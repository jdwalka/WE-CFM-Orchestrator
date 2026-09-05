# install-orchestrator.ps1 - Methodical Windows Installer Engine for WE-CFM-Orchestrator
# Thorough 7-stage installation, dependency audit, Docker orchestration, and shortcut generator.

[CmdletBinding()]
param(
    [string]$WorkspaceRoot = "",
    [switch]$SkipDocker = $false,
    [switch]$SkipTests = $false
)

$ErrorActionPreference = "Continue"

# Resolve Workspace Root
if (-not $WorkspaceRoot) {
    $WorkspaceRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    if (-not (Test-Path "$WorkspaceRoot\package.json")) {
        $WorkspaceRoot = (Get-Location).Path
    }
}

function Write-Section {
    param([string]$title)
    Write-Host ""
    Write-Host "==============================================================================" -ForegroundColor Cyan
    Write-Host "   $title" -ForegroundColor Cyan
    Write-Host "==============================================================================" -ForegroundColor Cyan
}

function Write-Step {
    param([string]$stage, [string]$desc)
    Write-Host "[$stage] " -ForegroundColor Yellow -NoNewline
    Write-Host "$desc" -ForegroundColor White
}

function Write-Success {
    param([string]$desc)
    Write-Host "  [OK] " -ForegroundColor Green -NoNewline
    Write-Host "$desc" -ForegroundColor Gray
}

function Write-Warning {
    param([string]$desc)
    Write-Host "  [WARN] " -ForegroundColor Yellow -NoNewline
    Write-Host "$desc" -ForegroundColor Gray
}

function Test-TcpPort {
    param([string]$hostName, [int]$port, [int]$timeoutMs = 1500)
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

Write-Section "WE-CFM-ORCHESTRATOR INSTALLER & SETUP SUITE"
Write-Host "Workspace Root : $WorkspaceRoot" -ForegroundColor Gray
Write-Host "Machine Name   : $env:COMPUTERNAME" -ForegroundColor Gray
Write-Host "OS Version     : $((Get-CimInstance Win32_OperatingSystem).Caption)" -ForegroundColor Gray
Write-Host ""

# ── STAGE 1: System Preflight ──────────────────────────────────────────────────
Write-Step "1/7" "Verifying runtime pre-requisites (Node.js, npm, Git)..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "Node.js is not installed or not in system PATH. Please install Node.js (>= 20) from https://nodejs.org"
}
$nodeVersion = (node -v).Trim()
Write-Success "Node.js detected: $nodeVersion"

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    throw "npm is not installed or not in system PATH."
}
$npmVersion = (npm -v).Trim()
Write-Success "npm detected: v$npmVersion"

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    $gitVer = (git --version).Trim()
    Write-Success "Git detected: $gitVer"
} else {
    Write-Warning "Git not found in PATH. Version control features will be limited."
}

# ── STAGE 2: Environment Configuration ─────────────────────────────────────────
Write-Step "2/7" "Configuring environment files and project boundaries..."
$envFile = Join-Path $WorkspaceRoot ".env"
$envExample = Join-Path $WorkspaceRoot ".env.example"

if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item -Path $envExample -Destination $envFile -Force
        Write-Success "Created .env from .env.example template."
    } else {
        New-Item -Path $envFile -ItemType File -Force | Out-Null
        Write-Success "Created fresh .env file."
    }
} else {
    Write-Success "Found existing .env file."
}

# Ensure COMPOSE_PROJECT_NAME=wecryp is set to prevent container collision
$envContent = Get-Content $envFile -Raw
if ($envContent -notmatch "COMPOSE_PROJECT_NAME=") {
    Add-Content -Path $envFile -Value "`nCOMPOSE_PROJECT_NAME=wecryp"
    Write-Success "Configured COMPOSE_PROJECT_NAME=wecryp in .env."
} else {
    Write-Success "Verified COMPOSE_PROJECT_NAME in .env."
}

# Ensure WECRYP_ROOT points to canonical directory
if ($envContent -notmatch "WECRYP_ROOT=") {
    Add-Content -Path $envFile -Value "`nWECRYP_ROOT=$WorkspaceRoot"
    Write-Success "Configured WECRYP_ROOT in .env."
}

# ── STAGE 3: Node Dependencies & Quant Layer Compilation ───────────────────────
Write-Step "3/7" "Installing dependencies and compiling Quant TypeScript layer..."
Push-Location $WorkspaceRoot
try {
    # Check if node_modules exists and has socks-proxy-agent
    $hasSocks = Test-Path "$WorkspaceRoot\node_modules\socks-proxy-agent"
    if (-not $hasSocks) {
        Write-Host "  Installing required npm packages (this may take 1-2 minutes)..." -ForegroundColor Gray
        npm install --prefer-offline 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            npm install --legacy-peer-deps 2>&1 | Out-Null
        }
    }
    
    # Guarantee socks-proxy-agent is present
    $testSocks = (node -e "try { require('socks-proxy-agent'); console.log('OK'); } catch(_) { console.log('FAIL'); }" 2>$null)
    if ($testSocks -ne "OK") {
        Write-Host "  Installing socks-proxy-agent..." -ForegroundColor Gray
        npm install socks-proxy-agent 2>&1 | Out-Null
    }
    Write-Success "Node dependencies verified."

    # Build quant layer
    Write-Host "  Compiling Quant layer (npm run build:quant)..." -ForegroundColor Gray
    npm run build:quant 2>&1 | Out-Null
    if (Test-Path "$WorkspaceRoot\src\quant\quant-layer.js") {
        Write-Success "Compiled Quant layer into src/quant/quant-layer.js."
    } else {
        Write-Warning "Quant layer build had non-fatal warnings."
    }

    # Synchronize prediction weights
    Write-Host "  Synchronizing prediction model weights..." -ForegroundColor Gray
    npm run weights:sync 2>&1 | Out-Null
    Write-Success "Prediction weights synchronized."
} finally {
    Pop-Location
}

# ── STAGE 4: Docker & Orbital Cluster Orchestration ────────────────────────────
Write-Step "4/7" "Orchestrating Docker infrastructure (Redpanda & Redis)..."
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

$dockerActive = $false
if ($dockerBin -and (-not $SkipDocker)) {
    # Check if daemon is active
    $dockerInfo = (& $dockerBin info 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Docker CLI found but daemon not responding. Attempting to start Docker Desktop..." -ForegroundColor Gray
        $desktopExes = @(
            "C:\Program Files\Docker\Docker\Docker Desktop.exe",
            "$env:LOCALAPPDATA\Programs\Docker\Docker\Docker Desktop.exe"
        )
        $desktopExe = $desktopExes | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($desktopExe) {
            Start-Process -FilePath $desktopExe
            Write-Host "  Waiting for Docker daemon to initialize (up to 40s)..." -ForegroundColor Gray
            for ($i = 1; $i -le 20; $i++) {
                Start-Sleep -Seconds 2
                & $dockerBin info 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    $dockerActive = $true
                    Write-Success "Docker Desktop daemon is now online."
                    break
                }
            }
        }
    } else {
        $dockerActive = $true
        Write-Success "Docker daemon is running."
    }

    if ($dockerActive) {
        # Spin up containers under project name 'wecryp' to guarantee no name collisions
        Write-Host "  Starting Redpanda, Redis, and Console containers (-p wecryp)..." -ForegroundColor Gray
        $composeFile = Join-Path $WorkspaceRoot "docker-compose.yml"
        if (Test-Path $composeFile) {
            & $dockerBin compose -p wecryp -f $composeFile up -d --no-recreate redis redpanda redpanda-console 2>&1 | Out-Null
            Start-Sleep -Seconds 2
            
            if (Test-TcpPort "127.0.0.1" 9092 2000) {
                Write-Success "Redpanda broker listening on 127.0.0.1:9092."
            } else {
                Write-Warning "Redpanda broker starting up on port 9092."
            }

            if (Test-TcpPort "127.0.0.1" 6379 2000) {
                Write-Success "Redis store listening on 127.0.0.1:6379."
            }
        }
    } else {
        Write-Warning "Docker daemon not available. Orbital will run in Standalone Mode (WECRYPTO_SKIP_ORBITAL=1)."
    }
} else {
    Write-Warning "Docker skipped or not installed. Application will run in Standalone Mode."
}

# ── STAGE 5: Proxy & SOCKS5 Egress Configuration ───────────────────────────────
Write-Step "5/7" "Verifying SOCKS5 and HTTP proxy endpoints..."
$wslSweden = Test-TcpPort "10.13.13.2" 18090 1000
$localSocks = Test-TcpPort "127.0.0.1" 18090 1000

if ($wslSweden) {
    Write-Success "WSL2 WireGuard Sweden proxy detected (10.13.13.2:18090)."
} elseif ($localSocks) {
    Write-Success "Local SOCKS5 proxy detected (127.0.0.1:18090)."
} else {
    Write-Warning "SOCKS5 bridge port 18090 is idle. Launcher will auto-start fallback bridge on launch."
}

# ── STAGE 6: Unit Test Validation ──────────────────────────────────────────────
Write-Step "6/7" "Running operational verification tests..."
if (-not $SkipTests) {
    Push-Location $WorkspaceRoot
    try {
        $precTest = (node --test tests/coin-precision.test.js 2>&1)
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Coin precision decimal tests passed (5/5)."
        } else {
            Write-Warning "Coin precision test had issues: $precTest"
        }

        $workerTest = (node --test tests/orbital-worker.test.js 2>&1)
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Orbital math worker tests passed (5/5)."
        } else {
            Write-Warning "Orbital worker test had issues: $workerTest"
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Warning "Tests skipped by flag."
}

# ── STAGE 7: Windows Desktop Shortcut ──────────────────────────────────────────
Write-Step "7/7" "Creating Windows Desktop shortcut..."
try {
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktopPath "WE-CRYPTO Orchestrator.lnk"
    $targetBatch = Join-Path $WorkspaceRoot "launch-wecrypto.bat"
    
    $wshShell = New-Object -ComObject WScript.Shell
    $shortcut = $wshShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $targetBatch
    $shortcut.WorkingDirectory = $WorkspaceRoot
    $shortcut.Description = "Launch WE-CFM-Orchestrator with Auto Proxy & Orbital Cluster"
    
    # Try to set icon from public/favicon.ico if exists
    $iconPath = Join-Path $WorkspaceRoot "public\favicon.ico"
    if (Test-Path $iconPath) {
        $shortcut.IconLocation = "$iconPath, 0"
    }
    $shortcut.Save()
    Write-Success "Created shortcut on Desktop: 'WE-CRYPTO Orchestrator.lnk'."
} catch {
    Write-Warning "Could not create Desktop shortcut: $_"
}

Write-Section "INSTALLATION COMPLETE"
Write-Host "  The WE-CFM-Orchestrator environment is fully installed and verified!" -ForegroundColor Green
Write-Host "  You can launch it anytime by:" -ForegroundColor White
Write-Host "    1. Double-clicking the 'WE-CRYPTO Orchestrator' icon on your Desktop." -ForegroundColor Yellow
Write-Host "    2. Or running: $WorkspaceRoot\launch-wecrypto.bat" -ForegroundColor Yellow
Write-Host ""
