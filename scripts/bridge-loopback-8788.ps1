$ErrorActionPreference = "Stop"

# WECRYPTO bridge loopback: Windows 127.0.0.1:8788 -> WSL :8788
# Run ELEVATED once (right-click PowerShell -> Run as administrator):
#   powershell -ExecutionPolicy Bypass -File G:\WECRYP\scripts\bridge-loopback-8788.ps1
# Mirrors scripts/truffle-loopback-bridge.ps1 (port 8002) for the wecrypto-bridge.
# Lets the Electron app HUD (Windows) reach the WSL bridge at http://127.0.0.1:8788
# with the X-Bridge-Token header (token lives in ~/projects/wecrypto-bridge/.env).

$listenAddress = "127.0.0.1"
$listenPort = 8788

$wslOutput = & wsl.exe -d Ubuntu hostname -I 2>$null
if (-not $wslOutput) {
    Write-Error "Unable to resolve WSL IP. Is Ubuntu running?"
    exit 1
}

$wslIp = ($wslOutput | Select-Object -First 1).ToString().Trim().Split(" ")[0]
if (-not $wslIp) {
    Write-Error "Unable to parse WSL IP from output: $wslOutput"
    exit 1
}

& netsh.exe interface portproxy delete v4tov4 listenaddress=$listenAddress listenport=$listenPort 2>$null
& netsh.exe interface portproxy add v4tov4 listenaddress=$listenAddress listenport=$listenPort connectaddress=$wslIp connectport=$listenPort | Out-Null

Write-Host "wecrypto-bridge loopback: $listenAddress`:$listenPort -> ${wslIp}:$listenPort"
