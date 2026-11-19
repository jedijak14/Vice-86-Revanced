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
    police: '',          // what the dispatch is doing about the player, one line
    policeHeat: 0,       // 0..3: how many pips are lit
    stars: 0,            // 0..5: the wanted level, one star per step of the ladder
    race: '',            // the race in hand: where in it you are
    mission: '',         // the job in hand: what to do next
    crew: '',            // who else is in this room
    purse: '',           // what is in the pocket: the cash, and what it came from
    foot: '',            // on foot: the gun in hand, the wind, what is nearest
    vitals: '',          // on foot: how much of him is left, when any of it is missing
    radio: '',           // the station on the dial and what it is playing
    health: 1,           // 0..1: the walker's wound state, as a bar rather than a number
    oxygen: 1,           // 0..1: the air left in him
    airOn: false,        // whether the air bar is news enough to show
    watch: '',           // inside a watched zone: the lens, or the eyes, that have you
    voice: '',           // the line somebody on the street is saying out loud
    jail: '',            // in custody: the bail, the wall, the guard
  };
}

/** A patrol siren is held in place while it means something, so no timer is kept here. */
function policeLine(pd) {
  if (!pd) return '';
  if (pd.heat) {
    const mode = pd.mode === 'search' ? 'searching' : pd.nearby ? 'pull over' : 'pursuit';
    const units = Math.max(1, pd.responding | 0);
    return `units ${units}${pd.officers ? ' · officers out' : ''} · ${mode}`;
  }
  // The end of an incident is worth reading: the dispatch says so for a few seconds.
  if (pd.mode === 'cleared') return 'traffic stop complete';
  if (pd.mode === 'escaped') return 'search called off';
  return '';
}

/** The race line: how far into it, and how the clock reads. */
function raceLine(race) {
  if (!race || !race.active) return '';
  if (race.countdown > 0) return `starting in ${Math.ceil(race.countdown)}`;
  // The money rides on the line: what is lying there during it, and what the result took after it.
  if (race.finished) {
    const took = race.payout ? ` · ${dollars(race.payout)}` : '';
    return `${race.place ? `P${race.place}` : 'finished'} · ${formatLap(race.lastMs)}${took}`;
  }
  const left = Math.max(0, (race.total | 0) - (race.passed | 0));
  const purse = race.purse ? ` · ${dollars(race.purse)}` : '';
  return `${race.name || 'Street race'} · ${left} to go · ${formatLap(race.elapsedMs)}${purse}`;
}

/** The job line: what the next objective asks for, in the mission's own words. */
function missionLine(mission) {
  if (!mission) return '';
  if (mission.offered && mission.offered.length) return `Jobs · ${mission.offered.length} to take at the kerb`;
  if (!mission.active || !mission.objective) return '';
  return mission.objective;
}

/**
 * The pocket: what is in it, and — only when something changed — where it came from. A number that moves
 * on its own is the thing a player wants to see after a job, so the delta rides along for a few seconds.
 */
/** Bills with thousands commas, the way the money is counted out; `value` is in dollars. */
const dollars = (value) => `$${Math.round(Math.abs(value)).toLocaleString('en-US')}`;

function purseLine(purse) {
  if (!purse) return '';
  const money = dollars(purse.cash);
  // The purse is always worth reading — it is the score of the street's other economy — and a change in it
  // is worth saying out loud for a while, because a number that moved without a reason looks like a bug.
  if (!purse.lastDelta) return purse.cash > 0 ? money : `${money} \u00b7 nothing to spend`;
  const ago = purse.lastAt === null || purse.lastAt === undefined ? 0 : purse.lastAt;
  const sign = purse.lastDelta > 0 ? '+' : '\u2212';
  return `${money} \u00b7 ${sign}${dollars(purse.lastDelta)}${ago > 0 && ago < 6 ? ` \u00b7 ${Math.round(6 - ago)}s` : ''}`;
}

/** The walker's own line: what is in the hand, and how much of him is left. */
function footLine(foot) {
  if (!foot || !foot.onFoot) return '';
  const gun = foot.gun ? `${foot.gun} ${foot.magazine}/${foot.reserve}` : 'no gun \u00b7 B to draw';
  const wind = foot.out ? ' \u00b7 winded' : foot.stamina < 0.34 ? ' \u00b7 low wind' : '';
  // A car within reach says which car it is: his own is a door he left open, and one that is not his is
  // a car he is about to take off the street, which the street will hold against him.
  const near = foot.boarding ? (foot.taken ? ' \u00b7 F to take it' : ' \u00b7 F to get in') : (foot.near ? ' \u00b7 F to get out' : '');
  const door = foot.door ? ` \u00b7 ${foot.door}` : '';
  return `${gun}${wind}${near}${door}`;
}

/**
 * How much of the walker is left. A full, dry, breathing man needs no line: the row stays dark and
 * the cluster says nothing. The moment any of it is missing - a wound, a dive, the sea over his head
 * - the numbers come up, because a number that only appears when it matters is a warning, not clutter.
 */
function vitalsLine(foot) {
  if (!foot || !foot.onFoot) return '';
  if (foot.dead) return 'down \u00b7 the water or the street got him';
  const parts = [];
  const health = foot.health === undefined ? 1 : foot.health;
  const oxygen = foot.oxygen === undefined ? 1 : foot.oxygen;
  if (health < 0.995) parts.push(`\u2665 ${Math.round(health * 100)}%`);
  if (foot.swimming || foot.submerged || oxygen < 0.995) parts.push(`O\u2082 ${Math.round(oxygen * 100)}%`);
  if (foot.swimming) parts.push(foot.submerged ? 'under' : 'swimming');
  return parts.join(' \u00b7 ');
}

/** The radio: which station, and the thing it is playing right now. Empty when the dial is off. */
function radioLine(radio) {
  if (!radio || !radio.station) return '';
  return radio.title ? `${radio.station} \u00b7 ${radio.title}` : radio.station;
}

/** Inside a watched zone, who has you: the bracket on the corner, or the pavement itself. */
function watchLine(w) {
  if (!w) return '';
  if (w.camera) return w.people ? `on camera \u00b7 and ${w.people} more pair${w.people === 1 ? '' : 's'} of eyes` : 'on camera \u00b7 the tape is evidence';
  return `${w.people} pair${w.people === 1 ? '' : 's'} of eyes on it`;
}

/** In custody: what the honest door costs, and how far the other one has got. */
function jailLine(j) {
  if (!j || !j.jailed) return '';
  const pct = Math.round(j.escape * 100);
  return `bail $${j.bail} \u00b7 E pays it \u00b7 hold Space for the wall${pct > 0 ? ` \u00b7 bars ${pct}%` : ''}${j.guardNear ? ' \u00b7 guard close' : ''}`;
}

/** The street talking: who said it, and the words, while the recording lasts. */
function voiceLine(v) {
  if (!v || !v.text) return '';
  return v.who ? `${v.who}: \u201c${v.text}\u201d` : `\u201c${v.text}\u201d`;
}

/**
 * The instruments, for whichever machine is not a car. An aeroplane gets the six things a pilot reads
 * in a glance - speed, height, whether he is going up or down, where he is pointing, the lever, and the
 * two configuration items that kill people when they are forgotten - and a motorcycle gets the three a
 * rider has: how fast, which gear, and how far over it is.
 */
function flightLine(f) {
  if (!f) return '';
  if (f.kind === 'plane') {
    const parts = [
      `${f.ias} kt`, `${f.alt} ft`, `${f.vsi >= 0 ? '+' : '\u2212'}${Math.abs(f.vsi)} fpm`,
      `${String(f.heading).padStart(3, '0')}\u00b0`,
      `THR ${f.throttle}%`, Math.abs(f.bank) < 1 ? 'WINGS LEVEL' : `BANK ${f.bank > 0 ? 'L' : 'R'}${Math.abs(f.bank)}\u00b0`,
      f.gear ? 'GEAR DN' : 'GEAR UP', f.flaps ? `FLAP ${f.flaps}` : null,
      f.runway ? `RWY ${f.runway}` : null,
    ];
    const warn = f.crashed ? 'WRITTEN OFF' : f.stalled ? 'STALL' : f.overspeed ? 'OVERSPEED' : f.gearUnsafe ? 'TOO FAST FOR THE GEAR' : null;
    return warn ? `${parts.filter(Boolean).join(' \u00b7 ')} \u00b7 ${warn}` : parts.filter(Boolean).join(' \u00b7 ');
  }
  if (f.kind === 'bike') {
    const parts = [`${f.speed} km/h`, `${f.gear} of ${f.gears}`, `${f.rpm} rpm`, `over ${f.lean > 0 ? 'left' : 'right'} ${Math.abs(f.lean)}\u00b0`];
    if (f.sliding) parts.push('THE TYRES ARE GONE');
    if (f.fallen) parts.push('ON ITS SIDE \u00b7 R to pick it up');
    else if (f.footDown) parts.push('a foot down');
    return parts.join(' \u00b7 ');
  }
  return '';
}

function crewLine(net) {
  if (!net || !net.room) return '';
  if (!net.peers) return `Room ${net.room} · waiting`;
  return `Room ${net.room} · ${net.peers + 1} driving`;
}

/** mm:ss.t, the shape a lap time takes on a board. */
export function formatLap(ms) {
  if (!(ms > 0)) return '--:--';
  const t = Math.max(0, ms / 1000), m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
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

  // Paloma PD: one line under the clock. The dispatch object is updated in place, so it is read
  // here and nowhere else in the UI.
  model.police = policeLine(input.police);
  model.policeHeat = input.police ? Math.max(0, Math.min(3, input.police.heat | 0)) : 0;
  // The wanted level is the record, not the incident: the stars stay up after the last car has
  // given up, which is the whole reason to draw them somewhere of their own.
  model.stars = input.wanted ? Math.max(0, Math.min(5, input.wanted.stars | 0)) : 0;
  model.race = raceLine(input.race);
  model.mission = missionLine(input.mission);
  model.crew = crewLine(input.net);
  model.purse = purseLine(input.purse);
  model.foot = footLine(input.foot);
  model.vitals = vitalsLine(input.foot);
  model.radio = radioLine(input.radio);
  const walker = input.foot || null;
  model.health = walker && walker.health !== undefined ? walker.health : 1;
  model.oxygen = walker && walker.oxygen !== undefined ? walker.oxygen : 1;
  model.airOn = !!walker && (walker.oxygen !== undefined && walker.oxygen < 0.995 || !!walker.swimming || !!walker.submerged);
  model.watch = watchLine(input.watch);
  model.jail = jailLine(input.jail);
  model.voice = voiceLine(input.voice);
  model.flight = flightLine(input.flight);

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
