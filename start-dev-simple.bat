@echo off
chcp 65001 >nul
title CloudMind-Zome Dev

echo.
echo   CloudMind-Zome Dev Launcher
echo   ===========================
echo.

REM --- Find Python ---
set PYTHON=
for %%p in (py python python3) do (
    if "!PYTHON!"=="" (
        %%p --version >nul 2>&1
        if !errorlevel!==0 set PYTHON=%%p
    )
)
if "%PYTHON%"=="" (
    echo ERROR: Python not found. Please install Python and add to PATH.
    pause
    exit /b 1
)
%PYTHON% --version

REM --- Find Node ---
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Please install Node.js and add to PATH.
    pause
    exit /b 1
)
node --version

REM --- Kill old python processes on port 8849 ---
echo.
echo [1/3] Stopping old backend...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8849') do (
    echo   Killing PID %%a
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

REM --- Kill old node processes on port 1420 ---
echo [2/3] Stopping old frontend...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :1420') do (
    echo   Killing PID %%a
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

REM --- Start backend ---
echo [3/3] Starting services...
echo.
echo   Backend  -> http://127.0.0.1:8849
echo   Frontend -> http://localhost:1420
echo.
echo   Press Ctrl+C here to stop both
echo   ============================================
echo.

REM Start backend in background
start "Backend" cmd /c "cd /d %~dp0\backend && %PYTHON% run.py"

REM Start frontend in foreground (blocking)
cd /d %~dp0\frontend
npm run dev

REM When frontend stops, kill backend too
taskkill /FI "WINDOWTITLE eq Backend" /F >nul 2>&1
echo.
echo All services stopped.
pause
