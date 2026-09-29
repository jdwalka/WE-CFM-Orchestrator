@echo off
setlocal enabledelayedexpansion
title WE-CRYPTO INFERENCE (query-log ultra split)
cd /d "%~dp0"

if exist "%~dp0.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
    set "_k=%%A"
    if "!_k:~0,1!" neq "#" if "!_k!" neq "" if not "%%B" == "" set "%%A=%%B"
  )
)

REM Must override .env AFTER the loop.
REM Whole stack: Sweden exit + Mullvad SOCKS PAC. Do NOT use HUD :18080 punch.
set "WECRYPTO_PROFILE=inference"
set "WECRYPTO_SKIP_INFERENCE=0"
set "ASI1_PREFERRED_ACCOUNT=icloud"
set "WECRYPTO_DIRECT_PROXY=off"
REM Do not set WECRYPTO_SWEDEN_SOCKS — that PAC paints Chromium through
REM 10.64.0.1 and the window stays #0b1020. Node ASI1 still uses the
REM Tailscale Sweden exit (system 0.0.0.0/0). Exchanges use main.js needles.
set "WECRYPTO_SWEDEN_SOCKS="
set "WECRYPTO_WEB_PORT=3460"
set "WECRYPTO_OPEN_DEVTOOLS=0"

echo Inference instance: LLM ON, no ASI1 punch proxy, Sweden SOCKS PAC, port 3460
echo HUD instance is untouched (launch-hud.bat / port 3450).
call npx electron .
