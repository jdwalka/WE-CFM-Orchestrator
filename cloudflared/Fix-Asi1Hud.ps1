#Requires -Version 5.1
<#
.SYNOPSIS
  WeCrypto ASI1 HUD fix — run in Windows PowerShell as the same user that runs Electron.

.DESCRIPTION
  G:\wecryp is the app tree.
  - Do NOT add a 34.149.190.89 Ethernet /32. That is EACCES on the HUD.
  - ASI1 Windows CONNECT proxy on 127.0.0.1:18080 (node, not WSL).
  - Force icloud account (Pro / ultra). gitgoin+mauro are eon-capped.
  Restart WeCrypto after this script.
#>
$ErrorActionPreference = 'Continue'
Set-Location G:\wecryp

$node = 'C:\Program Files\nodejs\node.exe'
$proxyJs = 'G:\wecryp\cloudflared\asi1-windows-proxy.js'

Write-Host '== 1. remove ASI1 Ethernet punch (causes HUD EACCES) =='
cmd /c 'route delete 34.149.190.89 mask 255.255.255.255 >nul 2>&1'
cmd /c 'route delete 34.149.190.89 >nul 2>&1'
route print -4 | findstr 34.149
if (-not $?) { Write-Host '  no 34.149 punch (good)' }

Write-Host '== 2. pin icloud + local proxy in User env =='
[Environment]::SetEnvironmentVariable('ASI1_PREFERRED_ACCOUNT', 'icloud', 'User')
[Environment]::SetEnvironmentVariable('WECRYPTO_DIRECT_PROXY', 'http://127.0.0.1:18080', 'User')
[Environment]::SetEnvironmentVariable('WECRYPTO_ASI1_PROXY', 'http://127.0.0.1:18080', 'User')
$env:ASI1_PREFERRED_ACCOUNT = 'icloud'
$env:WECRYPTO_DIRECT_PROXY = 'http://127.0.0.1:18080'

Write-Host '== 3. start Windows ASI1 proxy on 127.0.0.1:18080 =='
$listen = netstat -ano | Select-String '127.0.0.1:18080.+LISTENING'
if (-not $listen) {
  if (-not (Test-Path $node)) { throw "node.exe missing: $node" }
  if (-not (Test-Path $proxyJs)) { throw "proxy missing: $proxyJs" }
  Start-Process -FilePath $node -ArgumentList $proxyJs -WorkingDirectory 'G:\wecryp\cloudflared' -WindowStyle Minimized
  Start-Sleep -Seconds 1
}
netstat -ano | Select-String '127.0.0.1:18080.+LISTENING'

Write-Host '== 4. probe ASI1 (401 = path OK) =='
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 https://api.asi1.ai/v1/models | Out-Null
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Write-Host ("  direct HTTP {0}" -f $code)
}
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 -Proxy http://127.0.0.1:18080 https://api.asi1.ai/v1/models | Out-Null
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Write-Host ("  proxy  HTTP {0}" -f $code)
}

Write-Host ''
Write-Host 'Restart WeCrypto from G:\wecryp (launch.bat or npx electron .).'
Write-Host 'HUD account must be icloud. Do not route add 34.149.190.89.'
