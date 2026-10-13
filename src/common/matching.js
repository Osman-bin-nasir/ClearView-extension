/**
 * The matching engine.
 *
 * A direct port of the Android app's `KeywordMatcher` + the derived-set logic in
 * `BlockRepository`, so the extension blocks by the SAME rules, with the SAME
 * normalization and the SAME whole-word boundaries as the phone. A second,
 * independently-invented matcher is exactly what the spec forbids: a term the
 * app blocks must not slip through in Chrome because the browser used a
 * different string comparison.
 *
 * This module is deliberately free of Chrome APIs — it is pure string work over
 * arrays handed in — so it can be unit-tested under plain Node (see tests/).
 *
 * ## The three tiers (unchanged from the app)
 *
 *  1. Clear adult keywords — active in every mode.
 *  2. Strict-Mode discovery terms — active only while Strict Mode is on.
 *  3. Context combination — a generic half AND a risky half in the same text
 *     ("woman" + "bikini") blocks, even though neither half blocks alone.
 */

import {
  ALWAYS_BLOCK_KEYWORDS,
  ADULT_DOMAINS,
  STRICT_MODE_KEYWORDS,
  COMBINATION_GENERIC_TERMS,
  COMBINATION_RISKY_TERMS,
} from './rules/index.js';

export const MatchType = Object.freeze({
  DOMAIN: 'DOMAIN',
  BUILT_IN_KEYWORD: 'BUILT_IN_KEYWORD',
  USER_KEYWORD: 'USER_KEYWORD',
  GLOBAL_KEYWORD: 'GLOBAL_KEYWORD',
  INCognito: 'INCOGNITO',
});

export const MatchSource = Object.freeze({
  URL: 'URL',
  QUERY: 'QUERY',
  DOMAIN: 'DOMAIN',
  TITLE: 'TITLE',
  DESCRIPTION: 'DESCRIPTION',
  FEED: 'FEED',
  NONE: 'NONE',
});

// ── Precompiled lookup tables (ported verbatim) ──────────────────────────

/** Visually-similar non-Latin letters folded to their Latin look-alikes. */
const HOMOGLYPH_MAP = new Map(Object.entries({
  // Cyrillic look-alikes.
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y',
  'х': 'x', 'в': 'b', 'н': 'h', 'м': 'm', 'т': 't', 'к': 'k',
  'і': 'i', 'ѕ': 's', 'г': 'r',
  // Greek look-alikes (practical subset).
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'σ': 's', 'ς': 's',
  'ι': 'i', 'ν': 'v', 'χ': 'x', 'κ': 'k', 'μ': 'm', 'τ': 't',
}));

/** Digit/symbol → letter leetspeak stand-ins (word-like tokens only). */
const LEET_MAP = new Map(Object.entries({
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's',
  '7': 't', '@': 'a', '$': 's', '!': 'i',
}));

/** Unicode-aware tests, matching Kotlin's `Char.isLetter()` / `isDigit()`. */
const LETTER = /[\p{L}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function isLetter(ch) {
  return LETTER.test(ch);
}

function isLetterOrDigit(ch) {
  return LETTER_OR_DIGIT.test(ch);
}

/**
 * Whether a keyword is matched as a WHOLE WORD rather than as a substring.
 *
 * Plain words (letters + spaces, every space-separated token at least two
 * letters) must never be glued to a neighbouring letter or digit: "cock" must
 * not match "cocktail". Obfuscation/leetspeak forms ("p0rn", "f*ck", "n u d e")
 * keep substring matching, because their only realistic occurrences are
 * standalone and their inflections must keep matching.
 */
export function isPlainWordKeyword(keyword) {
  let sawLetter = false;
  for (const ch of keyword) {
    if (ch === ' ') continue;
    if (!isLetter(ch)) return false;
    sawLetter = true;
  }
  if (!sawLetter) return false;
  for (const token of keyword.split(' ')) {
    if (token.length < 2) return false;
  }
  return true;
}

/**
 * Whole-word aware containment. [needsBoundary] is [isPlainWordKeyword]'s
 * verdict; the text must already be normalized.
 */
export function containsKeyword(text, keyword, needsBoundary) {
  if (!needsBoundary) return text.includes(keyword);
  let start = text.indexOf(keyword);
  while (start >= 0) {
    const end = start + keyword.length;
    const beforeIsWord = start > 0 && isLetterOrDigit(text[start - 1]);
    const afterIsWord = end < text.length && isLetterOrDigit(text[end]);
    if (!beforeIsWord && !afterIsWord) return true;
    start = text.indexOf(keyword, start + 1);
  }
  return false;
}

// ── Text normalization (pre-keyword matching) ────────────────────────────

function isPureNumericToken(token) {
  if (token.length === 0) return false;
  for (const ch of token) {
    if (!/[0-9]/.test(ch) && ch !== '.' && ch !== ',') return false;
  }
  return true;
}

function applyLeet(token) {
  if (isPureNumericToken(token)) return token;
  let letters = 0;
  for (const ch of token) if (isLetter(ch)) letters += 1;
  if (letters < 2) return token;
  let changed = false;
  for (const ch of token) {
    if (LEET_MAP.has(ch)) {
      changed = true;
      break;
    }
  }
  if (!changed) return token;
  let out = '';
  for (const ch of token) out += LEET_MAP.get(ch) ?? ch;
  return out;
}

/**
 * Collapse punctuation/underscore separators between SINGLE characters inside a
 * token: "p.o.r.n" -> "porn", "n_u_d_3" -> "nud3". Digits are leetspeak letters,
 * not separators, so "s3x"/"4x4" are never split.
 */
function collapseSingleLetterSeparators(token) {
  if (token.length <= 1) return token;
  let i = 0;
  let anySeparator = false;
  let content = '';
  while (i < token.length) {
    const ch = token[i];
    if (isLetter(ch) || /[0-9]/.test(ch)) {
      let j = i;
      while (j < token.length && (isLetter(token[j]) || /[0-9]/.test(token[j]))) j += 1;
      if (j - i > 1) return token; // multi-char run -> not the pattern
      content += token[i];
      i = j;
    } else {
      anySeparator = true;
      i += 1;
    }
  }
  return anySeparator && content.length > 0 ? content : token;
}

/** Join consecutive single-character tokens: "n u d e" -> "nude". */
function collapseSingleLetterRuns(tokens) {
  if (tokens.length < 2) return tokens;
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].length === 1) {
      const runStart = i;
      while (i < tokens.length && tokens[i].length === 1) i += 1;
      if (i - runStart >= 2) {
        let joined = '';
        for (let k = runStart; k < i; k += 1) joined += tokens[k];
        out.push(joined);
      } else {
        out.push(tokens[runStart]);
      }
    } else {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * Canonical form used for ALL keyword comparisons. Mirrors the app step for
 * step:
 *  1. lowercase + NFKC (collapses fullwidth/compatibility variants);
 *  2. homoglyph folding (Cyrillic/Greek -> Latin look-alikes);
 *  3. per-token separator collapsing, then whitespace single-letter-run
 *     collapsing ("n u d e" -> "nude");
 *  4. leetspeak substitution on word-like tokens ("p0rn" -> "porn").
 */
export function normalizeForMatching(text) {
  // 1. Lowercase, then NFKC.
  let base = String(text).toLowerCase().normalize('NFKC');
  // 2. Homoglyph folding (only when the text contains any).
  if ([...base].some((ch) => HOMOGLYPH_MAP.has(ch))) {
    let folded = '';
    for (const ch of base) folded += HOMOGLYPH_MAP.get(ch) ?? ch;
    base = folded;
  }
  // 3. Per-token separator collapsing, then single-letter-run collapsing.
  const tokens = base.split(' ').filter((t) => t.length > 0);
  const collapsed = tokens.map(collapseSingleLetterSeparators);
  const runs = collapseSingleLetterRuns(collapsed);
  // 4. Leetspeak.
  return runs.map(applyLeet).join(' ');
}

// ── Keyword-set compilation ──────────────────────────────────────────────

/**
 * Compiled keyword lists, memoized by ARRAY IDENTITY.
 *
 * The built-in lists are ~700 entries and are handed to the matcher on every
 * navigation, so sorting and classifying them per call would be wasteful. The
 * lists this module is given are stable module-level arrays (built once in
 * settings.js), so identity is a safe cache key — a genuinely new list is a new
 * key and builds a fresh entry. A WeakMap lets a replaced list be collected.
 */
const compiledCache = new WeakMap();

function compile(keywords) {
  const cached = compiledCache.get(keywords);
  if (cached) return cached;
  const entries = [...keywords]
    .sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0))
    .map((original) => {
      const normalized = normalizeForMatching(original);
      return { original, normalized, needsBoundary: isPlainWordKeyword(normalized) };
    });
  compiledCache.set(keywords, entries);
  return entries;
}

/**
 * First keyword matched in [normalizedText], or null.
 *
 * Longest-first, so a longer, more specific rule names the match over a shorter
 * one contained in it.
 */
export function checkKeywords(normalizedText, keywords) {
  if (!keywords || keywords.length === 0) return null;
  for (const entry of compile(keywords)) {
    if (containsKeyword(normalizedText, entry.normalized, entry.needsBoundary)) {
      return entry.original;
    }
  }
  return null;
}

// ── Domains ──────────────────────────────────────────────────────────────

/**
 * Safely extract the host from a URL-like string, matching the app's
 * `extractHost` (adds a scheme when missing, drops a leading "www.").
 */
export function extractHost(text) {
  let s = String(text).trim().toLowerCase();
  if (!s.startsWith('http://') && !s.startsWith('https://')) {
    s = `https://${s}`;
  }
  try {
    const host = new URL(s).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * The host for a blocked-domain comparison: exact host, or a subdomain of a
 * blocked domain (so "www.pornhub.com" and "m.pornhub.com" both match
 * "pornhub.com").
 */
export function checkDomains(urlText, domains) {
  if (!domains || domains.length === 0) return null;
  const host = extractHost(urlText);
  if (!host) return null;
  for (const domain of domains) {
    if (host === domain || host.endsWith(`.${domain}`)) return domain;
  }
  return null;
}

/** Normalize a user-entered domain to a hostname, or null. Ported from the app. */
export function normalizeDomain(input) {
  let candidate = String(input).trim().toLowerCase();
  if (candidate.length === 0) return null;
  if (!candidate.startsWith('http://') && !candidate.startsWith('https://')) {
    candidate = `https://${candidate}`;
  }
  let host;
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.+$/, '');
  if (host.length === 0 || host.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  if (host.includes('..') || host.startsWith('.') || host.endsWith('.')) return null;
  return host;
}

// ── Tier 3: context combination ──────────────────────────────────────────

const GENERIC_TERMS = new Set(COMBINATION_GENERIC_TERMS);
const RISKY_TERMS = new Set(COMBINATION_RISKY_TERMS);

/**
 * Blocks when the text contains BOTH a generic discovery half (woman, girl,
 * beach, ...) AND a risky half (bikini, lingerie, pics, ...), reusing the same
 * whole-word rule. A term that is both halves ("beach") never self-combines.
 */
export function checkCombinationTerms(normalizedText) {
  if (GENERIC_TERMS.size === 0 || RISKY_TERMS.size === 0) return null;
  let genericHit = null;
  for (const term of COMBINATION_GENERIC_TERMS) {
    if (containsKeyword(normalizedText, normalizeForMatching(term), isPlainWordKeyword(normalizeForMatching(term)))) {
      genericHit = term;
      if (!RISKY_TERMS.has(term)) break;
    }
  }
  if (genericHit === null) return null;
  for (const term of COMBINATION_RISKY_TERMS) {
    if (term === genericHit) continue;
    const normalized = normalizeForMatching(term);
    if (containsKeyword(normalizedText, normalized, isPlainWordKeyword(normalized))) {
      return `${genericHit} + ${term}`;
    }
  }
  return null;
}

// ── Built-in set derivation ──────────────────────────────────────────────

/**
 * The active built-in keyword list for a given mode.
 *
 * Tier 1 (clear adult terms) is always present; Tier 2 (discovery terms) is
 * added only under Strict Mode. Returns the SAME cached arrays that ship in
 * rules/ whenever no derivation is needed, so the matcher's identity cache is
 * hit rather than rebuilt.
 *
 * (The app's TAB_RESTRICTED_KEYWORDS is empty, so the "website" set equals the
 * active built-in set — this collapses to one list, exactly as in the app.)
 */
export function activeBuiltInKeywords(strictMode) {
  if (!strictMode) return ALWAYS_BLOCK_KEYWORDS;
  return STRICT_ACTIVE;
}

let STRICT_ACTIVE = null;
function strictActive() {
  if (STRICT_ACTIVE === null) {
    STRICT_ACTIVE = [...new Set([...ALWAYS_BLOCK_KEYWORDS, ...STRICT_MODE_KEYWORDS])];
  }
  return STRICT_ACTIVE;
}
// Eagerly build once so activeBuiltInKeywords() never allocates on the hot path.
STRICT_ACTIVE = strictActive();

/**
 * The built-in domains plus any user-blocked domains, deduplicated.
 * Community (global) rules are merged by the caller — this stays the
 * built-in + user union.
 */
export function allBlockedDomains(userDomains) {
  if (!userDomains || userDomains.length === 0) return ADULT_DOMAINS;
  return [...new Set([...ADULT_DOMAINS, ...userDomains])];
}

/** The built-in domains, exposed for the settings UI. */
export const BUILT_IN_DOMAINS = ADULT_DOMAINS;

// ── Result shape ─────────────────────────────────────────────────────────

export const Allowed = Object.freeze({ blocked: false });

export function Blocked(matchedItem, matchType, matchSource = MatchSource.NONE, extra = {}) {
  return { blocked: true, matchedItem, matchType, matchSource, ...extra };
}

/**
 * The URL/text-level check, mirroring `KeywordMatcher.checkString`.
 *
 * @param {string} text               raw text or URL
 * @param {object} opts
 * @param {boolean} opts.isUrl        true for a URL (enables domain matching and
 *                                    disables the combination tier, so a path
 *                                    like /photos/beach.html cannot trip it)
 * @param {string[]} opts.builtIn     active built-in keyword list
 * @param {string[]} opts.userKeywords user's own + community keywords
 * @param {string[]} opts.domains     built-in + user blocked domains
 * @param {string}   opts.userType    MatchType to report for userKeywords
 */
export function checkString(text, opts) {
  const {
    isUrl = false,
    builtIn = ALWAYS_BLOCK_KEYWORDS,
    userKeywords = [],
    domains = ADULT_DOMAINS,
    userType = MatchType.USER_KEYWORD,
  } = opts ?? {};

  const normalized = normalizeForMatching(text);

  if (isUrl) {
    const matchedDomain = checkDomains(normalized, domains);
    if (matchedDomain !== null) {
      return Blocked(matchedDomain, MatchType.DOMAIN, MatchSource.DOMAIN);
    }
  }

  const matchedBuiltIn = checkKeywords(normalized, builtIn);
  if (matchedBuiltIn !== null) {
    return Blocked(matchedBuiltIn, MatchType.BUILT_IN_KEYWORD, MatchSource.NONE);
  }

  const matchedUser = checkKeywords(normalized, userKeywords);
  if (matchedUser !== null) {
    return Blocked(matchedUser, userType, MatchSource.NONE);
  }

  if (!isUrl) {
    const matchedCombo = checkCombinationTerms(normalized);
    if (matchedCombo !== null) {
      return Blocked(matchedCombo, MatchType.BUILT_IN_KEYWORD, MatchSource.NONE);
    }
  }

  return Allowed;
}
