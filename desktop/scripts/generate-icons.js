/* Cadence icon generator — writes every app icon from code (audit U7).
 *
 * The repo deliberately ships no binary design sources; this script IS the
 * source. Re-run after tweaking:  node desktop/scripts/generate-icons.js
 *
 * Outputs:
 *   desktop/build/icon.png        1024px, macOS style — rounded square on a
 *                                 transparent canvas with Apple-template
 *                                 margins (electron-builder converts → .icns)
 *   mobile/assets/icon.png        1024px, iOS style — full-bleed square,
 *                                 no alpha (the system applies the mask)
 *   mobile/assets/splash-icon.png 1024px glyph on transparency — Expo splash
 *                                 image, backgroundColor fills the screen
 *
 * Zero dependencies: a scanline renderer with 4× supersampling (free
 * antialiasing) and a minimal PNG encoder over node:zlib. The motif is the
 * same "pulse dot" as the menubar tray icon in desktop/main.js — a ring
 * with a needle at 12 o'clock, i.e. a metronome caught on the beat.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ── palette (matches app/src/theme.css + mobile/src/theme.js) ───────
const BG_TOP = [0x16, 0x2b, 0x4d];    // navy, upper-left light
const BG_BOTTOM = [0x0a, 0x16, 0x26]; // app background navy, lower-right
const GLYPH = [0x7f, 0xb4, 0xe8];     // brand blue
const GLYPH_HI = [0xd9, 0xea, 0xfb];  // needle highlight

// ── minimal PNG encoder (RGBA, 8-bit) ───────────────────────────────
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    rgba.copy(row, 1, y * size * 4, (y + 1) * size * 4);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── scene: returns [r,g,b,a] for a point in unit space (0..1) ───────
// opts.plate: "rounded" (macOS tile), "square" (iOS full-bleed), or
// "none" (splash glyph on transparency).
function shade(u, v, opts) {
  // Rounded-rect SDF for the macOS plate — Apple's 1024 template puts the
  // tile at 824×824 with ~185px corner radius; in unit space that's a
  // half-extent of 0.4023 and radius 0.1807 around the center.
  let plateAlpha = 1;
  if (opts.plate === "rounded") {
    const half = 0.4023, r = 0.1807;
    const dx = Math.abs(u - 0.5) - (half - r);
    const dy = Math.abs(v - 0.5) - (half - r);
    const dist = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
    plateAlpha = Math.max(0, Math.min(1, -dist * opts.size)); // ~1px edge
    if (plateAlpha === 0) return [0, 0, 0, 0];
  }

  // Background: diagonal gradient plus a soft radial glow behind the glyph.
  let rgb = null;
  if (opts.plate !== "none") {
    const t = Math.max(0, Math.min(1, (u + v) / 2));
    rgb = [
      BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t,
      BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t,
      BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t,
    ];
    const glow = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.44) / 0.52);
    const g = glow * glow * 0.22;
    rgb = rgb.map((c, i) => c + (GLYPH[i] - c) * g);
  }

  // Glyph geometry (unit space, centered). Ring + needle, like the tray dot.
  const cx = 0.5, cy = 0.5;
  const d = Math.hypot(u - cx, v - cy);
  const RING_OUT = 0.27, RING_IN = 0.175;
  const NEEDLE_W = 0.036, NEEDLE_TOP = cy - 0.335;

  const edge = 1.5 / opts.size; // soft edge width
  const band = (x, lo, hi) =>
    Math.max(0, Math.min(1, (x - lo) / edge)) * Math.max(0, Math.min(1, (hi - x) / edge));

  let glyphA = band(d, RING_IN, RING_OUT);
  // Needle: from just above the ring's outer edge down into the hole.
  let needleA = 0;
  if (v >= NEEDLE_TOP && v <= cy + NEEDLE_W) {
    const w = Math.max(0, Math.min(1, (NEEDLE_W - Math.abs(u - cx)) / edge));
    const capTop = Math.max(0, Math.min(1, (v - NEEDLE_TOP) / edge));
    needleA = w * capTop;
  }
  // Rounded needle tip: a dot at the center completes the metronome pivot.
  const pivotA = band(d, -1, 0.055);

  if (opts.plate === "none") {
    // Same stacking as the composite branch: needle paints OVER the ring.
    const hiA = Math.max(needleA, pivotA);
    const a = Math.max(glyphA, hiA);
    if (a === 0) return [0, 0, 0, 0];
    const col = GLYPH.map((c, i) => c + (GLYPH_HI[i] - c) * hiA);
    return [col[0], col[1], col[2], Math.round(a * 255)];
  }

  // Composite glyph over background: ring in brand blue, needle brighter.
  let out = rgb;
  if (glyphA > 0) out = out.map((c, i) => c + (GLYPH[i] - c) * glyphA);
  const hiA = Math.max(needleA, pivotA);
  if (hiA > 0) out = out.map((c, i) => c + (GLYPH_HI[i] - c) * hiA);
  return [out[0], out[1], out[2], Math.round(plateAlpha * 255)];
}

// ── render with 4× supersampling ────────────────────────────────────
function render(size, opts) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const [pr, pg, pb, pa] = shade(u, v, { ...opts, size });
          const w = pa / 255;
          r += pr * w; g += pg * w; b += pb * w; a += pa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const i = (y * size + x) * 4;
      // Average color weighted by coverage (colors were accumulated
      // premultiplied by their sample alpha).
      buf[i] = alpha > 0 ? Math.round(r / (a / 255)) : 0;
      buf[i + 1] = alpha > 0 ? Math.round(g / (a / 255)) : 0;
      buf[i + 2] = alpha > 0 ? Math.round(b / (a / 255)) : 0;
      buf[i + 3] = Math.round(alpha);
    }
  }
  return encodePng(size, buf);
}

// ── outputs ─────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, "..", "..");
const OUT = [
  [path.join(ROOT, "desktop", "build", "icon.png"), { plate: "rounded" }],
  [path.join(ROOT, "mobile", "assets", "icon.png"), { plate: "square" }],
  [path.join(ROOT, "mobile", "assets", "splash-icon.png"), { plate: "none" }],
];
for (const [file, opts] of OUT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(1024, opts));
  console.log(`wrote ${path.relative(ROOT, file)}`);
}
