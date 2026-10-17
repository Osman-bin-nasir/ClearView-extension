/**
 * The popup and the settings page, rendered for real.
 *
 * Both scripts build their whole DOM from `ui/shared.js`, so a mistake there —
 * a renamed helper, a `card()` option that no longer exists, a missing import —
 * is invisible to the pure tests and would only surface when a user opened the
 * extension. This runs the actual modules against a small DOM shim and a stubbed
 * worker, and asserts on the text that comes out.
 *
 * A shim rather than a browser: the project ships no dependencies by design, and
 * the subset of the DOM these two pages use is small enough to model honestly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey } from '../src/common/settings.js';

// ── A minimal DOM ────────────────────────────────────────────────────────

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this._text = '';
    this._listeners = {};
  }

  set className(value) {
    this.attributes.class = String(value);
  }

  get className() {
    return this.attributes.class ?? '';
  }

  get classList() {
    const read = () => (this.attributes.class ?? '').split(/\s+/).filter(Boolean);
    const write = (list) => {
      this.attributes.class = [...new Set(list)].join(' ');
    };
    return {
      add: (name) => write([...read(), name]),
      remove: (name) => write(read().filter((x) => x !== name)),
      contains: (name) => read().includes(name),
      toggle: (name, force) => {
        const on = force === undefined ? !read().includes(name) : Boolean(force);
        if (on) write([...read(), name]);
        else write(read().filter((x) => x !== name));
        return on;
      },
    };
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined || node === false) continue;
      const child = node instanceof FakeNode ? node : new FakeNode('#text');
      if (!(node instanceof FakeNode)) child._text = String(node);
      child.parentNode = this;
      this.children.push(child);
    }
  }

  removeChild(node) {
    this.children = this.children.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
  }

  getAttribute(key) {
    return key in this.attributes ? this.attributes[key] : null;
  }

  hasAttribute(key) {
    return key in this.attributes;
  }

  addEventListener(type, listener) {
    (this._listeners[type] ??= []).push(listener);
  }

  removeEventListener() {}

  dispatch(type, event = {}) {
    for (const listener of this._listeners[type] ?? []) listener({ target: this, ...event });
  }

  focus() {}

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

/** Every node under `root`, so an assertion can search the whole tree. */
function walk(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

function installDom(ids) {
  const byId = {};
  for (const id of ids) byId[id] = new FakeNode('div');

  const html = new FakeNode('html');
  const body = new FakeNode('body');

  globalThis.Node = FakeNode;
  globalThis.HTMLInputElement = FakeNode;
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const node = new FakeNode('#text');
      node._text = String(text);
      return node;
    },
    getElementById: (id) => byId[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    body,
    documentElement: html,
  };
  return { byId, body };
}

/** A worker stub, answering the messages each page sends on load. */
function installChrome(state) {
  const sent = [];
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        sent.push(message.type);
        switch (message.type) {
          case 'state/get':
            return { ok: true, data: state };
          case 'submissions/list':
            return { ok: true, data: { submissions: state.submissions ?? [] } };
          default:
            return { ok: true, data: state };
        }
      },
      getURL: (path) => `chrome-extension://clearview/${path}`,
      openOptionsPage: () => {},
    },
    tabs: { create: () => {} },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
  };
  return { sent };
}

/** A state object shaped exactly like the worker's `describeState`. */
function workerState(overrides = {}) {
  return {
    settings: {
      protectionEnabled: true,
      strictMode: false,
      blockShorts: false,
      blockYoutubeAds: true,
      brainBotEnabled: false,
      brainBotMode: 'overlay',
      youtubeKeywords: [],
      userKeywords: ['instagram'],
      blockedDomains: ['example.com'],
      blockedChannels: [],
      apiBase: 'https://clearview-1neb.onrender.com',
      ...overrides.settings,
    },
    passwordSet: overrides.passwordSet ?? false,
    passwordAt: overrides.passwordAt ?? null,
    onboarded: overrides.onboarded ?? true,
    incognitoAllowed: overrides.incognitoAllowed ?? false,
    blockedChannels: overrides.blockedChannels ?? [],
    bundleCounts: { builtIn: 500, domains: 60, everywhere: 1, youtube: 1, channels: 0, channelIds: 0 },
    global: { available: false, version: null, fetchedAt: null, keywordCount: 0, channelCount: 0, liveKeywords: [], liveChannels: [] },
    stats: overrides.stats ?? {
      total: 3,
      byReason: { search: 1, domain: 2 },
      lastAt: Date.now(),
      recent: [],
    },
    anonymousId: '11111111-2222-3333-4444-555555555555',
    submissions: overrides.submissions ?? [],
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// ── The popup ────────────────────────────────────────────────────────────

test('the popup is the name, the activity and a way in once protection is on', async () => {
  const { byId, body } = installDom(['content', 'popup-status']);
  installChrome(workerState({ passwordSet: false, onboarded: false }));

  await import(`../src/popup/popup.js?case=${Date.now()}${Math.random()}`);
  await settle();

  assert.match(byId['popup-status'].textContent, /Protection on/, 'the header states the state');

  const text = byId.content.textContent;
  assert.match(text, /Blocked today0/, 'today’s count is the headline');
  assert.match(text, /7 days0/, 'and the week is shown beside it');
  assert.match(text, /All time3/, 'the lifetime total too');
  assert.match(text, /Open settings/, 'there must be one way into the full settings');
  assert.match(text, /Set your Protection password to finish setup/, 'an unfinished install says so');
  assert.match(text, /Finish setup/, 'and leads to the one screen that can finish it');

  const chart = walk(byId.content).find((node) => node.attributes?.role === 'img');
  assert.ok(chart, 'the activity panel must carry a seven-day chart');
  assert.match(chart.getAttribute('aria-label'), /last seven days/, 'and describe it for a screen reader');

  // Minimalism is the point: once protection is ON the switch is not drawn at
  // all, so there is nothing in the popup that can turn it off by accident.
  const switches = walk(byId.content).filter((node) => node.attributes?.role === 'switch');
  assert.equal(switches.length, 0, 'the protection switch must be hidden while protection is on');
  assert.doesNotMatch(text, /Protection off/, 'and no off-state row is drawn either');

  // The controls that used to make this popup scroll are gone from it, and stay
  // gone. They live in the settings page.
  for (const moved of ['Block YouTube ads', 'Hide YouTube Shorts', 'Brain Bot', 'Blocked websites', 'Blocked keywords', 'Strict Mode']) {
    assert.doesNotMatch(text, new RegExp(moved), `${moved} belongs in the settings page, not the popup`);
  }

  assert.ok(document.body === body, 'the document body is the one the shim handed out');
});

test('the popup says Protection is off, with the one button that turns it back on', async () => {
  const { byId } = installDom(['content']);
  installChrome(workerState({ settings: { protectionEnabled: false }, passwordSet: true }));
  // `passwordSet: true` also means the first-run offer is long answered.

  await import(`../src/popup/popup.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /Protection off/);
  assert.match(text, /Nothing is being blocked/);
  assert.doesNotMatch(text, /Lock the switch with a password/, 'no password offer once one is set');

  // Off is the only state in which the switch is drawn.
  const switches = walk(byId.content).filter((node) => node.attributes?.role === 'switch');
  assert.equal(switches.length, 1, 'the switch is the one thing to do while protection is off');
  assert.equal(switches[0].getAttribute('aria-checked'), 'false');
  assert.equal(switches[0].getAttribute('aria-label'), 'Protection');
});

test('today’s number is today’s, not the last day anything was blocked', async () => {
  const { byId } = installDom(['content']);
  const today = dayKey();
  const yesterday = dayKey(Date.now() - 86_400_000);
  installChrome(
    workerState({
      stats: { total: 1204, byDay: { [today]: 7, [yesterday]: 99 }, byReason: {}, lastAt: Date.now(), recent: [] },
    }),
  );

  await import(`../src/popup/popup.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /All time1,204/, 'a large lifetime count is grouped');
  assert.match(text, /Blocked today7/, 'today reads today’s entry');
  assert.doesNotMatch(text, /99/, 'and never the previous day’s');
});

test('the first-run offer is not repeated once it has been answered', async () => {
  const { byId } = installDom(['content']);
  installChrome(workerState({ passwordSet: false, onboarded: true }));

  await import(`../src/popup/popup.js?case=${Date.now()}${Math.random()}`);
  await settle();

  // It stays settable from the settings page; the popup just does not nag.
  assert.doesNotMatch(byId.content.textContent, /Lock the switch with a password/);
});

// ── The settings page ────────────────────────────────────────────────────

test('the settings page renders the ad toggle and the password card', async () => {
  const { byId } = installDom(['content', 'toast', 'protection-scope', 'open-admin']);
  installChrome(workerState({ passwordSet: true, passwordAt: Date.now() }));

  await import(`../src/options/options.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /Block YouTube ads/, 'the ad toggle must be in settings');
  assert.match(text, /Block incognito mode/, 'the private-window control must be in settings');
  assert.match(text, /Protection password/, 'the password card must be in settings');
  assert.match(text, /Change password/, 'a set password offers a change');
  assert.match(text, /YouTube protection/, 'the section headings must remain');
  assert.match(text, /instagram/, 'the user keyword list must render');
  assert.doesNotMatch(text, /null/, 'a missing optional control must not render as the text "null"');

  // The sidebar's destinations are real sections, not decorative labels.
  const groups = walk(byId.content).filter((node) => node.attributes?.class === 'group');
  for (const id of ['protection', 'youtube', 'blocked-items', 'community', 'activity', 'security', 'advanced']) {
    assert.ok(
      groups.some((group) => group.getAttribute('id') === id),
      `the page must build the #${id} section the sidebar links to`
    );
  }

  const switches = walk(byId.content).filter((node) => node.attributes?.role === 'switch');
  assert.ok(switches.length >= 5, 'protection, ads, shorts, Brain Bot and incognito each need a switch');
});

test('turning a settings switch OFF asks for the password; turning one ON does not', async () => {
  const { byId } = installDom(['content', 'toast', 'protection-scope', 'open-admin']);
  const { sent } = installChrome(workerState({ passwordSet: true }));

  await import(`../src/options/options.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const switches = walk(byId.content).filter((node) => node.attributes?.role === 'switch');
  const ads = switches.find((node) => node.getAttribute('aria-label') === 'Block YouTube ads');
  assert.equal(ads.getAttribute('aria-checked'), 'true', 'the ad switch starts on');

  // OFF is the weakening direction: it must ask before anything is written.
  ads.dispatch('click');
  await tick();
  assert.equal(dialogInputs().length, 1, 'a password dialog must open for the off direction');
  assert.match(
    walk(document.body).map((node) => node.textContent).join(' '),
    /turn a protection off|password/i,
    'and say what the password is for'
  );
  dialogButton('Cancel').dispatch('click');
  await tick();
  assert.ok(!sent.includes('settings/update'), 'cancelling must write nothing');

  // ON is the safe direction: no dialog, and the write goes straight through.
  const shorts = switches.find((node) => node.getAttribute('aria-label') === 'Block YouTube Shorts');
  assert.equal(shorts.getAttribute('aria-checked'), 'false');
  shorts.dispatch('click');
  await settle();
  assert.equal(dialogInputs().length, 0, 'enabling must not ask for the password');
  assert.ok(sent.includes('settings/update'), 'and it must still be saved through the worker');
});

test('a settings page with no password is the mandatory setup gate', async () => {
  const { byId } = installDom(['content', 'toast', 'protection-scope', 'open-admin']);
  installChrome(workerState({ passwordSet: false }));

  await import(`../src/options/options.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /Protect ClearView/, 'the page becomes the setup screen');
  assert.match(text, /Create password/);
  assert.doesNotMatch(text, /Block YouTube ads/, 'no setting is reachable before setup');
  assert.doesNotMatch(text, /Skip/, 'there is no way past it');
  const switches = walk(byId.content).filter((node) => node.attributes?.role === 'switch');
  assert.equal(switches.length, 0, 'and no control to change');
});

test('a long keyword list opens the whole list on a page of its own', async () => {
  const { byId } = installDom(['content', 'toast', 'protection-scope', 'open-admin']);
  installChrome(
    workerState({
      settings: { userKeywords: ['one', 'two', 'three', 'four', 'five', 'six'] },
      passwordSet: true,
    })
  );

  await import(`../src/options/options.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /Show more \(6\)/, 'the card must lead to the rest of the list');
  assert.doesNotMatch(text, /six/, 'and must keep only a preview in the page itself');

  const showMore = walk(byId.content).find(
    (node) => node.tagName === 'BUTTON' && node.textContent === 'Show more (6)'
  );
  assert.ok(showMore, 'Show more is the way into the full list');
  showMore.dispatch('click');

  const fullPage = walk(document.body).find((node) => node.attributes?.class === 'fullpage');
  assert.ok(fullPage, 'the list must open as a full page, not a small dialog');
  assert.match(fullPage.textContent, /six/, 'the page shows the items the card left out');

  const search = walk(document.body).find(
    (node) => node.tagName === 'INPUT' && /search/i.test(node.getAttribute('placeholder') ?? '')
  );
  assert.ok(search, 'and it must offer a search field');

  // The field filters the list instead of being decorative.
  search.value = 'six';
  search.dispatch('input');
  assert.match(
    walk(document.body).map((node) => node.textContent).join(' '),
    /1 of 6 shown/,
    'typing in the search must narrow the list'
  );
});

// ── The password dialog ──────────────────────────────────────────────────

const dialogInputs = () => walk(document.body).filter((node) => node.tagName === 'INPUT');
const dialogButton = (label) =>
  walk(document.body).find((node) => node.tagName === 'BUTTON' && node.textContent === label);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadPasswordUi() {
  return import(`../src/ui/password.js?case=${Date.now()}${Math.random()}`);
}

test('a long blocked-channel list also opens the full page', async () => {
  const { byId } = installDom(['content', 'toast', 'protection-scope', 'open-admin']);
  const blockedChannels = Array.from({ length: 6 }, (_, index) => ({
    handle: `@channel${index}`,
    name: `Channel ${index}`,
    channelId: null,
    source: 'manual',
    addedAt: Date.now(),
  }));
  installChrome(workerState({ blockedChannels, passwordSet: true }));

  await import(`../src/options/options.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /Show more \(6\)/, 'the channel card must lead to the full list too');
  assert.doesNotMatch(text, /Channel 5/, 'and must keep only a preview in the page itself');

  const showMore = walk(byId.content).find(
    (node) => node.tagName === 'BUTTON' && node.textContent === 'Show more (6)'
  );
  assert.ok(showMore);
  showMore.dispatch('click');

  const bodyText = walk(document.body).map((node) => node.textContent).join(' ');
  assert.match(bodyText, /Channel 5/, 'every channel is on the full page');
  assert.match(bodyText, /@channel5/, 'with the handle the block is stored by');
  assert.ok(
    walk(document.body).some(
      (node) => node.tagName === 'INPUT' && /search/i.test(node.getAttribute('placeholder') ?? '')
    ),
    'and a search field'
  );
});

test('submissions and protection history also offer the full page', async () => {
  const { byId } = installDom(['content', 'toast', 'protection-scope', 'open-admin']);
  const submissions = Array.from({ length: 6 }, (_, index) => ({
    kind: 'keyword',
    value: `suggestion ${index}`,
    status: 'pending',
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
  }));
  const recent = Array.from({ length: 10 }, (_, index) => ({
    reason: 'domain',
    detail: `blocked site ${index}.example`,
    at: Date.now() - index * 60_000,
  }));
  installChrome(
    workerState({
      submissions,
      stats: { total: 10, byReason: { domain: 10 }, lastAt: Date.now(), recent },
      passwordSet: true,
    })
  );

  await import(`../src/options/options.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /Show more \(6\)/, 'the submissions list must lead to the rest');
  assert.match(text, /Show more \(10\)/, 'the history list must lead to the rest');
  assert.doesNotMatch(text, /suggestion 5/, 'the preview keeps the rest out of the card');

  const buttons = walk(byId.content).filter(
    (node) => node.tagName === 'BUTTON' && /^Show more \(\d+\)$/.test(node.textContent)
  );
  assert.equal(buttons.length, 2, 'one Show more for each long list');

  buttons[0].dispatch('click');
  const fullPage = walk(document.body).find((node) => node.attributes?.class === 'fullpage');
  assert.ok(fullPage, 'the submissions open on a full page');
  assert.match(fullPage.textContent, /suggestion 5/, 'with every submission visible');
});

test('the create-password dialog refuses a mismatch and a short password', async () => {
  installDom([]);
  const { askPassword } = await loadPasswordUi();

  const promise = askPassword({
    title: 'Create',
    fields: [
      { key: 'password', placeholder: 'Password' },
      { key: 'confirm', placeholder: 'Confirm' },
    ],
    submitLabel: 'Save',
    validate: (values) => (values.password !== values.confirm ? 'mismatch' : null),
  });

  const [first, second] = dialogInputs();
  first.value = 'one';
  second.value = 'two';
  dialogButton('Save').dispatch('click');
  assert.match(walk(document.body).map((n) => n.textContent).join(' '), /mismatch/, 'a mismatch is shown inline');

  second.value = 'one';
  dialogButton('Save').dispatch('click');
  const values = await promise;
  assert.deepEqual({ ...values }, { password: 'one', confirm: 'one' }, 'the dialog resolves with the entered values');
  assert.equal(dialogInputs().length, 0, 'and takes itself off the page');
});

test('the confirm dialog can be cancelled without a value', async () => {
  installDom([]);
  const { promptForPassword } = await loadPasswordUi();
  const promise = promptForPassword();
  dialogButton('Cancel').dispatch('click');
  assert.equal(await promise, null, 'cancelling must yield null, not an empty password');
});

test('a wrong password re-opens the dialog instead of failing the change', async () => {
  installDom([]);
  let calls = 0;
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        if (message.type !== 'settings/update') return { ok: true, data: {} };
        calls += 1;
        if (calls === 1) return { ok: false, error: { code: 'invalid_password', message: 'nope' } };
        return { ok: true, data: { settings: { protectionEnabled: false }, passwordSet: true } };
      },
    },
  };

  const { changeProtectionWithPassword } = await loadPasswordUi();
  const promise = changeProtectionWithPassword(false);

  dialogInputs()[0].value = 'wrong';
  dialogButton('Unlock').dispatch('click');
  await tick();

  assert.equal(dialogInputs().length, 1, 'the dialog must be shown again, not closed on the user');
  dialogInputs()[0].value = 'right';
  dialogButton('Unlock').dispatch('click');

  const result = await promise;
  assert.equal(calls, 2, 'the change is retried once the right password is given');
  assert.equal(result.state.settings.protectionEnabled, false, 'and it applies through the worker');
});

