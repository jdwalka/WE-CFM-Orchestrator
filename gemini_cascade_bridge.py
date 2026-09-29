"""
Gemini Agentverse / ASI1 Protocol Bridge — v2 (hardened, fast paths)
Module: Gemini_cascade_bridge.py
Port: 127.0.0.1:8003
"""

import json
import logging
import os as _os
import time as _time
import urllib.request as _urllib_req
import urllib.error as _urllib_err
from datetime import datetime as _dt, timezone as _tz
from concurrent.futures import ThreadPoolExecutor as _ThreadPool

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("Gemini-cascade")

# API key comes from environment (.env) — never hardcoded.
_GEMINI_API_KEY = _os.getenv("GEMINI_API_KEY") or _os.getenv("GEMINI_API_KEY_FALLBACK") or _os.getenv("GOOGLE_API_KEY") or ""
_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_GEMINI_CASCADE = [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
]

_SYSTEM_PROMPT = (
    "You are Gemini — the WeCryp live trading desk assistant for Kalshi/Polymarket hourly range binaries. "
    "You RUN LIVE: you ALWAYS have real market visibility via the LIVE MARKET SNAPSHOT block. "
    "You MUST NEVER ask the user for current BTC price, orderbook, or candles — use the snapshot. "
    "For 'BTC close in 15 min projected' you MUST compute a numeric projection: "
    "projected_close = spot + drift + volatility term from quantitative prediction. "
    "Ground every number in snapshot. If asked for 15m close, give: projected close, low/high range for next 15m, "
    "confidence %, direction bias, and settlement note (BRTI average vs TWAP). "
    "Be concise, professional, no disclaimer about lacking live data."
)


_CTX_CACHE = {"data": None, "ts": 0.0, "ttl": 45.0, "id": ""}


def _fetch_spot_coinbase() -> dict:
    """Fast Coinbase spot — single HTTP call, no cascade."""
    try:
        import httpx
        r = httpx.get("https://api.coinbase.com/v2/prices/BTC-USD/spot", timeout=5,
                      headers={"User-Agent": "wecryp-jdwalkaz/1.0"})
        r.raise_for_status()
        return r.json().get("data", {})
    except Exception as e:
        log.warning(f"coinbase spot fetch error: {e}")
        return {}


def _fetch_bridge_px() -> dict:
    """Fast bridge PX Redis ticker."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:8040/px?symbol=BTC", timeout=3) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        log.warning(f"bridge px error: {e}")
        return {}


def _predict_15m_only() -> dict | None:
    """Only the 15m prediction — skip heavy hourly ladder entirely."""
    try:
        from prediction_engine import predict_15m_range
        m15 = predict_15m_range()
        if isinstance(m15, dict) and m15.get("ticker"):
            return m15
    except Exception as e:
        log.warning(f"15m prediction error: {e}")
    return None


def _deterministic_15m_projection() -> str:
    """Deterministic projection from 24h hourly candles only (no Kalshi ladder)."""
    try:
        from market_data import get_spot, get_hourly_candles, compute_stats
        import math as _math
        spot_data = get_spot()
        spot = spot_data.get("price")
        if not spot:
            return ""
        candles = get_hourly_candles(24)
        if not candles:
            return ""
        stats = compute_stats(candles)
        avg_range = stats.get("avg_hourly_range") or 0
        last_open = stats.get("last_open") or spot
        last_close = stats.get("last_close") or spot
        drift_per_hour = last_close - last_open
        drift_15m = drift_per_hour * 0.25
        sigma_15m = (avg_range / 4) * 0.6
        proj = spot + drift_15m
        return (f"DETERMINISTIC_15M_PROJECTION: spot=${spot:,.2f} "
                f"drift_15m=${drift_15m:,.2f} sigma_15m=${sigma_15m:,.2f} "
                f"=> projected_close=${proj:,.2f} range ${proj - sigma_15m:,.2f}–${proj + sigma_15m:,.2f} "
                f"(calc from 24h avg_range ${avg_range:,.2f})")
    except Exception as e:
        log.warning(f"deterministic projection error: {e}")
        return ""


def _build_live_btc_context(query_hint: str = "") -> str:
    """Inject live spot + 15m prediction + Bridge PX + deterministic projection so Gemini has visibility."""
    now_sec = _time.time()
    use_15m = any(k in (query_hint or "").lower() for k in ["15", "close", "projected", "minute", "expiry"])
    cache_id = "15m" if use_15m else "hourly"

    # 30s cache — reuse body for speed; always refresh header timestamp
    if _CTX_CACHE["data"] is not None and (now_sec - _CTX_CACHE["ts"]) < _CTX_CACHE["ttl"] and _CTX_CACHE.get("id") == cache_id:
        cached = _CTX_CACHE["data"]
        lines = cached.split("\n", 1)
        header = f"[LIVE SNAPSHOT UTC {_dt.now(_tz.utc).isoformat()} — cached {int(now_sec - _CTX_CACHE['ts'])}s ago]"
        return header + "\n" + (lines[1] if len(lines) > 1 else "")

    parts = []
    now_utc = _dt.now(_tz.utc).isoformat()
    parts.append(f"[LIVE SNAPSHOT UTC {now_utc}]")

    # 1. Coinbase spot (fast, single HTTP)
    try:
        cd = _fetch_spot_coinbase()
        price = cd.get("amount") or cd.get("price")
        src = cd.get("source", "coinbase_spot_fallback")
        ts = cd.get("timestamp_utc", now_utc)
        err = cd.get("error")
        if price:
            parts.append(f"BTC SPOT (Coinbase): ${float(price):,.2f} src={src} ts={ts} err={err}")
        else:
            parts.append(f"BTC SPOT unavailable: {cd}")
    except Exception as e:
        parts.append(f"market_data import error: {e}")

    # 2. 15m prediction from Kalshi (fast, no hourly ladder)
    try:
        m15 = _predict_15m_only()
        if isinstance(m15, dict) and m15.get("ticker"):
            fair = m15.get("fair_cents") or m15.get("fair") or m15.get("model_fair")
            p_final = m15.get("p_final") or m15.get("prob")
            mins = m15.get("minutes_to_expiry")
            parts.append(f"15M_KALSHI: ticker={m15.get('ticker')} fair_cents={fair} prob={p_final} mins_left={mins}")
        else:
            parts.append("15M_KALSHI: unavailable (no live Kalshi contract)")
    except Exception as e:
        parts.append(f"15m prediction error: {e}")

    # 3. Bridge PX orderbook fallback (fast)
    try:
        bp = _fetch_bridge_px()
        book = bp.get("book", {})
        if book.get("best_bid") and book.get("best_ask"):
            parts.append(f"BRIDGE_PX: bid={book.get('best_bid')} ask={book.get('best_ask')} depth_bid_usd={book.get('bid_depth_usd')}")
        else:
            parts.append("BRIDGE_PX: empty or error")
    except Exception as e:
        parts.append(f"bridge px error: {e}")

    # 4. Deterministic 15m projection (fast, no Kalshi needed)
    det = _deterministic_15m_projection()
    if det:
        parts.append(det)

    result = "\n".join(parts)
    _CTX_CACHE["data"] = result
    _CTX_CACHE["ts"] = now_sec
    _CTX_CACHE["id"] = cache_id
    return result


def _call_gemini(user_text: str, live_context: str | None = None) -> str:
    ctx = live_context or _build_live_btc_context()
    full_prompt = (
        f"LIVE MARKET SNAPSHOT (use this, do not ask user for price):\n{ctx}\n\n"
        f"USER QUERY: {user_text}\n\n"
        f"INSTRUCTION: Answer the user query grounded ONLY in the snapshot above. "
        f"If query is 'btc close in 15 min projected' give projected close, range, confidence, direction, and settlement venue note."
    )
    payload = json.dumps({
        "system_instruction": {"parts": [{"text": _SYSTEM_PROMPT}]},
        "contents": [{"parts": [{"text": full_prompt}]}],
        "generationConfig": {"temperature": 0.15, "maxOutputTokens": 1200},
    }).encode("utf-8")
    last_err = None
    for model in _GEMINI_CASCADE:
        url = f"{_GEMINI_BASE}/{model}:generateContent"
        req = _urllib_req.Request(url, data=payload, headers={
            "Content-Type": "application/json",
            "X-goog-api-key": _GEMINI_API_KEY,
        }, method="POST")
        try:
            with _urllib_req.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                return data["candidates"][0]["content"]["parts"][0]["text"].strip()
        except _urllib_err.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:500]
            last_err = f"{model}: HTTP {e.code} {body[:120]}"
            if e.code in (429, 503):
                continue
            continue
        except Exception as e:
            last_err = f"{model}: {e}"
            continue
    raise RuntimeError(f"Gemini unavailable. Last error: {last_err}")


async def handle_query(request: object) -> object:
    """Simplified sync version for quick testing."""
    try:
        # Parse JSON body manually
        import json as _json
        length = request.headers.get('Content-Length')
        body = await request.read()
        data = _json.loads(body) if body else {}
        user_query = data.get("query", "").strip()
        if not user_query:
            return web.json_response({"ok": False, "error": "empty query"}, status=400)
        live_ctx = _build_live_btc_context()
        try:
            answer = _call_gemini(user_query, live_ctx)
        except RuntimeError as ge:
            fallback = ("⚠️ Gemini API temporarily unavailable — deterministic projection:\n\n"
                        + live_ctx[:3000]
                        + f"\n\n[Gemini error: {ge}]"
                        + "\n\nUse DETERMINISTIC_15M_PROJECTION above as your BTC 15m close estimate. "
                        "Settles BRTI average (Coinbase) — single wick at expiry counts.")
            log.warning(f"Gemini fallback used: {ge}")
            return web.json_response({"ok": True, "content": fallback, "fallback": True})
        return web.json_response({"ok": True, "content": answer})
    except Exception as e:
        log.exception("Query handler error")
        return web.json_response({"ok": False, "error": str(e)}, status=500)


def create_Gemini_app() -> object:
    from aiohttp import web
    app = web.Application(client_max_size=1_000_000)
    app.router.add_post("/query", handle_query)
    app.router.add_get("/health", lambda r: web.json_response({"status": "healthy", "service": "Gemini-cascade-engine", "version": "2.0"}))
    return app


if __name__ == "__main__":
    from aiohttp import web
    app = create_Gemini_app()
    print("Gemini AMM Cascade Bridge bound to http://127.0.0.1:8003")
    web.run_app(app, host="127.0.0.1", port=8003)
