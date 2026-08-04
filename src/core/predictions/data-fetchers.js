// Data Fetchers & API Cache Module
(function () {
  const candleCache = window.PredictionState.candleCache;
  const CDC_BASE = 'https://api.crypto.com/v2/public';
  const GECKO_BASE = 'https://api.coingecko.com/api/v3';
  const BIN_BASE = 'https://data-api.binance.vision/api/v3';  // market-data fallback after WS
  const MEXC_BASE = 'https://api.mexc.com/api/v3';
  const CB_EXCH_BASE = 'https://api.exchange.coinbase.com';
  const CB_EXCH_SYMS = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD' };
  const GECKO_ONLY = new Set(['BNB']);
  const GECKO_MIN_GAP_MS = 60_000;
  const GECKO_RATE_LIMIT_PAUSE_MS = 5 * 60_000;
  const GECKO_AUTH_PAUSE_MS = 5 * 60_000;
  // This module has its own IIFE, so these request-pacing variables cannot be
  // declared in predictions.js. Keeping them here makes every fetcher usable
  // as soon as this script loads.
  let geckoRequestQueue = Promise.resolve();
  let lastGeckoRequestAt = 0;
  let lastExchangeRequestAt = 0;
  const BIN_SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT' };
  const MEXC_SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', HYPE: 'HYPEUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT' };
  const BYBIT_BASE = 'https://api.bybit.com/v5';
  function getBybitUrl(path) { return `${BYBIT_BASE}${path}`; }
  const BYBIT_SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', HYPE: 'HYPEUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT' };
  const KUCOIN_BASE = 'https://api.kucoin.com/api/v1';
  const KUCOIN_SYMS = { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', HYPE: 'HYPE-USDT', DOGE: 'DOGE-USDT', BNB: 'BNB-USDT' };
  const BFNX_BASE = 'https://api-pub.bitfinex.com/v2';
  // BNB removed — not listed on Bitfinex. SOL corrected (tSOLUST was a typo → tSOLUSD).
  const BFNX_SYMS = { BTC: 'tBTCUSD', ETH: 'tETHUSD', SOL: 'tSOLUSD', XRP: 'tXRPUSD', DOGE: 'tDOGEUSD' };

  const ENABLE_MDT_SCORE_MULT = true; // set false to instantly revert to pre-MDT formula
  async function fetchWithTimeout(url, timeoutMs = 4000, options = {}) {
    const {
      schedulerLane = null,
      schedulerProvider = null,
      schedulerDelayMs = 0,
      schedulerDedupeKey = null,
      schedulerPriorityBoost = 0,
      ...fetchOptions
    } = options || {};

    const runFetch = async () => {
      const fetchImpl = (window.throttledFetch ?? fetch).bind(window);
      if (typeof AbortController === 'undefined') {
        return fetchImpl(url, fetchOptions);
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        try {
          controller.abort(new DOMException(`Predictions fetch timed out after ${timeoutMs}ms`, 'TimeoutError'));
        } catch (_) {
          try { controller.abort(); } catch (_) { }
        }
      }, timeoutMs);
      try {
        return await fetchImpl(url, { ...fetchOptions, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const scheduler = window._signalScheduler;
    if (!scheduler) return runFetch();

    return scheduler.schedule(runFetch, {
      lane: schedulerLane || scheduler.inferLaneFromUrl?.(url, 'momentum') || 'momentum',
      provider: schedulerProvider || scheduler.inferProviderFromUrl?.(url) || 'default',
      delayMs: schedulerDelayMs,
      priorityBoost: schedulerPriorityBoost,
      dedupeKey: schedulerDedupeKey || `${String(fetchOptions.method || 'GET').toUpperCase()}:${url}`,
      tag: `pred:${url}`,
    }).then(res => (res && typeof res.clone === 'function') ? res.clone() : res);
  }

  function randomBetween(min, max) {
    return Math.floor(min + Math.random() * Math.max(1, max - min + 1));
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function resetGeckoRequestQueue() {
    // Do not reset lastGeckoRequestAt: manual refreshes must keep the provider
    // pacing gap even when their stale queued work is discarded.
    geckoRequestQueue = Promise.resolve();
  }

  async function waitExchangeJitter(minGapMs = 90) {
    const jitterMs = randomBetween(40, 180);
    const sinceLast = Date.now() - lastExchangeRequestAt;
    const waitMs = Math.max(jitterMs, minGapMs - sinceLast);
    if (waitMs > 0) await wait(waitMs);
    lastExchangeRequestAt = Date.now();
  }

  // Track Gecko throttling/auth failures so a bad key or quota outage does not
  // keep the hot prediction loop retrying and logging every cycle.
  let geckoConsecutive429s = 0;
  let geckoCircuitBreakerUntil = 0;
  let geckoAuthFailureUntil = 0;
  let geckoLastAuthWarnTs = 0;

  function parseRetryAfterMs(headerValue) {
    if (!headerValue) return 0;
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(headerValue);
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
  }

  async function fetchGeckoJSON(path, options = {}) {
    const { minGapMs = GECKO_MIN_GAP_MS, retries = 0, retry429 = false } = options;
    const backoffMs = [1500, 3500, 20000];

    const run = async (attempt = 0) => {
      const nowCircuit = Date.now();
      if (nowCircuit < geckoAuthFailureUntil) {
        throw new Error(`Gecko auth circuit open (${Math.ceil((geckoAuthFailureUntil - nowCircuit) / 60000)}m remaining)`);
      }
      if (nowCircuit < geckoCircuitBreakerUntil) {
        throw new Error(`Gecko rate-limit circuit open (${Math.ceil((geckoCircuitBreakerUntil - nowCircuit) / 1000)}s remaining)`);
      }

      const now = Date.now();
      const waitMs = Math.max(0, minGapMs - (now - lastGeckoRequestAt));
      if (waitMs > 0) await wait(waitMs);
      lastGeckoRequestAt = Date.now();
      const rawUrl = `${GECKO_BASE}${path}`;
      const url = typeof window.coinGeckoUrl === 'function' ? window.coinGeckoUrl(rawUrl) : rawUrl;
      const baseFetchOptions = { headers: { Accept: 'application/json' } };
      const fetchOptions = typeof window.withCoinGeckoAuth === 'function'
        ? window.withCoinGeckoAuth(url, baseFetchOptions)
        : baseFetchOptions;
      const res = await fetchWithTimeout(url, 15000, fetchOptions);

      if (res.status === 429) {
        geckoConsecutive429s++;
        const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'));
        const pauseMs = Math.max(
          retryAfterMs,
          Math.min(15 * 60_000, GECKO_RATE_LIMIT_PAUSE_MS * Math.max(1, geckoConsecutive429s))
        );
        geckoCircuitBreakerUntil = Date.now() + pauseMs;
        console.warn(`[Gecko] 429 rate limit; pausing CoinGecko for ${Math.ceil(pauseMs / 1000)}s (consecutive=${geckoConsecutive429s})`);
        if (retry429 && attempt < retries) {
          const backoff = Math.max(pauseMs, backoffMs[Math.min(attempt, backoffMs.length - 1)]);
          await wait(backoff);
          return run(attempt + 1);
        }
        throw new Error('Gecko 429 rate limited');
      }

      // Success: reset consecutive 429 counter
      if (res.ok) geckoConsecutive429s = 0;

      // Handle 401 auth errors
      if (res.status === 401 || res.status === 403) {
        geckoConsecutive429s = 0;
        geckoAuthFailureUntil = Date.now() + GECKO_AUTH_PAUSE_MS;
        if ((Date.now() - geckoLastAuthWarnTs) > 60_000) {
          geckoLastAuthWarnTs = Date.now();
          console.warn(`[Gecko] ${res.status} auth/API rejection; pausing CoinGecko fallback for ${Math.round(GECKO_AUTH_PAUSE_MS / 60000)}m`);
        }
        throw new Error(`Gecko auth circuit open (HTTP ${res.status})`);
      }

      if (!res.ok) throw new Error(`Gecko ${res.status}`);
      return res.json();
    };

    const queued = geckoRequestQueue.then(() => run());
    geckoRequestQueue = queued.catch(() => { });
    return queued;
  }

  function geckoBucketMs(tf) {
    switch (tf) {
      case '15m': return 15 * 60 * 1000;
      case '1h': return 60 * 60 * 1000;
      default: return 5 * 60 * 1000;
    }
  }

  function bucketGeckoSeries(prices, volumes, bucketMs) {
    const buckets = new Map();
    prices.forEach((point, idx) => {
      const ts = Number(point[0]);
      const price = Number(point[1]);
      const vol = Number(volumes[idx]?.[1] || 0);
      if (!Number.isFinite(ts) || !Number.isFinite(price)) return;
      const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
      const bucket = buckets.get(bucketStart) || { t: bucketStart, o: price, h: price, l: price, c: price, v: 0 };
      bucket.h = Math.max(bucket.h, price);
      bucket.l = Math.min(bucket.l, price);
      bucket.c = price;
      bucket.v += Number.isFinite(vol) ? vol : 0;
      buckets.set(bucketStart, bucket);
    });
    return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
  }

  function bucketCandles(candles, bucketMs) {
    const buckets = new Map();
    (candles || []).forEach(candle => {
      const ts = Number(candle?.t);
      if (!Number.isFinite(ts)) return;
      const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
      const bucket = buckets.get(bucketStart) || { t: bucketStart, o: Number(candle.o), h: Number(candle.h), l: Number(candle.l), c: Number(candle.c), v: 0 };
      bucket.h = Math.max(bucket.h, Number(candle.h));
      bucket.l = Math.min(bucket.l, Number(candle.l));
      bucket.c = Number(candle.c);
      bucket.v += Number(candle.v || 0);
      buckets.set(bucketStart, bucket);
    });
    return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
  }

  function median(values) {
    if (!values || !values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function average(values) {
    return values && values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  }

  function poolMinuteCandles(...seriesList) {
    const buckets = new Map();
    seriesList.filter(Array.isArray).forEach(series => {
      series.forEach(candle => {
        const ts = Number(candle?.t);
        const close = Number(candle?.c);
        // Skip candles with non-finite timestamp or zero/near-zero price
        // (protects against exchanges returning bad candles that pass individual filters)
        if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) return;
        const bucket = buckets.get(ts) || { t: ts, o: [], h: [], l: [], c: [], v: [] };
        bucket.o.push(Number(candle.o || close));
        bucket.h.push(Number(candle.h || close));
        bucket.l.push(Number(candle.l || close));
        bucket.c.push(close);
        bucket.v.push(Number(candle.v || 0));
        buckets.set(ts, bucket);
      });
    });
    return Array.from(buckets.values()).sort((a, b) => a.t - b.t).map(bucket => ({
      t: bucket.t,
      o: median(bucket.o),
      h: Math.max(...bucket.h),
      l: Math.min(...bucket.l),
      c: median(bucket.c),
      v: average(bucket.v),
    }));
  }

  async function fetchCDCCandles(instrument, tf, count = 300) {
    const apiInstr = instrument.replace(/([A-Z]+)(USD[T]?)$/, '$1_$2');
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CDC_BASE}/get-candlestick?instrument_name=${apiInstr}&timeframe=${tf}&count=${count}`, 25000);
    if (!res.ok) throw new Error(`CDC ${res.status}`);
    const json = await res.json();
    if (json.code !== 0) throw new Error(`CDC code ${json.code}`);
    return json.result.data.map(normCandle).sort((a, b) => a.t - b.t);
  }

  async function fetchCDCBook(instrument) {
    const apiInstr = instrument.replace(/([A-Z]+)(USD[T]?)$/, '$1_$2');
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CDC_BASE}/get-book?instrument_name=${apiInstr}&depth=20`, 20000);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0) return null;
    const bookData = json.result?.data?.[0];
    if (!bookData) return null;
    return {
      bids: (bookData.bids || []).map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0),
      asks: (bookData.asks || []).map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0),
      source: 'crypto.com',
      timestamp: Date.now(),
    };
  }

  async function fetchCDCTrades(instrument) {
    const apiInstr = instrument.replace(/([A-Z]+)(USD[T]?)$/, '$1_$2');
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CDC_BASE.replace('/v1/', '/v2/')}/get-trades?instrument_name=${apiInstr}&count=100`, 20000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.code !== 0) return [];
    // CDC payload keys: q=quantity, p=price, s=side(BUY/SELL), m=maker_side(B/S=seller aggressor), d=tradeId, t=timestamp
    return (json.result.data || []).map(t => {
      const qty = parseFloat(t.q || t.qty || 0);
      const makerRaw = (t.m || '').toUpperCase();
      const sideRaw = (t.s || t.side || '').toUpperCase();
      const side = makerRaw
        ? (makerRaw === 'S' ? 'buy' : 'sell')   // seller=maker → buyer is aggressor
        : (sideRaw === 'BUY' || sideRaw === 'B' ? 'buy' : 'sell');
      return { qty, side, px: parseFloat(t.p || t.px || 0), t: Number(t.t || t.d || Date.now()) };
    }).filter(t => t.qty > 0);
  }

  function mexcSymbolForCoin(coin) {
    return MEXC_SYMS[coin.sym] || null;
  }

  function mexcInterval(tf) {
    switch (tf) {
      case '1m': return '1m';
      case '5m': return '5m';
      case '15m': return '15m';
      case '1h': return '1h';
      default: return tf;
    }
  }

  async function fetchMEXCCandles(coin, tf = '5m', limit = 300) {
    const symbol = mexcSymbolForCoin(coin);
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${MEXC_BASE}/klines?symbol=${symbol}&interval=${mexcInterval(tf)}&limit=${limit}`, 20000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(row => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c));
  }

  async function fetchMEXCBook(coin) {
    const symbol = mexcSymbolForCoin(coin);
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${MEXC_BASE}/depth?symbol=${symbol}&limit=20`, 7000);
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json?.bids) || !Array.isArray(json?.asks)) return null;
    return {
      bids: json.bids.map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(level => Number.isFinite(level.price) && Number.isFinite(level.qty)),
      asks: json.asks.map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(level => Number.isFinite(level.price) && Number.isFinite(level.qty)),
      source: 'mexc',
      timestamp: Date.now(),
    };
  }

  async function fetchMEXCTrades(coin, limit = 100) {
    const symbol = mexcSymbolForCoin(coin);
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${MEXC_BASE}/trades?symbol=${symbol}&limit=${limit}`, 7000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(trade => ({
      px: Number(trade.price),
      qty: Number(trade.qty),
      side: trade.isBuyerMaker ? 'sell' : 'buy',
      t: Number(trade.time || trade.id || Date.now()),
    })).filter(trade => Number.isFinite(trade.qty) && trade.qty > 0);
  }

  // ---------------------------------------------------------------
  // ByBit Exchange (public — no auth required)
  // ---------------------------------------------------------------

  function bybitInterval(tf) {
    switch (tf) {
      case '1m': return '1';
      case '5m': return '5';
      case '15m': return '15';
      case '1h': return '60';
      default: return '5';
    }
  }

  async function fetchBybitCandles(sym, tf = '5m', limit = 200) {
    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(getBybitUrl(`/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval(tf)}&limit=${limit}`), 20000);
    if (!res.ok) return fetchBINCandles(sym, tf === '1m' ? '1m' : tf === '5m' ? '5m' : '15m', limit);
    const json = await res.json();
    if (json.retCode !== 0 || !Array.isArray(json.result?.list)) return fetchBINCandles(sym, tf === '1m' ? '1m' : tf === '5m' ? '5m' : '15m', limit);
    const candles = json.result.list.map(row => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t);
    return candles.length ? candles : [];
  }

  async function fetchBybitBook(sym) {
    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(getBybitUrl(`/market/orderbook?category=spot&symbol=${symbol}&limit=20`), 7000);
    if (!res.ok) return fetchBINBook(sym);
    const json = await res.json();
    if (json.retCode !== 0 || !json.result) return fetchBINBook(sym);
    const bids = (json.result.b || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    const asks = (json.result.a || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    if (!bids.length && !asks.length) return null;
    return { bids, asks, source: 'bybit', timestamp: Date.now() };
  }

  async function fetchBybitTrades(sym, limit = 100) {
    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(getBybitUrl(`/market/recent-trade?category=spot&symbol=${symbol}&limit=${limit}`), 7000);
    if (!res.ok) return fetchBINTrades(sym, limit);
    const json = await res.json();
    if (json.retCode !== 0 || !Array.isArray(json.result?.list)) return fetchBINTrades(sym, limit);
    const trades = json.result.list.map(t => ({
      px: Number(t.price),
      qty: Number(t.size),
      side: t.side === 'Buy' ? 'buy' : 'sell',
      t: Number(t.time),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
    return trades.length ? trades : [];
  }

  // ---------------------------------------------------------------
  // KuCoin Exchange (public — no auth required)
  // ---------------------------------------------------------------

  function kucoinType(tf) {
    switch (tf) {
      case '1m': return '1min';
      case '5m': return '5min';
      case '15m': return '15min';
      case '1h': return '1hour';
      default: return '5min';
    }
  }

  async function fetchKucoinCandles(sym, tf = '5m', limit = 200) {
    const symbol = KUCOIN_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const bucketSec = tf === '1m' ? 60 : tf === '5m' ? 300 : tf === '15m' ? 900 : 3600;
    const endAt = Math.floor(Date.now() / 1000);
    const startAt = endAt - limit * bucketSec;
    const res = await fetchWithTimeout(`${KUCOIN_BASE}/market/candles?type=${kucoinType(tf)}&symbol=${symbol}&startAt=${startAt}&endAt=${endAt}`, 20000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.code !== '200000' || !Array.isArray(json.data)) return [];
    return json.data.map(row => ({
      t: Number(row[0]) * 1000,
      o: Number(row[1]),
      c: Number(row[2]),
      h: Number(row[3]),
      l: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t);
  }

  async function fetchKucoinBook(sym) {
    const symbol = KUCOIN_SYMS[sym];
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KUCOIN_BASE}/market/orderbook/level2_20?symbol=${symbol}`, 7000);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== '200000' || !json.data) return null;
    const bids = (json.data.bids || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    const asks = (json.data.asks || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    if (!bids.length && !asks.length) return null;
    return { bids, asks, source: 'kucoin', timestamp: Date.now() };
  }

  async function fetchKucoinTrades(sym, limit = 100) {
    const symbol = KUCOIN_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KUCOIN_BASE}/market/histories?symbol=${symbol}`, 7000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.code !== '200000' || !Array.isArray(json.data)) return [];
    return json.data.slice(0, limit).map(t => ({
      px: Number(t.price),
      qty: Number(t.size),
      side: t.side === 'buy' ? 'buy' : 'sell',
      t: Math.floor(Number(t.time) / 1e6),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  // ---------------------------------------------------------------
  // Bitfinex (public — no auth required)
  // ---------------------------------------------------------------

  function bfnxTimeframe(tf) {
    switch (tf) {
      case '1m': return '1m';
      case '5m': return '5m';
      case '15m': return '15m';
      case '1h': return '1h';
      default: return '5m';
    }
  }

  async function fetchBitfinexCandles(sym, tf = '5m', limit = 200) {
    const symbol = BFNX_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BFNX_BASE}/candles/trade:${bfnxTimeframe(tf)}:${symbol}/hist?limit=${limit}&sort=1`, 20000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    // Bitfinex: [mts, open, close, high, low, volume]
    return json.map(row => ({
      t: Number(row[0]),
      o: Number(row[1]),
      c: Number(row[2]),
      h: Number(row[3]),
      l: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c));
  }

  async function fetchBitfinexBook(sym) {
    const symbol = BFNX_SYMS[sym];
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BFNX_BASE}/book/${symbol}/P0?len=25`, 7000);
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json)) return null;
    const bids = json.filter(l => Number(l[2]) > 0).map(l => ({ price: Number(l[0]), qty: Number(l[2]) }));
    const asks = json.filter(l => Number(l[2]) < 0).map(l => ({ price: Number(l[0]), qty: Math.abs(Number(l[2])) }));
    if (!bids.length && !asks.length) return null;
    return { bids, asks, source: 'bitfinex', timestamp: Date.now() };
  }

  async function fetchBitfinexTrades(sym, limit = 100) {
    const symbol = BFNX_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BFNX_BASE}/trades/${symbol}/hist?limit=${limit}&sort=-1`, 7000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    // [id, mts, amount, price] — amount>0 = buy, amount<0 = sell
    return json.map(t => ({
      px: Number(t[3]),
      qty: Math.abs(Number(t[2])),
      side: Number(t[2]) > 0 ? 'buy' : 'sell',
      t: Number(t[1]),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  async function fetchGeckoCandles(geckoId, tf = '5m') {
    try {
      const days = tf === '1h' ? 7 : 1;
      const bucketMs = geckoBucketMs(tf);
      const json = await fetchGeckoJSON(`/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}`);
      const prices = Array.isArray(json.prices) ? json.prices : [];
      const volumes = Array.isArray(json.total_volumes) ? json.total_volumes : [];
      return bucketGeckoSeries(prices, volumes, bucketMs);
    } catch (e) {
      if (/Gecko auth circuit|Gecko rate-limit circuit|401 Unauthorized/i.test(String(e.message || e))) return [];
      console.warn(`[Gecko] market_chart failed for ${geckoId}:`, e.message);
      if (e.message.includes('429')) {
        console.warn(`[Gecko] Rate limited (429) for ${geckoId}, skipping candles fallback`);
      }
      return [];  // Return empty candles instead of failing
    }
  }

  async function fetchGeckoTicker(geckoId) {
    try {
      const json = await fetchGeckoJSON(`/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`);
      return json[geckoId];
    } catch (e) {
      if (/Gecko auth circuit|Gecko rate-limit circuit|401 Unauthorized/i.test(String(e.message || e))) return null;
      console.warn(`[Gecko] simple/price failed for ${geckoId}:`, e.message);
      if (e.message.includes('429')) {
        console.warn(`[Gecko] Rate limited (429) for ${geckoId}, skipping ticker fallback`);
      }
      return null;
    }
  }

  async function fetchGeckoMaxHistory(geckoId) {
    try {
      const days = '365'; // Hardcoded for Demo tier per CoinGecko specs
      const json = await fetchGeckoJSON(`/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}`);
      const prices = Array.isArray(json.prices) ? json.prices : [];
      const volumes = Array.isArray(json.total_volumes) ? json.total_volumes : [];
      return bucketGeckoSeries(prices, volumes, 24 * 60 * 60 * 1000);
    } catch (e) {
      if (/Gecko auth circuit|Gecko rate-limit circuit|401 Unauthorized/i.test(String(e.message || e))) return [];
      console.warn(`[Gecko] market_chart history failed for ${geckoId}:`, e.message);
      if (e.message.includes('429')) {
        console.warn(`[Gecko] Rate limited (429) for ${geckoId}, skipping history fallback`);
      }
      return [];  // Return empty history instead of failing
    }
  }

  async function fetchBINCandles(sym, interval = '1m', limit = 180) {
    const binSym = BIN_SYMS[sym];
    if (!binSym) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BIN_BASE}/klines?symbol=${binSym}&interval=${interval}&limit=${limit}`, 20000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(row => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c));
  }

  async function fetchBINBook(sym) {
    const binSym = BIN_SYMS[sym];
    if (!binSym) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BIN_BASE}/depth?symbol=${binSym}&limit=20`, 7000);
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json?.bids) || !Array.isArray(json?.asks)) return null;
    const bids = json.bids.map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    const asks = json.asks.map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    if (!bids.length && !asks.length) return null;
    return { bids, asks, source: 'binance', timestamp: Date.now() };
  }

  async function fetchBINTrades(sym, limit = 100) {
    const binSym = BIN_SYMS[sym];
    if (!binSym) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BIN_BASE}/trades?symbol=${binSym}&limit=${limit}`, 7000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(t => ({
      px: Number(t.price),
      qty: Number(t.qty),
      // isBuyerMaker=false → taker was buyer (aggressive buy)
      side: t.isBuyerMaker ? 'sell' : 'buy',
      t: Number(t.time),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  // ---------------------------------------------------------------
  // Coinbase Exchange (public — no auth required)
  // Used as primary anchor for all 1/5/15m predictions
  // ---------------------------------------------------------------

  async function fetchCBExchCandles(sym, granularitySec = 300, limit = 300) {
    const productId = CB_EXCH_SYMS[sym];
    if (!productId) return [];
    await waitExchangeJitter();
    const endSec = Math.floor(Date.now() / 1000);
    const startSec = endSec - limit * granularitySec;
    const res = await fetchWithTimeout(
      `${CB_EXCH_BASE}/products/${productId}/candles?granularity=${granularitySec}&start=${startSec}&end=${endSec}`,
      25000
    );
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    // CB returns [time_sec, low, high, open, close, volume] newest-first
    return json.map(row => ({
      t: Number(row[0]) * 1000,
      l: Number(row[1]),
      h: Number(row[2]),
      o: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t);
  }

  async function fetchCBExchBook(sym) {
    const productId = CB_EXCH_SYMS[sym];
    if (!productId) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CB_EXCH_BASE}/products/${productId}/book?level=2`, 20000);
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json?.bids) || !Array.isArray(json?.asks)) return null;
    return {
      bids: json.bids.slice(0, 20).map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0),
      asks: json.asks.slice(0, 20).map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0),
      source: 'coinbase',
      timestamp: Date.now(),
    };
  }

  async function fetchCBExchTrades(sym, limit = 100) {
    const productId = CB_EXCH_SYMS[sym];
    if (!productId) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CB_EXCH_BASE}/products/${productId}/trades?limit=${limit}`, 20000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(trade => ({
      qty: Number(trade.size),
      side: trade.side === 'buy' ? 'buy' : 'sell',
      px: Number(trade.price),
      t: trade.time ? new Date(trade.time).getTime() : Date.now(),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  // ---------------------------------------------------------------
  // Kraken (public REST — no auth required)
  // HYPE not listed on Kraken; all other PREDICTION_COINS supported
  // ---------------------------------------------------------------
  const KRAKEN_BASE = 'https://api.kraken.com/0/public';
  const KRAKEN_SYMS = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'XDGUSD', BNB: 'BNBUSD' };

  function krakenInterval(tf) {
    return tf === '1m' ? 1 : tf === '5m' ? 5 : tf === '15m' ? 15 : 5;
  }

  async function fetchKrakenCandles(sym, tf = '5m', limit = 300) {
    const pair = KRAKEN_SYMS[sym];
    if (!pair) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KRAKEN_BASE}/OHLC?pair=${pair}&interval=${krakenInterval(tf)}`, 25000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.error?.length) return [];
    const rows = Object.values(json.result || {}).find(v => Array.isArray(v));
    if (!rows) return [];
    // Kraken OHLC: [time_sec, open, high, low, close, vwap, vol, count]
    return rows.slice(-limit).map(row => ({
      t: Number(row[0]) * 1000,
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[6]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0);
  }

  async function fetchKrakenBook(sym) {
    const pair = KRAKEN_SYMS[sym];
    if (!pair) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KRAKEN_BASE}/Depth?pair=${pair}&count=25`, 20000);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error?.length) return null;
    const book = Object.values(json.result || {})[0];
    if (!book) return null;
    return {
      bids: (book.bids || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => l.qty > 0),
      asks: (book.asks || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => l.qty > 0),
      source: 'kraken',
      timestamp: Date.now(),
    };
  }

  async function fetchKrakenTrades(sym, limit = 100) {
    const pair = KRAKEN_SYMS[sym];
    if (!pair) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KRAKEN_BASE}/Trades?pair=${pair}`, 20000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.error?.length) return [];
    const rows = Object.values(json.result || {}).find(v => Array.isArray(v));
    if (!rows) return [];
    // Kraken trade: [price, volume, time_float, "b"/"s", ...]
    return rows.slice(-limit).map(t => ({
      px: Number(t[0]),
      qty: Number(t[1]),
      side: t[3] === 'b' ? 'buy' : 'sell',
      t: Math.round(Number(t[2]) * 1000),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  // Equal-weight pool across all exchanges — no single exchange is anchored
  function anchoredPoolCandles(cbSeries, ...fallbackSeries) {
    return poolMinuteCandles(...[cbSeries, ...fallbackSeries].filter(s => s?.length));
  }

  async function fetchAnalyticsWithRoute(url, timeoutMs = 4500) {
    const torOptIn = !!window.__TOR_ANALYTICS_OPT_IN__;
    const router = window.TORRouter;
    if (torOptIn && router && typeof router.routeAPI === 'function') {
      try {
        return await router.routeAPI(url, {
          routeClass: 'analytics',
          timeout: timeoutMs,
        });
      } catch (_) {
        // Fall through to direct path.
      }
    }
    return fetchWithTimeout(url, timeoutMs);
  }

  async function fetchFearGreed() {
    const now = Date.now();
    if (now - _fngCache.ts < 300000) return _fngCache.value;
    // Throttle on attempt (not only success) so transient outages don't spam requests.
    _fngCache.ts = now;
    try {
      // Non-critical indicator; keep timeout moderate to avoid noisy false negatives on slow routes.
      const res = await fetchAnalyticsWithRoute('https://api.alternative.me/fng/?limit=1', 15000);
      if (!res.ok) {
        console.warn(`[FNG] HTTP ${res.status} after 15s - using cached value`);
        return _fngCache.value;
      }
      const data = await res.json();
      _fngCache.value = parseInt(data.data[0].value, 10);
      console.info(`[FNG] Updated: ${_fngCache.value}`);
    } catch (e) {
      console.warn(`[FNG] Timeout/error after 15s: ${e.message} - using cached value`);
      /* use cached value */
    }
    return _fngCache.value;
  }

  window.PREDICTIONS_DATA_FETCHERS = {
    CDC_BASE, GECKO_BASE, BIN_BASE, MEXC_BASE, CB_EXCH_BASE, BYBIT_BASE, KUCOIN_BASE, BFNX_BASE,
    CB_EXCH_SYMS, BIN_SYMS, MEXC_SYMS, BYBIT_SYMS, KUCOIN_SYMS, BFNX_SYMS,
    fetchWithTimeout, fetchAnalyticsWithRoute, fetchFearGreed, resetGeckoRequestQueue,
    fetchCDCCandles, fetchCDCBook, fetchCDCTrades,
    fetchGeckoJSON, fetchGeckoCandles, fetchGeckoTicker, fetchGeckoMaxHistory,
    fetchBINCandles, fetchBINBook, fetchBINTrades,
    fetchMEXCCandles, fetchMEXCBook, fetchMEXCTrades,
    fetchCBExchCandles, fetchCBExchBook, fetchCBExchTrades,
    fetchBybitCandles, fetchBybitBook, fetchBybitTrades,
    fetchKucoinCandles, fetchKucoinBook, fetchKucoinTrades,
    fetchBitfinexCandles, fetchBitfinexBook, fetchBitfinexTrades,
    fetchKrakenCandles, fetchKrakenBook, fetchKrakenTrades,
    anchoredPoolCandles, bucketCandles
  };
})();
