@echo off
echo ========================================================
echo FORCE UNINSTALL WE-CRYPTO-Kalshi-15m-v2.15.5
echo ========================================================
echo.
echo Checking for Administrator privileges...
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Success: Administrative permissions confirmed.
) else (
    echo Failure: Current permissions inadequate.
    echo Please right-click this script and select "Run as Administrator".
    pause
    exit /b
)

echo.
echo 1. Killing any lingering processes...
taskkill /F /IM "WE-CRYPTO*" >nul 2>&1
taskkill /F /IM "we-crypto-proxy.exe" >nul 2>&1
taskkill /F /IM "Uninstall WE-CRYPTO*" >nul 2>&1
taskkill /F /IM "elevate.exe" >nul 2>&1

echo.
echo 2. Deleting installation directory...
if exist "E:\Program Files\WE-CRYPTO-Kalshi-15m-v2.15.5" (
    rmdir /S /Q "E:\Program Files\WE-CRYPTO-Kalshi-15m-v2.15.5"
    echo Deleted E:\Program Files\WE-CRYPTO-Kalshi-15m-v2.15.5
) else (
    echo Directory not found, skipping.
)

echo.
echo 3. Deleting uninstaller Registry Key...
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\f2bd8446-8c24-5f37-9740-e049c62fdde1" /f >nul 2>&1
echo Registry keys purged.

echo.
echo ========================================================
echo CLEANUP COMPLETE! 
echo You can now safely run the new installer.
echo ========================================================
pause
