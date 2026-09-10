(function () {
  const sessionAssetMap = new Map();

  function loadCache() {
    try {
      const raw = sessionStorage.getItem("__QX_SESSION_CACHE__");
      if (raw) JSON.parse(raw).forEach(([k, v]) => sessionAssetMap.set(k, v));
    } catch (_) {}
  }

  function saveCache() {
    try {
      sessionStorage.setItem("__QX_SESSION_CACHE__", JSON.stringify(Array.from(sessionAssetMap.entries())));
    } catch (_) {}
  }

  loadCache();

  function getAssetState(name) {
    if (!sessionAssetMap.has(name)) {
      sessionAssetMap.set(name, {
        name: name,
        livePrice: null,
        candles1m: [],
        currentCandle: null
      });
    }
    return sessionAssetMap.get(name);
  }

  // ==========================================
  // FOOLPROOF ACTIVE TAB DETECTOR
  // ==========================================
  function parseCleanName(str) {
    if (!str || typeof str !== "string") return null;
    let s = str.replace(/\b\d{1,3}%\b/g, "").replace(/[\n\r\t]/g, " ").trim();
    s = s.replace(/PAIR INFORMATION/gi, "").replace(/BEGINNING OF TRADE/gi, "").trim();

    // Ignore known system terms
    if (/^(settings|store|tick|live|demo|trade|chart|deposit)$/i.test(s)) return null;

    // Currency pairs: USD/BRL (OTC), USD/BDT (OTC), NZD/JPY (OTC)
    const pairMatch = s.match(/([A-Z]{3}\/[A-Z]{3}(?:\s*(?:\(OTC\)|OTC))?)/i);
    if (pairMatch) return pairMatch[1].trim();

    // Single-word Cryptos/Commodities: Cosmos (OTC), Bitcoin (OTC), Gold (OTC)
    const otcMatch = s.match(/([A-Za-z0-9\.\-\s]+(?:\(OTC\)|OTC))/i);
    if (otcMatch) {
      const name = otcMatch[1].trim();
      if (name.length >= 3 && name.length <= 25) return name;
    }
    return null;
  }

  function detectActiveAssetFromDOM() {
    // Look at top header tab bar (within top 75px of the viewport)
    const candidates = document.querySelectorAll("div, button, a");
    for (const el of candidates) {
      if (el.closest("#qx-assistant-panel")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 75 || rect.height < 20 || rect.width < 50) continue;

      // In Quotex, the active tab has the close button (x) AND chevron (v) -> at least 2 SVGs
      const svgs = el.querySelectorAll("svg");
      if (svgs.length >= 2) {
        const name = parseCleanName(el.innerText || el.textContent || "");
        if (name) return name;
      }
    }

    // Fallback: search any element having active/selected class in top area
    for (const el of candidates) {
      if (el.closest("#qx-assistant-panel")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top > 75) continue;
      const cls = (el.className || "") + " " + (el.getAttribute("aria-selected") || "");
      if (/active|selected/i.test(cls)) {
        const name = parseCleanName(el.innerText || el.textContent || "");
        if (name) return name;
      }
    }

    return null;
  }

  let activeAsset = detectActiveAssetFromDOM() || "Cosmos (OTC)";
  let state = getAssetState(activeAsset);

  function switchAsset(newName) {
    if (!newName || newName === activeAsset) return;
    activeAsset = newName;
    state = getAssetState(activeAsset);
    saveCache();
    updateUI();
  }

  // Instant capture click on tabs
  document.addEventListener("click", (e) => {
    if (e.target.closest("#qx-assistant-panel")) return;
    let node = e.target;
    for (let i = 0; i < 4 && node && node !== document.body; i++) {
      const name = parseCleanName(node.innerText || node.textContent || "");
      if (name) {
        switchAsset(name);
        break;
      }
      node = node.parentElement;
    }
  }, true);

  setInterval(() => {
    const domAsset = detectActiveAssetFromDOM();
    if (domAsset && domAsset !== activeAsset) {
      switchAsset(domAsset);
    }
  }, 400);

  // ==========================================
  // REAL-TIME PRICE & HISTORY (WITH PRICE SANITY GUARD)
  // ==========================================
  function ingestFastTick(price, time) {
    state.livePrice = price;
    const minFloor = Math.floor(time / 60000) * 60000;

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
      saveCache();
    }

    const priceEl = document.getElementById("qx-ui-price");
    if (priceEl) priceEl.textContent = price.toFixed(5);
    updateAnalysis();
  }

  function ingestHistory(candles) {
    if (!candles || candles.length === 0) return;

    // SANITY GUARD: Reject candle packets from other assets (e.g. 126.0 when Cosmos is 1.87)
    if (state.livePrice !== null) {
      const sampleClose = candles[candles.length - 1].close;
      const ratio = sampleClose / state.livePrice;
      if (ratio < 0.5 || ratio > 2.0) {
        return; // Mismatched asset history discarded
      }
    }

    const map = new Map();
    state.candles1m.forEach(c => map.set(c.time, c));
    candles.forEach(c => map.set(c.time, c));
    state.candles1m = Array.from(map.values()).sort((a, b) => a.time - b.time);
    if (state.candles1m.length > 240) state.candles1m = state.candles1m.slice(-240);
    saveCache();
    updateUI();
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

  // ==========================================
  // DRAGGABLE UI SETUP
  // ==========================================
  function mountUI() {
    if (document.getElementById("qx-assistant-panel")) return;
    if (!document.body) return;

    const panel = document.createElement("div");
    panel.id = "qx-assistant-panel";
    panel.innerHTML = `
      <div id="qx-panel-header">
        <div id="qx-panel-title">
          <span class="qx-badge">READ ONLY</span>
          <strong>QX Assistant</strong> <small>v1.3.3</small>
        </div>
        <div id="qx-panel-controls">
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
    const m1List = [...state.candles1m];
    if (state.currentCandle) m1List.push(state.currentCandle);
    const m5List = getAggregate(state.candles1m, state.currentCandle, 5);
    const m15List = getAggregate(state.candles1m, state.currentCandle, 15);

    const cnt1m = document.getElementById("qx-cnt-1m");
    const cnt5m = document.getElementById("qx-cnt-5m");
    const cnt15m = document.getElementById("qx-cnt-15m");
    if (cnt1m) cnt1m.textContent = m1List.length;
    if (cnt5m) cnt5m.textContent = m5List.length;
    if (cnt15m) cnt15m.textContent = m15List.length;

    const rsi = calcRSI(m1List, 14);
    const sr = calcSR(m1List);

    const rsiEl = document.getElementById("qx-ui-rsi");
    if (rsiEl) rsiEl.textContent = rsi !== null ? rsi.toFixed(1) : "--";

    const m15El = document.getElementById("qx-ui-15m");
    if (m15El) m15El.textContent = sr.s && sr.r ? `S: ${sr.s.toFixed(4)} | R: ${sr.r.toFixed(4)}` : "Accumulating";

    const m5El = document.getElementById("qx-ui-5m");
    if (m5El) m5El.textContent = m5List.length >= 2 ? (m5List[m5List.length - 1].close > m5List[0].close ? "Bullish" : "Bearish") : "Neutral";
  }

  function updateUI() {
    const assetEl = document.getElementById("qx-ui-asset");
    if (!assetEl) return;
    assetEl.textContent = activeAsset;

    if (state.livePrice !== null) {
      const priceEl = document.getElementById("qx-ui-price");
      if (priceEl) priceEl.textContent = state.livePrice.toFixed(5);
    }
    updateAnalysis();
  }

  window.addEventListener("message", (e) => {
    if (e.data?.type === "QX_FAST_PRICE_TICK") {
      ingestFastTick(e.data.payload.price, e.data.payload.timestamp);
    } else if (e.data?.type === "QX_HISTORICAL_CANDLES") {
      ingestHistory(e.data.payload);
    }
  });
})();