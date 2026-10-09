# Testing LazyEditMirror in Premiere Pro

The automated tests (`npm test`) prove the panel's logic against a model of
the Premiere API. This protocol proves the model: it takes about ten
minutes and uses a throwaway project.

## Before you start

- Premiere Pro 26.5 or later, closed.
- Install the panel: double-click `dist/LazyEditMirror-0.2.0.ccx` (or run
  `tools\install.bat`). Start Premiere Pro.
- Work on a **copy** of a project, or a new one.

## Test project

1. Import two recordings of the same take: the front camera (A) and the
   side camera (B). Ideally two front files (A1, A2) and two side files
   (B1, B2) so the two-pass flow gets exercised. If you have none, export
   the same clip twice with different names and treat them as A and B.
2. Create a sequence from the front file(s). On V1, make three or four cuts
   with the razor and delete one piece in the middle so the track has a
   gap. Leave the audio on A1.
3. Keep V2 empty (the Target). Make sure one audio track **has no clips**
   (say A3); add a track if needed (right-click an audio track header >
   Add Track).
4. Install the release with *Install LazyEditMirror - Windows.bat* (it sets
   up the audio engine; `npm run helper:selftest` proves the engine without
   Premiere).
5. Open **Window > UXP Plugins > LazyEditMirror**.

## Steps and what to expect

| Step | Expected |
| --- | --- |
| Panel opens | The log says `Read sequence "..."`; Master shows V1, Target V2; the pill in the corner says *Audio engine ready* (or *Starting audio engine* for a few seconds, with one permission dialog from Premiere the first time). Under the log a line names the log file on disk. |
| Pick B1 as the side footage, click **Analyze** | The status shows "Listening to ..." per file (slow the first time, instant afterwards). Then the result card: a green row for A1 (`side = front +/- X s (correlation ...)`, *M to place*), an amber row for A2 (*no match in this side file*, *N waiting*), the totals line, a note about the parking audio track. The Sync button reads *Sync M clips*. `%LOCALAPPDATA%\LazyEditMirror\engine.log` logs the same offsets. |
| Analyze after killing the engine (Task Manager > node.exe) | The pill goes *Starting audio engine* and comes back *ready*; Analyze continues. |
| Advanced: *Selected clips are in sync* with nothing selected | Red card explaining what to select. |
| Analyze with the extra offset set to `abc` | Red message: the offset must be a number. |
| Analyze with Target = Master | Red message: different tracks. |
| Click **Sync M clips** twice | A progress bar runs; V2 has one B1 clip per A1 clip, at the same positions, with the same gap. A1 audio untouched, A3 empty. The card turns green: *Placed M clips (verified). R front clips still waiting ...* and the status says `Placed M clips on V2 (K undo steps).` |
| Second pass | Pick B2 as the side footage, Analyze: the A1 row is grey (*done*), the A2 row green. Sync. The card ends with *Every front clip is covered.* |
| Scrub a cut point | A and B show the same moment; the voice on A1 and the picture on V2 are in lip sync. |
| Scrub a cut point | A and B show the same moment (same frame of the performance). If B is consistently early or late, Undo the pass, type the correction into the extra offset (seconds, + = later in B), Analyze, Sync again. |
| **Edit > Undo** K times | The sequence is exactly as before the pass. |
| Save, close, reopen the project | The B clips on V2 keep their in-points (this checks the trim path against a reported Premiere bug). |

## Other sync references

*Match by source timecode* only works for jam-synced cameras; if the files'
timecodes do not overlap, Analyze says so and points back to the selection
method. *Offset only*: select one A clip (its front file gets the offset),
find one moment in both files (a clap), note its source time in A and in B,
and enter `B - A` seconds as the extra offset. In every mode the log lists
every skipped clip with the reason.

## What to send back if something is off

1. The log: click **Save log...** and attach the file, or open the file
   named under the log (the plugin's data folder) and paste its contents.
   **Copy** also works when UXP grants the clipboard.
2. A screenshot of the timeline after the sync (tracks V1, V2, A1 to A3).
3. Premiere version (Help > About) and the step that misbehaved.

Three things the tests could not decide and the log will show:

- **Audio left on A3** ("audio clip(s) remain on A3"): Premiere did not remove
  the parked audio with `mediaType = AUDIO`.
- **Every clip landed X s away** ("systematic offset"): the overwrite time is
  measured from the sequence zero point rather than its start.
- **Missing or extra clips on V2**: removal took more or less than the
  selected items.

Any of these is a one-line change in `premiere.js` once known.
