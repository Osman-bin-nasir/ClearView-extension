import { setTimeout as sleep } from 'node:timers/promises';

const target = (await (await fetch('http://127.0.0.1:9222/json')).json()).find((entry) => entry.type === 'page');
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
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) return { error: response.result.exceptionDetails.exception?.description };
  return response.result?.result?.value;
}

await send('Page.navigate', { url: 'https://www.youtube.com/shorts' });
await sleep(7000);

console.log(
  'LABELS',
  JSON.stringify(
    await evaluate(`(() => {
      const reel = document.querySelector('ytd-reel-video-renderer');
      if (!reel) return { reel: false, url: location.href, title: document.title };
      const labelled = [...reel.querySelectorAll('[aria-label]')].map((el) => ({
        tag: el.tagName,
        id: el.id,
        aria: el.getAttribute('aria-label'),
        cls: (el.className || '').toString().slice(0, 80),
        parent: el.parentElement?.tagName,
      }));
      return {
        reel: true,
        url: location.href,
        labelled,
        buttons: [...reel.querySelectorAll('button')].map((el) => ({
          id: el.id,
          aria: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          cls: (el.className || '').toString().slice(0, 80),
          text: (el.textContent || '').trim().slice(0, 30),
        })),
      };
    })()`),
    null,
    2
  )
);

console.log(
  'CLICK RESULT',
  JSON.stringify(
    await evaluate(`(async () => {
      const reel = document.querySelector('ytd-reel-video-renderer');
      if (!reel) return { reel: false };
      const candidates = [...reel.querySelectorAll('[aria-label]')].filter((el) =>
        /more|menu|action/i.test(el.getAttribute('aria-label') || '')
      );
      const button = candidates[0];
      if (!button) return { candidate: null };
      button.click();
      await new Promise((r) => setTimeout(r, 1500));
      const visible = (el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const menus = [...document.querySelectorAll(
        '[role="dialog"], .ytp-overflow-panel, tp-yt-iron-dropdown, yt-sheet-view-model, ytd-menu-popup-renderer, yt-list-view-model, yt-list-item-view-model, ytd-menu-popup-renderer'
      )].filter(visible);
      return {
        candidate: {
          tag: button.tagName,
          id: button.id,
          aria: button.getAttribute('aria-label'),
          outer: button.outerHTML.slice(0, 600),
        },
        menus: menus.map((el) => ({
          tag: el.tagName,
          id: el.id,
          cls: (el.className || '').toString().slice(0, 100),
          text: (el.textContent || '').trim().slice(0, 400),
          parent: el.parentElement?.tagName,
          html: el.outerHTML.slice(0, 500),
        })),
        tags: [...new Set([...document.querySelectorAll('body *')].map((el) => el.tagName))]
          .filter((tag) => /SHEET|LIST|MENU|DIALOG|OVERFLOW/.test(tag)),
        bodyBottom: document.body.lastElementChild?.outerHTML?.slice(0, 1200),
      };
    })()`),
    null,
    2
  )
);
socket.close();
