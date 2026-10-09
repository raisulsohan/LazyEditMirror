/*
 * Draws the panel icons as PNG files, no image tools needed.
 *
 *   node tools/make-icons.mjs
 *
 * The glyph: a solid block (the front camera edit) mirrored across a dashed
 * axis into an outlined block (the side camera). Panel icons come in a dark
 * and a light variant at 1x/2x (24 px base); the plugin-list tile is a
 * coloured rounded square with the glyph at 48 px base.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "icons");

/* ---------- a tiny PNG writer (RGBA, 8 bit) ---------- */
const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(0);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- a tiny rasterizer with 4x4 supersampling ---------- */
function roundedRect(x, y, w, h, r) {
  return (px, py) => {
    const cx = Math.max(x + r, Math.min(x + w - r, px));
    const cy = Math.max(y + r, Math.min(y + h - r, py));
    return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= r * r;
  };
}
function ring(x, y, w, h, r, thickness) {
  const outer = roundedRect(x, y, w, h, r);
  const inner = roundedRect(x + thickness, y + thickness, w - 2 * thickness, h - 2 * thickness, Math.max(0, r - thickness));
  return (px, py) => outer(px, py) && !inner(px, py);
}
function dashes(x, y0, y1, w, dash, gap) {
  return (px, py) => px >= x && px < x + w && py >= y0 && py < y1 && ((py - y0) % (dash + gap)) < dash;
}

/** Render `layers` ([{ shape, color: [r,g,b,a] }]) at `size` px (shapes are described in 24-unit space). */
function render(size, layers) {
  const scale = size / 24;
  const rgba = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const layer of layers) {
        let coverage = 0;
        for (let sy = 0; sy < S; sy += 1) {
          for (let sx = 0; sx < S; sx += 1) {
            const px = (x + (sx + 0.5) / S) / scale;
            const py = (y + (sy + 0.5) / S) / scale;
            if (layer.shape(px, py)) coverage += 1;
          }
        }
        coverage /= S * S;
        if (!coverage) continue;
        const la = (layer.color[3] / 255) * coverage;
        /* "over" compositing */
        const outA = la + a * (1 - la);
        r = (layer.color[0] * la + r * a * (1 - la)) / (outA || 1);
        g = (layer.color[1] * la + g * a * (1 - la)) / (outA || 1);
        b = (layer.color[2] * la + b * a * (1 - la)) / (outA || 1);
        a = outA;
      }
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, rgba);
}

function glyph(color) {
  return [
    { shape: roundedRect(2.5, 6, 7.5, 12, 1.5), color: color }, // front: solid
    { shape: dashes(11.5, 4, 20, 1, 2, 1.4), color: color }, // mirror axis
    { shape: ring(14, 6, 7.5, 12, 1.5, 1.6), color: color }, // side: outline
  ];
}

mkdirSync(out, { recursive: true });
const light = [245, 245, 245, 255]; // on dark UI themes
const dark = [60, 60, 60, 255]; // on light UI themes
for (const [name, color] of [["icon-dark", light], ["icon-light", dark]]) {
  writeFileSync(join(out, name + ".png"), render(24, glyph(color)));
  writeFileSync(join(out, name + "@2x.png"), render(48, glyph(color)));
}
/* Plugin list tile: indigo rounded square with the light glyph. */
const tile = (size) =>
  render(size, [{ shape: roundedRect(0, 0, 24, 24, 5), color: [90, 99, 214, 255] }].concat(glyph(light).map((l) => ({ shape: (px, py) => l.shape((px - 12) * 0.78 + 12, (py - 12) * 0.78 + 12), color: l.color }))));
writeFileSync(join(out, "plugin-list.png"), tile(48));
writeFileSync(join(out, "plugin-list@2x.png"), tile(96));
console.log("Wrote icons to " + out);
