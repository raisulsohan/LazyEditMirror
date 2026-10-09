#!/bin/bash
# Starts the LazyEditMirror audio engine on macOS. Keep this window open while
# you use the panel. Needs Node.js (https://nodejs.org) and ffmpeg
# (brew install ffmpeg).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org and open this file again."
  read -r -p "Press Return to close."
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg was not found. Install it with: brew install ffmpeg"
  read -r -p "Press Return to close."
  exit 1
fi

node "./sync-helper.mjs"
echo "The engine stopped."
read -r -p "Press Return to close."
