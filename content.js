(function () {
  const sessionAssetMap = new Map();

  function loadCache() {
    try {
      const raw = sessionStorage.getItem("__QX_SESSION_CACHE__");
      if (raw) {
        JSON.parse(raw).forEach(([k, v]) => sessionAssetMap.set(k, v));
      }
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
  // PRECISE ACTIVE TAB DETECTION (BASED ON CLOSE 'X' & CHEVRON)
  // ==========================================
  function parseCleanName(str) {
    if (!str) return null;
    let clean = str.replace(/[\n\r\t]/g, " ").replace(/\d+%/g, "").trim();
    const m = clean.match(/([A-Za-z0-9\/\-\s]+(\(OTC\)|OTC)?)/i);
    if (m && m[0].trim().length >= 3) {
      const res = m[0].trim();
      if (!res.includes("PAIR") && !res.includes("INFORMATION")) return res;
    }
    return null;
  }

  function detectActiveAsset() {
    // 1. Only the active Quotex tab has the close button (x)
    const closeButtons = document.querySelectorAll(
      "button[class*='close'], svg[class*='close'], [class*='tab__close'], [class*='tab-close']"
    );
    for (const btn of closeButtons) {
      const parentTab = btn.closest("[class*='tab'], [class*='item']");
      if (parentTab) {
        const clone = parentTab.cloneNode(true);
        clone.querySelectorAll("button, svg, [class*='close'], [class*='payout'], [class*='percent']").forEach(n => n.remove());
        const name = parseCleanName(clone.textContent);
        if (name) return name;
      }
    }

    // 2. Active tab with chevron/arrow
    const dropdownIcons = document.querySelectorAll("[class*='arrow'], [class*='chevron']");
    for (const icon of dropdownIcons) {
      const parentTab = icon.closest("[class*='tab'], [class*='item']");
      if (parentTab) {
        const clone = parentTab.cloneNode(true);
        clone.querySelectorAll("button, svg, [class*='payout'], [class*='percent']").forEach(n => n.remove());
        const name = parseCleanName(clone.textContent);
        if (name) return name;
      }
    }

    // 3. Elements with active class
    const activeTabs = document.querySelectorAll("[class*='tab'][class*='active'], [class*='tab--active'], [class*='is-active']");
    for (const tab of activeTabs) {
      const clone = tab.cloneNode(true);
      clone.querySelectorAll("button, svg, [class*='close'], [class*='payout'], [class*='percent']").forEach(n => n.remove());
      const name = parseCleanName(clone.textContent);
      if (name) return name;
    }

    return null;
  }

  let activeAsset = detectActiveAsset() || "USD/BRL (OTC)";
  let state = getAssetState(activeAsset);

  function switchAsset(newAsset) {
    if (!newAsset || newAsset === activeAsset) return;
    activeAsset = newAsset;
    state = getAssetState(activeAsset);
    window.postMessage({ type: "QX_RESET_LOCK" }, "*");
    saveCache();
    updateUI();
  }

  document.addEventListener("click", () => {
    setTimeout(() => switchAsset(detectActiveAsset()), 100);
    setTimeout(() => switchAsset(detectActiveAsset()), 350);
  });

  setInterval(() => {
    const detected = detectActiveAsset();
    if (detected && detected !== activeAsset) {
      switchAsset(detected);
    }
  }, 500);

  function ingestHistory(candles) {
    if (!candles || candles.length === 0) return;
    const map = new Map();
    state.candles1m.forEach(c => map.set(c.time, c));
    candles.forEach(c => map.set(c.time, c));
    state.candles1m = Array.from(map.values()).sort((a, b) => a.time - b.time);
    if (state.candles1m.length > 240) state.candles1m = state.candles1m.slice(-240);
    saveCache();
    updateUI();
  }

  function ingestTick(price, time) {
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
  // DRAGGABLE UI COMPONENT
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
          <strong>QX Assistant</strong> <small>v1.3.1</small>
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
    if (document.getElementById("qx-assistant-panel")) {
      clearInterval(checkTimer);
    } else {
      mountUI();
    }
  }, 500);

  function updateUI() {
    const assetEl = document.getElementById("qx-ui-asset");
    if (!assetEl) return;
    assetEl.textContent = activeAsset;

    if (state.livePrice !== null) {
      const priceEl = document.getElementById("qx-ui-price");
      if (priceEl) priceEl.textContent = state.livePrice.toFixed(5);
    }

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
    if (m15El) m15El.textContent = sr.s && sr.r ? `S: ${sr.s.toFixed(3)} | R: ${sr.r.toFixed(3)}` : "Accumulating";

    const m5El = document.getElementById("qx-ui-5m");
    if (m5El) m5El.textContent = m5List.length >= 2 ? (m5List[m5List.length - 1].close > m5List[0].close ? "Bullish" : "Bearish") : "Neutral";
  }

  window.addEventListener("message", (e) => {
    if (e.data?.type === "QX_PRICE_TICK") {
      ingestTick(e.data.payload.price, e.data.payload.timestamp);
    } else if (e.data?.type === "QX_HISTORICAL_CANDLES") {
      ingestHistory(e.data.payload);
    }
  });
})();