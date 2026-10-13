import test from 'node:test';
import assert from 'node:assert/strict';

import { SAFE_SEARCH_DESTINATION, isShortsUrl, isYouTubeHost, parseSearchUrl } from '../src/common/search-engines.js';

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

test('an ordinary ?q= parameter on an unknown site is not a search', () => {
  assert.equal(parseSearchUrl('https://example.com/search?q=porn'), null);
});

test('a Google page that is not a search is not treated as one', () => {
  assert.equal(parseSearchUrl('https://www.google.com/maps'), null);
  assert.equal(parseSearchUrl('https://www.google.com/search?safe=active'), null);
});

test('the safe destination carries no query', () => {
  assert.equal(SAFE_SEARCH_DESTINATION, 'https://www.google.com/webhp?safe=active');
  assert.equal(new URL(SAFE_SEARCH_DESTINATION).searchParams.get('q'), null);
});

test('YouTube hosts and Shorts URLs are identified correctly', () => {
  assert.equal(isYouTubeHost('www.youtube.com'), true);
  assert.equal(isYouTubeHost('m.youtube.com'), true);
  assert.equal(isYouTubeHost('youtube.com'), true);
  assert.equal(isYouTubeHost('notyoutube.com'), false);
  assert.equal(isShortsUrl('https://www.youtube.com/shorts/abc123'), true);
  assert.equal(isShortsUrl('https://www.youtube.com/watch?v=abc'), false);
});
