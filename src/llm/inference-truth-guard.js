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

  const MKT_EDGE = Number(typeof window !== 'undefined' && window.__TRUTH_MKT_EDGE) || 0.10;
  const PATH_EDGE_PCT = Number(typeof window !== 'undefined' && window.__TRUTH_PATH_EDGE) || 0.00015;
  const BOOK_EDGE = 0.12;
  const NULLIFY_VOTES = 2;
  const SOFT_WEIGHT = 0.25;

  const _watch = new Map();

  const _accessors = {
    getCoin: (sym) => (typeof window !== 'undefined' && window.PredictionMarkets?.getCoin?.(sym)) || {},
    getPythSpot: (sym) => {
      try {
        if (typeof window !== 'undefined' && window.OracleSnapshot?.getPythSpot) {
          const p = window.OracleSnapshot.getPythSpot(sym);
          if (p?.price > 0) return p.price;
        }
      } catch (_) { /* */ }
      return null;
    },
    getPythPriceFallback: (sym) => {
      if (typeof window === 'undefined') return null;
      const symKey = String(sym || '').toUpperCase();
      const v = window.PythBrowser?.getPrice?.(sym) ?? (window._pythPrices && typeof symKey === 'string' && Object.prototype.hasOwnProperty.call(window._pythPrices, symKey) ? window._pythPrices[symKey] : null);
      return Number.isFinite(Number(v)) ? Number(v) : null;
    },
  };

  function configure(overrides = {}) {
    Object.assign(_accessors, overrides);
  }

  function _debugEnabled() {
    return typeof window === 'undefined' || window.__TRUTH_DEBUG !== false;
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function normCall(c) {
    const u = String(c || '').toUpperCase().trim();
    if (u === 'UP' || u === 'BUY_UP' || u === 'YES' || u === 'LONG') return 'UP';
    if (u === 'DOWN' || u === 'BUY_DOWN' || u === 'NO' || u === 'SHORT') return 'DOWN';
    return null;
  }

  function resolveMarket(sym, preferHorizon) {
    const coin = _accessors.getCoin(sym) || {};
    const p5 = coin.poly5m || null;
    const p15 = coin.kalshi15m || null;
    const p60 = coin.poly60m || null;
    let m = null;
    let horizon = '15m';
    if (preferHorizon === '5m' && p5?.slug) { m = p5; horizon = '5m'; }
    else if (preferHorizon === '15m' && p15?.ticker) { m = p15; horizon = '15m'; }
    else if ((preferHorizon === '60m' || preferHorizon === '1h' || preferHorizon === 'hourly') && p60?.slug) { m = p60; horizon = '60m'; }
    else if (p5?.slug) { m = p5; horizon = '5m'; }
    else if (p15?.ticker) { m = p15; horizon = '15m'; }
    else if (p60?.slug) { m = p60; horizon = '60m'; }

    if (!m) return null;

    let spot = _accessors.getPythSpot(sym) || NaN;
    if (!(spot > 0)) {
      spot = Number(_accessors.getPythPriceFallback(sym) || m.currentPriceNum || 0);
    }
    const rawPtb = Number(m.priceToBeatNum || m.targetPriceNum || 0);
    const ptbSrc = String(m.priceToBeatSource || m.ptbSource || '').toLowerCase();
    const ptbRejected = /rtds|twap|title|provisional|coinbase|binance|gecko|rti|crypto-price|boundary|rejected:|chainlink-candles/.test(ptbSrc);
    const ptb = (!ptbRejected && Number.isFinite(rawPtb) && rawPtb > 0) ? rawPtb : NaN;
    const tradeFlowRatio = Number(m.tradeFlowRatio ?? m.tradeFlow ?? 0.5);
    const volumeDelta = Number(m.volumeDelta ?? 0);
    const spread = (Number(m.bestAsk) && Number(m.bestBid)) ? (Number(m.bestAsk) - Number(m.bestBid)) : null;
    const spotVelocity = Number(m.spotVelocity ?? m.velocity ?? 0);

    return {
      sym: String(sym || '').toUpperCase(),
      horizon,
      slug: m.ticker || m.slug || null,
      spot: Number.isFinite(spot) && spot > 0 ? spot : null,
      ptb: Number.isFinite(ptb) && ptb > 0 ? ptb : null,
      yesProb: Number.isFinite(yes) ? clamp(yes, 0, 1) : null,
      mid: Number.isFinite(mid) ? mid : null,
      depthImbalance: Number.isFinite(imb) ? imb : null,
      bestBid: m.bestBid ?? null,
      bestAsk: m.bestAsk ?? null,
      spread: Number.isFinite(spread) ? spread : null,
      tradeFlowRatio: Number.isFinite(tradeFlowRatio) ? tradeFlowRatio : 0.5,
      volumeDelta: Number.isFinite(volumeDelta) ? volumeDelta : 0,
      spotVelocity: Number.isFinite(spotVelocity) ? spotVelocity : 0,
      secondsToClose: m.secondsToClose ?? null,
      liveDirection: m.liveDirection || null,
    };
  }

  /**
   * Anti-Spoofing Engine: Detects fake or ghost orderbook walls.
   * Prevents false positives caused by non-executable flash liquidity.
   */
  function detectOrderbookSpoofing(market) {
    if (!market || market.depthImbalance == null) {
      return { isSpoofed: false, reason: null, confidenceMultiplier: 1.0 };
    }

    const imb = market.depthImbalance;
    const flow = market.tradeFlowRatio;
    const spread = market.spread;

    // 1. Ghost Wall Divergence: Extreme book depth opposite to actual executed trade flow
    if (imb > 0.60 && flow < 0.35) {
      return {
        isSpoofed: true,
        reason: `Ghost Bid Wall (Imbalance +${imb.toFixed(2)} vs Aggressor Sell Flow ${(flow * 100).toFixed(0)}%)`,
        confidenceMultiplier: 0.15,
      };
    }
    if (imb < -0.60 && flow > 0.65) {
      return {
        isSpoofed: true,
        reason: `Ghost Ask Wall (Imbalance ${imb.toFixed(2)} vs Aggressor Buy Flow ${(flow * 100).toFixed(0)}%)`,
        confidenceMultiplier: 0.15,
      };
    }

    // 2. Wide Spread Depth Illusion: High imbalance in illiquid / wide spreads
    if (spread != null && spread > 0.08 && Math.abs(imb) > 0.50) {
      return {
        isSpoofed: true,
        reason: `Illiquid Spread Trap (Spread ${(spread * 100).toFixed(1)}c with fake wall ${imb > 0 ? 'Bid' : 'Ask'})`,
        confidenceMultiplier: 0.25,
      };
    }

    return { isSpoofed: false, reason: null, confidenceMultiplier: 1.0 };
  }

  /**
   * AI Lookahead Engine: Computes projected contract path at expiration
   * and sets dynamic lookahead error tolerances based on remaining seconds.
   */
  function computeLookaheadTrajectory(market) {
    if (!market || !market.spot || !market.ptb || market.secondsToClose == null) {
      return null;
    }

    const ttc = market.secondsToClose;
    const velocity = market.spotVelocity || 0; // price change per second
    const projectedSpot = market.spot + (velocity * Math.min(ttc, 300));
    const projectedDelta = projectedSpot - market.ptb;
    const projectedPct = projectedDelta / market.ptb;

    // Dynamic tolerances: tighter as expiration nears
    let lookaheadTolerance = 0.0006; // default 0.06% for early candle
    if (ttc <= 45) {
      lookaheadTolerance = 0.0001; // ultra-tight for final 45s
    } else if (ttc <= 120) {
      lookaheadTolerance = 0.00025; // tight for final 2m
    } else if (ttc <= 300) {
      lookaheadTolerance = 0.00045; // moderate
    }

    const projectedCall = Math.abs(projectedPct) >= lookaheadTolerance
      ? (projectedDelta > 0 ? 'UP' : 'DOWN')
      : null;

    return {
      ttc,
      velocity,
      projectedSpot,
      projectedDelta,
      projectedPct,
      projectedCall,
      lookaheadTolerance,
      strength: clamp(Math.abs(projectedPct) / (lookaheadTolerance * 4), 0.35, 1.0),
    };
  }

  function collectTruthVotes(market) {
    const votes = [];
    if (!market) return votes;

    // 1. Current Spot vs Settlement PTB
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

    // 2. Lookahead Projected Path
    const lookahead = computeLookaheadTrajectory(market);
    if (lookahead && lookahead.projectedCall) {
      votes.push({
        source: 'lookahead_trajectory',
        call: lookahead.projectedCall,
        strength: lookahead.strength,
        detail: `lookahead ${lookahead.ttc}s: projected ${lookahead.projectedDelta > 0 ? '+' : ''}${(lookahead.projectedPct * 100).toFixed(3)}% vs PTB (tol ${(lookahead.lookaheadTolerance * 100).toFixed(3)}%)`,
      });
    }

    // 3. Live Direction
    const ld = String(market.liveDirection || '').toUpperCase();
    if (ld === 'UP' || ld === 'DOWN') {
      votes.push({ source: 'live_direction', call: ld, strength: 0.7, detail: `liveDirection=${ld}` });
    }

    // 4. CLOB Mid-Price
    const p = market.yesProb != null ? market.yesProb : (market.mid != null ? market.mid : null);
    if (p != null && Math.abs(p - 0.5) >= MKT_EDGE) {
      votes.push({
        source: 'clob_mid',
        call: p >= 0.5 ? 'UP' : 'DOWN',
        strength: clamp(Math.abs(p - 0.5) / 0.35, 0.4, 1),
        detail: `P(Up)=${(p * 100).toFixed(1)}%`,
      });
    }

    // 5. Orderbook Imbalance with Spoofing Guard
    if (market.depthImbalance != null && Math.abs(market.depthImbalance) >= BOOK_EDGE) {
      const spoofCheck = detectOrderbookSpoofing(market);
      const rawCall = market.depthImbalance > 0 ? 'UP' : 'DOWN';
      
      if (spoofCheck.isSpoofed) {
        votes.push({
          source: 'book_imbalance_spoofed',
          call: rawCall,
          strength: clamp(Math.abs(market.depthImbalance) * spoofCheck.confidenceMultiplier, 0.05, 0.25),
          detail: `[SPOOF DETECTED] ${spoofCheck.reason} — downweighted`,
          spoofed: true,
        });
      } else {
        votes.push({
          source: 'book_imbalance',
          call: rawCall,
          strength: clamp(Math.abs(market.depthImbalance), 0.3, 1),
          detail: `depthImbalance=${market.depthImbalance.toFixed(3)} (Flow confirmed)`,
          spoofed: false,
        });
      }
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

  function evaluate(input = {}) {
    const aiCall = normCall(input.call);
    const conf = clamp(Number(input.confidence ?? 0.55), 0, 1);
    const sym = String(input.sym || input.market?.sym || '').toUpperCase();
    const market = input.market || (sym ? resolveMarket(sym, input.horizon) : null);

    const Calibrator = (typeof window !== 'undefined' && window.SignalCalibrator)
      || (typeof globalThis !== 'undefined' && globalThis.SignalCalibrator)
      || null;
    if (Calibrator && typeof Calibrator.blend === 'function') {
      const blended = Calibrator.blend({
        ...input,
        call: aiCall,
        confidence: conf,
        sym,
        market: market || input.market,
        modelScore: input.modelScore,
        secondsToClose: market?.secondsToClose ?? input.secondsToClose,
      });
      const effectiveCall = blended.call || aiCall;
      const nullified = !!(aiCall && blended.call && blended.call !== aiCall && blended.source !== 'ai');
      return {
        ts: blended.ts,
        sym,
        horizon: market?.horizon || input.horizon || null,
        slug: market?.slug || null,
        aiCall,
        effectiveCall,
        nullified,
        soft: !nullified && blended.modelCapped,
        weight: nullified ? 0 : clamp(blended.confidence, 0, 1),
        confidence: blended.confidence,
        sourceOfTruth: blended.source,
        reason: blended.reason,
        pUp: blended.pUp,
        components: blended.components,
        modelCapped: blended.modelCapped,
        votes: (blended.components || []).map((c) => ({
          source: c.source,
          call: c.call,
          strength: c.weight,
          detail: c.detail,
        })),
        calibrator: true,
      };
    }

    const votes = collectTruthVotes(market);
    const ms = Number(input.modelScore);
    if (Number.isFinite(ms) && Math.abs(ms) >= 0.12) {
      votes.push({
        source: 'model_score',
        call: ms > 0 ? 'UP' : 'DOWN',
        strength: clamp(Math.abs(ms), 0.3, 1),
        detail: `score=${ms.toFixed(3)}`,
      });
    }

    const validVotes = votes.filter((v) => !v.spoofed);
    const truth = majorityTruth(validVotes);
    const opposing = validVotes.filter((v) => aiCall && v.call && v.call !== aiCall);
    const supporting = validVotes.filter((v) => aiCall && v.call && v.call === aiCall);
    const spoofDetected = votes.some((v) => v.spoofed);
    const lookaheadInfo = votes.find((v) => v.source === 'lookahead_trajectory');

    let nullified = false;
    let soft = false;
    let reason = '';
    let weight = 1;
    let effectiveCall = aiCall;
    let sourceOfTruth = 'llm';

    if (!aiCall) {
      effectiveCall = truth.call;
      sourceOfTruth = truth.call ? 'raw_data' : 'none';
      reason = truth.call ? 'no_ai_call_use_raw' : 'no_signal';
    } else if (opposing.length >= NULLIFY_VOTES && truth.call && truth.call !== aiCall) {
      nullified = true;
      weight = 0;
      effectiveCall = truth.call;
      sourceOfTruth = 'raw_data';
      reason = `nullified: AI=${aiCall} opposed by ${opposing.map((v) => v.source).join('+')} → truth=${truth.call}${spoofDetected ? ' [SPOOF_FILTERED]' : ''}`;
    } else if (opposing.some((v) => v.source === 'spot_vs_ptb') && truth.call && truth.call !== aiCall) {
      nullified = true;
      weight = 0;
      effectiveCall = opposing.find((v) => v.source === 'spot_vs_ptb').call;
      sourceOfTruth = 'raw_data_path';
      reason = `nullified: AI=${aiCall} vs spot_vs_ptb → ${effectiveCall}${spoofDetected ? ' [SPOOF_FILTERED]' : ''}`;
    } else if (opposing.length === 1 && truth.call && truth.call !== aiCall) {
      soft = true;
      weight = SOFT_WEIGHT;
      effectiveCall = aiCall;
      sourceOfTruth = 'llm_soft_conflict';
      reason = `soft: AI=${aiCall} vs ${opposing[0].source}(${opposing[0].call}) — weight=${SOFT_WEIGHT}${spoofDetected ? ' [SPOOF_FILTERED]' : ''}`;
    } else if (supporting.length && (!truth.call || truth.call === aiCall)) {
      reason = `confirmed by ${supporting.map((v) => v.source).join('+')}${spoofDetected ? ' [SPOOF_FILTERED]' : ''}`;
      sourceOfTruth = 'llm+raw';
      weight = 1;
    } else {
      reason = spoofDetected ? 'insufficient_raw_edge [SPOOF_FILTERED]' : 'insufficient_raw_edge';
      sourceOfTruth = 'llm';
      weight = conf >= 0.55 ? 0.85 : 0.5;
    }

    const ttc = market?.secondsToClose;
    const pathVote = validVotes.find((v) => v.source === 'spot_vs_ptb');
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
      spoofDetected,
      lookahead: lookaheadInfo ? lookaheadInfo.detail : null,
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
        tradeFlowRatio: market.tradeFlowRatio,
        spread: market.spread,
        secondsToClose: market.secondsToClose,
      } : null,
    };

    if (sym) {
      _watch.set(`${sym}:${verdict.horizon || 'x'}`, verdict);
    }

    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('inference:truth', { detail: verdict }));
      }
    } catch (_) { /* */ }

    if (nullified && _debugEnabled()) {
      console.warn(`[TruthGuard] ${sym} ${reason}`);
    }

    return verdict;
  }

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
    if (horizon) return _watch.get(`${s}:${horizon}`) || null;
    return _watch.get(`${s}:5m`) || _watch.get(`${s}:15m`) || _watch.get(`${s}:x`) || null;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function renderBadgeHtml(verdictOrBrief) {
    const v = verdictOrBrief;
    if (!v) return '';
    let extra = '';
    if (v.spoofDetected) {
      extra += `<span style="font-size:8px;margin-left:4px;padding:1px 5px;border-radius:999px;background:rgba(255,152,0,0.2);color:#ffb74d;font-weight:700;">🛡 SPOOF FILTERED</span>`;
    }
    if (v.nullified) {
      return `<span style="font-size:8px;padding:1px 6px;border-radius:999px;background:rgba(255,82,82,0.2);color:#ff8a80;font-weight:800;">⛔ NULLIFIED → ${String(v.effectiveCall || v.truthCall || '').toUpperCase()}</span>${extra}`;
      const callText = escapeHtml(String(v.effectiveCall || v.truthCall || '').toUpperCase());
      return `<span style="font-size:8px;padding:1px 6px;border-radius:999px;background:rgba(255,82,82,0.2);color:#ff8a80;font-weight:800;">⛔ NULLIFIED → ${callText}</span>${extra}`;
    }
    if (v.softConflict || v.soft) {
      return `<span style="font-size:8px;padding:1px 6px;border-radius:999px;background:rgba(255,193,7,0.15);color:#ffe082;font-weight:700;">⚠ RAW CONFLICT</span>${extra}`;
    }
    if (v.sourceOfTruth === 'llm+raw') {
      return `<span style="font-size:8px;padding:1px 6px;border-radius:999px;background:rgba(0,230,118,0.12);color:#69f0ae;font-weight:700;">✓ RAW OK</span>${extra}`;
    }
    return extra;
  }

  return {
    evaluate,
    gateBrief,
    resolveMarket,
    collectTruthVotes,
    getLast,
    renderBadgeHtml,
    configure,
    constants: { MKT_EDGE, PATH_EDGE_PCT, BOOK_EDGE, NULLIFY_VOTES, SOFT_WEIGHT },
  };
}));
