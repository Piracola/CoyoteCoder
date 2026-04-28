@echo off
setlocal

title CoyoteCoder Dev Startup

set "ROOT=%~dp0"
set "START_SCRIPT=%ROOT%scripts\start-all.ps1"

if not exist "%START_SCRIPT%" (
  echo [CoyoteCoder] Missing startup script:
  echo   "%START_SCRIPT%"
  set "EXIT_CODE=1"
  goto :finish
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [CoyoteCoder] powershell.exe was not found in PATH.
  set "EXIT_CODE=1"
  goto :finish
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [CoyoteCoder] npm.cmd was not found in PATH. Please install Node.js first.
  set "EXIT_CODE=1"
  goto :finish
)

echo [CoyoteCoder] Starting local development validation stack...
echo [CoyoteCoder] Forwarding arguments to scripts\start-all.ps1: %*
echo.
echo [CoyoteCoder] Keep this window open. Closing it stops the managed services.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%START_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [CoyoteCoder] Startup failed with exit code %EXIT_CODE%.
) else (
  echo.
  echo [CoyoteCoder] Startup session ended.
)

:finish
if not defined EXIT_CODE set "EXIT_CODE=0"
if not "%COYOTE_NO_PAUSE%"=="1" (
  echo.
  pause
)

exit /b %EXIT_CODE%
