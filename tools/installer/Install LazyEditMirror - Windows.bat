@echo off
setlocal EnableExtensions EnableDelayedExpansion
title LazyEditMirror Installer

echo.
echo LazyEditMirror Installer
echo ========================
echo.

set "CCX="
for %%F in ("%~dp0LazyEditMirror-*.ccx") do set "CCX=%%~fF"
if not defined CCX (
    echo The LazyEditMirror .ccx file was not found next to this installer.
    echo Extract the whole ZIP first, then run this file from the extracted folder.
    echo.
    pause
    exit /b 1
)
if not exist "%~dp0engine\sync-helper.mjs" (
    echo The "engine" folder was not found next to this installer. Extract the whole ZIP first.
    echo.
    pause
    exit /b 1
)

tasklist /FI "IMAGENAME eq Adobe Premiere Pro.exe" /NH 2>NUL | find /I "Adobe Premiere Pro.exe" >NUL
if not errorlevel 1 (
    echo Close Premiere Pro first, then run this installer again.
    echo.
    pause
    exit /b 2
)

rem ---- 1. The panel, through Creative Cloud's plugin installer ----
set "UPIA=%ProgramFiles%\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if not exist "%UPIA%" set "UPIA=%ProgramFiles(x86)%\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if not exist "%UPIA%" (
    echo Creative Cloud's plugin installer was not found on this computer.
    echo Install or repair the Creative Cloud desktop app, or double-click this file instead:
    echo   %CCX%
    echo.
    pause
    exit /b 3
)

echo Installing the panel ...
"%UPIA%" /install "%CCX%"
if errorlevel 1 (
    echo.
    echo The installer reported a problem. You can also double-click the .ccx file
    echo to install it through the Creative Cloud desktop app, then run this installer
    echo again for the audio engine.
    echo.
    pause
    exit /b 4
)

rem ---- 2. The audio engine, for this Windows user ----
set "HOME_DIR=%LOCALAPPDATA%\LazyEditMirror"
set "ENGINE=%HOME_DIR%\engine"
echo Installing the audio engine to %ENGINE% ...
if not exist "%ENGINE%" mkdir "%ENGINE%" >NUL 2>&1
copy /Y "%~dp0engine\*.*" "%ENGINE%\" >NUL
if errorlevel 1 (
    echo Could not copy the audio engine files.
    pause
    exit /b 5
)
> "%ENGINE%\installed.json" echo {"installedAt":"%DATE% %TIME%","engine":"%ENGINE:\=\\%"}

rem The panel opens lazyeditmirror: links to start the engine; register the handler (current user only).
reg add "HKCU\Software\Classes\lazyeditmirror" /ve /t REG_SZ /d "URL:LazyEditMirror audio engine" /f >NUL
reg add "HKCU\Software\Classes\lazyeditmirror" /v "URL Protocol" /t REG_SZ /d "" /f >NUL
reg add "HKCU\Software\Classes\lazyeditmirror\shell\open\command" /ve /t REG_SZ /d "wscript.exe \"%ENGINE%\launch-hidden.vbs\" \"%%1\"" /f >NUL
rem Start it at login too, so it is simply there.
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LazyEditMirrorEngine /t REG_SZ /d "wscript.exe \"%ENGINE%\launch-hidden.vbs\"" /f >NUL

rem ---- 3. Node.js and ffmpeg, if missing ----
where node >NUL 2>&1
if errorlevel 1 (
    echo.
    echo The audio engine runs on Node.js, which was not found.
    set /p ANSWER=Install Node.js now with winget ^(Y/N^)?
    if /i "!ANSWER!"=="Y" winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
)
where ffmpeg >NUL 2>&1
if errorlevel 1 (
    echo.
    echo The audio engine reads camera files with ffmpeg, which was not found.
    set /p ANSWER2=Install ffmpeg now with winget ^(Y/N^)?
    if /i "!ANSWER2!"=="Y" winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
)

rem ---- 4. Start the engine now (hidden). A fresh process sees the new PATH. ----
start "" wscript.exe "%ENGINE%\launch-hidden.vbs"

echo.
echo Installed. Open Premiere Pro and choose Window ^> UXP Plugins ^> LazyEditMirror.
echo.
pause
exit /b 0
