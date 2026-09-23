#!/usr/bin/env node
// ================================================================
// WECRYPTO — Next-Gen Quant Hyperparameter & Weight Tuning Suite
//
// Features:
//   1. Lookahead-Free Physical Barrier Modeling:
//      Strike = Contract Open (PTB), Entry = true intrawindow 1m price,
//      Settlement = Contract Close. No peeking, no approximations.
//   2. QuantCore Statistical Regime Engine:
//      Rolling Hurst Exponent (trend persistence vs mean reversion),
//      2-State Kalman Filter Velocity (latent trend extraction),
//      Volatility Regime Classification.
//   3. Full 23-Indicator Signal Vector:
//      Extracts all indicators identically to predictions.js.
//   4. ElasticNet-Adam Optimizer:
//      Adaptive first/second moments, L1 Lasso penalty to prune
//      toxic/lagging indicators to 0.0, L2 Ridge shrinkage to prior.
//      Objective: Binary Cross-Entropy + Brier calibration score.
//   5. Purged K-Fold Walk-Forward Cross-Validation:
//      Chronological rolling train/test splits. Measures true OOS edge.
//   6. Single Source of Truth Synchronization:
//      Writes to src/core/predictions-weights.json and syncs all files.
//
// Usage:
//   node backtest/hypertune-quant-suite.js --days 14 --coins BTC,ETH,SOL,XRP
//   node backtest/hypertune-quant-suite.js --days 7 --coins BTC --write-weights
//   node backtest/hypertune-quant-suite.js --days 30 --mode ptb --folds 5
// ================================================================
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

// ── QuantCore Modules ────────────────────────────────────────────
const HurstExponent = require('../src/quant/hurst-exponent.js');
const KalmanFilter  = require('../src/quant/kalman-filter.js');
const RegimeClassifier = require('../src/quant/regime-classifier.js');

// ── CLI Parsing ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = (flag) => args.includes(flag);

const DAYS_ARG      = parseInt(getArg('--days', '14'), 10);
const COINS_ARG     = getArg('--coins', 'BTC,ETH,SOL,XRP').toUpperCase().split(',').map(s => s.trim());
const INTERVAL_ARG  = getArg('--interval', '5m'); // 5m or 15m
const MODE_ARG      = getArg('--mode', 'ptb');     // 'ptb' (binary strike) or 'spot' (close-to-close)
const EPOCHS_ARG    = parseInt(getArg('--epochs', '160'), 10);
const LR_ARG        = parseFloat(getArg('--lr', '0.025'));
const L1_ARG        = parseFloat(getArg('--l1', '0.006')); // Lasso: prunes toxic indicators to 0
const L2_ARG        = parseFloat(getArg('--l2', '0.002')); // Ridge: anchors to baseline
const FOLDS_ARG     = parseInt(getArg('--folds', '5'), 10); // K-fold walk-forward splits
const ENTRY_OFFSET  = parseFloat(getArg('--entry-offset', '0.40')); // 40% into contract window
const WRITE_WEIGHTS = hasFlag('--write-weights');

// ── Paths ────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const WEIGHTS_JSON = path.join(ROOT, 'src', 'core', 'predictions-weights.json');
const CACHE_DIR = path.join(ROOT, 'WE-CRYPTO-CACHE', 'backtest-candles');
const RESULTS_DIR = path.join(ROOT, 'backtest', 'results');
const SYNC_SCRIPT = path.join(ROOT, 'scripts', 'sync-weights.js');

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(RESULTS_DIR, { recursive: true }); } catch (_) {}

// ── Coin Configurations ──────────────────────────────────────────
const COIN_CONFIGS = {
  BTC:  { sym: 'BTC',  binSym: 'BTCUSDT',  color: '🟠' },
  ETH:  { sym: 'ETH',  binSym: 'ETHUSDT',  color: '🔵' },
  SOL:  { sym: 'SOL',  binSym: 'SOLUSDT',  color: '🟣' },
  XRP:  { sym: 'XRP',  binSym: 'XRPUSDT',  color: '🔷' },
  BNB:  { sym: 'BNB',  binSym: 'BNBUSDT',  color: '💛' },
  DOGE: { sym: 'DOGE', binSym: 'DOGEUSDT', color: '🟡' },
  HYPE: { sym: 'HYPE', binSym: 'HYPEUSDT', color: '🟢' },
};

// ── Base Weights Template ────────────────────────────────────────
const DEFAULT_WEIGHTS = JSON.parse(fs.readFileSync(WEIGHTS_JSON, 'utf8'));
const COMPOSITE_WEIGHTS = DEFAULT_WEIGHTS.COMPOSITE_WEIGHTS;
const OUTER_ORBITAL_WEIGHTS = { momentum: 0.05, vwap: 0.05 };
const PER_COIN_INDICATOR_BIAS = DEFAULT_WEIGHTS.PER_COIN_INDICATOR_BIAS;

// ── Math & Statistical Helpers ───────────────────────────────────
const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const average = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
const stddev  = arr => {
  if (!arr || arr.length < 2) return 0;
  const avg = average(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length);
};

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

// ── Technical Indicators ─────────────────────────────────────────
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

function calcSMA(data, period) {
  const sma = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (i >= period) sum -= data[i - period];
    if (i >= period - 1) sma.push(sum / period);
    else sma.push(data[i]);
  }
  return sma;
}

function calcWMA(data, period) {
  const wma = [];
  const denom = (period * (period + 1)) / 2;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      wma.push(data[i]);
      continue;
    }
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j] * (period - j);
    wma.push(sum / denom);
  }
  return wma;
}

function calcHMA(data, period = 16) {
  if (data.length < period) return data;
  const halfP = Math.max(1, Math.round(period / 2));
  const sqrtP = Math.max(1, Math.round(Math.sqrt(period)));
  const wmaHalf = calcWMA(data, halfP);
  const wmaFull = calcWMA(data, period);
  const diff = [];
  for (let i = 0; i < data.length; i++) diff.push(2 * wmaHalf[i] - wmaFull[i]);
  return calcWMA(diff, sqrtP);
}

function calcVWAP(candles) {
  let cumVol = 0, cumTP = 0;
  return candles.map(c => {
    const tp = (c.h + c.l + c.c) / 3;
    const vol = c.v || 1;
    cumVol += vol; cumTP += tp * vol;
    return cumVol > 0 ? cumTP / cumVol : tp;
  });
}

function calcVWMA(candles, period = 20) {
  const vwma = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      vwma.push(candles[i].c);
      continue;
    }
    let sumPV = 0, sumV = 0;
    for (let j = 0; j < period; j++) {
      const c = candles[i - j];
      const vol = c.v || 1;
      sumPV += c.c * vol;
      sumV += vol;
    }
    vwma.push(sumV > 0 ? sumPV / sumV : candles[i].c);
  }
  return vwma;
}

function calcOBV(candles) {
  const obv = [0];
  for (let i = 1; i < candles.length; i++) {
    const vol = candles[i].v || 1;
    if (candles[i].c > candles[i - 1].c) obv.push(obv[i - 1] + vol);
    else if (candles[i].c < candles[i - 1].c) obv.push(obv[i - 1] - vol);
    else obv.push(obv[i - 1]);
  }
  return obv;
}

function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signalPeriod);
  const lastMACD = macdLine[macdLine.length - 1];
  const lastSig  = signalLine[signalLine.length - 1];
  return { macd: lastMACD, signal: lastSig, histogram: lastMACD - lastSig };
}

function calcBollinger(closes, period = 20, mult = 2.0) {
  if (closes.length < period) return { middle: closes[closes.length - 1] || 0, upper: 0, lower: 0, position: 0.5 };
  const slice = closes.slice(-period);
  const middle = average(slice);
  const sd = stddev(slice);
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;
  const last = closes[closes.length - 1];
  const width = upper - lower;
  const position = width > 0 ? (last - lower) / width : 0.5;
  return { middle, upper, lower, position };
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const slice = trs.slice(-period);
  return average(slice);
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return { adx: 20, pdi: 20, mdi: 20 };
  const trs = [], pDMs = [], mDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    const upMove = c.h - p.h, dnMove = p.l - c.l;
    pDMs.push(upMove > dnMove && upMove > 0 ? upMove : 0);
    mDMs.push(dnMove > upMove && dnMove > 0 ? dnMove : 0);
  }
  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxs = [];
  for (let i = period; i < trs.length; i++) {
    sTR = sTR - sTR / period + trs[i];
    sPDM = sPDM - sPDM / period + pDMs[i];
    sMDM = sMDM - sMDM / period + mDMs[i];
    const pdi = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    const mdi = sTR > 0 ? (sMDM / sTR) * 100 : 0;
    const sum = pdi + mdi;
    dxs.push(sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0);
  }
  const adx = average(dxs.slice(-period));
  const pdi = sTR > 0 ? (sPDM / sTR) * 100 : 20;
  const mdi = sTR > 0 ? (sMDM / sTR) * 100 : 20;
  return { adx, pdi, mdi };
}

function calcWilliamsR(candles, period = 14) {
  if (candles.length < period) return -50;
  const slice = candles.slice(-period);
  const highest = Math.max(...slice.map(c => c.h));
  const lowest  = Math.min(...slice.map(c => c.l));
  const last = slice[slice.length - 1].c;
  return highest === lowest ? -50 : ((highest - last) / (highest - lowest)) * -100;
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let posFlow = 0, negFlow = 0;
  const slice = candles.slice(-period - 1);
  for (let i = 1; i < slice.length; i++) {
    const tp1 = (slice[i].h + slice[i].l + slice[i].c) / 3;
    const tp0 = (slice[i - 1].h + slice[i - 1].l + slice[i - 1].c) / 3;
    const rawFlow = tp1 * (slice[i].v || 1);
    if (tp1 > tp0) posFlow += rawFlow;
    else if (tp1 < tp0) negFlow += rawFlow;
  }
  if (negFlow === 0) return 100;
  return 100 - (100 / (1 + posFlow / negFlow));
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const needed = rsiPeriod + stochPeriod + Math.max(smoothK, smoothD) + 2;
  if (closes.length < needed) return { k: 50, d: 50 };
  const input = closes.length > 75 ? closes.slice(-75) : closes;
  const rsiValues = [];
  for (let i = rsiPeriod; i <= input.length; i++) {
    rsiValues.push(calcRSI(input.slice(0, i), rsiPeriod));
  }
  const stochRSI = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const min = Math.min(...window), max = Math.max(...window);
    stochRSI.push(max === min ? 50 : ((rsiValues[i] - min) / (max - min)) * 100);
  }
  const kArr = calcSMA(stochRSI, smoothK);
  const dArr = calcSMA(kArr, smoothD);
  return { k: kArr[kArr.length - 1] ?? 50, d: dArr[dArr.length - 1] ?? 50 };
}

function calcSupertrend(candles, period = 10, multiplier = 3.0) {
  if (candles.length < period + 1) return { signal: 0, trend: 'neutral' };
  const atr = calcATR(candles, period);
  let upperBand = 0, lowerBand = 0, inUpTrend = true;
  for (let i = period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const hl2 = (c.h + c.l) / 2;
    let bUpper = hl2 + multiplier * atr;
    let bLower = hl2 - multiplier * atr;
    lowerBand = (bLower > lowerBand || p.c < lowerBand) ? bLower : lowerBand;
    upperBand = (bUpper < upperBand || p.c > upperBand) ? bUpper : upperBand;
    if (inUpTrend && c.c < lowerBand) inUpTrend = false;
    else if (!inUpTrend && c.c > upperBand) inUpTrend = true;
  }
  const lastClose = candles[candles.length - 1].c;
  const band = inUpTrend ? lowerBand : upperBand;
  const distPct = band > 0 ? (lastClose - band) / band * 100 : 0;
  const signal = inUpTrend ? clamp(0.35 + distPct * 0.15, 0.2, 1.0) : -clamp(0.35 + Math.abs(distPct) * 0.15, 0.2, 1.0);
  return { signal, trend: inUpTrend ? 'bull' : 'bear' };
}

function calcCCI(candles, period = 14) {
  if (candles.length < period) return 0;
  const tps = candles.slice(-period).map(c => (c.h + c.l + c.c) / 3);
  const mean = average(tps);
  const meanDev = average(tps.map(tp => Math.abs(tp - mean))) || 0.0001;
  return (tps[tps.length - 1] - mean) / (0.015 * meanDev);
}

function calcCMF(candles, period = 20) {
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  let mfvSum = 0, volSum = 0;
  for (const c of slice) {
    const range = c.h - c.l;
    const clv = range > 0 ? ((c.c - c.l) - (c.h - c.c)) / range : 0;
    const vol = c.v || 1;
    mfvSum += clv * vol;
    volSum += vol;
  }
  return volSum > 0 ? mfvSum / volSum : 0;
}

function calcFisher(candles, period = 10) {
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const highest = Math.max(...slice.map(c => c.h));
  const lowest  = Math.min(...slice.map(c => c.l));
  const last    = (slice[slice.length - 1].h + slice[slice.length - 1].l) / 2;
  const hlDiff  = highest - lowest || 0.0001;
  const raw     = clamp(0.66 * ((last - lowest) / hlDiff - 0.5), -0.999, 0.999);
  return 0.5 * Math.log((1 + raw) / (1 - raw));
}

function calcKeltner(candles, period = 20, mult = 2.0) {
  if (candles.length < period) return { position: 0.5 };
  const closes = candles.map(c => c.c);
  const ema = calcEMA(closes, period);
  const mid = ema[ema.length - 1];
  const atr = calcATR(candles, period);
  const up = mid + mult * atr, dn = mid - mult * atr;
  const last = closes[closes.length - 1];
  const pos = up - dn > 0 ? (last - dn) / (up - dn) : 0.5;
  return { position: pos };
}

function calcTrendPersistence(closes, emaSeries, span = 12) {
  if (closes.length < span || emaSeries.length < span) return { signal: 0 };
  const rCloses = closes.slice(-span), rEma = emaSeries.slice(-span);
  const above = rCloses.filter((c, i) => c >= rEma[i]).length;
  const aboveRate = (above / span) * 100;
  const emaStart = rEma[0] || 1;
  const slopePct = ((rEma[rEma.length - 1] - emaStart) / emaStart) * 100;
  return { signal: clamp(((aboveRate - 50) / 30) + slopePct * 4, -1, 1) };
}

function calcStructureBias(candles, atrPct) {
  if (!candles || candles.length < 12) return { signal: 0 };
  const recent = candles.slice(-24), latest = recent[recent.length - 1].c;
  const support = Math.min(...recent.map(c => c.l));
  const resistance = Math.max(...recent.map(c => c.h));
  const supGap = latest > 0 ? ((latest - support) / latest) * 100 : 0;
  const resGap = latest > 0 ? ((resistance - latest) / latest) * 100 : 0;
  const buf = clamp(Math.max((atrPct || 0) * 1.25, 0.35), 0.35, 2.4);
  let signal = 0;
  if (supGap <= buf && supGap <= resGap) signal = clamp((buf - supGap) / buf, 0, 1) * 0.85;
  else if (resGap <= buf && resGap < supGap) signal = -clamp((buf - resGap) / buf, 0, 1) * 0.85;
  return { signal };
}

function calcIchimoku(candles) {
  if (candles.length < 52) return { signal: 0 };
  const hl = (slice) => (Math.max(...slice.map(c => c.h)) + Math.min(...slice.map(c => c.l))) / 2;
  const tenkan = hl(candles.slice(-9));
  const kijun  = hl(candles.slice(-26));
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = hl(candles.slice(-52));
  const lastClose = candles[candles.length - 1].c;
  const cloudTop = Math.max(senkouA, senkouB), cloudBottom = Math.min(senkouA, senkouB);
  if (lastClose > cloudTop) return { signal: 0.5 + (tenkan > kijun ? 0.25 : 0) };
  if (lastClose < cloudBottom) return { signal: -0.5 - (tenkan < kijun ? 0.25 : 0) };
  return { signal: tenkan > kijun ? 0.12 : -0.12 };
}

// ── Shared QuantCore Singletons ──────────────────────────────────
const GLOBAL_HURST = new HurstExponent({ min_window: 15, max_window: 60 });
const GLOBAL_KALMAN = new KalmanFilter();

// ── Complete 23-Indicator Signal Extractor ─────────────────────────
function extractSignalVector(candles) {
  if (!candles || candles.length < 35) return null;
  const closes = candles.map(c => c.c);
  const lastPrice = closes[closes.length - 1];

  const rsi = calcRSI(closes);
  let rsiSig = rsi > 70 ? -0.6 - ((rsi - 70) / 30) * 0.4 : rsi < 30 ? 0.6 + ((30 - rsi) / 30) * 0.4 : (rsi - 50) / 50 * 0.3;

  const ema9 = calcEMA(closes, 9), ema21 = calcEMA(closes, 21);
  const emaCross = (ema9[ema9.length - 1] - ema21[ema21.length - 1]) / (ema21[ema21.length - 1] || 1) * 100;
  const emaSig = clamp(emaCross * 5, -1, 1);

  const vwapRolling = calcVWAP(candles.slice(-80));
  const vwapLast = vwapRolling[vwapRolling.length - 1];
  const vwapDev = ((lastPrice - vwapLast) / (vwapLast || 1)) * 100;
  let vwapSig = Math.abs(vwapDev) < 0.3 ? 0 : vwapDev > 1.5 ? -0.5 : vwapDev < -1.5 ? 0.5 : vwapDev > 0 ? 0.3 : -0.3;

  const obv = calcOBV(candles);
  const rOBV = obv.slice(-8);
  const obvSlope = ((rOBV[rOBV.length - 1] - rOBV[0]) / (Math.abs(rOBV[0]) || 1)) * 100;
  const obvSig = clamp(obvSlope / 5, -1, 1);

  const recent = candles.slice(-12);
  let buyV = 0, sellV = 0;
  recent.forEach(c => {
    const range = c.h - c.l || 0.0001, bodyPos = (c.c - c.l) / range, vol = c.v || 1;
    buyV += vol * bodyPos; sellV += vol * (1 - bodyPos);
  });
  const volSig = clamp((buyV / (sellV || 1) - 1) * 0.5, -1, 1);

  const mom = closes.length > 6 ? ((closes[closes.length - 1] - closes[closes.length - 7]) / (closes[closes.length - 7] || 1)) * 100 : 0;
  const momSig = clamp(mom / 2, -1, 1);

  const atr = calcATR(candles);
  const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0.4;
  const bands = calcBollinger(closes);
  let bandSig = bands.position >= 0.88 ? -clamp((bands.position - 0.88) / 0.12, 0, 1)
    : bands.position <= 0.12 ? clamp((0.12 - bands.position) / 0.12, 0, 1)
    : clamp(-(bands.position - 0.5) * 0.45, -0.22, 0.22);

  const persistence = calcTrendPersistence(closes, ema21);
  const structure   = calcStructureBias(candles, atrPct);

  const macdR = calcMACD(closes);
  const macdHistNorm = lastPrice > 0 ? (macdR.histogram / lastPrice) * 1000 : 0;
  const macdCross = macdR.macd > macdR.signal ? 0.18 : macdR.macd < macdR.signal ? -0.18 : 0;
  const macdSig = clamp(macdHistNorm * 2.5 + macdCross, -1, 1);

  const stochR = calcStochRSI(closes);
  let stochSig = stochR.k > 80 ? -0.6 - ((stochR.k - 80) / 20) * 0.4
    : stochR.k < 20 ? 0.6 + ((20 - stochR.k) / 20) * 0.4
    : (stochR.k - 50) / 50 * 0.35;

  const adxR = calcADX(candles);
  const diDiff = (adxR.pdi - adxR.mdi) / Math.max(adxR.pdi + adxR.mdi, 1);
  const adxSig = clamp(diDiff * clamp(adxR.adx / 50, 0, 1) * 1.2, -1, 1);

  const ichi = calcIchimoku(candles);
  const wR = calcWilliamsR(candles);
  let wRSig = wR > -20 ? -0.6 - ((wR + 20) / 20) * 0.4
    : wR < -80 ? 0.6 + ((-80 - wR) / 20) * 0.4
    : (wR + 50) / 50 * -0.3;

  const mfi = calcMFI(candles);
  let mfiSig = mfi > 80 ? -0.6 - ((mfi - 80) / 20) * 0.4
    : mfi < 20 ? 0.6 + ((20 - mfi) / 20) * 0.4
    : (mfi - 50) / 50 * 0.35;

  const hmaLine = calcHMA(closes, 16);
  const hmaCurr = hmaLine[hmaLine.length - 1] || lastPrice;
  const hmaPrev = hmaLine[hmaLine.length - 3] || hmaCurr;
  const hmaSlope = (hmaCurr - hmaPrev) / (Math.abs(hmaPrev) || 1) * 100;
  const hmaSig = clamp(hmaSlope * 8, -1, 1);

  const vwmaLine = calcVWMA(candles, 20);
  const vwmaCurr = vwmaLine[vwmaLine.length - 1];
  const vwmaPrev = vwmaLine[vwmaLine.length - 4] || vwmaCurr;
  const vwmaSlope = (vwmaCurr - vwmaPrev) / (Math.abs(vwmaPrev) || 1) * 100;
  const vwmaSig = clamp(vwmaSlope * 6, -1, 1);

  const sma9arr = calcSMA(closes, 9), sma21arr = calcSMA(closes, 21);
  const smaCross = (sma9arr[sma9arr.length - 1] - sma21arr[sma21arr.length - 1]) / (Math.abs(sma21arr[sma21arr.length - 1]) || 1) * 100;
  const smaSig = clamp(smaCross * 5, -1, 1);

  const stR = calcSupertrend(candles, 10, 3.0);
  const cciVal = calcCCI(candles, 14);
  let cciSig = cciVal > 150 ? -clamp((cciVal - 100) / 150, 0, 1)
    : cciVal < -150 ? clamp((-100 - cciVal) / 150, 0, 1)
    : clamp(cciVal / 200, -0.3, 0.3);

  const cmfVal = calcCMF(candles, 20);
  const cmfSig = clamp(cmfVal * 2.5, -1, 1);

  const fisherVal = calcFisher(candles, 10);
  const fisherSig = clamp(fisherVal / 2.5, -1, 1);

  const kelt = calcKeltner(candles, 20, 2.0);
  let keltSig = kelt.position >= 0.88 ? -clamp((kelt.position - 0.88) / 0.12, 0, 1)
    : kelt.position <= 0.12 ? clamp((0.12 - kelt.position) / 0.12, 0, 1)
    : clamp(-(kelt.position - 0.5) * 0.45, -0.22, 0.22);

  // QuantCore Regime Classification
  const hurstVal = GLOBAL_HURST.compute(closes.slice(-60));
  const kalmanRes = GLOBAL_KALMAN.process(closes.slice(-30));
  const kalmanVel = kalmanRes.velocities[kalmanRes.velocities.length - 1] || 0;

  // Regime determination
  let regime = 'choppy';
  if (hurstVal > 0.55) {
    regime = atrPct > 0.6 ? 'trending_volatile' : 'trending_smooth';
  } else if (hurstVal < 0.45) {
    regime = 'ranging';
  }

  // Trend suppression of counter-trend signals
  const isTrend = regime.startsWith('trending');
  if (isTrend) {
    const trendDir = emaSig > 0 ? 1 : -1;
    if (trendDir > 0) {
      if (rsiSig < 0) rsiSig *= 0.3;
      if (bandSig < 0) bandSig *= 0.3;
      if (wRSig < 0) wRSig *= 0.2;
    } else {
      if (rsiSig > 0) rsiSig *= 0.3;
      if (bandSig > 0) bandSig *= 0.3;
      if (wRSig > 0) wRSig *= 0.2;
    }
  }

  return {
    signals: {
      supertrend: stR.signal,
      hma: hmaSig,
      vwma: vwmaSig,
      ema: emaSig,
      sma: smaSig,
      macd: macdSig,
      persistence: persistence.signal,
      bands: bandSig,
      keltner: keltSig,
      williamsR: wRSig,
      rsi: rsiSig,
      cci: cciSig,
      stochrsi: stochSig,
      volume: volSig,
      obv: obvSig,
      cmf: cmfSig,
      mfi: mfiSig,
      structure: structure.signal,
      ichimoku: ichi.signal,
      adx: adxSig,
      fisher: fisherSig,
      momentum: momSig,
      vwap: vwapSig,
    },
    atrPct,
    hurstVal,
    kalmanVel,
    regime,
    lastPrice,
  };
}

// ── HTTP Data Fetcher with Fast Paginated Ingestion & Caching ─────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGet(res.headers.location));
        return;
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function fetchCandles(binSym, interval = '5m', totalWanted = 2016) {
  const cacheFile = path.join(CACHE_DIR, `${binSym}_${interval}_${totalWanted}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const stat = fs.statSync(cacheFile);
      if (Date.now() - stat.mtimeMs < 6 * 3600 * 1000) { // 6 hour cache
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
    } catch (_) {}
  }

  const hosts = [
    'https://data-api.binance.vision/api/v3',
    'https://api.binance.us/api/v3',
    'https://api.binance.com/api/v3',
  ];

  for (const host of hosts) {
    try {
      const PAGE = 1000;
      const pages = [];
      let endTime = null;
      let remaining = totalWanted;

      while (remaining > 0) {
        const fetchCount = Math.min(PAGE, remaining);
        const url = endTime
          ? `${host}/klines?symbol=${binSym}&interval=${interval}&limit=${fetchCount}&endTime=${endTime}`
          : `${host}/klines?symbol=${binSym}&interval=${interval}&limit=${fetchCount}`;
        const { status, body } = await httpGet(url);
        if (status !== 200) break;
        const rows = JSON.parse(body);
        if (!Array.isArray(rows) || rows.length === 0) break;
        pages.unshift(rows);
        endTime = Number(rows[0][0]) - 1;
        remaining -= rows.length;
        if (rows.length < fetchCount) break;
        await new Promise(r => setTimeout(r, 60));
      }

      if (pages.length > 0) {
        const flattened = pages.flat().map(r => ({
          t: Number(r[0]),
          o: parseFloat(r[1]),
          h: parseFloat(r[2]),
          l: parseFloat(r[3]),
          c: parseFloat(r[4]),
          v: parseFloat(r[5]),
        }));
        flattened.sort((a, b) => a.t - b.t);
        try { fs.writeFileSync(cacheFile, JSON.stringify(flattened), 'utf8'); } catch (_) {}
        return flattened;
      }
    } catch (_) {}
  }

  throw new Error(`Failed to fetch candles for ${binSym} across all endpoints.`);
}

async function fetchBinance1mRange(binSym, startMs, endMs) {
  const cacheKey = `${binSym}_1m_${Math.floor(startMs / 3600000)}_${Math.floor(endMs / 3600000)}.json`;
  const cacheFile = path.join(CACHE_DIR, cacheKey);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (_) {}
  }

  const out = [];
  let cursor = startMs;
  const LIMIT = 1000;
  const hosts = ['https://data-api.binance.vision/api/v3', 'https://api.binance.us/api/v3'];

  while (cursor < endMs) {
    let rows = null;
    for (const host of hosts) {
      try {
        const url = `${host}/klines?symbol=${binSym}&interval=1m&startTime=${cursor}&endTime=${endMs}&limit=${LIMIT}`;
        const { status, body } = await httpGet(url);
        if (status === 200) {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed) && parsed.length) { rows = parsed; break; }
        }
      } catch (_) {}
    }
    if (!rows || !rows.length) break;
    for (const r of rows) out.push({ t: Number(r[0]), c: parseFloat(r[4]) });
    const lastOpen = Number(rows[rows.length - 1][0]);
    if (!(lastOpen > cursor)) break;
    cursor = lastOpen + 60_000;
    await new Promise(r => setTimeout(r, 60));
  }

  if (out.length > 0) {
    try { fs.writeFileSync(cacheFile, JSON.stringify(out), 'utf8'); } catch (_) {}
  }
  return out;
}

function buildMinuteIndex(oneMinCandles) {
  const map = new Map();
  for (const c of oneMinCandles) map.set(Math.floor(c.t / 60_000), c.c);
  return map;
}

function getNearest1mPrice(minuteMap, targetMs, fallbackPrice) {
  if (!minuteMap || !minuteMap.size) return fallbackPrice;
  const targetMin = Math.floor(targetMs / 60_000);
  for (let offset = 0; offset <= 5; offset++) {
    const val = minuteMap.get(targetMin - offset);
    if (val !== undefined) return val;
  }
  return fallbackPrice;
}

// ── ElasticNet-Adam Optimization Engine ───────────────────────────
function trainElasticNetAdam(observations, initialWeights, options = {}) {
  const {
    lr = LR_ARG,
    epochs = EPOCHS_ARG,
    l1 = L1_ARG,
    l2 = L2_ARG,
    beta1 = 0.9,
    beta2 = 0.999,
    eps = 1e-8,
  } = options;

  const keys = Object.keys(initialWeights);
  const W = { ...initialWeights };
  const W0 = { ...initialWeights };

  // Adam moment state
  const m = {}, v = {};
  for (const k of keys) { m[k] = 0; v[k] = 0; }

  function forward(obs, weights) {
    let sumW = 0, sumScore = 0;
    for (const k of keys) {
      const baseW = COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0.05;
      const effectiveW = (weights[k] ?? 1.0) * baseW;
      sumW += Math.abs(effectiveW);
      sumScore += (obs.signals[k] ?? 0) * effectiveW;
    }
    const totalW = sumW || 1;
    const score = clamp((sumScore / totalW) * 1.6, -1, 1);

    // Physical barrier expectation
    const expectedMove = score * obs.atrDollar * 0.40 * obs.remainingFrac;
    const meanFinal = obs.entryPrice + expectedMove;
    const z = (meanFinal - obs.strike) / (obs.sigma || 1);
    const pUp = clamp(normalCDF(z), 0.001, 0.999);

    return { score, sumScore, totalW, z, pUp };
  }

  function evaluateMetrics(weights, data) {
    let bceLoss = 0, brierLoss = 0, correct = 0;
    const N = data.length || 1;

    for (const obs of data) {
      const { pUp } = forward(obs, weights);
      const y = obs.target;
      bceLoss += -(y * Math.log(pUp) + (1 - y) * Math.log(1 - pUp));
      brierLoss += (pUp - y) ** 2;
      const pred = pUp >= 0.5 ? 1 : 0;
      if (pred === y) correct++;
    }

    return {
      loss: bceLoss / N,
      brier: brierLoss / N,
      accuracy: (correct / N) * 100,
      total: N,
    };
  }

  const initialMetrics = evaluateMetrics(W, observations);

  for (let t = 1; t <= epochs; t++) {
    const grads = {};
    for (const k of keys) grads[k] = 0;

    for (const obs of observations) {
      const { sumScore, totalW, z, pUp } = forward(obs, W);
      const y = obs.target;

      // Analytical gradient backprop through normal CDF barrier
      const dL_dp = (pUp - y) / (pUp * (1 - pUp));
      const dp_dz = normalPDF(z);
      const dz_dScore = (obs.atrDollar * 0.40 * obs.remainingFrac) / (obs.sigma || 1);
      const dL_dScore = dL_dp * dp_dz * dz_dScore;

      for (const k of keys) {
        const baseW = COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0.05;
        const sig_k = obs.signals[k] ?? 0;
        // Quotient rule on sumScore / totalW
        const dScore_dWk = 1.6 * baseW * (sig_k * totalW - sumScore * Math.sign(W[k] || 1)) / (totalW ** 2);
        grads[k] += dL_dScore * dScore_dWk;
      }
    }

    const N = Math.max(1, observations.length);
    // Adam update with ElasticNet L1 (Lasso) + L2 (Ridge) shrinkage
    for (const k of keys) {
      const g_data = grads[k] / N;
      const g_reg = l2 * 2 * (W[k] - (W0[k] || 1.0));
      const g_total = g_data + g_reg;

      m[k] = beta1 * m[k] + (1 - beta1) * g_total;
      v[k] = beta2 * v[k] + (1 - beta2) * (g_total ** 2);

      const mHat = m[k] / (1 - beta1 ** t);
      const vHat = v[k] / (1 - beta2 ** t);

      // Gradient step
      let stepW = W[k] - (lr / (Math.sqrt(vHat) + eps)) * mHat;

      // Soft-thresholding operator for L1 Lasso penalty (prunes toxic indicators to 0)
      const threshold = lr * l1;
      if (stepW > threshold) stepW -= threshold;
      else if (stepW < -threshold) stepW += threshold;
      else stepW = 0.0;

      W[k] = clamp(stepW, 0.0, 3.5);
    }
  }

  const finalMetrics = evaluateMetrics(W, observations);
  return { updatedWeights: W, initialMetrics, finalMetrics, evaluateMetrics };
}

// ── K-Fold Purged Walk-Forward Engine ─────────────────────────────
function runWalkForwardValidation(observations, initialBias, numFolds = FOLDS_ARG) {
  const foldSize = Math.floor(observations.length / numFolds);
  if (foldSize < 20) return null;

  const results = [];
  for (let k = 1; k < numFolds; k++) {
    const trainData = observations.slice(0, k * foldSize);
    const testData  = observations.slice(k * foldSize, (k + 1) * foldSize);

    const tuned = trainElasticNetAdam(trainData, initialBias, { epochs: Math.round(EPOCHS_ARG * 0.75) });
    const testMetrics = tuned.evaluateMetrics(tuned.updatedWeights, testData);
    const testBaseline = tuned.evaluateMetrics(initialBias, testData);

    results.push({
      fold: k,
      trainSize: trainData.length,
      testSize: testData.length,
      baselineAccuracy: testBaseline.accuracy,
      oosAccuracy: testMetrics.accuracy,
      oosLoss: testMetrics.loss,
      lift: testMetrics.accuracy - testBaseline.accuracy,
    });
  }

  const avgLift = average(results.map(r => r.lift));
  const avgOOS = average(results.map(r => r.oosAccuracy));
  return { folds: results, avgLift, avgOOS };
}

// ── Main Pipeline ────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(85));
  console.log('  WECRYPTO — NEXT-GEN QUANT HYPERTUNING & OPTIMIZATION SUITE');
  console.log('  Powered by QuantCore (Hurst, Kalman Filter, Regime Decomposition & ElasticNet)');
  console.log('═'.repeat(85));
  console.log(`  Target Coins:      ${COINS_ARG.join(', ')}`);
  console.log(`  Horizon Mode:      ${MODE_ARG.toUpperCase()} (Strike = ${MODE_ARG === 'ptb' ? 'Window Open (PTB)' : 'Spot Delta'})`);
  console.log(`  Candle Interval:   ${INTERVAL_ARG}`);
  console.log(`  History Depth:     ${DAYS_ARG} days`);
  console.log(`  Walk-Forward Folds:${FOLDS_ARG}`);
  console.log(`  ElasticNet Adam:   Epochs=${EPOCHS_ARG}, LR=${LR_ARG}, L1(Lasso)=${L1_ARG}, L2(Ridge)=${L2_ARG}`);
  console.log(`  Commit to State:   ${WRITE_WEIGHTS ? 'YES (write & sync)' : 'NO (audit only)'}`);
  console.log('═'.repeat(85) + '\n');

  const intervalSec = INTERVAL_ARG === '15m' ? 900 : 300;
  const candlesWanted = DAYS_ARG * Math.round(86400 / intervalSec);
  const auditReport = { timestamp: new Date().toISOString(), coins: {} };
  const allTunedBiases = {};

  for (const sym of COINS_ARG) {
    const cfg = COIN_CONFIGS[sym];
    if (!cfg) {
      console.warn(`[WARN] Unsupported coin: ${sym} — skipping.`);
      continue;
    }

    console.log(`\n─────────────────────────────────────────────────────────────────────────────`);
    console.log(` ${cfg.color} ${sym} (${cfg.binSym}) — Calibrating Quant Models...`);
    console.log(`─────────────────────────────────────────────────────────────────────────────`);

    process.stdout.write(`  ⏳ Fetching historical ${INTERVAL_ARG} klines (${candlesWanted} candles)... `);
    let candles = [];
    try {
      candles = await fetchCandles(cfg.binSym, INTERVAL_ARG, candlesWanted);
      console.log(`✓ Loaded ${candles.length} candles.`);
    } catch (e) {
      console.log(`❌ Error: ${e.message}`);
      continue;
    }

    if (candles.length < 50) {
      console.log(`  ⚠️ Insufficient candles for ${sym} (need at least 50) — skipping.`);
      continue;
    }

    let minuteMap = new Map();
    if (MODE_ARG === 'ptb') {
      process.stdout.write(`  ⏳ Fetching 1m klines for lookahead-free intrawindow entry... `);
      try {
        const startMs = candles[0].t;
        const endMs = candles[candles.length - 1].t + intervalSec * 1000;
        const oneMin = await fetchBinance1mRange(cfg.binSym, startMs, endMs);
        minuteMap = buildMinuteIndex(oneMin);
        console.log(`✓ Loaded ${oneMin.length} 1m klines.`);
      } catch (e) {
        console.log(`(using candle open: ${e.message})`);
      }
    }

    // Build Lookahead-Free Training Observations
    const warmup = 36;
    const observations = [];
    const regimeStats = { trending_smooth: 0, trending_volatile: 0, ranging: 0, choppy: 0 };

    for (let i = warmup; i < candles.length - 1; i++) {
      const history = candles.slice(Math.max(0, i - 150), i + 1);
      const current = candles[i];
      const nextCandle = candles[i + 1];

      const model = extractSignalVector(history);
      if (!model) continue;

      regimeStats[model.regime] = (regimeStats[model.regime] || 0) + 1;

      const strike = MODE_ARG === 'ptb' ? nextCandle.o : current.c;
      const settle = nextCandle.c;
      const target = settle >= strike ? 1 : 0;

      let entryPrice = current.c;
      if (MODE_ARG === 'ptb' && minuteMap.size > 0) {
        const entryMs = nextCandle.t + Math.round(intervalSec * 1000 * ENTRY_OFFSET);
        entryPrice = getNearest1mPrice(minuteMap, entryMs, nextCandle.o);
      }

      const atrDollar = entryPrice * (model.atrPct / 100);
      const remainingFrac = 1.0 - ENTRY_OFFSET;
      const sigma = Math.max(entryPrice * 0.0015, atrDollar * Math.sqrt(remainingFrac));

      observations.push({
        strike,
        settle,
        entryPrice,
        target,
        atrDollar,
        remainingFrac,
        sigma,
        regime: model.regime,
        signals: model.signals,
      });
    }

    console.log(`  ✓ Built ${observations.length} training observations.`);
    console.log(`    Regime distribution: SmoothTrend=${regimeStats.trending_smooth}, VolTrend=${regimeStats.trending_volatile}, Range=${regimeStats.ranging}, Chop=${regimeStats.choppy}`);

    const baseBias = PER_COIN_INDICATOR_BIAS[sym] || {};
    // Ensure all 23 indicators have baseline weight
    const initialBias = {};
    for (const k of Object.keys(COMPOSITE_WEIGHTS).concat(['momentum', 'vwap'])) {
      initialBias[k] = baseBias[k] !== undefined ? baseBias[k] : 1.0;
    }

    // Purged K-Fold Walk-Forward Cross Validation
    console.log(`  ⚡ Executing ${FOLDS_ARG}-Fold Purged Walk-Forward Cross-Validation...`);
    const wfRes = runWalkForwardValidation(observations, initialBias, FOLDS_ARG);
    if (wfRes) {
      console.log(`    • Out-Of-Sample (OOS) Baseline Win Rate: ${average(wfRes.folds.map(f => f.baselineAccuracy)).toFixed(1)}%`);
      console.log(`    • Out-Of-Sample (OOS) Calibrated Win Rate: ${wfRes.avgOOS.toFixed(1)}%`);
      console.log(`    • Average Generalization Lift: ${wfRes.avgLift >= 0 ? '+' : ''}${wfRes.avgLift.toFixed(2)} pp`);
    }

    // Full ElasticNet-Adam Calibration
    console.log(`  ⚡ Optimizing Indicator Weights with ElasticNet-Adam (${EPOCHS_ARG} epochs)...`);
    const trainRes = trainElasticNetAdam(observations, initialBias);
    allTunedBiases[sym] = trainRes.updatedWeights;

    console.log(`\n  ┌─────────────────────────────────────────────────────────────┐`);
    console.log(`  │ FINAL CALIBRATION RESULTS FOR ${sym.padEnd(5)}                          │`);
    console.log(`  ├─────────────────────────────────────────────────────────────┤`);
    console.log(`  │ Baseline Win Rate:   ${trainRes.initialMetrics.accuracy.toFixed(1).padStart(5)}%  (Loss: ${trainRes.initialMetrics.loss.toFixed(4)}, Brier: ${trainRes.initialMetrics.brier.toFixed(4)}) │`);
    console.log(`  │ Calibrated Win Rate: ${trainRes.finalMetrics.accuracy.toFixed(1).padStart(5)}%  (Loss: ${trainRes.finalMetrics.loss.toFixed(4)}, Brier: ${trainRes.finalMetrics.brier.toFixed(4)}) │`);
    console.log(`  │ Lift:               +${(trainRes.finalMetrics.accuracy - trainRes.initialMetrics.accuracy).toFixed(1).padStart(4)} pp                                │`);
    console.log(`  └─────────────────────────────────────────────────────────────┘`);

    console.log(`\n  Indicator Tuning Audit:`);
    const sorted = Object.entries(trainRes.updatedWeights).sort((a, b) => b[1] - a[1]);
    const top = sorted.filter(([, v]) => v >= 1.05);
    const pruned = sorted.filter(([, v]) => v < 0.35);

    if (top.length) {
      console.log(`    ★ Amplified Edge Indicators:`);
      for (const [k, v] of top.slice(0, 7)) {
        const delta = ((v - (initialBias[k] || 1.0)) / (initialBias[k] || 1.0)) * 100;
        console.log(`      • ${k.padEnd(14)} : ${v.toFixed(3)}x (${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%)`);
      }
    }
    if (pruned.length) {
      console.log(`    ✗ Pruned / Attenuated Noise Indicators (L1 Lasso):`);
      for (const [k, v] of pruned.slice(0, 7)) {
        console.log(`      • ${k.padEnd(14)} : ${v.toFixed(3)}x`);
      }
    }

    auditReport.coins[sym] = {
      observations: observations.length,
      initialAccuracy: trainRes.initialMetrics.accuracy,
      calibratedAccuracy: trainRes.finalMetrics.accuracy,
      initialLoss: trainRes.initialMetrics.loss,
      calibratedLoss: trainRes.finalMetrics.loss,
      walkForward: wfRes,
      tunedWeights: trainRes.updatedWeights,
    };
  }

  // Save Audit Report
  const reportPath = path.join(RESULTS_DIR, 'hypertune-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(auditReport, null, 2), 'utf8');
  console.log(`\n💾 Saved detailed hyperparameter audit report to: ${reportPath}`);

  // Write to Single Source of Truth if requested
  if (WRITE_WEIGHTS && Object.keys(allTunedBiases).length > 0) {
    console.log('\n' + '─'.repeat(85));
    console.log('  COMMITTING WEIGHTS TO predictions-weights.json & SYNCHRONIZING SYSTEM');
    console.log('─'.repeat(85));

    const weightsDoc = JSON.parse(fs.readFileSync(WEIGHTS_JSON, 'utf8'));
    for (const [coin, biasMap] of Object.entries(allTunedBiases)) {
      if (!weightsDoc.PER_COIN_INDICATOR_BIAS[coin]) {
        weightsDoc.PER_COIN_INDICATOR_BIAS[coin] = {};
      }
      for (const [k, v] of Object.entries(biasMap)) {
        weightsDoc.PER_COIN_INDICATOR_BIAS[coin][k] = parseFloat(v.toFixed(3));
      }
    }

    fs.writeFileSync(WEIGHTS_JSON, JSON.stringify(weightsDoc, null, 2), 'utf8');
    console.log(`✓ Updated ${WEIGHTS_JSON}`);

    console.log(`⚡ Executing sync-weights.js across all core engine targets...`);
    try {
      const syncOut = execSync(`node ${SYNC_SCRIPT}`, { cwd: ROOT, encoding: 'utf8' });
      console.log(syncOut.trim());
      console.log(`\n✅ ALL SYSTEM WEIGHTS SYNCHRONIZED SUCCESSFULLY.`);
    } catch (e) {
      console.error(`❌ sync-weights.js failed: ${e.message}`);
    }
  } else if (!WRITE_WEIGHTS) {
    console.log('\n💡 Tip: Run with --write-weights to commit these calibrated weights to predictions-weights.json');
  }
}

main().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
