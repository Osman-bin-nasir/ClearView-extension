/**
 * The privacy policy page, and the place that links to it.
 *
 * The policy is static HTML — deliberately: a page whose whole job is to say
 * what does and does not leave the browser should be incapable of sending
 * anything itself, so there is no script on it and nothing to intercept. These
 * checks pin that, the disclosures the page has to carry, and that the link out
 * of the extension points at a file that actually ships.
 *
 * The link lives on the settings page and not on the popup: the popup is one
 * activity panel, and everything with a sentence of explanation behind
 * it — the policy included — is one click further in. Removing the policy from
 * the extension entirely would be a different thing, and this test is also what
 * would fail if that happened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = resolve(ROOT, 'src/privacy/privacy.html');
const html = readFileSync(PAGE, 'utf8');
const css = readFileSync(resolve(ROOT, 'src/privacy/privacy.css'), 'utf8');
const options = readFileSync(resolve(ROOT, 'src/options/options.js'), 'utf8');
const popup = readFileSync(resolve(ROOT, 'src/popup/popup.js'), 'utf8');
const popupHtml = readFileSync(resolve(ROOT, 'src/popup/popup.html'), 'utf8');

test('the privacy policy page ships and is self-contained', () => {
  assert.ok(existsSync(PAGE), 'src/privacy/privacy.html must exist');
  assert.ok(existsSync(resolve(ROOT, 'src/privacy/privacy.css')), 'and its stylesheet must exist');
  assert.ok(
    /href="\.\.\/ui\/theme\.css"/.test(html),
    'it reuses the shared design system rather than a private palette'
  );
  assert.ok(
    /href="\.\.\/options\/options\.html"/.test(html),
    'it links back to the blocking settings'
  );
  assert.ok(
    existsSync(resolve(ROOT, 'src/options/options.html')),
    'and the page it links back to exists'
  );
});

test('the policy page cannot send anything itself', () => {
  // A policy page with a script could not be trusted by reading it. There is no
  // script, no inline handler and no network call: the page is inert.
  assert.ok(!/<script/i.test(html), 'no script tag belongs on the privacy page');
  assert.ok(!/on(click|load|change|submit)\s*=/i.test(html), 'no inline handlers either');
  assert.ok(!/\b(fetch|XMLHttpRequest|sendBeacon)\b/.test(html), 'and nothing that could send a request');
  assert.ok(!/privacy\.js/.test(html), 'there is no module to load');
});

test('the policy discloses what stays on the device and what can leave it', () => {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /checked on your device/i, 'the on-device check is stated');
  assert.match(text, /never uploaded/i, 'and that visits are not uploaded');
  assert.match(text, /no browsing history/i, 'no browsing history is collected');
  assert.match(text, /random install id/i, 'the anonymous id is described as random');
  assert.match(text, /derived from nothing about you/i, 'and as derived from nothing about the user');
  assert.match(text, /PBKDF2/i, 'the password is described as a local hash, not stored text');
  assert.match(text, /device lock, not an account/i, 'and not oversold as authentication');
  assert.match(text, /Removing the extension/i, 'the user is told how to delete their data');
  assert.match(text, /no account/i, 'and that no account is needed');
});

test('the settings page links to the shipped policy, and the popup links to the settings', () => {
  // The link is built as `chrome.runtime.getURL('src/privacy/privacy.html')`, so
  // the path in the code is the path on disk — a rename would break this test
  // rather than a user's click.
  const match = options.match(/getURL\('(src\/privacy\/privacy\.html)'\)/);
  assert.ok(match, 'options.js must open the privacy page');
  assert.ok(existsSync(resolve(ROOT, match[1])), 'and point at a file that ships');

  assert.ok(
    /openPrivacyPolicy/.test(options) && /privacy\.card/.test(options),
    'the settings Privacy card offers the policy and is still rendered'
  );
  assert.ok(
    /chrome\.runtime\.openOptionsPage\(\)/.test(popup),
    'the popup reaches the policy the way it reaches everything else: through the settings page'
  );
  assert.ok(
    !/open-privacy/.test(popupHtml),
    'and it carries no privacy control of its own, because it has no footer any more'
  );
  assert.ok(css.trim().length > 0, 'the page has its own stylesheet');
});
