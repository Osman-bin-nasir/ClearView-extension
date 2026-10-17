/**
 * Helpers every extension page shares.
 *
 * Pages are ES modules (`<script type="module">`), so they import the SAME
 * constants and rule bundle the worker uses — the popup can therefore describe
 * what is blocked without asking the worker to explain its own rules.
 */

import { icon as glyph } from './icons.js';

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

/**
 * A labelled switch. `onChange` receives the next boolean.
 *
 * `label` names what the switch controls, for a screen reader — "Toggle" alone
 * says nothing next to four of them on one page.
 */
export function switchControl(checked, onChange, { disabled = false, label = 'Toggle' } = {}) {
  const button = el('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label,
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
 * One settings row: an optional icon badge, a label, a trailing control, an
 * explanation and the body its caller fills in.
 *
 * The badge stays: the theme's `.card-head` is laid out around it, and it is the
 * only thing that makes a page of near-identical rows scannable. It carries no
 * information the title does not, so a row without one simply omits it. It takes
 * either an `icons.js` node or a string, so a page can still fall back to text.
 *
 * `variant` is the card's state, and it is the whole visual language of the app's
 * Protection tab:
 *   - `'on'`     — active protection: green, white type, no badge tile.
 *   - `'alert'`  — a filter that hides content (Brain Bot, Strict Mode): maroon.
 *   - `'dashed'` — there is a list behind this row.
 *   - `''`       — an ordinary slate row.
 * `dim` is separate, because it is a different fact: this row cannot do anything
 * until Protection is on again.
 *
 * `info` puts the ⓘ beside the row. It folds `detail` away and back — the panel
 * starts open (`open: false` for the popup, where space is the whole point), so
 * the button is a way to quieten the page rather than the only way to read it.
 *
 * Returns `{ card, body }`.
 */
export function card({
  icon: badge,
  title,
  subtitle,
  trailing,
  detail,
  variant = '',
  dim = false,
  info = false,
  open = true,
  action = null,
}) {
  const body = el('div', { class: 'card-body' });

  const detailNode = detail && detail.length
    ? el('div', { class: `card-detail${open ? '' : ' hidden'}` }, [
        el('ul', {}, detail.map((line) => el('li', { text: line }))),
      ])
    : null;

  let infoButton = null;
  if (info && detailNode) {
    infoButton = el(
      'button',
      {
        class: 'card-info',
        type: 'button',
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': `About ${title}`,
      },
      [glyph('info', 16)]
    );
    infoButton.addEventListener('click', () => {
      const collapsed = detailNode.classList.toggle('hidden');
      infoButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }

  const head = el('div', { class: 'card-head' }, [
    badge
      ? el('div', { class: 'card-icon', 'aria-hidden': 'true' }, [
          badge instanceof Node ? badge : document.createTextNode(String(badge)),
        ])
      : null,
    el('div', { class: 'card-titles' }, [
      el('div', { class: 'card-title', text: title }),
      subtitle ? el('div', { class: 'card-subtitle', text: subtitle }) : null,
    ]),
    trailing ?? null,
    infoButton,
  ]);

  const children = [head];
  if (detailNode) children.push(detailNode);
  children.push(body);
  if (action) {
    children.push(
      el(
        'button',
        {
          class: 'card-action',
          type: 'button',
          disabled: action.disabled ? true : false,
          onclick: action.onClick,
        },
        [action.glyph ? glyph(action.glyph, 17) : null, el('span', { text: action.label })]
      )
    );
  }

  const classes = ['card', variant, dim ? 'dim' : ''].filter(Boolean).join(' ');
  return { card: el('div', { class: classes }, children), body };
}

/**
 * The chevron a row shows when the thing it names is somewhere else.
 * A glyph on its own carries no text, so it is marked decorative here and the
 * row's own label is what a screen reader reads.
 */
export function chevron(size = 20) {
  const node = glyph('chevron', size);
  const wrap = el('span', { class: 'row-chevron', 'aria-hidden': 'true' }, [node]);
  return wrap;
}

export function section(label) {
  return el('div', { class: 'section' }, [el('span', { class: 'section-label', text: label })]);
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

/**
 * `1204` → `1,204`, for the counts the pages print.
 *
 * Grouped by hand rather than with `toLocaleString`, so the digits a page shows
 * are the same digits everywhere and in the tests: a locale that grouped by
 * lakhs, or that used a comma as a decimal mark, would change what a count
 * appears to say.
 */
export function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
    case 'password_required':
      return 'Set a Protection password to finish setup.';
    case 'password_locked':
      // The server-side ring is not used here: the worker counts the failures and
      // says how long the lock lasts in the message it already carries.
      return error?.message ?? 'Too many wrong attempts. Try again in a minute.';
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
