// Player input: keyboard, gamepad, touch (through the UI overlay) and injected actions for
// automation, merged into one action state.
//
// Held actions (analogue 0..1 unless noted):  throttle, brake, steer (-1..1, positive = left,
// the same sign as yaw), handbrake, boost (nitrous), lookBack, horn.
// One-shot actions (reported once per press):  camera, headlamps, recover, time, weather,
// pause.
//
// View input, while `looking`: a drag with the mouse or a finger, the wheel or a pinch, and the right
// stick, merged into `look`: this frame's turn of the view, in units that do not depend on the device
// or the size of the window. Two conventions share this pipe, and `lookMode` picks one: 'orbit' grabs
// the car and spins it (the garage turntable, where the object follows the hand), 'neck' turns a head
// (on foot, where the view goes the way the finger does). Feeding a man on the pavement the turntable's
// signs is what makes walking feel inverted: the eyes go left, the feet follow them, and the world
// turns against the hand.
//
// Nothing in here touches the DOM directly: the page passes an event target and a gamepad
// getter, tests call the same handlers by hand.

import { clamp, smoothstep, lerp } from '../core/math.js';

export const HELD_ACTIONS = ['throttle', 'brake', 'steer', 'handbrake', 'boost', 'lookBack', 'horn'];
export const PRESS_ACTIONS = ['camera', 'headlamps', 'recover', 'time', 'weather', 'race', 'pause', 'foot', 'weapon', 'shop', 'radio'];

/** Keyboard layout by physical key (`KeyboardEvent.code`), so it is the same on every layout. */
export const KEY_BINDINGS = Object.freeze({
  KeyW: 'throttle', ArrowUp: 'throttle',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'handbrake',
  ShiftLeft: 'boost',
  KeyQ: 'lookBack',
  KeyG: 'horn',
  KeyC: 'camera',
  KeyH: 'headlamps',
  KeyR: 'recover',
  KeyT: 'time',
  KeyY: 'weather',
  KeyV: 'race',               // take the street race on offer here (game/races.js)
  KeyF: 'foot',               // step out of the car, or get back in (game/foot.js)
  KeyB: 'weapon',             // draw the pistol, or stow it (game/weapons.js)
  KeyM: 'radio',              // the dial: next station on the car radio (audio/radio.js)
  KeyE: 'shop',               // the door: into a shopfront, or back out of the room (game/shops.js)

  Escape: 'pause', KeyP: 'pause',
});

/** Standard-mapping gamepad buttons. Triggers and the stick are read as analogue values below. */
export const PAD_BUTTONS = Object.freeze({
  0: 'handbrake', // A
  1: 'lookBack', // B
  2: 'boost', // X
  3: 'camera', // Y
  4: 'boost', // left bumper
  8: 'recover', // Back / Select
  9: 'pause', // Start
  10: 'horn', // left stick click
  12: 'time', // d-pad up
  13: 'weather', // d-pad down
  14: 'headlamps', // d-pad left
  5: 'foot', // right bumper: out of the car, back into it
  15: 'shop', // right stick in: a door, in and out (game/shops.js)

});
const PAD_THROTTLE = 7; // right trigger
const PAD_BRAKE = 6; // left trigger
const PAD_STEER_AXIS = 0; // left stick, horizontal

const PAD_LOOK_X = 2, PAD_LOOK_Y = 3; // right stick

// Turning the view. A drag across the whole height of the picture turns it by LOOK_DRAG.
const LOOK_DRAG = 2.6; // rad
const LOOK_STICK_YAW = 1.6; // rad/s at full stick
const LOOK_STICK_PITCH = 0.3; // rad/s at full stick
const LOOK_WHEEL = 0.0012; // zoom ratio per pixel of wheel travel
const LOOK_WHEEL_LIMIT = 0.25; // per frame, however fast the wheel was spun

const STICK_DEAD_ZONE = 0.12;
const TRIGGER_DEAD_ZONE = 0.05;
// Response curves. The stick exponent gives fine control around the centre, where a thumb is
// least precise; the throttle is close to linear so that the engine load can be feathered; the
// brake starts gently because full brake pressure is rarely wanted.
const STICK_CURVE = 1.7;
const THROTTLE_CURVE = 1.25;
const BRAKE_CURVE = 1.6;

// Keyboard steering. A key is all or nothing, and the vehicle model already turns it into a
// rate-limited steering position with a speed-dependent lock (a held key always asks for the
// cornering limit, never more). What is left to do here is placement at speed: the faster the
// car, the more slowly lock builds up, so that a short tap is a small correction and a held
// key still reaches the full limit. Unwinding is always quick.
const KEY_STEER_SLOW_SPEED = 12; // m/s: below this the key passes through unshaped
const KEY_STEER_FAST_SPEED = 55; // m/s (about 200 km/h): from here on the build-up is slowest
const KEY_STEER_RATE_SLOW = 9; // 1/s: faster than the vehicle's own limit, so that one governs
const KEY_STEER_RATE_FAST = 1.4; // 1/s: a 0.1 s tap at 200 km/h is a seventh of the limit
const KEY_STEER_RETURN_RATE = 30; // 1/s back to centre or across it: the vehicle's own return rate governs

/** Stick or trigger value with a dead zone removed and the rest rescaled to 0..1, then curved. */
export function shapeAxis(value, deadZone, exponent) {
  const a = Math.abs(value);
  if (a <= deadZone) return 0;
  const t = Math.min((a - deadZone) / (1 - deadZone), 1);
  return Math.sign(value) * Math.pow(t, exponent);
}

/**
 * Advances the keyboard steering position.
 * @param {number} current  position from the last frame, -1..1
 * @param {number} direction  -1, 0 or 1 from the keys (positive = left)
 * @param {number} speed  road speed, m/s (absolute)
 * @param {number} dt  seconds
 * @param {number} sensitivity  player setting, 1 = default; scales the build-up rate at speed
 * @returns {number} new position
 */
export function steerFromKeys(current, direction, speed, dt, sensitivity = 1) {
  const fast = smoothstep(KEY_STEER_SLOW_SPEED, KEY_STEER_FAST_SPEED, speed);
  const unwinding = direction === 0 || current * direction < 0;
  const rate = unwinding ? KEY_STEER_RETURN_RATE : lerp(KEY_STEER_RATE_SLOW, KEY_STEER_RATE_FAST * sensitivity, fast);
  const step = rate * dt;
  if (current < direction) return Math.min(current + step, direction);
  return Math.max(current - step, direction);
}

/**
 * @param {object} [opts]
 * @param {{addEventListener: Function, removeEventListener: Function}} [opts.keyTarget]  usually `window`
 * @param {() => ArrayLike<Gamepad|null>} [opts.getGamepads]  usually `() => navigator.getGamepads()`
 */
export function createInput(opts = {}) {
  const keyTarget = opts.keyTarget || null;
  const getGamepads = opts.getGamepads || null;

  /** The merged result, refreshed by update(). */
  const state = { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0, lookBack: 0, horn: 0 };
  const keys = { throttle: false, brake: false, left: false, right: false, handbrake: false, boost: false, lookBack: false, horn: false };
  const touch = { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0 };
  /** Injected held actions (automation and the autopilot). null = nothing injected. */
  let injected = null;
  const pressed = new Set();
  const padHeld = new Set();
  const pad = { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0, lookBack: 0, horn: 0, lookX: 0, lookY: 0, connected: false };
  /** Pointers held down on the picture, by id: where each was last seen. Two make a pinch. */
  const pointers = new Map();
  /** View input gathered from events since the last update. */
  const turned = { yaw: 0, pitch: 0, zoom: 0 };
  let keySteer = 0;
  let activePad = null;

  const api = {
    state,
    /** Driving input is ignored while false (menus); one-shot presses still arrive. */
    driving: false,
    /** Steering sensitivity from the settings, 1 = default. */
    sensitivity: 1,
    /** Which device steered last: 'keyboard', 'gamepad', 'touch' or 'script'. */
    lastDevice: 'keyboard',
    /** View input is gathered while true (the garage, the pavement, a shop); otherwise `look` stays at rest. */
    looking: false,
    /**
     * Whose view the pointers and the right stick are driving: 'orbit' (the default: the garage
     * turntable, where dragging brings the *object* round) or 'neck' (on foot: dragging turns the
     * head the way the hand goes, up raises the eye). `game.js` sets it when the player steps out.
     */
    lookMode: 'orbit',
    /**
     * This frame's turn of the view, refreshed by update(): yaw and pitch in radians (a positive
     * yaw turns the view towards +X, which is right for a walker facing +Z; a positive pitch raises
     * the eye), zoom a signed ratio (+0.1 = a tenth closer), held while a pointer is down on the picture.
     * Which *hand movement* produces a positive yaw is `lookMode`'s business, not the consumer's.
     */
    look: { yaw: 0, pitch: 0, zoom: 0, held: false },

    /**
     * A pointer on the picture: mouse button, pen or finger.
     * @param {'down'|'move'|'up'} type  'up' also for a cancelled pointer
     * @param {number} id      the pointer's id
     * @param {number} x       position in CSS pixels
     * @param {number} y
     * @param {number} height  height of the picture in the same pixels
     */
    handlePointer(type, id, x, y, height) {
      if (type === 'up') { pointers.delete(id); return; }
      const last = pointers.get(id);
      if (type === 'down' || !last) {
        if (type === 'down') pointers.set(id, { x, y });
        return;
      }
      const scale = LOOK_DRAG / Math.max(1, height);
      if (pointers.size === 1) {
        const dx = (x - last.x) * scale, dy = (y - last.y) * scale;
        if (api.lookMode === 'neck') {
          // A head, not a turntable: dragging right looks right and dragging up raises the eye. This is
          // the whole difference between a man walking where he is looking and a man walking circles.
          turned.yaw += dx;
          turned.pitch -= dy;
        } else {
          // The picture follows the hand: dragging right brings the car's left side round,
          // which is the eye going the other way; dragging down looks from higher up.
          turned.yaw -= dx;
          turned.pitch += dy;
        }
      } else {
        // A pinch: the change of the distance to the other finger.
        for (const [otherId, other] of pointers) {
          if (otherId === id) continue;
          const before = Math.hypot(last.x - other.x, last.y - other.y), after = Math.hypot(x - other.x, y - other.y);
          if (before > 1) turned.zoom += after / before - 1;
          break;
        }
      }
      last.x = x; last.y = y;
    },

    /** The mouse wheel over the picture: `deltaY` in pixels, negative away from the player (closer). */
    handleWheel(deltaY) {
      turned.zoom -= deltaY * LOOK_WHEEL;
    },

    /**
     * Key transition. Returns true if the key is bound (the page then prevents the default
     * action, so that arrows and space do not scroll).
     */
    handleKey(code, down, repeat = false) {
      const action = KEY_BINDINGS[code];
      if (!action) return false;
      if (action in keys) {
        keys[action] = down;
        if (down) api.lastDevice = 'keyboard';
      } else if (down && !repeat) {
        pressed.add(action);
      }
      return true;
    },

    /** Releases every key and pointer: the window lost focus and will not deliver their release. */
    releaseKeys() {
      for (const k in keys) keys[k] = false;
      pointers.clear();
    },

    /** Held touch controls from the UI overlay; fields that are left out keep their value. */
    setTouch(values) {
      for (const k in touch) if (values[k] !== undefined) touch[k] = +values[k] || 0;
      api.lastDevice = 'touch';
    },

    /** A one-shot action from the UI overlay or from script. */
    press(action) {
      if (PRESS_ACTIONS.includes(action)) pressed.add(action);
    },

    /** Held actions from script, kept until changed; null removes them. */
    inject(actions) {
      injected = actions ? { ...actions } : null;
      if (injected) api.lastDevice = 'script';
    },

    /** True once for each press of a one-shot action. */
    consume(action) {
      return pressed.delete(action);
    },

    /**
     * Merges all sources into `state`. Call once per frame.
     * @param {number} dt     frame time, seconds
     * @param {number} speed  road speed of the player's car, m/s
     */
    update(dt, speed) {
      pollGamepad();
      const look = api.look;
      if (api.looking) {
        // The stick's yaw follows the drag: a turntable is spun against the hand, a neck turns with it.
        // The pitch is the same either way, because raising the stick raises the eye in both frames --
        // an orbit's camera goes up, a head looks up.
        const spin = api.lookMode === 'neck' ? 1 : -1;
        look.yaw = turned.yaw + spin * pad.lookX * LOOK_STICK_YAW * dt;
        look.pitch = turned.pitch - pad.lookY * LOOK_STICK_PITCH * dt;
        look.zoom = clamp(turned.zoom, -LOOK_WHEEL_LIMIT, LOOK_WHEEL_LIMIT);
        look.held = pointers.size > 0 || pad.lookX !== 0 || pad.lookY !== 0;
      } else {
        look.yaw = 0; look.pitch = 0; look.zoom = 0; look.held = false;
      }
      turned.yaw = 0; turned.pitch = 0; turned.zoom = 0;
      const direction = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
      keySteer = steerFromKeys(keySteer, direction, Math.abs(speed), dt, api.sensitivity);
      if (!api.driving) {
        state.throttle = 0; state.brake = 0; state.steer = 0; state.handbrake = 0; state.boost = 0; state.lookBack = 0; state.horn = 0;
        keySteer = 0;
        return state;
      }
      let throttle = Math.max(keys.throttle ? 1 : 0, pad.throttle, touch.throttle);
      let brake = Math.max(keys.brake ? 1 : 0, pad.brake, touch.brake);
      let steer = keySteer + pad.steer + touch.steer;
      let handbrake = Math.max(keys.handbrake ? 1 : 0, pad.handbrake, touch.handbrake);
      let boost = Math.max(keys.boost ? 1 : 0, pad.boost, touch.boost);
      let lookBack = Math.max(keys.lookBack ? 1 : 0, pad.lookBack);
      let horn = Math.max(keys.horn ? 1 : 0, pad.horn);
      if (injected) {
        // A person at the controls always wins over a script on the same axis.
        if (injected.throttle !== undefined && throttle === 0) throttle = injected.throttle;
        if (injected.brake !== undefined && brake === 0) brake = injected.brake;
        if (injected.steer !== undefined && steer === 0) steer = injected.steer;
        if (injected.handbrake !== undefined && handbrake === 0) handbrake = injected.handbrake;
        if (injected.boost !== undefined && boost === 0) boost = injected.boost;
        if (injected.lookBack !== undefined && lookBack === 0) lookBack = injected.lookBack;
        if (injected.horn !== undefined && horn === 0) horn = injected.horn;
      }
      state.throttle = clamp(+throttle || 0, 0, 1);
      state.brake = clamp(+brake || 0, 0, 1);
      state.steer = clamp(+steer || 0, -1, 1);
      state.handbrake = clamp(+handbrake || 0, 0, 1);
      state.boost = clamp(+boost || 0, 0, 1);
      state.lookBack = lookBack > 0.5 ? 1 : 0;
      state.horn = horn > 0.5 ? 1 : 0;
      return state;
    },

    /**
     * Rumble on the active gamepad, if it has an actuator.
     * @param {number} strength 0..1
     * @param {number} duration seconds
     */
    rumble(strength, duration) {
      const actuator = activePad && activePad.vibrationActuator;
      if (!actuator || typeof actuator.playEffect !== 'function') return;
      const s = clamp(strength, 0, 1);
      // Rejections (unsupported effect, pad unplugged meanwhile) are of no interest.
      Promise.resolve(actuator.playEffect('dual-rumble', {
        duration: duration * 1000, strongMagnitude: s, weakMagnitude: s * 0.6,
      })).catch(() => {});
    },

    dispose() {
      if (!keyTarget) return;
      keyTarget.removeEventListener('keydown', onKeyDown);
      keyTarget.removeEventListener('keyup', onKeyUp);
      keyTarget.removeEventListener('blur', onBlur);
    },
  };

  function pollGamepad() {
    activePad = null;
    pad.connected = false;
    if (getGamepads) {
      const pads = getGamepads();
      for (let i = 0; pads && i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected !== false && p.buttons && p.buttons.length > PAD_THROTTLE) { activePad = p; break; }
      }
    }
    if (!activePad) {
      pad.throttle = 0; pad.brake = 0; pad.steer = 0; pad.handbrake = 0; pad.boost = 0; pad.lookBack = 0; pad.horn = 0;
      pad.lookX = 0; pad.lookY = 0;
      padHeld.clear();
      return;
    }
    pad.connected = true;
    const buttons = activePad.buttons;
    pad.throttle = shapeAxis(buttons[PAD_THROTTLE].value, TRIGGER_DEAD_ZONE, THROTTLE_CURVE);
    pad.brake = shapeAxis(buttons[PAD_BRAKE].value, TRIGGER_DEAD_ZONE, BRAKE_CURVE);
    // Stick right is positive on the pad; steering left is positive in the game.
    pad.steer = -shapeAxis(activePad.axes[PAD_STEER_AXIS] || 0, STICK_DEAD_ZONE, STICK_CURVE);
    // Right stick: right is positive, down is positive. Which way the *view* answers is `lookMode`'s
    // business (see update()): a neck turns right and looks up; a turntable swings the car the other way.
    pad.lookX = shapeAxis(activePad.axes[PAD_LOOK_X] || 0, STICK_DEAD_ZONE, STICK_CURVE);
    pad.lookY = shapeAxis(activePad.axes[PAD_LOOK_Y] || 0, STICK_DEAD_ZONE, STICK_CURVE);
    pad.handbrake = 0; pad.boost = 0; pad.lookBack = 0; pad.horn = 0;
    for (const index in PAD_BUTTONS) {
      const button = buttons[index];
      if (!button) continue;
      const action = PAD_BUTTONS[index];
      const down = button.pressed || button.value > 0.5;
      if (action in pad) {
        if (down) pad[action] = 1;
      } else if (down && !padHeld.has(index)) {
        pressed.add(action);
      }
      if (down) padHeld.add(index); else padHeld.delete(index);
    }
    if (pad.throttle > 0 || pad.brake > 0 || pad.steer !== 0) api.lastDevice = 'gamepad';
  }

  function onKeyDown(e) {
    // Leave typing in form fields and browser shortcuts alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (api.handleKey(e.code, true, e.repeat) && typeof e.preventDefault === 'function') e.preventDefault();
  }
  function onKeyUp(e) {
    api.handleKey(e.code, false);
  }
  function onBlur() {
    api.releaseKeys();
  }

  if (keyTarget) {
    keyTarget.addEventListener('keydown', onKeyDown);
    keyTarget.addEventListener('keyup', onKeyUp);
    keyTarget.addEventListener('blur', onBlur);
  }
  return api;
}
