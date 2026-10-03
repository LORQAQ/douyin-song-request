@echo off
title Douyin song-request - background
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run, installing dependencies ...
  call npm install --no-audit --no-fund
)

echo Started in background.
echo   Console : http://127.0.0.1:8787/
echo   Stop    : run stop.bat
echo.
cscript //nologo "%~dp0start-background.vbs"
echo Done.
timeout /t 3 >nul