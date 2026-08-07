#!/usr/bin/env node
// ================================================================
// WECRYPTO TFT Trainer (Phase 2 scaffold)
//
// Offline multi-horizon attention trainer. Collects historical windows
// via outcome-retuner helpers, builds h5/h15/h60 feature proxies, and
// exports tft-bundle.json for TemporalFusionLite fuse() inference.
//
// Usage:
//   node backtest/tft-trainer.js --days 11 --coins BTC,ETH,SOL,XRP
//   node backtest/tft-trainer.js --days 7 --max 120 --write-bundle
//   npm run backtest:tft-trainer
// ================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const retuner = require('./outcome-retuner');
const TemporalFusionLite = require('../src/ml/temporal-fusion-lite');

const {
  SYMBOL_MAP,
  generateWindows,
  fetchOutcome,
  fetchLookback,
  computeSignalVector,
  sleep,
} = retuner;

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'backtest-logs');
const PUBLIC_BUNDLE = path.join(ROOT, 'public', 'models', 'tft-bundle.json');

const args = process.argv.slice(2);
const getArg = (f, fb) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : fb;
};
const hasFlag = (f) => args.includes(f);

const DAYS = parseInt(getArg('--days', '11'), 10);
const MAX_WINDOWS = parseInt(getArg('--max', '0'), 10) || null;
const coins = String(getArg('--coins', 'BTC,ETH,SOL,XRP'))
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);
const writeBundle = hasFlag('--write-bundle');
const testMode = hasFlag('--test');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const FAST_KEYS = ['momentum', 'volume', 'obv', 'rsi', 'stochrsi', 'williamsR'];
const MID_KEYS = ['ema', 'macd', 'vwap', 'bands', 'keltner', 'cmf'];
const SLOW_KEYS = ['ichimoku', 'hma', 'sma', 'adx', 'supertrend', 'persistence'];

function avgKeys(sv, keys) {
  const vals = keys.map((k) => sv[k]).filter((v) => typeof v === 'number');
  if (!vals.length) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/** Multi-horizon proxy scores from indicator signal vector (Phase 2 feature heads). */
function horizonScoresFromSignalVector(sv) {
  if (!sv) return { h5: 0, h15: 0, h60: 0 };
  const h5 = clamp(avgKeys(sv, FAST_KEYS), -1, 1);
  const h15 = clamp(avgKeys(sv, [...FAST_KEYS, ...MID_KEYS]), -1, 1);
  const h60 = clamp(avgKeys(sv, [...MID_KEYS, ...SLOW_KEYS]), -1, 1);
  return { h5, h15, h60 };
}

function softmaxFromPriors(priors) {
  const keys = TemporalFusionLite.HORIZONS.map((h) => h.key);
  const logits = keys.map((k) => Math.log((priors[k] ?? 1e-6) + 1e-6));
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((s, v) => s + v, 0) || 1;
  const weights = {};
  keys.forEach((k, i) => { weights[k] = exps[i] / sum; });
  return { weights, logits: Object.fromEntries(keys.map((k, i) => [k, logits[i]])) };
}

/**
 * Minimal offline "training": horizon directional hit-rates → attention priors.
 * Phase 2 replaces this with real TFT sequence model + variable selection.
 */
function trainAttentionPriors(observations) {
  const hits = { h5: 0, h15: 0, h60: 0 };
  const total = { h5: 0, h15: 0, h60: 0 };
  const dirSign = (d) => (d === 'UP' ? 1 : d === 'DOWN' ? -1 : 0);

  for (const obs of observations) {
    const scores = obs.horizonScores || horizonScoresFromSignalVector(obs.signalVector);
    const dir = dirSign(obs.actualDirection);
    if (!dir) continue;

    for (const key of ['h5', 'h15', 'h60']) {
      const s = scores[key];
      if (Math.abs(s) < 0.08) continue;
      total[key]++;
      if ((s > 0 && dir > 0) || (s < 0 && dir < 0)) hits[key]++;
    }
  }

  const defaultPriors = Object.fromEntries(
    TemporalFusionLite.HORIZONS.map((h) => [h.key, h.basePrior]),
  );

  const raw = {};
  for (const h of TemporalFusionLite.HORIZONS) {
    const t = total[h.key];
    const acc = t > 0 ? hits[h.key] / t : defaultPriors[h.key];
    raw[h.key] = clamp(acc, 0.08, 0.72);
  }

  const sum = Object.values(raw).reduce((s, v) => s + v, 0) || 1;
  const basePriors = {};
  for (const k of Object.keys(raw)) basePriors[k] = raw[k] / sum;

  const { weights, logits } = softmaxFromPriors(basePriors);
  const horizonAccuracy = {};
  for (const k of Object.keys(total)) {
    horizonAccuracy[k] = total[k] > 0 ? hits[k] / total[k] : null;
  }

  return { weights, basePriors, logits, hits, total, horizonAccuracy };
}

async function collectObservations(coin, windows) {
  const sym = SYMBOL_MAP[coin];
  if (!sym) return [];

  const out = [];
  let delayMs = 280;
  let errorStreak = 0;
  let flat = 0;
  let errors = 0;
  const total = windows.length;
  const started = Date.now();

  console.log(`  ${coin}: fetching ${total} windows...`);

  for (let i = 0; i < windows.length; i++) {
    if (i > 0 && i % 25 === 0) {
      const pct = ((i / total) * 100).toFixed(0);
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      process.stdout.write(`\r  ${coin}: ${i}/${total} (${pct}%) usable=${out.length} flat=${flat} err=${errors} ${elapsed}s   `);
    }

    await sleep(delayMs);
    const outcome = await fetchOutcome(sym, windows[i].startMs);
    if (!outcome) {
      errors++;
      errorStreak++;
      if (errorStreak >= 5) delayMs = Math.min(2000, delayMs + 200);
      if (errorStreak >= 15) {
        console.log(`\n  [${coin}] Rate-limit backoff — sleeping 30s (${errorStreak} consecutive errors)`);
        await sleep(30000);
        delayMs = 500;
      }
      continue;
    }
    errorStreak = 0;
    delayMs = Math.max(280, delayMs - 10);
    if (outcome.direction === 'FLAT') { flat++; continue; }

    await sleep(delayMs);
    const candles = await fetchLookback(sym, windows[i].startMs);
    if (!candles || candles.length < 30) { errors++; continue; }

    const signalVector = computeSignalVector(candles);
    if (!signalVector) continue;

    const horizonScores = horizonScoresFromSignalVector(signalVector);
    out.push({
      coin,
      startMs: windows[i].startMs,
      actualDirection: outcome.direction,
      pct: outcome.pct,
      signalVector,
      horizonScores,
    });
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\r  ${coin}: done ${total} windows → ${out.length} usable (${flat} flat, ${errors} errors) in ${elapsed}s`);
  return out;
}

function buildBundle(allObservations, meta = {}) {
  const attention = trainAttentionPriors(allObservations);

  const bundle = {
    version: 1,
    phase: 'offline-tft-scaffold',
    horizons: TemporalFusionLite.HORIZONS.map((h) => ({
      key: h.key,
      label: h.label,
      minutes: h.minutes,
      basePrior: attention.basePriors[h.key] ?? h.basePrior,
    })),
    attention: {
      weights: attention.weights,
      basePriors: attention.basePriors,
      logits: attention.logits,
      coeffs: {
        magnitude: 1.35,
        closeBias: 1.0,
        volBias: 1.0,
        agreement: 1.0,
        conflictPenalty: 0.08,
        blend: 0.38,
      },
    },
    features: {
      fastKeys: FAST_KEYS,
      midKeys: MID_KEYS,
      slowKeys: SLOW_KEYS,
    },
    training: {
      days: DAYS,
      coins,
      samples: allObservations.length,
      horizonAccuracy: attention.horizonAccuracy,
      horizonCounts: attention.total,
      ...meta,
    },
    exportedAt: new Date().toISOString(),
  };

  // Sanity: fuse() API shape — weights keys must match HORIZONS
  const sample = allObservations[0];
  if (sample) {
    const fusion = TemporalFusionLite.fuse({
      score: avgKeys(sample.signalVector, Object.keys(sample.signalVector)),
      modelScore: sample.horizonScores.h15,
      fastTiming: { horizonScores: sample.horizonScores },
      msToClose: 12 * 60000,
      atrPct: 1.2,
      blend: bundle.attention.coeffs.blend,
    });
    bundle.validation = {
      fuseKeys: Object.keys(fusion.weights || {}),
      fusePhase: fusion.phase,
      sampleWeights: fusion.weights,
    };
  }

  return bundle;
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  console.log('\nWECRYPTO TFT Trainer (Phase 2 scaffold)');
  console.log(`Days: ${DAYS} | Coins: ${coins.join(', ')}`);
  if (MAX_WINDOWS) console.log(`Max windows/coin: ${MAX_WINDOWS}`);
  if (testMode) console.log('Test mode: 1 coin, capped windows');
  console.log(`Cwd: ${ROOT}\n`);

  let allObservations = [];
  const runCoins = testMode ? coins.slice(0, 1) : coins;

  for (const coin of runCoins) {
    let windows = generateWindows(DAYS);
    if (MAX_WINDOWS) windows = windows.slice(-MAX_WINDOWS);
    if (testMode) windows = windows.slice(-Math.min(40, windows.length));

    console.log(`\nCollecting ${coin}...`);
    const obs = await collectObservations(coin, windows);
    allObservations = allObservations.concat(obs);
  }

  console.log(`\nTotal directional samples: ${allObservations.length}`);
  const minSamples = testMode ? 5 : 30;
  if (allObservations.length < minSamples) {
    console.error(`Insufficient samples for TFT export (need >= ${minSamples}).`);
    process.exit(1);
  }

  const bundle = buildBundle(allObservations);
  const dateStr = new Date().toISOString().slice(0, 10);
  const logPath = path.join(LOG_DIR, `tft-bundle-${dateStr}.json`);
  fs.writeFileSync(logPath, JSON.stringify(bundle, null, 2));
  console.log(`\nBundle saved: ${logPath}`);
  console.log('Attention weights:', JSON.stringify(bundle.attention.weights));

  if (writeBundle) {
    fs.mkdirSync(path.dirname(PUBLIC_BUNDLE), { recursive: true });
    fs.writeFileSync(PUBLIC_BUNDLE, JSON.stringify(bundle, null, 2));
    console.log(`Public model: ${PUBLIC_BUNDLE}`);
  } else {
    console.log('Tip: pass --write-bundle to copy to public/models/tft-bundle.json');
  }

  console.log('\nDone.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL:', err.stack || err);
    process.exit(1);
  });
}

module.exports = {
  horizonScoresFromSignalVector,
  trainAttentionPriors,
  buildBundle,
  FAST_KEYS,
  MID_KEYS,
  SLOW_KEYS,
};
