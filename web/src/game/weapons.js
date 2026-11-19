// Firearms: what a shot is, in a world that has never had one.
//
// The street is built around a car: physics for a car, damage for a car, police that judge a car. A gun
// therefore cannot be a vehicle system wearing a hat — it is three things of its own, and this file owns all
// three, so that a test can hold them without a renderer:
//
//   the ballistics   a ray, fired from the muzzle rather than the eye, with a cone of dispersion that grows
//                    with the rate of fire and is emptied by standing still;
//   the weapon       a magazine, a spare count, a reload that cannot be interrupted into a shot, and a
//                    hammer that will not fall on an empty chamber;
//   the noise        a discharged firearm is a *witness event*: the crowd flinches, the police are told, and
//                    the record grows. This module reports it and never decides it — `onShot` and `onHit`
//                    belong to the game, which is where the wanted ledger and the dispatch live.
//
// Nothing here draws. A tracer, a muzzle flash and a corpse on the pavement are the effects and crowd
// modules' business; `game/game.js` hands this module their callbacks.

import { clamp } from '../core/math.js';

/** The guns the street can find. `rate` is shots per second, `spread` radians of half-angle per shot. */
export const WEAPONS = Object.freeze({
  // `hands` is how the body holds it, and therefore which of the vendored stance clips it wears:
  // one hand on the .38, two on the long guns (see world/people/cast.js ROLES).
  pistol: { name: 'Short .38', hands: 1, magazine: 6, reserve: 24, rate: 2.6, spread: 0.006, move: 0.02, reach: 160, stun: 0.55 },
  shotgun: { name: '12-gauge', hands: 2, magazine: 6, reserve: 18, rate: 0.9, spread: 0.03, move: 0.055, reach: 55, pellets: 8, stun: 0.9 },
  smg: { name: '9 mm machine pistol', hands: 2, magazine: 32, reserve: 64, rate: 11, spread: 0.014, move: 0.075, reach: 120, stun: 0.45 },
});
/** Seconds to work a magazine: the game refuses a shot for this long, and plays the sound for it. */
export const RELOAD_SECONDS = Object.freeze({ pistol: 1.4, shotgun: 2.6, smg: 2.0 });
/** How far a hit is worth in the crowd's own language: 0..1 of `threat`, and the ledger's `peds scattered`. */
export const HIT_STARS = 0.35;
/** Metres: a person hit inside this of the player is witnessed by everybody nearby; beyond it, by nobody. */
export const WITNESS_RADIUS = 45;
/** The pattern's memory: how much one shot opens it, and how fast standing still closes it. */
export const HEAT_PER_SHOT = 0.34, HEAT_DECAY = 0.55;
/** A standing body, as a bullet sees it: 0.34 m of shoulder and 1.75 m of man. */
export const BODY_RADIUS = 0.34, BODY_HEIGHT = 1.75;

/**
 * A unit direction inside the weapon's cone. `rng` is injected so that a test can be exact and the game can
 * be not: the same numbers either way.
 * @param {{yaw: number, pitch: number}} look        where the eye points (see foot.js)
 * @param {object} weapon                            a WEAPONS entry
 * @param {number} heat                              0..1 of the weapon's own agitation (see `fire`)
 * @param {number} move                              0..1 of how fast the shooter is moving
 * @param {(n: number) => number} rng                 unit random
 * @param {number[]} out
 */
export function spreadDir(look, weapon, heat, move, rng, out = [0, 0, 0]) {
  const a = rng(1) * Math.PI * 2;
  const half = weapon.spread + weapon.move * (heat * 0.7 + move * 0.9);
  const r = Math.sqrt(rng(2)) * half;                     // a real muzzle pattern is denser in the middle
  const c = Math.cos(look.pitch), s = Math.sin(look.pitch);
  // Tangent frame of the view direction, which rises with the pitch because a positive pitch raises the
  // eye (see game/foot.js `aim`, and the shoulder camera that agrees with it): forward = (sin yaw·c, s,
  // cos yaw·c), right = (cos yaw, 0, -sin yaw), up = (-sin yaw·s, c, -cos yaw·s).
  const fx = Math.sin(look.yaw) * c, fy = s, fz = Math.cos(look.yaw) * c;
  const rx = Math.cos(look.yaw), ry = 0, rz = -Math.sin(look.yaw);
  const ux = -Math.sin(look.yaw) * s, uy = c, uz = -Math.cos(look.yaw) * s;
  const dx = fx + (rx * Math.cos(a) + ux * Math.sin(a)) * r;
  const dy = fy + (ry * Math.cos(a) + uy * Math.sin(a)) * r;
  const dz = fz + (rz * Math.cos(a) + uz * Math.sin(a)) * r;
  const len = Math.max(1e-6, Math.hypot(dx, dy, dz));
  out[0] = dx / len; out[1] = dy / len; out[2] = dz / len;
  return out;
}

/**
 * The weapon in the player's hand.
 * @param {{
 *   id?: string,
 *   physics?: {raycast: Function},                 the world: what a bullet can hit
 *   crowd?: {people: object[]},                    the people it can hit (see game/crowd.js)
 *   onShot?: (info: object) => void,               fired for every trigger pull that went off
 *   onHit?: (info: object) => void,                fired for every person or car struck
 *   rng?: (n: number) => number,
 * }} deps
 */
export function createWeapon(deps = {}) {
  const physics = deps.physics || null;
  const crowd = deps.crowd || null;
  const rng = typeof deps.rng === 'function' ? deps.rng : Math.random;
  const dir = [0, 0, 0], origin = [0, 0, 0];
  /**
   * What is in the bag for each gun, whether it is in the hand or not. Drawing a pistol that is already
   * carried cannot hand you a fresh magazine — that would make a holster a shop — so the counts live here
   * and the hand is only ever a view of them.
   */
  const carry = new Map();
  const stash = () => { if (gun.id) carry.set(gun.id, { magazine: gun.inMagazine, reserve: gun.reserve }); };

  const gun = {
    id: null,
    weapon: null,
    inMagazine: 0,
    reserve: 0,
    /** Seconds until the trigger works again, and until the reload ends. */
    cooldown: 0,
    reloading: 0,
    /** The pattern's memory: 0 = cold, 1 = the cone is as wide as this gun ever gets. */
    heat: 0,
    shots: 0,
    hits: 0,

    /** Puts one of the catalogue's guns in the hand, loaded. */
    equip(id) {
      const spec = WEAPONS[id];
      if (!spec) return null;
      const kept = carry.get(id);
      gun.id = id; gun.weapon = spec;
      gun.inMagazine = kept ? kept.magazine : spec.magazine;
      gun.reserve = kept ? kept.reserve : spec.reserve;
      if (!kept) carry.set(id, { magazine: spec.magazine, reserve: spec.reserve });
      gun.cooldown = 0; gun.reloading = 0; gun.heat = 0;
      return spec;
    },
    /**
     * Takes it away again (entering a car, going inside, being searched). The brass goes back in the bag
     * with it: a gun you put down is the gun you pick up, not a fresh one.
     */
    stow() {
      stash();
      gun.id = null; gun.weapon = null; gun.inMagazine = 0; gun.reserve = 0; gun.reloading = 0;
    },
    /** What is in the bag for a gun you are not holding, for a shop that wants to sell you more of it. */
    carried(id) { return carry.get(id) || null; },
    /** The shop's way of handing over brass: it goes in the bag, held or not. */
    issue(rounds, id = gun.id) {
      const kept = carry.get(id) || { magazine: 0, reserve: 0 };
      kept.reserve += rounds | 0;
      carry.set(id, kept);
      if (id === gun.id) gun.reserve = kept.reserve;
      return kept.reserve;
    },
    get armed() { return !!gun.weapon; },
    get empty() { return gun.armed && gun.inMagazine === 0; },
    get ready() { return gun.armed && gun.inMagazine > 0 && gun.cooldown <= 0 && gun.reloading <= 0; },
    get state() {
      if (!gun.armed) return 'none';
      if (gun.reloading > 0) return 'reloading';
      if (gun.inMagazine === 0) return gun.reserve > 0 ? 'reload' : 'empty';
      if (gun.cooldown > 0) return 'cycling';
      return 'ready';
    },

    /**
     * The gun's own clocks: the slide, the reload and the cooling of the pattern. Called by `fire` as well,
     * so a shooter who holds the trigger needs no second call; the frame loop calls it too, because a gun
     * that is being carried and not fired still finishes its reload.
     */
    advance(dt) {
      gun.cooldown = Math.max(0, gun.cooldown - dt);
      gun.heat = clamp(gun.heat - HEAT_DECAY * dt, 0, 1);
      if (gun.reloading > 0) {
        gun.reloading = Math.max(0, gun.reloading - dt);
        if (gun.reloading === 0 && gun.weapon) {
          const want = gun.weapon.magazine - gun.inMagazine, take = Math.min(want, gun.reserve);
          gun.inMagazine += take; gun.reserve -= take;
          if (gun.inMagazine > 0) gun.needReload = false;
          stash();
        }
      }
    },
    tick(dt) { gun.advance(dt); },

    startReload() {
      const spec = gun.weapon;
      if (!spec || gun.reloading > 0 || gun.inMagazine >= spec.magazine || gun.reserve <= 0) return false;
      gun.reloading = RELOAD_SECONDS[gun.id] || 1.6;
      return true;
    },

    /**
     * Pulls the trigger.
     * @param {{x:number,y:number,z:number,yaw:number,pitch:number}} from  the muzzle, and the eye it points
     * @param {number} dt                                                     seconds since the last call
     * @param {number} [move]                                                 0..1 of the shooter's speed
     * @returns {null|{pellets: object[]}}  null when the gun did not answer; one entry per struck thing
     */
    fire(from, dt = 1 / 60, move = 0) {
      const spec = gun.weapon;
      if (!spec) return null;
      gun.advance(dt);
      if (gun.reloading > 0 || gun.cooldown > 0) return null;
      if (gun.inMagazine <= 0) { gun.needReload = true; return null; }
      gun.inMagazine--;
      gun.cooldown = 1 / spec.rate;
      stash();
      // The pattern opens by a third per shot and closes again at about two seconds' worth of standing: a
      // burst that never ends sprays, and a shooter who waits gets his first shot's accuracy back. The
      // decay belongs to `advance`, which this call has already run — charging it twice would leave a
      // pistol unable to warm up at all.
      gun.heat = clamp(gun.heat + HEAT_PER_SHOT, 0, 1);
      gun.shots++;
      const look = { yaw: from.yaw || 0, pitch: from.pitch || 0 };
      // The muzzle is 0.6 m ahead of the eye and 0.18 to the right: a shot fired from the camera centre is
      // a shot that goes through the shooter's own arm, and through anything he is holding up.
      origin[0] = from.x + Math.sin(look.yaw) * 0.6 + Math.cos(look.yaw) * 0.18;
      origin[1] = from.y - 0.12;
      origin[2] = from.z + Math.cos(look.yaw) * 0.6 - Math.sin(look.yaw) * 0.18;
      const pellets = [];
      for (let p = 0; p < (spec.pellets || 1); p++) pellets.push(oneShot(origin, spec, look, move));
      const struck = pellets.filter((s) => s.hit);
      if (deps.onShot) deps.onShot({ gun: gun.id, pellets, struck, origin: [origin[0], origin[1], origin[2]], dir: [dir[0], dir[1], dir[2]] });
      if (struck.length && deps.onHit) for (const s of struck) deps.onHit(s);
      gun.hits += struck.length;
      return { pellets, struck };
    },

    /** The tank's own numbers, for a HUD that has to say "5 / 24" and nothing grander. */
    snapshot() {
      return {
        id: gun.id, state: gun.state, magazine: gun.inMagazine, reserve: gun.reserve,
        size: gun.weapon ? gun.weapon.magazine : 0, heat: gun.heat, reload: gun.reloading,
        seconds: gun.weapon ? 1 / gun.weapon.rate : 0, shots: gun.shots, hits: gun.hits,
      };
    },
  };
  gun.needReload = false;

  /** One pellet: the world's ray, then the crowd's bodies, and the nearer of the two wins. */
  function oneShot(muzzle, spec, look, move) {
    spreadDir(look, spec, gun.heat, move, rng, dir);
    const out = { hit: false, dist: spec.reach, kind: 'air', person: null, body: null, point: [0, 0, 0] };
    const wall = physics && typeof physics.raycast === 'function' ? physics.raycast(muzzle, dir, spec.reach, null) : null;
    const wallDist = wall && wall.hit ? wall.dist : spec.reach;
    // People are not physics bodies — the crowd is simulated and never collided with, exactly so that a car
    // can drive through it — so a bullet meets them here, as a segment against a standing capsule.
    if (crowd && crowd.people) {
      let best = wallDist, found = null;
      for (const p of crowd.people) {
        if (!p || p.down) continue;
        const t = rayCapsule(muzzle, dir, p.x - muzzle[0], (p.y || 0) - muzzle[1], p.z - muzzle[2],
          BODY_RADIUS, BODY_HEIGHT, best);
        if (t !== null && t < best) { best = t; found = p; }
      }
      if (found) {
        out.hit = true; out.dist = best; out.kind = 'person'; out.person = found;
        out.point = [muzzle[0] + dir[0] * best, muzzle[1] + dir[1] * best, muzzle[2] + dir[2] * best];
        return out;
      }
    }
    if (wall && wall.hit) {
      out.hit = true; out.dist = wallDist; out.kind = wall.body ? 'car' : 'world';
      out.body = wall.body || null;
      out.point = [muzzle[0] + dir[0] * wallDist, muzzle[1] + dir[1] * wallDist, muzzle[2] + dir[2] * wallDist];
    }
    return out;
  }
  return gun;
}

/**
 * A ray against a vertical capsule: the standing body of a person, `radius` wide and `height` tall, whose
 * axis passes through (ox, oy, oz) — that offset being taken from the ray's own origin, which is what lets
 * the caller skip building a matrix. Returns the distance along the ray to the first thing it touches, or
 * null when the segment misses. Pure arithmetic, no allocation: this runs once per pellet per person.
 */
export function rayCapsule(origin, dir, ox, oy, oz, radius, height, maxDist) {
  const dx = dir[0], dy = dir[1], dz = dir[2];
  // The ray's position relative to the axis, at t: (dx*t - ox, dy*t - oy, dz*t - oz).
  const px = -ox, pz = -oz;
  let best = Infinity;
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {                                      // the cylinder's skin
    const b = 2 * (dx * px + dz * pz);
    const c = px * px + pz * pz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let t0 = (-b - sq) / (2 * a);
      const t1 = (-b + sq) / (2 * a);
      if (t1 >= 0) {
        if (t0 < 0) t0 = 0;                            // the ray starts inside the skin: enter at the origin
        const y0 = dy * t0 - oy, y1 = dy * t1 - oy;
        const through = (y0 >= 0 && y0 <= height) || (y1 >= 0 && y1 <= height) || (y0 < 0 && y1 > height);
        if (through) best = t0;
      }
    }
  }
  if (Math.abs(dy) > 1e-9) {                           // and its two ends, which a steep shot meets first
    for (const plane of [0, height]) {
      const t = (plane + oy) / dy;
      if (t < 0 || t >= best) continue;
      const hx = dx * t + px, hz = dz * t + pz;
      if (hx * hx + hz * hz <= radius * radius) best = t;
    }
  }
  return best <= maxDist && Number.isFinite(best) ? best : null;
}
