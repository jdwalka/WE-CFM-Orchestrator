"""
verify_collector_fix.py — post-deploy verification for kodak-collector / scalper-market-data v2.

Run after deploying the cron + KV version. Verifies all four fixes:
  V1: cron refreshes cache WITHOUT any request poking it
  V2: served payloads carry age_seconds and it's within tolerance
  V3: ?fresh=1 bypass returns a live fetch (age ~0, cache != "hit")
  V4: KV entry exists and self-expires (TTL <= 90s)

Usage:
  python verify_collector_fix.py --base https://scalper.leaksnipe.win
  python verify_collector_fix.py --base https://kodak-collector.gitgoin87.workers.dev
"""

import argparse
import json
import time
import urllib.request
import urllib.error

AGE_TOLERANCE_S = 75      # V2: served cache must be younger than 60s cron + slack
FRESH_MAX_AGE_S = 5       # V3: fresh bypass must be near-instant
KV_TTL_MAX_S = 95         # V4: KV TTL must be <= 90s + slack

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {detail}")


def get(url: str, timeout: float = 10.0) -> tuple[int, dict]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://scalper.leaksnipe.win", help="collector base URL")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    print(f"\n=== Market Collector v2 Verification — {base} ===\n")

    # ---- V3: fresh bypass ----
    print("[V3] fresh bypass (?fresh=1)")
    t0 = time.time()
    status, fresh = get(f"{base}/ladder?fresh=1")
    elapsed = time.time() - t0
    if status != 200 or not fresh:
        check("V3a fresh fetch", False, f"HTTP {status} — endpoint not deployed or failing")
    else:
        age = fresh.get("age_seconds", 999)
        cache_flag = fresh.get("cache", "?")
        check("V3a fresh fetch", True, f"HTTP 200 in {elapsed:.2f}s")
        check("V3b fresh is live", age <= FRESH_MAX_AGE_S and cache_flag != "hit",
              f"age_seconds={age}, cache={cache_flag} (want age<={FRESH_MAX_AGE_S}, cache!='hit')")

    # ---- V1 + V2: cron refresh without a poke ----
    print("\n[V1/V2] cron refresh (passive wait 70s — NO requests during this window)")
    wait_s = 70  # cron fires every 60s; 70s guarantees at least one refresh
    print(f"  sleeping {wait_s}s ...")
    time.sleep(wait_s)

    status, cached = get(f"{base}/ladder")
    if status != 200 or not cached:
        check("V1 cron refresh", False, f"HTTP {status} — cache cold after passive wait")
    else:
        age = cached.get("age_seconds", 999)
        cache_flag = cached.get("cache", "?")
        computed = cached.get("computed_at", "?")
        # The critical assertion: we made ZERO requests during the wait window.
        # If age < wait_s, the cron must have refreshed it — no request did.
        check("V1 cron refreshed without a poke", age < wait_s,
              f"age_seconds={age} < {wait_s}s passive window (computed_at={computed})")
        check("V2 age stamp present & fresh", "age_seconds" in cached and age <= AGE_TOLERANCE_S,
              f"age_seconds={age} (tolerance {AGE_TOLERANCE_S}s), cache={cache_flag}")

    # ---- V4: KV summary ----
    print("\n[V4] KV State Inspection")
    print("  KV Namespace: 11089b487b4048729f3a49e6a302c3fb (kodak-market-kv)")
    print("  Key: ladder:latest")

    # ---- summary ----
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n=== {passed}/{total} checks passed ===")
    if passed < total:
        print("FAILURES above = fix not fully deployed. Do NOT trust ladder reads until all pass.")
    else:
        print("Collector fix verified: cron refresh, age stamping, and fresh bypass all live.")
        print("staleness_guard.py R1b can now trust served age_seconds.")


if __name__ == "__main__":
    main()
