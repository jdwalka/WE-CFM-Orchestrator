import re
with open('/mnt/g/WECRYP/prediction_engine.py', 'r') as f:
    code = f.read()

# Lane 2: staleness check
staleness_check = """
def enforce_freshness(payload: dict, source: str) -> None:
    '''Lane 2 timestamp staleness gate'''
    if not payload:
        return
    import time
    from datetime import datetime, timezone
    
    # Check collector_timestamp, timestamp_utc, time, or ts
    ts_str = payload.get("collector_timestamp") or payload.get("timestamp_utc") or payload.get("time") or payload.get("ts")
    if ts_str:
        try:
            # Handle ISO formats
            dt = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - dt).total_seconds()
        except Exception:
            age = 0
            
        if age > 60:
            raise ValueError(f"STALE: {source} data is {age:.1f}s old")
"""

if "enforce_freshness" not in code:
    code = code.replace("import time\n", "import time\n" + staleness_check)

# Add freshness to get_kalshi_ladder
ladder_func = """def get_kalshi_ladder() -> dict:"""
new_ladder_func = """def get_kalshi_ladder() -> dict:
    '''Resilient Kalshi hourly band ladder with Lane 1 backoff and Lane 2 staleness check.'''
    now = time.time()
    cached = _bands_cache["data"]
    if cached is not None and now - _bands_cache["ts"] < BANDS_CACHE_TTL_SECONDS:
        return {
            **deepcopy(cached),
            "status": "ok",
            "error": None,
            "_cache": "hit",
            "_source": "cache",
            "_ts": _bands_cache["ts"],
        }

    last_primary_error = None
    
    # Lane 1: retry with backoff (3 attempts, 2s/4s/8s)
    delays = [2, 4, 8]
    for attempt in range(3):
        try:
            response = requests.get(
                f"{MARKET_DATA_WORKER_URL}/kalshi/bands", timeout=15
            )
            response.raise_for_status()
            payload = response.json()
            
            # Lane 2: enforce freshness
            enforce_freshness(payload, "ladder")
            
            payload = _normalize_bands_payload(payload)
            
            # Lane 1: Add collector_timestamp freshness check to ladder response
            if "collector_timestamp" not in payload:
                from datetime import datetime, timezone
                payload["collector_timestamp"] = datetime.now(timezone.utc).isoformat()
                
            payload = {
                **deepcopy(payload),
                "status": "ok",
                "error": None,
                "_cache": "miss",
                "_source": "primary_worker",
                "_ts": time.time(),
            }
            _bands_cache["data"] = deepcopy(payload)
            _bands_cache["ts"] = time.time()
            return payload
        except requests.exceptions.RequestException as e:
            last_primary_error = str(e)
            if attempt < 2:
                time.sleep(delays[attempt])
        except ValueError as e:
            last_primary_error = str(e)
            if attempt < 2:
                time.sleep(delays[attempt])

    try:
        ladder = _fetch_bands_from_snapshot()
        enforce_freshness(ladder, "snapshot_ladder")
        payload = {
            **deepcopy(ladder),
            "candidate_bands": ladder.get("markets", []),
            "status": "ok",
            "error": None,
            "_cache": "miss",
            "_source": "snapshot_fallback",
            "_primary_error": last_primary_error,
            "_ts": time.time(),
        }
        payload = _normalize_bands_payload(payload)
        _bands_cache["data"] = deepcopy(payload)
        _bands_cache["ts"] = time.time()
        return payload
    except ValueError as fallback_error:
        # Lane 1: explicit FEED_DOWN status - never serve stale quotes as live
        return {
            "status": "FEED_DOWN",
            "error": str(fallback_error),
            "candidate_bands": [],
            "_primary_error": last_primary_error,
            "_cache": "stale_refused"
        }
"""
code = re.sub(r'def get_kalshi_ladder\(\) -> dict:.*?except ValueError as fallback_error:\n\s+if cached is not None:\n\s+return \{\n.*?\n\s+\}\n\s+return \{\n.*?\n\s+\}', new_ladder_func, code, flags=re.DOTALL)

with open('/mnt/g/WECRYP/prediction_engine.py', 'w') as f:
    f.write(code)
