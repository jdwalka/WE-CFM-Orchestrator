// ================================================================
// WE|||CRYPTO — Hourly Ranges Panel v6 (Clean Rewrite)
//
// Fetches live range contracts from Kalshi /markets?series_ticker=KX*
// Shows 10-15 scrollable buckets centered on current price.
// Polls every 30s, accelerates to every 10s in final 10 mins of hour.
// ================================================================

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────
  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const COINBASE_EXCH_BASE = 'https://api.exchange.coinbase.com';
  const INSTRUMENTS = {
    BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD',
    XRP: 'XRPUSD', DOGE: 'DOGEUSD',
  };

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

  const SERIES = {
    BTC: 'KXBTC', ETH: 'KXETH', SOL: 'KXSOLE',
    XRP: 'KXXRP', DOGE: 'KXDOGE',
  };

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
    XRP: '#00aae4', DOGE: '#c2a633',
  };
  const VISIBLE_BUCKETS = 11;   // 5 above + current + 5 below
  const POLL_NORMAL_MS  = 10000;  // First 30 mins (10s)
  const POLL_HALF_MS    = 5000;   // Last 30 mins (5s)
  const POLL_FAST_MS    = 2500;   // Last 15 mins (2.5s)
  const HALF_WINDOW_MS  = 30 * 60 * 1000;
  const FAST_WINDOW_MS  = 15 * 60 * 1000;
  const CACHE_TTL_MS    = 2000;   // Allow 2.5s fast-polling

  // ── State ──────────────────────────────────────────────────────
  let _prices  = {}; // sym → number
  let _ranges  = {}; // sym → [{ low, high, yesAsk, yesBid, yesAsk%, closeTime }]
  let _closeTimes = {}; // sym → ISO string of active bucket
  let _apiCache = {}; // seriesTicker → { ts, markets[] }
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
        if (res && typeof res.json === 'function') return await race(res.json());
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

  // ── Spot-Centered Range Synthesizer (for misaligned Kalshi API strikes) ──
  function getStepSize(sym, refPrice) {
    if (sym === 'BTC' || refPrice >= 20000) return 100;
    if (sym === 'ETH' || (refPrice >= 1000 && refPrice < 20000)) return 10;
    if (sym === 'SOL' || (refPrice >= 50 && refPrice < 1000)) return 0.5;
    if (sym === 'BNB') return 2;
    if (sym === 'XRP' || (refPrice >= 0.5 && refPrice < 50)) return 0.01;
    if (sym === 'DOGE' || refPrice < 0.5) return 0.005;
    return refPrice * 0.002;
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
      const tickerStr = `KX${sym}-SPOT-${low}`;

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

  // ── Strike / market helpers ────────────────────────────────────
  function isBetweenMarket(m) {
    if (!m) return false;
    if (m.strike_type === 'between') return true;
    if (m.strike_type === 'custom' && m.custom_strike?.strike_type === 'between') return true;
    const sub = String(m.yes_sub_title || m.subtitle || '').toLowerCase();
    return sub.includes(' to ') || sub.includes('between');
  }

  function parseStrikeBounds(m) {
    const cs = m.custom_strike || {};
    const floorStrike = m.floor_strike != null ? parseFloat(m.floor_strike) : NaN;
    const floorPrice = m.floor_price != null ? parseFloat(m.floor_price) : NaN;
    const capStrike = m.cap_strike != null ? parseFloat(m.cap_strike) : NaN;
    const capPrice = m.cap_price != null ? parseFloat(m.cap_price) : NaN;
    const csFloor = cs.floor_strike != null ? parseFloat(cs.floor_strike) : NaN;
    const csCap = cs.cap_strike != null ? parseFloat(cs.cap_strike) : NaN;

    let low = Number.isFinite(floorStrike) && floorStrike > 0 ? floorStrike
      : Number.isFinite(floorPrice) && floorPrice > 0 ? floorPrice
        : Number.isFinite(csFloor) && csFloor > 0 ? csFloor : NaN;
    let high = Number.isFinite(capStrike) && capStrike > 0 ? capStrike
      : Number.isFinite(capPrice) && capPrice > 0 ? capPrice
        : Number.isFinite(csCap) && csCap > 0 ? csCap : NaN;

    if ((!Number.isFinite(low) || !Number.isFinite(high)) && m.yes_sub_title) {
      const nums = String(m.yes_sub_title).replace(/[$,]/g, '').match(/\d+(?:\.\d+)?/g) || [];
      if (nums.length >= 2) {
        low = parseFloat(nums[0]);
        high = parseFloat(nums[1]);
      }
    }

    return { low, high };
  }

  function normalizeStrikeScale(low, high, refPrice) {
    if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(refPrice) || refPrice <= 0) {
      return { low, high };
    }
    const mid = (low + high) / 2;
    if (mid > refPrice * 12) return { low: low / 100, high: high / 100 };
    return { low, high };
  }

  function parseCloseMs(closeTime) {
    const ms = Date.parse(closeTime);
    return Number.isFinite(ms) ? ms : null;
  }

  function readLivePrice(sym) {
    const instrument = INSTRUMENTS[sym];
    const ticker = instrument
      ? (window.tickers?.[instrument] || window._appTickers?.[instrument])
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

    const pred = window._predictions?.[sym]?.price;
    if (pred && Number.isFinite(+pred) && +pred > 0) return +pred;

    return null;
  }

  // ── Live price fetcher ─────────────────────────────────────────
  async function fetchPrice(sym) {
    const cached = readLivePrice(sym);
    if (cached !== null) return cached;

    try {
      const d = await apiFetch(`${COINBASE_EXCH_BASE}/products/${CB_PRODUCTS[sym]}/ticker`, 8000);
      if (d?.price) {
        const p = parseFloat(d.price);
        if (Number.isFinite(p) && p > 0) return p;
      }
    } catch (e) { console.warn(`[HR] Coinbase exchange ticker failed for ${sym}:`, e.message); }

    const kt = KRAKEN_TICKERS[sym];
    if (kt) {
      try {
        const d = await apiFetch(`${KRAKEN_BASE}/Ticker?pair=${kt}`, 8000);
        const c = d?.result?.[kt]?.c;
        if (c) {
          const p = parseFloat(c[0]);
          if (Number.isFinite(p) && p > 0) return p;
        }
      } catch (e) { console.warn(`[HR] Kraken price fetch failed for ${sym}:`, e.message); }
    }

    return readLivePrice(sym);
  }

  // ── Kalshi market fetcher ──────────────────────────────────────
  async function fetchKalshiMarkets(seriesTicker) {
    const now = Date.now();
    const cached = _apiCache[seriesTicker];
    if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.markets;

    if (window.EndpointTransport?.fetchKalshiMarkets) {
      try {
        const data = await window.EndpointTransport.fetchKalshiMarkets({
          series_ticker: seriesTicker,
          status: 'open',
          limit: 1000,
        });
        const markets = Array.isArray(data?.markets) ? data.markets : [];
        _apiCache[seriesTicker] = { ts: now, markets };
        return markets;
      } catch (e) {
        console.warn(`[HR] Kalshi transport error ${seriesTicker}:`, e.message);
      }
    }

    // Fetch up to 1000 markets for this series
    const url = `${KALSHI_BASE}/markets?series_ticker=${seriesTicker}&status=open&limit=1000`;
    try {
      const data = await apiFetch(url, 25000);
      const markets = Array.isArray(data?.markets) ? data.markets : [];
      _apiCache[seriesTicker] = { ts: now, markets };
      return markets;
    } catch (e) {
      console.warn(`[HR] Kalshi fetch error ${seriesTicker}:`, e.message);
      return cached?.markets || [];
    }
  }

  // ── 15M Kalshi market fetcher ──────────────────────────────────
  const _kalshi15mMarkets = {}; // sym → market object

  async function fetchKalshi15mMarket(sym) {
    const seriesTicker = `KX${sym}15M`;
    const now = Date.now();
    try {
      const markets = await fetchKalshiMarkets(seriesTicker);
      if (Array.isArray(markets) && markets.length) {
        const active = markets.find(m => {
          const closeMs = parseCloseMs(m.close_time);
          return closeMs && closeMs > now;
        }) || markets[0];
        if (active) {
          _kalshi15mMarkets[sym] = active;
          return active;
        }
      }
    } catch (e) {
      console.warn(`[HR] Kalshi 15m fetch error ${sym}:`, e.message);
    }
    return _kalshi15mMarkets[sym] || null;
  }

  // ── Pick the best close-time bucket ───────────────────────────
  // Price-aware: choose the hour whose strike ladder best matches live spot.
  function pickCloseBucket(markets, refPrice) {
    const now = Date.now();
    const byClose = new Map();

    for (const m of markets) {
      if (!isBetweenMarket(m)) continue;
      const closeMs = parseCloseMs(m.close_time);
      if (closeMs == null || closeMs <= now - 75_000) continue; // Allow 75s grace window for clock drift / 60s close lock
      if (closeMs > now + 6 * 3600 * 1000) continue; // Filter out far future series (>6h)

      let entry = byClose.get(closeMs);
      if (!entry) {
        entry = {
          closeMs,
          count: 0,
          maxProb: 0,
          isActive: false,
          lows: [],
          highs: [],
        };
        byClose.set(closeMs, entry);
      }
      entry.count++;

      const openMs = parseCloseMs(m.open_time);
      if (openMs != null && openMs <= now && closeMs > now) entry.isActive = true;

      const { low, high } = parseStrikeBounds(m);
      const scaled = normalizeStrikeScale(low, high, refPrice);
      if (Number.isFinite(scaled.low) && Number.isFinite(scaled.high) && scaled.high >= scaled.low) {
        entry.lows.push(scaled.low);
        entry.highs.push(scaled.high);
      }

      const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
      const yesBid = parseFloat(m.yes_bid_dollars) || 0;
      const prob = yesAsk > 0 && yesBid > 0 ? (yesAsk + yesBid) / 2 : (yesAsk || yesBid);
      if (prob > entry.maxProb) entry.maxProb = prob;
    }

    const entries = [...byClose.values()];
    if (!entries.length) return null;

    const scoreEntry = (entry) => {
      let score = 0;
      const minsToClose = (entry.closeMs - now) / 60_000;

      if (Number.isFinite(refPrice) && refPrice > 0 && entry.lows.length) {
        let bestDist = Infinity;
        let contains = false;
        for (let i = 0; i < entry.lows.length; i++) {
          const low = entry.lows[i];
          const high = entry.highs[i];
          if (refPrice >= low && refPrice <= high) contains = true;
          const mid = (low + high) / 2;
          bestDist = Math.min(bestDist, Math.abs(mid - refPrice));
        }
        // Heavy penalty for buckets whose price strikes are misaligned (>10% off from spot)
        if (bestDist > refPrice * 0.10) {
          score += 50_000_000 + bestDist * 1000;
        } else {
          score += bestDist * 10;
        }
        if (contains) score -= 1_000_000;
      } else {
        score += 50_000;
      }

      if (entry.isActive) score -= 500_000;
      score += minsToClose * 2;
      return score;
    };

    entries.sort((a, b) => scoreEntry(a) - scoreEntry(b));
    return entries[0].closeMs;
  }

  // ── Build range list for a coin ────────────────────────────────
  async function loadCoin(sym) {
    const series = SERIES[sym];
    if (!series) return;

    const [markets, price, m15] = await Promise.allSettled([
      fetchKalshiMarkets(series),
      fetchPrice(sym),
      fetchKalshi15mMarket(sym),
    ]).then(([m, p, k15]) => [
      m.status === 'fulfilled' ? m.value : [],
      p.status === 'fulfilled' ? p.value : readLivePrice(sym),
      k15.status === 'fulfilled' ? k15.value : null,
    ]);

    // Store price
    if (price !== null && Number.isFinite(price)) {
      _prices[sym] = price;
    }

    if (!markets.length) return;

    const refPrice = _prices[sym] ?? price;

    // Pick close time (returns milliseconds timestamp)
    const closeTimeMs = pickCloseBucket(markets, refPrice);
    if (closeTimeMs) {
      _closeTimes[sym] = new Date(closeTimeMs).toISOString();
    }

    // Filter to chosen close bucket, 'between' only
    const buckets = markets.filter(m => {
      if (!isBetweenMarket(m)) return false;
      if (!closeTimeMs) return true;
      return parseCloseMs(m.close_time) === closeTimeMs;
    });

    // Map to our format
    const ranges = buckets.map(m => {
      let { low, high } = parseStrikeBounds(m);
      ({ low, high } = normalizeStrikeScale(low, high, refPrice));
      const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
      const yesBid = parseFloat(m.yes_bid_dollars) || 0;
      const prob = yesAsk > 0 && yesBid > 0 ? (yesAsk + yesBid) / 2 : (yesAsk || yesBid);
      return {
        low,
        high,
        yesAsk,
        yesBid,
        noAsk: parseFloat(m.no_ask_dollars) || 0,
        prob,
        ticker: m.ticker,
        closeTime: m.close_time,
        subtitle: m.yes_sub_title || '',
      };
    }).filter(r => Number.isFinite(r.low) && Number.isFinite(r.high) && r.high >= r.low);

    ranges.sort((a, b) => a.low - b.low);
    _ranges[sym] = ranges;

    if (Number.isFinite(refPrice) && refPrice > 0) {
      const nearestDist = ranges.length ? ranges.reduce((best, r) => {
        const mid = (r.low + r.high) / 2;
        return Math.min(best, Math.abs(mid - refPrice));
      }, Infinity) : Infinity;
      if (!ranges.length || nearestDist > refPrice * 0.04) {
        console.warn(`[HR] ${sym} ladder misaligned (spot $${refPrice.toFixed(2)}, nearest off by $${nearestDist.toFixed(2)}) — synthesizing spot-centered hourly range ladder`);
        _ranges[sym] = buildSpotCenteredRanges(sym, refPrice, _closeTimes[sym]);
      }
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
          const mid = (ranges[i].low + ranges[i].high) / 2;
          const d = Math.abs(mid - currentPrice);
          if (d < best) { best = d; pivotIdx = i; }
        }
      }
    }

    if (pivotIdx === -1) {
      // Default: bucket with highest probability
      let bestProb = -1;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges[i].prob > bestProb) { bestProb = ranges[i].prob; pivotIdx = i; }
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
    const ranges  = _ranges[sym] || [];
    const price   = _prices[sym];
    const color   = COIN_COLORS[sym];
    const ctISO   = _closeTimes[sym] || (ranges[0]?.closeTime);
    const ttc     = ctISO ? timeToClose(ctISO) : null;
    const ttcMs   = ctISO ? Date.parse(ctISO) - Date.now() : null;
    const isFinal = ttcMs !== null && ttcMs < FAST_WINDOW_MS;

    const priceStr = price ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—';

    let body;
    let topBuckets = [];

    if (!ranges.length) {
      body = `<div class="hr-empty">Loading market data…</div>`;
    } else {
      const visible = selectVisible(ranges, price);
      const total = visible.reduce((s, r) => s + Math.max(0, r.prob), 0) || 1;

      // Multi-bucket likelihood calculation (2-5 buckets)
      const step = getStepSize(sym, price || 1);
      const ranked = visible.map(r => {
        const mid = (r.low + r.high) / 2;
        const distSteps = price ? Math.abs(mid - price) / step : 0;
        const likelihood = Math.exp(-distSteps * distSteps * 0.45) * Math.max(0.05, r.prob || 0.3);
        return { ...r, likelihood };
      }).sort((a, b) => b.likelihood - a.likelihood);

      const sumL = ranked.reduce((s, b) => s + b.likelihood, 0) || 1;
      ranked.forEach(b => {
        b.pctLikely = Math.round((b.likelihood / sumL) * 100);
      });
      topBuckets = ranked.slice(0, 5);

      const rankMap = new Map();
      topBuckets.slice(0, 3).forEach((b, idx) => {
        rankMap.set(b.low, { rank: idx + 1, pct: b.pctLikely });
      });

      const rows = visible.map(r => {
        const isCurrent = price !== null && price >= r.low && price <= r.high;
        const rInfo     = rankMap.get(r.low);
        const probNorm  = r.prob / total;
        const barW      = Math.max(2, Math.round(probNorm * 100));
        const probPctStr = fmtPct(r.prob);

        let badgeHtml = '';
        if (isCurrent) {
          const herePct = rInfo ? `${rInfo.pct}%` : probPctStr;
          badgeHtml = `<span class="hr-row-badge" style="background:${color};color:#000;font-weight:800;padding:2px 6px;border-radius:4px;margin-left:auto;">● HERE (${herePct})</span>`;
        } else if (rInfo) {
          badgeHtml = `<span class="hr-row-badge-rank" style="background:rgba(0,212,170,0.15);color:var(--color-accent,#00d4aa);font-size:10px;padding:2px 5px;border-radius:3px;margin-left:auto;font-weight:700;">🎯 #${rInfo.rank} (${rInfo.pct}%)</span>`;
        }

        return `
          <div class="hr-row${isCurrent ? ' hr-row--current' : ''}">
            <div class="hr-row-bar" style="width:${barW}%;background:${isCurrent ? color : 'rgba(255,255,255,0.12)'}"></div>
            <span class="hr-row-range">${fmtPrice(r.low, r.high)}</span>
            <span class="hr-row-prob" style="${isCurrent ? `color:${color}` : ''}">${probPctStr}</span>
            ${badgeHtml}
          </div>`;
      });

      const closeLabel = ttc
        ? `<span class="hr-ttc${isFinal ? ' hr-ttc--fast' : ''}">Closes in ${ttc}</span>`
        : '';

      body = `
        <div class="hr-ranges-scroll">
          <div class="hr-ranges-header">
            <span class="hr-ranges-label">Range</span>
            <span class="hr-ranges-label">Prob (YES)</span>
          </div>
          ${rows.join('')}
        </div>
        ${closeLabel}`;
    }

    // Grok 15m + hourly call pegged to Kalshi ranges (no 5m, never WAIT)
    let grokHtml = '';
    try {
      const api = window.GrokRangeOverlay || window.GrokRangeGrok;
      const g15 = api && api.getGuidance ? api.getGuidance(sym, 15) : null;
      const g60 = api && api.getGuidance ? api.getGuidance(sym, 60) : null;
      const renderOne = (label, g) => {
        if (!g) return '';
        if (g.error && !g.call) {
          return `<div class="hr-grok-row"><span class="hr-grok-label">${label}</span>
            <span class="hr-grok-meta" style="color:var(--color-orange,#f59e0b)">${g.error}</span></div>`;
        }
        if (!g.call) return '';
        const call = g.call === 'DOWN' ? 'DOWN' : 'UP';
        const col = call === 'UP' ? 'var(--color-green,#26a69a)' : 'var(--color-red,#ef5350)';
        const confRaw = Number(g.confidence) || 0;
        const pct = confRaw <= 1 ? Math.round(confRaw * 100) : Math.round(confRaw);

        let metaLine = `${pct}%`;
        let notes = String(g.notes || '').slice(0, 180);

        if (label === '15m contract') {
          const peg15 = g.kalshiPeg || g.kalshi15m;
          const ticker = g.contractTicker || (peg15 && peg15.ticker) || '';
          const side = peg15 && peg15.side ? peg15.side : (call === 'UP' ? 'YES' : 'NO');
          const floor = peg15 && (peg15.floorPrice ?? peg15.targetPriceNum);
          const strikePrice = floor ? `$${Number(floor).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : (priceStr !== '—' ? priceStr : '');
          if (ticker) metaLine += ` · ${ticker} buy ${side}`;
          if (strikePrice) metaLine += ` · strike ${strikePrice}`;
          if (peg15 && peg15.strikeDir) metaLine += ` (${peg15.strikeDir})`;
          if (peg15 && peg15.yesProb != null) metaLine += ` · mkt YES ${(Number(peg15.yesProb) * 100).toFixed(0)}%`;
          if (peg15 && peg15.secondsToClose != null) metaLine += ` · ttc ${peg15.secondsToClose}s`;
        } else {
          // 1h range — Top 2-5 Multi-Bucket Likelihood
          if (topBuckets.length) {
            const top3Str = topBuckets.slice(0, 3).map((b, i) => `#${i+1} $${b.low}–$${b.high} (${b.pctLikely}%)`).join(' · ');
            metaLine += ` · Top Ranges: ${top3Str}`;
          } else {
            const spot = _prices[sym] || readLivePrice(sym);
            let rangeObj = g.preferredRange || g.range;
            if (rangeObj && Number.isFinite(Number(rangeObj.low))) {
              metaLine += ` · bucket $${Number(rangeObj.low).toLocaleString()}–$${Number(rangeObj.high).toLocaleString()}`;
            }
          }

          if (/bucket\s+\$?\d+/i.test(notes) || /KXBTC|KXETH/i.test(notes)) {
            notes = ''; // Wipe stale text containing old tickers
          }
        }

        return `<div class="hr-grok-row">
          <span class="hr-grok-label">${label}</span>
          <span class="hr-grok-call" style="color:${col}">${call === 'UP' ? '▲' : '▼'} price ${call}</span>
          <span class="hr-grok-meta">${metaLine}</span>
          ${notes ? `<div class="hr-grok-notes">${notes}</div>` : ''}
        </div>`;
      };
      const b15 = renderOne('15m contract', g15);
      const b60 = renderOne('1h range', g60);
      if (b15 || b60) {
        grokHtml = `<div class="hr-grok">
          <div class="hr-grok-hdr">🤖 Grok (xAI) · Kalshi-pegged</div>
          ${b15}${b60}
        </div>`;
      } else {
        const stats = window.GrokAnalyticsMemory && window.GrokAnalyticsMemory.getStats
          ? window.GrokAnalyticsMemory.getStats() : null;
        const n = stats && stats.byCoin && stats.byCoin[sym] ? stats.byCoin[sym].samples : 0;
        grokHtml = `<div class="hr-grok"><div class="hr-grok-hdr">🤖 Grok (xAI)</div>
          <div class="hr-grok-notes">Building memory… ${n} samples · 15m/1h calls soon</div></div>`;
      }
    } catch (_) { grokHtml = ''; }

    // Polymarket 15m Up/Down — pulled by prediction-markets.js refreshPoly15M().
    // User no longer trades Kalshi's range buckets, so this is the primary
    // block on the card now; Kalshi ranges/Grok stay below as reference.
    // Probability/PTB text is shown only when the venue has actually published
    // it for this window; the embed itself renders whatever Polymarket shows,
    // live, straight from the venue -- never a guess.
    let poly15mHtml = '';
    try {
      const p15 = window.PredictionMarkets?.getCoin?.(sym)?.poly15m;
      if (p15 && p15.slug) {
        const upProb = Number(p15.probability);
        const hasProb = Number.isFinite(upProb);
        const call = hasProb ? (upProb >= 0.5 ? 'UP' : 'DOWN') : null;
        const col = call === 'UP' ? 'var(--color-green,#26a69a)' : call === 'DOWN' ? 'var(--color-red,#ef5350)' : 'var(--color-text-faint)';
        const ptbNum = Number(p15.priceToBeatNum ?? p15.targetPriceNum);
        const ptbLabel = p15.targetPrice || (Number.isFinite(ptbNum) && ptbNum > 0
          ? `$${ptbNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}` : 'pending');
        const closeLabel15 = p15.closeTime ? timeToClose(p15.closeTime) : null;
        poly15mHtml = `<div class="hr-poly15m" style="margin-bottom:8px;">
          <div class="hr-grok-hdr">Polymarket 15m Up/Down</div>
          <iframe
            title="${sym} Up or Down 15m — Polymarket"
            src="https://embed.polymarket.com/market?market=${encodeURIComponent(p15.slug)}&theme=dark&border=false&creator=JohnDaWalka&height=220"
            style="width:100%;height:220px;border:0;border-radius:6px;display:block;margin-top:4px;"
            frameborder="0"
            allowtransparency="true"
            loading="lazy"></iframe>
          <div class="hr-grok-row" style="margin-top:4px;">
            <span class="hr-grok-call" style="color:${col}">${hasProb ? `${call === 'UP' ? '▲' : '▼'} ${Math.round(upProb * 100)}% YES` : 'awaiting odds'}</span>
            <span class="hr-grok-meta">PTB ${ptbLabel}${closeLabel15 ? ` · closes ${closeLabel15}` : ''}</span>
          </div>
          <a href="https://polymarket.com/event/${encodeURIComponent(p15.slug)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:3px;font-size:10px;color:var(--color-text-faint);text-decoration:none;">Open on Polymarket ↗</a>
        </div>`;
      }
    } catch (_) { poly15mHtml = ''; }

    return `
      <div class="hr-card">
        <div class="hr-card-header">
          <span class="hr-sym" style="color:${color}">${sym}</span>
          <span class="hr-price">${priceStr}</span>
        </div>
        <div class="hr-card-body">${poly15mHtml}${body}${grokHtml}</div>
      </div>`;
  }

  // ── Build full panel HTML ──────────────────────────────────────
  function buildPanelHTML() {
    const now = new Date().toLocaleTimeString();
    return `
      <div class="hr-panel" id="hourly-ranges-panel">
        <div class="hr-panel-hdr">
          <h2 class="hr-panel-title">⏱ Kalshi Hourly Ranges + Grok 15m/1h</h2>
          <span class="hr-panel-updated">Updated ${now} · Grok pegs to ladder buckets (UP/DOWN only)</span>
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
          max-height: 340px;
          overflow-y: auto;
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

      // Preserve scroll positions of range tables
      const scrollEls = container.querySelectorAll('.hr-ranges-scroll');
      const scrollPosMap = [];
      scrollEls.forEach((el, idx) => {
        scrollPosMap[idx] = el.scrollTop;
      });

      container.innerHTML = buildPanelHTML();
      _mounted = true;

      // Restore scroll positions seamlessly
      const newScrollEls = container.querySelectorAll('.hr-ranges-scroll');
      newScrollEls.forEach((el, idx) => {
        if (scrollPosMap[idx] != null) {
          el.scrollTop = scrollPosMap[idx];
        }
      });
    });
  }

  // ── Load all coins (parallelized per coin) ─────────────────────
  async function loadAll() {
    await Promise.allSettled(COINS.map(sym => loadCoin(sym)));
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
      const p = _prices[sym] || readLivePrice(sym);
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
    get15mMarket: (sym) => _kalshi15mMarkets[sym] || null,
  };

  console.log('[HourlyRangesPanel v7] ✓ Ready');
})();
