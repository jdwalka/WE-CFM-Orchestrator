/**
 * ASI1 pre-contract advisor — Polymarket 5m + 15m guidance before/during window.
 * Renderer-safe: uses Electron `llm:analyzeSnapshot` (ASI1-primary cascade).
 *
 * Surfaces:
 *   window.Asi1PreContract.get(sym)           → best brief (15m preferred, else 5m)
 *   window.Asi1PreContract.get(sym, '5m'|'15m')
 *   window.Asi1PreContract.getAll()
 *   events: asi1:precontract { detail: brief }
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const REFRESH_MS = Number(window.__ASI1_PRECONTRACT_MS || 75_000);
  const MIN_TTC_FIRE = 20;
  const MAX_TTC_5M = 8 * 60;
  const MAX_TTC_15M = 22 * 60;

  /** @type {Record<string, object>} key = `${SYM}:5m` | `${SYM}:15m` */
  const _briefs = {};
  let _timer = null;
  let _running = false;

  // Cold-start: restore last briefs from localStorage
  try {
    const restored = window.InferenceStateStore?.loadBriefs?.() || {};
    let n = 0;
    for (const [k, b] of Object.entries(restored)) {
      if (b && b.sym) {
        _briefs[k] = b;
        n++;
      }
    }
    if (n) console.info(`[ASI1 PreContract] restored ${n} briefs from localStorage (cold-start)`);
  } catch (_) { /* */ }

  function _persistBriefs() {
    try {
      window.InferenceStateStore?.saveBriefs?.(_briefs);
    } catch (_) { /* */ }
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildMarketContext(sym, preferHorizon) {
    const coin = window.PredictionMarkets?.getCoin?.(sym) || {};
    const p15 = coin.poly15m || null;
    const p5 = coin.poly5m || null;
    let m = null;
    let horizon = '15m';
    if (preferHorizon === '5m' && p5?.slug) {
      m = p5;
      horizon = '5m';
    } else if (preferHorizon === '15m' && p15?.slug) {
      m = p15;
      horizon = '15m';
    } else if (p15?.slug) {
      m = p15;
      horizon = '15m';
    } else if (p5?.slug) {
      m = p5;
      horizon = '5m';
    }
    if (!m || !m.slug) return null;

    const spot = Number(
      window.PythBrowser?.getPrice?.(sym)
      || window._rtiPrices?.[sym]?.price
      || m.currentPriceNum
      || 0
    );
    const ptb = Number(m.priceToBeatNum || m.targetPriceNum || 0);
    const ttc = Number(m.secondsToClose);
    const yes = Number(m.probability ?? m.upProbability ?? m.yesProb);

    return {
      sym,
      horizon,
      slug: m.slug,
      live: m.live !== false,
      yesProb: Number.isFinite(yes) ? yes : null,
      priceToBeatNum: Number.isFinite(ptb) && ptb > 0 ? ptb : null,
      secondsToClose: Number.isFinite(ttc) ? ttc : null,
      bestBid: m.bestBid ?? null,
      bestAsk: m.bestAsk ?? null,
      mid: m.mid ?? null,
      spread: m.spread ?? null,
      depthImbalance: m.depthImbalance ?? null,
      nearTouchNotional: m.nearTouchNotional ?? null,
      liveDirection: m.liveDirection || null,
      spot: Number.isFinite(spot) && spot > 0 ? spot : null,
      deltaVsPtb: Number.isFinite(spot) && Number.isFinite(ptb) && ptb > 0 ? spot - ptb : null,
    };
  }

  function buildSnapshot(sym, ctx) {
    const pred = window.PredictionEngine?.getPrediction?.(sym)
      || window.predictions?.[sym]
      || null;
    const is5 = ctx.horizon === '5m';
    const polyBlock = {
      slug: ctx.slug,
      live: true,
      yesProb: ctx.yesProb,
      probability: ctx.yesProb,
      priceToBeatNum: ctx.priceToBeatNum,
      secondsToClose: ctx.secondsToClose,
      bestBid: ctx.bestBid,
      bestAsk: ctx.bestAsk,
      mid: ctx.mid,
      spread: ctx.spread,
      depthImbalance: ctx.depthImbalance,
      nearTouchNotional: ctx.nearTouchNotional,
      liveDirection: ctx.liveDirection,
    };
    return {
      coin: sym,
      preContract: true,
      preferAsi1: true,
      // 5m PTB path uses five-min prompts when poly5m is set + horizon 5;
      // force range/ASI1 path for guidance quality on both 5m and 15m.
      rangePrediction: true,
      rangeHorizonMinutes: 15,
      horizonMinutes: is5 ? 5 : 15,
      horizon: is5 ? '5m' : '15m',
      currentPrice: ctx.spot,
      price: ctx.spot,
      direction: pred?.signal || pred?.direction || null,
      modelDirection: pred?.signal || pred?.direction || null,
      score: pred?.score ?? null,
      confidence: pred?.confidence != null ? pred.confidence / 100 : null,
      poly5m: is5 ? polyBlock : null,
      poly15m: !is5 ? polyBlock : (window.PredictionMarkets?.getCoin?.(sym)?.poly15m || null),
      activeContract: {
        slug: ctx.slug,
        yesProb: ctx.yesProb,
        priceToBeatNum: ctx.priceToBeatNum,
        secondsToClose: ctx.secondsToClose,
      },
    };
  }

  function briefKey(sym, horizon) {
    return `${String(sym).toUpperCase()}:${horizon === '5m' ? '5m' : '15m'}`;
  }

  async function fireOne(sym, preferHorizon) {
    const ctx = buildMarketContext(sym, preferHorizon);
    if (!ctx) return null;

    const maxTtc = ctx.horizon === '5m' ? MAX_TTC_5M : MAX_TTC_15M;
    if (ctx.secondsToClose != null && ctx.secondsToClose < MIN_TTC_FIRE) {
      return _briefs[briefKey(sym, ctx.horizon)] || null;
    }
    if (ctx.secondsToClose != null && ctx.secondsToClose > maxTtc) {
      return _briefs[briefKey(sym, ctx.horizon)] || null;
    }

    const invoke = window.electron?.invoke;
    if (typeof invoke !== 'function') return null;

    const snapshot = buildSnapshot(sym, ctx);
    try {
      const res = await invoke('llm:analyzeSnapshot', snapshot);
      if (!res?.success || !res.output) return null;
      const o = res.output;
      const notes = String(o?.suggestions?.notes || o?.ai_wording?.primary_rationale || '').trim();
      const call = String(o?.call || o?.direction || '').toUpperCase();
      let brief = {
        sym: String(sym).toUpperCase(),
        ts: Date.now(),
        slug: ctx.slug,
        horizon: ctx.horizon,
        call: call === 'UP' || call === 'DOWN' ? call : null,
        confidence: clamp(Number(o?.confidence ?? 0), 0, 1),
        regime: o?.regime || null,
        notes,
        primaryRationale: o?.ai_wording?.primary_rationale || notes,
        marketPatterns: o?.ai_wording?.market_patterns || o?.market_patterns || null,
        preContract: o?.preContract || null,
        polyPeg: o?.polyPeg || null,
        provider: o?.provider || res?.providerStatus?.provider || res?.diagnostics?.lastProvider || 'asi1',
        model: o?.model || res?.providerStatus?.model || res?.diagnostics?.lastModel || null,
        market: ctx,
        degraded: !!res.degraded,
      };
      // Source-of-truth: raw poly PTB/CLOB/book can nullify wrong AI mid-contract
      if (window.InferenceTruthGuard?.gateBrief) {
        const pred = window.PredictionEngine?.getPrediction?.(sym);
        brief = window.InferenceTruthGuard.gateBrief(brief, {
          horizon: ctx.horizon,
          market: ctx,
          modelScore: pred?.score,
        });
      }
      _briefs[briefKey(sym, ctx.horizon)] = brief;
      _persistBriefs();
      try {
        window.dispatchEvent(new CustomEvent('asi1:precontract', { detail: brief }));
      } catch (_) { /* */ }
      console.log(
        `[ASI1 PreContract] ${brief.sym} ${brief.horizon} ${brief.call || '?'} ` +
        `conf=${(brief.confidence * 100).toFixed(0)}% via ${brief.provider}` +
        (brief.nullified ? ' ⛔NULLIFIED' : '') +
        ` ttc=${ctx.secondsToClose}s`
      );
      return brief;
    } catch (err) {
      console.warn(`[ASI1 PreContract] ${sym} ${preferHorizon} failed:`, err?.message || err);
      return null;
    }
  }

  /** Re-apply truth guard on cached briefs without a new LLM call (cheap mid-contract check). */
  function revalidateCached() {
    let changed = false;
    for (const key of Object.keys(_briefs)) {
      const brief = _briefs[key];
      if (!brief?.sym) continue;
      const ctx = buildMarketContext(brief.sym, brief.horizon);
      if (!ctx) continue;
      // refresh market snapshot on brief
      brief.market = ctx;
      if (!window.InferenceTruthGuard?.gateBrief) continue;
      const pred = window.PredictionEngine?.getPrediction?.(brief.sym);
      // Gate against original AI call so we can flip nullify on/off as path changes
      const rawCall = brief.aiCallOriginal || brief.call;
      const gated = window.InferenceTruthGuard.gateBrief(
        { ...brief, call: rawCall, notes: brief.primaryRationale || brief.notes },
        { horizon: brief.horizon, market: ctx, modelScore: pred?.score }
      );
      const wasNull = !!brief.nullified;
      const nowNull = !!gated.nullified;
      if (wasNull !== nowNull || brief.call !== gated.call) {
        changed = true;
        _briefs[key] = { ...gated, primaryRationale: brief.primaryRationale || brief.notes };
        try {
          window.dispatchEvent(new CustomEvent('asi1:precontract', { detail: _briefs[key] }));
        } catch (_) { /* */ }
        if (nowNull) {
          console.warn(`[ASI1 PreContract] mid-contract nullify ${brief.sym} ${brief.horizon}: ${gated.truthReason}`);
        }
      } else {
        _briefs[key] = { ...brief, ...gated, market: ctx };
      }
    }
    if (changed) _persistBriefs();
    return changed;
  }

  async function tick() {
    if (_running) return;
    _running = true;
    try {
      // Always re-check raw truth first (instant cut-off if AI goes wrong mid-window)
      revalidateCached();
      for (const sym of COINS) {
        await fireOne(sym, '5m');
        await new Promise((r) => setTimeout(r, 350));
        await fireOne(sym, '15m');
        await new Promise((r) => setTimeout(r, 350));
      }
      revalidateCached();
    } finally {
      _running = false;
    }
  }

  function get(sym, horizon) {
    const s = String(sym || '').toUpperCase();
    if (horizon === '5m' || horizon === '15m') {
      return _briefs[briefKey(s, horizon)] || null;
    }
    // Best available: freshest, prefer 15m if both recent
    const a = _briefs[briefKey(s, '15m')];
    const b = _briefs[briefKey(s, '5m')];
    if (a && b) return (a.ts >= b.ts - 30_000) ? a : b;
    return a || b || null;
  }

  /**
   * Compact HTML strip for 5m market boxes / cards.
   */
  function renderStripHtml(sym, opts = {}) {
    const horizon = opts.horizon || null;
    const brief = get(sym, horizon);
    if (!brief || (!brief.notes && !brief.call)) return '';

    const call = brief.call;
    const callColor = call === 'UP' ? 'var(--color-green,#00e676)' : call === 'DOWN' ? 'var(--color-red,#ff5252)' : 'var(--color-text-faint)';
    const confPct = Math.round((brief.confidence || 0) * 100);
    const action = brief.nullified ? 'USE_RAW' : (brief.preContract?.action || '');
    const sizeHint = brief.nullified ? 'skip_ai' : (brief.preContract?.sizeHint || '');
    const provider = String(brief.provider || 'ASI1').toUpperCase();
    const ttc = brief.market?.secondsToClose;
    const ageSec = Math.round((Date.now() - brief.ts) / 1000);
    const notes = String(brief.notes || brief.primaryRationale || '').slice(0, opts.maxNotes || 280);
    const invalidation = brief.preContract?.invalidation
      ? String(brief.preContract.invalidation).slice(0, 120)
      : '';
    const truthBadge = window.InferenceTruthGuard?.renderBadgeHtml?.(brief) || '';
    const border = brief.nullified
      ? '1px solid rgba(255,82,82,0.55)'
      : '1px solid rgba(165,180,252,0.28)';
    const bg = brief.nullified
      ? 'linear-gradient(135deg,rgba(60,20,25,0.95),rgba(25,10,15,0.98))'
      : 'linear-gradient(135deg,rgba(30,40,70,0.9),rgba(15,20,35,0.95))';

    return `
      <div class="asi1-precontract-strip" data-sym="${esc(brief.sym)}" data-horizon="${esc(brief.horizon)}" data-nullified="${brief.nullified ? '1' : '0'}" style="
        margin-top:8px;padding:8px 10px;border-radius:6px;
        background:${bg};
        border:${border};
      ">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;">
          <span style="font-size:9px;font-weight:800;letter-spacing:0.06em;color:#a5b4fc;">✨ ${esc(provider)} ${esc(brief.horizon.toUpperCase())}</span>
          ${call ? `<span style="font-size:11px;font-weight:800;color:${callColor};">CALL ${esc(call)}</span>` : ''}
          ${brief.aiCallOriginal && brief.nullified ? `<span style="font-size:9px;color:#fca5a5;text-decoration:line-through;">was ${esc(brief.aiCallOriginal)}</span>` : ''}
          ${confPct ? `<span style="font-size:9px;color:#c7d2fe;">${confPct}%</span>` : ''}
          ${truthBadge}
          ${action ? `<span style="font-size:8px;padding:1px 6px;border-radius:999px;background:rgba(255,193,7,0.12);color:#ffe082;">${esc(action)}</span>` : ''}
          ${sizeHint ? `<span style="font-size:8px;color:var(--color-text-faint);">size:${esc(sizeHint)}</span>` : ''}
          ${ttc != null ? `<span style="font-size:8px;color:var(--color-text-faint);margin-left:auto;">ttc ${Math.max(0, ttc)}s · ${ageSec}s ago</span>` : ''}
        </div>
        <div style="font-size:11px;color:#f1f5f9;line-height:1.45;white-space:pre-wrap;">${esc(notes)}</div>
        ${invalidation ? `<div style="margin-top:4px;font-size:9px;color:#fca5a5;">Invalidation: ${esc(invalidation)}</div>` : ''}
      </div>
    `;
  }

  // Fast mid-contract revalidation between LLM fires (every 8s)
  setInterval(() => {
    try {
      if (revalidateCached()) {
        window._markets5mLastRenderTs = 0;
        if (typeof window.renderMarkets5M === 'function') {
          const view = window.currentView || document.querySelector('[data-wecrypto-view]')?.dataset?.wecryptoView;
          if (view === 'markets5m') window.renderMarkets5M();
        }
        if (window.PolymarketTerminal?.render) window.PolymarketTerminal.render();
      }
    } catch (_) { /* */ }
  }, 8000);

  function start() {
    if (_timer) return;
    setTimeout(() => { tick().catch(() => {}); }, 10_000);
    _timer = setInterval(() => { tick().catch(() => {}); }, REFRESH_MS);
    console.info('[ASI1 PreContract] advisor started (5m+15m) interval', REFRESH_MS, 'ms');
  }

  function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
  }

  window.Asi1PreContract = {
    start,
    stop,
    tick,
    fireOne,
    revalidateCached,
    get,
    getAll: () => ({ ..._briefs }),
    renderStripHtml,
  };

  // Re-render surfaces when a new brief lands
  window.addEventListener('asi1:precontract', () => {
    try {
      window._markets5mLastRenderTs = 0;
      if (typeof window.renderMarkets5M === 'function') {
        const view = window.currentView || document.querySelector('[data-wecrypto-view]')?.dataset?.wecryptoView;
        if (view === 'markets5m') window.renderMarkets5M();
      }
      if (window.PolymarketTerminal?.render) {
        window.PolymarketTerminal.render();
      }
    } catch (_) { /* */ }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start());
  } else {
    start();
  }
})();
