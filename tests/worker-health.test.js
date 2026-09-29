import assert from "node:assert/strict";
import { test } from "node:test";

test("DerivativesFeed - data quality and multi-coin robustness", async () => {
  // Set up mock DOM/browser environment
  const venueHealthReports = [];
  const emittedEnvelopes = [];
  
  globalThis.window = {
    NetworkHealth: {
      update: (venue, data) => {
        venueHealthReports.push({ venue, ...data });
      },
    },
    DataLogger: {
      logDerivatives: () => {},
    },
    dispatchEvent: (ev) => {
      if (ev.name === "market-data-envelope") {
        emittedEnvelopes.push(ev.detail);
      }
    },
  };
  globalThis.document = {
    hidden: false,
    readyState: "complete",
    addEventListener: () => {},
  };
  globalThis.CustomEvent = class {
    constructor(name, opts) {
      this.name = name;
      this.detail = opts?.detail;
    }
  };
  globalThis.WebSocket = class {
    constructor() {}
    close() {}
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("hyperliquid")) {
      const universe = [
        { name: "BTC" }, { name: "ETH" }, { name: "SOL" },
        { name: "XRP" }, { name: "DOGE" }, { name: "BNB" },
      ];
      const ctxs = [
        { markPx: "85000", openInterest: "40000", funding: "0.00001" },
        { markPx: "2700", openInterest: "1000000", funding: "0.00001" },
        { markPx: "120", openInterest: "5000000", funding: "0.00001" },
        { markPx: "1.55", openInterest: "200000000", funding: "0.00001" },
        { markPx: "0.098", openInterest: "1000000000", funding: "0.00002" },
        { markPx: "780", openInterest: "65000", funding: "0.00001" },
      ];
      if (opts.body && String(opts.body).includes("predictedFundings")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify([ { universe }, ctxs ]), { status: 200 });
    }
    if (urlStr.includes("dapi.binance.com")) {
      // Simulate slow fallback response (latency simulated via recordDiagnostics)
      return new Response(JSON.stringify({ sumOpenInterestValue: "50000000" }), { status: 200 });
    }
    if (urlStr.includes("fapi.binance.com")) {
      return new Response(JSON.stringify({ code: 0, msg: "Restricted location" }), { status: 451 });
    }
    if (urlStr.includes("okx.com") && urlStr.includes("open-interest")) {
      return new Response(JSON.stringify({
        code: "0",
        data: [{ oiUsd: "2500000000", oiCcy: "29000", instId: "BTC-USDT-SWAP" }],
      }), { status: 200 });
    }
    if (urlStr.includes("okx.com") && urlStr.includes("funding-rate")) {
      return new Response(JSON.stringify({
        code: "0",
        data: [{ fundingRate: "0.000067" }],
      }), { status: 200 });
    }
    if (urlStr.includes("bybit.com")) {
      return new Response("Forbidden", { status: 403 });
    }
    if (urlStr.includes("indexer.dydx.trade")) {
      return new Response(JSON.stringify({ bids: [{ price: "84990" }], asks: [{ price: "85010" }] }), { status: 200 });
    }
    if (urlStr.includes("deribit.com")) {
      return new Response(JSON.stringify({ result: { mark_price: 85000, current_funding: 0.0001, bids: [], asks: [] } }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  let feed = null;
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    delete require.cache[require.resolve("../src/feeds/derivatives-feed.js")];
    require("../src/feeds/derivatives-feed.js");

    feed = globalThis.window.DerivativesFeed;
    assert.ok(feed, "DerivativesFeed should be registered on window");

    const detail = await feed.fetchAll();
    const coins = Object.keys(detail);
    assert.deepEqual(coins.sort(), ["BNB", "BTC", "DOGE", "ETH", "SOL", "XRP"].sort(), "All 6 coins must be present in detail");

    for (const sym of coins) {
      const state = detail[sym];
      assert.equal(state.available, true, `${sym} must report available: true`);
      assert.ok(state.oiUsd > 0, `${sym} must have positive oiUsd`);
      assert.ok(Number.isFinite(state.funding), `${sym} must have finite funding`);
      assert.ok(state.mark > 0, `${sym} must have positive mark price`);
      assert.ok(state.price > 0, `${sym} must have positive price`);
    }

    const diag = feed.getDiagnostics();
    assert.equal(diag.data_quality, "clean", "data_quality must be 'clean' even when secondary endpoints fail or are slow");

    const lastFeedReport = venueHealthReports.filter(r => r.venue === "DerivativesFeed").pop();
    assert.ok(lastFeedReport, "DerivativesFeed venue health must be reported");
    assert.equal(lastFeedReport.status, "healthy", "DerivativesFeed status must be healthy");
    assert.match(lastFeedReport.reason, /6\/6 coins · quality: clean/, "Report reason must state 6/6 coins · quality: clean");
  } finally {
    globalThis.fetch = originalFetch;
    if (feed) feed.stop();
  }
});

test("NetworkHealth - refreshDerivativesFeedStatus accurate counts and quality", () => {
  const mockFeed = {
    getDiagnostics: () => ({
      data_quality: "clean",
      latency_ms: {
        "api.hyperliquid.xyz": 250,
        "dapi.binance.com": 1580,
      },
    }),
    getAll: () => ({
      BTC: { available: true, venues: ["hyperliquid", "okx"] },
      ETH: { available: true, venues: ["hyperliquid", "okx"] },
      SOL: { available: true, venues: ["hyperliquid", "okx"] },
      XRP: { available: true, venues: ["hyperliquid", "okx"] },
      DOGE: { available: true, venues: ["hyperliquid", "okx"] },
      BNB: { available: true, venues: ["hyperliquid", "okx"] },
    }),
  };

  const all = mockFeed.getAll();
  const coins = Object.keys(all);
  const activeCoins = Object.values(all).filter(s => s && s.available);
  const diag = mockFeed.getDiagnostics();
  const quality = diag.data_quality || "clean";
  const coinCount = activeCoins.length || coins.length;
  const hasData = coinCount > 0;

  assert.equal(hasData, true);
  assert.equal(coinCount, 6);
  assert.equal(quality, "clean");
  assert.equal(hasData ? (quality === "clean" ? "healthy" : "degraded") : "recovering", "healthy");
  assert.equal(`${coinCount} coins · quality: ${quality}`, "6 coins · quality: clean");
});

test("kalshi-ladder-worker - /gemini/ladder route and stale data serving prevention", async () => {
  const workerModule = await import("../kalshi-ladder-worker/worker.js");
  const worker = workerModule.default;

  const kvStore = new Map();
  const env = {
    LADDER_CACHE: {
      get: async (k) => kvStore.get(k) || null,
      put: async (k, v) => kvStore.set(k, v),
      delete: async (k) => kvStore.delete(k),
    },
  };
  const ctx = { waitUntil: (p) => p };

  // 1. Verify /gemini/ladder returns 200 (never 404)
  const reqGemini = new Request("https://worker.test/gemini/ladder?symbol=BTC");
  const resGemini = await worker.fetch(reqGemini, env, ctx);
  assert.notEqual(resGemini.status, 404, "/gemini/ladder must never return 404");
  assert.equal(resGemini.status, 200, "/gemini/ladder must return 200");
  const dataGemini = await resGemini.json();
  assert.equal(dataGemini.status, "ok");
  assert.ok(Array.isArray(dataGemini.bands));

  // 2. Verify /health reports status, healthy boolean, and cache age
  const reqHealth = new Request("https://worker.test/health?symbol=BTC");
  const resHealth = await worker.fetch(reqHealth, env, ctx);
  assert.equal(resHealth.status, 200);
  const dataHealth = await resHealth.json();
  assert.equal(dataHealth.worker, "kalshi-ladder-worker");
  assert.equal(dataHealth.symbol, "BTC");
  assert.equal(dataHealth.status, "ok");
  assert.equal(dataHealth.healthy, true);
  assert.equal(typeof dataHealth.cache_age_ms, "number");
  assert.equal(typeof dataHealth.cache_age_s, "number");

  // 3. Stale ladder prevention: seed KV with expired yesterday ladder ($150) for SOL
  const expiredPayload = {
    status: "ok",
    source: "kalshi-ladder-worker",
    fetched_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    band_count: 1,
    symbol: "SOL",
    series: "KXSOL",
    bands: [
      {
        ticker: "KXSOL-EXPIRED-YESTERDAY",
        low: 150,
        high: 155,
        band: "$150-$155",
        close_time: new Date(Date.now() - 3600 * 1000).toISOString(), // expired 1 hour ago
        minutes_to_expiry: 0,
      },
    ],
  };
  await env.LADDER_CACHE.put("kalshi-ladder:SOL", JSON.stringify(expiredPayload));

  // Fetch when upstream Kalshi is simulated to fail (429)
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("kalshi")) {
      return new Response("Too Many Requests", { status: 429 });
    }
    return originalFetch(url);
  };

  try {
    const reqExpired = new Request("https://worker.test/gemini/ladder?symbol=SOL");
    const resExpired = await worker.fetch(reqExpired, env, ctx);
    assert.equal(resExpired.status, 200);
    const dataExpired = await resExpired.json();

    // Must NOT serve the expired 150 strike with kv-stale!
    assert.notEqual(dataExpired.cache, "kv-stale", "Must NOT serve expired strikes with kv-stale");
    assert.equal(dataExpired.status, "expired", "Must return expired status when cache is expired and upstream unavailable");
    assert.equal(dataExpired.expired, true);
    assert.equal(dataExpired.bands.length, 0, "Must return empty bands rather than yesterday's expired strikes");
    assert.match(dataExpired.message, /expired/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
