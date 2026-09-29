$ErrorActionPreference = "Stop"

# jdwalkaz cascade bridge loopback: Windows 127.0.0.1:8004 -> WSL :8004
# Run ELEVATED once (right-click PowerShell -> Run as administrator):
#   powershell -ExecutionPolicy Bypass -File G:\WECRYP\scripts\proxy-loopback-8004.ps1
# Mirrors scripts/proxy-loopback-3010.ps1 and scripts/bridge-loopback-8788.ps1.
# The ASI1 desk renderer fetches http://127.0.0.1:8004 from the Windows side,
# but jdwalkaz_cascade_bridge.py listens inside WSL (jdwalkaz offline message
# otherwise). The WSL NAT localhostForwarding relay stalls under load —
# the netsh portproxy is the reliable Windows->WSL hop.
# NOTE: WSL IP changes per boot — re-run this script after each WSL restart.

$listenAddress = "127.0.0.1"
$listenPort = 8004

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

Write-Host "jdwalkaz loopback: $listenAddress`:$listenPort -> ${wslIp}:$listenPort"
