$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnsureScript = Join-Path $ProjectRoot "ensure-environment.ps1"
$FrontendRoot = Join-Path $ProjectRoot "frontend"
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"

function Test-CommandExists {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host ""
Write-Host "== Update Project ==" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"

if (-not (Test-CommandExists "git")) {
    Write-Host "Git is not installed or not in PATH." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $ProjectRoot ".git"))) {
    Write-Host "This folder is not a git repository." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $EnsureScript)) {
    Write-Host "Missing script: ensure-environment.ps1" -ForegroundColor Red
    exit 1
}

Set-Location $ProjectRoot

Write-Host ""
Write-Host "[1/4] Pulling latest code..." -ForegroundColor Yellow
git pull --ff-only
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Update stopped. Your local changes may need to be committed or stashed first." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "[2/4] Checking environment..." -ForegroundColor Yellow
& $EnsureScript
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "[3/4] Refreshing backend dependencies..." -ForegroundColor Yellow
& $VenvPython -m pip install -r (Join-Path $ProjectRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "[4/4] Rebuilding frontend..." -ForegroundColor Yellow
Set-Location $FrontendRoot
npm run build
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Project updated successfully." -ForegroundColor Green
Write-Host "You can now start it with start-all.bat" -ForegroundColor Green
