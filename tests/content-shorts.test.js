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

test('the label is matched on the element AND on a descendant', () => {
  // YouTube puts `title="Shorts"` on the inner anchor while the element that
  // has to be hidden is the renderer wrapping it. Matching only one of the two
  // leaves the icon visible.
  assert.ok(
    css.includes(':has([title="Shorts"])') && css.includes('[title="Shorts"]'),
    'the stylesheet must match the label on the element and on a descendant'
  );
  assert.ok(
    script.includes('querySelector(\'[title="Shorts"], [aria-label="Shorts"]\')') &&
      script.includes("getAttribute('title')"),
    'the content script must match the label on the element and on a descendant'
  );
});

test('the Shorts SHELF is hidden, not only the entry point', () => {
  // Hiding the sidebar icon alone left the Shorts row in the feed on screen,
  // which is what the toggle is supposed to prevent.
  for (const selector of ['ytd-rich-shelf-renderer[is-shorts]', 'ytd-reel-shelf-renderer']) {
    assert.ok(css.includes(selector), `the stylesheet should hide ${selector}`);
  }
  assert.ok(script.includes("'ytd-reel-shelf-renderer'"), 'the script should consider the reel shelf');
  assert.ok(script.includes("'ytd-rich-shelf-renderer'"), 'the script should consider the rich shelf');
});

test('a Short card and the section that spaces the shelf are hidden too', () => {
  for (const selector of ['ytm-shorts-lockup-view-model', 'ytd-rich-section-renderer']) {
    assert.ok(css.includes(selector), `the stylesheet should account for ${selector}`);
    assert.ok(script.includes(selector), `the script should account for ${selector}`);
  }
  // A Short mixed into an ordinary list is only identifiable by its badge.
  assert.ok(
    css.includes('overlay-style="SHORTS"') && script.includes('overlay-style="SHORTS"'),
    'the thumbnail Shorts badge must be used to hide list-feed Shorts'
  );
});

test('the channel page Shorts tab is hidden', () => {
  assert.ok(css.includes('yt-tab-shape[tab-title="Shorts"]'), 'the stylesheet should hide the tab');
  assert.ok(script.includes("'yt-tab-shape'"), 'the script should consider the tab');
});

test('hiding a Shorts surface is resolved to the element to hide', () => {
  // The shelf must take its section wrapper with it, or the grid keeps the row.
  assert.ok(script.includes('shelfContainer'), 'a shelf should be resolved through its wrapper');
  assert.ok(script.includes('shortsTarget'), 'one resolver should decide what each candidate means');
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
