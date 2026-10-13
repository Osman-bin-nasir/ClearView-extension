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
            return { ok: true, data: { submissions: [] } };
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
    blockedChannels: overrides.blockedChannels ?? [],
    bundleCounts: { builtIn: 500, domains: 60, everywhere: 1, youtube: 1, channels: 0, channelIds: 0 },
    global: { available: false, version: null, fetchedAt: null, keywordCount: 0, channelCount: 0, liveKeywords: [], liveChannels: [] },
    stats: { total: 3, byReason: { search: 1, domain: 2 }, lastAt: Date.now(), recent: [] },
    anonymousId: '11111111-2222-3333-4444-555555555555',
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// ── The popup ────────────────────────────────────────────────────────────

test('the popup renders its hero, the ad toggle and the first-run password offer', async () => {
  const { byId, body } = installDom(['content', 'open-options', 'open-options-footer', 'open-admin']);
  installChrome(workerState({ passwordSet: false, onboarded: false }));

  await import(`../src/popup/popup.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /Protection is on/, 'the hero must state the protection status');
  assert.match(text, /Block YouTube ads/, 'the ad toggle must be on the popup');
  assert.match(text, /Hide YouTube Shorts/, 'the Shorts control must remain');
  assert.match(text, /Brain Bot/, 'the Brain Bot control must remain');
  assert.match(text, /Protect your settings/, 'the first-run password offer must show when none is set');
  assert.match(text, /Blocked websites/, 'the user lists must render');

  // The hero's switch is a real control in the tree.
  const switches = walk(byId.content).filter((node) => node.attributes?.role === 'switch');
  assert.ok(switches.length >= 1, 'the hero must carry a switch');
  assert.equal(switches[0].getAttribute('aria-checked'), 'true', 'and it must reflect the on state');

  assert.ok(document.body === body, 'the document body is the one the shim handed out');
});

test('the popup says Protection is off when it is', async () => {
  const { byId } = installDom(['content', 'open-options', 'open-options-footer', 'open-admin']);
  installChrome(workerState({ settings: { protectionEnabled: false }, passwordSet: true }));
  // `passwordSet: true` also means the first-run offer is long answered.

  await import(`../src/popup/popup.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /Protection is off/);
  assert.doesNotMatch(text, /Protect your settings/, 'no password offer once one is set');
});

test('the first-run offer is not repeated once it has been answered', async () => {
  const { byId } = installDom(['content', 'open-options', 'open-options-footer', 'open-admin']);
  installChrome(workerState({ passwordSet: false, onboarded: true }));

  await import(`../src/popup/popup.js?case=${Date.now()}${Math.random()}`);
  await settle();

  // It stays settable from the settings page; the popup just does not nag.
  assert.doesNotMatch(byId.content.textContent, /Protect your settings/);
});

// ── The settings page ────────────────────────────────────────────────────

test('the settings page renders the ad toggle and the password card', async () => {
  const { byId } = installDom(['content', 'toast', 'protection-scope', 'open-admin']);
  installChrome(workerState({ passwordSet: true, passwordAt: Date.now() }));

  await import(`../src/options/options.js?case=${Date.now()}${Math.random()}`);
  await settle();

  const text = byId.content.textContent;
  assert.match(text, /Block YouTube ads/, 'the ad toggle must be in settings');
  assert.match(text, /Protection password/, 'the password card must be in settings');
  assert.match(text, /Change password/, 'a set password offers a change');
  assert.match(text, /YouTube protection/, 'the section headings must remain');
  assert.match(text, /instagram/, 'the user keyword list must render');

  const switches = walk(byId.content).filter((node) => node.attributes?.role === 'switch');
  assert.ok(switches.length >= 4, 'protection, ads, shorts and Brain Bot each need a switch');
});

test('the settings page offers to create a password when none is set', async () => {
  const { byId } = installDom(['content', 'toast', 'protection-scope', 'open-admin']);
  // `onboarded: true` keeps the first-run dialog from opening during the test;
  // the card itself is what is asserted here.
  installChrome(workerState({ passwordSet: false, onboarded: true }));

  await import(`../src/options/options.js?case=${Date.now()}${Math.random()}`);
  await settle();

  assert.match(byId.content.textContent, /Create password/);
});

// ── The password dialog ──────────────────────────────────────────────────

const dialogInputs = () => walk(document.body).filter((node) => node.tagName === 'INPUT');
const dialogButton = (label) =>
  walk(document.body).find((node) => node.tagName === 'BUTTON' && node.textContent === label);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadPasswordUi() {
  return import(`../src/ui/password.js?case=${Date.now()}${Math.random()}`);
}

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

