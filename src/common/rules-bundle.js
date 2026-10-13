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
import { normalizeBlockedChannels, normalizeHandle } from './channels.js';

// Channel identity lives in `channels.js` so the block-list matching and the
// URL parsing that feeds it sit together. Re-exported here because this is the
// module the UI and the tests already import a handle normalizer from.
export { normalizeHandle };

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
 * @returns {{ builtIn: string[], domains: string[], everywhere: string[], youtube: string[], channels: string[], channelIds: string[] }}
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

  // A blocked channel is stored by handle AND, when the page offered one, by
  // channel id. Both are carried: a handle can be changed by the channel and an
  // id cannot, so a block made from a `/channel/UC…` URL would be lost the day
  // the channel renamed itself if only the id were kept, and the reverse holds
  // for a block made from `/@handle` before the id was ever seen.
  const blocked = normalizeBlockedChannels(settings.blockedChannels ?? []);

  const channels = [
    ...new Set([
      ...blocked.map((c) => c.handle).filter(Boolean),
      ...globalChannels.map((h) => normalizeHandle(h)).filter(Boolean),
    ]),
  ];

  const channelIds = [...new Set(blocked.map((c) => c.channelId).filter(Boolean))];

  return { builtIn, domains, everywhere, youtube, channels, channelIds };
}
