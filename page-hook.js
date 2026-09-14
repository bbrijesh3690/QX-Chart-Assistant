(function () {
  if (window.__QX_HOOK_ATTACHED__) return;
  window.__QX_HOOK_ATTACHED__ = true;

  const OriginalWebSocket = window.WebSocket;

  function parseQuotexCandles(rawList) {
    if (!Array.isArray(rawList) || rawList.length === 0) return null;

    const parsed = [];
    for (const item of rawList) {
      if (!item) continue;

      let time = 0, open = 0, close = 0, high = 0, low = 0;

      if (Array.isArray(item) && item.length >= 5) {
        // Quotex WebSocket History Array: [time, open, close, high, low]
        time = item[0] < 1e11 ? item[0] * 1000 : item[0];
        open = Number(item[1]);
        close = Number(item[2]); // Index 2 is Close
        high = Number(item[3]);  // Index 3 is High
        low = Number(item[4]);   // Index 4 is Low
      } else if (typeof item === "object") {
        const rawTime = item.time || item.t || item.timestamp;
        time = rawTime < 1e11 ? rawTime * 1000 : rawTime;
        open = Number(item.open ?? item.o);
        close = Number(item.close ?? item.c);
        high = Number(item.high ?? item.h ?? Math.max(open, close));
        low = Number(item.low ?? item.l ?? Math.min(open, close));
      }

      if (!time || isNaN(open) || isNaN(close)) continue;

      const trueHigh = Math.max(open, close, isNaN(high) ? open : high);
      const trueLow = Math.min(open, close, isNaN(low) ? open : low);
      const minFloor = Math.floor(time / 60000) * 60000;

      parsed.push({
        time: minFloor,
        open: open,
        high: trueHigh,
        low: trueLow,
        close: close
      });
    }

    if (parsed.length === 0) return null;

    parsed.sort((a, b) => a.time - b.time);
    const dedupe = [];
    for (let i = 0; i < parsed.length; i++) {
      if (i === 0 || parsed[i].time !== parsed[i - 1].time) {
        dedupe.push(parsed[i]);
      }
    }
    return dedupe;
  }

  window.WebSocket = function (...args) {
    const ws = new OriginalWebSocket(...args);

    ws.addEventListener("message", (e) => {
      try {
        const msg = e.data;
        if (typeof msg !== "string") return;

        // 1. Intercept Live Fast Price Ticks
        if (msg.startsWith('42["tick"') || msg.includes('"price"') || msg.includes('"rate"')) {
          const match = msg.match(/"price":\s*([0-9.]+)/) || msg.match(/"rate":\s*([0-9.]+)/);
          if (match) {
            const rawText = match[1];
            const price = parseFloat(rawText);
            const decimals = rawText.includes(".") ? rawText.split(".")[1].length : 3;
            window.postMessage({
              type: "QX_FAST_PRICE_TICK",
              payload: { price, rawText, decimals, timestamp: Date.now() }
            }, "*");
          }
        }

        // 2. Intercept Historical Candle Batches (Initial load + Drag/Scroll backfill)
        if (msg.includes("history") || msg.includes("candles") || (msg.startsWith("42[") && msg.includes("[["))) {
          const jsonStr = msg.replace(/^[0-9]+/, "");
          const data = JSON.parse(jsonStr);

          let candlePayload = null;
          if (Array.isArray(data)) {
            candlePayload = data[1]?.data || data[1]?.candles || data[1];
          } else if (typeof data === "object") {
            candlePayload = data.data || data.candles || data.history;
          }

          if (Array.isArray(candlePayload) && candlePayload.length >= 5) {
            const cleanCandles = parseQuotexCandles(candlePayload);
            if (cleanCandles && cleanCandles.length > 0) {
              const sample = cleanCandles[cleanCandles.length - 1].close;
              window.postMessage({
                type: "QX_HISTORICAL_CANDLES",
                payload: { candles: cleanCandles, samplePrice: sample }
              }, "*");
            }
          }
        }
      } catch (_) {}
    });

    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
})();