// ================================================================
// WE|||CRYPTO — MergeKit Weight Ensembling Engine
// Implements SLERP (Spherical Linear Interpolation) and DARE
// (Drop And REscale) for indicator weight matrices across market regimes.
// ================================================================

(function () {
  'use strict';

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  /**
   * Normalize a weight vector so its elements sum to 1.0 (L1 norm)
   */
  function normalizeL1(weights) {
    const sum = Object.values(weights).reduce((a, b) => a + Math.abs(b), 0);
    if (!sum || sum === 0) return { ...weights };
    const out = {};
    for (const [k, v] of Object.entries(weights)) {
      out[k] = v / sum;
    }
    return out;
  }

  /**
   * Dot product between two weight vectors
   */
  function dotProduct(v1, v2) {
    let dot = 0;
    for (const k of Object.keys(v1)) {
      if (v2[k] !== undefined) {
        dot += v1[k] * v2[k];
      }
    }
    return dot;
  }

  /**
   * L2 Vector Magnitude
   */
  function vectorMagnitude(v) {
    const sumSq = Object.values(v).reduce((acc, val) => acc + val * val, 0);
    return Math.sqrt(sumSq) || 1;
  }

  /**
   * SLERP — Spherical Linear Interpolation between two weight vectors v0 and v1.
   * Preserves directional geometry and relative conviction without linear flattening.
   * @param {Record<string, number>} v0 - Base weight vector
   * @param {Record<string, number>} v1 - Target regime / adaptive weight vector
   * @param {number} t - Interpolation fraction [0, 1]
   */
  function slerp(v0, v1, t = 0.5) {
    const keys = Array.from(new Set([...Object.keys(v0), ...Object.keys(v1)]));
    const mag0 = vectorMagnitude(v0);
    const mag1 = vectorMagnitude(v1);

    // Normalized unit vectors
    const u0 = {}, u1 = {};
    keys.forEach(k => {
      u0[k] = (v0[k] || 0) / mag0;
      u1[k] = (v1[k] || 0) / mag1;
    });

    let dot = dotProduct(u0, u1);
    dot = clamp(dot, -1.0, 1.0);

    // If vectors are nearly identical, fall back to linear interpolation
    if (Math.abs(dot) > 0.9995) {
      const out = {};
      keys.forEach(k => {
        out[k] = (1 - t) * (v0[k] || 0) + t * (v1[k] || 0);
      });
      return normalizeL1(out);
    }

    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const scale0 = Math.sin((1 - t) * theta) / sinTheta;
    const scale1 = Math.sin(t * theta) / sinTheta;

    const interpolatedMag = (1 - t) * mag0 + t * mag1;
    const out = {};
    keys.forEach(k => {
      const unitVal = scale0 * u0[k] + scale1 * u1[k];
      out[k] = Math.max(0, unitVal * interpolatedMag);
    });

    return normalizeL1(out);
  }

  /**
   * DARE — Drop And REscale pruning for noisy indicators
   * Drops indicators with empirical accuracy below threshold and rescales remaining weights.
   * @param {Record<string, number>} weights - Weight vector
   * @param {Record<string, number>} accuracies - Indicator accuracies [0, 100]
   * @param {number} dropThreshold - Minimum accuracy required to participate (e.g. 50%)
   * @param {number} boostThreshold - Accuracy threshold to receive amplification (e.g. 60%)
   */
  function darePruneAndRescale(weights, accuracies = {}, dropThreshold = 50.0, boostThreshold = 60.0) {
    const out = {};
    let keptSum = 0;

    for (const [k, w] of Object.entries(weights)) {
      const acc = accuracies[k];
      if (acc != null && acc < dropThreshold) {
        // Drop noisy voter
        out[k] = 0;
      } else if (acc != null && acc >= boostThreshold) {
        // Amplify proven high-accuracy voter
        const boost = 1.0 + (acc - boostThreshold) / 40.0;
        out[k] = w * boost;
        keptSum += out[k];
      } else {
        out[k] = w;
        keptSum += out[k];
      }
    }

    if (keptSum > 0) {
      for (const k of Object.keys(out)) {
        out[k] = out[k] / keptSum;
      }
    }

    return out;
  }

  /**
   * Ensemble Merging: Combines Base Weights, Regime Multipliers, and 3-5m Pre-Open Horizon Weights
   */
  function mergeModelWeights(baseWeights, coinBias = {}, regimeMults = {}, options = {}) {
    const merged = { ...baseWeights };
    const t = options.slerpT ?? 0.35;
    const accuracies = options.accuracies || null;

    // Apply coin-specific empirical biases
    for (const [k, bias] of Object.entries(coinBias)) {
      if (merged[k] !== undefined) {
        merged[k] *= bias;
      }
    }

    // Apply regime multipliers
    const regimeTarget = { ...merged };
    for (const [k, mult] of Object.entries(regimeMults)) {
      if (regimeTarget[k] !== undefined) {
        regimeTarget[k] *= mult;
      }
    }

    // Perform SLERP interpolation to avoid linear collapse
    let slerped = slerp(merged, regimeTarget, t);

    // Apply DARE pruning if accuracy statistics are provided
    if (accuracies && typeof accuracies === 'object') {
      slerped = darePruneAndRescale(slerped, accuracies, options.dropThreshold || 50, options.boostThreshold || 60);
    }

    return slerped;
  }

  window.PredictionWeightMergeKit = {
    slerp,
    darePruneAndRescale,
    mergeModelWeights,
    normalizeL1,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.PredictionWeightMergeKit;
  }
})();
