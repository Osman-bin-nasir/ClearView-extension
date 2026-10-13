/**
 * Regression guards for the YouTube Shorts entry-point hiding.
 *
 * The content script itself cannot be unit-tested here — it is a classic script
 * that talks to the DOM and to `chrome.*`, with no module system available to a
 * content script — so these are STATIC checks on the shipped artefacts. They are
 * narrow on purpose: each one pins an invariant that actually broke or would
 * break the feature silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Comments explain the rule and quote the old selector, so they are removed
 * before the negative checks — the invariant is about real selectors, not prose. */
const cssRaw = readFileSync(resolve(ROOT, 'src/content/youtube.css'), 'utf8');
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
const script = readFileSync(resolve(ROOT, 'src/content/youtube.js'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));

test('the Shorts stylesheet matches /shorts links by PREFIX', () => {
  // YouTube writes the guide link as "/shorts/" (trailing slash), so an
  // exact-match attribute selector matched nothing and the icon stayed visible.
  assert.ok(
    css.includes('a[href^="/shorts"]'),
    'the CSS must match /shorts links by prefix, or a trailing slash defeats it'
  );
  assert.ok(
    !/\[href="\/shorts"\]/.test(css),
    'an exact [href="/shorts"] selector cannot match YouTube\'s "/shorts/" link'
  );
});

test('the guide, mini-guide and chip containers are all covered', () => {
  for (const selector of [
    'ytd-guide-entry-renderer',
    'ytd-mini-guide-entry-renderer',
    'yt-chip-cloud-chip-renderer',
  ]) {
    assert.ok(css.includes(selector), `the stylesheet should cover ${selector}`);
    assert.ok(script.includes(selector), `the content script should cover ${selector}`);
  }
});

test('hiding is re-applied on DOM mutations, not only on navigation', () => {
  // YouTube re-renders the guide after load; a one-shot pass stops working.
  assert.ok(
    /function scheduleScan\(\)[\s\S]*applyShorts\(\)/.test(script),
    'the debounced mutation pass must re-apply the Shorts hiding'
  );
  assert.ok(script.includes('new MutationObserver'), 'a MutationObserver is required');
});

test('hiding is reversible, so turning the control off restores the entry points', () => {
  assert.ok(script.includes('restoreShortsEntries'), 'a restore path is required');
  assert.ok(script.includes('hiddenShorts'), 'hidden elements must be tracked to be restored');
});

test('the content script is wired to youtube.com and its stylesheet', () => {
  const entry = manifest.content_scripts?.find((c) => (c.js ?? []).includes('src/content/youtube.js'));
  assert.ok(entry, 'youtube.js must be a content script');
  assert.deepEqual(entry.matches, ['*://*.youtube.com/*']);
  assert.ok((entry.css ?? []).includes('src/content/youtube.css'), 'the stylesheet must be injected');
});
