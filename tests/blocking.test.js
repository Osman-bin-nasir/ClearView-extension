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
