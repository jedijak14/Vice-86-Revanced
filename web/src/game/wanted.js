// Wanted level: the stars the player is carrying, and what put them there.
//
// Paloma PD's dispatch (game/police.js) judges single incidents: it sees something, it sends units,
// the incident ends. The wanted level is the other half — the *record* a driver accumulates across
// incidents, which is what a player reads as consequence. It is kept here, separate from the
// dispatch, for two reasons: a star is worth something even when no car is behind you, and the
// things that earn one are wider than what a patrol car can see (a pedestrian scared off the pavement
// is not a crime a unit witnesses, but it is a crime).
//
// Nothing in this module draws, moves or toasts. `WantedLedger` is arithmetic on numbers the game has
// already computed, so it runs in a test without a renderer, a world or a clock.

import { clamp } from '../core/math.js';

/** The ladder is five deep, the way a 1986 Florida sheet would write it. */
export const MAX_STARS = 5;

/**
 * What one offence is worth, in points. Points, not stars: five hard charges should be able to make
 * a full star on their own, and a single bit of speeding should not.
 */
export const OFFENCES = Object.freeze({
  speeding: 1,
  'red light': 3,
  collision: 2,
  'patrol car struck': 4,
  'officer threatened': 4,
  // On foot the street has a man in it rather than a car, and what a man does with a gun or a shop's till
  // is judged by the same ledger: heard, witnessed, and written down.
  'shots fired': 3,
  'person shot': 5,
  'shop held up': 4,
  // A car taken off the street. Two charges, because the two acts are not the same: one has somebody
  // thrown out of the driver's seat onto the road, and one has an empty car standing at the kerb.
  'car jacked': 4,
  'car stolen': 2,
  'patrol car taken': 6,
  'peds scattered': 1,
  'wrong way': 2,
  'kerb riding': 1,
  'no lights at night': 1,
  'hit and run': 5,
  // The wall is a charge of its own: a man who was in custody and is now on the street.
  'jail break': 8,
});

/** Points that carry the level one star higher. The steps widen: the fifth star is hard to reach. */
export const STAR_STEPS = Object.freeze([3, 7, 13, 22, 34]);

/** Seconds of quiet before one star is forgiven, and how much longer each further star takes. */
const FORGIVE_SECONDS = 55, FORGIVE_PER_STAR = 24;
/** While a unit is after him nothing is forgiven; this is how long after the last contact. */
const ACTIVE_SECONDS = 12;

export const STAR_LABELS = Object.freeze([
  'Innocent', 'Under notice', 'Wanted', 'Wanted', 'Heavily wanted', 'Paloma PD wants you badly',
]);

/** The star count a number of points is worth. */
export function starsForPoints(points) {
  let stars = 0;
  for (const step of STAR_STEPS) if (points >= step) stars++;
  return stars;
}

/**
 * Whether the player ran a red light, from what the street already knows.
 *
 * @param {object|null} lane   the lane the player is over, as `graph.nearest` returns it (with its
 *                             `junction` and `control` records, see game/lanes.js)
 * @param {number} t           the signal clock the lamps are drawn from, seconds
 * @param {Function} greenFor  (junction, control, t) => boolean, the same answer `writeSignalLamps` uses
 * @param {number} [speed]     the player's speed, m/s: a stationary car is waiting, not running
 */
export function redLightEntered(lane, t, greenFor, speed = 0) {
  if (!lane || !(speed > 2)) return false;
  if (lane.junction === undefined || lane.junction < 0) return false;
  const control = lane.control;
  // Only a signal can be run: a stop sign, a yield or an unmarked junction has no light to beat.
  if (!control || control.kind !== 'signal' || typeof greenFor !== 'function') return false;
  return !greenFor(lane.junction, control, t);
}

/**
 * How much a star should be forgiven for, in one step of `dt` seconds.
 * Nothing is forgiven while an officer is close enough to have seen it.
 */
export function forgiveness({ dt, contact, heat, sinceOffence, stars },) {
  if (contact || heat > 0) return 0;
  if (sinceOffence < ACTIVE_SECONDS) return 0;
  const hold = FORGIVE_SECONDS + (stars - 1) * FORGIVE_PER_STAR;
  return dt / hold;
}

export class WantedLedger {
  constructor() {
    /** 0..MAX_STARS. */
    this.stars = 0;
    /** Points behind the stars, so that a level does not flicker on one charge. */
    this.points = 0;
    /** What was last charged, for the HUD and for a toast worth writing. */
    this.lastCause = '';
    this.lastAt = -Infinity;
    /** Seconds since anything was charged, whether or not it was worth a point. */
    this.quiet = 0;
    /** Times the level went up, and down: a record, not a score. */
    this.raised = this.lowered = 0;
    this.perCause = new Map();
  }

  /**
   * Charge one offence.
   * @param {string} cause  a key of OFFENCES
   * @param {number} [amount] override the table (a second offence of the same kind counts for less)
   * @returns {boolean} whether the star count went up
   */
  add(cause, amount = OFFENCES[cause] ?? 1) {
    if (!(amount > 0)) return false;
    const before = this.points;
    // The same charge twice in a minute is one event, not two: a driver who scrapes a parked car
    // in a crash of four impacts is not four times as guilty.
    const repeat = this.perCause.get(cause);
    const seen = repeat && this.quiet - repeat.at < 30;
    this.points += seen ? amount * 0.3 : amount;
    this.perCause.set(cause, { at: this.quiet, n: (repeat ? repeat.n : 0) + 1 });
    this.lastCause = cause;
    this.lastAt = this.quiet;
    this.stars = starsForPoints(this.points);
    this.raised += this.stars > starsForPoints(before) ? 1 : 0;
    return this.stars > starsForPoints(before);
  }

  /** One frame. `status` is the dispatch's, read for contact and heat; nothing is asked of it. */
  step(dt, status = null) {
    if (!(dt > 0)) return;
    this.quiet += dt;
    const since = this.quiet - this.lastAt;
    const drop = forgiveness({ dt, stars: this.stars, sinceOffence: since, contact: !!status?.nearby, heat: status?.heat | 0 });
    if (drop > 0) {
      this.points = Math.max(0, this.points - drop);
      const stars = starsForPoints(this.points);
      if (stars < this.stars) { this.stars = stars; this.lowered++; }
    }
  }

  /** A stop, a bail, or the end of a story: the slate, not the memory. The counters are kept — what
   * happened to you today is still a fact even after the charge was withdrawn. */
  clear() {
    this.points = 0; this.stars = 0; this.perCause.clear(); this.quiet = 0; this.lastAt = 0;
  }

  get active() { return this.stars > 0; }

  /** What a HUD line and a script both read. */
  snapshot() {
    return {
      stars: this.stars, points: Math.round(this.points * 10) / 10,
      // What the HUD reads: the cause only while there is a level to explain, and the last one for
      // reference once the record is clean (an empty string would read as a bug in a toast).
      cause: this.stars ? this.lastCause : (this.lastAt > -Infinity ? '' : ''),
      since: Math.round(this.quiet - this.lastAt),
      raised: this.raised, lowered: this.lowered,
    };
  }

  /** A label for the stars, for a toast or a jobs screen. */
  static label(stars) { return STAR_LABELS[clamp(stars | 0, 0, MAX_STARS)]; }
}
