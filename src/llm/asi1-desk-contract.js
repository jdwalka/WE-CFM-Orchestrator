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
      account_order: ['gitgoin', 'mauro'],
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

    if (spot == null || ptb == null || yes == null || mid == null) {
      return holdContract(m, ['Missing required fields (spot, priceToBeatNum, yesProb, mid)']);
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
    if (Math.abs(deltaBps) >= 4) confidence += 0.03;
    if (Math.abs(imb) >= 0.1) confidence += 0.03;
    if (notional >= 1000) confidence += 0.02;
    if (edge === 'with_crowd') confidence += 0.03;
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

    let notes;
    if (call === 'UP') {
      notes = `UP. Spot ${spot} sits ${delta.toFixed(1)} above PTB ${ptb} with ${ttc ?? '?'}s to close. YesProb ${yes.toFixed(2)} and mid ${mid.toFixed(3)} align upward. Depth imbalance ${imb.toFixed(2)} and near-touch notional ${notional} support buying. Edge is modest but directionally consistent. Fade only if spot pierces PTB.`;
    } else if (call === 'DOWN') {
      notes = `DOWN. Spot ${spot} sits ${Math.abs(delta).toFixed(1)} below PTB ${ptb} with ${ttc ?? '?'}s to close. YesProb ${yes.toFixed(2)} and mid ${mid.toFixed(3)} suggest downside. Depth imbalance ${imb.toFixed(2)} and near-touch notional ${notional} support selling. Edge is modest but directionally consistent. Fade only if spot pierces PTB.`;
    } else {
      notes = `HOLD_FLAT. Spot ${spot} vs PTB ${ptb} shows insufficient edge. YesProb ${yes.toFixed(2)} and mid ${mid.toFixed(3)} offer no clear direction. No legal action with positive EV.`;
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
        account: selectModel(packet, m) === 'asi1-ultra' ? 'gitgoin' : 'mauro',
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
    const spotAgeSec = spotTs != null ? Math.max(0, Math.round((Date.now() - spotTs) / 1000)) : null;
    return {
      sym: String(extras.sym || o.coin || o.sym || '').toUpperCase(),
      horizon: String(extras.horizon || o.horizon || w.horizon || '15m'),
      slug: o.slug || w.slug || null,
      spot: num(o.spot),
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
