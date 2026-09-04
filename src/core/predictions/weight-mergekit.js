// ================================================================
// WE|||CRYPTO — MergeKit Advanced Model & Weight Ensembling Engine
// Implements:
//   - SLERP (Spherical Linear Interpolation) & Multi-SLERP
//   - DARE (Drop And REscale)
//   - DELLA (MAGPRUNE: Magnitude-based adaptive dropout & retention)
//   - TIES-Merging (Trim, Elect Sign, Disjoint Merge)
//   - SCE (Select, Calculate, Erase: Variance-based Matrix Weighting)
//   - Nearswap (Selective Cosine Similarity Interpolation)
//   - Arcee Fusion (Relative Entropy / KL-Divergence Importance Scoring)
//   - Task Arithmetic & Pre-Open Horizon (T+1) Sniper Ensembling
//   - Lookahead & Multi-Token Trajectory Estimation (Sub-100ms Kalshi 15M)
// ================================================================

(function (root, factory) {
  'use strict';
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const scope = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : root);
    scope.PredictionWeightMergeKit = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
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
    return Math.sqrt(sumSq);
  }

  /**
   * Cosine similarity between two vectors in weight/indicator space
   */
  function cosineSimilarity(v0, v1) {
    const mag0 = vectorMagnitude(v0);
    const mag1 = vectorMagnitude(v1);
    if (mag0 === 0 || mag1 === 0) return 0.0;
    return clamp(dotProduct(v0, v1) / (mag0 * mag1), -1.0, 1.0);
  }

  // ================================================================
  // 1. SLERP & MULTI-SLERP
  // ================================================================

  /**
   * SLERP — Spherical Linear Interpolation between two weight vectors v0 and v1.
   * Preserves directional geometry and relative conviction without linear flattening.
   * @param {Record<string, number>} v0 - Base weight vector
   * @param {Record<string, number>} v1 - Target regime / adaptive weight vector
   * @param {number} t - Interpolation fraction [0, 1]
   */
  function slerp(v0, v1, t = 0.5) {
    const keys = Array.from(new Set([...Object.keys(v0), ...Object.keys(v1)]));
    const mag0 = vectorMagnitude(v0) || 1e-8;
    const mag1 = vectorMagnitude(v1) || 1e-8;

    // Normalized unit vectors
    const u0 = {}, u1 = {};
    keys.forEach(k => {
      u0[k] = (v0[k] || 0) / mag0;
      u1[k] = (v1[k] || 0) / mag1;
    });

    let dot = dotProduct(u0, u1);
    dot = clamp(dot, -1.0, 1.0);

    // Fall back to linear interpolation if vectors are nearly parallel
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
   * Multi-SLERP — Barycentric interpolation on hypersphere for >=2 models
   */
  function multiSlerp(models = [], weights = []) {
    if (!models.length) return {};
    if (models.length === 1) return { ...models[0] };
    if (models.length === 2) {
      const t = weights[1] !== undefined ? weights[1] / ((weights[0] || 0) + (weights[1] || 1e-6)) : 0.5;
      return slerp(models[0], models[1], t);
    }

    // Successive pairwise spherical reduction
    let totalWeight = weights.reduce((a, b) => a + b, 0) || models.length;
    let accumulated = { ...models[0] };
    let currentWeight = weights[0] ?? (totalWeight / models.length);

    for (let i = 1; i < models.length; i++) {
      const nextWeight = weights[i] ?? (totalWeight / models.length);
      const stepT = nextWeight / (currentWeight + nextWeight);
      accumulated = slerp(accumulated, models[i], stepT);
      currentWeight += nextWeight;
    }
    return accumulated;
  }

  // ================================================================
  // 2. DARE (Drop And REscale)
  // ================================================================

  /**
   * DARE — Drop And REscale pruning for noisy indicators
   * Drops indicators with empirical accuracy below threshold and rescales remaining weights.
   */
  function darePruneAndRescale(weights, accuracies = {}, dropThreshold = 50.0, boostThreshold = 60.0) {
    const out = {};
    let keptSum = 0;

    for (const [k, w] of Object.entries(weights)) {
      const acc = accuracies[k];
      if (acc != null && acc < dropThreshold) {
        out[k] = 0;
      } else if (acc != null && acc >= boostThreshold) {
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

  // ================================================================
  // 3. DELLA (MAGPRUNE: Magnitude-based Adaptive Dropout & Retention)
  // ================================================================

  /**
   * DELLA-Merging with MAGPRUNE:
   * Rather than uniform random drops, parameters are prioritized by absolute delta magnitude.
   * High-magnitude deltas (e.g., active RSI/EMA breakouts, CVD surges) are preserved deterministically,
   * while small noisy variations receive higher dropout rates with exact rescaling 1/(1-p_drop).
   * @param {Record<string, number>} baseWeights
   * @param {Record<string, number>} targetWeights
   * @param {Object} options - { density: 0.75, epsilon: 0.01, accuracies: null }
   */
  function dellaMerge(baseWeights, targetWeights, options = {}) {
    const density = clamp(options.density ?? 0.75, 0.1, 1.0);
    const epsilon = options.epsilon ?? 0.01;
    const accuracies = options.accuracies || null;
    const keys = Array.from(new Set([...Object.keys(baseWeights), ...Object.keys(targetWeights)]));

    // Calculate deltas
    const deltas = {};
    let maxAbsDelta = 1e-8;
    keys.forEach(k => {
      const diff = (targetWeights[k] || 0) - (baseWeights[k] || 0);
      deltas[k] = diff;
      const absD = Math.abs(diff);
      if (absD > maxAbsDelta) maxAbsDelta = absD;
    });

    const mergedDeltas = {};
    let keptDeltasCount = 0;

    keys.forEach(k => {
      const d = deltas[k];
      const absD = Math.abs(d);
      
      // MAGPRUNE: Retention probability scales with delta magnitude
      const magScore = clamp((absD - epsilon) / (maxAbsDelta || 1), 0.0, 1.0);
      let pKeep = clamp(density * 0.5 + magScore * 0.5, 0.1, 1.0);

      // If accuracy statistics exist, factor into retention
      let accWeightMult = 1.0;
      if (accuracies && accuracies[k] != null) {
        if (accuracies[k] < (options.dropThreshold || 50)) {
          pKeep = 0.0; // Prune underperforming signals
        } else {
          const accBoost = (accuracies[k] - 50) / 100;
          pKeep = clamp(pKeep + accBoost, 0.5, 1.0);
          accWeightMult = 1.0 + accBoost;
        }
      }

      // DELLA retention logic
      const isHighMagnitude = absD >= maxAbsDelta * 0.75;
      const shouldKeep = pKeep >= 0.5 || (isHighMagnitude && (!accuracies || accuracies[k] >= (options.dropThreshold || 50)));

      if (shouldKeep && pKeep > 0) {
        // Rescale by 1/pKeep to maintain unbiased expected delta, boosted by accuracy
        mergedDeltas[k] = (d / Math.max(0.1, pKeep)) * accWeightMult;
        keptDeltasCount++;
      } else {
        // Pruned
        mergedDeltas[k] = 0;
      }
    });

    const out = {};
    keys.forEach(k => {
      out[k] = Math.max(0.001, (baseWeights[k] || 0) + (mergedDeltas[k] || 0));
    });

    const normalized = normalizeL1(out);
    normalized._dellaMeta = {
      keptCount: keptDeltasCount,
      totalCount: keys.length,
      retentionPct: (keptDeltasCount / (keys.length || 1)) * 100,
      maxDelta: maxAbsDelta,
    };
    return normalized;
  }

  // ================================================================
  // 4. TIES-Merging (TRIM, ELECT SIGN, AND DISJOINT MERGE)
  // ================================================================

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

  // ================================================================
  // 5. SCE (Select, Calculate, Erase: Variance-Based Dynamic Weighting)
  // ================================================================

  /**
   * SCE Merging:
   * 1. Select: Identify parameters exhibiting stable vs volatile conviction across models.
   * 2. Calculate: Apply variance-scaled root-mean-square weighting.
   * 3. Erase: Eliminate destructive sign cancellations.
   */
  function sceMerge(baseWeights, candidateModels = [], options = {}) {
    if (!candidateModels.length) return { ...baseWeights };
    const keys = Array.from(new Set([
      ...Object.keys(baseWeights),
      ...candidateModels.flatMap(m => Object.keys(m))
    ]));

    // Compute mean and variance for each key across models
    const stats = {};
    keys.forEach(k => {
      const values = candidateModels.map(m => m[k] ?? baseWeights[k] ?? 0);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      const rms = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
      stats[k] = { mean, variance, rms };
    });

    const varianceScale = options.varianceScale ?? 25.0;

    // Select & Calculate: higher weight given to low-variance consensus features,
    // Erase: penalize and attenuate high-variance conflicting signals
    const out = {};
    keys.forEach(k => {
      const s = stats[k];
      const baseVal = baseWeights[k] || 0;
      // Stability weight: inverse variance damped by varianceScale
      const stability = 1.0 / (1.0 + s.variance * varianceScale);
      // Erase dampening: sharply attenuates conflicting high-variance features
      const eraseFactor = Math.exp(-s.variance * varianceScale * 0.5);
      const dynamicWeight = (s.mean * stability + baseVal * (1.0 - stability)) * eraseFactor;
      out[k] = Math.max(0.005, dynamicWeight);
    });

    return normalizeL1(out);
  }

  // ================================================================
  // 6. NEARSWAP (Selective Similarity Interpolation)
  // ================================================================

  /**
   * Nearswap:
   * Selectively pulls parameters from a secondary model ONLY when they show sufficient
   * directional agreement (cosine similarity > tau), while preserving divergent specialist
   * parameters uncorrupted.
   */
  function nearswap(baseWeights, targetWeights, tau = 0.65) {
    const keys = Array.from(new Set([...Object.keys(baseWeights), ...Object.keys(targetWeights)]));
    const out = {};
    let swappedCount = 0;

    keys.forEach(k => {
      const w0 = baseWeights[k] || 0;
      const w1 = targetWeights[k] || 0;
      const denom = Math.max(1e-6, Math.abs(w0) + Math.abs(w1));
      const localSim = 1.0 - Math.abs(w0 - w1) / denom;

      if (localSim >= tau) {
        // High agreement: blend smoothly
        out[k] = 0.5 * w0 + 0.5 * w1;
        swappedCount++;
      } else {
        // Divergent: retain base conviction without destructive dilution
        out[k] = w0;
      }
    });

    const normalized = normalizeL1(out);
    normalized._nearswapMeta = {
      swappedCount,
      totalCount: keys.length,
      agreementPct: (swappedCount / (keys.length || 1)) * 100,
    };
    return normalized;
  }

  // ================================================================
  // 7. ARCEE FUSION (Relative Entropy / KL-Importance Scoring & Dynamic IQR)
  // ================================================================

  /**
   * Arcee Fusion:
   * 1. Importance Scoring: Computes KL-divergence / relative entropy shift per feature.
   * 2. Dynamic Thresholding: Computes median + 1.5 * IQR on divergence scores.
   * 3. Selective Integration: Injects only the salient divergences above threshold.
   */
  function arceeFusion(baseWeights, targetWeights, options = {}) {
    const keys = Array.from(new Set([...Object.keys(baseWeights), ...Object.keys(targetWeights)]));
    const normBase = normalizeL1(baseWeights);
    const normTarget = normalizeL1(targetWeights);

    // 1. Importance Scoring via Relative Entropy contribution: p * log(p / q)
    const scores = [];
    const scoreMap = {};

    keys.forEach(k => {
      const p = Math.max(1e-5, normTarget[k] || 1e-5);
      const q = Math.max(1e-5, normBase[k] || 1e-5);
      const klContrib = Math.abs(p * Math.log(p / q)) + Math.abs(p - q);
      scoreMap[k] = klContrib;
      scores.push(klContrib);
    });

    // 2. Dynamic Threshold via Median + IQR
    scores.sort((a, b) => a - b);
    const n = scores.length;
    const q1 = scores[Math.floor(n * 0.25)] || 0;
    const median = n % 2 === 0
      ? ((scores[Math.floor(n / 2) - 1] || 0) + (scores[Math.floor(n / 2)] || 0)) / 2
      : (scores[Math.floor(n / 2)] || 0);
    const q3 = scores[Math.floor(n * 0.75)] || 0;
    const iqr = q3 - q1;
    const maxScore = scores[n - 1] || 0;
    const iqrMult = options.iqrMultiplier ?? 1.2;

    let threshold;
    if (options.threshold != null) {
      threshold = options.threshold;
    } else if (n <= 4) {
      threshold = median;
    } else {
      threshold = Math.min(maxScore * 0.95, median + iqrMult * iqr);
    }

    // 3. Selective Integration
    const out = {};
    let injectedCount = 0;

    keys.forEach(k => {
      const score = scoreMap[k];
      if (score >= threshold) {
        // High salient divergence: inject target enhancement
        out[k] = targetWeights[k] ?? baseWeights[k];
        injectedCount++;
      } else {
        // Below threshold: keep stable base weight
        out[k] = baseWeights[k] || 0;
      }
    });

    const normalized = normalizeL1(out);
    normalized._arceeFusionMeta = {
      threshold,
      injectedCount,
      totalCount: keys.length,
      fusionPct: (injectedCount / (keys.length || 1)) * 100,
    };
    return normalized;
  }

  // ================================================================
  // 8. TASK ARITHMETIC & PRE-OPEN SNIPER HORIZON
  // ================================================================

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

  function getPreOpenHorizonWeights(baseWeights, leadInMinutes = 3.5) {
    const weights = { ...baseWeights };
    const urgencyBoost = clamp((5 - leadInMinutes) / 5, 0.2, 1.0);

    if (weights.imbalanceVelocity !== undefined) weights.imbalanceVelocity *= (1 + 0.85 * urgencyBoost);
    if (weights.momentum !== undefined) weights.momentum *= (1 + 0.65 * urgencyBoost);
    if (weights.vwap !== undefined) weights.vwap *= (1 + 0.40 * urgencyBoost);
    if (weights.tradeFlow !== undefined) weights.tradeFlow *= (1 + 0.50 * urgencyBoost);
    if (weights.book !== undefined) weights.book *= (1 + 0.60 * urgencyBoost);

    if (weights.ema !== undefined) weights.ema *= (1 - 0.40 * urgencyBoost);
    if (weights.hma !== undefined) weights.hma *= (1 - 0.30 * urgencyBoost);

    return normalizeL1(weights);
  }

  // ================================================================
  // 9. LOOKAHEAD & MULTI-TOKEN TRAJECTORY ESTIMATION
  // ================================================================

  /**
   * Lookahead Trajectory Estimation (Sub-100ms Kalshi 15M):
   * Projects candle and modelProbUp forward across T+1 (5m), T+2 (10m), and T+3 (15m expiration)
   * in a single pass without draft model overhead.
   * @param {number} currentProbUp - Current modelProbUp [0, 1]
   * @param {Object} tapeVelocity - Tape velocity & delta dynamics
   * @param {Object} bookImbalance - CLOB micro-imbalance
   * @param {number} minutesRemaining - Contract minutes remaining (e.g. 3.5m)
   */
  /**
   * Lookahead Trajectory Estimation (Sub-100ms Kalshi 15M):
   * Projects candle and modelProbUp forward across T+1 (5m), T+2 (10m), and T+3 (15m expiration)
   * in a single pass without draft model overhead.
   * Includes deadband stability filtering to suppress micro-noise and whipsaws near strike price.
   * @param {number} currentProbUp - Current modelProbUp [0, 1]
   * @param {Object} tapeVelocity - Tape velocity & delta dynamics
   * @param {Object} bookImbalance - CLOB micro-imbalance
   * @param {number} minutesRemaining - Contract minutes remaining (e.g. 3.5m)
   * @param {Object} options - Optional config { deadband: 0.015, minProb: 0.02, maxProb: 0.98 }
   */
  function lookaheadTrajectoryEstimate(currentProbUp, tapeVelocity = {}, bookImbalance = {}, minutesRemaining = 15, options = {}) {
    const vel = tapeVelocity.velocity || 0;
    const accel = tapeVelocity.acceleration || 0;
    const imbRatio = bookImbalance.ratio ?? 0.5; // >0.5 bid heavy, <0.5 ask heavy

    const isSweetSpot = minutesRemaining >= 3.0 && minutesRemaining <= 6.0;

    // Multi-horizon lookahead steps (T+1 = 1m, T+5 = 5m, T_EXP = Expiry)
    const decayFactor = clamp(minutesRemaining / 15.0, 0.15, 1.0);
    let flowBias = (imbRatio - 0.5) * 0.30;
    let momBias = (vel * 0.6 + accel * 0.4) * 0.25;

    // Deadband stability filter: suppresses minor micro-fluctuations and whipsaw noise
    const deadband = options.deadband ?? options.deadbandThreshold ?? 0.015;
    let deadbandEngaged = false;

    if (Math.abs(flowBias) < deadband) {
      flowBias = 0;
      deadbandEngaged = true;
    }
    if (Math.abs(momBias) < deadband) {
      momBias = 0;
      deadbandEngaged = true;
    }

    const netDelta = flowBias * 0.7 + momBias * 0.3;
    if (Math.abs(netDelta) < deadband) {
      deadbandEngaged = true;
    }

    const minP = options.minProb ?? 0.02;
    const maxP = options.maxProb ?? 0.98;

    const t1 = clamp(currentProbUp + (flowBias * 0.7 + momBias * 0.3) * (1 / decayFactor), 0.05, 0.95);
    const t2 = clamp(currentProbUp + (flowBias * 0.4 + momBias * 0.6), 0.05, 0.95);
    const tExp = clamp(currentProbUp + (flowBias * 0.2 + momBias * 0.8) * decayFactor, minP, maxP);

    return {
      t1: Number(t1.toFixed(3)),
      t2: Number(t2.toFixed(3)),
      tExp: Number(tExp.toFixed(3)),
      isSweetSpot,
      confidenceVelocity: Math.abs(t1 - currentProbUp),
      directionAgreement: Math.sign(tExp - 0.5) === Math.sign(currentProbUp - 0.5),
      deadbandEngaged,
      decayFactor: Number(decayFactor.toFixed(3)),
    };
  }

  // ================================================================
  // 10. MASTER ORBITAL WEIGHT MERGING PIPELINE
  // ================================================================

  /**
   * Master Model Ensembling:
   * Coordinates DELLA magnitude pruning, SCE variance weighting, SLERP hypersphere interpolation,
   * Nearswap similarity, Arcee Fusion, TIES, Multi-SLERP, and Pre-Open Horizon sniper ensembling.
   */
  function mergeModelWeights(baseWeights, coinBias = {}, regimeMults = {}, options = {}) {
    const merged = { ...baseWeights };
    const method = options.mergeMethod || (typeof window !== 'undefined' && window.MERGEKIT_METHOD) || 'della_slerp';
    const t = options.slerpT ?? (typeof window !== 'undefined' && Number.isFinite(window.MERGEKIT_SLERP_T) ? window.MERGEKIT_SLERP_T : 0.50);
    const accuracies = options.accuracies || null;
    const isPreOpen = !!options.isPreOpen;
    const leadInMins = options.leadInMinutes ?? 3.5;

    // 1. Apply coin-specific empirical biases
    for (const [k, bias] of Object.entries(coinBias)) {
      if (merged[k] !== undefined) {
        merged[k] *= bias;
      }
    }

    // 2. Build regime target vector
    let regimeTarget = { ...merged };
    for (const [k, mult] of Object.entries(regimeMults)) {
      if (regimeTarget[k] !== undefined) {
        regimeTarget[k] *= mult;
      }
    }

    // 3. Pre-Open Horizon sniper vector blending
    if (isPreOpen) {
      const sniperVector = getPreOpenHorizonWeights(regimeTarget, leadInMins);
      regimeTarget = slerp(regimeTarget, sniperVector, 0.45);
    }

    let finalWeights;

    // 4. Dispatch to selected advanced merge method
    if (method === 'della_slerp' || method === 'della') {
      // First apply SLERP along hypersphere
      const slerped = slerp(merged, regimeTarget, t);
      // Then apply DELLA magnitude-aware retention
      finalWeights = dellaMerge(merged, slerped, {
        density: options.density ?? 0.80,
        epsilon: options.epsilon ?? 0.015,
        accuracies,
      });
    } else if (method === 'arcee_fusion') {
      finalWeights = arceeFusion(merged, regimeTarget, options);
    } else if (method === 'sce') {
      finalWeights = sceMerge(merged, [regimeTarget], options);
    } else if (method === 'nearswap') {
      finalWeights = nearswap(merged, regimeTarget, options.tau ?? 0.65);
    } else if (method === 'ties' || method === 'dare_ties') {
      const diffVector = {};
      for (const k of Object.keys(regimeTarget)) {
        diffVector[k] = (regimeTarget[k] || 0) - (merged[k] || 0);
      }
      finalWeights = tiesMerge(merged, [diffVector], options);
    } else if (method === 'multi_slerp') {
      const models = [merged, regimeTarget, ...(options.auxiliaryModels || [])];
      finalWeights = multiSlerp(models, options.weights || []);
    } else if (method === 'task_arithmetic') {
      const tasks = options.tasks || [{ taskVector: regimeTarget, alpha: options.alpha ?? 0.5 }];
      finalWeights = taskArithmeticMerge(merged, tasks);
    } else if (method === 'dare') {
      finalWeights = darePruneAndRescale(regimeTarget, accuracies || {}, options.dropThreshold || 50, options.boostThreshold || 60);
    } else {
      // Classic SLERP + DARE fallback
      let slerped = slerp(merged, regimeTarget, t);
      if (accuracies && typeof accuracies === 'object') {
        slerped = darePruneAndRescale(slerped, accuracies, options.dropThreshold || 50, options.boostThreshold || 60);
      }
      finalWeights = slerped;
    }

    // Calculate spherical angle theta between merged and regimeTarget
    const cosTheta = cosineSimilarity(merged, regimeTarget);
    const thetaRad = Math.acos(clamp(cosTheta, -1.0, 1.0));
    const thetaDeg = (thetaRad * 180) / Math.PI;

    // Diagnostics calculation
    const sym = options.sym || options.symbol || null;
    if (sym) {
      const sparsityPct = finalWeights._dellaMeta
        ? 100 - (finalWeights._dellaMeta.retentionPct || 100)
        : finalWeights._arceeFusionMeta
          ? 100 - (finalWeights._arceeFusionMeta.fusionPct || 100)
          : finalWeights._nearswapMeta
            ? 100 - (finalWeights._nearswapMeta.agreementPct || 100)
            : (1 - (Object.values(finalWeights).filter(v => v > 0.01).length / Math.max(1, Object.keys(finalWeights).length))) * 100;

      recordMergeDiagnostics(sym, {
        method,
        thetaDeg,
        sparsityPct,
        meta: finalWeights._dellaMeta || finalWeights._arceeFusionMeta || finalWeights._nearswapMeta || null,
        t,
      });
    }

    return finalWeights;
  }

  // Diagnostics store
  const _diagnosticsStore = {};

  function recordMergeDiagnostics(sym, diag) {
    if (!sym) return;
    _diagnosticsStore[String(sym).toUpperCase()] = {
      ...diag,
      updatedAt: Date.now(),
    };
  }

  function getMergeDiagnostics(sym) {
    return _diagnosticsStore[String(sym).toUpperCase()] || null;
  }

  // ================================================================
  // 11. MERGEKIT RECIPE YAML BUILDER & RUNTIME INTEROPERABILITY
  // ================================================================

  /**
   * Generates a standard MergeKit YAML recipe string from configuration parameters.
   * Suitable for external MergeKit / mergekit-evolve execution.
   */
  function generateMergeKitYaml(recipe) {
    const method = recipe.merge_method || recipe.method || 'della';
    const baseModel = recipe.base_model || recipe.baseModel || 'models/crypto-base-foresight-8b';
    const dtype = recipe.dtype || 'bfloat16';
    const models = recipe.models || [];
    const params = recipe.parameters || {};

    let yaml = `# ================================================================\n`;
    yaml += `# MergeKit Recipe: ${recipe.name || method.toUpperCase() + ' Crypto Foresight'}\n`;
    yaml += `# Generated by WeCrypto MergeKit Engine (G:\\WECRYP)\n`;
    yaml += `# Application: 5-minute & 15-minute crypto prediction contracts\n`;
    yaml += `# ================================================================\n\n`;
    yaml += `merge_method: ${method}\n`;
    yaml += `base_model: ${baseModel}\n`;
    yaml += `dtype: ${dtype}\n\n`;

    if (models.length > 0) {
      yaml += `models:\n`;
      models.forEach(m => {
        yaml += `  - model: ${m.model || m.name}\n`;
        if (m.parameters && Object.keys(m.parameters).length > 0) {
          yaml += `    parameters:\n`;
          for (const [k, v] of Object.entries(m.parameters)) {
            if (Array.isArray(v)) {
              yaml += `      ${k}: [${v.join(', ')}]\n`;
            } else if (typeof v === 'number') {
              yaml += `      ${k}: ${Number.isInteger(v) ? v : Number(v.toFixed(4))}\n`;
            } else {
              yaml += `      ${k}: ${v}\n`;
            }
          }
        }
      });
      yaml += `\n`;
    }

    if (Object.keys(params).length > 0) {
      yaml += `parameters:\n`;
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) {
          yaml += `  ${k}: [${v.join(', ')}]\n`;
        } else if (typeof v === 'number') {
          yaml += `  ${k}: ${Number.isInteger(v) ? v : Number(v.toFixed(4))}\n`;
        } else {
          yaml += `  ${k}: ${v}\n`;
        }
      }
    }

    return yaml;
  }

  /**
   * Minimalist parser for MergeKit YAML configs
   */
  function parseMergeKitYaml(yamlStr) {
    if (typeof yamlStr !== 'string' || !yamlStr.trim()) return {};
    
    // Try js-yaml if available in environment
    if (typeof require === 'function') {
      try {
        const jsyaml = require('js-yaml');
        if (jsyaml && typeof jsyaml.load === 'function') {
          return jsyaml.load(yamlStr);
        }
      } catch (_) {}
    }

    // Fallback simple line-based parser
    const out = { models: [], parameters: {} };
    let currentSection = null;
    let currentModel = null;

    const lines = yamlStr.split('\n');
    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      if (line.startsWith('merge_method:')) {
        out.merge_method = line.split(':')[1].trim();
      } else if (line.startsWith('base_model:')) {
        out.base_model = line.split(':')[1].trim();
      } else if (line.startsWith('dtype:')) {
        out.dtype = line.split(':')[1].trim();
      } else if (line === 'models:') {
        currentSection = 'models';
      } else if (line === 'parameters:') {
        currentSection = 'parameters';
      } else if (currentSection === 'models' && line.startsWith('- model:')) {
        currentModel = { model: line.replace('- model:', '').trim(), parameters: {} };
        out.models.push(currentModel);
      } else if (currentModel && line.startsWith('parameters:')) {
        // model parameters section
      } else if (currentModel && rawLine.startsWith('      ')) {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join(':').trim();
          currentModel.parameters[key] = isNaN(Number(val)) ? (val === 'true' ? true : val === 'false' ? false : val) : Number(val);
        }
      } else if (currentSection === 'parameters' && rawLine.startsWith('  ')) {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join(':').trim();
          out.parameters[key] = isNaN(Number(val)) ? (val === 'true' ? true : val === 'false' ? false : val) : Number(val);
        }
      }
    }
    return out;
  }

  /**
   * Executes a MergeKit recipe directly on runtime weight representations.
   */
  function executeMergeKitRecipe(baseWeights, recipeConfig, options = {}) {
    const method = recipeConfig.merge_method || recipeConfig.method || 'della';
    const params = { ...(recipeConfig.parameters || {}), ...options };

    if (method === 'della' || method === 'della_slerp') {
      const target = recipeConfig.targetWeights || options.targetWeights || baseWeights;
      return dellaMerge(baseWeights, target, {
        density: params.density ?? 0.75,
        epsilon: params.epsilon ?? 0.01,
      });
    }

    if (method === 'sce') {
      const candidates = recipeConfig.candidateModels || options.candidateModels || [options.targetWeights || baseWeights];
      return sceMerge(baseWeights, candidates, params);
    }

    if (method === 'nearswap') {
      const target = recipeConfig.targetWeights || options.targetWeights || baseWeights;
      return nearswap(baseWeights, target, params.tau ?? 0.65);
    }

    if (method === 'arcee_fusion') {
      const target = recipeConfig.targetWeights || options.targetWeights || baseWeights;
      return arceeFusion(baseWeights, target, params);
    }

    if (method === 'ties' || method === 'dare_ties') {
      const deltas = recipeConfig.deltaVectors || options.deltaVectors || [];
      return tiesMerge(baseWeights, deltas, params);
    }

    if (method === 'multi_slerp') {
      const models = recipeConfig.models || options.models || [baseWeights];
      const weights = recipeConfig.weights || options.weights || [];
      return multiSlerp(models, weights);
    }

    // Default SLERP
    const target = recipeConfig.targetWeights || options.targetWeights || baseWeights;
    return slerp(baseWeights, target, params.t ?? 0.5);
  }

  return {
    slerp,
    multiSlerp,
    darePruneAndRescale,
    dellaMerge,
    tiesMerge,
    sceMerge,
    nearswap,
    arceeFusion,
    taskArithmeticMerge,
    getPreOpenHorizonWeights,
    lookaheadTrajectoryEstimate,
    mergeModelWeights,
    normalizeL1,
    dotProduct,
    cosineSimilarity,
    vectorMagnitude,
    recordMergeDiagnostics,
    getMergeDiagnostics,
    generateMergeKitYaml,
    parseMergeKitYaml,
    executeMergeKitRecipe,
  };
});

