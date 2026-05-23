@echo off
setlocal EnableDelayedExpansion

echo ==========================================
echo  CloudMind-Zome Environment Setup
echo ==========================================
echo.

REM Read current user PATH
set "OLD_PATH="
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul ^| findstr PATH') do set "OLD_PATH=%%b"

if "!OLD_PATH!"=="" set "OLD_PATH=%PATH%"

REM Paths to add
set "ADD_GIT=C:\Program Files\Git\bin"
set "ADD_PY=C:\Users\b1953\AppData\Local\Programs\Python\Python314"
set "ADD_PYLAUNCHER=C:\Users\b1953\AppData\Local\Programs\Python\Launcher"
set "ADD_NODE=F:\Node"

set "NEW_PATH=!OLD_PATH!"
set "NEED_ADD=0"

call :AddIfMissing "!ADD_GIT!"
call :AddIfMissing "!ADD_PY!"
call :AddIfMissing "!ADD_PYLAUNCHER!"
call :AddIfMissing "!ADD_NODE!"

if !NEED_ADD! equ 0 (
    echo All paths already exist. No changes needed.
    pause
    exit /b 0
)

echo.
echo Updating user PATH...
setx PATH "!NEW_PATH!"
if !errorlevel! neq 0 (
    echo FAILED. Try running as Administrator.
    pause
    exit /b 1
)

echo.
echo SUCCESS: Environment variables updated.
echo.
echo IMPORTANT: You MUST log out and log back in
echo              for the changes to take effect.
echo.
pause
exit /b 0

:AddIfMissing
set "DIR=%~1"
echo Checking: %DIR%
echo !NEW_PATH! | findstr /I /C:"%DIR%" >nul
if !errorlevel! neq 0 (
    set "NEW_PATH=%DIR%;!NEW_PATH!"
    set /a NEED_ADD+=1
    echo   [ADDED]
) else (
    echo   [OK]
)
exit /b 0
