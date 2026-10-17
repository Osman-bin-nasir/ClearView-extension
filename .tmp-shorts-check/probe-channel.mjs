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
console.log(
  JSON.stringify(
    await evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const reel = document.querySelector('ytd-reel-video-renderer');
      if (!reel) return { reel: false, url: location.href };
      const links = [...reel.querySelectorAll('a[href]')].map((a) => ({
        href: a.getAttribute('href'),
        text: (a.textContent || '').trim().slice(0, 80),
        aria: a.getAttribute('aria-label'),
        cls: (a.className || '').toString().slice(0, 80),
      }));
      const headings = [...reel.querySelectorAll('h1, h2, h3, [role="heading"]')].map((el) => ({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 100),
        text: (el.textContent || '').trim().slice(0, 100),
        aria: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
      }));
      const modelled = [...reel.querySelectorAll('yt-shorts-video-title-view-model, ytd-reel-player-header-renderer, yt-shorts-channel-bar-view-model, [class*="ShortsVideoTitle"], [class*="reel-player-header"]')].map((el) => ({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 100),
        text: (el.textContent || '').trim().slice(0, 120),
      }));
      const avatar = [...reel.querySelectorAll('[aria-label*="Go to channel"]')].map((el) => ({
        tag: el.tagName,
        aria: el.getAttribute('aria-label'),
        cls: (el.className || '').toString().slice(0, 100),
        outer: el.outerHTML.slice(0, 500),
      }));
      return {
        url: location.href,
        title: document.title,
        links: links.filter((l) => l.href && /@|channel|user|\\/c\\//.test(l.href)).slice(0, 10),
        allLinkCount: links.length,
        headings,
        modelled,
        avatar,
        header: (reel.querySelector('#right-controls')?.parentElement?.parentElement?.innerText || '').slice(0, 400),
      };
    })()`),
    null,
    2
  )
);
socket.close();
