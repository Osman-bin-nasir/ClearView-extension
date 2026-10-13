/**
 * The background service worker.
 *
 * It owns everything with no UI: the rule bundle, the network, the blocking
 * listeners, and the admin session. Every page (popup, options, content script)
 * talks to it by message, which is what keeps the API reachable at all (the
 * backend serves browsers no CORS headers, but a service-worker request to a
 * host we hold permission for is exempt) and what keeps an admin token out of
 * any page a content script could reach.
 */

import { BRAINROT, STORAGE, coerceSubmissionSource } from '../common/constants.js';
import {
  bumpStats,
  getAnonymousId,
  getGlobalRules,
  getStats,
  resetStats,
  updateSettings,
} from '../common/settings.js';
import {
  addBlockedChannel,
  channelIdentity,
  channelLabel,
  channelRecord,
  normalizeBlockedChannels,
  removeBlockedChannel,
} from '../common/channels.js';
import {
  ApiError,
  adminLogin,
  adminLogout,
  adminRefresh,
  adminRequest,
  fetchSubmissions,
  reportTarget,
  submitSuggestion,
} from './api.js';
import { blockTab, evaluateFeedCards, installDomainRules, initBlocker, isChannelBlocked } from './blocking.js';
import { rulesFingerprint } from '../common/rules-bundle.js';
import { syncGlobalRules } from './rules-sync.js';
import { ensureState, refreshState } from './state.js';
import {
  CONTEXT_MENU_ID,
  CONTEXT_TARGET_MESSAGE,
  installContextMenus,
  resolveContextTarget,
  unresolvableMessage,
} from './context-menus.js';

const RULES_ALARM = 'clearview.rules-refresh';

/**
 * Load state, catch up on rules in the background, and install listeners.
 *
 * Idempotent: `onInstalled`, `onStartup` and the first top-level run can all
 * happen in one session, and doing the work three times would fire three
 * refreshes for one start.
 */
let bootstrapped = false;

async function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  await applyState();
  // Best-effort: a cold, offline start keeps working on the cached rules.
  void syncGlobalRules({ force: false }).then(async (result) => {
    if (result.changed) await applyState();
  });
}

/** Refresh our view of the world and (re-)install the host rules. */
async function applyState() {
  const state = await refreshState();
  await installDomainRules(state.bundle?.domains ?? []);
  return state;
}

// ── Blocking listener ────────────────────────────────────────────────────
//
// Registered here, at the TOP LEVEL and synchronously — not inside the async
// bootstrap above.
//
// MV3 stops an idle service worker, and delivers an event that arrives while it
// is stopped to whatever listeners were registered during the worker's FIRST
// synchronous run. A listener added after an `await` may not be registered yet
// when Chrome dispatches the event, and the event is then dropped. Registering
// this inside bootstrap() meant the worker was woken for a navigation, found no
// listener, and blocked nothing — websites, searches and Shorts alike. The state
// the handler needs is loaded lazily, inside the handler, so registration never
// depends on any async work having finished.
initBlocker({
  getState: () => ensureState(),
  onBlocked: (outcome, url) => {
    bumpStats(outcome.action === 'search' ? 'search' : (outcome.matchType ?? 'blocked'), url).catch(() => {});
  },
});

// ── Blocking a channel ───────────────────────────────────────────────────
//
// One function, because a channel gets blocked from four places — the video's
// ⋮ menu, the right-click menu, the options page, and the popup — and they must
// all end up with the same record, the same de-duplication, and the same
// immediate re-application of the rules.

/**
 * Add a channel to the block list.
 *
 * Returns the new state, or throws with a code the caller can word. The record
 * is built by `channelRecord`, so a caller that supplies nothing usable gets a
 * refusal rather than an empty entry that shows in the UI as a blank row.
 */
async function blockChannel({ handle = null, channelId = null, name = null, source = 'manual' } = {}) {
  const record = channelRecord({ handle, channelId, name, source });
  if (!record) throw new ApiError('invalid_channel', 400, 'That is not a channel ClearView can block.');

  const settings = (await ensureState()).settings;
  await updateSettings({ blockedChannels: addBlockedChannel(settings.blockedChannels, record) });
  await applyState();
  // The RECORD is returned alongside the state because the caller has to say
  // what was blocked — by handle where there is one, by name where there is not.
  return { state: await describeState(), record };
}

/**
 * Block what an entry point could actually see — a URL, a name, or both.
 *
 * One path for the ⋮ menu, the right-click menu and the settings page, so "a
 * channel target becomes a block record" is defined once. The URL is asked for
 * the handle and the id and the NAME IS KEPT AS A NAME: turning it into a handle
 * here would store `@thejapanesetown` for `The Japanese Town`, which matches
 * nothing and blocks nothing — while a stored name matches the same name, which
 * is what a right-click on the current grid's link-less card has to mean.
 */
async function blockChannelFromTarget({ url = null, name = null, channelId = null, source = 'manual' } = {}) {
  const fromUrl = channelIdentity({ url });
  return blockChannel({
    handle: fromUrl?.handle ?? null,
    channelId: fromUrl?.channelId ?? channelId,
    name: name ?? fromUrl?.name ?? null,
    source,
  });
}

// ── The right-click menu ─────────────────────────────────────────────────
//
// Registered at the TOP LEVEL, like the navigation listener above, and for the
// same reason: MV3 stops an idle worker, and an event that arrives while it is
// stopped only reaches a listener registered during the worker's first
// synchronous run.

installContextMenus();

/** Ask a tab's content script which card was last right-clicked. */
async function askPageForChannel(tabId) {
  if (typeof tabId !== 'number' || !chrome.tabs?.sendMessage) return null;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: CONTEXT_TARGET_MESSAGE });
    return response ?? null;
  } catch {
    // No content script in that tab (a non-YouTube page, a PDF, a page loaded
    // before the extension was installed). Nothing to say about it.
    return null;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  void (async () => {
    const { target, reason } = await resolveContextTarget(info, tab, askPageForChannel);
    if (!target) {
      console.warn('[clearview] block channel: nothing to block —', reason);
      await report(tab?.id, unresolvableMessage(reason), { failure: true });
      return;
    }
    try {
      const { state, record } = await blockChannelFromTarget({ ...target, source: 'context-menu' });
      await report(tab?.id, describeBlock(record, state));
    } catch (error) {
      console.warn('[clearview] block channel failed:', error?.code ?? error?.message);
      await report(tab?.id, error?.message ?? 'Could not block that channel.', { failure: true });
    }
  })();
});

/**
 * Tell the page what just happened.
 *
 * The content script draws a toast; a context menu has no UI of its own, and a
 * silent block leaves the user unable to tell whether it worked.
 *
 * @returns {Promise<boolean>} whether the page could be told
 */
async function notifyUser(tabId, text) {
  if (typeof tabId !== 'number') return false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'channel/blockResult', text });
    return true;
  } catch {
    // No content script listening, which happens whenever the tab was loaded
    // before the extension was (re)loaded. The caller decides what to do.
    return false;
  }
}

/**
 * Report a FAILURE where the page cannot hear it.
 *
 * If a tab has no live content script, `notifyUser` fails too, and a right-click
 * that did nothing would produce no feedback anywhere — which is exactly the
 * experience this exists to prevent. The toolbar badge always exists, so it is
 * the backstop: an exclamation mark and the reason in the tooltip, cleared
 * shortly afterwards.
 *
 * Failures only. A SUCCESSFUL block is reported by the page's toast, and a badge
 * for it would be noise.
 */
async function flagFailure(message) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: `ClearView — ${message}` });
    setTimeout(() => {
      void chrome.action.setBadgeText({ text: '' });
      void chrome.action.setTitle({ title: 'ClearView' });
    }, 8000);
  } catch {
    // Nothing further to try; the console warning above is the record.
  }
}

/** Tell the page, and fall back to the badge when it cannot be told. */
async function report(tabId, text, { failure = false } = {}) {
  const told = await notifyUser(tabId, text);
  if (!told && failure) await flagFailure(text);
  return told;
}

/** "Blocked @handle" — the label the user will see in settings. */
function describeBlock(record, state) {
  const label = channelLabel(record) ?? 'that channel';
  // All THREE kinds of channel block count. Handles and ids are not the whole
  // list any more: a block made from a feed thumbnail is stored by the name the
  // card prints, and counting only the first two meant the toast said
  // "0 channels blocked" immediately after blocking one.
  const counts = state.bundleCounts;
  const total =
    (counts.channels ?? 0) + (counts.channelIds ?? 0) + (counts.channelNames ?? 0);
  return `Blocked ${label}. ${total} channel${total === 1 ? '' : 's'} blocked in ClearView.`;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RULES_ALARM, { periodInMinutes: 180 });
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RULES_ALARM) return;
  void syncGlobalRules({ force: false }).then(async (result) => {
    if (result.changed) await applyState();
  });
});

// A settings change (from any screen) re-derives the rules immediately, so the
// next navigation already sees the new state.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE.settings]) void applyState();
  if (area === 'local' && changes[STORAGE.globalRules]) void applyState();
});

void bootstrap();

// ── The state the UI reads ───────────────────────────────────────────────

async function describeState() {
  const state = await ensureState();
  const [stats, anonymousId, global] = await Promise.all([getStats(), getAnonymousId(), getGlobalRules()]);
  return {
    settings: state.settings,
    bundleCounts: {
      builtIn: state.bundle.builtIn.length,
      domains: state.bundle.domains.length,
      everywhere: state.bundle.everywhere.length,
      youtube: state.bundle.youtube.length,
      channels: state.bundle.channels.length,
      channelIds: state.bundle.channelIds.length,
      // A name-only block (a card that printed a channel name and no link) is a
      // channel block like any other, so the UI can count it as one.
      channelNames: state.bundle.channelNames.length,
    },
    // The block list as the UI shows it: normalized, de-duplicated, and with
    // the display names and origins the raw setting does not carry.
    blockedChannels: normalizeBlockedChannels(state.settings.blockedChannels),
    global: global
      ? {
          available: true,
          version: global.version,
          fetchedAt: global.fetchedAt,
          keywordCount: global.keywords.length,
          channelCount: global.channels.length,
          // The live VALUES, so the UI can tell an approved rule that is still
          // in force from one that has since been removed.
          liveKeywords: global.keywords.map((k) => k.keyword),
          liveChannels: global.channels.map((c) => c.handle),
        }
      : {
          available: false,
          version: null,
          fetchedAt: null,
          keywordCount: 0,
          channelCount: 0,
          liveKeywords: [],
          liveChannels: [],
        },
    stats,
    anonymousId,
  };
}

// ── Content-script rules ─────────────────────────────────────────────────

/**
 * The rules a content script needs, and nothing else.
 *
 * Deliberately narrow: only the YouTube-scoped keywords, the blocked channels
 * and the two toggles that change what a page looks like. The content script has
 * no business holding the user's blocked domains or their identity.
 */
async function rulesForContent() {
  const state = await ensureState();
  const { settings, bundle } = state;
  return {
    enabled: settings.protectionEnabled,
    brainBotEnabled: settings.brainBotEnabled,
    brainBotMode: settings.brainBotMode,
    blockShorts: settings.blockShorts,
    // An opaque fingerprint of everything above AND the rules themselves. The
    // page cannot see the rules, but it can see when they changed — which is
    // what tells it to judge already-judged feed cards again.
    revision: rulesFingerprint(settings, bundle),
    // Built-in terms plus the YouTube-scoped set: the app matches feed cards
    // against the always-on filter AND the user's YouTube keywords.
    keywords: bundle.youtube,
    builtIn: bundle.builtIn,
    // A COUNT, not the list. The content script needs to know whether there is
    // anything to filter a channel against — it does not need to know which
    // channels, because the matching stays in the worker.
    blockedChannelCount: bundle.channels.length + bundle.channelIds.length,
  };
}

// ── Admin session ────────────────────────────────────────────────────────

async function getAdminSession() {
  const stored = await chrome.storage.local.get(STORAGE.adminSession);
  return stored[STORAGE.adminSession] ?? null;
}

async function setAdminSession(session) {
  await chrome.storage.local.set({ [STORAGE.adminSession]: session });
}

async function clearAdminSession() {
  await chrome.storage.local.remove(STORAGE.adminSession);
}

/**
 * Run an admin request, refreshing the 10-minute access token once on a 401.
 *
 * The refresh happens HERE, in the worker, and the new tokens replace the stored
 * ones — so a long review session keeps working without the page ever seeing a
 * credential it could leak.
 */
async function adminCall(path, { method = 'GET', body, retry = true } = {}) {
  const session = await getAdminSession();
  if (!session?.accessToken) throw new ApiError('missing_token', 401, 'Sign in as an administrator.');
  const state = await ensureState();
  try {
    return await adminRequest(state.settings.apiBase, path, {
      method,
      body,
      token: session.accessToken,
    });
  } catch (error) {
    const expired = error instanceof ApiError && (error.status === 401 || error.code === 'invalid_token');
    if (!expired || !retry || !session.refreshToken) throw error;
    const refreshed = await adminRefresh(state.settings.apiBase, session.refreshToken);
    const next = {
      ...session,
      accessToken: refreshed.accessToken ?? refreshed.token ?? session.accessToken,
      refreshToken: refreshed.refreshToken ?? session.refreshToken,
      expiresAt: refreshed.expiresAt ?? null,
    };
    await setAdminSession(next);
    return adminCall(path, { method, body, retry: false });
  }
}

// ── Message router ───────────────────────────────────────────────────────

const handlers = {
  'state/get': async () => describeState(),

  'settings/update': async (message) => {
    await updateSettings(message.patch ?? {});
    await applyState();
    return describeState();
  },

  'rules/sync': async (message) => {
    const result = await syncGlobalRules({ force: message.force !== false });
    await applyState();
    return { result: { changed: result.changed, reason: result.reason, error: result.error ?? null }, state: await describeState() };
  },

  'rules/forContent': async () => rulesForContent(),

  /**
   * Judge a batch of YouTube feed cards.
   *
   * The content script sends what it can see (titles and channel names) and gets
   * back only the matching indexes, so the rule set and the matcher stay in the
   * worker and a page never holds either.
   */
  'feed/evaluate': async (message) => {
    const state = await ensureState();
    const cards = Array.isArray(message.cards) ? message.cards.slice(0, 120) : [];
    return { blocked: evaluateFeedCards(cards, state) };
  },

  'submission/create': async (message) => {
    const state = await ensureState();
    return submitSuggestion(state.settings.apiBase, {
      kind: message.kind,
      value: message.value,
      note: message.note ?? null,
      displayName: message.displayName ?? null,
      // Coerced to the backend's closed enum: the previous hard-coded
      // 'extension' is not one of its values, so every suggestion built that way
      // was refused with `invalid_request` before it was ever recorded.
      source: coerceSubmissionSource(message.source),
    });
  },

  /**
   * Block a channel.
   *
   * The content script and the UI both land here, so a channel blocked from the
   * ⋮ menu and one blocked in settings are indistinguishable afterwards.
   */
  'channel/block': async (message) => {
    // An explicit handle (the settings page's "add by handle" field) is taken as
    // given; everything else is a target to be resolved — the HREF the ⋮ menu and
    // the right-click menu can see, and the NAME a link-less card can see.
    if (message.handle) {
      const { state } = await blockChannel({
        handle: message.handle,
        channelId: message.channelId ?? null,
        name: message.name ?? null,
        source: message.source ?? 'manual',
      });
      return state;
    }

    const { state } = await blockChannelFromTarget({
      url: message.url ?? null,
      name: message.name ?? null,
      channelId: message.channelId ?? null,
      source: message.source ?? 'manual',
    });
    return state;
  },

  /**
   * Is this channel blocked? Answers WITHOUT acting.
   *
   * The ⋮ menu needs the answer to label itself — "Block" or "Unblock" — and
   * asking is what keeps the channel list itself out of the page.
   */
  'channel/status': async (message) => {
    const state = await ensureState();
    if (!state.settings?.protectionEnabled) return { blocked: false, matchedItem: null };
    const identity = channelIdentity({
      url: message.url ?? null,
      name: message.name ?? null,
      channelId: message.channelId ?? null,
    });
    const matched = isChannelBlocked(state.bundle, identity);
    return { blocked: Boolean(matched), matchedItem: matched ?? null };
  },

  'channel/unblock': async (message) => {
    const settings = (await ensureState()).settings;
    await updateSettings({ blockedChannels: removeBlockedChannel(settings.blockedChannels, message.label) });
    await applyState();
    return describeState();
  },

  /**
   * Is the channel on THIS page blocked?
   *
   * Asked by the content script, which is the only thing that can read the
   * channel off a video page — and, for a channel blocked by NAME, off a channel
   * page, whose URL carries only the handle. The redirect happens here rather
   * than there: a page cannot navigate itself to a `chrome-extension://` URL, and
   * keeping it here means a blocked channel lands on the same blocked page a
   * blocked website does, with the same reason-code discipline.
   */
  'channel/check': async (message, sender) => {
    const state = await ensureState();
    if (!state.settings?.protectionEnabled) return { blocked: false, matchedItem: null };

    const identity = channelIdentity({
      url: message.url ?? null,
      name: message.name ?? null,
      channelId: message.channelId ?? null,
    });
    const matched = isChannelBlocked(state.bundle, identity);
    if (!matched) return { blocked: false, matchedItem: null };

    const applied = await blockTab(sender?.tab?.id, 'channel');
    return { blocked: true, matchedItem: matched, applied };
  },

  'submissions/list': async () => {
    const state = await ensureState();
    return { submissions: await fetchSubmissions(state.settings.apiBase), endpoint: BRAINROT.submissions };
  },

  'report/create': async (message) => {
    const state = await ensureState();
    return reportTarget(state.settings.apiBase, {
      kind: message.kind,
      value: message.value,
      detail: message.detail ?? null,
    });
  },

  'stats/reset': async () => {
    await resetStats();
    return describeState();
  },

  'admin/login': async (message) => {
    const state = await ensureState();
    const result = await adminLogin(state.settings.apiBase, message.email, message.password);
    const session = {
      accessToken: result.accessToken ?? result.token,
      refreshToken: result.refreshToken ?? null,
      admin: result.admin ?? null,
      signedInAt: Date.now(),
    };
    await setAdminSession(session);
    return { admin: session.admin };
  },

  'admin/session': async () => {
    const session = await getAdminSession();
    return session ? { admin: session.admin ?? null } : { admin: null };
  },

  'admin/logout': async () => {
    const session = await getAdminSession();
    if (session?.refreshToken) {
      const state = await ensureState();
      await adminLogout(state.settings.apiBase, session.refreshToken).catch(() => {});
    }
    await clearAdminSession();
    return { admin: null };
  },

  'admin/request': async (message) => adminCall(message.path, { method: message.method, body: message.body }),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  // `sender` is passed through because a handler that acts on the TAB (the
  // video-page channel check) has no other way to know which tab asked.
  handler(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: {
          code: error?.code ?? 'unknown_error',
          status: error?.status ?? 0,
          message: error?.message ?? 'Something went wrong.',
        },
      });
    });
  return true; // keep the channel open for the async reply
});
