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

/** The submission statuses the backend can return, plus the derived "removed". */
export const SUBMISSION_STATUS = Object.freeze({
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  under_review: 'Under review',
  removed: 'Removed',
});
