# Executable Versions - Feature Comparison

**Generated:** 2026-05-01  
**Current Latest:** v2.13.0-scorecard-integration

---

## Version 2.13.0 - Scorecard Integration ✅ CURRENT

**File:** WECRYPTO-v2.13.0-scorecard-integration-portable.exe (86.7 MB)  
**Status:** ✅ CURRENT BUILD (Just created)

### Includes Everything From v2.12.0 PLUS:

**NEW in 2.13.0:**
- ✅ Scorecard integration: predictions/settlements/errors captured
- ✅ 4 recording points wired into app.js
- ✅ Console commands: printReport(), getAccuracy(), exportCSV()
- ✅ Auto-correlation of predictions to outcomes
- ✅ Error tracking with context

**From v2.12.0 (LLM-Weaponized):**
- ✅ **LLM Adaptive Engine** - Full AI-driven signal tuning
- ✅ **LLM Signal Layer** - Specialized prompt for 9 indicators
- ✅ **Adaptive Learning** - Real-time weight adjustment
- ✅ **Anomaly Detection** - AI health monitoring
- ✅ **Real-Time Tuning** - 30-second polling with rapid decisions
- ✅ **Kalshi Integration** - Market probability analysis
- ✅ **Multi-Indicator System** - RSI, MACD, CCI, Fisher, ADX, ATR, Order Book, Kalshi %, Crowd Fade

### Console Commands Available

**Scorecard:**
```javascript
window._aggregator.printReport()           // Accuracy report
window._aggregator.getAccuracy()           // Per-coin stats
window._aggregator.exportCSV()             // Export for analysis
await window._aggregator.diagnoseSettlementData()  // Health check
```

**LLM/Adaptive Engine:**
```javascript
window._adaptiveTuner.getStatus()          // Engine status
window._adaptiveTuner.getTuningHistory()   // Recent tuning
window._adaptiveTuner.getDiagnostics()     // Full diagnostics
window._adaptiveTuner.printReport()        // Detailed report
```

**Real-Time Monitoring:**
```javascript
window._adaptiveTuner.getRealtimeStatus()  // 30s polling status
window._adaptiveTuner.getRealtimeUpdate()  // Last 30s decisions
window._adaptiveTuner.getTuningStatus()    // All metrics
```

---

## Version 2.12.0 - LLM Weaponized ✅ INCLUDED IN 2.13.0

**File:** WECRYPTO-v2.12.0-llm-weaponized-portable.exe (86.7 MB)  
**Status:** ✅ Available (Previous version, included in 2.13.0)

### LLM Layer Components

**1. Adaptive Learning Engine** (`src/core/adaptive-learning-engine.js`)
- ✅ Integrated with app.js
- ✅ Auto-initialized on startup
- ✅ 30-second polling enabled
- ✅ Real-time weight tuning active

**2. Real-Time Tuner** (`src/core/realtime-tuner.js`)
- ✅ 30-second polling on predictions
- ✅ 60-second rolling analysis windows
- ✅ Rapid gate adjustments (±4-8%)
- ✅ Micro-weight adjustments (±8-15%)
- ✅ Failure spike detection
- ✅ Exponential backoff on errors

**3. LLM Signal Layer** (`src/core/llm-signal-applier.js`)
- ✅ Specialized prompts for 9 indicators
- ✅ Real-time signal interpretation
- ✅ Confidence scoring
- ✅ Anomaly detection built-in

**4. Adaptive Learning Integration**
- ✅ Per-coin accuracy tracking
- ✅ Per-indicator weight targets
- ✅ Regime detection (bull, bear, chop)
- ✅ Volatility-aware adjustments
- ✅ Trade flow analysis

---

## Feature Matrix: What's Enabled

| Feature | v2.12.0 (LLM) | v2.13.0 (Scorecard+LLM) |
|---------|---|---|
| **Prediction Engine** | ✅ | ✅ |
| **LLM Adaptive Layer** | ✅ | ✅ (INHERITED) |
| **Real-Time Tuning (30s)** | ✅ | ✅ (INHERITED) |
| **Kalshi Integration** | ✅ | ✅ (INHERITED) |
| **Multi-Indicator Analysis** | ✅ | ✅ (INHERITED) |
| **Anomaly Detection** | ✅ | ✅ (INHERITED) |
| **Scorecard System** | ❌ | ✅ (NEW) |
| **Settlement Tracking** | ❌ | ✅ (NEW) |
| **Error Logging** | ❌ | ✅ (NEW) |
| **Accuracy Reports** | ❌ | ✅ (NEW) |
| **CSV Export** | ❌ | ✅ (NEW) |

---

## What's Inside v2.13.0

### LLM Components (From v2.12.0)
✅ `src/core/adaptive-learning-engine.js` - AI tuning engine  
✅ `src/core/realtime-tuner.js` - 30-second polling  
✅ `src/core/llm-signal-applier.js` - LLM signal interpretation  
✅ `src/core/anomaly-detector.js` - Health monitoring  
✅ `src/core/metrics-builder.js` - Performance tracking  

### Scorecard Components (New in v2.13.0)
✅ `src/kalshi/scorecard-data-aggregator.js` - Recording & correlation  
✅ `src/kalshi/accuracy-scorecard-comprehensive.js` - Diagnostics  
✅ Integration points in app.js (4 locations)  
✅ Browser console tools for debugging  

### Data Modules
✅ `src/kalshi/` - Kalshi API integration  
✅ `src/core/predictions.js` - Signal generation  
✅ `src/exchange/` - Exchange connectors  

---

## Initialization Flow (v2.13.0)

```
App Startup
    ↓
Load index.html
    ↓
├─ Load adaptive-learning-engine.js ✅ LLM active
├─ Load scorecard-data-aggregator.js ✅ Scorecard active
└─ Load accuracy-scorecard-comprehensive.js ✅ Diagnostics active
    ↓
Initialize window objects:
├─ window._adaptiveTuner (LLM engine)
├─ window._aggregator (Scorecard recorder)
└─ window._accuracyScorecard (Diagnostics)
    ↓
Start prediction loop (every 15m)
    ↓
├─ Generate signal (predictions.js)
├─ Record prediction (scorecard) ✅ NEW
├─ Apply LLM tuning (adaptive engine) ✅ EXISTING
└─ Poll real-time data (30s cycle) ✅ EXISTING
    ↓
Wait for settlement (Kalshi API)
    ↓
├─ Record settlement (scorecard) ✅ NEW
├─ Compare to prediction
└─ Update accuracy metrics (scorecard) ✅ NEW
    ↓
Update LLM engine weights (both systems work together) ✅
```

---

## You're Getting

### From v2.12.0-llm-weaponized:
1. **LLM-driven signal tuning**
   - AI interprets 9 technical indicators
   - Real-time weight adjustments
   - Anomaly detection & alerts

2. **Adaptive learning system**
   - Learns from prediction accuracy
   - Adjusts gates & weights per coin
   - Volatility-aware tuning

3. **Real-time polling (30 seconds)**
   - Fast market response
   - Rapid decision making
   - Micro-adjustments for whipsaws

### From v2.13.0-scorecard-integration (NEW):
1. **Complete prediction tracking**
   - Every prediction recorded
   - Full audit trail
   - CSV export capability

2. **Automatic settlement matching**
   - Outcomes linked to predictions
   - Per-coin accuracy calculated
   - Error tracking & diagnostics

3. **Console debugging tools**
   - View accuracy reports
   - Export data for analysis
   - 5-stage health diagnostics

---

## Verification: LLM is Active in v2.13.0

**Check 1: Adaptive Engine Initialization**
```javascript
window._adaptiveTuner  // Should be defined
// Output: AdaptiveTuner { realtimeTuner: {...}, ... }
```

**Check 2: Real-Time Polling Status**
```javascript
window._adaptiveTuner.getRealtimeStatus()
// Output: { active: true, lastPoll: 1714520..., cycleMs: 30000, ... }
```

**Check 3: Tuning Metrics**
```javascript
window._adaptiveTuner.getTuningStatus()
// Output: { btc: { accuracy: 0.63, confidence: 0.85, ... }, ... }
```

**Check 4: Scorecard Active**
```javascript
window._aggregator  // Should be defined
// Output: ScorecardDataAggregator { predictions: [...], settlements: [...], ... }
```

---

## Recommendation

**Use v2.13.0-scorecard-integration** because:

✅ **Has everything from v2.12.0** (LLM layer is fully included)  
✅ **Plus new scorecard features** (predictions/settlements/errors)  
✅ **Zero degradation** (just added, nothing removed)  
✅ **Better debugging** (full audit trail for accuracy issues)  
✅ **No version conflicts** (both systems integrated seamlessly)  

**There is no trade-off.** v2.13.0 is a pure superset of v2.12.0.

---

## Quick Comparison: Which Exe to Use?

| Need | Version |
|------|---------|
| Just LLM adaptive tuning | v2.12.0-llm-weaponized |
| LLM + Scorecard tracking | **v2.13.0-scorecard-integration** ✅ |
| Rollback to stable | v2.11.0-realtime-corrections |

**Recommendation:** Use v2.13.0 - it's the complete system with both LLM and scorecard.

---

## Build Timeline

```
v2.11.0 (Real-Time Corrections)
    ↓
v2.12.0 (LLM Weaponized) ← LLM layer added
    ↓
v2.13.0 (Scorecard Integration) ← Scorecard + LLM
```

Each version is cumulative. v2.13.0 includes everything from prior versions plus new scorecard features.

---

## Summary

**YES - The LLM layer IS integrated into the .exe**

✅ **v2.13.0** includes the complete LLM adaptive engine from v2.12.0  
✅ **PLUS** new scorecard integration  
✅ **Both systems** working together  
✅ **Production ready** - ready for staging/production deployment  

**Console Commands Available:**
- LLM: `window._adaptiveTuner.getStatus()`
- Scorecard: `window._aggregator.printReport()`
- Both: `window._adaptiveTuner.getTuningStatus()`
