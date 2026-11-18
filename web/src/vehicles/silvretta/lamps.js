// The headlamps: a round sealed beam at the front of each wing, leaning back with the wing's face, in a ring
// painted with the body. The wing's skin is flat where the lamp sits (shell.js), so ring and lamp are flat too.

import { VEHICLE } from '../../core/ids.js';
import { ringLoft } from '../hero/kit/solids.js';
import { sealedBeam, lensFace, circle, CIRCUIT, OPTICS, LENS } from '../hero/lamps/optics.js';
import * as S from './spec.js';

const MM = S.MM, H = S.HEADLAMP, LEAN = H.lean * Math.PI / 180;
const CENTRE = S.toCar(H.x, H.y, H.z), U = [1, 0, 0], V = [0, Math.cos(LEAN), -Math.sin(LEAN)], W = [0, Math.sin(LEAN), Math.cos(LEAN)];
/** The lamp's frame: u outboard, v up the lens, w out along the beam, millimetres from the centre of the lens seat. */
export const lampPoint = (u, v, w = 0) => [CENTRE[0] + (u * U[0] + v * V[0] + w * W[0]) * MM, CENTRE[1] + (u * U[1] + v * V[1] + w * W[1]) * MM, CENTRE[2] + (u * U[2] + v * V[2] + w * W[2]) * MM];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Chart point of the hull that lies behind (u, v) of the lamp's frame, looking along the beam. */
function behind(hull, u, v) {
  let a = H.x, b = S.RAIL.P2; const p = [0, 0, 0], ja = [0, 0, 0], jb = [0, 0, 0];
  for (let i = 0; i < 60; i++) {
    hull.pos(a, b, p); const d = [p[0] - CENTRE[0], p[1] - CENTRE[1], p[2] - CENTRE[2]], eu = dot(d, U) - u * MM, ev = dot(d, V) - v * MM;
    if (Math.abs(eu) + Math.abs(ev) < 1e-8) break;
    hull.jac(a, b, ja, jb);
    const m00 = dot(ja, U), m01 = dot(jb, U), m10 = dot(ja, V), m11 = dot(jb, V), det = m00 * m11 - m01 * m10;
    const da = -(m11 * eu - m01 * ev) / det, db = (m10 * eu - m00 * ev) / det, k = Math.min(1, 40 / Math.abs(da), 0.5 / Math.abs(db));
    a += da * k; b += db * k;
  }
  return [a, b];
}

/** The opening for the lamp in the wing, as chart points: the shut line round the ring. */
export function headlampOpening(hull, points = 44) {
  return circle(H.ring, points).map((q) => behind(hull, q[0], q[1]));
}

/**
 * Add the left headlamp. glass: the builder for lenses, or null for the reduced model, whose lamp is one glowing
 * disc on the uncut wing. Returns the lamp's anchor { pos, dir }.
 */
export function buildHeadlamp(mb, glass) {
  if (!glass) {
    // the coarse wing does not follow the lamp's seat: the disc stands on a skirt that reaches back into it
    mb.material(VEHICLE.PAINT, 0, 0); mb.color(1, 1, 1); mb.occlusion(1);
    ringLoft(mb, lampPoint, circle(H.ring - 4, 16), [[0, -45], [0, 2]], { crease: 60 });
    lensFace(mb, null, lampPoint, circle(H.ring - 4, 16), { w: 2, optics: OPTICS.SEALED_BEAM, circuit: CIRCUIT.HEAD, lens: LENS.clear });
    return { pos: lampPoint(0, 0, 6), dir: [0, 0, 1] };
  }
  // the ring: up out of the shut line, over a low crown and down to the lamp's own bright rim
  const reach = H.ring - S.GAP / 2 - H.lens;
  mb.material(VEHICLE.PAINT, 0, 0); mb.color(1, 1, 1); mb.occlusion(1);
  ringLoft(mb, lampPoint, circle(H.lens, 56), [[reach, -9], [reach, 0.8], [reach - 1.2, 2.8], [reach - 3.8, 4.4], [reach - 8, 5.2], [5, 4.6], [2, 3], [0.6, 1.2], [0.6, -2]], { crease: 60 });
  const pos = sealedBeam(mb, lampPoint, (build) => build(glass), { r: H.lens, circuit: CIRCUIT.HEAD });
  return { pos, dir: [0, 0, 1] };
}
