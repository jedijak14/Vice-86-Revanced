// Smooth form for a body of compound curves.
//
// The kit's loft (kit/sheet.js makeLoft) joins straight facets with fillets, which is right for a wedge. This car has
// no flat panel and no crease above the sill, so its hull is a spline surface instead:
//   along the car   every control rail is a C2 function of x (smoothRail): a monotone curve through the authored
//                   stations, sampled and rebuilt as a uniform cubic B-spline, so that it can neither overshoot nor
//                   carry a jump of curvature at a station;
//   across the car  each section is a uniform cubic B-spline over the control rails, mirrored about the centre plane
//                   at both ends, so the surface crosses the centre line square and with continuous curvature.
// The surface does not pass through its control rails: it lies inside their polygon, a sixth of the way towards the
// neighbours' mean at each rail. Two rails laid close together make a tight radius, three a crease.
//
// The sheet has the same chart and helpers as the kit's loft (a = x in mm, b = 0 .. rails - 1, sec, solve, arcOf,
// bOf, rows), so kit/panel.js cuts panels from it unchanged.

import { curve } from '../hero/kit/curve.js';
import { makeSheet } from '../hero/kit/sheet.js';

/** Sampling pitch of a smooth rail, mm, and how many times the samples are relaxed (each pass spreads a change of curvature over about one pitch more). */
const RAIL_STEP = 25, RAIL_PASSES = 3;
/** Chords per control span in the table of arc length across a section. */
const ARC_STEPS = 6;
/** Weight of curvature against change of curvature when a rail is faired: without it a rail rings after every bend. */
const FAIR_BEAM = 0.3;

/**
 * Fairs samples at a constant pitch: the smoothest run (least change of curvature, the sum of squared third
 * differences) that stays within `tol` of the samples given. Hand-set stations carry a millimetre or two of noise,
 * which a nearly flat panel shows as a wandering highlight; this takes it out and leaves every intended bend, which
 * is far larger than the tolerance, where it was. (Alternating directions: a banded solve, a clip to the band.)
 */
export function fair(base, tol, rounds = 400, rho = 0.004, mu = FAIR_BEAM) {
  const n = base.length; if (!(tol > 0) || n < 8) return Float64Array.from(base);
  // M = D3' D3 + mu D2' D2 + rho I, banded, half-width 3; Cholesky factor L kept by bands
  const band = Array.from({ length: 4 }, () => new Float64Array(n)), stencil = [-1, 3, -3, 1], beam = [1, -2, 1];
  for (let r = 0; r + 3 < n; r++) for (let i = 0; i < 4; i++) for (let j = 0; j <= i; j++) band[i - j][r + j] += stencil[i] * stencil[j];
  for (let r = 0; r + 2 < n; r++) for (let i = 0; i < 3; i++) for (let j = 0; j <= i; j++) band[i - j][r + j] += mu * beam[i] * beam[j];
  for (let i = 0; i < n; i++) band[0][i] += rho;
  const L = Array.from({ length: 4 }, () => new Float64Array(n));
  for (let j = 0; j < n; j++) {
    let d = band[0][j]; for (let k = 1; k <= 3 && j - k >= 0; k++) d -= L[k][j - k] * L[k][j - k];
    L[0][j] = Math.sqrt(d);
    for (let i = 1; i <= 3 && j + i < n; i++) {
      let v = band[i][j]; for (let k = 1; k + i <= 3 && j - k >= 0; k++) v -= L[k + i][j - k] * L[k][j - k];
      L[i][j] = v / L[0][j];
    }
  }
  const solve = (rhs, out) => {
    for (let i = 0; i < n; i++) { let v = rhs[i]; for (let k = 1; k <= 3 && i - k >= 0; k++) v -= L[k][i - k] * out[i - k]; out[i] = v / L[0][i]; }
    for (let i = n - 1; i >= 0; i--) { let v = out[i]; for (let k = 1; k <= 3 && i + k < n; k++) v -= L[k][i] * out[i + k]; out[i] = v / L[0][i]; }
  };
  const c = Float64Array.from(base), z = Float64Array.from(base), u = new Float64Array(n), rhs = new Float64Array(n);
  for (let it = 0; it < rounds; it++) {
    for (let i = 0; i < n; i++) rhs[i] = rho * (z[i] - u[i]);
    solve(rhs, c);
    for (let i = 0; i < n; i++) { const v = c[i] + u[i]; z[i] = Math.min(base[i] + tol, Math.max(base[i] - tol, v)); u[i] = v - z[i]; }
  }
  return z;
}

/**
 * A C2 function of x through (nearly) the given knots [x, value], defined from the first knot to the last and
 * continued straight beyond them. tol: how far the faired rail may leave the curve through the knots, mm.
 */
export function smoothRail(knots, tol = 0, passes = RAIL_PASSES) {
  const base = curve(knots), x0 = knots[0][0] - 3 * RAIL_STEP, n = Math.ceil((knots[knots.length - 1][0] - knots[0][0]) / RAIL_STEP) + 7;
  let c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = base(x0 + i * RAIL_STEP);
  c = fair(c, tol);
  for (let p = 0; p < passes; p++) {
    const d = new Float64Array(n); d[0] = c[0]; d[n - 1] = c[n - 1];
    for (let i = 1; i < n - 1; i++) d[i] = 0.25 * c[i - 1] + 0.5 * c[i] + 0.25 * c[i + 1];
    c = d;
  }
  return (x) => {
    const u = (x - x0) / RAIL_STEP; let i = Math.floor(u);
    if (i < 1) i = 1; else if (i > n - 3) i = n - 3;
    const t = u - i, t2 = t * t, t3 = t2 * t;
    return ((1 - 3 * t + 3 * t2 - t3) * c[i - 1] + (4 - 6 * t2 + 3 * t3) * c[i] + (1 + 3 * t + 3 * t2 - 3 * t3) * c[i + 1] + t3 * c[i + 2]) / 6;
  };
}

/**
 * The hull sheet.
 *   rails: array of { z(x), y(x) }: control rails from the centre line over the top, down the side and back to the
 *          centre line under the car. The first and last must have z = 0.
 *   place: (x, y, z, out) -> point in the vehicle frame.
 *   seams: chart rows (values of b) that carry long shut lines; the mesh always has a row there.
 */
export function makeSplineHull({ rails, place, seams = [], flip = true }) {
  const n = rails.length - 1, m = n * ARC_STEPS, cache = new Map();
  function section(a) {
    let s = cache.get(a); if (s) return s;
    // control points with one mirrored ghost at each end; q[2 * (k + 1)] is rail k
    const q = new Float64Array(2 * (n + 3)), arc = new Float64Array(m + 1);
    for (let k = 0; k <= n; k++) { q[2 * k + 2] = k === 0 || k === n ? 0 : rails[k].z(a); q[2 * k + 3] = rails[k].y(a); }
    q[0] = -q[4]; q[1] = q[5]; q[2 * n + 4] = -q[2 * n]; q[2 * n + 5] = q[2 * n + 1];
    s = { q, arc }; let px = 0, py = 0;
    for (let i = 0; i <= m; i++) {
      const p = at(s, i / ARC_STEPS, [0, 0]);
      if (i) arc[i] = arc[i - 1] + Math.max(1e-7, Math.hypot(p[0] - px, p[1] - py));
      px = p[0]; py = p[1];
    }
    if (cache.size > 6000) cache.clear(); cache.set(a, s);
    return s;
  }
  function at(s, b, out) {
    let k = Math.floor(b); if (k < 0) k = 0; else if (k > n - 1) k = n - 1;
    const t = b - k, t2 = t * t, t3 = t2 * t, q = s.q, j = 2 * k;
    const w0 = (1 - 3 * t + 3 * t2 - t3) / 6, w1 = (4 - 6 * t2 + 3 * t3) / 6, w2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6, w3 = t3 / 6;
    out[0] = w0 * q[j] + w1 * q[j + 2] + w2 * q[j + 4] + w3 * q[j + 6];
    out[1] = w0 * q[j + 1] + w1 * q[j + 3] + w2 * q[j + 5] + w3 * q[j + 7];
    return out;
  }
  const zy = [0, 0];
  const sheet = makeSheet((a, b, o) => { at(section(a), b, zy); return place(a, zy[1], b === 0 || b === n ? 0 : zy[0], o); }, { flip, ha: 0.5, hb: 2e-3, rows: () => seams.slice() });
  sheet.hs = 0.5;
  /** Section-plane coordinates [z, y] (mm) of a chart point. */
  sheet.sec = (a, b) => at(section(a), b, [0, 0]);
  /** Chart b in [bLo, bHi] where z (which 0) or y (which 1) of the section equals `value`; the coordinate must be monotone over the range. */
  sheet.solve = (a, which, value, bLo, bHi) => {
    const s = section(a), vLo = at(s, bLo, zy)[which], vHi = at(s, bHi, zy)[which], rising = vHi > vLo;
    if ((value - vLo) * (rising ? 1 : -1) <= 0) return bLo; if ((value - vHi) * (rising ? 1 : -1) >= 0) return bHi;
    let lo = bLo, hi = bHi;
    for (let i = 0; i < 44; i++) { const mid = (lo + hi) / 2; if ((at(s, mid, zy)[which] < value) === rising) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  /** Distance across the section from the centre line to b, mm, and its inverse. */
  sheet.arcOf = (a, b) => {
    const arc = section(a).arc, u = Math.min(m, Math.max(0, b * ARC_STEPS)), i = Math.min(m - 1, Math.floor(u));
    return arc[i] + (arc[i + 1] - arc[i]) * (u - i);
  };
  sheet.bOf = (a, d) => {
    const arc = section(a).arc; if (d <= 0) return 0; if (d >= arc[m]) return n;
    let lo = 0, hi = m; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arc[mid] <= d) lo = mid; else hi = mid; }
    return (lo + (d - arc[lo]) / (arc[hi] - arc[lo])) / ARC_STEPS;
  };
  sheet.facets = n;
  return sheet;
}
