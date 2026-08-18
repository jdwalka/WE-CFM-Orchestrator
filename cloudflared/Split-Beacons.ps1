#Requires -Version 5.1
<#
.SYNOPSIS
  Split radios: Ethernet = WeCrypto / WARP / Tailscale; Wi-Fi = poker.

.DESCRIPTION
  Ethernet (192.168.18.38, 1 Gbps) keeps the default route, WARP include,
  Tailscale mesh, and cloudflared origin.

  Wi-Fi is for LeakSnipe / poker. Prefer SSID LeakSnipe
  (BSSID 62:07:f8:49:59:9a) when a Windows profile exists.
  Metric is worse than Ethernet so Wi-Fi never steals the default route.

  Same gateway as Ethernet = same 192.168.18.0/24 (queue split only).
  Guest/isolated SSID on another subnet = real second WAN.

.EXAMPLE
  .\cloudflared\Split-Beacons.ps1
  .\cloudflared\Split-Beacons.ps1 -WifiProfile 'LeakSnipe'
  .\cloudflared\Split-Beacons.ps1 -DisconnectWifi
#>
param(
  [string]$WifiProfile = '',
  [string]$EthernetName = 'Ethernet',
  [string]$WifiName = 'Wi-Fi',
  [int]$EthernetMetric = 10,
  [int]$WifiMetric = 80,
  [switch]$DisconnectWifi
)

$ErrorActionPreference = 'Continue'

if (-not $WifiProfile) {
  $saved = (netsh wlan show profiles) | Out-String
  if ($saved -match 'LeakSnipe') { $WifiProfile = 'LeakSnipe' }
  elseif ($saved -match 'NOKIA-2461') { $WifiProfile = 'NOKIA-2461' }
  elseif ($saved -match 'B1063A_5G') { $WifiProfile = 'B1063A_5G' }
  else { $WifiProfile = 'LeakSnipe' }
}

function Show-Split {
  Write-Host '== adapters =='
  Get-NetAdapter | Where-Object { $_.Name -match "$EthernetName|$WifiName" } |
    Format-Table Name, Status, LinkSpeed, MacAddress -AutoSize
  Write-Host '== IPv4 =='
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -match "$EthernetName|$WifiName" } |
    Format-Table InterfaceAlias, IPAddress, PrefixLength -AutoSize
  Write-Host '== metrics / default routes =='
  Get-NetIPInterface -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -match "$EthernetName|$WifiName" } |
    Format-Table InterfaceAlias, InterfaceMetric, ConnectionState -AutoSize
  Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
    Format-Table DestinationPrefix, NextHop, InterfaceAlias, RouteMetric, InterfaceMetric -AutoSize
}

if ($DisconnectWifi) {
  netsh wlan disconnect interface="$WifiName" | Out-Null
  Write-Host "Wi-Fi disconnected. Ethernet is the only beacon."
  Show-Split
  return
}

Write-Host "Ethernet metric $EthernetMetric (WeCrypto / WARP / Tailscale)"
Set-NetIPInterface -InterfaceAlias $EthernetName -AddressFamily IPv4 -InterfaceMetric $EthernetMetric -ErrorAction SilentlyContinue

$wlan = netsh wlan show interfaces | Out-String
if ($wlan -notmatch 'State\s*:\s*connected') {
  Write-Host "Connecting Wi-Fi profile $WifiProfile (poker beacon)"
  netsh wlan connect name="$WifiProfile" interface="$WifiName" | Out-Host
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Seconds 2
    $ip = Get-NetIPAddress -InterfaceAlias $WifiName -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.PrefixOrigin -ne 'WellKnown' -and $_.IPAddress -notlike '169.254.*' }
    if ($ip) { break }
  } while ((Get-Date) -lt $deadline)
}

Set-NetIPInterface -InterfaceAlias $WifiName -AddressFamily IPv4 -InterfaceMetric $WifiMetric -ErrorAction SilentlyContinue

$wifiIp = Get-NetIPAddress -InterfaceAlias $WifiName -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1 -ExpandProperty IPAddress
$ethIp = Get-NetIPAddress -InterfaceAlias $EthernetName -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty IPAddress

if ($wifiIp) {
  [Environment]::SetEnvironmentVariable('LEAKSNIPE_BIND_IP', $wifiIp, 'User')
  $env:LEAKSNIPE_BIND_IP = $wifiIp
  Write-Host "Poker bind IP (Wi-Fi): $wifiIp"
} else {
  Write-Host 'Wi-Fi has no DHCP address yet — poker will fall back to Ethernet.'
}
if ($ethIp) {
  [Environment]::SetEnvironmentVariable('WECRYPTO_BIND_IP', $ethIp, 'User')
  $env:WECRYPTO_BIND_IP = $ethIp
  Write-Host "WeCrypto bind IP (Ethernet): $ethIp"
}

Show-Split
function Set-OnRampFirewall {
  $wifi = Get-NetAdapter -Name $WifiName -ErrorAction SilentlyContinue
  if (-not $wifi) { return }
  $rules = @(
    @{ Name = 'WeCrypto-WARP-NoWifi'; Display = 'WeCrypto WARP Ethernet only'; Dir = 'Outbound'; Program = 'C:\Program Files\Cloudflare\Cloudflare WARP\warp-svc.exe' },
    @{ Name = 'WeCrypto-TS-NoWifi-Out'; Display = 'WeCrypto Tailscale no Wi-Fi out'; Dir = 'Outbound'; Program = 'C:\Program Files\Tailscale\tailscaled.exe' }
  )
  foreach ($r in $rules) {
    if (Get-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue) {
      Remove-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue
    }
    try {
      New-NetFirewallRule -Name $r.Name -DisplayName $r.Display -Direction $r.Dir -Action Block -Program $r.Program -InterfaceAlias $WifiName -Profile Any -ErrorAction Stop | Out-Null
      Write-Host ("firewall {0}: block {1} on {2}" -f $r.Name, (Split-Path $r.Program -Leaf), $WifiName)
    } catch {
      Write-Host ("firewall {0}: need elevation ({1})" -f $r.Name, $_.Exception.Message)
    }
  }
  if (Get-NetFirewallRule -Name 'WeCrypto-TS-NoWifi-In41641' -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -Name 'WeCrypto-TS-NoWifi-In41641' -ErrorAction SilentlyContinue
  }
  try {
    New-NetFirewallRule -Name 'WeCrypto-TS-NoWifi-In41641' -DisplayName 'WeCrypto Tailscale no Wi-Fi UDP 41641' -Direction Inbound -Action Block -Protocol UDP -LocalPort 41641 -InterfaceAlias $WifiName -Profile Any -ErrorAction Stop | Out-Null
    Write-Host "firewall WeCrypto-TS-NoWifi-In41641: block Tailscale stun on $WifiName"
  } catch {
    Write-Host ("firewall inbound 41641: need elevation ({0})" -f $_.Exception.Message)
  }
}

Set-OnRampFirewall

$ethMac = (Get-NetAdapter -Name $EthernetName).MacAddress
$wifiMac = (Get-NetAdapter -Name $WifiName -ErrorAction SilentlyContinue).MacAddress
Write-Host ''
Write-Host 'MAC lift (local on-ramp only — Gateway/Tailscale see machine IPs, not NIC MACs):'
Write-Host ("  Ethernet {0}  {1}  -> tailscale 100.107.195.35 / WARP profile 56ba0668" -f $ethMac, $ethIp)
Write-Host ("  Wi-Fi    {0}  {1}  -> poker only (SSID LeakSnipe AP 62:07:f8:49:59:9a)" -f $wifiMac, $wifiIp)
Write-Host 'Launch poker: G:\LeakSnipe\Launch-LeakSnipe.bat'
Write-Host 'Same /24 today. Guest SSID on another subnet = real second WAN.'
