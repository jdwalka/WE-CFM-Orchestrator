/**
 * Kalshi 15-Min Entry: H-Subshell 11-State Model
 *
 * Aligned with KalshiEnhancements (kalshi-prediction-enhancements.js).
 * Uses the full 11-state h-subshell (-5..+5) spin system, not the old 3-shell model.
 *
 * Entry thresholds per coin orbital profile:
 *   core    (BTC/ETH)  — execute at |spin| >= 3  (s-d stable ground state)
 *   core+   (XRP)      — execute at |spin| >= 3
 *   momentum(SOL/HYPE) — execute at |spin| >= 2  (outer-shell reactive)
 *   highBeta(DOGE)     — execute at |spin| >= 3  (noise at ±4/±5, gate tighter)
 */

(function() {
  'use strict';

  window.KalshiShellEntry = window.KalshiShellEntry || {};

  /**
   * Per-coin h-subshell entry configuration
   * spinRange: natural range (-maxSpin..+maxSpin)
   * entryThreshold: minimum |spin| to trigger execution
   * confidence map: spin level → base confidence
   */
  const COIN_SHELL_CONFIG = {
    BTC: {
      profile: 'core',
      spinRange: 5,         // full h-subshell range supported
      entryThreshold: 3,    // execute at |spin| >= 3
      confidence: { 5: 0.92, 4: 0.82, 3: 0.72, 2: 0.58, 1: 0.45 },
    },
    ETH: {
      profile: 'core',
      spinRange: 5,
      entryThreshold: 3,
      confidence: { 5: 0.92, 4: 0.82, 3: 0.72, 2: 0.58, 1: 0.45 },
    },
    XRP: {
      profile: 'core_plus',
      spinRange: 5,
      entryThreshold: 3,
      confidence: { 5: 0.90, 4: 0.80, 3: 0.70, 2: 0.60, 1: 0.48 },
    },
    SOL: {
      profile: 'momentum',
      spinRange: 5,
      entryThreshold: 2,    // outer-shell reactive — ±2 is sufficient conviction
      confidence: { 5: 0.88, 4: 0.78, 3: 0.68, 2: 0.60, 1: 0.50 },
    },
    HYPE: {
      profile: 'momentum',
      spinRange: 5,
      entryThreshold: 2,
      confidence: { 5: 0.88, 4: 0.78, 3: 0.68, 2: 0.60, 1: 0.50 },
    },
    DOGE: {
      profile: 'highBeta',
      spinRange: 5,
      entryThreshold: 3,    // highBeta: ±4/±5 are noisy, still require ±3
      confidence: { 5: 0.80, 4: 0.72, 3: 0.65, 2: 0.55, 1: 0.44 },
    },
    BNB: {
      profile: 'core_plus',
      spinRange: 5,
      entryThreshold: 4,    // disabled-equivalent — needs near-extreme spin
      confidence: { 5: 0.70, 4: 0.60, 3: 0.50, 2: 0.40, 1: 0.35 },
    },
  };

  /**
   * Main entry decision using h-subshell spin state
   *
   * @param {string} coin       - BTC, ETH, SOL, etc
   * @param {number} spinState  - float -5..+5 (from KalshiEnhancements blendedSpin)
   * @param {number} [baseConf] - optional override base confidence (0-1)
   * @returns {object} decision
   */
  function makeShellEntry(coin, spinState, baseConf) {
    const cfg = COIN_SHELL_CONFIG[coin.toUpperCase()];
    if (!cfg) {
      return { trade: false, reason: 'unknown_coin' };
    }

    const absSpin = Math.abs(spinState);
    const spinLevel = Math.min(5, Math.round(absSpin));  // round to nearest integer level

    if (absSpin >= cfg.entryThreshold) {
      const confidence = baseConf != null ? baseConf : (cfg.confidence[spinLevel] ?? 0.50);
      return {
        trade: true,
        reason: 'spin_threshold_reached',
        coin,
        spinState,
        spinLevel,
        profile: cfg.profile,
        entryThreshold: cfg.entryThreshold,
        confidence,
        action: {
          direction: spinState > 0 ? 'YES' : 'NO',
          quantity: calculateQuantityFromSpin(absSpin),
          confidence,
        },
      };
    }

    return {
      trade: false,
      reason: 'below_spin_threshold',
      coin,
      spinState,
      spinLevel,
      threshold: cfg.entryThreshold,
    };
  }

  /**
   * Position sizing based on spin intensity (h-subshell scale 0-5)
   * 1 → 1 contract | 2 → 2 | 3 → 3 | 4 → 4 | 5 → 5
   */
  function calculateQuantityFromSpin(absSpin) {
    return Math.max(1, Math.min(5, Math.round(absSpin)));
  }

  function isValidCoin(coin) {
    return !!COIN_SHELL_CONFIG[coin.toUpperCase()];
  }

  function getConfig(coin) {
    return COIN_SHELL_CONFIG[coin.toUpperCase()];
  }

  function getAllConfigs() {
    return COIN_SHELL_CONFIG;
  }

  // Export
  window.KalshiShellEntry = {
    makeShellEntry,
    calculateQuantityFromSpin,
    isValidCoin,
    getConfig,
    getAllConfigs,
    COIN_SHELL_CONFIG,
  };

  // Edge mode: when the shell is running on a co-located VPS, the latest
  // Sig_prob float and spin state are pushed into the local edge Redis by
  // tools/edge-weight-sync.js. We override the synchronous decision path
  // to consume them so the per-tick loop never has to round-trip back
  // to the brain.
  const EDGE_MODE = process.env.WECRYPTO_EDGE_MODE === '1';
  const edgeReader = EDGE_MODE
    ? (function () {
        try { return require('./edge-sig-prob-reader'); }
        catch (_) { return null; }
      })()
    : null;

  async function getEdgeSigProb(asset) {
    if (!edgeReader) return null;
    return edgeReader.getSigProb(asset);
  }

  async function getEdgeSpin(asset) {
    if (!edgeReader) return null;
    return edgeReader.getSpin(asset);
  }

  async function decideWithEdge(coin, fallbackSpin) {
    if (!edgeReader) return makeShellEntry(coin, fallbackSpin);
    const [sigProb, spin] = await Promise.all([
      edgeReader.getSigProb(coin),
      edgeReader.getSpin(coin),
    ]);
    if (sigProb == null) {
      return { trade: false, reason: 'edge_sigprob_missing', coin, spinState: fallbackSpin };
    }
    const effectiveSpin = spin != null ? spin : fallbackSpin;
    if (sigProb < 0.55) {
      return { trade: false, reason: 'edge_below_sig_threshold', coin, sigProb, spinState: effectiveSpin };
    }
    const decision = makeShellEntry(coin, effectiveSpin, sigProb);
    if (decision.trade) decision.edgeSigProb = sigProb;
    return decision;
  }
  console.log('[KalshiShellEntry] Loaded — H-subshell 11-state entry framework active');
})();
