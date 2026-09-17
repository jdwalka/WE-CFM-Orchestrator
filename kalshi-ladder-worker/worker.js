/**
 * kalshi-ladder-worker — read-only, never places orders.
 * Serves KXBTC hourly band edges + yes_bid/yes_ask + size + minutes-to-expiry.
 *
 * Uses floor_strike / cap_strike fields (native numbers) — no string parsing.
 * Data: strike_type = "between" bands only (excludes floor/cap outlier markets).
 *
 * Routes:
 *   GET /ladder       → band list sorted by low strike
 *   GET /health       → worker liveness + cache age
 *   GET /edges        → flat array of [low, high] pairs for LME wiring
 */

const CACHE_TTL_MS = 5_000; // 5s in-memory cache per isolate
const KALSHI_URL =
  "https://api.elections.kalshi.com/trade-api/v2/markets" +
  "?series_ticker=KXBTC&status=open&limit=100";

let CACHE = { fetched_ms: 0, payload: null };

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
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ── /health ──────────────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status:        "ok",
          worker:        "kalshi-ladder-worker",
          cache_age_ms:  CACHE.payload ? Date.now() - CACHE.fetched_ms : null,
          band_count:    CACHE.payload?.band_count ?? null,
          ts:            new Date().toISOString(),
        }),
        { headers: CORS }
      );
    }

    // ── /edges — flat array of { low, high } for LME direct wiring ──────────
    if (url.pathname === "/edges") {
      const payload = await getOrFetch();
      const edges = payload.bands.map((b) => ({ low: b.low, high: b.high }));
      return new Response(
        JSON.stringify({ edges, band_count: edges.length, fetched_at: payload.fetched_at }),
        { headers: CORS }
      );
    }

    // ── /ladder (default) ────────────────────────────────────────────────────
    if (url.pathname === "/ladder" || url.pathname === "/") {
      const payload = await getOrFetch();
      return new Response(JSON.stringify(payload), { headers: CORS });
    }

    return new Response(
      JSON.stringify({ error: "not found", routes: ["/ladder", "/edges", "/health"] }),
      { status: 404, headers: CORS }
    );
  },
};

async function getOrFetch() {
  if (CACHE.payload && Date.now() - CACHE.fetched_ms < CACHE_TTL_MS) {
    return { ...CACHE.payload, cache: "hit" };
  }
  try {
    const payload = await fetchLadder();
    CACHE = { fetched_ms: Date.now(), payload };
    return { ...payload, cache: "miss" };
  } catch (e) {
    if (CACHE.payload) {
      return { ...CACHE.payload, cache: "stale", error: String(e) };
    }
    throw e;
  }
}
