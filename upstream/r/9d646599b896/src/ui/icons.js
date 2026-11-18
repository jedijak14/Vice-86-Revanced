// Line icons, drawn on a 24-unit grid with a thin stroke (set in CSS).
// Each entry is the path data of one icon; `icon()` wraps it in an inline SVG that takes its
// colour from the surrounding text (currentColor) and its size from CSS (.icon).

import { svg } from './dom.js';

const PATHS = {
  // Dipped-beam symbol: lamp lens on the right, five rays falling to the left.
  headlamps: 'M14 5.5c4.5 0 7 2.9 7 6.5s-2.5 6.5-7 6.5c-1.3-1.9-2-4.1-2-6.5s.7-4.6 2-6.5ZM9 7.2l-6 1.6M9 10.4l-6 1.6M9 13.6l-6 1.6M9 16.8l-6 1.6',
  // Brake warning symbol: a ringed exclamation mark between two brake-shoe arcs.
  handbrake: 'M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM4.6 5.2a10 10 0 0 0 0 13.6M19.4 5.2a10 10 0 0 1 0 13.6M12 8.6v4.2M12 15.4v.1',
  pause: 'M8.5 5v14M15.5 5v14',
  camera: 'M3 8.5h3.2l1.6-2.5h8.4l1.6 2.5H21V19H3ZM12 10.5a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6Z',
  chevronLeft: 'M14.5 5.5 8 12l6.5 6.5',
  chevronRight: 'M9.5 5.5 16 12l-6.5 6.5',
  back: 'M10 6l-6 6 6 6M4 12h16',
  // Tall, slim chevrons for the edges of the garage.
  previous: 'M15 2.5 8.5 12l6.5 9.5',
  next: 'M9 2.5 15.5 12 9 21.5',
  // Pedals for the touch layer.
  throttle: 'M9 3.5h6l1.5 17h-9Z M9.2 8h5.6M8.8 12h6.4M8.4 16h7.2',
  brake: 'M4.5 8.5h15v8h-15ZM8 8.5v8M12 8.5v8M16 8.5v8',
  boost: 'M10 3h4v2.5l1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 8.5 19V7L10 5.5ZM8.5 11h7M8.5 15h7',
};

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

/** An inline SVG icon. Decorative by default (hidden from assistive technology). */
export function icon(doc, name, className = '') {
  const path = PATHS[name];
  if (!path) throw new Error(`Unknown icon: ${name}`);
  return svg(doc, 'svg', { class: `icon ${className}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    svg(doc, 'path', { d: path }));
}

/** Raw path data of an icon, for tests and previews. */
export const iconPath = (name) => PATHS[name];
