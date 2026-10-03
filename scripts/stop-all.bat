@echo off
title Douyin Song Request - Stop All
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1" %*
echo.
echo Press any key to close this window ...
pause >nul
