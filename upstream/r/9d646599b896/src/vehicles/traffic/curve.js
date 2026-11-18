// Planar curves used to describe vehicle outlines (side elevations) and openings (windows, arches, grilles).
//
// A Path2 is a densely sampled curve in a two-dimensional parameter plane (a, b), parameterised by arc
// length. Outlines are authored as a few control vertices with a corner size each; every corner is replaced
// by a quintic blend whose curvature starts and ends at zero, so highlights flow through corners without
// the visible break that a circular arc glued to a straight line produces.

const DENSE_PER_CORNER = 28;

export class Path2 {
  /**
   * @param {number[]} a  first coordinate of every dense sample
   * @param {number[]} b  second coordinate
   * @param {boolean} closed  true when the last sample connects back to the first
   * @param {Object<string, {start:number, mid:number, end:number}>} marks  arc-length positions of tagged corners
   */
  constructor(a, b, closed = false, marks = {}) {
    const n = a.length;
    this.a = Float64Array.from(a); this.b = Float64Array.from(b); this.closed = closed; this.marks = marks;
    this.s = new Float64Array(n + (closed ? 1 : 0));
    for (let i = 1; i < n; i++) this.s[i] = this.s[i - 1] + Math.hypot(a[i] - a[i - 1], b[i] - b[i - 1]);
    if (closed) this.s[n] = this.s[n - 1] + Math.hypot(a[0] - a[n - 1], b[0] - b[n - 1]);
    this.n = n; this.length = this.s[this.s.length - 1];
    // Per-sample unit tangents (central differences) so that tangent(s) is continuous.
    this.ta = new Float64Array(n); this.tb = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const i0 = closed ? (i + n - 1) % n : Math.max(0, i - 1), i1 = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      const da = a[i1] - a[i0], db = b[i1] - b[i0], l = Math.hypot(da, db) || 1;
      this.ta[i] = da / l; this.tb[i] = db / l;
    }
    let area = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += a[i] * b[j] - a[j] * b[i]; }
    /** +1 when the curve runs counter-clockwise in (a, b); the outward normal is the tangent turned right. */
    this.orientation = area >= 0 ? 1 : -1;
  }

  _wrap(s) { if (!this.closed) return s < 0 ? 0 : s > this.length ? this.length : s; const L = this.length; return ((s % L) + L) % L; }

  /** Index of the dense segment containing arc length s, and the fraction within it. */
  _locate(s) {
    s = this._wrap(s);
    const S = this.s; let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
    const d = S[hi] - S[lo];
    return [lo, d > 0 ? (s - S[lo]) / d : 0];
  }

  /** Point at arc length s. Writes [a, b] into out. */
  at(s, out = [0, 0]) {
    const [i, f] = this._locate(s), j = (i + 1) % this.n;
    out[0] = this.a[i] + (this.a[j] - this.a[i]) * f; out[1] = this.b[i] + (this.b[j] - this.b[i]) * f; return out;
  }

  /** Unit tangent at arc length s. */
  tangent(s, out = [0, 0]) {
    const [i, f] = this._locate(s), j = (i + 1) % this.n;
    const x = this.ta[i] + (this.ta[j] - this.ta[i]) * f, y = this.tb[i] + (this.tb[j] - this.tb[i]) * f, l = Math.hypot(x, y) || 1;
    out[0] = x / l; out[1] = y / l; return out;
  }

  /** Unit normal pointing out of a closed curve (or to the right of travel times `orientation` on an open one). */
  normal(s, out = [0, 0]) { this.tangent(s, out); const x = out[0]; out[0] = out[1] * this.orientation; out[1] = -x * this.orientation; return out; }

  /**
   * Sample positions between s0 and s1 (s1 > s0; may exceed `length` on closed curves) such that no step is
   * longer than maxLen and no step turns more than maxAngle radians. Returns arc lengths including both ends.
   * With `exact` the number of steps is exactly `count`; otherwise `count` is a minimum. Steps are placed so
   * that each carries the same share of length and turning, which packs samples into corners.
   */
  adaptive(s0, s1, maxLen, maxAngle, count = 1, exact = false) {
    const steps = Math.max(8, Math.ceil((s1 - s0) / 0.004)), cost = new Float64Array(steps + 1), t0 = [0, 0], t1 = [0, 0];
    this.tangent(s0, t0);
    for (let k = 1; k <= steps; k++) {
      this.tangent(s0 + (s1 - s0) * k / steps, t1);
      const turn = Math.abs(Math.atan2(t0[0] * t1[1] - t0[1] * t1[0], t0[0] * t1[0] + t0[1] * t1[1]));
      cost[k] = cost[k - 1] + Math.max((s1 - s0) / steps / maxLen, turn / maxAngle);
      t0[0] = t1[0]; t0[1] = t1[1];
    }
    const total = cost[steps], n = exact ? count : Math.max(count, Math.ceil(total - 1e-6)), out = [s0];
    let k = 1;
    for (let i = 1; i < n; i++) {
      const want = total * i / n;
      while (k < steps && cost[k] < want) k++;
      const f = (want - cost[k - 1]) / Math.max(1e-12, cost[k] - cost[k - 1]);
      out.push(s0 + (s1 - s0) * (k - 1 + f) / steps);
    }
    out.push(s1);
    return out;
  }

  /** Number of steps adaptive() would use for a range. */
  cost(s0, s1, maxLen, maxAngle) { return this.adaptive(s0, s1, maxLen, maxAngle).length - 1; }

  /** Exactly `count` steps between s0 and s1, distributed like adaptive(). */
  spread(s0, s1, count, maxLen, maxAngle) { return this.adaptive(s0, s1, maxLen, maxAngle, count, true); }

  /** Arc length in [s0, s1] where fn(a, b) changes sign (bisection; fn must have one crossing in the range). */
  crossing(fn, s0, s1) {
    const p = [0, 0]; let f0 = fn(...this.at(s0, p));
    for (let k = 0; k < 44; k++) {
      const m = (s0 + s1) / 2, fm = fn(...this.at(m, p));
      if ((fm > 0) === (f0 > 0)) { s0 = m; f0 = fm; } else s1 = m;
    }
    return (s0 + s1) / 2;
  }
}

function quintic(P, t, out) {
  const u = 1 - t, b0 = u * u * u * u * u, b1 = 5 * u * u * u * u * t, b2 = 10 * u * u * u * t * t, b3 = 10 * u * u * t * t * t, b4 = 5 * u * t * t * t * t, b5 = t * t * t * t * t;
  out[0] = b0 * P[0][0] + b1 * P[1][0] + b2 * P[2][0] + b3 * P[3][0] + b4 * P[4][0] + b5 * P[5][0];
  out[1] = b0 * P[0][1] + b1 * P[1][1] + b2 * P[2][1] + b3 * P[3][1] + b4 * P[4][1] + b5 * P[5][1];
  return out;
}

/**
 * Build a Path2 from control vertices [{ a, b, r, tag }].
 * `r` is the nominal corner radius in metres (0 = sharp). The corner blend starts and ends at the points
 * where a circular fillet of that radius would touch the two edges, but its curvature rises smoothly from zero.
 * Adjacent corners never overlap: each is limited to just under half of the edges it sits on, so a run of
 * vertices with large radii gives one flowing spline-like curve (used for roof and bonnet lines).
 * Tagged vertices record where their corner starts, peaks and ends (arc length) in `path.marks[tag]`.
 */
export function roundedPath(verts, closed = true) {
  const n = verts.length, A = [], B = [], pending = [], p = [0, 0];
  const get = (i) => verts[((i % n) + n) % n];
  const trim = new Float64Array(n), dir = [];
  for (let i = 0; i < n; i++) {
    const v = get(i), w = get(i + 1), l = Math.hypot(w.a - v.a, w.b - v.b) || 1e-9;
    dir.push([(w.a - v.a) / l, (w.b - v.b) / l, l]);
  }
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const din = dir[(i + n - 1) % n], dout = dir[i], cosT = din[0] * dout[0] + din[1] * dout[1];
    const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
    const r = get(i).r || 0;
    trim[i] = theta < 1e-4 ? 0 : Math.min(r * Math.tan(theta / 2), din[2] * 0.48, dout[2] * 0.48);
  }
  for (let i = 0; i < n; i++) {
    const v = get(i), d = trim[i];
    const din = dir[(i + n - 1) % n], dout = dir[i], h = d * 0.42;
    if (d <= 1e-6) {
      // A sharp vertex is bracketed by two samples a millimetre away, so the interpolated tangent turns
      // within that millimetre instead of drifting along the whole of the straight edges on either side.
      const e = 1e-3, before = closed || i > 0, after = closed || i < n - 1;
      if (before && din[2] > 4 * e) { A.push(v.a - din[0] * e); B.push(v.b - din[1] * e); }
      if (v.tag) pending.push([v.tag, A.length, A.length, A.length]);
      A.push(v.a); B.push(v.b);
      if (after && dout[2] > 4 * e) { A.push(v.a + dout[0] * e); B.push(v.b + dout[1] * e); }
      continue;
    }
    const P0 = [v.a - din[0] * d, v.b - din[1] * d], P5 = [v.a + dout[0] * d, v.b + dout[1] * d];
    const C = [P0, [P0[0] + din[0] * h, P0[1] + din[1] * h], [P0[0] + din[0] * 2 * h, P0[1] + din[1] * 2 * h],
      [P5[0] - dout[0] * 2 * h, P5[1] - dout[1] * 2 * h], [P5[0] - dout[0] * h, P5[1] - dout[1] * h], P5];
    const first = A.length;
    for (let k = 0; k <= DENSE_PER_CORNER; k++) { quintic(C, k / DENSE_PER_CORNER, p); A.push(p[0]); B.push(p[1]); }
    if (v.tag) pending.push([v.tag, first, first + DENSE_PER_CORNER / 2, first + DENSE_PER_CORNER]);
  }
  const path = new Path2(A, B, closed);
  for (const [tag, i0, i1, i2] of pending) path.marks[tag] = { start: path.s[i0], mid: path.s[i1], end: path.s[i2] };
  return path;
}

/**
 * Closed rounded quadrilateral through four corners given in order, as a Path2. Used for window openings,
 * lamp pockets and grilles. `r` may be a number or four numbers (one per corner).
 */
export function roundedQuad(c0, c1, c2, c3, r) {
  const rr = typeof r === 'number' ? [r, r, r, r] : r;
  return roundedPath([c0, c1, c2, c3].map((c, i) => ({ a: c[0], b: c[1], r: rr[i], tag: 'c' + i })), true);
}

/** Split [0, len] into steps no longer than maxStep; returns fractions 0..1 including both ends. */
export function fractions(len, maxStep, minCount = 1) {
  const n = Math.max(minCount, Math.ceil(len / maxStep - 1e-6)), out = [];
  for (let i = 0; i <= n; i++) out.push(i / n);
  return out;
}
