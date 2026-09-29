import re
with open('/mnt/g/WECRYP/market_data.py', 'r') as f:
    code = f.read()

staleness_check = """
def enforce_freshness(payload: dict, source: str) -> None:
    if not payload: return
    import time
    from datetime import datetime, timezone
    ts_str = payload.get("collector_timestamp") or payload.get("timestamp_utc") or payload.get("time") or payload.get("ts")
    if ts_str:
        try:
            dt = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - dt).total_seconds()
        except Exception:
            age = 0
        if age > 60:
            raise ValueError(f"STALE: {source} data is {age:.1f}s old")
"""

if "enforce_freshness" not in code:
    code = code.replace("import time\n", "import time\n" + staleness_check)

# Patch get_spot to enforce freshness and use worker if needed
spot_func = """def get_spot(symbol: str = "BTC-USD") -> dict:
    try:
        from kodak_bridge import get_kodak_snapshot
        snapshot = get_kodak_snapshot(include_model=False)
        enforce_freshness(snapshot, "snapshot_spot")
        if snapshot.get("spot") and snapshot.get("spot").get("binance"):
            return {
                "price": snapshot["spot"]["binance"],
                "source": "kodak_snapshot",
                "canonical_source": "BINANCE",
                "error": None
            }
    except Exception:
        pass

    try:
        r = requests.get(f"https://scalper-market-data.gitgoin87.workers.dev/spot?symbol=BTC", timeout=5)
        r.raise_for_status()
        data = r.json()
        enforce_freshness(data, "worker_spot")
        return {
            "price": float(data["price"]),
            "source": "worker_spot_fallback",
            "canonical_source": "COINBASE",
            "error": None
        }
    except Exception as e:
        return {"price": None, "source": "error", "error": str(e)}
"""

code = re.sub(r'def get_spot.*?except Exception as e:\n.*?return \{"price": None.*?"error": str\(e\)\}', spot_func, code, flags=re.DOTALL)

with open('/mnt/g/WECRYP/market_data.py', 'w') as f:
    f.write(code)
