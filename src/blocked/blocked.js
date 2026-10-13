/**
 * The blocked page.
 *
 * Deliberately told only a REASON CODE, never the blocked URL or the matched
 * term. A blocked page that reprinted the address, or the word that matched,
 * would put the very content the user is being protected from back on screen —
 * and into the browser's history. The code is enough to say something useful.
 *
 * It also carries no actions of its own. It used to offer "Go back" and "Open
 * settings", which put the way out in the hands of the page rather than the
 * browser: the note that told the user what to press was doing a job the Back
 * button should already do, and here it did not (see below).
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
  channel: {
    title: 'Channel blocked',
    message: 'You blocked this YouTube channel, so ClearView stopped its page from loading.',
  },
};

/** Where the Back button goes from here. */
const BACK_DESTINATION = 'https://www.youtube.com/';

const reason = new URLSearchParams(location.search).get('reason') ?? 'keyword';
const copy = COPY[reason] ?? COPY.keyword;

document.getElementById('title').textContent = copy.title;
document.getElementById('message').textContent = copy.message;

/**
 * Make the browser's Back button leave this page for YouTube's home page.
 *
 * This page is reached by REDIRECT, so the history entry behind it is the very
 * address that was blocked. Pressing Back therefore re-requests it, the worker
 * blocks it again, and the user is returned to this page — Back looks like a
 * button that does nothing, which is what the old "Go back" button worked around
 * by sending the user somewhere else entirely.
 *
 * The way out is a history entry of our own. `pushState` puts an IDENTICAL entry
 * on top of this one, so the next Back is a SAME-DOCUMENT traversal that fires
 * `popstate` right here — and this page can answer it by going to YouTube home
 * instead of to the address the user was stopped from opening. `replace`, not
 * `assign`, so the blocked page does not accumulate entries of its own.
 *
 * The handler is armed a task later on purpose: a `popstate` can also be
 * delivered for the load itself when this page is reached by a traversal, and
 * acting on that would bounce the user straight back out again.
 */
history.pushState({ clearviewBlocked: true }, '', location.href);

let armed = false;
window.setTimeout(() => {
  armed = true;
}, 0);

window.addEventListener('popstate', () => {
  if (!armed) return;
  location.replace(BACK_DESTINATION);
});
