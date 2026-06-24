#!/usr/bin/env node
// ================================================================
// WECRYPTO RL Stack Trainer — DQN + MCTS + CFR + mispricing hunter
//
// Trains on historical 15m windows with simulated Kalshi crowd divergence
// for contrarian / execution-time mispricing plays.
//
// Usage:
//   node backtest/rl-stack-trainer.js --days 11 --coins BTC,ETH,SOL,XRP
//   node backtest/rl-stack-trainer.js --days 7 --write-bundle
// ================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const retuner = require('./outcome-retuner');

const TradingRLAgent = require('../src/ml/trading-rl-agent');
const MispricingHunter = require('../src/ml/mispricing-hunter');
const enc = require('../src/ml/feature-encoder');

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

const args = process.argv.slice(2);
const getArg = (f, fb) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : fb;
};
const hasFlag = (f) => args.includes(f);

const DAYS = parseInt(getArg('--days', '11'), 10);
const coins = String(getArg('--coins', 'BTC,ETH,SOL,XRP'))
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);
const writeBundle = hasFlag('--write-bundle');
const trainSplit = parseFloat(getArg('--train-split', '0.72'));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Synthetic Kalshi crowd price from signal + noise (simulates mispricing windows). */
function simulateKalshiAlign(signalVector, actualDirection, seed = 0) {
  const keys = Object.keys(signalVector || {});
  let composite = 0;
  let n = 0;
  for (const k of keys) {
    const v = signalVector[k];
    if (typeof v !== 'number') continue;
    composite += v;
    n++;
  }
  composite = n ? composite / n : 0;

  // Crowd leans with momentum but lags / overshoots on extremes
  const crowdBias = composite * 28 + (Math.sin(seed * 0.31) * 12);
  const modelYesPct = clamp(50 + composite * 35, 5, 95);
  const kalshiYesPct = clamp(50 + crowdBias + (Math.cos(seed * 0.17) * 8), 5, 95);

  const strikeDir = seed % 5 === 0 ? 'below' : 'above';
  const msToClose = 120000 + (seed % 7) * 45000;
  const probVelocity = (modelYesPct - kalshiYesPct) * 0.04 + Math.sin(seed * 0.09) * 0.8;

  return {
    strikeDir,
    modelYesPct: Math.round(modelYesPct),
    kalshiYesPct: Math.round(kalshiYesPct),
    closeTimeMs: Date.now() + msToClose,
    msToClose,
    probVelocity,
    divergence: Math.abs(modelYesPct - kalshiYesPct),
  };
}

function compositeScore(signalVector) {
  const vals = Object.values(signalVector || {}).filter((v) => typeof v === 'number');
  if (!vals.length) return 0;
  return clamp(vals.reduce((s, v) => s + v, 0) / vals.length, -1, 1);
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

  console.log(`  ${coin}: fetching ${total} windows (~${Math.ceil(total * 0.56 / 60)} min at rate-limit pace)...`);

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

    out.push({
      startMs: windows[i].startMs,
      actualDirection: outcome.direction,
      pct: outcome.pct,
      signalVector,
    });
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\r  ${coin}: done ${total} windows → ${out.length} usable (${flat} flat, ${errors} errors) in ${elapsed}s`);
  return out;
}

function evaluateAgent(observations, label) {
  let correct = 0;
  let traded = 0;
  let contrarianWins = 0;
  let contrarianTrades = 0;
  let huntHits = 0;
  let huntTrades = 0;

  for (const obs of observations) {
    const align = simulateKalshiAlign(obs.signalVector, obs.actualDirection, obs.startMs % 1000);
    const mispricing = MispricingHunter.analyze({ kalshiAlign: align, probVelocity: align.probVelocity, msToClose: align.msToClose });
    const ctx = {
      signalVector: obs.signalVector,
      score: compositeScore(obs.signalVector),
      kalshiAlign: align,
      probVelocity: align.probVelocity,
      agreement: 0.55,
      conflict: 0.1,
      asks: [[align.kalshiYesPct / 100, 1000]],
      spotVolatility: 0.05 + Math.abs(align.probVelocity) * 0.1,
      positionSize: 100,
    };
    const decision = TradingRLAgent.decide(ctx);
    const action = decision.action;
    if (action === 'WAIT') continue;
    traded++;
    if (action === obs.actualDirection) correct++;

    if (mispricing.contrarian) {
      contrarianTrades++;
      if (action === obs.actualDirection) contrarianWins++;
    }
    if (mispricing.huntScore >= 0.42) {
      huntTrades++;
      if (action === obs.actualDirection) huntHits++;
    }
  }

  const wr = traded ? (correct / traded) * 100 : 0;
  console.log(`  [${label}] trades=${traded} WR=${wr.toFixed(1)}% contrarian=${contrarianTrades} (${contrarianTrades ? (contrarianWins / contrarianTrades * 100).toFixed(1) : 0}%) hunt=${huntTrades} (${huntTrades ? (huntHits / huntTrades * 100).toFixed(1) : 0}%)`);
  return { traded, wr, contrarianTrades, huntTrades };
}

async function trainCoin(coin, observations) {
  const split = Math.floor(observations.length * trainSplit);
  const train = observations.slice(0, split);
  const test = observations.slice(split);

  console.log(`\n── ${coin}: ${observations.length} obs (train=${train.length} test=${test.length}) ──`);

  for (let epoch = 0; epoch < 3; epoch++) {
    process.stdout.write(`  ${coin}: training epoch ${epoch + 1}/3...`);
    for (let i = 0; i < train.length; i++) {
      const obs = train[i];
      const align = simulateKalshiAlign(obs.signalVector, obs.actualDirection, (obs.startMs + epoch * 17) % 1000);
      const mispricing = MispricingHunter.analyze({ kalshiAlign: align, probVelocity: align.probVelocity, msToClose: align.msToClose });
      const ctx = {
        signalVector: obs.signalVector,
        score: compositeScore(obs.signalVector),
        kalshiAlign: align,
        probVelocity: align.probVelocity,
        mispricing,
        agreement: 0.55,
        conflict: 0.1,
        asks: [[align.kalshiYesPct / 100, 1000]],
        spotVolatility: 0.05 + Math.abs(align.probVelocity) * 0.1,
        positionSize: 100,
      };
      const decision = TradingRLAgent.decide(ctx);
      TradingRLAgent.learnFromOutcome({
        ...ctx,
        predDirection: decision.action,
        rlActionId: decision.actionId,
        mispricing,
      }, obs.actualDirection, obs.pct);
    }
    console.log(` done (${train.length} samples)`);
  }

  evaluateAgent(test, `${coin} test`);
  return { coin, train: train.length, test: test.length };
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  console.log('\nWECRYPTO RL Stack Trainer (DQN + MCTS + CFR + Mispricing Hunter)');
  console.log(`Days: ${DAYS} | Coins: ${coins.join(', ')}`);
  console.log(`Cwd: ${ROOT}`);
  console.log('Note: first progress line may take ~15s while Binance responds.\n');

  TradingRLAgent.initFromBundle({ config: TradingRLAgent.DEFAULT_CONFIG });

  const results = [];
  for (const coin of coins) {
    const windows = generateWindows(DAYS, 15);
    console.log(`\nCollecting ${coin}...`);
    const observations = await collectObservations(coin, windows);
    console.log(`  ${coin}: ${observations.length} directional windows`);
    if (observations.length < 50) {
      console.log(`  SKIP ${coin}: insufficient data`);
      continue;
    }
    results.push(await trainCoin(coin, observations));
  }

  const bundle = TradingRLAgent.getBundle();
  const outPath = path.join(LOG_DIR, `rl-stack-bundle-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2));
  console.log(`\nBundle saved: ${outPath}`);

  if (writeBundle) {
    const publicPath = path.join(ROOT, 'public', 'models', 'rl-stack-bundle.json');
    fs.mkdirSync(path.dirname(publicPath), { recursive: true });
    fs.writeFileSync(publicPath, JSON.stringify(bundle, null, 2));
    console.log(`Public model: ${publicPath}`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
