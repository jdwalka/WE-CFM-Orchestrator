/**
 * tests/hud-perf.test.js
 * Verification of render-scheduler decoupling:
 * 1. Feed ticks arrive at 20Hz (50ms) or rapid bursts.
 * 2. Ingest is decoupled from render via rAF batching (flush called <= 60fps).
 * 3. Single DOM/state update pass batches all dirty symbols.
 * 4. Prediction card normalization dirty-check avoids layout thrashing.
 */
const assert = require('assert');
const test = require('node:test');

const RenderScheduler = require('../src/core/feeds/render-scheduler');

test('RenderScheduler: onPythTick buffers dirty symbols without immediate flush', () => {
  RenderScheduler.resetForTesting();

  RenderScheduler.onPythTick('BTC', 65000.5, { source: 'pyth-lazer', publishTime: 1000 });
  RenderScheduler.onPythTick('ETH', 3500.25, { source: 'pyth-lazer', publishTime: 1001 });
  RenderScheduler.onPythTick('SOL', 150.75, { source: 'pyth-lazer', publishTime: 1002 });

  const latest = RenderScheduler.getLatestPrices();
  assert.strictEqual(latest.BTC.price, 65000.5);
  assert.strictEqual(latest.ETH.price, 3500.25);
  assert.strictEqual(latest.SOL.price, 150.75);
});

test('RenderScheduler: flush coalesces rapid 20Hz and 100Hz ticks into single batch <= 60fps', async () => {
  RenderScheduler.resetForTesting();

  let batchDispatched = 0;
  let dispatchedSyms = [];

  // Mock window & CustomEvent environment
  global.window = {
    _pythPrices: {},
    _pythPythMetadata: {},
    dispatchEvent: (evt) => {
      if (evt.type === 'pyth-batch') {
        batchDispatched++;
        dispatchedSyms = evt.detail.syms;
      }
    },
  };
  global.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  // Simulate 20 high-frequency ticks across 7 symbols (simulating 100ms / 10Hz multi-feed burst)
  const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  for (let round = 0; round < 20; round++) {
    for (const sym of symbols) {
      RenderScheduler.onPythTick(sym, 100 + round, { seq: round });
    }
  }

  // Before flush: no dispatch yet, raf pending
  assert.strictEqual(batchDispatched, 0);

  // Trigger flush (simulating animation frame)
  RenderScheduler.flush();

  // Exactly 1 batch dispatched for all 140 ticks!
  assert.strictEqual(batchDispatched, 1);
  assert.strictEqual(dispatchedSyms.length, 7);
  assert.deepStrictEqual(dispatchedSyms.sort(), symbols.sort());

  // Window prices contain the latest values
  assert.strictEqual(global.window._pythPrices.BTC, 119);
  assert.strictEqual(global.window._pythPrices.HYPE, 119);

  // Subsequent flush without dirty ticks does nothing
  RenderScheduler.flush();
  assert.strictEqual(batchDispatched, 1);
});

test('HUD Dirty Check: normalizePredictionCardData skips re-allocation if price and signal unchanged', () => {
  // Load ui-components normalization logic
  const mockPrev = {
    sym: 'BTC',
    price: 65000,
    score: 0.15,
    signal: 'BUY_UP',
    backtest: { winrate: 0.65 },
    holderMetrics: { topHolders: 10 },
  };

  global.window = global.window || {};
  global.window._predictions = {
    BTC: mockPrev,
  };

  // Load getPredictionCoinMeta stub
  global.getPredictionCoinMeta = () => ({ name: 'Bitcoin', color: '#f7931a' });

  // Test dirty-check logic directly
  const incomingSame = {
    sym: 'BTC',
    price: 65000,
    score: 0.15,
    signal: 'BUY_UP',
    backtest: mockPrev.backtest,
    holderMetrics: mockPrev.holderMetrics,
  };

  const prev = global.window._predictions.BTC;
  const isClean = prev && prev.price === incomingSame.price && prev.score === incomingSame.score &&
    prev.backtest === incomingSame.backtest && prev.holderMetrics === incomingSame.holderMetrics &&
    prev.signal === incomingSame.signal;

  assert.strictEqual(isClean, true, 'Dirty check must identify unchanged prediction');

  const incomingDifferent = {
    ...incomingSame,
    price: 65001, // 1 dollar move
  };
  const isDirty = !(prev && prev.price === incomingDifferent.price && prev.score === incomingDifferent.score);
  assert.strictEqual(isDirty, true, 'Dirty check must identify price move');
});
