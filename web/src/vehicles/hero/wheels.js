// Road wheels of the Lucera: a three-piece 16 inch alloy of the period (polished lip, five-spoke satin centre; deep-
// dished and half as wide again at the rear) on a low-profile radial, over a ventilated disc and a red four-piston
// caliper.
//
// Everything is modelled as the car's LEFT wheel in the hub's frame: origin on the axle where the suspension carries
// the wheel (the point the game pivots and spins it about), +X along the axle pointing out of the car, +Y up, +Z
// forward. The wheel spins about X. The middle of the tyre's width lies `offset` (spec WHEEL) outboard of that origin:
// the wheel and its brake are drawn further out than the track the physics uses, to stand close under the flares.
// A right-hand wheel is the same mesh turned half a turn about Y (so the lettering still reads), spinning the other
// way; the corner mesh is mirrored instead.
//
//   buildWheel(w, detail)   all that turns: rim, tyre, disc, hub. detail 1 is the showroom wheel; below 0.75 the
//                           tread and lettering are left to the shader, below 0.5 the small parts go too
//   buildWheelBlur(w)       the same wheel as it looks turning fast, drawn in place of the sharp one above a wheel
//                           speed the game chooses, so that spokes and tread never strobe
//   buildCaliper(w)         all that follows the hub without turning: caliper, pads, shield, hub carrier, and at
//                           the rear the drive shaft, links and spring strut
//
// w is an entry of spec WHEEL; the wheel's own dimensions are in wheels/design.js.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY } from '../../core/ids.js';
import { wheelDesign } from './wheels/design.js';
import { buildRim, buildRimSmeared } from './wheels/rim.js';
import { buildTyre } from './wheels/tyre.js';
import { buildDisc, buildCorner } from './wheels/brake.js';
import { MM } from './wheels/skin.js';

const start = () => { const mb = new MeshBuilder(); mb.family(FAMILY.VEHICLE); mb.occlusion(1); return mb; };

/** Finish a mesh that was built about the middle of the tyre: move it outboard by the wheel's offset. */
const placed = (mb, d) => (d.offset ? mb.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d.offset * MM, 0, 0, 1]) : mb).finish();

/** One road wheel as mesh data. */
export function buildWheel(w, detail = 1) {
  const mb = start(), d = wheelDesign(w);
  buildRim(mb, d, detail); buildTyre(mb, d, detail); buildDisc(mb, d, detail);
  return placed(mb, d);
}

/** The wheel as it looks at speed (see above). */
export function buildWheelBlur(w) {
  const mb = start(), d = wheelDesign(w);
  buildRimSmeared(mb, d); buildTyre(mb, d, 0.75, true); buildDisc(mb, d, 0.4);
  return placed(mb, d);
}

/** The brake caliper and the rest of the corner behind a left wheel; it follows the hub but does not turn with the wheel. */
export function buildCaliper(w) {
  const mb = start(), d = wheelDesign(w);
  buildCorner(mb, d);
  return placed(mb, d);
}
