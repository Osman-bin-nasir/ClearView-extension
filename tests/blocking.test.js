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

test('the SAME phrase is judged the same way on any site’s search', () => {
  // The phrase tier ("woman" + "bikini") applies to a TYPED QUERY and is
  // deliberately skipped for a URL, so /photos/beach.html cannot trip it. Only
  // the named engines' queries reached it once, which made the same phrase block
  // on Google and pass on a Reddit or Amazon search. Same technique, so the same
  // verdict — and the same named match, or the two have not really converged.
  const s = state();
  const google = evaluateUrl('https://www.google.com/search?q=woman+bikini', s);
  assert.equal(google.action, 'search');
  assert.equal(google.matchedItem, 'woman + bikini');

  for (const url of [
    'https://www.reddit.com/search/?q=woman+bikini',
    'https://twitter.com/search?q=woman+bikini',
    'https://www.amazon.com/s?k=woman+bikini',
    'https://www.ebay.com/sch/i.html?_nkw=woman+bikini',
    'https://yandex.com/search/?text=woman+bikini',
    'https://ablog.example.com/?s=woman+bikini',
  ]) {
    const decision = evaluateUrl(url, s);
    assert.equal(decision.action, 'search', url);
    assert.equal(decision.matchedItem, google.matchedItem, url);
  }

  // A PATH that merely contains the two halves is still not a search: the URL
  // check keeps its own, weaker rule.
  assert.deepEqual(evaluateUrl('https://example.com/photos/beach.html', s), { action: 'allow' });
  // And a parameter that is not a search parameter is not judged as one.
  assert.deepEqual(evaluateUrl('https://example.com/page?utm_source=woman+bikini', s), { action: 'allow' });
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

test('a card that gives only the channel NAME is filtered, not left in place', () => {
  // YouTube's current grid gives a card no channel link at all — the channel is
  // an attributed string with a click command — so the printed name is the only
  // signal there is, and a blocked channel stayed in the feed without it.
  const s = state({ bundle: { channels: [], channelNames: ['the japanese town'] } });
  const blocked = evaluateFeedCards(
    [
      { title: 'a quiet documentary', channel: 'the   JAPANESE town' },
      { title: 'something else', channel: 'Another Channel' },
    ],
    s
  );
  assert.deepEqual(blocked.map((b) => b.index), [0]);
  assert.equal(blocked[0].via, 'channel');
});

test('feed evaluation is inert when Brain Bot is off or protection is off', () => {
  const cards = [{ title: 'porn compilation', channel: 'x' }];
  assert.deepEqual(evaluateFeedCards(cards, state({ settings: { brainBotEnabled: false } })), []);
  assert.deepEqual(evaluateFeedCards(cards, state({ settings: { protectionEnabled: false } })), []);
});

test('a blocked channel is still filtered when Brain Bot is off, and a keyword is not', () => {
  const s = state({ settings: { brainBotEnabled: false } });
  const blocked = evaluateFeedCards(
    [
      { title: 'porn compilation', channel: 'Someone' },
      { title: 'cooking tips', channel: 'BlockedChannel' },
    ],
    s
  );
  assert.deepEqual(blocked.map((b) => b.index), [1]);
  assert.equal(blocked[0].via, 'channel');
});

test('unrelated cards are never touched', () => {
  const s = state();
  const blocked = evaluateFeedCards(
    [{ title: 'how to bake bread', channel: 'Baking Weekly' }],
    s
  );
  assert.deepEqual(blocked, []);
});

test('a blocked search on ANY site is redirected to the safe page, query left behind', async () => {
  // The pipeline, not only the decision: `evaluateUrl` says "search", and this is
  // what the worker then DOES with it. Asserting the decision alone would let the
  // two drift — a search that is decided correctly and then lands on the blocked
  // page is not the behaviour anyone asked for.
  const { handleNavigation } = await import('../src/background/blocking.js');
  const { SAFE_SEARCH_DESTINATION } = await import('../src/common/search-engines.js');

  const calls = [];
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { getURL: (path) => `chrome-extension://clearview/${path}` },
    tabs: { update: async (tabId, options) => { calls.push({ tabId, url: options.url }); } },
  };
  try {
    // A search typed on a site with no rule of its own — the case that used to be
    // judged as a URL and let through.
    const search = await handleNavigation(
      { frameId: 0, tabId: 11, url: 'https://www.reddit.com/search/?q=woman+bikini' },
      state()
    );
    assert.equal(search.action, 'search');
    assert.equal(search.applied, true);
    assert.equal(calls.at(-1).url, SAFE_SEARCH_DESTINATION);
    assert.equal(new URL(calls.at(-1).url).searchParams.get('q'), null, 'the query is never carried over');
    assert.ok(!calls.at(-1).url.startsWith('chrome-extension://'), 'a search goes to the safe page, not the blocked page');

    // And the other half of the same mechanism still works: a keyword in a PATH,
    // on a site we do not recognise, still lands on the extension's own page.
    const path = await handleNavigation(
      { frameId: 0, tabId: 12, url: 'https://example.com/porn/video' },
      state()
    );
    assert.equal(path.action, 'block');
    assert.equal(calls.at(-1).url, 'chrome-extension://clearview/src/blocked/blocked.html?reason=keyword');
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('a search typed into a SITE’S OWN search box is caught, not only a page load', async () => {
  // The report, in the reporter's words: "on YouTube when I search this it still
  // doesn't redirect me". Typing in YouTube's search box never leaves the
  // document — YouTube rewrites the address itself with history.pushState — so it
  // fires NO navigation event, and a blocker that listened only to
  // onBeforeNavigate never saw the query. The URL was right and the rules
  // matched; nothing ever asked. This drives the real listener, with the real
  // URL, the way YouTube delivers it.
  const { initBlocker } = await import('../src/background/blocking.js');
  const { YOUTUBE_HOME } = await import('../src/common/search-engines.js');

  const listeners = { before: [], history: [] };
  const calls = [];
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { getURL: (path) => `chrome-extension://clearview/${path}` },
    tabs: { update: async (tabId, options) => { calls.push({ tabId, url: options.url }); } },
    webNavigation: {
      onBeforeNavigate: { addListener: (fn) => listeners.before.push(fn) },
      onHistoryStateUpdated: { addListener: (fn) => listeners.history.push(fn) },
    },
  };
  const blocked = [];
  const live = { ...state(), ready: true };
  try {
    initBlocker({ getState: async () => live, onBlocked: (outcome, url) => blocked.push({ outcome, url }) });

    assert.equal(listeners.before.length, 1, 'a document navigation is evaluated');
    assert.equal(listeners.history.length, 1, 'and so is a same-document one');

    // The exact URL from the report, delivered as YouTube delivers it.
    await listeners.history[0]({
      frameId: 0,
      tabId: 21,
      url: 'https://www.youtube.com/results?search_query=men+pics',
    });
    assert.equal(calls.length, 1, 'the tab must actually be moved');
    // A search made ON YouTube lands back on YouTube — not on Google's safe
    // page. Same block, and the destination follows the surface searched on.
    assert.equal(calls[0].url, YOUTUBE_HOME);
    assert.equal(calls[0].tabId, 21);
    assert.equal(new URL(calls[0].url).searchParams.get('search_query'), null, 'the query is never carried over');
    assert.equal(blocked.at(-1).outcome.action, 'search');
    assert.equal(blocked.at(-1).outcome.matchedItem, 'men + pics');

    // A same-document update that is clean leaves the tab where it is.
    await listeners.history[0]({
      frameId: 0,
      tabId: 22,
      url: 'https://www.youtube.com/results?search_query=lofi+beats',
    });
    assert.equal(calls.length, 1, 'a clean search must not move the tab');

    // A subframe is never the tab's own address, so it is not evaluated.
    await listeners.history[0]({
      frameId: 7,
      tabId: 23,
      url: 'https://www.youtube.com/results?search_query=men+pics',
    });
    assert.equal(calls.length, 1, 'a subframe update must not move the tab');
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
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
  // applies the same cover-or-remove presentation to it as to a keyword match.
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
