/*
 * Package the plugin as a .ccx (a zip with manifest.json at its root), the
 * file Creative Cloud installs when double-clicked, or that UPIA installs with
 *   UnifiedPluginInstallerAgent.exe /install <file>
 *
 *   node tools/build-ccx.mjs            -> dist/LazyEditMirror-<version>.ccx
 *
 * The zip is written here (not with Compress-Archive) so entry names always
 * use forward slashes and nothing else surprising ends up in the archive.
 */
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

/** Exactly what ships (paths with forward slashes). tools/sync-installed.mjs copies the same list. */
export const PLUGIN_FILES = [
  "manifest.json",
  "index.html",
  "styles.css",
  "main.js",
  "plan.js",
  "premiere.js",
  "sync.js",
  "log.js",
  "helper.js",
  "helper/sync-helper.mjs",
  "helper/audio.js",
  "helper/launch-hidden.vbs",
  "helper/start-helper.bat",
  "helper/start-helper.command",
  "icons/icon-dark.png",
  "icons/icon-dark@2x.png",
  "icons/icon-light.png",
  "icons/icon-light@2x.png",
  "icons/plugin-list.png",
  "icons/plugin-list@2x.png",
];

/** Entries that must be executable when unpacked on macOS. */
const EXECUTABLE = /\.(command|sh)$/i;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Write `files` ([{ name, path, mode? }], names with forward slashes) to `outFile`. */
export function writeZip(outFile, files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const body = readFileSync(file.path);
    const deflated = deflateRawSync(body, { level: 9 });
    const stored = deflated.length >= body.length;
    const data = stored ? body : deflated;
    const stamp = dosStamp(statSync(file.path).mtime);
    const crc = crc32(body);
    const mode = file.mode || (EXECUTABLE.test(file.name) ? 0o755 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(mode ? 0x0314 : 20, 4); // made by: UNIX when a mode is carried
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(mode ? ((0o100000 | mode) << 16) >>> 0 : 0, 38);
    header.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(outFile, Buffer.concat([...locals, ...central, end]));
}

export function build() {
  for (const name of PLUGIN_FILES) {
    if (!existsSync(join(root, name))) throw new Error("Missing plugin file: " + name);
  }
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  for (const old of readdirSync(dist)) if (/\.ccx$/i.test(old)) rmSync(join(dist, old));

  const outFile = join(dist, manifest.name + "-" + manifest.version + ".ccx");
  writeZip(
    outFile,
    PLUGIN_FILES.map((name) => ({ name, path: join(root, name) }))
  );
  return outFile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = build();
  console.log("Built " + out + " (" + statSync(out).size + " bytes, " + manifest.id + " " + manifest.version + ")");
  console.log("Install: double-click it (Creative Cloud) or run tools\\install.bat, then restart Premiere Pro.");
}
