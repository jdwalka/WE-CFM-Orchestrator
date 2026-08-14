/**
 * Inference Truth Guard — source-of-truth gate for LLM / ASI1 calls mid-contract.
 *
 * Raw Polymarket + spot data can **nullify** an AI directional call when it
 * contradicts live price-vs-PTB, CLOB mid, and book pressure. UI and signal
 * paths must prefer the returned `effectiveCall` and respect `nullified`.
 *
 * window.InferenceTruthGuard.evaluate({ call, confidence, market, modelScore })
 * window.InferenceTruthGuard.watch(sym, brief) — continuous re-check
 * events: inference:truth (detail = verdict)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.InferenceTruthGuard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Market yesProb edge needed to count as a strong crowd signal
  const MKT_EDGE = Number(typeof window !== 'undefined' && window.__TRUTH_MKT_EDGE) || 0.10;
  // Spot % past PTB to count as clear path direction
  const PATH_EDGE_PCT = Number(typeof window !== 'undefined' && window.__TRUTH_PATH_EDGE) || 0.00015; // 1.5 bps
  // Book imbalance |z| to count
  const BOOK_EDGE = 0.12;
  // How many independent truth votes must oppose AI to nullify
  const NULLIFY_VOTES = 2;
  // Soft downweight if only one vote opposes
  const SOFT_WEIGHT = 0.25;

  const _watch = {}; // `${sym}:${horizon}` -> last verdict

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function normCall(c) {
    const u = String(c || '').toUpperCase().trim();
    if (u === 'UP' || u === 'BUY_UP' || u === 'YES' || u === 'LONG') return 'UP';
    if (u === 'DOWN' || u === 'BUY_DOWN' || u === 'NO' || u === 'SHORT') return 'DOWN';
    return null;
  }

  /**
   * Pull live market context for a symbol (poly5m preferred for short, else 15m).
   */
  function resolveMarket(sym, preferHorizon) {
    const coin = (typeof window !== 'undefined' && window.PredictionMarkets?.getCoin?.(sym)) || {};
    const p5 = coin.poly5m || null;
    const p15 = coin.poly15m || null;
    let m = null;
    let horizon = '15m';
    if (preferHorizon === '5m' && p5?.slug) { m = p5; horizon = '5m'; }
    else if (preferHorizon === '15m' && p15?.slug) { m = p15; horizon = '15m'; }
    else if (p5?.slug) { m = p5; horizon = '5m'; }
    else if (p15?.slug) { m = p15; horizon = '15m'; }

    if (!m) return null;

    const spot = Number(
      (typeof window !== 'undefined' && (
        window.PythBrowser?.getPrice?.(sym)
        || window._rtiPrices?.[sym]?.price
      ))
      || m.currentPriceNum
      || m.currentPrice
      || 0
    );
    const ptb = Number(m.priceToBeatNum || m.targetPriceNum || 0);
    const yes = Number(m.probability ?? m.upProbability ?? m.yesProb ?? m.clobProbability);
    const mid = Number(m.mid);
    const imb = Number(m.depthImbalance);

    return {
      sym: String(sym || '').toUpperCase(),
      horizon,
      slug: m.slug || null,
      spot: Number.isFinite(spot) && spot > 0 ? spot : null,
      ptb: Number.isFinite(ptb) && ptb > 0 ? ptb : null,
      yesProb: Number.isFinite(yes) ? clamp(yes, 0, 1) : null,
      mid: Number.isFinite(mid) ? mid : null,
      depthImbalance: Number.isFinite(imb) ? imb : null,
      bestBid: m.bestBid ?? null,
      bestAsk: m.bestAsk ?? null,
      secondsToClose: m.secondsToClose ?? null,
      liveDirection: m.liveDirection || null,
    };
  }

  /**
   * Build independent "truth votes" from raw data.
   * Each vote: { source, call: UP|DOWN, strength: 0..1, detail }
   */
  function collectTruthVotes(market) {
    const votes = [];
    if (!market) return votes;

    // 1) Spot vs PTB path (settlement definition)
    if (market.spot != null && market.ptb != null && market.ptb > 0) {
      const delta = market.spot - market.ptb;
      const pct = delta / market.ptb;
      if (Math.abs(pct) >= PATH_EDGE_PCT) {
        votes.push({
          source: 'spot_vs_ptb',
          call: delta > 0 ? 'UP' : 'DOWN',
          strength: clamp(Math.abs(pct) / (PATH_EDGE_PCT * 8), 0.35, 1),
          detail: `spot ${delta > 0 ? '+' : ''}${(pct * 100).toFixed(3)}% vs PTB`,
        });
      }
    }

    // 2) Explicit liveDirection from prediction-markets if present
    const ld = String(market.liveDirection || '').toUpperCase();
    if (ld === 'UP' || ld === 'DOWN') {
      votes.push({
        source: 'live_direction',
        call: ld,
        strength: 0.7,
        detail: `liveDirection=${ld}`,
      });
    }

    // 3) CLOB / Gamma P(Up) mid
    const p = market.yesProb != null ? market.yesProb
      : (market.mid != null ? market.mid : null);
    if (p != null && Math.abs(p - 0.5) >= MKT_EDGE) {
      votes.push({
        source: 'clob_mid',
        call: p >= 0.5 ? 'UP' : 'DOWN',
        strength: clamp(Math.abs(p - 0.5) / 0.35, 0.4, 1),
        detail: `P(Up)=${(p * 100).toFixed(1)}%`,
      });
    }

    // 4) Book depth imbalance (positive = bid-heavy → UP pressure)
    if (market.depthImbalance != null && Math.abs(market.depthImbalance) >= BOOK_EDGE) {
      votes.push({
        source: 'book_imbalance',
        call: market.depthImbalance > 0 ? 'UP' : 'DOWN',
        strength: clamp(Math.abs(market.depthImbalance), 0.3, 1),
        detail: `depthImbalance=${market.depthImbalance.toFixed(3)}`,
      });
    }

    return votes;
  }

  function majorityTruth(votes) {
    if (!votes.length) return { call: null, strength: 0, sources: [] };
    let up = 0;
    let down = 0;
    const sources = [];
    for (const v of votes) {
      const w = v.strength || 0.5;
      if (v.call === 'UP') up += w;
      else if (v.call === 'DOWN') down += w;
      sources.push(v.source);
    }
    if (up === down) return { call: null, strength: 0, sources, up, down };
    return {
      call: up > down ? 'UP' : 'DOWN',
      strength: clamp(Math.abs(up - down) / Math.max(up + down, 1e-6), 0, 1),
      sources,
      up,
      down,
    };
  }

  /**
   * @param {object} input
   * @param {string} input.call - AI call UP|DOWN
   * @param {number} [input.confidence] - 0..1
   * @param {string} [input.sym]
   * @param {object} [input.market] - optional prebuilt market context
   * @param {string} [input.horizon] - '5m'|'15m'
   * @param {number} [input.modelScore] - prediction engine score [-1,1]
   */
  function evaluate(input = {}) {
    const aiCall = normCall(input.call);
    const conf = clamp(Number(input.confidence ?? 0.55), 0, 1);
    const sym = String(input.sym || input.market?.sym || '').toUpperCase();
    const market = input.market || (sym ? resolveMarket(sym, input.horizon) : null);
    const votes = collectTruthVotes(market);

    // Optional: model score from prediction engine as another vote (not LLM)
    const ms = Number(input.modelScore);
    if (Number.isFinite(ms) && Math.abs(ms) >= 0.12) {
      votes.push({
        source: 'model_score',
        call: ms > 0 ? 'UP' : 'DOWN',
        strength: clamp(Math.abs(ms), 0.3, 1),
        detail: `score=${ms.toFixed(3)}`,
      });
    }

    const truth = majorityTruth(votes);
    const opposing = votes.filter((v) => aiCall && v.call && v.call !== aiCall);
    const supporting = votes.filter((v) => aiCall && v.call && v.call === aiCall);

    let nullified = false;
    let soft = false;
    let reason = '';
    let weight = 1;
    let effectiveCall = aiCall;
    let sourceOfTruth = 'llm';

    if (!aiCall) {
      // No AI call — use truth if any
      effectiveCall = truth.call;
      sourceOfTruth = truth.call ? 'raw_data' : 'none';
      reason = truth.call ? 'no_ai_call_use_raw' : 'no_signal';
    } else if (opposing.length >= NULLIFY_VOTES && truth.call && truth.call !== aiCall) {
      nullified = true;
      weight = 0;
      effectiveCall = truth.call;
      sourceOfTruth = 'raw_data';
      reason = `nullified: AI=${aiCall} opposed by ${opposing.map((v) => v.source).join('+')} → truth=${truth.call}`;
    } else if (opposing.length === 1 && truth.call && truth.call !== aiCall) {
      soft = true;
      weight = SOFT_WEIGHT;
      // Keep AI label but heavily downweight; surface truth as alternate
      effectiveCall = aiCall;
      sourceOfTruth = 'llm_soft_conflict';
      reason = `soft: AI=${aiCall} vs ${opposing[0].source}(${opposing[0].call}) — weight=${SOFT_WEIGHT}`;
    } else if (supporting.length && (!truth.call || truth.call === aiCall)) {
      reason = `confirmed by ${supporting.map((v) => v.source).join('+')}`;
      sourceOfTruth = 'llm+raw';
      weight = 1;
    } else {
      reason = 'insufficient_raw_edge';
      sourceOfTruth = 'llm';
      weight = conf >= 0.55 ? 0.85 : 0.5;
    }

    // Late window: if path is decisive and fights AI, hard nullify even on 1 strong path vote
    const ttc = market?.secondsToClose;
    const pathVote = votes.find((v) => v.source === 'spot_vs_ptb');
    if (
      !nullified
      && aiCall
      && pathVote
      && pathVote.call !== aiCall
      && pathVote.strength >= 0.55
      && ttc != null
      && ttc <= 120
    ) {
      nullified = true;
      soft = false;
      weight = 0;
      effectiveCall = pathVote.call;
      sourceOfTruth = 'raw_data_late_window';
      reason = `late-window nullify: path ${pathVote.detail} fights AI=${aiCall}`;
    }

    const verdict = {
      ts: Date.now(),
      sym,
      horizon: market?.horizon || input.horizon || null,
      slug: market?.slug || null,
      aiCall,
      effectiveCall,
      truthCall: truth.call,
      nullified,
      soft,
      weight,
      confidence: nullified ? Math.round(truth.strength * 100) / 100 : conf * weight,
      sourceOfTruth,
      reason,
      votes,
      supporting: supporting.map((v) => v.source),
      opposing: opposing.map((v) => v.source),
      market: market ? {
        spot: market.spot,
        ptb: market.ptb,
        yesProb: market.yesProb,
        depthImbalance: market.depthImbalance,
        secondsToClose: market.secondsToClose,
      } : null,
    };

    if (sym) {
      _watch[`${sym}:${verdict.horizon || 'x'}`] = verdict;
    }

    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('inference:truth', { detail: verdict }));
      }
    } catch (_) { /* */ }

    if (nullified) {
      console.warn(`[TruthGuard] ${sym} ${reason}`);
    }

    return verdict;
  }

  /**
   * Evaluate a full ASI1/LLM brief object; returns brief patched with truth fields.
   */
  function gateBrief(brief, opts = {}) {
    if (!brief) return brief;
    const call = brief.call || brief.direction;
    const verdict = evaluate({
      call,
      confidence: brief.confidence,
      sym: brief.sym,
      horizon: brief.horizon || opts.horizon,
      market: opts.market || brief.market,
      modelScore: opts.modelScore,
    });

    const notes = String(brief.primaryRationale || brief.notes || '');
    const originalAi = brief.aiCallOriginal || normCall(call);
    const gated = {
      ...brief,
      call: verdict.nullified ? verdict.effectiveCall : (originalAi || verdict.effectiveCall),
      aiCallOriginal: originalAi,
      confidence: verdict.confidence,
      nullified: verdict.nullified,
      softConflict: verdict.soft,
      truthWeight: verdict.weight,
      sourceOfTruth: verdict.sourceOfTruth,
      truthReason: verdict.reason,
      truthCall: verdict.truthCall,
      truthVotes: verdict.votes,
      notes: verdict.nullified
        ? `⛔ NULLIFIED (${verdict.reason}). Raw truth: ${verdict.effectiveCall}. Was AI: ${originalAi}. ${notes}`.slice(0, 700)
        : (verdict.soft
          ? `⚠ soft conflict — ${verdict.reason}. ${notes}`.slice(0, 700)
          : notes),
    };
    return gated;
  }

  function getLast(sym, horizon) {
    const s = String(sym || '').toUpperCase();
    if (horizon) return _watch[`${s}:${horizon}`] || null;
    return _watch[`${s}:5m`] || _watch[`${s}:15m`] || _watch[`${s}:x`] || null;
  }

  function renderBadgeHtml(verdictOrBrief) {
    const v = verdictOrBrief;
    if (!v) return '';
    if (v.nullified) {
      return `<span style="font-size:8px;padding:1px 6px;border-radius:999px;background:rgba(255,82,82,0.2);color:#ff8a80;font-weight:800;">⛔ NULLIFIED → ${String(v.effectiveCall || v.truthCall || '').toUpperCase()}</span>`;
    }
    if (v.softConflict || v.soft) {
      return `<span style="font-size:8px;padding:1px 6px;border-radius:999px;background:rgba(255,193,7,0.15);color:#ffe082;font-weight:700;">⚠ RAW CONFLICT</span>`;
    }
    if (v.sourceOfTruth === 'llm+raw') {
      return `<span style="font-size:8px;padding:1px 6px;border-radius:999px;background:rgba(0,230,118,0.12);color:#69f0ae;font-weight:700;">✓ RAW OK</span>`;
    }
    return '';
  }

  return {
    evaluate,
    gateBrief,
    resolveMarket,
    collectTruthVotes,
    getLast,
    renderBadgeHtml,
    constants: { MKT_EDGE, PATH_EDGE_PCT, BOOK_EDGE, NULLIFY_VOTES, SOFT_WEIGHT },
  };
}));
