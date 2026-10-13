import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateUrl, evaluateFeedCards } from '../src/background/blocking.js';
import { MatchType } from '../src/common/matching.js';

/** A minimal state object shaped like the worker's live state. */
function state(overrides = {}) {
  return {
    settings: {
      protectionEnabled: true,
      brainBotEnabled: true,
      brainBotMode: 'overlay',
      ...overrides.settings,
    },
    bundle: {
      builtIn: ['porn'],
      domains: ['pornhub.com'],
      everywhere: ['instagram'],
      youtube: ['instagram'],
      channels: ['@blockedchannel'],
      ...overrides.bundle,
    },
  };
}

test('protection off allows everything', () => {
  const s = state({ settings: { protectionEnabled: false } });
  assert.deepEqual(evaluateUrl('https://www.pornhub.com/x', s), { action: 'allow' });
  assert.deepEqual(evaluateUrl('https://www.google.com/search?q=porn', s), { action: 'allow' });
});

test('a blocked search is redirected, and normal searches are not', () => {
  const s = state();
  const blocked = evaluateUrl('https://www.google.com/search?q=porn', s);
  assert.equal(blocked.action, 'search');
  assert.equal(blocked.engine, 'google');

  assert.deepEqual(evaluateUrl('https://www.google.com/search?q=recipes', s), { action: 'allow' });
});

test('a blocked query on Bing, DuckDuckGo and YouTube is caught', () => {
  const s = state();
  for (const url of [
    'https://www.bing.com/search?q=porn',
    'https://duckduckgo.com/?q=porn',
    'https://www.youtube.com/results?search_query=porn',
  ]) {
    assert.equal(evaluateUrl(url, s).action, 'search', url);
  }
});

test('a blocked host is blocked', () => {
  const s = state();
  const decision = evaluateUrl('https://www.pornhub.com/watch/123', s);
  assert.equal(decision.action, 'block');
  assert.equal(decision.matchType, MatchType.DOMAIN);
});

test('a user keyword inside a URL is blocked', () => {
  const s = state();
  const decision = evaluateUrl('https://instagram.com/someone', s);
  assert.equal(decision.action, 'block');
  assert.equal(decision.matchType, MatchType.USER_KEYWORD);
});

test('an ordinary page is allowed', () => {
  const s = state();
  assert.deepEqual(evaluateUrl('https://example.com/news', s), { action: 'allow' });
});

// ── Shorts blocking (app parity: `blockShorts`) ──────────────────────────

test('a Shorts URL is blocked only while the Shorts control is on', () => {
  const off = state();
  assert.equal(evaluateUrl('https://www.youtube.com/shorts/abc123', off).action, 'allow');

  const on = state({ settings: { blockShorts: true } });
  const decision = evaluateUrl('https://www.youtube.com/shorts/abc123', on);
  assert.equal(decision.action, 'block');
  assert.equal(decision.reason, 'shorts');
});

test('the Shorts control never blocks ordinary YouTube', () => {
  const s = state({ settings: { blockShorts: true } });
  assert.deepEqual(evaluateUrl('https://www.youtube.com/watch?v=abc', s), { action: 'allow' });
  assert.deepEqual(evaluateUrl('https://www.youtube.com/', s), { action: 'allow' });
});

test('the Shorts control is inert when protection is off', () => {
  const s = state({ settings: { blockShorts: true, protectionEnabled: false } });
  assert.equal(evaluateUrl('https://www.youtube.com/shorts/abc', s).action, 'allow');
});

// ── Brain Bot feed evaluation ────────────────────────────────────────────

test('feed cards match on title and on channel', () => {
  const s = state();
  const blocked = evaluateFeedCards(
    [
      { title: 'a quiet documentary', channel: 'Nature Channel' },
      { title: 'porn compilation', channel: 'Something' },
      { title: 'cooking tips', channel: 'BlockedChannel' },
    ],
    s
  );
  assert.deepEqual(
    blocked.map((b) => b.index),
    [1, 2]
  );
  assert.equal(blocked[0].via, 'title');
  assert.equal(blocked[1].via, 'channel');
});

test('feed evaluation is inert when Brain Bot is off or protection is off', () => {
  const cards = [{ title: 'porn compilation', channel: 'x' }];
  assert.deepEqual(evaluateFeedCards(cards, state({ settings: { brainBotEnabled: false } })), []);
  assert.deepEqual(evaluateFeedCards(cards, state({ settings: { protectionEnabled: false } })), []);
});

test('unrelated cards are never touched', () => {
  const s = state();
  const blocked = evaluateFeedCards(
    [{ title: 'how to bake bread', channel: 'Baking Weekly' }],
    s
  );
  assert.deepEqual(blocked, []);
});

// ── Blocked channels: the channel's own pages ────────────────────────────

const UC = 'UCabcdefghijklmnopqrstuv';

/** A state with a channel blocked by handle AND one blocked by id. */
function channelState(overrides = {}) {
  return state({
    bundle: {
      channels: ['@blockedchannel'],
      channelIds: [UC],
      ...overrides.bundle,
    },
    settings: overrides.settings,
  });
}

test('a blocked channel’s page is blocked, in every URL shape it has', () => {
  const s = channelState();
  for (const url of [
    'https://www.youtube.com/@BlockedChannel',
    'https://www.youtube.com/@blockedchannel/videos',
    'https://www.youtube.com/c/BlockedChannel',
    'https://www.youtube.com/user/BlockedChannel',
    'https://m.youtube.com/@BlockedChannel/streams',
  ]) {
    const decision = evaluateUrl(url, s);
    assert.equal(decision.action, 'block', url);
    assert.equal(decision.reason, 'channel', url);
    assert.equal(decision.matchedItem, '@blockedchannel', url);
  }
});

test('a channel blocked by its id is blocked too', () => {
  const s = channelState();
  const decision = evaluateUrl(`https://www.youtube.com/channel/${UC}/videos`, s);
  assert.equal(decision.action, 'block');
  assert.equal(decision.matchedItem, UC);
});

test('an unblocked channel page is left alone', () => {
  const s = channelState();
  assert.deepEqual(evaluateUrl('https://www.youtube.com/@someoneelse', s), { action: 'allow' });
  assert.deepEqual(
    evaluateUrl(`https://www.youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz`, s),
    { action: 'allow' }
  );
});

test('a VIDEO page is not blocked by the URL evaluator, by design', () => {
  // A watch URL names no channel, so the worker cannot decide it — the content
  // script reads the channel off the page and asks. Asserting the split here
  // stops someone "fixing" this by guessing from the URL.
  const s = channelState();
  assert.deepEqual(evaluateUrl('https://www.youtube.com/watch?v=abc123', s), { action: 'allow' });
});

test('the channel check is inert when protection is off', () => {
  const s = channelState({ settings: { protectionEnabled: false } });
  assert.deepEqual(evaluateUrl('https://www.youtube.com/@BlockedChannel', s), { action: 'allow' });
});

// ── Blocked channels: the feeds ──────────────────────────────────────────

test('a blocked channel is filtered even with Brain Bot switched off', () => {
  // The Brain Bot toggle governs the KEYWORD filters. An explicit block is the
  // user's own decision and must not be undone by a switch with another job.
  const s = channelState({ settings: { brainBotEnabled: false } });
  const blocked = evaluateFeedCards(
    [
      { title: 'a quiet documentary', channel: 'BlockedChannel' },
      { title: 'a quiet documentary', channel: 'Someone Else' },
    ],
    s
  );
  assert.deepEqual(blocked.map((b) => b.index), [0]);
  assert.equal(blocked[0].via, 'channel');
});

test('a blocked channel is matched through its LINK, not just its name', () => {
  const s = channelState();
  const blocked = evaluateFeedCards(
    [
      // A name that would collapse to a DIFFERENT handle, with the link that is
      // the real identity. The link has to win.
      { title: 'something', channel: 'Unrelated Name', channelUrl: '/@BlockedChannel' },
      { title: 'something', channel: 'Unrelated Name', channelUrl: `/channel/${UC}` },
    ],
    s
  );
  assert.deepEqual(blocked.map((b) => b.index), [0, 1]);
  assert.equal(blocked[1].matchedItem, UC);
});

test('an explicit channel block is not affected by the display mode', () => {
  // It is reported as a channel match whatever the mode; the content script
  // removes those cards rather than overlaying them.
  for (const mode of ['remove', 'overlay']) {
    const s = channelState({ settings: { brainBotMode: mode } });
    const blocked = evaluateFeedCards([{ title: 'x', channel: 'BlockedChannel' }], s);
    assert.equal(blocked[0].via, 'channel', mode);
  }
});

test('no channel rules means feeds are judged by keywords alone', () => {
  const s = state({ settings: { brainBotEnabled: false } });
  assert.deepEqual(evaluateFeedCards([{ title: 'porn compilation', channel: 'x' }], s), []);
});

test('protection off filters nothing, however many channels are blocked', () => {
  const s = channelState({ settings: { protectionEnabled: false } });
  assert.deepEqual(evaluateFeedCards([{ title: 'x', channel: 'BlockedChannel' }], s), []);
});
