// ================================================================
// options-gamma-feed.js — Deribit Options / Gamma Monitor v1.0
// ----------------------------------------------------------------
// BTC & ETH only (Deribit is the deep options venue; SOL/XRP options are thin).
// Adds option-implied structure the dataset never had:
//   • DVOL (Deribit implied-vol index) + ATM IV (front expiry)
//   • 25-delta risk reversal = call_iv(25Δ) − put_iv(25Δ)  → directional skew
//   • Gamma concentration: OI-weighted Black-Scholes gamma per strike
//     → "pin strike" (the magnet spot drifts toward into expiry)
//   • Max-pain strike
// Why it matters here: Kalshi/Polymarket hourly *strike* markets resolve on
// whether spot is above/below a round number — exactly where dealer gamma pins.
//
// Convention mirrors cex-flow.js / derivatives-feed.js:
//   Exposes:  window.OptionsGammaFeed
//   Events:   options-gamma-update, market-data-envelope
//   Methods:  .get(sym) .getAll() .start() .stop()
// Public Deribit API, no auth. One bulk call per currency. Never throws on boot.
// ================================================================

(function () {
  'use strict';

  const COINS = ['BTC', 'ETH'];
  const POLL_MS = 90_000;     // options structure moves slowly; be gentle on Deribit
  const TIMEOUT_MS = 12_000;
  const DERIBIT = 'https://www.deribit.com/api/v2';

  const CACHE = {};
  let _timer = null;

  function timedFetch(url) {
    return Promise.race([
      fetch(url, { headers: { Accept: 'application/json' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
  }
  async function getJson(url) {
    const res = await timedFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'deribit error');
    return j.result;
  }

  // ── math: standard normal pdf/cdf + Black-Scholes greeks ──────────
  function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
  function normCdf(x) {
    // Abramowitz-Stegun 7.1.26
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x >= 0 ? 1 - p : p;
  }
  function bsGreeks(S, K, T, iv) {
    if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return { gamma: 0, deltaCall: 0 };
    const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
    const gamma = normPdf(d1) / (S * iv * Math.sqrt(T));
    const deltaCall = normCdf(d1);
    return { gamma, deltaCall };
  }

  // ── parse Deribit instrument_name: e.g. "BTC-27JUN25-60000-C" ─────
  const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  function parseInstrument(name) {
    const m = String(name).match(/^[A-Z]+-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/);
    if (!m) return null;
    const day = parseInt(m[1], 10), mon = MONTHS[m[2]], yr = 2000 + parseInt(m[3], 10);
    const strike = parseFloat(m[4]);
    const type = m[5] === 'C' ? 'call' : 'put';
    const expiryMs = Date.UTC(yr, mon, day, 8, 0, 0); // Deribit settles 08:00 UTC
    return { strike, type, expiryMs };
  }

  async function fetchDvol(sym) {
    try {
      const end = Date.now();
      const start = end - 2 * 60 * 60 * 1000;
      const r = await getJson(
        `${DERIBIT}/public/get_volatility_index_data?currency=${sym}&start_timestamp=${start}&end_timestamp=${end}&resolution=3600`
      );
      const data = Array.isArray(r?.data) ? r.data : [];
      const last = data[data.length - 1];
      return last ? Number(last[4]) : null; // [ts,open,high,low,close]
    } catch (_) { return null; }
  }

  async function fetchCoin(sym) {
    const rows = await getJson(`${DERIBIT}/public/get_book_summary_by_currency?currency=${sym}&kind=option`);
    if (!Array.isArray(rows) || !rows.length) throw new Error('no option rows');

    const spot = Number(rows[0].underlying_price) || Number(rows[0].estimated_delivery_price) || 0;
    const now = Date.now();

    // Group by expiry, keep only future expiries with usable data.
    const byExpiry = new Map();
    for (const r of rows) {
      const meta = parseInstrument(r.instrument_name);
      if (!meta || meta.expiryMs <= now) continue;
      const iv = Number(r.mark_iv) / 100; // Deribit mark_iv is in % vol
      const oi = Number(r.open_interest) || 0;
      const underlying = Number(r.underlying_price) || spot;
      if (!(iv > 0) || oi <= 0 || !(underlying > 0)) continue;
      if (!byExpiry.has(meta.expiryMs)) byExpiry.set(meta.expiryMs, []);
      byExpiry.get(meta.expiryMs).push({ ...meta, iv, oi, underlying });
    }
    if (!byExpiry.size) throw new Error('no usable expiries');

    // Front expiry = nearest future expiry (drives short-horizon pinning).
    const frontExpiry = Math.min(...byExpiry.keys());
    const front = byExpiry.get(frontExpiry);
    const S = front[0].underlying || spot;
    const T = Math.max((frontExpiry - now) / (365 * 24 * 60 * 60 * 1000), 1 / (365 * 24)); // yrs, floor 1h

    // Gamma concentration per strike (OI-weighted, both call & put share gamma).
    const gammaByStrike = new Map();
    let atmIv = null, atmDist = Infinity;
    let rr25 = null, callIv25 = null, putIv25 = null, callD = Infinity, putD = Infinity;
    for (const o of front) {
      const { gamma, deltaCall } = bsGreeks(S, o.strike, T, o.iv);
      const gExp = gamma * o.oi * S; // $-ish gamma exposure
      gammaByStrike.set(o.strike, (gammaByStrike.get(o.strike) || 0) + gExp);

      const dist = Math.abs(o.strike - S);
      if (o.type === 'call' && dist < atmDist) { atmDist = dist; atmIv = o.iv; }

      // 25-delta risk reversal
      if (o.type === 'call') {
        const e = Math.abs(deltaCall - 0.25);
        if (e < callD) { callD = e; callIv25 = o.iv; }
      } else {
        const deltaPut = deltaCall - 1;
        const e = Math.abs(deltaPut + 0.25);
        if (e < putD) { putD = e; putIv25 = o.iv; }
      }
    }
    if (callIv25 != null && putIv25 != null) rr25 = (callIv25 - putIv25) * 100; // vol points

    // Pin strike = strike with max gamma exposure (the magnet).
    let pinStrike = null, pinGamma = -1;
    for (const [k, g] of gammaByStrike) { if (g > pinGamma) { pinGamma = g; pinStrike = k; } }

    // Max-pain across this expiry's full strike set (calls+puts OI).
    const oiByStrike = new Map();
    for (const o of front) {
      const cur = oiByStrike.get(o.strike) || { call: 0, put: 0 };
      cur[o.type] += o.oi;
      oiByStrike.set(o.strike, cur);
    }
    const strikes = [...oiByStrike.keys()].sort((a, b) => a - b);
    let maxPain = null, minPay = Infinity;
    for (const settle of strikes) {
      let pay = 0;
      for (const [k, oi] of oiByStrike) {
        if (settle > k) pay += (settle - k) * oi.call;
        if (settle < k) pay += (k - settle) * oi.put;
      }
      if (pay < minPay) { minPay = pay; maxPain = settle; }
    }

    const dvol = await fetchDvol(sym);

    const pinDistPct = (pinStrike && S > 0) ? ((pinStrike - S) / S) * 100 : null;
    const maxPainDistPct = (maxPain && S > 0) ? ((maxPain - S) / S) * 100 : null;

    // Skew bias label: positive RR = calls bid (bullish skew); negative = puts bid (bearish).
    let skewLabel = 'NEUTRAL';
    if (rr25 != null) {
      if (rr25 > 1.5) skewLabel = 'CALL SKEW (bullish)';
      else if (rr25 < -1.5) skewLabel = 'PUT SKEW (bearish)';
    }

    return {
      sym,
      ts: now,
      spot: S,
      frontExpiryMs: frontExpiry,
      hoursToExpiry: (frontExpiry - now) / 3600000,
      dvol,
      atmIv: atmIv != null ? atmIv * 100 : null,   // vol %
      riskReversal25: rr25,                          // vol points (skew)
      skewLabel,
      pinStrike,
      pinDistPct,
      maxPain,
      maxPainDistPct,
      available: true,
    };
  }

  function emitEnvelope(state) {
    const envelope = {
      envelope_id: `opt:${state.sym}:${state.ts}:${Math.floor(Math.random() * 1e6)}`,
      source: 'options-gamma-feed',
      received_ts: new Date(state.ts).toISOString(),
      chain_ts: null,
      type: 'options_snapshot',
      raw: null,
      parsed: {
        symbol: state.sym,
        spot: state.spot,
        dvol: state.dvol,
        atm_iv: state.atmIv,
        risk_reversal_25d: state.riskReversal25,
        skew_label: state.skewLabel,
        pin_strike: state.pinStrike,
        pin_dist_pct: state.pinDistPct,
        max_pain: state.maxPain,
        max_pain_dist_pct: state.maxPainDistPct,
        hours_to_expiry: state.hoursToExpiry,
      },
      provenance: { module: 'options-gamma-feed', venue: 'deribit' },
      schema_version: 'v1',
    };
    window.dispatchEvent(new CustomEvent('market-data-envelope', { detail: envelope }));
  }

  async function fetchAll() {
    const detail = {};
    for (const sym of COINS) {
      try {
        const state = await fetchCoin(sym);
        CACHE[sym] = state;
        detail[sym] = state;
        emitEnvelope(state);
        try { window.DataLogger?.logOptions?.(sym, {
          spot: state.spot, dvol: state.dvol, atmIv: state.atmIv,
          riskReversal25: state.riskReversal25, skewLabel: state.skewLabel,
          pinStrike: state.pinStrike, pinDistPct: state.pinDistPct,
          maxPain: state.maxPain, maxPainDistPct: state.maxPainDistPct,
          hoursToExpiry: state.hoursToExpiry, ts: state.ts,
        }); } catch (_) {}
      } catch (e) {
        // preserve prior cache; log sparingly
        if (!CACHE[`_warn_${sym}`] || Date.now() - CACHE[`_warn_${sym}`] > 300000) {
          console.warn(`[OptionsGammaFeed] ${sym} skipped:`, e.message);
          CACHE[`_warn_${sym}`] = Date.now();
        }
      }
    }
    window.dispatchEvent(new CustomEvent('options-gamma-update', { detail }));
    return detail;
  }

  const OptionsGammaFeed = {
    POLL_MS,
    get(sym) { return CACHE[sym] || null; },
    getAll() {
      const out = {};
      for (const k of Object.keys(CACHE)) if (!k.startsWith('_warn_')) out[k] = CACHE[k];
      return out;
    },
    fetchAll,
    start() {
      if (_timer) return;
      fetchAll();
      _timer = setInterval(() => { if (!document.hidden) fetchAll(); }, POLL_MS);
    },
    stop() { clearInterval(_timer); _timer = null; },
  };

  window.OptionsGammaFeed = OptionsGammaFeed;
})();
