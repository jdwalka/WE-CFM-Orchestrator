# Handoff — WeCrypto Cloudflare / Tailscale / WSL

**Date:** 2026-08-16  
**Continue in:** WSL, repo `G:\WECRYP` (Windows) = `/mnt/g/WECRYP` (WSL)  
**Account:** `f226035af09775dbffd7e6350adc8a12` (Gitgoin87 / leaksnipe org)  
**Zone:** `leaksnipe.win` (`555da76dd9b791fdb1e6ff8e33c88e5d`)

Do **not** put API tokens or tunnel install tokens in git. Rotate the Cloudflare user token that was pasted in chat (`cfut_…`).

---

## What we were doing

Make WeCrypto fast **and** keep a Sweden source IP for trading, without stacking WARP tunnel + Tailscale exit (that made WARP “Network: unstable”). Then fix DEGRADED feeds once WARP **traffic** was on (egress showed Cloudflare IPv6 `2a09:bac1:…`, Boston / AS13335).

User LAN: **`192.168.18.38/24`** (Ethernet, gw `192.168.18.1`). Public home IP when Fast lane: `64.25.2.144`. Mullvad Sweden via Tailscale: `170.62.100.238` / `2a02:6ea0:1508:9::e02f`.

---

## Live topology (do not mix)

| Piece | ID / name | Role |
|--------|-----------|------|
| Tailscale mesh | `prairiedog-godzilla.ts.net` | Keep ON |
| Tailscale exit | `se-sto-wg-209.mullvad.ts.net` | Sweden source IP; owns `0.0.0.0/0` when enabled |
| WARP org | `leaksnipe` | Windows: profile **WeCrypto Windows include** `56ba0668-…`. iPhone: **default** |
| WARP vnets | `Tailscale SWEDEN` `bc743e42-bbf6-4506-b5b2-db7c12f573cc` · `default` `5f6452da-c317-45dd-bd40-fa2190fa3b1c` | Sweden vnet unused unless WARP **tunnel** is up |
| Tunnel **wecrypto** | `63000efe-b165-4240-b91a-3b5bade70180` | Windows service `Cloudflared` (Automatic). Origin `https://127.0.0.1:3450` |
| Tunnel **Leak-Snipe** | `22614792-3a57-48fd-8b58-824b3f3be69b` | Second process `--token-file C:\ProgramData\cloudflared\token.leaksnipe.bak`. Origin `http://127.0.0.1:8765` (`db.leaksnipe.win`) |
| Published host | `wecrypto.leaksnipe.win` | wecrypto tunnel |
| Published host | `db.leaksnipe.win` | Leak-Snipe only (sidecar). Do not steal this. |

This Windows node is **`mauro.prairiedog-godzilla.ts.net`** (`100.107.195.35`).

**Lanes** (`G:\WECRYP\cloudflared\Set-WeCryptoLanes.ps1`):

```powershell
# Windows
.\cloudflared\Set-WeCryptoLanes.ps1 -Lane Status
.\cloudflared\Set-WeCryptoLanes.ps1 -Lane Fast        # no exit, Ethernet ~1 Gbps, IP 64.25.2.144
.\cloudflared\Set-WeCryptoLanes.ps1 -Lane Sweden      # Tailscale exit + SOCKS5 10.64.0.1:1080
.\cloudflared\Set-WeCryptoLanes.ps1 -Lane WarpSweden  # Sweden + warp+doh reconnect
```

- **Fast:** Tailscale mesh, no exit. WARP include/DoH. Public IP `64.25.2.144`.
- **Sweden:** Tailscale exit `se-sto-wg-209` + Ethernet punch + Mullvad SOCKS5 `10.64.0.1:1080` (Stockholm). Sets user env `WECRYPTO_SWEDEN_SOCKS`.
- **Do not** stack WARP **exclude-all** with Tailscale `RouteAll`. Include-mode is required.
- Mullvad public SOCKS5 hostnames (`se-sto-wg-socks5-*.relays.mullvad.net:1080`) only accept clients already on Mullvad. Inventory: `cloudflared/mullvad-stockholm-relays.json`.

---

## Cloudflare One — already applied

### Device profiles

| Profile | ID | Match | Split | Mode |
|---------|----|-------|-------|------|
| **WeCrypto Windows include** | `56ba0668-183e-491c-840d-254c0e075e9f` | `os.name == "windows"` (prec 50) | **Include** `172.64.128.0/20` + `2606:4700:0cf1:4000::/64` + exchange FQDNs | `warp` |
| **default** (iPhone / fallback) | `019b5b9f-93bc-7369-9cbd-8880a7b1e59a` | — | Exclude Tailscale + RFC1918 | **`1dot1`** |

Windows box must show `Profile ID: 56ba0668-…` and **Include mode**. `warp-cli mode warp` returns “Invalid setting for this account type”; leave the local override `WarpWithDnsOverHttps`.

Persistent Ethernet punch (gw `192.168.18.1`): `162.159.192/193/197/136/137/138/36/46.0/24`.

### Gateway lists / egress

- List `wecrypto-exchanges` `ad915de6-514f-4f10-9be3-24899ae06d9e` (~31 domains: CEX + Pyth + Polymarket WS + Etherscan/Ripple).
- Egress: WeCrypto FQDN list (prec 1700) → Sweden vnet (1800) → default vnet (1971) → CF catch-all (32000).
- **No dedicated Stockholm IPv4** on this account (POST 2055). CF cannot SNAT Mullvad IPs.

### The rule that broke feeds

`Block Malicious Traffic on All Ports` (`4a4cd57d-cf78-408c-9a45-a4f040a39009`, prec **62673**):

```
l4: detected_protocol in {http,http2,tls,...}
and not(proxy.endpoint == "19itm901rl.proxy.cloudflare-gateway.com")
and not(net.dst.geo.continent in {"NA"})
```

Identity-scoped to family emails. Blocks TLS to non-NA (Kraken/Gate/DexScreener/Ripple/many CDNs).

**Mitigations already in:**

| Rule | ID | Prec | What |
|------|-----|------|------|
| Allow Tailscale Sweden to Cloudflare IP Range | `089736f2-61b4-4342-91bf-e1e992e815ee` | **62000** | Full CF IPv4+IPv6 anycast (was only `173.245.49–59/24`) + `net.vnet_id == Sweden` |
| Allow WeCrypto exchanges L4 | `02b8693a-102c-4482-a71d-9d8ddafbd886` | **62010** | `any(net.sni.domains[*] in $ad915de6-…)` |

### Hostname routes (public FQDN → tunnel)

**All trading/feed hostnames → tunnel `wecrypto`.**  
**Leak-Snipe keeps only `localhost` (sidecar).**  
`wecrypto.leaksnipe.win` already on wecrypto.

Moved 28 + added Pyth/Etherscan/Ripple/xrplcluster. If a new feed host is added to the app, also:

1. Append to Gateway list `ad915de6-…`
2. `POST /accounts/$acct/zerotrust/routes/hostname` `{ hostname, tunnel_id: wecrypto }`

### CIDR / teamnet routes

- Deleted wrong **`192.168.1.0/24`**.
- Added **`192.168.18.0/24`** (host `.38`) on **both** vnets, tunnel **wecrypto**.
- Other Leak-Snipe CIDRs (Tailscale IPv6 hosts, `127.0.0.1`, `198.41.192.77` WSL) still on Leak-Snipe — decide in WSL whether those should move too.

### Gateway locations

| Name | ID | Networks | DoH | Role |
|------|-----|----------|-----|------|
| **TAILSCALE SWEDEN** (client default) | `117fc890e46d4d84b9f3aff5856b8996` | `170.62.100.238/32` + IPv6 `2a02:6ea0:1508:9::e02f/128` | `mokbrpzbx4` | Mullvad exit DNS |
| WARP Cloudflare egress | `85e2e69c77b04bcaa5d9233af067b2d7` | `104.28.213.35/32` | `ogedujzxu8` | WARP full-tunnel egress (US CF, **not** Sweden) |
| 233 Roseville | `a811e380a909457bbc58db17c11aef3a` | `64.25.2.144/32` | `tyakhiwkn2` | Fast Ethernet (live) |
| 233 Roseville .191 | `accea4a1aeac47b7a0b2f9b2bf5590af` | `64.25.2.191/32` | `qv4pnqshuo` | older home IP |
| Tailscale-CANADA | `4b53a97b8c114bdf83d2ef37a539a09a` | `23.234.121.87/32` | `0e6dbb5ktr` | unused here |

IPv4 resolvers on all of them: `172.64.36.1` / `172.64.36.2`.

CDN/zone **Pro** is not the same limiter as Gateway. Entitlement `swg.large_network_limit = 0` — the API still says “Free plan accounts cannot specify more than one source network on their IPv4 locations.” Workaround: one IPv4 `/32` per location (you can have many locations; `swg.location_limit = 50`). `.144` stays on 233 Roseville; `.191` is its own location if still in use.

DoH Sweden (Mullvad): `https://mokbrpzbx4.cloudflare-gateway.com/dns-query`  
DoH WARP egress: `https://ogedujzxu8.cloudflare-gateway.com/dns-query`

---

## cloudflared on Windows (service)

```
Service Cloudflared  Automatic  Running
  "…\cloudflared.exe" tunnel run --token-file C:\ProgramData\cloudflared\token
  token payload t=63000efe-…  (wecrypto)

Leak-Snipe extra process:
  cloudflared tunnel run --token-file C:\ProgramData\cloudflared\token.leaksnipe.bak
```

User pasted `cloudflared.exe service install <eyJ…>` (wecrypto). First install raced; second succeeded. Do not `service install` again without `service uninstall` or it no-ops.

In WSL you can inspect but **cannot** manage the Windows service. Use PowerShell for service / `Set-WeCryptoLanes.ps1`.

---

## WARP + Tailscale + SOCKS5 (current)

**Applied on mauro:** include profile + Ethernet punch + Sweden SOCKS5 hook in `electron/main.js` (`WECRYPTO_SWEDEN_SOCKS`).

**Working combo:** Tailscale exit ON (`WantRunning` must stay true) + SOCKS5 `10.64.0.1:1080` → Stockholm `2a02:6ea0:1508:9::d001`. WARP include-mode Connected/healthy after a reconnect. Tailscale `WantRunning` flaps to false if you only `tailscale set --exit-node=…` — use `tailscale up` from a local path (`C:\Windows\Temp`), not a WSL UNC cwd.

**Still true:** exclude-mode `warp+doh` + Tailscale `RouteAll` fights `0.0.0.0/0`. Include-mode is the fix.

### Cloudflare DNS on Tailscale (do this — it replaces WARP DNS)

WARP + Tailscale both trying to own system DNS is why they still fail together. Drop DNS onto Gateway **through Tailscale** and leave WARP as DoH-only (or off).

**Tailscale admin → DNS** (https://login.tailscale.com/admin/dns)

| Field | Put this | Remove |
|-------|----------|--------|
| Global nameservers | `172.64.36.1` and `172.64.36.2` | `194.242.2.2`, `2a07:e340::2`, `170.62.100.238` |
| Override DNS servers | **On** (forces the tailnet onto Gateway) | — |
| MagicDNS | **On** (`prairiedog-godzilla.ts.net`) | — |
| Split DNS | leave `ts.net` → Tailscale | do not add a split for the whole internet |

Those two IPv4s are **Cloudflare Gateway**, not public `1.1.1.1`. Do not paste a DoH URL — Tailscale only takes IPs.

Then on **mauro**:

```powershell
tailscale set --accept-dns=true
& 'C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe' mode doh
```

Query source IP picks the Gateway location automatically:

- Sweden exit on → `170.62.100.238` → **TAILSCALE SWEDEN** (`mokbrpzbx4`)
- Fast / no exit → `64.25.2.144` → **233 Roseville** (`tyakhiwkn2`)

Do **not** turn accept-dns on until the admin nameservers are Gateway. Today the tailnet still advertises Mullvad DNS, which only answers from a Mullvad hop.

API token for Zero Trust: set `CLOUDFLARE_API_TOKEN` in the WSL session (do not commit). Script: `cloudflared/apply-sweden-egress.ps1` (Windows). From WSL use `curl` to `https://api.cloudflare.com/client/v4/accounts/$ACCT/...`.

---

## WeCrypto app health (last UI dump)

**CORE healthy:** Crypto.com, Polymarket, ProxyOrchestrator, Pyth.  
**Often DEGRADED after WARP traffic:** Coinbase, DexScreener, Etherscan, s1/s2.ripple.com, xrplcluster (continent block + DNS).  
**UNKNOWN / standby:** Binance, Bybit, Gate, Hyperliquid, Kraken, KuCoin, OKX (many are optional standby, not necessarily down).  
**Healthy OPT:** Alchemy, CMC, Gemini, LocalProxy, Solana RPC, Whale Alert, …

Code: `src/infra/network-log.js` (bucket names), `src/infra/proxy-fetch.js`, `electron/main.js` host lists.

If a feed is still DEGRADED after policy refresh (~30s):

```bash
# WSL
dig api.kraken.com
curl -sI --max-time 10 https://api.dexscreener.com
curl -sI --max-time 10 https://api.kraken.com/0/public/Time
```

Then confirm the SNI is on list `ad915de6-…` and a hostname route exists on tunnel `wecrypto`.

---

## LeakSnipe MCP (other thread, already shipped)

Repo: `G:\LeakSnipe` / org `LeakSnipe/Leak-Snipe-Beta-DEV` branch `feature/action-debug-cloudflare`.  
Worker `leaksnipe` deployed (route PATCH still fights `leaksnipe-data-api`; script upload is live).  
`get_hand` + `streets_narrative` on `https://worker.leaksnipe.win/mcp`.  
`repair_actions_from_raw` backfill may still be running (`G:\LeakSnipe\cloudflared\action-backfill.log`).  
Do not point `mcp.leaksnipe.win` at a tunnel — Worker owns MCP.

---

## First commands in WSL

```bash
cd /mnt/g/WECRYP
# status from Windows tools if interop works:
powershell.exe -NoProfile -File 'G:\WECRYP\cloudflared\Set-WeCryptoLanes.ps1' -Lane Status

curl -sS https://wecrypto.leaksnipe.win/ -o /dev/null -w '%{http_code}\n'
curl -sS https://db.leaksnipe.win/health

# Zero Trust (export token first)
export CLOUDFLARE_API_TOKEN=...
ACCT=f226035af09775dbffd7e6350adc8a12
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/zerotrust/routes/hostname" \
  | jq '.result[] | {hostname,tunnel_name}'
```

Next work: change Tailscale admin nameservers from Mullvad `194.242.2.2` to Gateway `172.64.36.1`/`172.64.36.2` (do not enable accept-dns on mauro while WARP DoH is on). Keep Tailscale `WantRunning` true when using SOCKS5. Do not `service install` another cloudflared token without uninstalling first.
