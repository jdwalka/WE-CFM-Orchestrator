$ErrorActionPreference = "Stop"

$SourceRepo = "G:\WECRYP"
$DriveRoot = "H:\My Drive\WECRYP"
$RepoBackup = Join-Path $DriveRoot "REPO"
$SecretsBackup = Join-Path $DriveRoot "SECRETS"
$LogPath = Join-Path $DriveRoot "backup.log"

function Write-Log {
    param([string]$Message)
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    "$timestamp $Message" | Tee-Object -FilePath $LogPath -Append
}

function Assert-Repo {
    param([string]$Path)
    if (-not (Test-Path (Join-Path $Path ".git"))) {
        throw "No .git directory at $Path"
    }
}

try {
    Write-Log "Starting WECRYP backup"
    Assert-Repo $SourceRepo
    New-Item -ItemType Directory -Force -Path $RepoBackup | Out-Null

    robocopy $SourceRepo $RepoBackup /MIR `
        /XD .git node_modules WE-CRYPTO-CACHE tmp .worktrees __pycache__ dist `
        _consolidated-from-drive .tmp.driveupload .venv .codeql-results proxy we-crypto-electron `
        /XF "*.log" /NP /NFL /NDL /R:2 /W:5
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy repo failed with exit code $LASTEXITCODE"
    }
    Write-Log "Repo mirrored to $RepoBackup"

    New-Item -ItemType Directory -Force -Path $SecretsBackup | Out-Null
    robocopy (Join-Path $SourceRepo "secrets") $SecretsBackup /MIR /NP /NFL /NDL /R:2 /W:5
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy secrets failed with exit code $LASTEXITCODE"
    }
    Write-Log "Secrets mirrored to $SecretsBackup"

    $sourceHead = git -C $SourceRepo rev-parse HEAD
    Write-Log "Backup complete at source HEAD $sourceHead"
    exit 0
} catch {
    Write-Log "BACKUP FAILED: $($_.Exception.Message)"
    exit 1
}
