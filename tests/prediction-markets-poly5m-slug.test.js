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
    assert.strictEqual(hooks.POLY5M_PTB_LOCK_VERSION, 13);
  } finally {
    restore();
  }
});

test('a single PTB reading never locks -- needs a second independent read to agree', () => {
  const nowMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs });
  try {
    const slug = 'btc-updown-5m-1699999940'; // opened 60s before nowMs, past the 62s settle gate
    const first = hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market');
    assert.strictEqual(first, null, 'a single reading must not lock immediately');
    assert.strictEqual(hooks._getPolymarketPriceToBeatLock(slug), null);
  } finally {
    restore();
  }
});

test('two independent reads that agree, spaced apart, confirm and lock', () => {
  const nowMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs });
  try {
    const slug = 'btc-updown-5m-1699999940';
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market'), null);

    // Too soon -- same tick, does not count as an independent recheck.
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market'), null);

    Date.now = () => nowMs + hooks.PTB_CONFIRM_MIN_GAP_MS + 500;
    const locked = hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market');
    assert.ok(locked, 'two agreeing reads spaced apart should confirm and lock');
    assert.strictEqual(locked.price, 105432.12);
    assert.strictEqual(locked.source, 'gamma-market');

    const stored = hooks._getPolymarketPriceToBeatLock(slug);
    assert.strictEqual(stored.price, 105432.12);
  } finally {
    restore();
  }
});

test('a chainlink-candles read confirming a Gamma read is labeled chainlink-candles', () => {
  const nowMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs });
  try {
    const slug = 'eth-updown-5m-1699999940';
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 3200.50, 'gamma-market'), null);
    Date.now = () => nowMs + hooks.PTB_CONFIRM_MIN_GAP_MS + 500;
    const locked = hooks._lockPolymarketPriceToBeat(slug, 3200.50, 'polymarket-chainlink-candles');
    assert.ok(locked);
    assert.strictEqual(locked.source, 'polymarket-chainlink-candles', 'authoritative TWAP source should win the label even if Gamma read first');
  } finally {
    restore();
  }
});

test('disagreeing weaker-source reads do not lock; a later read confirms once it agrees with the prior one', () => {
  const nowMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs });
  try {
    const slug = 'btc-updown-5m-1699999940';
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 105400.00, 'gamma-market'), null);

    Date.now = () => nowMs + hooks.PTB_CONFIRM_MIN_GAP_MS + 500;
    // Still settling -- a materially different reading from another weaker
    // source. Must not lock on either the old or the new value.
    const stillPending = hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-event-metadata');
    assert.strictEqual(stillPending, null, 'disagreeing reads must not lock');
    assert.strictEqual(hooks._getPolymarketPriceToBeatLock(slug), null);

    Date.now = () => nowMs + (2 * hooks.PTB_CONFIRM_MIN_GAP_MS) + 1000;
    const locked = hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-event-metadata');
    assert.ok(locked, 'agreeing with the most recent reading should confirm and lock');
    assert.strictEqual(locked.price, 105432.12);
  } finally {
    restore();
  }
});

test('a chainlink-candles read locks immediately, even after an earlier disagreeing weaker read', () => {
  const nowMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs });
  try {
    const slug = 'btc-updown-5m-1699999940';
    // An earlier weaker-source read is still pending (unconfirmed) --
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 105400.00, 'gamma-market'), null);

    // Polymarket's own settled-TWAP contract endpoint is the contract value
    // itself, not an estimate of it -- it locks on this single read,
    // regardless of what the still-pending gamma read said.
    const locked = hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'polymarket-chainlink-candles');
    assert.ok(locked, 'a chainlink-candles read should lock on the first call');
    assert.strictEqual(locked.price, 105432.12);
    assert.strictEqual(locked.source, 'polymarket-chainlink-candles');
  } finally {
    restore();
  }
});

test('locks are immutable once confirmed -- a later disagreeing read is ignored', () => {
  const nowMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs });
  try {
    const slug = 'btc-updown-5m-1699999940';
    hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market');
    Date.now = () => nowMs + hooks.PTB_CONFIRM_MIN_GAP_MS + 500;
    const locked = hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market');
    assert.ok(locked);

    const relocked = hooks._lockPolymarketPriceToBeat(slug, 999999.99, 'polymarket-chainlink-candles');
    assert.strictEqual(relocked.price, 105432.12, 'an already-confirmed lock must never mutate');
  } finally {
    restore();
  }
});

test('an unconfirmed reading near the end of the grace window locks rather than staying pending all window', () => {
  const startSec = 1699999940;
  const nowMs = 1_700_000_000_000;
  const { hooks, restore } = loadPredictionMarkets({ nowMs });
  try {
    const slug = `btc-updown-5m-${startSec}`;
    assert.strictEqual(hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market'), null);

    // Jump to just inside the grace deadline with no second reading having
    // ever arrived (e.g. every other source stayed unreachable all window).
    Date.now = () => (startSec * 1000) + hooks.PTB_LOCK_GRACE_MS - 1000;
    const locked = hooks._lockPolymarketPriceToBeat(slug, 105432.12, 'gamma-market');
    assert.ok(locked, 'grace fallback should lock the last reading rather than stay pending forever');
    assert.strictEqual(locked.price, 105432.12);
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
