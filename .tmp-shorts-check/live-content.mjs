import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const script = readFileSync(new URL('../src/content/youtube.js', import.meta.url), 'utf8');
const MODE = process.argv[2] === 'remove' ? 'remove' : 'overlay';
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
  if (response.result?.exceptionDetails) {
    return { error: response.result.exceptionDetails.exception?.description ?? 'exception' };
  }
  return response.result?.result?.value;
}

await send('Page.navigate', { url: 'https://www.youtube.com/shorts' });
for (let attempt = 0; attempt < 15; attempt += 1) {
  await sleep(1000);
  const ready = await evaluate("Boolean(document.querySelector('ytd-reel-video-renderer') && document.querySelector('ytd-reel-video-renderer button[aria-label=\"More actions\"]'))");
  if (ready) break;
}
await sleep(1500);

const mock = `(() => {
  window.__calls = [];
  window.__config = {
    enabled: true,
    brainBotEnabled: true,
    brainBotMode: '${MODE}',
    blockShorts: false,
    blockYoutubeAds: false,
    blockedChannelCount: 0,
    revision: 'live-rev-1',
  };
  window.__storageListeners = [];
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.runtime.sendMessage = (message) => {
    window.__calls.push(message);
    if (message.type === 'rules/forContent') return Promise.resolve({ ok: true, data: { ...window.__config } });
    if (message.type === 'feed/evaluate') {
      const blocked = [];
      message.cards.forEach((card, index) => {
        if (window.__config.blockedChannelCount > 0 && (card.channelUrl || '').includes('@')) {
          blocked.push({ index, via: 'channel', matchedItem: card.channel });
        }
      });
      return Promise.resolve({ ok: true, data: { blocked } });
    }
    if (message.type === 'channel/status') return Promise.resolve({ ok: true, data: { blocked: false } });
    if (message.type === 'channel/block') {
      window.__blockTarget = { ...message };
      window.__config.blockedChannelCount = 1;
      window.__config.revision = 'live-rev-2';
      return Promise.resolve({ ok: true, data: {} });
    }
    if (message.type === 'video/check') return Promise.resolve({ ok: true, data: { blocked: false } });
    if (message.type === 'page/check') return Promise.resolve({ ok: true, data: { blocked: false } });
    return Promise.resolve({ ok: true, data: {} });
  };
  window.chrome.runtime.onMessage = { addListener() {} };
  window.chrome.storage = {
    onChanged: { addListener(listener) { window.__storageListeners.push(listener); } },
  };
})();`;

console.log('MOCK', await evaluate(mock));
console.log('INJECT', await evaluate(`${script}\n//# sourceURL=cv-youtube.js`));
await sleep(2500);

console.log(
  'BEFORE',
  await evaluate(`(() => {
    const reel = document.querySelector('ytd-reel-video-renderer');
    return {
      href: location.href,
      title: reel?.querySelector('yt-shorts-video-title-view-model h1')?.textContent?.trim().slice(0, 70) ?? null,
      channel: reel?.querySelector('a[href^="/@"], a[href^="/channel/"]')?.getAttribute('href') ?? null,
      overlays: document.querySelectorAll('.cv-block-overlay').length,
      calls: window.__calls.map((call) => call.type),
    };
  })()`)
);

console.log(
  'OPEN MENU',
  await evaluate(`(async () => {
    const reel = document.querySelector('ytd-reel-video-renderer');
    reel.querySelector('button[aria-label="More actions"]').click();
    await new Promise((r) => setTimeout(r, 1800));
    const items = [...document.querySelectorAll('.cv-menu-item')];
    return {
      items: items.map((el) => ({
        text: el.textContent.trim(),
        rect: el.getBoundingClientRect().toJSON(),
        parent: el.parentElement?.tagName,
        parentRole: el.parentElement?.getAttribute('role'),
      })),
      inSheet: Boolean(items[0]?.closest('yt-sheet-view-model')),
    };
  })()`)
);

console.log(
  'CLICK',
  await evaluate(`(async () => {
    const item = document.querySelector('.cv-menu-item');
    if (!item) return { clicked: false };
    item.click();
    await new Promise((r) => setTimeout(r, 1200));
    const reel = document.querySelector('ytd-reel-video-renderer');
    return {
      clicked: true,
      blockTarget: window.__blockTarget,
      toast: document.querySelector('.cv-toast')?.textContent ?? null,
      overlay: Boolean(reel?.querySelector('.cv-block-overlay')),
      paused: reel?.querySelector('video')?.paused ?? null,
    };
  })()`)
);

// The worker stores the block and the settings change reaches the page through
// chrome.storage.onChanged — emulate that so the overlay can be checked.
console.log(
  'STORAGE CHANGE',
  await evaluate(`(async () => {
    for (const listener of window.__storageListeners) listener({ 'cv.settings': { newValue: {} } }, 'sync');
    await new Promise((r) => setTimeout(r, 2500));
    const reel = document.querySelector('ytd-reel-video-renderer');
    return {
      overlay: Boolean(reel?.querySelector('.cv-block-overlay')),
      overlayText: reel?.querySelector('.cv-block-overlay')?.textContent ?? null,
      protectedAttr: reel?.getAttribute('data-cv-protected') ?? null,
      reelDisplay: reel?.style.display ?? '',
      paused: reel?.querySelector('video')?.paused ?? null,
      calls: window.__calls.map((call) => call.type),
    };
  })()`)
);

socket.close();
