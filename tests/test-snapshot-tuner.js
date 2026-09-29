#!/usr/bin/env node

/**
 * ================================================================
 * Snapshot Tuner Test Suite
 * Tests market regime detection and weight adjustment logic
 * ================================================================
 */

const SnapshotTuner = require('./src/core/snapshot-tuner');

// Mock window._predictions with sample trade data
const generateMockTrades = (count = 500, successRate = 0.50) => {
  const coins = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'HYPE'];
  const now = Date.now();
  const dayAgo = now - (24 * 60 * 60 * 1000);
  const trades = [];

  for (let i = 0; i < count; i++) {
    const coin = coins[Math.floor(Math.random() * coins.length)];
    const isCorrect = Math.random() < successRate;
    const prediction = Math.random() > 0.5 ? 'UP' : 'DOWN';
    
    trades.push({
      timestamp: dayAgo + (Math.random() * 24 * 60 * 60 * 1000),
      coin,
      horizon: 'h15',
      score: Math.random() * 1.0,
      prediction,
      actual: isCorrect ? prediction : (prediction === 'UP' ? 'DOWN' : 'UP'),
      indicators: {
        supertrend: isCorrect ? 0.8 : 0.3,
        rsi: isCorrect ? 0.7 : 0.4,
        bands: isCorrect ? 0.75 : 0.35,
        volume: isCorrect ? 0.6 : 0.5,
        flow: isCorrect ? 0.65 : 0.45,
      },
    });
  }

  return trades;
};

// Test suite
const tests = [
  {
    name: 'Initialize snapshot tuner',
    run: () => {
      const tuner = new SnapshotTuner();
      return tuner && tuner.baselineCompositeWeights ? 'PASS' : 'FAIL';
    },
  },
  {
    name: 'Parse mock trades (24h)',
    run: () => {
      const tuner = new SnapshotTuner();
      global.window = { _predictions: { BTC: generateMockTrades(50) } };
      const trades = tuner.parseLastDay();
      return trades.length > 0 ? 'PASS' : 'FAIL';
    },
  },
  {
    name: 'Analyze performance (50% success)',
    run: () => {
      const tuner = new SnapshotTuner();
      global.window = { _predictions: { BTC: generateMockTrades(100, 0.50) } };
      const trades = tuner.parseLastDay();
      const analysis = tuner.analyzePerformance(trades);
      
      const hasCoinStats = analysis.coins.BTC && analysis.coins.BTC.winRate > 0;
      const hasIndicatorStats = Object.keys(analysis.indicators).length > 0;
      
      return (hasCoinStats && hasIndicatorStats) ? 'PASS' : 'FAIL';
    },
  },
  {
    name: 'Detect market regime (normal)',
    run: () => {
      const tuner = new SnapshotTuner();
      global.window = { _predictions: { BTC: generateMockTrades(100, 0.50) } };
      const trades = tuner.parseLastDay();
      const analysis = tuner.analyzePerformance(trades);
      
      return (tuner.marketRegime === 'normal' || tuner.marketRegime === 'high-volatility') ? 'PASS' : 'FAIL';
    },
  },
  {
    name: 'Generate recommendations',
    run: () => {
      const tuner = new SnapshotTuner();
      global.window = { _predictions: { BTC: generateMockTrades(200, 0.45) } };
      const trades = tuner.parseLastDay();
      const analysis = tuner.analyzePerformance(trades);
      const recs = tuner.generateRecommendations(analysis);
      
      return (recs && recs.rationale && recs.rationale.length > 0) ? 'PASS' : 'FAIL';
    },
  },
  {
    name: 'Apply recommendations (normalize weights)',
    run: () => {
      const tuner = new SnapshotTuner();
      global.window = { _predictions: { BTC: generateMockTrades(100, 0.50) } };
      const trades = tuner.parseLastDay();
      const analysis = tuner.analyzePerformance(trades);
      tuner.generateRecommendations(analysis);
      const result = tuner.applyRecommendations();
      
      // Verify weights sum close to 1.0 (normalized)
      const sum = Object.values(result.compositeWeights).reduce((a, b) => a + b, 0);
      return Math.abs(sum - 1.0) < 0.01 ? 'PASS' : 'FAIL';
    },
  },
  {
    name: 'Run full snapshot cycle',
    run: () => {
      const tuner = new SnapshotTuner();
      global.window = { _predictions: { BTC: generateMockTrades(150, 0.52) } };
      const result = tuner.runSnapshot();
      
      return (result && result.compositeWeights && result.regime) ? 'PASS' : 'FAIL';
    },
  },
  {
    name: 'Detect high-performance indicator',
    run: () => {
      const tuner = new SnapshotTuner();
      
      // Create trades where "bands" indicator always correct
      const trades = [];
      for (let i = 0; i < 50; i++) {
        trades.push({
          timestamp: Date.now() - (Math.random() * 24 * 60 * 60 * 1000),
          coin: 'BTC',
          horizon: 'h15',
          score: 0.8,
          prediction: 'UP',
          actual: 'UP', // Always correct
          correct: true,
          indicators: { bands: { value: 1.0 } },
        });
      }
      
      const analysis = tuner.analyzePerformance(trades);
      const recs = tuner.generateRecommendations(analysis);
      
      // Should upweight bands
      return (recs.compositeAdjustments.bands?.reason.includes('High WR')) ? 'PASS' : 'FAIL';
    },
  },
  {
    name: 'Get status and diagnostics',
    run: () => {
      const tuner = new SnapshotTuner();
      global.window = { _predictions: { BTC: generateMockTrades(100, 0.50) } };
      tuner.runSnapshot();
      
      const status = tuner.getStatus();
      const diag = tuner.getDiagnostics();
      
      return (status && status.marketRegime && diag && diag.status) ? 'PASS' : 'FAIL';
    },
  },
  {
    name: 'Reset to baseline',
    run: () => {
      const tuner = new SnapshotTuner();
      global.window = { _predictions: { BTC: generateMockTrades(100, 0.40) } };
      tuner.runSnapshot();
      
      const beforeReset = tuner.currentCompositeWeights.supertrend;
      tuner.resetToBaseline();
      const afterReset = tuner.currentCompositeWeights.supertrend;
      
      return (beforeReset === undefined || afterReset === tuner.baselineCompositeWeights.supertrend) ? 'PASS' : 'FAIL';
    },
  },
];

// Run tests
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║  Snapshot Tuner Test Suite                               ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

let passed = 0;
let failed = 0;

tests.forEach((test, index) => {
  try {
    const result = test.run();
    const status = result === 'PASS' ? '✓' : '✗';
    console.log(`${status} [TEST ${index + 1}] ${test.name}`);
    
    if (result === 'PASS') {
      passed++;
    } else {
      failed++;
    }
  } catch (err) {
    console.log(`✗ [TEST ${index + 1}] ${test.name}`);
    console.log(`  Error: ${err.message}`);
    failed++;
  }
});

console.log(`\n╔════════════════════════════════════════════════════════════╗`);
console.log(`║  Results: ${passed}/${tests.length} PASSED, ${failed} FAILED${' '.repeat(18 - passed.toString().length - failed.toString().length)}║`);
console.log(`╚════════════════════════════════════════════════════════════╝\n`);

process.exit(failed > 0 ? 1 : 0);
