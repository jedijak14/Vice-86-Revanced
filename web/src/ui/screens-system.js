// The screens outside the menu system: loading, fatal error, and the toast line.

import { el, attrs, textWriter, styleWriter } from './dom.js';
import { wordmark } from './wordmark.js';

// ---------------------------------------------------------------- loading

/** Control hints shown one at a time under the bar while the city is built. */
export const LOADING_TIPS = Object.freeze([
  'W or the up arrow is the throttle; S brakes, then reverses.',
  'Space is the handbrake. Hold it into a bend to swing the tail.',
  'Left Shift fires the nitrous while the gauge beside the rev arc has charge.',
  'T steps the time of day; Y changes the weather.',
  'H switches the headlamps; the dipped-beam symbol shows under the gear.',
  'C changes the camera; G sounds the horn.',
  'F gets you out, and gets you into a car or a boat you walk up to.',
  'M turns the radio dial: three stations, and it only plays while you drive.',
  'R puts the car back on the nearest road if it gets stuck.',
  'Esc pauses. The settings there apply at once, even the graphics preset.',
]);

/** How often the tip changes. */
export const TIP_MS = 4000;

function buildLoading(doc) {
  // Same structure as the static copy in index.html, which is on screen before any script runs.
  return el(doc, 'div', 'loading',
    wordmark(doc, 'loading__wordmark'),
    el(doc, 'div', 'loading__progress',
      el(doc, 'div', 'loading__row', el(doc, 'span', 'loading__label'), el(doc, 'span', 'loading__percent')),
      el(doc, 'div', 'loading__bar', el(doc, 'div', 'loading__fill'))),
    el(doc, 'div', 'loading__tip'));
}

/**
 * Loading screen: the wordmark, a progress line with a stage label and a percentage, and a
 * control hint that changes every few seconds.
 * Uses the markup already in the page when there is one (so the first paint and the scripted
 * screen are the same element), and builds it otherwise.
 * Returns { el, set(fraction, label), show(), hide(), visible }.
 */
export function createLoading({ doc, parent, win }) {
  let root = typeof parent.querySelector === 'function' ? parent.querySelector('.loading') : null;
  if (!root) {
    root = buildLoading(doc);
    parent.appendChild(root);
  }
  const find = (name) => root.querySelector(`.${name}`);
  attrs(root, { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Loading' });

  const writeFill = styleWriter(find('loading__fill'), '--progress');
  const writeLabel = textWriter(find('loading__label'));
  const writePercent = textWriter(find('loading__percent'));
  const writeTip = textWriter(find('loading__tip'));
  let shown = 0;
  let tip = 0;
  let tipTimer = null;

  // Tips rotate on a chained timeout (no setInterval: nothing fires on a hidden page's backlog).
  const canTime = Boolean(win && win.setTimeout && win.clearTimeout);
  function nextTip() {
    writeTip(LOADING_TIPS[tip]);
    tip = (tip + 1) % LOADING_TIPS.length;
    tipTimer = win.setTimeout(nextTip, TIP_MS);
  }
  function startTips() {
    if (tipTimer === null && canTime) nextTip();
  }
  function stopTips() {
    if (tipTimer !== null) win.clearTimeout(tipTimer);
    tipTimer = null;
  }

  const loading = {
    el: root,
    visible: root.classList.contains('is-on'),

    /** fraction 0..1 of the whole load; label names the stage in progress. */
    set(fraction, label) {
      const clamped = Math.min(1, Math.max(0, Number(fraction) || 0));
      // Stages report independently and may overlap; the line never runs backwards within one load.
      shown = Math.max(shown, clamped);
      const percent = Math.round(shown * 100);
      writeFill(shown.toFixed(3));
      writePercent(`${percent}%`);
      root.setAttribute('aria-valuenow', String(percent));
      if (label !== undefined && label !== null) writeLabel(String(label));
      if (loading.visible) startTips();
    },

    show() {
      if (loading.visible) return;
      loading.visible = true;
      shown = 0;
      root.classList.add('is-on');
    },

    hide() {
      if (!loading.visible) return;
      loading.visible = false;
      root.classList.remove('is-on');
      stopTips();
    },
  };
  if (loading.visible) startTips();
  return loading;
}

// ---------------------------------------------------------------- errors

const GENERAL_STEPS = [
  'Reload the page.',
  'If it happens again, close other tabs that use 3D graphics and try once more.',
];

// Known failures, matched against the error text, with advice a player can act on.
const KNOWN_ERRORS = [
  {
    pattern: /webgl\s*2|webgl2|rendering context|float (?:render )?targets?|color_buffer_float|hardware acceleration/i,
    title: 'This browser cannot start the 3D renderer',
    summary: "VICE '86 draws with WebGL 2, which this browser or device is not providing.",
    steps: [
      'Update the browser to a current version of Chrome, Edge, Firefox or Safari.',
      "Turn on hardware acceleration (graphics acceleration) in the browser's settings and restart it.",
      'Update the graphics driver.',
      'If the game is embedded in another page, open it in a tab of its own.',
    ],
  },
  {
    pattern: /context\s*(?:was\s*)?lost|contextlost/i,
    title: 'The graphics driver reset',
    summary: 'The browser lost its connection to the graphics card. This can follow a driver update, sleep, or running out of video memory.',
    steps: ['Reload the page.', 'If it keeps happening, lower the graphics preset under Settings, Graphics.'],
  },
  {
    pattern: /wasm|webassembly/i,
    title: 'The physics engine could not start',
    summary: 'The game needs WebAssembly, which is switched off or blocked here.',
    steps: ['Update the browser, or allow WebAssembly if a security setting or extension blocks it.', 'Reload the page.'],
  },
  {
    pattern: /failed to fetch|dynamically imported module|importing a module script|failed to load|networkerror|load failed|\b404\b/i,
    title: 'Part of the game did not load',
    summary: 'A file the game needs could not be fetched.',
    steps: ['Check the connection and reload the page.', 'If the page was opened straight from disk, serve the folder from a local web server instead.'],
  },
];

/**
 * Turns whatever the game caught into a readable report: { title, summary, steps, technical }.
 * Accepts (title, detail), (title, Error), (Error) or (message).
 */
export function explainError(title, detail) {
  let heading = title, source = detail;
  if (title instanceof Error || (title && typeof title === 'object')) { source = title; heading = ''; }
  const message = source instanceof Error || (source && typeof source === 'object' && source.message)
    ? String(source.message) : source === undefined || source === null ? '' : String(source);
  const stack = source && typeof source === 'object' && typeof source.stack === 'string' ? source.stack : '';
  // The first line of a stack usually repeats the message; keep the frames only.
  const frames = stack.split('\n').filter((line) => line.trim() && !(message && line.includes(message))).slice(0, 6);

  const known = KNOWN_ERRORS.find((entry) => entry.pattern.test(`${heading || ''} ${message}`));
  if (known) {
    const technical = [heading, message, ...frames].filter((part) => part && String(part).trim()).join('\n');
    return { title: known.title, summary: known.summary, steps: known.steps, technical };
  }
  return {
    title: heading ? String(heading) : 'Something went wrong',
    summary: message || 'The game stopped because of an unexpected error.',
    steps: GENERAL_STEPS,
    technical: frames.join('\n'),
  };
}

/** Fatal error panel. Returns { el, show(title, detail), visible }. */
export function createErrorScreen({ doc, parent, win }) {
  const titleNode = el(doc, 'h1', 'error__title');
  const summary = el(doc, 'p', 'error__summary');
  const steps = el(doc, 'ol', 'error__steps');
  const technical = el(doc, 'pre', 'error__technical');
  const reload = el(doc, 'button', 'error__reload', 'Reload');
  reload.type = 'button';
  reload.addEventListener('click', () => { if (win && win.location && win.location.reload) win.location.reload(); });
  const root = el(doc, 'div', 'error', el(doc, 'div', 'error__card', el(doc, 'div', 'error__kicker', 'Stopped'), titleNode, summary, steps, reload, technical));
  attrs(root, { role: 'alertdialog', 'aria-modal': 'true' });
  parent.appendChild(root);

  const screen = {
    el: root,
    visible: false,
    show(title, detail) {
      const report = explainError(title, detail);
      titleNode.textContent = report.title;
      summary.textContent = report.summary;
      steps.replaceChildren(...report.steps.map((step) => el(doc, 'li', '', step)));
      technical.textContent = report.technical;
      technical.classList.toggle('is-on', report.technical.length > 0);
      screen.visible = true;
      root.classList.add('is-on');
      if (reload.focus) reload.focus();
    },
  };
  return screen;
}

// ---------------------------------------------------------------- toast

/** How long a toast stays up. */
export const TOAST_MS = 2000;

/** One line of transient text at the top of the screen; a new message replaces the current one. */
export function createToast({ doc, parent, win }) {
  const root = el(doc, 'div', 'toast');
  attrs(root, { role: 'status', 'aria-live': 'polite' });
  parent.appendChild(root);
  let timer = null;
  return {
    el: root,
    show(text) {
      root.textContent = String(text);
      root.classList.add('is-on');
      if (!(win && win.setTimeout)) return;
      if (timer !== null) win.clearTimeout(timer);
      timer = win.setTimeout(() => { timer = null; root.classList.remove('is-on'); }, TOAST_MS);
    },
  };
}
