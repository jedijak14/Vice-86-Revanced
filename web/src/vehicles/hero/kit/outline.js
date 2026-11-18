// Plane outlines (wheel arches, ducts, lamp shapes): rounding corners, offsetting and walking along a polyline.

/**
 * Round the corners of a polyline. pts: [[x, y]...]; radii: one per point (0 keeps the corner; end points of an open
 * line are kept). closed: treat as a loop. Returns a dense polyline.
 */
export function roundCorners(pts, radii, { closed = false, segs = 6 } = {}) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], r = typeof radii === 'number' ? radii : radii[i] || 0;
    if (r <= 0 || (!closed && (i === 0 || i === n - 1))) { out.push([p[0], p[1]]); continue; }
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    let ux = a[0] - p[0], uy = a[1] - p[1], vx = b[0] - p[0], vy = b[1] - p[1];
    const ul = Math.hypot(ux, uy), vl = Math.hypot(vx, vy); ux /= ul; uy /= ul; vx /= vl; vy /= vl;
    const th = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    if (th > Math.PI - 0.01) { out.push([p[0], p[1]]); continue; }
    const tn = Math.tan(th / 2), set = Math.min(r / tn, 0.48 * ul, 0.48 * vl), rr = set * tn, cd = rr / Math.sin(th / 2);
    let bx = ux + vx, by = uy + vy; const bl = Math.hypot(bx, by); bx /= bl; by /= bl;
    const cx = p[0] + bx * cd, cy = p[1] + by * cd, a0 = Math.atan2(p[1] + uy * set - cy, p[0] + ux * set - cx);
    let sweep = Math.atan2(p[1] + vy * set - cy, p[0] + vx * set - cx) - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI; while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const m = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 2) * segs));
    for (let k = 0; k <= m; k++) { const t = a0 + sweep * k / m; out.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr]); }
  }
  return out;
}

/** Unit left normals of a polyline at each point (average of the neighbouring segments). */
export function leftNormals(pts, closed = false) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[closed ? (i + n - 1) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return [-ty / l, tx / l];
  });
}

/** Move a polyline sideways by d (positive = to the left of the direction of travel), with mitred corners. */
export function offset(pts, d, closed = false) {
  const n = pts.length;
  return pts.map((p, i) => {
    const hasA = closed || i > 0, hasB = closed || i < n - 1, a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    let n0 = null, n1 = null;
    if (hasA) { const tx = p[0] - a[0], ty = p[1] - a[1], l = Math.hypot(tx, ty) || 1; n0 = [-ty / l, tx / l]; }
    if (hasB) { const tx = b[0] - p[0], ty = b[1] - p[1], l = Math.hypot(tx, ty) || 1; n1 = [-ty / l, tx / l]; }
    if (!n0) n0 = n1; if (!n1) n1 = n0;
    const k = d / Math.max(0.3, 1 + n0[0] * n1[0] + n0[1] * n1[1]);
    return [p[0] + (n0[0] + n1[0]) * k, p[1] + (n0[1] + n1[1]) * k];
  });
}

/** Points of a circular arc from angle a0 to a1 (radians, counter-clockwise positive), inclusive. */
export function arc(cx, cy, r, a0, a1, segs) {
  const out = []; for (let i = 0; i <= segs; i++) { const t = a0 + (a1 - a0) * i / segs; out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]); } return out;
}

/** Subdivide the segments of a polyline so that none is longer than `spacing`. Existing points are kept. */
export function densify(pts, spacing) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]), m = Math.max(1, Math.ceil(l / spacing));
    for (let k = 1; k <= m; k++) out.push([a[0] + (b[0] - a[0]) * k / m, a[1] + (b[1] - a[1]) * k / m]);
  }
  return out;
}

/** Whether point p lies inside the closed polygon `pts` (even-odd rule; a point on the outline may fall either way). */
export function contains(pts, p) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < a[0] + (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
}
