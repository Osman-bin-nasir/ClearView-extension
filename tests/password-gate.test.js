/**
 * The Protection password and the ad ruleset, driven through the REAL worker.
 *
 * Both are decisions the worker owns — a page cannot be trusted with either —
 * and both have a failure mode that is invisible from a unit test: a gate that
 * is checked in the UI but not in the worker (the switch stays flippable), and a
 * ruleset that is declared but never switched on (the toggle looks "on" while
 * ads keep loading).
 *
 * So the real service worker is imported against a stubbed `chrome`, messages
 * are delivered exactly as Chrome would, and both the storage writes and the
 * `updateEnabledRulesets` calls are read back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function stubChrome() {
  const sync = {};
  const local = {};
  const rulesets = { enabled: [], disabled: [] };
  const onMessage = [];
  const tabs = { list: [], removed: [], listeners: [] };

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
    async clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
  });

  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://clearview/${path}`,
      onMessage: { addListener: (fn) => onMessage.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      openOptionsPage: () => {},
    },
    storage: {
      sync: area(sync),
      local: area(local),
      onChanged: { addListener: () => {} },
    },
    tabs: {
      async sendMessage() {},
      async update() {},
      async query() {
        return tabs.list;
      },
      async remove(ids) {
        tabs.removed.push(...[].concat(ids));
      },
      onCreated: { addListener: (listener) => tabs.listeners.push(listener) },
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    // Both navigation events the blocker registers: the page load, and the
    // same-document pushState that a site's own search box produces.
    webNavigation: {
      onBeforeNavigate: { addListener: () => {} },
      onHistoryStateUpdated: { addListener: () => {} },
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return [];
      },
      async updateDynamicRules() {},
      async updateEnabledRulesets(options) {
        for (const id of options.enableRulesetIds ?? []) rulesets.enabled.push(id);
        for (const id of options.disableRulesetIds ?? []) rulesets.disabled.push(id);
      },
    },
    alarms: { create() {}, onAlarm: { addListener: () => {} } },
    contextMenus: { removeAll() {}, create() {}, onClicked: { addListener: () => {} } },
    permissions: { contains: async () => true, request: async () => true },
  };

  return { sync, local, rulesets, onMessage, tabs };
}

async function loadWorker() {
  const stub = stubChrome();
  globalThis.fetch = async () => {
    throw new Error('offline in tests');
  };
  await import(`../src/background/service-worker.js?case=${Date.now()}${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return stub;
}

function callWorker(stub, message) {
  return new Promise((resolve, reject) => {
    const listener = stub.onMessage[0];
    assert.ok(listener, 'the worker must have a message listener');
    listener(message, {}, (response) => {
      if (response?.ok) resolve(response.data);
      else reject(Object.assign(new Error(response?.error?.message ?? 'failed'), response?.error ?? {}));
    });
  });
}

const SETTINGS_KEY = 'cv.settings';

/** Let a fire-and-forget listener (the incognito tab close) finish. */
const settleWorker = () => new Promise((resolve) => setTimeout(resolve, 25));

// ── The ad ruleset ───────────────────────────────────────────────────────

test('the ad ruleset is switched on at boot from the default settings', async () => {
  const stub = await loadWorker();
  assert.deepEqual(stub.rulesets.enabled, ['youtube_ads'], 'ads are on by default');
  assert.deepEqual(stub.rulesets.disabled, []);
});

test('turning Protection off disables the ad ruleset, and on enables it again', async () => {
  const stub = await loadWorker();
  // Settings are locked until setup is done, so every write below carries the
  // password the worker now requires.
  await callWorker(stub, { type: 'password/set', password: 'secret1' });
  stub.rulesets.enabled.length = 0;
  stub.rulesets.disabled.length = 0;

  await callWorker(stub, {
    type: 'settings/update',
    patch: { protectionEnabled: false },
    password: 'secret1',
  });
  assert.deepEqual(stub.rulesets.disabled, ['youtube_ads'], 'Protection off must stop ad blocking');

  stub.rulesets.enabled.length = 0;
  await callWorker(stub, {
    type: 'settings/update',
    patch: { protectionEnabled: true },
    password: 'secret1',
  });
  assert.deepEqual(stub.rulesets.enabled, ['youtube_ads'], 'and on must resume it');
});

test('the ad switch alone controls the ruleset while Protection is on', async () => {
  const stub = await loadWorker();
  await callWorker(stub, { type: 'password/set', password: 'secret1' });
  stub.rulesets.disabled.length = 0;
  // Turning the ad blocker OFF weakens protection, so it carries the password
  // like every other off switch; enabling it does not.
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { blockYoutubeAds: false } }),
    (error) => error.code === 'invalid_password'
  );
  await callWorker(stub, {
    type: 'settings/update',
    patch: { blockYoutubeAds: false },
    password: 'secret1',
  });
  assert.deepEqual(stub.rulesets.disabled, ['youtube_ads']);
});

// ── The password gate ────────────────────────────────────────────────────

test('a fresh install must finish setup before anything can change', async () => {
  const stub = await loadWorker();
  const state = await callWorker(stub, { type: 'state/get' });
  assert.equal(state.passwordSet, false);
  assert.equal(state.onboarded, false);

  // Every settings write is refused until the mandatory password exists —
  // including the master switch, which is the one an unfinished install would
  // most like to change.
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { protectionEnabled: false } }),
    (error) => error.code === 'password_required'
  );
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { blockYoutubeAds: false } }),
    (error) => error.code === 'password_required'
  );
  assert.equal(stub.sync[SETTINGS_KEY], undefined, 'a refused write must write nothing');

  // Setup itself is allowed, and unlocks the page.
  const after = await callWorker(stub, { type: 'password/set', password: 'secret1' });
  assert.equal(after.passwordSet, true);
  await callWorker(stub, { type: 'settings/update', patch: { blockShorts: true } });
  assert.equal(stub.sync[SETTINGS_KEY].blockShorts, true);
});

test('once a password is set, changing Protection is refused without it', async () => {
  const stub = await loadWorker();
  await callWorker(stub, { type: 'password/set', password: 'secret1' });

  // Neither omitted nor wrong is accepted.
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { protectionEnabled: false } }),
    (error) => error.code === 'invalid_password'
  );
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { protectionEnabled: false }, password: 'nope' }),
    (error) => error.code === 'invalid_password'
  );
  assert.equal(stub.sync[SETTINGS_KEY], undefined, 'a refused change must write nothing');

  // The right one goes through.
  const state = await callWorker(stub, {
    type: 'settings/update',
    patch: { protectionEnabled: false },
    password: 'secret1',
  });
  assert.equal(state.settings.protectionEnabled, false);
  assert.equal(stub.sync[SETTINGS_KEY].protectionEnabled, false);

  // Turning it back ON is the safe direction, so it is free — a password that
  // punished enabling would be a lock that makes the product harder to use.
  const reEnabled = await callWorker(stub, {
    type: 'settings/update',
    patch: { protectionEnabled: true },
  });
  assert.equal(reEnabled.settings.protectionEnabled, true, 'enabling needs no password');
});

test('every off switch is gated, while every on switch is free', async () => {
  // The user asked for one rule across the page: the password is needed to
  // DISABLE a toggle, never to enable it.
  const stub = await loadWorker();
  await callWorker(stub, { type: 'password/set', password: 'secret1' });

  for (const key of ['blockShorts', 'brainBotEnabled', 'blockYoutubeAds', 'strictMode', 'blockIncognito']) {
    await callWorker(stub, { type: 'settings/update', patch: { [key]: true } });
    assert.equal(stub.sync[SETTINGS_KEY][key], true, `${key} turns on without a password`);
    await assert.rejects(
      () => callWorker(stub, { type: 'settings/update', patch: { [key]: false } }),
      (error) => error.code === 'invalid_password',
      `${key} must refuse to turn off without one`
    );
    await callWorker(stub, {
      type: 'settings/update',
      patch: { [key]: false },
      password: 'secret1',
    });
    assert.equal(stub.sync[SETTINGS_KEY][key], false, `${key} turns off with the password`);
  }
});

test('block incognito closes existing and newly-created private tabs', async () => {
  const stub = await loadWorker();
  await callWorker(stub, { type: 'password/set', password: 'secret1' });

  // A private window that was already open when the switch was turned on.
  stub.tabs.list.push({ id: 9, incognito: true });
  await callWorker(stub, { type: 'settings/update', patch: { blockIncognito: true } });
  assert.deepEqual(stub.tabs.removed, [9], 'an already-open private tab must be closed');

  // ...and a window opened while it is on is closed as it appears.
  assert.equal(stub.tabs.listeners.length, 1, 'the worker must listen for new tabs');
  stub.tabs.listeners[0]({ id: 10, incognito: true });
  await settleWorker();
  assert.ok(stub.tabs.removed.includes(10), 'a new private tab must be closed before it loads');

  // Other windows are left alone.
  stub.tabs.listeners[0]({ id: 11, incognito: false });
  await settleWorker();
  assert.ok(!stub.tabs.removed.includes(11), 'a normal window is never touched');

  // Turning the switch off weakens protection, so it asks for the password.
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { blockIncognito: false } }),
    (error) => error.code === 'invalid_password'
  );
  await callWorker(stub, {
    type: 'settings/update',
    patch: { blockIncognito: false },
    password: 'secret1',
  });
  assert.equal(stub.sync[SETTINGS_KEY].blockIncognito, false);
});

test('adding a blocked item is free, removing one needs the password', async () => {
  const stub = await loadWorker();
  await callWorker(stub, { type: 'password/set', password: 'secret1' });

  await callWorker(stub, { type: 'settings/update', patch: { youtubeKeywords: ['a term'] } });
  assert.deepEqual(stub.sync[SETTINGS_KEY].youtubeKeywords, ['a term']);
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { youtubeKeywords: [] } }),
    (error) => error.code === 'invalid_password'
  );

  const channel = { handle: '@someone', name: 'Someone' };
  await callWorker(stub, { type: 'settings/update', patch: { blockedChannels: [channel] } });
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { blockedChannels: [] } }),
    (error) => error.code === 'invalid_password'
  );
  await callWorker(stub, {
    type: 'settings/update',
    patch: { blockedChannels: [] },
    password: 'secret1',
  });
  assert.deepEqual(stub.sync[SETTINGS_KEY].blockedChannels, []);

  // The dedicated unblock path is gated the same way.
  await callWorker(stub, { type: 'channel/block', handle: '@someone' });
  await assert.rejects(
    () => callWorker(stub, { type: 'channel/unblock', label: '@someone' }),
    (error) => error.code === 'invalid_password'
  );
  const after = await callWorker(stub, {
    type: 'channel/unblock',
    label: '@someone',
    password: 'secret1',
  });
  assert.equal(after.settings.blockedChannels.length, 0);
});

test('the password can be verified, changed and removed — each with the current one', async () => {
  const stub = await loadWorker();
  await callWorker(stub, { type: 'password/set', password: 'secret1' });

  assert.equal((await callWorker(stub, { type: 'password/verify', password: 'secret1' })).ok, true);
  assert.equal((await callWorker(stub, { type: 'password/verify', password: 'wrong' })).ok, false);

  await assert.rejects(
    () => callWorker(stub, { type: 'password/change', current: 'wrong', next: 'secret2' }),
    (error) => error.code === 'invalid_password'
  );
  await callWorker(stub, { type: 'password/change', current: 'secret1', next: 'secret2' });
  assert.equal((await callWorker(stub, { type: 'password/verify', password: 'secret1' })).ok, false);
  assert.equal((await callWorker(stub, { type: 'password/verify', password: 'secret2' })).ok, true);

  await assert.rejects(
    () => callWorker(stub, { type: 'password/remove', password: 'wrong' }),
    (error) => error.code === 'invalid_password'
  );
  const state = await callWorker(stub, { type: 'password/remove', password: 'secret2' });
  assert.equal(state.passwordSet, false, 'removing it clears the gate');

  // ...and the mandatory setup gate is back, so there is no password-less
  // window in which Protection could be switched off.
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { protectionEnabled: false } }),
    (error) => error.code === 'password_required'
  );
});

test('the user can export their data and erase everything', async () => {
  const stub = await loadWorker();
  await callWorker(stub, { type: 'password/set', password: 'secret1' });
  await callWorker(stub, { type: 'settings/update', patch: { blockShorts: true } });

  const exported = await callWorker(stub, { type: 'data/export' });
  assert.equal(exported.settings.blockShorts, true, 'settings travel in the export');
  assert.ok(exported.anonymousId, 'and the anonymous id, so contributions are explainable');
  assert.ok(!('password' in exported) && !('hash' in exported), 'credentials never travel');
  assert.ok(exported.exportedAt, 'the document is dated');

  const state = await callWorker(stub, { type: 'data/erase' });
  assert.equal(state.passwordSet, false, 'erasing removes the password too');
  assert.equal(state.settings.protectionEnabled, true, 'and restores the defaults');
  assert.deepEqual(Object.keys(stub.sync), [], 'no synced setting survives');
  assert.ok(!('cv.password' in stub.local), 'no local credential survives');
});

test('the content script is told about the ad switch', async () => {
  const stub = await loadWorker();
  const config = await callWorker(stub, { type: 'rules/forContent' });
  assert.equal(config.blockYoutubeAds, true, 'the ad switch must reach the page');
  assert.equal(typeof config.enabled, 'boolean');
});

test('the only way past setup is creating a password', async () => {
  const stub = await loadWorker();
  assert.equal((await callWorker(stub, { type: 'state/get' })).onboarded, false);

  // There is no dismiss message any more: setup is finished by setting a
  // password and nothing else.
  assert.equal(stub.onMessage.length, 1, 'one listener; no separate skip path');
  const state = await callWorker(stub, { type: 'password/set', password: 'secret1' });
  assert.equal(state.onboarded, true);
});
