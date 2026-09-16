import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../cloudflare/kodak-market-archiver/src/index.js";

function createKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async put(key, value, options) {
      const existing = store.get(key);
      if (existing?.expirationTtl && options?.expirationTtl < existing.expirationTtl) return;
      store.set(key, { value, expirationTtl: options?.expirationTtl ?? null });
    },
  };
}

function unwrapGet(kv, key) {
  const entry = kv.store.get(key);
  return entry?.value ?? null;
}

async function call(path, { method = "GET", env, body, headers } = {}) {
  const init = { method, headers: headers || {} };
  if (body != null) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const response = await worker.fetch(new Request(`https://worker.test${path}`, init), env);
  return { response, body: await response.json() };
}

function snapshot(overrides = {}) {
  return {
    venue_mids: {
      coinbase_book: 76000,
      binance_spot_book: 76040,
    },
    liquidations: [
      { side: "long", notional_usd: 300000 },
      { side: "short", notional_usd: 250000 },
    ],
    bid_walls: { "75990": 50000 },
    ask_walls: { "76010": 40000 },
    ...overrides,
  };
}

test("collect records convergence, liquidations, and walls; rejects unauthorized writes", async () => {
  const kv = createKv();
  const env = { KODAK_KV: kv, COLLECT_TOKEN: "secret" };

  const unauthorized = await call("/collect", {
    method: "POST",
    env,
    body: snapshot(),
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(kv.store.size, 0);

  const authorized = await call("/collect", {
    method: "POST",
    env,
    body: snapshot(),
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(authorized.response.status, 200);
  assert.equal(authorized.body.status, "ok");
  assert.equal(authorized.body.recorded, true);

  const minute = Math.floor(Date.now() / 60000);
  const hour = Math.floor(minute / 60);
  assert.ok(unwrapGet(kv, `conv:${minute}`).includes('"gap":40'));
  assert.equal(JSON.parse(unwrapGet(kv, `liq:${hour}`)).length, 2);
  assert.ok(unwrapGet(kv, `walls:${minute}`).includes("75990"));
});

test("collect records a settlement row only during the final five minutes", async () => {
  const originalDateNow = Date.now;
  const fixedBase = originalDateNow() - (originalDateNow() % 3_600_000);
  try {
    Date.now = () => fixedBase + 56 * 60_000;
    const kv = createKv();
    const env = { KODAK_KV: kv };
    const result = await call("/collect", {
      method: "POST",
      env,
      body: snapshot({ liquidations: [], bid_walls: {}, ask_walls: {} }),
    });
    assert.equal(result.response.status, 200);
    const minute = Math.floor(Date.now() / 60000);
    const hour = Math.floor(minute / 60);
    assert.ok(unwrapGet(kv, `settle:${hour}`).includes('"coinbase":76000'));
  } finally {
    Date.now = originalDateNow;
  }
});

test("convergence returns insufficient data and then a converging signal", async () => {
  const kv = createKv();
  const env = { KODAK_KV: kv };
  const empty = await call("/convergence", { env });
  assert.equal(empty.response.status, 200);
  assert.equal(empty.body.status, "insufficient_data");
  assert.equal(empty.body.samples, 0);

  const now = Date.now();
  const minute = Math.floor(now / 60000);
  await kv.put(`conv:${minute - 1}`, JSON.stringify({
    minute: minute - 1,
    t: now - 60000,
    coinbase: 76000,
    binance: 76140,
    gap: 140,
    gap_pct: 140 / 76000,
  }));
  await kv.put(`conv:${minute}`, JSON.stringify({
    minute,
    t: now,
    coinbase: 76000,
    binance: 76080,
    gap: 80,
    gap_pct: 80 / 76000,
  }));
  const result = await call("/convergence", { env });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.status, "ok");
  assert.equal(result.body.elevated, true);
  assert.equal(result.body.signal, "converging_up");
  assert.equal(result.body.samples, 2);
});

test("liquidation burst sums the current and previous hour and detects a burst", async () => {
  const kv = createKv();
  const env = { KODAK_KV: kv };
  const now = Date.now();
  const currentHour = Math.floor(Math.floor(now / 60000) / 60);
  await kv.put(`liq:${currentHour}`, JSON.stringify([
    { side: "long", notional_usd: 500001, t: now },
  ]));
  const result = await call("/liqs", { env });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.status, "ok");
  assert.equal(result.body.events_15m, 1);
  assert.equal(result.body.notional_usd_15m, 500001);
  assert.equal(result.body.long_share, 1);
  assert.equal(result.body.burst, true);
});

test("wall detector reports a wall only when it shrinks by more than half", async () => {
  const kv = createKv();
  const env = { KODAK_KV: kv };
  const minute = Math.floor(Date.now() / 60000);
  await kv.put(`walls:${minute - 2}`, JSON.stringify({
    t: Date.now() - 120000,
    bid: { "75990": 50000 },
    ask: { "76010": 40000 },
  }));
  await kv.put(`walls:${minute}`, JSON.stringify({
    t: Date.now(),
    bid: { "75990": 10000 },
    ask: { "76010": 35000 },
  }));
  const result = await call("/walls", { env });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.status, "ok");
  assert.deepEqual(result.body.wall_pulls, [{
    side: "bid",
    level: 75990,
    from: 50000,
    to: 10000,
  }]);
});

test("settlement archive returns stored final-minute rows", async () => {
  const kv = createKv();
  const env = { KODAK_KV: kv };
  const hour = Math.floor(Math.floor(Date.now() / 60000) / 60);
  await kv.put(`settle:${hour - 1}`, JSON.stringify([
    { t: Date.now(), coinbase: 76000, binance: 76040, ohlc: null },
  ]));
  const result = await call("/settlement", { env });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.status, "ok");
  assert.equal(result.body.hours, 1);
  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.data[0].coinbase, 76000);
});

test("health reports endpoints and unknown routes return 404", async () => {
  const env = { KODAK_KV: createKv() };
  const health = await call("/health", { env });
  assert.equal(health.response.status, 200);
  assert.equal(health.body.worker, "kodak-market-archiver");
  assert.ok(health.body.endpoints.includes("/convergence"));

  const missing = await call("/not-a-route", { env });
  assert.equal(missing.response.status, 404);
});
