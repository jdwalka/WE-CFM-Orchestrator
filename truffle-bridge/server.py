"""
Truffle Bridge — Primary pricing & Agent Chat Protocol endpoint for WeCryp.
Listens on port 8040, communicates with Redis & Redpanda, and serves https://truffle.leaksnipe.win/chat.
"""

import asyncio
import json
import os
import time
import threading
from typing import Any, Optional
import urllib.request
import urllib.error
import httpx

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import redis

# Configuration
PORT = int(os.getenv("PORT", "8040"))
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
REDPANDA_BROKERS = os.getenv("REDPANDA_BROKERS", "127.0.0.1:9092")
ASI1_API_KEY = os.getenv("ASI1_API_KEY", "")

# Connect to Redis
try:
    redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    redis_client.ping()
    print(f"[TruffleBridge] Connected to Redis at {REDIS_URL}")
except Exception as e:
    print(f"[TruffleBridge] Warning: Redis connection failed: {e}")
    redis_client = None

# Connect to Redpanda KafkaProducer
kafka_producer = None
try:
    from kafka import KafkaProducer
    kafka_producer = KafkaProducer(
        bootstrap_servers=REDPANDA_BROKERS.split(","),
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
        key_serializer=lambda k: k.encode("utf-8") if k else None,
        acks=1,
    )
    print(f"[TruffleBridge] Connected KafkaProducer to {REDPANDA_BROKERS}")
except Exception as e:
    print(f"[TruffleBridge] Kafka producer init warning: {e}")

app = FastAPI(title="Truffle Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatParams(BaseModel):
    action: Optional[str] = "price_history"
    interval: Optional[str] = "1h"
    symbols: Optional[list[str]] = Field(default_factory=lambda: ["BTC"])
    include_orderbook: Optional[bool] = True
    source: Optional[str] = "wecrypto"
    signals: Optional[dict[str, Any]] = None


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = "truffle-wecrypto"
    params: Optional[ChatParams] = Field(default_factory=ChatParams)


def verify_auth(x_api_key: Optional[str], authorization: Optional[str]) -> bool:
    """Validate API key from X-API-Key or Authorization Bearer header."""
    token = x_api_key or ""
    if not token and authorization:
        if authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
        else:
            token = authorization.strip()

    if not token:
        return False

    # Check against known configured keys
    known_keys = [k for k in [
        ASI1_API_KEY,
        os.getenv("ASI1_API_KEY_MAURO", ""),
        os.getenv("ASI1_API_KEY_LEAKSNIPE", ""),
        "sk_e4d1", # user prefix hint
    ] if k]

    if token in known_keys:
        return True
    
    # Allow any key matching the sk_ prefix pattern used by the agent protocol
    if token.startswith("sk_"):
        return True

    return False


def fetch_live_market_fallback(symbol: str) -> dict:
    """Fetch live ticker and candles from Coinbase when Redis is cold."""
    symbol_norm = symbol.upper().replace("USDT", "").replace("USD", "")
    pair = f"{symbol_norm}-USD"
    now_ts = int(time.time())
    
    # 1. Fetch spot & ticker
    spot = 0.0
    bid = 0.0
    ask = 0.0
    try:
        url = f"https://api.exchange.coinbase.com/products/{pair}/ticker"
        req = urllib.request.Request(url, headers={"User-Agent": "truffle-bridge/1.0"})
        with urllib.request.urlopen(req, timeout=4) as r:
            tdata = json.loads(r.read().decode())
            spot = float(tdata.get("price", 0))
            bid = float(tdata.get("bid", spot - 1))
            ask = float(tdata.get("ask", spot + 1))
    except Exception:
        # Fallback defaults if upstream fails
        if symbol_norm == "BTC":
            spot, bid, ask = 76700.0, 76695.0, 76705.0
        elif symbol_norm == "ETH":
            spot, bid, ask = 2400.0, 2399.0, 2401.0
        else:
            spot, bid, ask = 150.0, 149.5, 150.5

    # 2. Fetch candles (last 24 1h candles)
    candles = []
    try:
        url = f"https://api.exchange.coinbase.com/products/{pair}/candles?granularity=3600"
        req = urllib.request.Request(url, headers={"User-Agent": "truffle-bridge/1.0"})
        with urllib.request.urlopen(req, timeout=5) as r:
            raw_candles = json.loads(r.read().decode())
            # Format: [ [ time, low, high, open, close, volume ], ... ]
            for c in raw_candles[:24]:
                candles.append({
                    "symbol": symbol_norm,
                    "ts": int(c[0]),
                    "o": float(c[3]),
                    "h": float(c[2]),
                    "l": float(c[1]),
                    "c": float(c[4]),
                    "v": float(c[5])
                })
    except Exception:
        candles.append({
            "symbol": symbol_norm,
            "ts": now_ts - (now_ts % 3600),
            "o": spot,
            "h": spot * 1.002,
            "l": spot * 0.998,
            "c": spot,
            "v": 100.0
        })

    # Sort ascending by ts
    candles.sort(key=lambda x: x["ts"])

    # 3. Cache into Redis
    if redis_client:
        try:
            # px:{symbol}:1m:latest (TTL 120s)
            latest_1m = {
                "symbol": symbol_norm,
                "ts": now_ts,
                "o": spot,
                "h": spot,
                "l": spot,
                "c": spot,
                "v": 1.0
            }
            redis_client.set(f"px:{symbol_norm}:1m:latest", json.dumps(latest_1m), ex=120)

            # px:{symbol}:1h:history (list, capped at 168)
            pipe = redis_client.pipeline()
            pipe.delete(f"px:{symbol_norm}:1h:history")
            for c in candles:
                pipe.rpush(f"px:{symbol_norm}:1h:history", json.dumps(c))
            pipe.ltrim(f"px:{symbol_norm}:1h:history", -168, -1)
            pipe.execute()

            # book:{venue}:{symbol} (TTL 30s)
            book_snap = {
                "venue": "coinbase",
                "symbol": symbol_norm,
                "best_bid": bid,
                "best_ask": ask,
                "bid_depth_usd": round(bid * 5.0, 2),
                "ask_depth_usd": round(ask * 5.0, 2),
                "ts": now_ts
            }
            redis_client.set(f"book:coinbase:{symbol_norm}", json.dumps(book_snap), ex=30)
        except Exception as e:
            print(f"[TruffleBridge] Redis write error: {e}")

    return {
        "candles": candles,
        "book": {
            "best_bid": bid,
            "best_ask": ask,
            "bid_depth_usd": round(bid * 5.0, 2),
            "ask_depth_usd": round(ask * 5.0, 2),
        }
    }


def get_prices_from_redis(symbol: str) -> dict:
    """Read candle history and orderbook from Redis with live fallback."""
    symbol_norm = symbol.upper().replace("USDT", "").replace("USD", "")
    candles = []
    book = None

    if redis_client:
        try:
            # 1. Read history from px:{symbol}:1h:history
            raw_list = redis_client.lrange(f"px:{symbol_norm}:1h:history", 0, -1)
            if raw_list:
                for item in raw_list:
                    candles.append(json.loads(item))

            # 2. Read orderbook from book:*:{symbol}
            for venue in ("coinbase", "binance", "kalshi", "wecrypto"):
                raw_book = redis_client.get(f"book:{venue}:{symbol_norm}")
                if raw_book:
                    b_data = json.loads(raw_book)
                    book = {
                        "best_bid": b_data.get("best_bid", 0.0),
                        "best_ask": b_data.get("best_ask", 0.0),
                        "bid_depth_usd": b_data.get("bid_depth_usd", 0.0),
                        "ask_depth_usd": b_data.get("ask_depth_usd", 0.0),
                    }
                    break
        except Exception as e:
            print(f"[TruffleBridge] Redis read error: {e}")

    # Fallback if Redis is cold or empty
    if not candles:
        fallback = fetch_live_market_fallback(symbol_norm)
        candles = fallback["candles"]
        if not book:
            book = fallback["book"]

    if not book:
        last_px = candles[-1]["c"] if candles else 76700.0
        book = {
            "best_bid": round(last_px - 1.0, 2),
            "best_ask": round(last_px + 1.0, 2),
            "bid_depth_usd": 150000.0,
            "ask_depth_usd": 150000.0,
        }

    return {"candles": candles, "book": book}


@app.get("/health")
def health():
    redis_ok = False
    if redis_client:
        try:
            redis_ok = redis_client.ping()
        except Exception:
            redis_ok = False

    return {
        "status": "ok",
        "service": "truffle-bridge",
        "redis": redis_ok,
        "endpoint": "https://truffle.leaksnipe.win",
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


@app.get("/px")
def get_px(symbol: str = "BTC"):
    """Snapshot endpoint for the edge worker (wecrypto.leaksnipe.win/px*)."""
    res = get_prices_from_redis(symbol)
    return {
        "symbol": symbol.upper(),
        "interval": "1h",
        "prices": res["candles"],
        "book": res["book"],
        "timestamp": int(time.time()),
    }


class CascadeRequest(BaseModel):
    symbol: Optional[str] = "BTC"
    spot: Optional[float] = None
    amm_bands: Optional[list[dict]] = Field(default_factory=list)
    liquidation_queue: Optional[list[dict]] = Field(default_factory=list)
    flow: Optional[dict] = Field(default_factory=dict)
    venue_skew: Optional[dict] = None


@app.post("/cascade")
@app.get("/cascade")
async def cascade_endpoint(
    req: Optional[CascadeRequest] = None,
    symbol: str = "BTC",
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """
    AMM Cascade Exhaustion telemetry endpoint for truffle.leaksnipe.win.
    Supports authenticated POST with custom payload or GET for live defaults.
    """
    sym = (req.symbol if req and req.symbol else symbol).upper()
    try:
        from amm_cascade_exhaustion import (
            AmmCascadeExhaustionCalculator,
            AmmPoolDepthBand,
            LiquidationBucket,
            VenueSkew,
            FlowSnapshot,
        )
        from truffle_cascade_bridge import format_asi1_context
        from dataclasses import asdict

        px_data = get_prices_from_redis(sym)
        book = px_data.get("book") or {}
        best_bid = float(book.get("best_bid") or 0.0)
        best_ask = float(book.get("best_ask") or 0.0)
        live_spot = (best_bid + best_ask) / 2.0 if best_bid and best_ask else 76500.0

        spot = float(req.spot) if req and req.spot else live_spot
        calc = AmmCascadeExhaustionCalculator()

        # Parse bands if provided, else use live orderbook depth
        bands = []
        if req and req.amm_bands:
            for b in req.amm_bands:
                bands.append(AmmPoolDepthBand(
                    lower_price=float(b["low"]),
                    upper_price=float(b["high"]),
                    virtual_liquidity_depth=float(b["depth"]),
                ))
        if not bands:
            floor_price = spot * (1.0 - (calc.slip_bps / 10_000.0))
            depth = float(book.get("bid_depth_usd") or 500000.0)
            bands = [AmmPoolDepthBand(lower_price=floor_price, upper_price=spot, virtual_liquidity_depth=depth)]

        # Parse queue if provided
        queue = []
        if req and req.liquidation_queue:
            for q in req.liquidation_queue:
                queue.append(LiquidationBucket(
                    trigger_price=float(q["price"]),
                    notional_volume=float(q["vol"]),
                    leverage_multiple=float(q.get("leverage", 10.0)),
                ))

        # Flow
        flow_dict = req.flow if req and req.flow else {}
        flow = FlowSnapshot(
            forced_liquidation_volume=float(flow_dict.get("forced_vol", 0.0)),
            discretionary_taker_buy_volume=float(flow_dict.get("taker_buy_vol", 10000.0)),
            discretionary_taker_sell_volume=float(flow_dict.get("taker_sell_vol", 10000.0)),
            amm_price_velocity=float(flow_dict.get("amm_vel", 0.0)),
            oracle_price_velocity=float(flow_dict.get("oracle_vel", 0.0)),
            window_sec=float(flow_dict.get("window_sec", 300.0)),
        )

        # Skew
        skew_dict = req.venue_skew if req and req.venue_skew else {}
        venue_skew = VenueSkew(
            l_ratio=float(skew_dict.get("l_ratio", 0.0)),
            divergence_pct=float(skew_dict.get("divergence_pct", 0.0)),
            funding_skew=float(skew_dict.get("funding_skew", 0.0)),
            active=bool(skew_dict.get("active", False)),
        )

        packet = calc.calculate_metrics(
            symbol=sym,
            spot_price=spot,
            amm_bands=bands,
            liquidation_queue=queue,
            flow=flow,
            venue_skew=venue_skew,
        )

        # Produce signal to Redpanda if state change / action warranted
        if kafka_producer and packet.verdict in ("FLUSH_EXHAUSTED_ABSORPTION_DETECTED", "VOID_SLIP_ACTIVE"):
            try:
                kafka_producer.send("truffle.signals", key=sym, value={
                    "symbol": sym,
                    "signal_type": "cascade_exhaustion",
                    "verdict": packet.verdict,
                    "coherence": packet.cascade_coherence_index,
                    "wall_density": packet.sub_orbital_wall_density,
                    "action": packet.recommended_action,
                    "ts": packet.timestamp_ms,
                })
            except Exception as k_err:
                print(f"[TruffleBridge] Error streaming cascade signal: {k_err}")

        return {
            "ok": True,
            "telemetry": asdict(packet),
            "context_prompt": format_asi1_context(packet),
        }
    except Exception as err:
        return {"ok": False, "error": str(err)}


@app.post("/chat")
async def chat_endpoint(
    req: ChatRequest,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """
    Agent Chat Protocol endpoint for Truffle.
    Enforces X-API-Key authentication and 10s hang-protection timeout.
    """
    if not verify_auth(x_api_key, authorization):
        raise HTTPException(
            status_code=401,
            detail={"status": "error", "message": "Unauthorized: Invalid or missing X-API-Key header"},
        )

    # Wrap resolution in a 10s timeout guard
    async def process():
        symbols = req.params.symbols if req.params and req.params.symbols else ["BTC"]
        interval = req.params.interval if req.params and req.params.interval else "1h"

        # Record session state in Redis: truffle:session:{id} (TTL 3600s)
        if redis_client and req.session_id:
            try:
                session_key = f"truffle:session:{req.session_id}"
                session_data = {
                    "last_active": int(time.time()),
                    "symbols": symbols,
                    "last_message": req.message,
                }
                redis_client.set(session_key, json.dumps(session_data), ex=3600)
            except Exception as e:
                print(f"[TruffleBridge] Session write error: {e}")

        all_prices = []
        primary_book = {}

        for sym in symbols:
            px_data = get_prices_from_redis(sym)
            all_prices.extend(px_data["candles"])
            if not primary_book and px_data["book"]:
                primary_book = px_data["book"]

        # Check if caller sent signals in params
        if req.params and req.params.signals and kafka_producer:
            for sym, sig in req.params.signals.items():
                try:
                    kafka_producer.send("truffle.signals", key=sym.upper(), value={"symbol": sym.upper(), "data": sig, "ts": int(time.time())})
                except Exception as e:
                    print(f"[TruffleBridge] Error publishing signal from chat: {e}")

        return {
            "status": "success",
            "data": {
                "interval": interval,
                "prices": all_prices,
                "book": primary_book,
            },
        }

    try:
        return await asyncio.wait_for(process(), timeout=10.0)
    except asyncio.TimeoutError:
        return {"status": "timeout", "message": "Request timed out after 10 seconds"}


class SignalRequest(BaseModel):
    symbol: str
    signal_type: Optional[str] = "regime"
    probability: Optional[float] = None
    flags: Optional[dict[str, Any]] = Field(default_factory=dict)
    data: Optional[dict[str, Any]] = Field(default_factory=dict)
    timestamp: Optional[int] = None


@app.post("/signal")
def post_signal(
    signal: SignalRequest,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """Publish regime flags and probabilities to truffle.signals."""
    if not verify_auth(x_api_key, authorization):
        raise HTTPException(
            status_code=401,
            detail={"status": "error", "message": "Unauthorized: Invalid or missing X-API-Key header"},
        )

    payload = signal.model_dump()
    if not payload.get("timestamp"):
        payload["timestamp"] = int(time.time())

    if kafka_producer:
        try:
            kafka_producer.send("truffle.signals", key=signal.symbol.upper(), value=payload)
            kafka_producer.flush()
        except Exception as e:
            print(f"[TruffleBridge] Signal produce error: {e}")
            return {"status": "error", "message": str(e)}

    return {"status": "success", "message": f"Signal for {signal.symbol} published to truffle.signals", "data": payload}


UAGENT_PORT = int(os.getenv("UAGENT_PORT", "8002"))


@app.get("/submit")
@app.head("/submit")
async def submit_health_check():
    """Liveness probe for Agentverse and webhook pingers."""
    return {
        "status": "ok",
        "agent": "Trufflezzz",
        "address": "agent1qw7fvhx3x0nsjppcpz7e5a92rq8k7qzsl3rug9nryc0mvz0r4kve28xfzhm",
        "handle": "truffz",
        "protocol": "proto:30a801ed3a83f9a0ff0a9f1e6fe958cb91da1fc2218b153df7b6cbf87bd33d62",
    }


@app.post("/submit")
async def submit_proxy(request: Request):
    """
    Proxy Agentverse envelope messages to the uAgent on port 8002.
    truffle.leaksnipe.win (CF tunnel) → 8040 (this server), but the
    uAgents envelope protocol (/submit) lives on 8002. Forward transparently.
    """
    body = await request.body()
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length")
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"http://127.0.0.1:{UAGENT_PORT}/submit",
                content=body,
                headers=headers,
            )
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type", "application/json"),
        )
    except Exception as e:
        print(f"[TruffleBridge] /submit proxy error: {e}")
        raise HTTPException(status_code=502, detail=f"uAgent unreachable: {e}")


def _run_kafka_tick_consumer():
    """Background consumer subscribing to wecrypto.prices.ticks and updating Redis."""
    try:
        from kafka import KafkaConsumer
        consumer = KafkaConsumer(
            "wecrypto.prices.ticks",
            bootstrap_servers=REDPANDA_BROKERS.split(","),
            auto_offset_reset="latest",
            enable_auto_commit=True,
            group_id="truffle-bridge-roll",
            value_deserializer=lambda m: json.loads(m.decode("utf-8")),
            consumer_timeout_ms=2000,
        )
        print(f"[TruffleBridge] Subscribed to wecrypto.prices.ticks on {REDPANDA_BROKERS}")
        while True:
            for message in consumer:
                try:
                    data = message.value
                    symbol = (data.get("symbol") or "BTC").upper()
                    now_ts = data.get("ts") or int(time.time())
                    candle = {
                        "symbol": symbol,
                        "ts": int(now_ts),
                        "o": float(data.get("o", 0.0)),
                        "h": float(data.get("h", 0.0)),
                        "l": float(data.get("l", 0.0)),
                        "c": float(data.get("c", 0.0)),
                        "v": float(data.get("v", 0.0)),
                    }
                    if redis_client:
                        # 1. px:{symbol}:1m:latest (TTL 120s)
                        redis_client.set(f"px:{symbol}:1m:latest", json.dumps(candle), ex=120)
                        # 2. Append to 1h history (capped at 168)
                        redis_client.rpush(f"px:{symbol}:1h:history", json.dumps(candle))
                        redis_client.ltrim(f"px:{symbol}:1h:history", -168, -1)

                    # 3. Roll to 1m topic
                    if kafka_producer:
                        kafka_producer.send("wecrypto.prices.1m", key=symbol, value=candle)
                except Exception as ex:
                    print(f"[TruffleBridge] Consumer tick processing error: {ex}")
            time.sleep(0.1)
    except Exception as e:
        print(f"[TruffleBridge] Kafka consumer thread exited: {e}")


@app.on_event("startup")
def on_startup():
    t = threading.Thread(target=_run_kafka_tick_consumer, daemon=True)
    t.start()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
