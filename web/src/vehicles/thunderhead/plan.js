// The plan outlines of the two ends of the car at belt height, each as a curve with a chart coordinate along it.
// The bumpers are swept along these, and the rub strip follows them.
//   nose: a = 0 on the centre line, across the straight front, round the corner and back along the body side.
//   tail: a = 0 on the body side at TAIL.startX, back along the side, round the corner and across to the centre line.
// A point is [x, z] in drawing millimetres. frame(a) is [x, z, nx, nz]: the point and the unit normal of the outline
// in plan, pointing out of the car.

import * as S from './spec.js';

/** Step of the central difference that gives the outline's direction, mm of chart. */
const STEP = 1e-2;
function framed(point) {
  let at = NaN, last = null;
  return (a) => {
    if (a === at) return last;
    const p = point(a), q0 = point(a - STEP), q1 = point(a + STEP), tx = q1[0] - q0[0], tz = q1[1] - q0[1], l = Math.hypot(tx, tz);
    at = a; last = [p[0], p[1], -tz / l, tx / l];
    return last;
  };
}

// ---------------------------------------------------------------- nose
/** Chart length given to the sweep from the straight front to station NOSE.roundX: about its true length. */
const NOSE_RUN = 900;
const N = S.NOSE, NOSE_SPAN = N.roundX - S.NOSE_X;
function nosePoint(a) {
  if (a <= N.flat) return [S.NOSE_X, a];
  const t = (a - N.flat) / NOSE_RUN;
  if (t >= 1) { const x = N.roundX + (a - N.flat - NOSE_RUN); return [x, S.sideZ(x)]; }
  // x = t ^ power makes the sweep's width grow in proportion to t at first: the curve leaves the front at a steady pace
  const s = t ** N.power, x = S.NOSE_X + NOSE_SPAN * s;
  return [x, N.flat + (S.sideZ(x) - N.flat) * S.noseSweep(s)];
}
export const nose = {
  point: nosePoint, frame: framed(nosePoint), corner: N.flat,
  /** Chart coordinate of the outline point at station x (x > NOSE_X), and of the point at lateral position z. */
  atX: (x) => (x >= N.roundX ? N.flat + NOSE_RUN + (x - N.roundX) : N.flat + NOSE_RUN * ((x - S.NOSE_X) / NOSE_SPAN) ** (1 / N.power)),
  atZ: (z) => { if (z <= N.flat) return z; let lo = N.flat, hi = N.flat + NOSE_RUN; for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (nosePoint(mid)[1] < z) lo = mid; else hi = mid; } return (lo + hi) / 2; },
};

// ---------------------------------------------------------------- tail
const T = S.TAIL, CORNER_A = T.cornerX - T.startX;
const cornerZ = S.beltZ(T.cornerX), slope = (S.beltZ(T.cornerX + 0.5) - S.beltZ(T.cornerX - 0.5));
// the outline's outward normal where the corner begins, and the angle the corner turns through to face straight back
const N0 = [-slope / Math.hypot(1, slope), 1 / Math.hypot(1, slope)], TURN = Math.PI / 2 - Math.atan(-slope);
const CENTRE = [T.cornerX - T.radius * N0[0], cornerZ - T.radius * N0[1]];
const REAR_A = CORNER_A + T.radius * TURN, REAR_Z = CENTRE[1] + T.radius * (-N0[0] * Math.sin(TURN) + N0[1] * Math.cos(TURN));
function tailPoint(a) {
  if (a <= CORNER_A) return [T.startX + a, S.beltZ(T.startX + a)];
  if (a >= REAR_A) return [CENTRE[0] + T.radius, REAR_Z - (a - REAR_A)];
  const f = (a - CORNER_A) / T.radius, c = Math.cos(f), s = Math.sin(f);
  return [CENTRE[0] + T.radius * (N0[0] * c + N0[1] * s), CENTRE[1] + T.radius * (-N0[0] * s + N0[1] * c)];
}
export const tail = {
  point: tailPoint, frame: framed(tailPoint),
  /** Chart coordinates where the corner begins and ends, and of the centre line; the station of the tail's belt. */
  corner: CORNER_A, rear: REAR_A, end: REAR_A + REAR_Z, beltX: CENTRE[0] + T.radius,
  /** Chart coordinate of the point at station x on the body side, and at lateral position z on the square tail. */
  atX: (x) => x - T.startX, atZ: (z) => REAR_A + REAR_Z - z,
};
