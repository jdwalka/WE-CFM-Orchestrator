// ================================================================
// WE|||CRYPTO — Market Boundary and Sentiment Logic
// Polymarket-first verification context (legacy export names retained).
// ================================================================

(function () {
  'use strict';

  // Model-first policy: prediction markets are verification context, not a directional driver.
  const POLYMARKET_VERIFY_ONLY = true;

  function getPolymarketNextBoundaryMinutes() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const currentFractionalMinute = minutes + (seconds / 60);
    let nextBoundary = Math.ceil(currentFractionalMinute / 15) * 15;
    if (nextBoundary === currentFractionalMinute) nextBoundary += 15;
    const remaining = Math.round(nextBoundary - currentFractionalMinute);
    return Math.max(1, Math.min(15, remaining));
  }

  function resolvePolymarketMarketData(symOrMarketData) {
    if (symOrMarketData && typeof symOrMarketData === 'object') return symOrMarketData;
    const sym = String(symOrMarketData || '').toUpperCase();
    return sym ? (window.PredictionMarkets?.getCoin(sym) ?? null) : null;
  }

  /**
   * Converts Kalshi/Polymarket consensus into a bounded [-1, 1] signal.
   * The verify-only switch zeroes model impact while preserving diagnostics.
   */
  function calculatePolymarketSentiment(symOrMarketData) {
    const marketData = resolvePolymarketMarketData(symOrMarketData);
    let signal = 0;
    if (marketData && marketData.combinedProb !== null) {
      const p = Number(marketData.combinedProb);
      if (p > 0.62) signal = Math.min(1, (p - 0.62) / 0.38);
      else if (p < 0.38) signal = -Math.min(1, (0.38 - p) / 0.38);
    }
    return {
      marketData,
      signal,
      modelSignal: POLYMARKET_VERIFY_ONLY ? 0 : signal,
      label: signal > 0.3 ? 'Markets say UP' : signal < -0.3 ? 'Markets say DOWN' : 'Markets neutral',
    };
  }

  function getPolymarket15mSettlementContext(sym, fallbackPrice) {
    const key = String(sym || '').toUpperCase();
    const coin = window.PredictionMarkets?.getCoin(key) ?? null;
    // Polymarket primary (poly15m → poly5m → poly)
    const mkt = coin?.poly15m || coin?.poly5m || coin?.poly || null;
    const polymarketRef = mkt?.priceToBeatNum ?? mkt?.targetPriceNum ?? null;
    const polymarketYes = mkt?.probability ?? mkt?.upProbability ?? null;
    // Polymarket Up/Down: Up wins if price settles above PTB → treat as "above"
    const polymarketStrikeDir = mkt?.strikeDir ?? 'above';
    const venue = 'polymarket';
    // Polymarket 5m/15m Up/Down settle 100% on Chainlink 60s/30s TWAP streams.
    const rtds = window.PredictionMarkets?.getFreshRtdsTwap?.(key, 15_000);
    const microTwap = window.Microstructure?.getTwap?.(key, 30_000);
    const twapPx = Number(rtds?.price ?? microTwap);
    const settlementPrice = (Number.isFinite(twapPx) && twapPx > 0) ? twapPx : fallbackPrice;

    return {
      poly15mCtx: mkt,
      poly15m: coin?.poly15m || null,
      poly5m: coin?.poly5m || null,
      polymarketRef,
      polymarketYes,
      polymarketStrikeDir,
      isBelowPoly: polymarketStrikeDir === 'below',
      twapData: rtds,
      twapPrice: settlementPrice,
      rtiData: rtds ? { openAvg: settlementPrice, closeAvg: settlementPrice, delta: 0 } : null, // compat alias
      rtiPrice: settlementPrice, // compat alias
      settlementPrice,
      venue,
    };
  }

  window.PredictionPolymarketLogic = {
    POLYMARKET_VERIFY_ONLY,
    getPolymarketNextBoundaryMinutes,
    calculatePolymarketSentiment,
    getPolymarket15mSettlementContext,
  };
})();
