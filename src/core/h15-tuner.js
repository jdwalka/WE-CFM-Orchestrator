/**
 * H15 Tuner — Applies h15-specific indicator weights to maximize 15-minute prediction accuracy
 * 
 * ★ STRATEGY (2026-05-06): Moderate calibration vs aggressive boosting
 * - Focus: Polymarket 15-min contract settlement (primary mission)
 * - h1/h5/h10: Scalp territory, use only as noise-detectors or h15 filters
 * - Target: All coins h15 WR > 50%
 * 
 * Approach: Light indicator adjustments only (±1.0–1.5x), avoid overfitting
 */

(function () {
  'use strict';

  /**
   * H15-optimized indicator biases
   * Applied only when horizon === 15 (in minutes)
   * ★ LIGHT CALIBRATION: Modest ±20% shifts only, not aggressive 2–4x boosts
   */
  const H15_INDICATOR_BIAS = {
    BTC: {
      // h15 baseline strong: stochrsi, vwma, volume, bands, williamsR
      stochrsi:  1.2,    vwma: 1.15,   volume: 1.1,
      bands:     1.1,    williamsR: 1.05, structure: 1.0, persistence: 1.0,
      book:      0.5,    flow: 0.5,    rsi: 0.9, macd: 0.9, ema: 0.85,
      momentum:  0.8,    obv: 0.8, fisher: 0.95, keltner: 1.0, cci: 0.95,
      cmf:       0.95,   mfi: 0.9, supertrend: 0.85, adx: 0.9, sma: 0.85,
      vwap:      0.85,   ichimoku: 0.8, hma: 0.85, fearGreed: 1.0,
    },

    ETH: {
      // h15 baseline strong: rsi 82%, stochrsi 56%, williamsR 55%
      rsi:       1.2,    stochrsi: 1.1, williamsR: 1.1, bands: 1.05, structure: 1.0,
      book:      0.5,    flow: 0.5, volume: 0.95, macd: 0.9, ema: 0.9,
      momentum:  0.85,   obv: 0.85, persistence: 1.0, fisher: 0.95, keltner: 0.95,
      cci:       0.95,   cmf: 0.9, mfi: 0.85, supertrend: 0.85, adx: 0.9,
      sma:       0.85,   vwap: 0.85, ichimoku: 0.8, hma: 0.85, fearGreed: 1.0,
    },

    SOL: {
      // h15 mean-reversion core: bands 77%, williamsR 74%, fisher 74%, cci 72%
      bands:     1.3,    williamsR: 1.25, fisher: 1.2, cci: 1.15, keltner: 1.1,
      structure: 1.05,   ema: 0.8, macd: 0.85, momentum: 0.75, obv: 0.85,
      volume:    0.8,    rsi: 0.7, persistence: 0.8, book: 0.4, flow: 0.4,
      sma:       0.75,   vwap: 0.7, vwma: 0.8, adx: 0.9, ichimoku: 0.7,
      mfi:       0.85,   supertrend: 0.8, cmf: 0.9, stochrsi: 0.95, hma: 0.75,
      fearGreed: 1.0,
    },

    XRP: {
      // h15 baseline moderate: structure 72%, volume 66%, vwap 65%
      structure: 1.15,   volume: 1.1, vwap: 1.05, vwma: 1.1, book: 0.55,
      flow:      0.55,   macd: 0.9, ema: 0.9, momentum: 0.85, rsi: 0.95,
      obv:       0.9,    williamsR: 0.95, bands: 1.0, persistence: 1.0, fisher: 0.95,
      keltner:   0.95,   cci: 0.95, cmf: 0.9, mfi: 0.9, supertrend: 0.85,
      adx:       0.9,    stochrsi: 0.95, ichimoku: 0.85, sma: 0.85, hma: 0.85,
      fearGreed: 1.0,
    },

    // Fallback for unmapped coins (BNB, DOGE, HYPE)
    DEFAULT: {}
  };

  const H15_FILTER_OVERRIDES = {
    BTC:  { entryThreshold: 0.32, minAgreement: 0.52 },
    ETH:  { entryThreshold: 0.28, minAgreement: 0.54 },
    XRP:  { entryThreshold: 0.28, minAgreement: 0.50 },
    SOL:  { entryThreshold: 0.33, minAgreement: 0.54 },
    BNB:  { entryThreshold: 0.48, minAgreement: 0.70 },
    DOGE: { entryThreshold: 0.36, minAgreement: 0.64 },
    HYPE: { entryThreshold: 0.31, minAgreement: 0.62 },
  };

  /**
   * getTunedBias(horizonMinutes, coin, baseBias)
   * Returns indicator bias multipliers for h15, preserves other horizons
   */
  function getTunedBias(horizonMinutes, coin, baseBias) {
    if (horizonMinutes !== 15 || !coin) return baseBias;
    const h15Bias = H15_INDICATOR_BIAS[coin] || H15_INDICATOR_BIAS.DEFAULT;
    if (!h15Bias || Object.keys(h15Bias).length === 0) return baseBias;
    return { ...baseBias, ...h15Bias };
  }

  /**
   * getTunedFilter(horizonMinutes, coin, baseFilter)
   * Returns threshold overrides for h15, preserves other horizons
   */
  function getTunedFilter(horizonMinutes, coin, baseFilter) {
    if (horizonMinutes !== 15 || !coin) return baseFilter;
    const h15Override = H15_FILTER_OVERRIDES[coin];
    if (!h15Override) return baseFilter;
    return { ...baseFilter, ...h15Override };
  }

  // ── Public API ──────────────────────────────────────────────────────────
  window._h15Tuner = {
    getTunedBias,
    getTunedFilter,
    H15_INDICATOR_BIAS,
    H15_FILTER_OVERRIDES
  };

  console.info('[H15 Tuner] Initialized: Light calibration (+10–30% for proven h15 indicators) ✓');
})();
