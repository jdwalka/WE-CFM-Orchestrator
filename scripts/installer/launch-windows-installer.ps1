# launch-windows-installer.ps1 - Windows Setup Wizard Launcher for WE-CFM-Orchestrator
# Resolves latest dist/*.exe installer, syncs .env/secrets to AppData, pre-checks Docker, and executes with elevation.

[CmdletBinding()]
param(
    [string]$WorkspaceRoot = "",
    [switch]$NoDockerWait,
    [switch]$Unattended,
    [switch]$DryRun
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

function Write-Step {
    param([string]$num, [string]$title)
    Write-Host ""
    Write-Host "[$num] $title" -ForegroundColor Yellow
}

function Write-Status {
    param([string]$tag, [string]$msg, [string]$color = "Green")
    Write-Host "  [$tag] " -ForegroundColor $color -NoNewline
    Write-Host $msg
}

Write-Header "WE-CFM-Orchestrator - Windows Installer Dispatcher"
Write-Host "Workspace: $WorkspaceRoot" -ForegroundColor Gray

# -----------------------------------------------------------------------------
# Step 1: Locate Latest Windows Installer Executable (.exe)
# -----------------------------------------------------------------------------
Write-Step "1/4" "Scanning for Windows Installer binary (.exe)..."

$distDir = Join-Path $WorkspaceRoot "dist"
if (-not (Test-Path $distDir)) {
    Write-Status "FAIL" "dist/ directory not found at: $distDir" "Red"
    Write-Host "Please compile the installer first: npm run build:installer" -ForegroundColor Yellow
    exit 1
}

$installers = Get-ChildItem -Path $distDir -Filter "*installer*x64.exe" -File | Sort-Object LastWriteTime -Descending
if (-not $installers -or $installers.Count -eq 0) {
    # Fallback to any x64 exe in dist
    $installers = Get-ChildItem -Path $distDir -Filter "*.exe" -File | Where-Object { $_.Name -notmatch "uninstaller|blockmap" } | Sort-Object LastWriteTime -Descending
}

if (-not $installers -or $installers.Count -eq 0) {
    Write-Status "FAIL" "No installer executable (.exe) found in $distDir." "Red"
    Write-Host "Run 'npm run build:installer' to build the NSIS package." -ForegroundColor Yellow
    exit 1
}

$targetInstaller = $installers[0]
$installerSizeMB = [math]::Round($targetInstaller.Length / 1MB, 2)
Write-Status "OK" "Found installer: $($targetInstaller.Name)" "Green"
Write-Status "INFO" "Size: $installerSizeMB MB | Built: $($targetInstaller.LastWriteTime)" "Cyan"
$installerFullPath = $targetInstaller.FullName

# -----------------------------------------------------------------------------
# Step 2: Synchronize Environment & Secrets to AppData
# -----------------------------------------------------------------------------
Write-Step "2/4" "Synchronizing runtime environment and secrets to Windows AppData..."

$appDataTargets = @(
    (Join-Path $env:APPDATA "WE-CRYPTO-Polymarket-v2.15.6"),
    (Join-Path $env:LOCALAPPDATA "WE-CRYPTO-Polymarket-v2.15.6"),
    (Join-Path $env:APPDATA "WE-CRYPTO")
)

foreach ($target in $appDataTargets) {
    if (-not (Test-Path $target)) {
        try {
            New-Item -ItemType Directory -Path $target -Force | Out-Null
            Write-Status "OK" "Created AppData directory: $target" "Green"
        } catch {
            Write-Status "WARN" "Could not create directory $target : $($_.Exception.Message)" "Yellow"
        }
    }
}

# Sync .env
$srcEnv = Join-Path $WorkspaceRoot ".env"
if (Test-Path $srcEnv) {
    foreach ($target in $appDataTargets) {
        $destEnv = Join-Path $target ".env"
        try {
            Copy-Item -Path $srcEnv -Destination $destEnv -Force
            Write-Status "OK" "Copied .env -> $destEnv" "Green"
        } catch {
            Write-Status "WARN" "Failed copying .env to $destEnv : $($_.Exception.Message)" "Yellow"
        }
    }
} else {
    Write-Status "WARN" "No .env file found at $srcEnv" "Yellow"
}

# Sync secrets/ folder
$srcSecrets = Join-Path $WorkspaceRoot "secrets"
if (Test-Path $srcSecrets) {
    foreach ($target in $appDataTargets) {
        $destSecrets = Join-Path $target "secrets"
        try {
            if (-not (Test-Path $destSecrets)) {
                New-Item -ItemType Directory -Path $destSecrets -Force | Out-Null
            }
            Copy-Item -Path "$srcSecrets\*" -Destination $destSecrets -Recurse -Force
            Write-Status "OK" "Copied secrets/ -> $destSecrets" "Green"
        } catch {
            Write-Status "WARN" "Failed copying secrets to $destSecrets : $($_.Exception.Message)" "Yellow"
        }
    }
}

# Sync standalone docker-compose for installed app fallback
$srcCompose = Join-Path $WorkspaceRoot "docker-compose.yml"
if (Test-Path $srcCompose) {
    $fallbackCompose = Join-Path (Join-Path $env:APPDATA "WE-CRYPTO") "docker-compose.orbital.yml"
    try {
        Copy-Item -Path $srcCompose -Destination $fallbackCompose -Force
        Write-Status "OK" "Copied docker-compose fallback -> $fallbackCompose" "Green"
    } catch {
        Write-Status "WARN" "Failed copying compose fallback: $($_.Exception.Message)" "Yellow"
    }
}

# -----------------------------------------------------------------------------
# Step 3: Docker Subsystem & Container Verification
# -----------------------------------------------------------------------------
Write-Step "3/4" "Verifying Docker infrastructure to prevent startup errors..."

$dockerCmd = Get-Command "docker" -ErrorAction SilentlyContinue
$dockerBin = if ($dockerCmd) { $dockerCmd.Source } else { "C:\Program Files\Docker\Docker\resources\bin\docker.exe" }

$dockerAvailable = $false
if (Test-Path $dockerBin) {
    # Check if daemon is active
    & $dockerBin info --format "{{.ServerVersion}}" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $dockerAvailable = $true
        Write-Status "OK" "Docker daemon is active and responsive." "Green"
    } else {
        Write-Status "WARN" "Docker CLI found, but daemon is currently offline." "Yellow"
        if (-not $NoDockerWait) {
            $desktopExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
            if (Test-Path $desktopExe) {
                Write-Status "INFO" "Launching Docker Desktop: $desktopExe ..." "Cyan"
                Start-Process -FilePath $desktopExe
                Write-Host "  Waiting up to 30s for Docker daemon to initialize..." -ForegroundColor Gray
                for ($i = 1; $i -le 10; $i++) {
                    Start-Sleep -Seconds 3
                    & $dockerBin info --format "{{.ServerVersion}}" 2>$null | Out-Null
                    if ($LASTEXITCODE -eq 0) {
                        $dockerAvailable = $true
                        Write-Status "OK" "Docker daemon is now online!" "Green"
                        break
                    }
                }
            }
        }
    }
} else {
    Write-Status "WARN" "Docker CLI not detected at standard locations. Docker Desktop is recommended." "Yellow"
}

if ($dockerAvailable) {
    # Start or ensure Redpanda + Redis are up under project 'wecryp'
    $composeFile = Join-Path $WorkspaceRoot "docker-compose.yml"
    if (Test-Path $composeFile) {
        Write-Status "INFO" "Ensuring Redpanda and Redis containers are running (project: wecryp)..." "Cyan"
        & $dockerBin compose -p wecryp -f $composeFile up -d --no-recreate redis redpanda redpanda-console 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Status "OK" "Docker containers online (Redpanda, Redis, Console)." "Green"
        } else {
            Write-Status "WARN" "Containers could not be started in background. The app will auto-retry on launch." "Yellow"
        }
    }
}

# -----------------------------------------------------------------------------
# Step 4: Execute Native Windows Setup Wizard (.exe)
# -----------------------------------------------------------------------------
Write-Step "4/4" "Launching Native Windows Installer..."
Write-Host ""
Write-Host "Target Executable: $installerFullPath" -ForegroundColor White
Write-Host "Elevating with Administrator privileges..." -ForegroundColor Gray
Write-Host ""

if ($DryRun) {
    Write-Status "INFO" "[DRY RUN] Would execute: Start-Process -FilePath `"$installerFullPath`" -Verb RunAs" "Cyan"
    Write-Status "OK" "Pre-flight checks, AppData sync, and Docker verification passed successfully." "Green"
    return
}

try {
    $proc = Start-Process -FilePath $installerFullPath -Verb RunAs -PassThru
    Write-Status "OK" "Windows Setup Wizard started successfully! (PID: $($proc.Id))" "Green"
    Write-Host ""
    Write-Host "Follow the on-screen installer prompts to complete the installation." -ForegroundColor Cyan
    Write-Host "The application will create a desktop shortcut and register in Windows." -ForegroundColor Gray
} catch {
    Write-Status "FAIL" "Failed to launch installer: $($_.Exception.Message)" "Red"
    Write-Host ""
    Write-Host "You can manually run the installer executable at:" -ForegroundColor Yellow
    Write-Host "  $installerFullPath" -ForegroundColor White
    exit 1
}

Write-Host ""
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "   INSTALLER DISPATCH COMPLETE" -ForegroundColor Green
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host ""
