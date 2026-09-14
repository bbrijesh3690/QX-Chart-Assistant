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
