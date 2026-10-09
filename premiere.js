/*
 * LazyEditMirror - Premiere Pro adapter.
 *
 * The only file that talks to the `premierepro` UXP module. Everything it
 * returns is plain data (ticks as numbers, names as strings) plus the opaque
 * Premiere objects the sync step needs to hand back (track items, project
 * items). The module is injected, so tools/test-sync.mjs can run the same
 * code against tools/mock-premiere.mjs.
 *
 * Every call below is listed in Adobe's @adobe/premierepro 26.5.0 type
 * declarations; see docs/api-research.md for the mapping and the caveats.
 */
"use strict";

function createAdapter(ppro) {
  const Constants = ppro.Constants;
  const CLIP = Constants.TrackItemType.CLIP;
  const TRANSITION = Constants.TrackItemType.TRANSITION;
  const VIDEO = Constants.MediaType.VIDEO;
  const AUDIO = Constants.MediaType.AUDIO;
  const MEDIA = Constants.ContentType.MEDIA;

  /** TickTime -> integer ticks. */
  function ticksOf(tickTime) {
    if (!tickTime) return 0;
    if (typeof tickTime.ticksNumber === "number") return tickTime.ticksNumber;
    if (typeof tickTime.ticks === "string") return Number(tickTime.ticks);
    if (typeof tickTime.seconds === "number") return Math.round(tickTime.seconds * 254016000000);
    return 0;
  }

  /** integer ticks -> TickTime. Ticks are passed as a string, as the API requires. */
  function tick(ticks) {
    return ppro.TickTime.createWithTicks(String(Math.round(ticks)));
  }

  /** Run an async getter, returning `fallback` instead of throwing. */
  async function safe(fn, fallback) {
    try {
      return await fn();
    } catch (e) {
      return fallback;
    }
  }

  function mediaKey(path) {
    return String(path || "").replace(/\\/g, "/").toLowerCase();
  }

  async function getContext() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("No Premiere Pro project is open.");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("Open the sequence you want to mirror (double-click it) and try again.");

    let frameTicks = 0;
    let fps = 0;
    try {
      const settings = await sequence.getSettings();
      const frameRate = settings.getVideoFrameRate();
      frameTicks = Number(frameRate.ticksPerFrame) || 0;
      fps = Number(frameRate.value) || 0;
    } catch (e) {
      /* getVideoFrameRate() exists since 26.2; fall back to the sequence timebase (ticks per frame). */
    }
    if (!frameTicks) {
      const timebase = await safe(() => sequence.getTimebase(), "");
      frameTicks = Number(timebase) || 0;
    }

    const ticksPerSecond = ticksOf(ppro.TickTime.createWithSeconds(1));
    if (!fps && frameTicks) fps = ticksPerSecond / frameTicks;

    const editor = ppro.SequenceEditor.getEditor(sequence);
    const zeroPoint = ticksOf(await safe(() => sequence.getZeroPoint(), null));

    return {
      project: project,
      sequence: sequence,
      editor: editor,
      sequenceName: sequence.name || "",
      frameTicks: frameTicks,
      fps: fps,
      ticksPerSecond: ticksPerSecond,
      zeroPoint: zeroPoint,
    };
  }

  /** [{ index, name, clipCount, track }] for "video" or "audio" tracks. */
  async function listTracks(sequence, kind) {
    const isVideo = kind === "video";
    const count = isVideo ? await sequence.getVideoTrackCount() : await sequence.getAudioTrackCount();
    const tracks = [];
    for (let index = 0; index < count; index += 1) {
      const track = isVideo ? await sequence.getVideoTrack(index) : await sequence.getAudioTrack(index);
      const items = (await track.getTrackItems(CLIP, false)) || [];
      const fallback = (isVideo ? "V" : "A") + (index + 1);
      tracks.push({
        index: index,
        name: track.name || fallback,
        label: fallback + (track.name && track.name !== fallback ? " - " + track.name : ""),
        clipCount: items.length,
        track: track,
      });
    }
    return tracks;
  }

  async function hasTransitions(track) {
    const transitions = await safe(() => track.getTrackItems(TRANSITION, false), []);
    return !!(transitions && transitions.length);
  }

  /**
   * Describe a project item as camera footage: null when it is not a clip.
   * mediaStart/mediaDuration are ticks; hasAudio is true/false, or null when
   * Premiere could not tell us (the sync then plays safe and parks audio).
   */
  async function describeClipItem(projectItem) {
    const clipItem = ppro.ClipProjectItem.cast(projectItem);
    if (!clipItem) return null;

    const isSequence = await safe(() => clipItem.isSequence(), false);
    const isMulticam = await safe(() => clipItem.isMulticamClip(), false);
    const isMerged = await safe(() => clipItem.isMergedClip(), false);
    const isOffline = await safe(() => clipItem.isOffline(), false);
    const contentType = await safe(() => clipItem.getContentType(), null);
    const mediaPath = isSequence ? "" : await safe(() => clipItem.getMediaFilePath(), "");

    let mediaStart = 0;
    let mediaDuration = 0;
    let mediaStartKnown = false;
    if (!isSequence) {
      const media = await safe(() => clipItem.getMedia(), null);
      if (media) {
        const start = await safe(() => media.getStart(), null);
        if (start) {
          mediaStart = ticksOf(start);
          mediaStartKnown = true;
        }
        mediaDuration = ticksOf(await safe(() => media.getDuration(), null));
      }
    }

    let fps = 0;
    const interpretation = await safe(() => clipItem.getFootageInterpretation(), null);
    if (interpretation) fps = Number(await safe(() => interpretation.getFrameRate(), 0)) || 0;

    let hasAudio = null;
    try {
      const chain = await clipItem.getComponentChain(AUDIO);
      hasAudio = !!chain;
    } catch (e) {
      hasAudio = null;
    }

    let id = "";
    try {
      id = String(projectItem.getId());
    } catch (e) {
      id = "";
    }

    return {
      id: id || projectItem.name + "|" + mediaPath,
      name: projectItem.name || clipItem.name || "(unnamed)",
      projectItem: projectItem,
      clipItem: clipItem,
      isSequence: isSequence,
      isMulticam: isMulticam,
      isMerged: isMerged,
      isOffline: isOffline,
      isMedia: contentType === null ? !isSequence : contentType === MEDIA,
      mediaPath: mediaPath,
      mediaKey: mediaKey(mediaPath),
      mediaStart: mediaStart,
      mediaStartKnown: mediaStartKnown,
      mediaDuration: mediaDuration,
      fps: fps,
      hasAudio: hasAudio,
    };
  }

  /** Clips on a video track with everything the planner needs. Sorted by start. */
  async function readVideoClips(track) {
    const items = (await track.getTrackItems(CLIP, false)) || [];
    const clips = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const values = await Promise.all([
        item.getStartTime(),
        item.getEndTime(),
        item.getInPoint(),
        item.getOutPoint(),
        safe(() => item.getSpeed(), 1),
        safe(() => item.isSpeedReversed(), 0),
        safe(() => item.isAdjustmentLayer(), false),
        safe(() => item.getName(), ""),
      ]);
      const projectItem = await safe(() => item.getProjectItem(), null);
      const desc = projectItem ? await describeClipItem(projectItem) : null;
      clips.push({
        item: item,
        index: index,
        name: values[7] || (desc && desc.name) || "clip " + (index + 1),
        start: ticksOf(values[0]),
        end: ticksOf(values[1]),
        inPoint: ticksOf(values[2]),
        outPoint: ticksOf(values[3]),
        speed: Number(values[4]) || 1,
        reversed: !!values[5],
        adjustmentLayer: !!values[6],
        projectItem: projectItem,
        desc: desc,
      });
    }
    clips.sort((a, b) => a.start - b.start);
    return clips;
  }

  /**
   * Clips on any track: position, name and (when withMedia) in-point and media
   * file. Used for the Target track, the audio tracks and the reference clip.
   */
  async function readTrackItemsLight(track, withMedia) {
    const items = (await track.getTrackItems(CLIP, false)) || [];
    const out = [];
    for (const item of items) {
      const values = await Promise.all([item.getStartTime(), item.getEndTime(), safe(() => item.getName(), ""), item.getInPoint()]);
      const entry = { item: item, start: ticksOf(values[0]), end: ticksOf(values[1]), name: values[2] || "", inPoint: ticksOf(values[3]), mediaKey: "" };
      if (withMedia) {
        const projectItem = await safe(() => item.getProjectItem(), null);
        const clipItem = projectItem ? ppro.ClipProjectItem.cast(projectItem) : null;
        if (clipItem) entry.mediaKey = mediaKey(await safe(() => clipItem.getMediaFilePath(), ""));
      }
      out.push(entry);
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  /**
   * The clips currently selected in the sequence (video and audio items):
   * [{ item, trackIndex, start, end, inPoint, mediaKey, name }].
   */
  async function readSelection(sequence) {
    const selection = await sequence.getSelection();
    if (!selection) return [];
    const items = (await selection.getTrackItems()) || [];
    const out = [];
    for (const item of items) {
      const values = await Promise.all([
        item.getStartTime(),
        item.getEndTime(),
        item.getInPoint(),
        safe(() => item.getTrackIndex(), -1),
        safe(() => item.getName(), ""),
      ]);
      let mediaPath = "";
      const projectItem = await safe(() => item.getProjectItem(), null);
      if (projectItem) {
        const clipItem = ppro.ClipProjectItem.cast(projectItem);
        if (clipItem) mediaPath = await safe(() => clipItem.getMediaFilePath(), "");
      }
      out.push({
        item: item,
        trackIndex: Number(values[3]),
        start: ticksOf(values[0]),
        end: ticksOf(values[1]),
        inPoint: ticksOf(values[2]),
        mediaKey: mediaKey(mediaPath),
        name: values[4] || "",
      });
    }
    return out;
  }

  /** Project-item id of the first clip on a track, or "". */
  async function firstProjectItemId(track) {
    const items = (await track.getTrackItems(CLIP, false)) || [];
    if (!items.length) return "";
    const projectItem = await safe(() => items[0].getProjectItem(), null);
    if (!projectItem) return "";
    try {
      return String(projectItem.getId());
    } catch (e) {
      return "";
    }
  }

  /** Every media clip in the project, walking all bins. */
  async function listProjectClips(project, log) {
    const root = await project.getRootItem();
    const clips = [];
    const TYPE_BIN = ppro.ProjectItem.TYPE_BIN;
    const TYPE_CLIP = ppro.ProjectItem.TYPE_CLIP;

    async function walk(folder, path, depth) {
      if (depth > 32) return;
      let items;
      try {
        items = (await folder.getItems()) || [];
      } catch (e) {
        if (log) log.warn("Could not list bin " + (path || "/") + ": " + (e && e.message ? e.message : e));
        return;
      }
      for (const item of items) {
        try {
          const isBin = typeof TYPE_BIN === "number" ? item.type === TYPE_BIN : false;
          if (isBin) {
            const child = ppro.FolderItem.cast(item);
            if (child) await walk(child, path + item.name + "/", depth + 1);
            continue;
          }
          if (typeof TYPE_CLIP === "number" && item.type !== TYPE_CLIP) continue;
          const desc = await describeClipItem(item);
          if (!desc || desc.isSequence || desc.isMulticam || desc.isMerged || !desc.isMedia) continue;
          desc.binPath = path;
          clips.push(desc);
        } catch (e) {
          if (log) log.warn("Skipped project item " + (item && item.name) + ": " + (e && e.message ? e.message : e));
        }
      }
    }

    await walk(root, "", 0);
    clips.sort((a, b) => (a.binPath + a.name).localeCompare(b.binPath + b.name));
    return clips;
  }

  /**
   * One undoable transaction. `fill(compoundAction)` adds the action(s).
   * Throws when Premiere refuses the transaction.
   */
  function transaction(project, label, fill) {
    let committed = false;
    let failure = null;
    project.lockedAccess(() => {
      try {
        committed = project.executeTransaction((compoundAction) => {
          fill(compoundAction);
        }, label);
      } catch (e) {
        failure = e;
      }
    });
    if (failure) throw failure;
    if (!committed) throw new Error('Premiere Pro did not commit "' + label + '".');
  }

  /**
   * Remove track items (no ripple). The selection only exists inside
   * createEmptySelection's callback, so the transaction runs in there too.
   */
  function removeItems(project, editor, items, mediaType, label) {
    if (!items.length) return;
    let committed = false;
    let failure = null;
    project.lockedAccess(() => {
      ppro.TrackItemSelection.createEmptySelection((selection) => {
        for (const item of items) selection.addItem(item, true);
        try {
          committed = project.executeTransaction((compoundAction) => {
            compoundAction.addAction(editor.createRemoveItemsAction(selection, false, mediaType, false));
          }, label);
        } catch (e) {
          failure = e;
        }
      });
    });
    if (failure) throw failure;
    if (!committed) throw new Error('Premiere Pro did not commit "' + label + '".');
  }

  /** Mark the source range on the project item (relative to its first frame). */
  function setInOut(project, clipItem, inTicks, outTicks, label) {
    transaction(project, label, (compoundAction) => {
      compoundAction.addAction(clipItem.createSetInOutPointsAction(tick(inTicks), tick(outTicks)));
    });
  }

  /** Overwrite-edit the project item's marked range onto the timeline. */
  function overwrite(project, editor, projectItem, timelineStart, videoTrackIndex, audioTrackIndex, label) {
    transaction(project, label, (compoundAction) => {
      compoundAction.addAction(editor.createOverwriteItemAction(projectItem, tick(timelineStart), videoTrackIndex, audioTrackIndex));
    });
  }

  function clearInOut(project, clipItem, label) {
    transaction(project, label, (compoundAction) => {
      compoundAction.addAction(clipItem.createClearInOutPointsAction());
    });
  }

  /** Workaround for a reported 26.3.2 crash when the Source Monitor shows the clip being re-marked. */
  async function closeSourceMonitor() {
    try {
      await ppro.SourceMonitor.closeAllClips();
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    constants: { VIDEO: VIDEO, AUDIO: AUDIO },
    ticksOf: ticksOf,
    tick: tick,
    mediaKey: mediaKey,
    getContext: getContext,
    listTracks: listTracks,
    hasTransitions: hasTransitions,
    describeClipItem: describeClipItem,
    readVideoClips: readVideoClips,
    readTrackItemsLight: readTrackItemsLight,
    readSelection: readSelection,
    firstProjectItemId: firstProjectItemId,
    listProjectClips: listProjectClips,
    transaction: transaction,
    removeItems: removeItems,
    setInOut: setInOut,
    overwrite: overwrite,
    clearInOut: clearInOut,
    closeSourceMonitor: closeSourceMonitor,
  };
}

module.exports = { createAdapter: createAdapter };
