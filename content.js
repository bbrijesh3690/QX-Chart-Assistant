(function () {
  try {
    sessionStorage.removeItem("__QX_SESSION_CACHE__");
    sessionStorage.removeItem("__QX_ASSET_VAULT__");
    sessionStorage.removeItem("__QX_ASSET_VAULT_V3__");
  } catch (_) {}

  const VAULT_KEY = "__QX_ASSET_VAULT_V5__";
  const assetVault = new Map();
  const globalHistoryPool = [];

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
      return { candles1m: [], currentCandle: null, livePrice: null, rawPrice: null, decimals: 3 };
    }
    if (!assetVault.has(name)) {
      assetVault.set(name, {
        candles1m: [],
        currentCandle: null,
        livePrice: null,
        rawPrice: null,
        decimals: 3
      });
    }
    return assetVault.get(name);
  }

  // PRESERVES EXACT PAIR FORMAT (Leaves non-OTC pairs clean!)
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
    if (/^(close|tab|payout|pin|active|favorite)$/i.test(s)) return null;

    // Currency Pairs: only add (OTC) if the raw string actually contained OTC!
    const pairMatch = s.match(/([A-Z]{3}\/[A-Z]{3})/i);
    if (pairMatch) {
      const isOtc = /OTC/i.test(s);
      return isOtc ? `${pairMatch[1].toUpperCase()} (OTC)` : pairMatch[1].toUpperCase();
    }

    // Indices, Crypto & Commodities (e.g. FTSE 100, Bitcoin Cash (OTC), Gold)
    const generalMatch = s.match(/([A-Za-z0-9\.\-\s]+(?:\(OTC\))?)/i);
    if (generalMatch && generalMatch[1].trim().length >= 3) {
      return generalMatch[1].trim();
    }
    return null;
  }

  // ACTIVE-STATE TAB DETECTOR
  function getActiveTabFromDOM() {
    const candidateTabs = Array.from(document.querySelectorAll("*")).filter(el => {
      if (el.closest("#qx-assistant-panel")) return false;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.top > 75 || r.height < 20 || r.height > 60 || r.width < 45 || r.width > 300) return false;
      const text = el.innerText || el.textContent || "";
      const p = text.match(/\d{1,3}\s*%/g);
      return p && p.length === 1;
    });

    if (candidateTabs.length === 0) return null;

    let bestTab = null;
    let highestScore = -1;

    for (const tab of candidateTabs) {
      let score = 0;
      const cls = (tab.className || "") + " " + (tab.getAttribute("aria-selected") || "");

      if (/(tab--active|tabs__item--active|is-active|\bactive\b|selected)/i.test(cls)) {
        score += 50;
      }

      try {
        const bg = window.getComputedStyle(tab).backgroundColor;
        const m = bg.match(/\d+/g);
        if (m && m.length >= 3) {
          const lum = 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
          if (lum < 22) score += 40;
        }
      } catch (_) {}

      const hasAction = tab.querySelector("button, [class*='close'], [class*='chevron'], [class*='arrow'], [class*='dropdown'], [class*='pin']");
      if (hasAction) score += 30;

      if (score > highestScore) {
        highestScore = score;
        bestTab = tab;
      }
    }

    if (bestTab && highestScore >= 30) {
      const clone = bestTab.cloneNode(true);
      clone.querySelectorAll("button, svg").forEach(n => n.remove());
      return formatCleanName(clone.innerText || clone.textContent);
    }

    return null;
  }

  let activeAsset = getActiveTabFromDOM() || "Detecting...";
  let state = getVaultEntry(activeAsset);

  function tryHydrateCandles() {
    if (state.candles1m.length >= 20 || state.livePrice === null) return;
    for (const pkt of globalHistoryPool) {
      if (Math.abs(pkt.samplePrice - state.livePrice) / state.livePrice <= 0.25) {
        state.candles1m = [...pkt.candles];
        saveVault();
        updateUI();
        break;
      }
    }
  }

  function switchAsset(newName) {
    if (!newName || newName === activeAsset || newName === "Detecting...") return;
    activeAsset = newName;
    state = getVaultEntry(activeAsset);

    tryHydrateCandles();
    saveVault();
    updateUI();
  }

  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#qx-assistant-panel")) return;
    let el = e.target;
    for (let i = 0; i < 6 && el && el !== document.body; i++) {
      const r = el.getBoundingClientRect();
      if (r.width <= 300) {
        const text = el.innerText || el.textContent || "";
        const parsed = formatCleanName(text);
        if (parsed) {
          switchAsset(parsed);
          break;
        }
      }
      el = el.parentElement;
    }
  }, true);

  let observerDebounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(observerDebounce);
    observerDebounce = setTimeout(() => {
      const found = getActiveTabFromDOM();
      if (found && found !== activeAsset) {
        switchAsset(found);
      }
    }, 30);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "aria-selected"]
  });

  setInterval(() => {
    const found = getActiveTabFromDOM();
    if (found && found !== activeAsset) {
      switchAsset(found);
    }
  }, 350);

  // ==========================================
  // PRICE & CANDLE INGESTION
  // ==========================================
  function ingestFastTick(price, rawText, decimals, time) {
    if (activeAsset === "Detecting...") {
      const found = getActiveTabFromDOM();
      if (found) switchAsset(found);
    }

    state.livePrice = price;
    state.rawPrice = rawText;
    if (decimals !== undefined) state.decimals = decimals;

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
      state.candles1m.push(Object.assign({}, state.currentCandle));
      if (state.candles1m.length > 240) state.candles1m.shift();
      state.currentCandle = { time: minFloor, open: price, high: price, low: price, close: price };
      saveVault();
    }

    const priceEl = document.getElementById("qx-ui-price");
    if (priceEl) priceEl.textContent = state.rawPrice || price.toFixed(state.decimals);
    updateAnalysis();
  }

  function ingestHistory(candles, samplePrice) {
    if (!candles || candles.length === 0) return;

    globalHistoryPool.unshift({ candles: candles, samplePrice: samplePrice });
    if (globalHistoryPool.length > 25) globalHistoryPool.pop();

    if (state.livePrice !== null && Math.abs(samplePrice - state.livePrice) / state.livePrice <= 0.25) {
      state.candles1m = [...candles];
      saveVault();
      updateUI();
      return;
    }

    for (const [name, data] of assetVault.entries()) {
      if (data.livePrice !== null && Math.abs(samplePrice - data.livePrice) / data.livePrice <= 0.25) {
        data.candles1m = [...candles];
        saveVault();
        if (name === activeAsset) updateUI();
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

  // ==========================================
  // DYNAMIC CONFLUENCE & SETUP ENGINE
  // ==========================================
  function evaluateConfluence(m15Trend, m5Trend, rsi, price, sr, latestCandle) {
    let callScore = 0;
    let putScore = 0;

    // 1. 15m Higher-Timeframe Trend
    if (m15Trend === "Bullish") callScore += 1.5;
    else if (m15Trend === "Bearish") putScore += 1.5;

    // 2. 5m Intermediate Trend
    if (m5Trend === "Bullish") callScore += 1.0;
    else if (m5Trend === "Bearish") putScore += 1.0;

    // 3. 1m RSI Conditions
    if (rsi !== null) {
      if (rsi <= 32) callScore += 1.5; // Oversold -> Buy bounce
      else if (rsi >= 68) putScore += 1.5; // Overbought -> Sell drop
      else if (rsi > 50 && m5Trend === "Bullish") callScore += 0.5;
      else if (rsi < 50 && m5Trend === "Bearish") putScore += 0.5;
    }

    // 4. Support / Resistance Proximity
    if (sr.s !== null && sr.r !== null && price !== null) {
      const range = sr.r - sr.s;
      if (range > 0) {
        const distToSupport = (price - sr.s) / range;
        const distToResistance = (sr.r - price) / range;
        if (distToSupport < 0.15) callScore += 1.0; // Near Support
        if (distToResistance < 0.15) putScore += 1.0; // Near Resistance
      }
    }

    // Calculate final verdict
    if (callScore >= 3.5 && callScore > putScore) {
      return { setup: "STRONG CALL", score: Math.min(5, Math.round(callScore)), color: "#10b981" };
    } else if (putScore >= 3.5 && putScore > callScore) {
      return { setup: "STRONG PUT", score: Math.min(5, Math.round(putScore)), color: "#ef4444" };
    } else if (callScore >= 2.5 && callScore > putScore) {
      return { setup: "CALL Bias", score: Math.round(callScore), color: "#34d399" };
    } else if (putScore >= 2.5 && putScore > callScore) {
      return { setup: "PUT Bias", score: Math.round(putScore), color: "#f87171" };
    } else {
      return { setup: "Neutral", score: Math.max(callScore, putScore).toFixed(0), color: "#94a3b8" };
    }
  }

  function mountUI() {
    if (document.getElementById("qx-assistant-panel")) return;
    if (!document.body) return;

    const panel = document.createElement("div");
    panel.id = "qx-assistant-panel";
    panel.innerHTML = `
      <div id="qx-panel-header">
        <div id="qx-panel-title">
          <span class="qx-badge">READ ONLY</span>
          <strong>QX Assistant</strong> <small>v1.4.7</small>
        </div>
        <div id="qx-panel-controls">
          <button id="qx-btn-refresh" title="Synchronize Tabs & History">[Sync]</button>
          <button id="qx-btn-reset-pos" title="Reset Position">[R]</button>
          <button id="qx-btn-min" title="Minimize">[-]</button>
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
        </div>

        <div class="qx-section">
          <div class="qx-section-title">MULTI-TIMEFRAME ANALYSIS</div>
          <div class="qx-row">
            <span class="qx-label">Setup:</span>
            <strong id="qx-ui-setup" class="qx-accent">Scanning...</strong>
          </div>
          <div class="qx-row">
            <span class="qx-label">Confluence Score:</span>
            <span id="qx-ui-score" class="qx-pill">0 / 5</span>
          </div>
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
      if (e.target.tagName === "BUTTON") return;
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

    const btnRefresh = document.getElementById("qx-btn-refresh");
    btnRefresh.addEventListener("click", () => {
      btnRefresh.textContent = "[...]";
      const found = getActiveTabFromDOM();
      if (found) switchAsset(found);
      tryHydrateCandles();
      window.postMessage({ type: "QX_REQ_REPLAY" }, "*");
      setTimeout(() => {
        btnRefresh.textContent = "[Sync]";
        updateUI();
      }, 300);
    });

    const btnMin = document.getElementById("qx-btn-min");
    const bodyEl = document.getElementById("qx-panel-body");
    btnMin.addEventListener("click", () => {
      const isHidden = bodyEl.style.display === "none";
      bodyEl.style.display = isHidden ? "block" : "none";
      btnMin.textContent = isHidden ? "[-]" : "[+]";
    });

    const btnReset = document.getElementById("qx-btn-reset-pos");
    btnReset.addEventListener("click", () => {
      panel.style.left = "auto";
      panel.style.top = "70px";
      panel.style.right = "20px";
      localStorage.removeItem("__qx_panel_pos__");
    });

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

    // Accurate 15m trend (checks close vs open of latest 15m candle)
    let trend15m = "Neutral";
    if (m15List.length >= 1) {
      const last15 = m15List[m15List.length - 1];
      trend15m = last15.close >= last15.open ? "Bullish" : "Bearish";
    }

    // Accurate 5m trend (checks current vs previous 5m close)
    let trend5m = "Neutral";
    if (m5List.length >= 2) {
      const cur5 = m5List[m5List.length - 1];
      const prev5 = m5List[m5List.length - 2];
      trend5m = cur5.close >= prev5.close ? "Bullish" : "Bearish";
    }

    // Compute live confluence verdict & score
    const verdict = evaluateConfluence(trend15m, trend5m, rsi, state.livePrice, sr, state.currentCandle);

    const setupEl = document.getElementById("qx-ui-setup");
    if (setupEl) {
      setupEl.textContent = verdict.setup;
      setupEl.style.color = verdict.color;
    }

    const scoreEl = document.getElementById("qx-ui-score");
    if (scoreEl) {
      scoreEl.textContent = `${verdict.score} / 5`;
      scoreEl.style.background = verdict.score >= 3 ? (verdict.setup.includes("CALL") ? "#065f46" : "#7f1d1d") : "#2d3748";
      scoreEl.style.color = verdict.score >= 3 ? "#ffffff" : "#cbd5e1";
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