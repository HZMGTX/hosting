@echo off
title OmniHost
cd /d "%~dp0"
echo ========================================================
echo  Starting OmniHost...
echo ========================================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies for the first time...
  call npm install --omit=dev
)
start "" http://localhost:3000
node server.js
pause
