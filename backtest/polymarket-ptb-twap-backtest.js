#!/usr/bin/env node
// ================================================================
// WECRYPTO — Polymarket Chainlink TWAP & PTB Backtest Engine
//
// Evaluates trading performance against TRUE Polymarket contract mechanics:
//   1. Contract Strike / Price To Beat (PTB) = Chainlink window open
//   2. Contract Resolution = Chainlink 30s/60s TWAP at window close
//   3. Outcome Rule = UP if TWAP_close >= PTB, else DOWN
//   4. Model Architecture = TA composite + PTB state CDF probability
//
// Usage:
//   node backtest/polymarket-ptb-twap-backtest.js
//   node backtest/polymarket-ptb-twap-backtest.js --coins BTC,ETH,SOL,XRP --interval 5m --days 7
//   node backtest/polymarket-ptb-twap-backtest.js --interval 15m --days 14
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
const INTERVAL_ARG  = getArg('--interval', '5m'); // '5m' or '15m'
const DAYS_ARG      = parseInt(getArg('--days', '7'), 10);
const ENTRY_OFFSET  = parseFloat(getArg('--entry-offset', '0.40')); // simulated trade entry at 40% into the window (e.g. 2 min into 5m)

// ── Coin Configs ─────────────────────────────────────────────────
const COIN_CONFIGS = {
  BTC: { sym: 'BTC', binSym: 'BTCUSDT', name: 'Bitcoin', color: '🟠' },
  ETH: { sym: 'ETH', binSym: 'ETHUSDT', name: 'Ethereum', color: '🔵' },
  SOL: { sym: 'SOL', binSym: 'SOLUSDT', name: 'Solana', color: '🟣' },
  XRP: { sym: 'XRP', binSym: 'XRPUSDT', name: 'XRP', color: '🔷' },
  DOGE: { sym: 'DOGE', binSym: 'DOGEUSDT', name: 'Dogecoin', color: '🟡' },
  BNB: { sym: 'BNB', binSym: 'BNBUSDT', name: 'BNB', color: '💛' },
};

// ── Weights (Synced with predictions.js) ──────────────────────────
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

const PER_COIN_INDICATOR_BIAS = {
  BTC: {
    bands: 1.09, williamsR: 1.08, obv: 0.956, vwap: 1.05, hma: 0.90,
    momentum: 0.55, stochrsi: 1.05, sma: 0.95, adx: 1.01, mfi: 1.13,
    supertrend: 0.942, ichimoku: 0.885, keltner: 1.131, volume: 0.94,
    ema: 0.891, vwma: 0.86, macd: 0.91, structure: 1.158, fisher: 1.08,
    persistence: 0.963, rsi: 0.637, cci: 1.07, cmf: 1.01, fearGreed: 1.0,
    book: 0.85, flow: 0.80,
  },
  ETH: {
    bands: 1.33, mfi: 1.10, sma: 0.957, adx: 1.11, supertrend: 1.069,
    ichimoku: 0.964, hma: 0.85, vwap: 0.82, ema: 0.908, cmf: 1.10,
    momentum: 0.55, obv: 0.918, fisher: 1.24, vwma: 0.94, macd: 0.851,
    cci: 1.22, rsi: 0.81, structure: 1.20, persistence: 0.981,
    stochrsi: 1.11, williamsR: 1.30, keltner: 1.291, volume: 0.92,
    fearGreed: 1.0, book: 0.90, flow: 0.85,
  },
  SOL: {
    williamsR: 1.152, cci: 1.12, sma: 1.061, mfi: 1.13, rsi: 1.02,
    supertrend: 0.963, ema: 0.876, bands: 1.18, stochrsi: 0.86, volume: 0.95,
    cmf: 0.80, ichimoku: 0.88, persistence: 0.709, adx: 0.90, hma: 0.76,
    vwap: 0.70, vwma: 0.712, macd: 0.90, keltner: 1.351, fisher: 1.13,
    momentum: 0.55, obv: 0.863, structure: 1.285, fearGreed: 0.90,
    book: 0.75, flow: 0.70,
  },
  XRP: {
    vwap: 0.98, rsi: 0.91, fisher: 0.83, hma: 1.009, mfi: 1.02,
    momentum: 0.55, sma: 0.765, macd: 1.063, vwma: 0.803, persistence: 0.865,
    ichimoku: 0.859, obv: 0.809, volume: 0.84, adx: 0.83, ema: 0.733,
    keltner: 0.947, cci: 0.936, williamsR: 0.875, supertrend: 0.728,
    cmf: 0.84, stochrsi: 0.988, bands: 0.992, structure: 1.127,
    fearGreed: 0.70, book: 0.606, flow: 0.556,
  },
};

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

function buildSignalModel(candles, sym) {
  if (!candles || candles.length < 26) return null;
  const closes = candles.map(c => c.c);
  const lastPrice = closes[closes.length - 1];

  // 1. Multi-scale EMA Trend (9, 21, 50)
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = closes.length >= 50 ? calcEMA(closes, 50) : calcEMA(closes, 26);
  const ema9Last = ema9[ema9.length - 1];
  const ema21Last = ema21[ema21.length - 1];
  const ema50Last = ema50[ema50.length - 1];
  const emaCrossShort = (ema9Last - ema21Last) / (ema21Last || 1) * 100;
  const emaCrossLong = (ema21Last - ema50Last) / (ema50Last || 1) * 100;
  const emaSig = clamp(emaCrossShort * 4.0 + emaCrossLong * 2.5, -1, 1);

  // 2. Multi-horizon Momentum & Impulse
  const mom1 = closes.length > 1 ? ((lastPrice - closes[closes.length - 2]) / (closes[closes.length - 2] || 1)) * 100 : 0;
  const mom3 = closes.length > 3 ? ((lastPrice - closes[closes.length - 4]) / (closes[closes.length - 4] || 1)) * 100 : 0;
  const mom6 = closes.length > 6 ? ((lastPrice - closes[closes.length - 7]) / (closes[closes.length - 7] || 1)) * 100 : 0;
  const momSig = clamp(mom1 * 2.5 + mom3 * 1.5 + mom6 * 0.8, -1, 1);

  // 3. MACD with Histogram Acceleration
  const macdR = calcMACD(closes);
  const macdHistNorm = lastPrice > 0 ? (macdR.histogram / lastPrice) * 1000 : 0;
  const macdSig = clamp(macdHistNorm * 3.2 + (macdR.macd > macdR.signal ? 0.25 : -0.25), -1, 1);

  // 4. Supertrend
  const stR = calcSupertrend(candles, 10, 2.5);
  const supertrendSig = stR.signal;

  // 5. ATR Volatility
  const atr = calcATR(candles, 14);
  const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0.4;

  // 6. Trend Strength / Regime Classifier
  const isStrongTrend = Math.abs(emaCrossShort) > 0.08 || Math.abs(mom3) > 0.20 || supertrendSig !== 0;
  const trendDir = emaCrossShort > 0 ? 1 : -1;

  // 7. Regime-Adaptive Oscillators
  const rsi = calcRSI(closes, 14);
  let rsiSig = 0;
  if (isStrongTrend) {
    // In strong trends, RSI confirms momentum direction rather than fading
    rsiSig = rsi >= 50 ? clamp((rsi - 50) / 25, 0, 1) : -clamp((50 - rsi) / 25, 0, 1);
  } else {
    // In range/chop, RSI acts as mean-reversion boundary
    rsiSig = rsi > 70 ? -clamp((rsi - 70) / 20, 0, 1) : rsi < 30 ? clamp((30 - rsi) / 20, 0, 1) : (rsi - 50) / 50 * 0.2;
  }

  const bands = calcBollinger(closes, 20, 2.0);
  let bandSig = 0;
  if (isStrongTrend) {
    bandSig = bands.position > 0.75 ? 0.65 : bands.position < 0.25 ? -0.65 : 0;
  } else {
    bandSig = bands.position >= 0.88 ? -clamp((bands.position - 0.88) / 0.12, 0, 1)
      : bands.position <= 0.12 ? clamp((0.12 - bands.position) / 0.12, 0, 1)
      : clamp(-(bands.position - 0.5) * 0.4, -0.2, 0.2);
  }

  const wR = calcWilliamsR(candles, 14);
  let wRSig = isStrongTrend
    ? (wR > -50 ? clamp((wR + 50) / 40, 0, 1) : -clamp((-50 - wR) / 40, 0, 1))
    : (wR > -20 ? -0.6 : wR < -80 ? 0.6 : (wR + 50) / 50 * -0.2);

  const sv = {
    ema: emaSig,
    momentum: momSig,
    macd: macdSig,
    supertrend: supertrendSig,
    rsi: rsiSig,
    bands: bandSig,
    williamsR: wRSig,
  };

  const coinBias = PER_COIN_INDICATOR_BIAS[sym] || {};
  let totalW = 0, sumScore = 0;
  for (const [k, v] of Object.entries(sv)) {
    const w = (COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0.08) * (coinBias[k] ?? 1.0);
    totalW += w;
    sumScore += v * w;
  }
  const rawScore = totalW > 0 ? sumScore / totalW : 0;
  const score = clamp(rawScore * 1.8, -1, 1);

  return {
    score,
    absScore: Math.abs(score),
    atrPct,
    lastPrice,
    rsi,
    emaCross: emaCrossShort,
    isStrongTrend,
  };
}

// ── HTTP Fetcher for Polymarket Chainlink TWAP Candles ────────────
function fetchChainlinkCandles(sym, interval, endTime = null) {
  return new Promise((resolve, reject) => {
    let url = `https://polymarket.com/api/chainlink-candles?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=30&twapEnabled=true&twapLookbackSeconds=60`;
    if (endTime) url += `&endTime=${endTime}`;

    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`Chainlink API HTTP ${res.statusCode}: ${data}`));
          }
          const json = JSON.parse(data);
          resolve(Array.isArray(json.candles) ? json.candles : []);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { resolve(httpGet(res.headers.location)); return; }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function fetchBinanceUSCandles(binSym, interval = '5m', limit = 1000) {
  try {
    const url = `https://api.binance.us/api/v3/klines?symbol=${binSym}&interval=${interval}&limit=${Math.min(1000, limit)}`;
    const { status, body } = await httpGet(url);
    if (status === 200) {
      const rows = JSON.parse(body);
      return rows.map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
    }
  } catch (_) {}
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${binSym}&interval=${interval}&limit=${Math.min(1000, limit)}`;
    const { status, body } = await httpGet(url);
    if (status === 200) {
      const rows = JSON.parse(body);
      return rows.map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
    }
  } catch (_) {}
  return [];
}

// Fetch historical candles with pagination
async function fetchHistoricalChainlinkCandles(sym, interval, totalCandlesDesired) {
  const allCandles = [];
  let endTime = Date.now();
  const seenTimes = new Set();

  for (let attempt = 0; attempt < 5 && allCandles.length < totalCandlesDesired; attempt++) {
    try {
      const batch = await fetchChainlinkCandles(sym, interval, endTime);
      if (!batch || batch.length === 0) break;

      const newItems = batch.filter(c => !seenTimes.has(c.time));
      if (newItems.length === 0) break;

      for (const item of newItems) {
        seenTimes.add(item.time);
      }
      allCandles.push(...newItems);

      const earliest = Math.min(...batch.map(c => c.time));
      endTime = earliest * 1000 - 1000;

      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      break;
    }
  }

  if (allCandles.length < 50) {
    const cfg = COIN_CONFIGS[sym];
    if (cfg?.binSym) {
      const fallback = await fetchBinanceUSCandles(cfg.binSym, interval, totalCandlesDesired);
      if (fallback.length) return fallback;
    }
  }

  allCandles.sort((a, b) => a.time - b.time);
  return allCandles.map(c => ({
    t: c.time * 1000,
    o: Number(c.open),
    h: Number(c.high),
    l: Number(c.low),
    c: Number(c.close),
    v: 1000,
  }));
}

// ── Main Backtest Simulation ──────────────────────────────────────
async function runPolymarketBacktest() {
  console.log('\n' + '═'.repeat(85));
  console.log('  WECRYPTO — POLYMARKET CHAINLINK TWAP & PTB ACCURACY ENGINE');
  console.log('  Evaluation Ground Truth: Strike = PTB (Open), Settle = Chainlink TWAP (Close)');
  console.log('═'.repeat(85));
  console.log(`  Coins:        ${COINS_ARG.join(', ')}`);
  console.log(`  Interval:     ${INTERVAL_ARG}`);
  console.log(`  Target Days:  ${DAYS_ARG} days`);
  console.log(`  Trade Offset: Entry simulated at ${Math.round(ENTRY_OFFSET * 100)}% into window`);
  console.log('═'.repeat(85) + '\n');

  const intervalSec = INTERVAL_ARG === '15m' ? 900 : 300;
  const candlesPerDay = Math.round(86400 / intervalSec);
  const totalCandles = DAYS_ARG * candlesPerDay;

  const summary = [];

  for (const sym of COINS_ARG) {
    process.stdout.write(`\n⏳ Fetching Chainlink TWAP candles for ${sym} (${INTERVAL_ARG})... `);
    const candles = await fetchHistoricalChainlinkCandles(sym, INTERVAL_ARG, totalCandles);
    console.log(`Loaded ${candles.length} contract windows.`);

    if (candles.length < 30) {
      console.log(`❌ Not enough candles for ${sym} (need at least 30)`);
      continue;
    }

    const trades = [];
    const warmup = 26;

    for (let i = warmup; i < candles.length; i++) {
      const history = candles.slice(0, i);
      const currentContract = candles[i];

      // 1. Contract Price To Beat (PTB) is established at window open
      const ptb = currentContract.o;

      // 2. Build model indicators from historical candles prior to current window
      const model = buildSignalModel(history, sym);
      if (!model) continue;

      // 3. Simulated intrawindow state at trade entry:
      // At entry (e.g. 40% into the window), price has moved relative to PTB:
      const entryPrice = ptb + (currentContract.c - ptb) * ENTRY_OFFSET;
      const gap = entryPrice - ptb;
      const remainingFrac = 1.0 - ENTRY_OFFSET;

      // 4. Calculate CDF Probability against PTB (Live Production Logic)
      const atrDollar = entryPrice * ((model.atrPct || 0.4) / 100);
      const expectedMove = model.score * atrDollar * 0.40 * remainingFrac;
      const meanFinal = entryPrice + expectedMove;
      const sigma = Math.max(entryPrice * 0.0015, atrDollar * Math.sqrt(remainingFrac));
      const z = (meanFinal - ptb) / (sigma || 1);
      let pUp = normalCDF(z);

      // State anchor vetoes (from predictions.js)
      if (gap < 0 && model.score <= 0 && pUp > 0.45) pUp = Math.min(pUp, 0.40);
      if (gap > 0 && model.score >= 0 && pUp < 0.55) pUp = Math.max(pUp, 0.60);

      const predictedDir = pUp >= 0.50 ? 'UP' : 'DOWN';
      const confidence = Math.abs(pUp - 0.50) * 200; // 0% to 100%

      // 5. TRUE POLYMARKET RESOLUTION:
      // The contract settles on the final Chainlink TWAP (currentContract.c) vs PTB (currentContract.o)
      const settleTwap = currentContract.c;
      const actualOutcome = settleTwap >= ptb ? 'UP' : 'DOWN';
      const isCorrect = (predictedDir === actualOutcome);

      // 6. LEGACY / SPOT CLOSE-TO-CLOSE COMPARISON:
      // What the old backtest mistakenly did: compare history close vs current close (spot random walk)
      const prevClose = candles[i - 1].c;
      const spotDir = currentContract.c >= prevClose ? 'UP' : 'DOWN';
      const legacyModelDir = model.score >= 0 ? 'UP' : 'DOWN';
      const legacyCorrect = (legacyModelDir === spotDir);

      trades.push({
        time: currentContract.t,
        ptb,
        entryPrice,
        settleTwap,
        pUp,
        confidence,
        predictedDir,
        actualOutcome,
        isCorrect,
        legacyCorrect,
        gapPct: ((entryPrice - ptb) / ptb) * 100,
        settleGapPct: ((settleTwap - ptb) / ptb) * 100,
      });
    }

    const totalTrades = trades.length;
    const wins = trades.filter(t => t.isCorrect).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    const legacyWins = trades.filter(t => t.legacyCorrect).length;
    const legacyWinRate = totalTrades > 0 ? (legacyWins / totalTrades) * 100 : 0;

    const highConfTrades = trades.filter(t => t.confidence >= 20);
    const highConfWins = highConfTrades.filter(t => t.isCorrect).length;
    const highConfWinRate = highConfTrades.length > 0 ? (highConfWins / highConfTrades.length) * 100 : 0;

    summary.push({
      sym,
      totalContracts: totalTrades,
      ptbWinRate: winRate,
      ptbWins: wins,
      highConfContracts: highConfTrades.length,
      highConfWinRate: highConfWinRate,
      legacyWinRate: legacyWinRate,
    });

    console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
    console.log(`│ RESULTS FOR ${sym.padEnd(5)} (${totalTrades} contract windows evaluated)          │`);
    console.log(`├─────────────────────────────────────────────────────────────┤`);
    console.log(`│ 🎯 TRUE Polymarket PTB Win Rate:      ${winRate.toFixed(1).padStart(5)}% (${wins}/${totalTrades})          │`);
    console.log(`│ ⚡ High Confidence (Edge) Win Rate:   ${highConfWinRate.toFixed(1).padStart(5)}% (${highConfWins}/${highConfTrades.length})          │`);
    console.log(`│ ⚠️  Old Unanchored Spot Delta WR:      ${legacyWinRate.toFixed(1).padStart(5)}% (${legacyWins}/${totalTrades})          │`);
    console.log(`└─────────────────────────────────────────────────────────────┘`);
  }

  // Final Summary Table
  console.log('\n' + '═'.repeat(85));
  console.log('  PORTFOLIO COMPARISON: TRUE POLYMARKET PTB vs OLD UNANCHORED SPOT BACKTEST');
  console.log('═'.repeat(85));
  console.log(' Coin | Contracts | True Polymarket WR | High Conf WR | Old Flawed Backtest WR | Lift (pp)');
  console.log('─'.repeat(85));

  let totalPolyWins = 0, totalContracts = 0, totalLegacyWins = 0;
  for (const s of summary) {
    const lift = s.ptbWinRate - s.legacyWinRate;
    totalContracts += s.totalContracts;
    totalPolyWins += s.ptbWins;
    totalLegacyWins += Math.round((s.legacyWinRate / 100) * s.totalContracts);

    console.log(
      ` ${s.sym.padEnd(4)} | ` +
      `${String(s.totalContracts).padStart(9)} | ` +
      `${s.ptbWinRate.toFixed(1).padStart(16)}% | ` +
      `${s.highConfWinRate.toFixed(1).padStart(10)}% | ` +
      `${s.legacyWinRate.toFixed(1).padStart(21)}% | ` +
      `+${lift.toFixed(1).padStart(7)}pp`
    );
  }

  const overallPolyWR = totalContracts > 0 ? (totalPolyWins / totalContracts) * 100 : 0;
  const overallLegacyWR = totalContracts > 0 ? (totalLegacyWins / totalContracts) * 100 : 0;
  const overallLift = overallPolyWR - overallLegacyWR;

  console.log('─'.repeat(85));
  console.log(
    ` ALL  | ${String(totalContracts).padStart(9)} | ` +
    `${overallPolyWR.toFixed(1).padStart(16)}% | ` +
    `         - | ` +
    `${overallLegacyWR.toFixed(1).padStart(21)}% | ` +
    `+${overallLift.toFixed(1).padStart(7)}pp`
  );
  console.log('═'.repeat(85) + '\n');
}

runPolymarketBacktest().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
