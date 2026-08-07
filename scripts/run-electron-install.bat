@echo off
cd /d G:\WECRYP\node_modules\electron
echo Cleaning dist...
rmdir /s /q dist 2>nul
mkdir dist
set force_no_cache=true
set ELECTRON_GET_USE_PROXY=
echo Starting download install.js ...
node -e "const {downloadArtifact}=require('@electron/get'); const {version}=require('./package'); console.log('version', version); downloadArtifact({version, artifactName:'electron', force:true, platform:'win32', arch:'x64'}).then(p=>{console.log('downloaded', p); process.exit(0)}).catch(e=>{console.error('FAIL', e); process.exit(1)})"
if errorlevel 1 exit /b 1
echo Running full install.js ...
node install.js
echo install_exit=%ERRORLEVEL%
dir dist
if exist path.txt (echo path.txt: & type path.txt)
if exist dist\electron.exe (echo HAS_EXE & for %%I in (dist\electron.exe) do echo size=%%~zI)
