/**
 * WecryptoExchangeMonitor - Dynamic Exchange Anomaly Monitor
 * Evaluates real-time aggregated exchange data against rolling statistical baselines
 * to trigger priority elevation during market anomalies.
 */
class ExchangeAnomalyMonitor {
  /**
   * @param {string} instrumentName - The symbol or name of the instrument (e.g. BTC)
   * @param {number} windowSize - Number of periods for rolling baselines
   */
  constructor(instrumentName, windowSize = 20) {
    this.instrumentName = instrumentName;
    this.windowSize = windowSize;

    // Rolling windows for baseline calculations
    this.volumeHistory = [];
    this.volatilityHistory = [];
    this.liquidityHistory = [];

    // Previous price state for True Range (volatility) calculation
    this.prevClose = null;
  }

  /**
   * Calculates how many standard deviations a value is from the moving average.
   * @param {number} currentValue 
   * @param {number[]} history 
   * @returns {number} Z-Score
   */
  _calculateZScore(currentValue, history) {
    if (history.length < 2) {
      return 0.0;
    }
    const sum = history.reduce((a, b) => a + b, 0);
    const mean = sum / history.length;
    
    const squaredDiffs = history.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / history.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) {
      return 0.0;
    }
    return (currentValue - mean) / stdDev;
  }

  /**
   * Feeds new aggregated data into the rolling windows and evaluates alert thresholds.
   * @param {number} currentPrice - Current VWM or TWAP price
   * @param {number} ask - Top of book ask across exchanges
   * @param {number} bid - Top of book bid across exchanges
   * @param {number} currentVolume - Total volume
   * @param {number} currentLiquidity - Proxy for liquidity (e.g., 1 / spread, or depth)
   * @returns {{ elevatePriority: boolean, alerts: string[] }}
   */
  updateAndCheck(currentPrice, ask, bid, currentVolume, currentLiquidity) {
    let elevatePriority = false;
    const alerts = [];

    // Safety checks
    if (!currentPrice || !ask || !bid || currentVolume == null) {
      return { elevatePriority, alerts };
    }

    // 1. Volatility Assessment (True Range proxy using top of book spread & prev close)
    let trueRange = Math.max(0, ask - bid);
    if (this.prevClose !== null) {
      trueRange = Math.max(
        trueRange,
        Math.abs(ask - this.prevClose),
        Math.abs(bid - this.prevClose)
      );
    }

    const volatilityZ = this._calculateZScore(trueRange, this.volatilityHistory);
    // Threshold: > 3 Standard Deviations
    if (volatilityZ > 3.0) {
      elevatePriority = true;
      alerts.push(`Volatility Spike (Z-Score: ${volatilityZ.toFixed(2)})`);
    }

    // 2. Volume Spike Assessment
    const volumeZ = this._calculateZScore(currentVolume, this.volumeHistory);
    // Threshold: > 2.5 Standard Deviations
    if (volumeZ > 2.5) {
      elevatePriority = true;
      alerts.push(`Volume Spike (Z-Score: ${volumeZ.toFixed(2)})`);
    }

    // 3. Liquidity Drop Assessment
    if (this.liquidityHistory.length > 0 && currentLiquidity !== null) {
      const avgLiquidity = this.liquidityHistory.reduce((a, b) => a + b, 0) / this.liquidityHistory.length;
      if (avgLiquidity > 0) {
        const liquidityDropPct = (avgLiquidity - currentLiquidity) / avgLiquidity;
        // Threshold: > 15% drop from the rolling average
        if (liquidityDropPct > 0.15) {
          elevatePriority = true;
          alerts.push(`Liquidity Drop (${(liquidityDropPct * 100).toFixed(1)}%)`);
        }
      }
    }

    // Update histories for the next cycle
    this.volatilityHistory.push(trueRange);
    if (this.volatilityHistory.length > this.windowSize) {
      this.volatilityHistory.shift();
    }

    this.volumeHistory.push(currentVolume);
    if (this.volumeHistory.length > this.windowSize) {
      this.volumeHistory.shift();
    }

    if (currentLiquidity !== null) {
      this.liquidityHistory.push(currentLiquidity);
      if (this.liquidityHistory.length > this.windowSize) {
        this.liquidityHistory.shift();
      }
    }

    this.prevClose = currentPrice;

    return { elevatePriority, alerts };
  }
}

// Export for node or browser environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExchangeAnomalyMonitor };
} else if (typeof window !== 'undefined') {
  window.ExchangeAnomalyMonitor = ExchangeAnomalyMonitor;
}
