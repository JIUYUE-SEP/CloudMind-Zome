@echo off
cd /d "%~dp0"
start cmd /k "pnpm --filter @mindcloud/engine dev"
timeout /t 3 >nul
start cmd /k "pnpm --filter @mindcloud/desktop dev"
