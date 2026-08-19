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

test('402 is a credit error; timeout is not', () => {
  assert.strictEqual(orch.isCreditError({ status: 402 }), true);
  assert.strictEqual(orch.isCreditError(new Error('out of credits on tokenmix')), true);
  assert.strictEqual(orch.isCreditError(new Error('HTTP 402 payment required')), true);
  assert.strictEqual(orch.isCreditError({ status: 504, message: 'timeout' }), false);
});

test('generic billing or 429 quota copy is not permanent credit exhaustion', () => {
  assert.strictEqual(orch.isCreditError(new Error('billing portal unavailable')), false);
  assert.strictEqual(orch.isCreditError(new Error('prepaid plan details')), false);
  assert.strictEqual(orch.isCreditError({ status: 429, message: 'quota exceeded' }), false);
  assert.strictEqual(orch.isCreditError(new Error('request-id 4021abc timeout')), false);
});

test('CREDIT_RES patterns require explicit credit-exhaustion phrasing, not generic lookalikes', () => {
  assert.strictEqual(orch.isCreditError(new Error('no credit check required for this trial')), false);
  assert.strictEqual(orch.isCreditError(new Error('promo: no credit card required')), false);
  assert.strictEqual(orch.isCreditError(new Error('server load balance too low, retrying')), false);
  assert.strictEqual(orch.isCreditError(new Error('no credits remaining on this account')), true);
  assert.strictEqual(orch.isCreditError(new Error('account balance too low to continue')), true);
});

test('roster walks every ASI1 model and prefers the requested one first', () => {
  assert.ok(orch.ASI1_ALL_MODELS.includes('asi1-ultra'));
  assert.ok(orch.ASI1_ALL_MODELS.includes('asi1'));
  assert.ok(orch.ASI1_ALL_MODELS.includes('asi1-mini'));
  const r = orch.rosterFor({ model: 'asi1-fast' });
  assert.strictEqual(r[0], 'asi1-fast');
  assert.ok(r.includes('asi1-ultra') && r.includes('asi1-mini') && r.includes('asi1'));
});

test('reshapeCascade drops tokenmix and pins asi1 when credits are gone', () => {
  const assistant = { _tokenmixCreditExhausted: true };
  const next = orch.reshapeCascade(['tokenmix', 'xai', 'google'], assistant);
  assert.deepStrictEqual(next, ['asi1', 'xai', 'google']);
});

test('markTokenmixExhausted only fires on credit errors', () => {
  const a = { _providerCooldowns: {} };
  assert.strictEqual(orch.markTokenmixExhausted(a, new Error('ECONNRESET')), false);
  assert.strictEqual(orch.markTokenmixExhausted(a, { status: 402, message: 'payment required' }), true);
  assert.strictEqual(a._tokenmixCreditExhausted, true);
  assert.ok(orch.shouldSkipTokenmix(a));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
