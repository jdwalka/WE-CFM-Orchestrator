// ================================================================
// exchange-ws.js — Unified public exchange websocket mux
//
// Priority providers (WS-first):
//   Binance, Coinbase Pro, Kraken, Bybit, OKX, KuCoin, Gate.io
//   Blockchain.com mempool feed (BTC unconfirmed tx)
// Optional:
//   DexPaprika SSE (default endpoint enabled, override via runtime config)
//
// Exposes:
//   window.ExchangeWS.getTicker(provider, sym, maxAgeMs)
//   window.ExchangeWS.getAll(provider)
//   window.ExchangeWS.getMempool()
//   window.ExchangeWS.start()/stop()
// ================================================================
// Circuit breaker state for provider flapping/failure
const CIRCUIT_BREAKER = {};
const FAILURE_THRESHOLD = 4; // Number of consecutive failures before disabling
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes cooldown
const PROVIDER_BREAKER_CONFIG = {
  // These venues are used as low-weight CEX-flow enrichments and have REST
  // fallback. Keep reconnecting through intermittent WS edge-node failures.
  KUCOIN: { threshold: 10, cooldownMs: 30 * 1000 },
  GATE: { threshold: 10, cooldownMs: 30 * 1000 },
};

(function () {
  'use strict';

  const TRADE_WINDOW_MS = 120000;
  const RECONNECT_BASE_MS = 3000;
  const RECONNECT_MAX_MS = 120000;
  const RECONNECT_JITTER_RATIO = 0.35;
  const WS_STARTUP_STAGGER_MS = 900;
  const OPTIONAL_WS_POOL_TICK_MS = 3000;
  const OPTIONAL_WS_POOL_DEFAULT_DWELL_MS = 35000;
  const OPTIONAL_REST_PROBE_MIN_INTERVAL_MS = 300_000; // 5 min - reduce spam from failing optionals
  const OPTIONAL_REST_PROBE_TIMEOUT_MS = 4500;
  const OPTIONAL_REST_PROBE_BATCH = 3;

  const STORE = {}; // provider -> sym -> snapshot
  const MEMPOOL = { btcUnconfirmed: 0, btcValue: 0, lastTxTs: 0 };
  const CONNECTIONS = {}; // name -> { ws, reconnectMs, timer, active, extra }
  const DEFAULT_DISABLED_WS_PROVIDERS = new Set(['BULLISH', 'OURBIT', 'COINW', 'UPBIT', 'BITSTAMP', 'WHITEBIT', 'COINW', 'BITSO', 'LBANK', 'WEEX']);
  const DEFAULT_BINANCE_WS_ENDPOINTS = [
    'wss://data-stream.binance.vision',
    'wss://stream.binance.com:9443',
  ];
  const OPTIONAL_WS_POOL = { timer: null, roster: [] };
  const OPTIONAL_REST_STATUS = {};
  const OPTIONAL_REST_ENDPOINTS = {
    // Only real public API endpoints that return JSON and are not homepages
    UPBIT: 'https://api.upbit.com/v1/market/all',
    BITGET: 'https://api.bitget.com/api/v2/spot/public/symbols',
    BINGX: 'https://open-api.bingx.com/openApi/swap/v2/quote/contracts',
    BITVAVO: 'https://api.bitvavo.com/v2/markets',
    GEMINI: 'https://api.gemini.com/v1/symbols',
    // Skip flaky/homepage ones to reduce 403 noise and rate limits on proxy
    // COINW, BITSTAMP (homepage), WHITEBIT, OURBIT, WEEX, LBANK, BULLISH, BITSO disabled by default
    // If you want them, enable explicitly and use proper API paths e.g.:
    // BITSTAMP: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    // WHITEBIT: 'https://api.whitebit.com/api/v4/public/markets',
  };

  function flagEnabled(value) {
    if (typeof value === 'boolean') return value;
    return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
  }

  function runtimeFlag(name) {
    try {
      if (typeof window.resolveRuntimeKey === 'function') {
        const value = window.resolveRuntimeKey(name);
        if (value != null && value !== '') return value;
      }
    } catch (_) { }
    try {
      if (window.__env && window.__env[name] != null) return window.__env[name];
    } catch (_) { }
    try {
      if (window.desktopApp?.publicEnv && window.desktopApp.publicEnv[name] != null) return window.desktopApp.publicEnv[name];
    } catch (_) { }
    try {
      if (typeof localStorage !== 'undefined') {
        const value = localStorage.getItem(name);
        if (value != null && value !== '') return value;
      }
    } catch (_) { }
    try {
      if (globalThis?.process?.env?.[name] != null) return globalThis.process.env[name];
    } catch (_) { }
    return '';
  }

  function splitRuntimeList(value) {
    return String(value || '')
      .split(/[\s,;|]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
  }

  function splitRuntimeUrlList(value) {
    return String(value || '')
      .split(/[\s,;|]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function getBinanceWsEndpoints() {
    const configured = splitRuntimeUrlList(runtimeFlag('WECRYPTO_BINANCE_WS_ENDPOINTS'));
    return (configured.length ? configured : DEFAULT_BINANCE_WS_ENDPOINTS)
      .map((endpoint) => endpoint.replace(/\/+$/, ''))
      .filter((endpoint) => /^wss:\/\//i.test(endpoint));
  }

  function isProviderExplicitlyOff(provider) {
    if (flagEnabled(runtimeFlag(`WECRYPTO_DISABLE_WS_${provider}`))) return true;
    return splitRuntimeList(runtimeFlag('WECRYPTO_DISABLED_WS_PROVIDERS')).includes(provider);
  }

  function isProviderConfiguredOff(name) {
    const provider = String(name || '').trim().toUpperCase();
    if (isProviderExplicitlyOff(provider)) return true;
    if (!DEFAULT_DISABLED_WS_PROVIDERS.has(provider)) return false;
    return !(
      flagEnabled(runtimeFlag('WECRYPTO_ENABLE_OPTIONAL_WS')) ||
      flagEnabled(runtimeFlag('WECRYPTO_ENABLE_HAR_FAILING_WS')) ||
      flagEnabled(runtimeFlag(`WECRYPTO_ENABLE_WS_${provider}`))
    );
  }

  // Track failures and circuit breaker state per provider
  function getBreakerState(name) {
    if (!CIRCUIT_BREAKER[name]) {
      CIRCUIT_BREAKER[name] = {
        failures: 0,
        open: false,
        openUntil: 0,
      };
    }
    return CIRCUIT_BREAKER[name];
  }

  function recordFailure(name) {
    const br = getBreakerState(name);
    const cfg = PROVIDER_BREAKER_CONFIG[name] || {};
    const threshold = Number(cfg.threshold || FAILURE_THRESHOLD);
    const cooldownMs = Number(cfg.cooldownMs || COOLDOWN_MS);
    br.failures++;
    if (!br.open && br.failures >= threshold) {
      br.open = true;
      br.openUntil = Date.now() + cooldownMs;
      // User feedback: dispatch event
      if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('provider-disabled', {
          detail: { provider: name, until: br.openUntil }
        }));
      }
      console.warn(`[CircuitBreaker] Provider ${name} disabled for ${cooldownMs / 1000}s due to repeated failures.`);
    }
  }

  function recordSuccess(name) {
    const br = getBreakerState(name);
    if (br.open && Date.now() > br.openUntil) {
      br.open = false;
      br.failures = 0;
      // User feedback: dispatch event
      if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('provider-recovered', {
          detail: { provider: name }
        }));
      }
      console.info(`[CircuitBreaker] Provider ${name} re-enabled after cooldown.`);
    } else if (!br.open) {
      br.failures = 0;
    }
  }

  function isProviderDisabled(name) {
    if (isProviderConfiguredOff(name)) return true;
    const br = getBreakerState(name);
    if (br.open && Date.now() > br.openUntil) {
      // Auto-recover after cooldown
      br.open = false;
      br.failures = 0;
      if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('provider-recovered', {
          detail: { provider: name }
        }));
      }
      console.info(`[CircuitBreaker] Provider ${name} auto-recovered after cooldown.`);
      return false;
    }
    return br.open;
  }
  const SSE = { stream: null, active: false, lastError: null };

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
  const DEXPAPRIKA_SSE_DEFAULT = 'https://mcp.dexpaprika.com/sse';
  const PROVIDERS = {
    BINANCE: 'BINANCE',
    COINBASE: 'COINBASE',
    KRAKEN: 'KRAKEN',
    BYBIT: 'BYBIT',
    HYPERLIQUID: 'HYPERLIQUID',
    OKX: 'OKX',
    KUCOIN: 'KUCOIN',
    GATE: 'GATE',
    UPBIT: 'UPBIT',
    BITGET: 'BITGET',
    BINGX: 'BINGX',
    BITVAVO: 'BITVAVO',
    GEMINI: 'GEMINI',
    COINW: 'COINW',
    LBANK: 'LBANK',
    BITSTAMP: 'BITSTAMP',
    BITSO: 'BITSO',
    BULLISH: 'BULLISH',
    WHITEBIT: 'WHITEBIT',
    OURBIT: 'OURBIT',
    WEEX: 'WEEX'
  };

  const PROVIDER_PROFILE = {
    BINANCE: { marketType: 'spot', venueType: 'cex' },
    COINBASE: { marketType: 'spot', venueType: 'cex' },
    KRAKEN: { marketType: 'spot', venueType: 'cex' },
    BYBIT: { marketType: 'spot', venueType: 'cex' },
    HYPERLIQUID: { marketType: 'perps', venueType: 'dex' },
    OKX: { marketType: 'spot', venueType: 'cex' },
    KUCOIN: { marketType: 'spot', venueType: 'cex' },
    GATE: { marketType: 'spot', venueType: 'cex' },
    UPBIT: { marketType: 'spot', venueType: 'cex' },
    BITGET: { marketType: 'spot', venueType: 'cex' },
    BINGX: { marketType: 'spot_derivatives', venueType: 'cex' },
    BITVAVO: { marketType: 'spot', venueType: 'cex' },
    GEMINI: { marketType: 'spot', venueType: 'cex' },
    COINW: { marketType: 'spot_futures', venueType: 'cex' },
    LBANK: { marketType: 'spot', venueType: 'cex' },
    BITSTAMP: { marketType: 'spot', venueType: 'cex' },
    BITSO: { marketType: 'spot', venueType: 'cex' },
    BULLISH: { marketType: 'spot', venueType: 'cex' },
    WHITEBIT: { marketType: 'spot', venueType: 'cex' },
    OURBIT: { marketType: 'spot_derivatives', venueType: 'cex' },
    WEEX: { marketType: 'spot', venueType: 'cex' },
  };

  const MAP = {
    BINANCE: { BTC: 'btcusdt', ETH: 'ethusdt', SOL: 'solusdt', XRP: 'xrpusdt', BNB: 'bnbusdt', DOGE: 'dogeusdt', HYPE: 'hypeusdt' },
    COINBASE: { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', HYPE: 'HYPE-USD' },
    KRAKEN: { BTC: 'BTC/USD', ETH: 'ETH/USD', SOL: 'SOL/USD', XRP: 'XRP/USD', DOGE: 'DOGE/USD' },
    BYBIT: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT' },
    HYPERLIQUID: { BTC: 'BTC', ETH: 'ETH', SOL: 'SOL', XRP: 'XRP', DOGE: 'DOGE', HYPE: 'HYPE' },
    OKX: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', BNB: 'BNB-USDT', DOGE: 'DOGE-USDT' },
    KUCOIN: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', BNB: 'BNB-USDT', DOGE: 'DOGE-USDT' },
    GATE: { BTC: 'BTC_USDT', ETH: 'ETH_USDT', SOL: 'SOL_USDT', XRP: 'XRP_USDT', BNB: 'BNB_USDT', DOGE: 'DOGE_USDT' },
    UPBIT: { BTC: 'USDT-BTC', ETH: 'USDT-ETH', SOL: 'USDT-SOL', XRP: 'USDT-XRP', DOGE: 'USDT-DOGE' }, // USDT pairs
    BITGET: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT', HYPE: 'HYPEUSDT' },
    BINGX: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', BNB: 'BNB-USDT', DOGE: 'DOGE-USDT', HYPE: 'HYPE-USDT' },
    BITVAVO: { BTC: 'BTC-EUR', ETH: 'ETH-EUR', SOL: 'SOL-EUR', XRP: 'XRP-EUR', DOGE: 'DOGE-EUR' },
    GEMINI: { BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'DOGEUSD' },
    COINW: { BTC: 'BTC_USDT', ETH: 'ETH_USDT', SOL: 'SOL_USDT', XRP: 'XRP_USDT', DOGE: 'DOGE_USDT' },
    LBANK: { BTC: 'btc_usdt', ETH: 'eth_usdt', SOL: 'sol_usdt', XRP: 'xrp_usdt', DOGE: 'doge_usdt' },
    BITSTAMP: { BTC: 'btcusd', ETH: 'ethusd', SOL: 'solusd', XRP: 'xrpusd' }, // Bitstamp uses lowercase no separator
    BITSO: { BTC: 'btc_usd', ETH: 'eth_usd', SOL: 'sol_usd', XRP: 'xrp_usd', DOGE: 'doge_usd' },
    BULLISH: { BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'DOGEUSD' },
    [PROVIDERS.WHITEBIT]: { BTC: 'BTC_USDT', ETH: 'ETH_USDT', SOL: 'SOL_USDT', XRP: 'XRP_USDT', DOGE: 'DOGE_USDT' },
    [PROVIDERS.OURBIT]: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', DOGE: 'DOGE-USDT' },
    [PROVIDERS.WEEX]: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT' }
  };

  const TRACKED_COINS = new Set(COINS);
  for (const provider of Object.keys(MAP)) {
    const filtered = {};
    const source = MAP[provider] || {};
    for (const [sym, pair] of Object.entries(source)) {
      if (TRACKED_COINS.has(sym)) filtered[sym] = pair;
    }
    MAP[provider] = filtered;
  }

  function now() { return Date.now(); }

  function getProviderProfile(provider) {
    return PROVIDER_PROFILE[provider] || { marketType: 'unknown', venueType: 'unknown' };
  }

  function getProviderPair(provider, sym) {
    return MAP?.[provider]?.[sym] || null;
  }

  function applyMarketStructure(snap) {
    const bid = parseNum(snap.bid);
    const ask = parseNum(snap.ask);
    const price = parseNum(snap.price);
    const hasBook = Number.isFinite(bid) && Number.isFinite(ask) && ask > 0 && bid > 0 && ask >= bid;
    const mid = hasBook ? (bid + ask) / 2 : (Number.isFinite(price) ? price : null);
    const spreadAbs = hasBook ? Math.max(ask - bid, 0) : null;
    const spreadBps = hasBook && mid > 0 ? (spreadAbs / mid) * 20000 : null;
    const profile = getProviderProfile(snap.provider);

    snap.mid = mid;
    snap.spreadAbs = spreadAbs;
    snap.spreadBps = spreadBps;
    snap.marketType = profile.marketType;
    snap.venueType = profile.venueType;
    snap.pair = getProviderPair(snap.provider, snap.sym);
    snap.tradeImbalance = parseNum(snap.buyPct) != null && parseNum(snap.sellPct) != null
      ? (snap.buyPct - snap.sellPct) / 100
      : 0;
    return snap;
  }

  function ensureSnapshot(provider, sym) {
    if (!STORE[provider]) STORE[provider] = {};
    if (!STORE[provider][sym]) {
      const profile = getProviderProfile(provider);
      STORE[provider][sym] = {
        sym,
        provider,
        pair: getProviderPair(provider, sym),
        marketType: profile.marketType,
        venueType: profile.venueType,
        price: null,
        bid: null,
        ask: null,
        mid: null,
        spreadAbs: null,
        spreadBps: null,
        vol24h: null,
        buyPct: 50,
        sellPct: 50,
        tradeImbalance: 0,
        ts: 0,
        tradeTs: 0,
        trades: [], // { ts, qty, buy }
      };
    }
    return STORE[provider][sym];
  }

  function parseNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function probeOptionalRestRoute(name, force = false) {
    const provider = String(name || '').toUpperCase();
    if (!provider || !OPTIONAL_REST_ENDPOINTS[provider] || isProviderDisabled(provider)) return null;
    const prev = OPTIONAL_REST_STATUS[provider] || {};
    const tsNow = now();
    if (!force && prev.ts && (tsNow - prev.ts) < OPTIONAL_REST_PROBE_MIN_INTERVAL_MS) return prev;
    const endpoint = OPTIONAL_REST_ENDPOINTS[provider];
    const started = now();
    const attempts = [];
    if (typeof window.proxyFetch === 'function') {
      attempts.push({ fn: window.proxyFetch.bind(window), via: 'proxy', noCors: false });
    }
    attempts.push({ fn: fetch, via: 'direct', noCors: true });

    let lastError = '';
    for (const attempt of attempts) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('rest-probe-timeout')), OPTIONAL_REST_PROBE_TIMEOUT_MS);
      try {
        const res = await attempt.fn(endpoint, {
          method: 'GET',
          mode: attempt.noCors ? 'no-cors' : 'cors',
          cache: 'no-store',
          signal: ctrl.signal,
          headers: attempt.noCors ? undefined : { Accept: 'application/json,*/*' },
        });
        const latencyMs = Math.max(1, now() - started);
        const statusOk = attempt.noCors ? true : (typeof res?.ok === 'boolean' ? res.ok : res?.status < 400);
        if (!statusOk) {
          lastError = `HTTP ${res?.status || 'error'}`;
          continue;
        }
        OPTIONAL_REST_STATUS[provider] = {
          ok: true,
          ts: now(),
          latencyMs,
          endpoint,
          via: attempt.via,
          status: typeof res?.status === 'number' ? res.status : null,
          type: String(res?.type || 'basic'),
          error: '',
        };
        return OPTIONAL_REST_STATUS[provider];
      } catch (err) {
        lastError = String(err?.message || err || 'rest-probe-failed');
      } finally {
        clearTimeout(timer);
      }
    }

    OPTIONAL_REST_STATUS[provider] = {
      ok: false,
      ts: now(),
      latencyMs: Math.max(1, now() - started),
      endpoint,
      via: attempts.length > 1 ? 'proxy,direct' : 'direct',
      status: null,
      type: 'error',
      error: lastError || 'rest-probe-failed',
    };
    return OPTIONAL_REST_STATUS[provider];
  }

  function trimTrades(snap, refTs) {
    const cutoff = refTs - TRADE_WINDOW_MS;
    if (!snap.trades.length) return;
    let i = 0;
    while (i < snap.trades.length && snap.trades[i].ts < cutoff) i++;
    if (i > 0) snap.trades.splice(0, i);

    // Hard cap to prevent array explosion on high-volume coins (prevents CPU lockup in recalcTradeMix)
    if (snap.trades.length > 1000) {
      snap.trades = snap.trades.slice(-1000);
    }
  }

  function recalcTradeMix(snap) {
    if (!snap.trades.length) {
      snap.buyPct = 50;
      snap.sellPct = 50;
      return;
    }
    let buy = 0;
    let sell = 0;
    for (const t of snap.trades) {
      if (t.buy) buy += t.qty;
      else sell += t.qty;
    }
    const total = buy + sell;
    if (total <= 0) {
      snap.buyPct = 50;
      snap.sellPct = 50;
      return;
    }
    snap.buyPct = (buy / total) * 100;
    snap.sellPct = 100 - snap.buyPct;
  }

  function updateTicker(provider, sym, patch) {
    const snap = ensureSnapshot(provider, sym);
    if (patch.price != null) snap.price = patch.price;
    if (patch.bid != null) snap.bid = patch.bid;
    if (patch.ask != null) snap.ask = patch.ask;
    if (patch.vol24h != null) snap.vol24h = patch.vol24h;
    snap.ts = patch.ts || now();
    return applyMarketStructure(snap);
  }

  function updateTrade(provider, sym, trade) {
    const snap = ensureSnapshot(provider, sym);
    const ts = trade.ts || now();
    const qty = trade.qty != null && trade.qty > 0 ? trade.qty : 0;
    snap.trades.push({ ts, qty, buy: !!trade.buy });
    trimTrades(snap, ts);
    recalcTradeMix(snap);
    snap.tradeTs = ts;
    if (trade.price != null && trade.price > 0) snap.price = trade.price;
    snap.ts = ts;
    return applyMarketStructure(snap);
  }

  function conn(name) {
    if (!CONNECTIONS[name]) {
      CONNECTIONS[name] = { ws: null, reconnectMs: RECONNECT_BASE_MS, timer: null, active: false, extra: {} };
    }
    return CONNECTIONS[name];
  }

  function clearConnTimer(c) {
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = null;
    }
  }

  function jitterMs(baseMs) {
    const normalized = Math.max(250, Number(baseMs) || RECONNECT_BASE_MS);
    const extra = Math.floor(normalized * RECONNECT_JITTER_RATIO * Math.random());
    return normalized + extra;
  }

  function scheduleReconnect(name, reconnectFn) {
    const c = conn(name);
    if (!c.active) return;
    clearConnTimer(c);
    // If provider is disabled, skip reconnect until cooldown expires
    if (isProviderDisabled(name)) {
      const br = getBreakerState(name);
      const wait = Math.max(0, br.openUntil - Date.now());
      c.timer = setTimeout(() => reconnectFn(), wait + 1000);
      return;
    }
    const delay = jitterMs(c.reconnectMs);
    c.timer = setTimeout(() => reconnectFn(), delay);
    c.reconnectMs = Math.min(Math.floor(c.reconnectMs * 1.5), RECONNECT_MAX_MS);
  }

  function bindCloseReconnect(name, reconnectFn) {
    const c = conn(name);
    if (!c.ws) return;
    const socket = c.ws;
    c.extra.lastFailureAt = 0;
    socket.onclose = (ev) => {
      if (c.ws !== socket) return;
      c.ws = null;
      if (c.extra.pingTimer) {
        clearInterval(c.extra.pingTimer);
        c.extra.pingTimer = null;
      }
      const code = Number(ev?.code || 0);
      const cleanClose = ev?.wasClean === true || code === 1000;
      const duplicateFailure = c.extra.lastFailureAt && (Date.now() - c.extra.lastFailureAt) < 1200;
      if (!cleanClose && !duplicateFailure) {
        c.extra.lastFailureAt = Date.now();
        recordFailure(name);
        if (typeof c.extra.onFailure === 'function') c.extra.onFailure(ev);
      }
      scheduleReconnect(name, reconnectFn);
    };
    socket.onerror = () => {
      if (c.ws !== socket) return;
      c.extra.lastFailureAt = Date.now();
      recordFailure(name);
      if (typeof c.extra.onFailure === 'function') c.extra.onFailure();
      try { socket.close(); } catch (_) { }
    };
  }

  function scheduleProviderStart(name, connectFn, delayMs = 0) {
    const c = conn(name);
    c.active = !isProviderConfiguredOff(name);
    clearConnTimer(c);
    if (!c.active) return;
    c.timer = setTimeout(() => {
      c.timer = null;
      if (!c.active) return;
      if (isProviderDisabled(name)) {
        scheduleReconnect(name, connectFn);
        return;
      }
      Promise.resolve()
        .then(connectFn)
        .catch((err) => {
          c.extra.lastStartError = String(err?.message || err || 'startup failed');
          recordFailure(name);
          scheduleReconnect(name, connectFn);
        });
    }, Math.max(0, Number(delayMs) || 0));
  }

  function optionalPoolMaxActive() {
    const configured = Number(runtimeFlag('WECRYPTO_OPTIONAL_WS_POOL_MAX_ACTIVE'));
    return Number.isFinite(configured) && configured > 0 ? Math.min(12, Math.floor(configured)) : 8;
  }

  function closeProvider(name) {
    const c = conn(name);
    c.active = false;
    clearConnTimer(c);
    if (c.extra.pingTimer) {
      clearInterval(c.extra.pingTimer);
      c.extra.pingTimer = null;
    }
    try { c.ws && c.ws.close(); } catch (_) { }
    c.ws = null;
  }

  function providerPoolRunning(name) {
    const c = conn(name);
    if (!c.active) return false;
    if (c.timer) return true;
    return c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING);
  }

  function optionalPoolTick() {
    const roster = OPTIONAL_WS_POOL.roster || [];
    if (!roster.length) return;
    const nowTs = now();

    for (const cfg of roster) {
      if (isProviderExplicitlyOff(cfg.name)) {
        closeProvider(cfg.name);
        cfg.activeUntil = 0;
        continue;
      }
      if (cfg.activeUntil && nowTs >= cfg.activeUntil) {
        closeProvider(cfg.name);
        cfg.activeUntil = 0;
      }
    }

    const maxActive = optionalPoolMaxActive();
    let activeCount = roster.filter(cfg => providerPoolRunning(cfg.name)).length;
    if (activeCount >= maxActive) return;

    const due = roster
      .filter(cfg => !providerPoolRunning(cfg.name))
      .filter(cfg => !isProviderExplicitlyOff(cfg.name))
      .filter(cfg => nowTs >= Number(cfg.nextDue || 0))
      .sort((a, b) => Number(a.nextDue || 0) - Number(b.nextDue || 0));

    const probeCandidates = roster
      .filter(cfg => !providerPoolRunning(cfg.name))
      .filter(cfg => !isProviderExplicitlyOff(cfg.name))
      .sort((a, b) => {
        const aTs = OPTIONAL_REST_STATUS[cfgName(a)]?.ts || 0;
        const bTs = OPTIONAL_REST_STATUS[cfgName(b)]?.ts || 0;
        return aTs - bTs;
      })
      .slice(0, OPTIONAL_REST_PROBE_BATCH);
    for (const probeCandidate of probeCandidates) {
      void probeOptionalRestRoute(cfgName(probeCandidate));
    }

    for (const cfg of due) {
      if (activeCount >= maxActive) break;
      const dwellMs = Number(cfg.dwellMs || OPTIONAL_WS_POOL_DEFAULT_DWELL_MS);
      scheduleProviderStart(cfg.name, cfg.connectFn, 0);
      cfg.lastStart = nowTs;
      cfg.nextDue = nowTs + Number(cfg.intervalMs || 60000);
      cfg.activeUntil = nowTs + dwellMs;
      activeCount++;
    }
  }

  function startOptionalWsPool(roster, initialDelayMs = 0) {
    stopOptionalWsPool();
    const startAt = now() + Math.max(0, Number(initialDelayMs) || 0);
    OPTIONAL_WS_POOL.roster = roster.map((cfg, index) => ({
      ...cfg,
      nextDue: startAt + index * 2500,
      activeUntil: 0,
      lastStart: 0,
    }));
    OPTIONAL_WS_POOL.timer = setInterval(optionalPoolTick, OPTIONAL_WS_POOL_TICK_MS);
    setTimeout(optionalPoolTick, Math.max(0, Number(initialDelayMs) || 0));
  }

  function warmOptionalWsRoutes(reason = 'manual') {
    // NO-OP to reduce spam from failing optionals (429/403/404/502 seen in logs).
    // 15m pooling for majors relies on Coinbase WS + CB/BIN 15m REST, not these.
    if (reason !== 'startup') {
      console.log('[ExchangeWS] Optional WS/REST warming disabled - focusing on core 15m sources.');
    }
  }

  function cfgName(cfg) {
    return String(cfg?.name || '').toUpperCase();
  }

  function stopOptionalWsPool() {
    if (OPTIONAL_WS_POOL.timer) {
      clearInterval(OPTIONAL_WS_POOL.timer);
      OPTIONAL_WS_POOL.timer = null;
    }
    for (const cfg of OPTIONAL_WS_POOL.roster || []) {
      closeProvider(cfg.name);
      cfg.activeUntil = 0;
    }
  }

  // ───────────────────────── Binance ─────────────────────────
  function connectBinance() {
    if (isProviderDisabled('BINANCE')) return;
    const name = 'BINANCE';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    const symbols = Object.values(MAP.BINANCE);
    const streams = [];
    for (const s of symbols) {
      streams.push(`${s}@ticker`);
      streams.push(`${s}@trade`);
    }
    const endpoints = getBinanceWsEndpoints();
    const endpointIndex = Number(c.extra.endpointIndex || 0) % Math.max(1, endpoints.length);
    const endpoint = endpoints[endpointIndex] || DEFAULT_BINANCE_WS_ENDPOINTS[0];
    const url = `${endpoint}/stream?streams=${streams.join('/')}`;
    c.extra.onFailure = () => {
      if (endpoints.length > 1) c.extra.endpointIndex = (endpointIndex + 1) % endpoints.length;
    };
    c.ws = new WebSocket(url);
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      c.extra.endpointIndex = endpointIndex;
      c.extra.lastEndpoint = endpoint;
      recordSuccess('BINANCE');
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BINANCE');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const stream = msg?.stream || '';
      const data = msg?.data || {};
      const pair = stream.split('@')[0];
      if (!pair) return;
      const sym = Object.keys(MAP.BINANCE).find(k => MAP.BINANCE[k] === pair);
      if (!sym) return;
      if (stream.endsWith('@ticker')) {
        updateTicker(PROVIDERS.BINANCE, sym, {
          price: parseNum(data.c),
          bid: parseNum(data.b),
          ask: parseNum(data.a),
          vol24h: parseNum(data.q),
          ts: parseNum(data.E) || now(),
        });
      } else if (stream.endsWith('@trade')) {
        const qty = parseNum(data.q) || 0;
        updateTrade(PROVIDERS.BINANCE, sym, {
          buy: !data.m, // buyer was taker
          qty,
          price: parseNum(data.p),
          ts: parseNum(data.T) || now(),
        });
      }
    };
    bindCloseReconnect(name, connectBinance);
  }

  // ─────────────────────── Coinbase Pro ───────────────────────
  function connectCoinbase() {
    if (isProviderDisabled('COINBASE')) return;
    const name = 'COINBASE';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('COINBASE');
      const products = Object.values(MAP.COINBASE);
      c.ws.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats' }));
      c.ws.send(JSON.stringify({ type: 'subscribe', channel: 'ticker', product_ids: products }));
      c.ws.send(JSON.stringify({ type: 'subscribe', channel: 'market_trades', product_ids: products }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('COINBASE');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.channel === 'ticker' && Array.isArray(msg.events)) {
        for (const event of msg.events) {
          for (const t of (event.tickers || [])) {
            const sym = Object.keys(MAP.COINBASE).find(k => MAP.COINBASE[k] === t.product_id);
            if (!sym) continue;
            updateTicker(PROVIDERS.COINBASE, sym, {
              price: parseNum(t.price),
              bid: parseNum(t.best_bid),
              ask: parseNum(t.best_ask),
              vol24h: parseNum(t.volume_24_h),
              ts: now(),
            });
          }
        }
        return;
      }
      if (msg.channel === 'market_trades' && Array.isArray(msg.events)) {
        for (const event of msg.events) {
          const trades = Array.isArray(event.trades) ? event.trades : [];
          for (const t of trades) {
            const sym = Object.keys(MAP.COINBASE).find(k => MAP.COINBASE[k] === t.product_id);
            if (!sym) continue;
            updateTrade(PROVIDERS.COINBASE, sym, {
              buy: String(t.side || '').toUpperCase() === 'BUY',
              qty: parseNum(t.size) || 0,
              price: parseNum(t.price),
              ts: t.time ? Date.parse(t.time) || now() : now(),
            });
          }
        }
        return;
      }
      const productId = msg.product_id || msg.productId;
      if (!productId) return;
      const sym = Object.keys(MAP.COINBASE).find(k => MAP.COINBASE[k] === productId);
      if (!sym) return;
      if (msg.type === 'ticker') {
        updateTicker(PROVIDERS.COINBASE, sym, {
          price: parseNum(msg.price),
          bid: parseNum(msg.best_bid),
          ask: parseNum(msg.best_ask),
          vol24h: parseNum(msg.volume_24h),
          ts: now(),
        });
      } else if (msg.type === 'match' || msg.type === 'last_match' || msg.type === 'trade') {
        updateTrade(PROVIDERS.COINBASE, sym, {
          buy: msg.side === 'buy',
          qty: parseNum(msg.size || msg.quantity) || 0,
          price: parseNum(msg.price),
          ts: msg.time ? Date.parse(msg.time) || now() : now(),
        });
      }
    };
    bindCloseReconnect(name, connectCoinbase);
  }

  // ───────────────────────── Kraken ───────────────────────────
  function connectKraken() {
    if (isProviderDisabled('KRAKEN')) return;
    const name = 'KRAKEN';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.kraken.com/v2');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('KRAKEN');
      const pairs = Object.values(MAP.KRAKEN);
      c.ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: pairs } }));
      c.ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: pairs } }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('KRAKEN');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (Array.isArray(msg) && msg.length >= 3) {
        const channel = msg[1];
        const pair = msg[2];
        const sym = Object.keys(MAP.KRAKEN).find(k => MAP.KRAKEN[k] === pair);
        if (!sym) return;
        if (channel === 'ticker') {
          const d = msg[0] || {};
          updateTicker(PROVIDERS.KRAKEN, sym, {
            price: parseNum(d.c?.[0] || d.last || d.price),
            bid: parseNum(d.b?.[0] || d.bid),
            ask: parseNum(d.a?.[0] || d.ask),
            vol24h: parseNum(d.v?.[1] || d.volume || d.vol24h),
            ts: now(),
          });
        } else if (channel === 'trade') {
          const rows = Array.isArray(msg[0]) ? msg[0] : [];
          for (const t of rows) {
            updateTrade(PROVIDERS.KRAKEN, sym, {
              buy: String(t?.[3] || '').toLowerCase() === 'b',
              qty: parseNum(t?.[1]) || 0,
              price: parseNum(t?.[0]),
              ts: t?.[2] ? Math.floor(parseFloat(t[2]) * 1000) : now(),
            });
          }
        }
        return;
      }
      const channel = msg.channel || msg.type;
      const pair = msg.symbol || msg.pair;
      const sym = Object.keys(MAP.KRAKEN).find(k => MAP.KRAKEN[k] === pair);
      if (!sym) return;
      if (channel === 'ticker') {
        const payload = msg[1] || {};
        updateTicker(PROVIDERS.KRAKEN, sym, {
          price: parseNum(payload.c?.[0]),
          bid: parseNum(payload.b?.[0]),
          ask: parseNum(payload.a?.[0]),
          vol24h: parseNum(payload.v?.[1]),
          ts: now(),
        });
      } else if (channel === 'trade') {
        const trades = msg[1] || [];
        for (const t of trades) {
          const side = t?.[3];
          updateTrade(PROVIDERS.KRAKEN, sym, {
            buy: side === 'b',
            qty: parseNum(t?.[1]) || 0,
            price: parseNum(t?.[0]),
            ts: t?.[2] ? Math.floor(parseFloat(t[2]) * 1000) : now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectKraken);
  }

  // ───────────────────────── Bybit ────────────────────────────
  function connectBybit() {
    if (isProviderDisabled('BYBIT')) return;
    const name = 'BYBIT';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('BYBIT');
      const syms = Object.values(MAP.BYBIT);
      c.ws.send(JSON.stringify({ op: 'subscribe', args: syms.map(s => `tickers.${s}`) }));
      c.ws.send(JSON.stringify({ op: 'subscribe', args: syms.map(s => `publicTrade.${s}`) }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BYBIT');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const topic = msg?.topic || '';
      if (!topic.includes('.')) return;
      const pair = topic.split('.').slice(1).join('.');
      const sym = Object.keys(MAP.BYBIT).find(k => MAP.BYBIT[k] === pair);
      if (!sym) return;
      if (topic.startsWith('tickers.')) {
        const d = msg?.data || {};
        updateTicker(PROVIDERS.BYBIT, sym, {
          price: parseNum(d.lastPrice),
          bid: parseNum(d.bid1Price),
          ask: parseNum(d.ask1Price),
          vol24h: parseNum(d.turnover24h || d.volume24h),
          ts: now(),
        });
      } else if (topic.startsWith('publicTrade.')) {
        const rows = Array.isArray(msg?.data) ? msg.data : [];
        for (const r of rows) {
          updateTrade(PROVIDERS.BYBIT, sym, {
            buy: String(r.S || '').toLowerCase() === 'buy',
            qty: parseNum(r.v) || 0,
            price: parseNum(r.p),
            ts: parseNum(r.T) || now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectBybit);
  }

  // ─────────────────────── Hyperliquid (DEX Perps) ────────────────────────
  function connectHyperliquid() {
    if (isProviderDisabled('HYPERLIQUID')) return;
    const name = 'HYPERLIQUID';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('HYPERLIQUID');
      c.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
      for (const coin of Object.values(MAP.HYPERLIQUID)) {
        c.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
        c.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
      }
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('HYPERLIQUID');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const channel = String(msg?.channel || msg?.subscription?.type || msg?.type || '').toLowerCase();
      const payload = msg?.data || {};

      const mids = payload?.mids || (channel.includes('allmids') ? payload : null);
      if (mids && typeof mids === 'object') {
        for (const [coin, midPx] of Object.entries(mids)) {
          const sym = Object.keys(MAP.HYPERLIQUID).find(k => MAP.HYPERLIQUID[k] === coin || k === String(coin).toUpperCase());
          if (!sym) continue;
          updateTicker(PROVIDERS.HYPERLIQUID, sym, { price: parseNum(midPx), ts: now() });
        }
      }

      if (channel.includes('l2book') || payload?.levels) {
        const coin = payload?.coin || msg?.coin || msg?.subscription?.coin;
        const sym = Object.keys(MAP.HYPERLIQUID).find(k => MAP.HYPERLIQUID[k] === coin || k === String(coin || '').toUpperCase());
        if (sym) {
          const levels = payload?.levels || [];
          const bids = Array.isArray(levels[0]) ? levels[0] : [];
          const asks = Array.isArray(levels[1]) ? levels[1] : [];
          const topBid = bids[0] || {};
          const topAsk = asks[0] || {};
          const bid = parseNum(topBid.px ?? topBid[0]);
          const ask = parseNum(topAsk.px ?? topAsk[0]);
          const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
          updateTicker(PROVIDERS.HYPERLIQUID, sym, { bid, ask, price: mid, ts: now() });
        }
      }

      if (channel.includes('trade')) {
        const coin = payload?.coin || msg?.coin || msg?.subscription?.coin;
        const sym = Object.keys(MAP.HYPERLIQUID).find(k => MAP.HYPERLIQUID[k] === coin || k === String(coin || '').toUpperCase());
        if (!sym) return;
        const rows = Array.isArray(payload?.trades) ? payload.trades : (Array.isArray(payload) ? payload : []);
        for (const t of rows) {
          const side = String(t?.side || '').toLowerCase();
          const ts = parseNum(t?.time);
          updateTrade(PROVIDERS.HYPERLIQUID, sym, {
            buy: side === 'buy' || side === 'bid' || side === 'b',
            qty: parseNum(t?.sz ?? t?.size ?? t?.amount) || 0,
            price: parseNum(t?.px ?? t?.price),
            ts: Number.isFinite(ts) ? (ts < 1e12 ? ts * 1000 : ts) : now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectHyperliquid);
  }

  // ────────────────────────────────────────────────────────────────────────
  // OURBIT
  // ────────────────────────────────────────────────────────────────────────
  function connectOurbit() {
    if (isProviderDisabled('OURBIT')) return;
    const name = 'OURBIT';
    const c = conn('OURBIT');
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;

    c.ws = new WebSocket('wss://ws.ourbit.com/ws');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('OURBIT');
      const pairs = Object.values(MAP[PROVIDERS.OURBIT]);
      pairs.forEach(p => {
        c.ws.send(JSON.stringify({ op: 'subscribe', args: [`ticker:${p}`] }));
        c.ws.send(JSON.stringify({ op: 'subscribe', args: [`trade:${p}`] }));
      });
      c.extra.pingTimer = setInterval(() => {
        if (c.ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ op: 'ping' }));
      }, 20000);
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('OURBIT');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.event === 'pong') return;

      if (msg.topic && msg.topic.startsWith('ticker:')) {
        const pair = msg.topic.split(':')[1];
        const sym = Object.keys(MAP[PROVIDERS.OURBIT]).find(k => MAP[PROVIDERS.OURBIT][k] === pair);
        if (sym && msg.data) {
          updateTicker(PROVIDERS.OURBIT, sym, { price: parseNum(msg.data.lastPrice), vol24h: parseNum(msg.data.volume24h), bid: parseNum(msg.data.bestBid), ask: parseNum(msg.data.bestAsk), ts: now() });
        }
      } else if (msg.topic && msg.topic.startsWith('trade:')) {
        const pair = msg.topic.split(':')[1];
        const sym = Object.keys(MAP[PROVIDERS.OURBIT]).find(k => MAP[PROVIDERS.OURBIT][k] === pair);
        if (sym && msg.data) {
          const arr = Array.isArray(msg.data) ? msg.data : [msg.data];
          arr.forEach(t => {
            updateTrade(PROVIDERS.OURBIT, sym, { buy: t.side === 'buy', qty: parseNum(t.size), price: parseNum(t.price), ts: t.time || now() });
          });
        }
      }
    };
    bindCloseReconnect(name, connectOurbit);
    const origClose = c.ws.onclose;
    c.ws.onclose = (ev) => {
      if (c.extra.pingTimer) clearInterval(c.extra.pingTimer);
      c.extra.pingTimer = null;
      if (origClose) origClose(ev);
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // WEEX
  // ────────────────────────────────────────────────────────────────────────
  function connectWeex() {
    if (isProviderDisabled('WEEX')) return;
    const name = 'WEEX';
    const c = conn('WEEX');
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;

    c.ws = new WebSocket('wss://ws-spot.weex.com/v3/ws/public');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('WEEX');
      const pairs = Object.values(MAP[PROVIDERS.WEEX]);
      pairs.forEach(p => {
        c.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${p}@ticker`], id: 1 }));
        c.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${p}@trade`], id: 2 }));
      });
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('WEEX');
      let msg;
      if (typeof ev.data === 'string' && ev.data === 'ping') {
        c.ws.send(JSON.stringify({ method: 'PONG', id: 1 }));
        return;
      }
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      
      if (msg.event === 'ping') {
        c.ws.send(JSON.stringify({ method: 'PONG', id: 1 }));
        return;
      }

      if (msg.ch && msg.ch.endsWith('@ticker')) {
        const pair = msg.ch.split('@')[0];
        const sym = Object.keys(MAP[PROVIDERS.WEEX]).find(k => MAP[PROVIDERS.WEEX][k] === pair);
        if (sym && msg.data) {
          updateTicker(PROVIDERS.WEEX, sym, { price: parseNum(msg.data.c), vol24h: parseNum(msg.data.v), ts: now() });
        }
      } else if (msg.ch && msg.ch.endsWith('@trade')) {
        const pair = msg.ch.split('@')[0];
        const sym = Object.keys(MAP[PROVIDERS.WEEX]).find(k => MAP[PROVIDERS.WEEX][k] === pair);
        if (sym && msg.data) {
          const arr = Array.isArray(msg.data) ? msg.data : [msg.data];
          arr.forEach(t => {
            updateTrade(PROVIDERS.WEEX, sym, { buy: t.S === '1', qty: parseNum(t.v), price: parseNum(t.p), ts: t.t || now() });
          });
        }
      }
    };
    bindCloseReconnect(name, connectWeex);
  }

  // ───────────────────────── OKX ──────────────────────────────
  function connectOKX() {
    if (isProviderDisabled('OKX')) return;
    const name = 'OKX';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('OKX');
      const inst = Object.values(MAP.OKX);
      c.ws.send(JSON.stringify({ op: 'subscribe', args: inst.map(s => ({ channel: 'tickers', instId: s })) }));
      c.ws.send(JSON.stringify({ op: 'subscribe', args: inst.map(s => ({ channel: 'trades', instId: s })) }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('OKX');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const arg = msg?.arg || {};
      const instId = arg.instId;
      const channel = arg.channel;
      if (!instId || !channel) return;
      const sym = Object.keys(MAP.OKX).find(k => MAP.OKX[k] === instId);
      if (!sym) return;
      const rows = Array.isArray(msg?.data) ? msg.data : [];
      if (channel === 'tickers') {
        const d = rows[0] || {};
        updateTicker(PROVIDERS.OKX, sym, {
          price: parseNum(d.last),
          bid: parseNum(d.bidPx),
          ask: parseNum(d.askPx),
          vol24h: parseNum(d.volCcy24h || d.vol24h),
          ts: parseNum(d.ts) || now(),
        });
      } else if (channel === 'trades') {
        for (const d of rows) {
          updateTrade(PROVIDERS.OKX, sym, {
            buy: String(d.side || '').toLowerCase() === 'buy',
            qty: parseNum(d.sz) || 0,
            price: parseNum(d.px),
            ts: parseNum(d.ts) || now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectOKX);
  }

  // ───────────────────────── KuCoin ───────────────────────────
  async function connectKuCoin() {
    if (isProviderDisabled('KUCOIN')) return;
    const name = 'KUCOIN';
    const c = conn(name);
    if (!c.active) return;
    if (c.extra.connecting) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.extra.connecting = true;
    try {
      const res = await fetch('https://api.kucoin.com/api/v1/bullet-public', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const endpoint = body?.data?.instanceServers?.[0]?.endpoint;
      const token = body?.data?.token;
      if (!endpoint || !token) throw new Error('No KuCoin token/endpoint');
      const connectId = `wecrypto-${Math.random().toString(36).slice(2)}`;
      const socket = new WebSocket(`${endpoint}?token=${token}&connectId=${connectId}`);
      c.ws = socket;
      c.extra.connecting = false;
      socket.onopen = () => {
        if (c.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
        c.reconnectMs = RECONNECT_BASE_MS;
        recordSuccess('KUCOIN');
        const pairs = Object.values(MAP.KUCOIN).join(',');
        socket.send(JSON.stringify({ id: Date.now(), type: 'subscribe', topic: `/market/ticker:${pairs}`, privateChannel: false, response: true }));
        socket.send(JSON.stringify({ id: Date.now() + 1, type: 'subscribe', topic: `/market/match:${pairs}`, privateChannel: false, response: true }));
        if (c.extra.pingTimer) clearInterval(c.extra.pingTimer);
        c.extra.pingTimer = setInterval(() => {
          try {
            if (c.ws === socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ id: Date.now(), type: 'ping' }));
            }
          } catch (_) { }
        }, 18000);
      };
      socket.onmessage = (ev) => {
        if (c.ws !== socket) return;
        recordSuccess('KUCOIN');
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === 'welcome' || msg.type === 'ack' || msg.type === 'pong') return;
        const topic = msg.topic || '';
        const data = msg.data || {};
        const pair = topic.split(':')[1];
        if (!pair) return;
        const sym = Object.keys(MAP.KUCOIN).find(k => MAP.KUCOIN[k] === pair);
        if (!sym) return;
        if (topic.startsWith('/market/ticker:')) {
          updateTicker(PROVIDERS.KUCOIN, sym, {
            price: parseNum(data.price),
            bid: parseNum(data.bestBid),
            ask: parseNum(data.bestAsk),
            vol24h: parseNum(data.volValue || data.vol),
            ts: parseNum(data.time) || now(),
          });
        } else if (topic.startsWith('/market/match:')) {
          updateTrade(PROVIDERS.KUCOIN, sym, {
            buy: String(data.side || '').toLowerCase() === 'buy',
            qty: parseNum(data.size) || 0,
            price: parseNum(data.price),
            ts: parseNum(data.time) || now(),
          });
        }
      };
      bindCloseReconnect(name, connectKuCoin);
    } catch (_) {
      c.extra.connecting = false;
      scheduleReconnect(name, connectKuCoin);
    }
  }

  // ───────────────────────── Gate.io ──────────────────────────
  function connectGate() {
    if (isProviderDisabled('GATE')) return;
    const name = 'GATE';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://api.gateio.ws/ws/v4/');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('GATE');
      const pairs = Object.values(MAP.GATE);
      c.ws.send(JSON.stringify({ time: Math.floor(now() / 1000), channel: 'spot.tickers', event: 'subscribe', payload: pairs }));
      c.ws.send(JSON.stringify({ time: Math.floor(now() / 1000), channel: 'spot.trades', event: 'subscribe', payload: pairs }));
      if (c.extra.pingTimer) clearInterval(c.extra.pingTimer);
      c.extra.pingTimer = setInterval(() => {
        try {
          if (c.ws?.readyState === WebSocket.OPEN) {
            c.ws.send(JSON.stringify({ time: Math.floor(now() / 1000), channel: 'spot.ping' }));
          }
        } catch (_) { }
      }, 25000);
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('GATE');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const channel = msg?.channel || '';
      if (msg?.event === 'subscribe' || msg?.event === 'pong') return;
      const result = msg?.result;
      if (!result) return;
      if (channel === 'spot.tickers') {
        const rows = Array.isArray(result) ? result : [result];
        for (const d of rows) {
          const pair = d.currency_pair;
          const sym = Object.keys(MAP.GATE).find(k => MAP.GATE[k] === pair);
          if (!sym) continue;
          updateTicker(PROVIDERS.GATE, sym, {
            price: parseNum(d.last),
            bid: parseNum(d.highest_bid),
            ask: parseNum(d.lowest_ask),
            vol24h: parseNum(d.quote_volume || d.base_volume),
            ts: now(),
          });
        }
      } else if (channel === 'spot.trades') {
        const rows = Array.isArray(result) ? result : [result];
        for (const d of rows) {
          const pair = d.currency_pair;
          const sym = Object.keys(MAP.GATE).find(k => MAP.GATE[k] === pair);
          if (!sym) continue;
          const side = String(d.side || d.type || '').toLowerCase();
          updateTrade(PROVIDERS.GATE, sym, {
            buy: side === 'buy',
            qty: parseNum(d.amount || d.size) || 0,
            price: parseNum(d.price),
            ts: parseNum(d.create_time_ms || d.time_ms) || now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectGate);
  }

  // ───────────────────────── Upbit ──────────────────────────────
  function connectUpbit() {
    if (isProviderDisabled('UPBIT')) return;
    const name = 'UPBIT';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://api.upbit.com/websocket/v1');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('UPBIT');
      const codes = Object.values(MAP.UPBIT);
      c.ws.send(JSON.stringify([
        { ticket: "wecrypto" },
        { type: "ticker", codes, isOnlyRealtime: true },
        { type: "trade", codes, isOnlyRealtime: true }
      ]));
    };
    c.ws.onerror = (e) => {
      // Upbit often 429 on handshake - slow down reconnect aggressively
      if (c.reconnectMs < 30000) c.reconnectMs = 30000;
      console.warn('[UpbitWS] handshake error (likely rate limit 429), backing off');
    };
    c.ws.onmessage = async (ev) => {
      recordSuccess('UPBIT');
      let text;
      try {
        if (ev.data instanceof Blob) text = await ev.data.text();
        else text = ev.data;
      } catch (_) { return; }
      let msg;
      try { msg = JSON.parse(text); } catch (_) { return; }
      
      const code = msg?.code;
      if (!code) return;
      const sym = Object.keys(MAP.UPBIT).find(k => MAP.UPBIT[k] === code);
      if (!sym) return;

      if (msg.type === 'ticker') {
        updateTicker(PROVIDERS.UPBIT, sym, {
          price: parseNum(msg.trade_price),
          bid: null,
          ask: null,
          vol24h: parseNum(msg.acc_trade_volume_24h),
          ts: msg.timestamp || now(),
        });
      } else if (msg.type === 'trade') {
        updateTrade(PROVIDERS.UPBIT, sym, {
          buy: msg.ask_bid === 'BID',
          qty: parseNum(msg.trade_volume) || 0,
          price: parseNum(msg.trade_price),
          ts: msg.timestamp || now(),
        });
      }
    };
    bindCloseReconnect(name, connectUpbit);
  }

  // ───────────────────────── Bitget ─────────────────────────────
  function connectBitget() {
    if (isProviderDisabled('BITGET')) return;
    const name = 'BITGET';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('BITGET');
      const args = Object.values(MAP.BITGET).map(s => ({ instType: 'SPOT', channel: 'ticker', instId: s }));
      const argsTrade = Object.values(MAP.BITGET).map(s => ({ instType: 'SPOT', channel: 'trade', instId: s }));
      c.ws.send(JSON.stringify({ op: 'subscribe', args: [...args, ...argsTrade] }));
      
      if (c.extra.pingTimer) clearInterval(c.extra.pingTimer);
      c.extra.pingTimer = setInterval(() => {
        try { if (c.ws?.readyState === WebSocket.OPEN) c.ws.send('ping'); } catch (_) { }
      }, 30000);
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BITGET');
      if (ev.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const arg = msg?.arg || {};
      const instId = arg.instId;
      if (!instId) return;
      const sym = Object.keys(MAP.BITGET).find(k => MAP.BITGET[k] === instId);
      if (!sym) return;
      
      const rows = Array.isArray(msg?.data) ? msg.data : [];
      if (arg.channel === 'ticker') {
        const d = rows[0] || {};
        updateTicker(PROVIDERS.BITGET, sym, {
          price: parseNum(d.lastPr),
          bid: parseNum(d.bidPr),
          ask: parseNum(d.askPr),
          vol24h: parseNum(d.baseVolume),
          ts: parseNum(d.ts) || now(),
        });
      } else if (arg.channel === 'trade') {
        for (const d of rows) {
          updateTrade(PROVIDERS.BITGET, sym, {
            buy: String(d.side || '').toLowerCase() === 'buy',
            qty: parseNum(d.size) || 0,
            price: parseNum(d.price),
            ts: parseNum(d.ts) || now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectBitget);
  }

  // ───────────────────────── BingX ──────────────────────────────
  function connectBingX() {
    if (isProviderDisabled('BINGX')) return;
    const name = 'BINGX';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://open-api-ws.bingx.com/market');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('BINGX');
      const symbols = Object.values(MAP.BINGX);
      for (const s of symbols) {
        c.ws.send(JSON.stringify({ id: `ticker_${s}`, reqType: "sub", dataType: `${s}@ticker` }));
        c.ws.send(JSON.stringify({ id: `trade_${s}`, reqType: "sub", dataType: `${s}@trade` }));
      }
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BINGX');
      let text = ev.data;
      if (text instanceof Blob) return;
      if (text === 'Ping') {
        c.ws.send('Pong');
        return;
      }
      let msg;
      try { msg = JSON.parse(text); } catch (_) { return; }
      
      const dataType = msg?.dataType || '';
      if (!dataType) return;
      const pair = dataType.split('@')[0];
      const sym = Object.keys(MAP.BINGX).find(k => MAP.BINGX[k] === pair);
      if (!sym) return;
      const data = msg?.data;
      if (!data) return;

      if (dataType.endsWith('@ticker')) {
        updateTicker(PROVIDERS.BINGX, sym, {
          price: parseNum(data.c),
          bid: parseNum(data.b),
          ask: parseNum(data.a),
          vol24h: parseNum(data.v),
          ts: parseNum(data.T) || now(),
        });
      } else if (dataType.endsWith('@trade')) {
        const rows = Array.isArray(data) ? data : [data];
        for (const t of rows) {
          updateTrade(PROVIDERS.BINGX, sym, {
            buy: !t.m,
            qty: parseNum(t.q) || 0,
            price: parseNum(t.p),
            ts: parseNum(t.T) || now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectBingX);
  }

  // ───────────────────────── Bitvavo ──────────────────────────
  function connectBitvavo() {
    if (isProviderDisabled('BITVAVO')) return;
    const name = 'BITVAVO';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.bitvavo.com/v2/');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('BITVAVO');
      const markets = Object.values(MAP.BITVAVO);
      c.ws.send(JSON.stringify({ action: 'subscribe', channels: [{ name: 'ticker', markets }, { name: 'trades', markets }] }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BITVAVO');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.event === 'ticker') {
        const sym = Object.keys(MAP.BITVAVO).find(k => MAP.BITVAVO[k] === msg.market);
        if (sym) updateTicker(PROVIDERS.BITVAVO, sym, { price: parseNum(msg.lastPrice), bid: parseNum(msg.bestBid), ask: parseNum(msg.bestAsk), vol24h: parseNum(msg.volume24h), ts: now() });
      } else if (msg.event === 'trade') {
        const sym = Object.keys(MAP.BITVAVO).find(k => MAP.BITVAVO[k] === msg.market);
        if (sym) updateTrade(PROVIDERS.BITVAVO, sym, { buy: msg.side === 'buy', qty: parseNum(msg.amount), price: parseNum(msg.price), ts: msg.timestamp || now() });
      }
    };
    bindCloseReconnect(name, connectBitvavo);
  }

  // ───────────────────────── Gemini ───────────────────────────
  function connectGemini() {
    if (isProviderDisabled('GEMINI')) return;
    const name = 'GEMINI';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    const symbols = Object.values(MAP.GEMINI).join(',');
    c.ws = new WebSocket(`wss://api.gemini.com/v1/multimarketdata?symbols=${symbols}&bids=true&offers=true&trades=true`);
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('GEMINI');
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('GEMINI');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'update' && msg.events) {
        const pair = msg.symbol || (msg.events[0] && msg.events[0].symbol);
        if (!pair) return;
        const sym = Object.keys(MAP.GEMINI).find(k => MAP.GEMINI[k] === pair);
        if (!sym) return;
        for (const e of msg.events) {
          if (e.type === 'trade') {
            updateTrade(PROVIDERS.GEMINI, sym, { buy: e.makerSide === 'ask', qty: parseNum(e.amount), price: parseNum(e.price), ts: msg.timestampms || now() });
          } else if (e.type === 'change') {
            updateTicker(PROVIDERS.GEMINI, sym, { price: parseNum(e.price), ts: msg.timestampms || now() });
          }
        }
      }
    };
    bindCloseReconnect(name, connectGemini);
  }

  // ───────────────────────── CoinW ────────────────────────────
  function connectCoinW() {
    if (isProviderDisabled('COINW')) return;
    const name = 'COINW';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.futurescw.info');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('COINW');
      const pairs = Object.values(MAP.COINW);
      pairs.forEach(p => c.ws.send(JSON.stringify({ cmd: 'req', args: [`ticker:${p}`, `trade:${p}`] })));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('COINW');
      // Generic fallback WS parser for CoinW undocumented streams
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const channel = msg.ch || msg.channel || '';
      if (!channel) return;
      const sym = Object.keys(MAP.COINW).find(k => channel.includes(MAP.COINW[k]));
      if (!sym) return;
      if (channel.includes('ticker')) {
        updateTicker(PROVIDERS.COINW, sym, { price: parseNum(msg.tick?.close || msg.data?.close), vol24h: parseNum(msg.tick?.vol || msg.data?.vol), ts: now() });
      } else if (channel.includes('trade')) {
        const trades = Array.isArray(msg.data) ? msg.data : (msg.tick ? [msg.tick] : []);
        for (const t of trades) {
          updateTrade(PROVIDERS.COINW, sym, { buy: t.direction === 'buy' || t.side === 'buy', qty: parseNum(t.amount || t.vol), price: parseNum(t.price), ts: now() });
        }
      }
    };
    bindCloseReconnect(name, connectCoinW);
  }

  // ───────────────────────── LBank ────────────────────────────
  function connectLBank() {
    if (isProviderDisabled('LBANK')) return;
    const name = 'LBANK';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://www.lbkex.net/ws/V2/');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('LBANK');
      const pairs = Object.values(MAP.LBANK);
      pairs.forEach(p => c.ws.send(JSON.stringify({ action: 'subscribe', subscribe: 'tick', pair: p })));
      pairs.forEach(p => c.ws.send(JSON.stringify({ action: 'subscribe', subscribe: 'trade', pair: p })));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('LBANK');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'tick' && msg.tick) {
        const sym = Object.keys(MAP.LBANK).find(k => MAP.LBANK[k] === msg.pair);
        if (sym) updateTicker(PROVIDERS.LBANK, sym, { price: parseNum(msg.tick.latest), vol24h: parseNum(msg.tick.vol), ts: now() });
      } else if (msg.type === 'trade' && msg.trade) {
        const sym = Object.keys(MAP.LBANK).find(k => MAP.LBANK[k] === msg.pair);
        if (sym) updateTrade(PROVIDERS.LBANK, sym, { buy: msg.trade.direction === 'buy', qty: parseNum(msg.trade.amount), price: parseNum(msg.trade.price), ts: now() });
      }
    };
    bindCloseReconnect(name, connectLBank);
  }

  // ───────────────────────── Bitstamp ─────────────────────────
  function connectBitstamp() {
    if (isProviderDisabled('BITSTAMP')) return;
    const name = 'BITSTAMP';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.bitstamp.net');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('BITSTAMP');
      const pairs = Object.values(MAP.BITSTAMP);
      pairs.forEach(p => c.ws.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: `live_trades_${p}` } })));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BITSTAMP');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.event === 'trade' && msg.data) {
        const channel = msg.channel;
        const pair = channel.replace('live_trades_', '');
        const sym = Object.keys(MAP.BITSTAMP).find(k => MAP.BITSTAMP[k] === pair);
        if (sym) {
          updateTrade(PROVIDERS.BITSTAMP, sym, { buy: msg.data.type === 0, qty: parseNum(msg.data.amount), price: parseNum(msg.data.price), ts: parseNum(msg.data.microtimestamp) / 1000 || now() });
          updateTicker(PROVIDERS.BITSTAMP, sym, { price: parseNum(msg.data.price), ts: now() });
        }
      }
    };
    bindCloseReconnect(name, connectBitstamp);
  }

  // ───────────────────────── Bitso ────────────────────────────
  function connectBitso() {
    if (isProviderDisabled('BITSO')) return;
    const name = 'BITSO';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.bitso.com');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('BITSO');
      const pairs = Object.values(MAP.BITSO);
      pairs.forEach(p => c.ws.send(JSON.stringify({ action: 'subscribe', book: p, type: 'trades' })));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BITSO');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'trades' && msg.payload) {
        const sym = Object.keys(MAP.BITSO).find(k => MAP.BITSO[k] === msg.book);
        if (sym) {
          msg.payload.forEach(t => {
            updateTrade(PROVIDERS.BITSO, sym, { buy: t.maker_side === 'sell', qty: parseNum(t.amount), price: parseNum(t.rate), ts: now() });
            updateTicker(PROVIDERS.BITSO, sym, { price: parseNum(t.rate), ts: now() });
          });
        }
      }
    };
    bindCloseReconnect(name, connectBitso);
  }

  // ───────────────────────── Bullish ──────────────────────────
  function connectBullish() {
    if (isProviderDisabled('BULLISH')) return;
    const name = 'BULLISH';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://api.exchange.bullish.com/trading-ws/v1/');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('BULLISH');
      const pairs = Object.values(MAP.BULLISH);
      c.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        type: 'command',
        method: 'subscribe',
        params: { topic: 'marketDataTick', symbols: pairs },
        id: String(Date.now()),
      }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BULLISH');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const row = msg?.data || msg?.result || {};
      const market = msg.market || row.symbol || msg.symbol;
      const sym = Object.keys(MAP.BULLISH).find(k => MAP.BULLISH[k] === market);
      if (!sym) return;
      if (row) updateTicker(PROVIDERS.BULLISH, sym, {
        price: parseNum(row.last || row.close || row.currentPrice),
        vol24h: parseNum(row.baseVolume || row.quoteVolume),
        bid: parseNum(row.bestBid),
        ask: parseNum(row.bestAsk),
        ts: parseNum(row.publishedAtTimestamp || row.createdAtTimestamp) || now(),
      });
    };
    bindCloseReconnect(name, connectBullish);
  }

  // ───────────────────────── WhiteBIT ─────────────────────────
  function connectWhiteBIT() {
    if (isProviderDisabled('WHITEBIT')) return;
    const name = 'WHITEBIT';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://api.whitebit.com/ws');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('WHITEBIT');
      const pairs = Object.values(MAP[PROVIDERS.WHITEBIT]);
      c.ws.send(JSON.stringify({ id: 1, method: 'lastprice_subscribe', params: pairs }));
      c.ws.send(JSON.stringify({ id: 2, method: 'trades_subscribe', params: [pairs, 100] }));
      
      c.extra.pingTimer = setInterval(() => {
        if (c.ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ id: 3, method: 'ping', params: [] }));
      }, 50000);
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('WHITEBIT');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.method === 'lastprice_update' && msg.params) {
        const [pair, priceStr] = msg.params;
        const sym = Object.keys(MAP[PROVIDERS.WHITEBIT]).find(k => MAP[PROVIDERS.WHITEBIT][k] === pair);
        if (sym) updateTicker(PROVIDERS.WHITEBIT, sym, { price: parseNum(priceStr), ts: now() });
      } else if (msg.method === 'trades_update' && msg.params) {
        const [pair, trades] = msg.params;
        const sym = Object.keys(MAP[PROVIDERS.WHITEBIT]).find(k => MAP[PROVIDERS.WHITEBIT][k] === pair);
        if (sym && Array.isArray(trades)) {
          trades.forEach(t => {
            updateTrade(PROVIDERS.WHITEBIT, sym, { buy: t.type === 'buy', qty: parseNum(t.amount), price: parseNum(t.price), ts: t.time * 1000 || now() });
          });
        }
      }
    };
    const origClose = c.ws.onclose;
    c.ws.onclose = (ev) => {
      if (c.extra.pingTimer) {
        clearInterval(c.extra.pingTimer);
        c.extra.pingTimer = null;
      }
      if (origClose) origClose(ev);
    };
    bindCloseReconnect(name, connectWhiteBIT);
  }

  // ─────────────────── Blockchain.com mempool ───────────────────
  function connectBlockchainMempool() {
    const name = 'BLOCKCHAIN_MEMPOOL';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.blockchain.info/inv');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      c.ws.send(JSON.stringify({ op: 'unconfirmed_sub' }));
    };
    c.ws.onerror = () => {
      if (c.reconnectMs < 60000) c.reconnectMs = 60000; // 502s are server-side, back off hard
    };
    c.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg?.op !== 'utx') return;
      const tx = msg?.x || {};
      const outs = Array.isArray(tx.out) ? tx.out : [];
      const sat = outs.reduce((sum, o) => sum + (parseNum(o.value) || 0), 0);
      MEMPOOL.btcUnconfirmed += 1;
      MEMPOOL.btcValue += sat / 1e8;
      MEMPOOL.lastTxTs = now();
      updateTrade('BLOCKCHAIN', 'BTC', { buy: false, qty: Math.max(sat / 1e8, 0.000001), price: null, ts: now() });
    };
    bindCloseReconnect(name, connectBlockchainMempool);
  }

  // Optional SSE (uses default DexPaprika endpoint; runtime config may override)
  function connectDexPaprikaSSE() {
    const url = window?.WECRYPTO_CONFIG?.dexPaprikaSseUrl || DEXPAPRIKA_SSE_DEFAULT;
    if (!url || typeof EventSource === 'undefined') return;
    try {
      SSE.stream = new EventSource(url);
      SSE.active = true;
      SSE.lastError = null;
      SSE.stream.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        const sym = String(msg?.sym || msg?.symbol || '').toUpperCase();
        if (!COINS.includes(sym)) return;
        updateTicker('DEXPAPRIKA', sym, {
          price: parseNum(msg.priceUsd || msg.price),
          vol24h: parseNum(msg.vol24h || msg.volume24h),
          ts: parseNum(msg.ts) || now(),
        });
      };
      SSE.stream.onerror = () => {
        SSE.lastError = 'sse_error';
      };
    } catch (e) {
      SSE.lastError = String(e?.message || e);
    }
  }

  function start() {
    const startupPlan = [
      ['BINANCE', connectBinance, 0],
      ['COINBASE', connectCoinbase, 0],
      ['KRAKEN', connectKraken, WS_STARTUP_STAGGER_MS],
      ['BYBIT', connectBybit, WS_STARTUP_STAGGER_MS],
      ['HYPERLIQUID', connectHyperliquid, WS_STARTUP_STAGGER_MS * 2],
      ['OKX', connectOKX, WS_STARTUP_STAGGER_MS * 2],
      ['KUCOIN', connectKuCoin, WS_STARTUP_STAGGER_MS * 3],
      ['GATE', connectGate, WS_STARTUP_STAGGER_MS * 4],
      ['BLOCKCHAIN_MEMPOOL', connectBlockchainMempool, WS_STARTUP_STAGGER_MS * 5],
    ];
    const optionalPoolPlan = [
      { name: 'UPBIT', connectFn: connectUpbit, intervalMs: 30000 },
      { name: 'BITGET', connectFn: connectBitget, intervalMs: 30000 },
      { name: 'BINGX', connectFn: connectBingX, intervalMs: 60000 },
      { name: 'BITVAVO', connectFn: connectBitvavo, intervalMs: 60000 },
      { name: 'GEMINI', connectFn: connectGemini, intervalMs: 120000 },
      { name: 'COINW', connectFn: connectCoinW, intervalMs: 120000 },
      { name: 'LBANK', connectFn: connectLBank, intervalMs: 180000 },
      { name: 'BITSTAMP', connectFn: connectBitstamp, intervalMs: 180000 },
      { name: 'BITSO', connectFn: connectBitso, intervalMs: 180000 },
      { name: 'BULLISH', connectFn: connectBullish, intervalMs: 300000 },
      { name: 'WHITEBIT', connectFn: connectWhiteBIT, intervalMs: 300000 },
      { name: 'OURBIT', connectFn: connectOurbit, intervalMs: 300000 },
      { name: 'WEEX', connectFn: connectWeex, intervalMs: 300000 },
    ];
    startupPlan.forEach(([name, connectFn, delayMs]) => scheduleProviderStart(name, connectFn, delayMs));
    // startOptionalWsPool disabled - see warmOptionalWsRoutes
    // startOptionalWsPool(optionalPoolPlan, WS_STARTUP_STAGGER_MS * 6);
    connectDexPaprikaSSE();
  }

  function stop() {
    stopOptionalWsPool();
    for (const c of Object.values(CONNECTIONS)) {
      c.active = false;
      clearConnTimer(c);
      if (c.extra.pingTimer) {
        clearInterval(c.extra.pingTimer);
        c.extra.pingTimer = null;
      }
      try { c.ws && c.ws.close(); } catch (_) { }
      c.ws = null;
    }
    if (SSE.stream) {
      try { SSE.stream.close(); } catch (_) { }
      SSE.stream = null;
      SSE.active = false;
    }
  }

  function getTicker(provider, sym, maxAgeMs = 20000) {
    const snap = STORE?.[provider]?.[sym];
    if (!snap) return null;
    if (!snap.ts) return null;
    if (now() - snap.ts > maxAgeMs) return null;
    return {
      provider: snap.provider,
      sym: snap.sym,
      pair: snap.pair,
      marketType: snap.marketType,
      venueType: snap.venueType,
      price: snap.price,
      bid: snap.bid,
      ask: snap.ask,
      mid: snap.mid,
      spreadAbs: snap.spreadAbs,
      spreadBps: snap.spreadBps,
      vol24h: snap.vol24h,
      buyPct: snap.buyPct,
      sellPct: snap.sellPct,
      tradeImbalance: snap.tradeImbalance,
      ts: snap.ts,
      tradeTs: snap.tradeTs,
    };
  }

  function getMarketStructure(provider, sym, maxAgeMs = 20000) {
    const snap = getTicker(provider, sym, maxAgeMs);
    if (!snap) return null;
    return {
      provider: snap.provider,
      venueType: snap.venueType,
      marketType: snap.marketType,
      sym: snap.sym,
      pair: snap.pair,
      mid: snap.mid,
      bid: snap.bid,
      ask: snap.ask,
      spreadAbs: snap.spreadAbs,
      spreadBps: snap.spreadBps,
      vol24h: snap.vol24h,
      buyPct: snap.buyPct,
      sellPct: snap.sellPct,
      tradeImbalance: snap.tradeImbalance,
      ts: snap.ts,
    };
  }

  function getAll(provider) {
    const out = {};
    const perProvider = STORE?.[provider] || {};
    for (const [sym, snap] of Object.entries(perProvider)) {
      out[sym] = {
        sym,
        pair: snap.pair,
        marketType: snap.marketType,
        venueType: snap.venueType,
        price: snap.price,
        bid: snap.bid,
        ask: snap.ask,
        mid: snap.mid,
        spreadAbs: snap.spreadAbs,
        spreadBps: snap.spreadBps,
        vol24h: snap.vol24h,
        buyPct: snap.buyPct,
        sellPct: snap.sellPct,
        tradeImbalance: snap.tradeImbalance,
        ts: snap.ts,
      };
    }
    return out;
  }

  function getMempool() {
    const ageMs = MEMPOOL.lastTxTs ? now() - MEMPOOL.lastTxTs : null;
    return { ...MEMPOOL, ageMs };
  }

  function getQualityGates(maxAgeMs = 30000) {
    const gates = {};
    for (const provider of Object.keys(MAP)) {
      if (isProviderConfiguredOff(provider)) continue;
      const expected = Object.keys(MAP[provider] || {}).filter(sym => TRACKED_COINS.has(sym));
      const rows = STORE?.[provider] || {};
      const stale = [];
      const missing = [];
      const fresh = [];
      let withBook = 0;
      for (const sym of expected) {
        const snap = rows[sym];
        if (!snap || !Number.isFinite(snap.price) || snap.price <= 0 || !snap.ts) {
          missing.push(sym);
          continue;
        }
        const ageMs = now() - snap.ts;
        if (ageMs > maxAgeMs) {
          stale.push(sym);
          continue;
        }
        fresh.push(sym);
        if (Number.isFinite(snap.bid) && Number.isFinite(snap.ask) && snap.ask > 0 && snap.bid > 0 && snap.ask >= snap.bid) {
          withBook++;
        }
      }
      const expectedCount = expected.length || 1;
      const freshCount = fresh.length;
      const staleCount = stale.length;
      const missingCount = missing.length;
      const coveragePct = Math.round((freshCount / expectedCount) * 100);
      const bookCoveragePct = freshCount > 0 ? Math.round((withBook / freshCount) * 100) : 0;

      gates[provider] = {
        expectedSymbols: expected,
        freshSymbols: fresh,
        staleSymbols: stale,
        missingSymbols: missing,
        freshCount,
        staleCount,
        missingCount,
        coveragePct,
        bookCoveragePct,
        ok: coveragePct >= 80 && staleCount === 0,
      };
    }
    return gates;
  }

  function getConfiguredOffProviders() {
    return [...new Set([...Object.keys(PROVIDERS), 'BLOCKCHAIN_MEMPOOL'])]
      .filter((provider) => isProviderConfiguredOff(provider));
  }

  function getStatus() {
    const status = {};
    for (const [name, c] of Object.entries(CONNECTIONS)) {
      status[name] = {
        connected: c.ws?.readyState === WebSocket.OPEN,
        reconnectMs: c.reconnectMs,
        active: c.active,
      };
    }
    return {
      connections: status,
      disabledByDefault: [...DEFAULT_DISABLED_WS_PROVIDERS].filter(isProviderConfiguredOff),
      disabledByConfig: getConfiguredOffProviders(),
      optionalPool: {
        active: !!OPTIONAL_WS_POOL.timer,
        maxActive: optionalPoolMaxActive(),
        tickMs: OPTIONAL_WS_POOL_TICK_MS,
        providers: (OPTIONAL_WS_POOL.roster || []).map(cfg => ({
          name: cfg.name,
          intervalMs: cfg.intervalMs,
          active: providerPoolRunning(cfg.name),
          nextDue: cfg.nextDue || 0,
          activeUntil: cfg.activeUntil || 0,
          lastStart: cfg.lastStart || 0,
          restProbe: OPTIONAL_REST_STATUS[cfgName(cfg)] || null,
        })),
      },
      optionalRest: { ...OPTIONAL_REST_STATUS },
      sse: { active: SSE.active, lastError: SSE.lastError },
      providers: Object.keys(STORE),
      qualityGates: getQualityGates(),
      mempool: getMempool(),
    };
  }

  window.ExchangeWS = {
    PROVIDERS,
    start,
    stop,
    gracefulReconnect: start,
    warmOptionalWsRoutes,
    getTicker,
    getMarketStructure,
    getAll,
    getMempool,
    getQualityGates,
    getStatus,
  };

  document.addEventListener('DOMContentLoaded', () => {
    try { start(); } catch (_) { }
  });
})();
