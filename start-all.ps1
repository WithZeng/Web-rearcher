$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnsureScript = Join-Path $ProjectRoot "ensure-environment.ps1"
$BackendScript = Join-Path $ProjectRoot "start-backend.ps1"
$FrontendScript = Join-Path $ProjectRoot "start-frontend.ps1"

Write-Host ""
Write-Host "== Start Project ==" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"
Write-Host "Mode: production" -ForegroundColor Green

if (-not (Test-Path $BackendScript)) {
    Write-Host "Missing script: start-backend.ps1" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $FrontendScript)) {
    Write-Host "Missing script: start-frontend.ps1" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $EnsureScript)) {
    Write-Host "Missing script: ensure-environment.ps1" -ForegroundColor Red
    exit 1
}

& $EnsureScript

$BackendCommand = "Set-Location -LiteralPath '$ProjectRoot'; powershell -ExecutionPolicy Bypass -File '$BackendScript' -SkipBootstrap"
$FrontendCommand = "Set-Location -LiteralPath '$ProjectRoot'; powershell -ExecutionPolicy Bypass -File '$FrontendScript' -SkipBootstrap"

Start-Process powershell -ArgumentList @("-NoExit", "-Command", $BackendCommand)
Start-Sleep -Seconds 1
Start-Process powershell -ArgumentList @("-NoExit", "-Command", $FrontendCommand)

Write-Host ""
Write-Host "Opened two new PowerShell windows:" -ForegroundColor Green
Write-Host "1. FastAPI backend (production mode)"
Write-Host "2. Next.js frontend (build + start)"
Write-Host ""
Write-Host "Open http://127.0.0.1:3000 in your browser" -ForegroundColor Green
