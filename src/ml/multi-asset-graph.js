/**
 * Lightweight online multi-asset graph — correlation + lead-lag spillover scores.
 * No GNN training in-browser; feeds feature-encoder extras and score nudges.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.MultiAssetGraph = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  const ANCHOR = 'BTC';
  const MAX_SAMPLES = 48;
  const MIN_SAMPLES = 8;
  const TRACKED = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];

  const priceHist = {};
  const returnHist = {};

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function ensure(sym) {
    const key = String(sym || '').toUpperCase();
    if (!priceHist[key]) priceHist[key] = [];
    if (!returnHist[key]) returnHist[key] = [];
    return key;
  }

  function pushBounded(arr, value, max) {
    arr.push(value);
    while (arr.length > max) arr.shift();
  }

  function pearson(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < MIN_SAMPLES) return 0;
    const xs = x.slice(-n);
    const ys = y.slice(-n);
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
      const a = xs[i] - mx;
      const b = ys[i] - my;
      num += a * b;
      dx += a * a;
      dy += b * b;
    }
    const den = Math.sqrt(dx * dy);
    return den > 1e-12 ? num / den : 0;
  }

  /** Cross-correlation at lag: leader[t] vs follower[t+lag]. Positive lag = leader leads. */
  function leadLag(leader, follower, lag = 1) {
    const n = Math.min(leader.length, follower.length);
    if (n < MIN_SAMPLES + lag) return 0;
    const xs = leader.slice(-(n - lag), -lag || undefined);
    const ys = follower.slice(-(n - lag));
    if (xs.length !== ys.length || xs.length < MIN_SAMPLES) return 0;
    return pearson(xs, ys);
  }

  function update(sym, price, ts = Date.now()) {
    const key = ensure(sym);
    const px = Number(price);
    if (!Number.isFinite(px) || px <= 0) return null;

    const hist = priceHist[key];
    const prev = hist.length ? hist[hist.length - 1].price : null;
    pushBounded(hist, { price: px, ts }, MAX_SAMPLES);

    if (prev && prev > 0) {
      const ret = Math.log(px / prev);
      pushBounded(returnHist[key], ret, MAX_SAMPLES);
    }
    return snapshot(key);
  }

  function correlation(a, b) {
    const ka = ensure(a);
    const kb = ensure(b);
    return pearson(returnHist[ka] || [], returnHist[kb] || []);
  }

  function getLeadLag(from, to, maxLag = 3) {
    const leader = ensure(from);
    const follower = ensure(to);
    let bestLag = 0;
    let bestScore = 0;
    for (let lag = 0; lag <= maxLag; lag++) {
      const score = leadLag(returnHist[leader] || [], returnHist[follower] || [], lag);
      if (Math.abs(score) > Math.abs(bestScore)) {
        bestScore = score;
        bestLag = lag;
      }
    }
    return { lag: bestLag, score: bestScore, leader, follower };
  }

  function anchorMomentum() {
    const anchorReturns = returnHist[ANCHOR] || [];
    if (anchorReturns.length < 3) return 0;
    const recent = anchorReturns.slice(-5);
    const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
    return clamp(avg * 120, -1, 1);
  }

  /**
   * Spillover score for sym: how much BTC lead-lag + correlation should nudge direction.
   * Returns [-1, 1].
   */
  function getSpillover(sym) {
    const key = ensure(sym);
    if (key === ANCHOR) return { spillover: 0, correlation: 1, leadLag: { lag: 0, score: 1 }, anchorMomentum: anchorMomentum() };

    const corr = correlation(ANCHOR, key);
    const ll = getLeadLag(ANCHOR, key, 3);
    const btcMom = anchorMomentum();
    const spillover = clamp(btcMom * Math.abs(corr) * (0.55 + Math.abs(ll.score) * 0.45), -1, 1);
    return { spillover, correlation: corr, leadLag: ll, anchorMomentum: btcMom };
  }

  function getAdjacencyFeatures(sym) {
    const row = getSpillover(sym);
    return {
      spillover: row.spillover,
      btcCorrelation: row.correlation,
      btcLeadLag: row.leadLag.score,
      btcLeadLagBars: row.leadLag.lag,
      anchorMomentum: row.anchorMomentum,
    };
  }

  function applyToScore(score, sym, weight = 0.12) {
    const key = ensure(sym);
    if (key === ANCHOR) return { score, spillover: getSpillover(key), adjusted: false };
    const { spillover } = getSpillover(key);
    if (Math.abs(spillover) < 0.04) return { score, spillover: getSpillover(key), adjusted: false };
    const scoreDir = score > 0.06 ? 1 : score < -0.06 ? -1 : 0;
    const spillDir = spillover > 0.04 ? 1 : spillover < -0.04 ? -1 : 0;
    let newScore = score;
    if (scoreDir === 0) {
      newScore = spillover * weight * 2.2;
    } else if (scoreDir === spillDir) {
      newScore = clamp(score + spillover * weight, -1, 1);
    } else {
      newScore = clamp(score * (1 - weight * 0.5), -1, 1);
    }
    return { score: newScore, spillover: getSpillover(key), adjusted: true };
  }

  function snapshot(sym) {
    const key = ensure(sym);
    return {
      sym: key,
      samples: (returnHist[key] || []).length,
      spillover: getSpillover(key),
    };
  }

  function ingestPredictions(predictions = {}) {
    const now = Date.now();
    for (const sym of TRACKED) {
      const px = predictions[sym]?.price ?? window._predictions?.[sym]?.price;
      if (px) update(sym, px, now);
    }
  }

  return {
    ANCHOR,
    TRACKED,
    update,
    correlation,
    getLeadLag,
    getSpillover,
    getAdjacencyFeatures,
    applyToScore,
    snapshot,
    ingestPredictions,
  };
}));
