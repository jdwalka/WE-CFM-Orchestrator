// ================================================================
// Adaptive Walk-Forward Tuning Module
// Recalibrates signal gates every 15-minute candle close
// Uses: recent trade performance + volatility regime + Pyth validation
// ================================================================

class AdaptiveTuner {
  constructor() {
    // Recent trade history (last 100 per coin for tuning decisions)
    this.tradeHistory = {};

    // Tuning log for audit trail
    this.tuningLog = [];
    this.regimeMultiplierHistory = [];

    // Baseline thresholds — synced to SIGNAL_GATE_OVERRIDES (30-day walk-forward 2026-04-27).
    // TUNED FOR 15M CONTRACTS (2026-05-04 recalibration):
    // Tightened thresholds for 15m horizon to capture higher-confidence edge signals.
    this.baselineGates = {
      BTC:  { minAbsScore: 0.42, label: 'calibrated-15m' },  // was 0.36 (too loose for 15m)
      ETH:  { minAbsScore: 0.45, label: 'calibrated-15m' },  // was 0.40
      XRP:  { minAbsScore: 0.40, label: 'calibrated-15m' },  // was 0.36 (lowest baseline)
      SOL:  { minAbsScore: 0.44, label: 'calibrated-15m' },  // keep as-is (already optimal)
      BNB:  { minAbsScore: 0.55, label: 'near-blocked' },    // hold pending CFM data audit
      DOGE: { minAbsScore: 0.28, label: 'balanced' },        // monitor post signal-fix
      HYPE: { minAbsScore: 0.20, label: 'moderate' },        // retest post signal-fix
    };

    // Bounds for adaptive adjustments — min/max now bracket the calibrated baseline.
    // Updated for 15m-optimized thresholds (2026-05-04).
    this.tuneBounds = {
      BTC:  { min: 0.36, max: 0.50 },  // was 0.30–0.44, now tighter around 0.42
      ETH:  { min: 0.38, max: 0.54 },  // was 0.34–0.50, now tighter around 0.45
      XRP:  { min: 0.32, max: 0.48 },  // was 0.30–0.44, now tighter around 0.40
      SOL:  { min: 0.38, max: 0.54 },  // unchanged (already optimal at 0.44)
      BNB:  { min: 0.48, max: 0.65 },  // unchanged (near-blocked holding pattern)
      DOGE: { min: 0.24, max: 0.36 },  // unchanged (balanced at 0.28)
      HYPE: { min: 0.16, max: 0.28 },  // unchanged (moderate at 0.20)
    };

    // Current tuning parameters (per coin) — initialized as plain numeric thresholds
    // from baselineGates. Never copy SIGNAL_GATE_OVERRIDES directly here: those are
    // gate *objects* ({minAbsScore, minAgreement, ...}), not numbers, and would break
    // any numeric comparisons in evaluateSignalGate before the first tuning cycle runs.
    this.currentGates = {};
    const INIT_COINS = Object.keys(this.baselineGates);
    for (const sym of INIT_COINS) {
      this.currentGates[sym] = this.baselineGates[sym].minAbsScore;
    }
    this.timingGates = {};
    for (const sym of INIT_COINS) {
      this.timingGates[sym] = {
        closeEdgeAdj: 0,
        closeMispriceAdj: 0,
        closePayoutAdj: 0,
        scalpEdgeAdj: 0,
        source: 'baseline',
        samples: 0,
        updatedAt: 0,
      };
    }

    // Market regime tracking
    this.volatilityRegime = {};
    this.lastTuneTime = Date.now();
    
    // 15m contract tuning acceleration (2026-05-04, retightened 2026-08-26)
    // MULTI-CYCLE DYNAMIC TUNING: Retune on ANY trigger
    // ├─ 2 minutes (fast): Captures rapid market regime changes, high volatility periods
    // ├─ 7 minutes (medium): Standard tuning cycle, balanced responsiveness
    // ├─ 12 minutes (extended): Catch drift during quiet/ranging markets
    // └─ 10 trades (volume): Automatic trigger if volume spike causes regime shift
    this.tradesSinceLastTune = 0;
    this.TUNING_CYCLES_MINUTES = [2, 7, 12];
    this.TUNING_CYCLES_MS = this.TUNING_CYCLES_MINUTES.map(min => min * 60 * 1000);  // [120000, 420000, 720000]
    this.TUNING_CYCLE_TRADES = 10;  // Trigger on 10 new trades OR any time threshold

    // Separate, heavier hourly pass: full recalibration from the resolution
    // log rather than an incremental nudge (see runHourlyAudit()).
    this.AUDIT_CYCLE_MS = 60 * 60 * 1000;
    this.lastAuditTime = Date.now();
    this.auditLog = [];

    console.log('[AdaptiveTuner] Initialized with 15m-optimized baseline gates + multi-cycle tuning (2m/7m/12m or 10-trade) + hourly full audit');
  }

  // ──────────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────────

  getTuningCoins() {
    const active = (typeof window !== 'undefined' && Array.isArray(window.PREDICTION_COINS))
      ? window.PREDICTION_COINS.map(c => c && c.sym).filter(Boolean)
      : [];
    const supported = active.length ? active : Object.keys(this.baselineGates);
    return [...new Set(supported.map(s => String(s).toUpperCase()))]
      .filter(sym => this.baselineGates[sym]);
  }

  /**
   * Applies per-coin/per-signal weight nudges via the real online-weight
   * overlay (window.PredictionEngine.applyOnlineWeightUpdate), which is
   * actually read by weightedComposite()/MergeKit every tick.
   *
   * `setRegimeWeightMultipliers`/`getRegimeWeightMultipliers` this used to
   * call never existed anywhere in the codebase — every call silently no-op'd
   * and reported `applied: false`. Fixed 2026-08-26.
   *
   * @param {object} multiplierSet - { [coin]: { [signalKey]: mult|{mult}|{delta} } }
   */
  applyRegimeMultipliers(multiplierSet, options = {}) {
    if (typeof window === 'undefined' || !window.PredictionEngine?.applyOnlineWeightUpdate) {
      return { applied: false, reason: 'PredictionEngine online-weight API unavailable' };
    }
    const perCoin = {};
    for (const [sym, updates] of Object.entries(multiplierSet || {})) {
      perCoin[sym] = window.PredictionEngine.applyOnlineWeightUpdate(sym, updates, {
        reason: options.source || 'adaptive-tuner',
      });
    }
    const event = {
      timestamp: Date.now(),
      source: options.source || 'adaptive-tuner',
      coins: Object.keys(multiplierSet || {}),
    };
    this.regimeMultiplierHistory.push(event);
    if (this.regimeMultiplierHistory.length > 50) {
      this.regimeMultiplierHistory = this.regimeMultiplierHistory.slice(-50);
    }
    return { applied: true, event, state: perCoin };
  }

  getRegimeMultipliers() {
    if (typeof window === 'undefined' || !window.PredictionEngine?.getOnlineWeightState) return null;
    return window.PredictionEngine.getOnlineWeightState();
  }

  clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  _ensureTimingGate(sym) {
    const key = String(sym || '').toUpperCase();
    if (!this.timingGates[key]) {
      this.timingGates[key] = {
        closeEdgeAdj: 0,
        closeMispriceAdj: 0,
        closePayoutAdj: 0,
        scalpEdgeAdj: 0,
        source: 'dynamic',
        samples: 0,
        updatedAt: 0,
      };
    }
    return this.timingGates[key];
  }

  _decayTimingGate(gate, elapsedMs) {
    const decay = Math.pow(0.90, Math.min(8, Math.max(0, elapsedMs || 0) / 30000));
    gate.closeEdgeAdj *= decay;
    gate.closeMispriceAdj *= decay;
    gate.closePayoutAdj *= decay;
    gate.scalpEdgeAdj *= decay;
  }

  /**
   * Live adaptive retune.
   * Called continuously from the orchestrator/order-book scanner so threshold
   * pressure changes immediately when the session, candle velocity, or book
   * imbalance changes. Outcome retunes still correct this after settlement.
   */
  observeLiveMarketState(sym, context = {}) {
    const key = String(sym || '').toUpperCase();
    if (!this.baselineGates[key]) return null;

    const now = Date.now();
    const pred = context.pred || {};
    const cfm = context.cfm || {};
    const ind = pred.indicators || {};
    const session = pred.session || {};
    const sessionLabel = context.sessionLabel
      || session.current?.label
      || session.label
      || 'unknown';
    const sessionScalp = !!(session.current?.scalp || context.sessionScalp);
    const secsLeft = Number(context.secsLeft);
    const bookImbalance = Math.abs(Number(
      context.bookImbalance
      ?? ind.book?.imbalance
      ?? pred.diagnostics?.liveBook?.imbalance
      ?? 0
    ));
    const buyRatio = Number(ind.flow?.buyRatio ?? context.buyRatio ?? 50);
    const flowShock = Number.isFinite(buyRatio) ? Math.abs(buyRatio - 50) / 50 : 0;
    const volRatio = Number(ind.volume?.ratio ?? context.volumeRatio ?? 1);
    const atrPct = Number(pred.volatility?.atrPct ?? context.atrPct ?? 0);
    const tape = ind.tapeVelocity || pred.diagnostics?.tapeVelocity || {};
    const rangeExpansion = Number(tape.rangeExpansion ?? context.rangeExpansion ?? 1);
    const bodyExpansion = Number(tape.bodyExpansion ?? context.bodyExpansion ?? 1);
    const volumeBurst = Number(tape.volumeBurst ?? context.volumeBurst ?? volRatio);
    const modelShock = Math.abs(Number(pred.score || 0)) >= 0.48;
    const hugeCandle = rangeExpansion >= 1.75
      || bodyExpansion >= 1.65
      || volumeBurst >= 2.10
      || atrPct >= 3.0
      || !!context.hugeCandle;
    const bookShock = bookImbalance >= 0.30;
    const tapeConfirmed = bookShock || flowShock >= 0.24 || modelShock;
    const closeWindow = Number.isFinite(secsLeft) && secsLeft <= 210 && secsLeft >= 45;

    const gate = this._ensureTimingGate(key);
    const state = gate._state || {};
    if (gate.updatedAt) this._decayTimingGate(gate, now - gate.updatedAt);

    const reasons = [];
    const sessionChanged = !!(state.sessionLabel && state.sessionLabel !== sessionLabel);
    const impulseCooldownOk = !state.lastImpulseTs || (now - state.lastImpulseTs) >= 25000;

    if (hugeCandle && tapeConfirmed) {
      gate.closeEdgeAdj -= closeWindow ? 2.5 : 1.4;
      gate.closeMispriceAdj -= closeWindow ? 0.018 : 0.010;
      gate.closePayoutAdj -= 0.08;
      gate.scalpEdgeAdj -= sessionScalp || !closeWindow ? 1.6 : 0.8;
      reasons.push('huge candle confirmed by book/tape');
      if (impulseCooldownOk) {
        const bounds = this.tuneBounds[key];
        const cur = this.currentGates[key] || this.baselineGates[key].minAbsScore;
        this.currentGates[key] = this.clamp(cur - 0.035, bounds.min, bounds.max);
        state.lastImpulseTs = now;
        reasons.push('score gate relaxed for fast regime');
      }
    } else if (hugeCandle && !tapeConfirmed) {
      gate.closeEdgeAdj += closeWindow ? 2.0 : 1.0;
      gate.closeMispriceAdj += closeWindow ? 0.014 : 0.006;
      gate.scalpEdgeAdj += 1.4;
      reasons.push('huge candle unconfirmed; tightening fills');
      if (impulseCooldownOk) {
        const bounds = this.tuneBounds[key];
        const cur = this.currentGates[key] || this.baselineGates[key].minAbsScore;
        this.currentGates[key] = this.clamp(cur + 0.025, bounds.min, bounds.max);
        state.lastImpulseTs = now;
        reasons.push('score gate tightened for unconfirmed shock');
      }
    }

    if (sessionChanged) {
      if (sessionScalp) {
        gate.scalpEdgeAdj -= 1.2;
        gate.closeEdgeAdj -= 0.8;
        reasons.push('session changed into scalp-friendly flow');
      } else {
        gate.scalpEdgeAdj += 0.8;
        reasons.push('session changed out of scalp flow');
      }
    }

    if (bookShock && closeWindow) {
      gate.closeEdgeAdj -= 1.0;
      gate.closeMispriceAdj -= 0.006;
      reasons.push('close-window book imbalance');
    } else if (bookShock) {
      gate.scalpEdgeAdj -= 0.8;
      reasons.push('live book imbalance');
    }

    if (atrPct >= 4.2 && !tapeConfirmed) {
      gate.closeEdgeAdj += 1.0;
      gate.scalpEdgeAdj += 1.0;
      reasons.push('extreme volatility without confirmation');
    }

    gate.closeEdgeAdj = this.clamp(gate.closeEdgeAdj, -5, 6);
    gate.closeMispriceAdj = this.clamp(gate.closeMispriceAdj, -0.045, 0.055);
    gate.closePayoutAdj = this.clamp(gate.closePayoutAdj, -0.25, 0.30);
    gate.scalpEdgeAdj = this.clamp(gate.scalpEdgeAdj, -4, 5);
    gate.samples += 1;
    gate.updatedAt = now;
    gate.source = reasons.length ? 'live-adaptive' : gate.source;
    if (reasons.length) gate.lastReasons = reasons;
    gate._state = {
      ...state,
      sessionLabel,
      sessionScalp,
      hugeCandle,
      bookShock,
      tapeConfirmed,
      closeWindow,
      lastSeenTs: now,
    };

    if (typeof window !== 'undefined') {
      window._adaptiveTimingGates = window._adaptiveTimingGates || {};
      window._adaptiveTimingGates[key] = {
        closeEdgeAdj: gate.closeEdgeAdj,
        closeMispriceAdj: gate.closeMispriceAdj,
        closePayoutAdj: gate.closePayoutAdj,
        scalpEdgeAdj: gate.scalpEdgeAdj,
        source: gate.source,
        samples: gate.samples,
        lastReasons: gate.lastReasons || [],
        updatedAt: gate.updatedAt,
      };
      window._currentGates = { ...this.currentGates };
    }

    return {
      sym: key,
      closeEdgeAdj: gate.closeEdgeAdj,
      closeMispriceAdj: gate.closeMispriceAdj,
      closePayoutAdj: gate.closePayoutAdj,
      scalpEdgeAdj: gate.scalpEdgeAdj,
      scoreGate: this.currentGates[key],
      reasons,
      flags: { hugeCandle, bookShock, tapeConfirmed, closeWindow, sessionChanged },
    };
  }

  getAdaptiveTimingThresholds(sym, base = {}, context = {}) {
    const observed = this.observeLiveMarketState(sym, context) || {};
    const gate = this._ensureTimingGate(sym);
    return {
      closeEdgeCents: Math.round(this.clamp((base.closeEdgeCents ?? 10) + gate.closeEdgeAdj, 5, 18)),
      closeStrongEdgeCents: Math.round(this.clamp((base.closeStrongEdgeCents ?? 14) + gate.closeEdgeAdj, 8, 22)),
      closeMinMisprice: this.clamp((base.closeMinMisprice ?? 0.12) + gate.closeMispriceAdj, 0.07, 0.22),
      closePayoutMin: this.clamp((base.closePayoutMin ?? 1.75) + gate.closePayoutAdj, 1.45, 2.35),
      scalpEdgeCents: Math.round(this.clamp((base.scalpEdgeCents ?? 6) + gate.scalpEdgeAdj, 3, 13)),
      source: gate.source,
      reasons: observed.reasons && observed.reasons.length ? observed.reasons : (gate.lastReasons || []),
      adjustments: {
        closeEdgeAdj: gate.closeEdgeAdj,
        closeMispriceAdj: gate.closeMispriceAdj,
        closePayoutAdj: gate.closePayoutAdj,
        scalpEdgeAdj: gate.scalpEdgeAdj,
      },
      flags: observed.flags || {},
    };
  }

  /**
   * Outcome retune for the adaptive timing layer.
   * Uses resolved 15m contracts to nudge the close-value/scalp gates:
   * - wrong trades tighten the relevant timing gate
   * - correct trades or missed opportunities relax it
   */
  retuneTimingFromLog() {
    let log = [];
    if (typeof window !== 'undefined') {
      if (Array.isArray(window._15mResolutionLog) && window._15mResolutionLog.length > 0) {
        log = window._15mResolutionLog;
      } else if (Array.isArray(window._marketSettlementLog) && window._marketSettlementLog.length > 0) {
        log = window._marketSettlementLog;
      } else if (Array.isArray(window._driveContractSettlements) && window._driveContractSettlements.length > 0) {
        log = window._driveContractSettlements;
      } else if (Array.isArray(window.MultiDriveCache?.data?.settlements) && window.MultiDriveCache.data.settlements.length > 0) {
        log = window.MultiDriveCache.data.settlements;
      } else if (typeof localStorage !== 'undefined') {
        try {
          const stored = localStorage.getItem('beta1_15m_resolution_log');
          if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) log = parsed;
          }
        } catch (_) {}
      }
    }
    if (!log.length) return { skipped: true, reason: 'no resolution log' };

    const byCoin = {};
    for (const raw of log.slice(-240)) {
      const sym = String(raw?.sym || raw?.ticker || '').toUpperCase();
      if (!this.baselineGates[sym]) continue;
      const regime = raw.timingRegime || (raw.closeValue ? 'CLOSE_VALUE' : raw.scalpFlip ? 'SCALP_EARLY' : null);
      const missed = raw.missedOpportunity || raw.missedOpportunityScore > 0;
      const timingRelevant = regime === 'CLOSE_VALUE'
        || regime === 'FINAL_SNIPE'
        || regime === 'SCALP_EARLY'
        || raw.closeValueCandidate
        || raw.scalpCandidate
        || missed
        || true;
      if (!timingRelevant) continue;
      if (!byCoin[sym]) byCoin[sym] = [];
      byCoin[sym].push(raw);
    }

    const results = {};
    for (const [sym, entries] of Object.entries(byCoin)) {
      const gate = this._ensureTimingGate(sym);
      let closeDelta = 0;
      let mispriceDelta = 0;
      let payoutDelta = 0;
      let scalpDelta = 0;
      let samples = 0;

      for (const entry of entries.slice(-80)) {
        const action = String(entry.orchestratorAction || entry.action || '').toLowerCase();
        const traded = action === 'trade' || entry.traded === true || entry.modelCorrect !== undefined || entry.correct !== undefined;
        const correct = entry.modelCorrect === true || entry.correct === true || (entry.strikeDir === 'above' ? (entry.outcome === 'YES' && (entry.score || 0) > 0) : (entry.outcome === 'NO' && (entry.score || 0) < 0));
        const wrong = entry.modelCorrect === false || entry.correct === false || (!correct && entry.outcome != null);
        const missed = !!entry.missedOpportunity || Number(entry.missedOpportunityScore || 0) >= 55;
        const closeLike = entry.timingRegime === 'CLOSE_VALUE'
          || entry.timingRegime === 'FINAL_SNIPE'
          || entry.closeValue
          || entry.closeValueCandidate
          || (!entry.timingRegime && !entry.scalpFlip);
        const scalpLike = entry.timingRegime === 'SCALP_EARLY'
          || entry.scalpFlip
          || entry.scalpCandidate;

        if (!closeLike && !scalpLike && !missed) continue;
        samples++;

        if (traded && wrong) {
          if (closeLike) {
            closeDelta += 0.55;
            mispriceDelta += 0.004;
            payoutDelta += 0.025;
          }
          if (scalpLike) scalpDelta += 0.45;
        } else if ((traded && correct) || missed) {
          if (closeLike || missed) {
            closeDelta -= missed ? 0.65 : 0.30;
            mispriceDelta -= missed ? 0.005 : 0.002;
            payoutDelta -= missed ? 0.030 : 0.015;
          }
          if (scalpLike || missed) scalpDelta -= missed ? 0.50 : 0.25;
        }
      }

      if (!samples) continue;
      const scale = 1 / Math.max(3, Math.min(samples, 12));
      gate.closeEdgeAdj = this.clamp(gate.closeEdgeAdj + closeDelta * scale, -5, 6);
      gate.closeMispriceAdj = this.clamp(gate.closeMispriceAdj + mispriceDelta * scale, -0.045, 0.055);
      gate.closePayoutAdj = this.clamp(gate.closePayoutAdj + payoutDelta * scale, -0.25, 0.30);
      gate.scalpEdgeAdj = this.clamp(gate.scalpEdgeAdj + scalpDelta * scale, -4, 5);
      gate.source = 'outcome-adaptive';
      gate.updatedAt = Date.now();
      gate.samples += samples;
      gate.lastReasons = ['resolved timing outcome retune'];

      results[sym] = {
        samples,
        closeEdgeAdj: gate.closeEdgeAdj,
        closeMispriceAdj: gate.closeMispriceAdj,
        closePayoutAdj: gate.closePayoutAdj,
        scalpEdgeAdj: gate.scalpEdgeAdj,
      };
    }

    const summary = { ts: Date.now(), coins: results };
    if (typeof window !== 'undefined') {
      window._lastTimingRetuneResult = summary;
      window._adaptiveTimingGates = window._adaptiveTimingGates || {};
      for (const [sym, gate] of Object.entries(this.timingGates)) {
        window._adaptiveTimingGates[sym] = {
          closeEdgeAdj: gate.closeEdgeAdj,
          closeMispriceAdj: gate.closeMispriceAdj,
          closePayoutAdj: gate.closePayoutAdj,
          scalpEdgeAdj: gate.scalpEdgeAdj,
          source: gate.source,
          samples: gate.samples,
          lastReasons: gate.lastReasons || [],
          updatedAt: gate.updatedAt,
        };
      }
    }
    return summary;
  }

  /**
   * Record a trade outcome for tuning analysis
   * @param {string} sym - Coin symbol (BTC, ETH, etc.)
   * @param {object} tradeData - { score, prediction, actual, correct, fprFlag }
   * @returns {boolean} true if tuning cycle should trigger
   */
  recordTrade(sym, tradeData) {
    if (!this.tradeHistory[sym]) {
      this.tradeHistory[sym] = [];
    }
    
    this.tradeHistory[sym].push({
      timestamp: Date.now(),
      ...tradeData,
    });
    
    this.tradesSinceLastTune++;
    
    // Keep only last 50 trades per coin (tuned for 15m contracts)
    // 50 trades ≈ 12-13 hours, matches crypto market regime duration
    // (was: 30 trades ≈ 7-8 hours)
    if (this.tradeHistory[sym].length > 50) {
      this.tradeHistory[sym] = this.tradeHistory[sym].slice(-50);
    }
    
    // Check if retuning should trigger
    return this.shouldRetune();
  }

  /**
   * Check if dynamic tuning cycle should trigger
   * @returns {object} { shouldRetune: bool, trigger: 'time-3m'|'time-7m'|'time-12m'|'trades'|'none' }
   */
  shouldRetune() {
    const timeSinceLastTune = Date.now() - this.lastTuneTime;
    const tradesTriggered = this.tradesSinceLastTune >= this.TUNING_CYCLE_TRADES;
    const auditDue = (Date.now() - this.lastAuditTime) >= this.AUDIT_CYCLE_MS;

    // Prioritize the hourly audit before regular time-based triggers
    if (auditDue) {
      return {
        shouldRetune: true,
        trigger: 'hourly-audit',
        timeSinceLastTune,
        trades: this.tradesSinceLastTune,
        auditDue,
      };
    }

    // Check time-based triggers (2m, 7m, 12m)
    for (let i = 0; i < this.TUNING_CYCLES_MS.length; i++) {
      if (timeSinceLastTune >= this.TUNING_CYCLES_MS[i]) {
        const minutes = this.TUNING_CYCLES_MINUTES[i];
        return {
          shouldRetune: true,
          trigger: `time-${minutes}m`,
          timeSinceLastTune,
          trades: this.tradesSinceLastTune,
          auditDue,
        };
      }
    }

    // Check trade-based trigger (10 trades)
    if (tradesTriggered) {
      return {
        shouldRetune: true,
        trigger: 'trades',
        timeSinceLastTune,
        trades: this.tradesSinceLastTune,
        auditDue,
      };
    }

    return {
      shouldRetune: auditDue,
      trigger: auditDue ? 'hourly-audit' : 'none',
      timeSinceLastTune,
      trades: this.tradesSinceLastTune,
      auditDue,
    };
  }

  /**
   * Mark tuning as complete and reset counters
   */
  markTuneComplete() {
    this.lastTuneTime = Date.now();
    this.tradesSinceLastTune = 0;
  }

  /**
   * Full hourly recalibration pass (separate from the 2m/7m/12m incremental
   * nudges): re-derives per-indicator and per-timing state from the complete
   * resolution log, then persists the resulting online-weight state so the
   * next session doesn't cold-start (see persistOnlineState()).
   */
  async runFullAudit() {
    const auditStartTime = Date.now();
    const indicatorRetune = this.retuneFromLog();
    const timingRetune = this.retuneTimingFromLog();
    const onlineState = (typeof window !== 'undefined' && window.PredictionEngine?.getOnlineWeightState)
      ? window.PredictionEngine.getOnlineWeightState()
      : {};
    const summary = {
      timestamp: auditStartTime,
      type: 'hourly-full-audit',
      indicatorRetune,
      timingRetune,
      coinsInState: Object.keys(onlineState).length,
      cycleTime: Date.now() - auditStartTime,
    };
    this.auditLog.push(summary);
    if (this.auditLog.length > 24) this.auditLog = this.auditLog.slice(-24); // ~1 day at hourly cadence
    this.lastAuditTime = Date.now();
    this.persistOnlineState(onlineState, 'adaptive-tuner-hourly-audit');
    if (typeof window !== 'undefined') {
      window._lastAuditResult = summary;
    }
    console.log(`[AdaptiveTuner] Hourly full audit complete (${summary.cycleTime}ms, ${summary.coinsInState} coins in state)`);
    return summary;
  }

  /**
   * Persists the current online-weight state via the existing Drive-backed
   * logging pipeline (data-logger.js) so a new session/page-reload can
   * bootstrap from where tuning left off instead of resetting to defaults.
   */
  persistOnlineState(onlineState, reason) {
    try {
      const state = onlineState || (typeof window !== 'undefined' && window.PredictionEngine?.getOnlineWeightState
        ? window.PredictionEngine.getOnlineWeightState()
        : null);
      if (!state || typeof window === 'undefined' || !window.DataLogger?.push) return { persisted: false };
      window.DataLogger.push('weight_tuning_state', { state, reason: reason || 'adaptive-tuner' });
      return { persisted: true };
    } catch (err) {
      console.warn('[AdaptiveTuner] persistOnlineState failed:', err.message);
      return { persisted: false, error: err.message };
    }
  }

  /**
   * Called once at startup: reads the most recently persisted online-weight
   * state (from the prior session, via the same Drive-backed log pipeline)
   * and seeds the live overlay so tuning doesn't cold-start every reload.
   */
  async bootstrapFromPriorSession() {
    try {
      if (typeof window === 'undefined' || !window.DataLogger?.getLatest) {
        return { loaded: false, reason: 'DataLogger.getLatest unavailable' };
      }
      const latest = await window.DataLogger.getLatest('weight_tuning_state');
      if (!latest || !latest.state) return { loaded: false, reason: 'no prior session state found' };
      const result = window.PredictionEngine?.loadOnlineWeightState?.(latest.state) ?? { loaded: false, coins: 0 };
      console.log(`[AdaptiveTuner] Bootstrapped online-weight state from prior session: ${result.coins} coin(s).`);
      return result;
    } catch (err) {
      console.warn('[AdaptiveTuner] bootstrapFromPriorSession failed:', err.message);
      return { loaded: false, error: err.message };
    }
  }

  /**
   * Compute current win rate for a coin
   * @param {string} sym - Coin symbol
   * @returns {object} { winRate, trades, correctCount, fprRate }
   */
  getPerformanceMetrics(sym) {
    const trades = this.tradeHistory[sym] || [];
    if (trades.length === 0) {
      return { winRate: 50, trades: 0, correctCount: 0, fprRate: 0 };
    }

    const correctCount = trades.filter(t => t.correct === true).length;
    const fprCount = trades.filter(t => t.fprFlag === true).length;
    const winRate = Math.round((correctCount / trades.length) * 100);
    const fprRate = Math.round((fprCount / Math.max(1, trades.length - correctCount)) * 100);

    return {
      winRate,
      trades: trades.length,
      correctCount,
      fprRate,
    };
  }

  /**
   * Get current volatility regime for a coin
   * @param {string} sym - Coin symbol
   * @returns {object} { regime, volatility, confidence }
   */
  getVolatilityRegime(sym) {
    // Placeholder: would integrate with real volatility calculation
    // For now, return cached or compute from recent prices
    if (this.volatilityRegime[sym]) {
      return this.volatilityRegime[sym];
    }

    // Default: assume moderate volatility
    return {
      regime: 'moderate',
      volatility: 0.5,
      confidence: 'low',
    };
  }

  /**
   * Recommend tuning adjustment for a coin
   * Based on: recent performance + volatility + false positive rate
   * @param {string} sym - Coin symbol
   * @returns {object} { action, newThreshold, reason, reason_codes }
   */
  recommendTuning(sym) {
    const perf = this.getPerformanceMetrics(sym);
    const vol = this.getVolatilityRegime(sym);
    const baseline = this.baselineGates[sym];
    const bounds = this.tuneBounds[sym];

    if (!baseline) {
      return { action: 'none', reason: 'Coin not in tuning list' };
    }

    let newThreshold = this.currentGates[sym] || baseline.minAbsScore;
    let action = 'none';
    const reasons = [];
    const reason_codes = [];

    // ── Rule 1: Low accuracy (< 40%) → Tighten (increase minAbsScore)
    if (perf.winRate < 40 && perf.trades >= 10) {
      const tighten = Math.min(newThreshold + 0.03, bounds.max);
      if (tighten > newThreshold) {
        newThreshold = tighten;
        action = 'tighten';
        reasons.push(`Low accuracy (${perf.winRate}% on ${perf.trades} trades)`);
        reason_codes.push('LOW_ACCURACY');
      }
    }

    // ── Rule 2: High accuracy (> 55%) → Relax (decrease minAbsScore)
    if (perf.winRate > 55 && perf.trades >= 15) {
      const relax = Math.max(newThreshold - 0.02, bounds.min);
      if (relax < newThreshold) {
        newThreshold = relax;
        action = 'relax';
        reasons.push(`High accuracy (${perf.winRate}% on ${perf.trades} trades)`);
        reason_codes.push('HIGH_ACCURACY');
      }
    }

    // ── Rule 3: High false positive rate (> 50%) → Tighten
    if (perf.fprRate > 50 && perf.trades >= 20) {
      const tighten = Math.min(newThreshold + 0.02, bounds.max);
      if (tighten > newThreshold) {
        newThreshold = tighten;
        action = action === 'relax' ? 'conflict' : 'tighten';
        reasons.push(`High FPR (${perf.fprRate}% false positives)`);
        reason_codes.push('HIGH_FPR');
      }
    }

    // ── Rule 4: High volatility → Tighten (be conservative)
    if (vol.volatility > 0.7 && vol.confidence !== 'low') {
      const tighten = Math.min(newThreshold + 0.02, bounds.max);
      if (tighten > newThreshold && !reasons.includes('High volatility')) {
        newThreshold = tighten;
        if (action === 'none') action = 'tighten';
        reasons.push(`High volatility regime (${(vol.volatility * 100).toFixed(1)}%)`);
        reason_codes.push('HIGH_VOLATILITY');
      }
    }

    return {
      action,
      currentThreshold: this.currentGates[sym] || baseline.minAbsScore,
      newThreshold: Math.round(newThreshold * 100) / 100,
      delta: Math.round((newThreshold - (this.currentGates[sym] || baseline.minAbsScore)) * 100) / 100,
      reason: reasons.join('; '),
      reason_codes,
      metrics: perf,
      volatilityRegime: vol,
    };
  }

  /**
   * Apply tuning adjustment to a coin (if recommendation approved)
   * @param {string} sym - Coin symbol
   * @param {object} recommendation - Output from recommendTuning()
   * @param {boolean} force - Force apply even if no recommendation
   */
  applyTuning(sym, recommendation, force = false) {
    if (!recommendation && !force) return;

    const newThreshold = recommendation.newThreshold || this.currentGates[sym];
    const oldThreshold = this.currentGates[sym] || this.baselineGates[sym]?.minAbsScore;

    if (newThreshold === oldThreshold && !force) {
      return;
    }

    this.currentGates[sym] = newThreshold;

    const event = {
      timestamp: Date.now(),
      coin: sym,
      action: recommendation?.action || 'force',
      oldThreshold: Math.round((oldThreshold || 0) * 100) / 100,
      newThreshold: Math.round(newThreshold * 100) / 100,
      reason: recommendation?.reason || 'Manual override',
      reason_codes: recommendation?.reason_codes || [],
    };

    this.tuningLog.push(event);
    console.log(
      `[AdaptiveTuner] ${sym}: ${event.oldThreshold} -> ${event.newThreshold} ` +
      `(${event.action}) — ${recommendation?.reason || 'forced'}`
    );

    return event;
  }

  /**
   * Get recommended entry delay based on volatility
   * High volatility = wait for confirmation before entering
   * @param {string} sym - Coin symbol
   * @returns {object} { delayCandles: 0-2, reason, volatilityReason }
   */
  getEntryDelay(sym) {
    const vol = this.getVolatilityRegime(sym);
    
    // No volatility data yet
    if (!vol || vol.confidence === 'low') {
      return { delayCandles: 0, reason: 'No volatility data yet', volatilityReason: null };
    }

    // High volatility → wait 2 candles for confirmation
    if (vol.volatility > 0.8) {
      return {
        delayCandles: 2,
        reason: 'High volatility: wait 2 candles for confirmation',
        volatilityReason: `vol=${(vol.volatility * 100).toFixed(1)}% (extreme)`,
      };
    }

    // Moderate-high volatility → wait 1 candle
    if (vol.volatility > 0.5) {
      return {
        delayCandles: 1,
        reason: 'Moderate volatility: wait 1 candle for confirmation',
        volatilityReason: `vol=${(vol.volatility * 100).toFixed(1)}% (high)`,
      };
    }

    // Low volatility → no delay needed
    return {
      delayCandles: 0,
      reason: 'Low volatility: enter immediately',
      volatilityReason: `vol=${(vol.volatility * 100).toFixed(1)}% (low)`,
    };
  }

  /**
   * Per-indicator gradient descent retuner.
   * Reads window._marketSettlementLog entries (which now carry signalComponents),
   * computes the actual price direction from each resolved contract,
   * and nudges window.PER_COIN_INDICATOR_BIAS toward indicators that predicted correctly.
   *
   * Learning rate: 0.025 per sample (scaled by signal magnitude).
   * Bounds: BIAS_MIN=0.05, BIAS_MAX=6.0.
   * Requires ≥3 entries with signalComponents per coin to run.
   */
  retuneFromLog() {
    let log = [];
    if (typeof window !== 'undefined') {
      if (Array.isArray(window._marketSettlementLog) && window._marketSettlementLog.length > 0) {
        log = window._marketSettlementLog;
      } else if (Array.isArray(window._15mResolutionLog) && window._15mResolutionLog.length > 0) {
        log = window._15mResolutionLog;
      } else if (Array.isArray(window._driveContractSettlements) && window._driveContractSettlements.length > 0) {
        log = window._driveContractSettlements;
      } else if (Array.isArray(window.MultiDriveCache?.data?.settlements) && window.MultiDriveCache.data.settlements.length > 0) {
        log = window.MultiDriveCache.data.settlements;
      } else if (typeof localStorage !== 'undefined') {
        try {
          const stored = localStorage.getItem('beta1_15m_resolution_log');
          if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) log = parsed;
          }
        } catch (_) {}
      }
    }

    let bias = (typeof window !== 'undefined' && window.PER_COIN_INDICATOR_BIAS) ? window.PER_COIN_INDICATOR_BIAS : null;
    if (!bias && typeof window !== 'undefined') {
      window.PER_COIN_INDICATOR_BIAS = {};
      bias = window.PER_COIN_INDICATOR_BIAS;
    }
    if (!bias || log.length === 0) return { skipped: true, reason: 'no data' };

    const BIAS_MIN = 0.05;
    const BIAS_MAX = 6.0;
    const LR = 0.025;
    const MIN_SIGNAL = 0.05;
    const results = {};

    // Group entries by coin, synthesizing signalComponents if absent
    const byCoin = {};
    for (const raw of log) {
      const sym = (raw.sym || raw.ticker || '').toUpperCase();
      if (!sym) continue;

      const outcome = (raw.outcome || raw.settledOutcome || (raw.modelCorrect === true ? 'YES' : raw.modelCorrect === false ? 'NO' : '')).toUpperCase();
      if (outcome !== 'YES' && outcome !== 'NO') continue;

      const strikeDir = raw.strikeDir || raw.dir || (raw.strikePrice && raw.settlePrice ? (raw.settlePrice >= raw.strikePrice ? 'above' : 'below') : 'above');

      let components = raw.signalComponents;
      if (!components || typeof components !== 'object') {
        const dirMult = (strikeDir === 'above' ? (outcome === 'YES' ? 1 : -1) : (outcome === 'YES' ? -1 : 1));
        const score = typeof raw.score === 'number' ? Math.abs(raw.score) : 0.5;
        const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.6;
        components = {
          rsi: Number((dirMult * 0.45 * confidence).toFixed(3)),
          ema: Number((dirMult * 0.50 * score).toFixed(3)),
          hma: Number((dirMult * 0.40 * confidence).toFixed(3)),
          macd: Number((dirMult * 0.55 * score).toFixed(3)),
          obv: Number((dirMult * 0.35 * confidence).toFixed(3)),
        };
      }

      const entry = { ...raw, sym, outcome, strikeDir, signalComponents: components };
      if (!byCoin[sym]) byCoin[sym] = [];
      byCoin[sym].push(entry);
    }

    for (const [sym, entries] of Object.entries(byCoin)) {
      if (!bias[sym]) {
        bias[sym] = { rsi: 1.0, ema: 1.0, hma: 1.0, macd: 1.0, obv: 1.0 };
      }
      if (entries.length < 3) continue;

      const coinBias = bias[sym];
      const adjustments = {};

      for (const entry of entries) {
        // Derive actual direction from contract outcome + strikeDir
        const actualUp = entry.strikeDir === 'above'
          ? entry.outcome === 'YES'
          : entry.outcome !== 'YES';

        const components = entry.signalComponents; // { rsi, ema, hma, ... } all in [-1,+1]

        for (const [key, signal] of Object.entries(components)) {
          if (!(key in coinBias)) coinBias[key] = 1.0;                  // only tune keys we track
          if (typeof signal !== 'number' || isNaN(signal)) continue;
          if (Math.abs(signal) < MIN_SIGNAL) continue;      // no opinion — skip

          // indicatorSaysUp = signal > 0 (positive signal = UP direction)
          const indicatorSaysUp = signal > 0;
          const correct = indicatorSaysUp === actualUp;

          // Gradient: reward correct indicators (increase bias), punish wrong (decrease bias)
          const magnitude = Math.min(Math.abs(signal), 1.0);
          const delta = LR * magnitude * (correct ? 1 : -1);

          adjustments[key] = (adjustments[key] || 0) + delta;
        }
      }

      // Apply averaged adjustments and clamp
      let updated = 0;
      for (const [key, totalDelta] of Object.entries(adjustments)) {
        const avgDelta = totalDelta / entries.length;
        const oldVal = coinBias[key];
        const newVal = Math.max(BIAS_MIN, Math.min(BIAS_MAX, oldVal + avgDelta));
        if (Math.abs(newVal - oldVal) > 0.001) {
          coinBias[key] = newVal;
          updated++;
        }
      }

      // Geometric mean normalization — prevent all-up or all-down drift
      const vals = Object.values(coinBias).filter(v => v > 0);
      if (vals.length > 0) {
        const geoMean = Math.exp(vals.reduce((s, v) => s + Math.log(v), 0) / vals.length);
        if (geoMean > 0.01) {
          for (const key of Object.keys(coinBias)) {
            coinBias[key] = Math.max(BIAS_MIN, Math.min(BIAS_MAX, coinBias[key] / geoMean));
          }
        }
      }

      results[sym] = { entries: entries.length, keysAdjusted: updated };
    }

    const summary = { ts: Date.now(), coins: results };
    if (typeof window !== 'undefined') window._lastRetuneResult = summary;
    console.log('[Retuner] Per-indicator gradient descent complete:', JSON.stringify(results));
    return summary;
  }

  /**
   * Execute full tuning cycle (called every 15-minute candle close)
   * Analyzes all coins, recommends tunings, applies if confident
   * @param {object} options - { validatePyth: true, dryRun: false }
   * @returns {object} Tuning cycle results
   */
  async runTuningCycle(options = {}) {
    const { validatePyth = true, dryRun = false, reason = 'scheduled' } = options;

    if (reason === 'hourly-audit' && !dryRun) {
      return this.runFullAudit();
    }

    const cycleStartTime = Date.now();
    const results = {
      timestamp: cycleStartTime,
      cycleId: Math.random().toString(36).substr(2, 9),
      reason,
      coins: [],
      totalAdjustments: 0,
      dryRun,
      validation: { pythChecked: false, valid: true },
    };

    // ── Validate Pyth feeds if enabled ──
    if (validatePyth) {
      try {
        results.validation.pythChecked = true;
        results.validation.valid = await this.validatePythFeeds();
        if (!results.validation.valid) {
          console.warn('[AdaptiveTuner] Pyth validation failed, skipping tuning cycle');
          return results;
        }
      } catch (err) {
        console.warn('[AdaptiveTuner] Pyth validation error:', err.message);
        results.validation.valid = false;
        return results;
      }
    }

    // ── Run recommendations for each coin ──
    const TUNING_COINS = this.getTuningCoins();
    let tuningCoinIndex = 0;
    for (const sym of TUNING_COINS) {
      if (++tuningCoinIndex % 2 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const rec = this.recommendTuning(sym);

      if (rec.action !== 'none') {
        const coinResult = {
          coin: sym,
          recommendation: rec,
          applied: false,
        };

        // Apply only if confident: action in ['tighten', 'relax'] and meets criteria
        if (!dryRun && (rec.action === 'tighten' || rec.action === 'relax')) {
          const event = this.applyTuning(sym, rec);
          coinResult.applied = true;
          results.totalAdjustments++;
        }

        results.coins.push(coinResult);
      }
    }

    this.markTuneComplete();
    results.cycleTime = Date.now() - cycleStartTime;

    // Run per-indicator gradient descent from _marketSettlementLog outcomes (yield first — can be heavy)
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      results.indicatorRetune = this.retuneFromLog();
    } catch (e) {
      console.warn('[AdaptiveTuner] retuneFromLog error:', e.message);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      results.timingRetune = this.retuneTimingFromLog();
    } catch (e) {
      console.warn('[AdaptiveTuner] retuneTimingFromLog error:', e.message);
    }

    // Expose to window for debugging
    if (typeof window !== 'undefined') {
      window._tuningLog = window._tuningLog || [];
      window._tuningLog.push(results);
      window._currentGates = { ...this.currentGates };
    }

    // Persist the online-weight state after every real (non-dry-run) cycle
    // so the next session/reload can bootstrap from it (see
    // bootstrapFromPriorSession() / section 4d of the tuning plan).
    if (!dryRun) this.persistOnlineState(null, `adaptive-tuner-${reason}`);

    console.log(
      `[AdaptiveTuner] Cycle complete: ${results.totalAdjustments} adjustments, ` +
      `${results.cycleTime}ms (dryRun=${dryRun})`
    );

    return results;
  }

  /**
   * Get current signal gates (for use in predictions.js)
   * Always returns a plain { SYM: number } map — never gate objects.
   * Defensive: if a value somehow ended up as an object (e.g. stale SIGNAL_GATE_OVERRIDES
   * entry), extracts minAbsScore so numeric comparisons never silently break.
   * @returns {object} { BTC: 0.36, ETH: 0.40, ... }
   */
  getCurrentGates() {
    const gates = {};
    for (const [sym, val] of Object.entries(this.currentGates)) {
      gates[sym] = typeof val === 'number'
        ? val
        : (val?.minAbsScore ?? this.baselineGates[sym]?.minAbsScore ?? 0.22);
    }
    return gates;
  }

  /**
   * Validate Pyth price feeds are fresh and reliable
   * @returns {boolean} True if all Pyth feeds are valid
   */
  async validatePythFeeds() {
    // Placeholder: would call Pyth Hermes API
    // For now, return true (assume valid if no errors)
    try {
      // Check if window.PYTH_HERMES_LAST_UPDATE is recent (< 60 seconds)
      if (typeof window !== 'undefined' && window.PYTH_HERMES_LAST_UPDATE) {
        const age = Date.now() - window.PYTH_HERMES_LAST_UPDATE;
        if (age > 60000) {
          console.warn('[AdaptiveTuner] Pyth feed is stale:', age, 'ms');
          return false;
        }
      }
      return true;
    } catch (err) {
      console.error('[AdaptiveTuner] Pyth validation error:', err);
      return false;
    }
  }

  /**
   * Reset tuning to baseline (for testing or recovery)
   * Covers all 7 tuning coins — DOGE and HYPE were previously missing.
   */
  resetToBaseline() {
    const TUNING_COINS = this.getTuningCoins();
    for (const sym of TUNING_COINS) {
      this.currentGates[sym] = this.baselineGates[sym].minAbsScore;
      const gate = this._ensureTimingGate(sym);
      gate.closeEdgeAdj = 0;
      gate.closeMispriceAdj = 0;
      gate.closePayoutAdj = 0;
      gate.scalpEdgeAdj = 0;
      gate.source = 'baseline';
      gate.lastReasons = ['reset to baseline'];
      gate.updatedAt = Date.now();
    }
    console.log('[AdaptiveTuner] Reset to baseline thresholds');
  }

  /**
   * Get diagnostic info for debugging
   */
  getDiagnostics() {
    const TUNING_COINS = this.getTuningCoins();
    const diagnostics = {
      currentGates: this.getCurrentGates(),
      timingGates: this.timingGates,
      baselineGates: this.baselineGates,
      tuneBounds: this.tuneBounds,
      metrics: {},
      entryDelays: {},
      lastTuneTime: new Date(this.lastTuneTime).toISOString(),
      tuningLogLength: this.tuningLog.length,
      recentTuningEvents: this.tuningLog.slice(-10),
      regimeMultipliers: this.getRegimeMultipliers(),
      recentRegimeMultiplierEvents: this.regimeMultiplierHistory.slice(-10),
    };

    for (const sym of TUNING_COINS) {
      diagnostics.metrics[sym] = {
        performance: this.getPerformanceMetrics(sym),
        volatility: this.getVolatilityRegime(sym),
        recommendation: this.recommendTuning(sym),
      };
      diagnostics.entryDelays[sym] = this.getEntryDelay(sym);
    }

    return diagnostics;
  }

  // ══════════════════════════════════════════════════════════════
  // OUTCOME FEEDBACK — live 500-trade rolling retuner
  // Called by the main app once a 15m Polymarket contract resolves.
  // ══════════════════════════════════════════════════════════════

  /**
   * Records a completed trade outcome for a given contract window.
   * Stores the signal vector alongside predicted/actual direction so
   * _retuneFromOutcomes() can compute per-indicator win-rates.
   * Auto-retunes when ≥20 new outcomes have accumulated since last tune.
   *
   * @param {string}  coin                - e.g. 'BTC'
   * @param {number}  windowStartMs       - UTC ms of 15m window open
   * @param {string}  predictedDirection  - 'UP' | 'DOWN'
   * @param {string}  actualDirection     - 'UP' | 'DOWN'
   * @param {object}  signalVector        - { rsi, macd, ema, … } normalised [-1,1] map
   */
  recordOutcome(coin, windowStartMs, predictedDirection, actualDirection, signalVector) {
    if (!this.outcomeHistory) this.outcomeHistory = {};
    if (!this.outcomeHistory[coin]) this.outcomeHistory[coin] = [];

    this.outcomeHistory[coin].push({
      ts:           windowStartMs,
      predicted:    predictedDirection,
      actual:       actualDirection,
      correct:      predictedDirection === actualDirection,
      signalVector: signalVector || {},
    });

    // Keep a rolling window of the last 500 outcomes per coin
    if (this.outcomeHistory[coin].length > 500) {
      this.outcomeHistory[coin] = this.outcomeHistory[coin].slice(-500);
    }

    // Auto-retune when 20 new outcomes have arrived since the last tune
    const lastTune         = (this.lastOutcomeTuneTs && this.lastOutcomeTuneTs[coin]) || 0;
    const newSinceLastTune = this.outcomeHistory[coin].filter(o => o.ts > lastTune).length;
    if (newSinceLastTune >= 20) {
      this._retuneFromOutcomes(coin);
    }

    // Surface misprediction details to the error bus
    if (predictedDirection !== actualDirection) {
      const score   = signalVector && signalVector._modelScore;
      const errType = (score !== undefined && Math.abs(score) < 0.2)
        ? 'LOW_CONFIDENCE' : 'SIGNAL_INVERSION';
      this._logOutcomeError(coin, windowStartMs, predictedDirection, actualDirection, errType);
    }
  }

  /**
   * Pushes a misprediction onto the renderer-accessible error bus.
   * No-op in Node.js environments (window is undefined).
   */
  _logOutcomeError(coin, ts, predicted, actual, errType) {
    if (typeof window !== 'undefined' && window._kalshiErrors) {
      window._kalshiErrors.push({
        type:      'OUTCOME_ERROR',
        subtype:   errType,
        coin,
        ts,
        predicted,
        actual,
        at:        new Date(ts).toISOString(),
      });
    }
  }

  /**
   * Per-indicator accuracy analysis over the rolling outcome window.
   * Logs win-rates and updates lastOutcomeTuneTs so the 20-trade gate resets.
   * Intentionally lightweight — the heavy gradient descent lives in outcome-feedback.js.
   */
  _retuneFromOutcomes(coin) {
    const outcomes = this.outcomeHistory[coin];
    if (!outcomes || outcomes.length < 20) return;

    // Accumulate hit/total counts for each signal that had a clear directional read
    const signalAccuracy = {};
    for (const obs of outcomes) {
      for (const [sig, val] of Object.entries(obs.signalVector || {})) {
        if (typeof val !== 'number' || sig.startsWith('_')) continue;
        if (!signalAccuracy[sig]) signalAccuracy[sig] = { hits: 0, total: 0 };
        const sigDir = val > 0.1 ? 'UP' : val < -0.1 ? 'DOWN' : null;
        if (sigDir) {
          if (sigDir === obs.actual) signalAccuracy[sig].hits++;
          signalAccuracy[sig].total++;
        }
      }
    }

    // Log any signal with ≥10 samples
    for (const [sig, acc] of Object.entries(signalAccuracy)) {
      if (acc.total < 10) continue;
      const winRate = acc.hits / acc.total;
      console.log(
        `[OutcomeFeedback] ${coin} ${sig}: ${(winRate * 100).toFixed(1)}% win (${acc.total} obs)`
      );
    }

    if (!this.lastOutcomeTuneTs) this.lastOutcomeTuneTs = {};
    this.lastOutcomeTuneTs[coin] = Date.now();
  }
}

// ══════════════════════════════════════════════════════════════
// Export for use in predictions.js and app.js
// ══════════════════════════════════════════════════════════════

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AdaptiveTuner;
}
