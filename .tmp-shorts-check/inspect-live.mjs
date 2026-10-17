import { setTimeout as sleep } from 'node:timers/promises';

const target = (await (await fetch('http://127.0.0.1:9222/json')).json()).find(
  (entry) => entry.type === 'page'
);
if (!target) throw new Error('no page target');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let id = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const next = ++id;
    pending.set(next, resolve);
    socket.send(JSON.stringify({ id: next, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.result?.exceptionDetails) {
    return { error: response.result.exceptionDetails.exception?.description ?? 'exception' };
  }
  return response.result?.result?.value;
}

for (let attempt = 0; attempt < 20; attempt += 1) {
  await sleep(1000);
  const count = await evaluate("document.querySelectorAll('ytd-reel-video-renderer').length");
  if (count > 0) break;
}

await sleep(2500);

console.log(
  'BASE',
  await evaluate(`(() => {
    const reels = [...document.querySelectorAll('ytd-reel-video-renderer')];
    const more = [...document.querySelectorAll('*')].filter((el) => {
      const outer = el.outerHTML || '';
      return outer.includes('More actions') && el.children.length === 0;
    });
    return {
      href: location.href,
      title: document.title,
      reels: reels.length,
      moreCount: more.length,
      more: more.slice(0, 3).map((el) => ({
        tag: el.tagName,
        id: el.id,
        cls: el.className?.toString().slice(0, 120),
        aria: el.getAttribute('aria-label'),
        outer: (el.outerHTML || '').slice(0, 500),
      })),
      ids: [...document.querySelectorAll('[id]')]
        .map((el) => el.id)
        .filter((value) => /reel|more|menu|short/i.test(value))
        .slice(0, 60),
      tags: [...new Set([...document.querySelectorAll('ytd-reel-video-renderer *')].map((el) => el.tagName))]
        .filter((tag) => /BUTTON|MENU|SHEET|LIST|OVERLAY/.test(tag))
        .slice(0, 60),
    };
  })()`)
);

// Click the Shorts three-dot, then look at what the page rendered.
console.log(
  'CLICK',
  await evaluate(`(async () => {
    const findMore = () => [...document.querySelectorAll('*')].find((el) =>
      el.getAttribute?.('aria-label') === 'More actions' ||
      el.id === 'reel_more_button' ||
      el.getAttribute?.('aria-label') === 'More'
    );
    const button = findMore();
    if (!button) return { clicked: false, ids: [...document.querySelectorAll('[id]')].map((e) => e.id).filter((v) => /more/i.test(v)).slice(0, 30) };
    const within = button.closest('ytd-reel-video-renderer') ? 'reel' : (button.closest('ytd-shorts') ? 'shorts' : 'outside');
    button.click();
    await new Promise((r) => setTimeout(r, 1500));
    const sheet = document.querySelector('yt-sheet-view-model');
    const list = document.querySelector('yt-list-view-model');
    const popup = document.querySelector('ytd-popup-container');
    return {
      clicked: true,
      tag: button.tagName,
      id: button.id,
      within,
      sheet: sheet ? sheet.outerHTML.slice(0, 1200) : null,
      list: list ? list.outerHTML.slice(0, 800) : null,
      popup: popup ? popup.innerHTML.slice(0, 1600) : null,
      dropdowns: document.querySelectorAll('tp-yt-iron-dropdown').length,
      sheets: document.querySelectorAll('yt-sheet-view-model').length,
      lists: document.querySelectorAll('yt-list-view-model').length,
      items: document.querySelectorAll('yt-list-item-view-model').length,
      menuPopups: document.querySelectorAll('ytd-menu-popup-renderer').length,
      dialogs: [...document.querySelectorAll('*')].filter((el) => el.getAttribute?.('role') === 'dialog').length,
    };
  })()`)
);

socket.close();
