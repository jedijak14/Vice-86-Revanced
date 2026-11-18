// Meshing helpers for the wheels and lamps: surfaces whose points and normals are known exactly are written as
// grids of prepared vertices, so that every fillet and every round edge shades as the curve it is.
// Working unit here is the millimetre; positions are scaled to metres as they are written into the builder.

export const MM = 0.001, TAU = Math.PI * 2;

const unit3 = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

/**
 * Write a grid of prepared vertices and stitch it. rows[i][j] = [x, y, z, nx, ny, nz, u, v] with positions in
 * millimetres. The visible side is (along j) x (along i); `flip` reverses it. closed: column 0 follows the last
 * column. m: optional placement (column-major 4x4 in metres, rigid). Quads that collapse to a point on one side
 * (a pole) become single triangles. A ninth element, where present, is the vertex's baked occlusion (0..1), and a
 * tenth to twelfth its colour (sRGB).
 */
export function skin(mb, rows, { closed = false, flip = false, m = null } = {}) {
  const n = rows[0].length, base = mb.count;
  for (const row of rows) for (const p of row) {
    const x = p[0] * MM, y = p[1] * MM, z = p[2] * MM;
    if (p.length > 8) mb.occlusion(p[8]);
    if (p.length > 11) mb.color(p[9], p[10], p[11]);
    if (m) mb.vertex(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14], m[0] * p[3] + m[4] * p[4] + m[8] * p[5], m[1] * p[3] + m[5] * p[4] + m[9] * p[5], m[2] * p[3] + m[6] * p[4] + m[10] * p[5], p[6] || 0, p[7] || 0);
    else mb.vertex(x, y, z, p[3], p[4], p[5], p[6] || 0, p[7] || 0);
  }
  const same = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 1e-6;
  const cols = closed ? n : n - 1;
  for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < cols; j++) {
    const j1 = (j + 1) % n, a = base + i * n + j, b = base + i * n + j1, c = b + n, d = a + n;
    const top = same(rows[i][j], rows[i][j1]), bottom = same(rows[i + 1][j], rows[i + 1][j1]);
    if (top && bottom) continue;
    if (top) { if (flip) mb.tri(a, d, c); else mb.tri(a, c, d); continue; }
    if (bottom) { if (flip) mb.tri(a, d, b); else mb.tri(a, b, d); continue; }
    if (flip) mb.quad(a, d, c, b); else mb.quad(a, b, c, d);
  }
  return base;
}

/**
 * Unit normals of a plane polyline for both sides of every point: left of the direction of travel. A corner sharper
 * than `crease` degrees keeps a normal for each of its two segments; gentler joints share one. Returns [before, after]
 * arrays of [nx, ny].
 */
export function polylineNormals(pts, crease = 40, closed = false) {
  const n = pts.length, seg = [], cosC = Math.cos(crease * Math.PI / 180);
  for (let i = 0; i < (closed ? n : n - 1); i++) { const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; seg.push([-(b[1] - a[1]) / l, (b[0] - a[0]) / l]); }
  const before = [], after = [];
  for (let i = 0; i < n; i++) {
    const p = closed ? seg[(i + n - 1) % n] : seg[Math.max(0, i - 1)], q = closed ? seg[i] : seg[Math.min(n - 2, i)];
    if (p[0] * q[0] + p[1] * q[1] >= cosC) { const l = Math.hypot(p[0] + q[0], p[1] + q[1]) || 1, s = [(p[0] + q[0]) / l, (p[1] + q[1]) / l]; before.push(s); after.push(s); } else { before.push(p); after.push(q); }
  }
  return [before, after];
}

/**
 * Surface of revolution about the X axis with exact normals. profile: [[x, radius], ...] in millimetres, ordered so
 * the visible side is on the left when drawn with +X to the right and the radius upwards (an outer skin runs towards
 * +X, a bore runs back towards -X). Round edges are authored as arcs; joints sharper than `crease` stay hard.
 * opts: { segs, from, to (radians), crease, m (placement), uv: (x, r, turn, i) => [u, v] (default: radius in metres
 * and the turn 0..1), style: (i) => set the builder state for the band that starts at point i, or false to skip it }.
 */
export function turn(mb, profile, opts = {}) {
  const segs = opts.segs || 64, a0 = opts.from || 0, a1 = opts.to ?? TAU, uv = opts.uv || ((x, r, t) => [r * MM, t]);
  const [before, after] = polylineNormals(profile, opts.crease ?? 40);
  const cs = []; for (let j = 0; j <= segs; j++) { const a = a0 + (a1 - a0) * j / segs; cs.push([Math.cos(a), Math.sin(a), j / segs * (a1 - a0) / TAU + a0 / TAU]); }
  for (let i = 0; i < profile.length - 1; i++) {
    if (opts.style && opts.style(i) === false) continue;
    const rows = [];
    for (const [p, nrm, k] of [[profile[i], after[i], i], [profile[i + 1], before[i + 1], i + 1]]) {
      rows.push(cs.map(([c, s, t]) => { const q = uv(p[0], p[1], t, k); return [p[0], p[1] * c, p[1] * s, nrm[0], nrm[1] * c, nrm[1] * s, q[0], q[1]]; }));
    }
    skin(mb, rows, { m: opts.m });
  }
}

/**
 * A closed plane section swept through an arc about the X axis: brake calipers, balance weights, shields.
 * section: [[x, radius], ...] in millimetres, counter-clockwise when drawn with +X right and the radius up (so its
 * outside is on the right of travel). The ends are closed with flat caps set in by `bevel` over a short chamfer.
 * opts: { steps, crease, bevel, m, uv }.
 */
export function arcSweep(mb, section, a0, a1, opts = {}) {
  const steps = opts.steps || 8, bevel = opts.bevel ?? 1.2, n = section.length, uv = opts.uv || ((x, r, t) => [r * MM, t]);
  const loop = section.slice().reverse();                              // visible side on the left, as turn() wants
  const [before, after] = polylineNormals(loop, opts.crease ?? 40, true);
  let cx = 0, cr = 0; for (const p of loop) { cx += p[0] / n; cr += p[1] / n; }
  const inset = (p, d) => { const l = Math.hypot(p[0] - cx, p[1] - cr) || 1, k = Math.max(0, 1 - d / l); return [cx + (p[0] - cx) * k, cr + (p[1] - cr) * k]; };
  const dir = Math.sign(a1 - a0) || 1, da = bevel / Math.max(cr, 1) * dir;       // the chamfer's length as an angle
  // stations along the arc: [angle, inset, lean] where lean tips the normal towards the cap on the chamfer rows
  const stations = [[a0, bevel, -0.7], [a0 + da, 0, -0.25]];
  for (let s = 1; s < steps; s++) stations.push([a0 + da + (a1 - a0 - 2 * da) * s / steps, 0, 0]);
  stations.push([a1 - da, 0, 0.25], [a1, bevel, 0.7]);
  const flip = dir < 0;
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n, rows = [];
    for (const [k, nrm] of [[i, after[i]], [i1, before[i1]]]) {
      rows.push(stations.map(([a, d, lean]) => {
        const p = d ? inset(loop[k], d) : loop[k], c = Math.cos(a), s = Math.sin(a), q = uv(p[0], p[1], a / TAU);
        // the tangent direction of the sweep at this angle is (0, -s, c)
        const N = unit3(nrm[0], nrm[1] * c - lean * dir * s, nrm[1] * s + lean * dir * c);
        return [p[0], p[1] * c, p[1] * s, N[0], N[1], N[2], q[0], q[1]];
      }));
    }
    skin(mb, rows, { m: opts.m, flip });
  }
  // caps: fans about the section's centre
  for (const [a, sign] of [[a0, -1], [a1, 1]]) {
    const c = Math.cos(a), s = Math.sin(a), N = [0, -s * sign * dir, c * sign * dir];
    const rim = loop.map((p) => { const q = inset(p, bevel), t = uv(q[0], q[1], a / TAU); return [q[0], q[1] * c, q[1] * s, N[0], N[1], N[2], t[0], t[1]]; });
    const t = uv(cx, cr, a / TAU), centre = rim.map(() => [cx, cr * c, cr * s, N[0], N[1], N[2], t[0], t[1]]);
    skin(mb, [centre, rim], { closed: true, m: opts.m, flip: (sign > 0) === flip });
  }
}

/** Round the corners of a millimetre polyline with arcs fine enough to shade smoothly (see kit/outline roundCorners). */
export function fillet(pts, radii, segs = 4) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], r = typeof radii === 'number' ? radii : radii[i] || 0;
    if (r <= 0 || i === 0 || i === n - 1) { out.push([p[0], p[1]]); continue; }
    const a = pts[i - 1], b = pts[i + 1];
    let ux = a[0] - p[0], uy = a[1] - p[1], vx = b[0] - p[0], vy = b[1] - p[1];
    const ul = Math.hypot(ux, uy), vl = Math.hypot(vx, vy); ux /= ul; uy /= ul; vx /= vl; vy /= vl;
    const th = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    if (th > Math.PI - 0.02) { out.push([p[0], p[1]]); continue; }
    const tn = Math.tan(th / 2), set = Math.min(r / tn, 0.49 * ul, 0.49 * vl), rr = set * tn, cd = rr / Math.sin(th / 2);
    let bx = ux + vx, by = uy + vy; const bl = Math.hypot(bx, by); bx /= bl; by /= bl;
    const cx = p[0] + bx * cd, cy = p[1] + by * cd, s0 = Math.atan2(p[1] + uy * set - cy, p[0] + ux * set - cx);
    let sweep = Math.atan2(p[1] + vy * set - cy, p[0] + vx * set - cx) - s0;
    while (sweep > Math.PI) sweep -= TAU; while (sweep < -Math.PI) sweep += TAU;
    const m = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 2) * segs));
    for (let k = 0; k <= m; k++) { const t = s0 + sweep * k / m; out.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr]); }
  }
  return out;
}

/**
 * Fill in the normals of a grid of prepared vertices from the positions of their neighbours, for surfaces that are
 * easier to place than to differentiate. The normal points to (along j) x (along i), as skin() draws it. Rows listed
 * in `keep` are left alone (their normals are known exactly, where the surface joins another).
 */
export function gridNormals(rows, { closed = false, keep = [] } = {}) {
  const ni = rows.length, nj = rows[0].length, out = rows.map((r) => r.map((p) => p.slice()));
  for (let i = 0; i < ni; i++) {
    if (keep.includes(i)) continue;
    for (let j = 0; j < nj; j++) {
      const a = rows[Math.max(0, i - 1)][j], b = rows[Math.min(ni - 1, i + 1)][j];
      const c = rows[i][closed ? (j + nj - 1) % nj : Math.max(0, j - 1)], d = rows[i][closed ? (j + 1) % nj : Math.min(nj - 1, j + 1)];
      const ix = b[0] - a[0], iy = b[1] - a[1], iz = b[2] - a[2], jx = d[0] - c[0], jy = d[1] - c[1], jz = d[2] - c[2];
      const n = unit3(jy * iz - jz * iy, jz * ix - jx * iz, jx * iy - jy * ix), p = out[i][j];
      p[3] = n[0]; p[4] = n[1]; p[5] = n[2];
    }
  }
  return out;
}

/**
 * A flat facet of three or four corners [x, y, z, u, v] (millimetres), wound and lit to face `towards`.
 * Returns the index of its first vertex.
 */
export function facet(mb, corners, towards) {
  const [a, b] = corners, e = corners[corners.length - 1];
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = e[0] - a[0], vy = e[1] - a[1], vz = e[2] - a[2];
  let n = unit3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  const back = n[0] * towards[0] + n[1] * towards[1] + n[2] * towards[2] < 0; if (back) n = [-n[0], -n[1], -n[2]];
  const i = mb.count; for (const p of corners) mb.vertex(p[0] * MM, p[1] * MM, p[2] * MM, n[0], n[1], n[2], p[3] || 0, p[4] || 0);
  if (corners.length === 3) { if (back) mb.tri(i, i + 2, i + 1); else mb.tri(i, i + 1, i + 2); }
  else if (back) mb.quad(i, i + 3, i + 2, i + 1); else mb.quad(i, i + 1, i + 2, i + 3);
  return i;
}

/** A round bar from a to b (millimetres) of radius r, with flat ends. opts: { segs, r1 (radius at b), caps } */
export function bar(mb, a, b, r, opts = {}) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]), x = [d[0] / L, d[1] / L, d[2] / L];
  const h = Math.abs(x[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1], k = h[0] * x[0] + h[1] * x[1] + h[2] * x[2];
  const y = unit3(h[0] - x[0] * k, h[1] - x[1] * k, h[2] - x[2] * k), z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const m = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, a[0] * MM, a[1] * MM, a[2] * MM, 1], r1 = opts.r1 ?? r;
  const profile = opts.caps === false ? [[0, r], [L, r1]] : [[0, 0], [0, r], [L, r1], [L, 0]];
  turn(mb, profile, { segs: opts.segs || 10, m, crease: 30 });
}
