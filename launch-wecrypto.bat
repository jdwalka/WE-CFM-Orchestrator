@echo off
setlocal enabledelayedexpansion
title WE-CFM-Orchestrator [Auto Proxy ^& Self-Healing Launcher]

echo.
echo ==============================================================================
echo    WE-CFM-Orchestrator - Self-Healing Windows Launcher
echo    - Direct US:   ASI1 (api.asi1.ai), Polymarket CLOB/Gamma, Coinbase, Kraken
echo    - Egress SOCKS: WSL Sweden / Local (10.13.13.2 / 127.0.0.1:18090)
echo ==============================================================================
echo.

REM ── 1. Resolve Script & Working Directory ──────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
cd /d "%SCRIPT_DIR%"
set "WECRYP_ROOT=%SCRIPT_DIR%"

REM ── 2. Check and Load .env ─────────────────────────────────────────────────────
set "ENV_FILE=%SCRIPT_DIR%\.env"
if not exist "%ENV_FILE%" (
    if exist "%SCRIPT_DIR%\.env.example" (
        copy "%SCRIPT_DIR%\.env.example" "%ENV_FILE%" >nul
        echo [INFO] Generated .env from .env.example
    ) else (
        echo [WARN] .env not found. Creating default configuration...
        echo COMPOSE_PROJECT_NAME=wecryp> "%ENV_FILE%"
        echo WECRYP_ROOT=%SCRIPT_DIR%>> "%ENV_FILE%"
    )
)

echo [1/6] Loading environment configuration...
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    set "_k=%%A"
    if "!_k:~0,1!" neq "#" if "!_k!" neq "" if not "%%B" == "" set "%%A=%%B"
)
set "COMPOSE_PROJECT_NAME=wecryp"

REM ── 3. Port Clearance: Free Locked Ports 3010, 3450, 3011, 3012 ────────────────
echo [2/6] Freeing service ports (3010, 3450, 3011, 3012)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3010,3450,3011,3012 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 1 /nobreak >nul

REM ── 4. SOCKS5 Bridge Detection ─────────────────────────────────────────────────
echo [3/6] Configuring SOCKS5 egress routing...
if not defined WECRYPTO_SWEDEN_SOCKS (
    powershell -NoProfile -Command "$c = New-Object System.Net.Sockets.TcpClient; try { $c.Connect('10.13.13.2', 18090); exit 0 } catch { exit 1 } finally { $c.Close() }" >nul 2>&1
    if !errorlevel! equ 0 (
        set "WECRYPTO_SWEDEN_SOCKS=socks5://10.13.13.2:18090"
        echo [INFO] Active WSL2 WireGuard proxy detected on 10.13.13.2:18090.
    ) else (
        powershell -NoProfile -Command "$c = New-Object System.Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', 18090); exit 0 } catch { exit 1 } finally { $c.Close() }" >nul 2>&1
        if !errorlevel! equ 0 (
            set "WECRYPTO_SWEDEN_SOCKS=socks5://127.0.0.1:18090"
            echo [INFO] Active local SOCKS5 proxy detected on 127.0.0.1:18090.
        ) else (
            echo [INFO] Starting standalone local SOCKS5 proxy on 127.0.0.1:18090...
            start "WE-CRYPTO SOCKS5 Bridge" /min node "%SCRIPT_DIR%\cloudflared\mullvad-standalone-socks.js"
            set "WECRYPTO_SWEDEN_SOCKS=socks5://127.0.0.1:18090"
            timeout /t 2 /nobreak >nul
        )
    )
)
echo [INFO] SOCKS5 target: %WECRYPTO_SWEDEN_SOCKS%

REM ── 5. Start HTTP Proxy Bouncer on Port 3010 ───────────────────────────────────
echo [4/6] Launching HTTP proxy bouncer on port 3010...
start "WE-CRYPTO Proxy Bouncer" /min node "%SCRIPT_DIR%\cloudflared\proxy-runner.js"
timeout /t 1 /nobreak >nul

REM ── 6. Docker Infrastructure Verification (with Project Isolation) ──────────────
echo [5/6] Checking Docker infrastructure...
docker info >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Docker online. Ensuring Redpanda and Redis containers are active...
    docker compose -p wecryp up -d --no-recreate redis redpanda redpanda-console >nul 2>&1
    if %errorlevel% equ 0 (
        echo [INFO] Redpanda and Redis online (Project: wecryp).
        set "WECRYPTO_SKIP_ORBITAL=0"
    ) else (
        echo [WARN] Docker compose had non-fatal warning. Continuing in standalone mode...
        set "WECRYPTO_SKIP_ORBITAL=1"
    )
) else (
    echo [WARN] Docker daemon not running. Running in Standalone Mode (WECRYPTO_SKIP_ORBITAL=1).
    set "WECRYPTO_SKIP_ORBITAL=1"
)

REM ── 7. Launch Electron with CPU Affinity ───────────────────────────────────────
echo [6/6] Launching Electron Application...
echo.
echo ==============================================================================
echo                WE-CRYPTO DEV ENVIRONMENT IS ACTIVE
echo   - Web Interface : http://127.0.0.1:3450
echo   - Proxy Bouncer : http://127.0.0.1:3010
echo   - Upstream SOCKS: %WECRYPTO_SWEDEN_SOCKS%
echo ==============================================================================
echo.

powershell -NoProfile -Command "Start-Sleep -Seconds 3; $p = Get-Process electron -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.ProcessorAffinity = 255; Write-Host '[Startup] Locked CPU Affinity mask 255 for PID' $p.Id }" >nul 2>&1 &

call npx electron . --enable-logging

exit /b 0
