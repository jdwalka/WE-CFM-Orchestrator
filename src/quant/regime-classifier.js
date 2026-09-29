/**
 * ================================================================
 * Statistical Regime Classifier for 15-minute Crypto Markets
 * 
 * Implements three complementary statistical measures:
 *   1. Hurst Exponent (Rescaled Range Analysis) — trend strength
 *   2. Variance Ratio Test — mean reversion vs momentum
 *   3. Permutation Entropy — price action structure quality
 * 
 * Regime States:
 *   'trend'           — strong directional momentum (H > 0.55, VR > 1.05)
 *   'mean_reversion'  — range-bound, oscillating (H < 0.45, VR < 0.95)
 *   'chop'            — indecisive, choppy (0.45 ≤ H ≤ 0.55)
 * 
 * Confidence: 0-1 composite score derived from all three metrics
 * ================================================================
 */

(function () {
  'use strict';

  /**
   * Calculates mean and standard deviation for an array of numbers
   */
  function calculateStats(arr) {
    if (!arr || arr.length === 0) return { mean: 0, std: 0 };
    const n = arr.length;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const variance = arr.reduce((a, x) => a + Math.pow(x - mean, 2), 0) / n;
    const std = Math.sqrt(variance);
    return { mean, std, variance };
  }

  /**
   * Logarithmic differences (returns) from price array
   */
  function calculateReturns(prices) {
    if (!prices || prices.length < 2) return [];
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > 0 && prices[i - 1] > 0) {
        returns.push(Math.log(prices[i] / prices[i - 1]));
      }
    }
    return returns;
  }

  /**
   * Hurst Exponent via Rescaled Range Analysis
   * Uses 60-candle lookback (15 hours on 15m timeframe)
   * 
   * H > 0.55  → trending/persistent (past up/down continues)
   * H ≈ 0.50  → random walk (no predictability)
   * H < 0.45  → mean reverting/antipersistent (reversals likely)
   * 
   * @param {number[]} closes - array of close prices
   * @param {number} lookback - window size (default 60)
   * @returns {object} { h_exponent, regime, volatility }
   */
  function calculateHurstExponent(closes, lookback = 60) {
    if (!closes || closes.length < lookback + 10) {
      return { h_exponent: 0.50, regime: 'chop', volatility: 0 };
    }

    // Use last `lookback` candles
    const subset = closes.slice(-lookback);
    const returns = calculateReturns(subset);
    
    if (returns.length < 10) {
      return { h_exponent: 0.50, regime: 'chop', volatility: 0 };
    }

    // Calculate rescaled range for multiple timescales
    const scales = [];
    const maxScale = Math.floor(returns.length / 2);
    const minScale = Math.max(2, Math.floor(returns.length / 20));

    for (let k = minScale; k <= maxScale; k += Math.max(1, Math.floor((maxScale - minScale) / 10))) {
      const numWindows = Math.floor(returns.length / k);
      if (numWindows < 2) continue;

      let avgRR = 0;
      for (let m = 0; m < numWindows; m++) {
        const window = returns.slice(m * k, (m + 1) * k);
        if (window.length < 2) continue;

        // Mean-adjusted cumulative sum (V)
        const wmean = window.reduce((a, b) => a + b, 0) / window.length;
        let cumsum = 0;
        let minCum = 0, maxCum = 0;
        for (let i = 0; i < window.length; i++) {
          cumsum += window[i] - wmean;
          minCum = Math.min(minCum, cumsum);
          maxCum = Math.max(maxCum, cumsum);
        }

        const R = maxCum - minCum;
        const S = Math.sqrt(window.reduce((a, x) => a + Math.pow(x - wmean, 2), 0) / window.length);
        
        if (S > 1e-10) {
          avgRR += R / S;
        }
      }

      avgRR /= numWindows;
      scales.push({ k, logK: Math.log(k), logRR: Math.log(avgRR + 1e-10) });
    }

    // Linear regression on log(k) vs log(R/S)
    if (scales.length < 2) {
      return { h_exponent: 0.50, regime: 'chop', volatility: 0 };
    }

    const n = scales.length;
    const sumLogK = scales.reduce((a, s) => a + s.logK, 0);
    const sumLogRR = scales.reduce((a, s) => a + s.logRR, 0);
    const sumLogKLogRR = scales.reduce((a, s) => a + s.logK * s.logRR, 0);
    const sumLogK2 = scales.reduce((a, s) => a + s.logK * s.logK, 0);

    const h_exponent = (n * sumLogKLogRR - sumLogK * sumLogRR) / (n * sumLogK2 - sumLogK * sumLogK);

    // Volatility from returns
    const stats = calculateStats(returns);
    const volatility = stats.std;

    // Regime classification
    let regime = 'chop';
    if (h_exponent > 0.55) regime = 'trend';
    else if (h_exponent < 0.45) regime = 'mean_reversion';

    return { h_exponent: Math.max(0, Math.min(1, h_exponent)), regime, volatility };
  }

  /**
   * Variance Ratio Test
   * Compares 1-period vs 2-period variance for mean reversion detection
   * VR > 1.05 suggests trending; VR < 0.95 suggests mean reversion
   * 
   * @param {number[]} prices - array of close prices
   * @param {number} d1_period - lag 1 (default 1)
   * @param {number} d2_period - lag 2 (default 2)
   * @returns {object} { variance_ratio, is_trending, is_mean_reverting, classification }
   */
  function calculateVarianceRatio(prices, d1_period = 1, d2_period = 2) {
    if (!prices || prices.length < d2_period * 5) {
      return { 
        variance_ratio: 1.0, 
        is_trending: false, 
        is_mean_reverting: false, 
        classification: 'neutral'
      };
    }

    // Calculate returns
    const returns = calculateReturns(prices);
    if (returns.length < d2_period * 5) {
      return { 
        variance_ratio: 1.0, 
        is_trending: false, 
        is_mean_reverting: false, 
        classification: 'neutral'
      };
    }

    // Variance of 1-period returns
    const stats1 = calculateStats(returns);
    const var1 = stats1.variance;

    // Variance of d2_period aggregated returns
    const aggregatedReturns = [];
    for (let i = 0; i <= returns.length - d2_period; i++) {
      const aggReturn = returns.slice(i, i + d2_period).reduce((a, b) => a + b, 0);
      aggregatedReturns.push(aggReturn);
    }

    const stats2 = calculateStats(aggregatedReturns);
    const var2 = stats2.variance;

    // Variance ratio: var(Δp_d) / (d * var(Δp_1))
    const variance_ratio = var2 > 1e-10 && var1 > 1e-10 
      ? var2 / (d2_period * var1) 
      : 1.0;

    const is_trending = variance_ratio > 1.05;
    const is_mean_reverting = variance_ratio < 0.95;
    const classification = is_trending ? 'trending' : is_mean_reverting ? 'mean_reversion' : 'neutral';

    return { 
      variance_ratio: Math.max(0.5, Math.min(1.5, variance_ratio)),
      is_trending,
      is_mean_reverting,
      classification
    };
  }

  /**
   * Permutation Entropy
   * Analyzes the ordinal pattern structure in price sequences.
   * Higher entropy = noisier/random. Lower entropy = more structured/trending.
   * 
   * entropy > 0.7  → 'noise' (chaotic, unpredictable)
   * 0.4–0.7       → 'weak' (some structure, moderate predictability)
   * entropy < 0.4  → 'strong' (clear patterns, high predictability)
   * 
   * @param {object[]} ohlcSequence - [{ open, high, low, close }, ...]
   * @param {number} order - permutation order (default 3)
   * @returns {object} { entropy_score, structure_quality, pattern_count }
   */
  function calculatePermutationEntropy(ohlcSequence, order = 3) {
    if (!ohlcSequence || ohlcSequence.length < order + 5) {
      return { entropy_score: 0.5, structure_quality: 'weak', pattern_count: 0 };
    }

    // Extract close prices (primary price action)
    const closes = ohlcSequence.map(ohlc => ohlc.close || ohlc);
    
    if (closes.length < order + 2) {
      return { entropy_score: 0.5, structure_quality: 'weak', pattern_count: 0 };
    }

    // Generate ordinal patterns
    const patterns = {};
    const maxPatterns = Math.factorial(order);

    for (let i = 0; i <= closes.length - order; i++) {
      const window = closes.slice(i, i + order);
      
      // Get ranks of indices sorted by value
      const indexed = window.map((v, idx) => ({ v, idx }));
      indexed.sort((a, b) => a.v - b.v);
      
      // Pattern is the sequence of ranks
      const pattern = indexed.map(x => x.idx).join(',');
      patterns[pattern] = (patterns[pattern] || 0) + 1;
    }

    // Calculate entropy
    const N = closes.length - order + 1;
    let entropy = 0;
    for (const count of Object.values(patterns)) {
      const p = count / N;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    // Normalize to [0, 1]: max entropy = log2(order!)
    const maxEntropy = Math.log2(maxPatterns);
    const normalized_entropy = maxEntropy > 0 ? entropy / maxEntropy : 0.5;

    let structure_quality = 'weak';
    if (normalized_entropy > 0.7) {
      structure_quality = 'noise';
    } else if (normalized_entropy < 0.4) {
      structure_quality = 'strong';
    }

    const pattern_count = Object.keys(patterns).length;

    return { 
      entropy_score: Math.max(0, Math.min(1, normalized_entropy)),
      structure_quality,
      pattern_count
    };
  }

  /**
   * Composite Regime Classification
   * Combines Hurst, Variance Ratio, and Entropy into single regime assessment
   * 
   * @param {number[]} closes - close prices
   * @param {object[]} ohlc - OHLC candles
   * @returns {object} {
   *   regime_state: 'trend'|'mean_reversion'|'chop',
   *   h_exponent: float,
   *   variance_ratio: float,
   *   entropy_score: float,
   *   confidence: 0-1,
   *   diagnostics: object
   * }
   */
  function classifyRegime(closes, ohlc) {
    // Safety checks
    if (!closes || closes.length < 65) {
      return {
        regime_state: 'chop',
        h_exponent: 0.50,
        variance_ratio: 1.0,
        entropy_score: 0.5,
        confidence: 0.3,
        diagnostics: { regime_score_composition: { h_weight: 0, vr_weight: 0, ent_weight: 0 } }
      };
    }

    // Calculate all three metrics
    const hurst = calculateHurstExponent(closes, 60);
    const vr = calculateVarianceRatio(closes, 1, 2);
    const entropy = calculatePermutationEntropy(ohlc || closes.map(c => ({ close: c })), 3);

    // Composite regime voting (simple majority + weighted confidence)
    const votes = {};
    const weights = {};

    // Hurst vote
    const hurst_regime = hurst.regime;
    votes[hurst_regime] = (votes[hurst_regime] || 0) + 1;
    weights[hurst_regime] = (weights[hurst_regime] || 0) + Math.abs(hurst.h_exponent - 0.50); // Higher weight if far from neutral

    // Variance Ratio vote
    const vr_regime = vr.classification;
    votes[vr_regime] = (votes[vr_regime] || 0) + 1;
    weights[vr_regime] = (weights[vr_regime] || 0) + Math.abs(vr.variance_ratio - 1.0); // Higher weight if far from neutral

    // Entropy vote (structure affects confidence but not primary regime)
    // Strong structure reinforces trending, weak structure suggests chop
    if (entropy.structure_quality === 'strong') {
      votes['trend'] = (votes['trend'] || 0) + 0.3;
      weights['trend'] = (weights['trend'] || 0) + 0.3;
    } else if (entropy.structure_quality === 'noise') {
      votes['chop'] = (votes['chop'] || 0) + 0.3;
      weights['chop'] = (weights['chop'] || 0) + 0.3;
    }

    // Find regime with highest vote (or weight if tied)
    let regime_state = 'chop';
    let max_vote = 0;
    let max_weight = 0;

    for (const [reg, vote] of Object.entries(votes)) {
      const w = weights[reg] || 0;
      if (vote > max_vote || (vote === max_vote && w > max_weight)) {
        regime_state = reg;
        max_vote = vote;
        max_weight = w;
      }
    }

    // Confidence: composite score from agreement of metrics
    // - All three agree = 0.9+ confidence
    // - Two agree = 0.6-0.75 confidence
    // - One dominant = 0.4-0.6 confidence
    let confidence = 0.5;
    const agreement_count = Object.values(votes).filter(v => v >= 1).length;

    if (agreement_count === 3 || max_vote >= 2.3) {
      confidence = 0.80 + (entropy.structure_quality === 'strong' ? 0.15 : 0);
    } else if (agreement_count === 2 || max_vote >= 1.3) {
      confidence = 0.65 + (entropy.structure_quality === 'strong' ? 0.1 : 0);
    } else {
      confidence = 0.45;
    }

    // Entropy penalty: noise reduces confidence
    if (entropy.structure_quality === 'noise') {
      confidence *= 0.8;
    }

    // Clamp confidence to [0.2, 0.95]
    confidence = Math.max(0.2, Math.min(0.95, confidence));

    return {
      regime_state,
      h_exponent: hurst.h_exponent,
      variance_ratio: vr.variance_ratio,
      entropy_score: entropy.entropy_score,
      confidence: Math.round(confidence * 100) / 100,
      diagnostics: {
        hurst_regime: hurst.regime,
        vr_classification: vr.classification,
        entropy_quality: entropy.structure_quality,
        agreement_count,
        regime_score_composition: {
          h_weight: weights[regime_state] || 0,
          vr_weight: weights[regime_state] || 0,
          ent_weight: entropy.structure_quality === 'strong' ? 0.3 : 0
        }
      }
    };
  }

  // Polyfill Math.factorial if needed (ES6 fallback)
  if (!Math.factorial) {
    Math.factorial = function(n) {
      if (n < 0) return undefined;
      if (n === 0 || n === 1) return 1;
      if (n === 2) return 2;
      if (n === 3) return 6;
      if (n === 4) return 24;
      let result = 1;
      for (let i = 2; i <= n; i++) result *= i;
      return result;
    };
  }

  // Export to window
  window.RegimeClassifier = {
    calculateHurstExponent,
    calculateVarianceRatio,
    calculatePermutationEntropy,
    classifyRegime,
  };

  console.log('[regime-classifier] Statistical regime detection module loaded');
})();
