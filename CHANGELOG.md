# Changelog

## 1.2.6-analysis (Current)
Status: TESTING

### Added
- Passive WebSocket eavesdropper to capture visible 1m historical candles instantly upon asset load.
- Tab-scoped `sessionStorage` cache: preserves candle history and asset state across page reloads (F5) and automatically purges when the tab is closed.
- Asset switch auto-reset: completely clears candidate pools upon switching assets, binding to the new asset within 1–2 seconds.
- 15m and 5m derived multi-timeframe candle generation with immediate S/R and trend calculation.

### Preserved
- 100% read-only safety guardrail (no trades executed or automated).
- WebGL texture price streaming.
- 10-asset in-memory LRU cache.
