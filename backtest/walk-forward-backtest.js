#!/usr/bin/env node
// ================================================================
// WECRYPTO — True Walk-Forward Backtest with Rolling TRAIN/TEST Splits
// Calibrates signal-gate thresholds on TRAIN window (in-sample),
// then evaluates STRICTLY on TEST window (out-of-sample).
//
// Usage:  node walk-forward-backtest.js
//         node walk-forward-backtest.js --coin BTC --days 30
//         node walk-forward-backtest.js --fold-size 500 --step 100
// ================================================================
'use strict';

// MOCK BROWSER ENVIRONMENT FOR QUANTCORE
global.window = global;
try {
    require('../src/quant/statistical-utils.js');
    require('../src/quant/kalman-filter.js');
    require('../src/quant/hurst-exponent.js');
    require('../src/quant/hmm-regime-classifier.js');
    window.QuantCore = {
        kalman: new window.KalmanFilter(),
        hurst: new window.HurstExponent(),
        hmm: new window.HMMRegimeClassifier()
    };
    console.log('[Backtest] Mocked window.QuantCore successfully');
} catch (e) {
    console.error('[Backtest] Failed to load QuantCore:', e.message);
}

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CLI args ─────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const FILTER_COIN  = getArg('--coin')?.toUpperCase() || null;
const DAYS_BACK    = parseInt(getArg('--days')  || '14', 10);
const TRAIN_BARS   = parseInt(getArg('--fold-size') || '400', 10);  // train window bars (5m each)
const TEST_BARS    = parseInt(getArg('--test')  || '100', 10);       // test window bars
const STEP_BARS    = parseInt(getArg('--step')  || '50',  10);       // fold step
const CANDLES_WANT = DAYS_BACK * 288;   // 288 × 5m = 1 day

// ── Log directory ─────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'backtest-logs');
const CHECKPOINT = path.join(ROOT, 'WECRYPTO_SESSION_CHECKPOINT_20260501.md');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

// ── Coins (4 core Kalshi coins) ──────────────────────────────────
const PREDICTION_COINS = [
  { sym: 'BTC', binSym: 'BTCUSDT' },
  { sym: 'ETH', binSym: 'ETHUSDT' },
  { sym: 'SOL', binSym: 'SOLUSDT' },
  { sym: 'XRP', binSym: 'XRPUSDT' },
];

// ── Weights (updated 2026-05-01) ─────────────────────────────────
const COMPOSITE_WEIGHTS = {
   supertrend: 0.1,
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
   structure: 0.1,
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
   fundingRate: 0.1,
   mktSentiment: 0.18,
   fearGreed: 0.12,
   cmcMacro: 0.08,
 };
const OUTER_ORBITAL_WEIGHTS = { momentum: 0.05, vwap: 0.05 };

const PER_COIN_INDICATOR_BIAS = {
     BTC: {
       bands: 1.09,
       williamsR: 1.08,
       obv: 0.97,
       vwap: 1.05,
       hma: 0.9,
       momentum: 0.55,
       stochrsi: 1.05,
       sma: 0.95,
       adx: 1.01,
       mfi: 1.13,
       supertrend: 0.96,
       ichimoku: 0.896,
       keltner: 1.116,
       volume: 0.94,
       ema: 0.891,
       vwma: 0.86,
       macd: 0.91,
       structure: 1.142,
       fisher: 1.08,
       persistence: 0.983,
       rsi: 0.63,
       cci: 1.07,
       cmf: 1.01,
       fearGreed: 1,
       book: 0.85,
       flow: 0.8,
     },
     ETH: {
       bands: 1.33,
       mfi: 1.1,
       sma: 0.97,
       adx: 1.11,
       supertrend: 1.086,
       ichimoku: 0.977,
       hma: 0.85,
       vwap: 0.82,
       ema: 0.92,
       cmf: 1.1,
       momentum: 0.55,
       obv: 0.932,
       fisher: 1.24,
       vwma: 0.94,
       macd: 0.851,
       cci: 1.22,
       rsi: 0.81,
       structure: 1.185,
       persistence: 1.004,
       stochrsi: 1.11,
       williamsR: 1.3,
       keltner: 1.276,
       volume: 0.92,
       fearGreed: 1,
       book: 0.9,
       flow: 0.85,
     },
     SOL: {
       williamsR: 1.14,
       cci: 1.12,
       sma: 1.074,
       mfi: 1.13,
       rsi: 1.02,
       supertrend: 0.983,
       ema: 0.888,
       bands: 1.18,
       stochrsi: 0.86,
       volume: 0.95,
       cmf: 0.8,
       ichimoku: 0.894,
       persistence: 0.732,
       adx: 0.9,
       hma: 0.76,
       vwap: 0.7,
       vwma: 0.72,
       macd: 0.9,
       keltner: 1.336,
       fisher: 1.13,
       momentum: 0.55,
       obv: 0.875,
       structure: 1.27,
       fearGreed: 0.9,
       book: 0.75,
       flow: 0.7,
     },
     XRP: {
       vwap: 0.98,
       rsi: 0.91,
       fisher: 0.83,
       hma: 1.009,
       mfi: 1.02,
       momentum: 0.55,
       sma: 0.764,
       macd: 1.063,
       vwma: 0.802,
       persistence: 0.863,
       ichimoku: 0.863,
       obv: 0.82,
       volume: 0.84,
       adx: 0.83,
       ema: 0.733,
       keltner: 0.942,
       cci: 0.95,
       williamsR: 0.86,
       supertrend: 0.734,
       cmf: 0.84,
       stochrsi: 0.977,
       bands: 0.995,
       structure: 1.123,
       fearGreed: 0.7,
       book: 0.6,
       flow: 0.55,
     },
     HYPE: {
       williamsR: 6.5,
       fisher: 5,
       cci: 4.5,
       bands: 3,
       keltner: 2,
       rsi: 1.5,
       stochrsi: 1.2,
       structure: 0.8,
       obv: 0.5,
       persistence: 0.4,
       vwap: 0.3,
       ema: 0.3,
       cmf: 0.3,
       adx: 0.3,
       ichimoku: 0.2,
       sma: 0,
       vwma: 0.2,
       supertrend: 0.1,
       momentum: 0.05,
       hma: 0.05,
       macd: 0.1,
       volume: 0.3,
       mfi: 0.3,
       fearGreed: 1.8,
     },
     DOGE: {
       obv: 4.5,
       volume: 3.5,
       cmf: 3,
       bands: 2.5,
       mfi: 2,
       structure: 1.8,
       fisher: 1.8,
       keltner: 1.212,
       cci: 1.012,
       williamsR: 0.824,
       rsi: 0.5,
       persistence: 0.252,
       ema: 0.277,
       macd: 0.181,
       ichimoku: 0.177,
       adx: 0.105,
       hma: 0.296,
       sma: 0,
       supertrend: 0.197,
       vwap: 0.102,
       stochrsi: 0.068,
       momentum: 0.052,
       vwma: 0.029,
       fearGreed: 2,
     },
     BNB: {
       sma: 5,
       mfi: 4.5,
       ema: 4,
       vwap: 3.5,
       hma: 3,
       vwma: 2.5,
       volume: 3.5,
       momentum: 2,
       persistence: 2,
       macd: 1.5,
       ichimoku: 2,
       supertrend: 2,
       cmf: 1.5,
       obv: 0.5,
       fisher: 0.831,
       cci: 0.34,
       adx: 0.505,
       structure: 0.065,
       keltner: 0.093,
       williamsR: 0.089,
       bands: 0.093,
       rsi: 0.071,
       stochrsi: 0.089,
       fearGreed: 0.8,
     },
   };

// Filter overrides (baseline reference — calibrated per fold in this script)
const BACKTEST_FILTER_OVERRIDES = {
  BTC:  { h1:{entryThreshold:0.30,minAgreement:0.54}, h5:{entryThreshold:0.30,minAgreement:0.54}, h10:{entryThreshold:0.25,minAgreement:0.58}, h15:{entryThreshold:0.25,minAgreement:0.58} },
  ETH:  { h1:{entryThreshold:0.25,minAgreement:0.50}, h5:{entryThreshold:0.25,minAgreement:0.50}, h10:{entryThreshold:0.25,minAgreement:0.50}, h15:{entryThreshold:0.25,minAgreement:0.54} },
  XRP:  { h1:{entryThreshold:0.30,minAgreement:0.58}, h5:{entryThreshold:0.30,minAgreement:0.58}, h10:{entryThreshold:0.30,minAgreement:0.58}, h15:{entryThreshold:0.30,minAgreement:0.54} },
  SOL:  { h1:{entryThreshold:0.35,minAgreement:0.50}, h5:{entryThreshold:0.35,minAgreement:0.50}, h10:{entryThreshold:0.28,minAgreement:0.54}, h15:{entryThreshold:0.30,minAgreement:0.54,maxThreshold:0.55} },
};

const SCORE_AMPLIFIER       = 1.6;
const BACKTEST_MIN_TRAIN_OBS = 36;
const SHORT_HORIZON_MINUTES  = [1, 5, 10, 15];

// ── Utility ───────────────────────────────────────────────────────
const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const average = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
const median  = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
};
const stdDev  = arr => {
  if (arr.length < 2) return 0;
  const mu = average(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length);
};

// ── EXACT Indicator Functions (verbatim from backtest-runner.js) ──
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function calcVWAP(candles) {
  let cumVol = 0, cumTP = 0;
  return candles.map(c => {
    const tp = (c.h + c.l + c.c) / 3, vol = c.v || 1;
    cumVol += vol; cumTP += tp * vol;
    return cumVol > 0 ? cumTP / cumVol : tp;
  });
}

function calcStdDev(arr, period) {
  if (arr.length < period) return 0;
  const slice = arr.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
}

function calcOBV(candles) {
  const obv = [0];
  for (let i = 1; i < candles.length; i++) {
    const vol = candles[i].v || 1;
    if (candles[i].c > candles[i - 1].c)      obv.push(obv[i - 1] + vol);
    else if (candles[i].c < candles[i - 1].c) obv.push(obv[i - 1] - vol);
    else                                        obv.push(obv[i - 1]);
  }
  return obv;
}

function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
  const emaFast  = calcEMA(closes, fast);
  const emaSlow  = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signalPeriod);
  const lastMACD = macdLine[macdLine.length - 1];
  const lastSig  = signalLine[signalLine.length - 1];
  return { macd: lastMACD, signal: lastSig, histogram: lastMACD - lastSig };
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const needed = rsiPeriod + stochPeriod + Math.max(smoothK, smoothD) + 2;
  if (closes.length < needed) return { k: 50, d: 50 };
  const rsiValues = [];
  for (let i = rsiPeriod; i < closes.length; i++) rsiValues.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const hi = Math.max(...slice), lo = Math.min(...slice);
    rawK.push(hi !== lo ? ((rsiValues[i] - lo) / (hi - lo)) * 100 : 50);
  }
  if (!rawK.length) return { k: 50, d: 50 };
  const smoothedK = calcEMA(rawK, smoothK);
  const smoothedD = calcEMA(smoothedK, smoothD);
  return { k: smoothedK[smoothedK.length - 1], d: smoothedD[smoothedD.length - 1] };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return { adx: 25, pdi: 25, mdi: 25 };
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    const up = c.h - p.h, down = p.l - c.l;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
  }
  const wilderSmooth = (arr, p) => {
    if (arr.length < p) return [arr.reduce((s, v) => s + v, 0)];
    let s = arr.slice(0, p).reduce((a, v) => a + v, 0);
    const out = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
    return out;
  };
  const atrS = wilderSmooth(trs, period), pdiS = wilderSmooth(plusDMs, period), mdiS = wilderSmooth(minusDMs, period);
  const dxArr = atrS.map((atr, i) => {
    const pdi = atr > 0 ? (pdiS[i] / atr) * 100 : 0, mdi = atr > 0 ? (mdiS[i] / atr) * 100 : 0;
    const sum = pdi + mdi;
    return sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0;
  });
  const adxArr = wilderSmooth(dxArr, period);
  const li = adxArr.length - 1, lastATR = atrS[li];
  return { adx: adxArr[li], pdi: lastATR > 0 ? (pdiS[li] / lastATR) * 100 : 0, mdi: lastATR > 0 ? (mdiS[li] / lastATR) * 100 : 0 };
}

function calcIchimoku(candles) {
  if (candles.length < 9) return { tenkan: 0, kijun: 0, cloudPos: 'inside' };
  const high = arr => Math.max(...arr.map(c => c.h));
  const low  = arr => Math.min(...arr.map(c => c.l));
  const tenkan = (high(candles.slice(-9)) + low(candles.slice(-9))) / 2;
  const slice26 = candles.length >= 26 ? candles.slice(-26) : candles;
  const kijun  = (high(slice26) + low(slice26)) / 2;
  const slice52 = candles.length >= 52 ? candles.slice(-52) : slice26;
  const spanA  = (tenkan + kijun) / 2;
  const spanB  = (high(slice52) + low(slice52)) / 2;
  const price  = candles[candles.length - 1].c;
  const cloudTop = Math.max(spanA, spanB), cloudBot = Math.min(spanA, spanB);
  return { tenkan, kijun, spanA, spanB, cloudPos: price > cloudTop ? 'above' : price < cloudBot ? 'below' : 'inside' };
}

function calcWilliamsR(candles, period = 14) {
  if (candles.length < period) return -50;
  const slice = candles.slice(-period);
  const hh = Math.max(...slice.map(c => c.h)), ll = Math.min(...slice.map(c => c.l));
  return hh !== ll ? ((hh - candles[candles.length - 1].c) / (hh - ll)) * -100 : -50;
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  const slice = candles.slice(-period - 1);
  let posFlow = 0, negFlow = 0;
  for (let i = 1; i < slice.length; i++) {
    const prevTP = (slice[i-1].h + slice[i-1].l + slice[i-1].c) / 3;
    const currTP = (slice[i].h   + slice[i].l   + slice[i].c)   / 3;
    const rawFlow = currTP * (slice[i].v || 1);
    if (currTP > prevTP) posFlow += rawFlow; else if (currTP < prevTP) negFlow += rawFlow;
  }
  if (negFlow === 0) return posFlow > 0 ? 100 : 50;
  return 100 - 100 / (1 + posFlow / negFlow);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++)
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
  return sum / period;
}

function calcHMA(data, period) {
  period = period || 16;
  if (data.length < period * 2) return data.slice(-1);
  function wma(arr, n) {
    if (arr.length < n) return [arr[arr.length - 1]];
    const result = [];
    for (let i = n - 1; i < arr.length; i++) {
      let sum = 0, wSum = 0;
      for (let j = 0; j < n; j++) { sum += arr[i - j] * (n - j); wSum += (n - j); }
      result.push(sum / wSum);
    }
    return result;
  }
  const half = Math.floor(period / 2), sqrtP = Math.floor(Math.sqrt(period));
  const wmaHalf = wma(data, half), wmaFull = wma(data, period);
  const minLen = Math.min(wmaHalf.length, wmaFull.length);
  const diff = [];
  for (let i = 0; i < minLen; i++) diff.push(2 * wmaHalf[wmaHalf.length - minLen + i] - wmaFull[wmaFull.length - minLen + i]);
  return wma(diff, sqrtP);
}

function calcVWMA(candles, period) {
  period = period || 20;
  const result = [];
  for (let i = 0; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - period + 1), i + 1);
    let pv = 0, v = 0;
    for (const c of slice) { pv += c.c * (c.v || 1); v += (c.v || 1); }
    result.push(v > 0 ? pv / v : candles[i].c);
  }
  return result;
}

function calcSMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(data[i]); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function calcSupertrend(candles, period, multiplier) {
  period = period || 10; multiplier = multiplier || 3.0;
  if (candles.length < period + 2) return { signal: 0, bullish: null };
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const atrs = [atr];
  for (let i = period; i < trs.length; i++) { atr = (atr * (period - 1) + trs[i]) / period; atrs.push(atr); }
  let finalUpper = 0, finalLower = 0, supertrend = 0, bullish = false, initialized = false;
  for (let i = 0; i < atrs.length; i++) {
    const ci = candles[i + 1], hl2 = (ci.h + ci.l) / 2;
    const rawUpper = hl2 + multiplier * atrs[i], rawLower = hl2 - multiplier * atrs[i];
    const prevClose = candles[i].c;
    if (!initialized) { finalUpper = rawUpper; finalLower = rawLower; supertrend = rawUpper; bullish = false; initialized = true; }
    else {
      const newUpper = (rawUpper < finalUpper || prevClose > finalUpper) ? rawUpper : finalUpper;
      const newLower = (rawLower > finalLower || prevClose < finalLower) ? rawLower : finalLower;
      const prevST = supertrend;
      if (prevST === finalUpper) { bullish = ci.c > newUpper; supertrend = bullish ? newLower : newUpper; }
      else                        { bullish = ci.c >= newLower; supertrend = bullish ? newLower : newUpper; }
      finalUpper = newUpper; finalLower = newLower;
    }
  }
  return { signal: bullish ? 1 : -1, bullish, supertrend };
}

function calcCCI(candles, period) {
  period = period || 14;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const tps = slice.map(c => (c.h + c.l + c.c) / 3);
  const mean = tps.reduce((s, v) => s + v, 0) / period;
  const meanDev = tps.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
  return meanDev > 0 ? (tps[tps.length - 1] - mean) / (0.015 * meanDev) : 0;
}

function calcCMF(candles, period) {
  period = period || 20;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  let mfvSum = 0, volSum = 0;
  for (const c of slice) {
    const range = c.h - c.l, vol = c.v || 1;
    const mfm = range > 0 ? ((c.c - c.l) - (c.h - c.c)) / range : 0;
    mfvSum += mfm * vol; volSum += vol;
  }
  return volSum > 0 ? mfvSum / volSum : 0;
}

function calcFisher(candles, period) {
  period = period || 10;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const hh = Math.max(...slice.map(c => c.h)), ll = Math.min(...slice.map(c => c.l));
  const range = hh - ll;
  let value = range > 0 ? 2 * ((candles[candles.length - 1].c - ll) / range) - 1 : 0;
  value = Math.max(-0.999, Math.min(0.999, value));
  return 0.5 * Math.log((1 + value) / (1 - value));
}

function calcKeltner(candles, period, mult) {
  period = period || 20; mult = mult || 2.0;
  if (candles.length < period) return { position: 0.5 };
  const closes = candles.map(c => c.c);
  const ema = calcEMA(closes, period), middle = ema[ema.length - 1];
  const atr = calcATR(candles, period);
  const upper = middle + mult * atr, lower = middle - mult * atr;
  const width = Math.max(upper - lower, middle * 0.0001);
  return { position: Math.max(0, Math.min(1, (closes[closes.length - 1] - lower) / width)) };
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return { position: 0.5 };
  const slice = closes.slice(-period), middle = average(slice);
  const std = calcStdDev(closes, period);
  const upper = middle + std * 2, lower = middle - std * 2;
  const width = Math.max(upper - lower, middle * 0.0001);
  return { position: clamp((slice[slice.length - 1] - lower) / width, 0, 1) };
}

function calcTrendPersistence(closes, emaSeries, lookback = 8) {
  const span = Math.min(lookback, closes.length, emaSeries.length);
  const recentCloses = closes.slice(-span), recentEma = emaSeries.slice(-span);
  const above = recentCloses.filter((c, i) => c >= recentEma[i]).length;
  const aboveRate = span ? (above / span) * 100 : 50;
  const emaStart = recentEma[0] || recentEma[recentEma.length - 1] || 1;
  const slopePct = emaStart ? ((recentEma[recentEma.length - 1] - emaStart) / emaStart) * 100 : 0;
  return { signal: clamp(((aboveRate - 50) / 30) + slopePct * 4, -1, 1) };
}

function calcStructureBias(candles, atrPct) {
  if (!candles || candles.length < 12) return { signal: 0, zone: 'none' };
  const recent = candles.slice(-24), latest = recent[recent.length - 1].c;
  const support = Math.min(...recent.map(c => c.l)), resistance = Math.max(...recent.map(c => c.h));
  const supportGapPct    = latest > 0 ? ((latest - support) / latest) * 100 : 0;
  const resistanceGapPct = latest > 0 ? ((resistance - latest) / latest) * 100 : 0;
  const bufferPct = clamp(Math.max((atrPct || 0) * 1.25, 0.35), 0.35, 2.4);
  let zone = 'middle', signal = 0;
  if (supportGapPct <= bufferPct && supportGapPct <= resistanceGapPct) {
    zone = 'support'; signal = clamp((bufferPct - supportGapPct) / bufferPct, 0, 1) * 0.85;
  } else if (resistanceGapPct <= bufferPct && resistanceGapPct < supportGapPct) {
    zone = 'resistance'; signal = -clamp((bufferPct - resistanceGapPct) / bufferPct, 0, 1) * 0.85;
  }
  return { signal, zone, supportGapPct, resistanceGapPct };
}

function slopeOBV(arr, n = 5) {
  if (arr.length < n + 1) return 0;
  const r = arr.slice(-n);
  const avg = (Math.abs(r[0]) + Math.abs(r[r.length - 1])) / 2 || 1;
  return ((r[r.length - 1] - r[0]) / avg) * 100;
}

function summarizeAgreement(signalMap) {
  const values = Object.values(signalMap).filter(v => Math.abs(v) >= 0.08);
  if (!values.length) return { agreement: 0.5, conflict: 0 };
  const bulls = values.filter(v => v > 0).length, bears = values.filter(v => v < 0).length;
  const active = bulls + bears, majority = Math.max(bulls, bears), minority = Math.min(bulls, bears);
  return { agreement: active ? majority / active : 0.5, conflict: active ? minority / active : 0, bulls, bears };
}

function scoreBucket(absScore) {
  if (absScore >= 0.4) return 'strong';
  if (absScore >= 0.25) return 'moderate';
  if (absScore >= 0.1) return 'light';
  return 'neutral';
}

// ── Main signal model (verbatim from backtest-runner.js) ─────────
function buildSignalModel(candles, sym = null) {
  if (!candles || candles.length < 26) return null;
  const closes = candles.map(c => c.c), lastPrice = closes[closes.length - 1];

  const rsi = calcRSI(closes);
  let rsiSig = rsi > 70 ? -0.6 - ((rsi - 70) / 30) * 0.4 : rsi < 30 ? 0.6 + ((30 - rsi) / 30) * 0.4 : (rsi - 50) / 50 * 0.3;

  const ema9 = calcEMA(closes, 9), ema21 = calcEMA(closes, 21);
  const emaCross = (ema9[ema9.length-1] - ema21[ema21.length-1]) / (ema21[ema21.length-1] || 1) * 100;
  const emaSig = clamp(emaCross * 5, -1, 1);

  const vwapRolling = calcVWAP(candles.slice(-80));
  const vwapRollingLast = vwapRolling[vwapRolling.length - 1];
  const vwapDev = ((lastPrice - vwapRollingLast) / (vwapRollingLast || 1)) * 100;
  let vwapSig = 0;
  if (Math.abs(vwapDev) < 0.3) vwapSig = 0;
  else if (vwapDev > 1.5) vwapSig = -0.5; else if (vwapDev < -1.5) vwapSig = 0.5;
  else vwapSig = vwapDev > 0 ? 0.3 : -0.3;

  const obv = calcOBV(candles), obvSig = clamp(slopeOBV(obv, 8) / 5, -1, 1);

  const recent = candles.slice(-12);
  let buyV = 0, sellV = 0;
  recent.forEach(c => { const range = c.h - c.l || 0.0001, bodyPos = (c.c - c.l) / range, vol = c.v || 1; buyV += vol * bodyPos; sellV += vol * (1 - bodyPos); });
  const volSig = clamp((buyV / (sellV || 1) - 1) * 0.5, -1, 1);

  const mom = closes.length > 6 ? ((closes[closes.length-1] - closes[closes.length-7]) / (closes[closes.length-7] || 1)) * 100 : 0;
  const momSig = clamp(mom / 2, -1, 1);

  const atr = calcATR(candles), atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
  const bands = calcBollinger(closes);
  let bandSig = 0;
  if (bands.position >= 0.88) bandSig = -clamp((bands.position - 0.88) / 0.12, 0, 1);
  else if (bands.position <= 0.12) bandSig = clamp((0.12 - bands.position) / 0.12, 0, 1);
  else bandSig = clamp(-(bands.position - 0.5) * 0.45, -0.22, 0.22);

  const persistence = calcTrendPersistence(closes, ema21);
  const structure   = calcStructureBias(candles, atrPct);
  const macdR       = calcMACD(closes);
  const macdHistNorm = lastPrice > 0 ? (macdR.histogram / lastPrice) * 1000 : 0;
  const macdCross   = macdR.macd > macdR.signal ? 0.18 : macdR.macd < macdR.signal ? -0.18 : 0;
  const macdSig     = clamp(macdHistNorm * 2.5 + macdCross, -1, 1);

  const stochR = calcStochRSI(closes);
  let stochSig = stochR.k > 80 ? -0.6 - ((stochR.k - 80) / 20) * 0.4 : stochR.k < 20 ? 0.6 + ((20 - stochR.k) / 20) * 0.4 : (stochR.k - 50) / 50 * 0.35;
  stochSig = clamp(stochSig + clamp((stochR.k - stochR.d) / 20, -0.18, 0.18), -1, 1);

  const adxR   = calcADX(candles);
  const diDiff = (adxR.pdi - adxR.mdi) / Math.max(adxR.pdi + adxR.mdi, 1);
  const adxSig = clamp(diDiff * clamp(adxR.adx / 50, 0, 1) * 1.2, -1, 1);

  const ichi = calcIchimoku(candles);
  let ichiSig = ichi.cloudPos === 'above' ? 0.5 + (ichi.tenkan > ichi.kijun ? 0.2 : 0) : ichi.cloudPos === 'below' ? -0.5 - (ichi.tenkan < ichi.kijun ? 0.2 : 0) : ichi.tenkan > ichi.kijun ? 0.12 : ichi.tenkan < ichi.kijun ? -0.12 : 0;
  ichiSig = clamp(ichiSig, -1, 1);

  const wR = calcWilliamsR(candles);
  let wRSig = wR > -20 ? -0.6 - ((wR + 20) / 20) * 0.4 : wR < -80 ? 0.6 + ((-80 - wR) / 20) * 0.4 : (wR + 50) / 50 * -0.3;
  wRSig = clamp(wRSig, -1, 1);

  const mfi = calcMFI(candles);
  let mfiSig = mfi > 80 ? -0.6 - ((mfi - 80) / 20) * 0.4 : mfi < 20 ? 0.6 + ((20 - mfi) / 20) * 0.4 : (mfi - 50) / 50 * 0.35;
  mfiSig = clamp(mfiSig, -1, 1);

  const hmaLine = calcHMA(closes, 16);
  const hmaCurr = hmaLine.length ? hmaLine[hmaLine.length - 1] : lastPrice;
  const hmaPrev2 = hmaLine.length > 2 ? hmaLine[hmaLine.length - 3] : hmaCurr;
  const hmaSlope = (hmaCurr - hmaPrev2) / (Math.abs(hmaPrev2) || 1) * 100;
  const hmaDevPct = (lastPrice - hmaCurr) / (Math.abs(hmaCurr) || 1) * 100;
  let hmaSig = clamp(hmaSlope * 8, -0.7, 0.7);
  if (Math.abs(hmaDevPct) > 0.4) hmaSig += clamp(-hmaDevPct * 0.28, -0.3, 0.3);
  hmaSig = clamp(hmaSig, -1, 1);

  const vwmaLine = calcVWMA(candles, 20);
  const vwmaCurr = vwmaLine[vwmaLine.length - 1];
  const vwmaPrev = vwmaLine.length > 3 ? vwmaLine[vwmaLine.length - 4] : vwmaCurr;
  const vwmaSlope = (vwmaCurr - vwmaPrev) / (Math.abs(vwmaPrev) || 1) * 100;
  const vwmaDevPct = (lastPrice - vwmaCurr) / (Math.abs(vwmaCurr) || 1) * 100;
  let vwmaSig = clamp(vwmaSlope * 6, -0.6, 0.6);
  vwmaSig = clamp(vwmaSig + clamp(vwmaDevPct * 0.35, -0.4, 0.4), -1, 1);

  const sma9arr = calcSMA(closes, 9), sma21arr = calcSMA(closes, 21);
  const smaCross = (sma9arr[sma9arr.length - 1] - sma21arr[sma21arr.length - 1]) / (Math.abs(sma21arr[sma21arr.length - 1]) || 1) * 100;
  const smaSig = clamp(smaCross * 5, -1, 1);

  const stR = calcSupertrend(candles, 10, 3.0), supertrendSig = stR.signal;

  const cciVal = calcCCI(candles, 14);
  let cciSig = cciVal > 150 ? -clamp((cciVal - 100) / 150, 0, 1) : cciVal < -150 ? clamp((-100 - cciVal) / 150, 0, 1) : clamp(-cciVal / 200, -0.3, 0.3);
  cciSig = clamp(cciSig, -1, 1);

  const cmfSig    = clamp(calcCMF(candles, 20) * 2.5, -1, 1);
  const fisherSig = clamp(-calcFisher(candles, 10) / 2.5, -1, 1);
  const kelt      = calcKeltner(candles, 20, 2.0);
  let keltSig = kelt.position >= 0.88 ? -clamp((kelt.position - 0.88) / 0.12, 0, 1) : kelt.position <= 0.12 ? clamp((0.12 - kelt.position) / 0.12, 0, 1) : clamp(-(kelt.position - 0.5) * 0.45, -0.22, 0.22);

  // Trend regime modulation — suppress contrarian oscillators in strong trends
  const isBullTrend = emaCross > 0.15 && adxR.pdi > adxR.mdi && adxR.adx > 22;
  const isBearTrend = emaCross < -0.15 && adxR.mdi > adxR.pdi && adxR.adx > 22;
  if (isBullTrend || isBearTrend) {
    const sf = clamp((adxR.adx - 22) / 28, 0, 0.70);
    if (isBullTrend) {
      if (rsiSig < 0) rsiSig *= (1 - sf); if (stochSig < 0) stochSig *= (1 - sf);
      if (wRSig < 0) wRSig *= (1 - sf); if (bandSig < 0) bandSig *= (1 - sf * 0.6);
      if (mfiSig < 0) mfiSig *= (1 - sf * 0.6);
    } else {
      if (rsiSig > 0) rsiSig *= (1 - sf); if (stochSig > 0) stochSig *= (1 - sf);
      if (wRSig > 0) wRSig *= (1 - sf); if (bandSig > 0) bandSig *= (1 - sf * 0.6);
      if (mfiSig > 0) mfiSig *= (1 - sf * 0.6);
    }
  }

  const sv = {
    rsi: rsiSig, ema: emaSig, vwap: vwapSig, obv: obvSig, volume: volSig,
    momentum: momSig, bands: bandSig, persistence: persistence.signal, structure: structure.signal,
    macd: macdSig, stochrsi: stochSig, adx: adxSig, ichimoku: ichiSig, williamsR: wRSig, mfi: mfiSig,
    hma: hmaSig, vwma: vwmaSig, sma: smaSig, supertrend: supertrendSig, cci: cciSig, cmf: cmfSig,
    fisher: fisherSig, keltner: keltSig,
  };

  const coinBias = (sym && PER_COIN_INDICATOR_BIAS[sym]) ? PER_COIN_INDICATOR_BIAS[sym] : {};

  // --- QUANT CORE INTEGRATION ---
  let hurstRegime = 'mean_reversion';
  let hmmPath = [];
  if (global.window && global.window.QuantCore) {
    if (global.window.QuantCore.kalman) {
        const kalmanResult = global.window.QuantCore.kalman.process(closes);
        const kVel = kalmanResult.velocities[kalmanResult.velocities.length - 1] || 0;
        sv.momentum = clamp(sv.momentum + kVel * 5, -1, 1);
    }
    if (global.window.QuantCore.hurst) {
        const h_exp = global.window.QuantCore.hurst.rolling(closes, 50);
        hurstRegime = global.window.QuantCore.hurst.classify(h_exp).signal_gate;
    }
    if (global.window.QuantCore.hmm && sym) {
        const obsSeq = closes.map((c, i) => {
            const h = candles[i].h;
            const l = candles[i].l;
            return {
                returns: i > 0 ? (c - closes[i-1])/(closes[i-1]||1) : 0,
                volatility: (h - l)/(l||1)
            };
        });
        global.window.QuantCore.hmm.classify(obsSeq);
        hmmPath = global.window.QuantCore.hmm.lastViterbiPath || [];
    }
  }

  let hmmState = hmmPath.length > 0 ? hmmPath[hmmPath.length - 1] : 0;
  if (hmmState === 3 || hurstRegime === 'mean_reversion') {
      sv.supertrend *= 0.5;
      sv.ema *= 0.5;
      sv.macd *= 0.5;
      sv.vwma *= 0.5;
  }
  if (hmmState === 0 || hurstRegime === 'trending') {
      sv.rsi *= 0.5;
      sv.stochrsi *= 0.5;
      sv.williamsR *= 0.5;
  }
  // --- END QUANT CORE INTEGRATION ---
  const keys = Object.keys(sv);
  const effW = k => (COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0) * (coinBias[k] ?? 1.0);
  const totalWeight = keys.reduce((s, k) => s + effW(k), 0) || 1;
  const rawComposite = keys.reduce((s, k) => s + sv[k] * effW(k), 0) / totalWeight;
  const adxGate = adxR.adx < 20 ? Math.max(0.25, adxR.adx / 20) : 1.0;
  const score   = clamp(rawComposite * SCORE_AMPLIFIER * adxGate, -1, 1);
  const agr     = summarizeAgreement(sv);

  return {
    score, absScore: Math.abs(score), coreScore: score,
    agreement: agr.agreement, conflict: agr.conflict,
    structureBias: structure.signal, structureZone: structure.zone,
    persistenceScore: persistence.signal,
    emaCross, mom, rsi, atrPct,
    signalVector: sv,
  };
}

// ── HTTP helper ───────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WECRYPTO-WF/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { resolve(httpGet(res.headers.location)); return; }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

const KRAKEN_PAIR = { BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLUSD', XRP: 'XXRPZUSD' };
const CB_PRODUCT  = { BTC: 'BTC-USD',  ETH: 'ETH-USD',  SOL: 'SOL-USD', XRP: 'XRP-USD'  };

async function fetchBinanceUSCandles(symbol, limit = 1000) {
  const PAGE = 1000;
  if (limit <= PAGE) {
    const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`;
    const { status, body } = await httpGet(url);
    if (status !== 200) throw new Error(`Binance.US HTTP ${status}`);
    const rows = JSON.parse(body);
    return rows.map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
  }
  const pages = []; let endTime = null, remaining = limit;
  while (remaining > 0) {
    const fetchCount = Math.min(PAGE, remaining);
    const url = endTime ? `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=5m&limit=${fetchCount}&endTime=${endTime}` : `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=5m&limit=${fetchCount}`;
    const { status, body } = await httpGet(url);
    if (status !== 200) throw new Error(`Binance.US HTTP ${status}`);
    const rows = JSON.parse(body);
    if (!Array.isArray(rows) || rows.length === 0) break;
    pages.unshift(rows); endTime = Number(rows[0][0]) - 1; remaining -= rows.length;
    if (rows.length < fetchCount) break;
    await new Promise(r => setTimeout(r, 150));
  }
  return pages.flat().map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
}

async function fetchKrakenCandles(sym, limit = 1000) {
  const pair = KRAKEN_PAIR[sym]; if (!pair) throw new Error(`No Kraken pair for ${sym}`);
  const since = Math.floor((Date.now() - (limit * 5 * 60 * 1000)) / 1000);
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=5&since=${since}`;
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`Kraken HTTP ${status}`);
  const json = JSON.parse(body);
  if (json.error && json.error.length) throw new Error(`Kraken: ${json.error[0]}`);
  const key = Object.keys(json.result).find(k => k !== 'last');
  const rows = json.result[key];
  if (!Array.isArray(rows) || !rows.length) throw new Error(`No Kraken data`);
  return rows.map(r => ({ t: Number(r[0]) * 1000, o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[6]) }));
}

async function fetchCoinbaseCandles(sym, limit = 300) {
  const product = CB_PRODUCT[sym]; if (!product) throw new Error(`No Coinbase product for ${sym}`);
  const end = Math.floor(Date.now() / 1000), start = end - limit * 5 * 60;
  const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${product}/candles?start=${start}&end=${end}&granularity=FIVE_MINUTE&limit=${limit}`;
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`Coinbase HTTP ${status}`);
  const json = JSON.parse(body);
  if (!Array.isArray(json.candles) || !json.candles.length) throw new Error(`No Coinbase data`);
  return json.candles.reverse().map(r => ({ t: Number(r.start) * 1000, o: parseFloat(r.open), h: parseFloat(r.high), l: parseFloat(r.low), c: parseFloat(r.close), v: parseFloat(r.volume) }));
}

async function fetchCandles(coin, limit) {
  const errors = [];
  try { return await fetchBinanceUSCandles(coin.binSym, limit); } catch(e) { errors.push(`BinanceUS: ${e.message}`); }
  try { return await fetchKrakenCandles(coin.sym, limit); }      catch(e) { errors.push(`Kraken: ${e.message}`); }
  try { return await fetchCoinbaseCandles(coin.sym, Math.min(300, limit)); } catch(e) { errors.push(`Coinbase: ${e.message}`); }
  throw new Error(errors.join(' | '));
}

// ── Precompute signals for efficient fold evaluation ──────────────
// Runs buildSignalModel once per bar, stores the minimal data needed
// for threshold grid search. Folds then just filter this array.
function precomputeAllSignals(candles, sym, horizonMin) {
  const BARMIN = 5, LIVE_WINDOW = 300;
  const horizonBars = Math.max(1, Math.round(horizonMin / BARMIN));
  const startIdx    = Math.max(52, BACKTEST_MIN_TRAIN_OBS);
  const signals     = [];
  for (let idx = startIdx; idx < candles.length - horizonBars; idx++) {
    const windowCandles = candles.slice(Math.max(0, idx - LIVE_WINDOW + 1), idx + 1);
    const model = buildSignalModel(windowCandles, sym);
    if (!model) continue;
    const entry = candles[idx].c, exit = candles[idx + horizonBars].c;
    const returnPct = entry > 0 ? ((exit - entry) / entry) * 100 : 0;
    signals.push({
      barIdx: idx,
      absScore: model.absScore, score: model.score, coreScore: model.coreScore,
      agreement: model.agreement, conflict: model.conflict,
      structureZone: model.structureZone, structureBias: model.structureBias,
      persistenceScore: model.persistenceScore || 0,
      emaCross: model.emaCross, mom: model.mom, atrPct: model.atrPct,
      returnPct, t: candles[idx].t,
    });
  }
  return signals;
}

// Apply filter to a pre-computed signal record
function passesFilter(s, entryThreshold, minAgreement, maxThreshold) {
  const persistenceVeto = Math.sign(s.persistenceScore || 0) !== 0
    && Math.sign(s.persistenceScore || 0) !== Math.sign(s.coreScore || 0)
    && Math.abs(s.persistenceScore || 0) >= 0.35
    && Math.abs(s.coreScore || 0) < (entryThreshold + 0.04);
  return s.absScore >= entryThreshold
    && s.agreement >= minAgreement
    && !(maxThreshold && s.absScore > maxThreshold)
    && !(s.conflict >= 0.38 && s.agreement < minAgreement + 0.08)
    && !(Math.abs(s.coreScore || 0) < entryThreshold * 0.92 && s.conflict >= 0.30)
    && !(s.structureZone === 'resistance' && s.score > 0 && s.agreement < 0.65 && Math.abs(s.structureBias || 0) >= 0.18)
    && !(s.structureZone === 'support'    && s.score < 0 && s.agreement < 0.65 && Math.abs(s.structureBias || 0) >= 0.18)
    && !persistenceVeto;
}

// Evaluate a set of pre-computed signals with given thresholds
function evaluateSet(signals, entryThreshold, minAgreement, maxThreshold) {
  const active = signals.filter(s => passesFilter(s, entryThreshold, minAgreement, maxThreshold));
  const total  = signals.length;
  if (!active.length) return { winRate: 0, coverage: 0, profitFactor: 0, wins: 0, losses: 0, count: 0 };
  const signedReturns = active.map(s => s.returnPct * (s.score > 0 ? 1 : -1));
  const wins   = signedReturns.filter(r => r > 0).length;
  const losses = signedReturns.filter(r => r < 0).length;
  const grossW = signedReturns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossL = Math.abs(signedReturns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  return {
    winRate: wins / active.length * 100,
    coverage: total ? active.length / total * 100 : 0,
    profitFactor: grossL > 0 ? grossW / grossL : grossW > 0 ? grossW : 0,
    wins, losses, count: active.length,
  };
}

// Grid-search calibration: find optimal thresholds on train set
function calibrateFold(trainSignals, horizonMin) {
  // WR target depends on horizon
  const wrTarget = horizonMin >= 15 ? 54 : horizonMin >= 10 ? 52 : 50;
  const etGrid   = [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55];
  const maGrid   = [0.50, 0.54, 0.58, 0.62, 0.66, 0.70, 0.72];

  let bestScore = -Infinity, bestET = 0.30, bestMA = 0.58;

  for (const et of etGrid) {
    for (const ma of maGrid) {
      const stats = evaluateSet(trainSignals, et, ma, null);
      if (stats.coverage < 8 || stats.profitFactor < 1.0 || stats.count < 5) continue;
      // Score: reward WR above target, penalise low coverage, bonus for high PF
      const score = (stats.winRate - wrTarget) * 2 + Math.log(Math.max(stats.coverage, 1)) + Math.log(Math.max(stats.profitFactor, 0.01));
      if (score > bestScore) { bestScore = score; bestET = et; bestMA = ma; }
    }
  }
  // If no valid combo found, fall back to defaults
  if (bestScore === -Infinity) {
    bestET = BACKTEST_FILTER_OVERRIDES[Symbol.for('fallback')]?.entryThreshold ?? 0.35;
    bestMA = 0.58;
  }
  return { entryThreshold: bestET, minAgreement: bestMA, calibScore: bestScore };
}

// Detect market regime for a candle slice
function detectRegime(candles) {
  if (candles.length < 22) return 'neutral';
  const closes = candles.map(c => c.c);
  const ema9   = calcEMA(closes, 9),  e9  = ema9[ema9.length - 1];
  const ema21  = calcEMA(closes, 21), e21 = ema21[ema21.length - 1];
  const mom    = closes.length > 6 ? ((closes[closes.length-1] - closes[closes.length-7]) / (closes[closes.length-7] || 1)) * 100 : 0;
  const adx    = calcADX(candles);
  if      (e9 > e21 && mom > 0.3)  return 'bull';
  else if (e9 < e21 && mom < -0.3) return 'bear';
  else if (adx.adx > 30)            return 'volatile';
  return 'flat';
}

// Classify UTC timestamp into trading session
function getSession(ts) {
  const h = new Date(ts).getUTCHours();
  if (h >= 0  && h < 6)  return 'Asia';
  if (h >= 7  && h < 12) return 'London';
  if (h >= 13 && h < 17) return 'NY Open';
  if (h >= 17 && h < 21) return 'NY Close';
  return 'Off-Hours';
}

// ── Run walk-forward for a single coin ───────────────────────────
async function runWalkForwardForCoin(sym, candles) {
  const startIdx  = Math.max(52, BACKTEST_MIN_TRAIN_OBS);
  const totalBars = candles.length;
  const foldCount = Math.max(0, Math.floor((totalBars - startIdx - TRAIN_BARS - TEST_BARS) / STEP_BARS) + 1);
  if (foldCount < 2) return null;

  const horizonResults = {};

  for (const horizonMin of SHORT_HORIZON_MINUTES) {
    process.stdout.write(`  h${horizonMin}m precompute...`);
    const allSignals = precomputeAllSignals(candles, sym, horizonMin);
    console.log(` ${allSignals.length} obs, ${foldCount} folds`);

    const folds = [];
    for (let fi = 0; fi < foldCount; fi++) {
      const foldStart = startIdx + fi * STEP_BARS;
      const trainEnd  = foldStart + TRAIN_BARS;
      const testEnd   = trainEnd  + TEST_BARS;

      const trainSigs = allSignals.filter(s => s.barIdx >= foldStart && s.barIdx < trainEnd);
      const testSigs  = allSignals.filter(s => s.barIdx >= trainEnd  && s.barIdx < testEnd);
      if (trainSigs.length < 5 || testSigs.length < 1) continue;

      // Calibrate on train
      const cal = calibrateFold(trainSigs, horizonMin);

      // IS (in-sample) stats with calibrated thresholds
      const isStats  = evaluateSet(trainSigs, cal.entryThreshold, cal.minAgreement, null);
      // OOS (out-of-sample) stats with same thresholds — strict
      const oosStats = evaluateSet(testSigs, cal.entryThreshold, cal.minAgreement, null);

      // Regime on train window
      const trainCandles = candles.slice(foldStart, trainEnd);
      const regime = detectRegime(trainCandles);

      // Session breakdown on test window
      const testActive = testSigs.filter(s => passesFilter(s, cal.entryThreshold, cal.minAgreement, null));
      const sessions = {};
      testActive.forEach(s => {
        const sess = getSession(s.t);
        if (!sessions[sess]) sessions[sess] = { w: 0, t: 0 };
        sessions[sess].t++;
        if (s.returnPct * (s.score > 0 ? 1 : -1) > 0) sessions[sess].w++;
      });

      folds.push({
        foldIdx: fi, foldStart, trainEnd, testEnd,
        regime, calibration: cal,
        isStats, oosStats,
        sessions,
        oofGap: isStats.winRate - oosStats.winRate,
      });
    }

    // Compute summary stats across folds
    const validFolds  = folds.filter(f => f.oosStats.count >= 2);
    const avgOOS_WR   = average(validFolds.map(f => f.oosStats.winRate));
    const avgIS_WR    = average(validFolds.map(f => f.isStats.winRate));
    const avgOofGap   = avgIS_WR - avgOOS_WR;
    const medET       = median(folds.map(f => f.calibration.entryThreshold));
    const medMA       = median(folds.map(f => f.calibration.minAgreement));

    const overfitLabel = avgOofGap > 8 ? 'HIGH' : avgOofGap >= 4 ? 'MODERATE' : 'STABLE';

    horizonResults[`h${horizonMin}`] = {
      horizonMin, folds, avgIS_WR, avgOOS_WR, avgOofGap, overfitLabel, medET, medMA,
      totalValidFolds: validFolds.length,
    };
  }

  return horizonResults;
}

// ── Report printer ────────────────────────────────────────────────
function printWalkForwardReport(sym, hrResults, logLines) {
  const D = '═'.repeat(74);
  const d = '─'.repeat(74);
  const line = s => { console.log(s); logLines.push(s); };

  line(`\n${D}`);
  line(` WALK-FORWARD: ${sym}  (TRAIN=${TRAIN_BARS} bars · TEST=${TEST_BARS} bars · STEP=${STEP_BARS})`);
  line(D);

  for (const horizonMin of SHORT_HORIZON_MINUTES) {
    const hr = hrResults[`h${horizonMin}`];
    if (!hr || hr.folds.length < 2) { line(` h${horizonMin}m  — insufficient folds`); continue; }

    line(`\n  h${horizonMin}m  [${hr.totalValidFolds} valid folds]`);
    line(`  Avg IS WR:  ${hr.avgIS_WR.toFixed(1)}%   Avg OOS WR: ${hr.avgOOS_WR.toFixed(1)}%   Gap: ${hr.avgOofGap.toFixed(1)}pp → ${hr.overfitLabel}`);
    line(`  Median calibrated thresholds:  entryThreshold=${hr.medET.toFixed(2)}  minAgreement=${hr.medMA.toFixed(2)}`);

    // Fold-by-fold table (last 10 folds)
    line(`\n  Fold | Regime    | IS WR%  | OOS WR% | OOS n  | Gap   | ET    | MA`);
    line(`  ${d.slice(0, 70)}`);
    const showFolds = hr.folds.slice(-10);
    for (const f of showFolds) {
      const oosWR = f.oosStats.winRate.toFixed(1).padStart(6);
      const isWR  = f.isStats.winRate.toFixed(1).padStart(6);
      const gap   = f.oofGap.toFixed(1).padStart(5);
      const gapFlag = Math.abs(f.oofGap) > 8 ? '⚠' : ' ';
      line(`  ${String(f.foldIdx).padStart(4)} | ${f.regime.padEnd(9)} | ${isWR}%  | ${oosWR}%  | ${String(f.oosStats.count).padStart(6)} | ${gap}pp${gapFlag} | ${f.calibration.entryThreshold.toFixed(2)}  | ${f.calibration.minAgreement.toFixed(2)}`);
    }
  }

  line(`\n${d}`);
  line(' RECOMMENDED BACKTEST_FILTER_OVERRIDES');
  line(d);
  const overrides = {};
  for (const horizonMin of SHORT_HORIZON_MINUTES) {
    const hr = hrResults[`h${horizonMin}`];
    if (hr) {
      if (!overrides[sym]) overrides[sym] = {};
      overrides[sym][`h${horizonMin}`] = { entryThreshold: +hr.medET.toFixed(2), minAgreement: +hr.medMA.toFixed(2) };
    }
  }
  const jsObj = JSON.stringify(overrides, null, 2).replace(/"([^"]+)":/g, '$1:');
  line('  // Paste into predictions.js and backtest-runner.js:');
  line(`  ${jsObj}`);
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const coins = FILTER_COIN ? PREDICTION_COINS.filter(c => c.sym === FILTER_COIN) : PREDICTION_COINS;
  if (FILTER_COIN && coins.length === 0) { console.error(`Unknown coin: ${FILTER_COIN}`); process.exit(1); }

  const dateStr = new Date().toISOString().slice(0, 10);
  const runTs   = new Date().toISOString();
  const logLines = [];

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  WECRYPTO — Walk-Forward Backtest (TRAIN→TEST rolling folds)    ║');
  console.log(`║  Days: ${DAYS_BACK}  Train: ${TRAIN_BARS}  Test: ${TEST_BARS}  Step: ${STEP_BARS}                      ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  const allResults = {};

  for (const coin of coins) {
    process.stdout.write(`\nFetching ${coin.sym}... `);
    let candles;
    try {
      candles = await fetchCandles(coin, CANDLES_WANT);
      console.log(`${candles.length} candles ✓`);
    } catch(e) {
      console.log(`FAILED: ${e.message}`);
      continue;
    }
    if (candles.length < TRAIN_BARS + TEST_BARS + 100) {
      console.log(`  Skipping ${coin.sym} — not enough data (${candles.length} candles)`);
      continue;
    }

    const hrResults = await runWalkForwardForCoin(coin.sym, candles);
    if (!hrResults) { console.log(`  Skipping ${coin.sym} — not enough folds`); continue; }
    allResults[coin.sym] = hrResults;

    printWalkForwardReport(coin.sym, hrResults, logLines);

    // Save per-coin JSON
    const jsonPath = path.join(LOG_DIR, `wf-${coin.sym}-${dateStr}.json`);
    try {
      fs.writeFileSync(jsonPath, JSON.stringify({ coin: coin.sym, generatedAt: runTs, daysBack: DAYS_BACK, trainBars: TRAIN_BARS, testBars: TEST_BARS, stepBars: STEP_BARS, results: hrResults }, null, 2));
      console.log(`  → JSON: ${jsonPath}`);
    } catch(e) { console.warn(`  Could not save JSON: ${e.message}`); }

    await new Promise(r => setTimeout(r, 300));
  }

  // Save combined log
  const logPath = path.join(LOG_DIR, `wf-${dateStr}.log`);
  try {
    fs.writeFileSync(logPath, logLines.join('\n'));
    console.log(`\nLog saved to: ${logPath}`);
  } catch(e) { console.warn(`Could not save log: ${e.message}`); }

  // Append to session checkpoint
  const cpSection = `\n## Walk-Forward Backtest — ${runTs}\n- Days: ${DAYS_BACK}  Train: ${TRAIN_BARS}  Test: ${TEST_BARS}  Step: ${STEP_BARS}\n- Coins: ${Object.keys(allResults).join(', ')}\n- Log: ${logPath}\n`;
  try { fs.appendFileSync(CHECKPOINT, cpSection); console.log(`Checkpoint updated: ${CHECKPOINT}`); } catch(e) { console.warn(`Could not update checkpoint: ${e.message}`); }

  console.log('\nDone.\n');
}

main().catch(e => { console.error('\nFatal error:', e); process.exit(1); });
