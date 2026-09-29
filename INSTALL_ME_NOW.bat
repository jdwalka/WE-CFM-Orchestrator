@echo off
setlocal enabledelayedexpansion
title WE-CFM-Orchestrator Quick Windows Installer

REM Resolve Script Directory
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
cd /d "%SCRIPT_DIR%"

echo.
echo ==============================================================================
echo    WE-CFM-Orchestrator -- Windows Quick Installer
echo ==============================================================================
echo.
echo [*] Preparing Windows environment and launching Setup Wizard...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\scripts\installer\launch-windows-installer.ps1" -WorkspaceRoot "%SCRIPT_DIR%"

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Installer launcher exited with code %ERRORLEVEL%.
    pause
)
