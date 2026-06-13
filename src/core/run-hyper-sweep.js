#!/usr/bin/env node
'use strict';

/**
 * Offline regime-multiplier hyperparameter sweep.
 *
 * Uses local WECRYPTO/data JSONL logs only:
 *   - predictions.jsonl: model score + RSI at decision time
 *   - cfm_snapshots.jsonl: localized Pyth/CFM price history proxies
 *   - resolver_outcomes.jsonl: resolved Kalshi/Pyth settlement direction
 *
 * Example:
 *   node src/core/run-hyper-sweep.js --coins=BTC,ETH,SOL,XRP --min-oos=50
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_DATA_ROOTS = [
  path.join(ROOT, 'WECRYPTO-data'),
  path.join(ROOT, 'data'),
].filter((p) => fs.existsSync(p));

const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const REGIMES = ['trending_smooth', 'trending_volatile', 'ranging', 'choppy', 'neutral'];
const TARGET_FEATURES = ['rsi', 'ema', 'vwap', 'whaleAccumulation'];

const BASE_FEATURE_WEIGHTS = {
  model: 0.66,
  rsi: 0.12,
  ema: 0.12,
  vwap: 0.07,
  whaleAccumulation: 0.03,
};

const PRODUCTION_REGIME_MULTS = {
  trending_smooth: {
    ema: 1.3, hma: 1.4, vwap: 1.7, obv: 1.2, bands: 0.7,
    williamsR: 0.7, momentum: 0.5, whaleAccumulation: 1.1, dexFlow: 1.2, rsi: 0.8,
  },
  trending_volatile: {
    volume: 1.5, flow: 1.4, book: 1.3, macd: 1.2, ema: 0.9,
    bands: 0.8, momentum: 2.0, ofi: 1.5, microPrice: 1.5,
    whaleAccumulation: 1.5, dexFlow: 1.5, rsi: 0.8, vwap: 1.5,
  },
  ranging: {
    bands: 1.6, williamsR: 1.5, cci: 1.4, rsi: 1.8, stochrsi: 1.3,
    ema: 0.5, hma: 0.6, momentum: 0.1, whaleAccumulation: 1.2, dexFlow: 1.5, vwap: 1.2,
  },
  choppy: {
    book: 0.4, flow: 0.4, macd: 0.5, ema: 0.6, bands: 0.6,
    momentum: 0.3, ofi: 0.5, microPrice: 0.5, whaleAccumulation: 2.0, dexFlow: 2.0,
    rsi: 1.0, vwap: 1.0,
  },
  neutral: { whaleAccumulation: 1.0, dexFlow: 2.0, rsi: 1.0, ema: 1.0, vwap: 1.0 },
};

const REGIME_PROFILES = {
  trending_smooth: [
    { label: 'prod', rsi: 0.8, ema: 1.3, vwap: 1.7, whaleAccumulation: 1.1 },
    { label: 'trend-ema', rsi: 0.7, ema: 1.8, vwap: 1.2, whaleAccumulation: 1.0 },
    { label: 'trend-balanced', rsi: 0.9, ema: 1.6, vwap: 1.4, whaleAccumulation: 1.2 },
    { label: 'trend-vwap', rsi: 0.8, ema: 1.3, vwap: 1.7, whaleAccumulation: 1.1 },
    { label: 'trend-flow', rsi: 0.8, ema: 1.4, vwap: 1.2, whaleAccumulation: 1.7 },
  ],
  trending_volatile: [
    { label: 'prod', rsi: 0.8, ema: 0.9, vwap: 1.5, whaleAccumulation: 1.5 },
    { label: 'vol-damped-rsi', rsi: 0.5, ema: 1.1, vwap: 0.8, whaleAccumulation: 1.8 },
    { label: 'vol-price-leads', rsi: 0.7, ema: 1.4, vwap: 1.0, whaleAccumulation: 1.4 },
    { label: 'vol-vwap-revert', rsi: 0.8, ema: 0.9, vwap: 1.5, whaleAccumulation: 1.5 },
    { label: 'vol-whale', rsi: 0.6, ema: 1.0, vwap: 0.9, whaleAccumulation: 2.2 },
  ],
  ranging: [
    { label: 'prod', rsi: 1.8, ema: 0.5, vwap: 1.2, whaleAccumulation: 1.2 },
    { label: 'range-rsi', rsi: 1.8, ema: 0.5, vwap: 1.2, whaleAccumulation: 1.2 },
    { label: 'range-vwap', rsi: 1.4, ema: 0.5, vwap: 1.8, whaleAccumulation: 1.1 },
    { label: 'range-balanced', rsi: 1.5, ema: 0.7, vwap: 1.5, whaleAccumulation: 1.3 },
    { label: 'range-whale', rsi: 1.2, ema: 0.6, vwap: 1.1, whaleAccumulation: 2.0 },
  ],
  choppy: [
    { label: 'prod', rsi: 1.0, ema: 0.6, vwap: 1.0, whaleAccumulation: 2.0 },
    { label: 'chop-damp', rsi: 0.7, ema: 0.4, vwap: 0.8, whaleAccumulation: 1.6 },
    { label: 'chop-rsi', rsi: 1.3, ema: 0.4, vwap: 1.0, whaleAccumulation: 1.6 },
    { label: 'chop-vwap', rsi: 1.0, ema: 0.5, vwap: 1.5, whaleAccumulation: 1.7 },
    { label: 'chop-whale', rsi: 0.8, ema: 0.4, vwap: 0.9, whaleAccumulation: 2.4 },
  ],
  neutral: [
    { label: 'prod', rsi: 1.0, ema: 1.0, vwap: 1.0, whaleAccumulation: 1.0 },
    { label: 'neutral-balanced', rsi: 1.0, ema: 1.0, vwap: 1.0, whaleAccumulation: 1.0 },
    { label: 'neutral-rsi', rsi: 1.4, ema: 0.8, vwap: 1.1, whaleAccumulation: 1.5 },
    { label: 'neutral-trend', rsi: 0.8, ema: 1.4, vwap: 1.1, whaleAccumulation: 1.4 },
    { label: 'neutral-flow', rsi: 0.8, ema: 1.0, vwap: 1.0, whaleAccumulation: 2.4 },
  ],
};

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    dataRoots: DEFAULT_DATA_ROOTS,
    coins: DEFAULT_COINS,
    trainRatio: 0.7,
    minOos: 50,
    minOosTrades: 12,
    decisionThreshold: 0.05,
    maxLookbackMs: 25 * 60 * 1000,
    out: path.join(ROOT, 'backtest-logs', `hyper-sweep-${Date.now()}.json`),
  };

  for (const arg of argv) {
    const [rawKey, rawValue] = arg.replace(/^--/, '').split('=');
    const key = rawKey.trim();
    const value = rawValue == null ? 'true' : rawValue.trim();
    if (key === 'data-root') parsed.dataRoots = [path.resolve(ROOT, value)];
    if (key === 'data-roots') parsed.dataRoots = value.split(',').map((v) => path.resolve(ROOT, v.trim())).filter(Boolean);
    if (key === 'coins') parsed.coins = value.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
    if (key === 'train-ratio') parsed.trainRatio = clamp(Number(value), 0.5, 0.9);
    if (key === 'min-oos') parsed.minOos = Number(value);
    if (key === 'min-oos-trades') parsed.minOosTrades = Number(value);
    if (key === 'threshold') parsed.decisionThreshold = Number(value);
    if (key === 'out') parsed.out = path.resolve(ROOT, value);
  }
  return parsed;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (_) {
      // Skip corrupt partial writes.
    }
  }
  return rows;
}

function listDayDirs(root) {
  if (!root || !fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function lowerBoundByTs(rows, ts) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid].ts || 0) <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function normalizePrediction(row) {
  const sym = String(row.sym || row.coin || '').toUpperCase();
  const ts = Number(row.ts || row.timestamp || row.time);
  if (!sym || !Number.isFinite(ts)) return null;
  const score = Number(row.score ?? row.modelScore ?? 0);
  return {
    sym,
    ts,
    score: Number.isFinite(score) ? clamp(score, -1, 1) : 0,
    rsi: Number(row.rsi ?? row.indicators?.rsi?.value),
    vwapDev: Number(row.vwapDev ?? row.indicators?.vwap?.value),
    dir: row.dir || row.signal || null,
  };
}

function normalizeOutcome(row) {
  const sym = String(row.sym || row.coin || '').toUpperCase();
  const ts = Number(row.ts || row.timestamp || row.resolvedAt);
  const outcome = String(row.outcome || row.actualDirection || '').toUpperCase();
  if (!sym || !Number.isFinite(ts) || !['UP', 'DOWN', 'YES', 'NO'].includes(outcome)) return null;
  let direction = outcome;
  if (outcome === 'YES' || outcome === 'NO') {
    const strike = String(row.strikeDir || row.strikeType || 'above').toLowerCase();
    const yesDir = strike === 'below' ? 'DOWN' : 'UP';
    direction = outcome === 'YES' ? yesDir : (yesDir === 'UP' ? 'DOWN' : 'UP');
  }
  return {
    sym,
    ts,
    direction,
    ticker: row.ticker || row.marketTicker || null,
    floorPrice: Number(row.floorPrice ?? row.settlementPrice),
  };
}

function normalizeCfmSnapshot(row) {
  const ts = Number(row.ts || row.timestamp);
  if (!Number.isFinite(ts) || !row.snap || typeof row.snap !== 'object') return [];
  const out = [];
  for (const [symRaw, data] of Object.entries(row.snap)) {
    const sym = String(symRaw || '').toUpperCase();
    if (!sym || sym.startsWith('_') || !data) continue;
    const price = Number(data.cfmRate ?? data.price ?? data.last);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({
      sym,
      ts,
      price,
      momentum: Number(data.momentum || 0),
      sourceCount: Number(data.sourceCount || 0),
      trend: String(data.trend || 'flat').toLowerCase(),
    });
  }
  return out;
}

function loadLocalDataset(options) {
  const predictions = new Map();
  const outcomes = new Map();
  const cfm = new Map();

  function addBySym(map, row, dedupeKey) {
    if (!map.has(row.sym)) map.set(row.sym, new Map());
    map.get(row.sym).set(dedupeKey, row);
  }

  for (const root of options.dataRoots) {
    for (const dayDir of listDayDirs(root)) {
      for (const raw of readJsonl(path.join(dayDir, 'predictions.jsonl'))) {
        const row = normalizePrediction(raw);
        if (!row || !options.coins.includes(row.sym)) continue;
        addBySym(predictions, row, `${row.sym}:${row.ts}:${row.score}:${row.rsi}`);
      }

      for (const raw of readJsonl(path.join(dayDir, 'resolver_outcomes.jsonl'))) {
        const row = normalizeOutcome(raw);
        if (!row || !options.coins.includes(row.sym)) continue;
        const slot = Math.floor(row.ts / (15 * 60 * 1000));
        const key = row.ticker || `${row.sym}:${slot}:${row.direction}:${row.floorPrice || ''}`;
        addBySym(outcomes, row, key);
      }

      for (const raw of readJsonl(path.join(dayDir, 'cfm_snapshots.jsonl'))) {
        for (const row of normalizeCfmSnapshot(raw)) {
          if (!options.coins.includes(row.sym)) continue;
          addBySym(cfm, row, `${row.sym}:${row.ts}:${row.price}`);
        }
      }
    }
  }

  const materialize = (map) => {
    const out = new Map();
    for (const [sym, keyed] of map.entries()) {
      out.set(sym, Array.from(keyed.values()).sort((a, b) => a.ts - b.ts));
    }
    return out;
  };

  return {
    predictions: materialize(predictions),
    outcomes: materialize(outcomes),
    cfm: materialize(cfm),
  };
}

function average(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const avg = average(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length);
}

function ema(values, period) {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let current = values[0];
  for (let i = 1; i < values.length; i++) current = values[i] * k + current * (1 - k);
  return current;
}

function calcRsi(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  const slice = prices.slice(-period - 1);
  for (let i = 1; i < slice.length; i++) {
    const delta = slice[i] - slice[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  if (loss === 0) return gain > 0 ? 100 : 50;
  const rs = gain / loss;
  return 100 - (100 / (1 + rs));
}

function classifyRegime(history) {
  if (history.length < 12) return 'neutral';
  const recent = history.slice(-32);
  const prices = recent.map((r) => r.price);
  const first = prices[0];
  const last = prices[prices.length - 1];
  if (!first || !last) return 'neutral';

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const trendPct = (last - first) / first;
  const vol = stdDev(returns);
  const avgAbs = average(returns.map((v) => Math.abs(v)));

  if (Math.abs(trendPct) >= 0.006 && (vol >= 0.0018 || avgAbs >= 0.0012)) return 'trending_volatile';
  if (Math.abs(trendPct) >= 0.004) return 'trending_smooth';
  if (vol >= 0.0022 || avgAbs >= 0.0016) return 'choppy';
  if (Math.abs(trendPct) <= 0.0015 && vol <= 0.0012) return 'ranging';
  return 'neutral';
}

function deriveFeatures(prediction, history) {
  const prices = history.map((r) => r.price);
  const current = prices[prices.length - 1];
  const latest = history[history.length - 1] || {};
  const rsiValue = Number.isFinite(prediction.rsi) ? prediction.rsi : calcRsi(prices);
  const emaFast = ema(prices.slice(-24), 9);
  const emaSlow = ema(prices.slice(-48), 21);
  const vwap = average(prices.slice(-24));
  const trendDir = latest.trend === 'rising' ? 1 : latest.trend === 'falling' ? -1 : 0;
  const momentumDir = clamp(Number(latest.momentum || 0) / 0.15, -1, 1);
  const sourceStrength = clamp((Number(latest.sourceCount || 0) - 3) / 4, 0, 1);

  return {
    rsi: clamp((rsiValue - 50) / 25, -1, 1),
    ema: current ? clamp(((emaFast - emaSlow) / current) * 160, -1, 1) : 0,
    vwap: current ? clamp(((vwap - current) / current) * 120, -1, 1) : 0,
    whaleAccumulation: clamp((trendDir * 0.55 + momentumDir * 0.45) * Math.max(0.25, sourceStrength), -1, 1),
  };
}

function buildSamples(dataset, options) {
  const samples = [];
  for (const sym of options.coins) {
    const predictions = dataset.predictions.get(sym) || [];
    const outcomes = dataset.outcomes.get(sym) || [];
    const cfm = dataset.cfm.get(sym) || [];
    if (!predictions.length || !outcomes.length || cfm.length < 20) continue;

    for (const outcome of outcomes) {
      const predIdx = lowerBoundByTs(predictions, outcome.ts - 15_000);
      if (predIdx < 0) continue;
      const prediction = predictions[predIdx];
      if (outcome.ts - prediction.ts > options.maxLookbackMs) continue;

      const cfmIdx = lowerBoundByTs(cfm, prediction.ts);
      if (cfmIdx < 20) continue;
      const history = cfm.slice(Math.max(0, cfmIdx - 64), cfmIdx + 1);
      const features = deriveFeatures(prediction, history);
      const regime = classifyRegime(history);

      samples.push({
        sym,
        ts: prediction.ts,
        outcomeTs: outcome.ts,
        regime,
        direction: outcome.direction,
        modelScore: prediction.score,
        features,
      });
    }
  }
  return samples.sort((a, b) => a.outcomeTs - b.outcomeTs);
}

function mergeRegimeMults(profileByRegime) {
  const merged = JSON.parse(JSON.stringify(PRODUCTION_REGIME_MULTS));
  for (const regime of REGIMES) {
    merged[regime] = { ...(merged[regime] || {}), ...(profileByRegime[regime] || {}) };
    if (Number.isFinite(merged[regime].whaleAccumulation) && !Number.isFinite(merged[regime].dexFlow)) {
      merged[regime].dexFlow = merged[regime].whaleAccumulation;
    }
  }
  return merged;
}

function* cartesianProfiles(regimes, index = 0, selected = {}) {
  if (index >= regimes.length) {
    yield { ...selected };
    return;
  }
  const regime = regimes[index];
  for (const profile of REGIME_PROFILES[regime]) {
    selected[regime] = profile;
    yield* cartesianProfiles(regimes, index + 1, selected);
  }
}

function predict(sample, regimeMults, threshold) {
  const mults = regimeMults[sample.regime] || regimeMults.neutral || {};
  let score = sample.modelScore * BASE_FEATURE_WEIGHTS.model;
  let total = BASE_FEATURE_WEIGHTS.model;

  for (const feature of TARGET_FEATURES) {
    const featureValue = Number(sample.features[feature] || 0);
    const baseWeight = BASE_FEATURE_WEIGHTS[feature] || 0;
    const mult = Number.isFinite(Number(mults[feature])) ? Number(mults[feature]) : 1;
    const effectiveWeight = baseWeight * clamp(mult, 0.05, 4.0);
    score += featureValue * effectiveWeight;
    total += Math.abs(effectiveWeight);
  }

  const normalized = total > 0 ? clamp(score / total, -1, 1) : 0;
  if (normalized > threshold) return { direction: 'UP', score: normalized };
  if (normalized < -threshold) return { direction: 'DOWN', score: normalized };
  return { direction: 'WAIT', score: normalized };
}

function evaluate(samples, regimeMults, threshold) {
  const byRegime = {};
  let wins = 0;
  let trades = 0;
  let waits = 0;

  for (const sample of samples) {
    const pred = predict(sample, regimeMults, threshold);
    if (!byRegime[sample.regime]) byRegime[sample.regime] = { wins: 0, trades: 0, waits: 0 };
    if (pred.direction === 'WAIT') {
      waits++;
      byRegime[sample.regime].waits++;
      continue;
    }
    trades++;
    byRegime[sample.regime].trades++;
    if (pred.direction === sample.direction) {
      wins++;
      byRegime[sample.regime].wins++;
    }
  }

  const decorate = (stats) => ({
    ...stats,
    winRate: stats.trades ? (stats.wins / stats.trades) * 100 : 0,
    coverage: samples.length ? (stats.trades / samples.length) * 100 : 0,
  });

  const regimes = {};
  for (const [regime, stats] of Object.entries(byRegime)) regimes[regime] = decorate(stats);
  return decorate({ wins, trades, waits, total: samples.length, regimes });
}

function objective(train, oos, options) {
  const minTarget = options.minOos;
  const oosPenalty = oos.winRate >= minTarget ? 0 : (minTarget - oos.winRate) * 4;
  const gapPenalty = Math.max(0, train.winRate - oos.winRate - 7) * 0.8;
  const countPenalty = oos.trades < options.minOosTrades ? (options.minOosTrades - oos.trades) * 2 : 0;
  return oos.winRate * 3 + train.winRate - oosPenalty - gapPenalty - countPenalty + Math.log10(oos.trades + 1) * 3;
}

function runSweep(samples, options) {
  const splitIdx = Math.max(1, Math.floor(samples.length * options.trainRatio));
  const trainSamples = samples.slice(0, splitIdx);
  const oosSamples = samples.slice(splitIdx);
  const results = [];

  for (const profiles of cartesianProfiles(REGIMES)) {
    const profileByRegime = {};
    const profileLabels = {};
    for (const regime of REGIMES) {
      const { label, ...profile } = profiles[regime];
      profileByRegime[regime] = profile;
      profileLabels[regime] = label;
    }
    const regimeMults = mergeRegimeMults(profileByRegime);
    const train = evaluate(trainSamples, regimeMults, options.decisionThreshold);
    const oos = evaluate(oosSamples, regimeMults, options.decisionThreshold);
    results.push({
      score: objective(train, oos, options),
      train,
      oos,
      profileLabels,
      regimeMults,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return {
    trainSamples: trainSamples.length,
    oosSamples: oosSamples.length,
    results,
    best: results[0] || null,
  };
}

function summarizeDataset(dataset, samples) {
  const byCoin = {};
  for (const sample of samples) {
    if (!byCoin[sample.sym]) byCoin[sample.sym] = { samples: 0, regimes: {} };
    byCoin[sample.sym].samples++;
    byCoin[sample.sym].regimes[sample.regime] = (byCoin[sample.sym].regimes[sample.regime] || 0) + 1;
  }
  return {
    predictions: Object.fromEntries(Array.from(dataset.predictions.entries()).map(([sym, rows]) => [sym, rows.length])),
    outcomes: Object.fromEntries(Array.from(dataset.outcomes.entries()).map(([sym, rows]) => [sym, rows.length])),
    cfm: Object.fromEntries(Array.from(dataset.cfm.entries()).map(([sym, rows]) => [sym, rows.length])),
    samplesByCoin: byCoin,
  };
}

function printTop(result, options) {
  const best = result.best;
  console.log('\nWECRYPTO regime hyperparameter sweep');
  console.log(`Samples: train=${result.trainSamples}, oos=${result.oosSamples}`);
  console.log(`Target OOS win rate: >= ${options.minOos.toFixed(1)}%`);
  console.log(`Configurations evaluated: ${result.results.length}`);

  if (!best) {
    console.log('No valid configurations evaluated.');
    return;
  }

  console.log('\nBest configuration:');
  console.log(`  train WR: ${best.train.winRate.toFixed(2)}% (${best.train.wins}/${best.train.trades}, coverage ${best.train.coverage.toFixed(1)}%)`);
  console.log(`  OOS WR:   ${best.oos.winRate.toFixed(2)}% (${best.oos.wins}/${best.oos.trades}, coverage ${best.oos.coverage.toFixed(1)}%)`);
  console.log(`  status:   ${best.oos.winRate >= options.minOos ? 'OOS_TARGET_MET' : 'OOS_TARGET_MISSED'}`);

  console.log('\nTop 5 OOS candidates:');
  result.results.slice(0, 5).forEach((candidate, idx) => {
    console.log(
      `  #${idx + 1} score=${candidate.score.toFixed(2)} train=${candidate.train.winRate.toFixed(2)}% ` +
      `oos=${candidate.oos.winRate.toFixed(2)}% trades=${candidate.oos.trades}`
    );
  });

  console.log('\nREGIME_WEIGHT_MULTS candidate:');
  console.log(JSON.stringify(best.regimeMults, null, 2));
}

function main() {
  const options = parseArgs();
  if (!options.dataRoots.length) {
    throw new Error('No local data roots found. Pass --data-root=PATH or create WECRYPTO-data/data logs.');
  }

  const dataset = loadLocalDataset(options);
  const samples = buildSamples(dataset, options);
  if (samples.length < Math.max(30, options.minOosTrades * 2)) {
    throw new Error(`Not enough matched local samples (${samples.length}). Check predictions/cfm_snapshots/resolver_outcomes logs.`);
  }

  const sweep = runSweep(samples, options);
  const output = {
    generatedAt: new Date().toISOString(),
    options: {
      dataRoots: options.dataRoots,
      coins: options.coins,
      trainRatio: options.trainRatio,
      minOos: options.minOos,
      minOosTrades: options.minOosTrades,
      decisionThreshold: options.decisionThreshold,
    },
    dataset: summarizeDataset(dataset, samples),
    trainSamples: sweep.trainSamples,
    oosSamples: sweep.oosSamples,
    best: sweep.best,
    top: sweep.results.slice(0, 25),
  };

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, JSON.stringify(output, null, 2), 'utf8');
  printTop(sweep, options);
  console.log(`\nWrote sweep details: ${options.out}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[hyper-sweep] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  loadLocalDataset,
  buildSamples,
  runSweep,
  evaluate,
  classifyRegime,
};
