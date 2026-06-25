/**
 * edge-sig-prob-reader.js
 *
 * Tiny shim that lets the existing Kalshi shell read the latest
 * Sig_prob float + spin from the edge Redis sidecar instead of
 * reaching back to the brain. The brain writes the floats; the
 * edge shells read them. This is the path used when the shell
 * is running on a co-located us-east-1 VPS.
 *
 * API surface intentionally mirrors what the in-process orbital
 * bridge exposes (getOrbitalStateForAsset) so the rest of the
 * shell does not need to know whether it is in edge mode.
 *
 * Reads (in priority order):
 *   edge:sigprob:<ASSET>  -> float 0..1, latest Oracle probability
 *   edge:spin:<ASSET>     -> float -5..+5, blended spin state
 *   edge:meta:ts          -> ms epoch, last sync timestamp
 *   edge:dqn:weights      -> base64 weights blob for the local DQN
 *
 * Latency budget: 1 GET per asset per tick, total < 1 ms against
 * an in-memory redis on the same host.
 */

'use strict';

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const STALENESS_MS = Math.max(250, Number(process.env.EDGE_SIG_STALENESS_MS || 5000));

let client = null;
let connected = false;
let lastConnectErrTs = 0;

function getClient() {
  if (client) return client;
  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 500,
    lazyConnect: false,
    retryStrategy(times) { return Math.min(200 * times, 2000); },
  });
  client.on('ready',   () => { connected = true; });
  client.on('error',   (err) => {
    if (Date.now() - lastConnectErrTs > 5000) {
      lastConnectErrTs = Date.now();
      console.warn('[edge-sig] redis error:', err.message);
    }
  });
  client.on('end',     () => { connected = false; });
  client.on('close',   () => { connected = false; });
  return client;
}

function assetKey(asset, kind) {
  const a = String(asset || '').toUpperCase();
  return 'edge:' + kind + ':' + a;
}

async function readFloat(kind, asset) {
  if (!connected) return null;
  try {
    const v = await getClient().get(assetKey(asset, kind));
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

async function isStale() {
  if (!connected) return true;
  try {
    const ts = await getClient().get('edge:meta:ts');
    if (!ts) return true;
    return Date.now() - Number(ts) > STALENESS_MS;
  } catch (_) {
    return true;
  }
}

/**
 * Read the latest Sig_prob float for an asset. Returns null if
 * the edge has never seen a fresh value (caller should fall back
 * to a wait action in that case).
 */
async function getSigProb(asset) {
  if (await isStale()) return null;
  return readFloat('sigprob', asset);
}

/**
 * Read the latest blended spin for an asset. Returns null if
 * unavailable; caller should treat a null spin as 0 (neutral).
 */
async function getSpin(asset) {
  return readFloat('spin', asset);
}

/**
 * Snapshot read for the entire orbital universe. Used by the
 * shell during the per-tick decision loop. Pipeline keeps it
 * to a single round-trip.
 */
async function getEdgeSnapshot(assets) {
  if (!connected || !Array.isArray(assets) || assets.length === 0) {
    return { sig_prob: {}, spin: {}, ts: null, stale: true };
  }
  try {
    const c = getClient();
    const pipe = c.pipeline();
    for (const a of assets) {
      const A = String(a).toUpperCase();
      pipe.get(assetKey(A, 'sigprob'));
      pipe.get(assetKey(A, 'spin'));
    }
    pipe.get('edge:meta:ts');
    const results = await pipe.exec();
    if (!results) return { sig_prob: {}, spin: {}, ts: null, stale: true };
    const out = { sig_prob: {}, spin: {}, ts: null, stale: false };
    for (let i = 0; i < assets.length; i += 1) {
      const A = String(assets[i]).toUpperCase();
      const sigRes = results[i * 2];
      const spinRes = results[i * 2 + 1];
      const sigRaw = sigRes && !sigRes[0] ? sigRes[1] : null;
      const spinRaw = spinRes && !spinRes[0] ? spinRes[1] : null;
      if (sigRaw != null) {
        const n = Number(sigRaw);
        if (Number.isFinite(n)) out.sig_prob[A] = n;
      }
      if (spinRaw != null) {
        const n = Number(spinRaw);
        if (Number.isFinite(n)) out.spin[A] = n;
      }
    }
    const tsRes = results[assets.length * 2];
    const tsRaw = tsRes && !tsRes[0] ? tsRes[1] : null;
    out.ts = tsRaw ? Number(tsRaw) : null;
    out.stale = !tsRaw || (Date.now() - out.ts) > STALENESS_MS;
    return out;
  } catch (_) {
    return { sig_prob: {}, spin: {}, ts: null, stale: true };
  }
}

async function close() {
  if (!client) return;
  try { await client.quit(); } catch (_) {}
  client = null;
  connected = false;
}

module.exports = {
  getSigProb,
  getSpin,
  getEdgeSnapshot,
  close,
};