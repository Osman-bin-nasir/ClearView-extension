/**
 * Blocking a channel from the two places the user actually is: the video's own ⋮
 * menu and a right-click.
 *
 * The resolution logic is pure and tested directly. The parts that live in the
 * content script are covered by STATIC checks on the shipped file, in the same
 * style as `content-shorts.test.js` — a content script has no module system, so
 * it cannot be imported here, and each static check pins an invariant that would
 * otherwise break the feature silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveContextTarget, unresolvableMessage } from '../src/background/context-menus.js';
import {
  DEFAULT_SUBMISSION_SOURCE,
  SUBMISSION_SOURCES,
  coerceSubmissionSource,
} from '../src/common/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(resolve(ROOT, 'src/content/youtube.js'), 'utf8');
const css = readFileSync(resolve(ROOT, 'src/content/youtube.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));

/** A page that records whether it was asked, and answers with `answer`. */
function page(answer = null) {
  const calls = [];
  return {
    calls,
    ask: async (tabId) => {
      calls.push(tabId);
      return answer;
    },
  };
}

const UC = 'UCabcdefghijklmnopqrstuv';

// ── Resolving a right-click ──────────────────────────────────────────────

test('a right-clicked channel link resolves without asking the page', async () => {
  const p = page();
  const { target, reason } = await resolveContextTarget(
    { linkUrl: 'https://www.youtube.com/@SomeHandle' },
    { id: 7 },
    p.ask
  );
  assert.deepEqual(target, { url: 'https://www.youtube.com/@SomeHandle', name: null, channelId: null });
  assert.equal(reason, 'channel-link');
  assert.deepEqual(p.calls, [], 'the URL already answered it');
});

test('a right-clicked video link is resolved from the page, never from the URL', async () => {
  // A watch URL carries no channel, so the only honest source is the page.
  const p = page({ url: '/@FromTheCard', name: 'From The Card' });
  const { target, reason } = await resolveContextTarget(
    { linkUrl: 'https://www.youtube.com/watch?v=abc123' },
    { id: 7 },
    p.ask
  );
  assert.equal(reason, 'page');
  assert.equal(target.url, '/@FromTheCard');
  assert.equal(target.name, 'From The Card');
  assert.deepEqual(p.calls, [7]);
});

test('a card whose channel has NO link resolves by its printed name alone', async () => {
  // YouTube's current grid: the channel is an attributed string carrying a click
  // command and no href. The target then has a name and no URL — and the name is
  // handed on as a NAME, never turned into a handle here.
  const p = page({ url: null, name: 'The Japanese Town' });
  const { target, reason } = await resolveContextTarget(
    { linkUrl: 'https://www.youtube.com/watch?v=abc123' },
    { id: 7 },
    p.ask
  );
  // `page-name`, not `page`: the card gave no link, so the target rests on the
  // printed name alone. The reasons are the diagnostic trail for "the menu did
  // nothing" reports, so a name-only resolution has to be distinguishable from a
  // card that carried a link.
  assert.equal(reason, 'page-name');
  assert.equal(target.url, null);
  assert.equal(target.name, 'The Japanese Town');
  assert.equal(target.handle, undefined, 'no handle may be invented from a name');
});

test('right-clicking the thumbnail artwork uses the page too', async () => {
  const p = page({ url: `/channel/${UC}`, name: 'Some Channel' });
  const { target } = await resolveContextTarget({ linkUrl: '' }, { id: 3 }, p.ask);
  assert.equal(target.url, `/channel/${UC}`);
});

test('a link that is not on YouTube is refused outright', async () => {
  // Blocking here would block whatever channel the page happens to be showing,
  // which is not what the user right-clicked.
  const p = page({ url: '/@SomeHandle', name: 'Some Handle' });
  const { target, reason } = await resolveContextTarget(
    { linkUrl: 'https://example.com/some-article' },
    { id: 7 },
    p.ask
  );
  assert.equal(target, null);
  assert.equal(reason, 'not-a-youtube-link');
  assert.deepEqual(p.calls, [], 'the page must not be consulted for a foreign link');
});

test('a video whose channel could not be read is reported, not guessed', async () => {
  const p = page(null);
  const { target, reason } = await resolveContextTarget(
    { linkUrl: 'https://www.youtube.com/watch?v=abc123' },
    { id: 7 },
    p.ask
  );
  assert.equal(target, null);
  assert.equal(reason, 'video-without-channel');
});

test('a right-click with nothing under it reports that, distinctly', async () => {
  const p = page(null);
  const { target, reason } = await resolveContextTarget({}, { id: 7 }, p.ask);
  assert.equal(target, null);
  assert.equal(reason, 'no-target');
});

test('a tab that cannot be asked yields no block rather than an exception', async () => {
  // `chrome.tabs.sendMessage` rejects on a page with no content script; the
  // worker's wrapper turns that into null.
  const { target, reason } = await resolveContextTarget(
    { linkUrl: 'https://www.youtube.com/watch?v=abc123' },
    {},
    async () => null
  );
  assert.equal(target, null);
  assert.equal(reason, 'video-without-channel');
});

test('when the page cannot answer, a CHANNEL page URL still resolves', async () => {
  // The fallback that needs no help from the content script: if the page IS a
  // channel's page, everything on it belongs to that channel, and the address
  // bar already names it. Without this, a tab running a stale content script
  // makes "Block" do nothing at all.
  const p = page(null);
  const { target, reason } = await resolveContextTarget(
    {
      linkUrl: 'https://www.youtube.com/watch?v=abc',
      pageUrl: 'https://www.youtube.com/@SomeHandle/videos',
    },
    { id: 7 },
    p.ask
  );
  assert.equal(target.url, 'https://www.youtube.com/@SomeHandle/videos');
  assert.equal(reason, 'page-url');
});

test('the clicked card wins over the page URL', async () => {
  const p = page({ url: '/@FromTheCard', name: 'From The Card' });
  const { target, reason } = await resolveContextTarget(
    {
      linkUrl: 'https://www.youtube.com/watch?v=abc',
      pageUrl: 'https://www.youtube.com/@PageChannel',
    },
    { id: 7 },
    p.ask
  );
  assert.equal(target.url, '/@FromTheCard');
  assert.equal(reason, 'page');
});

test('a VIDEO page URL is not a channel, so the refusal still stands', async () => {
  const p = page(null);
  const { target, reason } = await resolveContextTarget(
    { linkUrl: 'https://www.youtube.com/watch?v=abc', pageUrl: 'https://www.youtube.com/watch?v=abc' },
    { id: 7 },
    p.ask
  );
  assert.equal(target, null);
  assert.equal(reason, 'video-without-channel');
});

test('each unresolvable reason gets its own sentence', () => {
  const notYoutube = unresolvableMessage('not-a-youtube-link');
  const noChannel = unresolvableMessage('video-without-channel');
  assert.notEqual(notYoutube, noChannel);
  assert.match(notYoutube, /thumbnail|channel/i);
  assert.match(noChannel, /channel/i);
  assert.equal(unresolvableMessage('anything-else'), unresolvableMessage(undefined));
});

// ── The card's own ⋮ menu ────────────────────────────────────────────────

test('a CARD’s ⋮ menu gets the entry too, in BOTH menu shapes YouTube serves', () => {
  // The three-dot button on a card is the only menu the card has, and until this
  // existed the only way to block its channel was to open the video and use the
  // player's menu.
  assert.ok(script.includes('CARD_MENU_TRIGGER_SELECTOR'), 'the card’s own trigger must be recognised');
  assert.ok(
    /aria-label="More actions"/.test(script),
    'the current grid’s trigger label is the one read off a live card'
  );
  assert.ok(
    script.includes('yt-list-view-model[role="menu"]'),
    'the current grid opens a context SHEET — one of the two live shapes'
  );
  assert.ok(
    /dropdown\.querySelector\('ytd-menu-popup-renderer'\)/.test(script),
    'a SEARCH result card opens the classic menu; matching only the sheet left those untouched'
  );
  assert.ok(script.includes('scheduleMenuInjection(card)'), 'the card is recorded by the click that opened its menu');
  assert.ok(script.includes('blockCardChannel'), 'the card’s entry blocks the card’s channel');
  assert.ok(
    /container\.prepend\(buildMenuItem\(menuCard \? CARD_MENU_LABEL : WATCH_MENU_LABEL\)\)/.test(script),
    'both shapes get the entry prepended, worded for the menu it is going into'
  );
});

test('the Shorts player’s ⋮ gets the entry, into the sheet it actually opens', () => {
  // A live Short opens a `yt-sheet-view-model` inside the document-level popup
  // container — the same contextual sheet as a card’s, but without the menu’s
  // `role` on every build. The entry was found but never placed when the list
  // was matched only by role, so a Short’s three dots had no Block channel.
  assert.ok(
    /ytd-reel-video-renderer tp-yt-iron-dropdown/.test(script),
    'a Short’s menu may render inside the reels component rather than the popup container'
  );
  assert.ok(script.includes('function sheetList(root)'), 'the sheet list is resolved in one place');
  assert.ok(
    script.includes("root.querySelector('yt-sheet-view-model yt-list-view-model')"),
    'the list is found by its sheet when it carries no role="menu"'
  );
  assert.ok(/sheetList\(candidate\)/.test(script), 'menu detection uses the sheet list');
  assert.ok(/sheetList\(dropdown\)/.test(script), 'the injection target uses the same resolution');
});

test('the menu icon is built as NODES, never with innerHTML', () => {
  // youtube.com enforces Trusted Types (`require-trusted-types-for 'script'`), and
  // there `element.innerHTML = '…'` THROWS — which is how the entry came to be
  // built never: the icon assignment threw and the whole item with it.
  // The ASSIGNMENT is what throws; the word itself is only in comments here.
  assert.ok(!/\.innerHTML\s*=/.test(script), 'nothing may assign innerHTML: it throws under Trusted Types');
  assert.ok(script.includes('createElementNS'), 'the icon is built with createElementNS instead');
});

// ── The submission source the backend accepts ────────────────────────────
//
// The regression this guards: the client used to send `source: 'extension'`,
// which is not one of the server's enum values — and because the server's body
// schema is `.strict()`, every suggestion built that way was refused with
// `invalid_request` before it was ever recorded.

test('only the backend’s own source values are ever sent', () => {
  for (const value of ['youtube_not_interested', 'app', 'unknown']) {
    assert.equal(coerceSubmissionSource(value), value);
  }
  for (const value of ['extension', 'web', '', null, undefined, 'APP', 42]) {
    assert.equal(coerceSubmissionSource(value), DEFAULT_SUBMISSION_SOURCE, String(value));
  }
});

test('the shipped source list has no extra values the server would refuse', () => {
  assert.deepEqual([...SUBMISSION_SOURCES], ['youtube_not_interested', 'app', 'unknown']);
});

// ── Static guards on the menu injection ──────────────────────────────────

test('the ⋮ menu injection is scoped to the watch page’s own menu', () => {
  // The page has several menu renderers (the guide, every card, the player).
  // Injecting into whichever dropdown happens to be open would put "Block this
  // channel" in the wrong menu.
  assert.ok(
    script.includes("document.querySelectorAll('ytd-watch-metadata tp-yt-iron-dropdown')"),
    'the dropdown lookup must be scoped to ytd-watch-metadata'
  );
  assert.ok(
    /closest\('ytd-watch-metadata ytd-menu-renderer button/.test(script),
    'the trigger must be inside the watch metadata’s own menu renderer'
  );
  // The document-level fallback must stay behind the scoped lookup, and must
  // still insist on a MENU popup rather than a dialog.
  const scopedAt = script.indexOf("'ytd-watch-metadata tp-yt-iron-dropdown'");
  const fallbackAt = script.indexOf("'ytd-popup-container tp-yt-iron-dropdown'");
  assert.ok(scopedAt !== -1 && fallbackAt > scopedAt, 'the scoped lookup must come first');
  assert.ok(
    script.includes("dropdown.querySelector('ytd-menu-popup-renderer')"),
    'the fallback must still require a menu popup'
  );
});

test('the injected item is plain DOM, not one of YouTube’s managed elements', () => {
  // Appending a `ytd-menu-service-item-renderer` would hand the node to
  // YouTube's Polymer, which upgrades and can discard it — an entry that
  // disappears when the framework takes over.
  assert.ok(script.includes("document.createElement('button')"), 'the item must be a plain button');
  assert.ok(
    !/createElement\('ytd-/.test(script),
    'the item must not be built from YouTube’s custom elements'
  );
  assert.ok(css.includes('.cv-menu-item'), 'the item must be styled by the injected stylesheet');
});

test('the entry cannot be injected twice, and only while the menu is open', () => {
  assert.ok(/container\.querySelector\(`\.\$\{MENU_ITEM_CLASS\}`\)/.test(script), 'a duplicate guard is required');
  assert.ok(script.includes('MENU_WINDOW_MS'), 'injection must be time-bounded to the menu that was opened');
});

test('the injection RETRIES, rather than relying on the mutation observer alone', () => {
  // The observer watches child list changes, and opening a dropdown can be a
  // style/attribute change with no children added — in which case the observer
  // never fires and the entry silently never appears. The retry is what makes
  // the feature work across both shapes; losing it would look like "the block
  // option is missing" with nothing else wrong.
  // The retry now carries the CARD whose ⋮ was clicked (`scheduleMenuInjection(card)`),
  // because the entry has to know which channel it belongs to — the sheet renders
  // in a document-level container, not inside the card.
  assert.ok(
    /function scheduleMenuInjection\(card = null\)/.test(script),
    'a bounded retry is required, and it carries the menu’s owner'
  );
  assert.ok(script.includes('menuRetryTimer = window.setTimeout(attempt, 150)'), 'the retry must be bounded');
  assert.ok(
    script.includes("'ytd-watch-metadata ytd-menu-renderer button"),
    'the retry must be started by a click on the watch menu trigger'
  );
  assert.ok(
    script.includes('scheduleMenuInjection();'),
    'and the trigger handler must actually call it'
  );
});

test('a display name is never promoted to a stored handle', () => {
  // A handle invented from a display name (`"The Japanese Town"` →
  // `@thejapanesetown`) matches nothing and blocks the wrong channel — or
  // nothing — and would be written to storage either way. The handle and the id
  // come from the URL; a name is stored as a name.
  const worker = readFileSync(resolve(ROOT, 'src/background/service-worker.js'), 'utf8');
  assert.ok(worker.includes("'channel/block'"), 'the worker must handle channel/block');
  assert.ok(
    worker.includes('channelIdentity({ url })'),
    'the block path must derive identity from the URL, and only from the URL'
  );
  assert.ok(
    !/handle:\s*(message|target|fromPage)\.name/.test(worker),
    'a display name must never be assigned to a handle'
  );
});

test('the context menu is registered on YouTube only, and is permissioned', () => {
  const source = readFileSync(resolve(ROOT, 'src/background/context-menus.js'), 'utf8');
  assert.ok(source.includes("documentUrlPatterns: ['*://*.youtube.com/*']"), 'YouTube-only by page URL');
  assert.ok(
    manifest.permissions.includes('contextMenus'),
    'the contextMenus permission is required for the menu to appear'
  );
});

test('a block is reported to the user, since neither entry point has UI of its own', () => {
  assert.ok(script.includes('showToast'), 'the content script must be able to report the outcome');
  assert.ok(css.includes('.cv-toast'), 'the toast must be styled');
  assert.ok(script.includes("'channel/blockResult'"), 'the worker must be able to reach the page');
});

test('a FAILURE is reported through the badge when the page cannot be told', () => {
  // If the tab has no live content script, the page's toast cannot appear — so a
  // failed block would produce no feedback anywhere, which is the exact
  // experience this guards against.
  const worker = readFileSync(resolve(ROOT, 'src/background/service-worker.js'), 'utf8');
  assert.ok(worker.includes('flagFailure'), 'a badge fallback is required');
  assert.ok(/setBadgeText/.test(worker), 'the badge is the backstop');
  assert.ok(
    /failure: true/.test(worker),
    'the flag must be raised on failure, not on success'
  );
});

test('the channel is found by the SHAPE of its link, not by an element path', () => {
  // A path-based lookup returns nothing the moment YouTube moves a wrapper, and
  // "nothing" here reads to the user as "Block did nothing".
  assert.ok(script.includes('CHANNEL_LINK_SELECTOR'), 'a shape-based selector is required');
  for (const shape of ['a[href^="/@"]', 'a[href^="/channel/"]', 'a[href^="/c/"]', 'a[href^="/user/"]']) {
    assert.ok(script.includes(shape), `the selector must cover ${shape}`);
  }
  assert.ok(script.includes('OWNER_ROOTS'), 'the owner lookup must try several roots, not one path');
  assert.ok(
    script.includes('watchIdentityFromPlayerResponse'),
    'a fallback independent of markup is required'
  );
  assert.ok(
    /function readCardChannel[\s\S]{0,1200}CHANNEL_LINK_SELECTOR/.test(script),
    'a feed card must fall back to the shape too'
  );
});
