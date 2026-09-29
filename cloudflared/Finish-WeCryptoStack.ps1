#Requires -Version 5.1
<#
.SYNOPSIS
  Bring up the WeCrypto stack: WARP include/DoH + Tailscale node + tunnel origin + ASI1.

.DESCRIPTION
  1) Together lane (WARP connect, Tailscale mesh, Ethernet punch). Keeps the
     current Sweden exit if one is already set.
  2) Starts https://127.0.0.1:3450 so the wecrypto cloudflared token tunnel
     has an origin (wecrypto.leaksnipe.win).
  3) Probes Tailscale, WARP, local origin, published host, and ASI1 mini.

  ASI1 is intentionally NOT added to the WARP include list: Gateway rule
  "Block Malicious Traffic" drops non-NA TLS. ASI1 exits the Tailscale node.

.EXAMPLE
  .\cloudflared\Finish-WeCryptoStack.ps1
  .\cloudflared\Finish-WeCryptoStack.ps1 -SkipOrigin
#>
param(
  [switch]$SkipOrigin,
  [string]$OriginPort = '3450',
  [string]$PublishedHost = 'https://wecrypto.leaksnipe.win'
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$warp = 'C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe'

Write-Host '== 1. Together lane (WARP + Tailscale) =='
& (Join-Path $here 'Set-WeCryptoLanes.ps1') -Lane Together

if (-not $SkipOrigin) {
  Write-Host ''
  Write-Host "== 2. Origin https://127.0.0.1:$OriginPort =="
  $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq [int]$OriginPort }
  if ($listening) {
    Write-Host "  already listening on $OriginPort (pid $($listening.OwningProcess))"
  } else {
    Write-Host "  starting wecrypto-web-service on 127.0.0.1:$OriginPort"
    $env:WECRYPTO_WEB_HOST = '127.0.0.1'
    $env:WECRYPTO_WEB_PORT = $OriginPort
    $starter = @"
process.env.WECRYPTO_WEB_HOST = '127.0.0.1';
process.env.WECRYPTO_WEB_PORT = '$OriginPort';
require('./electron/wecrypto-web-service').startWebService();
"@
    $starterPath = Join-Path $env:TEMP 'wecrypto-origin-3450.js'
    Set-Content -Path $starterPath -Value $starter -Encoding UTF8
    Start-Process -FilePath 'node' -ArgumentList $starterPath -WorkingDirectory $repo -WindowStyle Hidden
    Start-Sleep -Seconds 3
  }
}

Write-Host ''
Write-Host '== 3. Stack probes =='
function Show-Probe([string]$Name, [scriptblock]$Fn) {
  try {
    $r = & $Fn
    Write-Host ("  {0}: {1}" -f $Name, $r)
  } catch {
    Write-Host ("  {0}: FAIL {1}" -f $Name, $_.Exception.Message)
  }
}

Show-Probe 'WARP' {
  if (-not (Test-Path $warp)) { return 'warp-cli missing' }
  $s = & $warp status 2>&1 | Out-String
  if ($s -match 'Connected') { 'Connected' } elseif ($s -match 'Disconnected') { 'Disconnected' } else { $s.Trim() }
}
Show-Probe 'Tailscale node' {
  $st = tailscale status --json | ConvertFrom-Json
  '{0} {1} exit={2}' -f $st.Self.DNSName, $st.BackendState, [bool]$st.ExitNodeStatus.Online
}
Show-Probe 'cloudflared service' {
  $svc = Get-Service Cloudflared -ErrorAction Stop
  '{0} {1}' -f $svc.Status, $svc.StartType
}
Show-Probe "origin :$OriginPort" {
  $code = & curl.exe -sk -o NUL -w '%{http_code}' --max-time 5 "https://127.0.0.1:$OriginPort/"
  "HTTP $code"
}
Show-Probe $PublishedHost {
  $code = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 12 $PublishedHost
  "HTTP $code"
}
Show-Probe 'ASI1 api.asi1.ai' {
  $code = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 12 'https://api.asi1.ai/v1/models'
  "HTTP $code (404 on /models still means host is reachable)"
}

Write-Host ''
Write-Host '== 4. ASI1 desk ping =='
$pingJs = @'
const A = require('./src/infra/asi1-client');
const O = require('./src/llm/asi1-credit-orchestrator');
(async () => {
  const d = A.getDiagnostics();
  const names = Object.keys(d.accounts || {}).join(',');
  console.log('  keys=' + d.keysConfigured + ' accounts=' + names + ' mode=' + O.getMode());
  const r = await A.chatCompletion(
    [{ role: 'user', content: 'Reply OK' }],
    { model: 'asi1-mini', max_tokens: 4, temperature: 0, timeoutMs: 20000 }
  );
  console.log('  mini ' + r.account + ' ' + r.model + ' ' + String(r.content || '').slice(0, 32));
})().catch((e) => {
  console.log('  ASI1 ping FAIL ' + e.message);
});
'@
$pingPath = Join-Path $env:TEMP 'wecrypto-asi1-ping.js'
Set-Content -Path $pingPath -Value $pingJs -Encoding UTF8
Push-Location $repo
try { node $pingPath }
finally { Pop-Location }

Write-Host ''
Write-Host '== 5. Tailscale Serve (tailnet app) =='
& (Join-Path $here 'Publish-WeCryptoTailscale.ps1')

Write-Host ''
Write-Host 'Stack: WARP include/DoH + Tailscale node + Serve + cloudflared(wecrypto) + ASI1 via TS exit.'
Write-Host 'Tailnet:  https://mauro.prairiedog-godzilla.ts.net/  (Serve, members only)'
Write-Host 'Public:   https://wecrypto.leaksnipe.win            (cloudflared; 403 until CF Access/WAF allow)'
Write-Host 'Origin:   https://127.0.0.1:3450'
Write-Host 'svc:wecrypto needs a tagged host — see Publish-WeCryptoTailscale.ps1'
