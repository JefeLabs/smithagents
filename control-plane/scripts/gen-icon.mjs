// Renders the smithagents spark glyph to a 1024x1024 RGBA PNG. No dependencies:
// pixels are composed in a Buffer and PNG chunks are emitted with node:zlib.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 1024;
const CORNER = 180;
const BG = [0x0d, 0x11, 0x19];
const FG = [0x7a, 0xa2, 0xff];

function inRoundedRect(x, y) {
  const cx = Math.min(Math.max(x, CORNER), S - CORNER);
  const cy = Math.min(Math.max(y, CORNER), S - CORNER);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= CORNER * CORNER;
}

const SCALE = 44;
const BASE = [
  [12, 2],
  [14.4, 7.6],
  [20, 10],
  [14.4, 12.4],
  [12, 18],
  [9.6, 12.4],
  [4, 10],
  [9.6, 7.6],
];
const STAR = BASE.map(([x, y]) => [512 + (x - 12) * SCALE, 512 + (y - 10) * SCALE]);

function inStar(x, y) {
  let inside = false;
  for (let i = 0, j = STAR.length - 1; i < STAR.length; j = i++) {
    const [xi, yi] = STAR[i];
    const [xj, yj] = STAR[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const SAMPLES = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];
const px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let bgCov = 0;
    let fgCov = 0;
    for (const [ox, oy] of SAMPLES) {
      if (inRoundedRect(x + ox, y + oy)) {
        bgCov++;
        if (inStar(x + ox, y + oy)) fgCov++;
      }
    }
    const i = (y * S + x) * 4;
    const t = fgCov / 4;
    px[i] = Math.round(BG[0] * (1 - t) + FG[0] * t);
    px[i + 1] = Math.round(BG[1] * (1 - t) + FG[1] * t);
    px[i + 2] = Math.round(BG[2] * (1 - t) + FG[2] * t);
    px[i + 3] = Math.round((bgCov / 4) * 255);
  }
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? "app-icon.png", png);
console.log(`wrote ${process.argv[2] ?? "app-icon.png"} (${png.length} bytes)`);
