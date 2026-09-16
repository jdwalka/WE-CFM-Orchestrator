$ErrorActionPreference = "Stop"

$listenAddress = "127.0.0.1"
$listenPort = 8002

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

Write-Host "WECRYP Truffle loopback bridge: $listenAddress`:$listenPort -> ${wslIp}:$listenPort"
