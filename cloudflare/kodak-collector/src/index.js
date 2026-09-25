/**
 * kodak-collector — Jdwalkaz's cross-venue books, derivatives, and contracts.
 *
 * Cloudflare Worker port of the local Jdwalkaz Kodak collector. It aggregates
 * public market data for the hourly range engine:
 *   - Order-book midpoints across Binance, Bybit, OKX, MEXC, Coinbase,
 *     Kraken, Bitget, Gate
 *   - Funding and open interest across Binance, Bybit, OKX
 *   - Kalshi KXBTC hourly range contracts
 * No API keys are required and the Worker places no orders.
 */

const TIMEOUT_MS = 9000;
const KALSHI_RETRY_ATTEMPTS = 3;
const KALSHI_RETRY_BASE_DELAY_MS = 250;
const KALSHI_CACHE_TTL_MS = 60_000;
const COIN_PRODUCT = {
  BTCUSDT: { spot: "BTC-USD", kraken: "XBTUSD", okx: "BTC-USDT-SWAP" },
  ETHUSDT: { spot: "ETH-USD", kraken: "ETHUSD", okx: "ETH-USDT-SWAP" },
  SOLUSDT: { spot: "SOL-USD", kraken: "SOLUSD", okx: "SOL-USDT-SWAP" },
  XRPUSDT: { spot: "XRP-USD", kraken: "XRPUSD", okx: "XRP-USDT-SWAP" },
};

let kalshiCache = null;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "kodak-collector/1.0 (+workers.dev)", ...headers },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchKalshiJson(url) {
  let lastError;
  for (let attempt = 0; attempt < KALSHI_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const jitter = Math.random() * 100;
      await sleep(KALSHI_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + jitter);
    }
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  if (Array.isArray(rows[0])) return rows;
  return rows.map(row => [row?.p ?? row?.price, row?.s ?? row?.size ?? row?.qty]);
}

function summarizeBook(bids, asks) {
  const bidRows = normalizeRows(bids);
  const askRows = normalizeRows(asks);
  if (!bidRows.length || !askRows.length) return { ok: false };
  const bestBid = Number(bidRows[0][0]);
  const bestAsk = Number(askRows[0][0]);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return { ok: false };
  return {
    ok: true,
    best_bid: bestBid,
    best_ask: bestAsk,
    mid: (bestBid + bestAsk) / 2,
  };
}

async function fetchBook(name, url, bidPath, askPath) {
  try {
    const data = await fetchJson(url);
    const bids = bidPath(data);
    const asks = askPath(data);
    return { name, ...summarizeBook(bids, asks) };
  } catch (error) {
    return { name, ok: false, error: String(error?.message || error) };
  }
}

async function pullBooks(symbol, product) {
  const coin = symbol.replace(/USDT$/, "");
  const jobs = [
    fetchBook("binance_spot_book", `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=50`, d => d.bids, d => d.asks),
    fetchBook("binance_fut_book", `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=50`, d => d.bids, d => d.asks),
    fetchBook("bybit_book", `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`, d => d?.result?.b, d => d?.result?.a),
    fetchBook("okx_book", `https://www.okx.com/api/v5/market/books?instId=${product.okx}&sz=50`, d => d?.data?.[0]?.bids, d => d?.data?.[0]?.asks),
    fetchBook("mexc_book", `https://contract.mexc.com/api/v1/contract/depth/${coin}_USDT`, d => d?.data?.bids, d => d?.data?.asks),
    fetchBook("coinbase_book", `https://api.exchange.coinbase.com/products/${product.spot}/book?level=2`, d => d.bids, d => d.asks),
    fetchBook("kraken_book", `https://api.kraken.com/0/public/Depth?pair=${product.kraken}&count=50`, d => d?.result?.[product.kraken]?.bids, d => d?.result?.[product.kraken]?.asks),
    fetchBook("bitget_book", `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=USDT-FUTURES&limit=50`, d => d?.data?.bids, d => d?.data?.asks),
    fetchBook("gate_book", `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${coin}_USDT&limit=50`, d => d.bids, d => d.asks),
  ];
  return Promise.all(jobs);
}

async function fetchFunding(symbol) {
  const jobs = [
    (async () => {
      const d = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
      return { name: "binance", funding: Number(d?.lastFundingRate) };
    })(),
    (async () => {
      const d = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
      return { name: "bybit", funding: Number(d?.result?.list?.[0]?.fundingRate) };
    })(),
    (async () => {
      const d = await fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${symbol.replace(/USDT$/, "-USDT-SWAP")}`);
      return { name: "okx", funding: Number(d?.data?.[0]?.fundingRate) };
    })(),
  ];
  return Promise.allSettled(jobs);
}

async function fetchOpenInterest(symbol) {
  const coin = symbol.replace(/USDT$/, "");
  const jobs = [
    (async () => {
      const [oi, mark] = await Promise.all([
        fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
        fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
      ]);
      const openInterest = Number(oi?.openInterest) || 0;
      const markPrice = Number(mark?.markPrice) || 0;
      return { name: "binance", oiUsd: openInterest * markPrice };
    })(),
    (async () => {
      const d = await fetchJson(`https://www.okx.com/api/v5/public/open-interest?instId=${symbol.replace(/USDT$/, "-USDT-SWAP")}`);
      return { name: "okx", oiUsd: Number(d?.data?.[0]?.oiCcy || 0) };
    })(),
    (async () => {
      const d = await fetchJson(`https://contract.mexc.com/api/v1/contract/open_interest/${coin}_USDT`);
      return { name: "mexc", oiUsd: Number(d?.data?.openInterest || 0) };
    })(),
  ];
  return Promise.allSettled(jobs);
}

function tickerStrike(ticker) {
  const match = /-([BST])(\d{5,}(?:\.\d+)?)$/.exec(String(ticker || ""));
  if (!match) return null;
  const strike = Number.parseFloat(match[2]);
  return Number.isFinite(strike) ? strike : null;
}

function fixStrike(contract) {
  const strike = tickerStrike(contract?.ticker);
  if (strike == null) return contract;
  const stored = Number(contract.strike);
  if (Number.isFinite(stored) && Math.abs(strike - stored) < 25) return contract;
  return {
    ...contract,
    strike,
    strike_was: contract.strike,
    strike_source: "ticker",
  };
}

const CACHE_KEY = "ladder:latest";
const KV_TTL_S = 90;

async function fetchKalshiContracts(spot, env = null, forceRefresh = false) {
  const url = "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC&status=open&limit=1000";
  const now = Date.now();

  if (!forceRefresh && env && env.MARKET_CACHE) {
    try {
      const raw = await env.MARKET_CACHE.get(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        const computedTs = Date.parse(cached.computed_at);
        const ageSeconds = Number.isFinite(computedTs)
          ? Math.max(0, Math.round(((Date.now() - computedTs) / 1000) * 10) / 10)
          : 0;
        return {
          ok: true,
          cache: "hit",
          _cache: "hit",
          age_seconds: ageSeconds,
          computed_at: cached.computed_at,
          cached_at: cached.computed_at,
          close_ts: cached.close_ts || null,
          ladder_ticker: cached.event_ticker || cached.ladder_ticker || null,
          markets: cached.markets || cached.candidate_bands || cached.bands || [],
        };
      }
    } catch (_) {}
  }

  if (!forceRefresh && kalshiCache && now - kalshiCache.fetchedAt < KALSHI_CACHE_TTL_MS) {
    const ageSeconds = Math.round((now - kalshiCache.fetchedAt) / 1000);
    return {
      ...kalshiCache.payload,
      cache: "hit",
      _cache: "hit",
      age_seconds: ageSeconds,
      cached_at: new Date(kalshiCache.fetchedAt).toISOString(),
    };
  }

  try {
    const data = await fetchKalshiJson(url);
    const marketsByExpiry = new Map();
    for (const market of data?.markets || []) {
      const closeTime = Date.parse(market?.close_time || "");
      if (!Number.isFinite(closeTime) || closeTime <= now) continue;
      if (!Number.isFinite(Number(market?.floor_strike))) continue;
      if (!marketsByExpiry.has(market.close_time)) {
        marketsByExpiry.set(market.close_time, []);
      }
      marketsByExpiry.get(market.close_time).push(market);
    }

    const expiries = [...marketsByExpiry.keys()].sort((a, b) => Date.parse(a) - Date.parse(b));
    for (const expiry of expiries) {
      const nearSpot = marketsByExpiry
        .get(expiry)
        .filter(market => Math.abs(Number(market.floor_strike) - spot) <= 1500)
        .sort((a, b) => a.floor_strike - b.floor_strike);
      if (!nearSpot.length) continue;

      const contracts = nearSpot.map(market => fixStrike({
        ticker: market.ticker,
        strike: Number(market.floor_strike),
        low: Number(market.floor_strike),
        high: Number(market.cap_strike),
        yes_bid: market?.yes_bid_dollars ?? null,
        yes_ask: market?.yes_ask_dollars ?? null,
        close_ts: market?.close_time || null,
      }));
      const nowIso = new Date().toISOString();
      const payload = {
        ok: true,
        close_ts: expiry,
        ladder_ticker: nearSpot[0]?.event_ticker || null,
        event_ticker: nearSpot[0]?.event_ticker || null,
        markets: contracts,
        candidate_bands: contracts,
        bands: contracts,
        computed_at: nowIso,
        spot,
      };
      kalshiCache = { fetchedAt: now, payload };
      if (env && env.MARKET_CACHE) {
        env.MARKET_CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_S }).catch(() => {});
      }
      return { ...payload, cache: "miss", _cache: "miss", age_seconds: 0 };
    }

    const payload = { ok: false, error: "no expiry brackets spot ±1500" };
    kalshiCache = { fetchedAt: now, payload };
    return { ...payload, cache: "miss", _cache: "miss", age_seconds: 0 };
  } catch (error) {
    const message = String(error?.message || error);
    if (kalshiCache) {
      const ageSeconds = Math.round((Date.now() - kalshiCache.fetchedAt) / 1000);
      return {
        ...kalshiCache.payload,
        ok: true,
        cache: "stale",
        _cache: "stale",
        age_seconds: ageSeconds,
        cached_at: new Date(kalshiCache.fetchedAt).toISOString(),
        error: message,
      };
    }
    return { ok: false, error: message };
  }
}

export function resetKalshiCache() {
  kalshiCache = null;
}

function computeDerived(books, funding, openInterest) {
  const venueMids = {};
  for (const book of books) {
    if (book?.ok && Number.isFinite(book.mid)) venueMids[book.name] = book.mid;
  }
  const midValues = Object.values(venueMids);
  const coinbaseMid = venueMids.coinbase_book ?? null;
  if (!midValues.length || coinbaseMid == null) {
    return { coinbase_mid: coinbaseMid, venue_mids: venueMids, max_divergence_usd: null, divergent_venues: [] };
  }
  const divergentVenues = Object.entries(venueMids)
    .map(([venue, mid]) => ({ venue, mid, delta: mid - coinbaseMid }))
    .filter(row => Math.abs(row.delta) > 10)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const fundingValues = funding
    .filter(result => result.status === "fulfilled" && Number.isFinite(result.value.funding))
    .map(result => result.value.funding);
  const oiValues = openInterest
    .filter(result => result.status === "fulfilled" && Number.isFinite(result.value.oiUsd))
    .map(result => result.value.oiUsd);
  return {
    coinbase_mid: coinbaseMid,
    venue_mids: venueMids,
    max_divergence_usd: Math.max(...midValues.map(mid => Math.abs(mid - coinbaseMid)), 0),
    divergent_venues: divergentVenues,
    avg_funding: fundingValues.length ? fundingValues.reduce((a, b) => a + b, 0) / fundingValues.length : null,
    total_oi_usd: oiValues.length ? oiValues.reduce((a, b) => a + b, 0) : null,
  };
}

async function buildSnapshot(symbol = "BTCUSDT", env = null, forceRefresh = false) {
  const normalized = String(symbol || "BTCUSDT").toUpperCase();
  const product = COIN_PRODUCT[normalized] || {
    spot: `${normalized.replace(/USDT$/, "")}-USD`,
    kraken: `${normalized.replace(/USDT$/, "")}USD`,
    okx: `${normalized.replace(/USDT$/, "")}-USDT-SWAP`,
  };
  const [books, funding, openInterest] = await Promise.all([
    pullBooks(normalized, product),
    fetchFunding(normalized),
    fetchOpenInterest(normalized),
  ]);
  const derived = computeDerived(books, funding, openInterest);
  const contractsResult = await fetchKalshiContracts(derived.coinbase_mid, env, forceRefresh).catch(error => ({
    ok: false,
    error: String(error?.message || error),
  }));
  return {
    symbol: normalized,
    ts: new Date().toISOString(),
    books: Object.fromEntries(books.map(book => [book.name, book])),
    derivs: {
      funding: funding.map(result => result.status === "fulfilled" ? result.value : { name: "unknown", error: result.reason?.message }),
      open_interest: openInterest.map(result => result.status === "fulfilled" ? result.value : { name: "unknown", error: result.reason?.message }),
    },
    contracts: { kalshi_kxbtc: contractsResult },
    derived,
  };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await buildSnapshot("BTCUSDT", env, true);
        } catch (e) {
          console.error("kodak-collector cron refresh failed:", e?.message || e);
        }
      })()
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbol") || "BTCUSDT";
    const isFresh = url.searchParams.get("fresh") === "1" || url.searchParams.get("force") === "1";

    switch (url.pathname) {
      case "/":
      case "/health":
        return jsonResponse({
          status: "ok",
          worker: "kodak-collector",
          version: "2.0.0",
          endpoints: ["/health", "/snapshot", "/ladder"],
          ts: new Date().toISOString(),
        });
      case "/ladder": {
        if (isFresh || !env?.MARKET_CACHE) {
          try {
            const snap = await buildSnapshot(symbol, env, true);
            const kalshi = snap.contracts?.kalshi_kxbtc || {};
            const nowIso = new Date().toISOString();
            const payload = {
              status: kalshi.ok ? "ok" : "error",
              computed_at: nowIso,
              age_seconds: 0,
              cache: "miss",
              _cache: "miss",
              event_ticker: kalshi.ladder_ticker || kalshi.event_ticker || null,
              spot: snap.derived?.coinbase_mid || 0,
              candidate_bands: kalshi.markets || kalshi.bands || [],
              bands: kalshi.markets || kalshi.bands || [],
              error: kalshi.error || null,
            };
            if (env?.MARKET_CACHE && ctx?.waitUntil) {
              ctx.waitUntil(
                env.MARKET_CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_S })
              );
            }
            return jsonResponse(payload);
          } catch (e) {
            return jsonResponse({ error: "fresh ladder fetch failed", detail: String(e?.message || e) }, 503);
          }
        }

        const raw = await env.MARKET_CACHE.get(CACHE_KEY);
        if (!raw) {
          try {
            const snap = await buildSnapshot(symbol, env, true);
            const kalshi = snap.contracts?.kalshi_kxbtc || {};
            const nowIso = new Date().toISOString();
            const payload = {
              status: kalshi.ok ? "ok" : "error",
              computed_at: nowIso,
              age_seconds: 0,
              cache: "miss",
              _cache: "miss",
              event_ticker: kalshi.ladder_ticker || kalshi.event_ticker || null,
              spot: snap.derived?.coinbase_mid || 0,
              candidate_bands: kalshi.markets || kalshi.bands || [],
              bands: kalshi.markets || kalshi.bands || [],
              error: kalshi.error || null,
            };
            if (ctx?.waitUntil) {
              ctx.waitUntil(
                env.MARKET_CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_S })
              );
            }
            return jsonResponse(payload);
          } catch (e) {
            return jsonResponse({ error: "cold cache fetch failed", detail: String(e?.message || e) }, 503);
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
      case "/snapshot":
        try {
          return jsonResponse(await buildSnapshot(symbol, env, isFresh));
        } catch (error) {
          return jsonResponse({ status: "error", error: String(error?.message || error) }, 502);
        }
      default:
        return jsonResponse({ status: "error", error: "not_found" }, 404);
    }
  },
};
