/*
 * LazyEditMirror audio engine ("the helper").
 *
 * A local HTTP server (127.0.0.1 only) that measures the time offset between
 * camera files by their audio. The panel (helper.js) sends one side file and
 * the front files; this program decodes each file's audio with ffmpeg into
 * an 8 kHz mono stream, turns it into a loudness envelope (audio.js), caches
 * that envelope on disk, and cross-correlates the pairs.
 *
 * Normally started by the installer's launcher (launch-hidden.vbs, no
 * window, at login and through the lazyeditmirror: URL scheme when the panel
 * needs it). It exits by itself after a few idle hours, keeps a log file, and
 * quietly steps aside when another instance already owns the port.
 *
 *   node helper/sync-helper.mjs           (visible, for development)
 *
 * Needs ffmpeg on the PATH (or LAZYEDITMIRROR_FFMPEG=<path to ffmpeg.exe>).
 * Port: LAZYEDITMIRROR_HELPER_PORT (default 5182).
 * Cache and log: %LOCALAPPDATA%\LazyEditMirror (LAZYEDITMIRROR_HOME overrides).
 *
 * Endpoints
 *   GET  /health          -> { ok, version, ffmpeg, cacheDir, uptime }  (?keepalive=1 resets the idle timer)
 *   POST /match           { side, fronts: [..] } -> { jobId }
 *   GET  /job/<id>        -> { state, progress: { message, done, total }, results, error }
 *   POST /quit            -> stops the engine
 */
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const audio = require("./audio.js");

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  for (const candidate of [join(here, "manifest.json"), join(here, "..", "manifest.json")]) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8")).version;
    } catch (e) {
      /* try the next one */
    }
  }
  return "unknown";
})();
const PORT = Number(process.env.LAZYEDITMIRROR_HELPER_PORT) || 5182;
const FFMPEG = process.env.LAZYEDITMIRROR_FFMPEG || "ffmpeg";
const HOME = process.env.LAZYEDITMIRROR_HOME || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "LazyEditMirror");
const CACHE_DIR = process.env.LAZYEDITMIRROR_CACHE || join(HOME, "cache");
const LOG_FILE = join(HOME, "engine.log");
const HIDDEN = process.argv.includes("--hidden");
const IDLE_EXIT_MS = (Number(process.env.LAZYEDITMIRROR_IDLE_HOURS) || 3) * 3600 * 1000;

const envelopes = new Map(); // cache key -> { envelope, seconds, path }
const jobs = new Map();
let ffmpegVersion = null;
let lastActivity = Date.now();
const startedAt = Date.now();

function stamp() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function log(message) {
  const line = "[" + stamp() + "] " + message;
  if (!HIDDEN) console.log(line);
  try {
    mkdirSync(HOME, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1024 * 1024) writeFileSync(LOG_FILE, "");
    appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {
    /* logging must never break the engine */
  }
}

function touch() {
  lastActivity = Date.now();
}

/** ffmpeg -version, first line, or null when ffmpeg cannot be started. */
function probeFfmpeg() {
  return new Promise((resolveProbe) => {
    let out = "";
    let child;
    try {
      child = spawn(FFMPEG, ["-version"], { windowsHide: true });
    } catch (e) {
      resolveProbe(null);
      return;
    }
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolveProbe(null));
    child.on("close", (code) => resolveProbe(code === 0 ? out.split(/\r?\n/)[0] : null));
  });
}

/** Mono float PCM at audio.PCM_RATE, decoded by ffmpeg. */
function decode(path) {
  return new Promise((resolveDecode, reject) => {
    const args = ["-v", "error", "-nostdin", "-i", path, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", String(audio.PCM_RATE), "-f", "f32le", "pipe:1"];
    const chunks = [];
    let stderr = "";
    let child;
    try {
      child = spawn(FFMPEG, args, { windowsHide: true });
    } catch (e) {
      reject(new Error("Could not start ffmpeg: " + e.message));
      return;
    }
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (e) => reject(new Error("Could not start ffmpeg (" + FFMPEG + "): " + e.message)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("ffmpeg could not read the audio of " + basename(path) + ": " + (stderr.trim() || "exit code " + code)));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const floats = new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length - (buffer.length % 4)));
      resolveDecode(floats);
    });
  });
}

function cacheKey(path) {
  const stats = statSync(path);
  return createHash("sha1").update(path.toLowerCase() + "|" + stats.size + "|" + Math.round(stats.mtimeMs)).digest("hex");
}

async function envelopeFor(path, onProgress) {
  const key = cacheKey(path);
  if (envelopes.has(key)) return envelopes.get(key);

  const binFile = join(CACHE_DIR, key + ".f32");
  const metaFile = join(CACHE_DIR, key + ".json");
  if (existsSync(binFile) && existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8"));
      const raw = readFileSync(binFile);
      const envelope = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
      if (meta.frameHz === audio.FRAME_HZ && envelope.length === meta.frames) {
        const entry = { envelope: envelope, seconds: meta.seconds, path: path };
        envelopes.set(key, entry);
        log("Cached envelope: " + basename(path) + " (" + meta.seconds.toFixed(1) + " s)");
        return entry;
      }
    } catch (e) {
      /* fall through and decode again */
    }
  }

  onProgress("Listening to " + basename(path) + " (first time takes a moment)...");
  const started = Date.now();
  const pcm = await decode(path);
  const seconds = pcm.length / audio.PCM_RATE;
  if (seconds < 1) throw new Error(basename(path) + " has less than a second of audio.");
  const envelope = audio.envelopeFromPcm(pcm, audio.PCM_RATE);
  log("Decoded " + basename(path) + ": " + seconds.toFixed(1) + " s of audio in " + ((Date.now() - started) / 1000).toFixed(1) + " s");

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(binFile, Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength));
    writeFileSync(metaFile, JSON.stringify({ path: path, seconds: seconds, frameHz: audio.FRAME_HZ, frames: envelope.length, version: VERSION }));
  } catch (e) {
    log("Could not write the cache: " + e.message);
  }

  const entry = { envelope: envelope, seconds: seconds, path: path };
  envelopes.set(key, entry);
  return entry;
}

async function runJob(job) {
  const setProgress = (message) => {
    job.progress.message = message;
    touch();
  };
  try {
    const unique = [job.side].concat(job.fronts.filter((f) => f.toLowerCase() !== job.side.toLowerCase()));
    job.progress.total = unique.length + job.fronts.length;
    job.progress.done = 0;

    const side = await envelopeFor(job.side, setProgress);
    job.progress.done += 1;

    for (const front of job.fronts) {
      const result = { front: front, status: "none", offsetSeconds: 0, score: 0, z: 0, prominence: 0, overlapSeconds: 0, frontSeconds: 0, sideSeconds: side.seconds };
      try {
        const frontEnvelope = await envelopeFor(front, setProgress);
        job.progress.done += 1;
        setProgress("Comparing " + basename(job.side) + " with " + basename(front) + "...");
        const found = audio.findOffset(frontEnvelope.envelope, side.envelope);
        Object.assign(result, found, { frontSeconds: frontEnvelope.seconds });
        log(
          basename(job.side) + " vs " + basename(front) + ": " + found.status + " (offset " + found.offsetSeconds.toFixed(3) + " s, correlation " +
            found.score.toFixed(3) + ", z " + found.z.toFixed(1) + ", prominence " + found.prominence.toFixed(2) + ", overlap " + found.overlapSeconds.toFixed(1) + " s)"
        );
      } catch (error) {
        result.status = "error";
        result.error = error.message;
        log(basename(front) + ": " + error.message);
      }
      job.progress.done += 1;
      job.results.push(result);
    }
    job.state = "done";
    job.progress.message = "Done.";
  } catch (error) {
    job.state = "error";
    job.error = error.message;
    log("Job failed: " + error.message);
  }
  touch();
}

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error("request too large"));
    });
    request.on("end", () => resolveBody(data));
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "OPTIONS") {
      send(response, 204, {});
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      if (url.searchParams.get("keepalive")) touch();
      send(response, 200, { ok: true, version: VERSION, ffmpeg: ffmpegVersion, cacheDir: CACHE_DIR, uptime: Math.round((Date.now() - startedAt) / 1000), hidden: HIDDEN });
      return;
    }
    if (request.method === "POST" && url.pathname === "/quit") {
      send(response, 200, { ok: true });
      log("Quit requested.");
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (request.method === "POST" && url.pathname === "/match") {
      touch();
      const body = JSON.parse((await readBody(request)) || "{}");
      const side = String(body.side || "");
      const fronts = Array.isArray(body.fronts) ? body.fronts.map(String) : [];
      if (!side || !fronts.length) {
        send(response, 400, { error: "side and fronts are required" });
        return;
      }
      const missing = [side].concat(fronts).filter((p) => !existsSync(p));
      if (missing.length) {
        send(response, 400, { error: "file not found: " + missing.join(", ") });
        return;
      }
      if (!ffmpegVersion) ffmpegVersion = await probeFfmpeg();
      if (!ffmpegVersion) {
        send(response, 503, { error: "ffmpeg was not found. Install it (winget install Gyan.FFmpeg) or set LAZYEDITMIRROR_FFMPEG." });
        return;
      }
      const job = { id: randomBytes(8).toString("hex"), state: "running", side: side, fronts: fronts, progress: { message: "Starting...", done: 0, total: 0 }, results: [], error: null };
      jobs.set(job.id, job);
      log("Job " + job.id + ": " + basename(side) + " vs " + fronts.map((f) => basename(f)).join(", "));
      runJob(job);
      send(response, 202, { jobId: job.id });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/job/")) {
      const job = jobs.get(decodeURIComponent(url.pathname.slice(5)));
      if (!job) {
        send(response, 404, { error: "unknown job" });
        return;
      }
      send(response, 200, { state: job.state, progress: job.progress, results: job.results, error: job.error });
      return;
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    send(response, 500, { error: error.message });
  }
});

/** Another engine already on the port? Then this one is not needed. */
function someoneElseIsListening() {
  return new Promise((resolveCheck) => {
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path: "/health", method: "GET", timeout: 1500 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolveCheck(/"ok":true/.test(data)));
    });
    req.on("error", () => resolveCheck(false));
    req.on("timeout", () => {
      req.destroy();
      resolveCheck(false);
    });
    req.end();
  });
}

server.on("error", async (error) => {
  if (error && error.code === "EADDRINUSE" && (await someoneElseIsListening())) {
    log("Another engine is already running on port " + PORT + "; exiting.");
    process.exit(0);
  }
  log("Could not listen on port " + PORT + ": " + error.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", async () => {
  ffmpegVersion = await probeFfmpeg();
  log("LazyEditMirror audio engine " + VERSION + " listening on http://127.0.0.1:" + PORT + (HIDDEN ? " (hidden)" : ""));
  log(ffmpegVersion ? "ffmpeg: " + ffmpegVersion : "ffmpeg NOT FOUND. Install it: winget install Gyan.FFmpeg (then restart the engine).");
  log("Envelope cache: " + CACHE_DIR);
  if (!HIDDEN) log("Keep this window open while you use the panel. Press Ctrl+C to stop.");
  setInterval(() => {
    if (Date.now() - lastActivity > IDLE_EXIT_MS && ![...jobs.values()].some((j) => j.state === "running")) {
      log("Idle for " + Math.round(IDLE_EXIT_MS / 3600000) + " h; exiting.");
      process.exit(0);
    }
  }, 60 * 1000).unref();
});
