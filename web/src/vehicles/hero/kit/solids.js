// Small solid generators for everything that is not coachwork: lamps, trim, interior, wheels.
// All of them write into a MeshBuilder with its current family, material and colour, and take a column-major
// 4x4 placement matrix (rigid, optionally mirrored). Dimensions are metres.

import { m4, m4mul } from '../../../core/math.js';
import { VERTEX_STRIDE } from '../../../core/ids.js';

const TAU = Math.PI * 2;
const tp = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const td = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
const det3 = (m) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

/** Placement matrix from an origin and two axes; the third axis is their cross product (X x Y). Axes are normalised; Y is made perpendicular to X. */
export function frame(origin, xAxis, yHint) {
  const l = Math.hypot(...xAxis), x = xAxis.map((v) => v / l);
  const d = x[0] * yHint[0] + x[1] * yHint[1] + x[2] * yHint[2]; let y = [yHint[0] - x[0] * d, yHint[1] - x[1] * d, yHint[2] - x[2] * d];
  const ly = Math.hypot(...y); y = y.map((v) => v / ly);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const m = m4(); m[0] = x[0]; m[1] = x[1]; m[2] = x[2]; m[4] = y[0]; m[5] = y[1]; m[6] = y[2]; m[8] = z[0]; m[9] = z[1]; m[10] = z[2]; m[12] = origin[0]; m[13] = origin[1]; m[14] = origin[2];
  return m;
}
/** Translation matrix. */
export const at = (x, y, z) => { const m = m4(); m[12] = x; m[13] = y; m[14] = z; return m; };
/** Rotation about a principal axis ('x' | 'y' | 'z'), radians, right-handed. */
export function rot(axis, a) {
  const m = m4(), c = Math.cos(a), s = Math.sin(a);
  if (axis === 'x') { m[5] = c; m[6] = s; m[9] = -s; m[10] = c; } else if (axis === 'y') { m[0] = c; m[2] = -s; m[8] = s; m[10] = c; } else { m[0] = c; m[1] = s; m[4] = -s; m[5] = c; }
  return m;
}
/** Product of any number of matrices, applied right to left. */
export const mul = (...ms) => ms.reduce((acc, m) => m4mul(m4(), acc, m));

/**
 * Surface of revolution about the local X axis. profile: points [x, radius] ordered so that the visible side is on
 * the left when the profile is drawn with +X to the right and the radius upwards (an outer skin runs towards +X, a
 * bore runs back towards -X). Corners sharper than `crease` degrees stay hard; round edges are authored as arcs.
 * opts: { segs, from, to (radians), crease, uv: (i, j) => [u, v], style: (i) => set the builder state for the band
 * that starts at profile point i, or return false to skip it }.
 */
export function lathe(mb, m, profile, opts = {}) {
  const segs = opts.segs || 32, a0 = opts.from || 0, a1 = opts.to ?? TAU, full = Math.abs(a1 - a0 - TAU) < 1e-9;
  const cols = full ? segs : segs + 1;
  const grid = profile.map((p) => { const row = []; for (let j = 0; j < cols; j++) { const a = a0 + (a1 - a0) * j / segs; row.push(tp(m, p[0], p[1] * Math.cos(a), p[1] * Math.sin(a))); } return row; });
  patch(mb, grid, { flip: det3(m) > 0, closeJ: full, crease: opts.crease ?? 38, uv: opts.uv, style: opts.style ? (i) => opts.style(i) : null });
}
export const HARD = 1;

/**
 * Box with rounded edges and corners, centred on the local origin. size = [sx, sy, sz] full extents, r = edge radius,
 * segs = rows across each rounded edge. warp(p) may bend the result (array [x,y,z] in local space, modified in place);
 * normals are then recomputed from the mesh.
 */
export function roundedBox(mb, m, size, r, segs = 3, warp = null) {
  const h = [size[0] / 2, size[1] / 2, size[2] / 2]; r = Math.min(r, h[0], h[1], h[2]);
  const axisSamples = (hh) => {
    const out = [], inner = hh - r;
    for (let i = 0; i <= segs; i++) out.push(-inner - r * Math.tan((Math.PI / 4) * (1 - i / segs)));
    if (inner > 1e-6) { const mid = Math.max(1, Math.min(6, Math.round(inner * 2 / 0.12))); for (let i = 1; i < mid; i++) out.push(-inner + 2 * inner * i / mid); }
    for (let i = 0; i <= segs; i++) out.push(inner + r * Math.tan((Math.PI / 4) * (i / segs)));
    return out;
  };
  const mirrored = det3(m) < 0, start = mb.count;
  // faces: [normal axis, sign, u axis, v axis] with u x v = sign * normal axis
  const faces = [[0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0]];
  for (const [ax, sg, ua, va] of faces) {
    const us = axisSamples(h[ua]), vs = axisSamples(h[va]), base = mb.count, q = [0, 0, 0], inn = [0, 0, 0];
    for (const v of vs) for (const u of us) {
      q[ax] = sg * h[ax]; q[ua] = u; q[va] = v;
      for (let k = 0; k < 3; k++) inn[k] = Math.max(-(h[k] - r), Math.min(h[k] - r, q[k]));
      let nx = q[0] - inn[0], ny = q[1] - inn[1], nz = q[2] - inn[2]; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const p = [inn[0] + nx * r, inn[1] + ny * r, inn[2] + nz * r]; if (warp) warp(p);
      const P = tp(m, p[0], p[1], p[2]), N = td(m, nx, ny, nz);
      mb.vertex(P[0], P[1], P[2], N[0], N[1], N[2], u, v);
    }
    const w = us.length;
    for (let j = 0; j < vs.length - 1; j++) for (let i = 0; i < w - 1; i++) {
      const a = base + j * w + i, b = a + 1, c = a + w + 1, d = a + w;
      if (mirrored) mb.quad(a, d, c, b); else mb.quad(a, b, c, d);
    }
  }
  if (warp) mb.computeNormals(60, start, mb.count, 1e-5);
}

/** Plain flat-shaded box, centred on the local origin (thin slats, plates, brackets). */
export function box(mb, m, sx, sy, sz) {
  const x = sx / 2, y = sy / 2, z = sz / 2, mirrored = det3(m) < 0;
  const quad = (a, b, c, d) => { const A = tp(m, ...a), B = tp(m, ...b), C = tp(m, ...c), D = tp(m, ...d); if (mirrored) mb.flatQuad(A, D, C, B); else mb.flatQuad(A, B, C, D); };
  quad([x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]); quad([-x, -y, z], [-x, y, z], [-x, y, -z], [-x, -y, -z]);
  quad([-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z]); quad([-x, -y, z], [-x, -y, -z], [x, -y, -z], [x, -y, z]);
  quad([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]); quad([x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]);
}

/**
 * Sweep a closed 2D section along a 3D path. path: [{ p, x, y }] with x, y the unit axes of the section plane at that
 * point. section: [[sx, sy, HARD?]] counter-clockwise when looking along the direction of travel reversed (i.e. from the
 * end of the path back to its start). caps: close both ends with fans. scale: optional per-path-point section scale.
 */
export function sweep(mb, path, section, opts = {}) {
  const n = section.length, closedSection = opts.open ? 0 : 1;
  const runs = []; let cur = [0];
  for (let i = 1; i < n + closedSection; i++) { const k = i % n; cur.push(k); if (section[k][2] && i < n + closedSection - 1) { runs.push(cur); cur = [k]; } }
  runs.push(cur);
  const wrapSmooth = closedSection && !section[0][2];
  for (const run of runs) {
    const base = mb.count, rn = run.length;
    for (let s = 0; s < path.length; s++) {
      const f = path[s], sc = f.scale ?? 1;
      for (let k = 0; k < rn; k++) {
        const i = run[k], c = section[i];
        let ia = run[Math.max(0, k - 1)], ib = run[Math.min(rn - 1, k + 1)];
        if (wrapSmooth && runs.length === 1) { if (k === 0) ia = run[rn - 2]; if (k === rn - 1) ib = run[1]; }
        const a = section[ia], b = section[ib]; let tx = b[0] - a[0], ty = b[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const nx = ty, ny = -tx;   // outward for a counter-clockwise section
        mb.vertex(f.p[0] + (f.x[0] * c[0] + f.y[0] * c[1]) * sc, f.p[1] + (f.x[1] * c[0] + f.y[1] * c[1]) * sc, f.p[2] + (f.x[2] * c[0] + f.y[2] * c[1]) * sc,
          f.x[0] * nx + f.y[0] * ny, f.x[1] * nx + f.y[1] * ny, f.x[2] * nx + f.y[2] * ny, s / (path.length - 1), k / (rn - 1));
      }
    }
    for (let s = 0; s < path.length - 1; s++) for (let k = 0; k < rn - 1; k++) {
      const a = base + s * rn + k, b = a + 1, c = a + rn + 1, d = a + rn;
      if (opts.flip) mb.quad(a, b, c, d); else mb.quad(a, d, c, b);
    }
  }
  if (opts.caps) for (const end of [0, path.length - 1]) {
    const f = path[end], sc = f.scale ?? 1, z = [f.x[1] * f.y[2] - f.x[2] * f.y[1], f.x[2] * f.y[0] - f.x[0] * f.y[2], f.x[0] * f.y[1] - f.x[1] * f.y[0]], sg = (end === 0 ? -1 : 1) * (opts.flip ? -1 : 1);
    let cx = 0, cy = 0; for (const c of section) { cx += c[0] / n; cy += c[1] / n; }
    const centre = mb.vertex(f.p[0] + (f.x[0] * cx + f.y[0] * cy) * sc, f.p[1] + (f.x[1] * cx + f.y[1] * cy) * sc, f.p[2] + (f.x[2] * cx + f.y[2] * cy) * sc, z[0] * sg, z[1] * sg, z[2] * sg);
    const ring = section.map((c) => mb.vertex(f.p[0] + (f.x[0] * c[0] + f.y[0] * c[1]) * sc, f.p[1] + (f.x[1] * c[0] + f.y[1] * c[1]) * sc, f.p[2] + (f.x[2] * c[0] + f.y[2] * c[1]) * sc, z[0] * sg, z[1] * sg, z[2] * sg));
    for (let i = 0; i < n; i++) { const a = ring[i], b = ring[(i + 1) % n]; if (sg > 0) mb.tri(centre, a, b); else mb.tri(centre, b, a); }
  }
}

/** Frames along a polyline for sweep(): x axis from `side` hint, y completes it. */
export function pathFrames(points, sideHint = [1, 0, 0]) {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    let t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const tl = Math.hypot(...t) || 1; t = t.map((v) => v / tl);
    const d = sideHint[0] * t[0] + sideHint[1] * t[1] + sideHint[2] * t[2]; let x = [sideHint[0] - t[0] * d, sideHint[1] - t[1] * d, sideHint[2] - t[2] * d];
    const xl = Math.hypot(...x) || 1; x = x.map((v) => v / xl);
    // y = t x x, so that x, y, -t is right handed and a counter-clockwise section faces outward
    const y = [t[1] * x[2] - t[2] * x[1], t[2] * x[0] - t[0] * x[2], t[0] * x[1] - t[1] * x[0]];
    return { p, x, y };
  });
}

/** Regular polygon / circle section for sweep(), counter-clockwise. */
export function circleSection(r, n = 12, squash = 1) { const s = []; for (let i = 0; i < n; i++) { const a = TAU * i / n; s.push([Math.cos(a) * r, Math.sin(a) * r * squash]); } return s; }
/** Rectangle section with every corner hard. */
export const rectSection = (w, h) => [[-w / 2, -h / 2, HARD], [w / 2, -h / 2, HARD], [w / 2, h / 2, HARD], [-w / 2, h / 2, HARD]];

/**
 * Skin through a grid of points: grid[i][j] = [x, y, z] in vehicle metres. Every quad gets its own vertices and the
 * normals are then computed from the mesh, so neighbouring faces blend where they meet at less than `crease` degrees
 * and stay hard where the grid turns a real corner. Rounded edges are therefore authored as points on an arc.
 * Winding: outward is (next row) x (next column), reversed with `flip`.
 * opts: { flip, facing: [x, y, z] (instead of flip: the direction the middle of the patch should face), crease, closeI,
 * closeJ, uv: (i, j) => [u, v], style: (i, j) => false to skip the quad that starts at (i, j), or anything else after
 * setting the builder's material and colour for it }.
 */
export function patch(mb, grid, opts = {}) {
  const rows = grid.length, cols = grid[0].length, start = mb.count, uv = opts.uv || ((i, j) => [j / (cols - 1), i / (rows - 1)]);
  if (opts.facing) {
    const i = Math.min(rows - 2, (rows - 1) >> 1), j = Math.min(cols - 2, (cols - 1) >> 1), a = grid[i][j], b = grid[i + 1][j + 1], c = grid[i + 1][j], d = grid[i][j + 1];
    const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], f = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];           // the quad's diagonals
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
    opts = { ...opts, flip: n[0] * opts.facing[0] + n[1] * opts.facing[1] + n[2] * opts.facing[2] < 0 };
  }
  const put = (i, j) => { const p = grid[i][j], t = uv(i, j); return mb.vertex(p[0], p[1], p[2], 0, 1, 0, t[0], t[1]); };
  const far = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 2e-6;
  const tri = (i0, j0, i1, j1, i2, j2) => {
    const a = grid[i0][j0], b = grid[i1][j1], c = grid[i2][j2]; if (!far(a, b) || !far(b, c) || !far(a, c)) return;
    const va = put(i0, j0), vb = put(i1, j1), vc = put(i2, j2); if (opts.flip) mb.tri(va, vc, vb); else mb.tri(va, vb, vc);
  };
  const ni = opts.closeI ? rows : rows - 1, nj = opts.closeJ ? cols : cols - 1;
  for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
    if (opts.style && opts.style(i, j) === false) continue;
    const i1 = (i + 1) % rows, j1 = (j + 1) % cols;
    tri(i, j, i1, j, i1, j1); tri(i, j, i1, j1, i, j1);
  }
  mb.computeNormals(opts.crease ?? 38, start, mb.count, 1e-5);
}

/**
 * Flat polygon (may be concave) from points in vehicle metres, triangulated by ear clipping. The points must run
 * counter-clockwise seen from the side the face should be visible from.
 */
export function polygon(mb, pts, uvOf = null) {
  const n = pts.length; if (n < 3) return;
  // Newell normal
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]); }
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  // plane axes
  const ref = Math.abs(nx) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  let ux = ref[1] * nz - ref[2] * ny, uy = ref[2] * nx - ref[0] * nz, uz = ref[0] * ny - ref[1] * nx; const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const flat = pts.map((p) => [p[0] * ux + p[1] * uy + p[2] * uz, p[0] * vx + p[1] * vy + p[2] * vz]);
  const idx = pts.map((p, i) => { const t = uvOf ? uvOf(p, i) : flat[i]; return mb.vertex(p[0], p[1], p[2], nx, ny, nz, t[0], t[1]); });
  const area = (a, b, c) => (flat[b][0] - flat[a][0]) * (flat[c][1] - flat[a][1]) - (flat[b][1] - flat[a][1]) * (flat[c][0] - flat[a][0]);
  const inside = (a, b, c, p) => area(a, b, p) >= -1e-12 && area(b, c, p) >= -1e-12 && area(c, a, p) >= -1e-12;
  // a polygon with holes arrives as one ring with bridges, so some points appear twice; a twin never blocks an ear
  const same = (p, q) => Math.abs(flat[p][0] - flat[q][0]) + Math.abs(flat[p][1] - flat[q][1]) < 1e-9;
  const left = pts.map((_, i) => i);
  let guard = n * n;
  while (left.length > 3 && guard-- > 0) {
    let cut = -1;
    for (let k = 0; k < left.length; k++) {
      const a = left[(k + left.length - 1) % left.length], b = left[k], c = left[(k + 1) % left.length];
      if (area(a, b, c) <= 1e-14) continue;
      let ear = true; for (const p of left) if (p !== a && p !== b && p !== c && !same(p, a) && !same(p, b) && !same(p, c) && inside(a, b, c, p)) { ear = false; break; }
      if (ear) { cut = k; mb.tri(idx[a], idx[b], idx[c]); break; }
    }
    if (cut < 0) cut = 0;                       // numerically flat remainder: drop a vertex and carry on
    left.splice(cut, 1);
  }
  if (left.length === 3 && area(left[0], left[1], left[2]) > 1e-14) mb.tri(idx[left[0]], idx[left[1]], idx[left[2]]);
}

const signedArea = (loop) => { let a = 0; for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
/** The loop running counter-clockwise. */
export const ccw = (loop) => (signedArea(loop) >= 0 ? loop.slice() : loop.slice().reverse());

/**
 * A plane with a right-handed frame: returns to3(u, v, w) = origin + u U + v V + w (U x V), so that a loop that is
 * counter-clockwise in (u, v) is seen counter-clockwise from the +w side. All plane helpers below assume this.
 */
export function planeFrame(origin, U, V) {
  const N = [U[1] * V[2] - U[2] * V[1], U[2] * V[0] - U[0] * V[2], U[0] * V[1] - U[1] * V[0]], nl = Math.hypot(...N), ul = Math.hypot(...U);
  const k = ul / nl;
  return (u, v, w = 0) => [origin[0] + u * U[0] + v * V[0] + w * N[0] * k, origin[1] + u * U[1] + v * V[1] + w * N[1] * k, origin[2] + u * U[2] + v * V[2] + w * N[2] * k];
}

/**
 * Flat region with holes, visible from +w. outer and holes are loops in (u, v), any orientation. Each hole is joined
 * to the outer ring by a bridge to the nearest vertex it can see, then the ring is ear-clipped.
 */
export function region(mb, to3, outer, holes = [], { w = 0, uv = null } = {}) {
  let ring = ccw(outer);
  const maxU = (h) => h.reduce((m, p) => Math.max(m, p[0]), -Infinity);
  const hs = holes.map((h) => ccw(h).reverse()).sort((a, b) => maxU(b) - maxU(a));
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const eq = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 1e-9;
  const cuts = (a, b, loop) => {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      if (eq(p, a) || eq(p, b) || eq(q, a) || eq(q, b)) continue;
      if (cross(a, b, p) * cross(a, b, q) < 0 && cross(p, q, a) * cross(p, q, b) < 0) return true;
    }
    return false;
  };
  hs.forEach((h, hi) => {
    let k = 0; for (let i = 1; i < h.length; i++) if (h[i][0] > h[k][0]) k = i;
    const H = h[k], order = ring.map((p, i) => [Math.hypot(p[0] - H[0], p[1] - H[1]), i]).sort((a, b) => a[0] - b[0]);
    const seen = order.find(([, i]) => !cuts(H, ring[i], ring) && !hs.slice(hi).some((o) => cuts(H, ring[i], o)));
    const c = (seen || order[0])[1];
    ring = [...ring.slice(0, c + 1), ...h.slice(k), ...h.slice(0, k + 1), ...ring.slice(c)];
  });
  polygon(mb, ring.map((q) => to3(q[0], q[1], w)), uv ? (p, i) => uv(ring[i]) : null);
}

/**
 * Wall through copies of one plane loop: steps = [[grow, w], ...], each row being the loop grown outward by `grow`
 * and lifted to height w. Rows run away from the surface the wall starts on: down into a recess (falling w) or up a
 * boss (rising w), in both cases the visible side comes out right. `outer: true` is for a wall standing on the
 * outside edge of a region, seen from within. style(i) as for patch().
 * An open loop may end on a line the wall has to stay on (the car's centre line, where the mirrored half takes over):
 * `slide: [first, last]` gives for each end of `loop` the direction [u, v] of that line, or null; the end then moves
 * along it as the loop grows, instead of square to its own last edge and so off the line.
 */
export function ringLoft(mb, to3, loop, steps, { crease = 38, style = null, outer = false, open = false, slide = null } = {}) {
  const base = ccw(loop), n = base.length, turned = base[0] !== loop[0];
  const rail = (i) => (!open || !slide ? null : i === 0 ? slide[turned ? 1 : 0] : i === n - 1 ? slide[turned ? 0 : 1] : null);
  const grown = (g) => {
    if (!g) return base;
    return base.map((p, i) => {
      const a = base[(i + n - 1) % n], b = base[(i + 1) % n], hasA = !open || i > 0, hasB = !open || i < n - 1;
      const nrm = (s, e) => { const tx = e[0] - s[0], ty = e[1] - s[1], l = Math.hypot(tx, ty) || 1; return [ty / l, -tx / l]; };
      const n0 = hasA ? nrm(a, p) : nrm(p, b), n1 = hasB ? nrm(p, b) : n0, k = g / Math.max(0.3, 1 + n0[0] * n1[0] + n0[1] * n1[1]);
      const along = rail(i);
      if (along) { const reach = g / (n0[0] * along[0] + n0[1] * along[1]); return [p[0] + along[0] * reach, p[1] + along[1] * reach]; }
      return [p[0] + (n0[0] + n1[0]) * k, p[1] + (n0[1] + n1[1]) * k];
    });
  };
  const grid = steps.map(([g, w]) => grown(g).map((q) => to3(q[0], q[1], w)));
  patch(mb, grid, { flip: !outer, closeJ: !open, crease, style: style ? (i) => style(i) : null });
}

/** Rounded rectangle as a counter-clockwise loop. */
export function roundRect(u0, v0, u1, v1, r, segs = 3) {
  const out = [], corners = [[u1 - r, v1 - r, 0], [u0 + r, v1 - r, 90], [u0 + r, v0 + r, 180], [u1 - r, v0 + r, 270]];
  for (const [cu, cv, a0] of corners) for (let i = 0; i <= segs; i++) { const a = (a0 + 90 * i / segs) * Math.PI / 180; out.push([cu + Math.cos(a) * r, cv + Math.sin(a) * r]); }
  return out;
}

/** The part of a convex or simple loop on one side of the line v = cut (above: keep v >= cut). */
export function clipLoop(loop, cut, above) {
  const out = [], inside = (p) => (above ? p[1] >= cut : p[1] <= cut);
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    if (inside(p)) out.push(p);
    if (inside(p) !== inside(q)) { const t = (cut - p[1]) / (q[1] - p[1]); out.push([p[0] + (q[0] - p[0]) * t, cut]); }
  }
  return out;
}

/**
 * A finished mesh (MeshBuilder.finish()) without the vertices that no triangle uses. The panel mesher lays out a
 * vertex wherever a row may need one and then drops the triangles that came out without area; what is left over
 * would still be uploaded and transformed, one in twenty of a body's vertices.
 */
export function compact(mesh) {
  const used = new Uint8Array(mesh.vertexCount), slot = new Uint32Array(mesh.vertexCount);
  for (let i = 0; i < mesh.indexCount; i++) used[mesh.indices[i]] = 1;
  let count = 0;
  for (let v = 0; v < mesh.vertexCount; v++) if (used[v]) slot[v] = count++;
  const from = new Uint8Array(mesh.vertices), to = new Uint8Array(count * VERTEX_STRIDE);
  for (let v = 0; v < mesh.vertexCount; v++) if (used[v]) to.set(from.subarray(v * VERTEX_STRIDE, (v + 1) * VERTEX_STRIDE), slot[v] * VERTEX_STRIDE);
  return { ...mesh, vertices: to.buffer, indices: mesh.indices.map((v) => slot[v]), vertexCount: count };
}
