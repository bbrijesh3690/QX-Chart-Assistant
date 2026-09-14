# Changelog

## 1.4.51-harvest (Current)
Status: DATASET

### Added — Harvest
A **Harvest** button in the Backward.test tab. Walks the whole `assetVault`
rather than just the active asset, replays each asset's `candles1m` through the
**same** `evaluateConfluence` and indicator functions the live path uses, and
bulk-writes one already-settled telemetry row per bar. Turns weeks of waiting
for live collection into one click over history already sitting in memory.

Rows arrive settled because the bar that resolves each one is right there in the
history: `entryOpen`/`exitClose`/`nextHigh`/`nextLow`/`nextDir` from the next bar.

### Harvested rows are deliberately not live rows
Tagged `source: "harvest"`, with ids prefixed `h_` so they can never collide
with a live row for the same minute. Both may exist; `source` keeps them apart.
**Filter on it — never pool.** Harvested rows have:

- no tick microstructure — the canvas stream is not replayable
- no flip gate — that needs sub-minute data history does not contain
- no payout — today's payout never applied to a bar from 30 hours ago, so
  recording one would be fabrication. Analysis must supply its own assumption.
- a fully **closed** bar scored, where live locks at `:55` on a partial one

### Added — plumbing
- `recordBulk(rows)` in `telemetry.js`: many rows in one transaction, preserving
  each row's own `settled` flag, and using `add()` so an existing row is never
  overwritten — a live row must always win a collision.
- `source` and `matchDist` columns, **appended** at the end of `COLUMNS`
  (never reordered). `SCHEMA_VERSION` → 3.
- `matchDist` is now recorded when `ingestHistory` attributes history to an
  asset by price proximity. The 25% band is wide enough to file GBP/USD under
  EUR/USD; the band is deliberately left alone, but the distance is now stored
  so a bad attribution is filterable after the fact instead of silently
  poisoning rows.
- Live rows now carry `source: "live"`.

### Verified
Schema parity with the live row (no missing or stray fields), correct bounds
(20-bar warmup, final bar unevaluated), correct settlement against the next bar,
correct null-labelling of every live-only column, behaviour on gappy history,
guards on short/missing input — and **zero scoring drift**: all 479 rows in the
test reproduce a full-history recompute exactly. On a random walk the harvest
returns 50.4%, i.e. it does not manufacture an edge the way the pre-v1.4.46
backtester did.

---

## 1.4.50-payout-aware
Status: MEASUREMENT

### The decision gate was calibrated to the wrong number
It treated ~50% as break-even. A binary win returns only the payout while a
loss costs the whole stake, so break-even is `1 / (1 + payout)`. Payouts on
this account run **74–93%**, which puts real break-even between **51.8% and
57.5%** — and it moves by asset and across the day.

Measured live on four tabs open at the same moment:

| Asset | Payout | Break-even |
| :--- | :--- | :--- |
| USD/IDR | 93% | 51.8% |
| USD/BRL | 82% | 54.9% |
| USD/MXN | 80% | 55.6% |
| USD/DZD | 78% | 56.2% |

A 54% hit rate is profitable on USD/IDR and loss-making on USD/DZD,
simultaneously. Most of the old gate's "53–57% → thin but real" band was in
fact still losing money.

### Added
- `payout` and `breakEven` telemetry columns, **appended** at the end of
  `COLUMNS` (never reordered), so older CSV exports stay compatible.
  `SCHEMA_VERSION` → 2. Scraped from the active asset tab at lock time.
- `payout` recorded on every queued trade, so the forward log carries it
  through to settlement.
- Forward summary now shows **net units** — `Σ(wins × payout) − losses` — the
  one figure that survives mixed payouts. Tooltip states the effective
  break-even and net P/L.
- Backtest table colours now key off that asset's real break-even instead of a
  hardcoded 65%/60%, with the bar stated in the footer.
- `CLAUDE.md` gate rewritten around Wilson lower bound vs break-even, with the
  sample sizes each true rate implies (a true 56% needs ~2,510 settled trades;
  a true 65% needs ~80).

Rows logged before v1.4.50 have no payout; the forward summary falls back to
54.1% (an 85% payout) and says so rather than silently assuming.

---

## 1.4.49-persistent-log
Status: FIX

### Fixed — the forward log reset on every browser relaunch
A heartbeat is written every 2s while a Quotex tab is open. On boot, a
heartbeat older than 15s was treated as a relaunch and the settled trade log
was **deleted** along with the vault and pending trades. Closing the browser
and reopening it therefore discarded the entire forward record, which made it
impossible to accumulate the few hundred settled trades the decision gate
needs — you would have restarted from zero every session, permanently.

The settled log now survives a relaunch. The asset vault and pending trades
still reset, because both reference candle series that are stale the moment
the browser closes and a pending trade whose candle is gone can never settle.

Those orphaned pending trades are now **counted** into the expired tally
rather than dropped silently, consistent with v1.4.48 — a log that quietly
loses trades reads as complete when it is not.

Verified against the real boot block: log survives a 60s-stale heartbeat,
orphaned pending are counted, vault clears, nothing resets on a 3s heartbeat,
and the log accumulates across repeated relaunches.

### Note — telemetry was never affected
`telemetry.js` is IndexedDB and the boot reset never touched it; it is cleared
only by an explicit `__QX_TELEMETRY__.wipe("YES")`. It remains the durable
record and the instrument the decision gate should be computed from.

### Known limits (unchanged)
- The visible log is capped at the 1000 most recent settled trades. Telemetry
  holds everything; the cap is a UI bound, not a data bound.
- `loadLog()` re-parses the full log from localStorage on a 500ms poll, which
  is wasteful at large log sizes. Pre-existing; not addressed here.

---

## 1.4.48-log-integrity
Status: FIX

### Fixed — forward log was silently losing trades
`reconcilePendingTrades` skips any trade whose asset isn't the one passed in,
and it was only ever called for the asset currently on screen. Switch away and
a pending trade sat unsettled until you came back; if that took over two hours
the expiry branch discarded it **without recording anything**. The log read as
complete while missing exactly the trades belonging to assets you stopped
watching — which is not a random sample, so the win rate was computed on a
biased subset.

- Added a 5s sweep (`reconcileAllPending`) that settles pending trades across
  every asset in the vault, using each asset's own candles.
- Trades that still expire unsettled are now counted and surfaced next to the
  forward summary (`⚠N`), with a tooltip explaining the skew. Cleared by `Clr`.

### Fixed — backtest blocked the UI for ~4 seconds
The backtest loop rebuilt every indicator from bar 0 on each step (two
Map-based aggregations, an RSI, and an S/R scan over an expanding slice) —
O(n²), measured at **4015ms for 2000 bars** in one synchronous click handler.

Now uses a trailing aggregation window, a 20-bar S/R window, and carries
Wilder's RSI smoothing forward: **4015ms → 266ms (15x)**, and 20x on gappy
data. Each substitution was chosen to be output-identical rather than merely
close, and verified as such — full result sets match the previous
implementation exactly on clean data and on data with injected gaps.

---

## 1.4.47-honest-stats
Status: MEASUREMENT

Display and accounting only — no change to which trades are taken, in either
tab. Follows v1.4.46's scoring unification with the reporting discipline the
project's own guardrails ask for.

### Added
- **Wilson 95% intervals on every win rate**, in both `Forward.test` and
  `Backward.test`. Validated against known values (50/100 → 40.4–59.6%,
  3/4 → 30.1–95.4%, 0/10 → 0–27.8%).
- Colour now keys off the interval's **lower bound**, not the point estimate.
  A 3W-1L "75%" no longer renders as a win; 168/280 at 60% correctly clears
  break-even, matching the ~280-trade figure in the statistical guardrails.
- Backtest footer states plainly that overlapping 20-bar windows on
  consecutive minutes are not N independent observations, that there is no
  flip gate, and that bars are scored fully closed where live locks at `:55`.
- Staleness indicator when the cached backtest was run on a different bar
  count than the asset currently holds.

### Fixed
- **Forward streaks were computed across all assets interleaved.** A "5 win
  streak" could be four unrelated pairs that happened to settle in that order,
  while the backtest's streaks are single-asset — so the two tabs' streak
  numbers were silently incomparable. Streaks are now per asset in both.
- `spanHours` was `bars / 60`, which assumes no gaps. Now uses real elapsed
  time and reports the number of missing bars alongside it.
- Accounting line now also accounts for the final unevaluated bar.

---

## 1.4.46-unified-scoring
Status: CORRECTION — invalidates all prior backtest numbers

### Fixed
`Forward.test` and `Backward.test` were not measuring the same strategy, so
their numbers were never comparable. Two near-identical scoring functions had
silently drifted apart at the S/R component:

- backtest probed with the evaluated bar's wick (`candle.low` / `candle.high`)
- live probed with a single price point (the current tick)

`calcSR` builds the level from a 20-bar window that **includes** the evaluated
bar, so the backtest was frequently measuring a bar against a level that bar
had itself defined — distance exactly zero, a guaranteed `+1.0`. Over 2000
bars the component fired on 34.2% / 26.8% of bars in the backtest versus
10.1% / 6.0% live.

Both are now one `evaluateConfluence` taking an explicit `srProbe`. Live passes
the current tick; the backtester passes the evaluated bar's close.

### Impact — prior backtest results are void
On 2000 random-walk bars (no real edge by construction), correcting the probe
moved the STRONG tier from **143 setups at 54.5%** to **14 setups at 50.0%**.
The old STRONG bucket was ~90% an artifact of the self-referential S/R bonus,
and it was reporting an apparent edge on data that has none. Any conclusion
previously drawn from a `Backward.test` STRONG win rate should be discarded,
not compared against.

### Unchanged — deliberately
The live signal path is untouched; v1.4.43 remains a valid control. Verified
mechanically: the surviving `evaluateConfluence` is byte-identical to the
previous one after normalising the `price` → `srProbe` rename, and the live
call site still passes `state.livePrice`.

### Still not comparable — and not fixable from 1m OHLC
- The backtester evaluates a **fully closed** bar; live locks at `:55` on a
  partially formed one. Different information sets.
- The backtester cannot model the `:58` flip gate, so live executions are a
  subset of backtest signals, not a replica.

---

## 1.4.45-assetfix
Status: FIX

### Fixed
- Active-asset detection (`getActiveTabFromDOM`) was silently stuck on whichever
  tab opened first. Quotex now renders asset tabs with hashed CSS-module
  classnames that rotate every build (e.g. `dJ15T vXMlv`, with an extra `AmO6b`
  only on the selected tab) — none of them contain literal words like
  `active`/`selected` anymore, so the old regex-based bonus went permanently
  silent and every tab tied on score, defaulting to DOM order.
- Reproduced live against qxbroker.com and confirmed the fix: switching between
  4 open OTC tabs (USD/IDR → USD/DZD → USD/MXN) now updates the detected asset
  every time, instead of sticking on the first tab.
- Fix is structural, not name-based: an element carrying a class its sibling
  tabs don't share is scored as the active one, so it survives the next class
  hash rotation too. Also normalizes nested near-identical-box wrapper divs to
  the outer element that actually carries the state class.
- No change to scoring, thresholds, or timing — this is DOM detection only,
  outside the frozen signal path.

---

## 1.4.44-telemetry
Status: COLLECTING

### Added
- `telemetry.js`: append-only IndexedDB store recording one feature vector per minute-level evaluation, surviving browser restarts. 63 columns — see `TELEMETRY_SCHEMA.md`.
- Captures **every** verdict including NEUTRAL and flip-gate rejects, so skipped minutes form a control group against which the confluence can actually be measured.
- Shadow features computed but deliberately unused by the live signal: last-closed 15m/5m trend alongside the forming-bar reading, RSI excluding the partial candle, and wick-aware S/R distance alongside the price-based one. Each settles an open design question from data rather than argument.
- Microstructure features derived from the existing 60fps tick stream: tick counts, directional imbalance and realised range over 5s/10s/60s windows.
- Volatility and regime features (ATR14, 20-bar return stdev) and data-integrity fields (`gapCount20`, `staleMs`).
- `rawCall` / `rawPut`: the unrounded confluence scores. The UI still rounds 3.5 to "4 / 5"; the telemetry keeps the real value.
- Settlement stores the raw next-candle OHLC plus **both** entry conventions (rollover tick and candle open), so outcomes stay derivable under either and forward/backward results finally become comparable.
- Telemetry pill in the panel header showing live record and settled counts; click to export CSV.

### Unchanged — deliberately
The entire signal path is byte-identical to v1.4.43: scoring weights, tier
thresholds, the `:55` lock and the `:58` flip gate are untouched, verified by
diff. v1.4.43 remains the control for every comparison that follows.

### Tests
68 assertions across three suites — storage layer against a real IndexedDB
implementation, feature helpers, and a full browser integration run driving a
complete lock-to-settlement minute cycle.

---

## 1.4.35 – 1.4.43
Atomic multi-window trade queuing; clean boot session and Edge shutdown handling;
hardened dual-channel sync; DOM query and tick-math performance work; corrected
Quotex OHLC parser with history capacity raised to 2000 bars; restored canvas
price ticks with dynamic wide-tab detection.

## 1.4.29 – 1.4.34
Native OpenXML `.xlsx` export written from scratch — two worksheets, bank-statement
layout, per-row signal and outcome columns, professional column widths and navy
headers, culminating in the executive dashboard layout with dual summary KPIs.

## 1.4.21 – 1.4.28
Backtest engine; dual Forward/Backward tab drawer; persistent per-asset backtest
cache; mac-style window controls; in-column tier filtering; dynamic signal-renew
label; dual max win/loss streaks; wick-aware S/R backtester with explicit
neutral-skipped accounting.

## 1.4.7 – 1.4.20
Core MTF engine (ticks, real decimals, multi-asset vault, S/R, RSI); 55s lock and
strict 58–60s millisecond flip gate; loud audio engine with dual mute controls;
forward log with catch-up reconciliation, pair filter and tier badges;
multi-window sync.

## 1.2.6-analysis
Passive WebSocket eavesdropper for instant candle capture; tab-scoped
`sessionStorage` cache; asset-switch auto-reset; 15m and 5m derived timeframes.
