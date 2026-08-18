#Requires -Version 5.1
<#
.SYNOPSIS
  Publish WeCrypto on the Tailscale tailnet (Serve now, Service when tagged).

.DESCRIPTION
  mauro is tagged (core/trading/mullvad/…). Publishes:

    https://mauro.prairiedog-godzilla.ts.net/   node Serve
    https://wecrypto.prairiedog-godzilla.ts.net/  svc:wecrypto (needs admin Approve)

  Both proxy https://127.0.0.1:3450. Tailnet only (not Funnel).

  After advertise, open https://login.tailscale.com/admin/services → wecrypto → Approve.
  Grant if missing: { "src": ["autogroup:member"], "dst": ["svc:wecrypto"], "ip": ["443"] }

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
Write-Host 'Advertising svc:wecrypto on this tagged node'
tailscale serve --service=svc:wecrypto --https=443 --yes $Origin
Write-Host 'If it says approval required: https://login.tailscale.com/admin/services → Approve this host.'
tailscale serve get-config --all
