Set-Location $PSScriptRoot
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "pnpm --filter @mindcloud/engine dev"
Start-Sleep -Seconds 3
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "pnpm --filter @mindcloud/web dev"
