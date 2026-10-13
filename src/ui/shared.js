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

/**
 * One settings row: an optional icon badge, a label, a trailing control and a
 * body.
 *
 * The badge stays: the theme's `.card-head` is laid out around it, and it is the
 * only thing that makes a page of near-identical rows scannable. It carries no
 * information the title does not, so a row without one simply omits it.
 * Returns `{ card, body }`.
 */
export function card({ icon, title, subtitle, trailing, detail }) {
  const body = el('div', { class: 'card-body' });
  const head = el('div', { class: 'card-head' }, [
    icon ? el('div', { class: 'card-icon', text: icon, 'aria-hidden': 'true' }) : null,
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

/**
 * The popup's protection summary: a state mark, a title and one line of status.
 *
 * @param {{ on: boolean, title: string, subtitle: string, trailing?: Node }} options
 */
export function hero({ on, icon, title, subtitle, trailing = null }) {
  return el('div', { class: `hero${on ? ' on' : ''}` }, [
    el('div', { class: 'hero-head' }, [
      el('div', { class: 'hero-mark', text: icon, 'aria-hidden': 'true' }),
      el('div', { class: 'card-titles' }, [
        el('div', { class: 'hero-title', text: title }),
        el('div', { class: 'hero-sub', text: subtitle }),
      ]),
      trailing,
    ]),
  ]);
}

/** A transient message, for outcomes that have no place of their own to live. */
let toastTimer = null;
export function toast(text) {
  if (typeof text !== 'string' || text.trim() === '') return;
  let node = document.querySelector('.toast');
  if (!node) {
    node = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  node.textContent = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3200);
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
    case 'invalid_password':
      return 'That password was not correct.';
    case 'password_too_short':
      return 'Use at least 4 characters for your password.';
    case 'password_too_long':
      return 'That password is too long.';
    case 'network_unavailable':
      return 'Could not reach the server. Nothing changed.';
    case 'invalid_anonymous_id':
      // No remedy is offered, because there is none to offer: the id is generated
      // once on install and the extension no longer replaces it, so telling the
      // user to "tap New identity" would point at a button that does not exist.
      return 'This install’s anonymous id was rejected by the server, so nothing was sent.';
    case 'invalid_request':
      return 'That input was not accepted. Check it and try again.';
    case 'invalid_keyword':
      return 'Enter a keyword between 1 and 80 characters.';
    case 'invalid_channel':
      return 'ClearView could not tell which channel that was. Open the video and use the ⋮ menu instead.';
    case 'invalid_channel_handle':
      return 'Enter a channel handle like @examplechannel.';
    case 'rate_limited':
    case 'too_many_requests':
      return 'Too many requests just now. Try again in a little while.';
    case 'invalid_credentials':
      // The extension holds no password and creates no accounts: an administrator
      // is a BACKEND row. Saying so is the difference between "the button is
      // broken" and "there is no account yet".
      return 'That email and password were refused by the server. Admin accounts are created on the backend, not in the extension — the extension stores no password.';
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
