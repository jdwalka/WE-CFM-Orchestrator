const assert = require('assert');
const path = require('path');

const LivePath15m = require(path.join(__dirname, '..', 'src', 'llm', 'live-path-15m.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

test('spot below PTB paints DOWN even if model/Grok is UP', () => {
  const r = LivePath15m.resolve('BTC', {
    spot: 64000,
    poly15m: { priceToBeatNum: 64500, priceToBeatSource: 'polymarket', yesProb: 0.62 },
    modelScore: 0.8,
  });
  assert.strictEqual(r.dir, 'DOWN');
  assert.ok(r.bps < 0);
  assert.ok(r.sources.includes('spot_vs_ptb'));
});

test('spot above PTB paints UP even if crowd YES is cheap', () => {
  const r = LivePath15m.resolve('ETH', {
    spot: 1910,
    poly15m: { priceToBeatNum: 1900, priceToBeatSource: 'polymarket', yesProb: 0.31 },
    modelScore: -0.7,
  });
  assert.strictEqual(r.dir, 'UP');
  assert.ok(r.bps > 0);
});

test('tiny noise inside 0.8 bps does not invent a path from the model', () => {
  const r = LivePath15m.resolve('SOL', {
    spot: 100.0004,
    poly15m: { priceToBeatNum: 100, priceToBeatSource: 'polymarket', yesProb: 0.50 },
    modelScore: 0.9,
  });
  assert.ok(Math.abs(r.bps) < LivePath15m.PATH_BPS_MIN);
  assert.strictEqual(r.dir, null);
});

test('rejected PTB source is ignored so we do not paint on a fake floor', () => {
  const r = LivePath15m.resolve('BTC', {
    spot: 64000,
    poly15m: { priceToBeatNum: 70000, priceToBeatSource: 'rejected:title', yesProb: 0.80 },
  });
  assert.strictEqual(r.ptb, null);
  assert.notStrictEqual(r.dir, 'DOWN');
});

test('tick momentum contributes when PTB is missing', () => {
  LivePath15m.noteTick('XRP', 2.00, 1_000);
  LivePath15m.noteTick('XRP', 2.00, 1_200);
  LivePath15m.noteTick('XRP', 2.04, 8_000);
  const r = LivePath15m.resolve('XRP', {
    spot: 2.04,
    ts: 8_000,
    poly15m: { yesProb: 0.51 },
  });
  assert.strictEqual(r.dir, 'UP');
  assert.ok(r.sources.includes('tick_momentum'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
