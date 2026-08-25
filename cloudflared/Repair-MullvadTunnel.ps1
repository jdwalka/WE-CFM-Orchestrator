#Requires -Version 5.1
<#
.SYNOPSIS
  Diagnose the API-provisioned wecrypto-mullvad WireGuard tunnel + SOCKS5 egress.

.DESCRIPTION
  The standalone Mullvad path is:
    Mullvad API device -> WireGuardTunnel$wecrypto-mullvad (10.65.50.149)
    -> mullvad-standalone-socks.js (:18090) -> WECRYPTO_SWEDEN_SOCKS

  launch.bat calls Test-TunnelConnectivity.ps1 before Electron starts.
#>
param(
    [string]$TunnelLocalAddr = $(if ($env:MULLVAD_TUNNEL_LOCAL_ADDR) { $env:MULLVAD_TUNNEL_LOCAL_ADDR } else { '10.65.50.149' }),
    [string]$SocksPort = $(if ($env:MULLVAD_SOCKS_PORT) { $env:MULLVAD_SOCKS_PORT } else { '18090' })
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here

Write-Host '== Mullvad API tunnel diagnostics ==' -ForegroundColor Cyan

$wgSvc = Get-Service 'WireGuardTunnel$wecrypto-mullvad' -ErrorAction SilentlyContinue
if ($wgSvc) {
    Write-Host ("  WireGuard service: {0} ({1})" -f $wgSvc.DisplayName, $wgSvc.Status)
} else {
    Write-Host '  WireGuard service: MISSING (install wecrypto-mullvad tunnel)' -ForegroundColor Red
}

$iface = Get-NetIPAddress -InterfaceAlias 'wecrypto-mullvad' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($iface) {
    Write-Host ("  Tunnel interface: {0}/{1}" -f $iface.IPAddress, $iface.PrefixLength)
    if ($iface.IPAddress -ne $TunnelLocalAddr) {
        Write-Host ("  WARN: expected {0}, got {1} — update MULLVAD_TUNNEL_LOCAL_ADDR" -f $TunnelLocalAddr, $iface.IPAddress) -ForegroundColor Yellow
    }
} else {
    Write-Host '  Tunnel interface: DOWN' -ForegroundColor Red
}

$socksUp = Test-NetConnection -ComputerName 127.0.0.1 -Port $SocksPort -InformationLevel Quiet -WarningAction SilentlyContinue
Write-Host ("  SOCKS bridge :{0} listening={1}" -f $SocksPort, [bool]$socksUp)

Write-Host ''
Write-Host '== End-to-end egress test ==' -ForegroundColor Cyan
& (Join-Path $here 'Test-TunnelConnectivity.ps1') -SocksUrl ("socks5://127.0.0.1:{0}" -f $SocksPort)
$egressOk = ($LASTEXITCODE -eq 0)

if (-not $egressOk) {
    Write-Host ''
    Write-Host 'Repair steps (API WireGuard path, not the desktop app):' -ForegroundColor Yellow
    Write-Host '  1. Run this script elevated, then: Restart-Service WireGuardTunnel`$wecrypto-mullvad'
    Write-Host '  2. Confirm C:\Windows\Temp\wecrypto-mullvad.conf peer AllowedIPs includes 0.0.0.0/0'
    Write-Host '  3. Confirm peer Endpoint matches a live Stockholm relay (cloudflared/mullvad-stockholm-relays.json)'
    Write-Host '  4. If handshake still dead, re-register the device via Mullvad API (see docs/HANDOFF-2026-08-23-asi1-hud-incident.md)'
    exit 1
}

Write-Host 'Mullvad API tunnel egress OK.' -ForegroundColor Green
exit 0
