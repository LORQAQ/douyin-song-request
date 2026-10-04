@echo off
title Douyin Song Request - Start All
cd /d "%~dp0.."

echo.
echo   ============================================
echo      Douyin Song Request - Start All
echo   ============================================
echo.

rem ---- 1) Start the server if not already running ----
netstat -ano 2>nul | findstr /r /c:"127.0.0.1:8787 .*LISTENING" >nul
if not errorlevel 1 (
  echo   [1/4] Server already running - skip
  goto :skip_server
)

echo   [1/4] Starting server ...
rem NOTE: the server itself launches the DEDICATED audio player (a separate
rem Chrome profile started with --autoplay-policy=no-user-gesture-required).
rem That flag is the only reliable way to get sound WITHOUT clicking the page.
rem Do NOT open the audio page with the default browser here - that browser
rem has no such flag, so the page would demand a click every time.
start "DouyinSongRequest" /min cmd /c "node src\index.js"
echo         waiting for it to come up ...
set /a _wait=0
:wait_loop
timeout /t 1 /nobreak >nul
set /a _wait+=1
netstat -ano 2>nul | findstr /r /c:"127.0.0.1:8787 .*LISTENING" >nul
if not errorlevel 1 goto :server_ready
if %_wait% lss 20 goto :wait_loop
echo         WARNING: server did not come up in 20s - check Node.js
goto :skip_server

:server_ready
echo         Server ready: http://127.0.0.1:8787/
echo         Audio player  : started by the server (separate window)

:skip_server
echo.
echo   [2/4] Opening console ...
start "" "http://127.0.0.1:8787/"

echo   [3/4] Audio page is opened by the server itself (see above).
echo         If no audio window appeared, run: npm run player
timeout /t 1 /nobreak >nul

rem The song-list overlay is an independent add-on, NOT shipped with this repo.
rem If you compiled it into overlay\bin\, start it too.
rem IMPORTANT: keep this file pure ASCII - cmd parses .bat using the local
rem codepage, so UTF-8 Chinese bytes here break the whole script.
if exist "%~dp0..\overlay\bin\SongOverlay.exe" (
  echo   [+] Starting song-list overlay ...
  tasklist /fi "imagename eq SongOverlay.exe" 2>nul | findstr /i "SongOverlay.exe" >nul
  if not errorlevel 1 (
    echo       Overlay already running - skip
  ) else (
    start "" "%~dp0..\overlay\bin\SongOverlay.exe"
  )
)

echo.
echo   ============================================
echo      Ready
echo   ============================================
echo.
echo   Console   http://127.0.0.1:8787/
echo   Audio     separate window (auto-opened, no click needed)
echo.
echo   Tips:
echo     - Audio page should show a GREEN line when it can feed the stream
echo     - Song-list overlay for viewers: an add-on, see overlay\README.md
echo     - Stop everything: desktop shortcut "Stop"
echo.
echo   This window closes in 6 seconds ...
timeout /t 6 /nobreak >nul
exit
