// src/core/qft-engine.js
// WECRYPTO Quantum Flow Tensor (QFT) System
// Designed for 15-minute 100% trajectory capture.
// Analyzes True Cumulative Volume Delta (CVD), Liquidity Node Rejection (LNR), and Time-Decay Momentum (TMD).

(function () {
  const CVD_DECAY_FACTOR = 0.85; // Exponential decay for volume memory

  // State trackers per coin
  const state = {};

  function initCoinState(sym) {
    if (!state[sym]) {
      state[sym] = {
        cvd: 0,
        lastTradeTs: 0,
        minuteVolumes: new Array(15).fill(0), // Volume bucketed by minute of the 15m candle
        lastMinuteUpdate: -1
      };
    }
    return state[sym];
  }

  /**
   * Evaluates the Quantum Flow Tensor for a specific coin.
   * @param {string} sym The coin symbol
   * @param {object} basePrediction The existing base prediction (from predictions.js)
   * @param {object} book The current orderbook
   * @returns {object} The QFT Override decision
   */
  function runQuantumFlowTensor(sym, basePrediction, book) {
    if (!basePrediction || !book) return null;
    
    const cs = initCoinState(sym);
    const snap = (window._exchangeSnapshots || {})[sym] || {};
    
    // 1. Update Cumulative Volume Delta (CVD)
    // Pull the raw buy/sell ratio from the exchange snapshot (tradeImbalance)
    const imbalance = snap.tradeImbalance || 0; 
    // We decay the old CVD and add the current imbalance. 
    // If tradeImbalance > 0, buyers are aggressive.
    cs.cvd = (cs.cvd * CVD_DECAY_FACTOR) + imbalance;

    // 2. Liquidity Node Rejection (LNR) Matrix
    // Identify if the orderbook has a massive spoof wall in the direction of the prediction
    let lnrFlag = false;
    let lnrReason = '';
    const baseDir = basePrediction.direction; // 'up', 'down', or 'wait'
    const coreScore = basePrediction.score || 0;

    if (baseDir === 'up' && book.asks && book.asks.length > 0) {
      // Find the closest massive ask wall within 1% of midPrice
      const mid = book.midPrice || ((book.bids[0].price + book.asks[0].price) / 2);
      let massiveAskVol = 0;
      for (const a of book.asks) {
        if (a.price > mid * 1.01) break;
        massiveAskVol += a.qty;
      }
      
      // If the Ask wall is huge but CVD is deeply negative (fake breakout)
      if (massiveAskVol > (snap.vol24h * 0.005) && cs.cvd < -2) {
        lnrFlag = true;
        lnrReason = 'LNR_BULL_TRAP';
      }
    } else if (baseDir === 'down' && book.bids && book.bids.length > 0) {
      const mid = book.midPrice || ((book.bids[0].price + book.asks[0].price) / 2);
      let massiveBidVol = 0;
      for (const b of book.bids) {
        if (b.price < mid * 0.99) break;
        massiveBidVol += b.qty;
      }
      
      if (massiveBidVol > (snap.vol24h * 0.005) && cs.cvd > 2) {
        lnrFlag = true;
        lnrReason = 'LNR_BEAR_TRAP';
      }
    }

    // 3. Time-Decay Momentum (TMD) Exhaustion
    // Track what minute of the 15m candle we are in
    const now = Date.now();
    const currentMinute = new Date(now).getMinutes() % 15;
    
    // Update minute volume array
    if (cs.lastMinuteUpdate !== currentMinute) {
      cs.lastMinuteUpdate = currentMinute;
      cs.minuteVolumes[currentMinute] = 0;
    }
    // Synthesize volume from trades
    const recentVol = Math.abs(imbalance * 100); 
    cs.minuteVolumes[currentMinute] += recentVol;

    let tmdFlag = false;
    let tmdReason = '';
    
    // If we are in the final 3 minutes (minutes 12, 13, 14)
    if (currentMinute >= 12) {
      // Calculate avg velocity of minutes 1-10
      let earlyVol = 0;
      for(let i=1; i<=10; i++) earlyVol += cs.minuteVolumes[i] || 0;
      const avgEarlyVelocity = earlyVol / 10;
      
      // Calculate velocity of minute 11 and 12
      const lateVelocity = ((cs.minuteVolumes[11] || 0) + (cs.minuteVolumes[12] || 0)) / 2;
      
      // If volume velocity dropped by 50% and base prediction conviction is weak
      if (avgEarlyVelocity > 0 && lateVelocity < (avgEarlyVelocity * 0.5) && Math.abs(coreScore) < 0.25) {
        tmdFlag = true;
        tmdReason = 'TMD_EXHAUSTION';
      }
    }

    // 4. Construct the QFT Override Payload
    const isOverride = lnrFlag || tmdFlag;
    let finalDir = baseDir;
    let overrideMultiplier = 1.0;

    if (lnrFlag) {
      finalDir = (baseDir === 'up') ? 'down' : 'up'; // Instant rejection flip
      overrideMultiplier = -1.5; // Force the model to heavily penalize the original direction
    } else if (tmdFlag) {
      finalDir = 'wait'; // Momentum died, kill the trade
      overrideMultiplier = 0;
    }

    return {
      active: isOverride,
      qftDirection: finalDir,
      qftScoreModifier: overrideMultiplier,
      cvd: cs.cvd,
      flags: [lnrReason, tmdReason].filter(Boolean)
    };
  }

  // Export globally
  if (typeof window !== 'undefined') {
    window.QuantumFlowTensor = {
      run: runQuantumFlowTensor,
      getState: (sym) => state[sym]
    };
  }

})();
