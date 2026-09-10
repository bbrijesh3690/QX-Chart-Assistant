(function () {
  const assetVault = new Map();
  let pendingCandles = null;

  function loadVault() {
    try {
      const raw = sessionStorage.getItem("__QX_ASSET_VAULT__");
      if (raw) JSON.parse(raw).forEach(([k, v]) => assetVault.set(k, v));
    } catch (_) {}
  }

  function saveVault() {
    try {
      sessionStorage.setItem("__QX_ASSET_VAULT__", JSON.stringify(Array.from(assetVault.entries())));
    } catch (_) {}
  }

  loadVault();

  function getVaultEntry(name) {
    if (!name || name === "Detecting...") {
      return { candles1m: [], currentCandle: null, livePrice: null, rawPrice: null, decimals: 2 };
    }
    if (!assetVault.has(name)) {
      assetVault.set(name, {
        candles1m: [],
        currentCandle: null,
        livePrice: null,
        rawPrice: null,
        decimals: 2
      });
    }
    return assetVault.get(name);
  }

  // UNIVERSAL CLEANER: Strips payout %, UI buttons, and spaces
  function cleanAssetName(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.replace(/\b\d{1,3}%\b/g, "").replace(/[\n\r\t]/g, " ").trim();
    if (/^(settings|store|tick|live|demo|trade|chart|deposit|pair information|beginning of trade)$/i.test(s)) return null;
    s = s.replace(/PAIR INFORMATION/gi, "").replace(/BEGINNING OF TRADE/gi, "").trim();
    s = s.replace(/\s+/g, " ");

    if (s.length >= 3 && s.length <= 30 && !/^\d+$/.test(s)) {
      return s;
    }
    return null;
  }

  // TARGETS ACTIVE TAB IN TOP STRIP
  function getActiveTabName() {
    // 1. Target tab containing the close cross (x)
    const closeButtons = document.querySelectorAll(
      "button[class*='close'], svg[class*='close'], [class*='tab-close'], [class*='tab__close'], [aria-label*='close']"
    );
    for (const btn of closeButtons) {
      if (btn.closest("#qx-assistant-panel")) continue;
      const tab = btn.closest("[class*='tab'], [class*='item'], div");
      if (tab && tab.getBoundingClientRect().top <= 110) {
        const clone = tab.cloneNode(true);
        clone.querySelectorAll("button, svg, [class*='close']").forEach(n => n.remove());
        const name = cleanAssetName(clone.textContent || clone.innerText);
        if (name) return name;
      }
    }

    // 2. Target tab with dropdown chevron
    const dropdowns = document.querySelectorAll("[class*='dropdown'], [class*='chevron'], [class*='arrow']");
    for (const d of dropdowns) {
      if (d.closest("#qx-assistant-panel")) continue;
      const tab = d.closest("[class*='tab'], [class*='item'], div");
      if (tab && tab.getBoundingClientRect().top <= 110) {
        const clone = tab.cloneNode(true);
        clone.querySelectorAll("button, svg").forEach(n => n.remove());
        const name = cleanAssetName(clone.textContent || clone.innerText);
        if (name) return name;
      }
    }

    // 3. Fallback to active class
    const activeEls = document.querySelectorAll(
      ".tab--active, .tabs__item--active, [class*='tab'][class*='active'], [class*='item'][class*='active'], [aria-selected='true']"
    );
    for (const el of activeEls) {
      if (el.closest("#qx-assistant-panel")) continue;
      if (el.getBoundingClientRect().top <= 110) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll("button, svg, [class*='close']").forEach(n => n.remove());
        const name = cleanAssetName(clone.textContent || clone.innerText);
        if (name) return name;
      }
    }

    return null;
  }

  let activeAsset = getActiveTabName() || "Detecting...";
  let state = getVaultEntry(activeAsset);

  function switchAsset(newName) {
    if (!newName || newName === activeAsset || newName === "Detecting...") return;
    console.log("[QX-Assistant] Switch active asset to:", newName);
    activeAsset = newName;
    state = getVaultEntry(activeAsset);

    if (pendingCandles && pendingCandles.length > 0) {
      ingestHistory(pendingCandles, pendingCandles[pendingCandles.length - 1].close);
      pendingCandles = null;
    }

    saveVault();
    updateUI();
  }

  // Pointerdown interceptor on tab row
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#qx-assistant-panel")) return;
    let el = e.target;
    for (let i = 0; i < 5 && el && el !== document.body; i++) {
      if (el.getBoundingClientRect().top <= 110) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll("button, svg").forEach(n => n.remove());
        const name = cleanAssetName(clone.textContent || clone.innerText);
        if (name) {
          switchAsset(name);
          break;
        }
      }
      el = el.parentElement;
    }
  }, true);

  setInterval(() => {
    const current = getActiveTabName();
    if (current && current !== activeAsset) {
      switchAsset(current);
    }
  }, 350);

  // ==========================================
  // PRICE INGESTION & OUTLIER GUARD
  // ==========================================
  function ingestFastTick(price, rawText, decimals, time) {
    if (activeAsset === "Detecting...") {
      const found = getActiveTabName();
      if (found) switchAsset(found);
    }

    state.livePrice = price;
    state.rawPrice = rawText;
    if (decimals !== undefined) state.decimals = decimals;

    const minFloor = Math.floor(time / 60000) * 60000;

    // Purge contaminated candles from a previous price scale
    if (state.candles1m.length > 0) {
      const last = state.candles1m[state.candles1m.length - 1];
      if (Math.abs(last.close - price) / price > 0.45) {
        state.candles1m = [];
        state.currentCandle = null;
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

    if (activeAsset === "Detecting...") {
      pendingCandles = candles;
      const found = getActiveTabName();
      if (found) switchAsset(found);
      return;
    }

    let targetAsset = activeAsset;
    if (state.livePrice !== null && Math.abs(samplePrice - state.livePrice) / state.livePrice > 0.3) {
      targetAsset = null;
      for (const [name, data] of assetVault.entries()) {
        if (data.livePrice !== null && Math.abs(samplePrice - data.livePrice) / data.livePrice <= 0.3) {
          targetAsset = name;
          break;
        }
      }
    }

    if (!targetAsset || targetAsset === "Detecting...") {
      pendingCandles = candles;
      return;
    }

    const targetState = getVaultEntry(targetAsset);
    const map = new Map();
    targetState.candles1m.forEach(c => map.set(c.time, c));
    candles.forEach(c => map.set(c.time, c));
    targetState.candles1m = Array.from(map.values()).sort((a, b) => a.time - b.time);
    if (targetState.candles1m.length > 240) targetState.candles1m = targetState.candles1m.slice(-240);

    saveVault();
    if (targetAsset === activeAsset) {
      updateUI();
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
          <strong>QX Assistant</strong> <small>v1.4.1</small>
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
      const found = getActiveTabName();
      if (found) switchAsset(found);
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
    const dec = state.decimals !== undefined ? state.decimals : 2;

    // SANITY FILTER: Candles must be within 30% of current live price
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
      priceEl.textContent = state.rawPrice || state.livePrice.toFixed(state.decimals !== undefined ? state.decimals : 2);
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