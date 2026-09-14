const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

function loadUiComponents({ kalshi15m, poly15m, poly60m, poly5m }) {
  const globalWindow = {
    _predictions: {},
    PredictionMarkets: { getCoin: () => ({ kalshi15m, poly15m, poly60m, poly5m }) },
    PredictionEngine: { get: () => null },
    GrokRangeOverlay: { getGuidance: () => null },
    LivePath15m: { resolve: () => null },
  };
  const context = vm.createContext({
    window: globalWindow,
    document: { getElementById: () => null },
    Number,
    Math,
    Date,
    String,
    Array,
    Object,
    JSON,
    escapeHtml: (value) => String(value),
    fmtPrice: (value) => Number(value).toLocaleString('en-US'),
  });
  context.window = globalWindow;
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'app', 'ui-components.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'ui-components.js' });
  return globalWindow;
}

function basePrediction() {
  return {
    sym: 'BTC',
    price: 78000,
    currentPrice: 78000,
    score: 0.1,
    confidence: 0.6,
    horizon: '15m',
    indicators: {},
    projections: {},
    backtest: {},
  };
}

test('predictionCard renders when the 15m Kalshi contract is absent', () => {
  const window = loadUiComponents({ kalshi15m: null, poly15m: null, poly60m: null, poly5m: null });
  const html = window.predictionCard(basePrediction());
  assert.ok(typeof html === 'string');
  assert.ok(!html.includes('Render Error'));
});

test('predictionCard renders when the hourly range contract is absent', () => {
  const window = loadUiComponents({ kalshi15m: null, poly15m: null, poly60m: null, poly5m: null });
  const html = window.predictionCard({ ...basePrediction(), horizon: '1h' });
  assert.ok(typeof html === 'string');
  assert.ok(!html.includes('Render Error'));
});

test('predictionCard renders with an empty market cache', () => {
  const window = loadUiComponents({ kalshi15m: null, poly15m: null, poly60m: null, poly5m: null });
  const html = window.predictionCard(basePrediction());
  assert.ok(html.includes('BTC'));
});
