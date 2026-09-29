/**
 * PYTH Momentum Exit System
 * 
 * Detects momentum breaks in real-time (15-sec sampling)
 * Exits positions BEFORE reversals complete
 * 
 * Core logic:
 * 1. Track price samples every 15 sec (4 samples per minute)
 * 2. Calculate momentum = slope of recent samples
 * 3. Detect break = momentum reverses or flattens
 * 4. Exit immediately when break detected (min 2-3 samples)
 * 5. Don't hold to expiry; lock profits early
 */

(function() {
  'use strict';

  window.PYTHMomentumExit = window.PYTHMomentumExit || {};

  /**
   * Per-position tracker
   * key: marketId
   */
  const positions = {};

  /**
   * Initialize position tracker when order executes
   * 
   * @param {string} marketId - Polymarket market ID
   * @param {number} entryPrice - CFM price at entry (0-100)
   * @param {string} direction - 'YES' or 'NO'
   * @param {number} quantity - contracts
   * @param {number} confidence - model confidence 0-100
   */
  function initPosition(marketId, entryPrice, direction, quantity, confidence) {
    const now = Date.now();
    
    positions[marketId] = {
      marketId,
      entryPrice,
      direction,
      quantity,
      confidence,
      enteredAt: now,
      
      // PYTH sample tracking
      samples: [
        { t: now, price: entryPrice, velocity: 0, acceleration: 0, state: 'ENTRY' }
      ],
      
      // Momentum state
      currentMomentum: 0,    // Slope of last 3 samples
      momentumBreak: false,  // Did momentum reverse?
      peakPrice: entryPrice, // Highest price seen (for reversal tracking)
      
      // Exit signals
      shouldExit: false,
      exitReason: null,
      exitPrice: null,
      exitAt: null,
      
      // Profitability
      maxProfit: 0,
      profitPercentage: 0
    };

    console.log(`[Position] ${marketId} opened: ${direction} @ ${entryPrice}, momentum tracking active`);
    return positions[marketId];
  }

  /**
   * Update position with new PYTH price sample
   * Called every 15 seconds
   * 
   * @param {string} marketId
   * @param {number} currentPrice - Current price from PYTH
   * @returns {object} position state
   */
  function updateMomentum(marketId, currentPrice) {
    const pos = positions[marketId];
    if (!pos) return null;

    const now = Date.now();
    const samples = pos.samples;
    const prevSample = samples[samples.length - 1];
    
    // Calculate velocity (price change rate)
    const velocity = currentPrice - prevSample.price;
    
    // Calculate acceleration (velocity change)
    const acceleration = samples.length >= 2 
      ? velocity - (samples[samples.length - 1].velocity || 0)
      : 0;

    // Calculate momentum (slope of last 3 samples = direction consistency)
    let momentum = 0;
    if (samples.length >= 3) {
      const last3 = samples.slice(-3);
      const p1 = last3[0].price;
      const p2 = last3[1].price;
      const p3 = last3[2].price;
      
      // Momentum = (latest - oldest) / 2 samples
      // Positive = consistent move in direction
      // Negative = reversal starting
      momentum = (p3 - p1) / 2;
    } else {
      momentum = velocity;
    }

    // Update peak price (for profit tracking)
    pos.peakPrice = Math.max(pos.peakPrice, currentPrice);

    // Calculate current profit %
    const priceMove = currentPrice - pos.entryPrice;
    const moveInDirection = pos.direction === 'YES' ? priceMove : -priceMove;
    pos.profitPercentage = (moveInDirection / pos.entryPrice) * 100;
    pos.maxProfit = Math.max(pos.maxProfit, moveInDirection);

    // Add sample
    const sample = {
      t: now,
      price: currentPrice,
      velocity,
      acceleration,
      momentum,
      state: 'TRACKING'
    };
    samples.push(sample);

    pos.currentMomentum = momentum;

    // ========== HARDENED EXIT LOGIC ==========
    // FIX: Avoid false reversals from wicks/spikes
    
    // 1. MOMENTUM BREAK DETECTION (STRENGTHENED)
    // Require 2+ consecutive samples confirming break (not just 1 spike)
    // Use tighter threshold (-1.0 instead of -0.5) to filter noise
    if (samples.length >= 5) {
      const last5 = samples.slice(-5);
      const momenta = last5.map(s => s.momentum);
      
      // Check: was momentum positive, now 2+ consecutive negative?
      const wasPositive = momenta[2] > 0.5;  // Earlier momentum was bullish
      const isBroken1 = momenta[3] < -1.0;   // CONFIRMED BREAK (not -0.5)
      const isBroken2 = momenta[4] < -1.0;   // CONFIRMED with 2nd sample
      
      // Only signal break if BOTH conditions met (requires confirmation)
      if (wasPositive && isBroken1 && isBroken2) {
        pos.momentumBreak = true;
        pos.breakConfirmed = (pos.breakConfirmed || 0) + 1;
        console.log(`[Momentum] ${marketId} BREAK CONFIRMED (${pos.breakConfirmed}x): was ${momenta[2].toFixed(2)}, now ${momenta[4].toFixed(2)}`);
      } else if (isBroken1 && !isBroken2) {
        // First sign of break - don't exit yet, wait for confirmation
        pos.breakWarning = true;
      }
    }

    // 2. HARDENED PROFIT EXIT
    // Only exit if:
    //   a) Momentum break is CONFIRMED (2+ samples)
    //   b) Position is IN PROFIT (not breakeven or loss)
    //   c) Profit is meaningful (>0.5%, not micro-profits)
    if (pos.momentumBreak && (pos.breakConfirmed || 0) >= 2 && pos.profitPercentage > 0.5) {
      pos.shouldExit = true;
      pos.exitReason = 'momentum_break_confirmed';
      pos.exitPrice = currentPrice;
      pos.exitAt = now;
      console.log(`[Exit] ${marketId} CONFIRMED BREAK (2x) → locking ${pos.profitPercentage.toFixed(2)}% profit`);
      return pos;
    }

    // 2b. SKIP FALSE BREAKS IF UNDERWATER
    // If momentum shows break but position is in LOSS, hold through it
    // (It's probably just a wick/spike, not a real reversal)
    if (pos.breakWarning && pos.profitPercentage < 0) {
      pos.breakWarning = false;  // Reset; this was noise
      console.log(`[Hold] ${marketId} momentum noise detected (wick), position underwater, holding...`);
    }

    // 3. AGGRESSIVE STOP-LOSS TRIGGER
    // If reversal is severe (-3%+), cut losses immediately (don't wait for break confirmation)
    if (pos.profitPercentage < -3) {
      pos.shouldExit = true;
      pos.exitReason = 'stop_loss_severe';
      pos.exitPrice = currentPrice;
      pos.exitAt = now;
      console.log(`[Exit] ${marketId} SEVERE STOP-LOSS at ${pos.profitPercentage.toFixed(2)}%`);
      return pos;
    }

    // 3b. SOFT STOP-LOSS (hold longer)
    // If -1% to -3%, log it but don't exit yet (might recover)
    if (pos.profitPercentage < -1 && pos.profitPercentage >= -3) {
      if (!pos.stopLossWarningAt) {
        pos.stopLossWarningAt = now;
        console.log(`[Warning] ${marketId} approaching stop-loss: ${pos.profitPercentage.toFixed(2)}%`);
      }
    }

    // 4. TIMEOUT EXIT (hold-too-long safeguard)
    // If position is open 3+ minutes with no clear profit, exit
    const elapsedSec = (now - pos.enteredAt) / 1000;
    if (elapsedSec > 180 && samples.length >= 12 && pos.profitPercentage < 1) {
      pos.shouldExit = true;
      pos.exitReason = 'timeout_no_profit';
      pos.exitPrice = currentPrice;
      pos.exitAt = now;
      console.log(`[Exit] ${marketId} TIMEOUT (3+ min) with low profit: ${pos.profitPercentage.toFixed(2)}%`);
      return pos;
    }

    return pos;
  }

  /**
   * Get position state
   */
  function getPosition(marketId) {
    return positions[marketId];
  }

  /**
   * Check if position should exit
   */
  function shouldExit(marketId) {
    const pos = positions[marketId];
    return pos && pos.shouldExit;
  }

  /**
   * Execute exit and clean up
   */
  function exitPosition(marketId) {
    const pos = positions[marketId];
    if (!pos) return null;

    const result = {
      marketId,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice: pos.exitPrice,
      exitReason: pos.exitReason,
      profitPercentage: pos.profitPercentage,
      samples: pos.samples.length,
      elapsedSeconds: (pos.exitAt - pos.enteredAt) / 1000,
      success: pos.exitReason === 'momentum_break_with_profit' || pos.profitPercentage > 0
    };

    console.log(`[Exited] ${marketId}: ${result.exitReason}, ${result.profitPercentage.toFixed(2)}% (${result.samples} samples, ${result.elapsedSeconds.toFixed(1)}s)`);

    delete positions[marketId];
    return result;
  }

  /**
   * Get all active positions (for monitoring)
   */
  function getAllPositions() {
    return positions;
  }

  /**
   * Render position status (for UI diagnostics)
   */
  function getStatusHTML() {
    let html = `<div style="font-family: monospace; font-size: 11px;">`;
    
    for (const marketId in positions) {
      const pos = positions[marketId];
      const elapsed = ((Date.now() - pos.enteredAt) / 1000).toFixed(1);
      const momentumColor = pos.currentMomentum > 0.2 ? '#4caf50' : pos.currentMomentum > -0.2 ? '#ffc107' : '#f44336';
      const profitColor = pos.profitPercentage > 0 ? '#4caf50' : '#f44336';

      html += `
        <div style="background: rgba(255,255,255,0.05); padding: 6px; margin: 4px 0; border-radius: 3px;">
          <div style="font-weight: bold; margin-bottom: 3px;">${pos.direction} ${pos.quantity} @ ${pos.entryPrice}</div>
          <div style="color: #aaa; font-size: 10px;">
            Momentum: <span style="color: ${momentumColor};">${pos.currentMomentum.toFixed(3)}</span>
            | Profit: <span style="color: ${profitColor};">${pos.profitPercentage.toFixed(1)}%</span>
            | Samples: ${pos.samples.length}
            | Elapsed: ${elapsed}s
            ${pos.momentumBreak ? '<span style="color: #f44336; font-weight: bold;"> [BREAK]</span>' : ''}
            ${pos.shouldExit ? '<span style="color: #ffc107; font-weight: bold;"> [EXIT SIGNAL]</span>' : ''}
          </div>
        </div>
      `;
    }
    
    html += `</div>`;
    return html;
  }

  // Export API
  window.PYTHMomentumExit = {
    initPosition,
    updateMomentum,
    getPosition,
    shouldExit,
    exitPosition,
    getAllPositions,
    getStatusHTML
  };

  console.log('[PYTHMomentumExit] Loaded — momentum tracking active');
})();
