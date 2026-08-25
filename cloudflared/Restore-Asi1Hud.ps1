#Requires -Version 5.1
<#
.SYNOPSIS
  Restore the 2026-08-23 ASI1 HUD fast path (~3ms in-app).

.DESCRIPTION
  Sweden Tailscale exit stays ON.
  Electron uses http://127.0.0.1:18080.
  WSL python CONNECT proxy does the upstream (Windows node bind to 192.168.18.38 = EACCES).
  Ethernet /32 for 34.149.190.89 on ifIndex 17 only.

  Run as the same Windows user that runs Electron. Route add needs elevation.
#>
$ErrorActionPreference = 'Continue'
Set-Location G:\wecryp

[Environment]::SetEnvironmentVariable('ASI1_PREFERRED_ACCOUNT', 'icloud', 'User')
[Environment]::SetEnvironmentVariable('WECRYPTO_DIRECT_PROXY', 'http://127.0.0.1:18080', 'User')
[Environment]::SetEnvironmentVariable('WECRYPTO_ASI1_PROXY', 'http://127.0.0.1:18080', 'User')
$env:ASI1_PREFERRED_ACCOUNT = 'icloud'
$env:WECRYPTO_DIRECT_PROXY = 'http://127.0.0.1:18080'
$env:WECRYPTO_SKIP_INFERENCE = '1'

Push-Location $env:TEMP
tailscale set --exit-node=se-sto-wg-209.mullvad.ts.net --exit-node-allow-lan-access=true
tailscale set --advertise-connector=false
tailscale set --advertise-routes=192.168.18.0/24
Pop-Location

$if = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq '192.168.18.38' }).InterfaceIndex
if (-not $if) { $if = 17 }
$bat = "$env:TEMP\asi1-eth-punch.bat"
@(
  'route delete 34.149.190.89 mask 255.255.255.255 >nul 2>&1'
  'route delete 34.149.190.89 >nul 2>&1'
  "route -p add 34.149.190.89 mask 255.255.255.255 192.168.18.1 metric 5 if $if"
) | Set-Content $bat -Encoding ASCII
Start-Process -FilePath $bat -Verb RunAs -Wait -WindowStyle Hidden

Get-NetTCPConnection -LocalPort 18080 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

wsl -d Ubuntu -- bash -lc "test -f /tmp/hudproxy.py && (ss -ltn | grep -q ':18080' || nohup python3 /tmp/hudproxy.py >/tmp/hudproxy.log 2>&1 &) ; ss -ltn | grep 18080"

$wslIp = ((wsl -d Ubuntu -- hostname -I) -split '\s+' | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1)
$env:ASI1_WSL_IP = $wslIp
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'G:\wecryp\cloudflared\asi1-wsl-relay.js' -WorkingDirectory 'G:\wecryp\cloudflared' -WindowStyle Minimized
Start-Sleep -Seconds 1
netstat -ano | findstr 'LISTENING' | findstr ':18080'
route print -4 | findstr 34.149
Write-Host "WSL_IP=$wslIp  Restart Electron from G:\wecryp"
