(function () {
  // Purge all stale legacy cache entries from storage
  try {
    sessionStorage.removeItem("__QX_SESSION_CACHE__");
    sessionStorage.removeItem("__QX_ASSET_VAULT__");
    sessionStorage.removeItem("__QX_ASSET_VAULT_V3__");
  } catch (_) {}

  const VAULT_KEY = "__QX_ASSET_VAULT_V4__";
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

  // ROBUST SANITIZER WITH CONTAINER REJECTION
  function formatCleanName(raw) {
    if (!raw || typeof raw !== "string") return null;

    // REJECT MULTI-TAB CONTAINERS
    const p = raw.match(/\d{1,3}\s*%/g);
    if (p && p.length > 1) return null;
    const pairs = raw.match(/[A-Z]{3}\/[A-Z]{3}/gi);
    if (pairs && pairs.length > 1) return null;

    let s = raw.replace(/\d{1,3}\s*%/g, "").trim();
    s = s.replace(/PAIR INFORMATION/gi, "").replace(/BEGINNING OF TRADE/gi, "").trim();
    s = s.replace(/[\r\n\t]+/g, " ");
    s = s.replace(/[\.…]+$/, "").trim(); // Strips "USD/PKR..." truncation
    s = s.replace(/\s+/g, " ");

    if (!s || s.length < 2 || s.includes("%") || /^\d+$/.test(s)) return null;
    if (/^(close|tab|payout|pin|active|favorite)$/i.test(s)) return null;

    // Currency Pairs (e.g. USD/PKR -> USD/PKR (OTC))
    const pairMatch = s.match(/([A-Z]{3}\/[A-Z]{3})/i);
    if (pairMatch) {
      return `${pairMatch[1].toUpperCase()} (OTC)`;
    }

    // Indices, Crypto & Commodities (e.g. FTSE 100, Bitcoin Cash (OTC), Gold)
    const generalMatch = s.match(/([A-Za-z0-9\.\-\s]+(?:\(OTC\))?)/i);
    if (generalMatch && generalMatch[1].trim().length >= 3) {
      return generalMatch[1].trim();
    }
    return null;
  }

  // ACTIVE-STATE DETERMINISTIC TAB FINDER (Never uses raw SVG counts)
  function getActiveTabFromDOM() {
    const candidateTabs = Array.from(document.querySelectorAll("*")).filter(el => {
      if (el.closest("#qx-assistant-panel")) return false;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.top > 75 || r.height < 20 || r.height > 60 || r.width < 45 || r.width > 300) return false;
      const text = el.innerText || el.textContent || "";
      const p = text.match(/\d{1,3}\s*%/g);
      return p && p.length === 1; // Strict: Exactly one tab element
    });

    if (candidateTabs.length === 0) return null;

    let bestTab = null;
    let highestScore = -1;

    for (const tab of candidateTabs) {
      let score = 0;
      const cls = (tab.className || "") + " " + (tab.getAttribute("aria-selected") || "");

      // 1. Check active class
      if (/(tab--active|tabs__item--active|is-active|\bactive\b|selected)/i.test(cls)) {
        score += 50;
      }

      // 2. Check jet black active background color
      try {
        const bg = window.getComputedStyle(tab).backgroundColor;
        const m = bg.match(/\d+/g);
        if (m && m.length >= 3) {
          const lum = 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
          if (lum < 22) score += 40; // Active tab in Quotex is black (lum < 20)
        }
      } catch (_) {}

      // 3. Check for close button or chevron dropdown (only present on active tab)
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

  // RETROACTIVE HISTORY HYDRATION
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
    console.log("[QX-Assistant] Active asset switched to:", newName);
    activeAsset = newName;
    state = getVaultEntry(activeAsset);

    tryHydrateCandles();
    saveVault();
    updateUI();
  }

  // 1. POINTERDOWN INTERCEPTOR (Only checks elements within tab width)
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

  // 2. DOM MUTATION OBSERVER
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

    // Purge candles if an incompatible price scale from another asset slipped in
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
      s: Math.min(...l.slice(-15)),
      r: Math.max(...h.slice(-15))
    };
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
          <strong>QX Assistant</strong> <small>v1.4.6</small>
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
            <span class="qx-label">Score:</span>
            <span id="qx-ui-score" class="qx-pill">0 / 5</span>
          </div>
          <div class="qx-tf-box">
            <div><strong>15m:</strong> <span id="qx-ui-15m">Neutral</span></div>
            <div><strong>5m:</strong> <span id="qx-ui-5m">Neutral</span></div>
            <div><strong>1m RSI:</strong> <span id="qx-ui-rsi">--</span></div>
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

    const rsiEl = document.getElementById("qx-ui-rsi");
    if (rsiEl) rsiEl.textContent = rsi !== null ? rsi.toFixed(1) : "--";

    const m15El = document.getElementById("qx-ui-15m");
    if (m15El) {
      m15El.textContent = sr.s && sr.r ? `S: ${sr.s.toFixed(dec)} | R: ${sr.r.toFixed(dec)}` : "Accumulating";
    }

    const m5El = document.getElementById("qx-ui-5m");
    if (m5El) m5El.textContent = m5List.length >= 2 ? (m5List[m5List.length - 1].close > m5List[0].close ? "Bullish" : "Bearish") : "Neutral";
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