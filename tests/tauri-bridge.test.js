const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bridgeSource = fs.readFileSync(path.join(__dirname, '../src/infra/tauri-bridge.js'), 'utf8');

function createStorage(initial = {}) {
  const values = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    setItem(key, value) {
      values[key] = String(value);
    },
  };
}

function createWindow({ storage, invoke, fetchImpl }) {
  const events = [];
  const window = {
    localStorage: storage,
    fetch: fetchImpl,
    addEventListener() {},
    dispatchEvent(event) {
      events.push(event);
    },
  };
  if (invoke) window.__TAURI__ = { core: { invoke } };
  return { window, events };
}

function loadBridge({ storage = createStorage(), invoke, fetchImpl }) {
  const { window, events } = createWindow({ storage, invoke, fetchImpl });
  const context = {
    window,
    localStorage: storage,
    fetch: fetchImpl,
    AbortSignal,
    CustomEvent,
    URL,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(bridgeSource, context);
  return { window, events, storage };
}

function okResponse(text = 'OK') {
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

test('Tauri discovery marks the proxy available and routes through the returned port', async () => {
  const requests = [];
  const { window } = loadBridge({
    invoke: async () => 4012,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return okResponse('{}');
    },
  });

  const response = await window.proxyFetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker');

  assert.equal(response.ok, true);
  assert.equal(requests.at(-1).url, 'http://127.0.0.1:4012/coinbase-ex/products/BTC-USD/ticker');
  assert.equal(window.ProxyTransport.getState().available, true);
  assert.equal(window.ProxyTransport.getState().mode, 'proxy');
});

test('a hanging Tauri invoke falls back to the cached last-good proxy port', async () => {
  const requests = [];
  const { window, storage } = loadBridge({
    storage: createStorage({ __we_tauri_proxy_port_cache__: '3017' }),
    invoke: () => new Promise(() => {}),
    fetchImpl: async (url) => {
      requests.push(url);
      if (url === 'http://127.0.0.1:3017/health') return okResponse('OK');
      if (url === 'http://127.0.0.1:3017/port') return okResponse('{"port":3017}');
      throw new Error('unexpected request');
    },
  });

  await window.refreshProxyRoute('test-cached-port');

  const state = window.ProxyTransport.getState();
  assert.equal(state.available, true);
  assert.equal(state.port, 3017);
  assert.equal(state.reason, 'proxy-discovered');
  assert.equal(storage.getItem('__we_tauri_proxy_port_cache__'), '3017');
  const healthUrls = requests.filter((url) => url.endsWith('/health'));
  assert.ok(healthUrls.length > 0);
  assert.ok(healthUrls.every((url) => url === 'http://127.0.0.1:3017/health'));
});

test('the proxy feature flag disables discovery and sends requests directly', async () => {
  let invokeCount = 0;
  const requests = [];
  const { window, events } = loadBridge({
    storage: createStorage({ __we_disable_tauri_db_proxy__: 'true' }),
    invoke: async () => {
      invokeCount++;
      return 4012;
    },
    fetchImpl: async (url) => {
      requests.push(url);
      return okResponse('{}');
    },
  });

  const response = await window.proxyFetch('https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD');
  const state = window.ProxyTransport.getState();

  assert.equal(response.ok, true);
  assert.equal(invokeCount, 0);
  assert.deepEqual(requests, ['https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD']);
  assert.equal(state.enabled, false);
  assert.equal(state.available, false);
  assert.equal(state.mode, 'bypass');
  assert.equal(state.lastInitErr, 'proxy-disabled');
  assert.ok(events.some((event) => event.type === 'proxy-mode-update' && event.detail.enabled === false));
});

test('proxy transport can be re-enabled at runtime', async () => {
  const { window, storage } = loadBridge({
    storage: createStorage({ __we_disable_tauri_db_proxy__: 'true' }),
    invoke: async () => 4013,
    fetchImpl: async () => okResponse('{}'),
  });

  const state = await window.ProxyTransport.setEnabled(true, 'test-enable');

  assert.equal(state.enabled, true);
  assert.equal(state.available, true);
  assert.equal(state.port, 4013);
  assert.equal(storage.getItem('__we_disable_tauri_db_proxy__'), 'false');
});
