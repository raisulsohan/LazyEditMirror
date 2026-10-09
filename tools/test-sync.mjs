/*
 * End-to-end tests of premiere.js + sync.js against the mock Premiere.
 * Run: node tools/test-sync.mjs
 *
 * These prove the control flow (what is read, which actions run in which
 * order, what is verified) against a model of the API. Adobe's real behaviour
 * still has to be confirmed in Premiere Pro; see docs/testing.md.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createScenario, sec, TICKS_PER_SECOND } from "./mock-premiere.mjs";

const require = createRequire(import.meta.url);
const plan = require("../plan.js");
const { createAdapter } = require("../premiere.js");
const { createEngine } = require("../sync.js");

const FRAME = TICKS_PER_SECOND / 25;
const S = (ticks) => ticks / TICKS_PER_SECOND;

function makeLog() {
  const lines = [];
  const push = (level) => (m) => lines.push(level + m);
  return { lines, info: push(""), warn: push("WARN "), error: push("ERROR "), step: push("-> ") };
}

function engineFor(scenario, audio) {
  const log = makeLog();
  const adapter = createAdapter(scenario.ppro);
  const progress = [];
  const engine = createEngine({ adapter, plan, log, audio: audio || null, onProgress: (m) => progress.push(m) });
  return { engine, adapter, log, progress };
}

/** A stand-in for helper.js: `offsets` maps a front file name to the offset it "hears". */
function fakeAudio(offsets, options) {
  const calls = [];
  const opts = options || {};
  const client = {
    START_HINT: "The audio engine is not running. Open Advanced options and run start-helper.bat.",
    health: async () => (opts.down ? null : { ok: true, version: "test", ffmpeg: opts.noFfmpeg ? null : "ffmpeg test" }),
    match: async (side, fronts, onProgress) => {
      calls.push({ side, fronts });
      if (onProgress) onProgress("Reading the audio of " + side + "...");
      return fronts.map((front) => {
        const name = front.split("/").pop();
        if (Object.prototype.hasOwnProperty.call(offsets, name)) {
          const value = offsets[name];
          if (typeof value === "object") return Object.assign({ front }, value);
          return { front, status: "match", offsetSeconds: value, score: 0.62, z: 55, prominence: 6, overlapSeconds: 180, frontSeconds: 600, sideSeconds: 590 };
        }
        return { front, status: "none", offsetSeconds: 0, score: 0.04, z: 9, prominence: 1.1, overlapSeconds: 100, frontSeconds: 600, sideSeconds: 590 };
      });
    },
  };
  return { client, calls };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ok  " + name);
  } catch (error) {
    console.error("FAIL  " + name);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

const params = (scenario, extra) => Object.assign({ masterIndex: 0, targetIndex: 1, targetClipId: scenario.side.id, offsetSeconds: 0, mode: "selection" }, extra || {});

/** Put `item` (whole) on `track` so that its source time `inAtStart` lies at timeline `start`, and select it with `masterClip`. */
function placeReference(scenario, track, item, start, inAtStart, length, masterClip) {
  const clip = track.add({ start: sec(start), end: sec(start + length), inPoint: sec(inAtStart), outPoint: sec(inAtStart + length), projectItem: item });
  scenario.sequence.selectedItems = masterClip ? [masterClip, clip] : [clip];
  return clip;
}

await test("adapter reads tracks, clips, project items and the selection", async () => {
  const scenario = createScenario();
  const { adapter, log } = engineFor(scenario);
  const ctx = await adapter.getContext();
  assert.equal(ctx.frameTicks, FRAME);
  assert.equal(ctx.fps, 25);
  assert.equal(ctx.ticksPerSecond, plan.TICKS_PER_SECOND);

  const tracks = await adapter.listTracks(ctx.sequence, "video");
  assert.deepEqual(tracks.map((t) => [t.label, t.clipCount]), [["V1", 3], ["V2", 1], ["V3", 0]]);

  const clips = await adapter.readVideoClips(tracks[0].track);
  assert.equal(clips.length, 3);
  assert.equal(clips[1].inPoint, sec(20));
  assert.equal(clips[1].desc.mediaStart, sec(36000));
  assert.equal(clips[1].desc.hasAudio, true);

  const light = await adapter.readTrackItemsLight(tracks[1].track, true);
  assert.equal(light[0].mediaKey, "d:/footage/side.mp4");
  assert.equal(light[0].inPoint, 0);

  const projectClips = await adapter.listProjectClips(ctx.project, log);
  assert.deepEqual(projectClips.map((c) => c.binPath + c.name), ["Footage/Front.mp4", "Footage/Side.mp4", "Music.wav"]);
  assert.equal(await adapter.firstProjectItemId(tracks[1].track), scenario.side.id);

  scenario.sequence.selectedItems = [scenario.v1.items[1]];
  const selected = await adapter.readSelection(ctx.sequence);
  assert.deepEqual(selected.map((s) => [s.trackIndex, S(s.start), S(s.inPoint), s.mediaKey]), [[0, 10, 20, "d:/footage/front.mp4"]]);
});

await test("one pass: the reference side clip on the Target track is consumed and the front edit mirrored", async () => {
  const scenario = createScenario({ emptyTarget: true });
  const v2clip = placeReference(scenario, scenario.v2, scenario.side, 0, 7, 60, scenario.v1.items[0]); // side = front + 5 s
  const { engine, log } = engineFor(scenario);
  const analysis = await engine.analyze(params(scenario));
  assert.equal(analysis.plan.placements.length, 3);
  assert.equal(analysis.plan.cuts, 1);
  assert.equal(analysis.plan.gaps, 1);
  assert.equal(analysis.reference.videoItem, v2clip);
  assert.equal(analysis.parking.index, 1); // A2 is the empty one
  const text = analysis.summary.join("\n");
  assert.match(text, /Sync reference: Master clip 1 \("Front\.mp4", file Front\.mp4\) at 00:00:00:00 \(source 00:00:02:00\) and side clip Side\.mp4 on V2 at 00:00:00:00 \(source 00:00:07:00\) -> side = front \+ 5\.000 s/);
  assert.match(text, /This pass: place 3 clips \(Front\.mp4: 3\)/);
  assert.match(text, /Reference clip Side\.mp4 on V2 will be removed/);
  assert.match(text, /parked on A2/);
  assert.equal(analysis.params.reference.baseShiftSeconds, 5);

  const a1Before = scenario.sequence.audioTracks[0].items.map((i) => [i.start, i.end]);
  const a3Before = scenario.sequence.audioTracks[2].items.map((i) => [i.start, i.end]);
  const v1Before = scenario.v1.items.map((i) => [i.start, i.end, i.inPoint]);
  const result = await engine.sync(analysis);

  const v2 = scenario.v2.getTrackItems(1);
  assert.deepEqual(v2.map((i) => [S(i.start), S(i.end), S(i.inPoint)]), [[0, 10, 7], [10, 18, 25], [20, 30, 45]]);
  assert.ok(v2.every((i) => i.projectItem === scenario.side));
  assert.deepEqual(scenario.sequence.audioTracks[0].items.map((i) => [i.start, i.end]), a1Before, "A1 untouched");
  assert.deepEqual(scenario.sequence.audioTracks[2].items.map((i) => [i.start, i.end]), a3Before, "A3 untouched");
  assert.equal(scenario.sequence.audioTracks[1].items.length, 0, "parking track A2 left empty");
  assert.deepEqual(scenario.v1.items.map((i) => [i.start, i.end, i.inPoint]), v1Before, "master untouched");
  assert.equal(scenario.side.inPoint, null, "side footage marks cleared");
  assert.equal(scenario.ppro.SourceMonitor._state.closedAll, 1);

  /* remove reference + 3 x (mark, place, drop audio) + clear marks = 11 undo steps. */
  assert.equal(result.steps, 11);
  assert.equal(scenario.project.transactions[0].label, "LazyEditMirror: remove reference side clip");
  assert.equal(result.verification.ok, true);
  assert.equal(result.leftoverAudio, 0);
  assert.equal(result.remaining, 0);
  assert.match(result.report.join("\n"), /Verified: 3 clip\(s\) placed on V2/);
  assert.match(result.report.join("\n"), /Every Master clip now has a side clip on V2/);
  assert.ok(log.lines.some((l) => /Clip 1\/3 \(master 1\): 00:00:00:00-00:00:10:00 <- side 00:00:07:00, audio dropped/.test(l)), log.lines.join("\n"));
});

await test("the reference clip's own audio does not block the parking track and is removed with it", async () => {
  const scenario = createScenario({ emptyTarget: true, audioTracks: 2 }); // A1 front audio, A2 free
  const v3 = scenario.sequence.videoTracks[2];
  placeReference(scenario, v3, scenario.side, 0, 7, 60, scenario.v1.items[0]);
  const a2 = scenario.sequence.audioTracks[1];
  const refAudio = a2.add({ start: 0, end: sec(60), inPoint: sec(7), outPoint: sec(67), projectItem: scenario.side });
  const { engine } = engineFor(scenario);
  const analysis = await engine.analyze(params(scenario));
  assert.equal(analysis.parking.index, 1);
  assert.deepEqual(analysis.reference.audioItems, [refAudio]);
  assert.match(analysis.summary.join("\n"), /Reference clip Side\.mp4 on V3 \(and its audio on A2\) will be removed/);
  const result = await engine.sync(analysis);
  assert.equal(result.verification.ok, true);
  assert.equal(v3.items.length, 0, "reference video removed from V3");
  assert.equal(a2.items.length, 0, "reference audio removed and parking track left empty");
  assert.equal(scenario.v2.items.length, 3);
  assert.equal(result.steps, 12); // + the audio removal
});

await test("two front files, two passes: each side clip fills its own clips and leaves the rest alone", async () => {
  const scenario = createScenario({ multiFile: true, emptyTarget: true });
  const v3 = scenario.sequence.videoTracks[2];
  const { engine } = engineFor(scenario);

  /* Pass 1: Side.mp4 synced with Master clip 1 (side = front + 5 s). */
  placeReference(scenario, v3, scenario.side, 0, 7, 60, scenario.v1.items[0]);
  const first = await engine.analyze(params(scenario));
  assert.equal(first.plan.counts.placed, 3);
  assert.equal(first.plan.counts.otherFile, 2);
  assert.match(first.summary.join("\n"), /Master V1: 5 clips from 2 files, 3 cuts, 1 gaps/);
  assert.match(first.summary.join("\n"), /Skipped: 2 from front files without a match here \(Front2\.mp4: 2\) wait for their own side clip/);
  const r1 = await engine.sync(first);
  assert.equal(r1.verification.ok, true);
  assert.equal(r1.remaining, 2);
  assert.match(r1.report.join("\n"), /Still without a side clip: 2 Master clip\(s\) \(Front2\.mp4: 2\)/);
  assert.equal(v3.items.length, 0);
  assert.deepEqual(scenario.v2.getTrackItems(1).map((i) => [S(i.start), S(i.end), i.projectItem.name]), [[0, 10, "Side.mp4"], [10, 18, "Side.mp4"], [20, 30, "Side.mp4"]]);

  /* Pass 2: Side2.mp4 synced with Master clip 4 (side2 = front2 + 10 s): at timeline 30 s the side2 source is 15 s. */
  placeReference(scenario, v3, scenario.side2, 30, 15, 60, scenario.v1.items[3]);
  const second = await engine.analyze(params(scenario, { targetClipId: scenario.side2.id }));
  assert.equal(second.targetMedia.name, "Side2.mp4");
  assert.equal(second.plan.counts.placed, 2);
  assert.equal(second.plan.counts.already, 3);
  assert.match(second.summary.join("\n"), /Skipped: 3 already on V2/);
  assert.deepEqual(second.plan.placements.map((c) => [S(c.timelineStart), S(c.targetIn)]), [[30, 15], [40, 40]]);
  const r2 = await engine.sync(second);
  assert.equal(r2.verification.ok, true);
  assert.equal(r2.remaining, 0);
  assert.deepEqual(
    scenario.v2.getTrackItems(1).map((i) => [S(i.start), S(i.end), S(i.inPoint), i.projectItem.name]),
    [[0, 10, 7, "Side.mp4"], [10, 18, 25, "Side.mp4"], [20, 30, 45, "Side.mp4"], [30, 40, 15, "Side2.mp4"], [40, 52, 40, "Side2.mp4"]]
  );

  /* A third pass with Side.mp4 again finds nothing left to do. */
  placeReference(scenario, v3, scenario.side, 0, 7, 60, scenario.v1.items[0]);
  await assert.rejects(engine.analyze(params(scenario)), /Nothing to place in this pass: 5 already on the Target track\.[\s\S]*Those clips are done already/);
});

await test("the Master clip under the side clip's start is used when none is selected", async () => {
  const scenario = createScenario({ emptyTarget: true });
  const v3 = scenario.sequence.videoTracks[2];
  placeReference(scenario, v3, scenario.side, 12, 37, 40, null); // starts inside Master clip 2 (10-18 s, source 20 s): side source 37 at 12 s -> front 22 -> side = front + 15
  const { engine } = engineFor(scenario);
  const analysis = await engine.analyze(params(scenario));
  assert.match(analysis.summary.join("\n"), /Master clip 2 .*auto-picked under the side clip/);
  assert.equal(analysis.params.reference.baseShiftSeconds, 15);
  assert.deepEqual(analysis.plan.placements.map((c) => S(c.targetIn)), [17, 35, 55]);
});

await test("a short side file covers only part of the edit; the rest is reported as remaining", async () => {
  const scenario = createScenario({ emptyTarget: true, sideDuration: sec(30) });
  placeReference(scenario, scenario.v2, scenario.side, 0, 7, 20, scenario.v1.items[0]);
  const { engine } = engineFor(scenario);
  const analysis = await engine.analyze(params(scenario));
  assert.equal(analysis.plan.counts.placed, 1);
  assert.equal(analysis.plan.counts.outOfRange, 2);
  assert.match(analysis.summary.join("\n"), /Skipped: 2 outside this side file/);
  const result = await engine.sync(analysis);
  assert.equal(result.verification.ok, true);
  assert.equal(result.remaining, 2);
  assert.match(result.report.join("\n"), /Still without a side clip: 2 Master clip\(s\) \(Front\.mp4: 2\)/);
});

await test("re-analysis uses the resolved reference without the selection, and notices if it moved", async () => {
  const scenario = createScenario({ emptyTarget: true });
  const v3 = scenario.sequence.videoTracks[2];
  const refClip = placeReference(scenario, v3, scenario.side, 0, 7, 60, scenario.v1.items[0]);
  const { engine } = engineFor(scenario);
  const analysis = await engine.analyze(params(scenario));
  scenario.sequence.selectedItems = [];
  const again = await engine.analyze(Object.assign({}, analysis.params, { projectClips: null }));
  assert.deepEqual(again.plan.placements.map((c) => S(c.targetIn)), [7, 25, 45]);
  assert.equal(again.reference.videoItem, refClip);
  assert.match(again.summary.join("\n"), /Sync reference \(read earlier\)/);
  refClip.start += sec(1);
  refClip.end += sec(1);
  await assert.rejects(engine.analyze(Object.assign({}, analysis.params, { projectClips: null })), /reference side clip moved or was removed/);
});

await test("selection mode explains what to select", async () => {
  const scenario = createScenario({ emptyTarget: true });
  const { engine } = engineFor(scenario);
  await assert.rejects(engine.analyze(params(scenario)), /Nothing is selected/);
  scenario.sequence.selectedItems = [scenario.v1.items[1]];
  await assert.rejects(engine.analyze(params(scenario)), /No side clip is selected on a video track other than V1/);
  const v3 = scenario.sequence.videoTracks[2];
  placeReference(scenario, v3, scenario.front, 0, 2, 30, scenario.v1.items[0]); // the front file itself on V3
  await assert.rejects(engine.analyze(params(scenario)), /same file as the Master clip/);
  v3.items = [];
  /* A pair that is not really in sync gives a wrong offset (-52 s here), which the bounds check catches. */
  placeReference(scenario, v3, scenario.side, 50, 0, 60, scenario.v1.items[0]);
  await assert.rejects(engine.analyze(params(scenario)), /Sync reference: Master clip 1[\s\S]*side = front - 52\.000 s[\s\S]*Nothing to place in this pass: 3 outside the side file[\s\S]*sync reference is right/);
});

await test("timecode and offset modes work per front file, with an empty Target track", async () => {
  const scenario = createScenario({ multiFile: true, emptyTarget: true });
  const { engine } = engineFor(scenario);
  /* Timecode: Side.mp4 (09:59:55:00) fits Front.mp4 (10:00:00:00); Front2.mp4 (11:06:40:00) maps far past its end. */
  const tcRun = await engine.analyze(params(scenario, { mode: "timecode" }));
  assert.equal(tcRun.plan.counts.placed, 3);
  assert.equal(tcRun.plan.counts.outOfRange, 2);
  assert.match(tcRun.summary.join("\n"), /Mapping: source timecode of each front file vs Side\.mp4/);
  assert.deepEqual(tcRun.plan.placements.map((c) => S(c.targetIn)), [7, 25, 45]);

  /* Offset: applies to the front file of the selected Master clip. */
  scenario.sequence.selectedItems = [scenario.v1.items[3]];
  const offsetRun = await engine.analyze(params(scenario, { mode: "offset", offsetSeconds: 10, targetClipId: scenario.side2.id }));
  assert.equal(offsetRun.plan.counts.placed, 2);
  assert.equal(offsetRun.plan.counts.otherFile, 3);
  assert.deepEqual(offsetRun.plan.placements.map((c) => S(c.targetIn)), [15, 40]);
  assert.equal(offsetRun.params.frontMediaKey, "d:/footage/front2.mp4");
  const result = await engine.sync(offsetRun);
  assert.equal(result.verification.ok, true);
  assert.deepEqual(scenario.v2.getTrackItems(1).map((i) => [S(i.start), S(i.inPoint)]), [[30, 15], [40, 40]]);

  /* An offset that is not a whole number of frames snaps to the nearest frame (1.5 s = 37.5 frames -> 38 frames). */
  scenario.sequence.selectedItems = [scenario.v1.items[0]];
  const snap = await engine.analyze(params(scenario, { mode: "offset", offsetSeconds: 1.5 }));
  assert.equal(snap.plan.placements[0].targetIn, FRAME * 88); // 2 s + 1.52 s = 88 frames at 25 fps
});

await test("timecodes that cannot overlap are reported as not jam-synced, with the facts", async () => {
  const scenario = createScenario({ sideStart: sec(36000 - 2000), emptyTarget: true });
  const { engine, log } = engineFor(scenario);
  let message = "";
  try {
    await engine.analyze(params(scenario, { mode: "timecode" }));
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /Side footage Side\.mp4: 590\.000 s long/);
  assert.match(message, /Nothing to place in this pass: 3 outside the side file/);
  assert.match(message, /not jam-synced/);
  assert.ok(log.lines.filter((l) => /past the end of the side file/.test(l)).length === 3, "every clip problem is in the log");
});

await test("unsupported Master clips are skipped, transitions and bad input are fatal", async () => {
  const scenario = createScenario({ emptyTarget: true });
  placeReference(scenario, scenario.v2, scenario.side, 0, 7, 60, scenario.v1.items[0]);
  scenario.v1.items[1].speed = 0.5;
  const { engine } = engineFor(scenario);
  const analysis = await engine.analyze(params(scenario));
  assert.equal(analysis.plan.counts.unsupported, 1);
  assert.equal(analysis.plan.counts.placed, 2);
  assert.match(analysis.summary.join("\n"), /1 unsupported \(see log\)/);

  await assert.rejects(engine.analyze(params(scenario, { targetIndex: 0 })), /different tracks/);
  await assert.rejects(engine.analyze(params(scenario, { offsetSeconds: "abc" })), /offset must be a number/);
  scenario.v1.transitions.push({});
  await assert.rejects(engine.analyze(params(scenario)), /has transitions/);
});

await test("a side file without audio needs no parking track; otherwise an empty one is required", async () => {
  const scenario = createScenario({ sideHasAudio: false, audioTracks: 1, emptyTarget: true });
  placeReference(scenario, scenario.v2, scenario.side, 0, 7, 60, scenario.v1.items[0]);
  const { engine } = engineFor(scenario);
  const analysis = await engine.analyze(params(scenario));
  assert.equal(analysis.parking, null);
  const result = await engine.sync(analysis);
  assert.equal(result.steps, 8); // remove reference + 3 x (mark, place) + clear marks
  assert.equal(result.verification.ok, true);

  const blocked = createScenario({ audioTracks: 1, emptyTarget: true });
  placeReference(blocked, blocked.v2, blocked.side, 0, 7, 60, blocked.v1.items[0]);
  await assert.rejects(engineFor(blocked).engine.analyze(params(blocked)), /No empty audio track/);
  assert.equal(blocked.project.transactions.length, 0, "nothing was changed");
});

await test("audio mode: the helper's offsets drive the placement, one pass per side file", async () => {
  const scenario = createScenario({ multiFile: true, emptyTarget: true });
  const audio = fakeAudio({ "Front.mp4": 5 });
  const { engine, log, progress } = engineFor(scenario, audio.client);
  const first = await engine.analyze(params(scenario, { mode: "audio", targetClipId: scenario.side.id }));
  assert.equal(audio.calls.length, 1);
  assert.deepEqual(audio.calls[0], { side: "D:/Footage/Side.mp4", fronts: ["D:/Footage/Front.mp4", "D:/Footage/Front2.mp4"] });
  assert.ok(progress.some((m) => /Reading the audio/.test(m)));
  const text = first.summary.join("\n");
  assert.match(text, /Audio: Side\.mp4 vs Front\.mp4: side = front \+ 5\.000 s \(match; correlation 0\.62 over 180\.0 s\)/);
  assert.match(text, /Audio: Side\.mp4 vs Front2\.mp4: no match \(correlation 0\.04\)/);
  assert.equal(first.plan.counts.placed, 3);
  assert.equal(first.plan.counts.otherFile, 2);
  assert.equal(first.reference, null);
  assert.ok(log.lines.some((l) => /Skipped 2 clip\(s\) of Front2\.mp4: no sync reference/.test(l)));

  /* Sync re-analyzes with the resolved params: no second trip to the helper. */
  const again = await engine.analyze(Object.assign({}, first.params, { projectClips: null }));
  assert.equal(audio.calls.length, 1);
  assert.deepEqual(again.plan.placements.map((c) => S(c.targetIn)), [7, 25, 45]);
  const r1 = await engine.sync(again);
  assert.equal(r1.verification.ok, true);
  assert.equal(r1.remaining, 2);

  /* Second side file: matches the other front file. */
  const audio2 = fakeAudio({ "Front2.mp4": 10 });
  const { engine: engine2 } = engineFor(scenario, audio2.client);
  const second = await engine2.analyze(params(scenario, { mode: "audio", targetClipId: scenario.side2.id }));
  assert.equal(second.plan.counts.placed, 2);
  assert.equal(second.plan.counts.already, 3);
  const r2 = await engine2.sync(second);
  assert.equal(r2.remaining, 0);
  assert.deepEqual(
    scenario.v2.getTrackItems(1).map((i) => [S(i.start), S(i.inPoint), i.projectItem.name]),
    [[0, 7, "Side.mp4"], [10, 25, "Side.mp4"], [20, 45, "Side.mp4"], [30, 15, "Side2.mp4"], [40, 40, "Side2.mp4"]]
  );
});

await test("audio mode: one long side file can cover several front files in a single pass", async () => {
  const scenario = createScenario({ multiFile: true, emptyTarget: true });
  const audio = fakeAudio({ "Front.mp4": 5, "Front2.mp4": 10 });
  const { engine } = engineFor(scenario, audio.client);
  const analysis = await engine.analyze(params(scenario, { mode: "audio", targetClipId: scenario.side.id }));
  assert.equal(analysis.plan.counts.placed, 5);
  assert.deepEqual(analysis.plan.placements.map((c) => S(c.targetIn)), [7, 25, 45, 15, 40]);
});

await test("audio mode: a selected clip of the side footage is consumed, weak matches are reported but unused", async () => {
  const scenario = createScenario({ multiFile: true, emptyTarget: true });
  const v3 = scenario.sequence.videoTracks[2];
  const refClip = placeReference(scenario, v3, scenario.side, 0, 0, 60, null);
  const audio = fakeAudio({ "Front.mp4": 5, "Front2.mp4": { status: "weak", offsetSeconds: 10, score: 0.1, z: 13, prominence: 1.3, overlapSeconds: 20 } });
  const { engine } = engineFor(scenario, audio.client);
  const analysis = await engine.analyze(params(scenario, { mode: "audio", targetClipId: scenario.side.id }));
  assert.equal(analysis.reference.videoItem, refClip);
  assert.match(analysis.summary.join("\n"), /Front2\.mp4: weak match only \(correlation 0\.10, offset \+ 10\.000 s\) - not used/);
  assert.match(analysis.summary.join("\n"), /Reference clip Side\.mp4 on V3 will be removed/);
  assert.equal(analysis.plan.counts.placed, 3);
  const result = await engine.sync(analysis);
  assert.equal(result.verification.ok, true);
  assert.equal(v3.items.length, 0);
});

await test("a front file or an offline item chosen as side footage fails before the helper is asked", async () => {
  const scenario = createScenario({ multiFile: true, emptyTarget: true });
  const audio = fakeAudio({ "Front.mp4": 5 });
  const { engine } = engineFor(scenario, audio.client);
  await assert.rejects(
    engine.analyze(params(scenario, { mode: "audio", targetClipId: scenario.front2.id })),
    /Side Camera footage "Footage\/Front2\.mp4" is a front file: it is cut on V1 \(clip 4\)[\s\S]*Choose the side recording/
  );
  assert.equal(audio.calls.length, 0, "the helper was not called");

  scenario.ppro.ClipProjectItem.cast = ((original) => (item) => {
    const cast = original(item);
    if (cast && item === scenario.side) cast.isOffline = async () => true;
    return cast;
  })(scenario.ppro.ClipProjectItem.cast);
  await assert.rejects(engine.analyze(params(scenario, { mode: "audio", targetClipId: scenario.side.id })), /reported offline by Premiere Pro[\s\S]*Link Media/);
  assert.equal(audio.calls.length, 0);
  await assert.rejects(engine.analyze(params(scenario, { mode: "timecode", targetClipId: scenario.side.id })), /reported offline/);
});

await test("audio mode: clear messages when the helper is down, has no ffmpeg, or hears nothing", async () => {
  const scenario = createScenario({ emptyTarget: true });
  await assert.rejects(engineFor(scenario, fakeAudio({}, { down: true }).client).engine.analyze(params(scenario, { mode: "audio" })), /audio engine is not running[\s\S]*start-helper\.bat/);
  await assert.rejects(engineFor(scenario, fakeAudio({}, { noFfmpeg: true }).client).engine.analyze(params(scenario, { mode: "audio" })), /cannot find ffmpeg/);
  await assert.rejects(engineFor(scenario, null).engine.analyze(params(scenario, { mode: "audio" })), /not available in this build/);
  await assert.rejects(engineFor(scenario, fakeAudio({}).client).engine.analyze(params(scenario, { mode: "audio" })), /Nothing to place in this pass: 3 from other front files[\s\S]*matched none of the front files/);
});

await test("a failure mid-sync reports how many undo steps were made", async () => {
  const scenario = createScenario({ emptyTarget: true });
  placeReference(scenario, scenario.v2, scenario.side, 0, 7, 60, scenario.v1.items[0]);
  const { engine } = engineFor(scenario);
  const analysis = await engine.analyze(params(scenario));
  const editor = scenario.ppro.SequenceEditor.getEditor();
  const realOverwrite = editor.createOverwriteItemAction;
  let calls = 0;
  editor.createOverwriteItemAction = function () {
    calls += 1;
    if (calls === 2) throw new Error("Script Action failed to execute");
    return realOverwrite.apply(this, arguments);
  };
  /* remove reference, mark 1, place 1, drop audio 1, mark 2 = 5 steps before the second placement fails. */
  await assert.rejects(engine.sync(analysis), /Stopped after 5 undoable steps; press Ctrl\+Z 5 times/);
});

await test("verification notices a systematic offset", async () => {
  const scenario = createScenario({ emptyTarget: true });
  placeReference(scenario, scenario.v2, scenario.side, 0, 7, 60, scenario.v1.items[0]);
  const { engine } = engineFor(scenario);
  const analysis = await engine.analyze(params(scenario));
  const editor = scenario.ppro.SequenceEditor.getEditor();
  const realOverwrite = editor.createOverwriteItemAction;
  editor.createOverwriteItemAction = function (projectItem, time, v, a) {
    return realOverwrite.call(this, projectItem, scenario.ppro.TickTime.createWithTicks(String(time.ticksNumber + sec(3600))), v, a);
  };
  const result = await engine.sync(analysis);
  assert.equal(result.verification.ok, false);
  assert.ok(Math.abs(result.verification.uniformDelta - sec(3600)) <= FRAME / 2);
  assert.match(result.report.join("\n"), /systematic offset/);
});

console.log(passed + " sync test(s) passed" + (process.exitCode ? ", with failures" : "") + ".");
