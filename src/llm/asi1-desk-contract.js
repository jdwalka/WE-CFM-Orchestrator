/**
 * ASI1 Desk contract — LeakSnipe-style EV call for Polymarket Up/Down.
 *
 * Hole cards  = Pyth spot vs Polymarket PTB
 * Pot odds    = crowd P(Up) + CLOB mid vs path
 * Legal acts  = BUY_UP | BUY_DOWN | SIZE_DOWN | HOLD_FLAT
 * Judge EV, not settlement. Never invent a price.
 *
 * Browser + Node. inferLocal is the offline fallback when ASI1 is down.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.Asi1DeskContract = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODES = Object.freeze(['asi1_only', 'dual_fire', 'planner']);
  const ACTIONS = Object.freeze(['BUY_UP', 'BUY_DOWN', 'SIZE_DOWN', 'HOLD_FLAT']);
  const CALLS = Object.freeze(['UP', 'DOWN', '—']);
  const REGIMES = Object.freeze([
    'trend_continuation', 'mean_reversion', 'chop_noise', 'breakout_volatility',
  ]);
  const EDGES = Object.freeze(['with_crowd', 'fade_crowd', 'neutral']);
  const URGENCIES = Object.freeze(['now', 'wait_pullback', 'late_window']);
  const SIZES = Object.freeze(['full', 'half', 'skip']);

  const SYSTEM_PROMPT = [
    'You are ASI1 at the WeCrypto Polymarket Up/Down desk.',
    'Same standard as LeakSnipe: legal actions only, EV not results, numbers in the packet are law.',
    'Hole cards = spot vs priceToBeatNum (PTB). Pot odds = yesProb and CLOB mid vs that path.',
    'Legal actions: BUY_UP | BUY_DOWN | SIZE_DOWN | HOLD_FLAT.',
    'If a number is missing, HOLD_FLAT / skip and add a warning. Never invent spot, PTB, TTC, or P(Up).',
    'Start notes with UP or DOWN (or HOLD_FLAT). Cite spot, PTB, TTC, yesProb, imbalance.',
    'Timing: secondsToClose is TTC in seconds, authoritative. urgency=late_window when TTC<90; ' +
      'urgency=now when TTC>=90 and the edge (deltaVsPtb vs yesProb, depthImbalance) is live and consistent; ' +
      'urgency=wait_pullback otherwise. spotAgeSec is how many seconds old the spot price is -- ' +
      'if spotAgeSec is large relative to TTC, treat spot as stale and prefer HOLD_FLAT over a timing call.',
    'derivPressure (-1..1) and derivLabel (e.g. CROWDED LONGS, SHORT LIQ CASCADE, OI BUILDING) are ' +
      'supplementary context from cross-venue perp positioning, never a hole card: positive pressure/' +
      'CROWDED LONGS or LONG LIQ CASCADE means a pullback risks forced long liquidations amplifying the ' +
      'down move; negative pressure/CROWDED SHORTS or SHORT LIQ CASCADE means a bounce risks a short-squeeze ' +
      'amplifying the up move. Only let it nudge confidence or urgency when it agrees with the spot-vs-PTB ' +
      'path; never let it override spot/PTB or invent a call alone.',
    'Return ONLY JSON matching the desk contract schema.',
  ].join(' ');

  const DESK_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: MODES.slice() },
      account_order: { type: 'array', items: { type: 'string' } },
      model_for_5m: { type: 'string' },
      model_for_15m: { type: 'string' },
      planner_on_5m: { type: 'boolean' },
      call: { type: 'string', enum: ['UP', 'DOWN', '—'] },
      action: { type: 'string', enum: ACTIONS.slice() },
      confidence: { type: 'number' },
      regime: { type: 'string', enum: REGIMES.slice() },
      edge_vs_crowd: { type: 'string', enum: EDGES.slice() },
      urgency: { type: 'string', enum: URGENCIES.slice() },
      size_hint: { type: 'string', enum: SIZES.slice() },
      invalidation: { type: 'string' },
      notes: { type: 'string' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'mode', 'account_order', 'model_for_5m', 'model_for_15m', 'planner_on_5m',
      'call', 'action', 'confidence', 'regime', 'edge_vs_crowd', 'urgency',
      'size_hint', 'invalidation', 'notes', 'warnings',
    ],
  };

  const RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
      name: 'desk_contract',
      strict: true,
      schema: DESK_SCHEMA,
    },
  };

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function pick(v, allowed, fallback) {
    const s = String(v || '').trim();
    return allowed.includes(s) ? s : fallback;
  }

  function normalizeMode(mode) {
    const s = String(mode || '').toLowerCase().trim();
    if (s === 'asi1-only' || s === 'economy') return 'asi1_only';
    if (s === 'dual' || s === 'dual-fire') return 'dual_fire';
    return MODES.includes(s) ? s : 'dual_fire';
  }

  function isFastPath(packet) {
    const horizon = String(packet?.horizon || '').toLowerCase().replace(/\s+/g, '');
    const ttc = num(packet?.secondsToClose);
    const is5m = horizon === '5m' || horizon === '5' || horizon.startsWith('5m-') || horizon === '5m-ptb';
    return is5m || (ttc != null && ttc < 90);
  }

  function selectModel(packet, mode) {
    if (isFastPath(packet)) return 'asi1-mini';
    if (normalizeMode(mode) === 'planner') return 'asi1';
    return 'asi1-ultra';
  }

  function plannerAllowed(packet, mode) {
    return normalizeMode(mode) === 'planner' && !isFastPath(packet);
  }

  function baseContract(mode) {
    return {
      mode: normalizeMode(mode),
      // icloud (mauro_fanelli@icloud.com, Pro tier as of 2026-08-22) is the
      // only account with real asi1-ultra token allowance -- gitgoin/mauro
      // both sit at a hard 0-token "eon" cap. Real key rotation lives in
      // asi1-client.js's ASI1_ACCOUNTS (icloud listed first); this order is
      // informational metadata only, kept consistent with that for accuracy.
      account_order: ['icloud', 'gitgoin', 'mauro'],
      model_for_5m: 'asi1-mini',
      model_for_15m: 'asi1-ultra',
      planner_on_5m: false,
    };
  }

  function holdContract(mode, warnings, notes) {
    return {
      ...baseContract(mode),
      call: '—',
      action: 'HOLD_FLAT',
      confidence: 0,
      regime: 'chop_noise',
      edge_vs_crowd: 'neutral',
      urgency: 'wait_pullback',
      size_hint: 'skip',
      invalidation: 'insufficient data',
      notes: notes || 'HOLD_FLAT. Missing required packet fields.',
      warnings: Array.isArray(warnings) ? warnings.slice() : [],
    };
  }

  function inferLocal(packet, mode) {
    const m = normalizeMode(mode);
    if (!packet || typeof packet !== 'object') {
      return holdContract(m, ['Invalid packet'], 'HOLD_FLAT. Invalid packet structure.');
    }
    const spot = num(packet.spot);
    const ptb = num(packet.priceToBeatNum);
    const yes = num(packet.yesProb);
    const mid = num(packet.mid);
    const spread = num(packet.spread);
    const imb = num(packet.depthImbalance) || 0;
    const notional = num(packet.nearTouchNotional) || 0;
    const ttc = num(packet.secondsToClose);
    const live = String(packet.liveDirection || packet.pathDir || '').toUpperCase();

    if (spot == null || spot <= 0 || ptb == null || ptb <= 0 || yes == null || mid == null) {
      return holdContract(m, ['Missing required fields (spot, priceToBeatNum, yesProb, mid)'], 'HOLD_FLAT. Missing or invalid spot / PTB from oracle feeds.');
    }

    const delta = spot - ptb;
    const deltaBps = ptb !== 0 ? (delta / ptb) * 10000 : 0;
    const path = delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : null;

    let regime = 'chop_noise';
    if (spread != null && spread > 0.05) regime = 'breakout_volatility';
    else if (Math.abs(deltaBps) >= 3) {
      regime = (!live || live === 'FLAT' || live === path) ? 'trend_continuation' : 'mean_reversion';
    }

    let edge = 'neutral';
    if (path === 'UP' && yes >= 0.52) edge = 'with_crowd';
    else if (path === 'UP' && yes <= 0.48) edge = 'fade_crowd';
    else if (path === 'DOWN' && yes <= 0.48) edge = 'with_crowd';
    else if (path === 'DOWN' && yes >= 0.52) edge = 'fade_crowd';

    let urgency = 'wait_pullback';
    if (ttc != null && ttc < 90) urgency = 'late_window';
    else if (Math.abs(deltaBps) >= 3 && Math.abs(imb) >= 0.1) urgency = 'now';

    let confidence = 0.45;
    if (path) confidence += 0.06;

    // ── Graviharmonic modulation ──────────────────────────────────────────
    const gh = packet.graviharmonic;
    if (gh) {
      if (gh.isEscaped && gh.harmonicCoherence >= 60) confidence += 0.05;
      if (gh.resonantRegime && gh.resonantRegime.includes('BREAKOUT')) regime = 'breakout_volatility';
      if (gh.resonantRegime && gh.resonantRegime.includes('DESTRUCTIVE')) confidence -= 0.05;
      if (gh.bindingStrength === 'HIGH_GRAVITY_CORE') regime = 'mean_reversion';
    }

    // ── Orbital Foresight Engine modulation ──────────────────────────────
    const ofe = packet.foresight;
    let ofeTag = '';
    if (ofe && !ofe.scanStale) {
      const vec = String(ofe.foresightVector || 'neutral').toUpperCase();
      const ofeConf = typeof ofe.foresightConfidence === 'number' ? ofe.foresightConfidence : 0;
      if (path && vec === path && ofeConf >= 0.55) confidence += 0.04 * ofeConf;
      if (path && vec !== 'NEUTRAL' && vec !== path && ofeConf >= 0.6) confidence -= 0.03;
      if (ofe.macroRegime && ofeConf >= 0.65) {
        if (ofe.macroRegime === 'volatile') regime = 'breakout_volatility';
        else if (ofe.macroRegime === 'trending') regime = 'trend_continuation';
        else if (ofe.macroRegime === 'ranging') regime = 'mean_reversion';
      }
      const smb = String(ofe.smartMoneyBias || '').toLowerCase();
      if (path === 'UP' && smb === 'bullish' && ofeConf >= 0.5) confidence += 0.02;
      if (path === 'DOWN' && smb === 'bearish' && ofeConf >= 0.5) confidence += 0.02;
      const ageS = ofe.scanAgeMs != null ? Math.round(ofe.scanAgeMs / 1000) : null;
      ofeTag = ` [OFE: ${ofe.macroRegime}/${vec}@${(ofeConf * 100).toFixed(0)}%${ageS != null ? ` ${ageS}s ago` : ''}]`;
    } else if (ofe && ofe.scanStale) {
      confidence -= 0.02;
      ofeTag = ' [OFE: STALE]';
    }

    confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;

    let call = '—';
    let action = 'HOLD_FLAT';
    let sizeHint = 'skip';
    if (path && confidence >= 0.55) {
      call = path;
      if (confidence >= 0.60) {
        action = path === 'UP' ? 'BUY_UP' : 'BUY_DOWN';
        sizeHint = confidence >= 0.72 ? 'full' : 'half';
      } else {
        action = 'SIZE_DOWN';
        sizeHint = 'half';
      }
    }

    let invalidation = 'no path';
    if (call === 'UP') {
      invalidation = `spot drops below ${ptb} or yesProb falls under ${(yes - 0.03).toFixed(2)}`;
    } else if (call === 'DOWN') {
      invalidation = `spot rises above ${ptb} or yesProb exceeds ${(yes + 0.03).toFixed(2)}`;
    }

    const graviTag = gh ? ` [Gravi: ${gh.resonantRegime}, Coherence: ${gh.harmonicCoherence}%, Escape: ${gh.escapeRatio}x]` : '';

    let notes;
    if (call === 'UP') {
      notes = `UP. Spot ${spot} sits ${delta.toFixed(1)} above PTB ${ptb} with ${ttc ?? '?'}s to close. YesProb ${yes.toFixed(2)} and mid ${mid.toFixed(3)} align upward. Depth imbalance ${imb.toFixed(2)} and near-touch notional ${notional} support buying.${graviTag}${ofeTag} Fade only if spot pierces PTB.`;
    } else if (call === 'DOWN') {
      notes = `DOWN. Spot ${spot} sits ${Math.abs(delta).toFixed(1)} below PTB ${ptb} with ${ttc ?? '?'}s to close. YesProb ${yes.toFixed(2)} and mid ${mid.toFixed(3)} suggest downside. Depth imbalance ${imb.toFixed(2)} and near-touch notional ${notional} support selling.${graviTag}${ofeTag} Fade only if spot pierces PTB.`;
    } else {
      notes = `HOLD_FLAT. Spot ${spot} vs PTB ${ptb} shows insufficient edge. YesProb ${yes.toFixed(2)} and mid ${mid.toFixed(3)} offer no clear direction.${graviTag}${ofeTag} No legal action with positive EV.`;
    }

    return {
      ...baseContract(m),
      call,
      action,
      confidence,
      regime,
      edge_vs_crowd: edge,
      urgency,
      size_hint: sizeHint,
      invalidation,
      notes,
      warnings: [],
      _meta: {
        model: selectModel(packet, m),
        account: selectModel(packet, m) === 'asi1-ultra' ? 'icloud' : 'mauro',
        source: 'inferLocal',
      },
    };
  }

  function normalizeContract(raw, mode, packet) {
    const fallback = inferLocal(packet || {}, mode);
    if (!raw || typeof raw !== 'object') return fallback;
    const m = normalizeMode(raw.mode || mode);
    const call = pick(raw.call, CALLS, fallback.call);
    const action = pick(raw.action, ACTIONS, fallback.action);
    let conf = num(raw.confidence);
    if (conf == null) conf = fallback.confidence;
    if (conf > 1) conf = conf / 100;
    conf = Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100;
    return {
      ...baseContract(m),
      call,
      action,
      confidence: conf,
      regime: pick(raw.regime, REGIMES, fallback.regime),
      edge_vs_crowd: pick(raw.edge_vs_crowd, EDGES, fallback.edge_vs_crowd),
      urgency: pick(raw.urgency, URGENCIES, fallback.urgency),
      size_hint: pick(raw.size_hint, SIZES, fallback.size_hint),
      invalidation: String(raw.invalidation || fallback.invalidation || ''),
      notes: String(raw.notes || fallback.notes || ''),
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
    };
  }

  function userPrompt(packet) {
    return [
      'Analyze this authoritative packet. Do not change the numbers.',
      JSON.stringify(packet || {}, null, 2),
    ].join('\n');
  }

  function packetFromOracle(oracle, extras = {}) {
    const o = oracle || {};
    const w = o.active || {};
    const spotTs = num(o.spotTs);
    // Guard: spotTs must be a realistic unix-ms timestamp (after 2020-01-01).
    // If spotTs=0 or very small, Date.now()-spotTs blows up to ~56 years stale.
    const MIN_VALID_SPOT_TS = 1_577_836_800_000; // 2020-01-01 UTC in ms
    const spotAgeSec = (spotTs != null && spotTs >= MIN_VALID_SPOT_TS)
      ? Math.max(0, Math.round((Date.now() - spotTs) / 1000))
      : null;
    const rawSpot = num(o.spot);
    return {
      sym: String(extras.sym || o.coin || o.sym || '').toUpperCase(),
      horizon: String(extras.horizon || o.horizon || w.horizon || '15m'),
      slug: o.slug || w.slug || null,
      // spot=0 is invalid (same as missing) — treat as null so inferLocal() HOLD_FLATs correctly.
      spot: (rawSpot != null && rawSpot > 0) ? rawSpot : null,
      spotSource: o.spotSource || 'pyth',
      spotAgeSec,
      priceToBeatNum: num(o.priceToBeatNum ?? w.priceToBeatNum),
      priceToBeatSource: o.priceToBeatSource || w.priceToBeatSource || null,
      deltaVsPtb: num(o.deltaVsPtb),
      liveDirection: o.pathDir || w.liveDirection || null,
      yesProb: num(o.yesProb ?? w.yesProb),
      mid: num(w.mid ?? extras.mid),
      spread: num(w.spread ?? extras.spread),
      bestBid: num(w.bestBid ?? extras.bestBid),
      bestAsk: num(w.bestAsk ?? extras.bestAsk),
      depthImbalance: num(w.depthImbalance ?? extras.depthImbalance),
      nearTouchNotional: num(w.nearTouchNotional ?? extras.nearTouchNotional),
      secondsToClose: num(o.secondsToClose ?? w.secondsToClose),
      secondsSinceOpen: num(extras.secondsSinceOpen),
      // Supplementary context only -- never spot/PTB, never overrides them.
      // Crowded leveraged positioning is a real amplifier of short-horizon
      // moves: a crowded-long book liquidating INTO a pullback, or a
      // crowded-short book squeezing on a bounce. derivPressure/derivLabel
      // are DerivativesFeed's own precomputed read (liquidation cascade >
      // funding crowding > OI build/unwind, in that priority).
      fundingRate: num(o.derivativesPositioning?.fundingRate),
      openInterestUsd: num(o.derivativesPositioning?.openInterestUsd),
      derivPressure: num(o.derivativesPositioning?.pressure),
      derivLabel: o.derivativesPositioning?.label || null,
      graviharmonic: (() => {
        try {
          const GraviBox = (typeof window !== 'undefined' && window.GraviharmonicBox)
            || (typeof require !== 'undefined' ? require('./graviharmonic-box') : null);
          const sym = String(extras.sym || o.coin || o.sym || '').toUpperCase();
          const spot = num(o.spot);
          const ptb = num(o.priceToBeatNum ?? w.priceToBeatNum);
          const ttc = num(o.secondsToClose ?? w.secondsToClose) || 300;
          if (GraviBox && typeof GraviBox.computeState === 'function' && spot > 0 && ptb > 0) {
            const st = GraviBox.computeState(sym, spot, ptb, { timeRemainingSec: ttc });
            if (st) {
              return {
                deltaBps: st.gravitational.deltaBps,
                escapeRatio: st.gravitational.escapeRatio,
                isEscaped: st.gravitational.isEscaped,
                bindingStrength: st.gravitational.bindingStrength,
                harmonicCoherence: st.harmonic.harmonicCoherenceScore,
                resonantRegime: st.harmonic.resonantRegime,
                phaseAlignment: st.harmonic.phaseAlignment,
                compositeIndex: st.compositeIndex,
                actionRecommendation: st.actionRecommendation,
              };
            }
          }
        } catch (_) { }
        return null;
      })(),
      foresight: (() => {
        try {
          const OFE = (typeof window !== 'undefined' && window.OrbitalForesightEngine)
            || (typeof require !== 'undefined' ? require('./orbital-foresight-engine') : null);
          const sym = String(extras.sym || o.coin || o.sym || '').toUpperCase();
          if (OFE && typeof OFE.getLatestScan === 'function') {
            const scan = OFE.getLatestScan(sym);
            const rhc  = OFE.getRhcStatus(sym);
            const dap  = OFE.getDapAnchor(sym);
            if (scan) {
              return {
                macroRegime:         scan.macroRegime || 'unknown',
                regimeConfidence:    scan.regimeConfidence ?? null,
                foresightVector:     scan.foresightVector || 'neutral',
                foresightConfidence: scan.foresightConfidence ?? null,
                smartMoneyBias:      scan.smartMoneyBias || 'neutral',
                sentimentScore:      scan.sentimentScore ?? null,
                upcomingCatalysts:   Array.isArray(scan.upcomingCatalysts) ? scan.upcomingCatalysts.slice(0, 3) : [],
                keyRiskEvents:       Array.isArray(scan.keyRiskEvents) ? scan.keyRiskEvents.slice(0, 2) : [],
                driftAnchor:         dap?.driftAnchor || scan.driftAnchor || null,
                scanAgeMs:           rhc.ageMs,
                scanFresh:           rhc.fresh,
                scanStale:           rhc.stale || rhc.dead,
              };
            }
          }
        } catch (_) { }
        return null;
      })(),
    };
  }

  const SAMPLE_PACKET = Object.freeze({
    sym: 'BTC',
    horizon: '15m',
    slug: 'btc-updown-15m',
    spot: 97420.5,
    spotSource: 'pyth',
    priceToBeatNum: 97380.0,
    priceToBeatSource: 'polymarket-ptb',
    deltaVsPtb: 40.5,
    liveDirection: 'UP',
    yesProb: 0.56,
    mid: 0.555,
    spread: 0.02,
    bestBid: 0.54,
    bestAsk: 0.56,
    depthImbalance: 0.18,
    nearTouchNotional: 4200,
    secondsToClose: 480,
    secondsSinceOpen: 420,
  });

  function extractJson(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      const p = JSON.parse(trimmed);
      if (p && typeof p === 'object') return p;
    } catch (_) {}
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch && fenceMatch[1]) {
      try {
        const p = JSON.parse(fenceMatch[1].trim());
        if (p && typeof p === 'object') return p;
      } catch (_) {}
    }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        const p = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        if (p && typeof p === 'object') return p;
      } catch (_) {}
    }
    return null;
  }

  function parseOrSynthesize(content, thought, mode, packet) {
    const rawText = [content, thought].filter(Boolean).join('\n');
    const parsed = extractJson(content) || extractJson(thought);
    if (parsed) {
      return { contract: normalizeContract(parsed, mode, packet), source: 'asi1' };
    }

    // When ASI1 Agentverse / Planner mode produces rich markdown prose:
    if (rawText && rawText.length > 50) {
      const fallback = inferLocal(packet || {}, mode);
      const isUp = /\b(?:favoring the "UP"|favoring the UP|probability for UP|bullish sentiment|UP outcome|favors UP|call:\s*UP)\b/i.test(rawText);
      const isDown = /\b(?:favoring the "DOWN"|favoring the DOWN|probability for DOWN|bearish sentiment|DOWN outcome|favors DOWN|call:\s*DOWN)\b/i.test(rawText);
      const call = isUp ? 'UP' : (isDown ? 'DOWN' : fallback.call);
      const action = call === 'UP' ? 'BUY_UP' : (call === 'DOWN' ? 'BUY_DOWN' : 'HOLD_FLAT');

      const probMatch = rawText.match(/(\d{1,2}(?:\.\d+)?)%\s*(?:probability|prob|confidence)/i);
      let conf = probMatch ? Number(probMatch[1]) / 100 : fallback.confidence;
      if (conf > 1) conf = conf / 100;
      conf = Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100;

      const notesClean = rawText
        .replace(/#+\s*/g, '')
        .replace(/\*\*/g, '')
        .replace(/\n+/g, ' ')
        .slice(0, 320)
        .trim();

      const contract = {
        ...baseContract(mode),
        call,
        action,
        confidence: conf,
        regime: fallback.regime || 'trend_continuation',
        edge_vs_crowd: fallback.edge_vs_crowd || 'with_crowd',
        urgency: fallback.urgency || 'now',
        size_hint: fallback.size_hint || 'half',
        invalidation: fallback.invalidation || 'reassess if spot breaks PTB',
        notes: notesClean || fallback.notes,
        warnings: [],
      };
      return { contract, source: 'asi1-planner' };
    }

    return { contract: inferLocal(packet || {}, mode), source: 'inferLocal' };
  }

  return {
    MODES,
    ACTIONS,
    SYSTEM_PROMPT,
    DESK_SCHEMA,
    RESPONSE_FORMAT,
    SAMPLE_PACKET,
    normalizeMode,
    isFastPath,
    selectModel,
    plannerAllowed,
    inferLocal,
    normalizeContract,
    userPrompt,
    packetFromOracle,
    holdContract,
    extractJson,
    parseOrSynthesize,
  };
}));
