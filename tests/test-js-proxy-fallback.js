const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('electron/main.js', 'utf8');
const start = source.indexOf('async function startJsProxyFallback');
const end = source.indexOf('\nasync function startProxy()', start);
assert(start >= 0 && end > start, 'JS fallback proxy function not found');

let requestHandler;
const server = {
  listening: false,
  once() {},
  listen(_port, _host, callback) {
    this.listening = true;
    callback();
  },
};
const context = {
  AbortController,
  Buffer,
  URL,
  console,
  clearTimeout,
  setTimeout,
  fetch: async () => ({
    status: 200,
    headers: new Map([
      ['content-encoding', 'gzip'],
      ['content-type', 'application/json'],
      ['content-length', '22'],
    ]),
    arrayBuffer: async () => Uint8Array.from([91, 93]).buffer,
  }),
  jsProxyServer: null,
  proxyPort: null,
  proxyHealthy: false,
  PROXY_EXCHANGE_BASES: {},
  require: (name) => {
    assert.strictEqual(name, 'http');
    return {
      createServer(handler) {
        requestHandler = handler;
        return server;
      },
    };
  },
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

(async () => {
  await context.startJsProxyFallback(3010);
  const responseHeaders = new Map();
  await new Promise((resolve, reject) => {
    requestHandler(
      { method: 'GET', url: '/proxy?url=https%3A%2F%2Fupstream.test%2Fcandles', headers: { host: '127.0.0.1:3010' } },
      {
        setHeader: (name, value) => responseHeaders.set(name.toLowerCase(), value),
        end: (body) => {
          try {
            assert.strictEqual(Buffer.from(body).toString(), '[]');
            resolve();
          } catch (error) {
            reject(error);
          }
        },
      },
    );
  });

  assert.strictEqual(responseHeaders.get('content-encoding'), undefined);
  assert.strictEqual(responseHeaders.get('content-length'), undefined);
  assert.strictEqual(responseHeaders.get('content-type'), 'application/json');
  console.log('JS proxy fallback content-encoding test passed');

  const upstreamFn = source.match(/async function proxyUpstreamWorks\([\s\S]*?\n\}/);
  assert(upstreamFn, 'proxyUpstreamWorks not found');
  assert(upstreamFn[0].includes('Promise.all'), 'proxyUpstreamWorks must probe in parallel');
  assert(/timeoutMs = 1500/.test(upstreamFn[0]), 'proxyUpstreamWorks timeout should be 1500ms');
  console.log('proxyUpstreamWorks parallel probe check passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
