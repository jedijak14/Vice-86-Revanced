// Road wheels of the Silvretta Turbo: a 16 inch forged alloy with five broad flat petals that grow out of a raised
// hub and round off against the rim, the hollows between them painted satin black round a window each, inside a
// broad polished lip. Five nuts on the hub round a black cap with our mark (a double peak). The rear rim is two
// inches wider than the front, all of it dish. Behind: ventilated discs and black four-piston calipers.
//
// Modelled as the car's LEFT wheel in the hub's frame, exactly as hero/wheels.js explains (+X out of the car, the
// wheel spins about X, the middle of the tyre `offset` outboard of the origin):
//   buildWheel(w, detail)   buildWheelBlur(w)   buildCaliper(w)        w: spec WHEEL.front or WHEEL.rear
// Millimetres until written; angles from the top (+Y) towards the front (+Z).

import { curve } from '../hero/kit/curve.js';
import { frame } from '../hero/kit/solids.js';
import { turn, fillet, MM, TAU } from '../hero/wheels/skin.js';
import { COLOUR } from '../hero/wheels/design.js';
import { FINISH, rimMetal, nut, centreCap, valve, weights, barrel } from '../hero/wheels/rim.js';
import { wheelSizes, surfaceOf, rounded, ramp, inCell, cellQuality, buildCells, buildSmearedFace, wheelBuilders } from '../hero/wheels/cast.js';

// [roughness, metalness] bytes: the petals' satin finish (the black of the hollows is the same lacquer over a dark
// base) and the polished lip
const SATIN = [85, 235], MIRROR = [24, 255];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Our mark on the cap: two peaks, the nearer one lower. A loop in millimetres on a cap seated at radius 30, [up, across]. */
const PEAKS = [[[-8, -15], [9, -3.5], [1, 2.5], [5.5, 6.5], [-8, 15]]];

/** The wheel's design for one end of the car (see hero/wheels/design.js for the layout). */
export function design(w) {
  const z = wheelSizes(w), { xo, bore } = z;
  // how far the petals' tips stand behind the outer flange: every extra inch of rim goes into the dish
  const dish = clamp(22 + 19 * ((w.rimWidth ?? 7) - 7), 18, 66), xr = xo - dish;
  const ring = { inner: 178 }, hubRadius = 84;
  const face = curve([[0, xr + 9], [hubRadius, xr + 9], [130, xr + 3.5], [ring.inner, xr]]);
  const hub = { radius: hubRadius, face: xr + 12, thickness: 34, seat: 30, nutPitch: 60 };   // the boss stands 3 mm proud of the petals' roots
  hub.pad = hub.face - hub.thickness;
  const spoke = {
    count: 5, angle0: 0,
    halfWidth: curve([[hubRadius, 18], [120, 33], [150, 39], [170, 37], [ring.inner, 36]]),    // a petal: widest two thirds of the way out
    thickness: curve([[hubRadius, face(hubRadius) - hub.pad], [130, 25], [ring.inner, 23]]),
    edge: 2.5, backEdge: 2, draft: 4 * Math.PI / 180,
  };
  // the hollow between two petals, and the window in its outer half; (r, a) from the middle of the hollow
  const half = Math.PI / spoke.count, bank = 6, sunk = 7;
  const between = (r, a, inset) => { const s = spoke.halfWidth(r) + inset; return [s - r * Math.sin(half - a), s - r * Math.sin(half + a)]; };
  const hollow = (r, a) => rounded([92 + 12 - r, r - (173 - 12), ...between(r, a, 12)], 12);
  const windowOf = (r, a) => rounded([126 + 10 - r, r - (163 - 10), ...between(r, a, 13 + 10)], 10);
  const lip = { step: [xo - 4.5, z.flange.wallFoot - 3], foot: [xr + 2.5, ring.inner + 4] };
  const back = xr - spoke.thickness(ring.inner);
  lip.radiusAt = (x) => (x <= back ? bore : x <= xr ? ring.inner : lip.foot[1] + (lip.step[1] - lip.foot[1]) * clamp((x - lip.foot[0]) / (lip.step[0] - lip.foot[0]), 0, 1));
  const hatDepth = 42, disc = z.rear ? { radius: 150, inner: 94, thickness: 24, plate: 7, hat: 76, vanes: 36 } : { radius: 152, inner: 96, thickness: 26, plate: 8, hat: 76, vanes: 36 };
  disc.x = hub.pad - hatDepth - disc.thickness / 2;
  return {
    ...z, dish, xr, hub, ring, spoke, face, lip, disc, pad: hub.pad, nutAngle0: 0,
    opening: { centre: 145, outside: windowOf },
    valley: { outside: hollow, width: bank, depth: sunk, colour: [0.035, 0.035, 0.038] },
    colour: COLOUR.alloy,
    caliper: { colour: [0.05, 0.05, 0.055], finish: [130, 40] },             // black enamel
    tyre: {
      shoulder: z.rear ? 27 : 24, crown: 2, depth: 7,
      grooves: z.rear ? [14, 44, 76] : [13, 38, 64], grooveWidth: 7, slot: 4.5, pitches: 60,
      brand: 'VELTRO', line: 'DORSALE', size: z.size, capHeight: 20,
    },
  };
}

/** The petals' face, sunk into the hollows between them down a bank `width` wide. */
function faceOf(d) {
  const V = d.valley;
  return surfaceOf((y, z) => d.face(Math.hypot(y, z)) - V.depth * ramp(0.5 - V.outside(...inCell(d, y, z)) / V.width));
}

/** The polished rim from behind the outer flange, over it and down the wall of the dish to the petals' tips. */
function lip(mb, d, q) {
  const F = d.flange, xo = d.xo, r1 = d.ring.inner, L = d.lip;
  const far = [[xo - 9, F.top - 6], [xo - 8, F.top], [xo, F.top], [xo - 0.7, F.wallFoot], [L.step[0] + 2.6, L.step[1] + 2.2], L.step, L.foot, [d.xr, r1 + 1.5], [d.xr, r1]];
  rimMetal(mb, COLOUR.polished, MIRROR, FINISH.SMOOTH);
  turn(mb, q.fine ? fillet(far, [0, 2, 3.6, 1.6, 0.5, 1.2, 4, 0, 0], q.arc) : far, { segs: q.segs, from: d.spoke.angle0, to: d.spoke.angle0 + TAU });
}

/** The hub inside the petals' roots: a low round boss, the five nuts on it and the cap in its middle. */
function hubAndNuts(mb, d, q) {
  const H = d.hub, r0 = H.radius, boss = [[d.face(r0), r0], [H.face - 0.4, r0 - 3.5], [H.face, r0 - 7], [H.face, H.seat]];
  rimMetal(mb, d.colour, SATIN, FINISH.SMOOTH);
  turn(mb, q.fine ? fillet(boss, [0, 2.5, 3, 0], q.arc) : boss, { segs: q.segs, from: d.spoke.angle0, to: d.spoke.angle0 + TAU });
  if (q.fine) {
    for (let k = 0; k < 5; k++) {
      const a = d.nutAngle0 + k * TAU / 5, y = H.nutPitch * Math.cos(a), z = H.nutPitch * Math.sin(a);
      nut(mb, frame([H.face * MM, y * MM, z * MM], [1, 0, 0], [0, y, z]));
    }
  }
  centreCap(mb, d, q, PEAKS);
}

/** The whole alloy wheel (everything of the wheel that is metal and turns), into `mb`. */
function rim(mb, d, detail) {
  const q = cellQuality(d, detail);
  lip(mb, d, q);
  rimMetal(mb, d.colour, SATIN, FINISH.SMOOTH);
  buildCells(mb, d, q, faceOf(d));
  hubAndNuts(mb, d, q);
  if (q.fine) {
    // the valve stands out of the wall of the dish in line with a hollow
    valve(mb, d, d.spoke.angle0 + 3 * Math.PI / d.spoke.count, d.xo - Math.min(20, d.dish * 0.55));
    weights(mb, d);
  }
  barrel(mb, d, q);
}

/** The wheel as it looks turning fast: petals and hollows run into bright and dark rings, the nuts into the hub. */
function smeared(mb, d) {
  const q = { ...cellQuality(d, 0.5), fine: false };
  lip(mb, d, q);
  buildSmearedFace(mb, d, faceOf(d), { blur: 36 * Math.PI / 180, segs: q.segs, finish: SATIN });
  hubAndNuts(mb, d, q);
  barrel(mb, d, q);
}

export const { buildWheel, buildWheelBlur, buildCaliper } = wheelBuilders({ design, rim, smeared });
