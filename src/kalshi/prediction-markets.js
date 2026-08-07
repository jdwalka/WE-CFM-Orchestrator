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

  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const POLY_GAMMA = 'https://gamma-api.polymarket.com';
  const POLY_CLOB = 'https://clob.polymarket.com';
  const POLY_CLOB_MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
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

  let cache = {};
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
  const _probHistory = {};
  const PROB_HIST_MAX = 12;

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
    if (typeof window.suppFetch === 'function') {
      try {
        return await readJsonPayload(await window.suppFetch(url, opts));
      } catch (err) {
        console.warn(`[PredictionMarkets] suppFetch failed for ${url}:`, err?.message || err);
      }
    }
    // Try IPC fetch (main process, no CORS) when running in Electron
    if (window.electron?.ipcFetch) {
      try {
        const r = await window.electron.ipcFetch(url, opts);
        if (r.ok) return typeof r.text === 'string' ? JSON.parse(r.text) : r.text;
        throw new Error(`HTTP ${r.status || 0}${r.error ? ` ${r.error}` : ''}`);
      } catch (err) {
        console.warn(`[PredictionMarkets] ipcFetch failed for ${url}:`, err?.message || err);
      }
    }
    const res = await fetch(url, { headers: { Accept: 'application/json' }, ...opts });
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
    const requestOpts = { headers: { Accept: 'text/html,application/json,*/*' }, ...opts };
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
    const res = await fetch(url, requestOpts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
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
    if (data && transport) {
      try {
        const wsState = window.KalshiWS?.getState?.() || {};
        const isWsHealthy = wsState.connected && !wsState.stale;
        const isPrimaryRest = transport === 'ipc-sdk' || transport === 'ipc-sdk-empty';
        window.NetworkHealth?.update?.('Kalshi', {
          status: 'healthy',
          lastFetch: Date.now(),
          fallback: !isWsHealthy && !isPrimaryRest,
          reason: isWsHealthy ? 'wss' : transport,
          bucket: 'unknown',
          bucketReason: '',
        });
      } catch (_) { }
    }
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

  const PYTH_LAZER_PRICE_FEED_IDS = { BTC: 1, ETH: 2, SOL: 6, DOGE: 10, XRP: 14, BNB: 15 };
  let _pythRealtimeSnapshot = { fetchedAt: 0, prices: null, inFlight: null };

  async function loadPythRealtimeSnapshot(maxAgeMs) {
    const now = Date.now();
    if (_pythRealtimeSnapshot.prices && now - _pythRealtimeSnapshot.fetchedAt <= 1_000) {
      return _pythRealtimeSnapshot.prices;
    }
    if (_pythRealtimeSnapshot.inFlight) return _pythRealtimeSnapshot.inFlight;

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
          return { price: val, timestamp: Date.now(), ageMs: 0, source: 'pyth-hermes-v2' };
        }
      }
      return null;
    }
    const ageMs = Date.now() - timestamp;
    if (ageMs < 0 || ageMs > maxAgeMs) {
      if (typeof window !== 'undefined' && window._pythPrices?.[sym]) {
        const val = typeof window._pythPrices[sym] === 'number' ? window._pythPrices[sym] : window._pythPrices[sym]?.price;
        if (val != null && Number.isFinite(val) && val > 0) {
          return { price: val, timestamp: Date.now(), ageMs: 0, source: 'pyth-hermes-v2-fallback' };
        }
      }
      return null;
    }
    return { price, timestamp, ageMs, source };
  }


  // --- Chainlink / RTDS helpers for PTB (ported for robustness) ---
  async function fetchPolymarketRtdsSnapshot(sym, startMs) {
    // Attempts to get exact Chainlink opening/current used by Polymarket contract.
    // Falls back to Pyth as proxy when direct RTDS not available.
    // Full impl would call Polymarket RTDS or Chainlink archival for precise open price at startMs.
    try {
      // Use lenient load for PTB windows (accept up to 2min old for open proxy on active windows)
      const snapshot = await loadPythRealtimeSnapshot(120_000);
      const ticker = snapshot?.[`${sym}USD`];
      const price = toPositiveFiniteNumber(ticker?.last);
      const ts = toPositiveFiniteNumber(ticker?.timestamp);
      if (price != null) {
        return {
          openingPriceNum: price,
          currentPriceNum: price,
          currentPriceTs: ts || Date.now(),
          timestamp: Date.now(),
          source: 'polymarket-rtds-chainlink-open'
        };
      }
      const pyth = await getFreshPythLazerPrice(sym, 120_000);
      if (pyth && pyth.price) {
        return {
          openingPriceNum: pyth.price,
          currentPriceNum: pyth.price,
          currentPriceTs: pyth.timestamp,
          timestamp: Date.now(),
          source: 'polymarket-rtds-chainlink-open'
        };
      }
    } catch (e) { }
    return null;
  }

  async function fetchPolymarketCryptoWindowPrice(sym, startMs) {
    // Returns price window around contract start (open/close).
    // Uses Pyth or other live as proxy for open. Lenient for PTB on active 5m.
    try {
      const snapshot = await loadPythRealtimeSnapshot(120_000);
      const ticker = snapshot?.[`${sym}USD`];
      const price = toPositiveFiniteNumber(ticker?.last);
      const ts = toPositiveFiniteNumber(ticker?.timestamp);
      if (price != null) {
        return {
          openPrice: price,
          closePrice: price,
          timestamp: ts || startMs || Date.now()
        };
      }
      const pyth = await getFreshPythLazerPrice(sym, 120_000);
      if (pyth && pyth.price) {
        return {
          openPrice: pyth.price,
          closePrice: pyth.price,
          timestamp: pyth.timestamp || startMs
        };
      }
    } catch (e) { }
    return null;
  }

  function toPositiveFiniteNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // --- Chainlink / RTDS helpers for PTB (ported for robustness) ---
  async function fetchPolymarketRtdsSnapshot(sym, startMs) {
    // Attempts to get exact Chainlink opening/current used by Polymarket contract.
    // Falls back to Pyth as proxy when direct RTDS not available.
    // Full impl would call Polymarket RTDS or Chainlink archival for precise open price at startMs.
    try {
      // Use lenient load for PTB windows (accept up to 2min old for open proxy on active windows)
      const snapshot = await loadPythRealtimeSnapshot(120_000);
      const ticker = snapshot?.[`${sym}USD`];
      const price = toPositiveFiniteNumber(ticker?.last);
      const ts = toPositiveFiniteNumber(ticker?.timestamp);
      if (price != null) {
        return {
          openingPriceNum: price,
          currentPriceNum: price,
          currentPriceTs: ts || Date.now(),
          timestamp: Date.now(),
          source: 'polymarket-rtds-chainlink-open'
        };
      }
      const pyth = await getFreshPythLazerPrice(sym, 120_000);
      if (pyth && pyth.price) {
        return {
          openingPriceNum: pyth.price,
          currentPriceNum: pyth.price,
          currentPriceTs: pyth.timestamp,
          timestamp: Date.now(),
          source: 'polymarket-rtds-chainlink-open'
        };
      }
    } catch (e) { }
    return null;
  }

  async function fetchPolymarketCryptoWindowPrice(sym, startMs) {
    // Returns price window around contract start (open/close).
    // Uses Pyth or other live as proxy for open. Lenient for PTB on active 5m.
    try {
      const snapshot = await loadPythRealtimeSnapshot(120_000);
      const ticker = snapshot?.[`${sym}USD`];
      const price = toPositiveFiniteNumber(ticker?.last);
      const ts = toPositiveFiniteNumber(ticker?.timestamp);
      if (price != null) {
        return {
          openPrice: price,
          closePrice: price,
          timestamp: ts || startMs || Date.now()
        };
      }
      const pyth = await getFreshPythLazerPrice(sym, 120_000);
      if (pyth && pyth.price) {
        return {
          openPrice: pyth.price,
          closePrice: pyth.price,
          timestamp: pyth.timestamp || startMs
        };
      }
    } catch (e) { }
    return null;
  }

  function toPositiveFiniteNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
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
    const targetPrice = targetPriceNum != null ? `$${targetPriceNum.toLocaleString()}` : null;

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

  async function fetchKalshi15M() {
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
      const series5m = KALSHI_5M_SERIES[sym] || null;

      // 1. Try dedicated 5M series (e.g. KXBTC5M)
      let data = series5m ? await fetchKalshiSeriesForSym(series5m, {
        suppressWarnings: true,
        bucketMs: BUCKET_MS_5M,
        minTradableMs: MIN_TRADABLE_MS_5M,
        strictQuarterHour: false,
      }) : null;

      // 2. Fallback: use strict 15M quarter-hour contract as 5M proxy
      // Skip if we just got empty success for 5m or are rate-limited
      if (!data && _rateLimitUntil <= Date.now()) {
        const baseSeries = KALSHI_15M_SERIES[sym];
        const d = await kalshiFetch(`${KALSHI_BASE}/markets?series_ticker=${baseSeries}&status=open&limit=${KALSHI_MARKET_LIMIT}`);
        const m = selectKalshiContract(d?.markets || [], {
          nowMs: Date.now(),
          bucketMs: BUCKET_MS_15M,
          minTradableMs: MIN_TRADABLE_MS_15M_PROXY,
          strictQuarterHour: true,
        });
        if (m) {
          data = buildKalshiContractData(m, { _proxy15m: true });
        }
      }
      result[sym] = data;
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

  function _bestBidAskFromBookRows(rows, side) {
    if (!Array.isArray(rows) || !rows.length) return null;
    let best = null;
    for (const row of rows) {
      const price = Number(row?.price);
      if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
      if (best == null) {
        best = price;
      } else if (side === 'bid') {
        best = Math.max(best, price);
      } else {
        best = Math.min(best, price);
      }
    }
    return best;
  }

  function _coercePolyMarketFromEvent(event, expectedSlug) {
    if (!event || typeof event !== 'object') return null;
    const markets = Array.isArray(event.markets) ? event.markets : [];
    let market = markets.find(m => (m?.slug || m?.market_slug) === expectedSlug && _isTradablePoly5M(m));
    if (!market) return null;
    return {
      ...market,
      slug: market.slug || market.market_slug || event.slug || expectedSlug,
      question: market.question || event.title,
      endDate: market.endDate || market.endDateIso || event.endDate || event.end_date || null,
      eventStartTime: market.eventStartTime || event.startTime || event.startDate || null,
      events: market.events || [{
        id: event.id,
        slug: event.slug,
        title: event.title,
        startTime: event.startTime || event.startDate || null,
        endDate: event.endDate || null,
      }],
      _eventFallback: {
        id: event.id,
        slug: event.slug,
        title: event.title,
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

    // Check if we already have the snapshot in-memory (from active streaming)
    const immediateSnap = _polyClobWS.getSnapshotValue(upAssetId, downAssetId, conditionId);
    if (immediateSnap && (immediateSnap.bestBid != null || immediateSnap.bestAsk != null || immediateSnap.upProbability != null)) {
      const val = { ...immediateSnap };
      _poly5mClobSnapshotCache[cacheKey] = { value: val, fetchedAt: Date.now() };
      return val;
    }

    const promise = new Promise(resolve => {
      // Ensure shared WebSocket is connected
      _polyClobWS.connect();
      
      // Subscribe to target token IDs
      _polyClobWS.subscribe(tokenIds, sym, market);

      const req = {
        resolve,
        tokenIds,
        upAssetId,
        downAssetId,
        conditionId,
        sym,
        market,
        timeoutId: null
      };

      req.timeoutId = setTimeout(() => {
        // Remove from pending on timeout
        const reqs = _polyClobWS.pendingRequests.get(cacheKey) || [];
        const idx = reqs.indexOf(req);
        if (idx >= 0) {
          reqs.splice(idx, 1);
          if (reqs.length === 0) {
            _polyClobWS.pendingRequests.delete(cacheKey);
          }
        }
        // Resolve with the best data we currently have
        const finalSnap = _polyClobWS.getSnapshotValue(upAssetId, downAssetId, conditionId);
        _poly5mClobSnapshotCache[cacheKey] = { value: finalSnap, fetchedAt: Date.now() };
        resolve(finalSnap);
      }, timeoutMs);

      if (!_polyClobWS.pendingRequests.has(cacheKey)) {
        _polyClobWS.pendingRequests.set(cacheKey, []);
      }
      _polyClobWS.pendingRequests.get(cacheKey).push(req);
    });

    _poly5mClobSnapshotCache[cacheKey] = { inFlight: promise, fetchedAt: Date.now(), value: cached?.value || null };
    return promise;
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

  let _poly5mCache = {};
  let _poly5mPriceToBeatCache = {};
  const _poly5mPriceToBeatLocks = new Map();
  let _poly5mEventScanCache = { fetchedAt: 0, events: [], source: '', error: '' };
  let _poly5mClobSnapshotCache = {};

  let _polyClobWS = {
    socket: null,
    status: 'CLOSED', // CLOSED, CONNECTING, OPEN
    activeSubs: new Set(),
    lastSeen: new Map(),
    assetToMarket: new Map(),
    pendingRequests: new Map(), // key -> Array of requests
    books: {}, // assetId -> { bestBid, bestAsk, ts }
    reconnectTimer: null,
    reconnectMs: 1000,
    pingTimer: null,

    connect() {
      if (typeof WebSocket === 'undefined') return;
      if (this.status !== 'CLOSED') return;
      this.status = 'CONNECTING';

      try {
        const socket = new WebSocket(POLY_CLOB_MARKET_WS);
        this.socket = socket;

        socket.onopen = () => {
          this.status = 'OPEN';
          this.reconnectMs = 1000;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.startHeartbeat();

          // Resubscribe to existing active subscriptions
          if (this.activeSubs.size > 0) {
            const ids = Array.from(this.activeSubs);
            try {
              socket.send(JSON.stringify({ assets_ids: ids, type: 'market' }));
            } catch (_) {}
          }

          // Trigger subscriptions for any waiting pending requests
          for (const [key, reqs] of Array.from(this.pendingRequests.entries())) {
            const first = reqs[0];
            if (first) {
              this.subscribe(first.tokenIds, first.sym, first.market);
            }
          }
        };

        socket.onmessage = (event) => {
          let msg = null;
          try { msg = JSON.parse(String(event.data || '')); } catch (_) { return; }
          const rows = Array.isArray(msg) ? msg : [msg];
          
          for (const row of rows) {
            const ts = Number(row?.timestamp);
            if (Array.isArray(row?.price_changes)) {
              for (const change of row.price_changes) {
                const assetId = String(change?.asset_id || '');
                this.consumeBook(
                  assetId,
                  Number(change?.best_bid),
                  Number(change?.best_ask),
                  ts
                );
                const mapping = this.assetToMarket.get(assetId);
                if (mapping) {
                  _publishPolymarketClobTick(mapping.sym, mapping.market, change);
                }
              }
            } else {
              const assetId = String(row?.asset_id || '');
              if (assetId) {
                this.consumeBook(
                  assetId,
                  _bestBidAskFromBookRows(row?.bids, 'bid'),
                  _bestBidAskFromBookRows(row?.asks, 'ask'),
                  ts
                );
                const mapping = this.assetToMarket.get(assetId);
                if (mapping) {
                  _publishPolymarketClobTick(mapping.sym, mapping.market, row);
                }
              }
            }
          }

          this.checkPending();
        };

        socket.onerror = (err) => {
          console.warn('[PredictionMarkets] Polymarket CLOB WS error:', err?.message || err);
        };

        socket.onclose = () => {
          this.handleClose();
        };

      } catch (err) {
        console.warn('[PredictionMarkets] Polymarket CLOB WS connect exception:', err?.message || err);
        this.handleClose();
      }
    },

    handleClose() {
      this.status = 'CLOSED';
      this.socket = null;
      this.stopHeartbeat();
      this.activeSubs.clear();

      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, this.reconnectMs);
        this.reconnectMs = Math.min(this.reconnectMs * 1.5, 10000);
      }
    },

    startHeartbeat() {
      this.stopHeartbeat();
      this.pingTimer = setInterval(() => {
        if (this.socket && this.status === 'OPEN') {
          try {
            this.socket.send(JSON.stringify({ type: 'ping' }));
          } catch (_) {}
        }
      }, 30000);
    },

    stopHeartbeat() {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
    },

    subscribe(tokenIds, sym, market) {
      const now = Date.now();
      tokenIds.forEach(id => {
        this.lastSeen.set(id, now);
        if (sym && market) {
          this.assetToMarket.set(id, { sym, market });
        }
      });

      const newIds = tokenIds.filter(id => !this.activeSubs.has(id));
      if (newIds.length > 0) {
        newIds.forEach(id => this.activeSubs.add(id));
        if (this.socket && this.status === 'OPEN') {
          try {
            this.socket.send(JSON.stringify({ assets_ids: newIds, type: 'market' }));
          } catch (err) {
            console.warn('[PredictionMarkets] Subscribe send failed:', err?.message || err);
          }
        }
      }

      this.cleanupStaleSubs();
    },

    unsubscribe(tokenIds) {
      const activeToUnsub = tokenIds.filter(id => this.activeSubs.has(id));
      if (activeToUnsub.length > 0) {
        activeToUnsub.forEach(id => {
          this.activeSubs.delete(id);
          this.assetToMarket.delete(id);
          this.lastSeen.delete(id);
        });
        if (this.socket && this.status === 'OPEN') {
          try {
            this.socket.send(JSON.stringify({ assets_ids: activeToUnsub, operation: 'unsubscribe' }));
          } catch (err) {
            console.warn('[PredictionMarkets] Unsubscribe send failed:', err?.message || err);
          }
        }
      }
    },

    cleanupStaleSubs() {
      const now = Date.now();
      const staleIds = [];
      for (const id of this.activeSubs) {
        const last = this.lastSeen.get(id) || 0;
        if (now - last > 120_000) { // 2 minutes stale
          staleIds.push(id);
        }
      }
      if (staleIds.length > 0) {
        this.unsubscribe(staleIds);
      }
    },

    consumeBook(assetId, bid, ask, ts) {
      if (!assetId) return;
      const prev = this.books[assetId] || {};
      this.books[assetId] = {
        bestBid: Number.isFinite(bid) ? bid : prev.bestBid,
        bestAsk: Number.isFinite(ask) ? ask : prev.bestAsk,
        ts: Number.isFinite(ts) ? ts : prev.ts,
      };
    },

    getSnapshotValue(upAssetId, downAssetId, conditionId) {
      const upBook = this.books[upAssetId] || {};
      const downBook = downAssetId ? this.books[downAssetId] || {} : {};
      const upBid = Number(upBook.bestBid);
      const upAsk = Number(upBook.bestAsk);
      let upMid = null;
      if (Number.isFinite(upBid) && Number.isFinite(upAsk)) upMid = (upBid + upAsk) / 2;
      else if (Number.isFinite(upBid) && Number.isFinite(downBook.bestAsk)) upMid = (upBid + (1 - Number(downBook.bestAsk))) / 2;
      else if (Number.isFinite(upAsk) && Number.isFinite(downBook.bestBid)) upMid = (upAsk + (1 - Number(downBook.bestBid))) / 2;
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
        downBestBid: Number.isFinite(Number(downBook.bestBid)) ? Number(downBook.bestBid) : null,
        downBestAsk: Number.isFinite(Number(downBook.bestAsk)) ? Number(downBook.bestAsk) : null,
        ts: Number(upBook.ts || downBook.ts || Date.now()) || Date.now(),
        source: 'polymarket-clob-ws',
      };
    },

    checkPending() {
      const entries = Array.from(this.pendingRequests.entries());
      for (const [key, reqs] of entries) {
        const first = reqs[0];
        if (!first) continue;
        const snap = this.getSnapshotValue(first.upAssetId, first.downAssetId, first.conditionId);
        if (snap && (snap.bestBid != null || snap.bestAsk != null || snap.upProbability != null)) {
          this.resolveRequest(key, snap);
        }
      }
    },

    resolveRequest(cacheKey, val) {
      const reqs = this.pendingRequests.get(cacheKey);
      if (reqs) {
        this.pendingRequests.delete(cacheKey);
        _poly5mClobSnapshotCache[cacheKey] = { value: val, fetchedAt: Date.now() };
        for (const req of reqs) {
          clearTimeout(req.timeoutId);
          req.resolve(val);
        }
      }
    }
  };
  // Rotate whenever PTB validation semantics change so a previously accepted
  // benchmark cannot survive in localStorage and poison later sessions.
  // v6: dropped all live-price proxies (boundary snapshot / RTDS / crypto-price).
  // polycool.app is the source of truth — only the canonical Polymarket
  // priceToBeat (event page or gamma metadata) may ever be displayed as the PTB.
  // A live Chainlink/Pyth price sampled near window-open is NOT the contract PTB
  // and must never be substituted (that produced the "averaged" mismatch vs polycool).
  const POLY5M_PTB_LOCK_VERSION = 6;
  const POLY5M_PTB_TRUSTED_SOURCES = new Set([
    'polymarket-event-page',
    'gamma-market',
    'gamma-event-metadata',
    'gamma-price-to-beat',
    'gamma-market-metadata',
    'gamma-market-field',
    'polymarket-title',
  ]);

  function _formatPolyPriceToBeat(value, symbol = '') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 1000) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 8 })}`;
  }

  function _lockPolymarketPriceToBeat(slug, value, source) {
    const price = toPositiveFiniteNumber(value);
    if (!slug || price == null || !POLY5M_PTB_TRUSTED_SOURCES.has(source)) return null;
    const existing = _poly5mPriceToBeatLocks.get(slug);
    if (existing) {
      // PTB locks are 100% strictly immutable once established.
      // Once set at boundary open (e.g. pyth-boundary-open or polymarket-event-page),
      // never allow any subsequent scrape or HTML update to shift or offset the lock.
      return existing;
    }
    const locked = Object.freeze({
      version: POLY5M_PTB_LOCK_VERSION,
      price,
      source,
      lockedAt: Date.now(),
    });
    _poly5mPriceToBeatLocks.set(slug, locked);
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
        localStorage.removeItem(storageKey);
        return null;
      }
      const lock = Object.freeze({
        version: POLY5M_PTB_LOCK_VERSION,
        price,
        source: stored.source,
        lockedAt: Number(stored.lockedAt) || 0,
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

    const slugMatch = slug.match(/^([a-z0-9-]+)-updown-5m-(\d+)$/i);
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
    const startSec = Number(slugMatch[2]);
    if (!querySymbol || !Number.isFinite(startSec)) return null;

    const startIso = new Date(startSec * 1000).toISOString().split('.')[0] + 'Z';
    const endIso = new Date((startSec + 300) * 1000).toISOString().split('.')[0] + 'Z';

    // Polymarket Next.js RSC streaming payload contains dehydrated React-Query state entries.
    // We anchor on startIso (e.g. "2026-08-07T11:10:00Z") inside the crypto-prices query
    // entry to guarantee 100% precision for the exact 5-minute contract window.
    let pos = 0;
    while ((pos = html.indexOf(startIso, pos)) !== -1) {
      const snippetBefore = html.slice(Math.max(0, pos - 600), pos);
      const snippetAfter = html.slice(pos, Math.min(html.length, pos + 300));

      if (snippetBefore.includes('crypto-prices') || snippetAfter.includes('fiveminute') || snippetBefore.includes('fiveminute')) {
        const matches = [
          ...snippetBefore.matchAll(/\\"openPrice\\":\s*([0-9.]+)/g),
          ...snippetBefore.matchAll(/"openPrice":\s*([0-9.]+)/g),
          ...snippetBefore.matchAll(/openPrice[^\d]*([0-9.]+)/g)
        ];
        if (matches.length > 0) {
          const op = Number(matches[matches.length - 1][1]);
          if (Number.isFinite(op) && op > 0) return op;
        }
      }
      pos += startIso.length;
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
      // matching is unsafe because the page can hydrate adjacent 5m windows.
      const openingPriceQuery = stateJson.queries.find(q => {
        const key = q.queryKey;
        return Array.isArray(key)
          && key[0] === 'crypto-prices'
          && key[1] === 'price'
          && key[2] === querySymbol
          && normalizeIso(key[3]) === normalizedStartIso
          && key[4] === 'fiveminute'
          && normalizeIso(key[5]) === normalizedEndIso;
      });
      const exactOpenPrice = toPositiveFiniteNumber(openingPriceQuery?.state?.data?.openPrice);
      if (exactOpenPrice != null) return exactOpenPrice;

      // During the first moments of a window, the opening query may not yet be
      // populated. The immediately preceding Chainlink close is the identical
      // boundary, but accept it only when both query and row timestamps match.
      const pastResultsQuery = stateJson.queries.find(q => {
        const key = q.queryKey;
        return Array.isArray(key)
          && key[0] === 'past-results'
          && key[1] === querySymbol
          && key[2] === 'fiveminute'
          && normalizeIso(key[3]) === normalizedStartIso;
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
    const queryKey = JSON.stringify(['crypto-prices', 'price', querySymbol, startIso, 'fiveminute', endIso]);
    const queryKeyIndex = html.indexOf(`"queryKey":${queryKey}`);
    if (queryKeyIndex !== -1) {
      // The state and data for this query key are located AFTER the queryKey in the JSON string.
      const chunk = html.substring(queryKeyIndex, queryKeyIndex + 3000);
      const nextQueryStart = chunk.indexOf('{"queryKey":', 20);
      const validChunk = nextQueryStart !== -1 ? chunk.substring(0, nextQueryStart) : chunk;
      
      const openMatches = [...validChunk.matchAll(/"openPrice":\s*([0-9]+(?:\.[0-9]+)?)/g)];
      const op = openMatches.length ? Number(openMatches[0][1]) : NaN; // The first match after the key belongs to this query
      if (Number.isFinite(op) && op > 0) return op;
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

  async function fetchPolymarketPriceToBeat(slug) {
    if (!slug) return null;
    const cached = _poly5mPriceToBeatCache[slug];
    if (cached && (cached.value != null || Date.now() - cached.fetchedAt < 500)) return cached.value;

    const slugMatch = slug.match(/^([a-z0-9-]+)-updown-5m-(\d+)$/i);
    if (slugMatch) {
      const symMap = { btc: 'BTC', eth: 'ETH', sol: 'SOL', xrp: 'XRP', doge: 'DOGE', hype: 'HYPE', bnb: 'BNB' };
      const sym = symMap[slugMatch[1].toLowerCase()];
      const startSec = Number(slugMatch[2]);
      if (sym && Number.isFinite(startSec)) {
        const startIso = new Date(startSec * 1000).toISOString().split('.')[0] + 'Z';
        const prevIso = new Date((startSec - 300) * 1000).toISOString().split('.')[0] + 'Z';

        try {
          // Direct official microservice query for active window
          const resCurrent = await jsonFetch(`https://polymarket.com/api/crypto/crypto-price?symbol=${sym}&eventStartTime=${encodeURIComponent(startIso)}`).catch(() => null);
          let apiPtb = toPositiveFiniteNumber(resCurrent?.openPrice);

          // If current window openPrice not populated yet, query previous window closePrice (identical boundary)
          if (apiPtb == null) {
            const resPrev = await jsonFetch(`https://polymarket.com/api/crypto/crypto-price?symbol=${sym}&eventStartTime=${encodeURIComponent(prevIso)}`).catch(() => null);
            apiPtb = toPositiveFiniteNumber(resPrev?.closePrice);
          }

          if (apiPtb != null && apiPtb > 0) {
            _poly5mPriceToBeatCache[slug] = { value: apiPtb, fetchedAt: Date.now() };
            return apiPtb;
          }
        } catch (e) {
          console.warn(`[Poly5M-PTB] Official microservice query failed for ${slug}:`, e?.message || e);
        }
      }
    }

    try {
      const html = await textFetch(`https://polymarket.com/event/${encodeURIComponent(slug)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      const value = _parsePolymarketPriceToBeat(html, slug);
      _poly5mPriceToBeatCache[slug] = { value, fetchedAt: Date.now() };
      return value;
    } catch (err) {
      _poly5mPriceToBeatCache[slug] = { value: null, fetchedAt: Date.now() };
      console.warn(`[PredictionMarkets] Poly5M price-to-beat fetch failed for ${slug}:`, err?.message || err);
      return null;
    }
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

        // Parse PTB from title/question (note: many 5m slugs use time-range in title; $ strike not always present)
        if (!priceToBeatNum && title) {
          const match = title.match(/\$([0-9,.]+)/);
          if (match) {
            const num = parseFloat(match[1].replace(/,/g, ''));
            if (Number.isFinite(num) && num > 0) {
              priceToBeatNum = num;
              priceToBeatSource = 'polymarket-title';
            }
          }
        }

        // 1. Try gamma metadata / m object first (reliable, no scrape)
        if (!priceToBeatNum && Number.isFinite(m.priceToBeat) && m.priceToBeat > 0) {
          priceToBeatNum = m.priceToBeat;
          priceToBeatSource = 'gamma-market';
        } else if (!priceToBeatNum && m.eventMetadata && Number.isFinite(m.eventMetadata.priceToBeat)) {
          priceToBeatNum = m.eventMetadata.priceToBeat;
          priceToBeatSource = 'gamma-event-metadata';
        } else if (!priceToBeatNum && m.price_to_beat && Number.isFinite(m.price_to_beat)) {
          priceToBeatNum = m.price_to_beat;
          priceToBeatSource = 'gamma-price-to-beat';
        }

        // 1b. Generic parse from full market JSON for other fields
        if (!priceToBeatNum) {
          const gen = _parseGenericPriceToBeat(JSON.stringify(m), marketSlug);
          if (Number.isFinite(gen) && gen > 0) {
            priceToBeatNum = gen;
            priceToBeatSource = 'gamma-market-metadata';
          }
        }

        // 1c. Also try broader keys on the raw market object (some gamma responses use different casing)
        if (!priceToBeatNum) {
          const cands = [m.initialPrice, m.openPrice, m.startPrice, m.benchmarkPrice, m.strike, m.strikePrice, m.referencePrice];
          for (const c of cands) {
            const n = toPositiveFiniteNumber(c);
            if (n != null) { priceToBeatNum = n; priceToBeatSource = 'gamma-market-field'; break; }
          }
        }

        const startMs = startDate ? new Date(startDate).getTime() : ts * 1000;
        const [cryptoWindow, rtds] = await Promise.all([
          fetchPolymarketCryptoWindowPrice(sym, startMs).catch(() => null),
          fetchPolymarketRtdsSnapshot(sym, startMs).catch(() => null),
        ]);

        // PTB resolution: prefer canonical value from Polymarket event page or locked boundary
        const isImmediateNext = ts === windowTs + 300;
        const shouldResolvePTB = !isFuture || isImmediateNext;

        if (shouldResolvePTB) {
          // Check if an immutable lock already exists for this exact contract slug FIRST
          const existingLock = _getPolymarketPriceToBeatLock(slug) || _getPolymarketPriceToBeatLock(marketSlug);
          if (existingLock) {
            priceToBeatNum = existingLock.price;
            priceToBeatSource = existingLock.source;
          } else if (priceToBeatNum == null) {
            // Only scrape when no trusted value was already resolved from Gamma/title
            // metadata above — a fragile HTML scrape must never override a value the
            // fast, reliable Gamma API already gave us.
            let scraped = null;
            try {
              scraped = await fetchPolymarketPriceToBeat(slug) || await fetchPolymarketPriceToBeat(marketSlug);
            } catch (_) {}
            if (Number.isFinite(scraped) && scraped > 0) {
              priceToBeatNum = scraped;
              priceToBeatSource = 'polymarket-event-page';
            }
          }

          if (priceToBeatNum != null) {
            const locked = _lockPolymarketPriceToBeat(slug, priceToBeatNum, priceToBeatSource) || _lockPolymarketPriceToBeat(marketSlug, priceToBeatNum, priceToBeatSource);
            if (locked) {
              priceToBeatNum = locked.price;
              priceToBeatSource = locked.source;
            }
            if (marketSlug && marketSlug !== slug) {
              _lockPolymarketPriceToBeat(marketSlug, priceToBeatNum, priceToBeatSource);
            }
          }
        }

        let chainlinkCurrentPriceNum = toPositiveFiniteNumber(cryptoWindow?.closePrice);
        let chainlinkCurrentPriceTs = toPositiveFiniteNumber(cryptoWindow?.timestamp);
        if (chainlinkCurrentPriceNum == null) {
          chainlinkCurrentPriceNum = toPositiveFiniteNumber(rtds?.currentPriceNum);
          chainlinkCurrentPriceTs = toPositiveFiniteNumber(rtds?.currentPriceTs);
        }
        const pythCurrent = await getFreshPythLazerPrice(sym);
        const currentPriceNum = pythCurrent?.price ?? chainlinkCurrentPriceNum;
        const currentPriceTs = pythCurrent?.timestamp ?? chainlinkCurrentPriceTs;
        const currentPriceSource = pythCurrent?.source || 'polymarket-chainlink';

        // PTB comes exclusively from Polymarket's canonical Chainlink contract benchmark (polymarket-event-page).
        // Never inject Pyth spot proxies for PTB to guarantee zero mid-contract changes.

        // A five-minute contract is unavailable until its benchmark exists.
        if (priceToBeatNum == null && !isFuture && ts !== windowTs) return null;

        if (ts === windowTs || isImmediateNext || priceToBeatNum != null) {
          console.log(`[Poly5M-PTB] ${sym} ${marketSlug} → $${priceToBeatNum ?? 'pending'} (source: ${priceToBeatSource ?? 'waiting-for-open'}) [exact-contract]`);
        }

        const oracleBasisNum = pythCurrent && chainlinkCurrentPriceNum != null
          ? pythCurrent.price - chainlinkCurrentPriceNum
          : null;
        const currentPriceJustification = pythCurrent
          ? 'Pyth Lazer real-time price compared with Polymarket Chainlink opening PTB; settlement remains Chainlink.'
          : 'Polymarket Chainlink current price fallback; Pyth Lazer was unavailable or stale.';

        // Re-lock if we got a good PTB from Polymarket sources for this window.
        // PTB for the exact contract must come from the slug's Polymarket page (scrape = truth)
        // or a value locked at the precise open time of the window (boundary clock snapshot).
        // Never inject a live price observed later in the window.
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
        const hasSettlementComparison = chainlinkCurrentPriceNum != null && Number.isFinite(priceToBeatNum) && priceToBeatNum > 0;
        const settlementPriceDeltaNum = hasSettlementComparison ? chainlinkCurrentPriceNum - priceToBeatNum : null;
        const settlementLiveDirection = hasSettlementComparison
          ? (settlementPriceDeltaNum >= 0 ? 'UP' : 'DOWN')
          : null;

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
      targetPrice: r.priceToBeat,
      targetPriceNum: r.priceToBeatNum,
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
      volume: primary.volume,
      title: primary.title,
      slug: primary.marketSlug,
      closeTime: primary.endDate,
      endDate: primary.endDate,
      startDate: primary.startDate,
      bestBid: primary.clobSnapshot?.bestBid ?? (parseFloat(primary.m.bestBid || primary.m.best_bid || 0) || null),
      bestAsk: primary.clobSnapshot?.bestAsk ?? (parseFloat(primary.m.bestAsk || primary.m.best_ask || 0) || null),
      liquidity: parseFloat(primary.m.liquidityNum || primary.m.liquidity || 0) || 0,
      targetPrice: primary.priceToBeat,
      targetPriceNum: primary.priceToBeatNum,
      targetPriceApprox: false,
      priceToBeat: primary.priceToBeat,
      priceToBeatNum: primary.priceToBeatNum,
      priceToBeatSource: primary.priceToBeatSource,
      currentPrice: _formatPolyPriceToBeat(primary.currentPriceNum),
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
      priceDelta: primary.priceDeltaNum != null ? _formatPolyPriceToBeat(Math.abs(primary.priceDeltaNum)) : null,
      priceDeltaNum: primary.priceDeltaNum,
      priceDeltaPct: primary.priceDeltaPct,
      liveDirection: primary.liveDirection,
      liveSignal: primary.liveDirection,
      liveState: primary.hasLiveComparison ? (primary.priceDeltaNum >= 0 ? 'above' : 'below') : 'unknown',
      clobConditionId: primary.clobSnapshot?.conditionId || primary.m.conditionId || primary.m.condition_id || null,
      clobTokenIds: _polyClobTokenIds(primary.m),
      clobUpAssetId: primary.clobSnapshot?.upAssetId || null,
      clobDownAssetId: primary.clobSnapshot?.downAssetId || null,
      clobSnapshotTs: primary.clobSnapshot?.ts || null,
      discoverySource: primary.hit.source || 'gamma-markets-slug',
      fallbackJustification: primary.hit.fallbackJustification || null,
      markets,
      _source: primary.hit.source === 'gamma-markets-slug' ? 'poly5m-slug' : `poly5m-${primary.hit.source || 'fallback'}`,
      _windowTs: primary.ts,
    };
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
  let _k5mCache = {};
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
    const fetchKalshi5MNow = true;  // always fetch 5m data for 5m markets view (was throttled, may have caused "wait" / missing data)

    const [kalshi15m, polyMarkets] = await Promise.all([
      withTimeout(fetchKalshi15M(), FETCH_TIMEOUT_MS, 'Kalshi 15M fetch').catch(err => {
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

    if (fetchKalshi5MNow) {
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

    if (fetchPoly5M) {
      const poly5mResults = {};
      await Promise.all(Object.keys(POLY_5M_COIN_SLUGS).map(async sym => {
        try {
          poly5mResults[sym] = await withTimeout(fetchPolymarket5MBySlug(sym), 8_000, `Poly5M ${sym}`);
        } catch (err) {
          console.warn(`[PredictionMarkets] Poly5M fetch failed for ${sym}:`, err?.message || err);
          poly5mResults[sym] = null;
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
      // Kalshi
      const kalshiStatus = {
        status: kalshi15m && Object.values(kalshi15m).some(x => x) ? 'healthy' : 'down',
        lastFetch: Date.now(),
        fallback: false,
        reason: kalshi15m && Object.values(kalshi15m).some(x => x) ? '' : 'No Kalshi 15M data',
      };
      window.NetworkHealth.update('Kalshi', kalshiStatus);

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

      

      // ProxyOrchestrator (if present)
      if (typeof window._proxyOrchestrator === 'undefined') {
        window.NetworkHealth.update('ProxyOrchestrator', {
          status: 'degraded',
          lastFetch: Date.now(),
          fallback: true,
          transient: true,
          reason: 'Not initialized',
          bucket: 'app/logic',
          bucketReason: 'ProxyOrchestrator not initialized',
        });
      }
    }
    // Debug: log what we got from Kalshi 15M
    const k15Coins = Object.entries(kalshi15m).filter(([sym, data]) => data !== null).map(([sym]) => sym);
    const k15Empty = Object.entries(kalshi15m).filter(([sym, data]) => data === null).map(([sym]) => sym);
    if (k15Coins.length === 0) {
      console.error(`[PredictionMarkets] CRITICAL: No Kalshi 15M contracts loaded. Empty coins: ${k15Empty.join(', ')}`);
    } else {
      console.log(`[PredictionMarkets] Loaded Kalshi 15M for: ${k15Coins.join(', ')} (failed: ${k15Empty.join(', ')})`);
    }

    const next = {};
    for (const sym of Object.keys(KALSHI_15M_SERIES)) {
      const k15 = kalshi15m[sym] ?? null;
      const k5raw = _k5mCache[sym] ?? null;
      const poly5mSlug = k5raw?._poly5m ?? null;
      const poly = Array.isArray(_polyCache) ? polymarketSentiment(_polyCache, sym) : null;
      const poly5m = poly5mSlug || null;

      let k5 = null;
      if (k5raw) {
        k5 = { ...k5raw };
        delete k5._poly5m;
        if (Object.keys(k5).length === 0) k5 = null;
      }
      
      const sources = [];
      if (k15?.probability != null) sources.push({ name: 'Kalshi15M', prob: k15.probability, vol: k15.volume || 1 });
      if (poly?.probability != null) sources.push({ name: 'Polymarket', prob: poly.probability, vol: poly.volume || 1 });
      if (poly5mSlug?.probability != null) sources.push({ name: 'Poly5M', prob: poly5mSlug.probability, vol: poly5mSlug.volume || 1 });
      
      let combinedProb = k15?.probability ?? null;
      if (combinedProb != null && poly?.probability != null) {
        combinedProb = (combinedProb * 0.7) + (poly.probability * 0.3);
      } else if (combinedProb == null && poly?.probability != null) {
        combinedProb = poly.probability;
      }

      next[sym] = {
        kalshi: k15?.probability != null ? parseFloat(k15.probability.toFixed(4)) : null,
        poly: poly?.probability != null ? parseFloat(poly.probability.toFixed(4)) : null,
        combinedProb: combinedProb !== null ? parseFloat(combinedProb.toFixed(4)) : null,
        sources,
        kalshi15m: k15,
        kalshi5m: k5,
        poly5m,
        poly5mSlug,
        poly5mMkts: poly5m?.markets || [],
        polyMarkets: poly?.markets || [],
        kalshiTitle: k15?.title ?? null,
        probVelocity: getProbVelocity(sym),  // Kalshi YES-price drift (Â¢/min)
      };
      // Update velocity history AFTER building next[sym] so this cycle feeds next read
      if (k15?.probability != null) trackProbability(sym, k15.probability);
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
    const results = {};
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

  // ---- Public API ---------------------------------------------------

  window.PredictionMarkets = {
    start() {
      if (PredictionMarkets._started) return;
      PredictionMarkets._started = true;
      window.EndpointTransport?.ensureKalshiWs?.();
      if (!PredictionMarkets._tickerBound) {
        PredictionMarkets._tickerBound = true;
        window.addEventListener('kalshi:ticker', onKalshiTicker);
      }
      if (timer) return;
      fetchAll();
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
      let prefetchTriggered = false;
      setInterval(() => {
        if (document.hidden) return;
        const nowMs = Date.now();
        const nowSec = Math.floor(nowMs / 1000);
        const secInPeriod = nowSec % 300;

        // 1. Pre-fetch trigger: 30 seconds before the 5-minute boundary
        if (secInPeriod >= 270 && !prefetchTriggered) {
          prefetchTriggered = true;
          const currentBoundary = nowSec - secInPeriod;
          const nextBoundary = currentBoundary + 300;
          console.info(`[BoundaryClock] ⏱ 30s to 5m boundary (${nextBoundary}). Pre-fetching & locking canonical PTB for upcoming contracts.`);
          Object.keys(POLY_5M_COIN_SLUGS).forEach(async (sym) => {
            try {
              const prefix = POLY_5M_COIN_SLUGS[sym];
              const nextSlug = `${prefix}-updown-5m-${nextBoundary}`;
              const scraped = await fetchPolymarketPriceToBeat(nextSlug).catch(() => null);
              if (Number.isFinite(scraped) && scraped > 0) {
                _lockPolymarketPriceToBeat(nextSlug, scraped, 'polymarket-event-page');
                console.info(`[BoundaryClock] 🎯 Pre-locked canonical PTB for upcoming ${sym} (${nextSlug}): $${scraped}`);
              }
              await fetchPolymarket5MMarketCandidate(sym, nextSlug).catch(() => null);
            } catch (_) {}
          });
          fetchAll().catch(() => {});
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
                  targetPrice: nextMkt.targetPrice,
                  targetPriceNum: nextMkt.targetPriceNum,
                  priceToBeat: nextMkt.targetPrice,
                  priceToBeatNum: nextMkt.targetPriceNum,
                  priceToBeatSource: nextMkt.priceToBeatSource,
                  currentPrice: null,
                  currentPriceNum: null,
                  currentPriceTs: null,
                  currentPriceSource: null,
                  currentPriceAgeMs: null,
                  currentPriceJustification: 'Local rollover: fetching fresh prices and benchmark…',
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

          // At exact rollover, fetch canonical Polymarket Chainlink contract benchmark
          // PTB comes strictly from Polymarket's event page stream (the single source of truth for settlement).
          // Never inject provisional spot proxies to avoid mid-contract shifts.
          Object.keys(POLY_5M_COIN_SLUGS).forEach(async (sym) => {
            try {
              const prefix = POLY_5M_COIN_SLUGS[sym];
              const newSlug = `${prefix}-updown-5m-${currentBoundary}`;
              let existing = _getPolymarketPriceToBeatLock(newSlug);
              if (!existing) {
                const scraped = await fetchPolymarketPriceToBeat(newSlug).catch(() => null);
                if (Number.isFinite(scraped) && scraped > 0) {
                  _lockPolymarketPriceToBeat(newSlug, scraped, 'polymarket-event-page');
                }
              }
            } catch (e) {}
          });

          // Trigger background fetch to get actual PTB and live pricing
          refreshPoly5M('boundary-clock').catch(() => {});
          fetchAll().catch(() => {});
        } else if (lastBoundarySec === 0) {
          lastBoundarySec = currentBoundary;
        }
      }, 1000);
    },
    getAll() { return cache; },
    getCoin(sym) { return cache[sym] ?? null; },
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
      return {
        lastFetch,
        age: lastFetch ? Date.now() - lastFetch : null,
        hasData: Object.keys(cache).length > 0,
        coinCount: Object.values(cache).filter(c => c.combinedProb !== null).length,
        poly5mCount: Object.values(cache).filter(c => c.poly5m?.probability != null).length,
        polymarket: {
          lastFetch: _polyLastFetch,
          age: _polyLastFetch ? Date.now() - _polyLastFetch : null,
          hasData: Array.isArray(_polyCache) && _polyCache.length > 0,
          marketCount: Array.isArray(_polyCache) ? _polyCache.length : 0,
          lastError: _polyLastError || null,
          source: _polyLastSource || null,
          poly5mCount: Object.values(cache).filter(c => c.poly5m?.probability != null).length,
        },
      };
    },
    fetchAll,
    refreshPoly5M,
  };

  if (window.__WE_TEST__) {
    window.__PredictionMarketsTestHooks = {
      fetchPolymarket5MBySlug,
      _coercePolyMarketFromEvent,
      _formatPolyPriceToBeat,
      _isTradablePoly5M,
      _parseGenericPriceToBeat,
      _parsePolymarketPriceToBeat,
      _parseUpProb,
    };
  }

  if (typeof window !== 'undefined' && window.PredictionMarkets && typeof window.PredictionMarkets.start === 'function') {
    try { window.PredictionMarkets.start(); } catch (_) {}
  }

})();
