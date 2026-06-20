/**

 * Trading RL stack: DQN + vanilla MCTS + CFR + mispricing hunter for contrarian plays.

 */

(function (root, factory) {

  const api = factory(root);

  if (typeof module !== 'undefined' && module.exports) {

    module.exports = api;

  } else {

    root.TradingRLAgent = api;

  }

}(typeof self !== 'undefined' ? self : this, function (root) {

  'use strict';

  if (typeof require !== 'undefined' && !root.RLFeatureEncoder) {
    try {
      root.RLFeatureEncoder = require('./feature-encoder');
      root.MCTS = require('./mcts');
      root.CFRAgent = require('./cfr-agent').CFRAgent;
      root.DeepQAgent = require('./deep-q-agent').DeepQAgent;
      root.MispricingHunter = require('./mispricing-hunter');
    } catch (_) { /* browser bundle */ }
  }

  const enc = root.RLFeatureEncoder || null;

  const MCTS = root.MCTS || null;

  const CFRAgent = root.CFRAgent || null;

  const DeepQAgent = root.DeepQAgent || null;

  const MispricingHunter = root.MispricingHunter || null;



  const DEFAULT_CONFIG = {

    enabled: true,

    mctsIterations: 100,

    rapidMctsBoost: 1.2,

    rapidThreshold: 0.38,

    mispricingMinHunt: 0.42,

    contrarianBoost: 0.22,

    blend: { dqn: 0.30, mcts: 0.30, cfr: 0.25, mispricing: 0.15 },

    rapidBlend: { dqn: 0.35, mcts: 0.38, cfr: 0.12, mispricing: 0.15 },

  };



  let config = { ...DEFAULT_CONFIG };

  let dqn = null;

  let cfr = null;

  let loaded = false;



  function actionLabel(id) {

    return enc?.ACTION_LABEL?.[id] ?? (id === 1 ? 'UP' : id === 2 ? 'DOWN' : 'WAIT');

  }



  function initFromBundle(bundle) {

    if (!bundle) return false;

    config = { ...DEFAULT_CONFIG, ...(bundle.config || {}) };

    if (bundle.dqn && DeepQAgent) {

      dqn = DeepQAgent.fromJSON(bundle.dqn);

      dqn.epsilon = Math.min(dqn.epsilon ?? 0.1, config.epsilonCap ?? 0.12);

    }

    if (bundle.cfr && CFRAgent) {

      cfr = CFRAgent.fromJSON(bundle.cfr);

    }

    loaded = !!(dqn || cfr);

    return loaded;

  }



  async function loadModel(url) {

    try {

      const res = await fetch(url);

      if (!res.ok) return false;

      const bundle = await res.json();

      return initFromBundle(bundle);

    } catch (err) {

      console.warn('[TradingRLAgent] model load failed:', err?.message || err);

      return false;

    }

  }



  function ensureAgents() {

    if (!dqn && DeepQAgent && enc) {

      dqn = new DeepQAgent(enc.FEATURE_SIZE, 3, { epsilon: 0.1, epsilonMin: 0.05 });

    }

    if (!cfr && CFRAgent) {

      cfr = new CFRAgent(3);

    }

  }



  function buildMispricing(ctx = {}) {

    if (!MispricingHunter?.analyze) return null;

    return MispricingHunter.analyze({

      kalshiAlign: ctx.kalshiAlign,

      strikeDir: ctx.kalshiAlign?.strikeDir,

      modelYesPct: ctx.kalshiAlign?.modelYesPct,

      kalshiYesPct: ctx.kalshiAlign?.kalshiYesPct,

      msToClose: ctx.kalshiAlign?.closeTimeMs

        ? Math.max(0, ctx.kalshiAlign.closeTimeMs - Date.now())

        : ctx.msToClose ?? 0,

      probVelocity: ctx.probVelocity ?? 0,

      rapidScore: ctx.rapidScore ?? 0,

    });

  }



  function buildBookCtx(ctx = {}) {

    const imb = ctx.imbalanceVelocity ?? ctx.signalVector?.imbalanceVelocity ?? ctx.liveBook?.imbalanceVelocity ?? 0;

    const spreadPct = ctx.spreadPct ?? ctx.liveBook?.spreadPct ?? 0;

    const toxicity = ctx.toxicity ?? ctx.signalVector?.toxicity ?? 0;

    const bidWall = ctx.bidWall ?? ctx.liveBook?.bidWall ?? 0;

    const askWall = ctx.askWall ?? ctx.liveBook?.askWall ?? 0;

    const wallPressure = clamp((bidWall - askWall) / Math.max(bidWall + askWall, 1), -1, 1);

    return { imbalance: imb, spreadPct, toxicity, wallPressure, bidWall, askWall };

  }



  function encodeExtras(ctx = {}, mispricing = null) {

    const msToClose = ctx.kalshiAlign?.closeTimeMs

      ? Math.max(0, ctx.kalshiAlign.closeTimeMs - Date.now())

      : Number(ctx.msToClose ?? 900000);

    const ttcNorm = clamp(msToClose / 900000, 0, 1);



    return {

      tapeVelocity: ctx.tapeVelocity?.directionalConsistency ?? ctx.tapeVelocity?.state ?? 0,

      rangeExpansion: ctx.tapeVelocity?.rangeExpansion ?? 0,

      bodyExpansion: ctx.tapeVelocity?.bodyExpansion ?? 0,

      volumeBurst: ctx.tapeVelocity?.volumeBurst ?? 0,

      imbalanceVelocity: ctx.imbalanceVelocity ?? ctx.signalVector?.imbalanceVelocity ?? 0,

      probVelocity: ctx.probVelocity ?? 0,

      atrPct: ctx.atrPct ?? 0,

      compositeScore: ctx.score ?? 0,

      agreement: ctx.agreement ?? 0.5,

      conflict: ctx.conflict ?? 0,

      mispricingPp: mispricing?.mispricingPp ?? 0,

      projectedMispricingPp: mispricing?.projectedMispricingPp ?? 0,

      ttcNorm,

      crowdExtreme: mispricing?.crowdExtreme ?? false,

      contrarian: mispricing?.contrarian ?? false,

      huntScore: mispricing?.huntScore ?? 0,

    };

  }



  /**

   * Fuse DQN + MCTS + CFR + mispricing hunter into a single action recommendation.

   */

  function decide(ctx = {}) {

    if (!config.enabled) return { action: 'pass', reason: 'disabled' };

    ensureAgents();

    if (!enc) return { action: 'pass', reason: 'no_encoder' };



    const mispricing = buildMispricing(ctx);

    const extras = encodeExtras(ctx, mispricing);

    const state = enc.encodeSignalVector(ctx.signalVector || {}, extras);

    const bookCtx = buildBookCtx(ctx);



    const rapid = enc.rapidMoveScore({

      rangeExpansion: extras.rangeExpansion,

      bodyExpansion: extras.bodyExpansion,

      volumeBurst: extras.volumeBurst,

      tapeVelocity: extras.tapeVelocity,

      probVelocity: extras.probVelocity,

    });

    const isRapid = rapid >= config.rapidThreshold;



    const q = dqn ? dqn.qValues(state) : [0, 0, 0];

    const dqnAction = dqn ? argmax(q) : 0;



    let mctsResult = null;

    if (MCTS?.search) {

      mctsResult = MCTS.search({

        state,

        qValues: () => q,

        iterations: config.mctsIterations,

        rapidBoost: isRapid ? config.rapidMctsBoost : 0,

        bookCtx,

        adversarialWeight: isRapid ? 0.24 : 0.16,

      });

    }



    const infoKey = cfr ? cfr.infoSetKey(state, bookCtx) : 'default';

    const cfrStrategy = cfr ? cfr.getAverageStrategy(infoKey) : [0.33, 0.33, 0.34];

    const cfrAction = cfr ? argmax(cfrStrategy) : 0;



    const huntAction = mispricing?.recommendedAction && mispricing.recommendedAction !== 'WAIT'

      ? enc.directionToAction(mispricing.recommendedAction)

      : enc.ACTION.WAIT;

    const huntPolicy = [0.05, 0.05, 0.05];

    if (mispricing?.huntScore > 0) {

      huntPolicy[huntAction] = 0.5 + mispricing.huntScore * 0.45;

      const rest = (1 - huntPolicy[huntAction]) / 2;

      for (let a = 0; a < 3; a++) if (a !== huntAction) huntPolicy[a] = rest;

    }



    const weights = isRapid ? config.rapidBlend : config.blend;

    const fused = [0, 0, 0];

    const mctsPolicy = mctsResult?.policy ?? [0.33, 0.33, 0.34];

    const dqnSoft = softmax(q);



    for (let a = 0; a < 3; a++) {

      fused[a] =

        (dqnSoft[a] ?? 0) * weights.dqn +

        (mctsPolicy[a] ?? 0) * weights.mcts +

        (cfrStrategy[a] ?? 0) * weights.cfr +

        (huntPolicy[a] ?? 0) * (weights.mispricing ?? 0.15);

    }

    const fusedAction = argmax(fused);

    const confidence = clamp(fused[fusedAction] / (fused.reduce((s, v) => s + v, 0) || 1), 0, 1);



    return {

      action: actionLabel(fusedAction),

      actionId: fusedAction,

      confidence,

      rapidMove: isRapid,

      rapidScore: rapid,

      state,

      infoKey,

      mispricing,

      sources: {

        dqn: { action: actionLabel(dqnAction), q: q.slice() },

        mcts: mctsResult ? { action: actionLabel(mctsResult.action), policy: mctsResult.policy, iters: mctsResult.iterations } : null,

        cfr: { action: actionLabel(cfrAction), strategy: cfrStrategy.slice() },

        mispricing: mispricing ? {

          action: mispricing.recommendedAction,

          huntScore: mispricing.huntScore,

          playType: mispricing.playType,

          projectedEdgePp: mispricing.projectedMispricingPp,

        } : null,

      },

      fusedPolicy: fused,

    };

  }



  /** Apply RL decision to model score — contrarian boost when mispricing hunt fires. */

  function applyToScore(score, ctx = {}) {

    const decision = decide(ctx);

    if (decision.action === 'pass') return { score, decision, gated: false };



    const { actionId, confidence, rapidMove, rapidScore, mispricing } = decision;

    let newScore = score;



    if (actionId === enc.ACTION.WAIT) {

      if (mispricing?.huntScore >= config.mispricingMinHunt && mispricing.recommendedAction !== 'WAIT') {

        const huntDir = mispricing.recommendedAction === 'UP' ? 1 : -1;

        newScore = huntDir * Math.max(0.18, mispricing.huntScore * 0.62);

        return {

          score: clamp(newScore, -1, 1),

          decision,

          gated: false,

          reason: mispricing.playType || 'mispricing_hunt',

        };

      }

      newScore = score * (rapidMove ? 0.25 : 0.42);

      return { score: newScore, decision, gated: true, reason: 'rl_wait' };

    }



    const rlDir = actionId === enc.ACTION.UP ? 1 : -1;

    const scoreDir = score > 0.08 ? 1 : score < -0.08 ? -1 : 0;

    let alignBoost = 1 + confidence * (rapidMove ? 0.28 : 0.16) + rapidScore * 0.12;



    if (mispricing?.contrarian && mispricing.huntScore >= config.mispricingMinHunt) {

      alignBoost += config.contrarianBoost + mispricing.huntScore * 0.15;

    }

    if (mispricing?.playType === 'mispricing_hunt' || mispricing?.playType === 'contrarian_mispricing') {

      alignBoost += 0.12 + (mispricing.huntScore ?? 0) * 0.1;

    }



    if (scoreDir !== 0 && scoreDir !== rlDir) {

      if (mispricing?.huntScore >= config.mispricingMinHunt && mispricing.contrarian) {

        newScore = rlDir * Math.max(0.22, confidence * 0.55 + mispricing.huntScore * 0.35);

        return {

          score: clamp(newScore, -1, 1),

          decision,

          gated: false,

          reason: 'contrarian_override',

        };

      }

      newScore = score * (rapidMove ? 0.45 : 0.58);

      return { score: newScore, decision, gated: true, reason: 'rl_conflict' };

    }



    if (scoreDir === 0) {

      newScore = rlDir * Math.max(0.12, confidence * (rapidMove ? 0.55 : 0.38));

    } else {

      newScore = score * alignBoost;

    }



    newScore = clamp(newScore, -1, 1);

    return {

      score: newScore,

      decision,

      gated: false,

      reason: mispricing?.playType && mispricing.playType !== 'none'

        ? mispricing.playType

        : (rapidMove ? 'rl_rapid_align' : 'rl_align'),

    };

  }



  /** Call on contract settlement — trains DQN memory + CFR regrets with contrarian bonus. */

  function learnFromOutcome(ctx, actualDirection, movePct = 0) {

    ensureAgents();

    if (!enc) return null;



    const mispricing = ctx.mispricing || buildMispricing(ctx);

    const extras = encodeExtras(ctx, mispricing);

    const state = enc.encodeSignalVector(ctx.signalVector || {}, extras);

    const bookCtx = buildBookCtx(ctx);

    const rapid = enc.rapidMoveScore(extras);

    const actionId = ctx.rlActionId ?? enc.directionToAction(ctx.predDirection) ?? enc.ACTION.WAIT;

    const reward = enc.rewardForAction(actionId, actualDirection, rapid, {

      contrarian: mispricing?.contrarian,

      huntScore: mispricing?.huntScore,

      playType: mispricing?.playType,

    });



    if (dqn) {

      const nextState = state.slice();

      dqn.remember(state, actionId, reward, nextState, true);

      dqn.replay();

    }



    if (cfr) {

      const q = dqn ? dqn.qValues(state) : [0, 0, 0];

      const values = q.map((v, i) => (i === actionId ? reward : v * 0.5));

      cfr.updateFromOutcome(cfr.infoSetKey(state, bookCtx), actionId, reward, values);

    }



    return { reward, rapid, actionId, mispricing };

  }



  function getBundle() {

    return {

      version: 2,

      config,

      dqn: dqn?.toJSON?.() ?? null,

      cfr: cfr?.toJSON?.() ?? null,

      savedAt: new Date().toISOString(),

    };

  }



  function argmax(arr) {

    let best = 0;

    for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;

    return best;

  }



  function softmax(arr) {

    const max = Math.max(...arr);

    const exps = arr.map((v) => Math.exp((v - max) * 1.2));

    const sum = exps.reduce((s, v) => s + v, 0) || 1;

    return exps.map((e) => e / sum);

  }



  function clamp(v, lo, hi) {

    return Math.max(lo, Math.min(hi, v));

  }



  return {

    DEFAULT_CONFIG,

    initFromBundle,

    loadModel,

    decide,

    applyToScore,

    learnFromOutcome,

    getBundle,

    isLoaded: () => loaded,

    getConfig: () => ({ ...config }),

  };

}));


