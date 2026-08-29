// ================================================================
// WE|||CRYPTO — Regime and Online Weight Overlays
// Orbital shell: adaptive signal-weight control.
// ================================================================

(function () {
  'use strict';

  const REGIME_WEIGHT_MULTS = {
     trending_smooth: { ema: 1.5, hma: 1.4, vwap: 1.3, obv: 1.2, bands: 0.7, williamsR: 0.7, momentum: 0.5 },
     trending_volatile: { volume: 1.5, flow: 1.4, book: 1.3, macd: 1.2, ema: 1.1, bands: 0.8, momentum: 2 },
     ranging: { bands: 1.6, williamsR: 1.5, cci: 1.4, rsi: 1.3, stochrsi: 1.3, ema: 0.7, hma: 0.6, momentum: 0.1 },
     choppy: { book: 0.4, flow: 0.4, macd: 0.5, ema: 0.6, bands: 0.6, momentum: 0.3 },
     neutral: {},
   };

  const ONLINE_WEIGHT_BOUNDS = {
    minMult: 0.6,
    maxMult: 1.4,
    minPruneMult: 0.15,
    maxStep: 0.06,
  };

  const OUTER_ORBITAL_WEIGHTS = {
    momentum: 0.05,
    vwap: 0.05,
  };

  const ONLINE_WEIGHT_STATE = {};

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function _coinKey(sym) {
    return String(sym || 'GLOBAL').toUpperCase();
  }

  function _ensureOnlineState(sym) {
    const key = _coinKey(sym);
    if (!ONLINE_WEIGHT_STATE[key]) {
      ONLINE_WEIGHT_STATE[key] = {
        updatedAt: Date.now(),
        signals: {},
      };
    }
    return ONLINE_WEIGHT_STATE[key];
  }

  function _ensureOnlineSignalState(sym, signal) {
    const state = _ensureOnlineState(sym);
    const skey = String(signal || '').trim();
    if (!skey) return null;
    if (!state.signals[skey]) {
      state.signals[skey] = {
        mult: 1,
        pruneMult: 1,
        samples: 0,
        wins: 0,
        losses: 0,
        updatedAt: Date.now(),
      };
    }
    return state.signals[skey];
  }

  function _clampOnlineStep(delta) {
    return clamp(delta, -ONLINE_WEIGHT_BOUNDS.maxStep, ONLINE_WEIGHT_BOUNDS.maxStep);
  }

  function applyOnlineWeightOverlay(sym, baseWeights) {
    const key = _coinKey(sym);
    const state = Object.prototype.hasOwnProperty.call(ONLINE_WEIGHT_STATE, key) ? ONLINE_WEIGHT_STATE[key] : undefined;
    if (!state || !state.signals) return { ...baseWeights };
    const out = { ...baseWeights };
    Object.keys(out).forEach((signal) => {
      const st = Object.prototype.hasOwnProperty.call(state.signals, signal) ? state.signals[signal] : undefined;
      if (!st) return;
      const mult = clamp(Number(st.mult) || 1, ONLINE_WEIGHT_BOUNDS.minMult, ONLINE_WEIGHT_BOUNDS.maxMult);
      const pruneMult = clamp(Number(st.pruneMult) || 1, ONLINE_WEIGHT_BOUNDS.minPruneMult, 1);
      const val = Object.prototype.hasOwnProperty.call(out, signal) ? out[signal] : undefined;
      if (val !== undefined) out[signal] = val * mult * pruneMult;
    });
    return out;
  }

  /**
   * Applies regime multipliers to a copied weight map to keep hot-path callers
   * side-effect free while preserving O(n) key traversal.
   */
  function applyRegimeMults(baseWeights, regimeKey) {
    const mults = Object.prototype.hasOwnProperty.call(REGIME_WEIGHT_MULTS, regimeKey) ? REGIME_WEIGHT_MULTS[regimeKey] : {};
    const result = { ...baseWeights };
    for (const [k, m] of Object.entries(mults)) {
      if (result[k] !== undefined) result[k] = result[k] * m;
    }
    return result;
  }

  // Full-state snapshot/restore for cross-session persistence (see
  // src/core/data-logger.js's weight_tuning_state category and
  // adaptive-tuner.js's bootstrapFromPriorSession()). This is the "native
  // weights" state that per-signal online tuning actually mutates.
  function getAllOnlineState() {
    return JSON.parse(JSON.stringify(ONLINE_WEIGHT_STATE));
  }

  function loadOnlineState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return { loaded: false, coins: 0 };
    let coins = 0;
    for (const [sym, state] of Object.entries(snapshot)) {
      if (!state || typeof state !== 'object' || !state.signals) continue;
      const key = _coinKey(sym);
      ONLINE_WEIGHT_STATE[key] = {
        updatedAt: Number(state.updatedAt) || Date.now(),
        signals: { ...state.signals },
      };
      coins++;
    }
    return { loaded: coins > 0, coins };
  }

  window.PredictionRegimeWeights = {
    REGIME_WEIGHT_MULTS,
    ONLINE_WEIGHT_BOUNDS,
    OUTER_ORBITAL_WEIGHTS,
    ONLINE_WEIGHT_STATE,
    getAllOnlineState,
    loadOnlineState,
    _coinKey,
    _ensureOnlineState,
    _ensureOnlineSignalState,
    _clampOnlineStep,
    applyOnlineWeightOverlay,
    applyRegimeMults,
  };
})();
