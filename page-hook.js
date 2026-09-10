(function () {
  if (window.__QX_PAGE_HOOK__) return;
  window.__QX_PAGE_HOOK__ = true;

  // 1. FAST 60FPS PRICE PASS-THROUGH
  let lastPrice = null;
  let lastTime = 0;
  const origFill = CanvasRenderingContext2D.prototype.fillText;

  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxW) {
    if (typeof text === "string") {
      const clean = text.trim();
      if (/^\d{1,6}\.\d{2,6}$/.test(clean)) {
        const val = parseFloat(clean);
        if (!isNaN(val) && val > 0) {
          const now = Date.now();
          if (val !== lastPrice || (now - lastTime > 200)) {
            lastPrice = val;
            lastTime = now;
            window.postMessage({
              type: "QX_FAST_PRICE_TICK",
              payload: { price: val, timestamp: now }
            }, "*");
          }
        }
      }
    }
    return origFill.apply(this, arguments);
  };

  // 2. WEBSOCKET CANDLE & ASSET PARSER
  function parseCandle(item) {
    if (!item) return null;
    if (typeof item === "object" && !Array.isArray(item)) {
      const t = item.time ?? item.timestamp ?? item.t;
      const o = item.open ?? item.o;
      const h = item.high ?? item.h;
      const l = item.low ?? item.l;
      const c = item.close ?? item.c;
      if (t !== undefined && o !== undefined && c !== undefined) {
        const timeMs = t < 1e11 ? t * 1000 : t;
        const nO = parseFloat(o);
        const nC = parseFloat(c);
        const nH = h !== undefined ? parseFloat(h) : Math.max(nO, nC);
        const nL = l !== undefined ? parseFloat(l) : Math.min(nO, nC);
        if (!isNaN(nO) && !isNaN(nC)) {
          return {
            time: Math.floor(timeMs / 60000) * 60000,
            open: nO,
            high: Math.max(nH, nO, nC),
            low: Math.min(nL, nO, nC),
            close: nC
          };
        }
      }
    }
    if (Array.isArray(item) && item.length >= 5) {
      const t = item[0];
      const timeMs = t < 1e11 ? t * 1000 : t;
      const vals = [parseFloat(item[1]), parseFloat(item[2]), parseFloat(item[3]), parseFloat(item[4])];
      if (vals.every(v => !isNaN(v) && v > 0)) {
        return {
          time: Math.floor(timeMs / 60000) * 60000,
          open: vals[0],
          high: Math.max(...vals),
          low: Math.min(...vals),
          close: parseFloat(item[4] ?? item[2])
        };
      }
    }
    return null;
  }

  function extractCandles(arr) {
    if (!Array.isArray(arr) || arr.length < 8) return null;
    const parsed = [];
    for (let i = 0; i < arr.length; i++) {
      const c = parseCandle(arr[i]);
      if (c) parsed.push(c);
      else if (parsed.length > 0 && parsed.length < 5) return null;
    }
    if (parsed.length >= 8) {
      parsed.sort((a, b) => a.time - b.time);
      return parsed;
    }
    return null;
  }

  function parseAssetString(str) {
    if (typeof str !== "string") return null;
    const m = str.match(/([A-Za-z0-9]+)[_\/]([A-Za-z0-9]+)(?:_otc|\s*\(OTC\))?/i);
    if (m && m[1].length === 3 && m[2].length === 3) {
      return `${m[1].toUpperCase()}/${m[2].toUpperCase()} (OTC)`;
    }
    if (str.toLowerCase().includes("_otc")) {
      const base = str.replace(/_otc/i, "").replace(/_/g, "/").toUpperCase();
      return `${base} (OTC)`;
    }
    return null;
  }

  function deepSearch(data, depth = 0) {
    if (!data || depth > 5) return null;
    if (Array.isArray(data)) {
      const list = extractCandles(data);
      if (list) return { candles: list, asset: null };
      for (const it of data) {
        const res = deepSearch(it, depth + 1);
        if (res) return res;
      }
    } else if (typeof data === "object") {
      let candidateAsset = null;
      for (const k of ["asset", "symbol", "pair", "instrument", "d"]) {
        if (data[k]) {
          const parsed = parseAssetString(data[k]);
          if (parsed) candidateAsset = parsed;
        }
      }

      for (const k of ["candles", "history", "data", "quotes", "bars"]) {
        if (data[k]) {
          const res = deepSearch(data[k], depth + 1);
          if (res) {
            if (candidateAsset && !res.asset) res.asset = candidateAsset;
            return res;
          }
        }
      }

      for (const k of Object.keys(data)) {
        if (typeof data[k] === "object") {
          const res = deepSearch(data[k], depth + 1);
          if (res) {
            if (candidateAsset && !res.asset) res.asset = candidateAsset;
            return res;
          }
        }
      }
    }
    return null;
  }

  function handleIncoming(raw) {
    try {
      let str = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      const b1 = str.indexOf("{");
      const b2 = str.indexOf("[");
      let start = -1;
      if (b1 !== -1 && b2 !== -1) start = Math.min(b1, b2);
      else if (b1 !== -1) start = b1;
      else if (b2 !== -1) start = b2;
      if (start === -1) return;

      const parsed = JSON.parse(str.substring(start));
      const res = deepSearch(parsed);
      if (res && res.candles && res.candles.length >= 8) {
        window.postMessage({
          type: "QX_HISTORICAL_CANDLES",
          payload: { candles: res.candles, asset: res.asset }
        }, "*");
      }
    } catch (_) {}
  }

  const OrigWS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new OrigWS(...args);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") handleIncoming(ev.data);
      else if (ev.data instanceof Blob) ev.data.text().then(t => handleIncoming(t));
      else if (ev.data instanceof ArrayBuffer) handleIncoming(ev.data);
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
})();