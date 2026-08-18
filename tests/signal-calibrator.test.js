const assert = require('assert');
const path = require('path');

const calibratorPath = path.resolve(__dirname, '../src/ml/signal-calibrator.js');
delete require.cache[calibratorPath];
const Calibrator = require(calibratorPath);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Calibrator.reset();
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

console.log('\n[SignalCalibrator] live-first blend + model cap');

test('path + AI consensus ignores a conflicting model baseline', () => {
  const out = Calibrator.blend({
    sym: 'BTC',
    call: 'UP',
    confidence: 0.72,
    modelScore: -0.8,
    market: {
      spot: 65020,
      ptb: 64980,
      yesProb: 0.63,
      depthImbalance: 0.22,
    },
  });
  assert.strictEqual(out.call, 'UP');
  assert.strictEqual(out.modelCapped, true);
  assert.ok(out.components.some((c) => c.source === 'model' && /capped/.test(c.detail)));
});

test('late window prefers spot-vs-PTB over a fading AI call', () => {
  const out = Calibrator.blend({
    sym: 'ETH',
    call: 'UP',
    confidence: 0.58,
    modelScore: 0.4,
    secondsToClose: 40,
    market: {
      spot: 2400,
      ptb: 2412,
      yesProb: 0.41,
    },
  });
  assert.strictEqual(out.call, 'DOWN');
  assert.strictEqual(out.source, 'path_late');
});

test('online record shrinks model weight when it loses', () => {
  for (let i = 0; i < 12; i += 1) {
    Calibrator.record('SOL', '5m', { ai: 'UP', model: 'DOWN', blend: 'UP' }, 'UP');
  }
  const st = Calibrator.stats('SOL');
  assert.ok(st.ai.wr > 0.9);
  assert.ok(st.model.wr < 0.1);
  assert.ok(st.weights.model < Calibrator.BASE_WEIGHTS.model);
  assert.ok(st.weights.model <= Calibrator.MODEL_PRIOR_CAP);
});

test('model weight never exceeds the prior cap', () => {
  for (let i = 0; i < 20; i += 1) {
    Calibrator.record('BTC', '15m', { ai: 'DOWN', model: 'UP', blend: 'UP' }, 'UP');
  }
  const w = Calibrator.adaptiveWeights('BTC');
  assert.ok(w.model <= Calibrator.MODEL_PRIOR_CAP + 1e-9);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
