/**
 * scalper-market-data — live Coinbase / Kalshi / Polymarket data proxy for
 * the Hourly Range Scalper uAgent (JohnDaWalka/WE-CFM-Orchestrator,
 * uagents/hourly-range-scalper/). JS port of market_data.py's verified
 * live clients, exposed as HTTP GET endpoints for an agent runtime that
 * has no native HTTP-request tool (e.g. an ASI1/Agentverse chat agent).
 *
 *   - Kalshi KXBTC (hourly) and Polymarket's daily band ladder are real
 *     [low, high] band contracts -> /kalshi/bands, /polymarket/daily-bands
 *   - Kalshi KXBTC15M and Polymarket btc-updown-{5m,15m,4h} are plain
 *     Up/Down (no band) -> /kalshi/updown, /polymarket/twap-updown
 *   - Coinbase is spot + momentum reference for all of the above.
 * No API keys required -- all upstream calls are public, unauthenticated
 * market-data endpoints. This proxy does not place orders.
 */

const COINBASE_BASE = "https://api.exchange.coinbase.com";
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const POLYMARKET_GAMMA_BASE = "https://gamma-api.polymarket.com";
const POLYMARKET_CLOB_BASE = "https://clob.polymarket.com";

const TWAP_INTERVAL_SECONDS = { "5m": 300, "15m": 900, "4h": 14400 };
const SPOT_FRESHNESS_MAX_AGE_SECONDS = 60;

function jsonResponse(data, status = 200) {
  if (data && typeof data === 'object' && !data.collector_timestamp) {
    data.collector_timestamp = new Date().toISOString();
  }
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store",
    },
  });
}

function parseTwapWindowSeconds(description) {
  const m = /twap-(\d+)s-streams/i.exec(description || "");
  return m ? parseInt(m[1], 10) : null;
}

// Coinbase's /candles endpoint (unlike /ticker) rejects requests with no
// User-Agent header -- Workers' fetch() sends none by default.
const COINBASE_HEADERS = { "User-Agent": "scalper-market-data/1.0 (+workers.dev)" };

async function fetchMarketData(url, init = {}, { retries = 2, retryDelayMs = 300, timeoutMs = 8000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timer);
      // Retry transient upstream 5xx errors or 429 rate limits
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        lastErr = new Error(`upstream ${url} -> HTTP ${res.status}`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1) * 2));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr;
}

async function getCoinbaseSpot(symbol = "BTC") {
  const productId = `${symbol}-USD`;
  const r = await fetchMarketData(`${COINBASE_BASE}/products/${productId}/ticker`, {
    headers: COINBASE_HEADERS,
  });
  if (!r.ok) throw new Error(`Coinbase ticker ${productId} -> HTTP ${r.status}`);
  const data = await r.json();
  return { symbol, product_id: productId, price: parseFloat(data.price), time: data.time };
}

async function getCalibrationHealth(env) {
  const database = env && (env.CALIBRATION_DB || env.jdwalkaz || env.truffle);
  if (!database) {
    return {
      storage_reachable: false,
      calibration_available: false,
      last_successful_calibration_write_timestamp: null,
    };
  }

  try {
    await database.prepare("SELECT 1 AS reachable").first();
    let lastWriteTimestamp = null;
    try {
      const row = await database
        .prepare("SELECT MAX(timestamp_utc) AS last_write_timestamp FROM calibration_reports")
        .first();
      lastWriteTimestamp = (row && row.last_write_timestamp) || null;
    } catch {
      lastWriteTimestamp = null;
    }

    return {
      storage_reachable: true,
      calibration_available: Boolean(lastWriteTimestamp),
      last_successful_calibration_write_timestamp: lastWriteTimestamp,
    };
  } catch {
    return {
      storage_reachable: false,
      calibration_available: false,
      last_successful_calibration_write_timestamp: null,
    };
  }
}

async function getSpotSourceHealth(symbol = "BTC") {
  try {
    const spot = await getCoinbaseSpot(symbol);
    const observedAt = Date.parse(spot.time);
    const ageSeconds = Number.isFinite(observedAt)
      ? Math.max(0, (Date.now() - observedAt) / 1000)
      : null;
    return {
      source: "coinbase",
      reachable: true,
      last_timestamp: spot.time,
      age_seconds: ageSeconds,
      fresh: ageSeconds !== null && ageSeconds <= SPOT_FRESHNESS_MAX_AGE_SECONDS,
    };
  } catch {
    return {
      source: "coinbase",
      reachable: false,
      last_timestamp: null,
      age_seconds: null,
      fresh: false,
    };
  }
}

async function getLadderFeedStatus(source, loadFeed) {
  try {
    await loadFeed();
    return { source, status: "ok" };
  } catch {
    return { source, status: "unavailable" };
  }
}

async function getLadderFeedHealth(env, ctx) {
  const [kalshi, polymarket] = await Promise.all([
    getLadderFeedStatus("kalshi", () => getKalshiUpdownCached(env, ctx, "KXBTC15M")),
    getLadderFeedStatus("polymarket", () => getPolymarketHourlyUpdown()),
  ]);
  return [kalshi, polymarket];
}

async function buildHealthResponse(env, symbol = "BTC", ctx) {
  const [calibration, ladderFeeds, spot] = await Promise.all([
    getCalibrationHealth(env),
    getLadderFeedHealth(env, ctx),
    getSpotSourceHealth(symbol),
  ]);
  const degraded = !calibration.calibration_available;
  return {
    status: degraded ? "degraded" : "ok",
    degraded,
    storage: {
      reachable: calibration.storage_reachable,
      last_successful_calibration_write_timestamp:
        calibration.last_successful_calibration_write_timestamp,
    },
    calibration: {
      available: calibration.calibration_available,
    },
    ladder_feeds: ladderFeeds,
    spot,
  };
}

async function getCoinbaseRecentRange(symbol = "BTC", minutes = 30) {
  const productId = `${symbol}-USD`;
  const end = Math.floor(Date.now() / 1000);
  const start = end - minutes * 60;
  const r = await fetchMarketData(
    `${COINBASE_BASE}/products/${productId}/candles?start=${start}&end=${end}&granularity=60`,
    { headers: COINBASE_HEADERS }
  );
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Coinbase candles ${productId} -> HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const candles = await r.json();
  if (!candles.length) return { high: null, low: null, momentum_signal: null };
  const chrono = [...candles].sort((a, b) => a[0] - b[0]);
  const windowOpen = chrono[0][3];
  const windowClose = chrono[chrono.length - 1][4];
  const windowHigh = Math.max(...chrono.map((c) => c[2]));
  const windowLow = Math.min(...chrono.map((c) => c[1]));
  const span = windowHigh - windowLow;
  const move = windowClose - windowOpen;
  let momentumSignal = null;
  if (span > 0 && Math.abs(move) >= span * 0.15) {
    momentumSignal = move > 0 ? "continuation_up" : "continuation_down";
  }
  return { high: windowHigh, low: windowLow, momentum_signal: momentumSignal };
}

const MAX_HOURLY_MINUTES_TO_EXPIRY = 65;

async function getKalshiBands(spot, seriesTicker = "KXBTC", maxBandsEachSide = 6) {
  const r = await fetchMarketData(
    `${KALSHI_BASE}/markets?series_ticker=${seriesTicker}&status=open&limit=1000`
  );
  if (!r.ok) throw new Error(`Kalshi markets ${seriesTicker} -> HTTP ${r.status}`);
  const data = await r.json();
  const markets = data.markets || [];
  if (!markets.length) throw new Error(`No open Kalshi markets for series ${seriesTicker}`);

  const events = {};
  for (const m of markets) {
    (events[m.event_ticker] ||= []).push(m);
  }

  const now = new Date();
  let bestTicker = null;
  let bestMarkets = null;
  let bestClose = null;
  let minMinutes = Infinity;

  for (const [ticker, ms] of Object.entries(events)) {
    const close = new Date(ms[0].close_time);
    const mins = (close - now) / 60000;
    if (mins > 0 && mins < minMinutes) {
      minMinutes = mins;
      bestTicker = ticker;
      bestMarkets = ms;
      bestClose = close;
    }
  }

  // Hourly market gate: if nearest contract is > 65m away, Kalshi's hourly range
  // market is currently closed (e.g. overnight 1am-6am EDT where only 5pm daily contracts exist).
  // Never serve 14-hour daily contracts as hourly candidate bands.
  if (!bestTicker || minMinutes > MAX_HOURLY_MINUTES_TO_EXPIRY) {
    return {
      status: "MARKET_CLOSED",
      error: `Kalshi hourly market closed (next event ${bestTicker || "none"} closes in ${Number.isFinite(minMinutes) ? Math.round(minMinutes) : "unknown"}m)`,
      candidate_bands: [],
      minutes_to_expiry: Number.isFinite(minMinutes) ? minMinutes : null,
      event_ticker: bestTicker,
      market_active: false,
      collector_timestamp: new Date().toISOString(),
    };
  }

  const above = [];
  const below = [];
  for (const m of bestMarkets) {
    if (m.strike_type !== "between") continue;
    const low = m.floor_strike;
    const high = m.cap_strike;
    const yesAsk = Math.round(parseFloat(m.yes_ask_dollars) * 10000) / 100;
    const yesBid = Math.round(parseFloat(m.yes_bid_dollars) * 10000) / 100;
    if (low > spot) above.push({ dist: low - spot, low, high, yesAsk, yesBid });
    else if (high < spot) below.push({ dist: spot - high, low, high, yesAsk, yesBid });
  }
  above.sort((a, b) => a.dist - b.dist);
  below.sort((a, b) => a.dist - b.dist);

  const toBand = (b, side) => ({
    low: b.low,
    high: b.high,
    yes_ask: b.yesAsk,
    yes_bid: b.yesBid,
    side_vs_spot: side,
  });

  const candidateBands = [
    ...above.slice(0, maxBandsEachSide).map((b) => toBand(b, "ABOVE_SPOT")),
    ...below.slice(0, maxBandsEachSide).map((b) => toBand(b, "BELOW_SPOT")),
  ];
  const nowIso = new Date().toISOString();
  return {
    status: "ok",
    market_active: true,
    candidate_bands: candidateBands,
    bands: candidateBands,
    minutes_to_expiry: minMinutes,
    event_ticker: bestTicker,
    spot,
    computed_at: nowIso,
    collector_timestamp: nowIso,
    age_seconds: 0,
    _cache: "miss",
    cache: "miss",
  };
}

async function getKalshiUpdown(seriesTicker = "KXBTC15M") {
  const r = await fetchMarketData(
    `${KALSHI_BASE}/markets?series_ticker=${seriesTicker}&status=open&limit=5`
  );
  if (!r.ok) throw new Error(`Kalshi markets ${seriesTicker} -> HTTP ${r.status}`);
  const data = await r.json();
  const m = (data.markets || [])[0];
  if (!m) throw new Error(`No open Kalshi markets for series ${seriesTicker}`);
  const now = new Date();
  const closeTime = new Date(m.close_time);
  return {
    ticker: m.ticker,
    title: m.title,
    target_price: m.yes_sub_title,
    yes_bid_cents: Math.round(parseFloat(m.yes_bid_dollars) * 10000) / 100,
    yes_ask_cents: Math.round(parseFloat(m.yes_ask_dollars) * 10000) / 100,
    minutes_to_expiry: (closeTime - now) / 60000,
    settlement_window_seconds: 60,
    settlement_method: "kalshi_brti_60s_avg_vs_open",
  };
}

// KV read-through for the 15M check: the HUD + health poll this route every
// few seconds, and uncached every poll is a direct Kalshi hit (429s when
// markets are open). 45s TTL cuts upstream pressure ~10x; direct fetch
// remains the fallback when KV is unbound.
const KALSHI_UPDOWN_TTL_S = 45;
const kalshiUpdownCacheKey = (seriesTicker) => `kalshi:updown:${seriesTicker}`;

async function getKalshiUpdownCached(env, ctx, seriesTicker = "KXBTC15M") {
  const key = kalshiUpdownCacheKey(seriesTicker);
  if (env && env.MARKET_CACHE) {
    try {
      const raw = await env.MARKET_CACHE.get(key);
      if (raw) {
        const cached = JSON.parse(raw);
        return { ...cached, _cache: "hit", cache: "hit" };
      }
    } catch (_) { /* fall through to live fetch */ }
  }
  const live = await getKalshiUpdown(seriesTicker);
  const stamped = {
    ...live,
    computed_at: new Date().toISOString(),
    _cache: "miss",
    cache: "miss",
  };
  if (env && env.MARKET_CACHE) {
    const put = env.MARKET_CACHE.put(key, JSON.stringify(stamped), {
      expirationTtl: KALSHI_UPDOWN_TTL_S,
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    else await put.catch(() => {});
  }
  return stamped;
}

async function getKalshiOrderbook(ticker) {
  const r = await fetchMarketData(`${KALSHI_BASE}/markets/${ticker}/orderbook`);
  if (!r.ok) throw new Error(`Kalshi orderbook ${ticker} -> HTTP ${r.status}`);
  return r.json();
}

async function buildKalshiSnapshot(symbol = "BTC") {
  const spotData = await getCoinbaseSpot(symbol);
  const recent = await getCoinbaseRecentRange(symbol);
  const bandsData = await getKalshiBands(spotData.price, "KXBTC");
  return {
    venue: "KALSHI",
    symbol,
    spot: spotData.price,
    minutes_to_expiry: bandsData.minutes_to_expiry,
    candidate_bands: bandsData.candidate_bands,
    momentum_signal: recent.momentum_signal,
    recent_30m_high: recent.high,
    recent_30m_low: recent.low,
    settlement_window_seconds: null,
    snapshot_ts: new Date().toISOString(),
  };
}

async function getClobYesPrices(tokenId) {
  let yesBid = null;
  let yesAsk = null;
  try {
    const r = await fetchMarketData(`${POLYMARKET_CLOB_BASE}/price?token_id=${tokenId}&side=buy`);
    if (r.ok) {
      const d = await r.json();
      yesBid = Math.round(parseFloat(d.price) * 10000) / 100;
    }
  } catch (_) {}
  try {
    const r = await fetchMarketData(`${POLYMARKET_CLOB_BASE}/price?token_id=${tokenId}&side=sell`);
    if (r.ok) {
      const d = await r.json();
      yesAsk = Math.round(parseFloat(d.price) * 10000) / 100;
    }
  } catch (_) {}
  return [yesBid, yesAsk];
}

async function getPolymarketTwapUpdown(interval = "5m") {
  const step = TWAP_INTERVAL_SECONDS[interval];
  if (!step) {
    throw new Error(`interval must be one of ${Object.keys(TWAP_INTERVAL_SECONDS).join(", ")}`);
  }
  const windowStartTs = Math.floor(Date.now() / 1000 / step) * step;
  const slug = `btc-updown-${interval}-${windowStartTs}`;
  const r = await fetchMarketData(`${POLYMARKET_GAMMA_BASE}/events?slug=${slug}`);
  if (!r.ok) throw new Error(`Polymarket events ${slug} -> HTTP ${r.status}`);
  const events = await r.json();
  if (!events.length) throw new Error(`No Polymarket ${interval} TWAP Up/Down event found for slug ${slug}`);
  const market = events[0].markets[0];
  const tokenIds = JSON.parse(market.clobTokenIds || "[]");
  const [upBid, upAsk] = tokenIds.length ? await getClobYesPrices(tokenIds[0]) : [null, null];
  const endTime = new Date(market.endDate);
  return {
    slug,
    question: market.question,
    up_bid_cents: upBid,
    up_ask_cents: upAsk,
    minutes_to_expiry: (endTime - new Date()) / 60000,
    settlement_window_seconds: parseTwapWindowSeconds(market.description),
    settlement_method: "chainlink_twap",
  };
}

function etDateParts(now, withHour = false) {
  const options = {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  if (withHour) {
    options.hour = "numeric";
    options.hour12 = true;
  }
  const parts = new Intl.DateTimeFormat("en-US", options).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    month: get("month").toLowerCase(),
    day: parseInt(get("day"), 10),
    year: get("year"),
    hour: withHour ? get("hour") : null,
    dayPeriod: withHour ? (get("dayPeriod") || "").toLowerCase() : null,
  };
}

async function getPolymarketDailyBands(spot, maxBandsEachSide = 6) {
  const now = new Date();
  const { month, day, year } = etDateParts(now);
  const slug = `bitcoin-price-on-${month}-${day}-${year}`;
  const r = await fetchMarketData(`${POLYMARKET_GAMMA_BASE}/events?slug=${slug}`);
  if (!r.ok) throw new Error(`Polymarket events ${slug} -> HTTP ${r.status}`);
  const events = await r.json();
  if (!events.length) throw new Error(`No Polymarket event found for slug ${slug}`);
  const event = events[0];
  const endTime = new Date(event.endDate);
  const minutesToExpiry = (endTime - now) / 60000;

  const bandRe = /between\s*\$?([\d,]+)\s*and\s*\$?([\d,]+)/i;
  let settlementWindowSeconds = null;
  const above = [];
  const below = [];
  for (const m of event.markets || []) {
    const match = bandRe.exec(m.question || "");
    if (!match) continue;
    const low = parseFloat(match[1].replace(/,/g, ""));
    const high = parseFloat(match[2].replace(/,/g, ""));
    if (settlementWindowSeconds === null) {
      const parsed = parseTwapWindowSeconds(m.description);
      settlementWindowSeconds = parsed !== null ? parsed : 0;
    }
    const tokenIds = JSON.parse(m.clobTokenIds || "[]");
    let [yesBid, yesAsk] = tokenIds.length ? await getClobYesPrices(tokenIds[0]) : [null, null];
    if (yesBid === null || yesAsk === null) {
      const prices = JSON.parse(m.outcomePrices || "[null,null]");
      if (prices[0] !== null && prices[0] !== undefined) {
        yesBid = yesAsk = Math.round(parseFloat(prices[0]) * 10000) / 100;
      }
    }
    if (yesAsk === null) continue;
    if (low > spot) above.push({ dist: low - spot, low, high, yesAsk, yesBid: yesBid ?? yesAsk });
    else if (high < spot) below.push({ dist: spot - high, low, high, yesAsk, yesBid: yesBid ?? yesAsk });
  }
  above.sort((a, b) => a.dist - b.dist);
  below.sort((a, b) => a.dist - b.dist);

  const toBand = (b, side) => ({
    low: b.low,
    high: b.high,
    yes_ask: b.yesAsk,
    yes_bid: b.yesBid,
    side_vs_spot: side,
  });

  const candidateBands = [
    ...above.slice(0, maxBandsEachSide).map((b) => toBand(b, "ABOVE_SPOT")),
    ...below.slice(0, maxBandsEachSide).map((b) => toBand(b, "BELOW_SPOT")),
  ];
  return {
    candidate_bands: candidateBands,
    minutes_to_expiry: minutesToExpiry,
    settlement_window_seconds: settlementWindowSeconds,
    slug,
  };
}

async function buildPolymarketSnapshot(symbol = "BTC") {
  if (symbol !== "BTC") throw new Error("Only BTC is wired for Polymarket so far");
  const spotData = await getCoinbaseSpot(symbol);
  const recent = await getCoinbaseRecentRange(symbol);
  const bandsData = await getPolymarketDailyBands(spotData.price);
  return {
    venue: "POLYMARKET",
    symbol,
    spot: spotData.price,
    minutes_to_expiry: bandsData.minutes_to_expiry,
    candidate_bands: bandsData.candidate_bands,
    momentum_signal: recent.momentum_signal,
    recent_30m_high: recent.high,
    recent_30m_low: recent.low,
    settlement_window_seconds: bandsData.settlement_window_seconds,
    snapshot_ts: new Date().toISOString(),
  };
}

async function getPolymarketHourlyUpdown() {
  const now = new Date();
  const { month, day, year, hour, dayPeriod } = etDateParts(now, true);
  const hourStr = `${hour}${dayPeriod}`;
  const slug = `bitcoin-up-or-down-${month}-${day}-${year}-${hourStr}-et`;
  const r = await fetchMarketData(`${POLYMARKET_GAMMA_BASE}/events?slug=${slug}`);
  if (!r.ok) throw new Error(`Polymarket events ${slug} -> HTTP ${r.status}`);
  const events = await r.json();
  if (!events.length) throw new Error(`No Polymarket hourly Up/Down event found for slug ${slug}`);
  const market = events[0].markets[0];
  const tokenIds = JSON.parse(market.clobTokenIds || "[]");
  const [upBid, upAsk] = tokenIds.length ? await getClobYesPrices(tokenIds[0]) : [null, null];
  return {
    slug,
    question: market.question,
    up_bid_cents: upBid,
    up_ask_cents: upAsk,
    settlement_window_seconds: parseTwapWindowSeconds(market.description),
    settlement_method: "binance_1h_candle_open_close",
  };
}

const CACHE_KEY = "ladder:latest";
const KV_TTL_S = 90;

async function fetchLadderPayload(spot, seriesTicker = "KXBTC", maxBandsEachSide = 6) {
  const bandsData = await getKalshiBands(spot, seriesTicker, maxBandsEachSide);
  const nowIso = new Date().toISOString();
  return {
    computed_at: nowIso,
    age_seconds: 0,
    cache: "miss",
    _cache: "miss",
    status: bandsData.status || "ok",
    market_active: bandsData.market_active ?? true,
    candidate_bands: bandsData.candidate_bands || [],
    bands: bandsData.candidate_bands || [],
    minutes_to_expiry: bandsData.minutes_to_expiry,
    event_ticker: bandsData.event_ticker,
    spot,
    collector_timestamp: nowIso,
    error: bandsData.error || null,
  };
}

const ROUTES = [
  "GET /health",
  "GET /calibration/status",
  "GET /ladder?fresh=1",
  "GET /spot?symbol=BTC",
  "GET /coinbase/range?symbol=BTC&minutes=30",
  "GET /kalshi/bands?symbol=BTC&series=KXBTC",
  "GET /kalshi/updown?series=KXBTC15M",
  "GET /kalshi/orderbook?ticker=<kalshi_ticker>",
  "GET /polymarket/twap-updown?interval=5m|15m|4h",
  "GET /polymarket/daily-bands?symbol=BTC",
  "GET /polymarket/hourly-updown",
  "GET /snapshot/kalshi?symbol=BTC",
  "GET /snapshot/polymarket?symbol=BTC",
];

export default {
  async scheduled(_event, env, ctx) {
    if (env.MARKET_CACHE) {
      ctx.waitUntil(
        (async () => {
          try {
            const spotData = await getCoinbaseSpot("BTC");
            const payload = await fetchLadderPayload(spotData.price, "KXBTC");
            payload.cache = "cron";
            payload._cache = "cron";
            await env.MARKET_CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_S });
          } catch (e) {
            console.error("cron refresh failed:", e?.message || e);
          }
        })()
      );
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Cache-Control": "no-store, max-age=0",
        },
      });
    }
    try {
      const symbol = url.searchParams.get("symbol") || "BTC";
      switch (url.pathname) {
        case "/":
        case "":
          return jsonResponse({
            name: "scalper-market-data",
            description:
              "Live Coinbase/Kalshi/Polymarket data proxy for the Hourly Range Scalper uAgent.",
            routes: ROUTES,
          });
        case "/robots.txt":
          return new Response("User-agent: *\nDisallow: /\n", {
            status: 200,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "public, max-age=86400",
            },
          });
        case "/health":
          return jsonResponse(await buildHealthResponse(env, symbol, ctx));
        case "/calibration/status": {
          const database = env && (env.CALIBRATION_DB || env.jdwalkaz || env.truffle);
          if (!database) {
            return jsonResponse({
              status: "degraded",
              storage_reachable: false,
              degraded: true,
              error: "No CALIBRATION_DB, jdwalkaz or truffle binding found",
            }, 503);
          }
          try {
            const predCounts = await database
              .prepare(
                "SELECT COUNT(*) AS total, " +
                "COUNT(CASE WHEN resolved_at_utc IS NOT NULL THEN 1 END) AS resolved, " +
                "COUNT(CASE WHEN resolved_at_utc IS NULL THEN 1 END) AS pending " +
                "FROM predictions"
              )
              .first();
            const latestRep = await database
              .prepare("SELECT timestamp_utc, regime, correction_factor, brier_score FROM calibration_reports ORDER BY id DESC LIMIT 1")
              .first();
            return jsonResponse({
              status: "ok",
              database: "scalper-calibration",
              storage_reachable: true,
              degraded: false,
              predictions: {
                total: predCounts?.total ?? 0,
                resolved: predCounts?.resolved ?? 0,
                pending: predCounts?.pending ?? 0,
              },
              latest_report: latestRep || null,
              collector_timestamp: new Date().toISOString(),
            });
          } catch (e) {
            return jsonResponse({
              status: "error",
              storage_reachable: false,
              degraded: true,
              error: String(e?.message || e),
            }, 500);
          }
        }
        case "/calibration/latest": {
          const authHeader = request.headers.get("Authorization");
          const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
          if (!env.API_SECRET || token !== env.API_SECRET) {
            return jsonResponse({ error: "Unauthorized: Invalid or missing API secret" }, 401);
          }
          const db = env.CALIBRATION_DB || env.DB || env.GOOGLE_DB;
          if (!db) return jsonResponse({ error: "Database binding not configured on Worker" }, 500);
          const result = await db.prepare("SELECT * FROM calibration_ledger ORDER BY timestamp DESC LIMIT 1").first();
          return jsonResponse({ success: true, data: result });
        }
        case "/calibration/ledger": {
          const authHeader = request.headers.get("Authorization");
          const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
          if (!env.API_SECRET || token !== env.API_SECRET) {
            return jsonResponse({ error: "Unauthorized: Invalid or missing API secret" }, 401);
          }
          const db = env.CALIBRATION_DB || env.DB || env.GOOGLE_DB;
          if (!db) return jsonResponse({ error: "Database binding not configured on Worker" }, 500);
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
          const { results } = await db.prepare("SELECT * FROM calibration_ledger ORDER BY timestamp DESC LIMIT ?").bind(limit).all();
          return jsonResponse({ success: true, count: results.length, data: results });
        }
        case "/calibration/record": {
          if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
          const authHeader = request.headers.get("Authorization");
          const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
          if (!env.API_SECRET || token !== env.API_SECRET) {
            return jsonResponse({ error: "Unauthorized: Invalid or missing API secret" }, 401);
          }
          const db = env.CALIBRATION_DB || env.DB || env.GOOGLE_DB;
          if (!db) return jsonResponse({ error: "Database binding not configured on Worker" }, 500);
          const payload = await request.json();
          const {
            market_id,
            strike_price,
            brti_divergence,
            student_t_factor,
            tail_risk_prob,
            predicted_side,
            confidence,
          } = payload;
          const insertQuery = `
            INSERT INTO calibration_ledger (
              timestamp, market_id, strike_price, brti_divergence, 
              student_t_factor, tail_risk_prob, predicted_side, confidence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          await db.prepare(insertQuery).bind(
            new Date().toISOString(),
            market_id || "UNKNOWN",
            strike_price || 0,
            brti_divergence || 0,
            student_t_factor || 1.0,
            tail_risk_prob || 0.0,
            predicted_side || null,
            confidence || 0.0
          ).run();
          return jsonResponse({ success: true, message: "Calibration recorded" }, 201);
        }
        case "/query": {
          if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
          const authHeader = request.headers.get("Authorization");
          const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
          if (!env.API_SECRET || token !== env.API_SECRET) {
            return jsonResponse({ error: "Unauthorized: Invalid or missing API secret" }, 401);
          }
          const db = env.CALIBRATION_DB || env.DB || env.GOOGLE_DB;
          if (!db) return jsonResponse({ error: "Database binding not configured on Worker" }, 500);
          const body = await request.json();
          const sql = body.sql?.trim();
          if (!sql) return jsonResponse({ error: "Missing SQL statement in body" }, 400);
          const normalized = sql.toUpperCase();
          if (
            normalized.startsWith("INSERT") ||
            normalized.startsWith("UPDATE") ||
            normalized.startsWith("DELETE") ||
            normalized.startsWith("DROP") ||
            normalized.startsWith("ALTER")
          ) {
            return jsonResponse({ error: "Mutation statements blocked on /query endpoint" }, 403);
          }
          const params = body.params || [];
          const { results } = await db.prepare(sql).bind(...params).all();
          return jsonResponse({ success: true, results });
        }
        case "/spot":
          return jsonResponse(await getCoinbaseSpot(symbol));
        case "/coinbase/range":
          return jsonResponse(
            await getCoinbaseRecentRange(symbol, Number(url.searchParams.get("minutes") || 30))
          );
        case "/ladder": {
          const isFresh = url.searchParams.get("fresh") === "1" || url.searchParams.get("force") === "1";
          const series = url.searchParams.get("series") || "KXBTC";

          // C4: fresh bypass — entry decisions NEVER read cache
          if (isFresh || !env.MARKET_CACHE) {
            try {
              const spotData = await getCoinbaseSpot(symbol);
              const payload = await fetchLadderPayload(spotData.price, series);
              if (env.MARKET_CACHE && ctx && ctx.waitUntil) {
                ctx.waitUntil(
                  env.MARKET_CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_S })
                );
              }
              return jsonResponse(payload);
            } catch (e) {
              return jsonResponse({ error: "fresh fetch failed", detail: String(e?.message || e) }, 503);
            }
          }

          const raw = await env.MARKET_CACHE.get(CACHE_KEY);
          if (!raw) {
            // Cold cache: fetch through AND write back (C5) so next reader hits KV
            try {
              const spotData = await getCoinbaseSpot(symbol);
              const payload = await fetchLadderPayload(spotData.price, series);
              if (ctx && ctx.waitUntil) {
                ctx.waitUntil(
                  env.MARKET_CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_S })
                );
              }
              return jsonResponse(payload);
            } catch (e) {
              return jsonResponse({ error: "cache cold and fetch failed", detail: String(e?.message || e) }, 503);
            }
          }

          const payload = JSON.parse(raw);
          const computedTs = Date.parse(payload.computed_at);
          const ageSeconds = Number.isFinite(computedTs)
            ? Math.max(0, Math.round(((Date.now() - computedTs) / 1000) * 10) / 10)
            : 0;
          payload.age_seconds = ageSeconds;
          payload.cache = "hit";
          payload._cache = "hit";
          return jsonResponse(payload);
        }
        case "/kalshi/bands": {
          const isFresh = url.searchParams.get("fresh") === "1" || url.searchParams.get("force") === "1";
          const series = url.searchParams.get("series") || "KXBTC";

          if (isFresh || !env.MARKET_CACHE) {
            const spotData = await getCoinbaseSpot(symbol);
            const bands = await getKalshiBands(spotData.price, series);
            const nowIso = new Date().toISOString();
            const payload = {
              ...bands,
              _cache: "miss",
              cache: "miss",
              age_seconds: 0,
              computed_at: nowIso,
              collector_timestamp: nowIso,
              spot: spotData.price,
            };
            if (env.MARKET_CACHE && ctx && ctx.waitUntil) {
              ctx.waitUntil(
                env.MARKET_CACHE.put(CACHE_KEY, JSON.stringify({
                  ...payload,
                  bands: payload.candidate_bands || [],
                }), { expirationTtl: KV_TTL_S })
              );
            }
            return jsonResponse(payload);
          }

          const raw = await env.MARKET_CACHE.get(CACHE_KEY);
          if (raw) {
            const cached = JSON.parse(raw);
            const computedTs = Date.parse(cached.computed_at);
            const ageSeconds = Number.isFinite(computedTs)
              ? Math.max(0, Math.round(((Date.now() - computedTs) / 1000) * 10) / 10)
              : 0;
            return jsonResponse({
              ...cached,
              _cache: "hit",
              cache: "hit",
              age_seconds: ageSeconds,
            });
          }

          const spotData = await getCoinbaseSpot(symbol);
          const bands = await getKalshiBands(spotData.price, series);
          const nowIso = new Date().toISOString();
          const payload = {
            ...bands,
            _cache: "miss",
            cache: "miss",
            age_seconds: 0,
            computed_at: nowIso,
            collector_timestamp: nowIso,
            spot: spotData.price,
          };
          if (ctx && ctx.waitUntil) {
            ctx.waitUntil(
              env.MARKET_CACHE.put(CACHE_KEY, JSON.stringify({
                ...payload,
                bands: payload.candidate_bands || [],
              }), { expirationTtl: KV_TTL_S })
            );
          }
          return jsonResponse(payload);
        }
        case "/kalshi/updown":
          return jsonResponse(await getKalshiUpdownCached(env, ctx, url.searchParams.get("series") || "KXBTC15M"));
        case "/kalshi/orderbook": {
          const ticker = url.searchParams.get("ticker");
          if (!ticker) return jsonResponse({ error: "ticker query param required" }, 400);
          return jsonResponse(await getKalshiOrderbook(ticker));
        }
        case "/polymarket/twap-updown":
          return jsonResponse(await getPolymarketTwapUpdown(url.searchParams.get("interval") || "5m"));
        case "/polymarket/daily-bands": {
          const spotData = await getCoinbaseSpot(symbol);
          return jsonResponse(await getPolymarketDailyBands(spotData.price));
        }
        case "/polymarket/hourly-updown":
          return jsonResponse(await getPolymarketHourlyUpdown());
        case "/snapshot/kalshi":
          return jsonResponse(await buildKalshiSnapshot(symbol));
        case "/snapshot/polymarket":
          return jsonResponse(await buildPolymarketSnapshot(symbol));
        default:
          return jsonResponse({ error: "not found", routes: ROUTES }, 404);
      }
    } catch (err) {
      return jsonResponse({ error: String((err && err.message) || err) }, 502);
    }
  },
};
