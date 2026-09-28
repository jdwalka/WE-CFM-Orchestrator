import { createSign, constants as cryptoConstants } from 'node:crypto';

/**
 * kalshi-ladder-worker — read-only, never places orders.
 * Serves hourly "between" band ladders (low/high strike + bid/ask + size +
 * open interest + minutes-to-expiry) for BTC and, as of this version, any
 * other coin Kalshi runs an hourly range series for.
 *
 * Uses floor_strike / cap_strike fields (native numbers) — no string parsing.
 * Data: strike_type = "between" bands only (excludes floor/cap outlier markets).
 *
 * Caching: same pattern as scalper-market-data — a cron trigger (every 1min)
 * proactively refreshes a KV-backed cache (LADDER_CACHE, shared namespace,
 * one key per symbol), so on-demand requests almost never call Kalshi
 * directly. The original version used a 5s in-memory cache, which is
 * per-isolate and essentially ineffective across Cloudflare's edge fleet —
 * every isolate cold-starts empty, so real traffic hit Kalshi's rate limit
 * constantly. An in-memory read-through cache is kept too, for the (rare)
 * case of multiple requests landing on the same warm isolate between KV reads.
 *
 * Routes (all accept ?symbol=BTC|ETH|SOL|XRP|DOGE|BNB, default BTC):
 *   GET /ladder       → band list sorted by low strike (HOURLY range series)
 *   GET /updown       → 15-minute binary Up/Down snapshot (single market:
 *                       floor strike + yes bid/ask + close time). 15m panel
 *                       cards MUST use this — never /ladder.
 *   GET /health       → worker liveness + cache age
 *   GET /edges        → flat array of [low, high] pairs for LME wiring
 *   GET /signals      → compact per-symbol snapshots for residual consumers
 *                       (?symbol= for one symbol, default all six)
 */

const KV_TTL_S = 60;

// Kalshi's hourly "range" series ticker per coin. Only these are wired up —
// HYPE has no Kalshi hourly range series as of this writing.
const SERIES_BY_SYMBOL = {
  BTC: "KXBTC",
  ETH: "KXETH",
  SOL: "KXSOL",
  XRP: "KXXRP",
  DOGE: "KXDOGE",
  BNB: "KXBNB",
};

// Kalshi's 15-minute Up/Down BINARY series per coin. These markets are a
// single yes/no contract vs floor_strike — there is no bracket ladder.
// The 15m panel cards must read /updown: feeding them /ladder (the hourly
// KX* range series above) shows strikes from a different instrument that
// can sit ~$1,000+ away from the 15m strike ("a thousand off").
// HYPE has no Kalshi 15m up/down series as of this writing.
const UPDOWN_SERIES_BY_SYMBOL = {
  BTC: "KXBTC15M",
  ETH: "KXETH15M",
  SOL: "KXSOL15M",
  XRP: "KXXRP15M",
  DOGE: "KXDOGE15M",
  BNB: "KXBNB15M",
};

let MEMO = {}; // symbol -> { fetched_ms, payload } — same-isolate fast path only
let MEMO_UPDOWN = {}; // updown symbol -> { fetched_ms, payload }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

// ── Kalshi authenticated fetch (RSA-PSS SHA-256) ─────────────────────────────
// Unauthenticated market-data calls get throttled for Worker egress IPs
// (sustained HTTP 429 too_many_requests — 129 hits / 6h on 2026-09-26, which
// is what starved the ladder/updown refresh and left every symbol on stale
// KV). Same signing scheme as electron/kalshi-ws-worker.js:
//   message = timestamp + method + reqPath (path+query, exactly as sent)
// Secrets KALSHI_KEY_ID / KALSHI_PRIVATE_KEY_PEM are set via
// `wrangler secret put`; when absent we fall back to the public fetch.
function kalshiAuthHeaders(env, method, reqPath) {
  const keyId = env?.KALSHI_KEY_ID;
  const pem = env?.KALSHI_PRIVATE_KEY_PEM;
  if (!keyId || !pem) return null;
  try {
    const timestamp = Date.now().toString();
    const message = timestamp + method + reqPath;
    const sign = createSign('SHA256');
    sign.update(message);
    sign.end();
    const signature = sign.sign({
      key: pem,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    }, 'base64');
    return {
      'KALSHI-ACCESS-KEY': keyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };
  } catch (e) {
    console.warn('[kalshi-ladder-worker] RSA sign failed, public fetch fallback:', e?.message || e);
    return null;
  }
}

function kalshiFetchHeaders(env, method, reqPath) {
  const base = { Accept: 'application/json', 'User-Agent': 'kalshi-ladder-worker/3.0' };
  const auth = kalshiAuthHeaders(env, method, reqPath);
  return auth ? { ...base, ...auth } : base;
}

function minutesToExpiry(closeTime) {
  if (!closeTime) return null;
  return Math.max(0, (new Date(closeTime).getTime() - Date.now()) / 60_000);
}

const FRESHNESS_THRESHOLD_S = 15 * 60; // 15 minutes max staleness for live strikes
const FRESHNESS_THRESHOLD_MS = FRESHNESS_THRESHOLD_S * 1000;

function isPayloadStaleOrExpired(payload) {
  if (!payload) return true;
  if (payload.status === "expired" || payload.expired === true) return true;
  const ageMs = ageAtReadMs(payload.fetched_at);
  if (ageMs == null || ageMs > FRESHNESS_THRESHOLD_MS) return true;

  const bands = payload.bands || [];
  if (!bands.length) return true;
  const hasLiveBand = bands.some((b) => {
    const mte = minutesToExpiry(b.close_time);
    return mte != null && mte > 0;
  });
  if (!hasLiveBand) return true;

  return false;
}

function attachLiveExpiry(payload) {
  if (!payload || !Array.isArray(payload.bands)) return payload;
  const bands = payload.bands.map((b) => ({
    ...b,
    minutes_to_expiry: minutesToExpiry(b.close_time),
  }));
  return {
    ...payload,
    bands,
  };
}

function isUpDownStaleOrExpired(payload) {
  if (!payload) return true;
  if (payload.status === "expired" || payload.expired === true) return true;
  const ageMs = ageAtReadMs(payload.fetched_at);
  if (ageMs == null || ageMs > FRESHNESS_THRESHOLD_MS) return true;
  if (payload.close_time) {
    const mte = minutesToExpiry(payload.close_time);
    if (mte != null && mte <= 0) return true;
  }
  return false;
}

function attachLiveExpiryUpDown(payload) {
  if (!payload) return payload;
  return {
    ...payload,
    minutes_to_expiry: minutesToExpiry(payload.close_time),
  };
}

function resolveSymbol(url) {
  const raw = (url.searchParams.get("symbol") || "BTC").toUpperCase();
  return SERIES_BY_SYMBOL[raw] ? raw : null;
}

function resolveUpDownSymbol(url) {
  const raw = (url.searchParams.get("symbol") || "BTC").toUpperCase();
  return UPDOWN_SERIES_BY_SYMBOL[raw] ? raw : null;
}

// 15-minute Up/Down binary snapshot. One open market per window: yes/no
// vs floor_strike. Returns nulls (never throws on thin books) when Kalshi
// has no bid/ask yet — callers must handle empty quotes.
async function fetchUpDown(symbol, env) {
  const series = UPDOWN_SERIES_BY_SYMBOL[symbol];
  const reqPath =
    `/trade-api/v2/markets?series_ticker=${series}&status=open&limit=10`;
  const kalshiUrl = "https://api.elections.kalshi.com" + reqPath;
  const res = await fetch(kalshiUrl, {
    headers: kalshiFetchHeaders(env, 'GET', reqPath),
  });
  if (!res.ok) throw new Error(`Kalshi API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // NOTE: Kalshi's per-market `status` reads "active" (not "open") for live
  // windows even when queried with ?status=open — exclude only finished ones.
  const markets = (data.markets || []).filter(
    (m) => m.status !== "closed" && m.status !== "settled" && Date.parse(m.close_time) > Date.now()
  );
  if (!markets.length) {
    return {
      status:        "expired",
      expired:       true,
      source:        "kalshi-ladder-worker",
      fetched_at:    new Date().toISOString(),
      market_type:   "updown-15m",
      symbol,
      series,
      open:          false,
      ticker:        null,
      floor_strike:  null,
      close_time:    null,
      message:       "No active unexpired 15m window found on Kalshi",
    };
  }
  // Nearest-expiring open window (normally exactly one).
  markets.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  const m = markets[0];
  return {
    status:            "ok",
    source:            "kalshi-ladder-worker",
    fetched_at:        new Date().toISOString(),
    market_type:       "updown-15m",
    symbol,
    series,
    open:              true,
    ticker:            m.ticker,
    event_ticker:      m.event_ticker ?? null,
    floor_strike:      m.floor_strike ?? null,
    cap_strike:        m.cap_strike ?? null,
    yes_bid:           m.yes_bid         ?? m.yes_bid_dollars  ?? null,
    yes_ask:           m.yes_ask         ?? m.yes_ask_dollars  ?? null,
    yes_bid_dollars:   m.yes_bid_dollars ?? null,
    yes_ask_dollars:   m.yes_ask_dollars ?? null,
    last_price_dollars: m.last_price_dollars ?? null,
    minutes_to_expiry: minutesToExpiry(m.close_time),
    close_time:        m.close_time,
    market_status:     m.status,
  };
}

function updownCacheKey(symbol) {
  return `kalshi-updown:${symbol}`;
}

function updownCooldownKey(symbol) {
  return `kalshi-updown-cooldown:${symbol}`;
}

let LAST_FAILURE_UPDOWN = {};

async function refreshUpDown(symbol, env) {
  const local = LAST_FAILURE_UPDOWN[symbol];
  if (local && Date.now() - local.at_ms < FAILURE_COOLDOWN_S * 1000) {
    return null;
  }
  if (env.LADDER_CACHE) {
    try {
      const cooling = await env.LADDER_CACHE.get(updownCooldownKey(symbol));
      if (cooling) return null;
    } catch (_) { /* KV read failure shouldn't block a live attempt */ }
  }
  try {
    const payload = await fetchUpDown(symbol, env);
    MEMO_UPDOWN[symbol] = { fetched_ms: Date.now(), payload };
    delete LAST_FAILURE_UPDOWN[symbol];
    if (env.LADDER_CACHE) {
      const ttl = (payload.status === "expired" || payload.open === false) ? 60 : KV_PERSIST_TTL_S;
      await env.LADDER_CACHE.put(updownCacheKey(symbol), JSON.stringify(payload), {
        expirationTtl: ttl,
      });
    }
    return payload;
  } catch (e) {
    const message = String((e && e.message) || e);
    LAST_FAILURE_UPDOWN[symbol] = { at_ms: Date.now(), message };
    if (env.LADDER_CACHE) {
      try {
        await env.LADDER_CACHE.put(updownCooldownKey(symbol), message, { expirationTtl: FAILURE_COOLDOWN_S });
      } catch (_) { /* best-effort */ }
    }
    console.error(`[kalshi-ladder-worker] updown refresh failed for ${symbol}:`, e);
    return null;
  }
}

async function getOrFetchUpDown(symbol, env, ctx) {
  const memo = MEMO_UPDOWN[symbol];
  if (memo?.payload) {
    if (isUpDownStaleOrExpired(memo.payload)) {
      delete MEMO_UPDOWN[symbol];
    } else if (Date.now() - memo.fetched_ms < KV_TTL_S * 1000) {
      return { ...attachLiveExpiryUpDown(memo.payload), cache: "memo" };
    }
  }
  if (env.LADDER_CACHE) {
    try {
      const raw = await env.LADDER_CACHE.get(updownCacheKey(symbol));
      if (raw) {
        const payload = JSON.parse(raw);
        if (isUpDownStaleOrExpired(payload)) {
          // Stale/expired in KV: try fresh fetch immediately
          try {
            const fresh = await refreshUpDown(symbol, env);
            if (fresh && !isUpDownStaleOrExpired(fresh)) {
              return { ...attachLiveExpiryUpDown(fresh), cache: "miss" };
            }
          } catch (_) {}
          return {
            status: "expired",
            expired: true,
            open: false,
            source: "kalshi-ladder-worker",
            market_type: "updown-15m",
            symbol,
            series: UPDOWN_SERIES_BY_SYMBOL[symbol],
            message: "Cached updown market has expired and fresh data is currently unavailable",
            fetched_at: payload.fetched_at,
            close_time: payload.close_time,
            minutes_to_expiry: 0,
            cache: "expired",
          };
        }
        const ageS = (Date.now() - Date.parse(payload.fetched_at)) / 1000;
        MEMO_UPDOWN[symbol] = { fetched_ms: Date.now(), payload };
        if (ageS < KV_TTL_S) {
          return { ...attachLiveExpiryUpDown(payload), cache: "kv" };
        }
        if (ctx) ctx.waitUntil(refreshUpDown(symbol, env));
        return { ...attachLiveExpiryUpDown(payload), cache: "kv-stale" };
      }
    } catch (e) {
      console.error(`[kalshi-ladder-worker] KV read failed for updown ${symbol}:`, e);
    }
  }
  try {
    const payload = await refreshUpDown(symbol, env);
    if (payload) {
      if (isUpDownStaleOrExpired(payload)) {
        return {
          status: "expired",
          expired: true,
          open: false,
          source: "kalshi-ladder-worker",
          market_type: "updown-15m",
          symbol,
          series: UPDOWN_SERIES_BY_SYMBOL[symbol],
          message: "No active unexpired 15m window found on Kalshi",
          fetched_at: payload.fetched_at,
          cache: "miss",
        };
      }
      return { ...attachLiveExpiryUpDown(payload), cache: "miss" };
    }
    const reason = LAST_FAILURE_UPDOWN[symbol]?.message || "refresh returned no payload (cooling down)";
    throw new Error(reason);
  } catch (e) {
    if (memo?.payload && !isUpDownStaleOrExpired(memo.payload)) {
      return { ...attachLiveExpiryUpDown(memo.payload), cache: "stale", error: String(e) };
    }
    return {
      status: "expired",
      expired: true,
      open: false,
      source: "kalshi-ladder-worker",
      market_type: "updown-15m",
      symbol,
      series: UPDOWN_SERIES_BY_SYMBOL[symbol],
      message: `Fresh updown market unavailable: ${String(e && e.message || e)}`,
      cache: "expired-fallback",
    };
  }
}

async function fetchLadder(symbol, env) {
  const series = SERIES_BY_SYMBOL[symbol];
  let cursor = "";
  const allMarkets = [];

  // Paginate through open markets. Kalshi sorts nearest-window-first, so a
  // single limit=1000 page normally returns the ENTIRE live window (no
  // cursor = complete). The old 6x100-page sweep pulled far-future windows
  // the single-window guard throws away anyway — 6x the requests for
  // nothing, and every extra page was another 429 dice roll that ended in
  // truncated 18-band caches and a synthetic panel.
  for (let page = 0; page < 3; page++) {
    const reqPath =
      `/trade-api/v2/markets?series_ticker=${series}&status=open&limit=1000` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const kalshiUrl = "https://api.elections.kalshi.com" + reqPath;
    const res = await fetch(kalshiUrl, {
      headers: kalshiFetchHeaders(env, 'GET', reqPath),
    });
    if (!res.ok) {
      // Transient mid-pagination failure (usually a 429): retry the SAME
      // page instead of caching a truncated ladder. A partial cache poisons
      // KV for a full day and drops the panel to synthetic — a thrown error
      // keeps last-good data + cooldown instead. Never salvage partials.
      let recovered = false;
      for (let retry = 0; retry < 2 && !recovered; retry++) {
        await new Promise((r) => setTimeout(r, 800 * (retry + 1)));
        try {
          const r2 = await fetch(kalshiUrl, {
            headers: kalshiFetchHeaders(env, 'GET', reqPath),
          });
          if (r2.ok) {
            const d2 = await r2.json();
            if (Array.isArray(d2.markets)) allMarkets.push(...d2.markets);
            cursor = d2.cursor || "";
            recovered = true;
          }
        } catch (_) { /* retry again */ }
      }
      if (recovered) {
        if (!cursor) break;
        continue;
      }
      if (allMarkets.length > 0) {
        throw new Error(
          `Kalshi API partial pagination rejected (pages done: ${page}, markets: ${allMarkets.length})`);
      }
      throw new Error(`Kalshi API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    if (Array.isArray(data.markets)) {
      allMarkets.push(...data.markets);
    }
    cursor = data.cursor || "";
    if (!cursor) break;
  }

  const bands = [];
  for (const m of allMarkets) {
    // Only take "between" bands (skip "above" / "below" boundary markets)
    if (m.strike_type !== "between") continue;
    if (m.floor_strike == null || m.cap_strike == null) continue;

    bands.push({
      ticker:             m.ticker,
      low:                m.floor_strike,
      high:               m.cap_strike,
      band:               `$${m.floor_strike.toLocaleString()}-$${m.cap_strike.toLocaleString()}`,
      yes_bid:            m.yes_bid          ?? m.yes_bid_dollars          ?? null,
      yes_ask:            m.yes_ask          ?? m.yes_ask_dollars          ?? null,
      yes_bid_dollars:    m.yes_bid_dollars  ?? null,
      yes_ask_dollars:    m.yes_ask_dollars  ?? null,
      yes_bid_size:       parseFloat(m.yes_bid_size_fp  || 0),
      yes_ask_size:       parseFloat(m.yes_ask_size_fp  || 0),
      open_interest:      parseFloat(m.open_interest_fp || 0),
      volume:             parseFloat(m.volume_fp        || 0),
      last_price_dollars: m.last_price_dollars ?? null,
      minutes_to_expiry:  minutesToExpiry(m.close_time),
      close_time:         m.close_time,
      status:             m.status,
    });
  }

  bands.sort((a, b) => a.low - b.low);

  // Single-window guard: Kalshi keeps expired windows listed as "open" for
  // hours — mixing them duplicates strikes on the panel.
  // Keep only the nearest window that hasn't closed yet.
  const closes = [...new Set(bands.map((b) => b.close_time))].sort();
  const liveClose = closes.find((ct) => Date.parse(ct) > Date.now());
  const windowBands = liveClose ? bands.filter((b) => b.close_time === liveClose) : [];

  if (!liveClose || windowBands.length === 0) {
    return {
      status:     "expired",
      expired:    true,
      source:     "kalshi-ladder-worker",
      fetched_at: new Date().toISOString(),
      band_count: 0,
      symbol,
      series,
      bands:      [],
      message:    "No active unexpired range window found on Kalshi",
    };
  }

  // Truncation guard: refuse to cache a ladder with suspiciously few bands
  // vs the last good cache (partial pagination that survived retries).
  // Caching 18 bands as "ok" is what drops the panel to synthetic for a
  // full day; throwing keeps last-good + cooldown and retries in 3 min.
  // Absolute floors backstop the relative check against staircase decline
  // (186 -> 90 -> 45 -> 22 -> 12 passes every halving step): a real BTC
  // hourly book holds 70+ bands; anything under the floor is never a
  // complete book, no matter what the cache says.
  const MIN_BANDS = { BTC: 40, ETH: 15, SOL: 8, XRP: 8, DOGE: 8, BNB: 8 };
  const bandFloor = MIN_BANDS[symbol] ?? 8;
  if (windowBands.length < bandFloor) {
    throw new Error(
      `Truncated ladder rejected for ${symbol}: only ${windowBands.length} bands (floor ${bandFloor})`);
  }
  if (env && env.LADDER_CACHE) {
    try {
      const rawOld = await env.LADDER_CACHE.get(`kalshi-ladder:${symbol}`);
      if (rawOld) {
        const oldCount = (JSON.parse(rawOld).bands || []).length;
        if (oldCount > 50 && windowBands.length < oldCount / 2) {
          throw new Error(
            `Truncated ladder rejected for ${symbol}: ${windowBands.length} bands vs cached ${oldCount}`);
        }
      }
    } catch (e) {
      if (String(e && e.message || e).startsWith("Truncated ladder rejected")) throw e;
      // KV read failure must never block a live fetch
    }
  }

  return {
    status:     "ok",
    source:     "kalshi-ladder-worker",
    fetched_at: new Date().toISOString(),
    band_count: windowBands.length,
    symbol,
    series,
    bands:      windowBands,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const symbol = resolveSymbol(url);
    if (!symbol) {
      return new Response(
        JSON.stringify({
          error: "unsupported symbol",
          supported: Object.keys(SERIES_BY_SYMBOL),
        }),
        { status: 400, headers: CORS }
      );
    }

    // Cold-start / Kalshi-hiccup safety net: getOrFetch can throw (no memo,
    // no KV entry yet, and the live Kalshi call also failed — e.g. a burst of
    // simultaneous cold fetches across symbols getting rate-limited right
    // after a deploy, before cron has had a chance to warm the cache). Without
    // this, that throw is an unhandled exception and Cloudflare returns an
    // opaque 500 with no body, which every symbol hit simultaneously on the
    // first deploy of multi-symbol support. Surface it as a typed 503 instead
    // so callers (the hourly-ranges panel) can tell "temporarily unavailable"
    // apart from a real bug, and so it always has CORS headers.
    try {
      // ── /health ────────────────────────────────────────────────────────────
      if (url.pathname === "/health" || url.pathname === "/gemini/health") {
        const payload = await getOrFetch(symbol, env, ctx);
        const expired = payload.status === "expired" || payload.expired === true || isPayloadStaleOrExpired(payload);
        const cacheAgeMs = ageAtReadMs(payload.fetched_at);
        const status = expired ? "expired" : (payload.error ? "degraded" : "ok");
        return new Response(
          JSON.stringify({
            status,
            healthy: status === "ok",
            worker:        "kalshi-ladder-worker",
            symbol,
            cache_age_ms:  cacheAgeMs,
            cache_age_s:   cacheAgeMs != null ? Math.round(cacheAgeMs / 1000) : null,
            cache_source:  payload.cache || null,
            band_count:    payload.band_count ?? (payload.bands?.length ?? null),
            expired,
            close_time:    payload.bands?.[0]?.close_time || payload.close_time || null,
            minutes_to_expiry: payload.bands?.[0]?.close_time
              ? minutesToExpiry(payload.bands[0].close_time)
              : (payload.minutes_to_expiry ?? null),
            ts:            new Date().toISOString(),
          }),
          { headers: CORS }
        );
      }

      // ── /edges — flat array of { low, high } for LME direct wiring ────────
      if (url.pathname === "/edges" || url.pathname === "/gemini/edges") {
        const payload = await getOrFetch(symbol, env, ctx);
        const bands = payload.bands || [];
        const edges = bands.map((b) => ({ low: b.low, high: b.high }));
        return new Response(
          JSON.stringify({ status: payload.status || "ok", edges, band_count: edges.length, fetched_at: payload.fetched_at, cache: payload.cache }),
          { headers: CORS }
        );
      }

      // ── /signals — compact snapshots for residual consumers ──────────
      // One entry per symbol (or ?symbol= for one): fetched_at, read-time
      // cache age, cache source, band_count, tightest-spread band, nearest
      // expiry. Served from the same KV/memo cache as /ladder — never calls
      // Kalshi directly beyond the normal getOrFetch path.
      if (url.pathname === "/signals" || url.pathname === "/gemini/signals") {
        const only = url.searchParams.get("symbol");
        const symbols = only
          ? (() => { const s = resolveSymbol(url); if (!s) return null; return [s]; })()
          : Object.keys(SERIES_BY_SYMBOL);
        if (!symbols) {
          return new Response(
            JSON.stringify({
              error: "unsupported symbol",
              supported: Object.keys(SERIES_BY_SYMBOL),
            }),
            { status: 400, headers: CORS }
          );
        }
        const signals = [];
        for (const sym of symbols) {
          const payload = await getOrFetch(sym, env, ctx);
          signals.push(summarizeSignal(sym, payload));
        }
        return new Response(
          JSON.stringify({ signals, ts: new Date().toISOString() }),
          { headers: CORS }
        );
      }

      // ── /updown — 15-minute binary Up/Down snapshot ───────────────────
      // Single market per window (floor strike + yes bid/ask). This is the
      // endpoint the 15m panel cards must use. /ladder is the HOURLY range
      // series — a different instrument.
      if (url.pathname === "/updown" || url.pathname === "/gemini/updown") {
        const upsym = resolveUpDownSymbol(url) || symbol;
        if (!upsym || !UPDOWN_SERIES_BY_SYMBOL[upsym]) {
          return new Response(
            JSON.stringify({
              error: "unsupported symbol",
              supported: Object.keys(UPDOWN_SERIES_BY_SYMBOL),
            }),
            { status: 400, headers: CORS }
          );
        }
        const payload = await getOrFetchUpDown(upsym, env, ctx);
        return new Response(JSON.stringify({
          ...payload,
          status: payload.market_status || (payload.open ? "active" : (payload.status || "closed")),
        }), { headers: CORS });
      }

      // ── /ladder (default) and /gemini/ladder ────────────────────────────────
      if (url.pathname === "/ladder" || url.pathname === "/gemini/ladder" || url.pathname === "/") {
        const force = url.searchParams.has("force") || url.searchParams.has("fresh");
        const payload = await getOrFetch(symbol, env, ctx, force);
        return new Response(JSON.stringify(payload), { headers: CORS });
      }

      return new Response(
        JSON.stringify({ error: "not found", routes: ["/ladder", "/gemini/ladder", "/updown", "/edges", "/health", "/signals"] }),
        { status: 404, headers: CORS }
      );
    } catch (e) {
      console.error(`[kalshi-ladder-worker] unhandled error for ${symbol} ${url.pathname}:`, e);
      return new Response(
        JSON.stringify({
          status: "error",
          error: "upstream-unavailable",
          message: String(e && e.message || e),
          symbol,
        }),
        { status: 503, headers: CORS }
      );
    }
  },

  // Cron trigger (every 1 minute) — keeps LADDER_CACHE warm for every
  // tracked symbol so on-demand requests almost never need to call Kalshi
  // directly. Genuinely sequential with a stagger, not Promise.all: firing
  // all 6 concurrently hit Kalshi's per-IP concurrency limit every single
  // tick, and network scheduling order made the SAME 3 symbols (ETH/XRP/BNB)
  // lose that race every time — a structural bias, not random rate-limiting,
  // that a random backoff can't fix. One request at a time removes the race
  // entirely.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshAllSequential(env));
  },
};

function cacheKey(symbol) {
  return `kalshi-ladder:${symbol}`;
}

// Persist good data for a full day. Kalshi rate-limiting for a few minutes
// must never mean the panel loses real data — the old 4x KV_TTL (4 minutes)
// TTL meant a sustained 429 window silently evaporated the cache entirely,
// which is exactly what dropped every symbol back to the synthetic ladder on
// 2026-09-17. Freshness is judged by fetched_at, not KV expiry, so a day-old
// entry is still served (labeled stale) rather than thrown away.
const KV_PERSIST_TTL_S = 60 * 60 * 24;

// Circuit breaker, cross-isolate via KV: once Kalshi 429s a symbol, every
// isolate must back off, not just the one that saw the failure. A symbol
// that never succeeds gets hit by every client poll PLUS cron across many
// concurrently-warm isolates, each with its own clock — a purely in-memory
// per-isolate cooldown can only cap ONE isolate's retry rate, so the
// aggregate request rate to Kalshi for a stuck symbol stayed high even with
// a cooldown in place, which is what kept ETH/XRP/BNB permanently 429'd
// while BTC/SOL/DOGE (lucky enough to succeed once) coasted on the 60s KV
// cache with near-zero further Kalshi calls. A KV-backed cooldown key is
// the same clock for every isolate everywhere.
const FAILURE_COOLDOWN_S = 120;
// symbol -> { at_ms, message } — fast local path so an isolate that just
// failed doesn't pay a KV read to rediscover that; it self-expires after
// FAILURE_COOLDOWN_S so a long-lived isolate keeps retrying periodically
// rather than refusing a symbol forever once it has failed once.
let LAST_FAILURE = {};

function cooldownKey(symbol) {
  return `kalshi-cooldown:${symbol}`;
}

async function refreshCache(symbol, env, force = false) {
  if (!force) {
    const local = LAST_FAILURE[symbol];
    if (local && Date.now() - local.at_ms < FAILURE_COOLDOWN_S * 1000) {
      return null; // this isolate just failed — same cooldown window as the KV key below
    }
    if (env.LADDER_CACHE) {
      try {
        const cooling = await env.LADDER_CACHE.get(cooldownKey(symbol));
        if (cooling) return null; // some isolate failed recently — global cooldown, don't add to the pressure
      } catch (_) { /* KV read failure shouldn't block a live attempt */ }
    }
  }
  try {
    const payload = await fetchLadder(symbol, env);
    MEMO[symbol] = { fetched_ms: Date.now(), payload };
    delete LAST_FAILURE[symbol];
    if (env.LADDER_CACHE) {
      const ttl = (payload.status === "expired" || payload.band_count === 0) ? 60 : KV_PERSIST_TTL_S;
      await env.LADDER_CACHE.put(cacheKey(symbol), JSON.stringify(payload), {
        expirationTtl: ttl,
      });
    }
    return payload;
  } catch (e) {
    const message = String((e && e.message) || e);
    LAST_FAILURE[symbol] = { at_ms: Date.now(), message };
    if (env.LADDER_CACHE) {
      try {
        await env.LADDER_CACHE.put(cooldownKey(symbol), message, { expirationTtl: FAILURE_COOLDOWN_S });
      } catch (_) { /* best-effort */ }
    }
    console.error(`[kalshi-ladder-worker] refresh failed for ${symbol}:`, e);
    throw e;
  }
}

const CRON_STAGGER_MS = 400;

async function refreshAllSequential(env) {
  for (const sym of Object.keys(SERIES_BY_SYMBOL)) {
    await refreshCache(sym, env);
    await new Promise((r) => setTimeout(r, CRON_STAGGER_MS));
  }
  // Warm the 15m binaries in the same tick, same stagger — one request at
  // a time, so the cron never bursts Kalshi's per-IP concurrency limit.
  for (const sym of Object.keys(UPDOWN_SERIES_BY_SYMBOL)) {
    await refreshUpDown(sym, env);
    await new Promise((r) => setTimeout(r, CRON_STAGGER_MS));
  }
}

// Read-time cache age: computed from Date.now() on every read, never
// baked into a stored payload, so repeated reads always report a live age.
function ageAtReadMs(fetched_at) {
  if (!fetched_at) return null;
  const t = Date.parse(fetched_at);
  return Number.isNaN(t) ? null : Date.now() - t;
}

// Compact one-symbol snapshot for /signals consumers.
function summarizeSignal(symbol, payload) {
  const bands = payload.bands || [];
  let tightest = null;
  let contested = null;
  let nearest_expiry = null;
  for (const b of bands) {
    if (b.yes_bid != null && b.yes_ask != null) {
      const spread = b.yes_ask - b.yes_bid;
      const entry = { ticker: b.ticker, low: b.low, high: b.high, spread };
      if (!tightest || spread < tightest.spread) {
        tightest = entry;
      }
      // A "tightest spread" on a pinned 1c/99c deep-OTM band is noise — it
      // masquerades as data (e.g. a $74.7k band on an $84k board). Prefer the
      // tightest spread among bands with genuine two-sided action.
      if (b.yes_bid >= 0.05 && b.yes_ask <= 0.95 &&
          (!contested || spread < contested.spread)) {
        contested = entry;
      }
    }
    const mte = minutesToExpiry(b.close_time);
    if (mte != null) {
      if (nearest_expiry == null || mte < nearest_expiry) {
        nearest_expiry = mte;
      }
    }
  }
  return {
    symbol,
    series: SERIES_BY_SYMBOL[symbol],
    status: payload.status || "ok",
    fetched_at: payload.fetched_at ?? null,
    cache_age_ms: ageAtReadMs(payload.fetched_at),
    cache_source: payload.cache ?? null,
    band_count: payload.band_count ?? bands.length,
    tightest_band: tightest,
    nearest_minutes_to_expiry: nearest_expiry,
  };
}

async function getOrFetch(symbol, env, ctx, force = false) {
  const memo = MEMO[symbol];

  if (!force) {
    // Fast path: same warm isolate served recently.
    if (memo?.payload) {
      if (isPayloadStaleOrExpired(memo.payload)) {
        delete MEMO[symbol];
      } else if (Date.now() - memo.fetched_ms < KV_TTL_S * 1000) {
        return { ...attachLiveExpiry(memo.payload), cache: "memo" };
      }
    }

    // Cross-isolate path: KV, refreshed by the cron trigger.
    if (env.LADDER_CACHE) {
      try {
        const raw = await env.LADDER_CACHE.get(cacheKey(symbol));
        if (raw) {
          const payload = JSON.parse(raw);
          if (isPayloadStaleOrExpired(payload)) {
            // Cached ladder is expired or older than freshness window.
            // Do NOT serve with kv-stale! Trigger a fresh fetch immediately.
            try {
              const fresh = await refreshCache(symbol, env, true);
              if (fresh && !isPayloadStaleOrExpired(fresh)) {
                return { ...attachLiveExpiry(fresh), cache: "miss" };
              }
            } catch (_) {}
            // Fresh fetch failed or returned expired: return clear expired/refreshing status
            return {
              status: "expired",
              expired: true,
              refreshing: true,
              source: "kalshi-ladder-worker",
              symbol,
              series: SERIES_BY_SYMBOL[symbol],
              message: "Cached ladder window has expired and fresh strikes are currently unavailable from upstream",
              fetched_at: payload.fetched_at,
              expired_at: payload.bands?.[0]?.close_time || null,
              cache_age_ms: ageAtReadMs(payload.fetched_at),
              band_count: 0,
              bands: [],
              cache: "expired",
            };
          }
          const ageS = (Date.now() - Date.parse(payload.fetched_at)) / 1000;
          MEMO[symbol] = { fetched_ms: Date.now(), payload };
          if (ageS < KV_TTL_S) {
            return { ...attachLiveExpiry(payload), cache: "kv" };
          }
          // Stale KV entry (within valid window and freshness threshold):
          // serve it immediately, refresh in the background so this request doesn't pay Kalshi's latency
          if (ctx) ctx.waitUntil(refreshCache(symbol, env));
          return { ...attachLiveExpiry(payload), cache: "kv-stale" };
        }
      } catch (e) {
        console.error(`[kalshi-ladder-worker] KV read failed for ${symbol}:`, e);
      }
    }
  }

  // No cache anywhere yet (cold start before the first cron tick) — fetch live
  try {
    const payload = await refreshCache(symbol, env, force);
    if (payload) {
      if (isPayloadStaleOrExpired(payload)) {
        return {
          status: "expired",
          expired: true,
          refreshing: true,
          source: "kalshi-ladder-worker",
          symbol,
          series: SERIES_BY_SYMBOL[symbol],
          message: "No active unexpired range window found on Kalshi",
          fetched_at: payload.fetched_at,
          band_count: 0,
          bands: [],
          cache: force ? "forced" : "miss",
        };
      }
      return { ...attachLiveExpiry(payload), cache: force ? "forced" : "miss" };
    }
    const reason = LAST_FAILURE[symbol]?.message || "refresh returned no payload (cooling down)";
    throw new Error(reason);
  } catch (e) {
    if (memo?.payload && !isPayloadStaleOrExpired(memo.payload)) {
      return { ...attachLiveExpiry(memo.payload), cache: "stale", error: String(e) };
    }
    return {
      status: "expired",
      expired: true,
      refreshing: true,
      source: "kalshi-ladder-worker",
      symbol,
      series: SERIES_BY_SYMBOL[symbol],
      message: `Fresh strikes unavailable: ${String(e && e.message || e)}`,
      band_count: 0,
      bands: [],
      cache: "expired-fallback",
    };
  }
}
