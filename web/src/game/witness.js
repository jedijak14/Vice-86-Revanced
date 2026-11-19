// The eyes of the street: cameras on the corners of shops and parking lots, and the people who
// happen to be standing there. A crime nobody saw is a crime nobody reported — but near a till or
// a painted bay, somebody is always watching: a lens on a bracket, or a pair of eyes on the
// pavement. Everything here is two-dimensional on purpose; the city is flat enough at eye height
// that a cone on the ground is the whole truth of whether a camera has you in frame.
//
// Zones come from the plan, not from a hand-placed list: every shopfront the shops system indexed
// is a zone, and every lot the planner paved for parking (COVER.PARKING) is a zone. Two cameras
// hang off the diagonal corners of each, looking in at the middle of it.

import { COVER } from '../world/plan/field.js';

/** How far a camera sees, in metres: a car park is not a airport, one bracket covers it. */
export const CAMERA_RANGE = 26;
/** Half-angle of the cone, radians: about 35 degrees either side of the lens's own yaw. */
export const CAMERA_CONE = 0.62;
/** How close a bystander has to be to have seen anything worth reporting. */
export const EYE_RANGE = 20;

const TAU = Math.PI * 2;
const angDelta = (a, b) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

/**
 * @param {{shops?: object[], lots?: object[], crowd?: object, seed?: number}} deps
 *   shops: the indexed shopfronts (they carry door x/z and a yaw); lots: the plan's lots, of which
 *   the parking-covered ones become zones; crowd: the living crowd, asked for positions with
 *   `crowd.at(person, out)`.
 */
export function createWitness({ shops = [], lots = [], crowd = null, seed = 7 } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

  const zones = [];
  for (const shop of shops) {
    if (!Number.isFinite(shop.x) || !Number.isFinite(shop.z)) continue;
    zones.push({ kind: 'shop', name: shop.name || 'a shopfront', x: shop.x, z: shop.z, r: 20, yaw: shop.yaw || 0 });
  }
  for (const lot of lots) {
    if (lot.cover !== COVER.PARKING) continue;
    const r = Math.max(14, Math.min(42, Math.max(lot.width || 20, lot.depth || 20) * 0.55));
    zones.push({ kind: 'lot', name: 'a parking lot', x: lot.x, z: lot.z, r, yaw: lot.yaw || 0 });
  }

  // Two lenses a zone, on opposite diagonal corners, both looking at the middle of it. A little
  // jitter on the bracket angle so no two shopfronts wear their cameras at the same tilt.
  const cameras = [];
  for (const zone of zones) {
    for (const k of [-1, 1]) {
      const a = zone.yaw + k * 0.9 + (rnd() - 0.5) * 0.3;
      const d = zone.r * 0.86;
      const x = zone.x + Math.sin(a) * d, z = zone.z + Math.cos(a) * d;
      cameras.push({ zone, x, z, yaw: Math.atan2(zone.x - x, zone.z - z), range: CAMERA_RANGE, cone: CAMERA_CONE });
    }
  }

  /** The zone a point is inside, nearest first; null out on the open street. */
  const zoneAt = (x, z) => {
    let best = null, bd = Infinity;
    for (const zone of zones) {
      const d = Math.hypot(x - zone.x, z - zone.z);
      if (d <= zone.r && d < bd) { bd = d; best = zone; }
    }
    return best;
  };

  /**
   * Who has eyes on a point right now.
   * @returns {{zone: object|null, camera: boolean, people: number}}
   */
  const seen = (x, z) => {
    const zone = zoneAt(x, z);
    if (!zone) return { zone: null, camera: false, people: 0 };
    let camera = false;
    for (const c of cameras) {
      if (c.zone !== zone) continue;
      const dx = x - c.x, dz = z - c.z;
      if (Math.hypot(dx, dz) > c.range) continue;
      if (Math.abs(angDelta(c.yaw, Math.atan2(dx, dz))) <= c.cone) { camera = true; break; }
    }
    let people = 0;
    if (crowd && crowd.people) {
      const out = [0, 0, 0];
      for (const p of crowd.people) {
        if (!p || p.dead) continue;
        crowd.at(p, out);
        if (Math.hypot(out[0] - x, out[2] - z) <= EYE_RANGE) people++;
      }
    }
    return { zone, camera, people };
  };

  return { zones, cameras, zoneAt, seen };
}
