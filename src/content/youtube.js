/**
 * YouTube content script.
 *
 * Its jobs, and the split between them, is deliberate:
 *
 *  - **Hide the Shorts entry points.** This script only HIDES: it toggles a
 *    class on <html> and hides the matching guide/chip entries, and it
 *    intercepts no navigation. Blocking a Shorts URL outright is the background
 *    worker's job (the `blockShorts` check in evaluateUrl), which keeps the two
 *    concerns — what the page shows, and what may be loaded — separate.
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
  const MENU_ITEM_CLASS = 'cv-menu-item';
  const TOAST_CLASS = 'cv-toast';

  /** Card containers YouTube uses across home, search, subscriptions, related. */
  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-rich-grid-media',
  ].join(',');

  /**
   * How long after the ⋮ trigger was clicked we will still look for its menu.
   *
   * The dropdown is rendered on demand, and the observer that notices it fires on
   * a debounce — so the window has to outlast the debounce, and must not outlast
   * it by so much that a menu opened later is mistaken for this one.
   */
  const MENU_WINDOW_MS = 3000;

  let config = {
    enabled: false,
    brainBotEnabled: false,
    brainBotMode: 'overlay',
    blockShorts: false,
    blockedChannelCount: 0,
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

  let configSignature = '';
  let scanTimer = null;
  let watchMenuOpenedAt = 0;
  let lastCheckedWatchUrl = null;

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

  // ── Shorts entry points ────────────────────────────────────────────────

  /**
   * The containers a Shorts entry can live in.
   *
   * YouTube renames the label and reshuffles these elements' attributes far more
   * often than it changes where a Shorts link POINTS, so an entry is identified
   * by shape (a link to /shorts) rather than by its text. The CSS file carries
   * the same rules for an instant hide on load; this JS pass is what copes with
   * the guide being re-rendered later, which is when a pure-CSS fix silently
   * stops working.
   */
  const SHORTS_CONTAINER_SELECTOR = [
    'ytd-guide-entry-renderer',
    'ytd-mini-guide-entry-renderer',
    'yt-chip-cloud-chip-renderer',
  ].join(',');

  /** Shorts entries this script has hidden, with the display value to restore. */
  const hiddenShorts = new Map();

  function isShortsEntry(element) {
    if (element.hasAttribute('is-shorts')) return true;
    if (element.querySelector('a[href^="/shorts"]')) return true;
    const label = `${element.getAttribute('title') ?? ''} ${element.getAttribute('aria-label') ?? ''}`
      .trim()
      .toLowerCase();
    if (label === 'shorts') return true;
    return Boolean(element.querySelector('[title="Shorts"], [aria-label="Shorts"]'));
  }

  function restoreShortsEntries() {
    for (const [element, previousDisplay] of hiddenShorts) {
      element.style.display = previousDisplay;
    }
    hiddenShorts.clear();
  }

  /**
   * Hide (or restore) the Shorts entry points.
   *
   * Runs on every mutation as well as on navigation, so an entry rendered later
   * is caught. Hiding never touches a /shorts URL — reaching a Short directly
   * still works unless the Shorts control is on, in which case the URL block is
   * the background worker's.
   */
  function applyShorts() {
    const hide = Boolean(config.enabled && config.blockShorts);
    document.documentElement.classList.toggle(HIDE_CLASS, hide);

    if (!hide) {
      restoreShortsEntries();
      return;
    }

    for (const element of document.querySelectorAll(SHORTS_CONTAINER_SELECTOR)) {
      if (hiddenShorts.has(element) || !isShortsEntry(element)) continue;
      hiddenShorts.set(element, element.style.display);
      element.style.display = 'none';
    }
    // Drop entries YouTube has since removed, so the map cannot grow unbounded
    // during a long session of guide re-renders.
    for (const element of [...hiddenShorts.keys()]) {
      if (!element.isConnected) hiddenShorts.delete(element);
    }
  }

  // ── Reading a card ─────────────────────────────────────────────────────

  /**
   * What a card says about itself.
   *
   * The channel's LINK is read as well as its name, and the link is the more
   * useful of the two: it is YouTube's own claim about which channel this is
   * (`/@handle` or `/channel/UC…`), where the name is only what it chose to
   * print — and two different channels can print the same name.
   */
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

  function readCard(element) {
    const titleEl = element.querySelector('#video-title, a#video-title, #video-title-link');
    const title =
      (titleEl?.textContent ?? '').trim() || (titleEl?.getAttribute('title') ?? '').trim();

    // The named spot first, then the shape. A card's thumbnail link points at a
    // VIDEO, so the first channel-shaped link in the card is the channel.
    const channelEl =
      element.querySelector('ytd-channel-name a, #channel-name a, .ytd-channel-name a') ??
      element.querySelector(CHANNEL_LINK_SELECTOR);

    const channel = (channelEl?.textContent ?? '').trim();
    const href = channelEl?.getAttribute('href') ?? '';
    return { title, channel, channelUrl: href.trim() === '' ? null : href };
  }

  // ── Feed cards ─────────────────────────────────────────────────────────

  function removeOverlay(record, element) {
    if (record?.overlay?.parentNode) record.overlay.parentNode.removeChild(record.overlay);
    if (record?.previousDisplay !== undefined) element.style.display = record.previousDisplay;
  }

  /** Forget every decision and restore the original cards. */
  function reset() {
    for (const element of document.querySelectorAll(CARD_SELECTOR)) {
      const record = handled.get(element);
      if (!record) continue;
      removeOverlay(record, element);
      element.removeAttribute('data-cv-protected');
      handled.delete(element);
    }
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
      if (record.previousDisplay === undefined) record.previousDisplay = element.style.display;
      element.style.display = 'none';
      removeOverlay(record, element);
      record.overlay = undefined;
    } else {
      // Overlay mode keeps the card in place. Reuse an overlay this script
      // already drew (a mode switch re-enters here) so a card can never end up
      // covered twice.
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

    const elements = [...document.querySelectorAll(CARD_SELECTOR)];
    const pending = [];
    const payload = [];
    for (const element of elements) {
      if (handled.has(element)) continue;
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
          handled.set(element, { mode: 'clean' });
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
   * Where inside the dropdown our entry belongs.
   *
   * `#items` is a plain div; the custom elements around it are Polymer-managed
   * and appending into them risks the framework wiping the node on its next
   * render.
   */
  function menuItemsContainer(dropdown) {
    return (
      dropdown.querySelector('ytd-menu-popup-renderer #items') ??
      dropdown.querySelector('#items') ??
      dropdown.querySelector('tp-yt-paper-listbox') ??
      dropdown.querySelector('ytd-menu-popup-renderer') ??
      null
    );
  }

  const BLOCK_ICON =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.96 7.96 0 0 1 12 4zm0 16a7.96 7.96 0 0 1-4.9-1.69L18.31 7.1A7.96 7.96 0 0 1 12 20z"/>' +
    '</svg>';

  function buildMenuItem() {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = MENU_ITEM_CLASS;
    item.setAttribute('role', 'menuitem');
    item.dataset.cvAction = 'block';

    const icon = document.createElement('span');
    icon.className = `${MENU_ITEM_CLASS}__icon`;
    // A fixed string of our own markup — no page data is ever interpolated into
    // it, so this cannot become an injection.
    icon.innerHTML = BLOCK_ICON;

    const label = document.createElement('span');
    label.className = `${MENU_ITEM_CLASS}__label`;
    label.textContent = 'Block this channel';

    item.append(icon, label);
    item.addEventListener('click', (event) => {
      // The click must not reach YouTube: the surrounding markup closes the menu
      // and would also treat the press as a selection of whatever is underneath.
      event.preventDefault();
      event.stopPropagation();
      void toggleWatchChannel(label);
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
    if (Date.now() - watchMenuOpenedAt > MENU_WINDOW_MS) return 'waiting';

    const dropdown = findOpenWatchMenu();
    if (!dropdown) return 'waiting';
    const container = menuItemsContainer(dropdown);
    if (!container) return 'waiting';
    if (container.querySelector(`.${MENU_ITEM_CLASS}`)) return 'present';

    container.appendChild(buildMenuItem());
    // The label is corrected a moment later, from the worker's answer: showing
    // "Block this channel" for a channel that is ALREADY blocked would be a
    // button that does nothing the user expects.
    void refreshMenuItemLabel(container);
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
  function scheduleMenuInjection() {
    watchMenuOpenedAt = Date.now();
    if (menuRetryTimer !== null) return;

    const attempt = () => {
      menuRetryTimer = null;
      const outcome = maybeInjectMenuItem();
      if (outcome !== 'waiting') return;
      if (Date.now() - watchMenuOpenedAt > MENU_WINDOW_MS) return;
      menuRetryTimer = window.setTimeout(attempt, 150);
    };
    menuRetryTimer = window.setTimeout(attempt, 60);
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
   * Ask the worker about the channel of the video on screen.
   *
   * Only for `/watch`: a channel page is decided from its URL alone by the
   * worker's navigation evaluator, and a Shorts page is the Shorts control's
   * business. The redirect belongs to the worker — a page cannot navigate itself
   * to a `chrome-extension://` URL — so there is nothing to apply here.
   */
  async function enforceWatchPage() {
    if (!config.enabled || config.blockedChannelCount === 0) return;
    if (location.pathname !== '/watch') return;

    const url = location.href;
    if (url === lastCheckedWatchUrl) return;

    const identity = watchChannelIdentity();
    // The metadata renders after the player does, so a miss here is normal and
    // must NOT be recorded as "checked" — the next mutation tries again.
    if (!identity) return;
    lastCheckedWatchUrl = url;

    await send('channel/check', identity);
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
    const card = node.closest(CARD_SELECTOR);
    if (card) {
      const { channel, channelUrl } = readCard(card);
      if (channelUrl || channel) return { url: channelUrl, name: channel === '' ? null : channel };
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
      // The entry points, the feed and the ⋮ menu are all re-rendered as the
      // user browses, so one debounced pass keeps them all correct.
      applyShorts();
      void scan();
      maybeInjectMenuItem();
      void enforceWatchPage();
    }, 200);
    // (The ⋮ menu is also retried on its own timer — see scheduleMenuInjection.)
  }

  /** Re-read the rules and re-apply everything from scratch. */
  async function refresh() {
    const previous = configSignature;
    await loadConfig();
    const next = JSON.stringify([
      config.enabled,
      config.brainBotEnabled,
      config.brainBotMode,
      config.blockShorts,
      config.blockedChannelCount,
    ]);
    if (previous !== '' && next !== previous) reset();
    configSignature = next;
    applyShorts();
    await scan();
    void enforceWatchPage();
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
      if (event.target.closest('ytd-watch-metadata ytd-menu-renderer button, ytd-watch-metadata ytd-menu-renderer .dropdown-trigger, ytd-watch-metadata #menu button')) {
        scheduleMenuInjection();
      }
    },
    true
  );

  const observer = new MutationObserver(scheduleScan);

  function start() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('yt-navigate-finish', () => {
      // A new video is a new channel to check, so the memo has to be cleared.
      lastCheckedWatchUrl = null;
      applyShorts();
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
