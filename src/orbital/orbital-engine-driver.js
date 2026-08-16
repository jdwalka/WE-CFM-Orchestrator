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
  // reinitLambdas() calibrates each coin's decay constant against real
  // realized volatility (lambda = LAMBDA_TARGET_SIGMA / realizedSigma) --
  // it existed but was never called anywhere, and its own no-arg fallback
  // path references a global (root._predictionsCache) that doesn't exist
  // in this codebase (the real one is window._predictions), so even a bare
  // call would have silently no-op'd to defaults. Always pass historyMap
  // explicitly here so that fallback path is never relied on. Hourly is
  // plenty -- realized volatility doesn't need to be recalibrated faster
  // than that for a decay constant feeding a 15m-horizon model.
  const LAMBDA_RECALIBRATE_MS = 60 * 60_000;
  let _timer = null;
  let _lambdaTimer = null;

  function getCandles(sym) {
    if (!window.CandleWS?.getClosedBuckets15m) return null;
    const candles15m = window.CandleWS.getClosedBuckets15m(sym);
    return Array.isArray(candles15m) && candles15m.length >= 3 ? candles15m : null;
  }

  function tickOne(sym) {
    try {
      const candles15m = getCandles(sym);
      if (!candles15m) return;
      window.OrbitalEngine.processInterval(sym, candles15m);
    } catch (err) {
      console.warn(`[OrbitalEngineDriver] ${sym} processInterval failed:`, err?.message || err);
    }
  }

  function tick() {
    if (!window.OrbitalEngine?.processInterval || !window.OrbitalEngine.isEnabled?.()) return;
    COINS.forEach(tickOne);
  }

  function recalibrateLambdas() {
    try {
      if (!window.OrbitalEngine?.reinitLambdas) return;
      const historyMap = {};
      let n = 0;
      COINS.forEach((sym) => {
        const candles15m = getCandles(sym);
        if (candles15m) { historyMap[sym] = candles15m; n++; }
      });
      if (!n) return;
      const lambdas = window.OrbitalEngine.reinitLambdas(historyMap);
      console.info('[OrbitalEngineDriver] Lambdas recalibrated from realized volatility:', lambdas);
    } catch (err) {
      console.warn('[OrbitalEngineDriver] reinitLambdas failed:', err?.message || err);
    }
  }

  function startDriver() {
    if (_timer) return;
    tick();
    _timer = setInterval(tick, TICK_MS);
    recalibrateLambdas();
    _lambdaTimer = setInterval(recalibrateLambdas, LAMBDA_RECALIBRATE_MS);
  }

  function stopDriver() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_lambdaTimer) { clearInterval(_lambdaTimer); _lambdaTimer = null; }
  }

  window.OrbitalEngineDriver = { startDriver, stopDriver, recalibrateLambdas };

  startDriver();
})();
