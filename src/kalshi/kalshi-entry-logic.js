/**
 * CFM Divergence + Sustenance Entry Logic
 * 
 * NEW FRAMEWORK (replaces ionization shells for 15-min contracts):
 * 
 * 1. CFM vs Kalshi comparison → detect mispricing (edge)
 * 2. Monitor for 7 minutes → confirm sustenance (not a pump-dump)
 * 3. Only execute 15-min contracts with SUSTAINED directional moves
 * 4. Exit early if reversal detected
 */

(function() {
  'use strict';

  window.KalshiEntryLogic = window.KalshiEntryLogic || {};

  /**
   * Entry Thresholds (based on edge magnitude, not volatility)
   * 
   * Edge = |CFM price - Kalshi odds|
   * Larger edge = more mispricing = higher confidence
   * 
   * RETUNED 2026-05-02: Per-coin edge minimums to align with shell activation rates
   */
  // ALWAYS_TRADE: tiny edges so almost every contract is executable.
  const EDGE_THRESHOLDS = {
    MIN_EDGE_TO_WATCH: 0.005,     // 0.5¢ — start tracking immediately
    MIN_EDGE_TO_EXECUTE: 0.01,    // 1¢ baseline
    
    PER_COIN_MINIMUMS: {
      DOGE: 0.005,
      ETH:  0.01,
      HYPE: 0.01,
      BTC:  0.01,
      BNB:  0.01,
      XRP:  0.01,
      SOL:  0.01,
    },
    
    CONFIDENCE_TIERS: [
      { edge: 0.15, confidence: 0.90 },
      { edge: 0.10, confidence: 0.80 },
      { edge: 0.07, confidence: 0.70 },
      { edge: 0.05, confidence: 0.60 },
      { edge: 0.02, confidence: 0.55 },
      { edge: 0.01, confidence: 0.52 },
    ]
  };

  /**
   * Per-coin policy from predictions.js (window.TRADING_POLICY).
   * Used for minEdge, paper-only, and hard trade disables outside ALWAYS_TRADE.
   */
  function getTradingPolicy(coin) {
    try {
      const table = (typeof window !== 'undefined' && window.TRADING_POLICY) || null;
      if (!table || typeof table !== 'object') return null;
      const key = String(coin || '').toUpperCase();
      return table[key] || table[coin] || null;
    } catch (_) {
      return null;
    }
  }

  function isAlwaysTradeMode() {
    return typeof window !== 'undefined' && !!window.ALWAYS_TRADE_MODE;
  }

  /**
   * Calculate directional signal from CFM vs Kalshi divergence
   * 
   * @param {object} cfmData - { price: number (0-100) }
   * @param {object} kalshiData - { odds: number (0-100) }
   * @param {string} coin - ticker (BTC, ETH, SOL, etc) for per-coin edge thresholds
   * @returns {object} signal
   */
  function analyzeDivergence(cfmData, kalshiData, coin = 'BTC') {
    const cfm = cfmData.price;      // 0-100 probability
    const kalshi = kalshiData.odds; // 0-100 probability
    const policy = getTradingPolicy(coin);
    const alwaysTrade = isAlwaysTradeMode();
    
    const edge = Math.abs(cfm - kalshi) / 100; // Edge in cents (0-1.0)
    const policyMin = (policy && Number.isFinite(Number(policy.minEdge)))
      ? Number(policy.minEdge)
      : null;
    const minEdge = policyMin != null
      ? policyMin
      : (EDGE_THRESHOLDS.PER_COIN_MINIMUMS[coin] || EDGE_THRESHOLDS.MIN_EDGE_TO_EXECUTE);
    
    let direction = null;
    if (cfm > kalshi + 0.005) {
      direction = 'YES';
    } else if (cfm < kalshi - 0.005) {
      direction = 'NO';
    } else if (cfm !== kalshi) {
      // ALWAYS_TRADE: any non-zero divergence still picks a side
      direction = cfm >= kalshi ? 'YES' : 'NO';
    } else {
      direction = cfm >= 50 ? 'YES' : 'NO';
    }

    // Policy hard-off (only when not ALWAYS_TRADE)
    const policyBlocks = !alwaysTrade && policy && policy.trade === false && policy.paper !== true;
    
    return {
      cfm,
      kalshi,
      edge,
      direction: policyBlocks ? null : direction,
      divergence: cfm - kalshi,
      shouldWatch: !policyBlocks,
      shouldExecute: !policyBlocks && direction !== null && edge >= Math.min(minEdge, 0.01),
      coin: coin,
      minEdgeRequired: minEdge,
      policy: policy || null,
      paperOnly: !!(policy && policy.paper === true),
      policyBlocked: !!policyBlocks,
    };
  }

  /**
   * Calculate confidence based on edge size
   */
  function getConfidenceFromEdge(edge) {
    for (const tier of EDGE_THRESHOLDS.CONFIDENCE_TIERS) {
      if (edge >= tier.edge) {
        return tier.confidence;
      }
    }
    return 0.50; // Minimum baseline
  }

  /**
   * Main entry decision: CFM + Sustenance filter + MODEL SCORE GATE
   * 
   * @param {object} signal - from analyzeDivergence()
   * @param {object} recommendation - from KalshiSustenance.getRecommendation()
   * @param {number} modelConfidence - model's confidence (0-100) — MUST be >=20 to trade
   * @returns {object} decision
   */
  function makeEntryDecision(signal, recommendation, modelConfidence = 0) {
    // CRITICAL FIX 2026-05-06: Reject if model confidence too low, regardless of edge
    // (prevents Kalshi odds from overriding weak model signals)
    const alwaysTrade = isAlwaysTradeMode();
    const policy = signal.policy || getTradingPolicy(signal.coin);
    const paperOnly = !!(signal.paperOnly || (policy && policy.paper === true));

    // TRADING_POLICY hard block (respect even under always-trade only as paper)
    if (policy && policy.trade === false && policy.paper !== true && !alwaysTrade) {
      return {
        trade: false,
        reason: policy.reason || `policy_block:${signal.coin}`,
        modelConfidence,
        edge: signal.edge,
        policy,
      };
    }

    const MIN_MODEL_CONFIDENCE = alwaysTrade ? 5 : 20;
    if (modelConfidence < MIN_MODEL_CONFIDENCE && !alwaysTrade) {
      return {
        trade: false,
        reason: `model_confidence_too_low: ${modelConfidence}% (need >=${MIN_MODEL_CONFIDENCE}%)`,
        modelConfidence,
        edge: signal.edge
      };
    }
    
    // ALWAYS_TRADE: execute whenever we have a direction
    if (alwaysTrade && signal.direction) {
      return {
        trade: true,
        reason: paperOnly ? 'always_trade_mode_paper' : 'always_trade_mode',
        modelConfidence: Math.max(modelConfidence, 30),
        edge: signal.edge,
        direction: signal.direction,
        alwaysTrade: true,
        paperOnly,
        policy: policy || null,
      };
    }

    // Reject if no divergence
    if (!signal.shouldExecute) {
      return {
        trade: false,
        reason: signal.policyBlocked ? (policy?.reason || 'policy_block') : 'insufficient_edge',
        edge: signal.edge,
        required: (policy && Number.isFinite(Number(policy.minEdge)))
          ? Number(policy.minEdge)
          : EDGE_THRESHOLDS.MIN_EDGE_TO_EXECUTE,
        policy: policy || null,
      };
    }

    // Reject if sustenance not confirmed
    if (recommendation.shouldTrade === false) {
      return {
        trade: false,
        reason: `reversal_detected: ${recommendation.reason}`,
        state: recommendation.state
      };
    }

    // PENDING — wait for sustenance confirmation (7+ min)
    if (recommendation.shouldTrade === null) {
      return {
        trade: null,  // PENDING
        reason: 'awaiting_sustenance_confirmation',
        elapsedSeconds: recommendation.elapsedSeconds,
        state: recommendation.state,
        directionMoveCount: recommendation.directionMoveCount,
        reversalMoveCount: recommendation.reversalMoveCount
      };
    }

    // EXECUTE — CFM edge + sustenance confirmed
    const confidence = getConfidenceFromEdge(signal.edge);
    return {
      trade: true,
      reason: paperOnly ? 'cfm_divergence_sustained_paper' : 'cfm_divergence_sustained',
      direction: signal.direction,
      edge: signal.edge,
      baseConfidence: confidence,
      sustenanceConfidence: recommendation.confidence,
      finalConfidence: Math.round((confidence + recommendation.confidence) / 2),
      paperOnly,
      policy: policy || null,
      action: {
        direction: signal.direction,
        quantity: calculateQuantity(signal.edge),
        stopLoss: calculateStopLoss(signal),
        takeProfit: undefined // Let it ride to expiry
      }
    };
  }

  /**
   * Position sizing based on edge (not volatility)
   * 
   * Larger edge = higher confidence = larger position
   */
  function calculateQuantity(edge) {
    // Scale from 1-5 contracts based on edge
    // 5¢ edge = 1 contract
    // 15¢ edge = 5 contracts
    const contracts = Math.min(5, Math.max(1, Math.round(edge * 33)));
    return contracts;
  }

  /**
   * Stop-loss: exit if reversal confirmed
   */
  function calculateStopLoss(signal) {
    // Exit if Kalshi odds move more than 10¢ AGAINST us
    const reverseThreshold = signal.kalshi + (signal.direction === 'YES' ? -0.10 : 0.10);
    return {
      type: 'reversal',
      threshold: reverseThreshold,
      reason: 'if_price_reverses_10c'
    };
  }

  /**
   * Risk management: circuit breakers
   */
  const riskState = {
    reversalTimestamps: [],  // timestamps of each reversal (for 30-min rolling window)
    shouldPause: false,
    pauseUntil: null
  };

  function onReversalDetected() {
    const now = Date.now();
    const windowStart = now - 30 * 60 * 1000;

    // Purge reversals older than 30 minutes
    riskState.reversalTimestamps = riskState.reversalTimestamps.filter(t => t > windowStart);
    riskState.reversalTimestamps.push(now);

    // 3+ reversals within the rolling 30-min window → pause for 15 min
    if (riskState.reversalTimestamps.length >= 3) {
      riskState.shouldPause = true;
      riskState.pauseUntil = now + 15 * 60 * 1000;
      console.warn('[KalshiEntry] 3 reversals in 30 min — pausing for 15 min');
    }
  }

  function canTrade() {
    if (riskState.shouldPause && Date.now() < riskState.pauseUntil) {
      return false;
    }
    riskState.shouldPause = false;
    return true;
  }

  // Export API
  window.KalshiEntryLogic = {
    analyzeDivergence,
    getConfidenceFromEdge,
    makeEntryDecision,
    calculateQuantity,
    calculateStopLoss,
    onReversalDetected,
    canTrade,
    getTradingPolicy,
    EDGE_THRESHOLDS,
    riskState
  };

  console.log('[KalshiEntryLogic] Loaded — CFM + Sustenance entry framework active');
})();
