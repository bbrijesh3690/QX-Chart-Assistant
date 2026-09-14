# Changelog

## 1.4.58-hold-last-signal (Current)
Status: UI

Display only — no change to scoring, the `:55` lock, the `:58` flip gate, trade
queuing or telemetry, verified by diff.

Between locks the panel now **holds the last locked verdict** instead of
blanking to `Analyzing...`:

```
:55 - :59    STRONG BUY [LOCKED]          4 / 5
:00 - :54    STRONG BUY [Analyzing next]  4 / 5     ("Renew in 42s")
```

v1.4.56 hid the pre-lock verdict because it was recomputed every 250ms off the
tick and flickered. That removed the noise but threw away real information: the
last lock is what was actually traded. Holding it keeps the panel useful and
still cannot flicker, because the value is frozen until the next lock. The
bracket plus the existing "Renew in Ns" countdown makes the state unambiguous.

Falls back to `Analyzing...` / `- / 5` only before the first lock of a session.

---

## 1.4.57-stale-marker

Status: FIX

`renderBacktestUI` only ran on Run and on asset switch, so a cached result
quietly went out of date while the panel still presented it as current —
candles keep arriving after the run. Observed live: a result computed on 247
bars still displayed as current with 296 in the vault, no stale marker.

Now re-renders when the staleness state flips, so the marker appears the moment
it becomes true. Fires once per run, not on a timer. `btStaleShown` is declared
with the other module state so `renderBacktestUI` cannot read it inside the
temporal dead zone.

---

## 1.4.56-quiet-panel
Status: UI

Display only. No change to scoring, the `:55` lock, the `:58` flip gate, trade
queuing or telemetry — verified by diff.

### Forward pill shows counts only
`31T: 12W - 19L`. The rate, Wilson interval and net units moved to the tooltip.
At these sample sizes a percentage on the face of the pill invites being read
as a result when it is still noise.

### Pre-lock signal no longer displayed
The verdict was recomputed every 250ms from the live tick, so it flickered
between CALL / PUT / Neutral many times a minute. It is also **not
actionable** — nothing is decided until the `:55` lock and entry is the next
candle's open, so the forming value has no decision content. It now reads
`Analyzing...` with `- / 5` until the lock, at which point the locked verdict
appears as before.

The flicker itself was informative, though: a signal that changes direction
several times a minute on tick jitter is not describing anything stable. That
is consistent with the 26,734-row verdict that the components carry no signal.

---

## 1.4.55-symbol-order
Status: CRITICAL DATA FIX — completes v1.4.53/54

Live check after v1.4.54: **13 of 15 assets matched by symbol, 2 still fell
through to price**, and one contamination survived —
USD/MXN (OTC) ↔ NZD/JPY (OTC), 99% identical closes over 199 bars.

The cause was visible in the frame itself:

```
tokens: ["BRLUSD_otc", "period=60"]
```

**Quotex does not always quote a symbol in the order it displays it.**
"USD/BRL (OTC)" arrives as `BRLUSD_otc`. The matcher only built `USDBRL`, never
matched, and fell through to the price guess — which mis-filed it.

### Fixed
`packetOwnedBy` now accepts either currency ordering. This cannot create a
false match: the platform never lists both directions of the same pair as
separate assets, and the OTC/non-OTC check is unchanged.

### Verified
Reversed and forward orderings both match their own asset; neither cross-matches
a different pair (BRLUSD↛USD/MXN, JPYNZD↛USD/MXN, AUDJPY and JPYAUD ↛ CAD/JPY,
CADCHF and CHFCAD ↛ NZD/CAD); OTC separation preserved in both orders. Full
attribution and symbol-presence suites still pass.

### Note on stale vault state
`matchMode` lives in `sessionStorage`, which survives an extension reload. After
reloading, clear it (or open a fresh tab) before judging attribution, or you
will be reading values written by the previous version.

---

## 1.4.54-symbol-authoritative
Status: CRITICAL DATA FIX — completes v1.4.53

v1.4.53 added symbol matching but kept the price fallback reachable whenever
the symbol found no owner. Verified live: **13 of 15 assets matched by symbol,
but the 2 that fell through to price were mis-filed again** —
CAD/CHF (OTC) ↔ USD/BRL (OTC) and USD/MXN (OTC) ↔ NZD/JPY (OTC), each sharing
100% identical closes.

The symbol was present and said *"not yours"*; the price guess overrode it.

### Fixed
- A frame that names a pair we do not track is now **dropped**, never
  price-matched. Price inference is reachable only when the frame carries no
  symbol at all.
- Same gate applied in `tryHydrateCandles`, which had its own price path.
- `packetHasSymbol` distinguishes a real symbol from a numeric field: numbers
  are collected as `key=value`, so the `=` separates them — without that,
  `period=60` reduces to the six letters `PERIOD` and reads as a pair.

### Confirmed live
The identifier was in the frames all along, and `page-hook.js` had been
discarding it:

```
tokens: ["USDPKR_otc", "period=60"]
```

### Verified
Symbol-presence gate across real Quotex token shapes, plus both exact leaks
from v1.4.53 reproduced and blocked. Full v1.4.53 attribution suite still
passes: 15 attribution cases, foreign-block rejection with no leakage, clean
series intact.

### Store wiped
The 39,231 contaminated rows were cleared. Note `__QX_TELEMETRY__` lives in the
extension's ISOLATED world — it is `undefined` in the page console, so the
documented wipe command silently fails there. Either switch the DevTools
context to the QX Chart Assistant content script, or clear the
`QX_TELEMETRY` IndexedDB store directly.

---

## 1.4.53-symbol-attribution
Status: CRITICAL DATA FIX — invalidates all measurements up to v1.4.52

### History was being filed under the wrong asset
`page-hook.js` extracted the candle array from each WebSocket frame and threw
the rest of the envelope away — including the symbol. With no symbol,
`ingestHistory` had to *guess* the owning asset from price proximity within
**25%**. AUD/JPY and CAD/JPY trade 0.5% apart.

Evidence from the contaminated store:

- **CAD/CHF (OTC) and NZD/CAD (OTC) shared 178 bars with identical closes.**
- AUD/JPY drifted 110.128 → 88.564 with a **30.2%** gap between consecutive
  1m bars; AUD/NZD (OTC) had a **107,853%** jump.
- **12 of 20 loaded pairs** sat inside the 25% band.

With four assets this mostly held. At twenty it collapsed. A series stitched
from two instruments behaves like noise — which produces ~50% on everything
regardless of whether an edge exists. **Every measurement through v1.4.52 is
therefore unreliable**, including the confluence-engine verdict and the S/R
reversal scan. Not necessarily wrong; unproven.

### Fixed
- `page-hook.js` now forwards `tokens` (every non-candle string/small integer
  in the frame) and the socket event `prefix`. Also exposes
  `window.__QX_LAST_HISTORY_META__` for diagnosis.
- Attribution is now **symbol-first**: each token is checked individually so
  `EURUSD` cannot match an OTC frame, or vice versa.
- Price fallback only when **unambiguous** — exactly one asset within 2%. If
  two could own the packet it is dropped. Losing history is recoverable;
  poisoning a series is not.
- `mergeCandleArrays` rejects a foreign block **whole** when its median price
  is >5% from the existing series. Trimming just the bar at the seam would
  remove the visible discontinuity while leaving the other instrument's bars
  in place — hiding the splice rather than removing it.
- Zero and non-finite prices dropped.
- `matchMode` telemetry column appended (`"symbol"` / `"price"` / null for
  pre-v1.4.53 rows). `SCHEMA_VERSION` → 4.
- Telemetry pill tooltip reports attribution health: how each asset was
  matched, packets dropped as unattributable, bars rejected for an impossible
  1m move.

### Verified
15 symbol-attribution cases including both real collisions (AUD/JPY ↔ CAD/JPY,
CAD/CHF ↔ NZD/CAD) and OTC/non-OTC separation; the splice guard rejecting a
foreign block whole with no bar leaking through; clean series passing intact.
Harvest regression re-run: no scoring drift, 50.4% on a random walk.

### Existing telemetry is contaminated
All 15k+ stored rows predate this fix. Wipe with
`__QX_TELEMETRY__.wipe("YES")` in the console, reload assets, and re-harvest
before drawing any conclusion.

---

## 1.4.52-sr-reversal-scan
Status: HYPOTHESIS TEST

The classic-5pt confluence engine is **dead** — 50.3% over 4,694 decided OTC
trades, CI [48.8–51.7], with an upper bound below even the most generous
break-even (52.1%). No component beat 50%, and the score did not rank: the
4.5–5.0 bucket scored *worse* than 2.5–3.0. Confirmed on real pairs at 49.6%.

### Added — S/R Test button
A new, **pre-registered** hypothesis, unrelated to the old weights: draw S/R on
the 15m chart, drop to 1m, and take a candle that pierces a level but CLOSES
back on the origin side (a rejection wick). Enter next 1m open, 1m expiry.

This is a different claim from the engine's S/R component, which reads a 20-bar
*1-minute* range — roughly 20 minutes of structure. Here levels come from 15m
structure and the trigger is a candle pattern the engine has no concept of.

Three level definitions, all tested: swing pivots (±2 bars), rolling 20-bar
extremes, and prior-session high/low. Oldest two thirds train, newest third
held out, levels rebuilt inside each slice so nothing leaks.

### The null is not 50%
Measured over 10 random walks of 40,000 bars — data with no edge by
construction — this test returns **pivots 50.9%, rolling 51.4%, session 33.0%**.
The bias is real rather than a bug: when price closes *through* a level there is
no rejection candle, so the pattern structurally never books that class of
loser. The UI shows these nulls and only colours a result green when the
interval's **lower bound** clears its own null. Without this calibration a 52%
would have looked like a discovery.

### Guards
- **No look-ahead.** A swing pivot is not knowable until 2 bars after it forms;
  every level carries the earliest instant it could honestly have been used, and
  the scan refuses to fire before it. Unit-tested explicitly.
- **One signal per bar.** Nearby levels are often rejected by the same candle;
  emitting one signal each would book that bar's outcome several times,
  inflating n and falsely narrowing the interval. It is also not tradeable.
- **Frozen-market segmentation.** Quotex keeps serving candles for real pairs
  while FX is shut, but they are frozen (`high == low == open == close`). A
  weekend harvest is ~100% of these and silently drags results toward the null.
  Long runs are split out rather than hardcoding market hours, and scans never
  bridge the gap, so settlement stays against the genuinely next minute.

### Verified
The in-extension scan is behaviourally identical to the unit-tested reference
across three seeds × three methods (rates and sample sizes match exactly), and
the declared nulls reproduce to 0.1pp.

### First read — inconclusive, not promising
~74 signals from 7,367 OTC bars, about one per 100 minutes. Swing pivots leaned
above null in both train and holdout, but every interval spans 30+ points.
Reaching ~300 signals needs roughly 30,000 bars per group. Load 15–20 assets.

---

## 1.4.51-harvest
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
