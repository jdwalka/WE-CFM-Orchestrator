// ================================================================
// WE|||CRYPTO — CFM Benchmark Orchestrator v2
//
// CF Benchmarks methodology applied to public multi-venue spot sources:
//   CDC  = Crypto.com Exchange (ticker, book, trades)
//   CB   = Coinbase (spot/buy/sell prices)
//   GKO  = CoinGecko (price, volume, 24h change)
//   DEX  = DexScreener (on-chain DEX aggregated pairs)
//   BIN  = Binance spot
//   OKX  = OKX spot
//
// Rolling 15-minute window partitioned into 5 × 3-min buckets.
// Volume-Weighted Median (VWM) per partition.
// Final CFM rate = equally-weighted average of partition VWMs.
// Polls every 15 seconds with staggered, rate-limit-aware calls.
// ================================================================

(function () {
  'use strict';

  // ── Fetch with AbortController timeout ──────────────────────────────────
  function fetchWithTimeout(url, ms = 20000, opts = {}) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => {
      try {
        ctrl.abort(new DOMException(`CFM fetch timed out after ${ms}ms`, 'TimeoutError'));
      } catch (_) {
        try { ctrl.abort(); } catch (_) { }
      }
    }, ms);
    const fetchImpl = window.throttledFetch || fetch;
    return fetchImpl(url, { ...opts, signal: ctrl.signal })
      .then(r => { clearTimeout(tid); return r; })
      .catch(e => { clearTimeout(tid); throw e; });
  }

  function getWsQuote(provider, sym, maxAgeMs = 20000) {
    if (!window.ExchangeWS?.getTicker) return null;
    const q = window.ExchangeWS.getTicker(provider, sym, maxAgeMs);
    if (!q || !Number.isFinite(q.price) || q.price <= 0) return null;
    return q;
  }

  const POLL_MS = 15000;
  const WINDOW_MIN = 15;    // 15-minute rolling window — full quarter-hour of CFM data
  const PARTITIONS = 5;     // 5 × 3-minute VWM buckets per window
  const MAX_BUF = 120;

  // Source configs with rate budgets (calls per 60s)
  const SRC = {
    CDC: { budget: 80, used: 0, resetAt: 0, label: 'Crypto.com', color: '#1a2c5a' },
    CB: { budget: 60, used: 0, resetAt: 0, label: 'Coinbase', color: '#0052ff' },
    GKO: { budget: 18, used: 0, resetAt: 0, label: 'CoinGecko', color: '#8dc63f' },
    DEX: { budget: 20, used: 0, resetAt: 0, label: 'DexScreener', color: '#a259ff' },
    BIN: { budget: 60, used: 0, resetAt: 0, label: 'Binance', color: '#f3ba2f' },
    OKX: { budget: 60, used: 0, resetAt: 0, label: 'OKX', color: '#ffffff' },
    KRK: { budget: 30, used: 0, resetAt: 0, label: 'Kraken', color: '#5741d9' },
    HYP: { budget: 20, used: 0, resetAt: 0, label: 'Hyperliquid', color: '#5ee7b0' },
    BIF: { budget: 60, used: 0, resetAt: 0, label: 'Binance Futures', color: '#f0b90b' },
    BYB: { budget: 30, used: 0, resetAt: 0, label: 'Bybit', color: '#f7a600' },
    UPB: { budget: 60, used: 0, resetAt: 0, label: 'Upbit', color: '#093687' },
    BIT: { budget: 60, used: 0, resetAt: 0, label: 'Bitget', color: '#00d2b4' },
    BNX: { budget: 60, used: 0, resetAt: 0, label: 'BingX', color: '#1052fb' },
    BTV: { budget: 120, used: 0, resetAt: 0, label: 'Bitvavo', color: '#1f48ed' },
    GEM: { budget: 60, used: 0, resetAt: 0, label: 'Gemini', color: '#00dcfa' },
    CNW: { budget: 60, used: 0, resetAt: 0, label: 'CoinW', color: '#f5c642' },
    LBK: { budget: 60, used: 0, resetAt: 0, label: 'LBank', color: '#14b18c' },
    BSP: { budget: 60, used: 0, resetAt: 0, label: 'Bitstamp', color: '#00cc66' },
    BTO: { budget: 60, used: 0, resetAt: 0, label: 'Bitso', color: '#00c853' },
    BUL: { budget: 60, used: 0, resetAt: 0, label: 'Bullish', color: '#2b2b2b' },
    WHB: { budget: 60, used: 0, resetAt: 0, label: 'WhiteBIT', color: '#ffb11a' },
    OUR: { budget: 60, used: 0, resetAt: 0, label: 'Ourbit', color: '#444444' },
    WEX: { budget: 60, used: 0, resetAt: 0, label: 'WEEX', color: '#ff5500' },
  };

  const SRC_TO_REGISTRY = {
    CDC: 'CDC',
    CB: 'COINBASE',
    GKO: null,
    DEX: null,
    BIN: 'BINANCE',
    OKX: 'OKX',
    KRK: 'KRAKEN',
    HYP: null,
    BIF: 'BINANCE',
    BYB: 'BYBIT',
    UPB: 'UPBIT',
    BIT: 'BITGET',
    BNX: 'BINGX',
    BTV: 'BITVAVO',
    GEM: 'GEMINI',
    CNW: 'COINW',
    LBK: 'LBANK',
    BSP: 'BITSTAMP',
    BTO: 'BITSO',
    BUL: 'BULLISH',
    WHB: 'WHITEBIT',
    OUR: 'OURBIT',
    WEX: 'WEEX',
  };

  function getSourceWeight(srcKey) {
    const regId = SRC_TO_REGISTRY[srcKey];
    if (!regId) return 0.5; // default for GKO, DEX, HYP
    const reg = window.ExchangeRegistry?.getById(regId);
    if (!reg) return 0.5;
    const orbital = window.ExchangeRegistry.ORBITALS[reg.orbital];
    return orbital ? orbital.weight : 0.5;
  }

  // DexScreener search queries per coin
  const DEX_QUERIES = {
    BTC: 'WBTC USDC', ETH: 'WETH USDC', SOL: 'SOL USDC',
    XRP: 'XRP USDT', HYPE: 'HYPE USDC', DOGE: 'DOGE USDT', BNB: 'WBNB',
  };
  const DEX_BASE_SYMS = {
    BTC: ['BTC', 'WBTC'],
    ETH: ['ETH', 'WETH'],
    SOL: ['SOL', 'WSOL'],
    XRP: ['XRP', 'WXRP'],
    HYPE: ['HYPE', 'WHYPE'],
    DOGE: ['DOGE', 'WDOGE'],
    BNB: ['BNB', 'WBNB'],
  };
  const DEX_STABLE_QUOTES = new Set(['USD', 'USDC', 'USDT', 'BUSD', 'DAI', 'FDUSD', 'USDE', 'USDL', 'USDS', 'USDBC']);

  // Coinbase symbols
  // BNB removed — Coinbase does not list BNB; calling spot/buy/sell for it burns 3 CB credits for 404s.
  const CB_SYMS = { BTC: 'BTC', ETH: 'ETH', SOL: 'SOL', XRP: 'XRP', HYPE: 'HYPE', DOGE: 'DOGE' };
  const BIN_SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT' };
  const OKX_SYMS = { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', HYPE: 'HYPE-USDT', DOGE: 'DOGE-USDT', BNB: 'BNB-USDT' };
  const KRK_SYMS = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'XDGUSD', BNB: 'BNBUSD' }; // HYPE not listed on Kraken

  const CDC_BASE = 'https://api.crypto.com/v2/public';
  const CB_BASE = 'https://api.coinbase.com/v2/prices';
  const GKO_BASE = 'https://api.coingecko.com/api/v3';
  const DEX_BASE = 'https://api.dexscreener.com/latest/dex';
  const BIN_BASE = 'https://api.binance.com/api/v3';
  const OKX_BASE = 'https://www.okx.com/api/v5/market';
  const KRK_BASE = 'https://api.kraken.com/0/public';

  // State
  const sampleBuf = {};  // sym → [ { t, sources:{CDC,CB,GKO,DEX}, vol, bid, ask } ]
  const anomalyMonitors = {};
  window._cfm = {};
  window._fundingRateCache = window._fundingRateCache || {};
  // Funding rates from perp sources — stored separately so they survive the
  // per-cycle window._cfm[sym] = computeCFM(sym) overwrite in runCycle().
  const _fundingRates = {};
  let timer = null;
  let cycle = 0;
  let lastMs = 0;
  let cdcTickerCache = null; // shared ticker response (single call for all coins)
  let cdcTickerAge = 0;
  const _engineStart = Date.now(); // startup timestamp for CoinGecko 3-min gate

  // ---- Rate limiter ----
  function can(src) {
    const s = SRC[src]; if (!s) return true;
    const now = Date.now();
    if (now > s.resetAt) { s.used = 0; s.resetAt = now + 60000; }
    return s.used < s.budget;
  }
  function hit(src) { if (SRC[src]) SRC[src].used++; }

  // ---- Fetchers ----

  // CDC: single tickers call — uses shared cache from app.js if fresh
  async function fetchCDCTickers() {
    // Check shared cache from app.js (avoids duplicate HTTP call)
    const shared = window._sharedTickerCache;
    if (shared && shared.raw && Date.now() - shared.age < 20000) {
      cdcTickerCache = shared.raw;
      cdcTickerAge = shared.age;
      return cdcTickerCache;
    }
    if (!can('CDC')) return null;
    if (cdcTickerCache && Date.now() - cdcTickerAge < 20000) return cdcTickerCache;
    try {
      hit('CDC');
      const r = await fetchWithTimeout(`${CDC_BASE}/get-ticker`);
      if (!r.ok) return null;
      const j = await r.json();
      if (j.code !== 0) return null;
      cdcTickerCache = j.result.data;
      cdcTickerAge = Date.now();
      // Populate shared cache for app.js
      window._sharedTickerCache = { raw: cdcTickerCache, age: cdcTickerAge };
      return cdcTickerCache;
    } catch { return null; }
  }

  function parseCDCTicker(allTickers, instrument) {
    if (!allTickers) return null;
    const t = allTickers.find(x => {
      const n = (x.i || x.instrument_name || '').replace(/_/g, '');
      return n === instrument;
    });
    if (!t) return null;
    return {
      price: parseFloat(t.a ?? t.last),
      vol: parseFloat(t.vv ?? t.volume_value ?? 0),
      bid: parseFloat(t.b ?? t.best_bid ?? 0),
      ask: parseFloat(t.k ?? t.best_ask ?? 0),
    };
  }

  // Coinbase: spot + buy + sell
  // hit() is now staged: 1 credit for spot first, 2 more only after spot succeeds.
  // This prevents wasting 3 credits on coins that return 404 (e.g. symbols not listed on CB).
  async function fetchCB(sym) {
    const ws = getWsQuote('COINBASE', sym, 20000);
    if (ws) {
      const buy = Number.isFinite(ws.ask) && ws.ask > 0 ? ws.ask : ws.price;
      const sell = Number.isFinite(ws.bid) && ws.bid > 0 ? ws.bid : ws.price;
      const spread = ws.price > 0 ? (Math.abs(buy - sell) / ws.price) * 100 : 0;
      return { price: ws.price, buy, sell, spread, ws: true };
    }
    if (!can('CB')) return null;
    try {
      hit('CB');
      let jwtStr = null;
      try {
        if (window.desktopApp && window.desktopApp.generateCoinbaseJWT) {
          const res = await window.desktopApp.generateCoinbaseJWT({
            requestMethod: 'GET',
            requestPath: `api.coinbase.com/api/v3/brokerage/best_bid_ask?product_ids=${sym}-USD`
          });
          if (res && res.success) jwtStr = res.jwt;
        }
      } catch(e) { console.warn('[CFM] CB JWT failed:', e.message); }

      const headers = { 'Accept': 'application/json' };
      if (jwtStr) {
        headers['Authorization'] = `Bearer ${jwtStr}`;
      }

      const r = await fetchWithTimeout(`https://api.coinbase.com/api/v3/brokerage/best_bid_ask?product_ids=${sym}-USD`, 20000, { headers });
      if (r.status === 429) { console.warn('CB rate limited'); return null; }
      if (!r.ok) return null;
      
      const j = await r.json();
      const book = j.pricebooks && j.pricebooks[0];
      if (!book) return null;
      
      // Best bid = sell to market, Best ask = buy from market
      const bp = parseFloat(book.asks && book.asks[0] ? book.asks[0].price : 0);
      const slp = parseFloat(book.bids && book.bids[0] ? book.bids[0].price : 0);
      const sp = (bp && slp) ? (bp + slp) / 2 : (bp || slp);
      
      if (!sp) return null;
      
      return { price: sp, buy: bp, sell: slp, spread: bp > 0 && slp > 0 ? (Math.abs(bp - slp) / sp) * 100 : 0 };
    } catch { return null; }
  }

  // CoinGecko
  async function fetchGKO(geckoId) {
    if (!can('GKO')) return null;
    try {
      hit('GKO');
      const r = await fetchWithTimeout(`${GKO_BASE}/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`);
      if (!r.ok) return null;
      const j = await r.json();
      const d = j[geckoId];
      return d ? { price: d.usd, vol: d.usd_24h_vol || 0, change: d.usd_24h_change || 0 } : null;
    } catch { return null; }
  }

  async function fetchBIN(sym) {
    const binSym = BIN_SYMS[sym];
    if (!binSym) return null;
    const ws = getWsQuote('BINANCE', sym, 20000);
    if (ws) {
      return {
        price: ws.price,
        vol: Number.isFinite(ws.vol24h) ? ws.vol24h : 0,
        bid: Number.isFinite(ws.bid) ? ws.bid : 0,
        ask: Number.isFinite(ws.ask) ? ws.ask : 0,
        ws: true,
      };
    }
    if (!can('BIN')) return null;
    try {
      hit('BIN'); hit('BIN');
      const [ticker, book] = await Promise.all([
        fetchWithTimeout(`${BIN_BASE}/ticker/24hr?symbol=${binSym}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetchWithTimeout(`${BIN_BASE}/ticker/bookTicker?symbol=${binSym}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      const price = parseFloat(ticker?.lastPrice || 0);
      if (!price) return null;
      return {
        price,
        vol: parseFloat(ticker?.quoteVolume || 0),
        bid: parseFloat(book?.bidPrice || 0),
        ask: parseFloat(book?.askPrice || 0),
      };
    } catch { return null; }
  }

  async function fetchOKX(sym) {
    const okxSym = OKX_SYMS[sym];
    if (!okxSym) return null;
    const ws = getWsQuote('OKX', sym, 20000);
    if (ws) {
      return {
        price: ws.price,
        vol: Number.isFinite(ws.vol24h) ? ws.vol24h : 0,
        bid: Number.isFinite(ws.bid) ? ws.bid : 0,
        ask: Number.isFinite(ws.ask) ? ws.ask : 0,
        ws: true,
      };
    }
    if (!can('OKX')) return null;
    try {
      hit('OKX');
      const r = await fetchWithTimeout(`${OKX_BASE}/ticker?instId=${okxSym}`);
      if (!r.ok) return null;
      const j = await r.json();
      const row = j?.data?.[0];
      const price = parseFloat(row?.last || 0);
      if (!price) return null;
      return {
        price,
        vol: parseFloat(row?.volCcy24h || 0),
        bid: parseFloat(row?.bidPx || 0),
        ask: parseFloat(row?.askPx || 0),
      };
    } catch { return null; }
  }

  async function fetchKRK(sym) {
    const krkSym = KRK_SYMS[sym];
    if (!krkSym) return null;
    const ws = getWsQuote('KRAKEN', sym, 20000);
    if (ws) {
      return {
        price: ws.price,
        vol: Number.isFinite(ws.vol24h) ? ws.vol24h : 0,
        bid: Number.isFinite(ws.bid) ? ws.bid : 0,
        ask: Number.isFinite(ws.ask) ? ws.ask : 0,
        ws: true,
      };
    }
    if (!can('KRK')) return null;
    try {
      hit('KRK');
      const r = await fetchWithTimeout(`${KRK_BASE}/Ticker?pair=${krkSym}`);
      if (!r.ok) return null;
      const j = await r.json();
      if (j.error?.length) return null;
      const row = Object.values(j.result || {})[0];
      if (!row) return null;
      const price = parseFloat(row.c?.[0] || 0);
      if (!price) return null;
      return {
        price,
        vol: parseFloat(row.v?.[1] || 0),    // 24h rolling volume
        bid: parseFloat(row.b?.[0] || 0),
        ask: parseFloat(row.a?.[0] || 0),
      };
    } catch { return null; }
  }

  // DexScreener
  async function fetchDEX(sym) {
    if (!can('DEX')) return null;
    const q = DEX_QUERIES[sym];
    if (!q) return null;
    try {
      hit('DEX');
      const r = await fetchWithTimeout(`${DEX_BASE}/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) return null;
      const j = await r.json();
      const targetBases = new Set((DEX_BASE_SYMS[sym] || [sym]).map(v => String(v).toUpperCase()));
      const quoteScore = quote => {
        const qSym = String(quote || '').toUpperCase().replace(/\./g, '');
        return DEX_STABLE_QUOTES.has(qSym) ? 2 : (qSym.includes('USD') ? 1 : 0);
      };
      const pairs = (j.pairs || []).filter(p => {
        const baseSym = String(p.baseToken?.symbol || '').toUpperCase();
        const quoteSym = String(p.quoteToken?.symbol || '').toUpperCase();
        const price = parseFloat(p.priceUsd || 0);
        return targetBases.has(baseSym) && price > 0 && quoteScore(quoteSym) > 0;
      }).sort((a, b) => {
        const quoteDelta = quoteScore(b.quoteToken?.symbol) - quoteScore(a.quoteToken?.symbol);
        if (quoteDelta !== 0) return quoteDelta;
        const liqDelta = parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0);
        if (liqDelta !== 0) return liqDelta;
        return parseFloat(b.volume?.h24 || 0) - parseFloat(a.volume?.h24 || 0);
      });
      if (pairs.length === 0) return null;
      const top = pairs[0];
      return {
        price: parseFloat(top.priceUsd || 0),
        vol: parseFloat(top.volume?.h24 || 0),
        liq: parseFloat(top.liquidity?.usd || 0),
        dex: top.dexId,
        chain: top.chainId,
        pair: `${top.baseToken.symbol}/${top.quoteToken.symbol}`,
        txns: top.txns?.h24 || {},
      };
    } catch { return null; }
  }

  // ---- New perp / derivative data sources --------------------------------

  // Hyperliquid: mark prices + funding rates via POST (no auth, free)
  // fetchWithTimeout only supports GET, so we use AbortController directly.
  async function fetchHYP() {
    if (!can('HYP')) return [];
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => {
        try {
          ctrl.abort(new DOMException('Hyperliquid fetch timed out after 8000ms', 'TimeoutError'));
        } catch (_) {
          try { ctrl.abort(); } catch (_) { }
        }
      }, 20000);
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (!res.ok) return [];
      const [meta, assetCtxs] = await res.json();
      hit('HYP');
      const MAP = { BTC: 'BTC', ETH: 'ETH', SOL: 'SOL', XRP: 'XRP', DOGE: 'DOGE', BNB: 'BNB', HYPE: 'HYPE' };
      const samples = [];
      meta.universe.forEach((info, i) => {
        const sym = MAP[info.name];
        if (!sym) return;
        const ctx = assetCtxs[i];
        const price = parseFloat(ctx.markPx);
        const funding = parseFloat(ctx.funding);
        if (!isFinite(price)) return;
        if (!_fundingRates[sym]) _fundingRates[sym] = {};
        _fundingRates[sym].hypFunding = isFinite(funding) ? funding : null;
        samples.push({ sym, price, vol: null, src: 'HYP' });
      });
      return samples;
    } catch (e) { return []; }
  }

  // Binance Futures: OI-weighted mark prices + hourly funding rates (free, no auth)
  async function fetchBIF() {
    if (!can('BIF')) return [];
    try {
      const res = await fetchWithTimeout('https://fapi.binance.com/fapi/v1/premiumIndex', 20000);
      if (!res.ok) return [];
      const data = await res.json();
      hit('BIF');
      const SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT', HYPE: 'HYPEUSDT' };
      const lookup = {};
      data.forEach(item => { lookup[item.symbol] = item; });
      const samples = [];
      Object.entries(SYMS).forEach(([sym, fsym]) => {
        const item = lookup[fsym];
        if (!item) return; // HYPE may not exist on Binance futures — skip gracefully
        const price = parseFloat(item.markPrice);
        const funding = parseFloat(item.lastFundingRate);
        if (!isFinite(price)) return;
        if (!_fundingRates[sym]) _fundingRates[sym] = {};
        _fundingRates[sym].binFunding = isFinite(funding) ? funding : null;
        samples.push({ sym, price, vol: null, src: 'BIF' });
      });
      return samples;
    } catch (e) { return []; }
  }

  // Bybit: linear perp mark prices + funding rates (free, no auth)
  async function fetchBYB() {
    if (!can('BYB')) return [];
    try {
      const res = await fetchWithTimeout('https://api.bybit.com/v5/market/tickers?category=linear', 20000);
      if (!res.ok) return [];
      const data = await res.json();
      hit('BYB');
      const SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT', HYPE: 'HYPEUSDT' };
      const list = data?.result?.list || [];
      const lookup = {};
      list.forEach(item => { lookup[item.symbol] = item; });
      const samples = [];
      Object.entries(SYMS).forEach(([sym, bsym]) => {
        const item = lookup[bsym];
        if (!item) return; // symbol absent on Bybit — skip gracefully
        const price = parseFloat(item.lastPrice);
        const funding = parseFloat(item.fundingRate);
        if (!isFinite(price)) return;
        if (!_fundingRates[sym]) _fundingRates[sym] = {};
        _fundingRates[sym].bybFunding = isFinite(funding) ? funding : null;
        samples.push({ sym, price, vol: null, src: 'BYB' });
      });
      return samples;
    } catch (e) { return []; }
  }

  // Fear & Greed Index (Alternative.me) — self-throttled to one fetch per 5 minutes.
  // Writes to window._cfm._fng; that key is never overwritten by computeCFM.
  let _fngLastFetch = 0;
  async function fetchFNG() {
    const now = Date.now();
    if (now - _fngLastFetch < 5 * 60 * 1000) return; // respect 5-min minimum interval
    // Throttle on attempt to avoid hammering Alternative.me when it is down.
    _fngLastFetch = now;
    try {
      // If timeout occurs, fall back to cached value.
      const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', 5000);
      if (!res.ok) {
        console.warn(`[FNG] HTTP ${res.status} - using cached value`);
        return;  // Use cached value
      }
      const data = await res.json();
      const entry = data?.data?.[0];
      if (!entry) return;
      window._cfm._fng = {
        value: parseInt(entry.value, 10),
        label: entry.value_classification,
        ts: parseInt(entry.timestamp, 10),
      };
      console.info(`[FNG] Updated: ${window._cfm._fng.value} (${window._cfm._fng.label})`);
    } catch (e) {
      console.warn(`[FNG] Timeout/error after 5s: ${e.message} - using cached value`);
      /* silent fail — non-critical indicator, cached value still available */
    }
  }

  // Aggregate funding rates from HYP / BIF / BYB into a per-coin bias signal.
  // Called AFTER computeCFM has replaced window._cfm[sym], so reads from
  // _fundingRates (the persistent cache) and writes fundingBias onto the new object.
  //
  // Interpretation:
  //   avg > 0.03 % → longs paying shorts → market is long-heavy → contrarian BEARISH
  //   avg < -0.01 % → shorts paying longs → market is short-heavy → contrarian BULLISH
  function _computeFundingBias() {
    const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
    COINS.forEach(sym => {
      const c = _fundingRates[sym] || {};
      const rates = [c.hypFunding, c.binFunding, c.bybFunding].filter(r => r != null && isFinite(r));
      if (!rates.length) return;
      const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
      const bias = avg > 0.0003 ? 'bearish' : avg < -0.0001 ? 'bullish' : 'neutral';
      const strength = Math.min(1, Math.abs(avg) / 0.001); // 0–1 normalised against 0.1 % threshold
      window._fundingRateCache[sym] = {
        rate: avg,
        sources: rates.length,
        ts: Date.now(),
        raw: { ...c },
      };
      // window._cfm[sym] was just written by computeCFM — safe to annotate it now
      if (window._cfm[sym]) {
        window._cfm[sym].fundingBias = { avg, bias, strength, sources: rates.length };
      }
    });
  }

  // ---- Sampling orchestrator (staggered) ----
  async function sampleAll() {
    const now = Date.now();

    // Phase 1: CDC (single call for all coins)
    const cdcAll = await fetchCDCTickers();

    // Phase 2: Coinbase (2 coins per cycle, rotating through all 7)
    // 2 coins * 3 calls each = 6 calls/cycle * 4 cycles/min = 24 calls/min (safe under 60)
    const cbIdx = cycle % PREDICTION_COINS.length;
    const cbBatch = [
      PREDICTION_COINS[cbIdx],
      PREDICTION_COINS[(cbIdx + 1) % PREDICTION_COINS.length],
    ];

    const cbResults = {};
    await Promise.allSettled(cbBatch.map(async c => {
      if (!CB_SYMS[c.sym]) return;  // coin not listed on Coinbase — skip entirely
      const r = await fetchCB(CB_SYMS[c.sym]);
      if (r) cbResults[c.sym] = r;
    }));

    const binResults = {};
    await Promise.allSettled(PREDICTION_COINS.map(async c => {
      const r = await fetchBIN(c.sym);
      if (r) binResults[c.sym] = r;
    }));

    // New perp sources: Hyperliquid + Binance Futures + Bybit run in parallel every cycle.
    // Side-effects (funding rates) land in _fundingRates; return values not needed here.
    await Promise.allSettled([fetchHYP(), fetchBIF(), fetchBYB()]);
    // Fear & Greed: fire-and-forget — internally throttled to one request per 5 minutes.
    fetchFNG();

    // Phase 3: CoinGecko (every 4th cycle = every 60s, only after 3-min warmup)
    // First 3 minutes: faster CEX sources (Binance, Coinbase, CDC) warm up instead.
    // CoinGecko icons still load via coinIcon() — this gate is price API only.
    const gkoResults = {};
    if (cycle % 4 === 0 && (Date.now() - _engineStart) > 180_000) {
      // Batch all gecko IDs in one call
      const ids = PREDICTION_COINS.map(c => c.geckoId).join(',');
      if (can('GKO')) {
        try {
          hit('GKO');
          const r = await fetchWithTimeout(`${GKO_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`);
          if (r.ok) {
            const j = await r.json();
            PREDICTION_COINS.forEach(c => {
              if (j[c.geckoId]) gkoResults[c.sym] = { price: j[c.geckoId].usd, vol: j[c.geckoId].usd_24h_vol || 0 };
            });
          }
        } catch { }
      }
    }

    const okxResults = {};
    if (cycle % 2 === 0) {
      await Promise.allSettled(PREDICTION_COINS.map(async c => {
        const r = await fetchOKX(c.sym);
        if (r) okxResults[c.sym] = r;
      }));
    }

    // Kraken: every 3rd cycle (~45s interval, well under 30/min budget)
    const krkResults = {};
    if (cycle % 3 === 0) {
      await Promise.allSettled(PREDICTION_COINS.map(async c => {
        const r = await fetchKRK(c.sym);
        if (r) krkResults[c.sym] = r;
      }));
    }

    // Phase 4: DexScreener (every 5th cycle = every 75s, 2 coins at a time)
    const dexResults = {};
    if (cycle % 5 === 0 || cycle % 5 === 1) {
      const dexBatch = PREDICTION_COINS.filter((_, i) => i % 4 === (cycle % 5 === 0 ? 0 : 2)).slice(0, 2);
      for (const c of dexBatch) {
        const r = await fetchDEX(c.sym);
        if (r) dexResults[c.sym] = r;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    // Assemble samples
    PREDICTION_COINS.forEach(coin => {
      const s = { t: now, sources: {}, vol: 0, bid: 0, ask: 0, meta: {} };

      // CDC
      const cdc = parseCDCTicker(cdcAll, coin.instrument);
      if (cdc) { s.sources.CDC = cdc.price; s.vol = cdc.vol; s.bid = cdc.bid; s.ask = cdc.ask; }

      // Coinbase
      if (cbResults[coin.sym]) { s.sources.CB = cbResults[coin.sym].price; s.meta.cbSpread = cbResults[coin.sym].spread; }

      // CoinGecko
      if (gkoResults[coin.sym]) { s.sources.GKO = gkoResults[coin.sym].price; if (!s.vol) s.vol = gkoResults[coin.sym].vol; }
      // Carry forward last GKO value if not polled this cycle (max 60s staleness to avoid injecting stale price as live)
      else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        if (last.sources.GKO && (now - last.t) < 60000) s.sources.GKO = last.sources.GKO;
      }

      // Binance
      if (binResults[coin.sym]) {
        s.sources.BIN = binResults[coin.sym].price;
        if (!s.bid && binResults[coin.sym].bid) s.bid = binResults[coin.sym].bid;
        if (!s.ask && binResults[coin.sym].ask) s.ask = binResults[coin.sym].ask;
        if (!s.vol) s.vol = binResults[coin.sym].vol;
      } else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        const ageMs = now - last.t;
        if (ageMs <= 60000 && last.sources.BIN) s.sources.BIN = last.sources.BIN; // TTL: reject stale carry-forward
      }

      // OKX
      if (okxResults[coin.sym]) {
        s.sources.OKX = okxResults[coin.sym].price;
        if (!s.bid && okxResults[coin.sym].bid) s.bid = okxResults[coin.sym].bid;
        if (!s.ask && okxResults[coin.sym].ask) s.ask = okxResults[coin.sym].ask;
        if (!s.vol) s.vol = okxResults[coin.sym].vol;
      } else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        const ageMs = now - last.t;
        if (ageMs <= 60000 && last.sources.OKX) s.sources.OKX = last.sources.OKX; // TTL: reject stale carry-forward
      }

      // Kraken
      if (krkResults[coin.sym]) {
        s.sources.KRK = krkResults[coin.sym].price;
        if (!s.bid && krkResults[coin.sym].bid) s.bid = krkResults[coin.sym].bid;
        if (!s.ask && krkResults[coin.sym].ask) s.ask = krkResults[coin.sym].ask;
        if (!s.vol) s.vol = krkResults[coin.sym].vol;
      } else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        const ageMs = now - last.t;
        if (ageMs <= 60000 && last.sources.KRK) s.sources.KRK = last.sources.KRK; // TTL: reject stale carry-forward
      }

      // DexScreener
      if (dexResults[coin.sym]) {
        s.sources.DEX = dexResults[coin.sym].price;
        s.meta.dex = dexResults[coin.sym];
      } else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        const ageMs = now - last.t;
        if (ageMs <= 60000 && last.sources.DEX) { s.sources.DEX = last.sources.DEX; s.meta.dex = last.meta?.dex; } // TTL gate
      }

      // Drop venue outliers so one bad quote cannot fabricate a fake arb window.
      const entries = Object.entries(s.sources).filter(([, value]) => Number.isFinite(value) && value > 0);
      if (entries.length >= 3) {
        const sorted = entries.map(([, value]) => value).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const rejected = entries.filter(([, value]) => Math.abs(value - median) / median > 0.08).map(([src]) => src);
        rejected.forEach(src => delete s.sources[src]);
        if (rejected.length) s.meta.rejectedSources = rejected;
      }

      // Buffer
      if (!sampleBuf[coin.sym]) sampleBuf[coin.sym] = [];
      sampleBuf[coin.sym].push(s);
      if (sampleBuf[coin.sym].length > MAX_BUF) sampleBuf[coin.sym] = sampleBuf[coin.sym].slice(-MAX_BUF);
    });
  }

  // ---- CFM Calculation ----
  function volumeWeightedMedian(trades) {
    if (!trades.length) return null;
    if (trades.length === 1) return trades[0].price;
    const sorted = [...trades].sort((a, b) => a.price - b.price);
    const total = sorted.reduce((s, t) => s + t.vol, 0);
    const half = total / 2;
    let cum = 0;
    for (const t of sorted) { cum += t.vol; if (cum >= half) return t.price; }
    return sorted[sorted.length - 1].price;
  }

  function computeCFM(sym) {
    const buf = sampleBuf[sym];
    if (!buf || buf.length < 3) return { cfmRate: 0, error: 'Warming up', sampleCount: buf?.length || 0 };

    const now = Date.now();
    const winMs = WINDOW_MIN * 60000;
    const winStart = now - winMs;
    const winSamples = buf.filter(s => s.t >= winStart);
    const useSamples = winSamples.length >= 2 ? winSamples : buf.slice(-10);

    // Partition → VWM
    const partMs = winMs / PARTITIONS;
    const parts = [];
    for (let i = 0; i < PARTITIONS; i++) {
      const ps = winStart + i * partMs, pe = ps + partMs;
      const pSamples = useSamples.filter(s => s.t >= ps && s.t < pe);
      if (!pSamples.length) { parts.push({ vwm: null, n: 0, i: i + 1 }); continue; }

      const trades = pSamples.map(s => {
        const prices = Object.entries(s.sources);
        if (!prices.length) return null;
        let wSum = 0, weightTotal = 0;
        prices.forEach(([src, p]) => {
          const w = getSourceWeight(src);
          wSum += p * w;
          weightTotal += w;
        });
        return { price: wSum / weightTotal, vol: s.vol || 1 };
      }).filter(Boolean);

      parts.push({ vwm: volumeWeightedMedian(trades), n: trades.length, i: i + 1 });
    }

    const valid = parts.filter(p => p.vwm !== null);
    const cfmRate = valid.length > 0 ? valid.reduce((s, p) => s + p.vwm, 0) / valid.length : 0;

    // VWAP
    let vN = 0, vD = 0;
    useSamples.forEach(s => {
      const pp = Object.entries(s.sources);
      if (!pp.length) return;
      let wSum = 0, weightTotal = 0;
      pp.forEach(([src, p]) => {
        const w = getSourceWeight(src);
        wSum += p * w;
        weightTotal += w;
      });
      const avg = wSum / weightTotal;
      const v = s.vol || 1;
      vN += avg * v; vD += v;
    });
    const vwap15 = vD > 0 ? vN / vD : cfmRate;

    // TWAP
    const allP = useSamples.map(s => {
      const pp = Object.entries(s.sources);
      if (!pp.length) return null;
      let wSum = 0, weightTotal = 0;
      pp.forEach(([src, p]) => {
        const w = getSourceWeight(src);
        wSum += p * w;
        weightTotal += w;
      });
      return wSum / weightTotal;
    }).filter(Boolean);
    const twap15 = allP.length > 0 ? allP.reduce((a, b) => a + b, 0) / allP.length : cfmRate;

    // Cross-exchange spread + convergence
    const latest = buf[buf.length - 1];
    const srcPrices = Object.entries(latest.sources);
    const prices = srcPrices.map(([, v]) => v);
    const spread = prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100 : 0;
    let convergence = 0;
    if (prices.length > 1) {
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      convergence = mean > 0 ? (Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length) / mean) * 100 : 0;
    }

    // Bid-ask
    const bidAsk = latest.bid > 0 && latest.ask > 0 ? ((latest.ask - latest.bid) / latest.bid) * 100 : 0;

    // Momentum (rate of cfmRate change over last 5 cycles)
    let momentum = 0;
    if (buf.length > 5) {
      const older = buf[buf.length - 6];
      const op = Object.values(older.sources);
      if (op.length) { const oa = op.reduce((a, b) => a + b, 0) / op.length; if (oa > 0) momentum = ((cfmRate - oa) / oa) * 100; }
    }

    // Trend
    let trend = 'flat';
    if (allP.length > 2) {
      const h1 = allP.slice(0, Math.floor(allP.length / 2));
      const h2 = allP.slice(Math.floor(allP.length / 2));
      const a1 = h1.reduce((a, b) => a + b, 0) / h1.length;
      const a2 = h2.reduce((a, b) => a + b, 0) / h2.length;
      const d = ((a2 - a1) / a1) * 100;
      trend = d > 0.03 ? 'rising' : d < -0.03 ? 'falling' : 'flat';
    }

    // Source breakdown
    const sourceDetail = {};
    srcPrices.forEach(([k, v]) => { sourceDetail[k] = v; });

    // DEX metadata
    const dexMeta = latest.meta?.dex || null;

    // Anomaly Detection
    if (!anomalyMonitors[sym]) {
      if (typeof window.ExchangeAnomalyMonitor !== 'undefined') {
        anomalyMonitors[sym] = new window.ExchangeAnomalyMonitor(sym, 20);
      }
    }
    
    let isAnomalous = false;
    let anomalyReasons = [];
    if (anomalyMonitors[sym]) {
      const spreadLiquidity = bidAsk > 0 ? (1 / (bidAsk / 100)) : null;
      const vol = latest.vol || 0;
      const anomalyCheck = anomalyMonitors[sym].updateAndCheck(cfmRate, latest.ask, latest.bid, vol, spreadLiquidity);
      isAnomalous = anomalyCheck.elevatePriority;
      anomalyReasons = anomalyCheck.alerts;
    }

    return {
      cfmRate, vwap15, twap15, spread, convergence, bidAsk, momentum, trend,
      isAnomalous, anomalyReasons,
      partitions: parts,
      sources: sourceDetail,
      sourceCount: Object.keys(sourceDetail).length,
      sampleCount: buf.length,
      windowSamples: useSamples.length,
      dexMeta,
      cbSpread: latest.meta?.cbSpread || 0,
      lastPrice: prices.length > 0 ? prices[prices.length - 1] : 0,
      updatedAt: new Date().toLocaleTimeString(),
    };
  }

  // ---- Orchestrator ----
  async function runCycle() {
    const t0 = Date.now();
    cycle++;
    await sampleAll();
    PREDICTION_COINS.forEach(c => { window._cfm[c.sym] = computeCFM(c.sym); });
    // Annotate each coin's CFM result with a funding-rate bias signal.
    // Must run AFTER computeCFM because that call replaces window._cfm[sym].
    _computeFundingBias();
    lastMs = Date.now() - t0;
  }

  // ---- Public API ----
  window.CFMEngine = {
    async start() {
      if (window.ExchangeWS?.start) {
        try { window.ExchangeWS.start(); } catch (_) { }
      }
      await runCycle();
      timer = setInterval(runCycle, POLL_MS);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    get(sym) { return window._cfm[sym] || null; },
    getAll() { return window._cfm; },
    getStatus() {
      return {
        running: !!timer, cycle, lastMs, pollMs: POLL_MS,
        sources: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, { label: v.label, color: v.color, used: v.used, budget: v.budget, pct: Math.round((v.used / v.budget) * 100) }])),
        buffers: Object.fromEntries(PREDICTION_COINS.map(c => [c.sym, sampleBuf[c.sym]?.length || 0])),
      };
    },
  };

})();
