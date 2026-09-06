// ================================================================
// WE|||CRYPTO â€” Prediction Markets Intelligence Layer v2.1
// Aggregates Kalshi 15M + Polymarket 5M/longer-horizon sentiment for crypto markets
//
// Sources (no auth required for market data):
//   Kalshi 15M  â€” Direct 15-min UP/DOWN direction markets (KXBTC15M etc.)
//                 YES price = market-implied probability price rises in 15 min
//                 Perfectly aligned with our h15 prediction horizon
//   Polymarket  â€” Decentralised prediction market on Polygon
//                 Gamma API primary; CLOB API fallback on failure
//
// Exposes window.PredictionMarkets:
//   .start()      â€” begin 30-second polling
//   .getAll()     â€” per-coin sentiment map
//   .getCoin(sym) â€” { kalshi, poly, combinedProb, kalshi15m, poly5m, sources, ... }
//   .getStatus()  â€” last fetch metadata
// ================================================================

(function () {
  'use strict';

  const KALSHI_BASE = ''; // Kalshi network disabled — Polymarket only
  const POLY_GAMMA = 'https://gamma-api.polymarket.com';
  const POLY_CLOB = 'https://clob.polymarket.com';
  // CLOB market WS is owned solely by window.PolymarketWS (src/feeds/polymarket-ws.js).
  // Do not open a second connection here — that caused duplicate books / half-depth.
  const POLY_GAMMA_ACTIVE_EVENTS_FALLBACKS = [
    { tagId: 21, source: 'gamma-events-tag21-crypto' },
    { tagId: 1, source: 'gamma-events-tag1-user-fallback' },
  ];
  const POLY_5M_FALLBACK_JUSTIFICATION =
    'Deterministic slug lookup is exact and lowest latency; active event scans are slower/noisier and Gamma tag ids drift, so they only fill discovery gaps after exact slug routes fail.';

  const COIN_PATTERNS = {
    BTC: [/\bbitcoin\b/i, /\bbtc\b/i],
    ETH: [/\bethereum\b/i, /\beth\b/i],
    SOL: [/\bsolana\b/i, /\bsol\b/i],
    XRP: [/\bxrp\b/i, /\bripple\b/i],
    DOGE: [/\bdogecoin\b/i, /\bdoge\b/i],
    BNB: [/\bbnb\b/i, /\bbinance\s+coin\b/i, /\bbinancecoin\b/i],
    HYPE: [/\bhyperliquid\b/i, /\bhype\b/i],
  };

  const POLY_5M_KEYWORDS = ['5 min', '5min', '5-min', 'next 5', 'five min', '5m ', '5 m '];
  const POLY_SHORT_WINDOW_MS = 60 * 60_000;
  
  // 15-second refresh â€” keeps Yes/No vote initialization tightly synced to
  // active 15M contracts, especially during boundary rollovers.
  const POLL_MS = 15_000;
  const KALSHI_MARKET_LIMIT = 25;
  const BUCKET_MS_15M = 15 * 60_000;
  const BUCKET_MS_5M = 5 * 60_000;
  const MIN_TRADABLE_MS_15M = 45_000;
  const MIN_TRADABLE_MS_5M = 20_000;
  const MIN_TRADABLE_MS_15M_PROXY = 30_000;

  // Direct 15-minute UP/DOWN series: YES = price higher in 15 min
  const KALSHI_15M_SERIES = {
    BTC: 'KXBTC15M',
    ETH: 'KXETH15M',
    SOL: 'KXSOL15M',
    XRP: 'KXXRP15M',
    DOGE: 'KXDOGE15M',
    BNB: 'KXBNB15M',
    HYPE: 'KXHYPE15M',
  };

  // Direct 5-minute UP/DOWN series — BNB/HYPE gracefully null if not live on Kalshi
  const KALSHI_5M_SERIES = {
    BTC: 'KXBTC5M',
    ETH: 'KXETH5M',
    SOL: 'KXSOL5M',
    XRP: 'KXXRP5M',
    DOGE: 'KXDOGE5M',
  };

  // Polymarket Up/Down 5-minute markets use deterministic slugs:
  // {prefix}-updown-5m-{unixWindowStart}. Outcomes are ["Up", "Down"].
  const POLY_5M_COIN_SLUGS = {
    BTC: 'btc',
    ETH: 'eth',
    SOL: 'sol',
    XRP: 'xrp',
    DOGE: 'doge',
    BNB: 'bnb',
    HYPE: 'hype',
  };

  const KALSHI_DISABLED = true; // 100% Polymarket only mode

  let cache = Object.create(null);
  let lastFetch = 0;
  let inFlight = null;
  let timer = null;
  let _quarterDebugTicksRemaining = 80; // ~20 minutes at 15s poll
  // Rate-limit state: if non-zero, skip fetching until this timestamp
  let _rateLimitUntil = 0;
  let _consecutive429 = 0;

  // â”€â”€ Kalshi probability velocity tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Tracks the last 12 probability readings per coin to detect smart-money
  // drift BEFORE the model catches up. velocity > 0 = Kalshi odds rising (bullish).
  const _probHistory = Object.create(null);
  // Signed CLOB auth lives in Electron main (secrets/POLYMARKET_API.txt).
  // Public Gamma/CLOB market GETs do not need L2 headers in the renderer.
  function _injectPolyHeaders(url, headers = {}) {
    return headers || {};
  }

  // ---- Route through Tauri suppFetch to bypass WebView2 CORS / geo-blocks ----
  async function readJsonPayload(payload) {
    if (!payload) return null;
    if (typeof Response !== 'undefined' && payload instanceof Response) {
      if (!payload.ok) throw new Error(`HTTP ${payload.status}`);
      return payload.json();
    }
    if (typeof payload.json === 'function' && typeof payload.ok === 'boolean') {
      if (!payload.ok) throw new Error(`HTTP ${payload.status}`);
      return payload.json();
    }
    if (typeof payload === 'string') return JSON.parse(payload);
    return payload;
  }

  async function apiFetch(url, opts = {}) {
    const requestOpts = { ...opts, headers: _injectPolyHeaders(url, { Accept: 'application/json', ...opts.headers }) };
    if (typeof window.suppFetch === 'function') {
      try {
        return await readJsonPayload(await window.suppFetch(url, requestOpts));
      } catch (err) {
        console.warn(`[PredictionMarkets] suppFetch failed for ${url}:`, err?.message || err);
      }
    }
    // Try IPC fetch (main process, no CORS) when running in Electron
    if (window.electron?.ipcFetch) {
      try {
        const r = await window.electron.ipcFetch(url, requestOpts);
        if (r.ok) return typeof r.text === 'string' ? JSON.parse(r.text) : r.text;
        throw new Error(`HTTP ${r.status || 0}${r.error ? ` ${r.error}` : ''}`);
      } catch (err) {
        console.warn(`[PredictionMarkets] ipcFetch failed for ${url}:`, err?.message || err);
      }
    }
    // Try CORS proxy fallback if running in browser
    const proxyPort = (typeof window !== 'undefined' && window.__PROXY_PORT__) || 3010;
    const proxyUrls = [];
    if (url.startsWith('https://gamma-api.polymarket.com/')) {
      proxyUrls.push(url.replace('https://gamma-api.polymarket.com/', `http://127.0.0.1:${proxyPort}/polymarket/`));
      proxyUrls.push(url.replace('https://gamma-api.polymarket.com/', `http://127.0.0.1:${proxyPort}/gamma/`));
      proxyUrls.push(`http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(url)}`);
    } else if (url.startsWith('https://clob.polymarket.com/')) {
      proxyUrls.push(url.replace('https://clob.polymarket.com/', `http://127.0.0.1:${proxyPort}/polymarket-clob/`));
      proxyUrls.push(url.replace('https://clob.polymarket.com/', `http://127.0.0.1:${proxyPort}/clob/`));
      proxyUrls.push(`http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(url)}`);
    } else if (url.startsWith('https://data-api.polymarket.com/')) {
      proxyUrls.push(url.replace('https://data-api.polymarket.com/', `http://127.0.0.1:${proxyPort}/polymarket-data/`));
      proxyUrls.push(`http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(url)}`);
    } else if (url.startsWith('https://polymarket.com/')) {
      proxyUrls.push(`http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(url)}`);
    }
    for (const pUrl of proxyUrls) {
      try {
        const pr = await fetch(pUrl, requestOpts);
        if (pr.ok) return await pr.json();
      } catch (_) {}
    }
    const res = await fetch(url, requestOpts);
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }

  async function readTextPayload(payload) {
    if (!payload) return '';
    if (typeof Response !== 'undefined' && payload instanceof Response) {
      if (!payload.ok) throw new Error(`HTTP ${payload.status}`);
      return payload.text();
    }
    if (typeof payload.text === 'function' && typeof payload.ok === 'boolean') {
      if (!payload.ok) throw new Error(`HTTP ${payload.status}`);
      return payload.text();
    }
    if (typeof payload === 'string') return payload;
    return JSON.stringify(payload);
  }

  async function textFetch(url, opts = {}) {
    const requestOpts = { ...opts, headers: _injectPolyHeaders(url, { Accept: 'text/html,application/json,*/*', ...opts.headers }) };
    if (typeof window.suppFetch === 'function') {
      try {
        return await readTextPayload(await window.suppFetch(url, requestOpts));
      } catch (err) {
        console.warn(`[PredictionMarkets] suppFetch text failed for ${url}:`, err?.message || err);
      }
    }
    if (window.electron?.ipcFetch) {
      try {
        const r = await window.electron.ipcFetch(url, requestOpts);
        if (r.ok) return typeof r.text === 'string' ? r.text : JSON.stringify(r.text);
        throw new Error(`HTTP ${r.status || 0}${r.error ? ` ${r.error}` : ''}`);
      } catch (err) {
        console.warn(`[PredictionMarkets] ipcFetch text failed for ${url}:`, err?.message || err);
      }
    }
    // Try CORS proxy fallback if running in browser
    const proxyPort = (typeof window !== 'undefined' && window.__PROXY_PORT__) || 3010;
    const proxyUrls = [];
    if (url.startsWith('https://gamma-api.polymarket.com/')) {
      proxyUrls.push(url.replace('https://gamma-api.polymarket.com/', `http://127.0.0.1:${proxyPort}/polymarket/`));
      proxyUrls.push(url.replace('https://gamma-api.polymarket.com/', `http://127.0.0.1:${proxyPort}/gamma/`));
      proxyUrls.push(`http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(url)}`);
    } else if (url.startsWith('https://clob.polymarket.com/')) {
      proxyUrls.push(url.replace('https://clob.polymarket.com/', `http://127.0.0.1:${proxyPort}/polymarket-clob/`));
      proxyUrls.push(url.replace('https://clob.polymarket.com/', `http://127.0.0.1:${proxyPort}/clob/`));
      proxyUrls.push(`http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(url)}`);
    } else if (url.startsWith('https://data-api.polymarket.com/')) {
      proxyUrls.push(url.replace('https://data-api.polymarket.com/', `http://127.0.0.1:${proxyPort}/polymarket-data/`));
      proxyUrls.push(`http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(url)}`);
    } else if (url.startsWith('https://polymarket.com/')) {
      proxyUrls.push(`http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(url)}`);
    }
    for (const pUrl of proxyUrls) {
      try {
        const pr = await fetch(pUrl, requestOpts);
        if (pr.ok) return await pr.text();
      } catch (_) {}
    }
    const res = await fetch(url, requestOpts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  async function jsonFetch(url, opts = {}) {
    const requestOpts = { ...opts, headers: { Accept: 'application/json', ...opts.headers } };
    const text = await textFetch(url, requestOpts);
    try {
      return JSON.parse(text);
    } catch (e) {
      const snippet = String(text || '').slice(0, 200);
      throw new Error(`jsonFetch: invalid JSON from ${url}: ${e?.message || e} — body: ${snippet}`);
    }
  }

  // ---- Rate-limit-aware Kalshi fetch helper --------------------------
  // Routes through ProxyOrchestrator for:
  //   - Per-endpoint rate limiting
  //   - Deduplication (coalesce identical requests within 500ms)
  //   - Fallback chains (Kalshi â†’ Polymarket â†’ Cache)
  //   - Multi-layer caching (memory â†’ localStorage)
  //
  // Fallback to direct fetch if ProxyOrchestrator not initialized.

  function parseKalshiUrl(url) {
    try {
      const u = new URL(url);
      return {
        series_ticker: u.searchParams.get('series_ticker') || null,
        status: u.searchParams.get('status') || 'open',
        limit: parseInt(u.searchParams.get('limit') || String(KALSHI_MARKET_LIMIT), 10),
      };
    } catch (_) {
      return { series_ticker: null, status: 'open', limit: KALSHI_MARKET_LIMIT };
    }
  }

  // Recursively unwrap IPC response to find the markets array.
  // proxyToWorker → { success, data, status }
  // worker getMarkets → { success, data: { markets:[...] }, count, timestamp }
  // Full nest: ipcRaw.data.data.markets OR ipcRaw.data.markets
  function _extractMarketsArray(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    if (Array.isArray(obj)) {
      // bare markets list or list of market-like objects
      if (!obj.length || obj[0]?.ticker || obj[0]?.event_ticker || obj[0]?.yes_bid != null) return obj;
      return null;
    }
    if (Array.isArray(obj.markets)) return obj.markets;
    // walk common wrapper keys
    for (const key of ['data', 'result', 'payload', 'body', 'response']) {
      if (obj[key] != null) {
        const found = _extractMarketsArray(obj[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function _ipcLooksRateLimited(ipcRaw) {
    if (!ipcRaw) return false;
    if (ipcRaw.status === 429) return true;
    const err = String(ipcRaw.error || ipcRaw.data?.error || ipcRaw.data?.code || '');
    return /429|rate.?limit|too many/i.test(err);
  }

  function _tripKalshiCooldown(reason, waitMs) {
    _consecutive429++;
    const wait = waitMs || (_consecutive429 >= 3 ? 90_000 : Math.min(60_000, 8_000 * (2 ** Math.min(4, _consecutive429 - 1))));
    _rateLimitUntil = Date.now() + wait;
    console.warn(`[PredictionMarkets] Kalshi cooldown ${wait}ms — ${reason} (streak=${_consecutive429})`);
    try {
      window.EndpointTransport?.markProviderRateLimited?.('kalshi', new Error(reason));
    } catch (_) { }
    return wait;
  }

  async function kalshiFetch(url, attempt = 0) {
    if (_rateLimitUntil > Date.now()) {
      // Silent skip while cooling — don't log every coin
      return null;
    }

    const params = parseKalshiUrl(url);
    let data = null;
    let transport = 'http';
    let is429 = false;
    let ipcEmptyOk = false; // IPC succeeded with empty markets — do NOT cascade

    if (window.electron && window.electron.invoke) {
      try {
        const ipcRaw = await window.electron.invoke('kalshi:markets', params);
        if (_ipcLooksRateLimited(ipcRaw)) {
          is429 = true;
        } else {
          const mkts = _extractMarketsArray(ipcRaw);
          if (mkts && mkts.length > 0) {
            data = { markets: mkts };
            transport = 'ipc-sdk';
            if (attempt === 0) {
              console.log(`[PredictionMarkets] IPC kalshi:markets → ${mkts.length} markets for ${params.series_ticker || 'all'}`);
            }
          } else if (ipcRaw?.success || ipcRaw?.status === 200 || ipcRaw?.data?.success) {
            // Successful empty response (series may have no open markets) — stop cascading
            ipcEmptyOk = true;
            data = { markets: [] };
            transport = 'ipc-sdk-empty';
          } else if (ipcRaw && !ipcRaw.success) {
            const shape = `success=${ipcRaw.success}, err=${ipcRaw.error || ipcRaw.data?.error || ''}, code=${ipcRaw.data?.code || ipcRaw.status || ''}`;
            console.warn(`[PredictionMarkets] IPC kalshi:markets failed: ${shape}`);
            if (/429|rate/i.test(shape)) is429 = true;
          } else {
            const shape = ipcRaw
              ? `success=${ipcRaw.success}, hasData=${!!ipcRaw.data}, keys=${Object.keys(ipcRaw.data || {}).join(',')}`
              : 'null';
            console.warn(`[PredictionMarkets] IPC kalshi:markets returned no markets. Shape: ${shape}`);
          }
        }
      } catch (err) {
        console.warn(`[PredictionMarkets] IPC kalshi:markets failed:`, err?.message || err);
        if (/429|rate.?limit/i.test(String(err?.message || err))) is429 = true;
      }
    }

    // Only cascade if IPC truly failed — not on empty series, not on 429
    if (!data && !is429 && !ipcEmptyOk && window.EndpointTransport?.fetchKalshiMarkets) {
      try {
        data = await window.EndpointTransport.fetchKalshiMarkets(params);
        transport = data?._transport || 'rpc/http';
      } catch (err) {
        console.warn(`[PredictionMarkets] EndpointTransport failed:`, err?.message || err);
        window._kalshiErrors = window._kalshiErrors || [];
        window._kalshiErrors.push({ ts: Date.now(), sym: params.series_ticker || 'SYS', msg: 'Proxy ' + (err?.message || 'Error') });
        if (/429|rate.?limit/i.test(String(err?.message || err))) is429 = true;
      }
    }

    if (!data && !is429 && !ipcEmptyOk) {
      try {
        data = await apiFetch(url);
        transport = 'http';
      } catch (err) {
        console.error(`[PredictionMarkets] Fetch error for ${url}:`, err?.message || err);
        window._kalshiErrors = window._kalshiErrors || [];
        window._kalshiErrors.push({ ts: Date.now(), sym: params.series_ticker || 'SYS', msg: 'Fetch ' + (err?.message || 'Error') });
        if (/429|rate.?limit/i.test(String(err?.message || err))) is429 = true;
        else return null;
      }
    }

    if (is429 || (data && typeof data === 'object' && data.status === 429)) {
      // Cool down and DO NOT immediately retry — retries multiply 429s across series.
      _tripKalshiCooldown('HTTP 429');
      return null;
    }

    if (data && data.markets) _consecutive429 = 0;
    if (data && data.markets) _consecutive429 = 0;
    return data;
  }

  function toFiniteProbability(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
  }

  function toPositiveFiniteNumber(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // --- Polymarket RTDS (Real-Time Data Service) live TWAP feed ---
  // wss://ws-live-data.polymarket.com is Polymarket's own free, credential-free
  // websocket for the exact Chainlink TWAP series their 5m/15m Up/Down contracts
  // resolve against (docs.polymarket.com/market-data/chainlink-twap). This is
  // NOT a Chainlink-direct integration -- it's Polymarket's own relay of it, so
  // it stays inside the "Polymarket only" rule for PTB.
  // It only streams the live value going forward (no history/replay after a
  // disconnect), so it can only ever tell us the true price AT the moment a
  // window opens -- never retroactively. It is sampled once, at the exact
  // boundary-clock rollover, and locked immediately; it must never be read
  // later in a window as a live/current price, or it would be exactly the
  // "provisional spot proxy" this whole PTB effort has been built to avoid.
  const RTDS_TWAP_SYMBOL = { BTC: 'btc/usd', ETH: 'eth/usd', SOL: 'sol/usd', XRP: 'xrp/usd', DOGE: 'doge/usd', BNB: 'bnb/usd', HYPE: 'hype/usd' };
  const _rtdsLiveTwap = Object.create(null); // sym -> { price, obsTs, recvAt }
  let _rtdsSocket = null;
  let _rtdsPingTimer = null;
  let _rtdsReconnectTimer = null;

  function _ensurePolymarketRtdsSocket() {
    if (typeof WebSocket === 'undefined') return;
    if (_rtdsSocket && (_rtdsSocket.readyState === WebSocket.OPEN || _rtdsSocket.readyState === WebSocket.CONNECTING)) return;
    try {
      const ws = new WebSocket('wss://ws-live-data.polymarket.com');
      _rtdsSocket = ws;
      ws.addEventListener('open', () => {
        try {
          ws.send(JSON.stringify({
            action: 'subscribe',
            subscriptions: [{ topic: 'crypto_prices_twap_thirty', type: 'update' }],
          }));
        } catch (_) {}
        if (_rtdsPingTimer) clearInterval(_rtdsPingTimer);
        _rtdsPingTimer = setInterval(() => { try { ws.send('PING'); } catch (_) {} }, 5_000);
        console.info('[PredictionMarkets] Polymarket RTDS TWAP socket connected');
      });
      ws.addEventListener('message', (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          const payload = msg?.payload;
          const symKey = payload?.symbol;
          const value = Number(payload?.value);
          if (!symKey || !Number.isFinite(value) || value <= 0) return;
          const sym = Object.keys(RTDS_TWAP_SYMBOL).find(k => RTDS_TWAP_SYMBOL[k] === symKey);
          if (!sym) return;
          _rtdsLiveTwap[sym] = { price: value, obsTs: Number(payload.timestamp) || Date.now(), recvAt: Date.now() };
        } catch (_) {}
      });
      const scheduleReconnect = () => {
        _rtdsSocket = null;
        if (_rtdsPingTimer) { clearInterval(_rtdsPingTimer); _rtdsPingTimer = null; }
        if (_rtdsReconnectTimer) return;
        _rtdsReconnectTimer = setTimeout(() => {
          _rtdsReconnectTimer = null;
          try { _ensurePolymarketRtdsSocket(); } catch (_) {}
        }, 5_000);
      };
      ws.addEventListener('close', scheduleReconnect);
      ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
    } catch (_) {}
  }

  // Only usable within a few seconds of receipt -- see comment above on why
  // this must never be treated as a general-purpose live price source.
  function _getFreshRtdsTwap(sym, maxAgeMs = 8_000) {
    const v = _rtdsLiveTwap[sym];
    if (!v) return null;
    if (Date.now() - v.recvAt > maxAgeMs) return null;
    return v;
  }

  // A single attempt exactly at boundary rollover missed too often (RTDS
  // socket momentarily behind on the exact tick, or the scrape returning
  // null) -- once missed, PTB stayed "pending" for the rest of the whole
  // window instead of resolving within a few seconds. Retry every tick for
  // a short grace window after rollover instead of giving up after one try.
  // RTDS is checked every tick (cheap, just reads a cache); the event-page
  // scrape is throttled since it's a real network fetch. After the grace
  // window elapses with nothing found, stop -- that means Polymarket
  // genuinely hasn't published it yet, and "pending" is the honest state.
  const _pendingPtbLocks = Object.create(null); // slug -> { sym, boundaryMs, lastScrapeAttemptTs, scrapeAttempts }
  // Verified live (2026-08-11): Polymarket's own chainlink-candles endpoint
  // does not have a candle for a brand-new window immediately -- checked a
  // window 31 seconds after it opened and the API's latest candle was still
  // the *previous* one. The original 25s grace window was shorter than that
  // real-world publish latency, so it gave up and left PTB stuck on
  // "pending" for the rest of the window before Polymarket ever published
  // it. 120s gives ample margin inside a 300s (5m) window without ever
  // showing a late/approximate value -- it's still the exact number once
  // found, just retried for longer before conceding "pending" is honest.
  const PTB_LOCK_GRACE_MS = 120_000;
  const PTB_SCRAPE_RETRY_MS = 4_000;
  const PTB_SCRAPE_RETRIES_SEC = Array.from(
    { length: Math.ceil(PTB_LOCK_GRACE_MS / PTB_SCRAPE_RETRY_MS) },
    () => PTB_SCRAPE_RETRY_MS / 1000
  );
  const PTB_SCRAPE_MAX_ATTEMPTS = PTB_SCRAPE_RETRIES_SEC.length;
  // Live-verified (2026-08-18): Gamma `cryptoMarketConfig` for current 5m and
  // 15m Up/Down markets is `btc-5m-twap-60` / `btc-15m-twap-60` with
  // twapLookbackSeconds=60. Querying chainlink-candles with lookback=30
  // produced a different open (e.g. BTC 16:10 window 64758.01 vs official
  // 64759.43) and that wrong number locked for the whole contract.
  const POLY_TWAP_LOOKBACK_SEC = 60;
  // Refuse to lock before the TWAP window has fully accumulated. 32s was
  // sized for the old 30s lookback; at 60s that captured a half-formed open.
  const PTB_TWAP_SETTLE_SEC = POLY_TWAP_LOOKBACK_SEC + 2;

  function _seedPendingPtbLock(sym, slug, boundaryMs) {
    const lk = _getPolymarketPriceToBeatLock(slug);
    // Skip only if the lock is already final (event-page value, or its one-shot
    // correction is spent). A candle/fallback lock still needs the event-page
    // retry loop so it can be corrected to the exact contract benchmark.
    if (lk && (lk.corrected || POLY5M_PTB_AUTHORITATIVE_SOURCES.has(lk.source))) return;
    if (_pendingPtbLocks[slug]) return;
    _pendingPtbLocks[slug] = { sym, boundaryMs, lastScrapeAttemptTs: 0, scrapeAttempts: 0 };
  }

  function _tickPendingPtbLocks() {
    const now = Date.now();
    for (const [slug, st] of Object.entries(_pendingPtbLocks)) {
      const lk = _getPolymarketPriceToBeatLock(slug);
      // Stop only once the lock is the contract's own event-page value (or has
      // already spent its one-shot correction). A candle/fallback lock is not
      // done yet -- keep scraping the event page so it can be corrected to the
      // exact benchmark if it came in a few cents off.
      if (lk && (lk.corrected || POLY5M_PTB_AUTHORITATIVE_SOURCES.has(lk.source))) {
        delete _pendingPtbLocks[slug]; continue;
      }
      if (now - st.boundaryMs > PTB_LOCK_GRACE_MS) { delete _pendingPtbLocks[slug]; continue; }

      // RTDS is deliberately not used here -- see POLY5M_PTB_TRUSTED_SOURCES.
      // Only the event-page scrape (Polymarket's own closed-window continuity
      // record) can produce an exact value, so that's the only thing retried.
      if (st.scrapeAttempts >= PTB_SCRAPE_MAX_ATTEMPTS) continue;
      const delayMs = (PTB_SCRAPE_RETRIES_SEC[st.scrapeAttempts] || 15) * 1000;
      if (now - st.lastScrapeAttemptTs < delayMs) continue;
      st.lastScrapeAttemptTs = now;
      st.scrapeAttempts++;
      fetchPolymarketPriceToBeat(slug).then(() => {
        // fetchPolymarketPriceToBeat drives the event-page lock/correction
        // itself; just clear the pending entry once it reaches a final state.
        const after = _getPolymarketPriceToBeatLock(slug);
        if (after && (after.corrected || POLY5M_PTB_AUTHORITATIVE_SOURCES.has(after.source))) {
          delete _pendingPtbLocks[slug];
        }
      }).catch(() => {});
    }

    // Sweep _pendingPtbReads for slugs that stopped receiving readings before
    // ever confirming or hitting the grace fallback in _lockPolymarketPriceToBeat
    // (e.g. every source for that one window went permanently unreachable) --
    // otherwise those single-read entries would sit in memory for the life of
    // the process. A window is long closed once it's PTB_LOCK_GRACE_MS past its
    // own boundary, so it can never lock or be read again either way.
    for (const [slug, reads] of _pendingPtbReads) {
      if (_poly5mPriceToBeatLocks.has(slug)) { _pendingPtbReads.delete(slug); continue; }
      const m = slug.match(/-updown-(?:5m|15m|60m|1h)-(\d+)$/);
      const boundaryMs = m ? Number(m[1]) * 1000 : null;
      const staleSinceLastRead = !reads.length || (now - reads[reads.length - 1].at > PTB_LOCK_GRACE_MS);
      if ((Number.isFinite(boundaryMs) && now - boundaryMs > PTB_LOCK_GRACE_MS) || staleSinceLastRead) {
        _pendingPtbReads.delete(slug);
      }
    }
  }

  const PYTH_LAZER_PRICE_FEED_IDS = { BTC: 1, ETH: 2, SOL: 6, DOGE: 10, XRP: 14, BNB: 15 };
  let _pythRealtimeSnapshot = { fetchedAt: 0, prices: null, inFlight: null };

  const ResonanceFilter = (typeof require !== 'undefined')
    ? require('../infra/resonance-filter')
    : (typeof window !== 'undefined' ? window.ResonanceFilter : null);
  // Low-pass cutoff for Pyth spot-price smoothing. Additive only -- this
  // never touches PTB (Polymarket's own published contract value must stay
  // exact, see POLY5M_PTB_LOCK_VERSION notes below) or the raw `price` field
  // callers already read; it only adds a `filteredPrice` alongside it. 2Hz
  // removes noise above the level a human/LLM would react to while staying
  // responsive against the multi-second PTB-confirm and LLM-call latencies
  // that already dominate this pipeline's end-to-end timing.
  const PYTH_PRICE_FILTER_HZ = Number(
    (typeof process !== 'undefined' && process.env && process.env.PYTH_PRICE_FILTER_HZ) || 2
  );
  const _pythPriceFilters = new Map(); // sym -> low-pass filter instance

  function _filteredPythPrice(sym, price, timestamp) {
    if (!ResonanceFilter || !Number.isFinite(price)) return null;
    let f = _pythPriceFilters.get(sym);
    if (!f) {
      f = ResonanceFilter.createLowPassFilter(PYTH_PRICE_FILTER_HZ);
      _pythPriceFilters.set(sym, f);
    }
    return f.update(price, Number.isFinite(timestamp) ? timestamp : Date.now());
  }

  // Push-driven cache kept live by the 'pyth:tickers' IPC event that electron/main.js sends on
  // every WS tick, instead of re-pulling via getLatestTickers() on a 1000ms TTL -- same listener
  // pattern as src/core/pyth-timeout-monitor.js. This is a single persistent listener registered
  // once at module load (mirrors that file), not a per-call subscribe/unsubscribe like
  // src/core/feeds/feed-adapters.js uses.
  let _pythPushCache = { prices: null, updatedAt: 0 };
  if (typeof window !== 'undefined' && window.pythLazer?.onTickers) {
    window.pythLazer.onTickers((prices) => {
      _pythPushCache = { prices, updatedAt: Date.now() };
    });
  }

  async function loadPythRealtimeSnapshot(maxAgeMs) {
    const now = Date.now();
    // Push-driven fast path -- no IPC round-trip once at least one tick has arrived.
    if (_pythPushCache.prices && now - _pythPushCache.updatedAt <= maxAgeMs) {
      return _pythPushCache.prices;
    }
    if (_pythRealtimeSnapshot.prices && now - _pythRealtimeSnapshot.fetchedAt <= 1_000) {
      return _pythRealtimeSnapshot.prices;
    }
    if (_pythRealtimeSnapshot.inFlight) return _pythRealtimeSnapshot.inFlight;

    // Pull-based fallback: only reached before the first push arrives (e.g. right after load).
    _pythRealtimeSnapshot.inFlight = (async () => {
      let prices = await window.pythLazer?.getLatestTickers?.();
      const hasFreshCache = Object.values(prices || {}).some(ticker => {
        const timestamp = toPositiveFiniteNumber(ticker?.timestamp);
        return timestamp != null && now - timestamp >= 0 && now - timestamp <= maxAgeMs;
      });

      if (!hasFreshCache && window.pythLazer?.getProxyLatest) {
        const feedIds = Object.values(PYTH_LAZER_PRICE_FEED_IDS);
        const proxyResult = await withTimeout(
          window.pythLazer.getProxyLatest(feedIds),
          2_500,
          'Pyth Lazer latest price'
        ).catch(() => null);
        if (proxyResult?.success && Array.isArray(proxyResult.prices)) {
          prices = Object.fromEntries(proxyResult.prices.map(ticker => [
            ticker.instrument_name,
            {
              last: ticker.last,
              timestamp: Date.now(),
              source: 'pyth-lazer-proxy',
            },
          ]));
        }
      }

      _pythRealtimeSnapshot.prices = prices || {};
      _pythRealtimeSnapshot.fetchedAt = Date.now();
      return _pythRealtimeSnapshot.prices;
    })().finally(() => { _pythRealtimeSnapshot.inFlight = null; });

    return _pythRealtimeSnapshot.inFlight;
  }

  async function getFreshPythLazerPrice(sym, maxAgeMs = 5_000) {
    const snapshot = await loadPythRealtimeSnapshot(maxAgeMs);
    const ticker = snapshot?.[`${sym}USD`];
    let price = toPositiveFiniteNumber(ticker?.last);
    let timestamp = toPositiveFiniteNumber(ticker?.timestamp);
    let source = ticker?.source || 'pyth-lazer';

    if (price == null && typeof window !== 'undefined' && window._pythPrices?.[sym]) {
      const p = window._pythPrices[sym];
      const val = typeof p === 'number' ? p : p?.price;
      if (val != null && Number.isFinite(val) && val > 0) {
        price = val;
        timestamp = window._pythPythMetadata?.[sym]?.publishTime || Date.now();
        source = 'pyth-hermes-v2';
      }
    }

    if (price == null || timestamp == null) {
      if (typeof window !== 'undefined' && window._pythPrices?.[sym]) {
        const val = typeof window._pythPrices[sym] === 'number' ? window._pythPrices[sym] : window._pythPrices[sym]?.price;
        if (val != null && Number.isFinite(val) && val > 0) {
          const ts = Date.now();
          return { price: val, timestamp: ts, ageMs: 0, source: 'pyth-hermes-v2', filteredPrice: _filteredPythPrice(sym, val, ts) };
        }
      }
      return null;
    }
    const ageMs = Date.now() - timestamp;
    if (ageMs < 0 || ageMs > maxAgeMs) {
      if (typeof window !== 'undefined' && window._pythPrices?.[sym]) {
        const val = typeof window._pythPrices[sym] === 'number' ? window._pythPrices[sym] : window._pythPrices[sym]?.price;
        if (val != null && Number.isFinite(val) && val > 0) {
          const ts = Date.now();
          return { price: val, timestamp: ts, ageMs: 0, source: 'pyth-hermes-v2-fallback', filteredPrice: _filteredPythPrice(sym, val, ts) };
        }
      }
      return null;
    }
    return { price, timestamp, ageMs, source, filteredPrice: _filteredPythPrice(sym, price, timestamp) };
  }


  function deriveAskFromReciprocal(directAsk, opposingBid) {
    const ask = toFiniteProbability(directAsk);
    if (ask != null && ask > 0) return ask;
    const oppBid = toFiniteProbability(opposingBid);
    if (oppBid == null) return null;
    return toFiniteProbability(1 - oppBid);
  }

  function resolveKalshiQuote(raw = {}) {
    const yesBid = toFiniteProbability(raw.yes_bid_dollars ?? raw.yes_bid);
    const noBid = toFiniteProbability(raw.no_bid_dollars ?? raw.no_bid);
    const yesAsk = deriveAskFromReciprocal(raw.yes_ask_dollars ?? raw.yes_ask, noBid);
    const noAsk = deriveAskFromReciprocal(raw.no_ask_dollars ?? raw.no_ask, yesBid);
    const last = toFiniteProbability(raw.last_price_dollars ?? raw.last_traded_price ?? raw.last_traded);

    let probability = null;
    if (yesAsk != null && yesBid != null && yesAsk > 0 && yesBid > 0) probability = (yesAsk + yesBid) / 2;
    else if (yesAsk != null && yesAsk > 0) probability = yesAsk;
    else if (yesBid != null && yesBid > 0) probability = yesBid;
    else if (noAsk != null && noBid != null && noAsk > 0 && noBid > 0) probability = 1 - (noAsk + noBid) / 2;
    else if (last != null && last > 0) probability = last;

    if (probability != null) {
      probability = Math.min(0.99, Math.max(0.01, probability));
    }

    return { yesAsk, yesBid, noAsk, noBid, last, probability };
  }

  function applyWsTickerToContract(contract) {
    if (!contract?.ticker || !window.KalshiWS?.getSnapshot) return contract;
    const tick = window.KalshiWS.getSnapshot().tickers?.[contract.ticker];
    if (!tick || Date.now() - (tick.ts || 0) > 45_000) return contract;

    const { yesAsk, yesBid, noAsk, noBid, last, probability: wsProbability } = resolveKalshiQuote(tick);
    const probability = wsProbability != null ? wsProbability : contract.probability;

    return {
      ...contract,
      probability,
      yesAsk: yesAsk ?? contract.yesAsk,
      yesBid: yesBid ?? contract.yesBid,
      noAsk: noAsk ?? contract.noAsk,
      noBid: noBid ?? contract.noBid,
      last: last ?? contract.last,
      _liveTransport: 'wss',
    };
  }

  function toMs(ts) {
    const n = new Date(ts).getTime();
    return Number.isFinite(n) ? n : null;
  }

  function ceilToBucket(ms, bucketMs) {
    return Math.ceil(ms / bucketMs) * bucketMs;
  }

  function isQuarterHourClose(ms) {
    const d = new Date(ms);
    const m = d.getUTCMinutes();
    return m === 0 || m === 15 || m === 30 || m === 45;
  }

  function selectKalshiContract(markets, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const bucketMs = Number.isFinite(options.bucketMs) ? options.bucketMs : BUCKET_MS_15M;
    const minTradableMs = Number.isFinite(options.minTradableMs) ? options.minTradableMs : 30_000;
    const strictQuarterHour = !!options.strictQuarterHour;
    const targetCloseMs = ceilToBucket(nowMs + minTradableMs, bucketMs);

    const eligible = (Array.isArray(markets) ? markets : [])
      .map(mk => ({ mk, closeMs: toMs(mk?.close_time) }))
      .filter(x => x.closeMs != null && x.closeMs > nowMs + minTradableMs);

    if (!eligible.length) return null;

    const strictPool = strictQuarterHour
      ? eligible.filter(x => isQuarterHourClose(x.closeMs))
      : eligible;

    const pool = strictPool.length ? strictPool : eligible;

    pool.sort((a, b) => {
      const da = Math.abs(a.closeMs - targetCloseMs);
      const db = Math.abs(b.closeMs - targetCloseMs);
      if (da !== db) return da - db;

      const liqA = parseFloat(a.mk?.liquidity_dollars || 0) || 0;
      const liqB = parseFloat(b.mk?.liquidity_dollars || 0) || 0;
      if (liqA !== liqB) return liqB - liqA;

      const volA = parseFloat(a.mk?.volume_fp || 0) || 0;
      const volB = parseFloat(b.mk?.volume_fp || 0) || 0;
      if (volA !== volB) return volB - volA;

      return a.closeMs - b.closeMs;
    });

    return pool[0].mk;
  }

  function buildKalshiContractData(m, extra = {}) {
    const { yesAsk, yesBid, noAsk, noBid, last, probability } = resolveKalshiQuote(m);

    const floorStrike = m.floor_strike != null ? parseFloat(m.floor_strike) : null;
    const floorPriceRaw = m.floor_price != null ? parseFloat(m.floor_price) : null;
    const floorPrice = (Number.isFinite(floorStrike) && floorStrike > 0) ? floorStrike
      : (Number.isFinite(floorPriceRaw) && floorPriceRaw > 0) ? floorPriceRaw : null;
    const capStrike = m.cap_strike != null ? parseFloat(m.cap_strike) : null;
    const capPriceRaw = m.cap_price != null ? parseFloat(m.cap_price) : null;
    const capPrice = (Number.isFinite(capStrike) && capStrike > 0) ? capStrike
      : (Number.isFinite(capPriceRaw) && capPriceRaw > 0) ? capPriceRaw : null;
    const rawStrike = m.strike_type ? String(m.strike_type).toLowerCase() : null;
    const subtitle = (m.yes_sub_title || m.subtitle || '');

    let strikeDir = null;
    if (rawStrike) {
      if (rawStrike === 'below' || rawStrike === 'under') strikeDir = 'below';
      else if (rawStrike === 'above' || rawStrike === 'over' || rawStrike === 'at_least' || rawStrike === 'greater_or_equal') strikeDir = 'above';
    }
    if (!strikeDir) {
      const sub = subtitle.toLowerCase();
      strikeDir = (sub.includes('below') || sub.includes('under')) ? 'below' : 'above';
    }

    let targetPriceNum = (Number.isFinite(floorPrice) && floorPrice > 0) ? floorPrice : null;
    if (targetPriceNum == null) {
      const numMatch = subtitle.replace(/[$,]/g, '').match(/\d+\.?\d*/);
      if (numMatch) targetPriceNum = parseFloat(numMatch[0]);
    }
    const targetSym = extra.sym || m.ticker || '';
    const targetPrice = targetPriceNum != null
      ? (window.CoinPrecision?.formatCoinStrike
          ? window.CoinPrecision.formatCoinStrike(targetSym, targetPriceNum)
          : _formatPolyPriceToBeat(targetPriceNum, targetSym))
      : null;


    return {
      probability, yesAsk, yesBid, noAsk, noBid, last,
      status: m.status,
      closeTime: m.close_time,
      openTime: m.open_time,
      ticker: m.ticker,
      title: m.title,
      subtitle,
      strikeDir,
      strikeType: rawStrike,
      floorPrice,
      capPrice,
      targetPrice,
      targetPriceNum,
      volume: Number(m.volume_fp || 0) || 0,
      liquidity: Number(m.liquidity_dollars || 0) || 0,
      openInterest: Number(m.open_interest_fp || 0) || 0,
      ...extra,
    };
  }

  // ---- Generic Kalshi series fetch ------------------------------------
  // Used for both 15M and 5M series â€” pass a windowMin for the fallback search.

  async function fetchKalshiSeriesForSym(series, opts = {}) {
    const suppressWarnings = !!opts.suppressWarnings;
    const bucketMs = Number.isFinite(opts.bucketMs)
      ? opts.bucketMs
      : (String(series).endsWith('15M') ? BUCKET_MS_15M : BUCKET_MS_5M);
    const minTradableMs = Number.isFinite(opts.minTradableMs)
      ? opts.minTradableMs
      : (bucketMs === BUCKET_MS_15M ? MIN_TRADABLE_MS_15M : MIN_TRADABLE_MS_5M);
    const strictQuarterHour = !!opts.strictQuarterHour;

    let d = await kalshiFetch(`${KALSHI_BASE}/markets?series_ticker=${series}&status=open&limit=${KALSHI_MARKET_LIMIT}`);
    if (!d) {
      if (!suppressWarnings) {
        console.warn(`[PredictionMarkets] No data returned from Kalshi for series ${series}`);
      }
      return null;
    }

    const markets = d?.markets || [];
    let nearClose = false;
    let m = selectKalshiContract(markets, {
      nowMs: Date.now(),
      bucketMs,
      minTradableMs,
      strictQuarterHour,
    });
    if (!m && opts.allowNearExpiry !== false && markets.length) {
      m = selectKalshiContract(markets, {
        nowMs: Date.now(),
        bucketMs,
        minTradableMs: 0,
        strictQuarterHour,
      });
      nearClose = !!m;
    }
    if (!m) {
      const nowMs = Date.now();
      const msUntilClose = bucketMs - (nowMs % bucketMs);
      const inRolloverDeadband = markets.length > 0 && msUntilClose <= (minTradableMs + 15000);

      if (!suppressWarnings && !inRolloverDeadband) {
        console.warn(`[PredictionMarkets] No open markets found for series ${series}. Markets available: ${markets.length}`);
      }
      return null;
    }

    const built = buildKalshiContractData(m, nearClose ? { tradable: false, nearClose: true } : { tradable: true });
    return applyWsTickerToContract(built);
  }

  // ---- Kalshi 15M -----------------------------------------------------

  // User no longer trades Kalshi. Rather than delete the large surface of
  // code across this file and its many downstream consumers (app-init,
  // observability, crash-analysis, quant-layer, etc.) that read Kalshi
  // fields defensively (kalshi15m/kalshi5m stay null, combinedProb already
  // falls back to Polymarket-only -- see below), kill it at the source: no
  // network calls are made, so every consumer just sees "no Kalshi data",
  // which they already handle. Flip to re-enable.
  async function fetchKalshi15M() {
    if (KALSHI_DISABLED) return {};
    const result = {};
    const coins = Object.keys(KALSHI_15M_SERIES);
    for (let i = 0; i < coins.length; i++) {
      const sym = coins[i];
      const series = KALSHI_15M_SERIES[sym];
      result[sym] = await fetchKalshiSeriesForSym(series, {
        bucketMs: BUCKET_MS_15M,
        minTradableMs: MIN_TRADABLE_MS_15M,
        strictQuarterHour: true,
      });
    }

    if (_quarterDebugTicksRemaining > 0) {
      const nowMs = Date.now();
      const debugRow = coins.map(sym => {
        const c = result[sym];
        const closeMs = c?.closeTime ? new Date(c.closeTime).getTime() : null;
        if (!Number.isFinite(closeMs)) return `${sym}:none`;
        const minute = new Date(closeMs).getUTCMinutes();
        const second = new Date(closeMs).getUTCSeconds();
        const isCanon = minute === 0 || minute === 15 || minute === 30 || minute === 45;
        const ttc = Math.max(0, Math.floor((closeMs - nowMs) / 1000));
        return `${sym}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')} canon=${isCanon ? 'Y' : 'N'} ttc=${ttc}s ${c?.ticker || 'no-ticker'}`;
      }).join(' | ');
      console.log(`[PredictionMarkets][Q15-VERIFY] ${debugRow}`);
      _quarterDebugTicksRemaining--;
      if (_quarterDebugTicksRemaining === 0) {
        console.log('[PredictionMarkets][Q15-VERIFY] Session debug logging complete; auto-disabled');
      }
    }

    return result;
  }

  // ---- Kalshi 5M — covers all 7 coins; dedicated 5M series tried first,
  // falls back to nearest-expiry 15M market as real-time proxy ----

  async function fetchKalshi5M() {
    if (KALSHI_DISABLED) return {};
    const result = {};
    const coins = Object.keys(KALSHI_15M_SERIES);
    // Space series calls so we don't trip Kalshi 429 (7 coins × multi-transport was a storm)
    const gapMs = () => (_rateLimitUntil > Date.now() ? 0 : 350);
    for (let i = 0; i < coins.length; i++) {
      if (_rateLimitUntil > Date.now()) {
        // Cool-down active — stop the series loop; keep prior cache if any
        break;
      }
      const sym = coins[i];

      // Kalshi has no 5-minute crypto series. Verified against their API: KXBTC5M and
      // KXETH5M return 404 not_found, while KXBTC15M / KXETH15M return 200. The old
      // code queried the 5M tickers on every refresh (guaranteed 404s) and then, when
      // that failed, substituted the strict 15M quarter-hour contract as a "5M proxy" —
      // presenting a 15-minute market as a 5-minute one. That is the same substitute-a
      // -plausible-value mistake that made the price-to-beat wrong for months.
      // There is no 5m Kalshi market, so report none.
      result[sym] = null;
      if (i < coins.length - 1 && gapMs() > 0) {
        await new Promise(r => setTimeout(r, gapMs()));
      }
    }
    return result;
  }

  // ---- Snipe detection: contracts closing within 5 min with strong bias ----
  const SNIPE_WINDOW_MS = 5 * 60_000;
  const SNIPE_THRESHOLD = 0.65;

  function detectSnipes(c) {
    const snipes = [];
    const now = Date.now();
    for (const [sym, data] of Object.entries(c)) {
      for (const [label, market] of [['Kalshi 15M', data?.kalshi15m], ['Kalshi 5M', data?.kalshi5m]]) {
        if (!market?.closeTime || market.probability == null) continue;
        const ms = new Date(market.closeTime).getTime() - now;
        if (ms <= 0 || ms > SNIPE_WINDOW_MS) continue;
        const p = market.probability;
        const dir = p >= SNIPE_THRESHOLD ? 'UP' : p <= (1 - SNIPE_THRESHOLD) ? 'DOWN' : null;
        if (!dir) continue;
        snipes.push({ sym, dir, prob: p, ms, label: market._proxy15m ? 'Kalshi Nearest' : label, ticker: market.ticker, targetPrice: market.targetPrice });
      }
    }
    return snipes.sort((a, b) => a.ms - b.ms);
  }

  // ---- Probability velocity tracker -----------------------------------
  // Records each new Kalshi YES probability reading (deduped by change + time).
  // Linear regression over the rolling window gives Â¢/min velocity â€” i.e. how
  // fast Kalshi's implied probability is drifting. Positive = bullish pressure.
  function trackProbability(sym, prob) {
    if (prob == null) return;
    if (!_probHistory[sym]) _probHistory[sym] = [];
    const hist = _probHistory[sym];
    const last = hist[hist.length - 1];
    // Require >0.3Â¢ change OR >15s elapsed since last reading
    if (last && Math.abs(last.prob - prob) < 0.003 && Date.now() - last.ts < 15_000) return;
    hist.push({ prob, ts: Date.now() });
    if (hist.length > PROB_HIST_MAX) hist.shift();
  }

  function getProbVelocity(sym) {
    const hist = _probHistory[sym];
    const latestProb = hist?.[hist.length - 1]?.prob ?? null;
    if (!hist || hist.length < 3) {
      return { velocity: 0, velCentsPerMin: 0, acceleration: 0, trend: 'flat', samples: hist?.length || 0, latestProb };
    }
    const n = hist.length;
    // Linear regression: x = seconds elapsed since first sample, y = prob
    const t0 = hist[0].ts;
    const xs = hist.map(h => (h.ts - t0) / 1000);
    const ys = hist.map(h => h.prob);
    const xMean = xs.reduce((a, b) => a + b) / n;
    const yMean = ys.reduce((a, b) => a + b) / n;
    const num = xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0);
    const den = xs.reduce((s, x) => s + (x - xMean) ** 2, 0);
    const slope = den > 0 ? num / den : 0; // prob per second
    const velCentsPerMin = slope * 60 * 100; // â†’ Â¢/min

    // Acceleration: velocity of 2nd half vs 1st half
    const compHalfVel = (half) => {
      if (half.length < 2) return 0;
      const dProb = half[half.length - 1].prob - half[0].prob;
      const dSec = (half[half.length - 1].ts - half[0].ts) / 1000;
      return dSec > 0 ? dProb / dSec * 60 * 100 : 0;
    };
    const mid = Math.floor(n / 2);
    const acceleration = compHalfVel(hist.slice(mid)) - compHalfVel(hist.slice(0, mid));

    const trend = velCentsPerMin >= 1.5 ? 'rising' : velCentsPerMin <= -1.5 ? 'falling' : 'flat';
    return {
      velocity: slope,
      velCentsPerMin: +velCentsPerMin.toFixed(2),
      acceleration: +acceleration.toFixed(2),
      trend,
      samples: n,
      latestProb,
    };
  }

    // ---- Polymarket ΓÇö paginated, all crypto markets, suppFetch-routed ----
  // Fetches active Gamma pages sorted by 24h volume. Gamma currently caps pages
  // at 100 rows even when a larger limit is requested, so offsets must step by
  // 100 or the app skips most of the market list.
  // Falls back to CLOB API if Gamma is unreachable.

  async function fetchPolymarket() {
    // ---- Tier 1: Gamma API (paginated, sort by volume) ----
    try {
      const pageSize = 100;
      const offsets = Array.from({ length: 16 }, (_, i) => i * pageSize);
      let gammaErrors = 0;
      const pages = await Promise.all(offsets.map(offset =>
        apiFetch(`${POLY_GAMMA}/markets?active=true&closed=false&limit=${pageSize}&offset=${offset}&order=volume24hr&ascending=false`)
          .catch(err => {
            gammaErrors++;
            if (gammaErrors <= 2) console.warn(`[PredictionMarkets] Gamma page offset=${offset} failed:`, err?.message || err);
            return null;
          })
      ));
      const all = [];
      for (const d of pages) {
        if (!d) continue;
        const batch = Array.isArray(d) ? d : Array.isArray(d.results) ? d.results : [];
        all.push(...batch);
      }
      console.log(`[PredictionMarkets] Gamma results: ${all.length} markets from ${pages.filter(p => p !== null).length}/16 pages (${gammaErrors} failed)`);
      if (all.length) {
        const seen = new Set();
        const markets = all.filter(m => {
          const key = m.id || m.conditionId || m.question || m.slug;
          if (!key) return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        _polyLastFetch = Date.now();
        _polyLastError = '';
        _polyLastSource = 'gamma';
        return markets;
      }
      _polyLastError = 'Gamma returned no active markets';
    } catch (err) {
      _polyLastError = err?.message || String(err);
      console.warn('[PredictionMarkets] Gamma fetch failed:', _polyLastError);
    }

    // ---- Tier 2: IPC CLOB SDK (authenticated, paginated) ----
    try {
      if (window.electron && window.electron.invoke) {
        const allMarkets = [];
        let cursor = '';
        for (let i = 0; i < 10; i++) {
          const res = await window.electron.invoke('poly:getMarkets', cursor);
          if (res && res.error) break;
          if (res && res.data && Array.isArray(res.data)) {
            allMarkets.push(...res.data);
            if (!res.next_cursor || res.next_cursor === 'LTE=') break;
            cursor = res.next_cursor;
          } else if (Array.isArray(res) && res.length) {
            allMarkets.push(...res);
            break;
          } else {
            break;
          }
        }
        if (allMarkets.length > 0) {
          const seen = new Set();
          const markets = allMarkets.filter(m => {
            const key = m.condition_id || m.market_slug || m.question;
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          _polyLastFetch = Date.now();
          _polyLastError = '';
          _polyLastSource = 'clob-ipc';
          return markets;
        }
      }
    } catch (err) {
      _polyLastError = err?.message || String(err);
      console.warn('[PredictionMarkets] poly:getMarkets IPC fetch failed:', _polyLastError);
    }

    // ---- Tier 3: Direct CLOB API (unauthenticated) ----
    try {
      const d2 = await apiFetch(`${POLY_CLOB}/markets?active=true&limit=500`);
      const markets = Array.isArray(d2) ? d2 : Array.isArray(d2.data) ? d2.data : null;
      if (markets?.length) {
        _polyLastFetch = Date.now();
        _polyLastError = '';
        _polyLastSource = 'clob-http';
      } else {
        _polyLastError = _polyLastError || 'CLOB returned no active markets';
      }
      return markets;
    } catch (err) {
      _polyLastError = err?.message || _polyLastError || 'Polymarket fetch failed';
      return null;
    }
  }

  // Keywords that indicate non-crypto political/social markets to exclude
  const POLY_BAD_KW = ['weinstein', 'biden', 'trump', 'ukraine', 'russia', 'election',
    'senate', 'house', 'president', 'gta', 'elon', 'musk', 'harvey', 'ceasefire',
    'tariff', 'nato', 'congress', 'supreme court'];

  // Parse YES probability from a single Gamma API market object
  function _parseYesProb(m) {
    let prices = m.outcomePrices;
    if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { return null; } }
    if (!Array.isArray(prices) || !prices[0]) return null;
    let yesIndex = 0;
    let outcomes = m.outcomes;
    if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; } }
    if (Array.isArray(outcomes)) {
      const idx = outcomes.findIndex(o => String(o || '').trim().toLowerCase() === 'yes');
      if (idx >= 0) yesIndex = idx;
    }
    const yes = parseFloat(prices[yesIndex]);
    return Number.isFinite(yes) && yes >= 0.01 && yes <= 0.99 ? yes : null;
  }

  function _parseUpProb(m) {
    let prices = m.outcomePrices;
    if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { return null; } }
    if (!Array.isArray(prices) || !prices.length) return null;
    let upIndex = 0;
    let outcomes = m.outcomes;
    if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; } }
    if (Array.isArray(outcomes)) {
      const idx = outcomes.findIndex(o => String(o || '').trim().toLowerCase() === 'up');
      if (idx >= 0) upIndex = idx;
    }
    const up = parseFloat(prices[upIndex]);
    return Number.isFinite(up) && up >= 0.01 && up <= 0.99 ? up : null;
  }

  function _extractPolyMarketArray(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.markets)) return result.markets;
    if (Array.isArray(result?.results)) return result.results;
    if (Array.isArray(result?.data)) return result.data;
    return [];
  }

  function _extractPolyEventArray(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.events)) return result.events;
    if (Array.isArray(result?.results)) return result.results;
    if (Array.isArray(result?.data)) return result.data;
    return [];
  }

  function _safeJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function _polyOutcomeIndex(m, outcomeName, fallback = 0) {
    const outcomes = _safeJsonArray(m?.outcomes);
    const idx = outcomes.findIndex(o => String(o || '').trim().toLowerCase() === outcomeName);
    return idx >= 0 ? idx : fallback;
  }

  function _polyClobTokenIds(m) {
    return _safeJsonArray(m?.clobTokenIds)
      .map(v => String(v || '').trim())
      .filter(Boolean);
  }

  function _coercePolyMarketFromEvent(event, expectedSlug) {
    if (!event || typeof event !== 'object') return null;
    const markets = Array.isArray(event.markets) ? event.markets : [];
    let market = markets.find(m => (m?.slug || m?.market_slug) === expectedSlug && _isTradablePoly5M(m));
    if (!market) return null;
    const clobTokenIds = _polyClobTokenIds(market);
    const eventMetadata = event.eventMetadata || event.event_metadata || null;
    const directPriceToBeat = toPositiveFiniteNumber(
      eventMetadata?.priceToBeat
      ?? eventMetadata?.price_to_beat
      ?? market.priceToBeat
      ?? market.price_to_beat
      ?? market.targetPrice
      ?? market.target_price
    );
    return {
      ...market,
      slug: market.slug || market.market_slug || event.slug || expectedSlug,
      question: market.question || event.title,
      endDate: market.endDate || market.endDateIso || event.endDate || event.end_date || null,
      eventStartTime: market.eventStartTime || event.startTime || event.startDate || null,
      conditionId: market.conditionId || market.condition_id || null,
      questionID: market.questionID || market.question_id || null,
      clobTokenIds: clobTokenIds.length ? JSON.stringify(clobTokenIds) : (market.clobTokenIds || null),
      yesTokenId: clobTokenIds[_polyOutcomeIndex(market, 'up', 0)] || clobTokenIds[0] || null,
      noTokenId: clobTokenIds[_polyOutcomeIndex(market, 'down', 1)] || clobTokenIds[1] || null,
      marketId: market.id || null,
      eventId: event.id || null,
      eventMetadata,
      priceToBeat: directPriceToBeat,
      priceToBeatNum: directPriceToBeat,
      price_to_beat: directPriceToBeat,
      events: market.events || [{
        id: event.id,
        slug: event.slug,
        title: event.title,
        startTime: event.startTime || event.startDate || null,
        endDate: event.endDate || null,
        eventMetadata,
      }],
      _eventFallback: {
        id: event.id,
        slug: event.slug,
        title: event.title,
        eventMetadata,
      },
    };
  }

  async function fetchPolymarket5MEventBySlug(slug) {
    if (!slug) return null;
    try {
      const result = await apiFetch(`${POLY_GAMMA}/events?closed=false&active=true&slug=${encodeURIComponent(slug)}`);
      const events = _extractPolyEventArray(result);
      for (const event of events) {
        if ((event?.slug || event?.ticker) !== slug) continue;
        const market = _coercePolyMarketFromEvent(event, slug);
        if (market) return { market, source: 'gamma-events-slug', fallbackJustification: POLY_5M_FALLBACK_JUSTIFICATION };
      }
    } catch (err) {
      console.warn(`[PredictionMarkets] Poly5M event slug fallback failed for ${slug}:`, err?.message || err);
    }
    return null;
  }

  async function fetchPolymarketActiveEventsFallback() {
    const now = Date.now();
    if (_poly5mEventScanCache.events.length && now - _poly5mEventScanCache.fetchedAt < 15_000) {
      return _poly5mEventScanCache;
    }

    const events = [];
    const sources = [];
    const errors = [];
    await Promise.all(POLY_GAMMA_ACTIVE_EVENTS_FALLBACKS.map(async ({ tagId, source }) => {
      try {
        const result = await apiFetch(`${POLY_GAMMA}/events?closed=false&active=true&tag_id=${tagId}&limit=100`);
        const batch = _extractPolyEventArray(result);
        if (batch.length) {
          events.push(...batch);
          sources.push(source);
        }
      } catch (err) {
        errors.push(`${source}: ${err?.message || err}`);
      }
    }));

    const seen = new Set();
    const deduped = events.filter(event => {
      const key = event?.id || event?.slug || event?.ticker || event?.title;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    _poly5mEventScanCache = {
      fetchedAt: now,
      events: deduped,
      source: sources.join(',') || 'gamma-events-scan',
      error: errors.join(' | '),
    };
    return _poly5mEventScanCache;
  }

  async function fetchPolymarket5MActiveEventFallback(slug) {
    if (!slug) return null;
    const scan = await fetchPolymarketActiveEventsFallback();
    for (const event of scan.events) {
      if ((event?.slug || event?.ticker) !== slug) continue;
      const market = _coercePolyMarketFromEvent(event, slug);
      if (market) {
        return {
          market,
          source: scan.source || 'gamma-events-scan',
          fallbackJustification: POLY_5M_FALLBACK_JUSTIFICATION,
        };
      }
    }
    return null;
  }

  async function fetchPolymarket5MMarketCandidate(sym, slug) {
    try {
      const result = await apiFetch(`${POLY_GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
      const m = _extractPolyMarketArray(result).find(mk => (mk?.slug || mk?.market_slug) === slug && _isTradablePoly5M(mk));
      if (m) return { market: m, source: 'gamma-markets-slug', fallbackJustification: null };
    } catch (err) {
      console.warn(`[PredictionMarkets] Poly5M market slug fetch failed for ${sym} ${slug}:`, err?.message || err);
    }

    const eventHit = await fetchPolymarket5MEventBySlug(slug);
    if (eventHit) return eventHit;

    const activeEventHit = await fetchPolymarket5MActiveEventFallback(slug);
    if (activeEventHit) return activeEventHit;

    return null;
  }

  function _publishPolymarketClobTick(sym, market, payload) {
    try {
      window.DataLogger?.logPolymarket?.([{
        sym,
        type: 'poly5m-clob-tick',
        market: market?.conditionId || market?.condition_id || null,
        slug: market?.slug || market?.market_slug || null,
        payload,
      }]);
    } catch (_) {
      // Data logging must never block or destabilize market ingestion.
    }
  }

  // ── Shared CLOB consumer (PolymarketWS is the sole market-channel owner) ──
  // Maps assetId → { sym, market } for tick logging / pending resolution.
  const _polyClobAssetMeta = new Map();
  /** cacheKey → Array<{ resolve, timeoutId, upAssetId, downAssetId, conditionId, tokenIds }> */
  const _polyClobPending = new Map();
  let _polyClobBookListenerBound = false;

  function _polyWs() {
    return (typeof window !== 'undefined' && window.PolymarketWS) ? window.PolymarketWS : null;
  }

  function _ensurePolyWsBookListener() {
    if (_polyClobBookListenerBound || typeof window === 'undefined') return;
    _polyClobBookListenerBound = true;

    const onBookOrTick = (ev) => {
      const assetId = String(ev?.detail?.assetId || '');
      if (!assetId) return;
      const mapping = _polyClobAssetMeta.get(assetId);
      if (mapping) {
        _publishPolymarketClobTick(mapping.sym, mapping.market, ev.detail);
      }
      _resolvePolyClobPendingForAsset(assetId);
    };

    window.addEventListener('polymarket:book', onBookOrTick);
    window.addEventListener('polymarket:tick', onBookOrTick);

    // Batch 3 hook: surface market_resolved on the PredictionMarkets bus too.
    window.addEventListener('polymarket:market_resolved', (ev) => {
      try {
        window.dispatchEvent(new CustomEvent('predictionmarkets:market_resolved', {
          detail: ev?.detail || {},
        }));
      } catch (_) {}
    });
  }

  function _polyClobSubscribe(tokenIds, sym, market) {
    const ws = _polyWs();
    if (!ws) return;
    _ensurePolyWsBookListener();
    try { ws.start?.(); } catch (_) {}
    const ids = (tokenIds || []).map((id) => String(id || '').trim()).filter(Boolean);
    if (!ids.length) return;
    for (const id of ids) {
      if (sym && market) _polyClobAssetMeta.set(id, { sym, market });
    }
    ws.subscribeAssets(ids);
  }

  function _polyClobGetSnapshot(upAssetId, downAssetId, conditionId) {
    const ws = _polyWs();
    if (!ws) {
      return {
        upAssetId: upAssetId || null,
        downAssetId: downAssetId || null,
        conditionId: conditionId || null,
        bestBid: null,
        bestAsk: null,
        upProbability: null,
        downBestBid: null,
        downBestAsk: null,
        mid: null,
        spread: null,
        depthImbalance: null,
        nearTouchNotional: null,
        bids: [],
        asks: [],
        ts: Date.now(),
        source: 'polymarket-clob-ws',
      };
    }
    if (typeof ws.getPairSnapshot === 'function') {
      return ws.getPairSnapshot(upAssetId, downAssetId, conditionId);
    }
    if (typeof ws.getSnapshotValue === 'function') {
      return ws.getSnapshotValue(upAssetId, downAssetId, conditionId);
    }
    // Minimal fallback from getMarketState if older PolymarketWS is loaded.
    const up = ws.getMarketState?.(upAssetId) || {};
    const down = downAssetId ? (ws.getMarketState?.(downAssetId) || {}) : {};
    const upBid = Number(up.bestBid);
    const upAsk = Number(up.bestAsk);
    let upMid = null;
    if (Number.isFinite(upBid) && Number.isFinite(upAsk)) upMid = (upBid + upAsk) / 2;
    else if (Number.isFinite(upBid)) upMid = upBid;
    else if (Number.isFinite(upAsk)) upMid = upAsk;
    if (!Number.isFinite(upMid) || upMid <= 0 || upMid >= 1) upMid = null;
    return {
      upAssetId,
      downAssetId,
      conditionId,
      bestBid: Number.isFinite(upBid) ? upBid : null,
      bestAsk: Number.isFinite(upAsk) ? upAsk : null,
      upProbability: upMid,
      downBestBid: Number.isFinite(Number(down.bestBid)) ? Number(down.bestBid) : null,
      downBestAsk: Number.isFinite(Number(down.bestAsk)) ? Number(down.bestAsk) : null,
      mid: up.mid ?? upMid,
      spread: up.spread ?? null,
      depthImbalance: up.depthImbalance ?? null,
      nearTouchNotional: up.nearTouchNotional ?? null,
      bids: Array.isArray(up.bids) ? up.bids : [],
      asks: Array.isArray(up.asks) ? up.asks : [],
      ts: Number(up.updatedAt || Date.now()) || Date.now(),
      source: 'polymarket-clob-ws',
    };
  }

  function _polyClobSnapHasQuotes(snap) {
    return !!(snap && (
      snap.bestBid != null ||
      snap.bestAsk != null ||
      snap.upProbability != null ||
      (Array.isArray(snap.bids) && snap.bids.length) ||
      (Array.isArray(snap.asks) && snap.asks.length)
    ));
  }

  function _resolvePolyClobPendingForAsset(assetId) {
    if (!assetId || !_polyClobPending.size) return;
    for (const [cacheKey, reqs] of Array.from(_polyClobPending.entries())) {
      if (!reqs || !reqs.length) continue;
      const first = reqs[0];
      if (!first) continue;
      if (first.upAssetId !== assetId && first.downAssetId !== assetId) continue;
      const snap = _polyClobGetSnapshot(first.upAssetId, first.downAssetId, first.conditionId);
      if (_polyClobSnapHasQuotes(snap)) {
        _resolvePolyClobPending(cacheKey, snap);
      }
    }
  }

  function _resolvePolyClobPending(cacheKey, val) {
    const reqs = _polyClobPending.get(cacheKey);
    if (!reqs) return;
    _polyClobPending.delete(cacheKey);
    _poly5mClobSnapshotCache[cacheKey] = { value: val, fetchedAt: Date.now() };
    for (const req of reqs) {
      try { clearTimeout(req.timeoutId); } catch (_) {}
      try { req.resolve(val); } catch (_) {}
    }
  }

  /**
   * Live L2 snapshot for a binary market via shared PolymarketWS.
   * Returns bestBid/bestAsk/upProbability plus mid/spread/depthImbalance/
   * nearTouchNotional and capped bids/asks arrays.
   */
  async function fetchPolymarketClobMarketSnapshot(sym, market, timeoutMs = 900) {
    const tokenIds = _polyClobTokenIds(market);
    if (!tokenIds.length || typeof WebSocket === 'undefined') return null;
    const conditionId = market.conditionId || market.condition_id || market.market || market.id || tokenIds.join(':');
    const cacheKey = `${conditionId}:${tokenIds.join(',')}`;
    const cached = _poly5mClobSnapshotCache[cacheKey];
    if (cached?.inFlight) return cached.inFlight;
    if (cached?.value && Date.now() - cached.fetchedAt < 2_000) return cached.value;

    const upIndex = _polyOutcomeIndex(market, 'up', 0);
    const downIndex = upIndex === 0 ? 1 : 0;
    const upAssetId = tokenIds[upIndex] || tokenIds[0];
    const downAssetId = tokenIds[downIndex] || tokenIds[1] || null;

    _polyClobSubscribe(tokenIds, sym, market);

    const immediateSnap = _polyClobGetSnapshot(upAssetId, downAssetId, conditionId);
    if (_polyClobSnapHasQuotes(immediateSnap)) {
      const val = { ...immediateSnap };
      _poly5mClobSnapshotCache[cacheKey] = { value: val, fetchedAt: Date.now() };
      return val;
    }

    const promise = new Promise((resolve) => {
      const req = {
        resolve,
        tokenIds,
        upAssetId,
        downAssetId,
        conditionId,
        sym,
        market,
        timeoutId: null,
      };

      req.timeoutId = setTimeout(() => {
        const reqs = _polyClobPending.get(cacheKey) || [];
        const idx = reqs.indexOf(req);
        if (idx >= 0) {
          reqs.splice(idx, 1);
          if (reqs.length === 0) _polyClobPending.delete(cacheKey);
        }
        const finalSnap = _polyClobGetSnapshot(upAssetId, downAssetId, conditionId);
        _poly5mClobSnapshotCache[cacheKey] = { value: finalSnap, fetchedAt: Date.now() };
        resolve(finalSnap);
      }, timeoutMs);

      if (!_polyClobPending.has(cacheKey)) _polyClobPending.set(cacheKey, []);
      _polyClobPending.get(cacheKey).push(req);
    });

    _poly5mClobSnapshotCache[cacheKey] = {
      inFlight: promise,
      fetchedAt: Date.now(),
      value: cached?.value || null,
    };
    return promise;
  }

  /** Attach L2 micro-structure fields onto a poly5m / poly15m coin snapshot (backward compatible). */
  function _attachClobMicroFields(target, clobSnapshot, market) {
    if (!target) return target;
    const snap = clobSnapshot || null;
    target.bestBid = snap?.bestBid ?? target.bestBid ?? (parseFloat(market?.bestBid || market?.best_bid || 0) || null);
    target.bestAsk = snap?.bestAsk ?? target.bestAsk ?? (parseFloat(market?.bestAsk || market?.best_ask || 0) || null);
    // Micro features (Batch 2)
    target.mid = snap?.mid ?? target.mid ?? null;
    target.spread = snap?.spread ?? target.spread ?? null;
    target.depthImbalance = snap?.depthImbalance ?? target.depthImbalance ?? null;
    target.nearTouchNotional = snap?.nearTouchNotional ?? target.nearTouchNotional ?? null;
    target.nearTouchBidSize = snap?.nearTouchBidSize ?? target.nearTouchBidSize ?? null;
    target.nearTouchAskSize = snap?.nearTouchAskSize ?? target.nearTouchAskSize ?? null;
    target.bidDepthNotional = snap?.bidDepthNotional ?? target.bidDepthNotional ?? null;
    target.askDepthNotional = snap?.askDepthNotional ?? target.askDepthNotional ?? null;
    target.bids = Array.isArray(snap?.bids) ? snap.bids : (target.bids || []);
    target.asks = Array.isArray(snap?.asks) ? snap.asks : (target.asks || []);
    target.clobConditionId = snap?.conditionId || market?.conditionId || market?.condition_id || target.clobConditionId || null;
    target.clobTokenIds = market ? _polyClobTokenIds(market) : (target.clobTokenIds || []);
    target.clobUpAssetId = snap?.upAssetId || target.clobUpAssetId || null;
    target.clobDownAssetId = snap?.downAssetId || target.clobDownAssetId || null;
    target.clobSnapshotTs = snap?.ts || target.clobSnapshotTs || null;
    target.clobSource = snap?.source || target.clobSource || null;
    return target;
  }

  function _isTradablePoly5M(m, nowMs = Date.now()) {
    if (!m) return false;
    if (m.active === false || m.closed === true || m.archived === true) return false;
    if (m.acceptingOrders === false || m.accepting_orders === false) return false;
    const endRaw = m.endDate || m.end_date_iso || m.end_date || m.endDateIso || null;
    if (!endRaw) return true;
    const endMs = new Date(endRaw).getTime();
    return !Number.isFinite(endMs) || endMs > nowMs + 5_000;
  }

  let _poly5mCache = Object.create(null);
  let _poly5mPriceToBeatCache = Object.create(null);
  const _poly5mPriceToBeatLocks = new Map();
  let _poly5mEventScanCache = { fetchedAt: 0, events: [], source: '', error: '' };
  let _poly5mClobSnapshotCache = Object.create(null);
  // CLOB market WS lives in window.PolymarketWS — see fetchPolymarketClobMarketSnapshot.
  // Rotate whenever PTB validation semantics change so a previously accepted
  // benchmark cannot survive in localStorage and poison later sessions.
  // v6: dropped all live-price proxies (boundary snapshot / RTDS / crypto-price).
  // polycool.app is the source of truth — only the canonical Polymarket
  // priceToBeat (event page or gamma metadata) may ever be displayed as the PTB.
  // A live Chainlink/Pyth price sampled near window-open is NOT the contract PTB
  // and must never be substituted (that produced the "averaged" mismatch vs polycool).
  // v7: added the official Polymarket crypto-price microservice as a trusted source
  // (openPrice exact, prevClose provisional) and allowed an exact openPrice to upgrade
  // a provisional lock exactly once.
  // v8: REMOVED the crypto-price microservice. Measured against live windows it is
  // hourly-bucketed, not 5-minute: every 03:xx window returns the 03:00 open
  // (64820.01), every 02:xx returns 64861.46, changing only at the top of the hour.
  // That made the PTB correct for 1 window in 12 and up to ~$50 wrong for the rest
  // (observed: locked 64788.80 against an actual PTB of 64756).
  // These markets settle on the Chainlink BTC/USD TWAP-30s stream, which no spot or
  // OHLC feed reproduces, so an approximate source is worse than none: a wrong PTB
  // shown as [exact-contract] is actively traded on. Rotating the version also purges
  // the bad values already persisted in localStorage under the v7 key.
  // v9: trusted rtds-twap30 (boundary open proxy). Still not Polymarket's published
  // "Price to Beat" — AI/UI could quote a wrong number until event-page/candles arrived,
  // and the immutable lock blocked the real PTB for the whole window.
  // v10: ONLY Polymarket-published contract PTB may lock. RTDS TWAP / title / generic
  // field guesses may display as provisional but never lock and never go to AI as PTB.
  // v11: 5m/15m contracts now settle on Chainlink TWAP-60 (cryptoMarketConfig
  // twapLookbackSeconds=60). Purge v10 locks that used the 30s candle open.
  // v12: a single scrape from any one trusted source -- including Gamma's own
  // `priceToBeat` market-list field, which has been observed publishing before
  // the 60s TWAP window has actually settled -- is no longer enough to lock a
  // number for the whole contract (observed: BTC locked ~$50 off, ETH ~$1 off,
  // drifting wider as spot moved away from the wrong anchor for the rest of the
  // window). Locking now requires two independent reads, spaced
  // PTB_CONFIRM_MIN_GAP_MS apart, that agree within PTB_CONFIRM_TOLERANCE. See
  // _lockPolymarketPriceToBeat. Purge v11 locks, which could still lock on one read.
  // v14: Zero-delay PTB fallback and immediate locking for all Polymarket-native
  // sources (Gamma metadata, Chainlink open candle, RTDS TWAP stream, and event page).
  // Eliminates 30-45s latency at window open and purges stale v13 locks.
  // v15: v14's "immediate locking" locked on a SINGLE read with no confirmation --
  // silently reintroducing the exact bug v12 above was written to fix (wrong PTB
  // frozen for the whole window, observed losing real trades). Restored the
  // two-independent-reads confirmation gate in _lockPolymarketPriceToBeat using the
  // PTB_CONFIRM_* infrastructure that already existed but was never wired in.
  // Purges stale v14 locks, which could still lock on one read.
  const POLY5M_PTB_LOCK_VERSION = 15;
  // Polymarket 5m and 15m Up/Down contracts settle exclusively on Chainlink TWAP-60
  // Polymarket 5m / 15m / 60m Up/Down contracts settle on Chainlink TWAP-60 PATH vs locked open strike
  // (cryptoMarketConfig.twapLookbackSeconds = 60).
  // The contract Price-To-Beat (PTB) is an immutable variable sourced strictly from
  // Polymarket's published contract (event page or Gamma market metadata).
  // Zero external feeds, zero candles, and zero synthetic approximations are ever used.
  // Contract opening strike only. Chainlink/RTDS TWAP is the PATH compared
  // AGAINST this lock, never a replacement for it.
  const PRIMARY_LOCK_SOURCE = 'polymarket-contract';
  const PTB_CONFIRM_MIN_GAP_MS = 1_000;
  const PTB_CONFIRM_TOLERANCE = 0.01;
  const _pendingPtbReads = new Map();
  // Same two-read confirmation, but for an event-page value arriving AFTER a
  // non-authoritative lock is already in place -- keyed separately because
  // _pendingPtbReads is cleared the moment the first lock lands.
  const _pendingPtbCorrections = new Map();
  const PTB_CONFIRM_MAX_READS = 6;
  const POLY5M_PTB_TRUSTED_SOURCES = new Set([
    'polymarket-contract',
    'polymarket-event-page',
    'gamma-market',
    'gamma-market-metadata',
  ]);
  // The contract's own published benchmark, read straight off the slug's
  // Polymarket event page. This is the only source allowed to overwrite an
  // already-locked PTB: a candle/fallback lock is an approximation of the 60s
  // TWAP open and has been observed a few cents off the real contract number,
  // so when the event page later publishes the exact value it corrects the
  // lock exactly once (see the authoritative-upgrade path in
  // _lockPolymarketPriceToBeat). Everything else stays immutable-on-first-lock.
  const POLY5M_PTB_AUTHORITATIVE_SOURCES = new Set(['polymarket-event-page']);
  // Minimum gap (cents) between a non-authoritative lock and a later
  // event-page value before the app rewrites the lock. Below this it's TWAP
  // rounding noise, not an error, and not worth churning the lock/log.
  const PTB_CORRECTION_MIN_DELTA = 0.01;
  // Sources allowed on market objects for *display* only (never immutable lock / AI PTB)
  const POLY5M_PTB_PROVISIONAL_SOURCES = new Set([
    'polymarket-title',
    'gamma-market-field',
    'provisional',
  ]);

  /** Coin quote decimals: BTC/ETH/BNB/SOL/HYPE = 2 (cents); XRP/DOGE = 4. */
  function _priceDecimalsForSymbol(symbol = '', value) {
    if (typeof window !== 'undefined' && window.CoinPrecision?.getCoinDecimals) {
      return window.CoinPrecision.getCoinDecimals(symbol, value);
    }
    const s = String(symbol || '').toUpperCase();
    const m = s.match(/^(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)/);
    const sym = m ? m[1] : s.replace(/[^A-Z]/g, '').slice(0, 5);
    if (sym === 'BTC' || sym === 'ETH' || sym === 'BNB' || sym === 'SOL' || sym === 'HYPE') return 2;
    if (sym === 'XRP' || sym === 'DOGE') return 4;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && n < 1) return 4;
    return 2;
  }

  function _roundPriceForSymbol(value, symbol = '') {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const d = _priceDecimalsForSymbol(symbol, n);
    const f = 10 ** d;
    return Math.round(n * f) / f;
  }

  function _formatPolyPriceToBeat(value, symbol = '') {
    if (typeof window !== 'undefined' && window.CoinPrecision?.formatCoinStrike) {
      return window.CoinPrecision.formatCoinStrike(symbol, value);
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = _priceDecimalsForSymbol(symbol, n);
    const rounded = _roundPriceForSymbol(n, symbol);
    return `$${Number(rounded).toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
      useGrouping: true,
    })}`;
  }


  /**
   * Lock the contract opening strike for `slug` at T0. Immutable for the
   * life of the window: later Gamma, event-page, TWAP, or spot readings
   * cannot rewrite it. First trusted source wins.
   */
  function _lockPolymarketPriceToBeat(slug, value, source) {
    const price = toPositiveFiniteNumber(value);
    if (!slug || price == null || !POLY5M_PTB_TRUSTED_SOURCES.has(source)) return null;
    const now = Date.now();
    const existing = _poly5mPriceToBeatLocks.get(slug);
    if (existing) {
      // A locked PTB is immutable -- with one deliberate exception. A
      // candle/fallback lock is only an approximation of the 60s TWAP open and
      // has been observed a few cents off the contract's real benchmark. When
      // the slug's own Polymarket event page later publishes the exact value,
      // let it overwrite the lock ONCE, gated by the same two-read
      // confirmation as a first lock so a single bad scrape can't corrupt a
      // good number.
      const canCorrect =
        !existing.corrected &&
        !POLY5M_PTB_AUTHORITATIVE_SOURCES.has(existing.source) &&
        POLY5M_PTB_AUTHORITATIVE_SOURCES.has(source) &&
        Math.abs(existing.price - price) >= PTB_CORRECTION_MIN_DELTA;
      if (!canCorrect) return existing;

      const cReads = _pendingPtbCorrections.get(slug) || [];
      const cConfirming = cReads.find(r =>
        Math.abs(r.price - price) <= PTB_CONFIRM_TOLERANCE && (now - r.at) >= PTB_CONFIRM_MIN_GAP_MS
      );
      if (!cConfirming) {
        cReads.push({ price, at: now });
        if (cReads.length > PTB_CONFIRM_MAX_READS) cReads.shift();
        _pendingPtbCorrections.set(slug, cReads);
        return existing;
      }

      const corrected = Object.freeze({
        version: POLY5M_PTB_LOCK_VERSION,
        price,
        source,
        lockedAt: existing.lockedAt || now,
        correctedAt: now,
        corrected: true,
        priorPrice: existing.price,
        priorSource: existing.source,
      });
      _poly5mPriceToBeatLocks.set(slug, corrected);
      _pendingPtbCorrections.delete(slug);
      try {
        localStorage.setItem(`poly5m:ptb:v${POLY5M_PTB_LOCK_VERSION}:${slug}`, JSON.stringify(corrected));
      } catch (err) {
        console.warn(`[Poly5M-PTB] Could not persist corrected lock for ${slug}:`, err?.message || err);
      }
      // Low-extent error logging: exactly one line, and only when a correction
      // actually lands. Silent on the normal path.
      console.warn(
        `[Poly5M-PTB] PTB corrected ${slug}: ${existing.price} -> ${price} ` +
        `(delta ${((price - existing.price) * 100).toFixed(1)} cents) ` +
        `${existing.source} -> ${source}`
      );
      return corrected;
    }

    // Require a second independent read, taken at least PTB_CONFIRM_MIN_GAP_MS
    // after an earlier one and agreeing within PTB_CONFIRM_TOLERANCE, before
    // freezing a PTB for the whole window -- see the v12 changelog above (a
    // single scrape locked BTC ~$50 off / ETH ~$1 off, drifting wider as spot
    // moved away from the wrong anchor for the rest of the window). This
    // confirmation infrastructure (_pendingPtbReads / PTB_CONFIRM_*, also read
    // by the sweep in _tickPendingPtbLocks) was defined but never wired into
    // the lock path, so v14's "immediate locking" silently reintroduced the
    // exact single-read bug v12 was written to fix.
    const reads = _pendingPtbReads.get(slug) || [];
    const confirming = reads.find(r =>
      Math.abs(r.price - price) <= PTB_CONFIRM_TOLERANCE && (now - r.at) >= PTB_CONFIRM_MIN_GAP_MS
    );
    if (!confirming) {
      reads.push({ price, source, at: now });
      if (reads.length > PTB_CONFIRM_MAX_READS) reads.shift();
      _pendingPtbReads.set(slug, reads);
      
      // Safety valve: after PTB_CONFIRM_MAX_READS unconfirmed reads, lock the
      // latest one rather than leave PTB stuck on "pending" forever -- still a
      // Polymarket-native trusted source, just never independently confirmed.
      if (reads.length < PTB_CONFIRM_MAX_READS) return null;
    }
    const existingRace = _getPolymarketPriceToBeatLock(slug);
    if (existingRace) return existingRace;

    const locked = Object.freeze({
      version: POLY5M_PTB_LOCK_VERSION,
      price,
      source,
      lockedAt: now,
      // A lock that is already the contract's own event-page value has nothing
      // left to correct to -- mark it final so the retry/fetch paths stop.
      corrected: POLY5M_PTB_AUTHORITATIVE_SOURCES.has(source),
    });
    _poly5mPriceToBeatLocks.set(slug, locked);
    _pendingPtbReads.delete(slug);
    try { localStorage.setItem(`poly5m:ptb:v${POLY5M_PTB_LOCK_VERSION}:${slug}`, JSON.stringify(locked)); } catch (err) {
      console.warn(`[Poly5M-PTB] Could not persist immutable lock for ${slug}:`, err?.message || err);
    }
    return locked;
  }

  function _getPolymarketPriceToBeatLock(slug) {
    if (!slug) return null;
    const memoryLock = _poly5mPriceToBeatLocks.get(slug);
    if (memoryLock) return memoryLock;
    try {
      const storageKey = `poly5m:ptb:v${POLY5M_PTB_LOCK_VERSION}:${slug}`;
      const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
      const price = toPositiveFiniteNumber(stored?.price);
      if (stored?.version !== POLY5M_PTB_LOCK_VERSION || price == null || !POLY5M_PTB_TRUSTED_SOURCES.has(stored?.source)) {
        try { localStorage?.removeItem?.(storageKey); } catch (_) {}
        return null;
      }
      const lock = Object.freeze({
        version: POLY5M_PTB_LOCK_VERSION,
        price,
        source: stored.source,
        lockedAt: Number(stored.lockedAt) || 0,
        // Carry the one-shot correction flag across reloads so a restart can't
        // re-open an already-corrected (or already-authoritative) lock.
        corrected: !!stored.corrected || POLY5M_PTB_AUTHORITATIVE_SOURCES.has(stored.source),
        ...(stored.priorPrice != null ? { priorPrice: stored.priorPrice, priorSource: stored.priorSource } : {}),
      });
      _poly5mPriceToBeatLocks.set(slug, lock);
      return lock;
    } catch (err) {
      console.warn(`[Poly5M-PTB] Could not restore immutable lock for ${slug}:`, err?.message || err);
      return null;
    }
  }

  function _parsePolymarketPriceToBeat(html, slug) {
    if (!html || !slug) return null;
    let idx = html.indexOf(`"slug":"${slug}"`);
    if (idx === -1) idx = html.indexOf(`"ticker":"${slug}"`);
    if (idx !== -1) {
      const chunk = html.substring(idx, idx + 4000);
      const nextObjIdx = chunk.indexOf('{"id"');
      const validChunk = nextObjIdx !== -1 ? chunk.substring(0, nextObjIdx) : chunk;
      const ptbMatch = validChunk.match(/"priceToBeat":\s*([0-9.]+)/);
      const ptb = ptbMatch ? Number(ptbMatch[1]) : NaN;
      if (Number.isFinite(ptb) && ptb > 0) return ptb;
    }

    // Verified live (2026-08-09) against Polymarket's own dehydrated queryKey:
    // ["crypto-prices","price","BTC","<startIso>","fifteen","<endIso>",true,60]
    // -- the 15-minute horizon literal is "fifteen", NOT "fifteenminute"; naming
    // it by analogy with the 5-minute "fiveminute" would have been wrong.
    const slugMatch = slug.match(/^([a-z0-9-]+)-updown-(5m|15m|60m|1h)-(\d+)$/i);
    if (!slugMatch) return null;
    const querySymbols = {
      btc: 'BTC', bitcoin: 'BTC',
      eth: 'ETH', ethereum: 'ETH',
      sol: 'SOL', solana: 'SOL',
      doge: 'DOGE', dogecoin: 'DOGE',
      xrp: 'XRP', ripplexrp: 'XRP',
      hype: 'HYPE', hyperliquid: 'HYPE',
      bnb: 'BNB', binancecoin: 'BNB'
    };
    const querySymbol = querySymbols[slugMatch[1].toLowerCase()];
    const horizonTag = slugMatch[2].toLowerCase();
    const windowSec = horizonTag === '15m' ? 900 : (horizonTag === '60m' || horizonTag === '1h' ? 3600 : 300);
    const horizonLiteral = horizonTag === '15m' ? 'fifteen' : ((horizonTag === '60m' || horizonTag === '1h') ? 'hourly' : 'fiveminute');
    const startSec = Number(slugMatch[3]);
    if (!querySymbol || !Number.isFinite(startSec)) return null;

    const startIso = new Date(startSec * 1000).toISOString().split('.')[0] + 'Z';
    const endIso = new Date((startSec + windowSec) * 1000).toISOString().split('.')[0] + 'Z';

    // Polymarket Next.js RSC streaming payload contains dehydrated React-Query state entries.
    // We anchor on startIso (e.g. "2026-08-07T11:10:00Z") inside the crypto-prices query
    // entry to guarantee 100% precision for the exact 5-minute contract window.
    // The page serialises timestamps WITH milliseconds ("2026-08-09T11:35:00.000Z"),
    // so anchoring on the second-precision form alone never matched. And in the real
    // payload the shape is {"startTime":"...","endTime":"...","openPrice":N}, i.e.
    // openPrice follows the timestamp -- searching only the text before it missed it.
    // Try both timestamp formats and look on both sides of the anchor.
    // CRITICAL: anchor on "startTime":"<iso>" and never the bare timestamp. Each entry
    // is {"startTime":...,"endTime":...,"openPrice":N} and the PREVIOUS window's endTime
    // is identical to this window's startTime, so a bare match can land on the previous
    // entry and return its openPrice -- one window early, which is where the residual
    // ~10c came from.
    const startIsoMs = new Date(startSec * 1000).toISOString(); // with .000Z

    // Verified live (2026-08-10): Polymarket's own closed-window continuity
    // record is the most trustworthy scraped source available -- it's their
    // own resolved settlement value, not a live/approximate read. By TWAP
    // continuity a window's official open price equals the immediately
    // preceding window's official close price. Each closed-window entry has
    // the literal shape {"startTime":...,"endTime":...,"openPrice":N,
    // "closePrice":M,"outcome":...} -- find the entry whose endTime equals
    // THIS window's startTime, and read ITS closePrice (not the openPrice on
    // that same match, which belongs to the earlier window's own open).
    // This becomes available shortly after the preceding window closes, i.e.
    // almost immediately once our own window opens -- unlike the "openPrice"
    // anchor below, which only fires for an in-progress window if Polymarket
    // has separately embedded its own live query (verified unreliable).
    const endTimeAnchors = [];
    for (const iso of [startIsoMs, startIso]) {
      endTimeAnchors.push(`"endTime":"${iso}"`, `\\"endTime\\":\\"${iso}\\"`);
    }
    for (const anchor of endTimeAnchors) {
      let pos = 0;
      while ((pos = html.indexOf(anchor, pos)) !== -1) {
        const after = html.slice(pos, Math.min(html.length, pos + 300));
        const closeMatches = [
          ...after.matchAll(/\\"closePrice\\":\s*([0-9.]+)/g),
          ...after.matchAll(/"closePrice":\s*([0-9.]+)/g),
        ];
        if (closeMatches.length > 0) {
          const cp = Number(closeMatches[0][1]);
          if (Number.isFinite(cp) && cp > 0) return cp;
        }
        pos += anchor.length;
      }
    }

    const anchors = [];
    for (const iso of [startIsoMs, startIso]) {
      anchors.push(`"startTime":"${iso}"`, `\\"startTime\\":\\"${iso}\\"`);
    }
    for (const anchor of anchors) {
      let pos = 0;
      while ((pos = html.indexOf(anchor, pos)) !== -1) {
        const before = html.slice(Math.max(0, pos - 600), pos);
        const after = html.slice(pos, Math.min(html.length, pos + 600));

        // openPrice immediately after this window's startTime is the contract open.
        const fwd = [
          ...after.matchAll(/\\"openPrice\\":\s*([0-9.]+)/g),
          ...after.matchAll(/"openPrice":\s*([0-9.]+)/g),
        ];
        if (fwd.length > 0) {
          const op = Number(fwd[0][1]);
          if (Number.isFinite(op) && op > 0) return op;
        }

        if (before.includes('crypto-prices') || after.includes(horizonLiteral) || before.includes(horizonLiteral)) {
          const back = [
            ...before.matchAll(/\\"openPrice\\":\s*([0-9.]+)/g),
            ...before.matchAll(/"openPrice":\s*([0-9.]+)/g),
          ];
          if (back.length > 0) {
            const op = Number(back[back.length - 1][1]);
            if (Number.isFinite(op) && op > 0) return op;
          }
        }
        pos += anchor.length;
      }
    }

    // Attempt to extract the dehydratedState JSON from HTML (legacy unescaped page format)
    let stateJson = null;
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        stateJson = nextData.props?.pageProps?.dehydratedState;
      } catch (e) {
        console.warn(`[Poly5M-PTB] Failed to parse __NEXT_DATA__ for ${slug}:`, e.message);
      }
    }

    if (!stateJson) {
      const dqIdx = html.indexOf('"dehydratedState"');
      if (dqIdx !== -1) {
        const startScript = html.lastIndexOf('<script', dqIdx);
        const endScript = html.indexOf('</script>', dqIdx);
        if (startScript !== -1 && endScript !== -1) {
          const scriptText = html.substring(startScript, endScript + 9);
          const jsonStart = scriptText.indexOf('{');
          const jsonEnd = scriptText.lastIndexOf('}') + 1;
          if (jsonStart !== -1 && jsonEnd !== -1) {
            try {
              const parsed = JSON.parse(scriptText.substring(jsonStart, jsonEnd));
              stateJson = parsed.props?.pageProps?.dehydratedState || parsed.dehydratedState || parsed;
            } catch (e) {
              console.warn(`[Poly5M-PTB] Failed to parse dehydratedState script for ${slug}:`, e.message);
            }
          }
        }
      }
    }

    if (stateJson && Array.isArray(stateJson.queries)) {
      const normalizedStartIso = startIso.replace('.000Z', 'Z');
      const normalizedEndIso = endIso.replace('.000Z', 'Z');
      const normalizeIso = value => typeof value === 'string' ? value.replace('.000Z', 'Z') : '';

      // Prefer the contract's exact Chainlink opening-price query. Symbol-only
      // matching is unsafe because the page can hydrate adjacent windows.
      // Verified live (2026-08-09) this array shape is identical between 5m and
      // 15m -- only the horizon literal at index 4 differs ("fiveminute" vs
      // "fifteen").
      const openingPriceQuery = stateJson.queries.find(q => {
        const key = q.queryKey;
        return Array.isArray(key)
          && key[0] === 'crypto-prices'
          && key[1] === 'price'
          && key[2] === querySymbol
          && normalizeIso(key[3]) === normalizedStartIso
          && key[4] === horizonLiteral
          && normalizeIso(key[5]) === normalizedEndIso;
      });
      const exactOpenPrice = toPositiveFiniteNumber(openingPriceQuery?.state?.data?.openPrice);
      if (exactOpenPrice != null) return exactOpenPrice;

      // During the first moments of a window, the opening query may not yet be
      // populated. The immediately preceding Chainlink close is the identical
      // boundary, but accept it only when both query and row timestamps match.
      // Unlike the crypto-prices key above, this one's shape genuinely differs
      // per horizon -- verified live the 15m array carries an extra numeric
      // element between the horizon literal and the timestamp
      // (["past-results","BTC","fifteen",4,"<startIso>",...]) that the 5m array
      // does not have. Rather than hardcode either shape, just require the
      // horizon literal and the target timestamp to both appear somewhere in
      // the key, in order -- correct regardless of exactly which index the
      // timestamp lands at.
      const pastResultsQuery = stateJson.queries.find(q => {
        const key = q.queryKey;
        if (!Array.isArray(key) || key[0] !== 'past-results' || key[1] !== querySymbol) return false;
        const literalIdx = key.indexOf(horizonLiteral);
        if (literalIdx === -1) return false;
        return key.slice(literalIdx + 1).some(v => normalizeIso(v) === normalizedStartIso);
      });
      const pastResults = pastResultsQuery?.state?.data?.data?.results
        || pastResultsQuery?.state?.data?.results;
      const boundaryResult = Array.isArray(pastResults)
        ? pastResults.find(result => normalizeIso(result?.endTime) === normalizedStartIso)
        : null;
      const exactBoundaryClose = toPositiveFiniteNumber(boundaryResult?.closePrice);
      if (exactBoundaryClose != null) return exactBoundaryClose;
    }

    // Legacy page fallback: retain exact full query-key matching. Never use a
    // symbol-only or page-global price because future windows share this HTML.
    const queryKey = JSON.stringify(['crypto-prices', 'price', querySymbol, startIso, horizonLiteral, endIso]);
    const queryKeyIndex = html.indexOf(`"queryKey":${queryKey}`);
    if (queryKeyIndex !== -1) {
      // The state and data for this query key are located AFTER the queryKey in the JSON string.
      const chunk = html.substring(queryKeyIndex, queryKeyIndex + 3000);
      const nextQueryStart = chunk.indexOf('{"queryKey":', 20);
      const validChunk = nextQueryStart !== -1 ? chunk.substring(0, nextQueryStart) : chunk;

      const openMatches = [...validChunk.matchAll(/"openPrice":\s*([0-9]+(?:\.[0-9]+)?)/g)];
      const op = openMatches.length ? Number(openMatches[0][1]) : NaN; // The first match after the key belongs to this query
      if (Number.isFinite(op) && op > 0) return op;

      // Verified live (2026-08-09): Polymarket moved off Pages Router's
      // dehydratedState/__NEXT_DATA__ script tag entirely (App Router RSC
      // streaming now), and in this format each dehydrated query entry puts
      // "state":{"data":{"openPrice":N,...}} BEFORE its own "queryKey", not
      // after -- {"dehydratedAt":...,"state":{"data":{"openPrice":N,...}},
      // "queryKey":[...]}. The forward search above is now the one that never
      // matches for this entry shape. Bound the backward search to this
      // query's own object (from its "{"dehydratedAt":" start) so it can never
      // pick up an adjacent window's openPrice.
      const entryStart = (() => {
        const a = html.lastIndexOf('{"dehydratedAt":', queryKeyIndex);
        const b = html.lastIndexOf('{\\"dehydratedAt\\":', queryKeyIndex);
        return Math.max(a, b);
      })();
      const ownChunk = entryStart !== -1
        ? html.substring(entryStart, queryKeyIndex)
        : html.substring(Math.max(0, queryKeyIndex - 2000), queryKeyIndex);
      const openMatchesBack = [
        ...ownChunk.matchAll(/\\"openPrice\\":\s*([0-9]+(?:\.[0-9]+)?)/g),
        ...ownChunk.matchAll(/"openPrice":\s*([0-9]+(?:\.[0-9]+)?)/g),
      ];
      const opBack = openMatchesBack.length ? Number(openMatchesBack[openMatchesBack.length - 1][1]) : NaN;
      if (Number.isFinite(opBack) && opBack > 0) return opBack;
    }

    // Deliberately no page-global "grab any openPrice/priceToBeat on the page" fallback
    // here: Polymarket event pages can hydrate multiple markets, symbols, and adjacent
    // 5-minute windows into the same HTML payload, so an unscoped match risks returning
    // another contract's benchmark entirely. Returning null (and falling back to a
    // slower, still-scoped source upstream) is safer than a plausible-looking wrong price.
    return null;
  }

  function _parseGenericPriceToBeat(jsonStr, slug) {
    if (!jsonStr) return null;
    try {
      const data = JSON.parse(jsonStr);
      const objs = [data, data.market, data.event, data.eventMetadata, data.resolution, data.metadata, data.data].filter(Boolean);
      for (const o of objs) {
        const cands = [o.priceToBeat, o.price_to_beat, o.initialPrice, o.openPrice, o.startPrice, o.benchmarkPrice, o.strike, o.strikePrice, o.referencePrice, o.openingPrice];
        for (const c of cands) {
          const n = typeof c === 'string' ? Number(c.replace(/,/g, '')) : Number(c);
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
      // Deep scan one level for arrays of sub objects (events etc)
      if (Array.isArray(data.markets)) {
        for (const mm of data.markets) {
          const cands = [mm.priceToBeat, mm.openPrice, mm.initialPrice];
          for (const c of cands) { const n=Number(c); if (Number.isFinite(n)&&n>0) return n; }
        }
      }
    } catch (e) {}
    return null;
  }

  // Verified live (2026-08-18): Polymarket's Price To Beat chart calls
  // GET /api/chainlink-candles?symbol=..&interval=5m|15m&limit=30&
  // endTime=<ms>&twapEnabled=true&twapLookbackSeconds=60. The 5m/15m
  // cryptoMarketConfig id is `*-twap-60`. lookback=30 is a different series
  // and must not be used. limit must be exactly 30 -- any other value 400s.
  // Live-verified (2026-08-13): a 4-minute audit of the real fetch pipeline
  // caught every single symbol/horizon combination failing with HTTP 429 from
  // this endpoint. Root cause: fetchPolymarketChainlinkCandleOpen used to fire
  // its own network request per {sym, horizon, boundarySec} lookup with no
  // caching, dedup, or 429 handling -- and it's called from three uncoordinated
  // places (_tickPendingPtbLocks' retry loop, both fetchPolymarket*BySlug's own
  // internal resolution, and the 15s _doFetch poll cycle), all hammering the
  // same endpoint independently right after every boundary rollover across all
  // 7 coins x 2 horizons. One call with limit=30 already returns ~2.5h (5m) /
  // ~7.5h (15m) of candles, so per-boundary-lookup fetching was wasteful even
  // before counting the duplication. Consolidated into a single shared,
  // rate-limited cache below -- mirrors the existing Kalshi 429-cooldown
  // pattern (_ipcLooksRateLimited/_tripKalshiCooldown above) rather than
  // inventing a new one.
  const _chainlinkCandleCache = Object.create(null); // `${sym}:${interval}:${lookback}` -> { candles, fetchedAt, inFlight }
  const CHAINLINK_CANDLE_TTL_MS = 45_000;
  const CHAINLINK_MIN_GLOBAL_INTERVAL_MS = 1_500; // gate across ALL keys, not per-key
  let _chainlinkLastRequestAt = 0;
  let _chainlinkRateLimitUntil = 0;
  let _chainlinkConsecutive429 = 0;

  function _tripChainlinkCooldown(reason) {
    _chainlinkConsecutive429++;
    const jitter = Math.floor(Math.random() * 2000);
    const wait = Math.min(25_000, (5_000 * Math.min(4, _chainlinkConsecutive429)) + jitter);
    _chainlinkRateLimitUntil = Date.now() + wait;
    console.warn(`[PredictionMarkets] chainlink-candles cooldown ${wait}ms — ${reason} (streak=${_chainlinkConsecutive429})`);
    return wait;
  }

  function _twapLookbackSeconds(market) {
    const n = Number(market?.cryptoMarketConfig?.twapLookbackSeconds);
    return Number.isFinite(n) && n > 0 ? n : POLY_TWAP_LOOKBACK_SEC;
  }

  // forceRefresh bypasses the CHAINLINK_CANDLE_TTL_MS cache (but never the
  // 429 cooldown/global-rate-limit gate below) -- used by the PTB confirm
  // recheck so a second reading is a genuine independent fetch, not a replay
  // of the same cached response the first reading already saw.
  async function _fetchChainlinkCandlesCached(sym, interval, lookbackSec = POLY_TWAP_LOOKBACK_SEC, forceRefresh = false) {
    const lookback = Number(lookbackSec) > 0 ? Number(lookbackSec) : POLY_TWAP_LOOKBACK_SEC;
    const key = `${sym}:${interval}:${lookback}`;
    const now = Date.now();
    const entry = _chainlinkCandleCache[key];

    if (entry?.inFlight) return entry.inFlight;
    if (!forceRefresh && entry && now - entry.fetchedAt < CHAINLINK_CANDLE_TTL_MS) return entry.candles;
    if (_chainlinkRateLimitUntil > now) return entry?.candles || []; // cooling down -- serve stale, never fetch

    const wait = Math.max(0, CHAINLINK_MIN_GLOBAL_INTERVAL_MS - (now - _chainlinkLastRequestAt));
    const doFetch = (async () => {
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      _chainlinkLastRequestAt = Date.now();
      try {
        const url = `https://polymarket.com/api/chainlink-candles?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=30&endTime=${Date.now()}&twapEnabled=true&twapLookbackSeconds=${lookback}`;
        const txt = await textFetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151 Safari/537.36',
            'Accept': 'application/json',
          },
        });
        const data = JSON.parse(txt);
        const candles = Array.isArray(data?.candles) ? data.candles : [];
        _chainlinkConsecutive429 = 0;
        _chainlinkCandleCache[key] = { candles, fetchedAt: Date.now(), inFlight: null };
        return candles;
      } catch (e) {
        const msg = e?.message || String(e);
        if (/HTTP 429/.test(msg)) {
          _tripChainlinkCooldown(`${key}: ${msg}`);
        } else {
          console.warn(`[Poly5M-PTB] chainlink-candles fetch failed for ${key}:`, msg);
        }
        if (_chainlinkCandleCache[key]) _chainlinkCandleCache[key].inFlight = null;
        return entry?.candles || [];
      }
    })();

    _chainlinkCandleCache[key] = { candles: entry?.candles || [], fetchedAt: entry?.fetchedAt || 0, inFlight: doFetch };
    return doFetch;
  }

  async function fetchPolymarketChainlinkCandleOpen(sym, horizonTag, boundarySec, lookbackSec = POLY_TWAP_LOOKBACK_SEC, forceRefresh = false) {
    const interval = horizonTag === '15m' ? '15m' : '5m';
    const intervalSec = horizonTag === '15m' ? 900 : 300;
    const candles = await _fetchChainlinkCandlesCached(sym, interval, lookbackSec, forceRefresh);
    const candle = Array.isArray(candles) ? candles.find(c => c.time === boundarySec) : null;
    const openVal = toPositiveFiniteNumber(candle?.open);
    if (openVal != null && openVal > 0) return openVal;

    // TWAP continuity: the opening strike of boundarySec is mathematically identical
    // to the close price of the preceding candle (time === boundarySec - intervalSec)
    const prevCandle = Array.isArray(candles) ? candles.find(c => c.time === boundarySec - intervalSec) : null;
    const prevClose = toPositiveFiniteNumber(prevCandle?.close);
    if (prevClose != null && prevClose > 0) return prevClose;

    return null;
  }

  // Exposed for the (planned) Polymarket 5m resolution tracker to read a
  // window's settlement close price off the same cache, without issuing any
  // fetch of its own.
  function _getCachedChainlinkCandle(sym, horizonTag, boundarySec, lookbackSec = POLY_TWAP_LOOKBACK_SEC) {
    const interval = horizonTag === '15m' ? '15m' : '5m';
    const lookback = Number(lookbackSec) > 0 ? Number(lookbackSec) : POLY_TWAP_LOOKBACK_SEC;
    const entry = _chainlinkCandleCache[`${sym}:${interval}:${lookback}`];
    if (!entry) return null;
    return (entry.candles || []).find(c => c.time === boundarySec) || null;
  }

  async function fetchPolymarketPriceToBeat(slug) {
    if (!slug) return null;
    const existingLock = _getPolymarketPriceToBeatLock(slug);
    // An authoritative (event-page) lock, or one that has already used its
    // one-shot correction, is final -- stop fetching.
    if (existingLock && (existingLock.corrected || POLY5M_PTB_AUTHORITATIVE_SOURCES.has(existingLock.source))) {
      return existingLock.price;
    }
    // A non-authoritative (candle/fallback) lock is still SERVED, but we keep
    // hitting the event page below: its dehydrated priceToBeat is the exact
    // contract benchmark and a candle open can settle a few cents off it. If
    // nothing new locks this pass, we return existingLock.price at the end.
    if (existingLock) return existingLock.price;

    const cached = _poly5mPriceToBeatCache[slug];
    if (!existingLock && cached && Date.now() - cached.fetchedAt < PTB_SCRAPE_RETRY_MS && cached.value != null) {
      return cached.value;
    }

    const slugMatch = slug.match(/^([a-z0-9-]+)-updown-(5m|15m)-(\d+)$/i);
    if (slugMatch) {
      const symMap = { btc: 'BTC', eth: 'ETH', sol: 'SOL', xrp: 'XRP', doge: 'DOGE', hype: 'HYPE', bnb: 'BNB' };
      const sym = symMap[slugMatch[1].toLowerCase()];
      const horizonTag = slugMatch[2].toLowerCase();
      const startSec = Number(slugMatch[3]);
      if (sym && Number.isFinite(startSec)) {
        const settledSec = (Date.now() / 1000) - startSec;

        // PRIMARY: chainlink-candles REST endpoint. Only when nothing is locked
        // yet AND the 60s TWAP window has fully accumulated (PTB_TWAP_SETTLE_SEC)
        // -- reading the `open` before then locks a half-formed TWAP that later
        // settles a few cents away, which is the drift this path used to cause.
        // NOTE: an unconfirmed read (_lockPolymarketPriceToBeat returns null while it
        // waits for a second independent read -- see PTB_CONFIRM_* / v15 above) must
        // NEVER be used as the returned/cached value. Falling back to the raw
        // single-read candleOpen/pmOpen/fallbackPrice here (as this code used to do)
        // silently bypassed the whole confirmation gate: the very first, unconfirmed
        // read got cached and handed to callers immediately, so v15's fix never
        // actually prevented a wrong PTB from being used -- it only changed what got
        // frozen internally a few seconds later, after the wrong value had already
        // been displayed/traded on. Return null (not-yet-available) instead; the
        // caller's short-TTL cache (PTB_SCRAPE_RETRY_MS below) re-invokes this within
        // ~1s, which naturally supplies the second confirming read.
        if (!existingLock && settledSec >= PTB_TWAP_SETTLE_SEC) {
          try {
            const candleOpen = await fetchPolymarketChainlinkCandleOpen(sym, horizonTag, startSec, POLY_TWAP_LOOKBACK_SEC, false);
            if (candleOpen != null && candleOpen > 0) {
              const locked = _lockPolymarketPriceToBeat(slug, candleOpen, 'polymarket-chainlink-candles');
              if (locked) {
                _poly5mPriceToBeatCache[slug] = { value: locked.price, fetchedAt: Date.now() };
                return locked.price;
              }
              return null;
            }
          } catch (_) {}
        }

        // AUTHORITATIVE: Polymarket event page dehydrated state. Always tried --
        // it locks when nothing else has, and it CORRECTS a candle/fallback lock
        // that came in off the contract value (see _lockPolymarketPriceToBeat).
        try {
          const html = await textFetch(`https://polymarket.com/event/${encodeURIComponent(slug)}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          });
          const pmOpen = toPositiveFiniteNumber(_parsePolymarketPriceToBeat(html, slug));
          if (pmOpen != null && pmOpen > 0) {
            const locked = _lockPolymarketPriceToBeat(slug, pmOpen, 'polymarket-event-page');
            if (locked) {
              _poly5mPriceToBeatCache[slug] = { value: locked.price, fetchedAt: Date.now() };
              return locked.price;
            }
            // event-page read seen but not yet confirmed (needs a 2nd read, or a
            // 2nd matching read to authorize a correction) -- keep serving the
            // existing lock in the meantime.
            if (existingLock) return existingLock.price;
            return null;
          }
        } catch (e) {
          console.warn(`[Poly5M-PTB] Polymarket openPrice lookup failed for ${slug}:`, e?.message || e);
        }

        // TERTIARY FALLBACK: Only at the exact open boundary (<= 15 seconds into
        // window) and only when nothing is locked yet.
        const secondsSinceStart = (Date.now() / 1000) - startSec;
        if (!existingLock && secondsSinceStart >= 0 && secondsSinceStart <= 15) {
          const rtdsFallback = _getFreshRtdsTwap(sym, 15_000);
          const fallbackPrice = toPositiveFiniteNumber(rtdsFallback?.price);
          if (fallbackPrice != null && fallbackPrice > 0) {
            const locked = _lockPolymarketPriceToBeat(slug, fallbackPrice, 'chainlink-open-fallback');
            if (locked) {
              _poly5mPriceToBeatCache[slug] = { value: locked.price, fetchedAt: Date.now() };
              return locked.price;
            }
            return null;
          }
        }
      }
    }



    // Sourced solely from Polymarket contract event page
    try {
      const html = await textFetch(`https://polymarket.com/event/${encodeURIComponent(slug)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const pmOpen = toPositiveFiniteNumber(_parsePolymarketPriceToBeat(html, slug));
      if (pmOpen != null && pmOpen > 0) {
        const locked = _lockPolymarketPriceToBeat(slug, pmOpen, 'polymarket-event-page');
        _poly5mPriceToBeatCache[slug] = { value: locked?.price ?? pmOpen, fetchedAt: Date.now() };
        return locked?.price ?? pmOpen;
      }
    } catch (e) {
      console.warn(`[Poly5M-PTB] Polymarket contract open lookup failed for ${slug}:`, e?.message || e);
    }
    return existingLock ? existingLock.price : null;

    return null;
  }

  async function fetchPolymarket5MBySlug(sym) {
    const coinSlugPrefix = POLY_5M_COIN_SLUGS[sym];
    if (!coinSlugPrefix) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    const cached = _poly5mCache[sym];
    if (cached && cached.windowTs === windowTs && Date.now() - cached.fetchedAt < (cached.data?.priceToBeatNum != null ? 15_000 : 1_000)) {
      const c = cached.data;
      if (c && Number.isFinite(c.priceToBeatNum) && c.priceToBeatNum > 0) {
        return c;
      }
      // stale cache without PTB for active window — re-fetch to establish exact contract PTB
    }
    const candidates = [
      windowTs,
      windowTs + 300,
      windowTs + 600,
      windowTs + 900,
      windowTs + 1200,
      windowTs + 1500,
      windowTs - 300,
    ];

    const results = await Promise.all(candidates.map(async (ts) => {
      const slug = `${coinSlugPrefix}-updown-5m-${ts}`;
      try {
        const hit = await fetchPolymarket5MMarketCandidate(sym, slug);
        const m = hit?.market;
        if (!m) return null;
        const upProb = _parseUpProb(m);
        if (upProb === null) return null;

        const isActiveWindow = ts <= windowTs;
        const clobSnapshot = isActiveWindow
          ? await fetchPolymarketClobMarketSnapshot(sym, m)
          : null;
        const clobProb = Number(clobSnapshot?.upProbability);
        const liveUpProb = Number.isFinite(clobProb) && clobProb >= 0.01 && clobProb <= 0.99 ? clobProb : upProb;
        const title = m.question || m.title || `${sym} Up or Down 5M`;
        const endDate = m.endDate || m.end_date_iso || m.end_date || null;
        const startDate = new Date(ts * 1000).toISOString();
        const volume = parseFloat(m.volume24hr || m.volumeNum || m.volume || 0) || 0;
        const marketSlug = m.slug || slug;
        const isFuture = ts > windowTs;

        let priceToBeatSource = null;
        let priceToBeatNum = null;

        // Check if an immutable lock already exists for this exact contract slug FIRST
        const existingLock = _getPolymarketPriceToBeatLock(slug) || _getPolymarketPriceToBeatLock(marketSlug);
        if (existingLock) {
          priceToBeatNum = existingLock.price;
          priceToBeatSource = existingLock.source;
        }

        const isImmediateNext = ts === windowTs + 300;
        // Strike is the opening value of THIS window. Future contracts are
        // not yet immutable — do not lock a forming TWAP / prev close as PTB.
        const shouldResolvePTB = ts === windowTs;
        const hasTwapSettled = nowSec >= ts + _twapLookbackSeconds(m) + 2;

        // 0. CANONICAL CONTRACT BENCHMARK: Polymarket Chainlink 60s TWAP Candle Open (Absolute Truth)
        if (priceToBeatNum == null && shouldResolvePTB && hasTwapSettled) {
          try {
            const candleStrike = await fetchPolymarketChainlinkCandleOpen(sym, '5m', ts, _twapLookbackSeconds(m), false);
            if (candleStrike != null && candleStrike > 0) {
              priceToBeatNum = candleStrike;
              priceToBeatSource = 'polymarket-contract';
            }
          } catch (_) {}
        }

        // 1. Direct Polymarket Contract Benchmark posted on Polygon / Polymarket metadata
        if (priceToBeatNum == null && shouldResolvePTB) {
          const directContractStrike = toPositiveFiniteNumber(
            m.eventMetadata?.priceToBeat
            ?? m.eventMetadata?.price_to_beat
            ?? m.priceToBeat
            ?? m.price_to_beat
            ?? m.targetPrice
            ?? m.target_price
            ?? m.strikePrice
          );
          if (directContractStrike != null && directContractStrike > 0) {
            priceToBeatNum = directContractStrike;
            priceToBeatSource = 'gamma-market';
          }
        }

        // 2. Fetch directly from Polymarket contract event page / API
        if (priceToBeatNum == null && shouldResolvePTB) {
          const maxRetries = (isActiveWindow && (nowSec - windowTs <= 30)) ? 4 : 1;
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              const scraped = await fetchPolymarketPriceToBeat(slug) || await fetchPolymarketPriceToBeat(marketSlug);
              if (Number.isFinite(scraped) && scraped > 0) {
                priceToBeatNum = scraped;
                priceToBeatSource = 'polymarket-event-page';
                break;
              }
            } catch (_) {}
            if (priceToBeatNum != null || !isActiveWindow || (nowSec - windowTs > 30)) break;
            await new Promise(r => setTimeout(r, 600));
          }
        }

        if (priceToBeatNum != null && shouldResolvePTB) {
          const candidateValue = priceToBeatNum;
          const candidateSource = priceToBeatSource;
          const locked = _lockPolymarketPriceToBeat(slug, candidateValue, candidateSource) || _lockPolymarketPriceToBeat(marketSlug, candidateValue, candidateSource);
          // Do NOT leave priceToBeatNum set to the raw candidateValue when `locked`
          // is falsy -- that silently bypasses the confirmation gate exactly like the
          // `?? candleOpen` pattern fixed in fetchPolymarketPriceToBeat() above: an
          // unconfirmed single read would flow straight through as this market's
          // "priceToBeat"/priceDeltaNum/AI PTB. Treat it as still-pending instead;
          // the next poll of this window (fetchPolymarket5MBySlug's short-TTL cache
          // re-invokes this within ~1s while priceToBeatNum is null) supplies the
          // second, independent, time-separated read that actually confirms it.
          if (locked) {
            priceToBeatNum = locked.price;
            priceToBeatSource = locked.source;
          } else {
            priceToBeatNum = null;
            priceToBeatSource = null;
          }
          if (marketSlug && marketSlug !== slug) {
            _lockPolymarketPriceToBeat(marketSlug, candidateValue, candidateSource);
          }
        }

        // Real-time data is Pyth only (There are no other feeds)
        const pythCurrent = await getFreshPythLazerPrice(sym);
        const pythPriceNum = pythCurrent?.price ?? toPositiveFiniteNumber(typeof window !== 'undefined' && (window.PythBrowser?.getPrice?.(sym) || window._pythPrices?.[sym]));
        const currentPriceNum = pythPriceNum ?? null;
        const currentPriceTs = pythCurrent?.timestamp ?? (typeof window !== 'undefined' && window._pythPythMetadata?.[sym]?.publishTime) ?? Date.now();
        const currentPriceSource = 'pyth';

        // PTB comes exclusively from Polymarket's canonical Chainlink contract benchmark.
        // A five-minute contract is unavailable until its benchmark exists.
        if (priceToBeatNum == null && !isFuture && ts !== windowTs) return null;

        if (ts === windowTs || isImmediateNext || priceToBeatNum != null) {
          const ptbFidelity = priceToBeatNum == null ? 'pending' : 'exact-contract';
          console.log(`[Poly5M-PTB] ${sym} ${marketSlug} → $${priceToBeatNum ?? 'pending'} (source: ${priceToBeatSource ?? 'waiting-for-open'}) [${ptbFidelity}]`);
        }

        const currentPriceJustification = 'Pyth real-time spot price compared with Polymarket contract opening PTB.';

        if (priceToBeatNum != null && !isFuture) {
          const locked = _lockPolymarketPriceToBeat(marketSlug, priceToBeatNum, priceToBeatSource);
          if (locked) {
            priceToBeatNum = locked.price;
            priceToBeatSource = locked.source;
          }
        }

        const priceToBeat = _formatPolyPriceToBeat(priceToBeatNum, sym);
        const hasLiveComparison = currentPriceNum != null && Number.isFinite(priceToBeatNum) && priceToBeatNum > 0;
        const priceDeltaNum = hasLiveComparison ? currentPriceNum - priceToBeatNum : null;
        const priceDeltaPct = hasLiveComparison ? priceDeltaNum / priceToBeatNum : null;
        const liveDirection = hasLiveComparison
          ? (priceDeltaNum >= 0 ? 'UP' : 'DOWN')
          : null;

        const cachedCandle = _getCachedChainlinkCandle(sym, '5m', ts, POLY_TWAP_LOOKBACK_SEC);
        const chainlinkCurrentPriceNum = toPositiveFiniteNumber(cachedCandle?.close);
        const chainlinkCurrentPriceTs = cachedCandle?.time ? cachedCandle.time * 1000 : null;
        const oracleBasisNum = (pythCurrent && chainlinkCurrentPriceNum != null) ? pythCurrent.price - chainlinkCurrentPriceNum : null;

        const hasSettlementComparison = chainlinkCurrentPriceNum != null && Number.isFinite(priceToBeatNum) && priceToBeatNum > 0;
        const settlementPriceDeltaNum = hasSettlementComparison ? chainlinkCurrentPriceNum - priceToBeatNum : null;
        const settlementLiveDirection = hasSettlementComparison
          ? (settlementPriceDeltaNum >= 0 ? 'UP' : 'DOWN')
          : null;

        const clobTokenIds = _polyClobTokenIds(m);
        const conditionId = m.conditionId || m.condition_id || null;
        const questionID = m.questionID || m.question_id || null;
        const yesTokenId = m.yesTokenId || clobTokenIds[_polyOutcomeIndex(m, 'up', 0)] || clobTokenIds[0] || null;
        const noTokenId = m.noTokenId || clobTokenIds[_polyOutcomeIndex(m, 'down', 1)] || clobTokenIds[1] || null;
        const marketId = m.marketId || m.id || null;
        const eventId = m.eventId || m.events?.[0]?.id || m._eventFallback?.id || null;

        return {
          ts,
          m,
          hit,
          liveUpProb,
          upProb,
          clobProb,
          volume,
          title,
          marketSlug,
          conditionId,
          questionID,
          questionId: questionID,
          clobTokenIds,
          yesTokenId,
          noTokenId,
          marketId,
          eventId,
          eventMetadata: m.eventMetadata || null,
          endDate,
          startDate,
          priceToBeat,
          priceToBeatNum,
          priceToBeatSource,
          currentPriceNum,
          currentPriceTs,
          currentPriceSource,
          currentPriceJustification,
          pythCurrent,
          chainlinkCurrentPriceNum,
          chainlinkCurrentPriceTs,
          oracleBasisNum,
          priceDeltaNum,
          priceDeltaPct,
          liveDirection,
          settlementPriceDeltaNum,
          settlementLiveDirection,
          hasLiveComparison,
          clobSnapshot
        };
      } catch (err) {
        console.warn(`[PredictionMarkets] Poly5M slug fetch failed for ${sym} ${slug}:`, err?.message || err);
        return null;
      }
    }));

    const validResults = results.filter(r => r !== null);
    if (validResults.length === 0) {
      _poly5mCache[sym] = { data: null, windowTs, fetchedAt: Date.now() };
      return null;
    }

    const primary = validResults.find(r => r.ts === windowTs) || null;

    if (!primary) {
      if (cached?.windowTs === windowTs && cached.data?._windowTs === windowTs) {
        cached.fetchedAt = Date.now();
        return cached.data;
      }
      return null;
    }

    const markets = validResults.sort((a, b) => a.ts - b.ts).map(r => ({
      question: r.title,
      yes: r.liveUpProb,
      gammaYes: r.upProb,
      clobYes: Number.isFinite(r.clobProb) ? r.clobProb : null,
      vol24h: r.volume,
      endDate: r.endDate,
      slug: r.marketSlug,
      conditionId: r.conditionId,
      questionID: r.questionID,
      questionId: r.questionID,
      clobTokenIds: r.clobTokenIds,
      yesTokenId: r.yesTokenId,
      noTokenId: r.noTokenId,
      marketId: r.marketId,
      eventId: r.eventId,
      eventMetadata: r.eventMetadata,
      targetPrice: r.priceToBeat,
      targetPriceNum: r.priceToBeatNum,
      priceToBeat: r.priceToBeat,
      priceToBeatNum: r.priceToBeatNum,
      priceToBeatSource: r.priceToBeatSource,
      currentPriceNum: r.currentPriceNum,
      currentPriceSource: r.currentPriceSource,
      chainlinkCurrentPriceNum: r.chainlinkCurrentPriceNum,
      oracleBasisNum: r.oracleBasisNum,
      priceDeltaNum: r.priceDeltaNum,
      liveDirection: r.liveDirection,
      settlementLiveDirection: r.settlementLiveDirection,
      discoverySource: r.hit.source || 'gamma-markets-slug',
      ts: r.ts,
      isFuture: r.ts > windowTs,
    }));

    const data = {
      probability: primary.liveUpProb,
      gammaProbability: primary.upProb,
      clobProbability: Number.isFinite(primary.clobProb) ? primary.clobProb : null,
      // upProbability alias kept for UI/Grok consumers that read the CLOB mid directly
      upProbability: Number.isFinite(primary.clobProb) ? primary.clobProb : primary.liveUpProb,
      volume: primary.volume,
      title: primary.title,
      slug: primary.marketSlug,
      ticker: primary.marketSlug,
      contractSlug: primary.marketSlug,
      contractTicker: primary.marketSlug,
      conditionId: primary.conditionId,
      questionID: primary.questionID,
      questionId: primary.questionID,
      clobTokenIds: primary.clobTokenIds,
      yesTokenId: primary.yesTokenId,
      noTokenId: primary.noTokenId,
      marketId: primary.marketId,
      eventId: primary.eventId,
      eventMetadata: primary.eventMetadata,
      closeTime: primary.endDate,
      endDate: primary.endDate,
      startDate: primary.startDate,
      liquidity: parseFloat(primary.m.liquidityNum || primary.m.liquidity || 0) || 0,
      targetPrice: primary.priceToBeat,
      targetPriceNum: primary.priceToBeatNum,
      targetPriceApprox: false,
      priceToBeat: primary.priceToBeat,
      priceToBeatNum: primary.priceToBeatNum,
      priceToBeatSource: primary.priceToBeatSource,
      currentPrice: _formatPolyPriceToBeat(primary.currentPriceNum, sym),
      currentPriceNum: primary.currentPriceNum,
      currentPriceTs: primary.currentPriceTs,
      currentPriceSource: primary.currentPriceSource,
      currentPriceAgeMs: primary.pythCurrent?.ageMs ?? null,
      currentPriceJustification: primary.currentPriceJustification,
      chainlinkCurrentPriceNum: primary.chainlinkCurrentPriceNum,
      chainlinkCurrentPriceTs: primary.chainlinkCurrentPriceTs,
      oracleBasisNum: primary.oracleBasisNum,
      settlementPriceDeltaNum: primary.settlementPriceDeltaNum,
      settlementLiveDirection: primary.settlementLiveDirection,
      priceDelta: primary.priceDeltaNum != null ? _formatPolyPriceToBeat(Math.abs(primary.priceDeltaNum), sym) : null,

      priceDeltaNum: primary.priceDeltaNum,
      priceDeltaPct: primary.priceDeltaPct,
      liveDirection: primary.liveDirection,
      liveSignal: primary.liveDirection,
      liveState: primary.hasLiveComparison ? (primary.priceDeltaNum >= 0 ? 'above' : 'below') : 'unknown',
      discoverySource: primary.hit.source || 'gamma-markets-slug',
      fallbackJustification: primary.hit.fallbackJustification || null,
      markets,
      _source: primary.hit.source === 'gamma-markets-slug' ? 'poly5m-slug' : `poly5m-${primary.hit.source || 'fallback'}`,
      _windowTs: primary.ts,
    };
    // bestBid/bestAsk + L2 micro (mid, spread, depthImbalance, nearTouchNotional, bids/asks)
    _attachClobMicroFields(data, primary.clobSnapshot, primary.m);
    _poly5mCache[sym] = { data, windowTs, fetchedAt: Date.now() };
    return data;
  }

  function matchesPolymarketCoin(m, sym) {
    const text = `${m.question || m.title || ''} ${m.description || ''}`;
    const q = text.toLowerCase();
    if (POLY_BAD_KW.some(b => q.includes(b))) return false;
    const patterns = COIN_PATTERNS[sym] || [new RegExp(`\\b${String(sym).toLowerCase()}\\b`, 'i')];
    return patterns.some(re => re.test(text));
  }

function polymarketSentiment(markets, sym) {
    const hits = markets.filter(m => matchesPolymarketCoin(m, sym));
    if (!hits.length) return null;

    let totalVol = 0, weighted = 0;
    hits.forEach(m => {
      const yes = _parseYesProb(m);
      if (yes === null) return;
      const vol = parseFloat(m.volume24hr || m.volume || 0) || 1;
      weighted += yes * vol;
      totalVol += vol;
    });
    if (totalVol === 0) return null;

    // Top 5 by 24h volume with individual YES prices ΓÇö shown in the 5M view
    const topMarkets = [...hits]
      .map(m => ({ question: m.question, yes: _parseYesProb(m), vol24h: parseFloat(m.volume24hr || m.volume || 0), endDate: m.end_date_iso || m.end_date || m.endDate || null, slug: m.market_slug || m.slug || null }))
      .filter(m => m.yes !== null)
      .sort((a, b) => b.vol24h - a.vol24h)
      .slice(0, 5);

    return {
      probability: Math.min(1, Math.max(0, weighted / totalVol)),
      volume: totalVol,
      title: topMarkets[0]?.question,
      count: hits.length,
      markets: topMarkets,
    };
  }

  function polymarket5mSentiment(markets, sym) {
    const now = Date.now();

    // First try: markets genuinely closing within 6 hours or tagged 5M
    let hits = markets.filter(m => {
      const q = ((m.question || '') + ' ' + (m.description || '')).toLowerCase();
      if (!matchesPolymarketCoin(m, sym)) return false;
      const endRaw = m.end_date_iso || m.end_date || m.endDate || null;
      if (endRaw) {
        const endMs = new Date(endRaw).getTime();
        if (endMs > now && endMs <= now + 6 * 60 * 60_000) return true;
      }
      return POLY_5M_KEYWORDS.some(k => q.includes(k));
    });

    // Fallback: any active coin market as long-term sentiment context
    const _noShortTerm = hits.length === 0;
    if (_noShortTerm) {
      hits = markets.filter(m => {
        return matchesPolymarketCoin(m, sym);
      });
    }
    if (!hits.length) return null;

    let totalVol = 0, weighted = 0;
    hits.forEach(m => {
      const yes = _parseYesProb(m);
      if (yes === null) return;
      const vol = parseFloat(m.volume24hr || m.volume || 0) || 1;
      weighted += yes * vol;
      totalVol += vol;
    });
    if (totalVol === 0) return null;

    const topMarkets = [...hits]
      .map(m => ({ question: m.question, yes: _parseYesProb(m), vol24h: parseFloat(m.volume24hr || m.volume || 0), endDate: m.end_date_iso || m.end_date || m.endDate || null, slug: m.market_slug || m.slug || null }))
      .filter(m => m.yes !== null)
      .sort((a, b) => b.vol24h - a.vol24h)
      .slice(0, 5);

    return {
      probability: Math.min(1, Math.max(0, weighted / totalVol)),
      volume: totalVol,
      title: topMarkets[0]?.question,
      count: hits.length,
      markets: topMarkets,
      _noShortTerm,
    };
  }



// ---- Aggregation --------------------------------------------------
  // Polymarket 5M: direct deterministic slug fetch. Kalshi has no 5-minute markets here.
  let _polyCycleCount = 0;
  
  let _polyCache = null;
  let _polyLastFetch = 0;
  let _polyLastError = '';
  let _polyLastSource = '';
  let _k5mCache = Object.create(null);
  const FETCH_TIMEOUT_MS = 12_000;

  function withTimeout(promise, ms, label) {
    let timerId = null;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timerId) clearTimeout(timerId);
    });
  }

  async function _doFetch() {
    _polyCycleCount++;
    const fetchPoly5M = true;

    const [kalshi15m, polyMarkets] = await Promise.all([
      KALSHI_DISABLED
        ? Promise.resolve({})
        : withTimeout(fetchKalshi15M(), FETCH_TIMEOUT_MS, 'Kalshi 15M fetch').catch(err => {
            console.warn('[PredictionMarkets] Kalshi 15M fetch failed:', err?.message || err);
            return {};
          }),
      withTimeout(fetchPolymarket(), FETCH_TIMEOUT_MS, 'Polymarket fetch').catch(err => {
        console.warn('[PredictionMarkets] Polymarket fetch failed:', err?.message || err);
        return null;
      }),
    ]);
    if (polyMarkets !== null) {
      _polyCache = polyMarkets;
      window.DataLogger?.logPolymarket(polyMarkets);
    }

    if (!KALSHI_DISABLED) {
      const k5m = await withTimeout(fetchKalshi5M(), FETCH_TIMEOUT_MS, 'Kalshi 5M fetch')
        .catch(err => {
          console.warn('[PredictionMarkets] Kalshi 5M fetch failed:', err?.message || err);
          return {};
        });
      if (k5m && Object.keys(k5m).length > 0) {
        for (const [sym, k5Data] of Object.entries(k5m)) {
          if (k5Data) {
            _k5mCache[sym] = { ...(_k5mCache[sym] || {}), ...k5Data };
          }
        }
      }
    }

    const poly15mResults = Object.create(null);
    const poly60mResults = Object.create(null);
    if (fetchPoly5M) {
      const poly5mResults = Object.create(null);
      const symKeys = Object.keys(POLY_5M_COIN_SLUGS);
      await Promise.all(symKeys.map(async (sym, i) => {
        // Stagger requests 200ms apart to avoid simultaneous 21-request bursts
        // (7 coins × 3 horizons each) that trip Gamma's rate limiter on BTC/XRP.
        if (i > 0) await new Promise(r => setTimeout(r, i * 200));
        try {
          poly5mResults[sym] = await withTimeout(fetchPolymarket5MBySlug(sym), 8_000, `Poly5M ${sym}`);
        } catch (err) {
          console.warn(`[PredictionMarkets] Poly5M fetch failed for ${sym}:`, err?.message || err);
          poly5mResults[sym] = null;
        }
        try {
          poly15mResults[sym] = await withTimeout(fetchPolymarket15MBySlug(sym), 8_000, `Poly15M ${sym}`);
        } catch (err) {
          poly15mResults[sym] = null;
        }
        try {
          poly60mResults[sym] = await withTimeout(fetchPolymarket60MBySlug(sym), 8_000, `Poly60M ${sym}`);
        } catch (err) {
          poly60mResults[sym] = null;
        }
      }));
      for (const [sym, poly5m] of Object.entries(poly5mResults)) {
        if (!poly5m) continue;
        _k5mCache[sym] = { ...(_k5mCache[sym] || {}), _poly5m: poly5m };
      }
      window.DataLogger?.logPolymarket5M({
        fetchedAt: Date.now(),
        source: 'deterministic-slug-clob',
        contracts: poly5mResults,
      });
    }

    // --- Network Health Reporting ---
    if (window.NetworkHealth) {
      // Polymarket
      const hasPolyMarkets = Array.isArray(polyMarkets) && polyMarkets.length > 0;
      const polyStatus = {
        status: hasPolyMarkets ? 'healthy' : 'degraded',
        lastFetch: Date.now(),
        fallback: !hasPolyMarkets,
        transient: !hasPolyMarkets,
        reason: hasPolyMarkets ? `${polyMarkets.length} markets` : (_polyLastError || 'No Polymarket data'),
        bucket: hasPolyMarkets ? 'unknown' : 'provider/api',
        bucketReason: hasPolyMarkets ? '' : (_polyLastError || 'optional Polymarket data unavailable'),
      };
      window.NetworkHealth.update('Polymarket', polyStatus);
    }

    const next = Object.create(null);
    for (const sym of Object.keys(POLY_5M_COIN_SLUGS)) {
      const k5raw = _k5mCache[sym] ?? null;
      const poly5mSlug = k5raw?._poly5m ?? null;
      const poly15mObj = poly15mResults[sym] || cache[sym]?.poly15m || _poly15mCache[sym]?.data || null;
      const poly60mObj = poly60mResults[sym] || cache[sym]?.poly60m || _poly60mCache[sym]?.data || null;
      const poly = Array.isArray(_polyCache) ? polymarketSentiment(_polyCache, sym) : null;
      const poly5m = poly5mSlug || null;

      const sources = [];
      if (poly5mSlug?.probability != null) sources.push({ name: 'Poly5M', prob: poly5mSlug.probability, vol: poly5mSlug.volume || 1 });
      if (poly15mObj?.probability != null) sources.push({ name: 'Poly15M', prob: poly15mObj.probability, vol: poly15mObj.volume || 1 });
      if (poly?.probability != null) sources.push({ name: 'Polymarket', prob: poly.probability, vol: poly.volume || 1 });
      
      const combinedProb = poly15mObj?.probability ?? poly5mSlug?.probability ?? poly?.probability ?? null;

      next[sym] = {
        kalshi: null,
        poly: poly?.probability != null ? parseFloat(poly.probability.toFixed(4)) : (poly15mObj?.probability != null ? parseFloat(poly15mObj.probability.toFixed(4)) : (poly5mSlug?.probability != null ? parseFloat(poly5mSlug.probability.toFixed(4)) : null)),
        combinedProb: combinedProb !== null ? parseFloat(combinedProb.toFixed(4)) : null,
        sources,
        kalshi15m: null,
        kalshi5m: null,
        poly5m,
        poly5mSlug,
        poly15m: poly15mObj,
        poly60m: poly60mObj,
        poly5mMkts: poly5m?.markets || [],
        polyMarkets: poly?.markets || [],
        kalshiTitle: null,
        probVelocity: 0,
      };
    }

    cache = next;
    lastFetch = Date.now();

    const liveTickers = Object.values(next)
      .map(c => c?.kalshi15m?.ticker)
      .filter(Boolean);
    window.EndpointTransport?.subscribeKalshiMarketTickers?.(liveTickers);

    window.dispatchEvent(new CustomEvent('predictionmarketsready', { detail: next }));
  }

  function onKalshiTicker(e) {
    const { market_ticker } = e.detail || {};
    if (!market_ticker) return;
    let touched = false;
    for (const sym of Object.keys(cache)) {
      const k15 = cache[sym]?.kalshi15m;
      if (!k15 || k15.ticker !== market_ticker) continue;
      const updated = applyWsTickerToContract(k15);
      if (updated.probability === k15.probability) continue;
      cache[sym] = { ...cache[sym], kalshi15m: updated, kalshi: updated.probability };
      if (cache[sym].combinedProb != null && cache[sym].sources?.length) {
        const kSrc = cache[sym].sources.find(s => s.name === 'Kalshi15M');
        if (kSrc) kSrc.prob = updated.probability;
        cache[sym].combinedProb = updated.probability;
      }
      touched = true;
    }
    if (touched) {
      window.dispatchEvent(new CustomEvent('predictionmarketsready', { detail: cache }));
    }
  }

  async function fetchAll() {
    if (inFlight) return inFlight;
    inFlight = _doFetch().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function refreshPoly5M(reason = 'manual') {
    const results = Object.create(null);
    await Promise.all(Object.keys(POLY_5M_COIN_SLUGS).map(async sym => {
      _poly5mCache[sym] = null;
      results[sym] = await fetchPolymarket5MBySlug(sym);
    }));

    let touched = false;
    for (const [sym, poly5m] of Object.entries(results)) {
      if (!poly5m) continue;
      _k5mCache[sym] = { ...(_k5mCache[sym] || {}), _poly5m: poly5m };
      if (cache[sym]) {
        cache[sym] = {
          ...cache[sym],
          poly5m,
          poly5mSlug: poly5m,
          poly5mMkts: poly5m.markets || [],
          sources: [
            ...(cache[sym].sources || []).filter(s => s.name !== 'Poly5M'),
            { name: 'Poly5M', prob: poly5m.probability, vol: poly5m.volume || 1 },
          ],
        };
        touched = true;
      }
    }

    if (touched) {
      window.dispatchEvent(new CustomEvent('predictionmarketsready', { detail: cache }));
    }
    console.info(`[PredictionMarkets] Poly5M refresh (${reason}): ${Object.entries(results).filter(([, v]) => v).map(([sym]) => sym).join(', ') || 'none'}`);
    return results;
  }

  // ── Polymarket 15-minute pull ────────────────────────────────────────────
  // Deliberately leaner than the 5-minute pipeline above. That pipeline's
  // immutable PTB locking, Pyth/Chainlink cross-referencing, and multi-window
  // lookahead were all built specifically to solve 5-minute-window timing
  // pressure across many iterations; 15-minute windows have far more slack,
  // and Kalshi's own 15M pipeline already provides model-comparison logic
  // elsewhere in this file. This pulls the market, its live odds, and a
  // best-effort PTB via the same generalized parser/fetcher used for 5m
  // (fetchPolymarket5MMarketCandidate, _parseUpProb, fetchPolymarketPriceToBeat,
  // _lockPolymarketPriceToBeat -- all horizon-agnostic; verified live against
  // Polymarket's actual 15m slug/queryKey shapes, not assumed by analogy with
  // 5m). No immutable-lock version namespace of its own is needed: the lock
  // key is the full slug string, which already encodes "15m" vs "5m", so
  // reusing the same lock store cannot collide between horizons.
  const _poly15mCache = Object.create(null);

  async function fetchPolymarket15MBySlug(sym) {
    const coinSlugPrefix = POLY_5M_COIN_SLUGS[sym];
    if (!coinSlugPrefix) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 900);
    const cached = _poly15mCache[sym];
    if (cached && cached.windowTs === windowTs && Date.now() - cached.fetchedAt < (cached.data?.priceToBeatNum != null ? 30_000 : 5_000)) {
      return cached.data;
    }

    const slug = `${coinSlugPrefix}-updown-15m-${windowTs}`;
    try {
      const hit = await fetchPolymarket5MMarketCandidate(sym, slug);
      const m = hit?.market;
      if (!m) return null;
      const upProb = _parseUpProb(m);
      if (upProb === null) return null;

      const title = m.question || m.title || `${sym} Up or Down 15M`;
      const endDate = m.endDate || m.end_date_iso || m.end_date || null;
      const startDate = new Date(windowTs * 1000).toISOString();
      const volume = parseFloat(m.volume24hr || m.volumeNum || m.volume || 0) || 0;
      const marketSlug = m.slug || slug;

      // Subscribe poly15m tokens on the shared PolymarketWS (same owner as poly5m).
      let clobSnapshot = null;
      try {
        clobSnapshot = await fetchPolymarketClobMarketSnapshot(sym, m);
      } catch (clobErr) {
        console.warn(`[PredictionMarkets] Poly15M CLOB snapshot unavailable for ${sym} ${marketSlug}:`, clobErr?.message || clobErr);
      }
      const clobProb = Number(clobSnapshot?.upProbability);
      const liveUpProb = Number.isFinite(clobProb) && clobProb >= 0.01 && clobProb <= 0.99
        ? clobProb
        : upProb;

      let priceToBeatNum = null;
      let priceToBeatSource = null;

      const existingLock = _getPolymarketPriceToBeatLock(slug) || _getPolymarketPriceToBeatLock(marketSlug);
      if (existingLock) {
        priceToBeatNum = existingLock.price;
        priceToBeatSource = existingLock.source;
      } else {
        // 0. CANONICAL CONTRACT BENCHMARK: Polymarket Chainlink 60s TWAP Candle Open (Absolute Truth)
        try {
          const candleStrike = await fetchPolymarketChainlinkCandleOpen(sym, '15m', windowTs, _twapLookbackSeconds(m), false);
          if (candleStrike != null && candleStrike > 0) {
            priceToBeatNum = candleStrike;
            priceToBeatSource = 'polymarket-contract';
          }
        } catch (_) {}
        const hasTwapSettled = nowSec >= windowTs + _twapLookbackSeconds(m) + 2;
        // 0. CANONICAL CONTRACT BENCHMARK: Polymarket Chainlink 60s TWAP Candle Open (Absolute Truth)
        if (hasTwapSettled) {
          try {
            const candleStrike = await fetchPolymarketChainlinkCandleOpen(sym, '15m', windowTs, _twapLookbackSeconds(m), false);
            if (candleStrike != null && candleStrike > 0) {
              priceToBeatNum = candleStrike;
              priceToBeatSource = 'polymarket-contract';
            }
          } catch (_) {}
        }

        // 1. Direct Polymarket Contract Benchmark posted on metadata
        const directContractStrike = toPositiveFiniteNumber(
          m.eventMetadata?.priceToBeat
          ?? m.eventMetadata?.price_to_beat
          ?? m.priceToBeat
          ?? m.price_to_beat
          ?? m.targetPrice
          ?? m.target_price
          ?? m.strikePrice
        );
        if (directContractStrike != null && directContractStrike > 0) {
          priceToBeatNum = directContractStrike;
          priceToBeatSource = 'gamma-market';
        }

        // 2. Direct Polymarket contract event page (opening strike, not live TWAP)
        if (priceToBeatNum == null) {
          try {
            const scraped = await fetchPolymarketPriceToBeat(marketSlug);
            if (Number.isFinite(scraped) && scraped > 0) {
              priceToBeatNum = scraped;
              priceToBeatSource = 'polymarket-event-page';
            }
          } catch (_) {}
        }

        if (priceToBeatNum != null) {
          // Same confirmation-bypass hazard as the 5m path above: an unconfirmed
          // single read (locked falsy) must not flow through as this market's
          // priceToBeatNum. Revert to pending; the next poll supplies the second,
          // time-separated read that actually confirms it.
          const locked = _lockPolymarketPriceToBeat(slug, priceToBeatNum, priceToBeatSource)
            || _lockPolymarketPriceToBeat(marketSlug, priceToBeatNum, priceToBeatSource);
          if (locked) {
            priceToBeatNum = locked.price;
            priceToBeatSource = locked.source;
          } else {
            priceToBeatNum = null;
            priceToBeatSource = null;
          }
        }
      }

      console.log(`[Poly15M-PTB] ${sym} ${marketSlug} → $${priceToBeatNum ?? 'pending'} (source: ${priceToBeatSource ?? 'waiting-for-open'})`);

      const clobTokenIds = _polyClobTokenIds(m);
      const conditionId = m.conditionId || m.condition_id || null;
      const questionID = m.questionID || m.question_id || null;
      const yesTokenId = m.yesTokenId || clobTokenIds[_polyOutcomeIndex(m, 'up', 0)] || clobTokenIds[0] || null;
      const noTokenId = m.noTokenId || clobTokenIds[_polyOutcomeIndex(m, 'down', 1)] || clobTokenIds[1] || null;
      const marketId = m.marketId || m.id || null;
      const eventId = m.eventId || m.events?.[0]?.id || m._eventFallback?.id || null;
      const pythCurrent = await getFreshPythLazerPrice(sym);
      const pythPriceNum = pythCurrent?.price ?? toPositiveFiniteNumber(typeof window !== 'undefined' && (window.PythBrowser?.getPrice?.(sym) || window._pythPrices?.[sym]));
      const currentPriceNum = pythPriceNum ?? null;
      const hasLiveComparison = currentPriceNum != null && Number.isFinite(priceToBeatNum) && priceToBeatNum > 0;
      const priceDeltaNum = hasLiveComparison ? currentPriceNum - priceToBeatNum : null;
      const liveDirection = hasLiveComparison ? (priceDeltaNum >= 0 ? 'UP' : 'DOWN') : null;

      const data = {
        slug: marketSlug,
        ticker: marketSlug,
        contractSlug: marketSlug,
        contractTicker: marketSlug,
        conditionId,
        questionID,
        questionId: questionID,
        clobTokenIds,
        yesTokenId,
        noTokenId,
        marketId,
        eventId,
        eventMetadata: m.eventMetadata || null,
        title,
        probability: liveUpProb,
        gammaProbability: upProb,
        clobProbability: Number.isFinite(clobProb) ? clobProb : null,
        upProbability: Number.isFinite(clobProb) ? clobProb : liveUpProb,
        priceToBeatNum,
        priceToBeatSource,
        targetPriceNum: priceToBeatNum,
        targetPrice: _formatPolyPriceToBeat(priceToBeatNum, sym),
        currentPriceNum,
        currentPrice: _formatPolyPriceToBeat(currentPriceNum, sym),
        priceDeltaNum,
        liveDirection,
        startDate,
        closeTime: endDate,
        volume,
      };
      _attachClobMicroFields(data, clobSnapshot, m);
      _poly15mCache[sym] = { windowTs, fetchedAt: Date.now(), data };
      return data;
    } catch (err) {
      console.warn(`[PredictionMarkets] Poly15M fetch failed for ${sym} ${slug}:`, err?.message || err);
      return null;
    }
  }


  // ── Polymarket 60-minute / hourly pull ──────────────────────────────────
  // Same immutable-at-open model as 5m and 15m. Slug candidates:
  //   {prefix}-updown-1h-{hourStart}  and  {prefix}-updown-60m-{hourStart}
  const _poly60mCache = Object.create(null);

  async function fetchPolymarket60MBySlug(sym) {
    const coinSlugPrefix = POLY_5M_COIN_SLUGS[sym];
    if (!coinSlugPrefix) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 3600);
    const cached = _poly60mCache[sym];
    if (cached && cached.windowTs === windowTs && Date.now() - cached.fetchedAt < (cached.data?.priceToBeatNum != null ? 60_000 : 5_000)) {
      return cached.data;
    }

    const slugCandidates = [
      `${coinSlugPrefix}-updown-1h-${windowTs}`,
      `${coinSlugPrefix}-updown-60m-${windowTs}`,
    ];
    try {
      let hit = null;
      let slug = slugCandidates[0];
      for (const candidate of slugCandidates) {
        const tried = await fetchPolymarket5MMarketCandidate(sym, candidate);
        if (tried?.market) { hit = tried; slug = candidate; break; }
      }
      const m = hit?.market;
      if (!m) return null;
      const upProb = _parseUpProb(m);
      if (upProb === null) return null;

      const title = m.question || m.title || `${sym} Up or Down 1H`;
      const endDate = m.endDate || m.end_date_iso || m.end_date || null;
      const startDate = new Date(windowTs * 1000).toISOString();
      const volume = parseFloat(m.volume24hr || m.volumeNum || m.volume || 0) || 0;
      const marketSlug = m.slug || slug;

      const clobSnapshot = await fetchPolymarketClobMarketSnapshot(sym, m);
      const clobProb = Number(clobSnapshot?.upProbability);
      const liveUpProb = Number.isFinite(clobProb) && clobProb >= 0.01 && clobProb <= 0.99
        ? clobProb
        : upProb;

      let priceToBeatNum = null;
      let priceToBeatSource = null;

      const existingLock = _getPolymarketPriceToBeatLock(slug) || _getPolymarketPriceToBeatLock(marketSlug);
      if (existingLock) {
        priceToBeatNum = existingLock.price;
        priceToBeatSource = existingLock.source;
      } else {
        const directContractStrike = toPositiveFiniteNumber(
          m.eventMetadata?.priceToBeat
          ?? m.eventMetadata?.price_to_beat
          ?? m.priceToBeat
          ?? m.price_to_beat
          ?? m.targetPrice
          ?? m.target_price
          ?? m.strikePrice
        );
        if (directContractStrike != null && directContractStrike > 0) {
          priceToBeatNum = directContractStrike;
          priceToBeatSource = 'gamma-market';
        }
        if (priceToBeatNum == null) {
          try {
            const scraped = await fetchPolymarketPriceToBeat(marketSlug) || await fetchPolymarketPriceToBeat(slug);
            if (Number.isFinite(scraped) && scraped > 0) {
              priceToBeatNum = scraped;
              priceToBeatSource = 'polymarket-event-page';
            }
          } catch (_) {}
        }
        if (priceToBeatNum != null) {
          const locked = _lockPolymarketPriceToBeat(slug, priceToBeatNum, priceToBeatSource)
            || _lockPolymarketPriceToBeat(marketSlug, priceToBeatNum, priceToBeatSource);
          if (locked) {
            priceToBeatNum = locked.price;
            priceToBeatSource = locked.source;
          }
        }
      }

      console.log(`[Poly60M-PTB] ${sym} ${marketSlug} → $${priceToBeatNum ?? 'pending'} (source: ${priceToBeatSource ?? 'waiting-for-open'})`);

      const clobTokenIds = _polyClobTokenIds(m);
      const conditionId = m.conditionId || m.condition_id || null;
      const questionID = m.questionID || m.question_id || null;
      const yesTokenId = m.yesTokenId || clobTokenIds[_polyOutcomeIndex(m, 'up', 0)] || clobTokenIds[0] || null;
      const noTokenId = m.noTokenId || clobTokenIds[_polyOutcomeIndex(m, 'down', 1)] || clobTokenIds[1] || null;
      const marketId = m.marketId || m.id || null;
      const eventId = m.eventId || m.events?.[0]?.id || m._eventFallback?.id || null;
      const pythCurrent = await getFreshPythLazerPrice(sym);
      const pythPriceNum = pythCurrent?.price ?? toPositiveFiniteNumber(typeof window !== 'undefined' && (window.PythBrowser?.getPrice?.(sym) || window._pythPrices?.[sym]));
      const currentPriceNum = pythPriceNum ?? null;
      const hasLiveComparison = currentPriceNum != null && Number.isFinite(priceToBeatNum) && priceToBeatNum > 0;
      const priceDeltaNum = hasLiveComparison ? currentPriceNum - priceToBeatNum : null;
      const liveDirection = hasLiveComparison ? (priceDeltaNum >= 0 ? 'UP' : 'DOWN') : null;

      const data = {
        slug: marketSlug,
        ticker: marketSlug,
        contractSlug: marketSlug,
        contractTicker: marketSlug,
        conditionId,
        questionID,
        questionId: questionID,
        clobTokenIds,
        yesTokenId,
        noTokenId,
        marketId,
        eventId,
        eventMetadata: m.eventMetadata || null,
        title,
        probability: liveUpProb,
        gammaProbability: upProb,
        clobProbability: Number.isFinite(clobProb) ? clobProb : null,
        upProbability: Number.isFinite(clobProb) ? clobProb : liveUpProb,
        priceToBeatNum,
        priceToBeatSource,
        targetPriceNum: priceToBeatNum,
        targetPrice: _formatPolyPriceToBeat(priceToBeatNum, sym),
        currentPriceNum,
        currentPrice: _formatPolyPriceToBeat(currentPriceNum, sym),
        priceDeltaNum,
        liveDirection,
        startDate,
        closeTime: endDate,
        volume,
        horizon: '60m',
      };
      _attachClobMicroFields(data, clobSnapshot, m);
      _poly60mCache[sym] = { windowTs, fetchedAt: Date.now(), data };
      return data;
    } catch (err) {
      console.warn(`[PredictionMarkets] Poly60M fetch failed for ${sym}:`, err?.message || err);
      return null;
    }
  }

  let _refreshPoly60MInFlight = null;

  async function refreshPoly60M(reason = 'manual') {
    if (_refreshPoly60MInFlight) return _refreshPoly60MInFlight;
    _refreshPoly60MInFlight = _doRefreshPoly60M(reason).finally(() => { _refreshPoly60MInFlight = null; });
    return _refreshPoly60MInFlight;
  }

  async function _doRefreshPoly60M(reason) {
    const results = Object.create(null);
    await Promise.all(Object.keys(POLY_5M_COIN_SLUGS).map(async sym => {
      results[sym] = await fetchPolymarket60MBySlug(sym);
    }));
    let touched = false;
    for (const [sym, poly60m] of Object.entries(results)) {
      if (!poly60m) continue;
      const prev = cache[sym]?.poly60m;
      const merged = (poly60m.priceToBeatNum == null && prev?.slug === poly60m.slug && prev?.priceToBeatNum != null)
        ? {
          ...poly60m,
          priceToBeatNum: prev.priceToBeatNum,
          priceToBeatSource: prev.priceToBeatSource,
          targetPriceNum: prev.priceToBeatNum,
          targetPrice: prev.targetPrice,
        }
        : poly60m;
      cache[sym] = { ...(cache[sym] || {}), poly60m: merged };
      touched = true;
    }
    if (touched) {
      window.dispatchEvent(new CustomEvent('predictionmarketsready', { detail: cache }));
    }
    console.info(`[PredictionMarkets] Poly60M refresh (${reason}): ${Object.entries(results).filter(([, v]) => v).map(([sym]) => sym).join(', ') || 'none'}`);
    return results;
  }

  let _refreshPoly15MInFlight = null;

  async function refreshPoly15M(reason = 'manual') {
    // refreshPoly15M is triggered from several independent places (the 20s
    // interval, boundary-clock rollovers, start()) with no coordination
    // between them. This doesn't fix any bug by itself (the actual PTB
    // flicker turned out to be _doFetch dropping the poly15m field on every
    // cache rebuild, see next[sym] below) -- it's a plain de-duplication
    // guard so overlapping calls don't do redundant network work.
    if (_refreshPoly15MInFlight) return _refreshPoly15MInFlight;
    _refreshPoly15MInFlight = _doRefreshPoly15M(reason).finally(() => { _refreshPoly15MInFlight = null; });
    return _refreshPoly15MInFlight;
  }

  async function _doRefreshPoly15M(reason) {
    const results = Object.create(null);
    await Promise.all(Object.keys(POLY_5M_COIN_SLUGS).map(async sym => {
      results[sym] = await fetchPolymarket15MBySlug(sym);
    }));

    let touched = false;
    for (const [sym, poly15m] of Object.entries(results)) {
      if (!poly15m) continue;
      const prev = cache[sym]?.poly15m;
      // Defense in depth on top of the in-flight guard above: never let a
      // missing/null PTB clobber an already-known good one for the SAME
      // window (same slug). Whatever the cause, regressing a real number
      // back to "pending" is the one thing that must never happen.
      const merged = (poly15m.priceToBeatNum == null && prev?.slug === poly15m.slug && prev?.priceToBeatNum != null)
        ? {
          ...poly15m,
          priceToBeatNum: prev.priceToBeatNum,
          priceToBeatSource: prev.priceToBeatSource,
          targetPriceNum: prev.priceToBeatNum,
          targetPrice: prev.targetPrice,
        }
        : poly15m;
      // Don't drop this on the floor if the coin's base cache entry hasn't
      // been created by fetchAll() yet (real race at app start: refreshPoly15M
      // fires immediately in start(), same tick as the un-awaited fetchAll()).
      cache[sym] = { ...(cache[sym] || {}), poly15m: merged };
      touched = true;
    }
    if (touched) {
      window.dispatchEvent(new CustomEvent('predictionmarketsready', { detail: cache }));
    }
    console.info(`[PredictionMarkets] Poly15M refresh (${reason}): ${Object.entries(results).filter(([, v]) => v).map(([sym]) => sym).join(', ') || 'none'}`);
    return results;
  }

  // ---- Public API ---------------------------------------------------

  window.PredictionMarkets = {
    start() {
      if (PredictionMarkets._started) return;
      PredictionMarkets._started = true;
      if (!KALSHI_DISABLED) window.EndpointTransport?.ensureKalshiWs?.();
      if (!PredictionMarkets._tickerBound) {
        PredictionMarkets._tickerBound = true;
        window.addEventListener('kalshi:ticker', onKalshiTicker);
      }
      if (timer) return;
      fetchAll();
      _ensurePolymarketRtdsSocket();
      // If the app just (re)started within the grace window of an already-
      // open 5m/15m window, seed a lock attempt for it too -- otherwise it
      // would sit pending until that window's own next rollover, minutes
      // away. _tickPendingPtbLocks' own grace-window check (PTB_LOCK_GRACE_MS)
      // already makes this a no-op if the window opened too long ago to
      // still be a valid "opening price" sample, so this is safe either way.
      (() => {
        const nowSec0 = Math.floor(Date.now() / 1000);
        const boundary5 = nowSec0 - (nowSec0 % 300);
        const boundary15 = nowSec0 - (nowSec0 % 900);
        const boundary60 = nowSec0 - (nowSec0 % 3600);
        Object.keys(POLY_5M_COIN_SLUGS).forEach((sym) => {
          const prefix = POLY_5M_COIN_SLUGS[sym];
          _seedPendingPtbLock(sym, `${prefix}-updown-5m-${boundary5}`, boundary5 * 1000);
          _seedPendingPtbLock(sym, `${prefix}-updown-15m-${boundary15}`, boundary15 * 1000);
          _seedPendingPtbLock(sym, `${prefix}-updown-1h-${boundary60}`, boundary60 * 1000);
          _seedPendingPtbLock(sym, `${prefix}-updown-60m-${boundary60}`, boundary60 * 1000);
        });
      })();
      timer = setInterval(() => { if (!document.hidden) fetchAll(); }, POLL_MS);
      // Fast-poll: when any 15M contract is < 2 min from close, re-fetch Kalshi every 10s.
      // Ensures price is at most 10s stale for last-call trades.
      setInterval(() => {
        if (document.hidden || inFlight) return;
        const now = Date.now();
        const nearClose = Object.values(cache).some(c => {
          const ct = c && c.kalshi15m && c.kalshi15m.closeTime;
          if (!ct) return false;
          const ms = new Date(ct).getTime() - now;
          return ms > 0 && ms < 120_000;
        });
        if (nearClose) fetchAll();
      }, 10_000);

      // High-precision clock for 5m boundaries to handle instant rollover, settlement, and pre-fetching
      let lastBoundarySec = 0;
      let lastBoundary15Sec = 0;
      let lastBoundary60Sec = 0;
      let prefetchTriggered = false;
      setInterval(() => {
        if (document.hidden) return;
        const nowMs = Date.now();
        const nowSec = Math.floor(nowMs / 1000);
        const secInPeriod = nowSec % 300;

        // 1. Pre-fetch trigger: 30 seconds before the 5-minute boundary (pre-warm candidates only; NEVER lock PTB before boundary opens)
        if (secInPeriod >= 270 && !prefetchTriggered) {
          prefetchTriggered = true;
          const currentBoundary = nowSec - secInPeriod;
          const nextBoundary = currentBoundary + 300;
          console.info(`[BoundaryClock] ⏱ 30s to 5m boundary (${nextBoundary}). Pre-warming candidate structure for upcoming contracts.`);
          Object.keys(POLY_5M_COIN_SLUGS).forEach(async (sym) => {
            try {
              const prefix = POLY_5M_COIN_SLUGS[sym];
              const nextSlug = `${prefix}-updown-5m-${nextBoundary}`;
              await fetchPolymarket5MMarketCandidate(sym, nextSlug).catch(() => null);
            } catch (_) {}
          });
        }

        // Reset prefetch trigger when we are in a new period
        if (secInPeriod < 270) {
          prefetchTriggered = false;
        }

        // 2. Rollover trigger: Exactly at the boundary
        const currentBoundary = nowSec - secInPeriod;
        if (currentBoundary > lastBoundarySec && lastBoundarySec > 0) {
          lastBoundarySec = currentBoundary;
          console.info(`[BoundaryClock] 🏁 5-minute boundary rollover hit (${currentBoundary})! Executing instant local rollover.`);

          let touched = false;
          Object.keys(POLY_5M_COIN_SLUGS).forEach(sym => {
            const coin = cache[sym];
            if (coin && coin.poly5mMkts && coin.poly5mMkts.length) {
              const nextMkt = coin.poly5mMkts.find(m => m.ts === currentBoundary);
              if (nextMkt) {
                const liveOpenTwap = _rtdsLiveTwap[sym]?.price;
                // Canonical PTB only: already-resolved next market fields, or null.
                // NEVER lock RTDS TWAP as PTB — it is not Polymarket's published
                // Price to Beat and an immutable lock would poison the whole window.
                const hasCanonical = Number.isFinite(nextMkt.targetPriceNum) && nextMkt.targetPriceNum > 0
                  && nextMkt.priceToBeatSource
                  && POLY5M_PTB_TRUSTED_SOURCES.has(nextMkt.priceToBeatSource);
                const initialPtb = hasCanonical ? nextMkt.targetPriceNum : null;
                const initialPtbStr = hasCanonical
                  ? (nextMkt.targetPrice || _formatPolyPriceToBeat(initialPtb, sym))
                  : null;
                const ptbSource = hasCanonical ? nextMkt.priceToBeatSource : null;
                if (initialPtb != null) {
                  _lockPolymarketPriceToBeat(nextMkt.slug, initialPtb, ptbSource);
                }
                const updatedPoly5m = {
                  probability: nextMkt.yes,
                  gammaProbability: nextMkt.gammaYes,
                  clobProbability: nextMkt.clobYes,
                  volume: nextMkt.vol24h,
                  title: nextMkt.question,
                  slug: nextMkt.slug,
                  closeTime: nextMkt.endDate,
                  endDate: nextMkt.endDate,
                  startDate: new Date(currentBoundary * 1000).toISOString(),
                  bestBid: null,
                  bestAsk: null,
                  liquidity: 0,
                  targetPrice: initialPtbStr,
                  targetPriceNum: initialPtb,
                  priceToBeat: initialPtbStr,
                  priceToBeatNum: initialPtb,
                  priceToBeatSource: ptbSource,
                  // Provisional open TWAP is spot context only — not PTB
                  provisionalOpenTwap: liveOpenTwap > 0 ? liveOpenTwap : null,
                  currentPrice: liveOpenTwap ? _formatPolyPriceToBeat(liveOpenTwap, sym) : null,
                  currentPriceNum: liveOpenTwap || null,
                  currentPriceTs: _rtdsLiveTwap[sym]?.obsTs || Date.now(),
                  currentPriceSource: liveOpenTwap ? 'polymarket-rtds-twap60' : null,
                  currentPriceAgeMs: 0,
                  currentPriceJustification: 'Opening Chainlink 60s TWAP is spot context only. PTB stays pending until Polymarket publishes contract price-to-beat.',
                  markets: coin.poly5mMkts.map(m => ({
                    ...m,
                    isFuture: m.ts > currentBoundary
                  })),
                  _source: 'local-rollover',
                  _windowTs: currentBoundary
                };
                
                cache[sym] = {
                  ...coin,
                  poly5m: updatedPoly5m,
                  poly5mSlug: updatedPoly5m,
                  poly5mMkts: updatedPoly5m.markets,
                  sources: [
                    ...(coin.sources || []).filter(s => s.name !== 'Poly5M'),
                    { name: 'Poly5M', prob: updatedPoly5m.probability, vol: updatedPoly5m.volume || 1 }
                  ]
                };
                touched = true;
              }
            }
            _poly5mCache[sym] = null;
          });

          if (touched) {
            window.dispatchEvent(new CustomEvent('predictionmarketsready', { detail: cache }));
          }

          // At exact rollover, seed a retry-backed PTB lock attempt for this
          // window (see _tickPendingPtbLocks -- a single attempt right here
          // missed too often and left PTB stuck on "pending" for the whole
          // window instead of resolving within seconds).
          Object.keys(POLY_5M_COIN_SLUGS).forEach((sym) => {
            const prefix = POLY_5M_COIN_SLUGS[sym];
            const newSlug = `${prefix}-updown-5m-${currentBoundary}`;
            _seedPendingPtbLock(sym, newSlug, currentBoundary * 1000);
          });

          // Trigger background fetch to get actual PTB and live pricing
          refreshPoly5M('boundary-clock').catch(() => {});
          fetchAll().catch(() => {});
        } else if (lastBoundarySec === 0) {
          lastBoundarySec = currentBoundary;
        }

        // Same exact-instant PTB capture for the 15-minute Up/Down contracts,
        // piggybacking on this same 1s clock tick rather than a second timer.
        const secIn15 = nowSec % 900;
        const boundary15 = nowSec - secIn15;
        if (boundary15 > lastBoundary15Sec && lastBoundary15Sec > 0) {
          lastBoundary15Sec = boundary15;
          Object.keys(POLY_5M_COIN_SLUGS).forEach((sym) => {
            const prefix = POLY_5M_COIN_SLUGS[sym];
            const newSlug15 = `${prefix}-updown-15m-${boundary15}`;
            _seedPendingPtbLock(sym, newSlug15, boundary15 * 1000);
          });
          refreshPoly15M('boundary-clock').catch(() => {});
        } else if (lastBoundary15Sec === 0) {
          lastBoundary15Sec = boundary15;
        }

        // Same exact-instant PTB capture for hourly (60m) Up/Down contracts.
        const secIn60 = nowSec % 3600;
        const boundary60 = nowSec - secIn60;
        if (boundary60 > lastBoundary60Sec && lastBoundary60Sec > 0) {
          lastBoundary60Sec = boundary60;
          Object.keys(POLY_5M_COIN_SLUGS).forEach((sym) => {
            const prefix = POLY_5M_COIN_SLUGS[sym];
            _seedPendingPtbLock(sym, `${prefix}-updown-1h-${boundary60}`, boundary60 * 1000);
            _seedPendingPtbLock(sym, `${prefix}-updown-60m-${boundary60}`, boundary60 * 1000);
          });
          refreshPoly60M('boundary-clock').catch(() => {});
        } else if (lastBoundary60Sec === 0) {
          lastBoundary60Sec = boundary60;
        }

        _tickPendingPtbLocks();
      }, 1000);

      // One-shot hydrate; ongoing 15m/60m PTB is owned by _doFetch (15s) plus
      // the exact-boundary clocks above. A second 20s 15m timer was racing
      // _doFetch and double-locking the same contract.
      refreshPoly15M('start').catch(() => {});
      refreshPoly60M('start').catch(() => {});
    },
    getAll() {
      const result = {};
      const keys = new Set([...Object.keys(cache), ...Object.keys(POLY_5M_COIN_SLUGS)]);
      for (const sym of keys) {
        const c = cache[sym];
        const p15 = c?.poly15m || _poly15mCache[sym]?.data || null;
        if (c || p15) {
          result[sym] = { ...(c || {}), poly15m: p15 };
        }
      }
      return result;
    },
    getCoin(sym) {
      const c = cache[sym];
      const p15 = c?.poly15m || _poly15mCache[sym]?.data || null;
      if (!c && !p15) return null;
      return { ...(c || {}), poly15m: p15 };
    },
    getSnipes() { return detectSnipes(cache); },
    // Funding-rate bias for a coin: { avg, bias, strength, sources } or null.
    // Populated by cfm-engine.js _computeFundingBias() after each poll cycle.
    getFundingBias(sym) { return window._cfm?.[sym]?.fundingBias || null; },
    // Fear & Greed Index: { value, label, ts } or null.
    // Fetched by cfm-engine.js fetchFNG() every 5 minutes.
    getFNG() { return window._cfm?._fng || null; },
    getVelocity(sym) { return getProbVelocity(sym); },
    getAllVelocities() { return Object.fromEntries(Object.keys(KALSHI_15M_SERIES).map(s => [s, getProbVelocity(s)])); },
    getStatus() {
      const wsStatus = (typeof window !== 'undefined' && window.PolymarketWS?.getStatus)
        ? window.PolymarketWS.getStatus()
        : null;
      return {
        lastFetch,
        age: lastFetch ? Date.now() - lastFetch : null,
        hasData: Object.keys(cache).length > 0,
        coinCount: Object.values(cache).filter(c => c.combinedProb !== null).length,
        poly5mCount: Object.values(cache).filter(c => c.poly5m?.probability != null).length,
        poly15mCount: Object.values(cache).filter(c => c.poly15m?.probability != null).length,
        poly60mCount: Object.values(cache).filter(c => c.poly60m?.probability != null).length,
        polymarket: {
          lastFetch: _polyLastFetch,
          age: _polyLastFetch ? Date.now() - _polyLastFetch : null,
          hasData: Array.isArray(_polyCache) && _polyCache.length > 0,
          marketCount: Array.isArray(_polyCache) ? _polyCache.length : 0,
          lastError: _polyLastError || null,
          source: _polyLastSource || null,
          poly5mCount: Object.values(cache).filter(c => c.poly5m?.probability != null).length,
          // Shared CLOB+RTDS owner (no duplicate WS from this module)
          clobWs: wsStatus,
        },
      };
    },
    fetchAll,
    refreshPoly5M,
    refreshPoly15M,
    refreshPoly60M,
    getFreshRtdsTwap: _getFreshRtdsTwap,
    _getCachedChainlinkCandle,
    POLY_5M_COIN_SLUGS,
  };

  if (window.__WE_TEST__) {
    window.__PredictionMarketsTestHooks = {
      fetchPolymarket5MBySlug,
      fetchPolymarketPriceToBeat,
      _coercePolyMarketFromEvent,
      _formatPolyPriceToBeat,
      _isTradablePoly5M,
      _parseGenericPriceToBeat,
      _parsePolymarketPriceToBeat,
      _parseUpProb,
      POLY_TWAP_LOOKBACK_SEC,
      PTB_TWAP_SETTLE_SEC,
      POLY5M_PTB_LOCK_VERSION,
      _lockPolymarketPriceToBeat,
      getFreshPythLazerPrice,
      _filteredPythPrice,
      _pythPriceFilters,
      PYTH_PRICE_FILTER_HZ,
      _getPolymarketPriceToBeatLock,
      PTB_CONFIRM_MIN_GAP_MS,
      PTB_CONFIRM_TOLERANCE,
      PTB_LOCK_GRACE_MS,
    };
  }

  if (typeof window !== 'undefined' && window.PredictionMarkets && typeof window.PredictionMarkets.start === 'function') {
    try { window.PredictionMarkets.start(); } catch (_) {}
  }

})();
