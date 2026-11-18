// HUD view model: turns the raw values the game sends every frame into exactly what is displayed.
//
// Pure functions and plain data, no DOM. hud.js writes a field to the page only when it differs
// from what is already shown, so everything here is quantised to display resolution: a speed is an
// integer, the rev arc moves in pixel-sized steps, the clock changes once a minute.

export const MS_TO_MPH = 2.2369363;
export const MS_TO_KMH = 3.6;

/**
 * Dial geometry in the gauge's own drawing units: 10 per layout unit `u` (style.css), origin at
 * the dial centre. Angles are degrees clockwise from 3 o'clock. The rev arc is open for 96 degrees
 * at the bottom; its last 73 degrees are the red zone, so the red line always sits at the same
 * place on the arc whatever the engine.
 */
export const DIAL = Object.freeze({ radius: 110, start: 138, sweep: 264, redZone: 73, tickRadius: 96 });

/** Where the red line falls along the rev arc, 0..1. */
export const REDLINE_AT = (DIAL.sweep - DIAL.redZone) / DIAL.sweep;

/** Slim nitrous arc outside the rev arc on its left shoulder, filling upwards from the arc's open end. */
export const NITROUS_ARC = Object.freeze({ radius: 123, start: 138, sweep: 84 });

/** Number of positions the rev arc can take: about one per device pixel of arc on a 1440p screen. */
export const ARC_STEPS = 720;

/** Fraction of the red line from which the arc's fill turns to the accent colour. */
export const HOT_AT = 0.92;

/** Fraction of the red line at which the limiter flash starts. */
export const LIMITER_AT = 0.985;

/** Time constant with which the arc follows the engine, so a gear change reads as a drop, not a jump. */
export const REV_SMOOTHING_MS = 40;
/** A gap between updates longer than this (a pause, a hidden tab) is not smoothed across. */
export const REV_SNAP_MS = 250;

/** The speed digits change at most this often; faster and the last digit is an unreadable flicker. */
export const SPEED_REFRESH_MS = 100;

/** How long the gear digit stays in the accent colour after a change. */
export const SHIFT_FLASH_MS = 150;

/** How long the district banner holds after entering a district (its fade follows, in CSS). */
export const DISTRICT_HOLD_MS = 3500;

/**
 * The minimap canvas is larger than the disc it shows through by this factor and centred on the
 * player's marker, which sits this far down the disc: more of the map shows ahead than behind,
 * while the painter still draws a plain square centred on the car.
 */
export const MAP_OVERSCAN = 1.18;
export const MAP_PLAYER_Y = 0.58;

/** Whole-number speed for display from metres per second. Reversing shows a positive number. */
export function displaySpeed(metresPerSecond, units) {
  const value = Math.abs(metresPerSecond) * (units === 'kmh' ? MS_TO_KMH : MS_TO_MPH);
  return Number.isFinite(value) ? Math.min(999, Math.round(value)) : 0;
}

export const unitLabel = (units) => (units === 'kmh' ? 'KM/H' : 'MPH');

/** Gear indicator text: -1 reverse, 0 neutral, 1..6 forward (sixth appears only under nitrous). */
export function gearLabel(gear) {
  if (gear < 0) return 'R';
  if (gear === 0 || !Number.isFinite(gear)) return 'N';
  return String(Math.round(gear));
}

/** Rev arc position 0..ARC_STEPS for an engine speed. The red line is at REDLINE_AT of the arc. */
export function arcStep(rpm, redline) {
  if (!(redline > 0) || !(rpm > 0)) return 0;
  return Math.round(Math.min(1, (rpm / redline) * REDLINE_AT) * ARC_STEPS);
}

/**
 * Path data for the rev scale: one dot per 1,000 rpm from zero to the end of the arc, each a
 * zero-length stroke that the round line cap turns into a dot. Empty until the red line is known.
 */
export function tickPath(redline) {
  if (!(redline > 0)) return '';
  const fullScale = redline / REDLINE_AT;
  let d = '';
  for (let rpm = 0; rpm <= fullScale; rpm += 1000) {
    const a = ((DIAL.start + DIAL.sweep * (rpm / fullScale)) * Math.PI) / 180;
    d += `M${(DIAL.tickRadius * Math.cos(a)).toFixed(1)} ${(DIAL.tickRadius * Math.sin(a)).toFixed(1)}h0`;
  }
  return d;
}

/** Nitrous tank level in hundredths, so the bar is written at most a hundred times per tank. */
export const NITROUS_STEPS = 100;
export function nitrousStep(level) {
  if (!(level > 0)) return 0;
  return Math.round(Math.min(1, level) * NITROUS_STEPS);
}

/** Minute of the day 0..1439 from hours as a float (any real number; wraps). */
export function minuteOfDay(hours) {
  if (!Number.isFinite(hours)) return 0;
  const minutes = Math.floor((((hours % 24) + 24) % 24) * 60 + 1e-6);
  return Math.min(1439, minutes);
}

/**
 * Rotation in degrees (clockwise) of the north marker on a heading-up minimap.
 * Yaw 0 faces +Z (south) and grows towards +X (east), so the compass bearing is 180 - yaw and
 * north sits at the opposite angle. Quantised to half a degree.
 */
export function northRotation(yaw) {
  const degrees = (yaw * 180) / Math.PI - 180;
  const wrapped = ((degrees % 360) + 360) % 360;
  return Math.round(wrapped * 2) / 2 % 360;
}

/** Shortest signed turn in degrees from one rotation to another, in (-180, 180]. */
export function turnBetween(from, to) {
  const turn = (((to - from) % 360) + 540) % 360 - 180;
  return turn === -180 ? 180 : turn;
}

/** SVG path of a circular arc from `start` over `sweep` degrees, clockwise from 3 o'clock. */
export function arcPath(cx, cy, radius, start, sweep) {
  const point = (degrees) => {
    const a = (degrees * Math.PI) / 180;
    return `${(cx + radius * Math.cos(a)).toFixed(2)} ${(cy + radius * Math.sin(a)).toFixed(2)}`;
  };
  const large = sweep > 180 ? 1 : 0;
  return `M${point(start)}A${radius} ${radius} 0 ${large} 1 ${point(start + sweep)}`;
}

/** A view model with nothing on it yet. One instance lives as long as the HUD. */
export function createHudModel() {
  return {
    speed: 0,
    speedAt: -Infinity,  // when the speed digits last changed
    units: '',
    gear: '',
    shift: false,        // the gear changed a moment ago
    shiftUntil: 0,
    rpm: 0,              // smoothed engine speed behind the arc
    rpmAt: -Infinity,
    arc: 0,              // 0..ARC_STEPS
    redline: 0,
    hot: false,          // close to the red line
    limit: false,        // on the limiter
    minute: -1,          // minute of day, -1 before the first update
    headlamps: false,
    handbrake: false,
    nitrous: 0,          // 0..NITROUS_STEPS
    boosting: false,
    place: '',           // the district the car is in now ('' outside every district)
    district: '',        // text of the entry banner: the district last entered
    districtOn: false,
    districtUntil: 0,
    north: 0,            // degrees
  };
}

/**
 * Advances the view model from one frame's input.
 * input: the object given to ui.hud.update (missing fields keep their previous display).
 * units: settings.game.units.  now: milliseconds, any monotonic clock.
 */
export function updateHudModel(model, input, units, now) {
  const unit = units === 'kmh' ? 'kmh' : 'mph';
  if (unit !== model.units || now - model.speedAt >= SPEED_REFRESH_MS) {
    model.units = unit;
    model.speed = displaySpeed(input.speed, unit);
    model.speedAt = now;
  }

  const gear = gearLabel(input.gear);
  if (gear !== model.gear) {
    if (model.gear) model.shiftUntil = now + SHIFT_FLASH_MS;   // not for the first gear shown
    model.gear = gear;
  }
  model.shift = now < model.shiftUntil;

  const redline = input.redline > 0 ? input.redline : 0;
  const rpm = input.rpm > 0 ? input.rpm : 0;
  const elapsed = now - model.rpmAt;
  model.rpmAt = now;
  if (elapsed >= 0 && elapsed < REV_SNAP_MS) model.rpm += (rpm - model.rpm) * (1 - Math.exp(-elapsed / REV_SMOOTHING_MS));
  else model.rpm = rpm;
  model.redline = redline;
  model.arc = arcStep(model.rpm, redline);
  // The warnings follow the engine itself, not the smoothed arc: the flash must start on time.
  model.limit = redline > 0 && rpm >= redline * LIMITER_AT;
  model.hot = redline > 0 && rpm >= redline * HOT_AT;

  if (typeof input.clock === 'number') model.minute = minuteOfDay(input.clock);
  model.headlamps = Boolean(input.headlamps);
  model.handbrake = Boolean(input.handbrake);
  model.nitrous = nitrousStep(input.nitrous);
  model.boosting = Boolean(input.boosting);
  if (typeof input.heading === 'number') model.north = northRotation(input.heading);

  // The banner appears when the car enters a district (including the first one of a drive) and
  // leaves after a hold. Leaving every district (open water, bridges) announces nothing.
  const district = input.district || '';
  model.place = district;
  if (district && district !== model.district) {
    model.district = district;
    model.districtOn = true;
    model.districtUntil = now + DISTRICT_HOLD_MS;
  } else if (model.districtOn && now >= model.districtUntil) {
    model.districtOn = false;
  }
  return model;
}

/**
 * Minimum time between minimap repaints: 20 a second while moving (the canvas element is turned
 * between repaints, so the map still rotates every frame), 5 a second at rest.
 */
export const MAP_INTERVAL_MOVING_MS = 50;
export const MAP_INTERVAL_IDLE_MS = 200;

/**
 * Whether the minimap is due a repaint. `last` holds { time, x, z, heading } of the previous
 * paint and is updated when the answer is yes.
 */
export function minimapDue(last, now, position, heading) {
  const x = position ? position[0] : 0, z = position ? position[2] : 0;
  const moved = Math.abs(x - last.x) + Math.abs(z - last.z) > 0.05 || Math.abs(heading - last.heading) > 0.002;
  if (now - last.time < (moved ? MAP_INTERVAL_MOVING_MS : MAP_INTERVAL_IDLE_MS)) return false;
  last.time = now; last.x = x; last.z = z; last.heading = heading;
  return true;
}
