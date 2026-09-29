const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync('src/core/predictions/data-fetchers.js', 'utf8');
const requests = [];
const context = {
  AbortController,
  DOMException,
  Date,
  Math,
  Promise,
  Map,
  Number,
  Set,
  String,
  Array,
  Object,
  console,
  setTimeout,
  clearTimeout,
  window: { PredictionState: { candleCache: {} } },
  fetch: async (url) => {
    requests.push(url);
    if (url.includes('coingecko.com')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ price: 1 }) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [[1, '10', '12', '9', '11', '100']],
    };
  },
};
context.window.throttledFetch = context.fetch;
vm.createContext(context);
vm.runInContext(code, context);

(async () => {
  const { fetchGeckoJSON, fetchBINCandles } = context.window.PREDICTIONS_DATA_FETCHERS;
  assert.deepStrictEqual(await fetchGeckoJSON('/ping', { minGapMs: 0 }), { price: 1 });

  const candles = await fetchBINCandles('BTC', '1m', 1);
  assert.strictEqual(candles.length, 1);
  assert.deepStrictEqual({ ...candles[0] }, { t: 1, o: 10, h: 12, l: 9, c: 11, v: 100 });
  assert(requests.some(url => url.includes('coingecko.com/api/v3/ping')));
  assert(requests.some(url => url.includes('binance.vision/api/v3/klines')));
  console.log('Prediction data fetcher scope test passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
