// The title treatment, built from text and plain boxes so the loading screen can carry the same
// mark before any script has run (index.html holds a static copy with this exact structure).
//
//   VICE '86          Display type, white, with the year in pink
//   ───────           a pink leaning line with a soft glow: the one neon touch
//    ── ─             two fainter echo stripes under it, the nod to a sunset's bands
//   PALOMA DRIVE 1986  the tag line in small spaced capitals

import { el } from './dom.js';

export const TAG_LINE = 'Paloma Drive \u00b7 1986';

export function wordmark(doc, className = '') {
  const root = el(doc, 'div', `wordmark ${className}`.trim(),
    el(doc, 'div', 'wordmark__title', el(doc, 'span', 'wordmark__word', 'VICE'), el(doc, 'span', 'wordmark__year', '\u201986')),
    el(doc, 'div', 'wordmark__line'),
    el(doc, 'div', 'wordmark__stripes', el(doc, 'i', ''), el(doc, 'i', '')),
    el(doc, 'div', 'wordmark__tag', TAG_LINE));
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', "VICE '86");
  return root;
}
