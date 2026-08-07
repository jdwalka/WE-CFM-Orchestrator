@echo off
setlocal
cd /d "%~dp0.."
echo [fix-electron] cwd=%CD%
echo [fix-electron] node=% 
where node
node -e "console.log('platform=', process.platform, 'arch=', process.arch, 'node=', process.version)"

REM Remove broken/partial electron package (keep dist backup if present)
if exist "node_modules\electron" (
  echo [fix-electron] Removing broken node_modules\electron ...
  rmdir /s /q "node_modules\electron" 2>nul
  if exist "node_modules\electron" (
    echo [fix-electron] rmdir incomplete — renaming
    if exist "node_modules\electron.broken" rmdir /s /q "node_modules\electron.broken" 2>nul
    move "node_modules\electron" "node_modules\electron.broken"
  )
)

echo [fix-electron] npm install electron@41.7.1 (package metadata)...
call npm install electron@41.7.1 --legacy-peer-deps --no-fund --no-audit --ignore-scripts
if errorlevel 1 (
  echo [fix-electron] FAILED npm install
  exit /b 1
)

if not exist "node_modules\electron\cli.js" (
  echo [fix-electron] cli.js still missing
  dir "node_modules\electron"
  exit /b 1
)

echo [fix-electron] Downloading + extracting Windows binary...
cd /d "%CD%\node_modules\electron"
set force_no_cache=true
node -e "const {downloadArtifact}=require('@electron/get'); const {version}=require('./package'); downloadArtifact({version, artifactName:'electron', force:true, platform:'win32', arch:'x64'}).then(async (zip)=>{ console.log('zip', zip); const ps=require('child_process'); require('fs').rmSync('dist',{recursive:true,force:true}); require('fs').mkdirSync('dist',{recursive:true}); ps.execFileSync('powershell',['-NoProfile','-Command',\"Expand-Archive -LiteralPath '\"+zip+\"' -DestinationPath '\"+require('path').resolve('dist')+\"' -Force\"],{stdio:'inherit'}); require('fs').writeFileSync('path.txt','electron.exe'); console.log('done'); }).catch(e=>{console.error(e); process.exit(1);})"
if errorlevel 1 (
  echo [fix-electron] FAILED binary extract
  exit /b 1
)
cd /d "%~dp0.."

if not exist "node_modules\electron\dist\electron.exe" (
  echo [fix-electron] electron.exe still missing
  dir "node_modules\electron\dist"
  exit /b 1
)

echo [fix-electron] OK
type "node_modules\electron\path.txt"
echo.
call npx electron --version
exit /b 0

