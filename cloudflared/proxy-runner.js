'use strict';
/**
 * Standalone Proxy Runner Daemon
 * Manages port 18090 (Mullvad SOCKS5) and port 3010 (Local HTTP Bouncer)
 */
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');

const SOCKS_PORT = Number(process.env.MULLVAD_SOCKS_PORT || 18090);
const HTTP_PORT = Number(process.env.WECRYPTO_PROXY_PORT || 3010);
const TUNNEL_LOCAL_ADDR = process.env.MULLVAD_TUNNEL_LOCAL_ADDR || '';

// 1. Start SOCKS5 Proxy Server (18090) if not already listening
const socksScript = path.join(__dirname, 'mullvad-standalone-socks.js');
let socksProc = null;

function startSocks() {
  const probe = net.connect({ port: SOCKS_PORT, host: '127.0.0.1', timeout: 500 }, () => {
    probe.destroy();
    console.log(`[ProxyRunner] SOCKS5 port ${SOCKS_PORT} is already active. Reusing existing tunnel bridge.`);
  });
  probe.on('error', () => {
    probe.destroy();
    try {
      socksProc = spawn(process.execPath, [socksScript], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, MULLVAD_SOCKS_PORT: String(SOCKS_PORT), MULLVAD_TUNNEL_LOCAL_ADDR: TUNNEL_LOCAL_ADDR, ELECTRON_RUN_AS_NODE: '1' }
      });
      socksProc.on('error', (err) => {
        console.warn('[ProxyRunner] SOCKS spawn error (non-fatal):', err.message);
        socksProc = null;
      });
      socksProc.on('exit', (code) => {
        socksProc = null;
        setTimeout(startSocks, 3000);
      });
    } catch (err) {
      console.warn('[ProxyRunner] Failed to start SOCKS:', err.message);
      socksProc = null;
    }
  });
}
startSocks();

// 2. Light Socket Agent
const socksAgent = new SocksProxyAgent(`socks5://127.0.0.1:${SOCKS_PORT}`, {
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 64,
});

const proxyMicroCache = new Map();
const PROXY_CACHE_TTL_MS = 600;
const responseHeadersToStrip = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding'
]);

const readBody = (req) => new Promise(resolve => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', () => resolve(Buffer.alloc(0)));
});

function isSocksTarget(target) {
  const t = String(target).toLowerCase();
  return t.includes('binance') || t.includes('bybit') || t.includes('okx') || 
         t.includes('mexc') || t.includes('hyperliquid') || t.includes('deribit');
}

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
        timeout: 10000,
      }, (upstreamRes) => {
        res.statusCode = upstreamRes.statusCode;
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (!responseHeadersToStrip.has(String(k).toLowerCase())) res.setHeader(k, v);
        }
        writeCors(res);
        const chunks = [];

        // If the upstream response emits an error after headers/partial body,
        // ensure the client response is closed and the request promise rejects
        upstreamRes.on('error', (err) => {
          console.warn(`[ProxyRunner] upstream response error for ${targetUrl}: ${err.message}`);
          try {
            if (!res.headersSent) {
              writeCors(res);
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'upstream-response-error', message: err.message }));
            } else {
              // If headers already sent, destroy the socket to terminate the stream
              try { res.destroy(); } catch (_) { }
            }
          } catch (_) { }
          reject(err);
        });

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
    const shouldTrySocks = isSocksTarget(targetUrl);
    if (shouldTrySocks) {
      try {
        await makeRequest(true);
        return;
      } catch (socksErr) {
        console.warn(`[ProxyRunner] SOCKS forward failed for ${targetUrl} (${socksErr.message}), falling back to direct connection`);
        // If we've already begun returning data to the client, close the
        // client connection instead of silently returning and leaving it open.
        if (res.headersSent) {
          try { res.destroy(); } catch (_) { }
          return;
        }
        // Only replay request body on idempotent methods (safe retry policy).
        if (!['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'].includes(method)) throw socksErr;
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
    'binance-d': 'https://dapi.binance.com',
    'binance-us': 'https://api.binance.us',
    'binance-data': 'https://data-api.binance.vision',
    'binance-f': 'https://fapi.binance.com',
    'coingecko': 'https://api.coingecko.com',
    'coingecko-pro': 'https://pro-api.coingecko.com',
    'coinbase': 'https://api.coinbase.com',
    'coinbase-ex': 'https://api.exchange.coinbase.com',
    'crypto-com': 'https://api.crypto.com',
    'kraken': 'https://api.kraken.com',
    'bybit': 'https://api.bybit.com',
    'okx': 'https://www.okx.com',
    'polymarket': 'https://gamma-api.polymarket.com',
    'polymarket-clob': 'https://clob.polymarket.com',
    'polymarket-data': 'https://data-api.polymarket.com',
    'polymarket-perps': 'https://api.perpetuals.polymarket.com',
    'gemini': 'https://api.gemini.com',
    'solana': 'https://api.mainnet-beta.solana.com',
    'solana-rpc': 'https://solana-rpc.publicnode.com',
    'xrpl': 'https://xrplcluster.com',
    'ripple': 'https://s2.ripple.com',
    'publicnode': 'https://ethereum.publicnode.com',
    'cloudflare-eth': 'https://cloudflare-eth.com',
    'alchemy': 'https://eth-mainnet.g.alchemy.com',
    'blockscout-eth': 'https://eth.blockscout.com',
    'blockscout-bsc': 'https://bsc.blockscout.com',
    'blockcypher': 'https://api.blockcypher.com',
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
