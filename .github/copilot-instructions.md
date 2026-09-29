# Copilot Instructions for WE-CRYPTO

## Build, test, and run

- Install dependencies: `npm install`
- Start the Electron app: `npm start` or `npm run start:dev`
- Build a portable app: `npm run build:portable`
- Build an installer: `npm run build:installer`
- Release builds run preflight checks first: `npm run build:portable:release` or `npm run build:installer:release`

### Tests

- Full integration cycle: `node test-integration.js`
- Signal correctness audit: `node test-signal-logic-audit.js`
- Real-time tuning: `node test-realtime-tuner.js`
- Snapshot tuning: `node test-snapshot-tuner.js`
- Focused single test: `node test-signal-inversion.js`
- Live proxy-backed checks: `node tests/test-live-feeds.js` and `node tests/test-api-status.js` after `npm start`

## High-level architecture

- This is an Electron desktop app. `electron/main.js` boots the BrowserWindow, proxy/worker services, and optional web mirror; `electron/preload.js` exposes the safe renderer bridge.
- The renderer is not a modern module app. `public/index.html` is a script-load dependency graph, and `src/core/app.js` is the composition layer that runs last.
- Prediction data flows from external APIs through the local proxy/throttled fetch layer into `src/core/predictions.js`, then into adaptive tuning, trade-intent logic, and the UI.
- `src/kalshi/prediction-markets.js` caches Kalshi + Polymarket data, while the learning loop recalibrates on a 30-second cycle with weight updates every 2 minutes.

## Key conventions

- Use `window.*` globals and IIFEs for cross-module renderer code; avoid ES module imports between renderer scripts.
- Preserve `public/index.html` script order. Startup/calibration modules must load before `src/core/app.js`.
- The canonical coin universe is fixed: `BTC, ETH, SOL, XRP, DOGE, BNB, HYPE`.
- Persist app state with the `beta1_*` localStorage namespace only.
- Reuse existing proxy/fetch wrappers before adding direct network calls.
- Keep build artifacts in `dist/` and do not overwrite existing `.exe` outputs.
- For deep domain work, prefer the repo-specific agents in `.github/AGENTS.md` and `.github/agents/`.

## Refer to these docs when changing related areas

- `docs/ARCHITECTURE.md`
- `docs/SIGNALS.md`
- `docs/LEARNING-ENGINE.md`
- `docs/CONFIGURATION.md`
- `docs/TESTING.md`
