/**
 * Multi-horizon attention fusion (5m / 15m / 1h proxies) — JS MLP-style softmax weights.
 * Phase 2: replace weights with offline TFT export; keep this API as inference shim.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TemporalFusionLite = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  const HORIZONS = [
    { key: 'h5', label: '5m', minutes: 5, basePrior: 0.28 },
    { key: 'h15', label: '15m', minutes: 15, basePrior: 0.44 },
    { key: 'h60', label: '1h', minutes: 60, basePrior: 0.28 },
  ];

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function softmax(arr) {
    const max = Math.max(...arr);
    const exps = arr.map((v) => Math.exp(v - max));
    const sum = exps.reduce((s, v) => s + v, 0) || 1;
    return exps.map((e) => e / sum);
  }

  function resolveHorizonScores(ctx = {}) {
    const fast = ctx.fastTiming?.horizonScores || ctx.horizonScores || {};
    const modelScore = Number(ctx.modelScore ?? ctx.score ?? 0);
    return {
      h5: Number(fast.h5 ?? fast.h10 ?? modelScore * 0.85),
      h15: Number(fast.h15 ?? modelScore),
      h60: Number(fast.h60 ?? ctx.hourlyScore ?? modelScore * 0.72),
    };
  }

  function msToCloseBias(msToClose) {
    if (!Number.isFinite(msToClose) || msToClose <= 0) return { h5: 0, h15: 0, h60: 0 };
    const mins = msToClose / 60000;
    if (mins <= 6) return { h5: 0.55, h15: 0.35, h60: -0.25 };
    if (mins <= 18) return { h5: 0.25, h15: 0.45, h60: -0.05 };
    if (mins <= 45) return { h5: -0.05, h15: 0.35, h60: 0.15 };
    return { h5: -0.15, h15: 0.15, h60: 0.35 };
  }

  function volatilityBias(atrPct = 0) {
    const v = clamp(Number(atrPct) / 2.5, 0, 1);
    return { h5: v * 0.35, h15: v * 0.15, h60: -v * 0.12 };
  }

  function agreementBias(scores) {
    const dirs = [scores.h5, scores.h15, scores.h60].map((s) => (s > 0.05 ? 1 : s < -0.05 ? -1 : 0));
    const same = dirs.filter((d) => d !== 0 && d === dirs[0]).length;
    const conflict = dirs.includes(1) && dirs.includes(-1);
    if (conflict) return { h5: 0.1, h15: 0.25, h60: 0.05, conflict: true };
    if (same >= 2) return { h5: 0.08, h15: 0.12, h60: 0.06, conflict: false };
    return { h5: 0, h15: 0.05, h60: 0, conflict: false };
  }

  /**
   * Fuse multi-horizon signal vectors into one score + attention weights.
   */
  function fuse(ctx = {}) {
    const scores = resolveHorizonScores(ctx);
    const closeBias = msToCloseBias(ctx.msToClose);
    const volBias = volatilityBias(ctx.atrPct ?? ctx.volatility?.atrPct);
    const agree = agreementBias(scores);

    const logits = HORIZONS.map((h) => {
      const s = scores[h.key] ?? 0;
      const magnitude = Math.abs(s);
      const close = closeBias[h.key] ?? 0;
      const vol = volBias[h.key] ?? 0;
      const agreeB = agree[h.key] ?? 0;
      return Math.log(h.basePrior + 1e-6) + magnitude * 1.35 + close + vol + agreeB - (agree.conflict ? 0.08 : 0);
    });

    const weightsArr = softmax(logits);
    const weights = {};
    HORIZONS.forEach((h, i) => { weights[h.key] = weightsArr[i]; });

    let fused = 0;
    HORIZONS.forEach((h, i) => {
      fused += (scores[h.key] ?? 0) * weightsArr[i];
    });
    fused = clamp(fused, -1, 1);

    const baseScore = Number(ctx.score ?? ctx.modelScore ?? 0);
    const blend = clamp(Number(ctx.blend ?? 0.38), 0, 1);
    const outScore = clamp(baseScore * (1 - blend) + fused * blend, -1, 1);

    return {
      score: outScore,
      fusedScore: fused,
      baseScore,
      horizonScores: scores,
      weights,
      conflict: agree.conflict,
      phase: 'lite-mlp-attention',
      tftPath: 'backtest/tft-export (Phase 2 offline)',
    };
  }

  function applyToScore(score, ctx = {}) {
    const out = fuse({ ...ctx, score, modelScore: score });
    return out;
  }

  return {
    HORIZONS,
    fuse,
    applyToScore,
    resolveHorizonScores,
  };
}));
