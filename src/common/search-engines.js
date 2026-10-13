/**
 * Search-engine URL parsing.
 *
 * Explicit-search blocking needs two things the URL alone does not give: which
 * engine this is, and the user's query. Both are read here so the background
 * worker can decide and redirect in one place.
 *
 * The query is now read on EVERY site, not only on the named engines. The named
 * engines were the whole feature once, and that was the bug: their search URL
 * was judged with the FULL rules — including the phrase tier, where "woman"
 * plus "bikini" blocks although neither half blocks alone — while every other
 * site only got the URL-level check, which deliberately skips that tier. The
 * same typed phrase was therefore blocked on Google and let through on a Reddit
 * or Amazon search. One technique, so it is applied in one place.
 *
 * What keeps that from breaking ordinary pages is that the query is only read
 * out of parameters that MEAN a search (see `SEARCH_QUERY_PARAMS`), only the
 * value is judged, and a value that is an address rather than a query is left
 * alone (see `looksLikeAddress`).
 */

/** The safe destination for a blocked search: Google, with NO query carried over. */
export const SAFE_SEARCH_DESTINATION = 'https://www.google.com/webhp?safe=active';

/** YouTube's home page: where a blocked YOUTUBE search lands. */
export const YOUTUBE_HOME = 'https://www.youtube.com/';

/**
 * Where a blocked search is sent.
 *
 * A search made ON YouTube goes back to YouTube's home page, not to Google. The
 * user was on YouTube and searched there; emptying them out onto a different site
 * answers a question they did not ask, and it is the one destination that reads
 * as "stay where you are, without that search". Every other site keeps the Google
 * safe page, which is where the app has always sent them.
 *
 * Neither destination carries the query — see `handleNavigation`.
 */
export function safeSearchDestination(engine) {
  return engine === 'youtube' ? YOUTUBE_HOME : SAFE_SEARCH_DESTINATION;
}

/**
 * The query parameters that mean "a search was typed here".
 *
 * The list is what keeps the generic scan honest. An arbitrary parameter on an
 * unknown page is not evidence of a search; one of THESE names carrying a value
 * is, and only the value is judged — never the whole URL, which the URL-level
 * check already covers on its own terms. `s` and `k` are single letters, and
 * they belong to the same vocabulary (WordPress, Amazon).
 */
export const SEARCH_QUERY_PARAMS = Object.freeze([
  'q',
  'query',
  'search',
  'search_query',
  'searchterm',
  'search_term',
  'keyword',
  'keywords',
  'term',
  'text',
  'k',
  's',
  '_nkw',
]);

/** Hosts with a rule of their own, so the generic scan never second-guesses one. */
function hasOwnRule(host) {
  return (
    /^google\.[a-z.]{2,}$/.test(host) ||
    host === 'bing.com' ||
    host.endsWith('.bing.com') ||
    host === 'duckduckgo.com' ||
    host.endsWith('.duckduckgo.com') ||
    isYouTubeHost(host)
  );
}

/**
 * True when a query value is an ADDRESS rather than something typed into a
 * search box.
 *
 * Redirectors hand their destination through a query parameter — `?q=https://…`
 * — and judging one as a search would block a page for a term in the address
 * being navigated TO, before that address is judged on its own terms. Both
 * spellings are covered: with a scheme, and as a bare `host/path`.
 */
function looksLikeAddress(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(value);
}

/**
 * Extract the search query from a URL, or null when it is not a search URL.
 *
 * Returns `{ engine, query }`. The engine is the one named in the rules, or
 * `'site'` for the generic scan. The query is decoded (a search for "%20" must
 * match the same as a space).
 */
export function parseSearchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.toLowerCase();

  // Google: google.com, google.co.uk, ... — /search or /webhp.
  if (/^google\.[a-z.]{2,}$/.test(host) && (path === '/search' || path === '/webhp')) {
    const query = parsed.searchParams.get('q');
    if (query) return { engine: 'google', query };
  }

  // Bing.
  if ((host === 'bing.com' || host.endsWith('.bing.com')) && path.startsWith('/search')) {
    const query = parsed.searchParams.get('q');
    if (query) return { engine: 'bing', query };
  }

  // DuckDuckGo (both the JS and the HTML-only front end).
  if ((host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) && (path === '/' || path === '/html/' || path === '')) {
    const query = parsed.searchParams.get('q');
    if (query) return { engine: 'duckduckgo', query };
  }

  // YouTube search. The app blocks the YouTube search query too, so it is
  // treated as a search surface here rather than left to the feed check.
  if (isYouTubeHost(host) && path.startsWith('/results')) {
    const query = parsed.searchParams.get('search_query') ?? parsed.searchParams.get('q');
    if (query) return { engine: 'youtube', query };
  }

  // Every OTHER site: the same technique, on whatever it calls its search box.
  // Skipped for a host that already has a rule above, because those rules are
  // about WHICH path is a search there (`google.com/url?q=` is a redirector,
  // not a search) and second-guessing them is how an ordinary page gets blocked.
  if (!hasOwnRule(host)) {
    for (const name of SEARCH_QUERY_PARAMS) {
      const value = parsed.searchParams.get(name);
      if (!value) continue;
      const query = value.trim();
      if (query === '' || looksLikeAddress(query)) continue;
      return { engine: 'site', query };
    }
  }

  return null;
}

/** YouTube host test shared by the search parser and the feed logic. */
export function isYouTubeHost(host) {
  const h = String(host).toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be';
}

/** True when a URL is a YouTube Shorts URL (which the Shorts control must NOT block). */
export function isShortsUrl(url) {
  try {
    const parsed = new URL(url);
    return isYouTubeHost(parsed.hostname) && parsed.pathname.toLowerCase().startsWith('/shorts');
  } catch {
    return false;
  }
}
