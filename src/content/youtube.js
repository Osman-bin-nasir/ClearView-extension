/**
 * YouTube content script.
 *
 * Its jobs, and the split between them, is deliberate:
 *
 *  - **Hide the Shorts entry points AND the Shorts content.** This script only
 *    HIDES: it toggles a class on <html> and hides the matching guide/chip
 *    entries along with the feed shelf, its section, the individual Short cards
 *    and the channel page's Shorts tab, and it intercepts no navigation.
 *    Blocking a Shorts URL outright is the background worker's job (the
 *    `blockShorts` check in evaluateUrl), which keeps the two concerns — what
 *    the page shows, and what may be loaded — separate.
 *  - **Brain Bot feed protection.** Matching feed cards are either removed or
 *    covered in place, according to the user's chosen mode.
 *  - **Blocking a channel, from where the user actually is.** A "Block this
 *    channel" entry is added to the video's own ⋮ menu, and the script records
 *    which card was last right-clicked so the worker's context-menu item can act
 *    on it.
 *  - **A video page whose channel is blocked.** A video URL names no channel, so
 *    this script reads it off the page and asks the worker; the worker does the
 *    redirecting, because a page cannot navigate itself to a
 *    `chrome-extension://` URL.
 *
 * It holds no rules and does no matching: it reads what is on screen (titles and
 * channel links) and asks the service worker to decide. That keeps one matcher
 * in the codebase, and keeps a page from ever holding the rule set.
 *
 * YouTube is a single-page app, so "the page loaded" is not an event that happens
 * once. Changes are re-applied on in-app navigation and on DOM mutations, and
 * every element is marked once it has been handled so an overlay can never be
 * stacked twice.
 */

(() => {
  const OVERLAY_CLASS = 'cv-block-overlay';
  const HIDE_CLASS = 'cv-hide-shorts';
  const HIDE_ADS_CLASS = 'cv-block-ads';
  const MENU_ITEM_CLASS = 'cv-menu-item';
  const TOAST_CLASS = 'cv-toast';

  /**
   * The ad containers YouTube renders around the video and in the feed.
   *
   * A list of shapes, not one selector: YouTube serves several ad formats
   * (display, in-feed, promoted video, masthead, banner) and each has its own
   * element, and it renames them often — so the stylesheet hides these by class
   * on <html> (instant, and independent of this script's timing) while this list
   * drives the JS pass that REMOVES the in-feed ones (a hidden grid item leaves
   * a gap; a removed one does not).
   */
  const AD_ELEMENT_SELECTOR = [
    '#masthead-ad',
    '#player-ads',
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-sparkles-text-search-renderer',
    'ytd-promoted-video-renderer',
    'ytd-compact-promoted-video-renderer',
    'ytd-display-ad-renderer',
    'ytd-banner-promo-renderer',
    'ytd-statement-banner-renderer',
    'ytd-video-masthead-ad-v3-renderer',
    'ytd-primetime-promo-renderer',
  ].join(',');

  /** The in-feed ads own a grid cell; its WRAPPER has to go with it. */
  const AD_GRID_WRAPPER_SELECTOR =
    'ytd-rich-item-renderer, ytd-compact-promoted-video-renderer, ytd-rich-section-renderer';

  /** YouTube's own controls for an ad that is playing, in landing order. */
  const AD_SKIP_SELECTOR = [
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-slot button',
  ].join(',');

  /** The "close" control on a banner/overlay ad drawn over the video. */
  const AD_OVERLAY_CLOSE_SELECTOR = [
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-overlay-close-container',
    '#dismiss-button',
  ].join(',');

  /**
   * Card containers YouTube uses across home, search, subscriptions, related.
   *
   * `ytd-channel-renderer` is the CHANNEL result in a search — the one with the
   * big round avatar and a Subscribe button. It carries a channel link like any
   * other card, so leaving it out meant searching a blocked channel's name still
   * showed its avatar and its subscribe button.
   */
  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-rich-grid-media',
    'ytd-channel-renderer',
  ].join(',');

  /**
   * A card that is a LOCKUP with none of the renderers above around it.
   *
   * Live-verified on the channel home tab, and the home feed serves it too: the
   * modern grid renders `yt-lockup-view-model` at the top level, inside a
   * `grid-shelf-view-model` or a horizontal list, with NO
   * `ytd-rich-item-renderer` wrapper. Recognising only the renderers meant two
   * things were wrong on exactly those cards, and both were reported as "it does
   * nothing": there was no card for the ⋮ click to record, so the menu got no
   * ClearView entry at all, and no card for `scan()` to evaluate, so a channel
   * blocked elsewhere kept showing. One selector, two symptoms.
   */
  const LOCKUP_CARD_SELECTOR = 'yt-lockup-view-model';

  /**
   * How long after the ⋮ trigger was clicked we will still look for its menu.
   *
   * The dropdown is rendered on demand, and the observer that notices it fires on
   * a debounce — so the window has to outlast the debounce, and must not outlast
   * it by so much that a menu opened later is mistaken for this one.
   */
  const MENU_WINDOW_MS = 3000;

  /**
   * The ⋮ button every CARD carries.
   *
   * Read off a live card: the current grid renders it as
   * `button[aria-label="More actions"]` inside the lockup's metadata, and the
   * classic card as a `yt-icon-button` in its `ytd-menu-renderer`. Matched by
   * SHAPE, because this is only ever consulted in the second after a click.
   */
  const CARD_MENU_TRIGGER_SELECTOR =
    'button[aria-label="More actions"], yt-icon-button[aria-label="Action menu"], ytd-menu-renderer button, ytd-menu-renderer .dropdown-trigger';

  /**
   * The list inside the CURRENT card menu.
   *
   * Live-verified: a card's ⋮ opens a contextual sheet rendered into the
   * document-level popup container — `ytd-popup-container > tp-yt-iron-dropdown >
   * yt-sheet-view-model > yt-contextual-sheet-layout > yt-list-view-model[role=
   * "menu"]`, whose rows are `yt-list-item-view-model` with a
   * `button[role="menuitem"]` inside. A different container from the watch
   * page's `ytd-menu-popup-renderer` list, which is why both are matched.
   */
  const CARD_SHEET_SELECTOR = 'yt-list-view-model[role="menu"]';

  let config = {
    enabled: false,
    brainBotEnabled: false,
    brainBotMode: 'overlay',
    blockShorts: false,
    blockYoutubeAds: false,
    blockedChannelCount: 0,
    /** The worker's fingerprint of the rules these decisions were made under. */
    revision: '',
    hasRules: false,
  };

  /**
   * Every card this script has already decided about.
   *
   * A WeakMap, so a card YouTube has recycled off-screen can be collected, and a
   * re-created card (a fresh element) is naturally re-evaluated.
   * value = { mode: 'remove'|'overlay'|'clean', overlay?: HTMLElement, previousDisplay?: string }
   */
  const handled = new WeakMap();

  let scanTimer = null;
  let menuOpenedAt = 0;
  /**
   * The card whose ⋮ was clicked, or null when the video page's menu was.
   *
   * The sheet renders in a document-level popup container, nowhere near the card
   * that opened it, so the click is the only thing that can say which channel the
   * entry belongs to.
   */
  let menuCard = null;
  /** The last page whose channel was sent to the worker, so it is sent once. */
  let lastCheckedPageUrl = null;

  // ── Messaging ──────────────────────────────────────────────────────────

  async function send(type, payload) {
    try {
      return await chrome.runtime.sendMessage({ type, ...payload });
    } catch {
      // The extension was reloaded or removed; the script is now orphaned.
      return null;
    }
  }

  /** The message text a refused call carries, for a toast. */
  function errorText(response, fallback) {
    return response?.error?.message ?? fallback;
  }

  async function loadConfig() {
    const response = await send('rules/forContent');
    if (response?.ok) {
      config = { ...config, ...response.data, hasRules: true };
      return true;
    }
    // Best-effort: stay with the previous config rather than turning everything
    // off because one message failed.
    return false;
  }

  // ── Shorts: entry points, the shelf, and the Shorts cards ──────────────

  /**
   * Every element that can BE, or WRAP, a Shorts surface.
   *
   * One flat list on purpose. The entry points (the sidebar item, the
   * mini-guide item, the chip) and the surfaces the content itself appears on
   * (the feed shelf, the section that spaces it, an individual Short card) are
   * not disjoint — a section wraps a shelf, a shelf holds lockups — so two
   * lists would have to agree about the overlaps, and the overlaps are the part
   * most likely to drift apart. What each candidate MEANS is decided by
   * `shortsTarget`, in one place.
   */
  const SHORTS_CANDIDATE_SELECTOR = [
    // Entry points.
    'ytd-guide-entry-renderer',
    'ytd-mini-guide-entry-renderer',
    'yt-chip-cloud-chip-renderer',
    // The Shorts shelf, the section that spaces it, and the reel shelf.
    'ytd-reel-shelf-renderer',
    'ytd-rich-shelf-renderer',
    'ytd-rich-section-renderer',
    // One Short, in the grid or as an ordinary list row or search result.
    'ytd-rich-item-renderer',
    'grid-shelf-view-model',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    // The Shorts tab on a channel page.
    'yt-tab-shape',
  ].join(',');

  /** The lockup element YouTube renders a single Short with. */
  const SHORTS_LOCKUP_SELECTOR = 'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2';

  /** The badge YouTube puts on a thumbnail when the video behind it is a Short. */
  const SHORTS_BADGE_SELECTOR = 'ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"]';

  /** Shorts surfaces this script has hidden, with the display value to restore. */
  const hiddenShorts = new Map();

  /**
   * Is this one of the Shorts entry points?
   *
   * A link to /shorts is the shape test and comes first, because YouTube
   * reshuffles these elements' attributes far more often than it changes where
   * a Shorts link POINTS. The label is checked both on the element and on a
   * descendant, because YouTube puts `title="Shorts"` on the inner anchor while
   * the element that has to be hidden is the renderer around it.
   */
  function isShortsEntry(element) {
    if (element.hasAttribute('is-shorts')) return true;
    if (element.querySelector('a[href^="/shorts"]')) return true;
    const label = `${element.getAttribute('title') ?? ''} ${element.getAttribute('aria-label') ?? ''}`
      .trim()
      .toLowerCase();
    if (label === 'shorts') return true;
    if (element.querySelector('[title="Shorts"], [aria-label="Shorts"]')) return true;
    // Last, and only last: the chip's markup names itself in no attribute at
    // all, so its TEXT is the only thing left to read. A whole element whose
    // entire text is "Shorts" is the Shorts entry — no other guide item, chip
    // or menu can say that.
    return element.textContent.trim().toLowerCase() === 'shorts';
  }

  /**
   * The section that spaces a shelf, when there is one.
   *
   * Hiding only the shelf leaves the row the grid reserved for it behind as a
   * gap, so the wrapper is what goes when YouTube has given us one.
   */
  function shelfContainer(shelf) {
    const parent = shelf.parentElement;
    return parent && parent.localName === 'ytd-rich-section-renderer' ? parent : shelf;
  }

  /**
   * What to hide for one candidate — the element itself, or its wrapper.
   *
   * Deliberately returns an ELEMENT rather than a boolean: the caller hides
   * exactly what it is given, and hiding a shelf's own section is the whole
   * reason the wrapper is resolved here instead of at the call site.
   */
  function shortsTarget(element) {
    const tag = element.localName;

    if (tag === 'ytd-reel-shelf-renderer') return shelfContainer(element);

    if (tag === 'ytd-rich-shelf-renderer') {
      const isShorts = element.hasAttribute('is-shorts') || Boolean(element.querySelector(SHORTS_LOCKUP_SELECTOR));
      return isShorts ? shelfContainer(element) : null;
    }

    if (tag === 'ytd-rich-section-renderer') {
      // A section that exists only to hold a Shorts shelf.
      const holds = element.querySelector(
        `ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer, ${SHORTS_LOCKUP_SELECTOR}`
      );
      return holds ? element : null;
    }

    if (tag === 'yt-tab-shape') {
      const title = (element.getAttribute('tab-title') ?? '').trim().toLowerCase();
      if (title === 'shorts') return element;
      return element.querySelector('a[href$="/shorts"]') ? element : null;
    }

    if (
      tag === 'ytd-rich-item-renderer' ||
      tag === 'grid-shelf-view-model' ||
      tag === 'ytd-video-renderer' ||
      tag === 'ytd-grid-video-renderer' ||
      tag === 'ytd-compact-video-renderer'
    ) {
      const holds = element.querySelector(`${SHORTS_LOCKUP_SELECTOR}, ${SHORTS_BADGE_SELECTOR}`);
      return holds ? element : null;
    }

    // Everything left in the candidate list is an entry point.
    return isShortsEntry(element) ? element : null;
  }

  function restoreShortsEntries() {
    for (const [element, previousDisplay] of hiddenShorts) {
      element.style.display = previousDisplay;
    }
    hiddenShorts.clear();
  }

  /**
   * Hide (or restore) the Shorts entry points AND the Shorts content itself.
   *
   * Runs on every mutation as well as on navigation, so a surface rendered
   * later — the feed loads after the shell, and YouTube re-renders the guide —
   * is still caught. Hiding never touches a /shorts URL: reaching a Short
   * directly still works unless the Shorts control is on, in which case the URL
   * block is the background worker's.
   *
   * The stylesheet does the same job through `:has()` and is what removes an
   * element the moment it is inserted; this pass is the safety net for the
   * shapes `:has()` cannot express and for Chrome versions without it.
   */
  function applyShorts() {
    const hide = Boolean(config.enabled && config.blockShorts);
    document.documentElement.classList.toggle(HIDE_CLASS, hide);

    if (!hide) {
      restoreShortsEntries();
      return;
    }

    for (const element of document.querySelectorAll(SHORTS_CANDIDATE_SELECTOR)) {
      const target = shortsTarget(element);
      if (!target) continue;
      const recorded = hiddenShorts.get(target);
      if (recorded !== undefined && target.style.display === 'none') continue;
      // Recorded once, and re-applied rather than skipped while the map still
      // knows the element: another part of this script (a Brain Bot reset, a
      // channel that was blocked and unblocked) can write that same inline
      // display, and a surface that stayed visible because we believed it was
      // already hidden would be the toggle quietly not working.
      if (recorded === undefined) hiddenShorts.set(target, target.style.display);
      target.style.display = 'none';
    }
    // Drop entries YouTube has since removed, so the map cannot grow unbounded
    // during a long session of guide re-renders.
    for (const element of [...hiddenShorts.keys()]) {
      if (!element.isConnected) hiddenShorts.delete(element);
    }
  }

  // ── YouTube ads ────────────────────────────────────────────────────────

  /**
   * Ad containers this script has removed, with where to put them back.
   *
   * Held so the toggle is REVERSIBLE: turning ad blocking off restores what was
   * taken out rather than leaving the page with holes until the next reload.
   */
  const removedAds = new Map();

  /** True when ad blocking is on: needs Protection AND the ad switch. */
  function adsOn() {
    return Boolean(config.enabled && config.blockYoutubeAds);
  }

  /**
   * Strip the ad slots out of the page.
   *
   * The wrapper is removed, not just the ad inside it: an in-feed ad occupies a
   * grid cell of its own, and hiding only its inner element leaves an empty tile
   * in the feed. `display: none` from the stylesheet still covers the formats
   * that have no wrapper and the instant before this pass runs.
   */
  function removeAdElements() {
    for (const element of document.querySelectorAll(AD_ELEMENT_SELECTOR)) {
      const target = element.closest(AD_GRID_WRAPPER_SELECTOR) ?? element;
      if (removedAds.has(target)) continue;
      // A grid wrapper is only removed when the ad is what it exists for, so an
      // ordinary video that happens to contain an ad node is never taken out.
      if (target !== element && !target.querySelector(AD_ELEMENT_SELECTOR)) continue;
      removedAds.set(target, { parent: target.parentNode, next: target.nextSibling });
      target.remove();
    }
  }

  function restoreAdElements() {
    for (const [node, spot] of removedAds) {
      if (node.isConnected || !spot.parent) continue;
      spot.parent.insertBefore(node, spot.next);
    }
    removedAds.clear();
  }

  /**
   * Deal with an ad that is PLAYING in the player.
   *
   * The network rules stop most ads before they load, but YouTube still serves
   * one from its own origin sometimes. Three moves, in order:
   *
   *  1. click YouTube's own skip control the moment it exists — the honest skip;
   *  2. dismiss an overlay/banner ad drawn over the video;
   *  3. for an ad the user cannot dismiss, fast-forward it to its end (and mute
   *     it while it runs), which is what every ad blocker has to do for an
   *     unskippable pre-roll.
   *
   * The mute is remembered and undone the moment the ad ends, so it can never
   * carry over and silence the video the user came to watch.
   */
  function handleVideoAds() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    if (!player) return;
    const video = player.querySelector('video');
    const adPlaying = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');

    if (!adPlaying) {
      // The ad is over: undo only the mute WE applied.
      if (video?.dataset.cvAdMuted === '1') video.muted = false;
      if (video) delete video.dataset.cvAdMuted;
      return;
    }

    if (video && video.dataset.cvAdMuted === undefined) {
      video.dataset.cvAdMuted = video.muted ? '0' : '1';
      video.muted = true;
    }

    const overlayClose = player.querySelector(AD_OVERLAY_CLOSE_SELECTOR);
    if (overlayClose && isVisible(overlayClose)) overlayClose.click();

    const skip = player.querySelector(AD_SKIP_SELECTOR);
    if (skip && isVisible(skip)) {
      skip.click();
      return;
    }

    // Unskippable: run it out instead of playing it.
    if (video && Number.isFinite(video.duration) && video.duration > 0.1 && video.currentTime < video.duration - 0.1) {
      try {
        video.currentTime = video.duration;
      } catch {
        /* a live stream's duration is Infinity; nothing to skip */
      }
    }
  }

  /**
   * Undo the mute the unskippable path applied, if we applied one.
   *
   * A separate path from `handleVideoAds` because it has to run when ad blocking
   * is switched OFF mid-ad: at that point no ad should be skipped, but the video
   * must not stay silent either.
   */
  function releaseAdMute() {
    const video = document.querySelector('#movie_player video, .html5-video-player video');
    if (!video) return;
    if (video.dataset.cvAdMuted === '1') video.muted = false;
    delete video.dataset.cvAdMuted;
  }

  /**
   * Apply (or undo) ad blocking.
   *
   * Runs on every debounced mutation pass as well as on navigation, because the
   * feed and the player both render ads after the page settles — a one-shot pass
   * at load would miss most of them.
   */
  function applyAds() {
    const on = adsOn();
    document.documentElement.classList.toggle(HIDE_ADS_CLASS, on);
    if (!on) {
      restoreAdElements();
      releaseAdMute();
      return;
    }
    removeAdElements();
    handleVideoAds();
  }

  // ── Reading a card ─────────────────────────────────────────────────────

  /**
   * A link to a channel, wherever it lives.
   *
   * Matched by the SHAPE of its href (`/@handle`, `/channel/UC…`, `/c/`, `/user/`)
   * rather than by the elements wrapped around it. That is the same reasoning as
   * the Shorts fix: YouTube rearranges card markup far more often than it changes
   * what a channel link points at, and a path-based lookup silently returns
   * nothing when it does — which reads to the user as "Block did nothing".
   */
  const CHANNEL_LINK_SELECTOR =
    'a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"], a[href*="youtube.com/@"], a[href*="youtube.com/channel/"]';

  /**
   * The card's title, from whichever card markup YouTube is serving.
   *
   * TWO shapes are live at once, and only one of them has an `#video-title`.
   * The classic renderer does; the current grid (`ytd-rich-item-renderer` →
   * `yt-lockup-view-model`) does not — its title is an anchor inside an `<h3>`
   * that carries the text as an attribute. Reading only `#video-title` meant a
   * title keyword filter had nothing to match on the modern feed and looked
   * like it was switched off.
   */
  function readCardTitle(element) {
    const named = element.querySelector('#video-title, a#video-title, #video-title-link');
    const namedText = (named?.textContent ?? '').trim() || (named?.getAttribute('title') ?? '').trim();
    if (namedText !== '') return namedText;

    const lockup = element.querySelector(
      'a.ytLockupMetadataViewModelTitle, h3.ytLockupMetadataViewModelHeadingReset'
    );
    const lockupText =
      (lockup?.textContent ?? '').trim() ||
      (lockup?.getAttribute('title') ?? '').trim() ||
      (lockup?.getAttribute('aria-label') ?? '').trim();
    if (lockupText !== '') return lockupText;

    // A CHANNEL result has no video title; its name is its title, and the card
    // is judged by the channel link it carries.
    const channelTitle = element.querySelector('#channel-title');
    const channelTitleText = (channelTitle?.textContent ?? '').trim();
    if (channelTitleText !== '') return channelTitleText;

    // Last resort: any heading carrying its text as an attribute, so a further
    // rename of the lockup still yields a title rather than nothing.
    const heading = element.querySelector('h3[title], h3[aria-label]');
    return (
      (heading?.textContent ?? '').trim() ||
      (heading?.getAttribute('title') ?? '').trim() ||
      (heading?.getAttribute('aria-label') ?? '').trim()
    );
  }

  /**
   * A row that states a NUMBER, not a name.
   *
   * Read off live cards: `777K`, `8d ago`, `17K watching`, `1.2M views`,
   * `15.8M subscribers`. What makes this worth matching is that a view count is
   * ONE text segment like a channel name is — on a channel's own grid the ONLY
   * metadata row is `777K · 8d ago` — so without it a right-click could store a
   * block named `777K`, which matches nothing and looks like the menu doing
   * nothing. It only ever SKIPS a candidate; the fallback below re-checks it.
   */
  const METRIC_TEXT =
    /^(?:\d[\d.,]*\s*[KMB](?:\s*(?:views?|watching|subscribers?|likes?))?|\d[\d.,]*\s*(?:views?|watching|subscribers?|likes?)|(?:streamed|premiered|live)\s+\d+\s*(?:s|sec|second|m|min|minute|h|hr|hour|d|day|w|week|mo|month|y|year)s?\s*ago|\d+\s*(?:s|sec|second|m|min|minute|h|hr|hour|d|day|w|week|mo|month|y|year)s?\s*ago|\d+(?::\d+)+)$/i;

  /**
   * The channel's printed name, when the card offers no link.
   *
   * The current grid renders the channel as an attributed string carrying a
   * click COMMAND and no href, so such a card genuinely has no channel URL. The
   * first metadata row is the byline (the channel) and later rows are views and
   * age; the byline is the row with ONE text segment, which is what keeps a
   * views row from being read as a channel name.
   */
  function readMetadataChannelName(element) {
    const rows = element.querySelectorAll(
      'yt-content-metadata-view-model .ytContentMetadataViewModelMetadataRow'
    );
    for (const row of rows) {
      // An icon inside the row (YouTube's verified-artist badge) is not text, so
      // a byline of "name + badge" is still one segment. Verified against live
      // cards: `Lofi Girl` + verified icon, and — on a channel's home shelf —
      // the row under it is `17K watching`, which is one segment TOO. Hence the
      // metric check: the first one-segment row that is not a number is the
      // byline, in every card checked live.
      const segments = row.querySelectorAll('.ytAttributedStringHost');
      if (segments.length !== 1) continue;
      const text = (segments[0].textContent ?? '').trim();
      if (text !== '' && !METRIC_TEXT.test(text)) return text;
    }

    // Nothing had exactly one segment — a row can grow a second one (a
    // sponsorship label, a collab), and on a card the BYLINE is the first row
    // while views and age come after it. Reading the first segment of the first
    // row is the same value in every card checked; anywhere it is not, it is a
    // guess the caller can still refuse, and `resolveContextTarget` prefers the
    // page's own URL over it.
    const first = (rows[0]?.querySelector('.ytAttributedStringHost')?.textContent ?? '').trim();
    // …and it is still refused when the first row states a number, because a
    // block named `777K` is worse than no block: it is stored, it looks like it
    // worked, and it matches nothing.
    return METRIC_TEXT.test(first) ? '' : first;
  }

  /**
   * The printed name, from the card's own channel block or its byline row.
   *
   * A `ytd-channel-name` with no anchor inside it (a card YouTube has stripped
   * the link out of) still prints the name in its text container — read that
   * rather than the whole block, which would pull in its badge text.
   */
  function readPrintedChannelName(element) {
    const namedBlock = element.querySelector('ytd-channel-name, #channel-name, .ytd-channel-name');
    if (namedBlock) {
      const container = namedBlock.querySelector('#text-container') ?? namedBlock;
      const name = (container.textContent ?? '').trim();
      if (name !== '') return name;
    }
    return readMetadataChannelName(element);
  }

  /**
   * The channel a card is by: its link when there is one, its name when not.
   *
   * Two traps here, both of which shipped:
   *
   *  - the FIRST channel-shaped link in a card is not always the one with the
   *    name on it. A channel RESULT puts the avatar link first — an image, no
   *    text — so the name is read separately and joined to the link;
   *  - the current grid has no channel link at all, so the printed name is the
   *    only signal there is (and the only thing a block made from it can store).
   */
  function readCardChannel(element) {
    // The named spot: a link that is the channel's name, as the classic card and
    // the search results both have.
    const namedLink = element.querySelector('ytd-channel-name a, #channel-name a, .ytd-channel-name a');
    if (namedLink) {
      const href = (namedLink.getAttribute('href') ?? '').trim();
      const name = (namedLink.textContent ?? '').trim();
      if (href !== '' || name !== '') return { channel: name, channelUrl: href === '' ? null : href };
    }

    // Then by shape, preferring a link that also carries the name.
    let href = '';
    let name = '';
    for (const link of element.querySelectorAll(CHANNEL_LINK_SELECTOR)) {
      const linkHref = (link.getAttribute('href') ?? '').trim();
      const linkName = (link.textContent ?? '').trim();
      if (linkHref !== '' && linkName !== '') return { channel: linkName, channelUrl: linkHref };
      if (href === '' && linkHref !== '') href = linkHref;
      if (name === '' && linkName !== '') name = linkName;
    }

    // The link may have been an avatar with no text, so the printed name is read
    // from wherever this card keeps it.
    const printed = readPrintedChannelName(element);
    const label = name !== '' ? name : printed;
    // `channel` is the field name the worker matches on — the payload contract is
    // { title, channel, channelUrl } and nothing else reads it.
    return { channel: label, channelUrl: href === '' ? null : href };
  }

  /**
   * What a card says about itself — `{ title, channel, channelUrl }`.
   *
   * The channel's LINK is preferred over its name, because the link is YouTube's
   * own claim about which channel this is, where the name is only what it chose
   * to print and two different channels can print the same one. The name is read
   * regardless, because on the current grid it is all there is.
   *
   * These three fields are the payload contract with the worker's
   * `feed/evaluate`, which matches `channel`/`channelUrl` and keyword-matches
   * `title` — renaming one here silently matches nothing there.
   */
  function readCard(element) {
    return { title: readCardTitle(element), ...readCardChannel(element) };
  }

  /**
   * The channel a card is by, as a block TARGET: a link and/or a printed name.
   *
   * Shared by the right-click path and the card's own ⋮ menu, so both read a card
   * the same way — and, as there, a name is never promoted to a handle here. What
   * to store from it is the worker's decision.
   */
  function cardChannelTarget(card) {
    const { channel, channelUrl } = readCard(card);
    const name = typeof channel === 'string' ? channel.trim() : '';
    if (!channelUrl && name === '') return null;
    return { url: channelUrl ?? null, name: name === '' ? null : name };
  }

  /**
   * The card a node sits in, across every layout YouTube serves.
   *
   * The renderers come first; a bare lockup is the second shape. Kept as one
   * helper so the ⋮ click and the right-click cannot disagree about what a card
   * is — they did, and the ⋮ entry was the one that broke.
   */
  function cardElementFor(node) {
    if (!node?.closest) return null;
    return node.closest(CARD_SELECTOR) ?? node.closest(LOCKUP_CARD_SELECTOR);
  }

  /**
   * Every card on the page, once each.
   *
   * A lockup nested inside one of the renderers is already covered by that
   * renderer, so it is NOT added a second time: evaluating one card twice would
   * send it twice and let the verdict be applied to the wrapper and to the
   * lockup separately.
   */
  function cardElements() {
    const elements = [...document.querySelectorAll(CARD_SELECTOR)];
    for (const lockup of document.querySelectorAll(LOCKUP_CARD_SELECTOR)) {
      if (!lockup.closest(CARD_SELECTOR)) elements.push(lockup);
    }
    return elements;
  }

  // ── Feed cards ─────────────────────────────────────────────────────────

  /**
   * Take off whatever this script put on the card — and nothing else.
   *
   * The display is restored only when this script is what hid the card. An
   * untouched card's inline display is `''`, and treating that as a recorded
   * value would "restore" the card the caller has just hidden — which is how a
   * blocked channel's card came back the instant it was removed.
   */
  function removeOverlay(record, element) {
    if (record?.overlay?.parentNode) record.overlay.parentNode.removeChild(record.overlay);
    if (record) record.overlay = undefined;
    if (record?.hidden) {
      element.style.display = record.previousDisplay ?? '';
      record.hidden = false;
    }
  }

  /** Hide a card, remembering what its display was the first time we did. */
  function hideCard(record, element) {
    if (!record.hidden) {
      record.previousDisplay = element.style.display;
      record.hidden = true;
    }
    element.style.display = 'none';
  }

  /**
   * Undo one card's decision — the overlay it may carry, the display it may have
   * lost — and forget it.
   */
  function restoreCard(element) {
    const record = handled.get(element);
    if (!record) return;
    removeOverlay(record, element);
    element.removeAttribute('data-cv-protected');
    handled.delete(element);
  }

  /** Forget every decision and restore the original cards. */
  function reset() {
    for (const element of cardElements()) restoreCard(element);
  }

  /**
   * Was this card decided by the rules that are in force NOW?
   *
   * A record in the WeakMap is not proof of anything on its own, and this is the
   * bug it exists to close: YouTube caches and re-attaches whole feed subtrees,
   * so a card judged clean before the user blocked its channel comes back on
   * screen with its record intact. Skipping it because it "was already handled"
   * is exactly how a blocked channel kept appearing in the feed — the reset that
   * follows a rules change only reaches the elements that are in the document at
   * that moment, and the user is usually on the video page when they block.
   */
  function decidedByCurrentRules(element) {
    return handled.get(element)?.revision === config.revision;
  }

  function applyProtection(element, verdict) {
    const record = handled.get(element) ?? {};

    // A channel the user blocked BY HAND is removed outright, whatever the Brain
    // Bot display mode says. The mode exists to choose how a keyword match is
    // presented; it has no business leaving a channel the user asked to be rid
    // of on the page under an overlay.
    const remove = verdict.via === 'channel' || config.brainBotMode === 'remove';
    record.mode = remove ? 'remove' : 'overlay';

    if (record.mode === 'remove') {
      // Cleanup FIRST, then hide: an earlier overlay and an earlier hide are both
      // undone by this call, and doing it the other way round let the cleanup
      // restore the display that was just set to none.
      removeOverlay(record, element);
      hideCard(record, element);
    } else {
      // Overlay mode keeps the card in place. Reaching it from Remove mode has
      // to give the card its place back first, or "kept in place" would mean
      // "still hidden".
      if (record.hidden) {
        element.style.display = record.previousDisplay ?? '';
        record.hidden = false;
      }
      // Reuse an overlay this script already drew (a mode switch re-enters here)
      // so a card can never end up covered twice.
      if (!record.overlay) {
        let overlay = element.querySelector(`.${OVERLAY_CLASS}`);
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = OVERLAY_CLASS;
          const label = document.createElement('div');
          label.className = `${OVERLAY_CLASS}__label`;
          label.textContent = 'Protected by ClearView';
          const reason = document.createElement('div');
          reason.className = `${OVERLAY_CLASS}__reason`;
          reason.textContent = verdict.matchedItem ? `Blocked: ${verdict.matchedItem}` : 'Hidden content';
          overlay.append(label, reason);
          element.style.position = element.style.position || 'relative';
          element.appendChild(overlay);
        }
        record.overlay = overlay;
      }
    }

    element.setAttribute('data-cv-protected', verdict.via ?? 'feed');
    // Stamped with the rules it was decided under, so a later rules change makes
    // this decision stale rather than permanent.
    record.revision = config.revision;
    handled.set(element, record);
  }

  /**
   * Judge the cards that have not been decided yet.
   *
   * A card whose title has not rendered yet is left undecided rather than marked
   * clean, so the next mutation re-checks it — otherwise a lazily-rendered
   * explicit title would slip through permanently.
   */
  async function scan() {
    // Blocked channels are filtered whenever Protection is on; the Brain Bot
    // toggle governs the keyword filters. Both are decided in the worker, so this
    // only has to know whether EITHER could apply — and asking is what keeps the
    // rule set out of the page.
    const channelRules = config.blockedChannelCount > 0;
    if (!config.enabled || (!config.brainBotEnabled && !channelRules)) {
      reset();
      return;
    }

    const elements = cardElements();
    const pending = [];
    const payload = [];
    for (const element of elements) {
      if (decidedByCurrentRules(element)) continue;
      const card = readCard(element);
      pending.push(element);
      payload.push(card);
    }
    if (pending.length === 0) return;

    // Judge in bounded batches so a huge home feed cannot produce one request
    // the worker has to cap.
    const BATCH = 60;
    for (let start = 0; start < pending.length; start += BATCH) {
      const slice = payload.slice(start, start + BATCH);
      const response = await send('feed/evaluate', { cards: slice });
      if (!response?.ok) return;
      const verdicts = new Map(response.data.blocked.map((b) => [b.index, b]));
      slice.forEach((card, i) => {
        const element = pending[start + i];
        const verdict = verdicts.get(i);
        if (verdict) {
          applyProtection(element, verdict);
        } else if (card.title !== '') {
          // A card with a channel link but no title yet is still worth marking
          // only once the title is known, so a lazy title is never missed.
          //
          // Anything this script did to the card BEFORE is undone first: the
          // verdict that produced it may be gone, and a card left hidden (or
          // left covered) by a decision that no longer applies is the same bug
          // in the other direction.
          restoreCard(element);
          handled.set(element, { mode: 'clean', revision: config.revision });
        }
        // else: no title yet — left unhandled for the next pass.
      });
    }
  }

  // ── The video's own ⋮ menu ─────────────────────────────────────────────

  /**
   * The channel of the video currently being watched.
   *
   * Read from the owner link rather than from the title or the byline, because
   * the LINK is the identity: it is `/@handle` or `/channel/UC…` rather than a
   * display name that any channel could reuse.
   */
  function watchChannelIdentity() {
    // The owner block first — but by the SHAPE of the link inside it, not by a
    // deep element path, because YouTube has moved `#owner` between several
    // wrappers (`ytd-video-owner-renderer`, `#owner-and-teaser`, plain divs) and
    // every move would have broken a path-based lookup silently.
    const OWNER_ROOTS = [
      'ytd-watch-metadata #owner',
      'ytd-video-owner-renderer',
      '#owner',
      'ytd-watch-metadata',
    ];

    for (const rootSelector of OWNER_ROOTS) {
      const root = document.querySelector(rootSelector);
      if (!root) continue;
      const link = root.querySelector(CHANNEL_LINK_SELECTOR);
      if (!link) continue;
      const href = link.getAttribute('href') ?? '';
      const name = (link.textContent ?? '').trim();
      if (href.trim() === '' && name === '') continue;
      return { url: href.trim() === '' ? null : href, name: name === '' ? null : name };
    }

    // Last resort: the video page itself carries the channel in its own player
    // response, which YouTube embeds as JSON in the document.
    return watchIdentityFromPlayerResponse();
  }

  /**
   * The channel, read out of the page's embedded player response.
   *
   * Every YouTube watch page ships the video's own metadata as a JSON blob in a
   * script tag, including the authoritative channel id. It is a fallback because
   * it means parsing a blob that is not a public interface — but it does not
   * depend on a single element path, so it survives markup changes that would
   * otherwise leave the feature with nothing at all.
   */
  function watchIdentityFromPlayerResponse() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent ?? '';
      if (!text.includes('"channelId"')) continue;
      const id = /"channelId"\s*:\s*"(UC[\w-]{10,})"/.exec(text);
      if (!id) continue;
      const name = /"author"\s*:\s*"([^"]{1,100})"/.exec(text);
      return { url: `/channel/${id[1]}`, name: name ? name[1] : null };
    }
    return null;
  }

  /** True when an element is actually displayed. */
  function isVisible(element) {
    if (!element || element.hidden) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  /**
   * The open dropdown belonging to the video's ⋮ menu.
   *
   * Scoped to `ytd-watch-metadata` first, on purpose: the page has several menu
   * renderers (the guide, every card, the player), and injecting into whichever
   * one happens to be open would put "Block this channel" in the wrong menu.
   *
   * The second branch exists because YouTube renders SOME dropdowns into a
   * document-level container instead of inside the component that owns them, and
   * a lookup that only knew the first shape would silently stop finding the menu
   * the day that changed. It is safe because the caller only looks within a
   * couple of seconds of a click on the watch menu's OWN trigger, so the menu
   * that just opened is the one that was clicked — and the popup must still be a
   * menu (`ytd-menu-popup-renderer`) rather than a dialog.
   */
  function findOpenWatchMenu() {
    const scoped = [...document.querySelectorAll('ytd-watch-metadata tp-yt-iron-dropdown')].find(isVisible);
    if (scoped) return scoped;

    return (
      [...document.querySelectorAll('ytd-popup-container tp-yt-iron-dropdown')].find(
        (dropdown) => isVisible(dropdown) && dropdown.querySelector('ytd-menu-popup-renderer')
      ) ?? null
    );
  }

  /**
   * The open dropdown belonging to the CARD whose ⋮ was just clicked.
   *
   * BOTH card menus are live at once and they are different components:
   *
   *  - the current grid's card opens a context SHEET (`yt-sheet-view-model` with
   *    a `role="menu"` list of `yt-list-item-view-model` rows);
   *  - a SEARCH result card (`ytd-video-renderer`) opens the classic
   *    `ytd-menu-popup-renderer` list, the same component the video page uses,
   *    which is why matching only the sheet left every search card's menu
   *    untouched.
   *
   * Both are identified by what the dropdown contains, and only within the window
   * that follows a click on a card's own trigger.
   */
  function findOpenCardMenu() {
    return (
      [...document.querySelectorAll('ytd-popup-container tp-yt-iron-dropdown')].find(
        (dropdown) =>
          isVisible(dropdown) &&
          (dropdown.querySelector(CARD_SHEET_SELECTOR) ||
            dropdown.querySelector('ytd-menu-popup-renderer'))
      ) ?? null
    );
  }

  /** Whichever menu was just opened: a card's, or the video page's. */
  function findOpenMenu() {
    return menuCard ? findOpenCardMenu() : findOpenWatchMenu();
  }

  /**
   * Where inside the dropdown our entry belongs.
   *
   * `#items` is a plain div; the custom elements around it are Polymer-managed
   * and appending into them risks the framework wiping the node on its next
   * render.
   */
  function menuItemsContainer(dropdown) {
    return (
      dropdown.querySelector(CARD_SHEET_SELECTOR) ??
      dropdown.querySelector('ytd-menu-popup-renderer #items') ??
      dropdown.querySelector('#items') ??
      dropdown.querySelector('tp-yt-paper-listbox') ??
      dropdown.querySelector('ytd-menu-popup-renderer') ??
      null
    );
  }

  /**
   * The entry's icon, built as NODES rather than as an `innerHTML` string.
   *
   * It was a string constant, and that was a landmine: youtube.com enforces
   * Trusted Types (`require-trusted-types-for 'script'`), and there `element.
   * innerHTML = '…'` throws — the entry was never built at all, so the menu item
   * silently never appeared. A content script's isolated world is exempt from the
   * page's policy today, which is why this only showed up when the script was run
   * in the page's own world; building nodes depends on no such exemption.
   *
   * No page data is used here either way — the path is a constant of our own.
   */
  function buildBlockIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute(
      'd',
      'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.96 7.96 0 0 1 12 4zm0 16a7.96 7.96 0 0 1-4.9-1.69L18.31 7.1A7.96 7.96 0 0 1 12 20z'
    );
    svg.append(path);
    return svg;
  }

  /**
   * What the entry says, in each menu.
   *
   * A CARD's menu is the narrower one — YouTube sizes it to its own longest row,
   * and on a search result that is `Send feedback`, about 181px — so the card's
   * entry says `Block channel` and fits on one line, while the video page keeps
   * the fuller sentence. Same action, sized to its menu.
   */
  const WATCH_MENU_LABEL = 'Block this channel';
  const CARD_MENU_LABEL = 'Block channel';

  function buildMenuItem(text = WATCH_MENU_LABEL) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = MENU_ITEM_CLASS;
    item.setAttribute('role', 'menuitem');
    item.dataset.cvAction = 'block';

    const icon = document.createElement('span');
    icon.className = `${MENU_ITEM_CLASS}__icon`;
    icon.append(buildBlockIcon());

    const label = document.createElement('span');
    label.className = `${MENU_ITEM_CLASS}__label`;
    label.textContent = text;

    item.append(icon, label);
    item.addEventListener('click', (event) => {
      // The click must not reach YouTube: the surrounding markup closes the menu
      // and would also treat the press as a selection of whatever is underneath.
      event.preventDefault();
      event.stopPropagation();
      // Which channel the entry is about is decided by WHICH menu is open: the
      // video page's ⋮ blocks the video's channel, a card's ⋮ blocks that card's.
      if (menuCard) void blockCardChannel(label);
      else void toggleWatchChannel(label);
      closeOpenMenu();
    });
    return item;
  }

  /** Close the ⋮ menu after we have acted, the way Escape does. */
  function closeOpenMenu() {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    } catch {
      /* nothing else to try — the menu closes on the next click regardless */
    }
  }

  /**
   * Put our entry in the ⋮ menu, if it is open.
   *
   * Guarded twice: the menu must have been opened by a click on the watch
   * metadata's own trigger (so another menu renderer's dropdown is never taken
   * for it), and the entry must not already be there (so a re-render cannot
   * stack a second copy).
   */
  function maybeInjectMenuItem() {
    if (!config.enabled) return 'skipped';
    if (Date.now() - menuOpenedAt > MENU_WINDOW_MS) return 'waiting';

    const dropdown = findOpenMenu();
    if (!dropdown) return 'waiting';
    const container = menuItemsContainer(dropdown);
    if (!container) return 'waiting';
    if (container.querySelector(`.${MENU_ITEM_CLASS}`)) return 'present';

    // Prepended, not appended: the menu scrolls when it is long, and an entry at
    // the bottom of a scrolled list is an entry the user has to hunt for.
    container.prepend(buildMenuItem(menuCard ? CARD_MENU_LABEL : WATCH_MENU_LABEL));
    // The label is corrected a moment later, from the worker's answer: showing
    // "Block this channel" for a channel that is ALREADY blocked would be a
    // button that does nothing the user expects. Only the video page's entry has
    // two labels to choose between — a blocked channel has no card on the page
    // for its own entry to be clicked from.
    if (!menuCard) void refreshMenuItemLabel(container);
    return 'injected';
  }

  let menuRetryTimer = null;

  /**
   * Try repeatedly, for a moment, to put the entry in the menu.
   *
   * The mutation observer is not enough on its own, and this is the reason: the
   * observer watches for CHILD LIST changes, and opening a dropdown can be a
   * style/attribute change with no children added — in which case the observer
   * never fires and the entry would simply never appear. Retrying for a bounded
   * window after the trigger is clicked covers both shapes without watching
   * attributes on the whole page (which would fire on every hover).
   */
  function scheduleMenuInjection(card = null) {
    menuCard = card;
    menuOpenedAt = Date.now();
    if (menuRetryTimer !== null) return;

    const attempt = () => {
      menuRetryTimer = null;
      const outcome = maybeInjectMenuItem();
      if (outcome !== 'waiting') return;
      if (Date.now() - menuOpenedAt > MENU_WINDOW_MS) return;
      menuRetryTimer = window.setTimeout(attempt, 150);
    };
    menuRetryTimer = window.setTimeout(attempt, 60);
  }

  /**
   * The channel the PAGE itself is by, when it is one.
   *
   * A card on a channel's own grid names nobody — the owner is implicit on that
   * page — so the address bar is the only thing that can say whose video was
   * clicked. `watchChannelIdentity` answers the equivalent question on a video
   * page (a related-video card is not always by the video's channel, so the card
   * still wins there).
   */
  function pageChannelTarget() {
    if (location.pathname === '/watch') return watchChannelIdentity();
    if (!isChannelPagePath(location.pathname)) return null;
    const name = channelPageName();
    return { url: location.href, name: name === '' ? null : name };
  }

  /**
   * Block the channel a CARD is by, from that card's own ⋮ menu.
   *
   * This is the entry that did not exist: on the feed the only menu a card has is
   * this one, and until now it offered no way to block without opening the video
   * and using the player's menu. The channel is read exactly as the right-click
   * reads it — the card's link when it has one, the name it prints when it does
   * not — so a link-less card is still blockable.
   */
  async function blockCardChannel(labelNode) {
    // The card's own channel first, then the PAGE's — the same precedence the
    // right-click uses. The fallback is what makes this entry work on a channel's
    // own grid, where the card is the owner's video and says nothing about who
    // that is: the address bar does.
    const target = (menuCard ? cardChannelTarget(menuCard) : null) ?? pageChannelTarget();
    if (!target) {
      showToast('ClearView could not read this card’s channel. Open the video and use its ⋮ menu.');
      return;
    }

    const response = await send('channel/block', { ...target, source: 'youtube-menu' });
    if (!response?.ok) {
      showToast(errorText(response, 'ClearView could not block that channel.'));
      return;
    }
    if (labelNode) labelNode.textContent = 'Blocked';
    // Naming the channel matters here, unlike on the video page: the card is
    // about to disappear, and the toast is the only record of which one went.
    showToast(`Blocked ${target.name ?? target.url}. Manage it in Settings → Blocked channels.`);
  }

  async function refreshMenuItemLabel(container) {
    const identity = watchChannelIdentity();
    if (!identity) return;
    const response = await send('channel/status', identity);
    const item = container.querySelector(`.${MENU_ITEM_CLASS}__label`);
    if (!item || !response?.ok) return;
    item.textContent = response.data.blocked ? 'Unblock this channel' : 'Block this channel';
    item.dataset.cvBlocked = response.data.blocked ? 'yes' : 'no';
  }

  /** Block or unblock the channel of the video being watched, from the ⋮ menu. */
  async function toggleWatchChannel(labelNode) {
    const identity = watchChannelIdentity();
    if (!identity) {
      showToast('ClearView could not read this video’s channel.');
      return;
    }

    const status = await send('channel/status', identity);
    if (!status?.ok) {
      showToast(errorText(status, 'ClearView could not check that channel.'));
      return;
    }

    if (status.data.blocked) {
      const response = await send('channel/unblock', { label: status.data.matchedItem });
      if (!response?.ok) {
        showToast(errorText(response, 'ClearView could not unblock that channel.'));
        return;
      }
      if (labelNode) labelNode.textContent = 'Block this channel';
      showToast(`Unblocked ${status.data.matchedItem}.`);
      return;
    }

    const response = await send('channel/block', { ...identity, source: 'youtube-menu' });
    if (!response?.ok) {
      showToast(errorText(response, 'ClearView could not block that channel.'));
      return;
    }
    if (labelNode) labelNode.textContent = 'Unblock this channel';
    showToast('Channel blocked. Manage it in Settings → Blocked channels.');
  }

  // ── A video page whose channel is blocked ──────────────────────────────

  /**
   * The name a CHANNEL page prints for itself.
   *
   * A channel page's URL names only the handle, so this is the one place a block
   * stored by NAME — which is all a right-click on a link-less feed card can make
   * — can stop the channel's own page from opening.
   */
  function channelPageName() {
    const named = document.querySelector(
      'ytd-c4-tabbed-header-renderer #channel-name #text, #channel-header #channel-name #text, ytd-channel-name #text, ytd-c4-tabbed-header-renderer #text'
    );
    const name = (named?.textContent ?? '').trim();
    if (name !== '') return name;

    // The page's own metadata, which renders before the header does.
    const title = (document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '').trim();
    return title.replace(/\s*[-–]\s*YouTube\s*$/i, '').trim();
  }

  /** True for the URL shapes a channel page has. */
  function isChannelPagePath(pathname) {
    return /^\/(@|channel\/|c\/|user\/)/.test(pathname);
  }

  /**
   * Ask the worker about the channel this page is showing.
   *
   * A `/watch` page names no channel, so the video's own channel is read off the
   * page. A CHANNEL page names it in the URL, which the worker's navigation
   * evaluator already checks — and its NAME is sent as well, which is what makes
   * a name-only block cover the page. A Shorts page is the Shorts control's
   * business. The redirect belongs to the worker either way: a page cannot
   * navigate itself to a `chrome-extension://` URL, so there is nothing to apply
   * here.
   */
  async function enforcePageChannel() {
    if (!config.enabled || config.blockedChannelCount === 0) return;

    const url = location.href;
    if (url === lastCheckedPageUrl) return;

    if (location.pathname === '/watch') {
      const identity = watchChannelIdentity();
      // The metadata renders after the player does, so a miss here is normal and
      // must NOT be recorded as "checked" — the next mutation tries again.
      if (!identity) return;
      lastCheckedPageUrl = url;
      await send('channel/check', identity);
      return;
    }

    if (!isChannelPagePath(location.pathname)) return;
    const name = channelPageName();
    if (name === '') return;
    lastCheckedPageUrl = url;
    await send('channel/check', { url, name });
  }

  // ── The card the user last right-clicked ───────────────────────────────

  /**
   * What the worker needs to resolve a right-click.
   *
   * Chrome's context-menu click reports the LINK under the cursor, which for a
   * thumbnail is the video — and a video URL names no channel. The page is the
   * only thing that can say, and `contextmenu` fires on the page before Chrome's
   * menu opens, so the answer is recorded here as the click happens.
   */
  let lastContextTarget = null;

  document.addEventListener(
    'contextmenu',
    (event) => {
      lastContextTarget = readContextTarget(event.target);
    },
    true
  );

  function readContextTarget(node) {
    if (!node?.closest) return null;

    // A card first: the channel of the video that was actually right-clicked.
    const card = cardElementFor(node);
    if (card) {
      const target = cardChannelTarget(card);
      if (target) return target;
      // A card with no channel link (a playlist, a Short) is not a dead end if
      // the page itself is a channel's — handled by the caller's page-URL
      // fallback.
    }

    // The player, the title, the description, the metadata block: on a video page
    // the only channel that can sensibly be meant is the video's own.
    if (node.closest('#movie_player, #player, ytd-watch-metadata, ytd-watch-flexy, #owner')) {
      return watchChannelIdentity();
    }
    return null;
  }

  // ── Toast ──────────────────────────────────────────────────────────────

  let toastTimer = null;

  /**
   * Say what happened.
   *
   * A context-menu click has no UI of its own, and the ⋮ menu closes the instant
   * it is used — without this, a block would be completely silent and the user
   * would have no way to tell it worked.
   */
  function showToast(text) {
    if (typeof text !== 'string' || text.trim() === '') return;
    let toast = document.querySelector(`.${TOAST_CLASS}`);
    if (!toast) {
      toast = document.createElement('div');
      toast.className = TOAST_CLASS;
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add(`${TOAST_CLASS}--visible`);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove(`${TOAST_CLASS}--visible`), 4000);
  }

  // ── Mutation-driven refresh ────────────────────────────────────────────

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      // The entry points, the feed, the ads and the ⋮ menu are all re-rendered as
      // the user browses, so one debounced pass keeps them all correct.
      applyShorts();
      applyAds();
      void scan();
      maybeInjectMenuItem();
      void enforcePageChannel();
    }, 200);
    // (The ⋮ menu is also retried on its own timer — see scheduleMenuInjection.)
  }

  /** Re-read the rules and re-apply everything from scratch. */
  async function refresh() {
    const previous = config.revision;
    await loadConfig();
    // The worker's fingerprint covers the toggles AND the rules, so a new
    // keyword, a newly blocked channel and a mode switch all land here — the
    // three things that change what a card should look like.
    if (previous !== '' && config.revision !== previous) reset();
    applyShorts();
    applyAds();
    await scan();
    void enforcePageChannel();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  // The ⋮ menu's dropdown is opened by a click on the watch metadata's own
  // trigger. Recorded in the CAPTURE phase so it is seen even if YouTube stops
  // the event from bubbling.
  document.addEventListener(
    'click',
    (event) => {
      if (!event.target?.closest) return;
      // Deliberately broad — ANY button inside the watch metadata's menu
      // renderer. YouTube has renamed the trigger's id and class several times,
      // and the cost of being broad is nil: this only opens a few-second window
      // in which a dropdown that just appeared is looked at.
      // A CARD's own ⋮ comes first: the entry has to know which card it belongs
      // to, and the click that opened the menu is the only thing that knows.
      const card = cardElementFor(event.target);
      if (card && event.target.closest(CARD_MENU_TRIGGER_SELECTOR)) {
        scheduleMenuInjection(card);
        return;
      }
      if (event.target.closest('ytd-watch-metadata ytd-menu-renderer button, ytd-watch-metadata ytd-menu-renderer .dropdown-trigger, ytd-watch-metadata #menu button')) {
        scheduleMenuInjection();
      }
    },
    true
  );

  const observer = new MutationObserver(scheduleScan);

  /**
   * A slow heartbeat for the ad pass.
   *
   * The mutation observer watches the DOM tree, and the player is marked as
   * showing an ad by a CLASS change — which adds no child and therefore fires no
   * mutation. Video ads are also short, so a pass that only ran on mutations
   * would routinely miss the window in which YouTube's skip control exists.
   * One second is frequent enough to catch a pre-roll and light enough to ignore.
   */
  function startAdHeartbeat() {
    window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (adsOn()) applyAds();
    }, 1000);
  }

  function start() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    startAdHeartbeat();
    window.addEventListener('yt-navigate-finish', () => {
      // A new page is a new channel to check, so the memo has to be cleared.
      lastCheckedPageUrl = null;
      applyShorts();
      applyAds();
      scheduleScan();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleScan();
    });
    // A settings change in the popup or options page takes effect on the next
    // tick, without a reload.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync') void refresh();
      });
    } catch {
      /* orphaned context — nothing to subscribe to */
    }
  }

  // The worker asks this when its context-menu item is used, and tells us the
  // outcome so the page can say what happened.
  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'channel/contextTarget') {
        sendResponse(lastContextTarget ?? null);
        return false;
      }
      if (message?.type === 'channel/blockResult') {
        showToast(message.text);
        return false;
      }
      return false;
    });
  } catch {
    /* orphaned context */
  }

  void refresh().then(start);
})();
