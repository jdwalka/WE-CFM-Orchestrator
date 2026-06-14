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

  const POLY_CHAINLINK_SYMBOLS = {
    BTC: 'btc/usd',
    ETH: 'eth/usd',
    SOL: 'sol/usd',
    XRP: 'xrp/usd',
    DOGE: 'doge/usd',
    BNB: 'bnb/usd',
    HYPE: 'hype/usd',
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
  // The kalshi:markets IPC goes through proxyToWorker which wraps as { success, data, status },
  // and the REST client itself may wrap as { success, data: { markets: [...] } }.
  function _extractMarketsArray(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj.markets)) return obj.markets;
    if (obj.data && Array.isArray(obj.data.markets)) return obj.data.markets;
    if (obj.data && obj.data.data && Array.isArray(obj.data.data.markets)) return obj.data.data.markets;
    if (obj.data && obj.data.data && obj.data.data.data && Array.isArray(obj.data.data.data.markets)) return obj.data.data.data.markets;
    if (Array.isArray(obj.data)) return obj.data;
    if (obj.data && Array.isArray(obj.data.data)) return obj.data.data;
    return null;
  }

  async function kalshiFetch(url, attempt = 0) {
    if (_rateLimitUntil > Date.now()) {
      console.warn(`[PredictionMarkets] Rate limited until ${new Date(_rateLimitUntil).toISOString()}`);
      return null;
    }

    const params = parseKalshiUrl(url);
    let data = null;
    let transport = 'http';
    let is429 = false;

    if (window.electron && window.electron.invoke) {
      try {
        const ipcRaw = await window.electron.invoke('kalshi:markets', params);
        // proxyToWorker returns { success, data, status }
        // data itself may be { success, data: { markets: [...] } } from the REST client
        // We need to find the markets array wherever it lives in this nesting
        const mkts = _extractMarketsArray(ipcRaw);
        if (mkts && mkts.length > 0) {
          data = { markets: mkts };
          transport = 'ipc-sdk';
          console.log(`[PredictionMarkets] IPC kalshi:markets → ${mkts.length} markets for ${params.series_ticker || 'all'}`);
        } else {
          // Log the response shape so we can diagnose the wrapping
          const shape = ipcRaw ? `success=${ipcRaw.success}, hasData=${!!ipcRaw.data}, dataType=${typeof ipcRaw.data}, keys=${Object.keys(ipcRaw.data || {}).join(',')}` : 'null';
          console.warn(`[PredictionMarkets] IPC kalshi:markets returned no markets. Shape: ${shape}`);
        }
      } catch (err) {
        console.warn(`[PredictionMarkets] IPC kalshi:markets failed:`, err?.message || err);
      }
    }

    if (!data && window.EndpointTransport?.fetchKalshiMarkets) {
      try {
        data = await window.EndpointTransport.fetchKalshiMarkets(params);
        transport = data?._transport || 'rpc/http';
      } catch (err) {
        console.warn(`[PredictionMarkets] EndpointTransport failed:`, err?.message || err);
        window._kalshiErrors = window._kalshiErrors || [];
        window._kalshiErrors.push({ ts: Date.now(), sym: params.series_ticker || 'SYS', msg: 'Proxy ' + (err?.message || 'Error') });
        if (String(err?.message || err).includes('429')) is429 = true;
      }
    }

    if (!data && !is429) {
      try {
        data = await apiFetch(url);
        transport = 'http';
      } catch (err) {
        console.error(`[PredictionMarkets] Fetch error for ${url}:`, err?.message || err);
        window._kalshiErrors = window._kalshiErrors || [];
        window._kalshiErrors.push({ ts: Date.now(), sym: params.series_ticker || 'SYS', msg: 'Fetch ' + (err?.message || 'Error') });
        if (String(err?.message || err).includes('429')) is429 = true;
        else return null;
      }
    }

    if (is429 || (data && typeof data === 'object' && data.status === 429)) {
      _consecutive429++;
      const wait = _consecutive429 >= 3
        ? 60_000
        : Math.min(30_000, 3_000 * (2 ** attempt));
      console.warn(`[PredictionMarkets] HTTP 429 â€” backoff ${wait}ms`);
      _rateLimitUntil = Date.now() + wait;
      await new Promise(r => setTimeout(r, wait));
      _rateLimitUntil = 0;
      return attempt < 2 ? kalshiFetch(url, attempt + 1) : null;
    }

    _consecutive429 = 0;
    if (data && transport) {
      try {
        window.NetworkHealth?.update?.('Kalshi', {
          status: 'healthy',
          lastFetch: Date.now(),
          fallback: transport !== 'wss',
          reason: transport,
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

  // ---- Snipe detection: contracts closing within 5 min with strong bias ----
  const SNIPE_WINDOW_MS = 5 * 60_000;
  const SNIPE_THRESHOLD = 0.65;

  function detectSnipes(c) {
    const snipes = [];
    const now = Date.now();
    for (const [sym, data] of Object.entries(c)) {
      for (const [label, market] of [['Kalshi 15M', data?.kalshi15m]]) {
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
  let _poly5mRtdsOpenCache = {};

  function _formatPolyPriceToBeat(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 1000) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 8 })}`;
  }

  function _parsePolymarketPriceToBeat(html, slug) {
    if (!html || !slug) return null;
    let idx = html.indexOf(`"slug":"${slug}"`);
    if (idx === -1) idx = html.indexOf(`"ticker":"${slug}"`);
    if (idx === -1) return null;
    const chunk = html.substring(idx, idx + 4000);
    const nextObjIdx = chunk.indexOf('{"id"');
    const validChunk = nextObjIdx !== -1 ? chunk.substring(0, nextObjIdx) : chunk;
    const match = validChunk.match(/"priceToBeat":\s*([0-9.]+)/);
    const n = match ? Number(match[1]) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
    return null;
  }

  // (Approximate Binance fetch removed - prices must come from Polymarket or Polycool oracles)

  async function fetchPolymarketPriceToBeat(slug) {
    if (!slug) return null;
    const cached = _poly5mPriceToBeatCache[slug];
    if (cached && (cached.value != null || Date.now() - cached.fetchedAt < 45_000)) return cached.value;
    try {
      const html = await textFetch(`https://polymarket.com/event/${encodeURIComponent(slug)}`);
      const value = _parsePolymarketPriceToBeat(html, slug);
      _poly5mPriceToBeatCache[slug] = { value, fetchedAt: Date.now() };
      return value;
    } catch (err) {
      _poly5mPriceToBeatCache[slug] = { value: null, fetchedAt: Date.now() };
      console.warn(`[PredictionMarkets] Poly5M price-to-beat fetch failed for ${slug}:`, err?.message || err);
      return null;
    }
  }

  function _selectOpeningChainlinkTick(rows, startMs) {
    if (!Array.isArray(rows) || !Number.isFinite(startMs)) return null;
    let best = null;
    for (const row of rows) {
      const ts = Number(row?.timestamp);
      const value = Number(row?.value);
      if (!Number.isFinite(ts) || !Number.isFinite(value) || value <= 0) continue;
      if (ts >= startMs && ts <= startMs + 10_000 && (!best || ts < best.ts)) {
        best = { ts, value };
      }
    }
    return best;
  }

  async function fetchPolymarketRtdsPriceToBeat(sym, startMs, timeoutMs = 1800) {
    const chainlinkSymbol = POLY_CHAINLINK_SYMBOLS[sym];
    if (!chainlinkSymbol || !Number.isFinite(startMs) || typeof WebSocket === 'undefined') return null;

    const cacheKey = `${sym}:${startMs}`;
    const cached = _poly5mRtdsOpenCache[cacheKey];
    if (cached && (cached.value != null || Date.now() - cached.fetchedAt < 30_000)) return cached.value;

    return new Promise(resolve => {
      let settled = false;
      let socket = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        _poly5mRtdsOpenCache[cacheKey] = { value, fetchedAt: Date.now() };
        try { if (socket) socket.close(); } catch (_) { }
        resolve(value);
      };

      const timerId = setTimeout(() => finish(null), timeoutMs);
      try {
        socket = new WebSocket('wss://ws-live-data.polymarket.com');
        socket.onopen = () => {
          socket.send(JSON.stringify({
            action: 'subscribe',
            subscriptions: [{
              topic: 'crypto_prices_chainlink',
              type: '*',
              filters: JSON.stringify({ symbol: chainlinkSymbol }),
            }],
          }));
        };
        socket.onmessage = (event) => {
          let msg = null;
          try { msg = JSON.parse(String(event.data || '')); } catch (_) { return; }
          const payload = msg?.payload || {};
          const rows = Array.isArray(payload.data)
            ? payload.data
            : [{ timestamp: payload.timestamp ?? msg.timestamp, value: payload.value }];
          const openingTick = _selectOpeningChainlinkTick(rows, startMs);
          if (!openingTick) return;
          clearTimeout(timerId);
          finish(openingTick.value);
        };
        socket.onerror = () => {
          clearTimeout(timerId);
          finish(null);
        };
        socket.onclose = () => {
          clearTimeout(timerId);
          finish(null);
        };
      } catch (_) {
        clearTimeout(timerId);
        finish(null);
      }
    });
  }

  async function fetchPolymarket5MBySlug(sym) {
    const coinSlugPrefix = POLY_5M_COIN_SLUGS[sym];
    if (!coinSlugPrefix) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    const cached = _poly5mCache[sym];
    if (cached && cached.windowTs === windowTs && Date.now() - cached.fetchedAt < 20_000) {
      return cached.data;
    }

    // Current, next, and prior windows cover provider rollover skew without broad market scans.
    const candidates = [windowTs, windowTs + 300, windowTs - 300];
    for (const ts of candidates) {
      const slug = `${coinSlugPrefix}-updown-5m-${ts}`;
      try {
        const result = await apiFetch(`${POLY_GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
        const m = _extractPolyMarketArray(result).find(mk => _isTradablePoly5M(mk));
        if (!m) continue;
        const upProb = _parseUpProb(m);
        if (upProb === null) continue;
        const title = m.question || m.title || `${sym} Up or Down 5M`;
        const endDate = m.endDate || m.end_date_iso || m.end_date || null;
        const startDate = m.eventStartTime || m.events?.[0]?.startTime || null;
        const volume = parseFloat(m.volume24hr || m.volumeNum || m.volume || 0) || 0;
        const marketSlug = m.slug || slug;
        let priceToBeatSource = 'polymarket-title';
        let priceToBeatNum = null;

        if (title) {
          const match = title.match(/\$([0-9,.]+)/);
          if (match) {
            priceToBeatNum = parseFloat(match[1].replace(/,/g, ''));
          }
        }

        if (priceToBeatNum == null) {
          priceToBeatSource = 'polymarket-eventMetadata';
          priceToBeatNum = await fetchPolymarketPriceToBeat(marketSlug);
        }
        
        const startMs = startDate ? new Date(startDate).getTime() : ts * 1000;
        if (priceToBeatNum == null) {
          priceToBeatNum = await fetchPolymarketRtdsPriceToBeat(sym, startMs);
          priceToBeatSource = priceToBeatNum != null ? 'polymarket-rtds-chainlink-open' : null;
        }
        const priceToBeat = _formatPolyPriceToBeat(priceToBeatNum);
        const data = {
          probability: upProb,
          volume,
          title,
          slug: marketSlug,
          closeTime: endDate,
          endDate,
          startDate,
          bestBid: parseFloat(m.bestBid || m.best_bid || 0) || null,
          bestAsk: parseFloat(m.bestAsk || m.best_ask || 0) || null,
          liquidity: parseFloat(m.liquidityNum || m.liquidity || 0) || 0,
          targetPrice: priceToBeat,
          targetPriceNum: priceToBeatNum,
          targetPriceApprox: priceToBeatSource === 'polymarket-rtds-chainlink-open',
          priceToBeat,
          priceToBeatNum,
          priceToBeatSource,
          markets: [{
            question: title,
            yes: upProb,
            vol24h: volume,
            endDate,
            slug: marketSlug,
            targetPrice: priceToBeat,
            targetPriceNum: priceToBeatNum,
          }],
          _source: 'poly5m-slug',
          _windowTs: ts,
        };
        _poly5mCache[sym] = { data, windowTs, fetchedAt: Date.now() };
        return data;
      } catch (err) {
        console.warn(`[PredictionMarkets] Poly5M slug fetch failed for ${sym} ${slug}:`, err?.message || err);
      }
    }

    _poly5mCache[sym] = { data: null, windowTs, fetchedAt: Date.now() };
    return null;
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
    const fetchPoly5M = _polyCycleCount === 1 || _polyCycleCount % 2 === 0;

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
      const polyStatus = {
        status: polyMarkets && polyMarkets.length > 0 ? 'healthy' : 'down',
        lastFetch: Date.now(),
        fallback: false,
        reason: polyMarkets && polyMarkets.length > 0 ? '' : 'No Polymarket data',
      };
      window.NetworkHealth.update('Polymarket', polyStatus);

      

      // ProxyOrchestrator (if present)
      let proxyStatus = { status: 'unknown', lastFetch: Date.now(), fallback: false, reason: '' };
      if (typeof window._proxyOrchestrator !== 'undefined') {
        proxyStatus.status = 'healthy';
      } else {
        proxyStatus.status = 'down';
        proxyStatus.reason = 'Not initialized';
      }
      window.NetworkHealth.update('ProxyOrchestrator', proxyStatus);
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
      const poly5m = poly5mSlug ?? (Array.isArray(_polyCache) ? polymarket5mSentiment(_polyCache, sym) : null);
      
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
        kalshi5m: null,
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
          poly5mMkts: [],
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

})();

