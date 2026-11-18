// Construction kit for buildings and landmarks.
//
// A Kit wraps one MeshBuilder plus the light, glow, collider and sign lists of one building at one level of detail.
// Everything is emitted in LOT-LOCAL metres (origin at the lot centre on the ground, +Z towards the street, +Y up)
// through a small 2D transform stack, so a part can be written once in the frame of the wall it hangs on
// (`onRun`: x along the wall from its left end as seen from outside, z out of the wall).
//
// Plan polygons are lists of RUNS. A run is a polyline: a straight wall (2 points) or an arc (rounded corner).
// The order is front-left -> front-right -> back-right -> back-left, which makes (p0, pi, pi+1) face up and makes the
// outward normal of an edge with direction (dx, dz) equal to (-dz, dx).
//
// Wall bands use the FACADE family (see src/render/families/facade.js for the uv and material rules); everything that
// projects or recedes is SOLID geometry with baked occlusion on soffits.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, FACADE, SOLID, CHANNEL, LIGHT_STRIDE, GLOW_STRIDE } from '../../core/ids.js';
import { makeRng, hashInts, srgbToLinear, clamp } from '../../core/math.js';
import { pickSign } from './signs-adapter.js';

const HALF_PI = Math.PI / 2;
// Local lights beside pale walls (see lamp() and neon()): the gain on small fittings, and the wash of a neon tube
// or lit sign (metres in front of the wall, metres between lights along a tube, radius, colour magnitude).
const LAMP_GAIN = 0.35, WASH_OFFSET = 0.45, WASH_SPACING = 2.0, WASH_RADIUS = 2.2, WASH_POWER = 0.5;
// Halo sprites along a neon tube: spacing and diameter in metres, sprite colour as a share of the tube's radiance.
const HALO_STEP = 0.22, HALO_SIZE = 0.55, HALO_GAIN = 0.1;
// Light that a lit ground floor throws through its glazing onto the terrace and the pavement, by SHOPFRONT type
// (colour magnitude of one light per SPILL_SPACING of front; types without glazing have none). The source stands
// SPILL_INSET behind the glass, where the lamps of the room are: a window is a wide source, and a point on the glass
// itself would burn the ground at its foot and reach nothing two metres on.
const SPILL_SPACING = 8, SPILL_INSET = 2.0, SPILL_RADIUS = 15, SPILL_POWER = [44, 56, 50, 0, 56, 24, 0, 0], SPILL_COLOR = [1, 0.84, 0.62];
const lin3 = (c) => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
/** Intensity byte for SOLID.EMISSIVE / NEON / SIGN / LAMP_LENS: radiance = 0.25 * 2^(code / 16). */
export const radianceCode = (radiance) => clamp(Math.round(16 * Math.log2(Math.max(radiance, 0.25) / 0.25)), 1, 255);
export const mixColor = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const shade = (c, k) => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

// ---------------------------------------------------------------- plan helpers
function finishRun(pts, curved, cls, nrm) {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const a = pts[0], b = pts[pts.length - 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const run = { pts, curved, cls, cum, len: cum[cum.length - 1], nx: -(b[1] - a[1]) / l, nz: (b[0] - a[0]) / l, nrm };
  if (!nrm) run.nrm = pts.map((_, i) => {
    if (!curved) return [run.nx, run.nz];
    const j0 = Math.max(0, i - 1), j1 = Math.min(pts.length - 1, i + 1), dx = pts[j1][0] - pts[j0][0], dz = pts[j1][1] - pts[j0][1], d = Math.hypot(dx, dz) || 1;
    return [-dz / d, dx / d];
  });
  return run;
}
/** One straight wall from (x0, z0) to (x1, z1); seen from outside it runs left to right. */
export const lineRun = (x0, z0, x1, z1, cls = 'front') => finishRun([[x0, z0], [x1, z1]], false, cls);
const sideOf = (nx, nz) => (Math.abs(nz) >= Math.abs(nx) ? (nz > 0 ? 'front' : 'back') : (nx > 0 ? 'right' : 'left'));

/**
 * Rectangle x0..x1, z0..z1 as runs, optionally with rounded corners. r: one radius or [frontLeft, frontRight,
 * backRight, backLeft]; segs: facets per quarter circle. Run classes: front, right, back, left and the corner arcs
 * fl, fr, br, bl.
 */
export function rectRuns(x0, z0, x1, z1, r = 0, segs = 6) {
  const R = (Array.isArray(r) ? r : [r, r, r, r]).map((v) => Math.max(0, Math.min(v, (x1 - x0) / 2 - 0.01, (z1 - z0) / 2 - 0.01)));
  const [fl, fr, br, bl] = R, runs = [];
  const arc = (cx, cz, rad, a0, cls) => {
    const pts = [], nrm = [];
    for (let i = 0; i <= segs; i++) { const a = a0 + (i / segs) * HALF_PI, s = Math.sin(a), c = Math.cos(a); pts.push([cx + rad * s, cz + rad * c]); nrm.push([s, c]); }
    runs.push(finishRun(pts, true, cls, nrm));
  };
  runs.push(finishRun([[x0 + fl, z1], [x1 - fr, z1]], false, 'front')); if (fr > 0) arc(x1 - fr, z1 - fr, fr, 0, 'fr');
  runs.push(finishRun([[x1, z1 - fr], [x1, z0 + br]], false, 'right')); if (br > 0) arc(x1 - br, z0 + br, br, HALF_PI, 'br');
  runs.push(finishRun([[x1 - br, z0], [x0 + bl, z0]], false, 'back')); if (bl > 0) arc(x0 + bl, z0 + bl, bl, Math.PI, 'bl');
  runs.push(finishRun([[x0, z0 + bl], [x0, z1 - fl]], false, 'left')); if (fl > 0) arc(x0 + fl, z1 - fl, fl, 3 * HALF_PI, 'fl');
  return runs;
}
/** Any simple polygon (points in the standard order) as straight runs classed by the way each edge faces. */
export function polyRuns(pts) {
  return pts.map((p, i) => { const q = pts[(i + 1) % pts.length], r = finishRun([p, q], false, ''); r.cls = sideOf(r.nx, r.nz); return r; });
}
/** A polygon whose edges carry the given class names (same order as the points: edge i runs from point i to i + 1). */
export function namedRuns(pts, classes) { const runs = polyRuns(pts); runs.forEach((r, i) => { if (classes[i]) r.cls = classes[i]; }); return runs; }
/** Bounding box of a run list in plan. */
export function bounds(runs) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of runs) for (const p of r.pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
  return { x0, x1, z0, z1 };
}
/** Regular polygon or circle of n sides as one curved run per side group (smooth all round). */
export function circleRuns(cx, cz, r, n, phase = 0) {
  const pts = [], nrm = [];
  for (let i = 0; i <= n; i++) { const a = phase + (i / n) * 2 * Math.PI, s = Math.sin(a), c = Math.cos(a); pts.push([cx + r * s, cz + r * c]); nrm.push([s, c]); }
  return [finishRun(pts, true, 'round', nrm)];
}
/** The corner points of a list of runs (closed polygon, no duplicates). */
export function flat(runs) {
  const out = [];
  for (const r of runs) for (let i = 0; i < r.pts.length - 1; i++) out.push(r.pts[i]);
  return out;
}
/** Move every edge of a closed polygon inwards by t (negative t grows it). Mitred. */
export function inset(pts, t) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    let e0x = b[0] - a[0], e0z = b[1] - a[1], e1x = c[0] - b[0], e1z = c[1] - b[1];
    const l0 = Math.hypot(e0x, e0z) || 1, l1 = Math.hypot(e1x, e1z) || 1; e0x /= l0; e0z /= l0; e1x /= l1; e1z /= l1;
    const n0x = -e0z, n0z = e0x, n1x = -e1z, n1z = e1x; let mx = n0x + n1x, mz = n0z + n1z; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    const k = t / Math.max(0.3, mx * n0x + mz * n0z);
    out.push([b[0] - mx * k, b[1] - mz * k]);
  }
  return out;
}
/** Ear-clipping triangulation of a simple polygon in the standard order. Returns index triples facing up. */
export function triangulate(pts) {
  const idx = pts.map((_, i) => i), tris = [];
  const turn = (a, b, c) => (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]);
  const inside = (a, b, c, p) => turn(a, b, p) <= 0 && turn(b, c, p) <= 0 && turn(c, a, p) <= 0;
  let guard = pts.length * pts.length + 8;
  while (idx.length > 3 && guard-- > 0) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (turn(a, b, c) >= -1e-9) continue;
      let ear = true; for (const p of idx) if (p !== a && p !== b && p !== c && inside(a, b, c, p)) { ear = false; break; }
      if (!ear) continue;
      tris.push(a, b, c); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) idx.splice(0, 1);      // degenerate corner: drop it rather than loop for ever
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

// ---------------------------------------------------------------- the kit
export class Kit {
  /** lot: the lot record (width, depth, seed); level: 0 near, 1 mid, 2 far. */
  constructor(lot, level) {
    this.lot = lot; this.L = level; this.near = level === 0; this.mid = level <= 1; this.far = level === 2;
    this.m = new MeshBuilder(level === 0 ? 8192 : 1024);
    this.seed = lot.seed >>> 0; this.rng = makeRng(hashInts(this.seed, 0x5eed)); this.sb = this.seed & 255;
    this.lights = []; this.glows = []; this.colliders = []; this.signs = [];
    this.T = [1, 0, 0, 1, 0, 0, 0]; this.stack = [];      // x' = a x + c z + tx ; z' = b x + d z + tz ; y' = y + ty
    this.height = 0; this.arc = level === 0 ? 6 : level === 1 ? 3 : 1;
    this.washes = []; this.downlights = []; this.spills = []; this.signMap = null; this.plants = [];
  }
  /** A deterministic 0..1 value for a named decision of this building (independent of the order of calls). */
  h(salt) { return hashInts(this.seed, salt, 0x7f4a) / 4294967296; }

  // ---- transform stack
  push(tx, ty, tz, yaw = 0) {
    const T = this.T, c = Math.cos(yaw), s = Math.sin(yaw); this.stack.push(T);
    // child: x = c*lx + s*lz + tx ; z = -s*lx + c*lz + tz, then the parent
    this.T = [T[0] * c + T[2] * -s, T[1] * c + T[3] * -s, T[0] * s + T[2] * c, T[1] * s + T[3] * c, T[0] * tx + T[2] * tz + T[4], T[5] + ty, T[1] * tx + T[3] * tz + T[6]];
    return this;
  }
  pop() { this.T = this.stack.pop(); return this; }
  /** Run fn in the frame of a straight run: x along it from its left end, z outwards, y unchanged. */
  onRun(run, fn) {
    const a = run.pts[0]; this.push(a[0], 0, a[1], Math.atan2(run.nx, run.nz)); fn(run.len); this.pop(); return this;
  }
  /** Run fn in a frame at (x, y, z) turned by yaw. */
  at(x, y, z, yaw, fn) { this.push(x, y, z, yaw); fn(); this.pop(); return this; }
  P(x, y, z) { const T = this.T; return [T[0] * x + T[2] * z + T[4], y + T[5], T[1] * x + T[3] * z + T[6]]; }
  D(x, z) { const T = this.T; return [T[0] * x + T[2] * z, T[1] * x + T[3] * z]; }
  v(x, y, z, nx, ny, nz, u = 0, w = 0) {
    const T = this.T, yy = y + T[5]; if (yy > this.height) this.height = yy;
    return this.m.vertex(T[0] * x + T[2] * z + T[4], yy, T[1] * x + T[3] * z + T[6], T[0] * nx + T[2] * nz, ny, T[1] * nx + T[3] * nz, u, w);
  }

  // ---- materials
  solid(id, color, p0 = 0, p1 = 0, occ = 1) { this.m.family(FAMILY.SOLID).material(id, p0, p1, this.sb).color(color[0], color[1], color[2]).occlusion(occ); this._occ = occ; return this; }
  stucco(color, wear = 60) { return this.solid(SOLID.STUCCO, color, 150, wear); }
  paint(color, rough = 0.55, wear = 40) { return this.solid(SOLID.PAINT, color, rough * 255, wear); }
  concrete(color = [0.66, 0.65, 0.62], joint = 0, wear = 90) { return this.solid(SOLID.CONCRETE, color, joint, wear); }
  steel(color, rough = 0.5, rust = 30) { return this.solid(SOLID.METAL_PAINTED, color, rough * 255, rust); }
  bare(kind = 1, rough = 0.35) { return this.solid(SOLID.METAL_BARE, [0.8, 0.8, 0.8], rough * 255, kind); }
  glass(tint = [0.1, 0.13, 0.15], rough = 0.06) { return this.solid(SOLID.DARK_GLASS, tint, rough * 255, 160); }
  tile(color, sizeCm = 15, pattern = 0) { return this.solid(SOLID.TILE, color, sizeCm, pattern); }
  roofing(kind, color, wear = 110) { return this.solid(SOLID.ROOF, color, kind, wear); }
  fabric(color, pattern = 0, second = 0) { return this.solid(SOLID.FABRIC, color, pattern, second); }
  emissive(color, radiance, channel = CHANNEL.NEON) { return this.solid(SOLID.EMISSIVE, color, radianceCode(radiance), channel); }
  lens(color, radiance, channel = CHANNEL.STREET) { return this.solid(SOLID.LAMP_LENS, color, radianceCode(radiance), channel); }
  occ(a) { this.m.occlusion(a); this._occ = a; return this; }
  /** FACADE material for hand-made wall quads. */
  facade(spec, storey) { this.m.family(FAMILY.FACADE).material(spec.style, Math.round(storey * 10), clamp(Math.round((spec.bayQ ?? spec.bay ?? 3) * 10), 6, 255), spec.seed ?? this.sb).color(spec.color[0], spec.color[1], spec.color[2]).occlusion(1); return this; }

  // ---- raw faces
  /** Quad from four points, counter-clockwise seen from outside, flat normal, uv in metres from the first corner. */
  quad(p0, p1, p2, p3, uv) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const w = uv || [0, 0, Math.hypot(ux, uy, uz), 0, Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), 0, Math.hypot(vx, vy, vz)];
    const a = this.v(p0[0], p0[1], p0[2], nx, ny, nz, w[0], w[1]); this.v(p1[0], p1[1], p1[2], nx, ny, nz, w[2], w[3]);
    this.v(p2[0], p2[1], p2[2], nx, ny, nz, w[4], w[5]); this.v(p3[0], p3[1], p3[2], nx, ny, nz, w[6], w[7]);
    this.m.quad(a, a + 1, a + 2, a + 3); return a;
  }
  /** Flat triangle, counter-clockwise seen from outside; uv: [u0, v0, u1, v1, u2, v2] or metres from the first corner. */
  tri3(p0, p1, p2, uv) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const w = uv || [0, 0, Math.hypot(ux, uy, uz), 0, 0, Math.hypot(vx, vy, vz)];
    const a = this.v(p0[0], p0[1], p0[2], nx, ny, nz, w[0], w[1]); this.v(p1[0], p1[1], p1[2], nx, ny, nz, w[2], w[3]); this.v(p2[0], p2[1], p2[2], nx, ny, nz, w[4], w[5]);
    this.m.tri(a, a + 1, a + 2);
  }
  /** A thin sheet seen from both sides (awnings, flags, screens): the quad and its reverse, the underside shaded. */
  sheet(p0, p1, p2, p3, uv, under = 0.6) {
    this.quad(p0, p1, p2, p3, uv); const o = this._occ; this.m.occlusion(o * under);
    // the underside sits 6 mm behind the top so the two faces never share a depth
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1, e = -0.006 / l; nx *= e; ny *= e; nz *= e;
    const B = (p) => [p[0] + nx, p[1] + ny, p[2] + nz];
    this.quad(B(p1), B(p0), B(p3), B(p2), uv ? [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]] : undefined); this.m.occlusion(o);
  }
  /** A two-sided triangle (awning cheeks, pennants); the back sits 6 mm behind the front like `sheet`. */
  leaf(p0, p1, p2) {
    this.tri3(p0, p1, p2);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1, e = -0.006 / l; nx *= e; ny *= e; nz *= e;
    this.tri3([p0[0] + nx, p0[1] + ny, p0[2] + nz], [p2[0] + nx, p2[1] + ny, p2[2] + nz], [p1[0] + nx, p1[1] + ny, p1[2] + nz]);
  }
  /** A quad wound whichever way makes it face `dir` (current frame): for faces whose handedness depends on a mirrored layout. */
  quadFacing(p0, p1, p2, p3, dir) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    const d = (uy * vz - uz * vy) * dir[0] + (uz * vx - ux * vz) * dir[1] + (ux * vy - uy * vx) * dir[2];
    return d >= 0 ? this.quad(p0, p1, p2, p3) : this.quad(p3, p2, p1, p0);
  }

  // ---- solids
  /**
   * Axis-aligned box in the current frame. faces: which to emit, letters x X (min / max x), z Z, y (bottom), Y (top);
   * default all but the bottom. The bottom is shaded as a soffit. uv are metres (u horizontal, v up).
   */
  box(x0, y0, z0, x1, y1, z1, faces = 'xXzZY') {
    const o = this._occ;
    if (faces.includes('Z')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, x1, y0, x1, y1, x0, y1]);
    if (faces.includes('z')) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [-x1, y0, -x0, y0, -x0, y1, -x1, y1]);
    if (faces.includes('X')) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [-z1, y0, -z0, y0, -z0, y1, -z1, y1]);
    if (faces.includes('x')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [z0, y0, z1, y0, z1, y1, z0, y1]);
    if (faces.includes('Y')) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [x0, -z1, x1, -z1, x1, -z0, x0, -z0]);
    if (faces.includes('y')) { this.m.occlusion(o * 0.55); this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, z0, x1, z0, x1, z1, x0, z1]); this.m.occlusion(o); }
    return this;
  }
  /** Polygon cap facing up (or down with `down`) at height y; uv = plan metres. */
  cap(pts, y, down = false) {
    const base = this.m.count; for (const p of pts) this.v(p[0], y, p[1], 0, down ? -1 : 1, 0, p[0], -p[1]);
    const t = triangulate(pts);
    for (let i = 0; i < t.length; i += 3) down ? this.m.tri(base + t[i], base + t[i + 2], base + t[i + 1]) : this.m.tri(base + t[i], base + t[i + 1], base + t[i + 2]);
    return this;
  }
  /** Side faces of a run list between y0 and y1 in the current SOLID material (smooth on arcs). skip: classes to leave out. */
  sides(runs, y0, y1, skip = null) {
    for (const r of runs) {
      if (skip && skip.includes(r.cls)) continue;
      const base = this.m.count, n = r.pts.length;
      for (let i = 0; i < n; i++) { const p = r.pts[i], nn = r.nrm[i]; this.v(p[0], y0, p[1], nn[0], 0, nn[1], r.cum[i], y0); this.v(p[0], y1, p[1], nn[0], 0, nn[1], r.cum[i], y1); }
      for (let i = 0; i < n - 1; i++) { const a = base + i * 2; this.m.quad(a, a + 2, a + 3, a + 1); }
    }
    return this;
  }
  /**
   * Extruded plan shape: sides, top and (with `bottom`) a shaded soffit. `lip`: colour of the sides when it differs
   * from the top (eyebrow lips, fascias). skip: run classes whose side face is hidden (against a wall).
   */
  slab(runs, y0, y1, o = {}) {
    const pts = flat(runs), keep = this._occ;
    if (o.top !== false) this.cap(pts, y1);
    if (o.bottom) { this.m.occlusion(keep * (o.under ?? 0.5)); this.cap(pts, y0, true); this.m.occlusion(keep); }
    if (o.lip) { const c = o.lip; this.m.color(c[0], c[1], c[2]); }
    this.sides(runs, y0, y1, o.skip);
    return this;
  }
  /** Vertical cylinder or frustum (r1 at the top), smooth, with an optional top cap. */
  cyl(x, y0, z, r, y1, o = {}) {
    const n = o.segs ?? (this.near ? 12 : 6), r1 = o.r1 ?? r, base = this.m.count, sl = (r - r1) / Math.max(1e-6, y1 - y0);
    for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI, s = Math.sin(a), c = Math.cos(a); this.v(x + r * s, y0, z + r * c, s, sl, c, (i / n) * 2 * Math.PI * r, y0); this.v(x + r1 * s, y1, z + r1 * c, s, sl, c, (i / n) * 2 * Math.PI * r, y1); }
    for (let i = 0; i < n; i++) { const a = base + i * 2; this.m.quad(a, a + 2, a + 3, a + 1); }
    if (o.cap !== false && r1 > 1e-4) { const pts = []; for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; pts.push([x + r1 * Math.sin(a), z + r1 * Math.cos(a)]); } this.cap(pts, y1); }
    if (o.bottom) { const pts = []; for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; pts.push([x + r * Math.sin(a), z + r * Math.cos(a)]); } this.cap(pts, y0, true); }
    return this;
  }
  /** Sphere (ball finials, tank ends, domes when `y0` cuts it). */
  ball(x, y, z, r, o = {}) {
    const n = o.segs ?? (this.near ? 10 : 6), rows = Math.max(2, n >> 1), lat0 = o.dome ? 0 : -HALF_PI, sy = o.sy ?? 1;
    this.m.grid(rows, n, (i, j, out) => {
      const la = lat0 + (i / rows) * (HALF_PI - lat0), lo = (j / n) * 2 * Math.PI, cl = Math.cos(la), sx = Math.sin(lo) * cl, sz = Math.cos(lo) * cl, syy = Math.sin(la);
      const T = this.T, px = x + r * sx, pz = z + r * sz, yy = y + r * syy * sy + T[5]; if (yy > this.height) this.height = yy;
      out.x = T[0] * px + T[2] * pz + T[4]; out.y = yy; out.z = T[1] * px + T[3] * pz + T[6];
      out.nx = T[0] * sx + T[2] * sz; out.ny = syy / sy; out.nz = T[1] * sx + T[3] * sz; out.u = j / n; out.v = i / rows;
    });
    return this;
  }
  /**
   * Round tube along a 3D polyline (railings, poles, neon). sides >= 3; mitred at corners; uv.x = metres along.
   * closed: the last point joins the first.
   */
  pipe(pts, r, sides = 4, closed = false) {
    const n = pts.length; if (n < 2) return this;
    const dir = (a, b) => { const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(d[0], d[1], d[2]) || 1; return [d[0] / l, d[1] / l, d[2] / l]; };
    const segs = []; for (let i = 0; i < n - 1; i++) segs.push(dir(pts[i], pts[i + 1])); if (closed) segs.push(dir(pts[n - 1], pts[0]));
    // a reference vector that is never parallel to the first segment, carried along the tube without twisting
    let ref = Math.abs(segs[0][1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const base = this.m.count, count = closed ? n + 1 : n; let dist = 0;
    for (let i = 0; i < count; i++) {
      const k = i % n, s0 = segs[(k + segs.length - 1) % segs.length], s1 = segs[k % segs.length];
      const first = !closed && i === 0, last = !closed && i === n - 1;
      let t = first ? s1 : last ? s0 : [s0[0] + s1[0], s0[1] + s1[1], s0[2] + s1[2]]; const tl = Math.hypot(t[0], t[1], t[2]) || 1; t = [t[0] / tl, t[1] / tl, t[2] / tl];
      const mitre = first || last ? 1 : 1 / Math.max(0.35, t[0] * s1[0] + t[1] * s1[1] + t[2] * s1[2]);
      let bx = t[1] * ref[2] - t[2] * ref[1], by = t[2] * ref[0] - t[0] * ref[2], bz = t[0] * ref[1] - t[1] * ref[0]; const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
      const ax = by * t[2] - bz * t[1], ay = bz * t[0] - bx * t[2], az = bx * t[1] - by * t[0]; ref = [ax, ay, az];
      if (i > 0) { const q = pts[(i - 1) % n]; dist += Math.hypot(pts[k][0] - q[0], pts[k][1] - q[1], pts[k][2] - q[2]); }
      for (let j = 0; j <= sides; j++) { const a = (j / sides) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a), nx = ax * c + bx * s, ny = ay * c + by * s, nz = az * c + bz * s;
        this.v(pts[k][0] + nx * r * mitre, pts[k][1] + ny * r * mitre, pts[k][2] + nz * r * mitre, nx, ny, nz, dist, j / sides); }
    }
    const w = sides + 1;
    for (let i = 0; i < count - 1; i++) for (let j = 0; j < sides; j++) { const a = base + i * w + j; this.m.quad(a, a + 1, a + w + 1, a + w); }
    return this;
  }

  // ---- walls
  /**
   * Stack of FACADE wall bands on a run list, from y0 upwards. bands: [{ h, storey, spec, grounded }], where
   * spec is { style, bay, color, seed?, occ?: [bottom, top], bays? } or a function (run) => spec | null (null: no wall).
   * `grounded` marks the band standing on the ground (default: only when y0 < 0.3 and it is the first band).
   * Returns per band { y0, y1, runs: [{ run, n, bay }] } so parts can be lined up with the painted bays.
   */
  walls(runs, y0, bands) {
    const out = []; let y = y0;
    bands.forEach((band, bi) => {
      const y1 = y + band.h, storey = band.storey ?? band.h, grounded = band.grounded ?? (bi === 0 && y0 < 0.3), info = { y0: y, y1, storey, runs: [] };
      const sByte = clamp(Math.round(Math.max(storey, 1) * 10), 10, 255), sQ = sByte / 10;
      for (const r of runs) {
        const spec = typeof band.spec === 'function' ? band.spec(r) : band.spec; if (!spec || r.len < 0.02) { info.runs.push({ run: r, n: 0, bay: 0 }); continue; }
        const target = spec.bay ?? 3, n = Math.max(1, spec.bays ?? (r.curved && spec.facetBays ? r.pts.length - 1 : Math.round(r.len / target)));
        const bayQ = clamp(Math.round((r.len / n) * 10), 6, 255) / 10, uScale = (n * bayQ) / r.len, occ = spec.occ ?? [1, 1], c = spec.color;
        this.m.family(FAMILY.FACADE).material(spec.style, sByte, bayQ * 10, spec.seed ?? this.sb).color(c[0], c[1], c[2]);
        const base = this.m.count, np = r.pts.length, v0 = (spec.grounded ?? grounded) ? 0 : sQ, v1 = v0 + (y1 - y);
        for (let i = 0; i < np; i++) { const p = r.pts[i], nn = r.nrm[i], u = r.cum[i] * uScale;
          this.m.occlusion(occ[0]); this.v(p[0], y, p[1], nn[0], 0, nn[1], u, v0); this.m.occlusion(occ[1]); this.v(p[0], y1, p[1], nn[0], 0, nn[1], u, v1); }
        for (let i = 0; i < np - 1; i++) { const a = base + i * 2; this.m.quad(a, a + 2, a + 3, a + 1); }
        info.runs.push({ run: r, n, bay: r.len / n });
        if (!this.far && y < 1.5 && !r.curved && (spec.style & 15) === FACADE.SHOPFRONT) this.spill(r, y, y1, SPILL_POWER[(spec.style >> 4) & 7]);
      }
      this.m.occlusion(1); out.push(info); y = y1;
    });
    return out;
  }
  /**
   * Parapet on top of a mass: inner face and coping in SOLID stucco (the outer face is a wall band the caller made).
   * Also lays the roof deck at y. At the far level only the deck is laid, at the parapet top.
   */
  parapet(runs, y, h, o = {}) {
    const pts = flat(runs), t = o.t ?? 0.22, roof = o.roof ?? [0.50, 0.49, 0.45];
    if (this.far) { this.roofing(o.roofKind ?? 0, roof).cap(pts, y + h); return this; }
    const inn = inset(pts, t), n = pts.length;
    this.roofing(o.roofKind ?? 0, roof).occ(0.85).cap(inn, y);
    this.stucco(o.inner ?? o.color ?? [0.8, 0.8, 0.78], 110).occ(0.8);
    for (let i = 0; i < n; i++) { const a = inn[i], b = inn[(i + 1) % n]; this.quad([b[0], y, b[1]], [a[0], y, a[1]], [a[0], y + h, a[1]], [b[0], y + h, b[1]]); }
    this.stucco(o.coping ?? o.color ?? [0.9, 0.9, 0.88]).occ(1);
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n], c = inn[(i + 1) % n], d = inn[i]; this.quad([a[0], y + h, a[1]], [b[0], y + h, b[1]], [c[0], y + h, c[1]], [d[0], y + h, d[1]]); }
    return this;
  }
  /**
   * A moulding swept along consecutive runs: a rectangular section projecting `depth` from the wall line between
   * y0 and y1 (cornices, copings, continuous eyebrows, stripes in relief, balcony slabs, plinths). The lip (front)
   * can take its own colour; the soffit is shaded. Ends are closed unless `open`.
   */
  ledge(runs, y0, y1, depth, o = {}) {
    const path = [];                                             // points with outward normals, joined across runs
    runs.forEach((r, ri) => r.pts.forEach((p, i) => {
      if (ri > 0 && i === 0) { const last = path[path.length - 1], nn = r.nrm[0]; let mx = last.n[0] + nn[0], mz = last.n[1] + nn[1]; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
        last.k = 1 / Math.max(0.5, mx * nn[0] + mz * nn[1]); last.n = [mx, mz]; return; }
      path.push({ p, n: r.nrm[i], k: 1, s: (path.length ? path[path.length - 1].s + Math.hypot(p[0] - path[path.length - 1].p[0], p[1] - path[path.length - 1].p[1]) : 0), smooth: r.curved });
    }));
    const closed = o.closed === true; if (closed) { const a = path[0], b = path[path.length - 1]; let mx = a.n[0] + b.n[0], mz = a.n[1] + b.n[1]; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml; const k = 1 / Math.max(0.5, mx * a.n[0] + mz * a.n[1]); a.n = b.n = [mx, mz]; a.k = b.k = k; }
    const keep = this._occ, np = path.length;
    const outer = path.map((q) => [q.p[0] + q.n[0] * depth * q.k, q.p[1] + q.n[1] * depth * q.k]);
    for (let i = 0; i < np - 1; i++) {
      const a = path[i].p, b = path[i + 1].p, c = outer[i + 1], d = outer[i];
      if (o.top !== false) this.quad([d[0], y1, d[1]], [c[0], y1, c[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]);
      if (o.bottom !== false) { this.m.occlusion(keep * (o.under ?? 0.5)); this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [c[0], y0, c[1]], [d[0], y0, d[1]]); this.m.occlusion(keep); }
      if (o.inner != null && o.inner < y1) this.quad([b[0], o.inner, b[1]], [a[0], o.inner, a[1]], [a[0], y1, a[1]], [b[0], y1, b[1]]);   // upstand above a roof: its roof-side face
    }
    if (!closed && !o.open) {
      const a = path[0].p, d = outer[0], b = path[np - 1].p, c = outer[np - 1];
      this.quad([a[0], y0, a[1]], [d[0], y0, d[1]], [d[0], y1, d[1]], [a[0], y1, a[1]]); this.quad([c[0], y0, c[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [c[0], y1, c[1]]);
    }
    if (o.lip) this.m.color(o.lip[0], o.lip[1], o.lip[2]);
    const base = this.m.count;                                   // the lip: smooth round arcs, creased at mitres
    for (let i = 0; i < np; i++) { const q = path[i], d = outer[i]; this.v(d[0], y0, d[1], q.n[0], 0, q.n[1], q.s, y0); this.v(d[0], y1, d[1], q.n[0], 0, q.n[1], q.s, y1); }
    for (let i = 0; i < np - 1; i++) { const a = base + i * 2; this.m.quad(a, a + 2, a + 3, a + 1); }
    return outer;
  }

  // ---- records
  /** Solid box collider in the current frame. */
  collide(x0, y0, z0, x1, y1, z1) {
    const c = this.P((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), T = this.T;
    this.colliders.push(c[0], c[1], c[2], Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2, Math.atan2(T[2], T[0]));
    return this;
  }
  /**
   * Ask for a plant from the flora catalogue at x, z of the current frame. The building does not draw it: the tile
   * builder instances the prototype (and takes its collider from the catalogue), so palms in a hotel court are the
   * same palms as on the avenue. tag: a catalogue tag such as 'royal', 'coconut', 'small', 'shrub', 'hedge'.
   */
  plant(tag, x, z, o = {}) {
    const p = this.P(x, 0, z);
    this.plants.push({ tag, x: p[0], y: o.y ?? 0, z: p[2], yaw: this.h(900 + this.plants.length) * 2 * Math.PI, scale: o.scale ?? 1, seed: hashInts(this.seed, 0x91a7, this.plants.length) });
    return this;
  }
  /**
   * A buried uplight at x, z shining up a wall or a trunk: a flush fitting, a narrow cone, a small glow. dir is the
   * aim (y up). The pool it makes is a metre or two wide and fades up the wall.
   */
  uplight(x, z, dir, color, o = {}) {
    if (!this.near) return this;
    const c = lin3(color), power = o.power ?? 7;
    this.steel([0.2, 0.2, 0.2], 0.5, 40).occ(1).box(x - 0.11, 0, z - 0.11, x + 0.11, 0.07, z + 0.11, 'xXzZ');
    this.lens(color, 10, CHANNEL.STREET).box(x - 0.08, 0.07, z - 0.08, x + 0.08, 0.075, z + 0.08, 'Y');
    this.light(x, 0.12, z, [c[0] * power, c[1] * power, c[2] * power], o.radius ?? 7, CHANNEL.STREET, { dir, outer: o.outer ?? 38, inner: o.inner ?? 16 });
    return this.glow(x, 0.12, z, 0.22, [c[0] * 2.5, c[1] * 2.5, c[2] * 2.5], CHANNEL.STREET);
  }
  /** Light record. color: linear rgb times intensity. spot: { dir: [x, y, z], outer, inner } (degrees). */
  light(x, y, z, color, radius, channel = CHANNEL.NEON, spot = null) {
    if (!this.near) return this;
    const p = this.P(x, y, z), rec = new Array(LIGHT_STRIDE).fill(0);
    rec[0] = p[0]; rec[1] = p[1]; rec[2] = p[2]; rec[3] = radius; rec[4] = color[0]; rec[5] = color[1]; rec[6] = color[2];
    if (spot) { const d = this.D(spot.dir[0], spot.dir[2]), l = Math.hypot(d[0], spot.dir[1], d[1]) || 1; rec[7] = 1; rec[8] = d[0] / l; rec[9] = spot.dir[1] / l; rec[10] = d[1] / l; rec[11] = Math.cos(spot.outer * Math.PI / 180); rec[12] = Math.cos(spot.inner * Math.PI / 180); }
    else { rec[9] = -1; rec[11] = -1; rec[12] = -1; }
    rec[13] = channel; rec[14] = (hashInts(this.seed, this.lights.length) & 1023) / 1023;
    this.lights.push(...rec); return this;
  }
  /** Glow record. color: linear rgb times intensity; kind 0 round, 1 star, 2 wide soft. `far`: kept at the far level too. */
  glow(x, y, z, size, color, channel = CHANNEL.NEON, kind = 0, far = false) {
    if (this.far && !far) return this;
    const p = this.P(x, y, z); this.glows.push(p[0], p[1], p[2], size, color[0], color[1], color[2], channel + 16 * kind); return this;
  }
  /**
   * The light of a lit ground floor falling out through its glazing: cones aimed out and down from inside the room
   * behind run `r` (band y0..y1), which reach the pavement and leave the wall they come through alone (it faces away).
   * They follow the window switch, as the rooms behind the glass do, and each has a faint wide glow on the glass
   * (near and mid levels): the bright front seen through the night air.
   */
  spill(r, y0, y1, power) {
    if (!(power > 0) || r.len < 2.5) return this;
    const n = Math.max(1, Math.round(r.len / SPILL_SPACING)), a = r.pts[0], b = r.pts[r.pts.length - 1], c = lin3(SPILL_COLOR), h = y0 + Math.min(2.5, (y1 - y0) * 0.7);
    const d = this.D(r.nx, r.nz), share = power * Math.min(1, r.len / SPILL_SPACING);
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t, q = this.P(x - r.nx * SPILL_INSET, h, z - r.nz * SPILL_INSET);
      if (this.near) this.spills.push([q[0], q[1], q[2], c[0] * share, c[1] * share, c[2] * share, 16 + Math.round(Math.atan2(d[0], d[1]) / (Math.PI / 8)), d[0], d[1]]);   // key: the way the front faces
      this.glow(x + r.nx * 0.1, y0 + (y1 - y0) * 0.45, z + r.nz * 0.1, Math.min(y1 - y0, 2.6), [c[0], c[1], c[2]], CHANNEL.WINDOW, 2); }
    return this;
  }
  /**
   * A small luminaire: lens disc facing down, with its light and glow at the same place. The light is a downward
   * cone unless `o.spot` aims it, and `o.power` is scaled by LAMP_GAIN unless `o.flood`: these fittings hang within
   * arm's reach of pale stucco, where the magnitudes of section 4.6 (meant for lamps metres from what they light)
   * turn the wall into a white patch.
   */
  lamp(x, y, z, color, o = {}) {
    const c = lin3(color), power = (o.power ?? 30) * (o.flood ? 1 : LAMP_GAIN), radius = o.radius ?? 7, ch = o.channel ?? CHANNEL.STREET, rad = o.radiance ?? 14, s = o.size ?? 0.12;
    if (this.near) { this.lens(color, rad, ch); this.box(x - s, y - 0.04, z - s, x + s, y, z + s, 'xXzZy'); }
    if (o.spot || o.flood) this.light(x, y - 0.1, z, [c[0] * power, c[1] * power, c[2] * power], radius, ch, { dir: o.spot ?? [0, -1, 0], outer: o.outer ?? 62, inner: o.inner ?? 35 });
    else if (this.near) { const q = this.P(x, y - 0.1, z); this.downlights.push([q[0], q[1], q[2], c[0] * power, c[1] * power, c[2] * power, ch, radius, o.outer ?? 62, o.inner ?? 35]); }
    this.glow(x, y - 0.05, z, o.glow ?? 0.6, [c[0] * rad * 0.5, c[1] * rad * 0.5, c[2] * rad * 0.5], ch, 0, !!o.far);
    return this;
  }
  /**
   * Neon tube along a 3D polyline. color: gas colour (sRGB). o.back: unit vector from the tube towards its wall
   * (stand-offs are drawn along it and the wash light sits on the other side). o.radiance 11..27, o.channel.
   * Near: a round tube on stand-offs. Mid: one flat ribbon of the same emitted power. Far: nothing but the glow.
   */
  neon(pts, color, o = {}) {
    const rad = o.radiance ?? 24, ch = o.channel ?? CHANNEL.NEON, back = o.back ?? [0, 0, -1], closed = o.closed === true, r = 0.007;
    const seg = []; let total = 0; const np = pts.length;
    for (let i = 0; i < (closed ? np : np - 1); i++) { const a = pts[i], b = pts[(i + 1) % np], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); seg.push(l); total += l; }
    if (this.near) {
      // the glass turns back into the wall at both ends of an open run, where the electrodes are
      const ret = (p) => [p[0] + back[0] * 0.045, p[1] + back[1] * 0.045, p[2] + back[2] * 0.045];
      this.solid(SOLID.NEON, color, radianceCode(rad), ch).pipe(closed || o.free ? pts : [ret(pts[0]), ...pts, ret(pts[np - 1])], r, 8, closed);
      // where a long run enters the wall its transformer feeds it: a small grey housing over the electrode
      if (!closed && !o.free && total > 3) { const e = ret(pts[0]); this.steel([0.42, 0.43, 0.44], 0.6, 70).occ(1).box(e[0] - 0.07, e[1] - 0.11, e[2] - 0.07, e[0] + 0.07, e[1] + 0.11, e[2] + 0.07, 'xXzZYy'); }
      this.bare(1, 0.4);                                        // stand-offs: a short post from the wall to the tube at every support
      const gap = 0.9; let run = gap * 0.5, acc = 0;
      for (let i = 0; i < seg.length; i++) { const a = pts[i], b = pts[(i + 1) % np];
        while (run < acc + seg[i]) { const t = (run - acc) / seg[i], p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], q = [p[0] + back[0] * 0.04, p[1] + back[1] * 0.04, p[2] + back[2] * 0.04];
          this.pipe([q, p], 0.006, 3); run += gap; }
        acc += seg[i]; }
    } else if (this.L === 1) {                                   // a ribbon five tube diameters wide at a fifth of the radiance, facing away from the wall
      this.emissive(color, rad * 0.22, ch); const w = 0.055;
      for (let i = 0; i < seg.length; i++) { const a = pts[i], b = pts[(i + 1) % np], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let sx = d[1] * back[2] - d[2] * back[1], sy = d[2] * back[0] - d[0] * back[2], sz = d[0] * back[1] - d[1] * back[0]; const sl = Math.hypot(sx, sy, sz) || 1; sx *= w / sl; sy *= w / sl; sz *= w / sl;
        const q = [[a[0] - sx, a[1] - sy, a[2] - sz], [b[0] - sx, b[1] - sy, b[2] - sz], [b[0] + sx, b[1] + sy, b[2] + sz], [a[0] + sx, a[1] + sy, a[2] + sz]];
        if (o.free) this.sheet(q[0], q[1], q[2], q[3], undefined, 1); else this.quad(q[0], q[1], q[2], q[3]); }   // free: nothing behind it, seen from both sides
    }
    // Wash: a neon tube lights the wall within a metre or two and fades. Point lights stand WASH_OFFSET off the
    // wall every WASH_SPACING at most, small enough that their pools overlap into one soft band along the tube and
    // weak enough that white stucco under them stays well below the tube's own brightness.
    const c = lin3(color), nl = Math.max(1, Math.ceil(total / WASH_SPACING)), power = WASH_POWER * Math.min(1, total / WASH_SPACING + 0.4) * (o.wash ?? 1);
    const at = (d) => { let acc = 0, i = 0; while (i < seg.length - 1 && acc + seg[i] < d) { acc += seg[i]; i++; }
      const a = pts[i], b = pts[(i + 1) % np], t = seg[i] > 0 ? clamp((d - acc) / seg[i], 0, 1) : 0; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
    if (o.lights !== false && this.near) for (let k = 0, n = Math.min(nl, o.maxLights ?? nl); k < n; k++) {
      const p = at(total * (k + 0.5) / n), q = this.P(p[0] - back[0] * WASH_OFFSET, p[1] - back[1] * WASH_OFFSET, p[2] - back[2] * WASH_OFFSET);
      this.washes.push([q[0], q[1], q[2], c[0] * power, c[1] * power, c[2] * power, ch]);
    }
    // Glow: the halo of the glass. A chain of small soft sprites close enough together to merge into one even band
    // along the run, so the tube reads as a glowing line and not as a hairline; it is also what the wet road and
    // the car bodies mirror, where the tube itself is thinner than a texel. Near: one every HALO_STEP. Mid: a
    // quarter as many, larger, carrying the same light per metre. Far: only what a caller keeps (`o.far`), sparse.
    const step = this.near ? HALO_STEP : this.mid ? HALO_STEP * 4 : 7, parts = Math.max(1, Math.round(total / step)), each = total / parts;
    const size = this.near ? HALO_SIZE : this.mid ? HALO_SIZE * 2 : clamp(0.3 + each * 0.06, 0.35, 0.7), gain = rad * (this.near ? HALO_GAIN : this.mid ? HALO_GAIN * 0.5 : 0.07);
    if (!this.far || o.far === true) for (let k = 0; k < parts; k++) { const p = at(each * (k + 0.5));
      this.glow(p[0] - back[0] * 0.05, p[1] - back[1] * 0.05, p[2] - back[2] * 0.05, size, [c[0] * gain, c[1] * gain, c[2] * gain], ch, 2, o.far === true); }
    return this;
  }
  /**
   * A sign face from the atlas in the current frame, on the plane z = z0 facing +z, centred on x. Give `height` or
   * `width`; the other follows from the sign's aspect (and `maxWidth` / `maxHeight` shrink it to fit).
   * category: pickSign category (or 'landmark:<id>'); variant: integer. Returns { width, height, entry } or null.
   */
  sign(category, variant, x, y, z0, o = {}) {
    // a landmark gives its own name to the stock building it is made of: `signMap` renames the request (false: no
    // sign); `o.own` keeps the request as it is, for a tenant inside the landmark
    if (this.signMap && !o.own) { const m = this.signMap(category, variant); if (m === false) return null; if (m) { category = m[0]; variant = m[1]; } }
    const e = pickSign(category, variant); if (!e) return null;
    let h = o.height ?? (o.width ?? 3) / e.aspect, w = h * e.aspect;
    if (o.maxWidth && w > o.maxWidth) { w = o.maxWidth; h = w / e.aspect; } if (o.maxHeight && h > o.maxHeight) { h = o.maxHeight; w = h * e.aspect; }
    const lit = o.lit ?? e.lit, code = lit ? (o.code ?? (e.emissiveCode > 1 ? e.emissiveCode : radianceCode(4))) : (e.decal ? 1 : 0), ch = o.channel ?? CHANNEL.NEON;
    const wall = o.wallColor ?? [1, 1, 1], col = e.decal ? wall : [1, 1, 1], [u0, v0, u1, v1] = e.uv, x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2;
    if (this.mid || o.far) {
      this.m.family(FAMILY.SOLID).material(SOLID.SIGN, code, ch, 110).color(col[0], col[1], col[2]).occlusion(1); this._occ = 1;
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [u0, v1, u1, v1, u1, v0, u0, v0]);
      if (o.double) {                                            // a free-standing cabinet: second face and a closed edge
        this.quad([x1, y0, z0 - o.double], [x0, y0, z0 - o.double], [x0, y1, z0 - o.double], [x1, y1, z0 - o.double], [u0, v1, u1, v1, u1, v0, u0, v0]);
        this.steel([0.2, 0.2, 0.21], 0.5, 40).box(x0, y0, z0 - o.double, x1, y1, z0, 'xXYy');
      }
    }
    if (lit) {
      const g = e.glow ?? [1, 0.8, 0.6], rad = 0.25 * Math.pow(2, code / 16), power = clamp(0.16 * rad * Math.sqrt(w * h), 0.35, 1.1);
      if (o.light !== false) this.light(x, y, z0 + WASH_OFFSET, [g[0] * power, g[1] * power, g[2] * power], clamp(2.4 + Math.max(w, h) * 0.5, 3, 5), ch);
      this.glow(x, y, z0 + 0.06, clamp(Math.max(w, h) * 0.5, 0.6, 2.5), [g[0] * rad * 0.15, g[1] * rad * 0.15, g[2] * rad * 0.15], ch, 2, o.far === true);
    }
    const p = this.P(x, y, z0), T = this.T;
    this.signs.push({ category, id: e.id, text: e.text, x: p[0], y: p[1], z: p[2], yaw: Math.atan2(T[2], T[3]), width: w, height: h, lit: !!lit });
    return { width: w, height: h, entry: e };
  }

  // ---- result
  triangles() { let n = 0; for (let f = 0; f < FAMILY.COUNT; f++) n += this.m.idxLen[f]; return n / 3; }
  /**
   * Turn the deferred light candidates into records. A building wrapped in tubes (parapet, eyebrows, fin and canopy
   * above one another) or a marquee with a bulb every metre would put more lights into one 8 m cell of the
   * renderer's grid than it holds, so candidates closer than a merge distance become one light at their centre and
   * the distance grows until the building is within a budget per metre of frontage. Every tube and fitting keeps
   * its own geometry and glow; only the light that falls on the surroundings is shared.
   */
  flushLights() {
    const merge = (cands, budget, reach0) => {
      budget = Math.max(budget, new Set(cands.map((w) => w[6])).size);          // candidates with different keys never merge
      for (let reach = reach0; ; reach *= 1.3) {
        const groups = [];
        for (const w of cands) {
          let best = null, bd = reach * reach;
          for (const g of groups) { if (g.ch !== w[6]) continue; const dx = g.x / g.n - w[0], dy = g.y / g.n - w[1], dz = g.z / g.n - w[2], d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = g; } }
          if (best) { best.x += w[0]; best.y += w[1]; best.z += w[2]; best.r += w[3]; best.g += w[4]; best.b += w[5]; best.n++; best.m.push(w); }
          else groups.push({ x: w[0], y: w[1], z: w[2], r: w[3], g: w[4], b: w[5], n: 1, ch: w[6], m: [w] });
        }
        if (groups.length <= budget) {
          for (const g of groups) { g.x /= g.n; g.y /= g.n; g.z /= g.n; g.spread = 0; for (const w of g.m) g.spread = Math.max(g.spread, Math.hypot(w[0] - g.x, w[1] - g.y, w[2] - g.z)); }
          return groups;
        }
      }
    };
    const front = this.lot.width ?? 16, T = this.T; this.T = [1, 0, 0, 1, 0, 0, 0];   // candidates are already in the lot frame
    // Neon wash: a merged light stands for n tubes over a wider patch, so its radius grows by the spread and its
    // power by sqrt(n), which keeps the wall under it at about the brightness the separate lights gave.
    if (this.washes.length) for (const g of merge(this.washes, clamp(Math.round(front * 0.55), 5, 34), 1.4)) {
      const k = 1 / Math.sqrt(g.n); this.light(g.x, g.y, g.z, [g.r * k, g.g * k, g.b * k], WASH_RADIUS + Math.min(g.spread, 3), g.ch);
    }
    // Downlights: the floor below receives the sum of the fittings.
    if (this.downlights.length) for (const g of merge(this.downlights, clamp(Math.round(front * 0.25), 3, 24), 0.8)) {
      const w = g.m[0]; this.light(g.x, g.y, g.z, [g.r, g.g, g.b], w[7] + Math.min(g.spread, 2), g.ch, { dir: [0, -1, 0], outer: w[8], inner: w[9] });
    }
    // Glazing spill: neighbouring fronts share a cone; its axis is the mean of theirs, 30 degrees below level.
    if (this.spills.length) for (const g of merge(this.spills, clamp(Math.round(front * 0.2), 3, 12), 3)) {
      let dx = 0, dz = 0; for (const w of g.m) { dx += w[7]; dz += w[8]; } const l = Math.hypot(dx, dz); if (l < 1e-3) continue;
      const k = 1 / Math.sqrt(g.n); this.light(g.x, g.y, g.z, [g.r * k, g.g * k, g.b * k], SPILL_RADIUS + Math.min(g.spread, 3), CHANNEL.WINDOW, { dir: [dx / l * 0.87, -0.5, dz / l * 0.87], outer: 72, inner: 36 });
    }
    this.washes = []; this.downlights = []; this.spills = []; this.T = T;
  }
  result() {
    this.flushLights(); this.m.family(FAMILY.SOLID);
    return { mesh: this.m, lights: new Float32Array(this.lights), glows: new Float32Array(this.glows), colliders: new Float32Array(this.colliders), signs: this.signs, plants: this.plants, height: this.height, triangles: this.triangles() };
  }
}

/** World-space copies of a result's lights, glows and collider boxes for a lot placed at groundY. */
export function placeRecords(result, lot, groundY, out = { lights: [], glows: [], boxes: [] }) {
  const c = Math.cos(lot.yaw), s = Math.sin(lot.yaw), X = (x, z) => lot.x + x * c + z * s, Z = (x, z) => lot.z - x * s + z * c;
  const L = result.lights, G = result.glows, C = result.colliders;
  for (let i = 0; i < L.length; i += LIGHT_STRIDE) {
    const o = out.lights.length; for (let k = 0; k < LIGHT_STRIDE; k++) out.lights.push(L[i + k]);
    out.lights[o] = X(L[i], L[i + 2]); out.lights[o + 1] = L[i + 1] + groundY; out.lights[o + 2] = Z(L[i], L[i + 2]);
    if (L[i + 7] > 0.5) { out.lights[o + 8] = L[i + 8] * c + L[i + 10] * s; out.lights[o + 10] = -L[i + 8] * s + L[i + 10] * c; }
  }
  for (let i = 0; i < G.length; i += GLOW_STRIDE) out.glows.push(X(G[i], G[i + 2]), G[i + 1] + groundY, Z(G[i], G[i + 2]), G[i + 3], G[i + 4], G[i + 5], G[i + 6], G[i + 7]);
  for (let i = 0; i < C.length; i += 7) out.boxes.push(X(C[i], C[i + 2]), C[i + 1] + groundY, Z(C[i], C[i + 2]), C[i + 3], C[i + 4], C[i + 5], C[i + 6] + lot.yaw);
  return out;
}
