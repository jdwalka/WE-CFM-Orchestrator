const assert = require('assert');
const path = require('path');

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
  const modulePath = path.resolve(__dirname, '../src/kalshi/prediction-markets.js');
  delete require.cache[modulePath];

  global.window = {
    __WE_TEST__: true,
    addEventListener() {},
    dispatchEvent() {},
  };
  global.document = { hidden: false };
  global.CustomEvent = function CustomEvent(type, options) {
    this.type = type;
    this.detail = options?.detail;
  };
  if (fetchImpl) global.fetch = fetchImpl;
  delete global.WebSocket;

  const originalNow = Date.now;
  if (nowMs != null) Date.now = () => nowMs;

  require(modulePath);
  const hooks = global.window.__PredictionMarketsTestHooks;

  return {
    hooks,
    restore() {
      Date.now = originalNow;
      delete global.window;
      delete global.document;
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

test('5m PTB uses 60s Chainlink TWAP, not the old 30s series', () => {
  const { hooks, restore } = loadPredictionMarkets();
  try {
    assert.strictEqual(hooks.POLY_TWAP_LOOKBACK_SEC, 60);
    assert.strictEqual(hooks.PTB_TWAP_SETTLE_SEC, 62);
    assert.strictEqual(hooks.POLY5M_PTB_LOCK_VERSION, 11);
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
    return {
      ok: true,
      async json() {
        assert(String(url).startsWith('https://gamma-api.polymarket.com/markets?slug='));
        return {
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
      },
    };
  };
  const { hooks, restore } = loadPredictionMarkets({ fetchImpl, nowMs });
  try {
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
