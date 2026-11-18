// One-dimensional design curves used to describe how every rail of the car changes along its length.
// A curve is authored as knots [t, value] or [t, value, KINK]. Between knots it is a monotone cubic
// (no overshoot, no wobble: a flat panel stays flat), and a knot flagged KINK keeps a hard change of slope
// (the cowl, the screen header, the tail edge).

export const KINK = 1;

/** Build a curve from knots sorted by ascending t. Returns f(t), clamped to linear extension outside the range. */
export function curve(knots) {
  const n = knots.length, t = new Float64Array(n), v = new Float64Array(n), mL = new Float64Array(n), mR = new Float64Array(n);
  for (let i = 0; i < n; i++) { t[i] = knots[i][0]; v[i] = knots[i][1]; }
  const sec = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) sec[i] = (v[i + 1] - v[i]) / (t[i + 1] - t[i]);
  for (let i = 0; i < n; i++) {
    const kink = knots[i][2] === KINK, a = i > 0 ? sec[i - 1] : sec[0], b = i < n - 1 ? sec[i] : sec[n - 2];
    if (kink || i === 0 || i === n - 1) { mL[i] = a; mR[i] = b; continue; }
    // weighted harmonic mean of the neighbouring secants: shape preserving
    if (a * b <= 0) { mL[i] = mR[i] = 0; continue; }
    const h0 = t[i] - t[i - 1], h1 = t[i + 1] - t[i], w0 = 2 * h1 + h0, w1 = h1 + 2 * h0;
    mL[i] = mR[i] = (w0 + w1) / (w0 / a + w1 / b);
  }
  return (x) => {
    if (x <= t[0]) return v[0] + (x - t[0]) * mR[0];
    if (x >= t[n - 1]) return v[n - 1] + (x - t[n - 1]) * mL[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= x) lo = mid; else hi = mid; }
    const h = t[hi] - t[lo], s = (x - t[lo]) / h, s2 = s * s, s3 = s2 * s;
    return v[lo] * (2 * s3 - 3 * s2 + 1) + v[hi] * (3 * s2 - 2 * s3) + h * (mR[lo] * (s3 - 2 * s2 + s) + mL[hi] * (s3 - s2));
  };
}

/** Straight line through two points, as a curve. */
export const line = (t0, v0, t1, v1) => (x) => v0 + (v1 - v0) * (x - t0) / (t1 - t0);
