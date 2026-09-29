# Adaptive Walk-Forward Tuning Module — Phase 6 Integration Guide

## Overview

The adaptive walk-forward tuning system continuously recalibrates signal gates every 15 minutes to adapt to changing market regimes. It uses:
- **Pyth live price feeds** for market regime detection & settlement validation
- **Recent trade performance** (last 100 trades per coin) to adjust thresholds
- **Intelligent rules** to tighten/relax based on accuracy, volatility, and false positives

## Architecture

### Core Modules

#### 1. **AdaptiveTuner** (`src/core/adaptive-tuner.js`)
Main tuning engine that recommends and applies threshold adjustments.

**Key Methods:**
- `recordTrade(sym, tradeData)` — Record trade outcomes for tuning decisions
- `getPerformanceMetrics(sym)` — Compute win rate, false positive rate
- `recommendTuning(sym)` — Generate tuning recommendation based on recent performance
- `applyTuning(sym, recommendation)` — Apply threshold adjustment
- `runTuningCycle(options)` — Execute full tuning cycle for all coins
- `getCurrentGates()` — Get current adaptive thresholds
- `getDiagnostics()` — Get full tuning state for debugging

**Tuning Rules:**
- **Rule 1**: `winRate < 40%` → **Tighten** (increase minAbsScore by 0.03)
- **Rule 2**: `winRate > 55%` → **Relax** (decrease minAbsScore by 0.02)
- **Rule 3**: `fprRate > 50%` → **Tighten** (increase by 0.02)
- **Rule 4**: `volatility > 0.7` → **Tighten** (be conservative in volatile markets)

**Bounds (per coin):**
```
BTC:  min=0.15, max=0.25  (baseline: 0.19)
ETH:  min=0.18, max=0.28  (baseline: 0.22)
XRP:  min=0.26, max=0.38  (baseline: 0.30)
SOL:  min=0.24, max=0.35  (baseline: 0.28)
BNB:  min=0.26, max=0.40  (baseline: 0.30)
```

#### 2. **PythSettlementValidator** (`src/core/pyth-settlement.js`)
Validates market data freshness and settlement accuracy via Pyth API.

**Key Methods:**
- `getCurrentPrice(sym)` — Fetch live price from Pyth Hermes
- `getPrices(coins)` — Batch fetch multiple prices
- `validateSettlement(trade)` — Compare Kalshi outcome to Pyth price
- `isFresh(sym, maxAge_ms)` — Check if price feed is stale
- `recordPrice(sym, price)` — Track price history for volatility
- `getVolatility(sym, windowSize)` — Compute volatility regime
- `getMarketRegime()` — Get aggregate market volatility across all coins
- `getDiagnostics()` — Get price cache and settlement log

**Supported Coins (Pyth Feed IDs):**
- BTC, ETH, SOL, XRP, DOGE, BNB

### Integration Points

#### In `predictions.js`
- Line ~395: Adaptive gates applied when evaluating signal quality
- Fallback to baseline if no adaptive tuner available
- Dynamically adjusts minAbsScore per coin

#### In `app.js`
- Lines ~7265-7300: Initialize adaptive modules on startup
- Lines ~7278-7295: Schedule tuning cycle every 15 minutes
- Lines ~4125-4135: Record trades when they settle
- Tracks: score, prediction direction, correctness, false positive flag

#### In HTML (`public/index.html`)
- Lines ~216-217: Load adaptive modules before predictions.js
- Ensures modules available when prediction engine initializes

## Usage

### Accessing Diagnostics in DevTools Console

```javascript
// Get current adaptive thresholds
window._adaptiveTuner.getCurrentGates()
// Output: { BTC: 0.19, ETH: 0.22, XRP: 0.30, SOL: 0.28, BNB: 0.30 }

// Get performance metrics for a coin
window._adaptiveTuner.getPerformanceMetrics('BTC')
// Output: { winRate: 52, trades: 45, correctCount: 23, fprRate: 12 }

// Get tuning recommendation (doesn't apply it)
window._adaptiveTuner.recommendTuning('ETH')
// Output: { action: 'relax', newThreshold: 0.20, reason: '... high accuracy ...', ... }

// Get full diagnostics
window._adaptiveTuner.getDiagnostics()

// View recent tuning events
window._tuningLog.slice(-5)

// Reset to baseline
window._adaptiveTuner.resetToBaseline()

// Pyth settlement validator
window._pythSettlementValidator.getCurrentPrice('BTC')
window._pythSettlementValidator.getMarketRegime()
```

### Manual Tuning Cycle (for testing)

```javascript
// Run dry-run (no changes applied)
await window._adaptiveTuner.runTuningCycle({ dryRun: true })

// Run live cycle with Pyth validation
await window._adaptiveTuner.runTuningCycle({ validatePyth: true, dryRun: false })
```

## Tuning Log Format

Each entry in `window._tuningLog` contains:

```javascript
{
  timestamp: 1714305000000,
  cycleId: 'a1b2c3d4e5',
  coins: [
    {
      coin: 'BTC',
      recommendation: {
        action: 'tighten',
        currentThreshold: 0.19,
        newThreshold: 0.21,
        delta: 0.02,
        reason: 'Low accuracy (38% on 12 trades)',
        reason_codes: ['LOW_ACCURACY'],
        metrics: { winRate: 38, trades: 12, correctCount: 5, fprRate: 67 },
        volatilityRegime: { regime: 'high', volatility: 0.82, confidence: 'high' }
      },
      applied: true
    }
  ],
  totalAdjustments: 1,
  validation: { pythChecked: true, valid: true },
  cycleTime: 142,
  dryRun: false
}
```

## Tuning Behavior Examples

### Scenario 1: Recent Poor Performance (BTC)
- Last 10 trades: 3 correct, 7 wrong → **38% win rate**
- Current threshold: 0.19
- **Recommendation**: Tighten to 0.22 (increase by 0.03)
- **Reason**: "Low accuracy (38% on 10 trades)"
- **Effect**: Fewer signals, but higher conviction when generated

### Scenario 2: High Accuracy & Low Volatility (ETH)
- Last 20 trades: 14 correct, 6 wrong → **70% win rate**
- Volatility: 0.35 (low, good conditions)
- Current threshold: 0.22
- **Recommendation**: Relax to 0.20 (decrease by 0.02)
- **Reason**: "High accuracy (70% on 20 trades)"
- **Effect**: More signals in favorable market regime

### Scenario 3: High Volatility (SOL)
- Current threshold: 0.28
- Volatility: 0.81 (high, turbulent market)
- Win rate: 52% (neutral)
- **Recommendation**: Tighten to 0.30 (increase by 0.02)
- **Reason**: "High volatility regime (81%)"
- **Effect**: Reduce false positives in noisy market

## Performance Monitoring

### Key Metrics to Track
- **Tuning Adjustments**: How often thresholds change (expect 0-2 per cycle)
- **Win Rate Stability**: Should remain 45-55% after tuning
- **False Positive Rate**: Target <30% for quality signals
- **Volatility Regime**: Correlate with market conditions

### Expected Behavior
- **Stable markets**: Few tuning changes, thresholds near baseline
- **Trending markets**: Slight relaxation if win rate >55%
- **Volatile markets**: Aggressive tightening to reduce whipsaws
- **Reversal markets**: Tightening when accuracy drops

## Tuning vs. Backtest

**Difference**:
- **Backtest** (coin_metrics.py): Offline analysis of historical data → produces baseline thresholds
- **Adaptive Tuning** (Phase 6): Live market adaptation every 15 minutes → tunes around baseline

**Relationship**:
- Adaptive tuner keeps thresholds within bounds (e.g., BTC: 0.15–0.25)
- Baseline threshold (0.19 for BTC) is center of bounds
- Tuning adjusts in small increments ±0.02–0.03

**When to trust adaptive tuning?**
- ✅ After 20+ trades recorded (enough signal)
- ✅ When performance metrics are stable (not fluctuating wildly)
- ✅ In consistent market regimes (not rapid regime changes)
- ❌ In first 5 minutes (not enough data)
- ❌ Immediately after market open (high noise)

## Troubleshooting

### Adaptive Tuner Not Recording Trades
- Check: Is `window._adaptiveTuner` defined? (`console.log(window._adaptiveTuner)`)
- Check: Are trades settling? (Look for `entry._settled = true` in app.js)
- Solution: Restart app, ensure predictions are running

### Pyth Validation Failing
- Check: Is Pyth API accessible? (`await window._pythSettlementValidator.getCurrentPrice('BTC')`)
- Check: Feed stale? (Age > 60 seconds = warning)
- Solution: Check internet connection, Pyth service status

### Thresholds Not Updating
- Check: Tuning cycle running? (Look for logs every 15 minutes)
- Check: Does recommendation pass confidence checks?
- Solution: Run manual cycle with `runTuningCycle({ dryRun: false })`

### Thresholds Oscillating
- This is normal with small sample sizes (<20 trades)
- Wait for more data or increase min trade threshold in code

## Future Enhancements

1. **Adaptive learning curves**: Learn per-coin sensitivity to tuning
2. **Multi-regime detection**: Identify and adapt to bull/bear/sideways markets
3. **Correlation tuning**: Adjust related coins together (e.g., BTC-ETH)
4. **Backtest feedback loop**: Use backtest results to seed tuning bounds
5. **Machine learning**: Use neural net to predict optimal thresholds

## Files Modified

- ✅ `src/core/adaptive-tuner.js` (NEW, 400+ lines)
- ✅ `src/core/pyth-settlement.js` (NEW, 350+ lines)
- ✅ `src/core/predictions.js` (modified: adaptive gate lookup)
- ✅ `src/core/app.js` (modified: module init + trade recording + tuning scheduler)
- ✅ `public/index.html` (modified: added script tags for adaptive modules)

## Build & Deployment

```bash
npm run build  # Builds dist/WECRYPTO-v2.5.0-momentum-portable.exe
```

All adaptive modules are bundled into the electron app and run client-side (no server required).
