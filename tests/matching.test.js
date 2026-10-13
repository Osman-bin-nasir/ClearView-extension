import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MatchSource,
  MatchType,
  checkCombinationTerms,
  checkDomains,
  checkString,
  containsKeyword,
  extractHost,
  isPlainWordKeyword,
  normalizeDomain,
  normalizeForMatching,
} from '../src/common/matching.js';

// ── Normalization ────────────────────────────────────────────────────────

test('normalization folds fullwidth, leetspeak, separator and spaced forms', () => {
  assert.equal(normalizeForMatching('ＰＯＲＮ'), 'porn'); // fullwidth -> NFKC
  assert.equal(normalizeForMatching('p0rn'), 'porn'); // leetspeak
  assert.equal(normalizeForMatching('s3x'), 'sex'); // leetspeak
  assert.equal(normalizeForMatching('p.o.r.n'), 'porn'); // separator collapsing
  assert.equal(normalizeForMatching('n u d e'), 'nude'); // single-letter run
  assert.equal(normalizeForMatching('watch porn now'), 'watch porn now');
});

test('normalization leaves ordinary numeric text alone', () => {
  assert.equal(normalizeForMatching('class of 2025'), 'class of 2025');
  assert.equal(normalizeForMatching('the score was 100 to 0'), 'the score was 100 to 0');
});

// ── Whole-word matching ──────────────────────────────────────────────────

test('plain-word keywords require a whole word', () => {
  assert.equal(isPlainWordKeyword('sex'), true);
  assert.equal(isPlainWordKeyword('sex tape'), true);
  assert.equal(isPlainWordKeyword('p0rn'), false);
  assert.equal(isPlainWordKeyword('p.o.r.n'), false);
  assert.equal(isPlainWordKeyword('n u d e'), false);
});

test('containsKeyword honours whole-word boundaries', () => {
  assert.equal(containsKeyword('sex education', 'sex', true), true);
  assert.equal(containsKeyword('middlesex', 'sex', true), false);
  assert.equal(containsKeyword('sextant', 'sex', true), false);
  assert.equal(containsKeyword('class', 'ass', true), false);
  // Non-boundary keywords keep substring matching, so inflections still hit.
  assert.equal(containsKeyword('p0rnstar', 'p0rn', false), true);
});

test('checkKeywords matches leetspeak and separated forms through normalization', () => {
  const builtIn = ['porn'];
  for (const attempt of ['porn', 'p0rn', 'p.o.r.n', 'ＰＯＲＮ']) {
    const verdict = checkString(attempt, { isUrl: false, builtIn, userKeywords: [], domains: [] });
    assert.equal(verdict.blocked, true, `expected ${attempt} to be blocked`);
  }
});

// ── Domains ──────────────────────────────────────────────────────────────

test('extractHost normalizes a URL-like string', () => {
  assert.equal(extractHost('https://www.Example.com/path'), 'example.com');
  assert.equal(extractHost('pornhub.com/watch'), 'pornhub.com');
});

test('checkDomains matches a blocked domain and its subdomains', () => {
  const domains = ['pornhub.com'];
  assert.equal(checkDomains('https://www.pornhub.com/x', domains), 'pornhub.com');
  assert.equal(checkDomains('https://m.pornhub.com/x', domains), 'pornhub.com');
  assert.equal(checkDomains('https://notpornhub.com/x', domains), null);
  assert.equal(checkDomains('https://example.com/x', domains), null);
});

test('normalizeDomain accepts hostnames and rejects nonsense', () => {
  assert.equal(normalizeDomain('https://www.example.com/path'), 'example.com');
  assert.equal(normalizeDomain('  EXAMPLE.com  '), 'example.com');
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain('not a domain'), null);
});

// ── checkString tiers ────────────────────────────────────────────────────

test('a blocked domain is reported as a domain match', () => {
  const verdict = checkString('https://www.pornhub.com/watch', {
    isUrl: true,
    builtIn: ['porn'],
    userKeywords: [],
    domains: ['pornhub.com'],
  });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.matchType, MatchType.DOMAIN);
  assert.equal(verdict.matchSource, MatchSource.DOMAIN);
});

test('a keyword inside a URL blocks on the URL itself', () => {
  const verdict = checkString('https://example.com/watch/porn', {
    isUrl: true,
    builtIn: ['porn'],
    userKeywords: [],
    domains: [],
  });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.matchType, MatchType.BUILT_IN_KEYWORD);
});

test('a user keyword blocks and is reported with the caller-supplied type', () => {
  const verdict = checkString('https://instagram.com/someone', {
    isUrl: true,
    builtIn: [],
    userKeywords: ['instagram'],
    domains: [],
  });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.matchType, MatchType.USER_KEYWORD);
  assert.equal(verdict.matchedItem, 'instagram');
});

test('an ordinary page is allowed', () => {
  const verdict = checkString('https://example.com/articles/technology', {
    isUrl: true,
    builtIn: ['porn'],
    userKeywords: ['instagram'],
    domains: ['pornhub.com'],
  });
  assert.equal(verdict.blocked, false);
});

// ── Tier 3: combination ──────────────────────────────────────────────────

test('combination terms block only when both halves are present', () => {
  assert.notEqual(checkCombinationTerms(normalizeForMatching('woman bikini')), null);
  assert.notEqual(checkCombinationTerms(normalizeForMatching('girl pics')), null);
  assert.equal(checkCombinationTerms(normalizeForMatching('woman')), null);
  assert.equal(checkCombinationTerms(normalizeForMatching('bikini')), null);
  // A term that is BOTH halves must never combine with itself.
  assert.equal(checkCombinationTerms(normalizeForMatching('beach')), null);
});

test('combination tier never applies to URLs', () => {
  const verdict = checkString('https://example.com/photos/beach.html', {
    isUrl: true,
    builtIn: [],
    userKeywords: [],
    domains: [],
  });
  assert.equal(verdict.blocked, false);
});
