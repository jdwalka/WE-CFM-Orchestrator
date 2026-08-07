const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '..', 'src', 'kalshi', 'prediction-markets.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const FIXED_MS = Date.UTC(2026, 5, 18, 10, 2, 30);
const WINDOW_TS = Math.floor(FIXED_MS / 1000 / 300) * 300;

const COIN_BY_PREFIX = {
  btc: 'BTC',
  eth: 'ETH',
  sol: 'SOL',
  xrp: 'XRP',
  doge: 'DOGE',
  bnb: 'BNB',
  hype: 'HYPE',
};

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

function createFixedDate(fixedMs) {
  return class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedMs]));
    }

    static now() {
      return fixedMs;
    }
  };
}

function parseSlug(url) {
  const parsed = new URL(url);
  return parsed.searchParams.get('slug');
}

function marketForSlug(slug, options = {}) {
  const prefix = String(slug || '').split('-')[0];
  const sym = COIN_BY_PREFIX[prefix] || prefix.toUpperCase();
  const titlePrice = options.titlePrices?.[prefix];
  const metadataPrice = options.metadataPrices?.[prefix];
  const title = titlePrice
    ? `${sym} Up or Down 5M - $${titlePrice.toLocaleString()} price to beat`
    : `${sym} Up or Down 5M`;

  return {
    id: `market-${slug}`,
    slug,
    question: title,
    active: true,
    closed: false,
    acceptingOrders: true,
    outcomes: JSON.stringify(['Up', 'Down']),
    outcomePrices: JSON.stringify(['0.62', '0.38']),
    volume24hr: '1250',
    liquidityNum: '500',
    bestBid: '0.61',
    bestAsk: '0.63',
    clobTokenIds: JSON.stringify([`${slug}-up-token`, `${slug}-down-token`]),
    endDate: new Date(FIXED_MS + 2 * 60_000).toISOString(),
    eventStartTime: new Date(WINDOW_TS * 1000).toISOString(),
    priceToBeat: metadataPrice || null,
  };
}

function createHarness(options = {}) {
  const fetchedUrls = [];
  const window = {
    DataLogger: { logPolymarket() {} },
    dispatchEvent() {},
    addEventListener() {},
  };

  const context = {
    window,
    console,
    URL,
    Date: createFixedDate(FIXED_MS),
    WebSocket: undefined,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (url) => {
      const href = String(url);
      fetchedUrls.push(href);

      if (href.startsWith('https://gamma-api.polymarket.com/markets?slug=')) {
        return {
          ok: true,
          json: async () => [marketForSlug(parseSlug(href), options)],
          text: async () => '',
        };
      }

      if (href.startsWith('https://polymarket.com/event/')) {
        return {
          ok: true,
          json: async () => ({}),
          text: async () => '<html><script>{"markets":[]}</script></html>',
        };
      }

      throw new Error(`Unexpected fetch: ${href}`);
    },
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: sourcePath });
  return { fetchedUrls, predictionMarkets: window.PredictionMarkets };
}

(async () => {
  console.log('\n[PredictionMarkets Poly 5M] price-to-beat regression tests');

  await test('does not call Polycool when Polymarket price-to-beat metadata is absent', async () => {
    const { fetchedUrls, predictionMarkets } = createHarness();

    const results = await predictionMarkets.refreshPoly5M('test-missing-ptb');
    const btc = results.BTC;

    assert(btc, 'BTC Poly 5M result should be present');
    assert.strictEqual(btc.slug, `btc-updown-5m-${WINDOW_TS}`);
    assert.strictEqual(btc.probability, 0.62);
    assert.strictEqual(btc.priceToBeatNum, null);
    assert.strictEqual(btc.targetPrice, null);
    assert.strictEqual(btc.priceToBeatSource, 'polymarket-eventMetadata');
    assert(
      fetchedUrls.some(url => url === `https://polymarket.com/event/btc-updown-5m-${WINDOW_TS}`),
      'Polymarket event page should be the final metadata fallback'
    );
    assert(
      fetchedUrls.every(url => !url.includes('polycool.app')),
      'Poly 5M resolution must not call Polycool routes'
    );
  });

  await test('uses Gamma market metadata before slower event-page fallbacks', async () => {
    const { fetchedUrls, predictionMarkets } = createHarness({
      metadataPrices: { btc: 105432.12 },
      titlePrices: {
        eth: 3500,
        sol: 145,
        xrp: 2.25,
        doge: 0.18,
        bnb: 625,
        hype: 38,
      },
    });

    const results = await predictionMarkets.refreshPoly5M('test-gamma-metadata');
    const btc = results.BTC;

    assert(btc, 'BTC Poly 5M result should be present');
    assert.strictEqual(btc.priceToBeatNum, 105432.12);
    assert.strictEqual(btc.targetPrice, '$105,432.12');
    assert.strictEqual(btc.priceToBeatSource, 'gamma-market-metadata');
    assert(
      fetchedUrls.every(url => !url.startsWith(`https://polymarket.com/event/btc-updown-5m-${WINDOW_TS}`)),
      'BTC should not fetch the event page when Gamma metadata contains priceToBeat'
    );
    assert(
      fetchedUrls.every(url => !url.includes('polycool.app')),
      'Gamma metadata path must not call Polycool routes'
    );
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
