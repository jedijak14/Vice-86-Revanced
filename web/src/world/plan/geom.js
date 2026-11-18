// Plane geometry and spatial indexes for the city plan. Everything here works on (x, z) in metres and on
// plain typed arrays, so an index built in the world worker can be posted to the page and used there as is.

/** Signed area of a polygon given as [[x, z], ...]. Negative for the layout's winding (counter-clockwise seen from above). */
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

/** Even-odd point in polygon test. */
export function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Squared distance from a point to a segment; writes the segment parameter into `tOut[0]` when given. */
export function distSqToSegment(px, pz, ax, az, bx, bz, tOut) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  if (tOut) tOut[0] = t;
  const ex = px - ax - t * dx, ez = pz - az - t * dz;
  return ex * ex + ez * ez;
}

/** Proper intersection of segments ab and cd. Returns the parameter along ab in (0, 1), or -1. */
export function segmentIntersection(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1], den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return -1;
  const qx = c[0] - a[0], qz = c[1] - a[1], t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? t : -1;
}

/** True if a simple polygon's edges cross each other. */
export function polygonSelfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segmentIntersection(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n]) >= 0) return true;
  }
  return false;
}

/**
 * Uniform grid of item lists in compressed-row form: cell c holds items[start[c] .. start[c + 1]).
 * `boxes(i, out)` must fill out = [minX, minZ, maxX, maxZ] for item i. Items inside a cell are in ascending order.
 */
export function buildGrid(count, boxes, bounds, cell) {
  const x0 = bounds[0], z0 = bounds[1], nx = Math.max(1, Math.ceil((bounds[2] - x0) / cell)), nz = Math.max(1, Math.ceil((bounds[3] - z0) / cell));
  const counts = new Uint32Array(nx * nz + 1), box = [0, 0, 0, 0];
  const range = (v, o, n) => { const c = Math.floor((v - o) / cell); return c < 0 ? 0 : c >= n ? n - 1 : c; };
  for (let pass = 0, items = null, fill = null; pass < 2; pass++) {
    for (let i = 0; i < count; i++) {
      boxes(i, box);
      if (box[2] < x0 || box[3] < z0 || box[0] > x0 + nx * cell || box[1] > z0 + nz * cell) continue;
      const cx0 = range(box[0], x0, nx), cx1 = range(box[2], x0, nx), cz0 = range(box[1], z0, nz), cz1 = range(box[3], z0, nz);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * nx + cx;
        if (pass === 0) counts[c + 1]++; else items[fill[c]++] = i;
      }
    }
    if (pass === 0) {
      for (let c = 0; c < nx * nz; c++) counts[c + 1] += counts[c];
      items = new Uint32Array(counts[nx * nz]); fill = counts.slice(0, nx * nz);
    } else return { x0, z0, cell, nx, nz, start: counts, items };
  }
  return null;
}

/** Index of the grid cell containing (x, z), clamped to the grid. */
export function gridCell(g, x, z) {
  let cx = Math.floor((x - g.x0) / g.cell), cz = Math.floor((z - g.z0) / g.cell);
  if (cx < 0) cx = 0; else if (cx >= g.nx) cx = g.nx - 1;
  if (cz < 0) cz = 0; else if (cz >= g.nz) cz = g.nz - 1;
  return cz * g.nx + cx;
}

/**
 * A set of closed polygons prepared for fast containment and boundary-distance queries.
 * Data (all plain, transferable): edge end points, the polygon each edge belongs to, a grid of edges that lie
 * within `reach` of each cell, and for every cell the polygon that contains the cell centre (or -1).
 * Polygons are assumed not to overlap each other (first match wins where they do).
 */
export function buildPolygonSet(polygons, bounds, cell, reach) {
  let n = 0; for (const p of polygons) n += p.length;
  const ax = new Float64Array(n), az = new Float64Array(n), bx = new Float64Array(n), bz = new Float64Array(n), owner = new Int32Array(n);
  let k = 0;
  polygons.forEach((poly, pi) => { for (let i = 0; i < poly.length; i++, k++) { const a = poly[i], b = poly[(i + 1) % poly.length]; ax[k] = a[0]; az[k] = a[1]; bx[k] = b[0]; bz[k] = b[1]; owner[k] = pi; } });
  const grid = buildGrid(n, (i, o) => { o[0] = Math.min(ax[i], bx[i]) - reach; o[1] = Math.min(az[i], bz[i]) - reach; o[2] = Math.max(ax[i], bx[i]) + reach; o[3] = Math.max(az[i], bz[i]) + reach; }, bounds, cell);
  // Which polygon contains each cell centre: scan-line fill per polygon, so start-up stays fast for large extents.
  // Two slots per cell, because a few layout polygons overlap (crossing runways); a third overlap is not tracked.
  const centre = new Int16Array(grid.nx * grid.nz).fill(-1), centre2 = new Int16Array(grid.nx * grid.nz).fill(-1);
  polygons.forEach((poly, pi) => {
    let minZ = Infinity, maxZ = -Infinity; for (const p of poly) { if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
    const r0 = Math.max(0, Math.floor((minZ - grid.z0) / cell - 0.5)), r1 = Math.min(grid.nz - 1, Math.ceil((maxZ - grid.z0) / cell));
    const xs = [];
    for (let r = r0; r <= r1; r++) {
      const z = grid.z0 + (r + 0.5) * cell; xs.length = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > z) !== (b[1] > z)) xs.push((b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]);
      }
      xs.sort((p, q) => p - q);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const c0 = Math.max(0, Math.ceil((xs[q] - grid.x0) / cell - 0.5)), c1 = Math.min(grid.nx - 1, Math.floor((xs[q + 1] - grid.x0) / cell - 0.5));
        for (let c = c0; c <= c1; c++) { const k = r * grid.nx + c; if (centre[k] < 0) centre[k] = pi; else if (centre2[k] < 0) centre2[k] = pi; }
      }
    }
  });
  return { ax, az, bx, bz, owner, grid, centre, centre2, reach, count: polygons.length };
}

const _t = [0];
/**
 * Query a polygon set. Returns the index of the polygon containing (x, z) or -1, and writes into `out`:
 * out.dist = distance to the nearest boundary edge within reach (else `reach`), out.edge = that edge or -1,
 * out.dist2 / out.edge2 = the same restricted to edges whose entry in `set.flag` (a Uint8Array, optional) is set.
 */
export function queryPolygonSet(set, x, z, out) {
  const g = set.grid, c = gridCell(g, x, z), s = g.start[c], e = g.start[c + 1], items = g.items, flag = set.flag;
  // Containment: the polygon holding the cell centre, corrected by every boundary crossed on the way to the query point.
  let inside = set.centre[c], best = set.reach * set.reach, bestI = -1, best2 = best, best2I = -1;
  if (e > s) {
    const cx = g.x0 + ((c % g.nx) + 0.5) * g.cell, cz = g.z0 + (Math.floor(c / g.nx) + 0.5) * g.cell;
    let flips = null;
    for (let q = s; q < e; q++) {
      const i = items[q], ax = set.ax[i], az = set.az[i], bx = set.bx[i], bz = set.bz[i];
      const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d2 = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      if ((d1 > 0) !== (d2 > 0)) {
        const d3 = (x - cx) * (az - cz) - (z - cz) * (ax - cx), d4 = (x - cx) * (bz - cz) - (z - cz) * (bx - cx);
        if ((d3 > 0) !== (d4 > 0)) (flips || (flips = [])).push(set.owner[i]);
      }
      const d = distSqToSegment(x, z, ax, az, bx, bz);
      if (d < best) { best = d; bestI = i; }
      if (flag && flag[i] && d < best2) { best2 = d; best2I = i; }
    }
    if (flips) {
      // An odd number of crossings of one polygon's boundary toggles membership of that polygon.
      let second = set.centre2[c];
      for (let k = 0; k < flips.length; k++) {
        const p = flips[k]; let odd = 0, firstAt = k;
        for (let m = 0; m < flips.length; m++) if (flips[m] === p) { odd ^= 1; if (m < firstAt) firstAt = m; }
        if (!odd || firstAt !== k) continue;
        if (inside === p) { inside = second; second = -1; } else if (second === p) second = -1; else if (inside < 0) inside = p; else second = p;
      }
    }
  }
  out.dist = Math.sqrt(best); out.edge = bestI; out.dist2 = Math.sqrt(best2); out.edge2 = best2I;
  return inside;
}

/** Cumulative lengths of a polyline given as flat [x0, z0, x1, z1, ...]. */
export function polylineStations(pts) {
  const n = pts.length / 2, s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  return s;
}

/**
 * Centripetal Catmull-Rom through `pts` ([[x, z], ...]), sampled so that no step is longer than `maxStep` and no
 * step turns more than `maxTurn` radians. `before` / `after` are optional phantom points that set the end tangents.
 * Returns a flat Float64Array of x, z pairs starting and ending exactly on the first and last input points.
 */
export function smoothPolyline(pts, maxStep, maxTurn, before = null, after = null) {
  const n = pts.length;
  if (n < 2) return new Float64Array(pts.flat());
  const P = (i) => (i < 0 ? (before || [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]]) : i >= n ? (after || [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]]) : pts[i]);
  const out = [pts[0][0], pts[0][1]];
  for (let i = 0; i + 1 < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const d01 = Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])) || 1e-3, d12 = Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])) || 1e-3, d23 = Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1])) || 1e-3;
    // Tangents of the non-uniform spline, scaled to the middle span.
    const t1x = ((p1[0] - p0[0]) / d01 - (p2[0] - p0[0]) / (d01 + d12) + (p2[0] - p1[0]) / d12) * d12, t1z = ((p1[1] - p0[1]) / d01 - (p2[1] - p0[1]) / (d01 + d12) + (p2[1] - p1[1]) / d12) * d12;
    const t2x = ((p2[0] - p1[0]) / d12 - (p3[0] - p1[0]) / (d12 + d23) + (p3[0] - p2[0]) / d23) * d12, t2z = ((p2[1] - p1[1]) / d12 - (p3[1] - p1[1]) / (d12 + d23) + (p3[1] - p2[1]) / d23) * d12;
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const a1 = Math.atan2(t1z, t1x), a2 = Math.atan2(t2z, t2x); let turn = Math.abs(a2 - a1); if (turn > Math.PI) turn = 2 * Math.PI - turn;
    const steps = Math.max(1, Math.ceil(len / maxStep), Math.ceil(turn * 1.5 / maxTurn));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t, h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push(k === steps ? p2[0] : h00 * p1[0] + h10 * t1x + h01 * p2[0] + h11 * t2x, k === steps ? p2[1] : h00 * p1[1] + h10 * t1z + h01 * p2[1] + h11 * t2z);
    }
  }
  return new Float64Array(out);
}

/** Separating-axis overlap test for two oriented rectangles [cx, cz, halfW, halfD, cos, sin] (local X = (cos, -sin), local Z = (sin, cos)). */
export function rectsOverlap(a, b, gap = 0) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const axes = [[a[4], -a[5]], [a[5], a[4]], [b[4], -b[5]], [b[5], b[4]]];
  for (let i = 0; i < 4; i++) {
    const ux = axes[i][0], uz = axes[i][1];
    const ra = a[2] * Math.abs(ux * a[4] - uz * a[5]) + a[3] * Math.abs(ux * a[5] + uz * a[4]);
    const rb = b[2] * Math.abs(ux * b[4] - uz * b[5]) + b[3] * Math.abs(ux * b[5] + uz * b[4]);
    if (Math.abs(dx * ux + dz * uz) > ra + rb + gap) return false;
  }
  return true;
}
