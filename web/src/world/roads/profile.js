// Vertical profile of a bridge or causeway: road surface height as a function of station.
// The road leaves the land at baseY with zero grade, climbs to a crest and comes down the same way.
// Every change of grade is a smoothstep blend, so height, grade and curvature are all continuous and a car
// meets neither a kink at the foot of the ramp nor a ledge at the top.

import { LAND_Y } from './lanes.js';

/** Vertical curvature in 1/m: a car leaves the road over a crest when curvature * speed^2 exceeds gravity. */
export const CURVATURE = Object.freeze({
  COMFORT: 0.0025,   // wheels stay loaded up to about 225 km/h
  LIMIT: 0.0045,     // sharpest curve ever built; the crest is lowered rather than exceed it
});
/** Share of the permitted grade that is actually used, leaving room for the rounding of a meshed deck. */
const GRADE_USE = 0.96;

/** One ramp for a given rise and peak curvature: equal sag and crest curves, a straight tangent between if needed. */
function ramp(rise, curvature, gradeMax) {
  const natural = Math.sqrt(rise * curvature / 1.5);            // grade reached when the two curves meet directly
  const grade = Math.min(natural, gradeMax), curve = 1.5 * grade / curvature;
  const tangent = grade < natural ? rise / grade - curve : 0;
  return { grade, curve, tangent, length: 2 * curve + tangent };
}

/** The value nearest to `bad` for which fits() still holds, given that it holds at `good` and is monotonic between. */
function boundary(good, bad, fits) {
  for (let i = 0; i < 40; i++) { const mid = (good + bad) / 2; if (fits(mid)) good = mid; else bad = mid; }
  return good;
}

/**
 * @param {{ length: number, rise: number, style?: 'flat'|'arch', baseY?: number, maxGrade?: number }} o
 *   length: metres along the centre line from land to land; rise: wanted height of the crest above baseY.
 *   'flat' holds the crest height between the two ramps; 'arch' draws the crest curve out to mid-span.
 * @returns {{ y(s): number, grade(s): number, curvature(s): number, length: number, baseY: number,
 *   crestY: number, maxGrade: number, maxCurvature: number, rampLength: number }}
 */
export function makeProfile(o) {
  const length = Math.max(0, o.length), half = length / 2, baseY = o.baseY ?? LAND_Y;
  const gradeMax = (o.maxGrade ?? 0.06) * GRADE_USE;
  let rise = Math.max(0, o.rise || 0);
  const pieces = [];                                             // the climbing half: { s0, y0, g0, g1, len }
  let maxGrade = 0, maxCurvature = 0, rampLength = 0;

  if (rise > 1e-4 && half > 1) {
    // gentlest curves that fit; then sharper ones up to the limit; then a lower crest
    let r = ramp(rise, CURVATURE.COMFORT, gradeMax);
    if (r.length > half) {
      const fitsAt = (k) => ramp(rise, k, gradeMax).length <= half;
      if (fitsAt(CURVATURE.LIMIT)) r = ramp(rise, boundary(CURVATURE.LIMIT, CURVATURE.COMFORT, fitsAt), gradeMax);
      else {
        rise = boundary(0, rise, (h) => ramp(h, CURVATURE.LIMIT, gradeMax).length <= half);
        r = ramp(rise, CURVATURE.LIMIT, gradeMax);
      }
    }
    let { grade, curve: sag, tangent } = r, crest = r.curve;
    if (o.style === 'arch') {
      // spend the level stretch on a longer crest curve: each metre taken from the tangent buys two of curve
      const spare = half - r.length;
      if (tangent >= spare) { tangent -= spare; crest += 2 * spare; }
      else { grade = 2 * rise / half; tangent = 0; sag = Math.min(sag * grade / r.grade, half / 2); crest = half - sag; }   // no tangent left: one long, lower-grade arch
    }
    let s = 0, y = baseY;
    const add = (g0, g1, len) => { if (len > 1e-9) { pieces.push({ s0: s, y0: y, g0, g1, len }); s += len; y += (g0 + g1) / 2 * len; } };
    add(0, grade, sag); add(grade, grade, tangent); add(grade, 0, crest);
    rampLength = s; maxGrade = grade; maxCurvature = 1.5 * grade / Math.min(sag, crest);
    rise = y - baseY;
  } else rise = 0;

  const crestY = baseY + rise;
  /** Height, grade and curvature on the climbing half at distance d from the nearer end. */
  const at = (d, out) => {
    out[0] = crestY; out[1] = 0; out[2] = 0;
    if (d <= 0) { out[0] = baseY; return out; }
    for (const p of pieces) {
      if (d > p.s0 + p.len) continue;
      const t = (d - p.s0) / p.len, dg = p.g1 - p.g0;
      out[0] = p.y0 + p.g0 * (d - p.s0) + dg * p.len * (t * t * t - t * t * t * t / 2);
      out[1] = p.g0 + dg * (3 * t * t - 2 * t * t * t);
      out[2] = dg / p.len * (6 * t - 6 * t * t);
      return out;
    }
    return out;
  };
  const tmp = [0, 0, 0];
  return {
    length, baseY, crestY, maxGrade, maxCurvature, rampLength,
    y: (s) => at(Math.min(s, length - s), tmp)[0],
    grade: (s) => (s <= half ? 1 : -1) * at(Math.min(s, length - s), tmp)[1],
    curvature: (s) => at(Math.min(s, length - s), tmp)[2],
  };
}
