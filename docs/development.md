# Development

*Written for LazyEditMirror 1.1.1.*

## How it fits together

```
Premiere Pro (UXP runtime)                       the user's account
+----------------------------------+             +-----------------------------------+
| index.html + main.js  (DOM)      |             | %LOCALAPPDATA%\LazyEditMirror\    |
|   sync.js      engine            |   fetch     |   engine\sync-helper.mjs          |
|   premiere.js  premierepro API   | <---------> |     HTTP 127.0.0.1:5182           |
|   helper.js    engine client     |             |     ffmpeg -> PCM -> audio.js     |
|   plan.js      maths (pure)      |  openExternal   engine\launch-hidden.vbs      |
+----------------------------------+  lazyeditmirror:  cache\  engine.log          |
                                                 +-----------------------------------+
```

- **premiere.js** is the only file that touches `require("premierepro")`.
  It returns plain data (ticks as numbers) plus the opaque Premiere objects
  the sync needs to hand back. Every call it makes is listed in
  [api-research.md](api-research.md).
- **sync.js** is the engine of the panel: `analyze(params)` builds a plan
  for one pass (and a structured `report` for the result card);
  `sync(analysis)` performs it one undoable transaction at a time and
  verifies the Target track afterwards. It only knows the adapter interface,
  so it runs unchanged against the mock in tests.
- **plan.js** and **helper/audio.js** are pure maths with no I/O: time
  mapping, cut/gap detection, verification; envelopes, FFT cross-correlation,
  the match decision.
- **helper/sync-helper.mjs** is the audio engine. It ships inside the `.ccx`
  (`helper/`) and in the download zip (`engine/`); the installer copies the
  latter to `%LOCALAPPDATA%\LazyEditMirror\engine`, registers the
  `lazyeditmirror:` URL scheme to `launch-hidden.vbs` (HKCU, no window) and
  a per-user Run entry. The panel opens `lazyeditmirror:start` through
  `shell.openExternal()` when `/health` does not answer; UXP refuses to open
  `.bat` files directly, hence the scheme. The engine exits after three idle
  hours, logs to `engine.log`, and steps aside if another instance owns the
  port.
- **main.js** knows whether the installer ran by looking for
  `engine/installed.json` under the user's folder (`localFileSystem:
  fullAccess`), so it never opens the scheme on a machine where nothing
  handles it.

## Running from a clone

```
npm test                  # node --check on the panel files, then the three test suites
npm run helper:selftest   # synthetic MP4s through ffmpeg and a real engine on port 5199
npm run build             # dist/LazyEditMirror-<version>.ccx (a zip; manifest.json at the root)
npm run sync              # copy the plugin files over the installed plugin and the engine copy
npm run helper            # the engine in a window, from the repository
npm run preview           # the panel with sample data in a browser, for layout work
npm run icons             # redraw icons/ (tools/make-icons.mjs, a 60-line PNG writer)
```

The dev loop: install a release once (the zip's installer, with Premiere
closed), then edit, `npm test`, `npm run sync` (it refreshes the plugin
folder, per-user or all-users, and the engine copy, and asks a running
engine to quit so the launcher starts the new one), restart Premiere Pro.
The panel has no console without Adobe's UXP Developer Tool; it logs into
itself and into `LazyEditMirror-log.txt` in its data folder instead, and
the engine logs into `engine.log`.

## Tests

- `tools/test-plan.mjs`: plan.js on hand-made clip lists (cuts, gaps,
  mapping, skipping, verification).
- `tools/test-audio.mjs`: audio.js on synthetic speech-like recordings:
  offsets recovered within a frame, unrelated takes rejected.
- `tools/test-sync.mjs`: premiere.js + sync.js against
  `tools/mock-premiere.mjs`, a model of the premierepro API (tracks, items,
  overwrite with linked audio, selection removal, transactions) and a fake
  audio client. It proves the control flow; Premiere's own behaviour was
  confirmed on 26.5.2 (see api-research.md section 4).
- `tools/selftest-helper.mjs`: the real engine, real ffmpeg, synthetic
  media.

## Rules the code keeps

- Everything the panel does to the sequence is an `Action` committed in its
  own `executeTransaction` (Premiere does not guarantee the order of several
  actions in one compound action). The count of transactions is reported so
  a pass can be undone.
- Audio is never written onto a track that has clips. The parking track must
  be empty; the reference clip's own audio does not count.
- Clips already on the Target track are never touched; a pass only fills
  free ranges.
- The engine binds 127.0.0.1 only, runs ffmpeg on paths Premiere reported,
  and installs nothing without a Yes in a dialog.
- No CSS grid, no float, no `DOMContentLoaded` reliance, CommonJS `require`
  with explicit `./file.js` paths, `<select>` values set explicitly: UXP's
  engine is not a browser.
- Times are integer ticks (254,016,000,000 per second) everywhere; seconds
  appear only at the edges (UI, engine protocol).

## Building a release

1. Set the version in `manifest.json`, `package.json` and `main.js`
   (`VERSION`), add the entry to `CHANGELOG.md`, update the version lines in
   README.md and docs.
2. `npm run release`: runs the tests, builds the `.ccx`, and zips it with
   `engine/` (the helper folder plus `manifest.json`), `tools/installer/*`
   (the Windows installer and uninstaller, the macOS command, the start-here
   note), `LICENSE.txt` and `README.md` into `LazyEditMirror-<version>.zip`
   in the nearest "00. Install from here" folder above the repository (or
   `dist/`). A `.sha256.txt` is written next to it.
3. Install the zip on a clean machine with Premiere closed and run
   [testing.md](testing.md).

The `.ccx` is not signed; Creative Cloud installs third-party `.ccx` files
after a warning (and, because of the network and file permissions, may
install it for all users under Program Files). The engine is plain
JavaScript run by the user's Node.js; ffmpeg is the user's own installation
(winget's Gyan build or any other).
