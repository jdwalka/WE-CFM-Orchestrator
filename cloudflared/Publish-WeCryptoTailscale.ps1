#Requires -Version 5.1
<#
.SYNOPSIS
  Publish WeCrypto on the Tailscale tailnet (Serve now, Service when tagged).

.DESCRIPTION
  mauro is a user-authenticated node, so Tailscale Services (svc:wecrypto)
  cannot host here — hosts must be tagged. This script always enables
  Tailscale Serve on the node MagicDNS name:

    https://mauro.prairiedog-godzilla.ts.net/  →  https://127.0.0.1:3450

  That is tailnet-only (not Funnel / not public). Cloudflare
  wecrypto.leaksnipe.win stays the public hostname.

  To get a stable svc:wecrypto VIP (wecrypto.<tailnet>.ts.net):
    1. Admin console → Services → Define a Service
       name wecrypto, endpoint tcp:443
    2. Tag a host (tag:trading or tag:core) — do not retag mauro
       unless you accept Mullvad/exit identity change
    3. On that tagged host, from the repo:
         tailscale serve set-config --all cloudflared\wecrypto-tailscale-serve.json
         tailscale serve advertise svc:wecrypto
    4. Approve the host on the Services page
    5. Grant: { "src": ["autogroup:member"], "dst": ["svc:wecrypto"], "ip": ["443"] }

.EXAMPLE
  .\cloudflared\Publish-WeCryptoTailscale.ps1
  .\cloudflared\Publish-WeCryptoTailscale.ps1 -Off
#>
param(
  [switch]$Off,
  [string]$Origin = 'https+insecure://127.0.0.1:3450',
  [string]$MagicHost = 'https://mauro.prairiedog-godzilla.ts.net/'
)

$ErrorActionPreference = 'Continue'

if ($Off) {
  Write-Host 'Disabling Tailscale Serve for WeCrypto'
  tailscale serve --https=443 off
  tailscale serve status
  return
}

$listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -eq 3450 }
if (-not $listening) {
  Write-Host 'WARNING: nothing on 127.0.0.1:3450 — start the WeCrypto web service first.'
  Write-Host '  $env:WECRYPTO_WEB_HOST=127.0.0.1; $env:WECRYPTO_WEB_PORT=3450'
  Write-Host '  node -e "require(''./electron/wecrypto-web-service'').startWebService(); setInterval(()=>{},6e5)"'
}

Write-Host "Publishing $Origin on tailnet HTTPS :443 (Serve, not Funnel)"
tailscale serve --bg --https=443 --yes $Origin
Write-Host ''
tailscale serve status
Write-Host ''
Write-Host 'Probe MagicDNS (tailnet only):'
& curl.exe -sS -o NUL -w "  $MagicHost  HTTP %{http_code} ssl=%{ssl_verify_result}`n" --max-time 15 $MagicHost

Write-Host ''
Write-Host 'svc:wecrypto: skipped on this node (service hosts must be tagged).'
Write-Host 'Define it at https://login.tailscale.com/admin/services then advertise from a tagged host using wecrypto-tailscale-serve.json'
