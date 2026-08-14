/**
 * Multi-provider Inference Relay
 * ------------------------------
 * Combines TokenMix (DeepSeek) + ASI1 into one cohesive market view:
 *
 *   Stage 1 — Microstructure packet (raw, no LLM)
 *   Stage 2 — Parallel specialists
 *               • DeepSeek: short-horizon + order-book dynamics
 *               • ASI1:     medium/longer-horizon regime + pre-contract guide
 *   Stage 3 — Relay synthesis (DeepSeek preferred for cost; ASI1 fallback)
 *             merges both legs into a single structured call/notes package
 *
 * Used by LLMSignalAssistant when both providers are keyed.
 */

'use strict';

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n) || 0));
}

function normCall(c) {
  const u = String(c || '').toUpperCase().trim();
  if (u === 'UP' || u === 'BUY_UP' || u === 'YES' || u === 'LONG') return 'UP';
  if (u === 'DOWN' || u === 'BUY_DOWN' || u === 'NO' || u === 'SHORT') return 'DOWN';
  return null;
}

/**
 * Build a compact, LLM-friendly microstructure packet from a snapshot.
 * This is the "ground layer" that every specialist and the synthesizer see.
 */
function buildMicrostructurePacket(snapshot = {}) {
  const p5 = snapshot.poly5m || {};
  const p15 = snapshot.poly15m || snapshot.activeContract || {};
  const spot = Number(snapshot.currentPrice ?? snapshot.price ?? p5.currentPriceNum ?? p15.currentPriceNum);
  const ptb5 = Number(p5.priceToBeatNum ?? p5.targetPriceNum);
  const ptb15 = Number(p15.priceToBeatNum ?? p15.targetPriceNum);
  const yes5 = Number(p5.probability ?? p5.upProbability ?? p5.yesProb ?? p5.clobProbability);
  const yes15 = Number(p15.probability ?? p15.upProbability ?? p15.yesProb);

  const delta5 = (Number.isFinite(spot) && Number.isFinite(ptb5) && ptb5 > 0)
    ? ((spot - ptb5) / ptb5) * 100
    : null;
  const delta15 = (Number.isFinite(spot) && Number.isFinite(ptb15) && ptb15 > 0)
    ? ((spot - ptb15) / ptb15) * 100
    : null;

  return {
    coin: String(snapshot.coin || snapshot.sym || 'UNK').toUpperCase(),
    ts: new Date().toISOString(),
    spot: Number.isFinite(spot) && spot > 0 ? spot : null,
    modelDirection: snapshot.direction || snapshot.modelDirection || null,
    modelScore: snapshot.score ?? snapshot.modelScore ?? null,
    modelConfidence: snapshot.confidence ?? null,
    shortTerm: {
      horizon: '5m',
      slug: p5.slug || null,
      ptb: Number.isFinite(ptb5) && ptb5 > 0 ? ptb5 : null,
      yesProb: Number.isFinite(yes5) ? yes5 : null,
      mid: p5.mid ?? null,
      bestBid: p5.bestBid ?? null,
      bestAsk: p5.bestAsk ?? null,
      spread: p5.spread ?? null,
      depthImbalance: p5.depthImbalance ?? null,
      nearTouchNotional: p5.nearTouchNotional ?? null,
      bidDepthNotional: p5.bidDepthNotional ?? null,
      askDepthNotional: p5.askDepthNotional ?? null,
      secondsToClose: p5.secondsToClose ?? null,
      liveDirection: p5.liveDirection || null,
      pathPctVsPtb: delta5,
    },
    mediumTerm: {
      horizon: '15m',
      slug: p15.slug || null,
      ptb: Number.isFinite(ptb15) && ptb15 > 0 ? ptb15 : null,
      yesProb: Number.isFinite(yes15) ? yes15 : null,
      mid: p15.mid ?? null,
      bestBid: p15.bestBid ?? null,
      bestAsk: p15.bestAsk ?? null,
      spread: p15.spread ?? null,
      depthImbalance: p15.depthImbalance ?? null,
      secondsToClose: p15.secondsToClose ?? null,
      liveDirection: p15.liveDirection || null,
      pathPctVsPtb: delta15,
    },
    session: {
      sampleCount: snapshot.sessionMemory?.sampleCount ?? snapshot.analyticsMemory?.sampleCount ?? null,
      sessionMinutes: snapshot.sessionMemory?.sessionMinutes ?? null,
    },
    rangeLadderTop: Array.isArray(snapshot.rangeLadder)
      ? snapshot.rangeLadder.slice(0, 5).map((b) => ({
        low: b.low, high: b.high, yesProb: b.yesProb, ticker: b.ticker,
      }))
      : [],
  };
}

function specialistSystemShort() {
  return `You are DeepSeek (via TokenMix) — SHORT-HORIZON + ORDER-BOOK specialist for Polymarket crypto Up/Down.

Focus ONLY on:
1) 5m (and near-term 15m) path: spot vs price-to-beat, TTC, liveDirection
2) CLOB microstructure: mid, spread, depthImbalance, near-touch notional, bid vs ask walls
3) Whether the book supports a scalp into settlement THIS window

Ignore long macro narratives. Be precise and numeric.

Return ONLY valid JSON:
{
  "role": "short_ob",
  "call": "UP|DOWN",
  "confidence": 0.0-1.0,
  "horizonFocus": "5m|15m",
  "bookView": {
    "pressure": "bid|ask|balanced",
    "spreadQuality": "tight|wide|toxic",
    "imbalance": 0.0,
    "note": ""
  },
  "pathView": {
    "vsPtb": "above|below|flat",
    "edgeBps": 0,
    "ttcSeconds": 0
  },
  "tradeHint": "BUY_UP|BUY_DOWN|SIZE_DOWN|HOLD",
  "invalidation": "",
  "suggestions": { "notes": "start with UP or DOWN then 2-4 sharp sentences on book+path" },
  "warnings": []
}`;
}

function specialistSystemLong() {
  return `You are ASI1 (Fetch.ai) — MEDIUM/LONGER-HORIZON regime + pre-contract specialist for Polymarket crypto.

Focus ONLY on:
1) 15m–1h regime: trend / mean-reversion / chop / breakout
2) Pre-contract positioning: what to do before or early in the window
3) How crowd odds (P(Up)) relate to model score and session memory
4) Risks that play out over multiple 5m windows

Do NOT re-derive tick-level book walls (another specialist covers that). Speak to multi-window dynamics.

Return ONLY valid JSON:
{
  "role": "medium_long",
  "call": "UP|DOWN",
  "confidence": 0.0-1.0,
  "regime": "trend_continuation|mean_reversion|chop_noise|breakout_volatility",
  "horizonFocus": "15m|60m",
  "preContract": {
    "action": "BUY_UP|BUY_DOWN|SIZE_DOWN|HOLD_FLAT",
    "urgency": "now|wait_pullback|late_window",
    "edgeVsMarket": "with_crowd|fade_crowd|neutral",
    "sizeHint": "full|half|skip",
    "invalidation": ""
  },
  "suggestions": { "notes": "start with UP or DOWN then pre-contract guidance" },
  "ai_wording": { "primary_rationale": "", "market_patterns": "" },
  "warnings": []
}`;
}

function synthesisSystem() {
  return `You are the INFERENCE RELAY synthesizer. You receive:
1) microstructure packet (raw numbers — SOURCE OF TRUTH for path/odds/book levels)
2) short_ob leg (DeepSeek): short-horizon + order book
3) medium_long leg (ASI1): regime + pre-contract

Produce ONE cohesive trading view for the operator. Rules:
- If legs AGREE on call, raise confidence and blend notes.
- If legs DISAGREE, prefer the leg that aligns with microstructure path (spot vs PTB) and CLOB mid; mark conflict.
- Never invent numbers not in the packet. Cite slug/TTC/P(Up)/imbalance when relevant.
- Output must be actionable across short and medium horizons.

Return ONLY valid JSON:
{
  "call": "UP|DOWN",
  "direction": "UP|DOWN",
  "confidence": 0.0-1.0,
  "regime": "trend_continuation|mean_reversion|chop_noise|breakout_volatility",
  "horizonMinutes": 15,
  "relay": {
    "shortCall": "UP|DOWN",
    "longCall": "UP|DOWN",
    "agreement": true,
    "primaryLeg": "short_ob|medium_long|microstructure",
    "conflictNote": ""
  },
  "preContract": {
    "action": "BUY_UP|BUY_DOWN|SIZE_DOWN|HOLD_FLAT",
    "urgency": "now|wait_pullback|late_window",
    "edgeVsMarket": "with_crowd|fade_crowd|neutral",
    "sizeHint": "full|half|skip",
    "invalidation": ""
  },
  "polyPeg": { "slug": "", "side": "Up|Down", "rationale": "" },
  "bookSummary": "",
  "pathSummary": "",
  "suggestions": {
    "notes": "UP|DOWN first, then unified short+long+book guidance in 3-6 sentences",
    "increase_weight": [],
    "decrease_weight": []
  },
  "ai_wording": {
    "primary_rationale": "full cohesive brief",
    "market_patterns": "",
    "scalp_setups": []
  },
  "analysis": {
    "strongest_signal": "",
    "weakest_signal": "",
    "key_conflict": "",
    "reversal_risk": ""
  },
  "warnings": [],
  "legs": {
    "short_ob": {},
    "medium_long": {}
  }
}`;
}

function buildSpecialistUser(packet, role) {
  return [
    `Coin: ${packet.coin}`,
    `Timestamp: ${packet.ts}`,
    `Spot: ${packet.spot ?? 'n/a'}`,
    `Model: dir=${packet.modelDirection} score=${packet.modelScore} conf=${packet.modelConfidence}`,
    '',
    '## SHORT-TERM / 5M',
    JSON.stringify(packet.shortTerm, null, 0),
    '',
    '## MEDIUM-TERM / 15M',
    JSON.stringify(packet.mediumTerm, null, 0),
    '',
    '## SESSION',
    JSON.stringify(packet.session, null, 0),
    packet.rangeLadderTop?.length ? `\n## RANGE LADDER TOP\n${JSON.stringify(packet.rangeLadderTop)}` : '',
    '',
    role === 'short_ob'
      ? 'Task: short-horizon + order-book specialist only. JSON only.'
      : 'Task: medium/longer-horizon + pre-contract specialist only. JSON only.',
  ].filter(Boolean).join('\n');
}

function buildSynthesisUser(packet, shortLeg, longLeg) {
  return [
    'Synthesize a single cohesive market view.',
    '',
    '## MICROSTRUCTURE (source of truth numbers)',
    JSON.stringify(packet, null, 0),
    '',
    '## SHORT_OB LEG (DeepSeek / TokenMix)',
    JSON.stringify(shortLeg || { error: 'missing' }, null, 0),
    '',
    '## MEDIUM_LONG LEG (ASI1)',
    JSON.stringify(longLeg || { error: 'missing' }, null, 0),
    '',
    'Task: merge into one JSON object per system schema. Prefer microstructure when legs fight path/odds.',
  ].join('\n');
}

/**
 * Local merge if synthesis LLM fails — still produce a cohesive object.
 */
function mergeLegsLocally(packet, shortLeg, longLeg) {
  const sCall = normCall(shortLeg?.call);
  const lCall = normCall(longLeg?.call);
  const path = packet.shortTerm?.pathPctVsPtb ?? packet.mediumTerm?.pathPctVsPtb;
  const pathCall = path == null ? null : (path > 0.01 ? 'UP' : path < -0.01 ? 'DOWN' : null);
  const yes = packet.shortTerm?.yesProb ?? packet.mediumTerm?.yesProb;
  const mktCall = yes == null ? null : (yes >= 0.55 ? 'UP' : yes <= 0.45 ? 'DOWN' : null);

  let call = sCall || lCall;
  let primary = sCall ? 'short_ob' : 'medium_long';
  let agreement = !!(sCall && lCall && sCall === lCall);

  if (sCall && lCall && sCall !== lCall) {
    // Prefer microstructure alignment
    if (pathCall && (pathCall === sCall || pathCall === lCall)) {
      call = pathCall;
      primary = 'microstructure';
    } else if (mktCall && (mktCall === sCall || mktCall === lCall)) {
      call = mktCall;
      primary = 'microstructure';
    } else {
      call = sCall; // short/book often more timely mid-window
      primary = 'short_ob';
    }
    agreement = false;
  }

  if (!call && pathCall) { call = pathCall; primary = 'microstructure'; }
  if (!call && mktCall) { call = mktCall; primary = 'microstructure'; }
  if (!call) call = 'UP';

  const sConf = clamp(shortLeg?.confidence, 0, 1);
  const lConf = clamp(longLeg?.confidence, 0, 1);
  let confidence = agreement ? Math.max(sConf, lConf, 0.55) : Math.min(sConf || 0.5, lConf || 0.5, 0.52);
  if (primary === 'microstructure') confidence = Math.max(confidence, 0.58);

  const slug = packet.shortTerm?.slug || packet.mediumTerm?.slug || '';
  const notesShort = String(shortLeg?.suggestions?.notes || shortLeg?.notes || '').slice(0, 280);
  const notesLong = String(longLeg?.suggestions?.notes || longLeg?.notes || '').slice(0, 280);
  const bookNote = shortLeg?.bookView?.note || shortLeg?.bookSummary || '';
  const pathNote = path != null ? `path ${path > 0 ? '+' : ''}${Number(path).toFixed(3)}% vs PTB` : '';

  const notes = [
    `${call}`,
    slug ? slug : '',
    agreement ? 'legs AGREE' : 'legs CONFLICT — microstructure weighted',
    pathNote,
    bookNote ? `book: ${bookNote}` : '',
    notesShort ? `ST: ${notesShort.replace(/^\s*(UP|DOWN)\b\s*/i, '')}` : '',
    notesLong ? `LT: ${notesLong.replace(/^\s*(UP|DOWN)\b\s*/i, '')}` : '',
  ].filter(Boolean).join(' · ').slice(0, 700);

  return {
    call,
    direction: call,
    confidence,
    regime: longLeg?.regime || shortLeg?.regime || 'chop_noise',
    horizonMinutes: 15,
    relay: {
      shortCall: sCall,
      longCall: lCall,
      agreement,
      primaryLeg: primary,
      conflictNote: agreement ? '' : `short=${sCall} long=${lCall} chose=${call} via ${primary}`,
    },
    preContract: longLeg?.preContract || shortLeg?.preContract || {
      action: call === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
      urgency: (packet.shortTerm?.secondsToClose != null && packet.shortTerm.secondsToClose < 90) ? 'late_window' : 'now',
      edgeVsMarket: 'neutral',
      sizeHint: agreement ? 'full' : 'half',
      invalidation: shortLeg?.invalidation || longLeg?.preContract?.invalidation || '',
    },
    polyPeg: {
      slug,
      side: call === 'UP' ? 'Up' : 'Down',
      rationale: `relay ${primary}`,
    },
    bookSummary: shortLeg?.bookView
      ? `${shortLeg.bookView.pressure || ''} ${shortLeg.bookView.spreadQuality || ''} imb=${shortLeg.bookView.imbalance ?? packet.shortTerm?.depthImbalance ?? '?'}`
      : '',
    pathSummary: pathNote,
    suggestions: {
      notes,
      increase_weight: agreement ? ['relay_agree'] : [],
      decrease_weight: agreement ? [] : ['relay_conflict'],
    },
    ai_wording: {
      primary_rationale: notes,
      market_patterns: longLeg?.ai_wording?.market_patterns || '',
      scalp_setups: shortLeg?.tradeHint ? [shortLeg.tradeHint] : [],
    },
    analysis: {
      strongest_signal: primary,
      weakest_signal: agreement ? '' : 'leg_disagreement',
      key_conflict: agreement ? '' : `short ${sCall} vs long ${lCall}`,
      reversal_risk: longLeg?.analysis?.reversal_risk || '',
    },
    warnings: [
      ...(Array.isArray(shortLeg?.warnings) ? shortLeg.warnings : []),
      ...(Array.isArray(longLeg?.warnings) ? longLeg.warnings : []),
      ...(agreement ? [] : ['relay_leg_disagreement']),
      'relay_local_merge',
    ],
    legs: {
      short_ob: shortLeg || null,
      medium_long: longLeg || null,
    },
    _provider: 'relay',
    _model: 'local-merge',
    _relay: true,
  };
}

module.exports = {
  buildMicrostructurePacket,
  specialistSystemShort,
  specialistSystemLong,
  synthesisSystem,
  buildSpecialistUser,
  buildSynthesisUser,
  mergeLegsLocally,
  normCall,
};
