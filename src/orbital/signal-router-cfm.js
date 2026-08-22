// ================================================================
// WE|||CRYPTO — CFM Signal Router v1
// Floating router: maps live CFM multi-exchange data + true
// outcome history into the prediction engine as anchor packets.
//
// Reads:  window._cfm[sym]      — 15m VWM multi-exchange benchmarks
//         window._predLog       — rolling true outcome history
//         window._lastPrediction— active prediction per coin
//
// Injects into computePrediction() in predictions.js:
//   1. CFM-derived signal packets (4 types) appended to router pool
//   2. Outcome calibration multiplier (self-tuning per coin)
//   3. Stand-aside singularity resolver — more opportunities
//   4. CFM score anchor — sharper directional magnitude
//   5. Early exit detector — CFM momentum reversal vs active call
//   6. CFM quality gate (convergence + spread) — quality multiplier
//   7. CFM history buffer — spread spikes, trend flips, CV loss
//   8. CFM conflict suppression — penalise when CFM opposes trade
//
// Loaded sync before predictions.js (defer). No auth required.
// ================================================================

(function () {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ── CFM HISTORY BUFFER ──────────────────────────────────────────
  // Keeps a rolling snapshot of the last 8 CFM readings per coin
  // for detecting trend flips, spread spikes, and convergence loss.
  const _cfmHistory = {}; // sym → [{ momentum, trend, spread, convergence, ts }]
  const CFM_HIST_MAX = 8;

  function recordCFMSnapshot(sym, cfm) {
    if (!_cfmHistory[sym]) _cfmHistory[sym] = [];
    _cfmHistory[sym].push({
      momentum: cfm.momentum || 0,
      trend: cfm.trend || 'flat',
      spread: cfm.spread || 0,
      convergence: cfm.convergence || 0,
      sourceCount: cfm.sourceCount || 0,
      ts: Date.now(),
    });
    if (_cfmHistory[sym].length > CFM_HIST_MAX) _cfmHistory[sym].shift();
  }

  // ── 0. CFM QUALITY GATE ─────────────────────────────────────────
  // Returns a 0–1 quality multiplier applied to all CFM packets.
  //   convergence = cross-exchange price dispersion (lower = better)
  //   spread      = max-min / min across all sources (lower = better)
  //   sourceCount = must be >= 3 to trust directional signal
  function buildCFMQuality(cfm) {
    if (!cfm || !cfm.cfmRate || cfm.sourceCount < 2) return 0;
    if (cfm.sourceCount < 3) return 0.35; // weak — still usable as soft signal

    const cvQuality = clamp(1 - (cfm.convergence || 0) / 0.15, 0, 1); // 0%CV→1.0, ≥0.15%→0
    const spreadPenalty = (cfm.spread || 0) > 0.12 ? 0.4 : 1.0;           // wide spread = fragmented
    const sourceMult = Math.min(1.0, 0.65 + cfm.sourceCount * 0.07);   // 3→0.86, 5→1.0
    return clamp(cvQuality * spreadPenalty * sourceMult, 0, 1);
  }

  // ── 1. OUTCOME CALIBRATION ──────────────────────────────────────
  // Blends two sources for per-coin calibration:
  //   _predLog (candle direction accuracy)         weight: 1.0
  //   _15mResolutionLog (Polymarket settled outcomes)  weight: 1.5
  // Market-settled data is weighted higher: clean external binary
  // oracle, not intra-bar candle noise.
  //
  // accuracy 35% -> 0.82x  |  50% -> 1.0x  |  70% -> 1.14x
  // Streak +3 correct adds +0.04. Declining accuracy penalises.
  function buildOutcomeCalibration(sym, n = 24) {

    // ---- Source A: candle-based _predLog -------------------------
    // Internally-graded against this app's own 15-minute candle bucket
    // (src/feeds/candle-ws.js), not any venue's real settlement.
    const candleLog = (window._predLog || [])
      .filter(e => e.sym === sym && e.predDir !== 'FLAT');

    // ---- Source B: Polymarket-settled _15mResolutionLog -------
    // MarketResolver writes this when Polymarket 15m markets settle
    // (5m and 15m share this log; the "_15m" name is historical).
    // Each entry has { sym, modelCorrect (bool|null), ... }
    const resolvedLog = (window._15mResolutionLog || [])
      .filter(e => e.sym === sym && e.modelCorrect !== null);

    // ---- Source C: Polymarket-settled _5mResolutionLog -----------
    // src/prediction-markets/poly5m-resolution-tracker.js -- graded against the actual
    // Chainlink TWAP-30s settlement of the actual 5-minute contracts traded,
    // not an internal proxy. Weighted highest of the three: it's genuine
    // ground truth for the venue/horizon actually in play.
    const poly5mLog = (window._5mResolutionLog || [])
      .filter(e => e.sym === sym && typeof e.correct === 'boolean');

    const hasCandle = candleLog.length >= 2;
    const hasResolved = resolvedLog.length >= 2;
    const hasPoly5m = poly5mLog.length >= 2;
    if (!hasCandle && !hasResolved && !hasPoly5m) {
      return { multiplier: 1.0, accuracy: null, streak: 0, trend: 'cold', n: 0, source: 'none' };
    }

    // ---- Per-source accuracy ------------------------------------
    const candleRecent = candleLog.slice(-n);
    const resolvedRecent = resolvedLog.slice(-Math.ceil(n * 0.75));
    const poly5mRecent = poly5mLog.slice(-n);

    const candleAcc = hasCandle
      ? candleRecent.filter(e => e.correct).length / candleRecent.length : null;
    const resolvedAcc = hasResolved
      ? resolvedRecent.filter(e => e.modelCorrect).length / resolvedRecent.length : null;
    const poly5mAcc = hasPoly5m
      ? poly5mRecent.filter(e => e.correct).length / poly5mRecent.length : null;

    // ---- Blend: poly5m (real settlement) at 2x, resolved at 1.5x --
    let accuracy, blendedN;
    const parts = [
      hasCandle ? { acc: candleAcc, w: 1.0, n: candleRecent.length } : null,
      hasResolved ? { acc: resolvedAcc, w: 1.5, n: resolvedRecent.length } : null,
      hasPoly5m ? { acc: poly5mAcc, w: 2.0, n: poly5mRecent.length } : null,
    ].filter(Boolean);
    if (parts.length > 1) {
      const wSum = parts.reduce((s, p) => s + p.w * p.n, 0);
      accuracy = parts.reduce((s, p) => s + p.acc * p.w * p.n, 0) / wSum;
      blendedN = parts.reduce((s, p) => s + p.n, 0);
    } else {
      accuracy = parts[0].acc;
      blendedN = parts[0].n;
    }

    // ---- Best available log for trend/streak, poly5m preferred ---
    // (real settlement > resolved-log > internal candle proxy)
    const bestLog = (hasPoly5m && poly5mLog.length >= 6) ? { log: poly5mLog, ok: e => e.correct }
      : (hasResolved && resolvedLog.length >= 6) ? { log: resolvedLog, ok: e => e.modelCorrect }
        : { log: candleLog, ok: e => e.correct };

    // ---- Accuracy trend: last 6 vs prior 6 ----------------------
    const last6 = bestLog.log.slice(-6);
    const prior6 = bestLog.log.slice(-12, -6);
    const l6acc = last6.length ? last6.filter(bestLog.ok).length / last6.length : 0.5;
    const p6acc = prior6.length ? prior6.filter(bestLog.ok).length / prior6.length : 0.5;
    const accDelta = l6acc - p6acc;

    // ---- Streak from best available log -------------------------
    let streak = 0;
    for (let i = bestLog.log.length - 1; i >= 0; i--) {
      const ok = bestLog.ok(bestLog.log[i]);
      if (streak === 0) { streak = ok ? 1 : -1; continue; }
      if ((streak > 0) === ok) streak += ok ? 1 : -1;
      else break;
    }

    const accMult = clamp(0.80 + accuracy * 0.60, 0.82, 1.18);
    const streakAdj = streak >= 3 ? 0.05 : streak >= 2 ? 0.02
      : streak <= -3 ? -0.07 : streak <= -2 ? -0.03 : 0;
    const trendAdj = accDelta > 0.15 ? 0.03 : accDelta < -0.15 ? -0.04 : 0;
    const multiplier = clamp(accMult + streakAdj + trendAdj, 0.78, 1.22);

    return {
      multiplier,
      accuracy: +(accuracy * 100).toFixed(1),
      candleAccuracy: candleAcc !== null ? +(candleAcc * 100).toFixed(1) : null,
      resolvedAccuracy: resolvedAcc !== null ? +(resolvedAcc * 100).toFixed(1) : null,
      resolvedN: resolvedRecent.length,
      poly5mAccuracy: poly5mAcc !== null ? +(poly5mAcc * 100).toFixed(1) : null,
      poly5mN: poly5mRecent.length,
      streak,
      trend: accDelta > 0.10 ? 'improving' : accDelta < -0.10 ? 'declining' : 'stable',
      n: blendedN,
      source: parts.length > 1 ? 'blended' : hasPoly5m ? 'poly5m' : hasResolved ? 'resolved' : 'candle',
    };
  }


  // ── 2. CFM SIGNAL PACKETS ───────────────────────────────────────
  // Converts window._cfm[sym] into router-compatible signal packets.
  // Quality gate is applied to all packets via trust × quality.
  function buildCFMPackets(sym) {
    const cfm = window._cfm?.[sym];
    if (!cfm || !cfm.cfmRate || cfm.cfmRate === 0 || cfm.sourceCount < 2) return [];

    const quality = buildCFMQuality(cfm);
    if (quality < 0.15) return []; // data too fragmented to trust

    const srcTrust = Math.min(0.94, 0.70 + cfm.sourceCount * 0.04) * quality;
    const packets = [];

    // ── Packet A: CFM 15m Trend ─────────────────────────────────
    if (cfm.trend !== 'flat') {
      const dir = cfm.trend === 'rising' ? 1 : -1;
      const momAbs = Math.abs(cfm.momentum || 0);
      const strength = clamp(momAbs / 0.45, 0.12, 0.92);
      packets.push({
        family: 'cfm_trend',
        category: 'benchmark',
        role: 'driver',
        label: 'CFM 15m trend',
        detail: `${cfm.trend} · ${cfm.sourceCount} sources · Δ${cfm.momentum?.toFixed(3) ?? '?'}%`,
        direction: dir,
        strength,
        freshness: 0.95,
        trust: srcTrust,
        relevance: 0.90,
        source: 'cfm',
      });
    }

    // ── Packet B: VWAP15 + TWAP15 Convergence ───────────────────
    if (cfm.sourceCount >= 3 && cfm.vwap15 && cfm.twap15) {
      const vwapDev = ((cfm.cfmRate - cfm.vwap15) / cfm.vwap15) * 100;
      const twapDev = ((cfm.cfmRate - cfm.twap15) / cfm.twap15) * 100;
      const vDir = Math.sign(vwapDev);
      const tDir = Math.sign(twapDev);
      if (vDir === tDir && vDir !== 0 && Math.abs(vwapDev) > 0.03) {
        const strength = clamp((Math.abs(vwapDev) + Math.abs(twapDev)) / 2 / 0.35, 0.10, 0.88);
        packets.push({
          family: 'cfm_convergence',
          category: 'benchmark',
          role: 'driver',
          label: 'CFM VWAP/TWAP convergence',
          detail: `VWAP15 ${vwapDev > 0 ? '+' : ''}${vwapDev.toFixed(3)}% · TWAP15 ${twapDev > 0 ? '+' : ''}${twapDev.toFixed(3)}%`,
          direction: vDir,
          strength,
          freshness: 0.92,
          trust: srcTrust,
          relevance: 0.84,
          source: 'cfm',
        });
      }
    }

    // ── Packet C: Partition Lock (all partitions trending same way)
    if (cfm.partitions?.length >= 3) {
      const valid = cfm.partitions.filter(p => p.vwm !== null && p.vwm > 0);
      if (valid.length >= 3) {
        const allUp = valid.every((p, i) => i === 0 || p.vwm >= valid[i - 1].vwm);
        const allDown = valid.every((p, i) => i === 0 || p.vwm <= valid[i - 1].vwm);
        if (allUp || allDown) {
          const first = valid[0].vwm;
          const last = valid[valid.length - 1].vwm;
          const driftPct = Math.abs((last - first) / first) * 100;
          packets.push({
            family: 'cfm_partition_lock',
            category: 'trend',
            role: 'driver',
            label: 'CFM partition lock',
            detail: `All ${valid.length}×5m buckets ${allUp ? '↑ rising' : '↓ falling'} · ${driftPct.toFixed(3)}% drift`,
            direction: allUp ? 1 : -1,
            strength: clamp(driftPct / 0.28, 0.16, 0.95),
            freshness: 0.96,
            trust: Math.min(0.90, srcTrust + 0.06), // slight bonus for multi-bucket confirmation
            relevance: 0.92,
            source: 'cfm',
          });
        }
      }
    }

    // ── Packet D: Momentum Surge (breakout/breakdown entry) ──────
    const momAbs = Math.abs(cfm.momentum || 0);
    if (momAbs >= 0.08) {
      packets.push({
        family: 'cfm_momentum_surge',
        category: 'momentum',
        role: 'driver',
        label: 'CFM momentum surge',
        detail: `${cfm.momentum > 0 ? '+' : ''}${cfm.momentum?.toFixed(3) ?? '?'}% over 15m window`,
        direction: Math.sign(cfm.momentum || 0),
        strength: clamp(momAbs / 0.32, 0.25, 0.96),
        freshness: 0.94,
        trust: Math.min(0.85, srcTrust + 0.03),
        relevance: 0.88,
        source: 'cfm',
      });
    }

    // ── Packet E: Polymarket Probability Drift (leading indicator) ───────
    // When Polymarket's YES price is trending directionally it signals smart-money
    // positioning BEFORE the CFM model fully catches up.
    const pVel = window.PolymarketWS?.getVelocity?.(sym) || window.PredictionMarkets?.getVelocity?.(sym);
    if (pVel && pVel.trend !== 'flat' && Math.abs(pVel.velCentsPerMin || 0) >= 1.0 && (pVel.samples || 0) >= 3) {
      const pDir = pVel.trend === 'rising' ? 1 : -1;
      const pStrength = clamp(Math.abs(pVel.velCentsPerMin) / 8.0, 0.15, 0.85);
      const accelBoost = ((pVel.acceleration || 0) > 0 && pDir === 1) || ((pVel.acceleration || 0) < 0 && pDir === -1)
        ? Math.min(0.10, Math.abs(pVel.acceleration) / 5.0) : 0;
      packets.push({
        family: 'polymarket_drift',
        category: 'market',
        role: 'driver',
        label: 'Polymarket probability drift',
        detail: `${pVel.trend} ${pVel.velCentsPerMin > 0 ? '+' : ''}${pVel.velCentsPerMin.toFixed(1)}¢/min · ${pVel.samples} pts · latest ${Math.round((pVel.latestProb ?? 0) * 100)}¢`,
        direction: pDir,
        strength: clamp(pStrength + accelBoost, 0.15, 0.85),
        freshness: 0.98,
        trust: 0.92,
        relevance: 0.94,
        source: 'polymarket',
      });
    }

    return packets;
  }

  // ── 3. CFM ALIGNMENT CHECK ──────────────────────────────────────
  // Returns 'confirming' | 'conflicting' | 'neutral' based on whether
  // CFM direction matches the base candle-model score direction.
  // Used in predictions.js to adjust standAsideMultiplier.
  function getCFMAlignment(sym, baseScore) {
    const cfm = window._cfm?.[sym];
    const quality = cfm ? buildCFMQuality(cfm) : 0;
    if (!cfm || quality < 0.30 || Math.abs(cfm.momentum || 0) < 0.04) return 'neutral';

    // Build a composite CFM directional signal
    const momSig = clamp((cfm.momentum || 0) / 0.25, -1, 1);
    const trendSig = cfm.trend === 'rising' ? 1 : cfm.trend === 'falling' ? -1 : 0;
    // Partition slope
    const valid = (cfm.partitions || []).filter(p => p.vwm > 0);
    let partSig = 0;
    if (valid.length >= 3) {
      const allUp = valid.every((p, i) => i === 0 || p.vwm >= valid[i - 1].vwm);
      const allDown = valid.every((p, i) => i === 0 || p.vwm <= valid[i - 1].vwm);
      partSig = allUp ? 1 : allDown ? -1 : 0;
    }
    const cfmSignal = (momSig * 0.50 + trendSig * 0.30 + partSig * 0.20) * quality;

    if (Math.abs(cfmSignal) < 0.06 || baseScore === 0) return 'neutral';

    const timedDir = Math.sign(baseScore);
    const cfmDir = Math.sign(cfmSignal);
    if (timedDir === cfmDir) return 'confirming';
    if (timedDir !== cfmDir) return 'conflicting';
    return 'neutral';
  }

  // ── 4. SINGULARITY RESOLVER ─────────────────────────────────────
  // When stand-aside fires due to directional conflict, check if
  // CFM data resolves it. Returns resolved action + standAsideMultiplier.
  function resolveSingularity(sym, routed, cfmPackets) {
    const base = {
      action: routed.action,
      confidenceMultiplier: routed.confidenceMultiplier,
      standAsideMultiplier: 0.45, // default
      cfmOverride: false,
    };

    if (routed.action !== 'stand-aside') return base;

    const cfm = window._cfm?.[sym];
    const quality = cfm ? buildCFMQuality(cfm) : 0;
    if (!cfm || cfmPackets.length === 0 || quality < 0.25) return base;

    const modelDir = routed.bullish > routed.bearish ? 1 : routed.bearish > routed.bullish ? -1 : 0;
    if (modelDir === 0) return base;

    const aligned = cfmPackets.filter(p => p.direction === modelDir);
    const opposed = cfmPackets.filter(p => p.direction !== 0 && p.direction !== modelDir);
    const alignedStr = aligned.reduce((s, p) => s + (p.strength || 0) * (p.relevance || 0.7) * (p.trust || 0.8), 0);
    const opposedStr = opposed.reduce((s, p) => s + (p.strength || 0) * (p.relevance || 0.7) * (p.trust || 0.8), 0);
    const cfmNet = alignedStr - opposedStr;

    // Strong multi-packet CFM confirmation → upgrade to watch + soften score multiplier
    if (aligned.length >= 2 && opposed.length === 0 && cfm.sourceCount >= 3 && cfmNet >= 0.30) {
      return {
        action: 'watch',
        confidenceMultiplier: 0.90,
        standAsideMultiplier: 0.62, // softer than default 0.45
        cfmOverride: true,
        overrideReason: `CFM ${aligned.length}-packet alignment (${cfm.sourceCount} sources, Q=${quality.toFixed(2)})`,
      };
    }

    // Partition lock or momentum surge resolves stand-aside
    const hasLock = cfmPackets.some(p => p.family === 'cfm_partition_lock' && p.direction === modelDir);
    const hasSurge = cfmPackets.some(p => p.family === 'cfm_momentum_surge' && p.direction === modelDir && p.strength >= 0.50);
    if ((hasLock || hasSurge) && aligned.length >= 1 && opposed.length === 0) {
      return {
        action: 'watch',
        confidenceMultiplier: 0.86,
        standAsideMultiplier: 0.62,
        cfmOverride: true,
        overrideReason: `CFM ${hasLock ? 'partition lock' : 'momentum surge'} override`,
      };
    }

    // Soft alignment: upgrade multiplier without changing action
    if (aligned.length >= 1 && opposedStr < 0.10 && Math.abs(cfm.momentum || 0) >= 0.05) {
      return {
        action: 'watch',
        confidenceMultiplier: 0.80,
        standAsideMultiplier: 0.58,
        cfmOverride: true,
        overrideReason: `CFM soft override (${cfm.trend}, Q=${quality.toFixed(2)})`,
      };
    }

    return base;
  }

  // ── 5. CFM SCORE ANCHOR ─────────────────────────────────────────
  // Additive delta (max ±0.09) when CFM confirms direction.
  // Never flips — only amplifies a confirmed call.
  function buildCFMAnchor(sym, normalizedScore, cfmPackets) {
    if (!cfmPackets.length || normalizedScore === 0) return 0;
    const scoreDir = Math.sign(normalizedScore);
    const aligned = cfmPackets.filter(p => p.direction === scoreDir);
    const opposed = cfmPackets.filter(p => p.direction !== 0 && p.direction !== scoreDir);
    if (aligned.length === 0) return 0;
    const alignedStr = aligned.reduce((s, p) => s + (p.strength || 0), 0) / aligned.length;
    const opposedStr = opposed.length ? opposed.reduce((s, p) => s + (p.strength || 0), 0) / opposed.length : 0;
    return scoreDir * clamp((alignedStr - opposedStr * 0.55) * 0.11, 0, 0.09);
  }

  function buildRegimeGate(regimeHint) {
    const state = String(regimeHint?.state || '').toLowerCase();
    if (!state) return { scoreMult: 1, confMult: 1, label: 'none' };
    if (state === 'chop') return { scoreMult: 0.90, confMult: 0.86, label: 'chop-guard' };
    if (state === 'transition') return { scoreMult: 0.95, confMult: 0.92, label: 'transition-guard' };
    if (state === 'trend') return { scoreMult: 1.02, confMult: 1.02, label: 'trend-boost' };
    return { scoreMult: 1, confMult: 1, label: 'neutral' };
  }

  // ── 6. EARLY EXIT DETECTOR (enhanced) ──────────────────────────
  // Detects 4 exit conditions from CFM history:
  //   momentumFlip       — velocity reversed sign
  //   trendFlip          — 15m rolling average switched direction
  //   spreadSpike        — exchange disagreement spiked (breakout risk)
  //   convergenceLoss    — venue prices diverged (fragmentation)
  // Returns null or { shouldExit, sym, type, severity, reason, ... }
  function detectEarlyExit(sym) {
    const stored = window._lastPrediction?.[sym];
    if (!stored || stored.direction === 'FLAT') return null;
    const cfm = window._cfm?.[sym];
    // Allow single-source CFM (sourceCount >= 1) — some coins only have one exchange feed
    if (!cfm || !cfm.cfmRate || cfm.sourceCount < 1) return null;

    const predDir = stored.direction === 'UP' ? 1 : -1;
    const momDir = Math.sign(cfm.momentum || 0);
    const trendDir = cfm.trend === 'rising' ? 1 : cfm.trend === 'falling' ? -1 : 0;

    // Adaptive momentum threshold: SOL/DOGE have smaller %-moves than BTC/ETH.
    // Use 0.03% for all coins (down from 0.06%) — still noise-resilient but catches
    // small-cap coins that move in the 0.03–0.07% range per candle.
    const MOM_THRESHOLD = 0.03;
    const momentumOpp = momDir !== 0 && momDir !== predDir && Math.abs(cfm.momentum || 0) >= MOM_THRESHOLD;
    const trendOpp = trendDir !== 0 && trendDir !== predDir;

    // History-based checks
    const hist = _cfmHistory[sym] || [];
    let spreadSpiked = false, convergenceLoss = false, histTrendFlip = false;
    if (hist.length >= 2) {
      const prev = hist[hist.length - 2];
      const curr = hist[hist.length - 1];
      spreadSpiked = curr.spread > prev.spread * 1.6 && curr.spread > 0.09;
      convergenceLoss = curr.convergence > prev.convergence * 2.2 && curr.convergence > 0.12;
      histTrendFlip = prev.trend !== 'flat' && curr.trend !== 'flat' && curr.trend !== prev.trend;
    }

    // Severity: high = momentum+trend both reversed; medium = one; low = spread/cv only
    const highConfidence = momentumOpp && trendOpp;
    const medConfidence = (momentumOpp || (trendOpp && Math.abs(cfm.momentum || 0) >= MOM_THRESHOLD * 0.7)) && !highConfidence;
    const lowSignal = (spreadSpiked || convergenceLoss || histTrendFlip) && !highConfidence && !medConfidence;

    if (!highConfidence && !medConfidence && !lowSignal) return null;

    const severity = highConfidence ? 'high' : medConfidence ? 'medium' : 'low';
    const exitDir = momDir > 0 ? 'UP' : trendDir > 0 ? 'UP' : 'DOWN';
    const type = highConfidence ? 'momentum_and_trend_flip'
      : trendOpp ? 'trend_flip'
        : momentumOpp ? 'momentum_reversal'
          : spreadSpiked ? 'spread_spike'
            : convergenceLoss ? 'convergence_loss'
              : 'trend_flip';

    return {
      shouldExit: severity !== 'low',
      sym,
      type,
      severity,
      reason: `CFM ${type.replace(/_/g, ' ')}: mom ${(cfm.momentum || 0).toFixed(3)}% · trend ${cfm.trend} · spread ${(cfm.spread || 0).toFixed(3)}% · src ${cfm.sourceCount}`,
      strength: highConfidence ? clamp(Math.abs(cfm.momentum || 0) / 0.15, 0.4, 1.0) : 0.35,
      prediction: stored.direction,
      cfmDirection: exitDir,
      sourceCount: cfm.sourceCount,
      ts: Date.now(),
    };
  }

  // ── 7. EARLY EXIT POLLING ───────────────────────────────────────
  let exitPollHandle = null;
  const recentExits = new Map(); // sym → last dispatch ts (debounce 3min)

  // ── 7b. COORDINATED SELL DETECTOR ──────────────────────────────────────
  // Wall events are cross-coin events: multiple coins dump simultaneously.
  // Pattern observed:
  //   pre-warning  → 3+ coins momentum < -0.025% in same poll cycle (04:25 event)
  //   wall break   → 3+ coins momentum < -0.04%  (04:28 ETH-0.191 / SOL-0.102 / XRP-0.055)
  //   cascade      → continues next candle with full-body down bars (04:30 BTC-0.075)
  // Shell-router-aware coordinated sell detection.
  // Reads ionisation state from window.ShellRouter rather than counting raw CFM
  // drops per coin. Coins stay in their own shells; only the router's output is
  // consumed here — so BTC never "talks to" SOL directly.
  function detectCoordinatedSell() {
    const sState = window.ShellRouter?.getShellState('s');
    const pState = window.ShellRouter?.getShellState('p');
    const fState = window.ShellRouter?.getShellState('f');
    const preds = window._lastPrediction || {};

    // s-shell ionised downward = coordinated core sell (BTC/ETH/XRP/BNB)
    const sCoreIonized = sState?.ionized && sState.direction < 0;
    // p-shell itself selling (alt-led move or delayed resonance after s-shell)
    const pShellSelling = (pState?.velocity ?? 0) < -0.025;
    // f-shell sentiment dump = externality shock / crowd unwind
    const fShellSelling = fState?.ionized && fState.direction < 0;

    if (!sCoreIonized && !pShellSelling && !fShellSelling) return null;

    // Momentum/high-beta coins are most exposed to shell resonance; core coins
    // still self-protect via their per-coin detectEarlyExit path.
    const pCoins = window.ShellRouter?.SHELLS?.p?.coins ?? ['SOL', 'HYPE'];
    const fCoins = window.ShellRouter?.SHELLS?.f?.coins ?? ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
    const atRisk = [
      ...(sCoreIonized ? pCoins : []),
      ...(pShellSelling ? pCoins : []),
      ...(fShellSelling ? fCoins : []),
    ].filter(sym => preds[sym]?.direction === 'UP');
    if (!atRisk.length) return null;

    const sVel = sState?.velocity ?? 0;
    const pVel = pState?.velocity ?? 0;
    const fVel = fState?.velocity ?? 0;
    const pattern = sCoreIonized && pShellSelling ? 'simultaneous'
      : fShellSelling ? 'sentiment_shock'
        : sCoreIonized ? 'core_led'
          : 'alt_led';
    const strength = Math.min(
      0.50
      + (sCoreIonized ? Math.min(Math.abs(sVel) / 0.08, 0.30) : 0)
      + (pShellSelling ? Math.min(Math.abs(pVel) / 0.10, 0.25) : 0),
      1.0
    );
    const sentimentBoost = fShellSelling ? Math.min(Math.abs(fVel) / 0.10, 0.22) : 0;
    const finalStrength = Math.min(strength + sentimentBoost, 1.0);

    return {
      atRisk,
      dropping: [...(sCoreIonized ? ['s-shell'] : []), ...(pShellSelling ? ['p-shell'] : []), ...(fShellSelling ? ['f-shell'] : [])],
      strength: finalStrength,
      reason: `Shell wall (${pattern})  s=${sVel.toFixed(3)}%  p=${pVel.toFixed(3)}%  f=${fVel.toFixed(3)}%`,
      pattern,
    };
  }

  // ── 8. EARLY EXIT POLLING ───────────────────────────────────────
  function startExitPolling() {
    if (exitPollHandle) return;
    exitPollHandle = setInterval(() => {
      if (!window._lastPrediction) return;

      // ── Per-coin CFM reversal detection ──
      Object.keys(window._lastPrediction).forEach(sym => {
        const cfm = window._cfm?.[sym];
        if (cfm?.cfmRate) recordCFMSnapshot(sym, cfm);

        const exit = detectEarlyExit(sym);
        if (!exit?.shouldExit) return;
        const last = recentExits.get(sym) || 0;
        if (Date.now() - last < 180000) return; // 3min debounce
        recentExits.set(sym, Date.now());
        try {
          dispatchEvent(new CustomEvent('cfm:earlyExit', { detail: exit }));
        } catch { /* non-critical */ }
      });

      // ── Cross-coin coordinated sell detection ──
      // Fires independently of per-coin check; catches wall events where
      // individual coin moves are too small to trigger per-coin threshold alone.
      const coord = detectCoordinatedSell();
      if (coord) {
        coord.atRisk.forEach(sym => {
          const last = recentExits.get(sym) || 0;
          if (Date.now() - last < 180000) return; // same 3min debounce
          recentExits.set(sym, Date.now());
          const stored = window._lastPrediction?.[sym];
          try {
            dispatchEvent(new CustomEvent('cfm:earlyExit', {
              detail: {
                sym,
                reason: coord.reason,
                strength: coord.strength,
                prediction: stored?.direction || 'UP',
                type: 'coordinated_sell',
                severity: 'high',
                shouldExit: true,
              }
            }));
          } catch { /* non-critical */ }
        });
        if (coord.atRisk.length) {
          console.warn('[CFMRouter] Wall event detected:', coord.reason,
            '| at-risk:', coord.atRisk.join(','));
        }
      }

    }, 15000);
    console.log('[CFMRouter] Early exit polling started (15s interval, +coordinated-sell)');
  }

  // ── PUBLIC API ──────────────────────────────────────────────────
  window.CFMRouter = {

    // Main entry point: called from computePrediction() in predictions.js
    enrich(sym, routerContext, routedPackets, routed, baseScore, baseConf, regimeHint = null) {
      const cfm = window._cfm?.[sym];
      if (cfm?.cfmRate) recordCFMSnapshot(sym, cfm); // keep history fresh

      const cfmPackets = buildCFMPackets(sym);
      const calibration = buildOutcomeCalibration(sym);
      const singularity = resolveSingularity(sym, routed, cfmPackets);
      const anchor = buildCFMAnchor(sym, baseScore, cfmPackets);
      const alignment = getCFMAlignment(sym, baseScore);

      const resolvedAction = singularity.action;
      const resolvedMultiplier = singularity.confidenceMultiplier;

      // Anchor-adjusted base score
      const anchoredScore = clamp(baseScore + anchor, -1, 1);

      // Stand-aside multiplier: soften to 0.62 when CFM confirms vs default 0.45
      const saMultiplier = singularity.standAsideMultiplier;

      // CFM conflict suppression: when CFM opposes a 'trade' action, suppress to 0.38×
      const conflictSuppressed = alignment === 'conflicting'
        && (routed.action === 'trade' || routed.action === 'watch')
        && Math.abs(anchoredScore) >= 0.15;

      let finalScore;
      if (resolvedAction === 'invalidated') {
        finalScore = 0;
      } else if (resolvedAction === 'stand-aside') {
        finalScore = anchoredScore * saMultiplier;
      } else if (conflictSuppressed) {
        // CFM actively contradicts → suppress even a 'trade' signal
        finalScore = clamp(anchoredScore * 0.38, -1, 1);
      } else {
        finalScore = clamp(anchoredScore * resolvedMultiplier * calibration.multiplier, -1, 1);
      }

      // Confidence: +8 pts if confirming, -12 pts if conflicting
      const cfmConfBoost = alignment === 'confirming'
        ? Math.round(Math.abs(buildCFMQuality(cfm || {}) || 0) * 8)
        : alignment === 'conflicting' ? -12 : 0;
      const regimeGate = buildRegimeGate(regimeHint);
      finalScore = clamp(finalScore * regimeGate.scoreMult, -1, 1);
      const finalConf = Math.round(
        clamp(baseConf * resolvedMultiplier * calibration.multiplier + cfmConfBoost, 0, 95)
        * regimeGate.confMult);

      return {
        cfmPackets,
        calibration,
        regimeGate,
        singularity,
        alignment,
        anchor,
        anchoredScore,
        finalScore,
        finalConf,
        resolvedAction,
        cfmOverride: singularity.cfmOverride,
        overrideReason: singularity.overrideReason || null,
        earlyExit: detectEarlyExit(sym),
        conflictSuppressed,
      };
    },

    getCalibration: sym => buildOutcomeCalibration(sym),
    getCFMPackets: sym => buildCFMPackets(sym),
    getCFMAlignment: (sym, score) => getCFMAlignment(sym, score),
    detectEarlyExit: sym => detectEarlyExit(sym),
    startExitPolling,

    // Full diagnostic report for all coins
    report() {
      return (window.PREDICTION_COINS || []).map(c => ({
        sym: c.sym,
        cfmQuality: buildCFMQuality(window._cfm?.[c.sym]),
        cfmPackets: buildCFMPackets(c.sym),
        calibration: buildOutcomeCalibration(c.sym),
        alignment: getCFMAlignment(c.sym, window._predictions?.[c.sym]?.score || 0),
        earlyExit: detectEarlyExit(c.sym),
      }));
    },
  };

})();
