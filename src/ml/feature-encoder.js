/**
 * State encoder for DQN / MCTS — indicators + rapid-movement microstructure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RLFeatureEncoder = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  const FEATURE_ORDER = [
    'rsi', 'ema', 'vwap', 'obv', 'volume', 'momentum', 'bands', 'persistence', 'structure',
    'macd', 'stochrsi', 'adx', 'ichimoku', 'williamsR', 'mfi', 'hma', 'vwma', 'sma',
    'supertrend', 'cci', 'cmf', 'fisher', 'keltner',
    'tapeVelocity', 'rangeExpansion', 'bodyExpansion', 'volumeBurst', 'imbalanceVelocity',
    'probVelocity', 'atrPct', 'compositeScore', 'agreement', 'conflict',
    'mispricingPp', 'projectedMispricingPp', 'ttcNorm', 'crowdExtreme', 'contrarianFlag', 'huntScore',
  ];

  const ACTION = { WAIT: 0, UP: 1, DOWN: 2 };
  const ACTION_LABEL = ['WAIT', 'UP', 'DOWN'];

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function encodeSignalVector(signalVector = {}, extras = {}) {
    const out = FEATURE_ORDER.map((key) => {
      if (key === 'tapeVelocity') return clamp(Number(extras.tapeVelocity ?? 0), -1, 1);
      if (key === 'rangeExpansion') return clamp(Number(extras.rangeExpansion ?? 0), 0, 1);
      if (key === 'bodyExpansion') return clamp(Number(extras.bodyExpansion ?? 0), 0, 1);
      if (key === 'volumeBurst') return clamp(Number(extras.volumeBurst ?? 0), 0, 1);
      if (key === 'imbalanceVelocity') return clamp(Number(extras.imbalanceVelocity ?? 0), -1, 1);
      if (key === 'probVelocity') return clamp(Number(extras.probVelocity ?? 0) / 3, -1, 1);
      if (key === 'atrPct') return clamp(Number(extras.atrPct ?? 0) / 3, 0, 1);
      if (key === 'compositeScore') return clamp(Number(extras.compositeScore ?? 0), -1, 1);
      if (key === 'agreement') return clamp(Number(extras.agreement ?? 0.5), 0, 1);
      if (key === 'conflict') return clamp(Number(extras.conflict ?? 0), 0, 1);
      if (key === 'mispricingPp') return clamp(Number(extras.mispricingPp ?? 0) / 30, -1, 1);
      if (key === 'projectedMispricingPp') return clamp(Number(extras.projectedMispricingPp ?? 0) / 30, -1, 1);
      if (key === 'ttcNorm') return clamp(1 - Number(extras.ttcNorm ?? 1), 0, 1);
      if (key === 'crowdExtreme') return extras.crowdExtreme ? 1 : 0;
      if (key === 'contrarianFlag') return extras.contrarian ? 1 : 0;
      if (key === 'huntScore') return clamp(Number(extras.huntScore ?? 0), 0, 1);
      return clamp(Number(signalVector[key] ?? 0), -1, 1);
    });
    return out;
  }

  function encodeFromModel(model, sym) {
    const sv = model?.diagnostics?.components || model?.signalVector || {};
    const tv = model?.diagnostics?.tapeVelocity || {};
    const coin = window.PredictionMarkets?.getCoin?.(sym);
    const probVel = coin?.kalshi15m ? window.PredictionMarkets?.getVelocity?.(sym) : null;
    return encodeSignalVector(sv, {
      tapeVelocity: tv.directionalConsistency ?? tv.state ?? 0,
      rangeExpansion: tv.rangeExpansion ?? 0,
      bodyExpansion: tv.bodyExpansion ?? 0,
      volumeBurst: tv.volumeBurst ?? 0,
      imbalanceVelocity: sv.imbalanceVelocity ?? model?.diagnostics?.orderBookImbalance?.velocity ?? 0,
      probVelocity: probVel?.trend ?? probVel?.velocity ?? 0,
      atrPct: model?.volatility?.atrPct ?? model?.diagnostics?.atrPct ?? 0,
      compositeScore: model?.score ?? model?.diagnostics?.coreScore ?? 0,
      agreement: model?.diagnostics?.agreement ?? 0.5,
      conflict: model?.diagnostics?.conflict ?? 0,
    });
  }

  function rapidMoveScore(extras = {}) {
    const range = clamp(Number(extras.rangeExpansion ?? 0), 0, 1);
    const body = clamp(Number(extras.bodyExpansion ?? 0), 0, 1);
    const vol = clamp(Number(extras.volumeBurst ?? 0), 0, 1);
    const tape = Math.abs(clamp(Number(extras.tapeVelocity ?? 0), -1, 1));
    const prob = Math.abs(clamp(Number(extras.probVelocity ?? 0) / 3, -1, 1));
    return clamp(range * 0.3 + body * 0.25 + vol * 0.25 + tape * 0.1 + prob * 0.1, 0, 1);
  }

  function directionFromOutcome(pct) {
    if (pct > 0.05) return ACTION.UP;
    if (pct < -0.05) return ACTION.DOWN;
    return ACTION.WAIT;
  }

  function rewardForAction(action, actualDirection, rapidScore = 0, meta = {}) {
    const actual = actualDirection === 'UP' ? ACTION.UP : actualDirection === 'DOWN' ? ACTION.DOWN : ACTION.WAIT;
    let reward = 0;

    if (action === ACTION.WAIT) {
      if (actual === ACTION.WAIT) return 0.15;
      return -0.05 - rapidScore * 0.1;
    }
    if (action === actual) {
      reward = 1.0 + rapidScore * 0.35;
    } else {
      reward = -1.0 - rapidScore * 0.25;
    }

    if (meta.contrarian && action === actual) reward += 0.45 + (meta.huntScore ?? 0) * 0.35;
    if (meta.playType === 'mispricing_hunt' && action === actual) reward += 0.35;
    if (meta.contrarian && action !== actual) reward -= 0.2;

    return reward;
  }

  function directionToAction(dir) {
    if (dir === 'UP') return ACTION.UP;
    if (dir === 'DOWN') return ACTION.DOWN;
    return ACTION.WAIT;
  }

  function actionToDirection(action) {
    return ACTION_LABEL[action] ?? 'WAIT';
  }

  return {
    FEATURE_ORDER,
    FEATURE_SIZE: FEATURE_ORDER.length,
    ACTION,
    ACTION_LABEL,
    encodeSignalVector,
    encodeFromModel,
    rapidMoveScore,
    directionFromOutcome,
    directionToAction,
    actionToDirection,
    rewardForAction,
  };
}));
