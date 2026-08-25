#Requires -Version 5.1
<#
.SYNOPSIS
  WeCrypto path control: Fast (Ethernet) vs Sweden (Tailscale Mullvad + SOCKS5).

.DESCRIPTION
  Do not stack WARP full-tunnel exclude-mode with Tailscale RouteAll.

  Fast:        Tailscale mesh, no exit. WARP stays on the Windows include profile
               (or DoH). Speedtest uses Ethernet. Public IP ~64.25.2.144.
  Sweden:      Tailscale exit se-sto-wg-209 (system-wide, ALL traffic incl.
               ASI1/api.asi1.ai routes through Stockholm) + Ethernet punch for
               WARP endpoints. WARP warp+doh on include-mode profile.
               Trading SOCKS5: 10.64.0.1:1080 (Mullvad in-tunnel, Sweden).
  SwedenSplit: Real split tunnel, no Cloudflare dependency. Same trading
               SOCKS5 as Sweden (routes exactly the electron/main.js
               WECRYPTO_SWEDEN_SOCKS needle list -- exchanges/Polymarket/etc,
               tuned over 2 months, NOT api.asi1.ai) but the Tailscale exit
               node is explicitly cleared, so everything NOT on that needle
               list (ASI1 included) goes out native Ethernet at full speed
               instead of taking a round trip through Stockholm it never
               needed. Use this instead of Sweden when trading -- Sweden
               only if you specifically need the whole box's default route
               (not just the needled domains) to egress from Sweden.
  WarpSweden:  Same as Sweden, then force warp+doh + Sweden vnet + reconnect.

.EXAMPLE
  .\Set-WeCryptoLanes.ps1 -Lane Status
  .\Set-WeCryptoLanes.ps1 -Lane Fast
  .\Set-WeCryptoLanes.ps1 -Lane Sweden
  .\Set-WeCryptoLanes.ps1 -Lane SwedenSplit
  .\Set-WeCryptoLanes.ps1 -Lane WarpSweden
#>
param(
  [ValidateSet('Status', 'Fast', 'Sweden', 'SwedenSplit', 'WarpSweden', 'Together')]
  [string]$Lane = 'Status',
  [string]$SwedenExit = 'se-sto-wg-209.mullvad.ts.net',
  [string]$SwedenVnet = 'bc743e42-bbf6-4506-b5b2-db7c12f573cc',
  [string]$Socks5 = '10.64.0.1:1080',
  [string]$EthernetGw = '192.168.18.1'
)

$ErrorActionPreference = 'Stop'
$warp = 'C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe'

function Get-PublicIp {
  param([string]$Socks)
  try {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) { return 'curl.exe missing' }
    $args = @('-4', '-sS', '--max-time', '8', 'https://ifconfig.co/json')
    if ($Socks) { $args = @('-sS', '--max-time', '8', '--socks5-hostname', $Socks, 'https://ifconfig.co/json') }
    $raw = & $curl.Source @args 2>$null
    if (-not $raw) { return 'empty' }
    $j = $raw | ConvertFrom-Json
    return "$($j.ip) $($j.country_iso) $($j.asn_org)"
  } catch { return $_.Exception.Message }
}

function Install-DirectHostPunch {
  param(
    [string]$Gateway,
    [string[]]$HostNames = @('api.asi1.ai')
  )
  if (-not $Gateway) { return }

  # Reconcile managed /32 direct-host routes before adding new resolutions:
  # Delete any stale /32 routes assigned to this gateway with metric 5 so IP changes don't leave permanent dead routes.
  Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.DestinationPrefix -match '/32$' -and
      $_.NextHop -eq $Gateway -and
      $_.RouteMetric -eq 5
    } |
    ForEach-Object {
      $staleIp = $_.DestinationPrefix -replace '/32$', ''
      cmd /c "route delete $staleIp >nul 2>&1" | Out-Null
    }

  $punched = @()
  foreach ($name in $HostNames) {
    $ips = @()
    try {
      $resolved = Resolve-DnsName -Name $name -Type A -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress }
      $ips = @($resolved | ForEach-Object { $_.IPAddress })
    } catch { }

    if (-not $ips -and $name -eq 'api.asi1.ai') { $ips = @('34.149.190.89') }
    foreach ($ip in $ips) {
      if ($ip -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        cmd /c "route add $ip mask 255.255.255.255 $Gateway metric 5 >nul 2>&1" | Out-Null
        $punched += ('{0}={1}' -f $name, $ip)
      }
    }
  }
  return $punched
}

function Install-WarpPunch {
  param([string]$Gateway)
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
    cmd /c "route -p add $($p.Dest) mask $($p.Mask) $Gateway metric 5 >nul 2>&1" | Out-Null
  }
  Install-DirectHostPunch -Gateway $Gateway | Out-Null
}

# ASI1 (api.asi1.ai) is not in electron/main.js's WECRYPTO_SWEDEN_SOCKS needle
# list and was never meant to go through the Mullvad exit -- but Tailscale has
# no native way to exempt one domain from an active exit node's 0.0.0.0/0
# route (confirmed against Tailscale's own open issues: mullvad/tailscale#11554
# says Mullvad's exit-node integration doesn't advertise its SOCKS5 proxy as a
# separable route, and tailscale/tailscale#7766 "bypass exit nodes for certain
# domains" is still open -- App Connectors, the closest official feature,
# require a publicly-reachable Linux node, not a fit here). A /32 host route
# via the LAN gateway wins over any 0.0.0.0/0 default route on prefix length
# alone, exit node or not -- same mechanism as Install-WarpPunch above, just
# resolved live instead of a fixed CIDR list since api.asi1.ai is a GCP LB IP
# behind fetch-ai.com, not a documented stable range.
#
# Verified 2026-08-22: 340ms+ (Stockholm-tunneled) -> 114.5ms with this route
# in place, exit node and Mullvad SOCKS5 both still up for everything else.
function Install-Asi1Punch {
  param([string]$Gateway)
  try {
    $ips = (Resolve-DnsName -Name api.asi1.ai -Type A -Server 1.1.1.1 -ErrorAction Stop |
      Where-Object { $_.Type -eq 'A' }).IPAddress
  } catch { $ips = $null }
  if (-not $ips) { $ips = @('34.149.190.89') } # last-known fallback if resolution fails
  foreach ($ip in $ips) {
    cmd /c "route -p add $ip mask 255.255.255.255 $Gateway metric 5 >nul 2>&1" | Out-Null
  }
  return $ips
}

function Start-TailscaleMesh {
  # `tailscale up` with extra flags requires restating every pref. UNC cwd
  # (WSL) also breaks cmd.exe. Flip WantRunning from a local path.
  Push-Location $env:TEMP
  try { cmd /c "tailscale up >nul 2>&1" | Out-Null }
  finally { Pop-Location }
}

function Set-WarpMode {
  param([string]$Mode)
  if (-not (Test-Path $warp)) { return }
  & $warp mode $Mode | Out-Null
}

function Restart-Warp {
  if (-not (Test-Path $warp)) { return }
  & $warp disconnect | Out-Null
  Start-Sleep -Seconds 2
  & $warp connect | Out-Null
}

function Set-SwedenSocksEnv {
  param([string]$Value)
  [Environment]::SetEnvironmentVariable('WECRYPTO_SWEDEN_SOCKS', $Value, 'User')
  if ($Value) { $env:WECRYPTO_SWEDEN_SOCKS = $Value }
  else { Remove-Item Env:WECRYPTO_SWEDEN_SOCKS -ErrorAction SilentlyContinue }
}

function Show-Status {
  Write-Host '== WARP =='
  if (Test-Path $warp) {
    & $warp status
    & $warp settings 2>$null | Select-String -Pattern 'Mode:|Profile ID|Exclude mode|Include mode|Organization'
    Write-Host '== WARP vnet =='
    & $warp vnet
  } else { Write-Host '  warp-cli missing' }

  Write-Host '== Tailscale =='
  tailscale debug prefs 2>&1 | Select-String -Pattern 'ExitNode|RouteAll|WantRunning|CorpDNS'
  Write-Host '== default IPv4 routes =='
  Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
    Format-Table DestinationPrefix, NextHop, InterfaceAlias, RouteMetric -AutoSize
  Write-Host '== WARP Ethernet punch =='
  Get-NetRoute -AddressFamily IPv4 |
    Where-Object { $_.DestinationPrefix -match '^162\.159\.(192|193|197|36|46)\.0/24$' -and $_.NextHop -eq $EthernetGw } |
    Format-Table DestinationPrefix, NextHop, InterfaceAlias, RouteMetric -AutoSize
  Write-Host '== Direct host Ethernet punch =='
  Get-NetRoute -AddressFamily IPv4 |
    Where-Object { $_.DestinationPrefix -match '/32$' -and $_.NextHop -eq $EthernetGw -and $_.RouteMetric -eq 5 } |
    Format-Table DestinationPrefix, NextHop, InterfaceAlias, RouteMetric -AutoSize
  Write-Host '== SOCKS5 =='
  $tcp = Test-NetConnection -ComputerName ($Socks5.Split(':')[0]) -Port 1080 -WarningAction SilentlyContinue
  Write-Host ("  {0} reachable={1}" -f $Socks5, [bool]$tcp.TcpTestSucceeded)
  Write-Host '== public IP (direct) =='
  Write-Host ('  ' + (Get-PublicIp))
  Write-Host '== public IP (SOCKS5) =='
  Write-Host ('  ' + (Get-PublicIp -Socks $Socks5))
}

switch ($Lane) {
  'Fast' {
    Write-Host 'Lane Fast: mesh only, no exit, Ethernet punch, WARP include/DoH'
    Install-WarpPunch -Gateway $EthernetGw
    Start-TailscaleMesh
    tailscale set --exit-node=
    Set-SwedenSocksEnv -Value ''
    Set-WarpMode -Mode doh
    Start-Sleep -Seconds 2
    Show-Status
    Write-Host 'Expect ~line-rate Ethernet, IP 64.25.2.144. Trading is NOT Sweden until -Lane Sweden.'
  }
  'Sweden' {
    Write-Host "Lane Sweden: Tailscale $SwedenExit + SOCKS5 $Socks5 + Ethernet punch. No Cloudflare/WARP -- Tailscale + Mullvad only, WARP drops too often to depend on for live trading."
    Install-WarpPunch -Gateway $EthernetGw
    Start-TailscaleMesh
    tailscale set --exit-node=$SwedenExit --exit-node-allow-lan-access=true
    Set-SwedenSocksEnv -Value ("socks5://{0}" -f $Socks5)
    $asi1Ips = Install-Asi1Punch -Gateway $EthernetGw
    Start-Sleep -Seconds 3
    Show-Status
    Write-Host "ASI1 punched direct via Ethernet: $($asi1Ips -join ', ') -- api.asi1.ai stays off the Stockholm exit even though everything else is on it."
    Write-Host 'Expect ~500 Mbps, source 170.62.100.238 / SOCKS5 Stockholm. Include profile must be active on this box.'
  }
  'SwedenSplit' {
    Write-Host "Lane SwedenSplit: SOCKS5 $Socks5 for the needled domains only (see electron/main.js WECRYPTO_SWEDEN_SOCKS list), Tailscale exit node explicitly cleared so everything else -- ASI1 included -- goes native Ethernet."
    Install-WarpPunch -Gateway $EthernetGw
    Start-TailscaleMesh
    # Deliberately NOT setting --exit-node here, unlike Sweden/WarpSweden --
    # that's the whole point: stop forcing the box's default route through
    # Stockholm for traffic the app-level SOCKS5 patch was never routing
    # there anyway (api.asi1.ai is not in the needle list in main.js).
    tailscale set --exit-node=
    Set-SwedenSocksEnv -Value ("socks5://{0}" -f $Socks5)
    if (Test-Path $warp) {
      & $warp mode doh | Out-Null
    }
    Start-Sleep -Seconds 3
    Show-Status
    Write-Host ''
    Write-Host 'CHECK THE "== SOCKS5 ==" LINE ABOVE.'
    Write-Host '  reachable=True  -> split worked: needled domains still hit Stockholm via SOCKS5, ASI1/everything else is native speed. This is the lane to trade on.'
    Write-Host '  reachable=False -> 10.64.0.1:1080 needs the Tailscale exit node up to exist at all (it may be an address only routable through that peer connection, not independently). If so, SwedenSplit cannot work as-is on this Mullvad/Tailscale setup -- fall back to -Lane Sweden (accepts ASI1 going through Stockholm too) until a non-Tailscale Mullvad tunnel is set up for the SOCKS5 leg.'
  }
  'Together' {
    Write-Host 'Lane Together/Overlay: WARP first (Ethernet punch), Tailscale DNS off, then Sweden exit on top.'
    Install-WarpPunch -Gateway $EthernetGw
    Push-Location $env:TEMP
    try { cmd /c "tailscale up --accept-dns=false >nul 2>&1" | Out-Null }
    finally { Pop-Location }
    tailscale set --accept-dns=false | Out-Null
    if (Test-Path $warp) {
      & $warp disconnect | Out-Null
      Start-Sleep -Seconds 2
      & $warp connect | Out-Null
    }
    tailscale set --exit-node-allow-lan-access=true | Out-Null
    $asi1Ips = Install-Asi1Punch -Gateway $EthernetGw
    Start-Sleep -Seconds 4
    Show-Status
    Write-Host "ASI1 punched direct via Ethernet: $($asi1Ips -join ', ')"
    Write-Host 'CF_DNS_LOOKUP_FAILURE fix: Tailscale CorpDNS must be false so WARP owns its local DNS proxy.'
    Write-Host 'Internet = Tailscale SE/CH exit. WARP include = exchanges only.'
  }
  'WarpSweden' {
    Write-Host "Lane WarpSweden: punch, Tailscale $SwedenExit, warp+doh, Sweden vnet, reconnect"
    Install-WarpPunch -Gateway $EthernetGw
    Start-TailscaleMesh
    tailscale set --exit-node=$SwedenExit --exit-node-allow-lan-access=true
    Set-SwedenSocksEnv -Value ("socks5://{0}" -f $Socks5)
    if (Test-Path $warp) {
      & $warp mode warp+doh | Out-Null
      & $warp vnet $SwedenVnet | Out-Null
      Restart-Warp
    }
    $asi1Ips = Install-Asi1Punch -Gateway $EthernetGw
    Start-Sleep -Seconds 4
    Show-Status
    Write-Host "ASI1 punched direct via Ethernet: $($asi1Ips -join ', ')"
    Write-Host 'WARP must show Profile ID of WeCrypto Windows include (not default) and Include mode.'
  }
  default { Show-Status }
}
