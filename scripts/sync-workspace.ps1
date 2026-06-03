param(
    [switch]$Force = $false
)

$ErrorActionPreference = "Stop"

Write-Host "=================================================="
Write-Host " WE-CFM Orchestrator - Workspace Sync Tool "
Write-Host "=================================================="
Write-Host ""

$WorkspaceRoot = $PSScriptRoot
$SecretsDest = Join-Path $WorkspaceRoot "secrets"
$EnvDest = Join-Path $WorkspaceRoot ".env"

if (-not (Test-Path $SecretsDest)) {
    New-Item -ItemType Directory -Path $SecretsDest | Out-Null
    Write-Host "[+] Created local secrets directory: $SecretsDest"
}

# 1. Discover cloud backup locations across all mounted drives
$PotentialRoots = @()

# Drive letters C: through Z:
for ($i = 67; $i -le 90; $i++) {
    $drive = [char]$i + ":\"
    if (Test-Path $drive) {
        $PotentialRoots += Join-Path $drive "WECRYP"
        $PotentialRoots += Join-Path $drive "My Drive\WECRYP"
        $PotentialRoots += Join-Path $drive "Google Drive\WECRYP"
    }
}

# User profile directory for locally synced Google Drive folders
$userProfile = [Environment]::GetFolderPath("UserProfile")
if (Test-Path $userProfile) {
    $PotentialRoots += Join-Path $userProfile "Google Drive\WECRYP"
    $PotentialRoots += Join-Path $userProfile "Google Drive (maurofanellijr@gmail.com)\WECRYP"
    $PotentialRoots += Join-Path $userProfile "Google Drive (gitgoin87@gmail.com)\WECRYP"
    $PotentialRoots += Join-Path $userProfile "My Drive\WECRYP"
}

$FoundSecretsPath = $null
$FoundEnvPath = $null

foreach ($root in $PotentialRoots) {
    if (Test-Path $root) {
        $secPath = Join-Path $root "secrets"
        $envPath = Join-Path $root ".env"
        
        if (Test-Path $secPath) {
            $FoundSecretsPath = $secPath
            $FoundRoot = $root
            if (Test-Path $envPath) {
                $FoundEnvPath = $envPath
            }
            Write-Host "[*] Found cloud backup at: $root"
            break
        }
    }
}

if (-not $FoundSecretsPath) {
    Write-Warning "[-] Could not automatically locate 'WECRYP\secrets' on any drive."
    Write-Warning "    Ensure your Google Drive or cloud storage is mounted and accessible."
    Exit 1
}

# 2. Sync Secrets
Write-Host "[*] Syncing secrets from: $FoundSecretsPath -> $SecretsDest"
$secretFiles = Get-ChildItem -Path $FoundSecretsPath -File
$syncedCount = 0

foreach ($file in $secretFiles) {
    $destFile = Join-Path $SecretsDest $file.Name
    if ($Force -or -not (Test-Path $destFile) -or (Get-Item $file.FullName).LastWriteTime -gt (Get-Item $destFile).LastWriteTime) {
        Copy-Item -Path $file.FullName -Destination $destFile -Force
        $syncedCount++
    }
}

Write-Host "[+] Synced $syncedCount secret files."

# 3. Sync .env
if ($FoundEnvPath) {
    Write-Host "[*] Syncing environment config: $FoundEnvPath -> $EnvDest"
    if ($Force -or -not (Test-Path $EnvDest) -or (Get-Item $FoundEnvPath).LastWriteTime -gt (Get-Item $EnvDest).LastWriteTime) {
        Copy-Item -Path $FoundEnvPath -Destination $EnvDest -Force
        Write-Host "[+] .env synced successfully."
    } else {
        Write-Host "[-] Local .env is up to date."
    }
}

# 4. Bind Cloud Storage Data Path for infinite context storage
$CloudDataPath = Join-Path $FoundRoot "data"
if (-not (Test-Path $CloudDataPath)) {
    New-Item -ItemType Directory -Path $CloudDataPath | Out-Null
    Write-Host "[+] Created cloud data directory: $CloudDataPath"
}
$EnvEntry = "WECRYPTO_CLOUD_DATA_PATH=$CloudDataPath"
if (Test-Path $EnvDest) {
    $envContent = Get-Content $EnvDest
    if ($envContent -notmatch "^WECRYPTO_CLOUD_DATA_PATH=") {
        Add-Content -Path $EnvDest -Value "`n$EnvEntry"
        Write-Host "[+] Appended WECRYPTO_CLOUD_DATA_PATH to local .env"
    }
} else {
    Set-Content -Path $EnvDest -Value $EnvEntry
    Write-Host "[+] Created local .env with WECRYPTO_CLOUD_DATA_PATH"
}

Write-Host ""
Write-Host "[SUCCESS] Workspace is fully synced and ready for Docker!"
Write-Host "You can now safely run: docker-compose up -d"
Write-Host "=================================================="
