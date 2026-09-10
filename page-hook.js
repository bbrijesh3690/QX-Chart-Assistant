/**
 * QX Chart Assistant - Page Context Hook (v1.2.6-analysis)
 * Eavesdrops on WebSocket historical candles & manages WebGL price texture stream.
 */

(function () {
  if (window.__QX_PAGE_HOOK_INSTALLED__) return;
  window.__QX_PAGE_HOOK_INSTALLED__ = true;

  // ==========================================
  // 1. WEBSOCKET EAVESDROPPER (HISTORICAL CANDLES)
  // ==========================================

  function parseCandleItem(item) {
    if (!item) return null;
    if (typeof item === 'object' && !Array.isArray(item)) {
      const t = item.time || item.timestamp || item.t;
      const o = item.open !== undefined ? item.open : item.o;
      const h = item.high !== undefined ? item.high : item.h;
      const l = item.low !== undefined ? item.low : item.l;
      const c = item.close !== undefined ? item.close : item.c;
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
          close: parseFloat(item[4] || item[2])
        };
      }
    }
    return null;
  }

  function extractCandleList(arr) {
    if (!Array.isArray(arr) || arr.length < 15) return null;
    const parsed = [];
    for (let i = 0; i < arr.length; i++) {
      const c = parseCandleItem(arr[i]);
      if (c) parsed.push(c);
      else if (parsed.length > 0 && parsed.length < 10) return null;
    }
    if (parsed.length >= 15) {
      parsed.sort((a, b) => a.time - b.time);
      return parsed;
    }
    return null;
  }

  function searchForCandles(data, depth = 0) {
    if (!data || depth > 4) return null;
    if (Array.isArray(data)) {
      const direct = extractCandleList(data);
      if (direct) return direct;
      for (const item of data) {
        const nested = searchForCandles(item, depth + 1);
        if (nested) return nested;
      }
    } else if (typeof data === 'object') {
      const priorityKeys = ['candles', 'history', 'data', 'quotes', 'history_line'];
      for (const k of priorityKeys) {
        if (data[k]) {
          const res = searchForCandles(data[k], depth + 1);
          if (res) return res;
        }
      }
      for (const k of Object.keys(data)) {
        if (typeof data[k] === 'object') {
          const res = searchForCandles(data[k], depth + 1);
          if (res) return res;
        }
      }
    }
    return null;
  }

  function processIncomingMessage(raw) {
    if (typeof raw !== 'string') return;
    let jsonStr = raw;
    if (raw.startsWith('42')) {
      jsonStr = raw.substring(2);
    }
    try {
      const parsed = JSON.parse(jsonStr);
      const candles = searchForCandles(parsed);
      if (candles && candles.length >= 15) {
        window.postMessage({
          type: 'QX_HISTORICAL_CANDLES',
          payload: { candles: candles }
        }, '*');
      }
    } catch (_) {}
  }

  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new OriginalWebSocket(...args);
    ws.addEventListener('message', (ev) => {
      try { processIncomingMessage(ev.data); } catch (_) {}
    });
    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;

  // ==========================================
  // 2. WEBGL TEXTURE ENGINE (LIVE PRICE STREAM)
  // ==========================================

  let candidateTextures = new Map();
  let activeTextureId = null;
  let manualLock = false;
  let textureCounter = 0;
  const textureIdMap = new WeakMap();

  function getTextureId(texture) {
    if (!textureIdMap.has(texture)) {
      textureCounter++;
      const id = 'T' + textureCounter;
      textureIdMap.set(texture, id);
      return id;
    }
    return textureIdMap.get(texture);
  }

  const originalFillText = CanvasRenderingContext2D.prototype.fillText;
  const originalStrokeText = CanvasRenderingContext2D.prototype.strokeText;
  const canvasLastDrawnPrice = new WeakMap();

  function scanDrawnText(ctx, text) {
    if (typeof text !== 'string') return;
    const clean = text.trim();
    if (/^\d{1,6}\.\d{2,6}$/.test(clean)) {
      const num = parseFloat(clean);
      if (!isNaN(num) && num > 0) {
        canvasLastDrawnPrice.set(ctx.canvas, {
          raw: clean,
          value: num,
          timestamp: Date.now()
        });
      }
    }
  }

  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    scanDrawnText(this, text);
    return originalFillText.apply(this, arguments);
  };

  CanvasRenderingContext2D.prototype.strokeText = function (text, x, y, maxWidth) {
    scanDrawnText(this, text);
    return originalStrokeText.apply(this, arguments);
  };

  function handleTexUpload(gl, texture, source) {
    if (!texture || !source) return;
    const texUid = getTextureId(texture);
    let priceRecord = null;

    if (source instanceof HTMLCanvasElement && canvasLastDrawnPrice.has(source)) {
      priceRecord = canvasLastDrawnPrice.get(source);
    }

    if (priceRecord) {
      let candidate = candidateTextures.get(texUid);
      if (!candidate) {
        candidate = {
          id: texUid,
          raw: priceRecord.raw,
          value: priceRecord.value,
          changes: 0,
          lastSeen: priceRecord.timestamp
        };
        candidateTextures.set(texUid, candidate);
      } else {
        if (candidate.raw !== priceRecord.raw) {
          candidate.changes++;
          candidate.raw = priceRecord.raw;
          candidate.value = priceRecord.value;
        }
        candidate.lastSeen = priceRecord.timestamp;
      }

      // Auto-lock onto active price texture
      if (!manualLock) {
        if (!activeTextureId && candidate.changes >= 2) {
          activeTextureId = texUid;
        } else if (activeTextureId && candidate.changes > (candidateTextures.get(activeTextureId)?.changes || 0) + 8) {
          activeTextureId = texUid;
        }
      }

      if (activeTextureId === texUid) {
        window.postMessage({
          type: 'QX_PRICE_UPDATE',
          payload: {
            price: candidate.value,
            rawText: candidate.raw,
            textureId: texUid,
            timestamp: candidate.lastSeen
          }
        }, '*');
      }
    }
  }

  const glPrototypes = [
    window.WebGLRenderingContext ? window.WebGLRenderingContext.prototype : null,
    window.WebGL2RenderingContext ? window.WebGL2RenderingContext.prototype : null
  ].filter(Boolean);

  glPrototypes.forEach(proto => {
    const origTexImage2D = proto.texImage2D;
    const origTexSubImage2D = proto.texSubImage2D;

    proto.texImage2D = function () {
      try {
        const target = arguments[0];
        const texture = this.getParameter(target === this.TEXTURE_2D ? this.TEXTURE_BINDING_2D : this.TEXTURE_BINDING_CUBE_MAP);
        const source = arguments.length >= 6 ? arguments[arguments.length - 1] : arguments[5];
        handleTexUpload(this, texture, source);
      } catch (_) {}
      return origTexImage2D.apply(this, arguments);
    };

    proto.texSubImage2D = function () {
      try {
        const target = arguments[0];
        const texture = this.getParameter(target === this.TEXTURE_2D ? this.TEXTURE_BINDING_2D : this.TEXTURE_BINDING_CUBE_MAP);
        const source = arguments[arguments.length - 1];
        handleTexUpload(this, texture, source);
      } catch (_) {}
      return origTexSubImage2D.apply(this, arguments);
    };
  });

  setInterval(() => {
    if (candidateTextures.size === 0) return;
    const now = Date.now();
    const list = [];
    for (const [id, c] of candidateTextures.entries()) {
      if (now - c.lastSeen < 15000) {
        list.push({
          id: c.id,
          raw: c.raw,
          value: c.value,
          changes: c.changes,
          active: c.id === activeTextureId
        });
      }
    }
    list.sort((a, b) => b.changes - a.changes);
    window.postMessage({
      type: 'QX_CANDIDATES_UPDATE',
      payload: list
    }, '*');
  }, 500);

  window.addEventListener('message', (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    const { type, payload } = ev.data;

    if (type === 'QX_CMD_SELECT_TEXTURE') {
      activeTextureId = payload.textureId;
      manualLock = true;
    } else if (type === 'QX_CMD_RESET_ASSET_LOCK') {
      candidateTextures.clear();
      activeTextureId = null;
      manualLock = false;
      textureCounter = 0;
    }
  });

})();
