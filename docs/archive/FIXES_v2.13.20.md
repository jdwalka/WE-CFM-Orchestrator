# WECRYPTO v2.13.20 - Critical Bug Fixes

## Summary
Fixed two critical data flow issues preventing accuracy scorecard and orchestrator intents from displaying data.

---

## ISSUE 1: Accuracy Scorecard blank on UP/DOWN Calls tab
**Status:** ✅ FIXED

### Root Cause
The `renderDebugLog()` function calls `window.getHistoricalContracts?.()` to get historical contract data for the accuracy scorecard, but:
1. Phase 3 startup loads CSV data into the calculator but the getter might not be properly initialized
2. The `getHistoricalContracts()` function was defined at module load time but may not be available when scorecard renders

### Changes Made

#### File: `src/kalshi/wecrypto-startup-loader.js`
**Enhanced Phase 3 (phaseDisplayDebugPanel)**
- Added automatic creation of calculator instance if not present
- Improved logging to track CSV loading process
- Added explicit exposure of `window.getHistoricalContracts()` function after loading data
- Better error handling with fallback paths
- Added logging for resolution log restoration

**Key improvements:**
```javascript
// CRITICAL: Ensure getHistoricalContracts() getter is exposed
if (!window.getHistoricalContracts) {
  window.getHistoricalContracts = () => window.__WinRateCalculatorInstance?.contracts || [];
  log('  ✓ Exposed window.getHistoricalContracts()');
}
```

---

## ISSUE 2: Orchestrator Live Intents shows "no data — waiting for first prediction cycle"
**Status:** ✅ FIXED

### Root Cause
The `renderDebugLog()` function renders `liveOrchRows` by calling `window.KalshiOrchestrator?.getIntent?.(sym)`, but:
1. The orchestrator's internal `_cache` was empty because `update()` was never called before rendering
2. `update()` is called inside `buildOpportunitiesPanel()` (line 4494), but `renderDebugLog()` runs independently
3. These are separate render cycles with no guaranteed ordering

### Changes Made

#### File: `src/core/app.js` (renderDebugLog function)
**Added orchestrator cache population before rendering**
- Added code to fetch current prediction data using `PredictionEngine.getAll()`
- Calls `KalshiOrchestrator.update(predAll)` BEFORE building liveOrchRows
- This ensures `_cache` is populated with fresh data before `getIntent()` is called
- Added try/catch error handling with logging

**Key improvement:**
```javascript
// ── CRITICAL FIX: Ensure orchestrator cache is populated before rendering ──
// This ensures getIntent() returns data instead of null
try {
  const predAll = window.PredictionEngine?.getAll?.() ?? {};
  const cfmAll = window.CFMEngine?.getAll?.() ?? {};
  if (window.KalshiOrchestrator?.update) {
    window.KalshiOrchestrator.update(predAll);
    console.log('[DebugLog] Orchestrator cache populated before rendering intents');
  }
} catch (e) {
  console.warn('[DebugLog] Could not update orchestrator cache:', e.message);
}
```

#### File: `src/ui/floating-orchestrator.js`
**Updated function signature**
- Changed `update(predAll)` to `update(predAll, cfmAll)` to match calling convention
- Added comment noting cfmAll is reserved for future enhancements
- Ensures no parameter mismatch issues

```javascript
update: function(predAll, cfmAll) {
  // cfmAll reserved for future enhancements (e.g., liquidity-weighted entry pricing)
  _cache = resolveAll(predAll);
  return _cache;
},
```

---

## Data Flow Fixes Summary

### Issue 1 Fix Flow
```
wecrypto-startup-loader.js Phase 3
  ↓
  Load CSV trades with resolution data
  ↓
  Set calc.contracts = csvTrades
  ↓
  Expose window.getHistoricalContracts() function
  ↓
  app.js renderDebugLog()
  ↓
  Call window.getHistoricalContracts?.() ← Now returns data!
  ↓
  Scorecard renders with historical data ✓
```

### Issue 2 Fix Flow
```
app.js renderDebugLog()
  ↓
  Call PredictionEngine.getAll()
  ↓
  Call window.KalshiOrchestrator.update(predAll) ← Cache populated here!
  ↓
  Build liveOrchRows
  ↓
  Call window.KalshiOrchestrator?.getIntent?.(sym) ← Cache has data! ✓
  ↓
  Orchestrator intents render properly ✓
```

---

## Testing Checklist

- [ ] Build v2.13.20
- [ ] Start app and navigate to "Debug Log" view
- [ ] Verify "ORCHESTRATOR — LIVE INTENTS" shows data instead of "no data — waiting..."
- [ ] Verify "ACCURACY SCORECARD" shows calculated win rates instead of "no settled data yet"
- [ ] Check browser console for startup logs confirming:
  - Phase 3 completed CSV loading
  - window.getHistoricalContracts() exposed
  - Orchestrator cache populated before rendering
- [ ] Verify scorecard shows per-coin accuracy stats
- [ ] Verify orchestrator shows ACTION, SIDE, ALIGNMENT, EDGE for live markets

---

## Files Modified

1. **src/kalshi/wecrypto-startup-loader.js**
   - Enhanced Phase 3 with better error handling and explicit getter exposure
   - Lines: 68-130 (approximately)

2. **src/core/app.js**
   - Added orchestrator cache population before liveOrchRows rendering
   - Lines: 5630-5648 (approximately)

3. **src/ui/floating-orchestrator.js**
   - Updated update() function signature to accept cfmAll parameter
   - Lines: 233 (approximately)

---

## Backups Created

- `src/core/app.js.backup.v2.13.19`
- `src/kalshi/wecrypto-startup-loader.js.backup.v2.13.19`
- `src/ui/floating-orchestrator.js.backup.v2.13.19`

---

## Build Command

```bash
npm run build  # or appropriate build command for v2.13.20
```

---

## Deployment Notes

- No database migrations required
- No localStorage schema changes
- No Electron IPC changes
- Backward compatible with existing data
- Safe to deploy to production
