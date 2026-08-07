/**
 * ================================================================
 * Kalshi DEBUG LOG Parser & Trade Failure Analyzer
 * Reads Kalshi-Recent-Activity-All.csv for live trade validation
 * Feeds failure detection into adaptive learning module
 * ================================================================
 */

const fs = typeof require !== 'undefined' && require('fs') ? require('fs') : null;
const path = typeof require !== 'undefined' && require('path') ? require('path') : null;

// CSV parsing: Node.js uses built-in, browser uses manual parser
const parseCSV = (content) => {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  
  // Manual CSV parser (handles quoted fields)
  const parse = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result.map(f => f.replace(/^"|"$/g, ''));
  };
  
  const headers = parse(lines[0]);
  const records = lines.slice(1).map(line => {
    const values = parse(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = values[i] || '';
    });
    return obj;
  });
  
  return records;
};

class KalshiDebugLogParser {
  constructor(csvPath = null) {
    this.csvPath = csvPath || path.join(__dirname, '..', '..', 'Kalshi-Recent-Activity-All.csv');
    this.trades = [];
    this.lastParsedTime = null;
    this.failureThreshold = 0.55; // >55% failure rate triggers retuning
  }

  /**
   * Parse Kalshi CSV file and extract completed trades
   * Returns array of trade objects with standardized format
   */
  parseCSV() {
    try {
      if (!fs || !path) {
        console.warn('[KalshiParser] Node.js fs/path not available, skipping CSV parse');
        return [];
      }

      const csvPath = this.csvPath;
      if (!fs.existsSync(csvPath)) {
        console.warn(`[KalshiParser] CSV not found: ${csvPath}`);
        return [];
      }

      const fileContent = fs.readFileSync(csvPath, 'utf-8');
      const records = parseCSV(fileContent);

      // Filter for completed trades (not orders, have results)
      const trades = records
        .filter(r => r.type === 'Trade' && r.Status === 'Completed' && r.Result)
        .map(r => ({
          timestamp: new Date(r.Original_Date).getTime(),
          marketTicker: r.Market_Ticker,
          coin: this.extractCoin(r.Market_Ticker),
          direction: r.Direction?.toUpperCase() || '',
          result: r.Result?.toUpperCase() || '',
          profit: parseFloat(r.Profit_In_Dollars) || 0,
          amount: parseFloat(r.Amount_In_Dollars) || 0,
          contracts: {
            yes: parseFloat(r.Yes_Contracts_Owned) || 0,
            no: parseFloat(r.No_Contracts_Owned) || 0,
          },
          avgPrice: {
            yes: parseFloat(r.Yes_Contracts_Average_Price_In_Cents) || 0,
            no: parseFloat(r.No_Contracts_Average_Price_In_Cents) || 0,
          },
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

      this.trades = trades;
      this.lastParsedTime = Date.now();

      console.log(`[KalshiParser] Parsed ${trades.length} completed trades from Kalshi`);
      return trades;
    } catch (err) {
      console.error('[KalshiParser] Error parsing CSV:', err.message);
      return [];
    }
  }

  /**
   * Extract coin symbol from market ticker
   * Example: KXBTC15M-26APR261600-00 → BTC
   */
  extractCoin(ticker) {
    if (!ticker) return null;
    const str = String(ticker).toUpperCase();
    if (str.includes('BTC')) return 'BTC';
    if (str.includes('ETH')) return 'ETH';
    if (str.includes('SOL')) return 'SOL';
    if (str.includes('XRP')) return 'XRP';
    if (str.includes('DOGE')) return 'DOGE';
    if (str.includes('BNB')) return 'BNB';
    if (str.includes('HYPE')) return 'HYPE';
    const match = str.match(/KX([A-Z]+)/);
    return match ? match[1] : null;
  }

  /**
   * Analyze recent trades (last N minutes) by coin
   * Returns failure rate and statistics per coin
   */
  analyzeRecentFailures(minutesBack = 60) {
    const cutoffTime = Date.now() - minutesBack * 60 * 1000;
    const recentTrades = this.trades.filter(t => t.timestamp > cutoffTime);

    const analysis = {
      timewindow: { startTime: new Date(cutoffTime).toISOString(), endTime: new Date().toISOString(), minutes: minutesBack },
      totalTrades: recentTrades.length,
      byCoins: {},
    };

    // Group by coin
    const coinMap = {};
    recentTrades.forEach(t => {
      if (!t.coin) return;
      if (!coinMap[t.coin]) {
        coinMap[t.coin] = {
          coin: t.coin,
          trades: [],
          winCount: 0,
          lossCount: 0,
          totalProfit: 0,
        };
      }
      coinMap[t.coin].trades.push(t);
    });

    // Calculate metrics
    Object.entries(coinMap).forEach(([coin, data]) => {
      data.trades.forEach(t => {
        if (t.profit > 0.01) {
          data.winCount++;
        } else if (t.profit < -0.01) {
          data.lossCount++;
        }
        data.totalProfit += t.profit;
      });

      const total = data.trades.length;
      analysis.byCoins[coin] = {
        trades: total,
        wins: data.winCount,
        losses: data.lossCount,
        winRate: total > 0 ? (data.winCount / total * 100).toFixed(1) : 'N/A',
        failureRate: total > 0 ? (data.lossCount / total * 100).toFixed(1) : 'N/A',
        totalProfit: data.totalProfit.toFixed(2),
        profitPerTrade: (data.totalProfit / Math.max(1, total)).toFixed(4),
        isCritical: total >= 5 && (data.lossCount / total) > this.failureThreshold,
        needsRetune: total >= 3 && (data.lossCount / total) > 0.45, // Retune if >45% failure on ≥3 trades
      };
    });

    return analysis;
  }

  /**
   * Get trades for a specific coin in recent window
   */
  getTradesForCoin(coin, minutesBack = 60) {
    const cutoffTime = Date.now() - minutesBack * 60 * 1000;
    return this.trades.filter(t => t.coin === coin && t.timestamp > cutoffTime);
  }

  /**
   * Detect which coins need immediate retuning based on live failures
   */
  detectRetuningNeeds() {
    const needs = [];
    const analysis = this.analyzeRecentFailures(120); // Check last 2 hours

    Object.entries(analysis.byCoins).forEach(([coin, stats]) => {
      if (stats.isCritical) {
        needs.push({
          coin,
          reason: 'CRITICAL_FAILURE',
          failureRate: parseFloat(stats.failureRate),
          trades: stats.trades,
          action: 'TIGHTEN_IMMEDIATELY',
          severity: 'HIGH',
        });
      } else if (stats.needsRetune) {
        needs.push({
          coin,
          reason: 'HIGH_FAILURE_RATE',
          failureRate: parseFloat(stats.failureRate),
          trades: stats.trades,
          action: 'TIGHTEN',
          severity: 'MEDIUM',
        });
      }
    });

    return needs;
  }

  /**
   * Generate tuning recommendations for adaptive module
   */
  generateTuningRecommendations() {
    const recentFailures = this.analyzeRecentFailures(120);
    const recommendations = {
      timestamp: new Date().toISOString(),
      recommendedActions: [],
      summary: {
        totalCoinsAnalyzed: Object.keys(recentFailures.byCoins).length,
        coinsNeedingRetune: 0,
        coinsPerformingWell: 0,
      },
    };

    Object.entries(recentFailures.byCoins).forEach(([coin, stats]) => {
      if (stats.isCritical) {
        recommendations.recommendedActions.push({
          coin,
          action: 'AGGRESSIVE_TIGHTEN',
          targetAdjustment: +0.08,
          reason: `Critical failure rate: ${stats.failureRate}% on ${stats.trades} trades`,
          confidence: 'HIGH',
        });
        recommendations.summary.coinsNeedingRetune++;
      } else if (stats.needsRetune) {
        recommendations.recommendedActions.push({
          coin,
          action: 'MODERATE_TIGHTEN',
          targetAdjustment: +0.04,
          reason: `High failure rate: ${stats.failureRate}% on ${stats.trades} trades`,
          confidence: 'MEDIUM',
        });
        recommendations.summary.coinsNeedingRetune++;
      } else if (parseFloat(stats.failureRate) < 30) {
        recommendations.summary.coinsPerformingWell++;
      }
    });

    return recommendations;
  }

  /**
   * Export trade data to file for analysis
   */
  exportTrades(outputPath = null) {
    const path = outputPath || path.join(__dirname, 'kalshi-trade-export.json');
    fs.writeFileSync(path, JSON.stringify({
      exportTime: new Date().toISOString(),
      tradeCount: this.trades.length,
      trades: this.trades.slice(-100), // Last 100 trades
    }, null, 2));
    console.log(`[KalshiParser] Exported trades to ${path}`);
  }

  /**
   * Get recent trade log for debugging
   */
  getTradeLog(limit = 20) {
    return this.trades.slice(-limit).reverse().map(t => ({
      time: new Date(t.timestamp).toISOString(),
      coin: t.coin,
      ticker: t.marketTicker,
      direction: t.direction,
      result: t.result,
      profit: t.profit,
      winRate: t.profit > 0 ? '✓' : t.profit < 0 ? '✗' : '○',
    }));
  }
}

// Browser/Node compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = KalshiDebugLogParser;
}
