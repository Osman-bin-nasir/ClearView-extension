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
import { normalizeBlockedChannels, normalizeChannelName, normalizeHandle } from './channels.js';

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
 * @returns {{ builtIn: string[], domains: string[], everywhere: string[], youtube: string[], channels: string[], channelIds: string[], channelNames: string[] }}
 */
export function buildRuleBundle(settings, global) {
  const globalKeywordsRaw = (global?.keywords ?? []).map((k) => k.keyword);
  const globalChannelsRaw = (global?.channels ?? []).map((c) => c.handle);

  // Built-in: Tier 1 always, Tier 2 only under Strict Mode. Returns a stable
  // module-level array when possible, so the matcher's identity cache is hit.
  const builtIn = activeBuiltInKeywords(Boolean(settings.strictMode));

  // Domains: built-in adult domains + the user's own. Never community-supplied
  // (a submitted keyword is a term, not a hostname).
  const domains = allBlockedDomains(settings.blockedDomains ?? []);

  // Keywords applied to every page and search: the user's "everywhere" list plus
  // the community rules an administrator approved.
  const everywhere = normalizeKeywords([...(settings.userKeywords ?? []), ...globalKeywordsRaw]);

  // Keywords applied to YouTube surfaces: the YouTube-only list, plus everything
  // that already applies everywhere.
  const youtube = normalizeKeywords([...(settings.youtubeKeywords ?? []), ...everywhere]);

  // A blocked channel is stored by handle AND, when the page offered one, by
  // channel id. Both are carried: a handle can be changed by the channel and an
  // id cannot, so a block made from a `/channel/UC…` URL would be lost the day
  // the channel renamed itself if only the id were kept, and the reverse holds
  // for a block made from `/@handle` before the id was ever seen.
  const blocked = normalizeBlockedChannels(settings.blockedChannels ?? []);

  // Provenance, kept beside the merged sets: a false-positive report is only
  // offered for a COMMUNITY rule, never for a rule the user wrote themselves —
  // and the content script must be able to tell the two apart without ever
  // seeing either list. The values are normalized exactly like the matching
  // sets, so a verdict's `matchedItem` can be looked up here verbatim.
  const globalKeywords = normalizeKeywords(globalKeywordsRaw);
  const globalChannels = [...new Set(globalChannelsRaw.map((h) => normalizeHandle(h)).filter(Boolean))];

  const channels = [
    ...new Set([...blocked.map((c) => c.handle).filter(Boolean), ...globalChannels]),
  ];

  const channelIds = [...new Set(blocked.map((c) => c.channelId).filter(Boolean))];

  // The displayed NAMES the user blocked, carried alongside the handles for one
  // reason: YouTube's CURRENT grid renders a card's channel as an attributed
  // string with a click command and NO href — the printed name is all such a
  // card gives — so a channel blocked by handle kept appearing in the feed.
  const channelNames = [...new Set(blocked.map((c) => normalizeChannelName(c.name)).filter(Boolean))];

  return {
    builtIn,
    domains,
    everywhere,
    youtube,
    channels,
    channelIds,
    channelNames,
    globalKeywords,
    globalChannels,
  };
}

/**
 * A short, opaque fingerprint of everything that decides what a page hides.
 *
 * The content script has to know when its own past decisions have gone stale —
 * a card it judged clean two pages ago must be judged again after the user
 * blocks a channel — without ever holding the rules themselves. So the worker
 * sends this, and the page compares two strings. It is deliberately also a
 * function of the KEYWORDS, which the page never sees: adding a keyword is a
 * rules change like any other, and the old code's six-field signature could not
 * notice one.
 *
 * Not a security hash and not a cache key: equality is the only property it has
 * to have, and a collision can only ever mean one extra re-scan.
 */
export function rulesFingerprint(settings, bundle) {
  return fingerprint(
    [
      settings?.protectionEnabled ? '1' : '0',
      settings?.brainBotEnabled ? '1' : '0',
      settings?.brainBotMode ?? '',
      settings?.blockShorts ? '1' : '0',
      (bundle?.builtIn ?? []).join('|'),
      (bundle?.youtube ?? []).join('|'),
      (bundle?.channels ?? []).join('|'),
      (bundle?.channelIds ?? []).join('|'),
      (bundle?.channelNames ?? []).join('|'),
      // Provenance is part of what a page shows: moving a rule into (or out of)
      // the community list changes whether its cover offers a report, even when
      // the effective match set is otherwise identical.
      (bundle?.globalKeywords ?? []).join('|'),
      (bundle?.globalChannels ?? []).join('|'),
    ].join('~')
  );
}

/** FNV-1a, 32-bit, base 36 — short, stable, and enough to notice a change. */
function fingerprint(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
