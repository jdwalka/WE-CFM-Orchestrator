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

  const CP = (typeof require !== 'undefined')
    ? (() => {
        try { return require('../shared/coin-precision'); } catch (_) {
          try { return require('./coin-precision'); } catch (__) { return null; }
        }
      })()
    : (typeof globalThis !== 'undefined' ? globalThis.CoinPrecision : null);

  function formatGraviRegime(regime) {
    if (!regime) return 'Neutral';
    return String(regime)
      .toLowerCase()
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

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
    'Format and Tone: Write notes in clear, objective, and transparent language for traders.',
    'Avoid dark-pool or insider jargon such as "fade", "pierces PTB", or cryptic acronyms.',
    'Respect exact coin precision without float noise (BTC/ETH/SOL/BNB/HYPE: 2 decimals, e.g. $79,566.58; XRP/DOGE: 4 decimals, e.g. $0.5842).',
    'Format time-to-close (TTC) in clean human-readable durations (e.g. 10m 27s or 45s).',
    'Format near-touch liquidity with commas and 2 decimals (e.g. $2,572.46), never raw IEEE-754 floats.',
    'Timing: secondsToClose is TTC in seconds, authoritative. urgency=late_window when TTC<90; ' +
      'urgency=now when TTC>=90 and the edge (deltaVsPtb vs yesProb, depthImbalance) is live and consistent; ' +
      'urgency=wait_pullback otherwise. spotAgeSec is how many seconds old the spot price is -- ' +
      'if spotAgeSec is large relative to TTC, treat spot as stale and prefer HOLD_FLAT over a timing call.',
    'Pin Risk & Boundary Defense Guard: When secondsToClose (TTC) < 90 and spot is within 0.5σ or 8 bps of PTB ' +
      '(deltaVsPtb is tiny, or pinRisk.isDefendedPinZone=true), market makers aggressively absorb order flow to pin ' +
      'the strike and collect binary premium, causing orders to evaporate right after expiration (the 1-2s late dump trap). ' +
      'In this zone, you MUST NOT call a late directional trade into the dying wire. Force action to HOLD_FLAT ' +
      'or SIZE_DOWN with a PIN_RISK warning, and pivot your active guidance to the T+1 future window pre-open setup.',
    'Range & Strike Viability: When rangeViability is present, favor CLEAN_TARGET strikes (adequate volatility runway, ' +
      'distance >= 1.25σ) and strictly reject PIN_TRAP_DANGER strikes.',
    'Future Windows (T+1): When futureWindowT1 is provided and TTC < 90s, cite the projected opening strike ' +
      '(projectedOpenPtb) and forward vector (forecastDirection/sniperAction), advising the trader to position for ' +
      'the upcoming window with full 15m/1h runway rather than risking pin execution.',
    'derivPressure (-1..1) and derivLabel (e.g. CROWDED LONGS, SHORT LIQ CASCADE, OI BUILDING) are ' +
      'supplementary context from cross-venue perp positioning, never a hole card: positive pressure/' +
      'CROWDED LONGS or LONG LIQ CASCADE means a pullback risks forced long liquidations amplifying the ' +
      'down move; negative pressure/CROWDED SHORTS or SHORT LIQ CASCADE means a bounce risks a short-squeeze ' +
      'amplifying the up move. Only let it nudge confidence or urgency when it agrees with the spot-vs-PTB ' +
      'path; never let it override spot/PTB or invent a call alone.',
    'If binaryIV_5m or binaryIV_15m are present, use them to spot contract mispricings. Extreme IV ' +
      '(e.g. > 150%) may indicate the contract is overpriced relative to the time to expiry and spot distance, ' +
      'while very low IV might indicate a cheap contract. Adjust confidence/edge accordingly.',
    'Hourly Contracts & Ranges: Hourly contracts refer specifically to HOURLY PRICE RANGES (the Hourly Ranges Ladder). ' +
      'For hourly contracts, settlement is determined by which range bracket price closes within at the upcoming top-of-hour close (e.g. 13:00 UTC). ' +
      'Evaluate spot position relative to the active range ladder brackets and identify the projected closing bracket. ' +
      'Never confuse hourly contracts with 5m/15m Up/Down PTB strikes or invent/reference legacy or expired contract expiries (such as an old "02 contract expiry").',
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
    const isLongerOrLookahead = horizon.includes('lookahead') || horizon === '1h' || horizon === '60m' || horizon === 'hourly' || horizon === 'anytime';
    return is5m || (ttc != null && ttc < 90 && !isLongerOrLookahead);
  }

  function selectModel(packet, mode) {
    if (isFastPath(packet)) return 'asi1-mini';
    if (normalizeMode(mode) === 'planner') return 'asi1';
    const envModel = (typeof process !== 'undefined' && (process.env.ASI1_DESK_MODEL || process.env.ASI1_MODEL)) || null;
    return envModel || 'asi1-mini';
  }

  function plannerAllowed(packet, mode) {
    return normalizeMode(mode) === 'planner' && !isFastPath(packet);
  }

  function baseContract(mode) {
    const defaultDeskModel = (typeof process !== 'undefined' && (process.env.ASI1_DESK_MODEL || process.env.ASI1_MODEL)) || 'asi1-mini';
    return {
      mode: normalizeMode(mode),
      account_order: ['mauro', 'icloud', 'gitgoin'],
      model_for_5m: 'asi1-mini',
      model_for_15m: defaultDeskModel,
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
    const isLookahead = packet.horizon === 'anytime' || String(packet.horizon || '').toLowerCase().includes('lookahead');
    const isHourly = packet.isHourly || packet.horizon === '1h' || packet.horizon === '60m' || packet.horizon === 'hourly' || packet.horizon === 'lookahead-1h' || (Array.isArray(packet.hourlyLadder) && packet.hourlyLadder.length > 0);
    const sym = String(packet.sym || packet.coin || '').toUpperCase() || 'BTC';
    const coinName = CP?.getCoinDisplayName ? CP.getCoinDisplayName(sym) : sym;

    const rawSpot = num(packet.spot);
    const rawPtb = num(packet.priceToBeatNum);
    const spot = (rawSpot != null && rawSpot > 0 && CP?.roundCoinPrice) ? CP.roundCoinPrice(sym, rawSpot) : rawSpot;
    const ptb = (rawPtb != null && rawPtb > 0 && CP?.roundCoinPrice) ? CP.roundCoinPrice(sym, rawPtb) : rawPtb;

    const rawProjectedPtb = num(packet.projectedOpenPtb);
    const projectedPtb = (rawProjectedPtb != null && rawProjectedPtb > 0 && CP?.roundCoinPrice)
      ? CP.roundCoinPrice(sym, rawProjectedPtb)
      : rawProjectedPtb;
    let effectivePtb = ptb || (isLookahead && projectedPtb) || null;

    // For hourly contracts, anchor to the active range bracket or spot ONLY if no PTB / projected PTB exists
    let activeSpotBucket = packet.spotBucket || null;
    if (isHourly && Array.isArray(packet.hourlyLadder) && packet.hourlyLadder.length > 0 && !activeSpotBucket && spot != null) {
      activeSpotBucket = packet.hourlyLadder.find((b) => spot >= Number(b.low) && spot <= Number(b.high)) || null;
    }
    if (isHourly && (effectivePtb == null || effectivePtb <= 0) && spot != null) {
      effectivePtb = activeSpotBucket ? ((Number(activeSpotBucket.low) + Number(activeSpotBucket.high)) / 2) : spot;
      if (CP?.roundCoinPrice) effectivePtb = CP.roundCoinPrice(sym, effectivePtb);
    }

    let yes = num(packet.yesProb);
    if (isHourly && yes == null && activeSpotBucket?.yesProb != null) {
      yes = num(activeSpotBucket.yesProb);
    }
    const effectiveYes = yes ?? (isLookahead && num(packet.pUp) != null ? num(packet.pUp) : (isHourly ? 0.50 : null));
    const mid = num(packet.mid);
    const effectiveMid = mid ?? effectiveYes;
    const spread = num(packet.spread);
    const imb = num(packet.depthImbalance) || 0;
    const rawNotional = num(packet.nearTouchNotional) || 0;
    const notional = Math.round(rawNotional * 100) / 100;
    const ttc = num(packet.secondsToClose);
    const live = String(packet.liveDirection || packet.pathDir || '').toUpperCase();

    if (spot == null || spot <= 0 || effectivePtb == null || effectivePtb <= 0 || effectiveYes == null || effectiveMid == null) {
      const missing = [];
      if (!spot || spot <= 0) missing.push('spot');
      if (!effectivePtb || effectivePtb <= 0) missing.push(isHourly ? 'hourlyRanges' : 'priceToBeatNum (Awaiting immutable Polymarket contract push)');
      if (effectiveYes == null) missing.push('yesProb');
      if (effectiveMid == null) missing.push('mid');
      return holdContract(
        m,
        missing,
        (!effectivePtb || effectivePtb <= 0)
          ? (isHourly ? 'HOLD_FLAT. Awaiting Hourly Range Ladder synchronization.' : 'HOLD_FLAT. Awaiting immutable Polymarket Up/Down contract target strike (PTB).')
          : 'HOLD_FLAT. Missing required oracle feeds.'
      );
    }

    const delta = spot - effectivePtb;
    const deltaBps = effectivePtb !== 0 ? (delta / effectivePtb) * 10000 : 0;
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
    if (Math.abs(deltaBps) >= 3) confidence += 0.06;
    if (Math.abs(imb) >= 0.1) confidence += 0.05;

    // ── Graviharmonic modulation ──────────────────────────────────────────
    const gh = packet.graviharmonic;
    let graviTag = '';
    if (gh) {
      if (gh.isEscaped && gh.harmonicCoherence >= 60) confidence += 0.05;
      if (gh.resonantRegime && gh.resonantRegime.includes('BREAKOUT')) regime = 'breakout_volatility';
      if (gh.resonantRegime && gh.resonantRegime.includes('DESTRUCTIVE')) confidence -= 0.05;
      if (gh.bindingStrength === 'HIGH_GRAVITY_CORE') regime = 'mean_reversion';

      const regimeName = formatGraviRegime(gh.resonantRegime);
      const escapeStr = (gh.isEscaped || (gh.escapeRatio != null && gh.escapeRatio > 0)) ? ` · Escape ${gh.escapeRatio}x` : '';
      graviTag = ` [Wave: ${regimeName} · ${gh.harmonicCoherence}% Coherence${escapeStr}]`;
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
      const macroName = ofe.macroRegime ? (ofe.macroRegime.charAt(0).toUpperCase() + ofe.macroRegime.slice(1)) : 'Active';
      const ofeConfPct = Math.round(ofeConf * 100);
      ofeTag = ` [Foresight: ${macroName} · ${vec} (${ofeConfPct}% conf${ageS != null ? `, ${ageS}s ago` : ''})]`;
    } else if (ofe && ofe.scanStale) {
      confidence -= 0.02;
      ofeTag = ' [Foresight: Stale]';
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

    // ── Pin-Risk & Expiry Boundary Defense Guard ─────────────────────────
    // Defends against the 1.23s post-expiry snap trap where MMs defend the strike right into the wire.
    const isPinDefended = !isLookahead && (
      (ttc != null && ttc <= 90 && Math.abs(deltaBps) < 6)
      || !!packet.pinRisk?.isDefendedPinZone
    );

    // Human-readable formatting values
    const spotStr = CP?.formatCoinPrice ? CP.formatCoinPrice(sym, spot) : ('$' + spot.toFixed(2));
    const ptbStr = CP?.formatCoinStrike ? CP.formatCoinStrike(sym, effectivePtb) : ('$' + effectivePtb.toFixed(2));
    const deltaDist = Math.abs(delta);
    const deltaStr = CP?.formatCoinDelta ? CP.formatCoinDelta(sym, deltaDist, { showSign: false }) : ('$' + deltaDist.toFixed(2));
    const notionalStr = CP?.formatNotional ? CP.formatNotional(notional) : ('$' + notional.toFixed(2));
    const ttcStr = CP?.formatTtc ? CP.formatTtc(ttc) : (ttc != null ? `${ttc}s` : 'unknown time');
    const deltaBpsStr = Math.abs(deltaBps).toFixed(1);
    const yesProbPct = Math.round(effectiveYes * 100);
    const midFormatted = effectiveMid.toFixed(3);
    const imbStr = (imb > 0 ? '+' : '') + imb.toFixed(2);

    const warnings = [];
    if (isPinDefended) {
      action = 'HOLD_FLAT';
      sizeHint = 'skip';
      urgency = 'late_window';
      confidence = Math.min(confidence, 0.40);
      warnings.push(`PIN_RISK_DEFENDED: ${coinName} spot is within ${deltaStr} (${deltaBpsStr} bps) of target strike ${ptbStr} in late window (<90s). Market maker defense risks whipsaws; pivot to T+1.`);
    }

    let invalidation = 'no path';
    if (call === 'UP') {
      const invProb = Math.max(0, yesProbPct - 3);
      invalidation = `Spot drops below ${ptbStr} or probability falls under ${invProb}%`;
    } else if (call === 'DOWN') {
      const invProb = Math.min(100, yesProbPct + 3);
      invalidation = `Spot rises above ${ptbStr} or probability exceeds ${invProb}%`;
    }

    let notes;
    if (isHourly) {
      const bucketStr = activeSpotBucket
        ? (CP?.formatCoinPrice ? `${CP.formatCoinPrice(sym, activeSpotBucket.low)}–${CP.formatCoinPrice(sym, activeSpotBucket.high)}` : `$${activeSpotBucket.low}–$${activeSpotBucket.high}`)
        : (CP?.formatCoinPrice ? `around ${CP.formatCoinPrice(sym, spot)}` : `around $${spot}`);
      const bucketProbPct = activeSpotBucket?.yesProb != null ? Math.round(Number(activeSpotBucket.yesProb) * 100) : yesProbPct;
      const targetTimeStr = packet.targetCloseHourUtc
        ? packet.targetCloseHourUtc
        : (packet.targetCloseTime ? new Date(packet.targetCloseTime).toUTCString() : 'top of the hour');
      const biasLabel = call === 'UP' ? 'upper range brackets' : (call === 'DOWN' ? 'lower range brackets' : 'current spot bracket');
      notes = `HOURLY RANGE. ${coinName} spot (${spotStr}) is inside the [${bucketStr}] bracket (${bucketProbPct}% prob) with ${ttcStr} to close at ${targetTimeStr}. Projected close leans toward ${biasLabel}.${graviTag}${ofeTag}`;
    } else if (isPinDefended) {
      const t1 = packet.futureWindowT1 || {};
      const t1PtbFormatted = t1.projectedOpenPtb
        ? (CP?.formatCoinStrike ? CP.formatCoinStrike(sym, t1.projectedOpenPtb) : `$${t1.projectedOpenPtb}`)
        : null;
      const t1Guidance = t1PtbFormatted
        ? ` Pivot to T+1 horizon: Projected PTB ${t1PtbFormatted}, Forward Call ${t1.forecastDirection || '—'} (${t1.confidence || 0}%), Stance: ${t1.sniperAction || 'STANDBY'}.`
        : '';
      notes = `HOLD_FLAT. PIN_RISK_DEFENDED. ${coinName} spot (${spotStr}) is within ${deltaStr} (${deltaBpsStr} bps) of PTB ${ptbStr} with ${ttcStr} to close. MM defense walls risk pinning strike until snapshot and snapping 1-2s post-expiry.${t1Guidance}`;
    } else if (call === 'UP') {
      notes = `UP. ${coinName} spot ${spotStr} is ${deltaStr} above target strike ${ptbStr} with ${ttcStr} to close. Market probability is ${yesProbPct}% (mid ${midFormatted}), favoring upside. Order book depth shows imbalance of ${imbStr} with ${notionalStr} in near-touch liquidity supporting buying momentum.${graviTag}${ofeTag} Invalidate if spot drops below ${ptbStr}.`;
    } else if (call === 'DOWN') {
      notes = `DOWN. ${coinName} spot ${spotStr} is ${deltaStr} below target strike ${ptbStr} with ${ttcStr} to close. Market probability is ${yesProbPct}% (mid ${midFormatted}), suggesting downside. Order book depth shows imbalance of ${imbStr} with ${notionalStr} in near-touch liquidity confirming selling flow.${graviTag}${ofeTag} Invalidate if spot rises above ${ptbStr}.`;
    } else {
      notes = `HOLD_FLAT. ${coinName} spot (${spotStr}) vs target strike ${ptbStr} shows insufficient edge. Market probability is ${yesProbPct}% (mid ${midFormatted}) offering no clear direction.${graviTag}${ofeTag} No legal action with positive EV.`;
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
      warnings: warnings,
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
    const isHourly = packet?.isHourly || packet?.horizon === '1h' || packet?.horizon === '60m' || packet?.horizon === 'hourly' || (Array.isArray(packet?.hourlyLadder) && packet.hourlyLadder.length > 0);
    const header = isHourly
      ? 'Analyze this authoritative HOURLY RANGE packet. For hourly contracts, evaluate the Hourly Range Ladder brackets and predict the closing range bracket at the upcoming top-of-hour close. Do not change the numbers.'
      : 'Analyze this authoritative packet. Do not change the numbers.';
    return [
      header,
      JSON.stringify(packet || {}, null, 2),
    ].join('\n');
  }

  function packetFromOracle(oracle, extras = {}) {
    const o = oracle || {};
    const w = o.active || {};
    const sym = String(extras.sym || o.coin || o.sym || '').toUpperCase();
    const isHourly = !!(extras.horizon === '1h' || extras.horizon === '60m' || extras.horizon === 'hourly' || extras.horizon === 'lookahead-1h' || o.horizon === '1h' || o.horizon === '60m' || o.horizon === 'hourly');
    const spotTs = num(o.spotTs);
    // Guard: spotTs must be a realistic unix-ms timestamp (after 2020-01-01).
    // If spotTs=0 or very small, Date.now()-spotTs blows up to ~56 years stale.
    const MIN_VALID_SPOT_TS = 1_577_836_800_000; // 2020-01-01 UTC in ms
    const spotAgeSec = (spotTs != null && spotTs >= MIN_VALID_SPOT_TS)
      ? Math.max(0, Math.round((Date.now() - spotTs) / 1000))
      : null;
    const rawSpot = num(o.spot);
    const cleanSpot = (rawSpot != null && rawSpot > 0)
      ? (CP?.roundCoinPrice ? CP.roundCoinPrice(sym, rawSpot) : rawSpot)
      : null;
    const rawPtb = num(o.priceToBeatNum ?? w.priceToBeatNum);
    const cleanPtb = (rawPtb != null && rawPtb > 0)
      ? (CP?.roundCoinPrice ? CP.roundCoinPrice(sym, rawPtb) : rawPtb)
      : null;
    const cleanDelta = (cleanSpot != null && cleanPtb != null)
      ? (CP?.roundCoinPrice ? CP.roundCoinPrice(sym, cleanSpot - cleanPtb) : (cleanSpot - cleanPtb))
      : num(o.deltaVsPtb);
    const rawNotional = num(w.nearTouchNotional ?? extras.nearTouchNotional);
    const cleanNotional = rawNotional != null ? Math.round(rawNotional * 100) / 100 : null;

    return {
      sym,
      horizon: String(extras.horizon || o.horizon || w.horizon || '15m'),
      slug: o.slug || w.slug || null,
      isHourly,
      hourlyLadder: o.hourlyLadder || [],
      spotBucket: o.spotBucket || null,
      hourlySource: o.hourlySource || null,
      // spot=0 is invalid (same as missing) — treat as null so inferLocal() HOLD_FLATs correctly.
      spot: cleanSpot,
      spotSource: o.spotSource || 'pyth',
      spotAgeSec,
      priceToBeatNum: cleanPtb,
      priceToBeatSource: o.priceToBeatSource || w.priceToBeatSource || null,
      deltaVsPtb: cleanDelta,
      liveDirection: o.pathDir || w.liveDirection || null,
      yesProb: num(o.yesProb ?? w.yesProb),
      mid: num(w.mid ?? extras.mid),
      spread: num(w.spread ?? extras.spread),
      bestBid: num(w.bestBid ?? extras.bestBid),
      bestAsk: num(w.bestAsk ?? extras.bestAsk),
      depthImbalance: num(w.depthImbalance ?? extras.depthImbalance),
      nearTouchNotional: cleanNotional,
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
      pinRisk: (() => {
        try {
          const Engine = (typeof window !== 'undefined' && window.PredictionEngine);
          const sym = String(extras.sym || o.coin || o.sym || '').toUpperCase();
          const spot = num(o.spot);
          const ptb = num(o.priceToBeatNum ?? w.priceToBeatNum);
          const ttc = num(o.secondsToClose ?? w.secondsToClose);
          if (Engine && typeof Engine.getPinRisk === 'function' && spot > 0 && ptb > 0) {
            return Engine.getPinRisk(sym, spot, ptb, ttc, num(w.depthImbalance ?? extras.depthImbalance) || 0);
          }
          if (spot > 0 && ptb > 0 && ttc != null && ttc <= 90) {
            const dist = Math.abs(spot - ptb);
            const distBps = (dist / ptb) * 10000;
            const isDefended = distBps <= 8;
            return {
              sym,
              spot,
              ptb,
              secondsToClose: ttc,
              distance: dist,
              distanceBps: distBps,
              isDefendedPinZone: isDefended,
              warning: isDefended ? 'PIN_RISK_DEFENDED: Spot within 8 bps of PTB in late window (<90s). MM defense risks 1-2s post-expiry snap.' : null,
              recommendedAction: isDefended ? 'HOLD_FLAT_ROLL_T1' : 'PROCEED',
            };
          }
        } catch (_) {}
        return null;
      })(),
      rangeViability: (() => {
        try {
          const Engine = (typeof window !== 'undefined' && window.PredictionEngine);
          const sym = String(extras.sym || o.coin || o.sym || '').toUpperCase();
          const spot = num(o.spot);
          const ptb = num(o.priceToBeatNum ?? w.priceToBeatNum);
          const ttc = num(o.secondsToClose ?? w.secondsToClose);
          const hMin = extras.horizon === '1h' || extras.horizon === '60m' ? 60 : (extras.horizon === '5m' ? 5 : 15);
          if (Engine && typeof Engine.getRangeViability === 'function' && spot > 0) {
            return Engine.getRangeViability(sym, hMin, ptb, ttc);
          }
        } catch (_) {}
        return null;
      })(),
      futureWindowT1: (() => {
        try {
          const Engine = (typeof window !== 'undefined' && window.PredictionEngine);
          const sym = String(extras.sym || o.coin || o.sym || '').toUpperCase();
          const hMin = extras.horizon === '1h' || extras.horizon === '60m' ? 60 : (extras.horizon === '5m' ? 5 : 15);
          if (Engine && typeof Engine.getPreOpenForecast === 'function') {
            const f = Engine.getPreOpenForecast(sym, hMin);
            if (f) {
              return {
                projectedOpenPtb: f.projectedOpenPtb,
                projectedSettlement: f.projectedSettlement,
                forecastDirection: f.forecastDirection,
                confidence: f.confidence,
                sniperAction: f.sniperAction,
                msToNextBoundary: f.msToNextBoundary,
              };
            }
          }
        } catch (_) {}
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
