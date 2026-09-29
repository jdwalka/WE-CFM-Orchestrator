# WECRYPTO Cross-Chain Orbital Engine

Native JS modules wired into the existing Electron 15m signal pipeline.

## Files

- `src/orbital/orbital-engine.js` — `WecryptoCrossChain`-style engine (s/p/d/f orbitals, OEQ with auto-scaled lambda, hybrid trailing stop + ground state decay exits).
- `src/orbital/kalshi-v2-mapper.js` — Pure Kalshi V2 payload builder with strict fixed-point strings (count 2dp, price 4dp), uuid `client_order_id`, `time_in_force: immediate_or_cancel`.
- `scripts/orbital-engine-smoke.js` — No-network smoke test.

## Integration points (additive, no behavior overrides)

- `src/core/predictions.js` — after `signalGate` diagnostics, calls `OrbitalEngine.processInterval(sym, cache.candles15m)` and attaches `result.orbital` + `result.diagnostics.orbital`.
- `src/ui/floating-orchestrator.js` — in `translate()`, mirrors `pred.orbital` onto the intent, builds `orbitalHint`, appends to `humanReason`, generates optional `KalshiV2Mapper` payload preview, and mirrors via `window.desktopApp.telemetryRecord` when available.
- `public/index.html` — loads both new scripts alongside `shell-router.js` and `signal-router-cfm.js`.

## Feature flags / env vars

- `WECRYP_ORBITAL_ENGINE_ENABLED` (default **true**) — gates orbital diagnostics.
- `WECRYP_KALSHI_V2_SUBMIT_ENABLED` (default **false**, dry-run) — gates live order submission inside `KalshiV2Mapper.submitIfEnabled()`.

These can be set via `process.env` (Electron main) or `window.__env` (renderer overrides).

## Side mapping

Orbital `pDelta` drives the Kalshi V2 leg:

- `pDelta > 0` → fade up: `side="yes"`, `action="sell"`
- `pDelta < 0` → buy YES: `side="yes"`, `action="buy"`

## Lambda

Recalibrated at boot and on demand via `window.OrbitalEngine.reinitLambdas(historyMap?)`. Uses local 15m close history (per-asset) and falls back to per-asset defaults when no sigma source is available. Never recomputed every 15m cycle.

## Run smoke test

```bash
node scripts/orbital-engine-smoke.js
```

## Validate without booting Electron

```bash
node --check src/orbital/orbital-engine.js
node --check src/orbital/kalshi-v2-mapper.js
node --check src/core/predictions.js
node --check src/ui/floating-orchestrator.js
node scripts/verify-15m-pipeline.js
```

## Follow-up wiring suggestions

- Replace placeholder ticker passed to the mapper with the live ticker from `window.PredictionMarkets.getCoin(sym).kalshi15m.ticker` (already partially used).
- Wire `KalshiV2Mapper.submitIfEnabled(payload, transport)` to an existing Kalshi REST or WS client (`src/kalshi/kalshi-rest.js` / `src/kalshi/kalshi-client.js`) inside a feature-flagged code path. Never enable submission without explicit env opt-in.
- Forward `result.orbital` to Firebase/Drive telemetry by adding an `orbital-intent` handler on the desktop bridge (`window.desktopApp.telemetryRecord` consumer) — the renderer already emits the events when the bridge exists.
