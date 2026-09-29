@echo off
REM WECRYPTO Launch Script with Patches v2.15.5
REM Runs app directly from source with all safety patches enabled
REM
REM Confidence floor: 70% (prevents lossy low-confidence signals)
REM Close-window guard: Skip final 45s of 15m candle
REM
setlocal enabledelayedexpansion

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║   WE-CRYPTO Kalshi 15m — v2.15.5 SAFETY PATCH ENABLED      ║
echo ╠══════════════════════════════════════════════════════════════╣
echo ║                                                              ║
echo ║   PATCHES ACTIVE:                                            ║
echo ║   • Confidence Floor: 70%% (blocks low-quality signals)     ║
echo ║   • Close-Window Guard: Skip final 45s of 15m candle       ║
echo ║                                                              ║
echo ║   READY TO TRADE (safely)                                   ║
echo ║                                                              ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

REM Kill any existing Electron processes to ensure clean start
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM we-crypto-proxy.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM Start the proxy backend
echo Starting Proxy Orchestrator...
start /b "" "%~dp0proxy\target\release\we-crypto-proxy.exe"
timeout /t 2 /nobreak >nul

REM Launch Electron with patches from source
cd /d %~dp0
echo Launching app with dev-mode patches...
echo.
call npx electron . --remote-debugging-port=9222

pause
