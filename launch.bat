@echo off
setlocal enabledelayedexpansion
title WE-CFM-Orchestrator Launcher

echo.
echo ================================================================
echo    WE-CFM-Orchestrator (WE-CRYPTO) - Windows Launcher
echo ================================================================
echo.

REM -- 1. Resolve Script ^& Working Directory --------------------------
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
cd /d "%SCRIPT_DIR%"

REM -- 2. Check and Load .env -------------------------------------------
set "ENV_FILE=%SCRIPT_DIR%\.env"
if not exist "%ENV_FILE%" (
    echo [WARN] .env not found at %ENV_FILE%. Copying from .env.example if available...
    if exist "%SCRIPT_DIR%\.env.example" (
        copy "%SCRIPT_DIR%\.env.example" "%ENV_FILE%" >nul
        echo [INFO] Created .env from .env.example
    ) else (
        echo [ERROR] No .env or .env.example found!
        pause
        exit /b 1
    )
)

echo [1/7] Loading environment variables from .env...
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    set "_k=%%A"
    if "!_k:~0,1!" neq "#" if "!_k!" neq "" if not "%%B" == "" set "%%A=%%B"
)

REM -- 3. Check Dependencies ----------------------------------------------
echo [2/7] Checking node_modules...
if not exist "%SCRIPT_DIR%\node_modules" (
    echo [INFO] Installing npm dependencies...
    call npm install --legacy-peer-deps
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

REM -- 4. Build Quant Layer and Sync Weights -------------------------------
echo [3/7] Building Quant TypeScript layer...
call npm run build:quant
if %errorlevel% neq 0 (
    echo [WARN] Quant layer build had warnings or non-fatal errors, continuing...
)

echo [4/7] Synchronizing prediction weights...
call npm run weights:sync >nul 2>&1

REM -- 5. Check ^& Start Docker Infrastructure (Optional/Best Effort) ------
echo [5/7] Checking Docker infrastructure...
docker info >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Docker daemon detected. Starting Redpanda, Redis, and CORS proxy...
    docker compose up -d --no-recreate redis redpanda redpanda-console cors-proxy >nul 2>&1
    if %errorlevel% equ 0 (
        echo [INFO] Docker containers online.
        set "WECRYPTO_SKIP_ORBITAL=0"
    ) else (
        echo [WARN] Docker compose failed to start some containers. Running in standalone mode.
        set "WECRYPTO_SKIP_ORBITAL=1"
    )
) else (
    echo [WARN] Docker is not running or not in PATH.
    echo [INFO] Running in standalone mode. WECRYPTO_SKIP_ORBITAL=1
    set "WECRYPTO_SKIP_ORBITAL=1"
)

REM -- 6. Mullvad SOCKS5 Bridge (MANDATORY) ---------------------------------
REM electron/main.js reads WECRYPTO_SWEDEN_SOCKS synchronously at module
REM load, before any async code in the app could start this bridge itself --
REM it MUST already be listening before `npx electron .` runs, or every
REM exchange call routed through the local proxy silently falls back to the
REM box's own (geo-blocked) egress IP instead of the Mullvad tunnel.
echo [6/7] Checking Mullvad / WSL SOCKS5 bridge...
if not defined WECRYPTO_SWEDEN_SOCKS (
    powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 18090 -HostName 10.13.13.2 >nul 2>&1
    if !errorlevel! equ 0 (
        set "WECRYPTO_SWEDEN_SOCKS=socks5://10.13.13.2:18090"
        echo [INFO] WSL WireGuard SOCKS5 bridge detected on 10.13.13.2:18090.
    ) else (
        powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 18090 >nul 2>&1
        if !errorlevel! equ 0 (
            set "WECRYPTO_SWEDEN_SOCKS=socks5://127.0.0.1:18090"
            echo [INFO] Local SOCKS5 bridge detected on 127.0.0.1:18090.
        ) else (
            echo [INFO] Starting local Mullvad SOCKS5 bridge...
            start "WE-CRYPTO Mullvad SOCKS5 Bridge" /min node "%SCRIPT_DIR%\cloudflared\mullvad-standalone-socks.js"
            set "WECRYPTO_SWEDEN_SOCKS=socks5://127.0.0.1:18090"
        )
    )
)

echo [6b/7] Launching HTTP proxy bouncer on port 3010...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3010 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
start "WE-CRYPTO Proxy Bouncer (Port 3010)" /min node "%SCRIPT_DIR%\cloudflared\proxy-runner.js"

set "PROXY_BOUND=0"
for /l %%i in (1,1,10) do (
    if "!PROXY_BOUND!"=="0" (
        powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 3010 -HostName 127.0.0.1 >nul 2>&1
        if !errorlevel! equ 0 ( set "PROXY_BOUND=1" ) else ( timeout /t 1 /nobreak >nul )
    )
)
if "!PROXY_BOUND!"=="1" (
    echo [INFO] HTTP proxy bouncer active on http://127.0.0.1:3010
) else (
    echo [WARN] Proxy bouncer did not bind immediately; Electron internal fallback ready.
)

REM -- 7. Environment Defaults ----------------------------------------------
set "WECRYPTO_OPEN_DEVTOOLS=1"
set "ELECTRON_ENABLE_LOGGING=1"
set "PYTH_LAZER_CHANNEL=fixed_rate@1000ms"
if not defined PYTH_FALLBACK_TIMEOUT_MS  set "PYTH_FALLBACK_TIMEOUT_MS=9000"
if not defined PYTH_FALLBACK_GRACE_MS    set "PYTH_FALLBACK_GRACE_MS=3000"
if not defined PYTH_LIVE_FEED_BACKOFF_MS set "PYTH_LIVE_FEED_BACKOFF_MS=250"
if not defined WECRYPTO_WEB_PORT         set "WECRYPTO_WEB_PORT=3450"
if not defined WECRYPTO_WEB_HOST         set "WECRYPTO_WEB_HOST=127.0.0.1"

REM Do not taskkill electron.exe -- HUD and inference are separate instances.

REM -- 8. Launch Electron -----------------------------------------------
echo [7/7] Launching WE-CFM-Orchestrator Electron Application...
echo.
echo ================================================================
echo                  WE-CRYPTO ORCHESTRATOR IS LIVE
echo   - Web Interface:  https://127.0.0.1:3450
echo   - Proxy:          http://127.0.0.1:3010
echo   - Upstream SOCKS: %WECRYPTO_SWEDEN_SOCKS%
echo   - DevTools:       Enabled
echo ================================================================
echo.

call npx electron .

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Electron exited with error code %errorlevel%.
    pause
)
