const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '..', 'src', 'llm', 'grok-analytics-memory.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const PTB_WINDOW_MS = 5 * 60_000;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

// Controllable fake clock — Date.now() reads whatever `nowMs` currently is,
// and tests advance it explicitly to cross 5-minute PTB window boundaries.
function createFakeClock(startMs) {
  let nowMs = startMs;
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() {
      return nowMs;
    }
  }
  return {
    DateClass: FakeDate,
    set(ms) { nowMs = ms; },
    advance(deltaMs) { nowMs += deltaMs; },
  };
}

function floorWindow(ts, ms) {
  return Math.floor(ts / ms) * ms;
}

// Market fixture: mutable price/PTB per coin, read by window.PredictionMarkets.
function createMarketState() {
  const state = {};
  return {
    set(coin, { price, ptb }) {
      state[coin] = { price, ptb };
    },
    predictionMarkets: {
      getPrice(coin) {
        return state[coin] ? state[coin].price : null;
      },
      getMarket(coin) {
        if (!state[coin]) return null;
        return { poly5m: { priceToBeatNum: state[coin].ptb } };
      },
    },
  };
}

function createHarness({ startMs, bridge } = {}) {
  const clock = createFakeClock(startMs);
  const market = createMarketState();
  const window = {
    PredictionMarkets: market.predictionMarkets,
  };
  if (bridge) window._grokMemoryBridge = bridge;

  const context = {
    window,
    console,
    Date: clock.DateClass,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: sourcePath });
  return { clock, market, hooks: window.GrokAnalyticsMemory };
}

function makeSpyBridge(overrides = {}) {
  const calls = { pushTick: [], pushPtbWindowClose: [], writeSessionSnapshot: [] };
  return {
    calls,
    pushTick: (coin, payload) => calls.pushTick.push({ coin, payload }),
    pushPtbWindowClose: (record) => calls.pushPtbWindowClose.push(record),
    writeSessionSnapshot: (coin, snapshot) => calls.writeSessionSnapshot.push({ coin, snapshot }),
    getPtbDefenseStats: overrides.getPtbDefenseStats || (() => Promise.resolve({ success: false, stats: null })),
    getSessionSnapshot: overrides.getSessionSnapshot || (() => Promise.resolve({ success: false, snapshot: null })),
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

(async () => {
  console.log('\n[GrokAnalyticsMemory] regression + PTB defense tests');

  await test('fail-open: no bridge present behaves like today (no throw, sane pack)', async () => {
    const startMs = Date.UTC(2026, 5, 18, 10, 0, 30);
    const { hooks, market } = createHarness({ startMs });
    market.set('BTC', { price: 65000, ptb: 64950 });

    assert.doesNotThrow(() => hooks.tick());
    assert.doesNotThrow(() => hooks.tick());

    const pack = hooks.memoryPackForPrompt('BTC');
    assert.strictEqual(pack.coin, 'BTC');
    assert.strictEqual(pack.sampleCount, 2);
    assert.strictEqual(pack.ptbDefenseStats, null, 'no opts.ptb passed -> null, not a throw');

    // Explicitly passing opts.ptb with no bridge/cache still yields null, never throws.
    const packWithPtb = hooks.memoryPackForPrompt('BTC', { ptb: 64950 });
    assert.strictEqual(packWithPtb.ptbDefenseStats, null);
  });

  await test('PTB window that never crosses the PTB closes as DEFENDED', async () => {
    const startMs = Date.UTC(2026, 5, 18, 10, 0, 30);
    const windowStart = floorWindow(startMs, PTB_WINDOW_MS);
    const bridge = makeSpyBridge();
    const { hooks, market, clock } = createHarness({ startMs, bridge });

    market.set('BTC', { price: 65010, ptb: 65000 }); // opens ABOVE ptb
    hooks.tick(); // t0: opens window, side=UP

    market.set('BTC', { price: 65050, ptb: 65000 });
    clock.advance(60_000);
    hooks.tick(); // t0+60s: still same window, stays UP

    // Cross into the next 5-minute window to force the close.
    clock.set(windowStart + PTB_WINDOW_MS + 10_000);
    market.set('BTC', { price: 65020, ptb: 65010 });
    hooks.tick();

    assert.strictEqual(bridge.calls.pushPtbWindowClose.length, 1);
    const closed = bridge.calls.pushPtbWindowClose[0];
    assert.strictEqual(closed.sym, 'BTC');
    assert.strictEqual(closed.outcome, 'DEFENDED');
    assert.strictEqual(closed.sideOpen, 'UP');
    assert.strictEqual(closed.sideClose, 'UP');
    assert.strictEqual(closed.ptb, 65000, 'PTB stays fixed at the value captured when the window opened');
  });

  await test('PTB window that flips sides closes as BROKEN', async () => {
    const startMs = Date.UTC(2026, 5, 18, 10, 0, 30);
    const windowStart = floorWindow(startMs, PTB_WINDOW_MS);
    const bridge = makeSpyBridge();
    const { hooks, market, clock } = createHarness({ startMs, bridge });

    market.set('ETH', { price: 3195, ptb: 3200 }); // opens BELOW ptb
    hooks.tick(); // t0: opens window, side=DOWN

    market.set('ETH', { price: 3210, ptb: 3200 }); // crosses ABOVE ptb intra-window
    clock.advance(90_000);
    hooks.tick();

    clock.set(windowStart + PTB_WINDOW_MS + 5_000);
    market.set('ETH', { price: 3220, ptb: 3215 });
    hooks.tick();

    assert.strictEqual(bridge.calls.pushPtbWindowClose.length, 1);
    const closed = bridge.calls.pushPtbWindowClose[0];
    assert.strictEqual(closed.sym, 'ETH');
    assert.strictEqual(closed.outcome, 'BROKEN');
    assert.strictEqual(closed.sideOpen, 'DOWN');
    assert.strictEqual(closed.sideClose, 'UP');
    assert.strictEqual(closed.crossCount, 1, 'one sign flip recorded mid-window');
  });

  await test('pushTick fires once per coin per tick when the bridge is present', async () => {
    const startMs = Date.UTC(2026, 5, 18, 10, 0, 30);
    const bridge = makeSpyBridge();
    const { hooks, market } = createHarness({ startMs, bridge });

    market.set('BTC', { price: 65000, ptb: 64950 });
    market.set('ETH', { price: 3200, ptb: 3190 });
    // SOL/XRP have no market fixture -> resolvePrice returns null -> sampleCoin
    // returns null -> tick() skips them (no pushTick call), matching today's behavior.

    hooks.tick();
    hooks.tick();

    assert.strictEqual(bridge.calls.pushTick.filter((c) => c.coin === 'BTC').length, 2);
    assert.strictEqual(bridge.calls.pushTick.filter((c) => c.coin === 'ETH').length, 2);
    assert.strictEqual(bridge.calls.pushTick.length, 4);
  });

  await test('memoryPackForPrompt attaches ptbDefenseStats only when the cached PTB matches', async () => {
    const startMs = Date.UTC(2026, 5, 18, 10, 0, 30);
    const windowStart = floorWindow(startMs, PTB_WINDOW_MS);
    const stats = { testedCount: 3, defendedCount: 2, brokenCount: 1, defendRate: 2 / 3 };
    const bridge = makeSpyBridge({
      getPtbDefenseStats: () => Promise.resolve({ success: true, stats }),
    });
    const { hooks, market, clock } = createHarness({ startMs, bridge });

    market.set('BTC', { price: 65010, ptb: 65000 });
    hooks.tick();

    // Force a window close so refreshPtbDefenseStats(coin, closedPtb) fires.
    clock.set(windowStart + PTB_WINDOW_MS + 10_000);
    market.set('BTC', { price: 65020, ptb: 65010 });
    hooks.tick();

    await flushMicrotasks();

    const matching = hooks.memoryPackForPrompt('BTC', { ptb: 65000 });
    assert.ok(matching.ptbDefenseStats, 'ptbDefenseStats should be populated for a matching PTB');
    assert.strictEqual(matching.ptbDefenseStats.testedCount, 3);
    assert.strictEqual(matching.ptbDefenseStats.defendedCount, 2);
    assert.strictEqual(matching.ptbDefenseStats.brokenCount, 1);
    assert.strictEqual(matching.ptbDefenseStats.defendRate, 2 / 3);
    assert.ok(Number.isFinite(matching.ptbDefenseStats.asOf));

    const farOff = hooks.memoryPackForPrompt('BTC', { ptb: 50000 });
    assert.strictEqual(farOff.ptbDefenseStats, null, 'PTB far outside tolerance -> null, not stale stats');
  });

  await test('_hydrate() restores windows15m/windows1h/predictions from Firestore when localStorage is empty', async () => {
    const startMs = Date.UTC(2026, 5, 18, 10, 0, 30);
    // Shape must match what updateOpenWindow()/_persistLight() actually produce
    // (see grok-analytics-memory.js) — not a generic fixture.
    const remoteSnapshot = {
      windows15m: [
        { start: startMs - 30 * 60_000, end: startMs - 15 * 60_000, o: 64800, h: 64900, l: 64750, c: 64850, rangePct: 0.23, direction: 'UP', sampleCount: 40 },
        { start: startMs - 15 * 60_000, end: startMs, o: 64850, h: 64950, l: 64800, c: 64900, rangePct: 0.23, direction: 'UP', sampleCount: 45 },
      ],
      windows1h: [
        { start: startMs - 60 * 60_000, end: startMs, o: 64500, h: 65000, l: 64400, c: 64900, rangePct: 0.93, direction: 'UP', sampleCount: 170 },
      ],
      predictions: {
        '15m': [{ ts: startMs - 10 * 60_000, windowStart: startMs - 15 * 60_000, call: 'UP', scored: true, correct: true }],
        '60m': [],
      },
    };
    const bridge = makeSpyBridge({
      getSessionSnapshot: (coin) => coin === 'BTC'
        ? Promise.resolve({ success: true, snapshot: remoteSnapshot })
        : Promise.resolve({ success: false, snapshot: null }),
    });
    // No localStorage in this harness at all (see createHarness) — the
    // genuinely-fresh-machine case _hydrate()'s remote fallback targets.
    const { hooks } = createHarness({ startMs, bridge });

    hooks.start();   // synchronous: _hydrate() (fires the async restore) then one tick()
    await flushMicrotasks();
    hooks.stop();    // clear the interval start() set up — this is a one-shot check, not a live loop

    const pack = hooks.memoryPackForPrompt('BTC');
    assert.strictEqual(pack.windows15m.n, 2, 'both restored 15m windows should be reflected');
    assert.strictEqual(pack.windows15m.upRate, 1, 'both restored windows were UP');
    assert.strictEqual(pack.windows1h.n, 1, 'restored 1h window should be reflected');
    assert.strictEqual(pack.predAccuracy15m.n, 1, 'restored prediction history should be reflected');
    assert.strictEqual(pack.predAccuracy15m.accuracy, 1);

    // A coin the bridge has no remote snapshot for stays empty — restore is per-coin, not a blanket fill.
    const packEth = hooks.memoryPackForPrompt('ETH');
    assert.strictEqual(packEth.windows15m.n, 0);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
