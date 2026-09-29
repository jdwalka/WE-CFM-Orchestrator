#Requires -Version 5.1
<#
.SYNOPSIS
  Apply Cloudflare One Sweden egress for WeCrypto + Tailscale SWEDEN vnet.

.DESCRIPTION
  Needs a token with Zero Trust / Gateway write (the cloudflared origin-cert
  token cannot create Gateway rules — those calls return 403).

  Set CLOUDFLARE_API_TOKEN then run:
    .\apply-sweden-egress.ps1
    .\apply-sweden-egress.ps1 -DedicatedIPv4 x.x.x.x -DedicatedIPv6 'xxxx::/64'
    .\apply-sweden-egress.ps1 -SwedenTunnelId <uuid>   # hostname-route off-ramp

.NOTES
  Gateway location already created in dashboard (Stockholm / Mullvad):
    IPv4 resolver     172.64.36.1  172.64.36.2
    Source IPv4       170.62.100.238/32
    IPv6 resolver     2a06:98c1:54::70:cc2c
    Source IPv6       (add 2a02:6ea0:1508:9::e02f/128)
    DoH               https://mokbrpzbx4.cloudflare-gateway.com/dns-query
    DoT               mokbrpzbx4.cloudflare-gateway.com

  That location identifies DNS *from* the Mullvad Stockholm IP.
  It does not make Cloudflare egress from Stockholm.
#>
param(
  [string]$AccountId = 'f226035af09775dbffd7e6350adc8a12',
  [string]$SwedenVnetId = 'bc743e42-bbf6-4506-b5b2-db7c12f573cc',
  [string]$DedicatedIPv4 = '',
  [string]$DedicatedIPv4Fallback = '0.0.0.0',
  [string]$DedicatedIPv6 = '',
  [string]$SwedenTunnelId = ''
)

$ErrorActionPreference = 'Stop'
$token = $env:CLOUDFLARE_API_TOKEN
if (-not $token) { throw 'Set CLOUDFLARE_API_TOKEN (Zero Trust / Gateway write). cloudflared cert token is not enough.' }

$hdr = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }
$base = "https://api.cloudflare.com/client/v4/accounts/$AccountId"

$exchangeHosts = @(
  'api.binance.com', 'api.binance.us', 'data-api.binance.vision', 'fapi.binance.com',
  'api.coingecko.com', 'api.coinbase.com', 'api.exchange.coinbase.com',
  'api.kraken.com', 'api.bybit.com', 'www.okx.com',
  'api.elections.kalshi.com', 'gamma-api.polymarket.com', 'clob.polymarket.com',
  'api-pub.bitfinex.com', 'api.kucoin.com', 'api.mexc.com',
  'api.dexscreener.com', 'api.hyperliquid.xyz', 'api.gateio.ws', 'api.crypto.com'
)

function Invoke-Cf {
  param([string]$Method, [string]$Path, $Body)
  $uri = if ($Path.StartsWith('http')) { $Path } else { "$base$Path" }
  $params = @{ Uri = $uri; Headers = $hdr; Method = $Method }
  if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress) }
  Invoke-RestMethod @params
}

Write-Host '== existing Gateway rules =='
$rules = Invoke-Cf GET '/gateway/rules'
$rules.result | ForEach-Object { '{0} [{1}] filters={2} enabled={3}' -f $_.name, $_.action, ($_.filters -join ','), $_.enabled }

$haveSweden = $rules.result | Where-Object { $_.name -eq 'Egress Tailscale SWEDEN Stockholm' }
$haveCatch  = $rules.result | Where-Object { $_.name -eq 'Default Cloudflare egress catch-all' }

if ($DedicatedIPv4 -and $DedicatedIPv6) {
  if (-not $haveSweden) {
    Write-Host '== create Sweden vnet egress policy =='
    $created = Invoke-Cf POST '/gateway/rules' @{
      action      = 'egress'
      name        = 'Egress Tailscale SWEDEN Stockholm'
      description = 'WeCrypto / trading: VNET Tailscale SWEDEN uses dedicated Stockholm IPs'
      enabled     = $true
      filters     = @('egress')
      precedence  = 10
      traffic     = "net.vnet_id == `"$SwedenVnetId`""
      rule_settings = @{
        egress = @{
          ipv4          = $DedicatedIPv4
          ipv4_fallback = $DedicatedIPv4Fallback
          ipv6          = $DedicatedIPv6
        }
      }
    }
    Write-Host "created $($created.result.id)"
  } else { Write-Host 'Sweden egress policy already exists' }

  $tradeExpr = ($exchangeHosts | ForEach-Object { 'net.fqdn.host == "{0}"' -f $_ }) -join ' or '
  $haveTrade = $rules.result | Where-Object { $_.name -eq 'Egress WeCrypto exchanges Stockholm' }
  if (-not $haveTrade) {
    Write-Host '== create host-selector trading egress (higher precedence) =='
    $created = Invoke-Cf POST '/gateway/rules' @{
      action      = 'egress'
      name        = 'Egress WeCrypto exchanges Stockholm'
      description = 'Only WeCrypto proxy destinations leave via Stockholm dedicated IPs'
      enabled     = $true
      filters     = @('egress')
      precedence  = 5
      traffic     = "($tradeExpr)"
      rule_settings = @{
        egress = @{
          ipv4          = $DedicatedIPv4
          ipv4_fallback = $DedicatedIPv4Fallback
          ipv6          = $DedicatedIPv6
        }
      }
    }
    Write-Host "created $($created.result.id)"
    Write-Host 'Turn on Zero Trust > Traffic policies > Traffic settings > Allow egress policy host selectors'
  }
} else {
  Write-Host 'SKIP dedicated egress policies — pass -DedicatedIPv4 and -DedicatedIPv6 (Enterprise add-on).'
}

if (-not $haveCatch) {
  Write-Host '== create catch-all default Cloudflare egress =='
  $created = Invoke-Cf POST '/gateway/rules' @{
    action      = 'egress'
    name        = 'Default Cloudflare egress catch-all'
    description = 'Everything else uses nearest Cloudflare egress (line-rate)'
    enabled     = $true
    filters     = @('egress')
    precedence  = 32000
    traffic     = 'net.protocol in {"tcp" "udp" "icmp" "icmpv6"}'
    rule_settings = @{
      egress = @{ ipv4 = '0.0.0.0'; ipv6 = '::' }
    }
  }
  Write-Host "created $($created.result.id)"
} else { Write-Host 'catch-all already exists' }

if ($SwedenTunnelId) {
  Write-Host "== hostname routes via Sweden tunnel $SwedenTunnelId =="
  $existing = Invoke-Cf GET '/zerotrust/routes/hostname'
  $have = @{}
  foreach ($h in $existing.result) { $have[$h.hostname] = $true }
  foreach ($hn in $exchangeHosts) {
    if ($have[$hn]) { Write-Host "exists $hn"; continue }
    $r = Invoke-Cf POST '/zerotrust/routes/hostname' @{
      hostname  = $hn
      tunnel_id = $SwedenTunnelId
      comment   = 'WeCrypto exchange — Sweden source-IP anchor'
    }
    Write-Host "routed $hn -> $($r.result.id)"
  }
} else {
  Write-Host 'SKIP hostname routes — do not point exchange FQDNs at the home Leak-Snipe tunnel (hairpin). Pass -SwedenTunnelId of a cloudflared that actually exits in Stockholm.'
}

Write-Host 'done'
