const assert = require('assert');
const path = require('path');

const { createLowPassFilter, createHzTracker } = require(path.join(__dirname, '..', 'src', 'infra', 'resonance-filter.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (err) { failed += 1; console.error(`FAIL ${name}`); console.error(err); }
}

test('createLowPassFilter rejects a non-positive cutoff', () => {
  assert.throws(() => createLowPassFilter(0));
  assert.throws(() => createLowPassFilter(-5));
});

test('first update seeds the filter at the raw value, no smoothing lag on the very first sample', () => {
  const f = createLowPassFilter(1);
  const out = f.update(100, 0);
  assert.strictEqual(out, 100);
  assert.strictEqual(f.value, 100);
});

test('a low cutoff heavily damps a single-sample spike', () => {
  const f = createLowPassFilter(0.1); // very slow filter
  f.update(100, 0);
  const out = f.update(200, 100); // 100ms later, big jump
  assert.ok(out > 100 && out < 110, `expected small movement toward 200, got ${out}`);
});

test('a high cutoff tracks the raw signal closely', () => {
  const f = createLowPassFilter(1000); // very fast filter, dt in seconds is tiny here
  f.update(100, 0);
  const out = f.update(200, 100);
  assert.ok(out > 195, `expected near-full jump to 200 with a fast cutoff, got ${out}`);
});

test('converges to a constant input over repeated samples', () => {
  const f = createLowPassFilter(2);
  let t = 0;
  let out = f.update(50, t);
  for (let i = 0; i < 50; i++) {
    t += 50;
    out = f.update(50, t);
  }
  assert.ok(Math.abs(out - 50) < 0.01, `expected convergence to 50, got ${out}`);
});

test('ignores a non-finite value and returns the last good filtered value', () => {
  const f = createLowPassFilter(1);
  f.update(100, 0);
  const out = f.update(NaN, 100);
  assert.strictEqual(out, 100);
});

test('a duplicate timestamp (dt=0) does not divide by zero or move the filter', () => {
  const f = createLowPassFilter(1);
  f.update(100, 0);
  const out = f.update(999, 0); // same timestamp as previous update
  assert.strictEqual(out, 100, 'zero-dt tick must not perturb the filtered value');
});

test('reset() clears filter state back to unseeded', () => {
  const f = createLowPassFilter(1);
  f.update(100, 0);
  f.reset();
  assert.strictEqual(f.value, null);
  const out = f.update(50, 100);
  assert.strictEqual(out, 50, 'post-reset first update should seed again, not smooth against stale state');
});

test('createHzTracker returns null on the very first tick (no interval yet)', () => {
  const h = createHzTracker(0.5);
  const out = h.tick(0);
  assert.strictEqual(out, null);
  assert.strictEqual(h.sampleCount, 1);
});

test('createHzTracker converges to the true rate for evenly spaced ticks', () => {
  const h = createHzTracker(2); // fast-settling smoothing for this test
  let t = 0;
  let out = null;
  for (let i = 0; i < 100; i++) {
    out = h.tick(t);
    t += 50; // 50ms apart == 20Hz
  }
  assert.ok(out > 19 && out < 21, `expected ~20Hz, got ${out}`);
  assert.ok(h.hz > 19 && h.hz < 21, `expected h.hz ~20, got ${h.hz}`);
});

test('createHzTracker smooths a single jittery gap instead of reading it as a rate change', () => {
  const h = createHzTracker(0.5);
  let t = 0;
  h.tick(t);
  for (let i = 0; i < 20; i++) { t += 50; h.tick(t); } // settle at 20Hz
  const settledHz = h.hz;
  t += 5; // one anomalously fast 5ms gap (e.g. reconnect replay burst)
  const spikedOut = h.tick(t);
  // a single fast gap should move the estimate only modestly, not jump to 200Hz
  assert.ok(spikedOut < 60, `expected damped response to one jittery gap, got ${spikedOut}`);
  assert.ok(spikedOut > settledHz * 0.5, 'a single gap should not collapse the smoothed rate either');
});

test('createHzTracker.reset() clears sample count and last-tick state', () => {
  const h = createHzTracker(1);
  h.tick(0);
  h.tick(50);
  h.reset();
  assert.strictEqual(h.sampleCount, 0);
  assert.strictEqual(h.hz, null);
  const out = h.tick(1000);
  assert.strictEqual(out, null, 'first tick after reset has no prior interval');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
