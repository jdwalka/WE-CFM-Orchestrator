/**
 * PYTH Browser-Compatible Price Feed
 * 
 * Hermes REST API for price verification (no WebSocket required)
 * Fetches every 5 seconds for Kalshi settlement divergence detection
 * 
 * Stored in: window._pythPrices = { BTC: price, ETH: price, ... }
 */

(function () {
  'use strict';

  const PYTH_HERMES = 'https://hermes.pyth.network/api/latest_price_feeds';
  // Support new Pyth key from secrets/PYTH_NEW_API wired via public env or resolveRuntimeKey
  let PYTH_API_KEY = '';
  try {
    if (typeof window !== 'undefined') {
      PYTH_API_KEY = window.resolveRuntimeKey
        ? (window.resolveRuntimeKey('PYTH_API') || window.resolveRuntimeKey('PYTH_NEW') || window.resolveRuntimeKey('PYTH_NEW_API') || window.resolveRuntimeKey('PYTH_API_KEY') || window.resolveRuntimeKey('PYTH_LAZER_TOKEN') || window.resolveRuntimeKey('LAZER_TOKEN'))
        : '';
      if (!PYTH_API_KEY && window.__env) {
        PYTH_API_KEY = window.__env.PYTH_API || window.__env.PYTH_NEW || window.__env.PYTH_NEW_API || window.__env.PYTH_API_KEY || window.__env.PYTH_LAZER_TOKEN || window.__env.LAZER_TOKEN || '';
      }
      if (!PYTH_API_KEY && window.electron && typeof window.electron.getPublicEnv === 'function') {
        window.electron.getPublicEnv().then(cfg => {
          if (cfg && (cfg.PYTH_API || cfg.PYTH_NEW || cfg.PYTH_NEW_API || cfg.PYTH_API_KEY)) {
            PYTH_API_KEY = cfg.PYTH_API || cfg.PYTH_NEW || cfg.PYTH_NEW_API || cfg.PYTH_API_KEY || cfg.PYTH_LAZER_TOKEN || cfg.LAZER_TOKEN || PYTH_API_KEY;
          }
        }).catch(() => {});
      }
      if (!PYTH_API_KEY) {
        PYTH_API_KEY = (typeof process !== 'undefined' && process.env)
          ? (process.env.PYTH_API || process.env.PYTH_NEW || process.env.PYTH_NEW_API || process.env.PYTH_API_KEY || '')
          : '';
      }
    }
  } catch (_) { }

  const PYTH_FEEDS = {
    BTC:  'Crypto.Bitcoin/USD',
    ETH:  'Crypto.Ethereum/USD',
    SOL:  'Crypto.Solana/USD',
    XRP:  'Crypto.Ripple/USD',
    DOGE: 'Crypto.Dogecoin/USD',
    BNB:  'Crypto.BinanceCoin/USD',
    HYPE: 'Crypto.Hyperliquid/USD',
  };

  // Poll interval: 5 seconds (faster than CMC for settlement verification)
  const POLL_INTERVAL_MS = 5000;
  let _pollTimer = null;
  let _lastPollTs = 0;

  // Initialize global store
  window._pythPrices = window._pythPrices || {};
  window._pythPythMetadata = window._pythPythMetadata || {};

  function scalePythPrice(rawPrice, expo) {
    const price = parseFloat(rawPrice);
    const exponent = Number(expo || 0);
    if (!Number.isFinite(price) || price <= 0) return null;
    const scaled = Number.isFinite(exponent) ? price * Math.pow(10, exponent) : price;
    return Number.isFinite(scaled) && scaled > 0 ? scaled : null;
  }

  async function fetchPythPrices() {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => {
        try {
          ctrl.abort(new DOMException('Pyth Hermes timed out after 7000ms', 'TimeoutError'));
        } catch (_) {
          try { ctrl.abort(); } catch (_) { }
        }
      }, 7000);

      let url = PYTH_HERMES;
      const headers = {};
      if (PYTH_API_KEY) {
        url += (PYTH_HERMES.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(PYTH_API_KEY);
        headers['x-api-key'] = PYTH_API_KEY;
      }
      
      const resp = await fetch(url, { signal: ctrl.signal, headers: Object.keys(headers).length ? headers : undefined });
      clearTimeout(timeout);
      
      if (!resp.ok) {
        console.warn(`[PythClient] HTTP ${resp.status} from Hermes API`);
        return false;
      }

      const data = await resp.json();
      if (!data.data || !Array.isArray(data.data.symbols)) {
        console.warn(`[PythClient] Unexpected Hermes response structure`);
        return false;
      }

      // Parse symbol feed data
      const updated = {};
      data.data.symbols.forEach(sym => {
        if (!sym.id || !sym.price) return;

        // Match against PYTH_FEEDS mapping
        for (const [coin, expectedId] of Object.entries(PYTH_FEEDS)) {
          if (sym.id.toLowerCase().includes(expectedId.toLowerCase()) || 
              sym.id.toLowerCase() === expectedId.toLowerCase()) {
            const price = scalePythPrice(sym.price.price, sym.price.expo);
            if (price != null) {
              updated[coin] = {
                price,
                expo: sym.price.expo || 0,
                conf: sym.price.conf || 0,
                publishTime: sym.price.publish_time || null,
              };
            }
            break;
          }
        }
      });

      // Update global store
      const prevCount = Object.keys(window._pythPrices).length;
      Object.assign(window._pythPrices, updated);
      
      if (Object.keys(updated).length > 0) {
        _lastPollTs = Date.now();
        console.log(`[PythClient] ✅ Updated ${Object.keys(updated).length} prices (total: ${Object.keys(window._pythPrices).length})`);
        if (typeof window !== 'undefined') {
          try {
            window.dispatchEvent(new CustomEvent('pyth:tick', { detail: updated }));
          } catch (_) {}
        }
      }

      return true;
    } catch (err) {
      console.warn(`[PythClient] Fetch failed:`, err.message);
      return false;
    }
  }

  async function startPolling() {
    if (_pollTimer) return;
    console.log(`[PythClient] 🚀 Starting PYTH price polling (5s interval)`);
    
    // Wire PYTH_API key for Hermes realtime (main reads secrets/PYTH_API.txt)
    try {
      if (typeof window !== 'undefined' && window.electron && typeof window.electron.getPublicEnv === 'function') {
        const cfg = await window.electron.getPublicEnv().catch(() => null);
        if (cfg) {
          PYTH_API_KEY = cfg.PYTH_API || cfg.PYTH_NEW || cfg.PYTH_NEW_API || cfg.PYTH_API_KEY || cfg.PYTH_LAZER_TOKEN || cfg.LAZER_TOKEN || PYTH_API_KEY;
          if (PYTH_API_KEY) console.log('[PythClient] Hermes realtime using key from PYTH_API');
        }
      }
    } catch (_) {}

    // First fetch immediately
    await fetchPythPrices();
    
    // Then poll every 5 seconds
    _pollTimer = setInterval(() => {
      fetchPythPrices().catch(e => console.error(`[PythClient] Poll error:`, e));
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      console.log(`[PythClient] ⏹️ Stopped PYTH price polling`);
    }
  }

  // Export API
  window.PythClient = {
    startPolling,
    stopPolling,
    getPrices: () => ({ ...window._pythPrices }),
    getPrice: (coin) => window._pythPrices[coin] || null,
    isReady: () => Object.keys(window._pythPrices).length > 0,
    lastPollTime: () => _lastPollTs,
  };

  console.log(`[PythClient] ✓ Module initialized`);
})();
