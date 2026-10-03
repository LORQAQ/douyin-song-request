@echo off
rem ============================================================
rem  SongOverlay - build script
rem
rem  Compiles all four programs using the C# compiler that ships
rem  with Windows. No Visual Studio, no .NET SDK required.
rem
rem  NOTE: this file is intentionally ASCII-only. Chinese text in
rem  a .bat breaks on Chinese Windows (cmd reads the file in the
rem  local codepage, not UTF-8). Chinese docs live in README.md.
rem ============================================================
setlocal

cd /d "%~dp0"

set CSC64=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set CSC32=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe

if exist "%CSC64%" (set CSC=%CSC64%) else (set CSC=%CSC32%)
if not exist "%CSC%" (
  echo [ERROR] csc.exe not found - .NET Framework 4.x seems to be missing.
  pause
  exit /b 1
)

if not exist "bin" mkdir bin

echo Compiler: %CSC%
echo.

rem ---- close running instances so the exe files are not locked ----
taskkill /f /im SongOverlay.exe >nul 2>nul
taskkill /f /im OverlayPlacer.exe >nul 2>nul
taskkill /f /im WhereIsIt.exe >nul 2>nul
taskkill /f /im WinDiag.exe >nul 2>nul
timeout /t 1 /nobreak >nul

set REFS=/reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll
set FAILED=0

echo [1/4] SongOverlay.exe    - the overlay window
"%CSC%" /nologo /target:winexe /optimize+ /out:bin\SongOverlay.exe %REFS% SongOverlay.cs
if errorlevel 1 (echo        FAILED & set FAILED=1) else (echo        OK)

echo [2/4] OverlayPlacer.exe  - positioning tool
"%CSC%" /nologo /target:winexe /optimize+ /out:bin\OverlayPlacer.exe %REFS% OverlayPlacer.cs
if errorlevel 1 (echo        FAILED & set FAILED=1) else (echo        OK)

echo [3/4] WhereIsIt.exe      - locate / move the window
"%CSC%" /nologo /target:exe /optimize+ /out:bin\WhereIsIt.exe %REFS% WhereIsIt.cs
if errorlevel 1 (echo        FAILED & set FAILED=1) else (echo        OK)

echo [4/4] WinDiag.exe        - window diagnostics
"%CSC%" /nologo /target:exe /optimize+ /out:bin\WinDiag.exe %REFS% WinDiag.cs
if errorlevel 1 (echo        FAILED & set FAILED=1) else (echo        OK)

echo.
if "%FAILED%"=="1" (
  echo Some targets FAILED - see the errors above.
) else (
  echo All done. Output is in the "bin" folder.
)
echo.
echo Next: run bin\SongOverlay.exe
echo.
pause
