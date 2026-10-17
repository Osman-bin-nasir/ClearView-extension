/**
 * The small slice of PNG the build needs, with no dependencies.
 *
 * A PNG is a header (IHDR), a zlib stream of filtered scanlines (IDAT) and a
 * CRC — all of which Node already has. This reads the non-interlaced 8-bit
 * RGB/RGBA subset that the brand logo and our own icons use, resamples by a box
 * filter, and writes RGBA back out.
 *
 * Pure and exported so the resampling can be checked directly rather than
 * trusted: `make-icons.mjs` is only the runner around it.
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The Paeth predictor, as the PNG spec defines it. */
export function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Undo one scanline's filter, given the line above it. */
export function unfilter(type, line, previous, bpp) {
  const out = Uint8Array.from(line);
  for (let i = 0; i < out.length; i += 1) {
    const a = i >= bpp ? out[i - bpp] : 0;
    const b = previous[i] ?? 0;
    const c = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
    switch (type) {
      case 0: break;
      case 1: out[i] = (out[i] + a) & 0xff; break;
      case 2: out[i] = (out[i] + b) & 0xff; break;
      case 3: out[i] = (out[i] + ((a + b) >> 1)) & 0xff; break;
      case 4: out[i] = (out[i] + paeth(a, b, c)) & 0xff; break;
      default: throw new Error(`Unsupported PNG filter ${type}`);
    }
  }
  return out;
}

// ── Reading ──────────────────────────────────────────────────────────────

import { deflateSync, inflateSync } from 'node:zlib';

/** Decode a non-interlaced 8-bit RGB/RGBA PNG into RGBA pixels. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG file');
  let offset = 8;
  let header = null;
  const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colour: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      chunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG has no IHDR');
  if (header.depth !== 8) throw new Error(`Unsupported bit depth ${header.depth}`);
  if (header.interlace !== 0) throw new Error('Interlaced PNGs are not supported');
  if (header.colour !== 2 && header.colour !== 6) {
    throw new Error(`Unsupported colour type ${header.colour} (RGB and RGBA only)`);
  }

  const channels = header.colour === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(chunks));
  const pixels = new Uint8Array(header.width * header.height * 4);
  let previous = new Uint8Array(stride);

  for (let y = 0; y < header.height; y += 1) {
    const rowStart = y * (stride + 1);
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const current = unfilter(raw[rowStart], line, previous, channels);
    for (let x = 0; x < header.width; x += 1) {
      const from = x * channels;
      const to = (y * header.width + x) * 4;
      pixels[to] = current[from];
      pixels[to + 1] = current[from + 1];
      pixels[to + 2] = current[from + 2];
      pixels[to + 3] = channels === 4 ? current[from + 3] : 255;
    }
    previous = current;
  }
  return { width: header.width, height: header.height, pixels };
}

// ── Resampling ───────────────────────────────────────────────────────────

/**
 * For each destination pixel along one axis, the source pixels it covers and
 * how much of it each contributes. The overlaps are fractional at the edges, so
 * a 300 → 16 downscale does not drift a pixel every few rows.
 */
export function axisWeights(sourceLength, destinationLength) {
  const weights = [];
  for (let d = 0; d < destinationLength; d += 1) {
    const start = (d * sourceLength) / destinationLength;
    const end = ((d + 1) * sourceLength) / destinationLength;
    const spans = [];
    let total = 0;
    for (let s = Math.floor(start); s < Math.ceil(end); s += 1) {
      const overlap = Math.min(end, s + 1) - Math.max(start, s);
      if (overlap <= 0) continue;
      spans.push([Math.min(Math.max(s, 0), sourceLength - 1), overlap]);
      total += overlap;
    }
    weights.push(spans.map(([index, overlap]) => [index, overlap / total]));
  }
  return weights;
}

/** Box-filter a decoded source down to `width` x `height` RGBA. */
export function resample(source, width, height) {
  const { pixels, width: sw, height: sh } = source;
  const xWeights = axisWeights(sw, width);
  const yWeights = axisWeights(sh, height);

  // Horizontal pass first: `width` x `sh`, then vertical.
  const horizontal = new Float64Array(width * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (const [sx, weight] of xWeights[x]) sum += pixels[(y * sw + sx) * 4 + c] * weight;
        horizontal[(y * width + x) * 4 + c] = sum;
      }
    }
  }

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (const [sy, weight] of yWeights[y]) sum += horizontal[(sy * width + x) * 4 + c] * weight;
        out[(y * width + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(sum)));
      }
    }
  }
  return out;
}

// ── Writing ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buffer) {
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

/** Encode RGBA pixels as an 8-bit RGBA PNG. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
