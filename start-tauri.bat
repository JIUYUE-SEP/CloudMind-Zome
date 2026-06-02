@echo off
setlocal EnableDelayedExpansion

:: CloudMind-Zome Development Launcher (Tauri Desktop Mode)
:: Starts Backend + Tauri Dev (WebView2 desktop window)

echo.
echo  CloudMind-Zome Dev Launcher (Tauri)
echo  ===================================
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

:: Check Rust / Cargo
cargo --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] cargo not found. Tauri requires Rust toolchain. Install from https://rustup.rs/
    pause
    exit /b 1
)

:: Go to project root
cd /d "%~dp0"
set "PROJECT_ROOT=%CD%"

:: Start backend
echo [1/3] Starting backend ...
start "CloudMind Backend" cmd /c "cd /d "%PROJECT_ROOT%\backend" && python run.py"

:: Wait for backend
echo [2/3] Waiting for backend (3s) ...
timeout /t 3 /nobreak >nul

:: Start Tauri Dev
echo [3/3] Starting Tauri desktop dev mode ...
cd /d "%PROJECT_ROOT%\frontend"
npm run tauri:dev

:: Cleanup
echo.
echo [EXIT] Stopping backend ...
taskkill /FI "WINDOWTITLE eq CloudMind Backend" /F >nul 2>&1
endlocal
