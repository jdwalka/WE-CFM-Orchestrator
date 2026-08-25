'use strict';
const http = require('http');
const https = require('https');
const { SocksClient } = require('socks');

const HTTP_PORT = 3010;
const SOCKS5_PROXY = { host: '127.0.0.1', port: 18091, type: 5 };

const EXCHANGE_HOSTS = {
  'binance': 'api.binance.com',
  'binance-us': 'api.binance.us',
  'binance-f': 'fapi.binance.com',
  'binance-d': 'dapi.binance.com',
  'coingecko': 'api.coingecko.com',
  'coingecko-pro': 'pro-api.coingecko.com',
  'kraken': 'api.kraken.com',
  'bybit': 'api.bybit.com',
  'okx': 'api.okx.com',
  'kucoin': 'api.kucoin.com',
  'mexc': 'api.mexc.com',
  'bitfinex': 'api-pub.bitfinex.com',
  'dexscreener': 'api.dexscreener.com',
  'blockchair': 'api.blockchair.com',
  'etherscan': 'api.etherscan.io',
  'bscscan': 'api.bscscan.com',
  'hyperliquid': 'api.hyperliquid.xyz',
  'crypto-com': 'api.crypto.com',
  'upbit': 'api.upbit.com',
  'bitget': 'api.bitget.com',
  'bingx': 'open-api.bingx.com',
  'gemini': 'api.gemini.com',
  'bitstamp': 'api.bitstamp.net',
  'bitso': 'api.bitso.com',
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url.startsWith('/health?')) {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  const pathParts = req.url.split('/').filter(Boolean);
  if (pathParts.length === 0) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const exchange = pathParts[0];
  const host = EXCHANGE_HOSTS[exchange];

  if (!host) {
    console.error('[http-socks5-bridge] unknown exchange: ' + exchange);
    res.writeHead(404);
    res.end('Unknown exchange');
    return;
  }

  const path = '/' + pathParts.slice(1).join('/') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');

  try {
    const info = await SocksClient.createConnection({
      proxy: SOCKS5_PROXY,
      command: 'connect',
      destination: { host, port: 443 },
    });

    const socket = info.socket;

    const upstreamReq = https.request(
      { host, port: 443, path, method: req.method, headers: req.headers, createConnection: () => socket },
      (upstreamRes) => { res.writeHead(upstreamRes.statusCode, upstreamRes.headers); upstreamRes.pipe(res); }
    );

    upstreamReq.on('error', (err) => {
      console.error('[http-socks5-bridge] ' + exchange + ' error: ' + err.message);
      res.writeHead(502);
      res.end('Bad Gateway');
    });

    req.pipe(upstreamReq);
  } catch (err) {
    console.error('[http-socks5-bridge] connection error: ' + err.message);
    res.writeHead(502);
    res.end('Bad Gateway');
  }
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log('[http-socks5-bridge] listening on 127.0.0.1:' + HTTP_PORT + ' -> SOCKS5 127.0.0.1:18091');
});

server.on('error', (err) => {
  console.error('[http-socks5-bridge] ' + err.message);
  process.exit(1);
});
