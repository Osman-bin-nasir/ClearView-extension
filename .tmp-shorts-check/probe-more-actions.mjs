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

await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
await sleep(500);
console.log(
  JSON.stringify(
    await evaluate(`(async () => {
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const before = new Set([...document.querySelectorAll('body *')]);
      const button = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === 'More actions');
      if (!button) return { button: false, url: location.href, title: document.title };
      const chain = [];
      let node = button;
      for (let i = 0; i < 8 && node; i += 1, node = node.parentElement) {
        chain.push(node.tagName + (node.id ? '#' + node.id : '') + '.' + (node.className || '').toString().split(' ').slice(0, 3).join('.'));
      }
      button.click();
      await new Promise((r) => setTimeout(r, 1600));
      const added = [...document.querySelectorAll('body *')].filter((el) => !before.has(el) && visible(el));
      const texts = [...document.querySelectorAll('body *')].filter(
        (el) => el.children.length === 0 && visible(el) && /Send feedback|Save|Report/i.test(el.textContent || '')
      );
      return {
        button: true,
        rect: button.getBoundingClientRect().toJSON(),
        chain,
        added: added.slice(0, 40).map((el) => ({
          tag: el.tagName,
          id: el.id,
          cls: (el.className || '').toString().slice(0, 100),
          role: el.getAttribute('role'),
          text: (el.textContent || '').trim().slice(0, 120),
          parent: el.parentElement?.tagName,
        })),
        feedback: texts.slice(0, 4).map((el) => {
          const ancestors = [];
          let n = el;
          for (let i = 0; i < 8 && n; i += 1, n = n.parentElement) {
            ancestors.push(n.tagName + (n.id ? '#' + n.id : '') + '.' + (n.className || '').toString().split(' ').slice(0, 3).join('.') + (n.getAttribute('role') ? '[' + n.getAttribute('role') + ']' : ''));
          }
          return { text: el.textContent.trim().slice(0, 60), ancestors };
        }),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).map((el) => ({
          tag: el.tagName,
          id: el.id,
          cls: (el.className || '').toString().slice(0, 80),
          text: (el.textContent || '').trim().slice(0, 300),
        })),
        panels: [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer, ytd-engagement-panel-renderer')].filter(visible).map((el) => ({
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 300),
          html: el.outerHTML.slice(0, 800),
        })),
        sheets: [...document.querySelectorAll('yt-sheet-view-model')].filter(visible).map((el) => el.outerHTML.slice(0, 1200)),
        dropdowns: [...document.querySelectorAll('tp-yt-iron-dropdown')].filter(visible).map((el) => ({
          html: el.outerHTML.slice(0, 1000),
          text: (el.textContent || '').trim().slice(0, 300),
        })),
        bodyTextTail: (document.body.innerText || '').slice(-600),
      };
    })()`),
    null,
    2
  )
);
socket.close();
