(function () {
  if (window.__QX_PAGE_HOOK__) return;
  window.__QX_PAGE_HOOK__ = true;

  // ==============================
  // 1. WEBSOCKET CANDLE LISTENER
  // ==============================
  function parseCandleItem(item) {
    if (!item) return null;
    if (typeof item === "object" && !Array.isArray(item)) {
      const t = item.time ?? item.timestamp ?? item.t;
      const o = item.open ?? item.o;
      const h = item.high ?? item.h;
      const l = item.low ?? item.l;
      const c = item.close ?? item.c;
      if (t !== undefined && o !== undefined && c !== undefined) {
        const timeMs = t < 1e11 ? t * 1000 : t;
        const numO = parseFloat(o);
        const numC = parseFloat(c);
        const numH = h !== undefined ? parseFloat(h) : Math.max(numO, numC);
        const numL = l !== undefined ? parseFloat(l) : Math.min(numO, numC);
        if (!isNaN(numO) && !isNaN(numC)) {
          return {
            time: Math.floor(timeMs / 60000) * 60000,
            open: numO,
            high: Math.max(numH, numO, numC),
            low: Math.min(numL, numO, numC),
            close: numC
          };
        }
      }
    }
    return null;
  }

  function extractCandleList(arr) {
    if (!Array.isArray(arr) || arr.length < 10) return null;
    const parsed = [];
    for (let i = 0; i < arr.length; i++) {
      const c = parseCandleItem(arr[i]);
      if (c) parsed.push(c);
      else if (parsed.length > 0 && parsed.length < 5) return null;
    }
    if (parsed.length >= 10) {
      parsed.sort((a, b) => a.time - b.time);
      return parsed;
    }
    return null;
  }

  function inspectNetworkData(data) {
    try {
      let parsed = data;
      if (typeof data === "string") {
        if (data.startsWith("42")) data = data.substring(2);
        parsed = JSON.parse(data);
      }
      if (Array.isArray(parsed)) {
        const candles = extractCandleList(parsed);
        if (candles) {
          window.postMessage({ type: "QX_HISTORICAL_CANDLES", payload: candles }, "*");
          return;
        }
      } else if (parsed && typeof parsed === "object") {
        for (const k of ["candles", "history", "data", "quotes"]) {
          if (Array.isArray(parsed[k])) {
            const candles = extractCandleList(parsed[k]);
            if (candles) {
              window.postMessage({ type: "QX_HISTORICAL_CANDLES", payload: candles }, "*");
              return;
            }
          }
        }
      }
    } catch (_) {}
  }

  const OrigWS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new OrigWS(...args);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        inspectNetworkData(ev.data);
      } else if (ev.data instanceof Blob) {
        ev.data.text().then(txt => inspectNetworkData(txt));
      }
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;

  // ==============================
  // 2. WEBGL TEXTURE PRICE STREAM
  // ==============================
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