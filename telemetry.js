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
    "resolvedTs",
    // --- v1.4.50: appended, never reordered -----------------------
    //     payout is the broker's advertised return at the moment of
    //     the lock, scraped from the asset tab (0.92 = 92%). It moves
    //     during the day and differs per asset, so a single global
    //     break-even is wrong. Break-even win rate is 1/(1+payout):
    //     0.92 -> 52.1%, 0.77 -> 56.5%. A 53% hit rate is profitable
    //     on one asset and loss-making on another, which is why this
    //     has to be stored per row rather than assumed.
    "payout", "breakEven",
    // --- v1.4.51: appended, never reordered -----------------------
    //     source is "live" for rows captured at a real :55 lock and
    //     "harvest" for rows replayed out of loaded history. NEVER
    //     pool them: harvested rows have no tick microstructure, no
    //     flip-gate behaviour and no payout, and they score a fully
    //     closed bar where live scores a partial one. Always filter.
    //
    //     matchDist is how far off the price-proximity match was when
    //     that asset's history was attributed to it (0.17 = 17%).
    //     ingestHistory accepts anything within 25%, which is wide
    //     enough to file GBP/USD history under EUR/USD, so this is
    //     what makes a bad attribution filterable after the fact.
    "source", "matchDist",
    // --- v1.4.53: appended, never reordered -----------------------
    //     How this asset's history was attributed:
    //       "symbol" - the frame named the pair. Trustworthy.
    //       "price"  - inferred from price proximity, unambiguously.
    //       undefined on rows captured before v1.4.53, which were
    //                  attributed by a 25% price band wide enough to
    //                  file one pair's history under another. Those
    //                  rows are NOT trustworthy; filter them out.
    "matchMode"
  ];

  const SCHEMA_VERSION = 4;

  let dbPromise = null;
  let cachedCount = 0;
  let lastCountAt = 0;

  /* --------------------------------------------------------------
     Session-scoped store (v1.4.60).

     Nothing this extension records is meant to outlive the browser
     session. On a stale heartbeat — no Quotex tab open for >15s, i.e.
     the browser was closed — the whole database is deleted before it
     is opened, so a new session always starts empty.

     This file is injected BEFORE content.js, so the delete lands
     before anything can hold the database open. Every later call
     awaits it via openDb().

     It also matters that this store lives on the QUOTEX origin, not
     the extension's: IndexedDB is origin-scoped, so any script on
     qxbroker.com can read it while it exists. Keeping it short-lived
     is the point.
     -------------------------------------------------------------- */
  const wipeIfNewSession = (function () {
    try {
      const lastHb = parseInt(localStorage.getItem("__QX_SESSION_HEARTBEAT__") || "0", 10);
      if (Date.now() - lastHb <= 15000) return Promise.resolve(false);
    } catch (_) {
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(true); } };
      try {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = finish;
        req.onerror = finish;
        req.onblocked = finish;
      } catch (_) { finish(); }
      // never let a blocked delete stall the whole telemetry layer
      setTimeout(finish, 3000);
    });
  })();

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = wipeIfNewSession.then(() => new Promise((resolve, reject) => {
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
    }));
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
     recordBulk(rows)
     Many rows in ONE transaction. The harvest writes tens of
     thousands; a transaction per row is unusably slow.

     Two deliberate differences from record():

     1. Each row's own `settled` flag is preserved. A harvested row
        arrives already settled — the bar that resolved it is sitting
        right there in the history.
     2. Uses add(), not put(), so an existing row is never overwritten.
        A live row carries tick microstructure and real flip-gate
        behaviour that a harvested row cannot reconstruct; if the two
        ever collide on an id, live must win.

     Returns the number actually written (duplicates are skipped, not
     counted, and do not abort the batch).
     -------------------------------------------------------------- */
  function recordBulk(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return Promise.resolve(0);
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      let written = 0;
      for (const row of rows) {
        if (!row || !row.id) continue;
        row.schema = SCHEMA_VERSION;
        const req = store.add(row);
        req.onsuccess = () => { written++; };
        req.onerror = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
      }
      t.oncomplete = () => { cachedCount += written; resolve(written); };
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("bulk write aborted"));
    })).catch(() => 0);
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
    recordBulk,
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
