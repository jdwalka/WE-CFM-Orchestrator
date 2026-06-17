(function () {
  'use strict';

  // Expose shared state so modules can coordinate without closure scope issues
  window.PredictionState = {
    candleCache: {},
    BT_CACHE_KEY: 'beta1_bt_cache_v2',
    BT_CACHE_TTL_MS: 4 * 60 * 60 * 1000,
    
    // Core shared caching methods
    saveBtCache: function() {
      try {
        const store = {};
        if (typeof PREDICTION_COINS !== 'undefined') {
          PREDICTION_COINS.forEach(coin => {
            const bt = window._backtests[coin.sym];
            if (bt) store[coin.sym] = { bt, ts: Date.now(), walkKey: window.PredictionState.candleCache[coin.sym]?._walkBacktestKey || '' };
          });
        }
        localStorage.setItem(window.PredictionState.BT_CACHE_KEY, JSON.stringify(store));
      } catch (e) { }
    },
    
    loadBtCache: function() {
      try {
        const raw = localStorage.getItem(window.PredictionState.BT_CACHE_KEY);
        if (!raw) return;
        const store = JSON.parse(raw);
        if (typeof PREDICTION_COINS !== 'undefined') {
          PREDICTION_COINS.forEach(coin => {
            const entry = store[coin.sym];
            if (!entry || Date.now() - entry.ts > window.PredictionState.BT_CACHE_TTL_MS) return;
            window._backtests[coin.sym] = entry.bt;
            if (!window.PredictionState.candleCache[coin.sym]) window.PredictionState.candleCache[coin.sym] = {};
            window.PredictionState.candleCache[coin.sym]._walkBacktestKey = entry.walkKey;
            window.PredictionState.candleCache[coin.sym]._walkBacktest = entry.bt;
          });
        }
      } catch (e) { }
    }
  };

  // Run the load automatically upon script initialization
  window.PredictionState.loadBtCache();

})();
