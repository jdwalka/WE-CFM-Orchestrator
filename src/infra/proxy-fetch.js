// ================================================================
// WE CFM ALPHA-1.3 — Smart Proxy Shim
//
// CORS is just a browser bouncer with a clipboard — it only fires
// when the browser asks. Electron's scoped webRequest CORS passthrough
// already dismissed that bouncer. The proxy's REAL job is server-side:
//
//  BUCKET A — CF_PROTECTED   : Cloudflare Bot Mgmt / 403 without
//                               Chrome TLS fingerprint → ALWAYS proxy
//  BUCKET B — RATE_LIMITED   : Public APIs that throttle heavily
//                               → proxy adds caching headroom
//  BUCKET C — OPEN           : No server-side block
//                               → direct in Electron, proxy in browser
//
// In Electron (file://): only bucket A+B go through proxy
// In browser  (http://): everything goes through proxy (CORS is live)
//
// PORT CASCADE: proxy tries 3010→3014 and binds the first free port.
// proxy-fetch discovers the live port via XHR health-checks and
// updates PROXY_ORIGIN in-flight, then syncs via IPC confirmation.
// ================================================================

(function () {
  'use strict';

  // Must match proxy/src/main.rs bind_cascade() + tauri-bridge.js cascade.
  // NOTE: 8080/8000/4000/5000/9000 excluded — :8080 is a local nginx trap
  // (200 'OK' on /health, 404 on every real route).
  const PORT_CASCADE = [3010, 3011, 3012, 3013, 3014, 3015, 3016, 3017, 3018, 3019, 3020, 3009, 3008, 3007, 3006, 3005, 3004, 3003, 3002, 3001, 3000];

  // Initialize PROXY_ORIGIN immediately so early fetches are never sent unproxied.
  let PROXY_ORIGIN = (typeof window !== 'undefined' && window.__PROXY_PORT__)
    ? `http://127.0.0.1:${window.__PROXY_PORT__}`
    : null;
  let proxyReady = !!PROXY_ORIGIN;

  const IS_ELECTRON = window.location.protocol === 'file:';

  // ── Bucket A: Cloudflare Bot Mgmt & Geo-restricted APIs — always proxy ─────
  const CF_PROTECTED = new Set([
    'api.binance.com',
    'fapi.binance.com',
    'dapi.binance.com',
    'data-api.binance.vision',
    'api.bybit.com',
    'api.bytick.com',
    'api.kraken.com',
    'www.kraken.com',
    // NOTE: bitstamp and hyperliquid are deliberately NOT in this set.
    // Hyperliquid runs on AWS CloudFront with wide-open CORS (ACAO:*) and direct
    // requests return 200 without geo-block, whereas local proxy injected spurious headers.
    'www.okx.com',
    'api.okx.com',
    'api-pub.bitfinex.com',
    'api.kucoin.com',
    'api.mexc.com',
    'api.crypto.com',
    'api.bitvavo.com',
    'api.upbit.com',
  ]);

  // ── Bucket B: rate-limited public APIs — proxy for headroom ─────────────
  const RATE_LIMITED = new Set([
    'api.dexscreener.com',
    'api.blockchair.com',
    'api.blockcypher.com',
    'hypurrscan.io',
    'api.etherscan.io',
    'api.bscscan.com',
    'api.gateio.ws',
    'fx-api.gateio.ws',
    'pyth.dourolabs.app',
  ]);

  // ── Bucket C: open / first-party APIs ──────────────────────────────────

  // hostname → proxy exchange prefix (config.toml keys)
  const HOST_MAP = {
    'api.binance.us': 'binance-us',
    'api.binance.com': 'binance',
    'data-api.binance.vision': 'binance',
    'fapi.binance.com': 'binance-f',
    'dapi.binance.com': 'binance-d',
    'api.coingecko.com': 'coingecko',
    'pro-api.coingecko.com': 'coingecko-pro',
    'api.coinbase.com': 'coinbase',
    'api.exchange.coinbase.com': 'coinbase-ex',
    'api.kraken.com': 'kraken',
    'www.kraken.com': 'kraken',
    'api.bybit.com': 'bybit',
    'api.bytick.com': 'bybit',   // EU mirror — same proxy route
    'www.okx.com': 'okx',
    'api.okx.com': 'okx',
    'gamma-api.polymarket.com': 'polymarket',
    'clob.polymarket.com': 'polymarket-clob',
    'data-api.polymarket.com': 'polymarket-data',
    'api.perpetuals.polymarket.com': 'polymarket-perps',
    'api-pub.bitfinex.com': 'bitfinex',
    'api.kucoin.com': 'kucoin',
    'api.mexc.com': 'mexc',
    'hypurrscan.io': 'hypurrscan',
    'api.dexscreener.com': 'dexscreener',
    'mempool.space': 'mempool',
    'api.blockchair.com': 'blockchair',
    'api.etherscan.io': 'etherscan',
    'api.bscscan.com': 'bscscan',
    'eth.blockscout.com': 'blockscout-eth',
    'bsc.blockscout.com': 'blockscout-bsc',
    'api.hyperliquid.xyz': 'hyperliquid',
    'api.blockcypher.com': 'blockcypher',
    's2.ripple.com': 'ripple',
    'xrplcluster.com': 'xrpl',
    'api.mainnet-beta.solana.com': 'solana',
    'api.crypto.com': 'crypto-com',
    'pyth.dourolabs.app': 'pyth-history',
    'api.upbit.com': 'upbit',
    'api.bitget.com': 'bitget',
    'open-api.bingx.com': 'bingx',
    'api.gemini.com': 'gemini',
    'api.whitebit.com': 'whitebit',
    'whitebit.com': 'whitebit',
    'www.coinw.com': 'coinw',
    'ourbit.com': 'ourbit',
    'www.lbank.com': 'lbank',
    'www.bitstamp.net': 'bitstamp',
    'api.bitstamp.net': 'bitstamp',
    'api.bitso.com': 'bitso',
    'www.bullish.com': 'bullish',
    'www.weex.com': 'weex',
  };

  const _origFetch = window.fetch.bind(window);
  const EXTERNAL = /^https?:\/\//;

  // Explicit direct bypass for AI/LLM endpoints so they always use native source IP.
  // pyth added 2026-08-24: Hermes/Lazer aren't geo-blocked, so routing them through
  // the local proxy (and from there, the Mullvad/Sweden path) only adds latency and
  // ties price-feed reliability to that tunnel's health for no access-control benefit.
  // Bitstamp 2026-09: its Incapsula WAF 403s proxied (non-browser TLS)
  // requests while direct browser-TLS requests return 200 with ACAO:* —
  // so Bitstamp always goes direct, never through the proxy.
  // Hyperliquid 2026-09: CloudFront edge with ACAO:*, open public market info.
  const IGNORE_DOMAINS = /localhost|127\.0\.0\.1|asi1\.ai|fetch-ai\.com|openai\.com|anthropic\.com|x\.ai|deepseek\.com|timeapi\.io|pyth|bitstamp\.net|hyperliquid/i;

  function needsProxy(hostname) {
    if (IGNORE_DOMAINS.test(hostname)) return false;
    return true; // All exchange / market endpoints MUST route through local proxy
  }

  function rewrite(url) {
    if (!EXTERNAL.test(url)) return url;
    try {
      const u = new URL(url);
      if (!needsProxy(u.hostname)) return url; // Bucket C in Electron → go direct

      // Proxy offline (never found on any port) → pass through and let it fail naturally
      if (!PROXY_ORIGIN) return url;

      const prefix = HOST_MAP[u.hostname];
      if (prefix) {
        const p = u.pathname.replace(/^\//, '');
        return `${PROXY_ORIGIN}/${prefix}/${p}${u.search}`;
      }
      // Unknown host → generic escape hatch
      return `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(url)}`;
    } catch (_) {
      return url;
    }
  }

  let _nodeFetch = null;
  try {
    if (typeof require !== 'undefined') {
      _nodeFetch = require('node-fetch');
    }
  } catch (_) { }

  function shouldUseNodeFetch(originalUrl, rewrittenUrl) {
    if (!_nodeFetch) return false;
    const isProxyRoute = rewrittenUrl !== originalUrl;
    return isProxyRoute; // ONLY use node-fetch for the local proxy (127.0.0.1) route. External DNS hangs in Electron renderer.
  }

  // ── Per-host circuit breaker: stop re-hammering a dead upstream leg ─────
  // The local proxy binary can stay up (health-checks green) while its own
  // outbound connections fail — e.g. the box's current egress IP is flagged
  // by a provider's Cloudflare edge. Without this, every poll loop across the
  // app keeps re-dispatching to the same doomed host every ~20s, drowning the
  // health dashboard in identical "502 Bad Gateway" rows. Track failures per
  // real upstream hostname (not the local proxy port) and fail fast during an
  // open backoff window instead. Reuses ApiCircuitBreaker (src/feeds/api-
  // circuit-breaker.js) when present so state shows up alongside the app's
  // other resilience tooling; degrades to a no-op if that module isn't loaded.
  // 502/503/504 = gateway errors (proxy can't reach upstream).
  // 403/404 via the local proxy path = upstream is refusing or route is missing —
  // treat as a circuit failure so the breaker isolates that feed, not the proxy itself.
  const CIRCUIT_TRIP_STATUSES = new Set([403, 404, 502, 503, 504, 522, 524]);

  function safeHostname(url) {
    try { return new URL(url).hostname; } catch (_) { return null; }
  }

  // When tauri-bridge builds a local proxy URL itself and calls the patched
  // fetch, the hostname is 127.0.0.1. Attributing failures to the local proxy
  // trips ONE global breaker and disables every proxied host together.
  // Resolve the real upstream host (slug prefix or /proxy?url=) instead.
  // Note: matches all local ports (3010–3019, 3012 for secondary services, etc.)
  const LOCAL_PROXY_HOST = /^(127\.0\.0\.1|localhost|\[::1\])$/i;
  const REVERSE_HOST_MAP = Object.fromEntries(
    Object.entries(HOST_MAP).map(([host, slug]) => [slug, host])
  );

  function breakerHostname(url) {
    try {
      const u = new URL(url);
      if (!LOCAL_PROXY_HOST.test(u.hostname)) return u.hostname;
      if (u.pathname === '/proxy') {
        const target = u.searchParams.get('url');
        return target ? new URL(target).hostname : null;
      }
      // Slug-based path: /xrpl/..., /bitstamp/..., etc.
      // Unmapped local utility paths (/health, /port, /grades, /cache, /test)
      // must return null — never the raw slug. Attributing them to a breaker
      // named e.g. "health" wedges proxy discovery itself: once that bogus
      // breaker trips, every later /health sweep fails fast without network
      // and a restarted proxy is never rediscovered.
      const slug = u.pathname.replace(/^\//, '').split('/')[0];
      return REVERSE_HOST_MAP[slug] || null;
    } catch (_) {
      return null;
    }
  }

  function getHostBreaker(hostname) {
    if (!hostname || !window.ApiCircuitBreaker) return null;
    return window.ApiCircuitBreaker.getBreaker(`proxy-fetch:${hostname}`, { threshold: 20, timeout: 8000 });
  }

  function hostCircuitResponse(hostname, breaker) {
    const retryAfterSec = breaker?.nextRetryTime
      ? Math.max(1, Math.ceil((breaker.nextRetryTime - Date.now()) / 1000))
      : 30;
    return new Response(
      JSON.stringify({ error: 'circuit_open', hostname, retryAfterSeconds: retryAfterSec }),
      {
        status: 503,
        statusText: `Circuit open for ${hostname} (WE proxy-fetch backoff)`,
        headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSec) },
      },
    );
  }

  function trackHostResult(hostname, res) {
    const breaker = getHostBreaker(hostname);
    if (!breaker || !res) return;
    if (CIRCUIT_TRIP_STATUSES.has(res.status)) {
      breaker.recordFailure();
    } else if (res.status < 500) {
      // Any non-5xx response means the upstream leg is reachable again —
      // only gateway/timeout-class errors indicate a broken network path.
      if (breaker.state !== 'CLOSED') breaker.close();
      else breaker.failureCount = 0;
    }
  }

  function trackHostFailure(hostname) {
    const breaker = getHostBreaker(hostname);
    if (breaker) breaker.recordFailure();
  }

  // Hosts whose last DIRECT attempt also failed with a 5xx: the upstream
  // itself is down (not the proxy), so hammering it every poll tick is pure
  // log spam. While the breaker is open AND a recent direct 5xx is recorded,
  // fail fast with a synthetic 503 and no network. A single direct probe is
  // still allowed once the quiet window expires (recovery chance).
  const _lastDirect5xx = {};
  const DIRECT_FAIL_QUIET_MS = 60_000;

  function noteDirectResult(hostname, res) {
    if (!hostname) return;
    if (res && Number(res.status) >= 500) {
      _lastDirect5xx[hostname] = Date.now();
    } else if (res && res.ok) {
      delete _lastDirect5xx[hostname];
    }
  }

  function dispatch(originalUrl, requestInput, init) {
    const mapped = breakerHostname(originalUrl);
    const hostname = mapped || safeHostname(originalUrl);
    // Local utility paths (/health, /port, ...) map to nothing and must
    // never be tracked — they are infrastructure, not upstream hosts.
    const isLocalUtil = !mapped && LOCAL_PROXY_HOST.test(safeHostname(originalUrl) || '');
    const breaker = (isLocalUtil || !hostname) ? null : getHostBreaker(hostname);
    if (breaker && !breaker.isAvailable()) {
      // Per-host breaker open: this upstream via proxy is failing.
      // WSS → gRPC → RPC → HTTP fallback: for non-CF-protected hosts the
      // HTTP leg can still try DIRECT for this request instead of forcing a
      // synthetic 503 (which is what wedged every feed behind one bad host).
      // CF-protected hosts REQUIRE the proxy — fail fast with 503 there.
      // Upstream-dead shortcut: if a direct attempt recently 5xx'd too, the
      // origin itself is down — fail fast with zero network, zero log spam.
      const cfProtected = hostname ? CF_PROTECTED.has(hostname) : true;
      if (!cfProtected && /^https?:\/\//.test(originalUrl)) {
        const quietUntil = (_lastDirect5xx[hostname] || 0) + DIRECT_FAIL_QUIET_MS;
        if (Date.now() < quietUntil) {
          return Promise.resolve(hostCircuitResponse(hostname, breaker));
        }
        const finalInput = requestInput instanceof Request ? requestInput : originalUrl;
        // Bypass rewrite: go direct, still track result for breaker recovery.
        const directP = (requestInput instanceof Request
          ? _origFetch(requestInput, init)
          : _origFetch(finalInput, init)).then(
          (res) => { noteDirectResult(hostname, res); trackHostResult(hostname, res); return res; },
          (err) => { trackHostFailure(hostname); throw err; },
        );
        return directP;
      }
      return Promise.resolve(hostCircuitResponse(hostname, breaker));
    }

    const urlToUse = IGNORE_DOMAINS.test(originalUrl) ? originalUrl : rewrite(originalUrl);
    let fetchPromise;

    if (shouldUseNodeFetch(originalUrl, urlToUse)) {
      if (requestInput instanceof Request) {
        const opts = init || {};
        opts.method = opts.method || requestInput.method;
        opts.headers = opts.headers || requestInput.headers;
        if (requestInput.body && !opts.body) opts.body = requestInput.body;
        opts.signal = opts.signal || requestInput.signal;
        fetchPromise = _nodeFetch(urlToUse, opts);
      } else {
        fetchPromise = _nodeFetch(urlToUse, init);
      }
    } else {
      const finalInput = requestInput instanceof Request
        ? (urlToUse !== requestInput.url ? new Request(urlToUse, requestInput) : requestInput)
        : urlToUse;
      fetchPromise = _origFetch(finalInput, init);
    }

    if (!hostname || isLocalUtil) return fetchPromise;
    return fetchPromise.then(
      (res) => {
        // Per-request direct retry: proxied 403/404 for a NON-CF host means
        // the upstream refused the proxy's TLS (e.g. Bitstamp Incapsula)
        // or the route is missing on a stale proxy binary — direct usually
        // works. CF-protected hosts stay proxied (direct blocked by design).
        // 5xx stays breaker-managed (see above).
        const retryableRefusal = (res.status === 403 || res.status === 404)
          && !CF_PROTECTED.has(hostname)
          && /^https?:\/\//.test(originalUrl)
          && urlToUse !== originalUrl
          // Worker-down quiet: if a recent direct attempt also 5xx'd, the
          // origin itself is down — don't double every call, fail fast.
          && Date.now() >= ((_lastDirect5xx[hostname] || 0) + DIRECT_FAIL_QUIET_MS);
        if (retryableRefusal) {
          return _origFetch(originalUrl, init).then(
            (dRes) => { noteDirectResult(hostname, dRes); trackHostResult(hostname, dRes); return dRes; },
            (dErr) => { trackHostResult(hostname, res); throw dErr; },
          );
        }
        trackHostResult(hostname, res);
        return res;
      },
      (err) => { trackHostFailure(hostname); throw err; },
    );
  }

  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      return dispatch(input, input, init);
    } else if (input instanceof Request && EXTERNAL.test(input.url)) {
      return dispatch(input.url, input, init);
    }
    return _origFetch(input, init);
  };

  // Keep PROXY_ORIGIN in sync with tauri-bridge discovery (single source of
  // truth for the live port). Without this the two shims can disagree —
  // one on :3010, one on :3011 — and half the app bypasses while the other
  // half proxies.
  try {
    window.addEventListener('proxy-mode-update', (e) => {
      const port = Number(e?.detail?.port || 0);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        const origin = `http://127.0.0.1:${port}`;
        if (origin !== PROXY_ORIGIN) {
          PROXY_ORIGIN = origin;
          proxyReady = true;
        }
        try { window.__PROXY_PORT__ = port; } catch (_) { }
      }
    });
  } catch (_) { }

  // ── Port cascade discovery via XHR (avoids patching our own patched fetch) ──
  // Uses XMLHttpRequest so it bypasses the window.fetch patch above.
  // Runs immediately; PROXY_ORIGIN is updated as soon as a live port is found.
  (function discoverProxyPort() {
    let idx = 0;

    // To ensure 100% reliability, we ALWAYS ping the cascade ports to verify health.
    // If the proxy is slow to start (e.g. due to OS/antivirus delay), we retry the sweep.
    function tryNext() {
      if (idx >= PORT_CASCADE.length) {
        PROXY_ORIGIN = null;
        proxyReady = false;
        console.warn('[WE] proxy-fetch — proxy not found on cascade in this sweep; retrying sweep in 2s...');
        idx = 0;
        setTimeout(tryNext, 2000);
        return;
      }
      const port = PORT_CASCADE[idx++];
      const xhr = new XMLHttpRequest();
      xhr.timeout = 500;
      xhr.onload = function () {
        if (xhr.status === 200 && xhr.responseText.trim() === 'OK') {
          // Identity check before latching: nginx :8080 also answers 'OK'
          // on /health but 404s every real route. Require /port to prove
          // this port is OUR proxy.
          try {
            const check = new XMLHttpRequest();
            check.timeout = 500;
            check.onload = function () {
              let okPort = 0;
              try { okPort = Number(JSON.parse(check.responseText || '{}').port || 0); } catch (_) { okPort = 0; }
              if (check.status === 200 && okPort === port) {
                latchPort(port);
              } else {
                tryNext();
              }
            };
            check.onerror = tryNext;
            check.ontimeout = tryNext;
            check.open('GET', `http://127.0.0.1:${port}/port`, true);
            check.send();
          } catch (_) {
            tryNext();
          }
          return;
        }
        tryNext();
      };
      function latchPort(port) {
        PROXY_ORIGIN = `http://127.0.0.1:${port}`;
        proxyReady = true;
        console.info(`[WE] proxy-fetch v1.4 — live on port ${port}`);
        // Also let the IPC confirm (in case main.js finishes parsing stdout later)
        if (window.desktopApp?.proxyPort) {
          window.desktopApp.proxyPort().then(p => {
            if (p && p !== port) {
              PROXY_ORIGIN = `http://127.0.0.1:${p}`;
              console.info(`[WE] proxy-fetch — IPC corrected port to ${p}`);
            }
          }).catch(() => { });
        }
      }
      xhr.onerror = tryNext;
      xhr.ontimeout = tryNext;
      xhr.open('GET', `http://127.0.0.1:${port}/health`, true);
      xhr.send();
    }

    tryNext();
  })();

  const mode = IS_ELECTRON ? 'Electron (A+B→proxy, C→direct)' : 'browser (all→proxy)';
  console.info(`[WE] proxy-fetch v1.4 — ${mode} — cascade: ${PORT_CASCADE.join(',')}`);
})();

