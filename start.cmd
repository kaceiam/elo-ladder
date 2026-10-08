@echo off
setlocal EnableDelayedExpansion
rem Starts the Elo Ladder server. Uses node on PATH, or the portable install.
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul
rem Use the first portable copy found. On this PC that's v22.14, which Windows
rem Firewall already lets phones on the Wi-Fi connect to (v22.20 is blocked).
if errorlevel 1 (
  for /d %%D in ("%LOCALAPPDATA%\node-portable\node-v*-win-x64") do if "!NODE!"=="node" set "NODE=%%D\node.exe"
)
"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo Could not find Node.js. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
rem Open the browser a moment after the server starts
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:8080/"
"%NODE%" server.js
pause
