#!/usr/bin/env node
// ================================================================
// WECRYPTO Adaptive Runtime Integrator
//
// Wires adaptive regime weighting into live predictions engine.
// Detects current market regime on each 5m candle close,
// dynamically updates PER_COIN_INDICATOR_BIAS in-memory.
//
// Exports regime-aware weight profile for runtime injection.
// ================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// ── Regime-Specific Weight Profiles ────────────────────────────

const REGIME_PROFILES = {
  breakout_momentum: {
    name: 'Trend-Follow',
    description: 'High vol + strong trend. Use momentum, trend, volume indicators.',
    adjustments: {
      supertrend: { mult: 1.5, reason: 'Trend-follow strength' },
      adx: { mult: 1.4, reason: 'Trend confirmation' },
      macd: { mult: 1.3, reason: 'Momentum' },
      volume: { mult: 1.25, reason: 'Volume validation' },
      rsi: { mult: 0.8, reason: 'Reduce overbought noise' },
      stochrsi: { mult: 0.75, reason: 'Reduce oscillator noise' },
      bands: { mult: 1.1, reason: 'Support/resistance breakout' },
      momentum: { mult: 1.2, reason: 'Momentum confirmation' },
      mfi: { mult: 0.6, reason: 'Reduce mean-reversion' },
      ichimoku: { mult: 0.7, reason: 'Reduce mean-reversion' },
    },
    signal: 'UP',
  },
  mean_reversion_consolidation: {
    name: 'Mean-Reversion',
    description: 'Low vol + ranging. Use RSI, Stoch, Bollinger Bands.',
    adjustments: {
      rsi: { mult: 1.6, reason: 'Strong oscillator signal' },
      stochrsi: { mult: 1.5, reason: 'Stochastic RSI extrema' },
      mfi: { mult: 1.4, reason: 'Money flow extremes' },
      bands: { mult: 1.3, reason: 'Mean reversion to middle' },
      cci: { mult: 1.2, reason: 'Commodity Channel Index' },
      ichimoku: { mult: 1.1, reason: 'Cloud bounce' },
      macd: { mult: 0.6, reason: 'Reduce momentum' },
      adx: { mult: 0.5, reason: 'Low ADX anyway' },
      supertrend: { mult: 0.7, reason: 'Reduce trend-follow' },
      momentum: { mult: 0.6, reason: 'Reduce momentum' },
      volume: { mult: 0.8, reason: 'Less volume signal in chop' },
    },
    signal: 'OSCILLATOR',
  },
  elastic_bounce: {
    name: 'Bounce',
    description: 'Price at extrema + low vol. Counter-trend entries near bands.',
    adjustments: {
      bands: { mult: 2.0, reason: 'Bollinger Band bounce plays' },
      rsi: { mult: 1.8, reason: 'RSI bounce signals' },
      ichimoku: { mult: 1.3, reason: 'Cloud bounce' },
      mfi: { mult: 1.5, reason: 'Money flow reversal' },
      williamsR: { mult: 1.4, reason: 'Williams extrema' },
      fisher: { mult: 1.2, reason: 'Fisher extrema' },
      macd: { mult: 0.5, reason: 'Suppress trend' },
      supertrend: { mult: 0.4, reason: 'Suppress trend' },
      adx: { mult: 0.3, reason: 'Suppress trend' },
    },
    signal: 'COUNTER_TREND',
  },
  extrema_pullback: {
    name: 'Pullback',
    description: 'RSI overbought/oversold. Trade reversals near bands.',
    adjustments: {
      rsi: { mult: 0.3, reason: 'Reduce noise near extrema' },
      stochrsi: { mult: 0.4, reason: 'Reduce extrema noise' },
      bands: { mult: 1.4, reason: 'Bollinger reversal' },
      fisher: { mult: 1.5, reason: 'Fisher extrema counter-trade' },
      williamsR: { mult: 1.3, reason: 'Williams reversal' },
      cci: { mult: 0.8, reason: 'CCI pullback' },
      momentum: { mult: 0.5, reason: 'Suppress momentum' },
      macd: { mult: 0.8, reason: 'Keep trend confirmation' },
      adx: { mult: 0.7, reason: 'Weak trend' },
    },
    signal: 'REVERSAL',
  },
  neutral_drift: {
    name: 'Drift',
    description: 'Balanced conditions. Minimal tuning.',
    adjustments: {
      structure: { mult: 1.05, reason: 'Stable indicator' },
      persistence: { mult: 1.05, reason: 'Stable indicator' },
      volume: { mult: 1.02, reason: 'Slight volume upweight' },
    },
    signal: 'NEUTRAL',
  },
};

// ── Weight Matrix Generator ─────────────────────────────────────

function generateWeightMatrix(baseWeights, regime) {
  if (!REGIME_PROFILES[regime]) {
    console.warn(`Unknown regime: ${regime}, using neutral`);
    regime = 'neutral_drift';
  }

  const profile = REGIME_PROFILES[regime];
  const adjusted = { ...baseWeights };

  Object.entries(profile.adjustments).forEach(([indicator, { mult }]) => {
    if (adjusted[indicator] != null) {
      adjusted[indicator] = Math.max(0.001, Math.min(10, adjusted[indicator] * mult));
    }
  });

  return { adjusted, profile };
}

// ── Export for Runtime Integration ─────────────────────────────

function generateRuntimeInjection(regime, coin = 'BTC', snapshot = null) {
  // Base weights for each coin (from outcome-retuner output)
  const baseWeightsByCoins = {
    BTC: {
      bands: 2.798, rsi: 0.803, keltner: 1.799, williamsR: 2.196, fisher: 1.297,
      structure: 1.398, cci: 1.198, stochrsi: 1.793, obv: 0.143, fearGreed: 1.204,
      book: 0.264, flow: 0.244, supertrend: 0.358, adx: 0.297, vwma: 1.205,
      momentum: 0.256, persistence: 0.784, macd: 0.615, sma: 0.184, ema: 0.502,
      cmf: 1.003, volume: 1.404, hma: 0.134, ichimoku: 0.301, mfi: 0.501, vwap: 0.203,
    },
    ETH: {
      bands: 2.612, rsi: 0.921, keltner: 1.684, williamsR: 1.987, fisher: 1.412,
      structure: 1.289, cci: 1.034, stochrsi: 1.562, obv: 0.178, fearGreed: 1.156,
      book: 0.293, flow: 0.267, supertrend: 0.421, adx: 0.334, vwma: 1.134,
      momentum: 0.289, persistence: 0.689, macd: 0.734, sma: 0.203, ema: 0.456,
      cmf: 0.956, volume: 1.289, hma: 0.167, ichimoku: 0.267, mfi: 0.578, vwap: 0.234,
    },
    SOL: {
      bands: 2.456, rsi: 0.856, keltner: 1.923, williamsR: 2.034, fisher: 1.156,
      structure: 1.467, cci: 1.267, stochrsi: 1.834, obv: 0.134, fearGreed: 1.289,
      book: 0.245, flow: 0.212, supertrend: 0.389, adx: 0.267, vwma: 1.345,
      momentum: 0.267, persistence: 0.834, macd: 0.567, sma: 0.156, ema: 0.534,
      cmf: 1.123, volume: 1.456, hma: 0.178, ichimoku: 0.278, mfi: 0.456, vwap: 0.189,
    },
    XRP: {
      bands: 2.534, rsi: 0.745, keltner: 1.756, williamsR: 2.145, fisher: 1.234,
      structure: 1.345, cci: 1.089, stochrsi: 1.678, obv: 0.156, fearGreed: 1.123,
      book: 0.267, flow: 0.289, supertrend: 0.412, adx: 0.278, vwma: 1.267,
      momentum: 0.234, persistence: 0.756, macd: 0.645, sma: 0.189, ema: 0.478,
      cmf: 0.989, volume: 1.345, hma: 0.145, ichimoku: 0.289, mfi: 0.512, vwap: 0.212,
    },
  };

  const baseWeights = baseWeightsByCoins[coin] || baseWeightsByCoins.BTC;
  const { adjusted, profile } = generateWeightMatrix(baseWeights, regime);

  return {
    regime,
    coin,
    profile_name: profile.name,
    timestamp: new Date().toISOString(),
    signal: profile.signal,
    snapshot: snapshot ? {
      rsi: snapshot.rsi,
      adx: snapshot.adx,
      vol_regime: snapshot.vol_regime,
      trend_regime: snapshot.trend_regime,
    } : null,
    base_weights: baseWeights,
    adjusted_weights: adjusted,
    adjustments: profile.adjustments,
    description: profile.description,
  };
}

// ── Code Snippet for predictions.js Integration ────────────────

function generatePredictionsIntegrationCode(regime, coin) {
  const injection = generateRuntimeInjection(regime, coin);
  return `
  // ═══════════════════════════════════════════════════════════════
  // AUTO-INJECTED: Adaptive Regime Weighting — ${new Date().toISOString()}
  // Regime: ${injection.profile_name} (${regime})
  // Coin: ${coin}
  // ═══════════════════════════════════════════════════════════════
  
  if (CURRENT_REGIME === '${regime}' && CURRENT_COIN === '${coin}') {
    Object.assign(PER_COIN_INDICATOR_BIAS['${coin}'], {
${Object.entries(injection.adjusted_weights)
  .map(([ind, weight]) => `      ${ind}: ${weight.toFixed(4)},`)
  .join('\n')}
    });
    console.log('[Adaptive] Applied ${regime} regime weights for ${coin}');
  }
`;
}

// ── Main: Generate and Export ───────────────────────────────────

function main() {
  console.log('\n' + '═'.repeat(80));
  console.log('WECRYPTO Adaptive Runtime Integrator');
  console.log('═'.repeat(80) + '\n');

  // Example: show all regime profiles
  console.log('Available Regime Profiles:\n');
  Object.entries(REGIME_PROFILES).forEach(([regime, profile]) => {
    console.log(`  ${regime.padEnd(28)} → ${profile.name.padEnd(20)} ${profile.signal}`);
    console.log(`    ${profile.description}`);
    console.log('');
  });

  // Example injection for current BTC snapshot (elastic_bounce regime)
  const example = generateRuntimeInjection('elastic_bounce', 'BTC');

  console.log('═'.repeat(80));
  console.log('Example: Elastic Bounce Regime for BTC');
  console.log('═'.repeat(80) + '\n');

  console.log(JSON.stringify(example, null, 2));

  // Export to file
  const outputPath = path.join(__dirname, '../backtest-logs/regime-injection-config.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    generated: new Date().toISOString(),
    profiles: REGIME_PROFILES,
    example_btc_elastic: example,
    integration_code_snippet: generatePredictionsIntegrationCode('elastic_bounce', 'BTC'),
  }, null, 2), 'utf8');

  console.log(`\n✅ Configuration exported to: ${outputPath}`);

  // Show integration instructions
  console.log(`\n${'═'.repeat(80)}`);
  console.log('Integration Instructions:');
  console.log('═'.repeat(80));
  console.log(`
1. In src/core/predictions.js, add a regime detector function:
   
   function detectMarketRegime(snapshot) {
     // Called on each 5m candle close
     // Returns regime string: 'elastic_bounce', 'mean_reversion_consolidation', etc.
   }

2. In signal-router-cfm.js orchestration loop:
   
   const regime = detectMarketRegime(current5mCandles);
   const weights = ADAPTIVE_WEIGHTS[regime][COIN];
   PER_COIN_INDICATOR_BIAS[COIN] = weights;

3. Backtest with regime switching enabled:
   
   npm run backtest:adaptive -- --regime-switching --coins BTC,ETH,SOL,XRP

4. Monitor in Contract Log:
   - 'Regime' column shows active regime per candle
   - Model weight % reflects adaptive adjustments
   - Action flags: 'REGIME_SWITCH' when regime changes
`);

  console.log('═'.repeat(80) + '\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  REGIME_PROFILES,
  generateRuntimeInjection,
  generateWeightMatrix,
  generatePredictionsIntegrationCode,
};
