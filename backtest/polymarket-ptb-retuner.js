#!/usr/bin/env node
// ================================================================
// WECRYPTO — Polymarket Chainlink TWAP & PTB Model Retuner
//
// Retrains indicator weights and per-coin biases specifically for
// Polymarket 5m/15m Binary Options settlement mechanics:
//   - Target = 1 if Chainlink settlement TWAP >= PTB, else 0
//   - Loss = Binary Cross-Entropy on Normal CDF Probability
//   - Model = Indicator Composite -> Drift -> CDF( (meanFinal - PTB) / sigma )
//
// Usage:
//   node backtest/polymarket-ptb-retuner.js --days 14 --coins BTC,ETH,SOL,XRP
//   node backtest/polymarket-ptb-retuner.js --days 7 --write-weights
//   npm run retrain:polymarket-ptb
// ================================================================
'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CLI Arguments ────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = (flag) => args.includes(flag);

const COINS_ARG     = getArg('--coins', 'BTC,ETH,SOL,XRP').toUpperCase().split(',').map(s => s.trim());
const INTERVAL_ARG  = getArg('--interval', '5m');
const DAYS_ARG      = parseInt(getArg('--days', '7'), 10);
const EPOCHS_ARG    = parseInt(getArg('--epochs', '150'), 10);
const LR_ARG        = parseFloat(getArg('--lr', '0.015'));
const WRITE_WEIGHTS = hasFlag('--write-weights');
const PREDS_FILE    = path.join(__dirname, '../src/core/predictions.js');

// ── Base Composite Weights (predictions.js) ──────────────────────
const COMPOSITE_WEIGHTS = {
  supertrend: 0.10,
  hma: 0.07,
  vwma: 0.06,
  ema: 0.05,
  sma: 0.03,
  macd: 0.07,
  persistence: 0.07,
  bands: 0.05,
  keltner: 0.05,
  williamsR: 0.07,
  rsi: 0.06,
  cci: 0.05,
  stochrsi: 0.04,
  volume: 0.12,
  obv: 0.07,
  cmf: 0.07,
  mfi: 0.07,
  structure: 0.10,
  ichimoku: 0.05,
  adx: 0.04,
  fisher: 0.04,
  book: 0.25,
  flow: 0.22,
  toxicity: 0.06,
  spoof: 0.07,
  iceberg: 0.08,
  orderBookImbalance: 0.18,
  imbalanceVelocity: 0.12,
  liquidityDepth: 0.08,
  liquidityVacuum: 0.12,
  fundingRate: 0.10,
  mktSentiment: 0.18,
  fearGreed: 0.12,
  cmcMacro: 0.08,
};

const OUTER_ORBITAL_WEIGHTS = { momentum: 0.05, vwap: 0.05 };

// ── Math & CDF Helper Functions ──────────────────────────────────
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const p = 1 - pdf * poly;
  return z >= 0 ? p : 1 - p;
}

function normalPDF(z) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

// ── TA Indicator Calculators ─────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  const ema = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    ema.push(arr[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcBollinger(closes, period = 20, mult = 2.0) {
  if (closes.length < period) return { position: 0.5, bandwidth: 0 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mean + mult * std, lower = mean - mult * std;
  const last = closes[closes.length - 1];
  const position = upper !== lower ? (last - lower) / (upper - lower) : 0.5;
  return { position: clamp(position, 0, 1), upper, lower, mean };
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, prevC = candles[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
  }
  return trs.slice(-period).reduce((s, v) => s + v, 0) / Math.min(trs.length, period);
}

function calcMACD(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = calcEMA(closes, 12), ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine.slice(25), 9);
  const macdVal = macdLine[macdLine.length - 1];
  const sigVal = signalLine[signalLine.length - 1] || 0;
  return { macd: macdVal, signal: sigVal, histogram: macdVal - sigVal };
}

function calcWilliamsR(candles, period = 14) {
  if (candles.length < period) return -50;
  const slice = candles.slice(-period);
  const highest = Math.max(...slice.map(c => c.h));
  const lowest = Math.min(...slice.map(c => c.l));
  const close = slice[slice.length - 1].c;
  if (highest === lowest) return -50;
  return ((highest - close) / (highest - lowest)) * -100;
}

function calcSupertrend(candles, period = 10, multiplier = 3.0) {
  if (candles.length < period + 1) return { signal: 0 };
  const atr = calcATR(candles, period);
  const last = candles[candles.length - 1];
  const hl2 = (last.h + last.l) / 2;
  const upper = hl2 + multiplier * atr;
  const lower = hl2 - multiplier * atr;
  return { signal: last.c > upper ? 1 : last.c < lower ? -1 : 0 };
}

function extractSignalVector(candles) {
  if (!candles || candles.length < 26) return null;
  const closes = candles.map(c => c.c);
  const lastPrice = closes[closes.length - 1];

  const rsi = calcRSI(closes);
  let rsiSig = rsi > 70 ? -0.6 - ((rsi - 70) / 30) * 0.4 : rsi < 30 ? 0.6 + ((30 - rsi) / 30) * 0.4 : (rsi - 50) / 50 * 0.3;

  const ema9 = calcEMA(closes, 9), ema21 = calcEMA(closes, 21);
  const emaCross = (ema9[ema9.length - 1] - ema21[ema21.length - 1]) / (ema21[ema21.length - 1] || 1) * 100;
  const emaSig = clamp(emaCross * 5, -1, 1);

  const bands = calcBollinger(closes);
  let bandSig = bands.position >= 0.88 ? -clamp((bands.position - 0.88) / 0.12, 0, 1)
    : bands.position <= 0.12 ? clamp((0.12 - bands.position) / 0.12, 0, 1)
    : clamp(-(bands.position - 0.5) * 0.45, -0.22, 0.22);

  const macdR = calcMACD(closes);
  const macdHistNorm = lastPrice > 0 ? (macdR.histogram / lastPrice) * 1000 : 0;
  const macdSig = clamp(macdHistNorm * 2.5 + (macdR.macd > macdR.signal ? 0.18 : -0.18), -1, 1);

  const wR = calcWilliamsR(candles);
  let wRSig = wR > -20 ? -0.6 - ((wR + 20) / 20) * 0.4 : wR < -80 ? 0.6 + ((-80 - wR) / 20) * 0.4 : (wR + 50) / 50 * -0.3;

  const stR = calcSupertrend(candles);
  const atr = calcATR(candles);
  const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0.4;

  const mom = closes.length > 6 ? ((closes[closes.length - 1] - closes[closes.length - 7]) / (closes[closes.length - 7] || 1)) * 100 : 0;
  const momSig = clamp(mom / 2, -1, 1);

  return {
    signals: {
      rsi: rsiSig,
      ema: emaSig,
      bands: bandSig,
      macd: macdSig,
      williamsR: wRSig,
      supertrend: stR.signal,
      momentum: momSig,
    },
    atrPct,
    lastPrice,
  };
}

// ── HTTP Fetcher for Chainlink TWAP Candles ──────────────────────
function fetchChainlinkCandles(sym, interval, endTime = null) {
  return new Promise((resolve, reject) => {
    let url = `https://polymarket.com/api/chainlink-candles?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=30&twapEnabled=true&twapLookbackSeconds=60`;
    if (endTime) url += `&endTime=${endTime}`;

    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return reject(new Error(`Chainlink API HTTP ${res.statusCode}: ${data}`));
          const json = JSON.parse(data);
          resolve(Array.isArray(json.candles) ? json.candles : []);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function fetchHistoricalChainlinkCandles(sym, interval, totalCandlesDesired) {
  const allCandles = [];
  let endTime = Date.now();
  const seenTimes = new Set();

  while (allCandles.length < totalCandlesDesired) {
    try {
      const batch = await fetchChainlinkCandles(sym, interval, endTime);
      if (!batch || batch.length === 0) break;

      const newItems = batch.filter(c => !seenTimes.has(c.time));
      if (newItems.length === 0) break;

      for (const item of newItems) seenTimes.add(item.time);
      allCandles.push(...newItems);

      const earliest = Math.min(...batch.map(c => c.time));
      endTime = earliest * 1000 - 1000;
      await new Promise(r => setTimeout(r, 220));
    } catch (err) {
      console.warn(`[ChainlinkFetcher] Warning fetching ${sym}: ${err.message}`);
      break;
    }
  }

  allCandles.sort((a, b) => a.time - b.time);
  return allCandles.map(c => ({
    t: c.time * 1000,
    o: Number(c.open),
    h: Number(c.high),
    l: Number(c.low),
    c: Number(c.close),
  }));
}

// ── Model Optimization Loop (PTB CDF Cross-Entropy Loss) ─────────
function trainCoinWeights(observations, initialBias, options = {}) {
  const { lr = 0.015, epochs = 150, l2 = 0.001 } = options;
  const weights = { ...initialBias };
  const keys = Object.keys(weights);

  function evaluate(W) {
    let loss = 0;
    let correct = 0;
    const N = observations.length;

    for (const obs of observations) {
      let sumW = 0, sumScore = 0;
      for (const k of keys) {
        const baseW = COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0.05;
        const w = (W[k] ?? 1.0) * baseW;
        sumW += Math.abs(w);
        sumScore += (obs.signals[k] ?? 0) * w;
      }
      const score = clamp((sumW > 0 ? sumScore / sumW : 0) * 1.6, -1, 1);
      const expectedMove = score * obs.atrDollar * 0.40 * obs.remainingFrac;
      const meanFinal = obs.entryPrice + expectedMove;
      const z = (meanFinal - obs.ptb) / (obs.sigma || 1);
      const pUp = clamp(normalCDF(z), 0.001, 0.999);

      const y = obs.target; // 1 for UP, 0 for DOWN
      loss += -(y * Math.log(pUp) + (1 - y) * Math.log(1 - pUp));

      const predDir = pUp >= 0.50 ? 1 : 0;
      if (predDir === y) correct++;
    }

    return {
      loss: loss / (N || 1),
      accuracy: N > 0 ? (correct / N) * 100 : 0,
      wins: correct,
      total: N,
    };
  }

  const initialMetrics = evaluate(weights);

  for (let ep = 0; ep < epochs; ep++) {
    const grads = {};
    for (const k of keys) grads[k] = 0;

    for (const obs of observations) {
      let sumW = 0, sumScore = 0;
      for (const k of keys) {
        const baseW = COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0.05;
        const w = (weights[k] ?? 1.0) * baseW;
        sumW += Math.abs(w);
        sumScore += (obs.signals[k] ?? 0) * w;
      }
      const totalW = sumW || 1;
      const rawNorm = sumScore / totalW;
      const score = clamp(rawNorm * 1.6, -1, 1);

      const expectedMove = score * obs.atrDollar * 0.40 * obs.remainingFrac;
      const meanFinal = obs.entryPrice + expectedMove;
      const z = (meanFinal - obs.ptb) / (obs.sigma || 1);
      const pUp = clamp(normalCDF(z), 0.001, 0.999);

      // Derivative of BCE loss w.r.t pUp: dL/dp = (pUp - y) / (pUp * (1 - pUp))
      // Derivative of pUp w.r.t z: dp/dz = pdf(z)
      // Derivative of z w.r.t score: dz/dScore = (atrDollar * 0.40 * remainingFrac) / sigma
      // Derivative of score w.r.t weight_k
      const dL_dp = (pUp - obs.target) / (pUp * (1 - pUp));
      const dp_dz = normalPDF(z);
      const dz_dScore = (obs.atrDollar * 0.40 * obs.remainingFrac) / (obs.sigma || 1);
      const dL_dScore = dL_dp * dp_dz * dz_dScore;

      for (const k of keys) {
        const baseW = COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0.05;
        const sig_k = obs.signals[k] ?? 0;
        // Quotient rule on sumScore / totalW
        const dScore_dWk = 1.6 * baseW * (sig_k * totalW - sumScore * Math.sign(weights[k] || 1)) / (totalW ** 2);
        grads[k] += dL_dScore * dScore_dWk + l2 * (weights[k] - (initialBias[k] || 1.0));
      }
    }

    const N = observations.length;
    for (const k of keys) {
      weights[k] = clamp(weights[k] - lr * (grads[k] / N), 0.05, 5.0);
    }
  }

  const finalMetrics = evaluate(weights);
  return {
    initialMetrics,
    finalMetrics,
    updatedWeights: weights,
  };
}

// ── Safely Update src/core/predictions.js ─────────────────────────
function updatePredictionsFile(allUpdatedBiases) {
  if (!fs.existsSync(PREDS_FILE)) {
    console.error(`❌ Cannot find ${PREDS_FILE}`);
    return false;
  }
  let content = fs.readFileSync(PREDS_FILE, 'utf8');

  // Search for PER_COIN_INDICATOR_BIAS block
  const biasPattern = /const\s+PER_COIN_INDICATOR_BIAS\s*=\s*\{([\s\S]*?)\n\s*\};/;
  const match = content.match(biasPattern);
  if (!match) {
    console.error('❌ Could not locate PER_COIN_INDICATOR_BIAS in predictions.js');
    return false;
  }

  // Format new bias object string
  const formattedLines = [];
  formattedLines.push('const PER_COIN_INDICATOR_BIAS = {');
  for (const [coin, biasMap] of Object.entries(allUpdatedBiases)) {
    formattedLines.push(`    ${coin}: {`);
    for (const [k, v] of Object.entries(biasMap)) {
      formattedLines.push(`      ${k}: ${Number(v).toFixed(3)},`);
    }
    formattedLines.push('    },');
  }
  formattedLines.push('  };');

  content = content.replace(biasPattern, formattedLines.join('\n'));
  fs.writeFileSync(PREDS_FILE, content, 'utf8');
  console.log(`\n✅ Successfully updated PER_COIN_INDICATOR_BIAS in ${PREDS_FILE}`);
  return true;
}

// ── Main Pipeline ────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(85));
  console.log('  WECRYPTO — POLYMARKET CHAINLINK TWAP & PTB MODEL RETUNER');
  console.log('  Training Ground Truth: Strike = PTB, Settle = Chainlink TWAP');
  console.log('═'.repeat(85));
  console.log(`  Coins:        ${COINS_ARG.join(', ')}`);
  console.log(`  Interval:     ${INTERVAL_ARG}`);
  console.log(`  History Days: ${DAYS_ARG} days`);
  console.log(`  Epochs:       ${EPOCHS_ARG}`);
  console.log(`  Write Weights:${WRITE_WEIGHTS ? ' YES' : ' NO'}`);
  console.log('═'.repeat(85) + '\n');

  const intervalSec = INTERVAL_ARG === '15m' ? 900 : 300;
  const totalCandles = DAYS_ARG * Math.round(86400 / intervalSec);
  const allUpdatedBiases = {};

  for (const sym of COINS_ARG) {
    process.stdout.write(`⏳ Fetching Chainlink TWAP candles for ${sym}... `);
    const candles = await fetchHistoricalChainlinkCandles(sym, INTERVAL_ARG, totalCandles);
    console.log(`Loaded ${candles.length} contract windows.`);

    if (candles.length < 30) {
      console.log(`❌ Skipping ${sym} (insufficient candles)`);
      continue;
    }

    // Build training observations
    const observations = [];
    const entryOffset = 0.40; // 40% into window
    const warmup = 26;

    for (let i = warmup; i < candles.length; i++) {
      const history = candles.slice(0, i);
      const contract = candles[i];
      const model = extractSignalVector(history);
      if (!model) continue;

      const ptb = contract.o;
      const settleTwap = contract.c;
      const target = settleTwap >= ptb ? 1 : 0; // 1 = UP, 0 = DOWN

      const entryPrice = ptb + (contract.c - ptb) * entryOffset;
      const atrDollar = entryPrice * ((model.atrPct || 0.4) / 100);
      const remainingFrac = 1.0 - entryOffset;
      const sigma = Math.max(entryPrice * 0.0015, atrDollar * Math.sqrt(remainingFrac));

      observations.push({
        ptb,
        settleTwap,
        target,
        entryPrice,
        atrDollar,
        remainingFrac,
        sigma,
        signals: model.signals,
      });
    }

    const initialBias = {
      bands: 1.0, williamsR: 1.0, obv: 1.0, vwap: 1.0, hma: 0.9,
      momentum: 0.6, stochrsi: 1.0, sma: 0.95, adx: 1.0, mfi: 1.1,
      supertrend: 1.0, ema: 0.9, macd: 0.9, rsi: 0.7,
    };

    const res = trainCoinWeights(observations, initialBias, { lr: LR_ARG, epochs: EPOCHS_ARG });
    allUpdatedBiases[sym] = res.updatedWeights;

    console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
    console.log(`│ RETRAINING RESULTS: ${sym.padEnd(5)} (${observations.length} contract windows)   │`);
    console.log(`├─────────────────────────────────────────────────────────────┤`);
    console.log(`│ Initial Win Rate:   ${res.initialMetrics.accuracy.toFixed(1).padStart(5)}%  (Loss: ${res.initialMetrics.loss.toFixed(4)})             │`);
    console.log(`│ Optimized Win Rate: ${res.finalMetrics.accuracy.toFixed(1).padStart(5)}%  (Loss: ${res.finalMetrics.loss.toFixed(4)})             │`);
    console.log(`│ Log-Loss Reduction: -${((res.initialMetrics.loss - res.finalMetrics.loss) / res.initialMetrics.loss * 100).toFixed(1)}%                           │`);
    console.log(`└─────────────────────────────────────────────────────────────┘`);

    console.log(`\n  Top Calibrated Indicators for ${sym}:`);
    const sorted = Object.entries(res.updatedWeights).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of sorted.slice(0, 6)) {
      console.log(`    • ${k.padEnd(12)} : ${v.toFixed(3)}x`);
    }
  }

  if (WRITE_WEIGHTS) {
    updatePredictionsFile(allUpdatedBiases);
  } else {
    console.log('\n💡 Tip: Run with --write-weights to apply optimized weights to src/core/predictions.js');
  }
}

main().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
