# Premiere Pro extensibility research for LazyEditMirror

*Written for LazyEditMirror 0.2.0, October 2026. Verified against Adobe's
published documentation and the official `@adobe/premierepro` 26.5.0 type
declarations (the npm package Adobe generates from the runtime).*

## 1. The two architectures Adobe currently supports

| | UXP (Unified Extensibility Platform) | CEP + ExtendScript |
| --- | --- | --- |
| Status | Adobe's current platform. Public beta in Premiere 25.2 (Dec 2024), **official release in 25.6**; API reference now at 26.5. | Legacy. Premiere lists these panels under *Window > Extensions (Legacy)*. Adobe staff, April 2025: "CEP is going away. We don't have a firm end date, but probably within a year" after UXP ships. ExtendScript itself: "Adobe currently has no plan or schedule for removing ExtendScript" (docsforadobe, Nov 2025). |
| Language / runtime | Modern JavaScript (async/await, CommonJS `require`), one process, `require("premierepro")` for the DOM API. | HTML/JS panel (Chromium 88 in CEP 11) talking to an ES3 ExtendScript engine through `evalScript` strings. |
| Timeline reading | `Sequence`, `VideoTrack.getTrackItems()`, `VideoClipTrackItem` getters. | `app.project.activeSequence.videoTracks[i].clips[j]` with `start/end/inPoint/outPoint/projectItem`. |
| Timeline editing | Action objects committed in `Project.executeTransaction()` (undoable): overwrite, insert, remove, clone, set in/out, move, set start/end. | `Track.overwriteClip()/insertClip()`, `TrackItem.remove()`, read/write `start/end/inPoint/outPoint`, `ProjectItem.setInPoint()/setOutPoint()`. |
| Loading / install | `.ccx` installed by Creative Cloud (double-click or UPIA); development with the UXP Developer Tool 2.2+ (admin install). | Copy a folder into `CEP/extensions` with `PlayerDebugMode`, or a signed `.zxp`. |
| Minimum Premiere | 25.6 for UXP; this panel needs **26.5** (`Media.getStart()`). | 2021+ |

**Decision: UXP.** It is the platform Adobe is building on, it already has
every call this tool needs, the user's Premiere is 26.5.2, and a `.ccx`
installs with a double-click. CEP would have been the path of least
resistance for the author's existing tools, but it is on a stated sunset
path; a new tool should not start there. The trade-off accepted: no
debugger without the UXP Developer Tool, so the panel carries its own log.

## 2. Reading sequence tracks and clips (UXP)

All from `require("premierepro")`, signatures from the 26.5.0 declarations.

| Need | Call | Notes |
| --- | --- | --- |
| Active project / sequence | `Project.getActiveProject()`, `project.getActiveSequence()` | both async |
| Video tracks | `sequence.getVideoTrackCount()`, `sequence.getVideoTrack(i)` | async; `AudioTrack` has the same shape |
| Clips on a track | `track.getTrackItems(Constants.TrackItemType.CLIP, false)` | **synchronous**, returns `VideoClipTrackItem[]`; `TRANSITION` lists transitions |
| Timeline position | `item.getStartTime()`, `item.getEndTime()` | `TickTime`, "relative to the sequence start time" |
| Source range | `item.getInPoint()`, `item.getOutPoint()` | "relative to the start time of the project item referenced by this track item", i.e. 0 = first frame of the file |
| Source media | `item.getProjectItem()` then `ClipProjectItem.cast(projectItem)` | cast returns a falsy value when the item is not a clip |
| Media file, start timecode, duration | `clipItem.getMediaFilePath()`, `clipItem.getMedia()` then `media.getStart()`, `media.getDuration()` | `getStart/getDuration` are new in **26.5**; the async `start/duration` properties are deprecated |
| Guards | `getSpeed()`, `isSpeedReversed()`, `isAdjustmentLayer()`, `clipItem.isSequence()/isMulticamClip()/isMergedClip()/isOffline()`, `getContentType()` | used to reject what the MVP does not support |
| Frame rate | `sequence.getSettings()` then `settings.getVideoFrameRate()` (sync, 26.2+) giving `FrameRate.ticksPerFrame`; fallback `sequence.getTimebase()` | used to snap in-points to frames |
| Project browsing | `project.getRootItem()` (FolderItem), `folder.getItems()`, `item.type` against `ProjectItem.TYPE_BIN / TYPE_CLIP`, `FolderItem.cast()` | fills the Side Camera footage list |

Times are `TickTime` objects: `ticksNumber`, `ticks` (string), `seconds`,
`add/subtract`, `alignToNearestFrame(frameRate)`; created with
`TickTime.createWithTicks(string)` or `createWithSeconds(number)`. One
second is 254,016,000,000 ticks.

## 3. Creating, trimming and removing timeline clips (UXP)

Every edit is an **Action** added to a compound action inside
`project.executeTransaction(callback, undoLabel)` (returns `boolean`),
itself called inside `project.lockedAccess(callback)`. Each transaction is
one Undo entry.

| Need | Call |
| --- | --- |
| Editor for a sequence | `SequenceEditor.getEditor(sequence)` (static, sync) |
| Choose the source range to place | `clipItem.createSetInOutPointsAction(inTick, outTick)` on the **ClipProjectItem**; "Clip in and out point determines the length of trackItem when it is used to be inserted into the sequence" (Adobe staff, May 2025). Clear with `createClearInOutPointsAction()`. |
| Place a clip without rippling | `editor.createOverwriteItemAction(projectItem, time, videoTrackIndex, audioTrackIndex)` |
| Place with ripple (not used) | `editor.createInsertProjectItemAction(projectItem, time, videoTrackIndex, audioTrackIndex, limitShift)`; "If you pass a track index greater than the number of existing tracks, a new track will be created." |
| Remove clips | `TrackItemSelection.createEmptySelection(cb)`, `selection.addItem(item, true)` inside `cb`, then `editor.createRemoveItemsAction(selection, ripple, mediaType, shiftOverLapping)` |
| Trim an existing clip (not used) | `item.createSetInPointAction()`, `createSetOutPointAction()`, `createSetStartAction()`, `createSetEndAction()`, `createMoveAction()` |
| Duplicate (not used) | `editor.createCloneTrackItemAction(item, timeOffset, vOffset, aOffset, alignToVideo, isInsert)` |

The sync therefore runs, per Master clip: set in/out on the side footage ->
overwrite at the Master clip's start -> remove the parked audio; and once:
clear the Target track before, clear the side footage marks after.

## 4. Limitations found that shaped the design

1. **No video-only placement.** Overwrite and insert always take the clip's
   linked audio to `audioTrackIndex`. Passing `null` errors; `-1` "just
   treats it as 0" (developer report, Aug 2026), i.e. **it overwrites A1**.
   The 0.1.0 prototype passed -1 and would have destroyed the user's main
   audio. The MVP parks audio on an audio track that has **no clips** and
   deletes it right after each placement; with no empty track it refuses to
   run. Creating a track is only documented for insert, so it is not relied
   on. *Confirmed on 26.5.2: every placement reported "audio dropped" and
   the parking track was empty afterwards.*
2. **Action order inside one compound action is not guaranteed.** A
   developer saw the overwrite execute before the in/out change queued
   ahead of it; separate transactions fixed it. Hence one transaction per
   step and many Undo entries.
3. **Track-item in/out actions have a bug history**: silent no-ops in 25.3
   and 25.4 beta builds; a May 2026 report that `createSetInPointAction` on
   video items does not survive save/reopen in 26.2. The MVP never trims a
   placed clip; it marks the project item first, which produces an ordinary
   clip.
4. **Source Monitor crash (26.3.2, Aug 2026)** after repeated mark /
   overwrite / clear while the clip was open in the Source Monitor;
   workaround `SourceMonitor.closeAllClips()`. The sync calls it first.
5. **Media start timecode needs 26.5** (`Media.getStart()`); before that the
   only route was `Metadata.getProjectColumnsMetadata()` and parsing
   `Column.Intrinsic.MediaStart`, which Adobe's own sample does. Hence
   `minVersion 26.5.0`.
6. **No API to add or delete tracks**, so the parked-audio track must exist.
7. **`createRemoveItemsAction`'s `mediaType` is undocumented.** The panel
   passes VIDEO when removing video items and AUDIO for audio items and
   verifies the Target track afterwards. *Confirmed on Premiere Pro 26.5.2
   (9 Oct 2026): removing the parked audio items with AUDIO left the placed
   video clips in place, and the post-sync verification passed.*
8. **Overwrite `time` frame of reference** is undocumented (sequence start vs
   zero point). `getStartTime()` is documented as relative to the sequence
   start, so the same value is passed; the post-sync verification detects a
   uniform shift and reports it. *Confirmed on 26.5.2: 23 clips landed
   exactly at their Master positions.*
9. **UXP UI engine**: no CSS grid or float (flexbox only), CommonJS
   `require` for local files with the `.js` extension, no console without
   the UXP Developer Tool, clipboard needs
   `requiredPermissions.clipboard: "readAndWrite"` and
   `navigator.clipboard.setContent({"text/plain": ...})`.
10. **No audio access from UXP.** The DOM API has no audio-sample reader, no
    Web Audio, no child processes, and no way to invoke Premiere's own
    *Synchronize* command (nothing of the kind in the 26.5.0 declarations).
    The UXP file API also loads whole files into memory, which rules out
    reading multi-gigabyte camera files in the panel. The brief excluded
    audio sync for the MVP; the user's footage turned out not to be
    jam-synced, so audio matching was added **outside** UXP: a local Node
    helper (`helper/sync-helper.mjs`) that runs ffmpeg and answers over
    HTTP on 127.0.0.1, reached from the panel with `fetch()` under the
    manifest's `network` permission. The maths (`audio.js`): 200 Hz
    log-energy envelopes with a 1 s moving average removed, standardized,
    FFT cross-correlation, overlap-weighted peak (z = corr * sqrt(overlap))
    with a runner-up prominence test; calibrated on synthetic recordings in
    `tools/test-audio.mjs` and checked end to end through ffmpeg by
    `tools/selftest-helper.mjs`.

## 5. Minimal folder structure

```
LazyEditMirror/
  manifest.json  index.html  styles.css        panel shell (UXP manifest v5)
  main.js                                      DOM wiring only
  sync.js                                      analyze() / sync() engine
  premiere.js                                  the premierepro adapter (only API caller)
  plan.js                                      pure maths, unit-tested
  log.js                                       in-panel log
  tools/   build-ccx.mjs install.bat sync-installed.mjs mock-premiere.mjs test-plan.mjs test-sync.mjs
  docs/    api-research.md testing.md
  dist/    LazyEditMirror-<version>.ccx
```

The adapter/engine split exists so the whole edit sequence can be run under
Node against `tools/mock-premiere.mjs`; what the tests cannot prove is
Premiere's own semantics, which is what [testing.md](testing.md) covers.

## Sources

- Premiere Pro UXP reference (classes, since-versions): https://developer.adobe.com/premiere-pro/uxp/ppro_reference/
- Official type declarations, `@adobe/premierepro` 26.5.0: https://github.com/adobe/premierepro-types
- UXP changelog (25.2 beta, 25.6 release, 26.3 and 26.5 changes): https://developer.adobe.com/premiere-pro/uxp/changelog
- Development tools (UDT 2.2, developer mode): https://developer.adobe.com/premiere-pro/uxp/introduction/essentials/dev-tools/
- Installing a plugin (.ccx, UPIA): https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/install
- Manifest v5: https://developer.adobe.com/premiere-pro/uxp/plugins/concepts/manifest/
- JavaScript modules in UXP: https://developer.adobe.com/premiere-pro/uxp/resources/recipes/js-modules
- Clipboard recipe: https://developer.adobe.com/premiere-pro/uxp/resources/recipes/clipboard
- Adobe sample panel (premiere-api): https://github.com/AdobeDocs/uxp-premiere-pro-samples
- "UXP Arrives in Premiere" (Adobe blog, Dec 2025): https://blog.developer.adobe.com/en/publish/2025/12/uxp-arrives-in-premiere-a-new-era-for-plugin-development
- Clip in/out determines inserted length (Adobe staff): https://forums.creativeclouddeveloper.com/t/clip-in-out-point-usage-in-uxp-ripple-trim/10800
- Ripple delete / "CEP is going away" (Adobe staff): https://forums.creativeclouddeveloper.com/t/how-do-i-trim-ripple-delete-a-part-of-a-sequence/10426
- Insert project item (working transaction code): https://forums.creativeclouddeveloper.com/t/how-to-add-clips-to-a-sequence-using-premiere-pro-uxp-api/8977
- Action order inside one compound action: https://forums.creativeclouddeveloper.com/t/how-to-cut-clips-in-premierepro-uxp/11266
- Remove + overwrite split workaround: https://forums.creativeclouddeveloper.com/t/premiere-pro-uxp-dom-eta-for-programmatic-split-razor-on-timeline/11375
- Audio/video-only insertion, `-1` treated as track 0: https://forums.creativeclouddeveloper.com/t/inserting-only-audio-only-video-from-mp4-in-a-sequence/12099
- Track-item in-point persistence bug (26.2): https://community.adobe.com/bug-reports-728/trackitem-createsetinpointaction-does-not-persist-across-save-reopen-for-video-tracks-in-uxp-in-points-revert-to-the-source-clip-s-original-in-point-audio-trackitems-unaffected-regression-in-26-2-1624188
- Source Monitor crash (26.3.2): https://community.adobe.com/questions-729/premiere-pro-26-3-2-crashes-in-source-monitor-after-repeated-uxp-clipprojectitem-in-out-updates-and-overwrite-edits-1638409
- CEP to UXP gap summary: https://forums.creativeclouddeveloper.com/t/premierepro-migrating-from-cep-to-uxp-community-api-gap-issue-summary/11373
- ExtendScript reference (CEP comparison): https://ppro-scripting.docsforadobe.dev/
- UXP unsupported features (float, no grid): https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/unsupported/
