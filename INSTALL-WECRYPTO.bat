@echo off
setlocal enabledelayedexpansion
title WE-CFM-Orchestrator Installer ^& Setup Suite

echo.
echo ==============================================================================
echo    WE-CFM-Orchestrator - Automated Windows Installer ^& Setup Engine
echo ==============================================================================
echo.

REM Resolve Script Directory
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
cd /d "%SCRIPT_DIR%"

echo [*] Initializing PowerShell setup pipeline...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\scripts\installer\install-orchestrator.ps1" -WorkspaceRoot "%SCRIPT_DIR%"

if %ERRORLEVEL% equ 0 (
    echo.
    echo ==============================================================================
    echo    SUCCESS: Setup completed! You can now run launch-wecrypto.bat
    echo ==============================================================================
    echo.
) else (
    echo.
    echo [ERROR] Setup encountered errors. See log messages above.
    echo.
)

pause
