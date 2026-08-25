const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err.message);
  }
}

function loadThrottledFetch() {
  const modulePath = path.resolve(__dirname, '../../src/infra/throttled-fetch.js');
  delete require.cache[modulePath];
  global.window = {
    location: { href: 'https://app.local/' },
    __env: {},
    desktopApp: { publicEnv: {} },
  };
  global.fetch = async () => ({ ok: true });
  require(modulePath);
  return global.window;
}

function withCoinGeckoEnv(env, fn) {
  const previous = {
    COINGECKO_API_KEY: process.env.COINGECKO_API_KEY,
    COINGECKO_API_TIER: process.env.COINGECKO_API_TIER,
  };
  if ('COINGECKO_API_KEY' in env) process.env.COINGECKO_API_KEY = env.COINGECKO_API_KEY;
  else delete process.env.COINGECKO_API_KEY;
  if ('COINGECKO_API_TIER' in env) process.env.COINGECKO_API_TIER = env.COINGECKO_API_TIER;
  else delete process.env.COINGECKO_API_TIER;

  try {
    fn();
  } finally {
    if (previous.COINGECKO_API_KEY === undefined) delete process.env.COINGECKO_API_KEY;
    else process.env.COINGECKO_API_KEY = previous.COINGECKO_API_KEY;
    if (previous.COINGECKO_API_TIER === undefined) delete process.env.COINGECKO_API_TIER;
    else process.env.COINGECKO_API_TIER = previous.COINGECKO_API_TIER;
    delete global.window;
    delete global.fetch;
  }
}

function proxyFetchRewrite(inputUrl, protocol = 'http:') {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/infra/proxy-fetch.js'), 'utf8');
  const calls = [];
  class FakeXMLHttpRequest {
    open(_method, url) {
      this.url = url;
    }

    send() {
      this.status = 200;
      this.responseText = 'OK';
      this.onload();
    }
  }

  const sandbox = {
    console: { info() {}, warn() {}, error() {}, log() {} },
    encodeURIComponent,
    setTimeout,
    URL,
    Request: globalThis.Request || class Request {},
    XMLHttpRequest: FakeXMLHttpRequest,
    window: {
      location: { protocol },
      fetch(url, init) {
        calls.push({ url, init });
        return Promise.resolve({ ok: true });
      },
    },
  };
  sandbox.window.fetch = sandbox.window.fetch.bind(sandbox.window);
  vm.runInNewContext(source, sandbox);
  sandbox.window.fetch(inputUrl);
  assert.strictEqual(calls.length, 1);
  return calls[0].url;
}

console.log('\n[CoinGecko routing] deterministic scenarios');

test('demo keys always use the public CoinGecko host and demo query param', () => {
  withCoinGeckoEnv({ COINGECKO_API_KEY: 'CG-demo_key_12345678', COINGECKO_API_TIER: 'pro' }, () => {
    const win = loadThrottledFetch();
    const routed = new URL(win.coinGeckoUrl('https://pro-api.coingecko.com/api/v3/simple/price?ids=bitcoin'));

    assert.strictEqual(routed.hostname, 'api.coingecko.com');
    assert.strictEqual(routed.searchParams.get('x_cg_demo_api_key'), 'CG-demo_key_12345678');
    assert.strictEqual(routed.searchParams.has('x_cg_pro_api_key'), false);
  });
});

test('plain non-pro keys default to demo routing to avoid 400s', () => {
  withCoinGeckoEnv({ COINGECKO_API_KEY: 'plain_demo_key_without_cg_prefix' }, () => {
    const win = loadThrottledFetch();
    const routed = new URL(win.coinGeckoUrl('https://api.coingecko.com/api/v3/coins/markets'));

    assert.strictEqual(routed.hostname, 'api.coingecko.com');
    assert.strictEqual(routed.searchParams.get('x_cg_demo_api_key'), 'plain_demo_key_without_cg_prefix');
    assert.strictEqual(routed.searchParams.has('x_cg_pro_api_key'), false);
  });
});

test('trial and pro tiers use the pro host and pro query param', () => {
  withCoinGeckoEnv({ COINGECKO_API_KEY: 'trial_key_abcdefghijklmnopqrstuvwxyz', COINGECKO_API_TIER: 'trial' }, () => {
    const win = loadThrottledFetch();
    const routed = new URL(win.coinGeckoUrl('https://api.coingecko.com/api/v3/ping?x_cg_demo_api_key=old'));

    assert.strictEqual(routed.hostname, 'pro-api.coingecko.com');
    assert.strictEqual(routed.searchParams.get('x_cg_pro_api_key'), 'trial_key_abcdefghijklmnopqrstuvwxyz');
    assert.strictEqual(routed.searchParams.has('x_cg_demo_api_key'), false);
  });
});

test('noisy copied demo key values are normalized before routing', () => {
  withCoinGeckoEnv({ COINGECKO_API_KEY: 'export COINGECKO_API_KEY="CG-AbCd_12345678" # copied from shell' }, () => {
    const win = loadThrottledFetch();
    const routed = new URL(win.coinGeckoUrl('https://api.coingecko.com/api/v3/ping'));

    assert.strictEqual(routed.hostname, 'api.coingecko.com');
    assert.strictEqual(routed.searchParams.get('x_cg_demo_api_key'), 'CG-AbCd_12345678');
  });
});

test('browser proxy rewrite keeps pro-api CoinGecko on the coingecko-pro route', () => {
  const rewritten = proxyFetchRewrite('https://pro-api.coingecko.com/api/v3/ping?x=1');

  assert.strictEqual(rewritten, 'http://127.0.0.1:3010/coingecko-pro/api/v3/ping?x=1');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
