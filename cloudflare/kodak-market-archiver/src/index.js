/**
 * kodak-market-archiver — persistent market-history signals for Kodak.
 *
 * Stores one-minute market snapshots in KV and derives signals that need
 * history rather than a single live frame:
 *   - Coinbase/Binance gap and convergence velocity
 *   - liquidation burst pressure
 *   - wall pull detection
 *   - final-five-minute settlement archive
 *
 * Bindings:
 *   KODAK_KV               KV namespace (required)
 *   MARKET_SNAPSHOT_URL    optional upstream snapshot URL for cron pulls
 *   MARKET_SNAPSHOT_TOKEN  optional bearer token for cron pulls
 *   COLLECT_TOKEN          optional bearer token required by POST /collect
 */

const MINUTE_MS = 60_000;
const CONVERGENCE_WINDOW_MINUTES = 5;
const GAP_ELEVATED_PCT = 0.0008;
const WALL_PULL_RATIO = 0.5;
const MIN_WALL_SIZE = 20_000;
const LIQUIDATION_BURST_USD = 500_000;
const RECENT_LIQUIDATION_MS = 15 * MINUTE_MS;
const LIQUIDATION_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const CONVERGENCE_RETENTION_SECONDS = 24 * 60 * 60;
const WALL_RETENTION_SECONDS = 24 * 60 * 60;
const SETTLEMENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const SETTLEMENT_ARCHIVE_HOURS = 168;
const MAX_BODY_BYTES = 1_000_000;
const UPSTREAM_TIMEOUT_MS = 9_000;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function minuteBucket(now = Date.now()) {
  return Math.floor(now / MINUTE_MS);
}

function hourBucket(minute = minuteBucket()) {
  return Math.floor(minute / 60);
}

async function readJsonArray(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function writeJsonArray(kv, key, value, expirationTtl) {
  await kv.put(key, JSON.stringify(value), { expirationTtl });
}

function normalizeVenueMid(snapshot) {
  const venueMids = snapshot?.venue_mids;
  if (!venueMids || typeof venueMids !== "object") {
    return { coinbase: null, binance: null };
  }
  return {
    coinbase: finiteNumber(venueMids.coinbase_book ?? venueMids.coinbase),
    binance: finiteNumber(venueMids.binance_spot_book ?? venueMids.binance),
  };
}

function normalizeLiquidationEvent(event, now) {
  if (!event || typeof event !== "object") return null;
  const side = event.side === "long" || event.side === "short" ? event.side : null;
  const notionalUsd = finiteNumber(event.notional_usd ?? event.notionalUsd);
  if (!side || notionalUsd == null || notionalUsd < 0) return null;
  const eventTime = finiteNumber(event.t ?? event.ts);
  return {
    side,
    notional_usd: notionalUsd,
    t: eventTime != null ? eventTime : now,
  };
}

function normalizeWalls(walls) {
  if (!walls || typeof walls !== "object") return {};
  const normalized = {};
  for (const [level, size] of Object.entries(walls)) {
    const price = finiteNumber(level);
    const wallSize = finiteNumber(size);
    if (price == null || wallSize == null || wallSize < 0) continue;
    normalized[price] = wallSize;
  }
  return normalized;
}

function normalizeOhlc(candle) {
  if (!Array.isArray(candle) || candle.length < 5) return null;
  const values = candle.map(finiteNumber);
  if (values.some(value => value == null)) return null;
  return values;
}

async function recordConvergence(kv, coinbase, binance, minute, now) {
  const gap = binance - coinbase;
  await kv.put(`conv:${minute}`, JSON.stringify({
    minute,
    t: now,
    coinbase,
    binance,
    gap,
    gap_pct: gap / coinbase,
  }), { expirationTtl: CONVERGENCE_RETENTION_SECONDS });
}

async function recordLiquidations(kv, snapshot, minute, now) {
  if (!Array.isArray(snapshot?.liquidations)) return;
  const events = snapshot.liquidations
    .map(event => normalizeLiquidationEvent(event, now))
    .filter(Boolean);
  if (!events.length) return;
  const key = `liq:${hourBucket(minute)}`;
  const existing = await readJsonArray(kv, key);
  await writeJsonArray(kv, key, [...existing, ...events].slice(-500), LIQUIDATION_RETENTION_SECONDS);
}

async function recordWalls(kv, snapshot, minute, now) {
  const bid = normalizeWalls(snapshot?.bid_walls);
  const ask = normalizeWalls(snapshot?.ask_walls);
  if (!Object.keys(bid).length && !Object.keys(ask).length) return;
  await kv.put(`walls:${minute}`, JSON.stringify({ t: now, bid, ask }), {
    expirationTtl: WALL_RETENTION_SECONDS,
  });
}

async function recordSettlement(kv, snapshot, coinbase, binance, minute, now) {
  const minuteOfHour = new Date(now).getUTCMinutes();
  if (minuteOfHour < 55) return;
  if (coinbase == null && binance == null) return;
  const key = `settle:${hourBucket(minute)}`;
  const existing = await readJsonArray(kv, key);
  const row = {
    t: now,
    coinbase,
    binance,
    ohlc: normalizeOhlc(snapshot?.coinbase_1m),
  };
  await writeJsonArray(kv, key, [...existing, row].slice(-20), SETTLEMENT_RETENTION_SECONDS);
}

async function recordSnapshot(kv, snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("invalid_snapshot");
  }
  const now = Date.now();
  const minute = minuteBucket(now);
  const { coinbase, binance } = normalizeVenueMid(snapshot);
  if (coinbase != null && coinbase > 0 && binance != null && binance > 0) {
    await recordConvergence(kv, coinbase, binance, minute, now);
  }
  await recordLiquidations(kv, snapshot, minute, now);
  await recordWalls(kv, snapshot, minute, now);
  await recordSettlement(kv, snapshot, coinbase, binance, minute, now);
}

async function fetchScheduledSnapshot(env) {
  const url = String(env.MARKET_SNAPSHOT_URL || "").trim();
  if (!url) return null;
  const headers = { Accept: "application/json" };
  const token = String(env.MARKET_SNAPSHOT_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
  return response.json();
}

async function getConvergence(kv) {
  const minute = minuteBucket();
  const keys = Array.from({ length: CONVERGENCE_WINDOW_MINUTES }, (_, offset) => `conv:${minute - offset}`);
  const rows = (await Promise.all(keys.map(key => kv.get(key))))
    .map(raw => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.minute - b.minute);
  if (rows.length < 2) {
    return { status: "insufficient_data", samples: rows.length };
  }
  const latest = rows.at(-1);
  const oldest = rows.at(0);
  const deltaMinutes = Math.max(0, latest.minute - oldest.minute);
  const gapVelocity = deltaMinutes ? (latest.gap - oldest.gap) / deltaMinutes : 0;
  const elevated = Math.abs(latest.gap_pct) > GAP_ELEVATED_PCT;
  let signal = "none";
  if (elevated) {
    if (Math.abs(latest.gap) < Math.abs(oldest.gap)) {
      signal = latest.gap > 0 ? "converging_up" : "converging_down";
    } else if (Math.abs(latest.gap) > Math.abs(oldest.gap)) {
      signal = "diverging";
    } else {
      signal = "elevated_static";
    }
  }
  return {
    status: "ok",
    current_gap: latest.gap,
    current_gap_pct: latest.gap_pct,
    gap_velocity_per_min: gapVelocity,
    elevated,
    signal,
    samples: rows.length,
  };
}

async function getRecentLiquidations(kv) {
  const hour = hourBucket();
  const keys = [`liq:${hour}`, `liq:${hour - 1}`];
  const rows = (await Promise.all(keys.map(key => readJsonArray(kv, key)))).flat();
  const cutoff = Date.now() - RECENT_LIQUIDATION_MS;
  const recent = rows.filter(event => Number(event?.t) >= cutoff);
  const notionalUsd = recent.reduce((sum, event) => sum + (finiteNumber(event?.notional_usd) || 0), 0);
  const longUsd = recent
    .filter(event => event?.side === "long")
    .reduce((sum, event) => sum + (finiteNumber(event?.notional_usd) || 0), 0);
  return {
    status: "ok",
    events_15m: recent.length,
    notional_usd_15m: notionalUsd,
    long_share: notionalUsd > 0 ? longUsd / notionalUsd : null,
    burst: notionalUsd > LIQUIDATION_BURST_USD,
  };
}

function detectWallPulls(current, previous) {
  const pulls = [];
  for (const side of ["bid", "ask"]) {
    const currentWalls = current?.[side] || {};
    const previousWalls = previous?.[side] || {};
    for (const [level, size] of Object.entries(currentWalls)) {
      const previousSize = finiteNumber(previousWalls[level]);
      if (previousSize == null || previousSize <= MIN_WALL_SIZE) continue;
      if (size >= previousSize * WALL_PULL_RATIO) continue;
      pulls.push({ side, level: Number(level), from: previousSize, to: size });
    }
  }
  return pulls;
}

async function getWallState(kv) {
  const minute = minuteBucket();
  const rows = await Promise.all([kv.get(`walls:${minute}`), kv.get(`walls:${minute - 2}`)]);
  if (!rows[0] || !rows[1]) return { status: "insufficient_data" };
  let current;
  let previous;
  try {
    current = JSON.parse(rows[0]);
    previous = JSON.parse(rows[1]);
  } catch {
    return { status: "insufficient_data" };
  }
  return { status: "ok", wall_pulls: detectWallPulls(current, previous) };
}

async function getSettlementArchive(kv) {
  const hour = hourBucket();
  const keys = Array.from({ length: SETTLEMENT_ARCHIVE_HOURS }, (_, offset) => `settle:${hour - offset - 1}`);
  const hours = await Promise.all(keys.map(async (key, index) => {
    const raw = await kv.get(key);
    if (!raw) return null;
    try {
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) return null;
      return rows.map(row => ({ hour: hour - index - 1, ...row }));
    } catch {
      return null;
    }
  }));
  const rows = hours.filter(Boolean).flat();
  return { status: "ok", hours: rows.length, data: rows };
}

function authorizedCollect(request, env) {
  const expected = String(env.COLLECT_TOKEN || "").trim();
  if (!expected) return true;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

async function readSnapshotBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new Error("payload_too_large");
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new Error("payload_too_large");
  const snapshot = JSON.parse(body);
  if (!snapshot || typeof snapshot !== "object") throw new Error("invalid_snapshot");
  return snapshot;
}

export default {
  async scheduled(event, env) {
    if (!env.KODAK_KV) throw new Error("KODAK_KV binding missing");
    const snapshot = await fetchScheduledSnapshot(env);
    if (!snapshot) return;
    await recordSnapshot(env.KODAK_KV, snapshot);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "authorization,content-type",
        },
      });
    }
    if (!env.KODAK_KV) {
      return jsonResponse({ status: "error", error: "KODAK_KV binding missing" }, 500);
    }

    try {
      if (request.method === "POST" && url.pathname === "/collect") {
        if (!authorizedCollect(request, env)) {
          return jsonResponse({ status: "error", error: "unauthorized" }, 401);
        }
        const snapshot = await readSnapshotBody(request);
        await recordSnapshot(env.KODAK_KV, snapshot);
        return jsonResponse({ status: "ok", recorded: true });
      }
      if (request.method !== "GET") {
        return jsonResponse({ status: "error", error: "method_not_allowed" }, 405);
      }
      if (url.pathname === "/" || url.pathname === "/health") {
        return jsonResponse({
          status: "ok",
          worker: "kodak-market-archiver",
          version: "1.0.0",
          endpoints: ["/health", "/collect", "/convergence", "/liqs", "/walls", "/settlement"],
          ts: new Date().toISOString(),
        });
      }
      if (url.pathname === "/convergence") return jsonResponse(await getConvergence(env.KODAK_KV));
      if (url.pathname === "/liqs") return jsonResponse(await getRecentLiquidations(env.KODAK_KV));
      if (url.pathname === "/walls") return jsonResponse(await getWallState(env.KODAK_KV));
      if (url.pathname === "/settlement") return jsonResponse(await getSettlementArchive(env.KODAK_KV));
      return jsonResponse({ status: "error", error: "not_found" }, 404);
    } catch (error) {
      return jsonResponse({ status: "error", error: String(error?.message || error) }, 400);
    }
  },
};
