/**
 * Orbital Signal Client — renderer-side reader for the Redpanda/Kafka orbital
 * momentum pipeline (scripts/start-runtime.js -> orbital-matrix-processor.js
 * -> Firestore wecrypto_engine/root/orbital_states/{ASSET}).
 *
 * Non-authoritative supplementary signal only. Never used as spot or PTB —
 * those stay Pyth-only / Polymarket-only per src/llm/oracle-snapshot.js.
 * The orbital pipeline only runs under `npm run start:server`; under the
 * Electron desktop app it may simply have nothing to report, which this
 * client treats as a normal (not error) empty state.
 *
 * Stored in: window._orbitalSignals = { BTC: {...}, ETH: {...}, ... }
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  // Orbital matrix synthesis is a 15-min windowed barrier — no point polling faster.
  const POLL_INTERVAL_MS = 60_000;
  const MAX_AGE_MS = 20 * 60 * 1000; // stale beyond one synthesis window + margin

  window._orbitalSignals = window._orbitalSignals || {};
  // Raw per-tick s/p/d/f payloads pushed live from orbital-redis-subscriber.js
  // (Electron main) via IPC — sub-second, no 15m synthesis barrier, no
  // Firestore round trip. Keyed by asset: { s, p, d, f } -> { payload, ts }.
  window._orbitalRedisTicks = window._orbitalRedisTicks || {};
  let _pollTimer = null;
  let _lastPollTs = 0;
  let _redisUnsub = null;
  let _redisStatus = { ready: false, lastError: null, cachedKeys: 0 };

  async function fetchOne(coin) {
    try {
      // NOTE: exposed at window._orbitalBroadcaster (top-level), NOT
      // window.electron._orbitalBroadcaster -- see electron/preload.js's
      // contextBridge.exposeInMainWorld('_orbitalBroadcaster', ...). The old
      // window.electron._orbitalBroadcaster path never existed, so this
      // poll (and every getSignal() call) had been silently no-op'ing.
      if (!window._orbitalBroadcaster?.getSignal) return;
      const res = await window._orbitalBroadcaster.getSignal(coin);
      if (res?.success && res.state) {
        window._orbitalSignals[coin] = { ...res.state, fetchedAt: Date.now() };
      }
    } catch (_) { /* pipeline not running / Firestore unavailable — normal, not fatal */ }
  }

  function applyRedisTick(type, asset, payload) {
    const sym = String(asset || '').toUpperCase();
    if (!sym) return;
    window._orbitalRedisTicks[sym] = window._orbitalRedisTicks[sym] || {};
    window._orbitalRedisTicks[sym][type] = { payload, ts: Date.now() };
  }

  function startRedisLive() {
    if (_redisUnsub || !window._orbitalBroadcaster?.onRedisTick) return;
    _redisUnsub = window._orbitalBroadcaster.onRedisTick(({ type, asset, payload }) => {
      applyRedisTick(type, asset, payload);
    });
    window._orbitalBroadcaster.getRedisStatus?.()
      .then((res) => { if (res?.success) _redisStatus = res.status; })
      .catch(() => {});
  }

  function stopRedisLive() {
    if (_redisUnsub) { try { _redisUnsub(); } catch (_) { /* */ } _redisUnsub = null; }
  }

  /** Latest raw live tick for a coin/type ('s'|'p'|'d'|'f'), or null. */
  function getLiveTick(coin, type) {
    const entry = window._orbitalRedisTicks[String(coin || '').toUpperCase()]?.[type];
    return entry || null;
  }

  async function pollAll() {
    await Promise.all(COINS.map(fetchOne));
    _lastPollTs = Date.now();
  }

  function startPolling() {
    if (_pollTimer) return;
    pollAll().catch(() => {});
    _pollTimer = setInterval(() => { pollAll().catch(() => {}); }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  /** Returns the latest orbital state for a coin, or null if missing/stale. */
  function get(coin) {
    const key = String(coin || '').toUpperCase();
    const entry = window._orbitalSignals[key];
    if (!entry) return null;
    if (Date.now() - (entry.fetchedAt || 0) > MAX_AGE_MS) return null;
    return entry;
  }

  window.OrbitalSignal = {
    startPolling,
    stopPolling,
    get,
    getAll: () => ({ ...window._orbitalSignals }),
    lastPollTime: () => _lastPollTs,
    startRedisLive,
    stopRedisLive,
    getLiveTick,
    redisStatus: () => ({ ..._redisStatus }),
  };

  // Auto-start — harmless no-op when the orbital pipeline isn't running
  // (start:server only); fetchOne() swallows the IPC/Firestore-unavailable
  // case as a normal empty state. startRedisLive() is likewise a no-op when
  // the preload bridge or main-process Redis subscriber isn't present.
  startPolling();
  startRedisLive();
})();
