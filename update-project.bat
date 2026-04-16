@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%update-project.ps1"

if not exist "%PS_SCRIPT%" (
    echo Missing file: update-project.ps1
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

if errorlevel 1 (
    echo.
    echo Failed to update the project.
    pause
    exit /b 1
)

endlocal
