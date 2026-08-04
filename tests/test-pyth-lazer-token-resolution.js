// Regression test for: Pyth Lazer WS stream always failing with
// "[PythTickers] WS stream failed: Pyth Lazer WS timeout (2500ms)" (feed-adapters.js:764).
//
// Root cause: electron/main.js's Pyth token lookups called
//   readEnvValue(['PYTH_NEW', 'PYTH_API', 'PYTH_NEW_API', 'LAZER_TOKEN'])
// which omits 'PYTH_LAZER_TOKEN' and 'PYTH_API_KEY' — the exact variable names configured
// in the root .env. When no secrets/PYTH_API(.txt) file exists, startPythLazerService()
// therefore never finds a token, returns early, and NEVER starts the Lazer WS client or the
// REST poller that feeds the 'pyth:tickers' IPC event. window.pythLazer.onTickers() in
// src/core/feeds/feed-adapters.js#fetchPythTickers then never fires, so every call times out
// after pythWsTimeoutMs (2500ms) and the app permanently falls back away from Pyth.
//
// This test extracts the actual helper functions from electron/main.js (readEnvValue and its
// dependencies) via vm and asserts that, given only PYTH_LAZER_TOKEN/PYTH_API_KEY set in
// process.env (mirroring the real .env) and no secrets/ files present, readEnvValue() resolves
// a token using the exact argument lists used by startPythLazerService(), buildEnvOverrides(),
// and the pyth:getProxyLatest handler in electron/main.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mainJsPath = path.join(__dirname, '..', 'electron', 'main.js');
const source = fs.readFileSync(mainJsPath, 'utf8');

const start = source.indexOf('let loadedEnvPath = null;');
const end = source.indexOf('\nfunction decodeJsonStringFragment');
assert(start >= 0 && end > start, 'Pyth token-resolution helpers not found in electron/main.js');

function readEnvValueWith(envVars) {
  const context = {
    process: {
      env: { ...envVars },
      execPath: 'C:\\fake\\WECRYP.exe',
      cwd: () => 'C:\\fake\\cwd',
      resourcesPath: undefined,
    },
    __dirname: 'C:\\fake\\electron',
    path,
    // Simulate a totally empty secrets/ dir and no .env files on disk — the token must be
    // resolvable from process.env alone, which is how dotenv-loaded .env values arrive.
    fs: {
      existsSync: () => false,
      readFileSync: () => '',
    },
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context.readEnvValue;
}

// Mirrors the real .env in this repo: only PYTH_LAZER_TOKEN and PYTH_API_KEY are set —
// PYTH_NEW / PYTH_API / PYTH_NEW_API / LAZER_TOKEN are not defined anywhere.
const envVars = {
  PYTH_LAZER_TOKEN: 'test-lazer-token-value',
  PYTH_API_KEY: 'test-api-key-value',
};

const readEnvValue = readEnvValueWith(envVars);

// Exact argument lists used at the three electron/main.js call sites
// (startPythLazerService, buildEnvOverrides, pyth:getProxyLatest handler) after the fix.
const callSiteArgLists = [
  ['PYTH_NEW', 'PYTH_API', 'PYTH_NEW_API', 'PYTH_LAZER_TOKEN', 'PYTH_API_KEY', 'LAZER_TOKEN'],
  ['PYTH_API', 'PYTH_NEW', 'PYTH_NEW_API', 'PYTH_LAZER_TOKEN', 'PYTH_API_KEY', 'LAZER_TOKEN'],
];

for (const names of callSiteArgLists) {
  const resolved = readEnvValue(names);
  assert.strictEqual(
    resolved,
    'test-lazer-token-value',
    `readEnvValue(${JSON.stringify(names)}) should resolve PYTH_LAZER_TOKEN from process.env`
  );
}

// Guard against regressing back to the old, incomplete argument list that caused the bug.
const buggyNames = ['PYTH_NEW', 'PYTH_API', 'PYTH_NEW_API', 'LAZER_TOKEN'];
assert.strictEqual(
  readEnvValue(buggyNames),
  '',
  'sanity check: the pre-fix argument list (without PYTH_LAZER_TOKEN/PYTH_API_KEY) must NOT resolve a token here'
);

// Also confirm the three fixed call sites in electron/main.js source actually include the two
// previously-missing names, so a future edit can't silently drop them again.
const fixedCallSites = [
  "readEnvValue(['PYTH_NEW', 'PYTH_API', 'PYTH_NEW_API', 'PYTH_LAZER_TOKEN', 'PYTH_API_KEY', 'LAZER_TOKEN'])",
  "readEnvValue(['PYTH_API', 'PYTH_NEW', 'PYTH_NEW_API', 'PYTH_LAZER_TOKEN', 'PYTH_API_KEY', 'LAZER_TOKEN'])",
];
for (const snippet of fixedCallSites) {
  assert(source.includes(snippet), `Expected electron/main.js to contain: ${snippet}`);
}

console.log('Pyth Lazer token resolution regression test passed');
