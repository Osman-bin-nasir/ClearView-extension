/**
 * Global rule synchronization.
 *
 * The properties that matter, carried over from the Android app's
 * `GlobalRulesStore`:
 *
 *  - **A failed refresh never weakens protection.** The previous snapshot is
 *    left exactly as it was, so the extension blocks everything it blocked
 *    before. There is no path that empties the blocklist because a request did
 *    not complete.
 *  - **An unchanged rule set is not rewritten.** The server's `version` is a
 *    content fingerprint, so a refresh that finds the same version only bumps
 *    the timestamp.
 *  - **A TTL bounds how often the network is touched**, and a manual "check for
 *    updates" can force past it.
 */

import { fetchRules } from './api.js';
import { getGlobalRules, getSettings, saveGlobalRules } from '../common/settings.js';

/** In-flight refresh, so two callers share one request. */
let inFlight = null;

/**
 * Refresh the cached global rules.
 *
 * @returns {Promise<{changed: boolean, snapshot: object|null, reason: string, error?: string}>}
 */
export async function syncGlobalRules({ force = false } = {}) {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const [settings, cached] = await Promise.all([getSettings(), getGlobalRules()]);
    const ttl = Number(settings.rulesTtlMs) || 0;
    const fresh = cached && Date.now() - (cached.fetchedAt ?? 0) < ttl;

    if (!force && fresh) {
      return { changed: false, snapshot: cached, reason: 'fresh' };
    }

    try {
      const snapshot = await fetchRules(settings.apiBase);
      if (cached && snapshot.version && snapshot.version === cached.version) {
        const merged = { ...cached, fetchedAt: Date.now() };
        await saveGlobalRules(merged);
        return { changed: false, snapshot: merged, reason: 'unchanged' };
      }
      await saveGlobalRules(snapshot);
      return { changed: true, snapshot, reason: 'updated' };
    } catch (error) {
      // Kept, not cleared: the caller keeps enforcing the previous snapshot.
      return { changed: false, snapshot: cached, reason: 'failed', error: error?.code ?? 'unknown' };
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
