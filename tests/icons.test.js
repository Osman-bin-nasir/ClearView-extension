/**
 * The extension icons, and the brand logo they come from.
 *
 * The icons are generated, not drawn, and the interesting failure is silent: an
 * icon generator that produces a plausible-looking PNG of the wrong image, or a
 * manifest pointing at a file nobody regenerates. So the PNG helpers are checked
 * directly — a round trip, and a downscale whose answer is known by hand — and
 * the committed icons are checked against the committed logo, which fails the
 * moment the two drift apart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { axisWeights, decodePng, encodePng, resample } from '../scripts/png.mjs';
import { SIZES, SOURCE, iconPath } from '../scripts/make-icons.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path));

// ── The PNG helpers ──────────────────────────────────────────────────────

test('an image survives a write and a read unchanged', () => {
  const width = 5;
  const height = 3;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 37) % 256;

  const decoded = decodePng(encodePng(width, height, pixels));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(
    [...decoded.pixels],
    [...pixels],
    'every channel of every pixel must come back exactly as it went in'
  );
});

test('a box downscale averages exactly the pixels each destination covers', () => {
  // Four quadrants of known values, so the expected answer is arithmetic rather
  // than a stored reference: a 4x4 to 2x2 box filter averages each 2x2 block.
  const source = { width: 4, height: 4, pixels: new Uint8Array(4 * 4 * 4) };
  const quadrant = [
    [100, 200],
    [50, 150],
  ];
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const i = (y * 4 + x) * 4;
      source.pixels[i] = quadrant[y >> 1][x >> 1];
      source.pixels[i + 3] = 255;
    }
  }

  const out = resample(source, 2, 2);
  const red = (x, y) => out[(y * 2 + x) * 4];
  assert.equal(red(0, 0), 100);
  assert.equal(red(1, 0), 200);
  assert.equal(red(0, 1), 50);
  assert.equal(red(1, 1), 150);
  assert.equal(out[3], 255, 'alpha is carried through like any other channel');

  for (let d = 0; d < 4; d += 1) {
    const total = axisWeights(4, 4)[d].reduce((sum, [, weight]) => sum + weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, 'the weights for a destination pixel must sum to 1');
  }
});

// ── The icons the extension ships ────────────────────────────────────────

test('the brand logo is committed beside the icons it generates', () => {
  assert.ok(existsSync(SOURCE), 'icons/logo.png must be in the repository, not fetched at build time');
  const logo = decodePng(readFileSync(SOURCE));
  assert.equal(logo.width, logo.height, 'the brand mark is square, so every size is a plain downscale');
  const colours = new Set();
  for (let i = 0; i < logo.pixels.length; i += 4) {
    colours.add(`${logo.pixels[i]},${logo.pixels[i + 1]},${logo.pixels[i + 2]}`);
  }
  assert.ok(colours.size > 10, 'and it must be an actual image, not a flat fill');
});

test('every icon is the logo at the size the manifest asks for', () => {
  const logo = decodePng(readFileSync(SOURCE));
  for (const size of SIZES) {
    const path = iconPath(size);
    assert.ok(existsSync(resolve(ROOT, path)), `${path} must exist`);
    const icon = decodePng(readFileSync(resolve(ROOT, path)));
    assert.equal(icon.width, size, `${path} must be ${size}px wide`);
    assert.equal(icon.height, size, `${path} must be ${size}px tall`);

    // Derived, not drawn: regenerating from the committed logo must reproduce
    // the committed icon. A drifted icon — or a generator that quietly stopped
    // working — fails here rather than in the toolbar.
    const expected = resample(logo, size, size);
    let difference = 0;
    for (let i = 0; i < expected.length; i += 1) {
      difference += Math.abs(expected[i] - icon.pixels[i]);
    }
    const mean = difference / expected.length;
    assert.ok(mean <= 1, `${path} must be the brand logo downscaled (mean channel difference ${mean})`);
  }
});

test('the manifest points at exactly the icons the generator writes', () => {
  const manifest = JSON.parse(read('manifest.json'));
  for (const size of SIZES) {
    const key = String(size);
    assert.equal(manifest.icons?.[key], iconPath(size), `the manifest’s ${key}px icon must be the generated one`);
    assert.equal(
      manifest.action?.default_icon?.[key],
      iconPath(size),
      `the toolbar’s ${key}px icon must be the generated one too`
    );
  }
});

test('the generator records where the brand image comes from', () => {
  const generator = readFileSync(resolve(ROOT, 'scripts/make-icons.mjs'), 'utf8');
  assert.ok(
    generator.includes('https://clearview-blush.vercel.app/logo.png'),
    'the source URL belongs in the generator, so a future logo is re-fetched from the same place'
  );
});

// ── The brand mark, in the pages that show it ────────────────────────────

test('every page that shows the brand mark uses the bundled logo', () => {
  for (const page of ['src/popup/popup.html', 'src/options/options.html', 'src/privacy/privacy.html']) {
    const html = readFileSync(resolve(ROOT, page), 'utf8');
    assert.ok(
      html.includes('class="brand-mark"') && html.includes('src="../../icons/logo.png"'),
      `${page} must render the logo image rather than an emoji stand-in`
    );
    assert.ok(
      existsSync(resolve(dirname(resolve(ROOT, page)), '../../icons/logo.png')),
      `${page}’s relative path must resolve to the committed logo`
    );
  }
  const theme = readFileSync(resolve(ROOT, 'src/ui/theme.css'), 'utf8');
  assert.ok(
    /\.brand-mark img \{[\s\S]{0,160}border-radius: inherit;/.test(theme),
    'the image fills the page’s own rounded tile, so each page need not restate it'
  );
});
