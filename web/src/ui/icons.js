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
  // A five-pointed star for the wanted level: one closed path, so it takes the surrounding colour.
  star: 'M12 3.4l2.62 5.3 5.86.85-4.24 4.13 1 5.83L12 16.66l-5.24 2.75 1-5.83L3.52 9.55l5.86-.85Z',
  // A racing flag on a pole, checked by two bars across it rather than by fills.
  flag: 'M5 3.5V21M8 4.5h11v7.5H8ZM8 12h11v7.5H8ZM13.6 4.5V19.5M8 8.2h11',
  // A launch under sail: hull, waterline, mast and a jib. Boats and the harbour read from it.
  boat: 'M3.4 15.4h17.2l-2.1 4.1a1.7 1.7 0 0 1-1.45.85H7a1.7 1.7 0 0 1-1.45-.85ZM12 3.2V14M12 4.6l6.2 8H12ZM5.6 12.6h3.2',
  // One person, and a crowd of two: the street's own population.
  person: 'M12 4.2a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6ZM7.6 20.6v-3.4a4.4 4.4 0 0 1 8.8 0v3.4',
  people: 'M8.4 8.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM3.6 20.4V17a4.8 4.8 0 0 1 9.6 0v3.4M15.8 5.4a2.2 2.2 0 0 1 0 4.4M17.6 20.4v-3.2a4.4 4.4 0 0 0-2-3.6',
  // The emergency beacon: a lens on its base, three rays off the top.
  siren: 'M6.6 14.4h10.8l-1-4.6a4.4 4.4 0 0 0-8.8 0ZM4.2 17.2h15.6v3.2H4.2ZM9 4.4V2.6M15 4.4V2.6M12 3.8V1.8',
  // A stop watch for the races, and a plotted line for a route.
  timer: 'M12 6.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2ZM12 10.4v2.2l2.4 2M9.4 2.4h5.2M12 2.4v4M18.2 5.4l1.8 1.8',
  route: 'M6.4 17.4a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2ZM17.6 2.4a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2ZM8.5 19.5h3.9a3 3 0 0 0 0-6h-1a3 3 0 0 1 0-6h3.9',
  // Night and day, for the clock's own control.
  moon: 'M19.6 14.2A8.1 8.1 0 0 1 9.7 4.3a7.9 7.9 0 1 0 9.9 9.9Z',
  sun: 'M12 7.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2ZM12 2.6v2.2M12 19.2v2.2M4.6 12H2.4M21.6 12h-2.2M6.7 6.7 5.1 5.1M18.9 18.9l-1.6-1.6M6.7 17.3l-1.6 1.6M18.9 5.1l-1.6 1.6',
  // A phone turning in the hand, for tilt steering.
  tilt: 'M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2ZM5 8.6A7.7 7.7 0 0 1 12 4.3M19 15.4A7.7 7.7 0 0 1 12 19.7M5 8.6 3.3 6.7M5 8.6l2.2-1.3M19 15.4l1.7 1.9M19 15.4l-2.2 1.3',
  // A steering wheel, for the touch layout that puts one under the thumb.
  wheel: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8ZM12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2ZM3.7 12h4.6M15.7 12h4.6M12 15.6v4.7',
  // The harbour, and a link between two machines.
  anchor: 'M12 3.4a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM12 7.4V21M6.2 12.4H3.6a8.4 8.4 0 0 0 16.8 0h-2.6M8.6 10.4 12 7.4l3.4 3',
  link: 'M9.6 14.4a3.6 3.6 0 0 1 0-5.1l2.5-2.5a3.6 3.6 0 0 1 5.1 5.1l-1.3 1.3M14.4 9.6a3.6 3.6 0 0 1 0 5.1l-2.5 2.5a3.6 3.6 0 0 1-5.1-5.1l1.3-1.3',
  // A job to do: a pinned marker, and a list of them.
  target: 'M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 1.6v2.8M12 19.6v2.8M1.6 12h2.8M19.6 12h2.8',
  jobs: 'M6.4 3.4h11.2v17.2l-2.8-2-2.8 2-2.8-2-2.8 2ZM9.4 8h5.2M9.4 11.8h5.2',
  radio: 'M4.2 9.6h15.6v10.2H4.2ZM8.6 9.6 16.4 3.8M7.2 12.6h4.4M7.2 15.4h3.2M14.6 14.7a2.1 2.1 0 1 0 0 .1Z',
  pulse: 'M2.8 12.4h4l2.4-5.6 3.4 10.4 2.4-4.8h6.2',
  camera: 'M3.4 7.6h11.2v7.2H3.4ZM14.6 10.2l6-2.5v7l-6-2.5ZM9 14.8v3.6M6.2 18.4h5.6',
  lock: 'M6.8 10.6h10.4v9.6H6.8ZM9.4 10.6V8.2a2.6 2.6 0 0 1 5.2 0v2.4M12 14.2v2.6',
  drop: 'M12 3.6c3.2 4 5.4 6.9 5.4 9.7a5.4 5.4 0 0 1-10.8 0c0-2.8 2.2-5.7 5.4-9.7Z',
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
