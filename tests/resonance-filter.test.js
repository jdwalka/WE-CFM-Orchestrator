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

test('createHzTracker converges to exactly 10Hz at 100ms ticks', () => {
  const h = createHzTracker(0.5);
  let t = 0;
  let out = null;
  for (let i = 0; i < 50; i++) {
    out = h.tick(t);
    t += 100; // 100ms ticks == 10 Hz
  }
  assert.ok(out > 9.5 && out < 10.5, `expected ~10Hz, got ${out}`);
  assert.ok(h.hz > 9.5 && h.hz < 10.5, `expected h.hz ~10, got ${h.hz}`);
});

test('createLowPassFilter(2) at 100ms cadence damps noise without overshoot or resonance', () => {
  const f = createLowPassFilter(2);
  let t = 0;
  f.update(100, t);
  // Introduce 100ms alternating noise (+-2 dollars)
  const outputs = [];
  for (let i = 0; i < 20; i++) {
    t += 100;
    const noisyPrice = 100 + (i % 2 === 0 ? 2 : -2);
    const out = f.update(noisyPrice, t);
    outputs.push(out);
  }
  // Filtered price should stay well within the noise bounds [98, 102] and never overshoot
  for (const out of outputs) {
    assert.ok(out >= 98 && out <= 102, `expected filtered price in [98, 102], got ${out}`);
  }
  // Standard deviation of output should be lower than input noise
  const mean = outputs.reduce((a, b) => a + b, 0) / outputs.length;
  assert.ok(Math.abs(mean - 100) < 0.5, `mean should be ~100, got ${mean}`);
});

test('createLowPassFilter reseeds cleanly after a long network disconnection gap (>3s)', () => {
  const f = createLowPassFilter(2);
  f.update(100, 0);
  f.update(101, 100);
  // Disconnection gap of 5 seconds (5000ms), market moves to 120
  const out = f.update(120, 5100);
  assert.strictEqual(out, 120, 'must reseed directly to new price after gap > 3s, avoiding multi-second lag');
});

test('createLowPassFilter supports a custom residual gap-reseed threshold', () => {
  const f = createLowPassFilter(2, 1000);
  f.update(100, 0);
  f.update(101, 100);
  const out = f.update(120, 1200);
  assert.strictEqual(out, 120, 'a 1.1s Pyth feed gap must not be smoothed into the residual signal');
  assert.throws(() => createLowPassFilter(2, -1));
});

test('50ms Pyth residual filter reseeds after a 250ms feed discontinuity', () => {
  const f = createLowPassFilter(2, 250);
  f.update(100, 0);
  f.update(100, 50);

  const shortGapOut = f.update(120, 300);
  assert.ok(shortGapOut > 100 && shortGapOut < 120, `150ms jitter should remain smoothed, got ${shortGapOut}`);

  f.update(120, 350);
  const discontinuityOut = f.update(130, 610);
  assert.strictEqual(discontinuityOut, 130, 'a >250ms 50ms-feed discontinuity must reseed, not lag residuals');
});

test('createHzTracker handles a reconnection pause without dragging smoothed Hz down', () => {
  const h = createHzTracker(0.5);
  let t = 0;
  for (let i = 0; i < 30; i++) {
    h.tick(t);
    t += 100;
  }
  assert.ok(h.hz > 9 && h.hz < 11, `expected ~10Hz before disconnect, got ${h.hz}`);
  // Simulate 10-second gap
  t += 10000;
  h.tick(t);
  // Next 100ms ticks resume
  for (let i = 0; i < 5; i++) {
    t += 100;
    h.tick(t);
  }
  assert.ok(h.hz > 8 && h.hz < 12, `expected rapid recovery near 10Hz without prolonged drag, got ${h.hz}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
