// ================================================================
// WE|||CRYPTO — Polymarket 5m/15m Resolution/Outcome Tracker
//
// Candle-based model-call grading (separate from MarketResolver).
//
// Dual-horizon note:
//   • market-resolver.js is the CANONICAL Polymarket oracle path
//     (CLOB WS market_resolved push + Gamma poll). It writes
//     window._15mResolutionLog and fires market15m:resolved for BOTH
//     5m and 15m (type field). Do NOT merge this tracker's rows into
//     that log — consumers treat _15mResolutionLog as UMA/Gamma truth.
//   • This module grades PTB-anchored model calls against the Chainlink
//     candle cache into window._5mResolutionLog (and poly5m:resolved).
//     Candle close can disagree with Polymarket TWAP near boundaries;
//     that is expected and informational for signal-weight feedback only.
//
// Records a prediction once per window (recordPending5mPrediction, called
// from render-layer.js's model box at the point the odds are computed),
// then polls -- after a grace period -- the SAME chainlink-candles cache
// prediction-markets.js already maintains for PTB (via the exposed
// window.PredictionMarkets._getCachedChainlinkCandle accessor) for that
// window's settlement close. Never issues a fetch of its own.
// ================================================================

(function () {
  'use strict';

  const RESOLUTION_GRACE_MS = 30_000;   // mirrors the PTB publish-latency lesson
  const RESOLUTION_TICK_MS = 15_000;
  const RESOLUTION_MAX_ATTEMPTS = 24;   // ~6 minutes of retry past the grace period
  const LOG_CAP = 1000;
  const STORE_KEY = 'poly5m_resolution_log_v1';

  window._5mResolutionLog = Array.isArray(window._5mResolutionLog) ? window._5mResolutionLog : [];

  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) window._5mResolutionLog = arr.slice(-LOG_CAP);
    }
  } catch (_) { /* fresh start is fine */ }

  function _saveLog() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(window._5mResolutionLog.slice(-LOG_CAP))); } catch (_) { }
  }

  const _pending = {}; // slug -> entry awaiting settlement

  // Called once per window per symbol at the point a directional call is
  // made (render-layer.js's model box, right where modelOdds/ptbAnchored are
  // already computed). Idempotent per slug -- safe to call on every render.
  function recordPending5mPrediction(sym, slug, windowStart, windowSec, prediction) {
    if (!sym || !slug || !Number.isFinite(windowStart) || !prediction) return;
    if (_pending[slug]) return;
    if (window._5mResolutionLog.some((e) => e.slug === slug)) return; // already resolved (e.g. app restart)

    const direction = String(prediction.direction || '').toUpperCase();
    if (direction !== 'UP' && direction !== 'DOWN') return; // no real call to grade

    _pending[slug] = {
      sym,
      slug,
      windowStart,
      windowEnd: windowStart + (Number.isFinite(windowSec) ? windowSec : 300),
      predictedDirection: direction,
      confidence: Number.isFinite(prediction.confidence) ? prediction.confidence : null,
      modelYesPct: Number.isFinite(prediction.modelYesPct) ? prediction.modelYesPct : null,
      ptbAnchored: !!prediction.ptbAnchored,
      ptbOpen: Number.isFinite(prediction.ptbOpen) && prediction.ptbOpen > 0 ? prediction.ptbOpen : null,
      recordedAt: Date.now(),
      _attempts: 0,
      _lastAttemptAt: 0,
    };
  }

  function _horizonTagFor(windowSec) {
    return windowSec === 900 ? '15m' : '5m';
  }

  function _tick() {
    const now = Date.now();
    for (const [slug, entry] of Object.entries(_pending)) {
      const windowEndMs = entry.windowEnd * 1000;
      if (now < windowEndMs + RESOLUTION_GRACE_MS) continue;
      if (entry._attempts >= RESOLUTION_MAX_ATTEMPTS) {
        console.warn(`[Poly5MResolution] ${entry.sym} ${slug} gave up after ${RESOLUTION_MAX_ATTEMPTS} attempts -- Polymarket never published the settled candle`);
        delete _pending[slug];
        continue;
      }
      if (now - entry._lastAttemptAt < RESOLUTION_TICK_MS) continue;
      entry._lastAttemptAt = now;
      entry._attempts++;

      const horizonTag = _horizonTagFor(entry.windowEnd - entry.windowStart);
      const candle = window.PredictionMarkets && typeof window.PredictionMarkets._getCachedChainlinkCandle === 'function'
        ? window.PredictionMarkets._getCachedChainlinkCandle(entry.sym, horizonTag, entry.windowStart)
        : null;
      if (!candle) continue; // not published yet -- retry next tick

      const settleClose = Number(candle.close);
      const ptbOpen = entry.ptbOpen != null ? entry.ptbOpen : Number(candle.open);
      if (!Number.isFinite(settleClose) || settleClose <= 0 || !Number.isFinite(ptbOpen) || ptbOpen <= 0) {
        // Malformed candle or no usable reference price -- not worth retrying.
        delete _pending[slug];
        continue;
      }

      const actualDirection = settleClose >= ptbOpen ? 'UP' : 'DOWN';
      const correct = entry.predictedDirection === actualDirection;

      const resolved = {
        sym: entry.sym,
        slug: entry.slug,
        windowStart: entry.windowStart,
        windowEnd: entry.windowEnd,
        predictedDirection: entry.predictedDirection,
        confidence: entry.confidence,
        modelYesPct: entry.modelYesPct,
        ptbAnchored: entry.ptbAnchored,
        ptbOpen,
        recordedAt: entry.recordedAt,
        resolvedAt: now,
        settleClose,
        actualDirection,
        correct,
      };

      window._5mResolutionLog.push(resolved);
      if (window._5mResolutionLog.length > LOG_CAP) window._5mResolutionLog.shift();
      _saveLog();
      delete _pending[slug];

      // The one call site recordOnlineSignalOutcome was missing everywhere.
      // signalKey 'ptbAnchor' is a new key (not one of the existing
      // COMPOSITE_WEIGHTS indicator keys), so this builds real win/loss
      // stats for the 5m PTB-anchored call specifically, but doesn't yet
      // feed back into applyOnlineWeightOverlay's live scoring (that only
      // reads mult for keys present in COMPOSITE_WEIGHTS). That's a
      // deliberate v1 scope -- per-signal attribution across the composite
      // score's ~20 individual indicators is a follow-up once this has
      // accumulated enough real samples to be worth wiring deeper.
      try {
        const confPct = Number.isFinite(entry.confidence) ? entry.confidence * 100
          : Number.isFinite(entry.modelYesPct) ? Math.abs(entry.modelYesPct - 0.5) * 200
            : 50;
        window.PredictionEngine?.recordOnlineSignalOutcome?.({
          sym: entry.sym,
          signalKey: 'ptbAnchor',
          predictedSign: entry.predictedDirection,
          outcomeSign: actualDirection,
          confidence: confPct,
        });
      } catch (_) { /* scoring feedback must never break resolution logging */ }

      try {
        window.dispatchEvent(new CustomEvent('poly5m:resolved', { detail: resolved }));
      } catch (_) { }

      console.log(
        `[Poly5MResolution] ${entry.sym} ${slug} -> ${actualDirection}` +
        ` (predicted ${entry.predictedDirection}) ${correct ? '✓' : '✗'}` +
        ` settle=${settleClose} ptb=${ptbOpen}`
      );
    }
  }

  let _timer = null;
  function start() {
    if (_timer) return;
    _timer = setInterval(_tick, RESOLUTION_TICK_MS);
  }
  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  window.Poly5MResolutionTracker = {
    recordPending5mPrediction,
    start,
    stop,
    getLog() { return window._5mResolutionLog; },
    getPending() { return { ..._pending }; },
    // Quick aggregate for a symbol's recent track record -- consumed by
    // Phase 3b's eventual 5m-isolated reliability track once enough samples
    // exist, and useful standalone for debugging/observability today.
    getStats(sym, lookback = 200) {
      const rows = sym
        ? window._5mResolutionLog.filter((e) => e.sym === sym)
        : window._5mResolutionLog;
      const recent = rows.slice(-lookback);
      const wins = recent.filter((e) => e.correct).length;
      return {
        samples: recent.length,
        wins,
        losses: recent.length - wins,
        winRate: recent.length ? wins / recent.length : null,
      };
    },
  };

  start();
})();
