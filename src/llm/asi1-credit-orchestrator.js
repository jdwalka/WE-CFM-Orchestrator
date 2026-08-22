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

async function deskInfer(packet, mode, options = {}) {
  if (mode) setMode(mode);
  const m = getMode();
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
  shouldSkipTokenmix,
  markTokenmixExhausted,
  reshapeCascade,
};
