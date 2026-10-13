/**
 * The right-click "Block this channel" entry.
 *
 * Chrome hands a click handler the LINK under the cursor, not the element — so
 * the work here is turning "what was right-clicked" into a channel, and there
 * are two honest ways to do it:
 *
 *  1. **The URL says so.** Right-clicking a channel link (`/@handle`,
 *     `/channel/UC…`) names the channel outright, and nothing else is needed.
 *  2. **The page says so.** A THUMBNAIL links to a VIDEO, and a video's URL
 *     carries no channel at all. There is no way to read the channel out of
 *     `watch?v=…`, so the content script records the card the user right-clicked
 *     (it sees the `contextmenu` event on the page) and this asks it. Nothing is
 *     guessed from the URL.
 *
 * What it deliberately does NOT do is fall back to "whatever channel this page
 * is showing". Right-clicking a link in a video description and blocking the
 * video's channel would be a block the user never asked for, so a link that is
 * not on YouTube is refused outright.
 *
 * The identity itself is built by `channelIdentity` in the worker, not here, so
 * there is one definition of what a channel is.
 */

import { channelIdentity, parseChannelUrl } from '../common/channels.js';
import { isYouTubeHost } from '../common/search-engines.js';

export const CONTEXT_MENU_ID = 'clearview-block-channel';

/** The message the content script answers with the card under the cursor. */
export const CONTEXT_TARGET_MESSAGE = 'channel/contextTarget';

/**
 * Install the menu entry.
 *
 * Idempotent: this runs on install AND on every worker start (MV3 stops the
 * worker freely), and creating an id that already exists is an error, so the
 * previous entries are cleared first.
 */
export function installContextMenus() {
  if (!chrome.contextMenus?.create) return;
  chrome.contextMenus.removeAll(() => {
    // Read the error rather than ignore it: `removeAll` reports "no menus" on a
    // first install through the same channel a real failure would.
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: 'Block this channel (ClearView)',
        // "link" covers a thumbnail (an <a> wrapping the image); "image" and
        // "video" cover right-clicking the thumbnail artwork or the player
        // itself, which is a context Chrome reports separately.
        contexts: ['link', 'video', 'image'],
        // Only on YouTube. The menu has nothing to say anywhere else.
        documentUrlPatterns: ['*://*.youtube.com/*'],
      },
      () => void chrome.runtime.lastError
    );
  });
}

/**
 * Resolve the channel a context-menu click was aimed at.
 *
 * Pure in everything except the `askPage` callback, so the URL path is testable
 * without a browser.
 *
 * @param {{linkUrl?: string, pageUrl?: string}} info   Chrome's click info
 * @param {{id?: number}} tab         the tab that was right-clicked
 * @param {(tabId: number|undefined) => Promise<{url?: string|null, name?: string|null}|null>} askPage
 * @returns {Promise<{identity: {handle: string|null, channelId: string|null, name: string|null}|null, reason: string}>}
 */
export async function resolveContextTarget(info, tab, askPage) {
  const linkUrl = typeof info?.linkUrl === 'string' ? info.linkUrl.trim() : '';

  if (linkUrl !== '') {
    const fromLink = parseChannelUrl(linkUrl);
    if (fromLink) return { identity: { ...fromLink, name: null }, reason: 'channel-link' };

    let host = '';
    try {
      host = new URL(linkUrl).hostname;
    } catch {
      host = '';
    }
    // A link somewhere else on the page — a description, a comment, an ad.
    if (!isYouTubeHost(host)) return { identity: null, reason: 'not-a-youtube-link' };
  }

  const fromPage = await askPage(tab?.id);
  const identity = channelIdentity({ url: fromPage?.url ?? null, name: fromPage?.name ?? null });
  if (identity) return { identity, reason: 'page' };

  // A last resort that needs no help from the page: if the page we are on IS a
  // channel's page, then every video on it belongs to that channel, and the
  // address bar already names it. This covers the case the content script cannot
  // answer at all — a tab still running a content script from before the
  // extension was reloaded — which would otherwise look like "Block did nothing".
  const fromPageUrl = parseChannelUrl(typeof info?.pageUrl === 'string' ? info.pageUrl : '');
  if (fromPageUrl) return { identity: { ...fromPageUrl, name: null }, reason: 'page-url' };

  return { identity: null, reason: linkUrl === '' ? 'no-target' : 'video-without-channel' };
}

/**
 * The reason a click could not be resolved, in words.
 *
 * Each one is a different situation the user can act on, which is why they are
 * not collapsed into a single "something went wrong".
 */
export function unresolvableMessage(reason) {
  switch (reason) {
    case 'not-a-youtube-link':
      return 'That link is not a YouTube channel. Right-click a video thumbnail or a channel name to block a channel.';
    case 'video-without-channel':
      return 'ClearView could not read the channel for that video. Open the video and use the ⋮ menu instead.';
    default:
      return 'ClearView could not tell which channel that was. Right-click a thumbnail or open the video and use the ⋮ menu.';
  }
}
