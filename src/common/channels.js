/**
 * Channel identity.
 *
 * YouTube names the same channel three ways, and which one a page hands over
 * depends on where the user was standing when they blocked it:
 *
 *   * `/@handle`          — the modern handle
 *   * `/channel/UC…`      — the opaque, permanent channel id
 *   * `/c/Name`, `/user/Name` — the legacy custom URLs
 *
 * A video's own URL carries none of them, which is why the video page's channel
 * has to be read from the page rather than from the address bar.
 *
 * All three are parsed here into one small identity, and the block list is
 * matched against every field of it rather than against one — so a channel
 * blocked from the three-dot menu still matches when it turns up in a feed, and
 * vice versa.
 *
 * The HANDLE is the stored identity, as in the Android app. A handle survives a
 * rename of the channel's display NAME, which is the thing the user actually
 * sees; a block stored by display name would be silently lost the moment the
 * channel renamed itself. The channel ID is kept alongside it when the page
 * offered one, because a handle can be changed and an id cannot.
 *
 * Pure: no Chrome APIs, no DOM. The whole point is that the block list can be
 * matched the same way from the worker, the content script and the tests.
 */

import { isYouTubeHost } from './search-engines.js';

/** A handle body: YouTube's own alphabet, and one leading "@". */
const HANDLE_BODY = /^[a-z0-9._-]{2,100}$/;

/** A channel id: "UC" and 20–24 more characters of YouTube's alphabet. */
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{16,24}$/;

/** Where a block came from. Display only — never used for matching. */
export const BLOCK_SOURCES = Object.freeze({
  'youtube-menu': 'YouTube menu',
  'context-menu': 'Right-click menu',
  manual: 'Added by hand',
});

/**
 * Normalize a channel handle: one leading "@", lower-cased, or null.
 *
 * Mirrors the backend's own normalization, so the extension and the server
 * agree on what a given input means.
 */
export function normalizeHandle(input) {
  const withoutAt = String(input ?? '').trim().replace(/^@+/, '').trim();
  if (withoutAt === '') return null;
  const body = withoutAt.toLowerCase();
  if (!HANDLE_BODY.test(body)) return null;
  return `@${body}`;
}

/**
 * Normalize a channel id, or null.
 *
 * Case is preserved: a channel id is not a slug, and folding it would produce a
 * value that matches nothing.
 */
export function normalizeChannelId(input) {
  const value = String(input ?? '').trim();
  return CHANNEL_ID.test(value) ? value : null;
}

/**
 * A URL from an absolute href OR a relative one.
 *
 * YouTube puts a RELATIVE href in a card's channel link (`/@handle`, not the
 * absolute form), and `new URL('/@handle')` throws — so a relative value is
 * resolved against YouTube rather than rejected. A bare `@handle` works too,
 * because that is what a user types.
 */
function toUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  try {
    return new URL(raw);
  } catch {
    try {
      return new URL(raw, 'https://www.youtube.com');
    } catch {
      return null;
    }
  }
}

/** A handle derived from a DISPLAY name — the only identity a feed card gives. */
export function identityFromName(name) {
  // A display name is not a handle: "Some Channel • Music" has no handle form,
  // and inventing one ("@somechannelmusic") would match a DIFFERENT channel. The
  // punctuation is stripped rather than kept, because that much is a display
  // convention, and a name that ends up empty simply yields null.
  const collapsed = String(name ?? '')
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '');
  const handle = normalizeHandle(collapsed);
  return handle ? { handle, channelId: null, name: String(name).trim() } : null;
}

/**
 * The identity a channel URL carries, or null when it is not a channel page.
 *
 * A `/shorts`, `/watch` or `/results` URL is deliberately NOT a channel page —
 * those are video and search surfaces, and treating one as a channel would block
 * a whole page because of what happened to be on it.
 */
export function parseChannelUrl(url) {
  const parsed = toUrl(url);
  if (!parsed) return null;
  if (!isYouTubeHost(parsed.hostname)) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (!first) return null;

  if (first.startsWith('@')) {
    const handle = normalizeHandle(first);
    return handle ? { handle, channelId: null } : null;
  }

  if (first === 'channel' && segments[1]) {
    const channelId = normalizeChannelId(segments[1]);
    return channelId ? { handle: null, channelId } : null;
  }

  // The legacy custom URLs. A /c/ or /user/ slug is the handle with different
  // punctuation, which is exactly what the app assumes when it stores a handle.
  if ((first === 'c' || first === 'user') && segments[1]) {
    let slug;
    try {
      slug = decodeURIComponent(segments[1]);
    } catch {
      return null;
    }
    const handle = normalizeHandle(slug);
    return handle ? { handle, channelId: null } : null;
  }

  return null;
}

/** True when a URL is a channel page. */
export function isChannelPageUrl(url) {
  return parseChannelUrl(url) !== null;
}

/**
 * The video id a URL carries, or null.
 *
 * Used by the right-click handler, which is handed the link under the cursor and
 * has to decide whether the user right-clicked a thumbnail or something else.
 */
export function parseVideoUrl(url) {
  const parsed = toUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
    const id = parsed.pathname.split('/').filter(Boolean)[0];
    return id ? { videoId: id } : null;
  }
  if (!isYouTubeHost(host)) return null;

  if (parsed.pathname === '/watch') {
    const id = parsed.searchParams.get('v');
    return id ? { videoId: id } : null;
  }
  const match = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(parsed.pathname);
  return match ? { videoId: match[2] } : null;
}

/**
 * One identity from whatever a card or page can offer.
 *
 * A URL wins over a name, always: the URL is YouTube's own claim about which
 * channel this is, and the name is what it chose to print — which two different
 * channels may print identically.
 */
export function channelIdentity({ url = null, name = null, channelId = null } = {}) {
  const fromUrl = parseChannelUrl(url);
  if (fromUrl) {
    return { handle: fromUrl.handle, channelId: fromUrl.channelId ?? normalizeChannelId(channelId), name: name ?? null };
  }
  const id = normalizeChannelId(channelId);
  if (id) return { handle: null, channelId: id, name: name ?? null };
  return identityFromName(name);
}

/**
 * A stored block list, cleaned.
 *
 * Drops anything unusable and collapses duplicates — the same channel reached by
 * its handle once and its id once is ONE block, and a duplicate would show twice
 * in the UI and be submitted twice.
 */
export function normalizeBlockedChannels(list) {
  const out = [];
  const handles = new Set();
  const ids = new Set();

  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const handle = normalizeHandle(raw.handle ?? '');
    const channelId = normalizeChannelId(raw.channelId ?? '');
    if (!handle && !channelId) continue;
    if ((handle && handles.has(handle)) || (channelId && ids.has(channelId))) continue;
    if (handle) handles.add(handle);
    if (channelId) ids.add(channelId);

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    out.push({
      handle: handle ?? null,
      channelId: channelId ?? null,
      name: name === '' ? null : name.slice(0, 100),
      addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : null,
      source: Object.prototype.hasOwnProperty.call(BLOCK_SOURCES, raw.source) ? raw.source : 'manual',
    });
  }
  return out;
}

/** A block record, from whatever the entry point could see. */
export function channelRecord({ handle = null, channelId = null, name = null, source = 'manual', addedAt = null } = {}) {
  const normalizedHandle = normalizeHandle(handle ?? '');
  const normalizedId = normalizeChannelId(channelId ?? '');
  if (!normalizedHandle && !normalizedId) return null;
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return {
    handle: normalizedHandle,
    channelId: normalizedId,
    name: trimmed === '' ? null : trimmed.slice(0, 100),
    addedAt: Number.isFinite(addedAt) ? addedAt : Date.now(),
    source: Object.prototype.hasOwnProperty.call(BLOCK_SOURCES, source) ? source : 'manual',
  };
}

/** The value a block is shown and submitted by: its handle, else its id. */
export function channelLabel(record) {
  return record?.handle ?? record?.channelId ?? null;
}

/**
 * Add a record to a list, or return the list unchanged when it is already there.
 *
 * Matching is by handle OR id, so blocking a channel by its id when it was
 * already blocked by its handle does not add a second entry — which is the same
 * reason [normalizeBlockedChannels] collapses duplicates.
 */
export function addBlockedChannel(list, record) {
  const current = normalizeBlockedChannels(list);
  if (!record) return current;
  const clash = current.some(
    (existing) =>
      (record.handle && existing.handle === record.handle) ||
      (record.channelId && existing.channelId === record.channelId)
  );
  return clash ? current : [...current, record];
}

/** Remove the block(s) matching a label (a handle or a channel id). */
export function removeBlockedChannel(list, label) {
  const handle = normalizeHandle(label ?? '');
  const channelId = normalizeChannelId(label ?? '');
  return normalizeBlockedChannels(list).filter((entry) => {
    if (handle && entry.handle === handle) return false;
    if (channelId && entry.channelId === channelId) return false;
    return true;
  });
}

/**
 * Does this identity match the block list?
 *
 * @param {{channels?: Iterable<string>, channelIds?: Iterable<string>}} blocked
 *        the effective block list — handles and ids, as the rule bundle holds them
 * @param {object|null} identity  from [channelIdentity]
 * @returns {string|null} the label that matched, for display
 */
export function matchBlockedChannel(blocked, identity) {
  if (!identity) return null;
  const has = (set, value) => Boolean(value) && Boolean(set) && (set.has ? set.has(value) : Array.from(set).includes(value));

  const handle = normalizeHandle(identity.handle ?? '');
  if (has(blocked?.channels, handle)) return handle;

  const id = normalizeChannelId(identity.channelId ?? '');
  if (has(blocked?.channelIds, id)) return id;

  // Last resort: a bare display name, which is all some surfaces give. It is
  // checked last because it is the weakest signal — a name can be printed
  // identically by two channels.
  const fromName = identityFromName(identity.name ?? '');
  if (fromName && has(blocked?.channels, fromName.handle)) return fromName.handle;

  return null;
}
