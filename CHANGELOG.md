# Changelog

## 1.1.2 (2026-10-09)

- More colourful panel: a deep indigo base, a colour stripe under the
  header, its own colour for every card (violet tracks, cyan footage, green
  result, amber log), a violet *Analyze* and a pink *Sync* button and a
  violet-pink-amber progress bar. Gradients sit on top of solid colours, so
  a host that ignores them still shows the solid colour.
- "Raisul Sohan" in the footer is a link: a click opens
  https://raisulsohan.com in the browser (the manifest now also allows the
  `https` scheme for `shell.openExternal`).

## 1.1.1 (2026-10-10)

- Buttons, the engine pill and the advanced-options link are styled `div`s:
  UXP draws `<button>` with the host's own look, ignores its background
  colour and turns a large border radius into a jagged shape, so the 1.1.0
  panel looked nothing like its design inside Premiere.
- The side-footage list prefers files from bins other than the front
  files' bin (the unused front file in the Front bin was being preselected).
- Step badges no longer break the card title onto two lines.

## 1.1.0 (2026-10-10)

Nothing to start, nothing to learn: install, open the panel, pick the side
file, Analyze, Sync.

- The audio engine is installed by the installer into the user's folder
  (`%LOCALAPPDATA%\LazyEditMirror\engine`), registered as the handler of the
  `lazyeditmirror:` URL scheme and as a startup item, and runs in the
  background without a window. The panel starts it when it is not running
  (UXP refuses to open `.bat` files, so the scheme replaces the 1.0.0
  "Start helper" button). It exits after three idle hours, keeps `engine.log`
  and steps aside if another instance is running. Node.js and ffmpeg are
  offered through winget by the installer and by the launcher when missing.
- New panel: steps instead of settings, an engine status pill in the corner,
  a progress bar, a result card with one row per front file (match, offset,
  correlation, clips to place / done / waiting) and a plain totals line; the
  manual sync references and the engine buttons live under *Advanced
  options*; the log is collapsed; *Sync* shows the number of clips.
- The uninstaller removes the engine, its registry entries and its cache.
- `npm run sync` refreshes the plugin whether it was installed per user or
  for all users (Program Files) and refreshes the engine copy.

## 1.0.0 (2026-10-10)

First release as a standalone tool.

- **Audio match** is the default sync reference: a helper program shipped
  inside the plugin (`helper/`) decodes the side file and every front file
  with ffmpeg, cross-correlates their loudness envelopes and hands the panel
  the offsets. Matches are reported with their correlation; weak or absent
  matches are named and left out. One long side file can cover several front
  files in a single pass.
- **Start helper** button in the panel: launches the helper's console window
  from the installed plugin folder (Premiere asks once). The launcher checks
  for Node.js and ffmpeg and offers to install them with winget.
- The Side Camera footage list marks front files *(front, on V1)* and
  unreadable items *(offline)* and lists them last; choosing one fails with
  a clear message before any audio is read.
- Panel icons (dark and light UI themes, plugin list), version in the
  footer, the mode list no longer starts blank.
- Installers: `Install LazyEditMirror - Windows.bat` (Creative Cloud's
  plugin installer + optional winget installs), uninstaller, experimental
  macOS command, start-here note; `npm run release` builds the download zip
  with a SHA-256 file.
- Documentation: manual, troubleshooting, development guide, operating
  guide for assistants (AGENTS.md), MIT licence.

Confirmed on Premiere Pro 26.5.2 with a four-file front edit (86 clips):
the audio match found the side file's offset at correlation 0.84 and the
pass placed and verified 23 clips.

## 0.2.0 (2026-10-09)

Rewrite of the MVP after verifying every call against Adobe's Premiere Pro
UXP reference and the official 26.5.0 type declarations.

- Works in passes, one side clip at a time: the Master track may be cut from
  several front files; each pass places the Master clips its side clip can
  cover (same front file, inside the side file, not yet on the Target track)
  and reports what still needs a side clip. Clips already on the Target
  track are never touched; the reference side clip (and its linked audio)
  is consumed.
- Sync references: a selected Master clip + side clip pair that lie in sync
  on the timeline (pairs with Premiere's Synchronize > Audio), matching
  source timecode per front file, or a hand-entered offset.
- Side-camera audio is parked on an empty audio track and removed after each
  placement. 0.1.0 passed `-1` as the audio track index, which Premiere
  treats as track 0: it would have overwritten the audio on A1.
- Side in-points are snapped to the sequence frame grid; after the sync the
  Target track is read back and compared with the plan.
- The Source Monitor is cleared before editing (works around a reported
  26.3.2 crash).
- In-panel log, written to a file after every action, with Save and Copy.
- Code split into plan.js (pure maths), premiere.js (API adapter), sync.js
  (engine), main.js (DOM); `npm test` runs unit tests and an end-to-end run
  against a mock of the Premiere API.

## 0.1.0

First prototype generated by another assistant: UXP panel with track pickers,
offset field, Analyze and Sync. Installed and recognised by Premiere Pro
26.5.2 but never run against a sequence.
