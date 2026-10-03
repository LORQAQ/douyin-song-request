@echo off
rem ============================================================
rem  SongOverlay - launcher
rem
rem  Starts the overlay window. Builds it first if needed.
rem
rem  You can pass arguments through, for example:
rem     run.bat --fixed
rem     run.bat --behind --no-cover
rem
rem  NOTE: this file is intentionally ASCII-only (see build.bat).
rem ============================================================
setlocal

cd /d "%~dp0"

if not exist "bin\SongOverlay.exe" (
  echo SongOverlay.exe not found - building it first...
  echo.
  call "%~dp0build.bat"
  if not exist "bin\SongOverlay.exe" (
    echo.
    echo [ERROR] Build failed - see the messages above.
    pause
    exit /b 1
  )
)

start "" "bin\SongOverlay.exe" %*

echo.
echo   Song overlay started.
echo.
echo   Hotkeys:
echo     Ctrl+Alt+T   toggle click-through
echo     Ctrl+Alt+M   turn click-through OFF (then you can drag it)
echo     Ctrl+Alt+Q   quit
echo.
echo   In the Live Companion:
echo     Add Source - Window Capture - pick "SongOverlay"
echo.
echo   This window closes in 5 seconds...
timeout /t 5 /nobreak >nul
