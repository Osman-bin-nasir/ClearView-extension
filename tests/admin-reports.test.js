/**
 * The admin dashboard's false-positive queue, guarded at the seams.
 *
 * The dashboard script builds its DOM from `ui/shared.js` and needs a signed-in
 * worker, so — like the other page tests here — the shipped artefacts are
 * checked statically, with comments stripped so prose cannot stand in for
 * behaviour.
 *
 * The rules pinned here are the ones that failed silently when they were wrong:
 *
 *  - a report names the VIDEO, so the administrator can watch what was covered;
 *  - reports are grouped by the channel (or keyword) that was blocked, not one
 *    opaque row per report;
 *  - a card opens to show every reported video, as a real link.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (path) => strip(readFileSync(resolve(ROOT, path), 'utf8'));

const admin = read('src/admin/admin.js');
const html = read('src/admin/admin.html');
const css = read('src/admin/admin.css');

test('a report group is the channel, and opens to its videos', () => {
  assert.ok(admin.includes('function groupReports'), 'the queue is grouped before it is drawn');
  assert.ok(
    /const key = `\$\{kind\}:\$\{value\.toLowerCase\(\)\}`/.test(admin),
    'two reports of the same channel belong to one group'
  );
  assert.ok(
    /subtitle: 'Grouped by channel and keyword\. Tap a card to see every reported video\.'/.test(admin),
    'the card says what the grouped queue is'
  );
  assert.ok(
    /head\.addEventListener\('click'/.test(admin) &&
      /body\.classList\.toggle\('hidden'\)/.test(admin) &&
      /head\.setAttribute\('aria-expanded'/.test(admin),
    'tapping a group opens it, and the state is announced'
  );
  assert.ok(
    /class: 'report-video',[\s\S]{0,200}href: video\.url,[\s\S]{0,120}target: '_blank'/.test(admin),
    'each reported video is a real link that opens in a new tab'
  );
  assert.ok(
    /href: video\.url,[\s\S]{0,200}rel: 'noopener noreferrer'/.test(admin),
    'and the new tab cannot reach back into the dashboard'
  );
  assert.ok(
    admin.includes('report${group.count === 1') && admin.includes('group.count} report'),
    'the group heading carries how many users reported it'
  );
});

test('the dashboard can read the video out of a report’s detail field', () => {
  assert.ok(admin.includes('function parseReportDetail'), 'the detail line is parsed, not printed raw');
  assert.ok(
    admin.includes('const REPORT_URL = /https?:\\/\\/[^\\s|]+/i'),
    'the video URL is the first URL in the detail'
  );
  assert.ok(
    admin.includes('Channel:') && admin.includes("(?:^|\\|)\\s*Channel:"),
    'and the channel name is recovered for channels that were blocked by keyword'
  );
  assert.ok(
    /Array\.isArray\(report\.details\)/.test(admin) && /Array\.isArray\(report\.detail\)/.test(admin),
    'a grouped server row may carry several details; every one is read'
  );
  assert.ok(
    /report\.videoUrl/.test(admin),
    'a server that names the URL directly is accepted too'
  );
});

test('the overview shows false-positive rates and contested rules', () => {
  assert.ok(admin.includes('function falsePositiveCell'), 'a rate is shown beside each rule');
  assert.ok(
    /function falsePositiveCell\(group, requests\)[\s\S]{0,300}Math\.round\(\(group\.count \/ total\) \* 100\)/.test(admin),
    'the share is reports / (requests + reports), so it cannot exceed 100%'
  );
  assert.ok(
    /group\.count >= 3 \? pill\('contested'/.test(admin),
    'three or more reports flags a rule'
  );
  assert.ok(admin.includes('function contestedCard'), 'the overview has a contested-rules card');
  assert.ok(
    /admin\(ADMIN\.reports\)\.catch\(\(\) => \(\{ reports: \[\] \}\)\)/.test(admin),
    'a refused reports call degrades instead of taking the overview down'
  );
  assert.ok(admin.includes('function reportTrend'), 'seven-day report activity is computed');
  assert.ok(admin.includes('function trendStrip'), 'and drawn as a strip on the reports tab');
});

test('the dashboard is a flat work surface, not a second design language', () => {
  assert.ok(html.includes('class="brand-mark"') && html.includes('icons/logo.png'));
  assert.ok(/id="tabs"/.test(html) && /data-tab="reports"/.test(html));
  assert.ok(admin.includes("class: 'admin-stats'"), 'the overview leads with numbers, not pills');
  assert.match(css, /\.tabs \{[\s\S]{0,200}border-bottom: 1px solid var\(--admin-border\)/);
  assert.match(css, /\.tab\.selected \{[\s\S]{0,120}border-bottom-color: var\(--primary\)/);
  assert.match(
    css,
    /#panel > \.card \{[\s\S]{0,220}background-image: none/,
    'cards on this page are flat'
  );
  assert.match(css, /\.report-video__url \{[\s\S]{0,120}word-break: break-all/, 'long URLs stay inside the card');
  assert.match(css, /@media \(max-width: 720px\)/, 'the dashboard has a narrow-window layout');
});
