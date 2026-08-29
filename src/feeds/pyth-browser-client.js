/**
 * PYTH Browser-Compatible Price Feed
 * 
 * Hermes REST API for price verification (no WebSocket required)
 * Fetches every 5 seconds for Polymarket settlement divergence detection
 * 
 * Stored in: window._pythPrices = { BTC: price, ETH: price, ... }
 */

(function () {
  'use strict';

  const PYTH_HERMES_V2 = 'https://hermes.pyth.network/v2/updates/price/latest';
  const PYTH_HERMES = 'https://hermes.pyth.network/api/latest_price_feeds';
  // hermes.pyth.network is Pyth's PUBLIC Hermes instance: the standard price
  // endpoints take NO auth. We therefore fetch anonymously first and only
  // attach `Authorization: Bearer` as a *retry* on 401/403/429, and only with a
  // key that is actually Pro-entitled. The Lazer streaming token
  // (PYTH_LAZER_TOKEN / PYTH_API / PYTH_NEW*) is NOT valid here -- sending it as
  // a Bearer makes the gateway 401 a request that would have succeeded with no
  // header at all, which is what took the spot feed down. Keep it out entirely.
  let PYTH_API_KEY = ''; // Pro key only -- used for the auth retry, never first.
  const PRO_KEY_NAMES = ['PYTH_PRO_API_KEY', 'PYTH_HERMES_PRO_KEY', 'HERMES_PRO_API_KEY'];
  function _firstKey(getter) {
    for (const name of PRO_KEY_NAMES) {
      try { const v = getter(name); if (v) return v; } catch (_) {}
    }
    return '';
  }
  try {
    if (typeof window !== 'undefined') {
      if (window.resolveRuntimeKey) {
        PYTH_API_KEY = _firstKey(window.resolveRuntimeKey);
      }
      if (!PYTH_API_KEY && window.__env) {
        PYTH_API_KEY = _firstKey((n) => window.__env[n]);
      }
      if (!PYTH_API_KEY && typeof process !== 'undefined' && process.env) {
        PYTH_API_KEY = _firstKey((n) => process.env[n]);
      }
      if (!PYTH_API_KEY && window.electron && typeof window.electron.getPublicEnv === 'function') {
        window.electron.getPublicEnv().then(cfg => {
          if (cfg) {
            const k = _firstKey((n) => cfg[n]);
            if (k) PYTH_API_KEY = k;
          }
        }).catch(() => {});
      }
    }
  } catch (_) { }
  // Support new Pyth key from secrets/PYTH_NEW_API wired via public env or resolveRuntimeKey
  let PYTH_API_KEY = '';
  function resolvePythKey() {
    try {
      if (typeof window !== 'undefined') {
        const k = (window.resolveRuntimeKey && (
          window.resolveRuntimeKey('PYTH_PRO_API_KEY') ||
          window.resolveRuntimeKey('PYTH_PRO') ||
          window.resolveRuntimeKey('PYTH_API') ||
          window.resolveRuntimeKey('PYTH_NEW') ||
          window.resolveRuntimeKey('PYTH_NEW_API') ||
          window.resolveRuntimeKey('PYTH_API_KEY')
        )) || (window.__env && (
          window.__env.PYTH_PRO_API_KEY ||
          window.__env.PYTH_PRO ||
          window.__env.PYTH_API ||
          window.__env.PYTH_NEW ||
          window.__env.PYTH_NEW_API ||
          window.__env.PYTH_API_KEY
        )) || (window.__wecrypto_env && (
          window.__wecrypto_env.PYTH_PRO_API_KEY ||
          window.__wecrypto_env.PYTH_PRO ||
          window.__wecrypto_env.PYTH_API ||
          window.__wecrypto_env.PYTH_NEW
        ));
        if (k) return k;
      }
      if (typeof process !== 'undefined' && process.env) {
        return process.env.PYTH_PRO_API_KEY || process.env.PYTH_PRO || process.env.PYTH_API || process.env.PYTH_NEW || process.env.PYTH_NEW_API || process.env.PYTH_API_KEY || '';
      }
    } catch (_) {}
    return '';
  }
  PYTH_API_KEY = resolvePythKey();

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

  // One timed fetch. Returns the parsed Response or throws.
  async function _timedFetch(url, headers) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => {
      try {
        ctrl.abort(new DOMException('Pyth Hermes timed out after 7000ms', 'TimeoutError'));
      } catch (_) {
        try { ctrl.abort(); } catch (_) { }
      }
    }, 7000);
    try {
      return await fetch(url, { signal: ctrl.signal, headers: headers && Object.keys(headers).length ? headers : undefined });
    } finally {
      clearTimeout(timeout);
    }
  }

  // Normalise both Hermes shapes into { COIN: {price, expo, conf, publishTime} }.
  function _parseHermesFeeds(list) {
    const out = {};
    (Array.isArray(list) ? list : []).forEach(f => {
      const priceObj = f && f.price;
      if (!f || !f.id || !priceObj || typeof priceObj !== 'object') return;
      const cleanId = String(f.id).replace(/^0x/i, '').toLowerCase();
      const coin = FEED_ID_TO_COIN[cleanId];
      if (!coin) return;
      const price = scalePythPrice(priceObj.price, priceObj.expo);
      if (price == null) return;
      out[coin] = {
        price,
        expo: priceObj.expo || 0,
        conf: priceObj.conf || 0,
        publishTime: priceObj.publish_time ? priceObj.publish_time * 1000 : null,
      };
    });
    return out;
  }

  // Public Hermes takes no auth. Try anonymous; retry with a Pro Bearer only
  // on 401/403/429; then fall back to the legacy public endpoint.
  async function _fetchHermes() {
    const feedIds = Object.values(PYTH_FEEDS);
    const v2Url = `${PYTH_HERMES_V2}?${feedIds.map(id => 'ids[]=' + encodeURIComponent(id)).join('&')}`;

    let resp = await _timedFetch(v2Url, {});
    if ((resp.status === 401 || resp.status === 403 || resp.status === 429) && PYTH_API_KEY) {
      console.warn(`[PythClient] Hermes v2 anon HTTP ${resp.status}; retrying with Pro key`);
      resp = await _timedFetch(v2Url, { Authorization: `Bearer ${PYTH_API_KEY}` });
    }
    if (resp.ok) {
      const data = await resp.json();
      if (data && Array.isArray(data.parsed)) return { feeds: _parseHermesFeeds(data.parsed), via: 'hermes-v2' };
      console.warn('[PythClient] Unexpected Hermes v2 response structure');
    } else {
      console.warn(`[PythClient] Hermes v2 HTTP ${resp.status}`);
    }

    // Legacy public fallback: /api/latest_price_feeds -> flat array of feeds.
    const legacyUrl = `${PYTH_HERMES}?${feedIds.map(id => 'ids[]=' + encodeURIComponent(id)).join('&')}`;
    const legacy = await _timedFetch(legacyUrl, {});
    if (legacy.ok) {
      const arr = await legacy.json();
      return { feeds: _parseHermesFeeds(arr), via: 'hermes-legacy' };
    }
    console.warn(`[PythClient] Hermes legacy HTTP ${legacy.status}`);
    return { feeds: {}, via: 'none' };
  }

  async function fetchPythPrices() {
    try {
      const { feeds, via } = await _fetchHermes();
  async function fetchPythPrices() {
    try {
      if (!PYTH_API_KEY) PYTH_API_KEY = resolvePythKey();

      const ctrl = new AbortController();
      const timeout = setTimeout(() => {
        try {
          ctrl.abort(new DOMException('Pyth Hermes timed out after 7000ms', 'TimeoutError'));
        } catch (_) {
          try { ctrl.abort(); } catch (_) { }
        }
      }, 7000);

      const feedIds = Object.values(PYTH_FEEDS);
      const url = `${PYTH_HERMES_V2}?${feedIds.map(id => 'ids[]=' + encodeURIComponent(id)).join('&')}`;
      const headers = { 'Accept': 'application/json' };
      if (PYTH_API_KEY) {
        headers['Authorization'] = `Bearer ${PYTH_API_KEY}`;
        headers['x-api-key'] = PYTH_API_KEY;
      }
      
      let data = null;
      if (typeof window !== 'undefined' && window.electron && typeof window.electron.ipcFetch === 'function') {
        const res = await window.electron.ipcFetch(url, { headers });
        if (!res || !res.ok) {
          console.warn(`[PythClient] HTTP ${res?.status} from Hermes API via IPC:`, res?.error);
          return false;
        }
        data = typeof res.text === 'string' ? JSON.parse(res.text) : res.text;
      } else {
        const resp = await fetch(url, { signal: ctrl.signal, headers });
        if (!resp.ok) {
          console.warn(`[PythClient] HTTP ${resp.status} from Hermes API`);
          return false;
        }
        data = await resp.json();
      }
      clearTimeout(timeout);
      
      if (!data || !Array.isArray(data.parsed)) {
        console.warn(`[PythClient] Unexpected Hermes v2 response structure`);
        return false;
      }

      // Parse symbol feed data
      const updated = {};
      for (const [coin, meta] of Object.entries(feeds)) {
        updated[coin] = meta.price;
        window._pythPythMetadata[coin] = meta;
      }
      if (Object.keys(updated).length === 0) {
        if (typeof window !== 'undefined' && window.NetworkHealth && typeof window.NetworkHealth.update === 'function') {
          window.NetworkHealth.update('Pyth', {
            status: 'degraded', lastFetch: Date.now(), fallback: true,
            reason: 'Hermes returned no usable feeds',
          });
        }
        return false;
      }
      if (via === 'hermes-legacy') console.log('[PythClient] served via legacy Hermes endpoint');

      // Update global store
      Object.assign(window._pythPrices, updated);
      _lastPollTs = Date.now();
      console.log(`[PythClient] ✅ Updated ${Object.keys(updated).length} prices via ${via} (total: ${Object.keys(window._pythPrices).length})`);
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('pyth:tick', { detail: updated }));
        } catch (_) {}
        if (window.NetworkHealth && typeof window.NetworkHealth.update === 'function') {
          window.NetworkHealth.update('Pyth', {
            status: 'healthy',
            lastFetch: Date.now(),
            fallback: via === 'hermes-legacy',
            reason: via === 'hermes-legacy' ? 'primary Hermes v2 unavailable; on legacy endpoint' : '',
          });
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
    
    // Pick up a Pro Hermes key if one is configured (used only for the auth
    // retry on 401/403/429 -- anonymous is the primary path). Never the Lazer
    // token: it is not valid for Hermes and only causes gateway 401s.
    try {
      if (typeof window !== 'undefined' && window.electron && typeof window.electron.getPublicEnv === 'function') {
        const cfg = await window.electron.getPublicEnv().catch(() => null);
        if (cfg) {
          const k = _firstKey((n) => cfg[n]);
          if (k) { PYTH_API_KEY = k; console.log('[PythClient] Hermes Pro key available for auth retry'); }
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
  // Alias — oracle-snapshot.js / grok-range-overlay.js look for window.PythBrowser first.
  window.PythBrowser = window.PythClient;

  // Auto-start polling on module load immediately
  try {
    startPolling();
  } catch (_) {}

  console.log(`[PythClient] ✓ Module initialized (auto-polling active)`);
})();
