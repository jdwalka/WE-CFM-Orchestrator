# Handoff State: WE-CFM-Orchestrator Refactoring

**Previous Session ID:** `4c50e401-5bad-4a47-9dc2-e3a5b2555526`

## What Was Accomplished

1. **Dockerized Nginx CORS Proxy:** Added Nginx to `docker-compose.yml` on port 8080.
2. **Proxy Orchestrator Integration:** `ProxyOrchestrator.fetch` rewrites Kalshi/CoinGecko/Coinbase URLs to route through `localhost:8080`.
3. **Data Extraction:** Hardcoded data extracted from `src/kalshi/cloud-data-loader.js` into external JSON files.
4. **Architecture Scaffolding:** Created `src/core/predictions/` (10 files) and `src/core/app/` (4 files).
5. **Predictions.js Weight Decoupling (COMPLETE):**
   - `src/core/predictions-weights.json` is canonical source for `COMPOSITE_WEIGHTS`, `REGIME_WEIGHT_MULTS`, `PER_COIN_INDICATOR_BIAS`.
   - `scripts/extract-weights.js` bootstraps JSON from JS sources.
   - `scripts/sync-weights.js` → propagates JSON to `predictions.js`, `regime-weights.js`, `backtest-runner.js`, `walk-forward-backtest.js`. Run via `npm run weights:sync`.
   - `backtest/outcome-retuner.js`, `backtest/ga-agent-swarm.js`, `backtest/regime-sweep.js` — all fixed to R/W JSON instead of regex-patching JS source.
6. **predictions.js Monolith Split (COMPLETE — 6,088 lines, down from ~7,500):**
   - All scaffold files loaded in `public/index.html` before `predictions.js`.
   - `predictions.js` now imports from 6 window namespaces at the top of its IIFE:
     - `window.PredictionKalshiLogic` — Kalshi boundary/settlement helpers
     - `window.PredictionMicrostructure` — live book/candle analysis
     - `window.PredictionRegimeWeights` — REGIME_WEIGHT_MULTS + online weight overlays
     - `window.PredictionSignalGates` — evaluateSignalGate + SIGNAL_GATE config
     - `window.PREDICTIONS_KALSHI_ROUTING` — normalCDF, buildRationale, buildExecutionGuard, getSecsToKalshiClose
     - `window.PREDICTIONS_DATA_FETCHERS` — all 30+ exchange fetch functions (CDC, Binance, MEXC, Bybit, Kucoin, Bitfinex, Kraken, Coinbase, Gecko, bucketCandles, anchoredPoolCandles)
   - Removed inline: CDC circuit-breaker cluster, fetchAnalyticsWithRoute, fetchFearGreed, all DATA FETCHING section (~1,412 lines total).
   - Retained inline: `wait()`, `withSoftTimeout()` (used below by loadCoinData/scoring), `loadCoinData()`, `enrichCoinDataBackground()`, `preservePredictionOverlay()`.
   - `scripts/strip-data-fetching.js` — automated transform script, re-runnable if needed.
7. **app-core.js Refactor (COMPLETE):** 490 lines (down from ~4,800). All heavy lifting in `src/core/app/` scaffold.

## Remaining Work (Lower Priority)

1. **`CDC_TRANSIENT_STATUS` in predictions.js** (line 61) — still defined but orphaned. The CDC fetch functions that consumed it were removed. Safe to delete if desired.
2. **Unused imports in predictions.js** — `fetchWithTimeout` and `fetchGeckoCandles` are imported but never directly called in predictions.js (they're called internally by data-fetchers.js functions). No functional impact; may produce linting warnings.
3. **`signal-aggregation.js` is redundant** — exports `evaluateSignalGate` and `CLOSE_WINDOW_GUARD_SECS` which are already in `signal-gates.js`. No impact; loaded in index.html harmlessly.

## Testing Instructions

- Turn **OFF** Tailscale.
- Make sure `docker-compose up -d cors-proxy` is running.
- Run the Electron app and verify network requests to Binance/Kalshi/CoinGecko succeed.
- After any backtest tuning pass: `npm run weights:sync` to propagate updated weights to all JS files.
- To re-extract weights from JS source: `npm run weights:extract`.
