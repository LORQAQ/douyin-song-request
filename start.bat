@echo off
title Douyin song-request
cd /d "%~dp0"

echo ================================================
echo   Douyin song-request  --  Bilibili auto play
echo ================================================
echo.

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
  echo.
)

echo Console : http://127.0.0.1:8787/
echo Audio   : http://127.0.0.1:8787/audio
echo Close this window to stop the service.
echo.

rem Also start the song-list overlay if it is installed (independent add-on,
rem NOT shipped with this repo - compile it into overlay\bin\ to enable).
rem IMPORTANT: keep this file pure ASCII. cmd parses .bat files using the
rem local codepage, so UTF-8 Chinese bytes here break the whole script.
if exist "overlay\bin\SongOverlay.exe" (
  tasklist /fi "imagename eq SongOverlay.exe" 2>nul | findstr /i "SongOverlay.exe" >nul
  if errorlevel 1 (
    echo Starting song-list overlay ...
    start "" "overlay\bin\SongOverlay.exe"
  ) else (
    echo Song-list overlay already running.
  )
  echo.
)

node src/index.js --open %*

echo.
echo Program exited.
pause