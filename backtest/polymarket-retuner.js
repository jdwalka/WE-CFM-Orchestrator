#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// Polyfills for Fetcher
if (!global.fetch) {
  global.fetch = require('node-fetch');
}

const HistoricalSettlementFetcher = require('../src/prediction-markets/historical-settlement-fetcher.js');
const {
  fetchLookback,
  computeSignalVector,
  optimizeWeights,
  writeWeightsToPredictions,
} = require('./outcome-retuner.js');

const PREDS = path.join(__dirname, '../src/core/predictions.js');
const BT    = path.join(__dirname, 'backtest-runner.js');

async function main() {
  console.log('================================================================');
  console.log(' WECRYPTO — Polymarket-Based Indicator Weight Retuner');
  console.log('================================================================');

  const fetcher = new HistoricalSettlementFetcher();
  
  // 1. Fetch Polymarket outcomes (up to 1000 historical per supported coin)
  console.log('\n[1] Fetching Polymarket Snapshots...');
  const polyMarkets = await fetcher.fetchPolymarketSettled(24, 1000);

  if (!polyMarkets || polyMarkets.length === 0) {
    console.error('❌ No resolved Polymarket outcomes found.');
    process.exit(1);
  }

  // Group by symbol
  const bySymbol = {};
  for (const m of polyMarkets) {
    if (!bySymbol[m.symbol]) bySymbol[m.symbol] = [];
    bySymbol[m.symbol].push(m);
  }

  console.log(`\nFound ${polyMarkets.length} outcomes across ${Object.keys(bySymbol).length} coins.`);

  const dateStr = new Date().toISOString().replace(/T/, ' ').slice(0, 16) + ' (Polymarket Recalibration)';
  const results = {};

  // 2. Load starting weights
  const predsContent = fs.readFileSync(PREDS, 'utf8');
  let currentBiases;
  try {
    const vm = require('vm');
    const sandbox = { window: {}, console: console, self: {}, Math: Math };
    vm.runInNewContext(predsContent, sandbox);
    currentBiases = sandbox.PER_COIN_INDICATOR_BIAS || sandbox.window.PER_COIN_INDICATOR_BIAS;
    if (!currentBiases) throw new Error("PER_COIN_INDICATOR_BIAS not found in sandbox");
  } catch (e) {
    throw new Error('Failed to parse PER_COIN_INDICATOR_BIAS: ' + e.message);
  }

  const defaultBias = currentBiases['BTC'] || currentBiases['ETH'];

  // 3. Process each coin
  for (const [coin, markets] of Object.entries(bySymbol)) {
    console.log(`\n─── Processing ${coin} (${markets.length} snapshots) ───`);

    const observations = [];
    let fetchErrors = 0;

    for (let i = 0; i < markets.length; i++) {
      const m = markets[i];
      const endMs = m.resolvedTime; // exact closure time
      const startMs = endMs - 15 * 60000; // 15m window prior
      
      const actualDirection = m.outcome === 'YES' ? 'UP' : 'DOWN';

      process.stdout.write(`  [${i+1}/${markets.length}] ${new Date(endMs).toISOString()} => ${actualDirection} ... `);

      const lookback = await fetchLookback(coin + 'USDT', startMs);
      if (!lookback) {
        console.log('SKIP (No Binance Lookback Data)');
        fetchErrors++;
        continue;
      }

      const sv = computeSignalVector(lookback);
      if (!sv) {
        console.log('SKIP (Not enough candles)');
        fetchErrors++;
        continue;
      }

      observations.push({
        windowStart: startMs,
        signalVector: sv,
        actualDirection: actualDirection,
      });

      console.log('OK');
      await new Promise(r => setTimeout(r, 150)); // rate limit Binance API
    }

    if (observations.length < 1) {
      console.log(`⚠️ Not enough valid observations for ${coin}. Skipping.`);
      continue;
    }

    // 4. Optimize
    console.log(`\n  Running Optimization for ${coin}...`);
    const initialBias = currentBiases[coin] || { ...defaultBias };
    
    const optResult = optimizeWeights(observations, initialBias, {
      learningRate: 0.015,
      epochs: 300
    });

    console.log(`  Initial Accuracy: ${(optResult.initialAccuracy * 100).toFixed(1)}%`);
    console.log(`  Final Accuracy:   ${(optResult.finalAccuracy * 100).toFixed(1)}%`);

    results[coin] = {
      optResult,
      oldBias: initialBias,
      obsCount: observations.length
    };
  }

  // 5. Apply new weights
  console.log('\n================================================================');
  console.log(' WRITING OPTIMIZED WEIGHTS');
  console.log('================================================================');
  
  if (Object.keys(results).length === 0) {
    console.log('No coins updated.');
  } else {
    for (const [coin, r] of Object.entries(results)) {
      writeWeightsToPredictions(coin, r.oldBias, r.optResult.updatedWeights, PREDS, r.obsCount, dateStr);
      writeWeightsToPredictions(coin, r.oldBias, r.optResult.updatedWeights, BT,   r.obsCount, dateStr);
    }

    // Syntax check
    const { execSync } = require('child_process');
    for (const f of [PREDS, BT]) {
      try {
        execSync(`node --check "${f}"`, { stdio: 'pipe' });
        console.log(`  ${path.basename(f)} — ✅ syntax OK`);
      } catch (e) {
        console.error(`  ${path.basename(f)} — ❌ SYNTAX ERROR: ${e.stderr?.toString().slice(0, 300)}`);
      }
    }
  }

  console.log('\n================ COMPLETE ================\n');
}

main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
