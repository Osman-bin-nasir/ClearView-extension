/**
 * The local Protection password.
 *
 * The stored record is the interesting part: it must never contain the password
 * itself, it must not be reusable against a different password, and the same
 * password must not produce the same bytes twice — or a leaked store would be
 * comparable against a list. Those are the properties tested here, against the
 * real module and real WebCrypto, with only `chrome.storage` stubbed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearPassword,
  getPasswordRecord,
  hasPassword,
  isOnboarded,
  markOnboarded,
  setPassword,
  validatePassword,
  verifyPassword,
} from '../src/common/password.js';
import { STORAGE } from '../src/common/constants.js';

/** A `chrome` stub with only the storage the password module touches. */
function stubChrome() {
  const local = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') return key in local ? { [key]: local[key] } : {};
          const out = {};
          for (const k of [].concat(key)) if (k in local) out[k] = local[k];
          return out;
        },
        async set(values) {
          Object.assign(local, values);
        },
        async remove(key) {
          for (const k of [].concat(key)) delete local[k];
        },
      },
      sync: {
        async get() {
          return {};
        },
        async set() {},
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
  return { local };
}

test('no password is set on a fresh install', async () => {
  stubChrome();
  assert.equal(await hasPassword(), false);
  assert.equal(await verifyPassword(''), false);
  assert.equal(await verifyPassword('anything'), false);
  assert.equal(await getPasswordRecord(), null);
});

test('the stored record never contains the password', async () => {
  const { local } = stubChrome();
  await setPassword('hunter2');

  const record = local[STORAGE.password];
  assert.ok(record, 'a record must be written');
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes('hunter2'), 'the plaintext password must not be stored');
  assert.equal(typeof record.hash, 'string');
  assert.equal(typeof record.salt, 'string');
  assert.equal(record.algorithm, 'PBKDF2-SHA256');
  assert.ok(record.iterations >= 10_000, 'the work factor must be meaningful');
});

test('the right password verifies and a wrong one does not', async () => {
  stubChrome();
  await setPassword('correct horse');
  assert.equal(await hasPassword(), true);
  assert.equal(await verifyPassword('correct horse'), true);
  assert.equal(await verifyPassword('correct horse '), false);
  assert.equal(await verifyPassword('Correct horse'), false);
  assert.equal(await verifyPassword(''), false);
});

test('the same password hashes differently every time (per-install salt)', async () => {
  const { local } = stubChrome();
  await setPassword('same-password');
  const first = local[STORAGE.password];
  await setPassword('same-password');
  const second = local[STORAGE.password];

  assert.notEqual(first.salt, second.salt, 'a fresh salt is required per write');
  assert.notEqual(first.hash, second.hash, 'equal hashes would make the store comparable');
  // ...and the new one is the one that verifies.
  assert.equal(await verifyPassword('same-password'), true);
});

test('replacing the password invalidates the old one', async () => {
  stubChrome();
  await setPassword('first-password');
  await setPassword('second-password');
  assert.equal(await verifyPassword('first-password'), false);
  assert.equal(await verifyPassword('second-password'), true);
});

test('removing the password leaves nothing that verifies', async () => {
  stubChrome();
  await setPassword('a-password');
  await clearPassword();
  assert.equal(await hasPassword(), false);
  assert.equal(await verifyPassword('a-password'), false);
});

test('a too-short password is refused with a code the UI can word', async () => {
  stubChrome();
  await assert.rejects(
    () => setPassword('abc'),
    (error) => error.code === 'password_too_short'
  );
  assert.equal(await hasPassword(), false, 'a refused password must not be stored');
});

test('length is counted in code points, not UTF-16 units', () => {
  // Four emoji are four characters to a person; counted in UTF-16 units they
  // would be eight, and a two-emoji password would slip through a four-character
  // rule. This is the reason the check is written the way it is.
  assert.doesNotThrow(() => validatePassword('🔐🔑🗝️🛡'));
  assert.throws(() => validatePassword('🔐🔑'), (error) => error.code === 'password_too_short');
});

test('a non-string is refused rather than coerced', async () => {
  stubChrome();
  await assert.rejects(() => setPassword(undefined), (error) => error.code === 'invalid_password');
  await assert.rejects(() => setPassword(null), (error) => error.code === 'invalid_password');
});

test('the first-run offer is remembered once answered', async () => {
  stubChrome();
  assert.equal(await isOnboarded(), false);
  await markOnboarded();
  assert.equal(await isOnboarded(), true);
});
