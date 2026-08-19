#Requires -Version 5.1
<#
.SYNOPSIS
  Make Cloudflare WARP and Tailscale run together (split tunnel, no 0.0.0.0/0 fight).

.DESCRIPTION
  WARP exclude-all + Tailscale RouteAll both claim the default route and DNS.
  This script:
    - Punches Ethernet routes for WARP anycast so the tunnel can stay up
    - Forces WARP include / DoH (never full-tunnel exclude)
    - Keeps Tailscale WantRunning (mesh) and optional Sweden exit + LAN access
    - Optionally pushes tailnet DNS to Cloudflare Gateway via Tailscale API

  Secrets (env only, never commit):
    TAILSCALE_API_KEY or TS_API_KEY   tskey-api-...
    TAILSCALE_TAILNET                 default prairiedog-godzilla.ts.net
    CLOUDFLARE_API_TOKEN              only if you also run apply-sweden-egress.ps1

.EXAMPLE
  $env:TAILSCALE_API_KEY = 'tskey-api-...'
  .\Apply-TailscaleWarpCoexist.ps1 -Action Status
  .\Apply-TailscaleWarpCoexist.ps1 -Action Together
  .\Apply-TailscaleWarpCoexist.ps1 -Action PushDns
#>
param(
  [ValidateSet('Status', 'Together', 'PushDns')]
  [string]$Action = 'Status',
  [string]$SwedenExit = 'se-sto-wg-209.mullvad.ts.net',
  [string]$SwedenVnet = 'bc743e42-bbf6-4506-b5b2-db7c12f573cc',
  [string]$EthernetGw = '192.168.18.1',
  [string]$Tailnet = $(if ($env:TAILSCALE_TAILNET) { $env:TAILSCALE_TAILNET } else { 'prairiedog-godzilla.ts.net' }),
  [string]$LocalHostName = 'localhost.leaksnipe.win'
)

$ErrorActionPreference = 'Stop'
$warp = 'C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe'
$GatewayNs = @('172.64.36.1', '172.64.36.2')

function Get-TsApiKey {
  $k = [string]($env:TAILSCALE_API_KEY + $env:TS_API_KEY)
  return $k.Trim()
}

function Invoke-TailscaleApi {
  param([string]$Method = 'GET', [string]$Path, [object]$Body)
  $key = Get-TsApiKey
  if (-not $key) { throw 'Set TAILSCALE_API_KEY (or TS_API_KEY) in the environment. Do not commit it.' }
  $headers = @{ Authorization = "Bearer $key" }
  $uri = "https://api.tailscale.com/api/v2$Path"
  $params = @{ Method = $Method; Uri = $uri; Headers = $headers }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Compress -Depth 6)
  }
  return Invoke-RestMethod @params
}

function Install-WarpPunch {
  $prefixes = @(
    @{ Dest = '162.159.193.0'; Mask = '255.255.255.0' },
    @{ Dest = '162.159.197.0'; Mask = '255.255.255.0' },
    @{ Dest = '162.159.192.0'; Mask = '255.255.255.0' },
    @{ Dest = '162.159.136.0'; Mask = '255.255.255.0' },
    @{ Dest = '162.159.137.0'; Mask = '255.255.255.0' },
    @{ Dest = '162.159.138.0'; Mask = '255.255.255.0' },
    @{ Dest = '162.159.36.0';  Mask = '255.255.255.0' },
    @{ Dest = '162.159.46.0';  Mask = '255.255.255.0' }
  )
  foreach ($p in $prefixes) {
    cmd /c "route -p add $($p.Dest) mask $($p.Mask) $EthernetGw metric 5 >nul 2>&1" | Out-Null
  }
}

function Start-TailscaleMesh {
  Push-Location $env:TEMP
  try { cmd /c "tailscale up --accept-dns=false >nul 2>&1" | Out-Null }
  finally { Pop-Location }
}

function Show-LocalHostDns {
  Write-Host "== $LocalHostName =="
  try {
    $rows = Resolve-DnsName $LocalHostName -ErrorAction Stop
    $rows | ForEach-Object {
      if ($_.Type -eq 'AAAA') { Write-Host ("  AAAA {0}" -f $_.IPAddress) }
      elseif ($_.Type -eq 'A') { Write-Host ("  A    {0}" -f $_.IPAddress) }
    }
    $aaaa = @($rows | Where-Object { $_.Type -eq 'AAAA' })
    if ($aaaa.Count -gt 0) {
      Write-Host '  note: AAAA is on Cloudflare anycast (proxied). Origin still needs the wecrypto tunnel to 127.0.0.1.'
    }
  } catch {
    Write-Host ("  resolve failed: {0}" -f $_.Exception.Message)
  }
}

function Show-Status {
  Write-Host '== WARP =='
  if (Test-Path $warp) {
    & $warp status
    & $warp settings 2>$null | Select-String -Pattern 'Mode:|Profile ID|Exclude mode|Include mode|Organization'
  } else { Write-Host '  warp-cli missing' }

  Write-Host '== Tailscale =='
  tailscale debug prefs 2>&1 | Select-String -Pattern 'ExitNode|RouteAll|WantRunning|CorpDNS|ExitNodeAllowLAN'
  Write-Host '== default IPv4 routes =='
  Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Format-Table DestinationPrefix, NextHop, InterfaceAlias, RouteMetric -AutoSize
  Show-LocalHostDns
  if (Get-TsApiKey) {
    try {
      $ns = Invoke-TailscaleApi -Path "/tailnet/$Tailnet/dns/nameservers"
      Write-Host '== Tailnet DNS (API) =='
      Write-Host ('  ' + (($ns.dns -join ', ')))
    } catch {
      Write-Host ("  tailnet DNS API: {0}" -f $_.Exception.Message)
    }
  } else {
    Write-Host '== Tailnet DNS (API) =='
    Write-Host '  skipped (TAILSCALE_API_KEY not set in this shell)'
  }
}

switch ($Action) {
  'PushDns' {
    $resp = Invoke-TailscaleApi -Method POST -Path "/tailnet/$Tailnet/dns/nameservers" -Body @{ dns = $GatewayNs }
    Write-Host ('Pushed Gateway nameservers: ' + (($resp.dns -join ', ')))
    Write-Host 'Then on this box: tailscale set --accept-dns=true  AND  warp-cli mode doh'
  }
  'Together' {
    Write-Host 'Lane Together: WARP include/DoH + Tailscale mesh + Ethernet punch. No exclude-all.'
    Install-WarpPunch
    Start-TailscaleMesh
    if (Test-Path $warp) {
      & $warp mode doh | Out-Null
    }
    tailscale set --exit-node-allow-lan-access=true | Out-Null
    Show-Status
    Write-Host 'Do not enable WARP exclude-all while Tailscale RouteAll is on.'
    Write-Host 'Sweden source IP: .\Set-WeCryptoLanes.ps1 -Lane Sweden (exit node + SOCKS5).'
  }
  default { Show-Status }
}
