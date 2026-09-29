// temporal-edge.js — Temporal Edge Engine for 15m Binary Contracts
// ═══════════════════════════════════════════════════════════════════════════
// Introduces clock-aware decay and next-window lookahead.

(function (root) {
  'use strict';

  // Math.erf approximation for probability mapping
  if (!Math.erf) {
    Math.erf = function(x) {
      var a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
      var a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
      var sign = (x < 0) ? -1 : 1;
      x = Math.abs(x);
      var t = 1.0 / (1.0 + p * x);
      var y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
      return sign * y;
    };
  }

  function calculateTemporalEdge(nowMs, pPct, dPct, fAnomaly) {
    var EPOCH_15M_SEC = 900;
    var currentSec = Math.floor(nowMs / 1000);
    var secIntoWindow = currentSec % EPOCH_15M_SEC;
    var secToExpiry = EPOCH_15M_SEC - secIntoWindow;
    
    // Ensure safe default values
    pPct = Number.isFinite(pPct) ? pPct : 0;
    dPct = (Number.isFinite(dPct) && dPct > 0.0001) ? dPct : 0.001;
    fAnomaly = (Number.isFinite(fAnomaly) && fAnomaly > 0) ? fAnomaly : 1.0;

    // In crypto, massive spikes can occur in the final 30 seconds.
    // Instead of forcing a "lookahead" blend that kills the current window,
    // we tag the extreme risk of "pinning" (where noise easily flips the contract).
    var isDangerZone = secToExpiry < 120; // Last 2 minutes
    var isExtremeDangerZone = secToExpiry < 30; // Last 30 seconds
    
    // Calculate raw current-window volatility capability
    var timeRatio = secToExpiry / EPOCH_15M_SEC;
    var remainingDiffusion = dPct * Math.sqrt(timeRatio); // Expected volatility remaining
    
    // Identify if the current momentum is backed by volume (signal) or low volume (noise)
    var isVolumeBacked = fAnomaly > 1.2;
    var noiseRatio = 1 / fAnomaly; // High anomaly = low noise ratio
    
    // Z-score for the current window based strictly on raw momentum vs remaining expected diffusion
    var zScore = remainingDiffusion > 0 ? (pPct / remainingDiffusion) : 0;
    var probUp = 0.5 * (1 + Math.erf(zScore / Math.SQRT2));

    var signal = 'NEUTRAL';
    if (probUp > 0.65) signal = 'BUY_UP';
    else if (probUp < 0.35) signal = 'BUY_DOWN';

    return {
      secToExpiry: secToExpiry,
      isDangerZone: isDangerZone,
      isExtremeDangerZone: isExtremeDangerZone,
      isVolumeBacked: isVolumeBacked,
      noiseRatio: parseFloat(noiseRatio.toFixed(4)),
      remainingDiffusion: parseFloat(remainingDiffusion.toFixed(4)),
      currentMomentum: parseFloat(pPct.toFixed(4)),
      probUp: parseFloat(probUp.toFixed(4)),
      metadataSignal: signal,
      tags: [
        isDangerZone ? 'late_window' : 'early_window',
        isVolumeBacked ? 'high_conviction_flow' : 'low_conviction_drift',
        (isExtremeDangerZone && !isVolumeBacked) ? 'high_pin_risk' : 'stable'
      ]
    };
  }

  var api = {
    calculateTemporalEdge: calculateTemporalEdge
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.TemporalEdge = api;
  } else if (typeof root !== 'undefined') {
    root.TemporalEdge = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
