# LazyEditMirror manual

*Written for LazyEditMirror 1.1.2.*

## 1. The idea

Two cameras recorded the same performance: a front camera and a side
camera. You edit the front camera on one video track, removing pauses and
mistakes. LazyEditMirror puts the side camera on another track with exactly
the same cuts, showing the same moment at every point, so you can switch
angles in the edit without redoing the work.

It works in **passes**: one side-camera file at a time. Each pass places the
front clips that this side file can cover and reports which front clips are
still waiting for another side file. Clips already on the side track are
never touched, so a pass can be repeated safely.

## 2. Setting up the sequence

- **Master track**: the front-camera edit, usually V1. It may be cut from
  several front files. No transitions (remove them first), no speed changes
  (such clips are skipped).
- **Target track**: an empty video track for the side camera, usually V2.
- **One empty audio track**, for example A3. Premiere always brings a clip's
  audio along when a clip is placed; LazyEditMirror parks it on that track
  and deletes it right away. A track whose only clips belong to a side clip
  you dropped as a reference counts as empty.
- The side-camera files imported into the project. They do not need to be
  on the timeline.

## 3. The audio engine

The sync is measured by a small program that the installer puts in your
user folder (`%LOCALAPPDATA%\LazyEditMirror\engine`). It decodes the audio
of the files with ffmpeg and finds the lag at which the two recordings line
up. You do not start it: it runs in the background from login, and the panel
starts it when it is not running (Premiere asks once whether the panel may
do that). The pill in the panel's corner shows its state:

| Pill | Meaning |
| --- | --- |
| *Audio engine ready* | All good. |
| *Starting audio engine* | Launched, answering within a few seconds. |
| *Audio engine off* | It did not answer. Click the pill to try again; if a window asked to install Node.js or ffmpeg, finish that first. |
| *Audio engine not installed* | The installer has not run on this user account. Run *Install LazyEditMirror - Windows.bat* once, or start the engine by hand from *Advanced options > Open engine folder > start-helper.bat*. |
| *ffmpeg missing* | The engine runs but cannot find ffmpeg. `winget install Gyan.FFmpeg`, then click the pill. |
| *Manual sync* | A manual sync reference is selected; the engine is not needed. |

Reading a big camera file takes a while the first time (the status line
says which file it is listening to); the result is cached in
`%LOCALAPPDATA%\LazyEditMirror\cache`, so later passes are instant. The
engine exits by itself after three idle hours and logs to `engine.log` next
to the cache.

On macOS the engine is started by hand: open
`~/Library/Application Support/LazyEditMirror/engine/start-helper.command`
and keep its window open.

## 4. The panel

**1 · Tracks**: the front-camera edit (Master) and the side-camera track
(Target).

**2 · Side camera footage**: every media file in the project. Front files
(cut on the Master track) are listed last and marked *(front, on V1)*; files
Premiere cannot read are marked *(offline)*. *Refresh* re-reads the project.

**Show advanced options** opens:

- *Sync reference*: how the side file is synced to the front files.
  - **Audio match** (default): the engine measures it.
  - **Selected clips are in sync**: you synced one side clip with one
    Master clip yourself (select both, right-click > Synchronize > Audio)
    and keep both selected. If no Master clip is selected, the one under the
    side clip's start is used. Covers that front file only; the side clip is
    consumed by the sync.
  - **Match by source timecode**: both cameras carry matching timecode.
  - **Offset only**: you measured the offset; select a Master clip of the
    front file it belongs to.
- *Extra offset in seconds*: added to the measured or chosen offset in every
  mode. Positive moves the match later in the side file. Use it for a
  one-frame correction (0.04 s at 25 fps) if you ever need one.
- *Start audio engine* and *Open engine folder*: for starting the engine by
  hand (see section 3).

**Analyze** reads the sequence and the files and fills the result card.
Nothing is changed. **Sync N clips** performs the pass; it asks for a second
click to confirm. Changing any control forgets the analysis.

## 5. Reading the result card

One row per front file on the Master track:

| Row | Meaning |
| --- | --- |
| green · `side = front +0.635 s (correlation 0.84)` · *23 to place* | Matched. The same moment is 0.635 s later in the side file than in this front file; 23 clips will be placed. *Correlation* is how alike the two loudness curves are over the overlapping seconds. |
| amber · *no match in this side file* · *32 waiting* | The side file does not cover this front file (or shares too little sound with it). Its clips wait for another side file. |
| amber · *weak match, not used* | There is a candidate offset but the peak is not clearly above the noise; sync that pair by hand if you know they overlap. |
| grey · *already on the side track* · *26 done* | Done in an earlier pass. |
| red · *audio could not be read* | ffmpeg could not decode the file; see the log. |

The line under the rows sums it up: *23 clips to place (209.0 s) · 26 done
· 37 waiting*. Notes mention a reference clip that will be consumed, the
parking audio track, an extra offset, and frame-rate warnings.

After the sync the card turns green: *Placed 23 clips (verified). 63 front
clips still waiting: C0003.mp4 32, C0004.mp4 5, C0005.mp4 26. Pick the next
side file.* The verification reads the Target track back and compares it
with the plan.

## 6. Undo

Every Premiere transaction LazyEditMirror makes is one entry in Edit > Undo
(remove reference, mark, place, drop audio, ... ). The status line reports
the count after a pass, so a pass can be reverted with that many Ctrl+Z.

## 7. The log

*Show* under *Log* opens the panel's log of everything that happened. It is
also written to a file after every action; the path is shown under the log
(`LazyEditMirror-log.txt` in the plugin's data folder). *Save...* saves it
anywhere; *Copy* puts it on the clipboard when Premiere allows it. Send that
file when you report a problem.

## 8. Tips

- Long side files are fine: a side file that covers two front files places
  both in one pass.
- Short overlaps are not: a front file needs at least about 25 seconds in
  common with the side file to be matched reliably.
- Different takes never match, which is the point: the engine refuses
  rather than guesses.
