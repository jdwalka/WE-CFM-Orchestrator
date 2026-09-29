"""
Pyth Lazer collector daemon.

Streams top-of-book price/bid/ask/funding-rate data from Pyth Lazer
(wss://pyth-lazer-*.dourolabs.app/v1/stream) for the coins this project
already tracks, persists it to SQLite with rolling retention, and serves
the latest snapshot over a small local HTTP endpoint so prediction_engine.py
can read it instead of the geo-blocked Binance fapi calls in
get_positioning_skew().

This is NOT full L2 order-book depth — Pyth Lazer exposes top-of-book
(bestBidPrice/bestAskPrice) and funding rate only, not a multi-level book
or diff stream. It fixes the dead funding_rate/open_interest feed; it does
not provide the L-ratio / dwell-time / wall-detection features that would
need real exchange-side L2 depth (Binance/OKX are geo-blocked from this
machine; Coinbase was not evaluated for this pass).

Run: python pyth_lazer_collector.py
"""

import asyncio
import json
import os
import sqlite3
import time
from pathlib import Path

import websockets
from aiohttp import web

HERE = Path(__file__).resolve().parent
DB_PATH = HERE / "pyth_lazer.db"
RETENTION_HOURS = 24
RECONNECT_BACKOFF_S = 2
MAX_RECONNECT_BACKOFF_S = 30

LAZER_ENDPOINTS = [
    "wss://pyth-lazer-0.dourolabs.app/v1/stream",
    "wss://pyth-lazer-1.dourolabs.app/v1/stream",
    "wss://pyth-lazer-2.dourolabs.app/v1/stream",
]

# Matches src/feeds/pyth-lazer-websocket.js's PRICE_FEED_IDS exactly, so
# any future cross-checking against the JS side lines up.
PRICE_FEED_IDS = {
    "BTC": 1,
    "ETH": 2,
    "SOL": 6,
    "XRP": 14,
    "BNB": 15,
}
# DOGE (feed 10) is deliberately excluded: this token's grant doesn't
# entitle it ("Not entitled: feed 10 ... asset type 'crypto', instrument
# type 'spot'"), and Pyth Lazer rejects the WHOLE subscription — every feed,
# not just the bad one — if any requested feed isn't entitled.
FEED_ID_TO_SYMBOL = {v: k for k, v in PRICE_FEED_IDS.items()}
SUBSCRIPTION_PROPERTIES = [
    "price", "bestBidPrice", "bestAskPrice", "confidence", "exponent",
    "fundingRate", "fundingRateInterval", "fundingTimestamp",
    "feedUpdateTimestamp", "publisherCount",
]


def read_lazer_token() -> str:
    """Mirrors readPythSecretFromFile() in pyth-lazer-websocket.js so this
    collector uses the exact same rotated token the rest of the app does."""
    env_token = os.environ.get("PYTH_NEW_API", "")
    if env_token:
        return env_token
    for secret_dir in (HERE / "secrets", HERE.parent / "secrets"):
        for name in ("PYTH_NEW_API", "PYTH_NEW_API.txt"):
            p = secret_dir / name
            if not p.exists():
                continue
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    return line.split("=", 1)[1].strip().strip("\"'")
                if " " not in line:
                    return line.strip("\"'")
    return ""


def init_db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS lazer_ticks (
            ts_ms INTEGER,
            symbol TEXT,
            price REAL,
            best_bid REAL,
            best_ask REAL,
            confidence REAL,
            funding_rate REAL,
            funding_rate_interval INTEGER,
            publisher_count INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_lazer_ticks_ts ON lazer_ticks(ts_ms);
        CREATE INDEX IF NOT EXISTS idx_lazer_ticks_symbol_ts ON lazer_ticks(symbol, ts_ms);
        """
    )
    return con


def decode_feed(feed: dict) -> dict | None:
    symbol = FEED_ID_TO_SYMBOL.get(feed.get("priceFeedId"))
    if symbol is None:
        return None
    exponent = feed.get("exponent")
    if exponent is None:
        return None
    scale = 10 ** exponent

    def scaled(key):
        raw = feed.get(key)
        return float(raw) * scale if raw is not None else None

    return {
        "symbol": symbol,
        "price": scaled("price"),
        "best_bid": scaled("bestBidPrice"),
        "best_ask": scaled("bestAskPrice"),
        "confidence": scaled("confidence"),
        # fundingRate/fundingRateInterval are not exponent-scaled fields.
        "funding_rate": (
            float(feed["fundingRate"]) if feed.get("fundingRate") is not None else None
        ),
        "funding_rate_interval": feed.get("fundingRateInterval"),
        "publisher_count": feed.get("publisherCount"),
    }


class Collector:
    def __init__(self, token: str):
        self.token = token
        self.con = init_db()
        self.latest: dict[str, dict] = {}
        self._buffer: list[tuple] = []
        self._last_commit = time.time()

    async def stream(self):
        backoff = RECONNECT_BACKOFF_S
        endpoint_idx = 0
        while True:
            uri = LAZER_ENDPOINTS[endpoint_idx % len(LAZER_ENDPOINTS)]
            endpoint_idx += 1
            try:
                async with websockets.connect(
                    uri, subprotocols=["pyth-lazer-auth", self.token], ping_interval=20
                ) as ws:
                    await ws.send(json.dumps({
                        "type": "subscribe",
                        "subscriptionId": 1,
                        "priceFeedIds": list(PRICE_FEED_IDS.values()),
                        "properties": SUBSCRIPTION_PROPERTIES,
                        "formats": ["solana"],
                        "channel": "real_time",
                        "deliveryFormat": "json",
                        "jsonBinaryEncoding": "hex",
                        "parsed": True,
                    }))
                    backoff = RECONNECT_BACKOFF_S
                    async for raw in ws:
                        self._handle_message(json.loads(raw))
            except Exception as e:
                print(f"[pyth-lazer] connection to {uri} failed: {type(e).__name__}: {e} "
                      f"(retrying in {backoff}s)")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, MAX_RECONNECT_BACKOFF_S)

    def _handle_message(self, data: dict):
        if data.get("type") != "streamUpdated":
            return
        parsed = data.get("parsed") or {}
        ts_ms = int(time.time() * 1000)
        rows = []
        for feed in parsed.get("priceFeeds", []):
            decoded = decode_feed(feed)
            if decoded is None:
                continue
            self.latest[decoded["symbol"]] = {"ts_ms": ts_ms, **decoded}
            rows.append((
                ts_ms, decoded["symbol"], decoded["price"], decoded["best_bid"],
                decoded["best_ask"], decoded["confidence"], decoded["funding_rate"],
                decoded["funding_rate_interval"], decoded["publisher_count"],
            ))
        if rows:
            self._buffer.extend(rows)
            now = time.time()
            if now - self._last_commit >= 2.0 or len(self._buffer) >= 200:
                try:
                    self.con.executemany(
                        "INSERT INTO lazer_ticks VALUES (?,?,?,?,?,?,?,?,?)", self._buffer
                    )
                    self.con.commit()
                except Exception as e:
                    print(f"[pyth-lazer] DB commit error: {e}")
                finally:
                    self._buffer.clear()
                    self._last_commit = now

    async def retention_loop(self):
        while True:
            cutoff_ms = int((time.time() - RETENTION_HOURS * 3600) * 1000)
            self.con.execute("DELETE FROM lazer_ticks WHERE ts_ms < ?", (cutoff_ms,))
            self.con.commit()
            await asyncio.sleep(600)

    # --- HTTP endpoints for prediction_engine.py ---
    async def http_snapshot(self, request):
        symbol = request.query.get("symbol", "BTC").upper()
        return web.json_response(self.latest.get(symbol, {}))

    async def http_snapshot_all(self, request):
        return web.json_response(self.latest)

    async def http_health(self, request):
        stale = {}
        now_ms = int(time.time() * 1000)
        for sym, tick in self.latest.items():
            age_s = (now_ms - tick["ts_ms"]) / 1000
            stale[sym] = {"age_seconds": round(age_s, 1), "fresh": age_s < 15}
        return web.json_response({
            "status": "ok" if self.latest else "no_data_yet",
            "symbols": stale,
        })


async def main():
    token = read_lazer_token()
    if not token:
        raise SystemExit(
            "No Pyth Lazer token found (checked PYTH_NEW_API env var and "
            "secrets/PYTH_NEW_API[.txt] next to this script and its parent)."
        )
    c = Collector(token)
    app = web.Application()
    app.router.add_get("/snapshot", c.http_snapshot)
    app.router.add_get("/snapshot/all", c.http_snapshot_all)
    app.router.add_get("/health", c.http_health)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 8792).start()
    print("[pyth-lazer] HTTP server listening on http://127.0.0.1:8792")
    await asyncio.gather(c.stream(), c.retention_loop())


if __name__ == "__main__":
    asyncio.run(main())
