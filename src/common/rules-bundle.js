/**
 * The effective rule set a page is judged against.
 *
 * A pure function of (settings, cached global rules) so the exact set the
 * browser enforces can be unit-tested without a browser — and so the one rule
 * that matters most stays visible: community rules are ADDED to the built-in
 * rules, never substituted for them. A dead backend, or an empty shared
 * blocklist, can therefore only ever block LESS than before, never more, and
 * never nothing.
 */

import { activeBuiltInKeywords, allBlockedDomains } from './matching.js';

/**
 * Normalize a channel handle the way the backend does: one leading "@",
 * lower-cased, and null for anything not a plausible handle. Mirrored here so
 * the extension and the server agree on what a given input means.
 */
export function normalizeHandle(input) {
  const withoutAt = String(input).trim().replace(/^@+/, '').trim();
  if (withoutAt === '') return null;
  const body = withoutAt.toLowerCase();
  if (!/^[a-z0-9._-]{2,100}$/.test(body)) return null;
  return `@${body}`;
}

/** Case-folded, de-duplicated keyword list, preserving first-seen order. */
export function normalizeKeywords(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list ?? []) {
    const keyword = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
    if (keyword === '' || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
  }
  return out;
}

/**
 * Build the enforcement bundle.
 *
 * @param {object} settings     the merged settings object
 * @param {object|null} global  the cached global rules `{ keywords, channels }`
 * @returns {{ builtIn: string[], domains: string[], everywhere: string[], youtube: string[], channels: string[] }}
 */
export function buildRuleBundle(settings, global) {
  const globalKeywords = (global?.keywords ?? []).map((k) => k.keyword);
  const globalChannels = (global?.channels ?? []).map((c) => c.handle);

  // Built-in: Tier 1 always, Tier 2 only under Strict Mode. Returns a stable
  // module-level array when possible, so the matcher's identity cache is hit.
  const builtIn = activeBuiltInKeywords(Boolean(settings.strictMode));

  // Domains: built-in adult domains + the user's own. Never community-supplied
  // (a submitted keyword is a term, not a hostname).
  const domains = allBlockedDomains(settings.blockedDomains ?? []);

  // Keywords applied to every page and search: the user's "everywhere" list plus
  // the community rules an administrator approved.
  const everywhere = normalizeKeywords([...(settings.userKeywords ?? []), ...globalKeywords]);

  // Keywords applied to YouTube surfaces: the YouTube-only list, plus everything
  // that already applies everywhere.
  const youtube = normalizeKeywords([...(settings.youtubeKeywords ?? []), ...everywhere]);

  const channels = [
    ...new Set([
      ...(settings.blockedChannels ?? []).map((c) => normalizeHandle(c.handle)).filter(Boolean),
      ...globalChannels.map((h) => normalizeHandle(h)).filter(Boolean),
    ]),
  ];

  return { builtIn, domains, everywhere, youtube, channels };
}
