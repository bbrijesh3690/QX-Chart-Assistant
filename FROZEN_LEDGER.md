# QX Chart Assistant — Frozen Milestone Ledger

| Version | Tag | Milestone Description | Date Locked |
| :--- | :--- | :--- | :--- |
| **v1.4.7** | `v1.4.7-frozen` | Core MTF Engine (Ticks, Real Decimals, Multi-Asset Vault V5, S/R, RSI) | Milestone 1 |
| **v1.4.11** | `v1.4.11-frozen` | Timing & Watchdog (55s Lock, Strict 58s-60s Millisecond Flip Gate) | Milestone 2 |
| **v1.4.15** | `v1.4.15-frozen` | Loud Audio Engine (3x Fanfare Strong, 3x Arcade Bias, Dual Mute Controls) | Milestone 3 |
| **v1.4.28** | `v1.4.28-frozen` | Wick-Aware Backtester + Multi-Window Sync + Audio Synthesis | Milestone 4 |
| **v1.4.34** | (baseline commit) | Executive Dashboard .xlsx Export, Dual Summary KPI Reports | Milestone 5 |
| **v1.4.40** | `v1.4.40-frozen` | Platform Baseline + Signal Confluence v1.0.0-classic5pt | Milestone 6 |
| **v1.4.43** | (baseline commit) | Canvas Price Ticks, Dynamic Wide Tab Detection, Session Lifecycle | Milestone 7 |
| **v1.4.45** | `v1.4.45-frozen` | Last version with the divergent backtest S/R probe. Frozen before unifying the scoring paths. | Milestone 8 |
| **v1.4.48** | `v1.4.48-frozen` | Unified scoring, Wilson intervals, forward-log integrity, 15x backtest. First version where both tabs measure one strategy. | Milestone 9 |
| **v1.4.55** | `v1.4.55-frozen` | Symbol-based history attribution. First trustworthy dataset — and the version the decision gate was finally run on. | Milestone 10 |
| **v1.4.61** | `v1.4.61-frozen` | Post-verdict cleanup: slim panel, session-scoped storage, nothing persists past the browser. | Milestone 11 |
| **v1.4.62** | `v1.4.62-frozen` | Repo and surface cleanup. Honest public README, no dead files, one global left in the page's world. | Milestone 12 |

## Measurement baseline

**v1.4.43 is the control for the LIVE signal path.** Every strategy change from
v1.4.45 onward is measured against it. v1.4.44 adds telemetry only — its signal
path is byte-identical to v1.4.43 by diff, which is what makes the comparison
valid. v1.4.45 changes DOM asset detection only, not scoring. Do not modify
scoring weights, tier thresholds, or the lock/flip timing without cutting a new
frozen baseline first and noting it here.

### v1.4.46 — backtest scoring realigned to live

Up to and including v1.4.45 the backtester scored the S/R component from the
evaluated bar's **wick** (`candle.low` / `candle.high`) while the live path
scored it from a **single price point**. Because `calcSR` builds the level from
a 20-bar window that includes the evaluated bar, the backtest's distance was
frequently exactly zero — the bar *was* the level it was being measured against.
Measured over 2000 bars, the component fired on 34.2% / 26.8% of bars in the
backtest versus 10.1% / 6.0% live.

v1.4.46 collapses both into one `evaluateConfluence`, so the two paths run
identical arithmetic. **The live path is unchanged** — v1.4.43 remains a valid
control. Backtest numbers produced before v1.4.46 are not comparable to those
produced after it, and any recorded pre-v1.4.46 backtest win rate should be
discarded rather than compared.

Two differences remain and are **not fixable** with 1m OHLC history alone:
the backtester evaluates a fully closed bar where the live path locks at `:55`
on a partially formed one, and the backtester cannot model the `:58` flip gate.
Live results are therefore a subset of backtest signals, not a replica.

### v1.4.48 — measurement baseline for the decision gate

Milestone 9 is the first version in which `Forward.test` and `Backward.test`
run the same arithmetic, report Wilson intervals rather than bare percentages,
and do not silently lose settled trades. It is the version the decision gate in
`CLAUDE.md` should be run against.

Verified at freeze time, live on qxbroker.com:

- live signal path byte-identical to v1.4.43 (mechanically checked, not
  eyeballed — `evaluateConfluence` matches after normalising the
  `price` → `srProbe` rename, and no lock/flip/queue line differs)
- backtest optimisations output-identical to the pre-optimisation loop on both
  clean and gap-injected data
- asset detection tracks tab switches across all four open tabs
- backtest accounting reconciles exactly: 108 traded + 70 neutral + 20 warmup
  + 1 unevaluated = 199 bars
- no extension errors in console

**Known state of the forward log at this freeze.** Trades recorded before
v1.4.46 are still valid as live results (the live path never changed), but the
log has no `source` column to separate them. Any pre-v1.4.46 `Backward.test`
figure written down elsewhere is void and must not be compared against numbers
from this version.

## Standalone Backup Location

All frozen versions are permanently archived as isolated ZIPs in:
`E:\Qx\Brijesh\QX_Frozen_Vault\`

## Milestone 10 — the gate was run, and v1.0.0-classic5pt failed it

Measured on **26,734 clean rows** across 24 assets, every one attributed by
symbol, zero contaminated pairs, 5 stray bars (0.019%) removed.

**OTC, 16,582 decided trades: 50.4%, CI [49.6 – 51.1].**

Break-even is 52.1–57.5% depending on payout. The interval's upper bound sits
below even the most generous bar. No component cleared 50%: 15m 50.1/50.3,
5m 50.3/49.5, RSI extreme 49.8, RSI momentum 50.0, S/R 50.4.

**The score does not rank** — 2.5–3.0 returns 51.5%, 4.5–5.0 returns 47.6%.
The confluence premise fails, not just the weights, so reweighting cannot
repair it. Real pairs: 50.8% [47.9–53.7] on 1,161 decided, consistent but thin.

### The verdict was delivered twice, and the first one was not valid

An earlier run reported 50.3% on 4,694 trades and called the engine dead. That
data was contaminated: `ingestHistory` guessed the owning asset from price
proximity within 25%, and AUD/JPY sits 0.5% from CAD/JPY. CAD/CHF and NZD/CAD
ended up sharing 178 bars with identical closes; AUD/JPY drifted 110 → 88 with
a 30% one-minute gap.

A spliced series behaves like noise, which returns ~50% regardless of whether
an edge exists — so that verdict was unsupported even though it happened to be
correct. It was defended on the strength of a planted-edge test that validated
the *analysis* while saying nothing about the *input*. Both halves need
checking, every time.

The symbol was in the WebSocket frame all along (`tokens: ["USDPKR_otc", …]`);
`page-hook.js` was discarding it. Fixed across v1.4.53–55, the last piece being
that Quotex does not always quote a symbol in the order it displays it —
"USD/BRL (OTC)" arrives as `BRLUSD_otc`.

### Status

- **v1.0.0-classic5pt is retired.** Do not tune it. Per the gate: change the
  inputs.
- **The 15m S/R rejection hypothesis (v1.4.52) is untested on clean data** and
  is the one remaining live thread. Its null is calibrated — pivots 50.9%,
  rolling 51.4%, session 33.0% — judge against that, never against 50%.
- The measurement rig itself is sound and reusable: it detects planted edges in
  both directions (65% momentum → 59.6%; 35% → 42.4%), reports Wilson intervals
  against payout-aware break-even, and now records how every row was attributed.

## Milestone 11 — post-verdict cleanup (v1.4.56 – v1.4.61)

The strategy was retired at Milestone 10. These seven commits tidy what was
left and return the extension to its original brief: local, quiet, and
leaving nothing behind. **No change to scoring, the `:55` lock, the `:58` flip
gate, trade queuing or telemetry capture** — verified by diff on each.

### Panel
- Forward pill shows counts only (`2T: 1W - 1L`); rate, Wilson interval and net
  units moved to the tooltip. A percentage on the face of the pill invites
  being read as a result while it is still noise.
- Between locks the panel **holds the last locked verdict** —
  `PUT Bias [Analyzing next]` with its score — instead of showing a live one.
  The pre-lock verdict was recomputed every 250ms off the tick and flickered
  several times a minute, and it was never actionable: nothing is decided
  until `:55` and entry is the next candle's open. Held, it cannot flicker.
- Telemetry pill, Harvest and S/R Test removed. The rig behind the last two is
  kept reachable on `__QX_TOOLS__` rather than deleted — it is the durable
  result of this project.
- Backtest staleness marker now appears when it becomes true. It was computed
  only on Run and on asset switch, so a cached result silently aged while being
  presented as current (observed: a result from 247 bars shown as current with
  296 in the vault).

### Storage — nothing outlives the browser session
Reverts v1.4.49, which had made the trade log survive a relaunch so the gate
could accumulate trades. The gate has been run, so the original requirement
applies again.

On a stale heartbeat — no Quotex tab open for >15s — the trade log, pending
trades, expired counter and asset vault are cleared, and the telemetry store is
emptied on first open. Panel position and the two sound toggles are kept, being
preferences rather than records.

This matters because `localStorage` and IndexedDB are scoped to the **Quotex
origin**, not the extension: while that data exists, any script on
qxbroker.com can read it. 31 MB of telemetry had accumulated there. Verified
after a real browser restart: origin usage 31.24 MB → 0.019 MB, trade log
empty, fresh session starting from two trades.

### Two bugs found by testing rather than by reading
- `deleteDatabase()` needs exclusive access. With a connection open it blocks,
  and every later `open()` queues behind it — **observed freezing a tab's
  renderer outright**. Two tabs booting together after a relaunch would hit
  this. Replaced with `clear()`, which runs in an ordinary transaction and
  cannot block.
- A `QX_TELEMETRY` database can exist at version 1 with **no object store** —
  any bare `indexedDB.open()` by name creates exactly that. Since `DB_VERSION`
  is also 1, `onupgradeneeded` never fires and every transaction throws
  `NotFoundError`: telemetry silently and permanently dead, with no symptom.
  `openDb` now detects the missing store and reopens one version higher to
  rebuild it. Verified against `fake-indexeddb`.

## Milestone 12 — repo and surface cleanup (v1.4.62)

No functional change. Nothing here touches scoring, the `:55` lock, the `:58`
flip gate, trade queuing, telemetry capture or history attribution — verified
by the attribution, symbol-presence, reversed-order and ephemeral suites.

### The public repo was misrepresenting the project
`README.md` claimed **v1.4.44**, documented a telemetry pill removed in
v1.4.59, and presented v1.0.0-classic5pt as a working strategy — weights table
and all, with no mention that it had been measured and failed. This repo is
public, so anyone finding it would have taken that at face value.

It now leads with the verdict and reframes the project around the part that is
actually reusable: the measurement rig. `STRATEGY_VERSION` leads with
`STATUS=RETIRED`, keeping the point allocation below as the record of what was
tested.

### Removed
- `window.__QX_LAST_HISTORY_META__` — added in v1.4.53 to diagnose the
  mis-attribution bug, unread since. It also sat in the MAIN world, so it was
  one of only two things written where the page could read it. `tokens` and
  `prefix` still reach `content.js` in the message payload, which is what the
  symbol match actually reads; the global was only ever a mirror.
- `visualizer.html` — a standalone demo of the retired engine. Verified
  unreferenced first: `manifest.json` declares none of the keys that could load
  a page (no `web_accessible_resources`, `action`, `options_page`,
  `chrome_url_overrides`, `background`, `devtools_page`, `side_panel`), no
  tracked file mentioned it, and it used none of the extension's APIs.
  Recoverable via `git show v1.4.61-frozen:visualizer.html`.

### Added
`.gitignore` for build artifacts and panel exports. It exists mainly because
`git add -A` would otherwise sweep the handover ZIP into a public repo — the
older workflow used exactly that command.

### Also fixed
v1.4.59, v1.4.60 and v1.4.61 had shipped with no `CHANGELOG.md` entries, so the
file jumped from v1.4.62 back to v1.4.58 and two versions carried a "(Current)"
marker. Three versions of work — including the storage change and both
IndexedDB bugs — were undocumented. Backfilled.

### What remains detectable, deliberately
`page-hook.js` must patch the page's own `WebSocket` and
`CanvasRenderingContext2D.prototype.fillText`; that patch **is** the data tap,
and `WebSocket.toString()` no longer reporting `[native code]` announces it in
one line. The panel is also a real child of `document.body`. Shadow-DOM
encapsulation and randomised IDs were considered and not done: they would break
40 `getElementById` call sites and the injected stylesheet while leaving the
primary tell untouched.
