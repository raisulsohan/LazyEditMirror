# LazyEditMirror - Premiere Pro Extension

> **Cut the front camera once; the side camera follows.** LazyEditMirror
> copies a Front Camera edit onto a Side Camera track (same cuts, same
> timing) and finds the sync between the two cameras by listening to their
> audio. Pick a side-camera file, click Analyze, click Sync. Nothing to set
> up, nothing overwritten.

Developed by **[Raisul Sohan](https://raisulsohan.com)** · **Version 1.1.1** ·
[Documentation](docs/README.md) · [Changelog](CHANGELOG.md) · MIT licensed

---

## What it does

You edit a presenter video from the front camera on V1, cutting away the
pauses and mistakes. The side camera recorded the same performance but you
do not want to repeat the edit on it. LazyEditMirror:

1. reads every clip on the Master track (front camera): which file, which
   source range, where on the timeline;
2. measures the time offset between the chosen side-camera file and every
   front-camera file by cross-correlating their audio (a small *audio
   engine* in the background does the listening, with ffmpeg);
3. places one side-camera clip per front clip at exactly the same timeline
   position, showing the same moment of the performance;
4. reads the Target track back, verifies every clip, and tells you which
   front clips still need another side-camera file.

The Master track may be cut from several front files and the side camera
may have several files: you run one pass per side file, and clips that are
already on the Target track are never touched.

## Requirements

- Adobe **Premiere Pro 26.5** or later (Windows; macOS experimental).
- The audio engine runs on **Node.js** and reads files with **ffmpeg**. The
  installer, and later the engine itself, offer to install either with
  `winget` when it is missing; nothing is downloaded without asking you.
- The sequence needs one **audio track with no clips** (the side audio is
  parked there for a moment during each placement).

## Install

**Windows**

1. Download `LazyEditMirror-1.1.1.zip` and extract it completely.
2. Close Premiere Pro and run **Install LazyEditMirror - Windows.bat**. It
   installs the panel through Creative Cloud's own plugin installer, puts
   the audio engine in your user folder (`%LOCALAPPDATA%\LazyEditMirror`),
   and offers to install Node.js and ffmpeg if they are missing.
3. Open Premiere Pro: **Window > UXP Plugins > LazyEditMirror**.

Uninstall with **Uninstall LazyEditMirror - Windows.bat** (removes the panel
and the engine) or in Creative Cloud under Plugins > Manage plugins.

**macOS (experimental)**: extract, open *Install LazyEditMirror - macOS
(EXPERIMENTAL).command*, install Node.js from nodejs.org and ffmpeg with
`brew install ffmpeg`. On macOS the engine is started by hand (see the
manual).

## Use

1. Cut the front-camera footage on one video track (the **Master**, say
   V1). Keep another video track empty for the side camera (the **Target**,
   say V2) and make sure one audio track has no clips.
2. Open the panel. The pill in the corner says *Audio engine ready*; if the
   engine is not running yet the panel starts it (Premiere asks once
   whether the panel may do that).
3. Choose the Master track, the Target track and the first **Side camera
   footage** (every media file in the project is listed; front files come
   last, marked *(front, on V1)*).
4. Click **Analyze**. The engine reads the audio of the side file and of
   every front file (slow the first time, instant afterwards) and the result
   card shows, per front file, what it found: `side = front +0.635 s
   (correlation 0.84)` and *23 to place*, or *no match in this side file*
   and *32 waiting*.
5. Click **Sync 23 clips**, then click it again to confirm. The clips appear
   on the Target track and the card says how many front clips still need a
   side file.
6. Pick the next side file and repeat from step 4 until *Every front clip
   is covered*.

Every step is a separate entry in **Edit > Undo**; the status line tells you
how many steps a pass made.

### Advanced options

Hidden under *Show advanced options* because the default does the job:

| Sync reference | Use it when |
| --- | --- |
| **Audio match** (default) | Both cameras heard the same sound. The engine measures the offset. |
| Selected clips are in sync | The audio is unusable. Drop the side clip on a free track, sync it with one Master clip yourself (select both, right-click > Synchronize > Audio), keep both selected, Analyze. Covers that front file. |
| Match by source timecode | Jam-synced cameras. |
| Offset only | You measured the offset yourself; select a Master clip of the front file it belongs to. |

The **extra offset** (seconds, + = later in the side file) is added in every
mode, for a fine correction. *Start audio engine* and *Open engine folder*
are there for the rare case the engine has to be started by hand.

## How the audio sync works

Premiere's UXP API cannot read audio samples, so the matching is done by a
small program outside Premiere: the audio engine (`helper/sync-helper.mjs`),
a local HTTP server (127.0.0.1 only) that uses ffmpeg to decode each file's
audio to 8 kHz mono, turns it into a 200 Hz loudness envelope, caches that
envelope, and cross-correlates side against front by FFT. The lag with the
strongest, clearly isolated peak is the offset; everything below the bar is
reported as *no match* and left out. The method is calibrated on synthetic
recordings (`npm test`) and checked through ffmpeg end to end
(`npm run helper:selftest`).

The installer copies the engine to `%LOCALAPPDATA%\LazyEditMirror\engine`,
registers the `lazyeditmirror:` URL scheme (the panel opens it to start the
engine without a window) and a per-user startup entry, so the engine is
simply there. It exits by itself after three idle hours, logs to
`engine.log` in that folder and keeps its cache next to it.

## How it treats audio on the timeline

Premiere's overwrite edit always brings a clip's linked audio along; the API
has no video-only option. LazyEditMirror parks the side audio on an empty
audio track and removes it right after each placement, so the Target track
ends up video-only and no existing audio is touched. A side clip you drop on
the timeline as a reference is consumed together with its audio.

## Limitations (1.1)

- One side file per pass. A front clip is placed only when it fits inside
  the side file whole.
- No speed changes (such clips are skipped), no transitions on the Master
  track, no effects or settings are copied; subclips, nested sequences,
  multicam and merged clips are skipped with a note in the log.
- Offsets are measured to 5 ms and snapped to the sequence frame grid; the
  two cameras should share a frame rate.
- The side footage's own in/out marks (Source Monitor) are cleared by the
  sync.

## Project layout

```
LazyEditMirror/
  manifest.json  index.html  styles.css   the UXP panel shell (manifest v5)
  main.js                                 DOM wiring, engine start, result card
  sync.js                                 the engine: analyze() and sync()
  premiere.js                             the only file that calls the premierepro API
  helper.js                               client for the audio engine
  plan.js                                 pure maths: cuts, gaps, mapping, verification
  log.js                                  in-panel log (also written to a file)
  helper/                                 the audio engine (ships inside the .ccx and the zip)
    sync-helper.mjs  audio.js  launch-hidden.vbs  start-helper.bat  start-helper.command
  icons/                                  panel and plugin-list icons (tools/make-icons.mjs)
  tools/                                  build, release, installers, tests, mock
  docs/                                   manual, troubleshooting, development, research
```

## Development

```
npm test                  # syntax check, plan, audio and end-to-end tests on a mock Premiere
npm run helper:selftest   # builds synthetic MP4s with ffmpeg and checks the engine end to end
npm run build             # dist/LazyEditMirror-<version>.ccx
npm run release           # tests, .ccx, engine, installers and licence zipped into "00. Install from here"
npm run sync              # copies the files over the installed plugin and engine (then restart Premiere)
npm run helper            # runs the audio engine in a window, from the repository
npm run preview           # the panel with sample data in a browser, for layout work
npm run icons             # redraws icons/ from tools/make-icons.mjs
```

See [docs/development.md](docs/development.md) for how the pieces fit
together and the rules the code keeps.

## Documentation

- [docs/manual.md](docs/manual.md): every control, the result card, the
  engine, undo, tips.
- [docs/troubleshooting.md](docs/troubleshooting.md): every message the
  panel can show and what to do.
- [docs/development.md](docs/development.md): architecture, tests, release.
- [docs/api-research.md](docs/api-research.md): the Premiere Pro
  extensibility landscape and the API calls this panel relies on.
- [docs/testing.md](docs/testing.md): the manual test protocol.

LazyEditMirror is one of Raisul Sohan's Lazy tools. MIT licensed.
