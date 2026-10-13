/**
 * The popup — the Block tab, in miniature.
 *
 * A minimalist switchboard: one hero that says whether Protection is on, then
 * the controls a user reaches for mid-browse (ads, Shorts, Brain Bot), then the
 * lists they occasionally add to. Everything that needs explaining — the
 * moderation queue, the server, the identity — stays in the full settings page.
 *
 * Every write goes through the worker, and a Protection change is gated by the
 * local password there, not here. This page only collects the password.
 */

import { BRAIN_BOT_MODES } from '../common/constants.js';
import { normalizeDomain } from '../common/matching.js';
import {
  card,
  clear,
  el,
  errorMessage,
  hero,
  relativeTime,
  section,
  send,
  statusLine,
  switchControl,
  toast,
} from '../ui/shared.js';
import {
  changeProtectionWithPassword,
  passwordErrorText,
  promptToCreatePassword,
} from '../ui/password.js';

const content = document.getElementById('content');

let state = null;

async function refresh() {
  try {
    state = await send('state/get');
    render();
  } catch (error) {
    clear(content);
    content.append(el('div', { class: 'card' }, [el('div', { class: 'empty', text: errorMessage(error) })]));
  }
}

/** Apply a settings patch, re-render, and report failures inline. */
async function patch(next, statusNode, password) {
  try {
    const message = { patch: next };
    if (password !== undefined) message.password = password;
    state = await send('settings/update', message);
    render();
    return true;
  } catch (error) {
    if (statusNode) statusLine(statusNode, errorMessage(error), true);
    else toast(errorMessage(error));
    return false;
  }
}

/** The hero's switch: free when no password is set, gated when one is. */
async function toggleProtection(next) {
  if (!state.passwordSet) {
    await patch({ protectionEnabled: next });
    return;
  }
  const result = await changeProtectionWithPassword(next);
  if (result.cancelled) {
    render(); // put the switch back where it was
    return;
  }
  if (result.error) {
    toast(passwordErrorText(result.error));
    render();
    return;
  }
  state = result.state;
  render();
}

function render() {
  const { settings, global: globalRules, stats, bundleCounts } = state;
  const protectionOn = settings.protectionEnabled;

  clear(content);

  // ── Hero ───────────────────────────────────────────────────────────────
  content.append(
    hero({
      on: protectionOn,
      icon: protectionOn ? '🛡' : '⚠️',
      title: protectionOn ? 'Protection is on' : 'Protection is off',
      subtitle: protectionOn ? 'Websites and searches are being checked' : 'Nothing is being blocked',
      trailing: switchControl(protectionOn, toggleProtection),
    })
  );

  // ── Password offer ─────────────────────────────────────────────────────
  // Offered on the first run only. After that it lives in the settings page's
  // Security section, so the popup is not a nag every time it is opened.
  if (!state.passwordSet && !state.onboarded) {
    content.append(passwordOfferCard());
  }

  // ── YouTube protection ─────────────────────────────────────────────────
  content.append(section('YouTube'));

  content.append(
    card({
      icon: '🚫',
      title: 'Block YouTube ads',
      subtitle: 'Blocks ad requests, removes ad slots and skips video ads.',
      trailing: switchControl(settings.blockYoutubeAds, (value) => patch({ blockYoutubeAds: value }), {
        disabled: !protectionOn,
      }),
      detail: [
        'Ad network requests are refused before they load, and the ad slots are taken out of the page.',
        'A video ad that still starts is skipped, or run out for you, without touching the video you came to watch.',
        'Only requests that originate on YouTube are affected.',
      ],
    }).card
  );

  content.append(
    card({
      icon: '📱',
      title: 'Hide YouTube Shorts',
      subtitle: 'Hides the Shorts entry point and blocks Shorts links.',
      trailing: switchControl(settings.blockShorts, (value) => patch({ blockShorts: value }), {
        disabled: !protectionOn,
      }),
    }).card
  );

  const brainBot = card({
    icon: '🧠',
    title: 'Brain Bot Protection',
    subtitle: 'Filters unwanted videos from YouTube feeds.',
    trailing: switchControl(settings.brainBotEnabled, (value) => patch({ brainBotEnabled: value }), {
      disabled: !protectionOn,
    }),
  });
  if (settings.brainBotEnabled) {
    const status = el('div', { class: 'status-line' });
    brainBot.body.append(
      el('div', { class: 'toggle-group' }, [
        ...BRAIN_BOT_MODES.map((mode) =>
          el('button', {
            class: `btn ${settings.brainBotMode === mode.value ? 'selected' : ''}`,
            type: 'button',
            text: mode.label,
            title: mode.description,
            onclick: () => patch({ brainBotMode: mode.value }, status),
          })
        ),
      ]),
      status
    );
  }
  content.append(brainBot.card);

  content.append(blockedChannelsCard(protectionOn));

  // ── My blocked items ───────────────────────────────────────────────────
  content.append(section('My rules'));

  content.append(
    card({
      icon: '⚠️',
      title: 'Strict Mode',
      subtitle: 'Also blocks discovery words like bikini or lingerie.',
      trailing: switchControl(settings.strictMode, (value) => patch({ strictMode: value }), {
        disabled: !protectionOn,
      }),
    }).card
  );

  content.append(listCard({
    icon: '🌐',
    title: 'Blocked websites',
    subtitle: 'Blocked everywhere you browse.',
    placeholder: 'e.g. youtube.com',
    items: settings.blockedDomains,
    onAdd: (value) => {
      const domain = normalizeDomain(value);
      if (!domain) return { error: 'Enter a website like example.com.' };
      if (settings.blockedDomains.includes(domain)) return { error: 'That website is already blocked.' };
      return { patch: { blockedDomains: [...settings.blockedDomains, domain] } };
    },
    onRemove: (item) => patch({ blockedDomains: settings.blockedDomains.filter((d) => d !== item) }),
  }));

  content.append(listCard({
    icon: '🔤',
    title: 'Blocked keywords',
    subtitle: 'Blocked on every website and search.',
    placeholder: 'e.g. instagram, tiktok',
    items: settings.userKeywords,
    onAdd: (value) => {
      const keyword = value.trim().toLowerCase().replace(/\s+/g, ' ');
      if (keyword === '' || keyword.length > 80) return { error: 'Enter 1 to 80 characters.' };
      if (settings.userKeywords.includes(keyword)) return { error: 'That keyword is already blocked.' };
      return { patch: { userKeywords: [...settings.userKeywords, keyword] } };
    },
    onRemove: (item) => patch({ userKeywords: settings.userKeywords.filter((k) => k !== item) }),
  }));

  // ── Shared blocklist ───────────────────────────────────────────────────
  content.append(section('Community'));
  content.append(globalRulesCard(globalRules));

  // ── Activity ───────────────────────────────────────────────────────────
  content.append(section('Activity'));
  content.append(activityCard(stats));
}

/** The first-run offer: set a password so Protection is not a one-click change. */
function passwordOfferCard() {
  const status = el('div', { class: 'status-line' });

  const dismiss = async () => {
    try {
      await send('password/dismissOnboarding');
      state = await send('state/get');
      render();
    } catch (error) {
      statusLine(status, passwordErrorText(error), true);
    }
  };

  const node = card({
    icon: '🔐',
    title: 'Protect your settings',
    subtitle: 'Set a password so Protection cannot be switched off by anyone at this device.',
    trailing: el('button', {
      class: 'btn primary small',
      type: 'button',
      text: 'Set password',
      onclick: async () => {
        const password = await promptToCreatePassword();
        if (password === null) return;
        try {
          state = await send('password/set', { password });
          render();
          toast('Password saved.');
        } catch (error) {
          statusLine(status, passwordErrorText(error), true);
        }
      },
    }),
  });
  node.body.append(
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn small', type: 'button', text: 'Not now', onclick: dismiss }),
    ]),
    status
  );
  return node.card;
}

/** A card with an add field and removable chips, shared by the two lists. */
function listCard({ icon, title, subtitle, placeholder, items, onAdd, onRemove }) {
  const status = el('div', { class: 'status-line' });
  const chips = el('div', { class: 'chip-list' });

  if (!items || items.length === 0) {
    chips.append(el('div', { class: 'empty', text: 'Nothing here yet. Add one below.' }));
  } else {
    for (const item of items) {
      chips.append(
        el('span', { class: 'chip' }, [
          item,
          el('button', {
            type: 'button',
            text: '✕',
            'aria-label': `Remove ${item}`,
            onclick: () => onRemove(item),
          }),
        ])
      );
    }
  }

  const input = el('input', { class: 'input', placeholder });
  const submit = async () => {
    if (input.value.trim() === '') {
      statusLine(status, 'Type something to add.', true);
      return;
    }
    const outcome = onAdd(input.value);
    if (outcome?.error) {
      statusLine(status, outcome.error, true);
      return;
    }
    input.value = '';
    await patch(outcome.patch, status);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  const node = card({ icon, title, subtitle });
  node.body.append(
    chips,
    el('div', { class: 'field-row popup-field' }, [
      input,
      el('button', { class: 'btn primary', type: 'button', text: 'Add', onclick: submit }),
    ]),
    status
  );
  return node.card;
}

/**
 * The blocked channels, with a one-tap unblock.
 *
 * Removal only, on purpose: asking for a global block is a decision that needs
 * the explanation the full settings page gives it.
 */
function blockedChannelsCard(protectionOn) {
  const channels = state.blockedChannels ?? [];
  const status = el('div', { class: 'status-line' });
  const chips = el('div', { class: 'chip-list' });

  if (channels.length === 0) {
    chips.append(el('div', { class: 'empty', text: 'No channels blocked yet.' }));
  } else {
    for (const channel of channels) {
      const label = channel.handle ?? channel.channelId;
      chips.append(
        el('span', { class: 'chip' }, [
          channel.name ? `${channel.name} · ${label}` : label,
          el('button', {
            type: 'button',
            text: '✕',
            'aria-label': `Unblock ${label}`,
            disabled: !protectionOn,
            onclick: async () => {
              try {
                state = await send('channel/unblock', { label });
                render();
              } catch (error) {
                statusLine(status, errorMessage(error), true);
              }
            },
          }),
        ])
      );
    }
  }

  const node = card({
    icon: '📺',
    title: 'Blocked channels',
    subtitle:
      channels.length === 0
        ? 'Block one from a video’s ⋮ menu.'
        : `${channels.length} blocked — hidden from feeds, and their pages will not open.`,
  });
  node.body.append(chips, status);
  return node.card;
}

/** The shared blocklist: what is global, a refresh, and a submission box. */
function globalRulesCard(globalRules) {
  const status = el('div', { class: 'status-line' });
  const submitStatus = el('div', { class: 'status-line' });

  const node = card({
    icon: '🌍',
    title: 'Shared blocklist',
    subtitle: globalRules.available
      ? `${globalRules.keywordCount} keywords · ${globalRules.channelCount} channels for everyone`
      : 'Not downloaded yet',
    trailing: el('button', {
      class: 'btn small',
      type: 'button',
      text: 'Check for updates',
      onclick: async () => {
        statusLine(status, 'Checking…');
        try {
          const result = await send('rules/sync', { force: true });
          state = result.state;
          render();
        } catch (error) {
          statusLine(status, errorMessage(error), true);
        }
      },
    }),
  });

  node.body.append(
    el('div', {
      class: 'empty',
      text: globalRules.available
        ? `Last checked ${relativeTime(globalRules.fetchedAt)} · version ${globalRules.version ?? '—'}`
        : 'Your own rules still apply while the shared list is unavailable.',
    }),
    status
  );

  const input = el('input', { class: 'input', placeholder: 'Suggest a keyword for everyone' });
  const submit = async () => {
    const keyword = input.value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (keyword === '') {
      statusLine(submitStatus, 'Type a keyword to suggest.', true);
      return;
    }
    try {
      await send('submission/create', { kind: 'keyword', value: keyword });
      input.value = '';
      statusLine(submitStatus, 'Sent for review. An administrator decides before it applies.');
    } catch (error) {
      statusLine(submitStatus, errorMessage(error), true);
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  node.body.append(
    el('div', { class: 'field-row popup-field' }, [
      input,
      el('button', { class: 'btn', type: 'button', text: 'Send', onclick: submit }),
    ]),
    submitStatus
  );

  return node.card;
}

function activityCard(stats) {
  const total = stats.total ?? 0;
  const node = card({
    icon: '📊',
    title: 'Recent activity',
    subtitle: `${total} item${total === 1 ? '' : 's'} blocked on this device`,
    trailing: el('button', {
      class: 'btn small',
      type: 'button',
      text: 'Reset',
      onclick: async () => {
        try {
          state = await send('stats/reset');
          render();
        } catch (error) {
          toast(errorMessage(error));
        }
      },
    }),
  });
  node.body.append(
    el('div', {
      class: 'empty',
      text: stats.lastAt
        ? `Last blocked ${relativeTime(stats.lastAt)}.`
        : 'Nothing blocked yet. Protection is watching.',
    })
  );
  return node.card;
}

// ── Footer ───────────────────────────────────────────────────────────────

const openOptions = () => chrome.runtime.openOptionsPage();
document.getElementById('open-options').addEventListener('click', openOptions);
document.getElementById('open-options-footer').addEventListener('click', openOptions);
document.getElementById('open-admin').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/admin/admin.html') });
});

void refresh();
