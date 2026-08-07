// Signal Gate & Confidence Routing
(function() {
  const { SIGNAL_GATE, REGIME_CONFIDENCE_MAP, SIGNAL_GATE_OVERRIDES } = window.PREDICTIONS_WEIGHTS || window;



  function evaluateSignalGate(pred, coin, regime) {
    if (!pred || pred.signal === 'neutral' || !Number.isFinite(pred.score)) {
      return { passed: true, gated: false, quality: 'medium', label: 'NEUTRAL', reasons: [] };
    }

    // ★ SAFETY PATCH: Close-window guard — skip trading in final close seconds before h15 expiry
    const now = Date.now();
    const secsSinceEpoch = (now % 900_000); // ms within any 15-min slot
    const secsIntoWindow = (secsSinceEpoch / 1000);
    const secsUntilClose = (900 - secsIntoWindow); // seconds until next 15m close
    if (pred.horizon === 15 && secsUntilClose < CLOSE_WINDOW_GUARD_SECS) {
      return {
        passed: false,
        gated: true,
        quality: 'blocked',
        label: '⏱️ CLOSE-WINDOW GUARD',
        reasons: [`Too close to 15m candle close (skip final ${CLOSE_WINDOW_GUARD_SECS}s)`]
      };
    }

    const conf = pred.confidence ?? 0;
    const absScore = Math.abs(pred.score ?? 0);
    const agreement = pred.diagnostics?.agreement ?? 0.5;
    const conflict = pred.diagnostics?.conflict ?? 0;
    const reliability = pred.backtest?.summary?.reliability ?? 0;
    const routedAction = pred.diagnostics?.routedAction ?? '';
    const quantRegime = pred.diagnostics?.quantRegime || null;
    const reasons = [];
    const confidence_adjustments = {};

    // Apply coin-specific gate if available
    // If adaptive tuner is running, use its current gates
    let gateOverride = SIGNAL_GATE_OVERRIDES[coin] || {};
    if (window._adaptiveTuner) {
      try {
        const adaptiveGates = window._adaptiveTuner.getCurrentGates();
        if (adaptiveGates && typeof adaptiveGates[coin] === 'number' && SIGNAL_GATE_OVERRIDES[coin]) {
          gateOverride = { ...SIGNAL_GATE_OVERRIDES[coin] };
          gateOverride.minAbsScore = adaptiveGates[coin];
        }
      } catch (err) {
        // Fallback to baseline if adaptive tuner has issues
        console.warn(`[predictions] Adaptive tuning error for ${coin}:`, err.message);
      }
    }
    const gate = Object.assign({}, SIGNAL_GATE, gateOverride);

    // ★ REGIME-ADAPTIVE CONFIDENCE ADJUSTMENT
    let adaptive_confidence = conf;
    let regime_state = regime?.regime_state || 'chop';
    let regime_confidence_floor = REGIME_CONFIDENCE_MAP[regime_state] || 0.58;

    if (regime && regime.regime_state) {
      regime_state = regime.regime_state;
      regime_confidence_floor = REGIME_CONFIDENCE_MAP[regime_state];
      confidence_adjustments.regime_state = regime_state;
      confidence_adjustments.base_confidence = conf;
      confidence_adjustments.regime_floor = regime_confidence_floor;

      // Variance ratio reinforcement: if VR > 1.1 && trending signal → reduce confidence (already trending hard)
      if (regime.variance_ratio > 1.1 && pred.signal === 'up') {
        adaptive_confidence -= 2;  // -2% adjustment
        confidence_adjustments.vr_trending_adjustment = -2;
      } else if (regime.variance_ratio > 1.1 && pred.signal === 'down') {
        adaptive_confidence -= 2;
        confidence_adjustments.vr_trending_adjustment = -2;
      }

      // Entropy penalty: if entropy > 0.65 → add confidence buffer (noise detected, need stronger signal)
      if (regime.entropy_score > 0.65) {
        adaptive_confidence += 4;  // +4% adjustment
        confidence_adjustments.entropy_noise_adjustment = +4;
      }

      confidence_adjustments.final_adaptive_confidence = Math.max(regime_confidence_floor, adaptive_confidence);
    }

    // ★ REVERSAL-ARM GATE EXCEPTION: Lower confidence floor for high-conviction reversals
    const reversalFlags = pred.diagnostics?.reversalFlags || [];
    const isExhaustedMove = Math.abs(pred.score ?? 0) >= 0.55;
    const hasMomentumDivergence = (pred.diagnostics?.momentumQuality ?? 0) >= 0.62;
    const qualifiesReversalArm = reversalFlags.filter(f => f.severity >= 2).length >= 2 && isExhaustedMove && hasMomentumDivergence;
    
    if (qualifiesReversalArm) {
      gate.minConfidence = 58; // Reversal-arm threshold: lower than normal 70% to allow early reversal entries
      gate.minAbsScore = 0.26;
      gate.minAgreement = 0.48;
      gate.maxConflict = 0.46;
      confidence_adjustments.reversal_arm_applied = true;
    }

    // Use regime-based confidence floor if applicable
    let effective_confidence_floor = gate.minConfidence;
    if (regime && regime.regime_state) {
      effective_confidence_floor = Math.max(gate.minConfidence, REGIME_CONFIDENCE_MAP[regime.regime_state]);
    }

    // Hard-gate failures
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

    // Store regime diagnostics in prediction object for telemetry
    if (!pred.diagnostics) pred.diagnostics = {};
    pred.diagnostics.regime = {
      h_exponent: regime?.h_exponent || 0,
      variance_ratio: regime?.variance_ratio || 1.0,
      entropy_score: regime?.entropy_score || 0.5,
      regime_state: regime_state,
      adaptive_confidence: Math.round(adaptive_confidence),
      confidence_adjustments: confidence_adjustments
    };

    if (reasons.length > 0) {
      return { passed: false, gated: true, quality: 'blocked', label: '⛔ HOLD', reasons };
    }

    // Soft-gate check (medium conviction)
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

window.PREDICTIONS_SIGNAL_AGGREGATION = {
  CLOSE_WINDOW_GUARD_SECS,
  evaluateSignalGate
};
})();
