# Install and start WireGuard Tunnel for WeCrypto Mullvad on Windows
$ErrorActionPreference = 'Continue'
$logFile = 'C:\Windows\Temp\wireguard-install.log'
"=== WireGuard WeCrypto Mullvad Install $(Get-Date) ===" | Out-File $logFile

$confPath = 'C:\Windows\Temp\wecrypto-mullvad.conf'
if (-not (Test-Path $confPath)) {
    Copy-Item 'G:\WECRYP\cloudflared\wecrypto-mullvad.conf' $confPath -Force
}

Write-Host "Installing/restarting WireGuardTunnel`$wecrypto-mullvad..." -ForegroundColor Cyan
& "C:\Program Files\WireGuard\wireguard.exe" /installtunnelservice $confPath *>> $logFile

Start-Sleep -Seconds 2

$svc = Get-Service 'WireGuardTunnel$wecrypto-mullvad' -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "Service status: $($svc.Status)" -ForegroundColor Green
    if ($svc.Status -ne 'Running') {
        Start-Service 'WireGuardTunnel$wecrypto-mullvad'
    }
} else {
    Write-Host "WireGuard service not registered yet." -ForegroundColor Yellow
}

Start-Sleep -Seconds 2
$iface = Get-NetIPAddress -InterfaceAlias 'wecrypto-mullvad*' -AddressFamily IPv4 -ErrorAction SilentlyContinue
Write-Host "Interface: $($iface.InterfaceAlias) IP: $($iface.IPAddress)" -ForegroundColor Green
"Interface: $($iface.InterfaceAlias) IP: $($iface.IPAddress)" | Out-File -Append $logFile
Write-Host "Done! You can close this window." -ForegroundColor Cyan
Start-Sleep -Seconds 3
