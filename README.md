# QX Chart Assistant

A **read-only, local-only** multi-timeframe analysis assistant for Quotex charts.

It observes, scores and measures. It does not place trades, does not touch the
account, and holds no network permissions — the only outbound action in the
entire codebase is a local file download.

**Version:** 1.4.44-telemetry · **Strategy:** v1.0.0-classic5pt

## How it works

| Layer | File | Role |
| :--- | :--- | :--- |
| Data tap | `page-hook.js` | Reads the live price off the chart canvas (~60fps) and parses OHLC out of the platform's own WebSocket frames. Passive — it observes existing traffic, sends nothing. |
| Engine | `content.js` | Builds 1m candles, derives 5m/15m by aggregation, scores the confluence every 250ms, runs forward and backward tests, exports Excel. |
| Telemetry | `telemetry.js` | Append-only IndexedDB record of every evaluation, for strategy measurement. |

## The signal

A 5-point confluence matrix, locked at `:55` each minute:

| Component | Weight |
| :--- | :--- |
| 15m trend | 1.5 |
| 5m trend | 1.0 |
| 1m RSI(14) extreme (≤32 / ≥68) | 1.5 |
| RSI momentum (non-extreme) | 0.5 |
| 20-bar S/R proximity (<15% of range) | 1.0 |

**STRONG** ≥ 3.5 · **BIAS** ≥ 2.5 · **NEUTRAL** below.

Between `:58` and `:60` a flip watchdog cancels the signal if direction diverges
or the score collapses below 2.

## Panel

- **Live** — asset, price, countdown, signal, score, the four component readings
- **Forward.test** — shadow log of locked signals with pair/tier filters, W-L, streaks
- **Backward.test** — replays loaded history bar by bar, per-asset cached
- **Export** — two-sheet .xlsx dashboard, written with a hand-rolled OpenXML writer (no dependencies)
- **● pill** — telemetry record count; click to export the full dataset as CSV

## Install

Load unpacked in `chrome://extensions` with Developer mode on.

## Known limitations

- Canvas and DOM scraping will break on a Quotex UI change. This is the main maintenance risk.
- Candle history is reconstructed from observed traffic, so it can contain gaps. `gapCount20` in the telemetry records them.
- OTC pairs are broker-generated feeds, not real market data. Results on them do not transfer to real pairs.

## Data & privacy

Everything is stored in the browser and stays there. See `TELEMETRY_SCHEMA.md`.
