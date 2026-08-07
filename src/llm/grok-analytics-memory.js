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
  const PTB_WINDOW_MS = 5 * 60_000;
  const MAX_PTB_WINDOWS_PER_COIN = 288; // ~24h of 5-minute windows, local cache only
  const PTB_DEFENSE_TOLERANCE_FRAC = 0.0015; // 15bps — "same level" for defense-history lookups
  const PTB_DEFENSE_REFRESH_MS = 4 * 60_000;

  const _state = {
    sessionStartedAt: Date.now(),
    samples: Object.fromEntries(COINS.map((c) => [c, []])),
    windows15m: Object.fromEntries(COINS.map((c) => [c, []])),
    windows1h: Object.fromEntries(COINS.map((c) => [c, []])),
    open15m: Object.fromEntries(COINS.map((c) => [c, null])),
    open1h: Object.fromEntries(COINS.map((c) => [c, null])),
    windowsPTB5m: Object.fromEntries(COINS.map((c) => [c, []])),
    openPtb5m: Object.fromEntries(COINS.map((c) => [c, null])),
    predictions: Object.fromEntries(COINS.map((c) => [c, { '15m': [], '60m': [] }])),
    lastSampleTs: 0,
    sampleTicks: 0,
  };

  // Most recent PTB-defense stats fetched from Firestore (via the bridge),
  // keyed by coin. Populated opportunistically after each closed PTB window.
  const _ptbDefenseCache = {};

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

  function _sideOfPtb(price, ptb) {
    return price >= ptb ? 'UP' : 'DOWN';
  }

  function _bpsFromPtb(price, ptb) {
    return ptb > 0 ? ((price - ptb) / ptb) * 10_000 : null;
  }

  function _grokBridge() {
    try {
      return (typeof window !== 'undefined' && window._grokMemoryBridge) ? window._grokMemoryBridge : null;
    } catch (_) {
      return null;
    }
  }

  // Fetches (and caches) real PTB-defense history for a coin/level from
  // Firestore via the bridge. Best-effort, fire-and-forget — memoryPackForPrompt()
  // reads whatever is currently cached, never blocks on this.
  function refreshPtbDefenseStats(coin, ptb) {
    if (!(ptb > 0)) return;
    const bridge = _grokBridge();
    if (!bridge || typeof bridge.getPtbDefenseStats !== 'function') return;
    const cached = _ptbDefenseCache[coin];
    if (cached && cached.ptb === ptb && Date.now() - cached.fetchedAt < PTB_DEFENSE_REFRESH_MS) return;
    try {
      bridge.getPtbDefenseStats(coin, ptb).then((res) => {
        if (res && res.success && res.stats) {
          _ptbDefenseCache[coin] = { ...res.stats, ptb, fetchedAt: Date.now() };
        }
      }).catch(() => {});
    } catch (_) {}
  }

  // Tracks the fixed 5-minute Polymarket PTB window per coin: open/high/low/close
  // relative to the PTB (captured once at window open — it's immutable for the
  // window's lifetime), and whether the side it opened on survived to close
  // ("DEFENDED") or flipped ("BROKEN"). On close, records the outcome via the
  // bridge and refreshes the defense-stats cache for that level.
  function updatePtbWindow(coin, now, price, ptb) {
    if (!(price > 0)) return;
    const start = floorWindow(now, PTB_WINDOW_MS);
    const open = _state.openPtb5m[coin];

    if (!open || open.start !== start) {
      if (open && open.ptb > 0) {
        const sideOpen = _sideOfPtb(open.open, open.ptb);
        const sideClose = _sideOfPtb(open.close, open.ptb);
        const closed = {
          sym: coin,
          windowStart: open.start,
          windowEnd: open.start + PTB_WINDOW_MS,
          ptb: open.ptb,
          open: open.open,
          high: open.high,
          low: open.low,
          close: open.close,
          sideOpen,
          sideClose,
          outcome: sideOpen === sideClose ? 'DEFENDED' : 'BROKEN',
          distanceOpenBps: _bpsFromPtb(open.open, open.ptb),
          distanceCloseBps: _bpsFromPtb(open.close, open.ptb),
          crossCount: open.crossCount || 0,
          sampleCount: open.sampleCount || 0,
        };
        pushCapped(_state.windowsPTB5m[coin], closed, MAX_PTB_WINDOWS_PER_COIN);
        const bridge = _grokBridge();
        if (bridge && typeof bridge.pushPtbWindowClose === 'function') {
          try { bridge.pushPtbWindowClose(closed); } catch (_) {}
        }
        refreshPtbDefenseStats(coin, closed.ptb);
      }
      if (ptb > 0) {
        _state.openPtb5m[coin] = {
          start,
          ptb,
          open: price,
          high: price,
          low: price,
          close: price,
          sampleCount: 1,
          crossCount: 0,
          lastSide: _sideOfPtb(price, ptb),
        };
      } else {
        _state.openPtb5m[coin] = null;
      }
      return;
    }

    // Same window still open — use the PTB captured at window open (immutable
    // for the window's lifetime), not whatever value was just sampled.
    const side = _sideOfPtb(price, open.ptb);
    if (open.lastSide && side !== open.lastSide) open.crossCount = (open.crossCount || 0) + 1;
    open.lastSide = side;
    open.high = Math.max(open.high, price);
    open.low = Math.min(open.low, price);
    open.close = price;
    open.sampleCount = (open.sampleCount || 0) + 1;
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
      updatePtbWindow(coin, now, s.price, s.ptb5);
      const bridge = _grokBridge();
      if (bridge && typeof bridge.pushTick === 'function') {
        try { bridge.pushTick(coin, s); } catch (_) {}
      }
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

    // Fan out a durable per-coin snapshot to Firestore (via the bridge) so
    // sampleTicks/windows/prediction accuracy survive restarts, not just this
    // browser profile's localStorage. Best-effort, never blocks.
    try {
      const bridge = _grokBridge();
      if (bridge && typeof bridge.writeSessionSnapshot === 'function') {
        for (const c of COINS) {
          bridge.writeSessionSnapshot(c, {
            sessionStartedAt: _state.sessionStartedAt,
            lastSampleTs: _state.lastSampleTs,
            sampleTicks: _state.sampleTicks,
            sampleCount: (_state.samples[c] || []).length,
            windows15m: (_state.windows15m[c] || []).slice(-48),
            windows1h: (_state.windows1h[c] || []).slice(-24),
            predictions: _state.predictions[c] || { '15m': [], '60m': [] },
          });
        }
      }
    } catch (_) {}
  }

  function _hydrate() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const slim = JSON.parse(raw);
        if (slim && typeof slim === 'object') {
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
        }
      }
    } catch (_) {}

    // Best-effort cross-machine restore: only for coins that still came up
    // empty above (a genuinely fresh machine/profile with no localStorage
    // history). Fire-and-forget async — never blocks start()'s boot.
    try {
      const bridge = _grokBridge();
      if (bridge && typeof bridge.getSessionSnapshot === 'function') {
        for (const c of COINS) {
          if ((_state.windows15m[c] || []).length > 0) continue;
          bridge.getSessionSnapshot(c).then((res) => {
            const snap = res && res.success ? res.snapshot : null;
            if (!snap) return;
            if ((_state.windows15m[c] || []).length > 0) return; // populated since (localStorage/tick)
            if (Array.isArray(snap.windows15m)) _state.windows15m[c] = snap.windows15m.slice(-MAX_WINDOWS_PER_COIN);
            if (Array.isArray(snap.windows1h)) _state.windows1h[c] = snap.windows1h.slice(-MAX_WINDOWS_PER_COIN);
            if (snap.predictions) _state.predictions[c] = snap.predictions;
          }).catch(() => {});
        }
      }
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

  function memoryPackForPrompt(coin, opts = {}) {
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
      ptbDefenseStats: (() => {
        const cached = _ptbDefenseCache[coin];
        const wantPtb = Number(opts.ptb);
        if (!cached || !Number.isFinite(wantPtb) || wantPtb <= 0 || !(cached.ptb > 0)) return null;
        if (Math.abs(cached.ptb - wantPtb) / wantPtb > PTB_DEFENSE_TOLERANCE_FRAC) return null;
        return {
          testedCount: cached.testedCount,
          defendedCount: cached.defendedCount,
          brokenCount: cached.brokenCount,
          defendRate: cached.defendRate,
          asOf: cached.fetchedAt,
        };
      })(),
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
