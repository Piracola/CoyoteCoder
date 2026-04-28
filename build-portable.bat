@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-portable.ps1" %*
if errorlevel 1 (
  echo.
  echo Build failed. Press any key to close this window.
  pause >nul
)
