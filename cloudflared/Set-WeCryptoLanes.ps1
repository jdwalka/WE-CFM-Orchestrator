#Requires -Version 5.1
<#
.SYNOPSIS
  WeCrypto path control: Fast (Ethernet) vs Sweden (Tailscale Mullvad + SOCKS5).

.DESCRIPTION
  Do not stack WARP full-tunnel exclude-mode with Tailscale RouteAll.

  Fast:       Tailscale mesh, no exit. WARP stays on the Windows include profile
              (or DoH). Speedtest uses Ethernet. Public IP ~64.25.2.144.
  Sweden:     Tailscale exit se-sto-wg-209 + Ethernet punch for WARP endpoints.
              WARP warp+doh on include-mode profile (not 0.0.0.0/0).
              Trading SOCKS5: 10.64.0.1:1080 (Mullvad in-tunnel, Sweden).
  WarpSweden: Same as Sweden, then force warp+doh + Sweden vnet + reconnect.

.EXAMPLE
  .\Set-WeCryptoLanes.ps1 -Lane Status
  .\Set-WeCryptoLanes.ps1 -Lane Fast
  .\Set-WeCryptoLanes.ps1 -Lane Sweden
  .\Set-WeCryptoLanes.ps1 -Lane WarpSweden
#>
param(
  [ValidateSet('Status', 'Fast', 'Sweden', 'WarpSweden', 'Together')]
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
    Write-Host "Lane Sweden: Tailscale $SwedenExit + SOCKS5 $Socks5 + Ethernet punch. WARP stays include (not exclude-all)."
    Install-WarpPunch -Gateway $EthernetGw
    Start-TailscaleMesh
    tailscale set --exit-node=$SwedenExit --exit-node-allow-lan-access=true
    Set-SwedenSocksEnv -Value ("socks5://{0}" -f $Socks5)
    if (Test-Path $warp) {
      & $warp mode warp+doh | Out-Null
      & $warp vnet $SwedenVnet | Out-Null
    }
    Start-Sleep -Seconds 3
    Show-Status
    Write-Host 'Expect ~500 Mbps, source 170.62.100.238 / SOCKS5 Stockholm. Include profile must be active on this box.'
  }
  'Together' {
    Write-Host 'Lane Together: WARP DoH/include + Tailscale mesh + Ethernet punch. No default-route fight.'
    Install-WarpPunch -Gateway $EthernetGw
    Start-TailscaleMesh
    Set-WarpMode -Mode doh
    if (Test-Path $warp) { & $warp connect | Out-Null }
    tailscale set --exit-node-allow-lan-access=true | Out-Null
    Show-Status
    Write-Host 'If WARP shows Exclude mode, switch the WeCrypto Windows include profile.'
    Write-Host 'For Sweden IP after this: -Lane Sweden. For tailnet Gateway DNS: Apply-TailscaleWarpCoexist.ps1 -Action PushDns'
    Write-Host 'ASI1 uses the Tailscale node (not WARP include) so Gateway L4 NA-only does not drop api.asi1.ai.'
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
    Start-Sleep -Seconds 4
    Show-Status
    Write-Host 'WARP must show Profile ID of WeCrypto Windows include (not default) and Include mode.'
  }
  default { Show-Status }
}
