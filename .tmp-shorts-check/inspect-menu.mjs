import { setTimeout as sleep } from 'node:timers/promises';

const target = (await (await fetch('http://127.0.0.1:9222/json')).json()).find(
  (entry) => entry.type === 'page'
);
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

console.log(
  await evaluate(`(async () => {
    const button = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === 'More actions');
    if (button && !document.querySelector('tp-yt-iron-dropdown')?.querySelector('*')) button.click();
    await new Promise((r) => setTimeout(r, 1200));
    const dropdown = document.querySelector('tp-yt-iron-dropdown');
    const visible = (el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const descendants = dropdown ? [...dropdown.querySelectorAll('*')] : [];
    return {
      button: button ? { outer: button.outerHTML.slice(0, 400), parent: button.parentElement?.outerHTML.slice(0, 300) } : null,
      dropdown: dropdown ? dropdown.outerHTML.slice(0, 3000) : null,
      childTags: descendants.map((el) => el.tagName + (el.id ? '#' + el.id : '')).slice(0, 60),
      visibleTexts: descendants.filter(visible).map((el) => (el.textContent || '').trim()).filter(Boolean).slice(-30),
      openDialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).map((el) => ({
        tag: el.tagName,
        cls: el.className?.toString().slice(0, 100),
        text: (el.textContent || '').trim().slice(0, 300),
      })),
      popupText: (document.querySelector('ytd-popup-container')?.textContent || '').trim().slice(0, 500),
    };
  })()`)
);
socket.close();
