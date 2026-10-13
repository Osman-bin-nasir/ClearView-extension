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

import { BRAINROT, STORAGE } from '../common/constants.js';
import {
  bumpStats,
  getAnonymousId,
  getGlobalRules,
  getStats,
  regenerateAnonymousId,
  resetStats,
  updateSettings,
} from '../common/settings.js';
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
import { evaluateFeedCards, installDomainRules, initBlocker } from './blocking.js';
import { syncGlobalRules } from './rules-sync.js';
import { ensureState, refreshState } from './state.js';

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
    },
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
    // Built-in terms plus the YouTube-scoped set: the app matches feed cards
    // against the always-on filter AND the user's YouTube keywords.
    keywords: bundle.youtube,
    builtIn: bundle.builtIn,
    channels: bundle.channels,
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
      source: 'extension',
    });
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

  'identity/regenerate': async () => {
    await regenerateAnonymousId();
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message)
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
