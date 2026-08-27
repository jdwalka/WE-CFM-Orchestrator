/**
 * Surge prefetch — catch vertical expansions before the 15m paint fades them.
 *
 * The mechanical 15m path is "spot vs PTB". That stays DOWN while ETH is
 * still a few bps under the floor even as the tape is already exploding
 * through it. This module samples the last 2 minutes and flags tail risk
 * so finalizeCall / TruthGuard will not lock a fade into a squeeze.
 *
 * window.SurgePrefetch.evaluate(sym, ctx)
 * window.SurgePrefetch.against(call, sym)
 * window.SurgePrefetch.start() / .stop() / .get(sym)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.SurgePrefetch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WATCH = ['ETH', 'BTC', 'SOL', 'XRP', 'DOGE', 'HYPE', 'BNB'];
  const BIN_SYM = {
    ETH: 'ETHUSDT', BTC: 'BTCUSDT', SOL: 'SOLUSDT',
    XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', HYPE: 'HYPEUSDT', BNB: 'BNBUSDT',
  };
  const MAX_TICKS = 240;
  const SAMPLE_MS = 2000;
  const DESK_ROTATE_MS = 3500;
  const ACTIVE = 0.90;
  const FLIP = 1.35;

  const _ticks = Object.create(null); // SYM -> [{t, px}]
  const _last = Object.create(null);  // SYM -> verdict
  const _desk = Object.create(null);  // SYM -> books + metrics (must exist BEFORE entry)
  let _timer = null;
  let _deskTimer = null;
  let _deskIdx = 0;

  function normSym(s) {
    return String(s || '').toUpperCase().replace(/USDT$|USD$|PERP$/i, '').trim();
  }

  function normCall(c) {
    const u = String(c || '').toUpperCase().trim();
    if (u === 'UP' || u === 'BUY_UP' || u === 'YES' || u === 'LONG') return 'UP';
    if (u === 'DOWN' || u === 'BUY_DOWN' || u === 'NO' || u === 'SHORT') return 'DOWN';
    return null;
  }

  function pushTick(sym, px, t) {
    const key = normSym(sym);
    const price = Number(px);
    const ts = Number(t) || Date.now();
    if (!key || !(price > 0)) return;
    const arr = _ticks[key] || (_ticks[key] = []);
    const last = arr[arr.length - 1];
    if (last && ts - last.t < 400) {
      last.px = price;
      last.t = ts;
      return;
    }
    arr.push({ t: ts, px: price });
    if (arr.length > MAX_TICKS) arr.splice(0, arr.length - MAX_TICKS);
  }

  function priceAtOrBefore(ticks, t) {
    for (let i = ticks.length - 1; i >= 0; i--) {
      if (ticks[i].t <= t) return ticks[i].px;
    }
    return ticks.length ? ticks[0].px : null;
  }

  function retOver(ticks, now, windowMs) {
    if (!ticks || ticks.length < 2) return null;
    const a = priceAtOrBefore(ticks, now - windowMs);
    const b = ticks[ticks.length - 1].px;
    if (!(a > 0) || !(b > 0)) return null;
    return (b - a) / a;
  }

  function realizedAbs(ticks, now, windowMs) {
    if (!ticks || ticks.length < 4) return null;
    const cut = now - windowMs;
    let sum = 0;
    let n = 0;
    for (let i = 1; i < ticks.length; i++) {
      if (ticks[i].t < cut) continue;
      const p0 = ticks[i - 1].px;
      const p1 = ticks[i].px;
      if (p0 > 0 && p1 > 0) {
        sum += Math.abs((p1 - p0) / p0);
        n++;
      }
    }
    return n ? sum / n : null;
  }

  function levels(side) {
    if (!Array.isArray(side)) return [];
    return side.map((l) => {
      if (Array.isArray(l)) return { price: Number(l[0]), qty: Number(l[1]) };
      return { price: Number(l.price ?? l.px), qty: Number(l.qty ?? l.size ?? l.sz) };
    }).filter((l) => l.price > 0 && l.qty > 0);
  }

  function summarizeBook(raw) {
    if (!raw) return null;
    const bids = levels(raw.bids).sort((a, b) => b.price - a.price);
    const asks = levels(raw.asks).sort((a, b) => a.price - b.price);
    if (!bids.length && !asks.length) return null;
    const bidQty = bids.reduce((s, l) => s + l.qty, 0);
    const askQty = asks.reduce((s, l) => s + l.qty, 0);
    const tot = bidQty + askQty;
    const mid = (bids[0] && asks[0]) ? (bids[0].price + asks[0].price) / 2 : (bids[0]?.price || asks[0]?.price);
    const spread = (bids[0] && asks[0]) ? (asks[0].price - bids[0].price) : null;
    const bidWall = bids.reduce((m, l) => (l.qty > m.qty ? l : m), { qty: 0, price: 0 });
    const askWall = asks.reduce((m, l) => (l.qty > m.qty ? l : m), { qty: 0, price: 0 });
    return {
      bidQty,
      askQty,
      imbalance: tot > 0 ? (bidQty - askQty) / tot : 0,
      mid,
      spread,
      spreadBps: mid > 0 && spread != null ? (spread / mid) * 1e4 : null,
      bidWall,
      askWall,
      ts: raw.timestamp || Date.now(),
    };
  }

  function proxyGet(path) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => { try { ctrl?.abort(); } catch (_) { /* */ } }, 8000);
    const url = `http://127.0.0.1:3010${path}`;
    return fetch(url, { signal: ctrl?.signal }).then((r) => {
      clearTimeout(t);
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }).finally(() => clearTimeout(t));
  }

  async function prefetchCoin(sym) {
    const key = normSym(sym);
    const pair = BIN_SYM[key];
    if (!pair) return null;
    const prev = _desk[key] || {};
    const tasks = {
      book: proxyGet(`/binance/api/v3/depth?symbol=${pair}&limit=50`).catch(() => null),
      fbook: proxyGet(`/binance-f/fapi/v1/depth?symbol=${pair}&limit=20`).catch(() => null),
      prem: proxyGet(`/binance-f/fapi/v1/premiumIndex?symbol=${pair}`).catch(() => null),
      oi: proxyGet(`/binance-f/fapi/v1/openInterest?symbol=${pair}`).catch(() => null),
      t24: proxyGet(`/binance/api/v3/ticker/24hr?symbol=${pair}`).catch(() => null),
      k1: proxyGet(`/binance/api/v3/klines?symbol=${pair}&interval=1m&limit=30`).catch(() => null),
      trades: proxyGet(`/binance/api/v3/trades?symbol=${pair}&limit=80`).catch(() => null),
    };
    const got = {};
    await Promise.all(Object.keys(tasks).map(async (k) => { got[k] = await tasks[k]; }));

    const spotBook = summarizeBook(got.book);
    const futBook = summarizeBook(got.fbook);
    const book = spotBook || futBook;

    let funding = prev.funding;
    let mark = prev.mark;
    let basisPct = prev.basisPct;
    if (got.prem) {
      funding = Number(got.prem.lastFundingRate) * 100;
      mark = Number(got.prem.markPrice);
      const idx = Number(got.prem.indexPrice);
      if (mark > 0 && idx > 0) basisPct = ((mark - idx) / idx) * 100;
    }

    let oiUsd = prev.oiUsd;
    let oiDeltaPct = prev.oiDeltaPct;
    if (got.oi && mark > 0) {
      const contracts = Number(got.oi.openInterest);
      if (contracts > 0) {
        const nextOi = contracts * mark;
        if (oiUsd > 0) oiDeltaPct = ((nextOi - oiUsd) / oiUsd) * 100;
        oiUsd = nextOi;
      }
    }

    let ticker24 = prev.ticker24 || null;
    if (got.t24) {
      const last = Number(got.t24.lastPrice);
      const high = Number(got.t24.highPrice);
      const low = Number(got.t24.lowPrice);
      const chg = Number(got.t24.priceChangePercent);
      const vol = Number(got.t24.quoteVolume);
      const range = high > low ? (last - low) / (high - low) : 0.5;
      ticker24 = { last, high, low, chg, vol, rangePos: range };
      if (last > 0) pushTick(key, last, Date.now());
    }

    if (Array.isArray(got.k1)) {
      for (const row of got.k1) {
        const t = Number(row[0]);
        const c = Number(row[4]);
        if (t > 0 && c > 0) pushTick(key, c, t + 59_000);
      }
    }

    let cvdSlope = prev.cvdSlope;
    if (Array.isArray(got.trades) && got.trades.length > 8) {
      let cvd = 0;
      const series = [];
      for (const tr of got.trades) {
        const qty = Number(tr.qty);
        if (!(qty > 0)) continue;
        cvd += tr.isBuyerMaker ? -qty : qty;
        series.push(cvd);
      }
      if (series.length > 4) {
        const a = series[0];
        const b = series[series.length - 1];
        cvdSlope = (b - a) / (Math.abs(a) || 1) * 100;
      }
    }

    if (book && typeof window !== 'undefined' && window.PredictionEngine?.updateLiveOrderBook) {
      try {
        window.PredictionEngine.updateLiveOrderBook(key, {
          bids: (got.book || got.fbook)?.bids,
          asks: (got.book || got.fbook)?.asks,
          source: 'surge-prefetch',
        }, { silent: true });
      } catch (_) { /* */ }
    }

    const snap = {
      ts: Date.now(),
      book,
      futBook,
      funding: Number.isFinite(funding) ? funding : null,
      mark: Number.isFinite(mark) ? mark : null,
      basisPct: Number.isFinite(basisPct) ? basisPct : null,
      oiUsd: Number.isFinite(oiUsd) ? oiUsd : null,
      oiDeltaPct: Number.isFinite(oiDeltaPct) ? oiDeltaPct : null,
      ticker24,
      cvdSlope: Number.isFinite(cvdSlope) ? cvdSlope : null,
    };
    _desk[key] = snap;
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('surge:desk', { detail: { sym: key, snap } }));
      }
    } catch (_) { /* */ }
    return snap;
  }

  async function prefetchAll() {
    const list = WATCH.filter((s) => BIN_SYM[s]);
    await Promise.allSettled(list.map((s) => prefetchCoin(s)));
  }

  function kickEngines() {
    if (typeof window === 'undefined') return;
    try { window.OrderBook?.connectAll?.(); } catch (_) { /* */ }
    try { window.DerivativesFeed?.start?.(); } catch (_) { /* */ }
    try { window.PredictionEngine?.warmCache?.(); } catch (_) { /* */ }
    try { window.CandleWS?.start?.(); } catch (_) { /* */ }
  }

  function gatherCtx(sym, extra) {
    const key = normSym(sym);
    const ctx = Object.assign({ ticks: _ticks[key] || [] }, extra || {});
    if (typeof window === 'undefined') return ctx;

    if (!(ctx.spot > 0)) {
      try {
        const py = window.OracleSnapshot?.getPythSpot?.(key);
        if (py?.price > 0) ctx.spot = py.price;
      } catch (_) { /* */ }
      if (!(ctx.spot > 0)) {
        const v = window.PythBrowser?.getPrice?.(key) ?? window._pythPrices?.[key];
        if (Number(v) > 0) ctx.spot = Number(v);
      }
    }

    try {
      const coin = window.PredictionMarkets?.getCoin?.(key);
      const p15 = coin?.poly15m;
      const p5 = coin?.poly5m;
      const poly = p15 || p5;
      if (poly) {
        if (!(ctx.ptb > 0)) ctx.ptb = Number(p15?.priceToBeatNum ?? p5?.priceToBeatNum ?? p15?.targetPriceNum ?? p5?.targetPriceNum);
        if (ctx.bookImb == null) ctx.bookImb = Number(poly.depthImbalance);
        if (ctx.yesProb == null) ctx.yesProb = Number(poly.yesProb ?? poly.probability);
        if (ctx.secondsToClose == null) ctx.secondsToClose = Number(poly.secondsToClose);
      }
    } catch (_) { /* */ }

    try {
      const pred = window._predictions?.[key];
      if (pred) {
        if (ctx.cvdSlope == null) ctx.cvdSlope = Number(pred.cvd?.slope);
        if (!ctx.squeeze) ctx.squeeze = pred.squeeze || null;
        if (ctx.funding == null) ctx.funding = Number(pred.derivatives?.funding);
      }
    } catch (_) { /* */ }

    try {
      const micro = window.PredictionEngine?.getLiveMicrostructure?.(key);
      if (micro && ctx.bookImb == null) ctx.bookImb = Number(micro.imbalance ?? micro.bookImbalance);
    } catch (_) { /* */ }

    const desk = _desk[key];
    if (desk) {
      if (ctx.bookImb == null && desk.book) ctx.bookImb = desk.book.imbalance;
      if (ctx.cvdSlope == null && desk.cvdSlope != null) ctx.cvdSlope = desk.cvdSlope;
      if (ctx.funding == null && desk.funding != null) ctx.funding = desk.funding;
      ctx.desk = desk;
    }

    try {
      const liveBook = window.OrderBook?.getFreshBook?.(key, 4000);
      const liveSum = summarizeBook(liveBook);
      if (liveSum) {
        if (ctx.bookImb == null) ctx.bookImb = liveSum.imbalance;
        ctx.desk = Object.assign({}, ctx.desk || {}, { book: liveSum, live: true });
      }
    } catch (_) { /* */ }

    return ctx;
  }

  /**
   * Pure score. extra.ticks can be injected for tests.
   * score > 0 = upside expansion, < 0 = downside.
   */
  function evaluate(sym, extra) {
    const key = normSym(sym);
    const ctx = gatherCtx(key, extra);
    const ticks = Array.isArray(ctx.ticks) ? ctx.ticks : [];
    const now = Number(ctx.now) || Date.now();
    const reasons = [];
    let score = 0;

    const r15 = retOver(ticks, now, 15_000);
    const r45 = retOver(ticks, now, 45_000);
    const r120 = retOver(ticks, now, 120_000);
    const step = realizedAbs(ticks, now, 180_000);
    const sigma15 = (step != null ? step : 0.00008) * 6;

    if (r15 != null && sigma15 > 0) {
      const z15 = r15 / sigma15;
      if (Math.abs(z15) >= 2.0) {
        score += Math.sign(r15) * Math.min(1.6, Math.abs(z15) * 0.45);
        reasons.push(`z15=${z15.toFixed(1)}`);
      } else if (Math.abs(r15) >= 0.00055) {
        score += Math.sign(r15) * 0.55;
        reasons.push(`r15=${(r15 * 1e4).toFixed(1)}bps`);
      }
    }

    if (r15 != null && r45 != null && Math.sign(r15) === Math.sign(r45) && r15 !== 0) {
      if (Math.abs(r15) >= Math.abs(r45) * 0.45 && Math.abs(r15) >= 0.00035) {
        score += Math.sign(r15) * 0.75;
        reasons.push('accel');
      }
    }

    if (r120 != null && r15 != null && Math.sign(r15) === Math.sign(r120) && Math.abs(r15) >= 0.0004) {
      score += Math.sign(r15) * 0.25;
    }

    const imb = Number(ctx.bookImb);
    if (Number.isFinite(imb) && Math.abs(imb) >= 0.18) {
      score += Math.sign(imb) * 0.45;
      reasons.push(`book=${imb.toFixed(2)}`);
    }

    const cvd = Number(ctx.cvdSlope);
    if (Number.isFinite(cvd) && Math.abs(cvd) >= 8) {
      score += Math.sign(cvd) * 0.35;
      reasons.push(`cvd=${cvd.toFixed(0)}`);
    }

    const sq = ctx.squeeze;
    if (sq && (sq.type === 'short_squeeze' || sq.direction === 'up')) {
      score += sq.severity === 'high' ? 1.05 : 0.65;
      reasons.push('short-squeeze');
    } else if (sq && (sq.type === 'long_squeeze' || sq.direction === 'down')) {
      score -= sq.severity === 'high' ? 1.05 : 0.65;
      reasons.push('long-squeeze');
    }

    const desk = ctx.desk || _desk[key];
    if (desk && desk.book) {
      const wallBias = (desk.book.bidWall?.qty || 0) - (desk.book.askWall?.qty || 0);
      const wallTot = (desk.book.bidWall?.qty || 0) + (desk.book.askWall?.qty || 0);
      if (wallTot > 0 && Math.abs(wallBias) / wallTot >= 0.35) {
        score += Math.sign(wallBias) * 0.4;
        reasons.push(wallBias > 0 ? 'bid-wall' : 'ask-wall');
      }
      if (desk.book.spreadBps != null && desk.book.spreadBps > 8) {
        reasons.push(`thin-spread ${desk.book.spreadBps.toFixed(1)}bps`);
      }
    }
    if (desk && Number.isFinite(desk.funding)) {
      // Negative funding = shorts pay = squeeze-up risk if tape lifts
      if (desk.funding < -0.01 && (r15 == null || r15 >= 0)) {
        score += 0.35;
        reasons.push(`fund ${desk.funding.toFixed(3)}%`);
      } else if (desk.funding > 0.02 && (r15 == null || r15 <= 0)) {
        score -= 0.35;
        reasons.push(`fund ${desk.funding.toFixed(3)}%`);
      }
    }
    if (desk && Number.isFinite(desk.oiDeltaPct) && r15 != null) {
      if (desk.oiDeltaPct < -0.4 && r15 > 0.00025) {
        score += 0.55;
        reasons.push(`oi ${desk.oiDeltaPct.toFixed(2)}% + lift`);
      } else if (desk.oiDeltaPct < -0.4 && r15 < -0.00025) {
        score -= 0.55;
        reasons.push(`oi ${desk.oiDeltaPct.toFixed(2)}% + dump`);
      }
    }
    if (desk && desk.ticker24 && Number.isFinite(desk.ticker24.rangePos)) {
      if (desk.ticker24.rangePos >= 0.92 && r15 != null && r15 > 0) {
        reasons.push('24h-high chase');
      }
    }

    const spot = Number(ctx.spot);
    const ptb = Number(ctx.ptb);
    if (spot > 0 && ptb > 0 && r15 != null) {
      const gap = (spot - ptb) / ptb;
      // Still under the floor but ripping toward it — the fade-DOWN trap.
      if (gap < 0 && gap > -0.0020 && r15 > 0.00028) {
        score += 1.05;
        reasons.push(`chase-ptb ${(gap * 1e4).toFixed(1)}bps`);
      }
      if (gap > 0 && gap < 0.0020 && r15 < -0.00028) {
        score -= 1.05;
        reasons.push(`dump-to-ptb ${(gap * 1e4).toFixed(1)}bps`);
      }
    }

    const side = score >= ACTIVE ? 'UP' : score <= -ACTIVE ? 'DOWN' : null;
    const verdict = {
      ts: now,
      sym: key,
      active: !!side,
      side,
      score,
      reasons,
      r15,
      r45,
      r120,
      flip: !!side && Math.abs(score) >= FLIP,
      wait: !!side && Math.abs(score) < FLIP,
    };
    _last[key] = verdict;
    return verdict;
  }

  /**
   * If a proposed UP/DOWN fades a live surge, return how to treat it.
   * { action: 'flip'|'wait'|null, surge }
   */
  function against(call, sym, extra) {
    const proposed = normCall(call);
    const surge = evaluate(sym, extra);
    if (!proposed || !surge.active || surge.side === proposed) {
      return { action: null, surge };
    }
    return {
      action: surge.flip ? 'flip' : 'wait',
      surge,
    };
  }

  function sampleLive() {
    if (typeof window === 'undefined') return;
    for (const sym of WATCH) {
      let px = null;
      try {
        const py = window.OracleSnapshot?.getPythSpot?.(sym);
        if (py?.price > 0) px = py.price;
      } catch (_) { /* */ }
      if (!(px > 0)) {
        const v = window.PythBrowser?.getPrice?.(sym) ?? window._pythPrices?.[sym];
        if (Number(v) > 0) px = Number(v);
      }
      if (px > 0) pushTick(sym, px, Date.now());
      const v = evaluate(sym);
      if (v.active) {
        try {
          window.dispatchEvent(new CustomEvent('surge:tail', { detail: v }));
        } catch (_) { /* */ }
      }
    }
  }

  function start() {
    if (_timer) return;
    kickEngines();
    sampleLive();
    prefetchAll().catch(() => { /* */ });
    _timer = setInterval(sampleLive, SAMPLE_MS);
    _deskTimer = setInterval(() => {
      const sym = WATCH[_deskIdx % WATCH.length];
      _deskIdx += 1;
      prefetchCoin(sym).catch(() => { /* */ });
    }, DESK_ROTATE_MS);
  }

  function stop() {
    if (_timer) clearInterval(_timer);
    if (_deskTimer) clearInterval(_deskTimer);
    _timer = null;
    _deskTimer = null;
  }

  function get(sym) {
    return _last[normSym(sym)] || null;
  }

  function getDesk(sym) {
    return _desk[normSym(sym)] || null;
  }

  return {
    evaluate,
    against,
    pushTick,
    prefetchCoin,
    prefetchAll,
    start,
    stop,
    get,
    getDesk,
    _ticks,
    _desk,
    ACTIVE,
    FLIP,
  };
}));

if (typeof window !== 'undefined') {
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => window.SurgePrefetch?.start?.());
    } else {
      window.SurgePrefetch?.start?.();
    }
  } catch (_) { /* */ }
}
