/**
 * SignalCalibrator — live-first blend + online recalibration for 5m/15m binaries.
 *
 * Hierarchy (empirically the quant PredictionEngine loses to AI + live tape):
 *   1. Settlement path: Pyth spot vs Polymarket PTB (contract definition)
 *   2. AI inference (spot, book, volume, odds already in the prompt)
 *   3. Live microstructure: CLOB mid, book OFI, tick/volume pressure
 *   4. Quant model as a *weak baseline prior* — never flips a live+AI consensus
 *
 * Meta-label (López de Prado style): after each settled window we update
 * per-source hit rates and shrink weights that are worse than a coin flip.
 *
 *   window.SignalCalibrator.blend(input) -> verdict
 *   window.SignalCalibrator.record(sym, horizon, { ai, model, blend }, actual)
 *   window.SignalCalibrator.stats(sym)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.SignalCalibrator = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORE_KEY = 'wecrypto.signalCalibrator.v1';
  const MIN_N = 8;
  const MODEL_PRIOR_CAP = 0.08;
  const LATE_TTC_SEC = 90;

  const BASE_WEIGHTS = Object.freeze({
    path: 0.30,
    ai: 0.34,
    clob: 0.12,
    book: 0.10,
    volume: 0.08,
    model: 0.06,
  });

  const _state = {
    global: { ai: { h: 0, n: 0 }, model: { h: 0, n: 0 }, blend: { h: 0, n: 0 } },
    coins: Object.create(null),
  };

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function normCall(c) {
    const u = String(c || '').toUpperCase().trim();
    if (u === 'UP' || u === 'BUY_UP' || u === 'YES' || u === 'LONG') return 'UP';
    if (u === 'DOWN' || u === 'BUY_DOWN' || u === 'NO' || u === 'SHORT') return 'DOWN';
    return null;
  }

  function wr(rec) {
    return rec && rec.n >= MIN_N ? rec.h / rec.n : null;
  }

  function coinBucket(sym) {
    const k = String(sym || 'ALL').toUpperCase();
    if (!_state.coins[k]) {
      _state.coins[k] = {
        ai: { h: 0, n: 0 },
        model: { h: 0, n: 0 },
        blend: { h: 0, n: 0 },
      };
    }
    return _state.coins[k];
  }

  function load() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.global) _state.global = parsed.global;
      if (parsed?.coins) _state.coins = parsed.coins;
    } catch (_) { /* */ }
  }

  function save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORE_KEY, JSON.stringify(_state));
      }
    } catch (_) { /* */ }
  }

  function ingestResolutionLog(log) {
    if (!Array.isArray(log) || !log.length) return;
    for (const e of log.slice(-200)) {
      const actual = normCall(e.actualOutcome || e.outcome || e.settlement);
      if (!actual) continue;
      const sym = e.sym || e.coin;
      const ai = normCall(e.aiCall || e.llmCall || e.effectiveCall);
      const model = normCall(e.modelDir || e.model);
      const blend = normCall(e.blendCall);
      if (ai) _bump(sym, 'ai', ai === actual);
      if (model) _bump(sym, 'model', model === actual);
      if (blend) _bump(sym, 'blend', blend === actual);
    }
    save();
  }

  function _bump(sym, key, hit) {
    const g = _state.global[key] || (_state.global[key] = { h: 0, n: 0 });
    g.n += 1;
    if (hit) g.h += 1;
    if (sym) {
      const c = coinBucket(sym)[key] || (coinBucket(sym)[key] = { h: 0, n: 0 });
      c.n += 1;
      if (hit) c.h += 1;
    }
  }

  function adaptiveWeights(sym, ttcSec) {
    const w = { ...BASE_WEIGHTS };
    const gAi = wr(_state.global.ai);
    const gModel = wr(_state.global.model);
    const c = coinBucket(sym);
    const cAi = wr(c.ai);
    const cModel = wr(c.model);

    const aiWr = cAi != null ? cAi : gAi;
    const modelWr = cModel != null ? cModel : gModel;

    if (aiWr != null && aiWr >= 0.54) w.ai += 0.06;
    if (aiWr != null && aiWr < 0.48) w.ai -= 0.08;
    if (modelWr != null && modelWr < 0.50) w.model = Math.min(w.model, 0.03);
    if (modelWr != null && modelWr < 0.46) w.model = 0.015;
    if (modelWr != null && modelWr >= 0.54) w.model = Math.min(0.10, w.model + 0.03);

    if (ttcSec != null && ttcSec <= LATE_TTC_SEC) {
      w.path += 0.16;
      w.ai -= 0.06;
      w.model = Math.min(w.model, 0.02);
    }

    w.model = clamp(w.model, 0, MODEL_PRIOR_CAP);
    const sum = Object.values(w).reduce((s, v) => s + v, 0) || 1;
    for (const k of Object.keys(w)) w[k] = w[k] / sum;
    if (w.model > MODEL_PRIOR_CAP) {
      const rest = 1 - w.model;
      const targetRest = 1 - MODEL_PRIOR_CAP;
      const scale = rest > 0 ? targetRest / rest : 1;
      for (const k of Object.keys(w)) {
        if (k !== 'model') w[k] *= scale;
      }
      w.model = MODEL_PRIOR_CAP;
    }
    return w;
  }

  function collectLive(input) {
    const m = input.market || {};
    const live = [];
    const spot = num(m.spot ?? input.spot);
    const ptb = num(m.ptb ?? input.ptb);
    if (spot > 0 && ptb > 0) {
      const bps = ((spot - ptb) / ptb) * 10000;
      if (Math.abs(bps) >= 0.8) {
        live.push({
          source: 'path',
          call: bps > 0 ? 'UP' : 'DOWN',
          strength: clamp(Math.abs(bps) / 8, 0.4, 1),
          detail: `${bps >= 0 ? '+' : ''}${bps.toFixed(1)}bps vs PTB`,
        });
      }
    }

    const yes = num(m.yesProb ?? m.probability ?? m.upProbability ?? input.yesProb);
    if (yes != null && Math.abs(yes - 0.5) >= 0.06) {
      live.push({
        source: 'clob',
        call: yes >= 0.5 ? 'UP' : 'DOWN',
        strength: clamp(Math.abs(yes - 0.5) / 0.30, 0.35, 1),
        detail: `P(Up)=${(yes * 100).toFixed(1)}%`,
      });
    }

    const imb = num(m.depthImbalance ?? input.depthImbalance);
    if (imb != null && Math.abs(imb) >= 0.10) {
      live.push({
        source: 'book',
        call: imb > 0 ? 'UP' : 'DOWN',
        strength: clamp(Math.abs(imb), 0.3, 1),
        detail: `book=${imb.toFixed(3)}`,
      });
    }

    const vol = num(input.volumeDelta ?? m.volumeDelta ?? input.tickBps);
    if (vol != null && Math.abs(vol) >= 1) {
      live.push({
        source: 'volume',
        call: vol > 0 ? 'UP' : 'DOWN',
        strength: clamp(Math.abs(vol) / 12, 0.25, 0.85),
        detail: `flow=${vol.toFixed(2)}`,
      });
    }

    const ld = normCall(m.liveDirection || input.liveDirection);
    if (ld && !live.some((v) => v.source === 'path')) {
      live.push({ source: 'path', call: ld, strength: 0.55, detail: `liveDirection=${ld}` });
    }

    return live;
  }

  /**
   * @param {object} input
   * @returns {{
   *   call: 'UP'|'DOWN'|null,
   *   confidence: number,
   *   pUp: number,
   *   source: string,
   *   weights: object,
   *   components: object[],
   *   modelCapped: boolean,
   *   reason: string
   * }}
   */
  function blend(input = {}) {
    const sym = String(input.sym || input.market?.sym || '').toUpperCase();
    const ttc = num(input.secondsToClose ?? input.market?.secondsToClose);
    const weights = adaptiveWeights(sym, ttc);
    const components = [];

    const aiCall = normCall(input.call || input.aiCall);
    const aiConf = clamp(num(input.confidence) ?? 0.55, 0, 1);
    if (aiCall) {
      components.push({
        source: 'ai',
        call: aiCall,
        weight: weights.ai * (0.65 + 0.35 * aiConf),
        detail: `AI ${aiCall} @${(aiConf * 100).toFixed(0)}%`,
      });
    }

    for (const v of collectLive(input)) {
      const key = v.source === 'path' ? 'path' : (weights[v.source] != null ? v.source : 'volume');
      components.push({
        source: v.source,
        call: v.call,
        weight: (weights[key] || 0.06) * v.strength,
        detail: v.detail,
      });
    }

    const ms = num(input.modelScore ?? input.score);
    const modelCall = Number.isFinite(ms) && Math.abs(ms) >= 0.12
      ? (ms > 0 ? 'UP' : 'DOWN')
      : normCall(input.modelDirection);
    let modelCapped = false;
    if (modelCall) {
      const liveConsensus = _majority(components.filter((c) => c.source !== 'ai' && c.source !== 'model'));
      const aiAgreesLive = aiCall && liveConsensus.call && aiCall === liveConsensus.call;
      if (aiAgreesLive && modelCall !== aiCall) {
        modelCapped = true;
      }
      components.push({
        source: 'model',
        call: modelCall,
        weight: modelCapped ? weights.model * 0.15 : weights.model * clamp(Math.abs(ms || 0.4), 0.25, 1),
        detail: modelCapped
          ? `model ${modelCall} capped (AI+live=${aiCall})`
          : `model ${modelCall} score=${ms != null ? ms.toFixed(3) : 'n/a'}`,
      });
    }

    const tot = _majority(components);
    const path = components.find((c) => c.source === 'path');
    let call = tot.call;
    let source = 'blend';
    if (path && path.weight >= 0.12 && ttc != null && ttc <= LATE_TTC_SEC) {
      call = path.call;
      source = 'path_late';
    } else if (aiCall && path && aiCall === path.call) {
      call = aiCall;
      source = 'ai+path';
    }

    const pUp = _pUp(components);
    const confidence = call
      ? clamp(0.50 + Math.abs(pUp - 0.5) * 1.15, 0.50, 0.96)
      : 0.5;

    const reason = call
      ? `${call} via ${source} [${components.map((c) => c.source).join('+')}]`
      : 'insufficient live/AI edge';

    return {
      call,
      confidence,
      pUp,
      source,
      weights,
      components,
      modelCapped,
      reason,
      ts: Date.now(),
      sym,
    };
  }

  function _majority(components) {
    let up = 0;
    let down = 0;
    for (const c of components) {
      if (c.call === 'UP') up += c.weight;
      else if (c.call === 'DOWN') down += c.weight;
    }
    if (up === down) return { call: null, up, down };
    return { call: up > down ? 'UP' : 'DOWN', up, down };
  }

  function _pUp(components) {
    let up = 0;
    let down = 0;
    for (const c of components) {
      if (c.call === 'UP') up += c.weight;
      else if (c.call === 'DOWN') down += c.weight;
    }
    const s = up + down;
    if (s <= 0) return 0.5;
    return up / s;
  }

  function record(sym, _horizon, picks, actualRaw) {
    const actual = normCall(actualRaw);
    if (!actual) return stats(sym);
    if (picks?.ai) _bump(sym, 'ai', normCall(picks.ai) === actual);
    if (picks?.model) _bump(sym, 'model', normCall(picks.model) === actual);
    if (picks?.blend) _bump(sym, 'blend', normCall(picks.blend) === actual);
    save();
    return stats(sym);
  }

  function stats(sym) {
    const c = sym ? coinBucket(sym) : _state.global;
    return {
      ai: { ...c.ai, wr: wr(c.ai) },
      model: { ...c.model, wr: wr(c.model) },
      blend: { ...c.blend, wr: wr(c.blend) },
      weights: adaptiveWeights(sym),
    };
  }

  function reset() {
    _state.global = { ai: { h: 0, n: 0 }, model: { h: 0, n: 0 }, blend: { h: 0, n: 0 } };
    _state.coins = Object.create(null);
    save();
  }

  load();
  if (typeof window !== 'undefined' && Array.isArray(window._15mResolutionLog)) {
    ingestResolutionLog(window._15mResolutionLog);
  }

  return {
    blend,
    record,
    stats,
    reset,
    ingestResolutionLog,
    adaptiveWeights,
    BASE_WEIGHTS,
    MODEL_PRIOR_CAP,
  };
}));
