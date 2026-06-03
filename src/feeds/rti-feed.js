// ================================================================
// WE|||CRYPTO — CME CF Real-Time Index (RTI) Methodology Feed
//
// Implements an order-book based RTI aligned to CME CF methodology:
// - constituent books only (Coinbase, Kraken, Bitstamp, Gemini)
// - delayed/erroneous/potentially-erroneous data handling
// - dynamic order size cap from uncapped consolidated order book
// - spacing/depth/deviation controls + exponential weighting
//
// Exposes:
//   window.RTIFeed
//   window._rtiPrices[sym] with:
//     { price, openAvg, closeAvg, delta, deltaDir, deltaPct, exchanges, stale, ts, meta }
// ================================================================

(function () {
  'use strict';

  const RTI_POLL_MS_BASE = 5_000;
  const RTI_POLL_MS_NEAR = 2_000;
  const NEAR_BOUNDARY_MS = 75_000;
  const EXCHANGE_FETCH_TIMEOUT_MS = 30_000;
  const MAX_LEVELS = 200;

  const BUFFER_SECS   = 180;      // keep enough history for open/close windows
  const STALE_MS      = 30_000;   // mark stale if no update in 30s
  const SETTLE_WINDOW = 60_000;   // last 60s before open/close = settlement window

  // CME CF RTI constituent symbols per exchange.
  const EXCHANGE_CONFIG = {
    coinbase: {
      url:    (pair) => `https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=${encodeURIComponent(pair)}&limit=${MAX_LEVELS}`,
      pairs:  { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD' },
      parse:  (d) => ({ bids: d?.pricebook?.bids || d?.bids, asks: d?.pricebook?.asks || d?.asks }),
    },
    kraken: {
      url:    (pair) => `https://api.kraken.com/0/public/Depth?pair=${pair}&count=${MAX_LEVELS}`,
      pairs:  { BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLUSD', XRP: 'XXRPZUSD' },
      parse:  (d) => {
        const key = Object.keys(d.result || {})[0];
        return key ? { bids: d.result[key]?.bids, asks: d.result[key]?.asks } : null;
      },
    },
    bitstamp: {
      url:    (pair) => `https://www.bitstamp.net/api/v2/order_book/${pair}/`,
      pairs:  { BTC: 'btcusd', ETH: 'ethusd', SOL: 'solusd', XRP: 'xrpusd' },
      parse:  (d) => ({ bids: d?.bids, asks: d?.asks }),
    },
    gemini: {
      url:    (pair) => `https://api.gemini.com/v1/book/${pair}?limit_bids=${MAX_LEVELS}&limit_asks=${MAX_LEVELS}`,
      pairs:  { BTC: 'btcusd', ETH: 'ethusd', SOL: 'solusd', XRP: 'xrpusd' },
      parse:  (d) => ({ bids: d?.bids, asks: d?.asks }),
    },
  };

  const SUPPORTED_SYMS = ['BTC', 'ETH', 'SOL', 'XRP'];
  const EXCHANGE_NAMES = Object.keys(EXCHANGE_CONFIG);

  // Index-specific parameters (CME CF v3.6.2, Section 6).
  const RTI_PARAMS = {
    BTC: { spacing: 1,    spreadDeviation: 0.005, potentiallyErroneousParam: 0.05 },
    ETH: { spacing: 25,   spreadDeviation: 0.01,  potentiallyErroneousParam: 0.05 },
    SOL: { spacing: 100,  spreadDeviation: 0.01,  potentiallyErroneousParam: 0.05 },
    XRP: { spacing: 20000, spreadDeviation: 0.01, potentiallyErroneousParam: 0.10 },
  };

  // Rolling buffer: _buffer[sym] = [{ ts, rti }]
  const _buffer = {};
  for (const sym of SUPPORTED_SYMS) _buffer[sym] = [];

  // Latest non-stale per-exchange mids (diagnostics/UI).
  const _latestMids = {};
  // Last valid fetched order books (for delayed-data rule handling).
  const _lastBooks = {};
  // Potentially-erroneous hysteresis state.
  const _outlierLatch = {};
  for (const sym of SUPPORTED_SYMS) {
    _latestMids[sym] = { coinbase: null, kraken: null, bitstamp: null, gemini: null };
    _lastBooks[sym] = { coinbase: null, kraken: null, bitstamp: null, gemini: null };
    _outlierLatch[sym] = { coinbase: false, kraken: false, bitstamp: false, gemini: false };
  }

  // Global output
  window._rtiPrices = window._rtiPrices || {};

  // ── Math helpers ───────────────────────────────────────────────────

  function mean(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sum = values.reduce((s, v) => s + v, 0);
    return sum / values.length;
  }

  function median(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function sampleStdDev(values, avg) {
    if (!Array.isArray(values) || values.length < 2 || !Number.isFinite(avg)) return 0;
    const varSum = values.reduce((s, v) => s + (v - avg) ** 2, 0);
    return Math.sqrt(varSum / (values.length - 1));
  }

  function bufferAvg(sym, fromMs, toMs) {
    const entries = _buffer[sym].filter(e => e.ts >= fromMs && e.ts <= toMs);
    if (entries.length === 0) return null;
    const sum = entries.reduce((s, e) => s + e.rti, 0);
    return sum / entries.length;
  }

  function pruneBuffer(sym) {
    const cutoff = Date.now() - BUFFER_SECS * 1000;
    const buf = _buffer[sym];
    let i = 0;
    while (i < buf.length && buf[i].ts < cutoff) i++;
    if (i > 0) _buffer[sym] = buf.slice(i);
  }

  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  function normalizeOrder(order) {
    const price = Array.isArray(order) ? toNumber(order[0]) : toNumber(order?.price);
    const size  = Array.isArray(order) ? toNumber(order[1]) : toNumber(order?.amount ?? order?.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) return null;
    return { price, size };
  }

  function sanitizeBook(rawBids, rawAsks) {
    const bids = (Array.isArray(rawBids) ? rawBids : [])
      .map(normalizeOrder)
      .filter(Boolean)
      .sort((a, b) => b.price - a.price)
      .slice(0, MAX_LEVELS);

    const asks = (Array.isArray(rawAsks) ? rawAsks : [])
      .map(normalizeOrder)
      .filter(Boolean)
      .sort((a, b) => a.price - b.price)
      .slice(0, MAX_LEVELS);

    if (!bids.length || !asks.length) return null;
    if (bids[0].price >= asks[0].price) return null; // crossed book
    return { bids, asks };
  }

  function marginalPrice(levels, volumeNeeded) {
    let cum = 0;
    for (let i = 0; i < levels.length; i++) {
      cum += levels[i].size;
      if (cum >= volumeNeeded) return levels[i].price;
    }
    return null;
  }

  function buildConsolidatedOrderBook(books) {
    const bidMap = new Map();
    const askMap = new Map();

    for (const book of books) {
      for (const bid of book.bids) {
        const key = bid.price;
        bidMap.set(key, (bidMap.get(key) || 0) + bid.size);
      }
      for (const ask of book.asks) {
        const key = ask.price;
        askMap.set(key, (askMap.get(key) || 0) + ask.size);
      }
    }

    const uncappedBids = [...bidMap.entries()]
      .map(([k, size]) => ({ price: k, size }))
      .sort((a, b) => b.price - a.price);
    const uncappedAsks = [...askMap.entries()]
      .map(([k, size]) => ({ price: k, size }))
      .sort((a, b) => a.price - b.price);

    if (!uncappedBids.length || !uncappedAsks.length || uncappedBids[0].price >= uncappedAsks[0].price) {
      return null;
    }

    const orderSizeCap = computeDynamicOrderSizeCap(uncappedBids, uncappedAsks);
    const bids = uncappedBids.map(level => ({ price: level.price, size: Math.min(level.size, orderSizeCap) }));
    const asks = uncappedAsks.map(level => ({ price: level.price, size: Math.min(level.size, orderSizeCap) }));
    return { bids, asks, orderSizeCap };
  }

  function computeDynamicOrderSizeCap(bids, asks) {
    if (!bids.length || !asks.length) return 1;
    const bestAsk = asks[0].price;
    const bestBid = bids[0].price;

    const askSample = asks.filter(level => level.price <= bestAsk * 1.05).slice(0, 50);
    const bidSample = bids.filter(level => level.price >= bestBid * 0.95).slice(0, 50);
    const sizes = [...askSample.map(x => x.size), ...bidSample.map(x => x.size)].sort((a, b) => a - b);
    if (!sizes.length) return Math.max(asks[0].size, bids[0].size, 1);

    const n = sizes.length;
    const k = Math.floor(0.01 * n);
    const lo = Math.min(k, n - 1);
    const hi = Math.max(lo, n - 1 - k);

    const trimmed = sizes.slice(lo, hi + 1);
    const trimmedMean = mean(trimmed) ?? mean(sizes) ?? 1;

    const winsorized = sizes.map((v, i) => {
      if (i < lo) return sizes[lo];
      if (i > hi) return sizes[hi];
      return v;
    });
    const winsorizedMean = mean(winsorized) ?? trimmedMean;
    const sigma = sampleStdDev(winsorized, winsorizedMean);
    const cap = winsorizedMean + (5 * sigma);
    return Number.isFinite(cap) && cap > 0 ? cap : Math.max(trimmedMean, 1);
  }

  function computeRtiFromBooks(sym, includedBooks, calcTs) {
    const params = RTI_PARAMS[sym];
    const consolidated = buildConsolidatedOrderBook(includedBooks);
    if (!consolidated) return null;

    const { bids, asks, orderSizeCap } = consolidated;
    const spacing = params.spacing;
    const spreadDeviation = params.spreadDeviation;
    const totalBid = bids.reduce((s, l) => s + l.size, 0);
    const totalAsk = asks.reduce((s, l) => s + l.size, 0);
    const maxVolume = Math.floor(Math.min(totalBid, totalAsk) / spacing) * spacing;
    if (!Number.isFinite(maxVolume) || maxVolume < spacing) return null;

    const points = [];
    for (let v = spacing; v <= maxVolume; v += spacing) {
      const bidPV = marginalPrice(bids, v);
      const askPV = marginalPrice(asks, v);
      if (!Number.isFinite(bidPV) || !Number.isFinite(askPV)) break;
      const midPV = (bidPV + askPV) / 2;
      if (!Number.isFinite(midPV) || midPV <= 0) break;
      const midSpread = (askPV / midPV) - 1;
      points.push({ volume: v, bidPV, askPV, midPV, midSpread });
    }
    if (!points.length) return null;

    let utilizedDepth = spacing;
    for (const point of points) {
      if (point.midSpread <= spreadDeviation) utilizedDepth = point.volume;
      else break;
    }
    utilizedDepth = Math.max(spacing, Math.min(utilizedDepth, points[points.length - 1].volume));

    const weightedPoints = points.filter(p => p.volume <= utilizedDepth);
    if (!weightedPoints.length) return null;

    const lambda = 1 / (0.3 * utilizedDepth);
    const weights = weightedPoints.map(p => lambda * Math.exp(-lambda * p.volume));
    const norm = weights.reduce((s, w) => s + w, 0);
    if (!Number.isFinite(norm) || norm <= 0) return null;

    let rti = 0;
    for (let i = 0; i < weightedPoints.length; i++) {
      rti += weightedPoints[i].midPV * (weights[i] / norm);
    }
    if (!Number.isFinite(rti) || rti <= 0) return null;

    return {
      price: rti,
      meta: {
        calcTs,
        spacing,
        spreadDeviation,
        potentiallyErroneousParam: params.potentiallyErroneousParam,
        orderSizeCap,
        utilizedDepth,
        lambda,
        exchangeCount: includedBooks.length,
      },
    };
  }

  function applyPotentiallyErroneousFilter(sym, books) {
    const mids = books.map(b => b.mid).filter(v => Number.isFinite(v) && v > 0);
    const medianMid = median(mids);
    if (!Number.isFinite(medianMid) || medianMid <= 0) return { included: [], excluded: {}, medianMid: null };

    const threshold = RTI_PARAMS[sym].potentiallyErroneousParam;
    const reinstateThreshold = threshold * 0.5;
    const included = [];
    const excluded = {};

    for (const book of books) {
      const deviation = Math.abs((book.mid - medianMid) / medianMid);
      const latched = !!_outlierLatch[sym][book.exchange];
      if (latched) {
        if (deviation < reinstateThreshold) {
          _outlierLatch[sym][book.exchange] = false;
          included.push({ ...book, deviation });
        } else {
          excluded[book.exchange] = { reason: 'potentially_erroneous_latched', deviation };
        }
      } else if (deviation > threshold) {
        _outlierLatch[sym][book.exchange] = true;
        excluded[book.exchange] = { reason: 'potentially_erroneous', deviation };
      } else {
        included.push({ ...book, deviation });
      }
    }

    return { included, excluded, medianMid };
  }

  // Get the open_time and close_time of the current active 15m Kalshi window for sym.
  // Falls back to floor-of-15m bucket if PredictionMarkets unavailable.
  function getContractWindow(sym) {
    try {
      const k15m = window.PredictionMarkets?.getCoin(sym)?.kalshi15m;
      if (k15m?.openTime && k15m?.closeTime) {
        return {
          openMs:  new Date(k15m.openTime).getTime(),
          closeMs: new Date(k15m.closeTime).getTime(),
        };
      }
    } catch (_) {}
    // Fallback: snap to 15m floor
    const now = Date.now();
    const bucket = Math.floor(now / 900_000) * 900_000;
    return { openMs: bucket, closeMs: bucket + 900_000 };
  }

  function getAdaptivePollMs() {
    const now = Date.now();
    for (const sym of SUPPORTED_SYMS) {
      const win = getContractWindow(sym);
      if (!win) continue;
      if (Math.abs(now - win.openMs) <= NEAR_BOUNDARY_MS) return RTI_POLL_MS_NEAR;
      if (Math.abs(now - win.closeMs) <= NEAR_BOUNDARY_MS) return RTI_POLL_MS_NEAR;
    }
    return RTI_POLL_MS_BASE;
  }

  // ── Fetch from a single exchange ───────────────────────────────────

  async function fetchExchangeBook(exName, sym) {
    const cfg = EXCHANGE_CONFIG[exName];
    const pair = cfg.pairs[sym];
    if (!pair) return null;

    const fetchFn = window.throttledFetch ?? window.proxyFetch ?? fetch;
    try {
      const resp = await fetchFn(cfg.url(pair), {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(EXCHANGE_FETCH_TIMEOUT_MS) : undefined,
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const parsed = cfg.parse(data, pair);
      if (!parsed) return null;
      const cleaned = sanitizeBook(parsed.bids, parsed.asks);
      if (!cleaned) return null;
      return {
        exchange: exName,
        retrievalTs: Date.now(),
        bids: cleaned.bids,
        asks: cleaned.asks,
        bestBid: cleaned.bids[0].price,
        bestAsk: cleaned.asks[0].price,
        mid: (cleaned.bids[0].price + cleaned.asks[0].price) / 2,
      };
    } catch (_) {
      return null;
    }
  }

  // ── Poll all exchanges for one symbol ─────────────────────────────

  async function pollSym(sym) {
    const now = Date.now();
    const excluded = {};

    const results = await Promise.allSettled(
      EXCHANGE_NAMES.map(ex => fetchExchangeBook(ex, sym))
    );

    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value != null) {
        _lastBooks[sym][EXCHANGE_NAMES[i]] = r.value;
      }
    });

    const candidateBooks = [];
    for (const ex of EXCHANGE_NAMES) {
      const book = _lastBooks[sym][ex];
      if (!book) {
        _latestMids[sym][ex] = null;
        excluded[ex] = { reason: 'no_book' };
        continue;
      }
      const ageMs = now - book.retrievalTs;
      if (ageMs > STALE_MS) {
        _latestMids[sym][ex] = null;
        excluded[ex] = { reason: 'delayed_data', ageMs };
        continue;
      }
      _latestMids[sym][ex] = book.mid;
      if (!book.bids.length || !book.asks.length || book.bestBid >= book.bestAsk) {
        excluded[ex] = { reason: 'erroneous_book' };
        continue;
      }
      candidateBooks.push(book);
    }

    const { included, excluded: outlierExcluded, medianMid } = applyPotentiallyErroneousFilter(sym, candidateBooks);
    Object.assign(excluded, outlierExcluded);

    const computed = included.length ? computeRtiFromBooks(sym, included, now) : null;
    if (!computed || !Number.isFinite(computed.price) || computed.price <= 0) {
      const prior = window._rtiPrices[sym];
      if (prior) {
        window._rtiPrices[sym] = {
          ...prior,
          exchanges: { ..._latestMids[sym] },
          stale: now - prior.ts > STALE_MS,
          meta: {
            ...(prior.meta || {}),
            calcFailed: true,
            calcFailureTs: now,
            excluded,
            includedExchanges: included.map(b => b.exchange),
            medianMid,
          },
        };
      }
      return;
    }

    const rti = computed.price;
    _buffer[sym].push({ ts: now, rti });
    pruneBuffer(sym);

    // Compute settlement window averages
    const win = getContractWindow(sym);
    const openWindowStart  = win.openMs - SETTLE_WINDOW;
    const openWindowEnd    = win.openMs;
    const closeWindowStart = win.closeMs - SETTLE_WINDOW;
    const closeWindowEnd   = win.closeMs;

    const openAvg  = bufferAvg(sym, openWindowStart, openWindowEnd);
    const closeAvg = bufferAvg(sym, closeWindowStart, Math.min(closeWindowEnd, now));

    let delta    = null;
    let deltaDir = null;
    let deltaPct = null;
    if (openAvg != null && closeAvg != null) {
      delta    = closeAvg - openAvg;
      deltaPct = (delta / openAvg) * 100;
      deltaDir = Math.abs(deltaPct) < 0.005 ? 'FLAT' : delta > 0 ? 'UP' : 'DOWN';
    }

    const includedExchanges = included.map(b => b.exchange);
    window._rtiPrices[sym] = {
      price:     rti,
      openAvg,
      closeAvg,
      delta,
      deltaDir,
      deltaPct,
      exchanges: { ..._latestMids[sym] },
      stale:     false,
      ts:        now,
      meta: {
        ...computed.meta,
        calcFailed: false,
        includedExchanges,
        excluded,
        medianMid,
      },
    };
  }

  // ── Mark stale entries ─────────────────────────────────────────────

  function markStale() {
    const cutoff = Date.now() - STALE_MS;
    for (const sym of SUPPORTED_SYMS) {
      const r = window._rtiPrices[sym];
      if (r && r.ts < cutoff) r.stale = true;
    }
  }

  // ── Poll cycle ─────────────────────────────────────────────────────

  let _pollTimer = null;
  let _running = false;
  let _stopped = false;

  async function runPollCycle() {
    await Promise.allSettled(SUPPORTED_SYMS.map(sym => pollSym(sym)));
    markStale();
    if (!_running || _stopped) return;
    const delay = getAdaptivePollMs();
    _pollTimer = setTimeout(runPollCycle, delay);
  }

  function clearTimer() {
    if (_pollTimer) {
      clearTimeout(_pollTimer);
      _pollTimer = null;
    }
  }

  function start() {
    if (_running) return;
    _running = true;
    _stopped = false;
    runPollCycle();
    console.log('[RTIFeed] Started — CME CF RTI methodology engine (order-book based)');
  }

  function stop() {
    _stopped = true;
    _running = false;
    clearTimer();
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Get the current RTI price for a symbol.
   * Returns null if no data or stale.
   */
  function getPrice(sym) {
    const r = window._rtiPrices[sym?.toUpperCase()];
    return r && !r.stale ? r.price : null;
  }

  /**
   * Get RTI data object for a symbol.
   */
  function getData(sym) {
    return window._rtiPrices[sym?.toUpperCase()] ?? null;
  }

  /**
   * Get the basis (RTI price - Coinbase price) in pct.
   * Positive = RTI is above Coinbase. Negative = RTI below Coinbase.
   */
  function getBasis(sym) {
    const r = window._rtiPrices[sym?.toUpperCase()];
    if (!r || r.stale || r.exchanges.coinbase == null) return null;
    return ((r.price - r.exchanges.coinbase) / r.exchanges.coinbase) * 100;
  }

  window.RTIFeed = { start, stop, getPrice, getData, getBasis };

  // Auto-start after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

})();
