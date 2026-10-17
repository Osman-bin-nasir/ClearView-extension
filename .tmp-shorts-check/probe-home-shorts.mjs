import { setTimeout as sleep } from 'node:timers/promises';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((entry) => entry.type === 'page');
const socket = new WebSocket(page.webSocketDebuggerUrl);
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
await send('Page.navigate', { url: 'https://www.youtube.com/' });
for (let attempt = 0; attempt < 15; attempt += 1) {
  await sleep(1000);
  if (await evaluate("document.querySelectorAll('ytd-rich-item-renderer').length > 3")) break;
}
await sleep(2000);
console.log(
  JSON.stringify(
    await evaluate(`(() => {
      const lockups = [...document.querySelectorAll('ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2')];
      const first = lockups[0];
      const shelf = document.querySelector('ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer');
      let chain = [];
      let node = first;
      for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) {
        chain.push(node.tagName + (node.id ? '#' + node.id : ''));
      }
      return {
        href: location.href,
        lockups: lockups.length,
        chain,
        titles: lockups.slice(0, 4).map((el) => ({
          lockupTitle: el.querySelector('.shortsLockupViewModelHostMetadataTitle, h3')?.textContent?.trim().slice(0, 70) ?? null,
          links: [...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).slice(0, 4),
          img: Boolean(el.querySelector('img')),
          thumbnailLink: Boolean(el.querySelector('a#thumbnail')),
          w: el.getBoundingClientRect().width,
          h: el.getBoundingClientRect().height,
        })),
        shelf: shelf ? { tag: shelf.tagName, isShorts: shelf.hasAttribute('is-shorts'), cls: shelf.className?.toString().slice(0, 60) } : null,
        badge: document.querySelectorAll('ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"]').length,
      };
    })()`),
    null,
    2
  )
);
socket.close();
