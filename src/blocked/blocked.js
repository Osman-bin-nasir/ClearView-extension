/**
 * The blocked page.
 *
 * Deliberately told only a REASON CODE, never the blocked URL or the matched
 * term. A blocked page that reprinted the address, or the word that matched,
 * would put the very content the user is being protected from back on screen —
 * and into the browser's history. The code is enough to say something useful.
 */

const COPY = {
  domain: {
    title: 'Site blocked',
    message: 'This website is on the blocked list, so ClearView stopped it from loading.',
  },
  keyword: {
    title: 'Content blocked',
    message: 'This address matched the built-in content filters, so ClearView stopped it.',
  },
  'your-keyword': {
    title: 'Blocked by your rule',
    message: 'This address matched a keyword you added, so ClearView stopped it.',
  },
  'shared-keyword': {
    title: 'Content blocked',
    message: 'This address matched a rule from the shared blocklist, so ClearView stopped it.',
  },
  search: {
    title: 'Search blocked',
    message: 'That search matched the content filters, so ClearView redirected you somewhere safe.',
  },
  shorts: {
    title: 'Shorts are blocked',
    message: 'YouTube Shorts are switched off, so ClearView stopped this one from loading.',
  },
};

const reason = new URLSearchParams(location.search).get('reason') ?? 'keyword';
const copy = COPY[reason] ?? COPY.keyword;

document.getElementById('title').textContent = copy.title;
document.getElementById('message').textContent = copy.message;

document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.replace('about:blank');
});

document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
