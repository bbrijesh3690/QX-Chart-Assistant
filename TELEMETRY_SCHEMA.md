# Signal Telemetry Schema (v1.4.44)

One row per minute-level evaluation, captured at the `:55` lock for **every**
verdict — STRONG, BIAS and NEUTRAL alike. Stored in IndexedDB
(`QX_TELEMETRY` → `evaluations`), keyed `"<asset>_<tradeMinute>"`.

The store is **append-only and survives browser restarts**, unlike the trade log.
Click the `●` pill in the panel header to export everything as CSV.

## Why neutrals and rejects are recorded

A dataset containing only the signals we traded cannot answer whether the
filter that produced them works. If STRONG setups win 58% we need to know what
the ones we skipped did — if NEUTRAL minutes also resolved 58% in the predicted
direction, the confluence is measuring nothing. The skipped rows are the control
group, and the flip-gate rejects are the sharpest test of all: they are the
trades the gate claims to have saved us from.

## Deriving outcomes

Settlement deliberately stores the **raw next-candle OHLC** rather than a
WIN/LOSS verdict, so the label stays derivable under any convention:

```
CALL wins  ⟺  exitClose > entryTick     (live convention)
CALL wins  ⟺  exitClose > entryOpen     (backtest convention)
PUT  wins  ⟺  exitClose < entry…
```

Both entry prices are recorded because the live path enters at the rollover tick
and the backtester enters at the candle open. Keeping both is what finally makes
forward and backward results comparable.

## Columns

### Identity
| Column | Meaning |
| :--- | :--- |
| `id` | `<asset>_<tradeMinute>` |
| `asset` | Normalised pair, e.g. `EUR/USD` or `EUR/USD (OTC)` |
| `isOtc` | 1 for OTC (broker-synthesised feed), else 0 |
| `decimals` | Price precision inferred from the chart |
| `schema` | Schema version for forward compatibility |

### Timing
| Column | Meaning |
| :--- | :--- |
| `evalTs` | Wall-clock ms at the lock |
| `evalMinute` | Minute whose candle was still forming at lock |
| `tradeMinute` | Minute actually traded — `evalMinute + 60000` |
| `localHour`, `localMinute`, `minuteOfDay`, `dayOfWeek` | Local session clock |
| `utcHour` | For aligning across sessions |

### The verdict, exactly as the live panel decided it
| Column | Meaning |
| :--- | :--- |
| `lockPrice` | Live price at the moment of lock |
| `dir` | `CALL` / `PUT` / `NONE` |
| `tier` | `STRONG` / `BIAS` / `NONE` |
| `setup` | Display string |
| `score` | The **rounded** score shown in the UI |
| `rawCall`, `rawPut` | **Unrounded** scores. A 3.5 displays as `4 / 5`; these are the real numbers and the ones to model on. |

### Confluence components as used live
`trend15`, `trend5`, `rsi`, `srS`, `srR`, `srRange`, `distSupPrice`, `distResPrice`

S/R distances are fractions of the 20-bar range — the live rule fires below `0.15`.

### Shadow features — computed, never used by the signal
These exist to settle open design questions with evidence instead of argument.

| Column | Question it answers |
| :--- | :--- |
| `trend15Closed` | The live signal reads the *forming* 15m bar, which is near-random early in a block. Does the last **closed** bar predict better? |
| `trend5Closed` | Same question for the 5m trend. |
| `rsiClosed` | RSI excluding the forming 1m candle. Does including a partial bar help or add noise? |
| `distSupWick`, `distResWick` | The backtester uses candle wicks, the live path uses spot price. This is the asymmetry that made the two incomparable — now both are logged. |
| `m15BlockPos` | Minutes elapsed into the 15m block (0–14). Lets you weight the 15m trend by how much of it actually exists yet. |
| `m15BarsClosed` | How many complete 15m bars were available. |

### Volatility / regime
`atr14`, `atrPct`, `stdev20`, `stdev20Pct`

Most 1m losses come from chop. Bucketing by these is usually where hit rate
separates — a strategy that is 58% in two regimes and 45% in a third looks
like 54% overall, and the average hides the whole story.

### Data sufficiency & integrity
| Column | Meaning |
| :--- | :--- |
| `count1m`, `count5m`, `count15m` | Bars available at evaluation |
| `gapCount20` | Missing minutes inside the last 20 bars |
| `staleMs` | Age of the most recent tick |

A signal computed over a gappy or thin window is not the same signal. Filter on
these before trusting any row.

### Microstructure — from the 60fps canvas tick stream
| Column | Meaning |
| :--- | :--- |
| `tick5s`, `tick10s`, `tick60s` | Tick counts — a proxy for activity |
| `tickUp10s`, `tickDown10s` | Directional tick counts |
| `tickImb10s` | Order-flow imbalance, −1 to +1 |
| `range5s`, `range60s`, `range5sPct` | Realised range |

This stream is the one dataset a chart-reading trader does not have, and nothing
in the current strategy uses it. Short-horizon edges live here far more often
than in RSI.

### Outcome
| Column | Meaning |
| :--- | :--- |
| `flipped` | 1 if the `:58` gate rejected it |
| `executed` | 1 if it became a real logged trade |
| `settled` | 1 once the outcome is known |
| `entryTick` | Price at rollover (live convention) |
| `entryOpen` | Traded candle's open (backtest convention) |
| `exitClose`, `nextHigh`, `nextLow` | Traded candle's OHLC |
| `nextDir` | `UP` / `DOWN` / `FLAT` |
| `resolvedTs` | When settlement was written |

## First questions to ask the data

Once a few thousand settled rows exist:

1. **Per-component lift.** For each of the five components in isolation, what is
   the hit rate when it fires versus the base rate? Any component at ~50% is
   contributing noise and its weight is unearned.
2. **Does the score rank?** Bucket by `rawCall`/`rawPut` and plot hit rate per
   bucket. If 4.5 does not beat 3.0, the scoring is not ordering setups.
3. **Is the flip gate earning its keep?** Compare `flipped=1` rows against
   `flipped=0`. If the rejects would have won at the same rate, the gate is
   costing trades for nothing.
4. **Forming vs closed bars.** `trend15` against `trend15Closed` on the same
   rows — a direct A/B that needs no code change to run.
5. **Regime split.** Hit rate by `atrPct` quartile and by `minuteOfDay`.
6. **OTC vs real.** Never pool them. The broker generates the OTC feed and is
   your counterparty on it; an edge on one says nothing about the other.

## Privacy

Everything stays in the browser's local IndexedDB. Nothing is transmitted, and
the extension holds no network permissions.
