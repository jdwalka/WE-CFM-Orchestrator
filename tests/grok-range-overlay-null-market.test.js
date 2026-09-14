const assert = require('assert');
const test = require('node:test');

const GrokRangeOverlay = require('../src/llm/grok-range-overlay');

test('buildRangeSnapshot handles a missing Kalshi 15m market', () => {
  global.window = global.window || {};
  global.window.PredictionMarkets = {
    getCoin: () => ({}),
  };
  global.window.HourlyRangesPanel = {
    get15mMarket: () => null,
    getRanges: () => [],
  };

  const snapshot = GrokRangeOverlay.buildRangeSnapshot('BTC', 15);
  assert.equal(snapshot.kalshi15m.live, false);
  assert.equal(snapshot.kalshi15m.ticker, null);
  assert.equal(snapshot.kalshi15m.yesProb, 0.5);
  assert.equal(snapshot.poly15m.priceToBeatNum, null);
  assert.equal(snapshot.activeContract, snapshot.kalshi15m);
  assert.ok(snapshot.oracleWarnings.includes('no_kalshi_strike'));
});
