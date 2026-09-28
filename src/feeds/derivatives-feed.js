// ================================================================
// derivatives-feed.js — Perp Derivatives Microstructure Monitor v1.0
// ----------------------------------------------------------------
// Adds the highest-signal short-horizon inputs the dataset was missing:
//   • Open interest + OI delta (rate of change, not just a level)
//   • Live liquidation stream (Binance !forceOrder WS) → cascade pressure
//   • OI-weighted cross-venue funding + funding velocity (d/dt)
//   • Perp-spot basis
// Replaces the single CoinGecko /derivatives snapshot (predictions.js:7010),
// which is rate-limited, 2-min stale, and picks one arbitrary venue.
//
// Convention mirrors cex-flow.js:
//   Exposes:  window.DerivativesFeed
//   Events:   derivatives-update (detail = { sym → state })
//             market-data-envelope (per-coin, for the Orbital Ingestor dataset)
//   Methods:  .get(sym) .getAll() .start() .stop()
// All endpoints are public / no-auth. Designed to never throw on boot.
// ================================================================

(function () {
  'use strict';

  // HYPE has no Binance/Bybit USDT-perp → excluded from perp metrics.
  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'];
  const PERP_SYM = Object.fromEntries(COINS.map(c => [c, `${c}USDT`]));

  const POLL_MS = 45000;          // OI/funding REST cadence (liquidations are real-time WS push)
  const TIMEOUT_MS = 9000;
  const FETCH_ATTEMPTS = 3;
  const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  // 401/403/451 are hard policy/geo blocks — retrying them every poll only
  // floods the console and the local proxy. Cool the host down instead.
  const BLOCKED_STATUS = new Set([401, 403, 451]);
  const HOST_BLOCK_MS = 5000;
  const BLOCKED_HOSTS = new Map();
  const RETRY_DELAY_MS = 250;
  const OI_HISTORY_MAX = 30;      // ~10 min of 20s samples
  const FUND_HISTORY_MAX = 12;
  const LIQ_WINDOW_MS = 5 * 60_000;  // rolling liquidation window (matches 5m/15m horizon)

  // Per-venue OI weighting for the aggregate funding/OI blend.
  const VENUE_WEIGHT = { binance: 0.35, bybit: 0.25, okx: 0.20, hyperliquid: 0.15, 'dydx-v4': 0.05 };

  const DIAGNOSTICS = {
    venues: {},
    latency_ms: {},
    rate_limits: {},
    data_quality: 'clean',
  };

  const DYDX_TICKER_MAP = {
    BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD',
    XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD',
  };

  const DERIBIT_INSTRUMENT_MAP = {
    BTC: 'BTC-PERPETUAL',
    ETH: 'ETH-PERPETUAL',
    SOL: 'SOL_USDC-PERPETUAL',
    XRP: 'XRP_USDC-PERPETUAL',
    DOGE: 'DOGE_USDC-PERPETUAL',
    BNB: 'BNB_USDC-PERPETUAL',
  };

  const HEALTHY_LATENCY_THRESHOLD_MS = 3500;

  function recordDiagnostics(url, res, latencyMs) {
    const host = urlHost(url) || 'unknown';
    const prev = DIAGNOSTICS.latency_ms[host];
    DIAGNOSTICS.latency_ms[host] = prev ? Math.round(prev * 0.5 + latencyMs * 0.5) : latencyMs;
    DIAGNOSTICS.venues[host] = { latencyMs, ts: Date.now() };
    const rl = {};
    const mbxWeight = res.headers?.get?.('x-mbx-used-weight-1m') || res.headers?.get?.('x-mbx-used-weight');
    if (mbxWeight) rl['x-mbx-used-weight'] = mbxWeight;
    const okxLimit = res.headers?.get?.('x-okx-limit-request-remaining') || res.headers?.get?.('x-okx-limit-remaining');
    if (okxLimit) rl['x-okx-limit-remaining'] = okxLimit;
    const bybitLimit = res.headers?.get?.('x-bapi-limit-status') || res.headers?.get?.('x-bapi-limit');
    if (bybitLimit) rl['x-bapi-limit-status'] = bybitLimit;
    if (Object.keys(rl).length) DIAGNOSTICS.rate_limits[host] = rl;
    // Latency on a secondary/fallback endpoint must never degrade data quality.
    // Data quality is evaluated post-poll based on whether required market metrics
    // (OI, funding, price) are populated for active coins.
  }

  const CACHE = {};               // sym → state
  const OI_HISTORY = {};          // sym → [{ ts, oiUsd }]
  const FUND_HISTORY = {};        // sym → [{ ts, funding }]
  const LIQ_BUFFER = {};          // sym → [{ ts, side, notional }]  (side: 'long'|'short' liquidated)

  let _timer = null;
  let _liqWs = null;
  let _liqReconnectTimer = null;
  let _liqBackoffMs = 1000;
  let _stopped = false;

  // ── helpers ──────────────────────────────────────────────────────
  function timedFetch(url, opts = {}) {
    return Promise.race([
      fetch(url, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function urlHost(url) {
    try { return new URL(url).hostname; } catch (_) { return null; }
  }
  function isHostBlocked(url) {
    const host = urlHost(url);
    const until = host ? BLOCKED_HOSTS.get(host) : 0;
    return Boolean(host && until > Date.now());
  }
  function markHostBlocked(url) {
    const host = urlHost(url);
    if (host) BLOCKED_HOSTS.set(host, Date.now() + HOST_BLOCK_MS);
  }

  function resolveFetchUrl(url) {
    const pPort = (typeof window !== 'undefined' && window.__PROXY_PORT__) || 3010;
    try {
      const u = new URL(url);
      if (u.hostname === 'fapi.binance.com') {
        return `http://127.0.0.1:${pPort}/binance-f${u.pathname}${u.search}`;
      }
      if (u.hostname === 'dapi.binance.com') {
        return `http://127.0.0.1:${pPort}/binance-d${u.pathname}${u.search}`;
      }
      if (u.hostname === 'api.binance.com') {
        return `http://127.0.0.1:${pPort}/binance${u.pathname}${u.search}`;
      }
      if (u.hostname === 'api.bybit.com') {
        return `http://127.0.0.1:${pPort}/bybit${u.pathname}${u.search}`;
      }
      if (u.hostname === 'www.deribit.com') {
        // Deribit geo-blocks US egress: route via local proxy generic forwarder
        // (Sweden path), same mechanism as the /proxy?url= fallback.
        return `http://127.0.0.1:${pPort}/proxy?url=${encodeURIComponent(url)}`;
      }
    } catch (_) {}
    return url;
  }

  async function getJson(url, opts = {}) {
    if (isHostBlocked(url)) throw new Error('host blocked (geo/policy cooldown)');
    const targetUrl = resolveFetchUrl(url);
    let lastError = null;
    const t0 = Date.now();
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      try {
        const res = await timedFetch(targetUrl, opts);
        const latencyMs = Date.now() - t0;
        recordDiagnostics(url, res, latencyMs);
        if (!res.ok) {
          if (BLOCKED_STATUS.has(res.status)) {
            markHostBlocked(url);
            throw new Error(`HTTP ${res.status} (blocked host cooldown)`);
          }
          const error = new Error(`HTTP ${res.status}`);
          if (!RETRYABLE_HTTP_STATUS.has(res.status) || attempt === FETCH_ATTEMPTS) throw error;
          lastError = error;
        } else {
          return await res.json();
        }
      } catch (e) {
        lastError = e;
        if (attempt === FETCH_ATTEMPTS) throw e;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
    throw lastError || new Error('fetch failed');
  }
  function pushBounded(arr, item, max) {
    arr.push(item);
    while (arr.length > max) arr.shift();
    return arr;
  }

  // ── Open interest (Binance fapi USDT-margined, dapi COIN-margined
  //    fallback, OKX last resort) ───────────────────────────────────
  const DAPI_PERP_SYM = Object.fromEntries(COINS.map(c => [c, `${c}USD_PERP`]));

  async function fetchOpenInterest(sym) {
    const symbol = PERP_SYM[sym];
    // Binance returns OI in *contracts* for /openInterest; multiply by mark for USD.
    // Strictly enforce lowercase /fapi/v1/...
    try {
      const [oiRes, markRes] = await Promise.allSettled([
        getJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
        getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
      ]);
      if (oiRes.status === 'fulfilled' && markRes.status === 'fulfilled') {
        const oiContracts = parseFloat(oiRes.value.openInterest || 0);
        const mark = parseFloat(markRes.value.markPrice || 0) || null;
        const index = parseFloat(markRes.value.indexPrice || 0) || null;
        const funding = parseFloat(markRes.value.lastFundingRate || 0) * 100; // %
        const oiUsd = oiContracts * (mark || 0);
        const basisPct = mark && index > 0 ? ((mark - index) / index) * 100 : null;
        if (oiUsd > 0) return { venue: 'binance', oiUsd, mark, funding, basisPct };
      }
    } catch (_) { /* fall through */ }

    // Binance dapi fallback (COIN-margined perpetuals)
    try {
      const dapiSymbol = DAPI_PERP_SYM[sym];
      const [oiRes, markRes] = await Promise.allSettled([
        getJson(`https://dapi.binance.com/dapi/v1/openInterest?symbol=${dapiSymbol}`),
        getJson(`https://dapi.binance.com/dapi/v1/premiumIndex?symbol=${dapiSymbol}`),
      ]);
      if (oiRes.status === 'fulfilled') {
        const oiUsd = parseFloat(oiRes.value?.sumOpenInterestValue || 0);
        const mark = markRes.status === 'fulfilled' ? (parseFloat(markRes.value?.markPrice || 0) || null) : null;
        const index = markRes.status === 'fulfilled' ? (parseFloat(markRes.value?.indexPrice || 0) || null) : null;
        const funding = markRes.status === 'fulfilled' ? (parseFloat(markRes.value?.lastFundingRate || 0) * 100) : null;
        const basisPct = mark && index > 0 ? ((mark - index) / index) * 100 : null;
        if (oiUsd > 0) return { venue: 'binance-coinm', oiUsd, mark, funding, basisPct };
      }
    } catch (_) { /* fall through */ }

    // OKX fallback (SWAP) — covers Binance geo/outage gaps.
    // Strictly use www.okx.com to avoid apex 301/308 redirects that strip headers or trip CORS
    try {
      const instId = `${sym}-USDT-SWAP`;
      const [oiRes, fundRes] = await Promise.allSettled([
        getJson(`https://www.okx.com/api/v5/public/open-interest?instId=${instId}`),
        getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
      ]);
      let oiUsd = 0, funding = null;
      if (oiRes.status === 'fulfilled') oiUsd = parseFloat(oiRes.value?.data?.[0]?.oiUsd || oiRes.value?.data?.[0]?.oiCcy || 0);
      if (fundRes.status === 'fulfilled') funding = parseFloat(fundRes.value?.data?.[0]?.fundingRate || 0) * 100;
      if (oiUsd > 0) return { venue: 'okx', oiUsd, mark: null, funding, basisPct: null };
    } catch (_) { /* give up gracefully */ }

    return null;
  }

  // ── OKX SWAP: Dedicated funding & OI probe (avoids apex 301/308 redirects)
  async function fetchOkxPerp(sym) {
    try {
      const instId = `${sym}-USDT-SWAP`;
      const [oiRes, fundRes] = await Promise.allSettled([
        getJson(`https://www.okx.com/api/v5/public/open-interest?instId=${instId}`),
        getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
      ]);
      let oiUsd = 0, funding = null;
      if (oiRes.status === 'fulfilled') oiUsd = parseFloat(oiRes.value?.data?.[0]?.oiUsd || oiRes.value?.data?.[0]?.oiCcy || 0);
      if (fundRes.status === 'fulfilled') funding = parseFloat(fundRes.value?.data?.[0]?.fundingRate || 0) * 100;
      return { venue: 'okx', oiUsd, funding };
    } catch (_) { return null; }
  }

  // ── Binance /fapi/v1/fundingInfo (Burst Pressure clamp interval detection)
  async function fetchBinanceFundingInfo(sym) {
    const symbol = PERP_SYM[sym];
    try {
      const res = await getJson(`https://fapi.binance.com/fapi/v1/fundingInfo?symbol=${symbol}`);
      const row = Array.isArray(res) ? res[0] : res;
      if (!row) return null;
      const intervalHours = parseInt(row.fundingIntervalHours || 8, 10);
      const cap = parseFloat(row.adjustedFundingRateCap || 0.0075);
      const floor = parseFloat(row.adjustedFundingRateFloor || -0.0075);
      let burstPressure = 0;
      if (intervalHours < 8) {
        burstPressure += (8 - intervalHours) / 4; // tightened clamp
      }
      if (cap > 0.0075) {
        burstPressure += (cap - 0.0075) * 100;
      }
      return { intervalHours, cap, floor, burstPressure };
    } catch (_) { return null; }
  }

  // ── Bybit: Funding lives in /v5/market/tickers (fundingRate, nextFundingTime)
  //    Do NOT attempt to parse funding from /v5/market/orderbook!
  async function fetchBybitFunding(sym) {
    try {
      const j = await getJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${PERP_SYM[sym]}`);
      const row = j?.result?.list?.[0];
      if (!row) return null;
      return {
        venue: 'bybit',
        funding: parseFloat(row.fundingRate || 0) * 100,
        nextFundingTime: row.nextFundingTime ? Number(row.nextFundingTime) : null,
        mark: parseFloat(row.markPrice || 0) || null,
        index: parseFloat(row.indexPrice || 0) || null,
        oiUsd: parseFloat(row.openInterestValue || 0),
        basisPct: Number(row.indexPrice) > 0
          ? ((parseFloat(row.markPrice || 0) - parseFloat(row.indexPrice)) / parseFloat(row.indexPrice)) * 100
          : null,
      };
    } catch (_) { return null; }
  }

  // ── Bybit: Orderbook polled alongside tickers (separated from funding)
  async function fetchBybitOrderbook(sym) {
    try {
      const j = await getJson(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${PERP_SYM[sym]}&limit=50`);
      return {
        bids: j?.result?.b || [],
        asks: j?.result?.a || [],
      };
    } catch (_) { return null; }
  }

  // ── dYdX v4 Indexer (Zero auth required for public market data)
  async function fetchDydxV4(sym) {
    const ticker = DYDX_TICKER_MAP[sym];
    if (!ticker) return null;
    try {
      const [bookRes, fundRes] = await Promise.allSettled([
        getJson(`https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/${ticker}`),
        getJson(`https://indexer.dydx.trade/v4/historicalFunding/${ticker}?limit=1`),
      ]);
      let funding = null, mark = null;
      if (fundRes.status === 'fulfilled' && fundRes.value?.historicalFunding?.[0]) {
        const hf = fundRes.value.historicalFunding[0];
        funding = parseFloat(hf.rate || 0) * 100;
        if (hf.price) mark = parseFloat(hf.price);
      }
      const bids = bookRes.status === 'fulfilled' ? (bookRes.value?.bids || []) : [];
      const asks = bookRes.status === 'fulfilled' ? (bookRes.value?.asks || []) : [];
      return {
        venue: 'dydx-v4',
        funding,
        mark,
        bids,
        asks,
      };
    } catch (_) { return null; }
  }

  // ── Deribit: Explicit depth param and accurate per-asset instrument naming.
  // Proxied first (Sweden egress beats the US geo-block); direct fallback
  // because public market-data usually answers from US egress anyway.
  async function fetchDeribitOrderbook(sym) {
    const instrument = DERIBIT_INSTRUMENT_MAP[sym] || `${sym}-PERPETUAL`;
    const parseBook = (j) => {
      const res = j?.result;
      if (!res) return null;
      return {
        venue: 'deribit',
        mark: parseFloat(res.mark_price || 0) || null,
        index: parseFloat(res.index_price || 0) || null,
        funding: parseFloat(res.current_funding || 0) * 100,
        bids: res.bids || [],
        asks: res.asks || [],
      };
    };
    const url = `https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${instrument}&depth=20`;
    try {
      const parsed = parseBook(await getJson(url));
      if (parsed) return parsed;
    } catch (_) { /* fall through to direct */ }
    try {
      const r = await timedFetch(url);
      if (!r.ok) return null;
      return parseBook(await r.json());
    } catch (_) { return null; }
  }

  // ── Hyperliquid: Single POST /info multiplexing metaAndAssetCtxs & predictedFundings
  //    Hyperliquid rejects GET with 405 Method Not Allowed!
  let _lastHlMap = {};
  let _lastHlTs = 0;

  async function fetchHyperliquidInfo() {
    try {
      const t0 = Date.now();
      const [metaRes, predRes] = await Promise.allSettled([
        timedFetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        }).then(r => { recordDiagnostics('https://api.hyperliquid.xyz/info', r, Date.now() - t0); return r.json(); }),
        timedFetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'predictedFundings' }),
        }).then(r => { recordDiagnostics('https://api.hyperliquid.xyz/info', r, Date.now() - t0); return r.json(); }),
      ]);

      const byCoin = {};
      if (metaRes.status === 'fulfilled' && Array.isArray(metaRes.value) && metaRes.value.length >= 2) {
        const universe = metaRes.value[0]?.universe || [];
        const ctxs = metaRes.value[1] || [];
        universe.forEach((asset, idx) => {
          const sym = asset.name;
          const ctx = ctxs[idx];
          if (ctx) {
            byCoin[sym] = {
              mark: parseFloat(ctx.markPx || 0),
              oiUsd: parseFloat(ctx.openInterest || 0) * parseFloat(ctx.markPx || 0),
              funding: parseFloat(ctx.funding || 0) * 100,
            };
          }
        });
      }

      if (predRes.status === 'fulfilled' && Array.isArray(predRes.value)) {
        for (const item of predRes.value) {
          const [coin, venueList] = item;
          if (!byCoin[coin]) byCoin[coin] = {};
          if (Array.isArray(venueList)) {
            const hlPred = venueList.find(v => v[0] === 'hl' || v[0] === 'hyperliquid') || venueList[0];
            if (hlPred && hlPred[1]?.fundingRate != null) {
              byCoin[coin].predictedFunding = parseFloat(hlPred[1].fundingRate) * 100;
            }
          }
        }
      }

      if (Object.keys(byCoin).length > 0) {
        _lastHlMap = byCoin;
        _lastHlTs = Date.now();
        return byCoin;
      }
      if (Date.now() - _lastHlTs < 180_000 && Object.keys(_lastHlMap).length > 0) {
        return _lastHlMap;
      }
      return {};
    } catch (_) {
      if (Date.now() - _lastHlTs < 180_000 && Object.keys(_lastHlMap).length > 0) {
        return _lastHlMap;
      }
      return {};
    }
  }

  // ── Liquidation WS (Binance combined !forceOrder@arr) ─────────────
  // SELL forced order  = a LONG was liquidated (forced market sell)
  // BUY  forced order  = a SHORT was liquidated (forced market buy)
  function connectLiquidationStream() {
    if (_stopped) return;
    try {
      _liqWs = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
    } catch (e) {
      scheduleLiqReconnect();
      return;
    }
    _liqWs.onopen = () => {
      _liqBackoffMs = 1000;
      DIAGNOSTICS.liq_ws_connected = true;
      console.info('[DerivativesFeed] Liquidation stream connected');
    };
    _liqWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const o = msg?.o;
        if (!o) return;
        const sym = String(o.s || '').replace(/USDT$/, '');
        if (!COINS.includes(sym)) return;
        const px = parseFloat(o.ap || o.p || 0);
        const qty = parseFloat(o.z || o.q || 0);
        const notional = px * qty;
        if (!Number.isFinite(notional) || notional <= 0) return;
        const side = o.S === 'SELL' ? 'long' : 'short'; // which side got liquidated
        if (!LIQ_BUFFER[sym]) LIQ_BUFFER[sym] = [];
        LIQ_BUFFER[sym].push({ ts: Date.now(), side, notional });
      } catch (_) { /* ignore malformed frame */ }
    };
    _liqWs.onclose = () => {
      DIAGNOSTICS.liq_ws_connected = false;
      if (!_stopped) scheduleLiqReconnect();
    };
    _liqWs.onerror = () => {
      DIAGNOSTICS.liq_ws_connected = false;
      try { _liqWs.close(); } catch (_) {}
    };
  }
  function scheduleLiqReconnect() {
    clearTimeout(_liqReconnectTimer);
    _liqBackoffMs = Math.min(_liqBackoffMs * 2, 60_000);
    _liqReconnectTimer = setTimeout(connectLiquidationStream, _liqBackoffMs);
  }

  function summarizeLiquidations(sym) {
    const buf = LIQ_BUFFER[sym] || [];
    const cutoff = Date.now() - LIQ_WINDOW_MS;
    // prune in place
    while (buf.length && buf[0].ts < cutoff) buf.shift();
    let longLiq = 0, shortLiq = 0, count = buf.length;
    for (const l of buf) {
      if (l.side === 'long') longLiq += l.notional; else shortLiq += l.notional;
    }
    const total = longLiq + shortLiq;
    // Imbalance ∈ [-1, +1]; +1 = pure short-liquidation (squeeze up), -1 = pure long-liquidation (cascade down)
    const imbalance = total > 0 ? (shortLiq - longLiq) / total : 0;
    return { longLiqUsd: longLiq, shortLiqUsd: shortLiq, totalUsd: total, count, imbalance };
  }

  // ── per-coin compute ──────────────────────────────────────────────
  function computeState(sym, oi, bybit, dydx, deribit, hlData, binanceFundingInfo, okx) {
    const ts = Date.now();

    // OI delta over the rolling history (%/window)
    const hist = OI_HISTORY[sym] || (OI_HISTORY[sym] = []);
    const primaryOi = oi?.oiUsd || hlData?.oiUsd || bybit?.oiUsd || okx?.oiUsd || 0;
    if (primaryOi > 0) pushBounded(hist, { ts, oiUsd: primaryOi }, OI_HISTORY_MAX);
    let oiDeltaPct = null, oiTrend = 'flat';
    if (hist.length >= 2) {
      const first = hist[0].oiUsd, last = hist[hist.length - 1].oiUsd;
      if (first > 0) {
        oiDeltaPct = ((last - first) / first) * 100;
        oiTrend = oiDeltaPct > 0.75 ? 'building' : oiDeltaPct < -0.75 ? 'unwinding' : 'flat';
      }
    }

    // OI-weighted aggregate funding across available venues
    const fundParts = [];
    if (oi && Number.isFinite(oi.funding)) fundParts.push({ f: oi.funding, w: VENUE_WEIGHT[oi.venue] ?? 0.35, oi: oi.oiUsd });
    if (bybit && Number.isFinite(bybit.funding)) fundParts.push({ f: bybit.funding, w: VENUE_WEIGHT.bybit, oi: bybit.oiUsd });
    if (okx && Number.isFinite(okx.funding)) fundParts.push({ f: okx.funding, w: VENUE_WEIGHT.okx, oi: okx.oiUsd });
    if (hlData && Number.isFinite(hlData.funding)) fundParts.push({ f: hlData.funding, w: VENUE_WEIGHT.hyperliquid, oi: hlData.oiUsd });
    if (dydx && Number.isFinite(dydx.funding)) fundParts.push({ f: dydx.funding, w: VENUE_WEIGHT['dydx-v4'], oi: 0 });
    if (deribit && Number.isFinite(deribit.funding)) fundParts.push({ f: deribit.funding, w: 0.1, oi: 0 });

    let aggFunding = null;
    if (fundParts.length) {
      const wsum = fundParts.reduce((a, p) => a + p.w, 0) || 1;
      aggFunding = fundParts.reduce((a, p) => a + p.f * p.w, 0) / wsum;
    }

    // Hyperliquid predictedFundings -> cascade_skew input
    // Instantaneous real-time consensus for the NEXT funding epoch cross-referenced against live rates
    let cascadeSkew = 0;
    if (hlData && Number.isFinite(hlData.predictedFunding) && Number.isFinite(aggFunding)) {
      cascadeSkew = (hlData.predictedFunding - aggFunding) * 10;
    }

    // Binance fundingInfo -> burst_pressure
    const burstPressure = binanceFundingInfo?.burstPressure || 0;

    // Funding velocity (rate of change of funding)
    const fh = FUND_HISTORY[sym] || (FUND_HISTORY[sym] = []);
    if (Number.isFinite(aggFunding)) pushBounded(fh, { ts, funding: aggFunding }, FUND_HISTORY_MAX);
    let fundingVelocity = null;
    if (fh.length >= 2) {
      const a = fh[0], b = fh[fh.length - 1];
      const dtMin = Math.max(1, (b.ts - a.ts) / 60000);
      fundingVelocity = (b.funding - a.funding) / dtMin; // %-points per minute
    }

    const liq = summarizeLiquidations(sym);
    const basisPct = oi?.basisPct ?? bybit?.basisPct ?? null;
    const basisSource = oi?.basisPct != null ? oi.venue : (bybit?.basisPct != null ? 'bybit' : null);
    const basisDirection = Number.isFinite(basisPct)
      ? (basisPct > 0 ? 'perp_above_spot' : basisPct < 0 ? 'perp_below_spot' : 'flat')
      : null;
    const futuresSpotDivergence = Number.isFinite(basisPct) ? {
      basis_pct: basisPct,
      direction: basisDirection,
      strength: Math.abs(basisPct),
      source: basisSource,
    } : null;

    // Composite "deriv pressure" ∈ roughly [-1, +1]; positive = bullish positioning tilt.
    // Combines: liquidation imbalance (cascades), funding extreme (contrarian), OI build direction,
    // burst pressure, and cascade skew.
    let pressure = 0;
    pressure += 0.5 * liq.imbalance; // short liqs push up
    if (Number.isFinite(aggFunding)) {
      // Crowded longs (high +funding) → contrarian-down; crowded shorts (neg) → contrarian-up.
      pressure += clamp(-aggFunding / 0.06, -0.3, 0.3);
    }
    if (oiDeltaPct != null) {
      // OI building alongside short-liq imbalance reinforces; alongside long-liq it deepens the cascade.
      pressure += clamp((oiDeltaPct / 5) * Math.sign(liq.imbalance || 0), -0.2, 0.2);
    }
    // Blend burst pressure and cascade skew into pressure
    pressure += clamp(cascadeSkew * 0.1, -0.2, 0.2);
    pressure = clamp(pressure, -1, 1);

    let label = 'NEUTRAL';
    if (liq.totalUsd > 0 && Math.abs(liq.imbalance) > 0.6 && liq.totalUsd > 250_000) {
      label = liq.imbalance > 0 ? 'SHORT LIQ CASCADE (up)' : 'LONG LIQ CASCADE (down)';
    } else if (Number.isFinite(aggFunding) && Math.abs(aggFunding) > 0.04) {
      label = aggFunding > 0 ? 'CROWDED LONGS' : 'CROWDED SHORTS';
    } else if (Math.abs(cascadeSkew) > 0.5) {
      label = cascadeSkew > 0 ? 'CASCADE SKEW LONG' : 'CASCADE SKEW SHORT';
    } else if (oiTrend === 'building') {
      label = 'OI BUILDING';
    } else if (oiTrend === 'unwinding') {
      label = 'OI UNWINDING';
    }

    const venues = [
      (oi?.venue === 'binance' || oi?.venue === 'binance-coinm') ? oi.venue : (binanceFundingInfo ? 'binance' : oi?.venue),
      bybit ? 'bybit' : null,
      okx ? 'okx' : null,
      dydx ? 'dydx-v4' : null,
      deribit ? 'deribit' : null,
      hlData ? 'hyperliquid' : null,
    ].filter(Boolean);

    const primaryMark = [oi?.mark, hlData?.mark, bybit?.mark, deribit?.mark, dydx?.mark, CACHE[sym]?.mark]
      .find(p => p != null && Number.isFinite(p) && p > 0) || null;

    return {
      sym,
      ts,
      mark: primaryMark,
      price: primaryMark,
      oiUsd: primaryOi || null,
      oiDeltaPct,
      oiTrend,
      funding: aggFunding,
      fundingVelocity,
      predictedFunding: hlData?.predictedFunding ?? null,
      cascade_skew: cascadeSkew,
      burst_pressure: burstPressure,
      basisPct,
      futures_spot_divergence: futuresSpotDivergence,
      venues,
      liquidations: liq,
      pressure,
      label,
      available: venues.length > 0,
      diagnostics: { ...DIAGNOSTICS },
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── envelope (feeds the Orbital Ingestor dataset, like cex-flow) ──
  function emitEnvelope(state) {
    const ts = state.ts;
    const envelope = {
      envelope_id: `deriv:${state.sym}:${ts}:${Math.floor(Math.random() * 1e6)}`,
      source: 'derivatives-feed',
      received_ts: new Date(ts).toISOString(),
      chain_ts: null,
      type: 'derivatives_snapshot',
      raw: null,
      parsed: {
        symbol: state.sym,
        price: state.mark,
        mark_price: state.mark,
        open_interest_usd: state.oiUsd,
        oi_delta_pct: state.oiDeltaPct,
        oi_trend: state.oiTrend,
        funding_pct: state.funding,
        funding_velocity: state.fundingVelocity,
        predicted_funding: state.predictedFunding,
        cascade_skew: state.cascade_skew,
        burst_pressure: state.burst_pressure,
        basis_pct: state.basisPct,
        futures_spot_divergence: state.futures_spot_divergence,
        liq_long_usd: state.liquidations.longLiqUsd,
        liq_short_usd: state.liquidations.shortLiqUsd,
        liq_imbalance: state.liquidations.imbalance,
        deriv_pressure: state.pressure,
        label: state.label,
        data_quality: state.diagnostics?.data_quality || 'clean',
        diagnostics: state.diagnostics,
      },
      provenance: { module: 'derivatives-feed', venues: state.venues },
      schema_version: 'v1',
    };
    window.dispatchEvent(new CustomEvent('market-data-envelope', { detail: envelope }));
  }

  function reportVenueHealth(venue, healthy, latencyMs, reason, extra = {}) {
    if (typeof window === 'undefined' || !window.NetworkHealth?.update) return;
    const isDegraded = !healthy || (latencyMs > HEALTHY_LATENCY_THRESHOLD_MS);
    const status = healthy
      ? (isDegraded ? 'degraded' : 'healthy')
      : (extra.transient ? 'recovering' : 'degraded');
    window.NetworkHealth.update(venue, {
      status,
      lastFetch: Date.now(),
      fallback: extra.fallback || false,
      optional: extra.optional || false,
      transient: extra.transient || false,
      reason: reason || (healthy ? `${latencyMs ? Math.round(latencyMs) + 'ms' : 'ok'}` : 'fetch error'),
      bucket: healthy ? 'unknown' : (extra.bucket || 'provider/api'),
      bucketReason: extra.bucketReason || '',
    });
  }

  // ── poll cycle ────────────────────────────────────────────────────
  async function fetchAll() {
    DIAGNOSTICS.data_quality = 'clean';
    const detail = {};
    const hlMap = await fetchHyperliquidInfo().catch(() => ({}));
    for (const sym of COINS) {
      try {
        const results = await Promise.allSettled([
          fetchOpenInterest(sym),
          fetchBybitFunding(sym),
          fetchDydxV4(sym),
          fetchDeribitOrderbook(sym),
          fetchBinanceFundingInfo(sym),
          fetchOkxPerp(sym),
        ]);
        const [oi, bybit, dydx, deribit, bInfo, okx] = results.map(r => r.status === 'fulfilled' ? r.value : null);
        const state = computeState(sym, oi, bybit, dydx, deribit, hlMap[sym] || null, bInfo, okx);
        CACHE[sym] = state;
        detail[sym] = state;
      } catch (e) {
        // preserve prior cache; never let one slow/failing call drop a coin
        if (CACHE[sym]) {
          detail[sym] = CACHE[sym];
        }
      }
    }

    // Determine data quality:
    // Data quality should be 'clean' as long as required market metrics (OI, funding, price)
    // are successfully obtained for the active coins. Only set 'partial' if required metrics
    // are genuinely missing across all venues.
    const coinEntries = Object.entries(detail);
    const activeCoins = coinEntries.map(([_, s]) => s).filter(s => s && s.available);
    const activeCount = activeCoins.length;

    const coinsWithRequiredMetrics = activeCoins.filter(s =>
      s.oiUsd > 0 &&
      Number.isFinite(s.funding) &&
      ((s.mark != null && s.mark > 0) || (s.price != null && s.price > 0))
    );

    if (activeCount > 0 && coinsWithRequiredMetrics.length === activeCount) {
      DIAGNOSTICS.data_quality = 'clean';
    } else if (coinsWithRequiredMetrics.length > 0) {
      DIAGNOSTICS.data_quality = 'partial';
    } else {
      DIAGNOSTICS.data_quality = activeCount > 0 ? 'partial' : 'degraded';
    }

    // Update diagnostics in state and emit envelopes / loggers
    for (const [sym, state] of Object.entries(detail)) {
      state.diagnostics = { ...DIAGNOSTICS };
      if (state.available) {
        emitEnvelope(state);
        try { window.DataLogger?.logDerivatives?.(sym, state.parsed || {
          symbol: state.sym,
          price: state.mark,
          oiUsd: state.oiUsd, oiDeltaPct: state.oiDeltaPct, funding: state.funding,
          fundingVelocity: state.fundingVelocity, basisPct: state.basisPct,
          cascadeSkew: state.cascade_skew, burstPressure: state.burst_pressure,
          futuresSpotDivergence: state.futures_spot_divergence,
          liqImbalance: state.liquidations?.imbalance, liqTotalUsd: state.liquidations?.totalUsd,
          pressure: state.pressure, label: state.label, ts: state.ts,
          dataQuality: state.diagnostics?.data_quality,
        }); } catch (_) {}
      }
    }

    // ── Report real-time health for all 7 venues ────────────────────
    try {
      const lat = DIAGNOSTICS.latency_ms;
      const hlCount = Object.keys(hlMap || {}).length;
      if (hlCount > 0) {
        reportVenueHealth('Hyperliquid', true, lat['api.hyperliquid.xyz'] || 0, `${hlCount} perps live (POST /info)`);
      } else {
        reportVenueHealth('Hyperliquid', false, lat['api.hyperliquid.xyz'] || 0, 'POST /info failed', { transient: true });
      }

      const hasBinance = Object.values(detail).some(s => s.venues?.includes('binance') || s.venues?.includes('binance-coinm'));
      const binanceLat = lat['fapi.binance.com'] || lat['dapi.binance.com'] || 0;
      reportVenueHealth('Binance', hasBinance, binanceLat, hasBinance ? 'fapi/dapi OI + funding live' : 'Geo-restricted (US egress · proxy/VPN optional)', { transient: !hasBinance, optional: true });

      const hasBybit = Object.values(detail).some(s => s.venues?.includes('bybit'));
      const bybitLat = lat['api.bybit.com'] || 0;
      reportVenueHealth('Bybit', hasBybit, bybitLat, hasBybit ? 'v5 linear tickers + book live' : 'Geo-restricted (US egress · proxy/VPN optional)', { transient: !hasBybit, optional: true });

      const hasOkx = Object.values(detail).some(s => s.venues?.includes('okx'));
      const okxLat = lat['www.okx.com'] || 0;
      reportVenueHealth('OKX', hasOkx, okxLat, hasOkx ? 'v5 swap OI + funding live' : 'OKX feeds offline', { transient: !hasOkx });

      const hasDydx = Object.values(detail).some(s => s.venues?.includes('dydx-v4'));
      const dydxLat = lat['indexer.dydx.trade'] || 0;
      reportVenueHealth('dYdX', hasDydx, dydxLat, hasDydx ? 'v4 indexer book + funding live' : 'dYdX indexer offline', { transient: !hasDydx });

      const hasDeribit = Object.values(detail).some(s => s.venues?.includes('deribit'));
      const deribitLat = lat['www.deribit.com'] || 0;
      reportVenueHealth('Deribit', hasDeribit, deribitLat, hasDeribit ? 'v2 depth=20 book live' : 'Deribit orderbook offline', { transient: !hasDeribit });

      const activeCoins = Object.values(detail).filter(s => s.available);
      reportVenueHealth('DerivativesFeed', activeCoins.length > 0, 0, `${activeCoins.length}/${COINS.length} coins · quality: ${DIAGNOSTICS.data_quality}`);
    } catch (_) {}

    window.dispatchEvent(new CustomEvent('derivatives-update', { detail }));
    return detail;
  }

  // ── public API ────────────────────────────────────────────────────
  const DerivativesFeed = {
    POLL_MS,
    get(sym) { return CACHE[sym] || null; },
    getAll() { return { ...CACHE }; },
    // Convenience: liquidation pressure for the squeeze detector to consume.
    getLiquidationPressure(sym) { return CACHE[sym]?.liquidations || null; },
    getDiagnostics() { return { ...DIAGNOSTICS }; },
    fetchAll,
    start() {
      if (_timer) return;
      _stopped = false;
      connectLiquidationStream();
      // Announce all 7 venues immediately so NetworkHealth immediately registers them
      const VENUES = ['Binance', 'Bybit', 'OKX', 'Hyperliquid', 'dYdX', 'Deribit', 'DerivativesFeed'];
      for (const v of VENUES) {
        if (typeof window !== 'undefined' && window.NetworkHealth?.update) {
          window.NetworkHealth.update(v, {
            status: 'recovering',
            lastFetch: Date.now(),
            fallback: false,
            transient: true,
            reason: 'Connecting derivatives stream...',
            bucket: 'unknown',
            bucketReason: '',
          });
        }
      }
      fetchAll();
      _timer = setInterval(() => { if (!document.hidden) fetchAll(); }, POLL_MS);
    },
    stop() {
      _stopped = true;
      clearInterval(_timer); _timer = null;
      clearTimeout(_liqReconnectTimer);
      try { _liqWs && _liqWs.close(); } catch (_) {}
      _liqWs = null;
    },
  };

  window.DerivativesFeed = DerivativesFeed;

  // Auto-start fallback in browser/electron environments
  if (typeof document !== 'undefined') {
    const autoBoot = () => {
      setTimeout(() => {
        if (!_timer && !_stopped && typeof DerivativesFeed.start === 'function') {
          DerivativesFeed.start();
        }
      }, 3000);
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      autoBoot();
    } else {
      document.addEventListener('DOMContentLoaded', autoBoot);
    }
  }
})();
