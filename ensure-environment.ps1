param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$FrontendRoot = Join-Path $ProjectRoot "frontend"
$VenvRoot = Join-Path $ProjectRoot ".venv"
$VenvPython = Join-Path $VenvRoot "Scripts\python.exe"
$RequirementsFile = Join-Path $ProjectRoot "requirements.txt"
$EnvExample = Join-Path $ProjectRoot ".env.example"
$EnvFile = Join-Path $ProjectRoot ".env"
$BackendStamp = Join-Path $VenvRoot ".requirements-installed"
$FrontendStamp = Join-Path $FrontendRoot "node_modules\.deps-installed"
$PackageLock = Join-Path $FrontendRoot "package-lock.json"

function Test-CommandExists {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-PythonModule {
    param(
        [string]$PythonExe,
        [string[]]$Modules
    )

    if (-not (Test-Path $PythonExe)) {
        return $false
    }

    $quotedModules = ($Modules | ForEach-Object { "'$_'" }) -join ", "
    $probe = @"
import importlib.util
import sys

modules = [$quotedModules]
missing = [name for name in modules if importlib.util.find_spec(name) is None]
sys.exit(0 if not missing else 1)
"@

    & $PythonExe -c $probe | Out-Null
    return $LASTEXITCODE -eq 0
}

function Ensure-BackendEnvironment {
    if (-not (Test-CommandExists "python")) {
        throw "Python is not installed or not in PATH."
    }

    if (-not (Test-Path $VenvPython)) {
        Write-Host ""
        Write-Host "[Bootstrap] Creating Python virtual environment..." -ForegroundColor Yellow
        Set-Location $ProjectRoot
        python -m venv .venv
    }

    $NeedInstall = $true
    if ((Test-Path $BackendStamp) -and (Test-Path $RequirementsFile)) {
        $NeedInstall = (Get-Item $BackendStamp).LastWriteTimeUtc -lt (Get-Item $RequirementsFile).LastWriteTimeUtc
    }
    if (-not $NeedInstall) {
        $NeedInstall = -not (Test-PythonModule -PythonExe $VenvPython -Modules @("uvicorn", "fastapi", "pydantic"))
    }

    if ($NeedInstall) {
        Write-Host ""
        Write-Host "[Bootstrap] Installing Python dependencies..." -ForegroundColor Yellow
        & $VenvPython -m pip install --upgrade pip
        & $VenvPython -m pip install -r $RequirementsFile
        if (-not (Test-PythonModule -PythonExe $VenvPython -Modules @("uvicorn", "fastapi", "pydantic"))) {
            throw "Python dependencies appear incomplete after installation. Missing required backend modules."
        }
        Set-Content -Path $BackendStamp -Value (Get-Date).ToString("o") -Encoding ASCII
    }

    if ((-not (Test-Path $EnvFile)) -and (Test-Path $EnvExample)) {
        Write-Host ""
        Write-Host "[Bootstrap] Creating .env from .env.example ..." -ForegroundColor Yellow
        Copy-Item $EnvExample $EnvFile
    }

    if (Test-Path $EnvFile) {
        $envContent = Get-Content $EnvFile -Raw -ErrorAction SilentlyContinue
        if ($envContent -notmatch "OPENAI_API_KEY\s*=\s*.+") {
            Write-Host ""
            Write-Host "[Notice] OPENAI_API_KEY does not appear to be configured in .env yet." -ForegroundColor Yellow
            Write-Host "The app can start, but extraction features may fail until you fill it in."
        }
    }
}

function Ensure-FrontendEnvironment {
    if (-not (Test-CommandExists "npm")) {
        throw "Node.js/npm is not installed or not in PATH."
    }

    if (-not (Test-Path $FrontendRoot)) {
        throw "Missing frontend directory."
    }

    $NodeModules = Join-Path $FrontendRoot "node_modules"
    $NeedInstall = -not (Test-Path $NodeModules)
    if ((-not $NeedInstall) -and (Test-Path $FrontendStamp) -and (Test-Path $PackageLock)) {
        $NeedInstall = (Get-Item $FrontendStamp).LastWriteTimeUtc -lt (Get-Item $PackageLock).LastWriteTimeUtc
    } elseif (-not (Test-Path $FrontendStamp)) {
        $NeedInstall = $true
    }

    if ($NeedInstall) {
        Write-Host ""
        Write-Host "[Bootstrap] Installing frontend dependencies..." -ForegroundColor Yellow
        Set-Location $FrontendRoot
        npm install
        if (-not (Test-Path $NodeModules)) {
            throw "npm install did not create frontend\node_modules."
        }
        Set-Content -Path $FrontendStamp -Value (Get-Date).ToString("o") -Encoding ASCII
    }
}

Write-Host ""
Write-Host "== Bootstrap Environment ==" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"

if (-not $FrontendOnly) {
    Ensure-BackendEnvironment
}

if (-not $BackendOnly) {
    Ensure-FrontendEnvironment
}

Write-Host ""
Write-Host "Environment is ready." -ForegroundColor Green
