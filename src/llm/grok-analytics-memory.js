/**
 * Grok Analytics Memory — session accumulator for xAI range prediction.
 *
 * While the app is open, samples multi-timeframe market state for BTC/ETH/SOL/XRP
 * and builds a growing memory pack. The longer the session runs, the denser the
 * sample trail, resolved 15m/1h window outcomes, and scored Grok predictions.
 *
 * Exposed as window.GrokAnalyticsMemory
 */
(function () {
  'use strict';

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
  const SAMPLE_MS = 20_000;
  const MAX_SAMPLES_PER_COIN = 2_400; // ~13h at 20s
  const MAX_WINDOWS_PER_COIN = 120;
  const MAX_PREDS_PER_HORIZON = 80;
  const STORAGE_KEY = 'wecrypto_grok_analytics_v1';

  const _state = {
    sessionStartedAt: Date.now(),
    samples: Object.fromEntries(COINS.map((c) => [c, []])),
    windows15m: Object.fromEntries(COINS.map((c) => [c, []])),
    windows1h: Object.fromEntries(COINS.map((c) => [c, []])),
    open15m: Object.fromEntries(COINS.map((c) => [c, null])),
    open1h: Object.fromEntries(COINS.map((c) => [c, null])),
    predictions: Object.fromEntries(COINS.map((c) => [c, { '15m': [], '60m': [] }])),
    lastSampleTs: 0,
    sampleTicks: 0,
  };

  let _timer = null;

  function floorWindow(ts, ms) {
    return Math.floor(ts / ms) * ms;
  }

  function resolvePrice(coin) {
    try {
      if (window.PredictionMarkets && typeof window.PredictionMarkets.getPrice === 'function') {
        const p = Number(window.PredictionMarkets.getPrice(coin));
        if (p > 0) return p;
      }
    } catch (_) {}
    try {
      const pm = window.PredictionMarkets && window.PredictionMarkets.state;
      const row = pm && (pm[coin] || pm[coin.toLowerCase()]);
      if (row) {
        const cands = [
          row.currentPrice, row.price, row.last,
          row.poly5m && row.poly5m.currentPrice,
          row.poly15m && row.poly15m.currentPrice,
        ];
        for (const c of cands) {
          const n = Number(c);
          if (n > 0) return n;
        }
      }
    } catch (_) {}
    try {
      if (window._pythPrices && window._pythPrices[coin] > 0) return Number(window._pythPrices[coin]);
    } catch (_) {}
    try {
      if (window.latestPrices && window.latestPrices[coin] > 0) return Number(window.latestPrices[coin]);
    } catch (_) {}
    return null;
  }

  function resolvePred(coin) {
    try {
      if (window.Predictions && window.Predictions[coin]) return window.Predictions[coin];
      if (window.predictionEngine && window.predictionEngine.get) {
        return window.predictionEngine.get(coin);
      }
    } catch (_) {}
    return null;
  }

  function resolveMarket(coin) {
    try {
      if (window.PredictionMarkets && window.PredictionMarkets.getMarket) {
        return window.PredictionMarkets.getMarket(coin);
      }
      const st = window.PredictionMarkets && window.PredictionMarkets.state;
      return (st && st[coin]) || null;
    } catch (_) {}
    return null;
  }

  function sampleCoin(coin, now) {
    const price = resolvePrice(coin);
    if (!(price > 0)) return null;
    const pred = resolvePred(coin) || {};
    const market = resolveMarket(coin) || {};
    const k15 = market.kalshi15m || market['15m'] || {};
    const poly15 = market.poly15m || market.poly || {};
    const poly5 = market.poly5m || {};
    let xSent = null;
    try {
      if (window.SocialSentiment && window.SocialSentiment.getTrend) {
        xSent = window.SocialSentiment.getTrend(coin, 0.5);
      }
    } catch (_) {}
    let onChain = null;
    try {
      if (window.OnChainFlow && typeof window.OnChainFlow.packetForGrok === 'function') {
        onChain = window.OnChainFlow.packetForGrok(coin);
      }
    } catch (_) {}

    return {
      ts: now,
      price,
      direction: pred.direction || pred.signal || null,
      confidence: pred.confidence != null ? Number(pred.confidence) : null,
      regime: pred.regime || null,
      poly5Up: poly5.upProb ?? poly5.probability ?? null,
      poly15Up: poly15.probability ?? k15.probability ?? null,
      ptb5: Number(poly5.priceToBeatNum || poly5.targetPriceNum) || null,
      xScore: xSent && xSent.score != null ? Number(xSent.score) : null,
      onChainLean: onChain && (onChain.lean || onChain.netBias || onChain.side) || null,
    };
  }

  function pushCapped(arr, item, max) {
    arr.push(item);
    if (arr.length > max) arr.splice(0, arr.length - max);
  }

  function updateOpenWindow(bucketMap, openMap, coin, now, price, windowMs) {
    const start = floorWindow(now, windowMs);
    let open = openMap[coin];
    if (!open || open.start !== start) {
      if (open && open.open > 0) {
        const closed = {
          start: open.start,
          end: open.start + windowMs,
          o: open.open,
          h: open.high,
          l: open.low,
          c: open.close,
          rangePct: open.open > 0 ? ((open.high - open.low) / open.open) * 100 : null,
          direction: open.close >= open.open ? 'UP' : 'DOWN',
          sampleCount: open.sampleCount || 0,
        };
        pushCapped(bucketMap[coin], closed, MAX_WINDOWS_PER_COIN);
        _scorePredictions(coin, windowMs, closed);
      }
      openMap[coin] = {
        start,
        open: price,
        high: price,
        low: price,
        close: price,
        sampleCount: 1,
      };
      return;
    }
    open.high = Math.max(open.high, price);
    open.low = Math.min(open.low, price);
    open.close = price;
    open.sampleCount = (open.sampleCount || 0) + 1;
  }

  function _scorePredictions(coin, windowMs, closed) {
    const key = windowMs === 15 * 60_000 ? '15m' : windowMs === 60 * 60_000 ? '60m' : null;
    if (!key) return;
    const preds = _state.predictions[coin][key] || [];
    for (const p of preds) {
      if (p.scored) continue;
      if (p.windowStart !== closed.start) continue;
      p.scored = true;
      p.actualDirection = closed.direction;
      p.actualRangePct = closed.rangePct;
      p.actualClose = closed.c;
      const call = String(p.call || p.direction || '').toUpperCase();
      if (call === 'UP' || call === 'DOWN') {
        p.correct = call === closed.direction;
      } else if (call === 'RANGE' || call === 'WAIT') {
        p.correct = closed.rangePct != null && closed.rangePct < (Number(p.expectedWidthPct) || 0.4);
      } else {
        p.correct = null;
      }
    }
  }

  function tick() {
    const now = Date.now();
    _state.sampleTicks += 1;
    _state.lastSampleTs = now;
    for (const coin of COINS) {
      const s = sampleCoin(coin, now);
      if (!s) continue;
      pushCapped(_state.samples[coin], s, MAX_SAMPLES_PER_COIN);
      updateOpenWindow(_state.windows15m, _state.open15m, coin, now, s.price, 15 * 60_000);
      updateOpenWindow(_state.windows1h, _state.open1h, coin, now, s.price, 60 * 60_000);
    }
    if (_state.sampleTicks % 15 === 0) _persistLight();
  }

  function _persistLight() {
    try {
      const slim = {
        sessionStartedAt: _state.sessionStartedAt,
        lastSampleTs: _state.lastSampleTs,
        sampleTicks: _state.sampleTicks,
        // keep last N samples + windows only
        samples: {},
        windows15m: {},
        windows1h: {},
        predictions: _state.predictions,
      };
      for (const c of COINS) {
        slim.samples[c] = (_state.samples[c] || []).slice(-120);
        slim.windows15m[c] = (_state.windows15m[c] || []).slice(-48);
        slim.windows1h[c] = (_state.windows1h[c] || []).slice(-24);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch (_) {}
  }

  function _hydrate() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const slim = JSON.parse(raw);
      if (!slim || typeof slim !== 'object') return;
      // Keep a new session clock but seed history from prior runs
      for (const c of COINS) {
        if (Array.isArray(slim.samples && slim.samples[c])) {
          _state.samples[c] = slim.samples[c].slice(-MAX_SAMPLES_PER_COIN);
        }
        if (Array.isArray(slim.windows15m && slim.windows15m[c])) {
          _state.windows15m[c] = slim.windows15m[c].slice(-MAX_WINDOWS_PER_COIN);
        }
        if (Array.isArray(slim.windows1h && slim.windows1h[c])) {
          _state.windows1h[c] = slim.windows1h[c].slice(-MAX_WINDOWS_PER_COIN);
        }
        if (slim.predictions && slim.predictions[c]) {
          _state.predictions[c] = slim.predictions[c];
        }
      }
      _state.sampleTicks = Number(slim.sampleTicks) || _state.sampleTicks;
    } catch (_) {}
  }

  function sessionMinutes() {
    return Math.max(0, (Date.now() - _state.sessionStartedAt) / 60_000);
  }

  function summarizeWindows(list) {
    if (!list || !list.length) return { n: 0 };
    const n = list.length;
    const ranges = list.map((w) => w.rangePct).filter((x) => Number.isFinite(x));
    const ups = list.filter((w) => w.direction === 'UP').length;
    const avgRange = ranges.length
      ? ranges.reduce((a, b) => a + b, 0) / ranges.length
      : null;
    const last = list[list.length - 1];
    return {
      n,
      avgRangePct: avgRange != null ? Number(avgRange.toFixed(4)) : null,
      upRate: n ? ups / n : null,
      last: last ? {
        direction: last.direction,
        rangePct: last.rangePct,
        o: last.o,
        h: last.h,
        l: last.l,
        c: last.c,
      } : null,
    };
  }

  function predictionAccuracy(coin, horizonKey) {
    const rows = (_state.predictions[coin] && _state.predictions[coin][horizonKey]) || [];
    const scored = rows.filter((r) => r.scored && r.correct != null);
    if (!scored.length) return { n: 0, correct: 0, accuracy: null };
    const correct = scored.filter((r) => r.correct).length;
    return { n: scored.length, correct, accuracy: correct / scored.length };
  }

  function memoryPackForPrompt(coin) {
    const samples = _state.samples[coin] || [];
    const recent = samples.slice(-24);
    const w15 = _state.windows15m[coin] || [];
    const w60 = _state.windows1h[coin] || [];
    const open15 = _state.open15m[coin];
    const open60 = _state.open1h[coin];
    const priceTrail = recent.map((s) => ({
      t: s.ts,
      p: s.price,
      d: s.direction,
    }));
    let pathReturnPct = null;
    if (recent.length >= 2) {
      const a = recent[0].price;
      const b = recent[recent.length - 1].price;
      if (a > 0) pathReturnPct = ((b - a) / a) * 100;
    }
    return {
      coin,
      sessionMinutes: Number(sessionMinutes().toFixed(1)),
      sampleCount: samples.length,
      sampleTicks: _state.sampleTicks,
      pathReturnPct: pathReturnPct != null ? Number(pathReturnPct.toFixed(4)) : null,
      recentTrail: priceTrail,
      windows15m: summarizeWindows(w15),
      windows1h: summarizeWindows(w60),
      open15m: open15 ? {
        start: open15.start,
        o: open15.open,
        h: open15.high,
        l: open15.low,
        c: open15.close,
        samples: open15.sampleCount,
        ageSec: Math.round((Date.now() - open15.start) / 1000),
      } : null,
      open1h: open60 ? {
        start: open60.start,
        o: open60.open,
        h: open60.high,
        l: open60.low,
        c: open60.close,
        samples: open60.sampleCount,
        ageSec: Math.round((Date.now() - open60.start) / 1000),
      } : null,
      predAccuracy15m: predictionAccuracy(coin, '15m'),
      predAccuracy1h: predictionAccuracy(coin, '60m'),
      note: samples.length < 6
        ? 'Thin session memory — treat HTF bias cautiously until more samples accumulate.'
        : `Session memory is rich (${samples.length} samples over ${sessionMinutes().toFixed(0)}m). Prefer patterns that held across closed windows.`,
    };
  }

  function recordPrediction(coin, horizonMinutes, payload) {
    const key = horizonMinutes === 60 || horizonMinutes === 1 ? '60m' : '15m';
    const windowMs = key === '60m' ? 60 * 60_000 : 15 * 60_000;
    const windowStart = floorWindow(Date.now(), windowMs);
    const row = {
      ts: Date.now(),
      windowStart,
      horizonMinutes: key === '60m' ? 60 : 15,
      call: payload.call || payload.direction || 'WAIT',
      direction: payload.direction || payload.call || null,
      confidence: Number(payload.confidence) || 0,
      expectedWidthPct: payload.range && payload.range.widthPct != null
        ? Number(payload.range.widthPct)
        : (payload.expectedWidthPct != null ? Number(payload.expectedWidthPct) : null),
      rangeLow: payload.range && payload.range.low,
      rangeHigh: payload.range && payload.range.high,
      notes: (payload.suggestions && payload.suggestions.notes) || payload.notes || '',
      scored: false,
      correct: null,
    };
    if (!_state.predictions[coin]) _state.predictions[coin] = { '15m': [], '60m': [] };
    pushCapped(_state.predictions[coin][key], row, MAX_PREDS_PER_HORIZON);
    return row;
  }

  function getRangeGuidance(coin, horizonMinutes) {
    const key = horizonMinutes === 60 || horizonMinutes === 1 ? '60m' : '15m';
    const rows = (_state.predictions[coin] && _state.predictions[coin][key]) || [];
    const last = rows[rows.length - 1];
    if (!last) return null;
    if (Date.now() - last.ts > 20 * 60_000) return null;
    return last;
  }

  function getStats() {
    const byCoin = {};
    for (const c of COINS) {
      byCoin[c] = {
        samples: (_state.samples[c] || []).length,
        windows15m: (_state.windows15m[c] || []).length,
        windows1h: (_state.windows1h[c] || []).length,
        acc15: predictionAccuracy(c, '15m'),
        acc60: predictionAccuracy(c, '60m'),
      };
    }
    return {
      sessionStartedAt: _state.sessionStartedAt,
      sessionMinutes: Number(sessionMinutes().toFixed(1)),
      sampleTicks: _state.sampleTicks,
      lastSampleTs: _state.lastSampleTs,
      byCoin,
    };
  }

  function start() {
    if (_timer) return;
    _hydrate();
    tick();
    _timer = setInterval(tick, SAMPLE_MS);
    console.log('[GrokAnalyticsMemory] started — sampling every', SAMPLE_MS / 1000, 's for 15m/1h range intelligence');
  }

  function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
  }

  const api = {
    start,
    stop,
    tick,
    memoryPackForPrompt,
    recordPrediction,
    getRangeGuidance,
    getStats,
    COINS,
  };

  if (typeof window !== 'undefined') {
    window.GrokAnalyticsMemory = api;
    // Auto-start in Electron renderer
    if (window.electron || window.require) {
      setTimeout(() => {
        try { start(); } catch (e) {
          console.warn('[GrokAnalyticsMemory] start failed:', e && e.message);
        }
      }, 1500);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
