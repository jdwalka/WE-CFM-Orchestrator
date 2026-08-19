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

function rosterFor(options = {}) {
  const preferred = String(options.model || '').trim();
  const all = ASI1_ALL_MODELS.slice();
  if (preferred && !all.includes(preferred)) return [preferred, ...all];
  if (preferred) return [preferred, ...all.filter((m) => m !== preferred)];
  return all;
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
  rosterFor,
  chat,
  getMode,
  setMode,
  plannerEnabled,
  deskInfer,
};
