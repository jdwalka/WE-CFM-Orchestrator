#!/usr/bin/env node
// ================================================================
// WECRYPTO — Advanced Comprehensive Backtest Analysis Suite
// 10-section report: signal overview, indicator accuracy, risk
// metrics, regime analysis, session timing, edge decay, and more.
//
// Usage:  node advanced-backtest.js
//         node advanced-backtest.js --coin ETH --days 60
//         node advanced-backtest.js --all --days 30
// ================================================================
'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CLI args ─────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (f) => args.includes(f);
const FILTER_COIN  = getArg('--coin')?.toUpperCase() || null;
const DAYS_BACK    = parseInt(getArg('--days') || '30', 10);
const CANDLES_WANT = DAYS_BACK * 288;   // 288 × 5m = 1 day

// ── Log directory & checkpoint ────────────────────────────────────
const ROOT       = path.resolve(__dirname, '..');
const LOG_DIR    = path.join(ROOT, 'backtest-logs');
const CHECKPOINT = path.join(ROOT, 'WECRYPTO_SESSION_CHECKPOINT_20260501.md');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

// ── Coins ─────────────────────────────────────────────────────────
const PREDICTION_COINS = [
  { sym: 'BTC', binSym: 'BTCUSDT', mexcSym: 'BTCUSDT' },
  { sym: 'ETH', binSym: 'ETHUSDT', mexcSym: 'ETHUSDT' },
  { sym: 'SOL', binSym: 'SOLUSDT', mexcSym: 'SOLUSDT' },
  { sym: 'XRP', binSym: 'XRPUSDT', mexcSym: 'XRPUSDT' },
  { sym: 'DOGE', binSym: 'DOGEUSDT', mexcSym: 'DOGEUSDT' },
  { sym: 'BNB', binSym: 'BNBUSDT', mexcSym: 'BNBUSDT' },
  { sym: 'HYPE', binSym: 'HYPEUSDT', mexcSym: 'HYPEUSDT' },
];

// ── Weights (updated 2026-08) ──────────────────────────────────────
const COMPOSITE_WEIGHTS = {
  supertrend:0.10, hma:0.07, vwma:0.06, ema:0.05, sma:0.03, macd:0.07, persistence:0.07,
  bands:0.08, keltner:0.05, williamsR:0.07, rsi:0.06, cci:0.05, stochrsi:0.04,
  volume:0.10, obv:0.07, cmf:0.07, mfi:0.07,
  structure:0.10, ichimoku:0.05, adx:0.04, fisher:0.04,
};
const OUTER_ORBITAL_WEIGHTS = { momentum: 0.05, vwap: 0.05 };

const PER_COIN_INDICATOR_BIAS = {
  BTC: {
    bands: 1.09, williamsR: 1.08, obv: 0.956, vwap: 1.05, hma: 0.9, momentum: 0.55,
    stochrsi: 1.05, sma: 0.95, adx: 1.01, mfi: 1.13, supertrend: 0.942, ichimoku: 0.885,
    keltner: 1.131, volume: 0.94, ema: 0.891, vwma: 0.86, macd: 0.91, structure: 1.158,
    fisher: 1.08, persistence: 0.963, rsi: 0.637, cci: 1.07, cmf: 1.01, fearGreed: 1,
    book: 0.85, flow: 0.8,
  },
  ETH: {
    bands: 1.33, mfi: 1.1, sma: 0.957, adx: 1.11, supertrend: 1.069, ichimoku: 0.964,
    hma: 0.85, vwap: 0.82, ema: 0.908, cmf: 1.1, momentum: 0.55, obv: 0.918,
    fisher: 1.24, vwma: 0.94, macd: 0.851, cci: 1.22, rsi: 0.81, structure: 1.2,
    persistence: 0.981, stochrsi: 1.11, williamsR: 1.3, keltner: 1.291, volume: 0.92,
    fearGreed: 1, book: 0.9, flow: 0.85,
  },
  SOL: {
    williamsR: 1.152, cci: 1.12, sma: 1.061, mfi: 1.13, rsi: 1.02, supertrend: 0.963,
    ema: 0.876, bands: 1.18, stochrsi: 0.86, volume: 0.95, cmf: 0.8, ichimoku: 0.88,
    persistence: 0.709, adx: 0.9, hma: 0.76, vwap: 0.7, vwma: 0.712, macd: 0.9,
    keltner: 1.351, fisher: 1.13, momentum: 0.55, obv: 0.863, structure: 1.285,
    fearGreed: 0.9, book: 0.75, flow: 0.7,
  },
  XRP: {
    vwap: 0.98, rsi: 0.91, fisher: 0.83, hma: 1.009, mfi: 1.02, momentum: 0.55,
    sma: 0.765, macd: 1.063, vwma: 0.803, persistence: 0.865, ichimoku: 0.859, obv: 0.809,
    volume: 0.84, adx: 0.83, ema: 0.733, keltner: 0.947, cci: 0.936, williamsR: 0.875,
    supertrend: 0.728, cmf: 0.84, stochrsi: 0.988, bands: 0.992, structure: 1.127,
    fearGreed: 0.7, book: 0.606, flow: 0.556,
  },
  DOGE: {
    obv: 4.5, volume: 3.5, cmf: 3, bands: 2.5, mfi: 2, structure: 1.8, fisher: 1.8,
    keltner: 1.212, cci: 1.012, williamsR: 0.824, rsi: 0.5, persistence: 0.252, ema: 0.277,
    macd: 0.181, ichimoku: 0.177, adx: 0.105, hma: 0.296, sma: 0, supertrend: 0.197,
    vwap: 0.102, stochrsi: 0.068, momentum: 0.052, vwma: 0.029, fearGreed: 2,
  },
  BNB: {
    sma: 5, mfi: 4.5, ema: 4, vwap: 3.5, hma: 3, vwma: 2.5, volume: 3.5, momentum: 2,
    persistence: 2, macd: 1.5, ichimoku: 2, supertrend: 2, cmf: 1.5, obv: 0.5,
    fisher: 0.831, cci: 0.34, adx: 0.505, structure: 0.065, keltner: 0.093,
    williamsR: 0.089, bands: 0.093, rsi: 0.071, stochrsi: 0.089, fearGreed: 0.8,
  },
  HYPE: {
    williamsR: 6.5, fisher: 5, cci: 4.5, bands: 3, keltner: 2, rsi: 1.5, stochrsi: 1.2,
    structure: 0.8, obv: 0.5, persistence: 0.4, vwap: 0.3, ema: 0.3, cmf: 0.3,
    adx: 0.3, ichimoku: 0.2, sma: 0, vwma: 0.2, supertrend: 0.1, momentum: 0.05,
    hma: 0.05, macd: 0.1, volume: 0.3, mfi: 0.3, fearGreed: 1.8,
  },
};

const BACKTEST_FILTER_OVERRIDES = {
  BTC:  { h1:{entryThreshold:0.06,minAgreement:0.50}, h5:{entryThreshold:0.08,minAgreement:0.50}, h10:{entryThreshold:0.08,minAgreement:0.50}, h15:{entryThreshold:0.06,minAgreement:0.50} },
  ETH:  { h1:{entryThreshold:0.06,minAgreement:0.50}, h5:{entryThreshold:0.08,minAgreement:0.50}, h10:{entryThreshold:0.08,minAgreement:0.50}, h15:{entryThreshold:0.06,minAgreement:0.50} },
  SOL:  { h1:{entryThreshold:0.06,minAgreement:0.50}, h5:{entryThreshold:0.08,minAgreement:0.50}, h10:{entryThreshold:0.08,minAgreement:0.50}, h15:{entryThreshold:0.06,minAgreement:0.50} },
  XRP:  { h1:{entryThreshold:0.06,minAgreement:0.50}, h5:{entryThreshold:0.08,minAgreement:0.50}, h10:{entryThreshold:0.08,minAgreement:0.50}, h15:{entryThreshold:0.06,minAgreement:0.50} },
  DOGE: { h1:{entryThreshold:0.06,minAgreement:0.50}, h5:{entryThreshold:0.08,minAgreement:0.50}, h10:{entryThreshold:0.08,minAgreement:0.50}, h15:{entryThreshold:0.06,minAgreement:0.50} },
  BNB:  { h1:{entryThreshold:0.06,minAgreement:0.50}, h5:{entryThreshold:0.08,minAgreement:0.50}, h10:{entryThreshold:0.08,minAgreement:0.50}, h15:{entryThreshold:0.06,minAgreement:0.50} },
  HYPE: { h1:{entryThreshold:0.06,minAgreement:0.50}, h5:{entryThreshold:0.08,minAgreement:0.50}, h10:{entryThreshold:0.08,minAgreement:0.50}, h15:{entryThreshold:0.06,minAgreement:0.50} },
};

const SCORE_AMPLIFIER        = 1.6;
const BACKTEST_MIN_TRAIN_OBS = 36;
const SHORT_HORIZON_MINUTES  = [1, 5, 10, 15];

// ── Utility ───────────────────────────────────────────────────────
const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const average = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
const median  = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
};
const stdDev = arr => {
  if (arr.length < 2) return 0;
  const mu = average(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length);
};
const downStdDev = arr => {
  if (arr.length < 2) return 0;
  const mu = average(arr), neg = arr.filter(v => v < mu);
  if (!neg.length) return 0;
  return Math.sqrt(neg.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length);
};

// ── EXACT Indicator Functions (verbatim from backtest-runner.js) ──
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) avgGain += d; else avgLoss -= d; }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcEMA(data, period) {
  const k = 2 / (period + 1), ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i-1] * (1 - k));
  return ema;
}

function calcVWAP(candles) {
  let cumVol = 0, cumTP = 0;
  return candles.map(c => { const tp = (c.h + c.l + c.c) / 3, vol = c.v || 1; cumVol += vol; cumTP += tp * vol; return cumVol > 0 ? cumTP / cumVol : tp; });
}

function calcStdDev(arr, period) {
  if (arr.length < period) return 0;
  const slice = arr.slice(-period), mean = slice.reduce((s, v) => s + v, 0) / period;
  return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
}

function calcOBV(candles) {
  const obv = [0];
  for (let i = 1; i < candles.length; i++) {
    const vol = candles[i].v || 1;
    obv.push(candles[i].c > candles[i-1].c ? obv[i-1] + vol : candles[i].c < candles[i-1].c ? obv[i-1] - vol : obv[i-1]);
  }
  return obv;
}

function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
  const emaFast = calcEMA(closes, fast), emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signalPeriod);
  const lastMACD = macdLine[macdLine.length - 1], lastSig = signalLine[signalLine.length - 1];
  return { macd: lastMACD, signal: lastSig, histogram: lastMACD - lastSig };
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const needed = rsiPeriod + stochPeriod + Math.max(smoothK, smoothD) + 2;
  if (closes.length < needed) return { k: 50, d: 50 };
  const rsiValues = [];
  for (let i = rsiPeriod; i < closes.length; i++) rsiValues.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod + 1, i + 1), hi = Math.max(...slice), lo = Math.min(...slice);
    rawK.push(hi !== lo ? ((rsiValues[i] - lo) / (hi - lo)) * 100 : 50);
  }
  if (!rawK.length) return { k: 50, d: 50 };
  const smoothedK = calcEMA(rawK, smoothK), smoothedD = calcEMA(smoothedK, smoothD);
  return { k: smoothedK[smoothedK.length - 1], d: smoothedD[smoothedD.length - 1] };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return { adx: 25, pdi: 25, mdi: 25 };
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    const up = c.h - p.h, down = p.l - c.l;
    plusDMs.push(up > down && up > 0 ? up : 0); minusDMs.push(down > up && down > 0 ? down : 0);
  }
  const wilderSmooth = (arr, p) => {
    if (arr.length < p) return [arr.reduce((s, v) => s + v, 0)];
    let s = arr.slice(0, p).reduce((a, v) => a + v, 0);
    const out = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
    return out;
  };
  const atrS = wilderSmooth(trs, period), pdiS = wilderSmooth(plusDMs, period), mdiS = wilderSmooth(minusDMs, period);
  const dxArr = atrS.map((atr, i) => { const pdi = atr > 0 ? (pdiS[i] / atr) * 100 : 0, mdi = atr > 0 ? (mdiS[i] / atr) * 100 : 0, sum = pdi + mdi; return sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0; });
  const adxArr = wilderSmooth(dxArr, period), li = adxArr.length - 1, lastATR = atrS[li];
  return { adx: adxArr[li], pdi: lastATR > 0 ? (pdiS[li] / lastATR) * 100 : 0, mdi: lastATR > 0 ? (mdiS[li] / lastATR) * 100 : 0 };
}

function calcIchimoku(candles) {
  if (candles.length < 9) return { tenkan: 0, kijun: 0, cloudPos: 'inside' };
  const high = arr => Math.max(...arr.map(c => c.h)), low = arr => Math.min(...arr.map(c => c.l));
  const tenkan = (high(candles.slice(-9)) + low(candles.slice(-9))) / 2;
  const slice26 = candles.length >= 26 ? candles.slice(-26) : candles;
  const kijun = (high(slice26) + low(slice26)) / 2;
  const slice52 = candles.length >= 52 ? candles.slice(-52) : slice26;
  const spanA = (tenkan + kijun) / 2, spanB = (high(slice52) + low(slice52)) / 2;
  const price = candles[candles.length - 1].c, cloudTop = Math.max(spanA, spanB), cloudBot = Math.min(spanA, spanB);
  return { tenkan, kijun, spanA, spanB, cloudPos: price > cloudTop ? 'above' : price < cloudBot ? 'below' : 'inside' };
}

function calcWilliamsR(candles, period = 14) {
  if (candles.length < period) return -50;
  const slice = candles.slice(-period), hh = Math.max(...slice.map(c => c.h)), ll = Math.min(...slice.map(c => c.l));
  return hh !== ll ? ((hh - candles[candles.length - 1].c) / (hh - ll)) * -100 : -50;
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  const slice = candles.slice(-period - 1);
  let posFlow = 0, negFlow = 0;
  for (let i = 1; i < slice.length; i++) {
    const prevTP = (slice[i-1].h + slice[i-1].l + slice[i-1].c) / 3, currTP = (slice[i].h + slice[i].l + slice[i].c) / 3;
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
    for (let i = n - 1; i < arr.length; i++) { let sum = 0, wSum = 0; for (let j = 0; j < n; j++) { sum += arr[i - j] * (n - j); wSum += (n - j); } result.push(sum / wSum); }
    return result;
  }
  const half = Math.floor(period / 2), sqrtP = Math.floor(Math.sqrt(period));
  const wmaHalf = wma(data, half), wmaFull = wma(data, period), minLen = Math.min(wmaHalf.length, wmaFull.length);
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
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function calcSupertrend(candles, period, multiplier) {
  period = period || 10; multiplier = multiplier || 3.0;
  if (candles.length < period + 2) return { signal: 0, bullish: null };
  const trs = [];
  for (let i = 1; i < candles.length; i++) { const c = candles[i], p = candles[i-1]; trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c))); }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const atrs = [atr];
  for (let i = period; i < trs.length; i++) { atr = (atr * (period - 1) + trs[i]) / period; atrs.push(atr); }
  let finalUpper = 0, finalLower = 0, supertrend = 0, bullish = false, initialized = false;
  for (let i = 0; i < atrs.length; i++) {
    const ci = candles[i + 1], hl2 = (ci.h + ci.l) / 2;
    const rawUpper = hl2 + multiplier * atrs[i], rawLower = hl2 - multiplier * atrs[i], prevClose = candles[i].c;
    if (!initialized) { finalUpper = rawUpper; finalLower = rawLower; supertrend = rawUpper; bullish = false; initialized = true; }
    else {
      const newUpper = (rawUpper < finalUpper || prevClose > finalUpper) ? rawUpper : finalUpper;
      const newLower = (rawLower > finalLower || prevClose < finalLower) ? rawLower : finalLower;
      const prevST = supertrend;
      if (prevST === finalUpper) { bullish = ci.c > newUpper; supertrend = bullish ? newLower : newUpper; }
      else { bullish = ci.c >= newLower; supertrend = bullish ? newLower : newUpper; }
      finalUpper = newUpper; finalLower = newLower;
    }
  }
  return { signal: bullish ? 1 : -1, bullish, supertrend };
}

function calcCCI(candles, period) {
  period = period || 14;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period), tps = slice.map(c => (c.h + c.l + c.c) / 3);
  const mean = tps.reduce((s, v) => s + v, 0) / period, meanDev = tps.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
  // Clamped to +/-500, matching src/core/predictions.js's live calcCCI.
  return meanDev > 0.00001 ? Math.max(-500, Math.min(500, (tps[tps.length - 1] - mean) / (0.015 * meanDev))) : 0;
}

function calcCMF(candles, period) {
  period = period || 20;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  let mfvSum = 0, volSum = 0;
  for (const c of slice) { const range = c.h - c.l, vol = c.v || 1, mfm = range > 0 ? ((c.c - c.l) - (c.h - c.c)) / range : 0; mfvSum += mfm * vol; volSum += vol; }
  return volSum > 0 ? mfvSum / volSum : 0;
}

function calcFisher(candles, period) {
  period = period || 10;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period), hh = Math.max(...slice.map(c => c.h)), ll = Math.min(...slice.map(c => c.l)), range = hh - ll;
  let value = range > 0 ? 2 * ((candles[candles.length - 1].c - ll) / range) - 1 : 0;
  value = Math.max(-0.999, Math.min(0.999, value));
  return 0.5 * Math.log((1 + value) / (1 - value));
}

function calcKeltner(candles, period, mult) {
  period = period || 20; mult = mult || 2.0;
  if (candles.length < period) return { position: 0.5 };
  const closes = candles.map(c => c.c), ema = calcEMA(closes, period), middle = ema[ema.length - 1];
  const atr = calcATR(candles, period), upper = middle + mult * atr, lower = middle - mult * atr, width = Math.max(upper - lower, middle * 0.0001);
  return { position: Math.max(0, Math.min(1, (closes[closes.length - 1] - lower) / width)) };
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return { position: 0.5 };
  const slice = closes.slice(-period), middle = average(slice), std = calcStdDev(closes, period);
  const upper = middle + std * 2, lower = middle - std * 2, width = Math.max(upper - lower, middle * 0.0001);
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
  if (supportGapPct <= bufferPct && supportGapPct <= resistanceGapPct) { zone = 'support'; signal = clamp((bufferPct - supportGapPct) / bufferPct, 0, 1) * 0.85; }
  else if (resistanceGapPct <= bufferPct && resistanceGapPct < supportGapPct) { zone = 'resistance'; signal = -clamp((bufferPct - resistanceGapPct) / bufferPct, 0, 1) * 0.85; }
  return { signal, zone, supportGapPct, resistanceGapPct };
}

function slopeOBV(arr, n = 5) {
  if (arr.length < n + 1) return 0;
  const r = arr.slice(-n), avg = (Math.abs(r[0]) + Math.abs(r[r.length - 1])) / 2 || 1;
  return ((r[r.length - 1] - r[0]) / avg) * 100;
}

function summarizeAgreement(signalMap) {
  const values = Object.values(signalMap).filter(v => Math.abs(v) >= 0.08);
  if (!values.length) return { agreement: 0.5, conflict: 0 };
  const bulls = values.filter(v => v > 0).length, bears = values.filter(v => v < 0).length, active = bulls + bears;
  return { agreement: active ? Math.max(bulls, bears) / active : 0.5, conflict: active ? Math.min(bulls, bears) / active : 0, bulls, bears };
}

function scoreBucket(absScore) {
  if (absScore >= 0.4) return 'strong';
  if (absScore >= 0.25) return 'moderate';
  if (absScore >= 0.1) return 'light';
  return 'neutral';
}

// ── Main signal model (verbatim from backtest-runner.js) ──────────
function buildSignalModel(candles, sym = null) {
  if (!candles || candles.length < 26) return null;
  const closes = candles.map(c => c.c), lastPrice = closes[closes.length - 1];

  const rsi = calcRSI(closes);
  let rsiSig = rsi > 70 ? -0.6 - ((rsi - 70) / 30) * 0.4 : rsi < 30 ? 0.6 + ((30 - rsi) / 30) * 0.4 : (rsi - 50) / 50 * 0.3;

  const ema9 = calcEMA(closes, 9), ema21 = calcEMA(closes, 21);
  const emaCross = (ema9[ema9.length-1] - ema21[ema21.length-1]) / (ema21[ema21.length-1] || 1) * 100;
  const emaSig = clamp(emaCross * 5, -1, 1);

  const vwapRolling = calcVWAP(candles.slice(-80)), vwapRollingLast = vwapRolling[vwapRolling.length - 1];
  const vwapDev = ((lastPrice - vwapRollingLast) / (vwapRollingLast || 1)) * 100;
  let vwapSig = Math.abs(vwapDev) < 0.3 ? 0 : vwapDev > 1.5 ? -0.5 : vwapDev < -1.5 ? 0.5 : vwapDev > 0 ? 0.3 : -0.3;

  const obv = calcOBV(candles), obvSig = clamp(slopeOBV(obv, 8) / 5, -1, 1);

  const recent = candles.slice(-12); let buyV = 0, sellV = 0;
  recent.forEach(c => { const range = c.h - c.l || 0.0001, bodyPos = (c.c - c.l) / range, vol = c.v || 1; buyV += vol * bodyPos; sellV += vol * (1 - bodyPos); });
  const volSig = clamp((buyV / (sellV || 1) - 1) * 0.5, -1, 1);

  const mom = closes.length > 6 ? ((closes[closes.length-1] - closes[closes.length-7]) / (closes[closes.length-7] || 1)) * 100 : 0;
  const momSig = clamp(mom / 2, -1, 1);

  const atr = calcATR(candles), atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
  const bands = calcBollinger(closes);
  let bandSig = bands.position >= 0.88 ? -clamp((bands.position - 0.88) / 0.12, 0, 1) : bands.position <= 0.12 ? clamp((0.12 - bands.position) / 0.12, 0, 1) : clamp(-(bands.position - 0.5) * 0.45, -0.22, 0.22);

  const persistence = calcTrendPersistence(closes, ema21), structure = calcStructureBias(candles, atrPct);
  const macdR = calcMACD(closes);
  const macdHistNorm = lastPrice > 0 ? (macdR.histogram / lastPrice) * 1000 : 0;
  const macdSig = clamp(macdHistNorm * 2.5 + (macdR.macd > macdR.signal ? 0.18 : macdR.macd < macdR.signal ? -0.18 : 0), -1, 1);

  const stochR = calcStochRSI(closes);
  let stochSig = stochR.k > 80 ? -0.6 - ((stochR.k - 80) / 20) * 0.4 : stochR.k < 20 ? 0.6 + ((20 - stochR.k) / 20) * 0.4 : (stochR.k - 50) / 50 * 0.35;
  stochSig = clamp(stochSig + clamp((stochR.k - stochR.d) / 20, -0.18, 0.18), -1, 1);

  const adxR = calcADX(candles);
  const adxSig = clamp(((adxR.pdi - adxR.mdi) / Math.max(adxR.pdi + adxR.mdi, 1)) * clamp(adxR.adx / 50, 0, 1) * 1.2, -1, 1);

  const ichi = calcIchimoku(candles);
  let ichiSig = ichi.cloudPos === 'above' ? 0.5 + (ichi.tenkan > ichi.kijun ? 0.2 : 0) : ichi.cloudPos === 'below' ? -0.5 - (ichi.tenkan < ichi.kijun ? 0.2 : 0) : ichi.tenkan > ichi.kijun ? 0.12 : ichi.tenkan < ichi.kijun ? -0.12 : 0;
  ichiSig = clamp(ichiSig, -1, 1);

  const wR = calcWilliamsR(candles);
  let wRSig = wR > -20 ? -0.6 - ((wR + 20) / 20) * 0.4 : wR < -80 ? 0.6 + ((-80 - wR) / 20) * 0.4 : (wR + 50) / 50 * -0.3;
  wRSig = clamp(wRSig, -1, 1);

  const mfi = calcMFI(candles);
  let mfiSig = mfi > 80 ? -0.6 - ((mfi - 80) / 20) * 0.4 : mfi < 20 ? 0.6 + ((20 - mfi) / 20) * 0.4 : (mfi - 50) / 50 * 0.35;
  mfiSig = clamp(mfiSig, -1, 1);

  const hmaLine = calcHMA(closes, 16), hmaCurr = hmaLine.length ? hmaLine[hmaLine.length - 1] : lastPrice;
  const hmaPrev2 = hmaLine.length > 2 ? hmaLine[hmaLine.length - 3] : hmaCurr;
  let hmaSig = clamp(((hmaCurr - hmaPrev2) / (Math.abs(hmaPrev2) || 1) * 100) * 8, -0.7, 0.7);
  const hmaDevPct = (lastPrice - hmaCurr) / (Math.abs(hmaCurr) || 1) * 100;
  if (Math.abs(hmaDevPct) > 0.4) hmaSig += clamp(-hmaDevPct * 0.28, -0.3, 0.3);
  hmaSig = clamp(hmaSig, -1, 1);

  const vwmaLine = calcVWMA(candles, 20), vwmaCurr = vwmaLine[vwmaLine.length - 1];
  const vwmaPrev = vwmaLine.length > 3 ? vwmaLine[vwmaLine.length - 4] : vwmaCurr;
  let vwmaSig = clamp(((vwmaCurr - vwmaPrev) / (Math.abs(vwmaPrev) || 1) * 100) * 6, -0.6, 0.6);
  vwmaSig = clamp(vwmaSig + clamp(((lastPrice - vwmaCurr) / (Math.abs(vwmaCurr) || 1) * 100) * 0.35, -0.4, 0.4), -1, 1);

  const sma9arr = calcSMA(closes, 9), sma21arr = calcSMA(closes, 21);
  const smaSig = clamp(((sma9arr[sma9arr.length-1] - sma21arr[sma21arr.length-1]) / (Math.abs(sma21arr[sma21arr.length-1]) || 1) * 100) * 5, -1, 1);

  const supertrendSig = calcSupertrend(candles, 10, 3.0).signal;
  const cciVal = calcCCI(candles, 14);
  let cciSig = cciVal > 150 ? -clamp((cciVal - 100) / 150, 0, 1) : cciVal < -150 ? clamp((-100 - cciVal) / 150, 0, 1) : clamp(-cciVal / 200, -0.3, 0.3);
  cciSig = clamp(cciSig, -1, 1);

  let cmfSig = clamp(calcCMF(candles, 20) * 2.5, -1, 1);
  let fisherSig = clamp(calcFisher(candles, 10) / 2.5, -1, 1);
  const kelt = calcKeltner(candles, 20, 2.0);
  let keltSig = kelt.position >= 0.88 ? -clamp((kelt.position - 0.88) / 0.12, 0, 1) : kelt.position <= 0.12 ? clamp((0.12 - kelt.position) / 0.12, 0, 1) : clamp(-(kelt.position - 0.5) * 0.45, -0.22, 0.22);

  // --- Trend Regime Modulation ---
  const isStrongBear = (supertrendSig === -1 || hmaSig < -0.15 || mom < -0.20 || vwmaSig < -0.15) && (adxR.mdi > adxR.pdi || adxR.adx > 18 || mom < -0.30);
  const isStrongBull = (supertrendSig === 1 || hmaSig > 0.15 || mom > 0.20 || vwmaSig > 0.15) && (adxR.pdi > adxR.mdi || adxR.adx > 18 || mom > 0.30);

  if (isStrongBear) {
    if (rsiSig > 0) rsiSig = 0;
    if (stochSig > 0) stochSig = 0;
    if (wRSig > 0) wRSig = 0;
    if (bandSig > 0) bandSig = 0;
    if (mfiSig > 0) mfiSig = 0;
    if (vwapSig > 0) vwapSig = 0;
    if (cciSig > 0) cciSig = 0;
    if (keltSig > 0) keltSig = 0;
    if (fisherSig > 0) fisherSig = 0;
  } else if (isStrongBull) {
    if (rsiSig < 0) rsiSig = 0;
    if (stochSig < 0) stochSig = 0;
    if (wRSig < 0) wRSig = 0;
    if (bandSig < 0) bandSig = 0;
    if (mfiSig < 0) mfiSig = 0;
    if (vwapSig < 0) vwapSig = 0;
    if (cciSig < 0) cciSig = 0;
    if (keltSig < 0) keltSig = 0;
    if (fisherSig < 0) fisherSig = 0;
  }

  const sv = {
    rsi: rsiSig, ema: emaSig, vwap: vwapSig, obv: obvSig, volume: volSig,
    momentum: momSig, bands: bandSig, persistence: persistence.signal, structure: structure.signal,
    macd: macdSig, stochrsi: stochSig, adx: adxSig, ichimoku: ichiSig, williamsR: wRSig, mfi: mfiSig,
    hma: hmaSig, vwma: vwmaSig, sma: smaSig, supertrend: supertrendSig, cci: cciSig, cmf: cmfSig,
    fisher: fisherSig, keltner: keltSig,
  };

  const coinBias = (sym && PER_COIN_INDICATOR_BIAS[sym]) ? PER_COIN_INDICATOR_BIAS[sym] : {};
  const keys = Object.keys(sv);
  const effW = k => (COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0) * (coinBias[k] ?? 1.0);
  const totalWeight = keys.reduce((s, k) => s + effW(k), 0) || 1;
  const rawComposite = keys.reduce((s, k) => s + sv[k] * effW(k), 0) / totalWeight;
  const adxGate = adxR.adx < 20 ? Math.max(0.25, adxR.adx / 20) : 1.0;
  const score = clamp(rawComposite * SCORE_AMPLIFIER * adxGate, -1, 1);
  const agr = summarizeAgreement(sv);

  return {
    score, absScore: Math.abs(score), coreScore: score,
    agreement: agr.agreement, conflict: agr.conflict,
    structureBias: structure.signal, structureZone: structure.zone, persistenceScore: persistence.signal,
    emaCross, mom, rsi, atrPct, signalVector: sv,
  };
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const p = 1 - pdf * poly;
  return z >= 0 ? p : 1 - p;
}

// ── HTTP helpers ──────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WECRYPTO-Advanced/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { resolve(httpGet(res.headers.location)); return; }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

const KRAKEN_PAIR = { BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLUSD', XRP: 'XXRPZUSD', DOGE: 'XDGUSD' };
const CB_PRODUCT  = { BTC: 'BTC-USD',  ETH: 'ETH-USD',  SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD' };

async function fetchBinanceCandles(symbol, limit = 1000, interval = '5m') {
  const PAGE = 1000;
  const hosts = [
    'https://data-api.binance.vision/api/v3',
    'https://api.binance.us/api/v3',
    'https://api.binance.com/api/v3',
  ];

  for (const host of hosts) {
    try {
      if (limit <= PAGE) {
        const url = `${host}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const { status, body } = await httpGet(url);
        if (status === 200) {
          const rows = JSON.parse(body);
          if (Array.isArray(rows) && rows.length > 0) {
            return rows.map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
          }
        }
      } else {
        const pages = []; let endTime = null, remaining = limit;
        while (remaining > 0) {
          const fetchCount = Math.min(PAGE, remaining);
          const url = endTime ? `${host}/klines?symbol=${symbol}&interval=${interval}&limit=${fetchCount}&endTime=${endTime}` : `${host}/klines?symbol=${symbol}&interval=${interval}&limit=${fetchCount}`;
          const { status, body } = await httpGet(url);
          if (status !== 200) break;
          const rows = JSON.parse(body);
          if (!Array.isArray(rows) || rows.length === 0) break;
          pages.unshift(rows); endTime = Number(rows[0][0]) - 1; remaining -= rows.length;
          if (rows.length < fetchCount) break;
          await new Promise(r => setTimeout(r, 100));
        }
        if (pages.length > 0) {
          return pages.flat().map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
        }
      }
    } catch (_) {}
  }
  throw new Error(`Binance endpoints unreachable for ${symbol}`);
}

async function fetchMexcCandles(symbol, limit = 1000, interval = '5m') {
  const url = `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(1000, limit)}`;
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`MEXC HTTP ${status}`);
  const rows = JSON.parse(body);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`No MEXC data`);
  return rows.map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
}

async function fetchKrakenCandles(sym, limit = 1000) {
  const pair = KRAKEN_PAIR[sym]; if (!pair) throw new Error(`No Kraken pair for ${sym}`);
  const since = Math.floor((Date.now() - (limit * 5 * 60 * 1000)) / 1000);
  const { status, body } = await httpGet(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=5&since=${since}`);
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
  try { return await fetchBinanceCandles(coin.binSym, limit); } catch(e) { errors.push(`Binance: ${e.message}`); }
  try { return await fetchMexcCandles(coin.mexcSym || coin.binSym, limit); } catch(e) { errors.push(`MEXC: ${e.message}`); }
  try { return await fetchKrakenCandles(coin.sym, limit); }      catch(e) { errors.push(`Kraken: ${e.message}`); }
  try { return await fetchCoinbaseCandles(coin.sym, Math.min(300, limit)); } catch(e) { errors.push(`Coinbase: ${e.message}`); }
  throw new Error(errors.join(' | '));
}

// Fetch 1m candles for h1/h5 analysis
async function fetch1mCandles(coin) {
  const hosts = ['https://data-api.binance.vision/api/v3', 'https://api.binance.us/api/v3', 'https://api.binance.com/api/v3'];
  for (const host of hosts) {
    const url = `${host}/klines?symbol=${coin.binSym}&interval=1m&limit=1000`;
    try {
      const { status, body } = await httpGet(url);
      if (status === 200) {
        const rows = JSON.parse(body);
        if (Array.isArray(rows) && rows.length > 0) {
          return rows.map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
        }
      }
    } catch(_) {}
  }
  return null;
}

// ── Core backtest runner (per-coin, per-horizon) ──────────────────
// candles5m: primary series; candles1m optional for h1/h5 (fixes h1≡h5 bug when only 5m bars used).
function runBacktest(sym, candles5m, candles1m = null) {
  const results = {};

  for (const horizonMin of SHORT_HORIZON_MINUTES) {
    // Use 1m series for h1/h5 when available so horizons are not byte-identical.
    const use1m = horizonMin <= 5 && Array.isArray(candles1m) && candles1m.length >= 120;
    const candles = use1m ? candles1m : candles5m;
    const BARMIN = use1m ? 1 : 5;
    const LIVE_WINDOW = use1m ? 180 : 300;
    const startIdx = Math.max(52, BACKTEST_MIN_TRAIN_OBS);
    const horizonBars = Math.max(1, Math.round(horizonMin / BARMIN));
    const filter = BACKTEST_FILTER_OVERRIDES[sym]?.[`h${horizonMin}`] || { entryThreshold: 0.30, minAgreement: 0.58 };
    const observations = [], indAccum = {};

    for (let idx = startIdx; idx < candles.length - horizonBars; idx++) {
      const windowCandles = candles.slice(Math.max(0, idx - LIVE_WINDOW + 1), idx + 1);
      const model = buildSignalModel(windowCandles, sym);
      if (!model) continue;

      const entry = candles[idx].c, exit = candles[idx + horizonBars].c;
      const returnPct = entry > 0 ? ((exit - entry) / entry) * 100 : 0;

      const persistenceVeto = Math.sign(model.persistenceScore || 0) !== 0
        && Math.sign(model.persistenceScore || 0) !== Math.sign(model.coreScore || 0)
        && Math.abs(model.persistenceScore || 0) >= 0.35 && Math.abs(model.coreScore || 0) < (filter.entryThreshold + 0.04);

      const isActive = model.absScore >= filter.entryThreshold && model.agreement >= filter.minAgreement
        && !(filter.maxThreshold && model.absScore > filter.maxThreshold)
        && !(model.conflict >= 0.38 && model.agreement < filter.minAgreement + 0.08)
        && !(Math.abs(model.coreScore || 0) < filter.entryThreshold * 0.92 && model.conflict >= 0.30)
        && !(model.structureZone === 'resistance' && model.coreScore > 0 && model.agreement < 0.65 && Math.abs(model.structureBias || 0) >= 0.18)
        && !(model.structureZone === 'support'    && model.coreScore < 0 && model.agreement < 0.65 && Math.abs(model.structureBias || 0) >= 0.18)
        && !persistenceVeto;

      const direction = isActive ? (model.score > 0 ? 1 : -1) : 0;
      const signedReturn = direction === 0 ? 0 : returnPct * direction;

      observations.push({
        t: candles[idx].t, direction, score: model.score, absScore: model.absScore,
        agreement: model.agreement, conflict: model.conflict, signedReturn, returnPct,
        bucket: direction === 0 ? 'neutral' : scoreBucket(model.absScore),
        correct: direction !== 0 ? signedReturn > 0 : null,
        atrPct: model.atrPct, rsi: model.rsi, emaCross: model.emaCross, mom: model.mom,
        signalVector: direction !== 0 ? model.signalVector : null,
      });

      // Per-indicator accuracy tracking
      if (direction !== 0 && model.signalVector) {
        const actualDir = returnPct > 0 ? 1 : -1;
        Object.entries(model.signalVector).forEach(([k, v]) => {
          if (!indAccum[k]) indAccum[k] = { agree: 0, total: 0, bullCount: 0, bearCount: 0 };
          if (Math.abs(v) >= 0.08) {
            indAccum[k].total++;
            if (Math.sign(v) === actualDir) indAccum[k].agree++;
            if (v > 0) indAccum[k].bullCount++; else indAccum[k].bearCount++;
          }
        });
      }
    }

    const active = observations.filter(o => o.direction !== 0);
    const wins   = active.filter(o => o.signedReturn > 0).length;
    const losses = active.filter(o => o.signedReturn < 0).length;
    const grossW = active.filter(o => o.signedReturn > 0).reduce((s, o) => s + o.signedReturn, 0);
    const grossL = Math.abs(active.filter(o => o.signedReturn < 0).reduce((s, o) => s + o.signedReturn, 0));
    const signedReturns = active.map(o => o.signedReturn);

    // Equity curve + max drawdown
    let equity = 100, peak = 100, maxDD = 0;
    active.forEach(o => { equity *= (1 + o.signedReturn / 100); peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak * 100); });

    // Risk metrics
    const annFactor = 252 * (390 / horizonMin);
    const sharpe    = signedReturns.length > 1 ? (average(signedReturns) / (stdDev(signedReturns) || 0.0001)) * Math.sqrt(annFactor) : 0;
    const sortino   = signedReturns.length > 1 ? (average(signedReturns) / (downStdDev(signedReturns) || 0.0001)) * Math.sqrt(annFactor) : 0;
    const annReturn = equity > 0 ? (Math.pow(equity / 100, 252 / Math.max(1, DAYS_BACK)) - 1) * 100 : 0;
    const calmar    = maxDD > 0 ? annReturn / maxDD : 0;

    // Confidence calibration (score buckets)
    const buckets = ['strong', 'moderate', 'light'].reduce((acc, b) => {
      const bt = active.filter(o => o.bucket === b);
      acc[b] = { count: bt.length, winRate: bt.length ? bt.filter(o => o.signedReturn > 0).length / bt.length * 100 : null };
      return acc;
    }, {});

    // Session breakdown
    const sessions = {};
    active.forEach(o => {
      const h = new Date(o.t).getUTCHours();
      const sess = h >= 13 && h < 17 ? 'NY Open' : h >= 17 && h < 21 ? 'NY Close' : h >= 7 && h < 12 ? 'London' : h >= 0 && h < 6 ? 'Asia' : 'Off-Hours';
      if (!sessions[sess]) sessions[sess] = { wins: 0, total: 0 };
      sessions[sess].total++;
      if (o.signedReturn > 0) sessions[sess].wins++;
    });

    // Indicator accuracy
    const indicatorAccuracy = Object.entries(indAccum)
      .map(([k, v]) => ({
        indicator: k, accuracy: v.total ? v.agree / v.total * 100 : null, samples: v.total,
        bias: v.total ? (v.bullCount > v.bearCount ? 'bull' : 'bear') : 'neutral',
        currentBias: PER_COIN_INDICATOR_BIAS[sym]?.[k] ?? 1.0,
        baseWeight: COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0,
      }))
      .filter(x => x.samples >= 5)
      .sort((a, b) => (b.accuracy || 0) - (a.accuracy || 0));

    // Regime classification per observation (for section 5)
    const regimeStats = { bull: { w: 0, t: 0 }, bear: { w: 0, t: 0 }, neutral: { w: 0, t: 0 } };
    active.forEach(o => {
      const regime = o.emaCross > 0.15 && o.mom > 0.3 ? 'bull' : o.emaCross < -0.15 && o.mom < -0.3 ? 'bear' : 'neutral';
      regimeStats[regime].t++;
      if (o.signedReturn > 0) regimeStats[regime].w++;
    });

    results[`h${horizonMin}`] = {
      horizonMin, filter, observations: observations.length, activeSignals: active.length,
      coverage: observations.length ? active.length / observations.length * 100 : 0,
      winRate:  active.length ? wins / active.length * 100 : 0,
      wins, losses, avgWin: active.length ? grossW / Math.max(wins, 1) : 0,
      avgLoss: active.length ? grossL / Math.max(losses, 1) : 0,
      avgSignedReturn: active.length ? average(signedReturns) : 0,
      profitFactor: grossL > 0 ? grossW / grossL : grossW > 0 ? grossW : 0,
      equity: { final: equity, returnPct: equity - 100, maxDrawdownPct: maxDD },
      sharpe, sortino, calmar,
      buckets, sessions: Object.entries(sessions).map(([s, v]) => ({ session: s, total: v.total, winRate: v.total ? v.wins / v.total * 100 : 0 })),
      indicatorAccuracy, regimeStats,
      rawObs: observations,  // kept for edge decay analysis
    };
  }

  return results;
}

// ── Section printers ──────────────────────────────────────────────
function bar(pct, width = 24) {
  const f = Math.round(clamp(pct / 100, 0, 1) * width);
  return '█'.repeat(f) + '░'.repeat(width - f);
}

function printSection1(allResults, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L('\n╔══════════════════════════════════════════════════════════════════════╗');
  L('║  SECTION 1 — SIGNAL OVERVIEW                                        ║');
  L('╚══════════════════════════════════════════════════════════════════════╝');
  const horizonTotals = {};
  for (const hm of SHORT_HORIZON_MINUTES) {
    const hk = `h${hm}`;
    let totalSig = 0, totalWins = 0, totalObs = 0;
    for (const [, res] of Object.entries(allResults)) {
      const r = res[hk]; if (!r) continue;
      totalSig += r.activeSignals; totalWins += r.wins; totalObs += r.observations;
    }
    horizonTotals[hk] = { totalSig, totalWins, totalObs };
    const wr = totalSig > 0 ? (totalWins / totalSig * 100).toFixed(1) : '—';
    const cov = totalObs > 0 ? (totalSig / totalObs * 100).toFixed(1) : '—';
    L(`  h${hm}m  │ Portfolio WR: ${wr}%  │ Coverage: ${cov}%  │ Total signals: ${totalSig}`);
  }
}

function printSection2(sym, results, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L(`\n── SECTION 2 · ${sym} DEEP DIVE ─────────────────────────────────────────`);
  const vals = SHORT_HORIZON_MINUTES.map(h => results[`h${h}`]?.winRate ?? 0);
  const best = SHORT_HORIZON_MINUTES.reduce((b, h) => (results[`h${h}`]?.winRate ?? 0) > (results[`h${b}`]?.winRate ?? 0) ? h : b, 1);
  L(`  Horizon │  WR%   │  PF    │ MaxDD% │ Signals │ Coverage`);
  L(`  ────────┼────────┼────────┼────────┼─────────┼─────────`);
  for (const hm of SHORT_HORIZON_MINUTES) {
    const r = results[`h${hm}`];
    if (!r) { L(`  h${hm}m     │  —     │  —     │  —     │  —      │  —`); continue; }
    const flag = hm === best ? ' ★' : '';
    L(`  h${hm}m${flag.padEnd(5)} │ ${r.winRate.toFixed(1).padStart(5)}% │ ${r.profitFactor.toFixed(2).padStart(6)} │ ${r.equity.maxDrawdownPct.toFixed(1).padStart(5)}% │ ${String(r.activeSignals).padStart(7)} │ ${r.coverage.toFixed(1).padStart(7)}%`);
  }
  L(`\n  Best horizon: h${best}m  (WR: ${results[`h${best}`]?.winRate.toFixed(1) ?? '—'}%)`);
}

function printSection3(sym, results, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L(`\n── SECTION 3 · INDICATOR ACCURACY — ${sym} ──────────────────────────────`);
  for (const hm of SHORT_HORIZON_MINUTES) {
    const r = results[`h${hm}`];
    if (!r || !r.indicatorAccuracy.length) continue;
    L(`\n  h${hm}m  [${r.activeSignals} active signals]`);
    L(`  Indicator     │ Acc%  │  n   │ Bias │ CurBias │ Status`);
    L(`  ──────────────┼───────┼──────┼──────┼─────────┼──────────`);
    for (const ind of r.indicatorAccuracy) {
      const acc = ind.accuracy?.toFixed(1).padStart(5) ?? '  —  ';
      const status = ind.accuracy == null ? '       ' : ind.accuracy >= 65 ? '⭐ STAR ' : ind.accuracy < 40 ? '🔴 BREAK' : '       ';
      const curBias = ind.currentBias.toFixed(2).padStart(7);
      L(`  ${ind.indicator.padEnd(14)}│ ${acc}% │ ${String(ind.samples).padStart(4)} │ ${ind.bias.padEnd(4)} │ ${curBias} │ ${status}`);
    }
  }
}

function printSection4(sym, results, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L(`\n── SECTION 4 · RISK METRICS — ${sym} ────────────────────────────────────`);
  L(`  Horizon │ Sharpe │ Sortino│ Calmar │ AvgWin% │ AvgLoss% │ W:L`);
  L(`  ────────┼────────┼────────┼────────┼─────────┼──────────┼──────`);
  for (const hm of SHORT_HORIZON_MINUTES) {
    const r = results[`h${hm}`];
    if (!r || r.activeSignals < 5) { L(`  h${hm}m     │  —     │  —     │  —     │  —      │  —       │  —`); continue; }
    const wl = r.avgLoss > 0 ? (r.avgWin / r.avgLoss).toFixed(2) : '∞';
    L(`  h${hm}m      │ ${r.sharpe.toFixed(2).padStart(6)} │ ${r.sortino.toFixed(2).padStart(6)} │ ${r.calmar.toFixed(2).padStart(6)} │ ${r.avgWin.toFixed(3).padStart(7)}% │ ${r.avgLoss.toFixed(3).padStart(8)}% │ ${wl}`);
  }
}

function printSection5(sym, results, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L(`\n── SECTION 5 · REGIME ANALYSIS — ${sym} ─────────────────────────────────`);
  L(`  Regime  │ h15 WR% │ Signals │ Recommendation`);
  L(`  ────────┼─────────┼─────────┼────────────────`);
  const r = results['h15'];
  if (!r) { L(`  (no h15 data)`); return; }
  const regimes = ['bull', 'bear', 'neutral'];
  for (const regime of regimes) {
    const rs = r.regimeStats[regime];
    const wr = rs.t > 0 ? (rs.w / rs.t * 100).toFixed(1) : '—';
    const rec = !rs.t ? 'n/a' : rs.t > 5 && parseFloat(wr) >= 54 ? 'TRADE ✅' : rs.t > 5 && parseFloat(wr) < 48 ? 'AVOID ❌' : 'REDUCE 🟡';
    L(`  ${regime.padEnd(8)}│ ${wr.padStart(7)}% │ ${String(rs.t).padStart(7)} │ ${rec}`);
  }
}

function printSection6(sym, results, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L(`\n── SECTION 6 · SESSION TIMING — ${sym} ──────────────────────────────────`);
  L(`  Session     │ h15 WR% │ h10 WR% │ Count │ Best?`);
  L(`  ────────────┼─────────┼─────────┼───────┼──────`);
  const r15 = results['h15'], r10 = results['h10'];
  const sessions = ['Asia', 'London', 'NY Open', 'NY Close', 'Off-Hours'];
  let bestSess = '', bestWR = 0;
  for (const sess of sessions) {
    const s15 = r15?.sessions?.find(s => s.session === sess);
    const s10 = r10?.sessions?.find(s => s.session === sess);
    const wr15 = s15 ? s15.winRate.toFixed(1) : '—';
    const wr10 = s10 ? s10.winRate.toFixed(1) : '—';
    if (s15 && s15.total > 3 && s15.winRate > bestWR) { bestWR = s15.winRate; bestSess = sess; }
    L(`  ${sess.padEnd(12)}│ ${wr15.padStart(7)}% │ ${wr10.padStart(7)}% │ ${String(s15?.total ?? 0).padStart(5)} │${sess === bestSess ? ' ⭐' : ''}`);
  }
  L(`\n  Best session for ${sym}: ${bestSess || 'n/a'} (h15 WR: ${bestWR.toFixed(1)}%)`);
}

function printSection7(sym, results, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L(`\n── SECTION 7 · CONFIDENCE CALIBRATION — ${sym} ──────────────────────────`);
  L(`  Expected: strong WR > moderate WR > light WR`);
  for (const hm of SHORT_HORIZON_MINUTES) {
    const r = results[`h${hm}`];
    if (!r || r.activeSignals < 5) continue;
    const { strong, moderate, light } = r.buckets;
    const fmt = b => b.count > 0 && b.winRate != null ? `${b.winRate.toFixed(1)}% (n=${b.count})` : '—';
    const isCalibrated = (strong.winRate ?? 0) >= (moderate.winRate ?? 0) && (moderate.winRate ?? 0) >= (light.winRate ?? 0);
    const flag = isCalibrated ? '✅ calibrated' : '⚠️  MISCALIBRATED';
    L(`  h${hm}m  strong: ${fmt(strong)}  moderate: ${fmt(moderate)}  light: ${fmt(light)}  → ${flag}`);
  }
}

function printSection8(sym, results, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L(`\n── SECTION 8 · WEIGHT RECOMMENDATIONS — ${sym} ──────────────────────────`);
  const r = results['h15'];
  if (!r || !r.indicatorAccuracy.length) { L(`  (insufficient data)`); return; }
  const coinBias = PER_COIN_INDICATOR_BIAS[sym] || {};
  const recs = [];
  for (const ind of r.indicatorAccuracy) {
    if (ind.accuracy == null) continue;
    const current = coinBias[ind.indicator] ?? 1.0;
    // Simple heuristic: recommend proportional to (accuracy - 50) / 50 * 4, clamped [0, 6]
    const accNorm = (ind.accuracy - 50) / 50;
    const recommended = clamp(1.0 + accNorm * 3, 0.05, 6.0);
    const delta = recommended - current;
    recs.push({ indicator: ind.indicator, accuracy: ind.accuracy, current: +current.toFixed(2), recommended: +recommended.toFixed(2), delta: +delta.toFixed(2) });
  }
  recs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  L(`  Indicator     │ Acc%  │ CurrentBias │ Recommended │ Delta`);
  L(`  ──────────────┼───────┼─────────────┼─────────────┼──────`);
  for (const r2 of recs.slice(0, 12)) {
    const deltaFlag = Math.abs(r2.delta) > 1.0 ? (r2.delta > 0 ? ' ↑↑' : ' ↓↓') : '';
    L(`  ${r2.indicator.padEnd(14)}│ ${r2.accuracy.toFixed(1).padStart(5)}% │ ${String(r2.current).padStart(11)} │ ${String(r2.recommended).padStart(11)} │ ${r2.delta > 0 ? '+' : ''}${r2.delta.toFixed(2)}${deltaFlag}`);
  }

  // Output JS object literal
  L('\n  Recommended PER_COIN_INDICATOR_BIAS (h15 accuracy-based):');
  const biasObj = {};
  for (const rec of recs) biasObj[rec.indicator] = rec.recommended;
  const jsLine = JSON.stringify(biasObj).replace(/"/g, '').replace(/,/g, ', ');
  L(`  ${sym}: { ${jsLine} },`);
}

function printSection9(sym, results, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L(`\n── SECTION 9 · EDGE DECAY — ${sym} ───────────────────────────────────────`);
  const r = results['h15'];
  if (!r || !r.rawObs || r.rawObs.length < 20) { L(`  (insufficient data)`); return; }
  const active = r.rawObs.filter(o => o.direction !== 0);
  if (active.length < 8) { L(`  (too few active signals for decay analysis)`); return; }

  // Divide into up to 4 time windows
  const windows = [7, 14, 21, 30].filter(d => d <= DAYS_BACK);
  const now = active[active.length - 1]?.t ?? Date.now();
  const wrs = [];
  for (const d of windows) {
    const cutoff = now - d * 24 * 3600 * 1000;
    const subset = active.filter(o => o.t >= cutoff);
    const wr = subset.length > 3 ? subset.filter(o => o.signedReturn > 0).length / subset.length * 100 : null;
    wrs.push({ days: d, wr, n: subset.length });
  }

  // ASCII WR chart (reversed so oldest is left)
  L(`  Window  │ WR%    │ n     │ Chart`);
  L(`  ────────┼────────┼───────┼─────────────────────────`);
  const reversed = [...wrs].reverse();
  for (const w of reversed) {
    if (w.wr == null) { L(`  ${String(w.days).padEnd(7)}d│  —     │ ${String(w.n).padStart(5)} │`); continue; }
    const chartBar = bar(w.wr, 20);
    const flag = w.wr >= 55 ? '✅' : w.wr >= 50 ? '🟡' : '❌';
    L(`  ${String(w.days).padEnd(7)}d│ ${w.wr.toFixed(1).padStart(5)}% ${flag}│ ${String(w.n).padStart(5)} │ ${chartBar}`);
  }

  // Trend direction
  const valid = wrs.filter(w => w.wr != null);
  if (valid.length >= 2) {
    const first = valid[0].wr, last = valid[valid.length - 1].wr;
    const trend = last - first;
    const label = trend > 2 ? '📈 IMPROVING' : trend < -2 ? '📉 DEGRADING' : '➡ STABLE';
    L(`  Edge trend (${valid[0].days}d→${valid[valid.length-1].days}d): ${label}  (Δ${trend > 0 ? '+' : ''}${trend.toFixed(1)}pp)`);
    if (last < 50) L(`  ⚠️  ALERT: Recent WR < 50% — model may be losing edge on ${sym}`);
  }
}

function printSection10(allResults, logLines) {
  const L = s => { console.log(s); logLines.push(s); };
  L('\n╔══════════════════════════════════════════════════════════════════════╗');
  L('║  SECTION 10 — SUMMARY & ACTION ITEMS                               ║');
  L('╚══════════════════════════════════════════════════════════════════════╝');

  const coins = Object.keys(allResults);
  // Rank coins by h15 WR
  const coinWRs = coins.map(c => ({ sym: c, wr: allResults[c]['h15']?.winRate ?? 0, n: allResults[c]['h15']?.activeSignals ?? 0 }))
    .sort((a, b) => b.wr - a.wr);

  L('\n  Coin performance at h15:');
  for (const cw of coinWRs) {
    const flag = cw.wr >= 55 ? '✅ TRADE MORE' : cw.wr < 50 ? '❌ REDUCE/AVOID' : '🟡 NEUTRAL';
    L(`  ${cw.sym.padEnd(5)} WR: ${cw.wr.toFixed(1).padStart(5)}%  (n=${cw.n})  → ${flag}`);
  }

  // Quick wins: find highest-impact actions
  L('\n  Top 3 Quick Wins:');
  let qw = 1;
  for (const cw of coinWRs) {
    const r = allResults[cw.sym]['h15'];
    if (!r) continue;
    const brokens = r.indicatorAccuracy.filter(x => x.accuracy != null && x.accuracy < 40);
    if (brokens.length > 0) {
      L(`  ${qw++}. ${cw.sym}: Kill broken indicators (${brokens.slice(0,3).map(x => `${x.indicator}=${x.accuracy.toFixed(0)}%`).join(', ')}) — set bias to 0.05`);
    }
    if (qw > 3) break;
  }
  if (qw <= 3) L(`  ${qw}. Review calibrated thresholds via walk-forward-backtest.js for all coins`);
  if (qw <= 3) L(`  ${qw + 1}. Focus trading on sessions with >55% WR per coin (see Section 6)`);

  L('\n  Threshold tightening check:');
  for (const c of coins) {
    const r = allResults[c]['h15'];
    if (!r) continue;
    if (r.coverage > 30 && r.winRate < 52) L(`  ⚠️  ${c} h15: Coverage ${r.coverage.toFixed(0)}% too high, WR ${r.winRate.toFixed(1)}% — tighten thresholds`);
    if (r.coverage < 8 && r.winRate < 54) L(`  ⚠️  ${c} h15: Coverage ${r.coverage.toFixed(0)}% too low — loosen thresholds or check data`);
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const coins = FILTER_COIN ? PREDICTION_COINS.filter(c => c.sym === FILTER_COIN) : PREDICTION_COINS;
  if (FILTER_COIN && coins.length === 0) { console.error(`Unknown coin: ${FILTER_COIN}`); process.exit(1); }

  const dateStr = new Date().toISOString().slice(0, 10);
  const runTs   = new Date().toISOString();
  const logLines = [];

  const hdr = s => { console.log(s); logLines.push(s); };
  hdr('');
  hdr('╔══════════════════════════════════════════════════════════════════════╗');
  hdr('║  WECRYPTO — Advanced Comprehensive Backtest Analysis Suite v2.0     ║');
  hdr(`║  ${DAYS_BACK}-day window · ${CANDLES_WANT} × 5m candles per coin · ${runTs.slice(0,10)}           ║`);
  hdr('╚══════════════════════════════════════════════════════════════════════╝');

  const allResults = {};

  for (const coin of coins) {
    process.stdout.write(`\nFetching ${coin.sym} 5m candles... `);
    let candles;
    try {
      candles = await fetchCandles(coin, CANDLES_WANT);
      console.log(`${candles.length} candles ✓`);
    } catch(e) {
      console.log(`FAILED: ${e.message}`); continue;
    }
    if (candles.length < 60) { console.log(`  Skipping — not enough data`); continue; }

    // Optionally fetch 1m candles for h1/h5 higher-resolution analysis
    process.stdout.write(`  Fetching 1m candles for ${coin.sym}... `);
    const candles1m = await fetch1mCandles(coin);
    console.log(candles1m ? `${candles1m.length} candles ✓` : 'skipped');

    process.stdout.write(`  Running advanced backtest for ${coin.sym}... `);
    const results = runBacktest(coin.sym, candles, candles1m);
    console.log('done');

    allResults[coin.sym] = results;
    await new Promise(r => setTimeout(r, 300));
  }

  if (Object.keys(allResults).length === 0) { console.error('No results generated'); process.exit(1); }

  // Print all sections
  printSection1(allResults, logLines);

  for (const [sym, results] of Object.entries(allResults)) {
    printSection2(sym, results, logLines);
    printSection3(sym, results, logLines);
    printSection4(sym, results, logLines);
    printSection5(sym, results, logLines);
    printSection6(sym, results, logLines);
    printSection7(sym, results, logLines);
    printSection8(sym, results, logLines);
    printSection9(sym, results, logLines);
  }

  printSection10(allResults, logLines);

  // Save JSON per coin
  for (const [sym, results] of Object.entries(allResults)) {
    const jsonPath = path.join(LOG_DIR, `advanced-${sym}-${dateStr}.json`);
    // Strip rawObs to avoid huge files
    const slim = {};
    for (const [hk, r] of Object.entries(results)) { slim[hk] = { ...r, rawObs: undefined }; delete slim[hk].rawObs; }
    try { fs.writeFileSync(jsonPath, JSON.stringify({ coin: sym, generatedAt: runTs, daysBack: DAYS_BACK, results: slim }, null, 2)); console.log(`\nJSON saved: ${jsonPath}`); }
    catch(e) { console.warn(`Could not save JSON for ${sym}: ${e.message}`); }
  }

  // Save log
  const logPath = path.join(LOG_DIR, `advanced-${dateStr}.log`);
  try { fs.writeFileSync(logPath, logLines.join('\n')); console.log(`Log saved: ${logPath}`); }
  catch(e) { console.warn(`Could not save log: ${e.message}`); }

  // Update session checkpoint
  const cpSection = `\n## Advanced Backtest — ${runTs}\n- Days: ${DAYS_BACK}  Candles: ${CANDLES_WANT}\n- Coins analyzed: ${Object.keys(allResults).join(', ')}\n- Log: ${logPath}\n`;
  try { fs.appendFileSync(CHECKPOINT, cpSection); console.log(`Checkpoint updated: ${CHECKPOINT}`); }
  catch(e) { console.warn(`Could not update checkpoint: ${e.message}`); }

  console.log('\nAdvanced backtest complete.\n');
}

main().catch(e => { console.error('\nFatal error:', e); process.exit(1); });
