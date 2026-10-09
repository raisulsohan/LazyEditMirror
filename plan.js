/*
 * LazyEditMirror - mirror plan (pure logic, no Premiere Pro access).
 *
 * Everything here works on plain numbers: times are Premiere "ticks"
 * (254,016,000,000 per second), which is the unit Premiere itself stores, so
 * the arithmetic is exact and frame alignment is a plain multiply/round.
 *
 * The module is CommonJS so the same file runs inside the UXP panel
 * (require("./plan.js")) and under Node for tools/test-plan.mjs.
 */
"use strict";

/** Premiere Pro tick rate. premiere.js re-derives it at runtime as a cross-check. */
const TICKS_PER_SECOND = 254016000000;

/** Why a Master clip is not placed in this pass. */
const SKIP = {
  otherFile: "otherFile", // from a front file the sync reference does not cover
  outOfRange: "outOfRange", // maps outside the side file
  already: "already", // the Target track already has a clip there
  unsupported: "unsupported", // speed change, adjustment layer, nested sequence, ...
};

/** Round `ticks` to the nearest whole frame of `frameTicks` ticks. */
function alignTicks(ticks, frameTicks) {
  if (!frameTicks || frameTicks <= 0) return Math.round(ticks);
  return Math.round(ticks / frameTicks) * frameTicks;
}

function secondsToTicks(seconds) {
  return Math.round(seconds * TICKS_PER_SECOND);
}

function ticksToSeconds(ticks) {
  return ticks / TICKS_PER_SECOND;
}

/** "12.345 s", keeping the sign. */
function formatSeconds(ticks) {
  const s = ticksToSeconds(ticks);
  return (s < 0 ? "-" : "") + Math.abs(s).toFixed(3) + " s";
}

/** Non-drop-frame "HH:MM:SS:FF" for the given frame duration (ticks per frame). */
function formatTimecode(ticks, frameTicks) {
  if (!frameTicks || frameTicks <= 0) return formatSeconds(ticks);
  const sign = ticks < 0 ? "-" : "";
  const totalFrames = Math.round(Math.abs(ticks) / frameTicks);
  const fps = Math.max(1, Math.round(TICKS_PER_SECOND / frameTicks));
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return sign + pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ":" + pad(frames);
}

function halfFrame(frameTicks) {
  return Math.max(1, Math.floor((frameTicks || TICKS_PER_SECOND / 60) / 2));
}

/** Items on a track whose range overlaps [start, end), ignoring half-frame touches. */
function itemsOverlapping(items, start, end, frameTicks) {
  const tolerance = halfFrame(frameTicks);
  return items.filter((item) => item.end > start + tolerance && item.start < end - tolerance);
}

/**
 * Build the mirror plan for one pass.
 *
 * @param {object} input
 * @param {Array} input.masterClips  every clip on the Master track, in any order:
 *   { index, name, mediaName, start, end, inPoint, outPoint, speed, reversed, adjustmentLayer,
 *     shift: number|null, skip: { reason, detail }|null }
 *   start/end are sequence times; inPoint/outPoint are source times relative to
 *   the first frame of the clip's own media file; `shift` is the offset that
 *   turns this clip's source time into side-file time (null = not mappable in
 *   this pass, with `skip` saying why). All in ticks.
 * @param {number} input.targetMediaDuration side-file duration (ticks)
 * @param {Array}  input.occupied   ranges already filled on the Target track: [{ start, end }]
 * @param {number} input.offset     extra shift added to every clip (ticks, +/-)
 * @param {number} input.frameTicks ticks per frame of the sequence
 */
function buildMirrorPlan(input) {
  const masterClips = (input.masterClips || []).slice().sort((a, b) => a.start - b.start);
  const targetMediaDuration = input.targetMediaDuration;
  const occupied = input.occupied || [];
  const offset = input.offset || 0;
  const frameTicks = input.frameTicks || 0;
  const tolerance = halfFrame(frameTicks);

  const errors = [];
  const warnings = [];
  const placements = [];
  const skipped = [];
  const counts = { total: masterClips.length, placed: 0, otherFile: 0, outOfRange: 0, already: 0, unsupported: 0 };
  const byFile = {};
  let cuts = 0;
  let gaps = 0;

  if (!masterClips.length) errors.push("The Master track has no video clips to mirror.");

  for (let i = 0; i < masterClips.length; i += 1) {
    const clip = masterClips[i];
    const label = clip.name ? "Clip " + (i + 1) + " (" + clip.name + ")" : "Clip " + (i + 1);
    const previous = masterClips[i - 1];
    const fileName = clip.mediaName || clip.name || "?";
    if (!byFile[fileName]) byFile[fileName] = { total: 0, placed: 0, remaining: 0, already: 0, otherFile: 0, outOfRange: 0, unsupported: 0 };
    const file = byFile[fileName];
    file.total += 1;

    if (previous) {
      const spacing = clip.start - previous.end;
      if (spacing < -tolerance) {
        errors.push(label + " overlaps the clip before it on the Master track. Overlapping clips are not supported.");
      } else if (spacing > tolerance) {
        gaps += 1;
      } else {
        cuts += 1;
      }
    }

    const skip = (reason, detail) => {
      skipped.push({ clip: clip, index: i, reason: reason, detail: detail });
      counts[reason] += 1;
      file[reason] += 1;
      if (reason !== SKIP.already) file.remaining += 1;
    };

    const speed = clip.speed == null ? 1 : clip.speed;
    const duration = clip.end - clip.start;
    /* Done in an earlier pass? Then nothing else about the clip matters. */
    if (itemsOverlapping(occupied, clip.start, clip.end, frameTicks).length) {
      skip(SKIP.already, label + " already has a clip on the Target track.");
      continue;
    }
    if (clip.skip && clip.skip.reason) {
      skip(clip.skip.reason, clip.skip.detail || "");
      continue;
    }
    if (clip.reversed || Math.abs(speed - 1) > 1e-6) {
      skip(SKIP.unsupported, label + " is reversed or not at 100% speed.");
      continue;
    }
    if (clip.adjustmentLayer) {
      skip(SKIP.unsupported, label + " is an adjustment layer.");
      continue;
    }
    if (duration <= 0) {
      skip(SKIP.unsupported, label + " has no duration on the timeline.");
      continue;
    }
    if (typeof clip.shift !== "number" || !Number.isFinite(clip.shift)) {
      skip(SKIP.otherFile, label + " has no sync reference in this pass.");
      continue;
    }

    const sourceDuration = clip.outPoint - clip.inPoint;
    if (Math.abs(duration - sourceDuration) > tolerance) {
      warnings.push(
        label + ": timeline duration (" + formatSeconds(duration) + ") differs from its source range (" +
          formatSeconds(sourceDuration) + "). The timeline duration is used."
      );
    }

    const rawIn = clip.inPoint + clip.shift + offset;
    const targetIn = alignTicks(rawIn, frameTicks);
    const targetOut = targetIn + duration;

    if (targetIn < 0) {
      skip(SKIP.outOfRange, label + " maps to " + formatSeconds(targetIn) + ", before the side file starts.");
      continue;
    }
    if (typeof targetMediaDuration === "number" && targetMediaDuration > 0 && targetOut > targetMediaDuration + tolerance) {
      skip(SKIP.outOfRange, label + " maps to " + formatSeconds(targetOut) + ", past the end of the side file (" + formatSeconds(targetMediaDuration) + ").");
      continue;
    }

    placements.push({
      index: placements.length,
      masterIndex: clip.index,
      masterPosition: i,
      name: clip.name || "",
      mediaName: fileName,
      timelineStart: clip.start,
      timelineEnd: clip.end,
      duration: duration,
      masterIn: clip.inPoint,
      masterOut: clip.outPoint,
      targetIn: targetIn,
      targetOut: targetOut,
      alignedBy: targetIn - rawIn,
    });
    counts.placed += 1;
    file.placed += 1;
  }

  if (!errors.length && masterClips.length && !placements.length) {
    const why = [];
    if (counts.already) why.push(counts.already + " already on the Target track");
    if (counts.outOfRange) why.push(counts.outOfRange + " outside the side file");
    if (counts.otherFile) why.push(counts.otherFile + " from other front files");
    if (counts.unsupported) why.push(counts.unsupported + " unsupported");
    errors.push("Nothing to place in this pass: " + (why.join(", ") || "no Master clip could be mapped") + ".");
  }

  const totalDuration = placements.reduce((sum, c) => sum + c.duration, 0);

  return {
    placements: placements,
    skipped: skipped,
    counts: counts,
    byFile: byFile,
    cuts: cuts,
    gaps: gaps,
    offset: offset,
    errors: errors,
    warnings: warnings,
    firstStart: placements.length ? placements[0].timelineStart : 0,
    lastEnd: placements.length ? placements[placements.length - 1].timelineEnd : 0,
    totalDuration: totalDuration,
    tolerance: tolerance,
  };
}

/**
 * The constant offset between two recordings, from one Master clip and one
 * side clip that lie in sync on the timeline: at any timeline time t the
 * side source time is sideIn + (t - sideStart) and the front source time is
 * masterIn + (t - masterStart), so side = front + k with
 *   k = (sideIn - sideStart) - (masterIn - masterStart).
 * All values in ticks.
 */
function deriveShiftFromSyncedPair(masterClip, sideClip) {
  return sideClip.inPoint - sideClip.start - (masterClip.inPoint - masterClip.start);
}

/** First `keep` messages plus a one-line count of the rest. */
function collapseMessages(messages, keep) {
  if (messages.length <= keep + 1) return messages.slice();
  const shown = messages.slice(0, keep);
  shown.push("... and " + (messages.length - keep) + " more (full list in the log).");
  return shown;
}

/**
 * Compare the clips found on the Target track after a sync with the plan's
 * placements. `actual` entries: { start, end, name } in ticks. Clips the plan
 * did not place (earlier passes) are reported as `extra` only when
 * options.ignoreExtra is false.
 */
function verifyMirror(plan, actual, frameTicks, options) {
  const ignoreExtra = !!(options && options.ignoreExtra);
  const tolerance = halfFrame(frameTicks);
  const remaining = actual.slice();
  const matched = [];
  const missing = [];
  const mismatched = [];

  for (const clip of plan.placements) {
    const at = remaining.findIndex((a) => Math.abs(a.start - clip.timelineStart) <= tolerance);
    if (at === -1) {
      missing.push(clip);
      continue;
    }
    const found = remaining.splice(at, 1)[0];
    if (Math.abs(found.end - clip.timelineEnd) > tolerance) {
      mismatched.push({ clip: clip, found: found });
    } else {
      matched.push({ clip: clip, found: found });
    }
  }

  /* If every clip landed the same distance away, that is one systematic offset
     (for example the sequence start timecode), worth naming in the report. */
  let uniformDelta = null;
  if (missing.length && missing.length === plan.placements.length && actual.length >= plan.placements.length) {
    const first = plan.placements[0];
    const candidates = actual.map((a) => a.start - first.timelineStart);
    for (const delta of candidates) {
      if (Math.abs(delta) <= tolerance) continue;
      const everyone = plan.placements.every((c) => actual.some((a) => Math.abs(a.start - (c.timelineStart + delta)) <= tolerance));
      if (everyone) {
        uniformDelta = delta;
        break;
      }
    }
  }

  const extra = ignoreExtra ? [] : remaining;
  return {
    ok: missing.length === 0 && mismatched.length === 0 && extra.length === 0,
    matched: matched,
    missing: missing,
    mismatched: mismatched,
    extra: extra,
    uniformDelta: uniformDelta,
  };
}

/** Index of the first track with no clips, or -1. `tracks`: [{ index, clipCount }]. */
function findEmptyTrackIndex(tracks) {
  const empty = tracks.find((t) => t.clipCount === 0);
  return empty ? empty.index : -1;
}

module.exports = {
  TICKS_PER_SECOND: TICKS_PER_SECOND,
  SKIP: SKIP,
  alignTicks: alignTicks,
  secondsToTicks: secondsToTicks,
  ticksToSeconds: ticksToSeconds,
  formatSeconds: formatSeconds,
  formatTimecode: formatTimecode,
  buildMirrorPlan: buildMirrorPlan,
  deriveShiftFromSyncedPair: deriveShiftFromSyncedPair,
  collapseMessages: collapseMessages,
  verifyMirror: verifyMirror,
  findEmptyTrackIndex: findEmptyTrackIndex,
  itemsOverlapping: itemsOverlapping,
};
