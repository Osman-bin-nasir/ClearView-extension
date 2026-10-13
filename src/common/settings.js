/**
 * Storage access, in one place.
 *
 * Two areas, split by nature: `sync` for settings (small, and a user who signs
 * Chrome in on a second machine expects their rules to follow), `local` for
 * caches and device identity (the rules snapshot is large and the anonymous id
 * is per-install — syncing either would be wrong).
 *
 * Every read falls back to the defaults, so a fresh install, a wiped profile and
 * a partially-written store all behave identically: nothing throws, and the same
 * protections are on.
 */

import { DEFAULT_SETTINGS, STORAGE } from './constants.js';

function hasChrome() {
  return typeof chrome !== 'undefined' && chrome.storage;
}

/** Read one key, falling back to a default. */
export async function readLocal(key, fallback = null) {
  if (!hasChrome()) return fallback;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? fallback;
}

export async function writeLocal(key, value) {
  if (!hasChrome()) return;
  await chrome.storage.local.set({ [key]: value });
}

/**
 * The merged settings: stored values over the defaults.
 *
 * Read via `get(null)` rather than by key so an added setting is present on an
 * install that predates it — a key-by-key read would return the new setting
 * undefined until the user touched it.
 */
export async function getSettings() {
  if (!hasChrome()) return { ...DEFAULT_SETTINGS };
  const stored = await chrome.storage.sync.get(STORAGE.settings);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE.settings] ?? {}) };
}

/** Merge a patch into the stored settings and return the new full settings. */
export async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (hasChrome()) await chrome.storage.sync.set({ [STORAGE.settings]: next });
  return next;
}

/** The cached global rules snapshot, or null when none has ever been stored. */
export async function getGlobalRules() {
  const snapshot = await readLocal(STORAGE.globalRules, null);
  if (!snapshot || !snapshot.version) return null;
  return snapshot;
}

export async function saveGlobalRules(snapshot) {
  await writeLocal(STORAGE.globalRules, snapshot);
}

/**
 * The anonymous contributor id, generated once per install.
 *
 * Deliberately a random UUID and nothing derived from the device: it exists only
 * because this extension made it up, which is what lets the UI honestly call
 * contributions anonymous. It can be regenerated at any time at the cost of at
 * most a duplicate report.
 */
export async function getAnonymousId() {
  const existing = await readLocal(STORAGE.anonymousId, null);
  if (isUuid(existing)) return existing;
  const fresh = crypto.randomUUID();
  await writeLocal(STORAGE.anonymousId, fresh);
  return fresh;
}

export async function regenerateAnonymousId() {
  const fresh = crypto.randomUUID();
  await writeLocal(STORAGE.anonymousId, fresh);
  return fresh;
}

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Local protection counters ({ total, byKeyword, byReason, lastAt }). */
export async function getStats() {
  return readLocal(STORAGE.stats, { total: 0, byReason: {}, lastAt: null });
}

export async function bumpStats(reason, detail) {
  const stats = await getStats();
  const next = {
    total: (stats.total ?? 0) + 1,
    lastAt: Date.now(),
    byReason: { ...(stats.byReason ?? {}) },
    recent: Array.isArray(stats.recent) ? stats.recent : [],
  };
  const key = reason ?? 'unknown';
  next.byReason[key] = (next.byReason[key] ?? 0) + 1;
  if (detail) {
    next.recent.unshift({ reason: key, detail: String(detail).slice(0, 120), at: Date.now() });
    next.recent = next.recent.slice(0, 20);
  }
  await writeLocal(STORAGE.stats, next);
  return next;
}

export async function resetStats() {
  await writeLocal(STORAGE.stats, { total: 0, byReason: {}, lastAt: null, recent: [] });
}

/** Subscribe to settings changes. Returns an unsubscribe function. */
export function onSettingsChanged(callback) {
  if (!hasChrome()) return () => {};
  const listener = (changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    if (area === 'sync' && changes[STORAGE.settings]) callback();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
