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

import { BRAIN_BOT_MODES, PASSWORD, SUBMISSION_STATUS } from '../common/constants.js';
import { normalizeDomain } from '../common/matching.js';
import { normalizeHandle } from '../common/rules-bundle.js';
import { BLOCK_SOURCES, channelLabel } from '../common/channels.js';
import { icon } from '../ui/icons.js';
import {
  card,
  clear,
  el,
  errorMessage,
  grouped,
  pill,
  relativeTime,
  send,
  statusLine,
  switchControl,
} from '../ui/shared.js';
import {
  changeProtectionWithPassword,
  passwordErrorText,
  promptToChangePassword,
  promptToCreatePassword,
} from '../ui/password.js';

const content = document.getElementById('content');
const toastNode = document.getElementById('toast');
const scopeNode = document.getElementById('protection-scope');

let state = null;
let submissions = null;
let submissionsError = null;
let toastTimer = null;

/**
 * How many rows a card shows before "Show more".
 *
 * Four is enough to recognise a list at a glance and short enough that the
 * page stays a page: the keyword and channel lists grow without limit, and
 * rendering every row in a settings card made the screen into a scrollbar.
 * "Show more" opens the whole list on a page of its own, where every row has
 * room to be read instead of being squeezed into a modal.
 */
const PREVIEW_LIMIT = 4;

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

// ── Mandatory setup ──────────────────────────────────────────────────────

/**
 * The first screen of a new install, and the only screen until it is done.
 *
 * There is no Skip and no Cancel: the password is what stops Protection being
 * switched off in one click, and an offer that can be dismissed is not a lock.
 * If the tab is closed, the next visit lands here again — and in the meantime the
 * worker refuses every settings write, so the extension cannot be reconfigured
 * from the popup either.
 */
function renderSetupGate() {
  document.body.classList.add('setup-required');
  scopeNode.textContent = 'Set a password to finish setting up ClearView.';
  clear(content);

  const status = el('div', { class: 'status-line' });
  const password = el('input', {
    class: 'input',
    type: 'password',
    placeholder: `Choose a password (at least ${PASSWORD.minLength} characters)`,
    autocomplete: 'new-password',
  });
  const confirm = el('input', {
    class: 'input',
    type: 'password',
    placeholder: 'Type it again',
    autocomplete: 'new-password',
  });

  let saving = false;
  const submit = async () => {
    if (saving) return;
    const value = password.value;
    if ([...value].length < PASSWORD.minLength) {
      statusLine(status, `Use at least ${PASSWORD.minLength} characters.`, true);
      return;
    }
    if (value !== confirm.value) {
      statusLine(status, 'The two passwords do not match.', true);
      return;
    }
    saving = true;
    statusLine(status, 'Saving…');
    try {
      state = await send('password/set', { password: value });
      notify('Protection password set.');
      render();
    } catch (error) {
      statusLine(status, passwordErrorText(error), true);
    } finally {
      saving = false;
    }
  };

  password.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });
  confirm.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });

  content.append(
    el('section', { class: 'setup-gate', 'aria-labelledby': 'setup-title' }, [
      el('span', { class: 'brand-mark setup-gate__mark', 'aria-hidden': 'true' }, [
        el('img', { src: '../../icons/logo.png', alt: '' }),
      ]),
      el('h2', { class: 'setup-gate__title', id: 'setup-title', text: 'Protect ClearView' }),
      el('p', {
        class: 'setup-gate__text',
        text: 'Choose the password that unlocks Protection. It is required — ClearView cannot be turned off or reconfigured without it.',
      }),
      el('div', { class: 'setup-gate__fields' }, [password, confirm]),
      el('button', { class: 'btn primary setup-gate__submit', type: 'button', text: 'Create password', onclick: submit }),
      status,
      el('p', {
        class: 'setup-gate__note',
        text: 'Stored as a one-way hash on this device. It is never synced or sent anywhere.',
      }),
    ])
  );
  password.focus?.();
}

// ── Render ───────────────────────────────────────────────────────────────

function render() {
  // The password is MANDATORY from install. Until one exists the page is the
  // setup screen and nothing else: a settings page that can be used before the
  // lock is set is a lock that was optional in practice.
  if (!state.passwordSet) {
    renderSetupGate();
    return;
  }
  document.body.classList.remove('setup-required');

  const { settings, global: globalRules, stats, anonymousId, bundleCounts } = state;
  const protectionOn = settings.protectionEnabled;

  // The one line on the page that changes with the switch. It is the header's
  // lede, so the screen states what it is doing before any card is read; the
  // static teal line under it is what stays true either way.
  scopeNode.textContent = protectionOn
    ? 'Protection is active — websites and searches are checked before they load.'
    : 'Protection is off — nothing is being blocked.';

  clear(content);

  // Each group is a real section with an id, so the sidebar can move between
  // them and the page stays readable as one page rather than a wall of cards.

  const protectionGroup = settingsGroup(
    'protection',
    'Protection',
    'The master switch. When it is off, nothing is blocked anywhere.'
  );
  protectionGroup.body.append(protectionCard(protectionOn, bundleCounts));
  content.append(protectionGroup.node);

  const youtube = settingsGroup(
    'youtube',
    'YouTube protection',
    'Ads, Shorts, feed filtering and the channels you never want to see.'
  );
  youtube.body.append(
    adsCard(protectionOn),
    brainBotCard(protectionOn),
    shortsCard(protectionOn),
    managerCard({
      badge: icon('filter', 21),
      title: 'Brain Bot keywords',
      subtitle: 'Matched against YouTube titles only — never against other websites.',
      placeholder: 'e.g. a phrase you keep seeing',
      items: settings.youtubeKeywords,
      itemsKey: 'youtubeKeywords',
      disabled: !protectionOn,
      emptyText: 'No YouTube-only keywords yet.',
      onAdd: (value) => addTo('youtubeKeywords', value.trim().toLowerCase().replace(/\s+/g, ' ')),
      onRemove: (item) => patch({ youtubeKeywords: state.settings.youtubeKeywords.filter((k) => k !== item) }),
    }),
    blockedChannelsCard(protectionOn)
  );
  content.append(youtube.node);

  const blockedItems = settingsGroup(
    'blocked-items',
    'Blocked items',
    'Websites, keywords and the extra discovery filter.'
  );
  blockedItems.body.append(
    strictModeCard(protectionOn),
    managerCard({
      badge: icon('globe', 21),
      title: 'Blocked websites',
      subtitle: 'Blocked everywhere you browse.',
      placeholder: 'e.g. youtube.com, reddit.com',
      items: settings.blockedDomains,
      itemsKey: 'blockedDomains',
      disabled: !protectionOn,
      emptyText: 'No websites blocked yet.',
      onAdd: async (value) => {
        const domain = normalizeDomain(value);
        if (!domain) {
          notify('Enter a website like example.com.');
          return false;
        }
        return patch({ blockedDomains: [...new Set([...state.settings.blockedDomains, domain])] });
      },
      onRemove: (item) => patch({ blockedDomains: state.settings.blockedDomains.filter((d) => d !== item) }),
    }),
    managerCard({
      badge: icon('filter', 21),
      title: 'Blocked keywords',
      subtitle: 'Blocked on every website and every search.',
      placeholder: 'e.g. instagram, tiktok',
      items: settings.userKeywords,
      itemsKey: 'userKeywords',
      disabled: !protectionOn,
      emptyText: 'No keywords yet.',
      onAdd: (value) => addTo('userKeywords', value.trim().toLowerCase().replace(/\s+/g, ' ')),
      onRemove: (item) => patch({ userKeywords: state.settings.userKeywords.filter((k) => k !== item) }),
    })
  );
  content.append(blockedItems.node);

  const community = settingsGroup(
    'community',
    'Community blocklist',
    'Rules an administrator reviewed and shared with every install.'
  );
  community.body.append(globalRulesCard(globalRules), submissionsCard(globalRules), suggestCard());
  content.append(community.node);

  const activity = settingsGroup(
    'activity',
    'Protection activity',
    'What ClearView has blocked on this device.'
  );
  activity.body.append(activityCard(stats));
  content.append(activity.node);

  const security = settingsGroup(
    'security',
    'Security',
    'A local lock for the Protection switch on this browser profile.'
  );
  security.body.append(passwordCard());
  content.append(security.node);

  const advanced = settingsGroup('advanced', 'Advanced', 'Server, identity and privacy details.');
  advanced.body.append(serverCard(settings), identityCard(anonymousId), dataCard(), privacyCard());
  content.append(advanced.node);

  paintActiveSection();
}

/**
 * One settings section: a heading, a sentence of context, and its cards.
 *
 * A real `<section id>` rather than a floating label, because the sidebar links
 * to it — a settings page whose navigation cannot reach the thing it names is
 * decoration.
 */
function settingsGroup(id, title, description) {
  const body = el('div', { class: 'group-body' });
  const node = el('section', { class: 'group', id }, [
    el('div', { class: 'group-head' }, [
      el('h2', { class: 'group-title', text: title }),
      description ? el('p', { class: 'group-desc', text: description }) : null,
    ]),
    body,
  ]);
  return { node, body };
}

/**
 * Mark the sidebar link for the section currently in view.
 *
 * Scroll arithmetic instead of an observer: the page is rebuilt on every
 * settings write, so an observer would have to be torn down and rebuilt with it.
 * This runs on the same few links and always reflects the DOM that exists now.
 */
function paintActiveSection() {
  const links = [...document.querySelectorAll('.settings-nav a[href^="#"]')];
  if (links.length === 0) return;
  let active = links[0];
  for (const link of links) {
    const target = document.getElementById(link.getAttribute('href').slice(1));
    if (!target) continue;
    if (target.getBoundingClientRect().top <= 140) active = link;
  }
  for (const link of links) link.classList.toggle('is-active', link === active);
}

// ── Cards ────────────────────────────────────────────────────────────────

/** The master switch, with the rule counts behind it. */
function protectionCard(protectionOn, bundleCounts) {
  return card({
    icon: icon(protectionOn ? 'shield' : 'shield-off', 21),
    title: 'Protection',
    subtitle: protectionOn ? 'Active · watching websites and Google' : 'Off — nothing is blocked',
    variant: protectionOn ? 'on' : '',
    trailing: switchControl(protectionOn, toggleProtection, { label: 'Protection' }),
    info: true,
    open: false,
    detail: [
      'The built-in adult filter, your blocked websites, your keywords and any shared rules all apply while Protection is on.',
      'Turning Protection off stops every block immediately — websites, searches, Shorts and Brain Bot alike.',
      // Channels are counted by handle, by id AND by name: a block made from a
      // feed thumbnail has no handle to count, and leaving it out made the
      // header read "0 channels" next to a list that plainly had one.
      `Rules in force: ${bundleCounts.domains} hosts · ${bundleCounts.builtIn + bundleCounts.everywhere} keywords · ${(bundleCounts.channels ?? 0) + (bundleCounts.channelIds ?? 0) + (bundleCounts.channelNames ?? 0)} channels`,
    ],
  }).card;
}

/** The extra discovery-term filter, under Protection's master switch. */
function strictModeCard(protectionOn) {
  return card({
    icon: icon('alert', 21),
    title: 'Strict Mode',
    subtitle: 'Also blocks discovery words like bikini, lingerie or cleavage.',
    variant: state.settings.strictMode ? 'alert' : '',
    dim: !protectionOn,
    info: true,
    open: false,
    trailing: switchControl(state.settings.strictMode, (value) => patch({ strictMode: value }), {
      disabled: !protectionOn,
      label: 'Strict Mode',
    }),
    detail: [
      'Adds a curated list of risky-but-innocent discovery terms on top of the always-on adult filter.',
      'Gender and family words (women, girl, mom, wife, ...) are never blocked alone — they only block combined with an adult term.',
      'When Strict Mode is off, only the always-on adult terms block.',
    ],
  }).card;
}

function privacyCard() {
  const privacy = card({
    icon: icon('eye-off', 21),
    title: 'Privacy',
    subtitle: 'Nothing here is linked to who you are.',
    detail: [
      'Websites and searches are checked on your device and never uploaded.',
      'Community suggestions are sent with a random install id, not an account or a device identifier.',
      'No account or sign-up is needed to use the extension.',
    ],
  });
  privacy.body.append(
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Read the privacy policy',
        onclick: openPrivacyPolicy,
      }),
    ])
  );
  return privacy.card;
}

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
    icon: icon('ban', 21),
    title: 'Block YouTube ads',
    subtitle: 'Blocks ad requests, removes ad slots and skips video ads.',
    dim: !protectionOn,
    info: true,
    open: false,
    trailing: switchControl(state.settings.blockYoutubeAds, (value) => patch({ blockYoutubeAds: value }), {
      disabled: !protectionOn,
      label: 'Block YouTube ads',
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
    // No "Remove password": the password is mandatory, so removing it would
    // only bounce the user straight back to setup. Changing it is the action.
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
    icon: icon(isSet ? 'lock' : 'unlock', 21),
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
    icon: icon('brain', 21),
    title: 'Brain Bot Protection',
    subtitle: 'Filter unwanted content from YouTube feeds using keywords and channels.',
    // Maroon while it is on, as the app marks it: this is the filter that hides
    // videos that are not outright blocked, so it is worth flagging as the
    // stronger of the two settings on this page.
    variant: state.settings.brainBotEnabled ? 'alert' : '',
    dim: !protectionOn,
    info: true,
    open: false,
    trailing: switchControl(state.settings.brainBotEnabled, (value) => patch({ brainBotEnabled: value }), {
      disabled: !protectionOn,
      label: 'Brain Bot Protection',
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
    icon: icon('play', 21),
    title: 'Block YouTube Shorts',
    subtitle: 'Hides the Shorts entry point and blocks Shorts links.',
    dim: !protectionOn,
    info: true,
    open: false,
    trailing: switchControl(state.settings.blockShorts, (value) => patch({ blockShorts: value }), {
      disabled: !protectionOn,
      label: 'Block YouTube Shorts',
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
    icon: icon('tv', 21),
    title: 'Blocked channels',
    subtitle: 'Their videos leave your YouTube feeds, and their channel page and videos will not open.',
    variant: 'dashed',
    dim: !protectionOn,
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
    // A preview, not the whole list: the card is a summary, and the full list is
    // one click away in a searchable view. Rendering every channel here is what
    // made the settings page grow without limit.
    for (const channel of channels.slice(0, PREVIEW_LIMIT)) list.append(blockedChannelRow(channel, protectionOn));
    if (channels.length > PREVIEW_LIMIT) {
      list.append(
        el('button', {
          class: 'btn small show-more-btn',
          type: 'button',
          text: `Show more (${channels.length})`,
          onclick: () =>
            openFullList({
              title: 'Blocked channels',
              subtitle: 'Every channel ClearView removes from your YouTube feeds.',
              items: () => state.blockedChannels ?? [],
              searchText: (channel) =>
                [channel.name, channel.handle, channel.channelId].filter(Boolean).join(' '),
              searchPlaceholder: 'Search name, @handle or channel id',
              emptyText: 'No channels blocked yet.',
              renderRow: (channel, refresh) => blockedChannelRow(channel, protectionOn, refresh),
            }),
        })
      );
    }
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
function blockedChannelRow(channel, protectionOn, onChanged = null) {
  const rowStatus = el('div', { class: 'status-line' });
  // Handle, else channel id, else the displayed name: a block made from a feed
  // card whose channel carries no link has only the name to go on.
  const label = channelLabel(channel);

  const meta = [];
  if (channel.handle && channel.name) meta.push(channel.handle);
  if (channel.channelId) meta.push(channel.channelId);
  // A name-only block has no handle to show, so the row must say what it WILL
  // match on — otherwise it looks like a row with no identity at all.
  if (!channel.handle && !channel.channelId && channel.name) meta.push('matched by name');
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
            // The page behind is always redrawn (its preview and counts changed);
            // a searchable list additionally refreshes its own rows in place.
            render();
            if (onChanged) onChanged();
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
function managerCard({ badge, title, subtitle, placeholder, items, itemsKey, onAdd, onRemove, disabled, emptyText }) {
  const status = el('div', { class: 'status-line' });
  // Dashed, like the app's Blocked Items row: the card IS the list, and the
  // dashed edge is what says a list is inside it. Dimmed when Protection is off,
  // because the field and the Add button are then disabled with nothing to do.
  const node = card({ icon: badge, title, subtitle, variant: 'dashed', dim: Boolean(disabled) });

  // Read live from state, not from the array captured at render time: a removal
  // made in the searchable view has to be reflected when it re-renders its list.
  const currentItems = () => (itemsKey ? state?.settings?.[itemsKey] ?? [] : items) ?? [];
  const all = currentItems();

  const chips = el('div', { class: 'chip-list' });
  if (all.length === 0) {
    chips.append(el('div', { class: 'empty', text: emptyText }));
  } else {
    for (const item of all.slice(0, PREVIEW_LIMIT)) {
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

  const showMore =
    all.length > PREVIEW_LIMIT
      ? el('button', {
          class: 'btn small show-more-btn',
          type: 'button',
          text: `Show more (${all.length})`,
          onclick: () =>
            openFullList({
              title,
              subtitle,
              items: currentItems,
              searchText: (item) => String(item),
              searchPlaceholder: `Search ${title.toLowerCase()}`,
              emptyText,
              renderRow: (item, refresh) =>
                el('div', { class: 'list-row' }, [
                  el('span', { class: 'grow', text: item }),
                  el('button', {
                    class: 'btn small',
                    type: 'button',
                    text: 'Remove',
                    'aria-label': `Remove ${item}`,
                    onclick: async () => {
                      const ok = await onRemove(item);
                      if (ok !== false) refresh();
                    },
                  }),
                ]),
            }),
        })
      : null;

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
    // Native `append` turns `null` into the text "null", so a card with a short
    // list must not pass the absent button through.
    ...(showMore ? [showMore] : []),
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
}/**
 * A full-page view of a list that outgrew its card.
 *
 * "Show more" means SHOW MORE — a page of its own, with the whole list, a
 * search field and rows wide enough to read, rather than a small dialog that
 * turns the same list into a scrollbar. `items` is a GETTER, not an array: a
 * removal made here re-renders from the state the worker just returned, so the
 * view can never show a row it has already deleted. Escape and the Back button
 * close it.
 */
function openFullList({ title, subtitle, items, searchText, emptyText, searchPlaceholder = 'Search…', renderRow }) {
  const search = el('input', {
    class: 'input',
    type: 'search',
    placeholder: searchPlaceholder,
    'aria-label': `Search ${title}`,
  });

  const list = el('div', { class: 'list fullpage-list' });
  const count = el('div', { class: 'fullpage-count' });

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('fullpage-open');
    backdrop.remove();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const renderList = () => {
    clear(list);
    const all = items() ?? [];
    const query = String(search.value ?? '').trim();
    const needle = query.toLowerCase();
    const shown = needle === '' ? all : all.filter((item) => searchText(item).toLowerCase().includes(needle));
    count.textContent = needle === ''
      ? `${all.length} item${all.length === 1 ? '' : 's'}`
      : `${shown.length} of ${all.length} shown`;
    if (shown.length === 0) {
      list.append(
        el('div', {
          class: 'empty',
          text: needle === '' ? emptyText : `No matches for “${query}”.`,
        })
      );
      return;
    }
    for (const item of shown) list.append(renderRow(item, renderList));
  };

  search.addEventListener('input', renderList);

  const page = el(
    'div',
    { class: 'fullpage', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    [
      el('header', { class: 'fullpage-head' }, [
        el('button', { class: 'btn small', type: 'button', text: 'Back', onclick: close }),
        el('div', { class: 'fullpage-heading' }, [
          el('h2', { class: 'fullpage-title', text: title }),
          subtitle ? el('p', { class: 'fullpage-sub', text: subtitle }) : null,
        ]),
      ]),
      el('div', { class: 'fullpage-tools' }, [search, count]),
      list,
    ]
  );
  const backdrop = el('div', { class: 'fullpage-backdrop' }, [page]);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.classList.add('fullpage-open');
  document.body.append(backdrop);
  renderList();
  search.focus();
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
  // A centred accent action rather than a small button in the corner: it is the
  // one thing this card does, and the app's "Select DNS Provider" row is the
  // same shape.
  const checkForUpdates = async () => {
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
  };
  const node = card({
    icon: icon('share', 21),
    title: 'Shared blocklist',
    subtitle: globalRules.available
      ? `${globalRules.keywordCount} keywords · ${globalRules.channelCount} channels blocked for everyone`
      : 'Not downloaded yet',
    info: true,
    open: false,
    action: { label: 'Check for updates', glyph: 'settings', onClick: checkForUpdates },
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
    icon: icon('upload', 21),
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
  const status = el('div', { class: 'status-line', id: 'submissions-status' });
  node.body.append(list, status);
  renderSubmissions(globalRules, list, status);
  return node.card;
}

/** Paint the submissions list. `list`/`status` default to the live card's nodes. */
function renderSubmissions(globalRules, list, status) {
  list = list ?? document.getElementById('submissions-list');
  status = status ?? document.getElementById('submissions-status');
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

  const rowFor = (submission) => {
    const live = submission.kind === 'keyword'
      ? liveKeywords.has(String(submission.value).toLowerCase())
      : liveChannels.has(String(submission.value).toLowerCase());
    const display =
      submission.status === 'approved' && !live ? 'removed' : submission.status;
    const kind = display === 'approved' ? 'ok' : display === 'pending' || display === 'under_review' ? 'pending' : 'rejected';

    return el('div', { class: 'list-row' }, [
      el('span', { class: 'grow', text: submission.value }),
      el('span', { class: 'meta', text: relativeTime(Date.parse(submission.createdAt)) }),
      pill(SUBMISSION_STATUS[display] ?? display, kind),
    ]);
  };

  for (const submission of submissions.slice(0, PREVIEW_LIMIT)) list.append(rowFor(submission));

  if (submissions.length > PREVIEW_LIMIT) {
    list.append(
      el('button', {
        class: 'btn small show-more-btn',
        type: 'button',
        text: `Show more (${submissions.length})`,
        onclick: () =>
          openFullList({
            title: 'My submissions',
            subtitle: 'What you asked to be blocked for everyone, and where each request stands.',
            items: () => submissions ?? [],
            searchText: (submission) => `${submission.value} ${submission.status}`,
            searchPlaceholder: 'Search your submissions',
            emptyText: 'You have not submitted anything yet.',
            renderRow: (submission) => rowFor(submission),
          }),
      })
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
  // The field asks for what the chosen kind actually wants, so switching to
  // "Channel handle" cannot leave a placeholder inviting a bare keyword.
  kindSelect.addEventListener('change', () => {
    input.placeholder = kindSelect.value === 'channel' ? '@channelhandle' : 'e.g. a keyword';
  });

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
    icon: icon('send', 21),
    title: 'Ask to block it for everyone',
    subtitle: 'An administrator reviews each request before it applies to anyone.',
    detail: [
      'One request never changes what everyone else blocks on its own.',
      'Requests are sent with a random install id — no account is required.',
      'Approved requests are distributed to every participating install.',
    ],
  });
  node.body.append(
    el('div', { class: 'field-row suggest-row' }, [kindSelect, input]),
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
    icon: icon('activity', 21),
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
        el('div', { class: 'stat-value', text: grouped(stats.total ?? 0) }),
        el('div', { class: 'stat-label', text: 'Content blocked' }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-value', text: grouped(byReason.search ?? 0) }),
        el('div', { class: 'stat-label', text: 'Searches' }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-value', text: grouped(byReason.domain ?? 0) }),
        el('div', { class: 'stat-label', text: 'Websites' }),
      ]),
    ])
  );

  const recent = stats.recent ?? [];
  const list = el('div', { class: 'list' });
  const HISTORY_PREVIEW = 8;

  const rowFor = (entry) =>
    el('div', { class: 'list-row' }, [
      el('span', { class: 'grow', text: entry.detail || entry.reason }),
      el('span', { class: 'meta', text: relativeTime(entry.at) }),
    ]);

  if (recent.length === 0) {
    list.append(el('div', { class: 'empty', text: 'Nothing blocked yet. Protection is watching.' }));
  } else {
    for (const entry of recent.slice(0, HISTORY_PREVIEW)) list.append(rowFor(entry));
    if (recent.length > HISTORY_PREVIEW) {
      list.append(
        el('button', {
          class: 'btn small show-more-btn',
          type: 'button',
          text: `Show more (${recent.length})`,
          onclick: () =>
            openFullList({
              title: 'Protection history',
              subtitle: 'Everything ClearView blocked on this device, most recent first.',
              items: () => state.stats?.recent ?? [],
              searchText: (entry) => `${entry.detail ?? ''} ${entry.reason ?? ''}`,
              searchPlaceholder: 'Search the history',
              emptyText: 'Nothing blocked yet.',
              renderRow: (entry) => rowFor(entry),
            }),
        })
      );
    }
  }
  node.body.append(list, status);
  return node.card;
}

/**
 * The user's own data: take it with you, or erase it.
 *
 * Export is a plain JSON download — settings, activity and the anonymous id, and
 * deliberately not the password hash. Erase clears BOTH storage areas, so a key
 * added in a later version cannot be the one that survives an "erase all".
 */
function dataCard() {
  const status = el('div', { class: 'status-line' });

  const exportData = async () => {
    try {
      const data = await send('data/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = el('a', {
        href: url,
        download: `clearview-export-${new Date().toISOString().slice(0, 10)}.json`,
      });
      document.body.append(link);
      link.click();
      link.remove();
      // Revoked on the next tick: revoking in the same task can cancel the
      // download in some Chromium builds.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      statusLine(status, 'Exported.');
    } catch (error) {
      statusLine(status, errorMessage(error), true);
    }
  };

  const erase = async () => {
    const sure = window.confirm(
      'Erase every ClearView setting, statistic, blocked item and the Protection password on this device? This cannot be undone.'
    );
    if (!sure) return;
    try {
      state = await send('data/erase');
      render();
      notify('All ClearView data erased. Set a password to continue.');
    } catch (error) {
      statusLine(status, errorMessage(error), true);
    }
  };

  const node = card({
    icon: icon('shield', 21),
    title: 'Your data',
    subtitle: 'Take a copy of what is stored here, or erase it completely.',
    detail: [
      'The export contains your settings, blocked items, activity counters and the random install id — never the password hash or an admin session.',
      'Erasing clears both the synced settings and this device’s local data, including the Protection password. Protection returns to its defaults and setup starts again.',
      'Nothing is sent to the server by either action.',
    ],
  });
  node.body.append(
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', type: 'button', text: 'Export my data', onclick: exportData }),
      el('button', { class: 'btn danger', type: 'button', text: 'Erase all data', onclick: erase }),
    ]),
    status
  );
  return node.card;
}

function serverCard(settings) {
  const status = el('div', { class: 'status-line' });
  const input = el('input', { class: 'input', value: settings.apiBase });
  const node = card({
    icon: icon('server', 21),
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

/**
 * The install's anonymous id — read-only.
 *
 * This card used to offer "New identity", which regenerated the id on demand.
 * That is gone: the id is the one thing that ties an install's contributions
 * together server-side, and a button that silently breaks that link is not
 * something the user can be expected to weigh up at the moment they press it.
 * Generated once on install (`getAnonymousId`), shown here, and never replaced.
 */
function identityCard(anonymousId) {
  const node = card({
    icon: icon('fingerprint', 21),
    title: 'Anonymous identity',
    subtitle: 'The random id your contributions are sent with.',
    detail: ['Generated on this device and derived from nothing about you — no account, no device id.'],
  });
  node.body.append(el('div', { class: 'identity', text: anonymousId }));
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

/** The full privacy policy, in its own page — the same one the popup links to. */
function openPrivacyPolicy() {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/privacy/privacy.html') });
}

document.getElementById('open-admin').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/admin/admin.html') });
});

// The sidebar highlights the section in view. Capture is used because the
// scrolling element is the document, and scroll does not bubble.
document.addEventListener('scroll', paintActiveSection, { passive: true, capture: true });

void (async () => {
  await refresh();
  await loadSubmissions(false);
  // Rendered once more AFTER the submissions land, so a channel already sent for
  // review says "Requested" on first paint rather than looking un-asked-for.
  // That re-render rebuilds every card — including the submissions list, which
  // is therefore filled again, or the rows that just arrived would be replaced
  // by an empty list the moment they were ready.
  render();
  renderSubmissions(state?.global ?? {});
})();
