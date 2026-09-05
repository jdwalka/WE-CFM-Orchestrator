@echo off
setlocal enabledelayedexpansion
title WE-CFM-Orchestrator Windows Setup ^& Installer

REM Resolve Script Directory
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
cd /d "%SCRIPT_DIR%"

echo.
echo ==============================================================================
echo    WE-CFM-Orchestrator -- Windows Setup ^& Installation Suite
echo ==============================================================================
echo.
echo  Please select an option:
echo.
echo    [1] Launch Native Windows Setup Wizard (.exe)  [RECOMMENDED]
echo        Pre-verifies Docker, synchronizes .env/secrets, and launches the
echo        compiled NSIS setup wizard with Administrator elevation.
echo.
echo    [2] In-Place Environment Diagnostic ^& Setup Pipeline (PowerShell)
echo        Validates all prerequisites, installs dependencies, verifies Docker,
echo        syncs prediction weights, and creates a desktop launch shortcut.
echo.
echo    [3] Run System Diagnostic Report (8 Subsystems)
echo        Runs diagnose-environment.ps1 and checks Docker, Redpanda, Redis,
echo        WSL, SOCKS5, and Python inference layers.
echo.
echo    [4] Launch WE-CRYPTO Desktop Directly
echo        Runs launch-wecrypto.bat immediately.
echo.
echo    [5] Exit
echo.
echo ==============================================================================
set "CHOICE="
set /p "CHOICE=Select [1-5] (Default is 1): "

if "%CHOICE%"=="" set "CHOICE=1"
if "%CHOICE%"=="1" goto opt_installer
if "%CHOICE%"=="2" goto opt_pipeline
if "%CHOICE%"=="3" goto opt_diagnostic
if "%CHOICE%"=="4" goto opt_launch
if "%CHOICE%"=="5" goto opt_exit

:opt_installer
echo.
echo [*] Launching Windows Installer Dispatcher...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\scripts\installer\launch-windows-installer.ps1" -WorkspaceRoot "%SCRIPT_DIR%"
goto end

:opt_pipeline
echo.
echo [*] Running Full In-Place Environment Setup...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\scripts\installer\install-orchestrator.ps1" -WorkspaceRoot "%SCRIPT_DIR%"
goto end

:opt_diagnostic
echo.
echo [*] Running System Diagnostic Check...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\scripts\installer\diagnose-environment.ps1" -WorkspaceRoot "%SCRIPT_DIR%"
goto end

:opt_launch
echo.
echo [*] Starting WE-CRYPTO Desktop...
call "%SCRIPT_DIR%\launch-wecrypto.bat"
goto end

:opt_exit
exit /b 0

:end
echo.
pause
