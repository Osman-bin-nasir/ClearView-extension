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

test('a Short in the reels player is a card like any other', () => {
  // The player is where a Short is actually WATCHED, so covering it is the only
  // way the overlay or Remove mode can act on one. Its title is not on a card:
  // the live player titles it with a `yt-shorts-video-title-view-model` h1, so
  // reading only the feed-lockup classes left it empty and an explicit keyword
  // could never match.
  assert.ok(script.includes("'ytd-reel-video-renderer'"), 'the reel must be a recognised card');
  assert.ok(
    script.includes('yt-shorts-video-title-view-model h1') &&
      script.includes('ytShortsVideoTitleViewModelShortsVideoTitle'),
    'the title must be read from the player’s current view model'
  );
  assert.ok(
    /function thumbnailHost[\s\S]{0,320}card\.localName === 'ytd-reel-video-renderer'/.test(script),
    'a Short has no thumbnail, so the cover belongs on its player'
  );
  assert.ok(
    /if \(element\.localName === 'ytd-reel-video-renderer'\) pauseShortPlayback\(element\)/.test(script),
    'a cover over a playing Short is not a block unless the video is paused'
  );
});

test('a Short in a feed shelf is judged too, and only once', () => {
  // A shelf Short is wrapped by a `ytd-rich-item-renderer` on the home feed, but
  // the channel page serves the lockup bare. Without it in `cardElements` a
  // blocked channel’s Short stayed in the shelf.
  assert.ok(script.includes('SHORTS_LOCKUP_SELECTOR'), 'the Shorts lockup must be a known card shape');
  assert.ok(
    /for \(const short of document\.querySelectorAll\(SHORTS_LOCKUP_SELECTOR\)\)/.test(script),
    'the scan must include Shorts lockups'
  );
  assert.ok(
    /!short\.closest\(CARD_SELECTOR\) && !short\.closest\(LOCKUP_CARD_SELECTOR\)/.test(script),
    'a Short already covered by a renderer must NOT be evaluated twice'
  );
  assert.ok(
    /function cardElementFor\(node\)[\s\S]{0,300}closest\(SHORTS_LOCKUP_SELECTOR\)/.test(script),
    'the right-click and ⋮ paths must resolve a shelf Short the same way'
  );
});

test('a recycled reel is re-judged when a swipe changes the Short', () => {
  // The live player reuses ONE `ytd-reel-video-renderer` for every swipe. The
  // element, its overlay and `data-cv-protected` all survive, so without an
  // identity the next Short was treated as already blocked: covered, paused and
  // impossible to play. This is the regression guard for that.
  assert.ok(script.includes('function cardIdentity'), 'a card needs an identity, not only an element');
  assert.ok(
    /record\.identity !== cardIdentity\(element\)/.test(script),
    'a changed identity must make the old decision stale'
  );
  assert.ok(
    /record\.identity = identity/.test(script),
    'every applied verdict must store the video it was decided for'
  );
  assert.ok(script.includes('function releaseStaleShorts'), 'a swipe must release the old cover immediately');
  assert.ok(script.includes('shownShortHref === location.href'), 'the release is keyed to the Shorts URL');
  assert.ok(
    /function scheduleScan\(\)[\s\S]{0,180}releaseStaleShorts\(\)/.test(script),
    'the mutation pass must release before it debounces'
  );
  assert.ok(script.includes('pausedByClearView'), 'only a pause this script made may be undone');
  assert.ok(script.includes('function resumeShortIfWePaused'), 'a clean Short must resume after a swipe');
  assert.ok(script.includes('markCardClean(element)'), 'clean verdicts go through the resuming path');
});

test('/shorts resolves the channel from the reel that is on screen', () => {
  // A /shorts/<id> URL names no channel. The reel’s header names it (the live
  // link is /@handle/shorts), and the page’s player response is the fallback.
  assert.ok(script.includes("location.pathname.startsWith('/shorts')"));
  assert.ok(script.includes('function shortsPageTarget'), 'the page target needs its own resolver');
  assert.ok(
    script.includes('return (visible ? cardChannelTarget(visible) : null) ?? watchIdentityFromPlayerResponse();'),
    'the on-screen reel wins, then the page’s own player response'
  );
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
