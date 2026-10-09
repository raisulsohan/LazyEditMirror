/*
 * End-to-end check of the audio helper with real media files.
 *
 *   node tools/selftest-helper.mjs
 *
 * Builds two small MP4 files with ffmpeg (black video + synthetic
 * speech-like audio) where the "side" file starts 17.3 s into the "front"
 * file, starts a helper on a spare port with its own cache folder, asks it
 * for the offset and checks the answer. Needs ffmpeg on the PATH.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const audio = require("../helper/audio.js");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5199;
const RATE = audio.PCM_RATE;
const EXPECTED_OFFSET = -17.3; // side = front + k; side time 0 is front time 17.3

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
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
function roomSound(seconds, seed) {
  const random = rng(seed);
  const n = Math.round(seconds * RATE);
  const pcm = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const burst = Math.round((0.05 + random() * 0.25) * RATE);
    const level = 0.2 + random() * 0.8;
    for (let k = 0; k < burst && i + k < n; k += 1) pcm[i + k] = level * (0.3 + 0.7 * Math.sin((Math.PI * k) / burst)) * gaussian(random);
    i += burst + Math.round((random() < 0.2 ? 0.3 + random() * 1.2 : random() * 0.12) * RATE);
  }
  return pcm;
}
function recording(room, startSeconds, seconds, gain, noise, seed) {
  const random = rng(seed);
  const out = new Float32Array(Math.round(seconds * RATE));
  const start = Math.round(startSeconds * RATE);
  for (let i = 0; i < out.length; i += 1) {
    const src = start + i;
    out[i] = gain * (src >= 0 && src < room.length ? room[src] : 0) + noise * gaussian(random);
  }
  return out;
}

/** 16-bit mono WAV. */
function wav(pcm) {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 12000))), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function mux(wavFile, mp4File, seconds) {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25", "-i", wavFile, "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "96k", mp4File],
    { windowsHide: true, encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error("ffmpeg mux failed: " + (result.stderr || result.error));
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = join(tmpdir(), "lazyeditmirror-selftest");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const room = roomSound(90, 1);
  const frontWav = join(dir, "front.wav");
  const sideWav = join(dir, "side.wav");
  writeFileSync(frontWav, wav(recording(room, 0, 90, 1, 0.05, 2)));
  writeFileSync(sideWav, wav(recording(room, 17.3, 40, 0.5, 0.15, 3)));
  const frontMp4 = join(dir, "front.mp4");
  const sideMp4 = join(dir, "side.mp4");
  console.log("Building test media in " + dir + " ...");
  mux(frontWav, frontMp4, 90);
  mux(sideWav, sideMp4, 40);

  console.log("Starting the helper on port " + PORT + " ...");
  const helper = spawn(process.execPath, [join(root, "helper", "sync-helper.mjs")], {
    env: Object.assign({}, process.env, { LAZYEDITMIRROR_HELPER_PORT: String(PORT), LAZYEDITMIRROR_CACHE: join(dir, "cache") }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  helper.stdout.on("data", (chunk) => process.stdout.write("  helper | " + chunk));
  helper.stderr.on("data", (chunk) => process.stdout.write("  helper ! " + chunk));

  try {
    let health = null;
    for (let i = 0; i < 40 && !health; i += 1) {
      await delay(250);
      try {
        const r = await fetch("http://127.0.0.1:" + PORT + "/health");
        health = await r.json();
      } catch (e) {
        health = null;
      }
    }
    if (!health) throw new Error("the helper did not come up");
    if (!health.ffmpeg) throw new Error("the helper did not find ffmpeg");
    console.log("Helper up: " + health.ffmpeg);

    const started = await fetch("http://127.0.0.1:" + PORT + "/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side: sideMp4, fronts: [frontMp4] }),
    });
    const { jobId } = await started.json();
    let job;
    for (;;) {
      await delay(300);
      job = await (await fetch("http://127.0.0.1:" + PORT + "/job/" + jobId)).json();
      if (job.state !== "running") break;
    }
    if (job.state !== "done") throw new Error("job failed: " + job.error);
    const result = job.results[0];
    console.log("Result: " + JSON.stringify(result));
    const okStatus = result.status === "match";
    const okOffset = Math.abs(result.offsetSeconds - EXPECTED_OFFSET) <= 0.03;
    if (!okStatus || !okOffset) throw new Error("expected a match at " + EXPECTED_OFFSET + " s, got " + result.status + " at " + result.offsetSeconds + " s");

    /* Second run must come from the cache (no decoding). */
    const again = await fetch("http://127.0.0.1:" + PORT + "/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ side: sideMp4, fronts: [frontMp4] }) });
    const second = (await again.json()).jobId;
    for (;;) {
      await delay(200);
      job = await (await fetch("http://127.0.0.1:" + PORT + "/job/" + second)).json();
      if (job.state !== "running") break;
    }
    if (job.state !== "done" || Math.abs(job.results[0].offsetSeconds - EXPECTED_OFFSET) > 0.03) throw new Error("cached run disagrees");
    console.log("Self-test passed: offset " + result.offsetSeconds.toFixed(3) + " s (expected " + EXPECTED_OFFSET + "), correlation " + result.score.toFixed(2) + ", z " + result.z.toFixed(1) + ".");
  } finally {
    helper.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Self-test FAILED: " + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
