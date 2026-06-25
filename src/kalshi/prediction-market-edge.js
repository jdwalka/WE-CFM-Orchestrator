// ================================================================
// prediction-market-edge.js — Prediction-Market Edge Layer v1.0
// ----------------------------------------------------------------
// Mines the prediction markets themselves for edge the engine ignored:
//   1) Cross-venue divergence — Kalshi YES prob vs Polymarket YES prob on the
//      same coin/horizon. A persistent gap is a direct, low-variance edge
//      (buy the cheaper venue / fade the richer one).
//   2) Strike-ladder implied distribution — a Kalshi threshold ladder (many
//      strikes, one expiry) IS a market-implied CDF. We extract the implied
//      median, implied vol, and skew from the YES("above") prices.
//   3) Model-vs-market mispricing rank — build a lognormal terminal-price
//      distribution from spot + ATM IV (from OptionsGammaFeed, else realized
//      vol), then rank ladder contracts by |model_prob − market_prob|, gated
//      by liquidity, to surface the single most-mispriced contract.
//
// Convention mirrors the feed modules:
//   Exposes:  window.PredictionMarketEdge
//   Events:   prediction-edge-update, market-data-envelope
//   Methods:  .get(sym) .getAll() .start() .stop() .setLadderSeries(map)
// Read-only over public Kalshi + existing window.PredictionMarkets cache.
// Never throws on boot; degrades gracefully when a ladder isn't available.
// ================================================================

(function () {
  'use strict';

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const POLL_MS = 30_000;
  const TIMEOUT_MS = 10_000;
  const KALSHI_MARKET_LIMIT = 200;

  // Configurable Kalshi range/threshold series per coin (multi-strike ladders).
  // Defaults target the daily range series; adjust via setLadderSeries() if your
  // account surfaces different tickers. Discovery requires >=3 distinct strikes.
  let LADDER_SERIES = {
    BTC: ['KXBTCD', 'KXBTC'],
    ETH: ['KXETHD', 'KXETH'],
    SOL: ['KXSOLD', 'KXSOL'],
    XRP: ['KXXRPD', 'KXXRP'],
  };

  // Divergence actionability threshold (probability points).
  const DIVERGENCE_MIN_PP = 4;
  // Min Kalshi $ liquidity for a ladder contract to be rankable.
  const MIN_CONTRACT_LIQUIDITY = 50;

  const CACHE = {};
  let _timer = null;

  function timedFetch(url) {
    return Promise.race([
      fetch(url, { headers: { Accept: 'application/json' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
  }
  async function getJson(url) {
    const res = await timedFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x >= 0 ? 1 - p : p;
  }

  // ── 1) Cross-venue divergence (from existing PredictionMarkets cache) ──
  function probFromSource(coin, names) {
    // sources: [{ name, prob, vol }]. prob is 0..1 (YES). Try named sources first.
    const sources = coin?.sources || [];
    for (const n of names) {
      const hit = sources.find(s => String(s.name || '').toLowerCase().includes(n));
      if (hit && Number.isFinite(hit.prob)) return hit.prob;
    }
    return null;
  }
  function divergenceFor(sym) {
    const pm = window.PredictionMarkets;
    if (!pm || typeof pm.getCoin !== 'function') return null;
    const coin = pm.getCoin(sym);
    if (!coin) return null;

    // Kalshi YES prob (15M direct UP market) — probability is 0..100 in cache.
    const kalRaw = coin.kalshi15m?.probability ?? coin.kalshi5m?.probability ?? probFromSource(coin, ['kalshi']);
    const polyRaw = coin.poly5m?.probability ?? coin.poly5m?.clobProbability ?? probFromSource(coin, ['poly']);
    const kal = kalRaw == null ? null : (kalRaw > 1 ? kalRaw / 100 : kalRaw);
    const poly = polyRaw == null ? null : (polyRaw > 1 ? polyRaw / 100 : polyRaw);
    if (kal == null || poly == null) return null;

    const gapPp = (kal - poly) * 100; // positive → Kalshi richer on YES than Poly
    const actionable = Math.abs(gapPp) >= DIVERGENCE_MIN_PP;
    let play = null;
    if (actionable) {
      // Buy YES on the cheaper venue, NO on the richer (same directional view).
      play = gapPp > 0
        ? { buyYesOn: 'polymarket', fadeYesOn: 'kalshi' }
        : { buyYesOn: 'kalshi', fadeYesOn: 'polymarket' };
    }
    return { kalshiYes: kal, polyYes: poly, gapPp, actionable, play };
  }

  // ── 2) Strike-ladder implied distribution (Kalshi threshold ladder) ──
  function normalizeMarket(m) {
    const yesBid = Number(m.yes_bid);
    const yesAsk = Number(m.yes_ask);
    const last = Number(m.last_price);
    // Mid of bid/ask when available, else last; values are cents 0..100.
    let yes = null;
    if (Number.isFinite(yesBid) && Number.isFinite(yesAsk) && (yesBid || yesAsk)) yes = (yesBid + yesAsk) / 2;
    else if (Number.isFinite(last)) yes = last;
    if (yes == null) return null;

    const sub = String(m.yes_sub_title || m.subtitle || m.title || '');
    let strike = Number(m.floor_strike ?? m.cap_strike);
    if (!Number.isFinite(strike) || strike <= 0) {
      const num = sub.replace(/[$,]/g, '').match(/\d+\.?\d*/);
      strike = num ? parseFloat(num[0]) : NaN;
    }
    if (!Number.isFinite(strike) || strike <= 0) return null;

    const rawType = String(m.strike_type || '').toLowerCase();
    let dir = /below|under|less/.test(rawType) ? 'below'
      : /above|over|greater|at_least/.test(rawType) ? 'above'
      : (/below|under/.test(sub.toLowerCase()) ? 'below' : 'above');

    // Normalize to P(price > strike).
    const pAbove = dir === 'above' ? yes / 100 : 1 - yes / 100;
    return {
      ticker: m.ticker,
      strike,
      pAbove: Math.max(0, Math.min(1, pAbove)),
      closeTime: m.close_time,
      liquidity: Number(m.liquidity_dollars || m.liquidity || 0) || 0,
      volume: Number(m.volume || 0) || 0,
    };
  }

  async function fetchLadder(sym) {
    for (const series of (LADDER_SERIES[sym] || [])) {
      try {
        const d = await getJson(`${KALSHI_BASE}/markets?series_ticker=${series}&status=open&limit=${KALSHI_MARKET_LIMIT}`);
        const markets = (d?.markets || []).map(normalizeMarket).filter(Boolean);
        if (!markets.length) continue;
        // Group by expiry (closeTime); keep the nearest expiry with >=3 strikes.
        const byExpiry = new Map();
        for (const m of markets) {
          if (!byExpiry.has(m.closeTime)) byExpiry.set(m.closeTime, []);
          byExpiry.get(m.closeTime).push(m);
        }
        const candidates = [...byExpiry.entries()]
          .map(([ct, ms]) => ({ ct, ms: ms.sort((a, b) => a.strike - b.strike) }))
          .filter(e => new Set(e.ms.map(m => m.strike)).size >= 3)
          .sort((a, b) => new Date(a.ct).getTime() - new Date(b.ct).getTime());
        if (candidates.length) return { series, ...candidates[0] };
      } catch (_) { /* try next series */ }
    }
    return null;
  }

  // Extract implied median/vol/skew from the survival function P(price>K).
  function impliedFromLadder(ladder) {
    const pts = ladder.ms
      .map(m => ({ k: m.strike, s: m.pAbove }))
      .sort((a, b) => a.k - b.k);
    if (pts.length < 3) return null;

    // Survival S(K)=P(>K) should be monotonically decreasing; interpolate quantiles.
    const quantileStrike = (targetSurvival) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if ((a.s >= targetSurvival && b.s <= targetSurvival) || (a.s <= targetSurvival && b.s >= targetSurvival)) {
          const span = (a.s - b.s);
          const frac = span !== 0 ? (a.s - targetSurvival) / span : 0.5;
          return a.k + frac * (b.k - a.k);
        }
      }
      return null;
    };
    const median = quantileStrike(0.5);
    const q16 = quantileStrike(0.84); // lower strike (survival high)
    const q84 = quantileStrike(0.16); // upper strike (survival low)
    let impliedVolPctOfPrice = null, skew = null;
    if (median && q16 && q84 && median > 0) {
      // ~1σ band ≈ (q84 − q16)/2 expressed as % of median.
      impliedVolPctOfPrice = ((q84 - q16) / 2 / median) * 100;
      // Skew: asymmetry of the band around the median (>0 = right/upside fat tail).
      const up = q84 - median, dn = median - q16;
      skew = (up - dn) / (Math.abs(up) + Math.abs(dn) || 1);
    }
    return { median, q16, q84, impliedVolPctOfPrice, skew, points: pts };
  }

  // ── 3) Model distribution + mispricing rank ──────────────────────
  function spotFor(sym) {
    // Reuse whatever live price source is warm.
    try {
      const t = window._sharedTickerCache?.data?.find?.(x => x.instrument_name === `${sym}USD`);
      if (t && t.last > 0) return t.last;
    } catch (_) {}
    try {
      const px = window.DerivativesFeed?.get?.(sym)?.oiUsd ? null : null; // no price there
    } catch (_) {}
    try {
      const opt = window.OptionsGammaFeed?.get?.(sym);
      if (opt && opt.spot > 0) return opt.spot;
    } catch (_) {}
    return null;
  }
  function annualVolFor(sym) {
    // Prefer Deribit ATM IV (already annualized %), else a coarse default by coin.
    try {
      const opt = window.OptionsGammaFeed?.get?.(sym);
      if (opt && Number.isFinite(opt.atmIv) && opt.atmIv > 0) return opt.atmIv / 100;
    } catch (_) {}
    const fallback = { BTC: 0.5, ETH: 0.65, SOL: 0.9, XRP: 0.85 };
    return fallback[sym] ?? 0.7;
  }
  function modelProbAbove(spot, strike, sigmaAnnual, hoursToExpiry) {
    if (!(spot > 0 && strike > 0 && sigmaAnnual > 0 && hoursToExpiry > 0)) return null;
    const T = hoursToExpiry / (365 * 24);
    const sigT = sigmaAnnual * Math.sqrt(T);
    // Lognormal (driftless): P(S_T > K) = N( ln(S/K)/sigT − sigT/2 )
    const d = (Math.log(spot / strike)) / sigT - 0.5 * sigT;
    return normCdf(d);
  }
  function rankMispricing(sym, ladder) {
    const spot = spotFor(sym);
    if (!spot) return null;
    const sigma = annualVolFor(sym);
    const hrs = Math.max((new Date(ladder.ct).getTime() - Date.now()) / 3600000, 0.1);
    const ranked = [];
    for (const m of ladder.ms) {
      if (m.liquidity < MIN_CONTRACT_LIQUIDITY) continue;
      const model = modelProbAbove(spot, m.strike, sigma, hrs);
      if (model == null) continue;
      const edge = (model - m.pAbove) * 100; // +edge → market underprices "above"
      ranked.push({ ticker: m.ticker, strike: m.strike, marketProbAbove: m.pAbove, modelProbAbove: model, edgePp: edge, liquidity: m.liquidity });
    }
    if (!ranked.length) return null;
    ranked.sort((a, b) => Math.abs(b.edgePp) - Math.abs(a.edgePp));
    return { spot, sigmaAnnual: sigma, hoursToExpiry: hrs, best: ranked[0], all: ranked.slice(0, 6) };
  }

  // ── per-coin orchestration ────────────────────────────────────────
  async function fetchCoin(sym) {
    const divergence = divergenceFor(sym);
    let ladder = null, implied = null, mispricing = null;
    try {
      const raw = await fetchLadder(sym);
      if (raw) {
        ladder = { series: raw.series, expiry: raw.ct, strikes: raw.ms.length };
        implied = impliedFromLadder(raw);
        mispricing = rankMispricing(sym, raw);
      }
    } catch (_) {}

    const state = { sym, ts: Date.now(), divergence, impliedDistribution: implied, ladder, mispricing, available: !!(divergence || implied) };
    CACHE[sym] = state;
    emitEnvelope(state);
    if (state.available) {
      try { window.DataLogger?.logPredictionEdge?.(sym, {
        kalshiYes: divergence?.kalshiYes, polyYes: divergence?.polyYes,
        divergencePp: divergence?.gapPp, actionable: divergence?.actionable,
        impliedMedian: implied?.median, impliedVolPct: implied?.impliedVolPctOfPrice,
        impliedSkew: implied?.skew, bestMispricedTicker: mispricing?.best?.ticker,
        bestEdgePp: mispricing?.best?.edgePp, ts: state.ts,
      }); } catch (_) {}
    }
    return state;
  }

  function emitEnvelope(state) {
    const envelope = {
      envelope_id: `pmedge:${state.sym}:${state.ts}:${Math.floor(Math.random() * 1e6)}`,
      source: 'prediction-market-edge',
      received_ts: new Date(state.ts).toISOString(),
      chain_ts: null,
      type: 'prediction_edge_snapshot',
      raw: null,
      parsed: {
        symbol: state.sym,
        kalshi_yes: state.divergence?.kalshiYes ?? null,
        poly_yes: state.divergence?.polyYes ?? null,
        divergence_pp: state.divergence?.gapPp ?? null,
        divergence_actionable: state.divergence?.actionable ?? false,
        implied_median: state.impliedDistribution?.median ?? null,
        implied_vol_pct: state.impliedDistribution?.impliedVolPctOfPrice ?? null,
        implied_skew: state.impliedDistribution?.skew ?? null,
        best_mispriced_ticker: state.mispricing?.best?.ticker ?? null,
        best_edge_pp: state.mispricing?.best?.edgePp ?? null,
      },
      provenance: { module: 'prediction-market-edge', ladderSeries: state.ladder?.series || null },
      schema_version: 'v1',
    };
    window.dispatchEvent(new CustomEvent('market-data-envelope', { detail: envelope }));
  }

  async function fetchAll() {
    const detail = {};
    for (const sym of COINS) {
      try { detail[sym] = await fetchCoin(sym); } catch (_) {}
    }
    window.dispatchEvent(new CustomEvent('prediction-edge-update', { detail }));
    return detail;
  }

  const PredictionMarketEdge = {
    POLL_MS,
    get(sym) { return CACHE[sym] || null; },
    getAll() { return { ...CACHE }; },
    setLadderSeries(map) { if (map && typeof map === 'object') LADDER_SERIES = { ...LADDER_SERIES, ...map }; },
    fetchAll,
    start() {
      if (_timer) return;
      // Let PredictionMarkets warm first so divergence has data.
      setTimeout(fetchAll, 4000);
      _timer = setInterval(() => { if (!document.hidden) fetchAll(); }, POLL_MS);
    },
    stop() { clearInterval(_timer); _timer = null; },
  };

  window.PredictionMarketEdge = PredictionMarketEdge;
})();
