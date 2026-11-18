// The hull: one lofted, creased surface from which every body panel is cut.

import { makeLoft } from './kit/sheet.js';
import { RAIL, CREASE_RADIUS, CROWN, toCar } from './spec.js';

/**
 * The hull sheet. Chart: a = x in drawing millimetres, b = 0..7 across the rails (see spec.js).
 * filletRows: mesh rows per half crease fillet; the surface itself does not depend on it.
 */
export function makeHull(filletRows = 5) {
  const names = ['C', 'E', 'V', 'D', 'W', 'K', 'S', 'B'];
  return makeLoft({
    rails: names.map((n) => RAIL[n]),
    radius: names.map((n) => CREASE_RADIUS[n] || 0),
    crown: names.slice(0, -1).map((n) => CROWN[n] || 0), centred: true,
    place: (a, p, q, out) => toCar(a, q, p, out),
    flip: true, ha: 0.5, arcSegs: filletRows,
  });
}
