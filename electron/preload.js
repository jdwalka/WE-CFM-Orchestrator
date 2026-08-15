const { contextBridge, ipcRenderer } = require('electron');

function safeRequire(name) {
  try {
    return require(name);
  } catch (_) {
    return null;
  }
}

const crypto = safeRequire('crypto');
const ws = safeRequire('ws');
const fs = safeRequire('fs');
const path = safeRequire('path');

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

function envFileCandidates() {
  if (!fs || !path) return [];
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(path.dirname(process.execPath || __filename), '.env'),
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
  ].filter(Boolean);
  const seen = new Set();
  return candidates.filter((candidate) => {
    try {
      const normalized = path.resolve(candidate);
      const key = normalized.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return fs.existsSync(normalized);
    } catch (_) {
      return false;
    }
  });
}

function readEnvValue(names) {
  for (const name of names) {
    const value = process.env?.[name];
    if (value != null && String(value).trim()) return stripEnvValue(value);
  }
  if (!fs) return '';
  for (const envPath of envFileCandidates()) {
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      for (const name of names) {
        const value = readRawEnvValue(raw, name);
        if (value) return value;
      }
    } catch (_) {
      // keep looking
    }
  }
  return '';
}

function decodeJsonStringFragment(value) {
  try {
    return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
  } catch (_) {
    return String(value || '').replace(/\\"/g, '"').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  }
}

function secretDirCandidates() {
  if (!fs || !path) return [];
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(path.dirname(process.execPath || __filename), 'secrets'),
    path.join(__dirname, '..', 'secrets'),
    path.join(process.resourcesPath || '', '..', 'secrets'),
    path.join(process.cwd(), 'secrets'),
    localAppData && path.join(localAppData, 'WE-CRYPTO', 'user-data', 'secrets'),
    appData && path.join(appData, 'WE-CRYPTO-Polymarket-v2.15.6', 'secrets'),
    // Pre-rename installs kept their secrets under the old Kalshi-branded folder name.
    appData && path.join(appData, 'WE-CRYPTO-Kalshi-15m-v2.15.5', 'secrets'),
    'G:\\WECRYPTO\\secrets',
    'F:\\WECRYPTO\\secrets',
    'E:\\WECRYPTO\\secrets',
  ].filter(Boolean);
  const seen = new Set();
  return candidates.filter((candidate) => {
    try {
      const normalized = path.resolve(candidate);
      const key = normalized.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return fs.existsSync(normalized);
    } catch (_) {
      return false;
    }
  });
}

function readSecretScalar(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';

  for (const line of lines) {
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (kv && /coingecko|coin.?gecko|gecko|^cg_|^x[-_]?cg/i.test(kv[1])) {
      return stripEnvValue(kv[2]);
    }
  }

  const jsonKey = String(raw).match(/"(?:COINGECKO_API_KEY|COINGECKO_PRO_API_KEY|COINGECKO_DEMO_API_KEY|apiKey|key)"\s*:\s*"((?:\\.|[^"])*)"/i);
  if (jsonKey) return stripEnvValue(decodeJsonStringFragment(jsonKey[1]));

  return stripEnvValue(lines.reduce((longest, line) => line.length > longest.length ? line : longest, ''));
}

function readSecretFileValue(fileNames) {
  if (!fs || !path) return { value: '', path: '' };
  for (const dir of secretDirCandidates()) {
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
    'COINMARKETCAP_API_KEY.txt'
  ]);
}

function readPythLazerSecret() {
  // Prefer PYTH_API (upgraded key name), then PYTH_NEW, then legacy
  return readSecretFileValue([
    'PYTH_API',
    'PYTH_API.txt',
    'PYTH_NEW',
    'PYTH_NEW.txt',
    'PYTH_NEW_API',
    'PYTH_NEW_API.txt'
  ]);
}

function readPublicEnv() {
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
  const out = {};
  const key = proKey || demoKey || genericKey;
  if (key) out.COINGECKO_API_KEY = key;
  if (tier) out.COINGECKO_API_TIER = tier;

  const cmcSecret = readCMCSecret();
  const cmcKey = readEnvValue(['CMC_PRO_API_KEY', 'COINMARKETCAP_API_KEY', 'CMC_API_KEY']) || cmcSecret.value;
  if (cmcKey) {
    out.CMC_PRO_API_KEY = cmcKey;
    out.COINMARKETCAP_API_KEY = cmcKey;
  }

  const etherscanKey = readEnvValue(['ETHERSCAN_API_KEY']);
  if (etherscanKey) {
    out.ETHERSCAN_API_KEY = etherscanKey;
  }
  const etherscanKey2 = readEnvValue(['ETHERSCAN_API_KEY_2', 'ETHERSCAN_API_KEY2']);
  if (etherscanKey2) {
    out.ETHERSCAN_API_KEY_2 = etherscanKey2;
  }
  const etherscanKey3 = readEnvValue(['ETHERSCAN_API_KEY_3', 'ETHERSCAN_API_KEY3']);
  if (etherscanKey3) {
    out.ETHERSCAN_API_KEY_3 = etherscanKey3;
  }

  for (const name of [
    'WECRYPTO_BINANCE_WS_ENDPOINTS',
    'WECRYPTO_DISABLED_WS_PROVIDERS',
    'WECRYPTO_DISABLE_WS_BINANCE',
    'WECRYPTO_ENABLE_WS_BINANCE',
    'WECRYPTO_ENABLE_OPTIONAL_WS',
    'WECRYPTO_ENABLE_HAR_FAILING_WS',
  ]) {
    const value = readEnvValue([name]);
    if (value) out[name] = value;
  }

  // Pyth key for realtime feeds (Hermes, Lazer, snapshots) — newest secret files first
  const pythSecret = readPythLazerSecret();
  const pythKey = pythSecret.value || readEnvValue(['PYTH_NEW', 'PYTH_API', 'PYTH_NEW_API', 'LAZER_TOKEN']);
  if (pythKey) {
    out.PYTH_NEW = pythKey;
    out.PYTH_API = pythKey;
    out.PYTH_NEW_API = pythKey;
    out.PYTH_API_KEY = pythKey;
    out.PYTH_LAZER_TOKEN = pythKey;
    out.LAZER_TOKEN = pythKey;
  }

  return out;
}

const publicEnv = readPublicEnv();

function resolveRuntimeKey(name) {
  try {
    if (publicEnv && publicEnv[name]) return publicEnv[name];
  } catch (_) { }
  try {
    if (window.__env && window.__env[name]) return window.__env[name];
  } catch (_) { }
  return '';
}

function createWebSocketBridge(url, options = {}) {
  if (!ws) throw new Error('ws module unavailable in preload');
  const WebSocketCtor = ws.WebSocket || ws;
  const socket = new WebSocketCtor(url, {
    handshakeTimeout: options.handshakeTimeout,
    perMessageDeflate: options.perMessageDeflate,
    headers: options.headers,
  });

  const bufferedEvents = [];
  const handlers = {};

  const api = {
    url,
    readyState: socket.readyState,
    send: (data) => socket.send(data),
    ping: () => {
      api.readyState = socket.readyState;
      if (socket.readyState !== 1 || typeof socket.ping !== 'function') return false;
      socket.ping();
      return true;
    },
    close: (code, reason) => socket.close(code, reason),
    on: (eventName, callback) => {
      if (typeof callback !== 'function') return false;
      handlers[eventName] = handlers[eventName] || [];
      handlers[eventName].push(callback);

      // Replay buffered events
      const toReplay = bufferedEvents.filter(e => e.eventName === eventName);
      toReplay.forEach(e => {
        const idx = bufferedEvents.indexOf(e);
        if (idx !== -1) bufferedEvents.splice(idx, 1);
        callback(...e.args);
      });
      return true;
    },
    once: (eventName, callback) => {
      if (typeof callback !== 'function') return false;
      const onceCb = (...args) => {
        const idx = (handlers[eventName] || []).indexOf(onceCb);
        if (idx !== -1) handlers[eventName].splice(idx, 1);
        callback(...args);
      };
      handlers[eventName] = handlers[eventName] || [];
      handlers[eventName].push(onceCb);

      const toReplay = bufferedEvents.find(e => e.eventName === eventName);
      if (toReplay) {
        const idx = bufferedEvents.indexOf(toReplay);
        if (idx !== -1) bufferedEvents.splice(idx, 1);
        onceCb(...toReplay.args);
      }
      return true;
    },
  };

  const dispatch = (eventName, ...args) => {
    api.readyState = socket.readyState;
    if (handlers[eventName] && handlers[eventName].length > 0) {
      handlers[eventName].forEach(cb => cb(...args));
    } else {
      bufferedEvents.push({ eventName, args });
    }
  };

  socket.on('open', () => dispatch('open'));
  socket.on('message', (data) => dispatch('message', data?.toString?.() ?? String(data ?? '')));
  socket.on('pong', () => dispatch('pong'));
  socket.on('error', (err) => {
    err = err || {};
    dispatch('error', {
      message: err.message || String(err),
      code: err.code || null,
      statusCode: err.statusCode || null,
      statusMessage: err.statusMessage || null,
    });
  });
  socket.on('close', (code, reason) => dispatch('close', code, reason?.toString?.() ?? String(reason || '')));
  socket.on('unexpected-response', (req, res) => {
    res = res || {};
    dispatch('unexpected-response', null, {
      statusCode: res.statusCode || null,
      statusMessage: res.statusMessage || '',
    });
  });

  return api;
}


contextBridge.exposeInMainWorld('desktopApp', {
  isElectron: true,
  publicEnv,
  userEnv: {
    username: process.env.USERNAME || '',
    userProfile: process.env.USERPROFILE || '',
    localAppData: process.env.LOCALAPPDATA || '',
    appData: process.env.APPDATA || '',
  },
  // Expose optional Node modules when available in preload context.
  crypto: crypto,
  ws: ws,
  createWebSocket: createWebSocketBridge,
  hasNodeCrypto: !!crypto,
  hasNodeWs: !!ws,
  proxyPort: () => ipcRenderer.invoke('proxy:port'),
  getPublicEnv: () => ipcRenderer.invoke('env:getPublicConfig'),
  generateCoinbaseJWT: (opts) => ipcRenderer.invoke('coinbase:generate-jwt', opts || {}),
  // Returns all local drives (C-Z), UNC network shares, and cloud sync folders
  getDrives: () => ipcRenderer.invoke('storage:getDrives'),
  getGoogleDriveTargets: (options) => ipcRenderer.invoke('storage:getGoogleDriveTargets', options || {}),
  networkError: (type, details) => ipcRenderer.invoke('network:logError', type, details),
});

contextBridge.exposeInMainWorld('resolveRuntimeKey', resolveRuntimeKey);

contextBridge.exposeInMainWorld('electron', {
  invoke: ipcRenderer.invoke.bind(ipcRenderer),
  web: {
    updateState: (stateUpdate) => ipcRenderer.send('web:update-state', stateUpdate),
    broadcastUpdate: (type, data) => ipcRenderer.send('web:broadcast-update', { type, data }),
  },
  ipcFetch: (url, opts) => ipcRenderer.invoke('ipc:fetch', url, opts),
  // Raw-string file read (returns content or null) — used by cex-flow.js to pull
  // the Python cex_flow_monitor.py / cex_high_freq_monitor.py JSON state files.
  readFile: (filePath) => ipcRenderer.invoke('data:readFile', filePath)
    .then((r) => (r && r.ok) ? r.content : null)
    .catch(() => null),
  llm: {
    getDiagnostics: () => ipcRenderer.invoke('llm:getDiagnostics'),
    getQueryHistory: (limit) => ipcRenderer.invoke('llm:getQueryHistory', limit),
    envStatus: () => ipcRenderer.invoke('llm:envStatus'),
  },
  telegram: {
    status: () => ipcRenderer.invoke('telegram:status'),
    login: (apiId, apiHash) => ipcRenderer.invoke('telegram:login', { apiId, apiHash }),
    getChannelHistory: (channelName, limit) => ipcRenderer.invoke('telegram:get-channel-history', { channelName, limit }),
    sendMessage: (chat, text, parseMode) => ipcRenderer.invoke('telegram:send-message', { chat, text, parseMode }),
    onAuthRequest: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('telegram:auth-request', handler);
      return () => ipcRenderer.removeListener('telegram:auth-request', handler);
    },
    sendAuthResponse: (type, value) => ipcRenderer.send('telegram:auth-response', { type, value }),
    onMessage: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('telegram:message', handler);
      return () => ipcRenderer.removeListener('telegram:message', handler);
    }
  },
  sab: {
    onInit: (callback) => {
      ipcRenderer.on('sab:init', (event, payload) => {
        if (payload && payload.sab) {
          callback(payload.sab);
        }
      });
    }
  }
});

// Power-user bridge alias for context-isolated renderer integrations
contextBridge.exposeInMainWorld('wecryp', {
  onTelemetry: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('telemetry-update', (_event, value) => callback(value));
  },
  runInference: async (prompt, context) => {
    return await ipcRenderer.invoke('ai:run-inference', { prompt, context });
  },
  syncDrive: async (payload) => {
    return await ipcRenderer.invoke('drive:sync-backup', payload);
  },
  recoverDrive: async (options) => {
    return await ipcRenderer.invoke('drive:recover-backups', options || {});
  },
  cloudStatus: async () => {
    return await ipcRenderer.invoke('google:cloudStatus');
  },
  cloudSqlStatus: async (options) => {
    return await ipcRenderer.invoke('google:cloudSqlStatus', options || {});
  },
  testCloudSql: async () => {
    return await ipcRenderer.invoke('google:testCloudSql');
  },
  tideForecast: async (payload) => {
    return await ipcRenderer.invoke('google:tideForecast', payload);
  },
  firebaseStatus: async () => {
    return await ipcRenderer.invoke('firebase:status');
  },
  firebaseStartupCheck: async (options) => {
    return await ipcRenderer.invoke('firebase:startupCheck', options || {});
  },
  appendInference: async (record) => {
    return await ipcRenderer.invoke('firebase:appendInference', record || {});
  },
  getInferences: async (options) => {
    return await ipcRenderer.invoke('firebase:getInferences', options || {});
  },
  getSystemWeights: async () => {
    return await ipcRenderer.invoke('firebase:getSystemWeights');
  },
  updateSystemWeights: async (weights) => {
    return await ipcRenderer.invoke('firebase:updateSystemWeights', weights);
  },
});

// Orbital broadcaster bridge — renderer calls push(), main process relays to Firestore/RTDB.
contextBridge.exposeInMainWorld('_orbitalBroadcaster', {
  push: (orbitalResult) => {
    if (!orbitalResult) return;
    ipcRenderer.send('orbital:push', orbitalResult);
  },
  pushTick: (tick) => {
    if (!tick) return;
    ipcRenderer.send('orbital:pushTick', tick);
  },
  pushVertexExecution: (kind, data) => {
    ipcRenderer.send('orbital:pushVertex', { kind, data: data || {} });
  },
  getDiagnostics: () => ipcRenderer.invoke('orbital:broadcaster:diagnostics'),
  getOrbitalStatus: () => ipcRenderer.invoke('orbital:status'),
  restartOrbitalSystem: () => ipcRenderer.invoke('orbital:restart'),
  getSignal: (sym) => ipcRenderer.invoke('orbital:getSignal', sym),
  getLatestTick: (type, asset) => ipcRenderer.invoke('orbital:getLatestTick', { type, asset }),
  getRedisStatus: () => ipcRenderer.invoke('orbital:redisStatus'),
  // Real-time push: main process forwards every Redis-subscribed orbital
  // tick immediately (sub-second), no barrier/poll. Returns an unsubscribe fn.
  onRedisTick: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('orbital:redisTick', handler);
    return () => ipcRenderer.removeListener('orbital:redisTick', handler);
  },
});

// Warm tier for src/core/tiered-cache.js — plain Redis GET/SET/DEL.
contextBridge.exposeInMainWorld('_tieredCacheWarm', {
  get: (key) => ipcRenderer.invoke('tieredCache:warmGet', { key }),
  set: (key, value, ttlMs) => ipcRenderer.invoke('tieredCache:warmSet', { key, value, ttlMs }),
  del: (key) => ipcRenderer.invoke('tieredCache:warmDel', { key }),
});

// Grok memory bridge — session-memory ticks to Kafka, session snapshots +
// PTB-defense history to Firestore. Renderer side: src/llm/grok-analytics-memory.js.
contextBridge.exposeInMainWorld('_grokMemoryBridge', {
  pushTick: (coin, payload) => {
    if (!coin || !payload) return;
    ipcRenderer.send('grok:pushTick', { coin, payload });
  },
  pushPtbWindowClose: (record) => {
    if (!record) return;
    ipcRenderer.send('grok:pushPtbWindowClose', record);
  },
  writeSessionSnapshot: (coin, snapshot) => {
    if (!coin || !snapshot) return;
    ipcRenderer.send('grok:writeSessionSnapshot', { coin, snapshot });
  },
  getPtbDefenseStats: (coin, ptb, opts) => ipcRenderer.invoke('grok:getPtbDefenseStats', { coin, ptb, opts }),
  getSessionSnapshot: (coin) => ipcRenderer.invoke('grok:getSessionSnapshot', { coin }),
  getStatus: () => ipcRenderer.invoke('grok:bridgeStatus'),
});

contextBridge.exposeInMainWorld('dataStore', {
  appendLine: (filePath, line) => ipcRenderer.invoke('data:appendLine', filePath, line),
  appendLineDetailed: (filePath, line) => ipcRenderer.invoke('data:appendLineDetailed', filePath, line),
  writeFile: (filePath, content) => ipcRenderer.invoke('data:writeFile', filePath, content),
  writeFileDetailed: (filePath, content) => ipcRenderer.invoke('data:writeFileDetailed', filePath, content),
  syncFileIncremental: (request) => ipcRenderer.invoke('data:syncFileIncremental', request),
  ensureDir: (dirPath) => ipcRenderer.invoke('data:ensureDir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('data:readFile', filePath),
  listDir: (dirPath) => ipcRenderer.invoke('data:listDir', dirPath),
});

contextBridge.exposeInMainWorld('multiDrive', {
  initDirectories: (args) => ipcRenderer.send('multi-drive:init-directories', args),
  onInitComplete: (cb) => {
    ipcRenderer.on('multi-drive:init-complete', (_e, results) => cb(results));
  },
  writeSettlementLog: (args) => ipcRenderer.send('multi-drive:write-settlement-log', args),
  onWriteComplete: (cb) => {
    ipcRenderer.once('multi-drive:write-complete', (_e, results) => cb(results));
  },
  getAllLogs: (args) => ipcRenderer.invoke('multi-drive:get-all-logs', args),
  readLog: (args) => ipcRenderer.invoke('multi-drive:read-log', args),
  syncAllLogs: (args) => ipcRenderer.invoke('multi-drive:sync-all-logs', args),
});

contextBridge.exposeInMainWorld('auditAPI', {
  validator: {
    getStats: () => ipcRenderer.invoke('validator:getStats'),
    getAll: () => ipcRenderer.invoke('validator:getAll'),
    getCoin: (sym) => ipcRenderer.invoke('validator:getCoin', sym),
  }
});

contextBridge.exposeInMainWorld('pythLazer', {
  onTickers: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('pyth:tickers', handler);
    return () => ipcRenderer.removeListener('pyth:tickers', handler);
  },
  offTickers: () => ipcRenderer.removeAllListeners('pyth:tickers'),
  onStatus: (cb) => ipcRenderer.on('pyth:status', (_e, data) => cb(data)),
  onTimeout: (cb) => ipcRenderer.on('pyth:timeout-fallback', (_e, data) => cb(data)),
  onConnectionLost: (cb) => ipcRenderer.on('pyth:connection-lost', (_e, data) => cb(data)),
  onConnectionFailed: (cb) => ipcRenderer.on('pyth:connection-failed', (_e, data) => cb(data)),
  getCandles: (opts) => ipcRenderer.invoke('pyth:getCandles', opts),
  getProxyLatest: (feedIds) => ipcRenderer.invoke('pyth:getProxyLatest', feedIds),
  getLatestTickers: () => ipcRenderer.invoke('pyth:getLatestTickers'),
  getStatus: () => ipcRenderer.invoke('pyth:getStatus'),
});
