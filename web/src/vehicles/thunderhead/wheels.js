// Road wheels of the Thunderhead: a 16 inch directional alloy. A flat disc, its face and lip turned bright on the
// lathe, pierced by a ring of sixteen swept slots that each sit in a shallow as-cast pocket; a painted cap over the
// nuts with our mark (a lightning bolt) on its black centre. Wide square-shouldered tyres, and behind the disc of
// the wheel a ventilated brake disc with a small single-piston iron caliper.
//
// The slots lean back at the top of the wheel as it rolls forward, so the two sides of the car need mirror-image
// wheels: `hand` 1 is the left-hand wheel, -1 the right-hand one. Both are modelled in the car's LEFT wheel frame
// (the right-hand wheel is placed like any other right wheel, by half a turn about the vertical), exactly as
// hero/wheels.js explains (+X out of the car, the wheel spins about X, the middle of the tyre `offset` outboard):
//   buildWheel(w, detail, hand)   buildWheelBlur(w, hand)   buildCaliper(w)      w: spec WHEEL.front or WHEEL.rear
// Millimetres until written; angles from the top (+Y) towards the front (+Z).

import { VEHICLE } from '../../core/ids.js';
import { curve } from '../hero/kit/curve.js';
import { turn, fillet, TAU } from '../hero/wheels/skin.js';
import { COLOUR } from '../hero/wheels/design.js';
import { FINISH, rimMetal, centreCap, valve, weights, barrel } from '../hero/wheels/rim.js';
import { wheelSizes, surfaceOf, rounded, ramp, inCell, cellQuality, buildCells, buildSmearedFace, wheelBuilders } from '../hero/wheels/cast.js';

// [roughness, metalness] bytes: the diamond-turned face and lip, and the cap's silver paint
const TURNED = [70, 255], PAINT = [105, 150];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Our mark on the cap: a lightning bolt. A loop in millimetres on a cap seated at radius 30, [up, across]. */
const BOLT = [[[15, 5], [-2.5, 1.5], [1, 8.5], [-15, -5], [2.5, -1.5], [-1, -8.5]]];

/** The wheel's design for one end of the car (see hero/wheels/design.js for the layout); hand -1: the mirror image. */
export function design(w, hand = 1) {
  const z = wheelSizes(w), { xo, bore } = z;
  // the face stands this far behind the outer flange: nearly flush on the front rim, a shallow dish on the wider rear
  const dish = clamp(10 + 12 * ((w.rimWidth ?? 8.5) - 8.5), 8, 30), xr = xo - dish;
  const ring = { inner: 180 }, hub = { radius: 100, face: xr, thickness: 30, seat: 30, cap: 82, proud: 9 };
  hub.pad = hub.face - hub.thickness;
  const spoke = {
    count: 16, angle0: 0,
    thickness: curve([[hub.radius, hub.thickness], [122, 16], [166, 15], [ring.inner, 19]]),   // a thin disc between a thick hub and the rim
    edge: 1.6, backEdge: 1.5, draft: 4 * Math.PI / 180,
    stations: [0.13, 0.3, 0.5, 0.7, 0.87],
  };
  // a slot: a stadium from radius 115 to 171, 17 mm wide at its inner end and 25 at its outer; (r, a) from its middle line
  const halfWidth = (r) => 8.5 + 4 * clamp((r - 115) / 56, 0, 1);
  const slot = (r, a) => { const k = halfWidth(r), t = r * Math.sin(a); return rounded([115 + k - r, r - (171 - k), t, -t], k); };
  const grow = 4.6;                                                         // the pocket: the slot grown by this much all round
  const lip = { step: [xo - 4.5, z.flange.wallFoot - 3], foot: [xr + 2.5, ring.inner + 4] };
  const back = xr - spoke.thickness(ring.inner);
  lip.radiusAt = (x) => (x <= back ? bore : x <= xr ? ring.inner : lip.foot[1] + (lip.step[1] - lip.foot[1]) * clamp((x - lip.foot[0]) / (lip.step[0] - lip.foot[0]), 0, 1));
  const hatDepth = 38, disc = { radius: 146, inner: 94, thickness: 24, plate: 7, hat: 78, vanes: 36 };
  disc.x = hub.pad - hatDepth - disc.thickness / 2;
  return {
    ...z, hand, dish, xr, hub, ring, spoke, lip, disc, pad: hub.pad,
    // every slot leans the same way round the wheel: outer end behind the inner end at the top as the wheel rolls forward
    sweep: (r) => -hand * 0.2 * (r - 145) / 53,
    face: () => xr,
    opening: { centre: 145, outside: slot },
    valley: { outside: (r, a) => slot(r, a) - grow, grow, width: 2.4, depth: 1.3, colour: [0.4, 0.4, 0.395] },
    colour: COLOUR.polished,
    caliper: { colour: [0.17, 0.165, 0.16], finish: [165, 110], pistons: 1 },   // a floating iron caliper
    tyre: {
      shoulder: 19, crown: 1.5, depth: 7,                                  // a square shoulder
      grooves: [14, 46, 80], grooveWidth: 7, slot: 4.5, pitches: 60,
      brand: 'VELTRO', line: 'TONANTE', size: z.size, capHeight: 20,
    },
  };
}

/** The flat face, sunk into the pocket round each slot down a bank `width` wide. */
function faceOf(d) {
  const V = d.valley;
  return surfaceOf(V ? (y, z) => d.xr - V.depth * ramp(0.5 - V.outside(...inCell(d, y, z)) / V.width) : () => d.xr);
}

/** The turned rim from behind the outer flange, over it and down the short wall of the dish to the face. */
function lip(mb, d, q) {
  const F = d.flange, xo = d.xo, r1 = d.ring.inner, L = d.lip, from = d.spoke.angle0 + d.sweep(r1);
  const far = [[xo - 9, F.top - 6], [xo - 8, F.top], [xo, F.top], [xo - 0.7, F.wallFoot], [L.step[0] + 2.6, L.step[1] + 2.2], L.step, L.foot, [d.xr, r1 + 1.5], [d.xr, r1]];
  rimMetal(mb, d.colour, TURNED, FINISH.TURNED);
  turn(mb, q.fine ? fillet(far, [0, 2, 3.6, 1.6, 0.5, 1.2, 2.5, 0, 0], q.arc) : far.filter((_, i) => i !== 4 && i !== 7), { segs: q.segs, from, to: from + TAU });
}

/** Inside the slots: the last of the turned face, then the painted cap that covers the nuts and its black centre. */
function hubAndCap(mb, d, q) {
  const H = d.hub, x = H.face, top = x + H.proud, c = H.cap, from = d.spoke.angle0 + d.sweep(H.radius);
  rimMetal(mb, d.colour, TURNED, FINISH.TURNED);
  turn(mb, [[x, H.radius], [x, c + 1.5]], { segs: q.segs, from, to: from + TAU });
  // the cap: a rolled edge, a flat crown with one pressed groove, and the seat of the centre
  const cap = [[x - 0.6, c + 1.5], [x - 0.6, c], [x + 6.5, c - 1.5], [top, c - 8], [top, 59], [top - 1.1, 57.6], [top - 1.1, 55.4], [top, 54], [top, H.seat]];
  rimMetal(mb, COLOUR.alloy, PAINT, FINISH.CAST);
  turn(mb, q.fine ? fillet(cap, [0, 0.4, 2.2, 5, 0.5, 0.5, 0.5, 0.5, 0], q.arc) : [[x, c + 1.5], cap[2], cap[3], cap[8]], { segs: q.fine ? q.segs : q.segs / 2 });
  centreCap(mb, { hub: { face: top, seat: H.seat } }, q, BOLT);
}

/** The whole alloy wheel (everything of the wheel that is metal and turns), into `mb`. */
function rim(mb, d, detail) {
  const q = cellQuality(d, detail);
  if (!q.fine) d = { ...d, valley: null };                                  // the pockets are too small to show far away
  lip(mb, d, q);
  rimMetal(mb, d.colour, TURNED, FINISH.TURNED);
  buildCells(mb, d, q, faceOf(d));
  hubAndCap(mb, d, q);
  if (q.fine) {
    // the valve stands out of the wall of the dish, over the metal between two slots
    valve(mb, d, d.spoke.angle0 + d.hand * 6 * TAU / d.spoke.count + d.sweep(176), d.xo - Math.min(20, d.dish * 0.55));
    weights(mb, d);
  }
  barrel(mb, d, q);
}

/**
 * The wheel as it looks turning fast: the ring of slots runs into one darker band on the bright face (the exposure
 * spans two slots exactly, so that every point of a circle records the same).
 */
function smeared(mb, d) {
  const q = { ...cellQuality(d, 0.5), fine: false };
  lip(mb, d, q);
  buildSmearedFace(mb, d, faceOf(d), { blur: 2 * TAU / d.spoke.count, segs: q.segs, finish: TURNED, samples: 16 });
  hubAndCap(mb, d, q);
  barrel(mb, d, q);
}

export const { buildWheel, buildWheelBlur, buildCaliper } = wheelBuilders({ design, rim, smeared });
