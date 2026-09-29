/**
 * ================================================================
 * Real-Time Tuner — Sub-Minute Adaptive Corrections
 * 
 * Polls every 30 seconds, makes decisions within 60 seconds
 * Monitors: Live predictions, Kalshi trades, indicator performance
 * Adjusts: minAbsScore (gates), indicator weights, market regime
 * 
 * Goal: Catch and correct errors before they compound
 * ================================================================
 */

class RealTimeTuner {
  constructor() {
    this.lastPollTime = Date.now();
    this.pollInterval = 30 * 1000; // 30 seconds
    this.decisionWindow = 60 * 1000; // 60 seconds (2 polls)
    
    // Rapid tuning state
    this.recentTrades = {}; // Last 60s trades per coin
    this.recentIndicators = {}; // Last 60s indicator performance
    this.recentFailures = {}; // Kalshi failures in last 60s
    
    // Gate adjustment tracking
    this.gateAdjustments = {}; // Recent gate changes
    this.weightAdjustments = {}; // Recent weight changes
    this.decisionHistory = []; // Last 20 decisions
    this.enforceMonotonicImprovement = false; // keep polls independent by default
    this.lastAcceptedWinRate = null;
    this.lastAcceptedSnapshot = null;
    this.minMonotonicDelta = 0.10; // require at least 0.10pp non-regression tolerance
    
    // Real-time metrics
    this.pollCount = 0;
    this.decisionsApplied = 0;
    this.emergencyTriggers = 0;
    
    // Thresholds for rapid correction
    this.thresholds = {
      rapidFailureRate: 0.70, // 70%+ = EMERGENCY tighten
      rapidGoodWR: 0.55,      // >55% = upweight indicator
      rapidBadWR: 0.35,       // <35% = aggressive downweight
      emergencyAccuracy: 0.40, // <40% portfolio = reset
      minSamplesForDecision: 3, // At least 3 trades to react
    };
    
    console.log('[RealTimeTuner] Initialized for 30s polling + 60s decisions');
  }

  /**
   * Poll real-time data every 30 seconds
   * Captures: New predictions, Kalshi results, live trades
   */
  pollRealtimeData() {
    try {
      const now = Date.now();
      const window60s = now - this.decisionWindow;
      
      // Step 1: Capture recent predictions from window._predictions
      const recentPredictions = this.captureRecentPredictions(window60s, now);
      
      // Step 2: Capture Kalshi trade results
      const recentKalshiTrades = this.captureKalshiTrades(window60s, now);
      
      // Step 3: Calculate real-time accuracy
      const accuracy = this.calculateRealtimeAccuracy(recentPredictions);
      
      // Step 4: Analyze indicator performance in real-time
      const indicatorPerformance = this.analyzeIndicatorsRealtimeWindow(recentPredictions);
      
      // Step 5: Detect Kalshi failure spikes
      const failureSpike = this.detectFailureSpike(recentKalshiTrades);
      
      this.pollCount++;
      
      return {
        timestamp: now,
        poll: this.pollCount,
        recentPredictions,
        recentKalshiTrades,
        accuracy,
        indicatorPerformance,
        failureSpike,
        ready: recentPredictions.length >= this.thresholds.minSamplesForDecision
      };
    } catch (err) {
      console.error('[RealTimeTuner] Poll error:', err.message);
      return null;
    }
  }

  /**
   * Capture predictions from last 60 seconds
   */
  captureRecentPredictions(start, end) {
    try {
      const trades = [];
      const coins = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'HYPE'];
      
      for (const coin of coins) {
        if (!window._predictions || !window._predictions[coin]) continue;
        
        const coinTrades = Array.isArray(window._predictions[coin])
          ? window._predictions[coin]
          : Object.values(window._predictions[coin] || {});
        
        coinTrades.forEach(trade => {
          if (trade.timestamp >= start && trade.timestamp <= end) {
            trades.push({
              timestamp: trade.timestamp,
              coin,
              horizon: trade.horizon || 'h15',
              score: trade.score || 0,
              prediction: trade.prediction,
              actual: trade.actual,
              correct: trade.prediction === trade.actual,
              indicators: trade.indicators || {},
            });
          }
        });
      }
      
      return trades;
    } catch (err) {
      console.warn('[RealTimeTuner] Error capturing predictions:', err.message);
      return [];
    }
  }

  /**
   * Capture Kalshi trade results from last 60 seconds
   */
  captureKalshiTrades(start, end) {
    try {
      if (!window._kalshiRecentTrades) return [];
      
      return window._kalshiRecentTrades.filter(t => 
        t.timestamp >= start && t.timestamp <= end
      );
    } catch (err) {
      console.warn('[RealTimeTuner] Error capturing Kalshi trades:', err.message);
      return [];
    }
  }

  /**
   * Calculate real-time accuracy from last 60s predictions
   */
  calculateRealtimeAccuracy(trades) {
    const byCoins = {};
    
    trades.forEach(t => {
      if (!byCoins[t.coin]) {
        byCoins[t.coin] = { total: 0, wins: 0, winRate: 0 };
      }
      byCoins[t.coin].total++;
      if (t.correct) byCoins[t.coin].wins++;
    });
    
    // Calculate win rates
    Object.keys(byCoins).forEach(coin => {
      if (byCoins[coin].total > 0) {
        byCoins[coin].winRate = (byCoins[coin].wins / byCoins[coin].total) * 100;
      }
    });
    
    const portfolioTotal = trades.length;
    const portfolioWins = trades.filter(t => t.correct).length;
    
    return {
      portfolio: {
        total: portfolioTotal,
        wins: portfolioWins,
        winRate: portfolioTotal > 0 ? (portfolioWins / portfolioTotal) * 100 : 0
      },
      byCoins
    };
  }

  /**
   * Analyze indicator performance in 60s window
   */
  analyzeIndicatorsRealtimeWindow(trades) {
    const indicatorStats = {};
    
    trades.forEach(trade => {
      if (!trade.indicators || typeof trade.indicators !== 'object') return;
      
      Object.entries(trade.indicators).forEach(([indName, indData]) => {
        if (!indicatorStats[indName]) {
          indicatorStats[indName] = { total: 0, wins: 0, winRate: 0 };
        }
        indicatorStats[indName].total++;
        if (trade.correct) indicatorStats[indName].wins++;
      });
    });
    
    // Calculate win rates
    Object.keys(indicatorStats).forEach(ind => {
      if (indicatorStats[ind].total > 0) {
        indicatorStats[ind].winRate = 
          (indicatorStats[ind].wins / indicatorStats[ind].total) * 100;
      }
    });
    
    return indicatorStats;
  }

  /**
   * Detect Kalshi failure spike (>70% recent failures)
   */
  detectFailureSpike(kalshiTrades) {
    if (kalshiTrades.length === 0) return null;
    
    const losses = kalshiTrades.filter(t => t.result === 'LOSS').length;
    const failureRate = losses / kalshiTrades.length;
    
    return {
      total: kalshiTrades.length,
      losses,
      failureRate,
      emergency: failureRate > this.thresholds.rapidFailureRate,
      level: failureRate > 0.70 ? 'CRITICAL' : failureRate > 0.60 ? 'SEVERE' : 'ALERT'
    };
  }

  /**
   * Make rapid correction decisions every 60 seconds
   */
  makeRapidDecisions(pollData) {
    try {
      if (!pollData || !pollData.ready) {
        return { status: 'waiting', reason: 'insufficient_data' };
      }

      const decisions = {
        timestamp: Date.now(),
        baselinePortfolioWinRate: Number(pollData?.accuracy?.portfolio?.winRate || 0),
        gateAdjustments: {},
        weightAdjustments: {},
        marketRegimeChange: null,
        emergencyActions: [],
      };

      // DECISION 1: Emergency correction if accuracy collapsed
      if (pollData.accuracy.portfolio.winRate < this.thresholds.emergencyAccuracy) {
        decisions.emergencyActions.push({
          action: 'EMERGENCY_RESET',
          reason: `Portfolio accuracy ${pollData.accuracy.portfolio.winRate.toFixed(1)}% < 40%`,
          severity: 'CRITICAL'
        });
        this.emergencyTriggers++;
      }

      // DECISION 2: Rapid gate tightening if Kalshi shows failure spike
      if (pollData.failureSpike && pollData.failureSpike.emergency) {
        const coins = Object.keys(pollData.accuracy.byCoins);
        coins.forEach(coin => {
          decisions.gateAdjustments[coin] = {
            action: 'EMERGENCY_TIGHTEN',
            adjustment: +0.08,
            reason: `${pollData.failureSpike.level}: ${(pollData.failureSpike.failureRate * 100).toFixed(0)}% failure rate`,
            expectedEffect: 'Fewer signals, error prevention'
          };
        });
      }

      // DECISION 3: Per-indicator rapid weight adjustment
      Object.entries(pollData.indicatorPerformance).forEach(([ind, stats]) => {
        if (stats.total < 3) return; // Need at least 3 samples
        
        if (stats.winRate > this.thresholds.rapidGoodWR) {
          decisions.weightAdjustments[ind] = {
            action: 'UPWEIGHT_RAPID',
            currentWR: stats.winRate.toFixed(1) + '%',
            adjustment: '+8%',
            rationale: 'Strong performance in real-time window'
          };
        } else if (stats.winRate < this.thresholds.rapidBadWR) {
          decisions.weightAdjustments[ind] = {
            action: 'DOWNWEIGHT_AGGRESSIVE',
            currentWR: stats.winRate.toFixed(1) + '%',
            adjustment: '-15%',
            rationale: 'Systematically failing - reduce influence immediately'
          };
        }
      });

      // DECISION 4: Per-coin gate adjustment if WR <45%
      Object.entries(pollData.accuracy.byCoins).forEach(([coin, stats]) => {
        if (stats.total < 3) return;
        
        if (stats.winRate < 45 && !decisions.gateAdjustments[coin]) {
          decisions.gateAdjustments[coin] = {
            action: 'TIGHTEN_RAPID',
            adjustment: '+0.04',
            reason: `Real-time: ${stats.winRate.toFixed(1)}% accuracy (${stats.wins}/${stats.total})`,
            expectedEffect: 'Higher bar for signal entry'
          };
        }
      });

      // Record decision
      this.decisionHistory.push(decisions);
      if (this.decisionHistory.length > 20) {
        this.decisionHistory = this.decisionHistory.slice(-20);
      }

      if (Object.keys(decisions.gateAdjustments).length > 0 || 
          Object.keys(decisions.weightAdjustments).length > 0 ||
          decisions.emergencyActions.length > 0) {
        this.decisionsApplied++;
      }

      return decisions;
    } catch (err) {
      console.error('[RealTimeTuner] Decision error:', err.message);
      return null;
    }
  }

  /**
   * Apply decisions to live tuning systems
   */
  applyDecisions(decisions, adaptiveEngine) {
    try {
      if (!decisions || decisions.status === 'waiting') return;

      const applied = {
        timestamp: Date.now(),
        gatesUpdated: 0,
        weightsUpdated: 0,
        emergencyTriggered: false,
        monotonicGuard: { blocked: false, rolledBack: false, reason: '' },
      };

      const snapshotState = () => {
        return {
          gates: adaptiveEngine?.tuner?.currentGates
            ? JSON.parse(JSON.stringify(adaptiveEngine.tuner.currentGates))
            : null,
          weights: adaptiveEngine?.snapshotTuner?.currentCompositeWeights
            ? JSON.parse(JSON.stringify(adaptiveEngine.snapshotTuner.currentCompositeWeights))
            : null,
        };
      };
      const restoreState = (snapshot) => {
        if (!snapshot) return false;
        if (snapshot.gates && adaptiveEngine?.tuner?.currentGates) {
          adaptiveEngine.tuner.currentGates = JSON.parse(JSON.stringify(snapshot.gates));
        }
        if (snapshot.weights && adaptiveEngine?.snapshotTuner?.currentCompositeWeights) {
          adaptiveEngine.snapshotTuner.currentCompositeWeights = JSON.parse(JSON.stringify(snapshot.weights));
        }
        return true;
      };

      const baselineWR = Number(decisions?.baselinePortfolioWinRate);
      const hasBaseline = Number.isFinite(baselineWR);
      if (this.enforceMonotonicImprovement && hasBaseline && this.lastAcceptedWinRate !== null) {
        const regressed = baselineWR + this.minMonotonicDelta < this.lastAcceptedWinRate;
        if (regressed && decisions.emergencyActions.length === 0) {
          const restored = restoreState(this.lastAcceptedSnapshot);
          applied.monotonicGuard = {
            blocked: true,
            rolledBack: !!restored,
            reason: `Blocked adjustment: WR ${baselineWR.toFixed(2)}% < last accepted ${this.lastAcceptedWinRate.toFixed(2)}%`,
          };
          console.warn(`[RealTimeTuner] ${applied.monotonicGuard.reason}`);
          return applied;
        }
      }

      // Apply emergency actions
      if (decisions.emergencyActions.length > 0) {
        console.error('[RealTimeTuner] 🚨 EMERGENCY ACTION TRIGGERED:');
        decisions.emergencyActions.forEach(action => {
          console.error(`  ${action.action}: ${action.reason}`);
        });
        applied.emergencyTriggered = true;
        
        // Reset adaptive tuner to baseline
        if (adaptiveEngine && adaptiveEngine.tuner) {
          adaptiveEngine.tuner.resetToBaseline();
        }
      }

      // Apply gate adjustments
      Object.entries(decisions.gateAdjustments).forEach(([coin, adj]) => {
        if (adaptiveEngine && adaptiveEngine.tuner && adaptiveEngine.tuner.currentGates) {
          const oldGate = Number(adaptiveEngine.tuner.currentGates[coin]);
          if (!Number.isFinite(oldGate) || oldGate <= 0) return;
          const newGate = oldGate + (adj.adjustment / 100 * oldGate); // Apply as percentage
          
          // Respect bounds
          const bounds = adaptiveEngine.tuner.tuneBounds[coin];
          const finalGate = Math.min(bounds.max, Math.max(bounds.min, newGate));
          
          adaptiveEngine.tuner.currentGates[coin] = finalGate;
          applied.gatesUpdated++;
          
          console.log(`[RealTime] Gate: ${coin} ${oldGate.toFixed(2)} → ${finalGate.toFixed(2)} (${adj.action})`);
        }
      });

      // Apply weight adjustments
      Object.entries(decisions.weightAdjustments).forEach(([ind, adj]) => {
        if (adaptiveEngine && adaptiveEngine.snapshotTuner) {
          const baseline = adaptiveEngine.snapshotTuner.baselineCompositeWeights[ind];
          const current = adaptiveEngine.snapshotTuner.currentCompositeWeights[ind];
          if (!Number.isFinite(baseline) || !Number.isFinite(current)) return;
          
          let newWeight;
          if (adj.action === 'UPWEIGHT_RAPID') {
            newWeight = Math.min(baseline * 1.15, current + baseline * 0.08);
          } else if (adj.action === 'DOWNWEIGHT_AGGRESSIVE') {
            newWeight = Math.max(baseline * 0.60, current - baseline * 0.15);
          }
          if (!Number.isFinite(newWeight)) return;
          
          adaptiveEngine.snapshotTuner.currentCompositeWeights[ind] = newWeight;
          applied.weightsUpdated++;
          
          console.log(`[RealTime] Weight: ${ind} ${current.toFixed(4)} → ${newWeight.toFixed(4)} (${adj.action})`);
        }
      });

      if (this.enforceMonotonicImprovement && hasBaseline) {
        this.lastAcceptedWinRate = this.lastAcceptedWinRate === null
          ? baselineWR
          : Math.max(this.lastAcceptedWinRate, baselineWR);
        this.lastAcceptedSnapshot = snapshotState();
      }

      return applied;
    } catch (err) {
      console.error('[RealTimeTuner] Apply error:', err.message);
      return null;
    }
  }

  /**
   * Get real-time status
   */
  getStatus() {
    return {
      pollCount: this.pollCount,
      decisionsApplied: this.decisionsApplied,
      emergencyTriggers: this.emergencyTriggers,
      lastDecisions: this.decisionHistory.slice(-3),
      decisionFrequency: `${this.decisionsApplied} decisions in ${this.pollCount} polls = ${(this.decisionsApplied / this.pollCount * 100).toFixed(1)}% decision rate`
    };
  }

  /**
   * Get diagnostics for debugging
   */
  getDiagnostics() {
    return {
      pollInterval: this.pollInterval,
      decisionWindow: this.decisionWindow,
      thresholds: this.thresholds,
      status: this.getStatus(),
      recentHistory: this.decisionHistory.slice(-10)
    };
  }

  /**
   * Reset to baseline (emergency only)
   */
  reset() {
    this.recentTrades = {};
    this.recentIndicators = {};
    this.recentFailures = {};
    this.decisionHistory = [];
    console.log('[RealTimeTuner] Reset complete');
  }
}

// Export for Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RealTimeTuner;
}
