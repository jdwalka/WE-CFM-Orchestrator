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
echo [6/7] Checking Mullvad SOCKS5 bridge...
powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 18090 >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Mullvad SOCKS5 bridge already listening on 18090.
) else (
    echo [INFO] Starting Mullvad SOCKS5 bridge...
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
    echo [INFO] Mullvad SOCKS5 bridge online.
)
set "WECRYPTO_SWEDEN_SOCKS=socks5://127.0.0.1:18090"

echo [6b/7] Verifying Mullvad tunnel egress (API WireGuard + SOCKS5)...
powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-TunnelConnectivity.ps1" >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Mullvad SOCKS5 on 18090 cannot reach exchanges through wecrypto-mullvad.
    echo [ERROR] The WireGuard tunnel interface may be up but has no working handshake/route.
    echo [ERROR] Restart WireGuardTunnel$wecrypto-mullvad, or re-provision via Mullvad API.
    pause
    exit /b 1
)
echo [INFO] Mullvad API tunnel egress verified.

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
echo   - DevTools:       Enabled
echo ================================================================
echo.

call npx electron .

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Electron exited with error code %errorlevel%.
    pause
)
