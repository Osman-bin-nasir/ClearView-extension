/**
 * The right-click "Block this channel" flow, driven end to end.
 *
 * This exists because the flow spans four things that unit tests cannot see
 * together — the context-menu click, the message to the content script, the
 * identity parsing, and the write to settings — and a break anywhere in it looks
 * identical from the outside: "I chose Block and nothing was added."
 *
 * So the REAL service worker is imported here against a stubbed `chrome`, the
 * click Chrome would deliver is delivered, and the resulting storage write is
 * read back. Nothing is mocked in the code under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A `chrome` stub with only what the worker touches, plus a record of what it
 * was asked to do.
 */
function stubChrome({ pageReply = null, pageUnreachable = false } = {}) {
  const sync = {};
  const local = {};
  const menuItems = [];
  const messagesToTab = [];
  const onMessage = [];
  const onClicked = [];
  const badge = { text: '', title: '', color: '' };

  const area = (store) => ({
    async get(key) {
      if (key === null || key === undefined) return { ...store };
      if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
      const out = {};
      for (const k of [].concat(key)) if (k in store) out[k] = store[k];
      return out;
    },
    async set(values) {
      Object.assign(store, values);
    },
    async remove(key) {
      for (const k of [].concat(key)) delete store[k];
    },
  });

  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://clearview/${path}`,
      onMessage: { addListener: (fn) => onMessage.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      lastError: undefined,
    },
    storage: {
      sync: area(sync),
      local: area(local),
      onChanged: { addListener: () => {} },
    },
    contextMenus: {
      removeAll: (cb) => {
        menuItems.length = 0;
        if (cb) cb();
      },
      create: (options, cb) => {
        menuItems.push(options);
        if (cb) cb();
      },
      onClicked: { addListener: (fn) => onClicked.push(fn) },
    },
    tabs: {
      async sendMessage(tabId, message) {
        // A tab loaded before the extension was reloaded rejects BOTH messages,
        // which is what this mode reproduces.
        if (pageUnreachable) throw new Error('Could not establish connection.');
        messagesToTab.push({ tabId, message });
        if (message?.type === 'channel/contextTarget') return pageReply;
        return undefined;
      },
      async update() {
        return {};
      },
    },
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      },
      async setTitle({ title }) {
        badge.title = title;
      },
    },
    // The rest is only touched at import time and never exercised here. BOTH
    // navigation events matter: the worker registers its evaluator for a document
    // navigation and for a same-document one (a site's own search box), so a stub
    // missing either one fails at import.
    webNavigation: {
      onBeforeNavigate: { addListener: () => {} },
      onHistoryStateUpdated: { addListener: () => {} },
    },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    permissions: { contains: async () => true, request: async () => true },
  };

  return { sync, local, menuItems, messagesToTab, onMessage, onClicked, badge };
}

/** Import the worker fresh, with `chrome` stubbed and the network dead. */
async function loadWorker(options) {
  const stub = stubChrome(options);
  globalThis.fetch = async () => {
    throw new Error('offline in tests');
  };
  // Query-string import so a second load in this process is a fresh module.
  await import(`../src/background/service-worker.js?case=${Date.now()}${Math.random()}`);
  // Let the import-time bootstrap settle, so it cannot interleave with a click.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return stub;
}

/** Deliver the click Chrome would deliver for our menu item. */
async function clickMenuItem(stub, info, tab = { id: 7 }) {
  assert.equal(stub.onClicked.length, 1, 'exactly one context-menu click listener');
  stub.onClicked[0](info, tab);
  // The handler is `void`-ed inside the listener, so let its microtasks finish.
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/** Call the worker's message router the way a page or a content script does. */
function callWorker(stub, message, sender = {}) {
  return new Promise((resolve, reject) => {
    const listener = stub.onMessage[0];
    assert.ok(listener, 'the worker must have a message listener');
    listener(message, sender, (response) => {
      if (response?.ok) resolve(response.data);
      else reject(Object.assign(new Error(response?.error?.message ?? 'failed'), response?.error ?? {}));
    });
  });
}

const SETTINGS_KEY = 'cv.settings';
const MENU_ID = 'clearview-block-channel';

// ── Registration ─────────────────────────────────────────────────────────

test('the menu item is registered on the right id and contexts', async () => {
  const stub = await loadWorker();
  const item = stub.menuItems.find((m) => m.id === MENU_ID);
  assert.ok(item, 'the Block this channel item must be created');
  assert.deepEqual(item.contexts, ['link', 'video', 'image']);
  assert.deepEqual(item.documentUrlPatterns, ['*://*.youtube.com/*']);
});

// ── The scenario that was reported broken ────────────────────────────────

test('right-clicking a VIDEO resolves the channel from the page and blocks it', async () => {
  // A watch URL names no channel, so the page is the only source.
  const stub = await loadWorker({ pageReply: { url: '/@FromThePage', name: 'From The Page' } });

  await clickMenuItem(stub, {
    menuItemId: MENU_ID,
    linkUrl: 'https://www.youtube.com/watch?v=abc123',
    mediaType: 'video',
    pageUrl: 'https://www.youtube.com/watch?v=abc123',
  });

  const written = stub.sync[SETTINGS_KEY];
  assert.ok(written, 'the settings must have been written');
  assert.equal(written.blockedChannels.length, 1, 'exactly one channel must be blocked');
  assert.equal(written.blockedChannels[0].handle, '@fromthepage');
  assert.equal(written.blockedChannels[0].name, 'From The Page');
  assert.equal(written.blockedChannels[0].source, 'context-menu');
});

test('right-clicking a video BLOCKS even when only the player was hit (no linkUrl)', async () => {
  const stub = await loadWorker({ pageReply: { url: '/@PlayerChannel', name: 'Player Channel' } });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: '', mediaType: 'video' });

  const written = stub.sync[SETTINGS_KEY];
  assert.equal(written.blockedChannels[0].handle, '@playerchannel');
});

test('a CHANNEL link blocks without asking the page at all', async () => {
  const stub = await loadWorker({ pageReply: null });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/@DirectHandle' });

  const written = stub.sync[SETTINGS_KEY];
  assert.equal(written.blockedChannels[0].handle, '@directhandle');
  assert.equal(
    stub.messagesToTab.filter((m) => m.message.type === 'channel/contextTarget').length,
    0,
    'the URL already answered it'
  );
});

test('the blocked channel is visible to the extension UI afterwards', async () => {
  // The reported symptom was "not added in extension", so this asserts the thing
  // the UI actually reads: `blockedChannels` on the state it gets back.
  const stub = await loadWorker({ pageReply: { url: '/@FromThePage', name: 'From The Page' } });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/watch?v=abc123' });

  const state = await callWorker(stub, { type: 'state/get' });
  assert.equal(state.blockedChannels.length, 1);
  assert.equal(state.blockedChannels[0].handle, '@fromthepage');
  // ...and it counts toward the rules in force, which is what the header shows.
  assert.equal(state.bundleCounts.channels, 1);
});

test('a block stored by NAME is counted, so the toast cannot say “0 channels”', async () => {
  // What a right-click on the current grid produces: the card carries no channel
  // link, so the block is stored by the name it prints. Counting only handles and
  // ids made the toast that CONFIRMS the block read "0 channels blocked".
  const stub = await loadWorker({ pageReply: { url: null, name: 'The Japanese Town' } });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/watch?v=abc123' });

  const written = stub.sync[SETTINGS_KEY];
  assert.equal(written.blockedChannels[0].name, 'The Japanese Town');
  assert.equal(written.blockedChannels[0].handle, null, 'no handle may be invented from a name');

  const state = await callWorker(stub, { type: 'state/get' });
  assert.equal(state.bundleCounts.channelNames, 1, 'the name-only block is in force');
  const told = stub.messagesToTab.filter((m) => m.message.type === 'channel/blockResult');
  assert.match(told[0].message.text, /Blocked The Japanese Town/);
  assert.match(told[0].message.text, /1 channel blocked/, 'the count has to include it');
});

test('the page is told what happened, so a silent block cannot happen', async () => {
  const stub = await loadWorker({ pageReply: { url: '/@FromThePage', name: 'From The Page' } });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/watch?v=abc123' });

  const told = stub.messagesToTab.filter((m) => m.message.type === 'channel/blockResult');
  assert.equal(told.length, 1, 'the content script must be told');
  assert.match(told[0].message.text, /Blocked @fromthepage/);
});

test('when the page cannot say which channel it is, NOTHING is written and the user is told', async () => {
  // The honest failure: better a message than a block on the wrong channel.
  const stub = await loadWorker({ pageReply: null });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/watch?v=abc123' });

  assert.equal(stub.sync[SETTINGS_KEY], undefined, 'no settings write may happen');
  const told = stub.messagesToTab.filter((m) => m.message.type === 'channel/blockResult');
  assert.equal(told.length, 1, 'the user must be told why nothing happened');
  assert.match(told[0].message.text, /⋮|channel/i);
});

test('a link that is not YouTube blocks nothing and says so', async () => {
  const stub = await loadWorker({ pageReply: { url: '/@SomeHandle', name: 'Some Handle' } });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://example.com/article' });

  assert.equal(stub.sync[SETTINGS_KEY], undefined);
  assert.match(
    stub.messagesToTab.find((m) => m.message.type === 'channel/blockResult').message.text,
    /not a YouTube channel/i
  );
});

test('a click on some other menu item is ignored', async () => {
  const stub = await loadWorker({ pageReply: { url: '/@x', name: 'x' } });
  await clickMenuItem(stub, { menuItemId: 'some-other-extension-item' });
  assert.equal(stub.sync[SETTINGS_KEY], undefined);
});

// ── The ⋮ menu path ──────────────────────────────────────────────────────

test('the ⋮ menu blocks by URL, deriving the identity in the worker', async () => {
  const stub = await loadWorker();
  const state = await callWorker(stub, {
    type: 'channel/block',
    url: '/@FromTheWatchPage',
    name: 'From The Watch Page',
    source: 'youtube-menu',
  });

  assert.equal(state.blockedChannels.length, 1);
  assert.equal(state.blockedChannels[0].handle, '@fromthewatchpage');
  assert.equal(state.blockedChannels[0].source, 'youtube-menu');
});

test('a dead content script still blocks when the PAGE is a channel page', async () => {
  // The reported failure mode: a YouTube tab open since before the extension was
  // reloaded has no live content script, so both messages reject and the page can
  // say nothing. The address bar can still answer for a channel page.
  const stub = await loadWorker({ pageUnreachable: true });
  await clickMenuItem(stub, {
    menuItemId: MENU_ID,
    linkUrl: 'https://www.youtube.com/watch?v=abc123',
    pageUrl: 'https://www.youtube.com/@PageChannel/videos',
  });

  assert.equal(stub.sync[SETTINGS_KEY].blockedChannels[0].handle, '@pagechannel');
});

test('a failure the page cannot hear raises the toolbar badge', async () => {
  // Otherwise a right-click that did nothing produces no feedback anywhere.
  const stub = await loadWorker({ pageUnreachable: true });
  await clickMenuItem(stub, {
    menuItemId: MENU_ID,
    linkUrl: 'https://www.youtube.com/watch?v=abc123',
    pageUrl: 'https://www.youtube.com/watch?v=abc123',
  });

  assert.equal(stub.sync[SETTINGS_KEY], undefined, 'nothing may be blocked');
  assert.equal(stub.badge.text, '!', 'the badge must be raised when no page can be told');
  assert.match(stub.badge.title, /channel/i);
});

test('a SUCCESS does not raise the badge', async () => {
  const stub = await loadWorker({ pageReply: { url: '/@FromThePage', name: 'From The Page' } });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/watch?v=abc' });
  assert.equal(stub.badge.text, '', 'the page toast is the report; a badge would be noise');
});

test('a right-click on a card whose channel has no link blocks it BY NAME', async () => {
  // YouTube's current grid gives a card's channel no href at all, so this is
  // what a right-click on a feed thumbnail has to work with. It must end in a
  // block the user asked for — and in a record that says NAME, never a handle
  // invented from the name.
  const stub = await loadWorker({ pageReply: { url: null, name: 'The Japanese Town' } });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/watch?v=abc' });

  const [record] = stub.sync[SETTINGS_KEY].blockedChannels;
  assert.equal(record.handle, null, 'no handle may be invented from the name');
  assert.equal(record.channelId, null);
  assert.equal(record.name, 'The Japanese Town');
  assert.equal(record.source, 'context-menu');
  assert.match(stub.messagesToTab.at(-1).message.text, /The Japanese Town/);
});

test('a target with nothing in it is still refused', async () => {
  // The refusal that matters stays: an empty payload must not become a record,
  // or the menu entry could report a block it never made.
  const stub = await loadWorker();
  await assert.rejects(
    () => callWorker(stub, { type: 'channel/block', source: 'youtube-menu' }),
    (error) => error.code === 'invalid_channel'
  );
  assert.equal(stub.sync[SETTINGS_KEY], undefined);
});

test('blocking the same channel twice does not create a second entry', async () => {
  const stub = await loadWorker({ pageReply: { url: '/@FromThePage', name: 'From The Page' } });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/watch?v=abc' });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/@FromThePage' });

  assert.equal(stub.sync[SETTINGS_KEY].blockedChannels.length, 1);
});

test('unblocking removes it again', async () => {
  const stub = await loadWorker({ pageReply: { url: '/@FromThePage', name: 'From The Page' } });
  await callWorker(stub, { type: 'password/set', password: 'secret1' });
  await clickMenuItem(stub, { menuItemId: MENU_ID, linkUrl: 'https://www.youtube.com/watch?v=abc' });
  assert.equal(stub.sync[SETTINGS_KEY].blockedChannels.length, 1);

  // Unblocking weakens protection, so it carries the password; blocking did not.
  await assert.rejects(
    () => callWorker(stub, { type: 'channel/unblock', label: '@fromthepage' }),
    (error) => error.code === 'invalid_password'
  );
  const state = await callWorker(stub, {
    type: 'channel/unblock',
    label: '@fromthepage',
    password: 'secret1',
  });
  assert.equal(state.blockedChannels.length, 0);
});

test('a channel blocked by id alone can be unblocked by that id', async () => {
  const stub = await loadWorker();
  const UC = 'UCabcdefghijklmnopqrstuv';
  await callWorker(stub, { type: 'password/set', password: 'secret1' });
  await callWorker(stub, { type: 'channel/block', url: `/channel/${UC}`, source: 'context-menu' });
  assert.equal(stub.sync[SETTINGS_KEY].blockedChannels[0].channelId, UC);

  const state = await callWorker(stub, {
    type: 'channel/unblock',
    label: UC,
    password: 'secret1',
  });
  assert.equal(state.blockedChannels.length, 0);
});
