/**
 * hypedog — Polymarket multi-asset up/down quoter with D1 calibration persistence.
 *
 * Exposes:
 *   GET /health                  → checks D1 jdwalkaz database readiness
 *   GET /quote?symbol=...        → live Polymarket 5m TWAP up/down quote (BTC/ETH/SOL/XRP)
 *   GET /robots.txt              → search engine crawl prevention
 *   GET /                        → service info
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

const SYMBOL_MAP = {
  btc: "bitcoin",
  bitcoin: "bitcoin",
  eth: "ethereum",
  ethereum: "ethereum",
  sol: "solana",
  solana: "solana",
  xrp: "xrp",
  ripple: "xrp",
};

const SLUG_PREFIX = {
  bitcoin: "btc",
  ethereum: "eth",
  solana: "sol",
  xrp: "xrp",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
}

async function fetchWithTimeout(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "hypedog/1.0" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function getClobPrice(tokenId, side) {
  try {
    const res = await fetchWithTimeout(`${CLOB_BASE}/price?token_id=${tokenId}&side=${side}`, 2000);
    if (res.ok) {
      const data = await res.json();
      return Math.round(parseFloat(data.price) * 10000) / 100;
    }
  } catch (_) {}
  return null;
}

async function fetchPolymarketQuote(canonicalSymbol) {
  const prefix = SLUG_PREFIX[canonicalSymbol];
  if (!prefix) return null;

  const step = 300; // 5 minutes
  const nowSec = Math.floor(Date.now() / 1000);
  const curWindow = Math.floor(nowSec / step) * step;
  const nextWindow = curWindow + step;

  // Prefer the current window if at least 15 seconds remain; otherwise fall back to next window
  const windowsToTry = [curWindow, nextWindow];

  for (const windowSec of windowsToTry) {
    const slug = `${prefix}-updown-5m-${windowSec}`;
    try {
      const res = await fetchWithTimeout(`${GAMMA_BASE}/events?slug=${slug}`);
      if (!res.ok) continue;
      const events = await res.json();
      if (!Array.isArray(events) || !events.length) continue;

      const event = events[0];
      const market = (event.markets && event.markets[0]) || {};
      const endDate = new Date(event.endDate || market.endDate);
      const minutesToExpiry = Math.max(0, (endDate.getTime() - Date.now()) / 60000);

      // If already expired in the past, skip to next window
      if (minutesToExpiry <= 0.05 && windowSec === curWindow) continue;

      let upCents = null;
      let downCents = null;

      try {
        const prices = JSON.parse(market.outcomePrices || "[]");
        if (prices[0] != null) upCents = Math.round(parseFloat(prices[0]) * 10000) / 100;
        if (prices[1] != null) downCents = Math.round(parseFloat(prices[1]) * 10000) / 100;
      } catch (_) {}

      // Check CLOB tokens if outcomePrices not available
      const tokenIds = JSON.parse(market.clobTokenIds || "[]");
      let upBid = null;
      let upAsk = null;
      if (tokenIds.length >= 2) {
        [upBid, upAsk] = await Promise.all([
          getClobPrice(tokenIds[0], "buy"),
          getClobPrice(tokenIds[0], "sell"),
        ]);
        if (upCents == null && upBid != null) upCents = upBid;
      }

      return {
        symbol: canonicalSymbol,
        slug: event.slug || slug,
        title: event.title || market.question,
        up_cents: upCents,
        down_cents: downCents,
        up_bid_cents: upBid,
        up_ask_cents: upAsk,
        minutes_to_expiry: Math.round(minutesToExpiry * 100) / 100,
        window_start_utc: new Date(windowSec * 1000).toISOString(),
        window_end_utc: endDate.toISOString(),
        venue: "POLYMARKET",
        settlement_method: "chainlink_twap",
        collector_timestamp: new Date().toISOString(),
      };
    } catch (_) {}
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Cache-Control": "no-store, max-age=0",
        },
      });
    }

    try {
      switch (url.pathname) {
        case "/":
        case "":
          return jsonResponse({
            name: "hypedog",
            description: "Polymarket multi-asset up/down quoter with D1 calibration persistence.",
            routes: [
              "GET /health",
              "GET /quote?symbol=bitcoin|ethereum|solana|xrp",
              "GET /robots.txt",
            ],
          });

        case "/robots.txt":
          return new Response("User-agent: *\nDisallow: /\n", {
            status: 200,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "public, max-age=86400",
            },
          });

        case "/health": {
          let d1Ready = false;
          let d1Error = null;
          try {
            const d1db = env && (env.jdwalkaz || env.truffle);
            if (d1db) {
              await d1db.prepare("SELECT 1 AS reachable").first();
              d1Ready = true;
            }
          } catch (e) {
            d1Ready = false;
            d1Error = String(e && e.message ? e.message : e);
          }
          return jsonResponse({
            status: "ok",
            d1_ready: d1Ready,
            d1_error: d1Error,
            service: "hypedog",
            supported_symbols: ["bitcoin", "ethereum", "solana", "xrp"],
            ts: new Date().toISOString(),
          });
        }

        case "/quote": {
          const rawSymbol = url.searchParams.get("symbol");
          if (!rawSymbol || !rawSymbol.trim()) {
            return jsonResponse(
              {
                error: "missing_symbol",
                usage: "/quote?symbol=bitcoin|ethereum|solana|xrp",
                supported: ["bitcoin", "ethereum", "solana", "xrp"],
              },
              400
            );
          }

          const normalized = rawSymbol.trim().toLowerCase();
          const canonical = SYMBOL_MAP[normalized];
          if (!canonical) {
            return jsonResponse(
              {
                error: "unsupported_symbol",
                symbol: rawSymbol,
                supported: ["bitcoin", "ethereum", "solana", "xrp"],
              },
              400
            );
          }

          const quote = await fetchPolymarketQuote(canonical);
          if (!quote) {
            return jsonResponse({
              symbol: canonical,
              error: "no_active_updown_window",
              note: "no market expiring within 6 minutes",
            });
          }

          // Asynchronously log quote into D1 jdwalkaz database
          // (falls back to the legacy truffle binding until redeployed)
          const quoteDb = env && (env.jdwalkaz || env.truffle);
          if (quoteDb) {
            const insertPromise = quoteDb
              .prepare(
                "INSERT INTO hypedog_quotes (timestamp_utc, symbol, slug, up_cents, down_cents, minutes_to_expiry) VALUES (?, ?, ?, ?, ?, ?)"
              )
              .bind(
                quote.collector_timestamp,
                quote.symbol,
                quote.slug,
                quote.up_cents,
                quote.down_cents,
                quote.minutes_to_expiry
              )
              .run()
              .catch((e) => console.error("D1 quote log err:", e));

            if (ctx && typeof ctx.waitUntil === "function") {
              ctx.waitUntil(insertPromise);
            } else {
              await insertPromise;
            }
          }

          return jsonResponse(quote);
        }

        default:
          return jsonResponse(
            {
              error: "not_found",
              routes: [
                "GET /health",
                "GET /quote?symbol=bitcoin|ethereum|solana|xrp",
                "GET /robots.txt",
              ],
            },
            404
          );
      }
    } catch (err) {
      return jsonResponse({ error: String((err && err.message) || err) }, 502);
    }
  },
};
