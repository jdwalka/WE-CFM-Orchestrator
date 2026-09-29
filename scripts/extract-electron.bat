@echo off
cd /d G:\WECRYP\node_modules\electron
set ZIP=C:\Users\gitgo\AppData\Local\electron\Cache\41f75cbba485232952392e289c1387621dafcedca8b27110f725ed0c4196575f\electron-v41.7.1-win32-x64.zip
echo ZIP size:
dir "%ZIP%"
rmdir /s /q dist 2>nul
mkdir dist
echo Extracting with PowerShell...
powershell -NoProfile -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath 'G:\WECRYP\node_modules\electron\dist' -Force"
if errorlevel 1 (
  echo Expand-Archive failed, trying tar...
  tar -xf "%ZIP%" -C dist
)
echo path.txt...
echo electron.exe> path.txt
dir dist
if exist dist\electron.exe (
  echo SUCCESS
  for %%I in (dist\electron.exe) do echo size=%%~zI
) else (
  echo FAIL no electron.exe
)
