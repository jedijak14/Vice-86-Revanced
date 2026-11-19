// Vitals: the one body the game actually owns — health, and the breath that runs out underwater.
//
// Everything else on the street is a car or a pedestrian with a single hit-point of drama: the crowd
// flinches, runs, falls over and gets up, because that is what a crowd is for. The player is the one body
// that has to *last*, so he gets two tanks and the rules that drain them:
//
//   health   falls that land hard, bullets when the street ever shoots back, and drowning once the breath
//            is gone. It comes back slowly and only while nothing is happening to him, because a man who
//            regenerates through a firefight is a man the firefight cannot matter to.
//   oxygen   a held breath. Under the surface it empties on a clock a swimmer would recognise — three
//            quarters of a minute, not the two minutes of a movie — and at the surface it comes back in a
//            few gasps. When it is gone the water starts taking health instead, which is what drowning is.
//
// Nothing here draws or decides: the HUD reads `snapshot()`, the game decides what a death means (a respawn
// at the hospital, a bill, a toast), and foot.js reports being underwater rather than owning a lung.

import { clamp } from '../core/math.js';

/** Seconds of breath in a full tank. A fit swimmer manages 45-75 s of easy underwater work; this is easy work. */
export const OXYGEN_SECONDS = 45;
/** Seconds to gasp a full tank back at the surface: three or four breaths, not a meditation. */
export const REFILL_SECONDS = 3.5;
/** Fraction of health the water takes per second once the breath is gone. Drowning is quick, not a duel. */
export const DROWN_RATE = 1 / 12;
/** Fraction of health per second came back while out of trouble: a full tank from empty in two minutes. */
export const RECOVER_RATE = 1 / 120;
/** m/s of landing speed the body shrugs off entirely, and the rate it pays above that. */
export const FALL_SOFT = 7.5, FALL_RATE = 1 / 9;
/** Health below which the HUD should be saying something. */
export const HURT_AT = 0.35;

/**
 * @param {{
 *   onDeath?: (cause: string) => void,     fired once per life, with what did it: 'drown', 'fall', 'shot'
 *   onHurt?: (cause: string, amount: number) => void,   fired for every wound that landed, death included
 * }} deps
 */
export function createVitals(deps = {}) {
  const onDeath = deps.onDeath || null;
  const onHurt = deps.onHurt || null;

  const vitals = {
    health: 1,
    oxygen: 1,
    /** True from the frame health reaches 0 until `revive`; the game stops reading input, not the water. */
    dead: false,
    /** The thing that killed him, while dead: what the respawn screen has to say. */
    cause: null,
    /** True while the last wound is still recent enough to hold recovery off (see `wound`). */
    trouble: 0,

    /**
     * A wound. `cause` is the word the death screen and the ledger will use; amounts are fractions of the
     * tank, so a fall from the first floor is 0.2 and not some number of joules nobody can picture.
     */
    damage(amount, cause = 'hurt') {
      if (vitals.dead || amount <= 0) return false;
      vitals.health = clamp(vitals.health - amount, 0, 1);
      vitals.trouble = 6;                       // six seconds of "something is happening to me"
      if (onHurt) onHurt(cause, amount);
      if (vitals.health <= 0) {
        vitals.dead = true;
        vitals.cause = cause;
        if (onDeath) onDeath(cause);
      }
      return true;
    },

    /** A landing, as foot.js measures it: m/s downwards at the frame the feet arrived. */
    fall(impact) {
      const over = impact - FALL_SOFT;
      if (over <= 0) return false;
      return vitals.damage(over * FALL_RATE * 0.5, 'fall');
    },

    /** Medicine, a shop's bandages, a night's sleep: whatever the game decides counts. */
    heal(amount) {
      if (vitals.dead) return false;
      vitals.health = clamp(vitals.health + amount, 0, 1);
      return true;
    },

    /**
     * One breath of time. `submerged` is the head under the surface, not the feet off the seabed: a man
     * wading chest-deep is a man with his face in the air and a full tank.
     * @param {number} dt seconds
     * @param {boolean} submerged the head under water this frame
     */
    breath(dt, submerged) {
      if (submerged) {
        vitals.oxygen = clamp(vitals.oxygen - dt / OXYGEN_SECONDS, 0, 1);
        if (vitals.oxygen <= 0) vitals.damage(DROWN_RATE * dt, 'drown');
      } else {
        vitals.oxygen = clamp(vitals.oxygen + dt / REFILL_SECONDS, 0, 1);
      }
      return vitals.oxygen;
    },

    /**
     * The slow clock: health coming back while the street leaves him alone. Called every frame on foot or
     * in a car; `inTrouble` is the game's say — wanted stars, a recent wound, a race he is being shot at in.
     */
    tick(dt, inTrouble = false) {
      const held = vitals.trouble > 0;          // the wound was fresh at the top of the frame
      vitals.trouble = Math.max(0, vitals.trouble - dt);
      if (vitals.dead || inTrouble || held) return vitals.health;
      if (vitals.health < 1) vitals.health = clamp(vitals.health + RECOVER_RATE * dt, 0, 1);
      return vitals.health;
    },

    /** Back on his feet with half a tank: what a hospital visit or a respawn hands him. */
    revive(at = 0.5) {
      vitals.dead = false;
      vitals.cause = null;
      vitals.health = clamp(at, 0, 1);
      vitals.oxygen = 1;
      vitals.trouble = 0;
      return vitals;
    },

    snapshot() {
      return {
        health: vitals.health, oxygen: vitals.oxygen, dead: vitals.dead, cause: vitals.cause,
        hurt: !vitals.dead && vitals.health < HURT_AT, drowning: vitals.oxygen <= 0 && !vitals.dead,
      };
    },
  };
  return vitals;
}
