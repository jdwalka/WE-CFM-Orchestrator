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
  // Stagger AI fire away from the exact window-open instant: prediction-markets.js's
  // boundary-clock rollover locks PTB asynchronously right at open (chainlink-candles
  // fetch + retry-backed pending lock), and observed cases showed the AI capturing a
  // stale (pre-rollover) PTB when it fired too close to open. Waiting a few seconds
  // gives that lock time to land before the AI reads it.
  const MIN_SECONDS_SINCE_OPEN = Number(window.__ASI1_MIN_SEC_SINCE_OPEN ?? 12); // 5-15s window
  const WINDOW_SECONDS = { '5m': 300, '15m': 900 };

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

  /** Reject non-Polymarket PTB proxies (RTDS TWAP, title, CEX, etc.). */
  function isCanonicalPtbSource(src) {
    const s = String(src || '').toLowerCase();
    if (!s) return true; // poly market field without tag still ok if number present
    if (/rtds|twap30|title|provisional|coinbase|binance|gecko|rti|crypto-price|boundary|rejected:/.test(s)) {
      return false;
    }
    return /poly|gamma|chainlink|clob|candle|lock|event|openprice|pricetobeat/.test(s);
  }

  function buildMarketContext(sym, preferHorizon) {
    // Prefer OracleSnapshot (Pyth spot + Polymarket PTB only)
    try {
      if (window.OracleSnapshot?.buildOraclePacket) {
        const o = window.OracleSnapshot.buildOraclePacket(sym, preferHorizon === '5m' ? '5m' : '15m');
        const w = o?.active;
        if (w?.slug) {
          const ptbOk = w.priceToBeatNum != null && isCanonicalPtbSource(w.priceToBeatSource);
          return {
            sym: String(sym).toUpperCase(),
            horizon: w.horizon || (preferHorizon === '5m' ? '5m' : '15m'),
            slug: w.slug,
            live: w.live !== false,
            yesProb: w.yesProb ?? null,
            priceToBeatNum: ptbOk ? w.priceToBeatNum : null,
            priceToBeatSource: ptbOk ? (w.priceToBeatSource || 'polymarket') : null,
            secondsToClose: w.secondsToClose ?? null,
            bestBid: w.bestBid ?? null,
            bestAsk: w.bestAsk ?? null,
            mid: w.mid ?? null,
            spread: w.spread ?? null,
            depthImbalance: w.depthImbalance ?? null,
            nearTouchNotional: w.nearTouchNotional ?? null,
            liveDirection: w.liveDirection || o.pathDir || null,
            spot: o.spot,
            spotSource: o.spotSource || 'pyth',
            deltaVsPtb: ptbOk ? o.deltaVsPtb : null,
            oraclePolicy: o.oraclePolicy,
            oracleWarnings: o.warnings || [],
          };
        }
      }
    } catch (_) { /* fall through */ }

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

    // Spot = Pyth only (never RTI/CEX as AI spot)
    const spot = Number(
      window.PythBrowser?.getPrice?.(sym)
      || window._pythPrices?.[String(sym).toUpperCase()]
      || 0
    );
    const rawPtb = Number(m.priceToBeatNum || m.targetPriceNum || 0);
    const ptbSource = m.priceToBeatSource || m.ptbSource || null;
    const ptbOk = Number.isFinite(rawPtb) && rawPtb > 0 && isCanonicalPtbSource(ptbSource);
    // Coin decimals: BTC/SOL=2, XRP=4 — never pass float trails to AI
    const roundPtb = (n) => {
      if (!Number.isFinite(n) || n <= 0) return null;
      const d = /^(XRP|DOGE)$/i.test(sym) ? 4 : 2;
      const f = 10 ** d;
      return Math.round(n * f) / f;
    };
    const ptb = ptbOk ? roundPtb(rawPtb) : null;
    const ttc = Number(m.secondsToClose);
    const yes = Number(m.probability ?? m.upProbability ?? m.yesProb);

    return {
      sym,
      horizon,
      slug: m.slug,
      live: m.live !== false,
      yesProb: Number.isFinite(yes) ? yes : null,
      priceToBeatNum: ptb,
      priceToBeatSource: ptbOk ? (ptbSource || 'polymarket') : null,
      secondsToClose: Number.isFinite(ttc) ? ttc : null,
      bestBid: m.bestBid ?? null,
      bestAsk: m.bestAsk ?? null,
      mid: m.mid ?? null,
      spread: m.spread ?? null,
      depthImbalance: m.depthImbalance ?? null,
      nearTouchNotional: m.nearTouchNotional ?? null,
      liveDirection: m.liveDirection || null,
      spot: Number.isFinite(spot) && spot > 0 ? spot : null,
      spotSource: 'pyth',
      deltaVsPtb: Number.isFinite(spot) && ptb != null ? spot - ptb : null,
      oraclePolicy: 'pyth_spot_plus_polymarket_ptb_only',
      oracleWarnings: ptb == null ? ['no_polymarket_ptb'] : [],
    };
  }

  function applyModelPack(snap, pack) {
    if (!snap || !pack) return snap;
    snap.direction = pack.direction || snap.direction;
    snap.modelDirection = pack.direction || snap.modelDirection;
    snap.score = pack.score ?? snap.score;
    snap.modelScore = pack.score ?? snap.modelScore;
    snap.confidence = pack.confidence ?? snap.confidence;
    snap.regimeLocal = pack.regime || snap.regimeLocal;
    snap.regime = pack.regime || snap.regime;
    snap.modelAgreement = pack.agreement || snap.modelAgreement;
    snap.agreement = pack.agreement || snap.agreement;
    if (pack.indicators) snap.indicators = pack.indicators;
    snap.market = {
      ...(snap.market || {}),
      modelDirection: pack.direction,
      modelScore: pack.score,
      score: pack.score,
      confidencePct: pack.confidence != null ? Math.round(pack.confidence * 100) : null,
      regime: pack.regime,
      agreement: pack.agreement,
      indicators: pack.indicators,
    };
    return snap;
  }

  function buildSnapshot(sym, ctx) {
    const pack = resolvePredPack(sym);

    // Prefer full oracle packet for LLM (includes strict PTB + Pyth)
    try {
      if (window.OracleSnapshot?.buildLlmSnapshot) {
        const snap = window.OracleSnapshot.buildLlmSnapshot(sym, ctx.horizon, { pred: pack });
        snap.preContract = true;
        snap.preferAsi1 = true;
        snap.rangePrediction = true;
        // Force horizon to the market we actually selected
        if (ctx.horizon === '5m') {
          snap.horizon = '5m';
          snap.horizonMinutes = 5;
          snap.rangeHorizonMinutes = 15;
          snap.fiveMinute = true;
        } else {
          snap.horizon = '15m';
          snap.horizonMinutes = 15;
          snap.rangeHorizonMinutes = 15;
        }
        // Overlay live CLOB fields from ctx
        const block = {
          slug: ctx.slug,
          live: true,
          yesProb: ctx.yesProb,
          probability: ctx.yesProb,
          priceToBeatNum: ctx.priceToBeatNum,
          priceToBeatSource: ctx.priceToBeatSource,
          secondsToClose: ctx.secondsToClose,
          bestBid: ctx.bestBid,
          bestAsk: ctx.bestAsk,
          mid: ctx.mid,
          spread: ctx.spread,
          depthImbalance: ctx.depthImbalance,
          nearTouchNotional: ctx.nearTouchNotional,
          liveDirection: ctx.liveDirection,
          settlementRule: `Polymarket ${ctx.horizon}: Up if finishes above Polymarket PTB at close.`,
        };
        if (ctx.horizon === '5m') snap.poly5m = block;
        else snap.poly15m = block;
        snap.activeContract = block;
        snap.currentPrice = ctx.spot;
        snap.price = ctx.spot;
        snap.priceSource = ctx.spotSource || 'pyth';
        snap.polymarketOracle = {
          slug: ctx.slug,
          priceToBeatNum: ctx.priceToBeatNum,
          priceToBeatSource: ctx.priceToBeatSource,
          pythSpot: ctx.spot,
          pythSource: ctx.spotSource || 'pyth',
          pathDir: ctx.liveDirection,
          deltaVsPtb: ctx.deltaVsPtb,
          yesProb: ctx.yesProb,
          secondsToClose: ctx.secondsToClose,
          rule: 'PTB is Polymarket window open only. Spot is Pyth only. Do not invent PTB.',
        };
        return applyModelPack(snap, pack);
      }
    } catch (_) { /* fall through */ }

    const is5 = ctx.horizon === '5m';
    const polyBlock = {
      slug: ctx.slug,
      live: true,
      yesProb: ctx.yesProb,
      probability: ctx.yesProb,
      priceToBeatNum: ctx.priceToBeatNum,
      priceToBeatSource: ctx.priceToBeatSource,
      secondsToClose: ctx.secondsToClose,
      bestBid: ctx.bestBid,
      bestAsk: ctx.bestAsk,
      mid: ctx.mid,
      spread: ctx.spread,
      depthImbalance: ctx.depthImbalance,
      nearTouchNotional: ctx.nearTouchNotional,
      liveDirection: ctx.liveDirection,
    };
    const snap = {
      coin: sym,
      preContract: true,
      preferAsi1: true,
      rangePrediction: !is5,
      fiveMinute: is5,
      rangeHorizonMinutes: 15,
      horizonMinutes: is5 ? 5 : 15,
      horizon: is5 ? '5m' : '15m',
      currentPrice: ctx.spot,
      price: ctx.spot,
      priceSource: ctx.spotSource || 'pyth',
      oraclePolicy: ctx.oraclePolicy || 'pyth_spot_plus_polymarket_ptb_only',
      oracleWarnings: ctx.oracleWarnings || [],
      poly5m: is5 ? polyBlock : null,
      poly15m: !is5 ? polyBlock : (window.PredictionMarkets?.getCoin?.(sym)?.poly15m || null),
      activeContract: {
        slug: ctx.slug,
        yesProb: ctx.yesProb,
        priceToBeatNum: ctx.priceToBeatNum,
        priceToBeatSource: ctx.priceToBeatSource,
        secondsToClose: ctx.secondsToClose,
      },
      polymarketOracle: {
        slug: ctx.slug,
        priceToBeatNum: ctx.priceToBeatNum,
        priceToBeatSource: ctx.priceToBeatSource,
        pythSpot: ctx.spot,
        pythSource: ctx.spotSource || 'pyth',
        deltaVsPtb: ctx.deltaVsPtb,
        rule: 'PTB is Polymarket window open only. Spot is Pyth only. Do not invent PTB.',
      },
    };
    return applyModelPack(snap, pack);
  }

  function briefKey(sym, horizon) {
    return `${String(sym).toUpperCase()}:${horizon === '5m' ? '5m' : '15m'}`;
  }

  /** Full PredictionEngine pack for LLM model-guide blocks */
  function resolvePredPack(sym) {
    let pred = null;
    try {
      pred = window.PredictionEngine?.get?.(sym)
        || window.PredictionEngine?.getPrediction?.(sym)
        || window.predictions?.[sym]
        || window._predictions?.[sym]
        || null;
    } catch (_) { pred = null; }
    if (!pred) return null;
    const score = Number(pred.score);
    const conf = Number(pred.confidence);
    const dir = String(pred.direction || pred.signal || '').toUpperCase();
    const direction = (dir === 'UP' || dir === 'DOWN')
      ? dir
      : (Number.isFinite(score)
        ? (score > 0.05 ? 'UP' : score < -0.05 ? 'DOWN' : null)
        : null);
    // Trim bulky indicator objects to labels the prompt can use
    let indicators = null;
    try {
      const raw = pred.indicators || pred.diagnostics?.components || null;
      if (raw && typeof raw === 'object') {
        indicators = {};
        for (const k of Object.keys(raw).slice(0, 16)) {
          const row = raw[k];
          if (row && typeof row === 'object') {
            indicators[k] = {
              label: row.label || null,
              value: row.value != null ? row.value : (row.signal != null ? row.signal : null),
              signal: row.signal != null ? row.signal : null,
            };
          }
        }
      }
    } catch (_) { indicators = null; }
    return {
      direction,
      signal: pred.signal || direction,
      score: Number.isFinite(score) ? score : null,
      confidence: Number.isFinite(conf) ? (conf > 1 ? conf / 100 : conf) : null,
      regime: pred.regime || pred.regimeLocal || null,
      agreement: pred.agreement || pred.coreAgreement || null,
      indicators,
    };
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
    // Correctness gate, not a timer: verify ctx.slug's own encoded window boundary
    // matches the boundary Date.now() says is actually current right now. A stale
    // (already-rolled-over) market context has a real, canonically-sourced PTB —
    // it's just for a window that no longer exists — so the trusted-source check
    // in buildMarketContext can't catch this on its own. No time budget: keep
    // skipping and retrying every cycle for as long as it takes, rather than firing
    // on a guess. Wrong info is worse than no info.
    const windowSec = WINDOW_SECONDS[ctx.horizon];
    if (ctx.slug && windowSec) {
      const slugMatch = ctx.slug.match(/-(\d+)$/);
      const slugBoundary = slugMatch ? Number(slugMatch[1]) : null;
      const nowSec = Math.floor(Date.now() / 1000);
      const expectedBoundary = nowSec - (nowSec % windowSec);
      if (slugBoundary != null && slugBoundary !== expectedBoundary) {
        console.warn(
          `[ASI1 PreContract] ${sym} ${ctx.horizon} market context is stale ` +
          `(slug boundary ${slugBoundary}, expected ${expectedBoundary}) — ` +
          `skipping fire rather than risk a wrong PTB, will retry next cycle`
        );
        return _briefs[briefKey(sym, ctx.horizon)] || null;
      }
    }
    // Belt-and-suspenders: also require a minimum settle time past open even once
    // the boundary matches, since the PTB lock write can trail the window-open
    // instant by a second or two.
    if (ctx.secondsToClose != null && windowSec) {
      const secondsSinceOpen = windowSec - ctx.secondsToClose;
      if (secondsSinceOpen >= 0 && secondsSinceOpen < MIN_SECONDS_SINCE_OPEN) {
        return _briefs[briefKey(sym, ctx.horizon)] || null;
      }
    }

    const invoke = window.electron?.invoke;
    if (typeof invoke !== 'function') return null;

    const snapshot = buildSnapshot(sym, ctx);
    try {
      const res = await invoke('llm:analyzeSnapshot', snapshot);
      if (!res?.success || !res.output) return null;
      const o = res.output;
      // Client-side float scrub (BTC/SOL 2dp, XRP 4dp) even if main process is stale
      const scrubLocal = (t) => {
        let s = String(t || '');
        s = s.replace(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\.([0-9]{3,})/g, (full, intP, frac) => {
          const raw = Number(String(intP).replace(/,/g, '') + '.' + frac);
          if (!Number.isFinite(raw) || raw <= 0) return full;
          const d = /^(XRP|DOGE)$/i.test(sym) ? 4 : 2;
          const f = 10 ** d;
          const n = Math.round(raw * f) / f;
          return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
        });
        return s;
      };
      const notes = scrubLocal(String(o?.suggestions?.notes || o?.ai_wording?.primary_rationale || '').trim());
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
        primaryRationale: scrubLocal(o?.ai_wording?.primary_rationale || notes),
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
        const pack = resolvePredPack(sym);
        brief = window.InferenceTruthGuard.gateBrief(brief, {
          horizon: ctx.horizon,
          market: ctx,
          modelScore: pack?.score,
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
      const pack = resolvePredPack(brief.sym);
      // Gate against original AI call so we can flip nullify on/off as path changes
      const rawCall = brief.aiCallOriginal || brief.call;
      const gated = window.InferenceTruthGuard.gateBrief(
        { ...brief, call: rawCall, notes: brief.primaryRationale || brief.notes },
        { horizon: brief.horizon, market: ctx, modelScore: pack?.score }
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

  let _revalidateTimer = null;

  function start() {
    if (_timer) return;
    setTimeout(() => { tick().catch(() => {}); }, 10_000);
    _timer = setInterval(() => { tick().catch(() => {}); }, REFRESH_MS);
    if (!_revalidateTimer) {
      // Fast mid-contract revalidation between LLM fires (every 8s)
      _revalidateTimer = setInterval(() => {
        try {
          if (revalidateCached()) {
            window._markets5mLastRenderTs = 0;
            const view = window.currentView || document.querySelector('[data-wecrypto-view]')?.dataset?.wecryptoView;
            if (view === 'markets5m' && typeof window.renderMarkets5M === 'function') window.renderMarkets5M();
            if (view === 'polymarket' && window.PolymarketTerminal?.render) window.PolymarketTerminal.render();
          }
        } catch (_) { /* */ }
      }, 8000);
    }
    console.info('[ASI1 PreContract] advisor started (5m+15m) interval', REFRESH_MS, 'ms');
  }

  function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
    if (_revalidateTimer) clearInterval(_revalidateTimer);
    _revalidateTimer = null;
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
      const view = window.currentView || document.querySelector('[data-wecrypto-view]')?.dataset?.wecryptoView;
      if (view === 'markets5m' && typeof window.renderMarkets5M === 'function') window.renderMarkets5M();
      if (view === 'polymarket' && window.PolymarketTerminal?.render) window.PolymarketTerminal.render();
    } catch (_) { /* */ }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start());
  } else {
    start();
  }
})();
