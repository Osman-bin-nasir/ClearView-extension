/**
 * Brain Bot's "Show protection overlay" mode, guarded at the seams.
 *
 * The content script has no module system to import, so — as with the other
 * page tests here — the shipped artefacts are checked statically. Comments are
 * stripped first, so prose about the behaviour cannot stand in for the
 * behaviour.
 *
 * Three product rules are pinned here, because each one failed silently when it
 * was wrong:
 *
 *  - the cover is drawn on the THUMBNAIL only, so the title and byline stay
 *    readable (a card-shaped fallback painted over the title);
 *  - a blocked channel and a keyword match are presented the SAME way, so a
 *    channel block is not silently turned into a removed card;
 *  - clicking a cover opens the video, and the video page blocks the PLAYER in
 *    place — paused behind a panel — while the description and comments remain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const script = strip(readFileSync(resolve(ROOT, 'src/content/youtube.js'), 'utf8'));
const css = strip(readFileSync(resolve(ROOT, 'src/content/youtube.css'), 'utf8'));
const constants = readFileSync(resolve(ROOT, 'src/common/constants.js'), 'utf8');

test('the overlay is drawn on the thumbnail — never over the title', () => {
  assert.ok(
    /function thumbnailHost\(card\)/.test(script),
    'the host is chosen by a helper, not by a bare querySelector fallback'
  );
  assert.ok(
    /if \(candidate === card \|\| candidate\.localName === 'img'\) continue;/.test(script) &&
      /if \(containsTitle\(candidate\)\) continue;/.test(script),
    'a candidate that contains the title (or is the image itself) is not a host'
  );
  assert.ok(script.includes('function containsTitle'), 'the title check must exist');
  assert.ok(
    /const \{ host, banner \} = thumbnailHost\(element\);/.test(script),
    'the overlay is placed only through that helper'
  );
  assert.ok(script.includes('host.appendChild(overlay)'), 'and it must actually be attached there');
  assert.ok(
    /const THUMBNAIL_SELECTOR = \[[\s\S]{0,200}'a#thumbnail'/.test(script),
    'the anchor that would play the video comes first'
  );
  assert.match(
    css,
    /\[data-cv-protected\] #video-title,[\s\S]{0,220}z-index: 2147483002;/,
    'the title is raised above the cover as a last line of defence'
  );
});

test('the feed cover names the reason, and the report action lives on the video', () => {
  assert.ok(
    script.includes("label.textContent = 'Blocked by ClearView'"),
    'the overlay says it is a block, not merely that something was hidden'
  );
  assert.ok(
    /reason\.textContent = reasonText\(verdict\);/.test(script) && script.includes('Matched “'),
    'and it names what matched — a block the user cannot account for is one they cannot judge'
  );
  assert.ok(
    /overlay\.append\(label, reason\);/.test(script),
    'the feed cover is a signpost: label and reason, nothing else'
  );
  assert.ok(
    !/overlay\.append\(label, reason, buildReportButton/.test(script),
    'reporting does not belong on a feed thumbnail'
  );

  assert.ok(script.includes('function buildReportButton'), 'the blocked player carries the report action');
  assert.ok(script.includes("button.textContent = 'Report false positive'"));
  assert.ok(
    /send\('report\/create'/.test(script) && /kind: verdict\.via === 'channel' \? 'channel' : 'keyword'/.test(script),
    'the report goes to the existing false-positive endpoint with the rule that matched'
  );
  assert.ok(
    /event\.preventDefault\(\);[\s\S]{0,160}event\.stopPropagation\(\);/.test(script),
    'a report click must not also resume the video'
  );
  assert.ok(
    /const report = buildReportButton\(verdict, \{[\s\S]{0,400}overlay\.append\(report\)/.test(script),
    'and it reaches the player block, where the video is'
  );
});

test('a report on the watch page carries the video, not only the rule', () => {
  // A channel name says which rule matched, never which video was covered —
  // so the administrator could not judge the report from a channel alone.
  assert.ok(script.includes('function currentVideoUrl'), 'a watch page reports its own video');
  assert.ok(
    /function reportDetail\(\{ videoUrl, title, channel \}\)/.test(script) &&
      /parts\.push\(`Video: \$\{videoUrl\}`\)/.test(script),
    'the detail line names the URL in a form the dashboard can parse'
  );
  assert.ok(
    /detail: reportDetail\(context\)/.test(script),
    'the report sends that line instead of inventing a field the backend schema refuses'
  );
  assert.ok(
    /videoUrl: currentVideoUrl\(\)/.test(script),
    'the player block reports the video that is actually open'
  );
});

test('a covered thumbnail can never play a hover preview', () => {
  // Covering the thumbnail is not enough: YouTube starts a muted inline preview
  // as the pointer rests on it, and a preview that keeps playing is playback.
  assert.ok(
    /const PREVIEW_SURFACE_SELECTOR =[\s\S]{0,260}ytd-video-preview,[\s\S]{0,260}#inline-preview-player/.test(script),
    'every shape the inline preview ships under is named'
  );
  assert.ok(script.includes('function stopHoverPreview'), 'and there is a pass that stops it');
  assert.ok(/video\.pause\(\)/.test(script) && /video\.muted = true/.test(script), 'pausing the element, not just hiding it');
  assert.ok(
    /document\.addEventListener\(\s*'mouseover'[\s\S]{0,260}closest\?\.\('\[data-cv-protected\]'\)/.test(script),
    'the pointer arriving on a covered card stops the preview at once'
  );
  assert.ok(
    /guardHoverPreviews\(\)/.test(script),
    'and every debounced pass sweeps the cards YouTube re-renders'
  );
  assert.match(
    css,
    /\[data-cv-protected\] video \{[\s\S]{0,80}display: none !important;[\s\S]{0,80}visibility: hidden !important;/,
    'the stylesheet hides the preview itself, by shape'
  );
});

test('a hover can neither wipe the cover nor keep a preview playing', () => {
  // The hover replaces the thumbnail's contents, taking the cover with it, and
  // YouTube can hang the preview off the page rather than inside the card — so
  // the card alone is not enough to police.
  assert.ok(
    /record\.verdict = verdict;/.test(script),
    'the decided verdict is kept on the record, for a rebuild without the worker'
  );
  assert.ok(script.includes('function reassertOverlay'), 'a wiped cover is rebuilt in place');
  assert.ok(
    /document\.addEventListener\(\s*'mouseover'[\s\S]{0,260}reassertOverlay\(card\)/.test(script),
    'the pointer arriving on a protected card restores the cover at once'
  );
  assert.ok(
    /function guardHoverPreviews\(\)[\s\S]{0,220}reassertOverlay\(card\)/.test(script),
    'and so does every pass, whether or not a pointer event was seen'
  );

  assert.ok(script.includes('const PROTECTED_HOVER_CLASS'), 'a page-wide hover lock exists');
  assert.ok(script.includes('function stopPagePreviews'), 'it hides preview surfaces outside the card too');
  assert.ok(
    /const card = event\.target\?\.closest\?\.\('\[data-cv-protected\]'\);[\s\S]{0,220}setProtectedHover\(true\)/.test(script),
    'the lock goes on when the pointer enters a protected card'
  );
  assert.ok(
    /addEventListener\(\s*'mouseout'[\s\S]{0,400}setProtectedHover\(false\)/.test(script),
    'and comes off when it leaves, so other cards keep their previews'
  );
  assert.ok(
    /setInterval\([\s\S]{0,700}, 120\)/.test(script),
    'a fast burst catches a preview created after the pointer arrived'
  );
  assert.match(
    css,
    /html\.cv-protected-hover ytd-video-preview,[\s\S]{0,320}#inline-preview-player[\s\S]{0,120}display: none !important;/,
    'the stylesheet blocks every preview surface page-wide while hovering'
  );

  // The last line of defence: a preview that starts between passes is paused as
  // it starts, and the real player is explicitly left alone.
  assert.ok(
    /video\.closest\('#movie_player'\)\) return;[\s\S]{0,900}video\.pause\(\)/.test(script),
    'a preview starting at any moment is paused, without touching the player'
  );
  assert.ok(
    /const protectedReel = video\.closest\('ytd-reel-video-renderer\[data-cv-protected\]'\);/.test(script),
    'a covered Short is checked before the player, because its reel lives inside #movie_player'
  );
  assert.ok(
    /const insideProtected = protectedReel \?\? video\.closest\('\[data-cv-protected\]'\);/.test(script) &&
      /hoverLock && video\.closest\(PREVIEW_SURFACE_SELECTOR\)/.test(script),
    'the guard is scoped to a protected card or the protected-card hover — not every preview on YouTube'
  );
});

test('the overlay is a dark scrim with a text action and readable type', () => {
  const overlay = css.slice(css.indexOf('.cv-block-overlay {'), css.indexOf('.cv-block-overlay__label'));
  assert.match(
    overlay,
    /background:\s*rgba\(4, 5, 6, 0\.97\)/,
    'the cover is a near-solid black, not a see-through scrim'
  );
  assert.doesNotMatch(overlay, /rgba\(0, 32, 28/, 'the old teal-tinted surface is gone');
  assert.doesNotMatch(overlay, /backdrop-filter/, 'nothing of the thumbnail may read through it');

  const label = css.slice(css.indexOf('.cv-block-overlay__label {'), css.indexOf('.cv-block-overlay__reason {'));
  assert.match(label, /font-size:\s*15px/, 'the block label is readable at thumbnail size');
  const reason = css.slice(css.indexOf('.cv-block-overlay__reason {'), css.indexOf('/*\n * The false-positive'));
  assert.match(reason, /font-size:\s*12\.5px/, 'and so is the reason');

  const report = css.slice(css.indexOf('.cv-block-overlay__report,'), css.indexOf('.cv-block-overlay__report:hover'));
  assert.match(report, /background:\s*transparent/, 'the report action is text, not a filled button');
  assert.match(report, /border:\s*0/, 'with no drawn box');
  assert.match(report, /text-decoration:\s*underline/, 'but still visibly actionable');
});

test('a blocked channel uses the same display mode as a keyword match', () => {
  // Forcing channels to be removed made the overlay appear for keywords but not
  // for the channel the user had just blocked — the card vanished before the
  // reason could be read.
  assert.ok(
    /const remove = config\.brainBotMode === 'remove';/.test(script),
    'only the user’s display mode decides between cover and removal'
  );
  assert.ok(
    !/verdict\.via === 'channel' \|\| config\.brainBotMode/.test(script),
    'a channel match must not be special-cased into removal'
  );
});

test('a decision is only in force while its effect is still on the page', () => {
  // The record says what the script DECIDED, not what the page shows. YouTube
  // re-stamps and re-attaches feed subtrees, and that takes the overlay with it:
  // trusting the record alone is how the overlay was built, wiped, and never
  // rebuilt while every later scan believed it was still there.
  assert.ok(
    /if \(record\.mode === 'overlay'\) return Boolean\(record\.overlay\?\.isConnected\);/.test(script),
    'an overlay decision is stale once the overlay has left the document'
  );
  assert.ok(
    /if \(record\.mode === 'remove'\) return element\.style\.display === 'none';/.test(script),
    'and a removal decision is stale once the card is visible again'
  );
  assert.ok(
    /if \(!record\.overlay \|\| !record\.overlay\.isConnected\)/.test(script),
    'the apply path must rebuild a wiped overlay rather than reuse the dead reference'
  );
});

test('a covered video opens, and its player is blocked in place', () => {
  // "Blocked" means the video does not play — not that the page is a dead end.
  // The description and comments stay readable, which is what makes the report
  // button on the block meaningful.
  assert.ok(/link\.click\(\)/.test(script), 'a click on the cover must still open the video');
  assert.ok(script.includes('rememberPendingBlock'), 'the click hands its verdict to the watch page');
  assert.ok(script.includes('takePendingBlock'), 'and the next page applies it before playback');
  assert.ok(script.includes("send('video/check'"), 'the watch page confirms with the worker');
  assert.ok(script.includes('function applyPlayerBlock'), 'the player itself is what gets blocked');
  assert.ok(/video\.pause\(\)/.test(script), 'the video must be paused');
  assert.ok(
    script.includes('document.documentElement.classList.add(VIDEO_BLOCKED_CLASS)'),
    'the page is marked so the stylesheet can hide the frame and controls'
  );
  assert.ok(
    /document\.addEventListener\(\s*'play'[\s\S]{0,400}event\.target\.pause\(\)/.test(script),
    'a blocked video must stay paused if anything asks it to play again'
  );
  assert.ok(
    script.includes('Comments and the description are still below.'),
    'the panel must say that the rest of the page is still usable'
  );
  assert.ok(!script.includes('refuseActivation'), 'a covered card is no longer a dead end');
});

test('the card’s own ⋮ stays above the overlay, so a block is never a trap', () => {
  assert.ok(
    /\[data-cv-protected\] ytd-thumbnail-overlay-toggle-button-renderer,[\s\S]{0,120}z-index: 2147483001 !important;/.test(
      css
    ),
    'the ⋮ opens a menu rather than playing anything, and Unblock lives in it'
  );
});

test('the stylesheet covers only the thumbnail and blocks the player in place', () => {
  const overlay = css.slice(css.indexOf('.cv-block-overlay {'), css.indexOf('.cv-block-overlay__label'));
  assert.match(overlay, /position:\s*absolute/, 'it has to cover the thumbnail');
  assert.match(overlay, /inset:\s*0/, 'edge to edge');
  assert.match(
    overlay,
    /z-index:\s*2147483000/,
    'a modest z-index let YouTube’s own thumbnail overlays sit above the block'
  );
  assert.match(overlay, /pointer-events:\s*auto/, 'a click on the block is a click on the video');

  assert.ok(/\.cv-block-overlay__report/.test(css), 'the report action must be styled');
  assert.ok(/\.cv-block-overlay--banner/.test(css), 'the no-thumbnail fallback must not cover the card');
  assert.ok(/\.cv-player-block \{/.test(css), 'the player block must be styled');
  assert.ok(
    /html\.cv-video-blocked #movie_player video/.test(css),
    'a blocked video frame must not peek out from behind the panel'
  );
  assert.ok(
    /\[data-cv-protected\] ytd-video-preview,/.test(css),
    'a hover preview YouTube already started keeps playing behind the overlay'
  );
  assert.ok(/\[data-cv-protected\] #mouseover-overlay,/.test(css), 'and its mouseover surface is hidden too');
});

test('both Brain Bot modes are still described the same way to the user', () => {
  assert.ok(/value: 'remove'/.test(constants) && /value: 'overlay'/.test(constants));
  assert.ok(
    /Matching videos stay in place, covered by a ClearView overlay\./.test(constants),
    'the overlay mode’s promise is unchanged'
  );
});
