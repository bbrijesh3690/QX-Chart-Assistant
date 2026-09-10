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

  // 2. WEBSOCKET CANDLE INGESTION & OUTGOING PAIR DETECTOR
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

  function deepSearch(data, depth = 0) {
    if (!data || depth > 5) return null;
    if (Array.isArray(data)) {
      const list = extractCandles(data);
      if (list) return list;
      for (const it of data) {
        const res = deepSearch(it, depth + 1);
        if (res) return res;
      }
    } else if (typeof data === "object") {
      for (const k of ["candles", "history", "data", "quotes"]) {
        if (data[k]) {
          const res = deepSearch(data[k], depth + 1);
          if (res) return res;
        }
      }
      for (const k of Object.keys(data)) {
        if (typeof data[k] === "object") {
          const res = deepSearch(data[k], depth + 1);
          if (res) return res;
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
      const candles = deepSearch(parsed);
      if (candles && candles.length >= 8) {
        window.postMessage({ type: "QX_HISTORICAL_CANDLES", payload: candles }, "*");
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

    // Strictly match currency pairs like USD_DZD_otc or NZD_JPY_otc on outgoing subscribe frames
    const origSend = ws.send;
    ws.send = function (data) {
      if (typeof data === "string") {
        const pairMatch = data.match(/\b([A-Z]{3})_([A-Z]{3})(_otc)?\b/i);
        if (pairMatch) {
          const formatted = `${pairMatch[1].toUpperCase()}/${pairMatch[2].toUpperCase()} (OTC)`;
          window.postMessage({ type: "QX_WS_ASSET_DETECTED", payload: formatted }, "*");
        }
      }
      return origSend.apply(this, arguments);
    };

    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
})();