/**
 * ================================================================
 * Adaptive Weight Restorer
 * 
 * Runs at app startup (BEFORE any live trading)
 * Restores last-known signal weights from cached contract accuracy
 * 
 * This ensures calibration persists across app restarts
 * No recalculation needed - just load & apply
 * ================================================================
 */

class AdaptiveWeightRestorer {
  constructor() {
    this.lastWeights = null;
    this.restoredAt = null;
    this.source = null; // 'cache' | 'electron' | 'fresh'
    this._initialized = false;
    this._initPromise = null;
    this._refreshTimer = null;
  }

  /**
   * Restore weights from localStorage cache (instant, <10ms)
   */
  restoreFromCache() {
    try {
      if (typeof localStorage === 'undefined') return null;

      const cached = localStorage.getItem('beta1_adaptive_weights');
      if (!cached) return null;

      const data = JSON.parse(cached);
      const ageMs = Date.now() - data.timestamp;
      const ageHours = ageMs / (1000 * 60 * 60);

      console.log(`[WeightRestorer] ✓ Loaded cached weights (${ageHours.toFixed(1)}h old)`);

      this.lastWeights = data.weights;
      this.restoredAt = Date.now();
      this.source = 'cache';

      return data;
    } catch (err) {
      console.warn('[WeightRestorer] Cache load failed:', err.message);
      return null;
    }
  }

  /**
   * Try Electron IPC cache as fallback
   */
  async restoreFromElectron() {
    try {
      if (typeof window === 'undefined' || !window.electron) return null;

      const result = await window.electron.invoke('storage:readContractCache');
      const settlements = result?.settlements || result?.data || result?.contracts || [];
      if (!result?.success || !Array.isArray(settlements) || settlements.length === 0) return null;

      // Calculate current weights from historical accuracy
      const stats = this._calculateStatsFromContracts(settlements);
      const weights = this._deriveWeights(stats);

      console.log(`[WeightRestorer] ✓ Derived weights from Electron cache (${settlements.length} contracts)`);

      this.lastWeights = weights;
      this.restoredAt = Date.now();
      this.source = 'electron';

      return { weights, stats, source: 'electron' };
    } catch (err) {
      console.warn('[WeightRestorer] Electron restore failed:', err.message);
      return null;
    }
  }

  /**
   * Apply restored weights to adaptive learning engine
   */
  applyWeights(symbols = ['BTC', 'ETH', 'SOL', 'XRP']) {
    if (!this.lastWeights) {
      console.warn('[WeightRestorer] No weights to apply');
      return false;
    }

    try {
      for (const sym of symbols) {
        if (this.lastWeights[sym]) {
          // Update adaptive learning engine (if loaded)
          if (typeof window !== 'undefined' && window.AdaptiveLearner) {
            window.AdaptiveLearner.setSymbolWeights(sym, this.lastWeights[sym]);
          }
        }
      }

      console.log(`[WeightRestorer] ✓ Applied weights to ${symbols.length} symbols (source: ${this.source})`);
      return true;
    } catch (err) {
      console.error('[WeightRestorer] Failed to apply weights:', err.message);
      return false;
    }
  }

  /**
   * Startup sequence: restore instantly, then update in background
   */
  async initialize() {
    if (this._initialized) {
      return {
        success: !!this.lastWeights,
        source: this.source,
        weights: this.lastWeights,
      };
    }
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      console.log('[WeightRestorer] Startup: restoring calibration...');

      // Step 1: Restore from cache (instant)
      let restored = this.restoreFromCache();

      if (!restored) {
        // Step 2: Fallback to Electron cache
        restored = await this.restoreFromElectron();
      }

      if (restored) {
        // Step 3: Apply weights immediately
        this.applyWeights();
        console.log('[WeightRestorer] ✓ Calibration restored and applied');
      } else {
        console.warn('[WeightRestorer] ⚠ No calibration to restore (first run?)');
      }

      // Step 4: Schedule background refresh (don't block startup)
      this._scheduleBackgroundRefresh();
      this._initialized = true;

      return {
        success: !!restored,
        source: this.source,
        weights: this.lastWeights,
      };
    })();

    try {
      return await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  /**
   * Persist current weights for next restart
   */
  cacheCurrentWeights(symbols = ['BTC', 'ETH', 'SOL', 'XRP']) {
    try {
      if (typeof localStorage === 'undefined') return false;

      const weights = {};

      for (const sym of symbols) {
        if (typeof window !== 'undefined' && window.AdaptiveLearner) {
          const symWeights = window.AdaptiveLearner.getSymbolWeights?.(sym);
          if (symWeights) {
            weights[sym] = symWeights;
          }
        }
      }

      localStorage.setItem('beta1_adaptive_weights', JSON.stringify({
        weights,
        timestamp: Date.now(),
        version: 1,
      }));

      console.log('[WeightRestorer] ✓ Cached current weights for next restart');
      return true;
    } catch (err) {
      console.warn('[WeightRestorer] Failed to cache weights:', err.message);
      return false;
    }
  }

  /**
   * Calculate stats from raw contract data
   */
  _calculateStatsFromContracts(contracts) {
    const stats = { bySymbol: {} };

    for (const c of contracts) {
      const sym = (c.symbol || c.sym || c.coin || 'UNKNOWN').toUpperCase();
      if (!stats.bySymbol[sym]) {
        stats.bySymbol[sym] = {
          total: 0,
          wins: 0,
          losses: 0,
          recentTrend: [],
        };
      }

      stats.bySymbol[sym].total++;
      if (c.modelCorrect === true) {
        stats.bySymbol[sym].wins++;
        stats.bySymbol[sym].recentTrend.push(1);
      } else if (c.modelCorrect === false) {
        stats.bySymbol[sym].losses++;
        stats.bySymbol[sym].recentTrend.push(0);
      }

      // Keep last 50 for trend
      if (stats.bySymbol[sym].recentTrend.length > 50) {
        stats.bySymbol[sym].recentTrend.shift();
      }
    }

    return stats;
  }

  /**
   * Derive weights from historical accuracy
   */
  _deriveWeights(stats) {
    const DEFAULT_WEIGHTS = {
      rsiFactor: 0.8,
      vwapThreshold: 0.6,
      emaWeight: 1.0,
      obvMomentum: 0.7,
      polymarketBias: 0.5,
    };

    const weights = {};

    for (const sym in stats.bySymbol) {
      const s = stats.bySymbol[sym];
      if (s.total < 5) {
        weights[sym] = DEFAULT_WEIGHTS;
        continue;
      }

      const winRate = s.wins / s.total;
      const trend = s.recentTrend.reduce((a, b) => a + b, 0) / s.recentTrend.length;

      // Adjust weights based on recent performance
      weights[sym] = {
        rsiFactor: DEFAULT_WEIGHTS.rsiFactor * (0.8 + trend * 0.4),
        vwapThreshold: DEFAULT_WEIGHTS.vwapThreshold * (0.8 + trend * 0.4),
        emaWeight: DEFAULT_WEIGHTS.emaWeight * (0.8 + trend * 0.4),
        obvMomentum: DEFAULT_WEIGHTS.obvMomentum * (0.8 + trend * 0.4),
        polymarketBias: DEFAULT_WEIGHTS.polymarketBias * (0.5 + winRate * 1.0),
      };
    }

    return weights;
  }

  /**
   * Schedule background refresh without blocking
   */
  _scheduleBackgroundRefresh() {
    // Refresh every 5 minutes in background
    if (typeof window === 'undefined') return;
    if (this._refreshTimer) return;

    this._refreshTimer = setInterval(() => {
      if (typeof window !== 'undefined' && window.ContractWinRateCalculator) {
        const calc = new window.ContractWinRateCalculator();
        calc.updateInBackground()
          .then(() => {
            // Cache new weights
            this.cacheCurrentWeights();
          })
          .catch(err => console.warn('[WeightRestorer] Background refresh failed:', err.message));
      }
    }, 5 * 60 * 1000);
  }
}

// Browser/Node compatibility
if (typeof window !== 'undefined') {
  window.AdaptiveWeightRestorer = AdaptiveWeightRestorer;

  const bootRestorer = () => {
    const restorer = window.__AdaptiveWeightRestorer || new AdaptiveWeightRestorer();
    window.__AdaptiveWeightRestorer = restorer;
    restorer.initialize().catch(err =>
      console.error('[WeightRestorer] Init failed:', err.message)
    );
  };

  // Auto-init once on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootRestorer, { once: true });
  } else {
    bootRestorer();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AdaptiveWeightRestorer;
}

console.log('[AdaptiveWeightRestorer] Module loaded - auto-init will run on app load');
