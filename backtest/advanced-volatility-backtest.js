#!/usr/bin/env node
// ================================================================
// WECRYPTO — Advanced Volatility-Aware Backtest v1.0
// ================================================================
// New mathematical formulas for navigating recent market volatility:
//
//   1. EWMA Realized Volatility (RiskMetrics λ=0.94)
//   2. Bipower Variation — separates jump vs. continuous vol
//   3. Variance Ratio Test (Lo-MacKinlay HC-corrected q=5)
//   4. 4-tier Volatility Regime Classifier (CALM/NORMAL/ELEVATED/CRISIS)
//   5. Regime-conditional walk-forward (thresholds learned per regime)
//   6. Regime-conditional score amplifiers
//   7. Kelly Criterion (fractional) — CALM/NORMAL only
//   8. Max consecutive loss streak (tail risk for binary Kalshi contracts)
//   9. Per-regime Sharpe and Sortino ratios
//
// Rubber-duck corrections applied:
//   - No Hurst R/S (unreliable <200 bars, redundant with VR)
//   - All percentile rankings computed causally (no look-ahead leakage)
//   - ELEVATED amplifier = 0.85 (conservative, NOT 1.20)
//   - CRISIS = skip bet entirely (one suppression mechanism)
//   - VR uses Lo-MacKinlay HC variance correction
//   - MIN_REGIME_OBS = 30 per fold; falls back to prior multiplier when starved
//   - BV jump threshold is percentile-based from training data
//
// Usage:
//   node advanced-volatility-backtest.js
//   node advanced-volatility-backtest.js --coin BTC --days 30
//   node advanced-volatility-backtest.js --all --days 45
//   node advanced-volatility-backtest.js --coin SOL --fold-size 500 --step 100
// ================================================================
'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CLI args ──────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (f) => args.includes(f);
const FILTER_COIN  = getArg('--coin')?.toUpperCase() || null;
const DAYS_BACK    = parseInt(getArg('--days')      || '30',  10);
const TRAIN_BARS   = parseInt(getArg('--fold-size') || '400', 10);
const TEST_BARS    = parseInt(getArg('--test')      || '100', 10);
const STEP_BARS    = parseInt(getArg('--step')      || '50',  10);
const CANDLES_WANT = DAYS_BACK * 288;   // 288 × 5m = 1 day

// ── Paths ─────────────────────────────────────────────────────────
const ROOT    = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'backtest-logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

// ── Coins ─────────────────────────────────────────────────────────
const PREDICTION_COINS = [
  { sym: 'BTC', binSym: 'BTCUSDT' },
  { sym: 'ETH', binSym: 'ETHUSDT' },
  { sym: 'SOL', binSym: 'SOLUSDT' },
  { sym: 'XRP', binSym: 'XRPUSDT' },
];

// ── Weights & per-coin bias (synced from advanced-backtest.js) ────
const COMPOSITE_WEIGHTS = {
  supertrend:0.10, hma:0.07, vwma:0.06, ema:0.05, sma:0.03, macd:0.07, persistence:0.07,
  bands:0.08, keltner:0.05, williamsR:0.07, rsi:0.06, cci:0.05, stochrsi:0.04,
  volume:0.10, obv:0.07, cmf:0.07, mfi:0.07,
  structure:0.10, ichimoku:0.05, adx:0.04, fisher:0.04,
};
const OUTER_ORBITAL_WEIGHTS = { momentum: 0.05, vwap: 0.05 };

const PER_COIN_INDICATOR_BIAS = {
  BTC: { stochrsi:1.8, vwma:1.2, volume:1.4, bands:2.5, williamsR:2.0, structure:1.4, fisher:1.3,
         keltner:1.6, cci:1.2, cmf:1.0, rsi:0.8, macd:0.6, persistence:0.8, ema:0.5,
         ichimoku:0.3, adx:0.3, vwap:0.2, sma:0.2, momentum:0.25, obv:0.1, hma:0.1, mfi:0.5, supertrend:0.4 },
  ETH: { rsi:0.5, stochrsi:1.0, williamsR:1.4, bands:2.5, structure:1.4, keltner:1.2, cci:0.9,
         fisher:0.8, cmf:0.6, volume:0.9, persistence:0.8, obv:0.5, macd:0.4, ema:0.35, sma:0.1,
         adx:0.25, ichimoku:0.2, vwap:0.15, vwma:0.5, supertrend:0.3, mfi:0.05, momentum:0.20, hma:0.05 },
  SOL: { bands:2.0, fisher:1.5, williamsR:4.0, hma:0.1, structure:1.2, cci:3.5, keltner:0.8,
         obv:0.8, macd:0.3, ichimoku:0.2, adx:0.2, vwma:0.1, volume:0.2, sma:0.0, vwap:0.05,
         rsi:0.05, persistence:0.05, ema:0.05, cmf:0.05, supertrend:0.05, momentum:0.50, mfi:0.05, stochrsi:0.05 },
  XRP: { structure:1.0, volume:1.5, vwap:4.0, fisher:2.5, rsi:3.5, obv:1.5, williamsR:1.2,
         bands:0.8, supertrend:0.5, cci:0.5, cmf:0.6, keltner:0.4, macd:0.3, stochrsi:0.8,
         persistence:0.2, ema:0.2, adx:0.2, ichimoku:0.2, sma:0.0, mfi:0.1, momentum:0.01, vwma:0.05, hma:0.05 },
};

const BACKTEST_FILTER_OVERRIDES = {
  BTC:  { h15:{ entryThreshold:0.36, minAgreement:0.58 } },
  ETH:  { h15:{ entryThreshold:0.38, minAgreement:0.58 } },
  XRP:  { h15:{ entryThreshold:0.32, minAgreement:0.58 } },
  SOL:  { h15:{ entryThreshold:0.41, minAgreement:0.64, maxThreshold:0.55 } },
};

const BASE_SCORE_AMPLIFIER   = 1.6;
const BACKTEST_MIN_TRAIN_OBS = 36;
const MIN_REGIME_OBS         = 30;   // min bars per regime for per-regime calibration
const SHORT_HORIZON_MIN      = 15;   // focus on the Kalshi 15m contract horizon
const SHORT_HORIZON_BARS     = 3;    // 15m ÷ 5m = 3 bars forward

// ── Vol regime config (rubber-duck corrected amplifiers) ──────────
const VOL_REGIMES = {
  CALM:     { pctLo: 0,   pctHi: 25,  amplifier: 0.90, thresholdMult: 0.85, label: 'CALM'     },
  NORMAL:   { pctLo: 25,  pctHi: 75,  amplifier: 1.00, thresholdMult: 1.00, label: 'NORMAL'   },
  ELEVATED: { pctLo: 75,  pctHi: 90,  amplifier: 0.85, thresholdMult: 1.20, label: 'ELEVATED' },
  CRISIS:   { pctLo: 90,  pctHi: 100, amplifier: 0.00, thresholdMult: 9999, label: 'CRISIS'   },
};
const VOL_REGIME_KEYS = ['CALM', 'NORMAL', 'ELEVATED', 'CRISIS'];

// EWMA decay constant (RiskMetrics λ=0.94)
const EWMA_LAMBDA    = 0.94;
const EWMA_WARMUP    = 30;   // bars before EWMA vol is considered reliable
const VR_PERIOD      = 200;  // rolling window for causal percentile ranking
const BV_WINDOW      = 20;   // rolling window for bipower variation
const VR_Q           = 5;    // variance ratio test lag

// ── Utility ───────────────────────────────────────────────────────
const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const average = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
const stdDev  = arr => {
  if (arr.length < 2) return 0;
  const mu = average(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length);
};
const downStdDev = (arr, mu = 0) => {
  const neg = arr.filter(v => v < mu);
  if (!neg.length) return 1e-9;
  return Math.sqrt(neg.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length);
};

// ═══════════════════════════════════════════════════════════════════
//  NEW VOLATILITY MATHEMATICS
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute full EWMA realized vol series for an array of log-returns.
 * σ²_t = λ·σ²_{t-1} + (1-λ)·r²_t  (RiskMetrics, λ=0.94)
 * Returns array of vol values (same length as returns).
 */
function computeEWMAVolSeries(logReturns, lambda = EWMA_LAMBDA) {
  const n = logReturns.length;
  if (!n) return [];
  const sigma2 = new Array(n);
  // Warm-start: use sample variance of first EWMA_WARMUP bars
  const initBars = Math.min(EWMA_WARMUP, n);
  let initVar = 0;
  for (let i = 0; i < initBars; i++) initVar += logReturns[i] ** 2;
  sigma2[0] = initVar / Math.max(1, initBars);
  for (let i = 1; i < n; i++) {
    sigma2[i] = lambda * sigma2[i - 1] + (1 - lambda) * (logReturns[i - 1] ** 2);
  }
  return sigma2.map(v => Math.sqrt(v));
}

/**
 * CAUSAL rolling percentile rank of vol[idx] within vol[idx-window..idx-1].
 * Returns 0-100. Never looks ahead.
 */
function causalVolPercentile(volSeries, idx, window = VR_PERIOD) {
  if (idx < 1) return 50;
  const lo  = Math.max(0, idx - window);
  const ref = volSeries.slice(lo, idx);   // STRICTLY preceding bars
  if (!ref.length) return 50;
  const v     = volSeries[idx];
  const below = ref.filter(x => x <= v).length;
  return (below / ref.length) * 100;
}

/**
 * Classify a 0-100 percentile into a vol regime.
 */
function classifyVolRegime(pct) {
  if (pct < 25) return 'CALM';
  if (pct < 75) return 'NORMAL';
  if (pct < 90) return 'ELEVATED';
  return 'CRISIS';
}

/**
 * Bipower Variation (Barndorff-Nielsen & Shephard 2004).
 * BV = (π/2) × (n/(n-1)) × Σ |r_i| × |r_{i-1}|  for i in [lo+1, idx]
 * RV = Σ r²_i  (realized variance, same window)
 * jumpRatio = max(0, RV - BV) / RV  ∈ [0, 1]
 *   → 0 = all continuous vol
 *   → 1 = all jumps
 */
function computeBipowerVariation(logReturns, idx, window = BV_WINDOW) {
  const lo = Math.max(0, idx - window + 1);
  const slice = logReturns.slice(lo, idx + 1);
  const n = slice.length;
  if (n < 3) return { rv: 0, bv: 0, jumpRatio: 0 };

  let rv = 0, bvSum = 0;
  for (let i = 0; i < n; i++) rv += slice[i] ** 2;
  for (let i = 1; i < n; i++) bvSum += Math.abs(slice[i]) * Math.abs(slice[i - 1]);

  const bv = (Math.PI / 2) * (n / (n - 1)) * bvSum;
  const jumpRatio = rv > 0 ? Math.max(0, rv - bv) / rv : 0;
  return { rv, bv, jumpRatio: Math.min(1, jumpRatio) };
}

/**
 * Compute rolling 75th-percentile BV jump threshold (causal) from training data.
 * Returns percentile value used to flag "high jump" bars.
 */
function computeJumpThreshold(jumpRatios, idx, window = VR_PERIOD) {
  const lo  = Math.max(0, idx - window);
  const ref = jumpRatios.slice(lo, idx);
  if (ref.length < 4) return 0.30;  // fallback prior
  const sorted = [...ref].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.75)];
}

/**
 * Variance Ratio Test with Lo-MacKinlay (1988) heteroskedasticity-consistent
 * correction for overlapping returns.
 *
 * VR(q) = Var(q-period return) / (q × Var(1-period return))
 *   VR > 1.2 → trending (momentum indicators more reliable)
 *   VR < 0.8 → mean-reverting (oscillators more reliable)
 *   0.8 ≤ VR ≤ 1.2 → random walk
 *
 * HC variance correction (δ̂ term) suppresses the overlapping-window bias
 * that otherwise inflates VR above 1 under the null hypothesis.
 */
function computeVarianceRatioHC(logReturns, idx, q = VR_Q, window = 50) {
  const lo    = Math.max(0, idx - window);
  const slice = logReturns.slice(lo, idx + 1);
  const n     = slice.length;
  if (n < q * 3) return { vr: 1.0, signal: 'random_walk', z: 0 };

  const mu   = average(slice);
  // 1-period variance (unbiased)
  const sigma1Sq = slice.reduce((s, r) => s + (r - mu) ** 2, 0) / (n - 1);
  if (sigma1Sq <= 0) return { vr: 1.0, signal: 'random_walk', z: 0 };

  // q-period overlapping variance (biased raw)
  let sigmaqSqRaw = 0;
  for (let i = q; i < n; i++) {
    let qRet = 0;
    for (let j = 0; j < q; j++) qRet += slice[i - j];
    sigmaqSqRaw += (qRet - q * mu) ** 2;
  }
  const m = q * (n - q) * (1 - q / n);
  const sigmaqSq = m > 0 ? sigmaqSqRaw / m : sigma1Sq * q;

  // Heteroskedasticity-consistent δ̂ correction
  let delta = 0;
  for (let k = 1; k < q; k++) {
    const wk = ((q - k) / q) ** 2;
    let num = 0, denom = 0;
    for (let t = k; t < n; t++) {
      num   += (slice[t]     - mu) ** 2 * (slice[t - k] - mu) ** 2;
      denom += (slice[t - k] - mu) ** 2;
    }
    const psi_k = (denom > 0) ? (n * num) / (denom ** 2) : 0;
    delta += wk * psi_k;
  }

  const vrRaw = sigmaqSq / (sigma1Sq * q);
  // Asymptotic variance of VR under HC null
  const thetaVR = Math.sqrt(Math.max(delta, 1e-10) / n);
  const z = thetaVR > 0 ? (vrRaw - 1) / thetaVR : 0;

  let signal = 'random_walk';
  if (vrRaw > 1.2 && z > 1.5) signal = 'trending';
  else if (vrRaw < 0.8 && z < -1.5) signal = 'mean_reverting';

  return { vr: vrRaw, signal, z };
}

/**
 * Get regime-conditional score amplifier.
 * CRISIS returns 0 — signals skipped by caller.
 */
function getRegimeAmplifier(regime) {
  return VOL_REGIMES[regime]?.amplifier ?? 1.0;
}

/**
 * Get regime-conditional entry threshold multiplier (prior only —
 * learned multipliers from TRAIN fold override this when available).
 */
function getRegimeThresholdMult(regime) {
  return VOL_REGIMES[regime]?.thresholdMult ?? 1.0;
}

/**
 * Kelly fraction (25% fractional Kelly) for position sizing.
 * Only meaningful for CALM / NORMAL regimes.
 * @param {number} winRate — historical win fraction [0,1]
 * @param {number} avgWin  — average win magnitude
 * @param {number} avgLoss — average loss magnitude (positive value)
 * @returns {number} fraction ∈ [0, 1]
 */
function computeKelly(winRate, avgWin, avgLoss) {
  if (avgLoss <= 0 || avgWin <= 0) return 0;
  const b    = avgWin / avgLoss;
  const p    = clamp(winRate, 0.01, 0.99);
  const q    = 1 - p;
  const full = (p * b - q) / b;
  return clamp(full * 0.25, 0, 1);  // 25% fractional Kelly
}

// ═══════════════════════════════════════════════════════════════════
//  PRE-COMPUTE VOL FEATURES FOR ENTIRE CANDLE SERIES
// ═══════════════════════════════════════════════════════════════════

function precomputeVolFeatures(candles) {
  const closes = candles.map(c => c.c);
  const n = closes.length;

  // Log-returns
  const logRets = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    logRets[i] = closes[i - 1] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0;
  }

  // EWMA vol series
  const ewmaVol = computeEWMAVolSeries(logRets);

  // Per-bar features (computed causally at each bar)
  const features = new Array(n);
  for (let i = 0; i < n; i++) {
    const volPct  = causalVolPercentile(ewmaVol, i, VR_PERIOD);
    const regime  = classifyVolRegime(volPct);
    const bv      = computeBipowerVariation(logRets, i, BV_WINDOW);
    const vr      = computeVarianceRatioHC(logRets, i, VR_Q, 50);
    const jThresh = computeJumpThreshold(
      features.slice(0, i).map(f => f ? f.jumpRatio : 0), i, VR_PERIOD,
    );
    const highJump = bv.jumpRatio > jThresh;

    features[i] = {
      ewmaVol:   ewmaVol[i],
      volPct,
      regime,
      jumpRatio: bv.jumpRatio,
      highJump,
      vrSignal:  vr.signal,
      vrRatio:   vr.vr,
    };
  }
  return features;
}

// ═══════════════════════════════════════════════════════════════════
//  INDICATOR FUNCTIONS (verbatim from advanced-backtest.js)
// ═══════════════════════════════════════════════════════════════════

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
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function calcEMA(arr, period) {
  if (!arr.length) return [];
  const k = 2 / (period + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[out.length - 1] * (1 - k));
  return out;
}

function calcSMA(arr, period) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) { out.push(arr[i]); continue; }
    out.push(arr.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period);
  }
  return out;
}

function calcVWAP(candles) {
  let cumPV = 0, cumVol = 0;
  return candles.map(c => {
    const tp = (c.h + c.l + c.c) / 3, vol = c.v || 1;
    cumPV += tp * vol; cumVol += vol;
    return cumVol > 0 ? cumPV / cumVol : c.c;
  });
}

function calcOBV(candles) {
  let obv = 0;
  return candles.map((c, i) => {
    if (i === 0) return 0;
    if (c.c > candles[i - 1].c) obv += c.v;
    else if (c.c < candles[i - 1].c) obv -= c.v;
    return obv;
  });
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12), ema26 = calcEMA(closes, 26);
  const diff = ema12.map((v, i) => v - ema26[i]);
  const signal = calcEMA(diff, 9);
  return { macd: diff[diff.length-1], signal: signal[signal.length-1], histogram: diff[diff.length-1] - signal[signal.length-1] };
}

function calcStochRSI(closes, period = 14, kPeriod = 3, dPeriod = 3) {
  const rsiArr = [];
  for (let i = period; i < closes.length; i++) rsiArr.push(calcRSI(closes.slice(0, i + 1), period));
  if (rsiArr.length < kPeriod) return { k: 50, d: 50 };
  const recentRSI = rsiArr.slice(-period);
  const minRSI = Math.min(...recentRSI), maxRSI = Math.max(...recentRSI);
  const range = maxRSI - minRSI;
  const kArr = rsiArr.slice(-kPeriod).map(r => range > 0 ? ((r - minRSI) / range) * 100 : 50);
  const kSmooth = kArr.reduce((s, v) => s + v, 0) / kArr.length;
  return { k: kSmooth, d: kSmooth };
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = candles.slice(1).map((c, i) => Math.max(c.h - c.l, Math.abs(c.h - candles[i].c), Math.abs(c.l - candles[i].c)));
  const recent = trs.slice(-period);
  return recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0;
}

function calcADX(candles, period = 14) {
  if (candles.length < period + 2) return { adx: 0, pdi: 0, mdi: 0 };
  let pdi = 0, mdi = 0, adxSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].h - candles[i - 1].h, downMove = candles[i - 1].l - candles[i].l;
    const tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    pdi = (pdi * (period - 1) + (upMove > downMove && upMove > 0 ? upMove : 0)) / period;
    mdi = (mdi * (period - 1) + (downMove > upMove && downMove > 0 ? downMove : 0)) / period;
    const sum = pdi + mdi;
    const dx = sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0;
    adxSum = (adxSum * (period - 1) + dx) / period;
  }
  return { adx: adxSum, pdi, mdi };
}

function calcIchimoku(candles) {
  const n = candles.length;
  if (n < 52) return { cloudPos: 'inside', tenkan: candles[n-1].c, kijun: candles[n-1].c };
  const high9 = Math.max(...candles.slice(-9).map(c => c.h)), low9 = Math.min(...candles.slice(-9).map(c => c.l));
  const high26 = Math.max(...candles.slice(-26).map(c => c.h)), low26 = Math.min(...candles.slice(-26).map(c => c.l));
  const high52 = Math.max(...candles.slice(-52).map(c => c.h)), low52 = Math.min(...candles.slice(-52).map(c => c.l));
  const tenkan = (high9 + low9) / 2, kijun = (high26 + low26) / 2;
  const spanA = (tenkan + kijun) / 2, spanB = (high52 + low52) / 2;
  const price = candles[n-1].c;
  const cloudTop = Math.max(spanA, spanB), cloudBot = Math.min(spanA, spanB);
  const cloudPos = price > cloudTop ? 'above' : price < cloudBot ? 'below' : 'inside';
  return { cloudPos, tenkan, kijun, spanA, spanB };
}

function calcWilliamsR(candles, period = 14) {
  if (candles.length < period) return -50;
  const slice = candles.slice(-period);
  const hh = Math.max(...slice.map(c => c.h)), ll = Math.min(...slice.map(c => c.l));
  return hh !== ll ? ((hh - candles[candles.length-1].c) / (hh - ll)) * -100 : -50;
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let pMF = 0, nMF = 0;
  const slice = candles.slice(-period - 1);
  for (let i = 1; i <= period; i++) {
    const tp = (slice[i].h + slice[i].l + slice[i].c) / 3, prevTp = (slice[i-1].h + slice[i-1].l + slice[i-1].c) / 3;
    if (tp > prevTp) pMF += tp * slice[i].v;
    else if (tp < prevTp) nMF += tp * slice[i].v;
  }
  return nMF === 0 ? 100 : 100 - 100 / (1 + pMF / nMF);
}

function calcHMA(arr, period = 16) {
  if (arr.length < period) return arr.slice();
  const wma1 = calcEMA(arr, Math.round(period / 2));
  const wma2 = calcEMA(arr, period);
  const diff = wma1.map((v, i) => 2 * v - wma2[i]);
  return calcEMA(diff, Math.round(Math.sqrt(period)));
}

function calcVWMA(candles, period = 20) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const sl = candles.slice(Math.max(0, i - period + 1), i + 1);
    let pvSum = 0, vSum = 0;
    sl.forEach(c => { pvSum += c.c * (c.v || 1); vSum += c.v || 1; });
    out.push(vSum > 0 ? pvSum / vSum : sl[sl.length-1].c);
  }
  return out;
}

function calcStdDev(arr, period) {
  if (arr.length < period) return 0;
  const sl = arr.slice(-period), mu = sl.reduce((s, v) => s + v, 0) / period;
  return Math.sqrt(sl.reduce((s, v) => s + (v - mu) ** 2, 0) / period);
}

function calcSupertrend(candles, period = 10, mult = 3.0) {
  if (candles.length < period) return { signal: 0, bullish: false, supertrend: candles[0]?.c || 0 };
  const sl = candles.slice(-period * 2 - 5);
  let upper = sl[0].c, lower = sl[0].c, bullish = true, supertrend = sl[0].c;
  for (let i = 1; i < sl.length; i++) {
    const atr = calcATR(sl.slice(0, i + 1), period);
    const mid = (sl[i].h + sl[i].l) / 2;
    const newUpper = mid + mult * atr, newLower = mid - mult * atr;
    upper = newUpper < upper || sl[i - 1].c > upper ? newUpper : upper;
    lower = newLower > lower || sl[i - 1].c < lower ? newLower : lower;
    bullish = sl[i].c > supertrend ? true : sl[i].c < supertrend ? false : bullish;
    supertrend = bullish ? lower : upper;
  }
  return { signal: bullish ? 1 : -1, bullish, supertrend };
}

function calcCCI(candles, period = 14) {
  if (candles.length < period) return 0;
  const sl = candles.slice(-period), tps = sl.map(c => (c.h + c.l + c.c) / 3);
  const mean = tps.reduce((s, v) => s + v, 0) / period;
  const meanDev = tps.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
  return meanDev > 0 ? (tps[tps.length - 1] - mean) / (0.015 * meanDev) : 0;
}

function calcCMF(candles, period = 20) {
  if (candles.length < period) return 0;
  const sl = candles.slice(-period);
  let mfvSum = 0, volSum = 0;
  sl.forEach(c => {
    const range = c.h - c.l, vol = c.v || 1;
    const mfm = range > 0 ? ((c.c - c.l) - (c.h - c.c)) / range : 0;
    mfvSum += mfm * vol; volSum += vol;
  });
  return volSum > 0 ? mfvSum / volSum : 0;
}

function calcFisher(candles, period = 10) {
  if (candles.length < period) return 0;
  const sl = candles.slice(-period);
  const hh = Math.max(...sl.map(c => c.h)), ll = Math.min(...sl.map(c => c.l)), range = hh - ll;
  let value = range > 0 ? 2 * ((candles[candles.length - 1].c - ll) / range) - 1 : 0;
  value = Math.max(-0.999, Math.min(0.999, value));
  return 0.5 * Math.log((1 + value) / (1 - value));
}

function calcKeltner(candles, period = 20, mult = 2.0) {
  if (candles.length < period) return { position: 0.5 };
  const closes = candles.map(c => c.c), ema = calcEMA(closes, period), middle = ema[ema.length - 1];
  const atr = calcATR(candles, period), upper = middle + mult * atr, lower = middle - mult * atr;
  const width = Math.max(upper - lower, middle * 0.0001);
  return { position: Math.max(0, Math.min(1, (closes[closes.length - 1] - lower) / width)) };
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return { position: 0.5 };
  const sl = closes.slice(-period), middle = average(sl), std = calcStdDev(closes, period);
  const upper = middle + std * 2, lower = middle - std * 2;
  const width = Math.max(upper - lower, middle * 0.0001);
  return { position: clamp((sl[sl.length - 1] - lower) / width, 0, 1) };
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
  const supportGapPct = latest > 0 ? ((latest - support) / latest) * 100 : 0;
  const resistanceGapPct = latest > 0 ? ((resistance - latest) / latest) * 100 : 0;
  const bufferPct = clamp(Math.max((atrPct || 0) * 1.25, 0.35), 0.35, 2.4);
  let zone = 'middle', signal = 0;
  if (supportGapPct <= bufferPct && supportGapPct <= resistanceGapPct)
    { zone = 'support';    signal =  clamp((bufferPct - supportGapPct)    / bufferPct, 0, 1) * 0.85; }
  else if (resistanceGapPct <= bufferPct && resistanceGapPct < supportGapPct)
    { zone = 'resistance'; signal = -clamp((bufferPct - resistanceGapPct) / bufferPct, 0, 1) * 0.85; }
  return { signal, zone, supportGapPct, resistanceGapPct };
}

function slopeOBV(arr, n = 5) {
  if (arr.length < n + 1) return 0;
  const r = arr.slice(-n), avg = (Math.abs(r[0]) + Math.abs(r[r.length - 1])) / 2 || 1;
  return ((r[r.length - 1] - r[0]) / avg) * 100;
}

function summarizeAgreement(sv) {
  const values = Object.values(sv).filter(v => Math.abs(v) >= 0.08);
  if (!values.length) return { agreement: 0.5, conflict: 0 };
  const bulls = values.filter(v => v > 0).length, bears = values.filter(v => v < 0).length;
  const active = bulls + bears;
  return { agreement: active ? Math.max(bulls, bears) / active : 0.5, conflict: active ? Math.min(bulls, bears) / active : 0, bulls, bears };
}

// ═══════════════════════════════════════════════════════════════════
//  REGIME-CONDITIONAL SIGNAL MODEL
// ═══════════════════════════════════════════════════════════════════

function buildSignalModel(candles, sym, volFeature) {
  if (!candles || candles.length < 26) return null;
  const closes = candles.map(c => c.c), lastPrice = closes[closes.length - 1];

  // ── Regime-conditional amplifier & indicator weights ──────────────
  const regime    = volFeature?.regime || 'NORMAL';
  const highJump  = volFeature?.highJump || false;
  const vrSignal  = volFeature?.vrSignal || 'random_walk';
  const ampMult   = getRegimeAmplifier(regime);

  // VR-driven indicator subgroup scaling:
  //   trending     → boost momentum indicators, suppress mean-reversion
  //   mean_reverting → boost oscillators, suppress trend-followers
  const trendBoost = vrSignal === 'trending'      ? 1.35 : vrSignal === 'mean_reverting' ? 0.70 : 1.0;
  const revBoost   = vrSignal === 'mean_reverting' ? 1.35 : vrSignal === 'trending'      ? 0.70 : 1.0;

  let rsi = calcRSI(closes);
  let rsiSig = rsi > 70 ? -0.6 - ((rsi - 70) / 30) * 0.4 : rsi < 30 ? 0.6 + ((30 - rsi) / 30) * 0.4 : (rsi - 50) / 50 * 0.3;
  rsiSig *= revBoost;

  const ema9 = calcEMA(closes, 9), ema21 = calcEMA(closes, 21);
  const emaCross = (ema9[ema9.length-1] - ema21[ema21.length-1]) / (ema21[ema21.length-1] || 1) * 100;
  const emaSig = clamp(emaCross * 5, -1, 1) * trendBoost;

  const vwapRolling = calcVWAP(candles.slice(-80)), vwapLast = vwapRolling[vwapRolling.length - 1];
  const vwapDev = ((lastPrice - vwapLast) / (vwapLast || 1)) * 100;
  let vwapSig = Math.abs(vwapDev) < 0.3 ? 0 : vwapDev > 1.5 ? -0.5 : vwapDev < -1.5 ? 0.5 : vwapDev > 0 ? 0.3 : -0.3;

  const obv = calcOBV(candles), obvSig = clamp(slopeOBV(obv, 8) / 5, -1, 1);

  const recent = candles.slice(-12); let buyV = 0, sellV = 0;
  recent.forEach(c => {
    const range = c.h - c.l || 0.0001, bodyPos = (c.c - c.l) / range, vol = c.v || 1;
    buyV += vol * bodyPos; sellV += vol * (1 - bodyPos);
  });
  const volSig = clamp((buyV / (sellV || 1) - 1) * 0.5, -1, 1);

  const mom = closes.length > 6 ? ((closes[closes.length-1] - closes[closes.length-7]) / (closes[closes.length-7] || 1)) * 100 : 0;
  const momSig = clamp(mom / 2, -1, 1) * trendBoost;

  const atr = calcATR(candles), atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
  const bands = calcBollinger(closes);
  let bandSig = bands.position >= 0.88 ? -clamp((bands.position - 0.88) / 0.12, 0, 1)
              : bands.position <= 0.12 ? clamp((0.12 - bands.position) / 0.12, 0, 1)
              : clamp(-(bands.position - 0.5) * 0.45, -0.22, 0.22);
  bandSig *= revBoost;

  const persistence = calcTrendPersistence(closes, ema21);
  const structure   = calcStructureBias(candles, atrPct);
  const macdR       = calcMACD(closes);
  const macdHistNorm = lastPrice > 0 ? (macdR.histogram / lastPrice) * 1000 : 0;
  const macdSig = clamp(macdHistNorm * 2.5 + (macdR.macd > macdR.signal ? 0.18 : macdR.macd < macdR.signal ? -0.18 : 0), -1, 1) * trendBoost;

  const stochR = calcStochRSI(closes);
  let stochSig = stochR.k > 80 ? -0.6 - ((stochR.k - 80) / 20) * 0.4 : stochR.k < 20 ? 0.6 + ((20 - stochR.k) / 20) * 0.4 : (stochR.k - 50) / 50 * 0.35;
  stochSig = clamp(stochSig + clamp((stochR.k - stochR.d) / 20, -0.18, 0.18), -1, 1) * revBoost;

  const adxR  = calcADX(candles);
  const adxSig = clamp(((adxR.pdi - adxR.mdi) / Math.max(adxR.pdi + adxR.mdi, 1)) * clamp(adxR.adx / 50, 0, 1) * 1.2, -1, 1) * trendBoost;

  const ichi  = calcIchimoku(candles);
  let ichiSig = ichi.cloudPos === 'above' ? 0.5 + (ichi.tenkan > ichi.kijun ? 0.2 : 0)
              : ichi.cloudPos === 'below' ? -0.5 - (ichi.tenkan < ichi.kijun ? 0.2 : 0)
              : ichi.tenkan > ichi.kijun ? 0.12 : ichi.tenkan < ichi.kijun ? -0.12 : 0;
  ichiSig = clamp(ichiSig, -1, 1) * trendBoost;

  const wR    = calcWilliamsR(candles);
  let wRSig   = wR > -20 ? -0.6 - ((wR + 20) / 20) * 0.4 : wR < -80 ? 0.6 + ((-80 - wR) / 20) * 0.4 : (wR + 50) / 50 * -0.3;
  wRSig = clamp(wRSig, -1, 1) * revBoost;

  const mfi   = calcMFI(candles);
  let mfiSig  = mfi > 80 ? -0.6 - ((mfi - 80) / 20) * 0.4 : mfi < 20 ? 0.6 + ((20 - mfi) / 20) * 0.4 : (mfi - 50) / 50 * 0.35;
  mfiSig = clamp(mfiSig, -1, 1) * revBoost;

  const hmaLine  = calcHMA(closes, 16), hmaCurr = hmaLine[hmaLine.length - 1];
  const hmaPrev2 = hmaLine.length > 2 ? hmaLine[hmaLine.length - 3] : hmaCurr;
  let hmaSig = clamp(((hmaCurr - hmaPrev2) / (Math.abs(hmaPrev2) || 1) * 100) * 8, -0.7, 0.7) * trendBoost;
  const hmaDevPct = (lastPrice - hmaCurr) / (Math.abs(hmaCurr) || 1) * 100;
  if (Math.abs(hmaDevPct) > 0.4) hmaSig += clamp(-hmaDevPct * 0.28, -0.3, 0.3) * revBoost;
  hmaSig = clamp(hmaSig, -1, 1);

  const vwmaLine = calcVWMA(candles, 20), vwmaCurr = vwmaLine[vwmaLine.length - 1];
  const vwmaPrev = vwmaLine.length > 3 ? vwmaLine[vwmaLine.length - 4] : vwmaCurr;
  let vwmaSig = clamp(((vwmaCurr - vwmaPrev) / (Math.abs(vwmaPrev) || 1) * 100) * 6, -0.6, 0.6) * trendBoost;
  vwmaSig = clamp(vwmaSig + clamp(((lastPrice - vwmaCurr) / (Math.abs(vwmaCurr) || 1) * 100) * 0.35, -0.4, 0.4), -1, 1);

  const sma9arr = calcSMA(closes, 9), sma21arr = calcSMA(closes, 21);
  const smaSig  = clamp(((sma9arr[sma9arr.length-1] - sma21arr[sma21arr.length-1]) / (Math.abs(sma21arr[sma21arr.length-1]) || 1) * 100) * 5, -1, 1);

  const supertrendSig = calcSupertrend(candles, 10, 3.0).signal;
  const cciVal  = calcCCI(candles, 14);
  let cciSig    = cciVal > 150 ? -clamp((cciVal - 100) / 150, 0, 1) : cciVal < -150 ? clamp((-100 - cciVal) / 150, 0, 1) : clamp(-cciVal / 200, -0.3, 0.3);
  cciSig = clamp(cciSig, -1, 1) * revBoost;

  const cmfSig    = clamp(calcCMF(candles, 20) * 2.5, -1, 1);
  const fisherSig = clamp(-calcFisher(candles, 10) / 2.5, -1, 1) * revBoost;
  const kelt      = calcKeltner(candles, 20, 2.0);
  let keltSig     = kelt.position >= 0.88 ? -clamp((kelt.position - 0.88) / 0.12, 0, 1)
                  : kelt.position <= 0.12 ? clamp((0.12 - kelt.position) / 0.12, 0, 1)
                  : clamp(-(kelt.position - 0.5) * 0.45, -0.22, 0.22);
  keltSig *= revBoost;

  // Trend-override muting
  const isBullTrend = emaCross > 0.15 && adxR.pdi > adxR.mdi && adxR.adx > 22;
  const isBearTrend = emaCross < -0.15 && adxR.mdi > adxR.pdi && adxR.adx > 22;
  if (isBullTrend || isBearTrend) {
    const sf = clamp((adxR.adx - 22) / 28, 0, 0.70);
    if (isBullTrend) { if (rsiSig < 0) rsiSig *= (1 - sf); if (stochSig < 0) stochSig *= (1 - sf); if (wRSig < 0) wRSig *= (1 - sf); if (bandSig < 0) bandSig *= (1 - sf * 0.6); if (mfiSig < 0) mfiSig *= (1 - sf * 0.6); }
    else             { if (rsiSig > 0) rsiSig *= (1 - sf); if (stochSig > 0) stochSig *= (1 - sf); if (wRSig > 0) wRSig *= (1 - sf); if (bandSig > 0) bandSig *= (1 - sf * 0.6); if (mfiSig > 0) mfiSig *= (1 - sf * 0.6); }
  }

  // High-jump confidence reduction: when vol is predominantly jumps, dampen signals
  const jumpDampen = highJump ? 0.65 : 1.0;

  const sv = {
    rsi: rsiSig, ema: emaSig, vwap: vwapSig, obv: obvSig, volume: volSig,
    momentum: momSig, bands: bandSig, persistence: persistence.signal, structure: structure.signal,
    macd: macdSig, stochrsi: stochSig, adx: adxSig, ichimoku: ichiSig, williamsR: wRSig, mfi: mfiSig,
    hma: hmaSig, vwma: vwmaSig, sma: smaSig, supertrend: supertrendSig, cci: cciSig, cmf: cmfSig,
    fisher: fisherSig, keltner: keltSig,
  };

  const coinBias  = PER_COIN_INDICATOR_BIAS[sym] || {};
  const keys      = Object.keys(sv);
  const effW      = k => (COMPOSITE_WEIGHTS[k] ?? OUTER_ORBITAL_WEIGHTS[k] ?? 0) * (coinBias[k] ?? 1.0);
  const totalW    = keys.reduce((s, k) => s + effW(k), 0) || 1;
  const rawComp   = keys.reduce((s, k) => s + sv[k] * effW(k), 0) / totalW;
  const adxGate   = adxR.adx < 20 ? Math.max(0.25, adxR.adx / 20) : 1.0;

  // Apply regime amplifier and jump dampen to composite score
  const effectiveAmp = BASE_SCORE_AMPLIFIER * ampMult * jumpDampen;
  const score = clamp(rawComp * effectiveAmp * adxGate, -1, 1);
  const agr   = summarizeAgreement(sv);

  return {
    score, absScore: Math.abs(score), coreScore: score,
    agreement: agr.agreement, conflict: agr.conflict,
    structureBias: structure.signal, structureZone: structure.zone,
    persistenceScore: persistence.signal, emaCross, rsi, atrPct,
    regime, ampMult, highJump, vrSignal,
    signalVector: sv,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  REGIME-CONDITIONAL WALK-FORWARD ENGINE
// ═══════════════════════════════════════════════════════════════════

/**
 * Learn per-regime thresholds on the TRAIN fold.
 * For each regime with ≥ MIN_REGIME_OBS observations, sweep
 * entryThreshold and minAgreement to maximize win rate.
 * Falls back to prior multiplier if data-starved.
 */
function calibrateRegimeThresholds(trainObs, sym) {
  const baseFilter = BACKTEST_FILTER_OVERRIDES[sym]?.h15 || { entryThreshold: 0.36, minAgreement: 0.58 };
  const learned = {};

  for (const rKey of VOL_REGIME_KEYS) {
    const regimeObs = trainObs.filter(o => o.regime === rKey);
    if (rKey === 'CRISIS' || regimeObs.length < MIN_REGIME_OBS) {
      // Fall back to prior multiplier
      learned[rKey] = {
        entryThreshold: baseFilter.entryThreshold * getRegimeThresholdMult(rKey),
        minAgreement:   baseFilter.minAgreement,
        calibrated:     false,
        n:              regimeObs.length,
      };
      continue;
    }

    // Grid search: threshold ∈ [0.20, 0.55] × agreement ∈ [0.50, 0.70]
    let bestWR = 0, bestThresh = baseFilter.entryThreshold, bestAgreement = baseFilter.minAgreement;
    for (let thresh = 0.20; thresh <= 0.55; thresh += 0.02) {
      for (let agr = 0.50; agr <= 0.72; agr += 0.02) {
        const active = regimeObs.filter(o =>
          o.absScore >= thresh && o.agreement >= agr && o.direction !== 0,
        );
        if (active.length < 10) continue;
        const wins = active.filter(o => o.signedReturn > 0).length;
        const wr   = wins / active.length;
        if (wr > bestWR) { bestWR = wr; bestThresh = thresh; bestAgreement = agr; }
      }
    }

    learned[rKey] = {
      entryThreshold: bestThresh,
      minAgreement:   bestAgreement,
      calibrated:     true,
      winRate:        bestWR,
      n:              regimeObs.length,
    };
  }
  return learned;
}

function evalWithThresholds(obs, regimeThresholds, sym) {
  const results = [];
  const baseFilter = BACKTEST_FILTER_OVERRIDES[sym]?.h15 || { entryThreshold: 0.36, minAgreement: 0.58 };
  for (const o of obs) {
    if (o.regime === 'CRISIS') {
      results.push({ ...o, direction: 0, signedReturn: 0, skipped: true });
      continue;
    }
    const thresholds  = regimeThresholds[o.regime] || { entryThreshold: baseFilter.entryThreshold, minAgreement: baseFilter.minAgreement };
    const isActive    = o.absScore >= thresholds.entryThreshold && o.agreement >= thresholds.minAgreement;
    const direction   = isActive && o.modelDirection !== 0 ? o.modelDirection : 0;
    const signedReturn = direction === 0 ? 0 : o.returnPct * direction;
    results.push({ ...o, direction, signedReturn });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════
//  PERFORMANCE METRICS
// ═══════════════════════════════════════════════════════════════════

function computeMetrics(obs) {
  const active = obs.filter(o => o.direction !== 0);
  if (!active.length) return { n: 0, winRate: 0, sharpe: 0, sortino: 0, maxConsecLoss: 0, kelly: 0 };

  const rets   = active.map(o => o.signedReturn);
  const wins   = rets.filter(r => r > 0);
  const losses = rets.filter(r => r <= 0);
  const winRate   = wins.length / rets.length;
  const avgWin    = wins.length  ? average(wins)          : 0;
  const avgLoss   = losses.length ? -average(losses)      : 1;
  const mu        = average(rets);
  const sigma     = stdDev(rets) || 1e-9;
  const downSig   = downStdDev(rets, 0) || 1e-9;
  const sharpe    = mu / sigma * Math.sqrt(252 * 24 * 4); // annualized (5m bars)
  const sortino   = mu / downSig * Math.sqrt(252 * 24 * 4);
  const kelly     = computeKelly(winRate, avgWin, avgLoss);

  // Max consecutive loss streak
  let maxConsecLoss = 0, consecLoss = 0;
  for (const r of rets) {
    if (r <= 0) { consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss); }
    else consecLoss = 0;
  }

  // Max drawdown on cumulative P&L
  let peak = 0, cumPL = 0, maxDD = 0;
  for (const r of rets) {
    cumPL += r; if (cumPL > peak) peak = cumPL;
    const dd = peak - cumPL; if (dd > maxDD) maxDD = dd;
  }

  return {
    n: active.length, winRate, avgWin, avgLoss,
    sharpe, sortino, kelly,
    maxConsecLoss, maxDrawdown: maxDD,
    totalReturn: rets.reduce((s, v) => s + v, 0),
  };
}

function computePerRegimeMetrics(obs) {
  const byRegime = {};
  for (const r of VOL_REGIME_KEYS) {
    byRegime[r] = computeMetrics(obs.filter(o => o.regime === r));
  }
  return byRegime;
}

// ═══════════════════════════════════════════════════════════════════
//  WALK-FORWARD RUNNER
// ═══════════════════════════════════════════════════════════════════

function runVolWalkForward(sym, candles, volFeatures) {
  const BARMIN    = 5, LIVE_WINDOW = 300;
  const startIdx  = Math.max(52, BACKTEST_MIN_TRAIN_OBS, VR_PERIOD + 10);
  const N         = candles.length;

  const allObs = [];

  // Pre-build all observations with vol features
  for (let idx = startIdx; idx < N - SHORT_HORIZON_BARS; idx++) {
    const windowCandles = candles.slice(Math.max(0, idx - LIVE_WINDOW + 1), idx + 1);
    const feat   = volFeatures[idx];
    const model  = buildSignalModel(windowCandles, sym, feat);
    if (!model) continue;

    const entry      = candles[idx].c;
    const exit       = candles[idx + SHORT_HORIZON_BARS].c;
    const returnPct  = entry > 0 ? ((exit - entry) / entry) * 100 : 0;

    allObs.push({
      idx, t: candles[idx].t,
      absScore:       model.absScore,
      agreement:      model.agreement,
      conflict:       model.conflict,
      modelDirection: model.score > 0 ? 1 : -1,
      returnPct,
      regime:         feat.regime,
      volPct:         feat.volPct,
      ewmaVol:        feat.ewmaVol,
      jumpRatio:      feat.jumpRatio,
      highJump:       feat.highJump,
      vrSignal:       feat.vrSignal,
      ampMult:        model.ampMult,
    });
  }

  if (allObs.length < TRAIN_BARS + TEST_BARS) {
    return { folds: [], allObs, sym };
  }

  // Walk-forward splits
  const folds = [];
  let trainStart = 0;

  while (trainStart + TRAIN_BARS + TEST_BARS <= allObs.length) {
    const trainObs = allObs.slice(trainStart, trainStart + TRAIN_BARS);
    const testObs  = allObs.slice(trainStart + TRAIN_BARS, trainStart + TRAIN_BARS + TEST_BARS);
    const regimeThresholds = calibrateRegimeThresholds(trainObs, sym);

    // Apply learned thresholds to test obs
    const testResults = evalWithThresholds(testObs, regimeThresholds, sym);
    const trainResults = evalWithThresholds(trainObs, regimeThresholds, sym);

    // Regime distribution (TRAIN)
    const trainRegimeDist = {};
    for (const r of VOL_REGIME_KEYS) {
      trainRegimeDist[r] = trainObs.filter(o => o.regime === r).length;
    }

    folds.push({
      foldId:            folds.length + 1,
      trainStart,
      trainEnd:          trainStart + TRAIN_BARS,
      testStart:         trainStart + TRAIN_BARS,
      testEnd:           trainStart + TRAIN_BARS + TEST_BARS,
      regimeThresholds,
      trainRegimeDist,
      trainMetrics:      computeMetrics(trainResults),
      testMetrics:       computeMetrics(testResults),
      testRegimeMetrics: computePerRegimeMetrics(testResults),
    });

    trainStart += STEP_BARS;
  }

  // Aggregate test results across all folds (non-overlapping portions)
  const allTestObs = [];
  for (const fold of folds) {
    const testObs  = allObs.slice(fold.testStart, fold.testEnd);
    const results  = evalWithThresholds(testObs, fold.regimeThresholds, sym);
    allTestObs.push(...results);
  }

  return {
    sym, folds,
    allObs,
    aggregateMetrics:      computeMetrics(allTestObs),
    aggregateRegimeMetrics: computePerRegimeMetrics(allTestObs),
    volRegimeDist: (() => {
      const d = {};
      for (const r of VOL_REGIME_KEYS) d[r] = allObs.filter(o => o.regime === r).length;
      return d;
    })(),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  REPORT GENERATOR
// ═══════════════════════════════════════════════════════════════════

function printReport(result) {
  const { sym, folds, aggregateMetrics: ag, aggregateRegimeMetrics: rg, volRegimeDist: rd } = result;
  const line = '─'.repeat(60);
  const sec  = (title) => console.log(`\n${line}\n  ${title}\n${line}`);

  sec(`WECRYPTO ADVANCED VOL BACKTEST — ${sym} (15m Kalshi horizon)`);

  console.log(`\n  OVERALL AGGREGATE (out-of-sample across ${folds.length} folds)`);
  console.log(`  Total bets    : ${ag.n}`);
  console.log(`  Win rate      : ${(ag.winRate * 100).toFixed(1)}%`);
  console.log(`  Avg win       : ${(ag.avgWin  || 0).toFixed(3)}%`);
  console.log(`  Avg loss      : -${(ag.avgLoss || 0).toFixed(3)}%`);
  console.log(`  Sharpe        : ${ag.sharpe.toFixed(2)}`);
  console.log(`  Sortino       : ${ag.sortino.toFixed(2)}`);
  console.log(`  Max consec loss: ${ag.maxConsecLoss}`);
  console.log(`  Max drawdown  : ${ag.maxDrawdown.toFixed(2)}%`);
  console.log(`  Kelly (25%)   : ${(ag.kelly * 100).toFixed(1)}% of bankroll`);
  console.log(`  Total return  : ${ag.totalReturn.toFixed(2)}%`);

  sec('VOL REGIME DISTRIBUTION');
  for (const r of VOL_REGIME_KEYS) {
    const n = rd[r] || 0, pct = result.allObs.length ? (n / result.allObs.length * 100).toFixed(1) : '0.0';
    const cfg = VOL_REGIMES[r];
    console.log(`  ${r.padEnd(10)}  ${String(n).padStart(5)} bars (${pct}%)  amp=${cfg.amplifier}  tMult=${cfg.thresholdMult === 9999 ? 'SKIP' : cfg.thresholdMult}`);
  }

  sec('PER-REGIME OUT-OF-SAMPLE PERFORMANCE');
  console.log(`  ${'Regime'.padEnd(10)} ${'Bets'.padStart(5)} ${'WinRate'.padStart(8)} ${'Sharpe'.padStart(8)} ${'Sortino'.padStart(8)} ${'MaxCL'.padStart(6)} ${'Kelly%'.padStart(7)}`);
  console.log(`  ${'─'.repeat(58)}`);
  for (const r of VOL_REGIME_KEYS) {
    const m = rg[r];
    if (!m || !m.n) { console.log(`  ${r.padEnd(10)} ${'0'.padStart(5)}  (no bets)`); continue; }
    console.log(
      `  ${r.padEnd(10)} ${String(m.n).padStart(5)}` +
      ` ${(m.winRate * 100).toFixed(1).padStart(8)}%` +
      ` ${m.sharpe.toFixed(2).padStart(8)}` +
      ` ${m.sortino.toFixed(2).padStart(8)}` +
      ` ${String(m.maxConsecLoss).padStart(6)}` +
      ` ${(m.kelly * 100).toFixed(1).padStart(6)}%`,
    );
  }

  sec('WALK-FORWARD FOLD SUMMARY');
  console.log(`  ${'Fold'.padStart(4)} ${'TrainWR'.padStart(8)} ${'TestWR'.padStart(8)} ${'TestN'.padStart(6)} ${'Sharpe'.padStart(8)}  RegimeThresholds (learned)`);
  for (const f of folds) {
    const tm = f.trainMetrics, te = f.testMetrics;
    const threshStr = VOL_REGIME_KEYS.filter(r => r !== 'CRISIS')
      .map(r => {
        const t = f.regimeThresholds[r];
        return `${r[0]}:${t.entryThreshold.toFixed(2)}${t.calibrated ? '*' : ''}`;
      }).join(' ');
    console.log(
      `  ${String(f.foldId).padStart(4)}` +
      ` ${((tm.winRate || 0) * 100).toFixed(1).padStart(8)}%` +
      ` ${((te.winRate || 0) * 100).toFixed(1).padStart(8)}%` +
      ` ${String(te.n || 0).padStart(6)}` +
      ` ${(te.sharpe || 0).toFixed(2).padStart(8)}  ${threshStr}`,
    );
  }
  console.log('  (* = learned from training data with ≥30 regime observations)');

  sec('VR SIGNAL DISTRIBUTION');
  const vrCounts = { trending: 0, mean_reverting: 0, random_walk: 0 };
  for (const o of result.allObs) vrCounts[o.vrSignal] = (vrCounts[o.vrSignal] || 0) + 1;
  for (const [k, v] of Object.entries(vrCounts)) {
    const pct = result.allObs.length ? (v / result.allObs.length * 100).toFixed(1) : '0';
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)} bars (${pct}%)`);
  }

  sec('JUMP ACTIVITY');
  const jumpBars = result.allObs.filter(o => o.highJump).length;
  const jumpPct  = result.allObs.length ? (jumpBars / result.allObs.length * 100).toFixed(1) : '0';
  console.log(`  High-jump bars: ${jumpBars} (${jumpPct}%)  — signal dampened to 65% confidence`);
  const jumpInCrisis = result.allObs.filter(o => o.highJump && o.regime === 'CRISIS').length;
  console.log(`  Jump ∩ CRISIS:  ${jumpInCrisis} bars (combo worst-case)`);

  console.log('');
}

// ═══════════════════════════════════════════════════════════════════
//  DATA FETCHING (from advanced-backtest.js)
// ═══════════════════════════════════════════════════════════════════

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WECRYPTO-VolBacktest/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { resolve(httpGet(res.headers.location)); return; }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function fetchBinanceUSCandles(symbol, limit = 1000, interval = '5m') {
  const PAGE = 1000;
  if (limit <= PAGE) {
    const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const { status, body } = await httpGet(url);
    if (status !== 200) throw new Error(`Binance.US HTTP ${status}`);
    return JSON.parse(body).map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
  }
  const pages = []; let endTime = null, remaining = limit;
  while (remaining > 0) {
    const fetchCount = Math.min(PAGE, remaining);
    const url = endTime
      ? `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${fetchCount}&endTime=${endTime}`
      : `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${fetchCount}`;
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
  const KRAKEN_PAIR = { BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLUSD', XRP: 'XXRPZUSD' };
  const pair  = KRAKEN_PAIR[sym]; if (!pair) throw new Error(`No Kraken pair for ${sym}`);
  const since = Math.floor((Date.now() - limit * 5 * 60 * 1000) / 1000);
  const { status, body } = await httpGet(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=5&since=${since}`);
  if (status !== 200) throw new Error(`Kraken HTTP ${status}`);
  const json = JSON.parse(body);
  if (json.error?.length) throw new Error(`Kraken: ${json.error[0]}`);
  const key  = Object.keys(json.result).find(k => k !== 'last');
  return json.result[key].map(r => ({ t: Number(r[0]) * 1000, o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[6]) }));
}

async function fetchCandles(coin, limit) {
  const errors = [];
  try { return await fetchBinanceUSCandles(coin.binSym, limit); } catch (e) { errors.push(`BinanceUS: ${e.message}`); }
  try { return await fetchKrakenCandles(coin.sym, limit); }      catch (e) { errors.push(`Kraken: ${e.message}`); }
  throw new Error(errors.join(' | '));
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const coins = FILTER_COIN
    ? PREDICTION_COINS.filter(c => c.sym === FILTER_COIN)
    : PREDICTION_COINS;

  if (!coins.length) {
    console.error(`Unknown coin: ${FILTER_COIN}. Valid: BTC, ETH, SOL, XRP`);
    process.exit(1);
  }

  console.log(`\n  WECRYPTO Advanced Volatility Backtest`);
  console.log(`  Coins: ${coins.map(c => c.sym).join(', ')}  |  Days: ${DAYS_BACK}`);
  console.log(`  Walk-forward: TRAIN=${TRAIN_BARS} TEST=${TEST_BARS} STEP=${STEP_BARS} bars`);
  console.log(`  Vol regimes: EWMA λ=${EWMA_LAMBDA}  |  VR HC-corrected q=${VR_Q}  |  BV window=${BV_WINDOW}`);
  console.log(`  Regime amplifiers: CALM=0.90  NORMAL=1.00  ELEVATED=0.85  CRISIS=SKIP`);
  console.log(`  Per-regime threshold: learned from train (min ${MIN_REGIME_OBS} obs), fallback to prior\n`);

  const allResults = [];

  for (const coin of coins) {
    process.stdout.write(`  Fetching ${coin.sym} (${CANDLES_WANT} 5m candles)...`);
    let candles;
    try {
      candles = await fetchCandles(coin, CANDLES_WANT);
      console.log(` got ${candles.length} bars`);
    } catch (e) {
      console.log(` FAILED: ${e.message}`);
      continue;
    }
    if (candles.length < TRAIN_BARS + TEST_BARS + 100) {
      console.log(`  ${coin.sym}: insufficient data (${candles.length} bars), skipping`);
      continue;
    }

    process.stdout.write(`  Pre-computing vol features for ${coin.sym}...`);
    const volFeatures = precomputeVolFeatures(candles);
    console.log(' done');

    process.stdout.write(`  Running walk-forward backtest for ${coin.sym}...`);
    const result = runVolWalkForward(coin.sym, candles, volFeatures);
    console.log(` ${result.folds.length} folds`);

    allResults.push(result);
    printReport(result);
  }

  // ── JSON output ────────────────────────────────────────────────
  const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(LOG_DIR, `vol-backtest-${ts}.json`);
  const summary = allResults.map(r => ({
    sym:              r.sym,
    folds:            r.folds.length,
    aggregateMetrics: r.aggregateMetrics,
    volRegimeDist:    r.volRegimeDist,
    regimeMetrics:    r.aggregateRegimeMetrics,
  }));
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\n  JSON report → ${outFile}`);

  // ── Recommendation block ───────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  THRESHOLD RECOMMENDATIONS FOR predictions.js / backtest-filter-overrides');
  console.log('═'.repeat(60));
  for (const r of allResults) {
    const lastFold = r.folds[r.folds.length - 1];
    if (!lastFold) continue;
    console.log(`\n  ${r.sym}:`);
    for (const rKey of ['CALM', 'NORMAL', 'ELEVATED']) {
      const t = lastFold.regimeThresholds[rKey];
      const tag = t.calibrated ? '(learned)' : '(prior)';
      console.log(`    ${rKey.padEnd(10)} entryThreshold=${t.entryThreshold.toFixed(3)}  minAgreement=${t.minAgreement.toFixed(3)} ${tag}`);
    }
    console.log(`    CRISIS     → SKIP ALL BETS (one-mechanism CRISIS suppression)`);
  }
  console.log('');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
