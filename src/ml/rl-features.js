/**
 * Shared state encoding for DQN / MCTS (live + backtest).
 */
'use strict';

const FEATURE_KEYS = [
  'rsi', 'ema', 'vwap', 'obv', 'volume', 'momentum', 'bands', 'persistence', 'structure',
  'macd', 'stochrsi', 'adx', 'ichimoku', 'williamsR', 'mfi', 'hma', 'vwma', 'sma',
  'supertrend', 'cci', 'cmf', 'fisher', 'keltner',
];

const ACTIONS = { WAIT: 0, UP: 1, DOWN: 2 };
const ACTION_LABELS = ['WAIT', 'UP', 'DOWN'];

function encodeSignalVector(signalVector, extras = {}) {
  const vec = FEATURE_KEYS.map((k) => clamp(Number(signalVector?.[k] ?? 0), -1, 1));
  vec.push(clamp(Number(extras.compositeScore ?? 0), -1, 1));
  vec.push(clamp(Number(extras.agreement ?? 0.5), 0, 1));
  vec.push(clamp(Number(extras.atrPct ?? 0) / 5, 0, 1));
  return vec;
}

function encodeObservation(obs) {
  return encodeSignalVector(obs.signalVector || {}, {
    compositeScore: obs.compositeScore,
    agreement: obs.agreement,
    atrPct: obs.atrPct,
  });
}

function directionToAction(dir) {
  if (dir === 'UP') return ACTIONS.UP;
  if (dir === 'DOWN') return ACTIONS.DOWN;
  return ACTIONS.WAIT;
}

function actionToDirection(action) {
  if (action === ACTIONS.UP) return 'UP';
  if (action === ACTIONS.DOWN) return 'DOWN';
  return 'WAIT';
}

function rewardForStep(action, actualDirection, movePct = 0) {
  const absMove = Math.abs(Number(movePct) || 0);
  const flat = absMove < 0.05;
  if (action === ACTIONS.WAIT) {
    return flat ? 0.15 : -0.25;
  }
  const predicted = actionToDirection(action);
  if (predicted === actualDirection) {
    return 1 + Math.min(0.5, absMove / 0.5);
  }
  return -1 - Math.min(0.5, absMove / 0.5);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

const exportObj = {
  FEATURE_KEYS,
  ACTIONS,
  ACTION_LABELS,
  encodeSignalVector,
  encodeObservation,
  directionToAction,
  actionToDirection,
  rewardForStep,
  stateSize: FEATURE_KEYS.length + 3,
  actionSize: 3,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = exportObj;
} else if (typeof window !== 'undefined') {
  window.WecrypRLFeatures = exportObj;
}
