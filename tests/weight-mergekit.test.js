/**
 * WE|||CRYPTO — Comprehensive MergeKit Model Ensembling & Lookahead Test Suite
 * Validates:
 *   - DELLA magnitude-aware pruning and delta rescaling
 *   - SCE variance-weighted parameter fusion
 *   - Nearswap similarity-based interpolation
 *   - Arcee Fusion importance-weighted model routing
 *   - Look-ahead trajectory forecasting & deadband stability
 *   - SLERP, Multi-SLERP, TIES-Merging, DARE, Task Arithmetic
 *   - Master orbital merging pipeline & diagnostics
 *   - Recipe generation, YAML serialization, and offline-online interoperability
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MergeKit = require('../src/core/predictions/weight-mergekit');
const RecipeGen = require('../configs/mergekit/recipe_generator');

// ================================================================
// 1. MATHEMATICAL & GEOMETRIC VECTOR INVARIANTS
// ================================================================

test('normalizeL1 produces non-negative weights that sum to 1.0 (L1 norm)', () => {
  const input = { book: 10, flow: 20, momentum: 10, ema: 10 };
  const normalized = MergeKit.normalizeL1(input);

  const sum = Object.values(normalized).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `Expected sum 1.0, got ${sum}`);

  for (const [k, v] of Object.entries(normalized)) {
    assert.ok(v >= 0, `Key ${k} should be non-negative: ${v}`);
  }
  assert.equal(normalized.flow, 0.4);
  assert.equal(normalized.book, 0.2);
});

test('vectorMagnitude and dotProduct satisfy Cauchy-Schwarz inequality', () => {
  const v1 = { a: 0.3, b: 0.4, c: 0.5 };
  const v2 = { a: 0.1, b: 0.8, c: 0.2 };

  const mag1 = MergeKit.vectorMagnitude(v1);
  const mag2 = MergeKit.vectorMagnitude(v2);
  const dot = MergeKit.dotProduct(v1, v2);

  assert.ok(dot <= mag1 * mag2 + 1e-6, 'Cauchy-Schwarz |u.v| <= ||u||*||v|| violated');
  assert.ok(mag1 > 0 && mag2 > 0, 'Magnitudes should be positive');
});

test('cosineSimilarity correctly computes directional alignment', () => {
  const v1 = { a: 1.0, b: 2.0, c: 3.0 };
  const v2 = { a: 2.0, b: 4.0, c: 6.0 }; // Identical direction
  const v3 = { a: 0.0, b: 0.0, c: 0.0 };

  const simIdentical = MergeKit.cosineSimilarity(v1, v2);
  assert.ok(Math.abs(simIdentical - 1.0) < 1e-4, `Expected sim ~1.0 for parallel, got ${simIdentical}`);

  const simZero = MergeKit.cosineSimilarity(v1, v3);
  assert.equal(simZero, 0.0, 'Zero vector similarity fallback');
});

// ================================================================
// 2. SLERP & MULTI-SLERP HYPERSPHERICAL INTERPOLATION
// ================================================================

test('slerp interpolates smoothly on hypersphere at t=0, t=0.5, t=1', () => {
  const base = { book: 0.6, flow: 0.4 };
  const target = { book: 0.2, flow: 0.8 };

  const slerp0 = MergeKit.slerp(base, target, 0.0);
  const slerpHalf = MergeKit.slerp(base, target, 0.5);
  const slerp1 = MergeKit.slerp(base, target, 1.0);

  // t=0 should match normalized base
  assert.ok(Math.abs(slerp0.book - 0.6) < 1e-3);
  assert.ok(Math.abs(slerp0.flow - 0.4) < 1e-3);

  // t=1 should match normalized target
  assert.ok(Math.abs(slerp1.book - 0.2) < 1e-3);
  assert.ok(Math.abs(slerp1.flow - 0.8) < 1e-3);

  // t=0.5 should be intermediate
  assert.ok(slerpHalf.book < slerp0.book && slerpHalf.book > slerp1.book);
  assert.ok(slerpHalf.flow > slerp0.flow && slerpHalf.flow < slerp1.flow);
});

test('multiSlerp performs barycentric reduction across >=3 models', () => {
  const m1 = { book: 0.8, flow: 0.2, mom: 0.0 };
  const m2 = { book: 0.2, flow: 0.8, mom: 0.0 };
  const m3 = { book: 0.0, flow: 0.2, mom: 0.8 };

  const blended = MergeKit.multiSlerp([m1, m2, m3], [0.33, 0.33, 0.34]);
  const sum = Object.values(blended).reduce((a, b) => a + b, 0);

  assert.ok(Math.abs(sum - 1.0) < 1e-4, 'Multi-SLERP sum must be 1.0');
  assert.ok(blended.book > 0.15, 'Book weight should be retained');
  assert.ok(blended.flow > 0.15, 'Flow weight should be retained');
  assert.ok(blended.mom > 0.15, 'Momentum weight should be retained');
});

// ================================================================
// 3. DELLA MAGNITUDE-AWARE PRUNING & DELTA RESCALING
// ================================================================

test('dellaMerge preserves high-magnitude deltas and prunes micro-noise below epsilon', () => {
  const base = {
    rsi: 0.20,
    macd: 0.20,
    flow: 0.30,
    noiseA: 0.15,
    noiseB: 0.15,
  };

  const target = {
    rsi: 0.50,    // High delta: +0.30 (Breakout)
    macd: 0.45,   // High delta: +0.25 (Surge)
    flow: 0.30,   // Zero delta: 0.00
    noiseA: 0.152,// Tiny noisy delta: +0.002
    noiseB: 0.149,// Tiny noisy delta: -0.001
  };

  const merged = MergeKit.dellaMerge(base, target, {
    density: 0.70,
    epsilon: 0.015,
  });

  assert.ok(merged._dellaMeta, 'DELLA must attach metadata');
  assert.ok(merged._dellaMeta.retentionPct > 0, 'Retention percentage should be recorded');
  assert.ok(merged._dellaMeta.maxDelta >= 0.25, `Expected max delta >= 0.25, got ${merged._dellaMeta.maxDelta}`);

  // RSI and MACD had major updates and must be preserved with strong weight
  assert.ok(merged.rsi > base.rsi, 'High-magnitude delta for RSI must be preserved');
  assert.ok(merged.macd > base.macd, 'High-magnitude delta for MACD must be preserved');

  // Total L1 sum must equal 1.0
  const sum = Object.values(merged).reduce((a, b) => (typeof b === 'number' ? a + b : a), 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-4, `L1 sum must be 1.0, got ${sum}`);
});

test('dellaMerge correctly rescales retained parameters by 1/pKeep for unbiased expectation', () => {
  const base = { signal1: 0.10, signal2: 0.10 };
  const target = { signal1: 0.40, signal2: 0.105 }; // signal1 has large delta

  const merged = MergeKit.dellaMerge(base, target, {
    density: 0.60,
    epsilon: 0.01,
  });

  // Signal1 should be significantly boosted through unbiased 1/pKeep delta rescaling
  assert.ok(merged.signal1 > target.signal1 * 0.8, 'Retained parameter must receive delta rescaling');
});

test('dellaMerge incorporates empirical accuracies into retention probability', () => {
  const base = { highAcc: 0.25, lowAcc: 0.25 };
  const target = { highAcc: 0.50, lowAcc: 0.50 };

  const accuracies = { highAcc: 75.0, lowAcc: 35.0 };

  const merged = MergeKit.dellaMerge(base, target, {
    density: 0.50,
    epsilon: 0.01,
    accuracies,
  });

  // highAcc has higher retention probability than lowAcc
  assert.ok(merged.highAcc > merged.lowAcc, `highAcc (${merged.highAcc}) should exceed lowAcc (${merged.lowAcc})`);
});

// ================================================================
// 4. SCE VARIANCE-WEIGHTED PARAMETER FUSION
// ================================================================

test('sceMerge reinforces low-variance consensus features and penalizes high-variance conflicts', () => {
  const base = { consensus: 0.25, conflicting: 0.25, neutral: 0.50 };

  // Candidate models agree strongly on consensus feature, but disagree wildly on conflicting feature
  const candidates = [
    { consensus: 0.40, conflicting: 0.90, neutral: 0.10 },
    { consensus: 0.41, conflicting: 0.05, neutral: 0.10 },
    { consensus: 0.39, conflicting: 0.85, neutral: 0.10 },
  ];

  const merged = MergeKit.sceMerge(base, candidates, { varianceScale: 30.0 });

  // Consensus has very low variance (~0.0001), while conflicting has huge variance (~0.16)
  // Therefore, consensus feature receives high stability weighting
  assert.ok(merged.consensus > 0.25, `Consensus feature should be reinforced, got ${merged.consensus}`);
  // Conflicting feature should be dampened towards baseline stability
  assert.ok(merged.conflicting < 0.35, `Conflicting feature should be penalized, got ${merged.conflicting}`);

  const sum = Object.values(merged).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-4, 'SCE output must sum to 1.0');
});

// ================================================================
// 5. NEARSWAP SIMILARITY-BASED INTERPOLATION
// ================================================================

test('nearswap interpolates agreeing parameters and preserves divergent specialist features', () => {
  const base = {
    agreeFeature: 0.30,
    specialistFeature: 0.40,
    commonFeature: 0.30,
  };

  const target = {
    agreeFeature: 0.32,      // High similarity: |0.30 - 0.32| / 0.62 ~ 0.032 -> sim ~ 0.968
    specialistFeature: 0.02, // Divergent: |0.40 - 0.02| / 0.42 ~ 0.905 -> sim ~ 0.095
    commonFeature: 0.28,     // High similarity: sim ~ 0.965
  };

  const tau = 0.65;
  const merged = MergeKit.nearswap(base, target, tau);

  assert.ok(merged._nearswapMeta, 'Nearswap must attach metadata');
  assert.equal(merged._nearswapMeta.swappedCount, 2, '2 features should have localSim >= tau');

  // Specialist feature was divergent (< tau), so target corruption was rejected and base was retained
  assert.ok(merged.specialistFeature > 0.30, `Specialist feature must be preserved, got ${merged.specialistFeature}`);
});

// ================================================================
// 6. ARCEE FUSION IMPORTANCE ROUTING (KL DIVERGENCE & DYNAMIC IQR)
// ================================================================

test('arceeFusion injects salient divergence above IQR threshold and keeps stable base weights', () => {
  const base = {
    macroAlpha: 0.05,
    pinDefense: 0.05,
    flow: 0.45,
    book: 0.45,
  };

  // Target has major salient divergence on macroAlpha and pinDefense
  const target = {
    macroAlpha: 0.40,
    pinDefense: 0.35,
    flow: 0.15,
    book: 0.10,
  };

  const merged = MergeKit.arceeFusion(base, target, { threshold: null });

  assert.ok(merged._arceeFusionMeta, 'Arcee Fusion must attach metadata');
  assert.ok(typeof merged._arceeFusionMeta.threshold === 'number', 'Threshold should be computed via IQR');
  assert.ok(merged._arceeFusionMeta.injectedCount > 0, 'Salient features should be injected');

  // macroAlpha and pinDefense should have been routed into the final composite
  assert.ok(merged.macroAlpha > base.macroAlpha, 'Macro Alpha salient divergence should be injected');
  assert.ok(merged.pinDefense > base.pinDefense, 'Pin Defense salient divergence should be injected');
});

// ================================================================
// 7. LOOKAHEAD TRAJECTORY FORECASTING & DEADBAND STABILITY
// ================================================================

test('lookaheadTrajectoryEstimate projects multi-horizon steps (T+1, T+2, T_EXP)', () => {
  const currentProb = 0.62;
  const tapeVel = { velocity: 0.4, acceleration: 0.1 };
  const bookImb = { ratio: 0.65 };
  const minsRemaining = 12.0;

  const traj = MergeKit.lookaheadTrajectoryEstimate(currentProb, tapeVel, bookImb, minsRemaining);

  assert.ok(traj.t1 >= 0.05 && traj.t1 <= 0.95, `T+1 out of bounds: ${traj.t1}`);
  assert.ok(traj.t2 >= 0.05 && traj.t2 <= 0.95, `T+2 out of bounds: ${traj.t2}`);
  assert.ok(traj.tExp >= 0.02 && traj.tExp <= 0.98, `T_EXP out of bounds: ${traj.tExp}`);
  assert.equal(typeof traj.isSweetSpot, 'boolean');
  assert.equal(typeof traj.directionAgreement, 'boolean');
  assert.equal(traj.directionAgreement, true, 'Direction agreement should be true for bullish confluence');
});

test('lookaheadTrajectoryEstimate activates sweet spot flag for 3.0m - 6.0m remaining', () => {
  const trajSweet = MergeKit.lookaheadTrajectoryEstimate(0.55, {}, {}, 4.5);
  assert.equal(trajSweet.isSweetSpot, true, '4.5m remaining should be sweet spot');

  const trajEarly = MergeKit.lookaheadTrajectoryEstimate(0.55, {}, {}, 12.0);
  assert.equal(trajEarly.isSweetSpot, false, '12m remaining is not sweet spot');

  const trajLate = MergeKit.lookaheadTrajectoryEstimate(0.55, {}, {}, 1.5);
  assert.equal(trajLate.isSweetSpot, false, '1.5m remaining is not sweet spot');
});

test('lookaheadTrajectoryEstimate deadband stability suppresses micro-noise and whipsaws', () => {
  const currentProb = 0.50;
  const deadbandThreshold = 0.025;

  // Sub-threshold micro-fluctuation jitter (tape noise + orderbook spread ping-pong)
  const microJitter1 = {
    tapeVel: { velocity: 0.015, acceleration: 0.005 },
    bookImb: { ratio: 0.508 }, // ratio delta: +0.008 -> flowBias = 0.0024 < 0.025
  };

  const trajStable = MergeKit.lookaheadTrajectoryEstimate(
    currentProb,
    microJitter1.tapeVel,
    microJitter1.bookImb,
    10.0,
    { deadband: deadbandThreshold }
  );

  assert.equal(trajStable.deadbandEngaged, true, 'Deadband must be engaged for sub-threshold noise');
  assert.equal(trajStable.t1, currentProb, 'T+1 must remain stable at currentProb under deadband');
  assert.equal(trajStable.t2, currentProb, 'T+2 must remain stable at currentProb under deadband');
  assert.equal(trajStable.tExp, currentProb, 'T_EXP must remain stable at currentProb under deadband');

  // Breakout beyond deadband threshold should disengage deadband and dynamically expand
  const breakout = {
    tapeVel: { velocity: 0.65, acceleration: 0.30 },
    bookImb: { ratio: 0.85 },
  };

  const trajBreakout = MergeKit.lookaheadTrajectoryEstimate(
    currentProb,
    breakout.tapeVel,
    breakout.bookImb,
    10.0,
    { deadband: deadbandThreshold }
  );

  assert.equal(trajBreakout.deadbandEngaged, false, 'Deadband must disengage on strong breakout');
  assert.ok(trajBreakout.tExp > currentProb + 0.05, `Trajectory must reflect strong bullish expansion: ${trajBreakout.tExp}`);
});

// ================================================================
// 8. TIES-MERGING, DARE & TASK ARITHMETIC
// ================================================================

test('tiesMerge trims smallest deltas, elects consensus sign, and disjoint merges', () => {
  const base = { sigA: 0.25, sigB: 0.25, sigC: 0.25, sigD: 0.25 };

  const delta1 = { sigA: 0.15, sigB: -0.10, sigC: 0.01, sigD: -0.01 };
  const delta2 = { sigA: 0.20, sigB: 0.05, sigC: -0.02, sigD: 0.01 };

  const merged = MergeKit.tiesMerge(base, [delta1, delta2], { topK: 0.5, lambda: 1.0 });

  assert.ok(merged.sigA > base.sigA, 'sigA had strong positive agreement and must increase');
  const sum = Object.values(merged).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-4, 'TIES output must sum to 1.0');
});

test('darePruneAndRescale drops low-accuracy indicators and boosts high-accuracy ones', () => {
  const weights = { goodSignal: 0.30, badSignal: 0.30, normalSignal: 0.40 };
  const accuracies = { goodSignal: 68.0, badSignal: 42.0, normalSignal: 55.0 };

  const pruned = MergeKit.darePruneAndRescale(weights, accuracies, 50.0, 60.0);

  assert.equal(pruned.badSignal, 0.0, 'badSignal (<50% acc) should be pruned to 0');
  assert.ok(pruned.goodSignal > weights.goodSignal, 'goodSignal (>=60% acc) should be boosted');
  const sum = Object.values(pruned).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-4, 'DARE output must sum to 1.0');
});

test('taskArithmeticMerge scales task vectors by alpha', () => {
  const base = { book: 0.5, flow: 0.5 };
  const tasks = [{ taskVector: { book: 0.2, flow: -0.1 }, alpha: 0.5 }];

  const merged = MergeKit.taskArithmeticMerge(base, tasks);

  assert.ok(merged.book > 0.5, 'Book should receive positive task delta');
  assert.ok(merged.flow < 0.5, 'Flow should receive negative task delta');
});

test('getPreOpenHorizonWeights boosts velocity and orderbook during final minutes', () => {
  const base = {
    imbalanceVelocity: 0.10,
    momentum: 0.10,
    vwap: 0.10,
    ema: 0.35,
    hma: 0.35,
  };

  const sniperWeights = MergeKit.getPreOpenHorizonWeights(base, 2.0); // 2m lead in (urgent)

  assert.ok(sniperWeights.imbalanceVelocity > base.imbalanceVelocity, 'Velocity should be boosted');
  assert.ok(sniperWeights.momentum > base.momentum, 'Momentum should be boosted');
  assert.ok(sniperWeights.ema < base.ema, 'Lagging EMA should be dampened');
});

// ================================================================
// 9. MASTER MERGING PIPELINE & DIAGNOSTICS STORE
// ================================================================

test('mergeModelWeights dispatches across all advanced merge methods', () => {
  const base = { book: 0.3, flow: 0.3, momentum: 0.2, ema: 0.2 };
  const coinBias = { BTC: 1.0 };
  const regimeMults = { book: 1.2, flow: 1.1 };

  const methods = ['della_slerp', 'della', 'sce', 'nearswap', 'arcee_fusion', 'ties', 'multi_slerp', 'classic'];

  for (const m of methods) {
    const res = MergeKit.mergeModelWeights(base, coinBias, regimeMults, {
      mergeMethod: m,
      sym: 'BTC',
      symbol: 'BTC',
    });

    const sum = Object.values(res).reduce((a, b) => (typeof b === 'number' ? a + b : a), 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-3, `Method ${m} weights must sum to 1.0, got ${sum}`);

    const diag = MergeKit.getMergeDiagnostics('BTC');
    assert.ok(diag, `Diagnostics must be recorded for method ${m}`);
    assert.ok(typeof diag.thetaDeg === 'number', 'thetaDeg must be numeric');
    assert.ok(typeof diag.sparsityPct === 'number', 'sparsityPct must be numeric');
  }
});

// ================================================================
// 10. MERGEKIT YAML CONFIGS, RECIPES & RUNTIME INTEROPERABILITY
// ================================================================

test('generateMergeKitYaml formats valid MergeKit recipe string', () => {
  const recipe = {
    merge_method: 'della',
    base_model: 'models/crypto-base-foresight-8b',
    dtype: 'bfloat16',
    models: [
      { model: 'models/crypto-orderbook-8b', parameters: { weight: 0.6, density: 0.75 } },
      { model: 'models/crypto-momentum-8b', parameters: { weight: 0.4, density: 0.70 } },
    ],
    parameters: { density: 0.75, epsilon: 0.015, normalize: true },
  };

  const yamlStr = MergeKit.generateMergeKitYaml(recipe);
  assert.ok(yamlStr.includes('merge_method: della'));
  assert.ok(yamlStr.includes('base_model: models/crypto-base-foresight-8b'));
  assert.ok(yamlStr.includes('models/crypto-orderbook-8b'));
  assert.ok(yamlStr.includes('density: 0.75'));
});

test('parseMergeKitYaml and executeMergeKitRecipe execute successfully at runtime', () => {
  const sampleYaml = `
merge_method: della
base_model: models/crypto-base-foresight-8b
dtype: bfloat16
models:
  - model: models/crypto-orderbook-8b
    parameters:
      weight: 0.60
      density: 0.75
parameters:
  density: 0.80
  epsilon: 0.01
`;

  const parsed = MergeKit.parseMergeKitYaml(sampleYaml);
  assert.equal(parsed.merge_method, 'della');
  assert.equal(parsed.base_model, 'models/crypto-base-foresight-8b');

  const baseWeights = { book: 0.4, flow: 0.4, mom: 0.2 };
  const targetWeights = { book: 0.7, flow: 0.2, mom: 0.1 };

  const executed = MergeKit.executeMergeKitRecipe(baseWeights, parsed, { targetWeights });
  const sum = Object.values(executed).reduce((a, b) => (typeof b === 'number' ? a + b : a), 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-4, 'Executed recipe must sum to 1.0');
});

test('all 7 preconfigured MergeKit YAML recipes in configs/mergekit/ are structurally valid', () => {
  const expectedRecipes = [
    'della_crypto_foresight.yaml',
    'sce_variance_fusion.yaml',
    'nearswap_specialist.yaml',
    'arcee_fusion_importance.yaml',
    'ties_orderbook_macro.yaml',
    'dare_ties_crypto_15m.yaml',
    'multi_slerp_ensemble.yaml',
  ];

  for (const filename of expectedRecipes) {
    const fullPath = path.join(__dirname, '..', 'configs', 'mergekit', filename);
    assert.ok(fs.existsSync(fullPath), `Recipe file ${filename} must exist`);

    const content = fs.readFileSync(fullPath, 'utf8');
    const parsed = MergeKit.parseMergeKitYaml(content);

    const val = RecipeGen.validateRecipe(parsed);
    assert.ok(val.valid, `Recipe ${filename} failed validation: ${val.errors.join(', ')}`);
    assert.ok(parsed.merge_method, `Recipe ${filename} missing merge_method`);
    assert.ok(parsed.models && parsed.models.length > 0, `Recipe ${filename} missing models`);
  }
});

test('offline evolutionary tuner output can be imported and consumed by runtime mergeModelWeights', () => {
  const evolvedJsonPath = path.join(__dirname, '..', 'configs', 'mergekit', 'evolved_weights_latest.json');
  assert.ok(fs.existsSync(evolvedJsonPath), 'evolved_weights_latest.json should exist from tuning run');

  const data = JSON.parse(fs.readFileSync(evolvedJsonPath, 'utf8'));
  assert.ok(data.optimized_indicator_weights, 'Tuner output must contain optimized_indicator_weights');
  assert.ok(data.hyperparameters, 'Tuner output must contain hyperparameters');

  const runtimeWeights = data.optimized_indicator_weights;
  const effective = MergeKit.mergeModelWeights(runtimeWeights, { BTC: 1.05 }, { book: 1.15 }, {
    mergeMethod: data.method,
    density: data.hyperparameters.density,
    epsilon: data.hyperparameters.epsilon,
    slerpT: data.hyperparameters.slerp_t,
    tau: data.hyperparameters.tau,
    sym: 'BTC',
  });

  const sum = Object.values(effective).reduce((a, b) => (typeof b === 'number' ? a + b : a), 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-4, 'Evolved weights merged in runtime must sum to 1.0');
});
