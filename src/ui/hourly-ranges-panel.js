// ================================================================
// WE|||CRYPTO — Hourly Ranges Panel v9 (hourly ranges only)
//
// Shows a spot-centered synthetic hourly range ladder. Kalshi 15m
// contracts are intentionally not rendered here.
// WE|||CRYPTO — Hourly Ranges Panel v8 (Kalshi 15m)
//
// Shows a spot-centered synthetic hourly range ladder. Kalshi 15m
// contracts are intentionally not rendered here.
// Polls every 10s, accelerates to every 2.5s in the final 15 mins.
// ================================================================

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────
  const escapeHTML = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const safeGet = (obj, key) => (obj && typeof key === 'string' && key !== '__proto__' && key !== 'constructor' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);
  const COINBASE_EXCH_BASE = 'https://api.exchange.coinbase.com';
  const INSTRUMENTS = {
    BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD',
    XRP: 'XRPUSD', DOGE: 'DOGEUSD', BNB: 'BNBUSD', HYPE: 'HYPEUSD',
  };

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];

  const CB_PRODUCTS = {
    BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD',
    XRP: 'XRP-USD', DOGE: 'DOGE-USD',
  };

  const KRAKEN_BASE = 'https://api.kraken.com/0/public';

  const KRAKEN_TICKERS = {
    BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLZUSD',
    XRP: 'XXRPZUSD', DOGE: 'XDOGEZUSD',
  };

  const COIN_COLORS = {
    BTC: '#f7931a', ETH: '#627eea', SOL: '#00d4aa',
    XRP: '#00aae4', DOGE: '#c2a633', BNB: '#f3ba2f', HYPE: '#50e3c2',
  };
  const VISIBLE_BUCKETS = 11;   // 5 above + current + 5 below (synthetic fallback only)
  const VISIBLE_PTB_ROWS = 8;   // real-ladder mode: single-PTB rows near spot
  const KALSHI_LADDER_WORKER = 'https://kalshi-ladder-worker.gitgoin87.workers.dev';
  // Coins Kalshi runs an hourly "between" range series for — kept in sync
  // with kalshi-ladder-worker's SERIES_BY_SYMBOL. HYPE has no such series,
  // so it always falls back to the synthetic ladder below.
  const REAL_LADDER_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB']);
  // Sequential blue ramp, light->dark (dataviz skill reference palette,
  // used as-is — no brand substitution needed). Discrete steps for a
  // filled-cell heatmap treatment, legible against this app's dark surface
  // regardless of which end of the ramp: the block itself carries the
  // magnitude, text stays on top in the app's normal ink color.
  const WALL_SATURATION_STEPS = ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'];
  const POLL_NORMAL_MS  = 10000;  // First 30 mins (10s)
  const POLL_HALF_MS    = 5000;   // Last 30 mins (5s)
  const POLL_FAST_MS    = 2500;   // Last 15 mins (2.5s)
  const HALF_WINDOW_MS  = 30 * 60 * 1000;
  const FAST_WINDOW_MS  = 15 * 60 * 1000;

  // ── State ──────────────────────────────────────────────────────
  let _prices  = {}; // sym → number
  let _ranges  = {}; // sym → [{ low, high, yesAsk, yesBid, yesAsk%, closeTime }] (synthetic fallback)
  let _realBands = {}; // sym → real Kalshi "between" bands from kalshi-ladder-worker, or [] if unavailable
  let _prevYesBid = {}; // sym → Map(low -> previous yes_bid_dollars), for the momentum arrow
  let _closeTimes = {}; // sym → ISO string of active bucket
  let _timer   = null;
  let _mounted = false;

  // Zero Cold-Start LocalStorage Persistence
  try {
    if (typeof localStorage !== 'undefined') {
      const pCache = localStorage.getItem('__we_hr_prices_cache');
      const rCache = localStorage.getItem('__we_hr_ranges_cache');
      if (pCache) _prices = Object.assign(_prices, JSON.parse(pCache));
      if (rCache) _ranges = Object.assign(_ranges, JSON.parse(rCache));
    }
  } catch (_) {}

  function saveHRCache() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('__we_hr_prices_cache', JSON.stringify(_prices));
        localStorage.setItem('__we_hr_ranges_cache', JSON.stringify(_ranges));
      }
    } catch (_) {}
  }

  // ── View detection ─────────────────────────────────────────────
  function isActive() {
    return (window.__weCurrentView || '') === 'hourly-ranges'
      || document.querySelector('.nav-btn.active')?.dataset?.view === 'hourly-ranges';
  }

  // ── Fetch helper (uses suppFetch for CORS bypass) ──────────────
  async function apiFetch(url, timeoutMs = 20000) {
    const race = (p) => Promise.race([p, new Promise((_, r) =>
      setTimeout(() => r(new Error('timeout')), timeoutMs))]);

    // Try suppFetch (Tauri/proxy layer)
    if (typeof window.suppFetch === 'function') {
      try {
        const res = await race(window.suppFetch(url));
        if (res && typeof res.json === 'function') {
          // proxyFetch returns a real Response — a persistent upstream 503
          // comes back as .ok === false, not a thrown error. Skipping this
          // check meant an error body (e.g. the kalshi-ladder-worker's typed
          // 503 JSON) got parsed as if it were valid data instead of
          // rejecting, which silently fed "no bands" into callers that then
          // wiped out perfectly good previous state on a transient failure.
          if (res.ok === false) throw new Error(`HTTP ${res.status}`);
          return await race(res.json());
        }
        return typeof res === 'string' ? JSON.parse(res) : res;
      } catch (e) {
        console.warn('[HR]', url, 'suppFetch failed:', e.message);
      }
    }

    // Fallback to native fetch
    const res = await race(fetch(url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── Spot-Centered Range Synthesizer (for bracket & strike ranges) ──
  function getStepSize(sym, refPrice) {
    if (sym === 'BTC' || refPrice >= 20000) return 100;
    if (sym === 'ETH' || (refPrice >= 1000 && refPrice < 20000)) return 10;
    if (sym === 'SOL' || (refPrice >= 50 && refPrice < 1000)) return 0.5;
    if (sym === 'BNB') return 2;
    if (sym === 'HYPE') return 0.25;
    if (sym === 'XRP' || (refPrice >= 0.5 && refPrice < 50)) return 0.01;
    if (sym === 'DOGE' || refPrice < 0.5) return 0.005;
    return refPrice * 0.002;
  }

  function getFallbackDecimals(sym) {
    if (sym === 'SOL' || sym === 'HYPE' || sym === 'XRP') return 4;
    if (sym === 'DOGE') return 7;
    return 2;
  }

  function buildSpotCenteredRanges(sym, refPrice, closeTimeIso) {
    if (!Number.isFinite(refPrice) || refPrice <= 0) return [];
    const step = getStepSize(sym, refPrice);
    const pivotLow = Math.floor(refPrice / step) * step;
    const numBelow = 5;
    const numAbove = 5;
    const result = [];
    const closeIso = closeTimeIso || new Date(Math.ceil(Date.now() / 3600000) * 3600000).toISOString();

    for (let i = -numBelow; i <= numAbove; i++) {
      const low = Number((pivotLow + i * step).toFixed(4));
      const high = Number((pivotLow + (i + 1) * step).toFixed(4));
      const distFromSpot = Math.abs((low + high) / 2 - refPrice) / step;
      let prob = Math.exp(-distFromSpot * distFromSpot * 0.35) * 0.48;
      prob = Number(Math.max(0.01, Math.min(0.85, prob)).toFixed(2));
      const tickerStr = `${sym}-RANGE-${low}`;

      result.push({
        low,
        high,
        yesAsk: prob,
        yesBid: prob,
        noAsk: Number((1 - prob).toFixed(2)),
        prob,
        ticker: tickerStr,
        closeTime: closeIso,
        subtitle: `$${low} to ${high}`,
      });
    }

    return result;
  }

  function readLivePrice(sym) {
    const instrument = safeGet(INSTRUMENTS, sym);
    const ticker = instrument
      ? (safeGet(window.tickers, instrument) || safeGet(window._appTickers, instrument))
      : null;
    if (ticker) {
      const p = parseFloat(ticker.last ?? ticker.price ?? ticker.close);
      if (Number.isFinite(p) && p > 0) return p;
    }

    const wsProviders = ['BINANCE', 'COINBASE', 'KRAKEN', 'BYBIT'];
    const wsQuotes = wsProviders
      .map((provider) => window.ExchangeWS?.getTicker?.(provider, sym, 120_000)?.price)
      .filter((p) => Number.isFinite(p) && p > 0);
    if (wsQuotes.length) {
      return wsQuotes.reduce((sum, p) => sum + p, 0) / wsQuotes.length;
    }

    const pred = safeGet(window._predictions, sym)?.price;
    if (pred && Number.isFinite(+pred) && +pred > 0) return +pred;

    return null;
  }

  // ── Live price fetcher ─────────────────────────────────────────
  async function fetchPrice(sym) {
    const cached = readLivePrice(sym);
    if (cached !== null) return cached;

    const cbProd = safeGet(CB_PRODUCTS, sym);
    if (cbProd) {
      try {
        const d = await apiFetch(`${COINBASE_EXCH_BASE}/products/${cbProd}/ticker`, 8000);
        if (d?.price) {
          const p = parseFloat(d.price);
          if (Number.isFinite(p) && p > 0) return p;
        }
      } catch (e) { console.warn(`[HR] Coinbase exchange ticker failed for ${sym}:`, e.message); }
    }

    const kt = safeGet(KRAKEN_TICKERS, sym);
    if (kt) {
      try {
        const d = await apiFetch(`${KRAKEN_BASE}/Ticker?pair=${kt}`, 8000);
        const c = safeGet(d?.result, kt)?.c;
        if (c && Array.isArray(c)) {
          const p = parseFloat(c.at(0));
          if (Number.isFinite(p) && p > 0) return p;
        }
      } catch (e) { console.warn(`[HR] Kraken price fetch failed for ${sym}:`, e.message); }
    }

    return readLivePrice(sym);
  }

  // ── Build range list for a coin ────────────────────────────────
  // No live multi-strike hourly ladder market exists today,
  // so the ladder is always the
  // spot-centered synthetic distribution.
  const _rangeHourTs = Object.create(null);

  function get60mContract(sym) {
    return window.PredictionMarkets?.getCoin?.(sym)?.poly60m || null;
  }

  // A successful fetch can still return zero bands — Kalshi briefly shows no
  // open "between" markets for a symbol during the hourly contract rollover
  // (old hour's bands close right as the new hour's are still opening).
  // Treating "succeeded with 0 bands" the same as "never had real data"
  // caused the panel to flicker: real ladder shown, one poll returns an
  // empty array, and it flips straight back to synthetic. Require a few
  // consecutive confirmed-empty polls before believing it (same distrust of
  // a single sample as the failure path already has), so a 10-30s rollover
  // blip doesn't wipe out perfectly good real data.
  const EMPTY_STREAK_TO_FALL_BACK = 3;
  let _emptyRealStreak = {}; // sym -> consecutive successful-but-empty poll count

  // ── Real Kalshi hourly ladder (single-strike PTB rows, real bid-wall size) ──
  const _kalshiWorkerHost = (() => { try { return new URL(KALSHI_LADDER_WORKER).hostname; } catch (_) { return ''; } })();
  function kalshiWorkerCircuitOpen() {
    // Worker down (5xx) → breaker opens for 60s. Skip the fetch entirely
    // while open: the tick runs every 2.5–10s and each attempt otherwise
    // burns a proxied + direct call that both 503. Keep last-known bands.
    try {
      const b = window.ApiCircuitBreaker?.getBreaker?.(`proxy-fetch:${_kalshiWorkerHost}`, { threshold: 5, timeout: 60000 });
      return !!(b && typeof b.isAvailable === 'function' && !b.isAvailable());
    } catch (_) { return false; }
  }
  async function loadRealLadder(sym) {
    if (!REAL_LADDER_SYMBOLS.has(sym)) return;
    if (kalshiWorkerCircuitOpen()) return;
    try {
      const data = await apiFetch(`${KALSHI_LADDER_WORKER}/ladder?symbol=${sym}`, 8000);
      const bands = (data && data.status === 'ok' && Array.isArray(data.bands)) ? data.bands : [];

      if (!bands.length) {
        const streak = (_emptyRealStreak[sym] || 0) + 1;
        _emptyRealStreak[sym] = streak;
        if (streak < EMPTY_STREAK_TO_FALL_BACK && (safeGet(_realBands, sym) || []).length) {
          return; // trust the last known-good bands through a brief rollover gap
        }
        _realBands[sym] = [];
        return;
      }
      _emptyRealStreak[sym] = 0;

      const prevMap = _prevYesBid[sym] || (_prevYesBid[sym] = new Map());
      for (const b of bands) {
        const bid = Number(b.yes_bid_dollars);
        if (Number.isFinite(bid)) {
          b.prev_yes_bid_dollars = prevMap.has(b.low) ? prevMap.get(b.low) : null;
          prevMap.set(b.low, bid);
        } else {
          b.prev_yes_bid_dollars = null;
        }
      }
      _realBands[sym] = bands;
    } catch (e) {
      console.warn(`[HR] real ladder fetch failed for ${sym}:`, e.message);
      // Leave whatever we had before (stale-but-real beats flipping to synthetic
      // on a single transient failure); buildCoinCard falls back to synthetic
      // only when _realBands[sym] has never been populated.
    }
  }

  // ── Model strike probabilities (engine artifact, Kalshi-independent) ──
  // prediction_engine.py writes data/engine_latest.json every ~5 min.
  // Indexed by "low-high" → p_touch (model's predicted touch probability
  // for the hourly close window). Only BTC until the engine covers more
  // coins; everything else stays Kalshi-only.
  const MODEL_STRIKE_TTL_MS = 600_000; // artifact older than 10m = stale
  const MODEL_REFRESH_MS = 60_000;     // re-read at most once a minute
  let _modelStrikes = {}; // sym → { ts, byKey: Map("low-high" → p_touch) }
  let _modelFetchTs = 0;
  async function loadModelStrikes() {
    const now = Date.now();
    if (now - _modelFetchTs < MODEL_REFRESH_MS && Object.keys(_modelStrikes).length) return;
    _modelFetchTs = now;
    try {
      // Prefer the absolute-path channel (works regardless of launch dir);
      // fall back to the workspace-relative read.
      let res = null;
      if (window.electron && typeof window.electron.invoke === 'function') {
        try { res = await window.electron.invoke('data:engineLatest'); } catch (_) { res = null; }
      }
      if ((!res || !res.ok) && window.electron && typeof window.electron.readFile === 'function') {
        const content = await window.electron.readFile('data/engine_latest.json');
        res = content ? { ok: true, content } : null;
      }
      if (!res || !res.ok || !res.content) return;
      const doc = JSON.parse(typeof res.content === 'string' ? res.content : res.content);
      const ageMs = now - Date.parse(doc.timestamp_utc || 0);
      if (!Number.isFinite(ageMs) || ageMs > MODEL_STRIKE_TTL_MS) { _modelStrikes = {}; return; }
      const byKey = new Map();
      for (const s of (doc.strike_probs || [])) {
        if (s && Number.isFinite(s.low) && Number.isFinite(s.high) && Number.isFinite(s.p_touch)) {
          byKey.set(`${s.low}-${s.high}`, s.p_touch);
        }
      }
      _modelStrikes = { BTC: { ts: now, byKey } };
      // Engine predicted range + remaining-window probabilities for
      // spot-centered synthetic buckets. strike_probs only covers Kalshi's
      // listed bands, so synthetic rows would otherwise show no model odds.
      try {
        const rp = doc.probabilities_remaining || {};
        const rlo = Number(doc.range && doc.range.lower);
        const rhi = Number(doc.range && doc.range.upper);
        if (Number.isFinite(rlo) && Number.isFinite(rhi) && rhi > rlo) {
          _modelStrikes.BTC.range = {
            lower: rlo, upper: rhi,
            inRange: Number.isFinite(rp.in_range) ? rp.in_range : null,
            aboveUpper: Number.isFinite(rp.above_upper) ? rp.above_upper : null,
            belowLower: Number.isFinite(rp.below_lower) ? rp.below_lower : null,
          };
        }
      } catch (_) {}
    } catch (e) { console.warn('[HR] model strikes unavailable:', e.message); }
  }
  // Model odds for spot-centered synthetic buckets: distribute the
  // engine's remaining-window region probabilities (in_range / above_upper
  // / below_lower) across the bucket by overlap with the predicted range.
  // Band-key lookup (modelTouchPct) only covers Kalshi's listed strikes.
  function modelRangePct(sym, low, high) {
    const entry = _modelStrikes[sym];
    const rg = entry && entry.range;
    if (!rg || !Number.isFinite(rg.lower) || !Number.isFinite(rg.upper) || rg.upper <= rg.lower) return null;
    const lo = Number(low), hi = Number(high);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
    const w = hi - lo;
    const overlap = (a, b) => Math.max(0, Math.min(hi, b) - Math.max(lo, a)) / w;
    let p = 0, covered = false;
    if (rg.inRange != null) { p += overlap(rg.lower, rg.upper) * rg.inRange; covered = true; }
    if (rg.aboveUpper != null) { p += overlap(rg.upper, Infinity) * rg.aboveUpper; covered = true; }
    if (rg.belowLower != null) { p += overlap(-Infinity, rg.lower) * rg.belowLower; covered = true; }
    if (!covered) return null;
    return Math.round(Math.max(0, Math.min(1, p)) * 100);
  }
  function modelTouchPct(sym, low, high) {
    const entry = _modelStrikes[sym];
    if (!entry) return null;
    const exact = entry.byKey.get(`${low}-${high}`);
    if (Number.isFinite(exact)) return Math.round(exact * 100);
    // Hour-roll tolerance: panel may still show last hour's cached bands
    // while the artifact already rolled — nearest band within $500.
    let best = null, bestD = 500;
    for (const [key, v] of entry.byKey) {
      const sep = key.indexOf('-');
      const klo = Number(key.slice(0, sep));
      if (!Number.isFinite(klo)) continue;
      const d = Math.abs(klo - low);
      if (d < bestD) { bestD = d; best = v; }
    }
    return Number.isFinite(best) ? Math.round(best * 100) : null;
  }

  async function loadCoin(sym) {    const price = await fetchPrice(sym);

    if (price !== null && Number.isFinite(price) && sym) {
      Object.defineProperty(_prices, sym, { value: price, writable: true, enumerable: true, configurable: true });
    }

    const p60 = get60mContract(sym);
    const lockedPtb = Number(p60?.priceToBeatNum);
    const hourStartMs = Math.floor(Date.now() / 3600000) * 3600000;
    // Hourly contract is immutable at T0: center the ladder on locked PTB, not live spot.
    const refPrice = (Number.isFinite(lockedPtb) && lockedPtb > 0) ? lockedPtb : (safeGet(_prices, sym) ?? price);
    if (!Number.isFinite(refPrice) || refPrice <= 0) return;

    const nextHourIso = (p60?.closeTime) || new Date(hourStartMs + 3600000).toISOString();
    if (sym) {
      Object.defineProperty(_closeTimes, sym, { value: nextHourIso, writable: true, enumerable: true, configurable: true });
    }
    const currentHourTs = safeGet(_rangeHourTs, sym);
    const currentRanges = safeGet(_ranges, sym);
    if (currentHourTs === hourStartMs && currentRanges?.length && Number.isFinite(lockedPtb) && lockedPtb > 0) {
      saveHRCache();
      return;
    }
    if (sym) {
      Object.defineProperty(_rangeHourTs, sym, { value: hourStartMs, writable: true, enumerable: true, configurable: true });
      Object.defineProperty(_ranges, sym, { value: buildSpotCenteredRanges(sym, refPrice, nextHourIso), writable: true, enumerable: true, configurable: true });
    }
    saveHRCache();
  }

  // ── Select visible window around current price ─────────────────
  function selectVisible(ranges, currentPrice) {
    if (!ranges?.length) return ranges || [];

    let pivotIdx = -1;

    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      // Find the bucket the price falls in
      pivotIdx = ranges.findIndex(r => currentPrice >= r.low && currentPrice <= r.high);

      if (pivotIdx === -1) {
        // Find nearest bucket mid
        let best = Infinity;
        for (let i = 0; i < ranges.length; i++) {
          const r = ranges.at(i);
          if (!r) continue;
          const mid = (r.low + r.high) / 2;
          const d = Math.abs(mid - currentPrice);
          if (d < best) { best = d; pivotIdx = i; }
        }
      }
    }

    if (pivotIdx === -1) {
      // Default: bucket with highest probability
      let bestProb = -1;
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges.at(i);
        if (!r) continue;
        if (r.prob > bestProb) { bestProb = r.prob; pivotIdx = i; }
      }
    }

    if (pivotIdx === -1) return ranges.slice(0, VISIBLE_BUCKETS);

    const half = Math.floor(VISIBLE_BUCKETS / 2);
    let start = Math.max(0, pivotIdx - half);
    let end   = Math.min(ranges.length - 1, start + VISIBLE_BUCKETS - 1);
    // Shift start if we hit the end
    if (end - start + 1 < VISIBLE_BUCKETS) {
      start = Math.max(0, end - VISIBLE_BUCKETS + 1);
    }

    return ranges.slice(start, end + 1);
  }

  // ── Format helpers ─────────────────────────────────────────────
  function fmtPrice(low, high) {
    const dp = low >= 100 ? 0 : low >= 1 ? 2 : 4;
    return `$${low.toFixed(dp)}–$${high.toFixed(dp)}`;
  }

  function fmtPct(p) {
    return (p * 100).toFixed(0) + '%';
  }

  function timeToClose(isoStr) {
    const ms = Date.parse(isoStr) - Date.now();
    if (!Number.isFinite(ms) || ms <= -75000) return null;
    if (ms <= 0) return 'Closing Now';
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  // ── Build HTML for one coin card ───────────────────────────────
  function buildCoinCard(sym) {
    let ranges  = safeGet(_ranges, sym) || [];
    const price   = safeGet(_prices, sym) || readLivePrice(sym);
    const color   = safeGet(COIN_COLORS, sym) || '#888';
    const ctISO   = safeGet(_closeTimes, sym) || (ranges.at(0)?.closeTime) || new Date(Math.ceil(Date.now() / 3600000) * 3600000).toISOString();
    const ttc     = ctISO ? timeToClose(ctISO) : null;
    const ttcMs   = ctISO ? Date.parse(ctISO) - Date.now() : null;
    const isFinal = ttcMs !== null && ttcMs < FAST_WINDOW_MS;

    const priceStr = price
      ? (window.CoinPrecision?.formatCoinPrice
          ? window.CoinPrecision.formatCoinPrice(sym, price)
          : `$${Number(price).toLocaleString('en-US', { minimumFractionDigits: getFallbackDecimals(sym), maximumFractionDigits: getFallbackDecimals(sym) })}`)
      : '—';


    let body;
    let topBuckets = [];
    const realBands = safeGet(_realBands, sym) || [];
    // Off-grid guard: when spot has moved past the end of Kalshi's listed
    // grid (e.g. a $2k dump below the lowest bracket), every real row is
    // untradeable noise. Fall back to spot-centered synthetic rows and say
    // so, instead of rendering a ladder thousands away from the price.
    const gridLo = realBands.length ? Math.min(...realBands.map(b => Number(b.low))) : null;
    const gridHi = realBands.length ? Math.max(...realBands.map(b => Number(b.high ?? b.low))) : null;
    const offGrid = price != null && Number.isFinite(gridLo) && Number.isFinite(gridHi) &&
      (price < gridLo || price > gridHi);
    const isLive = realBands.length > 0 && !offGrid;

    if (isLive) {
      // ── Real Kalshi hourly ladder: single-PTB rows, bid-wall saturation ──
      // PTB = the band's floor_strike — a real, exact number straight from
      // Kalshi, not a computed midpoint. "In spec" here means: this row
      // corresponds to an actual open, tradeable Kalshi contract right now.
      const sorted = [...realBands].sort((a, b) =>
        Math.abs(a.low - (price ?? a.low)) - Math.abs(b.low - (price ?? b.low))
      );
      const nearest = sorted.slice(0, VISIBLE_PTB_ROWS).sort((a, b) => a.low - b.low);

      // Depth can sit on either side of the book — a band with a big resting
      // ask and nothing on the bid is still a real wall (BTC's own rows were
      // showing transparent for every bucket because this only ever checked
      // yes_bid_size/open_interest while the actual size was on yes_ask_size).
      const wallDepth = (b) => Math.max(0, b.yes_bid_size || 0, b.yes_ask_size || 0, b.open_interest || 0);
      const wallSizes = nearest.map(wallDepth);
      const maxWall = Math.max(1, ...wallSizes);

      const rows = nearest.map(b => {
        const isCurrent = price !== null && price >= b.low && price <= b.high;
        const wallSize = wallDepth(b);
        const satIdx = Math.min(
          WALL_SATURATION_STEPS.length - 1,
          Math.floor((wallSize / maxWall) * WALL_SATURATION_STEPS.length)
        );
        const wallColor = wallSize > 0 ? WALL_SATURATION_STEPS[satIdx] : 'transparent';

        const bid = Number(b.yes_bid_dollars);
        const prevBid = b.prev_yes_bid_dollars;
        let arrow = '';
        if (Number.isFinite(bid) && Number.isFinite(prevBid) && bid !== prevBid) {
          arrow = bid > prevBid
            ? `<span class="hr-ptb-arrow hr-ptb-arrow--up" title="Yes bid rose since last poll">▲</span>`
            : `<span class="hr-ptb-arrow hr-ptb-arrow--down" title="Yes bid fell since last poll">▼</span>`;
        }

        const ptbStr = window.CoinPrecision?.formatCoinStrike
          ? window.CoinPrecision.formatCoinStrike(sym, b.low)
          : `$${b.low.toLocaleString()}`;
        // yes_bid_dollars/yes_ask_dollars are dollar units (0.25 = 25 cents)
        // — Kalshi contracts trade $0.01-$1.00, i.e. 1-100 cents.
        const bidStr = Number.isFinite(bid) ? `${(bid * 100).toFixed(0)}¢` : '—';
        const askVal = Number(b.yes_ask_dollars);
        const askStr = Number.isFinite(askVal) ? `${(askVal * 100).toFixed(0)}¢` : '—';

        // A Kalshi YES price already IS the market-implied probability that
        // this band gets hit — no separate model needed, just read it off
        // the book. Mid of bid/ask when both quote; whichever side is
        // actually quoted otherwise (thin books often have only one side).
        let probPct = null;
        if (Number.isFinite(bid) && bid > 0 && Number.isFinite(askVal) && askVal > 0) {
          probPct = Math.round(((bid + askVal) / 2) * 100);
        } else if (Number.isFinite(askVal) && askVal > 0) {
          // No resting bid (common on thin/far-OTM strikes) — averaging with
          // $0 would understate it; the ask alone is the honest read.
          probPct = Math.round(askVal * 100);
        } else if (Number.isFinite(bid) && bid > 0) {
          probPct = Math.round(bid * 100);
        }
        const probStr = probPct !== null ? `${probPct}%` : '—';

        // MODEL probability: engine's predicted touch for this band
        // (calibrated, Kalshi-independent). Residual = market − model:
        // big gaps are the mispricings. Null when the engine artifact is
        // missing/stale or doesn't cover this coin.
        const modelPct = modelTouchPct(sym, b.low, b.high);
        const modelStr = modelPct !== null ? `${modelPct}%` : '—';
        const resid = (probPct !== null && modelPct !== null) ? probPct - modelPct : null;
        const residStr = resid !== null ? `${resid > 0 ? '+' : ''}${resid}` : '—';
        const hot = resid !== null && Math.abs(resid) >= 10;

        return `
          <div class="hr-ptb-row${isCurrent ? ' hr-ptb-row--current' : ''}" style="background:${escapeHTML(wallColor)}22;border-left-color:${escapeHTML(wallColor)}">
            <span class="hr-ptb-price">${escapeHTML(ptbStr)}</span>
            <span class="hr-ptb-prob"${isCurrent ? ` style="color:${escapeHTML(color)}"` : ''}>${escapeHTML(probStr)}</span>
            <span class="hr-ptb-model" title="Model touch probability (engine)${resid !== null ? ` — market-model residual ${residStr}¢` : ''}"${hot ? ' style="font-weight:700;text-decoration:underline"' : ''}>${escapeHTML(modelStr)}</span>
            <span class="hr-ptb-odds">${escapeHTML(bidStr)} / ${escapeHTML(askStr)}</span>
            ${arrow}
            ${isCurrent ? `<span class="hr-ptb-here" style="color:${escapeHTML(color)}">● HERE</span>` : ''}
          </div>`;
      });

      const closeLabel = ttc
        ? `<span class="hr-ttc${isFinal ? ' hr-ttc--fast' : ''}">Closes in ${ttc}</span>`
        : '';

      body = `
        <div class="hr-ranges-scroll">
          <div class="hr-ranges-header">
            <span class="hr-ranges-label">PTB · live Kalshi</span>
            <span class="hr-ranges-label">Prob (YES)</span>
            <span class="hr-ranges-label" title="Model touch probability — engine, Kalshi-independent">Model</span>
            <span class="hr-ranges-label">Bid / Ask</span>
          </div>
          ${rows.join('')}
        </div>
        ${closeLabel}`;
    } else {
      // ── No real Kalshi coverage for this coin — synthetic fallback,
      // clearly labeled so it's never mistaken for a live tradeable strike.
      if (!ranges.length && price) {
        ranges = buildSpotCenteredRanges(sym, price, ctISO);
        Object.defineProperty(_ranges, sym, { value: ranges, writable: true, enumerable: true, configurable: true });
      }

      if (!ranges.length) {
        body = `<div class="hr-empty">Loading market data…</div>`;
      } else {
        const visible = selectVisible(ranges, price);

        const step = getStepSize(sym, price || 1);
        const ranked = visible.map(r => {
          const mid = (r.low + r.high) / 2;
          const distSteps = price ? Math.abs(mid - price) / step : 0;
          const likelihood = Math.exp(-distSteps * distSteps * 0.45) * Math.max(0.05, r.prob || 0.3);
          return { ...r, likelihood };
        }).sort((a, b) => b.likelihood - a.likelihood);
        const sumL = ranked.reduce((s, b) => s + b.likelihood, 0) || 1;
        ranked.forEach(b => { b.pctLikely = Math.round((b.likelihood / sumL) * 100); });
        topBuckets = ranked.slice(0, 8);

        const rows = visible.map(r => {
          const isCurrent = price !== null && price >= r.low && price <= r.high;
          const probPctStr = fmtPct(r.prob);
          // Same Model column as live rows: engine touch for this band,
          // Kalshi-independent. Null when uncovered/stale.
          const modelPct = modelTouchPct(sym, r.low, r.high) ?? modelRangePct(sym, r.low, r.high);
          const modelStr = modelPct !== null ? `${modelPct}%` : '—';
          return `
            <div class="hr-row${isCurrent ? ' hr-row--current' : ''}">
              <span class="hr-row-range">${escapeHTML(fmtPrice(r.low, r.high))}</span>
              <span class="hr-row-prob" style="${isCurrent ? `color:${escapeHTML(color)}` : ''}">${escapeHTML(probPctStr)}</span>
              <span class="hr-ptb-model" title="Model touch probability (engine)">${escapeHTML(modelStr)}</span>
              ${isCurrent ? `<span class="hr-ptb-here" style="color:${escapeHTML(color)}">● HERE</span>` : ''}
            </div>`;
        });

        const closeLabel = ttc
          ? `<span class="hr-ttc${isFinal ? ' hr-ttc--fast' : ''}">Closes in ${ttc}</span>`
          : '';

        body = `
          <div class="hr-ranges-scroll">
          <div class="hr-ranges-header">
            <span class="hr-ranges-label">Synthetic estimate${offGrid ? ' · spot off Kalshi grid' : ''}</span>
            <span class="hr-ranges-label">Prob (YES)</span>
            <span class="hr-ranges-label" title="Model touch probability — engine, Kalshi-independent">Model</span>
          </div>
            ${rows.join('')}
          </div>
          ${closeLabel}`;
      }
    }

    // ASI1 hourly bucket guidance, pegged to a fixed 60-minute interval.
    // Grok 15m + hourly call pegged to live market data (no 5m, never WAIT)
    let grokHtml = '';
    try {
      const api = window.GrokRangeOverlay || window.GrokRangeGrok;
      const g60 = api && api.getGuidance ? api.getGuidance(sym, 60) : null;
      const renderOne = (label, g) => {
        if (!g) return '';
        if (g.error && !g.call) {
          return `<div class="hr-grok-row"><span class="hr-grok-label">${escapeHTML(label)}</span>
            <span class="hr-grok-meta" style="color:var(--color-orange,#f59e0b)">${escapeHTML(g.error)}</span></div>`;
        }
        if (!g.call && !(g.livePath && g.livePath.dir) && !g.displayCall) return '';
        const call = (g.displayCall || (g.livePath && g.livePath.dir) || g.call) === 'DOWN' ? 'DOWN' : 'UP';
        const col = call === 'UP' ? 'var(--color-green,#26a69a)' : 'var(--color-red,#ef5350)';
        const confRaw = Number(g.confidence) || 0;
        const pct = confRaw <= 1 ? Math.round(confRaw * 100) : Math.round(confRaw);

        let metaLine = `${pct}%`;
        let notes = escapeHTML(String(g.notes || '').slice(0, 180));

        const bucket = g.preferredBucket || g.preferredRange || g.range;
        if (topBuckets.length) {
          const top3Str = topBuckets.slice(0, 3).map((b, i) => `#${i+1} $${b.low}–$${b.high} (${b.pctLikely}%)`).join(' · ');
          metaLine += ` · Top buckets: ${top3Str}`;
        } else if (bucket && Number.isFinite(Number(bucket.low))) {
          metaLine += ` · fixed 60m interval $${Number(bucket.low).toLocaleString()}–$${Number(bucket.high).toLocaleString()}`;
        }
        if (label === '15m contract') {
          const peg15 = g.polyPeg || g.poly15m;
          const slug = g.contractSlug || (peg15 && peg15.slug) || '';
          const side = peg15 && peg15.side ? peg15.side : (call === 'UP' ? 'Up' : 'Down');
          const ptb = peg15 && peg15.priceToBeatNum;
          const ptbLabel = ptb
            ? (window.CoinPrecision?.formatCoinStrike
                ? window.CoinPrecision.formatCoinStrike(sym, ptb)
                : `$${Number(ptb).toLocaleString('en-US', { minimumFractionDigits: getFallbackDecimals(sym), maximumFractionDigits: getFallbackDecimals(sym) })}`)
            : (priceStr !== '—' ? priceStr : '');

          if (slug) metaLine += ` · id: ${escapeHTML(slug.length > 20 ? slug.substring(0, 12) + '...' : slug)}`;
          if (slug) metaLine += ` · buy ${side}`;
          if (ptbLabel) metaLine += ` · PTB ${ptbLabel}`;
          if (peg15 && peg15.yesProb != null) metaLine += ` · mkt Up ${(Number(peg15.yesProb) * 100).toFixed(0)}%`;
          if (peg15 && peg15.secondsToClose != null) metaLine += ` · ttc ${peg15.secondsToClose}s`;
        } else {
          metaLine += ' · fixed 60m interval';
        }

        if (/bucket\s+\$?\d+/i.test(notes)) {
          notes = '';
        }

        return `<div class="hr-grok-row">
          <span class="hr-grok-label">${escapeHTML(label)}</span>
          <span class="hr-grok-call" style="color:${col}">${call === 'UP' ? '▲' : '▼'} price ${call}</span>
          <span class="hr-grok-meta">${escapeHTML(metaLine)}</span>
          ${notes ? `<div class="hr-grok-notes">${notes}</div>` : ''}
        </div>`;
      };
      const b60 = renderOne('1h bucket', g60);
      let asi1Strip = '';
      try {
        asi1Strip = window.Asi1PreContract?.renderStripHtml?.(sym, { horizon: '60m', maxNotes: 360 }) || '';
      } catch (_) { asi1Strip = ''; }

      if (b60 || asi1Strip) {
        grokHtml = `<div class="hr-grok">
          <div class="hr-grok-hdr">✨ ASI1 pre-contract · 🤖 range overlay · fixed 60m interval</div>
          ${asi1Strip}
          ${b60}
        </div>`;
      } else {
        const stats = window.GrokAnalyticsMemory && window.GrokAnalyticsMemory.getStats
          ? window.GrokAnalyticsMemory.getStats() : null;
        const n = stats && stats.byCoin && stats.byCoin[sym] ? stats.byCoin[sym].samples : 0;
        grokHtml = `<div class="hr-grok"><div class="hr-grok-hdr">✨ ASI1 · hourly bucket memory</div>
          <div class="hr-grok-notes">Building hourly bucket briefs… ${n} samples · fixed 60m interval</div></div>`;
      }
    } catch (_) { grokHtml = ''; }

    // The body is the spot-centered hourly bucket ladder (top-3 ranked by
    // likelihood); Grok adds the LLM's
    // Kalshi 15m Up/Down — pulled by prediction-markets.js fetchKalshi15M().
    // Render the live Kalshi quote directly; do not substitute another venue here.
    let kalshi15mHtml = '';
    try {
      const k15 = window.PredictionMarkets?.getCoin?.(sym)?.kalshi15m;
      const ticker = k15?.ticker || '';
      const upProb = Number(k15?.probability);
      const hasProb = Number.isFinite(upProb);
      const call = hasProb ? (upProb >= 0.5 ? 'UP' : 'DOWN') : null;
      const col = call === 'UP' ? 'var(--color-green,#26a69a)' : call === 'DOWN' ? 'var(--color-red,#ef5350)' : 'var(--color-text-faint)';
      const ptbNum = Number(k15?.targetPriceNum);
      const ptbLabel = k15?.targetPrice || (Number.isFinite(ptbNum) && ptbNum > 0
          ? (window.CoinPrecision?.formatCoinStrike
              ? window.CoinPrecision.formatCoinStrike(sym, ptbNum)
              : `$${ptbNum.toLocaleString('en-US', { minimumFractionDigits: getFallbackDecimals(sym), maximumFractionDigits: getFallbackDecimals(sym) })}`)
          : 'pending');
      const closeLabel15 = k15?.closeTime ? timeToClose(k15.closeTime) : null;
      const currentPrice15 = _prices[sym] || readLivePrice(sym);
      const prediction15 = window._predictions?.[sym] || window.PredictionEngine?.get?.(sym) || null;
      const fair15 = window.GrokRangeOverlay?.get15mModelFair?.(k15, currentPrice15, prediction15);
      const fair15Label = fair15?.model_fair_cents != null
        ? `Model fair ${Number(fair15.model_fair_cents).toFixed(1)}¢${fair15.residual_cents != null ? ` · residual ${Number(fair15.residual_cents).toFixed(1)}¢` : ''}`
        : 'Model fair pending';

      if (ticker) {
        kalshi15mHtml = `<div class="hr-kalshi15m" style="margin-bottom:8px;">
          <div class="hr-grok-hdr" style="display:flex;justify-content:space-between;">
            <span>Kalshi 15m Up/Down</span>
            <span style="opacity:0.5;font-family:monospace;font-size:9px;" title="Kalshi ticker">${escapeHTML(ticker)}</span>
          </div>
          <div class="hr-grok-row" style="margin-top:4px;">
            <span class="hr-grok-call" style="color:${col}">${hasProb ? `${call === 'UP' ? '▲' : '▼'} ${Math.round(upProb * 100)}% YES` : 'awaiting odds'}</span>
            <span class="hr-grok-meta">Strike ${ptbLabel}${closeLabel15 ? ` · closes ${closeLabel15}` : ''}</span>
            <div class="hr-grok-notes">${fair15Label}${fair15?.flagged ? ' · ask above model' : ''}</div>
          </div>
        </div>`;
      }
    } catch (_) { kalshi15mHtml = ''; }

    // Kalshi shows the live 15m odds; body is the spot-centered
    // hourly bucket ladder (top-3 ranked by likelihood); Grok adds the LLM's
    // own directional call + reasoning on top of both.
    return `
      <div class="hr-card">
        <div class="hr-card-header">
          <span class="hr-sym" style="color:${color}">${escapeHTML(sym)}</span>
          <span class="hr-price">${escapeHTML(priceStr)}</span>
        </div>
        <div class="hr-card-body">${kalshi15mHtml || ''}${body}${grokHtml}</div>
      </div>`;
  }

  // ── Build full panel HTML ──────────────────────────────────────
  function buildPanelHTML() {
    const now = new Date().toLocaleTimeString();
    return `
      <div class="hr-panel" id="hourly-ranges-panel">
        <div class="hr-panel-hdr">
          <h2 class="hr-panel-title">▲▼ Hourly Ranges</h2>
          <span class="hr-panel-updated">Updated ${now}</span>
        </div>
        <div class="hr-grid">
          ${COINS.map(buildCoinCard).join('')}
        </div>
      </div>
      <style>
        .hr-panel { padding: 12px 16px; font-family: inherit; }
        .hr-panel-hdr { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
        .hr-panel-title { font-size:1.1rem; font-weight:700; margin:0; color:var(--color-text,#e0e0e0); }
        .hr-panel-updated { font-size:0.72rem; color:var(--color-text-muted,#888); margin-left:auto; }
        .hr-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 12px;
        }
        .hr-card {
          background: var(--color-card-bg, rgba(255,255,255,0.05));
          border: 1px solid var(--color-border, rgba(255,255,255,0.1));
          border-radius: 10px;
          overflow: hidden;
        }
        .hr-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px 6px;
          border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        .hr-sym { font-size:1rem; font-weight:800; letter-spacing:.5px; }
        .hr-price { font-size:.85rem; font-weight:600; color:var(--color-text-muted,#aaa); }
        .hr-card-body { padding: 6px 0 6px; }
        .hr-ranges-scroll {
          overflow-y: visible;
          scrollbar-width: thin;
        }
        .hr-ranges-header {
          display: flex;
          justify-content: space-between;
          padding: 2px 12px 4px;
          font-size: .65rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: .8px;
          color: var(--color-text-muted,#666);
        }
        .hr-row {
          position: relative;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 5px 12px;
          min-height: 28px;
          overflow: hidden;
        }
        .hr-row--current {
          background: rgba(255,255,255,0.07);
          border-left: 3px solid var(--color-accent,#4af);
        }
        .hr-row-bar {
          position: absolute;
          left: 0; top: 0; bottom: 0;
          opacity: 0.25;
          pointer-events: none;
          transition: width .4s ease;
        }
        .hr-row-range {
          position: relative;
          flex: 1;
          font-size: .78rem;
          font-weight: 500;
          color: var(--color-text,#ddd);
          white-space: nowrap;
        }
        .hr-row-prob {
          position: relative;
          font-size: .8rem;
          font-weight: 700;
          min-width: 38px;
          text-align: right;
          color: var(--color-text-muted,#aaa);
        }
        .hr-row-badge {
          position: relative;
          animation: hr-pulse-badge 2s infinite ease-in-out;
          font-size: .58rem;
          font-weight: 800;
          letter-spacing: .5px;
          padding: 1px 5px;
          border-radius: 4px;
          color: #000;
        }
        /* Real-ladder single-PTB rows. Background is the bid-wall saturation
           color set inline per row (sequential blue ramp, magnitude = wall
           size) — this block encodes depth; text stays in normal ink. */
        .hr-ptb-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          min-height: 28px;
          border-left: 3px solid transparent;
          border-radius: 2px;
        }
        .hr-ptb-row--current {
          border-left-color: var(--color-accent,#4af) !important;
        }
        .hr-ptb-price {
          flex: 1;
          font-size: .78rem;
          font-weight: 600;
          color: var(--color-text,#ddd);
          white-space: nowrap;
        }
        .hr-ptb-prob {
          font-size: .8rem;
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          min-width: 34px;
          text-align: right;
          color: var(--color-text,#ddd);
          white-space: nowrap;
        }
        .hr-ptb-odds {
          font-size: .68rem;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          color: var(--color-text-muted,#888);
          white-space: nowrap;
        }
        .hr-ptb-arrow { font-size: .7rem; line-height: 1; }
        .hr-ptb-arrow--up { color: var(--color-green,#26a69a); }
        .hr-ptb-arrow--down { color: var(--color-red,#ef5350); }
        .hr-ptb-here {
          font-size: .6rem;
          font-weight: 800;
          letter-spacing: .3px;
          white-space: nowrap;
        }
        .hr-ttc {
          display: block;
          text-align: center;
          font-size: .7rem;
          font-weight: 600;
          color: var(--color-text-muted,#888);
          padding: 4px 0 2px;
        }
        .hr-ttc--fast { color: #f59e0b; animation: hr-blink 1s infinite; }
        @keyframes hr-pulse-badge { 0% { opacity: 0.8; } 50% { opacity: 1; transform: scale(1.05); } 100% { opacity: 0.8; } }
        @keyframes hr-blink { 0%,100%{opacity:1} 50%{opacity:.4} }
        .hr-grok {
          margin: 8px 10px 6px;
          padding: 8px 10px;
          border-radius: 8px;
          background: linear-gradient(180deg, rgba(138,109,255,0.12), rgba(255,255,255,0.03));
          border: 1px solid rgba(138,109,255,0.35);
        }
        .hr-grok-hdr {
          font-size: 0.65rem;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #a5b4fc;
          margin-bottom: 4px;
        }
        .hr-grok-row { margin-top: 4px; font-size: 0.78rem; }
        .hr-grok-label {
          font-size: 0.62rem;
          font-weight: 700;
          color: var(--color-text-muted,#888);
          text-transform: uppercase;
          margin-right: 6px;
        }
        .hr-grok-call { font-weight: 800; margin-right: 6px; }
        .hr-grok-meta { font-size: 0.72rem; color: var(--color-text-muted,#aaa); }
        .hr-grok-notes {
          font-size: 0.7rem;
          color: var(--color-text,#ccc);
          margin-top: 2px;
          line-height: 1.3;
        }
        .hr-empty {
          padding: 16px 12px;
          font-size: .8rem;
          color: var(--color-text-muted,#888);
          text-align: center;
        }
      </style>`;
  }

  // ── Render (Flicker-Free with Scroll Preservation) ───────────────
  let _renderScheduled = false;

  function render() {
    if (!isActive()) return;
    if (_renderScheduled) return;
    _renderScheduled = true;

    requestAnimationFrame(() => {
      _renderScheduled = false;
      if (!isActive()) return;
      const container = document.getElementById('content');
      if (!container) return;

      // Preserve page scroll position across re-renders
      const savedScrollTop = container.scrollTop;

      container.innerHTML = buildPanelHTML();
      _mounted = true;

      // Restore page scroll position seamlessly
      container.scrollTop = savedScrollTop;
    });
  }

  // ── Load all coins (parallelized per coin) ─────────────────────
  async function loadAll() {
    await Promise.allSettled([
      loadModelStrikes(),
      ...COINS.flatMap(sym => [loadCoin(sym), loadRealLadder(sym)]),
    ]);
  }

  function nextPollMs() {
    // Check if any close time is within the fast window
    const now = Date.now();
    for (const iso of Object.values(_closeTimes)) {
      const ms = Date.parse(iso) - now;
      if (ms > 0 && ms < FAST_WINDOW_MS) return POLL_FAST_MS;
      if (ms > 0 && ms < HALF_WINDOW_MS) return POLL_HALF_MS;
    }
    return POLL_NORMAL_MS;
  }

  // ── Start auto-load loop ───────────────────────────────────────
  async function startAutoLoad() {
    if (_timer) { clearTimeout(_timer); _timer = null; }

    // Render placeholder immediately
    render();

    const tick = async () => {
      if (!isActive()) { _timer = null; return; }
      try {
        await loadAll();
        render();
      } catch (e) {
        console.warn('[HR] tick error:', e.message);
      }
      if (!isActive()) { _timer = null; return; }
      const delay = nextPollMs();
      _timer = setTimeout(tick, delay);
    };

    // First load
    await tick();
  }

  function stopAutoLoad() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
  }

  // ── Public API ─────────────────────────────────────────────────
  window.HourlyRangesPanel = {
    startAutoLoad,
    stopAutoLoad,
    render,
    load: loadAll,
    getRanges: (sym) => {
      const r = _ranges[sym] || [];
      const p60 = get60mContract(sym);
      const lockedPtb = Number(p60 && p60.priceToBeatNum);
      // Once the hourly contract is open, the ladder is locked to that PTB.
      if (Number.isFinite(lockedPtb) && lockedPtb > 0 && r.length) return r;
      const p = (Number.isFinite(lockedPtb) && lockedPtb > 0) ? lockedPtb : (_prices[sym] || readLivePrice(sym));
      if (p && Number.isFinite(p) && p > 0) {
        if (!r.length) return buildSpotCenteredRanges(sym, p);
        const nearest = r.reduce((best, item) => Math.min(best, Math.abs((item.low + item.high) / 2 - p)), Infinity);
        if (nearest > p * 0.04) {
          return buildSpotCenteredRanges(sym, p);
        }
      }
      return r;
    },
    getPrice:  (sym) => _prices[sym] || null,
    get60mMarket: get60mContract,
  };

  console.log('[HourlyRangesPanel v9] ✓ Ready');
})();
