const assert = require('assert');
const path = require('path');

const orch = require(path.join(__dirname, '..', 'src', 'llm', 'asi1-credit-orchestrator.js'));
const math = require(path.join(__dirname, '..', 'src', 'shared', 'signal-math.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (err) { failed += 1; console.error(`FAIL ${name}`); console.error(err); }
}

test('signal-math clamp / num / normCall', () => {
  assert.strictEqual(math.clamp(5, 0, 1), 1);
  assert.strictEqual(math.num('3.2'), 3.2);
  assert.strictEqual(math.num('x'), null);
  assert.strictEqual(math.normCall('buy_up'), 'UP');
  assert.strictEqual(math.normCall('short'), 'DOWN');
  assert.strictEqual(math.normSym('btc'), 'BTC');
});


test('roster walks every ASI1 model and prefers the requested one first', () => {
  assert.ok(orch.ASI1_ALL_MODELS.includes('asi1-ultra'));
  assert.ok(orch.ASI1_ALL_MODELS.includes('asi1'));
  assert.ok(orch.ASI1_ALL_MODELS.includes('asi1-mini'));
  const r = orch.rosterFor({ model: 'asi1-fast' });
  assert.strictEqual(r[0], 'asi1-fast');
  assert.ok(r.includes('asi1-mini'));
});

test('desk mode defaults to asi1_only (ASI1 is the sole inference provider)', () => {
  assert.strictEqual(orch.getMode(), 'asi1_only');
});

test('planner/reasoning mode is available on non-5m horizons when explicitly enabled', () => {
  const restore = orch.getMode();
  orch.setMode('planner');
  assert.strictEqual(orch.plannerEnabled('5m'), false);
  assert.strictEqual(orch.plannerEnabled('15m'), true);
  orch.setMode(restore);
});

test('hourly horizon spec maps to 3600s interval and tags', () => {
  const spec = orch._horizonSpec('1h');
  assert.strictEqual(spec.intervalSec, 3600);
  assert.deepStrictEqual(spec.tags, ['1h', '60m']);
});

(async () => {
  try {
    const hourlyPkt = {
      sym: 'BTC',
      horizon: '1h',
      isHourly: true,
      spot: 68450.25,
      hourlyLadder: [
        { low: 68300, high: 68400, yesAsk: 0.20, prob: 0.20 },
        { low: 68400, high: 68500, yesAsk: 0.50, prob: 0.50 },
        { low: 68500, high: 68600, yesAsk: 0.25, prob: 0.25 },
      ],
      spotBucket: { low: 68400, high: 68500, yesProb: 0.50 },
      secondsToClose: 1800,
    };
    const res = await orch.deskInfer(hourlyPkt, 'asi1_only');
    assert.ok(res.ok, 'Expected ok: true');
    assert.ok(res.contract, 'Expected contract in res');
    assert.ok(hourlyPkt.priceToBeatNum > 0, 'Hourly PTB should be anchored');
    assert.strictEqual(hourlyPkt.priceToBeatSource, 'hourly-range-ladder');
    assert.strictEqual(hourlyPkt.priceToBeatNum, 68450);
    passed += 1;
    console.log('PASS deskInfer resolves hourly packet without waiting for binary PTB');
  } catch (err) {
    failed += 1;
    console.error('FAIL deskInfer resolves hourly packet without waiting for binary PTB');
    console.error(err);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
