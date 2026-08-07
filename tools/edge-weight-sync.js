/**
 * edge-weight-sync.js
 *
 * Pulls model weight snapshots and Sig_prob floats from the brain
 * (G:\WECRYP host, exposed at 10.10.0.1:3443 over WireGuard) and writes
 * them into the edge Redis sidecar. This is the only inbound traffic
 * the edge accepts: one-way pull, no port forwarded, no state pushed
 * back to the brain.
 *
 * Why a dedicated poll loop instead of a websocket: the wire is one-way,
 * the payload is small (a weights blob every few seconds, a Sig_prob
 * float per orbital per tick), and a simple retrying GET keeps the
 * edge daemon trivially recoverable after a WireGuard bounce.
 *
 * Expected brain endpoints:
 *   GET /api/edge/weights       -> { version, weights_b64, ts }
 *   GET /api/edge/sig-prob      -> { sig_prob: { BTC, ETH, SOL, XRP, ... }, ts }
 *   GET /api/edge/spin          -> { spin:    { BTC, ETH, SOL, XRP, ... }, ts }
 */

'use strict';

const fs = require('fs');
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const BRAIN_SYNC_URL = process.env.BRAIN_SYNC_URL;
const POLL_MS = Math.max(250, Number(process.env.EDGE_WEIGHT_POLL_MS || 2000));
const TOKEN_FILE = process.env.BRAIN_SYNC_TOKEN_FILE;

if (!BRAIN_SYNC_URL) {
  console.error('[edge-weight-sync] BRAIN_SYNC_URL is required');
  process.exit(1);
}

let authToken = null;
if (TOKEN_FILE) {
  try {
    authToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (err) {
    console.error('[edge-weight-sync] failed to read BRAIN_SYNC_TOKEN_FILE:', err.message);
    process.exit(1);
  }
}

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  connectTimeout: 1000,
  retryStrategy(times) { return Math.min(500 * times, 5000); },
});

let __lastRedisErrTs = 0;
let __lastSyncErrTs = 0;
let __edgeShutdown = false;
redis.on('error', (err) => {
  if (Date.now() - __lastRedisErrTs > 5000) {
    console.warn('[edge-weight-sync] redis error:', err.message);
    __lastRedisErrTs = Date.now();
  }
});

const KEYS = {
  weights: 'edge:dqn:weights',
  weightsVersion: 'edge:dqn:weights:version',
  weightsTs: 'edge:dqn:weights:ts',
  sigProb: (asset) => 'edge:sigprob:' + asset,
  spin: (asset) => 'edge:spin:' + asset,
  metaTs: 'edge:meta:ts',
};

async function fetchJson(endpoint) {
  const url = BRAIN_SYNC_URL.replace(/\/$/, '') + endpoint;
  const headers = { 'accept': 'application/json' };
  if (authToken) headers['authorization'] = 'Bearer ' + authToken;
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(endpoint + ' -> HTTP ' + res.status + ': ' + body.slice(0, 120));
  }
  return res.json();
}

async function syncWeights() {
  const data = await fetchJson('/api/edge/weights');
  if (!data || !data.weights_b64) throw new Error('weights payload missing weights_b64');
  const pipe = redis.pipeline();
  pipe.set(KEYS.weights, data.weights_b64);
  pipe.set(KEYS.weightsVersion, String(data.version || 0));
  pipe.set(KEYS.weightsTs, String(data.ts || Date.now()));
  await pipe.exec();
}

async function syncSigProb() {
  const data = await fetchJson('/api/edge/sig-prob');
  if (!data || !data.sig_prob) throw new Error('sig_prob payload missing sig_prob');
  const ts = String(data.ts || Date.now());
  const pipe = redis.pipeline();
  for (const asset of Object.keys(data.sig_prob)) {
    const value = data.sig_prob[asset];
    if (value == null || Number.isNaN(Number(value))) continue;
    pipe.set(KEYS.sigProb(asset.toUpperCase()), String(value));
  }
  pipe.set(KEYS.metaTs, ts);
  await pipe.exec();
}

async function syncSpin() {
  const data = await fetchJson('/api/edge/spin');
  if (!data || !data.spin) throw new Error('spin payload missing spin');
  const ts = String(data.ts || Date.now());
  const pipe = redis.pipeline();
  for (const asset of Object.keys(data.spin)) {
    const value = data.spin[asset];
    if (value == null || Number.isNaN(Number(value))) continue;
    pipe.set(KEYS.spin(asset.toUpperCase()), String(value));
  }
  pipe.set(KEYS.metaTs, ts);
  await pipe.exec();
}

async function tick(label, fn) {
  try {
    await fn();
  } catch (err) {
    if (Date.now() - __lastSyncErrTs > 5000) {
      console.warn('[edge-weight-sync] ' + label + ' failed:', err.message);
      __lastSyncErrTs = Date.now();
    }
  }
}

async function loop() {
  const weightsEveryN = Math.max(1, Math.round(30000 / POLL_MS));
  let n = 0;
  while (!__edgeShutdown) {
    n += 1;
    await tick('sig_prob', syncSigProb);
    await tick('spin',     syncSpin);
    if (n % weightsEveryN === 0) await tick('weights', syncWeights);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function shutdown(signal) {
  console.log('[edge-weight-sync] received ' + signal + ', shutting down');
  __edgeShutdown = true;
  try { await redis.quit(); } catch (_) {}
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[edge-weight-sync] starting; brain=' + BRAIN_SYNC_URL + ' poll=' + POLL_MS + 'ms');
loop().catch((err) => {
  console.error('[edge-weight-sync] fatal:', err);
  process.exit(1);
});