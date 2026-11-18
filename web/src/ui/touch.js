// On-screen driving controls for touch devices.
//
// Interface to the game (documented here because the game's input module consumes it):
//
//   actions.touchInput(state)   state = { steer, throttle, brake, handbrake, boost }
//       steer     -1..1, positive = left (the car's +X), analogue
//       throttle  0 or 1
//       brake     0 or 1   (the game turns held brake at rest into reverse, as with the keyboard)
//       handbrake 0 or 1
//       boost     0 or 1   (nitrous, held)
//     Called only when a value changes. The same object is passed every time and stays valid
//     between calls: values are held until the next call. All five return to 0 when the fingers
//     lift, when the HUD is hidden (pause, menus) and when the page loses visibility.
//
//   actions.press(name)         one-shot: 'camera'
//   actions.pause()             the pause button
//
// Layout: a wide steering strip under the left thumb, pedals under the right thumb (brake inside,
// throttle outside), handbrake above the brake, nitrous at the inner edge of the pedal group,
// pause and camera at the top edge. Each control
// tracks the pointer that pressed it, so any combination can be held at once.

import { el } from './dom.js';
import { icon } from './icons.js';

/** Share of the strip's half-width around the centre that gives no steering. */
export const STEER_DEAD_ZONE = 0.1;
/** Share of the half-width at which steering reaches full lock; the outer part is a full-lock margin. */
export const STEER_FULL_AT = 0.78;

/**
 * Steering value for a touch at clientX on a strip starting at `left` and `width` wide.
 * Positive is left. Linear between the dead zone and full lock; the game applies its own speed-
 * dependent smoothing, so no curve is added here.
 */
export function steerFromPad(clientX, left, width) {
  if (!(width > 0)) return 0;
  const offset = Math.min(1, Math.max(-1, ((clientX - left) / width) * 2 - 1));
  const magnitude = Math.min(1, Math.max(0, (Math.abs(offset) - STEER_DEAD_ZONE) / (STEER_FULL_AT - STEER_DEAD_ZONE)));
  // Quantised to 1/32 so a resting thumb's tremor does not produce a stream of new values.
  const stepped = Math.round(magnitude * 32) / 32;
  return offset < 0 ? stepped : -stepped || 0;
}

/**
 * True when touch is the main way of pointing at this device (phones, tablets). Laptops with a
 * touch screen report a fine primary pointer and get the controls only after an actual touch.
 */
export function isTouchPrimary(win) {
  if (!win) return false;
  try {
    if (typeof win.matchMedia === 'function') return win.matchMedia('(pointer: coarse)').matches;
  } catch {
    // matchMedia can throw on malformed implementations; fall through to the capability test.
  }
  const nav = win.navigator;
  return Boolean(nav && nav.maxTouchPoints > 0 && /Android|iPhone|iPad|Mobile/i.test(nav.userAgent || ''));
}

/**
 * options: { doc, parent, actions }
 * Returns { el, state, setActive(on), reset() }.
 * setActive shows or hides the layer; hiding releases everything.
 */
export function createTouchControls({ doc, parent, actions }) {
  const state = { steer: 0, throttle: 0, brake: 0, handbrake: 0, boost: 0 };

  const emit = () => { if (actions.touchInput) actions.touchInput(state); };
  const set = (key, value) => {
    if (state[key] === value) return;
    state[key] = value;
    emit();
  };

  // ---- steering strip
  const knob = el(doc, 'span', 'touch__knob');
  const steer = el(doc, 'div', 'touch__steer',
    icon(doc, 'chevronLeft', 'touch__arrow'), el(doc, 'span', 'touch__rail', knob), icon(doc, 'chevronRight', 'touch__arrow'));
  let steerPointer = null;
  let steerLeft = 0, steerWidth = 0;

  const steerTo = (clientX) => {
    const value = steerFromPad(clientX, steerLeft, steerWidth);
    if (value === state.steer) return;
    knob.style.setProperty('--steer', String(-value));   // the knob moves right for negative (right) steer
    set('steer', value);
  };
  const steerRelease = (event) => {
    if (event && event.pointerId !== steerPointer) return;
    steerPointer = null;
    steer.classList.remove('is-held');
    knob.style.setProperty('--steer', '0');
    set('steer', 0);
  };
  steer.addEventListener('pointerdown', (event) => {
    if (steerPointer !== null) return;
    steerPointer = event.pointerId;
    // One layout read per gesture: the strip does not move while a finger is on it.
    const box = steer.getBoundingClientRect();
    steerLeft = box.left; steerWidth = box.width;
    if (steer.setPointerCapture) steer.setPointerCapture(event.pointerId);
    steer.classList.add('is-held');
    steerTo(event.clientX);
    event.preventDefault();
  });
  steer.addEventListener('pointermove', (event) => { if (event.pointerId === steerPointer) steerTo(event.clientX); });
  steer.addEventListener('pointerup', steerRelease);
  steer.addEventListener('pointercancel', steerRelease);
  steer.addEventListener('lostpointercapture', steerRelease);

  // ---- held buttons
  const releases = [() => steerRelease(null)];
  function holdButton(className, iconName, label, key) {
    const button = el(doc, 'div', `touch__button ${className}`, iconName ? icon(doc, iconName) : null, el(doc, 'span', 'touch__label', label));
    let pointer = null;
    const release = (event) => {
      if (event && event.pointerId !== pointer) return;
      pointer = null;
      button.classList.remove('is-held');
      set(key, 0);
    };
    button.addEventListener('pointerdown', (event) => {
      if (pointer !== null) return;
      pointer = event.pointerId;
      if (button.setPointerCapture) button.setPointerCapture(event.pointerId);
      button.classList.add('is-held');
      set(key, 1);
      event.preventDefault();
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
    releases.push(() => release(null));
    return button;
  }

  function tapButton(className, iconName, label, onTap) {
    const button = el(doc, 'button', `touch__tap ${className}`, icon(doc, iconName));
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onTap);
    return button;
  }

  const root = el(doc, 'div', 'touch',
    el(doc, 'div', 'touch__taps',
      tapButton('touch__tap--camera', 'camera', 'Change camera', () => { if (actions.press) actions.press('camera'); }),
      tapButton('touch__tap--pause', 'pause', 'Pause', () => { if (actions.pause) actions.pause(); })),
    steer,
    el(doc, 'div', 'touch__pedals',
      holdButton('touch__button--boost', 'boost', 'Nitrous', 'boost'),
      holdButton('touch__button--handbrake', 'handbrake', 'Handbrake', 'handbrake'),
      holdButton('touch__button--brake', 'brake', 'Brake', 'brake'),
      holdButton('touch__button--throttle', 'throttle', 'Throttle', 'throttle')));
  // Stops the long-press menu and text selection that would otherwise interrupt a held pedal.
  root.addEventListener('contextmenu', (event) => event.preventDefault());
  parent.appendChild(root);

  const controls = {
    el: root,
    state,
    active: false,

    /** Releases every control and tells the game once if anything was held. */
    reset() {
      for (const release of releases) release();
    },

    setActive(on) {
      if (on === controls.active) return;
      controls.active = on;
      root.classList.toggle('is-on', on);
      if (!on) controls.reset();
    },
  };
  return controls;
}
