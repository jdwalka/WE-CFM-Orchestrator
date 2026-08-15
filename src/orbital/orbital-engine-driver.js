/**
 * Orbital Engine Driver — actually runs window.OrbitalEngine.processInterval().
 *
 * orbital-engine.js (loaded before this) exports a complete forward-looking
 * probability model — TemporalEdge.calculateTemporalEdge() computes probUp
 * for the current 15m window via a proper z-score/normal-CDF against
 * remaining time-to-expiry — but nothing ever called processInterval(), so
 * it had never run once. This driver feeds it real 15m candle data
 * (window.CandleWS.getClosedBuckets15m) on a fixed cadence for every coin.
 *
 * Consumers: window.OrbitalEngine.getState(sym) -> { temporalEdge, oeq,
 * state, action, ... } for the most recent processInterval() result.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const TICK_MS = 30_000;
  let _timer = null;

  function tickOne(sym) {
    try {
      if (!window.CandleWS?.getClosedBuckets15m) return;
      const candles15m = window.CandleWS.getClosedBuckets15m(sym);
      if (!Array.isArray(candles15m) || candles15m.length < 3) return;
      window.OrbitalEngine.processInterval(sym, candles15m);
    } catch (err) {
      console.warn(`[OrbitalEngineDriver] ${sym} processInterval failed:`, err?.message || err);
    }
  }

  function tick() {
    if (!window.OrbitalEngine?.processInterval || !window.OrbitalEngine.isEnabled?.()) return;
    COINS.forEach(tickOne);
  }

  function startDriver() {
    if (_timer) return;
    tick();
    _timer = setInterval(tick, TICK_MS);
  }

  function stopDriver() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  window.OrbitalEngineDriver = { startDriver, stopDriver };

  startDriver();
})();
