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
  // Hermes' /v2/updates/price/latest requires a Pyth Pro-entitled key (secrets/PYTH_PRO_API_KEY.txt)
  // -- the Lazer streaming token (PYTH_NEW_API) is a distinct product and 401s/403s here.
  // hermes.pyth.network is Pyth's PUBLIC Hermes instance: the standard price
  // endpoints take NO auth. We therefore fetch anonymously first and only
  // attach `Authorization: Bearer` as a *retry* on 401/403/429, and only with a
  // key that is actually Pro-entitled. The Lazer streaming token
  // PYTH_NEW_API is NOT valid here -- sending it as
  // a Bearer makes the gateway 401 a request that would have succeeded with no
  // header at all, which is what took the spot feed down. Keep it out entirely.
  let pythHermesProKey = '';
  const PRO_KEY_NAMES = ['PYTH_PRO_API_KEY', 'PYTH_HERMES_PRO_KEY', 'HERMES_PRO_API_KEY', 'PYTH_HERMES_TOKEN'];
  function _firstKey(getter) {
    for (const name of PRO_KEY_NAMES) {
      try { const v = getter(name); if (v) return v; } catch (_) {}
    }
    return '';
  }
  try {
    if (typeof window !== 'undefined') {
      if (window.resolveRuntimeKey) {
        const k = _firstKey(window.resolveRuntimeKey);
        if (k) pythHermesProKey = k;
      }
      if (window.__env) {
        const k = _firstKey((n) => window.__env[n]);
        if (k) pythHermesProKey = k;
      }
      if (typeof process !== 'undefined' && process.env) {
        const k = _firstKey((n) => process.env[n]);
        if (k) pythHermesProKey = k;
      }
      if (window.electron && typeof window.electron.getPublicEnv === 'function') {
        window.electron.getPublicEnv().then(cfg => {
          if (cfg) {
            const k = _firstKey((n) => cfg[n]);
            if (k) pythHermesProKey = k;
          }
        }).catch(() => {});
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
  window._pythPrices = window._pythPrices || Object.create(null);
  window._pythPythMetadata = window._pythPythMetadata || Object.create(null);

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
        ctrl.abort(new DOMException('Pyth Hermes timed out after 3500ms', 'TimeoutError'));
      } catch (_) {
        try { ctrl.abort(); } catch (_) { }
      }
    }, 3500);
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

  // Fast Douro Labs Lazer proxy fallback (sub-100ms, no auth needed)
  async function _fetchDouroLazerProxy() {
    const proxies = [
      'pyth-lazer-proxy-1.dourolabs.app',
      'pyth-lazer-proxy-2.dourolabs.app',
      'pyth-lazer-proxy-3.dourolabs.app',
    ];
    const qs = 'price_feed_ids=1&price_feed_ids=2&price_feed_ids=6&price_feed_ids=10&price_feed_ids=13&price_feed_ids=14&price_feed_ids=15';
    const lazerIdToCoin = {
      1: 'BTC', 2: 'ETH', 6: 'SOL', 10: 'DOGE', 13: 'DOGE', 14: 'XRP', 15: 'BNB'
    };

    const queryProxy = async (host) => {
      const resp = await _timedFetch(`https://${host}/v1/latest_price?${qs}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      const out = {};
      for (const f of json.priceFeeds || []) {
        const coin = lazerIdToCoin[f.priceFeedId];
        if (!coin) continue;
        const exp = f.exponent ?? -8;
        const scale = Math.pow(10, exp);
        const price = Number(f.price) * scale;
        if (!price || price <= 0 || isNaN(price)) continue;
        out[coin] = {
          price,
          expo: exp,
          conf: f.confidence != null ? Number(f.confidence) * scale : 0,
          publishTime: f.publishTime ? Number(f.publishTime) * 1000 : Date.now(),
        };
      }
      if (Object.keys(out).length < 4) throw new Error('Insufficient feeds');
      return out;
    };

    try {
      const feeds = await Promise.any(proxies.map(p => queryProxy(p)));
      return { feeds, via: 'douro-lazer-proxy' };
    } catch (_) {
      return null;
    }
  }

  // Primary Hermes v2 fetch with Bearer token, fallback to Douro Labs proxy, then legacy
  async function _fetchHermes() {
    const feedIds = Object.values(PYTH_FEEDS);
    const v2Url = `${PYTH_HERMES_V2}?${feedIds.map(id => 'ids[]=' + encodeURIComponent(id)).join('&')}`;

    // Douro Labs' Lazer proxy is public, sub-100ms, and currently the most
    // reliable route. Prefer it and avoid the noisy Hermes 403/401 console
    // response entirely; Hermes remains a fully authenticated fallback.
    const lazerFirst = await _fetchDouroLazerProxy();
    if (lazerFirst && Object.keys(lazerFirst.feeds).length >= 4) {
      return lazerFirst;
    }

    const headers = pythHermesProKey ? { Authorization: `Bearer ${pythHermesProKey}` } : {};
    let resp = null;
    try {
      resp = await _timedFetch(v2Url, headers);
      if ((resp.status === 401 || resp.status === 403) && !headers.Authorization && pythHermesProKey) {
        resp = await _timedFetch(v2Url, { Authorization: `Bearer ${pythHermesProKey}` });
      }
    } catch (e) {
      console.warn(`[PythClient] Hermes v2 network error: ${e.message}`);
    }

    if (resp && resp.ok) {
      const data = await resp.json().catch(() => null);
      if (data && Array.isArray(data.parsed)) return { feeds: _parseHermesFeeds(data.parsed), via: 'hermes-v2' };
    } else if (resp) {
      console.warn(`[PythClient] Hermes v2 HTTP ${resp.status}`);
    }

    // High-speed Douro Labs Lazer proxy fallback (sub-100ms)
    const lazerResult = await _fetchDouroLazerProxy();
    if (lazerResult && Object.keys(lazerResult.feeds).length >= 4) {
      return lazerResult;
    }

    // Legacy public fallback: /api/latest_price_feeds
    try {
      const legacyUrl = `${PYTH_HERMES}?${feedIds.map(id => 'ids[]=' + encodeURIComponent(id)).join('&')}`;
      const legacy = await _timedFetch(legacyUrl, {});
      if (legacy.ok) {
        const arr = await legacy.json().catch(() => null);
        if (Array.isArray(arr)) {
          return { feeds: _parseHermesFeeds(arr), via: 'hermes-legacy' };
        }
      }
    } catch (_) {}

    return { feeds: {}, via: 'none' };
  }

  let _isFetching = false;
  async function fetchPythPrices() {
    if (_isFetching) return false;
    _isFetching = true;
    try {
      const { feeds, via } = await _fetchHermes();

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
    } finally {
      _isFetching = false;
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
          if (k) { pythHermesProKey = k; console.log('[PythClient] Hermes Pro key available for auth retry'); }
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
