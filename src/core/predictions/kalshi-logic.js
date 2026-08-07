// ================================================================
// WE|||CRYPTO — Kalshi Boundary and Sentiment Logic
// Orbital shell: prediction-market verification context.
// ================================================================

(function () {
  'use strict';

  // Model-first policy: prediction markets are verification context, not a directional driver.
  const KALSHI_VERIFY_ONLY = true;

  function getKalshiNextBoundaryMinutes() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const currentFractionalMinute = minutes + (seconds / 60);
    let nextBoundary = Math.ceil(currentFractionalMinute / 15) * 15;
    if (nextBoundary === currentFractionalMinute) nextBoundary += 15;
    const remaining = Math.round(nextBoundary - currentFractionalMinute);
    return Math.max(1, Math.min(15, remaining));
  }

  function resolveKalshiMarketData(symOrMarketData) {
    if (symOrMarketData && typeof symOrMarketData === 'object') return symOrMarketData;
    const sym = String(symOrMarketData || '').toUpperCase();
    return sym ? (window.PredictionMarkets?.getCoin(sym) ?? null) : null;
  }

  /**
   * Converts Kalshi/Polymarket consensus into a bounded [-1, 1] signal.
   * The verify-only switch zeroes model impact while preserving diagnostics.
   */
  function calculateKalshiSentiment(symOrMarketData) {
    const marketData = resolveKalshiMarketData(symOrMarketData);
    let signal = 0;
    if (marketData && marketData.combinedProb !== null) {
      const p = Number(marketData.combinedProb);
      if (p > 0.62) signal = Math.min(1, (p - 0.62) / 0.38);
      else if (p < 0.38) signal = -Math.min(1, (0.38 - p) / 0.38);
    }
    return {
      marketData,
      signal,
      modelSignal: KALSHI_VERIFY_ONLY ? 0 : signal,
      label: signal > 0.3 ? 'Markets say UP' : signal < -0.3 ? 'Markets say DOWN' : 'Markets neutral',
    };
  }

  function getKalshi15mSettlementContext(sym, fallbackPrice) {
    const key = String(sym || '').toUpperCase();
    const k15m = window.PredictionMarkets?.getCoin(key)?.kalshi15m ?? null;
    const kalshiRef = k15m?.targetPriceNum ?? null;
    const kalshiYes = k15m?.probability ?? null;
    const kalshiStDir = k15m?.strikeDir ?? 'above';
    const rtiData = window._rtiPrices?.[key] ?? null;
    const rtiPrice = rtiData?.price ?? null;

    return {
      k15m,
      kalshiRef,
      kalshiYes,
      kalshiStDir,
      isBelowK: kalshiStDir === 'below',
      rtiData,
      rtiPrice,
      settlementPrice: rtiPrice ?? fallbackPrice,
    };
  }

  window.PredictionKalshiLogic = {
    KALSHI_VERIFY_ONLY,
    getKalshiNextBoundaryMinutes,
    calculateKalshiSentiment,
    getKalshi15mSettlementContext,
  };
})();
