(function () {
  if (window.__QX_PAGE_HOOK__) return;
  window.__QX_PAGE_HOOK__ = true;

  // ==========================================
  // 1. UNIVERSAL HISTORICAL CANDLE INGESTION
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

  function searchForCandles(data, depth = 0) {
    if (!data || depth > 5) return null;
    if (Array.isArray(data)) {
      const direct = extractCandleList(data);
      if (direct) return direct;
      for (const item of data) {
        const nested = searchForCandles(item, depth + 1);
        if (nested) return nested;
      }
    } else if (typeof data === "object") {
      for (const k of ["candles", "history", "data", "quotes", "bars"]) {
        if (data[k]) {
          const res = searchForCandles(data[k], depth + 1);
          if (res) return res;
        }
      }
      for (const k of Object.keys(data)) {
        if (typeof data[k] === "object") {
          const res = searchForCandles(data[k], depth + 1);
          if (res) return res;
        }
      }
    }
    return null;
  }

  function inspectNetworkPayload(raw) {
    if (!raw) return;
    try {
      let text = raw;
      if (typeof raw !== "string") {
        text = new TextDecoder().decode(raw);
      }
      const braceIdx = text.indexOf("{");
      const bracketIdx = text.indexOf("[");
      let start = -1;
      if (braceIdx !== -1 && bracketIdx !== -1) start = Math.min(braceIdx, bracketIdx);
      else if (braceIdx !== -1) start = braceIdx;
      else if (bracketIdx !== -1) start = bracketIdx;

      if (start === -1) return;
      const jsonStr = text.substring(start);
      const parsed = JSON.parse(jsonStr);
      const candles = searchForCandles(parsed);
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
        inspectNetworkPayload(ev.data);
      } else if (ev.data instanceof Blob) {
        ev.data.text().then(txt => inspectNetworkPayload(txt));
      } else if (ev.data instanceof ArrayBuffer) {
        inspectNetworkPayload(ev.data);
      }
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;

  // ==========================================
  // 2. WEBGL TEXTURE PRICE HOOK
  // ==========================================
  let candidateTextures = new Map();
  let activeTextureId = null;
  let textureCounter = 0;
  const textureIdMap = new WeakMap();

  function getTextureId(texture) {
    if (!textureIdMap.has(texture)) {
      textureCounter++;
      const id = "T" + textureCounter;
      textureIdMap.set(texture, id);
      return id;
    }
    return textureIdMap.get(texture);
  }

  const origFillText = CanvasRenderingContext2D.prototype.fillText;
  const canvasLastDrawn = new WeakMap();

  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    if (typeof text === "string") {
      const clean = text.trim();
      if (/^\d{1,6}\.\d{2,6}$/.test(clean)) {
        const num = parseFloat(clean);
        if (!isNaN(num) && num > 0) {
          canvasLastDrawn.set(this.canvas, { raw: clean, value: num, time: Date.now() });
        }
      }
    }
    return origFillText.apply(this, arguments);
  };

  function handleTex(gl, texture, source) {
    if (!texture || !source || !(source instanceof HTMLCanvasElement)) return;
    const rec = canvasLastDrawn.get(source);
    if (!rec) return;

    const id = getTextureId(texture);
    let cand = candidateTextures.get(id);
    if (!cand) {
      cand = { id: id, raw: rec.raw, value: rec.value, changes: 0, time: rec.time };
      candidateTextures.set(id, cand);
    } else {
      if (cand.raw !== rec.raw) {
        cand.changes++;
        cand.raw = rec.raw;
        cand.value = rec.value;
      }
      cand.time = rec.time;
    }

    if (!activeTextureId && cand.changes >= 2) {
      activeTextureId = id;
    } else if (activeTextureId && cand.changes > (candidateTextures.get(activeTextureId)?.changes || 0) + 8) {
      activeTextureId = id;
    }

    if (activeTextureId === id) {
      window.postMessage({
        type: "QX_PRICE_TICK",
        payload: { price: cand.value, raw: cand.raw, id: id, timestamp: cand.time }
      }, "*");
    }
  }

  const protos = [
    window.WebGLRenderingContext ? window.WebGLRenderingContext.prototype : null,
    window.WebGL2RenderingContext ? window.WebGL2RenderingContext.prototype : null
  ].filter(Boolean);

  protos.forEach(p => {
    const origTex = p.texImage2D;
    const origSub = p.texSubImage2D;
    p.texImage2D = function () {
      try {
        const target = arguments[0];
        const tex = this.getParameter(target === this.TEXTURE_2D ? this.TEXTURE_BINDING_2D : this.TEXTURE_BINDING_CUBE_MAP);
        const src = arguments.length >= 6 ? arguments[arguments.length - 1] : arguments[5];
        handleTex(this, tex, src);
      } catch (_) {}
      return origTex.apply(this, arguments);
    };
    p.texSubImage2D = function () {
      try {
        const target = arguments[0];
        const tex = this.getParameter(target === this.TEXTURE_2D ? this.TEXTURE_BINDING_2D : this.TEXTURE_BINDING_CUBE_MAP);
        const src = arguments[arguments.length - 1];
        handleTex(this, tex, src);
      } catch (_) {}
      return origSub.apply(this, arguments);
    };
  });

  window.addEventListener("message", (e) => {
    if (e.data?.type === "QX_RESET_LOCK") {
      candidateTextures.clear();
      activeTextureId = null;
      textureCounter = 0;
    }
  });
})();