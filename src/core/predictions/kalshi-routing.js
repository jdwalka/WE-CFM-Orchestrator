// Kalshi Orderbook & Routing Logic
(function() {

  const KALSHI_VERIFY_ONLY = true;

  function getKalshiNextBoundaryMinutes() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const currentFractionalMinute = minutes + (seconds / 60);
    let nextBoundary = Math.ceil(currentFractionalMinute / 15) * 15;
    if (nextBoundary === currentFractionalMinute) nextBoundary += 15;
    let remaining = Math.round(nextBoundary - currentFractionalMinute);
    return Math.max(1, Math.min(15, remaining));
  }

  function getSecsToKalshiClose(sym) {
    const close = window.PredictionMarkets?.getCoin?.(sym)?.kalshi15m?.closeTime;
    if (!close) return null;
    const ms = new Date(close).getTime() - Date.now();
    return Number.isFinite(ms) ? ms / 1000 : null;
  }

  function normalCDF(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    const p = 1 - pdf * poly;
    return z >= 0 ? p : 1 - p;
  }

  function buildRationale(sigVec, regime, kalshiProb, coin) {
    // Find top 3 contributing signals by weighted magnitude
    const sorted = [...sigVec]
      .filter(s => Math.abs(s.value) > 0.1)
      .sort((a, b) => Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight));

    const top3 = sorted.slice(0, 3);
    const direction = sigVec.reduce((s, x) => s + x.value * x.weight, 0);
    const dirLabel = direction > 0.05 ? 'UP' : direction < -0.05 ? 'DOWN' : 'FLAT';

    const lines = [];

    // Regime line
    lines.push(`Regime: ${regime.label}`);

    // Top signals
    if (top3.length > 0) {
      lines.push(`Key drivers: ${top3.map(s => {
        const dir = s.value > 0 ? '▲' : '▼';
        return `${dir}${s.name}`;
      }).join(', ')}`);
    }

    // Kalshi alignment
    if (kalshiProb !== null && kalshiProb !== undefined) {
      const kalshiDir = kalshiProb > 0.52 ? 'YES (UP)' : kalshiProb < 0.48 ? 'NO (DOWN)' : 'NEUTRAL';
      const aligned = (dirLabel === 'UP' && kalshiProb > 0.52) || (dirLabel === 'DOWN' && kalshiProb < 0.48);
      lines.push(`Kalshi ${(kalshiProb * 100).toFixed(0)}% ${kalshiDir} — ${aligned ? '✓ ALIGNED with model' : '⚡ DIVERGES from model'}`);
    }

    // Regime-adjusted conviction
    const conviction = Math.min(1, Math.abs(direction) * regime.confidence * 2);
    const convLabel = conviction > 0.6 ? 'HIGH' : conviction > 0.35 ? 'MODERATE' : 'LOW';

    lines.push(`Conviction: ${convLabel} (${(conviction * 100).toFixed(0)}%)`);

    // Pre-prediction lock — if conviction HIGH, lock in direction early
    const preLocked = conviction > 0.55 && regime.confidence > 0.6;
    if (preLocked) {
      lines.push(`⚡ PRE-LOCKED ${dirLabel} — ${top3[0]?.name || 'model'} + ${regime.emaCross} EMA + ${regime.bookBias}`);
    }

    return {
      lines,
      dirLabel,
      conviction,
      convLabel,
      preLocked,
      regimeKey: regime.regime,
      summary: lines.join(' | ')
    };
  }

  function buildExecutionGuard(model, cache) {
    const closeTimeMs = model?.projections?.p15?.kalshiAlign?.closeTimeMs;
    if (!Number.isFinite(closeTimeMs)) return null;
    const now = Date.now();
    const msToClose = closeTimeMs - now;
    const dataAgeMs = Math.max(0, now - (cache?.ts || now));
    const staleData = dataAgeMs > 45_000;
    const hardLate = msToClose <= 18_000;
    const cautionLate = msToClose <= 40_000;
    const blocked = hardLate || (cautionLate && staleData);
    return {
      blocked,
      hardLate,
      cautionLate,
      staleData,
      msToClose,
      dataAgeMs,
      reason: blocked
        ? (hardLate ? 'late-entry-window' : 'stale-data-near-close')
        : (cautionLate ? 'late-window-caution' : null),
    };
  }

window.PREDICTIONS_KALSHI_ROUTING = {
  KALSHI_VERIFY_ONLY,
  getKalshiNextBoundaryMinutes,
  getSecsToKalshiClose,
  normalCDF,
  buildRationale,
  buildExecutionGuard
};
})();
