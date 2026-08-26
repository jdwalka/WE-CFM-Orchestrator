'use strict';
/**
 * Standalone Proxy Runner Daemon
 * Manages port 18090 (Mullvad SOCKS5) and port 3010 (Local HTTP Bouncer)
 */
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');

const SOCKS_PORT = Number(process.env.MULLVAD_SOCKS_PORT || 18090);
const HTTP_PORT = Number(process.env.WECRYPTO_PROXY_PORT || 3010);
const TUNNEL_LOCAL_ADDR = process.env.MULLVAD_TUNNEL_LOCAL_ADDR || '10.65.50.149';

// 1. SOCKS5 Server for Binance & Bybit
const socksScript = path.join(__dirname, 'mullvad-standalone-socks.js');
let socksProc = null;
// 1. Start SOCKS5 Proxy Server (18090)
const socksScript = path.join(__dirname, 'mullvad-standalone-socks.js');
let socksProc = null;

function startSocks() {
  try {
    socksProc = spawn(process.execPath, [socksScript], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, MULLVAD_SOCKS_PORT: String(SOCKS_PORT), MULLVAD_TUNNEL_LOCAL_ADDR: TUNNEL_LOCAL_ADDR, ELECTRON_RUN_AS_NODE: '1' }
    });
    socksProc.on('error', (err) => {
      console.warn('[ProxyRunner] SOCKS spawn error (non-fatal):', err.message);
      socksProc = null;
    });
    socksProc.on('exit', () => setTimeout(startSocks, 2000));
  } catch (err) {
    console.warn('[ProxyRunner] Failed to start SOCKS:', err.message);
    socksProc = null;
  }
}
startSocks();

// 2. Light Socket Agent (8 sockets max)
const socksAgent = new SocksProxyAgent(`socks5://127.0.0.1:${SOCKS_PORT}`, {
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 8,
});

// 3. 2.5s Micro-Cache & In-Flight Coalescing
const cache = new Map();
const inFlight = new Map();
const TTL_MS = 2500;

const PREFIX_MAP = {
  'binance': 'https://api.binance.com',
  'binance-f': 'https://fapi.binance.com',
  'binance-us': 'https://api.binance.us',
  'binance-data': 'https://data-api.binance.vision',
  'coinbase': 'https://api.coinbase.com',
  'coinbase-ex': 'https://api.exchange.coinbase.com',
  'kraken': 'https://api.kraken.com',
  'gemini': 'https://api.gemini.com',
  'bitstamp': 'https://www.bitstamp.net',
  'bybit': 'https://api.bybit.com',
  'bytick': 'https://api.bytick.com',
  'okx': 'https://www.okx.com',
  'crypto-com': 'https://api.crypto.com',
  'crypto': 'https://api.crypto.com',
  'polymarket': 'https://gamma-api.polymarket.com',
  'polymarket-clob': 'https://clob.polymarket.com',
  'polymarket-data': 'https://data-api.polymarket.com',
  'polymarket-perps': 'https://api.perpetuals.polymarket.com',
  'mempool': 'https://mempool.space',
  'etherscan': 'https://api.etherscan.io',
  'bscscan': 'https://api.bscscan.com',
  'polygonscan': 'https://api.polygonscan.com',
  'solana': 'https://api.mainnet-beta.solana.com',
  'dexscreener': 'https://api.dexscreener.com',
  'coingecko': 'https://api.coingecko.com',
  'coingecko-pro': 'https://pro-api.coingecko.com',
  'kucoin': 'https://api.kucoin.com',
  'mexc': 'https://api.mexc.com',
  'bitfinex': 'https://api-pub.bitfinex.com',
  'hyperliquid': 'https://api.hyperliquid.xyz',
  'deribit': 'https://www.deribit.com',
  'bitvavo': 'https://api.bitvavo.com',
};

const writeCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
};

  socksProc.on('exit', (code) => {
    console.warn(`[proxy-runner] SOCKS5 process exited with code ${code}. Restarting in 1s...`);
    setTimeout(startSocks, 1000);
  });
}

startSocks();

// 2. Start HTTP Bouncer Server (3010)
const socksAgent = new SocksProxyAgent(`socks5://127.0.0.1:${SOCKS_PORT}`, {
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 64,
});

const proxyMicroCache = new Map();
const PROXY_CACHE_TTL_MS = 600;
const responseHeadersToStrip = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding']);

const readBody = (req) => new Promise(resolve => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', () => resolve(Buffer.alloc(0)));
});

function isSocksTarget(target) {
  const t = String(target).toLowerCase();
  return t.includes('binance') || t.includes('bybit') || t.includes('okx') || 
         t.includes('kucoin') || t.includes('mexc') || t.includes('bitfinex') || 
         t.includes('hyperliquid') || t.includes('deribit') || t.includes('bitvavo') ||
         t.includes('bitstamp') || t.includes('gate');
}
const writeCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');
};

const forward = async (targetUrl, req, res) => {
  const method = String(req.method || 'GET').toUpperCase();
  const isGet = method === 'GET' || method === 'HEAD';

  // 1. Cache HIT check for GET
  if (isGet) {
    const now = Date.now();
    const cached = cache.get(targetUrl);
    if (cached && (now - cached.ts) < TTL_MS) {
      res.statusCode = 200;
      res.setHeader('Content-Type', cached.contentType || 'application/json');
      res.setHeader('X-Cache', 'HIT');
      return res.end(cached.body);
    }

    if (inFlight.has(targetUrl)) {
      inFlight.get(targetUrl).then(data => {
        res.statusCode = data.statusCode;
        res.setHeader('Content-Type', data.contentType || 'application/json');
        res.setHeader('X-Cache', 'IN-FLIGHT');
        res.end(data.body);
      }).catch(() => {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: 'upstream-failed' }));
      });
      return;
    }
  }

  const parsed = new URL(targetUrl);
  const useSocks = isSocksTarget(targetUrl);
  const transport = parsed.protocol === 'https:' ? https : http;

  const outgoingHeaders = {
    'host': parsed.hostname,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'accept': req.headers['accept'] || '*/*',
    'accept-language': 'en-US,en;q=0.9',
  };
  if (req.headers['content-type']) outgoingHeaders['content-type'] = req.headers['content-type'];
  if (req.headers['authorization']) outgoingHeaders['authorization'] = req.headers['authorization'];
  if (req.headers['x-mbx-apikey']) outgoingHeaders['x-mbx-apikey'] = req.headers['x-mbx-apikey'];
  if (req.headers['x-api-key']) outgoingHeaders['x-api-key'] = req.headers['x-api-key'];

  if (isGet) {
    const promise = new Promise((resolve, reject) => {
      const outReq = transport.request({
        host: parsed.hostname,
        hostname: parsed.hostname,
        servername: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        agent: useSocks ? socksAgent : undefined,
        headers: outgoingHeaders,
        timeout: 8000
      }, (upRes) => {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          const body = Buffer.concat(chunks);
          const contentType = upRes.headers['content-type'] || 'application/json';
          if (upRes.statusCode === 200) {
            cache.set(targetUrl, { body, contentType, ts: Date.now() });
          }
          resolve({ statusCode: upRes.statusCode, contentType, body });
        });
      });
      outReq.on('error', reject);
      outReq.on('timeout', () => outReq.destroy(new Error('upstream-timeout')));
      outReq.end();
    }).finally(() => {
      inFlight.delete(targetUrl);
    });

    inFlight.set(targetUrl, promise);

    promise.then(data => {
      res.statusCode = data.statusCode;
      res.setHeader('Content-Type', data.contentType);
      res.end(data.body);
    }).catch(err => {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'upstream-failed', message: err?.message || 'unknown' }));
    });
    return;
  }

  // Handle POST / PUT / DELETE
  const body = await readBody(req);
  if (body && body.length) outgoingHeaders['content-length'] = body.length;

  try {
    const outReq = transport.request({
      host: parsed.hostname,
      hostname: parsed.hostname,
      servername: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      agent: useSocks ? socksAgent : undefined,
      headers: outgoingHeaders,
      timeout: 10000
    }, (upRes) => {
      res.statusCode = upRes.statusCode;
      if (upRes.headers['content-type']) res.setHeader('Content-Type', upRes.headers['content-type']);
      upRes.pipe(res);
    });

    outReq.on('error', (err) => {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'upstream-failed', message: err?.message || 'unknown' }));
    });

    if (body && body.length > 0) outReq.write(body);
    outReq.end();
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'upstream-failed', message: err?.message || 'unknown' }));
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
      agent: socksAgent,
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
      });
    });

    outgoingReq.on('timeout', () => {
      outgoingReq.destroy(new Error('upstream timeout'));
    });
    outgoingReq.on('error', (e) => {
      writeCors(res);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'proxy-forward-failed', message: e?.message || 'unknown error' }));
    });

    if (body && body.length > 0) outgoingReq.write(body);
    outgoingReq.end();
  } catch (e) {
    writeCors(res);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'proxy-forward-failed', message: e?.message || 'unknown error' }));
  }
};

const server = http.createServer(async (req, res) => {
  writeCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const u = new URL(req.url || '/', `http://127.0.0.1:${HTTP_PORT}`);
  const p = u.pathname;

  if (p === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('OK');
  }

  if (p === '/port') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ port: HTTP_PORT }));
  }
  if (p === '/proxy') {
    const target = u.searchParams.get('url');
    if (!target) {
      res.statusCode = 400;
      return res.end('Missing ?url=');
    }
    return forward(target, req, res);
  }

  const parts = p.replace(/^\//, '').split('/');
  const prefix = parts.shift();
  const rest = parts.join('/');

  const PREFIX_MAP = {
    'binance': 'https://api.binance.com',
    'binance-us': 'https://api.binance.us',
    'binance-data': 'https://data-api.binance.vision',
    'binance-f': 'https://fapi.binance.com',
    'coingecko': 'https://api.coingecko.com',
    'coingecko-pro': 'https://pro-api.coingecko.com',
    'coinbase': 'https://api.coinbase.com',
    'coinbase-ex': 'https://api.exchange.coinbase.com',
    'kraken': 'https://api.kraken.com',
    'bybit': 'https://api.bybit.com',
    'okx': 'https://www.okx.com',
    'polymarket': 'https://gamma-api.polymarket.com',
    'polymarket-clob': 'https://clob.polymarket.com',
    'polymarket-data': 'https://data-api.polymarket.com',
    'polymarket-perps': 'https://api.perpetuals.polymarket.com',
    'bitfinex': 'https://api-pub.bitfinex.com',
    'kucoin': 'https://api.kucoin.com',
    'mexc': 'https://api.mexc.com',
    'hypurrscan': 'https://hypurrscan.io',
    'dexscreener': 'https://api.dexscreener.com',
    'mempool': 'https://mempool.space',
    'blockchair': 'https://api.blockchair.com',
    'etherscan': 'https://api.etherscan.io',
    'bscscan': 'https://api.bscscan.com',
    'hyperliquid': 'https://api.hyperliquid.xyz',
    'bitstamp': 'https://www.bitstamp.net',
  };

  const base = PREFIX_MAP[prefix];
  if (!base) {
    res.statusCode = 404;
    return res.end(`Unknown proxy prefix: ${prefix}`);
  }

  const targetUrl = `${base}/${rest}${u.search}`;
  return forward(targetUrl, req, res);
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[proxy-runner] Full Tier-1 Proxy Live on http://127.0.0.1:${HTTP_PORT}`);
  console.log(`[proxy-runner] HTTP bouncer live on http://127.0.0.1:${HTTP_PORT} -> SOCKS5 :${SOCKS_PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[proxy-runner] HTTP bouncer port ${HTTP_PORT} already in use; reusing existing listener.`);
  } else {
    console.error('[proxy-runner]', err.message);
  }
});
