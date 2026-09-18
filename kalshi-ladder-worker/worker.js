/**
 * kalshi-ladder-worker — read-only, never places orders.
 * Serves KXBTC hourly band edges + yes_bid/yes_ask + size + minutes-to-expiry.
 *
 * Uses floor_strike / cap_strike fields (native numbers) — no string parsing.
 * Data: strike_type = "between" bands only (excludes floor/cap outlier markets).
 *
 * Caching: same pattern as scalper-market-data — a cron trigger (every 1min)
 * proactively refreshes a KV-backed cache (LADDER_CACHE, shared namespace,
 * distinct key), so on-demand requests almost never call Kalshi directly.
 * The previous version used a 5s in-memory cache, which is per-isolate and
 * essentially ineffective across Cloudflare's edge fleet — every isolate
 * cold-starts empty, so real traffic hit Kalshi's rate limit constantly.
 * An in-memory read-through cache is kept too, for the (rare) case of
 * multiple requests landing on the same warm isolate between KV reads.
 *
 * Routes:
 *   GET /ladder       → band list sorted by low strike
 *   GET /health       → worker liveness + cache age
 *   GET /edges        → flat array of [low, high] pairs for LME wiring
 */

const CACHE_KEY = "kalshi-ladder:latest";
const KV_TTL_S = 60;
const KALSHI_URL =
  "https://api.elections.kalshi.com/trade-api/v2/markets" +
  "?series_ticker=KXBTC&status=open&limit=100";

let MEMO = { fetched_ms: 0, payload: null }; // same-isolate fast path only

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

function minutesToExpiry(closeTime) {
  if (!closeTime) return null;
  return Math.max(0, (new Date(closeTime).getTime() - Date.now()) / 60_000);
}

async function fetchLadder() {
  const res = await fetch(KALSHI_URL, {
    headers: { Accept: "application/json", "User-Agent": "kalshi-ladder-worker/2.0" },
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
    series:     "KXBTC",
    bands,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ── /health ──────────────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      const payload = await getOrFetch(env, ctx);
      return new Response(
        JSON.stringify({
          status:        "ok",
          worker:        "kalshi-ladder-worker",
          cache_age_ms:  payload.fetched_at ? Date.now() - Date.parse(payload.fetched_at) : null,
          cache_source:  payload.cache,
          band_count:    payload.band_count ?? null,
          ts:            new Date().toISOString(),
        }),
        { headers: CORS }
      );
    }

    // ── /edges — flat array of { low, high } for LME direct wiring ──────────
    if (url.pathname === "/edges") {
      const payload = await getOrFetch(env, ctx);
      const edges = payload.bands.map((b) => ({ low: b.low, high: b.high }));
      return new Response(
        JSON.stringify({ edges, band_count: edges.length, fetched_at: payload.fetched_at }),
        { headers: CORS }
      );
    }

    // ── /ladder (default) ────────────────────────────────────────────────────
    if (url.pathname === "/ladder" || url.pathname === "/") {
      const payload = await getOrFetch(env, ctx);
      return new Response(JSON.stringify(payload), { headers: CORS });
    }

    return new Response(
      JSON.stringify({ error: "not found", routes: ["/ladder", "/edges", "/health"] }),
      { status: 404, headers: CORS }
    );
  },

  // Cron trigger (every 1 minute) — keeps LADDER_CACHE warm so on-demand
  // requests almost never need to call Kalshi directly.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshCache(env));
  },
};

async function refreshCache(env) {
  try {
    const payload = await fetchLadder();
    MEMO = { fetched_ms: Date.now(), payload };
    if (env.LADDER_CACHE) {
      await env.LADDER_CACHE.put(CACHE_KEY, JSON.stringify(payload), {
        expirationTtl: KV_TTL_S * 4, // generous outer bound; freshness is judged by fetched_at, not KV expiry
      });
    }
    return payload;
  } catch (e) {
    console.error("[kalshi-ladder-worker] refresh failed:", e);
    return null;
  }
}

async function getOrFetch(env, ctx) {
  // Fast path: same warm isolate served recently.
  if (MEMO.payload && Date.now() - MEMO.fetched_ms < KV_TTL_S * 1000) {
    return { ...MEMO.payload, cache: "memo" };
  }

  // Cross-isolate path: KV, refreshed by the cron trigger.
  if (env.LADDER_CACHE) {
    try {
      const raw = await env.LADDER_CACHE.get(CACHE_KEY);
      if (raw) {
        const payload = JSON.parse(raw);
        const ageS = (Date.now() - Date.parse(payload.fetched_at)) / 1000;
        MEMO = { fetched_ms: Date.now(), payload };
        if (ageS < KV_TTL_S) {
          return { ...payload, cache: "kv" };
        }
        // Stale KV entry: serve it immediately, refresh in the background
        // so this request doesn't pay Kalshi's latency (or its 429s).
        if (ctx) ctx.waitUntil(refreshCache(env));
        return { ...payload, cache: "kv-stale" };
      }
    } catch (e) {
      console.error("[kalshi-ladder-worker] KV read failed:", e);
    }
  }

  // No cache anywhere yet (cold start before the first cron tick) — fetch
  // live, same fallback behavior as before.
  try {
    const payload = await refreshCache(env);
    if (payload) return { ...payload, cache: "miss" };
    throw new Error("refresh returned no payload");
  } catch (e) {
    if (MEMO.payload) {
      return { ...MEMO.payload, cache: "stale", error: String(e) };
    }
    throw e;
  }
}
