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

  return { clamp, num, toFiniteNumber, normCall, normSym };
}));
