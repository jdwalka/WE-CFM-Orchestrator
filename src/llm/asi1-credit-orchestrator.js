/**
 * TokenMix-credit failover → full ASI1 roster.
 *
 * When tokenmix.ai returns 402 / "out of credits", skip TokenMix and walk
 * every ASI:One model (ultra → fast → mini → agentic asi1) across every
 * configured ASI1 key. Node-only; required by llm_signal_assistant.
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

const DESK_MODES = Desk.MODES;
let _deskMode = Desk.normalizeMode(process.env.ASI1_DESK_MODE || 'dual_fire');

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

async function deskInfer(packet, mode, options = {}) {
  if (mode) setMode(mode);
  const m = getMode();
  const explicitModel = options.model && options.model !== 'auto' ? options.model : null;
  const model = explicitModel || Desk.selectModel(packet, m);
  const plannerOn = options.plannerMode != null ? !!options.plannerMode : Desk.plannerAllowed(packet, m);
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
        reasoning_effort: options.reasoning_effort || options.effort || undefined,
        enable_thinking: options.enable_thinking != null ? options.enable_thinking : (options.thinking === false ? false : undefined),
        web_search: options.web_search != null ? !!options.web_search : undefined,
        temperature: options.temperature ?? 0.12,
        max_tokens: options.max_tokens ?? (plannerOn ? 2500 : (model === 'asi1-ultra' ? 2200 : 1200)),
        response_format: Desk.RESPONSE_FORMAT,
        timeoutMs: plannerOn ? 90000 : (Desk.isFastPath(packet) ? 25000 : 50000),
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
  isCreditError,
  shouldSkipTokenmix,
  markTokenmixExhausted,
  rosterFor,
  reshapeCascade,
  chat,
  getMode,
  setMode,
  plannerEnabled,
  deskInfer,
};
