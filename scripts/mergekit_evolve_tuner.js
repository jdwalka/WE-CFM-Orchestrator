#!/usr/bin/env node
// ================================================================
// WE|||CRYPTO — MergeKit Evolutionary Weight & Hyperparameter Tuner (Node.js)
// Optimizes model merge methods, hyperparameters, and feature weights
// against historical accuracy and Brier score for 5m & 15m crypto contracts.
// ================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const {
  slerp,
  multiSlerp,
  dellaMerge,
  tiesMerge,
  sceMerge,
  nearswap,
  arceeFusion,
  lookaheadTrajectoryEstimate,
  normalizeL1,
  generateMergeKitYaml,
} = require('../src/core/predictions/weight-mergekit');

const INDICATOR_KEYS = [
  'ema', 'hma', 'vwap', 'obv', 'bands', 'williamsR', 'momentum',
  'volume', 'flow', 'book', 'macd', 'rsi', 'stochrsi', 'cci',
  'fearGreed', 'imbalanceVelocity', 'tradeFlow', 'toxicity', 'spoof', 'iceberg'
];

const BASE_WEIGHTS = {
  book: 0.22,
  flow: 0.20,
  momentum: 0.12,
  volume: 0.08,
  ema: 0.06,
  hma: 0.05,
  vwap: 0.05,
  macd: 0.05,
  rsi: 0.04,
  obv: 0.03,
  bands: 0.03,
  williamsR: 0.02,
  stochrsi: 0.02,
  cci: 0.01,
  fearGreed: 0.01,
  imbalanceVelocity: 0.005,
  tradeFlow: 0.005,
  toxicity: 0.002,
  spoof: 0.002,
  iceberg: 0.002,
};

const REGIME_WEIGHT_MULTS = {
  trending_smooth: { ema: 1.5, hma: 1.4, vwap: 1.3, obv: 1.2, bands: 0.7, williamsR: 0.7, momentum: 0.5 },
  trending_volatile: { volume: 1.5, flow: 1.4, book: 1.3, macd: 1.2, ema: 1.1, bands: 0.8, momentum: 2.0 },
  ranging: { bands: 1.6, williamsR: 1.5, cci: 1.4, rsi: 1.3, stochrsi: 1.3, ema: 0.7, hma: 0.6, momentum: 0.1 },
  choppy: { book: 0.4, flow: 0.4, macd: 0.5, ema: 0.6, bands: 0.6, momentum: 0.3 },
  neutral: {},
};

const MERGE_METHODS = ['della', 'sce', 'nearswap', 'arcee_fusion', 'ties', 'slerp'];

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function randUniform(min, max) {
  return min + Math.random() * (max - min);
}

function randGauss(mean = 0, stdev = 1) {
  let u = 1 - Math.random();
  let v = Math.random();
  let z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + z * stdev;
}

function generateSyntheticHistoricalDataset(numSamples = 200, horizon = 15) {
  const regimes = ['trending_smooth', 'trending_volatile', 'ranging', 'choppy', 'neutral'];
  const coins = ['BTC', 'ETH', 'SOL', 'XRP'];
  const samples = [];

  for (let i = 0; i < numSamples; i++) {
    const regime = regimes[Math.floor(Math.random() * regimes.length)];
    const coin = coins[Math.floor(Math.random() * coins.length)];
    const minsRemaining = Number((1.0 + Math.random() * 13.5).toFixed(1));

    const trueBias = (Math.random() < 0.5 ? -1 : 1) * randUniform(0.1, 0.8);
    const signalVec = {};
    INDICATOR_KEYS.forEach(k => {
      signalVec[k] = clamp(trueBias + randGauss(0, 0.3), -1.0, 1.0);
    });

    const vel = clamp(trueBias * 0.5 + randGauss(0, 0.2), -1.0, 1.0);
    const accel = clamp(vel * 0.4 + randGauss(0, 0.1), -1.0, 1.0);
    const ratio = clamp(0.5 + trueBias * 0.2 + randGauss(0, 0.08), 0.1, 0.9);

    const finalMove = trueBias * 15.0 + randGauss(0, 6.0);
    const actualOutcome = finalMove > 0 ? 1 : 0;

    samples.push({
      id: `rec_${String(i).padStart(4, '0')}`,
      coin,
      horizon,
      regime,
      signals: signalVec,
      tapeVelocity: { velocity: vel, acceleration: accel },
      bookImbalance: { ratio },
      minutesRemaining: minsRemaining,
      actualOutcome,
      priceChangeBps: Number(finalMove.toFixed(2)),
    });
  }
  return samples;
}

class Genome {
  constructor(method = 'della') {
    this.method = method;
    this.slerpT = randUniform(0.2, 0.8);
    this.density = randUniform(0.5, 0.95);
    this.epsilon = randUniform(0.005, 0.04);
    this.tau = randUniform(0.45, 0.80);
    this.varianceScale = randUniform(10.0, 45.0);
    this.deadband = randUniform(0.008, 0.030);
    this.iqrMult = randUniform(0.9, 1.8);
    this.topK = randUniform(0.5, 0.9);
    this.lambda = randUniform(0.7, 1.3);

    this.weightsMult = {};
    INDICATOR_KEYS.forEach(k => {
      this.weightsMult[k] = randUniform(0.6, 1.6);
    });

    this.fitness = 0.0;
    this.brierScore = 1.0;
    this.accuracy = 0.0;
    this.ece = 1.0;
  }

  clone() {
    const copy = new Genome(this.method);
    copy.slerpT = this.slerpT;
    copy.density = this.density;
    copy.epsilon = this.epsilon;
    copy.tau = this.tau;
    copy.varianceScale = this.varianceScale;
    copy.deadband = this.deadband;
    copy.iqrMult = this.iqrMult;
    copy.topK = this.topK;
    copy.lambda = this.lambda;
    copy.weightsMult = { ...this.weightsMult };
    copy.fitness = this.fitness;
    copy.brierScore = this.brierScore;
    copy.accuracy = this.accuracy;
    copy.ece = this.ece;
    return copy;
  }

  mutate(rate = 0.20) {
    if (Math.random() < 0.15) {
      this.method = MERGE_METHODS[Math.floor(Math.random() * MERGE_METHODS.length)];
    }
    if (Math.random() < rate) this.slerpT = clamp(this.slerpT + randGauss(0, 0.08), 0.1, 0.9);
    if (Math.random() < rate) this.density = clamp(this.density + randGauss(0, 0.06), 0.3, 0.98);
    if (Math.random() < rate) this.epsilon = clamp(this.epsilon + randGauss(0, 0.005), 0.002, 0.05);
    if (Math.random() < rate) this.tau = clamp(this.tau + randGauss(0, 0.05), 0.35, 0.90);
    if (Math.random() < rate) this.varianceScale = clamp(this.varianceScale + randGauss(0, 4.0), 5.0, 60.0);
    if (Math.random() < rate) this.deadband = clamp(this.deadband + randGauss(0, 0.004), 0.005, 0.045);
    if (Math.random() < rate) this.iqrMult = clamp(this.iqrMult + randGauss(0, 0.12), 0.7, 2.5);

    INDICATOR_KEYS.forEach(k => {
      if (Math.random() < rate) {
        this.weightsMult[k] = clamp(this.weightsMult[k] + randGauss(0, 0.15), 0.2, 3.0);
      }
    });
  }

  static crossover(p1, p2) {
    const child = new Genome(Math.random() < 0.5 ? p1.method : p2.method);
    const alpha = Math.random();

    child.slerpT = clamp(alpha * p1.slerpT + (1 - alpha) * p2.slerpT, 0.1, 0.9);
    child.density = clamp(alpha * p1.density + (1 - alpha) * p2.density, 0.3, 0.98);
    child.epsilon = clamp(alpha * p1.epsilon + (1 - alpha) * p2.epsilon, 0.002, 0.05);
    child.tau = clamp(alpha * p1.tau + (1 - alpha) * p2.tau, 0.35, 0.90);
    child.varianceScale = clamp(alpha * p1.varianceScale + (1 - alpha) * p2.varianceScale, 5.0, 60.0);
    child.deadband = clamp(alpha * p1.deadband + (1 - alpha) * p2.deadband, 0.005, 0.045);
    child.iqrMult = clamp(alpha * p1.iqrMult + (1 - alpha) * p2.iqrMult, 0.7, 2.5);

    INDICATOR_KEYS.forEach(k => {
      child.weightsMult[k] = Math.random() < 0.5 ? p1.weightsMult[k] : p2.weightsMult[k];
    });

    return child;
  }
}

function evaluateIndividual(individual, dataset) {
  const rawWeights = {};
  for (const [k, baseW] of Object.entries(BASE_WEIGHTS)) {
    const mult = individual.weightsMult[k] ?? 1.0;
    rawWeights[k] = baseW * mult;
  }
  const baseNormalized = normalizeL1(rawWeights);

  const sqErrors = [];
  let correctCount = 0;
  const predictions = [];
  const actuals = [];

  for (const sample of dataset) {
    const regime = sample.regime || 'neutral';
    const regimeMults = REGIME_WEIGHT_MULTS[regime] || {};

    const regimeTarget = {};
    for (const k of Object.keys(baseNormalized)) {
      regimeTarget[k] = baseNormalized[k] * (regimeMults[k] ?? 1.0);
    }
    const normTarget = normalizeL1(regimeTarget);

    let effective;
    const method = individual.method;
    if (method === 'della') {
      const slerped = slerp(baseNormalized, normTarget, individual.slerpT);
      effective = dellaMerge(baseNormalized, slerped, { density: individual.density, epsilon: individual.epsilon });
    } else if (method === 'sce') {
      effective = sceMerge(baseNormalized, [normTarget], { varianceScale: individual.varianceScale });
    } else if (method === 'nearswap') {
      effective = nearswap(baseNormalized, normTarget, individual.tau);
    } else if (method === 'arcee_fusion') {
      effective = arceeFusion(baseNormalized, normTarget, { threshold: null });
    } else if (method === 'ties') {
      const diff = {};
      for (const k of Object.keys(baseNormalized)) {
        diff[k] = normTarget[k] - baseNormalized[k];
      }
      effective = tiesMerge(baseNormalized, [diff], { topK: individual.topK, lambda: individual.lambda });
    } else {
      effective = slerp(baseNormalized, normTarget, individual.slerpT);
    }

    const sigMap = sample.signals || {};
    let sumVal = 0, sumWeight = 0;
    for (const [k, val] of Object.entries(sigMap)) {
      const w = effective[k] ?? 0;
      sumVal += val * w;
      sumWeight += w;
    }
    const rawScore = sumWeight > 0 ? sumVal / sumWeight : 0;
    const probUp = clamp(0.5 + rawScore * 0.45, 0.05, 0.95);

    const traj = lookaheadTrajectoryEstimate(
      probUp,
      sample.tapeVelocity || {},
      sample.bookImbalance || {},
      sample.minutesRemaining ?? 15,
      { deadband: individual.deadband }
    );

    const pForecast = traj.tExp;
    const actual = sample.actualOutcome;

    sqErrors.push(Math.pow(pForecast - actual, 2));
    const predDir = pForecast >= 0.5 ? 1 : 0;
    if (predDir === actual) correctCount++;

    predictions.push(pForecast);
    actuals.push(actual);
  }

  const n = dataset.length || 1;
  const brier = sqErrors.reduce((a, b) => a + b, 0) / n;
  const acc = (correctCount / n) * 100.0;

  // Expected Calibration Error (ECE)
  const bins = Array.from({ length: 5 }, () => []);
  for (let i = 0; i < n; i++) {
    const binIdx = Math.min(4, Math.floor(predictions[i] * 5));
    bins[binIdx].push({ p: predictions[i], y: actuals[i] });
  }
  let ece = 0;
  for (const b of bins) {
    if (b.length > 0) {
      const avgP = b.reduce((s, x) => s + x.p, 0) / b.length;
      const avgY = b.reduce((s, x) => s + x.y, 0) / b.length;
      ece += (b.length / n) * Math.abs(avgP - avgY);
    }
  }

  const fitness = 100.0 * (1.0 - brier) * 0.45 + acc * 0.45 + 100.0 * (1.0 - ece) * 0.10;
  return { fitness, brier, acc, ece };
}

function runEvolutionaryOptimization(dataset, options = {}) {
  const generations = options.generations || 20;
  const popSize = options.popSize || 25;
  const eliteCount = options.eliteCount || 3;
  const mutationRate = options.mutationRate || 0.20;
  const preferredMethod = options.preferredMethod || null;

  console.log(`[*] Initializing Population: size=${popSize}, generations=${generations}, dataset_samples=${dataset.length}`);

  let population = [];
  for (let i = 0; i < popSize; i++) {
    const m = preferredMethod || MERGE_METHODS[Math.floor(Math.random() * MERGE_METHODS.length)];
    population.push(new Genome(m));
  }

  let bestEver = null;

  for (let gen = 1; gen <= generations; gen++) {
    for (const ind of population) {
      const evalRes = evaluateIndividual(ind, dataset);
      ind.fitness = evalRes.fitness;
      ind.brierScore = evalRes.brier;
      ind.accuracy = evalRes.acc;
      ind.ece = evalRes.ece;
    }

    population.sort((a, b) => b.fitness - a.fitness);
    const currentBest = population[0];

    if (!bestEver || currentBest.fitness > bestEver.fitness) {
      bestEver = currentBest.clone();
    }

    const avgFitness = population.reduce((s, x) => s + x.fitness, 0) / population.length;

    if (gen === 1 || gen % 5 === 0 || gen === generations) {
      console.log(
        `[Gen ${String(gen).padStart(2, '0')}/${String(generations).padStart(2, '0')}] ` +
        `Best Fit=${currentBest.fitness.toFixed(2)} (Acc=${currentBest.accuracy.toFixed(1)}%, Brier=${currentBest.brierScore.toFixed(4)}, ECE=${currentBest.ece.toFixed(3)}) | ` +
        `Avg Fit=${avgFitness.toFixed(2)} | Method=${currentBest.method.toUpperCase()}`
      );
    }

    const newPopulation = population.slice(0, eliteCount).map(x => x.clone());

    while (newPopulation.length < popSize) {
      const t1 = [
        population[Math.floor(Math.random() * population.length)],
        population[Math.floor(Math.random() * population.length)],
        population[Math.floor(Math.random() * population.length)],
      ];
      t1.sort((a, b) => b.fitness - a.fitness);
      const p1 = t1[0];

      const t2 = [
        population[Math.floor(Math.random() * population.length)],
        population[Math.floor(Math.random() * population.length)],
        population[Math.floor(Math.random() * population.length)],
      ];
      t2.sort((a, b) => b.fitness - a.fitness);
      const p2 = t2[0];

      const child = Genome.crossover(p1, p2);
      child.mutate(mutationRate);
      if (preferredMethod) child.method = preferredMethod;
      newPopulation.push(child);
    }

    population = newPopulation;
  }

  return bestEver;
}

function exportResults(best, outputJson, outputYaml) {
  const optimizedWeights = {};
  for (const [k, baseW] of Object.entries(BASE_WEIGHTS)) {
    const mult = best.weightsMult[k] ?? 1.0;
    optimizedWeights[k] = Number((baseW * mult).toFixed(5));
  }
  const normalized = normalizeL1(optimizedWeights);
  for (const k of Object.keys(normalized)) {
    normalized[k] = Number(normalized[k].toFixed(4));
  }

  const profile = {
    generator: 'WeCrypto MergeKit Evolutionary Tuner (Node.js)',
    method: best.method,
    fitness: Number(best.fitness.toFixed(3)),
    brier_score: Number(best.brierScore.toFixed(4)),
    accuracy_pct: Number(best.accuracy.toFixed(2)),
    ece: Number(best.ece.toFixed(4)),
    hyperparameters: {
      slerp_t: Number(best.slerpT.toFixed(3)),
      density: Number(best.density.toFixed(3)),
      epsilon: Number(best.epsilon.toFixed(4)),
      tau: Number(best.tau.toFixed(3)),
      variance_scale: Number(best.varianceScale.toFixed(2)),
      deadband: Number(best.deadband.toFixed(4)),
      iqr_multiplier: Number(best.iqrMult.toFixed(3)),
      top_k: Number(best.topK.toFixed(3)),
      lambda: Number(best.lambda.toFixed(3)),
    },
    optimized_indicator_weights: normalized,
  };

  if (outputJson) {
    fs.mkdirSync(path.dirname(path.resolve(outputJson)), { recursive: true });
    fs.writeFileSync(outputJson, JSON.stringify(profile, null, 2), 'utf8');
    console.log(`[OK] Saved optimized profile to ${outputJson}`);
  }

  if (outputYaml) {
    fs.mkdirSync(path.dirname(path.resolve(outputYaml)), { recursive: true });
    const yamlStr = generateMergeKitYaml({
      name: `Evolved ${best.method.toUpperCase()} Crypto Spec`,
      merge_method: best.method,
      base_model: 'models/crypto-base-foresight-8b',
      models: [
        { model: 'models/crypto-orderbook-specialist-8b', parameters: { weight: normalized.book || 0.30, density: Number(best.density.toFixed(3)) } },
        { model: 'models/crypto-flow-specialist-8b', parameters: { weight: normalized.flow || 0.25, density: Number(best.density.toFixed(3)) } },
        { model: 'models/crypto-momentum-specialist-8b', parameters: { weight: normalized.momentum || 0.20, density: Number(best.density.toFixed(3)) } },
      ],
      parameters: {
        density: Number(best.density.toFixed(3)),
        epsilon: Number(best.epsilon.toFixed(4)),
        tau: Number(best.tau.toFixed(3)),
        deadband: Number(best.deadband.toFixed(4)),
        normalize: true,
      },
    });
    fs.writeFileSync(outputYaml, yamlStr, 'utf8');
    console.log(`[OK] Saved MergeKit YAML recipe to ${outputYaml}`);
  }
}

// CLI entrypoint
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const generations = parseInt(getArg('--generations', '15'), 10);
  const popSize = parseInt(getArg('--pop-size', '20'), 10);
  const horizon = parseInt(getArg('--horizon', '15'), 10);
  const method = getArg('--method', null);
  const samplesCount = parseInt(getArg('--samples', '150'), 10);
  const outputJson = getArg('--output-json', 'configs/mergekit/evolved_weights_latest.json');
  const outputYaml = getArg('--output-yaml', 'configs/mergekit/evolved_mergekit_recipe.yaml');

  const dataset = generateSyntheticHistoricalDataset(samplesCount, horizon);
  console.log(`[*] Generated ${dataset.length} synthetic calibrated benchmark samples for ${horizon}m contracts`);

  const best = runEvolutionaryOptimization(dataset, {
    generations,
    popSize,
    preferredMethod: method,
  });

  console.log('\n================================================================');
  console.log('EVOLUTIONARY TUNING COMPLETED SUCCESSFULLY (Node.js)');
  console.log(`Winning Method: ${best.method.toUpperCase()}`);
  console.log(`Fitness Score:  ${best.fitness.toFixed(3)}`);
  console.log(`Brier Score:    ${best.brierScore.toFixed(4)} (Lower is better)`);
  console.log(`Accuracy:       ${best.accuracy.toFixed(2)}%`);
  console.log(`Calibration ECE:${best.ece.toFixed(4)}`);
  console.log(`Deadband Filter:${best.deadband.toFixed(4)}`);
  console.log('================================================================');

  exportResults(best, outputJson, outputYaml);
}

module.exports = {
  Genome,
  generateSyntheticHistoricalDataset,
  evaluateIndividual,
  runEvolutionaryOptimization,
  exportResults,
};
