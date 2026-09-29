# HANDOFF — WeCrypto ASI1 HUD (2026-08-22 night)

**App tree:** `G:\wecryp` (same folder as `G:\WECRYP`).  
**Do not treat** `/home/mar/WE-CFM-Orchestrator` as what Electron loads.

Next agent: **read this before touching Tailscale, routes, or ASI1.**

---

## What the user wants

- HUD **fast** (they measured **9–14ms TCP** to `api.asi1.ai` / **~158ms** desk latency when it was good).
- ASI1 **not** through **Mullvad Sweden** exit.
- **One key: icloud** (`ASI1_API_KEY_ICLOUD` / `secrets/ASI1_ICLOUD.txt`). Not gitgoin. Not mauro.
- Regular LLM inference (query log ultra split) runs in a **second Electron** (`launch-inference.bat`). HUD uses `launch-hud.bat` with `WECRYPTO_SKIP_INFERENCE=1`.
- Router for ASI1 on **Windows**, not WSL.

---

## Why it kept breaking

| Action | HUD |
|---|---|
| `route add 34.149.190.89 … 192.168.18.1` then Electron `fetch` to `api.asi1.ai` | **`EACCES` ~20ms**. Tailscale RouteAll + Sweden exit blocks Windows sockets to that /32. |
| Remove the /32 | HUD **works** but goes **Sweden** (slow). Public IP ~`170.62.100.250`. |
| WSL python CONNECT on `:18080` | Mini OK; **ultra `UND_ERR_SOCKET` ~142s**. |
| Nothing on `:18080` while client defaults to that proxy | **`ECONNREFUSED` ~20ms**. |
| Walking gitgoin + 4 mauro keys × 4 models × 12–90s | **2–5 minutes**. |

**14ms TCP is real** from **WSL** when the /32 is on **Ethernet `192.168.18.38` ifIndex 17**, **not** on Tailscale `100.107.195.35`.

A /32 whose interface is `100.107.195.35` is **wrong** (Sweden NIC). Delete it.

---

## Intended path (off Sweden, no Electron EACCES)

```
Electron  →  127.0.0.1:18080   (Windows node CONNECT proxy)
proxy     →  src 192.168.18.38 → 34.149.190.89:443   (Ethernet /32)
```

- Proxy: `G:\wecryp\cloudflared\asi1-windows-proxy.js`
- Start: `G:\wecryp\cloudflared\start-asi1-windows-proxy.bat`  
  or `G:\wecryp\cloudflared\Fix-Asi1Hud.ps1`
- Client: `G:\wecryp\src\infra\asi1-client.js`  
  - **one icloud key**  
  - **one model** per call  
  - undici `ProxyAgent` → `http://127.0.0.1:18080`  
- `.env`: `WECRYPTO_DIRECT_PROXY=http://127.0.0.1:18080`  
  `WECRYPTO_SKIP_INFERENCE=1`  
  `ASI1_PREFERRED_ACCOUNT=icloud`

Electron must **restart** after client/env changes.

---

## Do not

- `route add 34.149.190.89` **without** the HUD using `:18080`. That is HUD `EACCES`.
- `POST /device/mauro/routes` with only `192.168.18.0/24` unless you mean to drop 689 Google connector prefixes.
- WSL python `direct-proxy.py` for ultra.
- `start "ASI1-Windows-Proxy" node …` — `start` eats the first quoted token as a window title → “Windows cannot find \asi1-windows proxy”. Use `Start-Process`.
- WARP. User is Tailscale-only. Disconnect WARP if it is up.
- Treat `origin` punch/DNS apply script as safe; it can wipe mauro enabled routes.

---

## Live box (when this was written)

- Tailscale: `RouteAll=true`, exit `se-sto-wg-209` / `nk3C3xRSyH11CNTRL`, `CorpDNS=true`, split DNS **on**, `asi1.ai` → 1.1.1.1 family.
- WARP: disconnected.
- Punch: may be present on Ethernet `192.168.18.38`. If HUD `EACCES`, **delete it**.
- Windows proxy: `node.exe` listen `127.0.0.1:18080`.
- ACL: grants/hosts intact; `home-direct` connector for `asi1.ai` + `fetch-ai.com` was added (tag:core).

---

## PowerShell — paste as-is

```powershell
# G:\wecryp ASI1 HUD — run as the Windows user that runs Electron
Set-Location G:\wecryp
$ErrorActionPreference = 'Continue'

# 1) Pin icloud + local proxy (User env)
[Environment]::SetEnvironmentVariable('ASI1_PREFERRED_ACCOUNT','icloud','User')
[Environment]::SetEnvironmentVariable('WECRYPTO_DIRECT_PROXY','http://127.0.0.1:18080','User')
$env:ASI1_PREFERRED_ACCOUNT = 'icloud'
$env:WECRYPTO_DIRECT_PROXY  = 'http://127.0.0.1:18080'
$env:WECRYPTO_SKIP_INFERENCE = '1'

# 2) Ethernet punch (only if HUD uses 127.0.0.1:18080 — never raw fetch to api.asi1.ai)
$if = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq '192.168.18.38' }).InterfaceIndex
if (-not $if) { $if = 17 }
cmd /c "route delete 34.149.190.89 >nul 2>&1"
cmd /c "route -p add 34.149.190.89 mask 255.255.255.255 192.168.18.1 metric 5 if $if"
route print -4 | findstr 34.149
# MUST show next hop 192.168.18.1 and interface 192.168.18.38 — NOT 100.107.195.35

# 3) Windows CONNECT proxy
$node = 'C:\Program Files\nodejs\node.exe'
$js   = 'G:\wecryp\cloudflared\asi1-windows-proxy.js'
Get-NetTCPConnection -LocalPort 18080 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Start-Process -FilePath $node -ArgumentList $js -WorkingDirectory 'G:\wecryp\cloudflared' -WindowStyle Minimized
Start-Sleep -Seconds 1
netstat -ano | Select-String '127.0.0.1:18080.+LISTENING'

# 4) Probe (401 = path OK)
try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 -Proxy http://127.0.0.1:18080 https://api.asi1.ai/v1/models | Out-Null } catch { "proxy HTTP $($_.Exception.Response.StatusCode.value__)" }

Write-Host 'Restart Electron from G:\wecryp  (npx electron .)'
Write-Host 'If HUD EACCES: route delete 34.149.190.89'
Write-Host 'If HUD ECONNREFUSED: proxy is down — rerun step 3'
```

Saved copy: `G:\wecryp\cloudflared\Fix-Asi1Hud.ps1` (older; punch-delete oriented). Prefer the block above.

---

## If HUD is EACCES right now

```powershell
route delete 34.149.190.89
```

HUD will work on Sweden until proxy+punch+restart are all true together.

---

## PR note

Open: https://github.com/JohnDaWalka/WE-CFM-Orchestrator/pull/107  
Do **not** merge blindly. `#106` SwedenSplit is superseded. Apply script `POST device/.../routes` with only LAN **drops** Google connector prefixes.
