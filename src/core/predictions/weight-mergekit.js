// ================================================================
// WE|||CRYPTO — MergeKit Advanced Model & Weight Ensembling Engine
// Implements SLERP (Spherical Linear Interpolation), DARE (Drop And REscale),
// TIES-Merging (Trim, Elect Sign, Merge), Task Arithmetic, and
// Pre-Open Horizon (T+1) Sniper Ensembling across all feature domains.
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
      out[k] = Math.max(0, v / sum);
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

    // Fall back to linear interpolation if vectors are nearly parallel
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
   * TIES-Merging (TRIM, ELECT SIGN, AND MERGE)
   * Resolves parameter sign interference across diverse market models / regimes:
   * 1. Trim: keeps top-K% largest magnitude parameter changes.
   * 2. Elect Sign: selects dominant direction for each parameter across models.
   * 3. Disjoint Merge: averages only the deltas that agree with the elected sign.
   * @param {Record<string, number>} baseWeights - Base foundational model weights
   * @param {Array<Record<string, number>>} deltaVectors - Array of specialized model delta vectors
   * @param {Object} options - { topK: 0.75, lambda: 1.0 }
   */
  function tiesMerge(baseWeights, deltaVectors = [], options = {}) {
    const topK = options.topK ?? 0.75;
    const lambda = options.lambda ?? 1.0;
    const keys = Object.keys(baseWeights);

    if (!deltaVectors.length) return { ...baseWeights };

    // 1. Trim smallest deltas per vector
    const trimmedDeltas = deltaVectors.map(vec => {
      const entries = Object.entries(vec);
      entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      const keepCount = Math.max(1, Math.floor(entries.length * topK));
      const keptKeys = new Set(entries.slice(0, keepCount).map(e => e[0]));
      const out = {};
      for (const [k, v] of entries) {
        out[k] = keptKeys.has(k) ? v : 0;
      }
      return out;
    });

    // 2. Elect Sign for each parameter
    const electedSign = {};
    keys.forEach(k => {
      const sumDelta = trimmedDeltas.reduce((acc, d) => acc + (d[k] || 0), 0);
      electedSign[k] = sumDelta > 0 ? 1 : sumDelta < 0 ? -1 : 0;
    });

    // 3. Disjoint Merge (average only the deltas that agree with elected sign)
    const mergedDeltas = {};
    keys.forEach(k => {
      const targetSign = electedSign[k];
      if (targetSign === 0) {
        mergedDeltas[k] = 0;
        return;
      }
      const agreeing = trimmedDeltas
        .map(d => d[k] || 0)
        .filter(val => (val > 0 && targetSign > 0) || (val < 0 && targetSign < 0));
      mergedDeltas[k] = agreeing.length
        ? (agreeing.reduce((a, b) => a + b, 0) / agreeing.length) * lambda
        : 0;
    });

    // Apply merged delta to base weights
    const finalWeights = {};
    keys.forEach(k => {
      finalWeights[k] = Math.max(0.01, (baseWeights[k] || 0) + (mergedDeltas[k] || 0));
    });

    return normalizeL1(finalWeights);
  }

  /**
   * Task Arithmetic: Merges regime task vectors with tunable scaling coefficients
   * w_final = w_base + sum(alpha_i * tau_i)
   */
  function taskArithmeticMerge(baseWeights, tasks = []) {
    const finalWeights = { ...baseWeights };
    tasks.forEach(({ taskVector, alpha = 0.5 }) => {
      for (const [k, delta] of Object.entries(taskVector || {})) {
        if (finalWeights[k] !== undefined) {
          finalWeights[k] = Math.max(0.01, finalWeights[k] + alpha * delta);
        }
      }
    });
    return normalizeL1(finalWeights);
  }

  /**
   * Pre-Open Horizon (T+1) Sniper Weight Vector
   * Heightens order flow velocity, surge, and momentum weights during 3-5m lead-in to contract open.
   */
  function getPreOpenHorizonWeights(baseWeights, leadInMinutes = 3.5) {
    const weights = { ...baseWeights };
    const urgencyBoost = clamp((5 - leadInMinutes) / 5, 0.2, 1.0);

    // Boost early sniper velocity drivers
    if (weights.imbalanceVelocity !== undefined) weights.imbalanceVelocity *= (1 + 0.85 * urgencyBoost);
    if (weights.momentum !== undefined) weights.momentum *= (1 + 0.65 * urgencyBoost);
    if (weights.vwap !== undefined) weights.vwap *= (1 + 0.40 * urgencyBoost);
    if (weights.tradeFlow !== undefined) weights.tradeFlow *= (1 + 0.50 * urgencyBoost);
    if (weights.book !== undefined) weights.book *= (1 + 0.60 * urgencyBoost);

    // Dampen lagging indicators
    if (weights.ema !== undefined) weights.ema *= (1 - 0.40 * urgencyBoost);
    if (weights.hma !== undefined) weights.hma *= (1 - 0.30 * urgencyBoost);

    return normalizeL1(weights);
  }

  /**
   * Master Model Ensembling: Combines Base Weights, Regime Multipliers,
   * TIES sign-resolution, DARE pruning, and Pre-Open Horizon weighting.
   * Ensemble Merging: Combines Base Weights, Regime Multipliers, and 3-5m Pre-Open Horizon Weights
   */
  function mergeModelWeights(baseWeights, coinBias = {}, regimeMults = {}, options = {}) {
    const merged = { ...baseWeights };
    const t = options.slerpT ?? 0.35;
    const accuracies = options.accuracies || null;
    const isPreOpen = !!options.isPreOpen;
    const leadInMins = options.leadInMinutes ?? 3.5;

    // Apply coin-specific empirical biases
    for (const [k, bias] of Object.entries(coinBias)) {
      if (merged[k] !== undefined) {
        merged[k] *= bias;
      }
    }

    // Build regime target vector
    let regimeTarget = { ...merged };
    // Apply regime multipliers
    const regimeTarget = { ...merged };
    for (const [k, mult] of Object.entries(regimeMults)) {
      if (regimeTarget[k] !== undefined) {
        regimeTarget[k] *= mult;
      }
    }

    // If pre-open 3-5m horizon is active, blend in sniper vector
    if (isPreOpen) {
      const sniperVector = getPreOpenHorizonWeights(regimeTarget, leadInMins);
      regimeTarget = slerp(regimeTarget, sniperVector, 0.45);
    }

    // SLERP interpolation across hypersphere
    let slerped = slerp(merged, regimeTarget, t);

    // DARE Pruning
    // Perform SLERP interpolation to avoid linear collapse
    let slerped = slerp(merged, regimeTarget, t);

    // Apply DARE pruning if accuracy statistics are provided
    if (accuracies && typeof accuracies === 'object') {
      slerped = darePruneAndRescale(slerped, accuracies, options.dropThreshold || 50, options.boostThreshold || 60);
    }

    return slerped;
  }

  const _diagnosticsStore = {};

  function recordMergeDiagnostics(sym, diag) {
    _diagnosticsStore[String(sym).toUpperCase()] = {
      ...diag,
      updatedAt: Date.now(),
    };
  }

  function getMergeDiagnostics(sym) {
    return _diagnosticsStore[String(sym).toUpperCase()] || null;
  }

  window.PredictionWeightMergeKit = {
    slerp,
    darePruneAndRescale,
    tiesMerge,
    taskArithmeticMerge,
    getPreOpenHorizonWeights,
    mergeModelWeights,
    normalizeL1,
    recordMergeDiagnostics,
    getMergeDiagnostics,
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
