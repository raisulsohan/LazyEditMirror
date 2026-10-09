/*
 * LazyEditMirror - the engine: Analyze Edit and Sync Edits.
 *
 * One run is one pass: it mirrors the Master clips that one side file can
 * cover and leaves the rest for the next pass with the next side file.
 * Clips already lying on the Target track are never touched.
 *
 * analyze() reads the sequence and returns a plan plus everything sync() needs.
 * sync() performs the edit one undoable step at a time and then reads the
 * Target track back to verify it. Both are written against the adapter
 * interface in premiere.js so they run unchanged against the mock in tests.
 *
 * Mapping modes (params.mode):
 *   "audio"      the audio helper (helper/sync-helper.mjs, via helper.js)
 *                listens to the side file and every front file on the
 *                Master track and measures their offsets; every front file
 *                it matches is mirrored in this pass. A selected clip of the
 *                side footage on another video track is consumed.
 *   "selection"  the side clip lies somewhere on the timeline (any video
 *                track but the Master) in sync with one Master clip; both are
 *                selected. The constant offset between that Master clip's
 *                front file and the side file is derived from the pair; the
 *                side clip is consumed (removed) by the sync.
 *   "timecode"   every file carries matching (jam-synced) source timecode.
 *   "offset"     the user enters the offset for one front file by hand.
 * In every mode the extra offset (params.offsetSeconds) is added on top.
 */
"use strict";

const MODES = { audio: "audio", selection: "selection", timecode: "timecode", offset: "offset" };

function createEngine(deps) {
  const adapter = deps.adapter;
  const plan = deps.plan;
  const log = deps.log || { info() {}, warn() {}, error() {}, step() {} };
  const audio = deps.audio || null;
  const onProgress = typeof deps.onProgress === "function" ? deps.onProgress : function () {};
  const SKIP = plan.SKIP;

  function describeClipError(label, desc) {
    if (!desc) return label + " is not a standard media clip (graphic, title or unknown item).";
    if (desc.isSequence) return label + " is a nested sequence.";
    if (desc.isMulticam) return label + " is a multicamera clip.";
    if (desc.isMerged) return label + " is a merged clip.";
    if (desc.isOffline) return label + " refers to offline media. Relink it first.";
    if (!desc.mediaPath) return label + " has no media file (synthetic or generated item).";
    return "";
  }

  function fail(lines) {
    throw new Error(lines.filter(Boolean).join("\n"));
  }

  function spanMatcher(frameTicks) {
    const tolerance = Math.max(1, Math.floor((frameTicks || plan.TICKS_PER_SECOND / 60) / 2));
    return (a, b) => Math.abs(a.start - b.start) <= tolerance && Math.abs(a.end - b.end) <= tolerance;
  }

  function fileBreakdown(byFile, key) {
    return Object.keys(byFile)
      .filter((name) => byFile[name][key] > 0)
      .map((name) => name + ": " + byFile[name][key])
      .join(", ");
  }

  function signed(ticks) {
    return (ticks >= 0 ? "+ " : "- ") + plan.formatSeconds(Math.abs(ticks));
  }

  /**
   * Skipped clips in the log: one line per front file for the expected
   * reasons (other file, already placed), one line per clip for the ones
   * worth a look (outside the side file, unsupported), capped at 20.
   */
  function logSkipped(mirror) {
    const perFile = {};
    const perClip = [];
    for (const s of mirror.skipped) {
      if (s.reason === SKIP.otherFile || s.reason === SKIP.already) {
        const name = s.clip.mediaName || s.clip.name || "?";
        if (!perFile[name]) perFile[name] = { otherFile: 0, already: 0 };
        perFile[name][s.reason] += 1;
      } else {
        perClip.push("Skipped (" + s.reason + "): " + s.detail);
      }
    }
    for (const name of Object.keys(perFile)) {
      const n = perFile[name];
      if (n.otherFile) log.info("Skipped " + n.otherFile + " clip(s) of " + name + ": no sync reference for this file in this pass.");
      if (n.already) log.info("Skipped " + n.already + " clip(s) of " + name + ": already on the Target track.");
    }
    plan.collapseMessages(perClip, 20).forEach((line) => log.info(line));
  }

  /**
   * The selected clip on a video track other than the Master (optionally of
   * one media file), with its track, or null. Also returns the raw selection.
   */
  async function findSelectedSideClip(ctx, master, videoTracks, mediaKeyFilter) {
    const sameSpan = spanMatcher(ctx.frameTicks);
    const selected = await adapter.readSelection(ctx.sequence);
    for (const track of videoTracks) {
      if (track.index === master.index) continue;
      const candidates = selected.filter((s) => s.trackIndex === track.index);
      if (!candidates.length) continue;
      const items = await adapter.readTrackItemsLight(track.track, true);
      for (const candidate of candidates) {
        const found = items.find((i) => sameSpan(i, candidate) && (!mediaKeyFilter || i.mediaKey === mediaKeyFilter));
        if (found) return { sidePick: Object.assign({ trackIndex: track.index, trackLabel: track.label }, found), selected: selected };
      }
    }
    return { sidePick: null, selected: selected };
  }

  /** Re-find a reference clip from an earlier analysis by its track and span. */
  async function locateReferenceBySpan(ctx, videoTracks, span, mediaKey) {
    const sameSpan = spanMatcher(ctx.frameTicks);
    const track = videoTracks.find((t) => t.index === span.trackIndex);
    const items = track ? await adapter.readTrackItemsLight(track.track, true) : [];
    const found = items.find((i) => sameSpan(i, span) && i.mediaKey === mediaKey);
    if (!found) fail(["The reference side clip moved or was removed since the analysis. Select it again and Analyze."]);
    return Object.assign({ trackIndex: track.index, trackLabel: track.label }, found);
  }

  function makeReference(sidePick, targetMedia) {
    return {
      videoItem: sidePick.item,
      trackIndex: sidePick.trackIndex,
      trackLabel: sidePick.trackLabel,
      start: sidePick.start,
      end: sidePick.end,
      inPoint: sidePick.inPoint,
      mediaKey: sidePick.mediaKey,
      mediaName: targetMedia.name,
      audioItems: [],
      audioTrackLabels: [],
    };
  }

  /** Selection mode: the side clip and the Master clip it is synced with. */
  async function resolveSelectionReference(ctx, master, videoTracks, masterClips, projectClips, resolved) {
    const sameSpan = spanMatcher(ctx.frameTicks);
    const how =
      "Put the side clip on a free video track, select it together with the Master clip it is in sync with " +
      "(select both, right-click > Synchronize > Audio), keep them selected, then Analyze.";

    if (resolved) {
      const sidePick = await locateReferenceBySpan(ctx, videoTracks, resolved.span, resolved.sideMediaKey);
      const targetMedia = projectClips.find((c) => c.mediaKey === resolved.sideMediaKey);
      if (!targetMedia) fail(["The side footage is no longer in the project."]);
      return { sidePick: sidePick, masterPick: null, targetMedia: targetMedia, shift: plan.secondsToTicks(resolved.baseShiftSeconds), frontMediaKey: resolved.frontMediaKey, auto: false };
    }

    const found = await findSelectedSideClip(ctx, master, videoTracks, null);
    if (!found.selected.length) fail(["Nothing is selected in the sequence.", how]);
    const sidePick = found.sidePick;
    if (!sidePick) fail(["No side clip is selected on a video track other than " + master.label + ".", how]);

    const targetMedia = projectClips.find((c) => c.mediaKey === sidePick.mediaKey);
    if (!targetMedia) fail(["The selected side clip is not a plain media clip (nested sequence, multicam or graphic?). Select the side recording."]);

    let auto = false;
    let masterPick = masterClips.find((clip) => found.selected.some((s) => s.trackIndex === master.index && sameSpan(s, clip)));
    if (!masterPick) {
      const tolerance = Math.max(1, Math.floor((ctx.frameTicks || plan.TICKS_PER_SECOND / 60) / 2));
      masterPick = masterClips.find((clip) => clip.end > sidePick.start + tolerance);
      auto = true;
      if (!masterPick) fail(["No Master clip lies under or after the side clip. Select the Master clip it is in sync with.", how]);
    }
    const masterProblem = describeClipError("The reference Master clip (" + masterPick.name + ")", masterPick.desc);
    if (masterProblem) fail([masterProblem, "Select a plain camera clip on " + master.label + " as the reference."]);
    if (targetMedia.mediaKey === masterPick.desc.mediaKey) {
      fail(["The selected side clip is the same file as the Master clip (" + targetMedia.name + "). Select the side recording."]);
    }

    return {
      sidePick: sidePick,
      masterPick: masterPick,
      targetMedia: targetMedia,
      shift: plan.deriveShiftFromSyncedPair(masterPick, sidePick),
      frontMediaKey: masterPick.desc.mediaKey,
      auto: auto,
    };
  }

  /** Audio mode: offsets of the side file against every front file, from the helper (or an earlier analysis). */
  async function resolveAudioMatches(targetMedia, fronts, resolvedMatches) {
    if (resolvedMatches) return resolvedMatches;
    if (!audio) fail(["Audio matching is not available in this build."]);
    const health = await audio.health();
    if (!health) fail([audio.START_HINT]);
    if (!health.ffmpeg) fail(["The audio engine cannot find ffmpeg. Install it (winget install Gyan.FFmpeg), then Analyze again; the engine picks it up on its next start."]);
    onProgress("Matching the audio of " + targetMedia.name + " against " + fronts.length + " front file(s)...");
    const results = await audio.match(targetMedia.mediaPath, fronts.map((f) => f.mediaPath), (message) => onProgress(message));
    return results.map((r) => Object.assign({ mediaKey: adapter.mediaKey(r.front) }, r));
  }

  /**
   * @param {object} params { masterIndex, targetIndex, targetClipId, mode, offsetSeconds, reference?, audioMatches?, frontMediaKey?, projectClips? }
   */
  async function analyze(params) {
    const ctx = await adapter.getContext();
    log.info('Sequence "' + ctx.sequenceName + '": ' + (ctx.fps ? ctx.fps.toFixed(3) + " fps, " : "") + ctx.frameTicks + " ticks/frame.");
    if (ctx.ticksPerSecond && ctx.ticksPerSecond !== plan.TICKS_PER_SECOND) {
      log.warn("Premiere reports " + ctx.ticksPerSecond + " ticks per second; the planner assumes " + plan.TICKS_PER_SECOND + ".");
    }
    if (!ctx.frameTicks) log.warn("Could not read the sequence frame rate; in-points will not be frame-aligned.");

    const videoTracks = await adapter.listTracks(ctx.sequence, "video");
    if (videoTracks.length < 2) fail(["The sequence needs at least two video tracks (Master and Target)."]);

    const masterIndex = Number(params.masterIndex);
    const targetIndex = Number(params.targetIndex);
    const master = videoTracks.find((t) => t.index === masterIndex);
    const target = videoTracks.find((t) => t.index === targetIndex);
    if (!master || !target) fail(["Choose a Master track and a Target track."]);
    if (masterIndex === targetIndex) fail(["Master and Target must be different tracks."]);

    const mode = MODES[params.mode] || MODES.audio;
    const offsetSeconds = Number(params.offsetSeconds == null || params.offsetSeconds === "" ? 0 : params.offsetSeconds);
    if (!Number.isFinite(offsetSeconds)) fail(["The extra offset must be a number of seconds (for example 0, 2.5 or -1.25)."]);
    const offsetTicks = plan.secondsToTicks(offsetSeconds);

    if (await adapter.hasTransitions(master.track)) {
      fail(["The Master track (" + master.label + ") has transitions. Remove them first; transitions are outside this MVP."]);
    }

    const masterClips = await adapter.readVideoClips(master.track);
    if (!masterClips.length) fail(["The Master track (" + master.label + ") has no video clips."]);
    const projectClips = params.projectClips || (await adapter.listProjectClips(ctx.project, log));

    const tc = (t) => plan.formatTimecode(t, ctx.frameTicks);
    const sec = plan.formatSeconds;
    const facts = [];
    let targetMedia = null;
    let reference = null;
    let frontMediaKey = "";
    let shiftFor = () => null;
    let skipDetailFor = (clip) => "Clip " + (clip.index + 1) + " (" + clip.name + ") is from " + clip.desc.name + ", which has no sync reference in this pass.";
    let resolvedReference = null;
    let resolvedAudio = null;

    /* The chosen side footage must be a usable file that is not one of the front files. */
    const checkTargetMedia = (media) => {
      const label = 'Side Camera footage "' + (media.binPath || "") + media.name + '"';
      if (media.isOffline) {
        fail([
          label + " is reported offline by Premiere Pro (its icon shows a question mark in the Project panel).",
          "If the file exists, right-click that item > Link Media; if it is a stale duplicate, delete it and pick the item that plays on the timeline. " +
            "Items marked (offline) in the list are the ones Premiere cannot read.",
        ]);
      }
      const problem = describeClipError(label, media);
      if (problem) fail([problem]);
      const onMaster = masterClips.find((c) => c.desc && c.desc.mediaKey === media.mediaKey);
      if (onMaster) {
        fail([
          label + " is a front file: it is cut on " + master.label + " (clip " + (masterClips.indexOf(onMaster) + 1) + ").",
          "Choose the side recording (the file from the other camera) as the Side Camera footage; front files are marked (front, on " + master.label + ") in the list.",
        ]);
      }
    };

    if (mode === MODES.audio) {
      targetMedia = projectClips.find((c) => c.id === params.targetClipId);
      if (!targetMedia) fail(["Choose the Side Camera footage (the project item of the side recording)."]);
      checkTargetMedia(targetMedia);
      const seen = {};
      const fronts = [];
      for (const clip of masterClips) {
        if (!clip.desc || !clip.desc.mediaPath || clip.desc.mediaKey === targetMedia.mediaKey || seen[clip.desc.mediaKey]) continue;
        seen[clip.desc.mediaKey] = true;
        fronts.push({ mediaKey: clip.desc.mediaKey, name: clip.desc.name, mediaPath: clip.desc.mediaPath });
      }
      if (!fronts.length) fail(["Every clip on " + master.label + " is " + targetMedia.name + " itself. Choose the side recording as the Side Camera footage."]);

      let sidePick = null;
      if (params.reference) sidePick = await locateReferenceBySpan(ctx, videoTracks, params.reference.span, params.reference.sideMediaKey);
      else sidePick = (await findSelectedSideClip(ctx, master, videoTracks, targetMedia.mediaKey)).sidePick;
      if (sidePick) {
        reference = makeReference(sidePick, targetMedia);
        resolvedReference = { span: { trackIndex: reference.trackIndex, start: reference.start, end: reference.end }, sideMediaKey: reference.mediaKey };
      }

      const matches = await resolveAudioMatches(targetMedia, fronts, params.audioMatches || null);
      resolvedAudio = matches;
      const byKey = {};
      for (const m of matches) byKey[m.mediaKey] = m;
      for (const front of fronts) {
        const m = byKey[front.mediaKey];
        const head = "Audio: " + targetMedia.name + " vs " + front.name + ": ";
        if (!m) facts.push(head + "not measured.");
        else if (m.status === "match") {
          facts.push(head + "side = front " + signed(plan.secondsToTicks(m.offsetSeconds)) + " (match; correlation " + Number(m.score).toFixed(2) + " over " + Number(m.overlapSeconds).toFixed(1) + " s).");
        } else if (m.status === "weak") {
          facts.push(head + "weak match only (correlation " + Number(m.score).toFixed(2) + ", offset " + signed(plan.secondsToTicks(m.offsetSeconds)) + ") - not used. If they really overlap, use \"Selected clips are in sync\".");
        } else if (m.status === "error") {
          facts.push(head + "could not read the audio (" + (m.error || "unknown error") + ").");
        } else {
          facts.push(head + "no match (correlation " + Number(m.score || 0).toFixed(2) + ").");
        }
      }
      shiftFor = (clip) => {
        const m = clip.desc ? byKey[clip.desc.mediaKey] : null;
        return m && m.status === "match" ? plan.secondsToTicks(m.offsetSeconds) : null;
      };
      skipDetailFor = (clip) => "Clip " + (clip.index + 1) + " (" + clip.name + ") is from " + clip.desc.name + ", which has no audio match with " + targetMedia.name + ".";
    } else if (mode === MODES.selection) {
      const ref = await resolveSelectionReference(ctx, master, videoTracks, masterClips, projectClips, params.reference || null);
      targetMedia = ref.targetMedia;
      frontMediaKey = ref.frontMediaKey;
      const frontClip = masterClips.find((c) => c.desc && c.desc.mediaKey === frontMediaKey);
      const frontName = frontClip ? frontClip.desc.name : "?";
      reference = makeReference(ref.sidePick, targetMedia);
      const baseShift = ref.shift;
      if (ref.masterPick) {
        facts.push(
          "Sync reference: Master clip " + (masterClips.indexOf(ref.masterPick) + 1) + ' ("' + ref.masterPick.name + '", file ' + frontName + ") at " +
            tc(ref.masterPick.start) + " (source " + tc(ref.masterPick.inPoint) + ")" + (ref.auto ? ", auto-picked under the side clip," : "") +
            " and side clip " + targetMedia.name + " on " + reference.trackLabel + " at " + tc(reference.start) + " (source " + tc(ref.sidePick.inPoint) +
            ") -> side = front " + signed(baseShift) + "."
        );
      } else {
        facts.push("Sync reference (read earlier): " + frontName + " -> " + targetMedia.name + ", side = front " + signed(baseShift) + ".");
      }
      shiftFor = (clip) => (clip.desc && clip.desc.mediaKey === frontMediaKey ? baseShift : null);
      skipDetailFor = (clip) => "Clip " + (clip.index + 1) + " (" + clip.name + ") is from " + clip.desc.name + ", which this side clip is not synced to.";
      resolvedReference = {
        span: { trackIndex: reference.trackIndex, start: reference.start, end: reference.end },
        sideMediaKey: reference.mediaKey,
        frontMediaKey: frontMediaKey,
        baseShiftSeconds: plan.ticksToSeconds(baseShift),
      };
    } else {
      targetMedia = projectClips.find((c) => c.id === params.targetClipId);
      if (!targetMedia) fail(["Choose the Side Camera footage (the project item of the side recording)."]);
      checkTargetMedia(targetMedia);
      if (mode === MODES.timecode) {
        facts.push("Mapping: source timecode of each front file vs " + targetMedia.name + " (starts " + tc(targetMedia.mediaStart) + ").");
        shiftFor = (clip) => (clip.desc && clip.desc.mediaKey !== targetMedia.mediaKey ? clip.desc.mediaStart - targetMedia.mediaStart : null);
      } else {
        frontMediaKey = params.frontMediaKey || "";
        if (!frontMediaKey) {
          const selected = await adapter.readSelection(ctx.sequence);
          const sameSpan = spanMatcher(ctx.frameTicks);
          const picked = masterClips.find((clip) => clip.desc && selected.some((s) => s.trackIndex === master.index && sameSpan(s, clip)));
          const first = masterClips.find((clip) => clip.desc);
          frontMediaKey = picked || first ? (picked || first).desc.mediaKey : "";
          if (!picked) log.info("No Master clip selected; the offset is applied to the first front file on " + master.label + ".");
        }
        const frontClip = masterClips.find((c) => c.desc && c.desc.mediaKey === frontMediaKey);
        facts.push("Mapping: offset only, front file " + (frontClip ? frontClip.desc.name : "?") + " -> " + targetMedia.name + ".");
        shiftFor = (clip) => (clip.desc && clip.desc.mediaKey === frontMediaKey ? 0 : null);
      }
    }
    if (mode === MODES.selection) checkTargetMedia(targetMedia);
    facts.push("Side footage " + targetMedia.name + ": " + sec(targetMedia.mediaDuration) + " long" + (offsetSeconds ? ", extra offset " + sec(offsetTicks) : "") + ".");
    facts.forEach((line) => log.info(line));

    /* Everything on the Target track except the reference clip is "already there". */
    const sameSpan = spanMatcher(ctx.frameTicks);
    const targetItems = await adapter.readTrackItemsLight(target.track, false);
    const occupied = targetItems.filter((i) => !(reference && reference.trackIndex === target.index && sameSpan(i, reference)));

    const planInput = masterClips.map((clip) => {
      const label = "Clip " + (clip.index + 1) + " (" + clip.name + ")";
      const problem = describeClipError(label, clip.desc);
      const shift = problem ? null : shiftFor(clip);
      let skip = null;
      if (problem) skip = { reason: SKIP.unsupported, detail: problem };
      else if (shift === null) skip = { reason: SKIP.otherFile, detail: skipDetailFor(clip) };
      return {
        index: clip.index,
        name: clip.name,
        mediaName: clip.desc ? clip.desc.name : clip.name,
        start: clip.start,
        end: clip.end,
        inPoint: clip.inPoint,
        outPoint: clip.outPoint,
        speed: clip.speed,
        reversed: clip.reversed,
        adjustmentLayer: clip.adjustmentLayer,
        shift: shift,
        skip: skip,
      };
    });

    const mirror = plan.buildMirrorPlan({
      masterClips: planInput,
      targetMediaDuration: targetMedia.mediaDuration,
      occupied: occupied,
      offset: offsetTicks,
      frameTicks: ctx.frameTicks,
    });
    mirror.warnings.forEach((w) => log.warn(w));
    logSkipped(mirror);
    if (mirror.errors.length) {
      mirror.errors.forEach((e) => log.error(e));
      let hint = "";
      if (mirror.counts.already && !mirror.counts.placed && mirror.counts.already + mirror.counts.unsupported === mirror.counts.total) {
        hint = "Those clips are done already. Use a side clip for a front file that still has gaps on " + target.label + ".";
      } else if (mode === MODES.audio && !mirror.counts.placed && !mirror.counts.outOfRange) {
        hint =
          "The audio of " + targetMedia.name + " matched none of the front files on " + master.label + ". If it really is the same take, the recording may be too " +
          "noisy or too short to match; sync it by hand with \"Selected clips are in sync\". If a whole side clip lies on " + target.label + " unselected, select it (it is consumed) and Analyze again.";
      } else if (mirror.counts.outOfRange && !mirror.counts.placed) {
        hint = mode === MODES.timecode
          ? "The timecodes put every clip outside the side file: the cameras were probably not jam-synced. Use \"Audio match\" or \"Selected clips are in sync\" instead."
          : "Every clip of that front file falls outside the side file; check that the sync reference is right.";
      } else if (mirror.counts.already && !mirror.counts.placed) {
        hint = "Those clips are done already. If a whole side clip lies on " + target.label + " unselected, select it (it is consumed) and Analyze again.";
      }
      fail(facts.concat(mirror.errors, [hint]));
    }

    /* Audio: an overwrite edit always brings the clip's audio along, so it is
       parked on an empty audio track and removed again right away. The
       reference clip's own audio does not count as occupying a track. */
    let parking = null;
    const audioTracks = await adapter.listTracks(ctx.sequence, "audio");
    if (reference) {
      for (const audioTrack of audioTracks) {
        const items = await adapter.readTrackItemsLight(audioTrack.track, true);
        const linked = items.filter((i) => sameSpan(i, reference) && i.mediaKey === reference.mediaKey);
        if (linked.length) {
          reference.audioItems.push(...linked.map((i) => i.item));
          reference.audioTrackLabels.push(audioTrack.label);
          audioTrack.clipCount -= linked.length;
        }
      }
    }
    if (targetMedia.hasAudio !== false) {
      const parkingIndex = plan.findEmptyTrackIndex(audioTracks);
      if (parkingIndex === -1) {
        fail([
          "No empty audio track to park the side-camera audio on. Add one (right-click an audio track header > Add Track, " +
            "or Sequence > Add Tracks) and analyze again. LazyEditMirror never writes onto an audio track that has clips.",
        ]);
      }
      parking = audioTracks[parkingIndex];
      if (targetMedia.hasAudio === null) log.warn("Could not tell whether the side-camera file has audio; parking on " + parking.label + " just in case.");
    }

    const counts = mirror.counts;
    const files = Object.keys(mirror.byFile);
    const summary = facts.slice();
    summary.push("Master " + master.label + ": " + counts.total + " clips from " + files.length + " file" + (files.length === 1 ? "" : "s") + ", " + mirror.cuts + " cuts, " + mirror.gaps + " gaps.");
    const first = mirror.placements[0];
    summary.push(
      "This pass: place " + counts.placed + " clip" + (counts.placed === 1 ? "" : "s") + " (" + fileBreakdown(mirror.byFile, "placed") + "), " +
        sec(mirror.totalDuration) + " of picture; first at timeline " + tc(first.timelineStart) + " <- side " + tc(first.targetIn) + "."
    );
    const skippedBits = [];
    if (counts.otherFile) skippedBits.push(counts.otherFile + " from front files without a match here (" + fileBreakdown(mirror.byFile, "remaining").replace(/, /g, "; ") + ") wait for their own side clip");
    if (counts.outOfRange) skippedBits.push(counts.outOfRange + " outside this side file");
    if (counts.already) skippedBits.push(counts.already + " already on " + target.label);
    if (counts.unsupported) skippedBits.push(counts.unsupported + " unsupported (see log)");
    if (skippedBits.length) summary.push("Skipped: " + skippedBits.join("; ") + ".");
    if (reference) {
      summary.push(
        "Reference clip " + reference.mediaName + " on " + reference.trackLabel +
          (reference.audioItems.length ? " (and its audio on " + reference.audioTrackLabels.join(", ") + ")" : "") + " will be removed."
      );
    }
    summary.push(parking ? "Side-camera audio: parked on " + parking.label + " and removed." : "Side-camera file has no audio.");
    const frontClipForFps = masterClips.find((c) => c.desc && (!frontMediaKey || c.desc.mediaKey === frontMediaKey));
    if (frontClipForFps && frontClipForFps.desc.fps && targetMedia.fps && Math.abs(frontClipForFps.desc.fps - targetMedia.fps) > 0.01) {
      summary.push("Warning: front " + frontClipForFps.desc.fps.toFixed(3) + " fps vs side " + targetMedia.fps.toFixed(3) + " fps; cuts may land up to a frame off.");
    }
    /* The facts are in the log already; add the rest of the summary. */
    summary.slice(facts.length).forEach((line) => (/^Warning/.test(line) ? log.warn(line) : log.info(line)));

    /* A structured version of the summary for the panel's result card. */
    const matchByKey = {};
    if (resolvedAudio) for (const m of resolvedAudio) matchByKey[m.mediaKey] = m;
    const seenFiles = {};
    const fileRows = [];
    for (const clip of masterClips) {
      if (!clip.desc || seenFiles[clip.desc.mediaKey]) continue;
      seenFiles[clip.desc.mediaKey] = true;
      const stats = mirror.byFile[clip.desc.name] || { total: 0, placed: 0, remaining: 0, already: 0, otherFile: 0, outOfRange: 0, unsupported: 0 };
      const row = { name: clip.desc.name, status: "other", offsetSeconds: null, score: null, overlapSeconds: null, note: "" };
      Object.assign(row, stats);
      if (clip.desc.mediaKey === targetMedia.mediaKey) {
        row.status = "side";
      } else if (mode === MODES.audio) {
        const m = matchByKey[clip.desc.mediaKey];
        row.status = m ? m.status : "none";
        if (m && m.status !== "error") {
          row.offsetSeconds = m.offsetSeconds;
          row.score = m.score;
          row.overlapSeconds = m.overlapSeconds;
        }
        if (m && m.status === "error") row.note = m.error || "";
      } else if (mode === MODES.timecode) {
        row.status = "match";
        row.offsetSeconds = plan.ticksToSeconds(clip.desc.mediaStart - targetMedia.mediaStart);
      } else {
        row.status = clip.desc.mediaKey === frontMediaKey ? "match" : "other";
        if (row.status === "match") row.offsetSeconds = plan.ticksToSeconds((mode === MODES.selection ? plan.secondsToTicks(resolvedReference.baseShiftSeconds) : 0));
      }
      if (stats.total && stats.already === stats.total) row.status = "done";
      fileRows.push(row);
    }
    const report = {
      mode: mode,
      side: { name: targetMedia.name, seconds: plan.ticksToSeconds(targetMedia.mediaDuration) },
      files: fileRows,
      totals: {
        clips: counts.total,
        files: files.length,
        cuts: mirror.cuts,
        gaps: mirror.gaps,
        placed: counts.placed,
        already: counts.already,
        remaining: counts.otherFile + counts.outOfRange + counts.unsupported,
        outOfRange: counts.outOfRange,
        unsupported: counts.unsupported,
        pictureSeconds: plan.ticksToSeconds(mirror.totalDuration),
        extraOffsetSeconds: offsetSeconds,
      },
      reference: reference ? { mediaName: reference.mediaName, trackLabel: reference.trackLabel, audioTrackLabels: reference.audioTrackLabels.slice() } : null,
      parking: parking ? parking.label : null,
      warnings: summary.filter((line) => /^Warning/.test(line)),
    };

    return {
      report: report,
      ctx: ctx,
      master: master,
      target: target,
      masterClips: masterClips,
      targetMedia: targetMedia,
      reference: reference,
      parking: parking,
      plan: mirror,
      summary: summary,
      /* Resolved so a later re-analysis (before Sync) does not depend on the selection or the helper any more. */
      params: {
        masterIndex: masterIndex,
        targetIndex: targetIndex,
        targetClipId: targetMedia.id,
        mode: mode,
        offsetSeconds: offsetSeconds,
        reference: resolvedReference,
        audioMatches: resolvedAudio,
        frontMediaKey: frontMediaKey || undefined,
      },
    };
  }

  /** Performs the pass. Each Premiere transaction is one Undo entry; the count is reported. */
  async function sync(analysis) {
    const ctx = analysis.ctx;
    const project = ctx.project;
    const editor = ctx.editor;
    const mirror = analysis.plan;
    const targetMedia = analysis.targetMedia;
    const V = adapter.constants.VIDEO;
    const A = adapter.constants.AUDIO;
    const tc = (t) => plan.formatTimecode(t, ctx.frameTicks);
    let steps = 0;

    try {
      const closed = await adapter.closeSourceMonitor();
      log.step(closed ? "Source Monitor cleared." : "Source Monitor could not be cleared (continuing).");

      if (analysis.reference) {
        adapter.removeItems(project, editor, [analysis.reference.videoItem], V, "LazyEditMirror: remove reference side clip");
        steps += 1;
        if (analysis.reference.audioItems.length) {
          adapter.removeItems(project, editor, analysis.reference.audioItems, A, "LazyEditMirror: remove reference side audio");
          steps += 1;
        }
        log.step("Removed the reference clip " + analysis.reference.mediaName + " from " + analysis.reference.trackLabel + ".");
      }

      for (let i = 0; i < mirror.placements.length; i += 1) {
        const clip = mirror.placements[i];
        const n = i + 1 + "/" + mirror.placements.length;
        onProgress("Placing clip " + n + "...", i, mirror.placements.length);

        adapter.setInOut(project, targetMedia.clipItem, clip.targetIn, clip.targetOut, "LazyEditMirror: mark side clip " + n);
        steps += 1;

        const audioIndex = analysis.parking ? analysis.parking.index : 0;
        adapter.overwrite(project, editor, targetMedia.projectItem, clip.timelineStart, analysis.target.index, audioIndex, "LazyEditMirror: place side clip " + n);
        steps += 1;

        let parkedNote = "";
        if (analysis.parking) {
          const parked = await adapter.readTrackItemsLight(analysis.parking.track, false);
          const hits = plan.itemsOverlapping(parked, clip.timelineStart, clip.timelineEnd, ctx.frameTicks);
          if (hits.length) {
            adapter.removeItems(project, editor, hits.map((h) => h.item), A, "LazyEditMirror: drop side audio " + n);
            steps += 1;
            parkedNote = ", audio dropped";
          } else {
            parkedNote = ", no audio landed";
          }
        }
        log.step("Clip " + n + " (master " + (clip.masterPosition + 1) + "): " + tc(clip.timelineStart) + "-" + tc(clip.timelineEnd) + " <- side " + tc(clip.targetIn) + parkedNote + ".");
      }

      adapter.clearInOut(project, targetMedia.clipItem, "LazyEditMirror: clear side footage marks");
      steps += 1;
      onProgress("Checking the result...", mirror.placements.length, mirror.placements.length);
    } catch (error) {
      const message = (error && error.message) || String(error);
      const wrapped = new Error(message + " (Stopped after " + steps + " undoable step" + (steps === 1 ? "" : "s") + "; press Ctrl+Z " + steps + " time" + (steps === 1 ? "" : "s") + " to revert.)");
      wrapped.steps = steps;
      throw wrapped;
    }

    const actual = await adapter.readTrackItemsLight(analysis.target.track, false);
    const verification = plan.verifyMirror(mirror, actual, ctx.frameTicks, { ignoreExtra: true });
    let leftoverAudio = 0;
    if (analysis.parking) {
      const parked = await adapter.readTrackItemsLight(analysis.parking.track, false);
      leftoverAudio = parked.length;
    }

    const report = [];
    if (verification.ok) {
      report.push("Verified: " + verification.matched.length + " clip(s) placed on " + analysis.target.label + ".");
    } else {
      if (verification.uniformDelta !== null) {
        report.push("Every clip landed " + plan.formatSeconds(verification.uniformDelta) + " away from the plan (systematic offset; please report this).");
      }
      if (verification.missing.length) report.push(verification.missing.length + " planned clip(s) not found where expected.");
      if (verification.mismatched.length) report.push(verification.mismatched.length + " clip(s) have a different end time than planned.");
    }
    if (leftoverAudio) report.push(leftoverAudio + " audio clip(s) remain on " + analysis.parking.label + "; delete them by hand.");

    const remaining = Object.keys(mirror.byFile).filter((name) => mirror.byFile[name].remaining > 0);
    const remainingTotal = remaining.reduce((n, name) => n + mirror.byFile[name].remaining, 0);
    report.push(
      remainingTotal
        ? "Still without a side clip: " + remainingTotal + " Master clip(s) (" + fileBreakdown(mirror.byFile, "remaining") + "). Run the next side file."
        : "Every Master clip now has a side clip on " + analysis.target.label + "."
    );
    report.forEach((line) => (verification.ok && !leftoverAudio ? log.info(line) : log.warn(line)));

    return {
      steps: steps,
      verification: verification,
      leftoverAudio: leftoverAudio,
      report: report,
      placed: mirror.placements.length,
      remaining: remainingTotal,
      remainingByFile: remaining.map((name) => ({ name: name, remaining: mirror.byFile[name].remaining })),
    };
  }

  return { analyze: analyze, sync: sync, MODES: MODES };
}

module.exports = { createEngine: createEngine, MODES: MODES };
