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

import { parseChannelUrl } from '../common/channels.js';
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
 * Returns a TARGET — a URL, a name, an id — and never a derived identity. That
 * separation is the point: a display name must never be turned into a handle
 * (`channelIdentity` would, through its name fallback), because `"Some Channel"
 * → @somechannel` is a value the user never chose that matches nothing. What a
 * name CAN do is be stored as a name and matched as a name, and that decision
 * belongs to `channelRecord`, not here.
 *
 * Pure in everything except the `askPage` callback, so the URL path is testable
 * without a browser.
 *
 * @param {{linkUrl?: string, pageUrl?: string}} info   Chrome's click info
 * @param {{id?: number}} tab         the tab that was right-clicked
 * @param {(tabId: number|undefined) => Promise<{url?: string|null, name?: string|null}|null>} askPage
 * @returns {Promise<{target: {url: string|null, name: string|null, channelId: null}|null, reason: string}>}
 *        `reason` is `channel-link`, `page` (the card named a channel), `page-name`
 *        (the card printed a name and nothing else), `page-url` (the page is a
 *        channel's), or one of the refusals.
 */
export async function resolveContextTarget(info, tab, askPage) {
  const linkUrl = typeof info?.linkUrl === 'string' ? info.linkUrl.trim() : '';

  if (linkUrl !== '') {
    // A channel link names the channel outright; nothing else is needed.
    if (parseChannelUrl(linkUrl)) {
      return { target: { url: linkUrl, name: null, channelId: null }, reason: 'channel-link' };
    }

    let host = '';
    try {
      host = new URL(linkUrl).hostname;
    } catch {
      host = '';
    }
    // A link somewhere else on the page — a description, a comment, an ad.
    if (!isYouTubeHost(host)) return { target: null, reason: 'not-a-youtube-link' };
  }

  // A thumbnail links to a VIDEO, and a video's URL names no channel — so the
  // page is asked, and it answers with whatever its card actually has: a link on
  // the classic card, only a name on the current grid's.
  const fromPage = await askPage(tab?.id);
  const cardUrl = typeof fromPage?.url === 'string' ? fromPage.url.trim() : '';
  const cardName = typeof fromPage?.name === 'string' ? fromPage.name.trim() : '';

  // Order matters, and this is the order:
  //
  //   1. the channel link the CARD carries — exact, and about the card clicked;
  //   2. the PAGE's own URL when the page is a channel's — exact, and a definite
  //      answer to "whose video is this";
  //   3. the channel NAME the card prints — the weakest signal, because two
  //      channels can print the same name.
  //
  // The page URL is ahead of the name on purpose. On a channel's own grid the
  // first row a card prints is its VIEWS, not a channel, and a name read from
  // there would be stored as a block matching nothing ("772K").
  if (cardUrl !== '') {
    return { target: { url: cardUrl, name: cardName === '' ? null : cardName, channelId: null }, reason: 'page' };
  }

  const pageUrl = typeof info?.pageUrl === 'string' ? info.pageUrl.trim() : '';
  if (pageUrl !== '' && parseChannelUrl(pageUrl)) {
    return { target: { url: pageUrl, name: null, channelId: null }, reason: 'page-url' };
  }

  if (cardName !== '') {
    return { target: { url: null, name: cardName, channelId: null }, reason: 'page-name' };
  }

  return { target: null, reason: linkUrl === '' ? 'no-target' : 'video-without-channel' };
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
      // The likeliest cause is a tab still running the previous version of the
      // content script, so the first thing to try is named here rather than
      // leaving the user with a menu entry that appears broken.
      return 'ClearView could not read this video’s channel. Reload the YouTube tab if ClearView was just updated — otherwise open the video and use the ⋮ menu.';
    default:
      return 'ClearView could not tell which channel that was. Right-click a thumbnail or open the video and use the ⋮ menu.';
  }
}
