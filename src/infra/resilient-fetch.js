// resilient-fetch.js — Network resilience layer with retry + fallback
// Wraps throttledFetch to add:
// - Automatic retry (3 attempts) with exponential backoff
// - Fallback URLs for known APIs
// - Error logging to COPILOT_DEBUG
// - Graceful degradation (doesn't break on network failures)
//
// Loaded AFTER throttled-fetch.js so it wraps both throttled and direct fetch calls.

(function () {
  'use strict';

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 500;
  const TIMEOUT_MS = 15000;  // 15s default timeout for proxy routing

  function resolveRuntimeKey(name) {
    try {
      if (typeof window !== 'undefined') {
        if (window.__env && window.__env[name]) return window.__env[name];
        if (window.desktopApp?.publicEnv && window.desktopApp.publicEnv[name]) return window.desktopApp.publicEnv[name];
      }
    } catch (_) { }
    try {
      if (typeof localStorage !== 'undefined') {
        const keyMap = {
          ETHERSCAN_API_KEY: 'etherscanApiKey',
          HELIUS_API_KEY: 'heliusApiKey',
        };
        const localKey = keyMap[name];
        if (localKey) {
          const v = localStorage.getItem(localKey);
          if (v) return v;
        }
      }
    } catch (_) { }
    try {
      if (globalThis?.process?.env?.[name]) return globalThis.process.env[name];
    } catch (_) { }
    return '';
  }

  function etherscanV2Url(module, action) {
    const qs = new URLSearchParams({
      chainid: '1',
      module: String(module || ''),
      action: String(action || ''),
    });
    const apiKey = resolveRuntimeKey('ETHERSCAN_API_KEY');
    if (apiKey) qs.set('apikey', apiKey);
    return `https://api.etherscan.io/v2/api?${qs.toString()}`;
  }

  function normalizeKrakenPairToBinanceSymbol(pairRaw) {
    const pair = String(pairRaw || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!pair) return '';
    const aliases = {
      XBTUSD: 'BTCUSDT',
      XXBTZUSD: 'BTCUSDT',
      ETHUSD: 'ETHUSDT',
      XETHZUSD: 'ETHUSDT',
    };
    if (aliases[pair]) return aliases[pair];
    const normalized = pair.replace(/^XBT/, 'BTC');
    if (normalized.endsWith('USD')) return `${normalized.slice(0, -3)}USDT`;
    return normalized;
  }

  function krakenPairsToBinanceFallback(pairRaw) {
    const symbols = decodeURIComponent(String(pairRaw || ''))
      .split(',')
      .map((pair) => normalizeKrakenPairToBinanceSymbol(pair))
      .filter(Boolean);
    if (!symbols.length) return '';
    if (symbols.length === 1) {
      return `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbols[0])}`;
    }
    return `https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
  }

  // Fallback URLs for APIs that fail frequently
  const FALLBACK_URLS = {
    // Kraken → fallback to Binance for ticker data
    'api.kraken.com/0/public/Ticker': [
      url => url,
      // Fallback 1: Try Binance spot
      (url) => {
        const pair = (url.match(/[?&]pair=([^&]+)/i) || [])[1] || '';
        return krakenPairsToBinanceFallback(pair) || url;
      },
    ],
    // Coinbase → fallback to Kraken
    'api.exchange.coinbase.com/products': [
      url => url,
      // Fallback 1: Try Kraken
      url => url.replace(/api\.exchange\.coinbase\.com\/products\/(.+?)(-USD)/,
        'api.kraken.com/0/public/Ticker?pair=$1USD'),
    ],
    // Bybit → fallback to Binance for spot trades
    'api.bybit.com/v5/market/recent-trade': [
      // Original
      url => url,
      // Fallback 1: Try Binance spot
      url => url.replace(/api\.bybit\.com\/v5\/market\/recent-trade\?category=spot&symbol=(.+?)USDT/,
        'data-api.binance.vision/api/v3/trades?symbol=$1USDT'),
    ],
    // Blockscout gas → fallback to etherscan
    'eth.blockscout.com/api/v2/gas-price-oracle': [
      url => url,
      () => etherscanV2Url('proxy', 'eth_gasPrice'),
    ],
    // Mempool → fallback to blockchain.info
    'mempool.space/api/v1/fees/recommended': [
      url => url,
      () => 'https://api.blockchain.info/mempool/fees',
    ],
    // Mempool backlog → fallback to the Blockstream mirror (same response schema)
    'mempool.space/api/mempool': [
      url => url,
      () => 'https://blockstream.info/api/mempool',
    ],
    // Ankr RPC → fallback to Helius
    'rpc.ankr.com': [
      url => url,
      () => {
        const heliusKey = resolveRuntimeKey('HELIUS_API_KEY');
        return heliusKey
          ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`
          : 'https://api.mainnet-beta.solana.com';
      },
    ],
  };

  function getFallbackUrls(url) {
    if (typeof url !== 'string' || !url) return [];
    for (const [pattern, fallbacks] of Object.entries(FALLBACK_URLS)) {
      if (url.includes(pattern)) {
        return fallbacks
          .map((entry) => {
            try {
              return typeof entry === 'function' ? entry(url) : entry;
            } catch (_) {
              return null;
            }
          })
          .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
      }
    }
    return [url]; // No fallback — just return original
  }

  async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function jitterDelay(baseMs) {
    const jitter = Math.floor(Math.random() * Math.max(60, Math.floor(baseMs * 0.4)));
    return baseMs + jitter;
  }

  // Try a single URL with one retry loop + timeout
  async function tryUrl(url, options = {}, attemptNum = 0) {
    if (typeof url !== 'string' || !url) {
      throw new Error('Invalid URL passed to tryUrl');
    }
    try {
      const fetchImpl = typeof window.throttledFetch === 'function'
        ? window.throttledFetch.bind(window)
        : window.fetch.bind(window);
      const res = await fetchImpl(url, options);

      if (res.ok || res.status < 500) return res; // Accept 2xx, 3xx, 4xx; retry on 5xx

      // 5xx → retry
      if (attemptNum < MAX_RETRIES) {
        const delay = jitterDelay(RETRY_DELAY_MS * Math.pow(2, attemptNum));
        await sleep(delay);
        return tryUrl(url, options, attemptNum + 1);
      }
      return res; // Return error response after all retries exhausted
    } catch (err) {
      // Check for timeout
      const isTimeout = err.name === 'AbortError';
      const errMsg = String(err?.message || '');
      const isNetwork =
        errMsg.includes('fetch') ||
        errMsg.includes('ERR_') ||
        errMsg.includes('ECONNRESET') ||
        errMsg.includes('socket hang up') ||
        errMsg.includes('network changed');

      if ((isTimeout || isNetwork) && attemptNum < MAX_RETRIES) {
        const delay = jitterDelay(RETRY_DELAY_MS * Math.pow(2, attemptNum));
        const reason = isTimeout ? '(timeout)' : `(${err.message})`;
        console.warn(`[ResilientFetch] Retry attempt ${attemptNum + 1}/${MAX_RETRIES + 1} for ${url.slice(0, 60)} ${reason}`);
        await sleep(delay);
        return tryUrl(url, options, attemptNum + 1);
      }
      throw err; // Throw after all retries
    }
  }

  // Try all fallback URLs in sequence until one works
  async function tryFallbacks(fallbackUrls, options = {}) {
    let lastError = null;

    for (let i = 0; i < fallbackUrls.length; i++) {
      const url = fallbackUrls[i];
      if (typeof url !== 'string' || !url) {
        lastError = 'invalid fallback url';
        continue;
      }

      try {
        const res = await tryUrl(url, options);
        if (res.ok) {
          if (i > 0) {
            console.info(`[ResilientFetch] Fallback #${i} succeeded: ${url.slice(0, 60)}`);
          }
          return res;
        }
        // Non-ok response — remember and try next fallback
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err.message;
        // Continue to next fallback
      }
    }

    // All fallbacks failed — throw last error
    throw new Error(`All fallback URLs failed. Last error: ${lastError}`);
  }

  // Main resilient fetch
  async function resilientFetch(url, options = {}) {
    if (typeof url !== 'string' || !url) {
      throw new Error('resilientFetch requires a valid URL string');
    }
    const fallbackUrls = getFallbackUrls(url);
    if (!fallbackUrls.length) {
      throw new Error('No valid fallback URLs generated');
    }

    try {
      return await tryFallbacks(fallbackUrls, options);
    } catch (err) {
      console.error(
        `[ResilientFetch] FAILED: ${url.slice(0, 80)} → ${err.message}`
      );

      // Log to COPILOT_DEBUG via IPC if available
      if (window.desktopApp?.networkError) {
        try {
          await window.desktopApp.networkError(
            'NETWORK_ERROR',
            `${url.slice(0, 100)} | ${err.message}`
          );
        } catch (_) {
          // IPC not available or failed — continue anyway
        }
      }

      throw err;
    }
  }

  // Export as window.resilientFetch; callers can choose between throttled and resilient
  window.resilientFetch = resilientFetch;

  console.info(
    `[ResilientFetch] v1.1 ready — ${MAX_RETRIES} retries, ${Object.keys(FALLBACK_URLS).length} known fallbacks`
  );
})();
