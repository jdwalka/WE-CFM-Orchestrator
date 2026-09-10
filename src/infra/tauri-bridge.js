// tauri-bridge.js — WE|||CRYPTO Proxy Bridge v3
// Routes all API calls through we-crypto-proxy (CORS + header spoofing)
// Works in both Tauri (sidecar proxy) and Electron (main.js spawns proxy) modes

(function () {
  'use strict';

  // ── Port discovery ───────────────────────────────────────────────────────────
  let _proxyPort = 3010;
  let _initPromise = null;
  let _proxyAvailable = false;
  let _lastInitAt = 0;
  let _lastInitErr = '';
  let _proxyMode = 'proxy';
  let _proxyModeReason = '';
  let _proxyFailures = 0;
  let _proxyBypassUntil = 0;

  function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function _jitter(baseMs) {
    return baseMs + Math.floor(Math.random() * Math.max(60, Math.floor(baseMs * 0.4)));
  }

  function _isRouteChurnError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      msg.includes('abort') ||
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('failed to fetch') ||
      msg.includes('network changed') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504')
    );
  }

  function _classifyNetworkFailure(err, context = {}) {
    const msg = String(err?.message || err || '').toLowerCase();
    const url = String(context.url || '');
    const proxied = String(context.proxied || '');

    if (
      msg.includes('name_not_resolved') ||
      msg.includes('enotfound') ||
      msg.includes('eai_again') ||
      msg.includes('dns')
    ) {
      return { kind: 'dns-fail', detail: msg, url, proxied };
    }
    if (
      msg.includes('cert') ||
      msg.includes('ssl') ||
      msg.includes('tls') ||
      msg.includes('self signed')
    ) {
      return { kind: 'tls-fail', detail: msg, url, proxied };
    }
    if (
      msg.includes('unexpected-response') ||
      msg.includes('handshake') ||
      msg.includes('upgrade')
    ) {
      return { kind: 'handshake-fail', detail: msg, url, proxied };
    }
    if (
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('abort')
    ) {
      return { kind: 'timeout', detail: msg, url, proxied };
    }
    if (msg.includes('network changed') || msg.includes('err_network_changed')) {
      return { kind: 'route-change', detail: msg, url, proxied };
    }
    if (msg.includes('econnreset') || msg.includes('socket hang up')) {
      return { kind: 'socket-reset', detail: msg, url, proxied };
    }
    return { kind: 'network-fail', detail: msg, url, proxied };
  }

  function _emitRouteEvent(stage, reason, extra = {}) {
    const detail = {
      stage,
      reason: reason || '',
      proxyPort: _proxyPort,
      lastInitAt: _lastInitAt || Date.now(),
      lastInitErr: _lastInitErr || '',
      ts: Date.now(),
      ...extra,
    };
    try {
      window.dispatchEvent(new CustomEvent('proxy-route-change', { detail }));
    } catch (_) { }
    try {
      if (stage === 'route-error' || stage === 'reinit-failed' || stage === 'network-failure') {
        window.NetworkLog?.record?.('TRANSPORT_FAIL', {
          provider: 'LocalProxy',
          url: 'proxy://route',
          error: `${stage}:${reason}`,
          failureClass: detail.failureClass || '',
        });
      } else if (stage === 'reinit-done') {
        window.NetworkLog?.record?.('TRANSPORT_OK', {
          provider: 'LocalProxy',
          url: 'proxy://route',
          error: `route-ready:${reason}`,
        });
      }
    } catch (_) { }
  }

  function _proxyState() {
    const now = Date.now();
    return {
      available: !!_proxyAvailable,
      healthy: !!_proxyAvailable && _proxyFailures < 3,
      mode: _proxyMode,
      reason: _proxyModeReason,
      bypassActive: now < _proxyBypassUntil,
      bypassMsLeft: Math.max(0, _proxyBypassUntil - now),
      failures: _proxyFailures,
      port: _proxyPort,
      lastInitAt: _lastInitAt || null,
      lastInitErr: _lastInitErr || '',
      ts: now,
    };
  }

  function _setProxyMode(mode, reason = '', extra = {}) {
    const normalized = mode === 'bypass' ? 'bypass' : 'proxy';
    _proxyMode = normalized;
    _proxyModeReason = String(reason || '');
    const detail = {
      ..._proxyState(),
      ...extra,
    };
    try {
      window.dispatchEvent(new CustomEvent('proxy-mode-update', { detail }));
    } catch (_) { }
    try {
      if (window.NetworkHealth?.update) {
        window.NetworkHealth.update('LocalProxy', {
          status: detail.mode === 'proxy' && detail.healthy ? 'healthy' : 'degraded',
          lastFetch: Date.now(),
          fallback: detail.mode === 'bypass',
          transient: detail.bypassActive || !detail.healthy,
          reason: detail.mode === 'bypass'
            ? `hybrid bypass (${detail.bypassMsLeft > 0 ? Math.round(detail.bypassMsLeft / 1000) + 's left' : 'active'})`
            : (detail.healthy ? 'proxy healthy' : `proxy degraded (${detail.failures} failures)`),
        });
      }
    } catch (_) { }
  }

  let _lastLoggedPort = null;
  let _lastForceReinitTs = 0;

  async function _init() {
    // 1. Try Tauri invoke to get the port the sidecar is on
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
      try {
        const port = await invoke('get_proxy_port');
        if (port && port > 0) {
          _proxyPort = port;
          if (_lastLoggedPort !== _proxyPort) {
            _lastLoggedPort = _proxyPort;
            console.log(`[BRIDGE] Tauri sidecar proxy on :${port}`);
          }
          return;
        }
      } catch (_) { /* fall through */ }
    }

    // 2. Poll /health on the default cascade
    for (const tryPort of [3010, 3011, 3012, 3013, 3014, 3015, 3016, 3017, 3018, 3019, 3020]) {
      try {
        const r = await fetch(`http://127.0.0.1:${tryPort}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          const txt = await r.text();
          if (txt.trim() === 'OK') {
            const d = await fetch(`http://127.0.0.1:${tryPort}/port`).then(r => r.json()).catch(() => ({ port: tryPort }));
            _proxyPort = d.port || tryPort;
            _proxyAvailable = true;
            if (Date.now() >= _proxyBypassUntil) {
              _proxyFailures = 0;
              _proxyBypassUntil = 0;
              _setProxyMode('proxy', 'proxy-discovered');
            }
            if (_lastLoggedPort !== _proxyPort) {
              _lastLoggedPort = _proxyPort;
              console.log(`[BRIDGE] proxy discovered on :${_proxyPort}`);
            }
            _lastInitAt = Date.now();
            _lastInitErr = '';
            return;
          }
        }
      } catch (_) { /* try next */ }
    }
    _proxyAvailable = false;
    _lastInitErr = 'proxy-not-found';
    _lastInitAt = Date.now();
    if (_lastLoggedPort !== 'none') {
      _lastLoggedPort = 'none';
      console.warn(`[BRIDGE] proxy not found, using default :${_proxyPort}`);
    }
    _setProxyMode('bypass', 'proxy-not-found');
  }

  function initOnce() {
    if (!_initPromise) _initPromise = _init();
    return _initPromise;
  }

  async function forceReinit(reason = 'route-change') {
    const now = Date.now();
    if (now - _lastForceReinitTs < 10000) {
      // Throttle reinit to avoid cascading discovery storms
      return initOnce();
    }
    _lastForceReinitTs = now;
    _initPromise = null;
    console.info(`[BRIDGE] re-initializing proxy discovery (${reason})`);
    _emitRouteEvent('reinit-start', reason);
    try {
      await initOnce();
      _emitRouteEvent('reinit-done', reason, { ok: !_lastInitErr });
    } catch (err) {
      _emitRouteEvent('reinit-failed', reason, { error: String(err?.message || err || 'reinit failed') });
      throw err;
    }
  }

  // ── Host → exchange slug map ─────────────────────────────────────────────────
  const HOST_MAP = {
    'api.binance.us':                  'binance-us',
    'api.binance.com':                 'binance',
    'data-api.binance.vision':         'binance-data',
    'fapi.binance.com':                'binance-f',
    'api.bybit.com':                   'bybit',
    'www.okx.com':                     'okx',
    'api.kraken.com':                  'kraken',
    'api.coinbase.com':                'coinbase',
    'api.exchange.coinbase.com':       'coinbase-ex',
    'api.mexc.com':                    'mexc',
    'api.kucoin.com':                  'kucoin',
    'api-pub.bitfinex.com':            'bitfinex',
    'api.crypto.com':                  'crypto-com',
    'api.coingecko.com':               'coingecko',
    'api.dexscreener.com':             'dexscreener',
    'gamma-api.polymarket.com':        'polymarket',
    'clob.polymarket.com':             'polymarket-clob',
    'data-api.polymarket.com':         'polymarket-data',
    'api.etherscan.io':                'etherscan',
    'api.bscscan.com':                 'bscscan',
    'eth.blockscout.com':              'blockscout-eth',
    'bsc.blockscout.com':              'blockscout-bsc',
    'api.blockchair.com':              'blockchair',
    'api.blockcypher.com':             'blockcypher',
    'mempool.space':                   'mempool',
    'api.hyperliquid.xyz':             'hyperliquid',
    'hypurrscan.io':                   'hypurrscan',
    'api.mainnet-beta.solana.com':     'solana',
    's2.ripple.com':                   'ripple',
    'xrplcluster.com':                 'xrpl',
  };

  const IGNORE_DOMAINS = /timeapi\.io|kalshi\.com|polymarket\.com/i;

  function _buildProxyUrl(originalUrl) {
    try {
      const u = new URL(originalUrl);
      if (IGNORE_DOMAINS.test(u.hostname)) return originalUrl;

      const slug = HOST_MAP[u.hostname];
      if (slug) {
        return `http://127.0.0.1:${_proxyPort}/${slug}${u.pathname}${u.search}`;
      }
      // Unknown host — use direct ?url= proxy
      if (u.protocol === 'https:') {
        return `http://127.0.0.1:${_proxyPort}/proxy?url=${encodeURIComponent(originalUrl)}`;
      }
    } catch (_) {}
    return originalUrl; // not a valid URL or already local
  }

  // ── Core fetch ───────────────────────────────────────────────────────────────
  window.proxyFetch = async function (url, options = {}) {
    if (!_proxyAvailable && (Date.now() - _lastInitAt > 15000)) {
       _initPromise = null;
    }
    await initOnce();
    try {
      const isGecko = /coingecko/i.test(String(url));
      if (isGecko && typeof window.coinGeckoUrl === 'function') url = window.coinGeckoUrl(url);
      if (isGecko && typeof window.withCoinGeckoAuth === 'function') options = window.withCoinGeckoAuth(url, options);
    } catch (_) { }

    const maxAttempts = Number.isFinite(options.retries) ? Math.max(1, options.retries) : 3;
    let lastErr = null;
    let lastDiag = null;
    let targetHost = '';
    let targetProvider = '';
    try {
      const parsed = new URL(String(url));
      targetHost = parsed.hostname || '';
      targetProvider = HOST_MAP[targetHost] || '';
    } catch (_) { }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const bypassActive = Date.now() < _proxyBypassUntil;
      const forceProxy = !!options.forceProxy;
      const useProxy = _proxyAvailable && (forceProxy || !bypassActive);
      const proxied = useProxy ? _buildProxyUrl(url) : url;
      try {
        const response = await fetch(proxied, {
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body
            ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
            : undefined,
          signal: options.signal,
        });

        if ([502, 503, 504].includes(response.status) && attempt < maxAttempts) {
          if (useProxy) {
            _proxyFailures++;
            _proxyBypassUntil = Date.now() + _jitter(20_000);
            _setProxyMode('bypass', `proxy-http-${response.status}`, { attempt, proxied });
          }
          const failureClass = `proxy-http-${response.status}`;
          _emitRouteEvent('route-error', `http-${response.status}`, {
            attempt,
            proxied,
            provider: targetProvider,
            host: targetHost,
            proxyUsed: useProxy,
            failureClass,
          });
          // On next attempt, bypassActive is true so it will immediately fetch direct
          await _sleep(_jitter(60 * attempt));
          continue;
        }
        if (useProxy) {
          _proxyFailures = 0;
          _proxyBypassUntil = 0;
          _setProxyMode('proxy', 'proxy-ok', { attempt, proxied });
        }
        return response;
      } catch (err) {
        lastErr = err;
        const diag = _classifyNetworkFailure(err, { url, proxied });
        lastDiag = diag;
        if (_isRouteChurnError(err) && attempt < maxAttempts && useProxy) {
          _proxyFailures++;
          _proxyBypassUntil = Date.now() + _jitter(20_000);
          _setProxyMode('bypass', 'proxy-route-churn', {
            attempt,
            proxied,
            error: String(err?.message || err || 'route churn'),
          });
          _emitRouteEvent('route-error', 'transient-network-error', {
            attempt,
            proxied,
            error: String(err?.message || err || 'network error'),
            provider: targetProvider,
            host: targetHost,
            proxyUsed: useProxy,
            failureClass: diag.kind,
          });
          await _sleep(_jitter(60 * attempt));
          continue;
        }

        // Direct-path failures should be visible for diagnostics, but must not
        // trigger proxy route churn recovery loops.
        _emitRouteEvent('network-failure', diag.kind, {
          attempt,
          proxied,
          provider: targetProvider,
          host: targetHost,
          proxyUsed: useProxy,
          failureClass: diag.kind,
          error: String(err?.message || err || 'network error'),
        });

        // Last-resort fallback: if proxy path is failing, try direct URL once.
        if (proxied !== url && attempt === maxAttempts) {
          try {
            return await fetch(url, {
              method: options.method || 'GET',
              headers: options.headers || {},
              body: options.body
                ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
                : undefined,
              signal: options.signal,
            });
          } catch (_) { /* preserve original error below */ }
        }
        throw err;
      }
    }

    if (lastDiag) {
      _setProxyMode(_proxyMode, `${lastDiag.kind}:${_proxyModeReason || 'network-failure'}`);
    }
    throw lastErr || new Error('proxyFetch failed');
  };

  // ── Legacy compat ────────────────────────────────────────────────────────────
  window.bouncerFetch = async function (category, url, options = {}) {
    const r = await window.proxyFetch(url, options);
    return r.text();
  };

  window.priceFetch  = (url, opts) => window.proxyFetch(url, opts);
  window.binaryFetch = (url, opts) => window.proxyFetch(url, opts);
  window.suppFetch   = (url, opts) => window.proxyFetch(url, opts);
  window.refreshProxyRoute = (reason) => forceReinit(reason || 'manual-refresh');
  window.ProxyTransport = {
    getState: _proxyState,
    forceBypass(ms = 15_000, reason = 'manual') {
      _proxyBypassUntil = Date.now() + Math.max(1000, Number(ms) || 15_000);
      _setProxyMode('bypass', reason);
      return _proxyState();
    },
    clearBypass(reason = 'manual-clear') {
      _proxyFailures = 0;
      _proxyBypassUntil = 0;
      _setProxyMode('proxy', reason);
      return _proxyState();
    },
  };

  // Auto-init on load
  initOnce();
  console.log('[BRIDGE] WE|||CRYPTO proxy bridge v3 loaded');
})();
