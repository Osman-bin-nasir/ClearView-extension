/**
 * The anonymous identity row, and the option that is no longer on it.
 *
 * The id is what ties one install's contributions together on the server, so it
 * is generated once and never replaced. The card used to offer "New identity",
 * which regenerated it on demand; these checks keep the whole path gone — the
 * button, the message that ran it, and the two helpers behind it — because a
 * half-removed feature is one that comes back the next time someone wires up a
 * button and finds a handler already waiting for it.
 *
 * The options page is a classic script with no module system, so — as with the
 * other page tests here — the invariants are checked STATICALLY against the
 * shipped files.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = readFileSync(resolve(ROOT, 'src/options/options.js'), 'utf8');
const worker = readFileSync(resolve(ROOT, 'src/background/service-worker.js'), 'utf8');
const settings = readFileSync(resolve(ROOT, 'src/common/settings.js'), 'utf8');
const shared = readFileSync(resolve(ROOT, 'src/ui/shared.js'), 'utf8');

test('the identity card offers no way to create a new identity', () => {
  assert.ok(
    !/text: 'New identity'/.test(options),
    'the New identity button is gone'
  );
  assert.ok(
    !/send\('identity\/regenerate'\)/.test(options),
    'and nothing on the page asks the worker to rotate the id'
  );
  assert.ok(
    /function identityCard\(anonymousId\)/.test(options),
    'the card itself stays: the id is still shown'
  );
  assert.ok(
    /el\('div', \{ class: 'identity', text: anonymousId \}\)/.test(options),
    'and it still shows this install’s id'
  );
  assert.ok(
    !/Regenerating it/.test(options),
    'the copy promising what regeneration costs is gone with the button'
  );
});

test('there is no regenerate path left anywhere behind the page', () => {
  assert.ok(
    !/'identity\/regenerate'/.test(worker),
    'the worker must not keep an unreachable handler for a removed option'
  );
  assert.ok(
    !/regenerateAnonymousId/.test(worker) && !/export async function regenerateAnonymousId/.test(settings),
    'nor the helper it called'
  );
  assert.ok(
    /export async function getAnonymousId\(\)/.test(settings),
    'the id is still generated once, on demand'
  );
});

test('the error copy no longer points at a button that does not exist', () => {
  const at = shared.indexOf("case 'invalid_anonymous_id':");
  assert.ok(at !== -1, 'the case is still handled');
  const body = shared.slice(at, at + 400);
  assert.ok(
    !/New identity/.test(body.replace(/\/\/[^\n]*/g, '')),
    'a remedy that cannot be carried out is worse than none: nothing may tell the user to “tap New identity”'
  );
  assert.ok(
    /rejected by the server/.test(body),
    'the message still says what happened'
  );
});
