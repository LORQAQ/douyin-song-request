@echo off
title Stop Douyin song-request
echo Stopping Douyin song-request on port 8787 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force; Write-Output ('stopped pid ' + $_) } } else { Write-Output 'nothing listening on 8787' }"
echo.
echo Done.
timeout /t 3 >nul