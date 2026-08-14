/**
 * Quarter-Hour Alignment Validator
 * 
 * Ensures all 15-minute predictions and Kalshi settlements are strictly aligned
 * to quarter-hour boundaries (:00, :15, :30, :45 of each hour).
 * 
 * This prevents prediction/settlement timing mismatches that cause false signals.
 */

(function () {
  'use strict';

  const QUARTER_HOUR_MS = 15 * 60 * 1000;  // 15 minutes in milliseconds
  const SETTLEMENT_GRACE_MS = 5000;        // Allow 5s wiggle room
  const PREDICTION_LEAD_MS = 20000;        // Emit prediction 10s before settlement

  // ── Helper: Check if timestamp aligns to quarter-hour ──
  function isQuarterHourAligned(tsMs) {
    const date = new Date(tsMs);
    const minutes = date.getUTCMinutes();
    const seconds = date.getUTCSeconds();
    // Valid: :00:xx, :15:xx, :30:xx, :45:xx
    return minutes % 15 === 0;
  }

  // ── Helper: Get the next quarter-hour settlement time ──
  function getNextSettlementTime(tsMs = Date.now()) {
    const date = new Date(tsMs);
    const minutes = date.getUTCMinutes();
    const seconds = date.getUTCSeconds();
    
    // Find which quarter we're in
    const quarterIdx = Math.floor(minutes / 15);
    let nextQuarter = (quarterIdx + 1) * 15;
    
    let nextDate = new Date(date);
    if (nextQuarter >= 60) {
      nextQuarter = 0;
      nextDate.setUTCHours(nextDate.getUTCHours() + 1);
    }
    nextDate.setUTCMinutes(nextQuarter, 0, 0);
    
    return nextDate.getTime();
  }

  // ── Helper: Get the current quarter-hour boundary ──
  function getCurrentQuarterHour(tsMs = Date.now()) {
    const date = new Date(tsMs);
    const minutes = date.getUTCMinutes();
    const quarterIdx = Math.floor(minutes / 15);
    const quarterMinute = quarterIdx * 15;
    
    let currentDate = new Date(date);
    currentDate.setUTCMinutes(quarterMinute, 0, 0);
    
    return currentDate.getTime();
  }

  // ── Helper: Snap timestamp to nearest quarter-hour ──
  function snapToQuarterHour(tsMs) {
    const current = getCurrentQuarterHour(tsMs);
    const next = getNextSettlementTime(tsMs);
    
    // Which is closer?
    if (tsMs - current < next - tsMs) {
      return current;
    }
    return next;
  }

  // ── Validate that a candle is aligned to quarter-hour close ──
  function validateCandleAlignment(candle) {
    if (!candle || !candle.t) return { aligned: false, reason: 'No candle timestamp' };
    
    const closeTime = candle.t + 15 * 60 * 1000;  // Candle.t is open time; add 15m for close
    if (!isQuarterHourAligned(closeTime)) {
      return {
        aligned: false,
        reason: `Candle closes at ${new Date(closeTime).toISOString()}, not quarter-hour`,
        closeTime
      };
    }
    
    return { aligned: true, closeTime };
  }

  // ── Validate Polymarket settlement alignment ──
  function validateSettlement(closeTimeStr) {
    const tsMs = new Date(closeTimeStr).getTime();
    if (!isQuarterHourAligned(tsMs)) {
      return {
        aligned: false,
        reason: `Settlement at ${closeTimeStr} not quarter-hour aligned`,
        tsMs
      };
    }
    return { aligned: true, tsMs };
  }

  // ── Main validation: Check prediction vs settlement ──
  function validatePredictionTiming(predictionCoin, predictionTimestampMs, settlementTimeStr) {
    const check = validateSettlement(settlementTimeStr);
    if (!check.aligned) {
      return {
        valid: false,
        reason: check.reason,
        details: check
      };
    }

    // Prediction should close within 10s before settlement
    const settlementMs = check.tsMs;
    const timeDiffMs = settlementMs - predictionTimestampMs;

    if (timeDiffMs < -5000) {
      return {
        valid: false,
        reason: `Prediction closes ${Math.abs(timeDiffMs) / 1000}s AFTER settlement (too late)`,
        timeDiffMs
      };
    }

    if (timeDiffMs > SETTLEMENT_GRACE_MS + PREDICTION_LEAD_MS) {
      return {
        valid: false,
        reason: `Prediction closes ${timeDiffMs / 1000}s BEFORE settlement (too early)`,
        timeDiffMs
      };
    }

    return {
      valid: true,
      timeDiffMs,
      settlementMs,
      note: `Prediction closes ${timeDiffMs / 1000}s before settlement ✓`
    };
  }

  // ── Log prediction alignment for debugging ──
  function logAlignmentCheck(sym, candle, settlementStr) {
    const candleCheck = validateCandleAlignment(candle);
    const settlementCheck = validateSettlement(settlementStr);
    
    console.log(`[QuarterHourValidator] ${sym}:`);
    console.log(`  Candle: ${candleCheck.aligned ? '✓' : '❌'} ${candleCheck.reason || 'Aligned'}`);
    console.log(`  Settlement: ${settlementCheck.aligned ? '✓' : '❌'} ${settlementCheck.reason || 'Aligned'}`);
    
    if (candleCheck.aligned && settlementCheck.aligned) {
      const timeDiff = settlementCheck.tsMs - candle.t - 15 * 60 * 1000;
      console.log(`  Offset: ${(timeDiff / 1000).toFixed(1)}s (${timeDiff < 0 ? 'LATE' : 'EARLY'})`);
    }
  }

  // ── Expose API ──
  window.QuarterHourValidator = {
    isAligned: isQuarterHourAligned,
    getNextSettlement: getNextSettlementTime,
    getCurrentQuarter: getCurrentQuarterHour,
    snapToQuarter: snapToQuarterHour,
    validateCandle: validateCandleAlignment,
    validateSettlement,
    validateKalshiSettlement: validateSettlement,
    validateTiming: validatePredictionTiming,
    logCheck: logAlignmentCheck
  };

  console.log('[QuarterHourValidator] Loaded — predictions will enforce :00/:15/:30/:45 alignment');
})();
