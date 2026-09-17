"""
Coinbase L2 order-book feature collector.

Maintains a live BTC-USD order book from Coinbase's level2_batch channel
(snapshot + incremental diffs) plus the matches channel for real taker
executions, and computes:

  - L ratio: distance-weighted two-sided liquidity imbalance
  - dwell time: dead-quote lifetime per distance bucket (from level2
    remove events, i.e. size -> 0 at a price)
  - V ratio: taker flow rate vs resting depth (a Peclet-number-style
    velocity vs capacity ratio)

Exposes all three over a small local HTTP endpoint. Pyth Lazer
(pyth_lazer_collector.py) remains the source for spot price/funding;
this collector is specifically for order-book *depth*, which Pyth Lazer
does not provide (no size field on its bestBid/bestAsk).

Run: python coinbase_l2_features.py
"""

import asyncio
import json
import math
import sqlite3
import time
from pathlib import Path

import websockets
from aiohttp import web

HERE = Path(__file__).resolve().parent
DB_PATH = HERE / "coinbase_l2.db"
PRODUCT_ID = "BTC-USD"
WS_URI = "wss://ws-feed.exchange.coinbase.com"
MAX_WS_MESSAGE_BYTES = 10_000_000  # full snapshot can exceed the 1MB default
RETENTION_HOURS = 24
RECONNECT_BACKOFF_S = 2
MAX_RECONNECT_BACKOFF_S = 30

LAMBDA_D_BPS = 10.0  # depth decay constant; not yet estimated from data (see module docstring)
DWELL_MIN_MS = 50  # exclude sub-50ms dwell (cancel races / noise, per estimation discipline)
DWELL_BUCKET_BPS = 5
DWELL_BUCKET_CAP_BPS = 50
V_RATIO_WINDOW_S = 60


def init_db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=30.0)
    con.execute("PRAGMA journal_mode=WAL;")
    con.execute("PRAGMA synchronous=NORMAL;")
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS dwell_events (
            death_ts_ms INTEGER, side TEXT, price REAL, dwell_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_dwell_ts ON dwell_events(death_ts_ms);

        CREATE TABLE IF NOT EXISTS matches (
            ts_ms INTEGER, side TEXT, price REAL, size REAL
        );
        CREATE INDEX IF NOT EXISTS idx_matches_ts ON matches(ts_ms);
        """
    )
    return con


class OrderBook:
    """Full price->size book for one side, with birth timestamps for dwell tracking."""

    def __init__(self):
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.birth_ms: dict[tuple[str, float], int] = {}

    def load_snapshot(self, bids: list, asks: list, now_ms: int):
        self.bids = {float(p): float(s) for p, s in bids if float(s) > 0}
        self.asks = {float(p): float(s) for p, s in asks if float(s) > 0}
        for side, book in (("bid", self.bids), ("ask", self.asks)):
            for price in book:
                self.birth_ms[(side, price)] = now_ms

    def apply_change(self, side_raw: str, price: float, size: float, now_ms: int, dwell_sink: list):
        side = "bid" if side_raw == "buy" else "ask"
        book = self.bids if side == "bid" else self.asks
        key = (side, price)
        if size <= 0:
            if price in book:
                del book[price]
                birth = self.birth_ms.pop(key, None)
                if birth is not None:
                    dwell_ms = now_ms - birth
                    if dwell_ms >= DWELL_MIN_MS:
                        dwell_sink.append((now_ms, side, price, dwell_ms))
            return
        if price not in book:
            self.birth_ms[key] = now_ms
        book[price] = size

    def best_bid_ask(self):
        if not self.bids or not self.asks:
            return None, None
        return max(self.bids), min(self.asks)

    def l_ratio(self, lambda_d_bps: float = LAMBDA_D_BPS) -> dict:
        best_bid, best_ask = self.best_bid_ask()
        if best_bid is None or best_ask is None:
            return {"l_ratio": None, "reason": "book not ready"}
        mid = (best_bid + best_ask) / 2
        bid_weighted = sum(
            size * math.exp(-abs(mid - price) / mid * 10_000 / lambda_d_bps)
            for price, size in self.bids.items()
        )
        ask_weighted = sum(
            size * math.exp(-abs(price - mid) / mid * 10_000 / lambda_d_bps)
            for price, size in self.asks.items()
        )
        total = bid_weighted + ask_weighted
        if total <= 0:
            return {"l_ratio": None, "reason": "zero weighted depth"}
        return {
            "l_ratio": (bid_weighted - ask_weighted) / total,
            "mid": mid,
            "bid_weighted_depth": bid_weighted,
            "ask_weighted_depth": ask_weighted,
            "lambda_d_bps": lambda_d_bps,
        }

    def resting_depth_within(self, lambda_d_bps: float = LAMBDA_D_BPS) -> float:
        """Total size within one lambda_d of mid, both sides — Q_rest for the V ratio."""
        best_bid, best_ask = self.best_bid_ask()
        if best_bid is None or best_ask is None:
            return 0.0
        mid = (best_bid + best_ask) / 2
        band = mid * (lambda_d_bps / 10_000)
        total = sum(s for p, s in self.bids.items() if mid - p <= band)
        total += sum(s for p, s in self.asks.items() if p - mid <= band)
        return total

    def resting_depth_by_dwell_bucket(self, lambda_d_bps: float = LAMBDA_D_BPS) -> dict[int, float]:
        """Distance-decay-weighted resting depth aggregated into dwell distance buckets."""
        best_bid, best_ask = self.best_bid_ask()
        if best_bid is None or best_ask is None:
            return {}
        mid = (best_bid + best_ask) / 2
        bucket_weights: dict[int, float] = {}
        for book in (self.bids, self.asks):
            for price, size in book.items():
                delta_bps = abs(price - mid) / mid * 10_000
                key = min(int(delta_bps // DWELL_BUCKET_BPS) * DWELL_BUCKET_BPS, DWELL_BUCKET_CAP_BPS)
                w = size * math.exp(-delta_bps / lambda_d_bps)
                bucket_weights[key] = bucket_weights.get(key, 0.0) + w
        return bucket_weights


class Collector:
    def __init__(self):
        self.con = init_db()
        self.book = OrderBook()
        self.ready = False
        self.dwell_buffer: list[tuple[int, str, float, int]] = []  # (ts_ms, side, price, dwell_ms)
        self.recent_matches: list[tuple[int, str, float]] = []  # (ts_ms, side, size) — trimmed to V_RATIO_WINDOW_S

    async def stream(self):
        backoff = RECONNECT_BACKOFF_S
        while True:
            try:
                async with websockets.connect(
                    WS_URI, ping_interval=20, max_size=MAX_WS_MESSAGE_BYTES
                ) as ws:
                    await ws.send(json.dumps({
                        "type": "subscribe",
                        "product_ids": [PRODUCT_ID],
                        "channels": ["level2_batch", "matches"],
                    }))
                    self.ready = False
                    backoff = RECONNECT_BACKOFF_S
                    async for raw in ws:
                        self._handle_message(json.loads(raw))
            except Exception as e:
                self.ready = False
                print(f"[coinbase-l2] connection failed: {type(e).__name__}: {e} "
                      f"(retrying in {backoff}s)")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, MAX_RECONNECT_BACKOFF_S)

    def _handle_message(self, data: dict):
        now_ms = int(time.time() * 1000)
        msg_type = data.get("type")
        if msg_type == "snapshot":
            self.book.load_snapshot(data.get("bids", []), data.get("asks", []), now_ms)
            self.ready = True
        elif msg_type == "l2update":
            for side_raw, price_s, size_s in data.get("changes", []):
                self.book.apply_change(side_raw, float(price_s), float(size_s), now_ms, self.dwell_buffer)
            if len(self.dwell_buffer) >= 200:
                self._flush_dwell()
        elif msg_type == "match" or msg_type == "last_match":
            price = float(data.get("price", 0) or 0)
            size = float(data.get("size", 0) or 0)
            side = data.get("side")  # "buy" or "sell" taker side
            if price > 0 and size > 0 and side:
                self.recent_matches.append((now_ms, side, size))
                self.con.execute(
                    "INSERT INTO matches VALUES (?,?,?,?)", (now_ms, side, price, size)
                )
                self.con.commit()
        cutoff = now_ms - V_RATIO_WINDOW_S * 1000
        while self.recent_matches and self.recent_matches[0][0] < cutoff:
            self.recent_matches.pop(0)

    def _flush_dwell(self):
        if self.dwell_buffer:
            self.con.executemany("INSERT INTO dwell_events VALUES (?,?,?,?)", self.dwell_buffer)
            self.con.commit()
            self.dwell_buffer.clear()

    async def retention_loop(self):
        while True:
            self._flush_dwell()
            cutoff_ms = int((time.time() - RETENTION_HOURS * 3600) * 1000)
            self.con.execute("DELETE FROM dwell_events WHERE death_ts_ms < ?", (cutoff_ms,))
            self.con.execute("DELETE FROM matches WHERE ts_ms < ?", (cutoff_ms,))
            self.con.commit()
            await asyncio.sleep(600)

    def dwell_buckets(self, lookback_s: int = 3600) -> dict[int, dict]:
        now = time.time()
        if hasattr(self, "_cached_dwell_stats") and (now - getattr(self, "_cached_dwell_ts", 0)) < 15:
            return self._cached_dwell_stats
        self._flush_dwell()
        cutoff_ms = int((now - lookback_s) * 1000)
        rows = self.con.execute(
            "SELECT price, dwell_ms FROM dwell_events WHERE death_ts_ms >= ?", (cutoff_ms,)
        ).fetchall()
        best_bid, best_ask = self.book.best_bid_ask()
        if best_bid is None or best_ask is None:
            return {}
        mid = (best_bid + best_ask) / 2
        buckets: dict[int, list[int]] = {}
        for price, dwell_ms in rows:
            delta_bps = abs(price - mid) / mid * 10_000
            key = min(int(delta_bps // DWELL_BUCKET_BPS) * DWELL_BUCKET_BPS, DWELL_BUCKET_CAP_BPS)
            buckets.setdefault(key, []).append(dwell_ms)
        stats = {
            k: {"n": len(v), "mean_ms": sum(v) / len(v)}
            for k, v in sorted(buckets.items())
        }
        self._cached_dwell_stats = stats
        self._cached_dwell_ts = now
        return stats

    def estimate_tau_res(self, lambda_d_bps: float = LAMBDA_D_BPS) -> tuple[float, str]:
        stats = self.dwell_buckets()
        if not stats:
            return 1.0, "fallback_no_dwell_data"
        bucket_weights = self.book.resting_depth_by_dwell_bucket(lambda_d_bps)
        if not bucket_weights:
            return 1.0, "fallback_no_book_depth"

        weighted_tau_ms = 0.0
        total_weight = 0.0
        for k, b_stats in stats.items():
            w = bucket_weights.get(k, 0.0)
            if w > 0 and b_stats.get("n", 0) > 0:
                weighted_tau_ms += w * b_stats["mean_ms"]
                total_weight += w

        if total_weight <= 0:
            return 1.0, "fallback_zero_matched_weight"

        tau_res_s = (weighted_tau_ms / total_weight) / 1000.0
        return tau_res_s, "fitted_dwell_volume_weighted"

    def v_ratio(self) -> dict:
        if not self.recent_matches:
            return {"v_ratio": None, "reason": "no recent matches"}
        window_s = V_RATIO_WINDOW_S
        taker_volume = sum(size for _, _, size in self.recent_matches)
        flow_per_min = taker_volume / window_s * 60
        resting = self.book.resting_depth_within()
        if resting <= 0:
            return {"v_ratio": None, "reason": "zero resting depth"}
        tau_res_s, tau_res_source = self.estimate_tau_res()
        v = (flow_per_min / 60) * tau_res_s / resting
        return {
            "v_ratio": v,
            "flow_per_min": flow_per_min,
            "resting_depth": resting,
            "tau_res_s": tau_res_s,
            "tau_res_source": tau_res_source,
            "window_s": window_s,
            "lambda_d_bps": LAMBDA_D_BPS,
        }

    # --- HTTP endpoints ---
    async def http_l_ratio(self, request):
        return web.json_response(self.book.l_ratio())

    async def http_v_ratio(self, request):
        return web.json_response(self.v_ratio())

    async def http_dwell(self, request):
        stats = self.dwell_buckets()
        best_bid, best_ask = self.book.best_bid_ask()
        if (best_bid is None or best_ask is None) and not stats:
            return web.json_response({"error": "book not ready"})
        out = {str(k): v for k, v in sorted(stats.items())}
        return web.json_response(out)

    async def http_health(self, request):
        best_bid, best_ask = self.book.best_bid_ask()
        return web.json_response({
            "status": "ok" if self.ready else "book_not_ready",
            "best_bid": best_bid,
            "best_ask": best_ask,
            "bid_levels": len(self.book.bids),
            "ask_levels": len(self.book.asks),
            "recent_matches": len(self.recent_matches),
        })


async def main():
    c = Collector()
    app = web.Application()
    app.router.add_get("/l_ratio", c.http_l_ratio)
    app.router.add_get("/v_ratio", c.http_v_ratio)
    app.router.add_get("/dwell", c.http_dwell)
    app.router.add_get("/health", c.http_health)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 8793).start()
    print("[coinbase-l2] HTTP server listening on http://127.0.0.1:8793")
    await asyncio.gather(c.stream(), c.retention_loop())


if __name__ == "__main__":
    asyncio.run(main())
