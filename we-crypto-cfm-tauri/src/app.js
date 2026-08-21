// ================================================================
// WE CFM Orchestrator — Application Shell
// Benchmark feeds via Crypto.com Exchange API (no key required)
// Supporting flow and wallet data via Blockscout public API
// ================================================================

(function () {
  'use strict';

  // ---- Icon cache — stores computed HTML string per symbol so each coin's
  //      img element is only constructed once and reused across re-renders ----
  const _iconCache = new Map();

  // ---- State ----
  let currentView   = 'cfm';
  let _fetchAttempted = false;  // set after first fetchAll() completes (success or fail)
  let coinFilter    = 'all';
  let chartCoin     = 'SOLUSD';
  let chartTf       = '1h';
  let sortBy        = 'volume';
  let sortDir       = -1;
  let refreshTimer  = null;
  let refreshSecs   = 15;
  let tickers       = {};         // instrument_name → ticker data
  let sparkData     = {};         // sym → [prices] for sparklines
  let candleChart   = null;       // lightweight-charts instance
  let donutChart    = null;       // Chart.js donut
  let scanRunning   = false;
  let cfmExpanded   = new Set();
  let predictionExpanded = new Set();
  let screenerSortBy = 'marketCap';
  let screenerSortDir = -1;
  let screenerMetaCache = {};
  let screenerMetaAge = 0;
  let screenerMetaPromise = null;
  let _lastGeckoSupplementalTs = 0;
  let _lastGeckoSupplementalResult = [];
  let chartResizeObserver = null;
  let chartSeries = {};
  let chartRawCandles = [];
  let chartSnapshot = null;
  let predictionRefreshHandle = null;  // { cancel() } — quarter-aligned scorer + prefetch
  let predictionRunInFlight = null;
  let orbitalAnimationFrame = null;   // rAF handle for Market Universe orbital canvas
  let _rv = 0; // render version counter — increment on every render/refresh call so stale async renders can self-cancel

  // ── Persistence keys ─────────────────────────────────────────────────────
  const PRED_LOG_STORE    = 'beta1_pred_log';
  const KALSHI_LOG_STORE  = 'beta1_kalshi_log';
  const LAST_PRED_STORE   = 'beta1_last_pred';
  const LAST_KALSHI_STORE = 'beta1_last_kalshi';

  // ── Prediction accuracy tracker ──────────────────────────────────────────
  // window._lastPrediction[sym] = { direction: 'UP'|'DOWN'|'FLAT', price, ts, signal }
  window._lastPrediction     = window._lastPrediction     || {};
  // Rolling log of evaluated results (capped at 200 entries)
  window._predLog            = window._predLog            || [];
  // Kalshi contract outcome log — builds model vs market confidence over time
  window._kalshiLog          = window._kalshiLog          || [];
  // Last Kalshi alignment snapshot per coin (for outcome evaluation on bucket close)
  window._lastKalshiSnapshot = window._lastKalshiSnapshot || {};

  // Restore persisted logs from localStorage on startup
  (function restorePersistedData() {
    try { const r = localStorage.getItem(PRED_LOG_STORE);    if (r) window._predLog            = JSON.parse(r); } catch(e) {}
    try { const r = localStorage.getItem(KALSHI_LOG_STORE);  if (r) window._kalshiLog          = JSON.parse(r); } catch(e) {}
    try { const r = localStorage.getItem(LAST_PRED_STORE);   if (r) window._lastPrediction     = JSON.parse(r); } catch(e) {}
    try { const r = localStorage.getItem(LAST_KALSHI_STORE); if (r) window._lastKalshiSnapshot = JSON.parse(r); } catch(e) {}
  })();

  function savePredLog()    { try { localStorage.setItem(PRED_LOG_STORE,    JSON.stringify(window._predLog.slice(-200)));           } catch(e) {} }
  function saveKalshiLog()  { try { localStorage.setItem(KALSHI_LOG_STORE,  JSON.stringify(window._kalshiLog.slice(-500)));         } catch(e) {} }
  function saveLastPred()   { try { localStorage.setItem(LAST_PRED_STORE,   JSON.stringify(window._lastPrediction));                } catch(e) {} }
  function saveLastKalshi() { try { localStorage.setItem(LAST_KALSHI_STORE, JSON.stringify(window._lastKalshiSnapshot));            } catch(e) {} }

  // ── Clock-aligned quarter-hour scheduler ─────────────────────────────────
  // Returns ms until the next :00/:15/:30/:45 boundary, minimum 500ms.
  function msUntilNextQuarter() {
    const now = new Date();
    const ms = (now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    const qMs = 15 * 60 * 1000;
    return Math.max(500, Math.ceil((ms + 1) / qMs) * qMs - ms);
  }
  // Calls callback at each :00/:15/:30/:45. Drift-free via recursive setTimeout.
  function scheduleOnQuarterHours(callback) {
    let _t = null;
    function tick() { callback(); _t = setTimeout(tick, msUntilNextQuarter()); }
    _t = setTimeout(tick, msUntilNextQuarter());
    return { cancel() { clearTimeout(_t); } };
  }
  const PREDICTION_HORIZONS = [1, 5, 10, 15];
  let predictionControlsExpanded = false;
  let predictionSortBy = 'quality';
  let predictionHideUnavailable = false;
  let predictionOnlyActionable = false;
  let predictionCompact = false;
  let theme = 'dark';
  const chartIndicators = { ema9: true, ema21: true, vwap: true, support: true, resistance: true, trend: true };
  const UI_STORAGE_KEY = 'we-cfm-ui-state-v1';
  const uiState = (() => {
    try {
      const raw = localStorage.getItem(UI_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  })();
  if (uiState.currentView) currentView = uiState.currentView;
  if (Number.isFinite(uiState.refreshSecs)) refreshSecs = uiState.refreshSecs;
  if (uiState.theme === 'light' || uiState.theme === 'dark') theme = uiState.theme;
  predictionControlsExpanded = !!uiState.predictionControlsExpanded;
  predictionSortBy = uiState.predictionSortBy || predictionSortBy;
  predictionHideUnavailable = !!uiState.predictionHideUnavailable;
  predictionOnlyActionable = !!uiState.predictionOnlyActionable;
  predictionCompact = !!uiState.predictionCompact;

  function persistUIState() {
    try {
      localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({
        currentView,
        refreshSecs,
        theme,
        predictionControlsExpanded,
        predictionSortBy,
        predictionHideUnavailable,
        predictionOnlyActionable,
        predictionCompact,
      }));
    } catch {}
  }
  const SCREENER_GECKO_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', LTC: 'litecoin', SOL: 'solana', AVAX: 'avalanche-2',
    DOT: 'polkadot', ATOM: 'cosmos', POL: 'polygon-ecosystem-token', ADA: 'cardano',
    XTZ: 'tezos', ARB: 'arbitrum', OP: 'optimism', SUI: 'sui', APT: 'aptos',
    SEI: 'sei-network', NEAR: 'near', BONK: 'bonk', PEPE: 'pepe', WIF: 'dogwifcoin',
    FLOKI: 'floki', JUP: 'jupiter-exchange-solana', AERO: 'aerodrome-finance',
    DYDX: 'dydx-chain', PYTH: 'pyth-network', RNDR: 'render-token', FET: 'fetch-ai',
    TAO: 'bittensor', XLM: 'stellar', LINK: 'chainlink', UNI: 'uniswap',
    AAVE: 'aave', ICP: 'internet-computer', HBAR: 'hedera-hashgraph',
    XRP: 'ripple', DOGE: 'dogecoin', HYPE: 'hyperliquid', BNB: 'binancecoin',
  };

  // ---- DOM refs ----
  const $ = (s, c) => (c || document).querySelector(s);
  const content     = $('#content');
  const feedStatus  = $('#feedStatus');
  const feedDot     = feedStatus ? feedStatus.querySelector('.pulse-dot') : null;
  const feedText    = $('#feedStatusText');
  const lastUpdate  = $('#lastUpdate');
  const pageTitle   = $('#pageTitle');

  function activateNav(view) {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    const activeBtn = document.querySelector(`.nav-btn[data-view="${view}"]`);
    if (pageTitle && activeBtn) pageTitle.textContent = activeBtn.textContent.trim();
  }

  // ---- Theme toggle ----
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  const themeBtn = $('[data-theme-toggle]');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
      persistUIState();
      themeBtn.innerHTML = theme === 'dark'
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      if (candleChart) {
        const bg = theme === 'dark' ? '#111318' : '#ffffff';
        const grid = theme === 'dark' ? '#252932' : '#dde0ea';
        candleChart.applyOptions({ layout: { background: { color: bg }, textColor: theme === 'dark' ? '#7880a0' : '#6470a0' }, grid: { vertLines: { color: grid }, horzLines: { color: grid } } });
      }
    });
  }
  activateNav(currentView);

  // ---- Sidebar nav ----
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentView = btn.dataset.view;
      activateNav(currentView);
      persistUIState();
      updateHeaderSummary();
      render();
      syncPredictionRefresh();
      // close mobile sidebar
      $('#sidebar').classList.remove('open');
    });
  });

  // ---- Mobile menu ----
  const menuBtn = $('#menuBtn');
  if (menuBtn) menuBtn.addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // ---- Refresh control ----
  const refreshBtn = $('#refreshBtn');
  const refreshSel = $('#refreshInterval');
  if (refreshBtn) refreshBtn.addEventListener('click', () => fetchAll(true));
  if (refreshSel) refreshSel.addEventListener('change', e => {
    refreshSecs = parseInt(e.target.value, 10);
    persistUIState();
    resetTimer();
  });
  if (refreshSel) refreshSel.value = String(refreshSecs);

  // ================================================================
  // API LAYER — Crypto.com Exchange public endpoints (no auth)
  // ================================================================

  const CDC_BASE = 'https://api.crypto.com/v2/public';
  const GECKO_BASE = 'https://api.coingecko.com/api/v3';
  const BIN_BASE = 'https://api.binance.com/api/v3';
  const MEXC_BASE = 'https://api.mexc.com/api/v3';
  const BIN_SYMS = { BTC:'BTCUSDT', ETH:'ETHUSDT', SOL:'SOLUSDT', XRP:'XRPUSDT', HYPE:'HYPEUSDT', DOGE:'DOGEUSDT', BNB:'BNBUSDT' };
  const MEXC_SYMS = { BTC:'BTCUSDT', ETH:'ETHUSDT', SOL:'SOLUSDT', XRP:'XRPUSDT', DOGE:'DOGEUSDT', BNB:'BNBUSDT' };

  // ---- Shared HTTP cache: prevents duplicate CDC calls across engines ----
  // CFM engine and predictions.js also hit CDC tickers.
  // This cache lets them reuse our fetch if it's fresh (<8 seconds old).
  window._sharedTickerCache = { data: null, age: 0 };

  // Normalize short-form CDC API field names to readable names
  function normalizeTicker(t) {
    return {
      instrument_name: (t.i || t.instrument_name || '').replace(/_/g, ''),
      last:            t.a  ?? t.last,
      high:            t.h  ?? t.high,
      low:             t.l  ?? t.low,
      change:          t.c  ?? t.change,
      best_bid:        t.b  ?? t.best_bid,
      best_ask:        t.k  ?? t.best_ask,
      best_bid_size:   t.bs ?? t.best_bid_size,
      best_ask_size:   t.ks ?? t.best_ask_size,
      volume:          t.v  ?? t.volume,
      volume_value:    t.vv ?? t.volume_value,
      timestamp:       t.t  ?? t.timestamp,
      source:          'crypto.com',
    };
  }

  function fetchWithTimeout(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(tid));
  }

  async function fetchTickers() {
    // Check shared cache first (may have been populated by CFM engine)
    const cache = window._sharedTickerCache;
    if (cache.data && Date.now() - cache.age < 8000) {
      return cache.data;
    }
    const res = await fetchWithTimeout(`${CDC_BASE}/get-ticker`, 8000);
    if (!res.ok) throw new Error(`Tickers HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 0) throw new Error(`Tickers error code ${json.code}`);
    const normalized = json.result.data.map(normalizeTicker);
    // Populate shared cache for other engines
    window._sharedTickerCache = { data: normalized, raw: json.result.data, age: Date.now() };
    return normalized;
  }

  function findCoinByInstrument(instrument) {
    return WATCHLIST.find(c => c.instrument === instrument)
      || PORTFOLIO_HOLDINGS.find(c => c.instrument === instrument)
      || PREDICTION_COINS.find(c => c.instrument === instrument)
      || null;
  }

  function geckoIdForInstrument(instrument) {
    const coin = findCoinByInstrument(instrument);
    if (!coin) return null;
    return coin.geckoId || SCREENER_GECKO_IDS[coin.sym] || null;
  }

  function trackedMarketCoins() {
    const byInstrument = new Map();
    [...WATCHLIST, ...PORTFOLIO_HOLDINGS, ...PREDICTION_COINS].forEach(coin => {
      if (!coin?.instrument) return;
      if (!byInstrument.has(coin.instrument)) {
        byInstrument.set(coin.instrument, { ...coin, geckoId: geckoIdForInstrument(coin.instrument) });
      }
    });
    return Array.from(byInstrument.values());
  }

  async function fetchSupplementalTickers(rawTickers) {
    const existing = new Set((rawTickers || []).map(t => t.instrument_name));
    const targets = trackedMarketCoins()
      .filter(c => !existing.has(c.instrument))
      .filter(c => c.geckoId);

    if (!targets.length) return [];

    // Bug fix: CoinGecko rate-limit guard — honour 429 errors by caching result 60s
    if (Date.now() - _lastGeckoSupplementalTs < 60_000) return _lastGeckoSupplementalResult;

    const ids = Array.from(new Set(targets.map(t => t.geckoId))).join(',');
    const res = await fetchWithTimeout(`${GECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`, 8000);
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const rows = await res.json();
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));

    const result = targets
      .map(coin => {
        const row = byId[coin.geckoId];
        if (!row) return null;
        return {
          instrument_name: coin.instrument,
          last: row.current_price ?? 0,
          high: row.high_24h ?? row.current_price ?? 0,
          low: row.low_24h ?? row.current_price ?? 0,
          change: (row.price_change_percentage_24h_in_currency ?? row.price_change_percentage_24h ?? 0) / 100,
          best_bid: null,
          best_ask: null,
          best_bid_size: '',
          best_ask_size: '',
          volume: row.total_volume ?? 0,
          volume_value: row.total_volume ?? 0,
          timestamp: Date.now(),
          source: 'coingecko',
        };
      })
      .filter(Boolean);

    _lastGeckoSupplementalTs = Date.now();
    _lastGeckoSupplementalResult = result;
    return result;
  }

  function geckoTimeframeConfig(timeframe) {
    switch (timeframe) {
      case '5m': return { days: 1, bucketMs: 5 * 60 * 1000 };
      case '15m': return { days: 1, bucketMs: 15 * 60 * 1000 };
      case '1h': return { days: 7, bucketMs: 60 * 60 * 1000 };
      case '4h': return { days: 30, bucketMs: 4 * 60 * 60 * 1000 };
      case '1W': return { days: 365, bucketMs: 7 * 24 * 60 * 60 * 1000 };
      case '1D':
      default:
        return { days: 365, bucketMs: 24 * 60 * 60 * 1000 };
    }
  }

  function averageNums(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function exchangeInterval(timeframe) {
    switch (timeframe) {
      case '1D': return '1d';
      case '1W': return '1w';
      default: return timeframe;
    }
  }

  function poolCandles(...seriesList) {
    const buckets = new Map();
    seriesList.filter(Array.isArray).forEach(series => {
      series.forEach(row => {
        const [ts, o, h, l, c, v] = row;
        if (!Number.isFinite(Number(ts))) return;
        const bucket = buckets.get(Number(ts)) || { t: Number(ts), o: [], h: [], l: [], c: [], v: [] };
        bucket.o.push(Number(o || 0));
        bucket.h.push(Number(h || 0));
        bucket.l.push(Number(l || 0));
        bucket.c.push(Number(c || 0));
        bucket.v.push(Number(v || 0));
        buckets.set(Number(ts), bucket);
      });
    });
    return Array.from(buckets.values())
      .sort((a, b) => a.t - b.t)
      .map(bucket => [
        bucket.t,
        averageNums(bucket.o),
        Math.max(...bucket.h),
        Math.min(...bucket.l),
        averageNums(bucket.c),
        averageNums(bucket.v),
      ]);
  }

  async function fetchBinanceCandlesticks(instrument, timeframe) {
    const sym = findCoinByInstrument(instrument)?.sym;
    const binSym = sym ? BIN_SYMS[sym] : null;
    if (!binSym) return [];
    const limit = timeframe === '1m' ? 180 : 300;
    const res = await fetch(`${BIN_BASE}/klines?symbol=${binSym}&interval=${exchangeInterval(timeframe)}&limit=${limit}`);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(row => [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])]);
  }

  async function fetchMEXCCandlesticks(instrument, timeframe) {
    const sym = findCoinByInstrument(instrument)?.sym;
    const mexcSym = sym ? MEXC_SYMS[sym] : null;
    if (!mexcSym) return [];
    const limit = timeframe === '1m' ? 180 : 300;
    const res = await fetch(`${MEXC_BASE}/klines?symbol=${mexcSym}&interval=${exchangeInterval(timeframe)}&limit=${limit}`);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(row => [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])]);
  }

  async function fetchGeckoCandlesticks(instrument, timeframe) {
    const geckoId = geckoIdForInstrument(instrument);
    if (!geckoId) throw new Error(`No fallback feed configured for ${instrument}`);

    const { days, bucketMs } = geckoTimeframeConfig(timeframe);
    const res = await fetch(`${GECKO_BASE}/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}`);
    if (!res.ok) throw new Error(`CoinGecko candles ${res.status}`);
    const json = await res.json();
    const prices = Array.isArray(json.prices) ? json.prices : [];
    const volumes = Array.isArray(json.total_volumes) ? json.total_volumes : [];
    if (!prices.length) throw new Error(`No CoinGecko chart data for ${instrument}`);

    const buckets = new Map();
    prices.forEach((point, idx) => {
      const ts = Number(point[0]);
      const priceVal = Number(point[1]);
      const volumeVal = Number(volumes[idx]?.[1] || 0);
      if (!Number.isFinite(ts) || !Number.isFinite(priceVal)) return;
      const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
      const bucket = buckets.get(bucketStart) || {
        t: bucketStart,
        o: priceVal,
        h: priceVal,
        l: priceVal,
        c: priceVal,
        v: 0,
        samples: 0,
      };
      bucket.h = Math.max(bucket.h, priceVal);
      bucket.l = Math.min(bucket.l, priceVal);
      bucket.c = priceVal;
      bucket.v += Number.isFinite(volumeVal) ? volumeVal : 0;
      bucket.samples += 1;
      buckets.set(bucketStart, bucket);
    });

    return Array.from(buckets.values())
      .sort((a, b) => a.t - b.t)
      .map(bucket => [
        bucket.t,
        bucket.o,
        bucket.h,
        bucket.l,
        bucket.c,
        bucket.samples ? bucket.v / bucket.samples : 0,
      ]);
  }

  async function fetchCandlesticks(instrument, timeframe) {
    const geckoId = geckoIdForInstrument(instrument);
    const prefersGecko = tickers[instrument]?.source === 'coingecko';
    if (prefersGecko && geckoId) {
      const [gecko, binance, mexc] = await Promise.all([
        fetchGeckoCandlesticks(instrument, timeframe).catch(() => []),
        fetchBinanceCandlesticks(instrument, timeframe).catch(() => []),
        fetchMEXCCandlesticks(instrument, timeframe).catch(() => []),
      ]);
      const pooled = poolCandles(gecko, binance, mexc);
      if (pooled.length) return pooled;
      return gecko;
    }

    try {
      const apiInstr = instrument.replace(/([A-Z]+)(USD[T]?)$/, '$1_$2');
      const [cdc, binance, mexc] = await Promise.all([
        fetch(`${CDC_BASE}/get-candlestick?instrument_name=${apiInstr}&timeframe=${timeframe}`)
          .then(async res => {
            if (!res.ok) throw new Error(`Candles HTTP ${res.status}`);
            const json = await res.json();
            if (json.code !== 0) throw new Error(`Candles error ${json.code} for ${apiInstr}`);
            return json.result.data.map(c => Array.isArray(c) ? c : [c.t || c[0], c.o || c[1], c.h || c[2], c.l || c[3], c.c || c[4], c.v || c[5]]);
          })
          .catch(() => []),
        fetchBinanceCandlesticks(instrument, timeframe).catch(() => []),
        fetchMEXCCandlesticks(instrument, timeframe).catch(() => []),
      ]);
      const pooled = poolCandles(cdc, binance, mexc);
      if (pooled.length) return pooled;
      throw new Error(`No pooled candles for ${instrument}`);
    } catch (err) {
      if (geckoId) {
        console.warn(`Falling back to CoinGecko candles for ${instrument}:`, err.message);
        const [gecko, binance, mexc] = await Promise.all([
          fetchGeckoCandlesticks(instrument, timeframe).catch(() => []),
          fetchBinanceCandlesticks(instrument, timeframe).catch(() => []),
          fetchMEXCCandlesticks(instrument, timeframe).catch(() => []),
        ]);
        const pooled = poolCandles(gecko, binance, mexc);
        if (pooled.length) return pooled;
        return gecko;
      }
      throw err;
    }
  }

  // ================================================================
  // BLOCKSCOUT on-chain lookup (Ethereum mainnet)
  // ================================================================

  async function fetchWalletTokens(address) {
    // Tier 1: Blockscout (no auth, multi-chain)
    const _walletCtrl = new AbortController();
    const _walletTid  = setTimeout(() => _walletCtrl.abort(), 8000);
    try {
      const res = await fetch(`https://eth.blockscout.com/api/v2/addresses/${address}/token-balances`, { signal: _walletCtrl.signal });
      if (res.ok) { window._walletDataSource = 'blockscout'; return res.json(); }
    } catch (e) {
      if (e.name === 'AbortError') console.warn('[WE] Wallet fetch timed out');
    } finally {
      clearTimeout(_walletTid);
    }

    // Tier 2: Ethplorer (freekey, ETH only)
    try {
      const res = await fetch(`https://api.ethplorer.io/getAddressInfo/${address}?apiKey=freekey`);
      if (res.ok) {
        const data = await res.json();
        if (!data.error) { window._walletDataSource = 'ethplorer'; return normalizeEthplorerTokens(data); }
      }
    } catch (_) {}

    // Tier 3: Etherscan (user API key required)
    const esKey = localStorage.getItem('etherscanApiKey') || '';
    if (esKey) {
      try {
        const res = await fetch(`https://api.etherscan.io/api?module=account&action=tokenlist&address=${address}&apikey=${esKey}`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === '1') { window._walletDataSource = 'etherscan'; return normalizeEtherscanTokens(data); }
        }
      } catch (_) {}
    }

    throw new Error('All wallet data sources unavailable — check connection or add Etherscan API key');
  }

  async function fetchWalletTxs(address) {
    // Tier 1: Blockscout
    try {
      const res = await fetch(`https://eth.blockscout.com/api/v2/addresses/${address}/transactions?limit=10`);
      if (res.ok) return res.json();
    } catch (_) {}

    // Tier 2: Etherscan (if key stored)
    const esKey = localStorage.getItem('etherscanApiKey') || '';
    if (esKey) {
      try {
        const res = await fetch(`https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=10&apikey=${esKey}`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === '1') return normalizeEtherscanTxs(data, address);
        }
      } catch (_) {}
    }

    // Ethplorer freekey has no tx list; return empty
    return { items: [] };
  }

  function normalizeEthplorerTokens(data) {
    const out = [];
    if (data.ETH?.balance) {
      out.push({ token: { symbol: 'ETH', name: 'Ether', decimals: '18', address: '' },
        value: String(Math.round(data.ETH.balance * 1e18)) });
    }
    (data.tokens || []).forEach(t => {
      if (!t.tokenInfo) return;
      out.push({ token: {
        symbol: t.tokenInfo.symbol || '?', name: t.tokenInfo.name || '?',
        decimals: String(t.tokenInfo.decimals ?? 18), address: t.tokenInfo.address || '',
      }, value: String(t.balance ?? 0) });
    });
    return out;
  }

  function normalizeEtherscanTokens(data) {
    return (data.result || []).map(t => ({
      token: { symbol: t.tokenSymbol || '?', name: t.tokenName || '?',
        decimals: String(t.tokenDecimal ?? 18), address: t.contractAddress || '' },
      value: t.value || '0',
    }));
  }

  function normalizeEtherscanTxs(data, address) {
    return { items: (data.result || []).map(tx => ({
      hash: tx.hash,
      to:   { hash: tx.to },
      from: { hash: tx.from },
      value: tx.value,
      timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
      method: tx.functionName ? tx.functionName.split('(')[0] : 'transfer',
      gas_used: tx.gasUsed,
    })) };
  }

  async function fetchBlockscoutPolygon(address) {
    const url = `https://polygon.blockscout.com/api/v2/addresses/${address}/token-balances`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Polygon Blockscout HTTP ${res.status}`);
    return res.json();
  }

  // ================================================================
  // DATA FETCH ORCHESTRATION
  // ================================================================

  async function fetchAll(manual = false) {
    setFeedStatus('loading');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    try {
      let rawTickers = [];
      try {
        rawTickers = await fetchTickers();
      } catch (err) {
        console.warn('Crypto.com ticker fetch failed, using Gecko fallback:', err.message);
        const shared = window._sharedTickerCache;
        if (shared?.data && Date.now() - shared.age < 30000) {
          rawTickers = shared.data;
        }
      }

      const supplementalTickers = [];
      fetchSupplementalTickers(rawTickers)
        .then(supp => { if (Array.isArray(supp)) supp.forEach(t => { if (t?.instrument_name) tickers[t.instrument_name] = t; }); refreshActiveView(); })
        .catch(err => console.warn('[WE] Supplemental fetch failed:', err.message));

      if (!rawTickers.length && !supplementalTickers.length) {
        throw new Error('No market tickers available from Crypto.com or CoinGecko');
      }

      // Build lookup map
      rawTickers.forEach(t => { tickers[t.instrument_name] = t; });
      supplementalTickers.forEach(t => { tickers[t.instrument_name] = t; });
      window._appTickers = tickers; // expose for prediction engine
      window._lastTickerFetchTs = Date.now(); // for stale badge

      // Build sparkline buffers from last/change
      WATCHLIST.forEach(c => {
        const t = tickers[c.instrument];
        if (!t) return;
        const price = parseFloat(t.last);
        const chg = parseFloat(t.change);
        if (!sparkData[c.sym]) sparkData[c.sym] = [];
        // Keep rolling 20-point buffer
        sparkData[c.sym].push(price);
        if (sparkData[c.sym].length > 20) sparkData[c.sym].shift();
      });

      updateHeaderSummary();
      setFeedStatus('live');
      if (lastUpdate) lastUpdate.textContent = 'Updated ' + new Date().toLocaleTimeString();
      refreshActiveView(manual);

    } catch (err) {
      console.error('Fetch error:', err);
      // Keep live status if we already have ticker data — only go red if completely blind
      if (Object.keys(tickers).length > 0) {
        setFeedStatus('live');
        refreshActiveView(manual);
      } else {
        setFeedStatus('error');
        render(); // still render so nav works even with empty data
      }
    } finally {
      _fetchAttempted = true;
    }

    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }

  function setFeedStatus(state) {
    if (!feedDot || !feedText) return;
    feedDot.className = 'pulse-dot';
    if (state === 'loading')   { feedDot.classList.add('loading');   feedText.textContent = 'Refreshing...'; }
    else if (state === 'live') { feedDot.classList.add('live');      feedText.textContent = 'Live'; }
    else if (state === 'degraded') { feedDot.classList.add('degraded'); feedText.textContent = 'Stale data'; }
    else                       { feedDot.classList.add('error');     feedText.textContent = 'Error'; }
  }

  function resetTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (refreshSecs > 0) refreshTimer = setInterval(() => fetchAll(), refreshSecs * 1000);
  }

  function syncPredictionRefresh() {
    const shouldRun = (['predictions', 'cfm', 'universe'].includes(currentView)) && window.PredictionEngine;
    if (shouldRun && !predictionRefreshHandle) {
      const PREFETCH_LEAD_MS = 60000; // warm cache 60s before each boundary

      // ── Prefetch: fires 60s before each :00/:15/:30/:45 ─────────────────
      let prefetchTimer = null;
      function schedulePrefetch() {
        clearTimeout(prefetchTimer);
        const msToBoundary = msUntilNextQuarter();
        // If >60s to go: schedule 60s before the boundary
        // If ≤60s to go: skip this boundary, target the next one
        const lead = msToBoundary > PREFETCH_LEAD_MS
          ? msToBoundary - PREFETCH_LEAD_MS
          : msToBoundary + 15 * 60 * 1000 - PREFETCH_LEAD_MS;
        prefetchTimer = setTimeout(() => {
          if (window.PredictionEngine && PredictionEngine.warmCache) {
            PredictionEngine.warmCache().catch(() => {});
          }
          // Also pre-fetch X sentiment so SNT orbital is warm at boundary
          if (window.SocialSentiment && SocialSentiment.hasKey()) {
            SocialSentiment.fetchAll().catch(() => {});
          }
          schedulePrefetch(); // reschedule for the boundary after next
        }, Math.max(500, lead));
      }
      schedulePrefetch();

      // ── Score: fires at each :00/:15/:30/:45 ─────────────────────────────
      const scoreHandle = scheduleOnQuarterHours(async () => {
        // Bug fix: guard checked before await — must re-check after too
        if (!['predictions', 'cfm', 'universe'].includes(currentView) || document.hidden || predictionRunInFlight) return;
        try {
          predictionRunInFlight = PredictionEngine.runAll(); // Bug fix: was dead || fallback
          await predictionRunInFlight;
          predsLoaded = true;
          snapshotPredictions();
          // Bug fix: re-check currentView after the async gap
          if (currentView === 'universe') renderUniverse();
          else if (['predictions', 'cfm'].includes(currentView)) renderPredictions();
        } catch {}
        finally {
          predictionRunInFlight = null;
        }
      });

      predictionRefreshHandle = {
        cancel() { scoreHandle.cancel(); clearTimeout(prefetchTimer); }
      };

    } else if (!shouldRun && predictionRefreshHandle) {
      predictionRefreshHandle.cancel();
      predictionRefreshHandle = null;
    }
  }

  window.addEventListener('predictionadvancedready', () => {
    if (currentView !== 'predictions' || !predsLoaded || predictionRunInFlight) return;
    renderPredictions();
  });

  // ================================================================
  // HELPERS
  // ================================================================

  // ── Prediction snapshot & accuracy helpers ───────────────────────────────

  // ── PATCH1.11: 15M Prediction Stability Lock ──────────────────────────────
  // One candle cannot flip a 15-minute Kalshi contract prediction.
  // Once a direction is committed for the active 15M bucket, we require
  // MIN_FLIP_STREAK consecutive opposing snapshots (~75s at 15s refresh)
  // before accepting a direction change. A single wick candle is ignored.
  if (!window._predLock) window._predLock = {};
  const _BUCKET_MS    = 15 * 60 * 1000;
  const MIN_FLIP_STREAK = 5; // 5 × 15s refresh = 75s of sustained opposing signal required

  // Call after every PredictionEngine.runAll() to capture the current signal per coin
  function snapshotPredictions() {
    const preds = window._predictions || {};
    const nowMs = Date.now();
    const currentBucket = Math.floor(nowMs / _BUCKET_MS) * _BUCKET_MS;

    PREDICTION_COINS.forEach(coin => {
      const p = preds[coin.sym];
      if (!p || !p.price) return;
      const rawDir = p.signal === 'strong_bull' || p.signal === 'bullish' ? 'UP'
                   : p.signal === 'strong_bear' || p.signal === 'bearish' ? 'DOWN'
                   : 'FLAT';

      // ── Stability gate ──────────────────────────────────────────────────
      let lock = window._predLock[coin.sym];
      if (!lock || lock.bucketTs !== currentBucket) {
        // New 15M bucket: reset lock and accept whatever the model says
        lock = { bucketTs: currentBucket, lockedDir: rawDir, flipStreak: 0, flipDir: null };
      } else if (rawDir === 'FLAT') {
        // FLAT is a neutral wiggle: pause, do not reset or increment the flip streak
      } else if (rawDir === lock.lockedDir) {
        // Agrees with locked direction: reinforce, clear any flip streak
        lock.flipStreak = 0;
        lock.flipDir    = null;
      } else {
        // Opposing signal: accumulate streak
        if (lock.flipDir === rawDir) {
          lock.flipStreak++;
        } else {
          lock.flipDir    = rawDir;
          lock.flipStreak = 1;
        }
        if (lock.flipStreak >= MIN_FLIP_STREAK) {
          // Sustained reversal confirmed over MIN_FLIP_STREAK snapshots — accept flip
          const oldDir = lock.lockedDir;
          lock.lockedDir  = rawDir;
          lock.flipStreak = 0;
          lock.flipDir    = null;
          // Fire early exit warning — prediction has confirmed a direction flip within the active 15M bucket.
          // This is the primary notification path when CFM-based exit didn't fire fast enough.
          if (oldDir !== 'FLAT') {
            try {
              window.dispatchEvent(new CustomEvent('cfm:earlyExit', { detail: {
                sym:        coin.sym,
                reason:     `${coin.sym} ${oldDir}→${rawDir} confirmed (${MIN_FLIP_STREAK}× sustained signal)`,
                strength:   0.8,
                prediction: oldDir,
                type:       'confirmed_prediction_flip',
                severity:   'high',
                shouldExit: true,
              }}));
            } catch (_e) { /* non-critical */ }
          }
        }
      }
      window._predLock[coin.sym] = lock;
      const dir = lock.lockedDir !== 'FLAT' ? lock.lockedDir : rawDir;

      window._lastPrediction[coin.sym] = {
        direction: dir, price: p.price, signal: p.signal, ts: nowMs,
        rawDir, flipStreak: lock.flipStreak, bucketTs: currentBucket,
      };
      // Snapshot Kalshi alignment state so we can evaluate outcome on bucket close
      const ka = p.projections?.p15?.kalshiAlign ?? null;
      if (ka?.ref != null && ka.kalshiYesPct != null) {
        window._lastKalshiSnapshot[coin.sym] = {
          ref: ka.ref,
          kYesPct: ka.kalshiYesPct,
          mYesPct: ka.modelYesPct,
          modelDir: dir,
          ts: nowMs,
        };
      }
    });
    saveLastPred();
    saveLastKalshi();
  }

  // Returns rolling accuracy stats from _predLog
  function getPredAccuracy(sym = null, n = 50) {
    const log = sym
      ? window._predLog.filter(e => e.sym === sym)
      : window._predLog;
    const recent = log.slice(-n).filter(e => e.predDir !== 'FLAT');
    if (!recent.length) return null;
    const correct = recent.filter(e => e.correct).length;
    return {
      total:    recent.length,
      correct,
      accuracy: (correct / recent.length) * 100,
      avgMove:  recent.reduce((s, e) => s + Math.abs(e.pctMove), 0) / recent.length,
      perCoin:  PREDICTION_COINS.map(c => {
        const coinLog = recent.filter(e => e.sym === c.sym);
        const cc = coinLog.filter(e => e.correct).length;
        return { sym: c.sym, total: coinLog.length, correct: cc,
                 accuracy: coinLog.length ? (cc / coinLog.length) * 100 : null };
      }).filter(x => x.total > 0)
    };
  }

  // ── 15m bucket-close accuracy evaluation ─────────────────────────────────
  window.addEventListener('candleWS:bucketClosed', (e) => {
    const { sym, bucket } = e.detail || {};
    if (!sym || !bucket) return;
    const stored = window._lastPrediction[sym];
    if (!stored || stored.direction === 'FLAT') return;
    // Only evaluate if prediction was made before this bucket closed
    const bucketClose = bucket.t + 15 * 60 * 1000;
    if (stored.ts > bucketClose) return;

    const actual  = bucket.c > bucket.o ? 'UP' : bucket.c < bucket.o ? 'DOWN' : 'FLAT';
    const pctMove = stored.price > 0
      ? ((bucket.c - stored.price) / stored.price) * 100
      : ((bucket.c - bucket.o) / bucket.o) * 100;

    const entry = {
      sym, ts: Date.now(), bucketT: bucket.t,
      predDir: stored.direction, actual,
      correct: stored.direction === actual,
      pctMove: +pctMove.toFixed(4),
      signal: stored.signal
    };
    window._predLog.push(entry);
    if (window._predLog.length > 200) window._predLog.shift();
    savePredLog();

    // ── Kalshi outcome tracking ───────────────────────────────────────────
    // YES resolves if closing price ≥ reference threshold (meet or exceed)
    const kSnap = window._lastKalshiSnapshot[sym];
    if (kSnap?.ref != null && kSnap.ts <= bucketClose) {
      const yesResolved = bucket.c >= kSnap.ref;
      const kEntry = {
        sym, ts: Date.now(), ref: kSnap.ref,
        outcome:       yesResolved ? 'YES' : 'NO',
        kYesPct:       kSnap.kYesPct,
        mYesPct:       kSnap.mYesPct,
        modelDir:      kSnap.modelDir,
        closePrice:    +bucket.c.toFixed(6),
        marketCorrect: (kSnap.kYesPct >= 50) === yesResolved,
        modelCorrect:  kSnap.mYesPct != null ? (kSnap.mYesPct >= 50) === yesResolved : null,
      };
      window._kalshiLog.push(kEntry);
      if (window._kalshiLog.length > 500) window._kalshiLog.shift();
      saveKalshiLog();
      console.log(`[KalshiTracker] ${sym} ref≥${kSnap.ref} → ${yesResolved ? 'YES ✓' : 'NO'} | K:${kSnap.kYesPct}% M:${kSnap.mYesPct}% market${kEntry.marketCorrect ? '✓' : '✗'} model${kEntry.modelCorrect ? '✓' : '✗'}`);
    }

    // Refresh accuracy display if predictions tab is visible
    if (currentView === 'predictions' && predsLoaded) updateAccuracyBadge();
    console.log(`[PredTracker] ${sym} ${stored.direction} → ${actual} ${entry.correct ? '✓' : '✗'} | ${pctMove.toFixed(3)}%`);
  });

  function updateAccuracyBadge() {
    const stats = getPredAccuracy(null, 50);
    const el = document.getElementById('pred-accuracy-badge');
    if (!el || !stats) return;
    const color = stats.accuracy >= 60 ? 'var(--color-up)' : stats.accuracy >= 45 ? 'var(--color-gold)' : 'var(--color-down)';
    el.innerHTML =
      `<span style="color:${color};font-weight:700">${stats.accuracy.toFixed(1)}%</span>` +
      `<span style="color:var(--color-text-muted);font-size:10px"> acc · ${stats.correct}/${stats.total} closed buckets</span>`;
  }

  // ── CFM Early Exit Toast ────────────────────────────────────────
  // Appears at top-right when CFM detects momentum reversal vs
  // an active prediction. Auto-dismisses after 45s.
  const activeToasts = new Map(); // sym → element
  function showEarlyExitToast(sym, prediction, reason, strength = 0.5, type = '') {
    // Remove prior toast for same coin
    if (activeToasts.has(sym)) {
      activeToasts.get(sym).remove();
      activeToasts.delete(sym);
    }
    const strPct   = Math.round((strength || 0) * 100);
    const isWall   = type === 'coordinated_sell' || type === 'confirmed_prediction_flip';
    const isFlip   = type === 'confirmed_prediction_flip';
    const label    = isWall && !isFlip ? '⚠️ WALL EVENT' : isFlip ? '🔄 SIGNAL FLIP' : '⚡ EARLY EXIT';
    const bdrColor = isWall ? 'var(--color-gold,#f90)' : 'var(--color-down,#f45)';
    const strColor = strength >= 0.7 ? bdrColor : strength >= 0.45 ? 'var(--color-gold)' : 'var(--color-text-muted)';
    const coin     = (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []).find(c => c.sym === sym);
    const icon     = coin?.icon || sym;
    const bodyText = isWall && !isFlip
      ? `Cross-coin sell detected · exit ${prediction} bet now`
      : `${prediction} call reversed · momentum flip`;

    const toast = document.createElement('div');
    toast.setAttribute('data-exit-toast', sym);
    toast.style.cssText = [
      'position:fixed', 'top:68px', 'right:16px', 'z-index:9999',
      `background:var(--color-surface,#12192e)`, `border:1px solid ${bdrColor}`,
      'border-radius:10px', 'padding:10px 14px', 'min-width:240px', 'max-width:320px',
      'box-shadow:0 4px 24px rgba(0,0,0,.55)', 'animation:fadeInRight .25s ease',
      'cursor:pointer',
    ].join(';');
    toast.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-size:18px">${icon}</span>
        <span style="font-weight:700;color:${bdrColor}">${sym} · ${label}</span>
        <span style="margin-left:auto;font-size:10px;color:${strColor}">${strPct}%</span>
      </div>
      <div style="font-size:11px;color:var(--color-text-muted);line-height:1.4">
        ${bodyText}<br>
        <span style="color:var(--color-text-faint);font-size:10px">${reason || ''}</span>
      </div>
      <div style="font-size:10px;color:var(--color-text-faint);margin-top:5px">Click to dismiss</div>
    `;
    toast.addEventListener('click', () => { toast.remove(); activeToasts.delete(sym); });
    document.body.appendChild(toast);
    activeToasts.set(sym, toast);

    // Auto-dismiss after 45s
    setTimeout(() => {
      if (toast.isConnected) { toast.remove(); activeToasts.delete(sym); }
    }, 45000);
    console.log(`[CFMRouter] Early exit toast: ${sym} ${prediction} → CFM flip (${strPct}%)`);
  }


  function price(ticker)  { return ticker ? parseFloat(ticker.last || 0) : 0; }
  function change(ticker) { return ticker ? parseFloat(ticker.change) * 100 : 0; }
  function volume(ticker) { return ticker ? parseFloat(ticker.volume_value || 0) : 0; }
  function high(ticker) { return ticker ? parseFloat(ticker.high) : 0; }
  function low(ticker) { return ticker ? parseFloat(ticker.low) : 0; }
  function marketCap(meta) { return meta ? parseFloat(meta.marketCap || 0) : 0; }
  function compareNumbers(a, b, dir = -1) { return dir === -1 ? b - a : a - b; }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function fmt(n, dp = 2) {
    if (n === undefined || n === null || isNaN(n) || !isFinite(n)) return '—';
    n = Number(n);
    if (n < 0.000001 && n > 0) return n.toExponential(3);
    if (n < 0.01) return n.toFixed(6);
    if (n < 1) return n.toFixed(4);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: dp });
    return n.toFixed(dp);
  }

  function fmtPrice(n) {
    if (n === undefined || n === null || isNaN(n) || !isFinite(n)) return '—';
    n = Number(n);
    if (n >= 1000) return '$' + fmt(n, 0);
    if (n >= 1) return '$' + fmt(n, 2);
    if (n >= 0.01) return '$' + fmt(n, 4);
    if (n > 0) return '$' + n.toFixed(8);
    return '$0.00';
  }

  function fmtPct(n) {
    if (n === undefined || n === null || isNaN(n) || !isFinite(n)) return '—';
    const sign = n >= 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }

  function fmtCompactUsd(n) {
    if (n === undefined || n === null || isNaN(n) || !isFinite(n) || n <= 0) return '—';
    n = Number(n);
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(0);
  }

  function chgClass(n) { return n >= 0 ? 'change-pos' : 'change-neg'; }
  function posneg(n) { return n >= 0 ? 'pos' : 'neg'; }

  function coinColor(sym) { return COIN_COLORS[sym] || '#7880a0'; }

  function coinIcon(sym) {
    // Return cached HTML string — avoids repeated PREDICTION_COINS.find() and
    // string construction on every render pass; icons load once from browser cache.
    if (_iconCache.has(sym)) return _iconCache.get(sym);

    const pc = PREDICTION_COINS.find(c => c.sym === sym);
    const fb = pc?.icon || (PORTFOLIO_HOLDINGS.find(h => h.sym === sym)?.icon) || sym.slice(0, 2);
    // CDN fallback order: CoinGecko assets first (highest quality),
    // then atomiclabs PNG CDN (reliable, broad coverage), then text emoji.
    const primary  = pc?.iconSources?.[0] || '';
    const fallback = `https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons/128/color/${sym.toLowerCase()}.png`;

    if (!primary) {
      const html = `<span class="ci-text">${fb}</span>`;
      _iconCache.set(sym, html);
      return html;
    }
    // Text symbol is always visible immediately underneath.
    // CDN img sits on top with opacity:0 and fades in only on successful load.
    // onerror cascade: try atomiclabs CDN PNG first, then remove entirely.
    const html = (
      `<span class="ci-wrap">` +
        `<span class="ci-text">${fb}</span>` +
        `<img class="ci-img" src="${primary}" alt="${sym}" ` +
          `data-fb="${fallback}" ` +
          `onload="this.classList.add('ci-loaded')" ` +
          `onerror="var f=this.dataset.fb;if(f){this.dataset.fb='';this.src=f}else{this.remove()}">` +
      `</span>`
    );
    _iconCache.set(sym, html);
    return html;
  }

  function fmtRecord(wins, losses) {
    const w = Number(wins) || 0;
    const l = Number(losses) || 0;
    return `${w}-${l}`;
  }

  function fmtRatio(ratio, dp = 1) {
    const value = Number(ratio);
    if (!Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(dp)}%`;
  }

  function fmtSigned(n, dp = 0) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(dp)}`;
  }

  function fmtSignedPct(n, dp = 2) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(dp)}%`;
  }

  function predictionDirection(pred, fallback = 0) {
    if (!pred) return fallback;
    const score = Number.isFinite(pred.score) ? pred.score : (Number.isFinite(pred.rawScore) ? pred.rawScore : 0);
    const floor = Number.isFinite(pred.diagnostics?.decisionFloor) ? pred.diagnostics.decisionFloor : 0.1;
    if (score > floor) return 1;
    if (score < -floor) return -1;
    return fallback;
  }

  function toggleExpanded(setRef, key) {
    if (setRef.has(key)) setRef.delete(key);
    else setRef.add(key);
  }

  const GECKO_ID_TO_SYMBOL = Object.fromEntries(Object.entries(SCREENER_GECKO_IDS).map(([sym, id]) => [id, sym]));

  async function fetchScreenerMeta(force = false) {
    const fresh = Date.now() - screenerMetaAge < 10 * 60 * 1000;
    if (!force && fresh && Object.keys(screenerMetaCache).length) return screenerMetaCache;
    if (screenerMetaPromise) return screenerMetaPromise;

    const ids = Array.from(new Set(Object.values(SCREENER_GECKO_IDS))).join(',');
    screenerMetaPromise = fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`)
      .then(r => {
        if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
        return r.json();
      })
      .then(rows => {
        const next = {};
        rows.forEach(row => {
          const sym = GECKO_ID_TO_SYMBOL[row.id];
          if (!sym) return;
          next[sym] = {
            marketCap: row.market_cap || 0,
            totalVolume: row.total_volume || 0,
            image: row.image || '',
            rank: row.market_cap_rank || null,
            geckoId: row.id,
          };
        });
        screenerMetaCache = next;
        screenerMetaAge = Date.now();
        return screenerMetaCache;
      })
      .catch(err => {
        console.warn('Screener metadata fetch failed:', err.message);
        return screenerMetaCache;
      })
      .finally(() => {
        screenerMetaPromise = null;
      });

    return screenerMetaPromise;
  }

  function refreshActiveView(force = false) {
    // NOTE: do NOT increment _rv here — refreshActiveView is a same-panel data refresh,
    // not navigation. Only render() (user nav click) should bump the version counter.
    if (currentView === 'charts' && document.getElementById('chartContainer')) {
      updateChartMarketPanels();
      loadCandles({ showLoader: false, reuseChart: true });
      return;
    }
    if (currentView === 'cfm') { renderCFM(); return; }
    if (currentView === 'predictions') { renderPredictions(); return; }
    if (currentView === 'screener') { renderScreener(); return; }
    if (currentView === 'universe') { renderUniverse(); return; }
    if (currentView === 'markets5m') { renderMarkets5M(); return; }
    render();
  }

  function formatAddress(addr) {
    return addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : '—';
  }

  function updateHeaderSummary() {
    updateMarketSummary();
  }

  function updateMarketSummary() {
    const ms = $('#marketSummary');
    if (!ms) return;
    const btc = tickers['BTCUSD'];
    const sol = tickers['SOLUSD'];
    const xrp = tickers['XRPUSD'];
    const doge = tickers['DOGEUSD'];
    if (!btc && !sol && !xrp) return;
    const cacheAge = Date.now() - (window._lastTickerFetchTs || Date.now());
    const stalePart = cacheAge > 30000
      ? `<span class="stale-badge">CACHED ${Math.floor(cacheAge/60000)}m ago</span>`
      : '';
    ms.innerHTML = [
      `<div class="ms-item"><span>Targets</span> <span class="ms-val">${PREDICTION_COINS.length}</span></div>`,
      `<div class="ms-item"><span>Feeds</span> <span class="ms-val">4</span></div>`,
      `<div class="ms-item"><span>Cadence</span> <span class="ms-val">15s</span></div>`,
      window.CandleWS
        ? `<div class="ms-item"><span>15m</span> <span class="ms-val" style="color:${CandleWS.isConnected()?'var(--color-up)':'var(--color-muted)'}">` +
          (CandleWS.isConnected()
            ? `${Math.floor(CandleWS.getMsUntilClose()/1000)}s`
            : 'WS…') +
          `</span></div>`
        : '',
      btc  ? `<div class="ms-item"><span>BTC</span> <span class="ms-val">${fmtPrice(price(btc))}</span> <span class="ms-chg ${posneg(change(btc))}">${fmtPct(change(btc))}</span></div>` : '',
      sol  ? `<div class="ms-item"><span>SOL</span> <span class="ms-val">${fmtPrice(price(sol))}</span> <span class="ms-chg ${posneg(change(sol))}">${fmtPct(change(sol))}</span></div>` : '',
      xrp  ? `<div class="ms-item"><span>XRP</span> <span class="ms-val">${fmtPrice(price(xrp))}</span> <span class="ms-chg ${posneg(change(xrp))}">${fmtPct(change(xrp))}</span></div>` : '',
      doge ? `<div class="ms-item"><span>DOGE</span> <span class="ms-val">${fmtPrice(price(doge))}</span> <span class="ms-chg ${posneg(change(doge))}">${fmtPct(change(doge))}</span></div>` : '',
      stalePart,
    ].join('');
  }

  // ================================================================
  // VIEW: MARKETS
  // ================================================================

  const FILTER_GROUPS = {
    all: { label: 'All', pred: () => true },
    portfolio: { label: 'Modeled', pred: c => PORTFOLIO_HOLDINGS.some(h => h.sym === c.sym) },
    core: { label: 'Core', pred: c => c.group === 'core' },
    meme: { label: 'Memes', pred: c => c.group === 'meme' },
    defi: { label: 'DeFi', pred: c => c.group === 'defi' },
    layer2: { label: 'L2', pred: c => c.group === 'layer2' },
    layer1: { label: 'L1', pred: c => c.group === 'layer1' },
    ai: { label: 'AI', pred: c => c.group === 'ai' },
  };

  // ==== 5-Minute Markets Tab =========================================

  let _markets5mCountdown = null;
  function renderMarkets5M() {
    if (_markets5mCountdown) { clearInterval(_markets5mCountdown); _markets5mCountdown = null; }
    const pm   = window.PredictionMarkets?.getAll() || {};
    const pred = window.PredictionEngine?.getAll() || {};   // was .lastResults (doesn't exist)
    const COINS_5M = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];

    function _pct(v) {
      if (v == null) return '—';
      return (v * 100).toFixed(0) + '%';
    }
    function _countdown(iso) {
      if (!iso) return '—';
      const ms = new Date(iso).getTime() - Date.now();
      if (ms <= 0) return 'Settling…';
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const ss = s % 60;
      return `${m}m ${ss < 10 ? '0' : ''}${ss}s`;
    }
    function _side(prob) {
      if (prob == null) return '<span style="color:var(--color-text-faint)">—</span>';
      if (prob >= 0.55) return `<span class="badge-up">BUY YES ▲</span>`;
      if (prob <= 0.45) return `<span class="badge-down">BUY NO ▼</span>`;
      return `<span style="color:var(--color-text-faint)">NEUTRAL</span>`;
    }
    function _modelProj(sym) {
      const p = pred[sym];
      if (!p) return null;
      const proj = p.projections?.p5 ?? p.projections?.p15 ?? null;
      if (proj == null) return null;
      return proj;
    }

    const cards = COINS_5M.map(sym => {
      const coin  = pm[sym] || {};
      const k5    = coin.kalshi5m;
      const p5    = coin.poly5m;
      const tick  = tickers[WATCHLIST.find(w => w.sym === sym)?.instrument] || null;
      const curPx = tick ? price(tick) : null;
      const proj  = _modelProj(sym);

      const noData = !k5 && !p5;
      const k5prob = k5?.probability ?? null;
      const p5prob = p5?.probability ?? null;

      // Combined 5M signal: Kalshi 5M 80% weight (exact same question), Poly5M 20%
      let combined5m = null;
      if (k5prob != null && p5prob != null)
        combined5m = k5prob * 0.80 + p5prob * 0.20;
      else if (k5prob != null)
        combined5m = k5prob;
      else if (p5prob != null)
        combined5m = p5prob;

      const coinColor = sym === 'BTC' ? '#f7931a' : sym === 'ETH' ? '#627eea' : sym === 'SOL' ? '#9945ff' : sym === 'XRP' ? '#0085c0' : sym === 'BNB' ? '#f3ba2f' : sym === 'HYPE' ? '#34d399' : '#ba9f33';

      return `
        <div class="opp-card" style="border-left:3px solid ${coinColor}; padding:14px 16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:1.1em;font-weight:700;color:${coinColor}">${sym}</span>
              ${curPx != null ? `<span style="color:var(--color-text-muted);font-size:13px">$${fmtPrice(curPx)}</span>` : ''}
            </div>
            <div style="font-size:11px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.04em;">5-Min Markets</div>
          </div>

          ${noData
            ? `<div style="color:var(--color-text-faint);font-size:12px;padding:6px 0 8px;">
                ⚠ No Kalshi/Poly 5M contract data yet — model signal only
               </div>`
            : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">

            <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;">
              <div style="font-size:11px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">
                ${k5?._proxy15m ? 'Kalshi Nearest ★' : 'Kalshi 5M'}
              </div>
              ${k5 ? `
                <div style="display:flex;gap:10px;margin-bottom:6px;">
                  <span style="color:var(--color-green);font-size:15px;font-weight:700;">YES ${_pct(k5prob)}</span>
                  <span style="color:var(--color-red);font-size:15px;font-weight:700;">NO ${_pct(k5prob != null ? 1 - k5prob : null)}</span>
                </div>
                <div style="font-size:12px;color:var(--color-text-muted);">
                  Strike: ${k5.targetPrice || 'TBD'}<br>
                  Closes: <span id="k5cd-${sym}" data-close="${k5.closeTime}" style="font-weight:600;color:var(--color-text)">⏱ ${_countdown(k5.closeTime)}</span>
                </div>
                <div style="margin-top:6px;">${_side(k5prob)}</div>
              ` : `<div style="color:var(--color-text-faint);font-size:12px;">No active contract</div>`}
            </div>

            <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;">
              <div style="font-size:11px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">
                ${p5?._noShortTerm ? 'Poly Trend (Long-Term)' : 'Polymarket 5M'}
              </div>
              ${p5 ? `
                <div style="margin-bottom:6px;">
                  <span style="color:var(--color-green);font-size:15px;font-weight:700;">YES ${_pct(p5prob)}</span>
                  <span style="color:var(--color-red);font-size:15px;font-weight:700;margin-left:8px;">NO ${_pct(p5prob != null ? 1 - p5prob : null)}</span>
                  <span style="color:var(--color-text-faint);font-size:11px;margin-left:6px;">${p5.count > 1 ? '(' + p5.count + ' mkts)' : ''}</span>
                </div>
                <div style="font-size:11px;color:var(--color-text-muted);margin-bottom:6px;">${p5.title ? p5.title.slice(0, 52) + (p5.title.length > 52 ? '…' : '') : ''}</div>
                <div>${_side(p5prob)}</div>
              ` : `<div style="color:var(--color-text-faint);font-size:12px;">No Polymarket data yet</div>`}
            </div>
          </div>
          `}

          <!-- Model projection + combined signal — always shown regardless of external data -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;${noData ? '' : 'margin-top:0;'}">
            <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;">
              <div style="font-size:11px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Model 5M Proj</div>
              ${proj != null ? `
                <span style="font-size:14px;font-weight:700;color:${proj >= 0 ? 'var(--color-green)' : 'var(--color-red)'}">
                  ${proj >= 0 ? '▲ UP' : '▼ DOWN'} ${Math.abs(proj * 100).toFixed(1)}%
                </span>
              ` : `<span style="color:var(--color-text-faint);font-size:12px;">Run predictions first</span>`}
            </div>

            <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;">
              <div style="font-size:11px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Combined 5M Signal</div>
              ${combined5m != null ? `
                <div style="margin-bottom:4px;">${_side(combined5m)}</div>
                <div style="font-size:11px;color:var(--color-text-muted);">
                  ${_pct(combined5m)} YES probability
                  ${k5prob != null && p5prob != null ? `<br><span style="color:var(--color-text-faint)">(K:80% + P:20%)</span>` : ''}
                </div>
              ` : proj != null ? `
                <div style="margin-bottom:4px;">${_side(proj >= 0 ? 0.65 : 0.35)}</div>
                <div style="font-size:11px;color:var(--color-text-faint);">model-only signal</div>
              ` : `<span style="color:var(--color-text-faint);font-size:12px;">No data</span>`}
            </div>
          </div>
        </div>
      `;
    }).join('');

    content.innerHTML = `
      <div class="section-header">
        <span class="section-title">5-Minute Markets</span>
        <span style="font-size:11px;color:var(--color-text-faint);">
          Kalshi Nearest + Polymarket Trend · 7 coins · refreshes every 30s
        </span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;padding:4px 0;">
        ${cards}
      </div>
      <div style="padding:12px 0;font-size:11px;color:var(--color-text-faint);">
        ℹ <b>Kalshi Nearest</b> (★) = nearest-expiry 15M market used as real-time proxy when dedicated 5M series is unavailable.
        YES resolves if price ≥ CF Benchmarks at expiry. UP → BUY YES · DOWN → BUY NO.
        <b>Poly Trend</b> = long-term Polymarket sentiment (no short-term crypto markets exist on Polymarket).
      </div>
    `;

    // Live countdown tick for Kalshi 5M close times
    _markets5mCountdown = setInterval(() => {
      if (currentView !== 'markets5m') { clearInterval(_markets5mCountdown); _markets5mCountdown = null; return; }
      COINS_5M.forEach(sym => {
        const el = document.getElementById(`k5cd-${sym}`);
        if (!el) return;
        const close = el.dataset.close;
        if (close) el.textContent = `⏱ ${_countdown(close)}`;
      });
    }, 1000);
  }

  function renderMarkets() {
    // KPI bar
    let portfolioTotal = 0, portfolioChange = 0, gainers = 0, losers = 0;
    PORTFOLIO_HOLDINGS.forEach(h => {
      const t = tickers[h.instrument];
      if (!t) return;
      const val = h.amount * price(t);
      portfolioTotal += val;
      portfolioChange += change(t);
    });
    WATCHLIST.forEach(c => { const t = tickers[c.instrument]; if (!t) return; change(t) >= 0 ? gainers++ : losers++; });
    const avgChg = portfolioChange / (PORTFOLIO_HOLDINGS.filter(h => tickers[h.instrument]).length || 1);

    // Build sorted list
    let coins = WATCHLIST.filter(FILTER_GROUPS[coinFilter].pred);
    coins = coins.map(c => ({ ...c, ticker: tickers[c.instrument] }));
    coins.sort((a, b) => {
      let av = sortBy === 'price' ? price(a.ticker) : sortBy === 'change' ? change(a.ticker) : volume(a.ticker);
      let bv = sortBy === 'price' ? price(b.ticker) : sortBy === 'change' ? change(b.ticker) : volume(b.ticker);
      return compareNumbers(av, bv, sortDir);
    });

    content.innerHTML = `
      <div class="kpi-bar">
        <div class="kpi-card">
          <div class="kpi-label">Portfolio Value</div>
          <div class="kpi-val blue">$${fmt(portfolioTotal, 2)}</div>
          <div class="kpi-sub ${posneg(avgChg)}">${fmtPct(avgChg)} weighted move across modeled positions</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Market Breadth</div>
          <div class="kpi-val"><span style="color:var(--color-green)">${gainers}↑</span> <span style="color:var(--color-text-faint)">/</span> <span style="color:var(--color-red)">${losers}↓</span></div>
          <div class="kpi-sub">Up vs down pressure across ${WATCHLIST.length} monitored markets</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Strongest Upside</div>
          ${topMover(1)}
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Strongest Downside</div>
          ${topMover(-1)}
        </div>
      </div>

      <div class="section-header">
        <span class="section-title">Reference Tape</span>
        <div class="coin-filters">
          ${Object.entries(FILTER_GROUPS).map(([k, g]) => `
            <button class="filter-btn ${coinFilter === k ? 'active' : ''}" data-filter="${k}">${g.label}</button>
          `).join('')}
        </div>
      </div>

      <div class="table-wrap">
        <table class="price-table" id="priceTable">
          <thead>
            <tr>
              <th>#</th>
              <th>Coin</th>
              <th class="sorted" data-sort="price">Price</th>
              <th data-sort="change">24h %</th>
              <th>24h High</th>
              <th>24h Low</th>
              <th data-sort="volume">Volume</th>
              <th>Spark</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${coins.map((c, i) => marketRow(c, i)).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Filter buttons
    content.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => { coinFilter = btn.dataset.filter; renderMarkets(); });
    });

    // Sort headers
    content.querySelectorAll('[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortBy === col) sortDir *= -1; else { sortBy = col; sortDir = -1; }
        renderMarkets();
      });
    });

    // Chart buttons
    content.querySelectorAll('[data-chart]').forEach(btn => {
      btn.addEventListener('click', () => {
        chartCoin = btn.dataset.chart;
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('[data-view="charts"]').classList.add('active');
        currentView = 'charts';
        if (pageTitle) pageTitle.textContent = 'Market Structure';
        render();
      });
    });

    // Draw sparklines
    requestAnimationFrame(() => drawSparklines(coins));
  }

  function marketRow(c, i) {
    const t = c.ticker;
    const p = price(t), ch = change(t), v = volume(t), h24 = high(t), l24 = low(t);
    const isPortfolio = PORTFOLIO_HOLDINGS.some(h => h.sym === c.sym);
    return `
      <tr id="row-${c.sym}">
        <td style="color:var(--color-text-faint);font-size:11px">${i + 1}</td>
        <td>
          <div class="coin-cell">
            <div class="coin-icon" style="background:${coinColor(c.sym)}22;color:${coinColor(c.sym)}">${coinIcon(c.sym)}</div>
            <div>
              <div class="coin-name">${c.sym} ${isPortfolio ? '<span style="color:var(--color-gold);font-size:9px">●</span>' : ''}</div>
              <div class="coin-sym">${c.name}</div>
            </div>
          </div>
        </td>
        <td class="price-val" id="price-${c.sym}">${t ? fmtPrice(p) : '—'}</td>
        <td class="${chgClass(ch)}" id="chg-${c.sym}">${t ? fmtPct(ch) : '—'}</td>
        <td style="color:var(--color-green)">${t ? fmtPrice(h24) : '—'}</td>
        <td style="color:var(--color-red)">${t ? fmtPrice(l24) : '—'}</td>
        <td>
          <div class="vol-bar-wrap">
            <span>$${fmt(v, 0)}</span>
          </div>
        </td>
        <td class="spark-cell"><canvas class="spark-canvas" id="spark-${c.sym}" width="80" height="28"></canvas></td>
        <td><button class="chart-btn" data-chart="${c.instrument}">Chart</button></td>
      </tr>
    `;
  }

  function topMover(dir) {
    let best = null, bestVal = dir > 0 ? -Infinity : Infinity;
    WATCHLIST.forEach(c => {
      const t = tickers[c.instrument];
      if (!t) return;
      const ch = change(t);
      if (dir > 0 && ch > bestVal) { bestVal = ch; best = c; }
      if (dir < 0 && ch < bestVal) { bestVal = ch; best = c; }
    });
    if (!best) return '<div class="kpi-val">—</div>';
    return `<div class="kpi-val ${dir > 0 ? 'green' : 'red'}">${best.sym} ${fmtPct(bestVal)}</div><div class="kpi-sub">${fmtPrice(price(tickers[best.instrument]))}</div>`;
  }

  function drawSparklines(coins) {
    coins.forEach(c => {
      const canvas = document.getElementById(`spark-${c.sym}`);
      if (!canvas) return;
      const data = sparkData[c.sym];
      if (!data || data.length < 2) return;
      const ctx = canvas.getContext('2d');
      const t = c.ticker;
      const isUp = change(t) >= 0;
      const color = isUp ? '#26d47e' : '#ff4b6e';
      const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
      const W = 80, H = 28;
      ctx.clearRect(0, 0, W, H);
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i / (data.length - 1)) * W;
        const y = H - ((v - min) / range) * (H - 4) - 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Fill
      ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
      ctx.fillStyle = isUp ? 'rgba(38,212,126,0.08)' : 'rgba(255,75,110,0.08)';
      ctx.fill();
    });
  }

  // ================================================================
  // VIEW: PORTFOLIO
  // ================================================================

  function renderPortfolio() {
    let total = 0, totalCost = 0;
    const rows = PORTFOLIO_HOLDINGS.map(h => {
      const t = tickers[h.instrument];
      const p = price(t);
      const val = h.amount * p;
      const cost = h.amount * h.costBasis;
      const pnl = val - cost;
      const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
      total += val;
      totalCost += cost;
      return { ...h, price: p, val, cost, pnl, pnlPct, change: change(t) };
    }).sort((a, b) => b.val - a.val);

    const totalPnl = total - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    content.innerHTML = `
      <div class="portfolio-layout">
        <div>
          <!-- Holdings -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-title">Reference Positions — Edit Amounts Below</div>
            <div style="margin-bottom:12px">
              <div class="portfolio-total">$${fmt(total, 2)}</div>
              <div class="portfolio-pnl ${posneg(totalPnl)}">
                ${fmtPct(totalPnlPct)} (${totalPnl >= 0 ? '+' : ''}$${fmt(Math.abs(totalPnl), 2)}) vs reference cost
              </div>
            </div>
            ${rows.map(h => holdingRow(h, total)).join('')}
          </div>

          <!-- Edit Holdings -->
          <div class="card">
            <div class="card-title">Position Inputs</div>
            <div id="holdingInputs">
              ${PORTFOLIO_HOLDINGS.map(h => `
                <div class="input-group">
                  <span class="input-label" style="color:${coinColor(h.sym)}">${h.sym}</span>
                  <input class="input-field" type="number" id="amt-${h.sym}" value="${h.amount}" step="any" min="0" placeholder="Amount" data-sym="${h.sym}">
                  <input class="input-field" type="number" id="cost-${h.sym}" value="${h.costBasis}" step="any" min="0" placeholder="Avg cost" data-sym="${h.sym}-cost" style="max-width:100px">
                </div>
              `).join('')}
            </div>
            <button class="btn-primary" id="updateHoldingsBtn" style="margin-top:10px">Apply Inputs</button>
          </div>
        </div>

        <div>
          <!-- Allocation Donut -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-title">Exposure Mix</div>
            <div class="donut-wrap">
              <canvas class="donut-canvas" id="donutChart" width="180" height="180"></canvas>
            </div>
            <div id="donutLegend">
              ${rows.slice(0, 8).map(h => `
                <div class="legend-item">
                  <div class="legend-dot" style="background:${coinColor(h.sym)}"></div>
                  <span style="flex:1;font-size:11px">${h.sym}</span>
                  <span style="font-family:var(--font-mono);font-size:11px">${total > 0 ? ((h.val / total) * 100).toFixed(1) : 0}%</span>
                  <span style="font-family:var(--font-mono);font-size:11px;color:var(--color-text-muted);min-width:55px;text-align:right">$${fmt(h.val, 0)}</span>
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Stats -->
          <div class="card">
            <div class="card-title">Position Stats</div>
            <div class="kpi-card" style="margin-bottom:8px;border:none;padding:0">
              <div class="kpi-label">Reference Cost Basis</div>
              <div class="kpi-val blue">$${fmt(totalCost, 2)}</div>
            </div>
            <div class="kpi-card" style="margin-bottom:8px;border:none;padding:0">
              <div class="kpi-label">Reference P/L</div>
              <div class="kpi-val ${totalPnl >= 0 ? 'green' : 'red'}">${totalPnl >= 0 ? '+' : ''}$${fmt(Math.abs(totalPnl), 2)}</div>
            </div>
            <div class="kpi-card" style="border:none;padding:0">
              <div class="kpi-label">Reference Return</div>
              <div class="kpi-val ${totalPnlPct >= 0 ? 'green' : 'red'}">${fmtPct(totalPnlPct)}</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Draw donut
    requestAnimationFrame(() => {
      const canvas = document.getElementById('donutChart');
      if (!canvas) return;
      if (donutChart) { donutChart.destroy(); donutChart = null; }
      const top8 = rows.slice(0, 8);
      const otherVal = rows.slice(8).reduce((s, h) => s + h.val, 0);
      const labels = [...top8.map(h => h.sym), otherVal > 0 ? 'Other' : null].filter(Boolean);
      const vals   = [...top8.map(h => h.val), otherVal > 0 ? otherVal : null].filter(Boolean);
      const colors = [...top8.map(h => coinColor(h.sym)), '#444a60'];
      donutChart = new Chart(canvas, {
        type: 'doughnut',
        data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }] },
        options: {
          responsive: false, cutout: '70%',
          plugins: { legend: { display: false }, tooltip: {
            callbacks: { label: ctx => ` ${ctx.label}: $${fmt(ctx.raw, 0)} (${total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0}%)` }
          }}
        }
      });
    });

    // Edit holdings
    const updateBtn = document.getElementById('updateHoldingsBtn');
    if (updateBtn) {
      updateBtn.addEventListener('click', () => {
        PORTFOLIO_HOLDINGS.forEach(h => {
          const amtEl = document.getElementById(`amt-${h.sym}`);
          const costEl = document.getElementById(`cost-${h.sym}`);
          if (amtEl) h.amount = parseFloat(amtEl.value) || 0;
          if (costEl) h.costBasis = parseFloat(costEl.value) || 0;
        });
        renderPortfolio();
      });
    }
  }

  function holdingRow(h, total) {
    const pct = total > 0 ? (h.val / total) * 100 : 0;
    return `
      <div class="holding-row">
        <div class="coin-icon" style="background:${coinColor(h.sym)}22;color:${coinColor(h.sym)};width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${coinIcon(h.sym)}</div>
        <div class="holding-info">
          <div class="holding-name">${h.sym}</div>
          <div class="holding-amt">${h.amount.toLocaleString(undefined, {maximumFractionDigits: 4})} @ ${fmtPrice(h.costBasis)}</div>
          <div class="alloc-bar-wrap"><div class="alloc-bar" style="width:${pct}%;background:${coinColor(h.sym)}"></div></div>
        </div>
        <div class="holding-right">
          <div class="holding-val">${h.price > 0 ? '$'+fmt(h.val, 2) : '—'}</div>
          <div class="holding-chg ${posneg(h.pnl)}">${h.pnlPct !== 0 ? fmtPct(h.pnlPct)+' PnL' : '—'}</div>
        </div>
      </div>
    `;
  }

  // ================================================================
  // VIEW: CHARTS (Lightweight Charts candlesticks)
  // ================================================================

  function renderCharts() {
    if (candleChart) destroyChart();
    const coins = WATCHLIST;
    const options = coins.map(c => `<option value="${c.instrument}" ${c.instrument === chartCoin ? 'selected' : ''}>${c.sym} — ${c.name}</option>`).join('');

    content.innerHTML = `
      <div class="charts-controls">
        <div class="coin-select-wrap">
          <span class="ctrl-label">Coin</span>
          <select class="ctrl-select" id="chartCoinSelect">${options}</select>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="ctrl-label">Timeframe</span>
          <div class="tf-btns">
            ${['5m','15m','1h','4h','1D','1W'].map(tf => `<button class="tf-btn ${chartTf === tf ? 'active' : ''}" data-tf="${tf}">${tf}</button>`).join('')}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="ctrl-label">Tracing</span>
          <div class="tf-btns">
            ${[
              ['ema9', 'EMA 9'],
              ['ema21', 'EMA 21'],
              ['vwap', 'VWAP'],
              ['support', 'Support'],
              ['resistance', 'Resistance'],
              ['trend', 'Trend'],
            ].map(([key, label]) => `<button class="tf-btn ${chartIndicators[key] ? 'active' : ''}" data-indicator="${key}">${label}</button>`).join('')}
          </div>
        </div>
        <button class="btn-outline" id="chartRefreshBtn">Refresh Chart</button>
      </div>

      <div class="chart-container" id="chartContainer">
        <div class="chart-stage" id="chartStage"></div>
        <div class="chart-loading" id="chartLoading"><div class="loader-ring"></div><p>Loading candles...</p></div>
      </div>

      <div class="ohlc-row" id="ohlcRow"></div>

      <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="card">
          <div class="card-title">Order Book Snapshot</div>
          <div id="orderBook"><div class="empty-state" style="padding:20px">Select a coin above</div></div>
        </div>
        <div class="card">
          <div class="card-title">Recent Trades</div>
          <div id="recentTrades"><div class="empty-state" style="padding:20px">Select a coin above</div></div>
        </div>
      </div>
    `;

    // Bind controls
    const sel = document.getElementById('chartCoinSelect');
    if (sel) sel.addEventListener('change', e => { chartCoin = e.target.value; loadCandles({ showLoader: true, reuseChart: false }); });

    content.querySelectorAll('.tf-btn').forEach(btn => {
      if (btn.dataset.tf) btn.addEventListener('click', () => {
        chartTf = btn.dataset.tf;
        content.querySelectorAll('.tf-btn[data-tf]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadCandles({ showLoader: false, reuseChart: true });
      });
      if (btn.dataset.indicator) btn.addEventListener('click', () => {
        const key = btn.dataset.indicator;
        chartIndicators[key] = !chartIndicators[key];
        btn.classList.toggle('active', chartIndicators[key]);
        updateChartOverlays();
      });
    });

    const refreshChartBtn = document.getElementById('chartRefreshBtn');
    if (refreshChartBtn) refreshChartBtn.addEventListener('click', () => loadCandles({ showLoader: false, reuseChart: true }));

    loadCandles({ showLoader: !chartRawCandles.length, reuseChart: true });
  }

  function setChartLoading(isLoading) {
    const loading = document.getElementById('chartLoading');
    if (loading) loading.style.display = isLoading ? 'flex' : 'none';
  }

  function calcLineEMA(values, period) {
    if (!values.length) return [];
    const k = 2 / (period + 1);
    const ema = [values[0]];
    for (let i = 1; i < values.length; i++) ema.push(values[i] * k + ema[i - 1] * (1 - k));
    return ema;
  }

  function calcLineVWAP(rows) {
    let cumVol = 0;
    let cumTpVol = 0;
    return rows.map(row => {
      const vol = row.volume || 1;
      const tp = (row.high + row.low + row.close) / 3;
      cumVol += vol;
      cumTpVol += tp * vol;
      return { time: row.time, value: cumTpVol / cumVol };
    });
  }

  function destroyChart() {
    if (chartResizeObserver) {
      try { chartResizeObserver.disconnect(); } catch (e) {}
      chartResizeObserver = null;
    }
    if (candleChart) {
      try { candleChart.remove(); } catch (e) {}
      candleChart = null;
    }
    chartSeries = {};
    chartRawCandles = [];
    chartSnapshot = null;
  }

  function ensureChart(container) {
    if (candleChart && chartSeries.candles && chartSeries.volume) return;
    const isDark = root.getAttribute('data-theme') !== 'light';
    const bg = isDark ? '#111318' : '#ffffff';
    const textColor = isDark ? '#7880a0' : '#6470a0';
    const grid = isDark ? '#252932' : '#dde0ea';

    candleChart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 388,
      layout: { background: { type: 'solid', color: bg }, textColor },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: true },
    });

    chartSeries.candles = candleChart.addCandlestickSeries({
      upColor: '#26d47e', downColor: '#ff4b6e',
      borderUpColor: '#26d47e', borderDownColor: '#ff4b6e',
      wickUpColor: '#26d47e', wickDownColor: '#ff4b6e',
    });
    chartSeries.volume = candleChart.addHistogramSeries({
      color: '#26d47e',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    candleChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chartSeries.ema9 = candleChart.addLineSeries({ color: '#26d47e', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.ema21 = candleChart.addLineSeries({ color: '#00b4d8', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.vwap = candleChart.addLineSeries({ color: '#f3ba2f', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.support = candleChart.addLineSeries({ color: '#50e3c2', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.resistance = candleChart.addLineSeries({ color: '#ff9f3a', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.trend = candleChart.addLineSeries({ color: '#a259ff', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });

    chartResizeObserver = new ResizeObserver(() => {
      if (candleChart && container.clientWidth > 0) candleChart.applyOptions({ width: container.clientWidth });
    });
    chartResizeObserver.observe(container);
  }

  function updateChartOverlays() {
    if (!chartRawCandles.length || !chartSeries.candles) return;
    const closes = chartRawCandles.map(c => c.close);
    const ema9 = calcLineEMA(closes, 9).map((value, i) => ({ time: chartRawCandles[i].time, value }));
    const ema21 = calcLineEMA(closes, 21).map((value, i) => ({ time: chartRawCandles[i].time, value }));
    const vwap = calcLineVWAP(chartRawCandles);
    const recent = chartRawCandles.slice(-24);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const support = recent.length ? Math.min(...recent.map(c => c.low)) : null;
    const resistance = recent.length ? Math.max(...recent.map(c => c.high)) : null;
    const supportLine = support !== null ? [{ time: first.time, value: support }, { time: last.time, value: support }] : [];
    const resistanceLine = resistance !== null ? [{ time: first.time, value: resistance }, { time: last.time, value: resistance }] : [];
    const trendLine = recent.length ? [{ time: first.time, value: first.close }, { time: last.time, value: last.close }] : [];

    chartSeries.ema9.setData(chartIndicators.ema9 ? ema9 : []);
    chartSeries.ema21.setData(chartIndicators.ema21 ? ema21 : []);
    chartSeries.vwap.setData(chartIndicators.vwap ? vwap : []);
    chartSeries.support.setData(chartIndicators.support ? supportLine : []);
    chartSeries.resistance.setData(chartIndicators.resistance ? resistanceLine : []);
    chartSeries.trend.setData(chartIndicators.trend ? trendLine : []);
  }

  function updateChartMarketPanels() {
    const last = chartRawCandles[chartRawCandles.length - 1];
    const coin = WATCHLIST.find(c => c.instrument === chartCoin) || findCoinByInstrument(chartCoin);
    const t = chartSnapshot || tickers[chartCoin] || null;
    const ohlcRow = document.getElementById('ohlcRow');
    if (ohlcRow && last) {
      const recent = chartRawCandles.slice(-24);
      const support = recent.length ? Math.min(...recent.map(c => c.low)) : 0;
      const resistance = recent.length ? Math.max(...recent.map(c => c.high)) : 0;
      ohlcRow.innerHTML = `
        <div class="ohlc-item"><div class="ohlc-label">Open</div><div class="ohlc-val">${fmtPrice(last.open)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">High</div><div class="ohlc-val" style="color:var(--color-green)">${fmtPrice(last.high)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Low</div><div class="ohlc-val" style="color:var(--color-red)">${fmtPrice(last.low)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Close</div><div class="ohlc-val">${fmtPrice(last.close)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Change</div><div class="ohlc-val ${posneg(last.close-last.open)}">${fmtPct(((last.close-last.open)/last.open)*100)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Support</div><div class="ohlc-val">${fmtPrice(support)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Resistance</div><div class="ohlc-val">${fmtPrice(resistance)}</div></div>
        ${coin ? `<div class="ohlc-item"><div class="ohlc-label">Coin</div><div class="ohlc-val" style="color:${coinColor(coin.sym)}">${coin.sym}</div></div>` : ''}
        <div class="ohlc-item"><div class="ohlc-label">Feed</div><div class="ohlc-val">${t?.source === 'coingecko' ? 'Gecko' : 'CDC'}</div></div>
      `;
    }

    const ob = document.getElementById('orderBook');
    if (ob) {
      const bid = parseFloat(t?.best_bid);
      const ask = parseFloat(t?.best_ask);
      const hasBook = t && Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && t.source !== 'coingecko';
      if (hasBook) {
        const spread = ((ask - bid) / bid * 100).toFixed(4);
        ob.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12px;font-family:var(--font-mono)">
            <div style="color:var(--color-text-muted);font-size:10px;text-transform:uppercase">Ask</div>
            <div style="color:var(--color-text-muted);font-size:10px;text-transform:uppercase;text-align:right">Bid</div>
            <div style="color:var(--color-red)">${fmtPrice(ask)}</div>
            <div style="color:var(--color-green);text-align:right">${fmtPrice(bid)}</div>
            <div style="color:var(--color-text-muted);font-size:10px">${t.best_ask_size || '—'}</div>
            <div style="color:var(--color-text-muted);font-size:10px;text-align:right">${t.best_bid_size || '—'}</div>
          </div>
          <div style="margin-top:10px;font-size:11px;color:var(--color-text-muted)">Spread: <span style="color:var(--color-gold)">${spread}%</span></div>
          <div style="font-size:11px;color:var(--color-text-muted);margin-top:4px">24h Vol: <span style="color:var(--color-text)">${fmtCompactUsd(volume(t))}</span></div>
        `;
      } else {
        ob.innerHTML = `
          <div class="empty-state" style="padding:20px 12px;text-align:left">
            <div style="font-size:12px;color:var(--color-text)">Order book unavailable for ${coin?.sym || chartCoin}</div>
            <div style="margin-top:6px">This chart is using ${t?.source === 'coingecko' ? 'CoinGecko fallback market data' : 'a candle-only feed'} tonight, so there is no native bid/ask ladder to display.</div>
            <div style="margin-top:8px;font-size:11px;color:var(--color-text-muted)">24h Vol: <span style="color:var(--color-text)">${fmtCompactUsd(volume(t))}</span></div>
          </div>
        `;
      }
    }

    const rt = document.getElementById('recentTrades');
    if (rt && last) {
      const side = last.close >= last.open ? 'BUY' : 'SELL';
      rt.innerHTML = `
        <div style="font-size:11px;color:var(--color-text-muted);margin-bottom:8px">Latest market snapshot</div>
        <div class="token-row">
          <span class="token-sym" style="color:${side === 'BUY' ? 'var(--color-green)' : 'var(--color-red)'}">${side}</span>
          <span class="token-name">Last Trade</span>
          <span class="token-bal">${fmtPrice(t ? price(t) : last.close)}</span>
        </div>
        <div class="token-row">
          <span class="token-sym" style="color:var(--color-primary)">EMA</span>
          <span class="token-name">Overlay Stack</span>
          <span class="token-bal">${chartIndicators.ema9 || chartIndicators.ema21 ? 'ON' : 'OFF'}</span>
        </div>
        <div class="token-row">
          <span class="token-sym" style="color:var(--color-gold)">VWAP</span>
          <span class="token-name">Benchmark Line</span>
          <span class="token-bal">${chartIndicators.vwap ? 'ON' : 'OFF'}</span>
        </div>
        <div class="token-row">
          <span class="token-sym" style="color:var(--color-text-muted)">FEED</span>
          <span class="token-name">${t?.source === 'coingecko' ? 'CoinGecko fallback' : 'Market snapshot'}</span>
          <span class="token-bal">${t?.source === 'coingecko' ? 'GECKO' : 'CDC'}</span>
        </div>
        <div class="token-row">
          <span class="token-sym" style="color:var(--color-text-muted)">VOL</span>
          <span class="token-name">24h Volume</span>
          <span class="token-bal">${fmtCompactUsd(volume(t))}</span>
        </div>
      `;
    }
  }

  async function loadCandles(options = {}) {
    const stage = document.getElementById('chartStage');
    if (!stage) return;
    const showLoader = options.showLoader !== false;

    // Map our TF labels to CDC API values
    const tfMap = { '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1D': '1D', '1W': '1W' };
    const tf = tfMap[chartTf] || '1h';

    try {
      if (showLoader) setChartLoading(true);
      const candles = await fetchCandlesticks(chartCoin, tf);
      chartSnapshot = tickers[chartCoin] || null;
      const series = candles
        .map(c => ({
          time: Math.floor(c[0] / 1000),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5] || 0),
        }))
        .sort((a, b) => a.time - b.time);

      ensureChart(stage);
      chartRawCandles = series;
      chartSeries.candles.setData(series.map(({ volume, ...rest }) => rest));
      chartSeries.volume.setData(series.map(c => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,212,126,0.3)' : 'rgba(255,75,110,0.3)',
      })));
      updateChartOverlays();
      updateChartMarketPanels();
      candleChart.timeScale().fitContent();
      setChartLoading(false);

    } catch (err) {
      console.error('Candles error:', err);
      const container = document.getElementById('chartContainer');
      if (container && !candleChart) container.innerHTML = `<div class="error-notice">⚠ Could not load candles: ${err.message}</div>`;
      setChartLoading(false);
    }
  }

  // ================================================================
  // VIEW: ON-CHAIN (Blockscout + Live Blockchain Scanners)
  // ================================================================

  const CHAIN_COLORS = {
    BTC: '#f7931a', ETH: '#627eea', SOL: '#9945ff',
    XRP: '#00aae4', BNB: '#f3ba2f', DOGE: '#c2a633', HYPE: '#00d4aa',
  };

  function buildChainScanPlaceholders() {
    return ['BTC','ETH','SOL','XRP','BNB','DOGE','HYPE'].map(sym => `
      <div class="chain-scan-card" id="chain-card-${sym}">
        <div class="chain-scan-header">
          <span class="chain-scan-sym" style="color:${CHAIN_COLORS[sym]}">${sym}</span>
          <span class="chain-scan-badge neutral">LOADING</span>
        </div>
        <div class="chain-scan-loading">Fetching on-chain data…</div>
      </div>
    `).join('');
  }

  function buildChainCard(d) {
    const color  = CHAIN_COLORS[d.sym] || '#888';
    const sigCls = d.signal === 'BULLISH' ? 'bullish' : d.signal === 'BEARISH' ? 'bearish' : 'neutral';
    const ago    = d.ts ? Math.round((Date.now() - d.ts) / 1000) : null;
    const agoStr = ago !== null ? (ago < 60 ? `${ago}s ago` : `${Math.round(ago/60)}m ago`) : '';
    if (d.error) {
      return `
        <div class="chain-scan-card" id="chain-card-${d.sym}">
          <div class="chain-scan-header">
            <span class="chain-scan-sym" style="color:${color}">${d.sym}</span>
            <span class="chain-scan-badge neutral">OFFLINE</span>
          </div>
          <div style="font-size:11px;color:var(--color-text-muted);padding:8px 0">${escapeHtml(d.error)}</div>
          <div class="chain-scan-footer">
            <span>${d.source || '—'}</span><span>${agoStr}</span>
          </div>
        </div>`;
    }
    const metricsHtml = (d.metrics || []).map(m => `
      <div class="chain-metric-row">
        <span class="chain-metric-key">${escapeHtml(m.k)}</span>
        <span class="chain-metric-val">${escapeHtml(m.v)}</span>
      </div>`).join('');
    return `
      <div class="chain-scan-card" id="chain-card-${d.sym}">
        <div class="chain-scan-header">
          <div>
            <span class="chain-scan-sym" style="color:${color}">${d.sym}</span>
            <span class="chain-scan-chain">${escapeHtml(d.chain)}</span>
          </div>
          <span class="chain-scan-badge ${sigCls}">${d.signal}</span>
        </div>
        <div class="chain-scan-metrics">${metricsHtml}</div>
        <div class="chain-scan-footer">
          <span>${escapeHtml(d.source)}</span>
          <a href="${d.explorerUrl}" target="_blank" class="chain-scan-link">Explorer ↗</a>
          <span>${agoStr}</span>
        </div>
      </div>`;
  }

  function refreshChainScanUI() {
    const grid = document.getElementById('chainScanGrid');
    const age  = document.getElementById('chainScanAge');
    if (!grid) return;
    const all = window.BlockchainScan?.getAll() || {};
    const syms = ['BTC','ETH','SOL','XRP','BNB','DOGE','HYPE'];
    if (!Object.keys(all).length) {
      if (age) age.textContent = 'Waiting for data…';
      return;
    }
    // Update each card individually to avoid full re-render flicker
    syms.forEach(sym => {
      const d    = all[sym];
      const slot = document.getElementById(`chain-card-${sym}`);
      if (!d || !slot) return;
      slot.outerHTML = buildChainCard(d);
    });
    if (age) {
      const oldest = Math.min(...syms.filter(s => all[s]?.ts).map(s => all[s].ts));
      const sec = Math.round((Date.now() - oldest) / 1000);
      age.textContent = sec < 60 ? `Updated ${sec}s ago` : `Updated ${Math.round(sec/60)}m ago`;
    }
  }

  function renderOnChain() {
    content.innerHTML = `
      <div style="margin-bottom:14px">
        <div class="error-notice" style="background:var(--color-primary-dim);border-color:var(--color-primary);color:var(--color-primary)">
          ℹ Use wallet activity as a confirmation layer for narrative, treasury, and whale flow behind UP/DOWN calls.
        </div>
      </div>
      <div class="onchain-grid">
        <div class="card">
          <div class="card-title">Wallet Lookup — Ethereum</div>
          <div class="wallet-input-wrap">
            <input class="wallet-input" id="walletInput" placeholder="0x wallet address" type="text">
            <button class="btn-sm" id="lookupBtn">Lookup</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
            <span style="font-size:10px;color:var(--color-text-muted)">⚙ Etherscan key (optional, improves fallback):</span>
            <input id="etherscanKeyInput" type="password" placeholder="paste API key" value="${localStorage.getItem('etherscanApiKey') || ''}"
              style="flex:1;background:var(--color-surface-2);border:1px solid var(--color-border-dim);color:var(--color-text);border-radius:4px;padding:3px 6px;font-size:10px;font-family:var(--font-mono)">
            <button class="btn-sm" id="saveEsKey" style="font-size:10px;padding:3px 8px">Save</button>
          </div>
          <div id="walletResult">
            <div class="empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
              Enter a wallet address above
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Tracked Token Flows</div>
          <div id="tokenBalances">
            <div class="empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              Waiting for wallet lookup
            </div>
          </div>
        </div>

        <div class="card" style="grid-column:1/-1">
          <div class="card-title">Recent Flow</div>
          <div id="txHistory">
            <div class="empty-state">No transactions loaded</div>
          </div>
        </div>

        <!-- Live chain intelligence — full-width spanning section -->
        <div class="card" style="grid-column:1/-1">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <div class="card-title" style="margin-bottom:0">Live Chain Intelligence</div>
            <div style="display:flex;align-items:center;gap:10px">
              <span id="chainScanAge" style="font-size:10px;color:var(--color-text-muted)">Loading…</span>
              <button class="btn-sm" id="chainScanRefreshBtn" style="font-size:11px;padding:4px 10px">↻ Refresh</button>
            </div>
          </div>
          <div class="chain-scan-grid" id="chainScanGrid">
            ${buildChainScanPlaceholders()}
          </div>
        </div>
      </div>
    `;

    // Wallet lookup
    const lookupBtn = document.getElementById('lookupBtn');
    const walletInput = document.getElementById('walletInput');
    if (lookupBtn && walletInput) {
      const doLookup = async () => {
        const addr = walletInput.value.trim();
        if (!addr) return;
        lookupBtn.textContent = 'Loading...';
        lookupBtn.disabled = true;
        try {
          const [tokenData, txData] = await Promise.all([
            fetchWalletTokens(addr),
            fetchWalletTxs(addr)
          ]);
          renderWalletResult(addr, tokenData, txData);
        } catch (err) {
          document.getElementById('walletResult').innerHTML = `<div class="error-notice">⚠ ${err.message}</div>`;
          document.getElementById('tokenBalances').innerHTML = `<div class="error-notice">⚠ Could not fetch token balances</div>`;
        }
        lookupBtn.textContent = 'Lookup';
        lookupBtn.disabled = false;
      };
      lookupBtn.addEventListener('click', doLookup);
      walletInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
    }

    // Etherscan key save
    const saveEsKey = document.getElementById('saveEsKey');
    if (saveEsKey) {
      saveEsKey.addEventListener('click', () => {
        const val = (document.getElementById('etherscanKeyInput')?.value || '').trim();
        if (val) { localStorage.setItem('etherscanApiKey', val); saveEsKey.textContent = 'Saved ✓'; }
        else { localStorage.removeItem('etherscanApiKey'); saveEsKey.textContent = 'Cleared'; }
        setTimeout(() => { saveEsKey.textContent = 'Save'; }, 1500);
      });
    }

    // Chain scan — show cached data immediately, then listen for live updates
    refreshChainScanUI();
    const chainRefreshBtn = document.getElementById('chainScanRefreshBtn');
    if (chainRefreshBtn) {
      chainRefreshBtn.addEventListener('click', () => {
        chainRefreshBtn.disabled = true;
        chainRefreshBtn.textContent = '…';
        window.BlockchainScan?.fetchAll().then(() => {
          chainRefreshBtn.disabled = false;
          chainRefreshBtn.textContent = '↻ Refresh';
        });
      });
    }
  }

  function renderWalletResult(addr, tokenData, txData) {
    const src = window._walletDataSource || 'blockscout';
    const srcLabel = { blockscout: 'Blockscout', ethplorer: 'Ethplorer', etherscan: 'Etherscan' }[src] || src;
    // Wallet summary
    const wResult = document.getElementById('walletResult');
    if (wResult) {
      wResult.innerHTML = `
        <div style="font-size:12px;color:var(--color-text-muted);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span>Address: <span style="font-family:var(--font-mono);color:var(--color-primary)">${escapeHtml(formatAddress(addr))}</span></span>
          <span class="wallet-source-badge ${src}">${srcLabel}</span>
          <a href="https://eth.blockscout.com/address/${encodeURIComponent(addr)}" target="_blank" style="font-size:10px;color:var(--color-primary)">Blockscout ↗</a>
          <a href="https://etherscan.io/address/${encodeURIComponent(addr)}" target="_blank" style="font-size:10px;color:var(--color-primary)">Etherscan ↗</a>
        </div>
        <div style="font-size:13px">
          Found <strong>${Array.isArray(tokenData) ? tokenData.length : 0}</strong> ERC-20 tokens
          and <strong>${txData?.items?.length || 0}</strong> recent transactions
        </div>
      `;
    }

    // Token balances
    const tb = document.getElementById('tokenBalances');
    if (tb) {
      const tokens = Array.isArray(tokenData) ? tokenData.filter(t => t.token && parseFloat(t.value) > 0) : [];
      if (tokens.length === 0) {
        tb.innerHTML = '<div class="empty-state" style="padding:20px">No ERC-20 tokens found (or wallet is empty)</div>';
      } else {
        tb.innerHTML = tokens.slice(0, 20).map(t => {
          const decimals = parseInt(t.token?.decimals || 18);
          const bal = parseFloat(t.value) / Math.pow(10, decimals);
          const sym = t.token?.symbol || '?';
          const tickerKey = sym + 'USD';
          const livePrice = tickers[tickerKey] ? price(tickers[tickerKey]) : null;
          const usdVal = livePrice ? bal * livePrice : null;
          return `
            <div class="token-row">
              <span class="token-sym">${escapeHtml(sym)}</span>
              <span class="token-name">${t.token?.address ? `<a href="https://etherscan.io/token/${encodeURIComponent(t.token.address)}" target="_blank" style="color:inherit;text-decoration:none">${escapeHtml(t.token?.name || '—')}</a>` : escapeHtml(t.token?.name || '—')}</span>
              <span class="token-bal">${fmt(bal, 4)}</span>
              <span class="token-val">${usdVal ? '$' + fmt(usdVal, 2) : '—'}</span>
            </div>
          `;
        }).join('');
      }
    }

    // Transactions
    const txH = document.getElementById('txHistory');
    if (txH) {
      const txs = txData?.items || [];
      if (txs.length === 0) {
        txH.innerHTML = '<div class="empty-state">No recent transactions</div>';
      } else {
        txH.innerHTML = txs.slice(0, 10).map(tx => {
          const isIn = tx.to?.hash?.toLowerCase() === addr.toLowerCase();
          const val = tx.value ? (parseFloat(tx.value) / 1e18).toFixed(6) : '0';
          const age = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : '—';
          return `
            <div class="tx-row">
              <div class="tx-hash" onclick="window.open('https://etherscan.io/tx/${encodeURIComponent(tx.hash || '')}','_blank')">${tx.hash ? escapeHtml(tx.hash.slice(0, 10) + '...' + tx.hash.slice(-8)) : '—'}</div>
              <div class="tx-meta">${escapeHtml(age)} · ${escapeHtml(tx.method || 'transfer')} · Gas: ${escapeHtml(tx.gas_used || '—')}</div>
              <div class="tx-val ${isIn ? 'in' : 'out'}">${isIn ? '+ ' : '- '}${val} ETH</div>
              <div style="font-size:10px;color:var(--color-text-muted)"><a href="https://eth.blockscout.com/tx/${encodeURIComponent(tx.hash || '')}" target="_blank" style="color:var(--color-primary)">Blockscout</a> · <a href="https://etherscan.io/tx/${encodeURIComponent(tx.hash || '')}" target="_blank" style="color:var(--color-primary)">Etherscan</a></div>
            </div>
          `;
        }).join('');
      }
    }
  }

  // ================================================================
  // VIEW: SCREENER
  // ================================================================

  function sortScreenerCoins(coins) {
    return [...coins].sort((a, b) => {
      if (screenerSortBy === 'alpha') return screenerSortDir === -1 ? b.sym.localeCompare(a.sym) : a.sym.localeCompare(b.sym);
      const av = screenerSortBy === 'marketCap' ? marketCap(a.meta) : screenerSortBy === 'volume' ? (a.meta?.totalVolume || a.vol) : a.change;
      const bv = screenerSortBy === 'marketCap' ? marketCap(b.meta) : screenerSortBy === 'volume' ? (b.meta?.totalVolume || b.vol) : b.change;
      return compareNumbers(av, bv, screenerSortDir);
    });
  }

  async function renderScreener() {
    const _myRV = _rv; // capture version — bail after any await if stale
    if (!Object.keys(screenerMetaCache).length) {
      content.innerHTML = `<div class="loading-screen"><div class="loader-ring"></div><p>Loading market overview...</p></div>`;
      try { await fetchScreenerMeta(); } catch (e) { /* use stale cache or empty */ }
      if (_rv !== _myRV) return; // user navigated away during meta fetch
    } else {
      fetchScreenerMeta().catch(() => {});
    }

    const coins = sortScreenerCoins(WATCHLIST.map(c => {
      const t = tickers[c.instrument];
      const ch = change(t);
      const meta = screenerMetaCache[c.sym] || {};
      return { ...c, ticker: t, change: ch, price: price(t), vol: volume(t), meta };
    }));

    const gainers = coins.filter(c => c.change > 3);
    const losers  = coins.filter(c => c.change < -3);
    const hot     = coins.filter(c => (c.meta?.totalVolume || c.vol) > 100000);
    const topCap = WATCHLIST
      .map(c => ({ ...c, meta: screenerMetaCache[c.sym] || {} }))
      .filter(c => marketCap(c.meta) > 0)
      .sort((a, b) => marketCap(b.meta) - marketCap(a.meta))
      .slice(0, 5);

    content.innerHTML = `
      <div class="kpi-bar" style="margin-bottom:20px">
        <div class="kpi-card"><div class="kpi-label">Signal Candidates</div><div class="kpi-val blue">${gainers.length + losers.length}</div><div class="kpi-sub">±3% tape expansion threshold</div></div>
        <div class="kpi-card"><div class="kpi-label">UP Bias >3%</div><div class="kpi-val green">${gainers.length}</div></div>
        <div class="kpi-card"><div class="kpi-label">DOWN Bias >3%</div><div class="kpi-val red">${losers.length}</div></div>
        <div class="kpi-card"><div class="kpi-label">High Activity Tape</div><div class="kpi-val gold">${hot.length}</div><div class="kpi-sub">>$100k daily volume</div></div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-title">Directory Controls</div>
        <div class="screener-toolbar">
          <div class="coin-select-wrap">
            <span class="ctrl-label">Sort</span>
            <select class="ctrl-select" id="screenerSortSelect">
              <option value="marketCap" ${screenerSortBy === 'marketCap' ? 'selected' : ''}>Market Cap</option>
              <option value="volume" ${screenerSortBy === 'volume' ? 'selected' : ''}>Volume</option>
              <option value="change" ${screenerSortBy === 'change' ? 'selected' : ''}>24h Change</option>
              <option value="alpha" ${screenerSortBy === 'alpha' ? 'selected' : ''}>Alphabetical</option>
            </select>
          </div>
          <div class="tf-btns">
            <button class="tf-btn ${screenerSortDir === -1 ? 'active' : ''}" data-screener-dir="-1">Desc</button>
            <button class="tf-btn ${screenerSortDir === 1 ? 'active' : ''}" data-screener-dir="1">Asc</button>
          </div>
          <div class="screener-summary-strip">
            ${topCap.map(c => `<span class="screener-chip">${c.sym} ${c.meta?.rank ? '#' + c.meta.rank : ''}</span>`).join('')}
          </div>
        </div>
      </div>

      <div class="section-header"><span class="section-title">All Monitored Markets</span><span style="font-size:11px;color:var(--color-text-muted)">Sorted by ${screenerSortBy === 'alpha' ? 'alphabetical order' : screenerSortBy === 'marketCap' ? 'market cap' : screenerSortBy === 'volume' ? 'daily volume' : '24h change'}</span></div>
      <div class="screener-grid">
        ${coins.map(c => screenerCard(c, c.change > 0 ? 'bullish' : 'bearish')).join('')}
      </div>
    `;

    const sortSelect = document.getElementById('screenerSortSelect');
    if (sortSelect) sortSelect.addEventListener('change', e => {
      screenerSortBy = e.target.value;
      renderScreener();
    });
    content.querySelectorAll('[data-screener-dir]').forEach(btn => {
      btn.addEventListener('click', () => {
        screenerSortDir = Number(btn.dataset.screenerDir);
        renderScreener();
      });
    });

    // Draw sparklines in screener cards
    requestAnimationFrame(() => {
      coins.forEach(c => {
        const canvas = document.getElementById(`sc-spark-${c.sym}`);
        if (!canvas) return;
        const data = sparkData[c.sym];
        if (!data || data.length < 2) return;
        const ctx = canvas.getContext('2d');
        const isUp = c.change >= 0;
        const color = isUp ? '#26d47e' : '#ff4b6e';
        const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        ctx.beginPath();
        data.forEach((v, i) => {
          const x = (i / (data.length - 1)) * W;
          const y = H - ((v - min) / range) * H;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    });

    // Click screener cards → navigate to charts
    content.querySelectorAll('[data-sc-chart]').forEach(card => {
      card.addEventListener('click', () => {
        chartCoin = card.dataset.scChart;
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('[data-view="charts"]').classList.add('active');
        currentView = 'charts';
        if (pageTitle) pageTitle.textContent = 'Market Structure';
        render();
      });
    });
  }

  function screenerCard(c, sentiment) {
    const inPortfolio = PORTFOLIO_HOLDINGS.some(h => h.sym === c.sym);
    const signalLabel = c.change > 5 ? 'UP' : c.change > 1 ? 'Lean UP' : c.change < -5 ? 'DOWN' : c.change < -1 ? 'Lean DOWN' : 'No Bet';
    const logo = c.meta?.image;
    return `
      <div class="screener-card ${sentiment}" data-sc-chart="${c.instrument}" style="cursor:pointer">
        <div class="sc-header-row">
          <div class="sc-token-wrap">
            <div class="sc-token-icon" style="background:${coinColor(c.sym)}22;color:${coinColor(c.sym)}">${coinIcon(c.sym)}</div>
            <div>
              <div class="sc-ticker" style="color:${coinColor(c.sym)}">${c.sym}</div>
              <div class="sc-name">${c.name}</div>
            </div>
          </div>
          ${inPortfolio ? '<span style="font-size:9px;color:var(--color-gold);font-weight:700">MODELED ●</span>' : ''}
        </div>
        <div class="sc-price">${c.price ? fmtPrice(c.price) : '—'}</div>
        <div class="sc-chg ${posneg(c.change)}">${c.ticker ? fmtPct(c.change) : '—'}</div>
        <div class="sc-meta-grid">
          <div class="sc-vol">MCap: ${fmtCompactUsd(c.meta?.marketCap)}</div>
          <div class="sc-vol">Vol: ${fmtCompactUsd(c.meta?.totalVolume || c.vol)}</div>
          <div class="sc-vol">Rank: ${c.meta?.rank || '—'}</div>
          <div class="sc-vol">Source: ${c.meta?.geckoId ? 'Gecko' : 'Ticker'}</div>
        </div>
        <div class="signal-badge ${sentiment}">
          <span>${signalLabel}</span>
        </div>
        <div class="sc-sparkwrap">
          <canvas id="sc-spark-${c.sym}" width="200" height="40"></canvas>
        </div>
      </div>
    `;
  }

  // ================================================================
  // VIEW: CFM BENCHMARK
  // ================================================================

  let cfmStarted = false;
  let _cfmStarting = false;

  // ================================================================
  // SUBORBITAL PERIODIC TABLE — Element Definitions
  //
  // Like actual chemistry: heavier coins fill more electron shells.
  //   BTC/ETH = heavy elements (atomic mass ~80) → all 7 shells, 22 orbitals
  //   SOL/XRP/BNB = mid-weight (~40) → 5 shells, 18 orbitals
  //   DOGE/HYPE = light elements (~20) → 3 shells, 12 orbitals
  //
  // Shells:
  //   1s = Price Benchmarks (core — every element has these)
  //   2s = Momentum Oscillators
  //   2p = Trend Signals
  //   3s = Volume & Flow
  //   3p = Order Book Microstructure   (mid+heavy only)
  //   3d = Cross-Exchange Arbitrage    (mid+heavy only)
  //   4f = Deep Microstructure         (heavy only)
  // ================================================================

  const SUBORBITALS = [
    // ---- Shell 1s: Price Benchmarks (ALL coins) ----
    { num: 1,  sym: 'CFM', name: 'CFM Rate',         shell: '1s', key: 'cfmRate',      fmt: 'price', desc: 'VWM partition average (CF Benchmarks method)', weight: 'all' },
    { num: 2,  sym: 'VWP', name: 'VWAP-15',           shell: '1s', key: 'vwap15',       fmt: 'price', desc: 'Volume-weighted average price (15min)', weight: 'all' },
    { num: 3,  sym: 'TWP', name: 'TWAP-15',           shell: '1s', key: 'twap15',       fmt: 'price', desc: 'Time-weighted average price (15min)', weight: 'all' },
    { num: 4,  sym: 'SPT', name: 'Spot',              shell: '1s', key: 'lastPrice',    fmt: 'price', desc: 'Latest spot price across sources', weight: 'all' },

    // ---- Shell 2s: Momentum Oscillators (ALL coins) ----
    { num: 5,  sym: 'RSI', name: 'RSI(14)',            shell: '2s', key: '_rsi',         fmt: 'num1',  desc: 'Relative Strength Index — overbought/oversold', weight: 'all' },
    { num: 6,  sym: 'MOM', name: 'Momentum',           shell: '2s', key: 'momentum',     fmt: 'pct3',  desc: 'Rate of change over 5 polling cycles', weight: 'all' },
    { num: 7,  sym: 'MCD', name: 'MACD',               shell: '2s', key: '_macd',        fmt: 'sign4', desc: 'VWAP-TWAP divergence (MACD proxy)', weight: 'all' },

    // ---- Shell 2p: Trend Signals (ALL coins) ----
    { num: 8,  sym: 'EMA', name: 'EMA 9/21',           shell: '2p', key: '_emaCross',    fmt: 'pct3',  desc: 'Fast/slow EMA crossover spread', weight: 'all' },
    { num: 9,  sym: 'TRD', name: 'Trend',              shell: '2p', key: 'trend',        fmt: 'trend', desc: '15-min window direction', weight: 'all' },

    // ---- Shell 3s: Volume & Flow (ALL coins) ----
    { num: 10, sym: 'OBV', name: 'OBV Slope',          shell: '3s', key: '_obvSlope',    fmt: 'sign2', desc: 'On-Balance Volume — accumulation/distribution', weight: 'all' },
    { num: 11, sym: 'VDL', name: 'Vol Delta',          shell: '3s', key: '_volRatio',    fmt: 'ratio', desc: 'Buy vs sell volume ratio', weight: 'all' },
    { num: 12, sym: 'ATR', name: 'Volatility',         shell: '3s', key: '_atrPct',      fmt: 'pct2',  desc: 'ATR as percentage of price', weight: 'all' },

    // ---- Shell 3p: Order Book Micro (MID + HEAVY only) ----
    { num: 13, sym: 'BAS', name: 'Bid-Ask',            shell: '3p', key: 'bidAsk',       fmt: 'pct4',  desc: 'Bid-ask spread — market tightness', weight: 'mid' },
    { num: 14, sym: 'BKI', name: 'Book Imbal',         shell: '3p', key: '_bookImbal',   fmt: 'sign2', desc: 'Order book bid/ask weight imbalance', weight: 'mid' },
    { num: 15, sym: 'AGR', name: 'Aggressor',          shell: '3p', key: '_aggrBuy',     fmt: 'pct1',  desc: 'Buy-side aggressor ratio from trade tape', weight: 'mid' },

    // ---- Shell 3d: Cross-Exchange Arbitrage (MID + HEAVY only) ----
    { num: 16, sym: 'XSP', name: 'X-Spread',           shell: '3d', key: 'spread',       fmt: 'pct3',  desc: 'Cross-exchange price divergence', weight: 'mid' },
    { num: 17, sym: 'CVG', name: 'Convergence',        shell: '3d', key: 'convergence',  fmt: 'pct3',  desc: 'How tightly sources agree (lower=better)', weight: 'mid' },
    { num: 18, sym: 'SRC', name: 'Sources',             shell: '3d', key: 'sourceCount',  fmt: 'of4',   desc: 'Number of active constituent exchanges', weight: 'mid' },

    // ---- Shell 3d+: Derivatives (MID + HEAVY) ----
    { num: 19, sym: 'FND', name: 'Funding Rate',       shell: '3d', key: '_funding',      fmt: 'fundingRate', desc: 'Perp futures funding rate — +longs pay, -shorts pay', weight: 'mid' },
    { num: 20, sym: 'OI',  name: 'Open Interest',      shell: '3d', key: '_oi',           fmt: 'compactUsd', desc: 'Total open interest in futures markets', weight: 'mid' },
    { num: 21, sym: 'SQZ', name: 'Squeeze Risk',       shell: '3d', key: '_squeezeScore', fmt: 'squeeze', desc: 'Liquidation cascade / squeeze probability', weight: 'mid' },

    // ---- Shell 4s: CVD + Coinbase Premium (HEAVY only) ----
    { num: 22, sym: 'CVD', name: 'Cum Vol Delta',      shell: '4s', key: '_cvdSlope',     fmt: 'sign2', desc: 'CVD slope — buyer/seller exhaustion detector', weight: 'heavy' },
    { num: 23, sym: 'CBP', name: 'CB Premium',         shell: '4s', key: '_cbPremium',   fmt: 'pct3',  desc: 'Coinbase price vs CFM rate — institutional flow proxy', weight: 'heavy' },
    { num: 24, sym: 'CBS', name: 'CB Spread',          shell: '4s', key: 'cbSpread',     fmt: 'pct4',  desc: 'Coinbase buy-sell spread', weight: 'heavy' },

    // ---- Shell 4f: Deep Microstructure (HEAVY only) ----
    { num: 25, sym: 'DXV', name: 'DEX Vol',            shell: '4f', key: '_dexVol',      fmt: 'compactUsd', desc: 'On-chain DEX 24h volume', weight: 'heavy' },
    { num: 26, sym: 'DXL', name: 'DEX Liq',            shell: '4f', key: '_dexLiq',      fmt: 'compactUsd', desc: 'On-chain DEX liquidity depth', weight: 'heavy' },

    // ---- Shell 5s: Market Consensus (ALL coins, requires PredictionMarkets) ----
    { num: 27, sym: 'MKT', name: 'Mkt Consensus',      shell: '5s', key: '_mktConsensus', fmt: 'prob1',      desc: 'Kalshi + Polymarket implied UP probability', weight: 'all' },

    // ---- Shell 5p: Social Sentiment (ALL coins, requires x.ai API key) ----
    { num: 28, sym: 'SNT', name: 'X Sentiment',         shell: '5p', key: '_xSentiment',  fmt: 'sentiment',  desc: 'X.com real-time crowd sentiment via Grok AI (-100 to +100)', weight: 'all' },
  ];

  async function renderCFM() {
    const _myRV = _rv; // capture version — bail after any await if stale

    // Start engine in background if not started — DON'T await it blocking the render
    if (!cfmStarted && !_cfmStarting) {
      _cfmStarting = true;
      CFMEngine.start()
        .then(() => { cfmStarted = true; _cfmStarting = false; if (currentView === 'cfm') render(); })
        .catch(e => { _cfmStarting = false; console.error('[CFM] engine start failed:', e); if (currentView === 'cfm') render(); });
      // Also kick off predictions in background
      if (!predsLoaded) {
        PredictionEngine.runAll()
          .then(() => { predsLoaded = true; snapshotPredictions(); })
          .catch(() => {});
      }
      if (window.PredictionMarkets && !window._mktStarted) { window.PredictionMarkets.start(); window._mktStarted = true; }
    }
    // Start 15M market resolver
    if (window.MarketResolver && !window._resolverStarted) {
      window.MarketResolver.start();
      window._resolverStarted = true;
    }

    // Render immediately with whatever data we have (may be empty on first call)
    const cfmAll = CFMEngine.getAll();
    const predAll = PredictionEngine.getAll ? PredictionEngine.getAll() : {};
    const status = CFMEngine.getStatus ? CFMEngine.getStatus() : {};

    // Add a loading banner at the top if still loading
    const loadingBanner = (!cfmStarted)
      ? `<div style="display:flex;align-items:center;gap:10px;padding:8px 16px;background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.3);border-radius:6px;margin-bottom:12px;font-size:13px;color:#ffc107"><div style="width:16px;height:16px;border:2px solid rgba(255,193,7,0.3);border-top-color:#ffc107;border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0"></div><span>Assembling CFM benchmarks\u2026</span></div>`
      : '';

    if (_rv !== _myRV) return; // guard: stale render version

    content.innerHTML = `
      ${loadingBanner}
      <div class="engine-hero">
        <div>
          <div class="engine-eyebrow">CFM Benchmark Orchestrator</div>
          <h2 class="engine-title">Constituent-driven benchmarks for short-horizon UP/DOWN calls</h2>
          <p class="engine-copy">This surface consolidates spot, venue premium, and on-chain liquidity into a defensible benchmark, then layers microstructure and derivatives context on top so each market can be staged as UP, DOWN, or NO BET.</p>
        </div>
        <div class="engine-meta-grid">
          <div class="engine-meta-card"><span>Targets</span><strong>${PREDICTION_COINS.length}</strong><small>benchmark markets</small></div>
          <div class="engine-meta-card"><span>Constituents</span><strong>4</strong><small>CDC · CB · GKO · DEX</small></div>
          <div class="engine-meta-card"><span>Cadence</span><strong>15s</strong><small>rolling 15m partitions</small></div>
          <div class="engine-meta-card"><span>Decision Horizon</span><strong>1-15m</strong><small>predictive UP/DOWN ladder</small></div>
        </div>
      </div>

      <!-- Orchestrator Status Bar -->
      <div class="cfm-orch-bar">
        <div class="cfm-orch-item"><span class="cfm-orch-dot ${status.running ? 'ok' : 'off'}"></span><span>${status.running ? 'Live' : 'Off'}</span></div>
        <div class="cfm-orch-item">Cycle <span class="cfm-orch-val">#${status.cycle}</span></div>
        <div class="cfm-orch-item">\u0394 <span class="cfm-orch-val">${status.lastMs}ms</span></div>
        <div class="cfm-orch-item">Poll <span class="cfm-orch-val">15s</span></div>
        <div style="margin-left:auto;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${Object.entries(status.sources).map(([k, v]) => `
            <div class="cfm-orch-item" style="border-left:2px solid ${v.color};padding-left:6px">
              <span class="cfm-orch-dot ${v.pct > 80 ? 'warn' : 'ok'}"></span>
              <span>${v.label}</span>
              <span class="cfm-orch-val">${v.used}/${v.budget}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Shell Legend + Weight Classes -->
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:10px;color:var(--color-text-muted);flex-wrap:wrap;align-items:center">
        <span style="font-weight:600;color:var(--color-text)">Shells:</span>
        <span><span class="cfm-shell s" style="position:static">1s</span> Price</span>
        <span><span class="cfm-shell s" style="position:static">2s</span> Momentum</span>
        <span><span class="cfm-shell p" style="position:static">2p</span> Trend</span>
        <span><span class="cfm-shell s" style="position:static">3s</span> Volume</span>
        <span><span class="cfm-shell p" style="position:static">3p</span> Book</span>
        <span><span class="cfm-shell d" style="position:static">3d</span> Arb</span>
        <span><span class="cfm-shell s" style="position:static">4s</span> CB Prem</span>
        <span><span class="cfm-shell f" style="position:static">4f</span> DEX Deep</span>
        <span><span class="cfm-shell s" style="position:static">5s</span> Mkt Consensus</span>
        <span><span class="cfm-shell p" style="position:static">5p</span> X Sentiment</span>
        <span style="border-left:1px solid var(--color-border);padding-left:8px;margin-left:4px">
          <span style="color:var(--color-gold)">\u25cf</span> Heavy (22)
          <span style="color:var(--color-primary)">\u25cf</span> Mid (18)
          <span style="color:var(--color-text-faint)">\u25cf</span> Light (12)
        </span>
        <span style="margin-left:auto;font-size:9px"><span style="color:#1a6eff">\u25cf</span> CDC <span style="color:#0052ff">\u25cf</span> CB <span style="color:#8dc63f">\u25cf</span> GKO <span style="color:#a259ff">\u25cf</span> DEX</span>
      </div>

      <!-- WECRYPTO x.ai Sentiment Login -->
      <div id="xai-sentiment-panel" style="margin-bottom:12px"></div>

      <!-- Opportunities Panel -->
      ${buildOpportunitiesPanel(cfmAll, predAll)}

      <!-- Per-coin periodic tables -->
      ${PREDICTION_COINS.map(coin => {
        const cfm = cfmAll[coin.sym];
        const pred = predAll[coin.sym];
        if (!cfm || cfm.cfmRate === 0) return '';
        return buildCoinPeriodicTable(coin, cfm, pred);
      }).join('')}

      <!-- Methodology -->
      <div class="card" style="margin-top:8px">
        <div class="card-title">CFM Methodology</div>
        <div style="font-size:11px;color:var(--color-text-muted);line-height:1.5">
          Each coin's periodic table maps the benchmark, microstructure, and conviction layers used to issue short-horizon UP/DOWN calls.
          <strong>1s</strong> establishes the benchmark via <a href="https://docs.cfbenchmarks.com" target="_blank" style="color:var(--color-primary)">CF Benchmarks style VWM partitions</a>.
          <strong>2s / 2p</strong> score momentum and trend alignment.
          <strong>3s / 3p / 3d</strong> capture flow, book pressure, and cross-venue dispersion.
          <strong>4s / 4f</strong> add institutional premium, derivatives crowding, and DEX depth.
          The result is a benchmark-backed decision surface for UP, DOWN, or stand-aside execution.
        </div>
      </div>
    `;

    // Hydrate WECRYPTO sentiment panel (scripts in innerHTML don't execute)
    (function() {
      const panel = document.getElementById('xai-sentiment-panel');
      if (!panel) return;
      try {
        const connected = window.SocialSentiment && window.SocialSentiment.hasKey();
        if (connected) {
          panel.innerHTML = '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(38,212,126,0.07);border:1px solid rgba(38,212,126,0.25);border-left:3px solid #a855f7;border-radius:var(--radius-md)">' +
            '<span style="font-size:18px">\uD835\uDD4F</span>' +
            '<div style="flex:1"><div style="font-size:11px;font-weight:700;color:var(--color-green)">\u25cf WECRYPTO Connected \u2014 Shell 5p Live</div>' +
            '<div style="font-size:10px;color:var(--color-text-muted);margin-top:2px">X.com tweets fetched at :00 :15 :30 :45</div></div>' +
            '<button onclick="if(window.SocialSentiment){window.SocialSentiment.disconnect();location.reload();}" ' +
            'style="font-size:10px;padding:4px 10px;background:var(--color-surface-3);border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-muted);cursor:pointer">Disconnect</button></div>';
        } else {
          panel.innerHTML = '<div id="xai-login-wrap" style="padding:14px 16px;background:var(--color-surface-2);border:1px solid var(--color-border);border-left:3px solid #a855f7;border-radius:var(--radius-md)">' +
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><span style="font-size:20px">\uD835\uDD4F</span>' +
            '<div><div style="font-size:13px;font-weight:800;color:var(--color-text)">WECRYPTO \u2014 X.com Sentiment</div>' +
            '<div style="font-size:10px;color:var(--color-text-muted);margin-top:1px">Shell 5p \u00b7 Twitter API v2 \u00b7 Live crowd mood</div></div></div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">' +
            '<div style="display:flex;flex-direction:column;gap:5px;flex:1;min-width:150px">' +
            '<label style="font-size:10px;font-weight:700;color:var(--color-text-muted);text-transform:uppercase">Client ID</label>' +
            '<input id="xai-clientid" type="text" placeholder="Z-hx--\u2026" autocomplete="off" ' +
            'style="padding:8px 10px;background:var(--color-surface-3);border:1px solid var(--color-border);border-radius:var(--radius-sm);font-size:11px;font-family:var(--font-mono);color:var(--color-text);outline:none" /></div>' +
            '<div style="display:flex;flex-direction:column;gap:5px;flex:2;min-width:200px">' +
            '<label style="font-size:10px;font-weight:700;color:var(--color-text-muted);text-transform:uppercase">Client Secret</label>' +
            '<input id="xai-clientsecret" type="password" placeholder="OAuth 2.0 Client Secret" spellcheck="false" ' +
            'style="padding:8px 10px;background:var(--color-surface-3);border:1px solid var(--color-border);border-radius:var(--radius-sm);font-size:11px;font-family:var(--font-mono);color:var(--color-text);outline:none" /></div>' +
            '<button onclick="(function(){' +
            'var id=document.getElementById(\'xai-clientid\').value.trim();' +
            'var sec=document.getElementById(\'xai-clientsecret\').value.trim();' +
            'if(!id||!sec)return;' +
            'var w=document.getElementById(\'xai-login-wrap\');' +
            'if(w)w.innerHTML=\'<div style=\\\'padding:10px;font-size:11px;color:var(--color-gold)\\\'>\u23F3 Connecting\u2026</div>\';' +
            'if(window.SocialSentiment){window.SocialSentiment.setCredentials(id,sec).then(function(ok){' +
            'var p=document.getElementById(\'xai-sentiment-panel\');' +
            'if(!p)return;' +
            'if(ok){p.innerHTML=\'<div style=\\\'padding:10px 14px;background:rgba(38,212,126,0.07);border:1px solid rgba(38,212,126,0.25);border-left:3px solid #a855f7;border-radius:var(--radius-md);font-size:11px;font-weight:700;color:var(--color-green)\\\'>\u25cf WECRYPTO Connected \u2014 fetching sentiment\u2026</div>\';' +
            'window.SocialSentiment.fetchAll().catch(function(){});}' +
            'else{p.innerHTML=\'<div style=\\\'padding:10px 14px;border:1px solid var(--color-red);border-radius:var(--radius-md);font-size:11px;color:var(--color-red)\\\'>\u2717 Connection failed \u2014 check credentials</div>\';}' +
            '});}' +
            '})()" ' +
            'style="padding:9px 20px;background:#a855f7;border:none;border-radius:var(--radius-sm);font-size:12px;font-weight:800;color:#fff;cursor:pointer;flex-shrink:0">Connect</button></div>' +
            '<div style="font-size:9px;color:var(--color-text-faint);margin-top:8px">Credentials from <a href="https://developer.twitter.com" target="_blank" style="color:#a855f7">developer.twitter.com</a> \u2192 Your App \u2192 Keys &amp; Tokens \u2192 OAuth 2.0. Stored locally only.</div></div>';
        }
      } catch(e) { console.warn('[WECRYPTO panel]', e); }
    })();

    content.querySelectorAll('[data-cfm-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sym = btn.dataset.cfmToggle;
        const block = btn.closest('[data-cfm-sym]');
        if (!block) return;
        const panel = block.querySelector('.cfm-expand-panel');
        const icon  = block.querySelector('.cfm-expand-icon');
        const isOpen = panel?.classList.toggle('open');
        block.classList.toggle('expanded', isOpen);
        if (icon) icon.textContent = isOpen ? '\u2212' : '+';
        // Keep cfmExpanded in sync for re-renders
        if (isOpen) cfmExpanded.add(sym); else cfmExpanded.delete(sym);
      });
    });
  }

  // ================================================================
  // NARRATIVE CALLOUTS — plain-English flagging of opportunities
  // ================================================================

  function buildNarrativeCallouts(verdicts, allSignals, cfmAll, predAll) {
    const alerts = []; // { type: 'opp'|'warn'|'info', icon, title, body, coin, color }

    PREDICTION_COINS.forEach(coin => {
      const pred = predAll[coin.sym];
      const cfm = cfmAll[coin.sym];
      if (!pred || !cfm || cfm.cfmRate === 0) return;

      const sym = coin.sym;
      const price = cfm.cfmRate;
      const deriv = pred.derivatives;
      const squeeze = pred.squeeze;
      const cvd = pred.cvd;
      const ind = pred.indicators || {};
      const rsi = ind.rsi?.value ?? 50;
      const mom = cfm.momentum || 0;
      const trend = cfm.trend;
      const volRatio = ind.volume?.ratio ?? 1;
      const obvSlope = ind.obv?.slope ?? 0;
      const emaCross = ind.ema?.value ?? 0;
      const verdict = verdicts.find(v => v.sym === sym);
      const confirming = verdict?.edge?.signalCount ?? 0;
      const funding = deriv?.funding ?? 0;
      const predDir = predictionDirection(pred, 0);
      const predDirLabel = predDir > 0 ? 'UP' : predDir < 0 ? 'DOWN' : 'NEUTRAL';
      const agreement = pred.diagnostics?.agreement ?? 0;
      const conflict = pred.diagnostics?.conflict ?? 0;
      const reliability = pred.diagnostics?.reliability ?? pred.backtest?.summary?.reliability ?? 0;
      const bullishSignals = pred.diagnostics?.bullishSignals ?? 0;
      const bearishSignals = pred.diagnostics?.bearishSignals ?? 0;

      // --- Squeeze alerts ---
      if (squeeze) {
        const dir = squeeze.type === 'short_squeeze' ? 'UP' : 'DOWN';
        const alignsWithPrediction = (dir === 'UP' && predDir > 0) || (dir === 'DOWN' && predDir < 0);
        const urgency = alignsWithPrediction && reliability >= 0.45 && conflict <= 0.4
          ? (squeeze.severity === 'high' ? 'opp' : 'warn')
          : 'info';
        alerts.push({
          type: urgency, coin: sym, color: coin.color,
          icon: squeeze.severity === 'high' ? '\u26a1' : '\u26a0',
          title: `${sym} ${squeeze.type === 'short_squeeze' ? 'Short Squeeze' : 'Long Squeeze'} Risk`,
          body: `Funding at ${funding.toFixed(3)}%. ${squeeze.desc} Prediction bias: ${predDirLabel}.${alignsWithPrediction && confirming >= 3 ? ' ' + confirming + ' indicators confirm.' : alignsWithPrediction ? '' : ' Treat as positioning context until price confirms.'}`,
        });
      }

      // --- RSI extremes ---
      if (rsi >= 75) {
        const aligned = predDir < 0 && reliability >= 0.45 && conflict <= 0.45;
        alerts.push({
          type: aligned ? 'warn' : 'info', coin: sym, color: coin.color, icon: '\ud83d\udcc9',
          title: `${sym} Overbought — RSI ${rsi.toFixed(0)}`,
          body: aligned
            ? `RSI above 75 signals buyer exhaustion. ${trend === 'rising' ? 'Trend still rising but reversal risk is elevated.' : 'Already weakening.'} Prediction bias stays DOWN — tighten stops.`
            : `RSI is stretched but the broader model is not cleanly bearish yet. Treat this as exhaustion context, not a standalone short trigger.`,
        });
      } else if (rsi <= 25) {
        const aligned = predDir > 0 && reliability >= 0.45 && conflict <= 0.45;
        alerts.push({
          type: aligned ? 'opp' : 'info', coin: sym, color: coin.color, icon: '\ud83d\udcc8',
          title: `${sym} Oversold — RSI ${rsi.toFixed(0)}`,
          body: aligned
            ? `RSI below 25 signals seller exhaustion. ${trend === 'falling' ? 'Trend is still down, but the bounce setup is supported by the broader model.' : 'Price is already stabilizing.'} Expect UP — bounce opportunity.`
            : `RSI is deeply oversold, but momentum/flow are still leaning against a clean reversal. Watch for confirmation before treating this as an UP call.`,
        });
      }

      // --- CVD divergence (the cue you missed on BTC) ---
      if (cvd && Math.abs(cvd.slope) > 20) {
        const cvdDir = cvd.slope > 0 ? 'rising' : 'falling';
        const priceDir = mom > 0 ? 'up' : mom < 0 ? 'down' : 'flat';
        if ((cvd.slope > 0 && mom < -0.05) || (cvd.slope < 0 && mom > 0.05)) {
          alerts.push({
            type: 'opp', coin: sym, color: coin.color, icon: '\ud83d\udd04',
            title: `${sym} CVD Divergence Detected`,
            body: `Price moving ${priceDir} but CVD ${cvdDir} — order flow disagrees with price action. ${cvd.slope > 0 ? 'Buyers still aggressive despite price drop → reversal up likely.' : 'Sellers still aggressive despite price rise → exhaustion incoming, take profit.'} This is an exit/entry timing signal.`,
          });
        }
      }

      // --- Multi-signal confluence (HIGH CONVICTION) ---
      if (confirming >= 4 && predDir !== 0 && agreement >= 0.72 && conflict <= 0.28) {
        alerts.push({
          type: 'opp', coin: sym, color: coin.color, icon: '\ud83c\udfaf',
          title: `${sym} High Confluence — ${confirming} Signals Aligned ${predDirLabel}`,
          body: `${bullishSignals} bullish vs ${bearishSignals} bearish components, agreement ${(agreement * 100).toFixed(0)}%, conflict ${(conflict * 100).toFixed(0)}%. EMA ${emaCross > 0 ? 'bull' : 'bear'} cross, OBV ${obvSlope > 0 ? 'accumulation' : 'distribution'}, Vol Delta ${volRatio.toFixed(2)}x, Trend ${trend}${deriv ? ', Funding ' + funding.toFixed(3) + '%' : ''}. ${reliability >= 0.55 ? 'Backtest quality supports this cluster.' : 'Live cluster is strong, but backtest quality is mixed.'}`,
        });
      }

      // --- Volume anomaly ---
      if (volRatio > 1.5) {
        alerts.push({
          type: 'info', coin: sym, color: coin.color, icon: '\ud83d\udcca',
          title: `${sym} Elevated Buy Volume — ${volRatio.toFixed(2)}x ratio`,
          body: `Buy-side volume significantly exceeds sell-side. ${obvSlope > 10 ? 'OBV confirms accumulation.' : 'But OBV not yet confirming — could be a trap.'} Watch for follow-through.`,
        });
      } else if (volRatio < 0.65) {
        alerts.push({
          type: 'warn', coin: sym, color: coin.color, icon: '\ud83d\udcca',
          title: `${sym} Heavy Sell Pressure — ${volRatio.toFixed(2)}x ratio`,
          body: `Sell-side dominating order flow. ${obvSlope < -10 ? 'OBV confirms distribution — expect DOWN.' : 'Volume dropping though, may not sustain.'}`,
        });
      }

      // --- Extreme funding (not squeeze level, but notable) ---
      if (Math.abs(funding) > 0.1 && !squeeze) {
        const side = funding > 0 ? 'longs' : 'shorts';
        alerts.push({
          type: 'info', coin: sym, color: coin.color, icon: '\ud83d\udcb0',
          title: `${sym} Funding Imbalance — ${side} paying ${Math.abs(funding).toFixed(3)}%`,
          body: `${side === 'longs' ? 'Bullish crowding' : 'Bearish crowding'} in perpetual futures. Not at squeeze level yet but positioning is skewed. Contrarian edge building.`,
        });
      }

      // --- Cross-exchange arb opportunity ---
      if (cfm.spread > 0.3) {
        const spreadType = cfm.spread > 5 ? 'warn' : 'info';
        alerts.push({
          type: spreadType, coin: sym, color: coin.color, icon: '\ud83d\udd00',
          title: `${sym} Cross-Exchange Spread ${cfm.spread.toFixed(2)}%`,
          body: spreadType === 'warn'
            ? `Venue disagreement is unusually large, so this is more likely a source mismatch or illiquid venue than a clean arb. Sources: ${Object.keys(cfm.sources || {}).join(', ')}${cfm.dexMeta?.pair ? ` · DEX ${cfm.dexMeta.pair}` : ''}.`
            : `Price diverging across sources. ${cfm.spread > 1 ? 'Significant arb window open.' : 'Mild divergence, watching for convergence trade.'} Sources: ${Object.keys(cfm.sources || {}).join(', ')}.`,
        });
      }
    });

    // --- Market-wide context ---
    const allFunding = PREDICTION_COINS.map(c => predAll[c.sym]?.derivatives?.funding ?? 0).filter(f => f !== 0);
    if (allFunding.length > 0) {
      const avgFunding = allFunding.reduce((a, b) => a + b, 0) / allFunding.length;
      const negCount = allFunding.filter(f => f < -0.1).length;
      const posCount = allFunding.filter(f => f > 0.1).length;
      if (negCount >= 3) {
        alerts.unshift({
          type: 'opp', coin: 'MKT', color: 'var(--color-primary)', icon: '\ud83c\udf0a',
          title: `Market-Wide Short Crowding — ${negCount}/${allFunding.length} coins negative funding`,
          body: `Multiple coins showing negative funding rates simultaneously. This often precedes a broad short squeeze / relief rally. Avg funding: ${fmtSignedPct(avgFunding, 3)}.`,
        });
      } else if (posCount >= 3) {
        alerts.unshift({
          type: 'warn', coin: 'MKT', color: 'var(--color-primary)', icon: '\ud83c\udf0a',
          title: `Market-Wide Long Crowding — ${posCount}/${allFunding.length} coins positive funding`,
          body: `Majority of coins showing positive funding. Leveraged longs are overcrowded. Correction risk elevated. Avg funding: ${fmtSignedPct(avgFunding, 3)}.`,
        });
      }
    }

    if (alerts.length === 0) {
      return `
        <div class="opp-panel" style="border-left:3px solid var(--color-text-faint)">
          <div class="card-title" style="color:var(--color-text-muted)">\ud83d\udce1 Market Read</div>
          <div style="font-size:12px;color:var(--color-text-muted);padding:8px 0;line-height:1.6">
            No strong signals firing. Market is in a neutral / range-bound state across all 7 tokens. The orchestrator is watching every 15 seconds and will flag the moment conviction builds on any coin. Sit tight.
          </div>
        </div>
      `;
    }

    // Sort: opp first, then warn, then info
    const typeOrder = { opp: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

    const oppCount = alerts.filter(a => a.type === 'opp').length;
    const warnCount = alerts.filter(a => a.type === 'warn').length;
    const infoCount = alerts.filter(a => a.type === 'info').length;

    return `
      <div class="opp-panel" style="border-left:3px solid ${oppCount > 0 ? 'var(--color-green)' : warnCount > 0 ? 'var(--color-orange)' : 'var(--color-primary)'}">
        <div class="card-title" style="color:var(--color-text)">
          \ud83d\udce1 Live Market Read \u2014 ${alerts.length} flags
          <span style="margin-left:auto;font-size:10px;font-weight:400;color:var(--color-text-muted)">
            ${oppCount > 0 ? '<span style="color:var(--color-green)">' + oppCount + ' opportunity</span> ' : ''}
            ${warnCount > 0 ? '<span style="color:var(--color-orange)">' + warnCount + ' warning</span> ' : ''}
            ${infoCount > 0 ? '<span style="color:var(--color-primary)">' + infoCount + ' info</span>' : ''}
          </span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
          ${alerts.map(a => {
            const bgColor = a.type === 'opp' ? 'var(--color-green-dim)' : a.type === 'warn' ? 'var(--color-orange-dim)' : 'var(--color-surface-2)';
            const borderColor = a.type === 'opp' ? 'var(--color-green)' : a.type === 'warn' ? 'var(--color-orange)' : 'var(--color-primary)';
            const typeLabel = a.type === 'opp' ? 'OPPORTUNITY' : a.type === 'warn' ? 'WARNING' : 'INTEL';
            const typeBadgeColor = a.type === 'opp' ? 'var(--color-green)' : a.type === 'warn' ? 'var(--color-orange)' : 'var(--color-primary)';
            return `
              <div style="padding:10px 14px;background:${bgColor};border-left:3px solid ${borderColor};border-radius:var(--radius-md)">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <span style="font-size:15px">${a.icon}</span>
                  <span style="font-size:13px;font-weight:700;color:${a.color}">${a.coin}</span>
                  <span style="font-size:12px;font-weight:700;color:var(--color-text)">${a.title}</span>
                  <span style="margin-left:auto;font-size:8px;padding:2px 6px;border-radius:9999px;background:${typeBadgeColor}22;color:${typeBadgeColor};font-weight:700;letter-spacing:0.06em">${typeLabel}</span>
                </div>
                <div style="font-size:11px;color:var(--color-text-muted);line-height:1.5">${a.body}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // ---- Profitability calculator: does the expected move beat fees? ----
  // Round-trip fee estimate (buy + sell). Coinbase: ~0.6% standard, ~0.1% advanced.
  // Position-size agnostic — all verdicts shown as pure % edge.
  const FEE_PCT = 0.60;

  function calcEdge(coin, cfm, pred) {
    const price = cfm.cfmRate || cfm.lastPrice || 0;
    if (price === 0) return null;

    const atrPct = pred?.volatility?.atrPct ?? 0;
    const momentum = Math.abs(cfm.momentum || 0);
    const bidAsk = cfm.bidAsk || 0;
    const xSpread = cfm.spread || 0;

    // Expected move in next 15 min (ATR on 5-min candles * sqrt(3) for 15 min)
    const expected15m = atrPct * Math.sqrt(3);
    // Expected move in next 60 min
    const expected60m = atrPct * Math.sqrt(12);

    // Total cost to play: fees + bid-ask spread + slippage estimate
    const totalCostPct = FEE_PCT + bidAsk + 0.05; // 0.05% slippage estimate

    // Edge = expected move - cost
    const edge15 = expected15m - totalCostPct;
    const edge60 = expected60m - totalCostPct;

    // Dollar values per $100 deployed (for reference)
    const dollarEdgePer100_15 = (edge15 / 100) * 100;
    const dollarEdgePer100_60 = (edge60 / 100) * 100;

    // How many confirming signals does this coin have?
    const signalCount = countConfirmingSignals(coin, cfm, pred);

    // Conviction tier
    let tier, tierColor, tierDesc;
    if (edge15 > 0.3 && signalCount >= 3) {
      tier = 'HIGH CONVICTION'; tierColor = 'var(--color-green)';
      tierDesc = `${signalCount} indicators aligned, edge ${edge15.toFixed(2)}% > fees`;
    } else if (edge15 > 0.1 && signalCount >= 2) {
      tier = 'MARGINAL'; tierColor = 'var(--color-orange)';
      tierDesc = `Edge exists but thin \u2014 ${edge15.toFixed(2)}% after fees, ${signalCount} signals`;
    } else if (edge15 < 0) {
      tier = 'NOT WORTH IT'; tierColor = 'var(--color-red)';
      tierDesc = `Expected move ${expected15m.toFixed(2)}% < cost ${totalCostPct.toFixed(2)}% \u2014 fees eat the profit`;
    } else {
      tier = 'BREAK EVEN'; tierColor = 'var(--color-text-faint)';
      tierDesc = `Edge ~0 \u2014 coin flip after fees, need more data`;
    }

    // Reliability gate: downgrade HIGH CONVICTION if backtest quality is too low
    if (tier === 'HIGH CONVICTION' && (pred?.backtest?.summary?.reliability ?? 1) < 0.55) {
      tier = 'MARGINAL'; tierColor = 'var(--color-orange)';
      tierDesc = `Signals align but backtest reliability ${Math.round((pred.backtest.summary.reliability || 0) * 100)}% < 55% gate \u2014 wait for confirmation`;
    }

    // Entry/exit zones
    const dirBias = predictionDirection(pred, (cfm.momentum || 0) >= 0 ? 1 : -1);
    const dir = dirBias >= 0 ? 'up' : 'down';
    const entryPrice = dir === 'up'
      ? price * (1 - atrPct / 200) // buy on pullback to half-ATR below
      : price * (1 + atrPct / 200); // sell on bounce to half-ATR above
    const stopLoss = dir === 'up'
      ? price * (1 - atrPct * 1.5 / 100) // 1.5x ATR stop
      : price * (1 + atrPct * 1.5 / 100);
    const takeProfit = dir === 'up'
      ? price * (1 + atrPct * 2 / 100) // 2x ATR target (2:1 R/R)
      : price * (1 - atrPct * 2 / 100);
    const riskReward = atrPct > 0 ? 2.0 : 0; // fixed 2:1 by construction

    return {
      price, atrPct, expected15m, expected60m, totalCostPct, edge15, edge60,
      dollarEdgePer100_15, dollarEdgePer100_60,
      tier, tierColor, tierDesc, signalCount,
      dir, entryPrice, stopLoss, takeProfit, riskReward,
    };
  }

  function countConfirmingSignals(coin, cfm, pred) {
    const ind = pred?.indicators || {};
    let count = 0;
    const dir = predictionDirection(pred, (cfm.momentum || 0) >= 0 ? 1 : -1);
    if (dir === 0) return 0;

    // RSI
    const rsi = ind.rsi?.value ?? 50;
    if (dir > 0 && rsi < 40) count++; // oversold + bullish = confirming
    if (dir < 0 && rsi > 60) count++; // overbought + bearish = confirming
    // EMA
    if (dir > 0 && (ind.ema?.value ?? 0) > 0.1) count++;
    if (dir < 0 && (ind.ema?.value ?? 0) < -0.1) count++;
    // OBV
    if (dir > 0 && (ind.obv?.slope ?? 0) > 5) count++;
    if (dir < 0 && (ind.obv?.slope ?? 0) < -5) count++;
    // Volume delta
    if (dir > 0 && (ind.volume?.ratio ?? 1) > 1.2) count++;
    if (dir < 0 && (ind.volume?.ratio ?? 1) < 0.8) count++;
    // Trend
    if (dir > 0 && cfm.trend === 'rising') count++;
    if (dir < 0 && cfm.trend === 'falling') count++;
    // Momentum
    if (Math.abs(cfm.momentum || 0) > 0.1) count++;
    // Book
    const bookImbal = (ind.book?.imbalance ?? 0);
    if (dir > 0 && bookImbal > 0.2) count++;
    if (dir < 0 && bookImbal < -0.2) count++;
    // Funding rate (contrarian — negative funding + bullish = confirming)
    const funding = pred?.derivatives?.funding ?? 0;
    if (dir > 0 && funding < -0.1) count++; // shorts paying = confirms long
    if (dir < 0 && funding > 0.1) count++; // longs paying = confirms short
    // CVD
    const cvdSlope = pred?.cvd?.slope ?? 0;
    if (dir > 0 && cvdSlope > 10) count++;
    if (dir < 0 && cvdSlope < -10) count++;
    // Squeeze aligns with direction
    if (pred?.squeeze) {
      if (dir > 0 && pred.squeeze.type === 'short_squeeze') count++;
      if (dir < 0 && pred.squeeze.type === 'long_squeeze') count++;
    }

    return count;
  }

  // ---- Build Opportunities Panel with profitability analysis ----
  function buildOpportunitiesPanel(cfmAll, predAll) {
    const allSignals = [];
    const coinEdges = {};

    // Kalshi orchestrator — resolve YES/NO intents for all coins this render cycle
    const kalshiIntents = window.KalshiOrchestrator?.update(predAll, cfmAll) ?? {};

    // ── DataLogger hooks — fire-and-forget, no perf impact ──────────────────
    if (window.DataLogger) {
      PREDICTION_COINS.forEach(coin => {
        const pred = predAll[coin.sym];
        const cfm  = cfmAll[coin.sym];
        if (!pred || !cfm || cfm.cfmRate === 0) return;
        const ind = pred.indicators || {};
        window.DataLogger.logPrediction(coin.sym, {
          dir:       pred.direction ?? null,
          score:     pred.score     ?? null,
          conf:      pred.confidence ?? null,
          quality:   pred.modelQuality ?? null,
          fit:       pred.tradeFit     ?? null,
          alignment: pred.signalAlignment ?? null,
          rsi:       ind.rsi?.value ?? null,
          vwapDev:   cfm.vwapDev    ?? null,
        });
        const ki = kalshiIntents[coin.sym];
        if (ki) window.DataLogger.logDecision(coin.sym, ki);
      });
      // Expose cfmAll for overlay snapshot
      window._cfmAll = cfmAll;
    }

    PREDICTION_COINS.forEach(coin => {
      const cfm = cfmAll[coin.sym];
      const pred = predAll[coin.sym];
      if (!cfm || cfm.cfmRate === 0) return;

      // Compute profitability edge
      const edge = calcEdge(coin.sym, cfm, pred);
      if (edge) coinEdges[coin.sym] = edge;

      const wc = COIN_WEIGHT[coin.sym] || 'light';
      const rank = WEIGHT_RANK[wc];
      const ind = pred?.indicators || {};
      const dexMeta = cfm.dexMeta || {};
      const cbPrice = cfm.sources?.CB || 0;

      const vals = {
        ...cfm,
        _rsi: ind.rsi?.value ?? 50,
        _macd: computeQuickMACD(cfm),
        _emaCross: ind.ema?.value ?? 0,
        _obvSlope: ind.obv?.slope ?? 0,
        _volRatio: ind.volume?.ratio ?? 1,
        _atrPct: pred?.volatility?.atrPct ?? 0,
        _bookImbal: (ind.book || {}).imbalance ?? 0,
        _aggrBuy: (ind.flow || {}).buyRatio ?? 50,
        _cbPremium: cbPrice > 0 && cfm.cfmRate > 0 ? ((cbPrice - cfm.cfmRate) / cfm.cfmRate) * 100 : 0,
        _dexVol: dexMeta.vol ?? 0,
        _dexLiq: dexMeta.liq ?? 0,
        _funding: pred?.derivatives?.funding ?? 0,
        _oi: pred?.derivatives?.oi ?? 0,
        _squeezeScore: pred?.squeeze ? (pred.squeeze.severity === 'high' ? 2 : 1) : 0,
        _cvdSlope: pred?.cvd?.slope ?? 0,
      };

      const activeOrbs = SUBORBITALS.filter(orb => rank >= (ORBITAL_ACCESS[orb.weight] || 1));
      activeOrbs.forEach(orb => {
        const sig = evaluateSignal(orb, vals[orb.key], vals);
        if (sig.signal && sig.signal !== 'even') {
          allSignals.push({ coin: coin.sym, color: coin.color, orb: orb.sym, shell: orb.shell, signal: sig.signal, tag: sig.tag, reason: sig.reason });
        }
      });
    });

    // ---- Trade Verdict Cards (one per coin) ----
    const verdicts = PREDICTION_COINS
      .map(c => ({ sym: c.sym, color: c.color, edge: coinEdges[c.sym] }))
      .filter(v => v.edge)
      .sort((a, b) => b.edge.edge15 - a.edge.edge15);

    const highConv = verdicts.filter(v => v.edge.tier === 'HIGH CONVICTION');
    const marginal = verdicts.filter(v => v.edge.tier === 'MARGINAL');
    const notWorth = verdicts.filter(v => v.edge.tier === 'NOT WORTH IT' || v.edge.tier === 'BREAK EVEN');

    // Signal counts
    const scalpCount = allSignals.filter(s => s.signal === 'bull').length;
    const fadeCount = allSignals.filter(s => s.signal === 'bear').length;
    const dangerCount = allSignals.filter(s => s.signal === 'danger').length;

    // ---- Build Narrative Callouts (plain-English flagging) ----
    const callouts = buildNarrativeCallouts(verdicts, allSignals, cfmAll, predAll);

    return `
      <!-- Narrative Callouts -->
      ${callouts}

      <!-- Trade Verdict: Should you trade RIGHT NOW? -->
      <div class="opp-panel" style="border-left:3px solid ${highConv.length > 0 ? 'var(--color-green)' : marginal.length > 0 ? 'var(--color-orange)' : 'var(--color-text-faint)'}">
        <div class="card-title" style="color:var(--color-gold)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Trade Verdicts \u2014 ~${FEE_PCT}% Round-Trip Fee Assumed
        </div>

        ${verdicts.length === 0 ? '<div style="font-size:12px;color:var(--color-text-muted);padding:12px 0">Warming up \u2014 accumulating price data...</div>' : ''}

        <div class="opp-grid">
          ${verdicts.map(v => {
            const e = v.edge;
            const arrow = e.dir === 'up' ? '\u2191' : '\u2193';
            const dirLabel = e.dir === 'up' ? 'UP' : 'DOWN';
            return `
              <div class="opp-card ${e.tier === 'HIGH CONVICTION' ? 'scalp' : e.tier === 'MARGINAL' ? 'fade' : e.tier === 'NOT WORTH IT' ? 'danger' : 'even'}" style="padding:12px">
                <div class="opp-head">
                  <span style="color:${v.color};font-size:14px">${v.sym}</span>
                  <span style="font-size:16px;color:${e.dir === 'up' ? 'var(--color-green)' : 'var(--color-red)'}">${arrow}</span>
                  <span style="font-size:10px;color:var(--color-text-muted)">${dirLabel}</span>
                  <span style="margin-left:auto;font-size:9px;padding:2px 6px;border-radius:9999px;font-weight:700;background:${e.tierColor}22;color:${e.tierColor}">${e.tier}</span>
                </div>
                <div style="font-size:10px;color:var(--color-text-muted);margin:4px 0">${e.tierDesc}</div>

                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;font-family:var(--font-mono);margin-top:4px">
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">15m MOVE</div>
                    <div style="font-weight:700;color:${e.expected15m > e.totalCostPct ? 'var(--color-green)' : 'var(--color-red)'}">${e.expected15m.toFixed(2)}%</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">COST</div>
                    <div style="font-weight:700;color:var(--color-red)">${e.totalCostPct.toFixed(2)}%</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">EDGE</div>
                    <div style="font-weight:700;color:${e.edge15 > 0 ? 'var(--color-green)' : 'var(--color-red)'}">${e.edge15 > 0 ? '+' : ''}${e.edge15.toFixed(2)}%</div>
                  </div>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;font-family:var(--font-mono);margin-top:3px">
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">ENTRY</div>
                    <div style="font-weight:700">${fmtPrice(e.entryPrice)}</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">STOP</div>
                    <div style="font-weight:700;color:var(--color-red)">${fmtPrice(e.stopLoss)}</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">TARGET</div>
                    <div style="font-weight:700;color:var(--color-green)">${fmtPrice(e.takeProfit)}</div>
                  </div>
                </div>

                <div style="font-size:9px;color:var(--color-text-faint);margin-top:4px;display:flex;gap:8px">
                  <span>${e.signalCount} confirming signals</span>
                  <span>R:R ${e.riskReward.toFixed(1)}:1</span>
                  <span>ATR ${e.atrPct.toFixed(2)}%</span>
                  <span>${e.edge15 >= 0 ? '+' : ''}$${e.dollarEdgePer100_15.toFixed(2)} per $100</span>
                </div>

                ${(() => {
                  const ki = kalshiIntents[v.sym];
                  if (!ki || ki.action === 'skip') return '';
                  const isExit      = ki.action === 'earlyExit';
                  const isHold      = ki.action === 'hold';
                  const isTrade     = ki.action === 'trade';
                  const isDivergent = ki.alignment === 'DIVERGENT';
                  const bg     = isExit      ? 'rgba(255,80,80,0.07)'
                               : isHold      ? 'rgba(255,180,0,0.07)'
                               : isTrade     ? 'rgba(0,200,100,0.08)'
                               : isDivergent ? 'rgba(255,140,0,0.07)'
                               :               'rgba(200,200,0,0.06)';
                  const border = isExit      ? 'rgba(255,80,80,0.25)'
                               : isHold      ? 'rgba(255,180,0,0.28)'
                               : isTrade     ? 'rgba(0,200,100,0.22)'
                               : isDivergent ? 'rgba(255,140,0,0.28)'
                               :               'rgba(200,200,0,0.18)';
                  const sideColor  = ki.side === 'YES' ? 'var(--color-green)' : ki.side === 'NO' ? 'var(--color-red)' : 'var(--color-text-muted)';
                  const sideBg     = ki.side === 'YES' ? 'rgba(0,200,100,0.18)' : ki.side === 'NO' ? 'rgba(220,60,60,0.18)' : 'transparent';
                  const alignColor = isDivergent ? '#ff8c00' : isTrade ? 'var(--color-green)' : 'var(--color-text-muted)';
                  const alignTagC  = {
                    ALIGNED:'✓ Aligned', DIVERGENT:'⚡ Divergent', MODEL_LEADS:'→ Model leads',
                    KALSHI_ONLY:'◇ Kalshi only', MODEL_ONLY:'◆ Model only',
                    EARLY_EXIT:'✗ Early exit', SHELL_EVAL:'⏳ Evaluating',
                  }[ki.alignment] || (ki.alignment || '');
                  const strikeC = ki.strikeStr || (() => {
                    const m = (ki.contractTicker||'').match(/T(\d+(?:\.\d+)?)$/);
                    return m ? 'T'+Number(m[1]).toLocaleString() : '';
                  })();
                  // Millisecond-precision countdown — recomputed fresh on every render
                  const msNow   = ki.closeTimeMs ? Math.max(0, ki.closeTimeMs - Date.now()) : null;
                  const secsNow = msNow != null ? msNow / 1000 : null;
                  const timeStr = secsNow == null ? null
                    : secsNow < 10  ? msNow.toFixed(0) + 'ms'
                    : secsNow < 90  ? Math.round(secsNow) + 's'
                    : (secsNow / 60).toFixed(1) + 'm';
                  const isLastCall = msNow != null && msNow <= 60000;
                  return `
                   <div style="margin-top:6px;padding:7px 9px;border-radius:5px;background:${bg};border:1px solid ${border}">
                     ${isExit
                       ? `<div style="display:flex;align-items:center;gap:8px">
                            <span style="background:rgba(255,80,80,0.22);color:var(--color-red);padding:3px 12px;border-radius:4px;font-size:12px;font-weight:800;letter-spacing:.5px">STAND ASIDE</span>
                            <span style="font-size:11px;color:var(--color-text-muted)">CFM early-exit signal</span>
                          </div>`
                       : isHold
                       ? `<div style="display:flex;align-items:center;gap:8px">
                            <span style="background:rgba(255,180,0,0.22);color:var(--color-gold,#f90);padding:3px 12px;border-radius:4px;font-size:12px;font-weight:800;letter-spacing:.5px">⏳ EVALUATING</span>
                            <span style="font-size:11px;color:var(--color-text-muted)">Shell wall — collecting data</span>
                          </div>`
                       : `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                            <span style="background:${sideBg};color:${sideColor};padding:3px 12px;border-radius:4px;font-size:14px;font-weight:800;letter-spacing:.7px">${ki.side}</span>
                            <span style="font-size:12px;font-weight:700;color:var(--color-text);font-family:var(--font-mono)">KALSHI${strikeC ? ' · ' + strikeC : ''}</span>
                            ${ki.isInversion ? '<span style="background:rgba(255,120,0,0.22);color:#ff8c00;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:800">🔥 INVERSION</span>' : ''}
                            ${isLastCall ? `<span id="kalshi-lc-${ki.sym}" data-close-ms="${ki.closeTimeMs}" style="background:rgba(255,40,40,0.22);color:var(--color-red);padding:2px 7px;border-radius:3px;font-size:11px;font-weight:800;font-family:var(--font-mono)">⚡ ${timeStr}</span>` : ''}
                            <span style="margin-left:auto;color:${alignColor};font-size:11px;font-weight:700">${alignTagC}</span>
                          </div>`}
                     ${!isExit && !isHold && ki.edgeCents != null ? `
                     <div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;align-items:stretch">
                       <div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:44px">
                         <div style="font-size:9px;color:var(--color-text-faint)">EDGE</div>
                         <div style="font-size:13px;font-weight:800;color:${ki.edgeCents >= 8 ? 'var(--color-green)' : ki.edgeCents >= 0 ? 'var(--color-text-muted)' : 'var(--color-red)'}">
                           ${ki.edgeCents >= 0 ? '+' : ''}${ki.edgeCents}¢</div>
                       </div>
                       ${ki.payoutMult != null ? `<div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:44px">
                         <div style="font-size:9px;color:var(--color-text-faint)">PAYOUT</div>
                         <div style="font-size:13px;font-weight:800;color:var(--color-text)">${ki.payoutMult.toFixed(1)}×</div></div>` : ''}
                       <div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:44px">
                         <div style="font-size:9px;color:var(--color-text-faint)">ENTRY</div>
                         <div style="font-size:13px;font-weight:800;color:${ki.thinBook ? 'var(--color-orange)' : ki.tailRisk ? '#ff6b6b' : 'var(--color-text)'}">
                           ${ki.entryPrice != null ? '$'+(ki.entryPrice*100).toFixed(0)+'¢' : '—'}</div>
                       </div>
                       ${ki.breakEven != null ? `<div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:52px">
                         <div style="font-size:9px;color:var(--color-text-faint)">NEED WIN%</div>
                         <div style="font-size:13px;font-weight:800;color:var(--color-text)">${Math.round(ki.breakEven*100)}%</div></div>` : ''}
                       ${ki.kellyPct > 0 ? `<div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:44px">
                         <div style="font-size:9px;color:var(--color-text-faint)">KELLY</div>
                         <div style="font-size:13px;font-weight:800;color:var(--color-text)">${ki.kellyPct}%</div></div>` : ''}
                     </div>` : ''}
                     <div style="font-size:11px;color:var(--color-text-faint);margin-top:4px;display:flex;gap:10px;flex-wrap:wrap">
                       ${ki.modelProbUp != null ? `<span>Model <strong style="color:var(--color-text)">${Math.round(ki.modelProbUp*100)}%</strong> ↑</span>` : ''}
                       ${ki.kalshiYesPrice != null ? `<span>Kalshi <strong style="color:var(--color-text)">${Math.round(ki.kalshiYesPrice*100)}%</strong> YES</span>` : ''}
                       ${ki.targetPrice ? `<span>Strike <strong style="color:var(--color-text)">${ki.targetPrice}</strong></span>` : ''}
                       ${timeStr && !isLastCall ? `<span id="kalshi-min-${ki.sym}" data-close-ms="${ki.closeTimeMs}">⏱ <strong>${timeStr}</strong></span>` : ''}
                       <span style="color:${isTrade ? 'var(--color-green)' : 'var(--color-orange)'}"><strong>${ki.confidence}%</strong> conf</span>
                     </div>
                     ${ki.thinBook ? `<div style="font-size:11px;color:var(--color-orange);margin-top:3px">⚠ Thin book (${ki.entryPrice != null ? (ki.entryPrice*100).toFixed(0) : '?'}¢ entry) — check spread before sizing</div>` : ''}
                     ${ki.tailRisk ? `<div style="font-size:11px;color:#ff6b6b;margin-top:3px">⚠ Tail risk ($${ki.entryPrice != null ? ki.entryPrice.toFixed(2) : '?'} entry)${ki.lossErasesWins ? ' — one loss erases ' + ki.lossErasesWins + ' wins' : ''}</div>` : ''}
                     ${isDivergent ? `<div style="font-size:11px;color:#ff8c00;margin-top:3px">⚡ Model vs house — buy the mispriced side, the edge IS the divergence</div>` : ''}
                     ${ki.humanReason ? `<div style="font-size:11px;color:var(--color-text-muted);margin-top:4px;line-height:1.4">${ki.humanReason}</div>` : ''}
                   </div>`;
                })()}
                </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Flashing Indicators -->
      ${allSignals.length > 0 ? `
        <div class="opp-panel">
          <div class="card-title" style="color:var(--color-gold)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Flashing Indicators \u2014 ${allSignals.length} active
            <span style="margin-left:auto;font-size:10px;font-weight:400;color:var(--color-text-muted)">
              ${scalpCount > 0 ? '<span style="color:var(--color-green)">' + scalpCount + ' up</span>' : ''}
              ${fadeCount > 0 ? ' <span style="color:var(--color-orange)">' + fadeCount + ' down</span>' : ''}
              ${dangerCount > 0 ? ' <span style="color:var(--color-red)">' + dangerCount + ' risk</span>' : ''}
            </span>
          </div>
          <div class="opp-grid">
            ${allSignals.slice(0, 12).map(s => `
              <div class="opp-card ${s.signal}">
                <div class="opp-head">
                  <span style="color:${s.color}">${s.coin}</span>
                  <span style="font-size:9px;color:var(--color-text-faint)">${s.orb} \u00b7 ${s.shell}</span>
                  <span style="margin-left:auto;font-size:9px;padding:1px 5px;border-radius:9999px;background:${s.signal === 'bull' ? 'var(--color-green-dim)' : s.signal === 'bear' ? 'var(--color-orange-dim)' : 'var(--color-red-dim)'};color:${s.signal === 'bull' ? 'var(--color-green)' : s.signal === 'bear' ? 'var(--color-orange)' : 'var(--color-red)'};font-weight:700;text-transform:uppercase">${s.tag || s.signal}</span>
                </div>
                <div class="opp-desc">${s.reason}</div>
              </div>
            `).join('')}
          </div>
          ${allSignals.length > 12 ? '<div style="font-size:10px;color:var(--color-text-faint);margin-top:6px">+ ' + (allSignals.length - 12) + ' more signals in the tables below</div>' : ''}
        </div>
      ` : `
        <div class="opp-panel">
          <div class="card-title" style="color:var(--color-text-faint)">\u26a1 Indicators</div>
          <div style="font-size:12px;color:var(--color-text-muted);padding:8px 0">No flashing indicators yet \u2014 market is break-even across all orbitals.</div>
        </div>
      `}
    `;
  }

  // Weight class: determines which orbital shells a coin fills
  const COIN_WEIGHT = {
    BTC: 'heavy', ETH: 'heavy',
    SOL: 'mid', XRP: 'mid', BNB: 'mid',
    DOGE: 'light', HYPE: 'light',
  };

  const WEIGHT_RANK = { heavy: 3, mid: 2, light: 1 };
  const ORBITAL_ACCESS = { all: 1, mid: 2, heavy: 3 };

  // ================================================================
  // GROUND STATE ENERGY — Orbital Shell Synthesis
  // Thesis: inner shells = fundamental state, outer shells = catalysts.
  // Like an atom's ionisation energy: how far the market is from rest.
  // score ∈ [-1, +1]:  +1 = fully ionised bullish, -1 = fully ionised bearish
  // ================================================================

  function computeGroundState(vals, pred, weightClass) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const ind = pred?.indicators || {};

    // ── Inner shell contributions (fundamental state) ─────────────────────
    let innerScore = 0;
    let innerCount = 0;

    function addInner(v, w) {
      if (v === null || v === undefined || !isFinite(v)) return;
      innerScore += v * w;
      innerCount += w;
    }

    // Shell 1s — VWAP deviation from CFM rate (price truth)
    const vwapDev = ind.vwap?.value ?? 0;
    addInner(clamp(vwapDev / 2, -1, 1), 0.18);

    // Shell 2s — RSI (normalise 50 → 0, extremes → ±1)
    const rsi = ind.rsi?.value ?? 50;
    addInner(clamp((rsi - 50) / 30, -1, 1), 0.14);

    // Shell 2s — MACD
    const macdHist = ind.macd?.histogram ?? 0;
    addInner(clamp(macdHist * 50, -1, 1), 0.10);

    // Shell 2p — EMA cross
    const emaCross = vals._emaCross ?? 0;
    addInner(clamp(emaCross / 0.5, -1, 1), 0.12);

    // Shell 2p — Trend direction
    const trd = vals.trend;
    if (trd === 'rising')  addInner(0.7, 0.10);
    else if (trd === 'falling') addInner(-0.7, 0.10);

    // Shell 3s — OBV slope
    const obv = vals._obvSlope ?? 0;
    addInner(clamp(obv / 80, -1, 1), 0.10);

    // Shell 3s — Volume delta
    const volR = vals._volRatio ?? 1;
    addInner(clamp((volR - 1) / 0.5, -1, 1), 0.08);

    // Shell 3p — Book imbalance (mid/heavy only)
    if (weightClass !== 'light') {
      addInner(clamp((vals._bookImbal ?? 0) / 0.5, -1, 1), 0.09);
      // Aggressor ratio (normalise 50→0)
      addInner(clamp(((vals._aggrBuy ?? 50) - 50) / 30, -1, 1), 0.09);
    }

    // Shell 3d — Funding rate (heavy/mid)
    if (weightClass !== 'light') {
      const fund = vals._funding ?? 0;
      // Negative funding → longs are scarce → contrarian bullish
      addInner(clamp(-fund / 0.5, -1, 1), 0.08);
    }

    // Normalise inner score → [-1, +1]
    const rawInner = innerCount > 0 ? innerScore / innerCount : 0;
    const innerNorm = clamp(rawInner, -1, 1) * 0.7; // inner caps at ±0.7

    // ── Outer shell overrides (catalysts — additive on top of inner) ───────
    let outerBoost = 0;
    const triggers = [];

    // Shell 3d — Squeeze risk
    const sqz = vals._squeezeScore ?? 0;
    if (sqz >= 1) {
      const dir = vals._squeezeType === 'short_squeeze' ? 1 : vals._squeezeType === 'long_squeeze' ? -1 : 0;
      const mag = sqz >= 2 ? 0.40 : 0.25;
      if (dir !== 0) {
        outerBoost += dir * mag;
        triggers.push({ sym: 'SQZ', dir: dir > 0 ? 'bull' : 'bear', label: sqz >= 2 ? 'HIGH' : 'MED', strength: sqz >= 2 ? 'strong' : 'medium' });
      }
    }

    // Shell 4s — CVD slope
    const cvd = vals._cvdSlope ?? 0;
    if (Math.abs(cvd) > 10) {
      const boost = clamp(cvd / 80, -1, 1) * 0.20;
      outerBoost += boost;
      triggers.push({ sym: 'CVD', dir: boost > 0 ? 'bull' : 'bear', label: (cvd >= 0 ? '+' : '') + cvd.toFixed(0), strength: Math.abs(cvd) > 40 ? 'strong' : 'medium' });
    }

    // Shell 4s — Coinbase Premium
    const cbp = vals._cbPremium ?? 0;
    if (Math.abs(cbp) > 0.08) {
      const boost = clamp(cbp / 0.3, -1, 1) * 0.18;
      outerBoost += boost;
      triggers.push({ sym: 'CBP', dir: boost > 0 ? 'bull' : 'bear', label: (cbp >= 0 ? '+' : '') + cbp.toFixed(2) + '%', strength: Math.abs(cbp) > 0.2 ? 'strong' : 'medium' });
    }

    // Shell 5s — Prediction Market consensus
    const mkt = vals._mktConsensus;
    if (mkt !== null && mkt !== undefined) {
      const mktPct = mkt * 100;
      if (mktPct > 55 || mktPct < 45) {
        const boost = clamp((mktPct - 50) / 40, -1, 1) * 0.22;
        outerBoost += boost;
        triggers.push({ sym: 'MKT', dir: boost > 0 ? 'bull' : 'bear', label: mktPct.toFixed(0) + '%', strength: Math.abs(mktPct - 50) > 15 ? 'strong' : 'medium' });
      }
    }

    // Shell 5p — X.com Social Sentiment
    const xSent = vals._xSentiment;
    if (xSent !== null && xSent !== undefined && Math.abs(xSent) >= 30) {
      const boost = clamp(xSent / 70, -1, 1) * 0.18;
      outerBoost += boost;
      triggers.push({ sym: 'SNT', dir: boost > 0 ? 'bull' : 'bear', label: (xSent >= 0 ? '+' : '') + Math.round(xSent), strength: Math.abs(xSent) > 60 ? 'strong' : 'medium' });
    }

    // Clamp outer boost
    outerBoost = clamp(outerBoost, -0.30, 0.30);

    // ── Final ground state score ──────────────────────────────────────────
    const raw = clamp(innerNorm + outerBoost, -1.0, 1.0);
    const abs = Math.abs(raw);
    const dir = raw > 0.08 ? 'up' : raw < -0.08 ? 'down' : 'flat';

    let stateLabel, stateClass;
    if      (abs >= 0.80) { stateLabel = 'IONISED';    stateClass = 'ionised'; }
    else if (abs >= 0.60) { stateLabel = 'IONISING';   stateClass = 'ionising'; }
    else if (abs >= 0.35) { stateLabel = 'HIGH ENERGY'; stateClass = 'high'; }
    else if (abs >= 0.12) { stateLabel = 'EXCITED';    stateClass = 'excited'; }
    else                  { stateLabel = 'GROUND';     stateClass = 'ground'; }

    // ── Conflict detection: outer catalysts oppose inner state ────────────
    const conflicted = (
      Math.abs(outerBoost) >= 0.15 &&
      Math.sign(outerBoost) !== Math.sign(innerNorm) &&
      Math.abs(innerNorm) >= 0.10
    );

    // Count how many inner indicators agree with the direction
    const signedInner = innerNorm > 0 ? 1 : innerNorm < 0 ? -1 : 0;
    // Rough shell alignment check using bullish/bearish signal counts from pred
    const bullSignals = pred?.signals?.filter(s => s.dir > 0).length ?? 0;
    const bearSignals = pred?.signals?.filter(s => s.dir < 0).length ?? 0;
    const totalSignals = bullSignals + bearSignals;
    const shellsAligned = dir === 'up' ? bullSignals : dir === 'down' ? bearSignals : Math.min(bullSignals, bearSignals);
    const shellsTotal   = Math.max(totalSignals, 1);

    return {
      score: raw,
      innerScore: innerNorm,
      outerBoost,
      dir,
      stateLabel,
      stateClass,
      conflicted,
      triggers,
      shellsAligned,
      shellsTotal,
    };
  }

  // ── Market regime detection ─────────────────────────────────────────────
  function detectMarketRegime(pred) {
    const ind = pred?.indicators || {};
    const adx = ind.adx?.adx ?? 0;
    const atr = pred?.volatility?.atrPct ?? 0;
    const bbWidth = ind.bands?.width ?? null;

    if (atr > 3.0) {
      return { type: 'volatile', label: 'VOLATILE', cls: 'volatile', desc: `ATR ${atr.toFixed(1)}% — wide swings, widen stops` };
    }
    if (adx > 25) {
      const trendDir = ind.adx?.trend > 0 ? ' ▲' : ind.adx?.trend < 0 ? ' ▼' : '';
      return { type: 'trending', label: 'TREND' + trendDir, cls: 'trending', desc: `ADX ${adx.toFixed(0)} — directional, ride momentum` };
    }
    if (bbWidth !== null && bbWidth < 0.04) {
      return { type: 'squeeze', label: 'SQUEEZE', cls: 'breakout', desc: `BB squeeze — breakout imminent, wait for direction` };
    }
    if (adx < 18 && atr < 1.2) {
      return { type: 'ranging', label: 'RANGING', cls: 'ranging', desc: `ADX ${adx.toFixed(0)} — consolidation, fade extremes` };
    }
    return { type: 'neutral', label: 'NEUTRAL', cls: 'neutral', desc: 'No dominant regime — mixed conditions' };
  }

  // ── Entry quality grading ──────────────────────────────────────────────
  function computeEntryQuality(gs, regime, pred) {
    const abs  = Math.abs(gs.score);
    const conf = gs.shellsTotal > 0 ? gs.shellsAligned / gs.shellsTotal : 0;
    const rel  = pred?.backtest?.summary?.reliability ?? 0;

    if (gs.conflicted) {
      return { grade: 'D', label: 'WAIT', cls: 'wait', reason: 'Shell conflict — outer catalysts oppose inner state' };
    }
    if (abs >= 0.50 && conf >= 0.65 && rel >= 0.45) {
      return { grade: 'A', label: 'A-SETUP', cls: 'a', reason: 'High energy + strong confluence + reliable backtest' };
    }
    if (abs >= 0.35 && conf >= 0.55 && rel >= 0.40) {
      return { grade: 'B', label: 'B-SETUP', cls: 'b', reason: 'Good energy + majority aligned' };
    }
    if (abs >= 0.15 && conf >= 0.45) {
      return { grade: 'C', label: 'C-SETUP', cls: 'c', reason: 'Partial confluence — trade smaller size' };
    }
    return { grade: 'D', label: 'WAIT', cls: 'wait', reason: 'Low energy or insufficient confluence' };
  }

  // ================================================================
  // PERIODIC TABLE LAYOUT
  // ================================================================
  function buildCoinPeriodicTable(coin, cfm, pred) {
    const trendColor = cfm.trend === 'rising' ? 'var(--color-green)' : cfm.trend === 'falling' ? 'var(--color-red)' : 'var(--color-text-muted)';
    const srcKeys = Object.keys(cfm.sources || {});
    const weightClass = COIN_WEIGHT[coin.sym] || 'light';
    const coinRank = WEIGHT_RANK[weightClass];

    // Filter suborbitals by weight class
    const activeOrbitals = SUBORBITALS.filter(orb => {
      const required = ORBITAL_ACCESS[orb.weight] || 1;
      return coinRank >= required;
    });

    const shellCount = new Set(activeOrbitals.map(o => o.shell)).size;
    const atomicMass = activeOrbitals.length;

    // Merge prediction indicators into a flat lookup for suborbitals
    const ind = pred?.indicators || {};
    const bookData = ind.book || {};
    const flowData = ind.flow || {};
    const dexMeta = cfm.dexMeta || {};
    const cbPrice = cfm.sources?.CB || 0;

    const vals = {
      ...cfm,
      _rsi: ind.rsi?.value ?? 50,
      _macd: computeQuickMACD(cfm),
      _emaCross: ind.ema?.value ?? 0,
      _obvSlope: ind.obv?.slope ?? 0,
      _volRatio: ind.volume?.ratio ?? 1,
      _atrPct: pred?.volatility?.atrPct ?? 0,
      _bookImbal: bookData.imbalance ?? 0,
      _aggrBuy: flowData.buyRatio ?? 50,
      _cbPremium: cbPrice > 0 && cfm.cfmRate > 0 ? ((cbPrice - cfm.cfmRate) / cfm.cfmRate) * 100 : 0,
      _dexVol: dexMeta.vol ?? 0,
      _dexLiq: dexMeta.liq ?? 0,
      // Derivatives
      _funding: pred?.derivatives?.funding ?? 0,
      _oi: pred?.derivatives?.oi ?? 0,
      _squeezeScore: pred?.squeeze ? (pred.squeeze.severity === 'high' ? 2 : 1) : 0,
      _squeezeType: pred?.squeeze?.type ?? null,
      // CVD
      _cvdSlope: pred?.cvd?.slope ?? 0,
      // Prediction Markets
      _mktConsensus: window.PredictionMarkets?.getCoin(coin.sym)?.combinedProb ?? null,
      // Social Sentiment
      _xSentiment: window.SocialSentiment?.getCoin(coin.sym)?.score ?? null,
    };

    // ── Ground state synthesis ──────────────────────────────────────────
    const gs     = computeGroundState(vals, pred, weightClass);
    const regime = detectMarketRegime(pred);
    const eq     = computeEntryQuality(gs, regime, pred);

    // Ground state bar: fill from centre to each side
    const barPct    = Math.abs(gs.score) * 50;  // 0-50% each side from centre
    const barFill   = `left:${gs.dir === 'down' ? 50 - barPct : 50}%;width:${barPct}%;`;

    const triggerBadges = gs.triggers.map(t =>
      `<span class="gs-trigger ${t.dir} ${t.strength}" title="${t.sym}">${t.sym} ${t.label}</span>`
    ).join('');

    const conflictHtml = gs.conflicted ? `
      <div class="gs-conflict-warn">⚠ Shell conflict — outer catalysts oppose inner state. Reduce size.</div>
    ` : '';

    const gsHtml = `
      <div class="gs-wrap" onclick="event.stopPropagation()">
        <div class="gs-header-row">
          <span class="gs-state-label ${gs.dir}">${gs.stateLabel}</span>
          <div class="gs-bar-outer">
            <div class="gs-bar-center"></div>
            <div class="gs-bar-fill ${gs.dir}" style="${barFill}"></div>
          </div>
          <span style="font-size:10px;font-family:var(--font-mono);color:${gs.dir === 'up' ? 'var(--color-green)' : gs.dir === 'down' ? 'var(--color-red)' : 'var(--color-text-muted)'}">
            ${gs.score >= 0 ? '+' : ''}${gs.score.toFixed(2)}
          </span>
          <span class="gs-grade ${eq.cls}" title="${eq.reason}">${eq.label}</span>
          <span class="gs-regime ${regime.cls}" title="${regime.desc}">${regime.label}</span>
        </div>
        <div class="gs-meta-row">
          ${triggerBadges}
          <span class="gs-confluence ${gs.shellsAligned / gs.shellsTotal < 0.45 ? 'warn' : ''}">${gs.shellsAligned}/${gs.shellsTotal} shells</span>
        </div>
        ${conflictHtml}
      </div>
    `;

    const weightLabel = { heavy: 'Heavy', mid: 'Mid', light: 'Light' }[weightClass];
    const weightBadgeColor = { heavy: 'var(--color-gold)', mid: 'var(--color-primary)', light: 'var(--color-text-faint)' }[weightClass];
    const expanded = cfmExpanded.has(coin.sym);
    const partitionCards = (cfm.partitions || []).map(part => `
      <div class="cfm-detail-card">
        <span class="cfm-detail-label">Partition ${part.i}</span>
        <strong>${part.vwm ? fmtPrice(part.vwm) : '—'}</strong>
        <small>${part.n} samples</small>
      </div>
    `).join('');
    const sourceCards = Object.entries(cfm.sources || {}).map(([src, value]) => `
      <div class="cfm-detail-card">
        <span class="cfm-detail-label">${src}</span>
        <strong>${fmtPrice(value)}</strong>
        <small>${src === 'DEX' && cfm.dexMeta?.pair ? cfm.dexMeta.pair : 'live source'}</small>
      </div>
    `).join('');

    return `
      <div class="cfm-coin-block ${expanded ? 'expanded' : ''}" data-cfm-sym="${coin.sym}">
        <button type="button" class="cfm-coin-header cfm-toggle" data-cfm-toggle="${coin.sym}" style="border-left:3px solid ${coin.color};flex-wrap:wrap">
          <div class="cfm-coin-icon" style="background:${coin.color}22;color:${coin.color}">${coinIcon(coin.sym)}</div>
          <div class="cfm-coin-meta">
            <div class="cfm-coin-sym">
              ${coin.sym}
              <span style="font-size:9px;padding:1px 6px;border-radius:9999px;background:${weightBadgeColor}22;color:${weightBadgeColor};font-weight:700;margin-left:6px;letter-spacing:0.04em">${weightLabel} · ${atomicMass} orbitals · ${shellCount} shells</span>
            </div>
            <div class="cfm-coin-name">${coin.name} · ${srcKeys.length}/4 sources · ${cfm.sampleCount} samples</div>
          </div>
          <div>
            <div class="cfm-coin-rate" style="color:${trendColor}">${fmtPrice(cfm.cfmRate)}</div>
            <div class="cfm-coin-sub">
              <span style="color:${cfm.momentum >= 0 ? 'var(--color-green)' : 'var(--color-red)'}">${cfm.momentum >= 0 ? '+' : ''}${cfm.momentum.toFixed(3)}%</span>
              · ${cfm.trend}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:3px;align-items:center">
            ${['CDC','CB','GKO','DEX'].map(src => {
              const has = srcKeys.includes(src);
              const c = src === 'CDC' ? '#1a6eff' : src === 'CB' ? '#0052ff' : src === 'GKO' ? '#8dc63f' : '#a259ff';
              return `<span title="${src}: ${cfm.sources?.[src] ? fmtPrice(cfm.sources[src]) : 'N/A'}" style="width:6px;height:6px;border-radius:50%;background:${has ? c : 'var(--color-border)'};opacity:${has ? 1 : 0.25}"></span>`;
            }).join('')}
            <span class="cfm-expand-icon">${expanded ? '−' : '+'}</span>
          </div>
          ${gsHtml}
        </button>
        <div class="cfm-table">
          ${activeOrbitals.map(orb => renderSuborbital(orb, vals, coin.color)).join('')}
        </div>
        <div class="cfm-expand-panel ${expanded ? 'open' : ''}">
          <div class="cfm-detail-grid">
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Cross Spread</span>
              <strong>${cfm.spread.toFixed(3)}%</strong>
              <small>venue dispersion</small>
            </div>
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Convergence</span>
              <strong>${cfm.convergence.toFixed(3)}%</strong>
              <small>lower is tighter</small>
            </div>
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Bid / Ask</span>
              <strong>${cfm.bidAsk.toFixed(4)}%</strong>
              <small>market tightness</small>
            </div>
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Backtest Quality</span>
              <strong>${pred?.backtest ? Math.round((pred.backtest.summary?.reliability || 0) * 100) + '%' : '—'}</strong>
              <small>${pred?.diagnostics?.qualityLabel || 'live only'}</small>
            </div>
            ${partitionCards}
            ${sourceCards}
          </div>
          ${cfm.dexMeta ? `
            <div class="cfm-detail-strip">
              <span class="screener-chip">${cfm.dexMeta.chain || 'dex'} / ${cfm.dexMeta.dex || 'aggregated'}</span>
              <span class="screener-chip">${cfm.dexMeta.pair || 'pair n/a'}</span>
              <span class="screener-chip">DEX Vol ${fmtCompactUsd(cfm.dexMeta.vol)}</span>
              <span class="screener-chip">DEX Liq ${fmtCompactUsd(cfm.dexMeta.liq)}</span>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ---- Signal evaluation: determines if an orbital is flashing an opportunity ----
  // Returns { signal: 'scalp'|'fade'|'danger'|'even'|null, reason: string }
  function evaluateSignal(orb, raw, vals = {}) {
    if (raw === undefined || raw === null) return { signal: null, reason: '', tag: '' };
    const mk = (signal, tag, reason) => ({ signal, tag, reason });
    switch (orb.sym) {
      case 'RSI':
        if (raw >= 78) return mk('bear', 'REV-DN', 'RSI ' + raw.toFixed(0) + ' \u2014 extreme overbought, expect DOWN');
        if (raw <= 22) return mk('bull', 'REV-UP', 'RSI ' + raw.toFixed(0) + ' \u2014 extreme oversold, expect UP');
        if (raw >= 70) return mk('bear', 'REV-DN', 'RSI ' + raw.toFixed(0) + ' \u2014 overbought, contrarian fade');
        if (raw <= 30) return mk('bull', 'REV-UP', 'RSI ' + raw.toFixed(0) + ' \u2014 oversold, bounce scalp');
        if (raw > 45 && raw < 55) return mk('even', 'EVEN', 'RSI neutral \u2014 no edge');
        return mk(null, '', '');
      case 'MOM':
        if (raw > 0.5) return mk('bull', 'TRD-UP', 'Momentum +' + raw.toFixed(2) + '% \u2014 ride the wave');
        if (raw < -0.5) return mk('bear', 'TRD-DN', 'Momentum ' + raw.toFixed(2) + '% \u2014 expect DOWN');
        if (raw > -0.05 && raw < 0.05) return mk('even', 'EVEN', 'Flat momentum \u2014 break-even zone');
        return mk(null, '', '');
      case 'MCD':
        if (raw > 0.005) return mk('bull', 'TRD-UP', 'MACD bullish divergence \u2014 VWAP > TWAP');
        if (raw < -0.005) return mk('bear', 'TRD-DN', 'MACD bearish \u2014 VWAP < TWAP, expect DOWN');
        return mk('even', 'EVEN', 'MACD flat \u2014 no divergence');
      case 'EMA':
        if (raw > 0.3) return mk('bull', 'TRD-UP', 'EMA bull cross +' + raw.toFixed(2) + '% \u2014 trending UP');
        if (raw < -0.3) return mk('bear', 'TRD-DN', 'EMA bear cross ' + raw.toFixed(2) + '% \u2014 trending DOWN');
        if (Math.abs(raw) < 0.05) return mk('even', 'EVEN', 'EMA converging \u2014 no trend');
        return mk(null, '', '');
      case 'OBV':
        if (raw > 50) return mk('bull', 'FLOW-UP', 'Heavy accumulation \u2014 buyers loading');
        if (raw < -50) return mk('bear', 'FLOW-DN', 'Distribution \u2014 smart money selling');
        if (Math.abs(raw) < 5) return mk('even', 'EVEN', 'OBV flat \u2014 no conviction');
        return mk(null, '', '');
      case 'VDL':
        if (raw > 1.4) return mk('bull', 'FLOW-UP', 'Buy pressure ' + raw.toFixed(2) + 'x \u2014 scalp with momentum');
        if (raw < 0.7) return mk('bear', 'FLOW-DN', 'Sell pressure ' + raw.toFixed(2) + 'x \u2014 expect DOWN');
        if (raw > 0.95 && raw < 1.05) return mk('even', 'EVEN', 'Volume balanced \u2014 coin flip');
        return mk(null, '', '');
      case 'ATR':
        if (raw > 3) return mk('danger', 'RISK', 'High vol ' + raw.toFixed(1) + '% \u2014 big moves, wide targets');
        if (raw < 0.3) return mk('even', 'EVEN', 'Low vol \u2014 not worth the spread');
        return mk(null, '', '');
      case 'BKI':
        if (raw > 0.35) return mk('bull', 'BOOK-UP', 'Bid wall \u2014 support below, expect UP');
        if (raw < -0.35) return mk('bear', 'BOOK-DN', 'Ask wall \u2014 resistance above, fade');
        return mk(null, '', '');
      case 'AGR':
        if (raw > 65) return mk('bull', 'TAPE-UP', 'Buy aggression ' + raw.toFixed(0) + '% \u2014 tape says UP');
        if (raw < 35) return mk('bear', 'TAPE-DN', 'Sell aggression ' + (100 - raw).toFixed(0) + '% \u2014 tape says DOWN');
        if (raw > 47 && raw < 53) return mk('even', 'EVEN', 'Trade flow 50/50 \u2014 no edge on tape');
        return mk(null, '', '');
      case 'XSP':
        if (raw > 2) return mk('danger', 'RISK', 'Wide spread ' + raw.toFixed(1) + '% \u2014 fragmented liquidity');
        if (raw > 0.5) return mk('danger', 'ARB?', 'Arb spread ' + raw.toFixed(2) + '% \u2014 cross-exchange opportunity');
        return mk(null, '', '');
      case 'CBP':
        if (raw > 0.1) return mk('bull', 'INST-UP', 'CB premium +' + raw.toFixed(2) + '% \u2014 institutional buying');
        if (raw < -0.1) return mk('bear', 'INST-DN', 'CB discount ' + raw.toFixed(2) + '% \u2014 institutional selling');
        return mk(null, '', '');
      case 'TRD':
        if (raw === 'rising') return mk('bull', 'TRND-UP', 'Trend rising \u2014 go with it');
        if (raw === 'falling') return mk('bear', 'TRND-DN', 'Trend falling \u2014 sell rallies');
        return mk('even', 'EVEN', 'Flat \u2014 range-bound, no directional edge');
      case 'FND':
        if (raw < -0.5) return mk('bull', 'POS-UP', 'Funding ' + raw.toFixed(3) + '% \u2014 shorts overcrowded, squeeze risk = expect UP');
        if (raw < -0.1) return mk('bull', 'POS-UP', 'Funding negative ' + raw.toFixed(3) + '% \u2014 bearish positioning, contrarian UP');
        if (raw > 0.3) return mk('bear', 'POS-DN', 'Funding +' + raw.toFixed(3) + '% \u2014 longs overcrowded, expect DOWN');
        if (raw > 0.1) return mk('bear', 'POS-DN', 'Funding elevated +' + raw.toFixed(3) + '% \u2014 longs paying, expect DOWN');
        return mk(null, '', '');
      case 'SQZ':
        if (raw >= 1) {
          if (vals._squeezeType === 'short_squeeze') return mk('bull', raw >= 2 ? 'SQZ-UP' : 'SQ-UP', raw >= 2 ? 'HIGH squeeze risk \u2014 liquidation cascade imminent, trade squeeze UP' : 'Medium squeeze risk \u2014 watch for upward cascade trigger');
          if (vals._squeezeType === 'long_squeeze') return mk('bear', raw >= 2 ? 'SQZ-DN' : 'SQ-DN', raw >= 2 ? 'HIGH squeeze risk \u2014 liquidation cascade imminent, trade squeeze DOWN' : 'Medium squeeze risk \u2014 watch for downward cascade trigger');
          return mk('danger', 'SQZ?', raw >= 2 ? 'HIGH squeeze risk \u2014 liquidation cascade imminent, direction unclear' : 'Medium squeeze risk \u2014 watch for cascade trigger');
        }
        return mk(null, '', '');
      case 'CVD':
        if (raw > 30) return mk('bull', 'FLOW-UP', 'CVD rising sharply \u2014 aggressive buying, momentum scalp');
        if (raw < -30) return mk('bear', 'FLOW-DN', 'CVD falling sharply \u2014 aggressive selling, expect DOWN');
        if (Math.abs(raw) < 5) return mk('even', 'EVEN', 'CVD flat \u2014 no aggressive order flow');
        return mk(null, '', '');
      case 'MKT':
        if (raw === null || raw === undefined) return mk(null, '', '');
        if (raw > 62) return mk('bull', 'MKT-UP', 'Markets imply ' + raw.toFixed(0) + '% UP — Kalshi/Polymarket consensus');
        if (raw < 38) return mk('bear', 'MKT-DN', 'Markets imply ' + (100 - raw).toFixed(0) + '% DOWN — prediction market consensus');
        if (raw > 47 && raw < 53) return mk('even', 'EVEN', 'Markets split ' + raw.toFixed(0) + '/50 — no prediction market edge');
        return mk(null, '', '');
      case 'SNT':
        if (raw === null || raw === undefined) return mk(null, '', '');
        if (raw >= 65)  return mk('bull', 'SOC-UP', 'X crowd: +' + raw.toFixed(0) + ' — FOMO building, strong bullish sentiment');
        if (raw >= 35)  return mk('bull', 'SOC-UP', 'X crowd: +' + raw.toFixed(0) + ' — positive social flow');
        if (raw <= -65) return mk('bear', 'SOC-DN', 'X crowd: ' + raw.toFixed(0) + ' — fear/panic spreading');
        if (raw <= -35) return mk('bear', 'SOC-DN', 'X crowd: ' + raw.toFixed(0) + ' — negative social flow');
        if (Math.abs(raw) < 15) return mk('even', 'EVEN', 'X crowd: ' + raw.toFixed(0) + ' — mixed, no edge');
        return mk(null, '', '');
      default:
        return mk(null, '', '');
    }
  }

  function renderSuborbital(orb, vals, coinColor) {
    const raw = vals[orb.key];
    const { display, sentiment } = formatSuborbital(orb, raw);
    const shellClass = orb.shell.replace(/[0-9]/g, '');
    const sig = evaluateSignal(orb, raw, vals);

    const flashClass = sig.signal === 'bull' ? 'flash-bull' : sig.signal === 'bear' ? 'flash-bear' : sig.signal === 'danger' ? 'flash-danger' : sig.signal === 'even' ? 'dead-flat' : '';
    const tagHtml = sig.signal ? `<span class="cfm-signal-tag ${sig.signal}">${sig.tag || sig.signal}</span>` : '';

    return `
      <div class="cfm-element ${sentiment} ${flashClass}" title="${orb.desc}${sig.reason ? '\n\u26a1 ' + sig.reason : ''}">
        <span class="cfm-atomic">${orb.num}</span>
        <span class="cfm-shell ${shellClass}">${orb.shell}</span>
        <div class="cfm-sym" style="color:${coinColor}">${orb.sym}</div>
        <div class="cfm-name">${orb.name}</div>
        <div class="cfm-rate" style="color:${sentiment === 'bull' ? 'var(--color-green)' : sentiment === 'bear' ? 'var(--color-red)' : 'var(--color-text)'}">${display}</div>
        <div class="cfm-pulse live"></div>
        ${tagHtml}
      </div>
    `;
  }

  function formatSuborbital(orb, raw) {
    if (raw === undefined || raw === null || (typeof raw === 'number' && !isFinite(raw))) return { display: '\u2014', sentiment: 'flat' };
    if (typeof raw === 'number') raw = Number(raw); // ensure clean number
    switch (orb.fmt) {
      case 'price': return { display: fmtPrice(raw), sentiment: 'flat' };
      case 'num1': {
        const s = raw > 70 ? 'bear' : raw < 30 ? 'bull' : raw > 55 ? 'bull' : raw < 45 ? 'bear' : 'flat';
        return { display: raw.toFixed(1), sentiment: s };
      }
      case 'pct2': return { display: raw.toFixed(2) + '%', sentiment: raw > 2 ? 'warn' : 'flat' };
      case 'pct3': return { display: (raw >= 0 ? '+' : '') + raw.toFixed(3) + '%', sentiment: raw > 0.03 ? 'bull' : raw < -0.03 ? 'bear' : 'flat' };
      case 'pct4': return { display: raw.toFixed(4) + '%', sentiment: raw > 0.05 ? 'warn' : 'flat' };
      case 'sign2': return { display: (raw >= 0 ? '+' : '') + raw.toFixed(2), sentiment: raw > 1 ? 'bull' : raw < -1 ? 'bear' : 'flat' };
      case 'sign4': return { display: (raw >= 0 ? '+' : '') + raw.toFixed(4), sentiment: raw > 0 ? 'bull' : raw < 0 ? 'bear' : 'flat' };
      case 'ratio': return { display: raw.toFixed(2) + 'x', sentiment: raw > 1.15 ? 'bull' : raw < 0.85 ? 'bear' : 'flat' };
      case 'trend': return { display: String(raw).charAt(0).toUpperCase() + String(raw).slice(1), sentiment: raw === 'rising' ? 'bull' : raw === 'falling' ? 'bear' : 'flat' };
      case 'of4': return { display: raw + '/4', sentiment: raw >= 3 ? 'bull' : raw <= 1 ? 'warn' : 'flat' };
      case 'pct1': {
        const s = raw > 60 ? 'bull' : raw < 40 ? 'bear' : 'flat';
        return { display: raw.toFixed(1) + '%', sentiment: s };
      }
      case 'prob1': {
        // Probability 0–1 stored in key, displayed as percentage
        const pct = raw * 100;
        const s = pct > 62 ? 'bull' : pct < 38 ? 'bear' : 'flat';
        return { display: pct.toFixed(0) + '%', sentiment: s };
      }
      case 'compactUsd': {
        if (raw >= 1e9) return { display: '$' + (raw / 1e9).toFixed(1) + 'B', sentiment: 'flat' };
        if (raw >= 1e6) return { display: '$' + (raw / 1e6).toFixed(1) + 'M', sentiment: 'flat' };
        if (raw >= 1e3) return { display: '$' + (raw / 1e3).toFixed(0) + 'K', sentiment: 'flat' };
        return { display: raw > 0 ? '$' + raw.toFixed(0) : '\u2014', sentiment: 'flat' };
      }
      case 'fundingRate': {
        const s = raw > 0.3 ? 'warn' : raw < -0.3 ? 'warn' : raw > 0.01 ? 'bull' : raw < -0.01 ? 'bear' : 'flat';
        return { display: (raw >= 0 ? '+' : '') + raw.toFixed(3) + '%', sentiment: s };
      }
      case 'squeeze': {
        if (raw >= 2) return { display: 'HIGH', sentiment: 'warn' };
        if (raw >= 1) return { display: 'MED', sentiment: 'warn' };
        return { display: 'LOW', sentiment: 'flat' };
      }
      case 'sentiment': {
        // X.com score: -100 to +100
        const s = raw >= 35 ? 'bull' : raw <= -35 ? 'bear' : 'flat';
        return { display: (raw >= 0 ? '+' : '') + Math.round(raw).toString(), sentiment: s };
      }
      default: return { display: String(raw), sentiment: 'flat' };
    }
  }

  // Quick MACD from cfm sample momentum (approximation from VWAP-TWAP divergence)
  function computeQuickMACD(cfm) {
    if (!cfm || !cfm.vwap15 || !cfm.twap15) return 0;
    return ((cfm.vwap15 - cfm.twap15) / cfm.twap15) * 100;
  }

  // ================================================================
  // VIEW: PREDICTIONS
  // ================================================================

  let predsLoaded = false;

  // ================================================================
  // QUICK DECISION PANEL — compact scannable strip at top of Predictions
  // ================================================================

  // Returns { primary, secondary } rationale strings for the decision band.
  // Priority: mean-reversion > strong trend > band stretch > VWAP > MACD > OBV > volume > market > generic
  function getDecisionRationale(pred) {
    const ind  = pred?.indicators || {};
    const dir  = predictionDirection(pred);
    const rsi  = ind.rsi?.value;
    const adx  = ind.adx?.adx;
    const bbPos = ind.bands?.position;
    const vwapDev = ind.vwap?.value;
    const stochK  = ind.stochrsi?.k;
    const mfi     = ind.mfi?.value;
    const obvSlope = ind.obv?.slope;
    const buyPct   = ind.volume?.buyPct;

    let primary   = '';
    let secondary = '';

    // ---- 0. Kalshi market odds — primary ground truth ────────────────────
    // YES price from Kalshi 15M series = crowd-implied probability price ≥ ref
    const _kCoinR = window.PredictionMarkets?.getCoin(pred?.sym);
    const _kProbR = _kCoinR?.kalshi15m?.probability ?? _kCoinR?.combinedProb ?? null;
    if (_kProbR !== null) {
      const kp = Math.round(_kProbR * 100);
      if      (_kProbR >= 0.68) primary = `Kalshi ${kp}% YES — crowd strongly pricing a rally`;
      else if (_kProbR <= 0.32) primary = `Kalshi ${100-kp}% NO — crowd pricing a drop`;
      else if (_kProbR >= 0.55) primary = `Kalshi ${kp}% YES — market leans bullish this window`;
      else if (_kProbR <= 0.45) primary = `Kalshi ${100-kp}% NO — market leans bearish`;
      else                       primary = `Kalshi near 50/50 (${kp}%) — uncertain, model drives verdict`;
    }

    if (!primary) {
    if (rsi != null && rsi < 30 && dir >= 0) {
      primary = `Mean reversion — RSI ${rsi.toFixed(0)}, oversold bounce`;
    } else if (rsi != null && rsi > 70 && dir <= 0) {
      primary = `Mean reversion — RSI ${rsi.toFixed(0)}, overbought fade`;
    } else if (stochK != null && stochK < 15 && dir >= 0) {
      primary = `StochRSI oversold — ${stochK.toFixed(0)}, reversal setup`;
    } else if (stochK != null && stochK > 85 && dir <= 0) {
      primary = `StochRSI overbought — ${stochK.toFixed(0)}, pullback risk`;
    } else if (mfi != null && mfi < 20 && dir >= 0) {
      primary = `MFI oversold — money flow exhausted, bounce likely`;
    } else if (mfi != null && mfi > 80 && dir <= 0) {
      primary = `MFI overbought — smart money distributing`;

    // ---- 2. Strong trend (ADX > 25) ----
    } else if (adx != null && adx > 28) {
      if (dir > 0) primary = `Strong uptrend — ADX ${adx.toFixed(0)}, trend continuation`;
      else if (dir < 0) primary = `Strong downtrend — ADX ${adx.toFixed(0)}, trend continuation`;
      else primary = `Trending market — ADX ${adx.toFixed(0)}, direction unclear`;

    // ---- 3. Bollinger Band stretch ----
    } else if (bbPos != null && bbPos >= 0.88) {
      primary = dir <= 0 ? `Upper-band stretch — overextended, reversion risk` : `Upper-band breakout — momentum expanding`;
    } else if (bbPos != null && bbPos <= 0.12) {
      primary = dir >= 0 ? `Lower-band stretch — oversold, snap-back setup` : `Lower-band breakdown — momentum extending`;

    // ---- 4. VWAP deviation ----
    } else if (vwapDev != null && Math.abs(vwapDev) > 1.2) {
      if (vwapDev > 0 && dir <= 0) primary = `VWAP extended — ${vwapDev.toFixed(1)}% above, mean reversion`;
      else if (vwapDev < 0 && dir >= 0) primary = `VWAP discount — ${Math.abs(vwapDev).toFixed(1)}% below, reversion bid`;
      else if (vwapDev > 0) primary = `VWAP momentum — price ${vwapDev.toFixed(1)}% above, bulls in control`;
      else primary = `VWAP breakdown — price ${Math.abs(vwapDev).toFixed(1)}% below VWAP`;

    // ---- 5. MACD ----
    } else if (ind.macd?.sig != null) {
      const hist = ind.macd.histogram;
      if (ind.macd.sig > 0 && hist > 0) primary = `MACD bull cross — histogram expanding, momentum building`;
      else if (ind.macd.sig < 0 && hist < 0) primary = `MACD bear cross — histogram deepening, sellers in control`;
      else if (ind.macd.sig > 0) primary = `MACD bullish — signal line above zero`;
      else if (ind.macd.sig < 0) primary = `MACD bearish — signal line below zero`;

    // ---- 6. EMA ----
    } else if (ind.ema?.value != null) {
      if (ind.ema.value > 0.15) primary = `EMA bull cross — short above long, trend aligning`;
      else if (ind.ema.value < -0.15) primary = `EMA bear cross — short below long, trend falling`;
      else primary = `EMA converging — breakout pending`;

    // ---- Generic fallback ----
    } else {
      if      (pred?.signal === 'strong_bull') primary = `Strong buy — multiple indicators aligned UP`;
      else if (pred?.signal === 'strong_bear') primary = `Strong sell — multiple indicators aligned DOWN`;
      else if (pred?.signal === 'bullish')     primary = `Bullish bias — majority of signals positive`;
      else if (pred?.signal === 'bearish')     primary = `Bearish bias — majority of signals negative`;
      else                                      primary = `Mixed signals — insufficient confluence`;
    }
    } // end !primary

    // ---- Secondary: pick the next most relevant fact ----
    if (obvSlope != null) {
      secondary = obvSlope > 0 ? `OBV: accumulation in progress` : `OBV: distribution detected`;
    } else if (buyPct != null && buyPct > 62) {
      secondary = `Volume: ${buyPct.toFixed(0)}% buy-side pressure`;
    } else if (buyPct != null && buyPct < 38) {
      secondary = `Volume: ${(100 - buyPct).toFixed(0)}% sell-side pressure`;
    } else if (ind.ichimoku?.label) {
      secondary = `Ichimoku: ${ind.ichimoku.label}`;
    } else if (ind.mktSentiment?.combined != null) {
      const pct = Math.round(ind.mktSentiment.combined * 100);
      secondary = `Prediction markets: ${pct}% UP probability`;
    } else if (ind.adx?.adx != null && !primary.includes('ADX')) {
      const trending = ind.adx.adx > 20;
      secondary = trending ? `ADX ${ind.adx.adx.toFixed(0)} — ${ind.adx.label.toLowerCase()}` : `ADX ${ind.adx.adx.toFixed(0)} — ranging / consolidation`;
    } else if (rsi != null && !primary.includes('RSI')) {
      secondary = `RSI ${rsi.toFixed(0)} — ${ind.rsi.label}`;
    }

    return { primary, secondary };
  }

  function buildQuickDecisionPanel(predArr) {
    if (!predArr || predArr.length === 0) return '';

    const ordered = PREDICTION_COINS
      .map(c => predArr.find(p => p.sym === c.sym))
      .filter(Boolean);

    let upCount = 0, downCount = 0, neutralCount = 0;

    const cards = ordered.map(pred => {
      const dir      = predictionDirection(pred);
      const dirClass = dir > 0 ? 'up' : dir < 0 ? 'down' : 'neutral';
      const arrow    = dir > 0 ? '▲' : dir < 0 ? '▼' : '→';
      const label    = dir > 0 ? 'UP' : dir < 0 ? 'DOWN' : 'FLAT';
      const score    = Number.isFinite(pred.score) ? (pred.score > 0 ? '+' : '') + pred.score.toFixed(2) : '—';
      const horizon  = pred.backtest?.summary?.preferredHorizon ? `${pred.backtest.summary.preferredHorizon}m` : '';
      const mkt      = pred.indicators?.mktSentiment;
      const kPct     = mkt?.kalshi != null ? Math.round(mkt.kalshi * 100) : null;
      const pPct     = mkt?.poly   != null ? Math.round(mkt.poly   * 100) : null;
      const mktRow   = (kPct != null || pPct != null) ? `
        <div class="dc-mkt-row">
          ${kPct != null ? `<span class="dc-badge-k">K:${kPct}%</span>` : ''}
          ${pPct != null ? `<span class="dc-badge-p">P:${pPct}%</span>` : ''}
        </div>` : '';

      // Ground state synthesis for this coin
      const coin      = PREDICTION_COINS.find(c => c.sym === pred.sym);
      const wClass    = COIN_WEIGHT[pred.sym] || 'light';
      const cfmSnap   = window.CFMEngine?.getAll?.()?.[pred.sym];
      const gsVals    = cfmSnap ? {
        ...cfmSnap,
        _emaCross:   pred.indicators?.ema?.value ?? 0,
        _obvSlope:   pred.indicators?.obv?.slope ?? 0,
        _volRatio:   pred.indicators?.volume?.ratio ?? 1,
        _bookImbal:  pred.indicators?.book?.imbalance ?? 0,
        _aggrBuy:    pred.indicators?.flow?.buyRatio ?? 50,
        _funding:    pred.derivatives?.funding ?? 0,
        _cvdSlope:   pred.cvd?.slope ?? 0,
        _squeezeScore: pred.squeeze ? (pred.squeeze.severity === 'high' ? 2 : 1) : 0,
        _squeezeType:  pred.squeeze?.type ?? null,
        _cbPremium:  cfmSnap.sources?.CB > 0 && cfmSnap.cfmRate > 0 ? ((cfmSnap.sources.CB - cfmSnap.cfmRate) / cfmSnap.cfmRate) * 100 : 0,
        _mktConsensus: window.PredictionMarkets?.getCoin(pred.sym)?.combinedProb ?? null,
        _xSentiment:   window.SocialSentiment?.getCoin(pred.sym)?.score ?? null,
      } : null;
      const gs   = gsVals ? computeGroundState(gsVals, pred, wClass) : null;
      const eq   = gs     ? computeEntryQuality(gs, detectMarketRegime(pred), pred) : null;

      const gsRow = gs ? `
        <div class="dc-gs-row">
          <span class="dc-gs-score ${gs.dir}" title="Ground state: ${gs.stateLabel}">${gs.dir === 'up' ? '▲' : gs.dir === 'down' ? '▼' : '—'} ${gs.score >= 0 ? '+' : ''}${gs.score.toFixed(2)}</span>
          <span class="gs-grade ${eq?.cls || 'wait'}">${eq?.label || '—'}</span>
          ${gs.conflicted ? `<span class="dc-conflict">⚠ CONFLICT</span>` : ''}
        </div>` : '';

      const { primary, secondary } = getDecisionRationale(pred);

      if (dir > 0) upCount++; else if (dir < 0) downCount++; else neutralCount++;

      return `
        <div class="decision-card ${dirClass}${gs?.conflicted ? ' conflicted' : ''}" data-scroll-pred="${pred.sym}" title="${pred.sym} — ${label}  score ${score}">
          <span class="dc-sym">${pred.sym}</span>
          <span class="dc-arrow">${arrow}</span>
          <span class="dc-label">${label}</span>
          <span class="dc-score">${score}</span>
          ${horizon ? `<span class="dc-horizon">${horizon}</span>` : ''}
          ${mktRow}
          ${gsRow}
          ${primary   ? `<span class="dc-rationale-primary">${primary}</span>`     : ''}
          ${secondary ? `<span class="dc-rationale-secondary">${secondary}</span>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="decision-band">
        <div class="decision-band-header">
          <span class="decision-band-title">⚡ Market Calls</span>
          <div class="decision-band-tally">
            <span class="tally-up">${upCount} ▲ UP</span>
            <span class="tally-down">${downCount} ▼ DOWN</span>
            <span class="tally-flat">${neutralCount} → FLAT</span>
          </div>
        </div>
        <div class="decision-band-coins">
          ${cards}
        </div>
      </div>`;
  }

  async function renderPredictions() {
    const _myRV = _rv; // capture version — bail after any await if stale

    // Fire-and-forget: start prediction engine in background if not yet loaded
    if (!predsLoaded && !predictionRunInFlight) {
      predictionRunInFlight = PredictionEngine.runAll();
      predictionRunInFlight
        .then(() => { predsLoaded = true; predictionRunInFlight = null; snapshotPredictions(); if (currentView === 'predictions') render(); })
        .catch(e => { predictionRunInFlight = null; console.error('[Predictions] engine error:', e); if (currentView === 'predictions') render(); });
    }

    if (_rv !== _myRV) return; // guard: stale render version
    const preds = PredictionEngine.getAll();
    const session = PredictionEngine.getSession();
    const predArr = Object.values(preds).filter(p => p.price > 0);
    const bullCount = predArr.filter(p => p.signal === 'strong_bull' || p.signal === 'bullish').length;
    const bearCount = predArr.filter(p => p.signal === 'strong_bear' || p.signal === 'bearish').length;
    const backtests = predArr.map(p => p.backtest).filter(Boolean);
    const avgMetric = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const rankedBacktests = [...backtests].sort((a, b) => (b.summary?.reliability || 0) - (a.summary?.reliability || 0));
    const rankedTradeFit = [...backtests].sort((a, b) => ((b.summary?.tradeFit ?? b.summary?.reliability ?? 0)) - ((a.summary?.tradeFit ?? a.summary?.reliability ?? 0)));
    const bestBacktest = rankedBacktests[0] || null;
    const weakestBacktest = rankedBacktests[rankedBacktests.length - 1] || null;
    const bestTradeFit = rankedTradeFit[0] || null;
    const avgReliability = avgMetric(backtests.map(bt => (bt.summary?.reliability || 0.5) * 100));
    const avgTradeFit = avgMetric(backtests.map(bt => ((bt.summary?.tradeFit ?? bt.summary?.reliability ?? 0.5) * 100)));
    const advancedBacktests = backtests.map(bt => bt.advanced).filter(Boolean);
    const avgAdvancedQuality = advancedBacktests.length
      ? avgMetric(advancedBacktests.map(bt => (bt.summary?.reliability || 0.5) * 100))
      : avgReliability;
    const avgAdvancedFit = advancedBacktests.length
      ? avgMetric(advancedBacktests.map(bt => (bt.summary?.tradeFit || bt.summary?.reliability || 0.5) * 100))
      : avgTradeFit;
    const advancedVolSnapshots = backtests
      .map(bt => bt.volatility || bt.advanced?.volatility)
      .concat(predArr.map(p => p.volatilitySnapshot || (p.volatility?.ewmaVolPct ? p.volatility : null)))
      .filter(Boolean);
    const avgAdvancedVolPct = avgMetric(advancedVolSnapshots.map(v => Number(v.ewmaVolPct || v.atrPct) || 0));
    const avgAdvancedVolPercentile = avgMetric(advancedVolSnapshots.map(v => Number(v.volPercentile) || 50));
    const avgAdvancedJumpRisk = avgMetric(advancedVolSnapshots.map(v => (Number(v.jumpRatio) || 0) * 100));
    const regimeCounts = advancedVolSnapshots.reduce((acc, v) => {
      const key = String(v.regime || v.label || 'NORMAL').toUpperCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const dominantAdvancedRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || (avgReliability >= 55 ? 'NORMAL' : 'CALM');
    const preferredHorizonCounts = PREDICTION_HORIZONS.map(horizonMin => ({
      horizonMin,
      count: backtests.filter(bt => (bt.summary?.preferredHorizon || 5) === horizonMin).length,
    }));
    const preferredLeader = preferredHorizonCounts.slice().sort((a, b) => b.count - a.count)[0] || { horizonMin: 5, count: 0 };
    const horizonSummaries = PREDICTION_HORIZONS.map(horizonMin => {
      const key = `h${horizonMin}`;
      const active = backtests
        .map(bt => bt[key])
        .filter(stats => stats?.activeSignals);
      return {
        horizonMin,
        key,
        label: `${horizonMin}m`,
        hasData: active.length > 0,
        avgWin: avgMetric(active.map(stats => stats.winRate)),
        avgEdge: avgMetric(active.map(stats => stats.avgSignedReturn)),
        avgReturn: avgMetric(active.map(stats => stats.equity?.returnPct || 0)),
        avgDrawdown: avgMetric(active.map(stats => stats.equity?.maxDrawdownPct || 0)),
      };
    });
    const maxDrawdown = horizonSummaries.reduce((max, horizon) => Math.max(max, horizon.avgDrawdown || 0), 0);

    // Collect all scalp setups across all coins
    const allSetups = [];
    predArr.forEach(p => {
      (p.scalpSetups || []).forEach(s => {
        allSetups.push({ ...s, coin: p.sym, color: p.color });
      });
    });
    const highSetups = allSetups.filter(s => s.strength === 'high');
    const contrarian = allSetups.filter(s => s.type.startsWith('contrarian_'));

    content.innerHTML = `
      ${!predsLoaded ? `<div style="display:flex;align-items:center;gap:10px;padding:8px 16px;background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.3);border-radius:6px;margin-bottom:12px;font-size:13px;color:#ffc107"><div style="width:16px;height:16px;border:2px solid rgba(255,193,7,0.3);border-top-color:#ffc107;border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0"></div><span>Scoring UP/DOWN markets\u2026</span></div>` : ''}
      ${buildQuickDecisionPanel(predArr)}
      <div id="pred-accuracy-badge" style="text-align:center;padding:4px 0 6px;font-size:12px;letter-spacing:.5px"></div>
      <div class="pred-disclaimer">
        \u26a0 <strong>Not financial advice.</strong> These UP/DOWN calls are algorithmic signals derived from RSI, VWAP deviation, EMA crosses, OBV, order book imbalance, and trade flow analysis on 5-minute candles. They represent statistical probabilities, not certainties. Always manage risk.
      </div>

      <!-- Session + Scalp Timing Bar -->
      <div class="kpi-bar" style="margin-bottom:14px">
        <div class="kpi-card" style="border-left:3px solid ${session.current.scalp ? 'var(--color-green)' : 'var(--color-text-faint)'}">
          <div class="kpi-label">Current Session</div>
          <div class="kpi-val ${session.current.scalp ? 'green' : ''}" style="font-size:15px">${session.current.label}</div>
          <div class="kpi-sub">${session.current.desc}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Next Scalp Window</div>
          <div class="kpi-val blue" style="font-size:15px">${session.nextScalp.label}</div>
          <div class="kpi-sub">in ${session.minsToNext} min &middot; ${session.nextScalp.desc.split('\u2014')[0]}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Market Sentiment</div>
          <div class="kpi-val ${bullCount > bearCount ? 'green' : bearCount > bullCount ? 'red' : ''}" style="font-size:15px">${bullCount > bearCount ? 'Leaning Bullish' : bearCount > bullCount ? 'Leaning Bearish' : 'Mixed'}</div>
          <div class="kpi-sub"><span style="color:var(--color-green)">${bullCount}\u2191</span> / <span style="color:var(--color-red)">${bearCount}\u2193</span> / ${predArr.length - bullCount - bearCount} neutral</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Active Setups</div>
          <div class="kpi-val gold" style="font-size:15px">${highSetups.length} High</div>
          <div class="kpi-sub">${contrarian.length} contrarian &middot; ${allSetups.length} total</div>
        </div>
      </div>

      ${backtests.length > 0 ? `
        <div class="card" style="margin-bottom:14px">
          <div class="card-title">Walk-Forward Backtest</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:10px">
            <div class="kpi-card">
              <div class="kpi-label">Model Reliability</div>
              <div class="kpi-val ${avgReliability >= 60 ? 'green' : avgReliability < 45 ? 'red' : 'gold'}">${Math.round(avgReliability)}%</div>
              <div class="kpi-sub">Broad walk-forward quality across ${backtests.length} coins</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Short-Term Trade Fit</div>
              <div class="kpi-val ${avgTradeFit >= 62 ? 'green' : avgTradeFit < 46 ? 'red' : 'gold'}">${Math.round(avgTradeFit)}%</div>
              <div class="kpi-sub">${preferredLeader.count}/${backtests.length} coins prefer ${preferredLeader.horizonMin}m timing · best ${bestTradeFit?.sym || '—'}</div>
            </div>
            ${horizonSummaries.map(horizon => `
              <div class="kpi-card">
                <div class="kpi-label">${horizon.label} Hit Rate</div>
                <div class="kpi-val ${horizon.avgWin >= 55 ? 'green' : horizon.avgWin < 45 ? 'red' : ''}">${horizon.hasData ? horizon.avgWin.toFixed(1) : '—'}%</div>
                <div class="kpi-sub">Avg edge ${horizon.hasData ? fmtPct(horizon.avgEdge) : '—'} · Eq ${horizon.hasData ? fmtPct(horizon.avgReturn) : '—'}</div>
              </div>
            `).join('')}
            <div class="kpi-card">
              <div class="kpi-label">1m / 5m / 10m / 15m Drawdown</div>
              <div class="kpi-val ${maxDrawdown <= 6 ? 'green' : maxDrawdown >= 10 ? 'red' : 'gold'}">${horizonSummaries.map(horizon => horizon.hasData ? `${horizon.avgDrawdown.toFixed(1)}%` : '—').join(' / ')}</div>
              <div class="kpi-sub">Compounded from $${bestBacktest?.summary?.startingEquity || 100} test equity</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Strongest / Weakest</div>
              <div class="kpi-val" style="font-size:14px">${bestBacktest ? bestBacktest.sym : '—'} / ${weakestBacktest ? weakestBacktest.sym : '—'}</div>
              <div class="kpi-sub">${bestBacktest ? Math.round((bestBacktest.summary?.reliability || 0) * 100) : '—'}% quality · ${bestTradeFit ? Math.round(((bestTradeFit.summary?.tradeFit ?? 0) * 100)) : '—'}% fit</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Advanced Backtest</div>
              <div class="kpi-val ${avgAdvancedQuality >= 58 ? 'green' : avgAdvancedQuality < 42 ? 'red' : 'gold'}">${Math.round(avgAdvancedQuality)}%</div>
              <div class="kpi-sub">${Math.round(avgAdvancedFit)}% fit · ${dominantAdvancedRegime} regime · EWMA ${avgAdvancedVolPct.toFixed(2)}%</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">7d Volatility Regime</div>
              <div class="kpi-val ${avgAdvancedVolPercentile >= 90 ? 'red' : avgAdvancedVolPercentile >= 75 ? 'gold' : avgAdvancedVolPercentile < 25 ? 'green' : ''}">${dominantAdvancedRegime} (${avgAdvancedVolPercentile.toFixed(0)}p)</div>
              <div class="kpi-sub">${advancedVolSnapshots.length ? `Jump risk ${avgAdvancedJumpRisk.toFixed(1)}% across ${advancedVolSnapshots.length} coins` : `Volatility active · ${avgAdvancedVolPct.toFixed(2)}% EWMA`}</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--color-text-muted);line-height:1.5">
            Signals now separate broad model quality from short-horizon trade fit. The backtest still grades the full walk-forward history, while the trade-fit score leans toward the 1m / 5m / 10m / 15m ladder you are actually trading.
          </div>
        </div>
      ` : ''}

      <!-- Scalp Timing + Contrarian Setups Section -->
      ${allSetups.length > 0 ? `
        <div class="card" style="margin-bottom:14px">
          <div class="card-title" style="color:var(--color-gold)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Live Scalp & Contrarian Setups
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px">
            ${allSetups.sort((a,b) => (b.strength === 'high' ? 2 : b.strength === 'medium' ? 1 : 0) - (a.strength === 'high' ? 2 : a.strength === 'medium' ? 1 : 0)).map(s => {
              const dirIcon = s.direction === 'long' || s.direction === 'up' ? '\u2191' : s.direction === 'short' || s.direction === 'down' ? '\u2193' : '\u2014';
              const dirColor = s.direction === 'long' || s.direction === 'up' ? 'var(--color-green)' : s.direction === 'short' || s.direction === 'down' ? 'var(--color-red)' : 'var(--color-text-muted)';
              const strengthColor = s.strength === 'high' ? 'var(--color-gold)' : s.strength === 'warning' ? 'var(--color-orange)' : 'var(--color-text-muted)';
              const isCon = s.type.startsWith('contrarian_');
              return `
                <div style="padding:10px 12px;background:var(--color-surface-2);border-radius:var(--radius-md);border-left:3px solid ${s.color || 'var(--color-border)'}">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                    <span style="font-size:13px;font-weight:700;color:${s.color}">${s.coin}</span>
                    ${isCon ? '<span style="font-size:8px;padding:2px 5px;background:var(--color-orange-dim);color:var(--color-orange);border-radius:9999px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Contrarian</span>' : ''}
                    ${s.strength === 'high' ? '<span style="font-size:8px;padding:2px 5px;background:var(--color-green-dim);color:var(--color-green);border-radius:9999px;font-weight:700;text-transform:uppercase">High</span>' : ''}
                    ${s.strength === 'warning' ? '<span style="font-size:8px;padding:2px 5px;background:var(--color-orange-dim);color:var(--color-orange);border-radius:9999px;font-weight:700;text-transform:uppercase">Warning</span>' : ''}
                    <span style="margin-left:auto;font-size:18px;color:${dirColor}">${dirIcon}</span>
                  </div>
                  <div style="font-size:12px;font-weight:600;margin-bottom:2px">${s.label}</div>
                  <div style="font-size:11px;color:var(--color-text-muted);line-height:1.4">${s.desc}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Prediction Cards Grid -->
      <div class="section-header"><span class="section-title">1-15 Minute UP / DOWN Calls</span>
        <button class="btn-sm" id="rerunPreds" style="font-size:10px;padding:4px 10px">Refresh Analysis</button>
      </div>
      <div class="pred-grid">
        ${predArr.map(p => predictionCard(p)).join('')}
      </div>
    `;

    // Populate accuracy badge immediately after render
    updateAccuracyBadge();

    // Rerun button
    const rerunBtn = document.getElementById('rerunPreds');
    if (rerunBtn) {
      rerunBtn.addEventListener('click', async () => {
        if (predictionRunInFlight) return;
        rerunBtn.textContent = 'Analyzing...';
        rerunBtn.disabled = true;
        // Show loading screen immediately so browser can paint before heavy work starts
        content.innerHTML = `<div class="loading-screen"><div class="loader-ring"></div><p>Scoring UP/DOWN markets — routing inner shells first, then loading deeper confirmations...</p></div>`;
        // Yield two frames so the loading state is actually visible before CPU work begins
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        predsLoaded = false;
        await renderPredictions();
      });
    }

    content.querySelectorAll('[data-pred-toggle]').forEach(card => {
      card.addEventListener('click', () => {
        toggleExpanded(predictionExpanded, card.dataset.predToggle);
        renderPredictions();
      });
    });

    // Quick Decision Panel: click chip → scroll to matching prediction card
    content.querySelectorAll('[data-scroll-pred]').forEach(chip => {
      chip.addEventListener('click', () => {
        const target = content.querySelector(`[data-testid="pred-${chip.dataset.scrollPred}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function predictionCard(p) {
    // ── Kalshi-primary verdict ────────────────────────────────────────────
    // Per Kalshi contract spec: YES price = market-implied probability that
    // price ≥ CF Benchmarks 60-sec average at expiry ("at least X" criterion).
    // Kalshi ≥55% → UP  |  ≤45% → DOWN  |  45-55% → model score breaks tie.
    const _k15mCV    = window.PredictionMarkets?.getCoin(p.sym);
    const _k15mV     = _k15mCV?.kalshi15m ?? null;
    const kalshiProb = _k15mV?.probability ?? _k15mCV?.combinedProb ?? null;
    const kalshiPct  = kalshiProb !== null ? Math.round(kalshiProb * 100) : null;
    const kalshiEdge = kalshiProb !== null ? Math.abs(kalshiProb - 0.5)  : null;

    let verdictDir, verdictSource;
    if (kalshiProb !== null) {
      if      (kalshiProb >= 0.55) { verdictDir = 'up';   verdictSource = 'kalshi'; }
      else if (kalshiProb <= 0.45) { verdictDir = 'down'; verdictSource = 'kalshi'; }
      else {
        // Kalshi near 50/50 — model score breaks the tie
        verdictDir    = p.score > 0.12 ? 'up' : p.score < -0.12 ? 'down' : 'wait';
        verdictSource = 'model';
      }
    } else {
      // No Kalshi data — fall back to model with tightened threshold
      verdictDir    = p.score > 0.18 ? 'up' : p.score < -0.18 ? 'down' : 'wait';
      verdictSource = 'model';
    }

    const verdictMain = verdictDir === 'up' ? '▲ UP' : verdictDir === 'down' ? '▼ DOWN' : '◆ WAIT';
    const strength    = verdictDir === 'wait' ? 'NEUTRAL'
      : kalshiEdge !== null
        ? (kalshiEdge >= 0.20 ? 'STRONG' : kalshiEdge >= 0.10 ? 'MODERATE' : 'LIGHT')
        : (Math.abs(p.score) >= 0.5 ? 'STRONG' : Math.abs(p.score) >= 0.25 ? 'MODERATE' : 'WEAK');
    const scoreStr  = Number.isFinite(p.score) ? (p.score > 0 ? '+' : '') + p.score.toFixed(2) : '—';

    // Session quality badge — London open (UTC 7–12) is consistently worst session (-7-10% WR)
    const _nowUTC = new Date().getUTCHours();
    const isLondonSession = _nowUTC >= 7 && _nowUTC < 12;
    const londonBadge = isLondonSession
      ? `<span class="pred-session-warn" title="London open 7–12 UTC historically underperforms by 7–10% win-rate">⚠ London hrs</span>`
      : '';

    // Model calibration notices for problem coins
    const _uncalibrated = { HYPE: 'Limited data — extreme thresholds active', DOGE: 'Meme-coin regime — higher threshold required' };
    const calibBadge = _uncalibrated[p.sym]
      ? `<span class="pred-calib-warn" title="${_uncalibrated[p.sym]}">⚠ ${p.sym === 'HYPE' ? 'HYPE: low calibration' : 'DOGE: noisy regime'}</span>`
      : '';

    // Weak signal notice — light bucket (absScore <0.25) in model-only verdict has poor backtest WR
    const _isLightModel = verdictSource === 'model' && Math.abs(p.score) < 0.25 && verdictDir !== 'wait';
    const weakBadge = _isLightModel
      ? `<span class="pred-weak-warn" title="Low-conviction signal — backtest accuracy below 50%">⚡ WEAK</span>`
      : '';
    const { primary: ratPrimary, secondary: ratSecondary } = getDecisionRationale(p);

    const arrow = p.score > 0.3 ? '\u2B06' : p.score < -0.3 ? '\u2B07' : p.score > 0 ? '\u2197' : p.score < 0 ? '\u2198' : '\u2194';
    const confClass = p.score > 0 ? 'bull' : p.score < 0 ? 'bear' : 'flat';
    const ind = p.indicators || {};
    const hasBacktest = !!p.backtest;
    const reliabilityPct = hasBacktest ? Math.round((p.backtest.summary?.reliability || 0) * 100) : 0;
    const tradeFitPct = hasBacktest ? Math.round(((p.backtest.summary?.tradeFit ?? p.backtest.summary?.reliability ?? 0) * 100)) : 0;
    const advanced = p.backtest?.advanced || null;
    const advancedQualityPct = advanced ? Math.round((advanced.summary?.reliability || 0) * 100) : 0;
    const advancedFitPct = advanced ? Math.round((advanced.summary?.tradeFit || advanced.summary?.reliability || 0) * 100) : 0;
    const agreementPct = Math.round((p.diagnostics?.agreement || 0.5) * 100);
    const conflictPct = Math.round((p.diagnostics?.conflict || 0) * 100);
    const qualityLabel = hasBacktest ? (p.diagnostics?.qualityLabel || 'Backtest mixed') : 'Backtest unavailable';
    const tradeFitLabel = hasBacktest ? (p.diagnostics?.tradeFitLabel || 'Timing mixed') : 'Timing unavailable';
    const preferredHorizon = p.diagnostics?.preferredHorizon || p.backtest?.summary?.preferredHorizon || 5;
    const fastTiming = p.diagnostics?.fastTiming || null;
    const driverSummary = p.diagnostics?.driverSummary || 'No dominant driver cluster';
    const topDrivers = Array.isArray(p.diagnostics?.topDrivers) ? p.diagnostics.topDrivers.slice(0, 3) : [];
    const vetoReason = p.diagnostics?.vetoReason || '';
    const inBufferZone = !!p.diagnostics?.inBufferZone;
    const routedAction = p.diagnostics?.routedAction || 'watch';
    const routedSummary = p.diagnostics?.routedSummary || driverSummary;
    const routedRiskFlags = Array.isArray(p.diagnostics?.routedRiskFlags) ? p.diagnostics.routedRiskFlags.slice(0, 3) : [];
    const mdt = p.mdt || null;
    const reversalFlags = Array.isArray(p.reversalFlags) ? p.reversalFlags : [];
    const mdtVerdict = mdt?.verdict || 'HOLD';
    const mdtBias = mdt?.bias || 'neutral';
    const mdtConf = mdt?.biasConf || 0;
    const mdtPreemptive = !!mdt?.preemptive;
    const mdtLayer = mdt?.layer || 6;
    const mdtRegimeLabel = mdt?.regimeLabel || 'Flat / Ranging';
    const mdtPath = Array.isArray(mdt?.path) ? mdt.path : [];
    const rfRow = reversalFlags.length ? `
      <div class="rf-row">
        ${reversalFlags.map(f => `
          <span class="rf-badge rf-${f.severity} rf-${f.bias}" title="${f.desc}">
            ${f.severity === 'critical' ? '🔴' : f.severity === 'alert' ? '🟠' : '🟡'}
            ${f.label}
          </span>
        `).join('')}
      </div>` : '';
    const expanded = predictionExpanded.has(p.sym);
    const horizonRows = PREDICTION_HORIZONS.map(horizonMin => ({
      horizonMin,
      label: `${horizonMin}m`,
      stats: p.backtest?.[`h${horizonMin}`] || null,
      projection: p.projections?.[`p${horizonMin}`] || null,
    }));

    function indClass(sig) { return sig > 0.15 ? 'bull' : sig < -0.15 ? 'bear' : 'flat'; }
    function btClass(stats) {
      if (!stats || !stats.activeSignals) return 'flat';
      if (stats.winRate >= 55 && stats.avgSignedReturn > 0) return 'bull';
      if (stats.winRate < 45 && stats.avgSignedReturn < 0) return 'bear';
      return 'flat';
    }
    function routeClass(action) {
      return action === 'trade' ? 'bull' : action === 'invalidated' ? 'bear' : 'flat';
    }

    // Scalp setups count for this coin
    const mySetups = (p.scalpSetups || []);
    const scalpCount = mySetups.filter(s => s.type.startsWith('scalp_')).length;
    const contrarianCount = mySetups.filter(s => s.type.startsWith('contrarian_')).length;

    // ---- Kalshi 15M live market row ----
    // YES resolves if closePrice ≥ targetPriceNum (meet or exceed the reference).
    // NO  resolves if closePrice  < targetPriceNum (falls below the reference).
    // Show both sides: Kalshi YES/NO prices + model P(≥ ref) / P(< ref).
    const _k15mCoin  = window.PredictionMarkets?.getCoin(p.sym);
    const _k15m      = _k15mCoin?.kalshi15m ?? null;
    const _kProb     = ind.mktSentiment?.kalshi ?? _k15m?.probability ?? null;
    const _kAlign    = p.projections?.p15?.kalshiAlign ?? null;
    const kalshi15mRow = (() => {
      if (_kProb === null) return '';

      // YES and NO are complementary — always sum to 100%
      const kYesPct = Math.round(_kProb * 100);
      const kNoPct  = 100 - kYesPct;
      const kDir    = _kProb >= 0.5 ? 'up' : 'down';
      const kCls    = kDir === 'up' ? 'bull' : 'bear';

      let probLine;
      if (_kAlign?.modelYesPct != null) {
        // Reference price is set — show full YES/NO breakdown for both sides
        const mYesPct = _kAlign.modelYesPct;
        const mNoPct  = 100 - mYesPct;
        const div     = _kAlign.divergence;
        const status  = _kAlign.status;

        const divBadge = status === 'divergent'
          ? `<span class="k15-divergent">⚡ ${div}pp</span>`
          : status === 'soft-split'
          ? `<span class="k15-soft-split">${div}pp</span>`
          : `<span class="k15-agree">✓</span>`;

        // K: YES 68% / NO 32%   M: YES 72% / NO 28%   ⚡badge
        // YES = price meets/exceeds ref = bullish = always green (k15-yes)
        // NO  = price stays below ref   = bearish = always red   (k15-no)
        probLine =
          `<span class="k15-side-label">K</span>` +
          `<span class="k15-yes">Y ${kYesPct}%</span>` +
          `<span class="k15-sep">/</span>` +
          `<span class="k15-no">N ${kNoPct}%</span>` +
          `  <span class="k15-side-label">M</span>` +
          `<span class="k15-yes">Y ${mYesPct}%</span>` +
          `<span class="k15-sep">/</span>` +
          `<span class="k15-no">N ${mNoPct}%</span>` +
          ` ${divBadge}`;
      } else {
        // Reference TBD — show direction + YES/NO split while waiting
        const agree    = verdictDir !== 'wait' && verdictDir === kDir;
        const disagree = verdictDir !== 'wait' && verdictDir !== kDir;
        const agBadge  = agree    ? `<span class="k15-agree">✓ AGREE</span>`
                       : disagree ? `<span class="k15-disagree">✗ SPLIT</span>` : '';
        probLine =
          `<span class="k15-yes">Y ${kYesPct}%</span>` +
          `<span class="k15-sep">/</span>` +
          `<span class="k15-no">N ${kNoPct}%</span>` +
          ` ${agBadge}`;
      }

      // Reference threshold — "meets or exceeds $85.32"
      const refLine = _kAlign?.ref != null
        ? ` <span class="k15-target">≥ ${fmtPrice(_kAlign.ref)}</span>`
        : (_k15m?.targetPrice ? ` <span class="k15-target">≥ ${_k15m.targetPrice}</span>` : '');

      // Gap from current price to reference — show dollar amount + % + BORDERLINE warning
      const _gapRaw   = _kAlign?.gapPct ?? null;
      const _gapDollar = (_kAlign?.ref != null && p.price > 0)
        ? (_kAlign.ref - p.price) : null;
      const _borderline = _gapRaw !== null && Math.abs(_gapRaw) < 0.12; // within 0.12% of strike
      const gapLine = _gapRaw !== null && Math.abs(_gapRaw) > 0.001
        ? ` <span class="k15-gap ${_gapRaw > 0 ? 'k15-gap-up' : 'k15-gap-down'} ${_borderline ? 'k15-borderline' : ''}">` +
          `${_gapRaw > 0 ? '▲' : '▼'} ${_gapDollar !== null ? '$' + Math.abs(_gapDollar).toFixed(4) + ' ' : ''}` +
          `(${_gapRaw > 0 ? '+' : ''}${_gapRaw.toFixed(3)}%)` +
          `${_borderline ? ' ⚠ BORDERLINE' : ''}</span>`
        : (_gapRaw !== null ? ` <span class="k15-gap k15-gap-down k15-borderline">✓ AT STRIKE</span>` : '');

      // Countdown to settlement
      let countdown = '';
      if (_k15m?.closeTime) {
        const msl = new Date(_k15m.closeTime).getTime() - Date.now();
        if (msl > 0) {
          const ts = Math.floor(msl / 1000);
          countdown = ` <span class="k15-expiry">⏱ ${Math.floor(ts / 60)}m${String(ts % 60).padStart(2, '0')}s</span>`;
        } else {
          countdown = ` <span class="k15-expiry k15-settling">⏱ SETTLING</span>`;
        }
      }

      return `<div class="ind-item k15m-row"><span class="ind-name">Kalshi 15M</span><span class="ind-val ${kCls}">${probLine}${refLine}${gapLine}${countdown}</span></div>`;
    })();

    return `
      <div class="pred-card ${p.signal} ${expanded ? 'expanded' : ''}" data-testid="pred-${p.sym}" data-pred-toggle="${p.sym}"
           style="border-left: 4px solid ${verdictDir === 'up' ? 'var(--color-green)' : verdictDir === 'down' ? 'var(--color-red)' : 'var(--color-border)'}">

        <!-- Header: always visible -->
        <div class="pred-header">
          <div class="pred-coin-icon" style="background:${p.color}22;color:${p.color}">${coinIcon(p.sym)}</div>
          <div class="pred-coin-info">
            <div class="pred-coin-sym">${p.sym}</div>
            <div class="pred-coin-name">${p.name}</div>
          </div>
          <div>
            <div class="pred-coin-price">${fmtPrice(p.price)}</div>
            <div class="pred-coin-src">${p.source || 'partial'} &middot; ${p.candleCount15m || p.candleCount || '?'} x 15m (pooled from exchanges: WS+CB+BIN etc.)${p.candleCount1m ? ` · ${p.candleCount1m} x 1m` : ''}</div>
          </div>
          <div class="pred-expand-icon">${expanded ? '−' : '+'}</div>
        </div>

        <!-- Verdict Banner: always visible — this is the primary signal -->
        <div class="pred-verdict ${verdictDir}">
          <div class="pred-verdict-call">
            <span class="pred-verdict-main">${verdictMain}</span>
            <span class="pred-verdict-strength">${strength}</span>
          </div>
          <div class="pred-verdict-meta">
            ${kalshiPct !== null
              ? `<span class="pred-source-badge ${verdictSource}">${verdictSource === 'kalshi' ? `KALSHI ${kalshiPct}% YES` : `KALSHI ~50/50`}</span>`
              : `<span class="pred-source-badge model">MODEL</span>`}
            <span>Score ${scoreStr}</span>
            <span>·</span>
            <span>${p.confidence}% conf</span>
            ${londonBadge}${calibBadge}${weakBadge}
          </div>
          ${ratPrimary ? `<div class="pred-verdict-rationale">${ratPrimary}</div>` : ''}
          <div class="pred-verdict-bar-wrap">
            <div class="pred-verdict-bar-fill ${verdictDir}" style="width:${p.confidence}%"></div>
          </div>
          ${kalshi15mRow}
          ${(() => {
            const ki = window.KalshiOrchestrator?.getIntent?.(p.sym);
            if (!ki || ki.action === 'skip') return '';
            const isExit  = ki.action === 'earlyExit';
            const isHold  = ki.action === 'hold';
            const isTrade = ki.action === 'trade';
            const isSplit = ki.alignment === 'SPLIT';
            const sideColor = ki.side === 'YES' ? 'var(--color-green)' : ki.side === 'NO' ? 'var(--color-red)' : 'var(--color-orange)';
            const sideBg    = ki.side === 'YES' ? 'rgba(0,200,100,0.18)' : ki.side === 'NO' ? 'rgba(220,60,60,0.18)' : 'transparent';
            const rowBg     = isExit ? 'rgba(255,80,80,0.07)' : isHold ? 'rgba(255,180,0,0.07)' : isTrade ? 'rgba(0,200,100,0.07)' : 'rgba(200,200,0,0.05)';
            const rowBdr    = isExit ? 'rgba(255,80,80,0.2)'  : isHold ? 'rgba(255,180,0,0.25)' : isTrade ? 'rgba(0,200,100,0.2)'  : 'rgba(200,200,0,0.15)';
            const actionLabel = isTrade ? '🟢 TRADE' : isExit ? '🔴 EXIT' : isHold ? '⏳ HOLD' : '👁 WATCH';
            const strikeLabel = (() => { const m = ki.contractTicker?.match(/T(\d+(?:\.\d+)?)$/); return m ? 'T' + Number(m[1]).toLocaleString() : ''; })();
            const minsStr     = ki.minutesLeft != null ? (ki.minutesLeft < 1 ? Math.round(ki.minutesLeft * 60) + 's' : ki.minutesLeft.toFixed(1) + 'm') : null;
            const alignTag    = { AGREE:'✓ Both agree', SPLIT:'⚡ Split', MODEL_LEADS:'Model leads', KALSHI_ONLY:'Kalshi only', MODEL_ONLY:'Model only', EARLY_EXIT:'Early exit' }[ki.alignment] ?? (ki.alignment ?? '');
            return `
            <div style="margin-top:6px;padding:8px 10px;border-radius:5px;background:${rowBg};border:1px solid ${rowBdr};font-family:var(--font-mono)">
              ${isExit
                ? `<div style="display:flex;align-items:center;gap:8px">
                     <span style="background:rgba(255,80,80,0.22);color:var(--color-red);padding:4px 14px;border-radius:4px;font-size:13px;font-weight:800;letter-spacing:.6px">STAND ASIDE</span>
                     <span style="font-size:11px;color:var(--color-text-muted)">CFM early-exit — do not enter</span>
                   </div>`
                : isHold
                ? `<div style="display:flex;align-items:center;gap:8px">
                     <span style="background:rgba(255,180,0,0.22);color:var(--color-gold,#f90);padding:4px 14px;border-radius:4px;font-size:13px;font-weight:800;letter-spacing:.6px">⏳ EVALUATING WALL</span>
                     <span style="font-size:11px;color:var(--color-text-muted)">Collecting sell-pressure data…</span>
                   </div>`
                : `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                     <span style="background:${sideBg};color:${sideColor};padding:4px 14px;border-radius:4px;font-size:15px;font-weight:800;letter-spacing:.8px">${ki.side}</span>
                     <span style="font-size:12px;font-weight:700;color:var(--color-text)">KALSHI${strikeLabel ? ' · ' + strikeLabel : ''}</span>
                     <span style="margin-left:auto;background:${isTrade ? 'rgba(0,200,100,0.15)' : 'rgba(200,200,0,0.12)'};color:${isTrade ? 'var(--color-green)' : 'var(--color-orange)'};padding:3px 10px;border-radius:3px;font-size:12px;font-weight:700">${actionLabel}</span>
                   </div>`}
              <div style="display:flex;gap:12px;font-size:11px;color:var(--color-text-faint);margin-top:5px;flex-wrap:wrap;align-items:center">
                ${ki.targetPrice     ? `<span>Strike <strong style="color:var(--color-text)">${ki.targetPrice}</strong></span>` : ''}
                ${minsStr            ? `<span>⏱ <strong>${minsStr}</strong> left</span>` : ''}
                ${ki.suggestedEntry != null ? `<span>Entry ~<strong>$${ki.suggestedEntry.toFixed(2)}</strong></span>` : ''}
                <span style="color:${isTrade ? 'var(--color-green)' : isSplit ? 'var(--color-orange)' : 'var(--color-text-muted)'}">${alignTag} · <strong>${ki.confidence}%</strong></span>
              </div>
              ${ki.humanReason ? `<div style="font-size:11px;color:var(--color-text-muted);margin-top:5px;line-height:1.4;font-family:var(--font-sans)">${ki.humanReason}</div>` : ''}
              ${ki.illiquid ? `<div style="font-size:11px;color:var(--color-orange);margin-top:4px">⚠ Low liquidity ($${ki.liquidity?.toFixed(0)}) — size carefully</div>` : ''}
              ${isSplit     ? `<div style="font-size:11px;color:var(--color-orange);margin-top:4px">⚠ Kalshi vs model disagree — watch only, do not trade</div>` : ''}
            </div>`;
          })()}
        </div>

        ${rfRow}
        <!-- Expanded detail: hidden until card is clicked -->
        <div class="pred-expand-panel ${expanded ? 'open' : ''}">

          <div class="ind-grid" style="margin-bottom:12px">
            <div class="ind-item"><span class="ind-name">Model Quality</span><span class="ind-val ${reliabilityPct >= 60 ? 'bull' : reliabilityPct < 45 ? 'bear' : 'flat'}">${hasBacktest ? `${qualityLabel} (${reliabilityPct}%)` : qualityLabel}</span></div>
            <div class="ind-item"><span class="ind-name">Trade Fit</span><span class="ind-val ${tradeFitPct >= 62 ? 'bull' : tradeFitPct < 45 ? 'bear' : 'flat'}">${hasBacktest ? `${tradeFitLabel} (${tradeFitPct}%)` : tradeFitLabel}</span></div>
            <div class="ind-item"><span class="ind-name">Signal Alignment</span><span class="ind-val ${agreementPct >= 70 ? 'bull' : conflictPct >= 35 ? 'bear' : 'flat'}">${agreementPct}% aligned / ${conflictPct}% conflict</span></div>
            ${horizonRows.map(horizon => `<div class="ind-item"><span class="ind-name">UP/DOWN ${horizon.label}</span><span class="ind-val ${btClass(horizon.stats)}">${horizon.stats && horizon.stats.activeSignals ? `${horizon.stats.winRate.toFixed(0)}% win · ${fmtPct(Math.min(Math.max(horizon.stats.equity?.returnPct || 0, -9999), 9999))}` : 'Not enough signals'}</span></div>`).join('')}
            <div class="ind-item"><span class="ind-name">Decision Gate</span><span class="ind-val ${vetoReason ? 'bear' : inBufferZone ? 'flat' : 'bull'}">${vetoReason || (inBufferZone ? 'Buffer zone' : 'Clear to trade')}</span></div>
            <div class="ind-item ind-mdt">
              <span class="ind-name">Bias Gate</span>
              <span class="ind-val ${mdtBias === 'bullish' ? 'bull' : mdtBias === 'bearish' ? 'bear' : 'flat'}">
                ${mdtRegimeLabel}
                ${mdtPreemptive ? '<span class="mdt-pre-tag">PRE</span>' : ''}
                · ${mdtConf}% conf
                ${mdtVerdict !== 'HOLD' ? `· <strong>${mdtVerdict}</strong>` : ''}
              </span>
            </div>
            <div class="ind-item"><span class="ind-name">Router</span><span class="ind-val ${routeClass(routedAction)}">${routedAction}</span></div>
            <div class="ind-item"><span class="ind-name">Long-range Context</span><span class="ind-val ${advancedQualityPct >= 58 ? 'bull' : advancedQualityPct < 42 ? 'bear' : 'flat'}">${advanced ? `${advancedQualityPct}% quality · ${advancedFitPct}% fit` : 'Loading full history'}</span></div>
          </div>

          <div class="ind-grid" style="margin-bottom:12px">
            <div class="ind-item"><span class="ind-name">RSI(14)</span><span class="ind-val ${indClass(ind.rsi?.signal || 0)}">${ind.rsi?.value?.toFixed(1) ?? '—'} ${ind.rsi?.label ?? ''}</span></div>
            <div class="ind-item"><span class="ind-name">EMA 9/21</span><span class="ind-val ${indClass(ind.ema?.signal || 0)}">${ind.ema?.label ?? '—'}</span></div>
            <div class="ind-item"><span class="ind-name">VWAP</span><span class="ind-val ${indClass(ind.vwap?.signal || 0)}">${Number.isFinite(ind.vwap?.value) ? `${ind.vwap.value > 0 ? '+' : ''}${ind.vwap.value.toFixed(2)}%` : '—'} ${ind.vwap?.label ?? ''}</span></div>
            <div class="ind-item"><span class="ind-name">OBV</span><span class="ind-val ${indClass(ind.obv?.signal || 0)}">${ind.obv?.label ?? '—'}</span></div>
            <div class="ind-item"><span class="ind-name">Vol Flow</span><span class="ind-val ${indClass(ind.volume?.signal || 0)}">${ind.volume?.label ?? '—'}</span></div>
            <div class="ind-item"><span class="ind-name">Momentum</span><span class="ind-val ${indClass(ind.momentum?.signal || 0)}">${Number.isFinite(ind.momentum?.value) ? `${ind.momentum.value > 0 ? '+' : ''}${ind.momentum.value.toFixed(2)}%` : '—'}</span></div>
            ${ind.bands ? `<div class="ind-item"><span class="ind-name">Bands</span><span class="ind-val ${indClass(ind.bands.signal)}">${ind.bands.label}</span></div>` : ''}
            ${ind.persistence ? `<div class="ind-item"><span class="ind-name">Persistence</span><span class="ind-val ${indClass(ind.persistence.signal)}">${ind.persistence.label}</span></div>` : ''}
            ${ind.structure ? `<div class="ind-item"><span class="ind-name">Structure</span><span class="ind-val ${indClass(ind.structure.signal)}">${ind.structure.label}</span></div>` : ''}
            ${ind.book ? `<div class="ind-item"><span class="ind-name">Book</span><span class="ind-val ${ind.book.imbalance > 0.2 ? 'bull' : ind.book.imbalance < -0.2 ? 'bear' : 'flat'}">${ind.book.label.split('\u2014')[0]}</span></div>` : ''}
            ${ind.flow ? `<div class="ind-item"><span class="ind-name">Tape</span><span class="ind-val ${ind.flow.aggressor === 'buyers' ? 'bull' : ind.flow.aggressor === 'sellers' ? 'bear' : 'flat'}">${ind.flow.label.split('(')[0]}</span></div>` : ''}
            ${fastTiming ? `<div class="ind-item"><span class="ind-name">Pooled 1m</span><span class="ind-val ${fastTiming.score > 0.12 ? 'bull' : fastTiming.score < -0.12 ? 'bear' : 'flat'}">${fastTiming.label}</span></div>` : ''}
          </div>

          <div class="proj-section">
            <div class="proj-title">Why it fired</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">
              ${topDrivers.map(driver => `<span style="font-size:9px;padding:3px 6px;background:var(--color-surface-2);border-radius:9999px;color:${driver.direction === 'up' ? 'var(--color-green)' : 'var(--color-red)'}">${driver.label}: ${driver.detail}</span>`).join('')}
              ${fastTiming ? `<span style="font-size:9px;padding:3px 6px;background:var(--color-surface-2);border-radius:9999px;color:${fastTiming.score > 0 ? 'var(--color-green)' : fastTiming.score < 0 ? 'var(--color-red)' : 'var(--color-text-muted)'}">1m pulse: ${fastTiming.label}</span>` : ''}
              ${routedRiskFlags.map(flag => `<span style="font-size:9px;padding:3px 6px;background:var(--color-red-dim);border-radius:9999px;color:var(--color-red)">${flag}</span>`).join('')}
              ${mdtPath.slice(0,5).map(step => `
                <span style="font-size:9px;padding:3px 6px;background:var(--color-surface-2);border-radius:9999px;color:${step.pass === false ? 'var(--color-text-faint)' : mdtBias==='bullish'?'var(--color-green)':mdtBias==='bearish'?'var(--color-red)':'var(--color-text-muted)'}">
                  MDT/${step.node}${step.result ? ': ' + step.result : ''}
                </span>`).join('')}
            </div>
            <div style="font-size:11px;color:var(--color-text-muted);line-height:1.45">${routedSummary}</div>
          </div>

          <div class="proj-section">
            <div class="proj-title">Resolution Range</div>
            ${horizonRows.filter(horizon => horizon.projection).map(horizon => `
              <div class="proj-row">
                <span class="proj-label">${horizon.label}</span>
                <span style="color:var(--color-red);font-size:10px">${fmtPrice(horizon.projection.low)}</span>
                <div class="proj-range">
                  <div class="proj-target ${confClass}" style="left:50%"></div>
                </div>
                <span style="color:var(--color-green);font-size:10px">${fmtPrice(horizon.projection.high)}</span>
                <span class="proj-val" style="color:${p.score >= 0 ? 'var(--color-green)' : 'var(--color-red)'}">${fmtPrice(horizon.projection.target)}</span>
              </div>
            `).join('')}
          </div>

          <div class="pred-detail-grid" style="margin-top:10px">
            <div class="cfm-detail-card"><span class="cfm-detail-label">Consensus</span><strong>${p.diagnostics?.consensusLabel || 'Balanced'}</strong><small>${agreementPct}% aligned</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Raw Score</span><strong>${(p.rawScore ?? p.score).toFixed(3)}</strong><small>pre-calibration</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Trade Horizon</span><strong>${preferredHorizon}m bias</strong><small>${tradeFitLabel}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Decision Buffer</span><strong>${inBufferZone ? 'Inside buffer' : 'Outside buffer'}</strong><small>${vetoReason || `score ±${((p.diagnostics?.scoreBuffer || 0) * 100).toFixed(0)}bp gate`}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Router Verdict</span><strong>${routedAction}</strong><small>${routedRiskFlags.length ? routedRiskFlags.join(', ') : 'clean packet flow'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Funding</span><strong>${p.derivatives ? fmtPct(p.derivatives.funding) : '—'}</strong><small>${p.derivatives?.exchange || 'no perp feed'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">CVD Slope</span><strong>${p.cvd?.slope ? fmtPct(p.cvd.slope) : '—'}</strong><small>${p.cvd?.slope > 0 ? 'buyers leading' : p.cvd?.slope < 0 ? 'sellers leading' : 'flat flow'}</small></div>
            ${horizonRows.map(horizon => `<div class="cfm-detail-card"><span class="cfm-detail-label">${horizon.label} Filter</span><strong>${horizon.stats?.entryThreshold ? horizon.stats.entryThreshold.toFixed(2) : '—'} / ${horizon.stats?.minAgreement ? Math.round(horizon.stats.minAgreement * 100) + '%' : '—'}</strong><small>score / agreement gate</small></div>`).join('')}
            <div class="cfm-detail-card"><span class="cfm-detail-label">Advanced Span</span><strong>${advanced ? `${advanced.startDate} → ${advanced.endDate}` : '—'}</strong><small>${advanced ? `${advanced.candleCount} daily candles` : 'full-history loading'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Advanced 1d / 7d</span><strong>${advanced?.d1?.activeSignals ? `${advanced.d1.winRate.toFixed(0)}%` : '—'} / ${advanced?.d7?.activeSignals ? `${advanced.d7.winRate.toFixed(0)}%` : '—'}</strong><small>${advanced ? `${advancedQualityPct}% quality · ${advancedFitPct}% fit` : 'no data yet'}</small></div>
            ${horizonRows.map(horizon => `<div class="cfm-detail-card"><span class="cfm-detail-label">${horizon.label} Strong Bucket</span><strong>${horizon.stats?.buckets?.strong?.trades ?? 0}</strong><small>${horizon.stats?.buckets?.strong ? horizon.stats.buckets.strong.winRate.toFixed(0) + '% win · DD ' + (horizon.stats.equity?.maxDrawdownPct || 0).toFixed(1) + '%' : 'no data'}</small></div>`).join('')}
          </div>

          ${(p.scalpSetups || []).length ? `
            <div class="pred-setup-list">
              ${(p.scalpSetups || []).slice(0, 4).map(s => `
                <div class="pred-setup-item"><strong>${s.label}</strong><span>${s.desc}</span></div>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <!-- Footer: always visible -->
        <div class="pred-footer">
          <div>
            <span class="vol-badge ${p.volatility.label.toLowerCase()}">Vol: ${p.volatility.label} (${p.volatility.atrPct.toFixed(2)}%)</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${scalpCount > 0 ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-green-dim);color:var(--color-green);border-radius:9999px;font-weight:700">${scalpCount} scalp</span>` : ''}
            ${contrarianCount > 0 ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-orange-dim);color:var(--color-orange);border-radius:9999px;font-weight:700">${contrarianCount} contrarian</span>` : ''}
            ${fastTiming ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:${fastTiming.score > 0 ? 'var(--color-green)' : fastTiming.score < 0 ? 'var(--color-red)' : 'var(--color-text-muted)'};border-radius:9999px;font-weight:700">1m ${fastTiming.label}</span>` : ''}
            ${p.backtest ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:var(--color-text-muted);border-radius:9999px;font-weight:700">${reliabilityPct}% quality</span>` : ''}
            ${p.backtest ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:var(--color-text-muted);border-radius:9999px;font-weight:700">${tradeFitPct}% fit</span>` : ''}
            ${vetoReason ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-red-dim);color:var(--color-red);border-radius:9999px;font-weight:700">${vetoReason}</span>` : inBufferZone ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:var(--color-orange);border-radius:9999px;font-weight:700">Buffer zone</span>` : ''}
          </div>
          <span>${p.updatedAt}</span>
        </div>
      </div>
    `;
  }

  // ================================================================
  // ORDER BOOK DEPTH — View, Live Updates, Liquidity Map, HUD
  // ================================================================

  function renderDepth() {
    const syms = PREDICTION_COINS.map(c => c.sym);
    let selSym = window._depthSelectedSym || syms[0];
    if (!syms.includes(selSym)) selSym = syms[0];
    window._depthSelectedSym = selSym;
    const coin = PREDICTION_COINS.find(c => c.sym === selSym);
    const book = window.OB?.books?.[selSym] || { bids: [], asks: [], mid: 0, spread: 0, spreadPct: 0 };
    const fmtQty = (q) => window.OB?.formatQty?.(selSym, q) ?? q.toFixed(2);

    const coinTabs = syms.map(s => {
      const c = PREDICTION_COINS.find(x => x.sym === s);
      const active = s === selSym ? 'active' : '';
      const connected = window.OB?.getConnected?.()?.includes(s);
      return `<button class="depth-coin-tab ${active}" data-depth-sym="${s}">
        <span class="dtab-dot" style="background:${c.color}"></span>
        ${s}
        <span class="dtab-ws ${connected ? 'on' : 'off'}"></span>
      </button>`;
    }).join('');

    // Build order book ladder
    const MAX_LEVELS = 15;
    const allQtys = [...book.bids.slice(0,MAX_LEVELS), ...book.asks.slice(0,MAX_LEVELS)].map(([,q])=>q);
    const maxQty = allQtys.length > 0 ? Math.max(...allQtys) : 1;
    const minQty = window.OB?.WALL_MIN_QTY?.[selSym] || 0;
    const avgQty = allQtys.length > 0 ? allQtys.reduce((a,b)=>a+b,0)/allQtys.length : 1;
    const wallThresh = Math.max(minQty, avgQty * (window.OB?.WALL_MULTI || 3.5));

    const fmtPrice = (p) => {
      if (p >= 1000) return p.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
      if (p >= 1)    return p.toFixed(4);
      return p.toFixed(6);
    };

    const askRows = book.asks.slice(0, MAX_LEVELS).reverse().map(([price, qty]) => {
      const pct = (qty / maxQty) * 100;
      const isWall = qty >= wallThresh;
      return `<div class="ob-row ask ${isWall ? 'ob-wall' : ''}">
        <span class="ob-price">${fmtPrice(price)}</span>
        <div class="ob-bar-wrap"><div class="ob-bar ask" style="width:${pct.toFixed(1)}%"></div></div>
        <span class="ob-qty">${fmtQty(qty)}</span>
        ${isWall ? '<span class="ob-wall-badge">WALL</span>' : ''}
      </div>`;
    }).join('');

    const spreadRow = `<div class="ob-spread-row">
      <span>Spread: ${book.spread ? fmtPrice(book.spread) : '—'}</span>
      <span>${book.spreadPct ? book.spreadPct.toFixed(4) + '%' : ''}</span>
      <span class="ob-mid">${book.mid ? '$' + fmtPrice(book.mid) : '—'}</span>
    </div>`;

    const bidRows = book.bids.slice(0, MAX_LEVELS).map(([price, qty]) => {
      const pct = (qty / maxQty) * 100;
      const isWall = qty >= wallThresh;
      return `<div class="ob-row bid ${isWall ? 'ob-wall' : ''}">
        <span class="ob-price">${fmtPrice(price)}</span>
        <div class="ob-bar-wrap"><div class="ob-bar bid" style="width:${pct.toFixed(1)}%"></div></div>
        <span class="ob-qty">${fmtQty(qty)}</span>
        ${isWall ? '<span class="ob-wall-badge">WALL</span>' : ''}
      </div>`;
    }).join('');

    // Recent alerts for this coin (last 20)
    const coinAlerts = (window.OB?.wallAlerts || []).filter(a => a.sym === selSym).slice(0, 20);
    const alertRows = coinAlerts.length === 0
      ? `<div class="ob-alert-empty">No wall events yet — monitoring live</div>`
      : coinAlerts.map(a => {
          const ago = Math.round((Date.now() - a.ts) / 1000);
          const agoStr = ago < 60 ? `${ago}s` : `${Math.round(ago/60)}m`;
          return `<div class="ob-alert-row ${a.bias.toLowerCase()}">
            <span class="ob-alert-dot ${a.bias.toLowerCase()}"></span>
            <span class="ob-alert-text">${a.side}-WALL <strong>${a.type}</strong> @ $${fmtPrice(a.price)}</span>
            <span class="ob-alert-qty">qty: ${fmtQty(a.qty)}</span>
            <span class="ob-alert-age">${agoStr}</span>
          </div>`;
        }).join('');

    const el = document.getElementById('content');
    el.innerHTML = `
      <div class="depth-wrap">
        <div class="depth-coin-tabs">${coinTabs}</div>
        <div class="depth-main">
          <div class="depth-book-panel">
            <div class="depth-panel-title">
              <span style="color:${coin.color}">●</span> ${coin.name} Live Order Book
              <span class="ob-live-badge">LIVE</span>
            </div>
            <div class="ob-ladder">
              <div class="ob-section-label ask">ASK / RESISTANCE</div>
              ${askRows || '<div class="ob-empty">Connecting…</div>'}
              ${spreadRow}
              <div class="ob-section-label bid">BID / SUPPORT</div>
              ${bidRows || '<div class="ob-empty">Connecting…</div>'}
            </div>
          </div>
          <div class="depth-map-panel">
            <div class="depth-panel-title">Liquidity Map <span style="font-size:11px;color:var(--color-text-muted)">(15m rolling)</span></div>
            <canvas id="liq-map-canvas" class="liq-map-canvas"></canvas>
            <div class="liq-map-legend">
              <span class="liq-legend-bid">■ Bids</span>
              <span class="liq-legend-ask">■ Asks</span>
              <span class="liq-legend-wall">◆ Wall event</span>
            </div>
          </div>
        </div>
        <div class="depth-alerts-panel">
          <div class="depth-panel-title">Wall Events — ${coin.name}</div>
          <div class="ob-alerts-list">${alertRows}</div>
        </div>
        <div class="depth-raw-panel">
          <div class="depth-panel-title">Raw Wall Data — Standing Walls (live)</div>
          <div id="depth-raw-walls" class="depth-raw-walls">Loading…</div>
        </div>
      </div>`;

    // Attach coin tab handlers
    el.querySelectorAll('[data-depth-sym]').forEach(btn => {
      btn.addEventListener('click', () => {
        window._depthSelectedSym = btn.dataset.depthSym;
        renderDepth();
      });
    });

    // Start live order book updates
    startDepthLive(selSym);

    // Draw liquidity map and initial raw wall data
    requestAnimationFrame(() => drawLiqMap(selSym));
    setTimeout(() => updateDepthRawWalls(selSym), 500);
  }

  let _depthLiveCleanup = null;
  let _depthBookSym = null, _depthBookFn = null;
  function startDepthLive(sym) {
    if (_depthLiveCleanup) { _depthLiveCleanup(); _depthLiveCleanup = null; }
    if (!window.OB) return;

    // Remove any previously registered listener to prevent accumulation
    if (_depthBookSym && _depthBookFn) window.OB.offBook?.(_depthBookSym, _depthBookFn);

    const handler = () => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      // Re-render book ladder only (not full re-render, for perf)
      updateDepthBook(sym);
    };

    _depthBookSym = sym;
    _depthBookFn  = handler;
    window.OB.onBook(sym, handler);

    // Also redraw liquidity map every 2s
    const mapTimer = setInterval(() => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      requestAnimationFrame(() => drawLiqMap(sym));
    }, 2000);

    // Also update alert list every 5s
    const alertTimer = setInterval(() => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      updateDepthAlerts(sym);
    }, 5000);

    // Also refresh raw wall data every 3s
    const rawWallTimer = setInterval(() => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      updateDepthRawWalls(sym);
    }, 3000);

    _depthLiveCleanup = () => {
      clearInterval(mapTimer);
      clearInterval(alertTimer);
      clearInterval(rawWallTimer);
      window.OB.offBook?.(_depthBookSym, _depthBookFn);
      _depthBookSym = null; _depthBookFn = null;
    };
  }

  function updateDepthBook(sym) {
    const book = window.OB?.books?.[sym];
    if (!book) return;
    const ladder = document.querySelector('.ob-ladder');
    if (!ladder) return;
    // Full re-render of the book section only — simpler than diffing
    const MAX_LEVELS = 15;
    const allQtys = [...book.bids.slice(0,MAX_LEVELS), ...book.asks.slice(0,MAX_LEVELS)].map(([,q])=>q);
    const maxQty = allQtys.length > 0 ? Math.max(...allQtys) : 1;
    const avgQty = allQtys.length > 0 ? allQtys.reduce((a,b)=>a+b,0)/allQtys.length : 1;
    const minQty = window.OB?.WALL_MIN_QTY?.[sym] || 0;
    const wallThresh = Math.max(minQty, avgQty * (window.OB?.WALL_MULTI || 3.5));

    const fmtPrice = (p) => {
      if (p >= 1000) return p.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
      if (p >= 1)    return p.toFixed(4);
      return p.toFixed(6);
    };
    const fmtQty = (q) => window.OB?.formatQty?.(sym, q) ?? q.toFixed(2);

    const makeRow = (price, qty, side) => {
      const pct = (qty / maxQty) * 100;
      const isWall = qty >= wallThresh;
      return `<div class="ob-row ${side} ${isWall ? 'ob-wall' : ''}">
        <span class="ob-price">${fmtPrice(price)}</span>
        <div class="ob-bar-wrap"><div class="ob-bar ${side}" style="width:${pct.toFixed(1)}%"></div></div>
        <span class="ob-qty">${fmtQty(qty)}</span>
        ${isWall ? '<span class="ob-wall-badge">WALL</span>' : ''}
      </div>`;
    };

    const askHTML = book.asks.slice(0,MAX_LEVELS).reverse().map(([p,q])=>makeRow(p,q,'ask')).join('');
    const bidHTML = book.bids.slice(0,MAX_LEVELS).map(([p,q])=>makeRow(p,q,'bid')).join('');
    const spreadHTML = `<div class="ob-spread-row">
      <span>Spread: ${fmtPrice(book.spread||0)}</span>
      <span>${book.spreadPct?.toFixed(4)||''}%</span>
      <span class="ob-mid">$${fmtPrice(book.mid||0)}</span>
    </div>`;

    ladder.innerHTML = `
      <div class="ob-section-label ask">ASK / RESISTANCE</div>
      ${askHTML||'<div class="ob-empty">Connecting…</div>'}
      ${spreadHTML}
      <div class="ob-section-label bid">BID / SUPPORT</div>
      ${bidHTML||'<div class="ob-empty">Connecting…</div>'}`;
  }

  function updateDepthAlerts(sym) {
    const container = document.querySelector('.ob-alerts-list');
    if (!container) return;
    const alerts = (window.OB?.wallAlerts || []).filter(a => a.sym === sym).slice(0, 20);
    if (alerts.length === 0) { container.innerHTML = '<div class="ob-alert-empty">No wall events yet</div>'; return; }
    const fmtP = (p) => p >= 1000 ? p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : p >= 1 ? p.toFixed(4) : p.toFixed(6);
    container.innerHTML = alerts.map(a => {
      const ago = Math.round((Date.now()-a.ts)/1000);
      return `<div class="ob-alert-row ${a.bias.toLowerCase()}">
        <span class="ob-alert-dot ${a.bias.toLowerCase()}"></span>
        <span class="ob-alert-text">${a.side}-WALL <strong>${a.type}</strong> @ $${fmtP(a.price)}</span>
        <span class="ob-alert-qty">qty: ${window.OB?.formatQty?.(sym, a.qty) ?? a.qty.toFixed(2)}</span>
        <span class="ob-alert-age">${ago<60?ago+'s':Math.round(ago/60)+'m'}</span>
      </div>`;
    }).join('');
  }

  function updateDepthRawWalls(sym) {
    const container = document.getElementById('depth-raw-walls');
    if (!container) return;
    const tracker = window.OB?.wallTracker?.[sym];
    if (!tracker) { container.innerHTML = '<span style="color:var(--color-text-faint);font-size:0.8em;">Waiting for data…</span>'; return; }
    const fmtP = (p) => p >= 1000 ? p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : p >= 1 ? p.toFixed(4) : p.toFixed(6);
    const fmtQ = (q) => window.OB?.formatQty?.(sym, q) ?? q.toFixed(2);
    const now = Date.now();

    const bidWalls = [...(tracker.bids || new Map()).entries()]
      .map(([price, d]) => ({ price: +price, qty: d.qty, age: Math.round((now - d.firstTs) / 1000) }))
      .sort((a, b) => b.qty - a.qty).slice(0, 7);
    const askWalls = [...(tracker.asks || new Map()).entries()]
      .map(([price, d]) => ({ price: +price, qty: d.qty, age: Math.round((now - d.firstTs) / 1000) }))
      .sort((a, b) => b.qty - a.qty).slice(0, 7);

    const makeRows = (walls, side) => walls.length === 0
      ? `<div style="color:var(--color-text-faint);font-size:0.78em;padding:4px 0;">None detected</div>`
      : walls.map(w => `
          <div style="display:grid;grid-template-columns:100px 1fr 56px;gap:6px;align-items:center;padding:3px 0;font-size:0.78em;font-family:var(--font-mono);">
            <span style="color:${side === 'bid' ? 'var(--color-green)' : 'var(--color-red)'};font-weight:600;">$${fmtP(w.price)}</span>
            <span style="color:var(--color-text-muted);">${fmtQ(w.qty)}</span>
            <span style="color:var(--color-text-faint);">${w.age < 60 ? w.age + 's' : Math.round(w.age/60) + 'm'}</span>
          </div>`).join('');

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:8px 14px;">
        <div>
          <div style="font-size:0.68em;color:var(--color-green);text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:6px;">BID WALLS — Support</div>
          ${makeRows(bidWalls, 'bid')}
        </div>
        <div>
          <div style="font-size:0.68em;color:var(--color-red);text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:6px;">ASK WALLS — Resistance</div>
          ${makeRows(askWalls, 'ask')}
        </div>
      </div>`;
  }

  let _drawLiqRetryPending = false;
  function drawLiqMap(sym) {
    const canvas = document.getElementById('liq-map-canvas');
    if (!canvas) { _drawLiqRetryPending = false; return; }

    // Use getBoundingClientRect for reliable CSS dimensions in flex containers
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(rect.width  || canvas.offsetWidth  || canvas.parentElement?.clientWidth  || 400, 200);
    const H = Math.max(rect.height || canvas.offsetHeight || 280, 200);

    // If canvas has no layout dimensions yet, defer — only one retry chain at a time
    if (rect.width === 0 || rect.height === 0) {
      if (!_drawLiqRetryPending) {
        _drawLiqRetryPending = true;
        setTimeout(() => { _drawLiqRetryPending = false; if (document.getElementById('liq-map-canvas')) drawLiqMap(sym); }, 150);
      }
      return;
    }
    _drawLiqRetryPending = false;

    canvas.width  = W;
    canvas.height = H;

    const snaps = window.OB?.liquiditySnaps?.[sym];
    if (!snaps || snaps.length < 2) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Collecting data…', W / 2, H / 2);
      return;
    }

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#070d1a';
    ctx.fillRect(0, 0, W, H);

    const PRICE_AXIS_W = 56;
    const TIME_AXIS_H  = 18;
    const mapW = W - PRICE_AXIS_W;
    const mapH = H - TIME_AXIS_H;

    const displaySnaps = snaps.slice(-Math.min(snaps.length, Math.floor(mapW)));
    const nCols = displaySnaps.length;
    if (nCols < 2) return;

    const currentMid = displaySnaps[displaySnaps.length - 1].mid || 1;
    const PRICE_RANGE = 0.015; // ±1.5%
    const N_BUCKETS   = 80;
    const priceLo = currentMid * (1 - PRICE_RANGE);
    const priceHi = currentMid * (1 + PRICE_RANGE);
    const bucketSize = (priceHi - priceLo) / N_BUCKETS;

    // Build intensity grid [col][bucket]
    const grid = new Float32Array(nCols * N_BUCKETS);
    const isBid = new Uint8Array(nCols * N_BUCKETS); // 1=bid, 0=ask, 2=both

    for (let col = 0; col < nCols; col++) {
      const snap = displaySnaps[col];
      for (const [price, qty] of snap.bids) {
        const bucket = Math.floor((price - priceLo) / bucketSize);
        if (bucket >= 0 && bucket < N_BUCKETS) {
          grid[col * N_BUCKETS + bucket] += qty;
          isBid[col * N_BUCKETS + bucket] = 1;
        }
      }
      for (const [price, qty] of snap.asks) {
        const bucket = Math.floor((price - priceLo) / bucketSize);
        if (bucket >= 0 && bucket < N_BUCKETS) {
          grid[col * N_BUCKETS + bucket] += qty;
          isBid[col * N_BUCKETS + bucket] = isBid[col * N_BUCKETS + bucket] === 1 ? 2 : 0;
        }
      }
    }

    // 95th percentile max for color scale
    const nonZero = [];
    for (let i = 0; i < grid.length; i++) { if (grid[i] > 0) nonZero.push(grid[i]); }
    nonZero.sort((a,b) => a-b);
    const p95 = nonZero[Math.floor(nonZero.length * 0.95)] || 1;

    // Draw columns
    const colW = mapW / nCols;
    const rowH = mapH / N_BUCKETS;

    for (let col = 0; col < nCols; col++) {
      for (let b = 0; b < N_BUCKETS; b++) {
        const val = grid[col * N_BUCKETS + b];
        if (val === 0) continue;
        const intensity = Math.min(val / p95, 1);
        const side = isBid[col * N_BUCKETS + b];
        let r, g, bl;
        if (side === 1) { // bid = blue/cyan
          r = Math.round(0 * intensity); g = Math.round(150 * intensity); bl = Math.round(255 * intensity);
        } else if (side === 0) { // ask = red/orange
          r = Math.round(255 * intensity); g = Math.round(60 * intensity); bl = 0;
        } else { // both = purple
          r = Math.round(140 * intensity); g = 0; bl = Math.round(200 * intensity);
        }
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        // Y: bucket 0 = priceLo (bottom), flip so higher price = higher on canvas
        const y = mapH - (b + 1) * rowH;
        ctx.fillRect(PRICE_AXIS_W + col * colW, y, Math.max(colW, 1), rowH + 0.5);
      }
    }

    // Mid price line
    const midBucket = (currentMid - priceLo) / bucketSize;
    const midY = mapH - midBucket * rowH;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    ctx.beginPath();
    ctx.moveTo(PRICE_AXIS_W, midY);
    ctx.lineTo(W, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Wall event markers
    const events = window.OB?.wallEventLog?.[sym] || [];
    const firstSnapTs = displaySnaps[0].ts;
    const lastSnapTsVal  = displaySnaps[displaySnaps.length-1].ts;
    const tsRange = lastSnapTsVal - firstSnapTs || 1;

    for (const ev of events) {
      if (ev.ts < firstSnapTs || ev.ts > lastSnapTsVal + 5000) continue;
      const xFrac = (ev.ts - firstSnapTs) / tsRange;
      const x = PRICE_AXIS_W + xFrac * mapW;
      const priceBucket = (ev.price - priceLo) / bucketSize;
      const y = mapH - priceBucket * rowH;
      // Draw diamond
      const color = ev.bias === 'BULL' ? '#00ff88' : '#ff4466';
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x, y + 5);
      ctx.lineTo(x - 4, y);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Price axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    const fmtP = (p) => p >= 1000 ? '$' + (p/1000).toFixed(1)+'K' : p >= 1 ? '$'+p.toFixed(2) : '$'+p.toFixed(4);
    for (let i = 0; i <= 4; i++) {
      const price = priceLo + (i / 4) * (priceHi - priceLo);
      const y = mapH - (i / 4) * mapH;
      ctx.fillText(fmtP(price), PRICE_AXIS_W - 2, y + 3);
    }

    // Time axis
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('now', W - 10, H - 3);
    const minutesBack = Math.round((tsRange / 1000) / 60);
    if (minutesBack > 0) ctx.fillText(`-${minutesBack}m`, PRICE_AXIS_W + 20, H - 3);
  }

  function initOBHud() {
    const hud = document.getElementById('ob-hud');
    if (!hud) return;
    let minimized = false;
    let hudFilter = 'ALL';
    let soundOn = true;

    function renderHud() {
      const all = window.OB?.wallAlerts || [];
      const alerts = hudFilter === 'ALL' ? all : all.filter(a => a.sym === hudFilter);
      const shown = alerts.slice(0, 15);

      const syms = PREDICTION_COINS.map(c => c.sym);
      const filterPills = ['ALL', ...syms].map(s => {
        const active = s === hudFilter ? 'active' : '';
        return `<button class="hud-pill ${active}" data-hud-filter="${s}">${s}</button>`;
      }).join('');

      const fmtP = (p) => p >= 1000 ? p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : p >= 1 ? p.toFixed(3) : p.toFixed(5);

      const rows = shown.map(a => {
        const ago = Math.round((Date.now() - a.ts) / 1000);
        const agoStr = ago < 60 ? `${ago}s` : `${Math.round(ago/60)}m`;
        return `<div class="hud-row ${a.bias.toLowerCase()} ${Date.now()-a.ts<2000?'hud-new':''}">
          <span class="hud-dot ${a.bias.toLowerCase()}"></span>
          <span class="hud-sym">${a.sym}</span>
          <span class="hud-msg">${a.side} ${a.type}</span>
          <span class="hud-price">$${fmtP(a.price)}</span>
          <span class="hud-age">${agoStr}</span>
        </div>`;
      }).join('');

      const connCount = window.OB?.getConnected?.()?.length || 0;

      hud.innerHTML = `
        <div class="hud-header">
          <span class="hud-title">⚡ WALL ALERTS <span class="hud-conn">${connCount}/7</span></span>
          <div class="hud-header-btns">
            <button class="hud-icon-btn" id="hud-sound-btn" title="Toggle sound">
              ${soundOn ? '🔊' : '🔇'}
            </button>
            <button class="hud-icon-btn" id="hud-min-btn" title="Minimize">
              ${minimized ? '▲' : '▼'}
            </button>
          </div>
        </div>
        ${!minimized ? `
          <div class="hud-filters">${filterPills}</div>
          <div class="hud-rows">${rows || '<div class="hud-empty">Monitoring for wall events…</div>'}</div>
        ` : ''}`;

      // Attach handlers
      hud.querySelector('#hud-min-btn')?.addEventListener('click', () => {
        minimized = !minimized; renderHud();
      });
      hud.querySelector('#hud-sound-btn')?.addEventListener('click', () => {
        soundOn = window.OB?.toggleSound?.() ?? !soundOn;
        renderHud();
      });
      hud.querySelectorAll('[data-hud-filter]').forEach(btn => {
        btn.addEventListener('click', () => { hudFilter = btn.dataset.hudFilter; renderHud(); });
      });
    }

    // Re-render HUD every 3 seconds
    setInterval(renderHud, 3000);
    renderHud();

    // Re-render immediately on alert
    window.OB?.onAlert(() => renderHud());
  }

  // ================================================================
  // VIEW: MARKET UNIVERSE (Periodic Table + Orbital Canvas)
  // ================================================================

  function renderUniverse() {
    content.innerHTML = `
      <div class="universe-header">
        <h2 style="font-size:18px;font-weight:700;color:var(--color-text)">Market Universe</h2>
        <div class="universe-toggle">
          <button class="universe-tab active" data-tab="table">Periodic Table</button>
          <button class="universe-tab" data-tab="orbital">Orbital View</button>
          <button class="universe-tab" data-tab="cex">CEX Flows</button>
        </div>
      </div>
      <div id="universe-table"  class="universe-panel"></div>
      <div id="universe-orbital" class="universe-panel" style="display:none">
        <canvas id="orbital-canvas" width="900" height="620" style="max-width:100%;display:block;margin:0 auto"></canvas>
      </div>
      <div id="universe-cex" class="universe-panel" style="display:none"></div>
    `;

    document.querySelectorAll('.universe-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.universe-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabName = tab.dataset.tab;
        document.getElementById('universe-table').style.display   = tabName === 'table'  ? 'block' : 'none';
        document.getElementById('universe-orbital').style.display = tabName === 'orbital'? 'block' : 'none';
        document.getElementById('universe-cex').style.display     = tabName === 'cex'    ? 'block' : 'none';
        if (orbitalAnimationFrame) { cancelAnimationFrame(orbitalAnimationFrame); orbitalAnimationFrame = null; }
        if (tabName === 'orbital') setTimeout(drawOrbital, 50);
        if (tabName === 'cex') renderCexFlow();
      });
    });

    renderPeriodicTable();
  }

  function renderPeriodicTable() {
    const el = document.getElementById('universe-table');
    if (!el) return;

    // Map each PREDICTION_COIN to its universe group
    const grouped = {
      core:     PREDICTION_COINS.filter(c => ['BTC','ETH','BNB'].includes(c.sym)),
      platform: PREDICTION_COINS.filter(c => ['SOL','XRP','HYPE'].includes(c.sym)),
      meme:     PREDICTION_COINS.filter(c => ['DOGE'].includes(c.sym)),
    };

    let html = `<div class="periodic-table">`;

    Object.entries(grouped).forEach(([groupKey, coins]) => {
      if (!coins.length) return;
      const grp = UNIVERSE_GROUPS[groupKey];
      html += `<div class="period-row">
        <div class="group-label" style="color:${grp.color}">${grp.emoji} ${grp.name}</div>`;

      coins.forEach(coin => {
        const cfm  = window._cfmAll?.[coin.sym] || {};
        const pred = window._predictions?.[coin.sym] || {};
        const rawSig = pred.signal || 'neutral';
        // Map prediction engine signals → display direction
        const sigDir = ['strong_bull','bullish'].includes(rawSig) ? 'up'
                     : ['strong_bear','bearish'].includes(rawSig) ? 'down' : 'neutral';
        const conf = pred.confidence || 0;
        const cfmLabel = cfm.cfmRate != null ? (cfm.cfmRate >= 0 ? '+' : '') + cfm.cfmRate.toFixed(2) + '%' : '—';
        const arrow = sigDir === 'up' ? '↑' : sigDir === 'down' ? '↓' : '—';

        html += `
          <div class="element ${sigDir}" style="--el-color:${grp.color}">
            <div class="element-header">
              <span class="element-icon">${coinIcon(coin.sym)}</span>
              <span class="element-sym">${coin.sym}</span>
            </div>
            <div class="element-name">${coin.name}</div>
            <div class="element-cfm">${cfmLabel}</div>
            <div class="element-signal ${sigDir}">${arrow}</div>
            <div class="element-conf">${conf ? conf + '%' : '—'}</div>
          </div>`;
      });
      html += `</div>`;
    });

    html += `</div>`;
    el.innerHTML = html;
  }

  function drawOrbital() {
    const canvas = document.getElementById('orbital-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;

    ctx.clearRect(0, 0, W, H);

    // Background glow
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, 30, cx, cy, Math.max(W, H) * 0.7);
    grad.addColorStop(0, 'rgba(79,158,255,0.12)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Orbital rings
    [0, 1, 2].forEach(i => {
      const r = 110 + i * 95;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(120,130,160,${0.28 - i * 0.06})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 7]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Nucleus
    ctx.save();
    ctx.shadowBlur = 22;
    ctx.shadowColor = 'rgba(79,158,255,0.55)';
    ctx.fillStyle = 'rgba(79,158,255,0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,158,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(130,150,200,0.9)';
    ctx.font = 'bold 10px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CFM', cx, cy);
    ctx.restore();

    // Coin nodes
    PREDICTION_COINS.forEach((coin, index) => {
      const pred  = window._predictions?.[coin.sym] || {};
      const score = pred.score || 0;
      const angle = (index * (Math.PI * 2 / PREDICTION_COINS.length)) + (Date.now() / 8000);
      const orbitIdx = ['BTC','ETH','BNB'].includes(coin.sym) ? 0 : ['SOL','XRP'].includes(coin.sym) ? 1 : 2;
      const r = 110 + orbitIdx * 95;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      const hue = score > 0.1 ? 150 : score < -0.1 ? 340 : 210;

      ctx.save();
      ctx.shadowBlur = 14;
      ctx.shadowColor = `hsl(${hue}, 88%, 60%)`;
      ctx.fillStyle = `hsl(${hue}, 88%, 58%)`;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.fill();

      // Coin icon text
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(coin.icon || coin.sym[0], x, y + 1);

      // Ticker label below node
      ctx.font = '500 10px monospace';
      ctx.fillText(coin.sym, x, y + 32);
      ctx.restore();
    });

    orbitalAnimationFrame = requestAnimationFrame(drawOrbital);
  }

  // ================================================================
  // CEX FLOW PANEL
  // ================================================================

  let _cexActiveSym = 'BTC';

  function renderCexFlow() {
    const el = document.getElementById('universe-cex');
    if (!el) return;
    refreshCexFlow(_cexActiveSym, el);
  }

  function refreshCexFlow(sym, el) {
    if (!el) el = document.getElementById('universe-cex');
    if (!el) return;
    _cexActiveSym = sym;

    const data    = window.CexFlow?.get(sym) ?? null;
    const chain   = window.ChainRouter?.get(sym) ?? null;
    const COINS   = ['BTC','ETH','SOL','XRP','BNB','DOGE','HYPE'];
    const loading = !data;

    // Coin selector tabs
    const coinTabs = COINS.map(c =>
      `<button class="cex-coin-tab ${c === sym ? 'active' : ''}" data-cex-coin="${c}">${c}</button>`
    ).join('');

    // Aggregate bar
    const agg = data?.aggregate;
    const aggColor = agg
      ? agg.score < -0.2 ? 'var(--color-red)' : agg.score > 0.2 ? 'var(--color-green)' : 'var(--color-text-muted)'
      : 'var(--color-text-muted)';
    const aggLabel = agg?.label ?? '—';
    const sAgo = data?.ts ? Math.round((Date.now() - data.ts) / 1000) : null;
    const staleTag = sAgo != null && sAgo > 60
      ? `<span style="color:var(--color-orange);font-size:10px">⚠ ${sAgo}s ago</span>`
      : sAgo != null ? `<span style="color:var(--color-text-faint);font-size:10px">↻ ${sAgo}s ago</span>` : '';

    // Chain velocity row
    let chainRow = '';
    if (chain) {
      const vel = chain.velocity?.score ?? 0;
      const velLabel = chain.velocityLabel ?? 'Stable';
      const velColor = vel > 0.15 ? 'var(--color-green)' : vel < -0.10 ? 'var(--color-red)' : 'var(--color-text-muted)';
      chainRow = `
        <div class="cex-chain-row">
          <span class="cex-chain-label">On-Chain (${chain.source})</span>
          <span style="color:${velColor};font-weight:700">${velLabel}</span>
          <span style="color:var(--color-text-muted);font-size:11px">velocity ${vel > 0 ? '+' : ''}${(vel * 100).toFixed(0)}%</span>
          <span style="color:${aggColor};font-size:11px">${chain.congestion} congestion · Leading: ${(chain.leadingScore ?? chain.score ?? 0) > 0 ? '↑ bullish' : (chain.leadingScore ?? chain.score ?? 0) < 0 ? '↓ bearish' : '—'}</span>
        </div>`;
    }

    // Exchange rows
    const exchanges = data?.exchanges ?? [];
    const exRows = exchanges.length
      ? exchanges.map(ex => {
          if (!ex.available) {
            return `<tr class="cex-row cex-na">
              <td class="cex-name">${ex.exchange}</td>
              <td colspan="4" style="color:var(--color-text-faint);font-size:11px">${ex.reason ?? 'Not listed'}</td>
            </tr>`;
          }
          const sigColor = ex.color === 'red' ? 'var(--color-red)' : ex.color === 'green' ? 'var(--color-green)' : ex.color === 'orange' ? 'var(--color-orange)' : 'var(--color-text-muted)';
          const sigDot = ex.color === 'red' ? '🔴' : ex.color === 'green' ? '🟢' : ex.color === 'orange' ? '🟠' : '⚪';
          const fundStr = ex.fundingPct != null ? `${ex.fundingPct > 0 ? '+' : ''}${ex.fundingPct.toFixed(3)}%` : '—';
          const volStr  = ex.volMult    != null ? `${ex.volMult.toFixed(1)}×` : '—';
          const volColor = ex.volMult != null && ex.volMult > 2 ? 'var(--color-orange)' : ex.volMult != null && ex.volMult > 1.4 ? 'var(--color-gold)' : 'var(--color-text-muted)';
          return `<tr class="cex-row">
            <td class="cex-name">${ex.exchange}</td>
            <td class="cex-buysell">
              <span style="color:var(--color-green)">${ex.buyPct.toFixed(0)}%B</span>
              <span style="color:var(--color-text-faint)">/</span>
              <span style="color:var(--color-red)">${ex.sellPct.toFixed(0)}%S</span>
            </td>
            <td style="color:${volColor}">${volStr}</td>
            <td style="color:${ex.fundingPct != null && ex.fundingPct > 0.02 ? 'var(--color-red)' : ex.fundingPct != null && ex.fundingPct < -0.02 ? 'var(--color-green)' : 'var(--color-text-muted)'}">${fundStr}</td>
            <td><span style="color:${sigColor};font-weight:700">${sigDot} ${ex.signal}</span></td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" style="text-align:center;color:var(--color-text-faint);padding:24px">
          ${loading ? 'Loading exchange data…' : 'No data available'}
         </td></tr>`;

    // Aggregate summary row
    const aggSummaryRow = agg ? `
      <tr class="cex-agg-row">
        <td colspan="5">
          <span style="color:${aggColor};font-weight:800">${aggLabel}</span>
          <span style="color:var(--color-text-muted);font-size:11px;margin-left:10px">
            ${agg.distributing} dist · ${agg.accumulating} accum · ${agg.volatile} volatile
          </span>
          ${agg.maxFunding ? `<span style="color:var(--color-orange);font-size:11px;margin-left:8px">⚡ Max funding: ${agg.maxFunding.exchange} ${agg.maxFunding.pct > 0 ? '+' : ''}${agg.maxFunding.pct.toFixed(3)}%</span>` : ''}
        </td>
      </tr>` : '';

    el.innerHTML = `
      <div class="cex-flow-panel">
        <div class="cex-header">
          <div class="cex-coin-tabs">${coinTabs}</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:11px;color:var(--color-text-muted)">CEX FLOW MONITOR</span>
            ${staleTag}
            <button class="cex-refresh-btn" onclick="window.CexFlow?.fetchAll()">↻</button>
          </div>
        </div>
        ${chainRow}
        <div class="cex-table-wrap">
          <table class="cex-table">
            <thead>
              <tr>
                <th>Exchange</th>
                <th>Buy / Sell</th>
                <th>Vol ×Avg</th>
                <th>Funding</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              ${exRows}
              ${aggSummaryRow}
            </tbody>
          </table>
        </div>
        <div class="cex-footnote">
          Buy/Sell from last 200–500 trades · Funding from perpetuals · Vol = current 24h vs rolling avg
        </div>
      </div>`;

    // Wire coin tab clicks
    el.querySelectorAll('[data-cex-coin]').forEach(btn => {
      btn.addEventListener('click', () => refreshCexFlow(btn.dataset.cexCoin, el));
    });
  }

  // ================================================================
  // RENDER DISPATCH
  // ================================================================

  function render() {
    _rv++; // invalidate any in-flight async renders from previous navigation
    if (candleChart && currentView !== 'charts') destroyChart();
    // Cancel orbital animation whenever leaving (or re-entering) universe
    if (orbitalAnimationFrame) { cancelAnimationFrame(orbitalAnimationFrame); orbitalAnimationFrame = null; }
    syncPredictionRefresh();

    if (!_fetchAttempted && Object.keys(tickers).length === 0 && currentView !== 'depth') {
      updateHeaderSummary();
      content.innerHTML = `<div class="loading-screen">
        <div class="loader-ring"></div>
        <p>Booting benchmark feeds…</p>
        <p style="font-size:11px;color:var(--color-muted);margin-top:8px">Connecting to Crypto.com &amp; CoinGecko</p>
        <button onclick="window._fetchAllNow?.()" style="margin-top:16px;padding:6px 18px;background:var(--color-accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px">Retry</button>
      </div>`;
      return;
    }

    updateHeaderSummary();

    try {
      switch (currentView) {
        case 'markets':    renderMarkets(); break;
        case 'markets5m':  renderMarkets5M(); break;
        case 'portfolio': renderPortfolio(); break;
        case 'charts':    renderCharts(); break;
        case 'onchain':   renderOnChain(); break;
        case 'cfm':         renderCFM(); break;
        case 'predictions': renderPredictions(); break;
        case 'screener':  renderScreener(); break;
        case 'depth':     renderDepth(); break;
        case 'universe':  renderUniverse(); break;
      }
    } catch (e) {
      console.error('[render] Panel error:', e);
      content.innerHTML = `<div class="error-notice">⚠ Panel error: ${e.message}<br><small>${e.stack || ''}</small></div>`;
    }
  }

  // ================================================================
  // BOOT
  // ================================================================

  // Start Coinbase Advanced Trade WebSocket for live 15-min candle buckets
  if (window.CandleWS) {
    CandleWS.start();
    window.addEventListener('candleWS:connected', () => {
      const el = document.getElementById('feedStatusText');
      if (el) el.textContent = 'Live · WS connected';
    });
    window.addEventListener('candleWS:disconnected', () => {
      const el = document.getElementById('feedStatusText');
      if (el) el.textContent = 'WS reconnecting…';
    });
  }

  // ── CFM Floating Router — start early exit polling ─────────────
  if (window.CFMRouter) {
    CFMRouter.startExitPolling();
  }

  // ── CFM Early Exit Toast ────────────────────────────────────────
  window.addEventListener('cfm:earlyExit', (e) => {
    const { sym, reason, strength, prediction, type } = e.detail || {};
    if (!sym) return;
    showEarlyExitToast(sym, prediction, reason, strength, type);
  });

  // ── Shell Router Veto Toasts ────────────────────────────────────
  window.addEventListener('shell:vetoConfirmed', (e) => {
    const { sym, amplifiedEnergy } = e.detail || {};
    if (!sym) return;
    const coin  = (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []).find(c => c.sym === sym);
    const icon  = coin?.icon || sym;
    const pct   = Math.round((amplifiedEnergy || 0) * 100 * 10) / 10;
    showEarlyExitToast(sym, 'current', `Shell energy ${pct}% — stand aside`, Math.min((amplifiedEnergy || 0) * 8, 1), 'coordinated_sell');
    console.log(`[ShellRouter] Toast: ${sym} wall CONFIRMED`);
  });

  window.addEventListener('shell:vetoReleased', (e) => {
    const { sym, reason } = e.detail || {};
    if (!sym) return;
    // Show a brief green "wall absorbed" notification
    if (activeToasts.has(sym)) {
      activeToasts.get(sym).remove();
      activeToasts.delete(sym);
    }
    const coin  = (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []).find(c => c.sym === sym);
    const icon  = coin?.icon || sym;
    const toast = document.createElement('div');
    toast.setAttribute('data-exit-toast', sym + '-released');
    toast.style.cssText = [
      'position:fixed', 'top:68px', 'right:16px', 'z-index:9999',
      'background:var(--color-surface,#12192e)', 'border:1px solid rgba(0,200,100,0.35)',
      'border-radius:10px', 'padding:10px 14px', 'min-width:200px', 'max-width:280px',
      'box-shadow:0 4px 20px rgba(0,0,0,.45)', 'animation:fadeInRight .25s ease', 'cursor:pointer',
    ].join(';');
    toast.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">${icon}</span>
        <span style="font-weight:700;color:var(--color-green)">✅ ${sym} — wall absorbed</span>
      </div>
      <div style="font-size:11px;color:var(--color-text-muted);margin-top:3px">
        ${reason ?? 'Wall pressure resolved — prediction resumes'}
      </div>`;
    toast.addEventListener('click', () => toast.remove());
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 12000);
    console.log(`[ShellRouter] Toast: ${sym} wall released (${reason})`);
  });

  // ── 15M Market Resolution listener ─────────────────────────────────
  // Kalshi 15M settled result fed back into CFM calibration.
  window.addEventListener('market15m:resolved', (e) => {
    const { sym, outcome, modelCorrect, prob } = e.detail || {};
    if (!sym) return;
    const icon  = modelCorrect === true ? '✅' : modelCorrect === false ? '❌' : '❓';
    const coin  = (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []).find(c => c.sym === sym);
    const label = coin?.icon ? coin.icon + ' ' + sym : sym;
    console.log('[Resolver] ' + label + ' 15M ' + outcome + ' ' + icon + ' | prob:' + Math.round((prob||0.5)*100) + '%');
    if (currentView === 'predictions' && predsLoaded) updateAccuracyBadge();
  });

  // ── Real-time ms countdown for last-call Kalshi contracts ────────────────
  // Updates every 100ms so traders see sub-second precision when < 10s left.
  // Targets elements with data-close-ms attribute — set during render.
  setInterval(() => {
    const now = Date.now();
    // Scope to the active view to avoid scanning the entire document on every 100ms tick
    const activeView = document.querySelector('.view.active') || document.body;
    activeView.querySelectorAll('[data-close-ms]').forEach(el => {
      const closeMs  = parseInt(el.getAttribute('data-close-ms'), 10);
      const msLeft   = Math.max(0, closeMs - now);
      const secsLeft = msLeft / 1000;
      let label;
      if (secsLeft < 10)      label = msLeft.toFixed(0) + 'ms';
      else if (secsLeft < 90) label = Math.round(secsLeft) + 's';
      else                    label = (secsLeft / 60).toFixed(1) + 'm';
      if (el.id && el.id.startsWith('kalshi-lc-')) {
        el.textContent = '⚡ ' + label;
        // Pulse red when < 10s
        el.style.opacity = secsLeft < 10 && Math.floor(now / 300) % 2 === 0 ? '0.5' : '1';
      } else if (el.id && el.id.startsWith('kalshi-min-')) {
        el.innerHTML = '⏱ <strong' + (secsLeft < 30 ? ' style="color:var(--color-red)"' : '') + '>' + label + '</strong>';
      }
    });
  }, 100);

  // ── Blockchain scan live updates ──────────────────────────────────
  window.addEventListener('blockchain-scan-update', () => {
    if (currentView === 'onchain') refreshChainScanUI();
  });

  window.addEventListener('cex-flow-update', () => {
    if (currentView === 'universe') {
      const cexEl = document.getElementById('universe-cex');
      if (cexEl && cexEl.style.display !== 'none') refreshCexFlow(_cexActiveSym, cexEl);
    }
  });

  // Hard 10-second boot guard — if fetchAll hangs, force a render anyway
  const _bootGuard = setTimeout(() => {
    if (Object.keys(tickers).length === 0) {
      console.warn('[boot] fetchAll timed out after 10s — forcing render with empty tickers');
      setFeedStatus('error');
      render();
    }
  }, 10000);

  window._fetchAllNow = () => fetchAll(true).then(() => { clearTimeout(_bootGuard); resetTimer(); });

  // Prewarm coin icons — populates browser HTTP cache before first render
  (function prewarmCoinIcons() {
    const syms = ['BTC','ETH','SOL','XRP','HYPE','DOGE','BNB'];
    const cgBase = 'https://assets.coingecko.com/coins/images';
    const cgIds  = { BTC:'1/large/bitcoin.png', ETH:'279/large/ethereum.png', SOL:'4128/large/solana.png',
                     XRP:'44/large/xrp-symbol-white-128.png', HYPE:'39198/large/hyperliquid.png',
                     DOGE:'5/large/dogecoin.png', BNB:'825/large/bnb-icon2_2x.png' };
    syms.forEach(sym => {
      const img = new Image();
      img.src = `${cgBase}/${cgIds[sym]}`;
      img.onerror = () => {
        const fb = new Image();
        fb.src = `https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons/128/color/${sym.toLowerCase()}.png`;
      };
    });
  })();

  fetchAll().then(() => {
    clearTimeout(_bootGuard);
    resetTimer();
    if (window.PredictionMarkets) window.PredictionMarkets.start();             // immediate
    setTimeout(() => { if (window.BlockchainScan) window.BlockchainScan.start(); }, 1500); // +1.5s
    setTimeout(() => { if (window.CexFlow)        window.CexFlow.start(); },        3000); // +3s
  });

  // ── Order Book HUD — initialise after DOM is ready ──────────────
  initOBHud();

})();
