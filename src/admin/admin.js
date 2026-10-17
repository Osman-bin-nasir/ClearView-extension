/**
 * The admin dashboard.
 *
 * Three things shape this screen:
 *
 *  1. **It is not the security boundary.** The server re-reads the
 *     administrator's row and its permissions on every request, so hiding a
 *     button here is a courtesy, not a control. A caller who fabricated a
 *     request from the console would be refused by the API, not by this file.
 *  2. **No credentials live here.** Sign-in exchanges the password for a
 *     short-lived token, which the service worker holds; this page only ever
 *     asks the worker to make a call.
 *  3. **Approving is the only path from a suggestion to a rule**, and it is one
 *     backend transaction — so the button below cannot half-succeed.
 */

import { ADMIN, SUBMISSION_STATUS } from '../common/constants.js';
import { dayKey } from '../common/settings.js';
import { ADMIN_EMAIL } from '../common/env.config.js';
import { icon } from '../ui/icons.js';
import { card, clear, el, errorMessage, pill, relativeTime, send, statusLine } from '../ui/shared.js';

// The administrator's address from `.env`, pre-filled so signing in is one field
// to type rather than two. It is a convenience, NOT a check: permissions come
// from the backend, which re-reads the account on every request, so this value
// grants nothing and a different one would be treated exactly the same.
const emailField = document.getElementById('email');
if (ADMIN_EMAIL) emailField.value = ADMIN_EMAIL;

const gate = document.getElementById('gate');
const dashboard = document.getElementById('dashboard');
const panel = document.getElementById('panel');
const gateStatus = document.getElementById('gate-status');
const whoNode = document.getElementById('admin-who');
const toastNode = document.getElementById('toast');

let activeTab = 'overview';
let queueStatus = 'pending';
let toastTimer = null;

function notify(message) {
  toastNode.textContent = message;
  toastNode.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.add('hidden'), 3200);
}

/** An admin call, routed through the worker (which holds the token). */
function admin(path, options = {}) {
  return send('admin/request', { path, method: options.method ?? 'GET', body: options.body });
}

// ── Session ──────────────────────────────────────────────────────────────

async function boot() {
  try {
    const { admin: identity } = await send('admin/session');
    if (identity) {
      whoNode.textContent = `${identity.displayName ?? identity.email ?? 'Administrator'} · signed in`;
      showDashboard();
      return;
    }
  } catch {
    /* fall through to the gate */
  }
  gate.classList.remove('hidden');
}

function showDashboard() {
  gate.classList.add('hidden');
  dashboard.classList.remove('hidden');
  void loadTab(activeTab);
}

document.getElementById('signin').addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) {
    statusLine(gateStatus, 'Enter your administrator email and password.', true);
    return;
  }
  statusLine(gateStatus, 'Signing in…');
  try {
    const { admin: identity } = await send('admin/login', { email, password });
    document.getElementById('password').value = '';
    whoNode.textContent = `${identity?.displayName ?? identity?.email ?? email} · signed in`;
    showDashboard();
  } catch (error) {
    statusLine(gateStatus, errorMessage(error), true);
  }
});

document.getElementById('password').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('signin').click();
});

document.getElementById('signout').addEventListener('click', async () => {
  await send('admin/logout').catch(() => {});
  dashboard.classList.add('hidden');
  gate.classList.remove('hidden');
  statusLine(gateStatus, 'Signed out.');
});

document.getElementById('back-options').addEventListener('click', () => {
  location.href = chrome.runtime.getURL('src/options/options.html');
});

// ── Tabs ─────────────────────────────────────────────────────────────────

document.getElementById('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  activeTab = tab.dataset.tab;
  for (const node of document.querySelectorAll('.tab')) {
    node.classList.toggle('selected', node === tab);
  }
  void loadTab(activeTab);
});

function loading(text) {
  clear(panel);
  panel.append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), text]));
}

function failure(error) {
  clear(panel);
  panel.append(el('div', { class: 'card' }, [el('div', { class: 'empty', text: errorMessage(error) })]));
}

async function loadTab(tab) {
  loading('Loading…');
  try {
    if (tab === 'overview') await renderOverview();
    else if (tab === 'queue') await renderQueue();
    else if (tab === 'rules') await renderRules();
    else if (tab === 'reports') await renderReports();
  } catch (error) {
    failure(error);
  }
}

// ── Overview ─────────────────────────────────────────────────────────────

async function renderOverview() {
  // The dashboard totals and the report queue are two calls, but the overview
  // needs both: a rule's false-positive RATE is only visible when its requests
  // and its reports are side by side. A refused reports call degrades to no
  // contested card rather than taking the whole overview down with it.
  const [data, reportData] = await Promise.all([
    admin(ADMIN.dashboard),
    admin(ADMIN.reports).catch(() => ({ reports: [] })),
  ]);
  const totals = data.totals ?? {};
  const groups = groupReports(reportData.reports ?? []);
  const contested = new Map(
    groups.map((group) => [`${group.kind}:${group.value.toLowerCase()}`, group])
  );
  clear(panel);

  const node = card({
    icon: icon('activity', 21),
    title: 'Review status',
    subtitle: `${totals.all ?? 0} submissions in total`,
  });
  node.body.append(
    el('div', { class: 'admin-stats' }, [
      statTile(totals.pending ?? 0, 'Pending', 'pending'),
      statTile(totals.underReview ?? 0, 'Under review', 'pending'),
      statTile(totals.approved ?? 0, 'Approved', 'ok'),
      statTile(totals.rejected ?? 0, 'Rejected', 'rejected'),
    ])
  );
  panel.append(node.card);

  panel.append(demandTable('Most requested channels', data.topChannels ?? [], 'channel', contested));
  panel.append(demandTable('Most requested keywords', data.topKeywords ?? [], 'keyword', contested));
  if (groups.length > 0) panel.append(contestedCard(groups));
}

function statTile(value, label, tone = '') {
  return el('div', { class: `admin-stat ${tone}`.trim() }, [
    el('div', { class: 'admin-stat__value', text: String(value) }),
    el('div', { class: 'admin-stat__label', text: label }),
  ]);
}

function demandTable(title, rows, kind, contested) {
  const node = card({
    icon: icon('upload', 21),
    title,
    subtitle: 'What the community is asking for most — and how often it is reported as wrong.',
  });
  if (rows.length === 0) {
    node.body.append(el('div', { class: 'empty', text: 'Nothing requested yet.' }));
    return node.card;
  }
  const table = el('table', { class: 'admin-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Target' }),
        el('th', { text: 'Global requests' }),
        el('th', { text: 'False-positive reports' }),
        el('th', { text: 'Status' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      rows.slice(0, 20).map((row) =>
        el('tr', {}, [
          el('td', {}, [
            el('div', { text: row.value }),
            row.displayName ? el('div', { class: 'meta muted', text: row.displayName }) : null,
          ]),
          el('td', { text: String(row.globalRequests ?? 0) }),
          el('td', {}, [
            falsePositiveCell(
              contested.get(`${kind}:${String(row.value).toLowerCase()}`),
              Number(row.globalRequests ?? 0)
            ),
          ]),
          el('td', {}, [
            pill(
              SUBMISSION_STATUS[row.status] ?? row.status ?? 'not submitted',
              row.status === 'approved' ? 'ok' : row.status === 'rejected' ? 'rejected' : ''
            ),
          ]),
        ])
      )
    ),
  ]);
  node.body.append(table);
  return node.card;
}

/**
 * A rule's contested-ness, as a number and a share.
 *
 * The share is reports / (requests + reports), not reports / requests: the two
 * counts come from different users and different surfaces, and pretending one is
 * a subset of the other would print rates above 100%.
 */
function falsePositiveCell(group, requests) {
  if (!group) return el('span', { class: 'meta muted', text: '0' });
  const total = requests + group.count;
  const share = total > 0 ? Math.round((group.count / total) * 100) : 0;
  return el('div', { class: 'contested-cell' }, [
    el('span', { text: `${group.count} · ${share}%` }),
    group.count >= 3 ? pill('contested', 'rejected') : null,
  ]);
}

/** The rules users keep reporting, in one place on the Overview. */
function contestedCard(groups) {
  const node = card({
    icon: icon('alert', 21),
    title: 'Contested rules',
    subtitle: 'Rules users keep reporting as wrongly blocked.',
  });
  node.body.append(
    el('div', { class: 'table-scroll' }, [
      el('table', { class: 'admin-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Rule' }),
            el('th', { text: 'Kind' }),
            el('th', { text: 'Reports' }),
            el('th', { text: 'Videos' }),
            el('th', { text: 'Last report' }),
          ]),
        ]),
        el(
          'tbody',
          {},
          groups.map((group) =>
            el('tr', {}, [
              el('td', { text: group.value }),
              el('td', { text: group.kind }),
              el('td', { text: String(group.count) }),
              el('td', { text: String(group.videos.length) }),
              el('td', { text: relativeTime(group.lastAt) }),
            ])
          )
        ),
      ]),
    ])
  );
  return node.card;
}

// ── Review queue ─────────────────────────────────────────────────────────

async function renderQueue() {
  const data = await admin(`${ADMIN.submissions}?status=${encodeURIComponent(queueStatus)}`);
  const submissions = data.submissions ?? [];
  clear(panel);

  const filters = el('div', { class: 'tab-filters btn-row' },
    ['pending', 'under_review', 'approved', 'rejected', 'all'].map((status) =>
      el('button', {
        class: `btn small ${queueStatus === status ? 'primary' : ''}`,
        type: 'button',
        text: SUBMISSION_STATUS[status] ?? status,
        onclick: () => {
          queueStatus = status;
          void renderQueue();
        },
      })
    )
  );

  const node = card({
    title: 'Submissions',
    subtitle: `${submissions.length} shown`,
  });
  node.body.append(filters);

  if (submissions.length === 0) {
    node.body.append(el('div', { class: 'empty', text: 'Nothing here.' }));
    panel.append(node.card);
    return;
  }

  const table = el('table', { class: 'admin-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Target' }),
        el('th', { text: 'Kind' }),
        el('th', { text: 'Requests' }),
        el('th', { text: 'Submitted' }),
        el('th', { text: 'Status' }),
        el('th', { text: 'Decision' }),
      ]),
    ]),
    el('tbody', {}, submissions.map((submission) => submissionRow(submission))),
  ]);
  node.body.append(table);
  panel.append(node.card);
}

function submissionRow(submission) {
  const decided = submission.status === 'approved' || submission.status === 'rejected';
  const decide = async (decision) => {
    try {
      await admin(ADMIN.review(submission.id), { method: 'POST', body: { decision } });
      notify(
        decision === 'approved'
          ? `Approved — “${submission.value}” is now a rule for everyone.`
          : decision === 'rejected'
            ? `Rejected “${submission.value}”.`
            : 'Marked as under review.'
      );
      await renderQueue();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  return el('tr', {}, [
    el('td', {}, [
      el('div', { text: submission.value }),
      submission.note ? el('div', { class: 'reason-cell', text: `Note: ${submission.note}` }) : null,
      submission.displayName ? el('div', { class: 'meta muted', text: submission.displayName }) : null,
    ]),
    el('td', { text: submission.kind }),
    el('td', { text: `${submission.requesters ?? 0} (+${submission.reports ?? 0} reports)` }),
    el('td', { text: relativeTime(Date.parse(submission.createdAt)) }),
    el('td', {}, [
      pill(
        SUBMISSION_STATUS[submission.status] ?? submission.status,
        submission.status === 'approved' ? 'ok' : submission.status === 'rejected' ? 'rejected' : 'pending'
      ),
    ]),
    el('td', {}, [
      el('div', { class: 'actions-cell' }, [
        el('button', {
          class: 'btn small primary',
          type: 'button',
          text: 'Approve',
          disabled: submission.status === 'approved' ? true : false,
          onclick: () => decide('approved'),
        }),
        el('button', {
          class: 'btn small',
          type: 'button',
          text: 'Reject',
          disabled: submission.status === 'rejected' ? true : false,
          onclick: () => decide('rejected'),
        }),
        decided
          ? null
          : el('button', {
              class: 'btn small',
              type: 'button',
              text: 'Under review',
              onclick: () => decide('under_review'),
            }),
      ]),
    ]),
  ]);
}

// ── Published rules ──────────────────────────────────────────────────────

async function renderRules() {
  const [keywordData, channelData] = await Promise.all([
    admin(ADMIN.keywords),
    admin(ADMIN.channels),
  ]);
  clear(panel);

  panel.append(
    ruleTable({
      icon: icon('filter', 21),
      title: 'Published keywords',
      subtitle: 'These are in force for every participating install.',
      rows: keywordData.keywords ?? [],
      labelOf: (row) => row.keyword,
      statusPath: ADMIN.keywordStatus,
      deletePath: ADMIN.keywordDelete,
      onChanged: renderRules,
    })
  );
  panel.append(
    ruleTable({
      icon: icon('tv', 21),
      title: 'Published channels',
      subtitle: 'Blocked by @handle for every participating install.',
      rows: channelData.channels ?? [],
      labelOf: (row) => row.handle,
      statusPath: ADMIN.channelStatus,
      deletePath: ADMIN.channelDelete,
      onChanged: renderRules,
    })
  );
}

function ruleTable({ icon, title, subtitle, rows, labelOf, statusPath, deletePath, onChanged }) {
  const node = card({ icon, title, subtitle });
  if (rows.length === 0) {
    node.body.append(el('div', { class: 'empty', text: 'Nothing published yet.' }));
    return node.card;
  }

  const setEnabled = async (row, enabled) => {
    try {
      await admin(statusPath(row.id), { method: 'POST', body: { enabled } });
      notify(enabled ? 'Rule enabled.' : 'Rule switched off — it stops being distributed.');
      await onChanged();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const remove = async (row) => {
    try {
      await admin(deletePath(row.id), { method: 'DELETE' });
      notify('Rule removed.');
      await onChanged();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  node.body.append(
    el('table', { class: 'admin-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Rule' }),
          el('th', { text: 'Reports' }),
          el('th', { text: 'State' }),
          el('th', { text: 'Actions' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        rows.map((row) =>
          el('tr', {}, [
            el('td', {}, [
              el('div', { text: labelOf(row) }),
              row.reason ? el('div', { class: 'reason-cell', text: row.reason }) : null,
            ]),
            el('td', { text: String(row.reports ?? 0) }),
            el('td', {}, [pill(row.enabled ? 'active' : 'off', row.enabled ? 'ok' : 'rejected')]),
            el('td', {}, [
              el('div', { class: 'actions-cell' }, [
                el('button', {
                  class: 'btn small',
                  type: 'button',
                  text: row.enabled ? 'Disable' : 'Enable',
                  onclick: () => setEnabled(row, !row.enabled),
                }),
                el('button', {
                  class: 'btn small danger',
                  type: 'button',
                  text: 'Remove',
                  onclick: () => remove(row),
                }),
              ]),
            ]),
          ])
        )
      ),
    ])
  );
  return node.card;
}

// ── False-positive reports ───────────────────────────────────────────────

/** The YouTube URL inside a report's free-text `detail` field. */
const REPORT_URL = /https?:\/\/[^\s|]+/i;

/**
 * Read a report's detail back into the parts the dashboard shows.
 *
 * The overlay writes a labelled line — `Video: … | Title: … | Channel: …` —
 * because `detail` is the one free-text field the public reports endpoint
 * already accepts. Parsing it here means an existing backend needs no schema
 * change, while the dashboard still gets a clickable video and a channel name.
 */
function parseReportDetail(detail) {
  const text = Array.isArray(detail) ? detail.join(' | ') : String(detail ?? '');
  const url = (text.match(REPORT_URL)?.[0] ?? '').replace(/[).,]+$/, '');
  const title = /(?:^|\|)\s*Title:\s*([^|]+)/i.exec(text)?.[1]?.trim() ?? '';
  const channel = /(?:^|\|)\s*Channel:\s*([^|]+)/i.exec(text)?.[1]?.trim() ?? '';
  return {
    url: url === '' ? null : url,
    title: title === '' ? null : title,
    channel: channel === '' ? null : channel,
    text: text.trim(),
  };
}

/** Every video a report row names. A grouped row may carry several details. */
function reportVideos(report) {
  const details = Array.isArray(report.details)
    ? report.details
    : Array.isArray(report.detail)
      ? report.detail
      : report.detail
        ? [report.detail]
        : [];
  const videos = details.map((detail) => ({
    ...parseReportDetail(detail),
    at: report.createdAt ?? report.lastReportedAt ?? null,
  }));
  // Some later server shape may name the URL directly; accept it as well.
  if (report.videoUrl && !videos.some((video) => video.url === report.videoUrl)) {
    videos.unshift({
      url: report.videoUrl,
      title: report.videoTitle ?? null,
      channel: report.channel ?? null,
      text: '',
      at: report.createdAt ?? null,
    });
  }
  return videos;
}

/**
 * Group the queue by what was blocked.
 *
 * A user reports a CHANNEL or a KEYWORD, so that is the heading — not one row
 * per report, which buried the fact that ten videos from one channel were all
 * wrongly covered. Each group keeps every reported video it can read, with the
 * video URL the user's click supplied.
 */
function groupReports(reports) {
  const groups = new Map();
  for (const report of reports) {
    const kind = report.kind === 'channel' ? 'channel' : 'keyword';
    const value = String(report.value ?? '');
    const key = `${kind}:${value.toLowerCase()}`;
    const group = groups.get(key) ?? {
      kind,
      value,
      count: 0,
      videos: [],
      createdAt: report.createdAt ?? null,
      lastAt: 0,
    };

    group.count += Number(report.count ?? report.reporters ?? report.reports ?? 1) || 1;
    if (!group.createdAt || Number(report.createdAt) < Number(group.createdAt)) {
      group.createdAt = report.createdAt ?? group.createdAt;
    }
    const at = Number(report.createdAt ?? report.lastReportedAt ?? 0);
    if (Number.isFinite(at) && at > group.lastAt) group.lastAt = at;

    for (const video of reportVideos(report)) {
      const duplicate = video.url
        ? group.videos.some((existing) => existing.url === video.url)
        : group.videos.some((existing) => existing.text === video.text);
      if (!duplicate) group.videos.push(video);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.videos.length - a.videos.length || b.count - a.count || a.value.localeCompare(b.value)
  );
}

/**
 * The last seven days of reports, as a small bar strip.
 *
 * A moderation queue with no sense of direction is hard to staff: the same rule
 * can sit at three reports for a month or collect them overnight, and the number
 * alone cannot tell the two apart.
 */
function reportTrend(reports) {
  const days = [];
  for (let back = 6; back >= 0; back -= 1) {
    days.push({ key: dayKey(Date.now() - back * 86_400_000), count: 0 });
  }
  const index = new Map(days.map((day) => [day.key, day]));
  for (const report of reports) {
    const at = Number(report.createdAt ?? report.lastReportedAt ?? 0);
    if (!Number.isFinite(at) || at <= 0) continue;
    const day = index.get(dayKey(at));
    if (day) day.count += Number(report.count ?? report.reporters ?? report.reports ?? 1) || 1;
  }
  return days;
}

function trendStrip(reports) {
  const days = reportTrend(reports);
  const peak = Math.max(1, ...days.map((day) => day.count));
  const week = days.reduce((sum, day) => sum + day.count, 0);
  return el('div', { class: 'report-trend' }, [
    el('div', { class: 'report-trend__head' }, [
      el('span', { class: 'report-trend__label', text: 'Reports · last 7 days' }),
      el('span', { class: 'report-trend__total', text: `${week} this week` }),
    ]),
    el(
      'div',
      {
        class: 'report-trend__bars',
        role: 'img',
        'aria-label': `False-positive reports over the last seven days: ${days.map((day) => day.count).join(', ')}`,
      },
      days.map((day) =>
        el('div', { class: 'report-trend__bar-slot' }, [
          el('div', {
            class: 'report-trend__bar',
            style: `height:${Math.max(3, Math.round((day.count / peak) * 100))}%`,
            title: `${day.key}: ${day.count}`,
          }),
        ])
      )
    ),
  ]);
}

async function renderReports() {
  const data = await admin(ADMIN.reports);
  const reports = data.reports ?? [];
  const groups = groupReports(reports);
  clear(panel);

  const node = card({
    icon: icon('alert', 21),
    title: 'False-positive reports',
    subtitle: 'Grouped by channel and keyword. Tap a card to see every reported video.',
  });

  if (groups.length === 0) {
    node.body.append(el('div', { class: 'empty', text: 'No open reports.' }));
    panel.append(node.card);
    return;
  }

  node.body.append(trendStrip(reports));

  const resolve = async (group, resolution) => {
    try {
      await admin(ADMIN.resolveReport, {
        method: 'POST',
        body: { kind: group.kind, value: group.value, resolution },
      });
      notify(resolution === 'removed' ? 'Rule switched off and reports answered.' : 'Reports answered; rule kept.');
      await renderReports();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const list = el('div', { class: 'report-groups' });
  for (const group of groups) list.append(reportGroupCard(group, resolve));
  node.body.append(list);
  panel.append(node.card);
}

/**
 * One reported target, folded down to a heading and unfolded into its videos.
 *
 * The heading is the whole point: "this channel got false reports", with the
 * count beside it. Opening it is where the administrator judges the reports —
 * every video the users named, in the order the reports arrived, as a link they
 * can watch.
 */
function reportGroupCard(group, resolve) {
  const body = el('div', { class: 'report-body hidden' });
  const kindLabel = group.kind === 'channel' ? 'Channel' : 'Keyword';
  const videoLabel = `${group.videos.length} video${group.videos.length === 1 ? '' : 's'}`;

  const head = el('button', { class: 'report-head', type: 'button', 'aria-expanded': 'false' }, [
    el('div', { class: 'report-head__titles' }, [
      el('div', { class: 'report-head__name', text: group.value }),
      el('div', {
        class: 'report-head__meta',
        text: [
          kindLabel,
          group.videos.length === 0 ? 'video URL not recorded' : `${videoLabel} reported`,
          group.lastAt ? `last ${relativeTime(group.lastAt)}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    ]),
    el('div', { class: 'report-head__side' }, [
      pill(`${group.count} report${group.count === 1 ? '' : 's'}`, 'rejected'),
      el('span', { class: 'report-head__chevron', 'aria-hidden': 'true', text: '›' }),
    ]),
  ]);

  head.addEventListener('click', () => {
    const closed = body.classList.toggle('hidden');
    head.setAttribute('aria-expanded', closed ? 'false' : 'true');
    head.classList.toggle('is-open', !closed);
  });

  if (group.videos.length === 0) {
    body.append(
      el('div', {
        class: 'report-empty',
        text: 'This report arrived without a video URL, so there is nothing to open here.',
      })
    );
  } else {
    const videos = el('div', { class: 'report-videos' });
    for (const video of group.videos) {
      const label = video.title || video.channel || video.url || 'Reported video';
      const row = video.url
        ? el(
            'a',
            {
              class: 'report-video',
              href: video.url,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            [
              el('span', { class: 'report-video__title', text: label }),
              el('span', { class: 'report-video__url', text: video.url }),
              video.channel && video.channel !== label
                ? el('span', { class: 'report-video__meta', text: video.channel })
                : null,
            ]
          )
        : el('div', { class: 'report-video report-video--plain' }, [
            el('span', { class: 'report-video__title', text: label }),
            video.text ? el('span', { class: 'report-video__meta', text: video.text }) : null,
          ]);
      videos.append(row);
    }
    body.append(videos);
  }

  body.append(
    el('div', { class: 'report-actions' }, [
      el('button', {
        class: 'btn small',
        type: 'button',
        text: 'Keep rule',
        onclick: () => resolve(group, 'kept'),
      }),
      el('button', {
        class: 'btn small danger',
        type: 'button',
        text: 'Remove rule',
        onclick: () => resolve(group, 'removed'),
      }),
    ])
  );

  return el('div', { class: 'report-card' }, [head, body]);
}

void boot();
