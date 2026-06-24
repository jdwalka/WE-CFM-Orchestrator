// ================================================================
// cex-flow.js — CEX Exchange Flow Monitor  v1.1
// Detects institutional accumulation/distribution across major CEXs.
// WS-first (ExchangeWS mux) with REST fallback when a stream is stale.
// Polls every 15s to refresh aggregate state from live stream snapshots.
// ================================================================
// Exposes:  window.CexFlow
// Events:   cex-flow-update  (detail = { sym → exchangeResults[] })
// Methods:  .get(sym)      → { exchanges[], aggregate, ts }
//           .getAll()      → map of all coins
//           .start()/.stop()
// ================================================================

(function () {
  'use strict';

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
  const BINANCE_SPOT_SYMS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE']);
  const POLL_MS = 15000;
  const TIMEOUT = 9000;
  const CACHE = {};        // sym → { exchanges[], aggregate, ts }
  const VOL_HISTORY = {};    // `${exchange}_${sym}` → [vol24h, ...]  (rolling 8)
  const EXCHANGE_CACHE = {}; // `${exchange}_${sym}` -> { value, ts, inFlight }
  const EXCHANGE_POLL_INTERVAL_MS = {
    Binance: 30000,
    Coinbase: 15000,
    Kraken: 30000,
    Bybit: 30000,
    OKX: 30000,
    KuCoin: 30000,
    'Gate.io': 30000,
    Upbit: 30000,
    Bitget: 30000,
    BingX: 60000,
    Bitvavo: 60000,
    Gemini: 120000,
    CoinW: 120000,
    LBank: 180000,
    Bitstamp: 30000,
    Bitso: 180000,
    Bullish: 300000,
    WhiteBIT: 300000,
    Ourbit: 300000,
    WEEX: 300000,
  };
  const SECONDARY_EXCHANGES = Object.keys(EXCHANGE_POLL_INTERVAL_MS);
  let _timer = null;
  let _fetchCycle = 0;

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── helpers ──────────────────────────────────────────────────────
  function timedFetch(url, opts = {}) {
    return Promise.race([
      fetch(url, opts),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), TIMEOUT)
      ),
    ]);
  }

  async function getJson(url, opts = {}) {
    const res = await timedFetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function pushVolHistory(key, vol) {
    if (vol == null || isNaN(vol) || vol <= 0) return;
    if (!VOL_HISTORY[key]) VOL_HISTORY[key] = [];
    VOL_HISTORY[key].push(vol);
    if (VOL_HISTORY[key].length > 8) VOL_HISTORY[key].shift();
  }

  function rollingVolMult(key, currentVol) {
    const hist = VOL_HISTORY[key];
    if (!hist || hist.length < 2) return null; // need at least one prior poll
    const avg = hist.slice(0, -1).reduce((a, b) => a + b, 0) / (hist.length - 1);
    if (avg <= 0) return null;
    return currentVol / avg;
  }

  function shouldPollExchange(exchange, sym, intervalMs) {
    const slots = Math.max(1, Math.ceil((Number(intervalMs) || POLL_MS) / POLL_MS));
    if (slots <= 1) return true;
    const coinIndex = Math.max(0, COINS.indexOf(sym));
    const exchangeIndex = Math.max(0, SECONDARY_EXCHANGES.indexOf(exchange));
    return ((coinIndex + exchangeIndex + _fetchCycle) % slots) === 0;
  }

  async function withExchangeCadence(exchange, sym, fetcher) {
    const intervalMs = EXCHANGE_POLL_INTERVAL_MS[exchange] || POLL_MS;
    const key = `${exchange}_${sym}`;
    const row = EXCHANGE_CACHE[key] || {};
    const ageMs = Date.now() - Number(row.ts || 0);
    if (row.value && ageMs < intervalMs) {
      return {
        ...row.value,
        via: row.value.via || 'cached-pool',
        cadenceMs: intervalMs,
      };
    }
    if (row.inFlight) {
      if (row.value) return { ...row.value, via: row.value.via || 'cached-pool', cadenceMs: intervalMs };
      return row.inFlight;
    }
    if (!shouldPollExchange(exchange, sym, intervalMs)) {
      if (row.value) return { ...row.value, via: row.value.via || 'stale-pool', cadenceMs: intervalMs };
      return {
        exchange,
        available: false,
        reason: `pooled ${Math.round(intervalMs / 1000)}s cadence wait`,
        cadenceMs: intervalMs,
        via: 'cadence-wait',
      };
    }
    row.inFlight = Promise.resolve()
      .then(fetcher)
      .then(value => {
        EXCHANGE_CACHE[key] = { value, ts: Date.now(), inFlight: null };
        return { ...value, cadenceMs: intervalMs };
      })
      .catch(err => {
        if (row.value) return { ...row.value, via: row.value.via || 'stale-pool', cadenceMs: intervalMs };
        return { exchange, available: false, reason: err?.message || 'cadence fetch failed', cadenceMs: intervalMs };
      });
    EXCHANGE_CACHE[key] = row;
    return row.inFlight;
  }

  function wsSnapshot(exchange, sym) {
    const providerMap = {
      Binance: 'BINANCE',
      Coinbase: 'COINBASE',
      Kraken: 'KRAKEN',
      Bybit: 'BYBIT',
      OKX: 'OKX',
      KuCoin: 'KUCOIN',
      'Gate.io': 'GATE',
      Upbit: 'UPBIT',
      Bitget: 'BITGET',
      BingX: 'BINGX',
      Bitstamp: 'BITSTAMP',
      Bitvavo: 'BITVAVO',
    };
    const provider = providerMap[exchange];
    if (!provider || !window.ExchangeWS?.getTicker) return null;
    const snap = window.ExchangeWS.getTicker(provider, sym, 20000);
    if (!snap || !Number.isFinite(snap.price) || snap.price <= 0) return null;

    const vol24h = Number.isFinite(snap.vol24h) ? snap.vol24h : null;
    const volKey = `${exchange}_${sym}`;
    pushVolHistory(volKey, vol24h);
    const volMult = vol24h != null ? rollingVolMult(volKey, vol24h) : null;
    const buyPct = Number.isFinite(snap.buyPct) ? snap.buyPct : 50;
    const sellPct = Number.isFinite(snap.sellPct) ? snap.sellPct : 50;
    const { signal, color } = computeSignal(buyPct, sellPct, volMult, null);
    return {
      exchange,
      buyPct,
      sellPct,
      volMult,
      fundingPct: null,
      signal,
      color,
      available: true,
      via: 'ws',
      ts: snap.ts,
      price: snap.price,
      bid: snap.bid,
      ask: snap.ask,
    };
  }

  // ── signal computation ────────────────────────────────────────────
  function computeSignal(buyPct, sellPct, volMult, fundingPct) {
    const fundBear = fundingPct != null && fundingPct > 0.02;
    const fundBull = fundingPct != null && fundingPct < -0.02;
    const bigVol = volMult != null && volMult > 1.8;
    const smallVol = volMult != null && volMult < 0.5;

    if (sellPct > 58 || (sellPct > 52 && fundBear)) return { signal: 'DISTRIBUTING', color: 'red' };
    if (buyPct > 58 || (buyPct > 52 && fundBull)) return { signal: 'ACCUMULATING', color: 'green' };
    if (bigVol && Math.abs(buyPct - sellPct) < 6) return { signal: 'VOLATILE', color: 'orange' };
    if (smallVol) return { signal: 'QUIET', color: 'faint' };
    return { signal: 'NEUTRAL', color: 'muted' };
  }

  // ── per-exchange fetchers ─────────────────────────────────────────

  async function fetchBinance(sym) {
    const exchange = 'Binance';
    if (!BINANCE_SPOT_SYMS.has(sym)) {
      return { exchange, available: false, reason: 'Unsupported symbol' };
    }
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    try {
      // HYPE not on Binance futures but we still try spot
      const [tradesRes, tickerRes] = await Promise.allSettled([
        getJson(`https://data-api.binance.vision/api/v3/aggTrades?symbol=${sym}USDT&limit=500`),
        getJson(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${sym}USDT`),
      ]);

      if (tradesRes.status === 'rejected') throw new Error(tradesRes.reason?.message || 'trades failed');

      const trades = tradesRes.value;
      let buyQty = 0, sellQty = 0;
      for (const t of trades) {
        const qty = parseFloat(t.q || t.qty || 0);
        if (t.m === false) buyQty += qty; // taker is buyer
        else sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;

      let vol24h = null;
      if (tickerRes.status === 'fulfilled') {
        vol24h = parseFloat(tickerRes.value.quoteVolume || 0);
      }
      const volKey = `${exchange}_${sym}`;
      pushVolHistory(volKey, vol24h);
      const volMult = vol24h != null ? rollingVolMult(volKey, vol24h) : null;

      // Funding (futures) — not available for HYPE
      let fundingPct = null;
      if (sym !== 'HYPE') {
        try {
          const fi = await getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}USDT`);
          fundingPct = parseFloat(fi.lastFundingRate) * 100;
        } catch (_) { /* futures not available for this coin */ }
      }

      const { signal, color } = computeSignal(buyPct, sellPct, volMult, fundingPct);
      return { exchange, buyPct, sellPct, volMult, fundingPct, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  async function fetchCoinbase(sym) {
    const exchange = 'Coinbase';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    // BNB is not listed on Coinbase spot; skip it instead of burning requests.
    if (sym === 'BNB') {
      return { exchange, available: false, reason: 'Not listed' };
    }
    try {
      let jwtStr1 = null;
      let jwtStr2 = null;
      try {
        if (window.desktopApp && window.desktopApp.generateCoinbaseJWT) {
          const [res1, res2] = await Promise.all([
            window.desktopApp.generateCoinbaseJWT({
              requestMethod: 'GET',
              requestPath: `api.coinbase.com/api/v3/brokerage/market/products/${sym}-USD/ticker?limit=100`
            }),
            window.desktopApp.generateCoinbaseJWT({
              requestMethod: 'GET',
              requestPath: `api.coinbase.com/api/v3/brokerage/market/products/${sym}-USD`
            })
          ]);
          if (res1 && res1.success) jwtStr1 = res1.jwt;
          if (res2 && res2.success) jwtStr2 = res2.jwt;
        }
      } catch(e) { console.warn('[CexFlow] CB JWT failed:', e.message); }

      const headers1 = { 'Accept': 'application/json' };
      if (jwtStr1) headers1['Authorization'] = `Bearer ${jwtStr1}`;
      
      const headers2 = { 'Accept': 'application/json' };
      if (jwtStr2) headers2['Authorization'] = `Bearer ${jwtStr2}`;

      const url1 = `https://api.coinbase.com/api/v3/brokerage/market/products/${sym}-USD/ticker?limit=100`;
      const url2 = `https://api.coinbase.com/api/v3/brokerage/market/products/${sym}-USD`;

      const [tradesRes, tickerRes] = await Promise.allSettled([
        getJson(url1, { headers: headers1 }),
        getJson(url2, { headers: headers2 }),
      ]);

      if (tradesRes.status === 'rejected') {
        throw new Error(tradesRes.reason?.message || 'trades failed');
      }

      const trades = tradesRes.value?.trades || [];
      let buyQty = 0, sellQty = 0;
      for (const t of trades) {
        const qty = parseFloat(t.size || 0);
        // In Coinbase V3, side is the aggressor side ("BUY" or "SELL")
        if (t.side === 'BUY') buyQty += qty;
        else sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;

      let vol24h = null;
      if (tickerRes.status === 'fulfilled') {
        vol24h = parseFloat(tickerRes.value.volume_24h || 0);
      }
      const volKey = `${exchange}_${sym}`;
      pushVolHistory(volKey, vol24h);
      const volMult = vol24h != null ? rollingVolMult(volKey, vol24h) : null;

      const { signal, color } = computeSignal(buyPct, sellPct, volMult, null);
      return { exchange, buyPct, sellPct, volMult, fundingPct: null, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  const KRAKEN_PAIRS = {
    BTC: 'XBTUSDT',
    ETH: 'ETHUSDT',
    SOL: 'SOLUSDT',
    XRP: 'XRPUSDT',
    BNB: null,
    DOGE: 'DOGEUSDT',
    HYPE: null,
  };

  async function fetchKraken(sym) {
    const exchange = 'Kraken';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    const krakenPair = KRAKEN_PAIRS[sym];
    if (!krakenPair) {
      return { exchange, available: false, reason: 'Not listed' };
    }
    try {
      const data = await getJson(`https://api.kraken.com/0/public/Trades?pair=${krakenPair}&count=200`);
      if (data.error && data.error.length) throw new Error(data.error[0]);
      const result = data.result || {};
      const key = Object.keys(result).find(k => k !== 'last');
      const trades = key ? result[key] : [];

      let buyQty = 0, sellQty = 0;
      for (const t of trades) {
        // array: [price, volume, time, side, ...]
        const qty = parseFloat(t[1] || 0);
        const side = t[3]; // 'b' or 's'
        if (side === 'b') buyQty += qty;
        else sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;

      const { signal, color } = computeSignal(buyPct, sellPct, null, null);
      return { exchange, buyPct, sellPct, volMult: null, fundingPct: null, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  async function fetchBybit(sym) {
    const exchange = 'Bybit';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    // HYPE not on Bybit
    if (sym === 'HYPE') {
      return { exchange, available: false, reason: 'Not listed' };
    }
    try {
      const [tradesRes, fundRes] = await Promise.allSettled([
        getJson(`https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=${sym}USDT&limit=200`),
        getJson(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}USDT&limit=1`),
      ]);

      // Geo-blocked (CloudFront 403) — fall back to Binance global data under Bybit weight slot
      if (tradesRes.status === 'rejected' && tradesRes.reason?.message?.includes('403')) {
        return fetchBybitViaBinanceFallback(sym);
      }

      if (tradesRes.status === 'rejected') throw new Error(tradesRes.reason?.message || 'trades failed');

      const list = tradesRes.value?.result?.list ?? [];
      let buyQty = 0, sellQty = 0;
      for (const t of list) {
        const qty = parseFloat(t.size || 0);
        if (t.side === 'Buy') buyQty += qty;
        else sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;

      let fundingPct = null;
      if (fundRes.status === 'fulfilled') {
        const fl = fundRes.value?.result?.list;
        if (fl && fl.length > 0) {
          fundingPct = parseFloat(fl[0].fundingRate) * 100;
        }
      }

      const { signal, color } = computeSignal(buyPct, sellPct, null, fundingPct);
      return { exchange, buyPct, sellPct, volMult: null, fundingPct, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  // Bybit is geo-blocked (US CloudFront 403) — use Binance global spot data in the Bybit weight slot.
  // Binance global has identical liquidity profile and the same futures funding rate feed.
  async function fetchBybitViaBinanceFallback(sym) {
    const exchange = 'Bybit';
    if (!BINANCE_SPOT_SYMS.has(sym)) {
      return { exchange, available: false, reason: 'Unsupported symbol' };
    }
    try {
      const [tradesRes, fundRes] = await Promise.allSettled([
        getJson(`https://api.binance.com/api/v3/trades?symbol=${sym}USDT&limit=200`),
        getJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}USDT&limit=1`),
      ]);

      if (tradesRes.status === 'rejected') throw new Error(tradesRes.reason?.message || 'binance fb failed');

      const list = tradesRes.value ?? [];
      let buyQty = 0, sellQty = 0;
      for (const t of list) {
        const qty = parseFloat(t.qty || 0);
        // isBuyerMaker=false → taker was buyer (aggressive buy)
        if (!t.isBuyerMaker) buyQty += qty;
        else sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;

      let fundingPct = null;
      if (fundRes.status === 'fulfilled') {
        const fl = fundRes.value;
        if (Array.isArray(fl) && fl.length > 0) {
          fundingPct = parseFloat(fl[0].fundingRate) * 100;
        }
      }

      const { signal, color } = computeSignal(buyPct, sellPct, null, fundingPct);
      return { exchange, buyPct, sellPct, volMult: null, fundingPct, signal, color, available: true, fallback: 'binance-global' };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  async function fetchOkx(sym) {
    const exchange = 'OKX';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    // HYPE not on OKX
    if (sym === 'HYPE') {
      return { exchange, available: false, reason: 'Not listed' };
    }
    try {
      // Use proxy bypass for OKX geo-blocks
      const data = await getJson(`https://www.okx.com/api/v5/market/trades?instId=${sym}-USDT&limit=200`);
      const list = data?.data ?? [];

      let buyQty = 0, sellQty = 0;
      for (const t of list) {
        const qty = parseFloat(t.sz || 0);
        if (t.side === 'buy') buyQty += qty;
        else sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;

      const { signal, color } = computeSignal(buyPct, sellPct, null, null);
      return { exchange, buyPct, sellPct, volMult: null, fundingPct: null, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  const KUCOIN_SYMS = { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', BNB: 'BNB-USDT', DOGE: 'DOGE-USDT' };
  async function fetchKuCoin(sym) {
    const exchange = 'KuCoin';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    const kucoinSym = KUCOIN_SYMS[sym];
    if (!kucoinSym) return { exchange, available: false, reason: 'Not listed' };
    try {
      const [tradesRes, tickerRes] = await Promise.allSettled([
        getJson(`https://api.kucoin.com/api/v1/market/histories?symbol=${encodeURIComponent(kucoinSym)}`),
        getJson(`https://api.kucoin.com/api/v1/market/stats?symbol=${encodeURIComponent(kucoinSym)}`),
      ]);
      if (tradesRes.status === 'rejected') throw new Error(tradesRes.reason?.message || 'trades failed');

      const trades = Array.isArray(tradesRes.value?.data) ? tradesRes.value.data : [];
      let buyQty = 0, sellQty = 0;
      for (const t of trades) {
        const qty = parseFloat(t.size || t.qty || 0);
        if (String(t.side || '').toLowerCase() === 'buy') buyQty += qty;
        else sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;

      const ticker = tickerRes.status === 'fulfilled' ? tickerRes.value?.data || {} : {};
      const vol24h = parseFloat(ticker.volValue || ticker.vol || 0);
      const volKey = `${exchange}_${sym}`;
      pushVolHistory(volKey, vol24h);
      const volMult = vol24h > 0 ? rollingVolMult(volKey, vol24h) : null;
      const { signal, color } = computeSignal(buyPct, sellPct, volMult, null);
      return {
        exchange,
        buyPct,
        sellPct,
        volMult,
        fundingPct: null,
        signal,
        color,
        available: true,
        via: 'rest-fallback',
        price: parseFloat(ticker.last || ticker.buy || ticker.sell || 0) || null,
      };
    } catch (e) {
      return { exchange, available: false, reason: `WS/REST unavailable: ${e.message.slice(0, 44)}` };
    }
  }

  const GATE_SYMS = { BTC: 'BTC_USDT', ETH: 'ETH_USDT', SOL: 'SOL_USDT', XRP: 'XRP_USDT', BNB: 'BNB_USDT', DOGE: 'DOGE_USDT' };
  async function fetchGate(sym) {
    const exchange = 'Gate.io';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    const gateSym = GATE_SYMS[sym];
    if (!gateSym) return { exchange, available: false, reason: 'Not listed' };
    try {
      const [tradesRes, tickerRes] = await Promise.allSettled([
        getJson(`https://api.gateio.ws/api/v4/spot/trades?currency_pair=${encodeURIComponent(gateSym)}&limit=100`),
        getJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(gateSym)}`),
      ]);
      if (tradesRes.status === 'rejected') throw new Error(tradesRes.reason?.message || 'trades failed');

      const trades = Array.isArray(tradesRes.value) ? tradesRes.value : [];
      let buyQty = 0, sellQty = 0;
      for (const t of trades) {
        const qty = parseFloat(t.amount || t.size || 0);
        if (String(t.side || '').toLowerCase() === 'buy') buyQty += qty;
        else sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;

      const tickerRows = tickerRes.status === 'fulfilled'
        ? (Array.isArray(tickerRes.value) ? tickerRes.value : [tickerRes.value])
        : [];
      const ticker = tickerRows[0] || {};
      const vol24h = parseFloat(ticker.quote_volume || ticker.base_volume || 0);
      const volKey = `${exchange}_${sym}`;
      pushVolHistory(volKey, vol24h);
      const volMult = vol24h > 0 ? rollingVolMult(volKey, vol24h) : null;
      const { signal, color } = computeSignal(buyPct, sellPct, volMult, null);
      return {
        exchange,
        buyPct,
        sellPct,
        volMult,
        fundingPct: null,
        signal,
        color,
        available: true,
        via: 'rest-fallback',
        price: parseFloat(ticker.last || 0) || null,
        bid: parseFloat(ticker.highest_bid || 0) || null,
        ask: parseFloat(ticker.lowest_ask || 0) || null,
      };
    } catch (e) {
      return { exchange, available: false, reason: `WS/REST unavailable: ${e.message.slice(0, 44)}` };
    }
  }


  const UPBIT_SYMS = { BTC: 'USDT-BTC', ETH: 'USDT-ETH', SOL: 'USDT-SOL', XRP: 'USDT-XRP', DOGE: 'USDT-DOGE' };
  async function fetchUpbit(sym) {
    const exchange = 'Upbit';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    const upbitSym = UPBIT_SYMS[sym];
    if (!upbitSym) return { exchange, available: false, reason: 'Not listed' };
    try {
      const list = await getJson(`https://api.upbit.com/v1/trades/ticks?market=${upbitSym}&count=100`);
      let buyQty = 0, sellQty = 0;
      for (const t of list) {
        const qty = parseFloat(t.trade_volume || 0);
        if (t.ask_bid === 'BID') buyQty += qty;
        else sellQty += qty;
      }
      const latest = Array.isArray(list) ? list[0] : null;
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;
      const { signal, color } = computeSignal(buyPct, sellPct, null, null);
      return {
        exchange,
        buyPct,
        sellPct,
        volMult: null,
        fundingPct: null,
        signal,
        color,
        available: true,
        price: parseFloat(latest?.trade_price || latest?.price || 0) || null,
      };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  const BITGET_SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT', HYPE: 'HYPEUSDT' };
  async function fetchBitget(sym) {
    const exchange = 'Bitget';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    const bitgetSym = BITGET_SYMS[sym];
    if (!bitgetSym) return { exchange, available: false, reason: 'Not listed' };
    try {
      const res = await getJson(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${bitgetSym}`);
      const t = res?.data?.[0];
      const vol24h = parseFloat(t?.usdtVol || 0);
      const volKey = `${exchange}_${sym}`;
      pushVolHistory(volKey, vol24h);
      const volMult = vol24h != null ? rollingVolMult(volKey, vol24h) : null;
      const { signal, color } = computeSignal(50, 50, volMult, null);
      return {
        exchange,
        buyPct: 50,
        sellPct: 50,
        volMult,
        fundingPct: null,
        signal,
        color,
        available: true,
        price: parseFloat(t?.lastPr || t?.close || t?.price || 0) || null,
        bid: parseFloat(t?.bidPr || 0) || null,
        ask: parseFloat(t?.askPr || 0) || null,
      };
    } catch (e) { return { exchange, available: false, reason: e.message.slice(0, 60) }; }
  }

  const BINGX_SYMS = { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', BNB: 'BNB-USDT', DOGE: 'DOGE-USDT', HYPE: 'HYPE-USDT' };
  async function fetchBingX(sym) {
    const exchange = 'BingX';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    const bingxSym = BINGX_SYMS[sym];
    if (!bingxSym) return { exchange, available: false, reason: 'Not listed' };
    try {
      const data = await getJson(`https://open-api.bingx.com/openApi/spot/v1/ticker/trade?symbol=${bingxSym}&limit=100`);
      const list = data?.data ?? [];
      let buyQty = 0, sellQty = 0;
      for (const t of list) {
        const qty = parseFloat(t.qty || 0);
        if (!t.isBuyerMaker) buyQty += qty;
        else sellQty += qty;
      }
      const latest = Array.isArray(list) ? list[0] : null;
      const totalQty = buyQty + sellQty;
      const buyPct = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct = 100 - buyPct;
      const { signal, color } = computeSignal(buyPct, sellPct, null, null);
      return {
        exchange,
        buyPct,
        sellPct,
        volMult: null,
        fundingPct: null,
        signal,
        color,
        available: true,
        price: parseFloat(latest?.price || latest?.p || 0) || null,
      };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  async function fetchBitstamp(sym) {
    const exchange = 'Bitstamp';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    try {
      const bitstampSym = sym.toLowerCase() + 'usd';
      const res = await getJson(`https://www.bitstamp.net/api/v2/ticker/${bitstampSym}/`);
      const vol24h = parseFloat(res?.volume || 0);
      const volKey = `${exchange}_${sym}`;
      pushVolHistory(volKey, vol24h);
      const volMult = vol24h != null ? rollingVolMult(volKey, vol24h) : null;
      const { signal, color } = computeSignal(50, 50, volMult, null);
      return {
        exchange,
        buyPct: 50,
        sellPct: 50,
        volMult,
        fundingPct: null,
        signal,
        color,
        available: true,
        price: parseFloat(res?.last || 0) || null,
        bid: parseFloat(res?.bid || 0) || null,
        ask: parseFloat(res?.ask || 0) || null,
      };
    } catch (e) { return { exchange, available: false, reason: e.message.slice(0, 60) }; }
  }

  async function fetchBitvavo(sym) {
    const exchange = 'Bitvavo';
    const ws = wsSnapshot(exchange, sym);
    if (ws) return ws;
    try {
      const bitvavoSym = sym.toUpperCase() + '-EUR'; // Bitvavo primarily uses EUR
      const res = await getJson(`https://api.bitvavo.com/v2/ticker/24h?market=${bitvavoSym}`);
      const vol24h = parseFloat(res?.volume || 0);
      const volKey = `${exchange}_${sym}`;
      pushVolHistory(volKey, vol24h);
      const volMult = vol24h != null ? rollingVolMult(volKey, vol24h) : null;
      const { signal, color } = computeSignal(50, 50, volMult, null);
      return {
        exchange,
        buyPct: 50,
        sellPct: 50,
        volMult,
        fundingPct: null,
        signal,
        color,
        available: true,
        price: parseFloat(res?.last || 0) || null,
        bid: parseFloat(res?.bid || 0) || null,
        ask: parseFloat(res?.ask || 0) || null,
      };
    } catch (e) { return { exchange, available: false, reason: e.message.slice(0, 60) }; }
  }

  // ── aggregate ─────────────────────────────────────────────────────

  const WEIGHTS = { Binance: 0.22, Bybit: 0.16, OKX: 0.14, Upbit: 0.12, Bitget: 0.08, BingX: 0.06, Coinbase: 0.08, Kraken: 0.06, KuCoin: 0.02, 'Gate.io': 0.02, Bitstamp: 0.02, Bitvavo: 0.02 };

  function computeAggregate(exchanges) {
    let score = 0;
    let distributing = 0, accumulating = 0, volatile = 0;
    let maxFunding = null;

    for (const ex of exchanges) {
      if (!ex.available) continue;
      const w = WEIGHTS[ex.exchange] ?? 0;
      if (ex.signal === 'DISTRIBUTING') { score -= w; distributing++; }
      else if (ex.signal === 'ACCUMULATING') { score += w; accumulating++; }
      else if (ex.signal === 'VOLATILE') { volatile++; }

      if (ex.fundingPct != null) {
        const absFund = Math.abs(ex.fundingPct);
        if (!maxFunding || absFund > Math.abs(maxFunding.pct)) {
          maxFunding = { exchange: ex.exchange, pct: ex.fundingPct };
        }
      }
    }

    let label;
    if (score < -0.3) label = 'STRONG SELL PRESSURE';
    else if (score < -0.1) label = 'SELL PRESSURE';
    else if (score > 0.3) label = 'STRONG BUY PRESSURE';
    else if (score > 0.1) label = 'BUY PRESSURE';
    else label = 'NEUTRAL';

    return { score, label, distributing, accumulating, volatile, maxFunding, leadingScore: score };
  }

  function emitMarketEnvelope(sym, ex, aggregate, ts) {
    const envelope = {
      envelope_id: `cex:${sym}:${ex.exchange}:${ts}:${Math.floor(Math.random() * 1e6)}`,
      source: `cex-${String(ex.exchange || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      received_ts: new Date(ts).toISOString(),
      chain_ts: null,
      type: 'trade_flow_snapshot',
      raw: ex,
      parsed: {
        symbol: sym,
        exchange: ex.exchange,
        buyPct: ex.buyPct ?? null,
        sellPct: ex.sellPct ?? null,
        signal: ex.signal ?? null,
        fundingPct: ex.fundingPct ?? null,
        volMult: ex.volMult ?? null,
        aggregateLabel: aggregate?.label || null,
        aggregateScore: aggregate?.score ?? null,
      },
      provenance: {
        module: 'cex-flow',
        via: ex.via || 'rest',
      },
      schema_version: 'v1',
    };

    window.dispatchEvent(new CustomEvent('market-data-envelope', { detail: envelope }));
  }

  // ── per-coin fetch ────────────────────────────────────────────────
  async function fetchCoin(sym) {
    const results = await Promise.allSettled([
      withExchangeCadence('Binance', sym, () => fetchBinance(sym)),
      withExchangeCadence('Coinbase', sym, () => fetchCoinbase(sym)),
      withExchangeCadence('Kraken', sym, () => fetchKraken(sym)),
      withExchangeCadence('Bybit', sym, () => fetchBybit(sym)),
      withExchangeCadence('OKX', sym, () => fetchOkx(sym)),
      withExchangeCadence('KuCoin', sym, () => fetchKuCoin(sym)),
      withExchangeCadence('Gate.io', sym, () => fetchGate(sym)),
      withExchangeCadence('Upbit', sym, () => fetchUpbit(sym)),
      withExchangeCadence('Bitget', sym, () => fetchBitget(sym)),
      withExchangeCadence('BingX', sym, () => fetchBingX(sym)),
      withExchangeCadence('Bitstamp', sym, () => fetchBitstamp(sym)),
      withExchangeCadence('Bitvavo', sym, () => fetchBitvavo(sym)),
    ]);

    const exchanges = results.map(r =>
      r.status === 'fulfilled'
        ? r.value
        : { exchange: 'Unknown', available: false, reason: String(r.reason).slice(0, 60) }
    );

    const aggregate = computeAggregate(exchanges);
    const ts = Date.now();
    const entry = { exchanges, aggregate, ts };
    CACHE[sym] = entry;

    exchanges
      .filter(ex => ex && ex.available)
      .forEach(ex => emitMarketEnvelope(sym, ex, aggregate, ts));

    return entry;
  }

  // ── fetchAll ──────────────────────────────────────────────────────
  async function fetchAll() {
    _fetchCycle++;
    const detail = {};
    const batchSize = 2;
    for (let i = 0; i < COINS.length; i += batchSize) {
      const batch = COINS.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(sym => fetchCoin(sym)));
      for (let j = 0; j < batch.length; j++) {
        if (results[j].status === 'fulfilled') detail[batch[j]] = results[j].value;
      }
      if (i + batchSize < COINS.length) await wait(75);
    }

    // INTEGRATION: Load local Python supervisor and high-frequency state files
    if (window.electron && typeof window.electron.readFile === 'function') {
      try {
        const supervisorStr = await window.electron.readFile('WECRYP0-data/cex_flow_state.json');
        if (supervisorStr) {
          const supervisorState = JSON.parse(supervisorStr);
          const activeMonitors = supervisorState.active_monitors || [];
          
          for (const coin of COINS) {
            const pyStats = supervisorState.coins?.[coin];
            if (pyStats) {
              if (!CACHE[coin]) {
                CACHE[coin] = { exchanges: [], aggregate: {}, ts: Date.now() };
              }
              
              // Merge/Override aggregate stats with supervisor metrics
              CACHE[coin].aggregate = {
                ...CACHE[coin].aggregate,
                score: pyStats.vol_mult > 2.0 
                  ? (pyStats.buy_pct > pyStats.sell_pct ? 0.35 : -0.35) 
                  : (pyStats.buy_pct > pyStats.sell_pct ? 0.15 : -0.15),
                label: pyStats.signal,
                volMult: pyStats.vol_mult,
                hurst_v: pyStats.hurst_v,
                vr_v: pyStats.vr_v,
                distributing: pyStats.signal === 'DISTRIBUTING' ? 1 : 0,
                accumulating: pyStats.signal === 'ACCUMULATING' ? 1 : 0,
                volatile: pyStats.signal === 'VOLATILE' ? 1 : 0,
              };
              
              CACHE[coin].ts = supervisorState.ts * 1000; // Convert to ms timestamp
              
              // If high-frequency monitor is active, load the child JSON state
              if (activeMonitors.includes(coin)) {
                try {
                  const hfStr = await window.electron.readFile(`WECRYP0-data/cex_high_freq_${coin.toLowerCase()}.json`);
                  if (hfStr) {
                    const hfState = JSON.parse(hfStr);
                    CACHE[coin].hf = {
                      active: true,
                      connected: hfState.connected,
                      tradesPerSec: hfState.trades_per_sec,
                      vpin: hfState.vpin,
                      whaleTrades10k: hfState.whale_trades_1m_10k,
                      whaleTrades50k: hfState.whale_trades_1m_50k,
                      price: hfState.price,
                      buyPct: hfState.buy_pct_1m,
                      sellPct: hfState.sell_pct_1m,
                    };
                    
                    // Override price with high-frequency spot price for precision
                    CACHE[coin].price = hfState.price;
                  }
                } catch (hfErr) {
                  CACHE[coin].hf = { active: true, connected: false };
                }
              } else {
                CACHE[coin].hf = { active: false };
              }
              
              detail[coin] = CACHE[coin];
            }
          }
        }
      } catch (err) {
        console.warn('[CexFlow] Python state sync skipped/failed:', err.message);
      }
    }

    window.dispatchEvent(new CustomEvent('cex-flow-update', { detail }));
    return detail;
  }

  // ── public API ────────────────────────────────────────────────────
  const CexFlow = {
    POLL_MS,
    get(sym) { return CACHE[sym] || null; },
    getAll() { return { ...CACHE }; },
    fetchAll,
    start() {
      if (_timer) return;
      if (window.ExchangeWS?.start) {
        try { window.ExchangeWS.start(); } catch (_) { }
      }
      fetchAll();
      _timer = setInterval(fetchAll, POLL_MS);
    },
    stop() {
      clearInterval(_timer);
      _timer = null;
    },
  };

  window.CexFlow = CexFlow;
})();
