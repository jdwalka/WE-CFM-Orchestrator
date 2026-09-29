#Requires -Version 5.1
<#
.SYNOPSIS
  Wire Cloudflare Tunnel for wecrypto.leaksnipe.win → http://127.0.0.1:3450

.DESCRIPTION
  1) Opens browser login to Cloudflare (must pick the leaksnipe.win account/zone)
  2) Creates tunnel "wecrypto" if missing
  3) Writes %USERPROFILE%\.cloudflared\config.yml
  4) Routes DNS CNAME wecrypto.leaksnipe.win → tunnel
  5) Optionally installs Windows service

.NOTES
  Prerequisites:
  - cloudflared in PATH
  - WE-CRYPTO web service listening on 127.0.0.1:3450 (Electron app running)
  - Domain leaksnipe.win already in the Cloudflare account you log into
#>

$ErrorActionPreference = 'Stop'
$TunnelName = 'wecrypto'
$Hostname = 'wecrypto.leaksnipe.win'
# WE-CRYPTO Electron web service defaults to HTTPS on loopback (self-signed)
$Origin = 'https://127.0.0.1:3450'
$CfDir = Join-Path $env:USERPROFILE '.cloudflared'
$ConfigPath = Join-Path $CfDir 'config.yml'

New-Item -ItemType Directory -Force -Path $CfDir | Out-Null

Write-Host "==> 1/5 Login (browser) — select the Cloudflare account that owns leaksnipe.win" -ForegroundColor Cyan
cloudflared tunnel login
if (-not (Test-Path (Join-Path $CfDir 'cert.pem'))) {
  throw "Login did not produce cert.pem in $CfDir"
}

Write-Host "==> 2/5 Ensure tunnel exists: $TunnelName" -ForegroundColor Cyan
$list = cloudflared tunnel list 2>&1 | Out-String
if ($list -notmatch [regex]::Escape($TunnelName)) {
  cloudflared tunnel create $TunnelName
} else {
  Write-Host "    Tunnel already exists"
}

# Resolve UUID
$tunnelListJson = cloudflared tunnel list --output json 2>$null | Out-String
$uuid = $null
if ($tunnelListJson) {
  try {
    $arr = $tunnelListJson | ConvertFrom-Json
    $match = $arr | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
    if ($match) { $uuid = $match.id }
  } catch { }
}
if (-not $uuid) {
  # Fallback parse table output
  $line = (cloudflared tunnel list 2>&1 | Select-String -Pattern $TunnelName | Select-Object -First 1)
  if ($line -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
    $uuid = $Matches[1]
  }
}
if (-not $uuid) { throw "Could not resolve tunnel UUID for $TunnelName. Run: cloudflared tunnel list" }

$credFile = Join-Path $CfDir "$uuid.json"
if (-not (Test-Path $credFile)) {
  throw "Missing credentials file: $credFile (re-run tunnel create)"
}

Write-Host "==> 3/5 Write config.yml (origin $Origin)" -ForegroundColor Cyan
@"
tunnel: $uuid
credentials-file: $credFile
origincert: $(Join-Path $CfDir 'cert.pem')

ingress:
  - hostname: $Hostname
    service: $Origin
    originRequest:
      noTLSVerify: true
      connectTimeout: 30s
  - service: http_status:404
"@ | Set-Content -Path $ConfigPath -Encoding UTF8
Write-Host "    Wrote $ConfigPath"

Write-Host "==> 4/5 DNS route $Hostname → tunnel" -ForegroundColor Cyan
cloudflared tunnel route dns $TunnelName $Hostname
Write-Host "    CNAME should appear in Cloudflare DNS for leaksnipe.win (proxied)"

Write-Host "==> 5/5 Quick run (foreground). Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "    After it works, install as service:" -ForegroundColor Yellow
Write-Host "      cloudflared service install" -ForegroundColor Yellow
Write-Host "      net start cloudflared" -ForegroundColor Yellow
Write-Host ""
Write-Host "Public URL: https://$Hostname" -ForegroundColor Green
Write-Host "Local origin must stay up: $Origin (start Electron / WE-CRYPTO)" -ForegroundColor Green
Write-Host ""

# Probe origin
try {
  Invoke-WebRequest -Uri $Origin -UseBasicParsing -TimeoutSec 3 -SkipCertificateCheck | Out-Null
  Write-Host "Origin OK: $Origin" -ForegroundColor Green
} catch {
  # 404 still means TLS/TCP is up
  if ($_.Exception.Response) {
    Write-Host "Origin reachable: $Origin (HTTP $([int]$_.Exception.Response.StatusCode))" -ForegroundColor Green
  } else {
    Write-Host "WARNING: Origin not responding at $Origin — start WE-CRYPTO (Electron) first." -ForegroundColor Red
  }
}

cloudflared tunnel --config $ConfigPath run $TunnelName
