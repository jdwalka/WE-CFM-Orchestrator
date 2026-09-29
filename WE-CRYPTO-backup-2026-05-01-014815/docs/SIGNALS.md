# 🧬 Signal Indicators Reference

Complete guide to every technical indicator used in WE-CRYPTO predictions.

---

## Overview

WE-CRYPTO uses **9 primary signals** that feed into the prediction model:

| Signal | Category | Purpose | Typical Accuracy |
|--------|----------|---------|------------------|
| **RSI** | Oscillator | Overbought/Oversold | 53-58% |
| **MACD** | Momentum | Trend confirmation | 50-55% |
| **CCI** | Oscillator | Mean reversion | 51-56% |
| **Fisher Transform** | Oscillator | Normalized extremes | 52-57% |
| **ADX** | Trend | Trend strength filter | 50-53% |
| **ATR** | Volatility | Volatility filter | 50-52% |
| **Order Book** | Market Micro | Imbalance detection | 51-55% |
| **Kalshi Probability** | Market Macro | Direct crowd signal | 49-52% |
| **Crowd Fade** | Contrarian | Reverse crowd sentiment | 48-54% |

---

## 1️⃣ RSI (Relative Strength Index)

### What It Is
Momentum oscillator measuring speed/magnitude of price changes on a 0-100 scale.

### Formula
```
RSI = 100 - (100 / (1 + RS))
RS = Average Gain / Average Loss (over N periods)
Default: 14 periods
```

### Signals
```
RSI > 70  → Overbought (potential DOWN) 🔴
RSI < 30  → Oversold (potential UP) 🟢
30-70     → Neutral (no signal)
```

### In WE-CRYPTO
- **Window:** 14-period RSI on 15m candles
- **Threshold:** >70 or <30 triggers signal
- **Confidence:** ±15% per extreme
- **Trending:** Improving above 55% accuracy per cycle
- **Current Weight:** 1.0-1.2x (based on adaptive tuning)

### Example
```
BTC 15m candle at 14:00 UTC
RSI = 72 (overbought)
Signal: PREDICT DOWN
Confidence: +12% (closer to 100% threshold)
```

### Historical Performance
- **Baseline accuracy:** 55%
- **Trending direction:** Stable
- **Best performs in:** Ranging markets (not trending)
- **Worst performs in:** Strong trends (generates false signals)

---

## 2️⃣ MACD (Moving Average Convergence Divergence)

### What It Is
Trend-following momentum indicator showing relationship between two moving averages.

### Formula
```
MACD Line = EMA(12) - EMA(26)
Signal Line = EMA(MACD, 9)
Histogram = MACD Line - Signal Line
```

### Signals
```
MACD > Signal Line & both > 0  → Strong UP 🟢
MACD < Signal Line & both < 0  → Strong DOWN 🔴
MACD crosses Signal Line        → Direction change ↔️
Histogram color change          → Momentum shift
```

### In WE-CRYPTO
- **Window:** 12/26/9 on 15m candles
- **Signal strength:** Histogram magnitude
- **Confidence:** ±20% based on line distance
- **Trending:** Recently 50-52% accuracy (neutral)
- **Current Weight:** 0.95-1.05x (reducing if underperforming)

### Example
```
BTC 15m at 15:30 UTC
MACD: -150
Signal: -100
Histogram: -50 (becoming less negative)
Interpretation: DOWN momentum weakening
Prediction: Possible UP reversal incoming
```

### Historical Performance
- **Baseline accuracy:** 52%
- **Trending direction:** Declining (↓ 2% per week)
- **Best performs in:** Trending markets
- **Worst performs in:** Choppy consolidation

---

## 3️⃣ CCI (Commodity Channel Index)

### What It Is
Oscillator measuring cyclical price movements around mean, designed for mean reversion.

### Formula
```
CCI = (Price - SMA) / (0.015 × Mean Deviation)
Default: 20 periods
```

### Signals
```
CCI > +100  → Overbought (mean reversion DOWN) 🔴
CCI < -100  → Oversold (mean reversion UP) 🟢
-100 to +100 → Normal range
```

### In WE-CRYPTO
- **Window:** 20-period CCI on 15m candles
- **Extreme threshold:** ±100
- **Confidence:** ±18% based on distance from mean
- **Trending:** 51-54% accuracy (stable)
- **Current Weight:** 1.0x (performing well)

### Example
```
ETH 15m candle
CCI = +145 (strongly overbought)
Recent price: Above 20-period mean
Signal: PREDICT DOWN (mean reversion)
Confidence: +16% (strong extreme)
```

### Historical Performance
- **Baseline accuracy:** 54%
- **Trending direction:** Stable
- **Best performs in:** Range-bound markets
- **Worst performs in:** Strong trends (gets whipsawed)

---

## 4️⃣ Fisher Transform

### What It Is
Normalized oscillator converting prices to Gaussian normal distribution (-1 to +1).

### Formula
```
Normalized Price = 2 × ((Price - Min) / (Max - Min)) - 1
Fisher = 0.5 × ln((1 + Normalized) / (1 - Normalized))
```

### Signals
```
Fisher > +0.5  → Extreme overbought 🔴
Fisher < -0.5  → Extreme oversold 🟢
-0.5 to +0.5   → Normal range
Signal line crossover → Momentum change
```

### In WE-CRYPTO
- **Window:** 10-period normalization
- **Extreme threshold:** ±0.5
- **Confidence:** ±22% (highest sensitivity)
- **Trending:** 56-59% accuracy (improving!)
- **Current Weight:** 1.05-1.15x (boosted recently)

### Example
```
SOL 15m candle
Fisher = +0.68 (extremely overbought)
Recent trend: 5 consecutive up candles
Signal: PREDICT DOWN (mean reversion)
Confidence: +21% (extreme reading)
```

### Historical Performance
- **Baseline accuracy:** 57%
- **Trending direction:** Improving ↑ (+3% per week)
- **Best performs in:** Turning points
- **Worst performs in:** Early trend continuation

---

## 5️⃣ ADX (Average Directional Index)

### What It Is
Trend strength indicator (0-100) measuring intensity of trend without direction.

### Formula
```
+DI = (HighDiff / TrueRange) × 100
-DI = (LowDiff / TrueRange) × 100
ADX = smoothed average of +DI and -DI spread
```

### Signals
```
ADX > 25  → Strong trend (use directional signals)
ADX < 20  → Weak trend (avoid trades, consolidating)
ADX rising → Trend strengthening
ADX falling → Trend weakening
```

### In WE-CRYPTO
- **Window:** 14-period ADX
- **Strong threshold:** ADX > 25
- **Weak threshold:** ADX < 20
- **Purpose:** Filter (don't trade weak trends)
- **Trending:** 51% accuracy (mostly used as filter)
- **Current Weight:** 1.0x (stable)

### Example
```
BTC 15m candle
ADX = 18 (weak trend)
Recent: Range-bound consolidation
Signal: SKIP (insufficient trend strength)
Action: Don't trade in weak ADX environments
```

### Historical Performance
- **Baseline accuracy:** 51% (weak directional signal)
- **Trending direction:** Stable
- **Best use:** Filter (confirm trend exists)
- **Not recommended:** As primary signal

---

## 6️⃣ ATR (Average True Range)

### What It Is
Volatility indicator measuring average range of price movement, normalized by price.

### Formula
```
True Range = max(High - Low, High - Previous Close, Previous Close - Low)
ATR = smoothed average of True Range (14 periods typical)
```

### Signals
```
ATR increasing → Rising volatility (larger moves possible)
ATR decreasing → Falling volatility (moves constrained)
ATR above 20-period avg → Volatility spike
```

### In WE-CRYPTO
- **Window:** 14-period ATR on 15m candles
- **Purpose:** Volatility adjustment
- **Trending:** 50% accuracy (primarily used as filter)
- **Current Weight:** 1.0x (stable)

### Example
```
ETH 15m candle
ATR (14) = $45 (high volatility)
Previous ATR avg = $35
Signal: High volatility environment
Action: Increase confidence threshold (wait for clearer signals)
```

### Historical Performance
- **Baseline accuracy:** 50% (mainly volatility indicator)
- **Trending direction:** Stable
- **Best use:** Volatility regime detection
- **Not recommended:** As directional signal alone

---

## 7️⃣ Order Book Imbalance

### What It Is
Market micro-structure signal analyzing buy/sell pressure in real-time order book.

### Calculation
```
Buy Volume = Sum of BID orders within spread
Sell Volume = Sum of ASK orders within spread
Imbalance % = (Buy - Sell) / (Buy + Sell) × 100

Positive % → More buy pressure → Potential UP
Negative % → More sell pressure → Potential DOWN
```

### Signals
```
Imbalance > +15%  → Strong buy pressure (UP) 🟢
Imbalance < -15%  → Strong sell pressure (DOWN) 🔴
-15% to +15%      → Balanced
```

### In WE-CRYPTO
- **Window:** Top 5 levels on each side
- **Threshold:** ±15% extreme
- **Confidence:** ±18% based on magnitude
- **Trending:** 52-55% accuracy (market-dependent)
- **Current Weight:** 1.0x (stable)

### Example
```
BTC/USDT order book at 16:45 UTC
Bid volume (5 levels): 250 BTC
Ask volume (5 levels): 180 BTC
Imbalance: +16% (strong buy pressure)
Signal: PREDICT UP
Confidence: +16% (strong imbalance)
```

### Historical Performance
- **Baseline accuracy:** 53%
- **Trending direction:** Variable (coin-dependent)
- **Best performs in:** Liquid coins (BTC, ETH)
- **Worst performs in:** Low-volume altcoins

---

## 8️⃣ Kalshi Market Probability

### What It Is
Direct extraction of market crowd sentiment from Kalshi prediction contracts.

### Source
- Kalshi YES/NO contracts on same pair + timeframe
- Market probability reflects crowd's collective prediction
- Liquid market pricing = crowd's actual money at risk

### Signals
```
Kalshi YES prob > 65%  → Strong crowd bullish (UP) 🟢
Kalshi YES prob < 35%  → Strong crowd bearish (DOWN) 🔴
35-65%                  → Crowd uncertain
```

### In WE-CRYPTO
- **Source:** Real-time Kalshi API
- **Threshold:** ±15% from 50/50
- **Confidence:** ±20% based on probability distance
- **Trending:** 49-52% accuracy (crowd often wrong!)
- **Current Weight:** 1.0x (baseline)

### Example
```
Kalshi BTC UP 15m contract
Current probability: 72% YES (28% NO)
Market interpretation: Crowd expects UP
Signal: PREDICT UP (follow crowd)
Confidence: +20% (strong crowd signal)
```

### Historical Performance
- **Baseline accuracy:** 50%
- **Trending direction:** Varies
- **Best use:** Sentiment baseline
- **Note:** Often underperforms (crowds wrong 50% of time!)

---

## 9️⃣ Crowd Fade

### What It Is
Contrarian signal: predicts opposite of crowd extreme sentiment.

### Logic
```
IF Kalshi YES probability > 75% AND
   Recent trend = DOWN momentum AND
   OB imbalance = negative
THEN predict DOWN (fade the crowd bull trap)

IF Kalshi YES probability < 25% AND
   Recent trend = UP momentum AND
   OB imbalance = positive
THEN predict UP (fade the crowd bear trap)
```

### Signals
```
Extreme crowd probability + contrary technicals
→ Fade the crowd consensus
```

### In WE-CRYPTO
- **Trigger:** Kalshi prob > 75% OR < 25%
- **Confirmation:** ≥2 technical signals opposing crowd
- **Confidence:** ±22% (contrarian boost)
- **Trending:** 48-54% accuracy (volatile)
- **Current Weight:** 0.95-1.05x (tuning)

### Example
```
BTC 15m contract
Kalshi YES: 79% (strong crowd bullish)
RSI: 74 (overbought, potential DOWN)
MACD: Weakening (momentum fading)
ATR: Spiking (volatility spike before reversal)
Signal: FADE CROWD (predict DOWN despite 79% crowd UP)
Confidence: +20% (strong contrarian setup)
```

### Historical Performance
- **Baseline accuracy:** 50%
- **Trending direction:** Improving (↑ 2% per week)
- **Best performs in:** Extreme crowd events
- **Worst performs in:** Strong trend markets

---

## 🎯 Signal Combination Rules

### When Multiple Signals Align

```
Scenario 1: All signals bullish (RSI <30 + MACD UP + CCI <-100)
→ Strong UP prediction, confidence +30%
Example: BTC oversold reversal

Scenario 2: Mixed signals (RSI bullish, MACD neutral, CCI bearish)
→ Weak prediction, low confidence ~10%
Example: Skip or wait for clearer setup

Scenario 3: Strong contrarian (Crowd 80% UP, but technicals all DOWN)
→ Fade crowd signal, confidence +25%
Example: Crowd trap reversal

Scenario 4: ADX <20 (weak trend)
→ Reduce confidence -10% regardless of signals
Example: Choppy consolidation period
```

---

## 📊 Weight Tuning in Action

### Adaptive Response

The learning engine tracks each signal's accuracy:

```
Cycle 1 (14:00):
RSI accuracy: 57% → Boost 1.05x
MACD accuracy: 42% → Reduce 0.95x
CCI accuracy: 50% → Hold 1.0x

Cycle 2 (14:02):
RSI accuracy: 59% (trending up!) → Boost 1.10x (accelerated)
MACD accuracy: 48% (improving) → Reduce 0.95x (continue)
CCI accuracy: 51% (stable) → Hold 1.0x

By end of day:
RSI: 1.20x (best performer)
MACD: 0.85x (worst performer)
CCI: 1.05x (neutral performer)
```

---

## 🔍 Debugging Signal Issues

### "Predictions always UP"
1. Check RSI weight: If too high, may over-trigger
2. Verify order book API responding
3. Check if recent trend strongly bullish

### "Predictions always DOWN"
1. Same checks as above
2. Verify Kalshi crowd signal isn't stuck
3. Check MACD configuration

### "Low confidence scores"
1. Mixed signals = uncertain market
2. ADX <20 = weak trend environment
3. Volatility spike (ATR high) = uncertain conditions

---

## 🚀 Best Practices

### Signal Prioritization
1. **Primary:** RSI, Fisher, CCI (highest accuracy ~55%)
2. **Confirming:** MACD, Order Book (medium ~52%)
3. **Filtering:** ADX, ATR (trend/volatility context)
4. **Contrarian:** Crowd Fade, Kalshi Probability (sentiment)

### When to Trust Signals
✅ Multiple signals align (≥3 agree)  
✅ ADX > 25 (strong trend exists)  
✅ Signals from different categories align  
✅ Recent historical accuracy >55%

### When to Skip
❌ Mixed signals (<2 agree)  
❌ ADX <20 (weak/no trend)  
❌ ATR spiking (volatility chaos)  
❌ Recent accuracy <45%

---

**Signal Reference:** v2.11.0  
**Last Updated:** 2026-05-01  
**Maintained By:** Adaptive Learning Engine
