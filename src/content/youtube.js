/**
 * YouTube content script.
 *
 * Two jobs, both purely visual, and the split between them is deliberate:
 *
 *  - **Hide the Shorts entry points.** This script only HIDES: it toggles a
 *    class on <html> and hides the matching guide/chip entries, and it
 *    intercepts no navigation. Blocking a Shorts URL outright is the background
 *    worker's job (the `blockShorts` check in evaluateUrl), which keeps the two
 *    concerns — what the page shows, and what may be loaded — separate.
 *  - **Brain Bot feed protection.** Matching feed cards are either removed or
 *    covered in place, according to the user's chosen mode.
 *
 * It holds no rules and does no matching: it reads what is on screen (titles and
 * channel names) and asks the service worker which cards to act on. That keeps
 * one matcher in the codebase, and keeps a page from ever holding the rule set.
 *
 * YouTube is a single-page app, so "the page loaded" is not an event that happens
 * once. Changes are re-applied on in-app navigation and on DOM mutations, and
 * every element is marked once it has been handled so an overlay can never be
 * stacked twice.
 */

(() => {
  const OVERLAY_CLASS = 'cv-block-overlay';
  const HIDE_CLASS = 'cv-hide-shorts';

  /** Card containers YouTube uses across home, search, subscriptions, related. */
  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-rich-grid-media',
  ].join(',');

  let config = {
    enabled: false,
    brainBotEnabled: false,
    brainBotMode: 'overlay',
    blockShorts: false,
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

  // ── Messaging ──────────────────────────────────────────────────────────

  async function send(type, payload) {
    try {
      return await chrome.runtime.sendMessage({ type, ...payload });
    } catch {
      // The extension was reloaded or removed; the script is now orphaned.
      return null;
    }
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
   * still works — the URL-level block, when enabled, is the background worker's.
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

  // ── Feed cards ─────────────────────────────────────────────────────────

  function readCard(element) {
    const titleEl = element.querySelector('#video-title, a#video-title, #video-title-link');
    const title =
      (titleEl?.textContent ?? '').trim() || (titleEl?.getAttribute('title') ?? '').trim();
    const channelEl = element.querySelector('ytd-channel-name a, #channel-name a, .ytd-channel-name a');
    const channel = (channelEl?.textContent ?? '').trim();
    return { title, channel };
  }

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
    record.mode = config.brainBotMode === 'remove' ? 'remove' : 'overlay';

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
    if (!config.enabled || !config.brainBotEnabled) {
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
          handled.set(element, { mode: 'clean' });
        }
        // else: no title yet — left unhandled for the next pass.
      });
    }
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      // The entry points and the feed are both re-rendered as the user browses,
      // so one debounced pass keeps both correct.
      applyShorts();
      void scan();
    }, 200);
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
    ]);
    if (previous !== '' && next !== previous) reset();
    configSignature = next;
    applyShorts();
    await scan();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  const observer = new MutationObserver(scheduleScan);

  function start() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('yt-navigate-finish', () => {
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

  void refresh().then(start);
})();
