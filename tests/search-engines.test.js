import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SAFE_SEARCH_DESTINATION,
  YOUTUBE_HOME,
  isShortsUrl,
  isYouTubeHost,
  parseSearchUrl,
  safeSearchDestination,
} from '../src/common/search-engines.js';

test('recognizes a Google search and yields the query', () => {
  assert.deepEqual(parseSearchUrl('https://www.google.com/search?q=hello+world'), {
    engine: 'google',
    query: 'hello world',
  });
});

test('recognizes the Google Images/Videos layout codes', () => {
  assert.deepEqual(parseSearchUrl('https://www.google.com/search?tbm=isch&q=hello'), {
    engine: 'google',
    query: 'hello',
  });
});

test('recognizes country Google domains', () => {
  assert.deepEqual(parseSearchUrl('https://www.google.co.uk/search?q=hello'), {
    engine: 'google',
    query: 'hello',
  });
});

test('recognizes Bing, DuckDuckGo and YouTube search', () => {
  assert.deepEqual(parseSearchUrl('https://www.bing.com/search?q=hello'), { engine: 'bing', query: 'hello' });
  assert.deepEqual(parseSearchUrl('https://duckduckgo.com/?q=hello'), { engine: 'duckduckgo', query: 'hello' });
  assert.deepEqual(parseSearchUrl('https://www.youtube.com/results?search_query=hello'), {
    engine: 'youtube',
    query: 'hello',
  });
});

test('decodes percent-encoded queries', () => {
  assert.deepEqual(parseSearchUrl('https://www.google.com/search?q=hello%20world'), {
    engine: 'google',
    query: 'hello world',
  });
});

test('ANY site’s search query is read, not only the named engines’', () => {
  // This assertion used to read `null`: a search on an unrecognised site was not
  // intercepted at all. That was the bug — the named engines' queries were judged
  // with the FULL rules (including the phrase tier, where "woman" + "bikini"
  // blocks although neither half alone does) while every other site only got the
  // URL-level check, which deliberately skips that tier. The same phrase was
  // blocked on Google and let through on a Reddit search. The behaviour is
  // changed on purpose: one technique, applied everywhere.
  for (const url of [
    'https://www.reddit.com/search/?q=hello',
    'https://twitter.com/search?q=hello',
    'https://www.amazon.com/s?k=hello',
    'https://www.ebay.com/sch/i.html?_nkw=hello',
    'https://yandex.com/search/?text=hello',
    'https://search.brave.com/search?q=hello',
    'https://www.startpage.com/sp/search?query=hello',
    'https://ablog.example.com/?s=hello',
    'https://shop.example.com/find?searchterm=hello',
    'https://example.com/search?q=hello',
  ]) {
    assert.deepEqual(parseSearchUrl(url), { engine: 'site', query: 'hello' }, url);
  }
});

test('the generic scan judges the VALUE, and only in a parameter that means search', () => {
  // The guard against the obvious objection: a parameter that is not a search
  // parameter is not a search, however queried the page looks.
  assert.equal(parseSearchUrl('https://example.com/page?utm_source=newsletter'), null);
  assert.equal(parseSearchUrl('https://example.com/?page=2&sort=newest'), null);
  // A search parameter with nothing in it is not a search either.
  assert.equal(parseSearchUrl('https://example.com/search?q='), null);
  assert.equal(parseSearchUrl('https://example.com/search?q=%20%20'), null);
});

test('a query value that is an ADDRESS is not treated as a search', () => {
  // Redirectors pass their destination through a query parameter. Judging one as
  // a search would block a page for a term in the address being navigated to,
  // before that address is judged on its own terms.
  assert.equal(parseSearchUrl('https://oracle.example.com/?q=https://site.example.com/beach-pics'), null);
  assert.equal(parseSearchUrl('https://oracle.example.com/?q=site.example.com/beach-pics'), null);
});

test('a host with rules of its OWN is never second-guessed by the generic scan', () => {
  // Google's redirector hands the destination through `?q=`, and its maps are
  // not searches: the engine rule above decides which of its paths are searches.
  assert.equal(parseSearchUrl('https://www.google.com/url?q=https://example.com/'), null);
  assert.equal(parseSearchUrl('https://www.google.com/maps?q=coffee'), null);
  assert.equal(parseSearchUrl('https://duckduckgo.com/l/?uddg=https://example.com/'), null);
  assert.equal(parseSearchUrl('https://www.youtube.com/watch?v=abc&q=hello'), null);
});

test('a Google page that is not a search is not treated as one', () => {
  assert.equal(parseSearchUrl('https://www.google.com/maps'), null);
  assert.equal(parseSearchUrl('https://www.google.com/search?safe=active'), null);
});

test('the safe destination carries no query', () => {
  assert.equal(SAFE_SEARCH_DESTINATION, 'https://www.google.com/webhp?safe=active');
  assert.equal(new URL(SAFE_SEARCH_DESTINATION).searchParams.get('q'), null);
});

test('where a blocked search lands depends on where it was made', () => {
  // A search made ON YouTube keeps the user on YouTube; every other site keeps
  // the Google safe page. Neither destination can carry the blocked query, and
  // neither can be a position the extension then has to block again.
  assert.equal(safeSearchDestination('youtube'), YOUTUBE_HOME);
  assert.equal(YOUTUBE_HOME, 'https://www.youtube.com/');
  assert.equal(new URL(YOUTUBE_HOME).search, '', 'YouTube home carries no query');
  for (const engine of ['google', 'bing', 'duckduckgo', 'site']) {
    assert.equal(safeSearchDestination(engine), SAFE_SEARCH_DESTINATION, engine);
  }
  // A destination is always something we can navigate to, whatever the caller
  // forgot to pass.
  assert.equal(safeSearchDestination(undefined), SAFE_SEARCH_DESTINATION);
});

test('YouTube hosts and Shorts URLs are identified correctly', () => {
  assert.equal(isYouTubeHost('www.youtube.com'), true);
  assert.equal(isYouTubeHost('m.youtube.com'), true);
  assert.equal(isYouTubeHost('youtube.com'), true);
  assert.equal(isYouTubeHost('notyoutube.com'), false);
  assert.equal(isShortsUrl('https://www.youtube.com/shorts/abc123'), true);
  assert.equal(isShortsUrl('https://www.youtube.com/watch?v=abc'), false);
});
