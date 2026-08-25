// ================================================================
// WE CFM ALPHA-1.3 — Smart Proxy Shim
//
// CORS is just a browser bouncer with a clipboard — it only fires
// when the browser asks. Electron (webSecurity:false) already
// dismissed that bouncer. The proxy's REAL job is server-side:
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

  const PORT_CASCADE = [3010, 3011, 3012, 3013, 3014, 3015, 3016, 3017, 3018, 3019, 3020];

  // Initialize PROXY_ORIGIN immediately so early fetches are never sent unproxied.
  let PROXY_ORIGIN = (typeof window !== 'undefined' && window.__PROXY_PORT__)
    ? `http://127.0.0.1:${window.__PROXY_PORT__}`
    : 'http://127.0.0.1:3010';
  let proxyReady = true;

  const IS_ELECTRON = window.location.protocol === 'file:';

  // ── Bucket A: Cloudflare Bot Mgmt & Geo-restricted APIs — always proxy ─────
  const CF_PROTECTED = new Set([
    'api.binance.com',
    'fapi.binance.com',
    'data-api.binance.vision',
    'api.bybit.com',
    'api.bytick.com',
    'api.kraken.com',
    'www.kraken.com',
    'api.hyperliquid.xyz',
    'api.bitstamp.net',
    'www.bitstamp.net',
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
    'hypurrscan.io',
    'api.etherscan.io',
    'api.bscscan.com',
    'api.gateio.ws',
    'fx-api.gateio.ws',
  ]);

  // ── Bucket C: open / first-party APIs ──────────────────────────────────

  // hostname → proxy exchange prefix (config.toml keys)
  const HOST_MAP = {
    'api.binance.us': 'binance-us',
    'api.binance.com': 'binance',
    'data-api.binance.vision': 'binance',
    'fapi.binance.com': 'binance-f',
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

  // Explicit direct bypass for AI/LLM endpoints so they always use native source IP
  const IGNORE_DOMAINS = /localhost|127\.0\.0\.1|asi1\.ai|fetch-ai\.com|openai\.com|anthropic\.com|x\.ai|deepseek\.com|timeapi\.io|polymarket\.com/i;

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
  } catch (_) {}

  function shouldUseNodeFetch(originalUrl, rewrittenUrl) {
    if (!_nodeFetch) return false;
    const isProxyRoute = rewrittenUrl !== originalUrl;
    return isProxyRoute; // ONLY use node-fetch for the local proxy (127.0.0.1) route. External DNS hangs in Electron renderer.
  }

  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      let urlToUse = input;
      if (!IGNORE_DOMAINS.test(input)) {
        urlToUse = rewrite(input);
      }
      if (shouldUseNodeFetch(input, urlToUse)) {
        return _nodeFetch(urlToUse, init);
      }
      if (urlToUse !== input) {
        input = urlToUse;
      }
    } else if (input instanceof Request && EXTERNAL.test(input.url)) {
      let urlToUse = input.url;
      if (!IGNORE_DOMAINS.test(input.url)) {
        urlToUse = rewrite(input.url);
      }
      if (shouldUseNodeFetch(input.url, urlToUse)) {
        const opts = init || {};
        opts.method = opts.method || input.method;
        opts.headers = opts.headers || input.headers;
        if (input.body && !opts.body) opts.body = input.body;
        opts.signal = opts.signal || input.signal;
        return _nodeFetch(urlToUse, opts);
      }
      if (urlToUse !== input.url) {
        input = new Request(urlToUse, input);
      }
    }
    return _origFetch(input, init);
  };

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
        } else {
          tryNext();
        }
      };
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

