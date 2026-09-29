/**
 * Horizon-Locked Sniper Logic
 * Gates execution by demanding massive EV premiums early on,
 * decaying required edge toward baseline as expiry approaches.
 */
(function (root, factory) {
  const HorizonSniper = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HorizonSniper;
  } else {
    root.HorizonSniper = HorizonSniper;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class HorizonSniperLogic {
    constructor(maxWindowSeconds = 900) { // 15 minutes
      this.maxWindow = maxWindowSeconds;
      this.baseRequiredEv = 0.50; // At least 50% theoretical return at expiry
    }

    evaluateHorizonStrike(params = {}) {
      const {
        p_model,         // Model YES probability (0.0 to 1.0)
        orderBookAsks,   // Array of [price, qty] asks or numeric market price
        positionSize = 100, // Position size we want to execute (in contracts)
        tteSeconds = 900,  // Time to expiry in seconds
        spotVolatility = 0.1, // Volatility bps per sec or normalized value
      } = params;

      // 1. LIQUIDITY CHECK & TRUE MARKET PRICE
      let p_market = null;
      if (typeof orderBookAsks === 'number') {
        p_market = orderBookAsks;
      } else if (Array.isArray(orderBookAsks)) {
        p_market = this.calculateVwap(orderBookAsks, positionSize);
      }

      if (p_market === null || p_market <= 0 || p_market > 0.99) {
        return { action: 'SCOUT_WAIT', reward: 0.0, reason: 'invalid_price_or_illiquid' };
      }

      // 2. THE DYNAMIC HORIZON HURDLE
      const timeElapsedRatio = Math.max(0, Math.min(1, (this.maxWindow - tteSeconds) / this.maxWindow));
      const variancePremium = spotVolatility * Math.exp(-3.0 * timeElapsedRatio);
      const dynamicEvHurdle = this.baseRequiredEv + variancePremium;

      // 3. EXPECTED VALUE
      const ev = (p_model / p_market) - 1.0;

      // 4. HORIZON-LOCKED FILTER
      if (ev < dynamicEvHurdle) {
        return {
          action: 'SCOUT_WAIT',
          reward: 0.0,
          reason: `ev_below_hurdle:${ev.toFixed(3)}<${dynamicEvHurdle.toFixed(3)}`,
          p_market,
          ev,
          hurdle: dynamicEvHurdle
        };
      }

      // 5. EXECUTION SIGNAL
      const mispricingRatio = p_model / p_market;
      const horizonReward = ev * mispricingRatio * (1.0 + (1.0 - (tteSeconds / this.maxWindow)));

      return {
        action: 'EXECUTE_STRIKE',
        reward: horizonReward,
        p_market,
        ev,
        hurdle: dynamicEvHurdle,
      };
    }

    calculateVwap(asks, requiredSize) {
      if (!asks || !asks.length) return null;
      let filledSize = 0.0;
      let totalCost = 0.0;
      for (let i = 0; i < asks.length; i++) {
        const ask = asks[i];
        if (!Array.isArray(ask) || ask.length < 2) continue;
        const price = Number(ask[0]);
        const volume = Number(ask[1]);
        if (isNaN(price) || isNaN(volume) || price <= 0 || volume <= 0) continue;

        if (filledSize + volume >= requiredSize) {
          const remainingSize = requiredSize - filledSize;
          totalCost += remainingSize * price;
          return totalCost / requiredSize;
        }
        totalCost += volume * price;
        filledSize += volume;
      }
      return filledSize > 0 ? totalCost / filledSize : null;
    }
  }

  return {
    HorizonSniperLogic,
  };
}));
