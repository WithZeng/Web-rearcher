param(
    [switch]$SkipBootstrap,
    [switch]$DevMode
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnsureScript = Join-Path $ProjectRoot "ensure-environment.ps1"
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"

if (-not $SkipBootstrap) {
    & $EnsureScript -BackendOnly
}

Set-Location $ProjectRoot

Write-Host ""
Write-Host "== Start Backend ==" -ForegroundColor Cyan
Write-Host "Backend URL: http://127.0.0.1:8000" -ForegroundColor Green
Write-Host "Health check: http://127.0.0.1:8000/api/health" -ForegroundColor Green
Write-Host ""

if ($DevMode) {
    Write-Host "Mode: development" -ForegroundColor Yellow
    & $VenvPython -m uvicorn api.server:app --reload --host 127.0.0.1 --port 8000
} else {
    Write-Host "Mode: production" -ForegroundColor Green
    & $VenvPython -m uvicorn api.server:app --host 127.0.0.1 --port 8000
}
