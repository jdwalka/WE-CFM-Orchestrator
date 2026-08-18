/**
 * Live 15m Up/Down path — settlement-first color/direction.
 *
 * Model / Grok calls stay sticky (6–12 min cadence) and only flipped on
 * extreme odds. This module is the opposite: every Pyth tick + PTB +
 * window return + CLOB/book vote a live path. The painted UP/DOWN color
 * should follow this, not the last model prediction.
 *
 *   window.LivePath15m.resolve(sym, ctx)
 *   window.LivePath15m.fromAny(snapshotOrSym, ctx?)
 *   window.LivePath15m.noteTick(sym, px)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.LivePath15m = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 0.8 bps (~$5 on BTC, ~$0.15 on ETH) is already a visible path, not an
  // "extreme swing". Old paint logic waited for 12–18¢ of YES or last-15s.
  const PATH_BPS_MIN = 0.8;
  const PATH_BPS_STRONG = 3.0;
  const MKT_EDGE = 0.06;
  const BOOK_EDGE = 0.12;
  const TICK_WINDOW_MS = 12_000;
  const TICK_MAX = 24;

  const _ticks = Object.create(null);

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function noteTick(sym, px, ts) {
    const key = String(sym || '').toUpperCase();
    const price = num(px);
    if (!key || !(price > 0)) return;
    const t = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
    if (!_ticks[key]) _ticks[key] = [];
    const arr = _ticks[key];
    const last = arr[arr.length - 1];
    if (last && t - last.t < 80 && Math.abs(price - last.px) / last.px < 1e-7) return;
    arr.push({ t, px: price });
    const cutoff = t - TICK_WINDOW_MS;
    while (arr.length > TICK_MAX || (arr.length && arr[0].t < cutoff)) arr.shift();
  }

  function tickMomentumBps(sym) {
    const arr = _ticks[String(sym || '').toUpperCase()];
    if (!arr || arr.length < 3) return null;
    const first = arr[0];
    const last = arr[arr.length - 1];
    if (!(first.px > 0) || last.t - first.t < 400) return null;
    return ((last.px - first.px) / first.px) * 10000;
  }

  function resolveSpot(sym, ctx) {
    const c = ctx || {};
    const direct = num(c.spot ?? c.price ?? c.currentPrice);
    if (direct > 0) return direct;
    try {
      if (typeof window !== 'undefined') {
        const o = window.OracleSnapshot?.getPythSpot?.(sym);
        if (o && o.price > 0) return Number(o.price);
        const p = window.PythBrowser?.getPrice?.(sym) ?? window._pythPrices?.[String(sym).toUpperCase()];
        if (Number(p) > 0) return Number(p);
      }
    } catch (_) { /* */ }
    const poly = c.poly15m || c.market || {};
    const fromMkt = num(poly.currentPriceNum ?? poly.currentPrice);
    return fromMkt > 0 ? fromMkt : null;
  }

  function resolvePtb(ctx) {
    const poly = (ctx && (ctx.poly15m || ctx.market)) || {};
    const raw = num(poly.priceToBeatNum ?? poly.targetPriceNum ?? ctx?.ptb);
    if (!(raw > 0)) return null;
    const src = String(poly.priceToBeatSource || poly.ptbSource || ctx?.ptbSource || '').toLowerCase();
    if (/rtds|twap30|title|provisional|coinbase|binance|gecko|rti|crypto-price|boundary|rejected:/.test(src)) {
      return null;
    }
    return raw;
  }

  /**
   * Normalize the three UI shapes (Grok snapshot, prediction card, hourly
   * panel) into the ctx `resolve()` already understands. New paint sites
   * should call `fromAny` so live-path semantics cannot drift.
   */
  function normalizeCtx(src) {
    const s = src || {};
    const poly = s.poly15m || s.market || s.poly || {};
    const session = s.sessionMemory || {};
    return {
      spot: s.spot ?? s.price ?? s.currentPrice,
      poly15m: poly,
      market: poly,
      open15: s.open15 || s.sessionOpen || session.open15m,
      modelScore: s.modelScore ?? s.score,
      liveDirection: s.liveDirection ?? poly.liveDirection,
      settlementLiveDirection: s.settlementLiveDirection ?? poly.settlementLiveDirection,
      yesProb: s.yesProb,
      depthImbalance: s.depthImbalance,
      ts: s.ts,
      ptb: s.ptb,
      ptbSource: s.ptbSource,
    };
  }

  function fromAny(symOrInput, maybeCtx) {
    if (typeof symOrInput === 'string') {
      return resolve(symOrInput, normalizeCtx(maybeCtx || {}));
    }
    const src = Object.assign({}, symOrInput || {}, maybeCtx || {});
    const coin = String(src.sym || src.coin || src.symbol || '').toUpperCase();
    return resolve(coin, normalizeCtx(src));
  }

  /**
   * @returns {{
   *   dir: 'UP'|'DOWN'|null,
   *   bps: number|null,
   *   confidence: number,
   *   sources: string[],
   *   votes: object[],
   *   spot: number|null,
   *   ptb: number|null,
   *   yesProb: number|null,
   *   reason: string
   * }}
   */
  function resolve(sym, ctx) {
    const c = ctx || {};
    const coin = String(sym || c.sym || '').toUpperCase();
    const spot = resolveSpot(coin, c);
    const ptb = resolvePtb(c);
    const poly = c.poly15m || c.market || {};
    if (spot > 0) noteTick(coin, spot, c.ts);

    const votes = [];

    if (spot > 0 && ptb > 0) {
      const bps = ((spot - ptb) / ptb) * 10000;
      if (Math.abs(bps) >= PATH_BPS_MIN) {
        votes.push({
          source: 'spot_vs_ptb',
          call: bps > 0 ? 'UP' : 'DOWN',
          weight: clamp(Math.abs(bps) / PATH_BPS_STRONG, 0.55, 1.8),
          detail: `${bps >= 0 ? '+' : ''}${bps.toFixed(1)}bps vs PTB`,
        });
      }
    }

    const liveDir = String(poly.liveDirection || c.liveDirection || '').toUpperCase();
    if (liveDir === 'UP' || liveDir === 'DOWN') {
      votes.push({ source: 'live_direction', call: liveDir, weight: 0.85, detail: `liveDirection=${liveDir}` });
    }
    const settleDir = String(poly.settlementLiveDirection || c.settlementLiveDirection || '').toUpperCase();
    if (settleDir === 'UP' || settleDir === 'DOWN') {
      votes.push({ source: 'settlement_path', call: settleDir, weight: 0.7, detail: `settlement=${settleDir}` });
    }

    const open15 = c.open15 || c.sessionOpen || null;
    const o = num(open15 && (open15.o ?? open15.open));
    const cl = num(open15 && (open15.c ?? open15.close ?? open15.last));
    if (o > 0 && cl > 0) {
      const winBps = ((cl - o) / o) * 10000;
      if (Math.abs(winBps) >= 1.2) {
        votes.push({
          source: 'window_return',
          call: winBps > 0 ? 'UP' : 'DOWN',
          weight: clamp(Math.abs(winBps) / 8, 0.25, 0.7),
          detail: `window ${winBps >= 0 ? '+' : ''}${winBps.toFixed(1)}bps`,
        });
      }
    }

    const tickBps = tickMomentumBps(coin);
    if (tickBps != null && Math.abs(tickBps) >= 1.0) {
      votes.push({
        source: 'tick_momentum',
        call: tickBps > 0 ? 'UP' : 'DOWN',
        weight: clamp(Math.abs(tickBps) / 10, 0.2, 0.55),
        detail: `ticks ${tickBps >= 0 ? '+' : ''}${tickBps.toFixed(1)}bps`,
      });
    }

    const yes = num(poly.yesProb ?? poly.probability ?? poly.upProbability ?? c.yesProb);
    if (yes != null && Math.abs(yes - 0.5) >= MKT_EDGE) {
      votes.push({
        source: 'clob_yes',
        call: yes >= 0.5 ? 'UP' : 'DOWN',
        weight: clamp(Math.abs(yes - 0.5) / 0.35, 0.2, 0.55),
        detail: `P(Up)=${(yes * 100).toFixed(0)}%`,
      });
    }

    const imb = num(poly.depthImbalance ?? c.depthImbalance);
    if (imb != null && Math.abs(imb) >= BOOK_EDGE) {
      votes.push({
        source: 'book',
        call: imb > 0 ? 'UP' : 'DOWN',
        weight: clamp(Math.abs(imb), 0.2, 0.45),
        detail: `book=${imb.toFixed(2)}`,
      });
    }

    // Model is a last-resort vote only when we have no settlement path
    // (no usable PTB). A flat tape next to a real PTB must stay unpainted,
    // not inherit the last Grok/model lean.
    const liveWeight = votes.reduce((s, v) => s + v.weight, 0);
    const ms = num(c.modelScore ?? c.score);
    if (ptb == null && liveWeight < 0.55 && ms != null && Math.abs(ms) >= 0.18) {
      votes.push({
        source: 'model_fallback',
        call: ms > 0 ? 'UP' : 'DOWN',
        weight: 0.2,
        detail: `model=${ms.toFixed(3)}`,
      });
    }

    let up = 0;
    let down = 0;
    for (const v of votes) {
      if (v.call === 'UP') up += v.weight;
      else if (v.call === 'DOWN') down += v.weight;
    }

    const bps = (spot > 0 && ptb > 0) ? ((spot - ptb) / ptb) * 10000 : null;
    // Spot vs PTB is the settlement definition — it wins a tie, and it
    // wins outright once it is past PATH_BPS_MIN even if Grok/model lean
    // the other way.
    let dir = null;
    if (bps != null && Math.abs(bps) >= PATH_BPS_MIN) {
      dir = bps > 0 ? 'UP' : 'DOWN';
    } else if (up !== down) {
      dir = up > down ? 'UP' : 'DOWN';
    }

    const strength = clamp(Math.abs(up - down) / Math.max(up + down, 1e-6), 0, 1);
    const sources = votes.map((v) => v.source);
    const reason = dir
      ? `${dir} via ${sources.join('+') || 'path'}`
      : 'flat/insufficient live edge';

    return {
      dir,
      bps,
      confidence: dir ? clamp(0.52 + strength * 0.4, 0.52, 0.96) : 0.5,
      sources,
      votes,
      spot,
      ptb,
      yesProb: yes,
      reason,
      ts: Date.now(),
    };
  }

  return {
    resolve,
    fromAny,
    normalizeCtx,
    noteTick,
    tickMomentumBps,
    PATH_BPS_MIN,
    PATH_BPS_STRONG,
  };
}));
