// throttled-fetch.js — Global API rate limiter for WE|||CRYPTO
// Prevents exchange APIs from throttling/banning and stops the proxy from
// being overwhelmed by 30+ simultaneous requests during prediction engine runs.
//
// Two modes exposed on window:
//   throttledFetch(url, options)  — concurrent cap, hard timeout per request
//   queuedFetch(url)              — strict serial queue with 65ms breathing room between calls
(function() {
  // ── 1. CONCURRENT THROTTLE ────────────────────────────────────────────────
  const MAX_CONCURRENT   = 16;     // was 30 — fewer parallel REST blasts; proxy + Canada node stay stable
  const FETCH_TIMEOUT_MS = 45000;  // was 60s — fail faster, free slots for live path
  const SLOT_GAP_MS      = 30;     // slight breathing room for local proxy event loop
  const API_TIMEOUT_MS = {
    coingecko: 20000,
    coinbase: 20000,
    okx: 60000,
    okc: 60000,
    bitstamp: 60000,
    binance: 20000,
    bybit: 60000,
    kraken: 60000,
    kucoin: 60000,
    mexc: 60000,
    bitfinex: 60000,
    cryptocom: 20000,
    kalshi: 20000,
    polymarket: 60000,
    upbit: 60000,
    bitget: 60000,
    bingx: 60000,
    bitvavo: 60000,
    gemini: 60000,
    coinw: 60000,
    lbank: 60000,
    bitso: 60000,
    bullish: 60000,
    whitebit: 60000,
    ourbit: 60000,
    weex: 60000,
    default: FETCH_TIMEOUT_MS,
  };

  let activeFetches = 0;
  const waitQueue = [];

  function inferApiName(url) {
    try {
      const host = new URL(String(url), window.location.href).hostname.toLowerCase();
      if (host.includes('coingecko')) return 'coingecko';
      if (host.includes('coinbase')) return 'coinbase';
      if (host.includes('okx.com') || host.includes('okcoin.com')) return 'okx';
      if (host.includes('bitstamp')) return 'bitstamp';
      if (host.includes('coinmarketcap')) return 'coinmarketcap';
      if (host.includes('binance')) return 'binance';
      if (host.includes('bybit')) return 'bybit';
      if (host.includes('kraken')) return 'kraken';
      if (host.includes('kucoin')) return 'kucoin';
      if (host.includes('mexc')) return 'mexc';
      if (host.includes('bitfinex')) return 'bitfinex';
      if (host.includes('crypto.com')) return 'cryptocom';
      if (host.includes('kalshi')) return 'kalshi';
      if (host.includes('polymarket')) return 'polymarket';
      if (host.includes('mempool.space') || host.includes('blockchair.com') || host.includes('etherscan.io') || host.includes('blockscout.com')) return 'blockchainraw';
      if (host.includes('blockcypher')) return 'blockcypher';
      if (host.includes('chain.so')) return 'chainso';
      if (host.includes('upbit')) return 'upbit';
      if (host.includes('bitget')) return 'bitget';
      if (host.includes('bingx')) return 'bingx';
      if (host.includes('bitvavo')) return 'bitvavo';
      if (host.includes('gemini')) return 'gemini';
      if (host.includes('coinw')) return 'coinw';
      if (host.includes('lbkex') || host.includes('lbank')) return 'lbank';
      if (host.includes('bitso')) return 'bitso';
      if (host.includes('bullish')) return 'bullish';
      if (host.includes('whitebit')) return 'whitebit';
      if (host.includes('ourbit')) return 'ourbit';
      if (host.includes('weex')) return 'weex';
      return null;
    } catch (_) {
      return null;
    }
  }

  function resolveRuntimeKey(name) {
    if (typeof process !== 'undefined' && process.env && process.env[name]) {
      return process.env[name];
    }
    try {
      if (typeof window.resolveRuntimeKey === 'function') return window.resolveRuntimeKey(name) || '';
    } catch (_) { }
    try {
      return window.__env?.[name] || window.desktopApp?.publicEnv?.[name] || '';
    } catch (_) {
      return '';
    }
  }

    function withCoinGeckoAuth(url, options = {}) {
      // Return options unchanged; auth is handled in URL query params.
      return options;
    }

    function normalizeCoinGeckoApiKey(rawValue) {
      const value = String(rawValue || '').trim();
      if (!value) return '';
      const demoMatch = value.match(/\bCG-[A-Za-z0-9_-]{8,}\b/i);
      if (demoMatch) return demoMatch[0];
      const token = value
        .split(/[\s"'`]+/)
        .map(part => part.trim())
        .find(part => /^[A-Za-z0-9_-]{20,}$/.test(part) && !/^https?:/i.test(part));
      return token || '';
    }

    function coinGeckoUrl(url) {
      const key = normalizeCoinGeckoApiKey(resolveRuntimeKey('COINGECKO_API_KEY'));
      const tier = String(resolveRuntimeKey('COINGECKO_API_TIER') || '').trim().toLowerCase();
      if (!key) return url;
      try {
        const u = new URL(String(url), window.location.href);
        if (u.hostname.includes('coingecko')) {
          const isDemo = tier === 'demo' || tier === 'free' || key.startsWith('CG-') || (tier !== 'pro' && tier !== 'trial');
          if (!isDemo) {
            u.hostname = 'pro-api.coingecko.com';
            u.searchParams.set('x_cg_pro_api_key', key);
            u.searchParams.delete('x_cg_demo_api_key');
            u.searchParams.delete('x-cg-demo-api-key');
          } else {
            u.hostname = 'api.coingecko.com';
            u.searchParams.set('x_cg_demo_api_key', key);
            u.searchParams.delete('x_cg_pro_api_key');
            u.searchParams.delete('x-cg-pro-api-key');
          }
        }
        return u.toString();
      } catch (_) {
        return url;
      }
    }

  async function throttledFetch(url, options = {}) {
    const apiName = inferApiName(url);
    
    // 1. Wait for API rate limit BEFORE taking a global concurrency slot.
    // This prevents slow APIs (e.g., CoinGecko) from hoarding all global slots.
    if (apiName && window.ApiRateLimiter) {
      await window.ApiRateLimiter.acquireToken(apiName, options.signal);
    }

    // 2. If the caller aborted while we were waiting for the rate limit, exit early.
    if (options.signal && options.signal.aborted) {
      throw options.signal.reason || new DOMException('Aborted', 'AbortError');
    }

    // 3. Take a global concurrency slot.
    if (activeFetches >= MAX_CONCURRENT) {
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal: options.signal };
        waitQueue.push(entry);
        if (options.signal) {
          const onAbort = () => {
            options.signal.removeEventListener('abort', onAbort);
            const idx = waitQueue.indexOf(entry);
            if (idx !== -1) {
              waitQueue.splice(idx, 1);
              reject(options.signal.reason || new DOMException('Aborted', 'AbortError'));
            }
          };
          options.signal.addEventListener('abort', onAbort);
        }
      });
    }
    
    // Check abort again just in case we waited a long time in the global queue
    if (options.signal && options.signal.aborted) {
      if (waitQueue.length > 0) setTimeout(() => { 
        while (waitQueue.length) {
          const entry = waitQueue.shift();
          if (entry.signal && entry.signal.aborted) continue;
          (entry.resolve || entry)();
          break;
        }
      }, SLOT_GAP_MS);
      throw options.signal.reason || new DOMException('Aborted', 'AbortError');
    }
    
    activeFetches++;

    // Promise.race provides a hard deadline even when the proxy ignores
    // the AbortController signal.  The underlying fetch may keep running
    // in the background but it won't hold a throttle slot.
    let timeoutId = null;
    let innerCtrl = null;
    let abortHandler = null;
    const hardTimeout = new Promise((_, reject) =>
      timeoutId = setTimeout(() => {
        if (options.signal && !options.signal.aborted) {
          // Do not abort caller's signal, just reject our race. We will abort the inner fetch below.
        }
        reject(new Error('[throttle] timeout'));
      }, (() => {
        const fallbackApiName = apiName || 'default';
        const limiter = fallbackApiName && window.ApiRateLimiter ? window.ApiRateLimiter.getLimiter(fallbackApiName) : null;
        const queuePenaltyMs = limiter ? Math.min(4000, limiter.getQueueLength() * 120) : 0;
        const baseTimeout = API_TIMEOUT_MS[fallbackApiName] || API_TIMEOUT_MS.default;
        return baseTimeout + queuePenaltyMs;
      })())
    );

    try {
      
      // If caller already aborted while we were in rate limiter, throw immediately
      if (options.signal && options.signal.aborted) {
        throw options.signal.reason || new DOMException('Aborted', 'AbortError');
      }

      const finalUrl = apiName === 'coingecko' && typeof window.coinGeckoUrl === 'function'
        ? window.coinGeckoUrl(url)
        : url;
      
      innerCtrl = new AbortController();
      if (options.signal) {
        abortHandler = () => innerCtrl.abort(options.signal.reason);
        options.signal.addEventListener('abort', abortHandler);
      }
      
      // Ensure we abort the inner fetch if hardTimeout wins, to prevent socket leaks in Chrome
      hardTimeout.catch((e) => innerCtrl.abort(e));

      const authOptions = apiName === 'coingecko' ? withCoinGeckoAuth(finalUrl, options) : options;
      const finalOptions = { ...authOptions, signal: innerCtrl.signal };
      const fetchUrl = finalOptions._rewrittenUrl || finalUrl;

      const res = await Promise.race([fetch(fetchUrl, finalOptions), hardTimeout]);
      return res;   //   return raw Response; callers use .ok / .json() themselves
    } catch (err) {
      console.warn('[ThrottledFetch] timeout/error:', url.slice(0, 100));
      throw err;    // ← re-throw so caller's .catch(() => []) handles it gracefully
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (options.signal && abortHandler) {
        try { options.signal.removeEventListener('abort', abortHandler); } catch (_) { }
      }
      activeFetches--;
      // Small gap before waking the next queued request — reduces proxy burst
      if (waitQueue.length > 0) {
        setTimeout(() => { 
          while (waitQueue.length) {
            const entry = waitQueue.shift();
            if (entry.signal && entry.signal.aborted) continue;
            (entry.resolve || entry)();
            break;
          }
        }, SLOT_GAP_MS);
      }
    }
  }

  // ── 2. SERIAL QUEUE (65 ms gap) ───────────────────────────────────────────
  // For Kalshi/market polling where strict ordering matters.
  const serialQueue = [];
  let queueBusy = false;

  async function queuedFetch(url) {
    return new Promise(resolve => {
      serialQueue.push({ url, resolve });
      runSerialQueue();
    });
  }

  async function runSerialQueue() {
    if (queueBusy || serialQueue.length === 0) return;
    queueBusy = true;
    const { url, resolve } = serialQueue.shift();
    try {
      const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      resolve(await res.json());
    } catch (err) {
      console.error('[ThrottledFetch] serial queue error:', url, err);
      resolve(null);
    }
    queueBusy = false;
    setTimeout(runSerialQueue, 65);   // 65 ms breathing room between calls
  }

  // ── 3. RESET (call on each new runAll to drain stale queue) ─────────────
  // Resolves all pending waiters immediately so they abort (their callers have
  // .catch(() => []) guards).  Resets activeFetches so new requests get fresh slots.
  function throttledFetchReset() {
    const drained = waitQueue.length;
    // Resolve all waiters — they will attempt to proceed but the underlying
    // fetch calls they were waiting on belong to the abandoned prior run.
    // Their individual coin-level timeouts will catch anything that slips through.
    while (waitQueue.length) {
      const entry = waitQueue.shift();
      if (typeof entry === 'function') entry();
      else if (entry.resolve) entry.resolve();
    }
    activeFetches = 0;
    if (drained) console.info(`[ThrottledFetch] reset — drained ${drained} stale queue entries`);
  }

  window.throttledFetch      = throttledFetch;
  window.queuedFetch         = queuedFetch;
  window.throttledFetchReset = throttledFetchReset;
  window.withCoinGeckoAuth   = withCoinGeckoAuth;
  window.coinGeckoUrl        = coinGeckoUrl;

  console.info(`[ThrottledFetch] v1.2 ready — concurrent: ${MAX_CONCURRENT} | timeout: ${FETCH_TIMEOUT_MS}ms | gap: ${SLOT_GAP_MS}ms`);
})();
