const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function flushMicrotasks(times = 8) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) {
    chain = chain.then(() => new Promise(resolve => setImmediate(resolve)));
  }
  return chain;
}

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'data-logger.js'), 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const writes = [];
  const appended = [];

  const window = {
    desktopApp: {
      getDrives: async () => [
        { type: 'local', letter: 'C', root: 'C:\\' },
        { type: 'cloud', root: 'X:\\My Drive' },
        { type: 'network', root: '\\\\nas\\share\\' },
      ],
      getGoogleDriveTargets: async () => ({
        targets: [{ root: 'H:\\My Drive', name: 'stale-hardcoded-google-root' }],
      }),
    },
    dataStore: {
      writeFile: async (filePath) => {
        writes.push(filePath);
        return filePath.startsWith('X:\\My Drive\\WECRYPTO\\data\\');
      },
      readFile: async (filePath) => {
        if (filePath.includes(`\\${today}\\predictions.jsonl`)) {
          return {
            ok: true,
            content: [
              JSON.stringify({ sym: 'ETH', dir: 'UP', score: 1 }),
              JSON.stringify({ sym: 'ETH', dir: 'DOWN', score: 2 }),
              '',
            ].join('\n'),
          };
        }
        return { ok: false, notFound: true };
      },
      appendLine: async (filePath, line) => {
        appended.push({ filePath, line });
        return filePath.startsWith('X:\\My Drive\\WECRYPTO\\data\\');
      },
    },
    addEventListener() {},
    dispatchEvent() {},
  };

  const document = {
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return { style: {}, appendChild() {} }; },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };

  const context = vm.createContext({
    console,
    window,
    document,
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    CustomEvent: function CustomEvent(type, init) {
      this.type = type;
      this.detail = init?.detail;
    },
    setInterval() { return 0; },
    clearInterval() {},
    setTimeout() { return 0; },
    clearTimeout() {},
  });

  vm.runInContext(source, context, { filename: 'data-logger.js' });
  await flushMicrotasks();

  const roots = window.DataLogger.getStorageRoots();
  assert.strictEqual(roots.primary, 'X:\\My Drive\\WECRYPTO\\data');
  assert.deepStrictEqual(Array.from(roots.mirrors), []);
  assert.ok(writes.some(filePath => filePath.startsWith('X:\\My Drive\\WECRYPTO\\data\\.permission-check\\')));
  assert.ok(!roots.writableRoots.includes('H:\\My Drive\\WECRYPTO_Logs'));

  const stats = window.DataLogger.getStats();
  assert.strictEqual(stats.predictions.ETH.total, 2);
  assert.strictEqual(stats.predictions.ETH.up, 1);
  assert.strictEqual(stats.predictions.ETH.down, 1);

  window.DataLogger.logPrediction('BTC', { dir: 'UP', score: 0.7 });
  await window.DataLogger.flush();
  assert.strictEqual(appended.length, 1);
  assert.ok(appended[0].filePath.startsWith('X:\\My Drive\\WECRYPTO\\data\\'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
