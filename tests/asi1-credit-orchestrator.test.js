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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
