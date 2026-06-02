# CloudMind-Zome Development Launcher (Web Mode) - PowerShell

$ErrorActionPreference = "Stop"

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host ""
Write-Host " CloudMind-Zome Dev Launcher (PowerShell)" -ForegroundColor Cyan
Write-Host " ==========================================" -ForegroundColor Cyan
Write-Host ""

# Check python
if (-not (Test-Command "python")) {
    Write-Host "[ERROR] python not found. Please install Python 3.11+ and add to PATH." -ForegroundColor Red
    exit 1
}

# Check node
if (-not (Test-Command "node")) {
    Write-Host "[ERROR] node not found. Please install Node.js 18+ and add to PATH." -ForegroundColor Red
    exit 1
}

$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) { $ProjectRoot = Get-Location }

# Start backend
Write-Host "[1/3] Starting backend (uvicorn reload) ..." -ForegroundColor Green
$BackendJob = Start-Job -ScriptBlock {
    param($Root)
    Set-Location "$Root\backend"
    python run.py
} -ArgumentList $ProjectRoot

# Wait for backend
Write-Host "[2/3] Waiting for backend (3s) ..." -ForegroundColor Green
Start-Sleep -Seconds 3

# Start frontend
Write-Host "[3/3] Starting frontend dev server ..." -ForegroundColor Green
Set-Location "$ProjectRoot\frontend"
try {
    npm run dev
} finally {
    Write-Host ""
    Write-Host "[EXIT] Stopping backend ..." -ForegroundColor Yellow
    Stop-Job $BackendJob -ErrorAction SilentlyContinue
    Remove-Job $BackendJob -ErrorAction SilentlyContinue
}
