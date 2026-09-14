const assert = require('assert');
const test = require('node:test');

const GarvonixHarmonizer = require('../src/core/feeds/garvonix-harmonizer');
const RenderScheduler = require('../src/core/feeds/render-scheduler');

function amplitude(samples) {
  return Math.max(...samples) - Math.min(...samples);
}

function runSine({ frequencyHz, durationSeconds = 10, amplitude = 10, base = 100 }) {
  const raw = [];
  const filtered = [];
  const samples = Math.round(20 * durationSeconds);
  for (let index = 0; index < samples; index += 1) {
    const price = base + amplitude * Math.sin(2 * Math.PI * frequencyHz * (index / 20));
    const result = GarvonixHarmonizer.onTick('BTC', price, {
      publishTime: 1_000_000_000_000 + index * 50,
    });
    raw.push(price);
    if (result) filtered.push(result.filteredPrice);
  }
  return { raw, filtered };
}

test('GarvonixHarmonizer cancels configured cross-frequency tones', () => {
  GarvonixHarmonizer.resetForTesting();
  GarvonixHarmonizer.configure({
    sampleHz: 20,
    outputHz: 20,
    rolloffHz: 0.25,
    notchHz: [1, 2],
  });

  const { raw, filtered } = runSine({ frequencyHz: 1, durationSeconds: 10, amplitude: 10 });
  const half = Math.floor(filtered.length / 2);
  const rawAmplitude = amplitude(raw.slice(half));
  const filteredAmplitude = amplitude(filtered.slice(half));

  assert.ok(filteredAmplitude < rawAmplitude * 0.3, {
    rawAmplitude,
    filteredAmplitude,
  });
  assert.ok(GarvonixHarmonizer.getStats('BTC').suppressionRatio > 0.5);
});

test('GarvonixHarmonizer rolls off low-frequency residual components', () => {
  GarvonixHarmonizer.resetForTesting();
  GarvonixHarmonizer.configure({
    sampleHz: 20,
    outputHz: 20,
    rolloffHz: 0.5,
    notchHz: [],
  });
  const aggressive = runSine({ frequencyHz: 0.02, durationSeconds: 20, amplitude: 10 });
  const aggressiveAmplitude = amplitude(aggressive.filtered.slice(32));

  GarvonixHarmonizer.resetForTesting();
  GarvonixHarmonizer.configure({
    sampleHz: 20,
    outputHz: 20,
    rolloffHz: 0.01,
    notchHz: [],
  });
  const gentle = runSine({ frequencyHz: 0.02, durationSeconds: 20, amplitude: 10 });
  const gentleAmplitude = amplitude(gentle.filtered.slice(32));

  assert.ok(aggressiveAmplitude < gentleAmplitude * 0.25, {
    aggressiveAmplitude,
    gentleAmplitude,
  });
});

test('GarvonixHarmonizer decimates the 20Hz Pyth stream without aliasing gaps', () => {
  GarvonixHarmonizer.resetForTesting();
  GarvonixHarmonizer.configure({
    sampleHz: 20,
    outputHz: 10,
    rolloffHz: 0.25,
    notchHz: [1, 2],
  });

  let emitted = 0;
  for (let index = 0; index < 100; index += 1) {
    const result = GarvonixHarmonizer.onTick('SOL', 100 + index, {
      publishTime: 1_000_000_000_000 + index * 50,
    });
    if (result) emitted += 1;
  }

  assert.strictEqual(emitted, 50);
  assert.strictEqual(GarvonixHarmonizer.getSamples('SOL').length, 50);
  assert.strictEqual(GarvonixHarmonizer.getStats('SOL').skipped, 50);
});

test('GarvonixHarmonizer rejects invalid ticks and reports missing symbols safely', () => {
  GarvonixHarmonizer.resetForTesting();
  GarvonixHarmonizer.configure({ sampleHz: 20, outputHz: 20, rolloffHz: 0.25, notchHz: [] });

  assert.strictEqual(GarvonixHarmonizer.onTick('', 100), null);
  assert.strictEqual(GarvonixHarmonizer.onTick('BTC', Number.NaN), null);
  assert.strictEqual(GarvonixHarmonizer.onTick('BTC', -1), null);
  assert.strictEqual(GarvonixHarmonizer.onTick('BTC', 0), null);
  assert.strictEqual(GarvonixHarmonizer.getStats('BTC'), null);
  assert.strictEqual(GarvonixHarmonizer.getFilteredPrice('BTC'), null);
  assert.deepStrictEqual(GarvonixHarmonizer.getSamples('BTC'), []);
});

test('RenderScheduler preserves the latest harmonized sample across decimation skips', () => {
  RenderScheduler.resetForTesting();
  GarvonixHarmonizer.configure({
    sampleHz: 20,
    outputHz: 10,
    rolloffHz: 0.25,
    notchHz: [1, 2],
  });

  global.window = {
    _pythPrices: {},
    _pythPythMetadata: {},
    _pythFilteredPrices: {},
    _pythResidualSignals: {},
    dispatchEvent: () => {},
  };
  global.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  RenderScheduler.onPythTick('BTC', 100, { publishTime: 1_000_000_000_000 });
  RenderScheduler.onPythTick('BTC', 101, { publishTime: 1_000_000_000_050 });
  RenderScheduler.onPythTick('BTC', 102, { publishTime: 1_000_000_000_100 });
  RenderScheduler.flush();

  assert.strictEqual(global.window._pythPrices.BTC, 102);
  assert.strictEqual(global.window._pythFilteredPrices.BTC, 101);
  assert.ok(Number.isFinite(global.window._pythResidualSignals.BTC));
  assert.strictEqual(RenderScheduler.getLatestPrice('BTC').price, 102);
});
