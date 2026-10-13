/**
 * The blocked page: what it offers, and where its Back button goes.
 *
 * It is a plain page with no module system, so — as with the content script —
 * the invariants are pinned by STATIC checks on the shipped files. The behaviour
 * itself (Back leaves for YouTube home, in a real browser) is exercised by a
 * Chrome harness outside the repo; these guard the two things that make it true.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'src/blocked/blocked.html'), 'utf8');
const script = readFileSync(resolve(ROOT, 'src/blocked/blocked.js'), 'utf8');
const css = readFileSync(resolve(ROOT, 'src/blocked/blocked.css'), 'utf8');
const worker = readFileSync(resolve(ROOT, 'src/background/blocking.js'), 'utf8');

test('the blocked page asks the user for nothing', () => {
  // The page used to offer "Go back" and "Open settings", which put the way out
  // in the page's hands instead of the browser's — a note telling the user which
  // button to press, doing a job the Back button should already do.
  assert.ok(!/id="back"/.test(html), 'the Go back button is gone');
  assert.ok(!/id="options"/.test(html), 'the Open settings button is gone');
  assert.ok(!/<button/.test(html), 'the page carries no actions of its own');
  assert.ok(!/Go back|Open settings/i.test(html), 'and it does not tell the user to press them');
  assert.ok(!/openOptionsPage/.test(script), 'nothing here may send the user to settings');
  assert.ok(!/\.actions\s*\{/.test(css), 'the button group is gone with the buttons');
});

test('the browser’s Back button leaves the blocked page for YouTube home', () => {
  // The page is reached by REDIRECT, so the entry behind it is the address that
  // was blocked: Back re-requests it, the worker blocks it again, and the user
  // lands back here. A history entry of our own turns that Back into a
  // SAME-DOCUMENT traversal this page can answer.
  assert.ok(
    /const BACK_DESTINATION = 'https:\/\/www\.youtube\.com\/';/.test(script),
    'the destination is YouTube’s home page'
  );
  assert.ok(
    script.includes("history.pushState({ clearviewBlocked: true }, '', location.href)"),
    'a same-document entry of our own is what makes Back observable at all'
  );
  assert.ok(
    script.includes("window.addEventListener('popstate'"),
    'the traversal is answered by popstate'
  );
  assert.ok(
    script.includes('location.replace(BACK_DESTINATION)'),
    'replace, not assign, so the blocked page cannot accumulate entries'
  );
  assert.ok(
    script.includes('if (!armed) return;'),
    'a popstate delivered for the load itself must not bounce the user straight out'
  );
  assert.ok(!/history\.back\(\)/.test(script), 'the page must not bounce itself backwards');
});

test('every reason the worker can emit has copy on the blocked page', () => {
  // A reason with no copy falls back to the keyword wording, which would tell a
  // user who hit a blocked channel that their address matched a filter.
  const reasons = ['domain', 'keyword', 'your-keyword', 'shared-keyword', 'channel', 'shorts'];
  for (const reason of reasons) {
    assert.ok(
      new RegExp(`(^|\\n)\\s*'?${reason}'?:\\s*\\{`).test(script),
      `the blocked page must have wording for “${reason}”`
    );
    assert.ok(
      worker.includes(`'${reason}'`) || worker.includes(`reason: '${reason}'`),
      `the worker still emits “${reason}”, so its copy is still needed`
    );
  }
});

test('the blocked page never reprints what was blocked', () => {
  // The page is told a reason CODE and nothing else: the address, and the term
  // that matched, would otherwise be put back on screen and into the history.
  assert.ok(
    script.includes("new URLSearchParams(location.search).get('reason')"),
    'the reason code is the ONLY thing read out of the URL'
  );
  // `location.href` IS used — to push an identical history entry — so the rule
  // is about RENDERING the address, not reading it.
  assert.ok(!/textContent\s*=\s*location/.test(script), 'the address is never printed');
  assert.ok(!/\.href\s*=/.test(script), 'the page assigns no address of its own');
  assert.ok(!/innerHTML/.test(script + html), 'nothing may be written as markup');
  assert.ok(!/document\.write/.test(script), 'nor by document.write');
});
