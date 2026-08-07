@echo off
setlocal enabledelayedexpansion
echo Starting WE-CFM-Orchestrator with DevTools enabled...

REM ── Load all secrets from C:\WECRYP\.env ────────────────────────────────────
set "ENV_FILE=C:\WECRYP\.env"

if not exist "%ENV_FILE%" (
    echo [ERROR] Master .env not found at %ENV_FILE%
    pause & exit /b 1
)

REM Parse every KEY=VALUE line; skip comments (#) and blanks
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    set "_k=%%A"
    if "!_k:~0,1!" neq "#" if "!_k!" neq "" if not "%%B" == "" set "%%A=%%B"
)

REM ── Change to project directory ──────────────────────────────────────────────
cd /d C:\WECRYP\WE-CFM-Orchestrator

REM ── Start Redpanda + Redis infrastructure ────────────────────────────────────
echo Starting Redpanda + Redis infrastructure...
docker compose up -d --no-recreate redis redpanda redpanda-console
if %errorlevel% neq 0 (
    echo [ERROR] docker compose failed — is Docker Desktop running?
    pause
    exit /b 1
)
echo Infrastructure containers started in background.

REM ── App environment ──────────────────────────────────────────────────────────
set WECRYPTO_OPEN_DEVTOOLS=1
set ELECTRON_ENABLE_LOGGING=1
set PYTH_LAZER_CHANNEL=fixed_rate@1000ms
if not defined PYTH_FALLBACK_TIMEOUT_MS    set PYTH_FALLBACK_TIMEOUT_MS=9000
if not defined PYTH_FALLBACK_GRACE_MS      set PYTH_FALLBACK_GRACE_MS=3000
if not defined PYTH_LIVE_FEED_BACKOFF_MS   set PYTH_LIVE_FEED_BACKOFF_MS=250

npm run start
