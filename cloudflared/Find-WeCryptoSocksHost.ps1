# Find-WeCryptoSocksHost.ps1 — discover a reachable SOCKS5 bridge without
# hard-coding the current WSL/Wi-Fi topology.
#
# Output: first reachable host on stdout (exit 0), or no output (exit 1).
# Candidate order:
#   1. WECRYPTO_SOCKS_HOST / WECRYPTO_WSL_HOST (explicit user override)
#   2. Current WSL IPv4 addresses from wsl.exe (changes with laptop/Wi-Fi)
#   3. Legacy WSL WireGuard address
#   4. Local loopback bridge

param(
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [int]$TimeoutMs = 400
)

$ErrorActionPreference = 'Stop'

function Test-WeCryptoPort {
    param([string]$HostName)

    if ([string]::IsNullOrWhiteSpace($HostName)) { return $false }

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connected = $client.BeginConnect($HostName, $Port, $null, $null)
        return ($connected.AsyncWaitHandle.WaitOne($TimeoutMs, $false) -and $client.Connected)
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

$candidates = [System.Collections.Generic.List[string]]::new()
function Add-Candidate {
    param([string]$HostName)
    if ([string]::IsNullOrWhiteSpace($HostName)) { return }
    if ($candidates -notcontains $HostName) { $candidates.Add($HostName) }
}

Add-Candidate $env:WECRYPTO_SOCKS_HOST
Add-Candidate $env:WECRYPTO_WSL_HOST

if ($env:WECRYPTO_DISABLE_WSL_DISCOVERY -ne '1') {
    try {
        $wslOutput = & wsl.exe -e sh -c 'hostname -I' 2>$null
        foreach ($line in @($wslOutput)) {
            foreach ($token in ([string]$line) -split '\s+') {
                if ($token -match '^(\d{1,3}\.){3}\d{1,3}$' -and $token -ne '127.0.0.1') {
                    Add-Candidate $token
                }
            }
        }
    } catch {
        # WSL discovery is best-effort; explicit overrides and loopback still work.
    }
}

Add-Candidate '10.13.13.2'
Add-Candidate '127.0.0.1'

foreach ($candidate in $candidates) {
    if (Test-WeCryptoPort -HostName $candidate) {
        Write-Output $candidate
        exit 0
    }
}

exit 1
