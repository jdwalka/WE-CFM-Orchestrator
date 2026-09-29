#!/usr/bin/env python3
"""Ladder keep-fresh watchdog (cron */10).

Checks the two rungs the hourly-ranges panel reads:
  1. scalper-market-data /kalshi/bands  (primary lane)
  2. kalshi-ladder-worker /signals      (middle lane, what the app reads)

On staleness it force-refreshes ( Scalper ?fresh=1, ladder ?force=1 per
symbol) so KV never sits kv-stale/expired. Logs to
/tmp/opencode/ladder-watchdog.log. DataFaults in the app remains the
in-panel monitor; this is the self-healing counterpart.

Needs CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (read from
/mnt/g/WECRYP/.env like prediction_engine.py).
"""

import datetime
import json
import os
import sys
import urllib.request

ENV_PATH = "/mnt/g/WECRYP/.env"
LOG_PATH = "/tmp/opencode/ladder-watchdog.log"
SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB"]


def load_env():
    try:
        with open(ENV_PATH) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip("\"'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError:
        pass


def headers():
    # NOTE: urllib's default "Python-urllib/3.12" UA trips the zone WAF
    # (scripting-client rule) on data paths; identify as first-party.
    h = {"Accept": "application/json", "User-Agent": "wecrypto-engine/1.0"}
    cid = os.getenv("CF_ACCESS_CLIENT_ID", "")
    csec = os.getenv("CF_ACCESS_CLIENT_SECRET", "")
    if cid:
        h["CF-Access-Client-Id"] = cid
    if csec:
        h["CF-Access-Client-Secret"] = csec
    return h


def get_json(url, timeout=20):
    req = urllib.request.Request(url, headers=headers())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def log(msg):
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    line = f"{ts} {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def main():
    load_env()
    actions = []

    # Rung 1: primary bands must be ok with a live expiry.
    try:
        b = get_json(
            "https://scalper-market-data.gitgoin87.workers.dev"
            "/kalshi/bands?fresh=1"
        )
        mins = b.get("minutes_to_expiry")
        if b.get("status") != "ok" or not isinstance(mins, (int, float)):
            actions.append(f"primary bands bad (status={b.get('status')})")
        else:
            log(f"primary ok expiry_min={mins:.1f} bands={len(b.get('candidate_bands', []))}")
    except Exception as e:  # noqa: BLE001
        actions.append(f"primary fetch failed: {e}")

    # Rung 2: signals must not sit expired/kv-stale.
    try:
        s = get_json("https://ladder.leaksnipe.win/signals")
        stale = [x for x in s.get("signals", [])
                 if (x.get("cache_source") or "") in ("expired-fallback", "kv-stale")]
        if stale:
            actions.append("stale: " + ",".join(
                f"{x.get('symbol')}:{x.get('cache_source')}" for x in stale))
            for x in stale:
                sym = x.get("symbol")
                if sym not in SYMBOLS:
                    continue
                try:
                    cur = get_json(f"https://ladder.leaksnipe.win/ladder?symbol={sym}&force=1")
                    if (cur.get("status") == "expired"
                            and not cur.get("bands")):
                        actions.append(f"{sym} still expired (no live series, expected)")
                    else:
                        actions.append(f"force-refreshed {sym}")
                except Exception as e:  # noqa: BLE001
                    actions.append(f"force-refresh {sym} failed: {e}")
        else:
            log(f"signals fresh ({len(s.get('signals', []))} symbols)")
    except Exception as e:  # noqa: BLE001
        actions.append(f"signals fetch failed: {e}")

    if actions:
        for a in actions:
            log("ACTION " + a)
        return 1
    log("all fresh, no action")
    return 0


if __name__ == "__main__":
    sys.exit(main())
