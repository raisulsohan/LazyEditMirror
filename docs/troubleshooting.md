# If something goes wrong

*Written for LazyEditMirror 1.1.1.* The panel's log (*Show* under *Log*,
and the file named there) explains most situations; this page lists the
messages and what to do.

## The panel

| You see | Meaning and fix |
| --- | --- |
| The panel is not in Window > UXP Plugins | The plugin is not installed, or Premiere Pro is older than 26.5. Run the installer again with Premiere closed, or double-click the `.ccx`. |
| *No Premiere Pro project is open* / *Open the sequence you want to mirror* | Open the project and double-click the sequence so it is the active one, then *Refresh*. |
| The Side camera footage list is empty | The project has no plain media clips (only sequences or graphics). Import the camera files. |

## Audio engine (the pill in the corner)

| You see | Meaning and fix |
| --- | --- |
| *Audio engine not installed* | The installer has not run on this Windows account (double-clicking the `.ccx` installs only the panel). Run *Install LazyEditMirror - Windows.bat* once. Until then: *Advanced options > Open engine folder*, double-click `start-helper.bat` and keep its window open. |
| *Starting audio engine* for a long time, then *Audio engine off* | The launcher could not bring it up. Usually a window asked to install Node.js or ffmpeg: answer it, then click the pill. Otherwise open `%LOCALAPPDATA%\LazyEditMirror\engine.log` for the reason. |
| *Audio engine off* right after Premiere asked for permission and you declined | Click the pill and allow it; the engine runs without a window and installs nothing by itself. |
| *ffmpeg missing* | The engine runs but cannot find ffmpeg. `winget install Gyan.FFmpeg` in a terminal, then click the pill (the engine is restarted). |
| *Could not launch it: ...* in Advanced options | The `lazyeditmirror:` link is not registered on this account. Run the installer again, or start the engine by hand from the engine folder. |
| Analyze seems stuck on *Listening to ...* | Big camera files take a while the first time. Later runs use the cache. |
| *The audio engine refused the request: file not found* | The media path Premiere reports does not exist on this computer (moved drive, network path). Relink the media. |

## Matching

| You see | Meaning and fix |
| --- | --- |
| *no match in this side file* for a front file you expected to match | The two files do not share enough sound (the side file does not cover that front file, less than ~25 s in common, or one of them is nearly silent). Use the side file that covers it, or sync that pair by hand with *Selected clips are in sync*. |
| *weak match, not used* | There is a candidate offset but the peak is not clearly above the noise. If you know the files overlap, sync them by hand (*Selected clips are in sync*) for that front file. |
| *The audio of X matched none of the front files* | Wrong side file (pick the one from the other camera), or the side recording has no usable audio. |
| *Side Camera footage "..." is a front file: it is cut on V1* | You picked a file that is on the Master track. Choose the side recording; front files are marked *(front, on V1)*. |
| *Side Camera footage "..." is reported offline by Premiere Pro* | That project item cannot be read (question-mark icon in the Project panel). Right-click it > Link Media, or delete the stale duplicate and pick the item that plays on the timeline. |

## Placing

| You see | Meaning and fix |
| --- | --- |
| *Nothing to place in this pass: N already on the Target track* | Those front clips already have side clips. If a whole side clip is lying on the Target track unselected, select it (it is consumed) and Analyze again. |
| *No empty audio track to park the side-camera audio on* | Add an audio track (right-click an audio track header > Add Track) and Analyze again. |
| *The Master track has transitions* | Remove them (the tool mirrors cuts only) and Analyze again. |
| *The reference side clip moved or was removed since the analysis* | The timeline changed between Analyze and Sync. Analyze again. |
| *Sync stopped ... Stopped after N undoable steps* | Premiere refused a step (locked track, offline media). Press Ctrl+Z N times, fix the cause, run the pass again. |
| *N audio clip(s) remain on the parking track* | Premiere did not remove the parked audio. Delete those clips by hand and send the log. |
| *Every clip landed X s away from the plan* | A systematic offset in placement; please send the log. |
| The side clips are placed but out of sync when you scrub | The match was wrong or the reference pair was not really in sync. Undo the pass (Ctrl+Z, see the step count), check the correlation in the result card, and use *Selected clips are in sync* for that file. A constant one-frame slip is corrected with the extra offset (0.04 s at 25 fps). |

## Reporting a problem

Send to lettertosohan@gmail.com:

1. The panel's log: *Save...* under *Log*, or the file named there.
2. `%LOCALAPPDATA%\LazyEditMirror\engine.log` if the problem is about
   matching or the engine.
3. Premiere Pro version (Help > About) and a screenshot of the timeline.
