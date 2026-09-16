import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { resetKalshiCache } from "../cloudflare/kodak-collector/src/index.js";

const originalFetch = globalThis.fetch;

function mockUpstreams() {
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("binance.com/api/v3/depth")) {
      return Response.json({ bids: [["76000", "1"]], asks: [["76010", "1"]] });
    }
    if (value.includes("fapi.binance.com/fapi/v1/depth")) {
      return Response.json({ bids: [["75990", "1"]], asks: [["76000", "1"]] });
    }
    if (value.includes("bybit.com/v5/market/orderbook")) {
      return Response.json({ result: { b: [["75995", "1"]], a: [["76005", "1"]] } });
    }
    if (value.includes("okx.com/api/v5/market/books")) {
      return Response.json({ data: [{ bids: [["75996", "1"]], asks: [["76006", "1"]] }] });
    }
    if (value.includes("contract.mexc.com/api/v1/contract/depth")) {
      return Response.json({ data: { bids: [["75997", "1"]], asks: [["76007", "1"]] } });
    }
    if (value.includes("api.exchange.coinbase.com/products")) {
      return Response.json({ bids: [["75998", "1"]], asks: [["76008", "1"]] });
    }
    if (value.includes("api.kraken.com/0/public/Depth")) {
      return Response.json({ result: { XBTUSD: { bids: [["75999", "1"]], asks: [["76009", "1"]] } } });
    }
    if (value.includes("bitget.com/api/v2/mix/market/merge-depth")) {
      return Response.json({ data: { bids: [["75994", "1"]], asks: [["76004", "1"]] } });
    }
    if (value.includes("gateio.ws/api/v4/futures/usdt/order_book")) {
      return Response.json({ bids: [["75993", "1"]], asks: [["76003", "1"]] });
    }
    if (value.includes("fapi.binance.com/fapi/v1/premiumIndex")) {
      return Response.json({ lastFundingRate: "0.0001", markPrice: "76000" });
    }
    if (value.includes("fapi.binance.com/fapi/v1/openInterest")) {
      return Response.json({ openInterest: "10" });
    }
    if (value.includes("bybit.com/v5/market/tickers")) {
      return Response.json({ result: { list: [{ fundingRate: "0.0002" }] } });
    }
    if (value.includes("okx.com/api/v5/public/funding-rate")) {
      return Response.json({ data: [{ fundingRate: "0.0003" }] });
    }
    if (value.includes("okx.com/api/v5/public/open-interest")) {
      return Response.json({ data: [{ oiCcy: "5" }] });
    }
    if (value.includes("contract.mexc.com/api/v1/contract/open_interest")) {
      return Response.json({ data: { openInterest: 3 } });
    }
    if (value.includes("api.elections.kalshi.com")) {
      return Response.json({
        markets: [
          {
            ticker: "KXBTC-26SEP1512-B76550",
            floor_strike: 76500,
            cap_strike: 76599.99,
            event_ticker: "KXBTC-26SEP1512",
            yes_bid_dollars: "0.10",
            yes_ask_dollars: "0.12",
            close_time: "2026-09-15T16:00:00Z",
          },
          {
            ticker: "KXBTC-26SEP1512-B76450",
            floor_strike: 76400,
            cap_strike: 76499.99,
            event_ticker: "KXBTC-26SEP1512",
            yes_bid_dollars: "0.20",
            yes_ask_dollars: "0.22",
            close_time: "2026-09-15T16:00:00Z",
          },
        ],
      });
    }
    throw new Error(`Unexpected upstream request: ${value}`);
  };
}

async function call(path) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`));
  return { response, body: await response.json() };
}

test("health returns worker metadata without upstream calls", async () => {
  const { response, body } = await call("/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(body.status, "ok");
  assert.equal(body.worker, "kodak-collector");
});

test("snapshot aggregates books, funding, OI, and fixed Kalshi strikes", async () => {
  resetKalshiCache();
  mockUpstreams();
  try {
    const { response, body } = await call("/snapshot?symbol=BTCUSDT");
    assert.equal(response.status, 200);
    assert.equal(body.symbol, "BTCUSDT");
    assert.equal(body.books.binance_spot_book.ok, true);
    assert.equal(body.books.coinbase_book.mid, 76003);
    assert.equal(body.derived.coinbase_mid, 76003);
    assert.equal(body.derived.venue_mids.binance_spot_book, 76005);
    assert.equal(body.derived.avg_funding, 0.0002);
    assert.equal(body.derived.total_oi_usd, 760008);
    const kalshi = body.contracts.kalshi_kxbtc;
    const contracts = kalshi.markets;
    const contract = contracts.find(row => row.ticker.endsWith("B76550"));
    assert.equal(contract.ticker, "KXBTC-26SEP1512-B76550");
    assert.equal(contract.strike, 76550);
    assert.equal(contract.strike_source, "ticker");
    assert.equal(contract.low, 76500);
    assert.equal(contract.high, 76599.99);
    assert.equal(kalshi.ladder_ticker, "KXBTC-26SEP1512");
    assert.equal(kalshi.cache, "miss");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("snapshot degrades cleanly when an upstream fails", async () => {
  resetKalshiCache();
  mockUpstreams();
  try {
    globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
    const { response, body } = await call("/snapshot?symbol=BTCUSDT");
    assert.equal(response.status, 200);
    assert.equal(body.books.binance_spot_book.ok, false);
    assert.equal(body.contracts.kalshi_kxbtc.ok, false);
    assert.equal(body.derived.coinbase_mid, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kalshi failures serve the last good snapshot from cache", async () => {
  resetKalshiCache();
  mockUpstreams();
  const originalNow = Date.now;
  try {
    await call("/snapshot?symbol=BTCUSDT");
    Date.now = () => originalNow() + 61_000;
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    const { response, body } = await call("/snapshot?symbol=BTCUSDT");
    Date.now = originalNow;
    assert.equal(response.status, 200);
    assert.equal(body.contracts.kalshi_kxbtc.ok, true);
    assert.equal(body.contracts.kalshi_kxbtc.cache, "stale");
    assert.equal(body.contracts.kalshi_kxbtc.markets.length, 2);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    resetKalshiCache();
  }
});
