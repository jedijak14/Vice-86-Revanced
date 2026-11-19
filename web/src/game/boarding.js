// Boarding: the second and a half between a man at a door and a man in a car.
//
// Taking a car used to be instant — one frame he is on the pavement, the next the chase camera is behind
// the wheel — and the street showed it: no door, no motion, no driver. This module owns the transition so
// that the two ways into a car look like what they are:
//
//   an empty car    he reaches for the handle and gets in. One second, two sounds.
//   an occupied one he opens the door, and the man in the seat comes out of it — up out of the chair, one
//                   horrible moment of understanding, then away at a run — while he gets in over him.
//                   Nearly two seconds, which is what a carjack is: longer than a theft, shorter than a
//                   conversation.
//
// The sequence is a clock, not an animation graph: phases with durations, events at the seams, and the
// driver's own body borrowed from the crowd's shelf for as long as the ejection needs it and handed back
// the moment it does not. game.js decides what the events mean (which car, which camera, which charge on
// the record); this file only knows what a man does at a door.

import { TAU } from '../core/math.js';

/** Seconds per phase. `reach` is the hand on the handle; `pull` is the driver coming out; `enter` the door. */
export const PHASES = Object.freeze({
  empty: Object.freeze({ reach: 0.45, enter: 0.55 }),
  occupied: Object.freeze({ reach: 0.45, pull: 0.9, enter: 0.55 }),
});
/** Total seconds of each sequence, for a HUD that wants to hold a prompt through it. */
export const BOARD_SECONDS = Object.freeze({
  empty: PHASES.empty.reach + PHASES.empty.enter,
  occupied: PHASES.occupied.reach + PHASES.occupied.pull + PHASES.occupied.enter,
});
/**
 * Where the seams fall, in seconds from the hand on the handle: `hide` is the body committing to the
 * seat (the sit begins, the door stands open), `seated` is the body gone inside the car, which is the
 * only moment hiding it costs nothing. The arc between them is what "smooth" means here.
 */
export const SEAMS = Object.freeze({
  empty: Object.freeze({ reach: 0, pull: -1, hide: PHASES.empty.reach, seated: PHASES.empty.reach + PHASES.empty.enter * 0.72, done: BOARD_SECONDS.empty }),
  occupied: Object.freeze({ reach: 0, pull: PHASES.occupied.reach, hide: PHASES.occupied.reach + PHASES.occupied.pull, seated: PHASES.occupied.reach + PHASES.occupied.pull + PHASES.occupied.enter * 0.72, done: BOARD_SECONDS.occupied }),
});
/** m/s the ejected driver runs away at, and how long he is ours before the crowd takes him back. */
const DRIVER_RUN = 4.2, DRIVER_SECONDS = 3.2;

/**
 * @param {{crowd?: object}} deps  the street's people: `takePerson`/`handPersonBack` lend the driver a body
 */
export function createBoarding(deps = {}) {
  const crowd = deps.crowd || null;
  let t = 0;
  let plan = null;                 // the PHASES row of the sequence in flight
  let occupied = false;
  let phase = null;
  let driver = null;               // the borrowed body in the seat, while he is being ejected
  let driverT = 0;
  const driverPos = [0, 0, 0];
  const door = [0, 0, 0];
  let awayYaw = 0;

  const board = {
    get active() { return plan !== null; },
    get phase() { return phase; },
    get occupied() { return occupied; },
    /** Seconds into the sequence: for a prompt that counts the door out. */
    get t() { return t; },

    /**
     * Starts a sequence.
     * @param {boolean} wasOccupied  somebody was sitting in it
     * @param {{x: number, y: number, z: number}} at   the door he is standing at, world metres
     * @param {number} away  yaw the ejected driver should run off at
     */
    begin(wasOccupied, at, away = 0) {
      if (plan) return false;
      occupied = !!wasOccupied;
      plan = occupied ? PHASES.occupied : PHASES.empty;
      t = 0;
      phase = null;
      door[0] = at.x; door[1] = at.y; door[2] = at.z;
      awayYaw = away;
      return true;
    },

    /** Gives the sequence up: the car drove off, the player was shot, a cut took him elsewhere. */
    cancel() {
      plan = null;
      phase = null;
      handDriverBack();
      return board;
    },

    /**
     * One step of the clock.
     * @param {number} dt seconds
     * @returns {string[]} the events whose seam this step crossed, in order: `reach` as the hand goes to
     *   the handle, `pull` as the driver is told to come out, `hide` as the player's body leaves the
     *   pavement for the seat, `done` when the sequence is over and the car is his to take.
     */
    step(dt) {
      const events = [];
      // The ejected driver keeps running after the door closes on him: his clock is his own, and it
      // runs whether or not a sequence is still in flight.
      stepDriver(dt);
      if (!plan) return events;
      if (phase === null) { phase = 'reach'; events.push('reach'); }   // the hand goes to the handle now
      const was = t;
      t += dt;
      const at = (name, start) => {
        if (was < start && t >= start) { phase = name; events.push(name); }
      };
      if (occupied) at('pull', plan.reach);
      at('hide', plan.reach + (occupied ? plan.pull : 0));
      at('seated', (occupied ? SEAMS.occupied : SEAMS.empty).seated);
      if (was < total() && t >= total()) events.push('done');
      if (events.includes('done') || t >= total()) { plan = null; phase = null; }
      return events;
    },

    /** The driver's body, while the ejection owns it: the HUD and the crowd both leave it alone. */
    get driver() { return driver; },
  };

  function total() {
    return occupied ? BOARD_SECONDS.occupied : BOARD_SECONDS.empty;
  }

  /**
   * The man in the seat. He is borrowed at the `pull` seam and handed back once he has run his ten
   * metres: a crowd person is a walker with a route, and a walker who has fled a carjack is exactly a
   * pedestrian again, which is the whole trick — the ejection costs no new kind of body.
   */
  function stepDriver(dt) {
    if (phase === 'pull' && !driver && occupied && crowd && crowd.takePerson) {
      driver = crowd.takePerson({ id: 'jack' });
      driverT = 0;
      if (driver) {
        driverPos[0] = door[0]; driverPos[1] = door[1]; driverPos[2] = door[2];
        driver.place(door[0], door[1], door[2], awayYaw);
        driver.visible(true);
        driver.role('standup', { once: true });
      }
    }
    if (!driver) return;
    driverT += dt;
    if (driverT > 0.55 && driverT <= 0.95) driver.role('startle', { once: true });
    if (driverT > 0.95) {
      driver.role('run');
      const step = DRIVER_RUN * dt;
      driverPos[0] += Math.sin(awayYaw) * step;
      driverPos[2] += Math.cos(awayYaw) * step;
      driver.place(driverPos[0], driverPos[1], driverPos[2], awayYaw);
      driver.frame(dt, step);
    } else {
      driver.frame(dt, 0);
    }
    if (driverT >= DRIVER_SECONDS) handDriverBack();
  }

  function handDriverBack() {
    if (!driver) return;
    if (crowd && crowd.handPersonBack) crowd.handPersonBack({ person: driver });
    else if (driver.remove) driver.remove();
    driver = null;
  }

  return board;
}

/**
 * Where a body ends up when the door sequence has carried it in: the seat the machine actually has.
 *
 * Every car in this city is left-hand drive and every one of them is furnished that way — the steering
 * wheel, the column and the lit dials are built at the model's own driver's eye, which is at +X in the
 * body's frame. +X is the car's *left* on this map, because +Z is south and a yaw of zero faces south:
 * the same axis an aeroplane banks about and a motorcycle leans about, so a seat on one side of a car is a
 * seat on the same side of everything else. A model that says where its driver's eye is gets its body put
 * exactly there; a car off the street has no model to ask and gets the same side at the same distance.
 * @param {string} tag    'own' | 'traffic' | 'boat' | 'plane' | 'bike'
 * @param {number} cx @param {number} cz  the machine's origin, world metres
 * @param {number} cyaw   its heading, radians
 * @param {number[]|null} [eye]  the model's own `driverEye` anchor, [x, y, z] in the body's frame
 * @returns {number[]} [x, z] where the body stands while it sits
 */
export function seatFor(tag, cx, cz, cyaw, eye = null) {
  // Both are [x, z] pairs, not [x, y, z]: a heading on the ground has no height in it, and reading the
  // third element of a two-element vector gives `undefined` and then NaN, silently, all the way into the
  // body's position and from there into the place the game remembers as dry land.
  const left = [Math.cos(cyaw), -Math.sin(cyaw)];
  const fwd = [Math.sin(cyaw), Math.cos(cyaw)];
  if (tag === 'boat') return [cx - fwd[0] * 0.6, cz - fwd[1] * 0.6];
  // The left seat of a cockpit, two rows back from the panel: the pilot's, and the same side as the door
  // he climbed in through and will climb out of.
  if (tag === 'plane') return [cx + left[0] * 0.42 + fwd[0] * 1.4, cz + left[1] * 0.42 + fwd[1] * 1.4];
  // A saddle is on the centreline, a little behind the origin the physics puts between the contact patches.
  if (tag === 'bike') return [cx - fwd[0] * 0.1, cz - fwd[1] * 0.1];
  const across = eye ? eye[0] : 0.42, along = eye ? eye[2] : 0.08;
  return [cx + left[0] * across + fwd[0] * along, cz + left[1] * across + fwd[1] * along];
}

/**
 * The yaw straight out of the door side of a car: across the door, not along it. `side` is which side of
 * the car the man is standing on, +1 being its left — the same sign `foot.near.side` reports, measured
 * along the body's lateral axis rather than along its nose, because a door is on a side and not on an end.
 */
export function awayFromCar(carX, carZ, yaw, side) {
  let a = yaw + (side >= 0 ? Math.PI / 2 : -Math.PI / 2);
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}
