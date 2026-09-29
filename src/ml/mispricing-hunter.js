/**
 * Mispricing hunter — contrarian edge vs Polymarket crowd + projected drift to execution.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.MispricingHunter = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** Map YES-centric probabilities to UP/DOWN given strike direction. */
  function yesProbToDirection(modelYesPct, strikeDir = 'above') {
    const isBelow = String(strikeDir).toLowerCase() === 'below';
    const yesDir = isBelow ? 'DOWN' : 'UP';
    const noDir = isBelow ? 'UP' : 'DOWN';
    if (modelYesPct >= 58) return yesDir;
    if (modelYesPct <= 42) return noDir;
    return 'WAIT';
  }

  function polymarketYesPctFromCoin(coin) {
    const k = coin?.kalshi15m;
    if (!k) return null;
    if (k.probability != null) return Number(k.probability) * 100;
    if (k.yesAsk != null && k.yesBid != null) return ((k.yesAsk + k.yesBid) / 2) * 100;
    return null;
  }

  /**
   * Project Polymarket implied YES% at execution time using prob velocity (¢/min).
   */
  function projectPolymarketAtExecution(polymarketYesPct, probVelocity, msToClose, execLagMs = 3500) {
    if (polymarketYesPct == null) return null;
    const minsToExec = Math.max(0, (msToClose - execLagMs) / 60000);
    const vel = Number(probVelocity) || 0;
    return clamp(polymarketYesPct + vel * minsToExec, 1, 99);
  }

  /**
   * Core mispricing + contrarian analysis.
   */
  function analyze(ctx = {}) {
    const align = ctx.polyAlign || {};
    const strikeDir = align.strikeDir || ctx.strikeDir || 'above';
    const modelYes = align.modelYesPct ?? ctx.modelYesPct ?? null;
    const marketYes = align.polymarketYesPct ?? ctx.polymarketYesPct ?? null;
    const msToClose = align.closeTimeMs
      ? Math.max(0, align.closeTimeMs - Date.now())
      : Number(ctx.msToClose ?? 0);
    const probVel = ctx.probVelocity ?? ctx.probVelocityTrend ?? 0;
    const rapid = Number(ctx.rapidScore ?? 0) >= 0.38;
    const execLagMs = rapid ? 5500 : 3500;

    const out = {
      strikeDir,
      modelYesPct: modelYes,
      polymarketYesPct: marketYes,
      msToClose,
      mispricingPp: null,
      projectedMispricingPp: null,
      projectedPolymarketYesPct: null,
      contrarian: false,
      contrarianSide: null,
      crowdExtreme: false,
      huntScore: 0,
      executionEdgePp: null,
      recommendedAction: 'WAIT',
      recommendedSide: null,
      playType: 'none',
      rationale: '',
    };

    if (modelYes == null || marketYes == null) {
      out.rationale = 'missing market or model probability';
      return out;
    }

    const currentEdgePp = modelYes - marketYes;
    const projectedMarket = projectPolymarketAtExecution(marketYes, probVel, msToClose, execLagMs);
    const projectedEdgePp = projectedMarket != null ? modelYes - projectedMarket : currentEdgePp;

    out.mispricingPp = currentEdgePp;
    out.projectedMispricingPp = projectedEdgePp;
    out.projectedPolymarketYesPct = projectedMarket;
    out.executionEdgePp = projectedEdgePp;

    const absProj = Math.abs(projectedEdgePp);
    const absNow = Math.abs(currentEdgePp);

    // Crowd extreme → contrarian fade candidate
    out.crowdExtreme = marketYes >= 72 || marketYes <= 28;
    if (out.crowdExtreme) {
      const fadeYes = marketYes >= 72;
      out.contrarian = fadeYes
        ? projectedEdgePp < -8 || currentEdgePp < -8
        : projectedEdgePp > 8 || currentEdgePp > 8;
      out.contrarianSide = fadeYes
        ? yesProbToDirection(35, strikeDir)
        : yesProbToDirection(65, strikeDir);
    }

    // Direct mispricing hunt: model disagrees with projected crowd price at execution
    const edgeDirection = yesProbToDirection(
      modelYes,
      strikeDir,
    );
    const marketDirection = yesProbToDirection(
      projectedMarket ?? marketYes,
      strikeDir,
    );

    if (absProj >= 15 && edgeDirection !== 'WAIT' && edgeDirection !== marketDirection) {
      out.playType = out.contrarian ? 'contrarian_mispricing' : 'mispricing_hunt';
      out.recommendedAction = edgeDirection;
      out.recommendedSide = projectedEdgePp > 0
        ? (strikeDir === 'below' ? 'YES' : 'YES')
        : (strikeDir === 'below' ? 'NO' : 'NO');
      out.huntScore = clamp(absProj / 30 + (out.contrarian ? 0.15 : 0), 0, 1);
      out.rationale = `${out.playType}: model ${modelYes}% vs projected mkt ${projectedMarket?.toFixed(0)}% (${projectedEdgePp.toFixed(1)}pp edge at exec)`;
    } else if (out.contrarian && out.contrarianSide && out.contrarianSide !== 'WAIT') {
      out.playType = 'contrarian_fade';
      out.recommendedAction = out.contrarianSide;
      out.huntScore = clamp(absNow / 25 + 0.2, 0, 0.85);
      out.rationale = `contrarian fade: crowd ${marketYes}% YES, model ${modelYes}%`;
    } else if (absProj >= 10 && edgeDirection !== 'WAIT') {
      out.playType = 'soft_edge';
      out.recommendedAction = edgeDirection;
      out.huntScore = clamp(absProj / 35, 0, 0.65);
      out.rationale = `soft mispricing ${projectedEdgePp.toFixed(1)}pp projected`;
    }

    // Late-window: mispricing often widens — boost hunt score in final 3 min
    if (msToClose > 0 && msToClose < 180000 && out.huntScore > 0) {
      out.huntScore = clamp(out.huntScore * 1.18, 0, 1);
    }

    return out;
  }

  function analyzeFromSymbol(sym, modelExtras = {}) {
    const coin = window.PredictionMarkets?.getCoin?.(sym);
    const vel = window.PredictionMarkets?.getVelocity?.(sym);
    return analyze({
      polyAlign: modelExtras.polyAlign,
      strikeDir: coin?.kalshi15m?.strikeDir,
      modelYesPct: modelExtras.modelYesPct ?? modelExtras.polyAlign?.modelYesPct,
      polymarketYesPct: modelExtras.polymarketYesPct ?? polymarketYesPctFromCoin(coin),
      msToClose: coin?.kalshi15m?.closeTime
        ? new Date(coin.kalshi15m.closeTime).getTime() - Date.now()
        : 0,
      probVelocity: vel?.trend ?? vel?.velocity ?? 0,
      rapidScore: modelExtras.rapidScore ?? 0,
    });
  }

  function mispricingToActionId(recommendedAction, enc) {
    if (!enc?.ACTION) {
      return recommendedAction === 'UP' ? 1 : recommendedAction === 'DOWN' ? 2 : 0;
    }
    if (recommendedAction === 'UP') return enc.ACTION.UP;
    if (recommendedAction === 'DOWN') return enc.ACTION.DOWN;
    return enc.ACTION.WAIT;
  }

  return {
    analyze,
    analyzeFromSymbol,
    projectPolymarketAtExecution,
    yesProbToDirection,
    mispricingToActionId,
  };
}));
