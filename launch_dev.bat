@echo off
setlocal enabledelayedexpansion
title WE-CFM-Orchestrator Dev Launcher [Split Routing: ASI1 Direct + WSL Sweden CEX]

echo.
echo ==============================================================================
echo    WE-CFM-Orchestrator — Development Launcher with Auto Proxy ^& Port Binding
echo    - Direct US:   ASI1 (api.asi1.ai), Polymarket CLOB/Gamma, Coinbase, Kraken
echo    - WSL Sweden:  Binance Spot/Futures, Bybit, OKX, MEXC (10.13.13.2:18090)
echo ==============================================================================
echo.

REM ── 1. Resolve Script & Working Directory ──────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
cd /d "%SCRIPT_DIR%"

REM ── 2. Check and Load .env ─────────────────────────────────────────────────────
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

echo [1/8] Loading environment variables from .env...
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    set "_k=%%A"
    if "!_k:~0,1!" neq "#" if "!_k!" neq "" if not "%%B" == "" set "%%A=%%B"
)

REM ── 3. Port Clearance: Kill Stale Processes on 3010, 3450 ──────────────────────
echo [2/8] Ensuring ports 3010 and 3450 are free...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3010,3450 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 1 /nobreak >nul

REM ── 4. SOCKS5 Bridge Detection (WSL WireGuard 10.13.13.2 vs Local 127.0.0.1) ───
echo [3/8] Checking SOCKS5 egress bridge...
if not defined WECRYPTO_SWEDEN_SOCKS (
    powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 18090 -HostName 10.13.13.2 >nul 2>&1
    if !errorlevel! equ 0 (
        set "WECRYPTO_SWEDEN_SOCKS=socks5://10.13.13.2:18090"
        echo [INFO] Detected active WSL2 WireGuard SOCKS5 on 10.13.13.2:18090.
    ) else (
        powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 18090 -HostName 127.0.0.1 >nul 2>&1
        if !errorlevel! equ 0 (
            set "WECRYPTO_SWEDEN_SOCKS=socks5://127.0.0.1:18090"
            echo [INFO] Detected active local SOCKS5 bridge on 127.0.0.1:18090.
        ) else (
            echo [INFO] Starting local standalone SOCKS5 proxy on port 18090...
            start "WE-CRYPTO Mullvad SOCKS5 Bridge" /min node "%SCRIPT_DIR%\cloudflared\mullvad-standalone-socks.js"
            set "WECRYPTO_SWEDEN_SOCKS=socks5://127.0.0.1:18090"
            for /l %%i in (1,1,10) do (
                powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 18090 -HostName 127.0.0.1 >nul 2>&1
                if !errorlevel! equ 0 ( goto :socks_ready )
                timeout /t 1 /nobreak >nul
            )
        )
    )
)
:socks_ready
echo [INFO] SOCKS5 upstream target: %WECRYPTO_SWEDEN_SOCKS%

REM ── 5. Start and Verify HTTP Proxy Bouncer on Port 3010 ─────────────────────────
echo [4/8] Launching HTTP proxy bouncer daemon on port 3010...
start "WE-CRYPTO Proxy Bouncer (Port 3010)" /min node "%SCRIPT_DIR%\cloudflared\proxy-runner.js"

set "PROXY_BOUND=0"
for /l %%i in (1,1,15) do (
    if "!PROXY_BOUND!"=="0" (
        powershell -NoProfile -File "%SCRIPT_DIR%\cloudflared\Test-Port.ps1" -Port 3010 -HostName 127.0.0.1 >nul 2>&1
        if !errorlevel! equ 0 (
            set "PROXY_BOUND=1"
        ) else (
            timeout /t 1 /nobreak >nul
        )
    )
)

if "!PROXY_BOUND!"=="0" (
    echo [WARN] Proxy bouncer on port 3010 did not respond immediately. Continuing with Electron internal fallback...
) else (
    echo [INFO] HTTP proxy bouncer successfully bound to http://127.0.0.1:3010
)

REM ── 6. Build Quant Layer and Sync Weights ──────────────────────────────────────
echo [5/8] Building Quant TypeScript layer...
call npm run build:quant
if %errorlevel% neq 0 (
    echo [WARN] Quant layer build had warnings or non-fatal errors, continuing...
)

echo [6/8] Synchronizing prediction weights...
call npm run weights:sync >nul 2>&1

REM ── 7. Check & Start Docker Infrastructure (Optional/Best Effort) ───────────────
echo [7/8] Checking Docker infrastructure...
docker info >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Docker daemon detected. Starting Redpanda and Redis...
    docker compose -p wecryp up -d --no-recreate redis redpanda redpanda-console >nul 2>&1
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

REM ── 8. Environment Defaults & Launch Electron ──────────────────────────────────
set "WECRYPTO_OPEN_DEVTOOLS=1"
set "ELECTRON_ENABLE_LOGGING=1"
set "PYTH_LAZER_CHANNEL=fixed_rate@1000ms"
if not defined PYTH_FALLBACK_TIMEOUT_MS  set "PYTH_FALLBACK_TIMEOUT_MS=9000"
if not defined PYTH_FALLBACK_GRACE_MS    set "PYTH_FALLBACK_GRACE_MS=3000"
if not defined PYTH_LIVE_FEED_BACKOFF_MS set "PYTH_LIVE_FEED_BACKOFF_MS=250"
if not defined WECRYPTO_WEB_PORT         set "WECRYPTO_WEB_PORT=3450"
if not defined WECRYPTO_WEB_HOST         set "WECRYPTO_WEB_HOST=127.0.0.1"

echo.
echo ==============================================================================
echo                 WE-CRYPTO DEV ENVIRONMENT IS READY
echo   - Electron App:   Launching with DevTools enabled
echo   - Web Interface:  http://127.0.0.1:3450
echo   - Proxy Bouncer:  http://127.0.0.1:3010
echo   - Upstream SOCKS: %WECRYPTO_SWEDEN_SOCKS%
echo ==============================================================================
echo.

echo [8/8] Starting Electron app...
call npx electron .

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Electron exited with error code %errorlevel%.
    pause
)
