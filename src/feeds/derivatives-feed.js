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
  const OI_HISTORY_MAX = 30;      // ~10 min of 20s samples
  const FUND_HISTORY_MAX = 12;
  const LIQ_WINDOW_MS = 5 * 60_000;  // rolling liquidation window (matches 5m/15m horizon)

  // Per-venue OI weighting for the aggregate funding/OI blend.
  const VENUE_WEIGHT = { binance: 0.5, bybit: 0.3, okx: 0.2 };

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
  async function getJson(url, opts = {}) {
    const res = await timedFetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
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
    try {
      const [oiRes, markRes] = await Promise.allSettled([
        getJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
        getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
      ]);
      if (oiRes.status === 'fulfilled' && markRes.status === 'fulfilled') {
        const oiContracts = parseFloat(oiRes.value.openInterest || 0);
        const mark = parseFloat(markRes.value.markPrice || 0);
        const index = parseFloat(markRes.value.indexPrice || 0);
        const funding = parseFloat(markRes.value.lastFundingRate || 0) * 100; // %
        const oiUsd = oiContracts * mark;
        const basisPct = index > 0 ? ((mark - index) / index) * 100 : null;
        if (oiUsd > 0) return { venue: 'binance', oiUsd, mark, funding, basisPct };
      }
    } catch (_) { /* fall through */ }

    // Binance dapi fallback (COIN-margined perpetuals) -- same account/geo
    // status as fapi in practice, but a distinct product/endpoint, so it
    // isn't blocked by exactly the same failure (rate limit, single-endpoint
    // outage) that took fapi down. Contracts here are priced in USD directly
    // (1 contract = $100 or $10 notional depending on symbol), not coin qty,
    // so premiumIndex's markPrice is only needed for the funding rate/basis,
    // not to convert OI to USD like the fapi branch above.
    try {
      const dapiSymbol = DAPI_PERP_SYM[sym];
      const [oiRes, markRes] = await Promise.allSettled([
        getJson(`https://dapi.binance.com/dapi/v1/openInterest?symbol=${dapiSymbol}`),
        getJson(`https://dapi.binance.com/dapi/v1/premiumIndex?symbol=${dapiSymbol}`),
      ]);
      if (oiRes.status === 'fulfilled') {
        const oiUsd = parseFloat(oiRes.value?.sumOpenInterestValue || 0);
        const mark = markRes.status === 'fulfilled' ? parseFloat(markRes.value?.markPrice || 0) : null;
        const index = markRes.status === 'fulfilled' ? parseFloat(markRes.value?.indexPrice || 0) : null;
        const funding = markRes.status === 'fulfilled' ? parseFloat(markRes.value?.lastFundingRate || 0) * 100 : null;
        const basisPct = mark && index > 0 ? ((mark - index) / index) * 100 : null;
        if (oiUsd > 0) return { venue: 'binance-coinm', oiUsd, mark, funding, basisPct };
      }
    } catch (_) { /* fall through */ }

    // OKX fallback (SWAP) — covers Binance geo/outage gaps.
    try {
      const instId = `${sym}-USDT-SWAP`;
      const [oiRes, fundRes] = await Promise.allSettled([
        getJson(`https://www.okx.com/api/v5/public/open-interest?instId=${instId}`),
        getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
      ]);
      let oiUsd = 0, funding = null;
      if (oiRes.status === 'fulfilled') oiUsd = parseFloat(oiRes.value?.data?.[0]?.oiCcy || 0);
      if (fundRes.status === 'fulfilled') funding = parseFloat(fundRes.value?.data?.[0]?.fundingRate || 0) * 100;
      if (oiUsd > 0) return { venue: 'okx', oiUsd, mark: null, funding, basisPct: null };
    } catch (_) { /* give up gracefully */ }

    return null;
  }

  // ── Secondary funding (Bybit) for the OI-weighted blend ───────────
  async function fetchBybitFunding(sym) {
    try {
      const j = await getJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${PERP_SYM[sym]}`);
      const row = j?.result?.list?.[0];
      if (!row) return null;
      return {
        venue: 'bybit',
        funding: parseFloat(row.fundingRate || 0) * 100,
        oiUsd: parseFloat(row.openInterestValue || 0),
      };
    } catch (_) { return null; }
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
    _liqWs.onopen = () => { _liqBackoffMs = 1000; console.info('[DerivativesFeed] Liquidation stream connected'); };
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
    _liqWs.onclose = () => { if (!_stopped) scheduleLiqReconnect(); };
    _liqWs.onerror = () => { try { _liqWs.close(); } catch (_) {} };
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
  function computeState(sym, oi, bybit) {
    const ts = Date.now();

    // OI delta over the rolling history (%/window)
    const hist = OI_HISTORY[sym] || (OI_HISTORY[sym] = []);
    if (oi?.oiUsd > 0) pushBounded(hist, { ts, oiUsd: oi.oiUsd }, OI_HISTORY_MAX);
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
    if (oi && Number.isFinite(oi.funding)) fundParts.push({ f: oi.funding, w: VENUE_WEIGHT[oi.venue] ?? 0.4, oi: oi.oiUsd });
    if (bybit && Number.isFinite(bybit.funding)) fundParts.push({ f: bybit.funding, w: VENUE_WEIGHT.bybit, oi: bybit.oiUsd });
    let aggFunding = null;
    if (fundParts.length) {
      const wsum = fundParts.reduce((a, p) => a + p.w, 0) || 1;
      aggFunding = fundParts.reduce((a, p) => a + p.f * p.w, 0) / wsum;
    }

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

    // Composite "deriv pressure" ∈ roughly [-1, +1]; positive = bullish positioning tilt.
    // Combines: liquidation imbalance (cascades), funding extreme (contrarian), OI build direction.
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
    pressure = clamp(pressure, -1, 1);

    let label = 'NEUTRAL';
    if (liq.totalUsd > 0 && Math.abs(liq.imbalance) > 0.6 && liq.totalUsd > 250_000) {
      label = liq.imbalance > 0 ? 'SHORT LIQ CASCADE (up)' : 'LONG LIQ CASCADE (down)';
    } else if (Number.isFinite(aggFunding) && Math.abs(aggFunding) > 0.04) {
      label = aggFunding > 0 ? 'CROWDED LONGS' : 'CROWDED SHORTS';
    } else if (oiTrend === 'building') {
      label = 'OI BUILDING';
    } else if (oiTrend === 'unwinding') {
      label = 'OI UNWINDING';
    }

    return {
      sym,
      ts,
      oiUsd: oi?.oiUsd ?? null,
      oiDeltaPct,
      oiTrend,
      funding: aggFunding,
      fundingVelocity,
      basisPct: oi?.basisPct ?? null,
      venues: [oi?.venue, bybit ? 'bybit' : null].filter(Boolean),
      liquidations: liq,
      pressure,
      label,
      available: !!(oi || bybit),
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
        open_interest_usd: state.oiUsd,
        oi_delta_pct: state.oiDeltaPct,
        oi_trend: state.oiTrend,
        funding_pct: state.funding,
        funding_velocity: state.fundingVelocity,
        basis_pct: state.basisPct,
        liq_long_usd: state.liquidations.longLiqUsd,
        liq_short_usd: state.liquidations.shortLiqUsd,
        liq_imbalance: state.liquidations.imbalance,
        deriv_pressure: state.pressure,
        label: state.label,
      },
      provenance: { module: 'derivatives-feed', venues: state.venues },
      schema_version: 'v1',
    };
    window.dispatchEvent(new CustomEvent('market-data-envelope', { detail: envelope }));
  }

  // ── poll cycle ────────────────────────────────────────────────────
  async function fetchAll() {
    const detail = {};
    for (const sym of COINS) {
      try {
        const [oi, bybit] = await Promise.all([fetchOpenInterest(sym), fetchBybitFunding(sym)]);
        const state = computeState(sym, oi, bybit);
        CACHE[sym] = state;
        detail[sym] = state;
        if (state.available) {
          emitEnvelope(state);
          try { window.DataLogger?.logDerivatives?.(sym, state.parsed || {
            oiUsd: state.oiUsd, oiDeltaPct: state.oiDeltaPct, funding: state.funding,
            fundingVelocity: state.fundingVelocity, basisPct: state.basisPct,
            liqImbalance: state.liquidations?.imbalance, liqTotalUsd: state.liquidations?.totalUsd,
            pressure: state.pressure, label: state.label, ts: state.ts,
          }); } catch (_) {}
        }
      } catch (e) {
        // keep prior cache; never let one coin break the cycle
      }
    }
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
    fetchAll,
    start() {
      if (_timer) return;
      _stopped = false;
      connectLiquidationStream();
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
})();
