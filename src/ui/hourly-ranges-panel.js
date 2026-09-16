// ================================================================
// WE|||CRYPTO — Hourly Ranges Panel v9 (hourly ranges only)
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
  const VISIBLE_BUCKETS = 11;   // 5 above + current + 5 below
  const POLL_NORMAL_MS  = 10000;  // First 30 mins (10s)
  const POLL_HALF_MS    = 5000;   // Last 30 mins (5s)
  const POLL_FAST_MS    = 2500;   // Last 15 mins (2.5s)
  const HALF_WINDOW_MS  = 30 * 60 * 1000;
  const FAST_WINDOW_MS  = 15 * 60 * 1000;

  // ── State ──────────────────────────────────────────────────────
  let _prices  = {}; // sym → number
  let _ranges  = {}; // sym → [{ low, high, yesAsk, yesBid, yesAsk%, closeTime }]
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

  async function loadCoin(sym) {
    const price = await fetchPrice(sym);

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

    if (!ranges.length && price) {
      ranges = buildSpotCenteredRanges(sym, price, ctISO);
      Object.defineProperty(_ranges, sym, { value: ranges, writable: true, enumerable: true, configurable: true });
    }

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
          badgeHtml = `<span class="hr-row-badge" style="background:${escapeHTML(color)};color:#000;font-weight:800;padding:2px 6px;border-radius:4px;margin-left:auto;">● HERE (${escapeHTML(herePct)})</span>`;
        } else if (rInfo) {
          badgeHtml = `<span class="hr-row-badge-rank" style="background:rgba(0,212,170,0.15);color:var(--color-accent,#00d4aa);font-size:10px;padding:2px 5px;border-radius:3px;margin-left:auto;font-weight:700;">🎯 #${escapeHTML(rInfo.rank)} (${escapeHTML(rInfo.pct)}%)</span>`;
        }

        return `
          <div class="hr-row${isCurrent ? ' hr-row--current' : ''}">
            <div class="hr-row-bar" style="width:${escapeHTML(barW)}%;background:${isCurrent ? escapeHTML(color) : 'rgba(255,255,255,0.12)'}"></div>
            <span class="hr-row-range">${escapeHTML(fmtPrice(r.low, r.high))}</span>
            <span class="hr-row-prob" style="${isCurrent ? `color:${escapeHTML(color)}` : ''}">${escapeHTML(probPctStr)}</span>
            ${badgeHtml}
          </div>`;
      });

      const closeLabel = ttc
        ? `<span class="hr-ttc${isFinal ? ' hr-ttc--fast' : ''}">Closes in ${ttc}</span>`
        : '';

      body = `
        <div class="hr-ranges-scroll">
          <div class="hr-ranges-header">
            <span class="hr-ranges-label">Hourly bucket</span>
            <span class="hr-ranges-label">Prob (YES)</span>
          </div>
          ${rows.join('')}
        </div>
        ${closeLabel}`;
    }

    // ASI1 hourly bucket guidance, pegged to a fixed 60-minute interval.
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
          <div class="hr-grok-hdr">✨ ASI1 pre-contract · fixed 60m interval</div>
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
    // own directional call + reasoning on top of both.
    return `
      <div class="hr-card">
        <div class="hr-card-header">
          <span class="hr-sym" style="color:${color}">${escapeHTML(sym)}</span>
          <span class="hr-price">${escapeHTML(priceStr)}</span>
        </div>
        <div class="hr-card-body">${body}${grokHtml}</div>
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
