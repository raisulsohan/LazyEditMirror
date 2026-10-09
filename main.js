/*
 * LazyEditMirror - panel wiring (UXP).
 *
 * Only DOM work lives here. Reading and editing the sequence is premiere.js
 * (adapter) and sync.js (engine); the maths is plan.js; the audio engine is
 * reached through helper.js.
 *
 * The audio engine is started by the panel itself: the installer registers
 * the lazyeditmirror: URL scheme, and opening it launches the engine in the
 * background (helper/launch-hidden.vbs). The user never has to start anything.
 */
"use strict";

const ppro = require("premierepro");
const uxp = require("uxp");
const plan = require("./plan.js");
const { createAdapter } = require("./premiere.js");
const { createEngine } = require("./sync.js");
const { createLog } = require("./log.js");
const { createAudioClient } = require("./helper.js");

const VERSION = "1.1.2";
const LOG_FILE = "LazyEditMirror-log.txt";
const ENGINE_URL = "http://127.0.0.1:5182";
const ENGINE_LAUNCH_URL = "lazyeditmirror:start";
const AUTHOR_URL = "https://raisulsohan.com";
const KEEPALIVE_MS = 5 * 60 * 1000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const el = (id) => document.getElementById(id);
const masterSelect = el("master-track");
const targetSelect = el("target-track");
const footageSelect = el("target-footage");
const footageHint = el("footage-hint");
const refreshButton = el("refresh-button");
const advancedToggle = el("advanced-toggle");
const advancedBox = el("advanced");
const modeSelect = el("sync-mode");
const modeHint = el("mode-hint");
const offsetInput = el("offset");
const enginePill = el("engine-pill");
const engineText = el("engine-text");
const engineStartButton = el("engine-start-button");
const engineFolderButton = el("engine-folder-button");
const engineHint = el("engine-hint");
const analyzeButton = el("analyze-button");
const syncButton = el("sync-button");
const progressBox = el("progress");
const progressBar = el("progress-bar");
const statusElement = el("status");
const resultCard = el("result");
const resultTitle = el("result-title");
const resultFiles = el("result-files");
const resultTotals = el("result-totals");
const resultNotes = el("result-notes");
const logToggle = el("log-toggle");
const logBody = el("log-body");
const logArea = el("log");
const logPathElement = el("log-path");
const copyLogButton = el("copy-log-button");
const saveLogButton = el("save-log-button");
const authorLink = el("author-link");
const clearLogButton = el("clear-log-button");
const versionElement = el("version");

const log = createLog(logArea);
const adapter = createAdapter(ppro);
const audioClient = createAudioClient({ baseUrl: ENGINE_URL });
const engine = createEngine({
  adapter: adapter,
  plan: plan,
  log: log,
  audio: audioClient,
  onProgress: (message, done, total) => setProgress(message, done, total),
});

const MODE_HINTS = {
  audio: "The audio engine listens to the side file and to every front file on the Master track and finds the offsets itself.",
  selection:
    "Put the side clip on a free video track, select it together with the Master clip it is in sync with (select both, right-click > Synchronize > Audio), keep them selected, then Analyze. Covers that front file; the side clip is consumed.",
  timecode: "Every file must carry matching (jam-synced) source timecode.",
  offset: "Select one Master clip of the front file this offset belongs to, and enter how many seconds later (+) or earlier (-) the same moment is in the side file.",
};

const state = {
  busy: false,
  projectClips: [],
  analysis: null,
  confirmTimer: null,
  engine: "unknown", // unknown | ok | starting | off | missing
  engineStarting: null, // promise while a start is in flight
  pulse: null,
  targetLabel: "",
};

/* ---------- small UI helpers ---------- */

function setStatus(message, kind) {
  statusElement.textContent = message;
  statusElement.className = "status" + (kind ? " status--" + kind : "");
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function show(node, visible) {
  const classes = node.className.split(/\s+/).filter((c) => c && c !== "hint--hidden");
  if (!visible) classes.push("hint--hidden");
  node.className = classes.join(" ");
}

/* Buttons are <div>s, so "disabled" is a class and a check in every handler. */
function setDisabled(node, disabled) {
  const classes = node.className.split(/\s+/).filter((c) => c && c !== "btn--disabled");
  if (disabled) classes.push("btn--disabled");
  node.className = classes.join(" ");
}

function isDisabled(node) {
  return /(^|\s)btn--disabled(\s|$)/.test(node.className);
}

/** Swap the variant class of a button while keeping its disabled state. */
function setVariant(node, variant) {
  const disabled = isDisabled(node);
  node.className = "btn " + variant;
  setDisabled(node, disabled);
}

function onClick(node, handler) {
  node.addEventListener("click", () => {
    if (!isDisabled(node)) handler();
  });
}

function setProgress(message, done, total) {
  if (message) setStatus(message, null);
  show(progressBox, true);
  if (state.pulse) {
    clearInterval(state.pulse);
    state.pulse = null;
  }
  if (typeof total === "number" && total > 0 && typeof done === "number") {
    progressBar.style.width = Math.round((Math.min(done, total) / total) * 100) + "%";
    progressBar.style.marginLeft = "0";
  } else {
    /* Indeterminate: a short bar sweeping left to right. */
    let position = 0;
    progressBar.style.width = "28%";
    state.pulse = setInterval(() => {
      position = (position + 4) % 100;
      progressBar.style.marginLeft = Math.min(position, 72) + "%";
    }, 60);
  }
}

function hideProgress() {
  if (state.pulse) {
    clearInterval(state.pulse);
    state.pulse = null;
  }
  progressBar.style.width = "0";
  progressBar.style.marginLeft = "0";
  show(progressBox, false);
}

function fillSelect(select, options, preferredValue, fallbackIndex) {
  const previous = select.value;
  clearChildren(select);
  for (const option of options) {
    const node = document.createElement("option");
    node.value = String(option.value);
    node.textContent = option.text;
    select.appendChild(node);
  }
  const wanted = preferredValue != null && options.some((o) => String(o.value) === String(preferredValue)) ? String(preferredValue) : null;
  const kept = options.some((o) => String(o.value) === previous) ? previous : null;
  if (wanted) select.value = wanted;
  else if (kept) select.value = kept;
  else if (options.length) select.value = String(options[Math.min(fallbackIndex || 0, options.length - 1)].value);
}

function setBusy(busy) {
  state.busy = busy;
  for (const node of [masterSelect, targetSelect, modeSelect, offsetInput]) node.disabled = busy;
  footageSelect.disabled = busy || modeSelect.value === "selection";
  for (const node of [refreshButton, analyzeButton, engineFolderButton]) setDisabled(node, busy);
  setDisabled(engineStartButton, busy || state.engine === "ok" || state.engine === "starting");
  setDisabled(syncButton, busy || !state.analysis);
  if (!busy) hideProgress();
}

function resetConfirm() {
  if (state.confirmTimer) clearTimeout(state.confirmTimer);
  state.confirmTimer = null;
  setVariant(syncButton, "btn--accent");
  syncButton.textContent = state.analysis ? "Sync " + state.analysis.plan.placements.length + " clips" : "Sync";
}

function invalidate() {
  state.analysis = null;
  setDisabled(syncButton, true);
  resetConfirm();
}

function updateModeHint() {
  modeHint.textContent = MODE_HINTS[modeSelect.value] || "";
  const fromSelection = modeSelect.value === "selection";
  footageSelect.disabled = state.busy || fromSelection;
  footageHint.textContent = fromSelection ? "The side footage is taken from the selected side clip." : "One pass per side-camera file. Front files are listed last.";
  if (modeSelect.value === "audio") ensureEngine(false);
  else setEngine("manual", "Manual sync");
}

function readParams() {
  return {
    masterIndex: Number(masterSelect.value),
    targetIndex: Number(targetSelect.value),
    targetClipId: footageSelect.value,
    mode: modeSelect.value,
    offsetSeconds: Number(String(offsetInput.value).trim().replace(",", ".") || "0"),
    projectClips: state.projectClips,
  };
}

/* ---------- the audio engine ---------- */

function setEngine(stateName, text) {
  state.engine = stateName;
  enginePill.className = "pill pill--" + (stateName === "manual" ? "idle" : stateName);
  engineText.textContent = text;
  setDisabled(engineStartButton, state.busy || stateName === "ok" || stateName === "starting");
}

function isMac() {
  try {
    return require("os").platform() === "darwin";
  } catch (e) {
    return false;
  }
}

/**
 * Did the installer put the engine in place (and register the launcher)?
 * true / false, or null when the file system would not say.
 */
async function engineInstalled() {
  let path = "";
  try {
    const home = require("os").homedir();
    path = isMac()
      ? home + "/Library/Application Support/LazyEditMirror/engine/installed.json"
      : home + "\\AppData\\Local\\LazyEditMirror\\engine\\installed.json";
  } catch (e) {
    return null;
  }
  const missing = (error) => !!error && (error.code === "ENOENT" || /no such file|not found|does not exist|ENOENT/i.test(String(error.message || error)));
  try {
    const fs = require("fs");
    if (fs && typeof fs.lstatSync === "function") {
      fs.lstatSync(path);
      return true;
    }
    if (fs && typeof fs.lstat === "function") {
      await fs.lstat(path);
      return true;
    }
  } catch (error) {
    if (missing(error)) return false;
  }
  try {
    const entry = await uxp.storage.localFileSystem.getEntryWithUrl("file:///" + path.replace(/\\/g, "/").replace(/^\/+/, ""));
    return !!entry;
  } catch (error) {
    return missing(error) ? false : null;
  }
}

/**
 * Make sure the engine answers; start it when it does not. Returns true when
 * it is ready. `loud` writes the outcome to the status line.
 */
async function ensureEngine(loud) {
  if (state.engineStarting) return state.engineStarting;
  state.engineStarting = (async () => {
    const health = await audioClient.health(true);
    if (health && health.ffmpeg) {
      setEngine("ok", "Audio engine ready");
      engineHint.textContent = "Running: " + String(health.ffmpeg).replace(/ Copyright.*$/, "") + ".";
      return true;
    }
    if (health && !health.ffmpeg) {
      setEngine("off", "ffmpeg missing");
      engineHint.textContent = "The engine runs but ffmpeg is not installed. Run: winget install Gyan.FFmpeg, then click Start audio engine.";
      if (loud) setStatus("The audio engine cannot find ffmpeg. Install it (winget install Gyan.FFmpeg) and try again.", "error");
      return false;
    }
    if (isMac()) {
      setEngine("off", "Audio engine off");
      engineHint.textContent = "On macOS start the engine by hand: open start-helper.command in the engine folder and keep its window open.";
      if (loud) setStatus("Start the audio engine (Advanced options > Open engine folder > start-helper.command), then Analyze again.", "warn");
      return false;
    }
    const installed = await engineInstalled();
    if (installed === false) {
      setEngine("missing", "Audio engine not installed");
      engineHint.textContent = "Run \"Install LazyEditMirror - Windows.bat\" from the download, which installs the engine for this user. Or open the engine folder and double-click start-helper.bat.";
      if (loud) setStatus("The audio engine is not installed. Run the LazyEditMirror installer once (it sets the engine up), or start it from Advanced options.", "error");
      return false;
    }
    if (installed === null) log.warn("Could not check whether the engine is installed; trying to start it anyway.");
    setEngine("starting", "Starting audio engine");
    engineHint.textContent = "";
    log.info("Starting the audio engine (" + ENGINE_LAUNCH_URL + ").");
    let launchError = "";
    try {
      const result = await uxp.shell.openExternal(ENGINE_LAUNCH_URL, "LazyEditMirror starts its audio engine in the background (no window opens). It installs nothing without asking you.");
      if (result) launchError = String(result);
    } catch (error) {
      launchError = (error && error.message) || String(error);
    }
    if (launchError) {
      setEngine("off", "Audio engine off");
      engineHint.textContent = "Could not launch it: " + launchError + ". Open the engine folder and double-click start-helper.bat.";
      log.error("Could not launch the engine: " + launchError);
      if (loud) setStatus("Could not start the audio engine (" + launchError + "). Use Advanced options > Open engine folder > start-helper.bat.", "error");
      return false;
    }
    for (let i = 0; i < 40; i += 1) {
      await delay(750);
      const again = await audioClient.health(true);
      if (again && again.ffmpeg) {
        setEngine("ok", "Audio engine ready");
        engineHint.textContent = "Running: " + String(again.ffmpeg).replace(/ Copyright.*$/, "") + ".";
        log.info("Audio engine is up.");
        return true;
      }
      if (again && !again.ffmpeg) break;
    }
    setEngine("off", "Audio engine off");
    engineHint.textContent = "The engine did not answer. If a window asked to install Node.js or ffmpeg, finish that and click Start audio engine.";
    log.warn("The audio engine did not answer after launch.");
    if (loud) setStatus("The audio engine did not start. If a window asked to install Node.js or ffmpeg, finish that, then try again.", "error");
    return false;
  })();
  try {
    return await state.engineStarting;
  } finally {
    state.engineStarting = null;
  }
}

async function openEngineFolder() {
  try {
    const folder = await uxp.storage.localFileSystem.getPluginFolder();
    const path = folder.nativePath + (isMac() ? "/helper" : "\\helper");
    const result = await uxp.shell.openPath(path, "Opens the folder with LazyEditMirror's audio engine files.");
    if (result) throw new Error(String(result));
    setStatus("Engine folder opened. Double-click start-helper" + (isMac() ? ".command" : ".bat") + " there and keep its window open.", null);
  } catch (error) {
    setStatus("Could not open the folder: " + ((error && error.message) || error), "error");
  }
}

async function openAuthorSite() {
  try {
    const result = await uxp.shell.openExternal(AUTHOR_URL, "Opens Raisul Sohan's website in your browser.");
    if (result) throw new Error(String(result));
  } catch (error) {
    setStatus("Could not open the browser (" + ((error && error.message) || error) + "). The site is " + AUTHOR_URL + ".", "warn");
  }
}

/* ---------- log persistence ---------- */

async function persistLog() {
  try {
    const fs = uxp.storage.localFileSystem;
    const folder = await fs.getDataFolder();
    const file = await folder.createFile(LOG_FILE, { overwrite: true });
    await file.write(log.text(), { format: uxp.storage.formats.utf8 });
    if (folder.nativePath) logPathElement.textContent = "Log file: " + folder.nativePath + (isMac() ? "/" : "\\") + LOG_FILE;
  } catch (error) {
    logPathElement.textContent = "Log file could not be written: " + ((error && error.message) || error);
  }
}

async function saveLogAs() {
  try {
    const fs = uxp.storage.localFileSystem;
    const file = await fs.getFileForSaving(LOG_FILE, { types: ["txt"] });
    if (!file) return;
    await file.write(log.text(), { format: uxp.storage.formats.utf8 });
    setStatus("Log saved to " + (file.nativePath || file.name) + ".", "ok");
  } catch (error) {
    setStatus("Could not save the log: " + ((error && error.message) || error), "error");
  }
}

async function copyLog() {
  const text = log.text();
  try {
    if (navigator.clipboard && typeof navigator.clipboard.setContent === "function") {
      await navigator.clipboard.setContent({ "text/plain": text });
    } else if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("no clipboard API");
    }
    setStatus("Log copied to the clipboard.", "ok");
  } catch (error) {
    setStatus("Clipboard failed (" + ((error && error.message) || error) + "). Use Save..., or open the log file named under the log.", "warn");
  }
}

/* ---------- result card ---------- */

function sign(seconds) {
  return (seconds >= 0 ? "+" : "-") + Math.abs(seconds).toFixed(3) + " s";
}

function fileRow(file, synced) {
  const row = document.createElement("div");
  let kind = "wait";
  let sub = "";
  let count = "";
  const placedNow = synced ? file.placed : 0;
  if (file.status === "done" || (synced && file.placed && file.remaining === 0)) {
    kind = "done";
    sub = synced && placedNow ? "placed in this pass" : "already on the side track";
    count = file.total + " done";
  } else if (file.status === "match") {
    kind = "ok";
    sub = "side = front " + sign(file.offsetSeconds || 0) + (file.score != null ? " (correlation " + file.score.toFixed(2) + ")" : "");
    count = synced ? file.placed + " placed" : file.placed + " to place";
    if (file.outOfRange) count += ", " + file.outOfRange + " outside";
    if (file.already) count += ", " + file.already + " done";
  } else if (file.status === "weak") {
    sub = "weak match, not used (sync by hand if they do overlap)";
    count = file.remaining + " waiting";
  } else if (file.status === "error") {
    kind = "bad";
    sub = "audio could not be read" + (file.note ? ": " + file.note : "");
    count = file.remaining + " waiting";
  } else {
    sub = "no match in this side file";
    count = file.remaining + " waiting";
  }
  if (file.unsupported) count += ", " + file.unsupported + " skipped";
  row.className = "file-row file-row--" + kind;
  const dot = document.createElement("span");
  dot.className = "file-dot";
  const main = document.createElement("div");
  main.className = "file-main";
  const name = document.createElement("div");
  name.className = "file-name";
  name.textContent = file.name;
  const subNode = document.createElement("div");
  subNode.className = "file-sub";
  subNode.textContent = sub;
  main.appendChild(name);
  main.appendChild(subNode);
  const countNode = document.createElement("span");
  countNode.className = "file-count";
  countNode.textContent = count;
  row.appendChild(dot);
  row.appendChild(main);
  row.appendChild(countNode);
  return row;
}

function renderReport(report, syncResult) {
  clearChildren(resultFiles);
  resultTotals.className = "result-totals";
  const synced = !!syncResult;
  resultTitle.textContent = synced ? "Done: " + report.side.name : "Plan for " + report.side.name;
  for (const file of report.files) {
    if (file.status === "side") continue;
    resultFiles.appendChild(fileRow(file, synced));
  }
  const t = report.totals;
  if (synced) {
    const verified = syncResult.verification.ok ? "verified" : "check the log";
    resultTotals.textContent =
      "Placed " + syncResult.placed + " clip" + (syncResult.placed === 1 ? "" : "s") + " (" + verified + "). " +
      (syncResult.remaining
        ? syncResult.remaining + " front clip" + (syncResult.remaining === 1 ? "" : "s") + " still waiting: " +
          syncResult.remainingByFile.map((f) => f.name + " " + f.remaining).join(", ") + ". Pick the next side file."
        : "Every front clip is covered.");
  } else {
    const parts = [t.placed + " clip" + (t.placed === 1 ? "" : "s") + " to place (" + t.pictureSeconds.toFixed(1) + " s)"];
    if (t.already) parts.push(t.already + " done");
    if (t.remaining) parts.push(t.remaining + " waiting");
    resultTotals.textContent = parts.join(" · ") + ". Master: " + t.clips + " clips from " + t.files + " file" + (t.files === 1 ? "" : "s") + ", " + t.cuts + " cuts, " + t.gaps + " gaps.";
  }
  const notes = [];
  if (report.reference && !synced) {
    notes.push("The side clip on " + report.reference.trackLabel + (report.reference.audioTrackLabels.length ? " (with its audio)" : "") + " is replaced by the pieces.");
  }
  if (report.parking && !synced) notes.push("Side audio is parked on " + report.parking + " for a moment and removed.");
  if (t.extraOffsetSeconds) notes.push("Extra offset " + sign(t.extraOffsetSeconds) + " applied.");
  if (syncResult && syncResult.leftoverAudio) notes.push(syncResult.leftoverAudio + " audio clip(s) remain on the parking track; delete them by hand.");
  notes.push(...report.warnings);
  resultNotes.textContent = notes.join(" ");
  resultCard.className = "card result" + (synced ? (syncResult.verification.ok && !syncResult.leftoverAudio ? " result--ok" : " result--warn") : "");
  show(resultCard, true);
}

function renderError(message) {
  clearChildren(resultFiles);
  resultTitle.textContent = "Could not analyze";
  resultTotals.className = "result-totals result-totals--error";
  resultTotals.textContent = message.split("\n").join(" ");
  resultNotes.textContent = "";
  resultCard.className = "card result result--error";
  show(resultCard, true);
}

/* ---------- the three actions ---------- */

async function refresh(quiet) {
  if (state.busy) return;
  setBusy(true);
  invalidate();
  try {
    const ctx = await adapter.getContext();
    const tracks = await adapter.listTracks(ctx.sequence, "video");
    const trackOptions = tracks.map((t) => ({ value: t.index, text: t.label + " (" + (t.clipCount ? t.clipCount + " clip" + (t.clipCount === 1 ? "" : "s") : "empty") + ")" }));
    fillSelect(masterSelect, trackOptions, null, 0);
    fillSelect(targetSelect, trackOptions, null, 1);

    state.projectClips = await adapter.listProjectClips(ctx.project, log);

    /* Files cut on the Master track are front files: list them last, marked,
       so the side recording is easy to tell apart. Files sharing a bin with
       them are probably more front footage and come just before. Offline
       items go last. */
    const masterTrack = tracks.find((t) => t.index === Number(masterSelect.value));
    const frontKeys = {};
    if (masterTrack) {
      const masterItems = await adapter.readTrackItemsLight(masterTrack.track, true);
      for (const item of masterItems) if (item.mediaKey) frontKeys[item.mediaKey] = true;
    }
    const frontBins = {};
    for (const c of state.projectClips) if (frontKeys[c.mediaKey]) frontBins[c.binPath || ""] = true;
    const masterLabel = masterTrack ? masterTrack.label : "the Master track";
    const describe = (c) => {
      const tags = [];
      if (frontKeys[c.mediaKey]) tags.push("front, on " + masterLabel);
      if (c.isOffline) tags.push("offline");
      return (c.binPath ? c.binPath : "") + c.name + (tags.length ? "  (" + tags.join(", ") + ")" : "");
    };
    const allBins = {};
    for (const c of state.projectClips) allBins[c.binPath || ""] = true;
    const otherBinsExist = Object.keys(allBins).length > Object.keys(frontBins).length;
    const rank = (c) => (c.isOffline ? 4 : 0) + (frontKeys[c.mediaKey] ? 2 : otherBinsExist && frontBins[c.binPath || ""] ? 1 : 0);
    const ordered = state.projectClips.slice().sort((a, b) => rank(a) - rank(b) || describe(a).localeCompare(describe(b)));
    fillSelect(
      footageSelect,
      ordered.map((c) => ({ value: c.id, text: describe(c) })),
      null,
      0
    );
    let preferred = null;
    const targetTrack = tracks.find((t) => t.index === Number(targetSelect.value));
    if (targetTrack) preferred = await adapter.firstProjectItemId(targetTrack.track);
    if (!preferred) {
      const candidate = ordered.find((c) => rank(c) === 0);
      preferred = candidate ? candidate.id : null;
    }
    if (preferred && ordered.some((c) => c.id === preferred)) footageSelect.value = preferred;

    if (!quiet) {
      log.info('Read sequence "' + ctx.sequenceName + '": ' + tracks.length + " video tracks, " + state.projectClips.length + " media clips in the project.");
      setStatus("Pick the side footage and click Analyze.", null);
    }
  } catch (error) {
    const message = (error && error.message) || String(error);
    log.error(message);
    setStatus(message, "error");
  } finally {
    setBusy(false);
    persistLog();
  }
  if (modeSelect.value === "audio") ensureEngine(false);
}

async function analyze() {
  if (state.busy) return;
  setBusy(true);
  invalidate();
  show(resultCard, false);
  try {
    if (modeSelect.value === "audio") {
      setProgress("Checking the audio engine...", null, null);
      const ready = await ensureEngine(true);
      if (!ready) return;
    }
    setProgress("Reading the sequence...", null, null);
    const analysis = await engine.analyze(readParams());
    state.analysis = analysis;
    renderReport(analysis.report, null);
    resetConfirm();
    setDisabled(syncButton, false);
    setStatus("Ready: " + analysis.plan.placements.length + " clips to place on " + analysis.target.label + ". Click Sync.", "ok");
  } catch (error) {
    const message = (error && error.message) || String(error);
    log.error(message.replace(/\n/g, " | "));
    renderError(message);
    setStatus("Analysis stopped. See the details above.", "error");
  } finally {
    setBusy(false);
    persistLog();
  }
}

async function sync() {
  if (state.busy || !state.analysis) return;

  /* Two clicks: the first arms the button, the second (within 8 s) runs. */
  if (!state.confirmTimer) {
    syncButton.textContent = "Confirm: place " + state.analysis.plan.placements.length + " clips";
    setVariant(syncButton, "btn--danger");
    setStatus("Click again to place the clips on " + state.analysis.target.label + ". Every step is undoable.", "warn");
    state.confirmTimer = setTimeout(resetConfirm, 8000);
    return;
  }
  resetConfirm();

  setBusy(true);
  try {
    setProgress("Re-reading the sequence...", null, null);
    const before = state.analysis;
    const analysis = await engine.analyze(Object.assign({}, before.params, { projectClips: state.projectClips }));
    if (analysis.plan.placements.length !== before.plan.placements.length) {
      state.analysis = analysis;
      renderReport(analysis.report, null);
      resetConfirm();
      setDisabled(syncButton, false);
      setStatus("The timeline changed since the analysis (" + analysis.plan.placements.length + " clips to place now). Review and click Sync again.", "warn");
      return;
    }
    state.analysis = analysis;
    log.info("Sync started: " + analysis.plan.placements.length + " clips -> " + analysis.target.label + ".");
    setProgress("Placing clips...", 0, analysis.plan.placements.length);

    const result = await engine.sync(analysis);
    renderReport(analysis.report, result);
    const undoNote = " (" + result.steps + " undo step" + (result.steps === 1 ? "" : "s") + ")";
    if (result.verification.ok && !result.leftoverAudio) {
      setStatus(
        "Placed " + result.placed + " clips on " + analysis.target.label + undoNote + "." +
          (result.remaining ? " " + result.remaining + " front clips still need a side file." : " Every front clip is covered."),
        "ok"
      );
    } else {
      setStatus("Placed with warnings" + undoNote + ". Check the result and the log before trusting it.", "warn");
    }
    state.analysis = null;
    resetConfirm();
    setDisabled(syncButton, true);
  } catch (error) {
    const message = (error && error.message) || String(error);
    log.error(message);
    renderError(message);
    setStatus("Sync stopped. Use Edit > Undo to revert the steps already made.", "error");
    state.analysis = null;
    resetConfirm();
    setDisabled(syncButton, true);
  } finally {
    setBusy(false);
    persistLog();
  }
}

/* ---------- wiring ---------- */

onClick(analyzeButton, analyze);
onClick(syncButton, sync);
onClick(refreshButton, () => refresh(false));
enginePill.addEventListener("click", () => {
  if (modeSelect.value === "audio" && !state.busy) ensureEngine(true);
});
onClick(engineStartButton, () => ensureEngine(true));
onClick(engineFolderButton, openEngineFolder);
advancedToggle.addEventListener("click", () => {
  const open = advancedBox.className.indexOf("hint--hidden") !== -1;
  show(advancedBox, open);
  advancedToggle.textContent = open ? "Hide advanced options" : "Show advanced options";
});
onClick(logToggle, () => {
  const open = logBody.className.indexOf("hint--hidden") !== -1;
  show(logBody, open);
  logToggle.textContent = open ? "Hide" : "Show";
});
onClick(copyLogButton, copyLog);
onClick(saveLogButton, saveLogAs);
onClick(clearLogButton, () => log.clear());
authorLink.addEventListener("click", openAuthorSite);
masterSelect.addEventListener("change", () => {
  invalidate();
  refresh(true); // re-mark which files are front files
});
targetSelect.addEventListener("change", invalidate);
footageSelect.addEventListener("change", invalidate);
modeSelect.addEventListener("change", () => {
  updateModeHint();
  invalidate();
});
offsetInput.addEventListener("input", invalidate);

/* UXP leaves a <select> blank until a value is set explicitly. */
if (!modeSelect.value) modeSelect.value = "audio";
versionElement.textContent = VERSION;
updateModeHint();
log.info("LazyEditMirror " + VERSION + " loaded.");
refresh(false);
setInterval(() => {
  if (state.engine === "ok") audioClient.health(true);
}, KEEPALIVE_MS);

/* Optional in UXP, but it lets Premiere tell us when the panel is shown again. */
try {
  uxp.entrypoints.setup({
    panels: {
      "lazyeditmirror-panel": {
        show() {
          refresh(true);
        },
      },
    },
  });
} catch (error) {
  log.warn("entrypoints.setup: " + ((error && error.message) || error));
}
