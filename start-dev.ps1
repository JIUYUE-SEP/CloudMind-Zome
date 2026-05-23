#Requires -Version 5.1
<#
.SYNOPSIS
    CloudMind-Zome 开发环境一键启动
.DESCRIPTION
    自动结束后端(8849)/前端(1420)旧进程，启动新实例。
    按 Ctrl+C 或关闭窗口即可全部停止。
#>

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$backendDir = Join-Path $scriptDir "backend"
$frontendDir = Join-Path $scriptDir "frontend"

# ---------- helpers ----------
function Write-Step($n, $total, $msg) {
    Write-Host "[$n/$total] $msg" -ForegroundColor Yellow
}
function Write-Ok($msg)  { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn($msg){ Write-Host "  WARN  $msg" -ForegroundColor DarkYellow }
function Write-Err($msg) { Write-Host "  ERR  $msg" -ForegroundColor Red }

function Stop-OnPort($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($conn) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            Write-Warn "Killed $($proc.ProcessName) (PID $($proc.Id)) on port $port"
        }
    }
}

function Test-Command($cmd) {
    [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ---------- 0. banner ----------
Clear-Host
Write-Host @"
   ____ _                 _ __  __            _     ______
  / ___| | ___  _   _  __| |  \/  | ___   ___| | __|__  (_) ___ ___  ___
 | |   | |/ _ \| | | |/ _` | |\/| |/ _ \ / __| |/ /  / /\/ |/ __/ _ \/ __|
 | |___| | (_) | |_| | (_| | |  | | (_) | (__|   <  / /  | | (_|  __/\__ \
  \____|_|\___/ \__,_|\__,_|_|  |_|\___/ \___|_|\_\ /_/   |_|\___\___||___/
"@ -ForegroundColor Cyan
Write-Host "  Dev Launcher  v1.1  |  Branch: $(git -C $scriptDir branch --show-current 2>$null)" -ForegroundColor DarkGray
Write-Host ""

# ---------- 1. deps ----------
Write-Step 1 4 "Checking dependencies..."
if (-not (Test-Command "py") -and -not (Test-Command "python")) {
    Write-Err "Python not found. Install Python 3.11+ and add to PATH."
    exit 1
}
$pythonCmd = if (Test-Command "py") { "py" } else { "python" }
if (-not (Test-Command "node")) {
    Write-Err "Node.js not found. Install Node.js 18+ and add to PATH."
    exit 1
}
Write-Ok "Python  $((& $pythonCmd --version 2>&1))"
Write-Ok "Node    $(node --version)"
Write-Ok "NPM     $(npm --version)"
Write-Host ""

# ---------- 2. kill old ----------
Write-Step 2 4 "Stopping old processes..."
Stop-OnPort 8849
Stop-OnPort 1420
Write-Ok "Ports 8849 & 1420 are free"
Write-Host ""

# ---------- 3. DB ----------
Write-Step 3 4 "Preparing database..."
$dbPath = Join-Path $env:USERPROFILE ".cloudmind-zome" "cloudmind.db"
if (Test-Path $dbPath) {
    Write-Ok "DB ready  →  $dbPath"
} else {
    Write-Warn "DB will be created on first startup"
}
Write-Host ""

# ---------- 4. start services ----------
Write-Step 4 4 "Starting services..."
Write-Host ""

# backend
$backendJob = Start-Job -ScriptBlock {
    param($dir, $py)
    Set-Location $dir
    & $py run.py
} -ArgumentList $backendDir, $pythonCmd

# wait for backend health
$backendUp = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8849/api/v1/auth/me" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $backendUp = $true; break }
    } catch {}
}

if ($backendUp) {
    Write-Ok "Backend   →  http://127.0.0.1:8849"
} else {
    Write-Warn "Backend still starting... (check logs)"
}

# frontend
Set-Location $frontendDir
Write-Ok "Frontend  →  http://localhost:1420"
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Ctrl+C  or close window to stop" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

try {
    npm run dev
} finally {
    Write-Host "`nShutting down..." -ForegroundColor Yellow
    Stop-Job $backendJob -ErrorAction SilentlyContinue
    Remove-Job $backendJob -ErrorAction SilentlyContinue
    Stop-OnPort 8849
    Stop-OnPort 1420
    Write-Ok "All services stopped."
}
