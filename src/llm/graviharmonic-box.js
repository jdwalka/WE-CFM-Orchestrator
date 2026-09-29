/**
 * Graviharmonic Inference Box — WE|||CRYPTO AI Intelligence Layer
 * 
 * Synthesizes Gravitational Potential Field Dynamics (PTB Well, Kinetic Energy, Escape Velocity)
 * and Multi-Band Harmonic Resonance (Phase Coherence, Damping Ratio, Standing Wave Nodes)
 * to condition and accelerate LLM Inference (ASI1, Grok, Claude, DeepSeek).
 *
 * Exposes:
 *   window.GraviharmonicBox:
 *     .computeState(symbol, spotPrice, ptbPrice, options)
 *     .getGraviharmonicVector(symbol)
 *     .formatPromptContext(symbol)
 *     .getDiagnostics()
 *
 * Dual Browser + Node.js (CommonJS) support.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.GraviharmonicBox = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Gravitational and Resonance Field Constants
  const G_CONST = 1.0;                  // Gravitational scaling constant
  const EPSILON_SMOOTH = 0.0001;        // Singularity softening parameter
  const RING_BUFFER_SIZE = 60;          // 60-sample sliding window per asset
  const HARMONIC_BANDS = [
    { name: 'micro',   periodSec: 5,   weight: 0.20 }, // 1s-5s tick microstructure
    { name: 'short',   periodSec: 30,  weight: 0.30 }, // 15s-30s TWAP pulse
    { name: 'meso',    periodSec: 300, weight: 0.35 }, // 5m contract window
    { name: 'macro',   periodSec: 900, weight: 0.15 }, // 15m structural trend
  ];

  // Asset Memory State Chambers
  const _stateChambers = new Map();

  function _getOrCreateChamber(sym) {
    const key = String(sym || 'BTC').toUpperCase();
    if (!_stateChambers.has(key)) {
      _stateChambers.set(key, {
        symbol: key,
        samples: [],
        lastComputedAt: 0,
        lastState: null,
        resonanceTracker: {
          microPhase: 0,
          shortPhase: 0,
          mesoPhase: 0,
          macroPhase: 0,
        },
      });
    }
    return _stateChambers.get(key);
  }

  /**
   * Helper: Clamp value to [min, max]
   */
  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  /**
   * Computes Gravitational Potential Field Parameters:
   * - Well Depth (Phi): Potential energy binding the price to PTB
   * - Velocity (v): Directional momentum (rate of price change)
   * - Kinetic Energy (Ek): 0.5 * v^2
   * - Potential Energy (U): -G / (|delta_bps| + epsilon)
   * - Escape Velocity (v_esc): sqrt(2 * |U|)
   * - Escape Velocity Ratio (R_esc): v / v_esc (>1.0 indicates breakout from PTB gravity)
   */
  function computeGravitationalField(spot, ptb, history, timeRemainingSec = 300) {
    const s = Number(spot);
    const p = Number(ptb);
    if (!Number.isFinite(s) || !Number.isFinite(p) || s <= 0 || p <= 0) {
      return {
        deltaBps: 0,
        potentialPhi: 0,
        velocityBps: 0,
        kineticEnergy: 0,
        escapeVelocity: 0,
        escapeRatio: 0,
        isEscaped: false,
        gravitationalPullDirection: 'NEUTRAL',
        bindingStrength: 'UNBOUND',
      };
    }

    const deltaPrice = s - p;
    const deltaBps = (deltaPrice / p) * 10000;
    const absDeltaBps = Math.abs(deltaBps);

    // Compute velocity (bps per second) over recent history
    let velocityBps = 0;
    if (history.length >= 2) {
      const oldest = history[0];
      const newest = history[history.length - 1];
      const dtSec = Math.max(1, (newest.ts - oldest.ts) / 1000);
      const dPriceBps = ((newest.spot - oldest.spot) / p) * 10000;
      velocityBps = dPriceBps / dtSec;
    }

    // Gravitational Potential: U = -G_CONST * M / (distance + epsilon)
    // Distance modeled in normalized basis points
    const potentialPhi = -G_CONST / Math.sqrt(absDeltaBps * absDeltaBps + EPSILON_SMOOTH);
    const kineticEnergy = 0.5 * (velocityBps * velocityBps);
    const escapeVelocity = Math.sqrt(2 * Math.abs(potentialPhi) * 100);
    const escapeRatio = escapeVelocity > 0 ? Math.abs(velocityBps) / escapeVelocity : 0;
    const isEscaped = escapeRatio >= 1.0;

    let bindingStrength = 'MODERATE';
    if (absDeltaBps < 5) bindingStrength = 'HIGH_GRAVITY_CORE';
    else if (absDeltaBps < 20) bindingStrength = 'ORBITAL_TRAPPED';
    else bindingStrength = isEscaped ? 'FREE_TRAJECTORY' : 'WEAK_PULL';

    const gravitationalPullDirection = deltaPrice > 0 ? 'PULL_DOWN_TO_PTB' : (deltaPrice < 0 ? 'PULL_UP_TO_PTB' : 'AT_EQUILIBRIUM');

    return {
      deltaBps: Number(deltaBps.toFixed(2)),
      potentialPhi: Number(potentialPhi.toFixed(4)),
      velocityBps: Number(velocityBps.toFixed(3)),
      kineticEnergy: Number(kineticEnergy.toFixed(4)),
      escapeVelocity: Number(escapeVelocity.toFixed(3)),
      escapeRatio: Number(escapeRatio.toFixed(2)),
      isEscaped,
      gravitationalPullDirection,
      bindingStrength,
    };
  }

  /**
   * Computes Multi-Band Harmonic Resonance & Phase Coherence:
   * - Phase Coherence (gamma): Alignment across micro, short, meso, and macro waves
   * - Damping Ratio (zeta): Resistance of order book to harmonic oscillation
   * - Resonant Regime: CONSTRUCTIVE_IMPULSE, DESTRUCTIVE_CHOP, STANDING_WAVE_NODE, ORBITAL_RESONANCE
   */
  function computeHarmonicResonance(history, chamber) {
    if (history.length < 4) {
      return {
        phaseCoherence: 0.5,
        harmonicCoherenceScore: 50,
        dampingRatio: 0.707, // Critically damped baseline
        resonantRegime: 'ORBITAL_STABLE',
        phaseAlignment: 'NEUTRAL',
        standingWaveNode: false,
      };
    }

    const now = Date.now();
    const prices = history.map(h => h.spot);
    const n = prices.length;

    // Estimate instantaneous phase angles for each harmonic band
    const phases = [];
    HARMONIC_BANDS.forEach((band, idx) => {
      const windowSamples = Math.min(n, Math.max(3, Math.floor(band.periodSec / 2)));
      const slice = prices.slice(-windowSamples);
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length;
      const std = Math.sqrt(variance);

      // Phase derivative based on recent slope relative to standard deviation
      const slope = slice.length >= 2 ? (slice[slice.length - 1] - slice[0]) / slice.length : 0;
      const normalizedSlope = std > 0 ? clamp(slope / std, -1.0, 1.0) : 0;
      const phase = Math.asin(normalizedSlope); // -pi/2 to +pi/2

      phases.push({ name: band.name, phase, weight: band.weight });
    });

    // Compute pairwise Phase Coherence: mean of cos(theta_i - theta_j)
    let coherenceSum = 0;
    let pairCount = 0;
    for (let i = 0; i < phases.length; i++) {
      for (let j = i + 1; j < phases.length; j++) {
        const dTheta = phases[i].phase - phases[j].phase;
        coherenceSum += Math.cos(dTheta) * (phases[i].weight + phases[j].weight);
        pairCount += (phases[i].weight + phases[j].weight);
      }
    }
    const rawCoherence = pairCount > 0 ? coherenceSum / pairCount : 0.5;
    const phaseCoherence = clamp((rawCoherence + 1) / 2, 0.0, 1.0); // Map [-1, 1] to [0, 1]
    const harmonicCoherenceScore = Math.round(phaseCoherence * 100);

    // Damping calculation: low variance in micro vs meso = over-damped
    const microSlice = prices.slice(-3);
    const microRange = Math.max(...microSlice) - Math.min(...microSlice);
    const macroRange = Math.max(...prices) - Math.min(...prices);
    const dampingRatio = macroRange > 0 ? clamp(microRange / macroRange, 0.1, 1.5) : 0.707;

    // Detect standing wave node (phase crossing zero with high coherence)
    const microPhase = phases[0]?.phase || 0;
    const standingWaveNode = Math.abs(microPhase) < 0.15 && phaseCoherence > 0.75;

    let resonantRegime = 'ORBITAL_STABLE';
    let phaseAlignment = 'CONSTRUCTIVE_UP';

    const avgPhase = phases.reduce((acc, p) => acc + p.phase * p.weight, 0);
    if (phaseCoherence >= 0.70) {
      if (avgPhase > 0.25) {
        resonantRegime = 'CONSTRUCTIVE_BREAKOUT_UP';
        phaseAlignment = 'ALIGNED_BULLISH';
      } else if (avgPhase < -0.25) {
        resonantRegime = 'CONSTRUCTIVE_BREAKOUT_DOWN';
        phaseAlignment = 'ALIGNED_BEARISH';
      } else {
        resonantRegime = 'STANDING_WAVE_RESONANCE';
        phaseAlignment = 'HARMONIC_BALANCE';
      }
    } else if (phaseCoherence <= 0.35) {
      resonantRegime = 'DESTRUCTIVE_INTERFERENCE_CHOP';
      phaseAlignment = 'PHASE_COLLAPSE';
    } else {
      resonantRegime = 'ORBITAL_DAMPED';
      phaseAlignment = 'TRANSIENT_WAVE';
    }

    return {
      phaseCoherence: Number(phaseCoherence.toFixed(3)),
      harmonicCoherenceScore,
      dampingRatio: Number(dampingRatio.toFixed(3)),
      resonantRegime,
      phaseAlignment,
      standingWaveNode,
    };
  }

  /**
   * Main Entry: Computes the complete Graviharmonic Tensor State for an asset.
   */
  function computeState(symbol, spotPrice, ptbPrice, options = {}) {
    const chamber = _getOrCreateChamber(symbol);
    const now = Date.now();
    const spot = Number(spotPrice);
    const ptb = Number(ptbPrice);
    const timeRemainingSec = Number(options.timeRemainingSec || 300);

    if (Number.isFinite(spot) && spot > 0) {
      chamber.samples.push({ ts: now, spot, ptb: Number.isFinite(ptb) ? ptb : spot });
      if (chamber.samples.length > RING_BUFFER_SIZE) {
        chamber.samples.shift();
      }
    }

    const grav = computeGravitationalField(spot, ptb, chamber.samples, timeRemainingSec);
    const harm = computeHarmonicResonance(chamber.samples, chamber);

    // Synthesize Graviharmonic Composite Index (GCI: -100 to +100)
    // Positive = Constructive UP escape / momentum
    // Negative = Constructive DOWN escape / momentum
    // Near 0 = Trapped inside PTB Potential Well
    let directionSign = 0;
    if (grav.deltaBps > 0) directionSign = +1;
    else if (grav.deltaBps < 0) directionSign = -1;

    let compositeIndex = 0;
    if (grav.isEscaped) {
      compositeIndex = directionSign * Math.min(100, Math.round(50 + (grav.escapeRatio - 1) * 25 + harm.harmonicCoherenceScore * 0.25));
    } else {
      // Inside well: weighted by distance and phase alignment
      compositeIndex = Math.round(directionSign * Math.min(45, (Math.abs(grav.deltaBps) / 20) * 45) * harm.phaseCoherence);
    }

    // Recommended Action synthesis
    let actionRecommendation = 'HOLD_FLAT';
    let reasoning = '';
    if (grav.isEscaped && harm.phaseCoherence >= 0.65) {
      actionRecommendation = grav.deltaBps > 0 ? 'BUY_UP_ESCAPE' : 'BUY_DOWN_ESCAPE';
      reasoning = `Escape velocity achieved (Ratio: ${grav.escapeRatio}x) with constructive ${harm.phaseAlignment} resonance.`;
    } else if (!grav.isEscaped && Math.abs(grav.deltaBps) < 5) {
      actionRecommendation = 'HOLD_FLAT_WELL';
      reasoning = `Price bound within PTB gravitational singularity (|delta| < 5 bps). High probability of mean-reverting pin.`;
    } else if (harm.resonantRegime.includes('DESTRUCTIVE')) {
      actionRecommendation = 'HOLD_FLAT_CHOP';
      reasoning = `Destructive wave interference across timeframes. Signal noise dominates.`;
    } else {
      actionRecommendation = grav.deltaBps > 0 ? 'LEAN_UP_ORBIT' : 'LEAN_DOWN_ORBIT';
      reasoning = `Stable orbital trajectory with ${harm.harmonicCoherenceScore}% harmonic coherence.`;
    }

    const state = Object.freeze({
      symbol: chamber.symbol,
      timestamp: now,
      spot,
      ptb,
      gravitational: grav,
      harmonic: harm,
      compositeIndex,
      actionRecommendation,
      reasoning,
    });

    chamber.lastComputedAt = now;
    chamber.lastState = state;
    return state;
  }

  /**
   * Retrieves the latest Graviharmonic Vector for an asset.
   */
  function getGraviharmonicVector(symbol) {
    const chamber = _getOrCreateChamber(symbol);
    return chamber.lastState || null;
  }

  /**
   * Formats Graviharmonic Context for LLM Prompts (ASI1, Grok, Claude, DeepSeek).
   * Generates a concise, high-density telemetry block.
   */
  function formatPromptContext(symbol) {
    const v = getGraviharmonicVector(symbol);
    if (!v) return null;

    const g = v.gravitational;
    const h = v.harmonic;

    return [
      `[GRAVIHARMONIC RESONANCE TELEMETRY]`,
      `PTB Potential Well: Delta=${g.deltaBps >= 0 ? '+' : ''}${g.deltaBps} bps | State=${g.bindingStrength} | EscapeRatio=${g.escapeRatio}x (${g.isEscaped ? 'ESCAPED' : 'TRAPPED'})`,
      `Harmonic Matrix: Coherence=${h.harmonicCoherenceScore}% | Phase=${h.phaseAlignment} | Regime=${h.resonantRegime} | Damping=${h.dampingRatio}`,
      `Composite Field Index: ${v.compositeIndex > 0 ? '+' : ''}${v.compositeIndex}/100 | Recommendation: ${v.actionRecommendation} (${v.reasoning})`,
    ].join('\n');
  }

  /**
   * Exposes global system diagnostics for the UI desk HUD.
   */
  function getDiagnostics() {
    const out = {};
    _stateChambers.forEach((chamber, sym) => {
      out[sym] = {
        sampleCount: chamber.samples.length,
        lastComputedAt: chamber.lastComputedAt,
        state: chamber.lastState,
      };
    });
    return out;
  }

  return {
    computeState,
    getGraviharmonicVector,
    formatPromptContext,
    getDiagnostics,
  };
}));
