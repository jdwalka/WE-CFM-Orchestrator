#!/usr/bin/env bash
# Apply WeCrypto Tailscale DNS from live authoritative NS lookups.
# Split DNS = each API zone's own nameserver IPs (not 1.1.1.1/Mullvad).
# Global: 1.1.1.1 off-exit, Mullvad on-exit.
set -euo pipefail

: "${TAILSCALE_API_KEY:?set TAILSCALE_API_KEY in the environment}"
TAILNET="${TS_TAILNET:-prairiedog-godzilla.ts.net}"
MAURO="${TS_MAURO_ID:-6166383720811725}"
AUTH="Authorization: Bearer ${TAILSCALE_API_KEY}"
BASE="https://api.tailscale.com/api/v2"
HERE="$(cd "$(dirname "$0")" && pwd)"
AUTHNS="$HERE/wecrypto-auth-ns.json"

python3 - "$HERE/wecrypto-dns.json" "$AUTHNS" <<'PY'
import json, sys
from pathlib import Path
dns_path, auth_path = Path(sys.argv[1]), Path(sys.argv[2])
if dns_path.exists():
    body = json.loads(dns_path.read_text())
    split = body.get("splitDNS") or {}
    print("split domains from wecrypto-dns.json", len(split), file=sys.stderr)
else:
    inv = json.loads(auth_path.read_text())
    split = {}
    for z, info in (inv.get("zones") or {}).items():
        ips = [ip for ip in (info.get("ips") or []) if ip]
        if ips:
            split[z] = [{"address": ip} for ip in ips]
    for z in ("asi1.ai", "fetch-ai.com", "g.alchemy.com", "r.alchemy.com", "alchemy.com", "tokenmix.ai"):
        split[z] = [{"address": "1.1.1.1", "useWithExitNode": True}, {"address": "1.0.0.1", "useWithExitNode": True}]
    body = {
        "nameservers": [
            {"address": "1.1.1.1", "useWithExitNode": True},
            {"address": "1.0.0.1"},
            {"address": "2606:4700:4700::1111"},
            {"address": "2606:4700:4700::1001"},
            {"address": "194.242.2.2"},
            {"address": "2a07:e340::2"},
        ],
        "splitDNS": split,
        "preferences": {"overrideLocalDNS": True, "magicDNS": True},
    }
    print("split domains from auth-ns fallback", len(split), file=sys.stderr)
Path("/tmp/ts-dns-cfg-next.json").write_text(json.dumps(body))
PY

echo "== POST /dns/configuration =="
curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  --data-binary @/tmp/ts-dns-cfg-next.json \
  "$BASE/tailnet/$TAILNET/dns/configuration" >/dev/null
echo "ok"

echo "== POST searchpaths =="
curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"searchPaths":["prairiedog-godzilla.ts.net"]}' \
  "$BASE/tailnet/$TAILNET/dns/searchpaths"; echo

echo "== mauro LAN route =="
curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"routes":["192.168.18.0/24"]}' "$BASE/device/$MAURO/routes"; echo
