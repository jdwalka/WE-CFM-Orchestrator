/**
 * Narrative velocity — rate-of-change on social sentiment + optional ASI1 mini overlay.
 * Renderer-safe; ASI1 runs via Electron IPC when available (main process only).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.NarrativeVelocity = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  const HISTORY_MAX = 24;
  const MIN_DELTA_MS = 60_000;
  const history = {};
  const asi1Cache = {};

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function ensure(sym) {
    const key = String(sym || '').toUpperCase();
    if (!history[key]) history[key] = [];
    return key;
  }

  function readSocial(sym) {
    const row = window.SocialSentiment?.getCoin?.(sym);
    if (!row || row.ts == null) return null;
    return {
      score: clamp(Number(row.score ?? 0) / 100, -1, 1),
      momentum: row.momentum || 'flat',
      ts: Number(row.ts),
      summary: row.summary || '',
    };
  }

  function recordSample(sym) {
    const key = ensure(sym);
    const social = readSocial(sym);
    if (!social) return null;

    const hist = history[key];
    const last = hist.length ? hist[hist.length - 1] : null;
    if (last && social.ts - last.ts < 30_000 && Math.abs(social.score - last.score) < 0.01) {
      return computeVelocity(key);
    }

    hist.push({ score: social.score, momentum: social.momentum, ts: social.ts });
    while (hist.length > HISTORY_MAX) hist.shift();
    return computeVelocity(key);
  }

  function computeVelocity(key) {
    const hist = history[key] || [];
    if (hist.length < 2) {
      return { velocity: 0, acceleration: 0, momentum: hist[0]?.momentum || 'flat', samples: hist.length };
    }
    const a = hist[hist.length - 2];
    const b = hist[hist.length - 1];
    const dtMin = Math.max((b.ts - a.ts) / 60000, MIN_DELTA_MS / 60000);
    const velocity = clamp((b.score - a.score) / dtMin, -1, 1);

    let acceleration = 0;
    if (hist.length >= 3) {
      const c = hist[hist.length - 3];
      const vPrev = (a.score - c.score) / Math.max((a.ts - c.ts) / 60000, MIN_DELTA_MS / 60000);
      acceleration = clamp((velocity - vPrev) / dtMin, -1, 1);
    }

    return {
      velocity,
      acceleration,
      momentum: b.momentum,
      samples: hist.length,
      latestScore: b.score,
    };
  }

  async function fetchAsi1Mini(sym, context = {}) {
    const key = ensure(sym);
    const cached = asi1Cache[key];
    if (cached && Date.now() - cached.ts < 120_000) return cached.value;

    const invoke = window.electron?.invoke || window.electronAPI?.invoke;
    if (typeof invoke !== 'function') return null;

    try {
      const prompt = [
        `Coin: ${sym}.`,
        `Social score: ${context.socialScore ?? 'n/a'}.`,
        `Price bias: ${context.score ?? 0}.`,
        'Reply JSON only: {"velocity":-1..1,"narrative":"short phrase"}',
      ].join(' ');
      const res = await invoke('asi1:mini-narrative', { sym, prompt, model: 'asi1-mini' });
      const parsed = typeof res === 'string' ? JSON.parse(res) : res;
      const value = {
        velocity: clamp(Number(parsed?.velocity ?? 0), -1, 1),
        narrative: String(parsed?.narrative || '').slice(0, 120),
        source: 'asi1-mini',
      };
      asi1Cache[key] = { ts: Date.now(), value };
      return value;
    } catch (_) {
      return null;
    }
  }

  async function analyze(sym, ctx = {}) {
    const key = ensure(sym);
    const base = recordSample(key) || computeVelocity(key);
    let velocity = base.velocity ?? 0;
    let narrative = null;
    let source = 'social-delta';

    const social = readSocial(key);
    if (social?.momentum === 'rising') velocity = clamp(velocity + 0.08, -1, 1);
    if (social?.momentum === 'falling') velocity = clamp(velocity - 0.08, -1, 1);

    if (ctx.useAsi1 !== false) {
      const asi1 = await fetchAsi1Mini(key, {
        socialScore: social?.score,
        score: ctx.score,
      });
      if (asi1) {
        velocity = clamp(velocity * 0.55 + asi1.velocity * 0.45, -1, 1);
        narrative = asi1.narrative;
        source = 'social+asi1-mini';
      }
    }

    return {
      sym: key,
      velocity,
      acceleration: base.acceleration ?? 0,
      momentum: base.momentum,
      narrative,
      source,
      socialScore: social?.score ?? null,
    };
  }

  function applyToScore(score, sym, ctx = {}) {
    const key = ensure(sym);
    const base = recordSample(key) || computeVelocity(key);
    const velocity = base.velocity ?? 0;
    if (Math.abs(velocity) < 0.05) {
      return { score, narrative: base, adjusted: false };
    }
    const weight = clamp(Number(ctx.weight ?? 0.08), 0, 0.2);
    const scoreDir = score > 0.06 ? 1 : score < -0.06 ? -1 : 0;
    const velDir = velocity > 0.04 ? 1 : velocity < -0.04 ? -1 : 0;
    let newScore = score;
    if (scoreDir === 0) {
      newScore = velocity * weight * 2.5;
    } else if (scoreDir === velDir) {
      newScore = clamp(score + velocity * weight, -1, 1);
    } else {
      newScore = clamp(score * (1 - weight * 0.35), -1, 1);
    }
    return {
      score: newScore,
      narrative: { ...base, sym: key },
      adjusted: true,
    };
  }

  return {
    recordSample,
    analyze,
    applyToScore,
    getHistory: (sym) => (history[ensure(sym)] || []).slice(),
  };
}));
