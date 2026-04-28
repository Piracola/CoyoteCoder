@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-portable.ps1" %*
