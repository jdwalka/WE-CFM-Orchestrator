/**
 * Shared numeric / call helpers for LivePath15m, SignalCalibrator, and
 * inference orchestrators. Browser + Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.SignalMath = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(n, lo, hi) {
    const x = Number(n);
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
  }

  function num(v, fallback = null) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function toFiniteNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function normCall(c) {
    const u = String(c || '').toUpperCase().trim();
    if (u === 'UP' || u === 'BUY_UP' || u === 'YES' || u === 'LONG') return 'UP';
    if (u === 'DOWN' || u === 'BUY_DOWN' || u === 'NO' || u === 'SHORT') return 'DOWN';
    return null;
  }

  function normSym(s) {
    return String(s || '').toUpperCase().trim();
  }

  // Coin Precision Bridge
  let _coinPrec = null;
  try {
    if (typeof root !== 'undefined' && root.CoinPrecision) {
      _coinPrec = root.CoinPrecision;
    } else if (typeof require === 'function') {
      _coinPrec = require('./coin-precision');
    }
  } catch (_) { /* */ }

  const formatCoinPrice = (coin, val, opts) => _coinPrec ? _coinPrec.formatCoinPrice(coin, val, opts) : `$${Number(val).toFixed(2)}`;
  const formatCoinDelta = (coin, val, opts) => _coinPrec ? _coinPrec.formatCoinDelta(coin, val, opts) : `${val >= 0 ? '+' : '-'}$${Math.abs(Number(val)).toFixed(2)}`;
  const formatCoinStrike = (coin, val, opts) => _coinPrec ? _coinPrec.formatCoinStrike(coin, val, opts) : `$${Number(val).toFixed(2)}`;
  const getCoinDecimals = (coin, val) => _coinPrec ? _coinPrec.getCoinDecimals(coin, val) : 2;

  return {
    clamp,
    num,
    toFiniteNumber,
    normCall,
    normSym,
    CoinPrecision: _coinPrec,
    formatCoinPrice,
    formatCoinDelta,
    formatCoinStrike,
    getCoinDecimals,
  };
}));

