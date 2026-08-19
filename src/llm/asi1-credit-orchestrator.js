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

// TokenMix / OpenAI-compat credit exhaustion only. Do not treat 429 quota,
// generic "billing", or prepaid-plan copy as a permanent skip.
const CREDIT_RES = [
  /\bhttp\s*402\b/,
  /\bstatus(?:code)?[:\s]*402\b/,
  /\bpayment required\b/,
  /\binsufficient credits?\b/,
  /\bno credits?\b/,
  /\bcredits? exhausted\b/,
  /\bout of credits?\b/,
  /\bbalance too low\b/,
  /\binsufficient[_ ](?:funds|balance)\b/,
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
  // Economy / planner desk: do not spend TokenMix even if the key still works.
  if (_deskMode === 'asi1_only' || _deskMode === 'planner') return true;
  if (assistant?._tokenmixCreditExhausted) return true;
  const remaining = typeof assistant?._providerCooldownRemaining === 'function'
    ? assistant._providerCooldownRemaining('tokenmix')
    : 0;
  if (remaining > 0 && isCreditError({ message: tokenmixCreditReason(assistant) })) return true;
  return false;
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

function reshapeCascade(cascade, assistant) {
  const next = Array.isArray(cascade) ? cascade.slice() : [];
  if (!shouldSkipTokenmix(assistant)) return next;
  const filtered = next.filter((p) => p !== 'tokenmix');
  if (!filtered.includes('asi1')) filtered.unshift('asi1');
  return filtered;
}

async function chat(messages, options = {}) {
  return Asi1Client.chatCompletion(messages, {
    ...options,
    candidateModels: rosterFor(options),
  });
}

async function deskInfer(packet, mode) {
  if (mode) setMode(mode);
  const m = getMode();
  const local = Desk.inferLocal(packet, m);
  const model = Desk.selectModel(packet, m);
  const plannerOn = Desk.plannerAllowed(packet, m);
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
        temperature: 0.12,
        max_tokens: plannerOn ? 1800 : 900,
        response_format: Desk.RESPONSE_FORMAT,
        timeoutMs: plannerOn ? 90000 : (Desk.isFastPath(packet) ? 20000 : 45000),
      },
    );
    let parsed = null;
    try { parsed = JSON.parse(String(result.content || '')); } catch (_) { parsed = null; }
    const contract = Desk.normalizeContract(parsed || local, m, packet);
    contract._meta = {
      model: result.model || model,
      account: result.account || null,
      email: result.email || null,
      latency: Date.now() - started,
      source: parsed ? 'asi1' : 'inferLocal',
      thought: result.thought || null,
    };
    return { ok: true, contract, fallback: !parsed };
  } catch (err) {
    local._meta = {
      ...(local._meta || {}),
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
