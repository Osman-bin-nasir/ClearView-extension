/**
 * The service worker's live view of the world.
 *
 * One place holds the current settings and the effective rule bundle, so the
 * blocking path never re-reads storage on a navigation — and so a change made in
 * the UI is applied to the very next navigation rather than the next restart.
 */

import { getGlobalRules, getSettings } from '../common/settings.js';
import { buildRuleBundle } from '../common/rules-bundle.js';

let state = {
  settings: null,
  global: null,
  bundle: null,
  ready: false,
};

/** Re-read settings + cached rules and rebuild the bundle. */
export async function refreshState() {
  const [settings, global] = await Promise.all([getSettings(), getGlobalRules()]);
  state = {
    settings,
    global,
    bundle: buildRuleBundle(settings, global),
    ready: true,
  };
  return state;
}

/** The current state, loading it first if this is the first call. */
export async function ensureState() {
  if (!state.ready) await refreshState();
  return state;
}

export function currentState() {
  return state;
}
