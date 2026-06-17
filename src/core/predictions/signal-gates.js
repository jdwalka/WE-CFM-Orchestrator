// ================================================================
// WE|||CRYPTO — Signal Execution Gates
// Orbital shell: execution confidence and close-window controls.
// ================================================================

(function () {
  'use strict';

  const CLOSE_WINDOW_GUARD_SECS = 10;

  const REGIME_CONFIDENCE_MAP = {
    trend: 0.58,
    mean_reversion: 0.62,
    chop: 0.72,
  };

  const SIGNAL_GATE = {
    minConfidence: 42,
    minAgreement: 0.56,
    maxConflict: 0.38,
    minAbsScore: 0.22,
    minReliability: 0.42,
    medConfidence: 58,
    medAgreement: 0.64,
    medAbsScore: 0.38,
    medReliability: 0.52,
  };

  const SIGNAL_GATE_OVERRIDES = {
    BTC: { minAbsScore: 0.55, minAgreement: 0.70, minConfidence: 75, medAbsScore: 0.65, medAgreement: 0.75 },
    ETH: { minAbsScore: 0.50, minAgreement: 0.68, minConfidence: 75, medAbsScore: 0.60, medAgreement: 0.72 },
    XRP: { minAbsScore: 0.50, minAgreement: 0.65, minConfidence: 75, medAbsScore: 0.60, medAgreement: 0.70 },
    SOL: { minAbsScore: 0.60, minAgreement: 0.75, minConfidence: 80, medAbsScore: 0.70, medAgreement: 0.80 },
    BNB: { minAbsScore: 0.65, minAgreement: 0.80, minConfidence: 85, medAbsScore: 0.75, medAgreement: 0.85 },
    DOGE: { minAbsScore: 0.50, minAgreement: 0.70, minConfidence: 75, medAbsScore: 0.60, medAgreement: 0.75 },
    HYPE: { minAbsScore: 0.40, minAgreement: 0.65, minConfidence: 75, medAbsScore: 0.50, medAgreement: 0.70 },
  };

  /**
   * Returns the execution-quality assessment for a live prediction.
   * Close-window rejection happens before softer confidence checks to avoid
   * stale fills near 15m settlement.
   */
  function evaluateSignalGate(pred, coin, regime) {
    if (!pred || pred.signal === 'neutral' || !Number.isFinite(pred.score)) {
      return { passed: true, gated: false, quality: 'medium', label: 'NEUTRAL', reasons: [] };
    }

    const now = Date.now();
    const secsSinceEpoch = (now % 900_000);
    const secsIntoWindow = (secsSinceEpoch / 1000);
    const secsUntilClose = (900 - secsIntoWindow);
    if (pred.horizon === 15 && secsUntilClose < CLOSE_WINDOW_GUARD_SECS) {
      return {
        passed: false,
        gated: true,
        quality: 'blocked',
        label: '⏱️ CLOSE-WINDOW GUARD',
        reasons: [`Too close to 15m candle close (skip final ${CLOSE_WINDOW_GUARD_SECS}s)`],
      };
    }

    const conf = pred.confidence ?? 0;
    const absScore = Math.abs(pred.score ?? 0);
    const agreement = pred.diagnostics?.agreement ?? 0.5;
    const conflict = pred.diagnostics?.conflict ?? 0;
    const reliability = pred.backtest?.summary?.reliability ?? 0;
    const routedAction = pred.diagnostics?.routedAction ?? '';
    const reasons = [];
    const confidence_adjustments = {};

    let gateOverride = SIGNAL_GATE_OVERRIDES[coin] || {};
    if (window._adaptiveTuner) {
      try {
        const adaptiveGates = window._adaptiveTuner.getCurrentGates();
        if (adaptiveGates && typeof adaptiveGates[coin] === 'number' && SIGNAL_GATE_OVERRIDES[coin]) {
          gateOverride = { ...SIGNAL_GATE_OVERRIDES[coin] };
          gateOverride.minAbsScore = adaptiveGates[coin];
        }
      } catch (err) {
        console.warn(`[predictions] Adaptive tuning error for ${coin}:`, err.message);
      }
    }
    const gate = Object.assign({}, SIGNAL_GATE, gateOverride);

    let adaptive_confidence = conf;
    let regime_state = regime?.regime_state || 'chop';
    let regime_confidence_floor = REGIME_CONFIDENCE_MAP[regime_state] || 0.58;

    if (regime && regime.regime_state) {
      regime_state = regime.regime_state;
      regime_confidence_floor = REGIME_CONFIDENCE_MAP[regime_state];
      confidence_adjustments.regime_state = regime_state;
      confidence_adjustments.base_confidence = conf;
      confidence_adjustments.regime_floor = regime_confidence_floor;

      if (regime.variance_ratio > 1.1 && pred.signal === 'up') {
        adaptive_confidence -= 2;
        confidence_adjustments.vr_trending_adjustment = -2;
      } else if (regime.variance_ratio > 1.1 && pred.signal === 'down') {
        adaptive_confidence -= 2;
        confidence_adjustments.vr_trending_adjustment = -2;
      }

      if (regime.entropy_score > 0.65) {
        adaptive_confidence += 4;
        confidence_adjustments.entropy_noise_adjustment = +4;
      }

      confidence_adjustments.final_adaptive_confidence = Math.max(regime_confidence_floor, adaptive_confidence);
    }

    const reversalFlags = pred.diagnostics?.reversalFlags || [];
    const isExhaustedMove = Math.abs(pred.score ?? 0) >= 0.55;
    const hasMomentumDivergence = (pred.diagnostics?.momentumQuality ?? 0) >= 0.62;
    const qualifiesReversalArm = reversalFlags.filter(f => f.severity >= 2).length >= 2 && isExhaustedMove && hasMomentumDivergence;

    if (qualifiesReversalArm) {
      gate.minConfidence = 58;
      gate.minAbsScore = 0.26;
      gate.minAgreement = 0.48;
      gate.maxConflict = 0.46;
      confidence_adjustments.reversal_arm_applied = true;
    }

    let effective_confidence_floor = gate.minConfidence;
    if (regime && regime.regime_state) {
      effective_confidence_floor = Math.max(gate.minConfidence, REGIME_CONFIDENCE_MAP[regime.regime_state]);
    }

    if (routedAction === 'invalidated') {
      return { passed: false, gated: true, quality: 'blocked', label: '⛔ INVALIDATED', reasons: ['Signal invalidated by router'] };
    }
    if (adaptive_confidence < effective_confidence_floor) reasons.push('Low confidence (' + Math.round(adaptive_confidence) + '%, floor: ' + Math.round(effective_confidence_floor) + '%)');
    if (absScore < gate.minAbsScore) reasons.push('Weak score (' + absScore.toFixed(2) + ')');
    if (agreement < gate.minAgreement) reasons.push('Low agreement (' + Math.round(agreement * 100) + '%)');
    if (conflict >= gate.maxConflict) reasons.push('High conflict (' + Math.round(conflict * 100) + '%)');
    if (reliability > 0 && reliability < gate.minReliability) reasons.push('Weak backtest (' + Math.round(reliability * 100) + '%)');
    if (regime_state === 'chop' && adaptive_confidence < (gate.medConfidence + 4) && agreement < gate.medAgreement && !qualifiesReversalArm) {
      reasons.push('Choppy quant regime guard');
    }

    if (!pred.diagnostics) pred.diagnostics = {};
    pred.diagnostics.regime = {
      h_exponent: regime?.h_exponent || 0,
      variance_ratio: regime?.variance_ratio || 1.0,
      entropy_score: regime?.entropy_score || 0.5,
      regime_state,
      adaptive_confidence: Math.round(adaptive_confidence),
      confidence_adjustments,
    };

    if (reasons.length > 0) {
      return { passed: false, gated: true, quality: 'blocked', label: '⛔ HOLD', reasons };
    }

    const softFails = [];
    if (adaptive_confidence < gate.medConfidence) softFails.push('Conf ' + Math.round(adaptive_confidence) + '%');
    if (agreement < gate.medAgreement) softFails.push('Agr ' + Math.round(agreement * 100) + '%');
    if (absScore < gate.medAbsScore) softFails.push('Score ' + absScore.toFixed(2));
    if (reliability > 0 && reliability < gate.medReliability) softFails.push('Rel ' + Math.round(reliability * 100) + '%');

    if (softFails.length >= 2) {
      return { passed: true, gated: false, quality: 'medium', label: '⚡ LOW CONV', reasons: softFails };
    }

    return { passed: true, gated: false, quality: 'high', label: '✅ STRONG', reasons: [] };
  }

  window.PredictionSignalGates = {
    CLOSE_WINDOW_GUARD_SECS,
    REGIME_CONFIDENCE_MAP,
    SIGNAL_GATE,
    SIGNAL_GATE_OVERRIDES,
    evaluateSignalGate,
  };
})();
