// The windscreen's surface. Its base and header are bowed 200 mm in plan, which no section across the car can
// follow, so the screen is a sheet of its own: ruled between the base line on the cowl and the header line on the
// roof, crowned up its height, and bent at its side so that its edge is exactly the pillar line on the hull.
// The three boundary lines are hull points, so the frame cut from the hull (body.js) and the glass meet edge to edge.

import { makeSheet } from '../hero/kit/sheet.js';
import { curve } from '../hero/kit/curve.js';
import * as S from './spec.js';

const E = S.B_OF.E, G = S.B_OF.G;
/** Samples taken along each boundary line; the lines between them are cubics. */
const SAMPLES = 40;

/**
 * Returns { sheet, base(s), header(s), pillar(t), footZ, cornerZ }.
 * sheet chart: a = s, 0 on the centre line to 1 on the pillar line; b = t, 0 on the base line to 1 on the header.
 * base, header, pillar: hull chart points [x, b] of the three boundary lines.
 */
export function makeScreen(hull) {
  const footZ = hull.sec(S.PILLAR_FOOT_X, E)[0], cornerZ = hull.sec(S.HEADER_CORNER_X, E)[0];
  const bowed = (x0, x1, half) => (s) => {
    if (s >= 1) return [x1, E];
    const x = x0 + (x1 - x0) * s * s;
    return [x, s <= 0 ? 0 : hull.solve(x, 0, half * s, 0, E)];
  };
  const base = bowed(S.SCREEN_BASE_X, S.PILLAR_FOOT_X, footZ), header = bowed(S.HEADER_X, S.HEADER_CORNER_X, cornerZ);
  const pillar = (t) => {
    if (t <= 0) return [S.PILLAR_FOOT_X, E];
    if (t >= 1) return [S.HEADER_CORNER_X, E];
    const x = S.PILLAR_FOOT_X + (S.HEADER_CORNER_X - S.PILLAR_FOOT_X) * t;
    return [x, hull.solve(x, 1, S.pillarY(x), E, G)];
  };
  // each line as three cubics through its samples (vehicle metres)
  const line = (chartOf) => {
    const pts = Array.from({ length: SAMPLES + 1 }, (_, i) => hull.pos(...chartOf(i / SAMPLES), [0, 0, 0]));
    const xyz = [0, 1, 2].map((k) => curve(pts.map((p, i) => [i / SAMPLES, p[k]])));
    return (u, out) => { out[0] = xyz[0](u); out[1] = xyz[1](u); out[2] = xyz[2](u); return out; };
  };
  const onBase = line(base), onHeader = line(header), onPillar = line(pillar);
  const foot = onBase(1, [0, 0, 0]), corner = onHeader(1, [0, 0, 0]), p = [0, 0, 0], q = [0, 0, 0], e = [0, 0, 0];
  // the crown pushes the glass out along the mean normal of the screen's centre line: up and forward
  const rise = Math.atan2(corner[1] - foot[1], foot[2] - corner[2]), crownY = Math.cos(rise) * S.SCREEN.crown * S.MM, crownZ = Math.sin(rise) * S.SCREEN.crown * S.MM;
  const sheet = makeSheet((s, t, out) => {
    const sc = Math.min(1, Math.max(0, s)), tc = Math.min(1, Math.max(0, t));
    onBase(sc, p); onHeader(sc, q); onPillar(tc, e);
    // the bend that brings the ruled surface's edge onto the pillar line dies away towards the centre line
    const bend = sc * sc * sc, crown = 4 * tc * (1 - tc) * (1 - sc * sc);
    for (let k = 0; k < 3; k++) out[k] = p[k] + (q[k] - p[k]) * t + (e[k] - (foot[k] + (corner[k] - foot[k]) * tc)) * bend;
    out[1] += crownY * crown; out[2] += crownZ * crown;
    return out;
  });
  return { sheet, base, header, pillar, footZ, cornerZ };
}
