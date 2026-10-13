/**
 * The YouTube ad blocker, guarded at the seams.
 *
 * Like the Shorts and channel-menu guards, the shipped artefacts are checked
 * statically here, because a content script has no module system to import. The
 * invariants are the ones whose failure is SILENT: a ruleset that is never
 * switched on, a toggle that is stored but never read, an ad class the
 * stylesheet does not know. None of those would throw; they would just leave
 * ads on the page with an "on" switch next to them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AD_RULESET_ID, DEFAULT_SETTINGS, PASSWORD } from '../src/common/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const rulesetPath = manifest.declarative_net_request?.rule_resources?.[0]?.path;
const script = read('src/content/youtube.js');
const css = read('src/content/youtube.css').replace(/\/\*[\s\S]*?\*\//g, '');
const worker = read('src/background/service-worker.js');
const blocking = read('src/background/blocking.js');
const constants = read('src/common/constants.js');

// ── The manifest ruleset ─────────────────────────────────────────────────

test('the ad ruleset is declared and starts disabled', () => {
  const resources = manifest.declarative_net_request?.rule_resources;
  assert.ok(Array.isArray(resources) && resources.length === 1, 'exactly one ruleset is declared');
  assert.equal(resources[0].id, AD_RULESET_ID, 'the id must be the one the worker enables');
  assert.equal(resources[0].enabled, false, 'the toggle, not the install, decides whether it runs');
  assert.ok(manifest.permissions.includes('declarativeNetRequest'), 'the DNR permission is required');
});

test('the ruleset file exists where the manifest says it is', () => {
  assert.ok(rulesetPath, 'the manifest must name a path');
  assert.ok(existsSync(resolve(ROOT, rulesetPath)), `${rulesetPath} must be in the repository`);
});

test('the shipped rules parse, block, and are scoped to YouTube', () => {
  const rules = JSON.parse(read(rulesetPath));
  assert.ok(Array.isArray(rules) && rules.length > 5, 'the ruleset must carry real rules');

  const ids = new Set();
  for (const rule of rules) {
    assert.equal(typeof rule.id, 'number', 'every rule needs a numeric id');
    assert.ok(!ids.has(rule.id), `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    assert.equal(rule.action.type, 'block', `rule ${rule.id} must block`);
    assert.ok(
      Array.isArray(rule.condition.initiatorDomains) && rule.condition.initiatorDomains.includes('youtube.com'),
      `rule ${rule.id} must be scoped to requests originating on YouTube`
    );
    assert.ok(Array.isArray(rule.condition.resourceTypes) && rule.condition.resourceTypes.length > 0);
    assert.ok(
      !rule.condition.resourceTypes.includes('main_frame'),
      `rule ${rule.id} must never block a top-level navigation`
    );
  }
});

test('the ad networks that actually serve YouTube ads are covered', () => {
  const filters = JSON.parse(read(rulesetPath)).map((rule) => rule.condition.urlFilter);
  const joined = filters.join(' ');
  for (const network of ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', '2mdn.net']) {
    assert.ok(joined.includes(network), `${network} must be blocked`);
  }
  assert.ok(joined.includes('/pagead/'), "YouTube's own /pagead/ path must be blocked");
  assert.ok(joined.includes('/get_midroll_info'), 'mid-roll ad decisions must be blocked');
});

// ── The switch, end to end ───────────────────────────────────────────────

test('the toggle is a setting, on by default', () => {
  assert.equal(DEFAULT_SETTINGS.blockYoutubeAds, true, 'the ad blocker is the headline feature');
  assert.ok(
    /blockYoutubeAds: true/.test(constants),
    'the default must be declared in constants.js'
  );
});

test('the worker enables the ruleset from the setting, under the master switch', () => {
  assert.ok(blocking.includes('export async function installAdRules'), 'the ruleset switch lives in blocking.js');
  assert.ok(blocking.includes('updateEnabledRulesets'), 'the ruleset is enabled at runtime');
  assert.ok(blocking.includes('enableRulesetIds'), 'turning it on must enable the ruleset');
  assert.ok(blocking.includes('disableRulesetIds'), 'turning it off must disable the ruleset again');
  assert.ok(
    /installAdRules\(Boolean\(state\.settings\?\.protectionEnabled && state\.settings\?\.blockYoutubeAds\)\)/.test(
      worker
    ),
    'ads follow the ad switch only while Protection is on'
  );
});

test('the content script is told about the ad switch', () => {
  assert.ok(
    /rulesForContent[\s\S]*blockYoutubeAds: settings\.blockYoutubeAds/.test(worker),
    'the content config must carry the ad switch'
  );
  assert.ok(script.includes('blockYoutubeAds: false'), 'the content script default must be off until told');
});

// ── The content script ───────────────────────────────────────────────────

test('ad slots are removed, and the removal is reversible', () => {
  assert.ok(script.includes("const HIDE_ADS_CLASS = 'cv-block-ads'"), 'the html class must be named');
  assert.ok(script.includes('function removeAdElements'), 'the in-feed ads must be removed, not just hidden');
  assert.ok(
    script.includes('function restoreAdElements'),
    'turning the switch off must put the page back rather than leave holes'
  );
  assert.ok(script.includes('removedAds'), 'removed nodes must be tracked to be restored');
});

test('the ad pass runs on mutations AND on a heartbeat', () => {
  // A video ad is announced by a CLASS change on the player, which fires no
  // mutation — a pass driven only by the observer would routinely miss it.
  assert.ok(/function scheduleScan\(\)[\s\S]*applyAds\(\)/.test(script), 'the mutation pass must re-apply ads');
  assert.ok(script.includes('function startAdHeartbeat'), 'a heartbeat is required for the player');
  assert.ok(/setInterval\([\s\S]*applyAds\(\)/.test(script), 'the heartbeat must call the ad pass');
});

test('a video ad is skipped with YouTube’s own control where one exists', () => {
  assert.ok(script.includes('AD_SKIP_SELECTOR'), 'the skip control selector is required');
  assert.ok(script.includes('.ytp-ad-skip-button'), 'the modern skip button must be covered');
  assert.ok(script.includes('.ytp-skip-ad-button'), 'the alternative skip button must be covered');
  assert.ok(script.includes('skip.click()'), 'the skip control must be clicked');
  assert.ok(
    script.includes('AD_OVERLAY_CLOSE_SELECTOR'),
    'a banner/overlay ad must be dismissible too'
  );
});

test('an unskippable ad is run out, and the mute it costs is undone', () => {
  assert.ok(script.includes('video.currentTime = video.duration'), 'an unskippable ad must be fast-forwarded');
  assert.ok(script.includes('cvAdMuted'), 'the mute the pass applies must be remembered');
  assert.ok(
    /cvAdMuted === '1'[\s\S]{0,80}video\.muted = false/.test(script),
    'and undone when the ad ends, so the real video is never left silent'
  );
});

test('the stylesheet hides the ad containers by class, independent of the script', () => {
  assert.ok(css.includes('html.cv-block-ads'), 'the stylesheet must key on the html class');
  for (const selector of [
    '#masthead-ad',
    '#player-ads',
    'ytd-ad-slot-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-display-ad-renderer',
    'ytp-ad-overlay-slot',
  ]) {
    assert.ok(css.includes(selector), `the stylesheet must cover ${selector}`);
  }
});

// ── The UI ───────────────────────────────────────────────────────────────

test('both surfaces offer the ads toggle and write the same setting', () => {
  for (const page of ['src/popup/popup.js', 'src/options/options.js']) {
    const source = read(page);
    assert.ok(source.includes('Block YouTube ads'), `${page} must name the control`);
    assert.ok(source.includes('blockYoutubeAds'), `${page} must write the setting`);
  }
});

// ── The password gate ────────────────────────────────────────────────────

test('the password is stored locally, never synced', () => {
  assert.equal(PASSWORD.minLength, 4);
  assert.ok(constants.includes("password: 'cv.password'"), 'the storage key must exist');
  // The settings module is what decides sync vs local; a password in `sync`
  // would travel to every signed-in Chrome profile.
  const source = read('src/common/password.js');
  assert.ok(source.includes('writeLocal'), 'the password record must be written locally');
  assert.ok(!/writeSettings|storage\.sync/.test(source), 'the password must never be written to sync storage');
});

test('changing Protection is gated in the worker, not only in the UI', () => {
  // A lock that only exists in a page is not a lock: the switch can be flipped
  // by a message from anywhere, so the check has to be in the one path every
  // change passes through.
  assert.ok(
    /'settings\/update':[\s\S]{0,400}hasPassword\(\)[\s\S]{0,200}verifyPassword\(/.test(worker),
    'settings/update must verify the password when protection changes'
  );
  assert.ok(worker.includes("ApiError('invalid_password'"), 'a wrong password must be refused with a code');
});

test('the password can be created, changed and removed, each with its own guard', () => {
  for (const handler of ["'password/set'", "'password/change'", "'password/remove'", "'password/verify'"]) {
    assert.ok(worker.includes(handler), `the worker must handle ${handler}`);
  }
  // Change and remove must require the CURRENT password — otherwise the lock
  // removes itself.
  assert.ok(
    /'password\/change':[\s\S]{0,260}verifyPassword\(message\.current/.test(worker),
    'changing the password must require the current one'
  );
  assert.ok(
    /'password\/remove':[\s\S]{0,260}verifyPassword\(message\.password/.test(worker),
    'removing the password must require it'
  );
});

test('the first-run offer is dismissible and remembers the answer', () => {
  assert.ok(worker.includes("'password/dismissOnboarding'"), 'skipping must be recorded');
  const options = read('src/options/options.js');
  assert.ok(options.includes('offerPasswordOnFirstRun'), 'the options page must offer it once');
  assert.ok(options.includes('Skip for now'), 'and must let the user past it');
});
