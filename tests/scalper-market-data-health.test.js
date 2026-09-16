import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../cloudflare/scalper-market-data/src/index.js";

const originalFetch = globalThis.fetch;

function createD1({ storageError, timestamp }) {
  return {
    prepare(sql) {
      if (storageError) throw new Error(storageError);
      if (sql.startsWith("SELECT 1")) {
        return { first: async () => ({ reachable: 1 }) };
      }
      return { first: async () => ({ last_write_timestamp: timestamp }) };
    },
  };
}

function mockUpstreams({ spotTime = new Date().toISOString(), kalshiOk = true, polymarketOk = true } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    globalThis.lastFetchInit = init;
    const value = String(url);
    if (value.includes("/ticker")) {
      return new Response(JSON.stringify({ price: "50000", time: spotTime }));
    }
    if (value.includes("api.elections.kalshi.com")) {
      if (!kalshiOk) return new Response("upstream unavailable", { status: 503 });
      return new Response(
        JSON.stringify({
          markets: [
            {
              ticker: "KXBTC-25SEP14-A",
              title: "Test market",
              yes_sub_title: "$50,000",
              yes_bid_dollars: "0.40",
              yes_ask_dollars: "0.42",
              close_time: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        })
      );
    }
    if (value.includes("gamma-api.polymarket.com")) {
      if (!polymarketOk) return new Response("upstream unavailable", { status: 503 });
      return new Response(
        JSON.stringify([
          {
            markets: [
              {
                question: "Test Up/Down",
                clobTokenIds: "[]",
                description: "twap-3600s-streams",
              },
            ],
          },
        ])
      );
    }
    throw new Error(`Unexpected upstream request: ${value}`);
  };
}

async function callHealth(env) {
  const response = await worker.fetch(new Request("https://worker.test/health"), env);
  assert.equal(response.status, 200);
  return response.json();
}

test("health reports healthy storage, ladder feeds, and fresh spot data", async () => {
  const timestamp = "2026-09-14T11:00:00.000Z";
  mockUpstreams();
  try {
    const health = await callHealth({ CALIBRATION_DB: createD1({ timestamp }) });
    assert.equal(health.status, "ok");
    assert.equal(health.degraded, false);
    assert.equal(health.storage.reachable, true);
    assert.equal(health.storage.last_successful_calibration_write_timestamp, timestamp);
    assert.deepEqual(health.ladder_feeds, [
      { source: "kalshi", status: "ok" },
      { source: "polymarket", status: "ok" },
    ]);
    assert.equal(health.spot.source, "coinbase");
    assert.equal(health.spot.fresh, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker responses and upstream fetches bypass cache", async () => {
  const timestamp = "2026-09-14T11:00:00.000Z";
  mockUpstreams();
  try {
    const response = await worker.fetch(
      new Request("https://worker.test/health"),
      { CALIBRATION_DB: createD1({ timestamp }) }
    );
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(globalThis.lastFetchInit.cache, "no-store");
    assert.equal(globalThis.lastFetchInit.cf, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.lastFetchInit;
  }
});

test("health surfaces degraded calibration without failing", async () => {
  mockUpstreams();
  try {
    const health = await callHealth({ CALIBRATION_DB: createD1({ timestamp: null }) });
    assert.equal(health.status, "degraded");
    assert.equal(health.degraded, true);
    assert.equal(health.storage.reachable, true);
    assert.equal(health.storage.last_successful_calibration_write_timestamp, null);
    assert.equal(health.calibration.available, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health remains available when storage and feeds fail", async () => {
  mockUpstreams({ kalshiOk: false, polymarketOk: false, spotTime: "not-a-date" });
  try {
    const health = await callHealth({
      CALIBRATION_DB: createD1({ storageError: "database unavailable" }),
    });
    assert.equal(health.status, "degraded");
    assert.equal(health.degraded, true);
    assert.equal(health.storage.reachable, false);
    assert.deepEqual(health.ladder_feeds, [
      { source: "kalshi", status: "unavailable" },
      { source: "polymarket", status: "unavailable" },
    ]);
    assert.equal(health.spot.reachable, true);
    assert.equal(health.spot.fresh, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
