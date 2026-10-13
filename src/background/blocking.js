/**
 * URL-level blocking.
 *
 * Two mechanisms, chosen for what each is good at:
 *
 *  1. **declarativeNetRequest** for blocked HOSTS. A domain rule is a set
 *     membership test, it is what DNR exists for, and it stops the request
 *     before a byte is fetched — so an adult site never even loads a flash of
 *     content.
 *  2. **A navigation evaluator** for everything that needs real string work:
 *     keywords inside a URL and the user's own search query. These need the
 *     app's normalization and whole-word rules, which a DNR `urlFilter` cannot
 *     express, and doing them in JS keeps the extension's behaviour identical to
 *     the phone's rather than "close enough".
 *
 * Both consult the same bundle, so they cannot disagree about what is blocked.
 */

import { MatchType, checkString } from '../common/matching.js';
import { SAFE_SEARCH_DESTINATION, parseSearchUrl } from '../common/search-engines.js';

const BLOCKED_PAGE_PATH = 'src/blocked/blocked.html';

/** DNR rule ids are positive integers; we own the low block for domain rules. */
const DOMAIN_RULE_ID_BASE = 1;

function blockedPageUrl(reason) {
  return chrome.runtime.getURL(`${BLOCKED_PAGE_PATH}?reason=${encodeURIComponent(reason)}`);
}

/**
 * Decide what to do with a URL. Pure, so it can be unit-tested.
 *
 * @returns {{action:'allow'}}
 *        | {{action:'search', engine:string, matchedItem:string}}
 *        | {{action:'block', matchedItem:string, matchType:string}}
 */
export function evaluateUrl(url, state) {
  const { settings, bundle } = state;
  if (!settings?.protectionEnabled) return { action: 'allow' };
  if (!bundle) return { action: 'allow' };

  const { builtIn, domains, everywhere } = bundle;

  // 1. Searching is checked BEFORE the URL, because a search-results URL
  //    contains the query: without this order, a blocked search would be
  //    reported as a blocked page. The app draws the same distinction.
  const search = parseSearchUrl(url);
  if (search) {
    const verdict = checkString(search.query, {
      isUrl: false,
      builtIn,
      userKeywords: everywhere,
      domains,
    });
    if (verdict.blocked) {
      return { action: 'search', engine: search.engine, matchedItem: verdict.matchedItem };
    }
  }

  // 2. The URL itself: a blocked host is handled by DNR, but a keyword in the
  //    path or query is caught here. Combination terms are excluded for URLs by
  //    checkString (isUrl), so a path like /photos/beach.html cannot trip it.
  const urlVerdict = checkString(url, {
    isUrl: true,
    builtIn,
    userKeywords: everywhere,
    domains,
  });
  if (urlVerdict.blocked) {
    return { action: 'block', matchedItem: urlVerdict.matchedItem, matchType: urlVerdict.matchType };
  }

  return { action: 'allow' };
}

// ── DNR host rules ───────────────────────────────────────────────────────

/**
 * Replace the dynamic DNR rules with one redirect rule per blocked host.
 *
 * `requestDomains` matches a domain AND its subdomains, so one entry covers
 * "www.x.com" and "m.x.com". The action is a redirect to the extension's blocked
 * page rather than a bare `block`, because a bare block shows Chrome's own error
 * page, which explains nothing to the person who hit it.
 */
export async function installDomainRules(domains) {
  if (!chrome.declarativeNetRequest) return;
  const list = [...new Set(domains ?? [])].filter((d) => typeof d === 'string' && d.length > 2);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);
  const addRules = list.map((domain, index) => ({
    id: DOMAIN_RULE_ID_BASE + index,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { extensionPath: `/${BLOCKED_PAGE_PATH}?reason=domain` },
    },
    condition: { requestDomains: [domain], resourceTypes: ['main_frame'] },
  }));

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (error) {
    // Not fatal: the navigation evaluator still catches these hosts in JS (its
    // domain check uses the same list). Logged so a rules mismatch is visible.
    console.warn('[clearview] could not install domain rules:', error?.message);
  }
}

// ── Navigation evaluation ────────────────────────────────────────────────

/**
 * Per-tab record of the last redirect we issued, keyed by tab id.
 *
 * A blocked page offers "Go back", and going back to the blocked URL is
 * redirected again — that is intended. What this guards is the pathological
 * case: a redirect target that is itself blocked (a user keyword could match the
 * redirect URL). The target is remembered so the same tab is not bounced to it
 * twice in a row.
 */
const lastRedirect = new Map();

function isOwnPage(url) {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL(''));
}

/**
 * Handle one navigation. Returns the outcome (for tests/logging) and applies the
 * redirect when a redirect is warranted.
 */
export async function handleNavigation(details, state) {
  if (details.frameId !== 0) return { action: 'allow' };
  if (isOwnPage(details.url)) return { action: 'allow' };

  const decision = evaluateUrl(details.url, state);
  if (decision.action === 'allow') return decision;

  const target = decision.action === 'search'
    ? SAFE_SEARCH_DESTINATION
    : blockedPageUrl(decision.action === 'block' ? reasonFor(decision.matchType) : 'search');

  const previous = lastRedirect.get(details.tabId);
  if (previous && previous.target === target && Date.now() - previous.at < 1000) {
    return { ...decision, applied: false };
  }

  try {
    await chrome.tabs.update(details.tabId, { url: target });
    lastRedirect.set(details.tabId, { target, at: Date.now() });
  } catch (error) {
    console.warn('[clearview] redirect failed:', error?.message);
    return { ...decision, applied: false };
  }
  return { ...decision, applied: true, target };
}

/** A short, non-explicit reason label for the blocked page. */
function reasonFor(matchType) {
  switch (matchType) {
    case MatchType.DOMAIN:
      return 'domain';
    case MatchType.BUILT_IN_KEYWORD:
      return 'keyword';
    case MatchType.USER_KEYWORD:
      return 'your-keyword';
    case MatchType.GLOBAL_KEYWORD:
      return 'shared-keyword';
    default:
      return 'blocked';
  }
}

/**
 * Decide which feed cards are Brain Bot content.
 *
 * The same evaluation the app runs over a YouTube feed card, reused here rather
 * than reimplemented in the content script:
 *
 *  - the TITLE is checked against the built-in filters and the user's
 *    YouTube-scoped keywords, and a match is a hard block (a title describes the
 *    video, so it is trustworthy on its own);
 *  - the CHANNEL is matched against the user's blocked channels and the
 *    built-in filters (a suggestive channel can be the only signal a deceptive
 *    video gives).
 *
 * Runs here, in the worker, so a browser page never needs the rule set — the
 * content script sends titles and receives verdicts.
 *
 * @param {Array<{title?: string, channel?: string}>} cards
 * @returns {Array<{index: number, matchedItem: string, via: string}>}
 */
export function evaluateFeedCards(cards, state) {
  const { settings, bundle } = state;
  const blocked = [];
  if (!settings?.protectionEnabled || !settings?.brainBotEnabled || !bundle) return blocked;

  const channelSet = new Set(bundle.channels);

  cards.forEach((card, index) => {
    const title = (card?.title ?? '').trim();
    if (title !== '') {
      const verdict = checkString(title, {
        isUrl: false,
        builtIn: bundle.builtIn,
        userKeywords: bundle.youtube,
      });
      if (verdict.blocked) {
        blocked.push({ index, matchedItem: verdict.matchedItem, via: 'title' });
        return;
      }
    }

    const channel = (card?.channel ?? '').trim();
    if (channel === '') return;

    const handle = '@' + channel.toLowerCase().replace(/^@+/, '').replace(/\s+/g, '');
    if (channelSet.has(handle)) {
      blocked.push({ index, matchedItem: handle, via: 'channel' });
      return;
    }

    const channelVerdict = checkString(channel, { isUrl: false, builtIn: bundle.builtIn, userKeywords: [] });
    if (channelVerdict.blocked) {
      blocked.push({ index, matchedItem: channelVerdict.matchedItem, via: 'channel' });
    }
  });

  return blocked;
}

/**
 * Install the navigation listener.
 *
 * Guarded because the worker can start more than once in a session
 * (`onInstalled`, `onStartup`, and the top-level boot all fire), and each call
 * would otherwise add another listener — so one navigation would be evaluated
 * two or three times.
 */
let blockerInstalled = false;

export function initBlocker({ getState, onBlocked }) {
  if (blockerInstalled) return;
  blockerInstalled = true;
  chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    const state = getState();
    if (!state?.ready) return;
    const outcome = await handleNavigation(details, state);
    if (outcome.action !== 'allow' && outcome.applied) {
      onBlocked?.(outcome, details.url);
    }
  });
}

export { BLOCKED_PAGE_PATH };
