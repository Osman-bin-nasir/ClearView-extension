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

import { AD_RULESET_ID } from '../common/constants.js';
import { MatchType, checkString } from '../common/matching.js';
import { isShortsUrl, parseSearchUrl, safeSearchDestination } from '../common/search-engines.js';
import { channelIdentity, matchBlockedChannel, parseChannelUrl } from '../common/channels.js';

const BLOCKED_PAGE_PATH = 'src/blocked/blocked.html';

/**
 * The blocked-channel rule lists, as Sets.
 *
 * Cached against the BUNDLE rather than rebuilt per call, because the feed
 * evaluator runs on every DOM mutation of a YouTube page with up to 120 cards.
 * A WeakMap keyed on the bundle is safe by construction: the bundle is replaced
 * wholesale whenever settings or the shared list change, so a stale entry cannot
 * outlive the rules it was built from.
 */
const channelSetCache = new WeakMap();

function blockedChannelSets(bundle) {
  let sets = channelSetCache.get(bundle);
  if (!sets) {
    sets = {
      channels: new Set(bundle?.channels ?? []),
      channelIds: new Set(bundle?.channelIds ?? []),
      // The displayed names, so a card that carries no channel link can still be
      // matched — see `matchBlockedChannel` and the current grid's markup.
      channelNames: new Set(bundle?.channelNames ?? []),
    };
    channelSetCache.set(bundle, sets);
  }
  return sets;
}

/**
 * Does this channel identity match the blocked channels in force?
 *
 * Exported because the SAME question is asked from three places: a channel URL
 * (here), a feed card (here), and the channel shown on a video page (the
 * content script, which asks the worker). One implementation, so the three
 * cannot disagree about what "this channel is blocked" means.
 *
 * @returns {string|null} the label that matched, for display
 */
export function isChannelBlocked(bundle, identity) {
  if (!bundle) return null;
  return matchBlockedChannel(blockedChannelSets(bundle), identity);
}

/** The extension's own blocked page, for a reason code. */
function blockedPageUrl(reason) {
  return chrome.runtime.getURL(`${BLOCKED_PAGE_PATH}?reason=${encodeURIComponent(reason)}`);
}

/**
 * Send a tab to the blocked page.
 *
 * A content script CANNOT do this itself: it cannot navigate a page to a
 * `chrome-extension://` URL that is not a web-accessible resource, and making
 * the blocked page web-accessible just to allow it would expose it to every site
 * on the web. The redirect therefore lives in the worker, and a blocked channel
 * reached from a video page lands on exactly the same page as a blocked website.
 */
export async function blockTab(tabId, reason = 'channel') {
  if (typeof tabId !== 'number') return false;
  try {
    await chrome.tabs.update(tabId, { url: blockedPageUrl(reason) });
    return true;
  } catch (error) {
    console.warn('[clearview] could not redirect the tab:', error?.message);
    return false;
  }
}

/** DNR rule ids are positive integers; we own the low block for domain rules. */
const DOMAIN_RULE_ID_BASE = 1;

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

  // 0. Block Shorts when the Shorts control is on — the same behaviour as the
  //    Android app's `blockShorts`, which blocks any YouTube /shorts URL. The
  //    content script separately hides the entry point; this is what stops a
  //    Short being reached by its own link, so the toggle cannot be walked
  //    around by pasting a URL.
  if (settings.blockShorts && isShortsUrl(url)) {
    return { action: 'block', matchedItem: 'YouTube Shorts', matchType: MatchType.BUILT_IN_KEYWORD, reason: 'shorts' };
  }

  // 0b. A YouTube CHANNEL page whose channel the user blocked. The identity is
  //     in the URL here (`/@handle`, `/channel/UC…`), which is what makes this
  //     checkable without loading anything. A video page carries no channel in
  //     its URL, so that half is decided by the content script, which can read
  //     the channel off the page.
  const channel = parseChannelUrl(url);
  if (channel) {
    const matched = isChannelBlocked(bundle, channel);
    if (matched) {
      return { action: 'block', matchedItem: matched, matchType: MatchType.CHANNEL, reason: 'channel' };
    }
  }

  // 1. Searching is checked BEFORE the URL, because a search-results URL
  //    contains the query: without this order, a blocked search would be
  //    reported as a blocked page. The app draws the same distinction.
  //
  //    The query is read on EVERY site, not only on the named engines, so the
  //    phrase tier applies wherever it is typed — see `parseSearchUrl`. The
  //    keyword set is the same one the URL check uses, so the two cannot
  //    disagree about what the user blocked.
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

// ── DNR ad rules ─────────────────────────────────────────────────────────

/**
 * Turn the YouTube ad network ruleset on or off.
 *
 * The ad rules live in a STATIC ruleset (declared in the manifest, shipped as a
 * file) rather than in JS, because that is what MV3 wants: a fixed list of ad
 * hosts, evaluated by the browser before a request is made, with no script able
 * to forget to run. The toggle only flips the ruleset's enabled state, so
 * turning ad blocking off cannot leave a stray rule behind and turning it on
 * cannot half-apply.
 *
 * The ruleset is scoped (in its own conditions) to requests that ORIGINATE on
 * YouTube, so it can never touch the same ad network on an unrelated site.
 *
 * @returns {Promise<boolean>} whether the ruleset is now in the requested state
 */
export async function installAdRules(enabled) {
  if (!chrome.declarativeNetRequest?.updateEnabledRulesets) return false;
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      enabled ? { enableRulesetIds: [AD_RULESET_ID] } : { disableRulesetIds: [AD_RULESET_ID] }
    );
    return true;
  } catch (error) {
    // Not fatal, but worth a record: the toggle promises something that would
    // not be happening, and the console is where that is visible.
    console.warn('[clearview] could not update the ad ruleset:', error?.message);
    return false;
  }
}

// ── Navigation evaluation ────────────────────────────────────────────────

/**
 * Per-tab record of the last redirect we issued, keyed by tab id.
 *
 * What this guards is the pathological case: a redirect target that is itself
 * blocked (a user keyword could match the redirect URL). The target is remembered
 * so the same tab is not bounced to it twice in a row.
 *
 * Back off the blocked page is NOT this guard's business any more: the blocked
 * page answers it itself, by leaving for YouTube's home page rather than
 * re-requesting the address that was blocked.
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

  // A search goes to a search destination, chosen by WHERE the search was made:
  // on YouTube the user keeps YouTube (its home page), everywhere else the
  // Google safe page. Neither carries the blocked query.
  const target = decision.action === 'search'
    ? safeSearchDestination(decision.engine)
    : blockedPageUrl(decision.reason ?? reasonFor(decision.matchType));

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
    case MatchType.CHANNEL:
      return 'channel';
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
 * The two halves answer to different switches, and that is deliberate. A
 * channel the user blocked BY HAND is filtered whenever Protection is on: the
 * Brain Bot toggle filters keyword matches, and letting it also decide whether an
 * explicit block applies would mean a channel the user blocked kept appearing
 * because a switch with a different job happened to be off. Everything else —
 * titles, and suggestive channel NAMES from the built-in filters — is what the
 * Brain Bot toggle is for.
 *
 * @param {Array<{title?: string, channel?: string, channelUrl?: string}>} cards
 * @returns {Array<{index: number, matchedItem: string, via: string}>}
 */
export function evaluateFeedCards(cards, state) {
  const { settings, bundle } = state;
  const blocked = [];
  if (!settings?.protectionEnabled || !bundle) return blocked;

  const { channels: blockedChannels, channelIds, channelNames } = blockedChannelSets(bundle);
  const hasChannelRules = blockedChannels.size > 0 || channelIds.size > 0 || channelNames.size > 0;
  const filtersOn = Boolean(settings.brainBotEnabled);

  cards.forEach((card, index) => {
    if (hasChannelRules) {
      // The channel's own LINK is preferred over its printed name, because the
      // link is YouTube's own claim about which channel this is — but the
      // current grid gives no link, and then the NAME is what matches.
      const identity = channelIdentity({
        url: typeof card?.channelUrl === 'string' ? card.channelUrl : null,
        name: typeof card?.channel === 'string' ? card.channel : null,
      });
      const matched = matchBlockedChannel({ channels: blockedChannels, channelIds, channelNames }, identity);
      if (matched) {
        blocked.push({ index, matchedItem: matched, via: 'channel' });
        return;
      }
    }

    if (!filtersOn) return;

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

    const channelVerdict = checkString(channel, { isUrl: false, builtIn: bundle.builtIn, userKeywords: [] });
    if (channelVerdict.blocked) {
      blocked.push({ index, matchedItem: channelVerdict.matchedItem, via: 'channel' });
    }
  });

  return blocked;
}

/**
 * Install the navigation listeners.
 *
 * Guarded because the worker can start more than once in a session
 * (`onInstalled`, `onStartup`, and the top-level boot all fire), and each call
 * would otherwise add another listener — so one navigation would be evaluated
 * two or three times.
 *
 * TWO events, ONE evaluation, and the second one is not a detail:
 * `onBeforeNavigate` is a navigation that REPLACES the document, while
 * `onHistoryStateUpdated` is a navigation that does not — the page changed the
 * address itself with `history.pushState`. Modern sites search that way: typing
 * in YouTube's own search box never leaves the document, so it fires no
 * navigation event at all, and a listener that only knew `onBeforeNavigate`
 * never saw the query. That is what "I searched it and nothing happened" was:
 * the URL was right, the rules matched, and nothing ever asked.
 *
 * Both events hand the handler the same details shape, so both go through the
 * same evaluation rather than a second, quietly-diverging copy of it.
 */
let blockerInstalled = false;

export function initBlocker({ getState, onBlocked }) {
  if (blockerInstalled) return;
  blockerInstalled = true;

  const evaluate = async (details) => {
    // Loaded here rather than before registration: a just-woken worker has no
    // state yet, and skipping the event because state was not ready would drop
    // exactly the navigation that woke it.
    const state = await getState();
    if (!state?.ready) return;
    const outcome = await handleNavigation(details, state);
    if (outcome.action !== 'allow' && outcome.applied) {
      onBlocked?.(outcome, details.url);
    }
  };

  chrome.webNavigation.onBeforeNavigate.addListener(evaluate);
  // …and the same-document half, without which a search typed into a site's own
  // search box is never evaluated.
  chrome.webNavigation.onHistoryStateUpdated.addListener(evaluate);
}

export { BLOCKED_PAGE_PATH };
