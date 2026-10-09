/*
 * Build the download: LazyEditMirror-<version>.zip with the .ccx, the
 * installers, the start-here note and the licence.
 *
 *   node tools/release.mjs
 *
 * Runs the tests first. The zip goes to the nearest "00. Install from here"
 * folder above the repository (the shared download folder of the Lazy
 * tools), or to dist/ when there is none; LAZYEDITMIRROR_DOWNLOAD_DIR
 * overrides it. Older LazyEditMirror zips in that folder are replaced.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, writeZip } from "./build-ccx.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error("manifest.json says " + manifest.version + " but package.json says " + pkg.version + "; make them agree.");
}
const VERSION = manifest.version;
const DOWNLOAD_FOLDER_NAMES = ["00. Install from here", "00 Install from here"];

function downloadsFolder() {
  if (process.env.LAZYEDITMIRROR_DOWNLOAD_DIR) return process.env.LAZYEDITMIRROR_DOWNLOAD_DIR;
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    for (const name of DOWNLOAD_FOLDER_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (dirname(dir) === dir) break;
  }
  return join(root, "dist");
}

function run(label, args) {
  console.log("> " + label);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(label + " failed");
}

run("tests: plan", [join(root, "tools", "test-plan.mjs")]);
run("tests: audio", [join(root, "tools", "test-audio.mjs")]);
run("tests: sync", [join(root, "tools", "test-sync.mjs")]);

const ccx = build();
console.log("Built " + basename(ccx));

const stage = join(tmpdir(), "LazyEditMirror-release-" + process.pid);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const files = [];
function add(name, path) {
  files.push({ name: name, path: path });
}
add(basename(ccx), ccx);
const installer = join(root, "tools", "installer");
for (const name of readdirSync(installer)) add(name, join(installer, name));
/* The audio engine, installed by the installer into the user's folder. */
for (const name of readdirSync(join(root, "helper"))) add("engine/" + name, join(root, "helper", name));
add("engine/manifest.json", join(root, "manifest.json"));
add("LICENSE.txt", join(root, "LICENSE"));
const readme = join(stage, "README.md");
copyFileSync(join(root, "README.md"), readme);
add("README.md", readme);

const folder = downloadsFolder();
mkdirSync(folder, { recursive: true });
for (const old of readdirSync(folder)) if (/^LazyEditMirror-.*\.zip$/i.test(old)) rmSync(join(folder, old));
const zipFile = join(folder, "LazyEditMirror-" + VERSION + ".zip");
writeZip(zipFile, files);
rmSync(stage, { recursive: true, force: true });

const sha = spawnSync("certutil", ["-hashfile", zipFile, "SHA256"], { encoding: "utf8", windowsHide: true });
const hash = sha.status === 0 ? (sha.stdout.split(/\r?\n/)[1] || "").trim() : "";
writeFileSync(join(folder, "LazyEditMirror-" + VERSION + ".sha256.txt"), (hash || "(hash unavailable)") + "  " + basename(zipFile) + "\n");
console.log("Release: " + zipFile + (hash ? "\nSHA-256: " + hash : ""));
