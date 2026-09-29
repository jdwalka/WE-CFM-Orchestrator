#!/usr/bin/env node
// ================================================================
// WECRYPTO Adaptive Regime Detector — Live Runtime
//
// Detects market regime on each 5m candle close and dynamically
// applies regime-specific weight profiles to indicator bias.
//
// Called from predictions.js during signal generation:
//   const regime = detectMarketRegimeFromSnapshot(candles[coin]);
//   applyAdaptiveWeights(coin, regime);
// ================================================================
'use strict';

const REGIME_PROFILES = {
  breakout_momentum: {
    multipliers: {
      supertrend: 1.5, adx: 1.4, macd: 1.3, volume: 1.25,
      rsi: 0.8, stochrsi: 0.75, bands: 1.1, momentum: 1.2,
      mfi: 0.6, ichimoku: 0.7,
    },
    signal: 'UP',
  },
  mean_reversion_consolidation: {
    multipliers: {
      rsi: 1.6, stochrsi: 1.5, mfi: 1.4, bands: 1.3, cci: 1.2, ichimoku: 1.1,
      macd: 0.6, adx: 0.5, supertrend: 0.7, momentum: 0.6, volume: 0.8,
    },
    signal: 'OSCILLATOR',
  },
  elastic_bounce: {
    multipliers: {
      bands: 2.0, rsi: 1.8, ichimoku: 1.3, mfi: 1.5, williamsR: 1.4, fisher: 1.2,
      macd: 0.5, supertrend: 0.4, adx: 0.3,
    },
    signal: 'COUNTER_TREND',
  },
  extrema_pullback: {
    multipliers: {
      rsi: 0.3, stochrsi: 0.4, bands: 1.4, fisher: 1.5, williamsR: 1.3,
      cci: 0.8, momentum: 0.5, macd: 0.8, adx: 0.7,
    },
    signal: 'REVERSAL',
  },
  neutral_drift: {
    multipliers: {
      structure: 1.05, persistence: 1.05, volume: 1.02,
    },
    signal: 'NEUTRAL',
  },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const average = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
const stdDev = arr => {
  if (arr.length < 2) return 0;
  const m = average(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (m - v) ** 2, 0) / arr.length);
};

// ── Compute Quick Indicators ────────────────────────────────────

function computeQuickIndicators(closes, highs, lows, volumes) {
  const n = closes.length;
  if (n < 4) return null;

  // RSI (14)
  let rsi = 50;
  if (n >= 15) {
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= 14;
    avgLoss /= 14;
    for (let i = 15; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * 13 + (d > 0 ? d : 0)) / 14;
      avgLoss = (avgLoss * 13 + (d < 0 ? -d : 0)) / 14;
    }
    if (avgLoss > 0) rsi = 100 - (100 / (1 + avgGain / avgLoss));
  }

  // ATR (14)
  let atr = 0;
  if (n >= 2) {
    let sum = 0;
    for (let i = Math.max(1, n - 14); i < n; i++) {
      const h = highs[i], l = lows[i], pc = closes[i - 1];
      const ph = highs[i - 1], pl = lows[i - 1];
      sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    atr = sum / Math.min(14, n - 1);
  }
  const atrPercent = closes[n - 1] > 0 ? (atr / closes[n - 1]) * 100 : 0;

  // ADX (simplified: ratio of +DM to -DM)
  let adx = 25;
  if (n >= 2) {
    let plusDM = 0, minusDM = 0;
    for (let i = Math.max(1, n - 14); i < n; i++) {
      const h = highs[i], l = lows[i], ph = highs[i - 1], pl = lows[i - 1];
      const up = h - ph, down = pl - l;
      if (up > down && up > 0) plusDM += up;
      if (down > up && down > 0) minusDM += down;
    }
    const dx = plusDM + minusDM > 0 ? Math.abs(plusDM - minusDM) / (plusDM + minusDM) * 100 : 50;
    adx = dx;
  }

  // Volatility (stdDev of recent closes)
  const volatility = stdDev(closes.slice(-20));

  // Volume ratio (current vs average)
  const avgVol = average(volumes.slice(-14));
  const currVol = volumes[n - 1];
  const volRatio = avgVol > 0 ? currVol / avgVol : 1;

  // Price position (z-score)
  const recentCloses = closes.slice(-20);
  const meanPrice = average(recentCloses);
  const stdPrice = stdDev(recentCloses);
  const priceZScore = stdPrice > 0 ? (closes[n - 1] - meanPrice) / stdPrice : 0;

  // Close position in bar (0=low, 1=high)
  const lastRange = highs[n - 1] - lows[n - 1];
  const closePos = lastRange > 0 ? (closes[n - 1] - lows[n - 1]) / lastRange : 0.5;

  return {
    rsi,
    atr,
    atrPercent,
    adx,
    volatility,
    volRatio,
    priceZScore,
    closePos,
    closes: closes.slice(-20),
    highs: highs.slice(-20),
    lows: lows.slice(-20),
    volumes: volumes.slice(-14),
  };
}

// ── Classify Market Regime ──────────────────────────────────────

function classifyRegime(indicators) {
  if (!indicators) return 'neutral_drift';

  const {
    rsi, atrPercent, adx, volatility, volRatio, priceZScore, closePos,
  } = indicators;

  // 1. High volatility + strong trend
  if (atrPercent > 0.6 && adx > 35) {
    return 'breakout_momentum';
  }

  // 2. Low volatility + ranging + low ADX
  if (atrPercent < 0.3 && adx < 25 && volRatio < 1.2) {
    return 'mean_reversion_consolidation';
  }

  // 3. Price at extrema (z-score) + low volatility
  if (Math.abs(priceZScore) > 1.5 && atrPercent < 0.5 && volRatio < 0.8) {
    return 'elastic_bounce';
  }

  // 4. RSI overbought/oversold
  if ((rsi > 70 || rsi < 30) && volRatio > 1.0) {
    return 'extrema_pullback';
  }

  // 5. Default
  return 'neutral_drift';
}

// ── Apply Regime Weights ────────────────────────────────────────

function applyRegimeWeights(baseWeights, regime) {
  if (!REGIME_PROFILES[regime]) {
    return baseWeights;
  }

  const profile = REGIME_PROFILES[regime];
  const adjusted = { ...baseWeights };

  Object.entries(profile.multipliers).forEach(([indicator, mult]) => {
    if (adjusted[indicator] != null) {
      adjusted[indicator] = clamp(adjusted[indicator] * mult, 0.001, 10);
    }
  });

  return adjusted;
}

// ── Main Export Function ────────────────────────────────────────

function detectAndApplyRegime(candleData, baseWeights) {
  if (!candleData || candleData.length < 4) {
    return { regime: 'neutral_drift', weights: baseWeights };
  }

  const closes = candleData.map(c => Number(c[4]));
  const highs = candleData.map(c => Number(c[2]));
  const lows = candleData.map(c => Number(c[3]));
  const volumes = candleData.map(c => Number(c[7]));

  const indicators = computeQuickIndicators(closes, highs, lows, volumes);
  if (!indicators) {
    return { regime: 'neutral_drift', weights: baseWeights };
  }

  const regime = classifyRegime(indicators);
  const adjustedWeights = applyRegimeWeights(baseWeights, regime);

  return {
    regime,
    weights: adjustedWeights,
    indicators,
  };
}

module.exports = {
  detectAndApplyRegime,
  REGIME_PROFILES,
  classifyRegime,
  computeQuickIndicators,
  applyRegimeWeights,
};
