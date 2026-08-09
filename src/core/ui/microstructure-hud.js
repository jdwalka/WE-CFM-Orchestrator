// microstructure-hud.js — Micro-momentum, volume divergence, and order book
// imbalance for the 5m markets panel's Polymarket embed overlay (display only).
//
// Not to be confused with src/core/predictions/microstructure.js
// (window.PredictionMicrostructure), which rescopes the prediction engine's own
// odds from order-book state. That module feeds the model; this one only feeds
// the HUD the user sees drawn over the embeds. They read some of the same
// underlying feeds but serve different consumers and expose different globals
// (window.Microstructure here vs window.PredictionMicrostructure there).
//
// Deliberately built on data that is already live in this app rather than adding
// new network connections:
//   - Order book imbalance: window.OB.getBalanceMetrics(sym) (orderbook.js), a live
//     Hyperliquid L2 book feed already streaming for all 7 coins.
//   - Volume divergence: window.ExchangeWS.getTicker('BINANCE'|'COINBASE', sym)
//     (exchange-ws.js), a real trade-tape buy/sell mix over a rolling 2-minute
//     window, already streaming.
//   - Micro-momentum: the one genuinely new piece. Neither feed above exposes price
//     history, so this module samples the best available live price every 2s into a
//     short per-symbol ring buffer and derives % change over 30s/60s from that.
//
// Exposes: window.Microstructure.{start, stop, getSnapshot, getMomentum,
//   getImbalance, getVolumeDivergence}
(function () {
  'use strict';

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const SAMPLE_MS = 2000;
  const BUFFER_MS = 90_000; // covers the 30s/60s momentum windows with margin
  const FLAT_EPS = 0.0002; // 0.02% -- below this, price is treated as flat, not drifting

  const priceBuf = {}; // sym -> [{ ts, price }], oldest first

  function samplePrice(sym) {
    // Prefer the live trade-tape price (updates on every trade, sub-second).
    const bin = window.ExchangeWS?.getTicker?.('BINANCE', sym, 15_000);
    if (bin && Number.isFinite(bin.price) && bin.price > 0) return bin.price;
    const cb = window.ExchangeWS?.getTicker?.('COINBASE', sym, 15_000);
    if (cb && Number.isFinite(cb.price) && cb.price > 0) return cb.price;
    // Fall back to whatever the app's own Pyth Lazer ticker cache last saw.
    const t = window._appTickers?.[`${sym}USD`];
    const p = Number(t?.last);
    return Number.isFinite(p) && p > 0 ? p : null;
  }

  function tick() {
    const now = Date.now();
    for (const sym of COINS) {
      const p = samplePrice(sym);
      if (p == null) continue;
      const buf = priceBuf[sym] || (priceBuf[sym] = []);
      buf.push({ ts: now, price: p });
      const cutoff = now - BUFFER_MS;
      let i = 0;
      while (i < buf.length && buf[i].ts < cutoff) i++;
      if (i > 0) buf.splice(0, i);
    }
  }

  function pctChangeSince(sym, windowMs) {
    const buf = priceBuf[sym];
    if (!buf || buf.length < 2) return null;
    const target = Date.now() - windowMs;
    let anchor = buf[0];
    for (const s of buf) {
      if (s.ts >= target) { anchor = s; break; }
    }
    const latest = buf[buf.length - 1];
    if (!anchor || !latest || !(anchor.price > 0)) return null;
    return (latest.price - anchor.price) / anchor.price;
  }

  function getMomentum(sym) {
    const pct30 = pctChangeSince(sym, 30_000);
    const pct60 = pctChangeSince(sym, 60_000);
    const primary = pct30 ?? pct60;
    if (primary == null) return null;
    const dir = primary > FLAT_EPS ? 'UP' : primary < -FLAT_EPS ? 'DOWN' : 'FLAT';
    return { pct30, pct60, dir };
  }

  function getImbalance(sym) {
    const m = window.OB?.getBalanceMetrics?.(sym);
    if (!m) return null;
    return {
      value: m.imbalance?.value ?? null,   // -1 (all ask) .. +1 (all bid)
      band: m.imbalance?.band ?? null,     // extreme_bid/strong_bid/lean_bid/balanced/lean_ask/...
      velocityBand: m.velocity?.band ?? null, // bid_accelerating/bid_building/stable/ask_building/ask_accelerating
    };
  }

  function getVolumeDivergence(sym) {
    const xw = window.ExchangeWS?.getTicker?.('BINANCE', sym, 30_000)
      ?? window.ExchangeWS?.getTicker?.('COINBASE', sym, 30_000);
    if (!xw || !Number.isFinite(xw.buyPct)) return null;
    const momentum = getMomentum(sym);
    const buyPct = xw.buyPct;
    const tapeLean = buyPct > 55 ? 'BUY' : buyPct < 45 ? 'SELL' : 'NEUTRAL';
    // "Divergence" here means the real trade tape disagrees with where price has
    // actually been moving over the last 30-60s -- e.g. price grinding up while the
    // tape is net-selling into it (absorption), which often precedes a reversal.
    let label = 'CONFIRMING';
    if (!momentum || momentum.dir === 'FLAT' || tapeLean === 'NEUTRAL') label = 'NEUTRAL';
    else if (momentum.dir === 'UP' && tapeLean === 'SELL') label = 'BEARISH DIVERGENCE';
    else if (momentum.dir === 'DOWN' && tapeLean === 'BUY') label = 'BULLISH DIVERGENCE';
    return { buyPct, sellPct: xw.sellPct, tapeLean, label, priceDir: momentum?.dir ?? null };
  }

  function getSnapshot(sym) {
    return {
      momentum: getMomentum(sym),
      imbalance: getImbalance(sym),
      volumeDivergence: getVolumeDivergence(sym),
      ts: Date.now(),
    };
  }

  let _timer = null;
  function start() {
    if (_timer) return;
    tick();
    _timer = setInterval(tick, SAMPLE_MS);
  }
  function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
  }

  window.Microstructure = { start, stop, getSnapshot, getMomentum, getImbalance, getVolumeDivergence };

  document.addEventListener('DOMContentLoaded', start);
})();
