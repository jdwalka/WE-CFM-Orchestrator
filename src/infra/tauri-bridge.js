// tauri-bridge.js — WE|||CRYPTO Proxy Bridge v3
// Routes all API calls through we-crypto-proxy (CORS + header spoofing)
// Works in both Tauri (sidecar proxy) and Electron (main.js spawns proxy) modes

(function () {
  'use strict';

  // ── Port discovery ───────────────────────────────────────────────────────────
  const TAURI_INVOKE_TIMEOUT_MS = 250;
  const PROXY_HEALTH_TIMEOUT_MS = 350;
  const PROXY_PORT_CACHE_KEY = '__we_tauri_proxy_port_cache__';
  const PROXY_DISABLED_CACHE_KEY = '__we_disable_tauri_db_proxy__';
  let _proxyPort = 3010;
  let _cachedProxyPort = null;
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

  function _readCachedProxyPort() {
    try {
      const port = Number(window.localStorage?.getItem?.(PROXY_PORT_CACHE_KEY));
      return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
    } catch (_) {
      return null;
    }
  }

  function _writeCachedProxyPort(port) {
    try {
      window.localStorage?.setItem?.(PROXY_PORT_CACHE_KEY, String(port));
    } catch (_) { }
  }

  function _readProxyDisabledFlag() {
    try {
      const configValue = window.__WECRYPTO_CONFIG__?.disableTauriDbProxy;
      const explicitValue = window.__WE_DISABLE_TAURI_DB_PROXY__;
      const persistedValue = window.localStorage?.getItem?.(PROXY_DISABLED_CACHE_KEY);
      return configValue === true || explicitValue === true || persistedValue === 'true';
    } catch (_) {
      return false;
    }
  }

  function _withTimeout(promise, timeoutMs, label) {
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
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

  // Transport priority: WSS → gRPC → RPC → HTTP. The local HTTP proxy is the
  // HTTP-leg transport only — it must never poison WSS/gRPC/RPC legs.
  // Hence: upstream HTTP status (502/503/504 = provider rejected via proxy)
  // is a PER-REQUEST signal (retry that request direct), never a global
  // bypass. Global bypass fires ONLY when the proxy process itself is
  // unreachable (connection refused to 127.0.0.1 / /health down).
  const PROXY_DOWN_BYPASS_MS = 3000;
  const PROXY_CASCADE_PORTS = [
    3010, 3011, 3012, 3013, 3014, 3015, 3016, 3017, 3018, 3019, 3020,
    3009, 3008, 3007, 3006, 3005, 3004, 3003, 3002, 3001, 3000,
    // NOTE: 8080/8000/4000/5000/9000 deliberately excluded — :8080 is a
    // local nginx trap (200 'OK' on /health, 404 on every real route).
  ];

  function _isProxyConnectionError(err, proxiedUrl) {
    try {
      const u = new URL(String(proxiedUrl || ''));
      const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname);
      if (!isLocal) return false;
    } catch (_) {
      return false;
    }
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      msg.includes('failed to fetch') ||
      msg.includes('econnrefused') ||
      msg.includes('connection refused') ||
      msg.includes('networkerror') ||
      msg.includes('load failed') ||
      msg.includes('enetunreach') ||
      msg.includes('econnreset') && msg.includes('127.0.0.1')
    );
  }

  function _proxyState() {
    const now = Date.now();
    const bypassActive = now < _proxyBypassUntil;
    // HEALTHY = proxy process reachable. A single upstream rejecting via the
    // proxy (502/503/504 for one host) must NOT mark LocalProxy degraded —
    // that failure belongs to that provider, handled by its per-host breaker.
    const healthy = !!_proxyAvailable && !_proxyDisabled;
    return {
      available: !!_proxyAvailable,
      healthy,
      enabled: !_proxyDisabled,
      mode: _proxyMode,
      reason: _proxyModeReason,
      bypassActive,
      bypassMsLeft: Math.max(0, _proxyBypassUntil - now),
      failures: _proxyFailures,
      port: _proxyPort,
      cachedPort: _cachedProxyPort,
      tauriInvokeTimeoutMs: TAURI_INVOKE_TIMEOUT_MS,
      healthTimeoutMs: PROXY_HEALTH_TIMEOUT_MS,
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
        // Single source of truth with network-health.js updateTransport:
        // bypass with a live proxy process = HEALTHY + fallback=true
        // (per-request direct retry). DEGRADED only when proxy down/disabled.
        const proxyUp = !!detail.available && detail.enabled !== false;
        window.NetworkHealth.update('LocalProxy', {
          status: proxyUp ? 'healthy' : 'degraded',
          lastFetch: Date.now(),
          fallback: detail.mode === 'bypass' || !!detail.bypassActive,
          transient: !proxyUp || !!detail.bypassActive,
          reason: detail.mode === 'bypass'
            ? `hybrid bypass (${detail.bypassMsLeft > 0 ? Math.round(detail.bypassMsLeft / 1000) + 's left' : 'active'})`
            : (proxyUp ? 'proxy healthy' : `proxy degraded (${detail.failures} failures)`),
        });
      }
    } catch (_) { }
  }

  let _lastLoggedPort = null;
  let _lastForceReinitTs = 0;
  let _proxyDisabled = _readProxyDisabledFlag();
  _cachedProxyPort = _readCachedProxyPort();

  // XHR-based local probe: bypasses the window.fetch patch (no breaker /
  // rewrite re-entrancy) and fails silently without fetch-promise logging.
  function _xhrGetText(url, timeoutMs) {
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.timeout = timeoutMs;
        xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, text: xhr.responseText || '' });
        xhr.onerror = () => resolve({ ok: false, text: '' });
        xhr.ontimeout = () => resolve({ ok: false, text: '' });
        xhr.open('GET', url, true);
        xhr.send();
      } catch (_) {
        resolve({ ok: false, text: '' });
      }
    });
  }

  let _initInFlight = false;

  async function _init() {
    _proxyDisabled = _readProxyDisabledFlag();
    if (_proxyDisabled) {
      _proxyAvailable = false;
      _lastInitAt = Date.now();
      _lastInitErr = 'proxy-disabled';
      _setProxyMode('bypass', 'proxy-disabled');
      return;
    }

    // 1. Try Tauri invoke to get the port the sidecar is on
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
      try {
        const port = await _withTimeout(invoke('get_proxy_port'), TAURI_INVOKE_TIMEOUT_MS, 'Tauri proxy discovery');
        if (port && port > 0) {
          _proxyPort = port;
          _cachedProxyPort = port;
          _proxyAvailable = true;
          _writeCachedProxyPort(port);
          if (Date.now() >= _proxyBypassUntil) {
            _proxyFailures = 0;
            _proxyBypassUntil = 0;
            _setProxyMode('proxy', 'tauri-discovered');
          }
          _lastInitAt = Date.now();
          _lastInitErr = '';
          if (_lastLoggedPort !== _proxyPort) {
            _lastLoggedPort = _proxyPort;
            console.log(`[BRIDGE] Tauri sidecar proxy on :${port}`);
          }
          return;
        }
      } catch (_) { /* fall through */ }
    }

    // 2. Verify a cached last-good port before scanning the cascade.
    // Must match proxy/src/main.rs bind_cascade() + proxy-fetch.js cascade.
    // Latch the LOWEST healthy port, not the first: a stale proxy binary
    // can linger on a higher port (missing newer routes) while a fresh one
    // serves lower — first-hit latching wedges the app behind the stale one.
    const ports = _cachedProxyPort ? [_cachedProxyPort] : [];
    for (const p of PROXY_CASCADE_PORTS) {
      if (!ports.includes(p)) ports.push(p);
    }
    let bestPort = 0;
    for (const tryPort of ports) {
      // Silent XHR probe (see _xhrGetText): dead ports fail quiet, no
      // 'Failed to load resource' wall in the console per sweep.
      const h = await _xhrGetText(`http://127.0.0.1:${tryPort}/health`, PROXY_HEALTH_TIMEOUT_MS);
      if (!h.ok || h.text.trim() !== 'OK') continue;
      // Identity check: /health 'OK' is also served by unrelated local
      // servers (nginx :8080 returns 200 'OK' but 404s every real route).
      // Only latch when /port proves it is OUR proxy on THIS port.
      let identityOk = false;
      try {
        const p = await _xhrGetText(`http://127.0.0.1:${tryPort}/port`, PROXY_HEALTH_TIMEOUT_MS);
        const d = JSON.parse(p.text || '{}');
        identityOk = p.ok && Number(d && d.port) === tryPort;
      } catch (_) {
        identityOk = false;
      }
        if (!identityOk) {
          // Poisoned cache entry (e.g. a stale :8080): drop it so the next
          // launch sweeps clean instead of latching a dead port first.
          if (tryPort === _cachedProxyPort) {
            _cachedProxyPort = null;
            try { window.localStorage?.removeItem?.(PROXY_PORT_CACHE_KEY); } catch (_) { }
          }
          continue;
        }
        if (!bestPort || tryPort < bestPort) bestPort = tryPort;
    }
    if (bestPort) {
        {
          _proxyPort = bestPort;
          _cachedProxyPort = _proxyPort;
          _proxyAvailable = true;
          _writeCachedProxyPort(_proxyPort);
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
    // In-flight guard: concurrent proxyFetch calls during boot must share
    // one sweep — otherwise N callers × 21 ports = a console wall and a
    // discovery storm.
    if (!_initPromise) {
      _initInFlight = true;
      _initPromise = _init().then(
        (v) => { _initInFlight = false; return v; },
        (e) => { _initInFlight = false; throw e; },
      );
    }
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
    'dapi.binance.com':                'binance-d',
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
    'api.gemini.com':                  'gemini',
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

  // Mirror of proxy-fetch.js CF_PROTECTED: hosts that REQUIRE the proxy
  // (CF Bot Mgmt / geo-restricted). A 403/404 for these via proxy must NOT
  // retry direct — direct is blocked by design. A 403/404 for any other
  // host (e.g. Bitstamp's Incapsula rejecting proxied TLS while direct
  // returns 200, or a stale proxy binary missing a route) retries direct
  // once for THIS request, same as 502/503/504.
  const CF_PROTECTED_TB = new Set([
    'api.binance.com',
    'fapi.binance.com',
    'dapi.binance.com',
    'data-api.binance.vision',
    'api.bybit.com',
    'api.bytick.com',
    'api.kraken.com',
    'www.kraken.com',
    'api.hyperliquid.xyz',
    'www.okx.com',
    'api.okx.com',
    'api-pub.bitfinex.com',
    'api.kucoin.com',
    'api.mexc.com',
    'api.crypto.com',
    'api.bitvavo.com',
    'api.upbit.com',
  ]);

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
    // Never orphan an in-flight sweep: resetting _initPromise while a sweep
    // runs leaves the orphan probing AND starts a duplicate (boot storm).
    if (!_proxyAvailable && !_initInFlight && (Date.now() - _lastInitAt > 15000)) {
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
      // Global bypass ONLY when the proxy process itself is down. A single
      // upstream rejecting via the proxy must not flip every other host to
      // direct (that was the "fallback bullshit": one 502 → 20s global
      // bypass → CF-protected hosts fail direct → dashboard flaps).
      // Per-request direct retry is handled below without touching globals.
      const useProxy = _proxyAvailable && (forceProxy || !bypassActive);
      const proxied = useProxy ? _buildProxyUrl(url) : url;
      // Per-request flag: this attempt's upstream rejected via proxy, so the
      // NEXT attempt for THIS request goes direct — no global state change.
      try {
        const response = await fetch(proxied, {
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body
            ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
            : undefined,
          signal: options.signal,
        });

        // Gateway errors (502/503/504) always retry direct. Refusals
        // (403/404) retry direct ONLY for non-CF hosts — CF-protected
        // hosts are blocked direct by design, so retrying is pure spam.
        const retryableGateway = [502, 503, 504].includes(response.status);
        const retryableRefusal = (response.status === 403 || response.status === 404)
          && !CF_PROTECTED_TB.has(targetHost);
        if (retryableGateway || retryableRefusal) {
          // Upstream rejected VIA proxy (provider edge, flagged egress IP,
          // rate limit). NOT proxy-down. Emit per-host diagnostics so the
          // per-host breaker (proxy-fetch.js) and EndpointTransport circuit
          // can demote THIS route, then retry THIS request direct.
          const failureClass = `proxy-http-${response.status}`;
          _emitRouteEvent('route-error', `http-${response.status}`, {
            attempt,
            proxied,
            provider: targetProvider,
            host: targetHost,
            proxyUsed: useProxy,
            failureClass,
            perRequestFallback: useProxy,
          });
          if (useProxy && proxied !== url) {
            // Request-scoped fallback: try direct once for this request —
            // even on the last attempt (single-attempt callers like the
            // health probes must still fail over, not just report).
            if (attempt < maxAttempts) await _sleep(_jitter(60 * attempt));
            try {
              const directRes = await fetch(url, {
                method: options.method || 'GET',
                headers: options.headers || {},
                body: options.body
                  ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
                  : undefined,
                signal: options.signal,
              });
              // Direct succeeded (or gave a non-gateway status) — return it.
              // Do NOT touch _proxyBypassUntil / _proxyFailures / mode.
              return directRes;
            } catch (_) {
              // Direct also failed — fall through to normal retry loop.
            }
          }
          if (attempt < maxAttempts) {
            await _sleep(_jitter(60 * attempt));
            continue;
          }
          return response;
        }
        if (useProxy && response.ok) {
          // Successful proxied response clears stale proxy-down counters only.
          // Upstream non-gateway statuses (4xx) are provider signals, not
          // proxy health signals — leave counters alone.
          if (_proxyFailures > 0 && Date.now() >= _proxyBypassUntil) {
            _proxyFailures = 0;
            _setProxyMode('proxy', 'proxy-ok', { attempt, proxied });
          }
        }
        return response;
      } catch (err) {
        lastErr = err;
        const diag = _classifyNetworkFailure(err, { url, proxied });
        lastDiag = diag;
        const proxyDown = useProxy && _isProxyConnectionError(err, proxied);
        if (proxyDown) {
          // The proxy PROCESS is unreachable (ECONNREFUSED to 127.0.0.1).
          // This is the ONLY case that earns a short global bypass (3s) so
          // concurrent requests fail fast to direct instead of hanging.
          _proxyFailures++;
          _proxyBypassUntil = Date.now() + _jitter(PROXY_DOWN_BYPASS_MS);
          _setProxyMode('bypass', 'proxy-down', {
            attempt,
            proxied,
            error: String(err?.message || err || 'proxy unreachable'),
          });
          _emitRouteEvent('route-error', 'proxy-down', {
            attempt,
            proxied,
            error: String(err?.message || err || 'proxy unreachable'),
            provider: targetProvider,
            host: targetHost,
            proxyUsed: useProxy,
            failureClass: 'proxy-down',
          });
          if (attempt < maxAttempts) {
            await _sleep(_jitter(60 * attempt));
            continue;
          }
        } else if (_isRouteChurnError(err) && attempt < maxAttempts && useProxy) {
          // Transient via proxy for THIS request (timeout/abort through the
          // local hop). Retry THIS request direct once — no global bypass.
          _emitRouteEvent('route-error', 'transient-network-error', {
            attempt,
            proxied,
            error: String(err?.message || err || 'network error'),
            provider: targetProvider,
            host: targetHost,
            proxyUsed: useProxy,
            failureClass: diag.kind,
            perRequestFallback: true,
          });
          try {
            return await fetch(url, {
              method: options.method || 'GET',
              headers: options.headers || {},
              body: options.body
                ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
                : undefined,
              signal: options.signal,
            });
          } catch (directErr) {
            lastErr = directErr;
          }
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
    setEnabled(enabled, reason = 'runtime-toggle') {
      _proxyDisabled = !enabled;
      try {
        window.localStorage?.setItem?.(PROXY_DISABLED_CACHE_KEY, _proxyDisabled ? 'true' : 'false');
      } catch (_) { }
      _initPromise = null;
      if (!_proxyDisabled) {
        return initOnce().then(() => _proxyState());
      }
      _proxyAvailable = false;
      _lastInitAt = Date.now();
      _lastInitErr = reason || 'proxy-disabled';
      _setProxyMode('bypass', reason || 'proxy-disabled');
      return Promise.resolve(_proxyState());
    },
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
