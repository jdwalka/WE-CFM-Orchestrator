// test_all_markets_and_edges.mjs
// Exhaustive test runner for all tickers, markets, services, and edge cases across the WeCryp stack.

import http from "node:http";

const RESULTS = [];

async function probe(testName, url, options = {}) {
  await new Promise(r => setTimeout(r, options.delayMs || 120));
  const started = Date.now();
  try {
    let res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs || 8000),
    });
    let text = await res.text();
    if ((res.status === 429 || (res.status === 502 && text.includes("429"))) && !options._retried) {
      await new Promise(r => setTimeout(r, 1500));
      return probe(testName, url, { ...options, _retried: true });
    }
    const elapsed = Date.now() - started;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const result = {
      test: testName,
      url,
      method: options.method || "GET",
      status: res.status,
      ok: res.ok,
      elapsed_ms: elapsed,
      is_json: !!json,
      headers: Object.fromEntries(res.headers.entries()),
      body: json || text.slice(0, 300),
    };
    RESULTS.push(result);
    return result;
  } catch (err) {
    const elapsed = Date.now() - started;
    const result = {
      test: testName,
      url,
      method: options.method || "GET",
      status: 0,
      ok: false,
      elapsed_ms: elapsed,
      error: String(err && err.message ? err.message : err),
    };
    RESULTS.push(result);
    return result;
  }
}

async function runAll() {
  console.log("=== STARTING EXHAUSTIVE STACK TEST ===");

  // 1. LOCAL FEEDS: Pyth Lazer (Port 8792)
  console.log("\n--- Section 1: Pyth Lazer Collector (8792) ---");
  await probe("Pyth /health", "http://127.0.0.1:8792/health");
  for (const sym of ["BTC", "ETH", "SOL", "XRP", "BNB"]) {
    await probe(`Pyth /snapshot?symbol=${sym}`, `http://127.0.0.1:8792/snapshot?symbol=${sym}`);
  }
  await probe("Pyth /snapshot/all", "http://127.0.0.1:8792/snapshot/all");
  // Pyth Edge cases
  await probe("Pyth /snapshot?symbol=UNKNOWN (Edge)", "http://127.0.0.1:8792/snapshot?symbol=UNKNOWN");
  await probe("Pyth /snapshot?symbol= (Edge)", "http://127.0.0.1:8792/snapshot?symbol=");
  await probe("Pyth /404 route (Edge)", "http://127.0.0.1:8792/nonexistent");

  // 2. LOCAL FEEDS: Coinbase L2 Order Book (Port 8793)
  console.log("\n--- Section 2: Coinbase L2 Features (8793) ---");
  await probe("Coinbase L2 /health", "http://127.0.0.1:8793/health");
  await probe("Coinbase L2 /l_ratio", "http://127.0.0.1:8793/l_ratio");
  await probe("Coinbase L2 /v_ratio", "http://127.0.0.1:8793/v_ratio");
  await probe("Coinbase L2 /dwell", "http://127.0.0.1:8793/dwell");
  await probe("Coinbase L2 /404 route (Edge)", "http://127.0.0.1:8793/badpath");

  // 3. LOCAL Jdwalkaz uAgent (Port 8002)
  console.log("\n--- Section 3: WeCryp Jdwalkaz uAgent (8002) ---");
  await probe("Jdwalkaz /health", "http://127.0.0.1:8002/health");
  await probe("Jdwalkaz /calibration", "http://127.0.0.1:8002/calibration");
  await probe("Jdwalkaz /weights", "http://127.0.0.1:8002/weights");
  await probe("Jdwalkaz /tail-diagnostics", "http://127.0.0.1:8002/tail-diagnostics");
  await probe("Jdwalkaz /kalshi-15m-model", "http://127.0.0.1:8002/kalshi-15m-model");
  await probe("Jdwalkaz /404 route (Edge)", "http://127.0.0.1:8002/not-a-route");

  // 4. SCALPER MARKET DATA WORKER (Direct & Route)
  console.log("\n--- Section 4: Scalper Market Data Worker ---");
  const SCALPER_HOSTS = [
    "https://scalper-market-data.gitgoin87.workers.dev",
    "https://scalper.leaksnipe.win",
  ];

  for (const host of SCALPER_HOSTS) {
    const prefix = host.includes("leaksnipe") ? "[Custom Domain]" : "[Direct Worker]";
    await probe(`${prefix} Scalper /health`, `${host}/health`);
    await probe(`${prefix} Scalper / (routes)`, `${host}/`);

    // Spot tickers
    for (const sym of ["BTC", "ETH", "SOL", "XRP"]) {
      await probe(`${prefix} Scalper /spot?symbol=${sym}`, `${host}/spot?symbol=${sym}`);
    }
    // Spot Edge cases
    await probe(`${prefix} Scalper /spot?symbol=DOGE (Edge)`, `${host}/spot?symbol=DOGE`);
    await probe(`${prefix} Scalper /spot?symbol=INVALID (Edge)`, `${host}/spot?symbol=INVALID_TICKER`);
    await probe(`${prefix} Scalper /spot?symbol= (Edge)`, `${host}/spot?symbol=`);

    // Coinbase range
    await probe(`${prefix} Scalper /coinbase/range?symbol=BTC&minutes=15`, `${host}/coinbase/range?symbol=BTC&minutes=15`);
    await probe(`${prefix} Scalper /coinbase/range?symbol=BTC&minutes=60`, `${host}/coinbase/range?symbol=BTC&minutes=60`);
    await probe(`${prefix} Scalper /coinbase/range?symbol=ETH&minutes=30`, `${host}/coinbase/range?symbol=ETH&minutes=30`);
    await probe(`${prefix} Scalper /coinbase/range?symbol=INVALID (Edge)`, `${host}/coinbase/range?symbol=INVALID`);

    // Kalshi Markets
    await probe(`${prefix} Scalper /kalshi/bands (KXBTC)`, `${host}/kalshi/bands?symbol=BTC&series=KXBTC`);
    await probe(`${prefix} Scalper /kalshi/updown (KXBTC15M)`, `${host}/kalshi/updown?series=KXBTC15M`);
    await probe(`${prefix} Scalper /kalshi/bands?series=INVALID (Edge)`, `${host}/kalshi/bands?series=INVALID_SERIES`);
    await probe(`${prefix} Scalper /kalshi/orderbook missing ticker (Edge)`, `${host}/kalshi/orderbook`);
    await probe(`${prefix} Scalper /kalshi/orderbook with ticker`, `${host}/kalshi/orderbook?ticker=KXBTC-26SEP1706`);

    // Polymarket Markets
    await probe(`${prefix} Scalper /polymarket/twap-updown (5m)`, `${host}/polymarket/twap-updown?interval=5m`);
    await probe(`${prefix} Scalper /polymarket/twap-updown (15m)`, `${host}/polymarket/twap-updown?interval=15m`);
    await probe(`${prefix} Scalper /polymarket/twap-updown (4h)`, `${host}/polymarket/twap-updown?interval=4h`);
    await probe(`${prefix} Scalper /polymarket/twap-updown interval=30m (Edge)`, `${host}/polymarket/twap-updown?interval=30m`);
    await probe(`${prefix} Scalper /polymarket/daily-bands (BTC)`, `${host}/polymarket/daily-bands?symbol=BTC`);
    await probe(`${prefix} Scalper /polymarket/hourly-updown`, `${host}/polymarket/hourly-updown`);
    await probe(`${prefix} Scalper /polymarket/daily-bands?symbol=ETH (Edge)`, `${host}/polymarket/daily-bands?symbol=ETH`);

    // Snapshots
    await probe(`${prefix} Scalper /snapshot/kalshi?symbol=BTC`, `${host}/snapshot/kalshi?symbol=BTC`);
    await probe(`${prefix} Scalper /snapshot/polymarket?symbol=BTC`, `${host}/snapshot/polymarket?symbol=BTC`);

    // Scalper Edge Cases
    await probe(`${prefix} Scalper OPTIONS /health (CORS Edge)`, `${host}/health`, { method: "OPTIONS" });
    await probe(`${prefix} Scalper /invalid-route (404 Edge)`, `${host}/invalid-route`);
  }

  // 5. HYPEDOG WORKER
  console.log("\n--- Section 5: Hypedog Multi-Asset Up/Down Quoter ---");
  const HYPEDOG_HOSTS = [
    "https://hypedog.gitgoin87.workers.dev",
    "https://trufflehype.leaksnipe.win",
  ];

  for (const host of HYPEDOG_HOSTS) {
    const prefix = host.includes("leaksnipe") ? "[Custom Domain]" : "[Direct Worker]";
    for (const sym of ["bitcoin", "ethereum", "solana", "xrp"]) {
      await probe(`${prefix} Hypedog /quote?symbol=${sym}`, `${host}/quote?symbol=${sym}`);
    }
    // Hypedog Edge cases
    await probe(`${prefix} Hypedog /quote?symbol=BITCOIN (Uppercase Edge)`, `${host}/quote?symbol=BITCOIN`);
    await probe(`${prefix} Hypedog /quote?symbol=doge (Unsupported Edge)`, `${host}/quote?symbol=doge`);
    await probe(`${prefix} Hypedog /quote?symbol= (Empty Edge)`, `${host}/quote?symbol=`);
    await probe(`${prefix} Hypedog /quote (Missing Param Edge)`, `${host}/quote`);
    await probe(`${prefix} Hypedog /health (Endpoint Probe)`, `${host}/health`);
    await probe(`${prefix} Hypedog /unknown (404 Edge)`, `${host}/unknown`);
  }

  // 6. WECRYP HUB WORKER
  console.log("\n--- Section 6: WeCryp Hub Worker ---");
  const HUB_HOSTS = [
    "https://wecryp-hub.gitgoin87.workers.dev",
    "https://hub.leaksnipe.win",
  ];

  for (const host of HUB_HOSTS) {
    const prefix = host.includes("leaksnipe") ? "[Custom Domain]" : "[Direct Worker]";
    await probe(`${prefix} Hub / (service map)`, `${host}/`);
    await probe(`${prefix} Hub /status (fan-out)`, `${host}/status`);
    for (const sym of ["bitcoin", "ethereum", "solana", "xrp"]) {
      await probe(`${prefix} Hub /quote?symbol=${sym}`, `${host}/quote?symbol=${sym}`);
    }
    await probe(`${prefix} Hub /everything`, `${host}/everything`);
    // Hub Edge cases
    await probe(`${prefix} Hub /quote?symbol=cardano (Unsupported Edge)`, `${host}/quote?symbol=cardano`);
    await probe(`${prefix} Hub /quote?symbol= (Empty Edge)`, `${host}/quote?symbol=`);
    await probe(`${prefix} Hub OPTIONS /status (CORS Edge)`, `${host}/status`, { method: "OPTIONS" });
    await probe(`${prefix} Hub /not-found (404 Edge)`, `${host}/not-found`);
  }

  // 7. OTHER SUITE WORKERS
  console.log("\n--- Section 7: Ancillary Workers ---");
  await probe("wecryp-price-proxy (.workers.dev)", "https://wecryp-price-proxy.gitgoin87.workers.dev/");
  await probe("kodak-market-archiver (.workers.dev)", "https://kodak-market-archiver.gitgoin87.workers.dev/");
  await probe("price.leaksnipe.win (Custom Domain / WAF check)", "https://price.leaksnipe.win/");
  await probe("asi1.leaksnipe.win (Custom Domain / WAF check)", "https://asi1.leaksnipe.win/");

  console.log("\n=== COMPLETED ALL TESTS ===");
  console.log(JSON.stringify(RESULTS, null, 2));
}

runAll().catch(console.error);
