import { setTimeout as sleep } from 'node:timers/promises';

const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find((entry) => entry.type === 'page');
if (!page) throw new Error('page target missing');
const EXTENSION_ID = 'fignfifoniblkonapihmkfakmlgkbkcf';

async function connect(target) {
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
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.result?.exceptionDetails) {
      return { error: response.result.exceptionDetails.exception?.description ?? 'exception' };
    }
    return response.result?.result?.value;
  };
  return { socket, send, evaluate };
}

const pageCdp = await connect(page);

// An extension page has chrome.storage; the MV3 worker sleeps when idle.
await pageCdp.send('Page.navigate', { url: `chrome-extension://${EXTENSION_ID}/src/options/options.html` });
await sleep(2000);
console.log(
  'SETTINGS',
  await pageCdp.evaluate(`(async () => {
    await chrome.storage.sync.set({
      'cv.settings': {
        protectionEnabled: true,
        brainBotEnabled: true,
        brainBotMode: 'overlay',
        blockedChannels: [],
        youtubeKeywords: [],
        userKeywords: [],
      },
    });
    return (await chrome.storage.sync.get('cv.settings'))['cv.settings'];
  })()`)
);

await pageCdp.send('Page.navigate', { url: 'https://www.youtube.com/shorts' });
await sleep(7000);

const before = await pageCdp.evaluate(`(() => {
  const reel = document.querySelector('ytd-reel-video-renderer');
  return {
    href: location.href,
    title: document.title,
    reel: Boolean(reel),
    reelTitle: reel?.querySelector('yt-shorts-video-title-view-model h1')?.textContent?.trim().slice(0, 80) ?? null,
    channel: reel?.querySelector('a[href^="/@"], a[href^="/channel/"]')?.getAttribute('href') ?? null,
    overlays: document.querySelectorAll('.cv-block-overlay').length,
    menuItems: document.querySelectorAll('.cv-menu-item').length,
  };
})()`);
console.log('BEFORE', before);

const clicked = await pageCdp.evaluate(`(async () => {
  const reel = document.querySelector('ytd-reel-video-renderer');
  const button = reel?.querySelector('button[aria-label="More actions"]');
  if (!button) return { button: false, labels: [...(reel?.querySelectorAll('[aria-label]') ?? [])].map((el) => el.getAttribute('aria-label')).slice(0, 40) };
  button.click();
  await new Promise((r) => setTimeout(r, 2000));
  const items = [...document.querySelectorAll('.cv-menu-item')];
  return {
    button: true,
    items: items.map((el) => ({
      text: el.textContent.trim(),
      rect: el.getBoundingClientRect().toJSON(),
      parent: el.parentElement?.tagName,
      parentRole: el.parentElement?.getAttribute('role'),
    })),
  };
})()`);
console.log('MENU', clicked);

if (clicked.items?.length) {
  console.log(
    'CLICK ITEM',
    await pageCdp.evaluate(`(async () => {
      const item = document.querySelector('.cv-menu-item');
      item.click();
      await new Promise((r) => setTimeout(r, 2500));
      const reel = document.querySelector('ytd-reel-video-renderer');
      return {
        overlay: Boolean(reel?.querySelector('.cv-block-overlay')),
        protectedAttr: reel?.getAttribute('data-cv-protected') ?? null,
        toast: document.querySelector('.cv-toast')?.textContent ?? null,
        videoPaused: reel?.querySelector('video')?.paused ?? null,
        menuStillOpen: Boolean(document.querySelector('.cv-menu-item')),
      };
    })()`)
  );

  console.log(
    'STORED',
    await pageCdp.evaluate(`chrome.storage.sync.get('cv.settings').then((s) => ({
      blockedChannels: s['cv.settings']?.blockedChannels,
      mode: s['cv.settings']?.brainBotMode,
    }))`)
  );

  await sleep(1500);
  console.log(
    'AFTER',
    await pageCdp.evaluate(`(() => {
      const reel = document.querySelector('ytd-reel-video-renderer');
      return {
        overlay: Boolean(reel?.querySelector('.cv-block-overlay')),
        overlayText: reel?.querySelector('.cv-block-overlay')?.textContent ?? null,
        protectedAttr: reel?.getAttribute('data-cv-protected') ?? null,
        reelDisplay: reel?.style.display ?? '',
      };
    })()`)
  );
}

pageCdp.socket.close();
