param(
    [string]$WorkspaceRoot = "",
    [int]$Days = 60,
    [string]$Coins = "BTC,ETH,SOL,XRP",
    [int]$MaxWindows = 180,
    [int]$FoldSize = 400,
    [int]$TestBars = 100,
    [int]$StepBars = 50,
    [bool]$UseProxy = $true,
    [bool]$RequireTor = $false,
    [bool]$OpenTorPorts = $true,
    [string]$TorHttpProxy = "http://127.0.0.1:8118",
    [bool]$InstallDeps = $false,
    [switch]$WriteWeights,
    [switch]$SkipWalkForward,
    [switch]$SkipAdvanced,
    [switch]$SkipOutcomeRetuner
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[ERR ] $msg" -ForegroundColor Red }

function Resolve-RepoRoot {
    param([string]$Hint)

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Hint) { $candidates.Add($Hint) }
    if ($env:WE_CFM_ROOT) { $candidates.Add($env:WE_CFM_ROOT) }
    if ($PSScriptRoot) {
        $scriptParent = Split-Path -Parent $PSScriptRoot
        if ($scriptParent) { $candidates.Add($scriptParent) }
    }

    $userName = $env:USERNAME
    $fallbacks = @(
        "C:\Users\$userName\WE-CFM-Orchestrator",
        "C:\Users\$userName\Desktop\WE-CFM-Orchestrator",
        "D:\WE-CFM-Orchestrator",
        "E:\WE-CFM-Orchestrator",
        "F:\WE-CFM-Orchestrator",
        "F:\WE CFM Orchestrator"
    )
    foreach ($item in $fallbacks) { $candidates.Add($item) }

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        try {
            if (-not (Test-Path -LiteralPath $candidate)) { continue }
            $pkg = Join-Path $candidate "package.json"
            $pred = Join-Path $candidate "src\core\predictions.js"
            if ((Test-Path -LiteralPath $pkg) -and (Test-Path -LiteralPath $pred)) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        } catch {
            continue
        }
    }

    throw "Could not locate repo root. Pass -WorkspaceRoot explicitly."
}

function Import-DotEnvIfPresent {
    param([string]$RootPath)
    $envFile = Join-Path $RootPath ".env"
    if (-not (Test-Path -LiteralPath $envFile)) { return }

    Write-Info "Loading process env from .env"
    $lines = Get-Content -LiteralPath $envFile
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        if ($trimmed.StartsWith("#")) { continue }
        if (-not $trimmed.Contains("=")) { continue }
        $parts = $trimmed.Split("=", 2)
        $key = $parts[0].Trim()
        $value = $parts[1].Trim().Trim("'").Trim('"')
        if (-not $key) { continue }
        if (-not [Environment]::GetEnvironmentVariable($key, "Process")) {
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Show-LlmEnvStatus {
    $keys = @(
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_API_KEY",
        "GEMINI_API_KEY",
        "LLM_MODEL"
    )

    Write-Host ""
    Write-Host "LLM env status:"
    foreach ($k in $keys) {
        $v = [Environment]::GetEnvironmentVariable($k, "Process")
        if ($v) {
            $masked = if ($v.Length -ge 8) { $v.Substring(0, 4) + "..." + $v.Substring($v.Length - 4) } else { "***set***" }
            Write-Host ("  {0,-22} {1}" -f $k, $masked) -ForegroundColor Green
        } else {
            Write-Host ("  {0,-22} {1}" -f $k, "not-set") -ForegroundColor Yellow
        }
    }
    Write-Host ""
}

function Test-TcpPort {
    param(
        [string]$TargetHost,
        [int]$Port,
        [int]$TimeoutMs = 1500
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }
        $client.EndConnect($iar) | Out-Null
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Ensure-TorFirewallPorts {
    param([int[]]$Ports)

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if (-not $isAdmin) {
        Write-Warn "Skipping firewall rule creation (not running as Administrator)."
        return
    }

    # Portproxy requires IP Helper.
    Set-Service -Name iphlpsvc -StartupType Automatic
    if ((Get-Service -Name iphlpsvc).Status -ne "Running") {
        Start-Service -Name iphlpsvc
    }

    foreach ($p in $Ports) {
        $inName = "WECRYPTO Tor Inbound TCP $p"
        $outName = "WECRYPTO Tor Outbound TCP $p"

        if (-not (Get-NetFirewallRule -DisplayName $inName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName $inName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $p -Profile Any | Out-Null
            Write-Info "Created firewall rule: $inName"
        }
        if (-not (Get-NetFirewallRule -DisplayName $outName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName $outName -Direction Outbound -Action Allow -Protocol TCP -RemotePort $p -Profile Any | Out-Null
            Write-Info "Created firewall rule: $outName"
        }

        # v4tov4 forwarding: accept remote machine traffic on this host and forward to local Tor/Privoxy.
        & netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$p | Out-Null
        & netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$p connectaddress=127.0.0.1 connectport=$p | Out-Null
        Write-Info "Enabled portproxy 0.0.0.0:$p -> 127.0.0.1:$p"
    }

}

function Invoke-NodeStep {
    param(
        [string]$Label,
        [string[]]$NodeArgs,
        [string]$RepoRoot
    )

    Write-Host ""
    Write-Host "=============================================================="
    Write-Host $Label
    Write-Host ("node " + ($NodeArgs -join " "))
    Write-Host "=============================================================="

    Push-Location $RepoRoot
    try {
        & node @NodeArgs
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

try {
    $root = Resolve-RepoRoot -Hint $WorkspaceRoot
    Write-Info "Workspace: $root"

    $null = Get-Command node -ErrorAction Stop
    $null = Get-Command npm -ErrorAction Stop

    Import-DotEnvIfPresent -RootPath $root
    Show-LlmEnvStatus

    if ($InstallDeps -or -not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
        Write-Info "Installing Node dependencies via npm install"
        Push-Location $root
        try {
            npm install
            if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
    }

    $nodePrefix = @()
    if ($UseProxy) {
        $proxyUri = [Uri]$TorHttpProxy
        if ($proxyUri.Scheme -ne "http" -and $proxyUri.Scheme -ne "https") {
            throw "TorHttpProxy must use http:// or https:// (example: http://127.0.0.1:8118)."
        }

        if ($OpenTorPorts) {
            Ensure-TorFirewallPorts -Ports @(9050, 8118, 9051)
        }

        $proxyOk = Test-TcpPort -TargetHost $proxyUri.Host -Port $proxyUri.Port -TimeoutMs 1500
        if (-not $proxyOk -and $RequireTor) {
            throw "Tor proxy not reachable at $TorHttpProxy and -RequireTor is true."
        }
        if (-not $proxyOk) {
            Write-Warn "Tor proxy not reachable at $TorHttpProxy. Continuing in direct mode."
        } else {
            [Environment]::SetEnvironmentVariable("HTTP_PROXY", $TorHttpProxy, "Process")
            [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $TorHttpProxy, "Process")
            [Environment]::SetEnvironmentVariable("http_proxy", $TorHttpProxy, "Process")
            [Environment]::SetEnvironmentVariable("https_proxy", $TorHttpProxy, "Process")
            [Environment]::SetEnvironmentVariable("NO_PROXY", "127.0.0.1,localhost", "Process")
            [Environment]::SetEnvironmentVariable("no_proxy", "127.0.0.1,localhost", "Process")
            $nodePrefix = @("--use-env-proxy")
            Write-Info "Proxy wiring active: $TorHttpProxy"
        }
    }

    $logDir = Join-Path $root "backtest-logs"
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $transcriptPath = Join-Path $logDir ("tor-retune-" + $stamp + ".log")
    Start-Transcript -Path $transcriptPath -Force | Out-Null

    try {
        if (-not $SkipWalkForward) {
            $stepArgs = @()
            $stepArgs += $nodePrefix
            $stepArgs += @(
                "backtest/walk-forward-backtest.js",
                "--days", "$Days",
                "--fold-size", "$FoldSize",
                "--test", "$TestBars",
                "--step", "$StepBars"
            )
            Invoke-NodeStep -Label "Walk-forward calibration" -NodeArgs $stepArgs -RepoRoot $root
        } else {
            Write-Warn "Skipping walk-forward step"
        }

        if (-not $SkipAdvanced) {
            $stepArgs = @()
            $stepArgs += $nodePrefix
            $stepArgs += @(
                "backtest/advanced-backtest.js",
                "--all",
                "--days", "$Days"
            )
            Invoke-NodeStep -Label "Advanced diagnostics" -NodeArgs $stepArgs -RepoRoot $root
        } else {
            Write-Warn "Skipping advanced backtest step"
        }

        if (-not $SkipOutcomeRetuner) {
            $stepArgs = @()
            $stepArgs += $nodePrefix
            $stepArgs += @(
                "backtest/outcome-retuner.js",
                "--days", "$Days",
                "--coins", "$Coins",
                "--max", "$MaxWindows"
            )
            if ($WriteWeights) { $stepArgs += "--write-weights" }
            Invoke-NodeStep -Label "Outcome retuner" -NodeArgs $stepArgs -RepoRoot $root
        } else {
            Write-Warn "Skipping outcome-retuner step"
        }
    } finally {
        Stop-Transcript | Out-Null
    }

    Write-Host ""
    Write-Host "Completed Tor retune pipeline." -ForegroundColor Green
    Write-Host "Transcript: $transcriptPath"
    Write-Host ""
    Write-Host "One-command usage:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\tor-retune.ps1 -RequireTor `$true -WriteWeights"
    Write-Host ""
} catch {
    Write-Err $_.Exception.Message
    exit 1
}
