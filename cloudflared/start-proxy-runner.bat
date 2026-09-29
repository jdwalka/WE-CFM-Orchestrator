@echo off
echo Killing any stale proxy processes on port 3010...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3010 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"
echo Starting Proxy Bouncer on port 3010...
set "WECRYPTO_SWEDEN_SOCKS=socks5://10.13.13.2:18090"
node "%~dp0proxy-runner.js"
