/**
 * ASI1 desk-mode + model-roster orchestrator.
 *
 * TokenMix has been removed as an inference provider -- this app is ASI1-only.
 * Walks every ASI:One model (ultra → fast → mini → agentic asi1) across every
 * configured ASI1 key as an automatic fallback chain. Node-only; required by
 * llm_signal_assistant.
 */
'use strict';

const Asi1Client = require('../infra/asi1-client');
const Desk = require('./asi1-desk-contract');

const ASI1_ALL_MODELS = Asi1Client.ASI1_ALL_MODELS || Object.freeze([
  'asi1-ultra',
  'asi1',
  'asi1-mini',
  'asi1-fast',
]);

// Pinned Agentverse agents for planner mode -- curated from
// https://agentverse.ai/v1/search/agents on 2026-08-21, filtered to
// active/well-rated/recently-used listings (the open directory is mostly
// inactive or unrated). Pinning avoids planner_mode's blind live discovery
// picking a dead or low-quality agent for a real-money decision.
const AGENTVERSE_PINNED_AGENTS = Object.freeze([
  'agent1qg6hwwk7zltxq7pamh4ufw04kjywl2ntrkgspmvhdq5yc3mkkjjmk872mxn', // vedetta -- sentiment/price-divergence verdicts (4.8, 19.2k recent interactions)
  'agent1q240kxgq5u77auplgtypuwtzwe9suk9asayfuczernje4wzzthvzq59agj5', // Crypto Whale Radar -- live token data + ETH whale scans (4.2, 429 recent)
  'agent1qvcqcty9uay8avljk908hedgynla2gvcmdhhncjzsdt2u0q9wathshwunwn', // macropulse -- US macro health scores from FRED (4.4, 811 recent)
  'agent1q085746wlr3u2uh4fmwqplude8e0w6fhrmqgsnlp49weawef3ahlutypvu6', // Technical Analysis Agent (4.5, 8.2k recent -- built for stock tickers, TA indicators transfer to crypto)
]);

const DESK_MODES = Desk.MODES;
// TokenMix has been removed as an inference provider (ASI1-only app), so
// 'dual_fire' no longer has a second provider to fire alongside ASI1 --
// 'asi1_only' is the accurate default. Set ASI1_DESK_MODE=planner to also
// enable reasoning/agentic planner mode on non-5m horizons.
let _deskMode = Desk.normalizeMode(process.env.ASI1_DESK_MODE || 'asi1_only');

function getMode() {
  return _deskMode;
}

function setMode(mode) {
  _deskMode = Desk.normalizeMode(mode);
  return _deskMode;
}

function plannerEnabled(horizonOrPacket) {
  if (_deskMode !== 'planner') return false;
  if (horizonOrPacket && typeof horizonOrPacket === 'object') {
    return Desk.plannerAllowed(horizonOrPacket, _deskMode);
  }
  const h = String(horizonOrPacket || '').toLowerCase().replace(/\s+/g, '');
  if (h === '5m' || h === '5' || h.startsWith('5m-') || h === '5m-ptb') return false;
  return true;
}

// TokenMix / OpenAI-compat credit exhaustion only. Explicit 402 or
// credit-token phrases — never generic billing, wallet balance, or 429 quota.
const CREDIT_RES = [
  /\bhttp\s*402\b/,
  /\bstatus(?:code)?[:\s]*402\b/,
  /\bpayment required\b/,
  /\b(?:tokenmix|openai)(?:['’]s)?\s+(?:is\s+)?(?:out of|insufficient)\s+credits?\b/,
  /\binsufficient credits?\b/,
  /\bout of credits?\b/,
  /\bcredits?\s+exhausted\b/,
];

function isCreditError(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 402) return true;
  const msg = String(err?.message || err || '').toLowerCase();
  return CREDIT_RES.some((re) => re.test(msg));
}

function tokenmixCreditReason(assistant) {
  return String(assistant?._providerCooldowns?.tokenmix?.reason || '');
}

function shouldSkipTokenmix(assistant) {
  // Always skip TokenMix in ASI1 modes (asi1_only, planner, dual_fire) or when credentials configured
  const mode = getMode();
  if (mode === 'asi1_only' || mode === 'planner' || mode === 'dual_fire') return true;
  if (process.env.ASI1_ONLY === '1' || process.env.LLM_ONLY_PROVIDER === 'asi1') return true;
  if (assistant?._tokenmixCreditExhausted) return true;
  const remaining = typeof assistant?._providerCooldownRemaining === 'function'
    ? assistant._providerCooldownRemaining('tokenmix')
    : 0;
  if (remaining > 0 && isCreditError({ message: tokenmixCreditReason(assistant) })) return true;
  return true;
}

function markTokenmixExhausted(assistant, err) {
  if (!assistant || !isCreditError(err)) return false;
  assistant._tokenmixCreditExhausted = true;
  assistant._providerCooldowns = assistant._providerCooldowns || {};
  assistant._providerCooldowns.tokenmix = {
    until: Date.now() + 30 * 60 * 1000,
    reason: 'payment required (402) -- no credits on this account',
  };
  return true;
}

function rosterFor(options = {}) {
  const preferred = String(options.model || '').trim();
  const all = ASI1_ALL_MODELS.slice();
  if (preferred && !all.includes(preferred)) return [preferred, ...all];
  if (preferred) return [preferred, ...all.filter((m) => m !== preferred)];
  return all;
}

function reshapeCascade(cascade, assistant, skipCached) {
  const next = Array.isArray(cascade) ? cascade.slice() : [];
  const skip = skipCached != null ? !!skipCached : shouldSkipTokenmix(assistant);
  if (!skip) return next;
  return ['asi1'];
}

async function chat(messages, options = {}) {
  return Asi1Client.chatCompletion(messages, {
    ...options,
    candidateModels: rosterFor(options),
  });
}

// Single source of truth for the fast-path option-override policy. 5m (and
// any sub-90s) packets are latency-critical -- a 300s window can't afford a
// leftover HUD selection (model=asi1-ultra, reasoning effort, web search,
// planner mode) surviving from a prior 15m call via localStorage. Those
// knobs are caller-controlled options, not desk-selected defaults, so on the
// fast path they're force-disabled regardless of what the caller passed.
// Route every deskInfer() option through here rather than reading
// options.* directly elsewhere, so a caller can never accidentally assume
// its options are honored on a fast-path packet.
function resolveDeskOptions(packet, options, mode) {
  const fastPath = Desk.isFastPath(packet);
  const explicitModel = options.model && options.model !== 'auto' ? options.model : null;
  const model = fastPath ? Desk.selectModel(packet, mode) : (explicitModel || Desk.selectModel(packet, mode));
  const plannerOn = fastPath ? false : (options.plannerMode != null ? !!options.plannerMode : Desk.plannerAllowed(packet, mode));
  return {
    fastPath,
    model,
    plannerOn,
    reasoning_effort: fastPath ? undefined : (options.reasoning_effort || options.effort || undefined),
    enable_thinking: fastPath ? false : (options.enable_thinking != null ? options.enable_thinking : (options.thinking === false ? false : undefined)),
    web_search: fastPath ? false : (options.web_search != null ? !!options.web_search : undefined),
  };
}

const PYTH_FEEDS = {
  BTC:  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH:  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL:  '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  XRP:  '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
  DOGE: '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
  BNB:  '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
  HYPE: '0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b',
};

const fs = require('fs');
const path = require('path');

function readPythProKeyDirect() {
  if (process.env.PYTH_PRO_API_KEY) return process.env.PYTH_PRO_API_KEY;
  const paths = [
    path.join(__dirname, '../../secrets/PYTH_PRO_API_KEY.txt'),
    path.join(__dirname, '../secrets/PYTH_PRO_API_KEY.txt'),
    path.join(process.cwd(), 'secrets/PYTH_PRO_API_KEY.txt'),
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8').trim();
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const k = lines.find(l => !l.startsWith('#') && !l.includes('PYTH_PRO_API_KEY') && l.length > 20) || lines[lines.length - 1];
        if (k) return k;
      }
    } catch (_) {}
  }
  return '';
}

async function fetchPythSpotDirect(coin) {
  const sym = String(coin || 'BTC').toUpperCase();
  const feedId = PYTH_FEEDS[sym];
  if (!feedId) return null;
  const key = readPythProKeyDirect();
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=${encodeURIComponent(feedId)}`;
  const headers = { 'Accept': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000), headers });
    if (!resp.ok) return null;
    const data = await resp.json();
    const item = data?.parsed?.[0]?.price;
    if (item && item.price) {
      const raw = parseFloat(item.price);
      const expo = Number(item.expo || 0);
      const scaled = raw * Math.pow(10, expo);
      if (Number.isFinite(scaled) && scaled > 0) {
        return {
          price: scaled,
          publishTime: item.publish_time ? item.publish_time * 1000 : Date.now(),
        };
      }
    }
  } catch (_) {}
  return null;
}

async function fetchPolymarketPtbDirect(sym, horizon = '5m') {
  try {
    const symbol = String(sym || 'BTC').toUpperCase();
    const h = String(horizon || '5m').toLowerCase().replace(/\s+/g, '');
    let intervalSec = 300;
    let normHorizon = '5m';
    if (h === '15m' || h === '15' || h === 'h15') {
      intervalSec = 900;
      normHorizon = '15m';
    } else if (h === '60m' || h === '1h' || h === 'hourly' || h === '60' || h === 'h60') {
      intervalSec = 3600;
      normHorizon = '60m';
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const boundarySec = nowSec - (nowSec % intervalSec);
    const prefixMap = { BTC: 'btc', ETH: 'eth', SOL: 'sol', XRP: 'xrp', DOGE: 'doge', BNB: 'bnb', HYPE: 'hype' };
    const prefix = prefixMap[symbol] || symbol.toLowerCase();
    const slug = `${prefix}-updown-${normHorizon}-${boundarySec}`;

    // 1. Direct Polymarket Gamma market contract metadata
    try {
      const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (resp.ok) {
        const list = await resp.json();
        const m = Array.isArray(list) ? list[0] : list;
        const strike = Number(
          m?.eventMetadata?.priceToBeat ??
          m?.eventMetadata?.price_to_beat ??
          m?.priceToBeat ??
          m?.price_to_beat ??
          m?.targetPrice
        );
        if (Number.isFinite(strike) && strike > 0) return strike;
      }
    } catch (_) {}

    // 2. Direct Polymarket contract event page
    try {
      const resp = await fetch(`https://polymarket.com/event/${encodeURIComponent(slug)}`, {
        signal: AbortSignal.timeout(4000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (resp.ok) {
        const html = await resp.text();
        const fwd = [...html.matchAll(/\\"openPrice\\":\s*([0-9.]+)/g), ...html.matchAll(/"openPrice":\s*([0-9.]+)/g)];
        if (fwd.length > 0) {
          const val = Number(fwd[0][1]);
          if (Number.isFinite(val) && val > 0) return val;
        }
      }
    } catch (_) {}
  } catch (_) {}
  return null;
}

async function deskInfer(packet, mode, options = {}) {
  if (mode) setMode(mode);
  const m = getMode();

  // If spot price was missing or zero from renderer, actively hydrate from Pyth
  if (!packet.spot || packet.spot <= 0) {
    const livePyth = await fetchPythSpotDirect(packet.sym);
    if (livePyth && livePyth.price > 0) {
      packet.spot = livePyth.price;
      packet.spotSource = 'pyth-hermes-direct';
      packet.spotAgeSec = Math.max(0, Math.round((Date.now() - livePyth.publishTime) / 1000));
    }
  }

  // If PTB is missing or zero, actively hydrate from Polymarket chainlink candles
  if (!packet.priceToBeatNum || packet.priceToBeatNum <= 0) {
    const directPtb = await fetchPolymarketPtbDirect(packet.sym, packet.horizon);
    if (directPtb && directPtb > 0) {
      packet.priceToBeatNum = directPtb;
      packet.priceToBeatSource = 'polymarket-chainlink-candles-direct';
    }
  }

  // If PTB is still missing, PAUSE AND WAIT: do not fire model inference without immutable Polymarket PTB
  if (!packet.priceToBeatNum || packet.priceToBeatNum <= 0) {
    const local = Desk.inferLocal(packet, m);
    local.notes = 'HOLD_FLAT. Awaiting immutable Polymarket Up/Down contract PTB push.';
    local.warnings = [...(local.warnings || []), 'Awaiting immutable Polymarket PTB'];
    local._meta = {
      model: Desk.selectModel(packet, m),
      source: 'waiting-for-polymarket-ptb',
      latency: 0,
      waitingForPtb: true,
    };
    return {
      ok: true,
      contract: local,
      waitingForPtb: true,
      status: 'waiting_for_polymarket_ptb',
    };
  }

  // Ensure deltaVsPtb and liveDirection are precisely computed if both spot and PTB exist
  if (packet.spot && packet.spot > 0 && packet.priceToBeatNum && packet.priceToBeatNum > 0) {
    packet.deltaVsPtb = packet.spot - packet.priceToBeatNum;
    packet.liveDirection = packet.deltaVsPtb > 0 ? 'UP' : (packet.deltaVsPtb < 0 ? 'DOWN' : 'FLAT');
  }

  const {
    fastPath, model, plannerOn, reasoning_effort, enable_thinking, web_search,
  } = resolveDeskOptions(packet, options, m);
  const started = Date.now();
  try {
    const result = await Asi1Client.chatCompletion(
      [
        { role: 'system', content: Desk.SYSTEM_PROMPT },
        { role: 'user', content: Desk.userPrompt(packet) },
      ],
      {
        model,
        candidateModels: rosterFor({ model }),
        plannerMode: plannerOn,
        agents: plannerOn ? AGENTVERSE_PINNED_AGENTS.slice() : undefined,
        reasoning_effort,
        enable_thinking,
        web_search,
        temperature: options.temperature ?? 0.12,
        max_tokens: options.max_tokens ?? (plannerOn ? 2500 : (model === 'asi1-ultra' ? 2200 : 1200)),
        response_format: Desk.RESPONSE_FORMAT,
        timeoutMs: plannerOn ? 90000 : (fastPath ? 25000 : 50000),
      },
    );
    const { contract, source } = Desk.parseOrSynthesize(
      result.content,
      result.thought || result.raw?.choices?.[0]?.message?.reasoning_content,
      m,
      packet
    );
    const isFallback = source === 'inferLocal';
    contract._meta = {
      model: result.model || model,
      account: result.account || null,
      email: result.email || null,
      latency: Date.now() - started,
      source,
      thought: result.thought || (typeof result.content === 'string' ? result.content.slice(0, 300) : null),
    };
    return { ok: true, contract, fallback: isFallback };
  } catch (err) {
    const local = Desk.inferLocal(packet, m);
    local._meta = {
      model,
      source: 'inferLocal',
      latency: Date.now() - started,
      error: String(err?.message || err).slice(0, 180),
    };
    return {
      ok: true,
      contract: local,
      fallback: true,
      error: String(err?.message || err).slice(0, 180),
    };
  }
}

module.exports = {
  ASI1_ALL_MODELS,
  DESK_MODES,
  rosterFor,
  chat,
  getMode,
  setMode,
  plannerEnabled,
  resolveDeskOptions,
  deskInfer,
  fetchPythSpotDirect,
  fetchPolymarketPtbDirect,
  shouldSkipTokenmix,
  markTokenmixExhausted,
  reshapeCascade,
};
