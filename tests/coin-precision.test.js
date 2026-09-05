const test = require('node:test');
const assert = require('node:assert/strict');
const CoinPrecision = require('../src/shared/coin-precision');
const SignalMath = require('../src/shared/signal-math');

test('CoinPrecision: BTC and ETH have exactly 2 decimals (.00 cents)', () => {
  assert.equal(CoinPrecision.getCoinDecimals('BTC'), 2);
  assert.equal(CoinPrecision.getCoinDecimals('ETH'), 2);
  assert.equal(CoinPrecision.getCoinDecimals('btc-updown-15m-1725450000'), 2);
  assert.equal(CoinPrecision.getCoinDecimals('KXETH15M'), 2);

  // Spot prices
  assert.equal(CoinPrecision.formatCoinPrice('BTC', 65432.1), '$65,432.10');
  assert.equal(CoinPrecision.formatCoinPrice('BTC', 65432), '$65,432.00');
  assert.equal(CoinPrecision.formatCoinPrice('ETH', 3456.7), '$3,456.70');
  assert.equal(CoinPrecision.formatCoinPrice('ETH', 3456.789), '$3,456.79');

  // Deltas
  assert.equal(CoinPrecision.formatCoinDelta('BTC', 12.5), '+$12.50');
  assert.equal(CoinPrecision.formatCoinDelta('BTC', -45.1), '-$45.10');
  assert.equal(CoinPrecision.formatCoinDelta('ETH', 0.5), '+$0.50');
});

test('CoinPrecision: XRP has exactly 4 decimals (.0000) and never truncates to 2 cents', () => {
  assert.equal(CoinPrecision.getCoinDecimals('XRP'), 4);
  assert.equal(CoinPrecision.getCoinDecimals('xrp-updown-5m-1725450000'), 4);
  assert.equal(CoinPrecision.getCoinDecimals('KXXRP15M'), 4);

  // Sub-dollar XRP
  assert.equal(CoinPrecision.formatCoinPrice('XRP', 0.5842), '$0.5842');
  assert.equal(CoinPrecision.formatCoinPrice('XRP', 0.58), '$0.5800');

  // XRP >= $1.00 MUST preserve .0000 (bug was truncating to $1.20)
  assert.equal(CoinPrecision.formatCoinPrice('XRP', 1.2), '$1.2000');
  assert.equal(CoinPrecision.formatCoinPrice('XRP', 1.2543), '$1.2543');

  // Deltas for XRP
  assert.equal(CoinPrecision.formatCoinDelta('XRP', 0.0025), '+$0.0025');
  assert.equal(CoinPrecision.formatCoinDelta('XRP', -0.0012), '-$0.0012');
  assert.equal(CoinPrecision.formatCoinDelta('XRP', 0.0005), '+$0.0005');
});

test('CoinPrecision: DOGE, SOL, BNB, HYPE decimal rules', () => {
  // DOGE is sub-cent with 4 decimals
  assert.equal(CoinPrecision.getCoinDecimals('DOGE'), 4);
  assert.equal(CoinPrecision.formatCoinPrice('DOGE', 0.1345), '$0.1345');
  assert.equal(CoinPrecision.formatCoinPrice('DOGE', 0.13), '$0.1300');
  assert.equal(CoinPrecision.formatCoinDelta('DOGE', 0.0008), '+$0.0008');

  // SOL, BNB, HYPE have 2 decimals (.00 cents)
  assert.equal(CoinPrecision.getCoinDecimals('SOL'), 2);
  assert.equal(CoinPrecision.getCoinDecimals('BNB'), 2);
  assert.equal(CoinPrecision.getCoinDecimals('HYPE'), 2);
  assert.equal(CoinPrecision.formatCoinPrice('SOL', 142.8), '$142.80');
  assert.equal(CoinPrecision.formatCoinPrice('BNB', 582.4), '$582.40');
  assert.equal(CoinPrecision.formatCoinPrice('HYPE', 34.1), '$34.10');
});

test('CoinPrecision: Symbol normalization handles all slug formats', () => {
  assert.equal(CoinPrecision.normalizeCoinSymbol('btc-updown-15m-1725450000'), 'BTC');
  assert.equal(CoinPrecision.normalizeCoinSymbol('eth-5m-1725450000'), 'ETH');
  assert.equal(CoinPrecision.normalizeCoinSymbol('KXXRP15M'), 'XRP');
  assert.equal(CoinPrecision.normalizeCoinSymbol('KXDOGE5M'), 'DOGE');
  assert.equal(CoinPrecision.normalizeCoinSymbol('sol/usd'), 'SOL');
  assert.equal(CoinPrecision.normalizeCoinSymbol('BNB-USD'), 'BNB');
  assert.equal(CoinPrecision.normalizeCoinSymbol({ sym: 'XRP' }), 'XRP');
  assert.equal(CoinPrecision.normalizeCoinSymbol({ slug: 'doge-updown-15m' }), 'DOGE');
});

test('CoinPrecision: SignalMath integration', () => {
  assert.equal(SignalMath.formatCoinPrice('BTC', 70123.4), '$70,123.40');
  assert.equal(SignalMath.formatCoinPrice('XRP', 0.5912), '$0.5912');
  assert.equal(SignalMath.formatCoinDelta('XRP', 0.003), '+$0.0030');
  assert.equal(SignalMath.getCoinDecimals('ETH'), 2);
  assert.equal(SignalMath.getCoinDecimals('XRP'), 4);
});
