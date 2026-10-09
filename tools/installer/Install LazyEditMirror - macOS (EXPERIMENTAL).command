#!/bin/bash
# LazyEditMirror installer for macOS (experimental: built and tested on Windows).
# Installs the panel (.ccx) through Creative Cloud's plugin installer and puts the
# audio engine in ~/Library/Application Support/LazyEditMirror/engine.
cd "$(dirname "$0")" || exit 1

CCX=$(ls LazyEditMirror-*.ccx 2>/dev/null | head -n 1)
if [ -z "$CCX" ] || [ ! -f "engine/sync-helper.mjs" ]; then
  echo "The LazyEditMirror .ccx or the engine folder was not found next to this file. Extract the whole ZIP first."
  read -r -p "Press Return to close."
  exit 1
fi

UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
if [ -x "$UPIA" ]; then
  "$UPIA" --install "$CCX"
else
  echo "Creative Cloud's installer was not found; opening the .ccx with the Creative Cloud app instead."
  open "$CCX"
fi

ENGINE="$HOME/Library/Application Support/LazyEditMirror/engine"
mkdir -p "$ENGINE"
cp engine/* "$ENGINE/"
chmod +x "$ENGINE/start-helper.command"
echo "{\"installedAt\":\"$(date)\",\"engine\":\"$ENGINE\"}" > "$ENGINE/installed.json"

echo
echo "Open Premiere Pro and choose Window > UXP Plugins > LazyEditMirror."
echo "On macOS the audio engine is started by hand: open"
echo "  $ENGINE/start-helper.command"
echo "and keep its window open while you sync. It needs Node.js (https://nodejs.org) and ffmpeg (brew install ffmpeg)."
read -r -p "Press Return to close."
