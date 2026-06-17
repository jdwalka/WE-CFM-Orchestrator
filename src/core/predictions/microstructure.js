// ================================================================
// WE|||CRYPTO — Live Microstructure Engine
// Orbital shell: order-book and trade-flow execution context.
// ================================================================

(function () {
  'use strict';

  const LIVE_BOOK_TTL_MS = 2500;
  const LIVE_BOOK_REPRICE_MIN_MS = 2500;
  const LIVE_BOOK_CLOSE_REPRICE_MIN_MS = 1200;
  const LIVE_BOOK_REPRICE_MIN_ABS_IMBALANCE = 0.18;
  const LIVE_BOOK_REPRICE_DELTA = 0.06;
  const _liveMicroState = {};

  const runtime = {
    getCandleCache: () => null,
    getPredictionCoins: () => [],
    getPredictions: () => (window._predictions || {}),
    getBacktests: () => (window._backtests || {}),
    setPrediction: (sym, prediction) => {
      window._predictions = window._predictions || {};
      window._predictions[sym] = prediction;
    },
    computePrediction: null,
    preservePredictionOverlay: (previousPrediction, nextPrediction) => nextPrediction || previousPrediction,
  };

  function configure(nextRuntime = {}) {
    Object.assign(runtime, nextRuntime);
  }

  function cloneForSnapshot(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeBookLevel(level) {
    if (!level) return null;
    const price = Array.isArray(level)
      ? Number(level[0])
      : Number(level.price ?? level.px ?? level.p ?? level[0]);
    const qty = Array.isArray(level)
      ? Number(level[1])
      : Number(level.qty ?? level.size ?? level.sz ?? level.q ?? level[1]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) return null;
    return { price, qty };
  }

  function normalizeBookForModel(book, source = null) {
    if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return null;
    const bids = book.bids.map(normalizeBookLevel).filter(Boolean).sort((a, b) => b.price - a.price);
    const asks = book.asks.map(normalizeBookLevel).filter(Boolean).sort((a, b) => a.price - b.price);
    if (!bids.length || !asks.length) return null;
    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const mid = Number.isFinite(Number(book.mid)) && Number(book.mid) > 0
      ? Number(book.mid)
      : (bestBid + bestAsk) / 2;
    const spread = Number.isFinite(Number(book.spread)) ? Number(book.spread) : (bestAsk - bestBid);
    return {
      bids,
      asks,
      mid,
      spread,
      spreadPct: Number.isFinite(Number(book.spreadPct))
        ? Number(book.spreadPct)
        : (mid > 0 ? (spread / mid) * 100 : 0),
      source: source || book.source || 'book',
      timestamp: Number(book.timestamp || book.ts || Date.now()),
      balance: book.balance || book.depthMetrics || null,
    };
  }

  function analyzeBook(book) {
    const normalized = normalizeBookForModel(book, book?.source || 'book');
    if (!normalized) return { imbalance: 0, bidTotal: 0, askTotal: 0, bidWall: 0, askWall: 0, spread: 0, label: 'No data', source: book?.source || null, timestamp: book?.timestamp || null };
    const bidTotal = normalized.bids.reduce((s, b) => s + parseFloat(b.qty), 0);
    const askTotal = normalized.asks.reduce((s, a) => s + parseFloat(a.qty), 0);
    const total = bidTotal + askTotal || 1;
    const rawImbalance = (bidTotal - askTotal) / total;
    const weightedImbalance = normalized.balance?.weighted?.blendImbalance;
    const imbalance = Number.isFinite(Number(weightedImbalance)) ? Number(weightedImbalance) : rawImbalance;
    const bestBid = parseFloat(normalized.bids[0]?.price || 0);
    const bestAsk = parseFloat(normalized.asks[0]?.price || 0);
    const spread = bestAsk > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;
    const bidMax = Math.max(...normalized.bids.map(b => parseFloat(b.qty)));
    const askMax = Math.max(...normalized.asks.map(a => parseFloat(a.qty)));
    const bidWall = bidMax / (bidTotal || 1);
    const askWall = askMax / (askTotal || 1);

    let label = 'Balanced';
    if (imbalance > 0.3) label = 'Bid Heavy — Support Below';
    else if (imbalance < -0.3) label = 'Ask Heavy — Resistance Above';
    if (bidWall > 0.4) label += ' (bid wall)';
    if (askWall > 0.4) label += ' (ask wall)';

    return { imbalance, rawImbalance, bidTotal, askTotal, bidWall, askWall, spread, label, source: normalized.source, timestamp: normalized.timestamp, balance: normalized.balance };
  }

  function getFreshLiveBook(sym, ttlMs = LIVE_BOOK_TTL_MS) {
    const key = String(sym || '').toUpperCase();
    const st = _liveMicroState[key];
    if (st?.book && Date.now() - (st.book.timestamp || 0) <= ttlMs) return st.book;
    const obBook = window.OB?.getFreshBook?.(key, ttlMs)
      || ((window.OB?.books?.[key] && Date.now() - (window.OB.books[key].timestamp || 0) <= ttlMs)
        ? window.OB.books[key]
        : null);
    const normalized = normalizeBookForModel(obBook, obBook?.source || 'orderbook-ws');
    if (normalized) {
      updateLiveOrderBook(key, normalized, { source: normalized.source, silent: true });
      return normalized;
    }
    return null;
  }

  function resolveFreshOrderBook(sym, fallbackBook) {
    const liveBook = getFreshLiveBook(sym);
    if (liveBook) return liveBook;
    return normalizeBookForModel(fallbackBook, fallbackBook?.source || 'rest-book');
  }

  function updateLiveOrderBook(sym, rawBook, meta = {}) {
    const key = String(sym || '').toUpperCase();
    if (!key) return null;
    const book = normalizeBookForModel(rawBook, meta.source || rawBook?.source || 'orderbook-ws');
    if (!book) return null;
    const analysis = analyzeBook(book);
    const state = _liveMicroState[key] || {};
    _liveMicroState[key] = {
      ...state,
      book,
      balance: meta.balance || book.balance || state.balance || null,
      lastUpdateTs: Date.now(),
      lastImbalance: analysis.imbalance,
      lastLabel: analysis.label,
    };
    const cache = runtime.getCandleCache(key);
    if (cache) cache._liveBook = book;
    if (!meta.silent) {
      try {
        window.dispatchEvent(new CustomEvent('prediction:live-book', {
          detail: { sym: key, book, analysis },
        }));
      } catch (_) { }
    }
    return { book, analysis };
  }

  function getSecsToKalshiClose(sym) {
    const close = window.PredictionMarkets?.getCoin?.(sym)?.kalshi15m?.closeTime;
    if (!close) return null;
    const ms = new Date(close).getTime() - Date.now();
    return Number.isFinite(ms) ? ms / 1000 : null;
  }

  function shouldRepriceForLiveBook(sym, analysis, opts = {}) {
    const key = String(sym || '').toUpperCase();
    const state = _liveMicroState[key] || {};
    const now = Date.now();
    const secsLeft = getSecsToKalshiClose(key);
    const closeValueWindow = Number.isFinite(secsLeft) && secsLeft <= 210 && secsLeft >= 45;
    const minGap = closeValueWindow ? LIVE_BOOK_CLOSE_REPRICE_MIN_MS : LIVE_BOOK_REPRICE_MIN_MS;
    const absImb = Math.abs(Number(analysis?.imbalance || 0));
    const delta = Math.abs((Number(analysis?.imbalance || 0)) - (Number(state.lastRepriceImbalance || 0)));
    if (opts.force) return true;
    if (now - (state.lastRepriceTs || 0) < minGap && delta < LIVE_BOOK_REPRICE_DELTA) return false;
    return closeValueWindow || absImb >= LIVE_BOOK_REPRICE_MIN_ABS_IMBALANCE || delta >= LIVE_BOOK_REPRICE_DELTA;
  }

  function rescoreLiveMicrostructure(sym, opts = {}) {
    const key = String(sym || '').toUpperCase();
    const configuredCoins = runtime.getPredictionCoins();
    const coin = configuredCoins.find(c => c?.sym === key);
    const cache = runtime.getCandleCache(key);
    if (!coin || !cache?.candles15m?.length || typeof runtime.computePrediction !== 'function') return null;
    const book = resolveFreshOrderBook(key, cache.book);
    if (!book) return null;
    const analysis = analyzeBook(book);
    if (!shouldRepriceForLiveBook(key, analysis, opts)) return null;
    const predictions = runtime.getPredictions();
    const backtests = runtime.getBacktests();
    const prediction = runtime.preservePredictionOverlay(
      predictions[key],
      runtime.computePrediction(coin, backtests[key] || null)
    );
    runtime.setPrediction(key, prediction);
    const state = _liveMicroState[key] || {};
    _liveMicroState[key] = {
      ...state,
      lastRepriceTs: Date.now(),
      lastRepriceImbalance: analysis.imbalance,
      lastRepriceReason: opts.reason || 'live-book',
    };
    try {
      window.dispatchEvent(new CustomEvent('predictions:microstructure-updated', {
        detail: { sym: key, prediction, bookAnalysis: analysis, reason: opts.reason || 'live-book' },
      }));
    } catch (_) { }
    return prediction;
  }

  function detectWallAbsorption(candles1m) {
    if (!candles1m || candles1m.length < 6) return { detected: false, dir: 0, strength: 0 };
    const c = candles1m.slice(-16);
    let rangeSum = 0;
    for (let i = 0; i < c.length; i++) rangeSum += (c[i].h - c[i].l);
    const avgRange = rangeSum / c.length || 0.0001;

    let wallDetected = false;
    let wallDir = 0;
    let wallStrength = 0;

    for (let i = Math.max(1, c.length - 6); i < c.length; i++) {
      const bar = c[i];
      const body = Math.abs(bar.c - bar.o);
      const range = bar.h - bar.l || 0.0001;
      const lowerWick = Math.min(bar.o, bar.c) - bar.l;
      const upperWick = bar.h - Math.max(bar.o, bar.c);
      if (range < avgRange * 1.1) continue;
      if (lowerWick >= body * 2 && lowerWick >= avgRange * 1.4 && (lowerWick / range) > 0.38) {
        const strength = Math.min(1, (lowerWick / range) * 1.6);
        if (strength > wallStrength) { wallDetected = true; wallDir = 1; wallStrength = strength; }
      }
      if (upperWick >= body * 2 && upperWick >= avgRange * 1.4 && (upperWick / range) > 0.38) {
        const strength = Math.min(1, (upperWick / range) * 1.6);
        if (strength > wallStrength) { wallDetected = true; wallDir = -1; wallStrength = strength; }
      }
    }

    if (!wallDetected && c.length >= 8) {
      const last10 = c.slice(-10);
      const lows = last10.map(b => b.l);
      const highs = last10.map(b => b.h);
      const minLow = Math.min(...lows);
      const maxHigh = Math.max(...highs);
      const bidTests = lows.filter(l => Math.abs(l - minLow) / (minLow || 1) < 0.0006).length;
      const askTests = highs.filter(h => Math.abs(h - maxHigh) / (maxHigh || 1) < 0.0006).length;
      const lastBar = c[c.length - 1];
      if (bidTests >= 2 && lastBar.c >= lastBar.o) {
        wallDetected = true; wallDir = 1; wallStrength = Math.min(0.75, bidTests * 0.28);
      } else if (askTests >= 2 && lastBar.c <= lastBar.o) {
        wallDetected = true; wallDir = -1; wallStrength = Math.min(0.75, askTests * 0.28);
      }
    }
    return { detected: wallDetected, dir: wallDir, strength: wallStrength };
  }

  function classifyBookLiquidity(book) {
    if (!book) return { state: 'unknown', score: 0.5, label: 'Book unavailable' };
    if (book.spread >= 0.18 || (book.bidTotal + book.askTotal) < 1) {
      return { state: 'thin', score: 0.25, label: 'Thin book / wide spread' };
    }
    if (book.spread <= 0.04 && Math.abs(book.imbalance || 0) < 0.2) {
      return { state: 'balanced', score: 0.85, label: 'Tight balanced book' };
    }
    return { state: 'normal', score: 0.65, label: 'Normal book depth' };
  }

  function getLiveMicrostructure(sym) {
    const key = String(sym || '').toUpperCase();
    const state = _liveMicroState[key] || null;
    return cloneForSnapshot(state);
  }

  window.PredictionMicrostructure = {
    configure,
    getFreshLiveBook,
    resolveFreshOrderBook,
    updateLiveOrderBook,
    shouldRepriceForLiveBook,
    rescoreLiveMicrostructure,
    analyzeBook,
    detectWallAbsorption,
    classifyBookLiquidity,
    getLiveMicrostructure,
    normalizeBookForModel,
  };
})();
