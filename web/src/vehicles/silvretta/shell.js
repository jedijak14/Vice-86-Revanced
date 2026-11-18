// The hull: one smooth surface from the bonnet's leading edge to the tail, roof included, closed under the car.
// Everything painted is cut from it (body.js); the bumpers and the lamp band are separate sweeps round its ends.

import { makeSplineHull } from './form.js';
import { RAILS, ROWS, GUTTER_ROW, BELT_ROW, SILL_ROW, MM, toCar, HEADLAMP } from './spec.js';

// The headlamp's seat. The lamp is a flat disc leaning back, the wing behind it a tube: where the two meet, the
// front of the wing is drawn onto the lamp's plane. Within `flat` millimetres of the lamp's axis the skin lies in
// that plane exactly; from there to `reach` it runs back into the wing as drawn.
const SEAT = { flat: HEADLAMP.ring + 8, reach: HEADLAMP.ring + 62, near: 60, far: 120, cos: Math.cos(HEADLAMP.lean * Math.PI / 180), sin: Math.sin(HEADLAMP.lean * Math.PI / 180) };
const fade = (t) => (t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * t * (10 - 15 * t + 6 * t * t));
function seated(x, y, z, out) {
  const dx = x - HEADLAMP.x, dy = y - HEADLAMP.y, du = z - HEADLAMP.z;
  const ahead = dy * SEAT.sin - dx * SEAT.cos, dv = dx * SEAT.sin + dy * SEAT.cos, rho = Math.hypot(du, dv);
  if (rho >= SEAT.reach || Math.abs(ahead) >= SEAT.far) return toCar(x, y, z, out);
  const k = fade((rho - SEAT.flat) / (SEAT.reach - SEAT.flat)) * fade((Math.abs(ahead) - SEAT.near) / (SEAT.far - SEAT.near)) * ahead;
  return toCar(x + SEAT.cos * k, y - SEAT.sin * k, z, out);
}

/** The hull sheet. Chart: a = x in mm, b = control rail index (spec RAIL), fractions in between. */
export function makeHull() {
  return makeSplineHull({ rails: RAILS, place: seated, seams: [GUTTER_ROW, BELT_ROW, SILL_ROW], flip: true });
}

// Chart ranges in which the section's z (plan) or y (side view) is monotone.
const { top: TOP, side: SIDE, glass: GLASS, floor: FLOOR } = ROWS;
/** Chart point of a plan position (x, z) on the top surfaces, of a side-view position (x, y) on the body side, on the cabin's side above the belt, and of a plan position under the floor. */
export const onTop = (hull, x, z) => [x, hull.solve(x, 0, z, TOP[0], TOP[1])];
export const onSide = (hull, x, y) => [x, hull.solve(x, 1, y, SIDE[0], SIDE[1])];
export const onCabin = (hull, x, y) => [x, hull.solve(x, 1, y, GLASS[0], GLASS[1])];
export const onFloor = (hull, x, z) => [x, hull.solve(x, 0, z, FLOOR[0], FLOOR[1])];
/** Edge descriptors for buildPanel: the edge leaving the vertex is straight in plan, in side view, on the cabin side, under the floor. */
export const inPlan = { via: 0, range: TOP }, inSide = { via: 1, range: SIDE }, inCabin = { via: 1, range: GLASS }, inFloor = { via: 0, range: FLOOR };

/** Point of the hull at a chart position, `depth` millimetres under the surface. Vehicle metres. */
export function under(hull, c, depth = 0) {
  const p = hull.pos(c[0], c[1], [0, 0, 0]); if (!depth) return p;
  const n = hull.normal(c[0], c[1], [0, 0, 0]);
  return [p[0] - n[0] * depth * MM, p[1] - n[1] * depth * MM, p[2] - n[2] * depth * MM];
}
export const topPoint = (hull, x, z, depth = 0) => under(hull, onTop(hull, x, z), depth);
export const sidePoint = (hull, x, y, depth = 0) => under(hull, onSide(hull, x, y), depth);
/** Drawing coordinates [x, y, z] (mm) of a chart point. */
export function drawn(hull, c) { const s = hull.sec(c[0], c[1]); return [c[0], s[1], s[0]]; }
