@echo off
rem Double-click to connect your Apple developer account to the GitHub build.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-ios-secrets.ps1"
pause
