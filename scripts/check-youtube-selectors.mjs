/**
 * A canary for the YouTube markup this extension depends on.
 *
 * YouTube renames its custom elements and preview surfaces without notice, and
 * every such rename fails SILENTLY in the extension: the selector matches
 * nothing, so a block, a Shorts hide or an ad skip simply stops happening while
 * its switch still reads "on". This script fetches two live pages and looks for
 * the anchors the content script counts on, so the change is visible the day it
 * ships rather than from a user's report.
 *
 * It is intentionally NOT part of `npm test`: the suite must pass offline, and a
 * network flake is not a code failure. Run it on a schedule, or before a release:
 *
 *   npm run canary
 *
 * Exit codes: 0 = every required anchor present; 1 = something is missing;
 * 2 = the pages could not be fetched (inconclusive, not a pass).
 */

const PAGES = [
  {
    name: 'home feed',
    url: 'https://www.youtube.com/',
    required: ['ytd-app', 'ytd-thumbnail', 'ytd-rich-grid-renderer'],
    optional: ['ytd-video-preview', 'yt-lockup-view-model', 'ytd-moving-thumbnail-renderer'],
  },
  {
    name: 'watch page',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    required: ['ytd-watch-flexy', 'movie_player', 'ytd-watch-metadata'],
    optional: ['ytd-video-preview', 'ytp-ad-skip-button-modern', 'ytp-ad-player-overlay'],
  },
];

const HEADERS = {
  // YouTube serves a different, script-only shell to obvious bots.
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

async function fetchPage(page) {
  const response = await fetch(page.url, { headers: HEADERS, redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

let networkFailures = 0;
let missing = 0;

for (const page of PAGES) {
  let html;
  try {
    html = await fetchPage(page);
  } catch (error) {
    networkFailures += 1;
    console.error(`✖ ${page.name}: could not be fetched (${error.message})`);
    continue;
  }

  console.log(`${page.name} (${page.url})`);
  for (const selector of page.required) {
    // The page carries the tag name as a string even where the element is
    // created later by the app, which is why a shell is still a useful check.
    if (html.includes(selector)) {
      console.log(`  ✔ ${selector}`);
    } else {
      missing += 1;
      console.error(`  ✖ ${selector} — REQUIRED, missing from the served page`);
    }
  }
  for (const selector of page.optional) {
    if (html.includes(selector)) console.log(`  ✔ ${selector}`);
    else console.warn(`  ⚠ ${selector} — not in this page; may be created at runtime`);
  }
}

if (networkFailures === PAGES.length) {
  console.error('Inconclusive: neither page could be fetched. Nothing was verified.');
  process.exit(2);
}

if (missing > 0) {
  console.error(`\n${missing} required anchor(s) are gone. Check the content script's selectors.`);
  process.exit(1);
}

console.log('\nEvery required anchor is still present.');
