@echo off
setlocal enabledelayedexpansion
title WE-CRYPTO HUD (fast ASI1, no query-log inference)
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
cd /d "%SCRIPT_DIR%"

if exist "%SCRIPT_DIR%\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%SCRIPT_DIR%\.env") do (
    set "_k=%%A"
    if "!_k:~0,1!" neq "#" if "!_k!" neq "" if not "%%B" == "" set "%%A=%%B"
  )
)

set "WECRYPTO_PROFILE=hud"
set "WECRYPTO_SKIP_INFERENCE=1"
set "ASI1_PREFERRED_ACCOUNT=mauro"
set "WECRYPTO_WEB_PORT=3450"
set "WECRYPTO_OPEN_DEVTOOLS=1"

REM -- Mullvad SOCKS5 Bridge (MANDATORY) -----------------------------------
REM electron/main.js reads WECRYPTO_SWEDEN_SOCKS synchronously at module
REM load, before any async code in the app could start this bridge itself --
REM it MUST already be listening before `npx electron .` runs, or every
REM exchange call routed through the local proxy silently falls back to the
REM box's own (geo-blocked) egress IP instead of the Mullvad tunnel.
REM This used to point ASI1 at a WSL Python CONNECT proxy on 127.0.0.1:18080
REM via the (now fully removed) Tailscale Sweden exit node -- that path no
REM longer exists. ASI1 traffic goes direct now (see proxy-fetch.js
REM IGNORE_DOMAINS); this bridge is for the exchange/market-data proxy only.
echo Checking Mullvad SOCKS5 bridge...
powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 18090 >nul 2>&1
if %errorlevel% equ 0 (
    echo Mullvad SOCKS5 bridge already listening on 18090.
) else (
    echo Starting Mullvad SOCKS5 bridge...
    start "WE-CRYPTO Mullvad SOCKS5 Bridge" /min node "%SCRIPT_DIR%\cloudflared\mullvad-standalone-socks.js"
    set "MULLVAD_BRIDGE_UP=0"
    for /l %%i in (1,1,20) do (
        if "!MULLVAD_BRIDGE_UP!"=="0" (
            powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 18090 >nul 2>&1
            if !errorlevel! equ 0 (
                set "MULLVAD_BRIDGE_UP=1"
            ) else (
                timeout /t 1 /nobreak >nul
            )
        )
    )
    if "!MULLVAD_BRIDGE_UP!"=="0" (
        echo [ERROR] Mullvad SOCKS5 bridge failed to bind on 18090 after 20s.
        echo [ERROR] Check the Mullvad WireGuard tunnel ^("wecrypto-mullvad" interface^) is up
        echo [ERROR] and 10.65.50.149 is still its assigned local address.
        pause
        exit /b 1
    )
    echo Mullvad SOCKS5 bridge online.
)
set "WECRYPTO_SWEDEN_SOCKS=socks5://127.0.0.1:18090"

echo HUD instance: skip inference, icloud, port 3450, SOCKS5 via Mullvad
call npx electron .
