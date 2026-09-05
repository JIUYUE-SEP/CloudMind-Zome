@echo off
cd /d "%~dp0"
start cmd /k "pnpm --filter @cloudmind/engine dev"
timeout /t 3 >nul
start cmd /k "pnpm --filter @cloudmind/web dev"
