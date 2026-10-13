/**
 * The options page — the whole Block tab.
 *
 * It follows the Android app's section order: Protection, then YouTube
 * protection, then the user's own items, then the shared repository, then
 * activity, then the setup-once settings. The Android-only cards (device admin,
 * uninstall protection, the block-tab password, DNS) are deliberately absent —
 * they are protections of the PHONE, and offering them in a browser would be
 * controls that cannot do anything.
 */

import { BRAIN_BOT_MODES, SUBMISSION_STATUS } from '../common/constants.js';
import { normalizeDomain } from '../common/matching.js';
import { normalizeHandle } from '../common/rules-bundle.js';
import {
  card,
  clear,
  el,
  errorMessage,
  pill,
  relativeTime,
  section,
  send,
  statusLine,
  switchControl,
} from '../ui/shared.js';

const content = document.getElementById('content');
const toastNode = document.getElementById('toast');
const scopeNode = document.getElementById('protection-scope');

let state = null;
let submissions = null;
let submissionsError = null;
let toastTimer = null;

function notify(message) {
  toastNode.textContent = message;
  toastNode.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.add('hidden'), 3200);
}

async function refresh() {
  try {
    state = await send('state/get');
    render();
  } catch (error) {
    clear(content);
    content.append(el('div', { class: 'card' }, [el('div', { class: 'empty', text: errorMessage(error) })]));
  }
}

async function patch(next, statusNode) {
  try {
    state = await send('settings/update', { patch: next });
    render();
    return true;
  } catch (error) {
    if (statusNode) statusLine(statusNode, errorMessage(error), true);
    else notify(errorMessage(error));
    return false;
  }
}

// ── Render ───────────────────────────────────────────────────────────────

function render() {
  const { settings, global: globalRules, stats, anonymousId, bundleCounts } = state;
  const protectionOn = settings.protectionEnabled;

  scopeNode.textContent = protectionOn
    ? 'Protection is active. It applies to websites you visit in Chrome and to Google Search.'
    : 'Protection is off — nothing is being blocked.';

  clear(content);

  content.append(
    card({
      icon: protectionOn ? '🔒' : '🔓',
      title: 'Protection',
      subtitle: protectionOn ? 'Active — monitoring websites and searches' : 'Off — nothing is blocked',
      trailing: switchControl(protectionOn, (value) => patch({ protectionEnabled: value })),
      detail: [
        'The built-in adult filter, your blocked websites, your keywords and any shared rules all apply while Protection is on.',
        'Turning Protection off stops every block immediately — websites, searches, Shorts and Brain Bot alike.',
        `Rules in force: ${bundleCounts.domains} hosts · ${bundleCounts.builtIn + bundleCounts.everywhere} keywords · ${bundleCounts.channels} channels`,
      ],
    }).card
  );

  // ── YouTube protection ─────────────────────────────────────────────────
  content.append(section('YouTube protection'));
  content.append(brainBotCard(protectionOn));
  content.append(shortsCard(protectionOn));
  content.append(
    managerCard({
      icon: '🔤',
      title: 'Brain Bot keywords',
      subtitle: 'Matched against YouTube titles only — never against other websites.',
      placeholder: 'e.g. a phrase you keep seeing',
      items: settings.youtubeKeywords,
      disabled: !protectionOn,
      emptyText: 'No YouTube-only keywords yet.',
      onAdd: (value) => addTo('youtubeKeywords', value.trim().toLowerCase().replace(/\s+/g, ' ')),
      onRemove: (item) => patch({ youtubeKeywords: settings.youtubeKeywords.filter((k) => k !== item) }),
    })
  );
  content.append(
    managerCard({
      icon: '📺',
      title: 'Blocked channels',
      subtitle: 'Channels are stored by their @handle, so a rename never loses the block.',
      placeholder: '@channelhandle',
      items: settings.blockedChannels.map((c) => c.handle),
      disabled: !protectionOn,
      emptyText: 'No channels blocked yet.',
      onAdd: async (value) => {
        const handle = normalizeHandle(value);
        if (!handle) {
          notify('Enter a channel handle like @examplechannel.');
          return false;
        }
        return patch({
          blockedChannels: [...settings.blockedChannels.filter((c) => c.handle !== handle), { handle, name: null }],
        });
      },
      onRemove: (item) => patch({ blockedChannels: settings.blockedChannels.filter((c) => c.handle !== item) }),
    })
  );

  // ── My blocked items ───────────────────────────────────────────────────
  content.append(section('My blocked items'));
  content.append(
    card({
      icon: '⚠️',
      title: 'Strict Mode',
      subtitle: 'Also blocks discovery words like bikini, lingerie or cleavage.',
      trailing: switchControl(settings.strictMode, (value) => patch({ strictMode: value }), {
        disabled: !protectionOn,
      }),
      detail: [
        'Adds a curated list of risky-but-innocent discovery terms on top of the always-on adult filter.',
        'Gender and family words (women, girl, mom, wife, ...) are never blocked alone — they only block combined with an adult term.',
        'When Strict Mode is off, only the always-on adult terms block.',
      ],
    }).card
  );
  content.append(
    managerCard({
      icon: '🚫',
      title: 'Blocked websites',
      subtitle: 'Blocked everywhere you browse.',
      placeholder: 'e.g. youtube.com, reddit.com',
      items: settings.blockedDomains,
      disabled: !protectionOn,
      emptyText: 'No websites blocked yet.',
      onAdd: async (value) => {
        const domain = normalizeDomain(value);
        if (!domain) {
          notify('Enter a website like example.com.');
          return false;
        }
        return patch({ blockedDomains: [...new Set([...settings.blockedDomains, domain])] });
      },
      onRemove: (item) => patch({ blockedDomains: settings.blockedDomains.filter((d) => d !== item) }),
    })
  );
  content.append(
    managerCard({
      icon: '🔤',
      title: 'Blocked keywords',
      subtitle: 'Blocked on every website and every search.',
      placeholder: 'e.g. instagram, tiktok',
      items: settings.userKeywords,
      disabled: !protectionOn,
      emptyText: 'No keywords yet.',
      onAdd: (value) => addTo('userKeywords', value.trim().toLowerCase().replace(/\s+/g, ' ')),
      onRemove: (item) => patch({ userKeywords: settings.userKeywords.filter((k) => k !== item) }),
    })
  );

  // ── Shared blocklist ───────────────────────────────────────────────────
  content.append(section('Shared blocklist'));
  content.append(globalRulesCard(globalRules));
  content.append(submissionsCard(globalRules));
  content.append(suggestCard());

  // ── Activity ───────────────────────────────────────────────────────────
  content.append(section('Protection activity'));
  content.append(activityCard(stats));

  // ── Advanced ───────────────────────────────────────────────────────────
  content.append(section('Advanced'));
  content.append(serverCard(settings));
  content.append(identityCard(anonymousId));
  content.append(
    card({
      icon: '🕵️',
      title: 'Privacy',
      subtitle: 'Nothing here is linked to who you are.',
      detail: [
        'Websites and searches are checked on your device and never uploaded.',
        'Community suggestions are sent with a random install id, not an account or a device identifier.',
        'No account or sign-up is needed to use the extension.',
      ],
    }).card
  );
}

// ── Cards ────────────────────────────────────────────────────────────────

function brainBotCard(protectionOn) {
  const status = el('div', { class: 'status-line' });
  const node = card({
    icon: '🧠',
    title: 'Brain Bot Protection',
    subtitle: 'Filter unwanted content from YouTube feeds using keywords and channels.',
    trailing: switchControl(state.settings.brainBotEnabled, (value) => patch({ brainBotEnabled: value }), {
      disabled: !protectionOn,
    }),
  });

  if (state.settings.brainBotEnabled) {
    node.body.append(
      el('div', { class: 'toggle-group' }, [
        ...BRAIN_BOT_MODES.map((mode) =>
          el('button', {
            class: `btn ${state.settings.brainBotMode === mode.value ? 'selected' : ''}`,
            type: 'button',
            text: mode.label,
            onclick: () => patch({ brainBotMode: mode.value }, status),
          })
        ),
      ]),
      el('div', {
        class: 'mode-note',
        text:
          BRAIN_BOT_MODES.find((m) => m.value === state.settings.brainBotMode)?.description ?? '',
      }),
      status
    );
  } else {
    node.body.append(
      el('div', { class: 'mode-note', text: 'Off — YouTube feeds are shown unfiltered.' })
    );
  }
  return node.card;
}

function shortsCard(protectionOn) {
  return card({
    icon: '▶️',
    title: 'Block YouTube Shorts',
    subtitle: 'Hides the Shorts entry point in YouTube navigation.',
    trailing: switchControl(state.settings.blockShorts, (value) => patch({ blockShorts: value }), {
      disabled: !protectionOn,
    }),
    detail: [
      'Removes the Shorts link from the YouTube guide and chip bar.',
      'Direct Shorts links still open and play — this hides the entry point, it does not block the format.',
      'Regular YouTube browsing is unaffected.',
    ],
  }).card;
}

/** A list with add/remove, used for keywords, domains and channels. */
function managerCard({ icon, title, subtitle, placeholder, items, onAdd, onRemove, disabled, emptyText }) {
  const status = el('div', { class: 'status-line' });
  const node = card({ icon, title, subtitle });

  const chips = el('div', { class: 'chip-list' });
  if (!items || items.length === 0) {
    chips.append(el('div', { class: 'empty', text: emptyText }));
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

  const input = el('input', { class: 'input', placeholder, disabled: disabled ? true : false });
  let adding = false;
  const submit = async () => {
    if (adding) return;
    adding = true;
    try {
      const value = input.value;
      if (value.trim() === '') {
        statusLine(status, 'Type something to add.', true);
        return;
      }
      const ok = await onAdd(value);
      if (ok !== false) input.value = '';
    } finally {
      adding = false;
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  node.body.append(
    chips,
    el('div', { class: 'field-row', style: 'margin-top:10px' }, [
      input,
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Add',
        disabled: disabled ? true : false,
        onclick: submit,
      }),
    ]),
    status
  );
  return node.card;
}

/** Add to a string-list setting, refusing duplicates with a worded reason. */
function addTo(key, value) {
  const list = state.settings[key] ?? [];
  if (value === '' || value.length > 80) {
    notify('Enter a keyword between 1 and 80 characters.');
    return false;
  }
  if (list.includes(value)) {
    notify('That is already on the list.');
    return false;
  }
  return patch({ [key]: [...list, value] });
}

function globalRulesCard(globalRules) {
  const status = el('div', { class: 'status-line' });
  const node = card({
    icon: '🌍',
    title: 'Shared blocklist',
    subtitle: globalRules.available
      ? `${globalRules.keywordCount} keywords · ${globalRules.channelCount} channels blocked for everyone`
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
          if (result.result.changed) notify('Shared blocklist updated.');
          else if (result.result.reason === 'failed') statusLine(status, 'Could not reach the server. Your rules are unchanged.', true);
          render();
        } catch (error) {
          statusLine(status, errorMessage(error), true);
        }
      },
    }),
    detail: [
      'Rules an administrator approved for everyone, applied automatically alongside your own.',
      'Downloaded rules are cached, so protection continues when the server is unreachable.',
      'The list is only replaced once a newer version has been fetched in full.',
    ],
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
  return node.card;
}

function submissionsCard(globalRules) {
  const node = card({
    icon: '📨',
    title: 'My submissions',
    subtitle: 'What you asked to be blocked for everyone, and where each request stands.',
    trailing: el('button', {
      class: 'btn small',
      type: 'button',
      text: 'Refresh',
      onclick: () => void loadSubmissions(true),
    }),
  });
  const list = el('div', { class: 'list', id: 'submissions-list' });
  node.body.append(list, el('div', { class: 'status-line', id: 'submissions-status' }));
  renderSubmissions(globalRules);
  return node.card;
}

function renderSubmissions(globalRules) {
  const list = document.getElementById('submissions-list');
  const status = document.getElementById('submissions-status');
  if (!list) return;
  clear(list);

  if (submissionsError) {
    statusLine(status, submissionsError, true);
    return;
  }
  if (submissions === null) {
    statusLine(status, 'Loading…');
    return;
  }
  statusLine(status, '');
  if (submissions.length === 0) {
    list.append(el('div', { class: 'empty', text: 'You have not submitted anything yet.' }));
    return;
  }

  // An approved rule the shared list no longer carries reads "Removed" rather
  // than a stale "Approved" — the same reasoning as the app's
  // SubmissionStatusResolver, so the screen never claims something is blocked
  // for everyone when it is not.
  const liveKeywords = new Set((globalRules.liveKeywords ?? []).map((k) => k.toLowerCase()));
  const liveChannels = new Set((globalRules.liveChannels ?? []).map((c) => String(c).toLowerCase()));

  for (const submission of submissions) {
    const live = submission.kind === 'keyword'
      ? liveKeywords.has(String(submission.value).toLowerCase())
      : liveChannels.has(String(submission.value).toLowerCase());
    const display =
      submission.status === 'approved' && !live ? 'removed' : submission.status;
    const kind = display === 'approved' ? 'ok' : display === 'pending' || display === 'under_review' ? 'pending' : 'rejected';

    list.append(
      el('div', { class: 'list-row' }, [
        el('span', { class: 'grow', text: submission.value }),
        el('span', { class: 'meta', text: relativeTime(Date.parse(submission.createdAt)) }),
        pill(SUBMISSION_STATUS[display] ?? display, kind),
      ])
    );
  }
}

function suggestCard() {
  const status = el('div', { class: 'status-line' });
  const kindSelect = el('select', { class: 'select' }, [
    el('option', { value: 'keyword', text: 'Keyword' }),
    el('option', { value: 'channel', text: 'Channel handle' }),
  ]);
  const input = el('input', { class: 'input', placeholder: 'e.g. a keyword or @channelhandle' });

  const submit = async () => {
    const kind = kindSelect.value;
    const raw = input.value.trim();
    if (raw === '') {
      statusLine(status, 'Type something to suggest.', true);
      return;
    }
    const value = kind === 'channel' ? normalizeHandle(raw) : raw.toLowerCase().replace(/\s+/g, ' ');
    if (kind === 'channel' && !value) {
      statusLine(status, 'Enter a channel handle like @examplechannel.', true);
      return;
    }
    try {
      await send('submission/create', { kind, value });
      input.value = '';
      statusLine(status, 'Sent for review. An administrator decides before it applies to anyone.');
      await loadSubmissions(false);
    } catch (error) {
      statusLine(status, errorMessage(error), true);
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  const node = card({
    icon: '✉️',
    title: 'Ask to block it for everyone',
    subtitle: 'An administrator reviews each request before it applies to anyone.',
    detail: [
      'One request never changes what everyone else blocks on its own.',
      'Requests are sent with a random install id — no account is required.',
      'Approved requests are distributed to every participating install.',
    ],
  });
  node.body.append(
    el('div', { class: 'field-row' }, [kindSelect, input]),
    el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
      el('button', { class: 'btn primary', type: 'button', text: 'Send for review', onclick: submit }),
    ]),
    status
  );
  return node.card;
}

function activityCard(stats) {
  const status = el('div', { class: 'status-line' });
  const node = card({
    icon: '📊',
    title: 'Recent activity',
    subtitle: 'What ClearView blocked on this device.',
    trailing: el('button', {
      class: 'btn small',
      type: 'button',
      text: 'Reset activity',
      onclick: async () => {
        try {
          state = await send('stats/reset');
          render();
        } catch (error) {
          statusLine(status, errorMessage(error), true);
        }
      },
    }),
  });

  const byReason = stats.byReason ?? {};
  node.body.append(
    el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-value', text: String(stats.total ?? 0) }),
        el('div', { class: 'stat-label', text: 'Content blocked' }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-value', text: String(byReason.search ?? 0) }),
        el('div', { class: 'stat-label', text: 'Searches' }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-value', text: String(byReason.domain ?? 0) }),
        el('div', { class: 'stat-label', text: 'Websites' }),
      ]),
    ])
  );

  const recent = stats.recent ?? [];
  const list = el('div', { class: 'list' });
  if (recent.length === 0) {
    list.append(el('div', { class: 'empty', text: 'Nothing blocked yet. Protection is watching.' }));
  } else {
    for (const entry of recent.slice(0, 8)) {
      list.append(
        el('div', { class: 'list-row' }, [
          el('span', { class: 'grow', text: entry.detail || entry.reason }),
          el('span', { class: 'meta', text: relativeTime(entry.at) }),
        ])
      );
    }
  }
  node.body.append(list, status);
  return node.card;
}

function serverCard(settings) {
  const status = el('div', { class: 'status-line' });
  const input = el('input', { class: 'input', value: settings.apiBase });
  const node = card({
    icon: '🔌',
    title: 'Backend server',
    subtitle: 'Where shared rules and review requests are exchanged.',
    detail: [
      'Defaults to the ClearView server the app uses. Change it only for self-hosting or development.',
      'The extension asks for permission to reach a new host the first time you save it.',
    ],
  });
  node.body.append(
    el('div', { class: 'field-row' }, [
      input,
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Save',
        onclick: async () => {
          let origin;
          try {
            origin = new URL(input.value).origin;
          } catch {
            statusLine(status, 'Enter a valid server URL.', true);
            return;
          }
          try {
            const pattern = `${origin}/*`;
            const has = await chrome.permissions.contains({ origins: [pattern] });
            if (!has) {
              const granted = await chrome.permissions.request({ origins: [pattern] });
              if (!granted) {
                statusLine(status, 'Permission for that server was not granted. Nothing changed.', true);
                return;
              }
            }
            await patch({ apiBase: input.value.replace(/\/+$/, '') }, status);
            statusLine(status, 'Saved.');
          } catch (error) {
            statusLine(status, errorMessage(error), true);
          }
        },
      }),
    ]),
    status
  );
  return node.card;
}

function identityCard(anonymousId) {
  const status = el('div', { class: 'status-line' });
  const node = card({
    icon: '🎭',
    title: 'Anonymous identity',
    subtitle: 'The random id your contributions are sent with.',
    detail: [
      'Generated on this device and derived from nothing about you — no account, no device id.',
      'Regenerating it costs at most a duplicate report; nothing else is lost.',
    ],
  });
  node.body.append(
    el('div', { class: 'identity', text: anonymousId }),
    el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'New identity',
        onclick: async () => {
          try {
            state = await send('identity/regenerate');
            render();
            notify('A new anonymous id was generated.');
          } catch (error) {
            statusLine(status, errorMessage(error), true);
          }
        },
      }),
    ]),
    status
  );
  return node.card;
}

// ── Submissions loading ──────────────────────────────────────────────────

async function loadSubmissions(showSpinner) {
  const status = document.getElementById('submissions-status');
  if (showSpinner && status) statusLine(status, 'Refreshing…');
  try {
    const result = await send('submissions/list');
    submissions = result.submissions;
    submissionsError = null;
  } catch (error) {
    submissionsError = errorMessage(error);
    submissions = [];
  }
  renderSubmissions(state?.global ?? {});
}

// ── Boot ─────────────────────────────────────────────────────────────────

document.getElementById('open-admin').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/admin/admin.html') });
});

void (async () => {
  await refresh();
  await loadSubmissions(false);
})();
