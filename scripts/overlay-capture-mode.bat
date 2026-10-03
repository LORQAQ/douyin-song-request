@echo off
rem ============================================================
rem  Song Overlay - Capture Compatible Mode
rem
rem  When to use:
rem    The "Window Capture" list in Live Companion cannot find
rem    the "SongOverlay" window. This mode disables click-through,
rem    because a few capture tools skip layered windows that also
rem    have the click-through flag.
rem
rem  Tradeoff: the overlay will respond to the mouse, so clicking
rem  on it blocks what is underneath. Handy for positioning it.
rem
rem  To go back: close it and use the normal launcher.
rem ============================================================

cd /d "%~dp0.."
if not exist "overlay\bin\SongOverlay.exe" (
  echo [ERROR] overlay\bin\SongOverlay.exe not found.
  echo         Run "npm run overlay:build" first.
  pause
  exit /b 1
)

rem Kill any already-running overlay so we don't end up with two
taskkill /f /im SongOverlay.exe >nul 2>nul
timeout /t 1 /nobreak >nul

start "" "overlay\bin\SongOverlay.exe" --fixed

echo.
echo   Song overlay started in CAPTURE COMPATIBLE MODE.
echo   (click-through disabled - you can drag it with the mouse)
echo.
echo   Now try: Live Companion - Add Source - Window Capture - "SongOverlay"
echo.
echo   This window closes in 5 seconds...
timeout /t 5 /nobreak >nul