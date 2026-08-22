#!/usr/bin/env node
// ================================================================
// WECRYPTO — Outcome-Based Indicator Weight Retuner
//
// Fetches historical 15m OHLC windows from Binance, computes the
// signal vector at the START of each window, then grades each
// indicator against the ACTUAL market outcome.
//
// Gradient descent optimises per-indicator weights to maximise
// directional accuracy.  Results can be written back to
// PER_COIN_INDICATOR_BIAS in src/core/predictions.js and
// backtest/backtest-runner.js.
//
// Usage:
//   node backtest/outcome-retuner.js --days 60 --coins BTC,ETH
//   node backtest/outcome-retuner.js --days 7 --coins BTC --test
//   node backtest/outcome-retuner.js --days 30 --max 200 --write-weights
// ================================================================
'use strict';

// ── 1. Requires ─────────────────────────────────────────────────
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── 2. CLI arg parsing (done in main()) ─────────────────────────

// ── 3. Constants ─────────────────────────────────────────────────
const SYMBOL_MAP = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
  BNB: 'BNBUSDT',
  DOGE: 'DOGEUSDT',
  HYPE: 'HYPEUSDT',
};
const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const LOOKBACK_BARS = 200;   // 5m bars fetched before each 15m window
const LOOKBACK_INTERVAL = '5m';
const OUTCOME_INTERVAL = '15m';
const MIN_CHANGE_PCT = 0.05;  // ignore FLAT windows (< 0.05% move)
const WRITE_CHANGE_THRESHOLD_PCT = 1; // write materially changed weights, but avoid tiny noise

// ── 4. Indicator functions — copied VERBATIM from backtest-runner.js ──

// ── Utility helpers ─────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const average = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

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
    const tp = (c.h + c.l + c.c) / 3;
    const vol = c.v || 1;
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
  const lastSig = signalLine[signalLine.length - 1];
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
  const atrS = wilderSmooth(trs, period);
  const pdiS = wilderSmooth(plusDMs, period);
  const mdiS = wilderSmooth(minusDMs, period);
  const dxArr = atrS.map((atr, i) => {
    const pdi = atr > 0 ? (pdiS[i] / atr) * 100 : 0;
    const mdi = atr > 0 ? (mdiS[i] / atr) * 100 : 0;
    const sum = pdi + mdi;
    return sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0;
  });
  const adxArr = wilderSmooth(dxArr, period);
  const li = adxArr.length - 1;
  const lastATR = atrS[li];
  return { adx: adxArr[li], pdi: lastATR > 0 ? (pdiS[li] / lastATR) * 100 : 0, mdi: lastATR > 0 ? (mdiS[li] / lastATR) * 100 : 0 };
}

// NOTE: backtest-runner.js returns { tenkan, kijun, spanA, spanB, cloudPos }
// (NOT senkouA/senkouB — actual key names are spanA/spanB)
function calcIchimoku(candles) {
  if (candles.length < 9) return { tenkan: 0, kijun: 0, cloudPos: 'inside' };
  const high = arr => Math.max(...arr.map(c => c.h));
  const low = arr => Math.min(...arr.map(c => c.l));
  const tenkan = (high(candles.slice(-9)) + low(candles.slice(-9))) / 2;
  const slice26 = candles.length >= 26 ? candles.slice(-26) : candles;
  const kijun = (high(slice26) + low(slice26)) / 2;
  const slice52 = candles.length >= 52 ? candles.slice(-52) : slice26;
  const spanA = (tenkan + kijun) / 2;
  const spanB = (high(slice52) + low(slice52)) / 2;
  const price = candles[candles.length - 1].c;
  const cloudTop = Math.max(spanA, spanB);
  const cloudBot = Math.min(spanA, spanB);
  const cloudPos = price > cloudTop ? 'above' : price < cloudBot ? 'below' : 'inside';
  return { tenkan, kijun, spanA, spanB, cloudPos };
}

function calcWilliamsR(candles, period = 14) {
  if (candles.length < period) return -50;
  const slice = candles.slice(-period);
  const hh = Math.max(...slice.map(c => c.h));
  const ll = Math.min(...slice.map(c => c.l));
  const close = candles[candles.length - 1].c;
  return hh !== ll ? ((hh - close) / (hh - ll)) * -100 : -50;
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  const slice = candles.slice(-period - 1);
  let posFlow = 0, negFlow = 0;
  for (let i = 1; i < slice.length; i++) {
    const prevTP = (slice[i - 1].h + slice[i - 1].l + slice[i - 1].c) / 3;
    const currTP = (slice[i].h + slice[i].l + slice[i].c) / 3;
    const rawFlow = currTP * (slice[i].v || 1);
    if (currTP > prevTP) posFlow += rawFlow;
    else if (currTP < prevTP) negFlow += rawFlow;
  }
  if (negFlow === 0) return posFlow > 0 ? 100 : 50;
  return 100 - 100 / (1 + posFlow / negFlow);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++)
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
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
  const half = Math.floor(period / 2);
  const sqrtP = Math.floor(Math.sqrt(period));
  const wmaHalf = wma(data, half);
  const wmaFull = wma(data, period);
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
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrs.push(atr);
  }
  let finalUpper = 0, finalLower = 0, supertrend = 0, bullish = false;
  let initialized = false;
  for (let i = 0; i < atrs.length; i++) {
    const ci = candles[i + 1];
    const hl2 = (ci.h + ci.l) / 2;
    const rawUpper = hl2 + multiplier * atrs[i];
    const rawLower = hl2 - multiplier * atrs[i];
    const prevClose = candles[i].c;
    if (!initialized) {
      finalUpper = rawUpper; finalLower = rawLower;
      supertrend = rawUpper; bullish = false; initialized = true;
    } else {
      const newUpper = (rawUpper < finalUpper || prevClose > finalUpper) ? rawUpper : finalUpper;
      const newLower = (rawLower > finalLower || prevClose < finalLower) ? rawLower : finalLower;
      const prevST = supertrend;
      if (prevST === finalUpper) {
        bullish = ci.c > newUpper;
        supertrend = bullish ? newLower : newUpper;
      } else {
        bullish = ci.c >= newLower;
        supertrend = bullish ? newLower : newUpper;
      }
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
  // Clamped to +/-500, matching src/core/predictions.js's live calcCCI -- an
  // unclamped reading here lets a near-zero meanDev spike distort the
  // gradient-descent weight grading with a magnitude the live model can
  // never actually produce.
  return meanDev > 0.00001 ? clamp((tps[tps.length - 1] - mean) / (0.015 * meanDev), -500, 500) : 0;
}

function calcCMF(candles, period) {
  period = period || 20;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  let mfvSum = 0, volSum = 0;
  for (const c of slice) {
    const range = c.h - c.l;
    const vol = c.v || 1;
    const mfm = range > 0 ? ((c.c - c.l) - (c.h - c.c)) / range : 0;
    mfvSum += mfm * vol; volSum += vol;
  }
  return volSum > 0 ? mfvSum / volSum : 0;
}

// NOTE: calcFisher returns a PLAIN NUMBER in backtest-runner.js (not { value: ... })
function calcFisher(candles, period) {
  period = period || 10;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const hh = Math.max(...slice.map(c => c.h));
  const ll = Math.min(...slice.map(c => c.l));
  const close = candles[candles.length - 1].c;
  const range = hh - ll;
  let value = range > 0 ? 2 * ((close - ll) / range) - 1 : 0;
  value = Math.max(-0.999, Math.min(0.999, value));
  return 0.5 * Math.log((1 + value) / (1 - value));
}

// NOTE: calcKeltner returns { position } in backtest-runner.js (not { upper, lower, mid })
function calcKeltner(candles, period, mult) {
  period = period || 20; mult = mult || 2.0;
  if (candles.length < period) return { position: 0.5 };
  const closes = candles.map(c => c.c);
  const ema = calcEMA(closes, period);
  const middle = ema[ema.length - 1];
  const atr = calcATR(candles, period);
  const upper = middle + mult * atr;
  const lower = middle - mult * atr;
  const width = Math.max(upper - lower, middle * 0.0001);
  return { position: Math.max(0, Math.min(1, (closes[closes.length - 1] - lower) / width)) };
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) { return { position: 0.5, widthPct: 0 }; }
  const slice = closes.slice(-period);
  const middle = average(slice);
  const std = calcStdDev(closes, period);
  const upper = middle + std * 2, lower = middle - std * 2;
  const width = Math.max(upper - lower, middle * 0.0001);
  return { position: clamp((slice[slice.length - 1] - lower) / width, 0, 1), widthPct: middle > 0 ? (width / middle) * 100 : 0 };
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
  const support = Math.min(...recent.map(c => c.l));
  const resistance = Math.max(...recent.map(c => c.h));
  const supportGapPct = latest > 0 ? ((latest - support) / latest) * 100 : 0;
  const resistanceGapPct = latest > 0 ? ((resistance - latest) / latest) * 100 : 0;
  const bufferPct = clamp(Math.max((atrPct || 0) * 1.25, 0.35), 0.35, 2.4);
  let zone = 'middle', signal = 0;
  if (supportGapPct <= bufferPct && supportGapPct <= resistanceGapPct) {
    zone = 'support';
    signal = clamp((bufferPct - supportGapPct) / bufferPct, 0, 1) * 0.85;
  } else if (resistanceGapPct <= bufferPct && resistanceGapPct < supportGapPct) {
    zone = 'resistance';
    signal = -clamp((bufferPct - resistanceGapPct) / bufferPct, 0, 1) * 0.85;
  }
  return { signal, zone, supportGapPct, resistanceGapPct };
}

// OBV slope helper (used by computeSignalVector)
function slopeOBV(arr, n = 5) {
  if (arr.length < n + 1) return 0;
  const r = arr.slice(-n);
  const avg = (Math.abs(r[0]) + Math.abs(r[r.length - 1])) / 2 || 1;
  return ((r[r.length - 1] - r[0]) / avg) * 100;
}

// ── 5. HTTP helpers ──────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Minimal HTTPS GET returning parsed JSON.
 * Resolves { __status429: true } on rate-limit so caller can back off.
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const mod = require('https');
    const req = mod.get(url, { timeout: 15000 }, res => {
      if (res.statusCode === 429) {
        res.resume(); // drain
        resolve({ __status429: true });
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse fail: ${url.slice(0, 100)}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url.slice(0, 80)}`)); });
  });
}

/**
 * Binance GET with automatic 429 back-off and basic retry.
 * Enforces a minimum 150ms delay between calls (caller also sleeps before invoking).
 */
async function binanceGet(url, retries = 2) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await httpsGet(url);
      if (result && result.__status429) {
        console.log('  [429] Rate limited — sleeping 10s...');
        await sleep(10000);
        continue; // retry
      }
      return result;
    } catch (e) {
      if (attempt < retries - 1) { await sleep(2000); continue; }
      throw e;
    }
  }
  return null;
}

// ── 6. Window Generator ─────────────────────────────────────────

/**
 * Generates array of {startMs, endMs} for every closed 15m window
 * over the last `days` days, aligned to 15-minute UTC boundaries.
 */
function generateWindows(days) {
  const windows = [];
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  // Align start to nearest 15m boundary (ceiling)
  const aligned = Math.ceil(start / (15 * 60000)) * (15 * 60000);
  for (let t = aligned; t < now - 15 * 60000; t += 15 * 60000) {
    windows.push({ startMs: t, endMs: t + 15 * 60000 });
  }
  return windows;
}

// ── 7. fetchOutcome ──────────────────────────────────────────────

/**
 * Fetches the 15m candle that started at windowStart for `symbol`.
 * Returns { open, close, high, low, vol, pct, direction } or null.
 */
async function fetchOutcome(symbol, windowStart) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&startTime=${windowStart}&endTime=${windowStart + 15 * 60000}&limit=1`;
  const data = await binanceGet(url);
  if (!Array.isArray(data) || !data[0]) return null;
  const open = parseFloat(data[0][1]);
  const close = parseFloat(data[0][4]);
  const high = parseFloat(data[0][2]);
  const low = parseFloat(data[0][3]);
  const vol = parseFloat(data[0][5]);
  if (!open || open === 0) return null;
  const pct = (close - open) / open * 100;
  return {
    open, close, high, low, vol, pct,
    direction: pct > MIN_CHANGE_PCT ? 'UP' : pct < -MIN_CHANGE_PCT ? 'DOWN' : 'FLAT',
  };
}

// ── 8. fetchLookback ─────────────────────────────────────────────

/**
 * Fetches LOOKBACK_BARS of 5m candles ending just before windowStart.
 * Returns normalised candle array { t, o, h, l, c, v } or null.
 */
async function fetchLookback(symbol, windowStart) {
  const startTime = windowStart - LOOKBACK_BARS * 5 * 60000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${LOOKBACK_INTERVAL}&startTime=${startTime}&endTime=${windowStart}&limit=${LOOKBACK_BARS}`;
  const data = await binanceGet(url);
  if (!Array.isArray(data) || data.length < 30) return null;
  return data.map(k => ({
    t: k[0],
    o: parseFloat(k[1]), h: parseFloat(k[2]),
    l: parseFloat(k[3]), c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  }));
}

// ── 9. computeSignalVector ───────────────────────────────────────

/**
 * Replicates buildSignalModel from backtest-runner.js EXACTLY,
 * returning only the raw sv (signal vector) before any bias
 * application.  All indicator return shapes verified against
 * backtest-runner.js source:
 *   calcFisher  → plain number (NOT {value})
 *   calcKeltner → { position }  (NOT { upper, lower, mid })
 *   calcIchimoku → { tenkan, kijun, spanA, spanB, cloudPos }
 */
function computeSignalVector(candles) {
  if (!candles || candles.length < 26) return null;
  const closes = candles.map(c => c.c);
  const lastPrice = closes[closes.length - 1];

  // ── RSI ──
  const rsi = calcRSI(closes);
  let rsiSig = 0;
  if (rsi > 70) rsiSig = -0.6 - ((rsi - 70) / 30) * 0.4;
  else if (rsi < 30) rsiSig = 0.6 + ((30 - rsi) / 30) * 0.4;
  else rsiSig = (rsi - 50) / 50 * 0.3;

  // ── EMA cross ──
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const emaCross = (ema9[ema9.length - 1] - ema21[ema21.length - 1]) / (ema21[ema21.length - 1] || 1) * 100;
  const emaSig = clamp(emaCross * 5, -1, 1);

  // ── VWAP deviation (rolling 80-bar) ──
  const vwapRolling = calcVWAP(candles.slice(-80));
  const vwapRollingLast = vwapRolling[vwapRolling.length - 1];
  const vwapDev = ((lastPrice - vwapRollingLast) / (vwapRollingLast || 1)) * 100;
  let vwapSig = 0;
  if (Math.abs(vwapDev) < 0.3) vwapSig = 0;
  else if (vwapDev > 1.5) vwapSig = -0.5;
  else if (vwapDev < -1.5) vwapSig = 0.5;
  else vwapSig = vwapDev > 0 ? 0.3 : -0.3;

  // ── OBV slope ──
  const obv = calcOBV(candles);
  const obvSig = clamp(slopeOBV(obv, 8) / 5, -1, 1);

  // ── Volume delta (buy/sell aggressor proxy) ──
  const recent = candles.slice(-12);
  let buyV = 0, sellV = 0;
  recent.forEach(c => {
    const range = c.h - c.l || 0.0001;
    const bodyPos = (c.c - c.l) / range;
    const vol = c.v || 1;
    buyV += vol * bodyPos; sellV += vol * (1 - bodyPos);
  });
  const volSig = clamp((buyV / (sellV || 1) - 1) * 0.5, -1, 1);

  // ── Momentum (6-bar ROC) ──
  const mom = closes.length > 6 ? ((closes[closes.length - 1] - closes[closes.length - 7]) / (closes[closes.length - 7] || 1)) * 100 : 0;
  const momSig = clamp(mom / 2, -1, 1);

  // ── ATR + Bollinger Bands ──
  const atr = calcATR(candles);
  const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
  const bands = calcBollinger(closes);
  let bandSig = 0;
  if (bands.position >= 0.88) bandSig = -clamp((bands.position - 0.88) / 0.12, 0, 1);
  else if (bands.position <= 0.12) bandSig = clamp((0.12 - bands.position) / 0.12, 0, 1);
  else bandSig = clamp(-(bands.position - 0.5) * 0.45, -0.22, 0.22);

  // ── Trend Persistence + Structure ──
  const persistence = calcTrendPersistence(closes, ema21);
  const structure = calcStructureBias(candles, atrPct);

  // ── MACD ──
  const macdR = calcMACD(closes);
  const macdHistNorm = lastPrice > 0 ? (macdR.histogram / lastPrice) * 1000 : 0;
  const macdCross = macdR.macd > macdR.signal ? 0.18 : macdR.macd < macdR.signal ? -0.18 : 0;
  const macdSig = clamp(macdHistNorm * 2.5 + macdCross, -1, 1);

  // ── StochRSI ──
  const stochR = calcStochRSI(closes);
  let stochSig = 0;
  if (stochR.k > 80) stochSig = -0.6 - ((stochR.k - 80) / 20) * 0.4;
  else if (stochR.k < 20) stochSig = 0.6 + ((20 - stochR.k) / 20) * 0.4;
  else stochSig = (stochR.k - 50) / 50 * 0.35;
  stochSig = clamp(stochSig + clamp((stochR.k - stochR.d) / 20, -0.18, 0.18), -1, 1);

  // ── ADX / DI ──
  const adxR = calcADX(candles);
  const diDiff = (adxR.pdi - adxR.mdi) / Math.max(adxR.pdi + adxR.mdi, 1);
  const adxSig = clamp(diDiff * clamp(adxR.adx / 50, 0, 1) * 1.2, -1, 1);

  // ── Ichimoku (keys: tenkan, kijun, spanA, spanB, cloudPos) ──
  const ichi = calcIchimoku(candles);
  let ichiSig = 0;
  if (ichi.cloudPos === 'above') ichiSig = 0.5 + (ichi.tenkan > ichi.kijun ? 0.2 : 0);
  else if (ichi.cloudPos === 'below') ichiSig = -0.5 - (ichi.tenkan < ichi.kijun ? 0.2 : 0);
  else ichiSig = ichi.tenkan > ichi.kijun ? 0.12 : ichi.tenkan < ichi.kijun ? -0.12 : 0;
  ichiSig = clamp(ichiSig, -1, 1);

  // ── Williams %R ──
  const wR = calcWilliamsR(candles);
  let wRSig = 0;
  if (wR > -20) wRSig = -0.6 - ((wR + 20) / 20) * 0.4;
  else if (wR < -80) wRSig = 0.6 + ((-80 - wR) / 20) * 0.4;
  else wRSig = (wR + 50) / 50 * -0.3;
  wRSig = clamp(wRSig, -1, 1);

  // ── MFI ──
  const mfi = calcMFI(candles);
  let mfiSig = 0;
  if (mfi > 80) mfiSig = -0.6 - ((mfi - 80) / 20) * 0.4;
  else if (mfi < 20) mfiSig = 0.6 + ((20 - mfi) / 20) * 0.4;
  else mfiSig = (mfi - 50) / 50 * 0.35;
  mfiSig = clamp(mfiSig, -1, 1);

  // ── HMA ──
  const hmaLine = calcHMA(closes, 16);
  const hmaCurr = hmaLine.length ? hmaLine[hmaLine.length - 1] : lastPrice;
  const hmaPrev2 = hmaLine.length > 2 ? hmaLine[hmaLine.length - 3] : hmaCurr;
  const hmaSlope = (hmaCurr - hmaPrev2) / (Math.abs(hmaPrev2) || 1) * 100;
  const hmaDevPct = (lastPrice - hmaCurr) / (Math.abs(hmaCurr) || 1) * 100;
  let hmaSig = clamp(hmaSlope * 8, -0.7, 0.7);
  if (Math.abs(hmaDevPct) > 0.4) hmaSig += clamp(hmaDevPct * 0.28, -0.3, 0.3); // FIX: was negated (see predictions.js live logic)
  hmaSig = clamp(hmaSig, -1, 1);

  // ── VWMA ──
  const vwmaLine = calcVWMA(candles, 20);
  const vwmaCurr = vwmaLine[vwmaLine.length - 1];
  const vwmaPrev = vwmaLine.length > 3 ? vwmaLine[vwmaLine.length - 4] : vwmaCurr;
  const vwmaSlope = (vwmaCurr - vwmaPrev) / (Math.abs(vwmaPrev) || 1) * 100;
  const vwmaDevPct = (lastPrice - vwmaCurr) / (Math.abs(vwmaCurr) || 1) * 100;
  let vwmaSig = clamp(vwmaSlope * 6, -0.6, 0.6);
  vwmaSig += clamp(vwmaDevPct * 0.35, -0.4, 0.4);
  vwmaSig = clamp(vwmaSig, -1, 1);

  // ── SMA cross ──
  const sma9arr = calcSMA(closes, 9);
  const sma21arr = calcSMA(closes, 21);
  const smaCross = (sma9arr[sma9arr.length - 1] - sma21arr[sma21arr.length - 1]) / (Math.abs(sma21arr[sma21arr.length - 1]) || 1) * 100;
  const smaSig = clamp(smaCross * 5, -1, 1);

  // ── Supertrend — returns { signal: 1|-1, bullish, supertrend } ──
  const stR = calcSupertrend(candles, 10, 3.0);
  const supertrendSig = stR.signal; // already ±1

  // ── CCI (trend-filtered) ──
  const cciVal = calcCCI(candles, 14);
  let cciSig = 0;
  if (cciVal > 150) cciSig = -clamp((cciVal - 100) / 150, 0, 1);
  else if (cciVal < -150) cciSig = clamp((-100 - cciVal) / 150, 0, 1);
  else cciSig = clamp(cciVal / 200, -0.3, 0.3); // FIX: was negated (see predictions.js 2026-05-04 CRITICAL fix)
  cciSig = clamp(cciSig, -1, 1);

  // ── CMF ──
  const cmfVal = calcCMF(candles, 20);
  const cmfSig = clamp(cmfVal * 2.5, -1, 1);

  // ── Fisher Transform — plain number return ──
  const fisherVal = calcFisher(candles, 10);
  const fisherSig = clamp(fisherVal / 2.5, -1, 1); // FIX: was negated (see predictions.js 2026-05-04 CRITICAL fix)

  // ── Keltner Channels — { position } return ──
  const kelt = calcKeltner(candles, 20, 2.0);
  let keltSig = 0;
  if (kelt.position >= 0.88) keltSig = -clamp((kelt.position - 0.88) / 0.12, 0, 1);
  else if (kelt.position <= 0.12) keltSig = clamp((0.12 - kelt.position) / 0.12, 0, 1);
  else keltSig = clamp(-(kelt.position - 0.5) * 0.45, -0.22, 0.22);

  // ── Trend Regime Modulation (mirrors backtest-runner.js) ──
  const isBullTrend = emaCross > 0.15 && adxR.pdi > adxR.mdi && adxR.adx > 22;
  const isBearTrend = emaCross < -0.15 && adxR.mdi > adxR.pdi && adxR.adx > 22;
  if (isBullTrend || isBearTrend) {
    const sf = clamp((adxR.adx - 22) / 28, 0, 0.70);
    if (isBullTrend) {
      if (rsiSig < 0) rsiSig *= (1 - sf);
      if (stochSig < 0) stochSig *= (1 - sf);
      if (wRSig < 0) wRSig *= (1 - sf);
      if (bandSig < 0) bandSig *= (1 - sf * 0.6);
      if (mfiSig < 0) mfiSig *= (1 - sf * 0.6);
    } else {
      if (rsiSig > 0) rsiSig *= (1 - sf);
      if (stochSig > 0) stochSig *= (1 - sf);
      if (wRSig > 0) wRSig *= (1 - sf);
      if (bandSig > 0) bandSig *= (1 - sf * 0.6);
      if (mfiSig > 0) mfiSig *= (1 - sf * 0.6);
    }
  }

  return {
    rsi: rsiSig, ema: emaSig, vwap: vwapSig, obv: obvSig, volume: volSig,
    momentum: momSig, bands: bandSig, persistence: persistence.signal, structure: structure.signal,
    macd: macdSig, stochrsi: stochSig, adx: adxSig, ichimoku: ichiSig, williamsR: wRSig, mfi: mfiSig,
    hma: hmaSig, vwma: vwmaSig, sma: smaSig,
    supertrend: supertrendSig, cci: cciSig, cmf: cmfSig, fisher: fisherSig, keltner: keltSig,
  };
}

// ── 10. gradeSignals ─────────────────────────────────────────────

/**
 * For each indicator key, computes:
 *   - winRate  : fraction of non-trivial signals (|val| > 0.15) that pointed the correct direction
 *   - total    : number of non-trivial signal observations used
 *   - avgSignal: mean signal value across all observations
 */
function gradeSignals(observations) {
  const stats = {};

  for (const obs of observations) {
    const target = obs.actualDirection === 'UP' ? 1 : -1;
    for (const [key, val] of Object.entries(obs.signalVector)) {
      if (typeof val !== 'number') continue;
      if (!stats[key]) stats[key] = { hits: 0, total: 0, sumVal: 0 };
      if (Math.abs(val) > 0.15) {
        stats[key].total++;
        if ((val > 0 && target > 0) || (val < 0 && target < 0)) stats[key].hits++;
      }
      stats[key].sumVal += val;
    }
  }

  const result = {};
  for (const [k, s] of Object.entries(stats)) {
    result[k] = {
      winRate: s.total > 0 ? s.hits / s.total : 0.5,
      total: s.total,
      avgSignal: observations.length > 0 ? s.sumVal / observations.length : 0,
    };
  }
  return result;
}

// ── 11. optimizeWeights ──────────────────────────────────────────

/**
 * Runs gradient descent (mini-batch, tanh loss) to find indicator
 * weights that maximise directional accuracy over `observations`.
 *
 * @param {Array}  observations — [{signalVector, actualDirection}]
 * @param {Object} initialBias  — starting weight map {key: number}
 * @param {Object} opts         — { learningRate, epochs, minW, maxW }
 * @returns {{ updatedWeights, initialAccuracy, finalAccuracy, epochLog }}
 */
function optimizeWeights(observations, initialBias, opts = {}) {
  const { learningRate = 0.008, epochs = 200, minW = 0.01, maxW = 10 } = opts;

  const weights = { ...initialBias };
  const keys = Object.keys(weights);

  const computeAccuracy = (W) => {
    let correct = 0;
    let scored = 0;
    for (const obs of observations) {
      let score = 0, totalW = 0;
      for (const k of keys) {
        const sig = obs.signalVector[k] ?? 0;
        score += sig * (W[k] ?? 1);
        totalW += Math.abs(W[k] ?? 1);
      }

      // Match live predictions.js: amplify + deadband, no phase inversion.
      let rawNorm = totalW > 0 ? score / totalW : 0;
      const SCORE_AMPLIFIER = 1.6;
      rawNorm = rawNorm * SCORE_AMPLIFIER;
      if (Math.abs(rawNorm) < 0.15) continue; // abstain — selective accuracy
      const predDir = rawNorm > 0 ? 'UP' : 'DOWN';
      if (predDir === obs.actualDirection) correct++;
      scored++;
    }
    return scored > 0 ? correct / scored : 0;
  };

  const initialAccuracy = computeAccuracy(weights);
  const epochLog = [];

  for (let epoch = 0; epoch < epochs; epoch++) {
    let totalLoss = 0;
    const grads = {};
    keys.forEach(k => { grads[k] = 0; });

    for (const obs of observations) {
      let score = 0, totalW = 0;
      for (const k of keys) {
        const sig = obs.signalVector[k] ?? 0;
        score += sig * (weights[k] ?? 1);
        totalW += Math.abs(weights[k] ?? 1);
      }

      const norm = totalW > 0 ? score / totalW : 0;
      const pred = Math.tanh(norm * 2.5);
      const target = obs.actualDirection === 'UP' ? 1 : -1;
      const loss = (pred - target) ** 2;
      totalLoss += loss;

      const dL = 2 * (pred - target);
      const dTanh = 1 - pred ** 2;
      const dNorm = dL * dTanh;

      for (const k of keys) {
        const sig = obs.signalVector[k] ?? 0;
        const dS = sig / (totalW || 1) - score * Math.sign(weights[k] ?? 1) / ((totalW || 1) ** 2);
        grads[k] += dNorm * dS;
      }
    }

    const N = Math.max(1, observations.length);
    for (const k of keys) {
      weights[k] = Math.max(minW, Math.min(maxW, weights[k] - learningRate * grads[k] / N));
    }

    if (epoch % 40 === 0 || epoch === epochs - 1) {
      const acc = computeAccuracy(weights);
      const logLine = `  Epoch ${String(epoch).padStart(3)}: loss=${(totalLoss / N).toFixed(4)}, acc=${(acc * 100).toFixed(1)}%`;
      epochLog.push(logLine);
      process.stdout.write(logLine + '\n');
    }
  }

  return { updatedWeights: weights, initialAccuracy, finalAccuracy: computeAccuracy(weights), epochLog };
}

// ── 12. printWeightTable ─────────────────────────────────────────

function printWeightTable(coin, oldW, newW, winRates, obsCount) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${coin} — Before → After  (${obsCount} market windows)`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  ${'Indicator'.padEnd(14)} ${'Old'.padStart(6)} → ${'New'.padStart(6)}  (${'Δ%'.padStart(7)})  Win-Rate  N-samples`);
  console.log(`  ${'─'.repeat(68)}`);

  const rows = Object.entries(newW).map(([k, nw]) => {
    const ow = oldW[k] ?? 1;
    const delta = ((nw - ow) / (Math.abs(ow) || 1)) * 100;
    const wr = winRates[k];
    const wrStr = wr ? `${(wr.winRate * 100).toFixed(1)}%`.padStart(7) : '   n/a';
    const nStr = wr ? String(wr.total).padStart(8) : '       n/a';
    const marker = !wr ? ''
      : wr.winRate >= 0.62 ? '  ★ TOP PERFORMER'
        : wr.winRate < 0.45 ? '  ✗ WORSE THAN CHANCE'
          : wr.winRate < 0.50 ? '  ↓ WEAK'
            : '';
    const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
    const changed = Math.abs(delta) > WRITE_CHANGE_THRESHOLD_PCT ? ' ◄' : '';
    return { k, ow, nw, delta, deltaStr, wrStr, nStr, marker, changed };
  }).sort((a, b) => (winRates[b.k]?.winRate ?? 0.5) - (winRates[a.k]?.winRate ?? 0.5));

  for (const r of rows) {
    console.log(`  ${r.k.padEnd(14)} ${r.ow.toFixed(3).padStart(6)} → ${r.nw.toFixed(3).padStart(6)}  (${r.deltaStr.padStart(7)})  ${r.wrStr}  ${r.nStr}${r.marker}${r.changed}`);
  }
  console.log(`${'═'.repeat(70)}`);
}

// ── 13. writeWeightsToPredictions ───────────────────────────────

/**
 * Surgically rewrites PER_COIN_INDICATOR_BIAS values in `filePath`
 * for `coin`, only updating keys that changed by more than the configured
 * write threshold so the live model actually receives the latest retune.
 * Adds an outcome-retuned comment on the coin's opening line.
 *
 * Uses brace-counting to isolate the exact coin block so sibling
 * coins are never affected.
 */
function writeWeightsToJSON(coin, oldWeights, newWeights, weightsPath, windowCount, dateStr) {
  // Guarded read: a corrupted/truncated weights file (this exact failure hit
  // live once already — a duplicate-key JSON error) used to throw uncaught
  // here, aborting the write phase for every remaining coin in the run after
  // the expensive backtest computation had already completed for all of
  // them. Now it's reported per-coin and the run continues.
  let json;
  try {
    json = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
  } catch (e) {
    console.error(`  [ERROR] ${coin}: could not read/parse ${weightsPath} — ${e.message}. Skipping write for this coin; fix the file and rerun.`);
    return 0;
  }
  if (!json.PER_COIN_INDICATOR_BIAS[coin]) {
    console.log(`  [WARN] ${coin} not found in predictions-weights.json — skipping`);
    return 0;
  }
  let updatedCount = 0;
  for (const [key, newVal] of Object.entries(newWeights)) {
    const oldVal = oldWeights[key];
    if (oldVal === undefined) continue;
    const changePct = Math.abs((newVal - oldVal) / (Math.abs(oldVal) || 1)) * 100;
    if (changePct <= WRITE_CHANGE_THRESHOLD_PCT) continue; // skip noise
    json.PER_COIN_INDICATOR_BIAS[coin][key] = parseFloat(newVal.toFixed(3));
    updatedCount++;
  }
  if (updatedCount > 0) {
    // Atomic write: write-to-temp then rename, so a process kill mid-write
    // (this environment killed several long-running runs this session)
    // can't leave weightsPath itself truncated/corrupted.
    const tmpPath = `${weightsPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(json, null, 2), 'utf8');
    fs.renameSync(tmpPath, weightsPath);
    console.log(`  [${coin}] Wrote ${updatedCount} updated weights to predictions-weights.json`);
  } else {
    console.log(`  [${coin}] No weights changed by >${WRITE_CHANGE_THRESHOLD_PCT}%, nothing written`);
  }
  return updatedCount;
}

// ── 14. main() ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let days = 60;
  let coinsArg = DEFAULT_COINS;
  let writeWeights = false;
  let testMode = false;
  let maxWindows = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') days = parseFloat(args[++i]);
    else if (args[i] === '--coins') coinsArg = args[++i].split(',');
    else if (args[i] === '--write-weights') writeWeights = true;
    else if (args[i] === '--test') testMode = true;
    else if (args[i] === '--max') maxWindows = parseInt(args[++i], 10);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const ROOT = path.resolve(__dirname, '..');
  const PREDS = path.join(ROOT, 'src', 'core', 'predictions.js');
  const BT = path.join(ROOT, 'backtest', 'backtest-runner.js');
  const LOG_DIR = path.join(ROOT, 'backtest-logs');
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`WECRYPTO Outcome Retuner — ${new Date().toISOString()}`);
  console.log(`Days: ${days}  Coins: ${coinsArg.join(',')}  WriteWeights: ${writeWeights}`);
  console.log(`${'═'.repeat(60)}\n`);

  // ── Load current PER_COIN_INDICATOR_BIAS from predictions-weights.json ──
  const WEIGHTS_PATH = path.join(ROOT, 'src', 'core', 'predictions-weights.json');
  let currentBias = {};
  try {
    const weightsJson = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
    currentBias = weightsJson.PER_COIN_INDICATOR_BIAS || {};
    console.log(`Loaded PER_COIN_INDICATOR_BIAS for: ${Object.keys(currentBias).join(', ')}`);
  } catch (e) {
    console.warn(`WARN: Could not load predictions-weights.json: ${e.message} — starting from flat weights`);
  }

  const allWindows = generateWindows(days);
  const useWindows = maxWindows
    ? allWindows.slice(Math.max(0, allWindows.length - maxWindows))
    : allWindows;
  console.log(`Generated ${allWindows.length} windows (${days} days) — using ${useWindows.length}${maxWindows ? ' (most recent windows)' : ''}\n`);

  // ── Test mode: verify connectivity and signal computation ──────
  if (testMode) {
    console.log('[TEST MODE] Verifying Binance connectivity with sample fetches...');
    for (const coin of coinsArg.slice(0, 1)) {
      const sym = SYMBOL_MAP[coin];
      const w = useWindows[Math.floor(useWindows.length / 2)];
      console.log(`  Window: ${new Date(w.startMs).toISOString()}`);

      const out = await fetchOutcome(sym, w.startMs);
      console.log(`  ${coin} sample outcome: ${out ? `${out.direction} (${out.pct.toFixed(3)}%)` : 'FAILED'}`);

      await sleep(300);

      const lb = await fetchLookback(sym, w.startMs);
      console.log(`  ${coin} lookback bars: ${lb ? lb.length : 'FAILED'}`);

      if (lb && lb.length >= 30) {
        try {
          const sv = computeSignalVector(lb);
          if (sv) {
            console.log(`  ${coin} signal vector keys (${Object.keys(sv).length}): ${Object.keys(sv).join(', ')}`);
            const sample = Object.entries(sv).slice(0, 8).map(([k, v]) => `${k}:${v.toFixed(2)}`).join('  ');
            console.log(`  Sample signals: ${sample}`);
            const nonZero = Object.values(sv).filter(v => Math.abs(v) > 0.05).length;
            console.log(`  Active signals (|val|>0.05): ${nonZero}/${Object.keys(sv).length}`);
          } else {
            console.log(`  ${coin} signal vector: NULL (not enough data)`);
          }
        } catch (e) {
          console.error(`  ${coin} computeSignalVector ERROR: ${e.message}`);
        }
      }
    }
    console.log('\n[TEST MODE COMPLETE] Run without --test to process all windows.\n');
    return;
  }

  // ── Main loop ──────────────────────────────────────────────────
  const results = {};
  const BATCH_SIZE = 50;

  for (const coin of coinsArg) {
    const sym = SYMBOL_MAP[coin];
    if (!sym) { console.log(`SKIP: No symbol map entry for ${coin}`); continue; }

    console.log(`\n── ${coin} (${sym}) — ${useWindows.length} windows ────────────────`);
    const observations = [];
    let fetched = 0, flat = 0, errors = 0, skipped = 0;

    for (let i = 0; i < useWindows.length; i++) {
      const win = useWindows[i];

      if (i > 0 && i % BATCH_SIZE === 0) {
        console.log(`  Progress: ${i}/${useWindows.length} — ${fetched} usable, ${flat} flat, ${errors} errors`);
      }

      // Rate-limit: 150ms minimum between requests (spec requirement)
      await sleep(150);
      const outcome = await fetchOutcome(sym, win.startMs);
      if (!outcome) { errors++; continue; }
      if (outcome.direction === 'FLAT') { flat++; continue; }

      await sleep(150);
      const candles = await fetchLookback(sym, win.startMs);
      if (!candles || candles.length < 30) { skipped++; continue; }

      let sigVec;
      try {
        sigVec = computeSignalVector(candles);
      } catch (e) {
        errors++;
        continue;
      }
      if (!sigVec) { skipped++; continue; }

      observations.push({
        coin,
        signalVector: sigVec,
        actualDirection: outcome.direction,
        windowStart: win.startMs,
        pct: outcome.pct,
      });
      fetched++;
    }

    console.log(`\n  ${coin} complete: ${fetched} usable windows, ${flat} flat (skipped), ${skipped} insufficient data, ${errors} fetch errors`);

    if (observations.length < 50) {
      console.log(`  SKIP optimization — need ≥50 observations, got ${observations.length}`);
      continue;
    }

    const winRates = gradeSignals(observations);

    // Merge existing bias with flat-1.0 defaults for any keys not previously tuned
    const bias = currentBias[coin] || {};
    const sampleSV = observations[0].signalVector;
    const fullBias = {
      ...Object.fromEntries(Object.keys(sampleSV).map(k => [k, 1.0])),
      ...bias,
    };

    console.log(`\n  Running gradient descent (200 epochs, ${observations.length} obs)...`);
    const optResult = optimizeWeights(observations, fullBias, { epochs: 200, learningRate: 0.008 });

    results[coin] = { optResult, winRates, obsCount: observations.length, oldBias: bias };

    printWeightTable(coin, bias, optResult.updatedWeights, winRates, observations.length);
    console.log(`\n  Accuracy: ${(optResult.initialAccuracy * 100).toFixed(1)}% → ${(optResult.finalAccuracy * 100).toFixed(1)}% (${((optResult.finalAccuracy - optResult.initialAccuracy) * 100).toFixed(1)}pp delta)`);
  }

  // ── Write JSON summary to backtest-logs/ ──────────────────────
  const summaryPath = path.join(LOG_DIR, `tuned-weights-market-${dateStr}.json`);
  const summary = {};
  for (const [coin, r] of Object.entries(results)) {
    summary[coin] = {
      observations: r.obsCount,
      initialAccuracy: r.optResult.initialAccuracy,
      finalAccuracy: r.optResult.finalAccuracy,
      winRates: r.winRates,
      updatedWeights: r.optResult.updatedWeights,
    };
  }
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\nSummary written: ${summaryPath}`);

  // ── Optionally write weights back to source files ─────────────
  if (writeWeights) {
    console.log('\n── Writing weights to source files ─────────────────────────');
    const { execSync } = require('child_process');

    for (const [coin, r] of Object.entries(results)) {
      writeWeightsToJSON(coin, r.oldBias, r.optResult.updatedWeights, WEIGHTS_PATH, r.obsCount, dateStr);
    }

    // Sync JSON → predictions.js + backtest-runner.js + regime-weights.js
    try {
      execSync(`node "${path.join(ROOT, 'scripts', 'sync-weights.js')}"`, { stdio: 'inherit', cwd: ROOT });
    } catch (e) {
      console.error('  sync-weights.js failed:', e.message);
    }
  }

  console.log('\n================ COMPLETE ================\n');
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
} else {
  module.exports = {
    SYMBOL_MAP,
    DEFAULT_COINS,
    computeSignalVector,
    generateWindows,
    fetchOutcome,
    fetchLookback,
    sleep,
    optimizeWeights,
    writeWeightsToJSON,
    // polymarket-retuner.js imports this under the old name — the actual
    // function was always writeWeightsToJSON; this shorthand property
    // referenced a non-existent variable and threw ReferenceError on
    // require() the moment this branch executed.
    writeWeightsToPredictions: writeWeightsToJSON,
    gradeSignals,
  };
}
