/**
 * orbital-redis-subscriber.js (Electron main process only)
 *
 * Redis pub/sub for the orbital ingestor's ticks was publish-only across the
 * whole app — orbital-ingestor-daemon.js publishes to `orbital:ticks:{type}:
 * {asset}` (type = s|p|d|f) on every tick, but nothing anywhere ever
 * subscribed. The only path data had into the renderer was Kafka -> the 15m
 * matrix-processor barrier -> Firestore -> a 60s renderer poll
 * (orbital-signal-client.js) -- multi-minute latency for data that updates
 * in real time. This subscribes directly and pushes each tick to the
 * renderer immediately (sub-second), no barrier, no Firestore round trip.
 */
'use strict';

const Redis = require('ioredis');

let _sub = null;
let _ready = false;
let _lastError = null;
const _latest = {}; // `${type}:${asset}` -> { payload, ts }
let _pushCallback = null; // (type, asset, payload) => void

function _key(type, asset) {
  return `${type}:${asset}`;
}

function start(onTick) {
  if (_sub) return;
  _pushCallback = typeof onTick === 'function' ? onTick : null;

  _sub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    retryStrategy(times) {
      return Math.min(1000 * times, 5000);
    },
  });

  _sub.on('ready', () => { _ready = true; _lastError = null; });
  _sub.on('close', () => { _ready = false; });
  _sub.on('end', () => { _ready = false; });
  _sub.on('error', (err) => { _lastError = err?.message || String(err); });

  _sub.on('ready', () => {
    _sub.psubscribe('orbital:ticks:*', (err) => {
      if (err) _lastError = err.message;
    });
  });

  _sub.on('pmessage', (_pattern, channel, message) => {
    // channel = orbital:ticks:{type}:{asset}
    const parts = channel.split(':');
    if (parts.length !== 4) return;
    const type = parts[2];
    const asset = parts[3];
    let payload;
    try {
      payload = JSON.parse(message);
    } catch (_) {
      return;
    }
    _latest[_key(type, asset)] = { payload, ts: Date.now() };
    if (_pushCallback) {
      try { _pushCallback(type, asset, payload); } catch (_) { /* renderer push must never crash the subscriber */ }
    }
  });
}

function stop() {
  if (_sub) {
    try { _sub.disconnect(); } catch (_) { /* */ }
    _sub = null;
  }
  _ready = false;
}

function getLatest(type, asset) {
  return _latest[_key(type, asset)] || null;
}

function getStatus() {
  return {
    ready: _ready,
    lastError: _lastError,
    cachedKeys: Object.keys(_latest).length,
  };
}

module.exports = { start, stop, getLatest, getStatus };
