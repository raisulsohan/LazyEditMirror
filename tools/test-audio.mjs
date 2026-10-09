/*
 * Tests for audio.js on synthetic "speech-like" signals. Run: node tools/test-audio.mjs
 *
 * A random syllable-rate envelope modulates white noise to make a front
 * recording; the side recording is a cut-out of the same sound at a
 * different level with its own noise and a slow gain drift. The offset must
 * come back within one envelope frame, and unrelated recordings must not
 * match.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const audio = require("../helper/audio.js");

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

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const RATE = audio.PCM_RATE;

/** Speech-like loudness: bursts of 50-300 ms with pauses, as an amplitude curve at the PCM rate. */
function speechEnvelope(seconds, random) {
  const n = Math.round(seconds * RATE);
  const env = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const burst = Math.round((0.05 + random() * 0.25) * RATE);
    const level = 0.2 + random() * 0.8;
    for (let k = 0; k < burst && i + k < n; k += 1) {
      const ramp = Math.sin((Math.PI * k) / burst);
      env[i + k] = level * (0.3 + 0.7 * ramp);
    }
    i += burst;
    const pause = Math.round((random() < 0.2 ? 0.3 + random() * 1.2 : random() * 0.12) * RATE);
    i += pause;
  }
  return env;
}

/** The "room sound": the envelope modulating white noise. */
function roomSound(seconds, seed) {
  const random = rng(seed);
  const env = speechEnvelope(seconds, random);
  const pcm = new Float32Array(env.length);
  for (let i = 0; i < env.length; i += 1) pcm[i] = env[i] * gaussian(random);
  return pcm;
}

/** A camera's recording of `room` from `startSeconds` for `seconds`, with its own noise and gain drift. */
function recording(room, startSeconds, seconds, gain, noise, seed) {
  const random = rng(seed);
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  const start = Math.round(startSeconds * RATE);
  for (let i = 0; i < n; i += 1) {
    const src = start + i;
    const drift = 1 + 0.5 * Math.sin((2 * Math.PI * i) / (RATE * 40)); // slow level wobble (auto gain)
    const signal = src >= 0 && src < room.length ? room[src] : 0;
    out[i] = gain * drift * signal + noise * gaussian(random);
  }
  return out;
}

const room = roomSound(400, 1);
const front = recording(room, 0, 400, 1.0, 0.05, 2); // the front camera: the whole take
const frontEnv = audio.envelopeFromPcm(front, RATE);

test("envelope: 200 frames per second, standardized", () => {
  assert.equal(Math.round(frontEnv.length / 400), audio.FRAME_HZ);
  let mean = 0;
  for (const v of frontEnv) mean += v;
  assert.ok(Math.abs(mean / frontEnv.length) < 0.01);
});

test("side camera that started 73.3 s later, quieter, noisier: offset recovered within a frame", () => {
  const side = recording(room, 73.3, 150, 0.4, 0.15, 3);
  const result = audio.findOffset(frontEnv, audio.envelopeFromPcm(side, RATE));
  assert.equal(result.status, "match", JSON.stringify(result));
  /* side = front + k, and side time 0 is front time 73.3: k = -73.3 */
  assert.ok(Math.abs(result.offsetSeconds - -73.3) <= 1 / audio.FRAME_HZ, "offset " + result.offsetSeconds);
  assert.ok(result.overlapSeconds > 140);
});

test("side camera that started 20 s BEFORE the front one (positive offset)", () => {
  const side = recording(room, -20, 120, 1.5, 0.1, 4);
  const result = audio.findOffset(frontEnv, audio.envelopeFromPcm(side, RATE));
  assert.equal(result.status, "match", JSON.stringify(result));
  assert.ok(Math.abs(result.offsetSeconds - 20) <= 1 / audio.FRAME_HZ, "offset " + result.offsetSeconds);
});

test("a side file longer than the front file, covering it entirely", () => {
  const longRoom = roomSound(300, 7);
  const shortFront = recording(longRoom, 100, 60, 1, 0.05, 8);
  const longSide = recording(longRoom, 0, 300, 0.7, 0.1, 9);
  const result = audio.findOffset(audio.envelopeFromPcm(shortFront, RATE), audio.envelopeFromPcm(longSide, RATE));
  assert.equal(result.status, "match", JSON.stringify(result));
  assert.ok(Math.abs(result.offsetSeconds - 100) <= 1 / audio.FRAME_HZ, "offset " + result.offsetSeconds);
});

test("recordings of different takes do not match", () => {
  for (const seed of [11, 21, 31, 41]) {
    const otherRoom = roomSound(200, seed);
    const stranger = recording(otherRoom, 0, 200, 1, 0.1, seed + 1);
    const result = audio.findOffset(frontEnv, audio.envelopeFromPcm(stranger, RATE));
    assert.equal(result.status, "none", JSON.stringify(result));
    assert.ok(result.z < 20, "z " + result.z);
    assert.ok(result.prominence < 1.25, "prominence " + result.prominence);
  }
});

test("a true match with only 25 s in common is still found", () => {
  const side = recording(room, 375, 90, 0.6, 0.12, 14); // 25 s of the take, then silence
  const result = audio.findOffset(frontEnv, audio.envelopeFromPcm(side, RATE));
  assert.equal(result.status, "match", JSON.stringify(result));
  assert.ok(Math.abs(result.offsetSeconds - -375) <= 1 / audio.FRAME_HZ, "offset " + result.offsetSeconds);
});

test("only a few seconds in common is not enough", () => {
  const side = recording(room, 396, 60, 1, 0.1, 13); // 4 s of overlap, then silence
  const result = audio.findOffset(frontEnv, audio.envelopeFromPcm(side, RATE));
  assert.notEqual(result.status, "match", JSON.stringify(result));
});

test("cross-correlation lag convention: side frame j shows front frame j - K", () => {
  const x = new Float32Array([0, 0, 1, 0, 0, 0, 0, 0]);
  const y = new Float32Array([0, 0, 0, 0, 1, 0]);
  const c = audio.crossCorrelate(x, y);
  const size = c.length;
  let bestK = null;
  let best = -Infinity;
  for (let K = -7; K <= 5; K += 1) {
    const v = c[(K + size) % size];
    if (v > best) {
      best = v;
      bestK = K;
    }
  }
  assert.equal(bestK, 2); // the spike is at front 2 and side 4: side = front + 2
});

console.log(passed + " audio test(s) passed" + (process.exitCode ? ", with failures" : "") + ".");
