@echo off
setlocal EnableExtensions
title LazyEditMirror - build and install

rem Builds dist\LazyEditMirror-<version>.ccx and installs it through Adobe's
rem Unified Plugin Installer Agent (the tool Creative Cloud uses for .ccx files).
rem Needs Node.js. Close Premiere Pro first.

cd /d "%~dp0.."

where node >NUL 2>&1
if errorlevel 1 (
    echo Node.js was not found. Install it from https://nodejs.org and run this again.
    pause
    exit /b 1
)

node tools\build-ccx.mjs
if errorlevel 1 (
    echo The build failed.
    pause
    exit /b 1
)

set "CCX="
for %%F in ("dist\LazyEditMirror-*.ccx") do set "CCX=%%~fF"
if not defined CCX (
    echo No .ccx was produced in dist\.
    pause
    exit /b 1
)

set "UPIA=%ProgramFiles%\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if not exist "%UPIA%" set "UPIA=%ProgramFiles(x86)%\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

if exist "%UPIA%" (
    echo Installing "%CCX%" ...
    "%UPIA%" /install "%CCX%"
    echo.
    echo If the installer reported success: start Premiere Pro and open
    echo Window ^> UXP Plugins ^> LazyEditMirror.
) else (
    echo Creative Cloud's installer agent was not found.
    echo Double-click "%CCX%" to install it with the Creative Cloud desktop app.
)

echo.
pause
exit /b 0
