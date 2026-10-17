/**
 * The "ask to block it for everyone" row.
 *
 * The card pairs a kind picker (Keyword / Channel handle) with the value field.
 * `.input` and `.select` share a rule that makes them `width: 100%`, which inside
 * a flex row let the picker claim the whole line and left the field with no room:
 * the input was built and appended, but there was nothing to type into. These
 * checks pin the override that gives the field its space back, and that the row
 * still builds both controls.
 *
 * Layout is checked statically — the shipped CSS and the DOM the script builds —
 * because the suite has no renderer with real layout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = readFileSync(resolve(ROOT, 'src/options/options.js'), 'utf8');
const optionsHtml = readFileSync(resolve(ROOT, 'src/options/options.html'), 'utf8');
const optionsCss = readFileSync(resolve(ROOT, 'src/options/options.css'), 'utf8');
const theme = readFileSync(resolve(ROOT, 'src/ui/theme.css'), 'utf8');

/** The declaration block for a selector, or '' when it is not there. */
function ruleFor(css, selector) {
  const index = css.indexOf(`${selector} {`);
  if (index === -1) return '';
  return css.slice(index, css.indexOf('}', index));
}

test('a select next to a field is sized to its own content', () => {
  // The shared rule is what makes this necessary: both controls are full width.
  assert.match(
    ruleFor(theme, '.input,\n.select'),
    /width:\s*100%/,
    'the shared input/select rule is still full width'
  );
  const override = ruleFor(optionsCss, '.field-row .select');
  assert.ok(override, 'the options page must override the picker inside a field row');
  assert.match(override, /flex:\s*0 0 auto/, 'the picker must not grow or shrink');
  assert.match(override, /width:\s*auto/, 'and it must size to its own label');
  assert.match(
    ruleFor(optionsCss, '.field-row .input'),
    /min-width:\s*0/,
    'the field must be allowed to shrink rather than overflow the card'
  );
});

test('the sidebar links to sections the page actually builds', () => {
  // A navigation rail whose entries scroll to nothing is worse than no rail:
  // the redesign only holds together if every link has a matching section.
  const navIds = [...optionsHtml.matchAll(/href="#([\w-]+)"/g)].map((match) => match[1]);
  for (const id of ['protection', 'youtube', 'blocked-items', 'community', 'activity', 'security', 'advanced']) {
    assert.ok(navIds.includes(id), `the sidebar must link to #${id}`);
    assert.ok(
      new RegExp(`settingsGroup\\(\\s*'${id}'`).test(options),
      `the page must build a #${id} section for that link`
    );
  }
  assert.ok(/id="protection-scope"/.test(optionsHtml), 'the changing status line still has its node');
  assert.ok(/id="open-admin"/.test(optionsHtml), 'the admin entry still has its node');
  assert.ok(/class="brand-mark"/.test(optionsHtml) && /icons\/logo\.png/.test(optionsHtml));
  assert.match(
    optionsCss,
    /\.settings-shell \{[\s\S]{0,120}grid-template-columns/,
    'the page is a two-column shell on wide windows'
  );
});

test('the ask-to-block card builds both the picker and the field', () => {
  // The row is the one place a select and a text field sit together, and it is
  // tagged so the override above cannot reach a field row that has no select.
  assert.ok(
    /class: 'field-row suggest-row'/.test(options),
    'the row is tagged and can wrap on a narrow window'
  );
  assert.ok(
    /class: 'select'/.test(options) && /value: 'keyword'/.test(options) && /value: 'channel'/.test(options),
    'the kind picker keeps both options'
  );
  assert.ok(
    /class: 'input', placeholder: 'e\.g\. a keyword or @channelhandle'/.test(options),
    'the value field is still built into that row'
  );
  assert.ok(
    /input\.placeholder = kindSelect\.value === 'channel'/.test(options),
    'and it re-labels itself when the picker changes'
  );
});
