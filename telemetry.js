/* ==============================================================
   QX Chart Assistant — SIGNAL TELEMETRY LAYER (v1.4.44)
   ==============================================================
   Append-only IndexedDB store holding one record per minute-level
   signal evaluation, INCLUDING neutrals and flip-gate rejects.

   Purpose: make the confluence measurable. Nothing here feeds the
   live signal — it only observes it.

   Local only. Nothing is transmitted anywhere, ever.

   Console access:
     __QX_TELEMETRY__.count().then(console.log)
     __QX_TELEMETRY__.exportCsv()
     __QX_TELEMETRY__.wipe("YES")      // destructive, guarded
   ============================================================== */
(function () {
  if (window.__QX_TELEMETRY__) return;

  const DB_NAME = "QX_TELEMETRY";
  const DB_VERSION = 1;
  const STORE = "evaluations";

  // Stable CSV column order. Append new columns at the END only, so
  // older exports stay column-compatible with newer ones.
  const COLUMNS = [
    // --- identity -------------------------------------------------
    "id", "asset", "isOtc", "decimals", "schema",
    // --- timing ---------------------------------------------------
    "evalTs", "evalMinute", "tradeMinute",
    "localHour", "localMinute", "minuteOfDay", "dayOfWeek", "utcHour",
    // --- the verdict (exactly what the live panel decided) --------
    "lockPrice", "dir", "tier", "setup", "score", "rawCall", "rawPut",
    // --- confluence components, as used live ----------------------
    "trend15", "trend5", "rsi",
    "srS", "srR", "srRange", "distSupPrice", "distResPrice",
    // --- SHADOW features: computed, never used by the live signal -
    //     these exist to settle open questions with data
    "trend15Closed", "trend5Closed", "rsiClosed",
    "distSupWick", "distResWick",
    "m15BlockPos", "m15BarsClosed",
    // --- volatility / regime --------------------------------------
    "atr14", "atrPct", "stdev20", "stdev20Pct",
    // --- data sufficiency & integrity -----------------------------
    "count1m", "count5m", "count15m", "gapCount20", "staleMs",
    // --- microstructure (from the 60fps canvas tick stream) -------
    "tick5s", "tick10s", "tick60s",
    "tickUp10s", "tickDown10s", "tickImb10s",
    "range5s", "range60s", "range5sPct",
    // --- what happened --------------------------------------------
    "flipped", "executed", "settled",
    "entryTick", "entryOpen", "exitClose", "nextHigh", "nextLow", "nextDir",
    "resolvedTs"
  ];

  const SCHEMA_VERSION = 1;

  let dbPromise = null;
  let cachedCount = 0;
  let lastCountAt = 0;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("tradeMinute", "tradeMinute", { unique: false });
          os.createIndex("asset", "asset", { unique: false });
          os.createIndex("settled", "settled", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDb().then(db => db.transaction(STORE, mode).objectStore(STORE));
  }

  function asPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* --------------------------------------------------------------
     record(row)
     Writes one evaluation. Uses `add` semantics via get-then-put so
     a second tab watching the same asset cannot clobber a row that
     already carries settlement data.
     -------------------------------------------------------------- */
  function record(row) {
    if (!row || !row.id) return Promise.resolve(false);
    row.schema = SCHEMA_VERSION;
    row.settled = 0;
    return tx("readwrite").then(store => {
      return asPromise(store.get(row.id)).then(existing => {
        if (existing && existing.settled === 1) return false;
        if (existing) {
          // keep any settlement-side fields already present
          row.entryTick = existing.entryTick !== undefined ? existing.entryTick : row.entryTick;
          row.flipped = existing.flipped || row.flipped;
        }
        return asPromise(store.put(row)).then(() => {
          cachedCount++;
          return true;
        });
      });
    }).catch(() => false);
  }

  /* --------------------------------------------------------------
     patch(id, fields)
     Shallow-merge onto an existing row. Silent no-op if absent.
     -------------------------------------------------------------- */
  function patch(id, fields) {
    if (!id) return Promise.resolve(false);
    return tx("readwrite").then(store => {
      return asPromise(store.get(id)).then(row => {
        if (!row) return false;
        Object.assign(row, fields);
        return asPromise(store.put(row)).then(() => true);
      });
    }).catch(() => false);
  }

  /* --------------------------------------------------------------
     settle(asset, tradeMinute, candle)
     Records the realised next-candle OHLC. Deliberately stores the
     raw bar rather than a WIN/LOSS verdict, so outcomes for any
     hypothetical direction or entry convention stay derivable later.
     -------------------------------------------------------------- */
  function settle(asset, tradeMinute, candle) {
    if (!asset || !tradeMinute || !candle) return Promise.resolve(false);
    const id = `${asset}_${tradeMinute}`;
    return patch(id, {
      settled: 1,
      entryOpen: candle.open,
      exitClose: candle.close,
      nextHigh: candle.high,
      nextLow: candle.low,
      nextDir: candle.close > candle.open ? "UP" : (candle.close < candle.open ? "DOWN" : "FLAT"),
      resolvedTs: Date.now()
    });
  }

  function setEntryTick(asset, tradeMinute, price, executed) {
    if (!asset || !tradeMinute) return Promise.resolve(false);
    return patch(`${asset}_${tradeMinute}`, {
      entryTick: price,
      executed: executed ? 1 : 0
    });
  }

  function markFlipped(asset, tradeMinute) {
    if (!asset || !tradeMinute) return Promise.resolve(false);
    return patch(`${asset}_${tradeMinute}`, { flipped: 1, executed: 0 });
  }

  function count() {
    return tx("readonly")
      .then(store => asPromise(store.count()))
      .then(n => { cachedCount = n; lastCountAt = Date.now(); return n; })
      .catch(() => cachedCount);
  }

  function countSettled() {
    return tx("readonly").then(store => {
      const idx = store.index("settled");
      return asPromise(idx.count(IDBKeyRange.only(1)));
    }).catch(() => 0);
  }

  function all() {
    return tx("readonly").then(store => asPromise(store.getAll())).catch(() => []);
  }

  /* --------------------------------------------------------------
     CSV export
     -------------------------------------------------------------- */
  function csvCell(v) {
    if (v === undefined || v === null) return "";
    const s = String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(rows) {
    const lines = [COLUMNS.join(",")];
    rows.forEach(r => {
      lines.push(COLUMNS.map(c => csvCell(r[c])).join(","));
    });
    return lines.join("\r\n");
  }

  function exportCsv() {
    return all().then(rows => {
      rows.sort((a, b) => (a.tradeMinute || 0) - (b.tradeMinute || 0));
      const csv = toCsv(rows);
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = `qx_telemetry_${stamp}_${rows.length}rows.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1500);
      return rows.length;
    });
  }

  /* --------------------------------------------------------------
     wipe — deliberately awkward. Telemetry is append-only by design;
     the whole point is that history accumulates across sessions.
     -------------------------------------------------------------- */
  function wipe(confirmToken) {
    if (confirmToken !== "YES") {
      console.warn("[QX] wipe() refused. Call __QX_TELEMETRY__.wipe(\"YES\") if you really mean it.");
      return Promise.resolve(false);
    }
    return tx("readwrite")
      .then(store => asPromise(store.clear()))
      .then(() => { cachedCount = 0; return true; })
      .catch(() => false);
  }

  window.__QX_TELEMETRY__ = {
    COLUMNS,
    SCHEMA_VERSION,
    record,
    patch,
    settle,
    setEntryTick,
    markFlipped,
    count,
    countSettled,
    all,
    toCsv,
    exportCsv,
    wipe,
    cached: () => cachedCount
  };

  // warm the connection and prime the count
  count().catch(() => {});
})();
