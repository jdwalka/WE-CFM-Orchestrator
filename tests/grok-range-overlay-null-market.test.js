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

test('hourly snapshots exclude 15m contract inference and expose fixed buckets', () => {
  global.window = global.window || {};
  global.window.PredictionMarkets = {
    getCoin: () => ({
      kalshi15m: {
        ticker: 'KXBTC-15M-TEST',
        probability: 0.7,
        closeTime: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  };
  global.window.HourlyRangesPanel = {
    getRanges: () => [
      { low: 76000, high: 76099.99, prob: 0.4, yesBid: 0.39, yesAsk: 0.41 },
      { low: 76100, high: 76199.99, prob: 0.3, yesBid: 0.29, yesAsk: 0.31 },
    ],
  };

  const snapshot = GrokRangeOverlay.buildRangeSnapshot('BTC', 60);
  assert.equal(snapshot.kalshi15m, null);
  assert.equal(snapshot.poly15m, null);
  assert.equal(snapshot.activeContract, null);
  assert.equal(snapshot.fixedInterval, true);
  assert.equal(snapshot.fixedIntervalMinutes, 60);
  assert.equal(snapshot.hourlyBuckets.length, 2);
  assert.equal(snapshot.spotBucket, null);
  assert.deepEqual(snapshot.oracleWarnings, []);
});
