/**
 * tiered-cache-redis.js (Electron main process only)
 *
 * The warm tier of src/core/tiered-cache.js needs plain GET/SET/DEL against
 * Redis. orbital-redis-subscriber.js's connection can't be reused for this --
 * once a connection issues (p)subscribe it enters Redis subscriber mode and
 * refuses ordinary commands -- so this opens a second, separate connection
 * dedicated to key/value reads and writes.
 */
'use strict';

const Redis = require('ioredis');

let _client = null;
let _ready = false;
let _lastError = null;

function client() {
  if (_client) return _client;
  _client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    retryStrategy(times) {
      return Math.min(1000 * times, 5000);
    },
  });
  _client.on('ready', () => { _ready = true; _lastError = null; });
  _client.on('close', () => { _ready = false; });
  _client.on('end', () => { _ready = false; });
  _client.on('error', (err) => { _lastError = err?.message || String(err); });
  return _client;
}

async function warmGet(key) {
  if (!key) return null;
  try {
    const raw = await client().get(key);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (_) { return raw; }
  } catch (err) {
    _lastError = err?.message || String(err);
    return null;
  }
}

async function warmSet(key, value, ttlMs) {
  if (!key) return false;
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (Number.isFinite(ttlMs) && ttlMs > 0) {
      await client().set(key, raw, 'PX', Math.floor(ttlMs));
    } else {
      await client().set(key, raw);
    }
    return true;
  } catch (err) {
    _lastError = err?.message || String(err);
    return false;
  }
}

async function warmDel(key) {
  if (!key) return false;
  try {
    await client().del(key);
    return true;
  } catch (err) {
    _lastError = err?.message || String(err);
    return false;
  }
}

function getStatus() {
  return { ready: _ready, lastError: _lastError };
}

function stop() {
  if (_client) { try { _client.disconnect(); } catch (_) { /* */ } _client = null; }
  _ready = false;
}

module.exports = { warmGet, warmSet, warmDel, getStatus, stop };
