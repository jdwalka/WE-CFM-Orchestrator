/**
 * orbital-worker.js — Dedicated Web Worker for Heavy Microstructure & Orbital Math
 *
 * Offloads CPU-intensive routines from the Electron/browser main thread:
 * - GARCH(1,1) conditional volatility & residuals
 * - Realized Volatility (RV) & rolling log return variance
 * - Rolling VWAP & z_vwap calculation
 * - Rolling Bollinger Band Width (BBWidth(20))
 * - Jacobi eigenvalue decomposition for symmetric matrices
 * - Discrete Schrödinger orbital potential and energy levels
 * - Lloyd-Max & Maximum Entropy Quantization (MEQ)
 * - Haar Wavelet energy decomposition
 */

(function () {
  'use strict';

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function mean(arr) {
    if (!arr || !arr.length) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  function stdevPopulation(arr) {
    if (!arr || arr.length < 2) return 0;
    var m = mean(arr);
    var v = 0;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] - m;
      v += d * d;
    }
    return Math.sqrt(v / arr.length);
  }

  function normalizeZ(val, mu, sigma) {
    if (!sigma || sigma <= 1e-12) return 0;
    return (val - mu) / sigma;
  }

  // 1. GARCH(1,1) Volatility & Residuals
  function garchUpdate(state, return_t_minus_1, omega, alpha, beta) {
    var om = omega || 0.000001;
    var al = alpha || 0.15;
    var be = beta || 0.80;
    var st = state || {};
    if (!st.sigma2) {
      st.sigma2 = om / Math.max(0.0001, 1 - al - be);
    }
    var r2 = return_t_minus_1 * return_t_minus_1;
    st.sigma2 = om + al * r2 + be * st.sigma2;
    var condVol = Math.sqrt(Math.max(1e-12, st.sigma2));
    var residual = condVol > 0 ? return_t_minus_1 / condVol : 0;
    return {
      sigma2: st.sigma2,
      condVol: condVol,
      residual: residual,
    };
  }

  // 2. Rolling BBWidth(20) and z_vwap
  function calculateBBWidth(closes, period) {
    var p = period || 20;
    if (!closes || closes.length < p) return { width: 0, upper: 0, lower: 0, middle: 0, std: 0 };
    var slice = closes.slice(-p);
    var sma = mean(slice);
    var std = stdevPopulation(slice);
    var upper = sma + 2 * std;
    var lower = sma - 2 * std;
    var width = sma > 0 ? (upper - lower) / sma : 0;
    return {
      width: width,
      upper: upper,
      lower: lower,
      middle: sma,
      std: std,
    };
  }

  function calculateZVwap(prices, volumes, period) {
    var p = period || 20;
    if (!prices || !prices.length) return { vwap: 0, zVwap: 0, std: 0 };
    var n = Math.min(prices.length, p);
    var pSlice = prices.slice(-n);
    var vSlice = (volumes && volumes.length >= n) ? volumes.slice(-n) : new Array(n).fill(1);

    var cumPV = 0;
    var cumV = 0;
    for (var i = 0; i < n; i++) {
      var v = Math.max(1e-6, vSlice[i] || 1);
      cumPV += pSlice[i] * v;
      cumV += v;
    }
    var vwap = cumV > 0 ? cumPV / cumV : mean(pSlice);
    var curPrice = pSlice[pSlice.length - 1];
    var std = stdevPopulation(pSlice) || 1e-6;
    var zVwap = normalizeZ(curPrice, vwap, std);
    return {
      vwap: vwap,
      zVwap: clamp(zVwap, -4, 4),
      std: std,
    };
  }

  // 3. Jacobi Eigenvalues & Schrodinger Orbitals
  function jacobiEigenvaluesSymmetric(matrix, maxIter) {
    var n = Array.isArray(matrix) ? matrix.length : 0;
    if (!n) return [];
    var a = matrix.map(function (row) { return row.slice(); });
    var iterations = Number.isFinite(maxIter) ? maxIter : 28;

    for (var iter = 0; iter < iterations; iter++) {
      var p = 0, q = 1;
      var maxVal = Math.abs(a[p][q] || 0);
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var v = Math.abs(a[i][j] || 0);
          if (v > maxVal) { maxVal = v; p = i; q = j; }
        }
      }
      if (maxVal < 1e-8) break;

      var app = a[p][p], aqq = a[q][q], apq = a[p][q];
      var phi = 0.5 * Math.atan2(2 * apq, (aqq - app));
      var c = Math.cos(phi), s = Math.sin(phi);

      for (var k = 0; k < n; k++) {
        if (k === p || k === q) continue;
        var akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[p][k] = a[k][p];
        a[k][q] = s * akp + c * akq;
        a[q][k] = a[k][q];
      }
      a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
      a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
      a[p][q] = 0;
      a[q][p] = 0;
    }

    var eig = [];
    for (var d = 0; d < n; d++) eig.push(Number(a[d][d]) || 0);
    eig.sort(function (x, y) { return x - y; });
    return eig;
  }

  function computeSchrodingerOrbitals(closes, levelCount) {
    var seq = Array.isArray(closes) ? closes.filter(Number.isFinite) : [];
    if (seq.length < 6) return [];
    var returns = [];
    for (var i = 1; i < seq.length; i++) {
      var prev = seq[i - 1];
      returns.push(prev > 0 ? (seq[i] / prev) - 1 : 0);
    }
    if (!returns.length) return [];

    var sigma = stdevPopulation(returns) || 1e-6;
    var n = returns.length;
    var h = [];
    for (var r = 0; r < n; r++) {
      h[r] = new Array(n).fill(0);
      var potential = Math.abs(returns[r]) / sigma;
      h[r][r] = 2 + potential;
      if (r > 0) h[r][r - 1] = -1;
      if (r < n - 1) h[r][r + 1] = -1;
    }

    var eig = jacobiEigenvaluesSymmetric(h, 28);
    if (!eig.length) return [];

    var count = Math.max(1, Math.min(levelCount || 3, eig.length));
    var windowSlice = seq.slice(-n);
    var avg = mean(windowSlice);
    var s = stdevPopulation(windowSlice) || 1;
    var levels = [];
    for (var k = 0; k < count; k++) {
      var e = Math.max(0, eig[k]);
      var width = clamp((Math.sqrt(e + 1e-9) * sigma * avg), avg * 0.001, avg * 0.05);
      levels.push({
        energy: parseFloat(e.toFixed(6)),
        center: parseFloat(avg.toFixed(6)),
        width: parseFloat(width.toFixed(6)),
        persistence: parseFloat(clamp(1 - (width / Math.max(avg * 0.05, 1e-6)), 0, 1).toFixed(6)),
        zScore: parseFloat(normalizeZ(windowSlice[windowSlice.length - 1], avg, s).toFixed(6)),
      });
    }
    return levels;
  }

  function haarWaveletEnergy(returns) {
    var n = Math.min(returns.length, 8);
    if (n < 2) return 0;
    var energy = 0;
    for (var i = 0; i < n - 1; i += 2) {
      var diff = (returns[i] - returns[i + 1]) / Math.SQRT2;
      energy += diff * diff;
    }
    return energy;
  }

  function handleMessage(event) {
    var msg = event.data || {};
    var type = msg.type;
    var reqId = msg.reqId;

    try {
      if (type === 'COMPUTE_MICROSTRUCTURE') {
        var closes = msg.closes || [];
        var volumes = msg.volumes || [];
        var returns = [];
        for (var i = 1; i < closes.length; i++) {
          returns.push(closes[i - 1] > 0 ? (closes[i] / closes[i - 1]) - 1 : 0);
        }
        var lastRet = returns.length ? returns[returns.length - 1] : 0;
        var garch = garchUpdate(msg.garchState, lastRet);
        var bb = calculateBBWidth(closes, 20);
        var zVwap = calculateZVwap(closes, volumes, 20);
        var rv = stdevPopulation(returns);
        var haar = haarWaveletEnergy(returns);
        var orbitals = msg.computeOrbitals ? computeSchrodingerOrbitals(closes.slice(-16), 3) : [];

        var reply = {
          type: 'MICROSTRUCTURE_RESULT',
          reqId: reqId,
          sym: msg.sym,
          garch: garch,
          bbWidth: bb.width,
          bbBands: bb,
          zVwap: zVwap.zVwap,
          vwap: zVwap.vwap,
          rv: rv,
          haarEnergy: haar,
          orbitals: orbitals,
          ts: Date.now(),
        };

        if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
          self.postMessage(reply);
        }
        return reply;
      }
    } catch (err) {
      if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
        self.postMessage({
          type: 'ERROR',
          reqId: reqId,
          sym: msg.sym,
          error: String(err && err.message ? err.message : err),
        });
      }
    }
  }

  if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
    self.addEventListener('message', handleMessage);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      garchUpdate: garchUpdate,
      calculateBBWidth: calculateBBWidth,
      calculateZVwap: calculateZVwap,
      jacobiEigenvaluesSymmetric: jacobiEigenvaluesSymmetric,
      computeSchrodingerOrbitals: computeSchrodingerOrbitals,
      haarWaveletEnergy: haarWaveletEnergy,
      handleMessage: handleMessage,
    };
  }
})();
