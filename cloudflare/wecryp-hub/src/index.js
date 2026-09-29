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
//   GET /robots.txt  → disallow crawler bots on API endpoints
// ============================================================

const SERVICES = {
  hypedog: {
    url: "https://hypedog.gitgoin87.workers.dev/quote?symbol=bitcoin",
    desc: "Polymarket multi-asset up/down quoter (BTC/ETH/SOL/XRP), D1 logging",
  },
  scalper: {
    url: "https://scalper.leaksnipe.win/health",
    desc: "Scalper market data (jdwalkaz D1)",
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

async function probe(name, cfg, env, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    let res;
    if (name === "hypedog" && env?.HYPEDOG) {
      res = await env.HYPEDOG.fetch("https://hypedog/quote?symbol=bitcoin", {
        headers: { accept: "application/json" },
      });
    } else if (name === "scalper" && env?.SCALPER) {
      res = await env.SCALPER.fetch("https://scalper/health", {
        headers: { accept: "application/json" },
      });
    } else if (name === "price" && env?.PRICE_PROXY) {
      res = await env.PRICE_PROXY.fetch("https://price/", {
        headers: { accept: "*/*" },
      });
    } else if (name === "archiver" && env?.ARCHIVER) {
      res = await env.ARCHIVER.fetch("https://archiver/", {
        headers: { accept: "*/*" },
      });
    } else {
      res = await fetch(cfg.url, {
        signal: ctrl.signal,
        headers: { accept: "*/*" },
      });
    }
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

async function fetchQuote(symbol, env) {
  if (env?.HYPEDOG) {
    const res = await env.HYPEDOG.fetch(`https://hypedog/quote?symbol=${symbol}`, {
      headers: { accept: "application/json" },
    });
    return { status: res.status, body: await res.json() };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${QUOTE_BASE}/quote?symbol=${symbol}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    return { status: res.status, body: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env, ctx) {
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

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=86400",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return json({
        service: "wecryp-hub",
        version: "1.2.0",
        routes: ["/status", "/quote?symbol=", "/everything", "/robots.txt"],
        services: Object.fromEntries(
          Object.entries(SERVICES).map(([k, v]) => [k, v.desc])
        ),
      });
    }

    if (url.pathname === "/status") {
      const results = await Promise.all(
        Object.entries(SERVICES).map(([name, cfg]) => probe(name, cfg, env))
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
      try {
        const { status, body } = await fetchQuote(symbol, env);
        return json({ ...body, via: "wecryp-hub" }, status);
      } catch (e) {
        return json({ error: `hypedog unreachable: ${String(e && e.message ? e.message : e)}` }, 502);
      }
    }

    if (url.pathname === "/everything") {
      const [status, btcQuote] = await Promise.all([
        Promise.all(Object.entries(SERVICES).map(([name, cfg]) => probe(name, cfg, env))),
        fetchQuote("bitcoin", env)
          .then((r) => r.body)
          .catch((e) => ({ error: String(e && e.message ? e.message : e) })),
      ]);
      return json({
        fetched_at: new Date().toISOString(),
        services: status,
        all_healthy: status.every((r) => r.reachable),
        btc_quote: btcQuote,
      });
    }

    return json({ error: "unknown route", routes: ["/status", "/quote?symbol=", "/everything", "/robots.txt"] }, 404);
  },
};
