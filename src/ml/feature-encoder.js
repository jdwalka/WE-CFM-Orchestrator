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

    // 1. CAPITAL PRESERVATION (WAIT ACTION)
    if (action === ACTION.WAIT) {
      return 0.0; // Preserved capital is always neutral (no "existence is pain" penalty)
    }

    // 2. INCORRECT PREDICTION (Diverges from actual trend direction)
    if (action !== actual) {
      return -1.0; // Capital wasted on a bad prediction
    }

    // 3. CORRECT DIRECTION PREDICTION - CALCULATE EV & HURDLE GATES
    let p_market = meta.p_market;
    if (p_market == null) {
      if (typeof meta.orderBookAsks === 'number') {
        p_market = meta.orderBookAsks;
      } else if (Array.isArray(meta.orderBookAsks)) {
        let filledSize = 0.0;
        let totalCost = 0.0;
        const requiredSize = meta.positionSize || 100;
        for (let i = 0; i < meta.orderBookAsks.length; i++) {
          const ask = meta.orderBookAsks[i];
          if (Array.isArray(ask) && ask.length >= 2) {
            const price = Number(ask[0]);
            const volume = Number(ask[1]);
            if (!isNaN(price) && !isNaN(volume) && price > 0 && volume > 0) {
              if (filledSize + volume >= requiredSize) {
                const remaining = requiredSize - filledSize;
                totalCost += remaining * price;
                p_market = totalCost / requiredSize;
                break;
              }
              totalCost += volume * price;
              filledSize += volume;
            }
          }
        }
        if (p_market == null && filledSize > 0) {
          p_market = totalCost / filledSize;
        }
      }
    }
    if (p_market == null || p_market <= 0 || p_market > 0.99) {
      p_market = 0.50; // default/fallback
    }

    const p_model = meta.p_model || (action === actual ? 0.75 : 0.25);
    const ev = (p_model / p_market) - 1.0;

    // Evaluate dynamic hurdle
    const timeElapsedRatio = meta.tteSeconds != null ? Math.max(0, Math.min(1, (900 - meta.tteSeconds) / 900)) : 1.0;
    const spotVol = meta.spotVolatility || 0.05;
    const baseRequiredEv = 0.50;
    const variancePremium = spotVol * Math.exp(-3.0 * timeElapsedRatio);
    const hurdle = baseRequiredEv + variancePremium;

    // 4. EV HURDLE VIOLATION
    if (ev < hurdle) {
      return -1.0; // Strong penalty for executing a low-EV or high-variance premature trade
    }

    // 5. CORRECT HIGH-EV EXECUTION
    const mispricingRatio = p_model / p_market;
    let reward = ev * mispricingRatio;

    // Add extra contrarian/mispricing hunter rewards
    if (meta.contrarian) {
      reward += 0.45 + (meta.huntScore ?? 0) * 0.35;
    }
    if (meta.playType === 'mispricing_hunt') {
      reward += 0.35;
    }

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
