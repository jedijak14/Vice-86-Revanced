// Menu navigation logic without a DOM: what a key or a gamepad state means, and where focus goes.
//
// Every menu is a vertical list of rows. Up and down move between rows, left and right adjust the
// focused row, accept activates it, back leaves the screen, and the tab intents switch tabs on
// screens that have them. Keyboard, gamepad, mouse and touch all reduce to these intents.

export const INTENT = Object.freeze({
  UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right',
  ACCEPT: 'accept', BACK: 'back', TAB_PREV: 'tabPrev', TAB_NEXT: 'tabNext',
  MENU: 'menu',   // the gamepad's Start button: resumes from the pause menu
});

// Keyed by KeyboardEvent.code so WASD works on every layout; `key` covers keys without a stable code.
const CODE_INTENT = {
  ArrowUp: INTENT.UP, KeyW: INTENT.UP,
  ArrowDown: INTENT.DOWN, KeyS: INTENT.DOWN,
  ArrowLeft: INTENT.LEFT, KeyA: INTENT.LEFT,
  ArrowRight: INTENT.RIGHT, KeyD: INTENT.RIGHT,
  Enter: INTENT.ACCEPT, NumpadEnter: INTENT.ACCEPT, Space: INTENT.ACCEPT,
  Escape: INTENT.BACK, Backspace: INTENT.BACK,
  KeyQ: INTENT.TAB_PREV, PageUp: INTENT.TAB_PREV, BracketLeft: INTENT.TAB_PREV,
  KeyE: INTENT.TAB_NEXT, PageDown: INTENT.TAB_NEXT, BracketRight: INTENT.TAB_NEXT,
};
const KEY_INTENT = {
  ArrowUp: INTENT.UP, ArrowDown: INTENT.DOWN, ArrowLeft: INTENT.LEFT, ArrowRight: INTENT.RIGHT,
  Enter: INTENT.ACCEPT, ' ': INTENT.ACCEPT, Escape: INTENT.BACK, Esc: INTENT.BACK, Backspace: INTENT.BACK,
  PageUp: INTENT.TAB_PREV, PageDown: INTENT.TAB_NEXT,
};

/**
 * Intent of a keydown event, or null. Tab moves like down (Shift+Tab like up) so focus cannot
 * leave the menu for the browser chrome. Combinations with Ctrl, Alt or Meta are left to the browser.
 */
export function keyIntent(event) {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key === 'Tab' || event.code === 'Tab') return event.shiftKey ? INTENT.UP : INTENT.DOWN;
  return CODE_INTENT[event.code] || KEY_INTENT[event.key] || null;
}

/**
 * Index of the next focusable row from `from` in direction `delta` (+1 or -1), wrapping round.
 * `focusable` is an array of booleans. Returns `from` when nothing else can take focus, and the
 * first focusable row in that direction when `from` is -1 (nothing focused yet).
 */
export function nextFocusable(focusable, from, delta) {
  const count = focusable.length;
  if (count === 0) return -1;
  let index = from;
  for (let tries = 0; tries < count; tries++) {
    index = from < 0 && tries === 0 ? (delta > 0 ? 0 : count - 1) : (index + delta + count) % count;
    if (focusable[index]) return index;
  }
  return focusable[from] ? from : -1;
}

/** First focusable row, or -1. */
export const firstFocusable = (focusable) => focusable.indexOf(true);

// ---------------------------------------------------------------- gamepad

// Standard mapping (W3C Gamepad): face buttons 0 A, 1 B, 2 X, 3 Y; 4 LB, 5 RB; 9 Start; 12..15 d-pad.
const PAD_BUTTONS = [
  [0, INTENT.ACCEPT], [1, INTENT.BACK], [4, INTENT.TAB_PREV], [5, INTENT.TAB_NEXT], [9, INTENT.MENU],
];
const PAD_DIRECTIONS = [
  { intent: INTENT.UP, button: 12, axis: 1, sign: -1 },
  { intent: INTENT.DOWN, button: 13, axis: 1, sign: 1 },
  { intent: INTENT.LEFT, button: 14, axis: 0, sign: -1 },
  { intent: INTENT.RIGHT, button: 15, axis: 0, sign: 1 },
];

const pressed = (pad, index) => {
  const button = pad.buttons[index];
  return Boolean(button && (button.pressed || button.value > 0.5));
};

/**
 * Turns successive gamepad snapshots into menu intents.
 *
 * Directions (d-pad or left stick past the threshold) fire once on press and then repeat while
 * held: after `initialDelay` ms, every `repeatInterval` ms. The other buttons fire once per press.
 * A button that is already down when reading begins (the Start press that opened the pause menu,
 * the A press that chose Drive) does nothing until it has been released: call reset() whenever a
 * menu opens.
 */
export function createGamepadReader({ initialDelay = 380, repeatInterval = 110, threshold = 0.55 } = {}) {
  const buttonDown = PAD_BUTTONS.map(() => false);
  const directionDown = PAD_DIRECTIONS.map(() => false);
  const nextRepeat = PAD_DIRECTIONS.map(() => 0);
  let waitForRelease = true;

  return {
    /** Ignore everything held right now until it is let go. */
    reset() { waitForRelease = true; },

    /**
     * pad: a Gamepad (or { buttons, axes }) or null. now: ms. Appends intents to `out` and returns it.
     */
    read(pad, now, out = []) {
      if (!pad || !pad.buttons) { waitForRelease = true; return out; }
      const axes = pad.axes || [];

      if (waitForRelease) {
        let anything = false;
        for (const [index] of PAD_BUTTONS) anything = anything || pressed(pad, index);
        for (const d of PAD_DIRECTIONS) anything = anything || pressed(pad, d.button) || (axes[d.axis] || 0) * d.sign > threshold;
        if (anything) return out;
        waitForRelease = false;
        buttonDown.fill(false);
        directionDown.fill(false);
      }

      for (let i = 0; i < PAD_BUTTONS.length; i++) {
        const down = pressed(pad, PAD_BUTTONS[i][0]);
        if (down && !buttonDown[i]) out.push(PAD_BUTTONS[i][1]);
        buttonDown[i] = down;
      }
      for (let i = 0; i < PAD_DIRECTIONS.length; i++) {
        const d = PAD_DIRECTIONS[i];
        const down = pressed(pad, d.button) || (axes[d.axis] || 0) * d.sign > threshold;
        if (down && !directionDown[i]) {
          out.push(d.intent);
          nextRepeat[i] = now + initialDelay;
        } else if (down && now >= nextRepeat[i]) {
          out.push(d.intent);
          nextRepeat[i] = now + repeatInterval;
        }
        directionDown[i] = down;
      }
      return out;
    },
  };
}

/** The first connected gamepad with the standard mapping (or any connected one failing that), or null. */
export function pickGamepad(pads) {
  if (!pads) return null;
  let fallback = null;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad || pad.connected === false) continue;
    if (pad.mapping === 'standard') return pad;
    fallback = fallback || pad;
  }
  return fallback;
}
