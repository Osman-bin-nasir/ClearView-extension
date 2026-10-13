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
import { ADMIN_EMAIL } from '../common/env.config.js';
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
  const data = await admin(ADMIN.dashboard);
  const totals = data.totals ?? {};
  clear(panel);

  const node = card({
    title: 'Review status',
    subtitle: `${totals.all ?? 0} submissions in total`,
  });
  node.body.append(
    el('div', { class: 'count-pills' }, [
      pill(`${totals.pending ?? 0} pending`, 'pending'),
      pill(`${totals.underReview ?? 0} under review`, 'pending'),
      pill(`${totals.approved ?? 0} approved`, 'ok'),
      pill(`${totals.rejected ?? 0} rejected`, 'rejected'),
    ])
  );
  panel.append(node.card);

  panel.append(demandTable('Most requested channels', data.topChannels ?? []));
  panel.append(demandTable('Most requested keywords', data.topKeywords ?? []));
}

function demandTable(title, rows) {
  const node = card({ title, subtitle: 'What the community is asking for most.' });
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
          el('td', { text: String(row.usersBlocking ?? 0) }),
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

async function renderReports() {
  const data = await admin(ADMIN.reports);
  const reports = data.reports ?? [];
  clear(panel);

  const node = card({
    title: 'False-positive reports',
    subtitle: 'Targets users say should not have been blocked.',
  });

  if (reports.length === 0) {
    node.body.append(el('div', { class: 'empty', text: 'No open reports.' }));
    panel.append(node.card);
    return;
  }

  const resolve = async (report, resolution) => {
    try {
      await admin(ADMIN.resolveReport, {
        method: 'POST',
        body: { kind: report.kind, value: report.value, resolution },
      });
      notify(resolution === 'removed' ? 'Rule switched off and reports answered.' : 'Reports answered; rule kept.');
      await renderReports();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  node.body.append(
    el('table', { class: 'admin-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Target' }),
          el('th', { text: 'Kind' }),
          el('th', { text: 'Reports' }),
          el('th', { text: 'Actions' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        reports.map((report) =>
          el('tr', {}, [
            el('td', { text: report.value }),
            el('td', { text: report.kind }),
            el('td', { text: String(report.reporters ?? report.reports ?? 0) }),
            el('td', {}, [
              el('div', { class: 'actions-cell' }, [
                el('button', {
                  class: 'btn small',
                  type: 'button',
                  text: 'Keep rule',
                  onclick: () => resolve(report, 'kept'),
                }),
                el('button', {
                  class: 'btn small danger',
                  type: 'button',
                  text: 'Remove rule',
                  onclick: () => resolve(report, 'removed'),
                }),
              ]),
            ]),
          ])
        )
      ),
    ])
  );
  panel.append(node.card);
}

void boot();
