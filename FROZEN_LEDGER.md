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

## Measurement baseline

**v1.4.43 is the control.** Every strategy change from v1.4.45 onward is measured
against it. v1.4.44 adds telemetry only — its signal path is byte-identical to
v1.4.43 by diff, which is what makes the comparison valid. Do not modify scoring
weights, tier thresholds, or the lock/flip timing without cutting a new frozen
baseline first and noting it here.

## Standalone Backup Location

All frozen versions are permanently archived as isolated ZIPs in:
`E:\Qx\Brijesh\QX_Frozen_Vault\`
