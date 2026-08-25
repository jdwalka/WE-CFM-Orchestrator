'use strict';
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
function startSocks() {
  socksProc = spawn(process.execPath, [socksScript], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, MULLVAD_SOCKS_PORT: String(SOCKS_PORT), MULLVAD_TUNNEL_LOCAL_ADDR: TUNNEL_LOCAL_ADDR }
  });
  socksProc.on('exit', () => setTimeout(startSocks, 1000));
}
startSocks();

// 2. Light Socket Agent (8 sockets max)
const socksAgent = new SocksProxyAgent(`socks5://127.0.0.1:${SOCKS_PORT}`, {
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 8,
});

// 3. 2.5s Micro-Cache
const cache = new Map();
const inFlight = new Map();
const TTL_MS = 2500;

const writeCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
};

const server = http.createServer((req, res) => {
  writeCors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const u = new URL(req.url || '/', `http://127.0.0.1:${HTTP_PORT}`);
  if (u.pathname === '/health') { res.statusCode = 200; return res.end('OK'); }

  let target = null;
  if (u.pathname.startsWith('/binance-f/')) {
    target = `https://fapi.binance.com/${u.pathname.replace(/^\/binance-f\//, '')}${u.search}`;
  } else if (u.pathname.startsWith('/binance/')) {
    target = `https://api.binance.com/${u.pathname.replace(/^\/binance\//, '')}${u.search}`;
  } else if (u.pathname.startsWith('/bybit/')) {
    target = `https://api.bybit.com/${u.pathname.replace(/^\/bybit\//, '')}${u.search}`;
  } else if (u.pathname.startsWith('/okx/')) {
    target = `https://www.okx.com/${u.pathname.replace(/^\/okx\//, '')}${u.search}`;
  } else {
    res.statusCode = 404;
    return res.end('Not Routed');
  }

  const now = Date.now();
  const cached = cache.get(target);
  if (cached && (now - cached.ts) < TTL_MS) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'HIT');
    return res.end(cached.body);
  }

  if (inFlight.has(target)) {
    inFlight.get(target).then(data => {
      res.statusCode = data.statusCode;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Cache', 'IN-FLIGHT');
      res.end(data.body);
    }).catch(() => {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'upstream-failed' }));
    });
    return;
  }

  const parsed = new URL(target);
  const promise = new Promise((resolve, reject) => {
    const outReq = https.request({
      host: parsed.hostname,
      hostname: parsed.hostname,
      servername: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      agent: socksAgent,
      headers: { 'host': parsed.hostname, 'user-agent': 'Mozilla/5.0', 'accept': '*/*' },
      timeout: 6000
    }, (upRes) => {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const body = Buffer.concat(chunks);
        if (upRes.statusCode === 200) {
          cache.set(target, { body, ts: Date.now() });
        }
        resolve({ statusCode: upRes.statusCode, body });
      });
    });
    outReq.on('error', reject);
    outReq.end();
  }).finally(() => {
    inFlight.delete(target);
  });

  inFlight.set(target, promise);

  promise.then(data => {
    res.statusCode = data.statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(data.body);
  }).catch(() => {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'upstream-failed' }));
  });
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[proxy-runner] Lean Tier-1 Proxy Live on http://127.0.0.1:${HTTP_PORT}`);
});
