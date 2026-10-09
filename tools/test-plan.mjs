/*
 * Unit tests for plan.js (pure logic). Run: node tools/test-plan.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plan = require("../plan.js");

const TPS = plan.TICKS_PER_SECOND;
const sec = (s) => Math.round(s * TPS);
const FRAME = TPS / 25;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok  " + name);
  } catch (error) {
    console.error("FAIL  " + name);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

/* Three front clips with a cut and a gap; side = front + 5 s. */
const masterClips = [
  { index: 0, name: "A", mediaName: "Front.mp4", start: sec(0), end: sec(10), inPoint: sec(2), outPoint: sec(12), speed: 1, shift: sec(5) },
  { index: 1, name: "B", mediaName: "Front.mp4", start: sec(10), end: sec(18), inPoint: sec(20), outPoint: sec(28), speed: 1, shift: sec(5) },
  { index: 2, name: "C", mediaName: "Front.mp4", start: sec(20), end: sec(30), inPoint: sec(40), outPoint: sec(50), speed: 1, shift: sec(5) },
];
const base = { masterClips, targetMediaDuration: sec(590), frameTicks: FRAME };

test("places every mappable clip, counting cuts and gaps", () => {
  const result = plan.buildMirrorPlan(base);
  assert.deepEqual(result.errors, []);
  assert.equal(result.cuts, 1);
  assert.equal(result.gaps, 1);
  assert.equal(result.placements.length, 3);
  assert.equal(result.counts.placed, 3);
  assert.equal(result.placements[0].targetIn, sec(7));
  assert.equal(result.placements[0].targetOut, sec(17));
  assert.equal(result.placements[2].targetIn, sec(45));
  assert.equal(result.placements[2].timelineStart, sec(20));
  assert.equal(result.totalDuration, sec(28));
  assert.deepEqual(result.byFile, { "Front.mp4": { total: 3, placed: 3, remaining: 0, already: 0, otherFile: 0, outOfRange: 0, unsupported: 0 } });
});

test("the extra offset adds to every clip's shift and snaps to the frame grid", () => {
  const result = plan.buildMirrorPlan(Object.assign({}, base, { offset: sec(-2) }));
  assert.equal(result.placements[0].targetIn, sec(5));
  const odd = plan.buildMirrorPlan(Object.assign({}, base, { offset: sec(0.3) }));
  const clip = odd.placements[0];
  assert.equal(clip.targetIn % FRAME, 0);
  assert.equal(clip.targetIn, FRAME * Math.round(sec(7.3) / FRAME));
  assert.equal(clip.targetOut - clip.targetIn, sec(10));
  assert.ok(Math.abs(clip.alignedBy) <= FRAME / 2);
});

test("sorts clips by timeline position", () => {
  const shuffled = [masterClips[2], masterClips[0], masterClips[1]];
  const result = plan.buildMirrorPlan(Object.assign({}, base, { masterClips: shuffled }));
  assert.deepEqual(result.placements.map((c) => c.name), ["A", "B", "C"]);
  assert.equal(result.cuts, 1);
  assert.equal(result.gaps, 1);
});

test("clips of other front files, unsupported clips and out-of-range clips are skipped, not fatal", () => {
  const clips = masterClips.map((c) => Object.assign({}, c));
  clips[0].shift = null;
  clips[0].skip = { reason: plan.SKIP.otherFile, detail: "A is from Front2.mp4" };
  clips[0].mediaName = "Front2.mp4";
  clips[1].speed = 2;
  const result = plan.buildMirrorPlan(Object.assign({}, base, { masterClips: clips }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.placements.map((c) => c.name), ["C"]);
  assert.equal(result.counts.otherFile, 1);
  assert.equal(result.counts.unsupported, 1);
  assert.equal(result.counts.placed, 1);
  assert.deepEqual(result.byFile, {
    "Front2.mp4": { total: 1, placed: 0, remaining: 1, already: 0, otherFile: 1, outOfRange: 0, unsupported: 0 },
    "Front.mp4": { total: 2, placed: 1, remaining: 1, already: 0, otherFile: 0, outOfRange: 0, unsupported: 1 },
  });

  const short = plan.buildMirrorPlan(Object.assign({}, base, { targetMediaDuration: sec(48) })); // C maps to 45-55 s, past 48 s
  assert.deepEqual(short.errors, []);
  assert.deepEqual(short.placements.map((c) => c.name), ["A", "B"]);
  assert.equal(short.counts.outOfRange, 1);
  assert.match(short.skipped[0].detail, /past the end of the side file/);
});

test("nothing to place is an error that explains why", () => {
  const occupied = [{ start: sec(0), end: sec(60) }];
  const result = plan.buildMirrorPlan(Object.assign({}, base, { occupied }));
  assert.equal(result.placements.length, 0);
  assert.equal(result.counts.already, 3);
  assert.match(result.errors[0], /Nothing to place in this pass: 3 already on the Target track/);
  assert.deepEqual(result.byFile["Front.mp4"], { total: 3, placed: 0, remaining: 0, already: 3, otherFile: 0, outOfRange: 0, unsupported: 0 });

  const early = plan.buildMirrorPlan(Object.assign({}, base, { masterClips: masterClips.map((c) => Object.assign({}, c, { shift: sec(-50) })) }));
  assert.equal(early.counts.outOfRange, 3);
  assert.match(early.errors[0], /3 outside the side file/);
  assert.match(early.skipped[0].detail, /before the side file starts/);

  const none = plan.buildMirrorPlan(Object.assign({}, base, { masterClips: [] }));
  assert.match(none.errors[0], /no video clips/);
});

test("only the ranges that are free on the Target track are placed", () => {
  const occupied = [{ start: sec(10), end: sec(18) }];
  const result = plan.buildMirrorPlan(Object.assign({}, base, { occupied }));
  assert.deepEqual(result.placements.map((c) => c.name), ["A", "C"]);
  assert.equal(result.counts.already, 1);
  assert.equal(result.byFile["Front.mp4"].remaining, 0);
  /* Touching ranges are not overlaps. */
  const touching = plan.buildMirrorPlan(Object.assign({}, base, { occupied: [{ start: sec(18), end: sec(20) }] }));
  assert.equal(touching.placements.length, 3);
});

test("rejects overlapping Master clips and warns on source/timeline duration mismatch", () => {
  const overlapping = [masterClips[0], Object.assign({}, masterClips[1], { start: sec(9) })];
  const r1 = plan.buildMirrorPlan(Object.assign({}, base, { masterClips: overlapping }));
  assert.match(r1.errors.join("\n"), /overlaps/);
  const odd = [Object.assign({}, masterClips[0], { outPoint: sec(11) })];
  const r2 = plan.buildMirrorPlan(Object.assign({}, base, { masterClips: odd }));
  assert.equal(r2.errors.length, 0);
  assert.equal(r2.warnings.length, 1);
  assert.equal(r2.placements[0].duration, sec(10));
});

test("verifyMirror checks the placements and can ignore clips from earlier passes", () => {
  const mirror = plan.buildMirrorPlan(base);
  const good = mirror.placements.map((c) => ({ start: c.timelineStart + 1000, end: c.timelineEnd - 1000, name: "x" }));
  assert.equal(plan.verifyMirror(mirror, good, FRAME).ok, true);

  const v1 = plan.verifyMirror(mirror, good.slice(1), FRAME);
  assert.equal(v1.ok, false);
  assert.equal(v1.missing.length, 1);

  const shortEnd = good.map((c, i) => (i === 1 ? { start: c.start, end: c.end - FRAME * 2 } : c));
  assert.equal(plan.verifyMirror(mirror, shortEnd, FRAME).mismatched.length, 1);

  const extra = good.concat([{ start: sec(40), end: sec(41) }]);
  assert.equal(plan.verifyMirror(mirror, extra, FRAME).extra.length, 1);
  assert.equal(plan.verifyMirror(mirror, extra, FRAME, { ignoreExtra: true }).ok, true);

  const shifted = good.map((c) => ({ start: c.start + sec(3600), end: c.end + sec(3600) }));
  const v4 = plan.verifyMirror(mirror, shifted, FRAME);
  assert.equal(v4.ok, false);
  assert.ok(Math.abs(v4.uniformDelta - sec(3600)) <= FRAME / 2);
});

test("deriveShiftFromSyncedPair and collapseMessages", () => {
  assert.equal(plan.deriveShiftFromSyncedPair({ start: 0, inPoint: sec(2) }, { start: 0, inPoint: sec(7) }), sec(5));
  assert.equal(plan.deriveShiftFromSyncedPair({ start: sec(10), inPoint: sec(20) }, { start: sec(4), inPoint: sec(9) }), sec(-5));
  const six = ["a", "b", "c", "d", "e", "f"];
  const collapsed = plan.collapseMessages(six, 3);
  assert.equal(collapsed.length, 4);
  assert.match(collapsed[3], /and 3 more/);
  assert.deepEqual(plan.collapseMessages(six.slice(0, 4), 3), ["a", "b", "c", "d"]);
});

test("helpers: empty track lookup, overlap filter, timecode formatting", () => {
  assert.equal(plan.findEmptyTrackIndex([{ index: 0, clipCount: 2 }, { index: 1, clipCount: 0 }, { index: 2, clipCount: 0 }]), 1);
  assert.equal(plan.findEmptyTrackIndex([{ index: 0, clipCount: 2 }]), -1);
  const items = [
    { start: sec(0), end: sec(10) },
    { start: sec(10), end: sec(18) },
    { start: sec(20), end: sec(30) },
  ];
  assert.deepEqual(plan.itemsOverlapping(items, sec(10), sec(18), FRAME), [items[1]]);
  assert.deepEqual(plan.itemsOverlapping(items, sec(18), sec(20), FRAME), []);
  assert.equal(plan.formatTimecode(sec(3661) + FRAME * 3, FRAME), "01:01:01:03");
  assert.equal(plan.formatTimecode(-sec(5), FRAME), "-00:00:05:00");
  assert.equal(plan.formatSeconds(sec(-1.5)), "-1.500 s");
  assert.equal(plan.alignTicks(FRAME * 2.4, FRAME), FRAME * 2);
  assert.equal(plan.alignTicks(FRAME * 2.6, FRAME), FRAME * 3);
  assert.equal(plan.secondsToTicks(1), TPS);
});

console.log(passed + " plan test(s) passed" + (process.exitCode ? ", with failures" : "") + ".");
