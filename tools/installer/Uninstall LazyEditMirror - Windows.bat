@echo off
setlocal EnableExtensions
title LazyEditMirror Uninstaller

echo.
echo LazyEditMirror Uninstaller
echo ==========================
echo.

tasklist /FI "IMAGENAME eq Adobe Premiere Pro.exe" /NH 2>NUL | find /I "Adobe Premiere Pro.exe" >NUL
if not errorlevel 1 (
    echo Close Premiere Pro first, then run this again.
    echo.
    pause
    exit /b 2
)

rem ---- the audio engine ----
set "HOME_DIR=%LOCALAPPDATA%\LazyEditMirror"
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LazyEditMirrorEngine /f >NUL 2>&1
reg delete "HKCU\Software\Classes\lazyeditmirror" /f >NUL 2>&1
rem Ask a running engine to stop, then remove its folder (engine, cache, log).
powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5182/quit -TimeoutSec 2 | Out-Null } catch {}" >NUL 2>&1
timeout /t 1 /nobreak >NUL
if exist "%HOME_DIR%" rmdir /S /Q "%HOME_DIR%" >NUL 2>&1
echo The audio engine was removed.

rem ---- the panel ----
set "UPIA=%ProgramFiles%\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if not exist "%UPIA%" set "UPIA=%ProgramFiles(x86)%\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if not exist "%UPIA%" (
    echo Creative Cloud's plugin installer was not found. Remove the panel from the
    echo Creative Cloud desktop app instead: Plugins ^> Manage plugins ^> LazyEditMirror.
    echo.
    pause
    exit /b 3
)
"%UPIA%" /remove LazyEditMirror
echo.
echo LazyEditMirror was removed.
echo.
pause
exit /b 0
