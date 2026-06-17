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
  const COINBASE_BASE = 'https://api.coinbase.com/api/v3/brokerage/market';
  const KRAKEN_BASE = 'https://api.kraken.com/0/public';

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

  const SERIES = {
    BTC: 'KXBTC', ETH: 'KXETH', SOL: 'KXSOLE',
    XRP: 'KXXRP', DOGE: 'KXDOGE',
  };

  const CB_PRODUCTS = {
    BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD',
    XRP: 'XRP-USD', DOGE: 'DOGE-USD',
  };

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

  // ── Live price fetcher ─────────────────────────────────────────
  async function fetchPrice(sym) {
    // 1. Coinbase
    try {
      const d = await apiFetch(`${COINBASE_BASE}/products/${CB_PRODUCTS[sym]}`, 20000);
      if (d?.price) return parseFloat(d.price);
    } catch (e) { console.warn(`[HR] Coinbase price fetch failed for ${sym}:`, e.message); }

    // 2. Kraken
    const kt = KRAKEN_TICKERS[sym];
    if (kt) {
      try {
        const d = await apiFetch(`${KRAKEN_BASE}/Ticker?pair=${kt}`, 20000);
        const c = d?.result?.[kt]?.c;
        if (c) return parseFloat(c[0]);
      } catch (e) { console.warn(`[HR] Kraken price fetch failed for ${sym}:`, e.message); }
    }

    // 3. Cached from window._predictions
    const p = window._predictions?.[sym]?.price;
    if (p && Number.isFinite(+p)) return +p;

    return null;
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

  // ── Pick the best close-time bucket ───────────────────────────
  // Prefers: active (open now) with most contracts; or next upcoming
  function pickCloseBucket(markets) {
    const now = Date.now();
    const byClose = new Map();

    for (const m of markets) {
      const isBetween = m.strike_type === 'between' || (m.strike_type === 'custom' && m.custom_strike?.strike_type === 'between');
      if (!isBetween) continue;
      const closeMs = Date.parse(m.close_time);
      if (!Number.isFinite(closeMs)) continue;

      let entry = byClose.get(closeMs);
      if (!entry) {
        entry = { closeMs, count: 0, maxProb: 0, isActive: false };
        byClose.set(closeMs, entry);
      }
      entry.count++;

      const openMs = Date.parse(m.open_time);
      if (Number.isFinite(openMs) && openMs <= now && closeMs > now) {
        entry.isActive = true;
      }

      const prob = parseFloat(m.yes_ask_dollars) || 0;
      if (prob > entry.maxProb) entry.maxProb = prob;
    }

    const entries = [...byClose.values()].filter(e => e.closeMs > now);
    if (!entries.length) return null;

    // Prefer active bucket; among actives, the soonest close time
    const active = entries.filter(e => e.isActive);
    const pool = active.length ? active : entries;
    pool.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.closeMs - b.closeMs; // soonest first
    });

    // Return the chosen closeMs as a number so we can compare by timestamp
    return pool[0].closeMs;
  }

  // ── Build range list for a coin ────────────────────────────────
  async function loadCoin(sym) {
    const series = SERIES[sym];
    if (!series) return;

    const [markets, price] = await Promise.allSettled([
      fetchKalshiMarkets(series),
      fetchPrice(sym),
    ]).then(([m, p]) => [
      m.status === 'fulfilled' ? m.value : [],
      p.status === 'fulfilled' ? p.value : null,
    ]);

    // Store price
    if (price !== null && Number.isFinite(price)) {
      _prices[sym] = price;
    }

    if (!markets.length) return;

    // Pick close time (returns milliseconds timestamp)
    const closeTimeMs = pickCloseBucket(markets);
    if (closeTimeMs) {
      // Store as ISO string for display, but compare by ms
      _closeTimes[sym] = new Date(closeTimeMs).toISOString();
    }

    // Filter to chosen close bucket, 'between' only — compare by parsed timestamp
    const buckets = markets.filter(m => {
      const isBetween = m.strike_type === 'between' || (m.strike_type === 'custom' && m.custom_strike?.strike_type === 'between');
      if (!isBetween) return false;
      if (!closeTimeMs) return true;
      return Date.parse(m.close_time) === closeTimeMs;
    });

    // Map to our format
    const ranges = buckets.map(m => ({
      low:      parseFloat(m.floor_strike || m.custom_strike?.floor_strike),
      high:     parseFloat(m.cap_strike || m.custom_strike?.cap_strike),
      yesAsk:   parseFloat(m.yes_ask_dollars) || 0,
      yesBid:   parseFloat(m.yes_bid_dollars) || 0,
      noAsk:    parseFloat(m.no_ask_dollars) || 0,
      prob:     parseFloat(m.yes_ask_dollars) || 0,   // treat yes_ask as market probability
      ticker:   m.ticker,
      closeTime: m.close_time,
      subtitle: m.yes_sub_title || '',
    })).filter(r => Number.isFinite(r.low) && Number.isFinite(r.high));

    ranges.sort((a, b) => a.low - b.low);
    _ranges[sym] = ranges;
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
    if (!Number.isFinite(ms) || ms <= 0) return null;
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
    if (!ranges.length) {
      body = `<div class="hr-empty">Loading market data…</div>`;
    } else {
      const visible = selectVisible(ranges, price);

      // Normalize probabilities among visible set so they sum visually well
      const total = visible.reduce((s, r) => s + Math.max(0, r.prob), 0) || 1;

      const rows = visible.map(r => {
        const isCurrent = price !== null && price >= r.low && price <= r.high;
        const probNorm  = r.prob / total;
        const barW      = Math.max(2, Math.round(probNorm * 100));

        return `
          <div class="hr-row${isCurrent ? ' hr-row--current' : ''}">
            <div class="hr-row-bar" style="width:${barW}%;background:${isCurrent ? color : 'rgba(255,255,255,0.12)'}"></div>
            <span class="hr-row-range">${fmtPrice(r.low, r.high)}</span>
            <span class="hr-row-prob" style="${isCurrent ? `color:${color}` : ''}">${fmtPct(r.prob)}</span>
            ${isCurrent ? `<span class="hr-row-badge" style="background:${color}">● HERE</span>` : ''}
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

    return `
      <div class="hr-card">
        <div class="hr-card-header">
          <span class="hr-sym" style="color:${color}">${sym}</span>
          <span class="hr-price">${priceStr}</span>
        </div>
        <div class="hr-card-body">${body}</div>
      </div>`;
  }

  // ── Build full panel HTML ──────────────────────────────────────
  function buildPanelHTML() {
    const now = new Date().toLocaleTimeString();
    return `
      <div class="hr-panel" id="hourly-ranges-panel">
        <div class="hr-panel-hdr">
          <h2 class="hr-panel-title">⏱ Kalshi Hourly Ranges</h2>
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
        .hr-empty {
          padding: 16px 12px;
          font-size: .8rem;
          color: var(--color-text-muted,#888);
          text-align: center;
        }
      </style>`;
  }

  // ── Render ─────────────────────────────────────────────────────
  function render() {
    if (!isActive()) return;
    const container = document.getElementById('content');
    if (!container) return;
    container.innerHTML = buildPanelHTML();
    _mounted = true;
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
    getRanges: (sym) => _ranges[sym] || [],
    getPrice:  (sym) => _prices[sym] || null,
  };

  console.log('[HourlyRangesPanel v6] ✓ Ready');
})();
