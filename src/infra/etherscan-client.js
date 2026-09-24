/**
 * etherscan-client.js — Robust, rate-limited Etherscan client with key rotation.
 *
 * Operational Specs:
 * - Hard burst cap: 5 calls / second (200ms minimum inter-call spacing)
 * - Daily quota budget: 100,000 calls / 24h (~1.157 calls/sec sustained budget)
 * - Key Rotation: env keys first, then bundled read-only free-tier
 *   scanner defaults (public chain data only; visible in probe URLs by design)
 * - Caching: Response memoization with TTL to eliminate redundant hits
 * - Zero-flapping: Automatic failover on HTTP 429 / status "0" rate-limit replies
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EtherscanClient = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Constants
  const MAX_BURST_PER_SEC = 5;
  const MIN_INTERVAL_MS = 200; // 5 req/s max
  const DAILY_QUOTA_LIMIT = 100000;
  const ROLLING_WINDOW_24H_MS = 86400 * 1000;
  const DEFAULT_CACHE_TTL_MS = 30 * 1000; // 30s TTL for fast metrics

  // State
  let activeKeyIndex = 0;
  let lastRequestTime = 0;
  const requestTimestamps24h = [];
  const requestQueue = [];
  let isQueueProcessing = false;
  const responseCache = new Map();

  function getKeys() {
    const keys = [];
    const envSources = [
      typeof process !== 'undefined' && process.env ? process.env : null,
      typeof window !== 'undefined' && window.__env ? window.__env : null,
      typeof window !== 'undefined' ? window : null,
    ].filter(Boolean);

    for (const src of envSources) {
      if (src.ETHERSCAN_API_KEY && !keys.includes(src.ETHERSCAN_API_KEY)) keys.push(src.ETHERSCAN_API_KEY);
      if (src.ETHERSCAN_API_KEY_2 && !keys.includes(src.ETHERSCAN_API_KEY_2)) keys.push(src.ETHERSCAN_API_KEY_2);
      if (src.ETHERSCAN_API_KEY_3 && !keys.includes(src.ETHERSCAN_API_KEY_3)) keys.push(src.ETHERSCAN_API_KEY_3);
    }

    // Bundled read-only scanner defaults (public chain data only).
    // Env-provided keys take priority and are added first above.
    const defaults = [
      'T6F48S3FE2N74N9TR5GIRUPS95X7EWQ8GY',
      'YS8N4PZ78ZCMPGNEZIAFE6KPPFYXV74YBR',
      '39FHNNVAV6N9FXZ45YW1HQX6QFBSU3W61U',
    ];
    for (const d of defaults) {
      if (!keys.includes(d)) keys.push(d);
    }
    return keys;
  }

  function prune24hWindow(now = Date.now()) {
    const cutoff = now - ROLLING_WINDOW_24H_MS;
    while (requestTimestamps24h.length > 0 && requestTimestamps24h[0] < cutoff) {
      requestTimestamps24h.shift();
    }
  }

  function getUsageStats() {
    const now = Date.now();
    prune24hWindow(now);
    return {
      dailyCount: requestTimestamps24h.length,
      dailyQuota: DAILY_QUOTA_LIMIT,
      dailyRemaining: Math.max(0, DAILY_QUOTA_LIMIT - requestTimestamps24h.length),
      activeKeyIndex,
      cacheSize: responseCache.size,
    };
  }

  async function scheduleSlot() {
    return new Promise((resolve) => {
      requestQueue.push(resolve);
      processQueue();
    });
  }

  function processQueue() {
    if (isQueueProcessing || requestQueue.length === 0) return;
    isQueueProcessing = true;

    const now = Date.now();
    prune24hWindow(now);

    // Check 24-hour limit
    if (requestTimestamps24h.length >= DAILY_QUOTA_LIMIT) {
      const oldest = requestTimestamps24h[0];
      const waitTime = Math.max(1000, oldest + ROLLING_WINDOW_24H_MS - now);
      console.warn(`[EtherscanClient] Daily quota limit reached (${DAILY_QUOTA_LIMIT}). Pausing for ${Math.round(waitTime / 1000)}s`);
      setTimeout(() => {
        isQueueProcessing = false;
        processQueue();
      }, waitTime);
      return;
    }

    // Check burst limit (minimum interval spacing)
    const elapsed = now - lastRequestTime;
    const delay = elapsed < MIN_INTERVAL_MS ? MIN_INTERVAL_MS - elapsed : 0;

    setTimeout(() => {
      lastRequestTime = Date.now();
      requestTimestamps24h.push(lastRequestTime);
      const nextResolve = requestQueue.shift();
      if (nextResolve) nextResolve();
      isQueueProcessing = false;
      if (requestQueue.length > 0) processQueue();
    }, delay);
  }

  async function fetchEtherscan(params = {}, opts = {}) {
    const keys = getKeys();
    const cacheTtl = opts.cacheTtl != null ? opts.cacheTtl : DEFAULT_CACHE_TTL_MS;
    const bypassCache = !!opts.bypassCache;

    // Build URL query string
    const query = new URLSearchParams({
      chainid: '1',
      ...params,
    });

    const cacheKey = `${params.module}:${params.action}:${params.timestamp || ''}:${params.tag || ''}:${params.address || ''}`;
    const now = Date.now();

    if (!bypassCache && cacheTtl > 0) {
      const cached = responseCache.get(cacheKey);
      if (cached && now - cached.ts < cacheTtl) {
        return cached.data;
      }
    }

    // Try keys sequentially on rate-limit or failover
    let lastError = null;
    const initialIndex = activeKeyIndex;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const keyIdx = (initialIndex + attempt) % keys.length;
      const key = keys[keyIdx];
      query.set('apikey', key);

      const url = `https://api.etherscan.io/v2/api?${query.toString()}`;

      // Respect rate-limiting slot
      await scheduleSlot();

      try {
        const fetchFn = typeof opts.fetchFn === 'function'
          ? opts.fetchFn
          : (typeof window !== 'undefined' && typeof window.proxyFetch === 'function' ? window.proxyFetch : fetch);

        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(new Error('etherscan-timeout')), opts.timeout || 10000);

        let res;
        try {
          res = await fetchFn(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (!res || !res.ok) {
          throw new Error(`HTTP ${res?.status || 0}`);
        }

        const data = await res.json();

        // Etherscan API returns status "0" with "Max rate limit reached"
        const message = String(data?.message || data?.result || '');
        const isRateLimited = data?.status === '0' && /rate limit|limit reached|busy/i.test(message);

        if (isRateLimited) {
          console.warn(`[EtherscanClient] Key #${keyIdx} rate limited. Rotating to next key...`);
          activeKeyIndex = (keyIdx + 1) % keys.length;
          lastError = new Error(`Key rate limited: ${message}`);
          continue; // Try next key
        }

        // Success
        activeKeyIndex = keyIdx;
        if (cacheTtl > 0) {
          responseCache.set(cacheKey, { ts: Date.now(), data });
        }
        return data;
      } catch (err) {
        lastError = err;
        console.warn(`[EtherscanClient] Request failed on key #${keyIdx}: ${err.message}`);
        activeKeyIndex = (keyIdx + 1) % keys.length;
      }
    }

    throw lastError || new Error('All Etherscan API keys failed');
  }

  return {
    fetchEtherscan,
    getUsageStats,
    getKeys,
    MAX_BURST_PER_SEC,
    MIN_INTERVAL_MS,
    DAILY_QUOTA_LIMIT,
  };
});
