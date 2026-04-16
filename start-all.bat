@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%start-all.ps1"

if not exist "%PS_SCRIPT%" (
    echo Missing file: start-all.ps1
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

if errorlevel 1 (
    echo.
    echo Failed to start the project.
    pause
    exit /b 1
)

endlocal
