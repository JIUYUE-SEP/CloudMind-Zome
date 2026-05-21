@echo off
chcp 65001 >nul
title CloudMind-Zome Dev Launcher
echo.
echo   Starting CloudMind-Zome Development Environment...
echo.

:: Check PowerShell
powershell -Command "Get-Host" >nul 2>&1
if errorlevel 1 (
    echo ERROR: PowerShell is required but not available.
    pause
    exit /b 1
)

:: Run the PowerShell script
powershell -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1"

if errorlevel 1 (
    echo.
    echo Startup failed. Press any key to exit...
    pause >nul
)
