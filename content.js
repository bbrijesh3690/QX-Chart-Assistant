(function () {
  const VAULT_KEY = "__QX_ASSET_VAULT_SESSION__";
  const LOG_KEY = "__QX_SHARED_LOG_SESSION__";
  const PENDING_KEY = "__QX_SHARED_PENDING_SESSION__";
  const HEARTBEAT_KEY = "__QX_SESSION_HEARTBEAT__";

  // Enforce session fresh-start on browser relaunch
  const lastHb = parseInt(localStorage.getItem(HEARTBEAT_KEY) || "0", 10);
  if (Date.now() - lastHb > 15000) {
    localStorage.removeItem(LOG_KEY);
    localStorage.removeItem(PENDING_KEY);
    sessionStorage.clear();
  }
  setInterval(() => {
    localStorage.setItem(HEARTBEAT_KEY, Date.now().toString());
  }, 2000);

  const assetVault = new Map();
  const globalHistoryPool = [];
  const backtestCache = new Map();

  // ==============================================================
  // TELEMETRY PLUMBING (v1.4.44) — OBSERVES ONLY
  // Nothing below this comment may influence a signal. Every call
  // into the telemetry layer is fire-and-forget and swallowed, so a
  // storage failure can never alter or delay the live verdict.
  // ==============================================================
  const TEL = () => window.__QX_TELEMETRY__ || null;

  // Rolling ~90s ring of raw canvas ticks: {t, p}. Used only to derive
  // microstructure features at lock time.
  const tickRing = [];
  const TICK_RING_MS = 90000;

  let lastTickTs = 0;
  let telemetryCount = 0;
  let telemetrySettled = 0;

  function pushTick(price, time) {
    tickRing.push({ t: time, p: price });
    const cutoff = time - TICK_RING_MS;
    while (tickRing.length && tickRing[0].t < cutoff) tickRing.shift();
    lastTickTs = time;
  }

  function tickStats(now) {
    const out = {
      tick5s: 0, tick10s: 0, tick60s: 0,
      tickUp10s: 0, tickDown10s: 0, tickImb10s: 0,
      range5s: 0, range60s: 0, range5sPct: 0
    };
    if (tickRing.length === 0) return out;

    let hi5 = -Infinity, lo5 = Infinity, hi60 = -Infinity, lo60 = Infinity;
    let prev10 = null;

    for (let i = 0; i < tickRing.length; i++) {
      const tk = tickRing[i];
      const age = now - tk.t;
      if (age <= 60000) {
        out.tick60s++;
        if (tk.p > hi60) hi60 = tk.p;
        if (tk.p < lo60) lo60 = tk.p;
      }
      if (age <= 10000) {
        out.tick10s++;
        if (prev10 !== null) {
          if (tk.p > prev10) out.tickUp10s++;
          else if (tk.p < prev10) out.tickDown10s++;
        }
        prev10 = tk.p;
      }
      if (age <= 5000) {
        out.tick5s++;
        if (tk.p > hi5) hi5 = tk.p;
        if (tk.p < lo5) lo5 = tk.p;
      }
    }

    if (hi5 > -Infinity && lo5 < Infinity) out.range5s = hi5 - lo5;
    if (hi60 > -Infinity && lo60 < Infinity) out.range60s = hi60 - lo60;

    const dirTotal = out.tickUp10s + out.tickDown10s;
    if (dirTotal > 0) {
      out.tickImb10s = Number(((out.tickUp10s - out.tickDown10s) / dirTotal).toFixed(4));
    }

    const lastPrice = tickRing[tickRing.length - 1].p;
    if (lastPrice > 0 && out.range5s > 0) {
      out.range5sPct = Number(((out.range5s / lastPrice) * 100).toFixed(6));
    }
    return out;
  }

  function calcATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const slice = candles.slice(-(period + 1));
    let sum = 0;
    for (let i = 1; i < slice.length; i++) {
      const c = slice[i], prev = slice[i - 1];
      sum += Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      );
    }
    return sum / period;
  }

  function calcStdev(candles, period = 20) {
    if (!candles || candles.length < period + 1) return null;
    const slice = candles.slice(-(period + 1));
    const rets = [];
    for (let i = 1; i < slice.length; i++) {
      if (slice[i - 1].close > 0) {
        rets.push((slice[i].close - slice[i - 1].close) / slice[i - 1].close);
      }
    }
    if (rets.length < 2) return null;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
    return Math.sqrt(variance);
  }

  // Missing minutes inside the last 20 bars — a data-integrity read.
  // A signal computed over a gappy window is not the same signal.
  function countGaps(candles, lookback = 20) {
    if (!candles || candles.length < 2) return 0;
    const slice = candles.slice(-lookback);
    let gaps = 0;
    for (let i = 1; i < slice.length; i++) {
      const step = slice[i].time - slice[i - 1].time;
      if (step > 60000) gaps += Math.round(step / 60000) - 1;
    }
    return gaps;
  }

  const syncChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("QX_CROSS_WINDOW_SYNC") : null;

  let tradeLog = [];
  let pendingTrades = [];
  let currentPairFilter = "ALL";
  let currentTierFilter = "ALL";
  let activeTab = "FORWARD";
  let lastLogSignature = "";

  function loadLog() {
    try {
      const raw = localStorage.getItem(LOG_KEY);
      tradeLog = raw ? JSON.parse(raw) : [];
      const rawPending = localStorage.getItem(PENDING_KEY);
      pendingTrades = rawPending ? JSON.parse(rawPending) : [];
    } catch (_) {
      tradeLog = [];
      pendingTrades = [];
    }
  }

  loadLog();

  if (syncChannel) {
    syncChannel.onmessage = (e) => {
      if (e.data?.type === "QX_SYNC_LOG_UPDATE") {
        loadLog();
        if (activeTab === "FORWARD") renderLogUI();
      }
    };
  }

  window.addEventListener("storage", (e) => {
    if (e.key === LOG_KEY || e.key === PENDING_KEY) {
      loadLog();
      if (activeTab === "FORWARD") renderLogUI();
    }
  });

  setInterval(() => {
    loadLog();
    if (activeTab === "FORWARD") renderLogUI();
  }, 500);

  // ==============================================================
  // ATOMIC CONCURRENCY ENGINE
  // ==============================================================
  function atomicQueuePendingTrade(newTrade) {
    try {
      const rawLog = localStorage.getItem(LOG_KEY);
      const curLog = rawLog ? JSON.parse(rawLog) : [];
      if (curLog.some(t => t.id === newTrade.id)) return;

      const rawPending = localStorage.getItem(PENDING_KEY);
      const curPending = rawPending ? JSON.parse(rawPending) : [];

      if (!curPending.some(t => t.id === newTrade.id)) {
        curPending.push(newTrade);
        localStorage.setItem(PENDING_KEY, JSON.stringify(curPending));
        pendingTrades = curPending;
        if (syncChannel) syncChannel.postMessage({ type: "QX_SYNC_LOG_UPDATE" });
      }
    } catch (_) {}
  }

  function reconcilePendingTrades(assetName, candles, currentCandleTime) {
    if (!candles || candles.length === 0) return;

    try {
      const rawPending = localStorage.getItem(PENDING_KEY);
      let diskPending = rawPending ? JSON.parse(rawPending) : [];
      if (diskPending.length === 0) return;

      const rawLog = localStorage.getItem(LOG_KEY);
      let diskLog = rawLog ? JSON.parse(rawLog) : [];

      let pendingChanged = false;
      let logChanged = false;

      diskPending = diskPending.filter(trade => {
        if (trade.asset !== assetName) return true;

        const matchingCandle = candles.find(c => c.time === trade.minTime);
        const isPast = currentCandleTime ? currentCandleTime > trade.minTime : Date.now() >= trade.minTime + 60000;

        if (matchingCandle && isPast) {
          if (!diskLog.some(t => t.id === trade.id)) {
            let outcome = "TIE";
            if (trade.dir === "CALL") {
              outcome = matchingCandle.close > trade.entryPrice ? "WIN" : (matchingCandle.close < trade.entryPrice ? "LOSS" : "TIE");
            } else if (trade.dir === "PUT") {
              outcome = matchingCandle.close < trade.entryPrice ? "WIN" : (matchingCandle.close > trade.entryPrice ? "LOSS" : "TIE");
            }

            const d = new Date(trade.minTime);
            const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

            diskLog.unshift({
              id: trade.id,
              time: timeStr,
              asset: trade.asset,
              setup: trade.setup,
              tier: trade.tier || (trade.setup && trade.setup.includes("STRONG") ? "STRONG" : "BIAS"),
              score: trade.score || 0,
              dir: trade.dir,
              entry: trade.entryPrice,
              exit: matchingCandle.close,
              decimals: trade.decimals,
              outcome: outcome,
              minTime: trade.minTime
            });
            logChanged = true;
          }
          pendingChanged = true;
          return false;
        }

        if (Date.now() - trade.minTime > 7200000) {
          pendingChanged = true;
          return false;
        }

        return true;
      });

      if (logChanged) {
        if (diskLog.length > 1000) diskLog = diskLog.slice(0, 1000);
        localStorage.setItem(LOG_KEY, JSON.stringify(diskLog));
        tradeLog = diskLog;
      }

      if (pendingChanged) {
        localStorage.setItem(PENDING_KEY, JSON.stringify(diskPending));
        pendingTrades = diskPending;
      }

      if (logChanged || pendingChanged) {
        if (syncChannel) syncChannel.postMessage({ type: "QX_SYNC_LOG_UPDATE" });
        if (activeTab === "FORWARD") renderLogUI();
      }
    } catch (_) {}
  }

  // ==========================================
  // WEB AUDIO SYNTHESIZER
  // ==========================================
  let audioCtx = null;
  let masterComp = null;

  function getAudioContext() {
    if (!audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audioCtx = new AudioCtx();
        masterComp = audioCtx.createDynamicsCompressor();
        masterComp.threshold.setValueAtTime(-12, audioCtx.currentTime);
        masterComp.knee.setValueAtTime(8, audioCtx.currentTime);
        masterComp.ratio.setValueAtTime(10, audioCtx.currentTime);
        masterComp.attack.setValueAtTime(0.002, audioCtx.currentTime);
        masterComp.release.setValueAtTime(0.1, audioCtx.currentTime);
        masterComp.connect(audioCtx.destination);
      }
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  document.addEventListener("pointerdown", () => {
    getAudioContext();
  }, { once: false });

  function playTone(freq, type, startTime, duration, peakGain) {
    const ctx = getAudioContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(masterComp || ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  function triggerWindowVisualPulse() {
    const panel = document.getElementById("qx-assistant-panel");
    if (!panel) return;
    panel.classList.remove("qx-window-pulse");
    void panel.offsetWidth;
    panel.classList.add("qx-window-pulse");
    setTimeout(() => panel.classList.remove("qx-window-pulse"), 2500);
  }

  function playStrongFanfare3x(dir) {
    const ctx = getAudioContext();
    if (!ctx) return;
    triggerWindowVisualPulse();

    const baseTime = ctx.currentTime;
    const vol = 0.85;

    for (let rep = 0; rep < 3; rep++) {
      const t = baseTime + (rep * 0.42);
      if (dir === "CALL") {
        playTone(659, "triangle", t, 0.08, vol);
        playTone(880, "triangle", t + 0.07, 0.08, vol);
        playTone(1174, "triangle", t + 0.14, 0.22, vol);
      } else {
        playTone(987, "triangle", t, 0.08, vol);
        playTone(784, "triangle", t + 0.07, 0.08, vol);
        playTone(587, "triangle", t + 0.14, 0.22, vol);
      }
    }
  }

  function playBiasArcade3x(dir) {
    const ctx = getAudioContext();
    if (!ctx) return;
    triggerWindowVisualPulse();

    const baseTime = ctx.currentTime;
    const vol = 0.70;

    for (let rep = 0; rep < 3; rep++) {
      const t = baseTime + (rep * 0.36);
      if (dir === "CALL") {
        playTone(880, "triangle", t, 0.12, vol);
        playTone(1320, "triangle", t + 0.08, 0.22, vol * 1.05);
      } else {
        playTone(980, "triangle", t, 0.12, vol);
        playTone(587, "triangle", t + 0.08, 0.22, vol * 1.05);
      }
    }
  }

  function playAlert(tier, dir) {
    try {
      if (tier === "STRONG") playStrongFanfare3x(dir);
      else if (tier === "BIAS") playBiasArcade3x(dir);
    } catch (_) {}
  }

  function loadVault() {
    try {
      const raw = sessionStorage.getItem(VAULT_KEY);
      if (raw) JSON.parse(raw).forEach(([k, v]) => assetVault.set(k, v));
    } catch (_) {}
  }

  function saveVault() {
    try {
      sessionStorage.setItem(VAULT_KEY, JSON.stringify(Array.from(assetVault.entries())));
    } catch (_) {}
  }

  loadVault();

  function getVaultEntry(name) {
    if (!name || name === "Detecting...") {
      return {
        candles1m: [],
        currentCandle: null,
        livePrice: null,
        rawPrice: null,
        decimals: 3,
        activeSignal: null,
        activeScore: 0,
        activeFlipped: false,
        evalMinute: -1
      };
    }
    if (!assetVault.has(name)) {
      assetVault.set(name, {
        candles1m: [],
        currentCandle: null,
        livePrice: null,
        rawPrice: null,
        decimals: 3,
        activeSignal: null,
        activeScore: 0,
        activeFlipped: false,
        evalMinute: -1
      });
    }
    return assetVault.get(name);
  }

  function formatCleanName(raw) {
    if (!raw || typeof raw !== "string") return null;

    const p = raw.match(/\d{1,3}\s*%/g);
    if (p && p.length > 1) return null;
    const pairs = raw.match(/[A-Z]{3}\/[A-Z]{3}/gi);
    if (pairs && pairs.length > 1) return null;

    let s = raw.replace(/\d{1,3}\s*%/g, "").trim();
    s = s.replace(/PAIR INFORMATION/gi, "").replace(/BEGINNING OF TRADE/gi, "").trim();
    s = s.replace(/[\r\n\t]+/g, " ");
    s = s.replace(/[\.…]+$/, "").trim();
    s = s.replace(/\s+/g, " ");

    if (!s || s.length < 2 || s.includes("%") || /^\d+$/.test(s)) return null;
    if (/^(close|tab|payout|pin|active|favorite|live\s*account|demo\s*account|deposit|withdrawal|account|profile|up\s*down|leaderboard|tournaments|analytics)$/i.test(s)) return null;

    const pairMatch = s.match(/([A-Z]{3}\/[A-Z]{3})/i);
    if (pairMatch) {
      const isOtc = /OTC/i.test(s);
      return isOtc ? `${pairMatch[1].toUpperCase()} (OTC)` : pairMatch[1].toUpperCase();
    }

    return null;
  }

  // ==============================================================
  // DYNAMIC ACTIVE TAB DETECTOR (SUPPORTS PnL BADGES & WIDE TABS)
  // ==============================================================
  // v1.4.45: Quotex now renders asset tabs with hashed CSS-module
  // classnames (e.g. "dJ15T vXMlv") that rotate on every build — none
  // of them ever contain literal words like "active"/"selected", so the
  // regex bonus below can go permanently silent and every tab ties on
  // score, defaulting to the first one in DOM order regardless of which
  // is actually selected. The structural check added below (an element
  // carrying a class its sibling tabs don't share) still finds the
  // active tab even when the class itself is meaningless, because
  // Quotex still applies exactly one extra modifier class to it.
  function getActiveTabFromDOM() {
    const candidates = Array.from(document.querySelectorAll("div, a, button, li, span")).filter(el => {
      if (el.closest("#qx-assistant-panel")) return false;
      const t = el.innerText || el.textContent || "";
      return t.length >= 3 && t.length <= 60 && /[A-Z]{3}\/[A-Z]{3}/i.test(t);
    });

    if (candidates.length === 0) return null;

    const tabEls = [];
    for (const el of candidates) {
      let tabEl = el;
      for (let depth = 0; depth < 4 && tabEl && tabEl !== document.body; depth++) {
        const r = tabEl.getBoundingClientRect();
        if (r.top >= 0 && r.top <= 180 && r.height >= 20 && r.height <= 85 && r.width >= 50 && r.width <= 650) {
          break;
        }
        tabEl = tabEl.parentElement;
      }

      if (!tabEl || tabEl === document.body) continue;

      let r = tabEl.getBoundingClientRect();
      if (r.top < 0 || r.top > 180 || r.height < 20 || r.height > 85 || r.width < 50 || r.width > 650) continue;

      // Nested label/text wrapper divs often report a near-identical
      // box to their parent tab button. Climb to the outermost one
      // still occupying that box — that outer element is where Quotex
      // attaches the active-state modifier class, not the inner text
      // node the regex matched on.
      let outer = tabEl;
      for (let depth = 0; depth < 4 && outer.parentElement && outer.parentElement !== document.body; depth++) {
        const parent = outer.parentElement;
        const pr = parent.getBoundingClientRect();
        const pText = parent.innerText || parent.textContent || "";
        if (Math.abs(pr.top - r.top) > 6 || Math.abs(pr.width - r.width) > 40) break;
        if (!/[A-Z]{3}\/[A-Z]{3}/i.test(pText)) break;
        outer = parent;
        r = pr;
      }
      tabEl = outer;

      if (!tabEls.includes(tabEl)) tabEls.push(tabEl);
    }

    if (tabEls.length === 0) return null;

    // Group by parent so "does this tab have a class its siblings
    // lack" is judged only against actual siblings, not the whole page.
    const byParent = new Map();
    for (const t of tabEls) {
      const p = t.parentElement;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(t);
    }

    let bestName = null;
    let highestScore = -1;

    for (const siblings of byParent.values()) {
      let commonClasses = null;
      if (siblings.length > 1) {
        for (const s of siblings) {
          const cls = new Set((s.className || "").toString().split(/\s+/).filter(Boolean));
          commonClasses = commonClasses === null ? cls : new Set([...commonClasses].filter(c => cls.has(c)));
        }
      }

      for (const tabEl of siblings) {
        const rawText = tabEl.innerText || tabEl.textContent || "";
        const parsed = formatCleanName(rawText);
        if (!parsed) continue;

        let score = 10;
        const cls = (tabEl.className || "") + " " + (tabEl.getAttribute("aria-selected") || "") + " " + (tabEl.getAttribute("data-active") || "");

        if (/(active|selected|current|tab--active|tabs__item--active|is-active)/i.test(cls)) {
          score += 50;
        }
        if (commonClasses && siblings.length > 1) {
          const ownClasses = (tabEl.className || "").toString().split(/\s+/).filter(Boolean);
          if (ownClasses.some(c => !commonClasses.has(c))) score += 60;
        }
        if (tabEl.querySelector("button, svg, [class*='close'], [class*='cross']")) {
          score += 30;
        }
        if (tabEl.querySelector("[class*='arrow'], [class*='chevron'], [class*='select']")) {
          score += 40;
        }
        if (/[+\-]\s*[\d,]+\s*[₹$€£]/.test(rawText) || /[₹$€£]\s*[+\-]\s*[\d,]+/.test(rawText)) {
          score += 45;
        }
        if (/\d{1,3}\s*%/.test(rawText)) {
          score += 20;
        }

        if (score > highestScore) {
          highestScore = score;
          bestName = parsed;
        }
      }
    }

    return bestName;
  }

  let activeAsset = getActiveTabFromDOM() || "Detecting...";
  let state = getVaultEntry(activeAsset);

  function tryHydrateCandles() {
    if (state.candles1m.length >= 20 || state.livePrice === null) return;
    for (const pkt of globalHistoryPool) {
      if (Math.abs(pkt.samplePrice - state.livePrice) / state.livePrice <= 0.25) {
        state.candles1m = [...pkt.candles];
        saveVault();
        reconcilePendingTrades(activeAsset, state.candles1m, state.currentCandle?.time);
        updateUI();
        break;
      }
    }
  }

  function switchAsset(newName) {
    if (!newName || newName === activeAsset || newName === "Detecting...") return;
    activeAsset = newName;
    state = getVaultEntry(activeAsset);

    state.activeSignal = null;
    state.activeScore = 0;
    state.activeFlipped = false;
    state.evalMinute = -1;

    tryHydrateCandles();
    reconcilePendingTrades(activeAsset, state.candles1m, state.currentCandle?.time);
    saveVault();
    updateUI();

    if (activeTab === "BACKTEST") {
      renderBacktestUI();
    }
  }

  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#qx-assistant-panel")) return;
    let el = e.target;
    for (let i = 0; i < 6 && el && el !== document.body; i++) {
      const text = el.innerText || el.textContent || "";
      if (/[A-Z]{3}\/[A-Z]{3}/i.test(text)) {
        const parsed = formatCleanName(text);
        if (parsed) {
          switchAsset(parsed);
          break;
        }
      }
      el = el.parentElement;
    }
  }, true);

  setInterval(() => {
    const found = getActiveTabFromDOM();
    if (found && (found !== activeAsset || activeAsset === "Detecting...")) {
      switchAsset(found);
    }
  }, 400);

  // ==============================================================
  // FAST TICK INGESTION
  // ==============================================================
  function ingestFastTick(price, rawText, decimals, time) {
    if (state.livePrice !== null && Math.abs(price - state.livePrice) / state.livePrice > 1.0) {
      const found = getActiveTabFromDOM();
      if (found && found !== activeAsset) {
        switchAsset(found);
      }
    }

    if (activeAsset === "Detecting...") {
      const found = getActiveTabFromDOM();
      if (found) switchAsset(found);
    }

    state.livePrice = price;
    state.rawPrice = rawText;
    if (decimals !== undefined) state.decimals = decimals;

    pushTick(price, time);

    if (state.candles1m.length < 20) {
      tryHydrateCandles();
    }

    const minFloor = Math.floor(time / 60000) * 60000;

    if (state.candles1m.length > 0) {
      const last = state.candles1m[state.candles1m.length - 1];
      if (Math.abs(last.close - price) / price > 0.40) {
        state.candles1m = [];
        state.currentCandle = null;
        tryHydrateCandles();
      }
    }

    if (!state.currentCandle) {
      state.currentCandle = { time: minFloor, open: price, high: price, low: price, close: price };
    } else if (state.currentCandle.time === minFloor) {
      state.currentCandle.high = Math.max(state.currentCandle.high, price);
      state.currentCandle.low = Math.min(state.currentCandle.low, price);
      state.currentCandle.close = price;
    } else if (minFloor > state.currentCandle.time) {
      const finishedCandle = Object.assign({}, state.currentCandle);
      state.candles1m.push(finishedCandle);
      if (state.candles1m.length > 2000) state.candles1m.shift();

      reconcilePendingTrades(activeAsset, state.candles1m, minFloor);

      // --- TELEMETRY: settle the bar that just closed, and stamp the
      // rollover tick price onto the evaluation locked 5s ago. Both are
      // fire-and-forget; neither gates the trade queuing below.
      try {
        const tel = TEL();
        if (tel) {
          tel.settle(activeAsset, finishedCandle.time, finishedCandle);
          const wasExecuted = !!(state.activeSignal &&
            state.activeSignal.dir !== "NONE" &&
            !state.activeFlipped &&
            state.evalMinute === finishedCandle.time);
          tel.setEntryTick(activeAsset, minFloor, price, wasExecuted);
        }
      } catch (_) {}

      if (state.activeSignal && state.activeSignal.dir !== "NONE" && !state.activeFlipped && state.evalMinute === finishedCandle.time) {
        const tradeId = `${activeAsset}_${minFloor}`;
        atomicQueuePendingTrade({
          id: tradeId,
          minTime: minFloor,
          asset: activeAsset,
          dir: state.activeSignal.dir,
          tier: state.activeSignal.tier,
          setup: state.activeSignal.setup,
          score: state.activeScore,
          entryPrice: price,
          decimals: state.decimals !== undefined ? state.decimals : 3
        });
      }

      state.currentCandle = { time: minFloor, open: price, high: price, low: price, close: price };
      saveVault();
    }

    const priceEl = document.getElementById("qx-ui-price");
    if (priceEl) priceEl.textContent = state.rawPrice || price.toFixed(state.decimals);
  }

  function mergeCandleArrays(existing, incoming) {
    const map = new Map();
    (existing || []).forEach(c => map.set(c.time, c));
    (incoming || []).forEach(c => map.set(c.time, c));
    const merged = Array.from(map.values()).sort((a, b) => a.time - b.time);
    return merged.length > 2000 ? merged.slice(-2000) : merged;
  }

  function ingestHistory(candles, samplePrice) {
    if (!candles || candles.length === 0) return;

    globalHistoryPool.unshift({ candles: candles, samplePrice: samplePrice });
    if (globalHistoryPool.length > 35) globalHistoryPool.pop();

    if (state.livePrice !== null && Math.abs(samplePrice - state.livePrice) / state.livePrice <= 0.25) {
      state.candles1m = mergeCandleArrays(state.candles1m, candles);
      reconcilePendingTrades(activeAsset, state.candles1m, state.currentCandle?.time);
      saveVault();
      updateUI();
      return;
    }

    for (const [name, data] of assetVault.entries()) {
      if (data.livePrice !== null && Math.abs(samplePrice - data.livePrice) / data.livePrice <= 0.25) {
        data.candles1m = mergeCandleArrays(data.candles1m, candles);
        reconcilePendingTrades(name, data.candles1m, data.currentCandle?.time);
        saveVault();
        if (name === activeAsset) {
          updateUI();
        }
        return;
      }
    }
  }

  function getAggregate(candles, current, periodMin) {
    const all = [...candles];
    if (current) all.push(current);
    if (all.length === 0) return [];
    const ms = periodMin * 60000;
    const map = new Map();
    all.forEach(c => {
      const b = Math.floor(c.time / ms) * ms;
      if (!map.has(b)) {
        map.set(b, { time: b, open: c.open, high: c.high, low: c.low, close: c.close });
      } else {
        const item = map.get(b);
        item.high = Math.max(item.high, c.high);
        item.low = Math.min(item.low, c.low);
        item.close = c.close;
      }
    });
    return Array.from(map.values()).sort((a, b) => a.time - b.time);
  }

  function calcRSI(candles, period = 14) {
    if (candles.length <= period) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) {
      const d = candles[i].close - candles[i - 1].close;
      if (d >= 0) g += d; else l += Math.abs(d);
    }
    let ag = g / period, al = l / period;
    for (let i = period + 1; i < candles.length; i++) {
      const d = candles[i].close - candles[i - 1].close;
      ag = (ag * (period - 1) + (d >= 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    }
    if (al === 0) return 100;
    return 100 - (100 / (1 + (ag / al)));
  }

  function calcSR(candles) {
    if (candles.length < 5) return { s: null, r: null };
    const h = candles.map(c => c.high);
    const l = candles.map(c => c.low);
    return {
      s: Math.min(...l.slice(-20)),
      r: Math.max(...h.slice(-20))
    };
  }

  // Single scoring implementation for BOTH the live path and the
  // backtester. Until v1.4.46 these were two near-identical functions
  // that had silently drifted apart at the S/R component: the backtester
  // probed with the evaluated bar's wick (low/high) while live probed
  // with a single price point. Since calcSR builds the level from a
  // 20-bar window that INCLUDES the evaluated bar, the backtest distance
  // was often exactly zero — the bar was the level it was measured
  // against — and the component fired ~3x more often than it did live.
  //
  // srProbe is the single price the S/R distance is measured from.
  // Live passes the current tick; the backtester passes the evaluated
  // bar's close, which is that bar's final tick. Same arithmetic, so
  // Forward.test and Backward.test are finally measuring one strategy.
  function evaluateConfluence(m15Trend, m5Trend, rsi, srProbe, sr) {
    let callScore = 0;
    let putScore = 0;

    if (m15Trend === "Bullish") callScore += 1.5;
    else if (m15Trend === "Bearish") putScore += 1.5;

    if (m5Trend === "Bullish") callScore += 1.0;
    else if (m5Trend === "Bearish") putScore += 1.0;

    if (rsi !== null) {
      if (rsi <= 32) callScore += 1.5;
      else if (rsi >= 68) putScore += 1.5;
      else if (rsi > 50 && m5Trend === "Bullish") callScore += 0.5;
      else if (rsi < 50 && m5Trend === "Bearish") putScore += 0.5;
    }

    if (sr.s !== null && sr.r !== null && srProbe !== null) {
      const range = sr.r - sr.s;
      if (range > 0) {
        const distToSupport = (srProbe - sr.s) / range;
        const distToResistance = (sr.r - srProbe) / range;
        if (distToSupport < 0.15) callScore += 1.0;
        if (distToResistance < 0.15) putScore += 1.0;
      }
    }

    // rawCall / rawPut are the UNROUNDED scores. Added in v1.4.44 for
    // telemetry only — the displayed `score` and every tier threshold
    // below are unchanged. A 3.5 still renders as "4 / 5" live; the raw
    // value is what gets logged, so analysis sees the real number.
    if (callScore >= 3.5 && callScore > putScore) {
      return { setup: "STRONG BUY", score: Math.min(5, Math.round(callScore)), color: "#10b981", dir: "CALL", tier: "STRONG", rawCall: callScore, rawPut: putScore };
    } else if (putScore >= 3.5 && putScore > callScore) {
      return { setup: "STRONG PUT", score: Math.min(5, Math.round(putScore)), color: "#ef4444", dir: "PUT", tier: "STRONG", rawCall: callScore, rawPut: putScore };
    } else if (callScore >= 2.5 && callScore > putScore) {
      return { setup: "CALL Bias", score: Math.round(callScore), color: "#34d399", dir: "CALL", tier: "BIAS", rawCall: callScore, rawPut: putScore };
    } else if (putScore >= 2.5 && putScore > callScore) {
      return { setup: "PUT Bias", score: Math.round(putScore), color: "#f87171", dir: "PUT", tier: "BIAS", rawCall: callScore, rawPut: putScore };
    } else {
      return { setup: "Neutral", score: Math.max(callScore, putScore).toFixed(0), color: "#94a3b8", dir: "NONE", tier: "NONE", rawCall: callScore, rawPut: putScore };
    }
  }

  function computeForwardSummary(trades) {
    if (!trades || trades.length === 0) return null;
    let strongWins = 0, strongLosses = 0, strongTies = 0, strongCount = 0;
    let biasWins = 0, biasLosses = 0, biasTies = 0, biasCount = 0;

    const chron = trades.slice().reverse();
    let currentWinStreak = 0, maxWinStreak = 0;
    let currentLossStreak = 0, maxLossStreak = 0;

    chron.forEach(t => {
      const isStrong = t.tier === "STRONG" || (t.setup && t.setup.includes("STRONG"));
      if (isStrong) {
        strongCount++;
        if (t.outcome === "WIN") strongWins++;
        else if (t.outcome === "LOSS") strongLosses++;
        else strongTies++;
      } else {
        biasCount++;
        if (t.outcome === "WIN") biasWins++;
        else if (t.outcome === "LOSS") biasLosses++;
        else biasTies++;
      }

      if (t.outcome === "WIN") {
        currentWinStreak++;
        if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
        currentLossStreak = 0;
      } else if (t.outcome === "LOSS") {
        currentLossStreak++;
        if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
        currentWinStreak = 0;
      }
    });

    const totalCount = strongCount + biasCount;
    const totalWins = strongWins + biasWins;
    const totalLosses = strongLosses + biasLosses;
    const totalTies = strongTies + biasTies;

    const strongDecided = strongWins + strongLosses;
    const strongWr = strongDecided > 0 ? (strongWins / strongDecided) : 0;

    const biasDecided = biasWins + biasLosses;
    const biasWr = biasDecided > 0 ? (biasWins / biasDecided) : 0;

    const totalDecided = totalWins + totalLosses;
    const totalWr = totalDecided > 0 ? (totalWins / totalDecided) : 0;

    const distinctPairs = Array.from(new Set(trades.map(t => t.asset))).filter(Boolean);

    return {
      strongCount, strongWins, strongLosses, strongTies, strongWr,
      biasCount, biasWins, biasLosses, biasTies, biasWr,
      totalCount, totalWins, totalLosses, totalTies, totalWr,
      maxWinStreak, maxLossStreak,
      pairCount: distinctPairs.length
    };
  }

  function computeBacktestData(candles) {
    if (!candles || candles.length < 25) return null;

    let strongWins = 0, strongLosses = 0, strongTies = 0, strongCount = 0;
    let biasWins = 0, biasLosses = 0, biasTies = 0, biasCount = 0;
    let skippedNeutral = 0;
    let currentWinStreak = 0, maxWinStreak = 0;
    let currentLossStreak = 0, maxLossStreak = 0;

    const warmupCount = 20;
    for (let i = warmupCount; i < candles.length - 1; i++) {
      const subCandles = candles.slice(0, i + 1);
      const curCandle = subCandles[subCandles.length - 1];
      const m5 = getAggregate(subCandles, null, 5);
      const m15 = getAggregate(subCandles, null, 15);
      const rsi = calcRSI(subCandles, 14);
      const sr = calcSR(subCandles);

      let trend15m = "Neutral";
      if (m15.length >= 1) {
        const last15 = m15[m15.length - 1];
        trend15m = last15.close >= last15.open ? "Bullish" : "Bearish";
      }

      let trend5m = "Neutral";
      if (m5.length >= 2) {
        const cur5 = m5[m5.length - 1];
        const prev5 = m5[m5.length - 2];
        trend5m = cur5.close >= prev5.close ? "Bullish" : "Bearish";
      }

      const verdict = evaluateConfluence(trend15m, trend5m, rsi, curCandle.close, sr);

      if (verdict.dir === "NONE") {
        skippedNeutral++;
      } else {
        const targetCandle = candles[i + 1];
        const entry = targetCandle.open;
        const exit = targetCandle.close;

        let outcome = "TIE";
        if (verdict.dir === "CALL") {
          outcome = exit > entry ? "WIN" : (exit < entry ? "LOSS" : "TIE");
        } else if (verdict.dir === "PUT") {
          outcome = exit < entry ? "WIN" : (exit > entry ? "LOSS" : "TIE");
        }

        if (verdict.tier === "STRONG") {
          strongCount++;
          if (outcome === "WIN") strongWins++;
          else if (outcome === "LOSS") strongLosses++;
          else strongTies++;
        } else if (verdict.tier === "BIAS") {
          biasCount++;
          if (outcome === "WIN") biasWins++;
          else if (outcome === "LOSS") biasLosses++;
          else biasTies++;
        }

        if (outcome === "WIN") {
          currentWinStreak++;
          if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
          currentLossStreak = 0;
        } else if (outcome === "LOSS") {
          currentLossStreak++;
          if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
          currentWinStreak = 0;
        }
      }
    }

    const totalCount = strongCount + biasCount;
    const totalWins = strongWins + biasWins;
    const totalLosses = strongLosses + biasLosses;

    const strongDecided = strongWins + strongLosses;
    const strongWr = strongDecided > 0 ? (strongWins / strongDecided) : 0;

    const biasDecided = biasWins + biasLosses;
    const biasWr = biasDecided > 0 ? (biasWins / biasDecided) : 0;

    const totalDecided = totalWins + totalLosses;
    const totalWr = totalDecided > 0 ? (totalWins / totalDecided) : 0;

    const spanHours = (candles.length / 60).toFixed(1);

    return {
      strongCount, strongWins, strongLosses, strongTies, strongWr,
      biasCount, biasWins, biasLosses, biasTies, biasWr,
      totalCount, totalWins, totalLosses, totalWr,
      maxWinStreak, maxLossStreak, skippedNeutral,
      spanHours
    };
  }

  // ==============================================================
  // ZERO-DEPENDENCY NATIVE OPENXML (.XLSX) BUILDER
  // ==============================================================
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    crcTable[i] = c;
  }
  function calcCrc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZipBlob(files) {
    const encoder = new TextEncoder();
    const entries = files.map(f => {
      const nameBytes = encoder.encode(f.name);
      const dataBytes = typeof f.data === "string" ? encoder.encode(f.data) : f.data;
      const crc = calcCrc32(dataBytes);
      return { nameBytes, dataBytes, crc, size: dataBytes.length };
    });

    let totalLen = 0;
    entries.forEach(e => {
      totalLen += 30 + e.nameBytes.length + e.size;
      totalLen += 46 + e.nameBytes.length;
    });
    totalLen += 22;

    const buf = new Uint8Array(totalLen);
    const view = new DataView(buf.buffer);
    let offset = 0;
    const cdList = [];

    entries.forEach(e => {
      const localOffset = offset;
      view.setUint32(offset, 0x04034b50, true);
      view.setUint16(offset + 4, 10, true);
      view.setUint16(offset + 6, 0, true);
      view.setUint16(offset + 8, 0, true);
      view.setUint16(offset + 10, 0, true);
      view.setUint16(offset + 12, 0, true);
      view.setUint32(offset + 14, e.crc, true);
      view.setUint32(offset + 18, e.size, true);
      view.setUint32(offset + 22, e.size, true);
      view.setUint16(offset + 26, e.nameBytes.length, true);
      view.setUint16(offset + 28, 0, true);
      offset += 30;

      buf.set(e.nameBytes, offset);
      offset += e.nameBytes.length;

      buf.set(e.dataBytes, offset);
      offset += e.size;

      cdList.push({ ...e, localOffset });
    });

    const cdStart = offset;

    cdList.forEach(e => {
      view.setUint32(offset, 0x02014b50, true);
      view.setUint16(offset + 4, 20, true);
      view.setUint16(offset + 6, 10, true);
      view.setUint16(offset + 8, 0, true);
      view.setUint16(offset + 10, 0, true);
      view.setUint16(offset + 12, 0, true);
      view.setUint16(offset + 14, 0, true);
      view.setUint32(offset + 16, e.crc, true);
      view.setUint32(offset + 20, e.size, true);
      view.setUint32(offset + 24, e.size, true);
      view.setUint16(offset + 28, e.nameBytes.length, true);
      view.setUint16(offset + 30, 0, true);
      view.setUint16(offset + 32, 0, true);
      view.setUint16(offset + 34, 0, true);
      view.setUint16(offset + 36, 0, true);
      view.setUint32(offset + 38, 0, true);
      view.setUint32(offset + 42, e.localOffset, true);
      offset += 46;

      buf.set(e.nameBytes, offset);
      offset += e.nameBytes.length;
    });

    const cdSize = offset - cdStart;

    view.setUint32(offset, 0x06054b50, true);
    view.setUint16(offset + 4, 0, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, cdList.length, true);
    view.setUint16(offset + 10, cdList.length, true);
    view.setUint32(offset + 12, cdSize, true);
    view.setUint32(offset + 16, cdStart, true);
    view.setUint16(offset + 20, 0, true);

    return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function colLetters(n) {
    let s = "";
    while (n > 0) {
      let m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - m) / 26);
    }
    return s;
  }

  function escapeXml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function exportTwoSheetWorkbookXlsx() {
    loadLog();
    const nowStr = new Date().toLocaleTimeString();

    const fwd = computeForwardSummary(tradeLog);
    let s1RowsXml = "";
    let s1Row = 1;

    s1RowsXml += `<row r="${s1Row}" ht="28" customHeight="1">
      <c r="A${s1Row}" s="1" t="inlineStr"><is><t>FORWARD.TEST SESSION PERFORMANCE REPORT (LIVE RUN)</t></is></c>
    </row>`;
    s1Row++;

    s1RowsXml += `<row r="${s1Row}" ht="20" customHeight="1">
      <c r="A${s1Row}" s="8" t="inlineStr"><is><t>Total Trades: ${tradeLog.length}</t></is></c>
      <c r="B${s1Row}" s="8" t="inlineStr"><is><t>Active Pairs: ${fwd ? fwd.pairCount : 0}</t></is></c>
      <c r="C${s1Row}" s="8" t="inlineStr"><is><t>Report Generated: ${nowStr}</t></is></c>
      <c r="D${s1Row}" s="8"></c>
      <c r="E${s1Row}" s="8"></c>
      <c r="F${s1Row}" s="8"></c>
    </row>`;
    s1Row++;

    s1RowsXml += `<row r="${s1Row}" ht="12" customHeight="1"></row>`;
    s1Row++;

    s1RowsXml += `<row r="${s1Row}" ht="24" customHeight="1">
      <c r="A${s1Row}" s="2" t="inlineStr"><is><t>Tier</t></is></c>
      <c r="B${s1Row}" s="2" t="inlineStr"><is><t>Trades Taken</t></is></c>
      <c r="C${s1Row}" s="2" t="inlineStr"><is><t>Wins</t></is></c>
      <c r="D${s1Row}" s="2" t="inlineStr"><is><t>Losses</t></is></c>
      <c r="E${s1Row}" s="2" t="inlineStr"><is><t>Ties</t></is></c>
      <c r="F${s1Row}" s="2" t="inlineStr"><is><t>Win Rate</t></is></c>
    </row>`;
    s1Row++;

    if (fwd) {
      s1RowsXml += `<row r="${s1Row}" ht="20" customHeight="1">
        <c r="A${s1Row}" s="6" t="inlineStr"><is><t>Strong [S]</t></is></c>
        <c r="B${s1Row}" s="5"><v>${fwd.strongCount}</v></c>
        <c r="C${s1Row}" s="3"><v>${fwd.strongWins}</v></c>
        <c r="D${s1Row}" s="3"><v>${fwd.strongLosses}</v></c>
        <c r="E${s1Row}" s="3"><v>${fwd.strongTies}</v></c>
        <c r="F${s1Row}" s="7"><v>${Number(fwd.strongWr.toFixed(4))}</v></c>
      </row>`;
      s1Row++;

      s1RowsXml += `<row r="${s1Row}" ht="20" customHeight="1">
        <c r="A${s1Row}" s="6" t="inlineStr"><is><t>Bias [B]</t></is></c>
        <c r="B${s1Row}" s="5"><v>${fwd.biasCount}</v></c>
        <c r="C${s1Row}" s="3"><v>${fwd.biasWins}</v></c>
        <c r="D${s1Row}" s="3"><v>${fwd.biasLosses}</v></c>
        <c r="E${s1Row}" s="3"><v>${fwd.biasTies}</v></c>
        <c r="F${s1Row}" s="7"><v>${Number(fwd.biasWr.toFixed(4))}</v></c>
      </row>`;
      s1Row++;

      s1RowsXml += `<row r="${s1Row}" ht="22" customHeight="1">
        <c r="A${s1Row}" s="6" t="inlineStr"><is><t>Combined Total</t></is></c>
        <c r="B${s1Row}" s="5"><v>${fwd.totalCount}</v></c>
        <c r="C${s1Row}" s="5"><v>${fwd.totalWins}</v></c>
        <c r="D${s1Row}" s="5"><v>${fwd.totalLosses}</v></c>
        <c r="E${s1Row}" s="5"><v>${fwd.totalTies}</v></c>
        <c r="F${s1Row}" s="7"><v>${Number(fwd.totalWr.toFixed(4))}</v></c>
      </row>`;
      s1Row++;

      s1RowsXml += `<row r="${s1Row}" ht="12" customHeight="1"></row>`;
      s1Row++;

      s1RowsXml += `<row r="${s1Row}" ht="20" customHeight="1">
        <c r="A${s1Row}" s="8" t="inlineStr"><is><t>Streak Analysis</t></is></c>
        <c r="B${s1Row}" s="4" t="inlineStr"><is><t>Max Win Streak</t></is></c>
        <c r="C${s1Row}" s="9" t="inlineStr"><is><t>${fwd.maxWinStreak} Wins</t></is></c>
        <c r="D${s1Row}" s="4" t="inlineStr"><is><t>Max Loss Streak</t></is></c>
        <c r="E${s1Row}" s="10" t="inlineStr"><is><t>${fwd.maxLossStreak} Losses</t></is></c>
        <c r="F${s1Row}" s="3"></c>
      </row>`;
      s1Row++;
    } else {
      s1RowsXml += `<row r="${s1Row}" ht="20" customHeight="1">
        <c r="A${s1Row}" s="4" t="inlineStr"><is><t>No forward trades recorded in this session yet.</t></is></c>
      </row>`;
      s1Row++;
    }

    s1RowsXml += `<row r="${s1Row}" ht="14" customHeight="1"></row>`;
    s1Row++;

    s1RowsXml += `<row r="${s1Row}" ht="26" customHeight="1">
      <c r="A${s1Row}" s="1" t="inlineStr"><is><t>LIVE TRANSACTIONS &amp; EXECUTED FORWARD TRADES</t></is></c>
    </row>`;
    s1Row++;

    const s1Headers = ["Trade ID", "Time", "Asset", "Direction", "Tier", "Confluence Score", "Entry Price", "Exit Price", "Outcome"];
    s1RowsXml += `<row r="${s1Row}" ht="24" customHeight="1">`;
    s1Headers.forEach((h, idx) => {
      s1RowsXml += `<c r="${colLetters(idx + 1)}${s1Row}" s="2" t="inlineStr"><is><t>${escapeXml(h)}</t></is></c>`;
    });
    s1RowsXml += `</row>`;
    s1Row++;

    tradeLog.forEach(t => {
      const dec = t.decimals !== undefined ? t.decimals : 3;
      const outStyle = t.outcome === "WIN" ? 9 : (t.outcome === "LOSS" ? 10 : 3);

      s1RowsXml += `<row r="${s1Row}" ht="18" customHeight="1">
        <c r="A${s1Row}" s="4" t="inlineStr"><is><t>${escapeXml(t.id)}</t></is></c>
        <c r="B${s1Row}" s="3" t="inlineStr"><is><t>${escapeXml(t.time)}</t></is></c>
        <c r="C${s1Row}" s="4" t="inlineStr"><is><t>${escapeXml(t.asset)}</t></is></c>
        <c r="D${s1Row}" s="5" t="inlineStr"><is><t>${escapeXml(t.dir)}</t></is></c>
        <c r="E${s1Row}" s="3" t="inlineStr"><is><t>${escapeXml(t.tier)}</t></is></c>
        <c r="F${s1Row}" s="3"><v>${t.score || 0}</v></c>
        <c r="G${s1Row}" s="3"><v>${Number(t.entry.toFixed(dec))}</v></c>
        <c r="H${s1Row}" s="3"><v>${Number(t.exit.toFixed(dec))}</v></c>
        <c r="I${s1Row}" s="${outStyle}" t="inlineStr"><is><t>${escapeXml(t.outcome)}</t></is></c>
      </row>`;
      s1Row++;
    });

    const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0" showGridLines="0"/>
  </sheetViews>
  <cols>
    <col min="1" max="1" width="28" customWidth="1"/>
    <col min="2" max="2" width="14" customWidth="1"/>
    <col min="3" max="3" width="22" customWidth="1"/>
    <col min="4" max="4" width="14" customWidth="1"/>
    <col min="5" max="5" width="14" customWidth="1"/>
    <col min="6" max="6" width="18" customWidth="1"/>
    <col min="7" max="7" width="16" customWidth="1"/>
    <col min="8" max="8" width="16" customWidth="1"/>
    <col min="9" max="9" width="16" customWidth="1"/>
  </cols>
  <sheetData>${s1RowsXml}</sheetData>
</worksheet>`;

    const assetsToExport = [];
    if (assetVault.size > 0) {
      for (const [name, data] of assetVault.entries()) {
        if (data.candles1m && data.candles1m.length > 0 && !/live\s*account|up\s*down/i.test(name)) {
          assetsToExport.push({ name, candles: data.candles1m, dec: data.decimals || 3 });
        }
      }
    }
    if (assetsToExport.length === 0 && state.candles1m && state.candles1m.length > 0) {
      assetsToExport.push({ name: activeAsset, candles: state.candles1m, dec: state.decimals || 3 });
    }

    let s2RowsXml = "";
    let s2Row = 1;

    assetsToExport.forEach(item => {
      const cList = item.candles;
      const bt = computeBacktestData(cList);

      s2RowsXml += `<row r="${s2Row}" ht="28" customHeight="1">
        <c r="A${s2Row}" s="1" t="inlineStr"><is><t>BACKWARD.TEST SUMMARY REPORT - ${escapeXml(item.name)}</t></is></c>
      </row>`;
      s2Row++;

      s2RowsXml += `<row r="${s2Row}" ht="20" customHeight="1">
        <c r="A${s2Row}" s="8" t="inlineStr"><is><t>Asset: ${escapeXml(item.name)}</t></is></c>
        <c r="B${s2Row}" s="8" t="inlineStr"><is><t>TF: 1M Candle</t></is></c>
        <c r="C${s2Row}" s="8" t="inlineStr"><is><t>History: ${cList.length} Bars (~${bt ? bt.spanHours : '0'} Hours)</t></is></c>
        <c r="D${s2Row}" s="8"></c>
        <c r="E${s2Row}" s="8" t="inlineStr"><is><t>Generated: ${nowStr}</t></is></c>
        <c r="F${s2Row}" s="8"></c>
      </row>`;
      s2Row++;

      s2RowsXml += `<row r="${s2Row}" ht="12" customHeight="1"></row>`;
      s2Row++;

      s2RowsXml += `<row r="${s2Row}" ht="24" customHeight="1">
        <c r="A${s2Row}" s="2" t="inlineStr"><is><t>Tier</t></is></c>
        <c r="B${s2Row}" s="2" t="inlineStr"><is><t>Setups Count</t></is></c>
        <c r="C${s2Row}" s="2" t="inlineStr"><is><t>Wins</t></is></c>
        <c r="D${s2Row}" s="2" t="inlineStr"><is><t>Losses</t></is></c>
        <c r="E${s2Row}" s="2" t="inlineStr"><is><t>Ties</t></is></c>
        <c r="F${s2Row}" s="2" t="inlineStr"><is><t>Win Rate</t></is></c>
      </row>`;
      s2Row++;

      if (bt) {
        s2RowsXml += `<row r="${s2Row}" ht="20" customHeight="1">
          <c r="A${s2Row}" s="6" t="inlineStr"><is><t>Strong [S]</t></is></c>
          <c r="B${s2Row}" s="5"><v>${bt.strongCount}</v></c>
          <c r="C${s2Row}" s="3"><v>${bt.strongWins}</v></c>
          <c r="D${s2Row}" s="3"><v>${bt.strongLosses}</v></c>
          <c r="E${s2Row}" s="3"><v>${bt.strongTies}</v></c>
          <c r="F${s2Row}" s="7"><v>${Number(bt.strongWr.toFixed(4))}</v></c>
        </row>`;
        s2Row++;

        s2RowsXml += `<row r="${s2Row}" ht="20" customHeight="1">
          <c r="A${s2Row}" s="6" t="inlineStr"><is><t>Bias [B]</t></is></c>
          <c r="B${s2Row}" s="5"><v>${bt.biasCount}</v></c>
          <c r="C${s2Row}" s="3"><v>${bt.biasWins}</v></c>
          <c r="D${s2Row}" s="3"><v>${bt.biasLosses}</v></c>
          <c r="E${s2Row}" s="3"><v>${bt.biasTies}</v></c>
          <c r="F${s2Row}" s="7"><v>${Number(bt.biasWr.toFixed(4))}</v></c>
        </row>`;
        s2Row++;

        s2RowsXml += `<row r="${s2Row}" ht="22" customHeight="1">
          <c r="A${s2Row}" s="6" t="inlineStr"><is><t>Combined Total</t></is></c>
          <c r="B${s2Row}" s="5"><v>${bt.totalCount}</v></c>
          <c r="C${s2Row}" s="5"><v>${bt.totalWins}</v></c>
          <c r="D${s2Row}" s="5"><v>${bt.totalLosses}</v></c>
          <c r="E${s2Row}" s="5"><v>${bt.strongTies + bt.biasTies}</v></c>
          <c r="F${s2Row}" s="7"><v>${Number(bt.totalWr.toFixed(4))}</v></c>
        </row>`;
        s2Row++;

        s2RowsXml += `<row r="${s2Row}" ht="12" customHeight="1"></row>`;
        s2Row++;

        s2RowsXml += `<row r="${s2Row}" ht="20" customHeight="1">
          <c r="A${s2Row}" s="8" t="inlineStr"><is><t>Streak Analysis</t></is></c>
          <c r="B${s2Row}" s="4" t="inlineStr"><is><t>Max Win Streak</t></is></c>
          <c r="C${s2Row}" s="9" t="inlineStr"><is><t>${bt.maxWinStreak} Wins</t></is></c>
          <c r="D${s2Row}" s="4" t="inlineStr"><is><t>Max Loss Streak</t></is></c>
          <c r="E${s2Row}" s="10" t="inlineStr"><is><t>${bt.maxLossStreak} Losses</t></is></c>
          <c r="F${s2Row}" s="3"></c>
        </row>`;
        s2Row++;

        s2RowsXml += `<row r="${s2Row}" ht="20" customHeight="1">
          <c r="A${s2Row}" s="8" t="inlineStr"><is><t>Bar Accounting</t></is></c>
          <c r="B${s2Row}" s="4" t="inlineStr"><is><t>Traded Setups</t></is></c>
          <c r="C${s2Row}" s="5"><v>${bt.totalCount}</v></c>
          <c r="D${s2Row}" s="4" t="inlineStr"><is><t>Neutral (Skipped)</t></is></c>
          <c r="E${s2Row}" s="3"><v>${bt.skippedNeutral}</v></c>
          <c r="F${s2Row}" s="3" t="inlineStr"><is><t>20 Warmup</t></is></c>
        </row>`;
        s2Row++;
      } else {
        s2RowsXml += `<row r="${s2Row}" ht="20" customHeight="1">
          <c r="A${s2Row}" s="4" t="inlineStr"><is><t>Insufficient candle history for backtest calculation (&lt; 25 bars).</t></is></c>
        </row>`;
        s2Row++;
      }

      s2RowsXml += `<row r="${s2Row}" ht="14" customHeight="1"></row>`;
      s2Row++;

      s2RowsXml += `<row r="${s2Row}" ht="26" customHeight="1">
        <c r="A${s2Row}" s="1" t="inlineStr"><is><t>HISTORICAL 1-MINUTE RAW CANDLES &amp; ROW-BY-ROW SIGNAL STATUS</t></is></c>
      </row>`;
      s2Row++;

      const s2Headers = [
        "Timestamp", "Time", "Asset", "Open", "High", "Low", "Close", 
        "RSI (14)", "Support (20-bar)", "Resistance (20-bar)", 
        "Signal Triggered", "Trade Outcome"
      ];
      s2RowsXml += `<row r="${s2Row}" ht="24" customHeight="1">`;
      s2Headers.forEach((h, idx) => {
        s2RowsXml += `<c r="${colLetters(idx + 1)}${s2Row}" s="2" t="inlineStr"><is><t>${escapeXml(h)}</t></is></c>`;
      });
      s2RowsXml += `</row>`;
      s2Row++;

      for (let i = 0; i < cList.length; i++) {
        const c = cList[i];
        const sub = cList.slice(0, i + 1);
        const rsiVal = i >= 14 ? calcRSI(sub, 14) : null;
        const srVal = i >= 5 ? calcSR(sub) : { s: null, r: null };
        const d = new Date(c.time);
        const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

        let sigText = "Warmup";
        let outcomeText = "-";
        let outStyle = 3;

        if (i >= 20 && i < cList.length - 1) {
          const m5 = getAggregate(sub, null, 5);
          const m15 = getAggregate(sub, null, 15);
          let trend15m = "Neutral";
          if (m15.length >= 1) {
            const last15 = m15[m15.length - 1];
            trend15m = last15.close >= last15.open ? "Bullish" : "Bearish";
          }
          let trend5m = "Neutral";
          if (m5.length >= 2) {
            const cur5 = m5[m5.length - 1];
            const prev5 = m5[m5.length - 2];
            trend5m = cur5.close >= prev5.close ? "Bullish" : "Bearish";
          }

          const verdict = evaluateConfluence(trend15m, trend5m, rsiVal, c.close, srVal);
          if (verdict.dir === "NONE") {
            sigText = `Neutral (${verdict.score}/5)`;
            outcomeText = "Skipped";
            outStyle = 3;
          } else {
            const tierTag = verdict.tier === "STRONG" ? "[S]" : "[B]";
            sigText = `${tierTag} ${verdict.dir} (${verdict.score}/5)`;

            const nextCandle = cList[i + 1];
            const entry = nextCandle.open;
            const exit = nextCandle.close;
            if (verdict.dir === "CALL") {
              outcomeText = exit > entry ? "WIN" : (exit < entry ? "LOSS" : "TIE");
            } else if (verdict.dir === "PUT") {
              outcomeText = exit < entry ? "WIN" : (exit > entry ? "LOSS" : "TIE");
            }

            outStyle = outcomeText === "WIN" ? 9 : (outcomeText === "LOSS" ? 10 : 3);
          }
        } else if (i === cList.length - 1) {
          sigText = i >= 20 ? "Active Candle" : "Warmup";
          outcomeText = "Pending (Last Bar)";
          outStyle = 3;
        }

        s2RowsXml += `<row r="${s2Row}" ht="18" customHeight="1">
          <c r="A${s2Row}" s="3"><v>${c.time}</v></c>
          <c r="B${s2Row}" s="3" t="inlineStr"><is><t>${timeStr}</t></is></c>
          <c r="C${s2Row}" s="4" t="inlineStr"><is><t>${escapeXml(item.name)}</t></is></c>
          <c r="D${s2Row}" s="3"><v>${Number(c.open.toFixed(item.dec))}</v></c>
          <c r="E${s2Row}" s="3"><v>${Number(c.high.toFixed(item.dec))}</v></c>
          <c r="F${s2Row}" s="3"><v>${Number(c.low.toFixed(item.dec))}</v></c>
          <c r="G${s2Row}" s="3"><v>${Number(c.close.toFixed(item.dec))}</v></c>
          ${rsiVal !== null ? `<c r="H${s2Row}" s="3"><v>${Number(rsiVal.toFixed(1))}</v></c>` : `<c r="H${s2Row}" s="3" t="inlineStr"><is><t>--</t></is></c>`}
          ${srVal.s !== null ? `<c r="I${s2Row}" s="3"><v>${Number(srVal.s.toFixed(item.dec))}</v></c>` : `<c r="I${s2Row}" s="3" t="inlineStr"><is><t>--</t></is></c>`}
          ${srVal.r !== null ? `<c r="J${s2Row}" s="3"><v>${Number(srVal.r.toFixed(item.dec))}</v></c>` : `<c r="J${s2Row}" s="3" t="inlineStr"><is><t>--</t></is></c>`}
          <c r="K${s2Row}" s="4" t="inlineStr"><is><t>${escapeXml(sigText)}</t></is></c>
          <c r="L${s2Row}" s="${outStyle}" t="inlineStr"><is><t>${escapeXml(outcomeText)}</t></is></c>
        </row>`;
        s2Row++;
      }

      s2RowsXml += `<row r="${s2Row}" ht="14" customHeight="1"></row>`;
      s2Row++;
    });

    const sheet2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0" showGridLines="0"/>
  </sheetViews>
  <cols>
    <col min="1" max="1" width="22" customWidth="1"/>
    <col min="2" max="2" width="16" customWidth="1"/>
    <col min="3" max="3" width="22" customWidth="1"/>
    <col min="4" max="4" width="16" customWidth="1"/>
    <col min="5" max="5" width="16" customWidth="1"/>
    <col min="6" max="6" width="16" customWidth="1"/>
    <col min="7" max="7" width="14" customWidth="1"/>
    <col min="8" max="8" width="14" customWidth="1"/>
    <col min="9" max="9" width="18" customWidth="1"/>
    <col min="10" max="10" width="18" customWidth="1"/>
    <col min="11" max="11" width="22" customWidth="1"/>
    <col min="12" max="12" width="18" customWidth="1"/>
  </cols>
  <sheetData>${s2RowsXml}</sheetData>
</worksheet>`;

    const files = [
      {
        name: "[Content_Types].xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
      },
      {
        name: "_rels/.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
      },
      {
        name: "xl/workbook.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Forward.test Trades" sheetId="1" r:id="rId1"/>
    <sheet name="Historical 1M Candles" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`
      },
      {
        name: "xl/styles.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="0.0%"/>
  </numFmts>
  <fonts count="7">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="13"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF334155"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF059669"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFDC2626"/><name val="Calibri"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="11">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="6" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: sheet1Xml
      },
      {
        name: "xl/worksheets/sheet2.xml",
        data: sheet2Xml
      }
    ];

    const zipBlob = makeZipBlob(files);
    const now = new Date();
    const dateStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const fileName = `QX_Session_Workbook_${dateStamp}.xlsx`;

    const link = document.createElement("a");
    link.href = URL.createObjectURL(zipBlob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  // ==========================================
  // BACKTEST ENGINE
  // ==========================================
  function runBacktestForActiveAsset() {
    const candles = state.candles1m;
    const btContainer = document.getElementById("qx-bt-content");
    if (!btContainer) return;

    if (!candles || candles.length < 25) {
      btContainer.innerHTML = `
        <div class="qx-bt-prompt" style="color: #fca5a5;">
          ⚠️ Need >= 25 loaded 1m candles for <strong>${activeAsset}</strong> (currently has ${candles ? candles.length : 0}).
          <br><span style="color: #64748b; font-size: 9.5px;">Click <strong>Sync</strong> above to ingest chart history, then click <strong>Run</strong>.</span>
        </div>
      `;
      return;
    }

    const bt = computeBacktestData(candles);

    backtestCache.set(activeAsset, {
      asset: activeAsset,
      candlesCount: candles.length,
      spanHours: bt.spanHours,
      evaluatedTotal: candles.length - 1 - 20,
      skippedNeutral: bt.skippedNeutral,
      strongCount: bt.strongCount,
      strongWins: bt.strongWins,
      strongLosses: bt.strongLosses,
      strongTies: bt.strongTies,
      strongWr: (bt.strongWr * 100).toFixed(1),
      biasCount: bt.biasCount,
      biasWins: bt.biasWins,
      biasLosses: bt.biasLosses,
      biasTies: bt.biasTies,
      biasWr: (bt.biasWr * 100).toFixed(1),
      totalCount: bt.totalCount,
      totalWins: bt.totalWins,
      totalLosses: bt.totalLosses,
      totalWr: (bt.totalWr * 100).toFixed(1),
      maxWinStreak: bt.maxWinStreak,
      maxLossStreak: bt.maxLossStreak,
      testedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });

    renderBacktestUI();
  }

  function renderBacktestUI() {
    const btContainer = document.getElementById("qx-bt-content");
    if (!btContainer) return;

    if (!backtestCache.has(activeAsset)) {
      btContainer.innerHTML = `
        <div class="qx-bt-prompt">
          No backtest run yet for <strong>${activeAsset}</strong>.
          <br><span style="color: #64748b; font-size: 9.5px;">Click <strong>Run</strong> above to test historical candles.</span>
        </div>
      `;
      return;
    }

    const b = backtestCache.get(activeAsset);

    btContainer.innerHTML = `
      <table class="qx-log-table" style="margin-top: 2px;">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Setups</th>
            <th>W - L (Tie)</th>
            <th style="text-align: right;">Win Rate</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><span class="qx-tier-badge qx-tier-strong">S</span> <strong>Strong</strong></td>
            <td>${b.strongCount}</td>
            <td>${b.strongWins}W - ${b.strongLosses}L ${b.strongTies > 0 ? `(${b.strongTies}T)` : ''}</td>
            <td style="text-align: right; font-weight: 700; color: ${parseFloat(b.strongWr) >= 65 ? '#34d399' : '#f87171'};">${b.strongWr}%</td>
          </tr>
          <tr>
            <td><span class="qx-tier-badge qx-tier-bias">B</span> <strong>Bias</strong></td>
            <td>${b.biasCount}</td>
            <td>${b.biasWins}W - ${b.biasLosses}L ${b.biasTies > 0 ? `(${b.biasTies}T)` : ''}</td>
            <td style="text-align: right; font-weight: 700; color: ${parseFloat(b.biasWr) >= 60 ? '#34d399' : '#f87171'};">${b.biasWr}%</td>
          </tr>
          <tr style="border-top: 1px solid #2d3748; background: #131722;">
            <td><strong>Total</strong></td>
            <td><strong>${b.totalCount}</strong></td>
            <td><strong>${b.totalWins}W - ${b.totalLosses}L</strong></td>
            <td style="text-align: right; font-weight: 700; color: ${parseFloat(b.totalWr) >= 60 ? '#38bdf8' : '#e2e8f0'};">${b.totalWr}%</td>
          </tr>
        </tbody>
      </table>
      <div class="qx-bt-mini-footer" style="flex-direction: column; align-items: flex-start; gap: 2px;">
        <div style="width: 100%; display: flex; justify-content: space-between;">
          <span>🔥 Max Win: <strong style="color: #34d399;">${b.maxWinStreak}W</strong> | ⚠️ Max Loss: <strong style="color: #f87171;">${b.maxLossStreak}L</strong></span>
          <span style="color: #64748b;">${b.candlesCount} bars (~${b.spanHours}h)</span>
        </div>
        <div style="color: #64748b; font-size: 8.5px;">
          📊 Accounting: ${b.totalCount} Traded | ${b.skippedNeutral} Neutral Skipped | 20 Warmup
        </div>
      </div>
    `;
  }

  function renderLogUI() {
    const bodyEl = document.getElementById("qx-log-body");
    const summaryEl = document.getElementById("qx-log-summary");
    const pairFilterEl = document.getElementById("qx-log-pair-filter");
    const tierFilterEl = document.getElementById("qx-log-tier-filter");
    if (!bodyEl || !summaryEl) return;

    const sig = `${tradeLog.length}_${tradeLog[0]?.id || ''}_${tradeLog[0]?.outcome || ''}_${currentPairFilter}_${currentTierFilter}`;
    if (sig === lastLogSignature) return;
    lastLogSignature = sig;

    if (pairFilterEl) {
      const distinctPairs = Array.from(new Set(tradeLog.map(t => t.asset))).filter(Boolean);
      const existingOptions = Array.from(pairFilterEl.options).map(o => o.value);
      const targetValues = ["ALL", ...distinctPairs];

      if (existingOptions.join(",") !== targetValues.join(",")) {
        pairFilterEl.innerHTML = `<option value="ALL">Pair (All)</option>` + 
          distinctPairs.map(p => `<option value="${p}">${p.replace(/\s*\(OTC\)/gi, " *").slice(0, 9)}</option>`).join("");
        pairFilterEl.value = targetValues.includes(currentPairFilter) ? currentPairFilter : "ALL";
      }
      currentPairFilter = pairFilterEl.value;
    }

    if (tierFilterEl) {
      tierFilterEl.value = currentTierFilter;
    }

    let displayList = tradeLog;
    if (currentPairFilter !== "ALL") {
      displayList = displayList.filter(t => t.asset === currentPairFilter);
    }
    if (currentTierFilter !== "ALL") {
      displayList = displayList.filter(t => {
        const tier = t.tier || (t.setup && t.setup.includes("STRONG") ? "STRONG" : "BIAS");
        return tier === currentTierFilter;
      });
    }

    if (displayList.length === 0) {
      bodyEl.innerHTML = `<tr><td colspan="6" class="qx-empty-log">${tradeLog.length === 0 ? "Awaiting first settled candle..." : "No trades match active filters"}</td></tr>`;
      summaryEl.textContent = `0T: 0W - 0L (0%)`;
      summaryEl.style.background = "#2d3748";
      return;
    }

    let wins = 0;
    let losses = 0;
    let ties = 0;

    displayList.forEach(t => {
      if (t.outcome === "WIN") wins++;
      else if (t.outcome === "LOSS") losses++;
      else ties++;
    });

    const totalDecided = wins + losses;
    const wr = totalDecided > 0 ? ((wins / totalDecided) * 100).toFixed(0) : 0;
    const totalCount = wins + losses + ties;

    summaryEl.textContent = ties > 0 ? `${totalCount}T: ${wins}W - ${losses}L (${ties}T) (${wr}%)` : `${totalCount}T: ${wins}W - ${losses}L (${wr}%)`;
    summaryEl.style.background = wr >= 65 ? "#065f46" : (wr >= 50 ? "#2d3748" : "#7f1d1d");

    let rowsHtml = "";
    displayList.slice(0, 5).forEach(t => {
      const outcomeBadge = t.outcome === "WIN" 
        ? `<span class="qx-badge-win">WIN</span>` 
        : (t.outcome === "LOSS" ? `<span class="qx-badge-loss">LOSS</span>` : `<span class="qx-badge-tie">TIE</span>`);

      const dec = t.decimals !== undefined ? t.decimals : 3;
      const shortAsset = t.asset.replace(/\s*\(OTC\)/gi, " *").slice(0, 9);

      const isStrong = t.tier === "STRONG" || (t.setup && t.setup.includes("STRONG"));
      const tierBadge = isStrong 
        ? `<span class="qx-tier-badge qx-tier-strong" title="Strong Signal (Score >= 4)">S</span>` 
        : `<span class="qx-tier-badge qx-tier-bias" title="Bias Signal (Score 3)">B</span>`;

      const dirColor = t.dir === "CALL" 
        ? (isStrong ? "#10b981" : "#34d399") 
        : (isStrong ? "#ef4444" : "#f87171");

      rowsHtml += `
        <tr title="${t.setup} | Score: ${t.score || '--'}/5">
          <td>${t.time}</td>
          <td title="${t.asset}" style="color: #94a3b8; font-weight: 600;">${shortAsset}</td>
          <td style="white-space: nowrap;">
            ${tierBadge}
            <strong style="color: ${dirColor}; margin-left: 2px;">${t.dir}</strong>
          </td>
          <td>${t.entry.toFixed(dec)}</td>
          <td>${t.exit.toFixed(dec)}</td>
          <td style="text-align: right;">${outcomeBadge}</td>
        </tr>
      `;
    });
    bodyEl.innerHTML = rowsHtml;
  }

  function mountUI() {
    if (document.getElementById("qx-assistant-panel")) return;
    if (!document.body) return;

    const strongSoundEnabled = localStorage.getItem("__qx_sound_strong__") !== "false";
    const biasSoundEnabled = localStorage.getItem("__qx_sound_bias__") !== "false";

    const panel = document.createElement("div");
    panel.id = "qx-assistant-panel";
    panel.innerHTML = `
      <div id="qx-panel-header">
        <div id="qx-panel-title">
          <strong>QX Assistant</strong> <small>v1.4.46 [S: v1.0]</small>
          <span id="qx-tel-pill" title="Signal telemetry records stored locally (click to export CSV)">
            &#9679; <span id="qx-tel-count">0</span><span id="qx-tel-settled"></span>
          </span>
        </div>
        <div id="qx-panel-controls">
          <button id="qx-btn-sound-strong" class="qx-audio-btn" title="Toggle Strong Alerts (Triple Fanfare x3)">${strongSoundEnabled ? "S:🔊" : "S:🔇"}</button>
          <button id="qx-btn-sound-bias" class="qx-audio-btn" title="Toggle Bias Alerts (Arcade Ping x3)">${biasSoundEnabled ? "B:🔊" : "B:🔇"}</button>
          <button id="qx-btn-refresh" class="qx-sync-btn" title="Synchronize Tabs & History">Sync</button>
          <button id="qx-btn-min" class="qx-mac-dot qx-mac-min" title="Minimize / Expand Window"></button>
        </div>
      </div>
      <div id="qx-panel-body">
        <div class="qx-section">
          <div class="qx-row">
            <span class="qx-label">Asset:</span>
            <strong id="qx-ui-asset">${activeAsset}</strong>
          </div>
          <div class="qx-row">
            <span class="qx-label">Price:</span>
            <span id="qx-ui-price" class="qx-price">Waiting...</span>
          </div>
          <div class="qx-row" style="margin-top: 4px; border-top: 1px solid #232838; padding-top: 4px;">
            <span class="qx-label">1m Candle:</span>
            <span id="qx-ui-timer" class="qx-timer-badge">--:--</span>
          </div>
        </div>

        <div class="qx-section">
          <div class="qx-section-title">SIGNAL CONFLUENCE</div>
          <div class="qx-row">
            <span class="qx-label" id="qx-lbl-signal">Signal:</span>
            <strong id="qx-ui-setup" class="qx-accent">Analyzing...</strong>
          </div>
          <div class="qx-row">
            <span class="qx-label">Score:</span>
            <span id="qx-ui-score" class="qx-pill">-- / 5</span>
          </div>

          <div id="qx-ui-advisory" class="qx-advisory-box qx-hidden"></div>

          <div class="qx-tf-box">
            <div class="qx-row-sm"><span>15m Trend:</span> <strong id="qx-ui-15m">Neutral</strong></div>
            <div class="qx-row-sm"><span>5m Trend:</span> <strong id="qx-ui-5m">Neutral</strong></div>
            <div class="qx-row-sm"><span>1m RSI (14):</span> <strong id="qx-ui-rsi">--</strong></div>
            <div class="qx-row-sm"><span>Key Levels:</span> <span id="qx-ui-sr" class="qx-mono">--</span></div>
          </div>
        </div>

        <div class="qx-section">
          <div class="qx-section-title">CANDLES (SESSION)</div>
          <div class="qx-grid-3">
            <div class="qx-stat-box"><div class="qx-stat-lbl">1m</div><div id="qx-cnt-1m" class="qx-stat-val">0</div></div>
            <div class="qx-stat-box"><div class="qx-stat-lbl">5m</div><div id="qx-cnt-5m" class="qx-stat-val">0</div></div>
            <div class="qx-stat-box"><div class="qx-stat-lbl">15m</div><div id="qx-cnt-15m" class="qx-stat-val">0</div></div>
          </div>
        </div>

        <div class="qx-section" id="qx-testing-section">
          <div class="qx-tabs-header">
            <div class="qx-tab-group">
              <button id="qx-tab-btn-forward" class="qx-tab-btn qx-tab-active">Forward.test</button>
              <button id="qx-tab-btn-backtest" class="qx-tab-btn">Backward.test</button>
            </div>
            <div id="qx-forward-controls" class="qx-tab-actions">
              <span id="qx-log-summary" class="qx-log-pill">0T: 0W - 0L (0%)</span>
              <button id="qx-btn-export-log" class="qx-export-btn" title="Export Dashboard Style Native .xlsx Workbook">Export</button>
              <button id="qx-btn-clear-log" class="qx-clear-btn" title="Reset Shared Session Log Across Windows">Clr</button>
            </div>
            <div id="qx-backtest-controls" class="qx-tab-actions qx-hidden">
              <button id="qx-btn-run-bt" class="qx-bt-run-btn" title="Run Backward.test on Active Chart History">Run</button>
            </div>
          </div>

          <div id="qx-view-forward" class="qx-log-table-wrap">
            <table class="qx-log-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>
                    <select id="qx-log-pair-filter" class="qx-th-filter" title="Filter by Pair">
                      <option value="ALL">Pair (All)</option>
                    </select>
                  </th>
                  <th>
                    <select id="qx-log-tier-filter" class="qx-th-filter qx-th-tier-filter" title="Filter by Strong / Bias">
                      <option value="ALL">Tier (All)</option>
                      <option value="STRONG">[S] Strong</option>
                      <option value="BIAS">[B] Bias</option>
                    </select>
                  </th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th style="text-align: right;">Result</th>
                </tr>
              </thead>
              <tbody id="qx-log-body">
                <tr><td colspan="6" class="qx-empty-log">Awaiting first settled candle...</td></tr>
              </tbody>
            </table>
          </div>

          <div id="qx-view-backtest" class="qx-log-table-wrap qx-hidden">
            <div id="qx-bt-content"></div>
          </div>
        </div>

      </div>
    `;
    document.body.appendChild(panel);

    const savedPos = localStorage.getItem("__qx_panel_pos__");
    if (savedPos) {
      try {
        const { left, top } = JSON.parse(savedPos);
        panel.style.left = left + "px";
        panel.style.top = top + "px";
        panel.style.right = "auto";
      } catch (_) {}
    }

    const header = panel.querySelector("#qx-panel-header");
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    header.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "SELECT") return;
      isDragging = true;
      dragOffset.x = e.clientX - panel.offsetLeft;
      dragOffset.y = e.clientY - panel.offsetTop;

      function onMouseMove(moveEv) {
        if (!isDragging) return;
        const x = Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, moveEv.clientX - dragOffset.x));
        const y = Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, moveEv.clientY - dragOffset.y));
        panel.style.left = x + "px";
        panel.style.top = y + "px";
        panel.style.right = "auto";
      }

      function onMouseUp() {
        isDragging = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        localStorage.setItem("__qx_panel_pos__", JSON.stringify({
          left: panel.offsetLeft,
          top: panel.offsetTop
        }));
      }

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    const tabForward = document.getElementById("qx-tab-btn-forward");
    const tabBacktest = document.getElementById("qx-tab-btn-backtest");
    const viewForward = document.getElementById("qx-view-forward");
    const viewBacktest = document.getElementById("qx-view-backtest");
    const controlsForward = document.getElementById("qx-forward-controls");
    const controlsBacktest = document.getElementById("qx-backtest-controls");

    tabForward.addEventListener("click", () => {
      activeTab = "FORWARD";
      tabForward.classList.add("qx-tab-active");
      tabBacktest.classList.remove("qx-tab-active");
      viewForward.classList.remove("qx-hidden");
      viewBacktest.classList.add("qx-hidden");
      controlsForward.classList.remove("qx-hidden");
      controlsBacktest.classList.add("qx-hidden");
      lastLogSignature = "";
      renderLogUI();
    });

    tabBacktest.addEventListener("click", () => {
      activeTab = "BACKTEST";
      tabBacktest.classList.add("qx-tab-active");
      tabForward.classList.remove("qx-tab-active");
      viewBacktest.classList.remove("qx-hidden");
      viewForward.classList.add("qx-hidden");
      controlsBacktest.classList.remove("qx-hidden");
      controlsForward.classList.add("qx-hidden");
      renderBacktestUI();
    });

    const btnRunBt = document.getElementById("qx-btn-run-bt");
    btnRunBt.addEventListener("click", () => {
      runBacktestForActiveAsset();
    });

    const btnExport = document.getElementById("qx-btn-export-log");
    btnExport.addEventListener("click", () => {
      exportTwoSheetWorkbookXlsx();
    });

    const pairFilterEl = document.getElementById("qx-log-pair-filter");
    pairFilterEl.addEventListener("change", (e) => {
      currentPairFilter = e.target.value;
      lastLogSignature = "";
      renderLogUI();
    });

    const tierFilterEl = document.getElementById("qx-log-tier-filter");
    tierFilterEl.addEventListener("change", (e) => {
      currentTierFilter = e.target.value;
      lastLogSignature = "";
      renderLogUI();
    });

    const btnSoundStrong = document.getElementById("qx-btn-sound-strong");
    btnSoundStrong.addEventListener("click", () => {
      const cur = localStorage.getItem("__qx_sound_strong__") !== "false";
      const next = !cur;
      localStorage.setItem("__qx_sound_strong__", next ? "true" : "false");
      btnSoundStrong.textContent = next ? "S:🔊" : "S:🔇";
      if (next) playAlert("STRONG", "CALL");
    });

    const btnSoundBias = document.getElementById("qx-btn-sound-bias");
    btnSoundBias.addEventListener("click", () => {
      const cur = localStorage.getItem("__qx_sound_bias__") !== "false";
      const next = !cur;
      localStorage.setItem("__qx_sound_bias__", next ? "true" : "false");
      btnSoundBias.textContent = next ? "B:🔊" : "B:🔇";
      if (next) playAlert("BIAS", "CALL");
    });

    const btnClearLog = document.getElementById("qx-btn-clear-log");
    btnClearLog.addEventListener("click", () => {
      tradeLog = [];
      pendingTrades = [];
      currentPairFilter = "ALL";
      currentTierFilter = "ALL";
      lastLogSignature = "";
      localStorage.removeItem(LOG_KEY);
      localStorage.removeItem(PENDING_KEY);
      if (syncChannel) syncChannel.postMessage({ type: "QX_SYNC_LOG_UPDATE" });
      renderLogUI();
    });

    const btnRefresh = document.getElementById("qx-btn-refresh");
    btnRefresh.addEventListener("click", () => {
      btnRefresh.textContent = "...";
      const found = getActiveTabFromDOM();
      if (found) switchAsset(found);
      tryHydrateCandles();
      window.postMessage({ type: "QX_REQ_REPLAY" }, "*");
      setTimeout(() => {
        btnRefresh.textContent = "Sync";
        updateUI();
        if (activeTab === "BACKTEST") renderBacktestUI();
      }, 300);
    });

    const btnMin = document.getElementById("qx-btn-min");
    const bodyEl = document.getElementById("qx-panel-body");
    btnMin.addEventListener("click", () => {
      const isHidden = bodyEl.style.display === "none";
      bodyEl.style.display = isHidden ? "block" : "none";
    });

    // --- TELEMETRY PILL: live record count, click to export CSV ---
    const telPill = document.getElementById("qx-tel-pill");
    if (telPill) {
      telPill.addEventListener("click", () => {
        const tel = TEL();
        if (!tel) return;
        const label = document.getElementById("qx-tel-count");
        const prev = label ? label.textContent : "";
        if (label) label.textContent = "...";
        tel.exportCsv().then(n => {
          if (label) label.textContent = prev;
          console.log(`[QX] Exported ${n} telemetry rows.`);
        }).catch(() => {
          if (label) label.textContent = prev;
        });
      });
    }

    function refreshTelemetryPill() {
      const tel = TEL();
      if (!tel) return;
      tel.count().then(n => {
        telemetryCount = n;
        const el = document.getElementById("qx-tel-count");
        if (el) el.textContent = n;
      }).catch(() => {});
      tel.countSettled().then(n => {
        telemetrySettled = n;
        const el = document.getElementById("qx-tel-settled");
        if (el) el.textContent = n > 0 ? ` (${n}✓)` : "";
      }).catch(() => {});
    }
    refreshTelemetryPill();
    setInterval(refreshTelemetryPill, 15000);

    const found = getActiveTabFromDOM();
    if (found && found !== activeAsset) switchAsset(found);

    renderLogUI();
    updateUI();
  }

  mountUI();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountUI);
  }
  const checkTimer = setInterval(() => {
    if (document.getElementById("qx-assistant-panel")) clearInterval(checkTimer);
    else mountUI();
  }, 400);

  // ==============================================================
  // TELEMETRY CAPTURE (v1.4.44)
  // Called once per minute at the :55 lock, for EVERY evaluation —
  // STRONG, BIAS and NEUTRAL alike. The neutrals are the control
  // group; without them there is no way to tell whether a component
  // predicts direction or merely correlates with taking a trade.
  // ==============================================================
  function captureTelemetry(ctx) {
    const tel = TEL();
    if (!tel) return;

    try {
      const {
        cleanCandles, m5List, m15List, rsi, sr,
        trend15m, trend5m, verdict, evalMinute
      } = ctx;

      const now = Date.now();
      const tradeMinute = evalMinute + 60000;
      const price = state.livePrice;
      const closed = state.currentCandle ? cleanCandles.slice(0, -1) : cleanCandles.slice();

      // ---- SHADOW: last fully CLOSED 15m bar, vs the forming one the
      // live signal uses. Logged side by side so the question of which
      // one actually predicts gets settled by data, not by argument.
      const block15 = Math.floor(now / 900000) * 900000;
      const closed15 = m15List.filter(b => b.time < block15);
      let trend15Closed = "Neutral";
      if (closed15.length >= 1) {
        const last = closed15[closed15.length - 1];
        trend15Closed = last.close >= last.open ? "Bullish" : "Bearish";
      }

      const block5 = Math.floor(now / 300000) * 300000;
      const closed5 = m5List.filter(b => b.time < block5);
      let trend5Closed = "Neutral";
      if (closed5.length >= 2) {
        const cur = closed5[closed5.length - 1];
        const prev = closed5[closed5.length - 2];
        trend5Closed = cur.close >= prev.close ? "Bullish" : "Bearish";
      }

      const rsiClosed = calcRSI(closed, 14);

      // ---- SHADOW: wick-aware S/R distance (what the backtester uses)
      // alongside the price-based distance (what the live signal uses).
      // This asymmetry is exactly why backtest and forward numbers have
      // never been comparable.
      let distSupPrice = null, distResPrice = null;
      let distSupWick = null, distResWick = null;
      if (sr.s !== null && sr.r !== null) {
        const range = sr.r - sr.s;
        if (range > 0) {
          if (price !== null) {
            distSupPrice = Number(((price - sr.s) / range).toFixed(6));
            distResPrice = Number(((sr.r - price) / range).toFixed(6));
          }
          const fc = state.currentCandle;
          if (fc) {
            distSupWick = Number(((fc.low - sr.s) / range).toFixed(6));
            distResWick = Number(((sr.r - fc.high) / range).toFixed(6));
          }
        }
      }

      const atr = calcATR(closed, 14);
      const sd = calcStdev(closed, 20);
      const ticks = tickStats(now);
      const d = new Date(now);

      const row = {
        id: `${activeAsset}_${tradeMinute}`,
        asset: activeAsset,
        isOtc: /\(OTC\)/i.test(activeAsset) ? 1 : 0,
        decimals: state.decimals !== undefined ? state.decimals : 3,

        evalTs: now,
        evalMinute: evalMinute,
        tradeMinute: tradeMinute,
        localHour: d.getHours(),
        localMinute: d.getMinutes(),
        minuteOfDay: d.getHours() * 60 + d.getMinutes(),
        dayOfWeek: d.getDay(),
        utcHour: d.getUTCHours(),

        lockPrice: price,
        dir: verdict.dir,
        tier: verdict.tier,
        setup: verdict.setup,
        score: verdict.score,
        rawCall: verdict.rawCall,
        rawPut: verdict.rawPut,

        trend15: trend15m,
        trend5: trend5m,
        rsi: rsi !== null ? Number(rsi.toFixed(4)) : null,
        srS: sr.s,
        srR: sr.r,
        srRange: (sr.s !== null && sr.r !== null) ? Number((sr.r - sr.s).toFixed(8)) : null,
        distSupPrice, distResPrice,

        trend15Closed, trend5Closed,
        rsiClosed: rsiClosed !== null ? Number(rsiClosed.toFixed(4)) : null,
        distSupWick, distResWick,
        m15BlockPos: Math.floor((now % 900000) / 60000),
        m15BarsClosed: closed15.length,

        atr14: atr !== null ? Number(atr.toFixed(8)) : null,
        atrPct: (atr !== null && price) ? Number(((atr / price) * 100).toFixed(6)) : null,
        stdev20: sd !== null ? Number(sd.toFixed(10)) : null,
        stdev20Pct: sd !== null ? Number((sd * 100).toFixed(6)) : null,

        count1m: cleanCandles.length,
        count5m: m5List.length,
        count15m: m15List.length,
        gapCount20: countGaps(closed, 20),
        staleMs: lastTickTs ? (now - lastTickTs) : null,

        tick5s: ticks.tick5s,
        tick10s: ticks.tick10s,
        tick60s: ticks.tick60s,
        tickUp10s: ticks.tickUp10s,
        tickDown10s: ticks.tickDown10s,
        tickImb10s: ticks.tickImb10s,
        range5s: ticks.range5s,
        range60s: ticks.range60s,
        range5sPct: ticks.range5sPct,

        flipped: 0,
        executed: 0,
        settled: 0,
        entryTick: null,
        entryOpen: null,
        exitClose: null,
        nextHigh: null,
        nextLow: null,
        nextDir: null,
        resolvedTs: null
      };

      tel.record(row).then(ok => {
        if (ok) {
          telemetryCount++;
          const el = document.getElementById("qx-tel-count");
          if (el) el.textContent = telemetryCount;
        }
      });
    } catch (_) {}
  }

  // ==============================================================
  // ANALYSIS, FLIP GATE & SIGNAL LOCK
  // ==============================================================
  function updateAnalysis() {
    const dec = state.decimals !== undefined ? state.decimals : 3;

    let cleanCandles = [...state.candles1m];
    if (state.livePrice !== null && cleanCandles.length > 0) {
      cleanCandles = cleanCandles.filter(c => Math.abs(c.close - state.livePrice) / state.livePrice < 0.3);
    }
    if (state.currentCandle) cleanCandles.push(state.currentCandle);

    const m5List = getAggregate(cleanCandles, null, 5);
    const m15List = getAggregate(cleanCandles, null, 15);

    const cnt1m = document.getElementById("qx-cnt-1m");
    const cnt5m = document.getElementById("qx-cnt-5m");
    const cnt15m = document.getElementById("qx-cnt-15m");
    if (cnt1m) cnt1m.textContent = cleanCandles.length;
    if (cnt5m) cnt5m.textContent = m5List.length;
    if (cnt15m) cnt15m.textContent = m15List.length;

    const rsi = calcRSI(cleanCandles, 14);
    const sr = calcSR(cleanCandles);

    let trend15m = "Neutral";
    if (m15List.length >= 1) {
      const last15 = m15List[m15List.length - 1];
      trend15m = last15.close >= last15.open ? "Bullish" : "Bearish";
    }

    let trend5m = "Neutral";
    if (m5List.length >= 2) {
      const cur5 = m5List[m5List.length - 1];
      const prev5 = m5List[m5List.length - 2];
      trend5m = cur5.close >= prev5.close ? "Bullish" : "Bearish";
    }

    const liveVerdict = evaluateConfluence(trend15m, trend5m, rsi, state.livePrice, sr);

    const now = Date.now();
    const msInMinute = now % 60000;
    const sec = Math.floor(msInMinute / 1000);
    const remSec = 60 - sec;
    const currentMinFloor = Math.floor(now / 60000) * 60000;

    const timerEl = document.getElementById("qx-ui-timer");
    if (timerEl) {
      if (msInMinute < 55000) {
        timerEl.textContent = `00:${String(remSec).padStart(2, '0')}s`;
        timerEl.className = "qx-timer-badge qx-timer-analyzing";
      } else {
        timerEl.textContent = `00:${String(remSec).padStart(2, '0')}s [LOCK]`;
        timerEl.className = "qx-timer-badge qx-timer-locked";
      }
    }

    const signalLbl = document.getElementById("qx-lbl-signal");
    const signalEl = document.getElementById("qx-ui-setup");
    const scoreEl = document.getElementById("qx-ui-score");
    const advisoryEl = document.getElementById("qx-ui-advisory");

    if (msInMinute >= 55000) {
      if (signalLbl) signalLbl.textContent = "Signal:";

      if (state.evalMinute !== currentMinFloor) {
        state.activeSignal = Object.assign({}, liveVerdict);
        state.activeScore = liveVerdict.score;
        state.evalMinute = currentMinFloor;
        state.activeFlipped = false;

        const strongSoundEnabled = localStorage.getItem("__qx_sound_strong__") !== "false";
        const biasSoundEnabled = localStorage.getItem("__qx_sound_bias__") !== "false";

        if (state.activeSignal.tier === "STRONG" && strongSoundEnabled) {
          playAlert("STRONG", state.activeSignal.dir);
        } else if (state.activeSignal.tier === "BIAS" && biasSoundEnabled) {
          playAlert("BIAS", state.activeSignal.dir);
        }

        // TELEMETRY: capture every locked evaluation, neutrals included.
        // Placed AFTER the signal is committed above so it cannot affect it.
        captureTelemetry({
          cleanCandles, m5List, m15List, rsi, sr,
          trend15m, trend5m,
          verdict: liveVerdict,
          evalMinute: currentMinFloor
        });
      }

      if (msInMinute >= 58000 && state.activeSignal && state.activeSignal.dir !== "NONE") {
        const flippedNow = (state.activeSignal.dir === "CALL" && liveVerdict.dir !== "CALL") ||
                           (state.activeSignal.dir === "PUT" && liveVerdict.dir !== "PUT") ||
                           (liveVerdict.score < 2);
        if (flippedNow) {
          const wasAlreadyFlipped = state.activeFlipped;
          state.activeFlipped = true;
          // TELEMETRY: record the flip-gate reject. These rows are the
          // most interesting in the dataset — they are the trades the
          // gate saved you from, and the only way to find out whether
          // it is actually saving you anything.
          if (!wasAlreadyFlipped) {
            try {
              const tel = TEL();
              if (tel) tel.markFlipped(activeAsset, currentMinFloor + 60000);
            } catch (_) {}
          }
        }
      }

      if (signalEl && state.activeSignal) {
        signalEl.textContent = `${state.activeSignal.setup} [LOCKED]`;
        signalEl.style.color = state.activeSignal.color;
      }
      if (scoreEl && state.activeSignal) {
        scoreEl.textContent = `${state.activeScore} / 5`;
        scoreEl.style.background = state.activeScore >= 3 
          ? (state.activeSignal.dir === "CALL" ? "#065f46" : "#7f1d1d") 
          : "#2d3748";
        scoreEl.style.color = "#ffffff";
      }
    } else {
      const renewCountdown = 55 - sec;
      if (signalLbl) {
        signalLbl.textContent = `Signal (Renew in ${renewCountdown}s):`;
      }

      if (signalEl) {
        if (liveVerdict.dir !== "NONE") {
          signalEl.textContent = `Forming: ${liveVerdict.setup}`;
          signalEl.style.color = liveVerdict.color;
        } else {
          signalEl.textContent = `Analyzing...`;
          signalEl.style.color = "#94a3b8";
        }
      }

      if (scoreEl) {
        scoreEl.textContent = `${liveVerdict.score} / 5`;
        scoreEl.style.background = liveVerdict.score >= 3 
          ? (liveVerdict.dir === "CALL" ? "#065f46" : "#7f1d1d") 
          : "#2d3748";
        scoreEl.style.color = liveVerdict.score >= 3 ? "#ffffff" : "#cbd5e1";
      }
    }

    if (advisoryEl) {
      if (state.activeFlipped) {
        advisoryEl.className = "qx-advisory-box qx-advisory-flip";
        advisoryEl.textContent = msInMinute >= 55000 
          ? "⚠ FLIP DETECTED: Signal shifted in final 2s — DO NOT TRADE!"
          : "⚠ FLIP DETECTED: Trade skipped (failed at close) — Awaiting next signal";
      } else {
        advisoryEl.className = "qx-advisory-box qx-hidden";
        advisoryEl.textContent = "";
      }
    }

    const m15El = document.getElementById("qx-ui-15m");
    if (m15El) {
      m15El.textContent = trend15m;
      m15El.style.color = trend15m === "Bullish" ? "#10b981" : (trend15m === "Bearish" ? "#ef4444" : "#94a3b8");
    }

    const m5El = document.getElementById("qx-ui-5m");
    if (m5El) {
      m5El.textContent = trend5m;
      m5El.style.color = trend5m === "Bullish" ? "#10b981" : (trend5m === "Bearish" ? "#ef4444" : "#94a3b8");
    }

    const rsiEl = document.getElementById("qx-ui-rsi");
    if (rsiEl) {
      rsiEl.textContent = rsi !== null ? rsi.toFixed(1) : "--";
      if (rsi !== null) {
        rsiEl.style.color = rsi <= 30 ? "#10b981" : (rsi >= 70 ? "#ef4444" : "#e2e8f0");
      }
    }

    const srEl = document.getElementById("qx-ui-sr");
    if (srEl) {
      srEl.textContent = sr.s && sr.r ? `S: ${sr.s.toFixed(dec)} | R: ${sr.r.toFixed(dec)}` : "Accumulating";
    }
  }

  setInterval(updateAnalysis, 250);

  function updateUI() {
    const assetEl = document.getElementById("qx-ui-asset");
    if (assetEl) assetEl.textContent = activeAsset;

    const priceEl = document.getElementById("qx-ui-price");
    if (priceEl && (state.rawPrice || state.livePrice !== null)) {
      priceEl.textContent = state.rawPrice || state.livePrice.toFixed(state.decimals !== undefined ? state.decimals : 3);
    }
    updateAnalysis();
  }

  window.addEventListener("message", (e) => {
    if (e.data?.type === "QX_FAST_PRICE_TICK") {
      ingestFastTick(e.data.payload.price, e.data.payload.rawText, e.data.payload.decimals, e.data.payload.timestamp);
    } else if (e.data?.type === "QX_HISTORICAL_CANDLES") {
      ingestHistory(e.data.payload.candles, e.data.payload.samplePrice);
    }
  });
})();