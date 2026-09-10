(function () {
  if (window.__QX_PAGE_HOOK__) return;
  window.__QX_PAGE_HOOK__ = true;

  // ==========================================
  // 1. INSTANT PRICE EMITTER (DIRECT CANVAS 60 FPS)
  // ==========================================
  let lastSentPrice = null;
  let lastSentTime = 0;
  const origFillText = CanvasRenderingContext2D.prototype.fillText;

  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    if (typeof text === "string") {
      const clean = text.trim();
      // Match price formats: e.g., 126.340, 0.19599, 1.08542
      if (/^\d{1,6}\.\d{2,6}$/.test(clean)) {
        const val = parseFloat(clean);
        if (!isNaN(val) && val > 0) {
          const now = Date.now();
          // Emit immediately on any price change, or heart-beat every 200ms
          if (val !== lastSentPrice || (now - lastSentTime > 200)) {
            lastSentPrice = val;
            lastSentTime = now;
            window.postMessage({
              type: "QX_FAST_PRICE_TICK",
              payload: { price: val, raw: clean, timestamp: now }
            }, "*");
          }
        }
      }
    }
    return origFillText.apply(this, arguments);
  };

  // ==========================================
  // 2. WEBSOCKET CANDLE & SUBSCRIBER INTERCEPTOR
  // ==========================================
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

  function extractCandleList(arr) {
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

  function deepSearchCandles(data, depth = 0) {
    if (!data || depth > 5) return null;
    if (Array.isArray(data)) {
      const list = extractCandleList(data);
      if (list) return list;
      for (const item of data) {
        const nested = deepSearchCandles(item, depth + 1);
        if (nested) return nested;
      }
    } else if (typeof data === "object") {
      for (const k of ["candles", "history", "data", "quotes", "bars"]) {
        if (data[k]) {
          const list = deepSearchCandles(data[k], depth + 1);
          if (list) return list;
        }
      }
      for (const k of Object.keys(data)) {
        if (typeof data[k] === "object") {
          const list = deepSearchCandles(data[k], depth + 1);
          if (list) return list;
        }
      }
    }
    return null;
  }

  function processPayload(raw) {
    try {
      let str = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      // Strip Socket.IO / Engine.IO headers: e.g., 42["event", ...], 451-[...]
      const brace = str.indexOf("{");
      const bracket = str.indexOf("[");
      let start = -1;
      if (brace !== -1 && bracket !== -1) start = Math.min(brace, bracket);
      else if (brace !== -1) start = brace;
      else if (bracket !== -1) start = bracket;
      if (start === -1) return;

      const parsed = JSON.parse(str.substring(start));
      const candles = deepSearchCandles(parsed);
      if (candles && candles.length >= 8) {
        window.postMessage({ type: "QX_HISTORICAL_CANDLES", payload: candles }, "*");
      }
    } catch (_) {}
  }

  const OrigWS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new OrigWS(...args);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        processPayload(ev.data);
      } else if (ev.data instanceof Blob) {
        ev.data.text().then(t => processPayload(t));
      } else if (ev.data instanceof ArrayBuffer) {
        processPayload(ev.data);
      }
    });

    // Detect asset switches directly from outgoing WebSocket subscriptions
    const origSend = ws.send;
    ws.send = function (data) {
      if (typeof data === "string") {
        const match = data.match(/["']([A-Z0-9\/\s_]+(?:_otc|OTC)?)["']/i);
        if (match && match[1].length >= 3 && !match[1].includes("subscribe") && !match[1].includes("auth")) {
          const clean = match[1].replace("_otc", " (OTC)").replace("_", "/").trim();
          window.postMessage({ type: "QX_WS_ASSET_DETECTED", payload: clean }, "*");
        }
      }
      return origSend.apply(this, arguments);
    };

    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
})();