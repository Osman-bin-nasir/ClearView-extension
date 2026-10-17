/**
 * The Protection password UI: one dialog, four jobs.
 *
 * Every page that can change Protection needs the same three things — ask for
 * the password that is set, offer to create one, and offer to change or remove
 * one — so they are built once here rather than three slightly different ways.
 *
 * The dialog only COLLECTS and does local sanity checks (length, matching
 * fields). Whether a password is right is decided by the worker, which owns the
 * stored hash, and its refusal is what the dialog shows. A page never gets to
 * believe a password is correct on its own.
 */

import { PASSWORD } from '../common/constants.js';
import { el, errorMessage, send } from './shared.js';

const MIN_LENGTH = PASSWORD.minLength;

/** One password input, with the browser's own manager kept out of the way. */
function passwordField(placeholder, { autofocus = false, id } = {}) {
  return el('input', {
    class: 'input',
    type: 'password',
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    ...(id ? { id } : {}),
    ...(autofocus ? { 'data-autofocus': 'true' } : {}),
  });
}

/**
 * Show a modal and resolve with the submitted value, or `null`.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.message]
 * @param {string} [options.icon]
 * @param {Array<{placeholder:string, key:string, autofocus?:boolean}>} options.fields
 * @param {(values: Record<string,string>) => string|null} options.validate
 *        return an error sentence to keep the dialog open, or null to resolve
 * @param {string} options.submitLabel
 * @param {string} [options.cancelLabel]
 * @param {string} [options.skipLabel]  an extra, lower-emphasis exit
 */
export function askPassword({
  title,
  message = '',
  icon = '🔒',
  fields,
  validate = () => null,
  submitLabel = 'Unlock',
  cancelLabel = 'Cancel',
  skipLabel = '',
}) {
  return new Promise((resolve) => {
    const inputs = {};
    const fieldNodes = fields.map((field) => {
      const input = passwordField(field.placeholder, { autofocus: field.autofocus });
      inputs[field.key] = input;
      return input;
    });

    const errorNode = el('div', { class: 'modal-error' });

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(value);
    };

    const submit = () => {
      const values = {};
      for (const [key, input] of Object.entries(inputs)) values[key] = input.value;
      const problem = validate(values);
      if (problem) {
        errorNode.textContent = problem;
        return;
      }
      close(values);
    };

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      }
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        submit();
      }
    };

    const actions = [
      el('button', { class: 'btn', type: 'button', text: cancelLabel, onclick: () => close(null) }),
      el('button', { class: 'btn primary', type: 'button', text: submitLabel, onclick: submit }),
    ];
    if (skipLabel) {
      actions.unshift(el('button', { class: 'btn', type: 'button', text: skipLabel, onclick: () => close(null) }));
    }

    const card = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('div', { class: 'modal-icon', text: icon, 'aria-hidden': 'true' }),
      el('h2', { class: 'modal-title', text: title }),
      message ? el('p', { class: 'modal-text', text: message }) : null,
      el('div', { class: 'modal-fields' }, fieldNodes),
      errorNode,
      el('div', { class: 'modal-actions' }, actions),
    ]);

    const root = el('div', { class: 'modal-backdrop' }, [card]);
    // A click on the backdrop is the same intent as Cancel.
    root.addEventListener('mousedown', (event) => {
      if (event.target === root) close(null);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(root);

    const first = fieldNodes.find((node) => node.dataset.autofocus === 'true') ?? fieldNodes[0];
    first?.focus();
  });
}

/** The local sanity checks a password dialog does before asking the worker. */
function strongEnough(value) {
  if ([...value].length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  return null;
}

/**
 * Ask the user for the password that is set. Resolves with the password or null.
 *
 * Used before a change that weakens protection. The worker is the one that
 * decides whether it is right — this dialog only collects it, so a wrong
 * password comes back as the worker's refusal and the caller shows it.
 */
export async function promptForPassword({ title, message, submitLabel = 'Unlock' } = {}) {
  const result = await askPassword({
    title: title ?? 'Enter your password',
    message: message ?? 'A password protects the Protection switch on this device.',
    icon: '🔒',
    fields: [{ key: 'password', placeholder: 'Password', autofocus: true }],
    submitLabel,
    validate: (values) => (values.password === '' ? 'Enter your password.' : null),
  });
  return result ? result.password : null;
}

/**
 * Offer to create the first password.
 *
 * `skipLabel` makes it an OFFER rather than a wall: the extension works without
 * a password, and the password exists to stop a one-click change on a shared
 * machine, so refusing to let the user past it would be the wrong trade.
 */
export async function promptToCreatePassword({ title, message, skipLabel = 'Not now' } = {}) {
  const result = await askPassword({
    title: title ?? 'Protect your settings',
    message: message ?? 'Set a password so Protection cannot be switched off in one click.',
    icon: '🛡️',
    fields: [
      { key: 'password', placeholder: 'Create a password', autofocus: true },
      { key: 'confirm', placeholder: 'Confirm password' },
    ],
    submitLabel: 'Save password',
    skipLabel,
    validate: (values) => {
      if (values.password !== values.confirm) return 'The two passwords do not match.';
      return strongEnough(values.password);
    },
  });
  return result ? result.password : null;
}

/** Change the password: the current one, then the new one twice. */
export async function promptToChangePassword() {
  const result = await askPassword({
    title: 'Change password',
    message: 'Enter your current password, then choose a new one.',
    icon: '🔑',
    fields: [
      { key: 'current', placeholder: 'Current password', autofocus: true },
      { key: 'next', placeholder: 'New password' },
      { key: 'confirm', placeholder: 'Confirm new password' },
    ],
    submitLabel: 'Update password',
    validate: (values) => {
      if (values.next !== values.confirm) return 'The two new passwords do not match.';
      return strongEnough(values.next);
    },
  });
  return result ?? null;
}

/** Ask for the password one last time before removing it. */
export async function promptToRemovePassword() {
  const result = await askPassword({
    title: 'Remove password',
    message: 'Removing it lets anyone change Protection with a single click.',
    icon: '🔓',
    fields: [{ key: 'password', placeholder: 'Password', autofocus: true }],
    submitLabel: 'Remove password',
    validate: (values) => (values.password === '' ? 'Enter your password.' : null),
  });
  return result ? result.password : null;
}

/**
 * Apply a settings patch that turns protection OFF or removes a blocked item.
 *
 * The change is written by the WORKER, which verifies the password against the
 * stored hash — so a page cannot bypass the lock by skipping this dialog, and a
 * wrong password is reported by the one authority that knows. A wrong entry
 * re-opens the dialog (up to three times) rather than closing it on the user.
 *
 * Enabling a toggle and ADDING an item deliberately do not come through here:
 * the password exists to stop protection being removed, not to make setup or
 * strengthening the filter slower.
 *
 * @returns {{state?: object, cancelled?: boolean, error?: object}}
 */
export async function changeSettingWithPassword({ patch, title, message }) {
  let prompt = message ?? 'Enter your password to turn this protection off.';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const password = await promptForPassword({ title: title ?? 'Confirm this change', message: prompt });
    if (password === null) return { cancelled: true };
    try {
      const state = await send('settings/update', { patch, password });
      return { state };
    } catch (error) {
      if (error?.code !== 'invalid_password') return { error };
      prompt = 'That was not the right password. Try again.';
    }
  }
  return { error: { code: 'invalid_password', message: 'Too many incorrect attempts.' } };
}

/** Turn Protection OFF, asking for the password that is set. */
export async function changeProtectionWithPassword(nextEnabled) {
  // Turning it ON is free (and must stay free): a password that made enabling
  // slower would be a lock that punishes the safe direction. Every caller that
  // disables goes through here; enabling uses a plain settings write.
  if (nextEnabled) {
    try {
      return { state: await send('settings/update', { patch: { protectionEnabled: true } }) };
    } catch (error) {
      return { error };
    }
  }
  return changeSettingWithPassword({
    patch: { protectionEnabled: false },
    title: 'Turn Protection off',
    message: 'Enter your password to turn Protection off.',
  });
}

/** A sentence for a password failure the worker reported. */
export function passwordErrorText(error) {
  if (error?.code === 'invalid_password') return 'That password was not correct.';
  if (error?.code === 'password_too_short') return `Use at least ${MIN_LENGTH} characters.`;
  return errorMessage(error);
}
