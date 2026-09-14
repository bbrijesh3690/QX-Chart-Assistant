# QX Chart Assistant — Working Notes

Read this before changing anything. It encodes decisions that are easy to
undo by accident.

## What this is

A Manifest V3 Chrome extension that overlays a read-only multi-timeframe
analysis panel on Quotex charts. It scores setups, logs them, and measures
itself. Owner: Brijesh Bhavsar. Repo: `bbrijesh3690/QX-Chart-Assistant`.

## Hard rules — do not violate

1. **Read-only.** The extension never places, modifies or cancels a trade, and
   never automates a click on the platform. The only `.click()` in the codebase
   is a download anchor. Keep it that way.
2. **Local-only.** No network permissions, no API calls, no telemetry upload,
   nothing leaves the browser. `permissions` is `["storage"]` and should stay
   that way. If a change seems to need a network call, it is the wrong change.
3. **No account access.** Nothing reads balance, credentials or account state.

## Architecture

| File | World | Role |
| :--- | :--- | :--- |
| `page-hook.js` | MAIN | Passive data tap. Patches `CanvasRenderingContext2D.fillText` to read the painted price (~60fps) and wraps `WebSocket` to parse OHLC from inbound frames. Emits `QX_FAST_PRICE_TICK` / `QX_HISTORICAL_CANDLES` via `postMessage`. Observes only — sends nothing. |
| `telemetry.js` | ISOLATED | Append-only IndexedDB store, `window.__QX_TELEMETRY__`. Loaded **before** `content.js`. |
| `content.js` | ISOLATED | Everything else: candle building, confluence scoring, forward/backtest, UI, OpenXML export. |

Key internals in `content.js`:
- `assetVault` — per-asset state, mirrored to `sessionStorage`. **Holds every asset visited this session, not just the active one.**
- `globalHistoryPool` — last 35 WebSocket history packets.
- Cross-tab sync via `BroadcastChannel` + `localStorage` + 500ms poll.
- IndexedDB is origin-scoped, so all Quotex tabs share one telemetry store.

## The strategy — v1.0.0-classic5pt

Evaluated every 250ms. Max score 5.0.

| Component | Weight |
| :--- | :--- |
| 15m trend (forming bar close vs open) | 1.5 |
| 5m trend (last 5m close vs prior) | 1.0 |
| 1m RSI(14) ≤32 / ≥68 | 1.5 |
| RSI momentum, non-extreme | 0.5 |
| 20-bar S/R proximity <15% of range | 1.0 |

STRONG ≥3.5 · BIAS ≥2.5 · NEUTRAL below.
Locks at `:55`. Flip watchdog `:58`–`:60` cancels if direction diverges or score
drops below 2. Entry next candle open, 1-minute expiry.

## Measurement discipline — the important part

**v1.4.43 is the control baseline.** Every strategy change is measured against
it. v1.4.44 added telemetry with a *byte-identical signal path*, verified by
diff — that is what makes the comparison valid.

Therefore:

- **Do not change scoring weights, tier thresholds, or the `:55`/`:58` timing**
  without cutting a frozen baseline first and recording it in `FROZEN_LEDGER.md`.
- Additive changes to the verdict objects are fine (that is how `rawCall` /
  `rawPut` were added). Changes to the arithmetic are not, unless deliberate.
- After touching `content.js`, verify the signal path is still unchanged:
  diff against the previous frozen version and confirm every changed line is
  additive.

The reason: these weights were hand-guessed. Nobody yet knows which components
carry signal. Changing them before measuring destroys the only baseline we have.

## Current state

- Working version **1.4.44-telemetry**. Signal path identical to v1.4.43.
- v1.4.44 may still be **uncommitted**. Check `git status` first; commit and tag
  `v1.4.44-telemetry` before starting new work.
- `TELEMETRY_SCHEMA.md` documents all 63 telemetry columns and the analysis plan.

## Next task — harvest function (v1.4.45)

Goal: get a labeled dataset today instead of waiting weeks for live collection.

Each asset loads with up to 2000 bars of 1m history from the WebSocket, already
sitting in `assetVault`. `runBacktestForActiveAsset` only reads the active
asset's candles and only prints an aggregate.

Build a harvest that:

1. Iterates **the whole `assetVault`**, not just the active asset.
2. For each asset, walks its `candles1m` with a 20-bar warmup — reuse the loop in
   `computeBacktestData`.
3. At each bar, extracts the same feature vector `captureTelemetry` builds, and
   writes it to the telemetry store.
4. Tags every row `source: "harvest"` (live rows get `source: "live"`). **Never
   let the two pool silently** — harvested rows have no tick microstructure and
   no flip-gate behaviour, so those columns are null.
5. Records the price-match distance per asset (see caveat below) so bad
   attributions are filterable afterwards.

Add `source` and `matchDist` to `COLUMNS` in `telemetry.js` — **append at the
end**, never reorder, so older CSV exports stay compatible.

### Known data-quality caveat

`ingestHistory` matches incoming history to an asset by price proximity within
**25%**, which is wide — EUR/USD at 1.08 and GBP/USD at 1.26 are only 17% apart,
so history can be filed under the wrong asset. Do not casually tighten the
threshold; it is probably wide because the canvas-scraped price can be briefly
stale, and a tight band would break hydration. Handle it by recording the match
distance and by checking for duplicate candle series across assets in analysis.

## The decision gate

After harvest, produce one table: hit rate by raw score bucket, hit rate per
component in isolation, each with a Wilson confidence interval. Agreed in
advance:

- **~50%** → no edge. Stop or change the inputs. Do not start reweighting.
- **53–57%** → thin but real. Worth pursuing; find the regime carrying it.
- **>60% out-of-sample** → strong.

Do not skip past this gate into tuning. Tuning before the gate is fitting noise.

## Conventions

- One numbered version per feature. Bump `manifest.json` version, `VERSION`, and
  the version string in the panel header (`mountUI`) together — all three.
- Conventional commits naming the version: `feat: v1.4.45 <what>`.
- Tag each version. Periodic `chore: freeze baseline at vX` with a `-frozen` tag,
  mirrored as a ZIP in `E:\Qx\Brijesh\QX_Frozen_Vault\`, recorded in
  `FROZEN_LEDGER.md`.
- Rolling back to a frozen tag is a normal part of this workflow.

## Testing

Test files live outside the extension folder (they must not ship). Suites cover:
the IndexedDB layer against `fake-indexeddb`, the feature helpers, and a full
`jsdom` integration run driving a lock → rollover → settlement cycle with a
mocked clock. Requires `fake-indexeddb` and `jsdom` as dev dependencies.

Run them after any change to `content.js` or `telemetry.js`.

## Statistical guardrails

- Distinguishing 60% from break-even needs ~280 settled trades; 57% from 54%
  needs ~1100. Report Wilson intervals, never bare percentages.
- Hold out the newest third of data by time. Do not look at it while iterating.
- ~40 tagged versions of tuning against the same history has already spent a lot
  of statistical power. Confirm findings on fresh data.
- Never pool OTC with real pairs. OTC feeds are broker-generated and the broker
  is the counterparty; an edge on one says nothing about the other.
- Consecutive minutes are highly autocorrelated — 2000 bars is nowhere near 2000
  independent observations.
