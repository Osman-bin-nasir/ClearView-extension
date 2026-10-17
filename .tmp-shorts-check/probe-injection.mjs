const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find((entry) => entry.type === 'page');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let id = 0;
const pending = new Map();
const contexts = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.executionContextCreated') contexts.push(message.params.context);
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
await send('Runtime.enable');
async function evaluate(expression, contextId) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId });
  if (response.result?.exceptionDetails) return { error: response.result.exceptionDetails.exception?.description };
  return response.result?.result?.value;
}
console.log('URL', await evaluate('location.href'));
console.log(
  'STYLES',
  await evaluate(`[...document.styleSheets].map((s) => s.href).filter(Boolean)`)
);
console.log(
  'SCRIPTS',
  await evaluate(`performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.includes('youtube.js') || n.includes('chrome-extension'))`)
);
console.log(
  'CLASSES',
  await evaluate(`({ cv: document.documentElement.className, toast: Boolean(document.querySelector('.cv-toast')), menu: Boolean(document.querySelector('.cv-menu-item')) })`)
);
console.log(
  'CONTEXTS',
  contexts.map((c) => ({ id: c.id, origin: c.origin, name: c.name, aux: c.auxData }))
);
for (const context of contexts.filter((c) => c.name || c.origin.startsWith('chrome-extension'))) {
  console.log(
    'CTX',
    context.id,
    context.name,
    context.origin,
    await evaluate(`({ chrome: typeof chrome, storage: typeof chrome !== 'undefined' && !!chrome.storage, runtime: typeof chrome !== 'undefined' && !!chrome.runtime })`, context.id)
  );
}
socket.close();
