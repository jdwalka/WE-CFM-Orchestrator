/**
 * ================================================================
 * SCORECARD DATA AGGREGATOR
 * 
 * Captures and correlates:
 * - Prediction errors (wrong direction, low confidence)
 * - Settlement outcomes from Kalshi/Polymarket/Coinbase
 * - Error logs from engine
 * - Backtest performance data
 * 
 * Provides unified analysis for debugging "no settlement data" issues
 * ================================================================
 */

class ScorecardDataAggregator {
  constructor() {
    this.predictions = [];        // All predictions made
    this.settlements = [];        // All settled contracts
    this.errors = [];             // All prediction errors
    this.backtests = [];          // Backtest results
    this.correlations = [];       // Matched predictions to outcomes
    
    this.errorBuffer = [];        // Circular buffer for recent errors
    this.errorBufferSize = 1000;
    
    this.stats = {
      predictionsTotal: 0,
      settlementsTotal: 0,
      errorCount: 0,
      matchedCount: 0,
      accuracy: 0,
    };
    
    // Load from localStorage on startup
    this._loadFromCache();
    
    console.log(`[ScorecardDataAggregator] Initialized (${this.settlements.length} settlements from cache)`);
  }

  /**
   * Load data from localStorage cache
   */
  _loadFromCache() {
    try {
      const cached = localStorage.getItem('scorecard-data');
      if (cached) {
        const data = JSON.parse(cached);
        this.predictions = data.predictions || [];
        this.settlements = data.settlements || [];
        this.errors = data.errors || [];
        this.correlations = data.correlations || [];
        this.stats = data.stats || this.stats;
        console.log(`[Scorecard] Loaded from cache: ${this.settlements.length} settlements, ${this.predictions.length} predictions`);
      }
    } catch (e) {
      console.warn('[Scorecard] Cache load failed:', e.message);
    }
  }

  /**
   * Save data to localStorage cache (debounced to prevent UI freezing)
   */
  _saveToCache() {
    if (this._savePending) return;
    this._savePending = true;

    setTimeout(() => {
      this._savePending = false;
      try {
        // Strip heavy 'signals' object from predictions before caching to prevent QuotaExceededError
        const slimPredictions = this.predictions.map(p => {
          const { signals, ...rest } = p;
          return rest;
        });

        // Ensure arrays are strictly capped
        if (this.correlations.length > 500) this.correlations = this.correlations.slice(-500);
        if (this.backtests.length > 500) this.backtests = this.backtests.slice(-500);

        const data = {
          predictions: slimPredictions,
          settlements: this.settlements,
          errors: this.errors.slice(-100),
          correlations: this.correlations,
          stats: this.stats,
          timestamp: Date.now(),
        };
        localStorage.setItem('scorecard-data', JSON.stringify(data));
      } catch (e) {
        // Silently fail if localStorage is full
        if (e.name === 'QuotaExceededError') {
          // Clear oldest 25% of data and retry
          this.predictions = this.predictions.slice(Math.floor(this.predictions.length * 0.25));
          this.settlements = this.settlements.slice(Math.floor(this.settlements.length * 0.25));
          this.correlations = this.correlations.slice(Math.floor(this.correlations.length * 0.25));
          try {
            const data = {
              predictions: this.predictions.map(p => ({ ...p, signals: undefined })),
              settlements: this.settlements,
              errors: this.errors.slice(-50),
              correlations: this.correlations,
              stats: this.stats,
              timestamp: Date.now(),
            };
            localStorage.setItem('scorecard-data', JSON.stringify(data));
          } catch (e2) {
            console.warn('[Scorecard] Cache save failed even after cleanup:', e2.message);
          }
        }
      }
    }, 2000);
  }

  /**
   * Capture prediction from engine
   * Called whenever prediction is generated
   */
  recordPrediction(coin, prediction, confidence, signals = {}) {
    const entry = {
      id: `pred-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      coin,
      prediction,
      confidence,
      signals,
      settled: false,
      outcome: null,
      isCorrect: null,
      errorReason: null,
    };

    this.predictions.push(entry);
    this.stats.predictionsTotal++;

    // Trim to last 500 if too large
    if (this.predictions.length > 500) {
      this.predictions.shift();
    }

    // Save to cache
    this._saveToCache();
    
    return entry.id;
  }

  /**
   * Capture error that occurred during prediction or settlement
   * Links error to prediction chain
   */
  recordError(coin, errorType, message, context = {}) {
    const error = {
      id: `err-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      coin,
      type: errorType, // 'PREDICTION_FAILED', 'SIGNAL_INVERSION', 'LOW_CONFIDENCE', etc.
      message,
      context, // Additional context (prediction, market data, etc.)
      relatedPredictionId: context.predictionId || null,
    };

    this.errors.push(error);
    this.errorBuffer.push(error);
    if (this.errorBuffer.length > this.errorBufferSize) {
      this.errorBuffer.shift();
    }

    this.stats.errorCount++;

    // Log to browser console for debugging
    console.warn(`[ScorecardAggregator] ERROR [${coin}] ${errorType}: ${message}`);

    // Save to cache
    this._saveToCache();

    return error.id;
  }

  /**
   * Record settlement from Kalshi/Polymarket/Coinbase
   */
  recordSettlement(coin, source, outcome, settleTime, metadata = {}) {
    const settlement = {
      id: `settle-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      coin,
      source,
      outcome, // 'UP' or 'DOWN'
      settleTime,
      matchedPredictionId: null,
      isCorrect: null,
      metadata,
    };

    this.settlements.push(settlement);

    // Try to match with recent prediction
    const recentPred = this.predictions
      .filter(p => p.coin === coin)
      .filter(p => p.timestamp < settleTime + 60000) // Within 1 minute after settle
      .sort((a, b) => b.timestamp - a.timestamp)
      .at(0);

    if (recentPred) {
      settlement.matchedPredictionId = recentPred.id;
      recentPred.settled = true;
      recentPred.outcome = outcome;
      recentPred.isCorrect = recentPred.prediction === outcome;

      this.correlations.push({
        predictionId: recentPred.id,
        settlementId: settlement.id,
        coin,
        predicted: recentPred.prediction,
        actual: outcome,
        isCorrect: recentPred.isCorrect,
        confidence: recentPred.confidence,
        timeDiff: settleTime - recentPred.timestamp,
      });

      this.stats.matchedCount++;
    }

    // Trim to last 500 if too large
    if (this.settlements.length > 500) {
      this.settlements.shift();
    }

    this.stats.settlementsTotal++;

    // Save to cache
    this._saveToCache();

    return settlement.id;
  }

  /**
   * Record backtest result
   */
  recordBacktest(coin, backtestData) {
    const entry = {
      id: `bt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      coin,
      ...backtestData,
    };

    this.backtests.push(entry);
    
    // Save to cache
    this._saveToCache();
    
    return entry.id;
  }

  /**
   * Get recent errors for a coin
   */
  getRecentErrors(coin = null, limit = 10) {
    let filtered = this.errorBuffer;
    
    if (coin) {
      filtered = filtered.filter(e => e.coin === coin);
    }

    return filtered.slice(-limit).reverse();
  }

  /**
   * Get accuracy stats for a coin
   */
  getAccuracy(coin = null) {
    let relevant = this.correlations;

    if (coin) {
      relevant = relevant.filter(c => c.coin === coin);
    }

    if (relevant.length === 0) {
      return {
        total: 0,
        correct: 0,
        accuracy: 0,
        coins: {},
      };
    }

    const correct = relevant.filter(c => c.isCorrect).length;
    const accuracy = Math.round((correct / relevant.length) * 1000) / 10;

    // Per-coin breakdown
    const coins = {};
    for (const corr of relevant) {
      if (!coins[corr.coin]) {
        coins[corr.coin] = { total: 0, correct: 0, accuracy: 0 };
      }
      coins[corr.coin].total++;
      if (corr.isCorrect) coins[corr.coin].correct++;
      coins[corr.coin].accuracy = Math.round((coins[corr.coin].correct / coins[corr.coin].total) * 1000) / 10;
    }

    return {
      total: relevant.length,
      correct,
      accuracy,
      coins,
    };
  }

  /**
   * Diagnose why settlement data is missing
   * Returns structured diagnosis
   */
  async diagnoseSettlementData() {
    const diagnosis = {
      timestamp: Date.now(),
      issues: [],
      recommendations: [],
      summary: '',
    };

    // Check 1: Are predictions being recorded?
    if (this.predictions.length === 0) {
      diagnosis.issues.push('NO_PREDICTIONS: No predictions recorded yet');
      diagnosis.recommendations.push('Wait for engine to make first prediction OR ensure prediction capture is active');
    }

    // Check 2: Are settlements being recorded?
    if (this.settlements.length === 0) {
      diagnosis.issues.push('NO_SETTLEMENTS: No settled contracts fetched yet');
      diagnosis.recommendations.push('Run: window._accuracyScorecard.buildScorecard()');
      diagnosis.recommendations.push('Or call: window._settledFetcher.fetchAllSettled()');
    }

    // Check 3: Are they being matched?
    if (this.predictions.length > 0 && this.settlements.length > 0 && this.correlations.length === 0) {
      diagnosis.issues.push('PREDICTIONS_SETTLEMENTS_MISMATCH: Data exists but not matched (timing issue?)');
      diagnosis.recommendations.push('Check prediction timestamps match settlement times');
      diagnosis.recommendations.push('Run correlation manually: window._aggregator.correlateAllData()');
    }

    // Check 4: Are errors being recorded?
    if (this.errors.length === 0 && this.predictions.length > 10) {
      diagnosis.issues.push('POSSIBLE_SILENT_FAILURES: Many predictions but no errors logged');
      diagnosis.recommendations.push('Ensure error capture is wired into prediction pipeline');
    }

    // Check 5: Low accuracy
    const acc = this.getAccuracy();
    if (acc.total > 20 && acc.accuracy < 40) {
      diagnosis.issues.push(`LOW_ACCURACY: Only ${acc.accuracy}% (${acc.correct}/${acc.total})`);
      diagnosis.recommendations.push('Review signal inversion issues');
      diagnosis.recommendations.push('Run: window.PolymarketAccuracyDebug.findInversions()');
    }

    // Generate summary
    if (diagnosis.issues.length === 0) {
      diagnosis.summary = 'All systems operational';
    } else {
      diagnosis.summary = `${diagnosis.issues.length} issue(s) detected`;
    }

    return diagnosis;
  }

  /**
   * Manually correlate all prediction/settlement pairs
   */
  correlateAllData() {
    console.log('[ScorecardDataAggregator] Correlating all data...');

    this.correlations = [];

    for (const pred of this.predictions) {
      // Find matching settlement
      const matching = this.settlements.filter(s => 
        s.coin === pred.coin &&
        s.settleTime >= pred.timestamp &&
        s.settleTime <= pred.timestamp + 3600000 // Within 1 hour
      );

      if (matching.length > 0) {
        const settlement = matching[0]; // Take first match
        const isCorrect = pred.prediction === settlement.outcome;

        this.correlations.push({
          predictionId: pred.id,
          settlementId: settlement.id,
          coin: pred.coin,
          predicted: pred.prediction,
          actual: settlement.outcome,
          isCorrect,
          confidence: pred.confidence,
          timeDiff: settlement.settleTime - pred.timestamp,
        });

        pred.settled = true;
        pred.outcome = settlement.outcome;
        pred.isCorrect = isCorrect;
      }
    }

    console.log(`[ScorecardDataAggregator] Correlated ${this.correlations.length} prediction/settlement pairs`);
    return this.correlations;
  }

  /**
   * Export all data as JSON
   */
  exportJSON() {
    return {
      timestamp: Date.now(),
      predictions: this.predictions,
      settlements: this.settlements,
      errors: this.errors,
      correlations: this.correlations,
      stats: {
        ...this.stats,
        accuracy: this.getAccuracy(),
      },
    };
  }

  /**
   * Export as CSV for Excel/Sheets analysis
   */
  exportCSV() {
    let csv = 'TIMESTAMP,COIN,TYPE,PREDICTION,ACTUAL,CONFIDENCE,IS_CORRECT,NOTES\n';

    // Export correlations
    for (const corr of this.correlations) {
      const isCorrectStr = corr.isCorrect ? 'YES' : 'NO';
      const ts = new Date(Date.now()).toISOString(); // Use current time if not set
      csv += `${ts},${corr.coin},CORRELATION,${corr.predicted},${corr.actual},${corr.confidence},${isCorrectStr},"Time diff: ${corr.timeDiff}ms"\n`;
    }

    // Export unmatched predictions
    for (const pred of this.predictions.filter(p => !p.settled)) {
      const ts = pred.timestamp ? new Date(pred.timestamp).toISOString() : new Date(Date.now()).toISOString();
      csv += `${ts},${pred.coin},PREDICTION,${pred.prediction},-,${pred.confidence},-,"Unmatched"\n`;
    }

    // Export errors
    for (const err of this.errors) {
      const ts = err.timestamp ? new Date(err.timestamp).toISOString() : new Date(Date.now()).toISOString();
      csv += `${ts},${err.coin},ERROR,-,-,-,-,"${err.type}: ${err.message}"\n`;
    }

    return csv;
  }

  /**
   * Print comprehensive status report
   */
  printReport() {
    console.log('\n╔═════════════════════════════════════════════════════╗');
    console.log('║     SCORECARD DATA AGGREGATOR - STATUS REPORT       ║');
    console.log('╚═════════════════════════════════════════════════════╝\n');

    console.log('📊 DATA COUNTS:');
    console.log(`   Predictions:   ${this.predictions.length}`);
    console.log(`   Settlements:   ${this.settlements.length}`);
    console.log(`   Correlations:  ${this.correlations.length}`);
    console.log(`   Errors:        ${this.errors.length}`);

    const acc = this.getAccuracy();
    console.log('\n📈 ACCURACY:');
    console.log(`   Overall: ${acc.accuracy}% (${acc.correct}/${acc.total})`);

    if (Object.keys(acc.coins).length > 0) {
      console.log('   By coin:');
      for (const [coin, coinAcc] of Object.entries(acc.coins)) {
        console.log(`     ${coin}: ${coinAcc.accuracy}% (${coinAcc.correct}/${coinAcc.total})`);
      }
    }

    console.log('\n🚨 RECENT ERRORS:');
    const recentErrors = this.getRecentErrors(null, 5);
    if (recentErrors.length === 0) {
      console.log('   None');
    } else {
      recentErrors.forEach((err, i) => {
        console.log(`   ${i + 1}. [${err.coin}] ${err.type}: ${err.message}`);
      });
    }

    console.log('');
  }

  /**
   * Clear all data (for testing/reset)
   */
  clear() {
    this.predictions = [];
    this.settlements = [];
    this.errors = [];
    this.backtests = [];
    this.correlations = [];
    this.errorBuffer = [];
    this.stats = {
      predictionsTotal: 0,
      settlementsTotal: 0,
      errorCount: 0,
      matchedCount: 0,
      accuracy: 0,
    };
    console.log('[ScorecardDataAggregator] Cleared all data');
  }
}

// Export globally
if (typeof window !== 'undefined') {
  window.ScorecardDataAggregator = ScorecardDataAggregator;
  
  // Auto-initialize
  if (!window._aggregator) {
    window._aggregator = new ScorecardDataAggregator();
    console.log('[ScorecardDataAggregator] Auto-initialized as window._aggregator');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScorecardDataAggregator;
}

console.log('[ScorecardDataAggregator] Module loaded');
