# Handoff — Tailscale + WARP DNS-only + localhost Serve (WSL)

**Date:** 2026-08-18 (late)  
**Continue in:** WSL, repo `G:\WECRYP` = `/mnt/g/WECRYP`  
**Git:** branch `feat/asi1-credit-orchestrator` → remote **`leaksnipe`** = `LeakSnipe/WE-CFM-Orchestrator` (PR #2). Do not treat `origin` (JohnDaWalka) as the source of truth.  
**Windows node:** `mauro.prairiedog-godzilla.ts.net` `100.107.195.35` nodeId **`nSfuckSm9q11CNTRL`**

Do **not** commit API keys. Do **not** print full `tskey-api-…` or Cloudflare tokens in git or chat logs.

---

## What you are finishing

Nail **WARP (DNS-only)** to **Tailscale** using the **localhost WeCrypto service**, and use the **home LAN subnet router on mauro** (replacement for the brother’s laptop subnet router) so phones/other nodes can hit the desk.

WARP **full tunnel** + Tailscale **RouteAll/Mullvad exit** = [CF_DNS_LOOKUP_FAILURE](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/troubleshooting/client-errors/#cf_dns_lookup_failure). That is proven. Do not turn `warp+doh` (traffic+DNS tunnel) back on while a Mullvad exit is selected.

---

## Live snapshot (when this file was written)

| Piece | State |
|--------|--------|
| Origin | `https://127.0.0.1:3450` **HTTP 200** (node `wecrypto-web-service`, HTTPS self-signed) |
| Tailscale Serve | `https://mauro.prairiedog-godzilla.ts.net/` → origin **200** |
| `svc:wecrypto` | **Created + host approved.** VIP **`100.108.140.221`** / `fd7a:115c:a1e0::f83a:8cde`. MagicDNS **`wecrypto.prairiedog-godzilla.ts.net`** resolves. **curl timed out** — ACL grant never landed (PowerShell ACL parse failed). |
| Subnet router | API **enabled** `192.168.18.0/24` on mauro. Brother’s `g-lap` / `g-lap-1`: **offline, advertised=[]**. |
| Tailscale | `WantRunning=true`, `CorpDNS=false`, **Mullvad exit ON** (`ExitNodeID=n8XjUZ8cgL11CNTRL`, Stockholm egress). |
| WARP | **Disconnected** (manual). DNS-only (`mode doh`) **connects only when the Mullvad exit is off**. |
| Ethernet | `192.168.18.38` MAC `7C-10-C9-44-08-23` metric **10** — WeCrypto / WARP / Tailscale |
| Wi-Fi SSID **LeakSnipe** | AP BSSID `62:07:f8:49:59:9a`, client MAC `86-E3-90-99-F2-5C`. Last good LAN `192.168.18.56`. Often drops to APIPA. Metric **80**. |
| Modem WAN | **`100.64.91.167`** Optimum **CGNAT** (RFC6598). Not public. |
| House public (exit off) | **`64.25.2.144`** — Cloudflare Gateway location “233 Roseville” |
| Cloudflare API | env `CLOUDFLARE_API_TOKEN` is expired **`cfoat_`**. Cannot edit ZT/DNS/tunnels until a dashboard token is set. |

Cloudflared Windows service **Cloudflared** (token `63000efe-…` tunnel **wecrypto**) still publishes `wecrypto.leaksnipe.win` → `https://127.0.0.1:3450`. Public host was **403**.

---

## Import the Tailscale API key in WSL

Key is in **Windows User** env `TAILSCALE_API_KEY` (not in the repo).

```bash
export TAILSCALE_API_KEY="$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('TAILSCALE_API_KEY','User')" | tr -d '\r')"
export TS_TAILNET="prairiedog-godzilla.ts.net"
export TS_MAURO="nSfuckSm9q11CNTRL"
# sanity: first 12 chars only
echo "${TAILSCALE_API_KEY:0:12}… len=${#TAILSCALE_API_KEY}"
```

That key was also pasted in the Windows chat. Rotate after this session if it leaked further.

---

## FIRST: land the ACL (this is why svc:wecrypto times out)

`PUT svc:wecrypto` and **Approve mauro** already returned 200. **POST ACL failed** — Windows converted HuJSON to a byte/object mess. WSL `curl` + `jq` must add:

1. Grant members/tags → `svc:wecrypto:443`
2. Grant members/tags → `192.168.18.0/24` (subnet-router path)
3. `autoApprovers.routes["192.168.18.0/24"]` = `tag:core`, `tag:trading`, `autogroup:admin`
4. `autoApprovers.services["svc:wecrypto"]` = `tag:trading`, `tag:core`, `autogroup:admin`
5. `hosts.wecrypto-lan` / `hosts.mauro-eth` = `192.168.18.38`

```bash
cd /mnt/g/WECRYP
ETAG=$(curl -sS -D - -o /tmp/ts-acl.json \
  -H "Authorization: Bearer $TAILSCALE_API_KEY" \
  "https://api.tailscale.com/api/v2/tailnet/$TS_TAILNET/acl" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')

# Inspect /tmp/ts-acl.json (HuJSON). Edit with jq if it is strict JSON, or keep HuJSON and patch by hand.
# Then:
curl -sS -X POST \
  -H "Authorization: Bearer $TAILSCALE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "If-Match: $ETAG" \
  --data-binary @/tmp/ts-acl-next.json \
  "https://api.tailscale.com/api/v2/tailnet/$TS_TAILNET/acl"
```

Grant objects to merge (do not drop existing grants / app-connectors / ssh / nodeAttrs):

```json
{
  "src": ["autogroup:member", "tag:trading", "tag:core", "tag:research"],
  "dst": ["svc:wecrypto"],
  "ip": ["443"]
}
```

```json
{
  "src": ["autogroup:member", "tag:trading", "tag:core"],
  "dst": ["192.168.18.0/24"],
  "ip": ["*"]
}
```

Then:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 10 \
  https://wecrypto.prairiedog-godzilla.ts.net/
# expect 200 after ACL + Serve
```

Verify service + host:

```bash
curl -sS -H "Authorization: Bearer $TAILSCALE_API_KEY" \
  "https://api.tailscale.com/api/v2/tailnet/$TS_TAILNET/services/svc:wecrypto"
curl -sS -H "Authorization: Bearer $TAILSCALE_API_KEY" \
  "https://api.tailscale.com/api/v2/tailnet/$TS_TAILNET/services/svc:wecrypto/devices"
# host nSfuckSm9q11CNTRL approvalLevel already approved:manual
```

---

## Subnet router (brother’s laptop → mauro)

**Intent:** other tailnet devices reach the house LAN / WeCrypto Ethernet IP the same way `g-lap` used to.

| Device | nodeId | Routes now |
|--------|--------|------------|
| **mauro** (do this) | `nSfuckSm9q11CNTRL` | API reports **advertised+enabled `192.168.18.0/24`** |
| g-lap | `niuRoGmGyR11CNTRL` | offline, none |
| g-lap-1 | `ndbmQSSys611CNTRL` | offline, none (`tag:research,tag:sensitive`) |

If Windows `AdvertiseRoutes` looks empty after a reboot:

```bash
# from Windows or powershell.exe
tailscale set --advertise-routes=192.168.18.0/24
curl -sS -X POST -H "Authorization: Bearer $TAILSCALE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"routes":["192.168.18.0/24"]}' \
  "https://api.tailscale.com/api/v2/device/$TS_MAURO/routes"
```

**Do not** advertise `0.0.0.0/0` on mauro (that is an exit node; Mullvad already is).  
Existing ACL `autoApprovers.routes["0.0.0.0/24"]` is leftover junk — leave or delete in the ACL edit; it is not a real LAN.

Serve still binds origin to **127.0.0.1:3450**. Subnet clients cannot hit loopback. Two ways in:

1. **Preferred:** `https://mauro.prairiedog-godzilla.ts.net/` or `https://wecrypto.prairiedog-godzilla.ts.net/` (Serve).
2. **LAN via subnet:** bind the web service to Ethernet as well:

```powershell
$env:WECRYPTO_WEB_HOST='192.168.18.38'   # or 0.0.0.0 if you accept LAN exposure
$env:WECRYPTO_WEB_PORT='3450'
```

Then `https://192.168.18.38:3450` from any node that accepts the `192.168.18.0/24` route (`tailscale set --accept-routes` on Linux clients < 1.94).

---

## WARP DNS-only + Tailscale (do not invert this)

```text
Internet traffic  →  Tailscale (mesh, optional Mullvad SE/CH exit)
DNS (when WARP Connected) →  Gateway DoH (mode doh, NO tunnel)
Local WeCrypto            →  127.0.0.1:3450
                             ↑ Tailscale Serve / svc:wecrypto
WARP include list         →  unused in doh mode (no traffic tunnel)
```

**Works**

```text
tailscale set --accept-dns=false
warp-cli mode doh
warp-cli connect          # only while Mullvad --exit-node is EMPTY
```

**Breaks (CF_DNS_LOOKUP_FAILURE)**

- `warp-cli mode warp+doh` (full tunnel) + Tailscale `RouteAll` / Mullvad exit
- Tailscale `CorpDNS=true` while WARP owns `127.0.2.2`
- Forcing `mode doh` while exit is on (DoH stays Unable)

**NRPT** (MagicDNS without CorpDNS): `.ts.net` → `100.100.100.100`  
Scripts: `/mnt/g/WECRYP/cloudflared/Apply-TailscaleWarpCoexist.ps1 -Action Overlay`  
Lanes: `Set-WeCryptoLanes.ps1` (`Fast` / `Sweden` / `Together`)  
Ethernet punch: `162.159.36/46/192/193/197/136-138` via gw `192.168.18.1`

Gateway nameservers already on the tailnet: `172.64.36.1`, `172.64.36.2` + IPv6. **Do not** add modem WAN `100.64.91.167` as a Gateway location.

---

## Split beacons (Ethernet vs poker Wi-Fi)

```powershell
# from G:\WECRYP, not System32
G:\WECRYP\cloudflared\Split-Beacons.ps1 -WifiProfile LeakSnipe
```

| Radio | MAC / BSSID | LAN | Metric | Role |
|-------|-------------|-----|--------|------|
| Ethernet | `7C-10-C9-44-08-23` | `192.168.18.38` | 10 | WARP + Tailscale `100.107.195.35` |
| Wi-Fi **LeakSnipe** | client `86-E3-90-99-F2-5C` AP `62:07:f8:49:59:9a` | `192.168.18.56` when up | 80 | poker / LeakSnipe |

Firewall (needs admin, already applied once): block `warp-svc.exe` + `tailscaled.exe` outbound on Wi-Fi; block UDP **41641** inbound on Wi-Fi.

Same `/24` as Ethernet today — queue split only, not a second WAN. Guest SSID on another subnet = real split.

Identities: `cloudflared/beacon-identities.json`.  
Gateway/Tailscale **cannot** match client MAC on the wire. Use `100.107.195.35` / `tag:trading` / public `64.25.2.144`.

---

## ASI1 (WeCrypto inference)

- Secrets (gitignored): `secrets/ASI1_GITGOIN.txt` (ultra works), `secrets/ASI1_MAURO.txt` (mini/asi1/fast; ultra 429). Skip dead `prompt_TEACHING`.
- Desk: `src/llm/asi1-desk-contract.js`, UI `src/ui/asi1-desk.js`, IPC `asi1:desk-*`.
- Modes: `asi1_only` / `dual_fire` / `planner` (planner never on 5m).
- Official models: `asi1-ultra`, `asi1`, `asi1-mini` (+ extra `asi1-fast`).
- gitgoin first. Same-account 429 does not retry sibling mauro keys.
- Probe: `asi1-mini` 200 when network works. `/v1/models` → 401 is fine.

---

## Cloudflare leftover

- Tunnel **wecrypto** `63000efe-b165-4240-b91a-3b5bade70180` → `https://127.0.0.1:3450` (`noTLSVerify`).
- `localhost.leaksnipe.win` is proxied anycast A+AAAA; local `~\.cloudflared\config.yml` lists it but the **service uses a token** — dashboard hostname required (blocked on expired `cfoat_`).
- Need a **dashboard API token** (not OAuth `cfoat_`) for DNS/ZT/WARP profile edits.

---

## WSL first-hour checklist

1. `cd /mnt/g/WECRYP && git status && git log -3 --oneline && git remote -v`
2. Export `TAILSCALE_API_KEY` from Windows User env (above).
3. **Patch ACL** and confirm `curl https://wecrypto.prairiedog-godzilla.ts.net/` = 200.
4. Confirm device routes: `GET /api/v2/device/nSfuckSm9q11CNTRL/routes` includes `192.168.18.0/24` enabled.
5. Decide WARP: if Sweden exit stays on, leave WARP disconnected; if you want Gateway DNS, drop `--exit-node=` then `warp-cli mode doh && warp-cli connect`.
6. Re-run Split-Beacons if poker Wi-Fi is APIPA.
7. Optional: bind origin to `192.168.18.38` for raw LAN via subnet router.
8. Rotate the Tailscale API key after the WSL session if it was pasted in chat.

---

## Do not

- Commit `.env`, `secrets/`, or `TAILSCALE_API_KEY`.
- `warp-cli mode warp+doh` while Mullvad exit / RouteAll is on.
- `tailscale up --accept-dns=true` while WARP DoH is trying to own `127.0.2.2`.
- `service install` another cloudflared token without uninstalling.
- Put `100.64.91.167` in Gateway locations or Tailscale ACL dst.
- Retag mauro casually (Mullvad + many tags already).
- Advertise `0.0.0.0/0` on mauro.

---

## Useful URLs

- Serve (works now): https://mauro.prairiedog-godzilla.ts.net/
- Service (ACL missing): https://wecrypto.prairiedog-godzilla.ts.net/
- Approve UI (already approved via API): https://login.tailscale.com/admin/services
- ACL UI fallback: https://login.tailscale.com/admin/acls
- Devices: https://login.tailscale.com/admin/machines/100.107.195.35
- PR: https://github.com/LeakSnipe/WE-CFM-Orchestrator/pull/2
