@echo off
setlocal EnableDelayedExpansion

:: CloudMind-Zome Development Launcher (Web Mode)
:: Starts Backend (FastAPI + uvicorn) + Frontend (Vite dev server)

echo.
echo  CloudMind-Zome Dev Launcher (Web)
echo  =================================
echo.

:: Check python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] python not found. Please install Python 3.11+ and add to PATH.
    pause
    exit /b 1
)

:: Check node
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node not found. Please install Node.js 18+ and add to PATH.
    pause
    exit /b 1
)

:: Go to project root (where this script is)
cd /d "%~dp0"
set "PROJECT_ROOT=%CD%"

:: Start backend
echo [1/3] Starting backend (uvicorn reload) ...
start "CloudMind Backend" cmd /c "cd /d "%PROJECT_ROOT%\backend" && python run.py"

:: Wait for backend
echo [2/3] Waiting for backend (3s) ...
timeout /t 3 /nobreak >nul

:: Start frontend
echo [3/3] Starting frontend dev server ...
cd /d "%PROJECT_ROOT%\frontend"
npm run dev

:: Cleanup
echo.
echo [EXIT] Stopping backend ...
taskkill /FI "WINDOWTITLE eq CloudMind Backend" /F >nul 2>&1
endlocal
