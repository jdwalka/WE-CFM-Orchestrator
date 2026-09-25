@echo off
title Install WeCrypto Mullvad WireGuard Tunnel
:: Check for Administrator privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Elevating with UAC...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

echo [1/3] Copying WireGuard configuration...
copy /Y "%~dp0wecrypto-mullvad.conf" "C:\Windows\Temp\wecrypto-mullvad.conf"

echo [2/3] Installing WireGuard tunnel service...
"C:\Program Files\WireGuard\wireguard.exe" /installtunnelservice "C:\Windows\Temp\wecrypto-mullvad.conf"

echo [3/3] Checking status...
timeout /t 2 /nobreak >nul
sc query "WireGuardTunnel$wecrypto-mullvad"

echo.
echo WireGuard WeCrypto Mullvad tunnel installed!
echo You can now restart WeCrypto HUD.
pause
