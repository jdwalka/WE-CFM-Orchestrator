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

function minutesToExpiry(closeTime) {
  if (!closeTime) return null;
  return Math.max(0, (new Date(closeTime).getTime() - Date.now()) / 60_000);
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
async function fetchUpDown(symbol) {
  const series = UPDOWN_SERIES_BY_SYMBOL[symbol];
  const kalshiUrl =
    "https://api.elections.kalshi.com/trade-api/v2/markets" +
    `?series_ticker=${series}&status=open&limit=10`;
  const res = await fetch(kalshiUrl, {
    headers: { Accept: "application/json", "User-Agent": "kalshi-ladder-worker/3.0" },
  });
  if (!res.ok) throw new Error(`Kalshi API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // NOTE: Kalshi's per-market `status` reads "active" (not "open") for live
  // windows even when queried with ?status=open — exclude only finished ones.
  const markets = (data.markets || []).filter(
    (m) => m.status !== "closed" && m.status !== "settled"
  );
  if (!markets.length) {
    return {
      status:        "ok",
      source:        "kalshi-ladder-worker",
      fetched_at:    new Date().toISOString(),
      market_type:   "updown-15m",
      symbol,
      series,
      open:          false,
      ticker:        null,
      floor_strike:  null,
      close_time:    null,
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
    const payload = await fetchUpDown(symbol);
    MEMO_UPDOWN[symbol] = { fetched_ms: Date.now(), payload };
    delete LAST_FAILURE_UPDOWN[symbol];
    if (env.LADDER_CACHE) {
      await env.LADDER_CACHE.put(updownCacheKey(symbol), JSON.stringify(payload), {
        expirationTtl: KV_PERSIST_TTL_S,
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
  if (memo?.payload && Date.now() - memo.fetched_ms < KV_TTL_S * 1000) {
    return { ...memo.payload, cache: "memo" };
  }
  if (env.LADDER_CACHE) {
    try {
      const raw = await env.LADDER_CACHE.get(updownCacheKey(symbol));
      if (raw) {
        const payload = JSON.parse(raw);
        const ageS = (Date.now() - Date.parse(payload.fetched_at)) / 1000;
        MEMO_UPDOWN[symbol] = { fetched_ms: Date.now(), payload };
        if (ageS < KV_TTL_S) {
          return { ...payload, cache: "kv" };
        }
        if (ctx) ctx.waitUntil(refreshUpDown(symbol, env));
        return { ...payload, cache: "kv-stale" };
      }
    } catch (e) {
      console.error(`[kalshi-ladder-worker] KV read failed for updown ${symbol}:`, e);
    }
  }
  try {
    const payload = await refreshUpDown(symbol, env);
    if (payload) return { ...payload, cache: "miss" };
    const reason = LAST_FAILURE_UPDOWN[symbol]?.message || "refresh returned no payload (cooling down)";
    throw new Error(reason);
  } catch (e) {
    if (memo?.payload) {
      return { ...memo.payload, cache: "stale", error: String(e) };
    }
    throw e;
  }
}

async function fetchLadder(symbol) {
  const series = SERIES_BY_SYMBOL[symbol];
  const kalshiUrl =
    "https://api.elections.kalshi.com/trade-api/v2/markets" +
    `?series_ticker=${series}&status=open&limit=100`;
  const res = await fetch(kalshiUrl, {
    headers: { Accept: "application/json", "User-Agent": "kalshi-ladder-worker/3.0" },
  });
  if (!res.ok) throw new Error(`Kalshi API ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const bands = [];
  for (const m of data.markets || []) {
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

  return {
    status:     "ok",
    source:     "kalshi-ladder-worker",
    fetched_at: new Date().toISOString(),
    band_count: bands.length,
    symbol,
    series,
    bands,
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
      if (url.pathname === "/health") {
        const payload = await getOrFetch(symbol, env, ctx);
        return new Response(
          JSON.stringify({
            status:        "ok",
            worker:        "kalshi-ladder-worker",
            symbol,
            cache_age_ms:  ageAtReadMs(payload.fetched_at),
            cache_source:  payload.cache,
            band_count:    payload.band_count ?? null,
            ts:            new Date().toISOString(),
          }),
          { headers: CORS }
        );
      }

      // ── /edges — flat array of { low, high } for LME direct wiring ────────
      if (url.pathname === "/edges") {
        const payload = await getOrFetch(symbol, env, ctx);
        const edges = payload.bands.map((b) => ({ low: b.low, high: b.high }));
        return new Response(
          JSON.stringify({ edges, band_count: edges.length, fetched_at: payload.fetched_at }),
          { headers: CORS }
        );
      }

      // ── /signals — compact snapshots for residual consumers ──────────
      // One entry per symbol (or ?symbol= for one): fetched_at, read-time
      // cache age, cache source, band_count, tightest-spread band, nearest
      // expiry. Served from the same KV/memo cache as /ladder — never calls
      // Kalshi directly beyond the normal getOrFetch path.
      if (url.pathname === "/signals") {
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
      if (url.pathname === "/updown") {
        const upsym = resolveUpDownSymbol(url);
        if (!upsym) {
          return new Response(
            JSON.stringify({
              error: "unsupported symbol",
              supported: Object.keys(UPDOWN_SERIES_BY_SYMBOL),
            }),
            { status: 400, headers: CORS }
          );
        }
        const payload = await getOrFetchUpDown(upsym, env, ctx);
        return new Response(JSON.stringify(payload), { headers: CORS });
      }

      // ── /ladder (default) ──────────────────────────────────────────────────
      if (url.pathname === "/ladder" || url.pathname === "/") {
        const payload = await getOrFetch(symbol, env, ctx);
        return new Response(JSON.stringify(payload), { headers: CORS });
      }

      return new Response(
        JSON.stringify({ error: "not found", routes: ["/ladder", "/updown", "/edges", "/health", "/signals"] }),
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

async function refreshCache(symbol, env) {
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
  try {
    const payload = await fetchLadder(symbol);
    MEMO[symbol] = { fetched_ms: Date.now(), payload };
    delete LAST_FAILURE[symbol];
    if (env.LADDER_CACHE) {
      await env.LADDER_CACHE.put(cacheKey(symbol), JSON.stringify(payload), {
        expirationTtl: KV_PERSIST_TTL_S,
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
    return null;
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
  let nearest_expiry = null;
  for (const b of bands) {
    if (b.yes_bid != null && b.yes_ask != null) {
      const spread = b.yes_ask - b.yes_bid;
      if (!tightest || spread < tightest.spread) {
        tightest = { ticker: b.ticker, low: b.low, high: b.high, spread };
      }
    }
    if (b.minutes_to_expiry != null) {
      if (nearest_expiry == null || b.minutes_to_expiry < nearest_expiry) {
        nearest_expiry = b.minutes_to_expiry;
      }
    }
  }
  return {
    symbol,
    series: SERIES_BY_SYMBOL[symbol],
    fetched_at: payload.fetched_at ?? null,
    cache_age_ms: ageAtReadMs(payload.fetched_at),
    cache_source: payload.cache ?? null,
    band_count: payload.band_count ?? bands.length,
    tightest_band: tightest,
    nearest_minutes_to_expiry: nearest_expiry,
  };
}

async function getOrFetch(symbol, env, ctx) {
  const memo = MEMO[symbol];

  // Fast path: same warm isolate served recently.
  if (memo?.payload && Date.now() - memo.fetched_ms < KV_TTL_S * 1000) {
    return { ...memo.payload, cache: "memo" };
  }

  // Cross-isolate path: KV, refreshed by the cron trigger.
  if (env.LADDER_CACHE) {
    try {
      const raw = await env.LADDER_CACHE.get(cacheKey(symbol));
      if (raw) {
        const payload = JSON.parse(raw);
        const ageS = (Date.now() - Date.parse(payload.fetched_at)) / 1000;
        MEMO[symbol] = { fetched_ms: Date.now(), payload };
        if (ageS < KV_TTL_S) {
          return { ...payload, cache: "kv" };
        }
        // Stale KV entry: serve it immediately, refresh in the background
        // so this request doesn't pay Kalshi's latency (or its 429s).
        if (ctx) ctx.waitUntil(refreshCache(symbol, env));
        return { ...payload, cache: "kv-stale" };
      }
    } catch (e) {
      console.error(`[kalshi-ladder-worker] KV read failed for ${symbol}:`, e);
    }
  }

  // No cache anywhere yet (cold start before the first cron tick) — fetch
  // live, same fallback behavior as before.
  try {
    const payload = await refreshCache(symbol, env);
    if (payload) return { ...payload, cache: "miss" };
    // refreshCache swallows its own error into LAST_FAILURE and returns
    // null (so callers can fall back to stale data); surface that real
    // reason here instead of a generic message that hides what actually
    // went wrong (Kalshi HTTP status, cooldown, etc).
    const reason = LAST_FAILURE[symbol]?.message || "refresh returned no payload (cooling down)";
    throw new Error(reason);
  } catch (e) {
    if (memo?.payload) {
      return { ...memo.payload, cache: "stale", error: String(e) };
    }
    throw e;
  }
}
