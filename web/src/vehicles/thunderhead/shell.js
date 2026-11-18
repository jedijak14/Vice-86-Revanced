// The hull: one lofted surface from which every panel and pane of the car is cut.

import { makeLoft } from '../hero/kit/sheet.js';
import { RAIL, RAIL_NAMES, CREASE_RADIUS, CROWN, NOSE_X, PILLAR_FOOT_X, HEADER_X, HEADER_CORNER_X, HOOP_X, HATCH_X, HATCH_END_X, toCar } from './spec.js';

/** Share of the chart between two rails given to each fillet: wide, because the shoulder rolls are a hand across. */
export const BAND = 0.3;
/**
 * Stations the mesh must contain besides the regular lattice: the nose is bowed in plan, so its outline turns
 * through most of a right angle within 200 mm of the leading edge.
 */
const NOSE_STATIONS = [1, 2, 4, 7, 10, 14, 19, 25, 32, 40, 50, 62, 76, 92, 110, 130, 155, 180].map((d) => NOSE_X + d);
/** Stations where a rail changes direction: the mesh has an edge on each. */
const BREAK_STATIONS = [PILLAR_FOOT_X, HEADER_X, HEADER_CORNER_X, HOOP_X, HATCH_X, 4040, HATCH_END_X];

/**
 * A rail that remembers its stations: the mesh asks for the same few hundred over and over, and a rail is a dozen
 * curve evaluations.
 */
function remembered(rail) {
  const seen = new Map();
  return (x) => { let p = seen.get(x); if (!p) { if (seen.size > MEMORY) seen.clear(); p = rail(x); seen.set(x, p); } return p; };
}
/** Stations a rail remembers before it starts over. */
const MEMORY = 60000;

/**
 * The hull sheet. Chart: a = x in drawing millimetres, b = 0..7 across the rails (see spec.js).
 * filletRows: mesh rows per half crease fillet; the surface itself does not depend on it.
 */
export function makeHull(filletRows = 5) {
  const hull = makeLoft({
    rails: RAIL_NAMES.map((n) => remembered(RAIL[n])),
    radius: RAIL_NAMES.map((n) => CREASE_RADIUS[n] || 0),
    crown: RAIL_NAMES.slice(0, -1).map((n) => CROWN[n] || 0), centred: true,
    place: (a, p, q, out) => toCar(a, q, p, out),
    flip: true, ha: 0.5, band: BAND, arcSegs: filletRows,
  });
  hull.cols = () => [...NOSE_STATIONS, ...BREAK_STATIONS];
  return hull;
}
