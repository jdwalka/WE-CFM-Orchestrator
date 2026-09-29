/**
 * ================================================================
 * Contract Win Rate Calculator
 * 
 * Compares model predictions vs actual Kalshi outcomes
 * Calculates per-contract win rates and accuracy trends
 * Persists to both browser storage and drive cache for:
 *  - Debug panel population
 *  - Adaptive weight adjustment at startup
 * ================================================================
 */

class ContractWinRateCalculator {
  constructor() {
    this.contracts = [];
    this.stats = {
      bySymbol: {},
      byTimeframe: {},
      total: 0,
      overall: {
        wins: 0,
        losses: 0,
        winRate: 0,
      },
    };
    this.lastCalculated = null;
    this.cacheDirty = false;
  }

  /**
   * Load contracts from historical fetcher
   * Merges Kalshi, Polymarket, and Coinbase settled data
   */
  async loadHistoricalContracts() {
    try {
      if (typeof window === 'undefined') return [];

      if (!window.HistoricalSettlementFetcher) {
        console.warn('[WinRateCalc] HistoricalSettlementFetcher not loaded');
        return [];
      }

      const fetcher = new window.HistoricalSettlementFetcher();
      const settled = await fetcher.fetchAllSettled();

      const contracts = [
        ...settled.kalshi,
        ...settled.polymarket,
        ...settled.coinbase,
      ];

      console.log(`[WinRateCalc] Loaded ${contracts.length} historical contracts`);
      return contracts;
    } catch (err) {
      console.error('[WinRateCalc] Error loading historical contracts:', err.message);
      return [];
    }
  }

  /**
   * Load contracts from Electron cache (multi-drive)
   */
  async loadCachedContracts() {
    try {
      if (typeof window === 'undefined' || !window.electron) return [];

      const result = await window.electron.invoke('storage:readContractCache');
      if (result.success && result.data) {
        console.log(`[WinRateCalc] Loaded ${result.data.length} contracts from cache (${result.source})`);
        return result.data;
      }
    } catch (err) {
      console.warn('[WinRateCalc] Cache load failed:', err.message);
    }
    return [];
  }

  /**
   * Load contracts from all sources (priority: Cache > Historical)
   */
  async loadAllContracts() {
    const [cached, historical] = await Promise.all([
      this.loadCachedContracts(),    // Drive cache
      this.loadHistoricalContracts(), // Historical fetcher (Polymarket + Coinbase)
    ]);

    // Deduplicate: timestamp + symbol
    const seen = new Map();
    const merged = [...cached, ...historical];

    for (const c of merged) {
      const key = `${c.ts || c.settledTs || c.createdAt}-${c.symbol}`;
      if (!seen.has(key)) {
        seen.set(key, c);
      }
    }

    this.contracts = Array.from(seen.values())
      .sort((a, b) => (a.ts || a.settledTs || 0) - (b.ts || b.settledTs || 0))
      .slice(-500); // Keep most recent 500

    console.log(`[WinRateCalc] Loaded contracts: ${cached.length} from cache, ${historical.length} historical (total: ${this.contracts.length})`);
    return this.contracts;
  }

  /**
   * Calculate accuracy: compare model predictions vs actual outcomes
   * Uses window._lastPrediction for model direction
   */
  calculateAccuracy() {
    const predictions = window._lastPrediction || {};
    const stats = {
      bySymbol: {},
      byTimeframe: {},
      overall: {
        total: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
      },
    };

    for (const contract of this.contracts) {
      const sym = contract.symbol;
      if (!sym) continue;

      // Initialize symbol stats
      if (!stats.bySymbol[sym]) {
        stats.bySymbol[sym] = {
          symbol: sym,
          total: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          recentWinRate: 0, // Last 10 contracts
          recent: [],
        };
      }

      // Determine model direction and outcome
      const pred = predictions[sym];
      const modelDir = contract.modelDir || pred?.direction; // 'UP' or 'DOWN'

      let actualDir = null;
      if (contract.outcome === 'UP' || contract.outcome === 'DOWN') {
        actualDir = contract.outcome;
      } else {
        // Polymarket/Coinbase: outcome is already YES/NO where YES = UP
        actualDir = contract.outcome === 'YES' ? 'UP' : 'DOWN';
      }

      stats.bySymbol[sym].total++;
      stats.overall.total++;

      // Is this prediction correct?
      let isWin = false;
      if (typeof contract.modelCorrect === 'boolean') {
        isWin = contract.modelCorrect;
      } else {
        isWin = !!(modelDir && actualDir && modelDir === actualDir);
        contract.modelCorrect = isWin;
      }

      if (isWin) {
        stats.bySymbol[sym].wins++;
        stats.overall.wins++;
      } else {
        stats.bySymbol[sym].losses++;
        stats.overall.losses++;
      }

      // Track recent for trending
      stats.bySymbol[sym].recent.push(isWin ? 1 : 0);
      if (stats.bySymbol[sym].recent.length > 50) {
        stats.bySymbol[sym].recent.shift();
      }
    }

    // Calculate win rates
    for (const sym in stats.bySymbol) {
      const s = stats.bySymbol[sym];
      if (s.total > 0) {
        s.winRate = (s.wins / s.total * 100).toFixed(1);

        // Recent win rate (last 10)
        if (s.recent.length > 0) {
          const recentWins = s.recent.slice(-10).reduce((a, b) => a + b, 0);
          s.recentWinRate = (recentWins / Math.min(10, s.recent.length) * 100).toFixed(1);
        }
      }
    }

    if (stats.overall.total > 0) {
      stats.overall.winRate = (stats.overall.wins / stats.overall.total * 100).toFixed(1);
    }

    this.stats = stats;
    this.lastCalculated = Date.now();
    this.cacheDirty = true;

    console.log(`[WinRateCalc] Accuracy calculated: ${stats.overall.winRate}% (${stats.overall.wins}/${stats.overall.total})`);
    return stats;
  }

  /**
   * Persist calculated stats to browser storage
   */
  persistToStorage() {
    try {
      if (typeof localStorage === 'undefined') return false;

      localStorage.setItem('beta1_contract_stats', JSON.stringify(this.stats));
      localStorage.setItem('beta1_contract_list', JSON.stringify(
        this.contracts.slice(-200) // Keep 200 most recent
      ));

      console.log('[WinRateCalc] Persisted to localStorage');
      return true;
    } catch (err) {
      console.warn('[WinRateCalc] Failed to persist to localStorage:', err.message);
      return false;
    }
  }

  /**
   * Persist to Electron cache (multi-drive)
   */
  async persistToElectronCache() {
    try {
      if (typeof window === 'undefined' || !window.electron) return false;

      const result = await window.electron.invoke('storage:writeContractCache',
        this.contracts.map(c => ({
          ...c,
          modelCorrect: c.modelCorrect,
          winRateCalculatedAt: this.lastCalculated,
        }))
      );

      if (result.success) {
        console.log(
          `[WinRateCalc] Persisted to Electron cache ` +
          `(writes=${result.writeCount || 1}, path=${result.path || 'unknown'}, contracts=${result.count})`
        );
        this.cacheDirty = false;
        return true;
      }
    } catch (err) {
      console.warn('[WinRateCalc] Failed to persist to Electron cache:', err.message);
    }
    return false;
  }

  /**
   * Dispatch event for debug panel to listen to
   */
  broadcastStats() {
    if (typeof window === 'undefined') return;

    const event = new CustomEvent('contract:statsUpdated', {
      detail: {
        stats: this.stats,
        contracts: this.contracts.slice(-50), // Last 50 for detail
        timestamp: Date.now(),
      },
    });

    window.dispatchEvent(event);
    console.log('[WinRateCalc] Broadcasted stats update event');
  }

  /**
   * Get win rate for specific symbol
   */
  getWinRateForSymbol(symbol) {
    return this.stats.bySymbol[symbol] || null;
  }

  /**
   * Get accuracy insights for adaptive learning
   * Returns data structure that weight calculator can use
   */
  getAdaptiveInsights() {
    return {
      timestamp: this.lastCalculated,
      overall: this.stats.overall,
      perSymbol: this.stats.bySymbol,
      confidence: Math.min(1.0, this.stats.overall.total / 100), // 0-1: confidence based on sample size
      recommendedAdjustments: this._calculateWeightAdjustments(),
    };
  }

  /**
   * Calculate recommended weight adjustments based on historical accuracy
   */
  _calculateWeightAdjustments() {
    const adjustments = {};
    const threshold = 50; // Win rate threshold

    for (const sym in this.stats.bySymbol) {
      const s = this.stats.bySymbol[sym];
      const wr = parseFloat(s.winRate);

      if (s.total < 5) continue; // Need minimum trades

      if (wr > 60) {
        // High accuracy: increase confidence, reduce stops
        adjustments[sym] = {
          direction: 'INCREASE',
          factors: ['rsiFactor', 'emaWeight'],
          magnitude: 0.05,
          reason: `High accuracy: ${wr}%`,
        };
      } else if (wr < 40) {
        // Low accuracy: decrease confidence, tighten stops
        adjustments[sym] = {
          direction: 'DECREASE',
          factors: ['obvMomentum', 'vwapThreshold'],
          magnitude: 0.08,
          reason: `Low accuracy: ${wr}%`,
        };
      }
    }

    return adjustments;
  }

  /**
   * FAST initialization: restore from cache immediately
   * This is called on app startup - must be <100ms
   */
  initializeFast() {
    console.log('[WinRateCalc] Fast init (from cache)...');

    try {
      if (typeof localStorage === 'undefined') {
        console.warn('[WinRateCalc] localStorage unavailable');
        return this.stats;
      }

      // Restore cached stats
      const cachedStats = localStorage.getItem('beta1_contract_stats');
      const cachedContracts = localStorage.getItem('beta1_contract_list');

      if (cachedStats) {
        this.stats = JSON.parse(cachedStats);
        console.log(`[WinRateCalc] ✓ Restored stats from cache (${this.stats.overall.total} total, ${this.stats.overall.winRate}% WR)`);
      }

      if (cachedContracts) {
        this.contracts = JSON.parse(cachedContracts);
        console.log(`[WinRateCalc] ✓ Restored ${this.contracts.length} contracts from cache`);
      }

      // Broadcast immediately so UI can use cached data
      this.broadcastStats();

      console.log('[WinRateCalc] Fast init complete (<100ms)');
      return this.stats;
    } catch (err) {
      console.warn('[WinRateCalc] Fast init error:', err.message);
      return this.stats;
    }
  }

  /**
   * BACKGROUND update: fetch new data without blocking
   * Call AFTER app is functional. Updates cache asynchronously.
   */
  async updateInBackground() {
    console.log('[WinRateCalc] Background update started (non-blocking)...');

    try {
      // Load new contracts (but don't block on this)
      await this.loadAllContracts();

      // Recalculate accuracy
      this.calculateAccuracy();

      // Persist updates
      this.persistToStorage();
      await this.persistToElectronCache();

      // Broadcast updated data
      this.broadcastStats();

      console.log('[WinRateCalc] Background update complete');
      return this.stats;
    } catch (err) {
      console.error('[WinRateCalc] Background update failed:', err.message);
      // Don't throw - let app continue with cached data
    }
  }

  /**
   * Full initialization pipeline (legacy)
   * Only use this if you need fresh data on startup (slow!)
   */
  async initialize() {
    console.log('[WinRateCalc] Full init (SLOW - use initializeFast + updateInBackground instead)...');

    // Load contracts from all sources
    await this.loadAllContracts();

    // Calculate accuracy
    this.calculateAccuracy();

    // Persist to both storage layers
    this.persistToStorage();
    await this.persistToElectronCache();

    // Broadcast for UI components
    this.broadcastStats();

    console.log('[WinRateCalc] Initialization complete');
    return this.stats;
  }
}

// Browser/Node compatibility
if (typeof window !== 'undefined') {
  window.ContractWinRateCalculator = ContractWinRateCalculator;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContractWinRateCalculator;
}

console.log('[ContractWinRateCalculator] Module loaded');

// ──────────────────────────────────────────────────────────────────
// Create singleton instance for debug panel & app-wide access
// ──────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.__WinRateCalculatorInstance = new ContractWinRateCalculator();

  // Expose getter for debug panel to access historical contracts directly
  window.getHistoricalContracts = () => {
    return window.__WinRateCalculatorInstance?.contracts || [];
  };

  // Expose getter for accuracy stats
  window.getAccuracyStats = () => {
    return window.__WinRateCalculatorInstance?.stats || {};
  };
}
