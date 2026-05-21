#Requires -Version 5.1
<#
.SYNOPSIS
    CloudMind-Zome 一键开发启动脚本
.DESCRIPTION
    同时启动后端 FastAPI (port 8848) 和前端 Vite (port 1420)
    按 Ctrl+C 即可全部停止
#>

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$backendDir = Join-Path $projectRoot "backend"
$frontendDir = Join-Path $projectRoot "frontend"

function Write-Color($Text, $Color = "White") {
    Write-Host $Text -ForegroundColor $Color
}

function Test-Command($cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ========== Banner ==========
Clear-Host
Write-Color @"
   ____ _                 _ __  __            _     ______                
  / ___| | ___  _   _  __| |  \/  | ___   ___| | __|__  (_) ___ ___  ___ 
 | |   | |/ _ \| | | |/ _` | |\/| |/ _ \ / __| |/ /  / /\/ |/ __/ _ \/ __|
 | |___| | (_) | |_| | (_| | |  | | (_) | (__|   <  / /  | | (_|  __/\__ \
  \____|_|\___/ \__,_|\__,_|_|  |_|\___/ \___|_|\_\ /_/   |_|\___\___||___/
"@ "Cyan"
Write-Color "  CloudMind-Zome Dev Launcher v0.1.0`n" "DarkGray"

# ========== Check Dependencies ==========
Write-Color "[1/4] Checking dependencies..." "Yellow"

if (-not (Test-Command "py") -and -not (Test-Command "python")) {
    Write-Color "ERROR: Python not found. Please install Python 3.11+ and add to PATH." "Red"
    exit 1
}
$pythonCmd = if (Test-Command "py") { "py" } else { "python" }

if (-not (Test-Command "node")) {
    Write-Color "ERROR: Node.js not found. Please install Node.js 18+ and add to PATH." "Red"
    exit 1
}

Write-Color "  Python: $((& $pythonCmd --version 2>&1))" "Green"
Write-Color "  Node:   $(node --version)" "Green"
Write-Color "  NPM:    $(npm --version)`n" "Green"

# ========== Check / Kill Old Processes ==========
Write-Color "[2/4] Checking existing processes..." "Yellow"

$oldBackends = Get-Process | Where-Object {
    $_.ProcessName -match "python" -and $_.CommandLine -match "run\.py"
} -ErrorAction SilentlyContinue

$oldFrontends = Get-Process | Where-Object {
    $_.ProcessName -match "node" -and $_.CommandLine -match "vite"
} -ErrorAction SilentlyContinue

if ($oldBackends -or $oldFrontends) {
    Write-Color "  Found existing dev processes." "DarkYellow"
    $resp = Read-Host "  Kill them before starting new ones? [Y/n]"
    if ($resp -eq "" -or $resp -match "^[Yy]") {
        $oldBackends | Stop-Process -Force -ErrorAction SilentlyContinue
        $oldFrontends | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        Write-Color "  Old processes killed.`n" "Green"
    }
} else {
    Write-Color "  No existing processes found.`n" "Green"
}

# ========== Clean DB (Optional) ==========
Write-Color "[3/4] Preparing database..." "Yellow"
$dbFile = Join-Path (Join-Path $env:USERPROFILE ".cloudmind-zome") "cloudmind.db"
if (Test-Path $dbFile) {
    Write-Color "  DB exists: $dbFile" "DarkGray"
} else {
    Write-Color "  DB will be created on first startup.`n" "DarkGray"
}

# ========== Start Backend ==========
Write-Color "[4/4] Starting services...`n" "Yellow"

$backendJob = Start-Job -ScriptBlock {
    param($dir, $py)
    Set-Location $dir
    & $py run.py
} -ArgumentList $backendDir, $pythonCmd

# Wait a moment for backend to initialize
Start-Sleep -Seconds 3

# Check if backend started successfully
$backendLog = Receive-Job -Job $backendJob -Keep -ErrorAction SilentlyContinue
if ($backendLog -match "error" -or $backendLog -match "Traceback") {
    Write-Color "Backend failed to start:" "Red"
    Write-Color $backendLog "Red"
    Stop-Job $backendJob
    Remove-Job $backendJob
    exit 1
}

if ($backendLog -match "Application startup complete" -or $backendLog -match "Uvicorn running") {
    Write-Color "  Backend  -> http://127.0.0.1:8848  (started)" "Green"
} else {
    Write-Color "  Backend  -> starting..." "DarkYellow"
}

# ========== Start Frontend ==========
Set-Location $frontendDir
Write-Color "  Frontend -> http://localhost:1420   (starting...)`n" "Green"

Write-Color "========================================" "Cyan"
Write-Color "  Press Ctrl+C to stop all services" "Cyan"
Write-Color "========================================`n" "Cyan"

try {
    npm run dev
} finally {
    Write-Color "`nShutting down backend..." "Yellow"
    Stop-Job $backendJob -ErrorAction SilentlyContinue
    Remove-Job $backendJob -ErrorAction SilentlyContinue
    Get-Process | Where-Object {
        $_.ProcessName -match "python" -and $_.CommandLine -match "run\.py"
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Color "All services stopped." "Green"
}
