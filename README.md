# QX Chart Assistant

A **read-only, local-only** multi-timeframe analysis assistant for Quotex charts.

It observes, scores and measures. It does not place trades, does not touch the
account, and holds no network permissions — the only outbound action in the
entire codebase is a local file download.

**Version:** 1.4.61 · **Strategy:** v1.0.0-classic5pt — **retired, see below**

---

## Status: the strategy was measured and has no edge

This started as a signal engine. It ended as a measurement rig, which is the
more useful half.

Measured on **26,734 clean rows** across 24 assets, every one attributed by
symbol from the platform's own WebSocket frames:

| Bucket | Decided trades | Rate | 95% CI |
| :--- | :--- | :--- | :--- |
| **Engine, all signals (OTC)** | **16,582** | **50.4%** | **49.6 – 51.1** |
| Engine, STRONG tier | 538 | 50.2% | 46.0 – 54.4 |
| Real (non-OTC) pairs | 1,161 | 50.8% | 47.9 – 53.7 |

Binary options do not pay 1:1. With payouts of 74–93%, **break-even is
52.1–57.5%**, so the interval's upper bound sits below even the most generous
bar. No individual component beat 50% either.

And the score does not rank: the lowest bucket (2.5–3.0) returns 51.5% while
the highest (4.5–5.0) returns 47.6%. **More agreement between components
produced worse predictions**, which means the confluence premise fails rather
than the weights being mis-tuned. Reweighting cannot repair that.

Full working in `FROZEN_LEDGER.md`.

## What is actually worth reusing

The measurement apparatus, not the signal:

- **Payout-aware break-even.** Every rate is judged against `1/(1+payout)` for
  that asset, never against 50%.
- **Wilson intervals everywhere.** A bare percentage over a handful of trades
  is not evidence; the interval says so.
- **Calibrated nulls.** The S/R rejection test returns ~51% on pure random
  walks, because a level that breaks produces no rejection candle and that
  class of loser is never booked. Any result is read against *that*, not 50%.
- **Validated in both directions.** Fed data with a planted 65% edge it reports
  59.6%; fed a planted 35% edge it reports 42.4%. It is not pinned at 50%.
- **Provenance on every row.** `matchMode` records whether an asset's history
  was attributed by symbol or inferred, so contaminated rows stay filterable.

## How it works

| Layer | File | Role |
| :--- | :--- | :--- |
| Data tap | `page-hook.js` | Reads the live price off the chart canvas (~60fps) and parses OHLC out of the platform's own WebSocket frames. Passive — it observes existing traffic, sends nothing. |
| Engine | `content.js` | Builds 1m candles, derives 5m/15m by aggregation, scores the confluence every 250ms, runs forward and backward tests, exports Excel. |
| Telemetry | `telemetry.js` | Session-scoped IndexedDB record of every evaluation, for measurement. |

## The signal (retired — kept as the specification of what was tested)

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

- **Live** — asset, price, countdown, and the locked signal. Between locks the
  last locked verdict is held and marked `[Analyzing next]`; the pre-lock
  value is deliberately not shown, because it is recomputed off every tick and
  is not actionable until the lock.
- **Forward.test** — log of locked signals with pair/tier filters. Shows counts
  only; the rate, interval and net P/L are in the tooltip.
- **Backward.test** — replays loaded history bar by bar, per-asset cached,
  with a staleness marker when newer candles have arrived since the run.
- **Export** — two-sheet .xlsx dashboard, hand-rolled OpenXML, no dependencies.

The harvest and S/R rejection tools are no longer buttons; they remain
available on `__QX_TOOLS__` in the extension's ISOLATED world.

## Install

Load unpacked in `chrome://extensions` with Developer mode on.

## Data & privacy

**Nothing outlives the browser session.** On a stale heartbeat — no Quotex tab
open for >15s — the trade log, pending trades and asset vault are cleared and
the telemetry store is emptied. Only panel position and the sound toggles
persist, being preferences rather than records.

This matters because `localStorage` and IndexedDB are scoped to the *Quotex*
origin, not the extension's: while that data exists, any script on the page can
read it. Keeping it short-lived is the point. Schema in `TELEMETRY_SCHEMA.md`.

## Known limitations

- Canvas and DOM scraping will break on a Quotex UI change. This is the main
  maintenance risk, and it has broken twice already.
- Candle history is reconstructed from observed traffic, so it can contain
  gaps. `gapCount20` records them.
- OTC pairs are broker-generated feeds with the broker as counterparty. Results
  on them say nothing about real pairs, and the two must never be pooled.
- Consecutive minutes are heavily autocorrelated. 2,000 bars is nowhere near
  2,000 independent observations.
- The extension is detectable by the page: it patches `WebSocket` and canvas
  `fillText` in the MAIN world and injects a panel into the page's own DOM.
