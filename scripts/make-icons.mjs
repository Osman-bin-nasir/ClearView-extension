#!/usr/bin/env node
/**
 * Generate the extension icons.
 *
 * Chrome needs raster icons, and adding an image toolchain for four small files
 * is not worth a dependency — a PNG is a header, a zlib stream of scanlines and
 * a CRC, all of which Node already has. The mark is the ClearView blocked-shield:
 * a teal rounded square with a white "no" ring and bar.
 *
 * Usage: node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];

// ClearView teal (the app's Material-3 primary) on white.
const BG = [0x00, 0x69, 0x5c];
const FG = [0xff, 0xff, 0xff];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Draw one icon: rounded teal tile, white ring, white diagonal bar. */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const corner = size * 0.22;
  const ringOuter = size * 0.34;
  const ringInner = size * 0.34 - Math.max(1, size * 0.09);
  const barHalf = Math.max(1, size * 0.055);

  const inRoundedSquare = (x, y) => {
    const dx = Math.min(x, size - 1 - x);
    const dy = Math.min(y, size - 1 - y);
    if (dx >= corner || dy >= corner) return true;
    const cxp = dx - corner;
    const cyp = dy - corner;
    return cxp * cxp + cyp * cyp <= corner * corner;
  };

  const inRing = (x, y) => {
    const dx = x - centre;
    const dy = y - centre;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return dist <= ringOuter && dist >= ringInner;
  };

  // A 45° bar through the ring: |x - y| small, within the ring's span.
  const inBar = (x, y) => {
    const dx = x - centre;
    const dy = y - centre;
    if (Math.abs(dx) > ringOuter || Math.abs(dy) > ringOuter) return false;
    return Math.abs(dx - dy) / Math.SQRT2 <= barHalf;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      if (!inRoundedSquare(x, y)) continue; // transparent outside the tile
      const mark = inRing(x, y) || inBar(x, y);
      const colour = mark ? FG : BG;
      rgba[index] = colour[0];
      rgba[index + 1] = colour[1];
      rgba[index + 2] = colour[2];
      rgba[index + 3] = 255;
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, size, drawIcon(size));
  writeFileSync(resolve(OUT_DIR, `icon${size}.png`), png);
}
console.log(`Wrote ${SIZES.length} icons to ${OUT_DIR}`);
