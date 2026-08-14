// network-log.js
// Early renderer-side network diagnostics for fetch/XHR failures.
(function () {
  'use strict';

  if (window.NetworkLog && window.NetworkLog.installed) return;

  const MAX_ENTRIES = 500;
  const entries = [];
  const dedupe = new Map();
  const recentFailures = [];
  const OPTIONAL_DEDUPE_MS = 75_000;
  const BASE_DEDUPE_MS = 6_000;
  let seq = 0;
  const PROVIDER_ALIASES = {
    kalshi: 'Kalshi',
    polymarket: 'Polymarket',
    pyth: 'Pyth',
    proxyorchestrator: 'ProxyOrchestrator',
    'alternative.me': 'Alternative.me',
    coinmarketcap: 'CoinMarketCap',
    coingecko: 'CoinGecko',
    localproxy: 'LocalProxy',
    bybit: 'Bybit',
    bullish: 'Bullish',
    etherscan: 'Etherscan',
    bscscan: 'BSCScan',
    binance: 'Binance',
    'crypto.com': 'Crypto.com',
    bitget: 'Bitget',
    bingx: 'BingX',
    kraken: 'Kraken',
    gemini: 'Gemini',
    hyperliquid: 'Hyperliquid',
    coinw: 'CoinW',
    ourbit: 'Ourbit',
    lbank: 'LBank',
    bitstamp: 'Bitstamp',
    bitso: 'Bitso',
    whitebit: 'WhiteBIT',
    weex: 'Weex',
    upbit: 'Upbit',
    bitvavo: 'Bitvavo',
    chainso: 'Chain.so',
    'chain.so': 'Chain.so',
    mempool: 'Mempool.space',
    blockcypher: 'Blockcypher',
    blockchair: 'Blockchair',
    solana: 'Solana RPC',
    alchemy: 'Alchemy RPC',
    gate: 'Gate',
    'gate.io': 'Gate',
    timeapi: 'TimeAPI',
    'timeapi.io': 'TimeAPI',
    whalealert: 'Whale Alert',
    'whale-alert': 'Whale Alert',
    'whale alert': 'Whale Alert',
  };
  const HOST_TO_PROVIDER = {
    'api.bitget.com': 'Bitget',
    'open-api.bingx.com': 'BingX',
    'api.kraken.com': 'Kraken',
    'api.gemini.com': 'Gemini',
    'api.hyperliquid.xyz': 'Hyperliquid',
    'www.coinw.com': 'CoinW',
    'ourbit.com': 'Ourbit',
    'www.lbank.com': 'LBank',
    'www.bitstamp.net': 'Bitstamp',
    'api.bitso.com': 'Bitso',
    'whitebit.com': 'WhiteBIT',
    'api.whitebit.com': 'WhiteBIT',
    'www.weex.com': 'Weex',
    'www.bullish.com': 'Bullish',
    'api.upbit.com': 'Upbit',
    'api.bitvavo.com': 'Bitvavo',
    'chain.so': 'Chain.so',
    'api.etherscan.io': 'Etherscan',
    'mempool.space': 'Mempool.space',
    'api.blockcypher.com': 'Blockcypher',
    'api.blockchair.com': 'Blockchair',
    'api.mainnet-beta.solana.com': 'Solana RPC',
    'solana-rpc.publicnode.com': 'Solana RPC',
    'solana-api.projectserum.com': 'Solana RPC',
    'eth-mainnet.g.alchemy.com': 'Alchemy RPC',
    'polygon-mainnet.g.alchemy.com': 'Alchemy RPC',
    'api.gateio.ws': 'Gate',
    'fx-api.gateio.ws': 'Gate',
    'timeapi.io': 'TimeAPI',
    'time.akamai.com': 'TimeAPI',
    'api.whale-alert.io': 'Whale Alert',
  };
  function canonicalProviderName(input) {
    const raw = String(input || '').trim();
    if (!raw) return 'Network';
    const alias = PROVIDER_ALIASES[raw.toLowerCase()];
    return alias || raw;
  }


  function now() {
    return Date.now();
  }

  function toUrl(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      return String(input || '');
    } catch (_) {
      return 'unknown';
    }
  }

  function sanitizeUrl(raw) {
    try {
      const url = new URL(raw, location.href);
      for (const key of [...url.searchParams.keys()]) {
        if (/key|token|secret|auth|password|signature|credential/i.test(key)) {
          url.searchParams.set(key, 'redacted');
        }
      }
      return url.toString();
    } catch (_) {
      return String(raw || 'unknown').replace(/([?&](?:key|token|secret|auth|password|signature|credential)=)[^&]+/ig, '$1redacted');
    }
  }

  function hostname(raw) {
    try {
      return new URL(raw, location.href).hostname || 'local';
    } catch (_) {
      return 'unknown';
    }
  }

  function providerFor(raw) {
    const host = hostname(raw).toLowerCase();
    if (host.includes('127.0.0.1') || host.includes('localhost')) {
      try {
        const prefix = new URL(raw, location.href).pathname.split('/').filter(Boolean)[0] || '';
        const proxyProviders = {
          'kalshi': 'Kalshi',
          'polymarket': 'Polymarket',
          'polymarket-clob': 'Polymarket',
          'binance': 'Binance',
          'binance-f': 'Binance',
          'coinbase': 'Coinbase',
          'coinbase-ex': 'Coinbase',
          'coingecko': 'CoinGecko',
          'blockscout-eth': 'Blockscout',
          'blockscout-bsc': 'Blockscout',
          'bscscan': 'BSCScan',
          'etherscan': 'Etherscan',
          'bybit': 'Bybit',
          'okx': 'OKX',
          'kraken': 'Kraken',
          'crypto-com': 'Crypto.com',
          'dexscreener': 'DexScreener',
          'hyperliquid': 'Hyperliquid',
        };
        if (proxyProviders[prefix]) return proxyProviders[prefix];
      } catch (_) { }
      return 'LocalProxy';
    }
    if (host.includes('kalshi')) return 'Kalshi';
    if (host.includes('polymarket')) return 'Polymarket';
    if (host.includes('pyth') || host.includes('hermes')) return 'Pyth';
    if (host.includes('coinmarketcap')) return 'CoinMarketCap';
    if (host.includes('alternative.me')) return 'Alternative.me';
    if (host.includes('blockscout')) return 'Blockscout';
    if (host.includes('coingecko')) return 'CoinGecko';
    if (host.includes('coinbase')) return 'Coinbase';
    if (host.includes('crypto.com')) return 'Crypto.com';
    if (host.includes('binance')) return 'Binance';
    if (host.includes('bybit')) return 'Bybit';
    if (host.includes('bullish')) return 'Bullish';
    if (host.includes('bitget')) return 'Bitget';
    if (host.includes('bingx')) return 'BingX';
    if (host.includes('kraken')) return 'Kraken';
    if (host.includes('gemini')) return 'Gemini';
    if (host.includes('hyperliquid')) return 'Hyperliquid';
    if (host.includes('coinw')) return 'CoinW';
    if (host.includes('ourbit')) return 'Ourbit';
    if (host.includes('lbank')) return 'LBank';
    if (host.includes('bitstamp')) return 'Bitstamp';
    if (host.includes('bitso')) return 'Bitso';
    if (host.includes('whitebit')) return 'WhiteBIT';
    if (host.includes('weex')) return 'Weex';
    if (host.includes('upbit')) return 'Upbit';
    if (host.includes('bitvavo')) return 'Bitvavo';
    if (host.includes('chain.so')) return 'Chain.so';
    if (host.includes('mempool.space')) return 'Mempool.space';
    if (host.includes('etherscan')) return 'Etherscan';
    if (host.includes('blockcypher')) return 'Blockcypher';
    if (host.includes('blockchair')) return 'Blockchair';
    if (host.includes('alchemy.com')) return 'Alchemy RPC';
    if (host.includes('solana.com') || host.includes('projectserum') || host.includes('helius-rpc') || (host.includes('publicnode.com') && host.includes('solana'))) return 'Solana RPC';
    if (host.includes('gateio') || host.includes('gate.io')) return 'Gate';
    if (host.includes('timeapi') || host.includes('time.akamai')) return 'TimeAPI';
    if (HOST_TO_PROVIDER[host]) return HOST_TO_PROVIDER[host];
    return host || 'Network';
  }

  function isTransient(entry) {
    const text = `${entry.error || ''} ${entry.status || ''} ${entry.statusText || ''}`.toLowerCase();
    return (
      /abort|timed?\s*out|timeout|network\s*changed|econnreset|socket hang up|failed to fetch/.test(text) ||
      [429, 502, 503, 504].includes(entry.status)
    );
  }

  function classifyFailure(detail = {}) {
    const text = `${detail.error || ''} ${detail.statusText || ''} ${detail.reason || ''}`.toLowerCase();
    const status = Number(detail.status || 0);
    if (text.includes('name_not_resolved') || text.includes('enotfound') || text.includes('eai_again') || text.includes('dns')) return 'dns-fail';
    if (text.includes('cert') || text.includes('ssl') || text.includes('tls') || [495, 496, 525, 526].includes(status)) return 'tls-fail';
    if (text.includes('handshake') || text.includes('unexpected-response') || text.includes('upgrade')) return 'handshake-fail';
    if (text.includes('timeout') || text.includes('timed out') || text.includes('abort')) return 'timeout';
    if (text.includes('stale')) return 'stale-reconnect';
    if (text.includes('code=1000') || text.includes('code=1001') || text.includes('code=1005') || text.includes('route')) return 'lifecycle-reconnect';
    if (text.includes('network changed') || text.includes('err_network_changed')) return 'route-change';
    if (text.includes('econnreset') || text.includes('socket hang up')) return 'socket-reset';
    if (/credential|kalshi-api-key\.txt not found|auth-header-failed|signature generation|requires node ws|browser websocket cannot send|auth-config-fail/.test(text)) return 'auth-config-fail';
    if (status >= 500) return 'upstream-http-fail';
    return 'network-fail';
  }

  function classifyBucket(detail = {}) {
    const status = Number(detail.status || 0);
    const failureClass = String(detail.failureClass || '').toLowerCase();
    const text = `${detail.error || ''} ${detail.statusText || ''} ${detail.reason || ''}`.toLowerCase();

    if (failureClass === 'stale-reconnect' || failureClass === 'lifecycle-reconnect' || /stale[-\s]*watchdog|demote|hysteresis|scheduler|circuit|oscillat|internal|code=1000|code=1001|code=1005/.test(text)) {
      return {
        bucket: 'app/logic',
        reason: detail.error || detail.reason || 'internal WSS lifecycle/watchdog reconnect',
      };
    }

    if (text.includes('all_connections_down')) {
      return {
        bucket: 'network/transport',
        bucketReason: detail.reason || detail.error || 'all_connections_down (auto-reconnect in progress)',
      };
    }

    if (failureClass === 'auth-config-fail' || /credential|kalshi-api-key\.txt not found|auth-header-failed|signature generation|requires node ws|browser websocket cannot send/.test(text)) {
      return {
        bucket: 'app/logic',
        bucketReason: detail.error || detail.reason || 'local credential/auth configuration issue',
      };
    }
    if (
      status === 401 || status === 403 || status === 404 || status === 429 || status >= 500 ||
      /unauthorized|forbidden|not found|rate limit|upstream/.test(text)
    ) {
      return {
        bucket: 'provider/api',
        bucketReason: status ? `upstream API reject (${status})` : 'upstream API reject',
      };
    }
    if (/event:error/.test(text) && /readystate=3/.test(text)) {
      return {
        bucket: 'network/transport',
        bucketReason: 'websocket connect failure (readyState=3 before open)',
      };
    }
    if (
      ['dns-fail', 'tls-fail', 'handshake-fail', 'timeout', 'route-change', 'socket-reset', 'network-fail'].includes(failureClass) ||
      /dns|tls|ssl|cert|handshake|upgrade|timeout|abort|route|network|econnreset|socket hang up|websocket|wss/.test(text)
    ) {
      let finalReason = detail.error || detail.reason || detail.statusText || 'network transport failure';
      if (finalReason.includes('signal is aborted without reason')) {
        finalReason = detail.provider ? `${detail.provider} timed out` : 'signal timed out';
      }
      return {
        bucket: 'network/transport',
        bucketReason: finalReason,
      };
    }
    return {
      bucket: 'unknown',
      bucketReason: detail.error || detail.reason || '',
    };
  }

  function isOptionalProvider(provider) {
    return new Set([
      'Alternative.me', 'CoinMarketCap', 'CoinGecko', 'Blockscout', 'LocalProxy',
      'Bullish', 'DexScreener', 'BSCScan', 'Blockcypher', 'Chain.so', 'Polymarket',
      'Bitget', 'BingX', 'Kraken', 'Gemini', 'Hyperliquid', 'CoinW', 'Ourbit', 'LBank',
      'Bitstamp', 'Bitso', 'WhiteBIT', 'Weex', 'Upbit', 'Bitvavo', 'Etherscan',
      'Mempool.space', 'Blockchair', 'Solana RPC', 'Alchemy RPC', 'Bybit', 'OKX', 'KuCoin',
      'Gate', 'TimeAPI', 'Whale Alert',
    ]).has(provider);
  }

  function recordSuccess(url, started) {
    const provider = canonicalProviderName(providerFor(url));
    if (!isOptionalProvider(provider)) return;
    const dedupeKey = `success:${provider}`;
    const nowTs = now();
    if ((nowTs - (dedupe.get(dedupeKey) || 0)) < 30_000) return;
    dedupe.set(dedupeKey, nowTs);
    try {
      window.NetworkHealth?.markSuccess?.(provider, {
        lastFetch: nowTs,
        reason: 'HTTP OK',
      });
    } catch (_) { }
  }

  function healthStatusFor(entry) {
    if (!entry) return 'unknown';
    if (entry.type === 'TRANSPORT_OK') return 'healthy';
    if (entry.bucket === 'app/logic' || entry.failureClass === 'stale-reconnect' || entry.failureClass === 'lifecycle-reconnect' || entry.failureClass === 'auth-config-fail') {
      return 'healthy';
    }
    const optional = isOptionalProvider(entry.provider);
    const transient = isTransient(entry);

    if (entry.status === 401) return optional ? 'degraded' : 'down';
    if (entry.status && entry.status >= 500) return (optional || transient) ? 'degraded' : 'down';
    if (entry.type === 'NETWORK_ERROR') return (optional || transient) ? 'degraded' : 'down';
    if (entry.type === 'TRANSPORT_FAIL' && entry.bucket === 'network/transport') return 'degraded';
    return 'healthy';
  }

  function inferRouteHint(entry) {
    const nowTs = now();
    recentFailures.push({
      ts: nowTs,
      provider: entry.provider,
      failureClass: entry.failureClass,
    });
    while (recentFailures.length && (nowTs - recentFailures[0].ts) > 45_000) recentFailures.shift();

    if (entry.failureClass === 'dns-fail') {
      const distinctProviders = new Set(
        recentFailures.filter((row) => row.failureClass === 'dns-fail').map((row) => row.provider)
      );
      if (distinctProviders.size >= 3) return 'possible-exit-node-dns';
    }
    if (entry.failureClass === 'route-change') {
      const routeChanges = recentFailures.filter((row) => row.failureClass === 'route-change').length;
      if (routeChanges >= 2) return 'possible-exit-node-route-change';
    }
    return '';
  }

  function record(type, detail) {
    const rawUrl = detail.url || 'unknown';
    const bucketMeta = classifyBucket({
      ...detail,
      failureClass: detail.failureClass || classifyFailure(detail),
      reason: detail.reason || detail.error || detail.statusText || '',
    });
    const entry = {
      id: ++seq,
      ts: now(),
      type,
      provider: canonicalProviderName(detail.provider || providerFor(rawUrl)),
      url: sanitizeUrl(rawUrl),
      method: detail.method || 'GET',
      status: Number.isFinite(detail.status) ? detail.status : null,
      statusText: detail.statusText || '',
      durationMs: Number.isFinite(detail.durationMs) ? Math.round(detail.durationMs) : null,
      error: detail.error || '',
      failureClass: detail.failureClass || classifyFailure(detail),
      bucket: bucketMeta.bucket,
      bucketReason: bucketMeta.bucketReason,
    };
    entry.routeHint = inferRouteHint(entry);

    const dedupeKey = `${entry.provider}|${entry.type}|${entry.status || 0}|${String(entry.error || '').slice(0, 80)}`;
    const nowTs = now();
    const dedupeWindow = isOptionalProvider(entry.provider) ? OPTIONAL_DEDUPE_MS : BASE_DEDUPE_MS;
    const lastSeen = dedupe.get(dedupeKey) || 0;
    if ((nowTs - lastSeen) < dedupeWindow) return null;
    dedupe.set(dedupeKey, nowTs);

    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();

    try {
      window.dispatchEvent(new CustomEvent('network-log:update', { detail: entry }));
    } catch (_) {}

    try {
      if (window.NetworkHealth?.update) {
        const computedStatus = healthStatusFor(entry);
        window.NetworkHealth.update(entry.provider, {
          status: computedStatus,
          lastFetch: entry.ts,
          fallback: false,
          transient: isTransient(entry),
          reason: `${entry.error || `${entry.status || 'network'} ${entry.statusText}`.trim()}${entry.routeHint ? ` (${entry.routeHint})` : ''}`,
          failureClass: entry.failureClass,
          statusCode: entry.status,
          bucket: computedStatus === 'healthy' ? 'unknown' : entry.bucket,
          bucketReason: computedStatus === 'healthy' ? '' : entry.bucketReason,
        });
      }
    } catch (_) {}

    try {
      const line = `${entry.provider} ${entry.method} ${entry.status || type} [${entry.failureClass}] ${entry.url} ${entry.error}`.slice(0, 1800);
      window.desktopApp?.networkError?.(type, line).catch(() => {});
    } catch (_) {}

    return entry;
  }

  function methodFor(input, init) {
    return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch && !originalFetch.__wecryptoNetworkLogWrapped) {
    const wrappedFetch = function (input, init) {
      const started = now();
      const url = toUrl(input);
      const method = methodFor(input, init);
      return originalFetch(input, init)
        .then(response => {
          if (response && response.ok) {
            recordSuccess(url, started);
          } else if (!response || !response.ok) {
            record('HTTP_ERROR', {
              url,
              method,
              status: response ? response.status : null,
              statusText: response ? response.statusText : 'No response',
              durationMs: now() - started,
            });
          }
          return response;
        })
        .catch(error => {
          record('NETWORK_ERROR', {
            url,
            method,
            durationMs: now() - started,
            error: error?.message || String(error),
          });
          throw error;
        });
    };
    wrappedFetch.__wecryptoNetworkLogWrapped = true;
    window.fetch = wrappedFetch;
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR && !OriginalXHR.__wecryptoNetworkLogWrapped) {
    function LoggedXHR() {
      const xhr = new OriginalXHR();
      let started = 0;
      let method = 'GET';
      let url = 'unknown';
      const originalOpen = xhr.open;
      xhr.open = function (m, u) {
        method = String(m || 'GET').toUpperCase();
        url = toUrl(u);
        return originalOpen.apply(xhr, arguments);
      };
      const originalSend = xhr.send;
      xhr.send = function () {
        started = now();
        xhr.addEventListener('loadend', () => {
          if (xhr.status >= 200 && xhr.status < 400) {
            recordSuccess(url, started);
          } else if (xhr.status === 0 || xhr.status >= 400) {
            record(xhr.status === 0 ? 'NETWORK_ERROR' : 'HTTP_ERROR', {
              url,
              method,
              status: xhr.status || null,
              statusText: xhr.statusText || '',
              durationMs: now() - started,
              error: xhr.status === 0 ? 'XHR network failure' : '',
            });
          }
        });
        return originalSend.apply(xhr, arguments);
      };
      return xhr;
    }
    LoggedXHR.__wecryptoNetworkLogWrapped = true;
    window.XMLHttpRequest = LoggedXHR;
  }

  window.NetworkLog = {
    installed: true,
    record,
    getAll: () => entries.slice(),
    getRecent: (n = 25) => entries.slice(-n),
    clear: () => { entries.length = 0; },
    summary() {
      const byProvider = {};
      for (const e of entries) {
        if (!byProvider[e.provider]) byProvider[e.provider] = { total: 0, http: 0, network: 0, lastTs: 0 };
        const row = byProvider[e.provider];
        row.total += 1;
        if (e.type === 'HTTP_ERROR') row.http += 1;
        if (e.type === 'NETWORK_ERROR') row.network += 1;
        row.lastTs = Math.max(row.lastTs, e.ts);
      }
      return {
        total: entries.length,
        lastTs: entries.length ? entries[entries.length - 1].ts : null,
        byProvider,
      };
    },
    report() {
      const data = this.summary();
      console.table(entries.slice(-50));
      return data;
    },
    export: () => JSON.stringify(entries, null, 2),
  };

  console.log('[NetworkLog] Installed fetch/XHR diagnostics');
})();
