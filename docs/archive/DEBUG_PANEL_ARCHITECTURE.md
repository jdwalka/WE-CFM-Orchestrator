# WECRYPTO Debug Panel & Calibration Persistence

**Problem Solved**: App no longer needs to wait 1+ hour on restart to recalculate calibration. Historical contract data and win rates are cached and restored in <100ms.

## Architecture

### 4-Phase Startup Sequence

```
[STARTUP] ─────────────────────────────────────────
Phase 1: Restore Calibration (cache)      [<50ms]
Phase 2: Load Historical Contracts (cache) [<50ms]
Phase 3: Display Debug Panel (UI)         [<10ms]
────────────────────────────────────────── [<110ms] ✓ APP READY
Phase 4: Background Refresh (async)    [non-blocking]
```

### Key Modules

#### 1. **AdaptiveWeightRestorer** (`adaptive-weight-restorer.js`)
- **On app start**: Loads cached weights in <10ms
- **Restores to**: AdaptiveLearner (if loaded)
- **Source cascade**: localStorage → Electron cache → fresh (first run)
- **Auto-caches**: Saves current weights to localStorage every 5 minutes

#### 2. **ContractWinRateCalculator** (`contract-win-rate-calculator.js`)
- **Fast load**: `initializeFast()` restores cached stats in <10ms
- **Background update**: `updateInBackground()` fetches new contracts async, doesn't block
- **Storage**: Persists to both localStorage and Electron multi-drive cache
- **Events**: Broadcasts `contract:statsUpdated` for UI listeners

#### 3. **Kalshi IPC Bridge** (`electron/kalshi-ipc-bridge.js`)
- **`storage:readContractCache`**: Reads from multi-drive cascade (F:, D:, network)
- **`storage:writeContractCache`**: Writes to first available drive
- **`storage:getContractStats`**: Calculates win rates from cached contracts

#### 4. **Debug Panel** (`adaptive-debug-panel.js`)
- **Historical Section**: Shows past performance per coin (BTC, ETH, SOL, XRP)
- **Win Rate Display**: Color-coded (green >50%, red <50%)
- **Event Listener**: Updates on `contract:statsUpdated` event
- **Instant Display**: Uses cached data immediately on startup

#### 5. **Startup Loader** (`wecrypto-startup-loader.js`)
- **Orchestrates**: All 4 phases in sequence
- **Non-blocking**: Phase 4 (background) doesn't delay app readiness
- **Logging**: Exposes startup timeline at `window.__STARTUP_LOG`
- **Events**: Fires `wecrypto:startupComplete` / `wecrypto:startupFailed`

---

## Data Flow

### On App Start
```
localStorage ──┐
               ├─→ AdaptiveWeightRestorer ──→ Restored Weights
Electron Cache ┘                                ↓
                                            Immediately Applied
                                                to AdaptiveLearner
                                                (calibration active!)
                    ┌─────────────────────────────────────────┐
                    │ Background (async, non-blocking)        │
                    │ HistoricalSettlementFetcher + API       │
                    │ → Updates localStorage + Electron cache │
                    │ → Broadcasts contract:statsUpdated      │
                    │ → Debug panel refreshes (if UI ready)   │
                    └─────────────────────────────────────────┘
```

### On Contract Settlement (Kalshi API)
```
Kalshi Trade Resolved
  ↓
accuracy-debug.js detects outcome
  ↓
Compares: model prediction vs actual
  ↓
Broadcasts: contract:statsUpdated
  ↓
ContractWinRateCalculator updates cache
  ↓
Debug panel shows new historical data
  ↓
Every 5min: Weights cached for next restart
```

---

## Integration Checklist

### Load Order (in HTML/preload)
1. **Core Modules** (must load first)
   - `adaptive-weight-restorer.js` — restores weights at <100ms
   - `contract-win-rate-calculator.js` — provides cache interface
   - `kalshi-ipc-bridge.js` — handles multi-drive storage (main process)

2. **UI Modules** (can load anytime)
   - `adaptive-debug-panel.js` — listens for cached data
   - `accuracy-debug.js` — provides debug commands (KalshiAccuracyDebug.*)

3. **Startup Orchestration** (load last)
   - `wecrypto-startup-loader.js` — runs 4-phase sequence automatically

### Electron Main Process
```javascript
// In electron/main.js after app ready:
const { startKalshiWorker, stopKalshiWorker } = require('./kalshi-ipc-bridge.js');

// IPC handlers are auto-registered when kalshi-ipc-bridge.js loads:
// - storage:readContractCache
// - storage:writeContractCache
// - storage:getContractStats
```

### Preload Script
```javascript
// In we-crypto-electron/preload.js:
contextBridge.exposeInMainWorld('electron', {
  invoke: ipcRenderer.invoke,  // Enable IPC calls from renderer
});
```

---

## Console Commands (for debugging)

```javascript
// Check startup status
window.__WECRYPTO_STARTUP.getLog()

// Manually trigger background refresh
window.ContractWinRateCalculator?.updateInBackground()

// View current weights
window.AdaptiveLearner?.getSymbolWeights?.('BTC')

// View historical accuracy
window.KalshiAccuracyDebug?.scorecard('BTC')

// Export accuracy data
window.KalshiAccuracyDebug?.exportCSV()
```

---

## Performance Targets

| Phase | Duration | Blocking? |
|-------|----------|-----------|
| Restore weights | <50ms | Yes (fast) |
| Load cache | <50ms | Yes (fast) |
| Display UI | <10ms | Yes |
| **Total startup** | **<110ms** | **Unblocked** |
| Background refresh | 2-10s | No |

---

## Multi-Drive Storage Cascade

Contracts and stats are written to **first available**:
1. `F:\WECRYP\data\contract-cache.json` (primary - external drive)
2. `D:\WECRYP\data\contract-cache.json` (secondary - backup drive)
3. Electron network mounts (Z:, Y:, X:)
4. Windows AppData fallback

**Read**: Tries all locations, returns first match

---

## What This Fixes

✅ **No 1-hour recalculation** on app restart
✅ **Calibration persists** across sessions
✅ **Weights restored** in <100ms (app immediately ready)
✅ **Historical data** populates debug panel instantly
✅ **Background refresh** updates without blocking
✅ **Multi-drive support** for cascading storage

---

## Next Steps (Optional Enhancements)

- [ ] Store per-timeframe accuracy (15m vs 1h windows)
- [ ] Version cache files with rolling 30-day history
- [ ] Calculate confidence intervals for weight adjustments
- [ ] Alert when historical accuracy drops >10% in last hour
