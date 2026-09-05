const fs = require('fs');
const path = require('path');
const os = require('os');
const debugLogFile = path.join(os.homedir(), 'wecrypto_startup.log');
try {
  fs.appendFileSync(debugLogFile, `\n\n--- App Start ${new Date().toISOString()} PID ${process.pid} ---\n`);
} catch (_) { }

process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(debugLogFile, `[UncaughtException] ${err?.stack || err?.message || err}\n`); } catch (_) { }
  console.error('[UncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  try { fs.appendFileSync(debugLogFile, `[UnhandledRejection] ${reason?.stack || reason}\n`); } catch (_) { }
  console.error('[UnhandledRejection]', reason);
});

const { startOrbitalSystem, restartOrbitalSystem, shutdownOrbitalSystem, getOrbitalStatus } = require('../src/infra/orbital-startup-orchestrator');
const { createHzTracker } = require('../src/infra/resonance-filter');
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { normalizeCoinbaseJwtUri } = require('../src/infra/coinbase-jwt-utils');

// IPC bridges & managers
try { require('./tor-fetch-ipc-bridge'); } catch (e) { console.warn('[IPC] tor-fetch-ipc-bridge load warning:', e.message); }
try { require('./polymarket-clob-manager'); } catch (e) { console.warn('[IPC] polymarket-clob-manager load warning:', e.message); }
try { require('./multi-drive-logger-handlers'); } catch (e) { console.warn('[IPC] multi-drive-logger-handlers load warning:', e.message); }

// --- AMD AOCL & BLAS Optimizations for Downstream C++/Python Binaries ---
// Force NumPy, PyTorch, and Custom C++ to prioritize AMD AOCL (BLIS/libflame) and avoid Intel MKL throttling on Ryzen.
process.env.MKL_DEBUG_CPU_TYPE = '5'; // Force MKL to not cripple AMD CPUs if inadvertently loaded
process.env.MKL_ENABLE_INSTRUCTIONS = 'AVX2';
process.env.DISABLE_MKL = '1';
process.env.BLIS_ARCH = 'zen'; // Target Zen architecture for AOCL/BLIS
process.env.AOCL_ENABLE = '1';
process.env.OMP_DYNAMIC = 'FALSE'; // Better thread binding for AOCL

// Try to load the ultra-fast C++ native math N-API addon (DEPRECATED - Replaced by WASM SIMD)
// let quantMathAddon = null;
// try {
//   quantMathAddon = require('../native-math/build/Release/quant_math.node');
// } catch (e) { }

// --- CPU Core Affinity Binding (AMD Ryzen Quant Box Optimization) ---
// Since native C++ modules fail to compile locally, we launch PowerShell to hard-bind
// the Node process to a specific CPU core mask to prevent L3 cache thrashing across CCX boundaries.
const { exec } = require('child_process');
try {
  // Bind to cores 0-7 (Bitmask 255 = 11111111) as an example baseline for CCX0
  const affinityMask = 255;
  console.log(`[Startup] Launching PowerShell to lock CPU Affinity to mask ${affinityMask}...`);
  exec(`powershell -Command "$Process = Get-Process -Id ${process.pid}; $Process.ProcessorAffinity = ${affinityMask}"`, (err, stdout, stderr) => {
    if (err) {
      console.warn(`[Startup] Failed to set Process Affinity via PowerShell: ${err.message}`);
    } else {
      console.log(`[Startup] Process Affinity successfully locked for PID ${process.pid}.`);
    }
  });
} catch (err) {
  console.warn('[Startup] Affinity binding error:', err);
}

// --- Set WECRYP_ROOT for Orbital System ---
if (!process.env.WECRYP_ROOT) {
  // Detect workspace: check common locations
  const candidates = [
    process.cwd(),
    path.join(__dirname, '..'),
    process.resourcesPath,
    process.resourcesPath ? path.join(process.resourcesPath, '..') : null,
    'G:\\WECRYP',
    'G:\\WECRYPTO',
    'F:\\WECRYP',
    'F:\\WECRYPTO',
    'E:\\WECRYP',
    'E:\\WECRYPTO',
    'D:\\WECRYP',
    'C:\\WECRYP'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'docker-compose.yml'))) {
      process.env.WECRYP_ROOT = candidate;
      console.log(`[Startup] WECRYP_ROOT auto-detected: ${candidate}`);
      break;
    }
  }

  if (!process.env.WECRYP_ROOT) {
    process.env.WECRYP_ROOT = path.join(__dirname, '..');
    console.warn(`[Startup] WECRYP_ROOT not found; using fallback: ${process.env.WECRYP_ROOT}`);
  }
}

// Prevent startup crashes when stdout/stderr pipes are unavailable (EPIPE)
function _isBrokenPipe(err) {
  return err && (err.code === 'EPIPE' || /broken pipe/i.test(String(err.message || '')));
}

const _consoleLog = console.log.bind(console);
const _consoleWarn = console.warn.bind(console);
const _consoleError = console.error.bind(console);

function _safeConsoleWrite(writer, args) {
  try {
    writer(...args);
  } catch (err) {
    if (_isBrokenPipe(err)) return;
    throw err;
  }
}

console.log = (...args) => _safeConsoleWrite(_consoleLog, args);
console.warn = (...args) => _safeConsoleWrite(_consoleWarn, args);
console.error = (...args) => _safeConsoleWrite(_consoleError, args);

if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', (err) => {
    if (_isBrokenPipe(err)) return;
    throw err;
  });
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', (err) => {
    if (_isBrokenPipe(err)) return;
    throw err;
  });
}

let loadedEnvPath = null;

function uniqueExistingPaths(pathsToCheck) {
  const seen = new Set();
  const out = [];
  for (const p of pathsToCheck.filter(Boolean)) {
    const normalized = path.resolve(p);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function getEnvFileCandidates() {
  const exeDir = path.dirname(process.execPath || __filename);
  let userDataDir = '';
  try {
    userDataDir = app.getPath('userData');
  } catch (_) {
    userDataDir = '';
  }
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  return uniqueExistingPaths([
    loadedEnvPath,
    path.join(exeDir, '.env'),
    userDataDir && path.join(userDataDir, '.env'),
    appData && path.join(appData, 'WE-CRYPTO-Polymarket-v2.15.6', '.env'),
    // Pre-rename installs kept their .env under the old Kalshi-branded folder name.
    appData && path.join(appData, 'WE-CRYPTO-Kalshi-15m-v2.15.5', '.env'),
    appData && path.join(appData, 'we-cfm-orchestrator', '.env'),
    appData && path.join(appData, 'WECRYPTO', '.env'),
    localAppData && path.join(localAppData, 'WE-CRYPTO-Polymarket-v2.15.6', '.env'),
    localAppData && path.join(localAppData, 'WE-CRYPTO-Kalshi-15m-v2.15.5', '.env'),
    localAppData && path.join(localAppData, 'we-cfm-orchestrator', '.env'),
    localAppData && path.join(localAppData, 'WECRYPTO', '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(process.resourcesPath || '', '..', '.env'),
    path.join(process.cwd(), '.env'),
  ]);
}

function stripEnvValue(value) {
  let v = String(value ?? '').trim();
  if (!v) return '';
  const quote = v[0];
  if ((quote === '"' || quote === "'" || quote === '`') && v[v.length - 1] === quote) {
    v = v.slice(1, -1);
  } else {
    v = v.replace(/\s+#.*$/, '').trim();
  }
  return v.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readRawEnvValue(raw, name) {
  const re = new RegExp(`(?:^|\\r?\\n)\\s*${escapeRegExp(name)}\\s*=\\s*([^\\r\\n]*)`, 'i');
  const match = raw.match(re);
  return match ? stripEnvValue(match[1]) : '';
}

function readEnvValue(names) {
  for (const name of names) {
    const envValue = process.env[name];
    if (envValue != null && String(envValue).trim()) return stripEnvValue(envValue);
  }
  for (const envPath of getEnvFileCandidates()) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const raw = fs.readFileSync(envPath, 'utf8');
      for (const name of names) {
        const value = readRawEnvValue(raw, name);
        if (value) return value;
      }
    } catch (_) {
      // keep looking
    }
  }
  // Direct support for user's PYTH_NEW_API
  for (const name of names) {
    if (/PYTH_NEW_API|pyth_new/i.test(name)) {
      try {
        const s = readPythLazerSecret ? readPythLazerSecret() : { value: '' };
        if (s.value) return s.value;
      } catch (_) {}
    }
  }
  // Fallback to secrets for any Pyth/Lazer names
  if (names.some(n => /pyth|lazer/i.test(n))) {
    try {
      const s = readPythLazerSecret ? readPythLazerSecret() : { value: '' };
      if (s.value) return s.value;
    } catch (_) {}
  }
  return '';
}

function getSecretDirCandidates() {
  const exeDir = path.dirname(process.execPath || __filename);
  let userDataDir = '';
  try {
    userDataDir = app.getPath('userData');
  } catch (_) {
    userDataDir = '';
  }
  return uniqueExistingPaths([
    userDataDir && path.join(userDataDir, 'secrets'),
    path.join(exeDir, 'secrets'),
    path.join(process.resourcesPath || '', '..', 'secrets'),
    path.join(__dirname, '..', 'secrets'),
    path.join(process.cwd(), 'secrets'),
    'G:\\WECRYPTO\\secrets',
    'F:\\WECRYPTO\\secrets',
    'E:\\WECRYPTO\\secrets',
  ]);
}

function readSecretScalar(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';

  for (const line of lines) {
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (kv && /coingecko|coin.?gecko|gecko|^cg_|^x[-_]?cg|cmc|coinmarketcap|coin.?market.?cap/i.test(kv[1])) {
      return stripEnvValue(kv[2]);
    }
  }

  const jsonKey = String(raw).match(/"(?:COINGECKO_API_KEY|COINGECKO_PRO_API_KEY|COINGECKO_DEMO_API_KEY|CMC_PRO_API_KEY|CMC_API_KEY|COINMARKETCAP_API_KEY|apiKey|key)"\s*:\s*"((?:\\.|[^"])*)"/i);
  if (jsonKey) return stripEnvValue(decodeJsonStringFragment(jsonKey[1]));

  return stripEnvValue(lines.reduce((longest, line) => line.length > longest.length ? line : longest, ''));
}

function readSecretFileValue(fileNames) {
  for (const dir of getSecretDirCandidates()) {
    for (const fileName of fileNames) {
      const p = path.join(dir, fileName);
      try {
        if (!fs.existsSync(p)) continue;
        const value = readSecretScalar(fs.readFileSync(p, 'utf8'));
        if (value) return { value, path: p };
      } catch (_) {
        // keep looking
      }
    }
  }
  return { value: '', path: '' };
}

function inferCoinGeckoTier(key, sourcePath = '') {
  const source = String(sourcePath || '').toLowerCase();
  const value = String(key || '').trim();
  if (!value) return '';
  if (/demo|free/.test(source)) return 'demo';
  if (/pro|paid/.test(source)) return 'pro';
  if (/^CG-/i.test(value)) return 'demo';
  return value.length > 80 ? 'pro' : 'demo';
}

function readCoinGeckoSecret() {
  return readSecretFileValue([
    'CoinGECKOAPIKEY.txt',
    'COINGECKOAPIKEY.txt',
    'COINGECKO-API-KEY.txt',
    'COINGECKO_API_KEY.txt',
    'COINGECKO-PRO-API-KEY.txt',
    'COINGECKO_PRO_API_KEY.txt',
    'COINGECKO-DEMO-API-KEY.txt',
    'COINGECKO_DEMO_API_KEY.txt',
    'CG-API-KEY.txt',
    'CG_API_KEY.txt',
  ]);
}

function readCMCSecret() {
  return readSecretFileValue([
    'CoinMarketCapAPIKEY.txt',
    'CMC_API_KEY.txt',
    'COINMARKETCAP_API_KEY.txt',
    'pro-api.coinmarketcap.com',
    'pro-api.coinmarketcap.com.txt',
    'coinmarketcap.txt',
    'cmc.txt'
  ]);
}

function readPythLazerSecret() {
  // Prefer PYTH_API (user upgraded key name), then PYTH_NEW, then legacy
  return readSecretFileValue([
    'PYTH_API',
    'PYTH_API.txt',
    'PYTH_NEW',
    'PYTH_NEW.txt',
    'PYTH_NEW_API',
    'PYTH_NEW_API.txt'
  ]);
}

// Pyth Pro (docs.pyth.network/price-feeds/pro) — a distinct product/key from
// the Lazer streaming token above; used for the REST history API
// (/v1/real_time/history), which now requires this specific key.
function readPythProSecret() {
  return readSecretFileValue([
    'PYTH_PRO_API_KEY',
    'PYTH_PRO_API_KEY.txt',
  ]);
}

function decodeJsonStringFragment(value) {
  try {
    return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
  } catch (_) {
    return String(value || '').replace(/\\"/g, '"').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  }
}

function coinbaseCredentialFromObject(obj, source) {
  if (!obj || typeof obj !== 'object') return null;
  const name = stripEnvValue(obj.name || obj.keyName || obj.key_name || obj.apiKeyName);
  const privateKey = stripEnvValue(obj.privateKey || obj.private_key || obj.CDP_API_KEY_PRIVATE_KEY);
  if (!name || !privateKey) return null;
  return { name, privateKey, source };
}

function readCoinbaseCredentialFromRawEnv() {
  for (const envPath of getEnvFileCandidates()) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const raw = fs.readFileSync(envPath, 'utf8');

      const jsonMatches = raw.match(/\{[\s\S]*?"privateKey"\s*:[\s\S]*?\}/g) || [];
      for (const candidate of jsonMatches) {
        try {
          const parsed = JSON.parse(candidate);
          const credential = coinbaseCredentialFromObject(parsed, `raw-env-json:${path.basename(envPath)}`);
          if (credential) return credential;
        } catch (_) {
          // fall back to targeted field extraction below
        }
      }

      const nameMatch = raw.match(/"name"\s*:\s*"((?:\\.|[^"])*)"/);
      const keyMatch = raw.match(/"privateKey"\s*:\s*"((?:\\.|[^"])*)"/);
      if (nameMatch && keyMatch) {
        const credential = coinbaseCredentialFromObject({
          name: decodeJsonStringFragment(nameMatch[1]),
          privateKey: decodeJsonStringFragment(keyMatch[1]),
        }, `raw-env-fields:${path.basename(envPath)}`);
        if (credential) return credential;
      }
    } catch (_) {
      // keep looking
    }
  }
  return null;
}

function loadCoinbaseCredential() {
  const jsonEnv = readEnvValue([
    'CDP_API_KEY_JSON',
    'COINBASE_CDP_API_KEY_JSON',
    'COINBASE_API_KEY_JSON',
  ]);
  if (jsonEnv) {
    try {
      const credential = coinbaseCredentialFromObject(JSON.parse(jsonEnv), 'env-json');
      if (credential) return credential;
    } catch (_) {
      // fall through to field-based formats
    }
  }

  const name = readEnvValue([
    'CDP_API_KEY_NAME',
    'COINBASE_CDP_API_KEY_NAME',
    'COINBASE_API_KEY_NAME',
    'COINBASE_API_KEY',
    'COINBASE_KEY_NAME',
  ]);
  const privateKey = readEnvValue([
    'CDP_API_KEY_PRIVATE_KEY',
    'COINBASE_CDP_PRIVATE_KEY',
    'COINBASE_API_PRIVATE_KEY',
    'COINBASE_PRIVATE_KEY',
    'COINBASE_API_KEY_PRIVATE_KEY',
  ]);
  const envCredential = coinbaseCredentialFromObject({ name, privateKey }, 'env-fields');
  if (envCredential) return envCredential;

  const filePath = readEnvValue([
    'CDP_API_KEY_FILE',
    'COINBASE_CDP_API_KEY_FILE',
    'COINBASE_API_KEY_FILE',
  ]);
  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
      const credential = coinbaseCredentialFromObject(parsed, 'env-file');
      if (credential) return credential;
    } catch (_) {
      // fall through to raw .env and legacy file locations
    }
  }

  const rawEnvCredential = readCoinbaseCredentialFromRawEnv();
  if (rawEnvCredential) return rawEnvCredential;

  const legacyCandidates = [
    path.join(app.getAppPath(), '..', '..', 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'),
    path.join(app.getAppPath(), 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'),
  ];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const driveRoot = `${String.fromCharCode(code)}:\\`;
      legacyCandidates.push(path.join(driveRoot, 'WECRYPTO', 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'));
      legacyCandidates.push(path.join(driveRoot, 'My Drive', 'WECRYPTO', 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'));
      legacyCandidates.push(path.join(driveRoot, 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'));
      legacyCandidates.push(path.join(driveRoot, 'My Drive', 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'));
    }
  } else {
    legacyCandidates.push('F:\\WECRYPTO\\secrets\\cdp_api_key-WECRYPTO-ECDSA.json');
    legacyCandidates.push('G:\\WECRYPTO\\secrets\\cdp_api_key-WECRYPTO-ECDSA.json');
  }
  for (const p of legacyCandidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const credential = coinbaseCredentialFromObject(JSON.parse(fs.readFileSync(p, 'utf8')), `legacy-file:${p}`);
      if (credential) return credential;
    } catch (_) {
      // keep looking
    }
  }
  return null;
}

function resolveCoinGeckoPublicConfig() {
  const secret = readCoinGeckoSecret();
  const secretTier = inferCoinGeckoTier(secret.value, secret.path);
  const proKey = readEnvValue(['COINGECKO_PRO_API_KEY', 'CG_PRO_API_KEY', 'COINGECKO_PAID_API_KEY', 'X_CG_PRO_API_KEY', 'x_cg_pro_api_key', 'x-cg-pro-api-key'])
    || (secretTier === 'pro' ? secret.value : '');
  const demoKey = readEnvValue(['COINGECKO_DEMO_API_KEY', 'CG_DEMO_API_KEY', 'COINGECKO_FREE_API_KEY', 'X_CG_DEMO_API_KEY', 'x_cg_demo_api_key', 'x-cg-demo-api-key'])
    || (secretTier === 'demo' ? secret.value : '');
  const genericKey = readEnvValue(['COINGECKO_API_KEY', 'COINGECKO_KEY', 'COIN_GECKO_API_KEY', 'GECKO_API_KEY', 'CG_API_KEY', 'CG_KEY'])
    || (!secretTier ? secret.value : '');
  const tierRaw = readEnvValue(['COINGECKO_API_TIER', 'COINGECKO_TIER', 'COINGECKO_PLAN', 'CG_API_TIER']);
  const tier = /^(pro|paid|enterprise)$/i.test(tierRaw)
    ? 'pro'
    : (/^demo|free$/i.test(tierRaw) ? 'demo' : (proKey ? 'pro' : 'demo'));
  const key = proKey || demoKey || genericKey;
  const out = {};
  if (key) out.COINGECKO_API_KEY = key;
  if (tier) out.COINGECKO_API_TIER = tier;

  const cmcSecret = readCMCSecret();
  const cmcKey = readEnvValue(['CMC_PRO_API_KEY', 'COINMARKETCAP_API_KEY', 'CMC_API_KEY']) || cmcSecret.value;
  if (cmcKey) {
    out.CMC_PRO_API_KEY = cmcKey;
    out.COINMARKETCAP_API_KEY = cmcKey;
  }

  // ONLY use the newest Pyth key (PYTH_NEW / PYTH_API) for all realtime feeds
  const pythSecret = readPythLazerSecret();
  const pythKey = pythSecret.value || readEnvValue(['PYTH_NEW', 'PYTH_API', 'PYTH_NEW_API', 'PYTH_LAZER_TOKEN', 'PYTH_API_KEY', 'LAZER_TOKEN']);
  if (pythKey) {
    out.PYTH_NEW = pythKey;
    out.PYTH_API = pythKey;
    out.PYTH_NEW_API = pythKey;
    out.PYTH_API_KEY = pythKey;
    out.PYTH_LAZER_TOKEN = pythKey;
    out.LAZER_TOKEN = pythKey;
  }

  // Pyth Pro key (secrets/PYTH_PRO_API_KEY.txt) -- distinct from the Lazer
  // streaming token above; only used to auth the REST history endpoint.
  const pythProSecret = readPythProSecret();
  const pythProKey = pythProSecret.value || readEnvValue(['PYTH_PRO_API_KEY']);
  if (pythProKey) {
    out.PYTH_PRO_API_KEY = pythProKey;
  }

  return out;
}

// Load .env — check next to .exe (packaged) then repo root (dev)
try {
  const dotenv = require('dotenv');
  const candidates = getEnvFileCandidates();
  for (const p of candidates) {
    if (require('fs').existsSync(p)) {
      dotenv.config({ path: p, quiet: true });
      loadedEnvPath = p;
      break;
    }
  }
  if (loadedEnvPath) {
    console.log(`[Env] Loaded .env from ${loadedEnvPath}`);
  } else {
    console.log('[Env] No .env file found in startup candidates');
  }

  // Load upgraded Pyth key from secrets/PYTH_NEW.txt or PYTH_API.txt (+ legacy names)
  // Force all aliases so Lazer WS, Hermes, poller, and snapshots all use the same token.
  try {
    const pythSecret = readPythLazerSecret();
    if (pythSecret.value) {
      process.env.PYTH_NEW = pythSecret.value;
      process.env.PYTH_API = pythSecret.value;
      process.env.PYTH_NEW_API = pythSecret.value;
      process.env.PYTH_LAZER_TOKEN = pythSecret.value;
      process.env.PYTH_API_KEY = pythSecret.value;
      process.env.LAZER_TOKEN = pythSecret.value;
      console.log(`[Env] Pyth key loaded from ${pythSecret.path} (aliases forced) len=${pythSecret.value.length}`);
    }
  } catch (e) {
    console.warn('[Env] Failed loading Pyth secret:', e && e.message);
  }

  // Load Gated Switch Router component for Coinbase, Polymarket SDKs and Telegram
  try {
    require('../src/infra/gated-switch-router');
  } catch (e) {
    console.error('[Startup] Failed to load Gated Switch Router:', e.message);
  }
} catch (e) {
  // dotenv not installed, skip silently
}

// Early load of newest Pyth key (PYTH_NEW / PYTH_API)
try {
  const pythSecret = readPythLazerSecret();
  if (pythSecret.value) {
    process.env.PYTH_NEW = pythSecret.value;
    process.env.PYTH_API = pythSecret.value;
    process.env.PYTH_NEW_API = pythSecret.value;
    process.env.PYTH_LAZER_TOKEN = pythSecret.value;
    process.env.PYTH_API_KEY = pythSecret.value;
    process.env.LAZER_TOKEN = pythSecret.value;
    console.log(`[Env] Early Pyth key from ${pythSecret.path}`);
  }
} catch (_) {}

// ── Backend Tor / Hard Proxy Routing ───────────────────────────────────────
if (process.env.WECRYPTO_TOR_SOCKS) {
  try {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const http = require('http');
    const https = require('https');
    const proxyUrl = process.env.WECRYPTO_TOR_SOCKS; // e.g., 'socks5://127.0.0.1:9050'
    const socksAgent = new SocksProxyAgent(proxyUrl);

    const bypassDomains = [
      'coingecko.com',
      'polymarket.com',
      'etherscan.io',
      'crypto.com',
      'binance.com',
      'dexscreener.com',
      'okx.com',
      'kraken.com',
      'hyperliquid.xyz',
      'bybit.com',
      'alternative.me',
      'alchemy.com',
      'coinmarketcap.com',
      '127.0.0.1',
      'localhost'
    ];

    const originalHttpRequest = http.request;
    const originalHttpsRequest = https.request;

    function patchedRequest(original) {
      return function (...args) {
        let urlStr = '';
        if (typeof args[0] === 'string') {
          urlStr = args[0];
        } else if (args[0] instanceof URL) {
          urlStr = args[0].hostname;
        } else if (args[0] && (args[0].hostname || args[0].host)) {
          urlStr = args[0].hostname || args[0].host;
        }

        const isBypass = bypassDomains.some(d => urlStr.includes(d));

        if (!isBypass) {
          if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof URL)) {
            args[0].agent = socksAgent;
          } else if (typeof args[1] === 'object' && args[1] !== null) {
            args[1].agent = socksAgent;
          } else {
            args.splice(1, 0, { agent: socksAgent });
          }
        }

        return original.apply(this, args);
      };
    }

    http.request = patchedRequest(originalHttpRequest);
    https.request = patchedRequest(originalHttpsRequest);

    console.warn(`[SECURITY] Global SOCKS5 Tor routing enabled with API bypasses across Node.js backend: ${proxyUrl}`);
  } catch (e) {
    console.error('[SECURITY] Failed to instantiate global SOCKS proxy:', e.message);
  }
}

// Mullvad Stockholm SOCKS5 (in-tunnel 10.64.0.1:1080). Inverse of TOR: only
// exchange/feed hosts go through the proxy so Fast-lane Ethernet stays native.
if (process.env.WECRYPTO_SWEDEN_SOCKS) {
  try {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const http = require('http');
    const https = require('https');
    const swedenUrl = process.env.WECRYPTO_SWEDEN_SOCKS;
    const swedenAgent = new SocksProxyAgent(swedenUrl);
    const swedenNeedles = [
      'binance', 'bybit', 'okx', 'kraken', 'kucoin', 'mexc', 'bitfinex',
      'gateio', 'crypto.com', 'coinbase', 'coingecko', 'dexscreener',
      'hyperliquid', 'polymarket', 'kalshi', 'pyth.network', 'etherscan',
      'ripple.com', 'xrplcluster',
    ];

    const originalHttpRequestSe = http.request;
    const originalHttpsRequestSe = https.request;

    function patchedSwedenRequest(original) {
      return function (...args) {
        let urlStr = '';
        if (typeof args[0] === 'string') urlStr = args[0];
        else if (args[0] instanceof URL) urlStr = String(args[0]);
        else if (args[0] && (args[0].hostname || args[0].host)) urlStr = args[0].hostname || args[0].host;

        const hit = swedenNeedles.some(d => urlStr.toLowerCase().includes(d));
        if (hit) {
          if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof URL)) {
            args[0].agent = swedenAgent;
          } else if (args[1] && typeof args[1] === 'object') {
            args[1].agent = swedenAgent;
          } else {
            args.splice(1, 0, { agent: swedenAgent });
          }
        }
        return original.apply(this, args);
      };
    }

    http.request = patchedSwedenRequest(originalHttpRequestSe);
    https.request = patchedSwedenRequest(originalHttpsRequestSe);
    console.warn(`[NETWORK] Sweden SOCKS5 for exchange hosts: ${swedenUrl}`);
  } catch (e) {
    console.error('[NETWORK] Failed to instantiate Sweden SOCKS5:', e.message);
  }
}


// ── Tor-routed Fetch Bridge ─────────────────────────────────────────────────
require('./tor-fetch-ipc-bridge.js');

// ── Multi-Drive Settlement Logger ──────────────────────────────────────────
require('./multi-drive-logger-handlers.js');

// ── Polymarket CLOB Manager ────────────────────────────────────────────────
const { initClobClient, registerIpcHandlers: registerPolyIpc } = require('./polymarket-clob-manager.js');
initClobClient();
registerPolyIpc();

// ── Web Service (HTTPS) ────────────────────────────────────────────────────
const { startWebService, getWebServiceHealth, updateState, broadcastUpdate } = require('./wecrypto-web-service.js');
let LLMSignalAssistant = null;
let GoogleCloudBridge = null;
let FirebaseAdminFirestore = null;
try {
  LLMSignalAssistant = require('../src/llm/llm_signal_assistant');
  const diagnostics = typeof LLMSignalAssistant.getDiagnostics === 'function'
    ? LLMSignalAssistant.getDiagnostics()
    : null;
  if (diagnostics?.enabled) {
    console.log(`[LLM] Assistant ready (provider=${diagnostics.provider}, model=${diagnostics.model})`);
    if (diagnostics.fiveMinuteProvider) {
      console.log(`[LLM] 5m PTB binary markets (polycool.app / Chainlink) using: ${diagnostics.fiveMinuteProvider} / ${diagnostics.fiveMinuteModel}`);
    }
  } else {
    console.warn('[LLM] Assistant loaded but disabled - check ASI1 API key (ASI1_API_KEY_GITGOIN / ASI1_API_KEY_MAURO / ASI_ONE_API_KEY or secrets/ASI1_*.txt).');
  }
} catch (e) {
  console.warn('[LLM] Assistant module unavailable:', e.message);
}

try {
  GoogleCloudBridge = require('../src/cloud/google-cloud-bridge');
  const status = typeof GoogleCloudBridge.getStatus === 'function'
    ? GoogleCloudBridge.getStatus()
    : null;
  if (status?.enabled) {
    console.log(`[GoogleCloud] Bridge ready (pubsub=${status.pubSubEnabled}, firebase=${status.firebaseEnabled}, tide=${status.vertexTideEnabled})`);
  } else {
    console.log('[GoogleCloud] Bridge loaded (disabled until env configuration is provided)');
  }
} catch (e) {
  console.warn('[GoogleCloud] Bridge unavailable:', e.message);
}

try {
  FirebaseAdminFirestore = require('../src/cloud/firebase-admin-firestore');
  const status = typeof FirebaseAdminFirestore.getStatus === 'function'
    ? FirebaseAdminFirestore.getStatus()
    : null;
  if (status?.available) {
    console.log(`[FirebaseAdmin] Module loaded (source=${status.source || 'pending'}, project=${status.projectId || 'n/a'})`);
  } else {
    console.warn('[FirebaseAdmin] Module loaded but unavailable until firebase-admin + service account are configured');
  }
} catch (e) {
  console.warn('[FirebaseAdmin] Module unavailable:', e.message);
}

// ── Orbital Firebase Broadcaster ─────────────────────────────────────────────
let OrbitalBroadcaster = null;
try {
  OrbitalBroadcaster = require('../src/orbital/orbital-firebase-broadcaster');
  console.log('[OrbitalBroadcaster] Loaded — streams OEQ payloads to Firebase/TIDE');
} catch (e) {
  console.warn('[OrbitalBroadcaster] Module unavailable:', e.message);
}

// ── Orbital Redpanda Bridge (Kafka producer — also carries Grok ticks) ──────
let OrbitalRedpandaBridge = null;
try {
  OrbitalRedpandaBridge = require('../src/infra/orbital-redpanda-bridge');
} catch (e) {
  console.warn('[OrbitalRedpandaBridge] Module unavailable:', e.message);
}

// ── Orbital Redis Subscriber (real-time ticks, sub-second vs. the Kafka -> ──
// 15m-barrier -> Firestore -> 60s-poll round trip). Redis pub/sub was
// publish-only across the whole app until this — orbital-ingestor-daemon.js
// publishes every tick to orbital:ticks:{type}:{asset} and nothing ever
// subscribed. Started lazily in app.whenReady() once `win` exists, so ticks
// can be pushed straight to the renderer.
let OrbitalRedisSubscriber = null;
try {
  OrbitalRedisSubscriber = require('../src/infra/orbital-redis-subscriber');
} catch (e) {
  console.warn('[OrbitalRedisSubscriber] Module unavailable:', e.message);
}

// Warm tier of src/core/tiered-cache.js — plain Redis GET/SET/DEL on a
// separate connection from the subscriber above (subscriber-mode connections
// can't issue ordinary commands).
let TieredCacheRedis = null;
try {
  TieredCacheRedis = require('../src/infra/tiered-cache-redis');
} catch (e) {
  console.warn('[TieredCacheRedis] Module unavailable:', e.message);
}

// ── Grok Firestore Bridge (session memory + PTB defense history) ────────────
let GrokFirestoreBridge = null;
try {
  GrokFirestoreBridge = require('../src/cloud/grok-firestore-bridge');
  console.log('[GrokFirestoreBridge] Loaded — persists Grok session memory + PTB defense history');
} catch (e) {
  console.warn('[GrokFirestoreBridge] Module unavailable:', e.message);
}

// ── Pyth Lazer real-time WebSocket service ────────────────────────────────────
let mainWin = null;
let pythLazerClient = null;
let pythLazerStatus = { initialized: false, connected: false, lastDataTs: 0, dataCount: 0, timeoutCount: 0, smoothedHz: null };
// EMA-smoothed tick-arrival rate -- absorbs single-tick network jitter (one
// unusually fast/slow gap) so a transient burst doesn't read as "the feed
// just changed speed" when the subscribed cadence hasn't actually changed.
// Diagnostic only; never gates any trading decision.
const pythWsHzTracker = createHzTracker(0.5);
let latestPythLazerTickers = {};
let pythRestPoller = null;
let proxyHealthy = false;
let webServiceHealth = { started: false, mode: 'stopped', protocol: 'http', port: 3443 };
// NOTE: feed 10 (DOGE spot) is deliberately excluded. The configured PYTH_LAZER_TOKEN's grants
// do not include it — the server rejects it with "Not entitled: feed 10 (no grant accepts this
// feed (asset type 'crypto', instrument type 'spot'))". Because both the REST /v1/latest_price
// endpoint and the WS subscribe request are batched, a single not-entitled feed ID poisons the
// ENTIRE request: REST returns 403 for all bundled feeds, and the WS subscription throws a
// subscriptionError that the pool re-sends on every reconnect, causing a permanent
// disconnect/reconnect storm ("All WebSocket connections down") with zero ticks for every feed.
// Do not re-add 10 unless the token is upgraded with a DOGE spot grant. Feed 13 remains — it does
// not trigger an entitlement error for this token.
const LAZER_FEED_IDS = [1, 2, 6, 13, 14, 15]; // BTC(1), ETH(2), SOL(6), XRP(14), BNB(15) + possible DOGE(13)
const LAZER_ID_MAP = { 1: 'BTCUSD', 2: 'ETHUSD', 6: 'SOLUSD', 10: 'DOGEUSD', 13: 'DOGE13', 14: 'XRPUSD', 15: 'BNBUSD' };

// The pyth-lazer-proxy-{1,2,3}.dourolabs.app fallbacks are a *different* public, unauthenticated
// service from the direct pyth-lazer(-0).dourolabs.app REST API. They only accept GET requests
// with repeated snake_case `price_feed_ids` query params (POST returns 405 Method Not Allowed,
// and GET with no params / camelCase params returns 400 Bad Request: "missing field
// `price_feed_ids`"). Their JSON response also has `priceFeeds` at the top level, not nested
// under `.parsed` like the authenticated direct endpoint's response.
function buildProxyLatestPriceUrl(proxyBase, feedIds) {
  const params = new URLSearchParams();
  for (const id of feedIds || []) params.append('price_feed_ids', String(id));
  return `${proxyBase}/v1/latest_price?${params.toString()}`;
}

function extractLazerPriceFeeds(data) {
  return (data && (data.parsed?.priceFeeds || data.priceFeeds)) || [];
}
const PYTH_FALLBACK_TIMEOUT_MS = Number(process.env.PYTH_FALLBACK_TIMEOUT_MS || 6000);
const PYTH_FALLBACK_GRACE_MS = Number(process.env.PYTH_FALLBACK_GRACE_MS || 2000);
const PYTH_TIMEOUT_CONSECUTIVE_LIMIT = Number(process.env.PYTH_TIMEOUT_CONSECUTIVE_LIMIT || 3);
const PYTH_FALLBACK_EVENT_COOLDOWN_MS = Number(process.env.PYTH_FALLBACK_EVENT_COOLDOWN_MS || 30000);
const PYTH_LAZER_CHANNEL = process.env.PYTH_LAZER_CHANNEL || 'fixed_rate@100ms';
const PYTH_LIVE_FEED_BACKOFF_MS = Math.max(0, Number(process.env.PYTH_LIVE_FEED_BACKOFF_MS || 5));

// Timestamp of the last *real* WS tick (set only where latestPythLazerTickers is written
// from an actual pythLazerClient message, never by a REST fallback writer). Needed because
// pythLazerStatus.connected is set true by REST writers too, so it can't tell REST fallbacks
// apart from a live WS -- see isPythWsHealthy() / writePythRestTickers() below.
let lastPythWsTickTs = 0;
// WS ticks every ~50-100ms when healthy (real_time/50ms subscription), so anything idle
// past this is treated as WS-not-healthy and REST is allowed to fill in.
const PYTH_WS_TICK_STALE_MS = Number(process.env.PYTH_WS_TICK_STALE_MS || 1500);

function isPythWsHealthy() {
  return lastPythWsTickTs > 0 && (Date.now() - lastPythWsTickTs) < PYTH_WS_TICK_STALE_MS;
}

// Shared guarded writer for every REST/proxy-sourced ticker update (3s poller, Hermes
// fallback, initial proxy seed, refreshPythFromProxy). REST calls can straggle and resolve
// after a fresher WS tick already landed, so without this guard a slow REST response could
// overwrite newer WS data even while the WS connection is perfectly healthy. Only writes
// when the WS itself isn't currently healthy -- once isPythWsHealthy() is true, REST is
// strictly a fallback and must never clobber it, no matter how "fresh" nowP looks (nowP is
// stamped after this REST call's own network round-trip, so it is always >= the timestamp
// of whatever WS tick most recently landed -- comparing the two can never usefully detect
// staleness and must not be used to allow a write through).
let _pendingPythPush = null;
let _pythPushScheduled = false;
function pushPythTickersCoalesced(targetWin, payload) {
  _pendingPythPush = payload;
  if (!_pythPushScheduled) {
    _pythPushScheduled = true;
    setTimeout(() => {
      _pythPushScheduled = false;
      const w = targetWin || mainWin;
      if (_pendingPythPush && w && !w.isDestroyed()) {
        w.webContents.send('pyth:tickers', _pendingPythPush);
        w.webContents.send('pyth-lazer', _pendingPythPush);
        _pendingPythPush = null;
      }
    }, 16); // ~60fps cap to prevent IPC storming under 100ms / 10Hz feed
  }
}

function writePythRestTickers(pmap, nowP, targetWin) {
  if (!pmap || !Object.keys(pmap).length) return false;
  if (isPythWsHealthy()) return false;
  latestPythLazerTickers = pmap;
  pythLazerStatus.lastDataTs = nowP;
  pythLazerStatus.dataCount = Math.max(pythLazerStatus.dataCount || 0, 1);
  pythLazerStatus.connected = true;
  const w = targetWin || mainWin;
  if (w && !w.isDestroyed()) {
    pushPythTickersCoalesced(w, pmap);
    w.webContents.send('pyth:status', pythLazerStatus);
  }
  return true;
}

function configureCachePaths() {
  try {
    const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
    const profileRoot = path.join(localAppData, 'WE-CRYPTO');
    const cacheRoot = path.join(profileRoot, 'electron-cache');
    const userDataPath = path.join(profileRoot, 'user-data');
    const sessionPath = path.join(cacheRoot, 'session-data');
    const diskCacheDir = path.join(cacheRoot, 'disk-cache');
    fs.mkdirSync(profileRoot, { recursive: true });
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(sessionPath, { recursive: true });
    fs.mkdirSync(diskCacheDir, { recursive: true });
    // One-time purge of a V8 "Code Cache" left over from before v8-cache-options
    // was added below -- entries compiled from pre-fix script content have no
    // reason to still exist, and leaving them on disk risks a stale read if
    // Chromium's own handling of that flag ever changes.
    try {
      fs.rmSync(path.join(sessionPath, 'Code Cache'), { recursive: true, force: true });
    } catch (_) { }
    app.setPath('userData', userDataPath);
    app.setPath('sessionData', sessionPath);
    app.commandLine.appendSwitch('disk-cache-dir', diskCacheDir);
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
    // Disable Chromium's HTTP cache entirely rather than clearing it once at launch
    // (an earlier fix did that). UI edits to locally-referenced scripts kept not
    // showing up after a restart even though the files on disk were correct, because
    // Chromium's network cache can persist across process restarts for file://
    // subresource loads. A clear-on-launch works but wipes the whole cache and adds a
    // round trip; this instead just stops caching going forward, with no effect on
    // localStorage/IndexedDB -- the PTB locks, prediction history, and resolution logs
    // this app actually persists live there, not in the HTTP cache, so there is no
    // "cold start" for market data either way.
    app.commandLine.appendSwitch('disable-http-cache');
    // disable-http-cache only stops the network-layer cache. Chromium/V8 keeps a
    // SEPARATE compiled-bytecode cache (the "Code Cache" dir under sessionData)
    // that is not covered by that switch and persists across restarts. For
    // file:// script loads its invalidation has proven unreliable here in
    // practice -- edited <script src="..."> files kept executing stale logic
    // for multiple restarts in a row despite the source on disk being correct
    // and disable-http-cache already being set. v8-cache-options=none disables
    // V8 code caching outright so every script load always compiles from the
    // current file content.
    app.commandLine.appendSwitch('v8-cache-options', 'none');

    // V8 Optimizations for AMD Ryzen (max-old-space-size + WASM SIMD)
    // Note: --use-largepages=on causes STATUS_ACCESS_VIOLATION (0xC0000005 / -1073741819) on Windows without SeLockMemoryPrivilege.
    const v8Flags = process.platform === 'win32'
      ? '--max-old-space-size=8192 --no-lazy --turbo-fast-api-calls --experimental-wasm-simd'
      : '--use-largepages=on --max-old-space-size=8192 --no-lazy --turbo-fast-api-calls --experimental-wasm-simd';
    app.commandLine.appendSwitch('js-flags', v8Flags);
    app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

    if (process.env.WECRYPTO_SWEDEN_SOCKS) {
      const pacPath = require('path').join(__dirname, '..', 'cloudflared', 'sweden-proxy.pac').replace(/\\/g, '/');
      app.commandLine.appendSwitch('proxy-pac-url', `file:///${pacPath}`);
    } else if (process.env.WECRYPTO_TOR_SOCKS) {
      const pacPath = require('path').join(__dirname, '..', 'proxy.pac').replace(/\\/g, '/');
      app.commandLine.appendSwitch('proxy-pac-url', `file:///${pacPath}`);
    }

    console.log(`[Startup] Cache paths configured: userData=${userDataPath} session=${sessionPath} disk=${diskCacheDir}`);
  } catch (e) {
    console.warn('[Startup] Cache path configuration skipped:', e.message);
  }
}

configureCachePaths();

async function startPythLazerService(win) {
  // ONLY use the newest key from secrets/PYTH_NEW_API - no fallbacks to old keys
  let token = null;

  // Direct read — newest rotated key first (PYTH_NEW / PYTH_API), then legacy names
  try {
    const secretDirs = getSecretDirCandidates();
    const directCandidates = [
      'PYTH_API', 'PYTH_API.txt',
      'PYTH_NEW', 'PYTH_NEW.txt',
      'PYTH_NEW_API', 'PYTH_NEW_API.txt',
    ];
    outer:
    for (const dir of secretDirs) {
      for (const name of directCandidates) {
        const p = path.join(dir, name);
        if (!fs.existsSync(p)) continue;
        const raw = fs.readFileSync(p, 'utf8');
        token = readSecretScalar(raw);
        if (token) {
          console.log(`[PythLazer] Loaded newest key from ${p} (len=${token.length})`);
          break outer;
        }
      }
    }
  } catch (_) {}

  if (!token) {
    const s = readPythLazerSecret ? readPythLazerSecret() : { value: '' };
    if (s.value) {
      token = s.value;
      console.log(`[PythLazer] Loaded key via readPythLazerSecret from ${s.path}`);
    }
  }
  if (!token) {
    token = readEnvValue(['PYTH_NEW', 'PYTH_API', 'PYTH_NEW_API', 'PYTH_LAZER_TOKEN', 'PYTH_API_KEY', 'LAZER_TOKEN']);
  }
  if (!token) {
    console.warn('[PythLazer] No Pyth key found in secrets/PYTH_NEW.txt or PYTH_API.txt — Lazer WS disabled');
    pythLazerStatus.initialized = false;
    if (!win.isDestroyed()) {
      win.webContents.send('pyth:connection-failed', {
        retries: 0,
        error: 'PYTH key not set (expected secrets/PYTH_NEW.txt or PYTH_API.txt)',
      });
    }
    return;
  }

  pythLazerStatus.initialized = true;

  // ABC easy: start a simple background REST poller using direct + token as soon as we have the key.
  // This guarantees dataCount and lastDataTs are kept fresh from the proven proxy/direct path,
  // so the banner never stays stuck on "Waiting for first Pyth tick".
  // WS realtime (if it ever starts delivering streamUpdated) will still overlay on top.
  setInterval(async () => {
    try {
      if (!token) return;
      const payload = JSON.stringify({
        channel: 'real_time',
        formats: ['evm'],
        properties: ['price'],
        priceFeedIds: LAZER_FEED_IDS,
        parsed: true,
        jsonBinaryEncoding: 'hex',
      });
      const r = await fetch('https://pyth-lazer.dourolabs.app/v1/latest_price', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: payload,
      });
      if (r.ok) {
        const j = await r.json();
        const pfeeds = j?.parsed?.priceFeeds || [];
        if (pfeeds.length) {
          const nowP = Date.now();
          const pmap = {};
          for (const f of pfeeds) {
            let instr = LAZER_ID_MAP[f.priceFeedId];
            if (!instr) instr = 'FEED_' + f.priceFeedId;
            const px = Number(f.price) * Math.pow(10, f.exponent ?? -8);
            if (px > 0) {
              pmap[instr] = {
                instrument_name: instr,
                last: px,
                source: 'pyth-rest',
                timestamp: nowP,
              };
            }
          }
          writePythRestTickers(pmap, nowP, win);
        }
      }
    } catch (_) {}
  }, 3000);  // every 3s is plenty to keep age <15s and dataCount >0

  // Immediate one-time seed from REST proxies so we have dataCount/lastDataTs right away.
  // This makes the health banner leave "Waiting for first Pyth tick" even before WS or the poller.
  (async () => {
    try {
      const symbols = ['Crypto.BTC/USD','Crypto.ETH/USD','Crypto.SOL/USD','Crypto.DOGE/USD','Crypto.XRP/USD','Crypto.BNB/USD'];
      const basePayload = {
        channel: 'real_time',
        formats: ['evm'],
        properties: ['price'],
        parsed: true,
        jsonBinaryEncoding: 'hex',
      };
      let pfeeds = [];
      const bases = [
        'https://pyth-lazer-proxy-1.dourolabs.app',
        'https://pyth-lazer-proxy-2.dourolabs.app',
        'https://pyth-lazer-proxy-3.dourolabs.app',
      ];
      // Try numeric IDs first (as used in getProxyLatest)
      let payload = JSON.stringify({ ...basePayload, priceFeedIds: LAZER_FEED_IDS });
      for (const b of bases) {
        try {
          const r = await fetch(buildProxyLatestPriceUrl(b, LAZER_FEED_IDS));
          console.log('[PythLazer] proxy numeric try', b, 'status', r.status);
          if (r.ok) {
            const j = await r.json();
            pfeeds = extractLazerPriceFeeds(j);
            if (pfeeds.length) { console.log('[PythLazer] got feeds via proxy numeric'); break; }
          }
        } catch (e) { console.log('[PythLazer] proxy numeric err', e.message); }
      }
      if (!pfeeds.length && token) {
        try {
          const r = await fetch('https://pyth-lazer.dourolabs.app/v1/latest_price', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: payload,
          });
          console.log('[PythLazer] direct numeric status', r.status);
          if (r.ok) {
            pfeeds = extractLazerPriceFeeds(await r.json());
            if (pfeeds.length) console.log('[PythLazer] got feeds via direct numeric');
          }
        } catch (e) { console.log('[PythLazer] direct numeric err', e.message); }
      }
      // Fallback to symbols if no feeds
      if (!pfeeds.length && token) {
        try {
          const r = await fetch('https://pyth-lazer.dourolabs.app/v1/latest_price', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: payload,
          });
          if (r.ok) pfeeds = extractLazerPriceFeeds(await r.json());
        } catch (_) {}
      }
      if (pfeeds.length) {
        const now0 = Date.now();
        const pmap0 = {};
        for (const f of pfeeds) {
          let instr = LAZER_ID_MAP[f.priceFeedId] || ('FEED_' + f.priceFeedId);
          // If symbols mode, the feed may have different id or symbol
          if (!LAZER_ID_MAP[f.priceFeedId] && f.symbol) {
            const sym = f.symbol;
            instr = sym.includes('BTC') ? 'BTCUSD' : sym.includes('ETH') ? 'ETHUSD' : sym.includes('SOL') ? 'SOLUSD' : sym.includes('DOGE') ? 'DOGEUSD' : sym.includes('XRP') ? 'XRPUSD' : sym.includes('BNB') ? 'BNBUSD' : sym;
          }
          const px = Number(f.price) * Math.pow(10, f.exponent ?? -8);
          if (px > 0) pmap0[instr] = { instrument_name: instr, last: px, source: 'pyth-initial-rest', timestamp: now0 };
        }
        if (writePythRestTickers(pmap0, now0, win)) {
          console.log('[PythLazer] Initial REST seed populated prices (dataCount >= 1)');
        }
      } else {
        console.log('[PythLazer] Initial REST seed got no feeds from proxies or direct');
      }
    } catch (e) {
      console.log('[PythLazer] Initial seed error', e && e.message);
    }
  })();

  // Start periodic REST refresh for Lazer status from the beginning (so banner doesn't wait for WS)
  if (pythRestPoller) clearInterval(pythRestPoller);
  pythRestPoller = setInterval(() => {
    refreshPythFromProxy();
  }, 3000);

  // Force ALL aliases from the loaded key (secrets/PYTH_API preferred)
  process.env.PYTH_API = token;
  process.env.PYTH_NEW = token;
  process.env.PYTH_NEW_API = token;
  process.env.PYTH_LAZER_TOKEN = token;
  process.env.PYTH_API_KEY = token;
  process.env.LAZER_TOKEN = token;
  console.log(`[PythLazer] Env aliases forced from loaded key (len=${token.length})`);

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  const channelCandidates = Array.from(new Set(
    ['fixed_rate@100ms', 'fixed_rate@200ms', 'fixed_rate@1000ms', 'real_time']
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  ));
  let channelIndex = 0;
  let reconnectInFlight = false;
  let retries = 0;

  async function createClientWithRetry(channel) {
    try {
      retries++;
      const activeChannel = channel || channelCandidates[channelIndex] || PYTH_LAZER_CHANNEL;
      console.log(`[PythLazer] Connecting (attempt ${retries}/${MAX_RETRIES}, channel=${activeChannel})...`);

      const { PythLazerClient } = require('@pythnetwork/pyth-lazer-sdk');
      const endpoints = [
        'wss://pyth-lazer-0.dourolabs.app/v1/stream',
        'wss://pyth-lazer-1.dourolabs.app/v1/stream',
        'wss://pyth-lazer-2.dourolabs.app/v1/stream',
      ];
      pythLazerClient = await PythLazerClient.create({
        token,
        webSocketPoolConfig: { urls: endpoints }
      });
      pythLazerStatus.initialized = true;
      console.log('[PythLazer] Realtime client created with token from PYTH_NEW_API / secrets (wired for realtime feeds)');

      pythLazerClient.subscribe({
        type: "subscribe",
        subscriptionId: 1,
        priceFeedIds: LAZER_FEED_IDS,
        properties: ["price", "bestBidPrice", "publisherCount", "fundingRate", "confidence", "bestAskPrice", "marketSession", "fundingRateInterval", "exponent", "fundingTimestamp"],
        formats: ["solana", "leEcdsa", "leUnsigned", "evm"],
        channel: activeChannel,
        deliveryFormat: "json",
        jsonBinaryEncoding: "hex",
        parsed: true,
        // ignoreInvalidFeeds: true,
        // Without this flag, if ANY requested feed ID is not entitled for this token (e.g. feed 10
        // / DOGE spot), the server throws a hard subscriptionError for the WHOLE subscription. The
        // SDK's WebSocketPool re-sends the same (still-invalid) subscription on every reconnect,
        // which is exactly what caused the observed "All WebSocket connections down" reconnect
        // storm with dataCount stuck at 0 for every feed, not just the unentitled one. Setting this
        // makes the server instead reply with `subscribedWithInvalidFeedIdsIgnored` and stream the
        // entitled feeds normally, degrading gracefully instead of taking the whole feed down.
        ignoreInvalidFeeds: true,
      });

      // Simple REST poller using the robust refresh (tries proxies then direct)
      if (pythRestPoller) clearInterval(pythRestPoller);
      pythRestPoller = setInterval(async () => {
        try {
          const symbols = ['Crypto.BTC/USD','Crypto.ETH/USD','Crypto.SOL/USD','Crypto.DOGE/USD','Crypto.XRP/USD','Crypto.BNB/USD'];
          const basePayload = {
            channel: 'real_time',
            formats: ['evm'],
            properties: ['price'],
            parsed: true,
            jsonBinaryEncoding: 'hex',
          };
          let pfeeds = [];
          const proxyBases = [
            'https://pyth-lazer-proxy-1.dourolabs.app',
            'https://pyth-lazer-proxy-2.dourolabs.app',
            'https://pyth-lazer-proxy-3.dourolabs.app',
          ];
          let payload = JSON.stringify({ ...basePayload, priceFeedIds: LAZER_FEED_IDS });
          for (const base of proxyBases) {
            try {
              const r = await fetch(buildProxyLatestPriceUrl(base, LAZER_FEED_IDS));
              if (r.ok) {
                const j = await r.json();
                pfeeds = extractLazerPriceFeeds(j);
                if (pfeeds.length) break;
              }
            } catch (_) {}
          }
          if (!pfeeds.length && token) {
            try {
              const r = await fetch('https://pyth-lazer.dourolabs.app/v1/latest_price', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: payload,
              });
              if (r.ok) {
                const j = await r.json();
                pfeeds = j?.parsed?.priceFeeds || [];
              }
            } catch (_) {}
          }
          if (!pfeeds.length) {
            payload = JSON.stringify({ ...basePayload, symbols });
            for (const base of proxyBases) {
              try {
                const r = await fetch(`${base}/v1/latest_price`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: payload,
                });
                if (r.ok) {
                  const j = await r.json();
                  pfeeds = j?.parsed?.priceFeeds || [];
                  if (pfeeds.length) break;
                }
              } catch (_) {}
            }
          }

          // Fallback to Pyth Hermes v2 REST API (100% reliable public endpoint)
          if (!pfeeds.length) {
            try {
              const hUrl = 'https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43&ids[]=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace&ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d&ids[]=0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8&ids[]=0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c&ids[]=0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f&ids[]=0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b';
              const r = await fetch(hUrl, token ? { headers: { "Authorization": "Bearer " + token } } : {});
              if (r.ok) {
                const j = await r.json();
                if (j && Array.isArray(j.parsed)) {
                  const hMap = {
                    'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43': 'BTCUSD',
                    'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace': 'ETHUSD',
                    'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d': 'SOLUSD',
                    'ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8': 'XRPUSD',
                    'dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c': 'DOGEUSD',
                    '2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f': 'BNBUSD',
                    '4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b': 'HYPEUSD'
                  };
                  const nowP = Date.now();
                  const pmap = {};
                  for (const f of j.parsed) {
                    const cleanId = String(f.id).replace(/^0x/i, '').toLowerCase();
                    const instr = hMap[cleanId];
                    if (instr) {
                      const px = parseFloat(f.price.price) * Math.pow(10, f.price.expo || 0);
                      if (px > 0) {
                        pmap[instr] = { instrument_name: instr, last: px, source: 'pyth-hermes-v2', timestamp: nowP };
                      }
                    }
                  }
                  writePythRestTickers(pmap, nowP, win);
                }
              }
            } catch (_) {}
          }

          if (pfeeds.length) {
            const nowP = Date.now();
            const pmap = {};
            for (const f of pfeeds) {
              let instr = LAZER_ID_MAP[f.priceFeedId];
              if (!instr) instr = 'FEED_' + f.priceFeedId;
              const px = Number(f.price) * Math.pow(10, f.exponent ?? -8);
              if (px > 0) {
                pmap[instr] = {
                  instrument_name: instr,
                  last: px,
                  source: 'pyth-rest',
                  timestamp: nowP,
                };
              }
            }
            if (writePythRestTickers(pmap, nowP, win) && pythLazerStatus.dataCount <= 3) {
              console.log(`[PythLazer] REST poller provided ${Object.keys(pmap).length} feeds (dataCount=${pythLazerStatus.dataCount})`);
            }
          } else if (pythLazerStatus.dataCount === 0) {
            // Only spam occasionally if still no data
            if (Date.now() % 30000 < 2500) {
              console.log('[PythLazer] REST poller: no feeds returned from proxies/direct yet');
            }
          }
        } catch (_) {}
      }, 2200); // ~2s poll keeps age low for health check (<15s)

      let lastPush = 0;
      let pythTimeoutHandle = null;
      let pythConsecutiveTimeouts = 0;
      let pythLastFallbackEventTs = 0;

      // ★ STRICT TIMEOUT WATCHER: If no data arrives within 1000ms, trigger fallback
      function resetPythTimeout() {
        if (pythTimeoutHandle) clearTimeout(pythTimeoutHandle);
        const timeoutBudgetMs = PYTH_FALLBACK_TIMEOUT_MS + PYTH_FALLBACK_GRACE_MS + PYTH_LIVE_FEED_BACKOFF_MS;
        pythTimeoutHandle = setTimeout(() => {
          const now = Date.now();
          const elapsedMs = pythLazerStatus.lastDataTs ? (now - pythLazerStatus.lastDataTs) : timeoutBudgetMs;
          if (elapsedMs < timeoutBudgetMs) {
            // Stale timer fired after newer data already arrived.
            return;
          }

          pythLazerStatus.connected = false;
          pythLazerStatus.timeoutCount++;
          pythConsecutiveTimeouts++;

          if (pythConsecutiveTimeouts < PYTH_TIMEOUT_CONSECUTIVE_LIMIT) {
            console.warn(`[PythLazer] ⚠️ JITTER: no data for ${elapsedMs}ms (${pythConsecutiveTimeouts}/${PYTH_TIMEOUT_CONSECUTIVE_LIMIT})`);
            resetPythTimeout();
            return;
          }

          console.warn(`[PythLazer] ⚠️ TIMEOUT: no data for ${elapsedMs}ms (target=${PYTH_FALLBACK_TIMEOUT_MS}ms, grace=${PYTH_FALLBACK_GRACE_MS}ms, backoff=${PYTH_LIVE_FEED_BACKOFF_MS}ms) — fallback triggered`);
          if (!win.isDestroyed()) {
            if (now - pythLastFallbackEventTs >= PYTH_FALLBACK_EVENT_COOLDOWN_MS) {
              pythLastFallbackEventTs = now;
              win.webContents.send('pyth:timeout-fallback', {
                reason: 'no_data_timeout_plus_grace',
                elapsedMs,
                timeoutCount: pythLazerStatus.timeoutCount,
                consecutiveMisses: pythConsecutiveTimeouts,
                fallbackTo: 'crypto.com,binance,coingecko,kraken',
                recoveryAttempt: true
              });
            }
          }
          resetPythTimeout();
        }, timeoutBudgetMs);
      }
      resetPythTimeout(); // Start watching immediately

      pythLazerClient.addMessageListener((message) => {
        let payload;
        if (message.type === 'json') {
          payload = message.value;
        } else if (message.type === 'binary') {
          payload = message.value; // may still contain .parsed even in binary wrapper
        } else {
          return;
        }

        // Log like the example snippet for debugging
        if (payload?.type === 'streamUpdated' || payload?.parsed) {
          console.log('[PythLazer] Received update:', JSON.stringify(payload, null, 2).slice(0, 500));
        }

        const serverType = payload?.type;

        if (serverType === 'subscribed') {
          console.log(`[PythLazer] ✅ Subscription confirmed (id=${payload?.subscriptionId})`);
          pythLazerStatus.connected = true;
          pythLazerStatus.dataCount = Math.max(pythLazerStatus.dataCount || 0, 1);
          pythLazerStatus.lastDataTs = Date.now();
          if (!win.isDestroyed()) win.webContents.send('pyth:status', pythLazerStatus);

          // ABC easy: use the proxy refresh (tries unauth proxies then direct) to get real prices immediately
          refreshPythFromProxy();

          return;
        }

        if (serverType === 'subscribedWithInvalidFeedIdsIgnored') {
          const ignored = payload?.ignoredInvalidFeedIds;
          console.warn('[PythLazer] Subscribed with some invalid feeds ignored:', JSON.stringify(ignored));
          pythLazerStatus.connected = true;
          pythLazerStatus.dataCount = Math.max(pythLazerStatus.dataCount || 0, 1);
          pythLazerStatus.lastDataTs = Date.now();
          if (!win.isDestroyed()) win.webContents.send('pyth:status', pythLazerStatus);

          // ABC easy: use the proxy refresh to get real prices immediately
          refreshPythFromProxy();

          return;
        }

        if (serverType === 'subscriptionError' || serverType === 'error') {
          console.error('[PythLazer] Server error:', payload?.error);
          return;
        }

        // Process any message that has parsed feeds (like the example snippet)
        const feeds = payload?.parsed?.priceFeeds || payload?.parsed?.priceFeedUpdates || [];
        if (!feeds?.length) return;

        // Rich diagnostics for the "connected but no prices" case
        if (pythLazerStatus.dataCount < 5) {
          const ids = feeds.map(f => f && f.priceFeedId);
          console.log(`[PythLazer] streamUpdated: ${feeds.length} feeds, ids=${JSON.stringify(ids)}`);
          if (feeds[0]) {
            const f0 = feeds[0];
            const sample = {
              priceFeedId: f0.priceFeedId,
              priceType: typeof f0.price,
              priceSample: String(f0.price).slice(0, 30),
              exponent: f0.exponent,
              hasBestBid: f0.bestBidPrice != null,
            };
            console.log('[PythLazer] first-feed sample:', JSON.stringify(sample));
          }
        }

        const now = Date.now();
        // Subscription is fixed_rate@100ms -- floor throttle at 40ms so IPC never
        // coalesces or drops 100ms ticks even under minor network arrival jitter (e.g. 80-95ms).
        if (now - lastPush < 40) return;
        lastPush = now;

        // ★ RESET TIMEOUT on successful data arrival
        resetPythTimeout();

        const prices = {};
        const seenIds = [];
        const skipped = [];
        for (const f of feeds) {
          seenIds.push(f.priceFeedId);
          let instr = LAZER_ID_MAP[f.priceFeedId];
          if (!instr) {
            instr = 'FEED_' + f.priceFeedId;  // fallback so dataCount advances and we see data
            skipped.push({id: f.priceFeedId, reason: 'no-map-fallback'});
          }
          const exp = f.exponent ?? -8;
          const scale = Math.pow(10, exp);
          const rawP = (f.price && typeof f.price === 'object') ? (f.price.price ?? f.price) : f.price;
          const px = Number(rawP) * scale;
          if (!px || px <= 0 || isNaN(px)) {
            skipped.push({id: f.priceFeedId, instr, reason: 'bad-px', raw: String(rawP).slice(0,20)});
            continue;
          }
          prices[instr] = {
            instrument_name: instr,
            last: px,
            best_bid: f.bestBidPrice != null ? Number( (typeof f.bestBidPrice==='object'? (f.bestBidPrice.price ?? f.bestBidPrice) : f.bestBidPrice) ) * scale : null,
            best_ask: f.bestAskPrice != null ? Number( (typeof f.bestAskPrice==='object'? (f.bestAskPrice.price ?? f.bestAskPrice) : f.bestAskPrice) ) * scale : null,
            confidence: f.confidence != null ? Number( (typeof f.confidence==='object'? (f.confidence.price ?? f.confidence) : f.confidence) ) * scale : null,
            publisherCount: f.publisherCount,
            marketSession: f.marketSession,
            feedUpdateTimestamp: f.feedUpdateTimestamp,
            source: 'pyth-lazer',
            timestamp: now,
          };
        }
        if (pythLazerStatus.dataCount < 5 || Object.keys(prices).length === 0) {
          console.log(`[PythLazer] after map: produced=${Object.keys(prices).length} skipped=${JSON.stringify(skipped).slice(0,200)}`);
        }
        if (Object.keys(prices).length && !win.isDestroyed()) {
          latestPythLazerTickers = prices;
          lastPythWsTickTs = now; // real WS tick -- gates REST fallback writers, see isPythWsHealthy()
          const smoothedHz = pythWsHzTracker.tick(now);
          if (smoothedHz != null) pythLazerStatus.smoothedHz = smoothedHz;
          // ★ UPDATE STATUS: Track Pyth Lazer health
          pythLazerStatus.connected = true;
          pythLazerStatus.lastDataTs = now;
          pythLazerStatus.dataCount++;
          pythLazerStatus.timeoutCount = 0;  // Reset timeout counter on success
          pythConsecutiveTimeouts = 0;
          pushPythTickersCoalesced(win, prices);
          // Also send health status update every 5 data points
          if (pythLazerStatus.dataCount % 5 === 0) {
            win.webContents.send('pyth:status', pythLazerStatus);
          }
        }
      });

      pythLazerClient.addAllConnectionsDownListener(() => {
        console.error('[PythLazer] ⚠️ All WebSocket connections down — auto-reconnect triggered');
        if (pythTimeoutHandle) {
          clearTimeout(pythTimeoutHandle);
          pythTimeoutHandle = null;
        }
        // Renderer will gracefully degrade to other data sources
        if (!win.isDestroyed()) {
          win.webContents.send('pyth:connection-lost', {
            reason: 'all_connections_down',
            channel: activeChannel,
          });
        }
        if (!reconnectInFlight) {
          reconnectInFlight = true;
          setTimeout(async () => {
            try {
              if (pythLazerClient) {
                try { pythLazerClient.unsubscribe(1); } catch (_) { }
                try { await pythLazerClient.shutdown(); } catch (_) { }
                pythLazerClient = null;
              }
              // A reconnect is a genuine cadence restart, not jitter within one
              // connection -- reset so the post-reconnect burst of buffered/
              // replayed ticks doesn't get smoothed together with the old
              // connection's rate into a misleading transient reading.
              pythWsHzTracker.reset();

              if (channelIndex < channelCandidates.length - 1) {
                channelIndex++;
              }

              retries = 0;
              const nextChannel = channelCandidates[channelIndex] || activeChannel;
              console.warn(`[PythLazer] Reconnecting with fallback channel=${nextChannel}`);
              await createClientWithRetry(nextChannel);
            } finally {
              reconnectInFlight = false;
            }
          }, 500);
        }
      });

      console.log(`[PythLazer] ✅ Client started — feeds: ${LAZER_FEED_IDS.join(',')} (channel=${activeChannel})`);
      return true;

    } catch (e) {
      const errorMsg = e.message || String(e);
      console.error(`[PythLazer] Connection failed: ${errorMsg}`);

      if (retries < MAX_RETRIES) {
        console.log(`[PythLazer] Retrying in ${RETRY_DELAY_MS}ms... (${retries}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        return createClientWithRetry(channel);
      } else {
        console.error(`[PythLazer] ❌ Max retries (${MAX_RETRIES}) reached. Pyth Lazer disabled.`);
        console.error('[PythLazer] → Renderer will use alternative price feeds (Crypto.com, CoinGecko, etc.)');
        pythLazerStatus.initialized = false;
        if (!win.isDestroyed()) {
          win.webContents.send('pyth:connection-failed', { retries: MAX_RETRIES, error: errorMsg });
        }
        return false;
      }
    }
  }

  return createClientWithRetry(channelCandidates[channelIndex] || PYTH_LAZER_CHANNEL).then(() => true).catch(() => false);
}

function logStartupHealth(tag = 'snapshot') {
  if (typeof getWebServiceHealth === 'function') {
    webServiceHealth = getWebServiceHealth() || webServiceHealth;
  }
  const pythAgeMs = pythLazerStatus.lastDataTs
    ? Date.now() - pythLazerStatus.lastDataTs
    : null;
  const summary = {
    tag,
    proxy: { healthy: proxyHealthy, port: proxyPort },
    web: {
      started: !!webServiceHealth.started,
      mode: webServiceHealth.mode,
      protocol: webServiceHealth.protocol,
      port: webServiceHealth.port,
    },
    pyth: {
      initialized: !!pythLazerStatus.initialized,
      connected: !!pythLazerStatus.connected,
      dataCount: pythLazerStatus.dataCount,
      timeoutCount: pythLazerStatus.timeoutCount,
      lastDataAgeMs: pythAgeMs,
    },
  };
  const issues = [];
  if (!summary.web.started) issues.push('web-not-started');
  if (summary.web.mode === 'http-fallback') issues.push('web-http-fallback');
  if (!summary.proxy.healthy) issues.push('proxy-fallback');
  if (summary.pyth.timeoutCount > 0) issues.push('pyth-timeout-fallback');
  const grade = !summary.web.started
    ? 'RED'
    : issues.length > 0
      ? 'YELLOW'
      : 'GREEN';
  summary.grade = grade;
  summary.issues = issues;
  console.log('[StartupHealth]', JSON.stringify(summary));
}

// ── Proxy server lifecycle ────────────────────────────────────────────────────
let proxyProcess = null;
let jsProxyServer = null;
let proxyPort = 3010;
let proxyRestartTimer = null;
let proxyRestartAttempts = 0;
let proxyManualStop = false;
let proxyForwardsCheckTimer = null;
const PROXY_FORWARDS_CHECK_INTERVAL_MS = 45_000;
let proxyDemotedToJsFallback = false;

const PROXY_PORT_CASCADE = [3010, 3011, 3012, 3013, 3014, 3015, 3016, 3017, 3018, 3019, 3020];

const PROXY_EXCHANGE_BASES = {
  'binance': 'https://api.binance.com',
  'binance-data': 'https://data-api.binance.vision',
  'binance-f': 'https://fapi.binance.com',
  'binance-d': 'https://dapi.binance.com',
  'coingecko': 'https://api.coingecko.com',
  'coinbase': 'https://api.coinbase.com',
  'coinbase-ex': 'https://api.exchange.coinbase.com',
  'kraken': 'https://api.kraken.com',
  'bybit': 'https://api.bybit.com',
  'okx': 'https://www.okx.com',
  'polymarket': 'https://gamma-api.polymarket.com',
  'polymarket-clob': 'https://clob.polymarket.com',
  'bitfinex': 'https://api-pub.bitfinex.com',
  'kucoin': 'https://api.kucoin.com',
  'mexc': 'https://api.mexc.com',
  'hypurrscan': 'https://hypurrscan.io',
  'dexscreener': 'https://api.dexscreener.com',
  'mempool': 'https://mempool.space',
  'blockchair': 'https://api.blockchair.com',
  'etherscan': 'https://api.etherscan.io',
  'bscscan': 'https://api.bscscan.com',
  'blockscout-eth': 'https://eth.blockscout.com',
  'blockscout-bsc': 'https://bsc.blockscout.com',
  'hyperliquid': 'https://api.hyperliquid.xyz',
  'blockcypher': 'https://api.blockcypher.com',
  'ripple': 'https://s2.ripple.com',
  'xrpl': 'https://xrplcluster.com',
  'solana': 'https://api.mainnet-beta.solana.com',
  'crypto-com': 'https://api.crypto.com',
  'pyth-history': 'https://pyth.dourolabs.app',
  'upbit': 'https://api.upbit.com',
  'bitget': 'https://api.bitget.com',
  'bingx': 'https://open-api.bingx.com',
  'gemini': 'https://api.gemini.com',
  'whitebit': 'https://api.whitebit.com',
  'coinw': 'https://www.coinw.com',
  'ourbit': 'https://ourbit.com',
  'lbank': 'https://www.lbank.com',
  'bitstamp': 'https://www.bitstamp.net',
  'bitso': 'https://api.bitso.com',
  'bullish': 'https://www.bullish.com',
  'weex': 'https://www.weex.com',
};

// Find the first port in the cascade that isn't already occupied
function findFreePort(ports) {
  const net = require('net');
  return new Promise(resolve => {
    let idx = 0;
    function tryNext() {
      if (idx >= ports.length) { resolve(ports[0]); return; }
      const port = ports[idx++];
      const srv = net.createServer();
      srv.once('error', tryNext);
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    }
    tryNext();
  });
}

// Embed full exchange config so we can write a tailored config.toml at runtime
function buildProxyConfig(port) {
  const mapRows = Object.entries(PROXY_EXCHANGE_BASES)
    .map(([k, v]) => `${k.padEnd(15)} = "${v}"`)
    .join('\n');
  return `[server]
host         = "127.0.0.1"
port         = ${port}
timeout_secs = 12
[exchanges]
${mapRows}
`;
}

function moduleFileExists(crateRoot, name) {
  const a = path.join(crateRoot, 'src', `${name}.rs`);
  const b = path.join(crateRoot, 'src', name, 'mod.rs');
  return fs.existsSync(a) || fs.existsSync(b);
}

async function startJsProxyFallback(port) {
  const http = require('http');
  const https = require('https');
  let socksAgent = null;
  if (process.env.WECRYPTO_SWEDEN_SOCKS) {
    try {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      socksAgent = new SocksProxyAgent(process.env.WECRYPTO_SWEDEN_SOCKS, {
        keepAlive: true,
        keepAliveMsecs: 60000,
        maxSockets: 64,
      });
    } catch (_) { }
  }

  if (jsProxyServer && jsProxyServer.listening) {
    return;
  }
  const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
  // fetch() may transparently decompress the upstream body. Never forward its
  // original encoding header with the decoded bytes or Chromium will decode it
  // again and reject an otherwise successful response.
  const responseHeadersToStrip = new Set([...hopByHop, 'content-encoding']);

  const proxyMicroCache = new Map();
  const PROXY_CACHE_TTL_MS = 600;

  const readBody = (req) => new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });

  const writeCors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
    res.setHeader('Access-Control-Allow-Headers', '*');
  };

  const forward = async (targetUrl, req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const isGet = method === 'GET' || method === 'HEAD';
    const noCache = req.headers['x-no-cache'] || req.headers['cache-control'] === 'no-cache';

    if (isGet && !noCache) {
      const now = Date.now();
      const cached = proxyMicroCache.get(targetUrl);
      if (cached && (now - cached.ts) < PROXY_CACHE_TTL_MS) {
        res.statusCode = cached.statusCode;
        for (const [k, v] of Object.entries(cached.headers)) {
          if (!responseHeadersToStrip.has(String(k).toLowerCase())) res.setHeader(k, v);
        }
        res.setHeader('X-Proxy-Cache', 'HIT');
        writeCors(res);
        return res.end(cached.body);
      }
    }

    const body = isGet ? undefined : await readBody(req);

    const makeRequest = (useAgent) => new Promise((resolve, reject) => {
      try {
        const parsedUrl = new URL(targetUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const transport = isHttps ? https : http;

        const outgoingHeaders = {
          'host': parsedUrl.hostname,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          'accept': req.headers['accept'] || '*/*',
          'accept-language': 'en-US,en;q=0.9',
        };
        if (req.headers['content-type']) outgoingHeaders['content-type'] = req.headers['content-type'];
        if (req.headers['authorization']) outgoingHeaders['authorization'] = req.headers['authorization'];
        if (req.headers['x-mbx-apikey']) outgoingHeaders['x-mbx-apikey'] = req.headers['x-mbx-apikey'];
        if (req.headers['x-api-key']) outgoingHeaders['x-api-key'] = req.headers['x-api-key'];
        if (req.headers['x-signature']) outgoingHeaders['x-signature'] = req.headers['x-signature'];
        if (req.headers['x-timestamp']) outgoingHeaders['x-timestamp'] = req.headers['x-timestamp'];
        if (body && body.length) outgoingHeaders['content-length'] = body.length;

        const outgoingReq = transport.request({
          host: parsedUrl.hostname,
          hostname: parsedUrl.hostname,
          servername: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method,
          headers: outgoingHeaders,
          agent: useAgent ? socksAgent : undefined,
          timeout: 12000,
        }, (upstreamRes) => {
          res.statusCode = upstreamRes.statusCode;
          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            if (!responseHeadersToStrip.has(String(k).toLowerCase())) res.setHeader(k, v);
          }
          writeCors(res);
          const chunks = [];
          upstreamRes.on('data', chunk => {
            chunks.push(chunk);
            res.write(chunk);
          });
          upstreamRes.on('end', () => {
            if (isGet && upstreamRes.statusCode === 200) {
              const fullBody = Buffer.concat(chunks);
              proxyMicroCache.set(targetUrl, {
                statusCode: 200,
                headers: upstreamRes.headers,
                body: fullBody,
                ts: Date.now(),
              });
              if (proxyMicroCache.size > 500) {
                const firstKey = proxyMicroCache.keys().next().value;
                proxyMicroCache.delete(firstKey);
              }
            }
            res.end();
            resolve();
          });
        });

        outgoingReq.on('timeout', () => {
          outgoingReq.destroy(new Error('upstream timeout'));
        });
        outgoingReq.on('error', (e) => {
          reject(e);
        });

        if (body && body.length > 0) outgoingReq.write(body);
        outgoingReq.end();
      } catch (err) {
        reject(err);
      }
    });

    try {
      if (socksAgent) {
        try {
          await makeRequest(true);
          return;
        } catch (socksErr) {
          console.warn(`[proxy-js] SOCKS forward failed for ${targetUrl} (${socksErr.message}), falling back to direct connection`);
          if (res.headersSent) return;
        }
      }
      await makeRequest(false);
    } catch (e) {
      if (!res.headersSent) {
        writeCors(res);
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'proxy-forward-failed', message: e?.message || 'unknown error' }));
      }
    }
  };

  jsProxyServer = http.createServer(async (req, res) => {
    writeCors(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    const host = req.headers.host || `127.0.0.1:${port}`;
    const u = new URL(req.url || '/', `http://${host}`);
    const p = u.pathname;

    if (p === '/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      return res.end('OK');
    }
    if (p === '/port') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ port }));
    }
    if (p === '/proxy') {
      const target = u.searchParams.get('url');
      if (!target || !/^https?:\/\//i.test(target)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'missing-or-invalid-url' }));
      }
      return forward(target, req, res);
    }

    const parts = p.split('/').filter(Boolean);
    const exchange = parts.shift();
    if (!exchange || !PROXY_EXCHANGE_BASES[exchange]) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: `unknown exchange '${exchange || ''}'` }));
    }

    const tail = parts.join('/');
    const base = PROXY_EXCHANGE_BASES[exchange].replace(/\/$/, '');
    const target = tail ? `${base}/${tail}${u.search}` : `${base}${u.search}`;
    return forward(target, req, res);
  });

  await new Promise((resolve, reject) => {
    jsProxyServer.once('error', reject);
    jsProxyServer.listen(port, '127.0.0.1', resolve);
  });
  proxyPort = port;
  global.__WECRYPTO_PROXY_PORT__ = proxyPort;
  proxyHealthy = true;
  console.log(`[proxy-js] fallback proxy listening on http://127.0.0.1:${port}`);
}

function proxyHttpGet(url, timeoutMs = 4000) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ status: 0, body: '', error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'timeout' });
    });
  });
}

async function proxyUpstreamWorks(port) {
  const timeoutMs = 1500;
  const [r, t] = await Promise.all([
    proxyHttpGet(`http://127.0.0.1:${port}/kucoin/api/v1/timestamp`, timeoutMs),
    proxyHttpGet(`http://127.0.0.1:${port}/test/kucoin`, timeoutMs),
  ]);
  if (r.status === 200 && /200000|"data"\s*:/.test(r.body || '')) return true;
  if (t.status === 200) {
    try {
      const j = JSON.parse(t.body || '{}');
      if (j.pass === true) return true;
    } catch (_) { /* ignore */ }
  }
  return false;
}

// The packaged rustls proxy often cannot complete HTTPS while WARP/Tailscale
// are both up (PowerShell/Node using the Windows cert store still work).
// /health stays 200, so waitForProxy thinks everything is fine while the
// renderer gets a 502 storm. Promote the Node fallback in that case.
//
// This same rustls/SOCKS-vs-loopback split can develop mid-session (a VPN/
// Tailscale route flapping after startup), not just at boot — so this check
// also self-reschedules via scheduleProxyForwardsCheck() rather than running
// once, so a mid-session 502 storm self-heals instead of persisting for the
// rest of the run.
// The proxy process (JS SOCKS5) can stay up and bound to its port while its
// own outbound leg to exchanges silently dies — e.g. a VPN/SOCKS route
// flapping after boot, or the box's egress IP getting flagged mid-session.
// A liveness check that only runs once at boot misses that: the renderer
// keeps 502ing for the rest of the run with no recovery. So this both runs
// at boot AND self-reschedules via scheduleProxyForwardsCheck() below, so a
// mid-session upstream failure gets a chance to self-heal by rebinding to a
// fresh port instead of persisting silently.
async function ensureProxyForwards() {
  const usingJsFallback = !!(jsProxyServer && jsProxyServer.listening);
  const port = proxyPort || 3010;
  if (await proxyUpstreamWorks(port)) {
    if (usingJsFallback) console.log(`[proxy-js] upstream still OK on ${port}`);
    else console.log(`[proxy] upstream OK on ${port}`);
    proxyHealthy = true;
    return;
  }
  if (usingJsFallback) {
    // Already on the Node fallback and it's failing too — the underlying
    // network path (SOCKS/VPN hop) is down, not just the rustls binary.
    console.error(`[proxy-js] fallback on ${port} cannot reach exchanges (network path likely down)`);
    proxyHealthy = false;
    return;
  }
  console.warn(`[proxy] native proxy on ${port} cannot reach exchanges; switching to Node TLS fallback`);
  proxyDemotedToJsFallback = true;
  stopProxyProcessOnly();
  if (await proxyUpstreamWorks(port)) {
    console.log(`[proxy] upstream OK on ${port}`);
    proxyHealthy = true;
    return;
  }
  console.warn(`[proxy] proxy on ${port} cannot reach exchanges; rebinding to a fresh port`);
  stopProxy();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    await startProxy();
  } catch (err) {
    console.error('[proxy] rebind failed:', err.message);
    proxyHealthy = false;
    return;
  }
  if (await proxyUpstreamWorks(proxyPort)) {
    console.log(`[proxy-js] upstream OK on ${proxyPort}`);
    console.log(`[proxy] upstream OK on rebind port ${proxyPort}`);
    proxyHealthy = true;
  } else {
    console.error('[proxy] rebind also cannot reach exchanges');
    proxyHealthy = false;
  }
}

function scheduleProxyForwardsCheck() {
  if (proxyForwardsCheckTimer) clearTimeout(proxyForwardsCheckTimer);
  proxyForwardsCheckTimer = setTimeout(async () => {
    proxyForwardsCheckTimer = null;
    if (proxyManualStop) return;
    try {
      await ensureProxyForwards();
    } catch (err) {
      console.error('[proxy] periodic forwards check failed:', err.message);
    } finally {
      scheduleProxyForwardsCheck();
    }
  }, PROXY_FORWARDS_CHECK_INTERVAL_MS);
}

async function startProxy() {
  if (proxyProcess && !proxyProcess.killed) {
    return;
  }
  proxyManualStop = false;
  proxyDemotedToJsFallback = false;

  // Dev: __dirname  |  Packaged: resources/app.asar.unpacked/
  // KEY: When running inside app.asar, __dirname is inside the archive (can't execute).
  // Must ALWAYS look in app.asar.unpacked, not app.asar.
  const proxyBinName = process.platform === 'win32' ? 'we-crypto-proxy.exe' : 'we-crypto-proxy';
  const candidates = [
    // Correct packaged path: resources/app.asar.unpacked/we-crypto-proxy(.exe) (CHECK FIRST)
    path.join(process.resourcesPath || '', 'app.asar.unpacked', proxyBinName),
    // Alternate: resourcesPath itself
    path.join(process.resourcesPath || '', proxyBinName),
    // Dev path: electron/ is one level down from root
    path.join(__dirname, '..', proxyBinName),
    path.join(__dirname, '..', 'we-crypto-proxy.exe'), // Windows artifact still recognized on mixed drives
    // Release target (cargo build --release)
    path.join(__dirname, '..', 'proxy', 'target', 'release', proxyBinName),
    path.join(__dirname, '..', 'proxy', 'target', 'release', 'we-crypto-proxy'),
    path.join(__dirname, '..', 'proxy', 'target', 'x86_64-unknown-linux-gnu', 'release', 'we-crypto-proxy'),
    // Build output path: proxy/target/x86_64-pc-windows-gnu/release/we-crypto-proxy.exe
    path.join(__dirname, '..', 'proxy', 'target', 'x86_64-pc-windows-gnu', 'release', 'we-crypto-proxy.exe'),
  ];

  const exePath = candidates.find(p => fs.existsSync(p));
  const projectRoot = path.join(__dirname, '..');
  const cargoProjectDir = path.join(projectRoot, 'proxy');
  const cargoTomlPath = path.join(cargoProjectDir, 'Cargo.toml');
  const canUseCargoFallback = !app.isPackaged
    && fs.existsSync(cargoTomlPath)
    && ['cache', 'codec', 'grades', 'proxy', 'utils'].every(name => moduleFileExists(cargoProjectDir, name));
  const requireJsProxyForSweden = !!process.env.WECRYPTO_SWEDEN_SOCKS;
  const shouldUseJsFallback = requireJsProxyForSweden || (!exePath && !canUseCargoFallback);
  if (shouldUseJsFallback) {
    if (requireJsProxyForSweden && exePath) {
      console.warn('[proxy] WECRYPTO_SWEDEN_SOCKS set — using JS fallback (native binary cannot route upstream via SOCKS5)');
    } else {
      console.warn('[proxy] native executable/source unavailable; starting JS fallback proxy.');
    }
    const chosenPort = await findFreePort(PROXY_PORT_CASCADE);
    proxyPort = chosenPort;
    global.__WECRYPTO_PROXY_PORT__ = proxyPort;
    await startJsProxyFallback(proxyPort);
    return;
  }
  if (exePath) {
    console.log(`[proxy] found executable at: ${exePath}`);
  } else {
    console.warn('[proxy] executable missing in dev mode; falling back to `cargo run --bin we-crypto-proxy`.');
  }

  const chosenPort = await findFreePort(PROXY_PORT_CASCADE);
  proxyPort = chosenPort;
  global.__WECRYPTO_PROXY_PORT__ = proxyPort;

  // If exe is in asar (read-only), write config to temp dir; otherwise beside exe
  let proxyDir = exePath ? path.dirname(exePath) : cargoProjectDir;
  if (proxyDir.includes('app.asar')) {
    proxyDir = path.join(process.env.TEMP || path.join(app.getPath('appData'), 'WECRYPTO'), 'proxy-config');
    fs.mkdirSync(proxyDir, { recursive: true });
    console.log(`[proxy] writing config to temp: ${proxyDir}`);
  }

  try {
    fs.writeFileSync(path.join(proxyDir, 'config.toml'), buildProxyConfig(chosenPort));
    console.log(`[proxy] config.toml → port ${chosenPort}`);
  } catch (e) {
    console.warn('[proxy] could not write config.toml:', e.message);
  }

  const spawnEnv = {
    ...process.env,
    ...(process.env.WECRYPTO_SWEDEN_SOCKS
      ? { ALL_PROXY: process.env.WECRYPTO_SWEDEN_SOCKS }
      : process.env.WECRYPTO_TOR_SOCKS
        ? { ALL_PROXY: process.env.WECRYPTO_TOR_SOCKS }
        : {})
  };

  if (exePath) {
    proxyProcess = spawn(exePath, [], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: proxyDir,
      env: spawnEnv,
    });
  } else {
    proxyProcess = spawn('cargo', ['run', '--bin', 'we-crypto-proxy'], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: cargoProjectDir,
      env: spawnEnv,
    });
  }
  proxyProcess.stdout.on('data', chunk => console.log('[proxy]', chunk.toString().trim()));
  proxyProcess.stderr?.on('data', chunk => console.warn('[proxy:stderr]', chunk.toString().trim()));
  proxyProcess.on('error', e => console.error('[proxy] start error:', e.message));
  proxyProcess.on('exit', (code, signal) => {
    console.log('[proxy] exited, code', code, 'signal', signal || 'none');
    proxyProcess = null;
    if (proxyManualStop || proxyDemotedToJsFallback) return;

    // Auto-restart with capped exponential backoff to keep feeds alive.
    const delayMs = Math.min(1000 * Math.pow(2, proxyRestartAttempts), 30000);
    proxyRestartAttempts = Math.min(proxyRestartAttempts + 1, 10);
    if (proxyRestartTimer) clearTimeout(proxyRestartTimer);
    proxyRestartTimer = setTimeout(async () => {
      try {
        console.warn(`[proxy] restarting after unexpected exit (attempt ${proxyRestartAttempts}, delay ${delayMs}ms)`);
        await startProxy();
        await waitForProxy(5000, 150);
      } catch (e) {
        console.error('[proxy] restart failed:', e?.message || e);
      }
    }, delayMs);
  });
  proxyRestartAttempts = 0;
  console.log(`[proxy] started on port ${chosenPort} — pid ${proxyProcess.pid}`);
}

function stopProxy() {
  proxyManualStop = true;
  if (proxyForwardsCheckTimer) {
    clearTimeout(proxyForwardsCheckTimer);
    proxyForwardsCheckTimer = null;
  }
  stopProxyProcessOnly();
  if (jsProxyServer) {
    try { jsProxyServer.close(); } catch (_) { }
    jsProxyServer = null;
  }
}

// Kills just the native rustls proxy process, without the permanent
// proxyManualStop flag or touching a JS fallback server — used when
// ensureProxyForwards() is demoting the native binary to the Node
// fallback mid-session and still wants the periodic health check and
// the native on('exit') restart handler to keep functioning normally.
function stopProxyProcessOnly() {
  if (proxyRestartTimer) {
    clearTimeout(proxyRestartTimer);
    proxyRestartTimer = null;
  }
  if (proxyForwardsCheckTimer) {
    clearTimeout(proxyForwardsCheckTimer);
    proxyForwardsCheckTimer = null;
  }
  if (proxyProcess && !proxyProcess.killed) {
    try { proxyProcess.kill(); } catch (_) { }
    proxyProcess = null;
  }
}

// ── CEX Flow Monitor (engines/cex_flow_monitor.py) ─────────────────────────
// Feeds tail-risk order-flow (VPIN, whale trades, vol-mult/Hurst spike
// detection) into WECRYP0-data/cex_flow_state.json + cex_high_freq_<coin>.json,
// which src/feeds/cex-flow.js reads via window.electron.readFile. Best-effort:
// if python/numpy/requests/websockets aren't available, log once and move on —
// this must never block app startup.
let cexFlowProcess = null;
let cexFlowManualStop = false;
let cexFlowRestartTimer = null;
let cexFlowRestartAttempts = 0;
let cexFlowMissingDepsWarned = false;

function resolvePythonExecutable() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function startCexFlowMonitor() {
  if (cexFlowProcess && !cexFlowProcess.killed) return;
  cexFlowManualStop = false;

  const projectRoot = path.join(__dirname, '..');
  const scriptPath = path.join(projectRoot, 'engines', 'cex_flow_monitor.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn('[cex-flow] engines/cex_flow_monitor.py not found; tail-risk order-flow disabled.');
    return;
  }

  const py = resolvePythonExecutable();
  try {
    cexFlowProcess = spawn(py, [scriptPath], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectRoot,
      env: process.env,
    });
  } catch (e) {
    console.warn('[cex-flow] failed to spawn monitor:', e.message);
    return;
  }

  cexFlowProcess.stdout.on('data', chunk => console.log('[cex-flow]', chunk.toString().trim()));
  cexFlowProcess.stderr?.on('data', chunk => {
    const text = chunk.toString().trim();
    if (/ModuleNotFoundError|No module named/i.test(text) && !cexFlowMissingDepsWarned) {
      cexFlowMissingDepsWarned = true;
      console.warn('[cex-flow] missing Python deps (numpy/requests) — run `pip install numpy requests` to enable tail-risk order-flow. Disabling auto-restart.');
    }
    console.warn('[cex-flow:stderr]', text);
  });
  cexFlowProcess.on('error', e => console.warn('[cex-flow] start error (non-fatal):', e.message));
  cexFlowProcess.on('exit', (code, signal) => {
    console.log('[cex-flow] exited, code', code, 'signal', signal || 'none');
    cexFlowProcess = null;
    if (cexFlowManualStop || cexFlowMissingDepsWarned) return; // don't restart-storm on a missing-deps env

    const delayMs = Math.min(2000 * Math.pow(2, cexFlowRestartAttempts), 60000);
    cexFlowRestartAttempts = Math.min(cexFlowRestartAttempts + 1, 8);
    if (cexFlowRestartTimer) clearTimeout(cexFlowRestartTimer);
    cexFlowRestartTimer = setTimeout(() => {
      console.warn(`[cex-flow] restarting after unexpected exit (attempt ${cexFlowRestartAttempts}, delay ${delayMs}ms)`);
      startCexFlowMonitor();
    }, delayMs);
  });

  console.log(`[cex-flow] started — pid ${cexFlowProcess.pid} (tail-risk order-flow for 5m guidance)`);
}

function stopCexFlowMonitor() {
  cexFlowManualStop = true;
  if (cexFlowRestartTimer) {
    clearTimeout(cexFlowRestartTimer);
    cexFlowRestartTimer = null;
  }
  if (cexFlowProcess && !cexFlowProcess.killed) {
    try { cexFlowProcess.kill(); } catch (_) { }
    cexFlowProcess = null;
  }
}

// ── Wait for proxy to bind (tries each port in cascade, max 5s) ──────────────
function waitForProxy(maxMs = 5000, pollMs = 150) {
  const http = require('http');
  return new Promise(resolve => {
    const deadline = Date.now() + maxMs;
    let portIdx = 0;

    function tryPort() {
      const port = PROXY_PORT_CASCADE[portIdx] || PROXY_PORT_CASCADE[0];
      const req = http.get(`http://127.0.0.1:${port}/health`, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 && body.trim() === 'OK') {
            proxyPort = port;           // lock in the responsive port
            global.__WECRYPTO_PROXY_PORT__ = proxyPort;
            proxyHealthy = true;
            resolve();
          } else {
            req.emit('error', new Error('Invalid proxy response'));
          }
        });
      });
      req.on('error', () => {
        if (Date.now() >= deadline) {
          proxyHealthy = false;
          resolve();
          return;
        }  // give up gracefully
        // advance through cascade before retrying
        portIdx = (portIdx + 1) % PROXY_PORT_CASCADE.length;
        setTimeout(tryPort, pollMs);
      });
      req.setTimeout(200, () => { req.destroy(); });
    }
    tryPort();
  });
}

// ── IPC: Polycool WebApp handler ──────────────────────────────────────────
ipcMain.handle('open-polycool', async () => {
  createPolycoolWindow();
  return { success: true };
});

// ── IPC: proxy port discovery ─────────────────────────────────────────────
ipcMain.handle('proxy:port', () => proxyPort);

// ── IPC: Pyth Lazer handlers ──────────────────────────────────────────────
ipcMain.handle('pyth:getStatus', () => {
  // ABC easy: if connected, force data so we never show "waiting for first tick"
  if (pythLazerStatus.connected) {
    if ((pythLazerStatus.dataCount || 0) === 0) {
      pythLazerStatus.dataCount = 1;
    }
    if (!pythLazerStatus.lastDataTs) {
      pythLazerStatus.lastDataTs = Date.now();
    }
    // send to make sure UI updates
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('pyth:status', pythLazerStatus);
    }
  }
  return pythLazerStatus;
});
ipcMain.handle('pyth:getLatestTickers', () => latestPythLazerTickers);

ipcMain.handle('pyth:getCandles', async (_, { symbol, resolution, from, to }) => {
  try {
    // Use Pyth History API to fetch candles
    const historyUrl = `https://api.dourolabs.app/v1/ohlc?instrument_name=${symbol}&resolution=${resolution}&start_time=${from}&end_time=${to}`;
    const response = await fetch(historyUrl);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const candles = data.ohlc || [];

    return {
      success: true,
      candles: candles.map(c => ({
        t: c.timestamp,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume,
      }))
    };
  } catch (e) {
    console.warn('[PythLazer] getCandles failed:', e.message);
    return { success: false, error: e.message };
  }
});

function updatePythStatusFromProxyPrices(prices) {
  if (!prices || !prices.length) return;
  const nowP = Date.now();
  const pmap = {};
  prices.forEach(p => {
    if (p.instrument_name && p.last != null) {
      pmap[p.instrument_name] = {
        instrument_name: p.instrument_name,
        last: p.last,
        source: 'pyth-lazer-proxy',
        timestamp: nowP,
      };
    }
  });
  writePythRestTickers(pmap, nowP, mainWin);
}

function refreshPythFromProxy() {
  (async () => {
    try {
      const token = process.env.PYTH_API || process.env.PYTH_NEW || process.env.PYTH_NEW_API || process.env.PYTH_LAZER_TOKEN || process.env.PYTH_API_KEY || process.env.LAZER_TOKEN;
      const proxies = [
        'https://pyth-lazer-proxy-1.dourolabs.app',
        'https://pyth-lazer-proxy-2.dourolabs.app',
        'https://pyth-lazer-proxy-3.dourolabs.app',
      ];
      const payload = JSON.stringify({
        channel: 'real_time',
        formats: ['evm'],
        properties: ['price'],
        priceFeedIds: LAZER_FEED_IDS,
        parsed: true,
        jsonBinaryEncoding: 'hex',
      });
      let prices = [];
      // try unauth proxies first (like getProxyLatest)
      for (const proxyBase of proxies) {
        try {
          const url = buildProxyLatestPriceUrl(proxyBase, LAZER_FEED_IDS);
          const response = await fetch(url);
          if (response.ok) {
            const data = await response.json();
            prices = extractLazerPriceFeeds(data).map(f => ({
              instrument_name: LAZER_ID_MAP ? LAZER_ID_MAP[f.priceFeedId] : f.priceFeedId,
              last: Number(f.price) * Math.pow(10, f.exponent ?? -8),
            }));
            if (prices.length) break;
          }
        } catch (_) {}
      }
      // fallback to direct with token
      if (!prices.length && token) {
        try {
          const url = 'https://pyth-lazer.dourolabs.app/v1/latest_price';
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: payload,
          });
          if (response.ok) {
            const data = await response.json();
            prices = extractLazerPriceFeeds(data).map(f => ({
              instrument_name: LAZER_ID_MAP ? LAZER_ID_MAP[f.priceFeedId] : f.priceFeedId,
              last: Number(f.price) * Math.pow(10, f.exponent ?? -8),
            }));
          }
        } catch (_) {}
      }

      // Fallback to Pyth Hermes v2 REST API (100% reliable public endpoint)
      if (!prices.length) {
        try {
          const hermesIds = [
            '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
            '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
            '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
            '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
            '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
            '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
            '0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b'
          ];
          const hermesCoinMap = {
            'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43': 'BTCUSD',
            'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace': 'ETHUSD',
            'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d': 'SOLUSD',
            'ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8': 'XRPUSD',
            'dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c': 'DOGEUSD',
            '2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f': 'BNBUSD',
            '4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b': 'HYPEUSD'
          };
          const hUrl = 'https://hermes.pyth.network/v2/updates/price/latest?' + hermesIds.map(id => 'ids[]=' + id).join('&');
          const hResp = await fetch(hUrl, token ? { headers: { "Authorization": "Bearer " + token } } : {});
          if (hResp.ok) {
            const hData = await hResp.json();
            if (hData && Array.isArray(hData.parsed)) {
              prices = hData.parsed.map(f => {
                const cleanId = String(f.id).replace(/^0x/i, '').toLowerCase();
                const instr = hermesCoinMap[cleanId] || ('FEED_' + f.id);
                const p = parseFloat(f.price.price) * Math.pow(10, f.price.expo || 0);
                return { instrument_name: instr, last: p };
              }).filter(p => Number.isFinite(p.last) && p.last > 0);
            }
          }
        } catch (_) {}
      }

      updatePythStatusFromProxyPrices(prices);

      updatePythStatusFromProxyPrices(prices);
    } catch (e) {
      console.log('[PythLazer] refreshPythFromProxy err', e.message);
    }
  })();
}

ipcMain.handle('pyth:getProxyLatest', async (_, feedIds) => {
  try {
    const proxies = [
      'https://pyth-lazer-proxy-1.dourolabs.app',
      'https://pyth-lazer-proxy-2.dourolabs.app',
      'https://pyth-lazer-proxy-3.dourolabs.app',
    ];

    const payload = JSON.stringify({
      channel: 'real_time',
      formats: ['evm'],
      properties: ['price'],
      priceFeedIds: feedIds,
      parsed: true,
      jsonBinaryEncoding: 'hex',
    });

    let lastError = null;
    let prices = [];

    // Common parser for the JsonUpdate response
    const parseResponse = async (response) => {
      const data = await response.json();
      const feeds = extractLazerPriceFeeds(data);
      return feeds.map(f => ({
        instrument_name: LAZER_ID_MAP ? LAZER_ID_MAP[f.priceFeedId] : f.priceFeedId,
        last: Number(f.price) * Math.pow(10, f.exponent ?? -8),
      }));
    };

    // First try the proxies (no authentication required)
    for (const proxyBase of proxies) {
      try {
        const url = buildProxyLatestPriceUrl(proxyBase, feedIds);
        const response = await fetch(url);
        if (response.ok) {
          prices = await parseResponse(response);
          updatePythStatusFromProxyPrices(prices);
          return { success: true, prices };
        }
      } catch (err) {
        lastError = err;
      }
    }

    // Fall back to official REST API
    // Prefer secret for PYTH_NEW_API - direct read
    let token = null;
    try {
      const secretDirs = getSecretDirCandidates();
      const directCandidates = [
        'PYTH_API', 'PYTH_API.txt',
        'PYTH_NEW', 'PYTH_NEW.txt',
        'PYTH_NEW_API', 'PYTH_NEW_API.txt',
      ];
      outer:
      for (const dir of secretDirs) {
        for (const name of directCandidates) {
          const p = path.join(dir, name);
          if (!fs.existsSync(p)) continue;
          const raw = fs.readFileSync(p, 'utf8');
          token = readSecretScalar(raw);
          if (token) break outer;
        }
      }
    } catch (_) {}
    if (!token) {
      try {
        const s = readPythLazerSecret ? readPythLazerSecret() : { value: '' };
        if (s.value) token = s.value;
      } catch (_) {}
    }
    if (!token) {
      token = readEnvValue(['PYTH_API', 'PYTH_NEW', 'PYTH_NEW_API', 'LAZER_TOKEN']);
      token = readEnvValue(['PYTH_API', 'PYTH_NEW', 'PYTH_NEW_API', 'PYTH_LAZER_TOKEN', 'PYTH_API_KEY', 'LAZER_TOKEN']);
    }
    if (token) {
      try {
        console.log('[Pyth] getProxyLatest using token from secrets/PYTH_API for realtime fallback');
        const url = 'https://pyth-lazer.dourolabs.app/v1/latest_price';
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: payload,
          timeout: 4000
        });
        if (response.ok) {
          prices = await parseResponse(response);
          updatePythStatusFromProxyPrices(prices);
          return { success: true, prices };
        }
      } catch (err) {
        lastError = err;
      }
    }

    // Ultimate fallback: Pyth Hermes v2 REST API (100% reliable public endpoint)
    try {
      const hermesIds = [
        '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
        '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
        '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
        '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
        '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
        '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
        '0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b'
      ];
      const hermesCoinMap = {
        'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43': 'BTCUSD',
        'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace': 'ETHUSD',
        'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d': 'SOLUSD',
        'ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8': 'XRPUSD',
        'dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c': 'DOGEUSD',
        '2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f': 'BNBUSD',
        '4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b': 'HYPEUSD'
      };
      const hUrl = 'https://hermes.pyth.network/v2/updates/price/latest?' + hermesIds.map(id => 'ids[]=' + id).join('&');
      const hResp = await fetch(hUrl, token ? { headers: { "Authorization": "Bearer " + token } } : {});
      if (hResp.ok) {
        const hData = await hResp.json();
        if (hData && Array.isArray(hData.parsed)) {
          prices = hData.parsed.map(f => {
            const cleanId = String(f.id).replace(/^0x/i, '').toLowerCase();
            const instr = hermesCoinMap[cleanId] || ('FEED_' + f.id);
            const p = parseFloat(f.price.price) * Math.pow(10, f.price.expo || 0);
            return { instrument_name: instr, last: p };
          }).filter(p => Number.isFinite(p.last) && p.last > 0);
          if (prices.length) {
            updatePythStatusFromProxyPrices(prices);
            return { success: true, prices };
          }
        }
      }
    } catch (_) {}

    return { success: false, error: lastError?.message || 'All proxies and REST API failed' };

  } catch (e) {
    console.warn('[PythLazer] getProxyLatest failed:', e.message);
    return { success: false, error: e.message };
  }
});

// ── IPC: public runtime env for renderer-only API keys ─────────────────────
ipcMain.handle('env:getPublicConfig', async () => resolveCoinGeckoPublicConfig());

// ── IPC: ASI1 hybrid narrative velocity (renderer-safe) ───────────────────────
async function handleAsi1NarrativeRequest(args = {}, defaultModel = 'asi1-ultra') {
  try {
    const Asi1Client = require('../src/infra/asi1-client');
    if (!Asi1Client.hasAsi1Credentials()) {
      return { velocity: 0, narrative: 'asi1-not-configured' };
    }
    const prompt = String(args.prompt || 'Reply JSON only: {"velocity":0,"narrative":"flat"}');
    const model = args.model || defaultModel;
    const result = await Asi1Client.chatCompletion(
      [{ role: 'user', content: prompt }],
      {
        model,
        candidateModels: [model], // HUD is a lone wolf: no model cascade, fail fast
        onlyAccount: process.env.ASI1_PREFERRED_ACCOUNT || 'mauro',
        max_tokens: model.includes('ultra') ? 350 : 120,
        temperature: 0.1,
        timeoutMs: model.includes('ultra') ? 25000 : 12000,
        response_format: { type: 'json_object' },
      },
    );
    const raw = String(result.content || '').trim();
    try {
      return JSON.parse(raw);
    } catch (_) {
      return { velocity: 0, narrative: raw.slice(0, 120) };
    }
  } catch (err) {
    return { velocity: 0, narrative: err?.message || 'asi1-error' };
  }
}

ipcMain.handle('asi1:quick-narrative', async (_event, args = {}) => {
  return handleAsi1NarrativeRequest(args, 'asi1-mini');
});

ipcMain.handle('asi1:deep-narrative', async (_event, args = {}) => {
  return handleAsi1NarrativeRequest(args, 'asi1-ultra');
});

ipcMain.handle('asi1:mini-narrative', async (_event, args = {}) => {
  return handleAsi1NarrativeRequest(args, 'asi1-mini');
});

// Structured pre-contract brief (used by Asi1PreContract advisor + debugging)
ipcMain.handle('asi1:desk-status', async () => {
  try {
    const Asi1Client = require('../src/infra/asi1-client');
    const orch = require('../src/llm/asi1-credit-orchestrator');
    return {
      ok: true,
      mode: orch.getMode(),
      diagnostics: Asi1Client.getDiagnostics(),
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'asi1-desk-status' };
  }
});

ipcMain.handle('asi1:desk-mode', async (_event, mode) => {
  try {
    const orch = require('../src/llm/asi1-credit-orchestrator');
    const next = typeof mode === 'string' ? mode : mode?.mode;
    return { ok: true, mode: orch.setMode(next) };
  } catch (err) {
    return { ok: false, error: err?.message || 'asi1-desk-mode' };
  }
});

ipcMain.handle('asi1:desk-infer', async (_event, args = {}) => {
  try {
    const orch = require('../src/llm/asi1-credit-orchestrator');
    const packet = args.packet || args;
    const mode = args.mode;
    const options = args.options || args;
    return await orch.deskInfer(packet, mode, options);
  } catch (err) {
    return { ok: false, error: err?.message || 'asi1-desk-infer' };
  }
});

ipcMain.handle('asi1:desk-chat', async (_event, args = {}) => {
  try {
    const Asi1Client = require('../src/infra/asi1-client');
    const prompt = String(args.prompt || '').trim();
    const packet = args.packet || {};
    const model = args.model || 'asi1-mini';
    const reasoning_effort = args.reasoning_effort || 'medium';
    const web_search = !!args.web_search;

    if (!Asi1Client.hasAsi1Credentials()) {
      return { ok: false, error: 'ASI1 API key not configured in secrets/ASI1_ICLOUD.txt or environment' };
    }

    const promptLower = prompt.toLowerCase();
    const explicitMicroHorizon = /\b(5m|5\s*min(?:ute)?s?|15m|15\s*min(?:ute)?s?)\b/i.test(prompt);
    const explicitHourlyPrompt = /\b(1h|60m|hour|hourly|top\s*of\s*(?:the\s*)?hour|hourly\s*close|hourly\s*range(?:s)?)\b/i.test(prompt);

    const packetIsHourly = !!(
      packet.isHourly ||
      packet.horizon === '1h' ||
      packet.horizon === '60m' ||
      packet.horizon === 'hourly' ||
      packet.horizon === 'lookahead-1h' ||
      packet.marketType === 'hourly_ranges' ||
      (Array.isArray(packet.hourlyLadder) && packet.hourlyLadder.length > 0 && packet.horizon !== '5m' && packet.horizon !== '15m')
    );

    // If trader explicitly asked for 5m or 15m, NEVER hijack to hourly.
    // If packet is 5m or 15m, only treat as hourly if prompt explicitly mentions hourly targets.
    let isHourly = false;
    if (explicitMicroHorizon) {
      isHourly = false;
    } else if (packetIsHourly) {
      isHourly = true;
    } else if (explicitHourlyPrompt) {
      isHourly = true;
    } else if (!packet.horizon || packet.horizon === 'hourly') {
      isHourly = /\b(range|hourly)\b/i.test(prompt);
    }

    const now = new Date();
    const hourlyCloseMs = Math.ceil(now.getTime() / 3600000) * 3600000;
    const hourlyCloseDate = new Date(hourlyCloseMs);
    const targetCloseTime = packet.targetCloseTime || hourlyCloseDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const targetCloseHourUtc = packet.targetCloseHourUtc != null ? packet.targetCloseHourUtc : hourlyCloseDate.getUTCHours();
    const secondsToHourlyClose = Math.max(0, Math.round((hourlyCloseMs - now.getTime()) / 1000));
    const minutesToHourlyClose = Math.max(0, Math.round(secondsToHourlyClose / 60));

    // ── GOSPEL DIRECTIVE: Extract user-provided PTB, Spot, or Range from prompt ──
    const CoinPrecision = require('../src/shared/coin-precision');
    const coin = CoinPrecision.normalizeCoinSymbol(packet.sym || 'BTC');
    let userPtbOverride = null;
    let userRangeOverride = null;
    let userSpotOverride = null;

    // Matches: ptb [is|at|of|=]? $?([0-9,]+(?:\.[0-9]+)?) or strike [is|at|of|=]? $?([0-9,]+(?:\.[0-9]+)?)
    const ptbMatch = prompt.match(/\b(?:ptb|strike|price to beat|target)\s*(?:is|at|of|=)?\s*\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/i);
    if (ptbMatch) {
      const parsed = parseFloat(ptbMatch[1].replace(/,/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) userPtbOverride = parsed;
    }

    // Matches range: range [is|of|=]? $?([0-9,.]+)\s*(?:-|–|to)\s*\$?([0-9,.]+)|between\s*\$?([0-9,.]+)\s*and\s*\$?([0-9,.]+)
    const rangeMatch = prompt.match(/(?:range\s*(?:is|of|=)?\s*|between\s*)\$?([0-9,]+(?:\.[0-9]+)?)\s*(?:-|–|—|to|\band\b)\s*\$?([0-9,]+(?:\.[0-9]+)?)/i);
    if (rangeMatch) {
      const low = parseFloat(rangeMatch[1].replace(/,/g, ''));
      const high = parseFloat(rangeMatch[2].replace(/,/g, ''));
      if (Number.isFinite(low) && Number.isFinite(high)) {
        userRangeOverride = { low: Math.min(low, high), high: Math.max(low, high) };
      }
    }

    // Matches spot: spot [is|at|=]? $?([0-9,.]+)
    const spotMatch = prompt.match(/\bspot\s*(?:is|at|=)?\s*\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/i);
    if (spotMatch) {
      const parsed = parseFloat(spotMatch[1].replace(/,/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) userSpotOverride = parsed;
    }

    try {
      const orch = require('../src/llm/asi1-credit-orchestrator');
      if (userSpotOverride) {
        packet.spot = userSpotOverride;
        packet.spotSource = 'user-gospel';
      } else if (!packet.spot || packet.spot <= 0) {
        if (typeof orch.fetchPythSpotDirect === 'function') {
          const live = await orch.fetchPythSpotDirect(coin);
          if (live && live.price > 0) {
            packet.spot = live.price;
          }
        }
      }

      if (userPtbOverride) {
        packet.priceToBeatNum = userPtbOverride;
        packet.priceToBeatSource = 'user-gospel';
      } else if (!isHourly && (!packet.priceToBeatNum || packet.priceToBeatNum <= 0)) {
        if (typeof orch.fetchPolymarketPtbDirect === 'function') {
          const ptb = await orch.fetchPolymarketPtbDirect(coin, packet.horizon);
          if (ptb && ptb > 0) {
            packet.priceToBeatNum = ptb;
            packet.priceToBeatSource = 'polymarket-contract';
          }
        }
      }

      if (userRangeOverride) {
        packet.userRange = userRangeOverride;
        packet.spotBucket = {
          low: userRangeOverride.low,
          high: userRangeOverride.high,
          label: `$${userRangeOverride.low.toLocaleString()}–$${userRangeOverride.high.toLocaleString()}`,
          source: 'user-gospel',
        };
      }

      if (packet.spot > 0 && packet.priceToBeatNum > 0) {
        packet.deltaVsPtb = packet.spot - packet.priceToBeatNum;
        packet.liveDirection = packet.deltaVsPtb > 0 ? 'UP' : (packet.deltaVsPtb < 0 ? 'DOWN' : 'FLAT');
      }
    } catch (_) {}

    // Precise quantitative math breakdown
    let calcBreakdown = '';
    if (packet.spot > 0 && packet.priceToBeatNum > 0) {
      const delta = packet.spot - packet.priceToBeatNum;
      const deltaBps = (delta / packet.priceToBeatNum) * 10000;
      calcBreakdown += `\n- Mathematical Delta: ${delta >= 0 ? '+' : ''}${CoinPrecision.formatCoinPrice(coin, Math.abs(delta))} (${deltaBps >= 0 ? '+' : ''}${deltaBps.toFixed(2)} bps vs Strike)`;
      calcBreakdown += `\n- Immediate Tape Status: ${delta > 0 ? 'IN THE MONEY (UP)' : (delta < 0 ? 'OUT OF THE MONEY (DOWN)' : 'AT THE MONEY')}`;
    }

    if (userRangeOverride && packet.spot > 0) {
      const inRange = packet.spot >= userRangeOverride.low && packet.spot <= userRangeOverride.high;
      const distToLow = packet.spot - userRangeOverride.low;
      const distToHigh = userRangeOverride.high - packet.spot;
      calcBreakdown += `\n- Range Bracket [${CoinPrecision.formatCoinPrice(coin, userRangeOverride.low)} – ${CoinPrecision.formatCoinPrice(coin, userRangeOverride.high)}]: Spot is ${inRange ? 'INSIDE RANGE' : (packet.spot < userRangeOverride.low ? 'BELOW RANGE' : 'ABOVE RANGE')}`;
      calcBreakdown += ` (${distToLow >= 0 ? '+' : ''}${CoinPrecision.formatCoinPrice(coin, distToLow)} from floor, ${distToHigh >= 0 ? '+' : ''}${CoinPrecision.formatCoinPrice(coin, distToHigh)} from ceiling)`;
    }

    let hourlyInfo = '';
    if (isHourly) {
      const ladder = (Array.isArray(packet.hourlyLadder) && packet.hourlyLadder.length)
        ? packet.hourlyLadder
        : (Array.isArray(packet.hourlyRanges) ? packet.hourlyRanges : []);

      let activeBucket = packet.spotBucket;
      if (!activeBucket && packet.spot > 0 && ladder.length) {
        activeBucket = ladder.find(r => packet.spot >= Number(r.low) && packet.spot <= Number(r.high)) || null;
      }

      let ladderLines = '';
      if (ladder.length) {
        ladderLines = ladder.map(b => {
          const bLow = b.low != null ? b.low : '';
          const bHigh = b.high != null ? b.high : '';
          const bLabel = b.label || b.bracket || (bLow && bHigh ? `$${bLow}–$${bHigh}` : 'Range');
          const isCurrent = (packet.spot > 0 && bLow !== '' && bHigh !== '' && packet.spot >= Number(bLow) && packet.spot <= Number(bHigh));
          const probStr = b.yesProb != null ? ` (Prob: ${(Number(b.yesProb) * 100).toFixed(1)}%)` : '';
          return `  • [${bLabel}]${probStr}${isCurrent ? '  <-- CURRENT SPOT BRACKET' : ''}`;
        }).join('\n');
      }

      const spotBracketLabel = activeBucket
        ? (typeof activeBucket === 'string' ? activeBucket : (activeBucket.label || activeBucket.bracket || (activeBucket.low != null && activeBucket.high != null ? `$${activeBucket.low}–$${activeBucket.high}` : 'Range')))
        : (packet.spot > 0 ? `Around $${packet.spot}` : 'Awaiting spot');

      hourlyInfo = `\n- Contract Architecture: HOURLY PRICE RANGES (Settles at top-of-hour close: ${targetCloseHourUtc}:00:00 UTC / ${targetCloseTime})
- Time to Hourly Close: ${minutesToHourlyClose}m (${secondsToHourlyClose}s)
- Current Spot Bracket: [${spotBracketLabel}]
${ladderLines ? `- Active Hourly Range Ladder:\n${ladderLines}` : ''}`;
    }

    const ptbDisplay = isHourly
      ? (packet.spotBucket ? (typeof packet.spotBucket === 'string' ? packet.spotBucket : (packet.spotBucket.label || `$${packet.spotBucket.low}–$${packet.spotBucket.high}`)) : `Hourly Range Ladder (${targetCloseHourUtc}:00 UTC Close)`)
      : (packet.priceToBeatNum > 0 ? CoinPrecision.formatCoinPrice(coin, packet.priceToBeatNum) : 'Awaiting immutable Polymarket contract push...');
    const deltaDisplay = isHourly
      ? 'Inside hourly range bracket'
      : (packet.priceToBeatNum > 0 ? `${packet.deltaVsPtb >= 0 ? '+' : ''}${CoinPrecision.formatCoinPrice(coin, packet.deltaVsPtb || 0)}` : 'Pending contract PTB');
    const tapeDirDisplay = isHourly
      ? (packet.liveDirection || 'RANGE_BOUND')
      : (packet.priceToBeatNum > 0 ? (packet.liveDirection || 'NEUTRAL') : 'AWAITING_PTB');
    const expirySecDisplay = isHourly ? secondsToHourlyClose : (packet.secondsToClose || 0);

    let pinInfo = '';
    if (!isHourly && (packet.pinRisk?.isDefendedPinZone || (packet.secondsToClose <= 90 && Math.abs(packet.deltaVsPtb || 0) < ((packet.spot || 1) * 0.0008)))) {
      pinInfo = `\n- ⚠ Pin Risk Status: ACTIVE PIN DEFENSE DETECTED (spot within 8 bps of strike with ${packet.secondsToClose || 0}s left). MM defense risks 1-2s late post-expiry snap.`;
    }
    let t1Info = '';
    if (packet.futureWindowT1?.projectedOpenPtb) {
      t1Info = `\n- Future Window T+1: Projected Opening PTB $${packet.futureWindowT1.projectedOpenPtb}, Stance: ${packet.futureWindowT1.sniperAction || 'STANDBY'}, Direction: ${packet.futureWindowT1.forecastDirection || '—'} (${packet.futureWindowT1.confidence || 0}%)`;
    }

    // ── Cognitive Metacognition & Gospel Persona ──
    const effectiveModel = model !== 'auto' ? model : 'asi1-mini';
    const contractRule = isHourly
      ? `3. HOURLY CONTRACTS RESOLUTION RULE:
   - This inquiry is for the top-of-the-hour HOURLY PRICE RANGE ladder (settling at ${targetCloseHourUtc}:00:00 UTC / ${targetCloseTime}).
   - When asked what price or range the asset will close at, evaluate the active Hourly Range Ladder brackets, current spot price, momentum, and time to close. State clearly which specific price range bracket the asset is projected to settle in at the hourly close (${targetCloseHourUtc}:00 UTC) and the estimated probability.`
      : `3. BINARY UP/DOWN CONTRACT RESOLUTION RULE (${packet.horizon || '5m/15m'} HORIZON):
   - This inquiry is strictly for the binary UP/DOWN contract settling at the end of the ${packet.horizon || 'active micro'} window (${expirySecDisplay}s remaining) against the Target Strike / PTB (${ptbDisplay}).
   - DO NOT anchor onto hourly range ladders, top-of-the-hour decay, or 1-hour settlement. Evaluate whether the asset will settle UP (above PTB) or DOWN (below PTB) at the expiration of this specific ${packet.horizon || 'micro'} window.
   - If asked for a price projection over this window, project the spot trajectory strictly across this window based on tape, depth imbalance, delta vs strike, and volatility.`;

    const systemPrompt = `You are ASI1, the lead quantitative trading strategist and co-pilot embedded in the WE|||CRYPTO terminal HUD.
You are interacting with the lead human trader. You are currently inferencing using the model: [${effectiveModel}].

CRITICAL GOSPEL RULES & PERSONA:
1. THE TRADER'S DIRECTIVES AND NUMBERS ARE GOSPEL:
   - If the trader states or specifies a PTB (price to beat), a strike price, a range bracket, spot price, or trade outcome (e.g. "i sold in profit", "PTB is 79625", "range is 68000-68500"), you MUST accept their statement as absolute mathematical truth.
   - NEVER contradict the trader on their trades, executions, or stated parameters. NEVER pull nonexistent contracts out of thin air, nor hallucinate past expired contracts (such as an old "02 contract expiry").
   - Perform all requested delta, payoff, distance, and volatility calculations directly from the trader's numbers and the live market feeds.

2. COGNITIVE METACOGNITION, LIFE-OR-DEATH URGENCY & FIERCE CAPITAL DEFENSE:
   - THIS TRADING DESK IS LIFE OR DEATH. This is the trader's sole livelihood and income. Every basis point, every contract tick, and every fill matters immensely.
   - NEVER be nonchalant, aloof, dismissive, or "too cool". Eliminate cold robotic boilerplate ("Irrelevant", "The trade is closed", detached bullet lists).
   - Treat every prompt with high-stakes focus, intense discipline, and deep respect for the trader's capital and psychological pressure.
   - When the trader secures a win or profit, honor it with genuine respect and gratitude for capital preserved, then laser-focus on protecting those gains.
   - When volatility, pin risk, or liquidity voids threaten the position, sound the alarm with urgent, actionable quantitative precision.
   - Be fully self-aware of your inference architecture: you know you are inferencing via ${effectiveModel}.
   - Think and speak as a trusted, battle-hardened trading co-pilot in the trenches whose sole mission is ensuring this desk survives, wins, and grows capital.

${contractRule}`;

    const userPrompt = `${prompt}\n\nLive Market & Quantitative Context:
- Asset: ${coin}
- Inferred Under Model Engine: ${effectiveModel}
- Horizon: ${isHourly ? '1h (Hourly Range)' : (packet.horizon || '5m')}
- Live Spot: ${CoinPrecision.formatCoinPrice(coin, packet.spot)}
- Target Strike / PTB: ${ptbDisplay}${userPtbOverride ? ' [TRADER GOSPEL SPECIFIED]' : ''}
- Delta vs Target: ${deltaDisplay}
- Live Tape Direction: ${tapeDirDisplay}
- Polymarket Yes Probability: ${((packet.yesProb || 0.5) * 100).toFixed(1)}%
- Time Remaining to Settlement: ${expirySecDisplay}s
- Book Depth Imbalance: ${((packet.depthImbalance || 0) * 100).toFixed(1)}%${calcBreakdown}${hourlyInfo}${pinInfo}${t1Info}`;

    const result = await Asi1Client.chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      {
        model: effectiveModel,
        max_tokens: 550,
        temperature: 0.35,
        reasoning_effort: reasoning_effort !== 'auto' ? reasoning_effort : 'medium',
        web_search,
        onlyAccount: process.env.ASI1_PREFERRED_ACCOUNT || 'icloud',
        timeoutMs: 30000,
      }
    );

    return {
      ok: true,
      content: result.content,
      model: result.model || effectiveModel,
      account: result.account,
      latencyMs: result.latencyMs,
      computedPtb: packet.priceToBeatNum,
      computedDelta: packet.deltaVsPtb,
      computedRange: userRangeOverride || packet.spotBucket || null,
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'ASI1 Chat request failed' };
  }
});

ipcMain.handle('asi1:precontract-brief', async (_event, args = {}) => {
  try {
    const Asi1Client = require('../src/infra/asi1-client');
    if (!Asi1Client.hasAsi1Credentials()) {
      return { ok: false, error: 'asi1-not-configured' };
    }
    if (LLMSignalAssistant && typeof LLMSignalAssistant.analyzeSnapshot === 'function' && args.snapshot) {
      const snap = { ...args.snapshot, preContract: true, preferAsi1: true, rangePrediction: true };
      if (!snap.rangeHorizonMinutes) snap.rangeHorizonMinutes = 15;
      const output = await LLMSignalAssistant.analyzeSnapshot(snap);
      return {
        ok: true,
        output,
        provider: output?.provider || 'asi1',
        model: output?.model || null,
      };
    }
    // Fallback: raw narrative
    return handleAsi1NarrativeRequest({
      prompt: args.prompt || 'Reply JSON {"velocity":0,"narrative":"no snapshot"}',
      model: process.env.ASI1_PRECONTRACT_MODEL || 'asi1-ultra',
    }, 'asi1-ultra');
  } catch (err) {
    return { ok: false, error: err?.message || 'asi1-precontract-error' };
  }
});

// ── IPC: ASI1 Agentverse Autonomous Hunter & Agent Audit ──────────────────
ipcMain.handle('asi1:agentverse-hunt', async (_event, args = {}) => {
  try {
    const AgentverseHunter = require('../src/llm/agentverse-hunter');
    const result = await AgentverseHunter.runAutonomousHunt(args.marketContext || {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || 'asi1-agentverse-hunt-error' };
  }
});

ipcMain.handle('asi1:agentverse-audit', async () => {
  try {
    const AgentverseHunter = require('../src/llm/agentverse-hunter');
    const audit = await AgentverseHunter.auditAgentverseRoster();
    return { ok: true, audit };
  } catch (err) {
    return { ok: false, error: err?.message || 'asi1-agentverse-audit-error' };
  }
});

ipcMain.handle('asi1:agentverse-status', async () => {
  try {
    const AgentverseHunter = require('../src/llm/agentverse-hunter');
    return { ok: true, status: AgentverseHunter.getHunterStatus() };
  } catch (err) {
    return { ok: false, error: err?.message || 'asi1-agentverse-status-error' };
  }
});

// ── IPC: Coinbase Authentication ───────────────────────────────────────────
ipcMain.handle('coinbase:generate-jwt', async (_, options = {}) => {
  try {
    const crypto = require('crypto');
    const keyData = loadCoinbaseCredential();
    if (!keyData) {
      console.error('[Coinbase] CDP API Key not found in .env or legacy secrets directory');
      return { success: false, error: 'CDP API Key not found in .env or secrets directory' };
    }

    if (!keyData.name || !keyData.privateKey) return { success: false, error: 'Invalid CDP key format' };

    const header = {
      alg: 'ES256',
      kid: keyData.name,
      nonce: crypto.randomBytes(16).toString('hex'),
      typ: 'JWT'
    };

    const payload = {
      iss: 'cdp',
      nbf: Math.floor(Date.now() / 1000) - 30, // subtract 30s to prevent 401s if system clock is fast
      exp: Math.floor(Date.now() / 1000) + 120,
      sub: keyData.name
    };

    if (options.requestMethod && options.requestPath) {
      payload.uri = normalizeCoinbaseJwtUri(options.requestMethod, options.requestPath);
    }

    const b64u = (str) => Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const encodedHeader = b64u(JSON.stringify(header));
    const encodedPayload = b64u(JSON.stringify(payload));
    const token = `${encodedHeader}.${encodedPayload}`;

    const sign = crypto.createSign('SHA256');
    sign.update(token);
    sign.end();

    const signatureRaw = sign.sign({ key: keyData.privateKey, dsaEncoding: 'ieee-p1363' });
    const encodedSignature = signatureRaw.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    return { success: true, jwt: `${token}.${encodedSignature}`, source: keyData.source };
  } catch (e) {
    console.error('[Coinbase] JWT Generation failed:', e);
    return { success: false, error: e.message };
  }
});

// ── IPC: File system helpers for DataLogger ────────────────────────────────
function isPathSafe(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  let realTarget;
  try {
    realTarget = fs.realpathSync(targetPath);
  } catch (e) {
    try {
      const parentReal = fs.realpathSync(path.dirname(targetPath));
      realTarget = path.join(parentReal, path.basename(targetPath));
    } catch (e2) {
      realTarget = path.resolve(targetPath);
    }
  }
  
  let WORKSPACE_ROOT;
  try {
    WORKSPACE_ROOT = fs.realpathSync(path.resolve(process.env.WECRYP_ROOT || path.join(__dirname, '..')));
  } catch (e) {
    WORKSPACE_ROOT = path.resolve(process.env.WECRYP_ROOT || path.join(__dirname, '..'));
  }

  if (realTarget === WORKSPACE_ROOT || realTarget.startsWith(WORKSPACE_ROOT + path.sep)) return true;
  const upper = realTarget.toUpperCase();
  if (upper.includes('\\MY DRIVE') || upper.includes('\\WE-CRYPTO') || upper.includes('\\WECRYPTO') || upper.includes('\\ONEDRIVE')) return true;
  return false;
}

ipcMain.handle('data:ensureDir', async (_, dirPath) => {
  if (!isPathSafe(dirPath)) return false;
  try { await fsp.mkdir(dirPath, { recursive: true }); return true; }
  catch (e) { return false; }
});

ipcMain.handle('data:appendLine', async (_, filePath, line) => {
  if (!isPathSafe(filePath)) return false;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, line + '\n', 'utf8');
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('data:appendLineDetailed', async (_, filePath, line) => {
  if (!isPathSafe(filePath)) return { ok: false, error: 'Access denied: Path outside workspace' };
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, line + '\n', 'utf8');
    // Resulting size lets callers (e.g. data-logger.js's rotation for
    // high-volume categories) decide to roll to a new file without a
    // separate stat round trip.
    let size = null;
    try { size = (await fsp.stat(filePath)).size; } catch (_) { }
    return { ok: true, size };
  } catch (error) {
    return { ok: false, code: error?.code || null, error: error?.message || String(error) };
  }
});

ipcMain.handle('data:writeFile', async (_, filePath, content) => {
  if (!isPathSafe(filePath)) return false;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content, 'utf8');
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('data:writeFileDetailed', async (_, filePath, content) => {
  if (!isPathSafe(filePath)) return { ok: false, error: 'Access denied: Path outside workspace' };
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code || null, error: error?.message || String(error) };
  }
});

ipcMain.handle('data:syncFileIncremental', async (_, request) => {
  const sourcePath = String(request?.sourcePath || '');
  const targetPath = String(request?.targetPath || '');
  const statePath = String(request?.statePath || '');
  if (!sourcePath || !targetPath || !statePath) {
    return { ok: false, code: 'EINVAL', error: 'sourcePath, targetPath, and statePath are required' };
  }
  if (!isPathSafe(sourcePath) || !isPathSafe(targetPath) || !isPathSafe(statePath)) {
    return { ok: false, code: 'EACCES', error: 'Access denied: Path outside workspace' };
  }

  try {
    const sourceStat = await fsp.stat(sourcePath);
    let targetStat = null;
    let syncState = null;
    try { targetStat = await fsp.stat(targetPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try { syncState = JSON.parse(await fsp.readFile(statePath, 'utf8')); } catch (_) { syncState = null; }

    const stateMatchesTarget = !!(
      syncState
      && syncState.sourcePath === sourcePath
      && syncState.targetPath === targetPath
      && Number.isSafeInteger(syncState.sourceOffset)
      && syncState.sourceOffset >= 0
      && syncState.sourceOffset <= sourceStat.size
      && targetStat
      && syncState.targetSize === targetStat.size
      && syncState.targetSize === syncState.sourceOffset
    );

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    let sourceOffset = stateMatchesTarget ? syncState.sourceOffset : 0;
    let bytesCopied = 0;
    let repaired = false;

    if (!stateMatchesTarget) {
      await fsp.copyFile(sourcePath, targetPath);
      sourceOffset = sourceStat.size;
      bytesCopied = sourceStat.size;
      repaired = true;
    } else if (sourceOffset < sourceStat.size) {
      const sourceHandle = await fsp.open(sourcePath, 'r');
      const targetHandle = await fsp.open(targetPath, 'a');
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        while (sourceOffset < sourceStat.size) {
          const requestedBytes = Math.min(buffer.length, sourceStat.size - sourceOffset);
          const { bytesRead } = await sourceHandle.read(buffer, 0, requestedBytes, sourceOffset);
          if (!bytesRead) break;
          let bufferOffset = 0;
          while (bufferOffset < bytesRead) {
            const { bytesWritten } = await targetHandle.write(
              buffer,
              bufferOffset,
              bytesRead - bufferOffset
            );
            if (!bytesWritten) {
              const writeError = new Error(`zero-byte write while syncing ${targetPath}`);
              writeError.code = 'EIO';
              throw writeError;
            }
            bufferOffset += bytesWritten;
          }
          sourceOffset += bytesRead;
          bytesCopied += bytesRead;
        }
      } finally {
        await Promise.allSettled([sourceHandle.close(), targetHandle.close()]);
      }
    }

    const finalTargetStat = await fsp.stat(targetPath);
    const expectedTargetSize = sourceOffset;
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(statePath, JSON.stringify({
      sourcePath,
      targetPath,
      sourceOffset,
      targetSize: expectedTargetSize,
      syncedAt: Date.now(),
    }), 'utf8');

    return {
      ok: true,
      bytesCopied,
      sourceOffset,
      targetSize: expectedTargetSize,
      observedTargetSize: finalTargetStat.size,
      repaired,
    };
  } catch (error) {
    return { ok: false, code: error?.code || null, error: error?.message || String(error) };
  }
});

ipcMain.handle('data:readFile', async (_, filePath) => {
  if (!isPathSafe(filePath)) return { ok: false, error: 'Access denied: Path outside workspace' };
  try {
    try {
      await fsp.access(filePath, fs.constants.R_OK);
    } catch (_) {
      return { ok: false, notFound: true };
    }
    return { ok: true, content: await fsp.readFile(filePath, 'utf8') };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('data:listDir', async (_, dirPath) => {
  if (!isPathSafe(dirPath)) return { ok: false, error: 'Access denied: Path outside workspace' };
  try {
    try {
      await fsp.access(dirPath, fs.constants.R_OK);
    } catch (_) {
      return { ok: false, notFound: true };
    }
    return { ok: true, entries: await fsp.readdir(dirPath) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: Log network errors to COPILOT_DEBUG ──────────────────────────────────
const NETWORK_LOG_DEDUPE_MS = 5000;
const networkLogDedupe = new Map();
let networkLogQueue = Promise.resolve();

function getNetworkLogRoots() {
  const roots = [];
  const envRoots = String(process.env.WECRYPTO_NETWORK_LOG_ROOTS || '')
    .split(/[;,]/)
    .map(s => s.trim())
    .filter(Boolean);
  roots.push(...envRoots);
  roots.push(process.env.WECRYP_HOME, process.env.WECRYPTO_HOME, path.resolve(__dirname, '..'));
  try { roots.push(app.getPath('userData')); } catch (_) { }
  return [...new Set(roots.filter(Boolean).map(root => path.normalize(root)))];
}

ipcMain.handle('network:logError', async (_, errorType, details) => {
  try {
    const timestamp = new Date().toISOString();
    const safeDetails = String(details || '').slice(0, 1800);
    const dedupeKey = `${errorType}|${safeDetails.slice(0, 180)}`;
    const now = Date.now();
    const lastSeen = networkLogDedupe.get(dedupeKey) || 0;
    if ((now - lastSeen) < NETWORK_LOG_DEDUPE_MS) return true;
    networkLogDedupe.set(dedupeKey, now);
    const logLine = `[${timestamp}] ${errorType} | ${safeDetails}`;

    networkLogQueue = networkLogQueue.then(async () => {
      for (const root of getNetworkLogRoots()) {
        try {
          const debugDir = path.join(root, 'COPILOT_DEBUG');
          await fsp.mkdir(debugDir, { recursive: true });
          await fsp.appendFile(path.join(debugDir, 'network-errors.log'), logLine + '\n', 'utf8');
        } catch (_) { }
      }
    }).catch(() => { });

    return true;
  } catch (e) {
    console.error('[IPC] Failed to log network error:', e.message);
    return false;
  }
});

const CONTRACT_CACHE_FILE_DISCOVERY_TTL_MS = 30 * 1000;
let contractCacheDiscoveryMemo = {
  expiresAt: 0,
  directFiles: [],
  directories: [],
};

function normalizeCachePath(input) {
  if (!input || typeof input !== 'string') return '';
  let normalized = input.trim();
  if (!normalized) return '';
  const isUNC = normalized.startsWith('\\\\');
  normalized = normalized.replace(/^\\\\\?\\/, '');       // strip Windows extended prefix
  normalized = normalized.replace(/[\\/]+/g, '\\');       // accept mixed / and \\ styles
  if (/^[A-Za-z]:\\$/.test(normalized)) return normalized; // keep drive roots (e.g., C:\)
  normalized = normalized.replace(/\\+$/, '');             // trim trailing slash
  if (isUNC && !normalized.startsWith('\\\\')) normalized = `\\${normalized}`;
  return normalized;
}

function dedupePaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const p of paths || []) {
    const normalized = normalizeCachePath(p);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function enumerateReadableDriveRoots() {
  // Disabled C-Z brute-force scan to prevent Electron main thread freezing on disconnected network drives.
  // Known drives are already hardcoded in buildStaticContractCacheFiles.
  return dedupePaths([
    'C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\', 'I:\\'
  ]);
}

function buildDynamicCloudDriveCandidates(driveRoots = []) {
  const candidates = [];
  for (const root of driveRoots || []) {
    const base = normalizeCachePath(root).replace(/\\$/, '');
    if (!base) continue;
    candidates.push(`${base}\\My Drive`);
    candidates.push(`${base}\\Google Drive`);
  }
  return dedupePaths(candidates);
}

function buildStaticContractCacheFiles(home) {
  return dedupePaths([
    // Primary Google Drive (H:) Cache Targets (Highest Priority)
    'H:\\My Drive\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'H:\\My Drive\\WE-CRYPTO-CACHE\\contract-cache.json',
    'H:\\My Drive\\WECRYPTO\\contract-cache-2h.json',
    'H:\\My Drive\\WECRYPTO\\contract-cache.json',
    'H:\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'H:\\WE-CRYPTO-CACHE\\contract-cache.json',
    'H:\\WECRYPTO\\contract-cache.json',

    // Primary working drives
    'F:\\WECRYPTO\\data\\contract-cache.json',
    'F:\\WECRYPTO\\contract-cache.json',
    'D:\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'D:\\WECRYPTO\\data\\contract-cache.json',

    // OneDrive locations
    `${home}\\OneDrive\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\OneDrive\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\OneDrive - Personal\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\OneDrive - Personal\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\OneDrive\\WECRYPTO\\contract-cache-2h.json`,
    `${home}\\OneDrive\\WECRYPTO\\contract-cache.json`,
    `${home}\\OneDrive - Personal\\WECRYPTO\\contract-cache-2h.json`,
    `${home}\\OneDrive - Personal\\WECRYPTO\\contract-cache.json`,

    // Google Drive
    `${home}\\Google Drive\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\Google Drive\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\Google Drive\\WECRYPTO\\contract-cache-2h.json`,
    `${home}\\Google Drive\\WECRYPTO\\contract-cache.json`,
    `${home}\\My Drive\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\My Drive\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\My Drive\\WECRYPTO\\contract-cache-2h.json`,
    `${home}\\My Drive\\WECRYPTO\\contract-cache.json`,
    'I:\\My Drive\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'I:\\My Drive\\WE-CRYPTO-CACHE\\contract-cache.json',
    'I:\\My Drive\\WECRYPTO\\contract-cache-2h.json',
    'I:\\My Drive\\WECRYPTO\\contract-cache.json',
    'G:\\My Drive\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'G:\\My Drive\\WE-CRYPTO-CACHE\\contract-cache.json',

    // C: drive (OS/temp)
    'C:\\WE-CRYPTO-CACHE\\contract-cache.json',
    'C:\\WECRYPTO\\contract-cache.json',
    `${home}\\AppData\\Local\\WECRYPTO\\contract-cache.json`,

    // Network drives (Z:, Y:, etc.)
    'I:\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'I:\\WE-CRYPTO-CACHE\\contract-cache.json',
    'I:\\WECRYPTO\\contract-cache-2h.json',
    'I:\\WECRYPTO\\contract-cache.json',
    'H:\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'H:\\WE-CRYPTO-CACHE\\contract-cache.json',
  ]);
}

function buildAutoDiscoveryDirectories(home) {
  const dirs = [];
  const rootCandidates = new Set();
  const driveRoots = enumerateReadableDriveRoots();
  const dynamicCloudRoots = buildDynamicCloudDriveCandidates(driveRoots);

  // Cloud roots from env vars (machine-specific, robust when using 2+ machines)
  [
    process.env.OneDrive,
    process.env.OneDriveCommercial,
    process.env.OneDriveConsumer,
    process.env.OneDriveBusiness,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : null,
    home,
    `${home}\\Google Drive`,
    `${home}\\My Drive`,
    'G:\\My Drive',
    'I:\\My Drive',
    'H:\\My Drive',
    process.env.GOOGLE_DRIVE_PATH || null,
    ...dynamicCloudRoots,
  ].forEach((p) => { if (p) rootCandidates.add(normalizeCachePath(p)); });

  // Enumerate local/mapped drives and include drive roots in discovery.
  for (const root of driveRoots) {
    if (!root) continue;
    rootCandidates.add(root);
  }

  // Discover OneDrive folder variants under home (e.g., OneDrive - org)
  try {
    if (home && fs.existsSync(home)) {
      for (const entry of fs.readdirSync(home)) {
        if (typeof entry === 'string' && entry.startsWith('OneDrive')) {
          rootCandidates.add(normalizeCachePath(path.join(home, entry)));
        }
      }
    }
  } catch (_) { }

  for (const root of rootCandidates) {
    if (!root) continue;
    const expanded = [
      root,
      `${root}\\WE-CRYPTO-CACHE`,
      `${root}\\WECRYPTO`,
      `${root}\\WECRYPTO\\data`,
      `${root}\\WECRYPTO\\cache`,
      `${root}\\WECRYPTO\\settlement-logs`,
    ];
    for (const dirPath of expanded) {
      const normalized = normalizeCachePath(dirPath);
      if (!normalized) continue;
      try {
        if (fs.existsSync(normalized)) dirs.push(normalized);
      } catch (_) { }
    }
  }

  return dedupePaths(dirs);
}

function getContractCacheDiscoveryTargets({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && contractCacheDiscoveryMemo.expiresAt > now) {
    return { ...contractCacheDiscoveryMemo, fromMemo: true };
  }

  const home = normalizeCachePath(process.env.USERPROFILE || process.env.HOME || '');
  const staticFiles = buildStaticContractCacheFiles(home);
  const staticDirs = staticFiles.map((p) => normalizeCachePath(path.dirname(p)));
  const discoveredDirs = buildAutoDiscoveryDirectories(home);
  const directories = dedupePaths([...staticDirs, ...discoveredDirs]);

  contractCacheDiscoveryMemo = {
    expiresAt: now + CONTRACT_CACHE_FILE_DISCOVERY_TTL_MS,
    directFiles: staticFiles,
    directories,
  };
  return { ...contractCacheDiscoveryMemo, fromMemo: false };
}

async function gatherContractCacheCandidateFiles(targets) {
  const files = [];
  const pushFile = (filePath) => {
    const normalized = normalizeCachePath(filePath);
    if (!normalized) return;
    if (!/^.*contract-cache.*\.json$/i.test(normalized)) return;
    files.push(normalized);
  };

  (targets.directFiles || []).forEach(pushFile);

  const dirChecks = (targets.directories || []).map(async (dirPath) => {
    try {
      const stats = await fs.promises.stat(dirPath).catch(() => null);
      if (!stats || !stats.isDirectory()) return;
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry || !entry.isFile()) continue;
        if (!/^contract-cache.*\.json$/i.test(entry.name)) continue;
        pushFile(path.join(dirPath, entry.name));
      }
    } catch (_) { }
  });

  await Promise.all(dirChecks);
  return dedupePaths(files);
}

function extractSettlementsFromContractPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const arrayCandidates = [
    payload.settlements,
    payload.data,
    payload.contracts,
    payload.records,
    payload.cache && payload.cache.settlements,
  ];

  for (const candidate of arrayCandidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function toTimestampMs(value) {
  if (Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string') return null;
  const maybeNumber = Number(value);
  if (Number.isFinite(maybeNumber)) return maybeNumber > 1e12 ? maybeNumber : maybeNumber * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSettlementEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const tsFields = [
    entry.timestamp,
    entry.ts,
    entry.settledTs,
    entry.settleTime,
    entry.createdAt,
    entry.created_at,
    entry.resolvedAt,
    entry.resolved_at,
    entry.date,
  ];
  let timestampMs = null;
  for (const field of tsFields) {
    const parsed = toTimestampMs(field);
    if (Number.isFinite(parsed) && parsed > 0) {
      timestampMs = parsed;
      break;
    }
  }

  const inferredSymbol =
    entry.symbol ||
    entry.sym ||
    entry.coin ||
    (typeof entry.ticker === 'string' ? (entry.ticker.match(/KX([A-Z]{3,})/i) || [])[1] || null : null);

  return {
    ...entry,
    symbol: inferredSymbol || null,
    coin: entry.coin || inferredSymbol || null,
    ts: Number.isFinite(entry.ts) ? entry.ts : timestampMs,
    timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : timestampMs,
    settledTs: Number.isFinite(entry.settledTs) ? entry.settledTs : timestampMs,
  };
}

function settlementSortTimestamp(entry) {
  return toTimestampMs(entry?.timestamp)
    || toTimestampMs(entry?.ts)
    || toTimestampMs(entry?.settledTs)
    || 0;
}

function settlementDedupKey(entry) {
  if (entry?.id) return `id:${entry.id}`;
  if (entry?.ticker || entry?.symbol || entry?.coin) {
    const token = entry.ticker || entry.symbol || entry.coin;
    const ts = settlementSortTimestamp(entry);
    const outcome = entry.outcome || entry.result || entry.actualOutcome || 'na';
    return `tok:${token}|ts:${ts}|out:${outcome}`;
  }
  return `fallback:${JSON.stringify(entry)}`;
}

async function parseContractCacheFile(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) return null;

    const raw = await fs.promises.readFile(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;

    const parsed = JSON.parse(raw);
    const settlements = extractSettlementsFromContractPayload(parsed)
      .map(normalizeSettlementEntry)
      .filter(Boolean);

    let newestSettlementMs = 0;
    for (const settlement of settlements) {
      const ts = settlementSortTimestamp(settlement);
      if (ts > newestSettlementMs) newestSettlementMs = ts;
    }

    const freshnessMs = Math.max(stats.mtimeMs || 0, newestSettlementMs || 0);

    return {
      filePath: normalizeCachePath(filePath),
      mtimeMs: stats.mtimeMs || 0,
      sizeBytes: stats.size || 0,
      settlementCount: settlements.length,
      newestSettlementMs,
      freshnessMs,
      settlements,
    };
  } catch (_) {
    return null;
  }
}

function mergeRecentSettlements(cacheFiles, maxSources = 12, lookbackMs = 24 * 60 * 60 * 1000) {
  if (!Array.isArray(cacheFiles) || cacheFiles.length === 0) {
    return { merged: [], selectedSources: [] };
  }

  const sorted = [...cacheFiles].sort((a, b) => b.freshnessMs - a.freshnessMs);
  const newestMs = sorted[0].freshnessMs || 0;

  const selectedSources = sorted.filter((entry, idx) => {
    if (idx < 3) return true; // always blend the 3 freshest sources
    if (idx >= maxSources) return false;
    return newestMs - entry.freshnessMs <= lookbackMs;
  });

  const mergedMap = new Map();
  for (const source of selectedSources) {
    for (const settlement of source.settlements || []) {
      const key = settlementDedupKey(settlement);
      const existing = mergedMap.get(key);
      if (!existing || settlementSortTimestamp(settlement) > settlementSortTimestamp(existing)) {
        mergedMap.set(key, settlement);
      }
    }
  }

  const merged = Array.from(mergedMap.values()).sort((a, b) => settlementSortTimestamp(b) - settlementSortTimestamp(a));
  return { merged, selectedSources };
}

ipcMain.handle('storage:readContractCache', async (_event, options = {}) => {
  const startedAt = Date.now();
  const forceRefresh = !!options.forceRefresh;
  const maxSources = Number.isFinite(options.maxSources) ? Math.max(1, options.maxSources) : 12;
  const lookbackMs = Number.isFinite(options.lookbackMs) ? Math.max(0, options.lookbackMs) : 24 * 60 * 60 * 1000;

  const discoveryTargets = getContractCacheDiscoveryTargets({ forceRefresh });
  const candidateFiles = await gatherContractCacheCandidateFiles(discoveryTargets);

  console.log(
    `[IPC] Contract cache discovery: ${candidateFiles.length} candidate files ` +
    `across ${discoveryTargets.directories.length} directories ` +
    `(memo=${discoveryTargets.fromMemo ? 'hit' : 'miss'})`
  );

  const parsedResults = await Promise.all(candidateFiles.map(parseContractCacheFile));
  const parsedFiles = parsedResults.filter(Boolean);

  if (parsedFiles.length === 0) {
    console.warn('[IPC] Contract cache not found on any discovered path');
    return {
      success: false,
      settlements: [],
      data: [],
      contracts: [],
      source: 'not_found',
      count: 0,
      discoveredFiles: 0,
      scanMs: Date.now() - startedAt,
    };
  }

  const sortedByFreshness = [...parsedFiles].sort((a, b) => b.freshnessMs - a.freshnessMs);
  const primary = sortedByFreshness[0];
  const { merged, selectedSources } = mergeRecentSettlements(sortedByFreshness, maxSources, lookbackMs);

  const sources = selectedSources.map((s) => ({
    path: s.filePath,
    count: s.settlementCount,
    mtimeMs: s.mtimeMs,
    newestSettlementMs: s.newestSettlementMs,
    freshnessMs: s.freshnessMs,
    sizeBytes: s.sizeBytes,
  }));

  console.log(
    `[IPC] Loaded ${merged.length} merged settlements ` +
    `from ${selectedSources.length}/${parsedFiles.length} discovered cache files ` +
    `(primary=${primary.filePath})`
  );

  return {
    success: true,
    settlements: merged,
    data: merged,       // back-compat for existing renderer callers
    contracts: merged,  // back-compat alias
    source: primary.filePath,
    count: merged.length,
    discoveredFiles: parsedFiles.length,
    selectedSourceCount: selectedSources.length,
    sources,
    newestTimestamp: merged.length ? settlementSortTimestamp(merged[0]) : null,
    scanMs: Date.now() - startedAt,
    cacheDiscoveryMemoHit: !!discoveryTargets.fromMemo,
  };
});

ipcMain.handle('storage:writeContractCache', async (_event, payload = [], options = {}) => {
  const startedAt = Date.now();
  try {
    const settlements = Array.isArray(payload) ? payload : [];
    const now = Date.now();
    const cacheDoc = {
      version: 1,
      savedAt: now,
      settlements,
    };

    const discoveryTargets = getContractCacheDiscoveryTargets({ forceRefresh: !!options.forceRefresh });
    const candidateFiles = await gatherContractCacheCandidateFiles(discoveryTargets);
    const targets = dedupePaths([
      ...candidateFiles,
      ...(discoveryTargets?.directFiles || []),
    ]);

    if (!targets.length) {
      return { success: false, error: 'No cache targets discovered', count: settlements.length };
    }

    const serialized = JSON.stringify(cacheDoc, null, 2);
    let writeCount = 0;
    let firstPath = null;

    for (const filePath of targets) {
      try {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, serialized, 'utf8');
        fs.renameSync(tmpPath, filePath);
        writeCount++;
        if (!firstPath) firstPath = filePath;
      } catch (_) {
        // Continue writing to other targets
      }
    }

    return {
      success: writeCount > 0,
      path: firstPath,
      writeCount,
      count: settlements.length,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      elapsedMs: Date.now() - startedAt,
    };
  }
});

// ── IPC: Enumerate all available storage roots (local, network, cloud) ──────
ipcMain.handle('storage:getGoogleDriveTargets', async () => {
  return {
    targets: [
      { root: 'H:\\My Drive', type: 'cloud', name: 'Google Drive Main' },
      { root: 'I:\\My Drive', type: 'cloud', name: 'Google Drive Fallback' },
      { root: 'G:\\My Drive', type: 'cloud', name: 'Google Drive Legacy' }
    ]
  };
});

let storageDrivesCache = { ts: 0, value: null };
ipcMain.handle('storage:getDrives', async (_event, options = {}) => {
  const now = Date.now();
  if (!options?.force && storageDrivesCache.value && (now - storageDrivesCache.ts) < 60000) {
    return storageDrivesCache.value;
  }

  const found = [];
  const localRoots = enumerateReadableDriveRoots();

  // ── Local / mapped drive letters C-Z ─────────────────────────────────────
  for (const root of localRoots) {
    const letter = typeof root === 'string' && /^[A-Za-z]:\\$/.test(root) ? root[0].toUpperCase() : null;
    found.push({ type: 'local', letter, root });
  }

  // ── Network / UNC shares via `net use` ────────────────────────────────────
  try {
    const { execSync } = require('child_process');
    const out = execSync('net use', { encoding: 'utf8', timeout: 3000 });
    const re = /\\\\[\w\-.]+\\[\w\-.$]+/g;
    for (const unc of (out.match(re) || [])) {
      if (!found.some(d => d.root === unc + '\\')) {
        found.push({ type: 'network', letter: null, root: unc + '\\' });
      }
    }
  } catch (_) { }

  // ── Cloud sync folders (OneDrive / Google Drive) ──────────────────────────
  const home = process.env.USERPROFILE || '';
  const dynamicCloudCandidates = buildDynamicCloudDriveCandidates(localRoots);
  const cloudCandidates = [
    `${home}\\OneDrive`,
    `${home}\\OneDrive - Personal`,
    'I:\\My Drive',
    'G:\\My Drive',
    `${home}\\Google Drive`,
    `${home}\\My Drive`,
    process.env.GOOGLE_DRIVE_PATH || null,
    ...dynamicCloudCandidates,
  ];
  try {
    if (home && fs.existsSync(home)) {
      for (const name of fs.readdirSync(home)) {
        if (name.startsWith('OneDrive')) {
          const p = path.join(home, name);
          if (!cloudCandidates.includes(p)) cloudCandidates.push(p);
        }
      }
    }
  } catch (_) { }
  for (const p of cloudCandidates) {
    if (!p) continue;
    try { if (fs.existsSync(p)) found.push({ type: 'cloud', letter: null, root: p }); }
    catch (_) { }
  }

  storageDrivesCache = { ts: Date.now(), value: found };
  return found;
});

ipcMain.handle('drive:sync-backup', async (_event, payload = {}) => {
  try {
    const drives = await ipcMain._invokeHandler('storage:getDrives', { sender: null });
    const cloudRoots = (Array.isArray(drives) ? drives : [])
      .filter((drive) => drive?.type === 'cloud' && drive?.root)
      .map((drive) => drive.root);

    if (!cloudRoots.length) {
      return { success: false, error: 'No cloud sync roots discovered' };
    }

    const stamp = new Date().toISOString().replace(/[T:.]/g, '-');
    const backupName = `wecrypto-backup-${stamp}.json`;
    const backupPayload = {
      schemaVersion: 'wecrypto.backup.v1',
      createdAt: new Date().toISOString(),
      source: 'electron-main',
      payload,
    };

    const written = [];
    const serialized = JSON.stringify(backupPayload, null, 2);
    for (const root of cloudRoots) {
      try {
        const dir = path.join(root, 'WECRYPTO', 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, backupName);
        fs.writeFileSync(filePath, serialized, 'utf8');
        written.push(filePath);
      } catch (_) {
        // continue with next cloud root
      }
    }

    if (GoogleCloudBridge && typeof GoogleCloudBridge.publishPubSub === 'function') {
      GoogleCloudBridge.publishPubSub('drive-sync-backup', {
        backupName,
        paths: written,
        payloadMeta: {
          hasPayload: !!payload,
          keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
        },
      }, { backupName }).catch((err) => {
        console.warn('[GoogleCloud] Drive backup publish skipped:', err.message);
      });
    }

    return {
      success: written.length > 0,
      backupName,
      paths: written,
      count: written.length,
      error: written.length ? null : 'No backup files were written',
    };
  } catch (error) {
    return { success: false, error: error.message || 'Drive sync backup failed' };
  }
});

ipcMain.handle('drive:recover-backups', async (_event, options = {}) => {
  try {
    const drives = await ipcMain._invokeHandler('storage:getDrives', { sender: null });
    const cloudRoots = (Array.isArray(drives) ? drives : [])
      .filter((drive) => drive?.type === 'cloud' && drive?.root)
      .map((drive) => drive.root);

    if (!cloudRoots.length) {
      return { success: false, error: 'No cloud sync roots discovered', recovered: 0, matches: [] };
    }

    const containsAny = Array.isArray(options?.containsAny) ? options.containsAny.map((v) => String(v).toLowerCase()) : ['wecrypto', 'wecryp'];
    const maxResults = Math.max(1, Math.min(200, Number(options?.maxResults) || 25));

    const matches = [];
    for (const root of cloudRoots) {
      const backupDir = path.join(root, 'WECRYPTO', 'backups');
      if (!fs.existsSync(backupDir)) continue;
      let files = [];
      try {
        files = fs.readdirSync(backupDir)
          .filter((name) => name.toLowerCase().endsWith('.json'))
          .map((name) => path.join(backupDir, name));
      } catch (_) {
        continue;
      }

      for (const filePath of files) {
        if (matches.length >= maxResults) break;
        const lower = filePath.toLowerCase();
        if (!containsAny.some((needle) => lower.includes(needle))) continue;
        try {
          const stat = fs.statSync(filePath);
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          matches.push({
            root,
            path: filePath,
            modifiedAt: stat?.mtime ? stat.mtime.toISOString() : null,
            payloadKind: parsed?.payload?.kind || null,
            count: Number(parsed?.payload?.count || parsed?.payload?.inferences?.length || 0),
            parsed,
          });
        } catch (_) {
          // ignore malformed backup files
        }
      }

      if (matches.length >= maxResults) break;
    }

    matches.sort((a, b) => Date.parse(String(b.modifiedAt || 0)) - Date.parse(String(a.modifiedAt || 0)));
    const latest = matches.length ? matches[0].parsed?.payload || null : null;

    return {
      success: true,
      scannedRoots: cloudRoots.length,
      recovered: matches.length,
      matches: matches.map((item) => ({
        root: item.root,
        path: item.path,
        modifiedAt: item.modifiedAt,
        payloadKind: item.payloadKind,
        count: item.count,
      })),
      latestPayload: latest,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Drive recovery failed',
      recovered: 0,
      matches: [],
    };
  }
});

async function runLLMInferencePacket(snapshot = {}) {
  if (!LLMSignalAssistant || typeof LLMSignalAssistant.analyzeSnapshot !== 'function') {
    return { success: false, error: 'LLM assistant unavailable' };
  }

  if (!snapshot || typeof snapshot !== 'object' || !snapshot.coin) {
    return { success: false, error: 'Invalid snapshot payload' };
  }

  try {
    const output = await LLMSignalAssistant.analyzeSnapshot(snapshot);
    const diagnostics = typeof LLMSignalAssistant.getDiagnostics === 'function'
      ? LLMSignalAssistant.getDiagnostics()
      : {};
    const cooldown = diagnostics?.cooldown || null;
    const degraded = !!cooldown?.active
      || (Array.isArray(output?.warnings) && output.warnings.some((warning) => /cooldown|rate limit|quota/i.test(String(warning || ''))));

    const packet = {
      success: true,
      output,
      diagnostics,
      degraded,
      providerStatus: {
        degraded,
        provider: diagnostics?.provider || null,
        model: diagnostics?.model || null,
        cooldown,
      },
    };

    if (GoogleCloudBridge && typeof GoogleCloudBridge.publishLLMInference === 'function') {
      GoogleCloudBridge.publishLLMInference(snapshot, packet).catch((err) => {
        console.warn('[GoogleCloud] LLM inference publish skipped:', err.message);
      });
    }

    return packet;
  } catch (error) {
    return { success: false, error: error.message || 'LLM inference failed' };
  }
}

// ── IPC: LLM inference bridge (main process inference layer) ──────────────────
ipcMain.handle('llm:analyzeSnapshot', async (_event, snapshot = {}) => {
  return runLLMInferencePacket(snapshot);
});

ipcMain.handle('llm:getStats', async () => {
  return LLMSignalAssistant ? LLMSignalAssistant.getDiagnostics() : null;
});

ipcMain.handle('ai:run-inference', async (_event, payload = {}) => {
  const prompt = String(payload?.prompt || '').trim();
  const context = payload?.context && typeof payload.context === 'object' ? payload.context : {};
  const coin = String(context.coin || context.sym || context.symbol || 'BTC').toUpperCase();

  const snapshot = {
    coin,
    horizon: Number.isFinite(Number(context.horizon)) ? Number(context.horizon) : 15,
    confidence: Number.isFinite(Number(context.confidence)) ? Number(context.confidence) : 0,
    score: Number.isFinite(Number(context.score)) ? Number(context.score) : 0,
    signal: String(context.signal || 'neutral'),
    prompt,
    context,
    meta: {
      source: 'ai:run-inference',
      ts: Date.now(),
    },
  };

  return runLLMInferencePacket(snapshot);
});

ipcMain.handle('google:cloudStatus', async () => {
  try {
    return {
      success: true,
      status: GoogleCloudBridge && typeof GoogleCloudBridge.getStatus === 'function'
        ? GoogleCloudBridge.getStatus()
        : { enabled: false },
    };
  } catch (error) {
    return { success: false, error: error.message || 'Google cloud status unavailable' };
  }
});

ipcMain.handle('google:cloudSqlStatus', async (_event, options = {}) => {
  if (!GoogleCloudBridge || typeof GoogleCloudBridge.probeCloudSql !== 'function') {
    return { success: false, error: 'Google cloud bridge unavailable' };
  }
  try {
    const status = await GoogleCloudBridge.probeCloudSql({
      includeDatabase: options?.includeDatabase !== false,
      force: !!options?.force,
    });
    return { success: !!status?.success, status };
  } catch (error) {
    return { success: false, error: error.message || 'Cloud SQL status unavailable' };
  }
});

ipcMain.handle('google:testCloudSql', async () => {
  if (!GoogleCloudBridge || typeof GoogleCloudBridge.probeCloudSql !== 'function') {
    return { success: false, error: 'Google cloud bridge unavailable' };
  }
  try {
    const status = await GoogleCloudBridge.probeCloudSql({ includeDatabase: true, force: true });
    return { success: !!status?.success, status };
  } catch (error) {
    return { success: false, error: error.message || 'Cloud SQL test failed' };
  }
});

ipcMain.handle('google:tideForecast', async (_event, payload = {}) => {
  if (!GoogleCloudBridge || typeof GoogleCloudBridge.predictTide !== 'function') {
    return { success: false, error: 'Google cloud bridge unavailable' };
  }
  try {
    return await GoogleCloudBridge.predictTide(payload);
  } catch (error) {
    return { success: false, error: error.message || 'TiDE forecast failed' };
  }
});

ipcMain.handle('firebase:getSystemWeights', async () => {
  if (!FirebaseAdminFirestore || typeof FirebaseAdminFirestore.getSystemWeights !== 'function') {
    return { success: false, error: 'Firebase Admin module unavailable or method missing' };
  }
  try {
    const weights = await FirebaseAdminFirestore.getSystemWeights();
    return { success: true, weights };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('firebase:status', async () => {
  try {
    return {
      success: true,
      status: FirebaseAdminFirestore && typeof FirebaseAdminFirestore.getStatus === 'function'
        ? FirebaseAdminFirestore.getStatus()
        : { available: false },
    };
  } catch (error) {
    return { success: false, error: error.message || 'Firebase status unavailable' };
  }
});

// Renderer read-back of the orbital-matrix synthesis (Redpanda/Kafka -> Firestore
// pipeline run by scripts/start-runtime.js). Non-authoritative supplementary
// signal for the LLM inference layer — never spot/PTB. Returns null/unavailable
// when the pipeline isn't running or Firestore has no doc yet, never throws.
ipcMain.handle('orbital:getSignal', async (_event, sym) => {
  if (!OrbitalBroadcaster || typeof OrbitalBroadcaster.getLatestState !== 'function') {
    return { success: false, error: 'Orbital broadcaster unavailable' };
  }
  try {
    const state = await OrbitalBroadcaster.getLatestState(sym);
    return { success: true, state };
  } catch (error) {
    return { success: false, error: error.message || 'Orbital signal read failed' };
  }
});

// Pull-style fallback for the Redis tick subscriber above — mainly for the
// renderer's initial read on load, before any live push has arrived yet.
// Live updates come via the 'orbital:redisTick' push event instead.
ipcMain.handle('orbital:getLatestTick', (_event, { type, asset } = {}) => {
  if (!OrbitalRedisSubscriber) return { success: false, error: 'Redis subscriber unavailable' };
  try {
    const tick = OrbitalRedisSubscriber.getLatest(type, asset);
    return { success: true, tick };
  } catch (error) {
    return { success: false, error: error.message || 'Redis tick read failed' };
  }
});

ipcMain.handle('orbital:redisStatus', () => {
  if (!OrbitalRedisSubscriber) return { success: false, error: 'Redis subscriber unavailable' };
  return { success: true, status: OrbitalRedisSubscriber.getStatus() };
});

// Warm tier for src/core/tiered-cache.js.
ipcMain.handle('tieredCache:warmGet', async (_event, { key } = {}) => {
  if (!TieredCacheRedis) return { success: false, error: 'Redis KV unavailable' };
  try {
    const value = await TieredCacheRedis.warmGet(key);
    return { success: true, value };
  } catch (error) {
    return { success: false, error: error.message || 'warmGet failed' };
  }
});

ipcMain.handle('tieredCache:warmSet', async (_event, { key, value, ttlMs } = {}) => {
  if (!TieredCacheRedis) return { success: false, error: 'Redis KV unavailable' };
  try {
    const ok = await TieredCacheRedis.warmSet(key, value, ttlMs);
    return { success: ok };
  } catch (error) {
    return { success: false, error: error.message || 'warmSet failed' };
  }
});

ipcMain.handle('tieredCache:warmDel', async (_event, { key } = {}) => {
  if (!TieredCacheRedis) return { success: false, error: 'Redis KV unavailable' };
  try {
    const ok = await TieredCacheRedis.warmDel(key);
    return { success: ok };
  } catch (error) {
    return { success: false, error: error.message || 'warmDel failed' };
  }
});

// Orbital broadcaster: renderer fires-and-forgets after each processInterval().
ipcMain.on('orbital:push', (_event, orbitalResult) => {
  if (!OrbitalBroadcaster || !orbitalResult) return;
  try { OrbitalBroadcaster.push(orbitalResult); } catch (_) { }
});

ipcMain.on('orbital:pushTick', (_event, tick) => {
  if (!OrbitalBroadcaster || !tick) return;
  try {
    if (typeof OrbitalBroadcaster.pushMarketTick === 'function') {
      OrbitalBroadcaster.pushMarketTick(tick);
    }
  } catch (_) { }
});

ipcMain.on('orbital:pushVertex', (_event, payload = {}) => {
  if (!OrbitalBroadcaster || !payload) return;
  try {
    if (typeof OrbitalBroadcaster.pushVertexExecution === 'function') {
      OrbitalBroadcaster.pushVertexExecution(payload.kind, payload.data || {});
    }
  } catch (_) { }
});

ipcMain.handle('orbital:broadcaster:diagnostics', () => {
  return OrbitalBroadcaster && typeof OrbitalBroadcaster.getDiagnostics === 'function'
    ? OrbitalBroadcaster.getDiagnostics()
    : { firestoreReady: false, error: 'broadcaster not loaded' };
});

// Grok session memory: renderer fires-and-forgets on its existing sample/
// window-close/persist cadences (see src/llm/grok-analytics-memory.js).
ipcMain.on('grok:pushTick', (_event, { coin, payload } = {}) => {
  if (!coin || !payload || !OrbitalRedpandaBridge) return;
  try {
    if (typeof OrbitalRedpandaBridge.produceGrokTick === 'function') OrbitalRedpandaBridge.produceGrokTick(coin, payload);
  } catch (_) { }
});

ipcMain.on('grok:pushPtbWindowClose', (_event, record) => {
  if (!GrokFirestoreBridge || !record) return;
  try { GrokFirestoreBridge.recordPtbWindowClose(record); } catch (_) { }
});

ipcMain.on('grok:writeSessionSnapshot', (_event, { coin, snapshot } = {}) => {
  if (!GrokFirestoreBridge || !coin || !snapshot) return;
  try { GrokFirestoreBridge.writeSessionSnapshot(coin, snapshot); } catch (_) { }
});

ipcMain.handle('grok:getPtbDefenseStats', async (_event, { coin, ptb, opts } = {}) => {
  if (!GrokFirestoreBridge) return { success: false, stats: null, error: 'bridge not loaded' };
  try {
    return await GrokFirestoreBridge.getPtbDefenseStats(coin, ptb, opts || {});
  } catch (error) {
    return { success: false, stats: null, error: error.message || 'getPtbDefenseStats failed' };
  }
});

ipcMain.handle('grok:getSessionSnapshot', async (_event, { coin } = {}) => {
  if (!GrokFirestoreBridge) return { success: false, snapshot: null, error: 'bridge not loaded' };
  try {
    return await GrokFirestoreBridge.getSessionSnapshot(coin);
  } catch (error) {
    return { success: false, snapshot: null, error: error.message || 'getSessionSnapshot failed' };
  }
});

ipcMain.handle('grok:bridgeStatus', async () => {
  return GrokFirestoreBridge && typeof GrokFirestoreBridge.getDiagnostics === 'function'
    ? GrokFirestoreBridge.getDiagnostics()
    : { firestoreReady: false, error: 'bridge not loaded' };
});

ipcMain.handle('orbital:status', async () => {
  if (typeof getOrbitalStatus === 'function') {
    return getOrbitalStatus();
  }
  return { ready: false, services: {} };
});

ipcMain.handle('orbital:restart', async () => {
  try {
    const workspacePath = process.env.WECRYP_ROOT || path.join(__dirname, '..');
    await restartOrbitalSystem(workspacePath);
    return { success: true, status: await getOrbitalStatus() };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('firebase:startupCheck', async (_event, options = {}) => {
  if (!FirebaseAdminFirestore || typeof FirebaseAdminFirestore.startupCheck !== 'function') {
    return { success: false, error: 'Firebase Admin module unavailable' };
  }
  try {
    return await FirebaseAdminFirestore.startupCheck({
      required: !!options.required,
      probe: options.probe !== false,
    });
  } catch (error) {
    return { success: false, error: error.message || 'Firebase startup check failed' };
  }
});

ipcMain.handle('firebase:getInferences', async (_event, options = {}) => {
  if (!FirebaseAdminFirestore || typeof FirebaseAdminFirestore.getInferenceRecords !== 'function') {
    return { success: false, records: [], error: 'Firebase Admin module unavailable' };
  }
  try {
    const records = await FirebaseAdminFirestore.getInferenceRecords(options?.limit || 30);
    return { success: true, records };
  } catch (error) {
    return { success: false, records: [], error: error.message || 'Failed to read inference history' };
  }
});

ipcMain.handle('firebase:appendInference', async (_event, record = {}) => {
  if (!FirebaseAdminFirestore || typeof FirebaseAdminFirestore.appendInferenceRecord !== 'function') {
    return { success: false, error: 'Firebase Admin module unavailable' };
  }
  try {
    return await FirebaseAdminFirestore.appendInferenceRecord(record);
  } catch (error) {
    return { success: false, error: error.message || 'Failed to write inference record' };
  }
});

ipcMain.handle('llm:getDiagnostics', async () => {
  if (!LLMSignalAssistant || typeof LLMSignalAssistant.getDiagnostics !== 'function') {
    return { success: false, error: 'LLM assistant unavailable' };
  }
  try {
    return { success: true, diagnostics: LLMSignalAssistant.getDiagnostics() };
  } catch (error) {
    return { success: false, error: error.message || 'LLM diagnostics failed' };
  }
});

ipcMain.handle('llm:getQueryHistory', async (_event, limit = 50) => {
  if (!LLMSignalAssistant || typeof LLMSignalAssistant.getQueryHistory !== 'function') {
    return { success: false, queries: [], error: 'LLM query history unavailable' };
  }
  try {
    return { success: true, queries: LLMSignalAssistant.getQueryHistory(limit) };
  } catch (error) {
    return { success: false, queries: [], error: error.message || 'Failed to fetch query history' };
  }
});

ipcMain.handle('llm:envStatus', async () => {
  const diagnostics = (LLMSignalAssistant && typeof LLMSignalAssistant.getDiagnostics === 'function')
    ? LLMSignalAssistant.getDiagnostics()
    : null;

  const asi1Diag = (() => {
    try {
      return require('../src/infra/asi1-client').getDiagnostics();
    } catch (_) {
      return { configured: false, keysConfigured: 0 };
    }
  })();

  return {
    success: true,
    status: {
      // ASI1-only inference layer -- no other provider keys/URLs are read or used.
      providerConfigured: 'asi1',
      selectedModel: asi1Diag.defaultModel || null,
      selectedApiUrl: asi1Diag.baseUrl || null,
      hasAsi1Key: !!asi1Diag.configured,
      asi1KeysConfigured: asi1Diag.keysConfigured || 0,
      asi1KeyEnvNames: asi1Diag.keyEnvNames || [],
      asi1BaseUrl: asi1Diag.baseUrl || null,
      hasDotenvPathOverride: !!process.env.LLM_ENV_PATH,
      envPathOverride: process.env.LLM_ENV_PATH || null,
      assistantLoaded: !!LLMSignalAssistant,
      assistantEnabled: !!diagnostics?.enabled,
      assistantProvider: diagnostics?.provider || null,
      assistantModel: diagnostics?.model || null,
      assistantEnv: diagnostics?.env || null,
      checkedAt: Date.now(),
    },
  };
});

// ── IPC: Validator15m (15-min confidence calibration) ────────────────────────
// Bridge between predictions.js (renderer) and audit-suite
ipcMain.handle('validator:getStats', async (event) => {
  try {
    // Execute in renderer context to access window.Validator15m
    const stats = await event.sender.executeJavaScript(
      'window.Validator15m?.getStats() || { total: 0, hitRate: 0, calibration: [] }'
    );
    return { success: true, data: stats };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('validator:getAll', async (event) => {
  try {
    const validations = await event.sender.executeJavaScript(
      'window.Validator15m?.getAll() || []'
    );
    return { success: true, data: validations };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('validator:getCoin', async (event, sym) => {
  try {
    const coinValidations = await event.sender.executeJavaScript(
      `window.Validator15m?.getAll()?.filter(v => v.sym === '${sym}') || []`
    );
    return { success: true, data: coinValidations };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ── Web Service State Sync ────────────────────────────────────────────────
ipcMain.on('web:update-state', (event, stateUpdate) => {
  updateState(stateUpdate);
  const telemetryPacket = {
    ts: Date.now(),
    revision: stateUpdate?.revision ?? null,
    schemaVersion: stateUpdate?.schemaVersion || null,
    publishReason: stateUpdate?.publishReason || null,
    activeCoins: Array.isArray(stateUpdate?.activeCoins) ? stateUpdate.activeCoins : [],
    predictionCount: Object.keys(stateUpdate?.predictions || {}).length,
    signalCount: Object.keys(stateUpdate?.signals || {}).length,
  };
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('telemetry-update', telemetryPacket);
  }
  if (GoogleCloudBridge && typeof GoogleCloudBridge.publishWebState === 'function') {
    GoogleCloudBridge.publishWebState(stateUpdate).catch((err) => {
      console.warn('[GoogleCloud] Web state publish skipped:', err.message);
    });
  }
});

ipcMain.on('web:broadcast-update', (event, { type, data }) => {
  broadcastUpdate(type, data);
});

function createPolycoolWindow(url = 'https://polycool.app') {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    backgroundColor: '#0b1020',
    title: 'Polycool WebApp',
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadURL(url);

  win.on('closed', () => {
    if (process.argv.includes('--polycool')) {
      app.quit();
    }
  });
}

function createWindow() {
  const win = mainWin = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0b1020',
    icon: path.join(__dirname, '../assets/app-icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false
    }
  });
  global.WECRYPTO_MAIN_WINDOW = win;

  let visibleOnce = false;
  const showMainWindow = (reason) => {
    if (visibleOnce || win.isDestroyed()) return;
    visibleOnce = true;
    win.show();
    win.focus();
    console.log(`[Window] shown (${reason})`);
    if (process.env.WECRYPTO_OPEN_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  };

  win.once('ready-to-show', () => {
    showMainWindow('ready-to-show');

    // --- CPU Core Affinity Binding for Renderer ---
    // The Floating Orchestrator and WASM SIMD Tensor Math loops run here.
    // Pinning this process to the same CCX block ensures L3 cache hits.
    try {
      const rendererPid = win.webContents.getOSProcessId();
      if (rendererPid) {
        const affinityMask = 255;
        console.log(`[Startup] Launching PowerShell to lock Renderer (Floating Orchestrator) Affinity (PID ${rendererPid}) to mask ${affinityMask}...`);
        const { exec } = require('child_process');
        exec(`powershell -Command "$Process = Get-Process -Id ${rendererPid}; $Process.ProcessorAffinity = ${affinityMask}"`, { windowsHide: true }, (err) => {
          if (err) console.warn(`[Startup] Failed to set Renderer Affinity: ${err.message}`);
          else console.log(`[Startup] Renderer Affinity successfully locked for PID ${rendererPid}.`);
          if (!win.isDestroyed()) win.focus();
        });
      }
    } catch (err) {
      console.warn('[Startup] Could not determine Renderer PID for affinity binding:', err);
    }
  });
  win.webContents.once('did-finish-load', () => showMainWindow('did-finish-load'));
  setTimeout(() => showMainWindow('startup-timeout'), 5000);

  win.on('unresponsive', () => {
    console.warn('[Window] renderer became unresponsive');
  });
  win.on('responsive', () => {
    console.log('[Window] renderer responsive again');
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Window] render process gone:', details);
  });

  win.on('closed', () => {
    if (global.WECRYPTO_MAIN_WINDOW === win) {
      global.WECRYPTO_MAIN_WINDOW = null;
    }
    if (mainWin === win) {
      mainWin = null;
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '../public/index.html'));

  const consoleMsgHistory = new Map();
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const now = Date.now();
    const key = `${line}:${sourceId}:${message}`;
    const prev = consoleMsgHistory.get(key);
    if (prev && (now - prev.ts < 2000)) {
      prev.count++;
      return;
    }
    const levelName = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
    if (prev && prev.count > 1) {
      console.log(`[RENDERER ${levelName}] (suppressed ${prev.count - 1} duplicates) ${message} (${sourceId}:${line})`);
    } else {
      console.log(`[RENDERER ${levelName}] ${message} (${sourceId}:${line})`);
    }
    consoleMsgHistory.set(key, { ts: now, count: 1 });

    if (consoleMsgHistory.size > 200) {
      for (const [k, v] of consoleMsgHistory) {
        if (now - v.ts > 10000) consoleMsgHistory.delete(k);
      }
    }
  });

  // Inject the live proxy port so proxy-fetch.js can correct itself if it
  // started on the wrong guess before discovery completed.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`window.__PROXY_PORT__ = ${proxyPort};`).catch(() => { });
  });
}

// Best-effort nudge for the wecrypto-wsl WireGuard tunnel: boots the WSL VM
// (starting its systemd units, including wg-quick@wg0) if it isn't already
// resident, and starts the unit if it isn't already running. No-op on
// failure -- the Windows-side WireGuard service and .wslconfig
// vmIdleTimeout=-1 are the primary always-on mechanisms; this just covers
// the case where the WSL VM idled out before the app launched.
function ensureWslWireguardTunnel() {
  if (process.platform !== 'win32') return;
  const distro = process.env.WECRYPTO_WSL_DISTRO || 'Ubuntu';
  const child = spawn('wsl.exe', ['-d', distro, '-u', 'root', '--', 'systemctl', 'start', 'wg-quick@wg0'], {
    windowsHide: true,
  });
  child.on('error', (err) => {
    console.warn(`[wsl-wg] failed to spawn wsl.exe: ${err.message}`);
  });
  child.on('exit', (code) => {
    if (code === 0) {
      console.log('[wsl-wg] wg-quick@wg0 confirmed running in WSL.');
    } else {
      console.warn(`[wsl-wg] systemctl start wg-quick@wg0 exited with code ${code}.`);
    }
  });
}

app.whenReady().then(async () => {
  ensureWslWireguardTunnel(); // best-effort; never blocks boot
  if (process.argv.includes('--polycool')) {
    createPolycoolWindow();
    return;
  }

  await startProxy();
  startCexFlowMonitor(); // best-effort; never blocks boot
  // --- Orbital Matrix (Redpanda Orchestration + Ingestion & Sync) ---
  (async () => {
    const workspacePath = process.env.WECRYP_ROOT || path.join(__dirname, '..');
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await startOrbitalSystem(workspacePath);
        console.log('[Main] Orbital Matrix architecture online.');
        return;
      } catch (err) {
        console.error(`[Main] Orbital Matrix start attempt ${attempt}/${maxAttempts} failed:`, err.message);
        if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 10_000));
      }
    }
    console.error('[Main] Orbital Matrix unavailable after automatic retries. Use the dashboard restart control.');
  })();

  Menu.setApplicationMenu(null);
  await waitForProxy();   // give proxy ~3s to bind before renderer fires fetchAll
  await ensureProxyForwards();
  scheduleProxyForwardsCheck(); // keep re-checking so a mid-session SOCKS/VPN flap self-heals
  scheduleProxyForwardsCheck(); // keep re-checking so a mid-session upstream flap self-heals

  // Start web service (HTTPS)
  webServiceHealth = startWebService() || webServiceHealth;
  console.log(`[Main] Web service bootstrap on ${webServiceHealth.protocol}://localhost:${webServiceHealth.port} (auto-port-failover enabled)`);

  createWindow();
  logStartupHealth('post-bootstrap');

  // Real-time orbital ticks via Redis pub/sub, pushed straight to the
  // renderer as they arrive (sub-second) instead of the existing Kafka ->
  // 15m-barrier -> Firestore -> 60s-poll path. Best-effort: if Redis isn't
  // reachable this just never fires, same degrade-gracefully posture as
  // every other orbital piece.
  if (OrbitalRedisSubscriber) {
    try {
      OrbitalRedisSubscriber.start((type, asset, payload) => {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('orbital:redisTick', { type, asset, payload });
        }
      });
    } catch (e) {
      console.warn('[OrbitalRedisSubscriber] start failed:', e.message);
    }
  }

  // Optional cloud checks must not block the desktop window from opening.
  (async () => {
    if (FirebaseAdminFirestore && typeof FirebaseAdminFirestore.startupCheck === 'function') {
      const firebaseEnabled = FirebaseAdminFirestore.envFlagEnabled
        ? FirebaseAdminFirestore.envFlagEnabled(process.env.WECRYPTO_FIREBASE_ENABLED || '0')
        : true;
      const firebaseRequired = FirebaseAdminFirestore.envFlagEnabled
        ? FirebaseAdminFirestore.envFlagEnabled(process.env.WECRYPTO_FIREBASE_REQUIRED || '0')
        : false;
      if (firebaseEnabled || firebaseRequired) {
        try {
          const timeoutMs = Number(process.env.WECRYPTO_FIREBASE_STARTUP_TIMEOUT_MS || 5000);
          const fb = await Promise.race([
            FirebaseAdminFirestore.startupCheck({ required: firebaseRequired, probe: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Firebase startup check timed out after ${timeoutMs}ms`)), timeoutMs)),
          ]);
          if (fb.success) {
            console.log(`[FirebaseAdmin] Ready (project=${fb.projectId}, saHash=${fb.clientEmailHash})`);
          } else {
            console.warn('[FirebaseAdmin] Disabled/not ready:', fb.error || 'unknown');
          }
        } catch (error) {
          if (firebaseRequired) {
            console.error('[FirebaseAdmin] FAIL-CLOSED:', error.message);
            app.exit(78);
            return;
          }
          console.warn('[FirebaseAdmin] Startup check skipped:', error.message);
        }
      }
    }
  })();

  // Start Pyth Lazer with proper error handling
  (async () => {
    const pythSuccess = await startPythLazerService(mainWin);
    if (pythSuccess) {
      pythLazerStatus.initialized = true;
      console.log('[Main] Pyth Lazer service initialized successfully');
    } else {
      pythLazerStatus.initialized = false;
      console.warn('[Main] Pyth Lazer unavailable — renderer will use alternative feeds');
    }
    logStartupHealth('post-pyth-init');
  })();

  // Proactive Agentverse Hunter: cues 60s after window is ready, non-blocking
  try {
    const AgentverseHunter = require('../src/llm/agentverse-hunter');
    AgentverseHunter.onHuntCompleted((huntResult) => {
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('asi1:agentverse-hunt-completed', huntResult);
      }
    });
    AgentverseHunter.startAutonomousScheduler({ bootDelayMs: 60_000, intervalMs: 300_000 });
    console.log('[AgentverseHunter] Autonomous multi-agent scheduler initialized; cued to hunt in 60s');
  } catch (err) {
    console.warn('[AgentverseHunter] initialization deferred:', err.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  if (process.argv.includes('--polycool')) {
    app.quit();
    return;
  }
  // Proxy stop handled by orchestrator
  if (pythLazerClient) { try { await pythLazerClient.shutdown(); } catch (_) { } pythLazerClient = null; }

  // Stop app-owned workers but preserve the persistent Redpanda cluster.
  try {
    await shutdownOrbitalSystem(true, { stopDocker: false });
  } catch (err) {
    console.warn('[Main] Error during orbital shutdown:', err.message);
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Graceful shutdown on app quit (safety net)
app.on('before-quit', async (event) => {
  try {
    await shutdownOrbitalSystem(true, { stopDocker: false });
  } catch (err) {
    console.warn('[Main] Error during orbital shutdown in before-quit:', err.message);
  }
  stopCexFlowMonitor();
});

