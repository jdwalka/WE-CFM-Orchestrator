// Regression test for Pyth Lazer token resolution.
// PYTH_NEW_API is the sole streaming-token alias; legacy Pyth env names must
// never be able to shadow or reactivate an old key.
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

const envVars = {
  PYTH_NEW_API: 'test-new-api-token-value',
  PYTH_API: 'legacy-api-token-value',
  PYTH_NEW: 'legacy-new-token-value',
  PYTH_API_KEY: 'legacy-api-key-value',
  PYTH_LAZER_TOKEN: 'legacy-lazer-token-value',
  LAZER_TOKEN: 'legacy-lazer-value',
};

const readEnvValue = readEnvValueWith(envVars);
assert.strictEqual(
  readEnvValue(['PYTH_NEW_API']),
  'test-new-api-token-value',
  'Pyth Lazer must resolve only PYTH_NEW_API'
);

const legacyNames = ['PYTH_API', 'PYTH_NEW', 'PYTH_API_KEY', 'PYTH_LAZER_TOKEN', 'LAZER_TOKEN'];
const legacyPattern = new RegExp(`\\b(${legacyNames.join('|')})\\b`);
assert(
  !legacyPattern.test(source),
  'electron/main.js must not contain any legacy Pyth Lazer alias'
);

console.log('Pyth Lazer token resolution regression test passed');
