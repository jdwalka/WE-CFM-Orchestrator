/**
 * Tiered Cache — hot (in-memory) / warm (Redis) / cold (MultiDriveCache)
 * for orbital/prediction data. Renderer-side only.
 *
 * hot:  in-memory Map, TTL only, gone on reload. Fastest, always tried first.
 * warm: Redis via IPC (electron/main.js -> src/infra/tiered-cache-redis.js).
 *       Survives reload, not the process. Good for forecast/momentum data
 *       with a natural TTL (a few minutes) -- NOT for anything that must be
 *       an immutable-forever lock (e.g. PTB), since a TTL'd tier is the
 *       wrong shape for "never changes, never expires."
 * cold: MultiDriveCache (Google Drive/OneDrive/local-disk mirrored JSON +
 *       localStorage), no TTL, survives app restarts. Deliberately not
 *       Firestore -- this app's Firestore reads already carry a known
 *       composite-index risk that a hot cache path shouldn't inherit.
 *
 * get() checks hot -> warm -> cold in order and backfills faster tiers on a
 * cold/warm hit, so a value written once with set({tier:'cold'}) still gets
 * memoized in memory in this process after the first read.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  const _hot = new Map(); // key -> { value, expiresAt }

  function hotGet(key) {
    const entry = _hot.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      _hot.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function hotSet(key, value, ttlMs) {
    _hot.set(key, {
      value,
      expiresAt: Number.isFinite(ttlMs) && ttlMs > 0 ? Date.now() + ttlMs : null,
    });
  }

  function hotDel(key) {
    _hot.delete(key);
  }

  async function warmGet(key) {
    try {
      if (!window._tieredCacheWarm?.get) return undefined;
      const res = await window._tieredCacheWarm.get(key);
      return res?.success && res.value != null ? res.value : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async function warmSet(key, value, ttlMs) {
    try {
      if (!window._tieredCacheWarm?.set) return false;
      const res = await window._tieredCacheWarm.set(key, value, ttlMs);
      return !!res?.success;
    } catch (_) {
      return false;
    }
  }

  async function warmDel(key) {
    try {
      if (!window._tieredCacheWarm?.del) return false;
      const res = await window._tieredCacheWarm.del(key);
      return !!res?.success;
    } catch (_) {
      return false;
    }
  }

  function coldGet(key) {
    try {
      const entry = window.MultiDriveCache?.getCold?.(key);
      return entry ? entry.value : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function coldSet(key, value) {
    try {
      window.MultiDriveCache?.setCold?.(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Reads hot -> warm -> cold, backfilling faster tiers on a lower-tier hit.
   * opts.tiers restricts which tiers are consulted (default: all three).
   * opts.hotTtlMs controls how long a warm/cold hit gets memoized in hot.
   */
  async function get(key, opts = {}) {
    const tiers = opts.tiers || ['hot', 'warm', 'cold'];
    const hotTtlMs = opts.hotTtlMs ?? 60_000;

    if (tiers.includes('hot')) {
      const v = hotGet(key);
      if (v !== undefined) return v;
    }

    if (tiers.includes('warm')) {
      const v = await warmGet(key);
      if (v !== undefined) {
        if (tiers.includes('hot')) hotSet(key, v, hotTtlMs);
        return v;
      }
    }

    if (tiers.includes('cold')) {
      const v = coldGet(key);
      if (v !== undefined) {
        if (tiers.includes('hot')) hotSet(key, v, hotTtlMs);
        return v;
      }
    }

    return undefined;
  }

  /**
   * Writes to the given tier (default 'hot'), or to all three at once with
   * tier: 'all'. ttlMs applies to hot and warm only -- cold has no TTL.
   */
  async function set(key, value, opts = {}) {
    const tier = opts.tier || 'hot';
    const ttlMs = opts.ttlMs;

    if (tier === 'hot' || tier === 'all') hotSet(key, value, ttlMs);
    if (tier === 'warm' || tier === 'all') await warmSet(key, value, ttlMs);
    if (tier === 'cold' || tier === 'all') coldSet(key, value);
  }

  async function invalidate(key) {
    hotDel(key);
    await warmDel(key);
    // Cold is intentionally left alone here -- MultiDriveCache has no
    // generic delete, and cold entries are meant to be long-lived history,
    // not something a hot/warm cache miss should erase.
  }

  window.TieredCache = { get, set, invalidate };
})();
