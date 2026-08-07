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

  const PYTH_HERMES_V2 = 'https://hermes.pyth.network/v2/updates/price/latest';
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
    BTC:  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    ETH:  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    SOL:  '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    XRP:  '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
    DOGE: '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
    BNB:  '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
    HYPE: '0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b',
  };

  const FEED_ID_TO_COIN = {};
  for (const [coin, idHex] of Object.entries(PYTH_FEEDS)) {
    FEED_ID_TO_COIN[idHex.replace(/^0x/i, '').toLowerCase()] = coin;
  }

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

      const feedIds = Object.values(PYTH_FEEDS);
      let url = `${PYTH_HERMES_V2}?${feedIds.map(id => 'ids[]=' + encodeURIComponent(id)).join('&')}`;
      const headers = {};
      if (PYTH_API_KEY) {
        url += '&api_key=' + encodeURIComponent(PYTH_API_KEY);
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
      if (!data || !Array.isArray(data.parsed)) {
        console.warn(`[PythClient] Unexpected Hermes v2 response structure`);
        return false;
      }

      // Parse symbol feed data
      const updated = {};
      data.parsed.forEach(f => {
        if (!f || !f.id || !f.price) return;
        const cleanId = String(f.id).replace(/^0x/i, '').toLowerCase();
        const coin = FEED_ID_TO_COIN[cleanId];
        if (coin) {
          const price = scalePythPrice(f.price.price, f.price.expo);
          if (price != null) {
            updated[coin] = price;
            window._pythPythMetadata[coin] = {
              price,
              expo: f.price.expo || 0,
              conf: f.price.conf || 0,
              publishTime: f.price.publish_time ? f.price.publish_time * 1000 : null,
            };
          }
        }
      });

      // Update global store
      Object.assign(window._pythPrices, updated);
      
      if (Object.keys(updated).length > 0) {
        _lastPollTs = Date.now();
        console.log(`[PythClient] ✅ Updated ${Object.keys(updated).length} prices via Hermes v2 (total: ${Object.keys(window._pythPrices).length})`);
        console.log(`[PythClient] ✅ Updated ${Object.keys(updated).length} prices (total: ${Object.keys(window._pythPrices).length})`);
        if (typeof window !== 'undefined') {
          try {
            window.dispatchEvent(new CustomEvent('pyth:tick', { detail: updated }));
          } catch (_) {}
          if (window.NetworkHealth && typeof window.NetworkHealth.update === 'function') {
            window.NetworkHealth.update('Pyth', {
              status: 'healthy',
              lastFetch: Date.now(),
              fallback: false,
              reason: '',
            });
          }
        }
      }

      return true;
    } catch (err) {
      console.warn(`[PythClient] Fetch failed:`, err.message);
      if (typeof window !== 'undefined' && window.NetworkHealth && typeof window.NetworkHealth.update === 'function') {
        window.NetworkHealth.update('Pyth', {
          status: 'degraded',
          lastFetch: Date.now(),
          fallback: true,
          reason: err.message,
        });
      }
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
