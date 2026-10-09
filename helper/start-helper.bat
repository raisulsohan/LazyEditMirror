@echo off
setlocal EnableExtensions EnableDelayedExpansion
title LazyEditMirror audio engine

rem Runs the audio engine in a visible window (for a look at what it does, or
rem when the hidden launcher is not registered). The panel normally starts it
rem by itself through launch-hidden.vbs. Keep this window open while you work.

cd /d "%~dp0"

where node >NUL 2>&1
if errorlevel 1 (
    echo Node.js was not found on this computer. The audio engine runs on Node.js.
    echo.
    set /p ANSWER=Install Node.js now with winget ^(Y/N^)?
    if /i "!ANSWER!"=="Y" (
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        echo.
        echo Close this window and start the engine again so the new PATH is picked up.
    ) else (
        echo Install Node.js from https://nodejs.org and start the engine again.
    )
    pause
    exit /b 1
)

where ffmpeg >NUL 2>&1
if errorlevel 1 (
    echo ffmpeg was not found on the PATH. The audio engine reads the camera files with ffmpeg.
    echo.
    set /p ANSWER2=Install ffmpeg now with winget ^(Y/N^)?
    if /i "!ANSWER2!"=="Y" (
        winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
        echo.
        echo Close this window and start the engine again so the new PATH is picked up.
    ) else (
        echo Install ffmpeg ^(for example "winget install Gyan.FFmpeg"^) and start the engine again.
    )
    pause
    exit /b 1
)

node "%~dp0sync-helper.mjs"
echo.
echo The engine stopped.
pause
