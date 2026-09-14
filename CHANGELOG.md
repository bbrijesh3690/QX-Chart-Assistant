# Changelog

## 1.4.44-telemetry (Current)
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
