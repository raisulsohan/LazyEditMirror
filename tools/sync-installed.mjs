/*
 * Developer shortcut: copy the plugin files over an already installed copy,
 * and the engine files over the installed audio engine.
 *
 * Creative Cloud installs a .ccx into
 *   %APPDATA%\Adobe\UXP\Plugins\External\<manifest id>_<version>\       (per user)
 *   %ProgramFiles%\Common Files\Adobe\UXP\Plugins\External\<id>_<version>\  (all users; needs an elevated shell)
 * Once that registration exists (install the .ccx once), later edits can
 * simply be copied into the same folder; Premiere Pro reads the files again
 * at launch. The installer puts the engine in %LOCALAPPDATA%\LazyEditMirror\engine;
 * that copy is refreshed too and the running engine is asked to quit so the
 * launcher starts the new one next time the panel needs it.
 *
 *   node tools/sync-installed.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_FILES } from "./build-ccx.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const folderName = manifest.id + "_" + manifest.version;
const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local");
const candidates = [
  join(appData, "Adobe", "UXP", "Plugins", "External", folderName),
  join(process.env.ProgramFiles || "C:\\Program Files", "Common Files", "Adobe", "UXP", "Plugins", "External", folderName),
];
const target = candidates.find((c) => existsSync(c));

if (!target) {
  console.error("Version " + manifest.version + " is not installed yet; looked in:\n  " + candidates.join("\n  "));
  console.error("Build the .ccx (npm run build) and install it once (tools\\install.bat or the release installer); then this shortcut works.");
  process.exit(1);
}

let copied = 0;
for (const name of PLUGIN_FILES) {
  const destination = join(target, name);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, name), destination);
  copied += 1;
}
console.log("Copied " + copied + " files to " + target);

const engine = join(localAppData, "LazyEditMirror", "engine");
if (existsSync(engine)) {
  for (const name of PLUGIN_FILES.filter((n) => n.startsWith("helper/")).map((n) => n.slice("helper/".length)).concat(["../manifest.json"])) {
    const source = name.startsWith("../") ? join(root, name.slice(3)) : join(root, "helper", name);
    copyFileSync(source, join(engine, name.startsWith("../") ? name.slice(3) : name));
  }
  console.log("Refreshed the audio engine in " + engine);
  try {
    await fetch("http://127.0.0.1:5182/quit", { method: "POST" });
    console.log("Asked the running engine to quit; the panel restarts it when needed.");
  } catch (e) {
    /* not running */
  }
}
console.log("Restart Premiere Pro (or close and reopen the panel) to load the panel files.");
