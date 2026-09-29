// ============================================================
// kodak-collector.js — cross-venue books, derivatives, and contracts
// Usage: node kodak-collector.js [SYMBOL]   (default BTCUSDT)
// No API keys required. All public endpoints.
// ============================================================

const SYMBOL = (process.argv[2] || 'BTCUSDT').toUpperCase();
const COIN = SYMBOL.replace('USDT', '').replace('USD', '').toUpperCase();
const TIMEOUT = 9000;
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
if (!module.paths.includes('/mnt/g/WECRYP/node_modules')) {
  module.paths.push('/mnt/g/WECRYP/node_modules');
}
let WsClass = globalThis.WebSocket;
try {
  WsClass = require('ws');
} catch (_) {}
const SWEDEN_LOCAL_ADDRESS = process.env.KODAK_SWEDEN_BIND || '10.68.218.219';
const SWEDEN_ROUTE_HOSTS = /(^|\.)(binance|bybit)\./i;
const out = { symbol: SYMBOL, ts: new Date().toISOString(), books: {}, derivs: {}, spot: {}, contracts: {}, derived: {} };
const { fixStrike } = require('./fixStrikeOffset.js');

const num = (v) => (v == null || isNaN(Number(v))) ? null : Number(v);

async function routedFetch(url, opts = {}) {
  const parsedUrl = new URL(url);
  if (!SWEDEN_ROUTE_HOSTS.test(parsedUrl.hostname)) return fetch(url, opts);

  return await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: opts.method || 'GET',
      headers: { ...(opts.headers || {}) },
      localAddress: SWEDEN_LOCAL_ADDRESS,
      family: 4,
      servername: parsedUrl.hostname,
      timeout: TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(body.toString('utf8')),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout after ${TIMEOUT}ms`)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function jget(url, name, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await routedFetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'kodak-collector/2.0', ...(opts.headers || {}) }, ...opts });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { name, ok: true, data: await r.json() };
  } catch (e) {
    return { name, ok: false, error: String(e.message || e) };
  } finally { clearTimeout(t); }
}

async function jpost(url, body, name) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await routedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { name, ok: true, data: await r.json() };
  } catch (e) { return { name, ok: false, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

// ---------- ORDER BOOKS ----------
async function pullBooks() {
  const jobs = [
    jget(`https://api.binance.com/api/v3/depth?symbol=${SYMBOL}&limit=50`, 'binance_spot_book'),
    jget(`https://fapi.binance.com/fapi/v1/depth?symbol=${SYMBOL}&limit=50`, 'binance_fut_book'),
    jget(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${SYMBOL}&limit=50`, 'bybit_book'),
    jget(`https://www.okx.com/api/v5/market/books?instId=${COIN}-USDT-SWAP&sz=50`, 'okx_book'),
    jget(`https://contract.mexc.com/api/v1/contract/depth/${COIN}_USDT`, 'mexc_book'),
    jget('https://api.exchange.coinbase.com/products/BTC-USD/book?level=2', 'coinbase_book'),
    jget('https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=50', 'kraken_book'),
    jget(`https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${SYMBOL}&productType=USDT-FUTURES&limit=50`, 'bitget_book'),
    jget(`https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${COIN}_USDT&limit=50`, 'gate_book'),
  ];
  const res = await Promise.all(jobs);
  for (const r of res) {
    if (!r.ok) { out.books[r.name] = { ok: false, error: r.error }; continue; }
    const d = r.data;
    const summarize = (bids, asks) => {
      if (!bids?.length || !asks?.length) return { ok: false };
      const normalizeRows = (rows) => {
        if (!Array.isArray(rows)) return [];
        if (Array.isArray(rows[0])) return rows;
        return rows.map(row => [row?.p ?? row?.price, row?.s ?? row?.size ?? row?.qty]);
      };
      const bidRows = normalizeRows(bids), askRows = normalizeRows(asks);
      if (!bidRows.length || !askRows.length) return { ok: false };
      const bb = num(bidRows[0][0]), ba = num(askRows[0][0]);
      const lvl = (arr, n) => arr.slice(0, n).map(x => ({ p: num(x[0] ?? x.price ?? x.p), s: num(x[1] ?? x.size ?? x.qty ?? x.s) }));
      const findWalls = (arr) => {
        const l = lvl(arr, 25);
        if (!l.length) return [];
        const sizes = l.map(x => x.s).sort((a, b) => a - b);
        const med = sizes[Math.floor(sizes.length / 2)] || 1;
        return l.filter(x => x.s >= med * 3).slice(0, 5);
      };
      return { ok: true, best_bid: bb, best_ask: ba, mid: (bb + ba) / 2,
        bid_walls: findWalls(bidRows), ask_walls: findWalls(askRows),
        bid_depth_25: lvl(bidRows, 25).reduce((s, x) => s + x.s, 0),
        ask_depth_25: lvl(askRows, 25).reduce((s, x) => s + x.s, 0) };
    };
    switch (r.name) {
      case 'binance_spot_book': case 'binance_fut_book':
        out.books[r.name] = summarize(d.bids, d.asks); break;
      case 'bybit_book': { const b = d?.result; out.books[r.name] = b ? summarize(b.b, b.a) : { ok: false }; break; }
      case 'okx_book': { const b = d?.data?.[0]; out.books[r.name] = b ? summarize(b.bids, b.asks) : { ok: false }; break; }
      case 'mexc_book': { const b = d?.data; out.books[r.name] = b ? summarize(b.bids, b.asks) : { ok: false }; break; }
      case 'coinbase_book': {
        const bids = (d.bids || []).slice(0, 25).map(x => [x[0], x[1]]);
        const asks = (d.asks || []).slice(0, 25).map(x => [x[0], x[1]]);
        out.books[r.name] = summarize(bids, asks); break;
      }
      case 'kraken_book': { const k = d?.result?.[Object.keys(d.result)[0]]; out.books[r.name] = k ? summarize(k.bids, k.asks) : { ok: false }; break; }
      case 'bitget_book': { const b = d?.data; out.books[r.name] = b ? summarize(b.bids, b.asks) : { ok: false }; break; }
      case 'gate_book': { out.books[r.name] = summarize(d.bids, d.asks); break; }
    }
  }
}


// ---------- WALL TRACKING ----------
const WALLS_CACHE_FILE = require('path').join('/tmp', `kodak_walls_${SYMBOL}.json`);

function trackWalls(currentBooks, currentSpot) {
  let prevWalls = {};
  try {
    if (fs.existsSync(WALLS_CACHE_FILE)) {
      prevWalls = JSON.parse(fs.readFileSync(WALLS_CACHE_FILE, 'utf8'));
    }
  } catch(_) {}
  
  const now = Date.now();
  const nextWalls = {};
  let pulledWalls = [];
  
  for (const [venue, book] of Object.entries(currentBooks)) {
    if (!book || !book.ok) continue;
    
    // Group all current walls
    const currentVenueWalls = [...(book.bid_walls || []), ...(book.ask_walls || [])];
    
    nextWalls[venue] = currentVenueWalls.map(w => {
      // Find matching wall from previous (same price, roughly same size)
      const prev = (prevWalls[venue] || []).find(pw => Math.abs(pw.p - w.p) < (w.p * 0.0001));
      return {
        p: w.p,
        s: w.s,
        firstSeen: prev ? prev.firstSeen : now,
        lastSeen: now
      };
    });
    
    // Check for pulled walls
    const prevVenueWalls = prevWalls[venue] || [];
    for (const pw of prevVenueWalls) {
      // If a previous wall is no longer in current walls
      const stillExists = currentVenueWalls.some(w => Math.abs(w.p - pw.p) < (pw.p * 0.0001));
      if (!stillExists) {
        // Wall disappeared!
        // Was it pulled or executed? 
        // We consider it PULLED if the price hasn't crossed it (within a safe distance)
        // Or if it just disappeared right as price approached it.
        // Let's use a simple distance metric: if price is within 1% and it vanished without massive volume printed.
        // Actually, the instruction says: "flag WALL_PULL when a large bid level disappears within N seconds of price approaching."
        const distToSpot = Math.abs(pw.p - currentSpot) / currentSpot;
        if (distToSpot < 0.01) {
           const ageSec = (now - pw.firstSeen) / 1000;
           if (ageSec > 10) {
             pulledWalls.push({
               venue,
               price: pw.p,
               size: pw.s,
               dist_to_spot_pct: (distToSpot * 100).toFixed(2),
               flag: "WALL_PULL"
             });
           }
        }
      }
    }
  }
  
  try {
    fs.writeFileSync(WALLS_CACHE_FILE, JSON.stringify(nextWalls));
  } catch(_) {}
  
  return pulledWalls;
}

// ---------- DERIVATIVES ----------
async function pullDerivs() {
  const jobs = [
    jget(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${SYMBOL}`, 'binance_mark'),
    jget(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`, 'binance_oi'),
    jget(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${SYMBOL}&period=5m&limit=1`, 'binance_ls'),
    jget(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${SYMBOL}&period=5m&limit=1`, 'binance_taker'),
    jget(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=1m&limit=60`, 'binance_1m'),
    jget(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${SYMBOL}`, 'bybit_tick'),
    jget(`https://www.okx.com/api/v5/public/funding-rate?instId=${COIN}-USDT-SWAP`, 'okx_funding'),
    jget(`https://contract.mexc.com/api/v1/contract/funding_rate/${COIN}_USDT`, 'mexc_funding'),
    jget(`https://api.bitget.com/api/v2/mix/market/tickers?symbol=${SYMBOL}&productType=USDT-FUTURES`, 'bitget_tick'),
    jget(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${COIN}_USDT`, 'gate_tick'),
  ];
  const res = await Promise.all(jobs);
  for (const r of res) {
    if (!r.ok) { out.derivs[r.name] = { ok: false, error: r.error }; continue; }
    const d = r.data;
    switch (r.name) {
      case 'binance_mark':
        out.derivs[r.name] = { ok: true, mark: num(d.markPrice), index: num(d.indexPrice), funding_rate: num(d.lastFundingRate), next_funding_ms: num(d.nextFundingTime) }; break;
      case 'binance_oi': out.derivs[r.name] = { ok: true, oi_coins: num(d.openInterest) }; break;
      case 'binance_ls': out.derivs[r.name] = { ok: true, long_short_ratio: num(d?.[0]?.longShortRatio) }; break;
      case 'binance_taker': out.derivs[r.name] = { ok: true, taker_buy_sell: num(d?.[0]?.buySellRatio) }; break;
      case 'binance_1m': {
        const k = d.map(c => ({ o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]), v: num(c[5]) }));
        out.derivs[r.name] = { ok: true, last_close: k.at(-1).c, high_60m: Math.max(...k.map(x => x.h)), low_60m: Math.min(...k.map(x => x.l)) }; break;
      }
      case 'bybit_tick': { const t = d?.result?.list?.[0]; out.derivs[r.name] = t ? { ok: true, mark: num(t.markPrice), funding_rate: num(t.fundingRate), oi_coins: num(t.openInterest), oi_usd: num(t.openInterestValue) } : { ok: false }; break; }
      case 'okx_funding': { const f = d?.data?.[0]; out.derivs[r.name] = f ? { ok: true, funding_rate: num(f.fundingRate) } : { ok: false }; break; }
      case 'mexc_funding': out.derivs[r.name] = { ok: true, funding_rate: num(d?.data?.fundingRate) }; break;
      case 'bitget_tick': { const t = d?.data?.[0]; out.derivs[r.name] = t ? { ok: true, funding_rate: num(t.fundingRate), oi_coins: num(t.holdingAmount), mark: num(t.markPrice) } : { ok: false }; break; }
      case 'gate_tick': { const t = d?.[0]; out.derivs[r.name] = t ? { ok: true, funding_rate: num(t.funding_rate), oi_coins: num(t.total_size) * num(t.quanto_multiplier) } : { ok: false }; break; }
      case 'binance_liq_feed': {
        const liqs = (Array.isArray(d) ? d : []).slice(0, 20).map(x => ({
          side: x.side, price: num(x.price), qty: num(x.qty), time: x.time }));
        out.derivs[r.name] = { ok: true, recent_liquidations: liqs }; break;
      }
    }
  }
  const hl = await jpost('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' }, 'hyperliquid');
  if (hl.ok) {
    const idx = hl.data[0]?.universe?.findIndex(x => x.name === COIN);
    const ctx = idx >= 0 ? hl.data[1]?.[idx] : null;
    out.derivs.hyperliquid = ctx ? { ok: true, funding_rate: num(ctx.funding), oi_coins: num(ctx.openInterest), mark: num(ctx.markPx) } : { ok: false };
  } else out.derivs.hyperliquid = { ok: false, error: hl.error };
}

// ---------- SPOT ----------
async function pullSpot() {
  const jobs = [
    jget('https://api.exchange.coinbase.com/products/BTC-USD/ticker', 'coinbase'),
    jget(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${SYMBOL}`, 'binance'),
    jget('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', 'kraken'),
    jget('https://api.coinbase.com/v2/prices/BTC-USD/spot', 'coinbase_retail'),
    jget('https://api.coinpaprika.com/v1/tickers/btc-bitcoin', 'coinpaprika'),
  ];
  const res = await Promise.all(jobs);
  for (const r of res) {
    if (!r.ok) { out.spot[r.name] = { ok: false, error: r.error }; continue; }
    const d = r.data;
    switch (r.name) {
      case 'coinbase': out.spot[r.name] = { ok: true, bid: num(d.bid), ask: num(d.ask), last: num(d.price) }; break;
      case 'binance': out.spot[r.name] = { ok: true, bid: num(d.bidPrice), ask: num(d.askPrice) }; break;
      case 'kraken': { const k = d?.result?.[Object.keys(d.result)[0]]; out.spot[r.name] = k ? { ok: true, last: num(k.c[0]) } : { ok: false }; break; }
      case 'coinbase_retail': out.spot[r.name] = { ok: true, last: num(d?.data?.amount) }; break;
      case 'coinpaprika': out.spot[r.name] = { ok: true, last: num(d?.quotes?.USD?.price), chg_1h_pct: num(d?.quotes?.USD?.percent_change_1h) }; break;
    }
  }
}

// ---------- PREDICTION MARKET CONTRACTS ----------
async function pullContracts() {
  const kalshi = await jget('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC&status=open&limit=200', 'kalshi_kxbtc');
  if (!kalshi.ok) { out.contracts.kalshi_kxbtc = { ok: false, error: kalshi.error }; return; }
  const spot = out.spot.coinbase?.last ?? out.books.coinbase_book?.mid;
  if (!spot) { out.contracts.kalshi_kxbtc = { ok: false, error: 'no spot reference' }; return; }
  const markets = kalshi.data.markets || [];
  const now = Date.now();
  const byExpiry = {};
  for (const m of markets) {
    if (new Date(m.close_time).getTime() <= now) continue;
    if (!byExpiry[m.close_time]) byExpiry[m.close_time] = [];
    byExpiry[m.close_time].push(m);
  }
  const expiries = Object.keys(byExpiry).sort((a, b) => new Date(a) - new Date(b));
  if (!expiries.length) { out.contracts.kalshi_kxbtc = { ok: false, error: 'no future markets' }; return; }
  for (const expiry of expiries) {
    const nearSpot = byExpiry[expiry].filter(m =>
      m.floor_strike != null && Math.abs(m.floor_strike - spot) <= 1500
    );
    if (!nearSpot.length) continue;
    const sorted = nearSpot.sort((a, b) => a.floor_strike - b.floor_strike);
    out.contracts.kalshi_kxbtc = {
      ok: true,
      close_ts: expiry,
      ladder_ticker: sorted[0]?.event_ticker || sorted[0]?.ticker?.split('-').slice(0, 2).join('-'),
      markets: sorted.map(m => fixStrike({
        ticker: m.ticker,
        strike: m.floor_strike,
        yes_bid: m.yes_bid_dollars,
        yes_ask: m.yes_ask_dollars,
        close_ts: m.close_time
      }))
    };
    return;
  }
  out.contracts.kalshi_kxbtc = { ok: false, error: 'no expiry brackets spot ±1500' };
}

// ---------- DERIVED DECISION NUMBERS ----------
const LIQ_CACHE_FILE = path.join('/tmp', `kodak_recent_liquidations_${SYMBOL}.json`);
const LIQ_RETENTION_MS = 15 * 60 * 1000;

function loadCachedLiquidations() {
  try {
    if (fs.existsSync(LIQ_CACHE_FILE)) {
      const raw = fs.readFileSync(LIQ_CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const cutoff = Date.now() - LIQ_RETENTION_MS;
        return parsed.filter(e => Number(e.time || e.t) >= cutoff);
      }
    }
  } catch (_) {}
  return [];
}

function saveCachedLiquidations(events) {
  try {
    const cutoff = Date.now() - LIQ_RETENTION_MS;
    const filtered = events.filter(e => Number(e.time || e.t) >= cutoff);
    fs.writeFileSync(LIQ_CACHE_FILE, JSON.stringify(filtered));
  } catch (_) {}
}

async function pullOkxLiquidations() {
  try {
    const instFamily = `${COIN}-USDT`;
    const url = `https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instFamily=${instFamily}&mgnMode=cross&state=filled&limit=50`;
    const res = await routedFetch(url, { headers: { 'User-Agent': 'kodak-collector/2.0' } });
    if (!res.ok) return [];
    const d = await res.json();
    const events = [];
    for (const item of d?.data || []) {
      for (const dt of item.details || []) {
        const price = num(dt.bkPx);
        const sz = num(dt.sz);
        if (!price || !sz) continue;
        const qty = sz * 0.01;
        const side = dt.posSide === 'long' ? 'SELL' : 'BUY';
        const time = num(dt.ts || dt.time);
        events.push({
          side,
          price,
          qty,
          time,
          notional_usd: price * qty,
          venue: 'okx',
        });
      }
    }
    return events;
  } catch (_) {
    return [];
  }
}

async function pullLiquidations() {
  const cached = loadCachedLiquidations();
  const okxEvents = await pullOkxLiquidations();
  const wsEvents = [];
  let wsError = null;

  await new Promise((resolve) => {
    let ws;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      try { if (ws && ws.readyState === WsClass.OPEN) ws.close(); } catch (_) {}
      resolve();
    };

    try {
      const wsOptions = {};
      if (SWEDEN_LOCAL_ADDRESS) {
        wsOptions.agent = new https.Agent({ localAddress: SWEDEN_LOCAL_ADDRESS, family: 4 });
      }
      ws = new WsClass('wss://fstream.binance.com/ws/!forceOrder@arr', wsOptions);
    } catch (e) {
      wsError = String(e.message || e);
      return done();
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const o = msg?.o;
        if (!o || o.s !== SYMBOL) return;
        const p = num(o.p);
        const q = num(o.q);
        wsEvents.push({
          side: o.S === 'SELL' ? 'SELL' : 'BUY',
          price: p,
          qty: q,
          time: num(o.T),
          notional_usd: p && q ? p * q : undefined,
          venue: 'binance',
        });
      } catch (_) {}
    };

    ws.onerror = (err) => {
      wsError = String(err?.message || err || 'websocket_error');
    };
    ws.onclose = () => {};
    setTimeout(done, 5000);
  });

  const seen = new Set();
  const merged = [];
  for (const ev of [...cached, ...okxEvents, ...wsEvents]) {
    if (!ev || !ev.time || !ev.price) continue;
    const key = `${ev.side}_${ev.price}_${ev.qty?.toFixed?.(4) ?? ev.qty}_${Math.floor(ev.time / 1000)}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ev);
    }
  }

  merged.sort((a, b) => b.time - a.time);
  saveCachedLiquidations(merged);

  const newestTime = merged.length ? Math.max(...merged.map(e => e.time)) : null;
  const lastEventAge = newestTime ? Math.max(0, Math.round((Date.now() - newestTime) / 1000)) : null;

  
  let daemonAlive = false;
  try {
    const st = fs.statSync(LIQ_CACHE_FILE);
    // If cache file updated in last 60s, daemon is running/healthy
    if (Date.now() - st.mtimeMs < 60000) daemonAlive = true;
  } catch(_) {}
  
  const liq_feed_status = daemonAlive ? "HEALTHY" : "BLIND_DAEMON_DEAD";

  out.derivs.binance_liq_feed = {
    liq_feed_status,
    ok: true,
    recent_liquidations: merged,
    last_event_age_seconds: lastEventAge,
    cached_count: cached.length,
    new_okx_count: okxEvents.length,
    new_ws_count: wsEvents.length,
    ...(wsError ? { ws_warning: wsError } : {}),
  };
}

function computeDerived() {
  const b = out.books, s = out.spot, dv = out.derivs;
  const cbMid = b.coinbase_book?.mid ?? s.coinbase?.last;
  const mids = {};
  for (const [k, v] of Object.entries(b)) if (v?.mid != null) mids[k] = v.mid;
  if (cbMid != null) {
    out.derived.coinbase_mid = cbMid;
    out.derived.venue_mids = mids;
    out.derived.max_divergence_usd = Math.max(...Object.values(mids).map(m => Math.abs(m - cbMid)));
    out.derived.divergent_venues = Object.entries(mids)
      .filter(([k, m]) => Math.abs(m - cbMid) > 10).map(([k, m]) => ({ venue: k, mid: m, delta: +(m - cbMid).toFixed(2) }));
  }
  const funds = ['binance_mark', 'bybit_tick', 'okx_funding', 'mexc_funding', 'bitget_tick', 'gate_tick', 'hyperliquid']
    .map(k => dv[k]?.funding_rate).filter(v => v != null);
  if (funds.length) {
    out.derived.avg_funding = funds.reduce((a, c) => a + c, 0) / funds.length;
    out.derived.funding_spread = Math.max(...funds) - Math.min(...funds);
  }
  const ois = [dv.binance_oi?.oi_coins, dv.bybit_tick?.oi_coins, dv.hyperliquid?.oi_coins, dv.gate_tick?.oi_coins].filter(v => v != null);
  if (ois.length) out.derived.total_oi_coins = ois.reduce((a, c) => a + c, 0);
  const liqs = dv.binance_liq_feed?.recent_liquidations || [];
  if (liqs.length) {
    const sellLiqs = liqs.filter(l => l.side === 'SELL').length;
    out.derived.recent_liq_long_count = sellLiqs;
    out.derived.recent_liq_short_count = liqs.length - sellLiqs;
  }
}


// ---------- DAEMON MODE ----------
async function runDaemon() {
  console.log("Starting liquidation websocket daemon...");
  let ws;
  let isAlive = false;
  
  function connect() {
    console.log("Connecting to Binance WS...");
    try {
      const wsOptions = {};
      if (SWEDEN_LOCAL_ADDRESS) {
        wsOptions.agent = new (require('https')).Agent({ localAddress: SWEDEN_LOCAL_ADDRESS, family: 4 });
      }
      ws = new WsClass('wss://fstream.binance.com/ws/!forceOrder@arr', wsOptions);
    } catch (e) {
      console.error("WS Create Error:", e.message);
      setTimeout(connect, 5000);
      return;
    }
    
    ws.on('open', () => {
      console.log("WS Connected.");
      isAlive = true;
    });
    
    ws.on('ping', () => { ws.pong(); });
    ws.on('pong', () => { isAlive = true; });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        const o = msg?.o;
        if (!o || o.s !== SYMBOL) return;
        const p = num(o.p);
        const q = num(o.q);
        if (!p || !q) return;
        
        const ev = {
          side: o.S === 'SELL' ? 'SELL' : 'BUY',
          price: p,
          qty: q,
          time: num(o.T),
          notional_usd: p * q,
          venue: 'binance',
        };
        
        const cached = loadCachedLiquidations();
        cached.push(ev);
        // keep last 1000 or recent 15m
        saveCachedLiquidations(cached);
      } catch (e) {
        console.error("Message parse error:", e);
      }
    });
    
    ws.on('close', () => {
      console.log("WS Closed. Reconnecting in 2s...");
      setTimeout(connect, 2000);
    });
    
    ws.on('error', (err) => {
      console.error("WS Error:", err.message);
      ws.close();
    });
  }
  
  connect();
  
  setInterval(() => {
    if (ws && ws.readyState === WsClass.OPEN) {
      if (!isAlive) {
        console.log("WS Connection dead. Terminating to trigger reconnect.");
        ws.terminate();
      }
      isAlive = false;
      ws.ping();
    }
    // Heartbeat touch
    try { const now = new Date(); fs.utimesSync(LIQ_CACHE_FILE, now, now); } catch(e){}
  }, 30000);
}

if (process.argv.includes('--daemon')) {
  runDaemon();
} else {
  (async () => {
    await Promise.all([pullBooks(), pullDerivs(), pullSpot(), pullLiquidations()]);
    await pullContracts();
    computeDerived();
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  })().catch(e => { console.error('FATAL', e); process.exit(1); });
}

