/**
 * The maintenance surface: things that keep the extension correct over time
 * rather than at install time.
 *
 * The canary is the important one. YouTube renames elements silently, and a
 * selector that matches nothing does not throw — it just stops protecting. A
 * canary nobody runs, or one whose anchors are not the selectors the extension
 * actually uses, is worse than none, so both are pinned here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

const pkg = JSON.parse(read('package.json'));
const canaryPath = 'scripts/check-youtube-selectors.mjs';
const canary = read(canaryPath);
const content = read('src/content/youtube.js');
const readme = read('README.md');

test('the canary is a script you can actually run', () => {
  assert.equal(pkg.scripts?.canary, 'node scripts/check-youtube-selectors.mjs');
  assert.ok(existsSync(resolve(ROOT, canaryPath)));
  assert.ok(canary.includes('fetch('), 'it reads the live pages');
  assert.ok(canary.includes('fetchPage'), 'through one fetch helper');
  assert.ok(
    !pkg.scripts.test.includes('canary'),
    'the offline test suite must not depend on youtube.com being reachable'
  );
  assert.ok(canary.includes('process.exit(2)'), 'an unreachable page is inconclusive, not a pass');
  assert.ok(canary.includes('process.exit(1)'), 'a missing anchor is a failure');
  assert.ok(readme.includes('npm run canary'), 'and the README says how to run it');
});

test('the canary checks the anchors the extension really depends on', () => {
  for (const anchor of [
    'ytd-app',
    'ytd-thumbnail',
    'ytd-rich-grid-renderer',
    'ytd-watch-flexy',
    'movie_player',
    'ytd-watch-metadata',
  ]) {
    assert.ok(canary.includes(anchor), `the canary must check ${anchor}`);
  }
  // The page-level anchors the extension itself matches on have to appear in the
  // content script, or the canary would be watching markup nothing uses.
  // (`ytd-app`/`ytd-rich-grid-renderer` are shell anchors: useful proof the page
  // is the one the canary expects, not selectors this script evaluates.)
  for (const anchor of ['ytd-thumbnail', 'ytd-watch-flexy', 'movie_player']) {
    assert.ok(content.includes(anchor), `the content script must actually use ${anchor}`);
  }
});
