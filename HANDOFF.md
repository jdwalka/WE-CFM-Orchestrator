# Handoff State: WE-CFM-Orchestrator Refactoring

**Previous Session ID:** `4c50e401-5bad-4a47-9dc2-e3a5b2555526`
**Artifacts Directory:** `C:\Users\gitgo\.gemini\antigravity-ide\brain\4c50e401-5bad-4a47-9dc2-e3a5b2555526`

## What Was Accomplished
1. **Dockerized Nginx CORS Proxy:** Added Nginx to `docker-compose.yml` to run locally on port 8080.
2. **Proxy Orchestrator Integration:** Modified `ProxyOrchestrator.fetch` in `src/infra/proxy-orchestrator.js` to automatically rewrite URLs for Kalshi, CoinGecko, and Coinbase to route through `localhost:8080`.
3. **Data Extraction:** Extracted hardcoded data from `src/kalshi/cloud-data-loader.js` into external JSON files.
4. **Architecture Scaffolding:** Created sub-directories for `src/core/predictions/` and `src/core/app/`.

## What Needs to be Done Next
1. **Refactor `predictions.js` (7,500 lines):** This file cannot be split blindly because ~38 Python and JS quant scripts use regular expressions to parse its hardcoded weights blocks. **A new strategy is needed to decouple the script dependencies before splitting the monolith.**
2. **Refactor `app-core.js` (4,800 lines):** Continue breaking this down into the `src/core/app/` directory.

## Testing Instructions
- Turn **OFF** Tailscale.
- Make sure `docker-compose up -d cors-proxy` is running.
- Run the Electron app and verify that network requests to Binance/Kalshi/CoinGecko are succeeding with near zero latency and no CORS errors.
