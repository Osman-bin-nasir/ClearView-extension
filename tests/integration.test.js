/**
 * End-to-end checks over the REAL rule set.
 *
 * The unit tests use hand-written stubs; these use the actual ported built-in
 * rules and the actual evaluator, which is the combination the browser will run.
 * A matcher that passes only against stub keywords proves nothing about whether
 * the extension blocks anything on a real page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/common/constants.js';
import { buildRuleBundle } from '../src/common/rules-bundle.js';
import { evaluateUrl } from '../src/background/blocking.js';
import { fetchRules } from '../src/background/api.js';

const settings = { ...DEFAULT_SETTINGS };
const state = { settings, bundle: buildRuleBundle(settings, null) };

test('the real built-in rules block a known adult host', () => {
  assert.equal(evaluateUrl('https://www.pornhub.com/watch', state).action, 'block');
  assert.equal(evaluateUrl('https://m.xvideos.com/video', state).action, 'block');
});

test('the real built-in rules block an explicit keyword inside a URL', () => {
  const decision = evaluateUrl('https://someblog.example/porn-video', state);
  assert.equal(decision.action, 'block');
});

test('an explicit search is caught, and a normal one is not', () => {
  assert.equal(evaluateUrl('https://www.google.com/search?q=porn', state).action, 'search');
  assert.equal(evaluateUrl('https://www.google.com/search?q=sourdough+bread+recipe', state).action, 'allow');
});

test('ordinary browsing is unaffected', () => {
  for (const url of [
    'https://www.wikipedia.org/',
    'https://news.ycombinator.com/',
    'https://www.google.com/search?q=weather+in+london',
    'https://github.com/explore',
  ]) {
    assert.equal(evaluateUrl(url, state).action, 'allow', url);
  }
});

test('Strict Mode adds blocking the default set does not', () => {
  const strictState = {
    settings: { ...settings, strictMode: true },
    bundle: buildRuleBundle({ ...settings, strictMode: true }, null),
  };
  const target = 'https://www.google.com/search?q=bikini';
  assert.equal(evaluateUrl(target, state).action, 'allow');
  assert.equal(evaluateUrl(target, strictState).action, 'search');
});

test('a community rule is enforced once it is in the bundle', () => {
  const withCommunity = {
    settings,
    bundle: buildRuleBundle(settings, {
      keywords: [{ keyword: 'communityonlyterm' }],
      channels: [],
    }),
  };
  assert.equal(evaluateUrl('https://example.com/communityonlyterm', withCommunity).action, 'block');
  assert.equal(
    evaluateUrl('https://example.com/communityonlyterm', state).action,
    'allow',
    'the term must not block without the community snapshot'
  );
});

test('the live backend serves the rule contract this extension expects', async (t) => {
  let snapshot;
  try {
    snapshot = await fetchRules(DEFAULT_SETTINGS.apiBase);
  } catch (error) {
    t.skip(`backend unreachable (${error.code ?? error.message}) — skipping the live check`);
    return;
  }
  assert.equal(typeof snapshot.version, 'string');
  assert.ok(Array.isArray(snapshot.keywords));
  assert.ok(Array.isArray(snapshot.channels));
  for (const keyword of snapshot.keywords) {
    assert.equal(typeof keyword.keyword, 'string');
  }
  for (const channel of snapshot.channels) {
    assert.match(channel.handle, /^@/, `handle should carry a leading @: ${channel.handle}`);
  }
});
