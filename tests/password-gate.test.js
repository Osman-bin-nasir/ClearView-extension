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
      openOptionsPage: () => {},
    },
    storage: {
      sync: area(sync),
      local: area(local),
      onChanged: { addListener: () => {} },
    },
    tabs: { async sendMessage() {}, async update() {} },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    webNavigation: { onBeforeNavigate: { addListener: () => {} } },
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

  return { sync, local, rulesets, onMessage };
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

// ── The ad ruleset ───────────────────────────────────────────────────────

test('the ad ruleset is switched on at boot from the default settings', async () => {
  const stub = await loadWorker();
  assert.deepEqual(stub.rulesets.enabled, ['youtube_ads'], 'ads are on by default');
  assert.deepEqual(stub.rulesets.disabled, []);
});

test('turning Protection off disables the ad ruleset, and on enables it again', async () => {
  const stub = await loadWorker();
  stub.rulesets.enabled.length = 0;
  stub.rulesets.disabled.length = 0;

  await callWorker(stub, { type: 'settings/update', patch: { protectionEnabled: false } });
  assert.deepEqual(stub.rulesets.disabled, ['youtube_ads'], 'Protection off must stop ad blocking');

  stub.rulesets.enabled.length = 0;
  await callWorker(stub, { type: 'settings/update', patch: { protectionEnabled: true } });
  assert.deepEqual(stub.rulesets.enabled, ['youtube_ads'], 'and on must resume it');
});

test('the ad switch alone controls the ruleset while Protection is on', async () => {
  const stub = await loadWorker();
  stub.rulesets.disabled.length = 0;
  await callWorker(stub, { type: 'settings/update', patch: { blockYoutubeAds: false } });
  assert.deepEqual(stub.rulesets.disabled, ['youtube_ads']);
});

// ── The password gate ────────────────────────────────────────────────────

test('a fresh install has no password and is not gated', async () => {
  const stub = await loadWorker();
  const state = await callWorker(stub, { type: 'state/get' });
  assert.equal(state.passwordSet, false);
  assert.equal(state.onboarded, false);

  // Protection can be changed freely.
  await callWorker(stub, { type: 'settings/update', patch: { protectionEnabled: false } });
  assert.equal(stub.sync[SETTINGS_KEY].protectionEnabled, false);
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

  // The gate is on the SWITCH, not on one direction: turning it back ON is
  // gated exactly the same way.
  await assert.rejects(
    () => callWorker(stub, { type: 'settings/update', patch: { protectionEnabled: true } }),
    (error) => error.code === 'invalid_password'
  );
  const reEnabled = await callWorker(stub, {
    type: 'settings/update',
    patch: { protectionEnabled: true },
    password: 'secret1',
  });
  assert.equal(reEnabled.settings.protectionEnabled, true, 'enabling needs the password too');
});

test('every other setting stays free while a password is set', async () => {
  // The password guards PROTECTION. Making it guard the keyword list too would
  // be a change nobody asked for and would make the lock feel like a cage.
  const stub = await loadWorker();
  await callWorker(stub, { type: 'password/set', password: 'secret1' });
  await callWorker(stub, { type: 'settings/update', patch: { blockShorts: true } });
  assert.equal(stub.sync[SETTINGS_KEY].blockShorts, true);
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

  // ...and Protection is free again.
  await callWorker(stub, { type: 'settings/update', patch: { protectionEnabled: false } });
  assert.equal(stub.sync[SETTINGS_KEY].protectionEnabled, false);
});

test('the content script is told about the ad switch', async () => {
  const stub = await loadWorker();
  const config = await callWorker(stub, { type: 'rules/forContent' });
  assert.equal(config.blockYoutubeAds, true, 'the ad switch must reach the page');
  assert.equal(typeof config.enabled, 'boolean');
});

test('skipping the first-run offer is recorded', async () => {
  const stub = await loadWorker();
  await callWorker(stub, { type: 'password/dismissOnboarding' });
  assert.equal((await callWorker(stub, { type: 'state/get' })).onboarded, true);
});
