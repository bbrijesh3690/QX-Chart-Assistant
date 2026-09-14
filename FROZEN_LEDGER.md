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
