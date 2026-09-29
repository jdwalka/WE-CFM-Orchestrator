# 🎓 Adaptive Learning Engine Deep Dive

Complete technical guide to how WE-CRYPTO learns and improves automatically.

---

## Overview

The adaptive learning engine is the **heart of WE-CRYPTO**. Instead of static signal weights, it:

1. **Measures** accuracy of each signal in real-time
2. **Identifies** which signals work best per coin
3. **Tunes** weights automatically every 2 minutes
4. **Accelerates** tuning if trends detected
5. **Maintains** audit trail for debugging

Result: **Continuously improving predictions** that adapt to market conditions.

---

## Architecture

### Three-Tier Learning System

```
Tier 1: Real-Time Accuracy Tracking (Every 30 seconds)
  └─ Fetch settled contracts
  └─ Calculate signal accuracy per coin
  └─ Store in window._historicalScorecard

Tier 2: Signal Accuracy Aggregation (Sliding window)
  └─ Maintain last 20 contracts per signal per coin
  └─ Calculate rolling accuracy percentage
  └─ Detect trending (improving vs degrading)

Tier 3: Automatic Weight Tuning (Every 120 seconds)
  └─ Evaluate each signal's accuracy
  └─ Apply boost/reduce/hold rules
  └─ Detect trends and apply acceleration
  └─ Update weights in window._adaptiveWeights
  └─ Log to audit trail
```

---

## Tier 1: Real-Time Accuracy Tracking

### How It Works

Every 30 seconds, the system:

```javascript
1. Fetch settled contracts from 3 sources
   ├─ Kalshi: /markets?status=settled
   ├─ Polymarket: Resolved markets
   └─ Coinbase: Settled predictions

2. For each settled contract:
   ├─ Get model's prediction (UP or DOWN)
   ├─ Get actual market outcome (YES or NO)
   └─ Record: prediction == outcome? (HIT or MISS)

3. Calculate per-coin accuracy:
   ├─ BTC: 24 / 42 contracts = 57% ✅
   ├─ ETH: 19 / 36 contracts = 53% ✅
   └─ SOL: 21 / 35 contracts = 60% ✅

4. Store in window._historicalScorecard:
   {
     timestamp: Date.now(),
     totalSettled: 113,
     scorecard: {
       BTC: { accuracy: 0.57, count: 42, wins: 24 },
       ETH: { accuracy: 0.53, count: 36, wins: 19 },
       SOL: { accuracy: 0.60, count: 35, wins: 21 }
     },
     sources: ['kalshi', 'polymarket', 'coinbase']
   }
```

### Console Check

```javascript
// View current scorecard
window._historicalScorecard

// Output:
{
  timestamp: 1714598400000,
  totalSettled: 113,
  scorecard: {
    BTC: { accuracy: 0.57, count: 42, wins: 24 },
    ETH: { accuracy: 0.53, count: 36, wins: 19 },
    SOL: { accuracy: 0.60, count: 35, wins: 21 }
  }
}
```

---

## Tier 2: Signal Accuracy Aggregation

### Sliding Window Tracking

For each signal, maintain accuracy over last 20 contracts:

```
Signal: RSI
Coin: BTC

Contract 1: BTC prediction UP,  actual UP   → HIT (1/1 = 100%)
Contract 2: BTC prediction UP,  actual DOWN → MISS (1/2 = 50%)
Contract 3: BTC prediction DOWN, actual UP  → MISS (1/3 = 33%)
...
Contract 20: BTC prediction UP,  actual UP  → HIT (15/20 = 75%)

Per-Signal Accuracy: 75%
```

### Storage

```javascript
// Internal tracking (not exposed)
accuracyHistory = {
  RSI: {
    BTC: [
      { timestamp: t1, accurate: true },
      { timestamp: t2, accurate: false },
      { timestamp: t3, accurate: true },
      // ... 20 entries, oldest removed when new added
    ]
  },
  MACD: { BTC: [...], ETH: [...] },
  CCI: { BTC: [...], ETH: [...] },
  // ... all 9 signals
}
```

### Trending Detection

Compare OLD half vs NEW half of window:

```
Signal: Fisher Transform
Coin: BTC

Old half (contracts 1-10):  12/20 = 60% accurate
New half (contracts 11-20): 18/20 = 90% accurate

Improvement: +30 percentage points
Trend: IMPROVING 📈
Action: Apply acceleration boost (1.5x)
```

---

## Tier 3: Automatic Weight Tuning

### Core Algorithm

```
IF accuracy >= 52%:
   NEW_WEIGHT = current_weight × 1.05
   REASON = "High accuracy detected"

ELSE IF accuracy <= 45%:
   NEW_WEIGHT = current_weight × 0.95
   REASON = "Low accuracy detected"

ELSE (46-51%):
   NEW_WEIGHT = current_weight × 1.00
   REASON = "Neutral accuracy, hold weight"

// Apply trending acceleration
IF trend improving > 5%:
   NEW_WEIGHT = boost_weight × 1.5
   REASON = "Strong improvement trend"

ELSE IF trend degrading > 5%:
   NEW_WEIGHT = reduce_weight × 1.3
   REASON = "Strong degradation trend"

// Apply multiplier caps
IF NEW_WEIGHT > 2.0:
   NEW_WEIGHT = 2.0
ELSE IF NEW_WEIGHT < 0.3:
   NEW_WEIGHT = 0.3

SAVE(NEW_WEIGHT)
```

### Example Tuning Cycle

```javascript
// Time: 14:32:00 UTC
// Starting weights (from last cycle):
currentWeights = {
  RSI: 1.05,
  MACD: 0.95,
  CCI: 1.00,
  Fisher: 1.10,
  // ... others
}

// Collected accuracy data (last 20 contracts per coin per signal):
accuracyData = {
  BTC: {
    RSI: 0.58,      // 58% accurate
    MACD: 0.42,     // 42% accurate
    CCI: 0.50,      // 50% accurate
    Fisher: 0.59,   // 59% accurate (improving from 0.54!)
  },
  ETH: {
    RSI: 0.55,
    MACD: 0.48,
    CCI: 0.52,
    Fisher: 0.53,
  },
  // ... other coins
}

// Trending analysis:
trendData = {
  BTC: {
    RSI: {
      oldHalf: 0.55,
      newHalf: 0.60,
      improvement: +5,    // Slight improvement
      acceleration: 1.0   // No acceleration
    },
    MACD: {
      oldHalf: 0.44,
      newHalf: 0.40,
      degradation: -4,    // Slight degradation
      acceleration: 1.0   // No acceleration
    },
    Fisher: {
      oldHalf: 0.54,
      newHalf: 0.65,
      improvement: +11,   // STRONG improvement!
      acceleration: 1.5   // Apply 1.5x boost
    },
  },
  // ... other coins
}

// === TUNING DECISIONS ===

// BTC RSI: 58% accuracy
if (0.58 >= 0.52) {
  boost = 1.05 * 1.05 * 1.0 = 1.10  // Current (1.05) × 1.05 × trend (1.0)
}
// Result: 1.05 → 1.10 ✅ BOOSTED

// BTC MACD: 42% accuracy
if (0.42 <= 0.45) {
  reduce = 0.95 * 0.95 * 1.0 = 0.90  // Current (0.95) × 0.95 × trend (1.0)
}
// Result: 0.95 → 0.90 ❌ REDUCED

// BTC CCI: 50% accuracy (neutral)
if (0.46 <= 0.50 <= 0.51) {
  hold = 1.00 * 1.00 * 1.0 = 1.00    // No change
}
// Result: 1.00 → 1.00 ⏸️  HELD

// BTC Fisher: 59% accuracy + strong improvement!
if (0.59 >= 0.52) {
  boost = 1.10 * 1.05 * 1.5 = 1.73   // Current (1.10) × 1.05 × trend (1.5)
  capped = min(1.73, 2.0) = 1.73
}
// Result: 1.10 → 1.73 📈 ACCELERATED BOOST

// === FINAL WEIGHTS FOR BTC ===
newWeights = {
  RSI: 1.10,      // 1.05 → 1.10
  MACD: 0.90,     // 0.95 → 0.90
  CCI: 1.00,      // 1.00 → 1.00
  Fisher: 1.73,   // 1.10 → 1.73 (boosted + trending)
  // ... other signals
}

// Save to window
window._adaptiveWeights = newWeights

// Log event
window._lastTuneEvent = {
  timestamp: Date.now(),
  cycle: 847,
  duration_ms: 45,
  changes: [
    { signal: 'RSI', coin: 'BTC', old: 1.05, new: 1.10, reason: 'boosted (58%)' },
    { signal: 'MACD', coin: 'BTC', old: 0.95, new: 0.90, reason: 'reduced (42%)' },
    { signal: 'CCI', coin: 'BTC', old: 1.00, new: 1.00, reason: 'held (50%)' },
    { signal: 'Fisher', coin: 'BTC', old: 1.10, new: 1.73, reason: 'accelerated boost (59% + improving)' },
  ],
  summary: {
    boosted: 2,
    reduced: 1,
    held: 1,
    accelerated: 1,
  }
}
```

---

## Weight Adjustment Rules

### Thresholds

```
Accuracy >= 52%  → BOOST weight by 5%
Accuracy <= 45%  → REDUCE weight by 5%
Accuracy 46-51%  → HOLD weight (no change)
```

### Trending Acceleration

```
Improvement > 5%  → Multiply boost by 1.5x
Degradation > 5%  → Multiply reduce by 1.3x
Stable (±5%)      → No acceleration
```

### Multiplier Caps

```
Minimum: 0.3x  (signal can't be suppressed below 30% of baseline)
Maximum: 2.0x  (signal can't dominate beyond 200% of baseline)
```

---

## Audit Trail

### Console Access

```javascript
// View last tuning event
window._lastTuneEvent

// Output:
{
  timestamp: 1714598520000,
  cycle: 847,
  duration_ms: 45,
  changes: [
    { signal: 'RSI', coin: 'BTC', old: 1.05, new: 1.10, reason: 'boosted (58%)' },
    // ... 8 more changes
  ],
  summary: {
    boosted: 2,
    reduced: 1,
    held: 1,
    accelerated: 1
  }
}

// Get full diagnostics
window.AdaptiveLearner.getDiagnostics()

// Output:
{
  initialized: true,
  cycleCount: 847,
  lastTuneTime: 1714598520000,
  nextTuneTime: 1714598640000,  // 2 min from last
  signalAccuracy: {
    BTC: {
      RSI: { accuracy: 0.58, count: 20, boosted: 2, times_adjusted: 14 },
      MACD: { accuracy: 0.42, count: 20, reduced: 3, times_adjusted: 8 },
      // ... all signals
    },
    // ... all coins
  },
  currentWeights: {
    BTC: { RSI: 1.10, MACD: 0.90, ... },
    // ... all coins
  },
  tuneHistory: [
    // Last 100 tuning events
  ]
}
```

### Manual Console Inspection

```javascript
// Get per-signal accuracy report
window.AdaptiveLearner.getAllReports()

// Output:
{
  BTC: {
    RSI: { accuracy: 0.58, history: [1,0,1,1,0,...], trend: 'improving' },
    MACD: { accuracy: 0.42, history: [0,1,0,0,1,...], trend: 'degrading' },
    // ... all signals
  },
  ETH: { ... },
  // ... all coins
}

// Get trending analysis
window.AdaptiveLearner.getTrendAnalysis()

// Output:
{
  BTC: {
    RSI: { oldHalf: 0.55, newHalf: 0.60, trend: 'improving', acceleration: 1.0 },
    Fisher: { oldHalf: 0.54, newHalf: 0.65, trend: 'strongly_improving', acceleration: 1.5 },
    // ...
  },
  // ... all coins
}
```

---

## Real-Time Learning Example

### Day-Long Scenario

```
=== 09:00 UTC - System Startup ===
No historical data yet
All weights at baseline: 1.0x

=== 10:00 UTC - First tuning cycle ===
Collected 30 settled contracts
RSI: 48% accuracy → REDUCE to 0.95x
MACD: 52% accuracy → BOOST to 1.05x
CCI: 50% accuracy → HOLD at 1.00x

=== 10:30 UTC - 30 more contracts ===
Scorecard updated: 60 total settled contracts

=== 12:00 UTC - Second tuning cycle ===
Last 20 contracts (10:30-12:00):
RSI: 54% accuracy (improving from 48%!)
  └─ Old half: 48%, New half: 60%
  └─ Improvement: +12% → Apply 1.5x acceleration
  └─ Decision: BOOST × 1.05 × 1.5 = 1.58x
  └─ Update: 0.95x → 1.58x (capped at 2.0x)

MACD: 50% accuracy (declining from 52%!)
  └─ Old half: 55%, New half: 45%
  └─ Degradation: -10% → Apply 1.3x acceleration
  └─ Decision: HOLD (50% is neutral)
  └─ Update: 1.05x → 1.05x (no change for holds)

CCI: 51% accuracy (stable)
  └─ Old half: 50%, New half: 52%
  └─ Improvement: +2% → No acceleration
  └─ Decision: HOLD at 1.00x

=== 14:00 UTC - 100 settled contracts total ===
Weight evolution:
Time | RSI  | MACD | CCI
-----|------|------|-----
 09:00| 1.0x | 1.0x | 1.0x
 12:00| 1.58x| 1.05x| 1.0x
 14:00| 1.62x| 0.95x| 1.05x  ← Next tuning
     |↑📈  |↓📉  |→📊

Impact on predictions:
- RSI now 62% more influential
- MACD now 5% less influential
- CCI stable
- Result: Better prediction accuracy! 📈

=== 18:00 UTC - Summary ===
Contracts: 200 settled
Model accuracy: 57% (up from 52% baseline)
Best signal: Fisher Transform (1.73x boost - strong improvement)
Worst signal: MACD (0.85x reduction - consistent underperformance)
Learning status: ✅ IMPROVING

Projected improvement: +1-2% per day as learning continues
```

---

## Console Commands Reference

### Check Status

```javascript
// View historical accuracy
window._historicalScorecard

// View current weights
window._adaptiveWeights

// View last tuning event
window._lastTuneEvent
```

### Get Reports

```javascript
// All signal accuracies per coin
window.AdaptiveLearner.getAllReports()

// Trending analysis
window.AdaptiveLearner.getTrendAnalysis()

// Full diagnostics
window.AdaptiveLearner.getDiagnostics()
```

### Manual Control

```javascript
// Force immediate tuning (don't wait 2 min)
window.AdaptiveLearner.autoTuneWeights()

// Reset learning (clear history)
window.AdaptiveLearner.reset()

// Set custom weight multiplier
window.AdaptiveLearner.setWeight('BTC', 'RSI', 1.5)

// Get specific signal accuracy
window.AdaptiveLearner.getSignalAccuracy('BTC', 'RSI')
```

---

## Debugging Learning Issues

### "Weights not updating"

**Diagnosis:**
```javascript
// Check if enough contracts exist
window._historicalScorecard.totalSettled

// If < 5, system won't tune yet (needs minimum data)

// Check tuning interval
window.AdaptiveLearner.tuneInterval  // Should be 120000 (2 min)

// Check if learning engine initialized
window.AdaptiveLearner !== undefined  // Should be true
```

**Solution:**
```javascript
// If stuck, force tuning
window.AdaptiveLearner.autoTuneWeights()

// If that fails, reset and restart
window.AdaptiveLearner.reset()
```

### "Accuracy not improving"

**Diagnosis:**
```javascript
// Check trending
window.AdaptiveLearner.getTrendAnalysis()

// Look for "degrading" signals
// These are underperforming and hurting accuracy

// Get signal accuracy
window.AdaptiveLearner.getAllReports()
```

**Solution:**
```javascript
// Manually reduce poor-performing signal
window.AdaptiveLearner.setWeight('BTC', 'MACD', 0.5)

// Wait 1-2 hours for learning to adapt
// If accuracy still low, signal may be broken
```

### "Weight multiplication too extreme (>2x or <0.3x)"

**Diagnosis:**
```javascript
// Check weights
window._adaptiveWeights

// Look for values outside 0.3x-2.0x range
// (Shouldn't happen, but check for bugs)
```

**Solution:**
```javascript
// Reset weights to baseline
window.AdaptiveLearner.reset()

// Restart learning from scratch
```

---

## Performance Expectations

### Accuracy Improvement Timeline

| Period | Expected Accuracy | Learning Status |
|--------|------------------|-----------------|
| 0-2 hours | 45-50% | Insufficient data (< 20 contracts) |
| 2-4 hours | 48-52% | Initial tuning active |
| 4-8 hours | 50-54% | Trending detected, acceleration active |
| 1 day | 52-55% | Baseline established per coin |
| 1 week | 54-58% | Strong per-coin optimization |
| 1 month | 54-60% | Regime-aware adaptation |

### Signal Development

```
Hours 0-2:   All signals weight 1.0x (baseline)
Hours 2-6:   Best performers boosted to 1.2-1.4x
Hours 6-12:  Poor performers reduced to 0.6-0.8x
Day 1+:      Stable pattern emerges
Week 1+:     Adaptive pattern by coin + market regime
```

---

## Advanced: Custom Tuning Parameters

### Modifying Thresholds

```javascript
// Edit tuning configuration (if exposed):
window.AdaptiveLearner.config = {
  boostThreshold: 0.52,      // Default 52%
  reduceThreshold: 0.45,     // Default 45%
  boostFactor: 1.05,         // Default 1.05 (5%)
  reduceFactor: 0.95,        // Default 0.95 (5%)
  trendAcceleration: 1.5,    // Default 1.5x
  minWeight: 0.3,            // Default 0.3x
  maxWeight: 2.0,            // Default 2.0x
  tuneInterval: 120000,      // Default 120 sec (2 min)
  windowSize: 20,            // Default 20 contracts
}
```

### Advanced Analysis

```javascript
// Get correlation between signals
window.AdaptiveLearner.getSignalCorrelation('BTC')

// Get optimal signal combination per coin
window.AdaptiveLearner.getOptimalCombination('BTC')

// Export historical accuracy for analysis
window.AdaptiveLearner.exportAccuracyData('csv')
```

---

**Learning Engine Version:** 2.11.0  
**Last Updated:** 2026-05-01  
**Status:** Production-ready and continuously improving
