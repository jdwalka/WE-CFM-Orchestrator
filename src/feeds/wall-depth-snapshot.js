// wall-depth-snapshot.js — full bid-wall + depth datapoints for Truffle queries.
//
// Collects every tracked bid/ask wall, top-20 book levels with cumulative
// depth, and the computed depth stats (imbalance 10/20, velocity, liquidity,
// wall concentration, dominant side) from window.OB, plus cross-venue RTI
// mids. Built on every Truffle query and appended as JSONL to
// logs/truffle-wall-stats.log (via data:appendLine IPC or Electron main).
(function () {
  'use strict';

  var TOP_N = 20;
  var SYMS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  var LOG_PATH = 'logs/truffle-wall-stats.log';

  function num(v, d) {
    var n = Number(v);
    return Number.isFinite(n) ? n : (d || 0);
  }

  function round2(v) {
    var n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  // Top-N levels with per-level notional + cumulative depth + distance from mid.
  function levelRows(levels, mid) {
    var cum = 0;
    return ((levels || []).slice(0, TOP_N)).map(function (lv) {
      var price = num(lv && lv[0]), qty = num(lv && lv[1]);
      var notional = price * qty;
      cum += notional;
      return {
        price: price,
        qty: qty,
        notional: round2(notional),
        cumDepth: round2(cum),
        distBps: mid > 0 ? round2(((price - mid) / mid) * 10000) : 0,
      };
    });
  }

  // Every live tracked wall on one side: price/qty/notional/age/distance.
  function liveWalls(sym, side, mid) {
    var map = window.OB && window.OB.wallTracker && window.OB.wallTracker[sym]
      ? window.OB.wallTracker[sym][side] : null;
    if (!map || typeof map.forEach !== 'function') return [];
    var out = [];
    var now = Date.now();
    map.forEach(function (info, key) {
      var price = num(key);
      var qty = num(info && (info.qty != null ? info.qty : info.lastQty));
      out.push({
        price: price,
        qty: qty,
        notional: round2(price * qty),
        ageMs: now - num(info && info.firstTs, now),
        distBps: mid > 0 ? round2(((price - mid) / mid) * 10000) : 0,
      });
    });
    out.sort(function (a, b) { return side === 'bids' ? b.price - a.price : a.price - b.price; });
    return out;
  }

  function sumNotional(rows) {
    return round2(rows.reduce(function (s, r) { return s + (r.notional || 0); }, 0));
  }

  function buildSym(sym) {
    sym = String(sym || '').toUpperCase();
    var ob = (window.OB && window.OB.books && window.OB.books[sym]) || null;
    var mid = num(ob && ob.mid);
    var bids = levelRows(ob && ob.bids, mid);
    var asks = levelRows(ob && ob.asks, mid);
    var bidWalls = liveWalls(sym, 'bids', mid);
    var askWalls = liveWalls(sym, 'asks', mid);
    var metrics = (window.OB && window.OB.balanceMetrics && window.OB.balanceMetrics[sym])
      || (ob && (ob.balance || ob.depthMetrics)) || null;
    var alerts = ((window.OB && window.OB.wallAlerts) || [])
      .filter(function (a) { return String(a && a.sym).toUpperCase() === sym; })
      .slice(0, 10);
    var events = ((window.OB && window.OB.wallEventLog && window.OB.wallEventLog[sym]) || []).slice(-10);
    var rti = (window._rtiPrices && window._rtiPrices[sym]) || null;
    var bidDepth = sumNotional(bids);
    var askDepth = sumNotional(asks);
    return {
      sym: sym,
      bookTs: (ob && ob.timestamp) || null,
      bookSource: (ob && ob.source) || null,
      mid: mid,
      spread: num(ob && ob.spread),
      spreadPct: num(ob && ob.spreadPct),
      // Full depth ladders (every data point, top 20 per side)
      bids: bids,
      asks: asks,
      bidDepthTop20: bidDepth,
      askDepthTop20: askDepth,
      totalDepthTop20: round2(bidDepth + askDepth),
      // Every tracked wall + its depth
      bidWalls: bidWalls,
      askWalls: askWalls,
      bidWallCount: bidWalls.length,
      askWallCount: askWalls.length,
      bidWallNotional: sumNotional(bidWalls),
      askWallNotional: sumNotional(askWalls),
      // Computed depth stats (imbalance/velocity/liquidity/concentration)
      depth: metrics || null,
      // Recent wall activity
      recentAlerts: alerts,
      recentEvents: events,
      // Cross-venue mids for reference
      rtiMids: (rti && rti.exchanges) || null,
      rtiStale: rti ? !!rti.stale : null,
    };
  }

  function build(focusSym) {
    var coins = {};
    if (focusSym) {
      var s = String(focusSym).toUpperCase();
      coins[s] = buildSym(s);
      return { ts: new Date().toISOString(), focus: s, coins: coins };
    }
    SYMS.forEach(function (s) {
      if (window.OB && window.OB.books && window.OB.books[s]) coins[s] = buildSym(s);
    });
    return { ts: new Date().toISOString(), focus: null, coins: coins };
  }

  function summarize(snap) {
    var lines = [];
    Object.keys((snap && snap.coins) || {}).forEach(function (s) {
      var c = snap.coins[s];
      var d = c.depth || {};
      var imb = d.imbalance ? d.imbalance.value : (d.weighted ? d.weighted.blendImbalance : null);
      lines.push(
        '[truffle:walls] ' + s +
        ' mid=' + c.mid +
        ' bidDepth20=' + c.bidDepthTop20 +
        ' askDepth20=' + c.askDepthTop20 +
        ' bidWalls=' + c.bidWallCount + '(' + c.bidWallNotional + ')' +
        ' askWalls=' + c.askWallCount + '(' + c.askWallNotional + ')' +
        ' dom=' + ((d.walls && d.walls.dominantWallSide) || 'none') +
        ' imb=' + (imb != null ? Number(imb).toFixed(3) : 'n/a') +
        ' liq=' + ((d.liquidity && d.liquidity.band) || 'n/a')
      );
    });
    return lines.length ? lines : ['[truffle:walls] no orderbook data (OB books empty)'];
  }

  // Append the full snapshot as one JSONL line. Fire-and-forget.
  function appendLog(snap, meta) {
    var entry = JSON.stringify(Object.assign(
      { ts: new Date().toISOString() },
      meta || {},
      { walls: snap }
    ));
    try {
      if (window.dataStore && typeof window.dataStore.appendLine === 'function') {
        return window.dataStore.appendLine(LOG_PATH, entry).catch(function () {});
      }
      if (window.electron && typeof window.electron.invoke === 'function') {
        return window.electron.invoke('data:appendLine', LOG_PATH, entry).catch(function () {});
      }
    } catch (_) { /* non-Electron (browser) — console only */ }
    return Promise.resolve(false);
  }

  window.WallDepthSnapshot = {
    TOP_N: TOP_N,
    SYMS: SYMS,
    LOG_PATH: LOG_PATH,
    build: build,
    buildSym: buildSym,
    summarize: summarize,
    appendLog: appendLog,
  };
})();
