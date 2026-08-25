// network-log.js — Tier-1 Streamlined Network Logging HUD
(function (global) {
  'use strict';

  const MAX_LOG_ENTRIES = 100;
  const entries = [];
  const listeners = new Set();

  // Tier-1 Core domains to monitor actively
  const TIER1_DOMAINS = /pyth|polymarket|coinbase|binance|bybit|crypto\.com|asi1\.ai|127\.0\.0\.1:3010/i;

  // Suppress spam from dropped/deprecated third-party scrapers
  const SUPPRESS_DOMAINS = /deribit|bitvavo|whale-alert|blockchair|blockcypher|blockscout|bscscan|etherscan|polygonscan|alchemy|ankr|chain\.so/i;

  function now() {
    return Date.now();
  }

  function toUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return String(input || '');
  }

  function record(type, payload) {
    const url = payload.url || '';
    
    // Skip logging suppressed background scrapers
    if (SUPPRESS_DOMAINS.test(url)) return;

    const entry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      url,
      method: payload.method || 'GET',
      status: payload.status ?? (type === 'SUCCESS' ? 200 : null),
      statusText: payload.statusText || (type === 'SUCCESS' ? 'OK' : 'Error'),
      durationMs: Math.round(payload.durationMs || 0),
      timestamp: now(),
      isTier1: TIER1_DOMAINS.test(url),
    };

    entries.unshift(entry);
    if (entries.length > MAX_LOG_ENTRIES) {
      entries.pop();
    }

    listeners.forEach(fn => {
      try { fn(entry, entries); } catch (_) {}
    });

    if (window.desktopApp?.networkLog) {
      window.desktopApp.networkLog(entry).catch(() => {});
    }

    return entry;
  }

  // Wrap window.fetch cleanly
  if (window.fetch && !window.fetch.__wecryptoNetworkLogWrapped) {
    const origFetch = window.fetch.bind(window);

    const wrappedFetch = function (input, init) {
      const started = now();
      const url = toUrl(input);
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();

      return origFetch(input, init)
        .then(res => {
          const durationMs = now() - started;
          if (res && res.ok) {
            record('SUCCESS', { url, method, status: res.status, statusText: res.statusText, durationMs });
          } else if (res && !res.ok) {
            record('HTTP_ERROR', { url, method, status: res.status, statusText: res.statusText, durationMs });
          }
          return res;
        })
        .catch(err => {
          const durationMs = now() - started;
          record('NETWORK_ERROR', { url, method, error: err?.message || String(err), durationMs });
          throw err;
        });
    };

    wrappedFetch.__wecryptoNetworkLogWrapped = true;
    window.fetch = wrappedFetch;
  }

  global.NetworkLog = {
    getEntries: () => [...entries],
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    clear: () => { entries.length = 0; },
  };

  console.info('[WE] network-log — Tier-1 Core filtering active (max 100 entries)');
})(typeof window !== 'undefined' ? window : global);
