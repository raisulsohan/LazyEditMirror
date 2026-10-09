# LazyEditMirror - operating guide

LazyEditMirror is a free, MIT-licensed UXP panel for Adobe Premiere Pro (26.5+): it copies a Front Camera edit onto a Side Camera track with the same cuts and timing, syncing the two cameras by audio through a local helper (Node.js + ffmpeg). One of Raisul Sohan's Lazy tools.

## Read first

1. This file.
2. [docs/development.md](docs/development.md) for how the pieces fit, then only the files it points to.
3. [docs/api-research.md](docs/api-research.md) before touching premiere.js: every Premiere call is listed there with its caveats.

## Hard rules

- **Commits are Raisul Sohan's alone.** Never add an AI or co-author line to a commit, pull request or release. Do the work yourself; no subagents.
- **Reply in Bengali.** Code, comments, docs, commit messages and file names are English.
- **Ask before launching an Adobe app or downloading anything.** Nothing can drive Premiere Pro from the command line; a real run is the user's.
- **Never invent a Premiere API.** The reference is Adobe's `@adobe/premierepro` type declarations (`npm view @adobe/premierepro`) and developer.adobe.com; if a call is not there, it does not exist.
- **premiere.js is the only file that calls `premierepro`.** sync.js and plan.js must keep running against `tools/mock-premiere.mjs`.
- **Every timeline change is its own `executeTransaction`** and is counted; never write onto an audio track that has clips; never touch clips already on the Target track.
- **UXP is not a browser**: flexbox only, no `DOMContentLoaded`, CommonJS `require("./x.js")`, `<select>` values set explicitly, no reliance on the clipboard.
- **No audio access inside UXP**: the audio work stays in `helper/` (the engine, `audio.js`, the launcher), reached through `helper.js` over 127.0.0.1. UXP cannot open `.bat` files; the engine is started through the `lazyeditmirror:` URL scheme the installer registers.
- **The installed engine lives in `%LOCALAPPDATA%\LazyEditMirror\engine`**, the panel wherever Creative Cloud put it (per user under `%APPDATA%\Adobe\UXP\Plugins\External` or for all users under `%ProgramFiles%\Common Files\Adobe\UXP\Plugins\External`); `npm run sync` handles both.

## Commands

```
npm test                  # must pass before any build
npm run helper:selftest   # when audio.js or helper/ changed (needs ffmpeg)
npm run build             # dist/LazyEditMirror-<version>.ccx
npm run sync              # copy over the installed plugin, then the user restarts Premiere
npm run release           # tests + .ccx + installers -> "00. Install from here"
```

## Reflexes

| When you are about to... | Do this |
|---|---|
| change plan.js or sync.js | add or adjust a case in tools/test-plan.mjs / tools/test-sync.mjs; `npm test` |
| change helper/ (engine, audio.js, launcher) | `node tools/test-audio.mjs` and `npm run helper:selftest`; the installer copies `helper/` as `engine/` |
| change premiere.js | check the call in docs/api-research.md; model it in tools/mock-premiere.mjs |
| change the panel markup or styles | `npm run preview` and look at it at 340 px wide |
| change the manifest or the shipped file list | update `PLUGIN_FILES` in tools/build-ccx.mjs |
| publish a version | docs/development.md "Building a release"; version in manifest.json, package.json, main.js; CHANGELOG.md; README "Version" line |
