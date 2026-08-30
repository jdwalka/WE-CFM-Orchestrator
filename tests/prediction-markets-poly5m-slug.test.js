const assert = require('assert');
const path = require('path');
const nodeRequire = require;

let passed = 0;
let failed = 0;
const asyncTests = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('Use testAsync for async scenarios');
    }
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err.message);
  }
}

function loadPredictionMarkets({ fetchImpl, nowMs } = {}) {
  const modulePath = path.resolve(__dirname, '../src/prediction-markets/prediction-markets.js');
  delete require.cache[modulePath];

  const storage = new Map();
  const mockStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };

  global.window = {
    __WE_TEST__: true,
    addEventListener() {},
    dispatchEvent() {},
    localStorage: mockStorage,
  };
  global.document = { hidden: false };
  global.localStorage = mockStorage;
  global.CustomEvent = function CustomEvent(type, options) {
    this.type = type;
    this.detail = options?.detail;
  };
  if (fetchImpl) global.fetch = fetchImpl;
  delete global.WebSocket;

  const originalNow = Date.now;
  if (nowMs != null) Date.now = () => nowMs;

  nodeRequire(modulePath);
  const hooks = global.window.__PredictionMarketsTestHooks;

  return {
    hooks,
    restore() {
      Date.now = originalNow;
      delete global.window;
      delete global.document;
      delete global.localStorage;
      delete global.CustomEvent;
      delete global.fetch;
      delete global.WebSocket;
    },
  };
}

function futureIso(nowMs, deltaMs) {
  return new Date(nowMs + deltaMs).toISOString();
}

console.log('\n[PredictionMarkets Poly5M] deterministic scenarios');

test('Polymarket price-to-beat parser stays scoped to the requested slug', () => {
  const { hooks, restore } = loadPredictionMarkets();
  try {
    const html = [
      '{"id":"market-a","slug":"btc-updown-5m-1000","priceToBeat":105432.25}',
      '{"id":"market-b","slug":"eth-updown-5m-1000","priceToBeat":3200.50}',
    ].join('');

    assert.strictEqual(hooks._parsePolymarketPriceToBeat(html, 'btc-updown-5m-1000'), 105432.25);
    assert.strictEqual(hooks._parsePolymarketPriceToBeat(html, 'eth-updown-5m-1000'), 3200.50);
    assert.strictEqual(hooks._parsePolymarketPriceToBeat(html, 'sol-updown-5m-1000'), null);
  } finally {
    restore();
  }
});

test('15m and 60m slugs share the same immutable open-price parser', () => {
  const { hooks, restore } = loadPredictionMarkets();
  try {
    const html15 = '{"id":"m15","slug":"btc-updown-15m-2000","priceToBeat":105500.50}';
    const html60 = '{"id":"m60","slug":"btc-updown-1h-3000","priceToBeat":105600.25}';
    assert.strictEqual(hooks._parsePolymarketPriceToBeat(html15, 'btc-updown-15m-2000'), 105500.50);
    assert.strictEqual(hooks._parsePolymarketPriceToBeat(html60, 'btc-updown-1h-3000'), 105600.25);
  } finally {
    restore();
  }
});

test('5m PTB uses 60s Chainlink TWAP, not the old 30s series', () => {
  const { hooks, restore } = loadPredictionMarkets();
  try {
    assert.strictEqual(hooks.POLY_TWAP_LOOKBACK_SEC, 60);
    assert.strictEqual(hooks.PTB_TWAP_SETTLE_SEC, 62);
    assert.strictEqual(hooks.POLY5M_PTB_LOCK_VERSION, 15);
  } finally {
    restore();
  }
});

test('trusted Polymarket contract sources lock cleanly and immutably', () => {
  let currentMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs: currentMs });
  try {
    const slug = 'btc-updown-5m-1699999940';
    // 1st read records pending
    hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market');
    // 2nd read confirming >= 1s later locks
    Date.now = () => currentMs + 1500;
    const locked = hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market');
    assert.ok(locked, 'trusted contract source must lock');
    assert.strictEqual(locked.price, 105432.12);
    assert.strictEqual(locked.source, 'gamma-market');

    const stored = hooks._getPolymarketPriceToBeatLock(slug);
    assert.strictEqual(stored.price, 105432.12);

    // Immutable once locked -- later attempts to overwrite with wrong prices are ignored
    const relocked = hooks._lockPolymarketPriceToBeat(slug, 999999.99, 'gamma-market');
    assert.strictEqual(relocked.price, 105432.12, 'locked contract price must be immutable');
    const upgraded = hooks._lockPolymarketPriceToBeat(slug, 888888.88, 'polymarket-contract');
    assert.strictEqual(upgraded.price, 105432.12, 'PRIMARY source must not rewrite an already-locked T0 strike');
  } finally {
    restore();
  }
});

test('untrusted / synthetic sources are rejected from locking', () => {
  const nowMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs });
  try {
    const slug = 'btc-updown-5m-1699999940';
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 105400.00, 'polymarket-title'), null);
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 105400.00, 'binance-spot'), null);
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 105400.00, 'pyth-lazer'), null);
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 105400.00, 'polymarket-chainlink-candles'), null);
    assert.strictEqual(hooks._getPolymarketPriceToBeatLock(slug), null);
  } finally {
    restore();
  }
});

test('generic metadata parser handles common Polymarket price-to-beat shapes', () => {
  const { hooks, restore } = loadPredictionMarkets();
  try {
    assert.strictEqual(hooks._parseGenericPriceToBeat('{"price_to_beat":"105,250.75"}', 'btc-updown-5m-1000'), 105250.75);
    assert.strictEqual(hooks._formatPolyPriceToBeat(105250.75), '$105,250.75');
  } finally {
    restore();
  }
});

test('event fallback chooses a tradable 5m market and preserves fallback provenance', () => {
  const nowMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs });
  try {
    const market = hooks._coercePolyMarketFromEvent({
      id: 'evt-1',
      slug: 'btc-updown-5m-1700000000',
      title: 'Bitcoin Up or Down - 5m',
      startTime: new Date(nowMs).toISOString(),
      markets: [
        {
          slug: 'stale-market',
          active: true,
          closed: false,
          endDate: new Date(nowMs + 1_000).toISOString(),
          outcomePrices: '["0.40","0.60"]',
          outcomes: '["Up","Down"]',
        },
        {
          slug: 'btc-updown-5m-1700000000',
          active: true,
          closed: false,
          acceptingOrders: true,
          endDate: futureIso(nowMs, 60_000),
          outcomePrices: '["0.61","0.39"]',
          outcomes: '["Up","Down"]',
        },
      ],
    }, 'btc-updown-5m-1700000000');

    assert.strictEqual(market.slug, 'btc-updown-5m-1700000000');
    assert.strictEqual(hooks._isTradablePoly5M(market, nowMs), true);
    assert.strictEqual(hooks._parseUpProb(market), 0.61);
    assert.strictEqual(market._eventFallback.slug, 'btc-updown-5m-1700000000');
  } finally {
    restore();
  }
});

asyncTests.push(testAsync('5m slug fetch uses Polymarket metadata without calling Polycool fallback routes', async () => {
  const nowMs = 1_700_000_000_000;
  const expectedWindow = Math.floor(nowMs / 1000) - (Math.floor(nowMs / 1000) % 300);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const payload = {
      markets: [{
        slug: `btc-updown-5m-${expectedWindow}`,
        active: true,
        closed: false,
        acceptingOrders: true,
        question: 'Bitcoin Up or Down - 5m',
        endDate: futureIso(nowMs, 60_000),
        eventStartTime: new Date(nowMs).toISOString(),
        outcomePrices: '["0.62","0.38"]',
        outcomes: '["Up","Down"]',
        priceToBeat: 105432.25,
        volume24hr: '2500',
      }],
    };
    return {
      ok: true,
      async json() {
        return payload;
      },
      async text() {
        return JSON.stringify(payload);
      },
    };
  };
  const { hooks, restore } = loadPredictionMarkets({ fetchImpl, nowMs });
  try {
    // 1st fetch queues pending read for v15 confirmation gate
    await hooks.fetchPolymarket5MBySlug('BTC');
    // 2nd fetch 1.5s later confirms and locks
    Date.now = () => nowMs + 1500;
    const data = await hooks.fetchPolymarket5MBySlug('BTC');

    assert.strictEqual(data.probability, 0.62);
    assert.strictEqual(data.targetPriceNum, 105432.25);
    assert.strictEqual(data.priceToBeatSource, 'gamma-market');
    assert.strictEqual(data.priceToBeat, '$105,432.25');
    assert.strictEqual(data.discoverySource, 'gamma-markets-slug');
    assert(calls.length > 0);
    assert(calls.every(url => !url.includes('polycool.app')));
  } finally {
    restore();
  }
}));

Promise.all(asyncTests).finally(() => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
});
