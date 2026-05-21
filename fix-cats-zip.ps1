#Requires -Version 5.1
<#
.SYNOPSIS
    修复 Cats Blender Plugin 与 Blender 5.1+ 的兼容性
.DESCRIPTION
    将 bl_info 中的 "support": "TESTING" 改为 "COMMUNITY"，重新打包
#>

$ErrorActionPreference = "Stop"

$zipPath = Read-Host "请输入 cats-blender-plugin.zip 的完整路径"
if (!(Test-Path $zipPath)) {
    Write-Host "文件不存在: $zipPath" -ForegroundColor Red
    exit 1
}

$workDir = Join-Path $env:TEMP "cats-fix-$(Get-Random)"
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

$extractDir = Join-Path $workDir "extracted"
$fixedZip = Join-Path (Split-Path $zipPath -Parent) "cats-blender-plugin-fixed.zip"

Write-Host "解压到临时目录..." -ForegroundColor Cyan
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

# 找到 __init__.py（可能在 zip 根目录或子目录）
$initFiles = Get-ChildItem -Path $extractDir -Recurse -Filter "__init__.py" -Depth 2
if (!$initFiles) {
    Write-Host "未找到 __init__.py，无法修复" -ForegroundColor Red
    Remove-Item -Recurse -Force $workDir
    exit 1
}

$fixed = $false
foreach ($f in $initFiles) {
    $content = Get-Content $f.FullName -Raw -Encoding UTF8
    if ($content -match '"support"\s*:\s*"TESTING"') {
        Write-Host "修复: $($f.FullName)" -ForegroundColor Green
        $content = $content -replace '"support"\s*:\s*"TESTING"', '"support": "COMMUNITY"'
        Set-Content -Path $f.FullName -Value $content -Encoding UTF8 -NoNewline
        $fixed = $true
    }
}

if (!$fixed) {
    Write-Host "未找到 'TESTING' 标记，可能已经修复或格式不同" -ForegroundColor Yellow
}

Write-Host "重新打包..." -ForegroundColor Cyan
# 找到包含 __init__.py 的那一层目录
$sourceDir = $initFiles[0].DirectoryName
Compress-Archive -Path (Join-Path $sourceDir "*") -DestinationPath $fixedZip -Force

Remove-Item -Recurse -Force $workDir

Write-Host "" 
Write-Host "修复完成！" -ForegroundColor Green
Write-Host "新文件: $fixedZip" -ForegroundColor Cyan
Write-Host ""
Write-Host "请在 Blender 中安装这个修复后的 zip:" -ForegroundColor White
Write-Host "  Edit → Preferences → Add-ons → Install... → 选择 cats-blender-plugin-fixed.zip"
