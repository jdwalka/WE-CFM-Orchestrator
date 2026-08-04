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
      root.HorizonSniper = require('./horizon-sniper');
    } catch (_) { /* browser bundle */ }
  }

  const enc = root.RLFeatureEncoder || null;

  const MCTS = root.MCTS || null;

  const CFRAgent = root.CFRAgent || null;

  const DeepQAgent = root.DeepQAgent || null;

  const MispricingHunter = root.MispricingHunter || null;

  const HorizonSniper = root.HorizonSniper || null;



  const DEFAULT_CONFIG = {

    enabled: true,

    mctsIterations: 100,

    rapidMctsBoost: 1.2,

    rapidThreshold: 0.38,

    mispricingMinHunt: 0.42,

    contrarianBoost: 0.22,

    pathwayBiasScale: 0.62,

    pathwayLearnBlend: 0.34,

    pathwayLearningRate: 0.18,

    pathwayActivationFloor: 0.18,

    blend: { dqn: 0.30, mcts: 0.30, cfr: 0.25, mispricing: 0.15 },

    rapidBlend: { dqn: 0.35, mcts: 0.38, cfr: 0.12, mispricing: 0.15 },

  };



  let config = { ...DEFAULT_CONFIG };

  let dqn = null;

  let cfr = null;

  let loaded = false;

  let sniper = null;

  const PATHWAY_META = {
    trend_follow: { label: 'Trend Follow' },
    rapid_breakout: { label: 'Rapid Breakout' },
    contrarian_mispricing: { label: 'Contrarian Mispricing' },
    liquidity_reversion: { label: 'Liquidity Reversion' },
    late_window_scalp: { label: 'Late Window Scalp' },
  };

  let pathwayTable = buildPathwayTable();



  function actionLabel(id) {

    return enc?.ACTION_LABEL?.[id] ?? (id === 1 ? 'UP' : id === 2 ? 'DOWN' : 'WAIT');

  }

  function pathwayLabel(id) {

    return PATHWAY_META[id]?.label ?? id;

  }

  function createPathwayState(seed = {}) {

    const actionValues = Array.isArray(seed.actionValues)
      ? seed.actionValues.slice(0, 3).map((v) => Number(v) || 0)
      : [0, 0, 0];

    while (actionValues.length < 3) actionValues.push(0);

    const seen = Math.max(0, Math.round(Number(seed.seen ?? seed.count ?? 0) || 0));

    const totalReward = Number(seed.totalReward ?? 0) || 0;

    const avgReward = seen
      ? totalReward / seen
      : (Number(seed.avgReward ?? 0) || 0);

    const lastAction = Number(seed.lastAction);

    return {
      seen,
      totalReward,
      avgReward,
      actionValues,
      lastReward: Number(seed.lastReward ?? 0) || 0,
      lastAction: Number.isFinite(lastAction) ? lastAction : 0,
      lastSeenAt: Number(seed.lastSeenAt ?? 0) || 0,
    };

  }

  function buildPathwayTable(seed = {}) {

    return Object.keys(PATHWAY_META).reduce((acc, id) => {

      acc[id] = createPathwayState(seed?.[id]);

      return acc;

    }, {});

  }

  function normalizePolicy(values, fallback = [0.34, 0.33, 0.33]) {

    const arr = Array.isArray(values)
      ? values.slice(0, 3).map((v) => Math.max(0, Number(v) || 0))
      : fallback.slice();

    while (arr.length < 3) arr.push(0);

    const sum = arr.reduce((s, v) => s + v, 0);

    if (!sum) return fallback.slice();

    return arr.map((v) => v / sum);

  }

  function directionalPolicy(signal = 0, conviction = 0.5, waitFloor = 0.12) {

    const signed = clamp(Number(signal) || 0, -1, 1);

    const magnitude = clamp(Math.abs(signed), 0, 1);

    const conf = clamp(Number(conviction) || 0, 0, 1);

    const wait = clamp(waitFloor + (1 - conf) * 0.35 + (1 - magnitude) * 0.2, 0.06, 0.82);

    const directional = Math.max(0.05, 1 - wait);

    const tilt = 0.5 + signed * 0.5;

    return normalizePolicy([wait, directional * tilt, directional * (1 - tilt)]);

  }

  function actionPolicy(actionId, conviction = 0.7, waitFloor = 0.08) {

    const conf = clamp(Number(conviction) || 0, 0, 1);

    if (actionId === enc?.ACTION?.WAIT || actionId === 0) {

      return normalizePolicy([0.62 + (1 - conf) * 0.18, 0.19, 0.19]);

    }

    const policy = [waitFloor + (1 - conf) * 0.25, 0.12, 0.12];

    policy[actionId === enc?.ACTION?.DOWN || actionId === 2 ? 2 : 1] += 0.72 + conf * 0.55;

    return normalizePolicy(policy);

  }

  function blendPolicies(primary, learned, mix = 0.34) {

    const m = clamp(Number(mix) || 0, 0, 1);

    return normalizePolicy(primary.map((v, i) => v * (1 - m) + (learned?.[i] ?? 0) * m));

  }

  function pathwaySnapshot(pathway) {

    if (!pathway) return null;

    return {
      id: pathway.id,
      label: pathway.label,
      action: actionLabel(pathway.preferredAction),
      activation: pathway.activation,
      rationale: pathway.rationale,
      policy: pathway.policy.slice(),
      learnedPolicy: pathway.learnedPolicy.slice(),
      stats: pathway.stats ? {
        seen: pathway.stats.seen,
        avgReward: pathway.stats.avgReward,
        lastReward: pathway.stats.lastReward,
      } : null,
    };

  }

  function buildDecisionPathways(ctx = {}, extras = {}, mispricing = null, bookCtx = {}) {

    const score = clamp(Number(extras.compositeScore ?? ctx.score ?? 0), -1, 1);

    const agreement = clamp(Number(extras.agreement ?? ctx.agreement ?? 0.5), 0, 1);

    const conflict = clamp(Number(extras.conflict ?? ctx.conflict ?? 0), 0, 1);

    const tapeVelocity = clamp(Number(extras.tapeVelocity ?? 0), -1, 1);

    const probVelocity = clamp(Number(extras.probVelocity ?? 0) / 3, -1, 1);

    const rapid = enc?.rapidMoveScore?.(extras) ?? 0;

    const huntScore = clamp(Number(mispricing?.huntScore ?? 0), 0, 1);

    const lateWindow = clamp(1 - Number(extras.ttcNorm ?? 1), 0, 1);

    const spreadNorm = clamp(Number(bookCtx.spreadPct ?? 0) * 20, 0, 1);

    const toxicity = clamp(Number(bookCtx.toxicity ?? 0), 0, 1);

    const imbalance = clamp(Number(bookCtx.imbalance ?? 0), -1, 1);

    const wallPressure = clamp(Number(bookCtx.wallPressure ?? 0), -1, 1);

    const mispricingSignal = mispricing?.recommendedAction === 'UP'
      ? 1
      : mispricing?.recommendedAction === 'DOWN'
        ? -1
        : clamp(Number(mispricing?.projectedMispricingPp ?? mispricing?.mispricingPp ?? 0) / 18, -1, 1);

    const lateSignal = mispricing?.recommendedAction === 'UP'
      ? 0.85
      : mispricing?.recommendedAction === 'DOWN'
        ? -0.85
        : clamp(probVelocity * 0.45 + score * 0.35 + mispricingSignal * 0.2, -1, 1);

    return [
      {
        id: 'trend_follow',
        label: pathwayLabel('trend_follow'),
        activation: clamp(Math.abs(score) * 0.38 + agreement * 0.34 + Math.abs(tapeVelocity) * 0.18 - conflict * 0.22, 0, 1),
        policy: directionalPolicy(score * 0.55 + tapeVelocity * 0.25 + probVelocity * 0.2, agreement * 0.65 + Math.abs(score) * 0.35, 0.1),
        rationale: `trend alignment score=${score.toFixed(2)} tape=${tapeVelocity.toFixed(2)} agreement=${agreement.toFixed(2)}`,
      },
      {
        id: 'rapid_breakout',
        label: pathwayLabel('rapid_breakout'),
        activation: clamp(rapid * 0.62 + Number(extras.rangeExpansion ?? 0) * 0.14 + Number(extras.bodyExpansion ?? 0) * 0.14 + Number(extras.volumeBurst ?? 0) * 0.1, 0, 1),
        policy: directionalPolicy(score * 0.3 + tapeVelocity * 0.4 + probVelocity * 0.3, rapid * 0.75 + Math.abs(probVelocity) * 0.25, 0.08),
        rationale: `rapid breakout rapid=${rapid.toFixed(2)} range=${Number(extras.rangeExpansion ?? 0).toFixed(2)} volume=${Number(extras.volumeBurst ?? 0).toFixed(2)}`,
      },
      {
        id: 'contrarian_mispricing',
        label: pathwayLabel('contrarian_mispricing'),
        activation: clamp(huntScore * 0.62 + (mispricing?.contrarian ? 0.22 : 0) + (mispricing?.crowdExtreme ? 0.12 : 0), 0, 1),
        policy: mispricing?.recommendedAction && mispricing.recommendedAction !== 'WAIT'
          ? actionPolicy(enc?.directionToAction?.(mispricing.recommendedAction) ?? 0, 0.55 + huntScore * 0.45, 0.06)
          : directionalPolicy(mispricingSignal || -score, 0.45 + huntScore * 0.4, 0.16),
        rationale: mispricing?.rationale || 'contrarian / crowd-dislocation edge',
      },
      {
        id: 'liquidity_reversion',
        label: pathwayLabel('liquidity_reversion'),
        activation: clamp(Math.abs(imbalance) * 0.34 + Math.abs(wallPressure) * 0.28 + spreadNorm * 0.18 + toxicity * 0.2, 0, 1),
        policy: directionalPolicy(-(imbalance * 0.55 + wallPressure * 0.3 + tapeVelocity * 0.15), 0.42 + toxicity * 0.28 + spreadNorm * 0.3, 0.18),
        rationale: `reversion imbalance=${imbalance.toFixed(2)} walls=${wallPressure.toFixed(2)} toxicity=${toxicity.toFixed(2)}`,
      },
      {
        id: 'late_window_scalp',
        label: pathwayLabel('late_window_scalp'),
        activation: clamp(lateWindow * 0.46 + huntScore * 0.24 + Math.abs(probVelocity) * 0.18 + rapid * 0.12, 0, 1),
        policy: directionalPolicy(lateSignal, 0.44 + lateWindow * 0.32 + huntScore * 0.24, 0.12),
        rationale: `late window ttc=${lateWindow.toFixed(2)} probVel=${probVelocity.toFixed(2)} hunt=${huntScore.toFixed(2)}`,
      },
    ];

  }

  function enrichPathways(pathways = []) {

    return pathways.map((pathway) => {

      const state = pathwayTable[pathway.id] || createPathwayState();

      const learnedPolicy = softmax(state.actionValues);

      const policy = blendPolicies(pathway.policy, learnedPolicy, config.pathwayLearnBlend ?? DEFAULT_CONFIG.pathwayLearnBlend);

      return {
        ...pathway,
        preferredAction: argmax(policy),
        policy,
        learnedPolicy,
        stats: {
          seen: state.seen,
          avgReward: state.avgReward,
          lastReward: state.lastReward,
          actionValues: state.actionValues.slice(),
        },
      };

    });

  }

  function updatePathwayState(id, actionId, reward, activation = 1) {

    if (!id) return;

    const state = pathwayTable[id] || createPathwayState();

    const alpha = clamp((config.pathwayLearningRate ?? DEFAULT_CONFIG.pathwayLearningRate) * clamp(activation, 0, 1), 0.02, 0.6);

    state.seen += 1;

    state.totalReward += reward;

    state.avgReward = state.totalReward / state.seen;

    state.lastReward = reward;

    state.lastAction = actionId;

    state.lastSeenAt = Date.now();

    for (let a = 0; a < 3; a++) {

      const target = a === actionId ? reward : (-reward * 0.3);

      state.actionValues[a] += alpha * (target - state.actionValues[a]);

    }

    pathwayTable[id] = state;

  }

  function initFromBundle(bundle) {

    if (!bundle) return false;

    config = { ...DEFAULT_CONFIG, ...(bundle.config || {}) };

    pathwayTable = buildPathwayTable(bundle.pathwayTable || {});

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

    if (!sniper && HorizonSniper?.HorizonSniperLogic) {

      sniper = new HorizonSniper.HorizonSniperLogic();

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

    const activePathways = enrichPathways(buildDecisionPathways(ctx, extras, mispricing, bookCtx))
      .filter((pathway) => pathway.activation >= (config.pathwayActivationFloor ?? DEFAULT_CONFIG.pathwayActivationFloor))
      .sort((a, b) => b.activation - a.activation)
      .slice(0, 3);

    const pathwayBias = [0, 0, 0];

    const pathwayPolicy = [0, 0, 0];

    let pathwayActivation = 0;

    for (const pathway of activePathways) {

      pathwayActivation += pathway.activation;

      for (let a = 0; a < 3; a++) {

        pathwayPolicy[a] += pathway.policy[a] * pathway.activation;

        pathwayBias[a] += (
          ((pathway.policy[a] ?? 0) - (1 / 3)) * 1.35 +
          ((pathway.learnedPolicy[a] ?? 0) - (1 / 3)) * 0.65
        ) * pathway.activation * (config.pathwayBiasScale ?? DEFAULT_CONFIG.pathwayBiasScale);

      }

    }

    const normalizedPathwayPolicy = pathwayActivation
      ? normalizePolicy(pathwayPolicy.map((v) => v / pathwayActivation))
      : [0.34, 0.33, 0.33];

    const baseQ = dqn ? dqn.qValues(state) : [0, 0, 0];

    const q = baseQ.map((v, i) => v + (pathwayBias[i] ?? 0));

    const dqnAction = argmax(q);



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

    let sniperDecision = null;
    if (sniper && (fusedAction === enc.ACTION.UP || fusedAction === enc.ACTION.DOWN)) {
      const p_model = ctx.kalshiAlign?.modelYesPct != null
        ? ctx.kalshiAlign.modelYesPct / 100
        : (fusedAction === enc.ACTION.UP ? 0.75 : 0.25);

      const asks = ctx.liveBook?.asks || ctx.asks || [];
      const positionSize = ctx.positionSize || config.positionSize || 100;
      const msToClose = ctx.kalshiAlign?.closeTimeMs
        ? Math.max(0, ctx.kalshiAlign.closeTimeMs - Date.now())
        : Number(ctx.msToClose ?? 900000);
      const tteSeconds = msToClose / 1000;
      const spotVolatility = ctx.spotVolatility ?? 0.05;

      sniperDecision = sniper.evaluateHorizonStrike({
        p_model,
        orderBookAsks: asks,
        positionSize,
        tteSeconds,
        spotVolatility,
      });
    }

    let overrideAction = fusedAction;
    let overrideReason = null;
    if (sniperDecision && sniperDecision.action === 'SCOUT_WAIT') {
      overrideAction = enc.ACTION.WAIT;
      overrideReason = sniperDecision.reason || 'horizon_gated';
    }

    return {

      action: actionLabel(overrideAction),

      actionId: overrideAction,

      pathway: pathwaySnapshot(activePathways[0]),

      pathways: activePathways.map(pathwaySnapshot),

      confidence,

      rapidMove: isRapid,

      rapidScore: rapid,

      state,

      infoKey,

      mispricing,

      horizonGated: overrideAction === enc.ACTION.WAIT && fusedAction !== enc.ACTION.WAIT,
      horizonGateReason: overrideReason,
      sniperDecision,

      sources: {

        dqn: {
          action: actionLabel(dqnAction),
          q: q.slice(),
          baseQ: baseQ.slice(),
          pathwayBias: pathwayBias.slice(),
          pathwayPolicy: normalizedPathwayPolicy.slice(),
        },

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

      return { score: newScore, decision, gated: true, reason: decision.horizonGateReason || 'rl_wait' };

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

        : (decision.pathway?.id ? `rl_${decision.pathway.id}` : (rapidMove ? 'rl_rapid_align' : 'rl_align')),

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

    const p_model = ctx.kalshiAlign?.modelYesPct != null
      ? ctx.kalshiAlign.modelYesPct / 100
      : (actionId === enc.ACTION.UP ? 0.75 : 0.25);

    const asks = ctx.liveBook?.asks || ctx.asks || [];
    const positionSize = ctx.positionSize || config.positionSize || 100;
    const msToClose = ctx.kalshiAlign?.closeTimeMs
      ? Math.max(0, ctx.kalshiAlign.closeTimeMs - Date.now())
      : Number(ctx.msToClose ?? 900000);
    const tteSeconds = msToClose / 1000;
    const spotVolatility = ctx.spotVolatility ?? 0.05;

    const reward = enc.rewardForAction(actionId, actualDirection, rapid, {

      contrarian: mispricing?.contrarian,

      huntScore: mispricing?.huntScore,

      playType: mispricing?.playType,

      p_model,
      orderBookAsks: asks,
      positionSize,
      tteSeconds,
      spotVolatility,

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



    const learnedPathways = enrichPathways(buildDecisionPathways(ctx, extras, mispricing, bookCtx))
      .filter((pathway) => pathway.activation >= (config.pathwayActivationFloor ?? DEFAULT_CONFIG.pathwayActivationFloor))
      .sort((a, b) => b.activation - a.activation)
      .slice(0, 3);

    for (const pathway of learnedPathways) {

      updatePathwayState(pathway.id, actionId, reward, pathway.activation);

    }

    return {
      reward,
      rapid,
      actionId,
      mispricing,
      pathway: pathwaySnapshot(learnedPathways[0]),
      pathways: learnedPathways.map(pathwaySnapshot),
    };

  }



  function getBundle() {

    return {

      version: 3,

      config,

      dqn: dqn?.toJSON?.() ?? null,

      cfr: cfr?.toJSON?.() ?? null,

      pathwayTable,

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
