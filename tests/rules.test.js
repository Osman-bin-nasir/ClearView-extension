import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADULT_DOMAINS,
  ALWAYS_BLOCK_KEYWORDS,
  COMBINATION_GENERIC_TERMS,
  COMBINATION_RISKY_TERMS,
  STRICT_MODE_KEYWORDS,
} from '../src/common/rules/index.js';
import { buildRuleBundle, normalizeHandle, normalizeKeywords } from '../src/common/rules-bundle.js';
import { activeBuiltInKeywords } from '../src/common/matching.js';

test('the built-in rule lists are populated', () => {
  assert.ok(ALWAYS_BLOCK_KEYWORDS.length > 500, `expected many keywords, got ${ALWAYS_BLOCK_KEYWORDS.length}`);
  assert.ok(ADULT_DOMAINS.length > 50, `expected many domains, got ${ADULT_DOMAINS.length}`);
  assert.ok(STRICT_MODE_KEYWORDS.length > 10, `expected strict terms, got ${STRICT_MODE_KEYWORDS.length}`);
  assert.ok(COMBINATION_GENERIC_TERMS.length > 10);
  assert.ok(COMBINATION_RISKY_TERMS.length > 10);
});

test('no comment text leaked into the generated rules', () => {
  for (const list of [ALWAYS_BLOCK_KEYWORDS, ADULT_DOMAINS, STRICT_MODE_KEYWORDS]) {
    for (const entry of list) {
      assert.equal(entry.trim(), entry, `untrimmed entry: ${JSON.stringify(entry)}`);
      assert.notEqual(entry, '');
      assert.ok(!entry.includes('//'), `comment leaked: ${JSON.stringify(entry)}`);
    }
  }
});

test('domains look like hostnames and keywords are lower-case', () => {
  for (const domain of ADULT_DOMAINS) {
    assert.match(domain, /^[a-z0-9.-]+\.[a-z]{2,}$/, `bad domain: ${domain}`);
  }
  for (const keyword of ALWAYS_BLOCK_KEYWORDS) {
    assert.equal(keyword, keyword.toLowerCase(), `not lower-case: ${keyword}`);
  }
});

test('strict mode adds terms on top of the always-on set', () => {
  const off = activeBuiltInKeywords(false);
  const on = activeBuiltInKeywords(true);
  assert.equal(off, ALWAYS_BLOCK_KEYWORDS);
  assert.ok(on.length > off.length);
  for (const keyword of ALWAYS_BLOCK_KEYWORDS) {
    assert.ok(on.includes(keyword));
  }
});

// ── The effective bundle ─────────────────────────────────────────────────

test('community rules are ADDED to the built-in rules, never substituted', () => {
  const settings = {
    strictMode: false,
    blockedDomains: [],
    userKeywords: ['instagram'],
    youtubeKeywords: [],
    blockedChannels: [],
  };
  const bundle = buildRuleBundle(settings, {
    keywords: [{ keyword: 'communityterm' }],
    channels: [{ handle: '@communitychannel' }],
  });

  assert.equal(bundle.builtIn, ALWAYS_BLOCK_KEYWORDS);
  assert.ok(bundle.everywhere.includes('instagram'));
  assert.ok(bundle.everywhere.includes('communityterm'));
  // Built-in domains survive a community merge.
  assert.ok(bundle.domains.length >= ADULT_DOMAINS.length);
  assert.ok(bundle.channels.includes('@communitychannel'));
});

test('a missing community snapshot can only make the bundle smaller, never empty it', () => {
  const settings = {
    strictMode: false,
    blockedDomains: [],
    userKeywords: [],
    youtubeKeywords: [],
    blockedChannels: [],
  };
  const bundle = buildRuleBundle(settings, null);
  assert.equal(bundle.builtIn.length, ALWAYS_BLOCK_KEYWORDS.length);
  assert.equal(bundle.domains.length, ADULT_DOMAINS.length);
  assert.deepEqual(bundle.everywhere, []);
});

test('YouTube keywords include everything that applies everywhere', () => {
  const bundle = buildRuleBundle(
    {
      strictMode: false,
      blockedDomains: [],
      userKeywords: ['everywhereterm'],
      youtubeKeywords: ['youtubeterm'],
      blockedChannels: [],
    },
    null
  );
  assert.ok(bundle.youtube.includes('youtubeterm'));
  assert.ok(bundle.youtube.includes('everywhereterm'));
});

test('user domains are merged with the built-in domains', () => {
  const bundle = buildRuleBundle(
    {
      strictMode: false,
      blockedDomains: ['mysite.example'],
      userKeywords: [],
      youtubeKeywords: [],
      blockedChannels: [],
    },
    null
  );
  assert.ok(bundle.domains.includes('mysite.example'));
  assert.ok(bundle.domains.includes('pornhub.com'));
});

test('handle and keyword normalization match the server', () => {
  assert.equal(normalizeHandle('@ExampleChannel'), '@examplechannel');
  assert.equal(normalizeHandle('examplechannel'), '@examplechannel');
  assert.equal(normalizeHandle('a'), null);
  assert.equal(normalizeHandle('has space'), null);
  assert.deepEqual(normalizeKeywords(['  Porn  ', 'porn', '', 'Sex']), ['porn', 'sex']);
});
