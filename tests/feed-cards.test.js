/**
 * Regression guards for reading and remembering YouTube feed cards.
 *
 * The content script is a classic script with no module system, so it cannot be
 * imported and tested directly — these are STATIC checks on the shipped
 * artefact. Each one pins a failure that actually shipped:
 *
 *  - a card's title was read from `#video-title`, which the current grid does
 *    not have, so a title keyword filter had nothing to match and looked broken;
 *  - a card with no channel link gave no channel at all, so a channel the user
 *    had blocked kept playing in the feed;
 *  - a card judged clean was never judged again, so a block made afterwards
 *    never reached it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(resolve(ROOT, 'src/content/youtube.js'), 'utf8');
const worker = readFileSync(resolve(ROOT, 'src/background/service-worker.js'), 'utf8');

test('the title is read from the current grid as well as from the classic card', () => {
  assert.ok(script.includes('#video-title'), 'the classic title id must still be read');
  assert.ok(
    script.includes('ytLockupMetadataViewModelTitle'),
    'the current grid titles a card with a class, not an id'
  );
  assert.ok(
    /h3\[title\], h3\[aria-label\]/.test(script),
    'a heading carrying its text as an attribute is the documented last resort'
  );
});

test('a card with no channel link falls back to the name it prints', () => {
  assert.ok(script.includes('readMetadataChannelName'), 'the metadata row is that fallback');
  assert.ok(
    script.includes('ytContentMetadataViewModelMetadataRow'),
    'the byline row is where a channel name lives in the current grid'
  );
  assert.ok(
    /if \(segments\.length !== 1\) continue;/.test(script),
    'the byline is the one-segment row; a views/age row must not be read as a name'
  );
  assert.ok(
    script.includes('return { title: readCardTitle(element), ...readCardChannel(element) };'),
    'every card must carry a title, a name and whatever link it has'
  );
});

/**
 * The shipped metric pattern, taken out of the script itself.
 *
 * A copy of it here would pass while the real one rotted, so the check RUNS the
 * pattern the extension ships — the strings below are the ones live YouTube
 * cards were seen to print.
 */
function shippedMetricPattern() {
  const found = /const METRIC_TEXT =\s*\n?\s*(\/[\s\S]*?\/[a-z]*);/.exec(script);
  assert.ok(found, 'the metric guard must be a literal in the shipped script');
  const literal = found[1];
  const end = literal.lastIndexOf('/');
  return new RegExp(literal.slice(1, end), literal.slice(end + 1));
}

test('a row that states a NUMBER is never read as a channel name', () => {
  // The byline is the row with ONE text segment — and so is a view count. On a
  // channel's own grid the only metadata row is `777K · 8d ago`, and a right
  // click that read `777K` off it would store a block that matches nothing.
  const metric = shippedMetricPattern();
  for (const value of [
    '777K',
    '17K watching',
    '2.5K watching',
    '15.8M subscribers',
    '1.2M views',
    '8d ago',
    '3 weeks ago',
    'Streamed 2 days ago',
    '1:04:42',
  ]) {
    assert.ok(metric.test(value), `“${value}” must be read as a number, not a name`);
  }
  for (const value of [
    'Lofi Girl',
    'The Japanese Town',
    '60 Minutes',
    'MKBHD',
    'MrBeast',
    '777',
    '1 Day in Tokyo',
    'Ninja',
  ]) {
    assert.ok(!metric.test(value), `“${value}” must still be readable as a channel name`);
  }
  assert.ok(
    /METRIC_TEXT\.test\(first\) \? '' : first/.test(script),
    'the last-resort fallback must refuse a number too'
  );
});

test('a channel RESULT in a search is a card like any other', () => {
  // Searching a blocked channel's name showed its avatar and its Subscribe
  // button, because a channel result was never evaluated at all.
  assert.ok(
    script.includes("'ytd-channel-renderer'"),
    'the search channel result must be a card the script evaluates'
  );
  assert.ok(
    /element\.querySelector\('ytd-channel-name a/.test(script),
    'the name-bearing link must be preferred over the avatar link'
  );
  assert.ok(
    script.includes('readPrintedChannelName'),
    'a link with no text on it still has to yield the printed name'
  );
  assert.ok(script.includes('#channel-title'), 'the channel result’s own name spot is read as its title');
});

test('the ⋮ menu entry is placed where it can be seen without scrolling', () => {
  // The label is passed in: a CARD's menu is narrower than the video page's, so
  // the two entries are worded for the space they have.
  assert.ok(
    /container\.prepend\(buildMenuItem\(menuCard \? CARD_MENU_LABEL : WATCH_MENU_LABEL\)\)/.test(script),
    'an entry at the bottom of a scrolling menu is one the user has to hunt for'
  );
});

test('a channel page is checked by NAME as well, so a name-only block covers it', () => {
  // A channel page's URL carries only the handle, so a block stored by name
  // would otherwise let the channel's own page open.
  assert.ok(script.includes('channelPageName'), 'the page’s printed name must be readable');
  assert.ok(script.includes('isChannelPagePath'), 'the channel page shapes must be recognised');
  assert.ok(
    script.includes("send('channel/check', { url, name })"),
    'the page and its name must both go to the worker'
  );
});

test('the worker tells the page when the rules changed, without giving it the rules', () => {
  assert.ok(
    worker.includes('revision: rulesFingerprint('),
    'rules/forContent must carry an opaque revision'
  );
});

test('a card is judged again when the rules change, not remembered forever', () => {
  assert.ok(script.includes('decidedByCurrentRules'), 'a stale verdict must be detectable');
  // The comparison now reads the record out first, because the revision is no
  // longer the whole test: a decision is also stale once its effect has left
  // the page (see brainbot-overlay.test.js). The guarantee is unchanged — a
  // record is still judged against the revision in force.
  assert.ok(
    /record\.revision !== config\.revision/.test(script),
    'a record must be compared against the revision in force'
  );
  assert.ok(
    /record\.revision = config\.revision;/.test(script),
    'every applied verdict must stamp the revision it was decided under'
  );
  assert.ok(
    /handled\.set\(element, \{[\s\S]{0,80}mode: 'clean',[\s\S]{0,80}revision: config\.revision,[\s\S]{0,80}identity: cardIdentity\(element\)/.test(
      script
    ),
    'a clean verdict must be stamped with the revision AND the identity it belongs to'
  );
});

test('removing a card is not undone by its own cleanup', () => {
  // An untouched card's inline display is '' — so restoring it "because it was
  // recorded" re-showed the card that had just been hidden, and a blocked
  // channel's video kept playing in the feed.
  assert.ok(script.includes('function hideCard'), 'hiding must remember what it replaced');
  assert.ok(
    /removeOverlay\(record, element\);\s*hideCard\(record, element\);/.test(script),
    'the cleanup must run BEFORE the hide, not after it'
  );
  assert.ok(
    /if \(record\?\.hidden\) \{\s*element\.style\.display = record\.previousDisplay \?\? ''/.test(script),
    'the display may only be restored when this script is what hid the card'
  );
});

test('a card that is clean again is restored before it is marked clean', () => {
  // The verdict that justified an overlay or a hidden card can disappear while
  // the card itself is off screen; coming back clean must undo it.
  assert.ok(script.includes('function restoreCard'), 'restoring one card is the unit of work');
  assert.ok(script.includes('function markCardClean'), 'the clean path is one helper, so it cannot drift');
  assert.ok(
    /function markCardClean\(element\)[\s\S]{0,260}restoreCard\(element\);/.test(script),
    'the clean path must restore the card first'
  );
  assert.ok(
    /function markCardClean\(element\)[\s\S]{0,320}handled\.set\(element, \{[\s\S]{0,80}mode: 'clean'/.test(script),
    'and only then record the clean verdict'
  );
  assert.ok(
    /function reset\(\) \{[\s\S]{0,800}for \(const element of cardElements\(\)\) \{[\s\S]{0,140}restoreCard\(element\);/.test(
      script
    ),
    'a full reset must go through the same restore, so the two cannot drift'
  );
});

test('the feed pass is bounded to what can be seen, and remembers verdicts', () => {
  // A feed can hold hundreds of cards, and most of them repeat a title the
  // worker has already judged. Both facts are used: off-screen cards wait for the
  // scroll pass, and an identity is asked about once per rules fingerprint.
  assert.ok(script.includes('const verdictCache'), 'decided identities are cached');
  assert.ok(script.includes('function nearViewport'), 'distance from the viewport is measured');
  assert.ok(
    /if \(!nearViewport\(element\)\) continue;/.test(script),
    'a card far off screen is left undecided rather than sent to the worker'
  );
  assert.ok(
    /if \(applyCachedVerdict\(element, card\)\) \{/.test(script),
    'a cached verdict is applied without a round-trip'
  );
  assert.ok(/rememberVerdict\(card, verdict\)/.test(script), 'blocked verdicts are remembered');
  assert.ok(/rememberVerdict\(card, null\)/.test(script), 'and clean ones too, so they are not re-asked');
  assert.ok(/verdictCache\.clear\(\)/.test(script), 'a rules change clears the cache');
  assert.ok(
    /addEventListener\('scroll', scheduleScan/.test(script),
    'scrolling brings the cards that were skipped near the viewport'
  );
});

test('Remove mode settles the cards its own layout shift reveals', () => {
  // Hiding a blocked card collapses its grid cell and pulls the next row into
  // view. That is a STYLE change, so the child-list MutationObserver does not
  // fire and no scroll happened — the newly visible cards were never judged. A
  // blocked channel’s Shorts stayed on its channel page, visible, until the user
  // scrolled. The scan therefore chains one more pass while Remove mode still
  // has an undecided card near the viewport.
  assert.ok(
    script.includes('function hasUndecidedCardNearViewport'),
    'the removal pass needs to know whether the grid still has work'
  );
  assert.ok(
    /function hasUndecidedCardNearViewport\(\)[\s\S]{0,500}readCard\(element\)\.title === ''/.test(
      script
    ),
    'a title-less card must not spin the chain forever'
  );
  assert.ok(
    /function followUpAfterRemoval\(applied\)[\s\S]{0,200}config\.brainBotMode !== 'remove'/.test(
      script
    ),
    'only Remove mode changes the layout this way'
  );
  assert.ok(
    /followUpAfterRemoval\(applied\);/.test(script),
    'the scan must chain a pass after it has applied a decision'
  );
});

test('the legacy Shorts shelf card is a card, not only the modern lockup', () => {
  // YouTube still serves home/subscriptions Shorts as
  // `ytd-reel-shelf-renderer > ytd-reel-item-renderer`: a thumbnail link and a
  // title, with no `ytm-shorts-lockup-view-model` inside. It was therefore
  // neither evaluated nor coverable, so a blocked channel's Short stayed on
  // screen after a scroll and only the player refused it when clicked.
  assert.ok(
    /const CARD_SELECTOR = \[[\s\S]{0,900}'ytd-reel-item-renderer'/.test(script),
    'the legacy reel item must be judged like any other card'
  );
  assert.ok(
    /const CARD_SELECTOR = \[[\s\S]{0,900}'ytd-rich-grid-slim-media'/.test(script),
    'a Short in the slim rich grid must be judged too'
  );
  assert.ok(
    /const SHORTS_CANDIDATE_SELECTOR = \[[\s\S]{0,700}'ytd-reel-item-renderer'/.test(script),
    'the Shorts toggle must reach the legacy card even outside a known shelf'
  );
});

test('a card that is a BARE lockup is a card too', () => {
  // The channel home tab — and the home feed on accounts YouTube serves the bare
  // grid to — renders `yt-lockup-view-model` at the top level, with no
  // `ytd-rich-item-renderer` around it. Recognising only the renderers produced
  // two symptoms from one cause: the ⋮ menu got no ClearView entry at all (there
  // was no `closest(CARD_SELECTOR)` to record), and the card was never scanned,
  // so a channel blocked elsewhere kept appearing. Both were reported, verified
  // against a live page, and are pinned here.
  assert.ok(script.includes('LOCKUP_CARD_SELECTOR'), 'the bare lockup must be a known card shape');
  assert.ok(
    /const LOCKUP_CARD_SELECTOR = 'yt-lockup-view-model';/.test(script),
    'the lockup element is what YouTube renders on that grid'
  );
  assert.ok(
    /function cardElementFor\(node\)[\s\S]{0,240}closest\(LOCKUP_CARD_SELECTOR\)/.test(script),
    'the ⋮ click and the right-click must resolve the card the same way'
  );
  assert.ok(
    /const card = cardElementFor\(event\.target\);/.test(script),
    'the ⋮ click records the card it belongs to'
  );
  assert.ok(
    /const elements = cardElements\(\);/.test(script),
    'the scan must judge bare lockups as well'
  );
  assert.ok(
    /if \(!lockup\.closest\(CARD_SELECTOR\)\) elements\.push\(lockup\);/.test(script),
    'a lockup already covered by a renderer must NOT be evaluated a second time'
  );
});
