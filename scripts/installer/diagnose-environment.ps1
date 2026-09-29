# diagnose-environment.ps1 - Comprehensive Subsystem Diagnostic for WE-CFM-Orchestrator
# Tests Node, Docker, Redpanda, Redis, SOCKS5, HTTP Proxy, Ports, and Quant layers.

[CmdletBinding()]
param(
    [string]$WorkspaceRoot = ""
)

$ErrorActionPreference = "Continue"

# Resolve Workspace Root
if (-not $WorkspaceRoot) {
    $WorkspaceRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    if (-not (Test-Path "$WorkspaceRoot\package.json")) {
        $WorkspaceRoot = (Get-Location).Path
    }
}

function Write-Header {
    param([string]$text)
    Write-Host ""
    Write-Host "==============================================================================" -ForegroundColor Cyan
    Write-Host "   $text" -ForegroundColor Cyan
    Write-Host "==============================================================================" -ForegroundColor Cyan
}

function Write-Check {
    param(
        [string]$name,
        [string]$status,
        [string]$msg = ""
    )
    $tag = if ($status -eq "OK") { "[  OK  ]" } elseif ($status -eq "WARN") { "[ WARN ]" } else { "[ FAIL ]" }
    $color = if ($status -eq "OK") { "Green" } elseif ($status -eq "WARN") { "Yellow" } else { "Red" }
    Write-Host "$tag " -ForegroundColor $color -NoNewline
    Write-Host "$name" -NoNewline
    if ($msg) {
        Write-Host " - $msg" -ForegroundColor Gray
    } else {
        Write-Host ""
    }
}

function Test-TcpPort {
    param(
        [string]$hostName,
        [int]$port,
        [int]$timeoutMs = 1500
    )
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($hostName, $port, $null, $null)
        $wait = $iar.AsyncWaitHandle.WaitOne($timeoutMs, $false)
        if ($wait) {
            $client.EndConnect($iar)
            $client.Close()
            return $true
        } else {
            $client.Close()
            return $false
        }
    } catch {
        return $false
    }
}

Write-Header "WE-CFM-ORCHESTRATOR SUBSYSTEM DIAGNOSTICS"
Write-Host "Target Directory: $WorkspaceRoot" -ForegroundColor Gray
Write-Host ""

$allPassed = $true
$warnings = 0

# -- 1. Node.js & Tooling --------------------------------------------------------
try {
    $nodeVer = (node -v 2>$null)
    if ($nodeVer) {
        Write-Check "Node.js Runtime" "OK" "$nodeVer"
    } else {
        Write-Check "Node.js Runtime" "FAIL" "node not found in PATH"
        $allPassed = $false
    }
} catch {
    Write-Check "Node.js Runtime" "FAIL" "$_"
    $allPassed = $false
}

try {
    $npmVer = (npm -v 2>$null)
    if ($npmVer) {
        Write-Check "npm Package Manager" "OK" "v$npmVer"
    } else {
        Write-Check "npm Package Manager" "FAIL" "npm not found in PATH"
        $allPassed = $false
    }
} catch {
    Write-Check "npm Package Manager" "FAIL" "$_"
    $allPassed = $false
}

try {
    $gitVer = (git --version 2>$null)
    if ($gitVer) {
        Write-Check "Git Version Control" "OK" "$gitVer"
    } else {
        Write-Check "Git Version Control" "WARN" "git not found in PATH"
        $warnings++
    }
} catch {
    Write-Check "Git Version Control" "WARN" "$_"
    $warnings++
}

# -- 2. Configuration & Environment Files -----------------------------------------
$envPath = Join-Path $WorkspaceRoot ".env"
$envExamplePath = Join-Path $WorkspaceRoot ".env.example"

if (Test-Path $envPath) {
    $composeProject = Select-String -Path $envPath -Pattern "COMPOSE_PROJECT_NAME" -SimpleMatch 2>$null
    if ($composeProject) {
        Write-Check ".env Configuration" "OK" "Exists with COMPOSE_PROJECT_NAME set"
    } else {
        Write-Check ".env Configuration" "WARN" "Exists but COMPOSE_PROJECT_NAME missing"
        $warnings++
    }
} elseif (Test-Path $envExamplePath) {
    Write-Check ".env Configuration" "WARN" ".env missing (can copy from .env.example)"
    $warnings++
} else {
    Write-Check ".env Configuration" "FAIL" "Neither .env nor .env.example found"
    $allPassed = $false
}

# -- 3. Critical Node Dependencies ------------------------------------------------
$modulesPath = Join-Path $WorkspaceRoot "node_modules"
if (Test-Path $modulesPath) {
    Write-Check "node_modules Root" "OK" "Present"
    
    # Test socks-proxy-agent
    $testSocks = (node -e "try { require('socks-proxy-agent'); console.log('OK'); } catch(_) { console.log('FAIL'); }" 2>$null)
    if ($testSocks -eq "OK") {
        Write-Check "Dependency: socks-proxy-agent" "OK" "Loaded successfully"
    } else {
        Write-Check "Dependency: socks-proxy-agent" "FAIL" "Cannot require module"
        $allPassed = $false
    }

    # Test kafkajs
    $testKafka = (node -e "try { require('kafkajs'); console.log('OK'); } catch(_) { console.log('FAIL'); }" 2>$null)
    if ($testKafka -eq "OK") {
        Write-Check "Dependency: kafkajs" "OK" "Loaded successfully"
    } else {
        Write-Check "Dependency: kafkajs" "WARN" "kafkajs not installed (Orbital will run in standalone mode)"
        $warnings++
    }

    # Test electron
    $testElectron = (node -e "try { require('electron'); console.log('OK'); } catch(_) { console.log('FAIL'); }" 2>$null)
    if ($testElectron -eq "OK") {
        Write-Check "Dependency: electron" "OK" "Loaded successfully"
    } else {
        Write-Check "Dependency: electron" "WARN" "electron not found in node_modules"
        $warnings++
    }
} else {
    Write-Check "node_modules Root" "FAIL" "Missing completely - run npm install"
    $allPassed = $false
}

# -- 4. Quant & Model Weights Layer -----------------------------------------------
$quantFile = Join-Path $WorkspaceRoot "src\quant\quant-layer.js"
if (Test-Path $quantFile) {
    Write-Check "Quant Layer (src/quant/quant-layer.js)" "OK" "Compiled layer present"
} else {
    Write-Check "Quant Layer (src/quant/quant-layer.js)" "WARN" "Missing quant-layer.js - run npm run build:quant"
    $warnings++
}

# -- 5. Docker Daemon & Orbital Infrastructure ------------------------------------
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
$dockerBin = if ($dockerCmd) { $dockerCmd.Source } else { $null }
if (-not $dockerBin) {
    $candidates = @(
        "C:\Program Files\Docker\Docker\resources\bin\docker.exe",
        "C:\ProgramData\DockerDesktop\version-bin\docker.exe",
        "$env:LOCALAPPDATA\Programs\Docker\Docker\resources\bin\docker.exe"
    )
    foreach ($cand in $candidates) {
        if (Test-Path $cand) {
            $dockerBin = $cand
            break
        }
    }
}

if ($dockerBin) {
    Write-Check "Docker Executable" "OK" "$dockerBin"
    
    # Check daemon responsiveness
    $dockerInfo = (& $dockerBin info 2>&1)
    if ($LASTEXITCODE -eq 0) {
        Write-Check "Docker Daemon" "OK" "Daemon is active and responsive"
        
        # Check Redpanda on 9092
        $redpandaOpen = Test-TcpPort "127.0.0.1" 9092 1000
        if ($redpandaOpen) {
            Write-Check "Redpanda Broker (9092)" "OK" "Broker listening on 127.0.0.1:9092"
        } else {
            Write-Check "Redpanda Broker (9092)" "WARN" "Port 9092 closed (Redpanda not running)"
            $warnings++
        }

        # Check Redis on 6379
        $redisOpen = Test-TcpPort "127.0.0.1" 6379 1000
        if ($redisOpen) {
            Write-Check "Redis Store (6379)" "OK" "Redis listening on 127.0.0.1:6379"
        } else {
            Write-Check "Redis Store (6379)" "WARN" "Port 6379 closed (Redis not running)"
            $warnings++
        }

        # Check Redpanda Console on 8081
        $consoleOpen = Test-TcpPort "127.0.0.1" 8081 1000
        if ($consoleOpen) {
            Write-Check "Redpanda Console (8081)" "OK" "Console accessible on http://127.0.0.1:8081"
        } else {
            Write-Check "Redpanda Console (8081)" "WARN" "Port 8081 closed"
        }
    } else {
        Write-Check "Docker Daemon" "WARN" "Docker CLI exists but daemon is stopped (Start Docker Desktop)"
        $warnings++
    }
} else {
    Write-Check "Docker Executable" "WARN" "Docker CLI not found (Will run in Standalone Mode without Docker)"
    $warnings++
}

# -- 6. Networking & Proxy Egress ------------------------------------------------
$wslSweden = Test-TcpPort "10.13.13.2" 18090 1000
$localSocks = Test-TcpPort "127.0.0.1" 18090 1000
if ($wslSweden) {
    Write-Check "SOCKS5 Egress (18090)" "OK" "Active WSL2 WireGuard bridge on 10.13.13.2:18090"
} elseif ($localSocks) {
    Write-Check "SOCKS5 Egress (18090)" "OK" "Active local SOCKS5 bridge on 127.0.0.1:18090"
} else {
    Write-Check "SOCKS5 Egress (18090)" "WARN" "Port 18090 not active (Launcher will start local fallback bridge)"
}

$bouncerOpen = Test-TcpPort "127.0.0.1" 3010 1000
if ($bouncerOpen) {
    Write-Check "HTTP Proxy Bouncer (3010)" "OK" "Listening on http://127.0.0.1:3010"
} else {
    Write-Check "HTTP Proxy Bouncer (3010)" "WARN" "Port 3010 idle (Launcher will auto-spawn daemon)"
}

Write-Header "DIAGNOSTIC SUMMARY"
if ($allPassed -and ($warnings -eq 0)) {
    Write-Host "  STATUS: PERFECT - All components operational and verified." -ForegroundColor Green
    Write-Host ""
    exit 0
} elseif ($allPassed) {
    Write-Host "  STATUS: READY WITH MINOR WARNINGS - Handled automatically by launcher." -ForegroundColor Yellow
    Write-Host ""
    exit 0
} else {
    Write-Host "  STATUS: CRITICAL ISSUES DETECTED - Run INSTALL-WECRYPTO.bat to repair." -ForegroundColor Red
    Write-Host ""
    exit 1
}
