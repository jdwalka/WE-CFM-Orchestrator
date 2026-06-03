#!/usr/bin/env node
/**
 * WE-CRYPTO WebSocket Proxy Server
 * Bootstraps all connections through a local proxy to bypass geo-blocking
 * Supports: Hyperliquid, Bybit, Mempool, Pyth Network, CoinGecko
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
let PythLazerWebSocketHandler;
try {
  PythLazerWebSocketHandler = require('../feeds/pyth-lazer-websocket');
} catch (e) {
  console.warn(`[PythLazerWS] Optional handler unavailable: ${e.message}`);
  PythLazerWebSocketHandler = class {
    addClient(ws) { try { ws.close(1013, 'Pyth Lazer handler unavailable'); } catch (_) { } }
    removeClient() { }
    async connect() { throw new Error('Pyth Lazer handler unavailable'); }
    async disconnect() { }
  };
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

function readEnvValue(names) {
  for (const name of names) {
    const value = process.env?.[name];
    if (value != null && String(value).trim()) return stripEnvValue(value);
  }
  return '';
}

function coinbaseCredentialFromObject(obj, source) {
  if (!obj || typeof obj !== 'object') return null;
  const name = stripEnvValue(obj.name || obj.keyName || obj.key_name || obj.apiKeyName || obj.api_key_name);
  const privateKey = stripEnvValue(obj.privateKey || obj.private_key || obj.CDP_API_KEY_PRIVATE_KEY);
  if (privateKey && !/-----BEGIN (EC )?PRIVATE KEY-----/.test(privateKey)) return null;
  if (!name || !privateKey) return null;
  return { name, privateKey, source };
}

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

function getSecretDirCandidates() {
  return uniqueExistingPaths([
    path.join(process.cwd(), 'secrets'),
    path.join(__dirname, '../../secrets'),
    path.join(__dirname, '../../../secrets'),
    'G:\\WECRYP\\secrets',
    'g:\\WECRYP\\secrets',
    'F:\\WECRYP\\secrets',
  ]);
}

function isJwtLike(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || '').trim());
}

function decodeJwtPayload(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function coinbaseJwtFromValue(value, source, requiredUri = '') {
  const token = stripEnvValue(value);
  if (!isJwtLike(token)) return null;
  const payload = decodeJwtPayload(token) || {};
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && Number(payload.exp) <= now + 5) return null;
  if (requiredUri) {
    if (!payload.uri) return null;
    if (String(payload.uri).trim() !== requiredUri) return null;
  }
  return { token, source, exp: payload.exp || null, uri: payload.uri || '' };
}

function readCoinbaseJwtFromObject(obj, source, requiredUri = '') {
  if (!obj || typeof obj !== 'object') return null;
  const value = obj.jwt || obj.JWT || obj.token || obj.accessToken || obj.access_token || obj.COINBASE_JWT;
  return coinbaseJwtFromValue(value, source, requiredUri);
}

function loadCoinbaseStaticJwt(requiredUri = '') {
  const direct = coinbaseJwtFromValue(readEnvValue([
    'COINBASE_JWT',
    'COINBASE_CDP_JWT',
    'COINBASE_API_JWT',
    'CDP_JWT',
    'JWT',
  ]), 'env-jwt', requiredUri);
  if (direct) return direct;

  const filePath = readEnvValue([
    'COINBASE_JWT_FILE',
    'COINBASE_CDP_JWT_FILE',
    'COINBASE_API_JWT_FILE',
    'CDP_JWT_FILE',
  ]);
  if (filePath) {
    try {
      const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
      const fromFile = coinbaseJwtFromValue(raw, 'env-jwt-file', requiredUri)
        || readCoinbaseJwtFromObject(JSON.parse(raw), 'env-jwt-file-json', requiredUri);
      if (fromFile) return fromFile;
    } catch (_) { }
  }

  const jwtFileNames = [
    'COINBASE_JWT.txt',
    'COINBASE_CDP_JWT.txt',
    'COINBASE_API_JWT.txt',
    'CDP_JWT.txt',
    'coinbase-jwt.txt',
    'coinbase_jwt.txt',
  ];
  for (const dir of getSecretDirCandidates()) {
    for (const fileName of jwtFileNames) {
      try {
        const p = path.join(dir, fileName);
        if (!fs.existsSync(p)) continue;
        const raw = fs.readFileSync(p, 'utf8');
        const fromSecret = coinbaseJwtFromValue(raw, `secret-jwt:${p}`, requiredUri)
          || readCoinbaseJwtFromObject(JSON.parse(raw), `secret-jwt-json:${p}`, requiredUri);
        if (fromSecret) return fromSecret;
      } catch (_) { }
    }
  }
  return null;
}

function normalizeCoinbaseJwtUri(method, requestPath) {
  if (!method || !requestPath) return '';
  const verb = String(method).trim().toUpperCase();
  let target = String(requestPath).trim();
  try {
    if (/^https?:\/\//i.test(target)) {
      const u = new URL(target);
      target = `${u.hostname}${u.pathname}`;
    }
  } catch (_) {
    // keep original target
  }
  target = target.replace(/^\/+/, '');
  if (/^api\/v3\//i.test(target)) target = `api.coinbase.com/${target}`;
  if (!/^[a-z0-9.-]+\/api\/v3\//i.test(target)) target = `api.coinbase.com/${target}`;
  return `${verb} ${target}`;
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
    } catch (_) { }
  }

  const name = readEnvValue([
    'CDP_API_KEY_NAME',
    'COINBASE_CDP_API_KEY_NAME',
    'COINBASE_API_KEY_NAME',
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
      const credential = coinbaseCredentialFromObject(JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')), 'env-file');
      if (credential) return credential;
    } catch (_) { }
  }

  try {
    const envContent = fs.readFileSync(path.join(__dirname, '../../.env'), 'utf-8');
    const jsonMatch = envContent.match(/\{[\s\S]*?"privateKey"\s*:[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0].replace(/\\n/g, '\n'));
      const credential = coinbaseCredentialFromObject(parsed, '.env');
      if (credential) return credential;
    }
  } catch (_) { }

  const secretFileNames = [
    'cdp_api_key-WECRYPTO-ECDSA.json',
    'cdp_api_key-WECRYPTO-ECDSA.txt',
    'COINBASE_CDP_API_KEY.json',
    'COINBASE_CDP_API_KEY.txt',
    'COINBASE_API_KEY.json',
    'COINBASE_API_KEY.txt',
    'CDP_API_KEY.json',
    'CDP_API_KEY.txt',
  ];
  for (const dir of getSecretDirCandidates()) {
    for (const fileName of secretFileNames) {
      try {
        const p = path.join(dir, fileName);
        if (!fs.existsSync(p)) continue;
        const credential = coinbaseCredentialFromObject(JSON.parse(fs.readFileSync(p, 'utf8')), `secret-file:${p}`);
        if (credential) return credential;
      } catch (_) { }
    }
  }

  return null;
}

const coinbaseCredential = loadCoinbaseCredential();
let CDP_KEY_NAME = coinbaseCredential?.name || null;
let CDP_PRIVATE_KEY = coinbaseCredential?.privateKey || null;
if (CDP_KEY_NAME && CDP_PRIVATE_KEY) {
  console.log(`[Auth] Loaded Coinbase CDP credentials from ${coinbaseCredential.source}`);
} else {
  console.warn('[Auth] Could not load Coinbase CDP credentials');
}
const PORT = Number(process.env.WECRYPTO_WS_PROXY_PORT || process.env.WS_PROXY_PORT || 3011);
const WSS_PORT = 3012;

// Initialize Pyth Lazer WebSocket handler (official SDK)
const pythHandler = new PythLazerWebSocketHandler();

// Log with timestamp
function log(msg, type = 'INFO') {
  const ts = new Date().toISOString().split('T')[1];
  console.log(`[${ts}] [${type}] ${msg}`);
}

// Upstream WebSocket endpoints (with geo-bypass)
const UPSTREAM = {
  'hyperliquid': 'wss://api.hyperliquid.xyz/ws',
  'bybit': 'wss://stream.bybit.com/v5/public/spot',
  'mempool': 'wss://mempool.space/api/v1/blocksBitcoin',
  'pyth': 'POLLER', // Special marker - uses HTTP polling instead of WebSocket
  'pyth-lazer': 'POLLER', // Special marker - uses HTTP polling
  'coingecko': 'wss://stream.coingecko.com/v1/stream'
};

const DEFAULT_DISABLED_PRECONNECT = new Set(['mempool', 'coingecko', 'pyth']);

function envFlag(name) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function shouldPreconnect(service) {
  const suffix = String(service || '').replace(/[^a-z0-9]/gi, '_').toUpperCase();
  if (envFlag(`WECRYPTO_PROXY_ENABLE_${suffix}`)) return true;
  if (envFlag(`WECRYPTO_PROXY_DISABLE_${suffix}`)) return false;
  return !DEFAULT_DISABLED_PRECONNECT.has(service);
}

// Store upstream connections
const upstreamConnections = new Map();
const clientConnections = new Map();

class ProxyManager {
  constructor() {
    this.reconnectAttempts = new Map();
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
  }

  // Connect to upstream service
  connectUpstream(service) {
    if (upstreamConnections.has(service)) {
      return upstreamConnections.get(service);
    }

    log(`Connecting to upstream: ${service}`, 'CONNECT');

    return new Promise((resolve, reject) => {
      const url = UPSTREAM[service];
      if (!url) {
        return reject(new Error(`Unknown service: ${service}`));
      }

      // Special handling for Pyth Lazer (Official SDK WebSocket)
      if (url === 'POLLER') {
        log(`Initializing Pyth Lazer WebSocket Handler (official SDK)...`, 'INFO');
        
        // Create a mock WebSocket-like object for consistency
        const pythProxy = {
          readyState: WebSocket.OPEN,
          on: () => {},
          terminate: async () => {
            await pythHandler.disconnect();
          }
        };
        
        // Connect to Pyth Lazer (will throw if failed)
        pythHandler.connect().then(() => {
          log(`✅ Connected to ${service} (WebSocket Pool)`, 'UPSTREAM');
        }).catch(err => {
          log(`Failed to connect Pyth: ${err.message}`, 'ERROR');
        });
        
        upstreamConnections.set(service, pythProxy);
        this.reconnectAttempts.delete(service);
        
        return resolve();
      }

      // Standard WebSocket handling for other services
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'Upgrade',
        'Upgrade': 'websocket'
      };

      const ws = new WebSocket(url, {
        headers,
        rejectUnauthorized: false
      });

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Connection timeout for ${service}`));
      }, 20000);

      ws.on('open', () => {
        clearTimeout(timeout);
        log(`✅ Connected to ${service}`, 'UPSTREAM');
        
        // Store connection
        upstreamConnections.set(service, ws);
        this.reconnectAttempts.delete(service);

        // Handle messages from upstream
        ws.on('message', (data) => {
          // Relay to all connected clients for this service
          if (clientConnections.has(service)) {
            clientConnections.get(service).forEach(clientWs => {
              if (clientWs.readyState === WebSocket.OPEN) {
                try {
                  clientWs.send(data);
                } catch (e) {
                  log(`Error sending to client: ${e.message}`, 'ERROR');
                }
              }
            });
          }
        });

        ws.on('error', (err) => {
          log(`Upstream error (${service}): ${err.message}`, 'ERROR');
        });

        ws.on('close', () => {
          log(`Upstream closed (${service}), reconnecting...`, 'WARN');
          upstreamConnections.delete(service);
          const attempts = (this.reconnectAttempts.get(service) || 0) + 1;
          if (attempts <= this.maxReconnectAttempts) {
            this.reconnectAttempts.set(service, attempts);
            setTimeout(() => this.connectUpstream(service), this.reconnectDelay * attempts);
          }
        });

        resolve(ws);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        log(`Failed to connect to ${service}: ${err.message}`, 'ERROR');
        reject(err);
      });
    });
  }

  // Handle client connection
  handleClientConnection(ws, service) {
    if (!clientConnections.has(service)) {
      clientConnections.set(service, new Set());
    }
    clientConnections.get(service).add(ws);

    log(`Client connected to ${service} (${clientConnections.get(service).size} clients)`, 'CLIENT');

    // Special handling for Pyth services - register with handler
    if (service === 'pyth' || service === 'pyth-lazer') {
      pythHandler.addClient(ws);
    }

    // Ensure upstream is connected
    if (!upstreamConnections.has(service)) {
      this.connectUpstream(service).catch(err => {
        log(`Failed to connect upstream for ${service}: ${err.message}`, 'ERROR');
        ws.close(1011, `Failed to connect to ${service}`);
      });
    }

    ws.on('message', (data) => {
      // Pyth services don't accept client messages (WebSocket streaming only)
      if (service !== 'pyth' && service !== 'pyth-lazer') {
        const upstream = upstreamConnections.get(service);
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          try {
            upstream.send(data);
          } catch (e) {
            log(`Error relaying to upstream: ${e.message}`, 'ERROR');
          }
        }
      }
    });

    ws.on('error', (err) => {
      log(`Client error (${service}): ${err.message}`, 'ERROR');
    });

    ws.on('close', () => {
      // Deregister from handler if Pyth
      if (service === 'pyth' || service === 'pyth-lazer') {
        pythHandler.removeClient(ws);
      }
      
      const clients = clientConnections.get(service);
      if (clients) {
        clients.delete(ws);
        log(`Client disconnected from ${service} (${clients.size} remaining)`, 'CLIENT');
      }
    });
  }
}

// Initialize proxy
const proxy = new ProxyManager();

// Create HTTP server (for upgrading to WebSocket)
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // Cross-Origin configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/jwt/coinbase') {
    try {
      const requestMethod = url.searchParams.get('method') || null;
      const requestPath = url.searchParams.get('path') || null;

      const algorithm = 'ES256';
      const uri = normalizeCoinbaseJwtUri(requestMethod, requestPath);

      if (!CDP_KEY_NAME || !CDP_PRIVATE_KEY) {
        const staticJwt = loadCoinbaseStaticJwt(uri);
        if (staticJwt) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            token: staticJwt.token,
            source: staticJwt.source,
            static: true,
            exp: staticJwt.exp,
            uri: staticJwt.uri || uri,
          }));
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Coinbase ECDSA credentials not configured in .env or secrets directory' }));
      }
      
      const payload = {
        iss: 'cdp',
        nbf: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        sub: CDP_KEY_NAME,
      };

      if (uri) {
        payload.uri = uri;
      }

      const token = jwt.sign(payload, CDP_PRIVATE_KEY, {
        algorithm,
        header: { kid: CDP_KEY_NAME, nonce: crypto.randomBytes(16).toString('hex'), typ: 'JWT' }
      });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token, source: coinbaseCredential?.source || 'unknown', uri }));
    } catch (e) {
      console.error('[Auth] Error generating JWT:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Failed to generate JWT' }));
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'WE-CRYPTO WebSocket Proxy',
    version: '1.0.0',
    uptime: process.uptime(),
    services: Array.from(upstreamConnections.keys()),
    clients: Array.from(clientConnections.entries()).map(([service, clients]) => ({
      service,
      count: clients.size
    }))
  }));
});

// WebSocket server for clients
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const service = url.searchParams.get('service') || url.pathname.replace('/', '');

  if (!UPSTREAM[service]) {
    log(`Invalid service requested: ${service}`, 'WARN');
    ws.close(1008, `Unknown service: ${service}`);
    return;
  }

  proxy.handleClientConnection(ws, service);
});

// Start listening with Port Cascading (3030 - 3035)
let currentPort = PORT;
const maxPort = PORT + 10;

function startServer(port) {
  server.listen(port, () => {
    log(`🟢 WE-CRYPTO WebSocket Proxy running`, 'STARTUP');
    log(`   HTTP Endpoint: http://localhost:${port}`, 'INFO');
    log(`   WebSocket: ws://localhost:${port}?service=<service>`, 'INFO');
    log(`   Available services: ${Object.keys(UPSTREAM).join(', ')}`, 'INFO');
    console.log();
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`Port ${currentPort} is in use, trying next port...`, 'WARN');
    currentPort++;
    if (currentPort <= maxPort) {
      setTimeout(() => startServer(currentPort), 100);
    } else {
      log(`Could not find an open port between ${PORT} and ${maxPort}`, 'ERROR');
      process.exit(1);
    }
  } else {
    log(`Server error: ${e.message}`, 'ERROR');
  }
});

startServer(currentPort);

// Pre-connect only to healthy default upstreams. Stale/credentialed optional
// services stay available for explicit client requests or env opt-in.
Object.keys(UPSTREAM).filter(shouldPreconnect).forEach(service => {
  setTimeout(() => {
    proxy.connectUpstream(service).catch(err => {
      log(`Initial connection to ${service} failed: ${err.message}`, 'WARN');
    });
  }, 1000);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...', 'INFO');
  
  // Close all connections
  upstreamConnections.forEach((ws, service) => {
    log(`Closing upstream: ${service}`, 'INFO');
    ws.close(1000, 'Server shutdown');
  });
  
  clientConnections.forEach((clients, service) => {
    clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Server shutdown');
      }
    });
  });

  server.close(() => {
    log('Server closed', 'INFO');
    process.exit(0);
  });

  setTimeout(() => {
    log('Force exit', 'WARN');
    process.exit(1);
  }, 5000);
});

// Error handling
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`, 'ERROR');
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`Unhandled rejection: ${reason}`, 'ERROR');
});
