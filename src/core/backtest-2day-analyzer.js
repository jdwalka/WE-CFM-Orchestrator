// backtest-2day-analyzer.js
// ════════════════════════════════════════════════════════════════════════════
// 2-Day Backtest Analyzer: Compare model predictions vs actual outcomes
// Shows accuracy by coin, signal, and identifies tuning opportunities
// ════════════════════════════════════════════════════════════════════════════

class BacktestAnalyzer {
  constructor() {
    this.startTime = Date.now() - (2 * 24 * 60 * 60 * 1000); // 2 days ago
    this.endTime = Date.now();
    
    this.results = {
      byCoins: {},           // Accuracy per coin
      bySignals: {},         // Accuracy per signal type
      byTimeframes: {},      // Accuracy per timeframe
      predictions: [],       // All predictions analyzed
      settlements: [],       // All settlements during period
      errors: [],            // Analysis errors
      summary: {}            // Overall metrics
    };
  }

  /**
   * Main backtest runner
   */
  async run() {
    console.log(`\n${'═'.repeat(80)}`);
    console.log('🔄 2-DAY BACKTEST ANALYZER');
    console.log(`${'═'.repeat(80)}\n`);
    
    console.log(`⏱️  Analysis Period: ${new Date(this.startTime).toISOString()}`);
    console.log(`                   ${new Date(this.endTime).toISOString()}\n`);

    try {
      // Phase 1: Get historical predictions from cache
      console.log('📊 Phase 1: Loading predictions from cache...');
      const cachedPredictions = await this._getCachedPredictions();
      console.log(`   ✓ Found ${cachedPredictions.length} predictions\n`);

      // Phase 2: Get historical settlements from Kalshi API
      console.log('📊 Phase 2: Fetching settled contracts from Kalshi...');
      const settlements = await this._getHistoricalSettlements();
      console.log(`   ✓ Found ${settlements.length} settlements\n`);

      // Phase 3: Correlate predictions with outcomes
      console.log('📊 Phase 3: Correlating predictions with outcomes...');
      const correlations = await this._correlateData(cachedPredictions, settlements);
      console.log(`   ✓ Correlated ${correlations.length} prediction-outcome pairs\n`);

      // Phase 4: Calculate accuracy metrics
      console.log('📊 Phase 4: Calculating accuracy metrics...');
      await this._calculateAccuracy(correlations);
      console.log(`   ✓ Metrics calculated\n`);

      // Phase 5: Generate analysis and recommendations
      console.log('📊 Phase 5: Generating analysis and recommendations...');
      await this._generateAnalysis();
      console.log(`   ✓ Analysis complete\n`);

      // Phase 6: Identify tuning opportunities
      console.log('📊 Phase 6: Identifying tuning opportunities...');
      await this._identifyTuningOpportunities();

      return this.results;
    } catch (e) {
      console.error('[BacktestAnalyzer] Error:', e.message);
      this.results.errors.push({ message: e.message, stack: e.stack });
      return this.results;
    }
  }

  /**
   * Get predictions from cache (last 2 days)
   */
  async _getCachedPredictions() {
    const predictions = [];
    
    // From window._contractCache (new)
    if (window._contractCache) {
      try {
        const cached = window._contractCache.getRecentPredictions(null, 24 * 60);
        predictions.push(...cached);
        console.log(`   [Cache] ${cached.length} predictions from ContractCache`);
      } catch (e) {
        console.warn(`   [Cache] Error reading ContractCache:`, e.message);
      }
    }

    // From window._predLog (legacy)
    if (window._predLog && Array.isArray(window._predLog)) {
      const legacyPreds = window._predLog.filter(p => {
        const ts = p.ts || p.timestamp;
        return ts >= this.startTime && ts <= this.endTime;
      });
      predictions.push(...legacyPreds);
      console.log(`   [Legacy] ${legacyPreds.length} predictions from _predLog`);
    }

    return predictions.filter(p => {
      const ts = p.ts || p.timestamp;
      return ts >= this.startTime && ts <= this.endTime;
    });
  }

  /**
   * Fetch all settlements from Kalshi API (paginated)
   */
  async _getHistoricalSettlements() {
    const settlements = [];
    const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];

    for (const coin of coins) {
      try {
        // Fetch settled markets for this coin
        const url = `https://api.elections.kalshi.com/trade-api/v2/markets?status=settled&limit=100`;
        const response = await fetch(url, { timeout: 20000 });
        
        if (!response.ok) continue;
        
        const data = await response.json();
        const markets = (data.markets || []).filter(m => {
          // Match 15M markets for this coin
          return m.ticker && m.ticker.includes(coin) && m.ticker.includes('15M') && m.status === 'settled';
        });

        for (const market of markets) {
          const settleTime = market.close_time ? new Date(market.close_time).getTime() : null;
          
          // Only include settlements within our 2-day window
          if (settleTime && settleTime >= this.startTime && settleTime <= this.endTime) {
            settlements.push({
              source: 'kalshi',
              coin,
              ticker: market.ticker,
              outcome: (() => {
                const strike = String(market.strike_type ?? 'above').toLowerCase();
                const yesDir = strike === 'below' ? 'DOWN' : 'UP';
                const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
                return String(market.result).toUpperCase() === 'YES' ? yesDir : noDir;
              })(),
              strikeType: market.strike_type,
              settleTime,
              settleTimeIso: new Date(settleTime).toISOString(),
              marketPrice: market.last_price || null,
              strikePrice: market.strike_price || null
            });
          }
        }

        await this._delay(500); // Rate limit
      } catch (e) {
        console.warn(`   [Kalshi] Error fetching ${coin}:`, e.message);
      }
    }

    console.log(`   [Kalshi] ${settlements.length} settlements fetched`);
    return settlements;
  }

  /**
   * Correlate predictions with actual outcomes
   */
  async _correlateData(predictions, settlements) {
    const correlations = [];

    for (const pred of predictions) {
      const coin = pred.coin || pred.sym;
      const predTime = pred.ts || pred.timestamp;
      
      // Find settlement for this coin within ~1 hour of prediction
      const settlement = settlements.find(s => 
        s.coin === coin && 
        Math.abs(s.settleTime - predTime) < 60 * 60 * 1000
      );

      if (settlement) {
        const correct = pred.direction === settlement.outcome;
        
        correlations.push({
          coin,
          prediction: {
            direction: pred.direction,
            confidence: pred.confidence || 50,
            signals: pred.signals || {},
            timestamp: predTime,
            timeIso: new Date(predTime).toISOString()
          },
          settlement: {
            outcome: settlement.outcome,
            strikeType: settlement.strikeType,
            timestamp: settlement.settleTime,
            timeIso: settlement.settleTimeIso
          },
          correct,
          timeDiffMs: settlement.settleTime - predTime,
          timeDiffMins: Math.round((settlement.settleTime - predTime) / 60000)
        });
      }
    }

    console.log(`   ✓ Correlated ${correlations.length} predictions with outcomes`);
    return correlations;
  }

  /**
   * Calculate accuracy by coin, signal type, timeframe
   */
  async _calculateAccuracy(correlations) {
    // By Coin
    const byCoins = {};
    for (const corr of correlations) {
      if (!byCoins[corr.coin]) {
        byCoins[corr.coin] = { correct: 0, total: 0, predictions: [] };
      }
      byCoins[corr.coin].total++;
      if (corr.correct) byCoins[corr.coin].correct++;
      byCoins[corr.coin].predictions.push(corr);
    }

    for (const coin in byCoins) {
      const stats = byCoins[coin];
      stats.accuracy = (stats.correct / stats.total * 100).toFixed(2);
      stats.winRate = `${stats.accuracy}%`;
    }

    this.results.byCoins = byCoins;

    // By Signal Type
    const bySignals = {};
    for (const corr of correlations) {
      const signals = corr.prediction.signals || {};
      const signalNames = Object.keys(signals);
      
      for (const sig of signalNames) {
        if (!bySignals[sig]) {
          bySignals[sig] = { correct: 0, total: 0, confidence: [] };
        }
        bySignals[sig].total++;
        if (corr.correct) bySignals[sig].correct++;
        bySignals[sig].confidence.push(corr.prediction.confidence);
      }
    }

    for (const sig in bySignals) {
      const stats = bySignals[sig];
      stats.accuracy = (stats.correct / stats.total * 100).toFixed(2);
      stats.winRate = `${stats.accuracy}%`;
      stats.avgConfidence = (stats.confidence.reduce((a, b) => a + b, 0) / stats.confidence.length).toFixed(1);
    }

    this.results.bySignals = bySignals;

    // Summary
    const totalCorrect = correlations.filter(c => c.correct).length;
    const totalPredictions = correlations.length;
    const portfolioWR = (totalCorrect / totalPredictions * 100).toFixed(2);

    this.results.summary = {
      totalPredictions,
      totalCorrect,
      portfolioWR: `${portfolioWR}%`,
      accuracy: parseFloat(portfolioWR),
      correlations
    };

    console.log(`   ✓ Portfolio WR: ${portfolioWR}% (${totalCorrect}/${totalPredictions})`);
  }

  /**
   * Generate detailed analysis
   */
  async _generateAnalysis() {
    const { byCoins, bySignals, summary } = this.results;

    console.log('\n' + '═'.repeat(80));
    console.log('📊 ACCURACY BREAKDOWN');
    console.log('═'.repeat(80) + '\n');

    // By Coin
    console.log('PER-COIN ACCURACY:\n');
    console.table(
      Object.entries(byCoins).map(([coin, stats]) => ({
        Coin: coin,
        'Win Rate': stats.winRate,
        Correct: `${stats.correct}/${stats.total}`,
        Status: parseFloat(stats.accuracy) >= 55 ? '✅' : '⚠️ '
      }))
    );

    // By Signal
    console.log('\nSIGNAL PERFORMANCE:\n');
    console.table(
      Object.entries(bySignals)
        .sort((a, b) => parseFloat(b[1].accuracy) - parseFloat(a[1].accuracy))
        .slice(0, 10)
        .map(([signal, stats]) => ({
          Signal: signal,
          'Win Rate': stats.winRate,
          Uses: stats.total,
          'Avg Conf': `${stats.avgConfidence}%`,
          Status: parseFloat(stats.accuracy) >= 60 ? '✅' : '⚠️'
        }))
    );

    console.log('\n' + '═'.repeat(80));
    console.log('🎯 PORTFOLIO SUMMARY');
    console.log('═'.repeat(80) + '\n');
    console.log(`   Win Rate:        ${summary.portfolioWR}`);
    console.log(`   Predictions:     ${summary.totalPredictions}`);
    console.log(`   Correct:         ${summary.totalCorrect}`);
    console.log('\n');
  }

  /**
   * Identify tuning opportunities
   */
  async _identifyTuningOpportunities() {
    const { byCoins, bySignals, summary } = this.results;
    const opportunities = [];

    console.log('═'.repeat(80));
    console.log('🔧 TUNING OPPORTUNITIES');
    console.log('═'.repeat(80) + '\n');

    // Find underperforming coins
    for (const [coin, stats] of Object.entries(byCoins)) {
      const acc = parseFloat(stats.accuracy);
      if (acc < 45) {
        opportunities.push({
          type: 'DISABLE_COIN',
          coin,
          accuracy: acc,
          reason: `${coin} accuracy ${acc}% < 45% threshold`,
          recommendation: `Disable ${coin} or reduce position size`
        });
        console.log(`❌ ${coin}: ${acc}% accuracy (below 45% threshold)`);
        console.log(`   → Recommendation: Disable or reduce position size\n`);
      } else if (acc < 50) {
        opportunities.push({
          type: 'REDUCE_CONFIDENCE',
          coin,
          accuracy: acc,
          reason: `${coin} accuracy ${acc}% barely above 50%`,
          recommendation: `Require 70%+ confidence before trading ${coin}`
        });
        console.log(`⚠️  ${coin}: ${acc}% accuracy (marginal)`);
        console.log(`   → Recommendation: Raise confidence threshold to 70%\n`);
      } else if (acc > 60) {
        opportunities.push({
          type: 'INCREASE_SIZE',
          coin,
          accuracy: acc,
          reason: `${coin} accuracy ${acc}% > 60% threshold`,
          recommendation: `Increase position size for ${coin} (proven signal)`
        });
        console.log(`✅ ${coin}: ${acc}% accuracy (strong)`);
        console.log(`   → Recommendation: Increase position size\n`);
      }
    }

    // Find underperforming signals
    for (const [signal, stats] of Object.entries(bySignals)) {
      const acc = parseFloat(stats.accuracy);
      if (acc < 40) {
        opportunities.push({
          type: 'DISABLE_SIGNAL',
          signal,
          accuracy: acc,
          reason: `${signal} accuracy ${acc}% < 40% threshold`,
          recommendation: `Disable or reduce weight for ${signal}`
        });
      } else if (acc > 65) {
        opportunities.push({
          type: 'INCREASE_WEIGHT',
          signal,
          accuracy: acc,
          reason: `${signal} accuracy ${acc}% > 65% threshold`,
          recommendation: `Increase weight/confidence for ${signal}`
        });
      }
    }

    this.results.tuningOpportunities = opportunities;

    console.log('═'.repeat(80));
    console.log(`💡 Found ${opportunities.length} tuning opportunities\n`);

    // Group by type
    const byType = {};
    for (const opp of opportunities) {
      if (!byType[opp.type]) byType[opp.type] = [];
      byType[opp.type].push(opp);
    }

    for (const [type, opps] of Object.entries(byType)) {
      console.log(`${type} (${opps.length}):`);
      for (const opp of opps) {
        console.log(`  • ${opp.coin || opp.signal}: ${opp.accuracy}% → ${opp.recommendation}`);
      }
      console.log('');
    }

    console.log('═'.repeat(80) + '\n');
  }

  /**
   * Utility: delay for rate limiting
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Export results
   */
  getResults() {
    return this.results;
  }

  printSummary() {
    const { byCoins, summary, tuningOpportunities } = this.results;
    
    console.log('\n' + '='.repeat(80));
    console.log('📋 BACKTEST SUMMARY');
    console.log('='.repeat(80) + '\n');
    
    console.log(`Portfolio Win Rate: ${summary.portfolioWR}`);
    console.log(`Total Predictions: ${summary.totalPredictions}`);
    console.log(`Correct: ${summary.totalCorrect}`);
    
    console.log('\nTop Performers:');
    Object.entries(byCoins)
      .sort((a, b) => parseFloat(b[1].accuracy) - parseFloat(a[1].accuracy))
      .slice(0, 3)
      .forEach(([coin, stats]) => {
        console.log(`  ✅ ${coin}: ${stats.winRate} (${stats.correct}/${stats.total})`);
      });
    
    console.log('\nNeeds Improvement:');
    Object.entries(byCoins)
      .sort((a, b) => parseFloat(a[1].accuracy) - parseFloat(b[1].accuracy))
      .slice(0, 3)
      .forEach(([coin, stats]) => {
        console.log(`  ⚠️  ${coin}: ${stats.winRate} (${stats.correct}/${stats.total})`);
      });
    
    console.log(`\nTuning Opportunities: ${tuningOpportunities.length}`);
    console.log('='.repeat(80) + '\n');
  }
}

// Export for browser console
window.BacktestAnalyzer = BacktestAnalyzer;

// Auto-run if in browser context
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  console.log('[BacktestAnalyzer] Ready. Run: await window.BacktestAnalyzer.run()');
}
