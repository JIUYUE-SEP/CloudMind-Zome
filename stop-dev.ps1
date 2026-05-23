#Requires -Version 5.1
<#
.SYNOPSIS
    停止 CloudMind-Zome 开发环境所有进程
#>

Write-Host "Stopping CloudMind-Zome services..." -ForegroundColor Yellow

function Stop-OnPort($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($conn) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            Write-Host "  Killed $($proc.ProcessName) (PID $($proc.Id)) on port $port" -ForegroundColor Green
        }
    } else {
        Write-Host "  Port $port already free" -ForegroundColor DarkGray
    }
}

Stop-OnPort 8849
Stop-OnPort 1420
Write-Host "Done." -ForegroundColor Green
