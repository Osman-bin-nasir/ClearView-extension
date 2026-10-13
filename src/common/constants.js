/**
 * Shared constants: storage keys, setting defaults, and the backend base.
 *
 * Kept in one module so the popup, the options page and the service worker all
 * agree on where a setting lives — a key spelled two ways is a setting that
 * silently works in one screen and not the other.
 */

/**
 * The deployed ClearView backend — the SAME server the Android app uses. The
 * shared blocklist, the review queue and the moderation API all live there, and
 * pointing the extension anywhere else would split the community in two. It is
 * overridable from the options page for local development.
 */
export const DEFAULT_API_BASE = 'https://clearview-1neb.onrender.com';

/** Brain Rot endpoints, on the backend's public/anonymous surface. */
export const BRAINROT = Object.freeze({
  rules: '/api/v1/brainrot/rules',
  suggestions: '/api/v1/brainrot/suggestions',
  submissions: '/api/v1/brainrot/submissions',
  reports: '/api/v1/brainrot/reports',
});

/** Admin endpoints, all behind a bearer token the server re-checks. */
export const ADMIN = Object.freeze({
  login: '/admin/api/auth/login',
  refresh: '/admin/api/auth/refresh',
  logout: '/admin/api/auth/logout',
  me: '/admin/api/auth/me',
  dashboard: '/admin/api/brainrot/dashboard',
  submissions: '/admin/api/brainrot/submissions',
  review: (id) => `/admin/api/brainrot/submissions/${id}/review`,
  keywords: '/admin/api/brainrot/keywords',
  keywordStatus: (id) => `/admin/api/brainrot/keywords/${id}/status`,
  keywordDelete: (id) => `/admin/api/brainrot/keywords/${id}`,
  channels: '/admin/api/brainrot/channels',
  channelStatus: (id) => `/admin/api/brainrot/channels/${id}/status`,
  channelDelete: (id) => `/admin/api/brainrot/channels/${id}`,
  reports: '/admin/api/brainrot/reports',
  resolveReport: '/admin/api/brainrot/reports/resolve',
});

/** chrome.storage areas, by what each holds. */
export const STORAGE = Object.freeze({
  /** Settings — synced across the user's own Chrome profiles. */
  settings: 'cv.settings',
  /** Cached global rules + their version/timestamp (local: a per-device cache). */
  globalRules: 'cv.globalRules',
  /** The generated anonymous contributor id. */
  anonymousId: 'cv.anonymousId',
  /** Local protection counters, for the Block tab's activity card. */
  stats: 'cv.stats',
  /** Admin bearer/refresh tokens and identity. Never a bundled secret. */
  adminSession: 'cv.adminSession',
  /**
   * The local protection password record (salt + PBKDF2 hash). Local, never
   * synced: it is a lock on THIS device, and a credential has no business
   * travelling to another machine with the settings.
   */
  password: 'cv.password',
  /** Whether the first-run password offer has been answered (create or skip). */
  onboarded: 'cv.onboarded',
});

/**
 * Every setting, with its default.
 *
 * Defaults deliberately mirror the Android app: protection on, Strict Mode off,
 * Shorts control off, Brain Rot off. "Off by default" matters for the two
 * content controls — they change what the user sees, and enabling them silently
 * on install would be a surprise.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Master switch. Off means the extension blocks nothing at all. */
  protectionEnabled: true,
  /** Tier 2 discovery terms (bikini, lingerie, ...). */
  strictMode: false,
  /** Hide the YouTube Shorts entry point. Never blocks Shorts URLs. */
  blockShorts: false,
  /**
   * Strip YouTube ads: network ad requests are refused, the ad slots are removed
   * from the page, and a video ad is skipped where YouTube allows it. On by
   * default, because it is the one control that only ever removes something the
   * user did not ask to see.
   */
  blockYoutubeAds: true,
  /** Brain Bot (Brain Rot) protection on YouTube feeds. */
  brainBotEnabled: false,
  /** 'remove' hides matching cards; 'overlay' covers them in place. */
  brainBotMode: 'overlay',
  /** Keywords that apply to YouTube content only. */
  youtubeKeywords: [],
  /** Keywords that apply to every page and search. */
  userKeywords: [],
  /** User-blocked hostnames. */
  blockedDomains: [],
  /** User-blocked channels: [{ handle, name }]. */
  blockedChannels: [],
  /** Backend base URL. */
  apiBase: DEFAULT_API_BASE,
  /** How long a cached rules snapshot may be used before a refresh (ms). */
  rulesTtlMs: 6 * 60 * 60 * 1000,
});

/**
 * The Brain Bot display modes, in the order the UI offers them.
 *
 * Mutually exclusive by construction: a single enum stored once, so "remove"
 * and "overlay" can never both be active.
 */
export const BRAIN_BOT_MODES = Object.freeze([
  {
    value: 'remove',
    label: 'Remove from feed',
    description: 'Matching videos are removed from supported YouTube feeds.',
  },
  {
    value: 'overlay',
    label: 'Show protection overlay',
    description: 'Matching videos stay in place, covered by a ClearView overlay.',
  },
]);

/**
 * The `source` values the backend's submission schema accepts.
 *
 * It is a closed enum server-side and the request body is `.strict()`, so an
 * invented value is not quietly recorded as "unknown" — it is refused with
 * `invalid_request`. The extension therefore sends one of these, and this list
 * exists so the client and the server's schema cannot drift apart silently.
 */
export const SUBMISSION_SOURCES = Object.freeze(['youtube_not_interested', 'app', 'unknown']);

/** What a suggestion is labelled when nothing more specific is true. */
export const DEFAULT_SUBMISSION_SOURCE = 'unknown';

/** Coerce anything to a source the backend will accept. */
export function coerceSubmissionSource(value) {
  return SUBMISSION_SOURCES.includes(value) ? value : DEFAULT_SUBMISSION_SOURCE;
}

/**
 * The YouTube ad blocking surface.
 *
 * Kept next to the other constants so the content script, the ruleset file and
 * the tests all name the same ruleset id — a typo in either would leave the
 * toggle looking on while nothing is blocked, which is the one failure mode that
 * cannot be seen from the UI.
 */
export const AD_RULESET_ID = 'youtube_ads';

/** How long a password must be, and the hashing parameters it is stored with. */
export const PASSWORD = Object.freeze({
  minLength: 4,
  maxLength: 128,
  iterations: 120_000,
  algorithm: 'PBKDF2-SHA256',
});

/** The submission statuses the backend can return, plus the derived "removed". */
export const SUBMISSION_STATUS = Object.freeze({
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  under_review: 'Under review',
  removed: 'Removed',
});
