// Loads predictions-weights.json synchronously before predictions modules execute
(function() {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '../src/core/predictions-weights.json', false); 
  try {
    xhr.send(null);
    if (xhr.status === 200 || xhr.status === 0) {
      const weights = JSON.parse(xhr.responseText);
      window.PREDICTIONS_WEIGHTS = weights;
      // Export them to the global namespace so api.js and others can use them natively
      window.COMPOSITE_WEIGHTS = weights.COMPOSITE_WEIGHTS;
      window.PER_COIN_INDICATOR_BIAS = weights.PER_COIN_INDICATOR_BIAS;
      window.REGIME_CONFIDENCE_MAP = weights.REGIME_CONFIDENCE_MAP;
      window.SIGNAL_GATE = weights.SIGNAL_GATE;
      window.SHORT_HORIZON_WEIGHTS = weights.SHORT_HORIZON_WEIGHTS;
      window.SHORT_HORIZON_FILTERS = weights.SHORT_HORIZON_FILTERS;
      console.log("[WECRYPTO] Successfully loaded extracted weights from JSON.");
    } else {
      console.error("[WECRYPTO] Failed to load predictions-weights.json", xhr.status);
    }
  } catch(e) {
    console.error("[WECRYPTO] Error loading predictions-weights.json", e);
  }
})();
