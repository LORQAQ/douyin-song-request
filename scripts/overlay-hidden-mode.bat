@echo off
rem ============================================================
rem  Song Overlay - "Hidden Behind" Mode
rem
rem  Goal: you do NOT see the song list on your own desktop,
rem        but the Live Companion still captures it.
rem
rem  How it works:
rem    Starts the overlay WITHOUT always-on-top, and pushes it to
rem    the bottom of the window stack. Keep the Live Companion
rem    window in front and it completely covers the overlay.
rem
rem  Whether it works depends on how the Live Companion captures:
rem    * Windows Graphics Capture  -> captures occluded windows, WORKS
rem    * old BitBlt                -> captures what is on screen, FAILS
rem
rem  Test: start this, put Live Companion in front (or fullscreen),
rem        then look at the preview in Live Companion.
rem          overlay content visible -> it works, keep using this mode
rem          nothing / black         -> not supported, use normal mode
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

taskkill /f /im SongOverlay.exe >nul 2>nul
timeout /t 1 /nobreak >nul

start "" "overlay\bin\SongOverlay.exe" --behind --fixed

echo.
echo   Song overlay started in HIDDEN-BEHIND mode.
echo.
echo   1. Put the Live Companion window in FRONT of the overlay
echo      (or make it fullscreen). The overlay should now be hidden.
echo   2. Check the Live Companion preview:
rem  NOTE: never put ">" in an echo line, not even escaped. Why:
rem          echo ... -^> not supported
rem        parses as  echo ... -  > not supported
rem        i.e. cmd sees a file named "-" ... actually it creates a junk file
rem        named "not" and swallows the text. Escaping does NOT save you here
rem        because cmd re-parses after removing the caret.
rem        So: use plain words instead of arrows in echo. (Learned the hard way.)
echo        - overlay content IS visible   = it works, keep this mode
echo        - blank or wrong content       = not supported,
echo                                         use the normal launcher
echo   3. Ctrl+Alt+Q quits the overlay.
echo.
echo   This window closes in 8 seconds...
timeout /t 8 /nobreak >nul
