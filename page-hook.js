(function () {
  if (window.__QX_PAGE_HOOK__) return;
  window.__QX_PAGE_HOOK__ = true;

  const historyRing = [];
  let lastPrice = null;
  let lastTime = 0;

  // 1. FAST 60FPS CANVAS PRICE EMITTER
  const origFill = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxW) {
    if (typeof text === "string") {
      const clean = text.trim();
      if (/^\d{1,7}\.\d{1,6}$/.test(clean) && !clean.includes(":") && !clean.includes("%")) {
        const val = parseFloat(clean);
        if (!isNaN(val) && val > 0) {
          const now = Date.now();
          if (val !== lastPrice || (now - lastTime > 200)) {
            lastPrice = val;
            lastTime = now;
            const decimals = clean.includes(".") ? clean.split(".")[1].length : 2;
            window.postMessage({
              type: "QX_FAST_PRICE_TICK",
              payload: { price: val, rawText: clean, decimals: decimals, timestamp: now }
            }, "*");
          }
        }
      }
    }
    return origFill.apply(this, arguments);
  };

  // 2. WEBSOCKET CANDLE PARSER
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
      const o = parseFloat(item[1]);
      const c = parseFloat(item[2]); // Quotex native index 2 is Close
      const h = parseFloat(item[3]);
      const l = parseFloat(item[4]);
      const allVals = [o, c, h, l].filter(v => !isNaN(v) && v > 0);
      if (!isNaN(o) && !isNaN(c)) {
        return {
          time: Math.floor(timeMs / 60000) * 60000,
          open: o,
          high: Math.max(...allVals, o, c),
          low: Math.min(...allVals, o, c),
          close: c
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
      for (const k of ["candles", "history", "data", "quotes", "bars"]) {
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

  // Every string/number in the frame that is NOT candle data. The
  // symbol this history belongs to is in here; throwing the whole
  // envelope away (as this did until v1.4.53) forced the ISOLATED side
  // to guess the owner by price proximity, which silently filed one
  // pair's history under another whenever two pairs traded at similar
  // levels — AUD/JPY and CAD/JPY are 0.5% apart.
  function collectTokens(data, out, depth) {
    depth = depth || 0;
    if (!data || depth > 6 || out.length > 40) return out;
    if (Array.isArray(data)) {
      // skip OHLC payloads; a candle row is a numeric tuple or an
      // object carrying close/c
      if (data.length >= 8) return out;
      for (const v of data) collectTokens(v, out, depth + 1);
      return out;
    }
    if (typeof data === "object") {
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (typeof v === "string" && v.length > 1 && v.length <= 40) out.push(v);
        else if (typeof v === "number" && Number.isFinite(v)) {
          // ids are small integers; prices and epochs are not useful here
          if (Number.isInteger(v) && v > 0 && v < 100000) out.push(k + "=" + v);
        } else if (typeof v === "object") collectTokens(v, out, depth + 1);
      }
    }
    return out;
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
        const samplePrice = candles[candles.length - 1].close;
        const tokens = collectTokens(parsed, []);
        // the socket frame is often prefixed with an event name such as
        // 42["history/list",{...}] — keep it, it can carry the symbol
        const prefix = str.substring(0, Math.min(start, 48));
        const pkt = {
          candles: candles,
          samplePrice: samplePrice,
          time: Date.now(),
          tokens: tokens,
          prefix: prefix
        };

        historyRing.unshift(pkt);
        if (historyRing.length > 35) historyRing.pop();

        // exposed read-only so attribution problems can be diagnosed
        // without re-instrumenting the socket
        window.__QX_LAST_HISTORY_META__ = { tokens: tokens, prefix: prefix, bars: candles.length };

        window.postMessage({ type: "QX_HISTORICAL_CANDLES", payload: pkt }, "*");
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

  window.addEventListener("message", (e) => {
    if (e.data?.type === "QX_REQ_REPLAY") {
      historyRing.forEach(p => {
        window.postMessage({ type: "QX_HISTORICAL_CANDLES", payload: p }, "*");
      });
    }
  });
})();