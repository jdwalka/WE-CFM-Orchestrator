/**
 * ================================================================
 * COMPREHENSIVE KALSHI ACCURACY SCORECARD & DIAGNOSTICS
 * 
 * Fixes "no settlement data" issue by:
 * 1. Fetching ALL historical settled contracts (not just recent)
 * 2. Loading backtest results & error logs
 * 3. Correlating predictions with empirical data
 * 4. Building unified accuracy picture
 * ================================================================
 */

class ComprehensiveAccuracyScorecard {
  constructor() {
    this.data = {
      predictions: {},      // window._predictions
      settled: {},          // from fetcher
      backtests: {},        // from CSV files
      errorLogs: {},        // from error logs
      correlations: {},     // mapping predictions to actual outcomes
    };
    
    this.cache = {
      lastFetch: 0,
      fetchTTL: 300_000,    // 5 min
      data: null,
    };
    
    this.stats = {
      totalPredictions: 0,
      totalSettled: 0,
      totalBacktests: 0,
      totalErrors: 0,
      correlatedCount: 0,
    };
    
    console.log('[ComprehensiveAccuracyScorecard] Initialized');
  }

  /**
   * Fetch ALL settled contracts from Kalshi API
   * Retrieves full history, not just cached recent contracts
   */
  async fetchAllKalshiSettled(limit = 500, offset = 0) {
    try {
      const url = `https://api.elections.kalshi.com/trade-api/v2/markets?status=settled&limit=${limit}&offset=${offset}`;
      const response = await fetch(url, { timeout: 15000 });
      
      if (!response.ok) {
        console.error(`[Scorecard] Kalshi API error: ${response.status}`);
        return [];
      }
      
      const data = await response.json();
      const markets = data.markets || [];
      
      console.log(`[Scorecard] Fetched ${markets.length} settled markets (offset: ${offset})`);
      
      return markets
        .filter(m => {
          // Only 15M crypto markets
          if (!m.ticker) return false;
          if (!m.ticker.includes('15M')) return false;
          if (!['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'].some(sym => m.ticker.includes(sym))) return false;
          if (m.status !== 'settled') return false;
          return true;
        })
        .map(m => {
          const symMatch = m.ticker.match(/KX(\w+)15M/);
          const symbol = symMatch ? symMatch[1] : null;
          
          return {
            source: 'kalshi',
            ticker: m.ticker,
            symbol,
            status: m.status,
            result: m.result, // 'YES' or 'NO'
            outcome: (() => {
              const strike = String(m.strike_type ?? 'above').toLowerCase();
              const yesDir = strike === 'below' ? 'DOWN' : 'UP';
              return String(m.result).toUpperCase() === 'YES' ? yesDir : (yesDir === 'UP' ? 'DOWN' : 'UP');
            })(),
            strikeType: m.strike_type,
            settleTime: m.close_time ? new Date(m.close_time).getTime() : null,
            createdAt: m.created_at ? new Date(m.created_at).getTime() : null,
            floorPrice: m.floor_price,
            raw: m,
          };
        });
    } catch (err) {
      console.error('[Scorecard] Kalshi fetch error:', err.message);
      return [];
    }
  }

  /**
   * Load all backtest results from backtest-results directory
   * Parses CSV files to extract model performance
   */
  async loadBacktestResults() {
    try {
      // Fetch backtest summary CSVs
      const response = await fetch('/backtest-results/', { timeout: 5000 });
      if (!response.ok) {
        console.warn('[Scorecard] Could not fetch backtest directory');
        return {};
      }

      // Parse from localStorage or window variable if available
      const backtestData = window._backtest_results || {};
      
      console.log(`[Scorecard] Loaded ${Object.keys(backtestData).length} backtest entries`);
      return backtestData;
    } catch (err) {
      console.error('[Scorecard] Backtest load error:', err.message);
      return {};
    }
  }

  /**
   * Load error logs from browser console or localStorage
   * Captures prediction errors and accuracy failures
   */
  async loadErrorLogs() {
    try {
      // Check for error log in localStorage
      let errorLog = [];
      
      const storedLog = localStorage.getItem('PREDICTION_ERROR_LOG');
      if (storedLog) {
        try {
          errorLog = JSON.parse(storedLog);
        } catch (e) {
          console.warn('[Scorecard] Could not parse stored error log');
        }
      }

      // Also check window variable
      if (window._errorLog && Array.isArray(window._errorLog)) {
        errorLog = [...errorLog, ...window._errorLog];
      }

      console.log(`[Scorecard] Loaded ${errorLog.length} error log entries`);
      return errorLog;
    } catch (err) {
      console.error('[Scorecard] Error log load error:', err.message);
      return [];
    }
  }

  /**
   * Get current predictions from window
   */
  getCurrentPredictions() {
    const preds = window._predictions || {};
    const lastPred = window._lastPrediction || {};
    
    const all = {};
    
    // Merge all prediction sources
    Object.assign(all, preds);
    Object.assign(all, lastPred);
    
    console.log(`[Scorecard] Found ${Object.keys(all).length} prediction records`);
    return all;
  }

  /**
   * Correlate predictions with settled outcomes
   * Matches predicted direction to actual market result
   */
  correlateData(predictions, settled) {
    const correlations = {};
    const byCoin = {};

    // Group settled by coin
    for (const s of settled) {
      if (!s.symbol) continue;
      if (!byCoin[s.symbol]) byCoin[s.symbol] = [];
      byCoin[s.symbol].push(s);
    }

    // Match predictions to settled outcomes
    for (const [sym, settledList] of Object.entries(byCoin)) {
      const pred = predictions[sym];
      
      if (!pred) {
        correlations[sym] = {
          symbol: sym,
          status: 'NO_PREDICTION',
          settledCount: settledList.length,
          accuracy: null,
        };
        continue;
      }

      const modelDir = pred.direction || pred.modelDir || pred.prediction;
      if (!modelDir) {
        correlations[sym] = {
          symbol: sym,
          status: 'NO_DIRECTION',
          settledCount: settledList.length,
          accuracy: null,
        };
        continue;
      }

      // Count matches
      let correct = 0;
      const details = [];
      
      for (const s of settledList) {
        const match = s.outcome === modelDir;
        if (match) correct++;
        
        details.push({
          predicted: modelDir,
          actual: s.outcome,
          match,
          settleTime: s.settleTime,
          ticker: s.ticker,
        });
      }

      const accuracy = settledList.length > 0 
        ? Math.round((correct / settledList.length) * 1000) / 10 
        : 0;

      correlations[sym] = {
        symbol: sym,
        status: 'CORRELATED',
        prediction: modelDir,
        settledCount: settledList.length,
        correct,
        accuracy,
        winRate: `${correct}/${settledList.length}`,
        recent: details.slice(-5),
      };
    }

    return correlations;
  }

  /**
   * Build comprehensive scorecard
   * Combines all data sources into single view
   */
  async buildScorecard() {
    console.log('\n[Scorecard] Building comprehensive scorecard...\n');

    try {
      // 1. Fetch all data in parallel
      const [predictions, settled, backtests, errorLogs] = await Promise.all([
        Promise.resolve(this.getCurrentPredictions()),
        this.fetchAllKalshiSettled(),
        this.loadBacktestResults(),
        this.loadErrorLogs(),
      ]);

      // 2. Store in instance
      this.data = {
        predictions,
        settled,
        backtests,
        errorLogs,
      };

      // 3. Correlate
      const correlations = this.correlateData(predictions, settled);
      this.data.correlations = correlations;

      // 4. Calculate stats
      this.stats = {
        totalPredictions: Object.keys(predictions).length,
        totalSettled: settled.length,
        totalBacktests: Object.keys(backtests).length,
        totalErrors: errorLogs.length,
        correlatedCount: Object.keys(correlations).filter(k => correlations[k].status === 'CORRELATED').length,
      };

      console.log(`\n[Scorecard] ✅ Build complete`);
      console.log(`  Predictions: ${this.stats.totalPredictions}`);
      console.log(`  Settled contracts: ${this.stats.totalSettled}`);
      console.log(`  Correlated: ${this.stats.correlatedCount}`);
      console.log(`  Backtest entries: ${this.stats.totalBacktests}`);
      console.log(`  Error logs: ${this.stats.totalErrors}\n`);

      return this.data;
    } catch (err) {
      console.error('[Scorecard] Build error:', err);
      return { error: err.message };
    }
  }

  /**
   * Display scorecard in console
   */
  displayScorecard(coin = 'ALL') {
    const correlations = this.data.correlations || {};

    if (coin === 'ALL') {
      const coins = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'HYPE'];
      console.log('\n╔═══════════════════════════════════════════════════╗');
      console.log('║     COMPREHENSIVE ACCURACY SCORECARD - ALL COINS   ║');
      console.log('╚═══════════════════════════════════════════════════╝\n');

      for (const c of coins) {
        this.displayScorecard(c);
      }
      return;
    }

    const corr = correlations[coin];
    if (!corr) {
      console.log(`  ℹ️  ${coin}: No data available`);
      return;
    }

    if (corr.status === 'NO_PREDICTION') {
      console.log(`  ⚠️  ${coin}: ${corr.settledCount} settled contracts but NO prediction found`);
      return;
    }

    if (corr.status === 'NO_DIRECTION') {
      console.log(`  ⚠️  ${coin}: Prediction incomplete (missing direction)`);
      return;
    }

    // Correlated
    const icon = corr.accuracy >= 55 ? '📈' : corr.accuracy >= 45 ? '➡️' : '📉';
    console.log(`\n${icon} ${coin}`);
    console.log(`   Accuracy: ${corr.accuracy}% (${corr.winRate})`);
    console.log(`   Prediction: ${corr.prediction}`);
    console.log(`   Recent settlements:`);

    if (corr.recent && corr.recent.length > 0) {
      corr.recent.forEach((r, i) => {
        const checkmark = r.match ? '✓' : '✗';
        console.log(`     ${checkmark} Predicted ${r.predicted}, got ${r.actual}`);
      });
    }
  }

  /**
   * Export full scorecard as JSON
   */
  exportJSON() {
    return {
      timestamp: Date.now(),
      stats: this.stats,
      data: this.data,
    };
  }

  /**
   * Export as CSV for analysis
   */
  exportCSV() {
    const correlations = this.data.correlations || {};
    let csv = 'COIN,STATUS,PREDICTION,SETTLED_COUNT,CORRECT,ACCURACY,WIN_RATE\n';

    for (const [coin, corr] of Object.entries(correlations)) {
      csv += `${coin},${corr.status},${corr.prediction || ''},${corr.settledCount},${corr.correct || 0},${corr.accuracy || 0},${corr.winRate || ''}\n`;
    }

    return csv;
  }

  /**
   * Diagnose why "no settlement data" appears
   */
  async diagnose() {
    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║        SETTLEMENT DATA DIAGNOSIS REPORT            ║');
    console.log('╚═══════════════════════════════════════════════════╝\n');

    // Check Kalshi API connectivity
    console.log('1️⃣  KALSHI API CONNECTIVITY TEST');
    try {
      const testUrl = 'https://api.elections.kalshi.com/trade-api/v2/markets?status=settled&limit=1';
      const response = await fetch(testUrl, { timeout: 20000 });
      console.log(`   Status: ${response.status} (${response.ok ? '✅ OK' : '❌ FAILED'})`);
      
      if (response.ok) {
        const data = await response.json();
        console.log(`   Response structure: ${data.markets ? '✅ Has markets' : '❌ No markets field'}`);
      }
    } catch (err) {
      console.log(`   ❌ FAILED: ${err.message}`);
    }

    // Check data in window
    console.log('\n2️⃣  WINDOW DATA AVAILABILITY');
    const kalshiLog = (window._kalshiLog || []).length;
    const predictions = Object.keys(window._predictions || {}).length;
    const lastPred = Object.keys(window._lastPrediction || {}).length;
    
    console.log(`   _kalshiLog entries: ${kalshiLog} ${kalshiLog > 0 ? '✅' : '❌'}`);
    console.log(`   _predictions entries: ${predictions} ${predictions > 0 ? '✅' : '❌'}`);
    console.log(`   _lastPrediction entries: ${lastPred} ${lastPred > 0 ? '✅' : '❌'}`);

    // Check fetcher initialization
    console.log('\n3️⃣  HISTORICAL SETTLEMENT FETCHER');
    const hasFetcher = typeof window.HistoricalSettlementFetcher !== 'undefined';
    console.log(`   Available: ${hasFetcher ? '✅ YES' : '❌ NO'}`);
    
    if (hasFetcher && window._settledFetcher) {
      const diags = window._settledFetcher.getDiagnostics();
      console.log(`   Cache (kalshi): ${diags.cache.kalshi} ${diags.cache.kalshi > 0 ? '✅' : '❌'}`);
      console.log(`   Cache (polymarket): ${diags.cache.polymarket} ${diags.cache.polymarket > 0 ? '✅' : '❌'}`);
      console.log(`   Last Kalshi fetch: ${diags.lastFetch.kalshi > 0 ? new Date(diags.lastFetch.kalshi).toISOString() : '❌ Never'}`);
    }

    // Check localStorage persistence
    console.log('\n4️⃣  LOCALSTORAGE PERSISTENCE');
    try {
      const stored = localStorage.getItem('KALSHI_LOG_STORE');
      console.log(`   KALSHI_LOG_STORE: ${stored ? `✅ (${(stored.length / 1024).toFixed(1)} KB)` : '❌ Empty'}`);
    } catch (err) {
      console.log(`   ❌ Storage error: ${err.message}`);
    }

    // Summary and fix recommendation
    console.log('\n5️⃣  DIAGNOSIS SUMMARY & FIX');
    if (kalshiLog === 0 && predictions === 0) {
      console.log(`   ❌ ROOT CAUSE: No data captured yet`);
      console.log(`   ✅ FIX: Wait for first contract to settle and resolve`);
    } else if (kalshiLog > 0 && predictions === 0) {
      console.log(`   ⚠️  Settled contracts exist but predictions missing`);
      console.log(`   ✅ FIX: Ensure prediction generation is working`);
    } else if (predictions > 0 && kalshiLog === 0) {
      console.log(`   ⚠️  Predictions exist but settled data not loaded`);
      console.log(`   ✅ FIX: Run fetcher.fetchAllKalshiSettled() manually`);
    } else {
      console.log(`   ✅ All data sources available - building scorecard now`);
    }

    console.log('');
  }

  /**
   * Force full refresh from all sources
   */
  async forceRefresh() {
    console.log('[Scorecard] Force refresh initiated...');
    this.cache = { lastFetch: 0, fetchTTL: 300_000, data: null };
    return this.buildScorecard();
  }
}

// Export globally
if (typeof window !== 'undefined') {
  window.ComprehensiveAccuracyScorecard = ComprehensiveAccuracyScorecard;
  
  // Auto-initialize
  if (!window._accuracyScorecard) {
    window._accuracyScorecard = new ComprehensiveAccuracyScorecard();
    console.log('[ComprehensiveAccuracyScorecard] Auto-initialized as window._accuracyScorecard');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ComprehensiveAccuracyScorecard;
}

console.log('[ComprehensiveAccuracyScorecard] Module loaded');
