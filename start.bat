@echo off
title Douyin song-request
cd /d "%~dp0"

echo ================================================
echo   Douyin song-request  -^>  Bilibili auto play
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

rem 顺带把歌单悬浮窗拉起来（已经在跑就跳过）。
rem 悬浮窗是独立子项目，不随这个仓库分发 —— 自己编译好放在 overlay\bin\ 才会启动。
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