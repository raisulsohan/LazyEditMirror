/*
 * LazyEditMirror - client for the audio helper (helper/sync-helper.mjs).
 *
 * The helper is a small local HTTP server the user starts once (the panel's
 * "Start helper" button, or helper/start-helper.bat). The panel asks it for the audio offset
 * between one side file and every front file; the helper decodes the audio
 * with ffmpeg and answers through a job the panel polls, so the panel can
 * show progress while big camera files are being read.
 */
"use strict";

function createAudioClient(options) {
  const opts = options || {};
  const baseUrl = String(opts.baseUrl || "http://127.0.0.1:5182").replace(/\/$/, "");
  const fetchImpl = opts.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const pollMs = opts.pollMs || 700;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const START_HINT =
    "The audio engine is not running. Installed with the LazyEditMirror installer, it starts by itself; otherwise open Advanced options, " +
    "click Open engine folder and double-click start-helper.bat (keep its window open), then try again.";

  /** { ok, version, ffmpeg } or null when the engine is not reachable. `keepalive` resets its idle timer. */
  async function health(keepalive) {
    if (!fetchImpl) return null;
    try {
      const response = await fetchImpl(baseUrl + "/health" + (keepalive ? "?keepalive=1" : ""));
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      return null;
    }
  }

  /**
   * Offsets of `sidePath` against each of `frontPaths`:
   * [{ front, status: "match"|"weak"|"none"|"error", offsetSeconds, score, z, prominence, overlapSeconds, error? }]
   */
  async function match(sidePath, frontPaths, onProgress) {
    if (!fetchImpl) throw new Error("This UXP build has no fetch(); the audio helper cannot be reached.");
    let response;
    try {
      response = await fetchImpl(baseUrl + "/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side: sidePath, fronts: frontPaths }),
      });
    } catch (e) {
      throw new Error(START_HINT);
    }
    if (!response.ok) {
      let text = "";
      try {
        text = await response.text();
      } catch (e) {
        text = "";
      }
      throw new Error("The audio helper refused the request: " + (text || response.status));
    }
    const started = await response.json();
    const jobId = started.jobId;
    for (;;) {
      await delay(pollMs);
      let job;
      try {
        const poll = await fetchImpl(baseUrl + "/job/" + encodeURIComponent(jobId));
        job = await poll.json();
      } catch (e) {
        throw new Error("Lost the audio helper while it was working. " + START_HINT);
      }
      if (onProgress && job.progress && job.progress.message) onProgress(job.progress.message);
      if (job.state === "done") return job.results || [];
      if (job.state === "error") throw new Error("The audio helper failed: " + (job.error || "unknown error"));
    }
  }

  return { baseUrl: baseUrl, health: health, match: match, START_HINT: START_HINT };
}

module.exports = { createAudioClient: createAudioClient };
