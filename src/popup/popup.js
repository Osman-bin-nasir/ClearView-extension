/**
 * The popup — the Block tab, in miniature.
 *
 * It shows the same sections, in the same order, as the Android Block tab, and
 * every control writes the same setting the options page does. Where the app has
 * a whole screen for something (the keyword manager, the review queue), the popup
 * shows the count and links out, so it stays a quick switchboard rather than a
 * cramped copy.
 */

import { BRAIN_BOT_MODES } from '../common/constants.js';
import { normalizeDomain } from '../common/matching.js';
import {
  card,
  clear,
  el,
  errorMessage,
  relativeTime,
  section,
  send,
  statusLine,
  switchControl,
} from '../ui/shared.js';

const content = document.getElementById('content');
const protectionStatus = document.getElementById('protection-status');

let state = null;

async function refresh() {
  try {
    state = await send('state/get');
    render();
  } catch (error) {
    clear(content);
    content.append(
      el('div', { class: 'card' }, [el('div', { class: 'empty', text: errorMessage(error) })])
    );
  }
}

/** Apply a settings patch, re-render, and report failures inline. */
async function patch(next, statusNode) {
  try {
    state = await send('settings/update', { patch: next });
    render();
    return true;
  } catch (error) {
    if (statusNode) statusLine(statusNode, errorMessage(error), true);
    return false;
  }
}

function render() {
  const { settings, global: globalRules, stats, bundleCounts } = state;

  protectionStatus.textContent = settings.protectionEnabled
    ? 'Protection active — monitoring websites and searches'
    : 'Protection is off';

  clear(content);
  const protectionOn = settings.protectionEnabled;

  // ── Protection ─────────────────────────────────────────────────────────
  content.append(
    card({
      icon: '🔒',
      title: 'Protection',
      subtitle: protectionOn ? 'Active — blocking websites and searches' : 'Off — nothing is blocked',
      trailing: switchControl(protectionOn, (value) => patch({ protectionEnabled: value })),
      detail: [
        'Built-in adult filter — always on while Protection is on.',
        `Blocked hosts: ${bundleCounts.domains} · keywords: ${bundleCounts.builtIn + bundleCounts.everywhere}`,
        'Your own keywords apply alongside the built-in ones.',
      ],
    }).card
  );

  // ── YouTube protection ─────────────────────────────────────────────────
  content.append(section('YouTube protection'));

  const brainBot = card({
    icon: '🧠',
    title: 'Brain Bot Protection',
    subtitle: 'Filter unwanted videos from YouTube feeds.',
    trailing: switchControl(settings.brainBotEnabled, (value) => patch({ brainBotEnabled: value }), {
      disabled: !protectionOn,
    }),
  });
  if (settings.brainBotEnabled) {
    const status = el('div', { class: 'status-line' });
    const group = el('div', { class: 'toggle-group' }, [
      ...BRAIN_BOT_MODES.map((mode) =>
        el('button', {
          class: `btn ${settings.brainBotMode === mode.value ? 'selected' : ''}`,
          type: 'button',
          text: mode.label,
          title: mode.description,
          onclick: () => patch({ brainBotMode: mode.value }, status),
        })
      ),
    ]);
    brainBot.body.append(group, status);
  }
  content.append(brainBot.card);

  content.append(
    card({
      icon: '▶️',
      title: 'Block YouTube Shorts',
      subtitle: 'Hides the Shorts entry point. Direct Shorts links still play.',
      trailing: switchControl(settings.blockShorts, (value) => patch({ blockShorts: value }), {
        disabled: !protectionOn,
      }),
    }).card
  );

  // ── My blocked items ───────────────────────────────────────────────────
  content.append(section('My blocked items'));

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

  content.append(blockedSitesCard());
  content.append(keywordCard());

  // ── Shared blocklist ───────────────────────────────────────────────────
  content.append(section('Shared blocklist'));
  content.append(globalRulesCard(globalRules));

  // ── Activity ───────────────────────────────────────────────────────────
  content.append(section('Protection activity'));
  const resetStatus = el('div', { class: 'status-line' });
  const activity = card({
    icon: '📊',
    title: 'Recent activity',
    subtitle: `${stats.total ?? 0} item${(stats.total ?? 0) === 1 ? '' : 's'} blocked on this device`,
    trailing: el('button', {
      class: 'btn small',
      type: 'button',
      text: 'Reset',
      onclick: async () => {
        try {
          state = await send('stats/reset');
          render();
        } catch (error) {
          statusLine(resetStatus, errorMessage(error), true);
        }
      },
    }),
  });
  activity.body.append(
    el('div', {
      class: 'empty',
      text: stats.lastAt ? `Last blocked ${relativeTime(stats.lastAt)}.` : 'Nothing blocked yet. Protection is watching.',
    }),
    resetStatus
  );
  content.append(activity.card);
}

/** The user's blocked hostnames, with an inline add field. */
function blockedSitesCard() {
  const { settings } = state;
  const status = el('div', { class: 'status-line' });
  const chips = el('div', { class: 'chip-list' });

  if (settings.blockedDomains.length === 0) {
    chips.append(el('div', { class: 'empty', text: 'No websites blocked yet. Add one below.' }));
  } else {
    for (const domain of settings.blockedDomains) {
      chips.append(
        el('span', { class: 'chip' }, [
          domain,
          el('button', {
            type: 'button',
            text: '✕',
            'aria-label': `Unblock ${domain}`,
            onclick: () => patch({ blockedDomains: settings.blockedDomains.filter((d) => d !== domain) }, status),
          }),
        ])
      );
    }
  }

  const input = el('input', { class: 'input', placeholder: 'e.g. youtube.com', id: 'add-domain' });
  const submit = async () => {
    const domain = normalizeDomain(input.value);
    if (!domain) {
      statusLine(status, 'Enter a website like example.com.', true);
      return;
    }
    if (settings.blockedDomains.includes(domain)) {
      statusLine(status, 'That website is already blocked.');
      return;
    }
    input.value = '';
    await patch({ blockedDomains: [...settings.blockedDomains, domain] }, status);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  const cardNode = card({
    icon: '🚫',
    title: 'Blocked websites',
    subtitle: 'Blocked everywhere you browse.',
  });
  cardNode.body.append(
    chips,
    el('div', { class: 'field-row popup-field' }, [
      input,
      el('button', { class: 'btn primary', type: 'button', text: 'Block', onclick: submit }),
    ]),
    status
  );
  return cardNode.card;
}

/** The user's own keywords, with an inline add field. */
function keywordCard() {
  const { settings } = state;
  const status = el('div', { class: 'status-line' });
  const chips = el('div', { class: 'chip-list' });

  if (settings.userKeywords.length === 0) {
    chips.append(el('div', { class: 'empty', text: 'No keywords yet. Add one below.' }));
  } else {
    for (const keyword of settings.userKeywords) {
      chips.append(
        el('span', { class: 'chip' }, [
          keyword,
          el('button', {
            type: 'button',
            text: '✕',
            'aria-label': `Remove ${keyword}`,
            onclick: () => patch({ userKeywords: settings.userKeywords.filter((k) => k !== keyword) }, status),
          }),
        ])
      );
    }
  }

  const input = el('input', { class: 'input', placeholder: 'e.g. instagram, tiktok', id: 'add-keyword' });
  const submit = async () => {
    const keyword = input.value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (keyword === '' || keyword.length > 80) {
      statusLine(status, 'Enter a keyword between 1 and 80 characters.', true);
      return;
    }
    if (settings.userKeywords.includes(keyword)) {
      statusLine(status, 'That keyword is already blocked.');
      return;
    }
    input.value = '';
    await patch({ userKeywords: [...settings.userKeywords, keyword] }, status);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  const cardNode = card({
    icon: '🔤',
    title: 'Blocked keywords',
    subtitle: 'Blocked on every website and search.',
  });
  cardNode.body.append(
    chips,
    el('div', { class: 'field-row popup-field' }, [
      input,
      el('button', { class: 'btn primary', type: 'button', text: 'Block', onclick: submit }),
    ]),
    status
  );
  return cardNode.card;
}

/** The shared blocklist: what is global, a refresh, and a submission box. */
function globalRulesCard(globalRules) {
  const status = el('div', { class: 'status-line' });
  const submitStatus = el('div', { class: 'status-line' });

  const refreshButton = el('button', {
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
  });

  const cardNode = card({
    icon: '🌍',
    title: 'Shared blocklist',
    subtitle: globalRules.available
      ? `${globalRules.keywordCount} keywords · ${globalRules.channelCount} channels blocked for everyone`
      : 'No rules downloaded yet',
    trailing: refreshButton,
  });

  cardNode.body.append(
    el('div', {
      class: 'empty',
      text: globalRules.available
        ? `Last checked ${relativeTime(globalRules.fetchedAt)} · version ${globalRules.version ?? '—'}`
        : 'Your own rules still apply while the shared list is unavailable.',
    }),
    status
  );

  // Submission: a keyword the user wants blocked for everyone. Inert until an
  // administrator approves it.
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
      statusLine(submitStatus, 'Sent for review. An administrator decides before it applies to anyone.');
    } catch (error) {
      statusLine(submitStatus, errorMessage(error), true);
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  cardNode.body.append(
    el('div', { class: 'field-row popup-field' }, [
      input,
      el('button', { class: 'btn', type: 'button', text: 'Ask to block', onclick: submit }),
    ]),
    submitStatus,
    el('div', { class: 'hint', text: 'Approved suggestions reach every participating install.' })
  );

  return cardNode.card;
}

document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('open-admin').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/admin/admin.html') });
});

void refresh();
