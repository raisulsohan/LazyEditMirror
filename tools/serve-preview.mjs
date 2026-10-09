/*
 * Look at the panel in a normal browser, with sample content, to check the
 * layout without Premiere Pro. Nothing here runs inside the plugin.
 *
 *   node tools/serve-preview.mjs        -> http://localhost:5181/
 *
 * The page is index.html with styles.css inlined, main.js dropped (it needs
 * the premierepro module) and the selects, result card and log pre-filled.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5181;

function row(kind, name, sub, count) {
  return (
    '<div class="file-row file-row--' + kind + '"><span class="file-dot"></span><div class="file-main"><div class="file-name">' + name +
    '</div><div class="file-sub">' + sub + '</div></div><span class="file-count">' + count + "</span></div>"
  );
}

function page() {
  let html = readFileSync(join(root, "index.html"), "utf8");
  const css = readFileSync(join(root, "styles.css"), "utf8");
  html = html.replace(/<link rel="stylesheet" href="styles.css" \/>/, "<style>" + css + "</style>");
  html = html.replace(/<script src="main.js"><\/script>/, "");
  html = html.replace('<select id="master-track"></select>', '<select id="master-track"><option>V1 - Video 1 (86 clips)</option><option>V2 - Video 2 (empty)</option></select>');
  html = html.replace('<select id="target-track"></select>', '<select id="target-track"><option>V2 - Video 2 (empty)</option></select>');
  html = html.replace('<select id="target-footage"></select>', '<select id="target-footage"><option>01. Assets/03. Videos/Side/C0056.mp4</option></select>');
  html = html.replace('<span id="engine-text">Audio engine</span>', '<span id="engine-text">Audio engine ready</span>');
  html = html.replace('class="pill pill--idle"', 'class="pill pill--ok"');
  html = html.replace(
    '<div id="result-files" class="result-files"></div>',
    '<div id="result-files" class="result-files">' +
      row("ok", "C0002.mp4", "side = front +0.635 s (correlation 0.84)", "23 to place") +
      row("wait", "C0003.mp4", "no match in this side file", "32 waiting") +
      row("wait", "C0004.mp4", "no match in this side file", "5 waiting") +
      row("done", "C0005.mp4", "already on the side track", "26 done") +
      "</div>"
  );
  html = html.replace('<div id="result-title">Result</div>', '<div id="result-title">Plan for C0056.mp4</div>');
  html = html.replace('class="card-title" id="result-title">Result<', 'class="card-title" id="result-title">Plan for C0056.mp4<');
  html = html.replace('<p id="result-totals" class="result-totals"></p>', '<p id="result-totals" class="result-totals">23 clips to place (209.0 s) · 26 done · 37 waiting. Master: 86 clips from 4 files, 85 cuts, 0 gaps.</p>');
  html = html.replace('<p id="result-notes" class="hint"></p>', '<p id="result-notes" class="hint">Side audio is parked on A3 - Audio 3 for a moment and removed.</p>');
  html = html.replace('<div id="result" class="card result hint--hidden">', '<div id="result" class="card result">');
  html = html.replace('<div id="sync-button" class="btn btn--accent btn--disabled">Sync</div>', '<div id="sync-button" class="btn btn--accent">Sync 23 clips</div>');
  html = html.replace('class="status">Open your sequence, pick the side footage and click Analyze.', 'class="status status--ok">Ready: 23 clips to place on V2 - Video 2. Click Sync.');
  html = html.replace('<div id="progress" class="progress hint--hidden"><div id="progress-bar" class="progress-bar"></div></div>', '<div id="progress" class="progress"><div id="progress-bar" class="progress-bar" style="width: 40%"></div></div>');
  html = html.replace('<span id="version"></span>', '<span id="version">1.1.1</span>');
  html = html.replace(
    '<textarea id="log" readonly></textarea>',
    '<textarea id="log" readonly>[03:05:10] LazyEditMirror 1.1.1 loaded.\n[03:05:10] Read sequence "C0002": 3 video tracks, 9 media clips in the project.\n[03:05:14] Audio: C0056.mp4 vs C0002.mp4: side = front + 0.635 s (match; correlation 0.84 over 281.3 s).</textarea>'
  );
  html = html.replace('<div id="log-body" class="hint--hidden">', '<div id="log-body">');
  return html;
}

createServer((request, response) => {
  if (request.url === "/" || request.url === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page());
    return;
  }
  response.writeHead(404);
  response.end("not found");
}).listen(port, "127.0.0.1", () => console.log("LazyEditMirror preview: http://localhost:" + port + "/"));
