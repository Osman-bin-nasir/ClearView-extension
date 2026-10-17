#!/usr/bin/env node
/**
 * Generate the extension icons from the ClearView brand logo.
 *
 * The extension's face is the brand logo — the same asset the website serves at
 * https://clearview-blush.vercel.app/logo.png — kept beside the icons as
 * `icons/logo.png`, committed so a build never needs the network. To pick up a
 * new brand image:
 *
 *   curl -sSL https://clearview-blush.vercel.app/logo.png -o icons/logo.png
 *   npm run icons
 *
 * Chrome needs raster icons in four sizes. They are derived here rather than
 * drawn, so the toolbar, the extensions page and the store listing all show the
 * one brand image — and no image toolchain is added for it: see `png.mjs`.
 *
 * Usage: node scripts/make-icons.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodePng, encodePng, resample } from './png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Where the icons are written. */
export const OUT_DIR = resolve(ROOT, 'icons');
/** The brand logo, and the only input. */
export const SOURCE = resolve(OUT_DIR, 'logo.png');
/** The sizes the manifest declares. */
export const SIZES = [16, 32, 48, 128];
/** The manifest's icon path for a size, so the two cannot drift apart. */
export const iconPath = (size) => `icons/icon${size}.png`;

/** Read the logo and write every size. Idempotent: same input, same bytes. */
export function generateIcons() {
  const logo = decodePng(readFileSync(SOURCE));
  mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    writeFileSync(resolve(OUT_DIR, `icon${size}.png`), encodePng(size, size, resample(logo, size, size)));
  }
  return { source: SOURCE, width: logo.width, height: logo.height, sizes: SIZES };
}

// Only when run, not when imported for its constants.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = generateIcons();
  console.log(
    `Wrote ${result.sizes.length} icons to ${OUT_DIR} from ${result.width}x${result.height} ${result.source}`
  );
}
