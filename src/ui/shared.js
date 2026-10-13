/**
 * Helpers every extension page shares.
 *
 * Pages are ES modules (`<script type="module">`), so they import the SAME
 * constants and rule bundle the worker uses — the popup can therefore describe
 * what is blocked without asking the worker to explain its own rules.
 */

/** Send a message to the worker, resolving to its payload or throwing a coded error. */
export async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('The extension background is not responding.');
  if (!response.ok) {
    const error = new Error(response.error?.message ?? response.error?.code ?? 'Request failed');
    error.code = response.error?.code ?? 'unknown_error';
    error.status = response.error?.status ?? 0;
    return Promise.reject(error);
  }
  return response.data;
}

/** `el('div', {class: 'x'}, ['text', child])` — a tiny DOM builder. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A labelled switch. `onChange` receives the next boolean. */
export function switchControl(checked, onChange, { disabled = false } = {}) {
  const button = el('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': 'Toggle',
    disabled: disabled ? true : false,
  });
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', next ? 'true' : 'false');
    onChange(next);
  });
  return button;
}

/** A card with the app's icon-badge header. Returns { card, body }. */
export function card({ icon, title, subtitle, trailing, detail }) {
  const body = el('div', { class: 'card-body' });
  const head = el('div', { class: 'card-head' }, [
    el('div', { class: 'card-icon', text: icon ?? '🛡' }),
    el('div', { class: 'card-titles' }, [
      el('div', { class: 'card-title', text: title }),
      subtitle ? el('div', { class: 'card-subtitle', text: subtitle }) : null,
    ]),
    trailing ?? null,
  ]);
  const children = [head];
  if (detail) children.push(el('div', { class: 'card-detail' }, [el('ul', {}, detail.map((line) => el('li', { text: line })))]));
  children.push(body);
  return { card: el('div', { class: 'card' }, children), body };
}

export function section(label) {
  return el('div', { class: 'section' }, [el('span', { class: 'section-label', text: label })]);
}

export function pill(text, kind = '') {
  return el('span', { class: `pill ${kind}`.trim(), text });
}

export function statusLine(node, text, isError = false) {
  node.textContent = text ?? '';
  node.classList.toggle('error', Boolean(isError));
}

/** "3 minutes ago" / "just now", for timestamps the UI shows. */
export function relativeTime(timestamp) {
  if (!timestamp) return 'never';
  const delta = Date.now() - Number(timestamp);
  if (delta < 45_000) return 'just now';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/** Turn a backend error into a sentence that says nothing it should not. */
export function errorMessage(error) {
  switch (error?.code) {
    case 'network_unavailable':
      return 'Could not reach the server. Nothing changed.';
    case 'invalid_anonymous_id':
      return 'This install’s anonymous id was rejected. Tap “New identity” and try again.';
    case 'invalid_request':
      return 'That input was not accepted. Check it and try again.';
    case 'invalid_keyword':
      return 'Enter a keyword between 1 and 80 characters.';
    case 'invalid_channel_handle':
      return 'Enter a channel handle like @examplechannel.';
    case 'rate_limited':
    case 'too_many_requests':
      return 'Too many requests just now. Try again in a little while.';
    case 'missing_token':
    case 'invalid_token':
      return 'Sign in as an administrator to do that.';
    case 'admin_forbidden':
    case 'forbidden':
      return 'This account is not allowed to moderate keywords.';
    default:
      return error?.message ?? 'Something went wrong.';
  }
}
