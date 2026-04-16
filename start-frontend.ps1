param(
    [switch]$SkipBootstrap,
    [switch]$DevMode
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnsureScript = Join-Path $ProjectRoot "ensure-environment.ps1"
$FrontendRoot = Join-Path $ProjectRoot "frontend"
$BuildIdFile = Join-Path $FrontendRoot ".next\BUILD_ID"

function Get-LatestWriteTimeUtc {
    param([string[]]$Paths)

    $latest = [datetime]::MinValue
    foreach ($path in $Paths) {
        if (-not (Test-Path $path)) {
            continue
        }

        $item = Get-Item $path
        if ($item.PSIsContainer) {
            $times = Get-ChildItem -Path $path -Recurse -File -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty LastWriteTimeUtc
            foreach ($time in $times) {
                if ($time -gt $latest) {
                    $latest = $time
                }
            }
        } elseif ($item.LastWriteTimeUtc -gt $latest) {
            $latest = $item.LastWriteTimeUtc
        }
    }
    return $latest
}

if (-not $SkipBootstrap) {
    & $EnsureScript -FrontendOnly
}

Set-Location $FrontendRoot

Write-Host ""
Write-Host "== Start Frontend ==" -ForegroundColor Cyan
Write-Host "Frontend URL: http://127.0.0.1:3000" -ForegroundColor Green
Write-Host ""

if ($DevMode) {
    Write-Host "Mode: development" -ForegroundColor Yellow
    npm run dev
    exit $LASTEXITCODE
}

$SourcePaths = @(
    (Join-Path $FrontendRoot "app"),
    (Join-Path $FrontendRoot "components"),
    (Join-Path $FrontendRoot "lib"),
    (Join-Path $FrontendRoot "public"),
    (Join-Path $FrontendRoot "package.json"),
    (Join-Path $FrontendRoot "package-lock.json"),
    (Join-Path $FrontendRoot "next.config.ts"),
    (Join-Path $FrontendRoot "tsconfig.json")
)

$NeedsBuild = -not (Test-Path $BuildIdFile)
if (-not $NeedsBuild) {
    $buildTime = (Get-Item $BuildIdFile).LastWriteTimeUtc
    $sourceTime = Get-LatestWriteTimeUtc -Paths $SourcePaths
    $NeedsBuild = $sourceTime -gt $buildTime
}

Write-Host "Mode: production" -ForegroundColor Green
if ($NeedsBuild) {
    Write-Host "Building frontend..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} else {
    Write-Host "Using existing frontend build." -ForegroundColor Green
}

npm run start
