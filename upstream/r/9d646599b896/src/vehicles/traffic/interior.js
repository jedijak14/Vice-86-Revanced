// Interiors: what is seen through the glass. A tub (floor, door trims, bulkheads), a dashboard, seats and a
// steering wheel, all sized from the driver's eye point so the same code furnishes a hatchback and a bus.

import { quad, box, vec, X, Y, Z } from './kit.js';
import { steeringWheel } from './parts.js';
import * as mt from './materials.js';

const dark = mt.interior(2, [0.09, 0.09, 0.095]);
const carpet = mt.interior(1, [0.07, 0.07, 0.075]);
const shade = (rgb, k) => [rgb[0] * k, rgb[1] * k, rgb[2] * k];

/** A seat for the half-open range of x: cushion, reclined back and (with `head`) a head restraint. hip = [y of cushion top, z of the seat back's foot]. */
function seat(sk, m, x0, x1, hip, top, floor, lv, head) {
  const cx = (x0 + x1) / 2, hx = (x1 - x0) / 2, [yc, zb] = hip;
  box(sk, m, [cx, (yc + floor) / 2, zb + 0.26], [hx, (yc - floor) / 2, 0.26], { skip: 'y' + (x0 <= 0 ? 'x' : ''), occ: [0.5, 1] });
  // The back leans some twelve degrees.
  const lean = vec.unit([0, 1, -0.22]), fw = vec.unit([0, 0.22, 1]), len = (top - yc) / lean[1], c = vec.mad([cx, yc, zb - 0.05], lean, len / 2);
  box(sk, m, c, [hx, len / 2, 0.06], { ax: [X, lean, fw], skip: 'y' + (x0 <= 0 ? 'x' : ''), occ: [0.6, 1] });
  if (head && lv === 0) box(sk, m, vec.mad([cx, yc, zb - 0.05], lean, len + 0.085), [0.12, 0.07, 0.045], { ax: [X, lean, fw] });
}

/**
 * Furnish a cabin. c = {
 *   xIn (inner face of the door trims), floor (y), belt (y of the window line), zFront (bulkhead under the screen), zBack (rear wall),
 *   eye: [x, y, z], tint (sRGB of seats and trims), rows: [{ z (seat back foot), bucket }], shelf: y of the parcel shelf or load deck behind the last seat | null, wall: z | null (partition behind the front seats, up to wallTop and out to wallX above the belt),
 *   wells: [{ z0, z1, x (inner face), top }] wheel housings that may reach into the cabin }.
 * Left half only; the steering wheel and instrument cowl are added by the caller after mirroring.
 */
export function furnish(sk, c, lv) {
  if (lv === 2) return;
  const { xIn, floor, belt, zFront, zBack, eye } = c, seatM = mt.interior(0, c.tint), trimM = mt.interior(0, shade(c.tint, 0.8));
  // Floor and door trims run the length of the cabin, stepping inwards round each wheel housing that reaches into it.
  // Behind the last seat lies the parcel shelf or the load deck: nothing is built below it, since the underside
  // of the body rises towards the tail and a footwell carried on at one height would hang out underneath.
  const zDeck = c.shelf != null ? c.rows[c.rows.length - 1].z - 0.12 : zBack, yBack = c.shelf != null ? c.shelf : floor;
  const wells = (c.wells || []).filter((w) => w.z1 > zBack && w.z0 < zFront && w.top > floor && w.x < xIn), cuts = [zBack, zFront];
  for (const z of [zDeck, ...wells.flatMap((w) => [w.z0, w.z1])]) if (z > zBack + 1e-4 && z < zFront - 1e-4) cuts.push(z);
  cuts.sort((p, q) => p - q);
  const yTrim = belt - 0.06, zone = (z) => wells.find((w) => z > w.z0 && z < w.z1);
  let before = null, lowBefore = floor;
  for (let k = 0; k < cuts.length - 1; k++) {
    const z0 = cuts[k], z1 = cuts[k + 1], zm = (z0 + z1) / 2, low = zm < zDeck ? yBack : floor;
    const w = zone(zm) && zone(zm).top > low ? zone(zm) : null, x = w ? w.x - 0.012 : xIn, top = w ? Math.min(w.top, yTrim) : low;
    // The shelf reaches out to the glass; a load deck stops at the side trims and steps round the housings.
    const xo = zm > zDeck || w ? x : low > yTrim ? xIn + 0.07 : xIn;
    quad(sk, zm > zDeck ? carpet : dark, [[0, low, z0], [0, low, z1], [xo, low, z1], [xo, low, z0]], Y, null, zm > zDeck ? 0.55 : 0.7);
    if (w) {
      quad(sk, trimM, [[x, low, z1], [x, low, z0], [x, top, z0], [x, top, z1]], [-1, 0, 0], null, [0.5, 0.5, 0.8, 0.8]);
      quad(sk, trimM, [[x, top, z0], [xIn, top, z0], [xIn, top, z1], [x, top, z1]], Y, null, 0.7);
    }
    if (top < yTrim) quad(sk, trimM, [[xIn, top, z1], [xIn, top, z0], [xIn, yTrim, z0], [xIn, yTrim, z1]], [-1, 0, 0], null, [w ? 0.8 : 0.5, w ? 0.8 : 0.5, 1, 1]);
    // Where the width changes, an upright face closes the step.
    const step = w || before, from = Math.max(low, lowBefore);
    if (k && step && w !== before) { const xs = step.x - 0.012, ts = Math.min(step.top, yTrim); if (ts > from) quad(sk, trimM, [[xs, from, z0], [xIn, from, z0], [xIn, ts, z0], [xs, ts, z0]], w ? [0, 0, -1] : Z, null, 0.6); }
    before = w; lowBefore = low;
  }
  quad(sk, dark, [[xIn, belt - 0.06, zFront], [xIn, belt - 0.06, zBack], [xIn + 0.012, belt - 0.02, zBack], [xIn + 0.012, belt - 0.02, zFront]], [-1, 0, 0]);
  quad(sk, dark, [[xIn + 0.012, belt - 0.02, zBack], [xIn + 0.07, belt - 0.02, zBack], [xIn + 0.07, belt - 0.02, zFront], [xIn + 0.012, belt - 0.02, zFront]], Y, null, 0.7);
  // An upright face across the cabin from the centre line to the door, leaning from z0 at y0 to z1 at y1. Where
  // it stands beside a wheel housing it stops at the housing's inner face and only passes over the top of it.
  const across = (m, y0, z0, y1, z1, n, occ, xOut = xIn + 0.07) => {
    const w = wells.find((q) => Math.min(z0, z1) <= q.z1 && Math.max(z0, z1) >= q.z0), at = (x, y) => [x, y, z0 + (z1 - z0) * (y - y0) / (y1 - y0)];
    const face = (xa, xb, ya, yb) => { const P = [at(xa, ya), at(xb, ya), at(xb, yb), at(xa, yb)]; quad(sk, m, n[2] > 0 ? P : [P[1], P[0], P[3], P[2]], n, null, occ); };
    if (!w || w.top <= y0 || w.x >= xOut) return face(0, xOut, y0, y1);
    face(0, w.x - 0.012, y0, y1); if (w.top < y1) face(w.x - 0.012, xOut, w.top, y1);
  };
  across(dark, yBack, zBack, belt - 0.02, zBack, Z, 0.5);
  // Dashboard: a padded top that reaches forward under the screen, and a face towards the seats.
  const zd = eye[2] + 0.56, yd = belt - 0.005;
  quad(sk, dark, [[0, yd, zd], [0, yd + 0.02, zFront + 0.2], [xIn + 0.07, yd + 0.02, zFront + 0.2], [xIn + 0.07, yd, zd]], Y, null, 0.8);
  quad(sk, dark, [[0, yd - 0.06, zd - 0.03], [0, yd, zd], [xIn, yd, zd], [xIn, yd - 0.06, zd - 0.03]], vec.unit([0, 0.4, -1]));
  across(trimM, floor + 0.12, zd + 0.05, yd - 0.06, zd - 0.03, [0, 0, -1], 0.6, xIn);
  const yc = Math.max(floor + 0.2, eye[1] - 0.66);
  c.rows.forEach((r, k) => {
    const top = Math.min(eye[1] - 0.1, belt + 0.16) - (k ? 0.04 : 0);
    // A seat beside a wheel housing is only as wide as the housing allows.
    const w = wells.find((q) => r.z - 0.2 < q.z1 && r.z + 0.52 > q.z0), xMax = Math.min(xIn, w ? w.x - 0.012 : xIn) - 0.03;
    if (r.bucket) seat(sk, seatM, eye[0] - 0.25, Math.min(xMax, eye[0] + 0.25), [yc, r.z], top, floor, lv, true);
    else seat(sk, seatM, 0, xMax, [yc - (k ? 0.02 : 0), r.z], top, floor, lv, false);
  });
  // A partition behind the front seats is seen from the cab and, through the rear glass, from behind.
  // Above the window line it is only as wide as the leaning-in glasshouse allows (wallX).
  if (c.wall != null) for (const [z, n, y0] of [[c.wall, Z, floor], [c.wall - 0.02, [0, 0, -1], Math.max(floor, yBack)]]) {
    across(dark, y0, z, belt, z, n, 0.6); across(dark, belt, z, c.wallTop, z, n, 0.7, Math.min(xIn + 0.07, c.wallX));
  }
}

/** Driver's side fittings, added once (the car's left, +X): steering wheel, column and the instrument cowl with its lit dials. */
export function driverFittings(sk, c, lv) {
  if (lv === 2) return;
  const { eye, belt } = c, zd = eye[2] + 0.56, ax = vec.unit([0, 0.42, -0.9]), hub = [eye[0], eye[1] - 0.36, eye[2] + 0.4];
  if (lv === 0) steeringWheel(sk, hub, ax, lv, dark);
  box(sk, dark, [eye[0], belt + 0.012, zd + 0.06], [0.17, 0.03, 0.08], { skip: 'y' });
  if (lv === 0) quad(sk, mt.interior(3, [1, 1, 1]), [[eye[0] + 0.14, belt - 0.05, zd - 0.022], [eye[0] - 0.14, belt - 0.05, zd - 0.022], [eye[0] - 0.14, belt + 0.035, zd - 0.022], [eye[0] + 0.14, belt + 0.035, zd - 0.022]], [0, 0, -1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
}
