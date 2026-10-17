/**
 * The icon set the extension's pages draw with.
 *
 * The app's Protection tab carries a line icon on every row — a shield for the
 * switch, a brain for Brain Bot, a triangle for Strict Mode — and the pages used
 * to stand in coloured emoji instead. Emoji cannot take the accent colour, they
 * render differently on every platform, and they sit oddly beside the sentence
 * they label, so the rows now share one drawn set: 24×24, no fill, `currentColor`
 * stroke, 1.8 wide, round joins. That is what lets a tile tint them teal on a
 * plain row and white inside a coloured hero card without a second set.
 *
 * Icons are decorative by construction: every one is inserted with
 * `aria-hidden`, and the text next to it is what a screen reader reads.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * `name: [[tag, attributes], ...]`, in 24×24 user units.
 *
 * Path data rather than drawings: the shapes are simple enough that a path says
 * exactly what it is, and nothing here needs to be fetched or bundled.
 */
const ICONS = {
  shield: [
    ['path', { d: 'M12 3.2l7.2 3v5c0 4.5-3 8.2-7.2 9.8-4.2-1.6-7.2-5.3-7.2-9.8v-5l7.2-3z' }],
    ['path', { d: 'M9.2 12.1l2.1 2.1 4-4.4' }],
  ],
  'shield-off': [
    ['path', { d: 'M12 3.2l7.2 3v5c0 4.5-3 8.2-7.2 9.8-4.2-1.6-7.2-5.3-7.2-9.8v-5l7.2-3z' }],
    ['path', { d: 'M5.2 4.6l13.6 14.8' }],
  ],
  ban: [
    ['circle', { cx: '12', cy: '12', r: '8.4' }],
    ['path', { d: 'M6.1 17.9l11.8-11.8' }],
  ],
  brain: [
    ['path', { d: 'M12 5.4v13.2' }],
    ['path', { d: 'M12 6.6A3.2 3.2 0 008.8 9.8v.3a2.5 2.5 0 00.6 4.9A2.8 2.8 0 0012 18.2' }],
    ['path', { d: 'M12 6.6a3.2 3.2 0 013.2 3.2v.3a2.5 2.5 0 01-.6 4.9A2.8 2.8 0 0112 18.2' }],
  ],
  play: [
    ['circle', { cx: '12', cy: '12', r: '8.4' }],
    ['path', { d: 'M10.3 9.2l4.6 2.8-4.6 2.8z' }],
  ],
  filter: [['path', { d: 'M4.5 5.5h15l-6 7.2v5.6l-3-1.7v-3.9l-6-7.2z' }]],
  tv: [
    ['path', { d: 'M3.6 7h16.8v10.4H3.6z' }],
    ['path', { d: 'M8.6 20.4h6.8' }],
  ],
  alert: [
    ['path', { d: 'M12 4.6l8.1 14.2H3.9L12 4.6z' }],
    ['path', { d: 'M12 10.2v3.6' }],
    ['path', { d: 'M12 16.5h.01' }],
  ],
  globe: [
    ['circle', { cx: '12', cy: '12', r: '8.4' }],
    ['path', { d: 'M3.6 12h16.8' }],
    ['path', { d: 'M12 3.6c2.4 2.6 2.4 14.2 0 16.8' }],
    ['path', { d: 'M12 3.6c-2.4 2.6-2.4 14.2 0 16.8' }],
  ],
  share: [
    ['circle', { cx: '17.6', cy: '6.4', r: '2.6' }],
    ['circle', { cx: '6.4', cy: '12', r: '2.6' }],
    ['circle', { cx: '17.6', cy: '17.6', r: '2.6' }],
    ['path', { d: 'M8.7 10.7l6.6-3.1M8.7 13.3l6.6 3.1' }],
  ],
  upload: [
    ['path', { d: 'M4.4 15.4v2.8a1.8 1.8 0 001.8 1.8h11.6a1.8 1.8 0 001.8-1.8v-2.8' }],
    ['path', { d: 'M12 15.2V4.4' }],
    ['path', { d: 'M8 8.4L12 4.4l4 4' }],
  ],
  send: [
    ['path', { d: 'M20.4 4.2L3.8 10.6l6.1 2.4 2.4 6.1 8.1-14.9z' }],
    ['path', { d: 'M9.9 13l4.6-4.6' }],
  ],
  activity: [
    ['path', { d: 'M3.6 13.2h3.1l2-5.6 2.9 9.2 2.3-6.4 1.7 2.8h4.8' }],
  ],
  lock: [
    ['path', { d: 'M6.6 10.6h10.8a1.4 1.4 0 011.4 1.4v6.2a1.4 1.4 0 01-1.4 1.4H6.6a1.4 1.4 0 01-1.4-1.4V12a1.4 1.4 0 011.4-1.4z' }],
    ['path', { d: 'M8.8 10.6V8.2a3.2 3.2 0 016.4 0v2.4' }],
  ],
  unlock: [
    ['path', { d: 'M6.6 10.6h10.8a1.4 1.4 0 011.4 1.4v6.2a1.4 1.4 0 01-1.4 1.4H6.6a1.4 1.4 0 01-1.4-1.4V12a1.4 1.4 0 011.4-1.4z' }],
    ['path', { d: 'M8.8 10.6V8.2a3.2 3.2 0 016.2-.9' }],
  ],
  server: [
    ['path', { d: 'M4.4 5.6h15.2v5H4.4zM4.4 13.4h15.2v5H4.4z' }],
    ['path', { d: 'M7.6 8.1h.01M7.6 15.9h.01' }],
  ],
  fingerprint: [
    ['path', { d: 'M4.8 12A7.2 7.2 0 0112 4.8' }],
    ['path', { d: 'M19.2 12A7.2 7.2 0 0112 19.2' }],
    ['path', { d: 'M7.8 12.6a4.2 4.2 0 018.4 0v3.6' }],
    ['path', { d: 'M10.8 12.8a1.5 1.5 0 013 0v4.4' }],
  ],
  'eye-off': [
    ['path', { d: 'M4 4.6l16 14.8' }],
    ['path', { d: 'M9.6 6.2A9.6 9.6 0 0112 6c4.6 0 8 4.1 8.4 5.9a9.3 9.3 0 01-2.6 3.9' }],
    ['path', { d: 'M6.2 8.2A10.4 10.4 0 003.6 12c.4 1.9 3.8 6 8.4 6a9.4 9.4 0 003.6-.7' }],
  ],
  info: [
    ['circle', { cx: '12', cy: '12', r: '8.4' }],
    ['path', { d: 'M12 11.2v5.2' }],
    ['path', { d: 'M12 8h.01' }],
  ],
  chevron: [['path', { d: 'M9.6 5.8L15.4 12l-5.8 6.2' }]],
  settings: [
    ['path', { d: 'M4.8 8.6h14.4M4.8 15.4h14.4' }],
    ['circle', { cx: '9.4', cy: '8.6', r: '2.2' }],
    ['circle', { cx: '15', cy: '15.4', r: '2.2' }],
  ],
  check: [['path', { d: 'M5.4 12.6l4.4 4.4 8.8-9.6' }]],
};

/** Every name `icon()` accepts — used by the tests to keep the set honest. */
export function iconNames() {
  return Object.keys(ICONS);
}

/**
 * One icon, as an `<svg>` sized to `size` and stroked in `currentColor`.
 *
 * Built with `createElementNS` where it exists, because `createElement('svg')`
 * makes an HTML element that browsers do not lay out as a drawing. The test DOM
 * shim has no namespace API, so it falls back to the plain builder and the pages
 * stay renderable there.
 */
export function icon(name, size = 20) {
  const parts = ICONS[name] ?? ICONS.info;
  const make = (tag) =>
    typeof document.createElementNS === 'function'
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);

  const svg = make('svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');

  for (const [tag, attributes] of parts) {
    const child = make(tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
    svg.append(child);
  }
  return svg;
}
