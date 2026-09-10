/**
 * QX Chart Assistant - Content Script (v1.2.7-analysis)
 */

(function () {
  const MAX_SESSION_ASSETS = 10;
  const sessionAssetMap = new Map();

  function loadSessionCache() {
    try {
      const raw = sessionStorage.getItem('__QX_SESSION_CACHE__');
      if (raw) {
        const entries = JSON.parse(raw);
        entries.forEach(([name, data]) => {
          sessionAssetMap.set(name, data);
        });
      }
    } catch (_) {}
  }

  function persistSessionCache() {
    try {
      const serialized = JSON.stringify(Array.from(sessionAssetMap.entries()));
      sessionStorage.setItem('__QX_SESSION_CACHE__', serialized);
    } catch (_) {}
  }

  loadSessionCache();

  function createAssetState(name) {
    return {
      assetName: name,
      selectedTextureId: null,
      livePrice: null,
      rawPriceText: null,
      lastTickTime: null,
      candles1m: [],
      current1mCandle: null,
      lastAccessTime: Date.now()
    };
  }

  function getOrInitAsset(name) {
    if (!sessionAssetMap.has(name)) {
      if (sessionAssetMap.size >= MAX_SESSION_ASSETS) {
        let oldestName = null;
        let oldestTime = Infinity;
        for (const [k, v] of sessionAssetMap.entries()) {
          if (v.lastAccessTime < oldestTime) {
            oldestTime = v.lastAccessTime;
            oldestName = k;
          }
        }
        if (oldestName) sessionAssetMap.delete(oldestName);
      }
      sessionAssetMap.set(name, createAssetState(name));
    }
    const asset = sessionAssetMap.get(name);
    asset.lastAccessTime = Date.now();
    return asset;
  }

  function detectActiveAsset() {
    const activeTab = document.querySelector('.tab--active .tab-asset__name, .tab--active, [class*="tab"][class*="active"]');
    if (activeTab && activeTab.textContent) {
      const clean = activeTab.textContent.replace(/[\n\r\t]/g, ' ').trim();
      const match = clean.match(/([A-Z]{3}\/[A-Z]{3}(\s+OTC)?|[A-Z]{3,6}(\s+OTC)?)/i);
      if (match) return match[0].toUpperCase();
    }
    const selector = document.querySelector('.asset-select__button, .asset-select, .current-asset');
    if (selector && selector.textContent) {
      const clean = selector.textContent.replace(/[\n\r\t]/g, ' ').trim();
      const match = clean.match(/([A-Z]{3}\/[A-Z]{3}(\s+OTC)?|[A-Z]{3,6}(\s+OTC)?)/i);
      if (match) return match[0].toUpperCase();
    }
    const docTitle = document.title || '';
    const titleMatch = docTitle.match(/([A-Z]{3}\/[A-Z]{3}(\s+OTC)?)/i);
    if (titleMatch) return titleMatch[0].toUpperCase();
    return 'EUR/USD OTC';
  }

  let currentAssetName = detectActiveAsset();
  let currentAsset = getOrInitAsset(currentAssetName);

  setInterval(() => {
    const detected = detectActiveAsset();
    if (detected !== currentAssetName) {
      currentAssetName = detected;
      currentAsset = getOrInitAsset(currentAssetName);
      window.postMessage({ type: 'QX_CMD_RESET_ASSET_LOCK', payload: { asset: currentAssetName } }, '*');
      persistSessionCache();
      updateAssetUI();
    }
  }, 400);

  function ingestHistoricalCandles(candles, source) {
    if (!candles || candles.length === 0) return;
    const existing = new Map();
    currentAsset.candles1m.forEach(c => existing.set(c.time, c));
    candles.forEach(c => existing.set(c.time, c));
    currentAsset.candles1m = Array.from(existing.values()).sort((a, b) => a.time - b.time);
    if (currentAsset.candles1m.length > 240) {
      currentAsset.candles1m = currentAsset.candles1m.slice(-240);
    }
    persistSessionCache();
    runAnalysis();
    updateUI();
  }

  function ingestPriceTick(price, timestamp, textureId) {
    currentAsset.livePrice = price;
    currentAsset.lastTickTime = timestamp;
    currentAsset.selectedTextureId = textureId;

    const minuteFloor = Math.floor(timestamp / 60000) * 60000;

    if (!currentAsset.current1mCandle) {
      currentAsset.current1mCandle = {
        time: minuteFloor,
        open: price,
        high: price,
        low: price,
        close: price
      };
    } else if (currentAsset.current1mCandle.time === minuteFloor) {
      currentAsset.current1mCandle.high = Math.max(currentAsset.current1mCandle.high, price);
      currentAsset.current1mCandle.low = Math.min(currentAsset.current1mCandle.low, price);
      currentAsset.current1mCandle.close = price;
    } else if (minuteFloor > currentAsset.current1mCandle.time) {
      currentAsset.candles1m.push(Object.assign({}, currentAsset.current1mCandle));
      if (currentAsset.candles1m.length > 240) currentAsset.candles1m.shift();

      currentAsset.current1mCandle = {
        time: minuteFloor,
        open: price,
        high: price,
        low: price,
        close: price
      };
      persistSessionCache();
    }

    runAnalysis();
    updateUI();
  }

  function buildAggregatedCandles(candles1m, current1m, periodMinutes) {
    const all = [...candles1m];
    if (current1m) all.push(current1m);
    if (all.length === 0) return [];

    const periodMs = periodMinutes * 60000;
    const map = new Map();

    all.forEach(c => {
      const bucket = Math.floor(c.time / periodMs) * periodMs;
      if (!map.has(bucket)) {
        map.set(bucket, {
          time: bucket,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        });
      } else {
        const ag = map.get(bucket);
        ag.high = Math.max(ag.high, c.high);
        ag.low = Math.min(ag.low, c.low);
        ag.close = c.close;
      }
    });

    return Array.from(map.values()).sort((a, b) => a.time - b.time);
  }

  function calculateEMA(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((acc, c) => acc + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) {
      ema = (candles[i].close * k) + (ema * (1 - k));
    }
    return ema;
  }

  function calculateRSI(candles, period = 14) {
    if (candles.length <= period) return null;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < candles.length; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      const gain = diff >= 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  function detectSRZones(candles) {
    if (candles.length < 5) return { support: null, resistance: null };
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const res = Math.max(...highs.slice(-15));
    const sup = Math.min(...lows.slice(-15));
    return { support: sup, resistance: res };
  }

  function detectCandlePattern(candles) {
    if (candles.length < 2) return 'Neutral';
    const curr = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const currBody = Math.abs(curr.close - curr.open);

    if (prev.close < prev.open && curr.close > curr.open && curr.close >= prev.open && curr.open <= prev.close) {
      return 'Bullish Engulfing';
    }
    if (prev.close > prev.open && curr.close < curr.open && curr.close <= prev.open && curr.open >= prev.close) {
      return 'Bearish Engulfing';
    }
    const lowerWick = Math.min(curr.open, curr.close) - curr.low;
    if (lowerWick > currBody * 2 && currBody > 0) {
      return 'Hammer (Rejection)';
    }
    const upperWick = curr.high - Math.max(curr.open, curr.close);
    if (upperWick > currBody * 2 && currBody > 0) {
      return 'Shooting Star';
    }
    return 'Regular Candle';
  }

  let analysisState = {
    warmupText: 'Scanning chart history...',
    m15: { trend: 'Neutral', support: null, resistance: null },
    m5: { trend: 'Neutral', structure: 'Analyzing structure' },
    m1: { rsi: null, pattern: 'Neutral', ema8: null, ema20: null },
    setup: {
      type: 'Scanning...',
      score: 0,
      totalRules: 5,
      rules: []
    }
  };

  function runAnalysis() {
    const candles1m = [...currentAsset.candles1m];
    if (currentAsset.current1mCandle) candles1m.push(currentAsset.current1mCandle);

    const candles5m = buildAggregatedCandles(currentAsset.candles1m, currentAsset.current1mCandle, 5);
    const candles15m = buildAggregatedCandles(currentAsset.candles1m, currentAsset.current1mCandle, 15);

    const count1m = candles1m.length;
    if (count1m < 5) {
      analysisState.warmupText = `Waiting for chart history (${count1m} candles)...`;
      analysisState.setup.type = 'Neutral (Accumulating)';
      return;
    }

    analysisState.warmupText = `Analysis active: ${count1m} candles loaded`;

    const rsi1m = calculateRSI(candles1m, 14);
    const ema8_1m = calculateEMA(candles1m, 8);
    const ema20_1m = calculateEMA(candles1m, 20);
    const pattern1m = detectCandlePattern(candles1m);
    const sr1m = detectSRZones(candles1m);

    analysisState.m1 = {
      rsi: rsi1m,
      ema8: ema8_1m,
      ema20: ema20_1m,
      pattern: pattern1m
    };

    const sr5m = detectSRZones(candles5m);
    let trend5m = 'Neutral';
    if (candles5m.length >= 2) {
      trend5m = candles5m[candles5m.length - 1].close > candles5m[0].close ? 'Bullish' : 'Bearish';
    }
    analysisState.m5 = {
      trend: trend5m,
      structure: trend5m === 'Bullish' ? 'Structure bullish' : 'Structure bearish'
    };

    const sr15m = detectSRZones(candles15m);
    analysisState.m15 = {
      trend: candles15m.length > 1 ? (candles15m[candles15m.length - 1].close >= candles15m[0].close ? 'Bullish' : 'Bearish') : 'Consolidating',
      support: sr15m.support || sr1m.support,
      resistance: sr15m.resistance || sr1m.resistance
    };

    const rules = [];
    const currentPrice = currentAsset.livePrice;

    const nearSupport = sr1m.support && Math.abs(currentPrice - sr1m.support) <= (sr1m.support * 0.0004);
    const nearResistance = sr1m.resistance && Math.abs(currentPrice - sr1m.resistance) <= (sr1m.resistance * 0.0004);
    rules.push({ text: 'Near identified S/R zone', passed: Boolean(nearSupport || nearResistance) });

    const rsiBull = rsi1m !== null && rsi1m <= 38;
    const rsiBear = rsi1m !== null && rsi1m >= 62;
    rules.push({ text: 'RSI in reaction zone (<=38 or >=62)', passed: Boolean(rsiBull || rsiBear) });

    const patternPassed = pattern1m.includes('Engulfing') || pattern1m.includes('Hammer') || pattern1m.includes('Shooting');
    rules.push({ text: `Pattern confirmation (${pattern1m})`, passed: patternPassed });

    const trendAlign = (trend5m === 'Bullish' && nearSupport) || (trend5m === 'Bearish' && nearResistance);
    rules.push({ text: 'HTF (5m) trend structure aligned', passed: Boolean(trendAlign) });

    const emaSlopePassed = ema8_1m && ema20_1m ? (nearSupport ? ema8_1m >= ema20_1m * 0.9999 : ema8_1m <= ema20_1m * 1.0001) : false;
    rules.push({ text: 'EMA dynamic reaction', passed: Boolean(emaSlopePassed) });

    const passedCount = rules.filter(r => r.passed).length;
    let setupType = 'Neutral / Scanning';
    if (passedCount >= 4) {
      setupType = nearSupport || rsiBull ? 'Potential Bullish Setup' : 'Potential Bearish Setup';
    } else if (passedCount >= 3) {
      setupType = 'Developing Opportunity';
    }

    analysisState.setup = {
      type: setupType,
      score: passedCount,
      totalRules: rules.length,
      rules: rules
    };
  }

  function initUI() {
    if (document.getElementById('qx-assistant-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'qx-assistant-panel';
    panel.innerHTML = `
      <div id="qx-panel-header">
        <div id="qx-panel-title">
          <span class="qx-badge">READ ONLY</span>
          <strong>QX Assistant</strong> <small>v1.2.7</small>
        </div>
        <div id="qx-panel-controls">
          <button id="qx-btn-reset-pos" title="Reset Position">↺</button>
          <button id="qx-btn-minimize" title="Minimize">—</button>
        </div>
      </div>
      <div id="qx-panel-body">
        <div class="qx-section">
          <div class="qx-row">
            <span class="qx-label">Asset:</span>
            <strong id="qx-val-asset">${currentAssetName}</strong>
            <span class="qx-pill" id="qx-val-cached-count">RAM: 1</span>
          </div>
          <div class="qx-row">
            <span class="qx-label">Price:</span>
            <span id="qx-val-price" class="qx-price">Detecting...</span>
          </div>
          <div class="qx-row">
            <span class="qx-label">Source:</span>
            <span id="qx-val-source" class="qx-subtext">Auto-locking WebGL...</span>
          </div>
        </div>

        <div class="qx-section qx-setup-card">
          <div class="qx-section-title">STRATEGY ANALYSIS (1-MIN TRADES)</div>
          <div class="qx-row">
            <span class="qx-label">Signal:</span>
            <strong id="qx-setup-name" class="qx-accent-text">Scanning...</strong>
          </div>
          <div class="qx-row">
            <span class="qx-label">Rules Matched:</span>
            <span id="qx-setup-score" class="qx-pill">0 / 5</span>
          </div>
          <div id="qx-setup-rules-list" class="qx-rules-container"></div>
          <div class="qx-disclaimer">Analysis only. Never automate or place trades.</div>
        </div>

        <div class="qx-section">
          <div class="qx-section-title">MULTI-TIMEFRAME CONTEXT</div>
          <div class="qx-timeframe-box">
            <div class="qx-tf-row">
              <strong>15m Context:</strong> <span id="qx-tf-15m">Loading...</span>
            </div>
            <div class="qx-tf-row">
              <strong>5m Context:</strong> <span id="qx-tf-5m">Loading...</span>
            </div>
            <div class="qx-tf-row">
              <strong>1m Trigger:</strong> <span id="qx-tf-1m">Loading...</span>
            </div>
          </div>
          <div class="qx-row qx-mt-6">
            <span class="qx-subtext" id="qx-warmup-info">Scanning chart...</span>
          </div>
        </div>

        <div class="qx-section">
          <div class="qx-section-title">SESSION CANDLE COUNTERS</div>
          <div class="qx-grid-3">
            <div class="qx-stat-box">
              <div class="qx-stat-label">1m Candles</div>
              <div class="qx-stat-val" id="qx-stat-1m">0</div>
            </div>
            <div class="qx-stat-box">
              <div class="qx-stat-label">5m Derived</div>
              <div class="qx-stat-val" id="qx-stat-5m">0</div>
            </div>
            <div class="qx-stat-box">
              <div class="qx-stat-label">15m Derived</div>
              <div class="qx-stat-val" id="qx-stat-15m">0</div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    const savedPos = localStorage.getItem('__qx_panel_pos__');
    if (savedPos) {
      try {
        const { left, top } = JSON.parse(savedPos);
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = 'auto';
      } catch (_) {}
    }

    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };
    const header = panel.querySelector('#qx-panel-header');

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      dragOffset.x = e.clientX - panel.offsetLeft;
      dragOffset.y = e.clientY - panel.offsetTop;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const x = Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, e.clientX - dragOffset.x));
      const y = Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, e.clientY - dragOffset.y));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
    }

    function onMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      localStorage.setItem('__qx_panel_pos__', JSON.stringify({
        left: panel.offsetLeft,
        top: panel.offsetTop
      }));
    }

    panel.querySelector('#qx-btn-reset-pos').addEventListener('click', () => {
      panel.style.left = 'auto';
      panel.style.top = '70px';
      panel.style.right = '20px';
      localStorage.removeItem('__qx_panel_pos__');
    });

    const bodyEl = panel.querySelector('#qx-panel-body');
    panel.querySelector('#qx-btn-minimize').addEventListener('click', (e) => {
      const isHidden = bodyEl.style.display === 'none';
      bodyEl.style.display = isHidden ? 'block' : 'none';
      e.target.textContent = isHidden ? '—' : '+';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }

  function updateAssetUI() {
    const assetEl = document.getElementById('qx-val-asset');
    if (assetEl) assetEl.textContent = currentAssetName;
    const countEl = document.getElementById('qx-val-cached-count');
    if (countEl) countEl.textContent = `RAM: ${sessionAssetMap.size}`;
    updateUI();
  }

  function updateUI() {
    const priceEl = document.getElementById('qx-val-price');
    if (!priceEl) return;

    if (currentAsset.livePrice !== null) {
      priceEl.textContent = currentAsset.livePrice.toFixed(5);
      document.getElementById('qx-val-source').textContent = `${currentAsset.selectedTextureId || 'Auto'} (Live continuous)`;
    }

    const m1Count = currentAsset.candles1m.length + (currentAsset.current1mCandle ? 1 : 0);
    const m5Candles = buildAggregatedCandles(currentAsset.candles1m, currentAsset.current1mCandle, 5);
    const m15Candles = buildAggregatedCandles(currentAsset.candles1m, currentAsset.current1mCandle, 15);

    document.getElementById('qx-stat-1m').textContent = m1Count;
    document.getElementById('qx-stat-5m').textContent = m5Candles.length;
    document.getElementById('qx-stat-15m').textContent = m15Candles.length;

    const setupNameEl = document.getElementById('qx-setup-name');
    setupNameEl.textContent = analysisState.setup.type;
    if (analysisState.setup.type.includes('Bullish')) {
      setupNameEl.className = 'qx-setup-bullish';
    } else if (analysisState.setup.type.includes('Bearish')) {
      setupNameEl.className = 'qx-setup-bearish';
    } else {
      setupNameEl.className = 'qx-accent-text';
    }

    document.getElementById('qx-setup-score').textContent = `${analysisState.setup.score} / ${analysisState.setup.totalRules}`;

    const rulesEl = document.getElementById('qx-setup-rules-list');
    rulesEl.innerHTML = analysisState.setup.rules.map(r => `
      <div class="qx-rule-item ${r.passed ? 'qx-rule-pass' : 'qx-rule-fail'}">
        <span>${r.passed ? '✓' : '✗'}</span> ${r.text}
      </div>
    `).join('');

    document.getElementById('qx-tf-15m').textContent = `Structure: ${analysisState.m15.trend} | S: ${analysisState.m15.support ? analysisState.m15.support.toFixed(5) : '—'} | R: ${analysisState.m15.resistance ? analysisState.m15.resistance.toFixed(5) : '—'}`;
    document.getElementById('qx-tf-5m').textContent = `${analysisState.m5.structure} (${analysisState.m5.trend})`;
    document.getElementById('qx-tf-1m').textContent = `RSI: ${analysisState.m1.rsi !== null ? analysisState.m1.rsi.toFixed(1) : '—'} | Pattern: ${analysisState.m1.pattern}`;
    document.getElementById('qx-warmup-info').textContent = analysisState.warmupText;
  }

  window.addEventListener('message', (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    const { type, payload } = ev.data;

    if (type === 'QX_HISTORICAL_CANDLES') {
      ingestHistoricalCandles(payload.candles, payload.source);
    } else if (type === 'QX_PRICE_UPDATE') {
      currentAsset.rawPriceText = payload.rawText;
      ingestPriceTick(payload.price, payload.timestamp, payload.textureId);
    }
  });

})();
