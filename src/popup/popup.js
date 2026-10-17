/**
 * The popup — three things, and nothing else.
 *
 *   1. The switch that turns Protection on — drawn ONLY while it is off. Once
 *      protection is on the popup is the name and the activity; the switch moves
 *      to the settings page, where a password can guard it.
 *   2. What it has done: today's count, the running totals, a seven-day strip,
 *      and the reasons that account for most of it.
 *   3. One quiet way into the full settings.
 *
 * The header above them is static markup in `popup.html`, so the screen has its
 * title before the worker has answered anything, and the lock beside it reports
 * whether the Protection password is set.
 *
 * That is the whole surface. Everything a user might want to *change* — the ad
 * blocker, Shorts, Brain Bot, keywords, blocked sites, channels, the password,
 * the community list — is one click away in the settings page, and putting a
 * copy of it here is what made this popup scroll. A popup that needs scrolling
 * to show a switch has stopped being a popup.
 *
 * Every write still goes through the worker, and a Protection change is gated by
 * the local password there rather than here: this page only collects it.
 */

import { dayKey } from '../common/settings.js';
import { card, chevron, clear, el, errorMessage, grouped, send, switchControl, toast } from '../ui/shared.js';
import { icon } from '../ui/icons.js';
import { changeProtectionWithPassword, passwordErrorText } from '../ui/password.js';

const content = document.getElementById('content');
const lockButton = document.getElementById('popup-lock');
const statusNode = document.getElementById('popup-status');

/** Human labels for the counters the worker stores by match type. */
const REASON_LABELS = {
  // The worker stores the matcher's own type (see `bumpStats`), plus `search`
  // for a blocked query.
  search: 'Searches',
  DOMAIN: 'Websites',
  domain: 'Websites',
  BUILT_IN_KEYWORD: 'Keywords',
  keyword: 'Keywords',
  USER_KEYWORD: 'Your keywords',
  'your-keyword': 'Your keywords',
  GLOBAL_KEYWORD: 'Shared keywords',
  'shared-keyword': 'Shared keywords',
  CHANNEL: 'Channels',
  channel: 'Channels',
  shorts: 'Shorts',
  blocked: 'Blocked',
};
const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

let state = null;

async function refresh() {
  try {
    state = await send('state/get');
  } catch (error) {
    clear(content);
    content.append(el('div', { class: 'popup-error', text: errorMessage(error) }));
    return;
  }
  render();
}

/**
 * The hero switch: it only appears while Protection is OFF, so it only ever
 * turns protection ON — and enabling is deliberately free of the password.
 * Turning protection OFF lives in Settings, where the password is asked for.
 *
 * The switch moves back on its own when a write fails — it is drawn from
 * `state`, so a re-render is the undo.
 */
async function toggleProtection(next) {
  // No password yet means setup is unfinished, and the worker refuses every
  // settings write. Send the user to the one screen that can finish it.
  if (!state.passwordSet) {
    chrome.runtime.openOptionsPage();
    return;
  }

  const result = await changeProtectionWithPassword(next);
  if (result.cancelled) {
    render();
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

/**
 * The lock in the header: the password's state, and the way to the card that
 * changes it.
 *
 * It is not a second way to switch Protection off — that is the hero switch, and
 * a header control that could also disable protection would be the wrong thing to
 * put within reach of a mis-tap.
 */
function paintLock() {
  if (!lockButton) return;
  const isSet = Boolean(state.passwordSet);
  clear(lockButton);
  lockButton.append(icon(isSet ? 'lock' : 'unlock', 17));
  lockButton.classList.toggle('is-locked', isSet);
  const label = isSet
    ? 'Protection password is set — open the settings'
    : 'No protection password — open the settings';
  lockButton.setAttribute('aria-label', label);
  lockButton.setAttribute('title', label);
  lockButton.onclick = () => chrome.runtime.openOptionsPage();
}

/** The one line of state under the name: on with a live dot, or plainly off. */
function paintStatus(protectionOn) {
  if (!statusNode) return;
  clear(statusNode);
  statusNode.classList.toggle('is-off', !protectionOn);
  statusNode.append(
    el('span', { class: 'popup-status__dot', 'aria-hidden': 'true' }),
    el('span', { text: protectionOn ? 'Protection on' : 'Protection off' })
  );
}

function render() {
  const { settings, stats } = state;
  const protectionOn = settings.protectionEnabled;

  paintLock();
  paintStatus(protectionOn);
  clear(content);

  // ── Protection ─────────────────────────────────────────────────────────
  // The switch is only drawn while Protection is OFF. Once it is on, the popup
  // is the product's name and its activity — a control that can only turn
  // protection off is not something to put one mis-tap away here; that lives in
  // the settings page, behind the password when one is set.
  if (!protectionOn) {
    content.append(
      card({
        icon: icon('shield-off', 21),
        title: 'Protection off',
        subtitle: 'Nothing is being blocked',
        trailing: switchControl(protectionOn, toggleProtection, { label: 'Protection' }),
        info: true,
        open: false,
        detail: [
          'Websites, searches, YouTube feeds and Shorts are all unguarded while it is off.',
          'Your lists are kept — nothing is deleted, and everything comes back when it is on.',
        ],
      }).card
    );
  }

  // ── Activity ───────────────────────────────────────────────────────────
  content.append(analyticsCard(stats));

  // ── Unfinished setup ───────────────────────────────────────────────────
  // Shown until a password exists. The password is mandatory, so this is not an
  // offer: until it is done, nothing in the extension can be changed.
  if (!state.passwordSet) content.append(setupRequiredCard());

  // ── Into the settings ──────────────────────────────────────────────────
  // A plain row with a hairline rule, not a dashed card: the way out should be
  // quiet, and one of it is enough (the lock in the header goes there too).
  content.append(
    el(
      'button',
      { class: 'popup-settings', type: 'button', onclick: () => chrome.runtime.openOptionsPage() },
      [
        el('span', { text: 'Open settings' }),
        chevron(17),
      ]
    )
  );
}

/**
 * Activity, in the smallest useful shape.
 *
 * A number nobody can act on is decoration. Today's count beside the two totals
 * it belongs to, a seven-day bar strip for the trend, and the reasons that
 * account for the most blocks — all read from the counters the worker already
 * keeps, so the popup adds no bookkeeping of its own.
 */
function analyticsCard(stats) {
  const total = stats.total ?? 0;
  const today = stats.byDay?.[dayKey()] ?? 0;

  // Seven days ending today. `byDay` holds a fortnight, so every key exists on
  // a normal install; a missing one is a day with nothing blocked.
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return { key: dayKey(date), initial: DAY_INITIALS[date.getDay()] };
  });
  const counts = days.map((day) => stats.byDay?.[day.key] ?? 0);
  const week = counts.reduce((sum, value) => sum + value, 0);
  const peak = Math.max(1, ...counts);

  const chart = el(
    'div',
    {
      class: 'spark',
      role: 'img',
      'aria-label': `Blocks over the last seven days: ${counts.join(', ')}`,
    },
    days.map((day, index) =>
      el('div', { class: 'spark__col' }, [
        el('span', {
          class: `spark__bar${counts[index] === 0 ? ' is-empty' : ''}`,
          style: `height:${Math.max(2, Math.round((counts[index] / peak) * 30))}px`,
        }),
        el('span', { class: 'spark__day', text: day.initial }),
      ])
    )
  );

  const reasons = Object.entries(stats.byReason ?? {})
    .filter(([, value]) => Number(value) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key, value]) => `${REASON_LABELS[key] ?? 'Other'} ${grouped(value)}`);

  return el('section', { class: 'analytics', 'aria-label': 'Protection activity' }, [
    el('div', { class: 'analytics__head' }, [
      el('div', {}, [
        el('span', { class: 'analytics__label', text: 'Blocked today' }),
        el('span', { class: 'analytics__value', text: grouped(today) }),
      ]),
      el('div', { class: 'analytics__totals' }, [
        totalCell('7 days', grouped(week)),
        totalCell('All time', grouped(total)),
      ]),
    ]),
    chart,
    el('div', {
      class: 'analytics__reasons',
      text: reasons.length > 0 ? reasons.join(' · ') : total === 0 ? 'Nothing blocked yet.' : 'Protection is watching.',
    }),
  ]);
}

function totalCell(label, value) {
  return el('div', { class: 'analytics__total' }, [
    el('span', { class: 'analytics__total-label', text: label }),
    el('span', { class: 'analytics__total-value', text: value }),
  ]);
}

/**
 * Setup is unfinished: the password is required, so this is a door, not an
 * offer. The actual form lives on the settings page, where it also hides every
 * setting until it is done.
 */
function setupRequiredCard() {
  return el('div', { class: 'card dashed popup-offer' }, [
    el('span', { class: 'popup-offer__icon', 'aria-hidden': 'true' }, [icon('lock', 18)]),
    el('span', { class: 'popup-offer__text', text: 'Set your Protection password to finish setup' }),
    el('button', {
      class: 'btn small primary',
      type: 'button',
      text: 'Finish setup',
      onclick: () => chrome.runtime.openOptionsPage(),
    }),
  ]);
}

void refresh();
