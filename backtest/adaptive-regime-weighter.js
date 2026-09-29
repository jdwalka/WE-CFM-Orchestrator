#!/usr/bin/env node
// ================================================================
// WECRYPTO Adaptive Regime Weighter — Live Market Snapshot
//
// Analyzes real-time 2h BTC snapshot, detects market regime,
// and auto-switches indicator weights based on:
//   - Volatility (ATR-based)
//   - Trend strength (ADX)
//   - Mean reversion vs momentum (RSI/MACD state)
//   - Liquidity/velocity (Volume Profile)
//
// Generates regime-specific PER_COIN_INDICATOR_BIAS tuning
// ================================================================
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Utility helpers ─────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const average = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
const stdDev = arr => {
  if (arr.length < 2) return 0;
  const m = average(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
};

// ── Market Snapshot Analyzer ────────────────────────────────────

function analyzeSnapshot(candles) {
  if (candles.length < 4) throw new Error('Need at least 4 candles');

  const closes = candles.map(c => Number(c[4]));
  const highs = candles.map(c => Number(c[2]));
  const lows = candles.map(c => Number(c[3]));
  const volumes = candles.map(c => Number(c[7]));

  // ── 1. Volatility Regime (via ATR) ──────────────────────
  const atr = calcATR(candles.slice(-14));
  const percent_atr = (atr / closes[closes.length - 1]) * 100;
  const vol_regime = percent_atr < 0.3 ? 'low' : percent_atr < 0.6 ? 'medium' : 'high';

  // ── 2. Trend Strength (via ADX + RSI) ────────────────────
  const adx_val = calcADX(candles.slice(-14));
  const rsi_val = calcRSI(closes);
  const trend_regime = adx_val.adx > 35 ? 'strong_trend' : adx_val.adx < 25 ? 'ranging' : 'moderate_trend';
  const rsi_state = rsi_val > 70 ? 'overbought' : rsi_val < 30 ? 'oversold' : 'neutral';

  // ── 3. Momentum vs Mean Reversion (via MACD + price action) ─
  const macd = calcMACD(closes);
  const momentum_score = macd.histogram > 0 ? 1 : -1;
  const price_pos = (closes[closes.length - 1] - average(closes)) / stdDev(closes);
  const mean_reversion_score = price_pos > 1.5 ? -1 : price_pos < -1.5 ? 1 : 0;

  // ── 4. Volume Profile ───────────────────────────────────────
  const avg_vol = average(volumes);
  const curr_vol = volumes[volumes.length - 1];
  const vol_ratio = curr_vol / avg_vol;
  const vol_state = vol_ratio > 1.5 ? 'high_vol_breakout' : vol_ratio < 0.7 ? 'low_vol_consolidation' : 'normal_vol';

  // ── 5. Intrabar structure (wick, body, close position) ───────
  const last_close = closes[closes.length - 1];
  const last_high = highs[highs.length - 1];
  const last_low = lows[lows.length - 1];
  const last_range = last_high - last_low;
  const close_pos = (last_close - last_low) / (last_range || 1);
  const close_bias = close_pos > 0.75 ? 'bullish' : close_pos < 0.25 ? 'bearish' : 'neutral';

  return {
    timestamp: new Date().toISOString(),
    snapshot_bars: candles.length,
    price: last_close,
    atr_percent: percent_atr.toFixed(3),
    rsi: rsi_val.toFixed(2),
    adx: adx_val.adx.toFixed(2),
    macd_histogram: macd.histogram.toFixed(6),
    avg_volume: avg_vol.toFixed(0),
    curr_volume: curr_vol.toFixed(0),
    vol_ratio: vol_ratio.toFixed(2),

    // Regime detection
    vol_regime,
    trend_regime,
    rsi_state,
    momentum_score,
    mean_reversion_score,
    vol_state,
    close_bias,

    // Composite regime
    composite_regime: computeCompositeRegime({
      vol_regime, trend_regime, rsi_state, vol_state, mean_reversion_score
    }),
  };
}

function computeCompositeRegime(factors) {
  const { vol_regime, trend_regime, rsi_state, vol_state, mean_reversion_score } = factors;

  // Priority-based regime classification
  if (vol_regime === 'high' && trend_regime === 'strong_trend') {
    return 'breakout_momentum';
  }
  if (vol_regime === 'low' && trend_regime === 'ranging') {
    return 'mean_reversion_consolidation';
  }
  if (mean_reversion_score !== 0 && vol_state === 'low_vol_consolidation') {
    return 'elastic_bounce';
  }
  if (rsi_state === 'overbought' || rsi_state === 'oversold') {
    return 'extrema_pullback';
  }
  return 'neutral_drift';
}

// ── Weight Adjustment Formulas ──────────────────────────────────

function computeWeightsForRegime(regime, snapshot) {
  // Base weights (from successful BTC backtest)
  const base_weights = {
    bands: 2.798,
    rsi: 0.803,
    keltner: 1.799,
    williamsR: 2.196,
    fisher: 1.297,
    structure: 1.398,
    cci: 1.198,
    stochrsi: 1.793,
    obv: 0.143,
    fearGreed: 1.204,
    book: 0.264,
    flow: 0.244,
    supertrend: 0.358,
    adx: 0.297,
    vwma: 1.205,
    momentum: 0.256,
    persistence: 0.784,
    macd: 0.615,
    sma: 0.184,
    ema: 0.502,
    cmf: 1.003,
    volume: 1.404,
    hma: 0.134,
    ichimoku: 0.301,
    mfi: 0.501,
    vwap: 0.203,
  };

  const weights = { ...base_weights };
  let multipliers = {};

  // Regime-specific tuning
  switch (regime) {
    case 'breakout_momentum':
      // High vol + strong trend → boost momentum, trend, volume indicators
      multipliers = {
        supertrend: 1.5,    // Trend-follow strength
        adx: 1.4,           // Trend confirmation
        macd: 1.3,          // Momentum
        volume: 1.25,       // Volume validation
        rsi: 0.8,           // Reduce overbought noise
        stochrsi: 0.75,
        bands: 1.1,         // Support/resistance breakout levels
        momentum: 1.2,
        // Reduce mean-reversion heavy indicators
        mfi: 0.6,
        ichimoku: 0.7,
      };
      break;

    case 'mean_reversion_consolidation':
      // Low vol + ranging → boost mean reversion, oscillators
      multipliers = {
        rsi: 1.6,           // Strong oscillator signal
        stochrsi: 1.5,
        mfi: 1.4,           // Money flow extremes
        bands: 1.3,         // Mean reversion to middle bands
        cci: 1.2,
        ichimoku: 1.1,
        // Reduce momentum signals in choppy market
        macd: 0.6,
        adx: 0.5,           // ADX low anyway
        supertrend: 0.7,
        momentum: 0.6,
        volume: 0.8,
      };
      break;

    case 'elastic_bounce':
      // Price extrema + low vol → aggressive mean reversion
      multipliers = {
        bands: 2.0,         // Bollinger Band bounce plays
        rsi: 1.8,           // RSI bounce signals
        ichimoku: 1.3,      // Cloud bounce
        mfi: 1.5,           // Money flow reversal
        williamsR: 1.4,     // Williams %R extrema
        fisher: 1.2,        // Fisher extrema
        // Suppress trend-follow signals
        macd: 0.5,
        supertrend: 0.4,
        adx: 0.3,
      };
      break;

    case 'extrema_pullback':
      // RSI overbought/oversold → counter-trend bias
      multipliers = {
        rsi: 0.3,           // Reduce noise near extrema
        stochrsi: 0.4,
        bands: 1.4,         // Bollinger reversal
        fisher: 1.5,        // Fisher extrema counter-trade
        williamsR: 1.3,     // Williams reversal
        cci: 0.8,
        momentum: 0.5,
        // Keep trend signals for confirmation
        macd: 0.8,
        adx: 0.7,
      };
      break;

    case 'neutral_drift':
    default:
      // Balanced regime → minimal tuning
      multipliers = {
        // Slight upweight for stable, moderate indicators
        structure: 1.05,
        persistence: 1.05,
        volume: 1.02,
      };
  }

  // Apply multipliers
  Object.keys(multipliers).forEach(ind => {
    if (weights[ind] != null) {
      weights[ind] = clamp(weights[ind] * multipliers[ind], 0.001, 10);
    }
  });

  return { weights, multipliers, regime };
}

// ── Technical Indicators (subset for snapshot analysis) ─────────

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const h = Number(c[2]), l = Number(c[3]);
    const ph = Number(p[2]), pl = Number(p[3]), pc = Number(p[4]);
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / period;
}

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

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return { adx: 25, pdi: 25, mdi: 25 };
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const h = Number(c[2]), l = Number(c[3]), pc = Number(p[4]);
    const ph = Number(p[2]), pl = Number(p[3]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, down = pl - l;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
  }
  const wilderSmooth = (arr, p) => {
    if (arr.length < p) return [arr.reduce((a, v) => a + v, 0)];
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
  return { 
    adx: adxArr[li], 
    pdi: lastATR > 0 ? (pdiS[li] / lastATR) * 100 : 0, 
    mdi: lastATR > 0 ? (mdiS[li] / lastATR) * 100 : 0 
  };
}

function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
  const calcEMA = (data, period) => {
    const k = 2 / (period + 1);
    const ema = [data[0]];
    for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
    return ema;
  };
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signalPeriod);
  const lastMACD = macdLine[macdLine.length - 1];
  const lastSig = signalLine[signalLine.length - 1];
  return { macd: lastMACD, signal: lastSig, histogram: lastMACD - lastSig };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const snapshotFile = args[0] || path.join(require('os').tmpdir(), 'btc_snapshot.json');

  if (!fs.existsSync(snapshotFile)) {
    console.error(`Snapshot file not found: ${snapshotFile}`);
    process.exit(1);
  }

  const snapshotRaw = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const candles = Array.isArray(snapshotRaw) ? snapshotRaw : snapshotRaw.data || [];

  console.log('\n' + '='.repeat(80));
  console.log('WECRYPTO Adaptive Regime Weighter — Live BTC Snapshot');
  console.log('='.repeat(80));
  console.log(`\nSnapshot: ${candles.length} candles (5m bars, ~${(candles.length * 5).toFixed(0)} minutes)\n`);

  // Analyze snapshot
  const snapshot = analyzeSnapshot(candles);

  console.log('Market Analysis:');
  console.log(`  Price: $${snapshot.price.toFixed(2)}`);
  console.log(`  ATR (% of price): ${snapshot.atr_percent}%`);
  console.log(`  RSI: ${snapshot.rsi}`);
  console.log(`  ADX: ${snapshot.adx}`);
  console.log(`  MACD Histogram: ${snapshot.macd_histogram}`);
  console.log(`  Volume Ratio: ${snapshot.vol_ratio}x`);
  console.log(`\nRegime Detection:`);
  console.log(`  Volatility Regime: ${snapshot.vol_regime} (${snapshot.atr_percent}% ATR)`);
  console.log(`  Trend Regime: ${snapshot.trend_regime} (ADX: ${snapshot.adx})`);
  console.log(`  RSI State: ${snapshot.rsi_state}`);
  console.log(`  Volume State: ${snapshot.vol_state}`);
  console.log(`  Price Bias: ${snapshot.close_bias}`);
  console.log(`  Momentum: ${snapshot.momentum_score > 0 ? 'bullish' : 'bearish'}`);
  console.log(`  Mean Reversion Signal: ${snapshot.mean_reversion_score > 0 ? 'buy dip' : snapshot.mean_reversion_score < 0 ? 'sell rally' : 'neutral'}`);
  console.log(`\n→ Composite Regime: ${snapshot.composite_regime.toUpperCase()}`);

  // Compute regime-specific weights
  const tuning = computeWeightsForRegime(snapshot.composite_regime, snapshot);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Weight Adjustments for regime: ${tuning.regime}`);
  console.log(`${'='.repeat(80)}\n`);

  console.log('Indicator Weights (Adjusted):');
  const sortedWeights = Object.entries(tuning.weights)
    .sort((a, b) => b[1] - a[1]);

  sortedWeights.forEach(([ind, w]) => {
    const mult = tuning.multipliers[ind];
    const multStr = mult ? ` (${mult.toFixed(2)}x)` : '';
    console.log(`  ${ind.padEnd(14)} → ${w.toFixed(4)}${multStr}`);
  });

  // Output summary
  const output = {
    timestamp: snapshot.timestamp,
    market_snapshot: snapshot,
    regime_tuning: tuning,
    suggested_action: generateActionSuggestion(snapshot, tuning),
    deployment_ready: true,
  };

  const outPath = path.join(require('os').tmpdir(), 'adaptive-weights-output.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ Adaptive tuning written to: ${outPath}`);

  console.log(`\nSuggested Action: ${output.suggested_action}`);
  console.log('\n' + '='.repeat(80) + '\n');
}

function generateActionSuggestion(snapshot, tuning) {
  const regime = tuning.regime;
  const rsi = Number(snapshot.rsi);
  const adx = Number(snapshot.adx);

  if (regime === 'breakout_momentum') {
    return '📈 TREND-FOLLOW MODE: Use supertrend, ADX, MACD; enter on dips with momentum confirmation.';
  }
  if (regime === 'mean_reversion_consolidation') {
    return '🔄 MEAN-REVERSION MODE: Use RSI/Stoch/Bands; enter extrema (>70 or <30 RSI) for bounces.';
  }
  if (regime === 'elastic_bounce') {
    return '⚡ BOUNCE MODE: Price at extrema with low volume; aggressive counter-trend entries near bands.';
  }
  if (regime === 'extrema_pullback') {
    return '⬇️ PULLBACK MODE: Overbought/oversold RSI; trade reversals near Bollinger Bands.';
  }
  return '➡️ DRIFT MODE: Mixed signals; use broad regime confirmation before entries.';
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
