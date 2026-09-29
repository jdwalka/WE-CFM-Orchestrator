param(
    [string]$DeployDrive = "F:"
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

Write-Host "Starting build-and-deploy (deploy drive: $DeployDrive)"

# Ensure Python exists (try python, py, python3)
$python = $null
foreach ($cmd in @('python','py','python3')) {
    $c = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($c) { $python = $cmd; break }
}
if (-not $python) {
    Write-Host "Python not found in PATH. Please install Python 3.11+ and ensure 'python' or 'py' is on PATH." -ForegroundColor Red
    exit 1
}

Write-Host "Installing Python dependencies (PyInstaller, numpy, scipy, requests)..."
& $python -m pip install --upgrade pip setuptools wheel
& $python -m pip install pyinstaller numpy scipy requests

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$pyBuildRoot = Join-Path $scriptDir "build\pyinstaller-$stamp"
$pyDistDir = Join-Path $pyBuildRoot "dist"
$pyWorkDir = Join-Path $pyBuildRoot "work"
New-Item -ItemType Directory -Path $pyDistDir, $pyWorkDir -Force | Out-Null

Write-Host "Building backtest-regime.exe with PyInstaller..."
& $python -m PyInstaller --onefile --name "backtest-regime-$stamp" --distpath $pyDistDir --workpath $pyWorkDir --specpath $pyBuildRoot backtest-regime.py

$exePath = Join-Path $pyDistDir "backtest-regime-$stamp.exe"
if (!(Test-Path $exePath)) {
    Write-Host "PyInstaller did not produce expected exe at $exePath" -ForegroundColor Red
    exit 1
}

# Ensure Tauri resources folder exists
$resourceDir = Join-Path $scriptDir "we-crypto-cfm-tauri\src-tauri\resources"
if (!(Test-Path $resourceDir)) { New-Item -ItemType Directory -Path $resourceDir | Out-Null }
Copy-Item -Path $exePath -Destination (Join-Path $resourceDir "backtest-regime.exe") -Force
Write-Host "Copied backtest-regime.exe to Tauri resources"

# Build Tauri app
Set-Location (Join-Path $scriptDir "we-crypto-cfm-tauri")
Write-Host "Installing Node dependencies (npm install)..."
npm install

Write-Host "Building Tauri app (npm run build)... This may take several minutes."
npm run build

# Locate built exe
$releaseDir = Join-Path $scriptDir "we-crypto-cfm-tauri\src-tauri\target\release"
$exeFiles = Get-ChildItem -Path $releaseDir -Filter *.exe -Recurse -ErrorAction SilentlyContinue | Sort-Object Length -Descending
if ($exeFiles.Count -eq 0) {
    # Try bundle folder
    $bundleDir = Join-Path $releaseDir "bundle"
    $exeFiles = Get-ChildItem -Path $bundleDir -Filter *.exe -Recurse -ErrorAction SilentlyContinue | Sort-Object Length -Descending
}
if ($exeFiles.Count -eq 0) {
    Write-Host "Built exe not found. Check Tauri build output under src-tauri/target/release." -ForegroundColor Red
    exit 1
}
$builtExe = $exeFiles[0].FullName
Write-Host "Found built exe: $builtExe"

# Copy to drive root
$driveRoot = $DeployDrive.TrimEnd('\') + '\\'
$dest = Join-Path $driveRoot (Split-Path $builtExe -Leaf)
if (Test-Path $dest) {
    $name = [IO.Path]::GetFileNameWithoutExtension($dest)
    $ext = [IO.Path]::GetExtension($dest)
    $dest = Join-Path $driveRoot "$name-$stamp$ext"
}
if (Test-Path $dest) {
    Write-Host "Refusing to overwrite existing executable: $dest" -ForegroundColor Red
    exit 1
}
Write-Host "Copying to $dest"
Copy-Item -Path $builtExe -Destination $dest

Write-Host "Done. Deployed to $dest" -ForegroundColor Green
Write-Host "Note: Writing to root of drive may require elevated privileges." -ForegroundColor Yellow
