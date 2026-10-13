/**
 * Search-engine URL parsing.
 *
 * Explicit-search blocking needs two things the URL alone does not give: which
 * engine this is, and the user's query. Both are read here so the background
 * worker can decide and redirect in one place.
 *
 * Only engines the product promises to cover are listed: a search the user runs
 * on a site we do not recognise is not intercepted at all, which is the correct
 * failure — intercepting an arbitrary `?q=` on an unknown site would break
 * ordinary pages.
 */

/** The safe destination for a blocked search: Google, with NO query carried over. */
export const SAFE_SEARCH_DESTINATION = 'https://www.google.com/webhp?safe=active';

/**
 * Extract the search query from a URL, or null when it is not a recognised
 * search-results URL.
 *
 * Returns `{ engine, query }`. The query is decoded (a search for "%20" must
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
