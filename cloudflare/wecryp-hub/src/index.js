// ============================================================
// wecryp-hub — unified status + quote aggregator for the
// WeCryp stack on leaksnipe.win
//
// Routes:
//   GET /            → service map
//   GET /status      → fan-out health of every service
//   GET /quote?symbol=bitcoin|ethereum|solana|xrp
//                    → proxied hypedog up/down quote
//   GET /everything   → status + fresh BTC quote in one call
//
// No bindings required — pure edge fan-out. CORS enabled so
// the WECRYPTO app (Tailscale service) can call it directly.
// ============================================================

const SERVICES = {
  hypedog: {
    url: "https://hypedog.gitgoin87.workers.dev/quote?symbol=bitcoin",
    desc: "Polymarket multi-asset up/down quoter (BTC/ETH/SOL/XRP), D1 logging",
  },
  scalper: {
    url: "https://scalper.leaksnipe.win/health",
    desc: "Scalper market data (truffle D1)",
  },
  price: {
    url: "https://price.leaksnipe.win/",
    desc: "WeCryp price proxy (BRTI spot)",
  },
  archiver: {
    url: "https://asi1.leaksnipe.win/",
    desc: "Kodak market archiver",
  },
};

const QUOTE_BASE = "https://hypedog.gitgoin87.workers.dev";
const SYMBOLS = ["bitcoin", "ethereum", "solana", "xrp"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "cache-control": "no-store",
    },
  });

async function probe(name, cfg, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(cfg.url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON ok */ }
    return {
      service: name,
      desc: cfg.desc,
      reachable: res.ok,
      http_status: res.status,
      latency_ms: Date.now() - started,
      body,
    };
  } catch (e) {
    return {
      service: name,
      desc: cfg.desc,
      reachable: false,
      http_status: null,
      latency_ms: Date.now() - started,
      error: String(e && e.message ? e.message : e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return json({
        service: "wecryp-hub",
        version: "1.0.0",
        routes: ["/status", "/quote?symbol=", "/everything"],
        services: Object.fromEntries(
          Object.entries(SERVICES).map(([k, v]) => [k, v.desc])
        ),
      });
    }

    if (url.pathname === "/status") {
      const results = await Promise.all(
        Object.entries(SERVICES).map(([name, cfg]) => probe(name, cfg))
      );
      return json({
        fetched_at: new Date().toISOString(),
        all_healthy: results.every((r) => r.reachable),
        services: results,
      });
    }

    if (url.pathname === "/quote") {
      const symbol = (url.searchParams.get("symbol") || "bitcoin").toLowerCase();
      if (!SYMBOLS.includes(symbol)) {
        return json({ error: `unsupported symbol: ${symbol}`, supported: SYMBOLS }, 400);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`${QUOTE_BASE}/quote?symbol=${symbol}`, {
          signal: ctrl.signal,
          headers: { accept: "application/json" },
        });
        const body = await res.json();
        return json({ ...body, via: "wecryp-hub" }, res.status);
      } catch (e) {
        return json({ error: `hypedog unreachable: ${String(e && e.message ? e.message : e)}` }, 502);
      } finally {
        clearTimeout(timer);
      }
    }

    if (url.pathname === "/everything") {
      const [status, btcQuote] = await Promise.all([
        Promise.all(Object.entries(SERVICES).map(([name, cfg]) => probe(name, cfg))),
        fetch(`${QUOTE_BASE}/quote?symbol=bitcoin`, { headers: { accept: "application/json" } })
          .then((r) => r.json())
          .catch((e) => ({ error: String(e && e.message ? e.message : e) })),
      ]);
      return json({
        fetched_at: new Date().toISOString(),
        services: status,
        all_healthy: status.every((r) => r.reachable),
        btc_quote: btcQuote,
      });
    }

    return json({ error: "unknown route", routes: ["/status", "/quote?symbol=", "/everything"] }, 404);
  },
};
