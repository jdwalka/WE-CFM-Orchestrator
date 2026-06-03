/**
 * ================================================================
 * Test Suite: Real-Time Tuner (30-second polling, 60-second decisions)
 * ================================================================
 */

const RealTimeTuner = require('./src/core/realtime-tuner');

// Mock window object for testing
if (typeof window === 'undefined') {
  global.window = {
    _predictions: {
      BTC: [
        { timestamp: Date.now() - 30000, horizon: 'h15', score: 0.65, prediction: 'UP', actual: 'UP', correct: true, indicators: { rsi: 0.7, stochrsi: 0.65 } },
        { timestamp: Date.now() - 20000, horizon: 'h15', score: 0.55, prediction: 'DOWN', actual: 'DOWN', correct: true, indicators: { rsi: 0.3, stochrsi: 0.25 } },
        { timestamp: Date.now() - 10000, horizon: 'h15', score: 0.45, prediction: 'UP', actual: 'DOWN', correct: false, indicators: { rsi: 0.55, stochrsi: 0.5 } },
      ],
      ETH: [
        { timestamp: Date.now() - 25000, horizon: 'h15', score: 0.70, prediction: 'UP', actual: 'UP', correct: true, indicators: { rsi: 0.75, stochrsi: 0.70 } },
      ],
      DOGE: [
        { timestamp: Date.now() - 15000, horizon: 'h15', score: 0.35, prediction: 'DOWN', actual: 'DOWN', correct: true, indicators: { rsi: 0.2, stochrsi: 0.15 } },
      ],
    },
    _kalshiRecentTrades: [
      { timestamp: Date.now() - 40000, result: 'WIN' },
      { timestamp: Date.now() - 30000, result: 'WIN' },
      { timestamp: Date.now() - 20000, result: 'LOSS' },
      { timestamp: Date.now() - 10000, result: 'LOSS' },
      { timestamp: Date.now() - 5000, result: 'LOSS' },
      { timestamp: Date.now() - 2000, result: 'LOSS' },
    ]
  };
}

// Test counters
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`✅ PASS: ${testName}`);
    testsPassed++;
  } else {
    console.error(`❌ FAIL: ${testName}`);
    testsFailed++;
  }
}

function assertEquals(actual, expected, testName) {
  // Handle floating point precision
  const matches = Math.abs(actual - expected) < 0.01 || actual === expected;
  assert(matches, `${testName} (expected ${expected}, got ${actual})`);
}

function assertGreater(actual, threshold, testName) {
  assert(actual > threshold, `${testName} (expected > ${threshold}, got ${actual})`);
}

function assertLess(actual, threshold, testName) {
  assert(actual < threshold, `${testName} (expected < ${threshold}, got ${actual})`);
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║  Real-Time Tuner Test Suite                                ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// TEST 1: Initialization
console.log('TEST 1: Initialization');
const tuner = new RealTimeTuner();
assert(tuner !== null, 'RealTimeTuner instantiated');
assertEquals(tuner.pollCount, 0, 'Poll count starts at 0');
assertEquals(tuner.decisionsApplied, 0, 'Decisions count starts at 0');
assertGreater(tuner.pollInterval, 0, 'Poll interval > 0');
assertGreater(tuner.decisionWindow, 0, 'Decision window > 0');
console.log('');

// TEST 2: Poll Real-Time Data
console.log('TEST 2: Poll Real-Time Data');
const pollData = tuner.pollRealtimeData();
assert(pollData !== null, 'Poll data returned');
assert(pollData.timestamp > 0, 'Poll has timestamp');
assertGreater(pollData.recentPredictions.length, 0, 'Recent predictions captured');
assertGreater(pollData.recentKalshiTrades.length, 0, 'Recent Kalshi trades captured');
assert(pollData.accuracy !== null, 'Accuracy calculated');
assert(pollData.accuracy.portfolio !== null, 'Portfolio accuracy exists');
assertGreater(pollData.accuracy.portfolio.winRate, 0, 'Portfolio win rate > 0%');
console.log(`  Portfolio accuracy: ${pollData.accuracy.portfolio.winRate.toFixed(1)}%`);
console.log('');

// TEST 3: Indicator Performance Analysis
console.log('TEST 3: Indicator Performance Analysis');
assert(pollData.indicatorPerformance !== null, 'Indicator performance calculated');
assert(typeof pollData.indicatorPerformance === 'object', 'Indicator performance is object');
const indicatorKeys = Object.keys(pollData.indicatorPerformance);
assertGreater(indicatorKeys.length, 0, 'At least one indicator tracked');
console.log(`  Indicators tracked: ${indicatorKeys.join(', ')}`);
console.log('');

// TEST 4: Kalshi Failure Spike Detection
console.log('TEST 4: Kalshi Failure Spike Detection');
assert(pollData.failureSpike !== null, 'Failure spike analysis done');
assert(pollData.failureSpike.total > 0, 'Kalshi trades detected');
assertLess(pollData.failureSpike.failureRate, 1.0, 'Failure rate < 100%');
console.log(`  Failure rate: ${(pollData.failureSpike.failureRate * 100).toFixed(1)}%`);
console.log(`  Level: ${pollData.failureSpike.level}`);
console.log('');

// TEST 5: Decision Making
console.log('TEST 5: Decision Making');
const decisions = tuner.makeRapidDecisions(pollData);
assert(decisions !== null, 'Decisions made');
assert(decisions.timestamp > 0, 'Decision has timestamp');
assert(typeof decisions.gateAdjustments === 'object', 'Gate adjustments object');
assert(typeof decisions.weightAdjustments === 'object', 'Weight adjustments object');
console.log(`  Gate adjustments: ${Object.keys(decisions.gateAdjustments).length}`);
console.log(`  Weight adjustments: ${Object.keys(decisions.weightAdjustments).length}`);
console.log(`  Emergency actions: ${decisions.emergencyActions.length}`);
console.log('');

// TEST 6: Multiple Polls (60-second window simulation)
console.log('TEST 6: Multiple Polls (60-second window)');
let totalPolls = 0;
for (let i = 0; i < 2; i++) {
  const p = tuner.pollRealtimeData();
  if (p) totalPolls++;
}
assert(totalPolls === 2, `Completed ${totalPolls} polls`);
assertEquals(tuner.pollCount, 3, 'Poll count incremented (1 from TEST 2 + 2 from TEST 6)');
console.log('');

// TEST 7: Per-Coin Accuracy Extraction
console.log('TEST 7: Per-Coin Accuracy Extraction');
const coinAccuracy = pollData.accuracy.byCoins;
assert(Object.keys(coinAccuracy).length > 0, 'Per-coin accuracy tracked');
Object.entries(coinAccuracy).forEach(([coin, stats]) => {
  if (stats.total > 0) {
    console.log(`  ${coin}: ${stats.winRate.toFixed(1)}% (${stats.wins}/${stats.total})`);
  }
});
console.log('');

// TEST 8: Decision History
console.log('TEST 8: Decision History');
assert(Array.isArray(tuner.decisionHistory), 'Decision history is array');
assertGreater(tuner.decisionHistory.length, 0, 'Decisions recorded in history');
console.log(`  Decision history length: ${tuner.decisionHistory.length}`);
console.log('');

// TEST 9: Status Report
console.log('TEST 9: Status Report');
const status = tuner.getStatus();
assert(status !== null, 'Status retrieved');
assert(status.pollCount > 0, 'Poll count in status');
assertEquals(status.pollCount, tuner.pollCount, 'Status poll count matches internal');
console.log(`  Polls: ${status.pollCount}`);
console.log(`  Decisions applied: ${status.decisionsApplied}`);
console.log(`  Emergency triggers: ${status.emergencyTriggers}`);
console.log(`  Decision frequency: ${status.decisionFrequency}`);
console.log('');

// TEST 10: Diagnostics Report
console.log('TEST 10: Diagnostics Report');
const diagnostics = tuner.getDiagnostics();
assert(diagnostics !== null, 'Diagnostics retrieved');
assert(diagnostics.pollInterval > 0, 'Poll interval in diagnostics');
assert(diagnostics.decisionWindow > 0, 'Decision window in diagnostics');
assert(diagnostics.thresholds !== null, 'Thresholds in diagnostics');
console.log(`  Poll interval: ${diagnostics.pollInterval}ms`);
console.log(`  Decision window: ${diagnostics.decisionWindow}ms`);
console.log(`  Threshold thresholds.rapidFailureRate: ${diagnostics.thresholds.rapidFailureRate}`);
console.log('');

// TEST 11: Reset Functionality
console.log('TEST 11: Reset Functionality');
const preResetCount = tuner.pollCount;
tuner.reset();
assert(Object.keys(tuner.decisionHistory).length === 0, 'Decision history cleared');
console.log(`  State reset successfully`);
console.log('');

// TEST 12: Re-poll after reset
console.log('TEST 12: Re-poll After Reset');
const postResetPoll = tuner.pollRealtimeData();
assert(postResetPoll !== null, 'Poll works after reset');
assert(tuner.pollCount > preResetCount, 'Poll count continued after reset');
console.log('');

// TEST 13: Rapid failure rate detection
console.log('TEST 13: Rapid Failure Rate Detection');
const failureTest = tuner.detectFailureSpike([
  { result: 'LOSS' },
  { result: 'LOSS' },
  { result: 'LOSS' },
  { result: 'WIN' },
]);
assert(failureTest.failureRate === 0.75, 'Failure rate calculated correctly (75%)');
assert(failureTest.emergency === true, 'Emergency flag triggered at 75%');
console.log(`  3 losses, 1 win = ${failureTest.failureRate * 100}% failure rate`);
console.log(`  Emergency triggered: ${failureTest.emergency}`);
console.log('');

// TEST 14: Per-indicator win rate calculation
console.log('TEST 14: Per-Indicator Win Rate Calculation');
const indicatorTest = tuner.analyzeIndicatorsRealtimeWindow([
  { 
    correct: true, 
    indicators: { rsi: 0.7, stochrsi: 0.65 } 
  },
  { 
    correct: true, 
    indicators: { rsi: 0.75, stochrsi: 0.70 } 
  },
  { 
    correct: false, 
    indicators: { rsi: 0.3, stochrsi: 0.25 } 
  },
]);
assert(indicatorTest.rsi !== null, 'RSI stats calculated');
assert(indicatorTest.stochrsi !== null, 'StochRSI stats calculated');
assertEquals(indicatorTest.rsi.total, 3, 'RSI total trades = 3');
assertEquals(indicatorTest.rsi.wins, 2, 'RSI wins = 2');
assertGreater(indicatorTest.rsi.winRate, 50, 'RSI win rate > 50%');
console.log(`  RSI: ${indicatorTest.rsi.winRate.toFixed(1)}% (${indicatorTest.rsi.wins}/${indicatorTest.rsi.total})`);
console.log(`  StochRSI: ${indicatorTest.stochrsi.winRate.toFixed(1)}% (${indicatorTest.stochrsi.wins}/${indicatorTest.stochrsi.total})`);
console.log('');

// TEST 15: Rapid accuracy calculation
console.log('TEST 15: Rapid Accuracy Calculation');
const accuracyTest = tuner.calculateRealtimeAccuracy([
  { coin: 'BTC', correct: true },
  { coin: 'BTC', correct: true },
  { coin: 'BTC', correct: false },
  { coin: 'ETH', correct: true },
]);
assert(accuracyTest.portfolio.total === 4, 'Portfolio total = 4');
assertEquals(accuracyTest.portfolio.wins, 3, 'Portfolio wins = 3');
assertGreater(accuracyTest.portfolio.winRate, 70, 'Portfolio win rate > 70%');
assert(accuracyTest.byCoins.BTC !== null, 'BTC coin stats exist');
assertEquals(accuracyTest.byCoins.BTC.winRate, 66.67, 'BTC win rate ~66.67%');
console.log(`  Portfolio: ${accuracyTest.portfolio.winRate.toFixed(1)}% (${accuracyTest.portfolio.wins}/${accuracyTest.portfolio.total})`);
console.log(`  BTC: ${accuracyTest.byCoins.BTC.winRate.toFixed(1)}%`);
console.log(`  ETH: ${accuracyTest.byCoins.ETH.winRate.toFixed(1)}%`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log('╔════════════════════════════════════════════════════════════╗');
console.log(`║  TEST SUMMARY                                              ║`);
console.log('╚════════════════════════════════════════════════════════════╝\n');
console.log(`✅ Tests Passed: ${testsPassed}`);
console.log(`❌ Tests Failed: ${testsFailed}`);
console.log(`📊 Total Tests:  ${testsPassed + testsFailed}`);
console.log(`📈 Pass Rate:    ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%\n`);

if (testsFailed === 0) {
  console.log('🎉 ALL TESTS PASSED!\n');
  process.exit(0);
} else {
  console.log(`⚠️  ${testsFailed} test(s) failed\n`);
  process.exit(1);
}
