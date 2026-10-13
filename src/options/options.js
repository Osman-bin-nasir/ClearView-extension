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
import { BLOCK_SOURCES } from '../common/channels.js';
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
import {
  changeProtectionWithPassword,
  passwordErrorText,
  promptToChangePassword,
  promptToCreatePassword,
  promptToRemovePassword,
} from '../ui/password.js';

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

/** The Protection switch: free with no password, gated by the worker when one is set. */
async function toggleProtection(next) {
  if (!state.passwordSet) {
    await patch({ protectionEnabled: next });
    return;
  }
  const result = await changeProtectionWithPassword(next);
  if (result.cancelled) {
    render();
    return;
  }
  if (result.error) {
    notify(passwordErrorText(result.error));
    render();
    return;
  }
  state = result.state;
  render();
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
      trailing: switchControl(protectionOn, toggleProtection),
      detail: [
        'The built-in adult filter, your blocked websites, your keywords and any shared rules all apply while Protection is on.',
        'Turning Protection off stops every block immediately — websites, searches, Shorts and Brain Bot alike.',
        `Rules in force: ${bundleCounts.domains} hosts · ${bundleCounts.builtIn + bundleCounts.everywhere} keywords · ${bundleCounts.channels} channels`,
      ],
    }).card
  );

  // ── YouTube protection ─────────────────────────────────────────────────
  content.append(section('YouTube protection'));
  content.append(adsCard(protectionOn));
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
  content.append(blockedChannelsCard(protectionOn));

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

  // ── Security ───────────────────────────────────────────────────────────
  content.append(section('Security'));
  content.append(passwordCard());

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

/**
 * YouTube ads.
 *
 * The checkbox that makes the feature discoverable and gives it an off switch.
 * The actual work is two-layered: a declarativeNetRequest ruleset (ad network
 * requests, refused before they load) and the content script (ad slots removed
 * from the page, and a video ad skipped). Both follow this switch.
 */
function adsCard(protectionOn) {
  return card({
    icon: '🚫',
    title: 'Block YouTube ads',
    subtitle: 'Blocks ad requests, removes ad slots and skips video ads.',
    trailing: switchControl(state.settings.blockYoutubeAds, (value) => patch({ blockYoutubeAds: value }), {
      disabled: !protectionOn,
    }),
    detail: [
      'Ad requests that originate on YouTube are refused before they load, so most ads never arrive.',
      'Ad slots left in the page are removed, so the feed and the sidebar have no holes or placeholders.',
      'A video ad that still starts is skipped with YouTube’s own control, or run out for you — the ad is muted while it runs and unmuted the moment the real video resumes.',
      'Nothing outside YouTube is affected.',
    ],
  }).card;
}

/**
 * The Protection password.
 *
 * Three states, one card: not set (offer to set it), set (change or remove), and
 * the explanation of what it is. The wording is deliberate — this is a device
 * lock, not an account, and pretending it were stronger would be a false claim.
 */
function passwordCard() {
  const status = el('div', { class: 'status-line' });
  const isSet = Boolean(state.passwordSet);

  const actions = [];
  if (isSet) {
    actions.push(
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Change password',
        onclick: async () => {
          const result = await promptToChangePassword();
          if (!result) return;
          try {
            await send('password/change', { current: result.current, next: result.next });
            state = await send('state/get');
            render();
            notify('Password updated.');
          } catch (error) {
            statusLine(status, passwordErrorText(error), true);
          }
        },
      }),
      el('button', {
        class: 'btn danger',
        type: 'button',
        text: 'Remove password',
        onclick: async () => {
          const password = await promptToRemovePassword();
          if (password === null) return;
          try {
            state = await send('password/remove', { password });
            render();
            notify('Password removed.');
          } catch (error) {
            statusLine(status, passwordErrorText(error), true);
          }
        },
      })
    );
  } else {
    actions.push(
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Create password',
        onclick: async () => {
          const password = await promptToCreatePassword({ skipLabel: '' });
          if (password === null) return;
          try {
            state = await send('password/set', { password });
            render();
            notify('Password saved.');
          } catch (error) {
            statusLine(status, passwordErrorText(error), true);
          }
        },
      })
    );
  }

  const node = card({
    icon: isSet ? '🔐' : '🔓',
    title: 'Protection password',
    subtitle: isSet
      ? `Required to change Protection${state.passwordAt ? ` · set ${relativeTime(state.passwordAt)}` : ''}`
      : 'Not set — Protection can be changed with one click.',
    detail: [
      'The password is asked for whenever Protection is turned on or off from any screen.',
      'It is stored as a one-way hash on this device only — never synced, and never sent anywhere.',
      'This is a device lock for a shared machine, not an account: it cannot hide anything from someone with full access to this browser profile.',
    ],
  });
  node.body.append(el('div', { class: 'btn-row' }, actions), status);
  return node.card;
}

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
    subtitle: 'Hides the Shorts entry point and blocks Shorts links.',
    trailing: switchControl(state.settings.blockShorts, (value) => patch({ blockShorts: value }), {
      disabled: !protectionOn,
    }),
    detail: [
      'Removes the Shorts link from the YouTube guide and chip bar.',
      'Opening a Shorts link directly is blocked too, so the toggle cannot be walked around by pasting a URL.',
      'Regular YouTube watch pages, search and subscriptions are unaffected.',
    ],
  }).card;
}

/**
 * The blocked channels, and the two things that can be done with each.
 *
 * A card of its own rather than the generic chip list, because a channel is not
 * a string: it carries the display name the user recognises, the @handle that
 * is its stored identity, the channel id when the page offered one, where the
 * block came from, and — the part the shared repository needs — whether it can
 * be submitted at all.
 */
function blockedChannelsCard(protectionOn) {
  const status = el('div', { class: 'status-line' });
  const node = card({
    icon: '📺',
    title: 'Blocked channels',
    subtitle: 'Their videos leave your YouTube feeds, and their channel page and videos will not open.',
    detail: [
      'Add one from a video: open its ⋮ menu and choose “Block this channel”, or right-click a thumbnail.',
      'Channels are stored by their @handle, so a channel rename never loses the block. The channel id is kept too, when the page offered one.',
      'Asking to block a channel for everyone sends a request for review — it never changes what anyone else blocks on its own.',
    ],
  });

  const channels = state.blockedChannels ?? [];
  const list = el('div', { class: 'list' });
  if (channels.length === 0) {
    list.append(el('div', { class: 'empty', text: 'No channels blocked yet. Use the ⋮ menu on any YouTube video.' }));
  } else {
    for (const channel of channels) list.append(blockedChannelRow(channel, protectionOn));
  }

  const input = el('input', { class: 'input', placeholder: '@channelhandle', disabled: protectionOn ? false : true });
  const add = async () => {
    const handle = normalizeHandle(input.value);
    if (!handle) {
      statusLine(status, 'Enter a channel handle like @examplechannel.', true);
      return;
    }
    if (channels.some((c) => c.handle === handle)) {
      statusLine(status, 'That channel is already blocked.');
      return;
    }
    try {
      state = await send('channel/block', { handle, source: 'manual' });
      input.value = '';
      render();
    } catch (error) {
      statusLine(status, errorMessage(error), true);
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void add();
  });

  node.body.append(
    list,
    el('div', { class: 'field-row', style: 'margin-top:10px' }, [
      input,
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Add',
        disabled: protectionOn ? false : true,
        onclick: add,
      }),
    ]),
    status
  );
  return node.card;
}

/** One blocked channel: what it is, where the block came from, and what to do. */
function blockedChannelRow(channel, protectionOn) {
  const rowStatus = el('div', { class: 'status-line' });
  const label = channel.handle ?? channel.channelId;

  const meta = [];
  if (channel.handle && channel.name) meta.push(channel.handle);
  if (channel.channelId) meta.push(channel.channelId);
  if (channel.addedAt) meta.push(relativeTime(channel.addedAt));
  meta.push(BLOCK_SOURCES[channel.source] ?? 'Blocked');

  const submitted = (submissions ?? []).some(
    (entry) => entry.kind === 'channel' && String(entry.value).toLowerCase() === String(label).toLowerCase()
  );

  const requestButton = el('button', {
    class: 'btn small',
    type: 'button',
    text: submitted ? 'Requested' : 'Ask to block for everyone',
    disabled: submitted || !channel.handle || !protectionOn,
    // The server stores a global channel rule as a HANDLE and refuses anything
    // else, so a channel known only by its opaque id has to be added by handle
    // first. Saying so beats a request that would be rejected with a puzzling
    // error nobody could act on.
    title: channel.handle
      ? 'Send this channel for administrator review'
      : 'Global requests use the channel’s @handle. Add it below if you know it.',
    onclick: () => void submitChannel(channel, rowStatus, requestButton),
  });

  return el('div', { class: 'list-row channel-row' }, [
    el('div', { class: 'channel-main' }, [
      el('div', { class: 'channel-name', text: channel.name ?? label }),
      el('div', { class: 'meta', text: meta.join(' · ') }),
      rowStatus,
    ]),
    el('div', { class: 'btn-row' }, [
      requestButton,
      el('button', {
        class: 'btn small',
        type: 'button',
        text: 'Remove',
        'aria-label': `Unblock ${label}`,
        onclick: async () => {
          try {
            state = await send('channel/unblock', { label });
            render();
            notify(`Unblocked ${label}.`);
          } catch (error) {
            statusLine(rowStatus, errorMessage(error), true);
          }
        },
      }),
    ]),
  ]);
}

/** Ask an administrator to block this channel for everyone. Inert until reviewed. */
async function submitChannel(channel, rowStatus, button) {
  if (!channel.handle) {
    statusLine(rowStatus, 'A global request needs the channel’s @handle.', true);
    return;
  }
  statusLine(rowStatus, 'Sending…');
  try {
    await send('submission/create', {
      kind: 'channel',
      value: channel.handle,
      displayName: channel.name ?? null,
      source: 'unknown',
    });
    statusLine(rowStatus, 'Sent for review. An administrator decides before it applies to anyone.');
    // Updated in place rather than by re-rendering: a full re-render would
    // replace this row and take the sentence above with it.
    if (button) {
      button.textContent = 'Requested';
      button.disabled = true;
    }
    await loadSubmissions(false);
  } catch (error) {
    statusLine(rowStatus, errorMessage(error), true);
  }
}

/** A list with add/remove, used for keywords and domains. */
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

// ── First run ────────────────────────────────────────────────────────────

/**
 * Offer to set a password on the first visit.
 *
 * Shown once. The extension is fully usable without a password, so this is an
 * offer with a way past it — a wall here would be the wrong trade for a device
 * lock the user may not want. Either answer is recorded, so it is not asked
 * again.
 */
async function offerPasswordOnFirstRun() {
  if (!state || state.passwordSet || state.onboarded) return;
  const password = await promptToCreatePassword({
    title: 'Welcome to ClearView',
    message:
      'Set a password so Protection cannot be switched off by anyone else at this device. You can skip this and add one later.',
    skipLabel: 'Skip for now',
  });
  try {
    if (password) {
      state = await send('password/set', { password });
      render();
      notify('Password saved.');
      return;
    }
    await send('password/dismissOnboarding');
    state = await send('state/get');
    render();
  } catch (error) {
    notify(passwordErrorText(error));
  }
}

void (async () => {
  await refresh();
  await loadSubmissions(false);
  // Rendered once more AFTER the submissions land, so a channel already sent for
  // review says "Requested" on first paint rather than looking un-asked-for.
  render();
  await offerPasswordOnFirstRun();
})();
