#!/usr/bin/env bash
# verify_collector_fix.sh — run with NO other traffic hitting the collector
BASE="${1:-https://scalper.leaksnipe.win}"

echo "[V3] fresh bypass"
fresh=$(curl -s "$BASE/ladder?fresh=1")
echo "$fresh" | jq -e '.age_seconds <= 5 and .cache != "hit"' \
  && echo "PASS fresh is live" || echo "FAIL fresh bypass"

echo "[V1/V2] passive wait 70s (> 60s cron cadence) — make zero requests"
sleep 70
cached=$(curl -s "$BASE/ladder")
age=$(echo "$cached" | jq '.age_seconds')
echo "$cached" | jq -e '.cache == "hit"' \
  && echo "PASS served from KV" || echo "FAIL not a cache hit"
# age must be < 70: no request poked it during the wait, so only the cron could have refreshed
jq -e --argjson a "$age" '$a < 70' <<< '{}' \
  && echo "PASS cron refreshed without a poke (age=${age}s)" \
  || echo "FAIL age=${age}s — cron not firing"

echo "[V2] age stamp present"
echo "$cached" | jq -e 'has("age_seconds") and has("computed_at")' \
  && echo "PASS age stamping live" || echo "FAIL missing age fields"
