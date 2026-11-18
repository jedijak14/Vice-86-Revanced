// Modelling kit for props: a thin layer over MeshBuilder with the primitives street furniture is made of
// (tapered tubes, bevelled bars, lathes, extrusions, shells), baked-occlusion passes, and the bookkeeping
// that keeps every lamp honest: a fixture registers its light and glow at the position of its lens.
//
// One Kit builds one level of detail of one prototype. Builders are written once and run per level:
// `k.n(24)` scales curve tessellation with the level, `k.lod` gates the small parts.
//
// Conventions: metres, +Y up, the prop stands on y = 0, its front is +Z. Triangles are counter-clockwise
// seen from outside. Open sheets are emitted on both sides (`twoSided`) so no back face is ever visible.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, SOLID, GLASS, CHANNEL, LIGHT_STRIDE, GLOW_STRIDE } from '../../core/ids.js';
import { clamp, smoothstep } from '../../core/math.js';

// ---------------------------------------------------------------- small vector helpers (arrays of 3)
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vmul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vmad = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vlerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Unit vector perpendicular to the unit vector `t`, as close to `hint` as possible. */
export function perpendicular(t, hint = [0, 1, 0]) {
  let h = hint, d = vdot(t, h);
  if (Math.abs(d) > 0.999) { h = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]; d = vdot(t, h); }
  return vnorm(vmad(h, t, -d));
}

/** Column-major placement matrix: yaw about Y, then pitch about the local X, then translation. */
export function place(x, y, z, yaw = 0, pitch = 0, roll = 0) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Ry(yaw) * Rx(pitch) * Rz(roll)
  const m = new Float32Array(16);
  m[0] = cy * cr + sy * sp * sr; m[1] = cp * sr; m[2] = -sy * cr + cy * sp * sr;
  m[4] = -cy * sr + sy * sp * cr; m[5] = cp * cr; m[6] = sy * sr + cy * sp * cr;
  m[8] = sy * cp; m[9] = -sp; m[10] = cy * cp;
  m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
  return m;
}
const xformPoint = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const xformDir = (m, d) => [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];

/** SOLID intensity code for an emitted radiance in scene units: radiance = 0.25 * 2^(code / 16). */
export const radianceCode = (radiance) => (radiance <= 0 ? 0 : clamp(Math.round(16 * Math.log2(radiance / 0.25)), 2, 255));

/** Ear-clipping triangulation of a simple polygon given as [[u, v], ...] in counter-clockwise order. Returns index triples. */
export function triangulate(poly) {
  const n = poly.length, idx = [], out = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const area = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  const inside = (p, a, b, c) => area(a, b, p) >= -1e-12 && area(b, c, p) >= -1e-12 && area(c, a, p) >= -1e-12;
  let guard = n * n + 8;
  while (idx.length > 3 && guard-- > 0) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length], a = poly[ia], b = poly[ib], c = poly[ic];
      if (area(a, b, c) <= 1e-12) continue;                       // reflex or degenerate corner
      let ear = true;
      for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inside(poly[j], a, b, c)) { ear = false; break; } }
      if (!ear) continue;
      out.push(ia, ib, ic); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) idx.splice(0, 1);                                    // numerically stuck (collinear run): drop a vertex and carry on
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

const KEY = [255, 0, 255];   // vertex colour that the SOLID shader replaces with the instance tint palette

// Reflecting surfaces outdoors never reach the corners of the colour cube: fresh white paint reflects about 80 % and
// even a new safety colour has a few percent of the other primaries in it. Every albedo passes through here so that
// no prop can glow in the sun like a toy: value is capped at 0.89 sRGB (0.77 linear), saturation at 0.8.
const MAX_VALUE = 0.89, MAX_SATURATION = 0.8;
function outdoor(c) {
  let r = c[0], g = c[1], b = c[2];
  const hi = Math.max(r, g, b);
  if (hi > MAX_VALUE) { const s = MAX_VALUE / hi; r *= s; g *= s; b *= s; }
  const top = Math.max(r, g, b), floor = top * (1 - MAX_SATURATION);
  return [Math.max(r, floor), Math.max(g, floor), Math.max(b, floor)];
}
const SELF_LIT = new Set([SOLID.EMISSIVE, SOLID.NEON, SOLID.LAMP_LENS, SOLID.SIGN]);

export class Kit {
  /** lod: 0 near, 1 mid, 2 far. detail: 0 low, 1 medium, 2 high (from the density setting). */
  constructor(lod = 0, detail = 2, seed = 1, nearTess = 1.6) {
    this.b = new MeshBuilder(4096);
    this.lod = lod; this.detail = detail; this.nearTess = nearTess;
    // Near props stand at arm's length from the camera: round things get enough segments to have a round silhouette.
    // Lamps and signals carry most of their curves well above eye level and stand every few metres along a road,
    // so their definitions ask for less (`nearTess`) and stay inside the triangle budget of section 12.
    this.tess = [nearTess, 0.55, 0.26][lod] * [0.62, 0.8, 1][detail];
    this.seedByte = seed & 255;
    this.lights = []; this.glows = []; this.lenses = []; this.anchors = [];
  }
  /** An empty kit at the same level, detail, seed and tessellation, for a part that is built apart and placed with add(). */
  child() { return new Kit(this.lod, this.detail, this.seedByte, this.nearTess); }
  /** Segment count for a curve that wants `count` segments at full detail. */
  n(count, min = 4) { return Math.max(min, Math.round(count * this.tess)); }
  get near() { return this.lod === 0; }
  get mid() { return this.lod <= 1; }

  // ------------------------------------------------------------ materials (colours are sRGB 0..1, amounts 0..1)
  _m(id, raw, p0, p1, p2) { const color = SELF_LIT.has(id) ? raw : outdoor(raw); this.b.family(FAMILY.SOLID).material(id, p0, p1, p2 === undefined ? this.seedByte : (this.seedByte + p2) & 255).color(color[0], color[1], color[2]).occlusion(1); return this; }
  paint(color, rough = 0.55, weather = 0.25, s) { return this._m(SOLID.PAINT, color, rough * 255, weather * 255, s); }
  concrete(color, jointDm = 0, weather = 0.4, s) { return this._m(SOLID.CONCRETE, color, jointDm, weather * 255, s); }
  stucco(color, texture = 0.5, weather = 0.35, s) { return this._m(SOLID.STUCCO, color, texture * 255, weather * 255, s); }
  steel(color, rough = 0.5, rust = 0.15, s) { return this._m(SOLID.METAL_PAINTED, color, rough * 255, rust * 255, s); }
  /** kind: 0 chrome, 1 aluminium, 2 galvanised, 3 brass. */
  bare(kind, rough = 0.35, color = [1, 1, 1], s) { return this._m(SOLID.METAL_BARE, color, rough * 255, kind, s); }
  darkGlass(color = [0.1, 0.12, 0.13], rough = 0.08, tint = 0.6, s) { return this._m(SOLID.DARK_GLASS, color, rough * 255, tint * 255, s); }
  wood(color, rough = 0.75, weather = 0.4, s) { return this._m(SOLID.WOOD, color, rough * 255, weather * 255, s); }
  rubber(color = [0.05, 0.05, 0.05], rough = 0.85, s) { return this._m(SOLID.RUBBER, color, rough * 255, 0, s); }
  plastic(color, rough = 0.45, s) { return this._m(SOLID.PLASTIC, color, rough * 255, 0, s); }
  /** pattern: 0 plain, 1 wide stripes, 2 narrow stripes, 3 checks. */
  fabric(color, pattern = 0, second = 4, s) { return this._m(SOLID.FABRIC, color, pattern, second, s); }
  roof(color, kind = 2, weather = 0.3, s) { return this._m(SOLID.ROOF, color, kind, weather * 255, s); }
  /** Luminaire lens: glassy by day, emits `radiance` when its channel is on (radiance 0 = never lit). */
  lens(color, radiance, channel = CHANNEL.STREET, s) { return this._m(SOLID.LAMP_LENS, color, radianceCode(radiance), channel, s); }
  neon(color, radiance, channel = CHANNEL.NEON, s) { return this._m(SOLID.NEON, color, radianceCode(radiance), channel, s); }
  emissive(color, radiance, channel = CHANNEL.ALWAYS, s) { return this._m(SOLID.EMISSIVE, color, radianceCode(radiance), channel, s); }
  /** Sign face. code: 0 painted, 1 decal over the vertex colour, >= 2 lit (use the atlas entry's emissiveCode). */
  signFace(code = 0, channel = CHANNEL.NEON, rough = 0.5, color = [1, 1, 1]) { this.b.family(FAMILY.SOLID).material(SOLID.SIGN, code, channel, rough * 255).color(color[0], color[1], color[2]).occlusion(1); return this; }
  /** Colour taken from the instance tint palette instead of the vertex colour (keeps the current material). */
  tintKey() { this.b.color(1, 0, 1); return this; }
  /** Forward-blended clear glass pane (GLASS family). */
  clearGlass() { this.b.family(FAMILY.GLASS).material(GLASS.CLEAR, 0, 0, this.seedByte).color(0.85, 0.92, 0.9).occlusion(1); return this; }
  /** Forward-blended bronze-tinted pane (acrylic shelter walls). */
  tintedGlass() { this.b.family(FAMILY.GLASS).material(GLASS.TINTED, 0, 0, this.seedByte).color(0.42, 0.33, 0.24).occlusion(1); return this; }
  occ(a) { this.b.occlusion(a); return this; }

  // ------------------------------------------------------------ ranges
  /** Remember where the mesh is now; pass the result to the range operations below. */
  mark() { return { v: this.b.count, i: this.b.idxLen.slice() }; }

  /**
   * Emit the triangles added since `mark` again with reversed winding and normals, so an open sheet
   * (a visor, a fabric panel, a sign blade) shows a proper surface from both sides. `inner(k)` may set a
   * different material/colour for the copy (it is applied to the copied vertices). The copy is offset by `thickness`
   * and, unless `rim` is false, the free edges of the sheet are closed with a strip, so the result is a thin solid:
   * no face ever shares a depth with its twin and no slit shows between them.
   */
  twoSided(mark, inner = null, thickness = 0.003, rim = true) {
    const b = this.b, n = b.count - mark.v, base = b.count;
    let c = null, m = null;
    if (inner) { inner(this); c = b._c.slice(); m = b._m.slice(); }
    const spot = (v) => `${Math.round(b.pos[v * 3] * 2e4)},${Math.round(b.pos[v * 3 + 1] * 2e4)},${Math.round(b.pos[v * 3 + 2] * 2e4)}`;
    // Vertices that share a position (split by a hard crease) must move together or the copy opens a slit along the
    // crease: offset each position along the mean of its normals, lengthened so the faces still end up `thickness` apart.
    const mean = new Map(), unit = (v) => { const p = v * 3, l = Math.hypot(b.nrm[p], b.nrm[p + 1], b.nrm[p + 2]) || 1; return [b.nrm[p] / l, b.nrm[p + 1] / l, b.nrm[p + 2] / l]; };
    for (let i = 0; i < n; i++) { const key = spot(mark.v + i), u = unit(mark.v + i), e = mean.get(key); if (e) { e[0] += u[0]; e[1] += u[1]; e[2] += u[2]; e[3]++; } else mean.set(key, [u[0], u[1], u[2], 1]); }
    for (const e of mean.values()) { const l = Math.hypot(e[0], e[1], e[2]) || 1, cos = Math.max(0.4, l / e[3]), f = thickness / (l * cos); e[0] *= f; e[1] *= f; e[2] *= f; }
    for (let i = 0; i < n; i++) {
      const s = mark.v + i, p = s * 3, q = s * 4, o = mean.get(spot(s));
      const nx = b.nrm[p], ny = b.nrm[p + 1], nz = b.nrm[p + 2];
      const v = b.vertex(b.pos[p] - o[0], b.pos[p + 1] - o[1], b.pos[p + 2] - o[2], -nx, -ny, -nz, b.uv[s * 2], b.uv[s * 2 + 1]);
      for (let k = 0; k < 4; k++) { b.col[v * 4 + k] = c ? (k < 3 ? c[k] : b.col[q + 3]) : b.col[q + k]; b.mat[v * 4 + k] = m ? m[k] : b.mat[q + k]; }
    }
    const keep = b._family, edges = new Map();
    for (let f = 0; f < FAMILY.COUNT; f++) {
      const from = mark.i[f], to = b.idxLen[f]; if (to === from) continue;
      b.family(f);
      for (let t = from; t < to; t += 3) {
        const ix = b.idx[f], tri = [ix[t], ix[t + 1], ix[t + 2]];
        b.tri(tri[0] - mark.v + base, tri[2] - mark.v + base, tri[1] - mark.v + base);
        if (rim) for (let e = 0; e < 3; e++) { const a = tri[e], d = tri[(e + 1) % 3], ka = spot(a), kd = spot(d); if (edges.has(kd + '|' + ka)) edges.delete(kd + '|' + ka); else edges.set(ka + '|' + kd, [a, d, f]); }
      }
    }
    // free edges (used by one triangle only): bridge the sheet to its copy, facing away from the sheet's interior
    for (const [a, d, f] of edges.values()) {
      b.family(f);
      const at = (v) => [b.pos[v * 3], b.pos[v * 3 + 1], b.pos[v * 3 + 2]], A = at(a), D = at(d), A2 = at(a - mark.v + base), D2 = at(d - mark.v + base);
      const nr = vcross(vsub(A, D), vsub(A2, A)), first = b.count;
      for (const [P, src] of [[D, d], [A, a], [A2, a], [D2, d]]) { const v = b.vertex(P[0], P[1], P[2], nr[0], nr[1], nr[2], b.uv[src * 2], b.uv[src * 2 + 1]); for (let k = 0; k < 4; k++) { b.col[v * 4 + k] = b.col[src * 4 + k]; b.mat[v * 4 + k] = b.mat[src * 4 + k]; } }
      b.quad(first, first + 1, first + 2, first + 3);
    }
    b.family(keep);
    return this;
  }

  /** Multiply the baked occlusion of every vertex added since `mark` by fn(x, y, z) (0 dark .. 1 open). */
  shade(mark, fn) {
    const b = this.b;
    for (let i = mark.v; i < b.count; i++) { const a = b.col[i * 4 + 3] / 255 * fn(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]); b.col[i * 4 + 3] = clamp(Math.round(a * 255), 0, 255); }
    return this;
  }
  /** Move every vertex added since `mark` vertically by fn(x, z): lays flat work onto a gently sloping surface. */
  settle(mark, fn) { const b = this.b; for (let i = mark.v; i < b.count; i++) b.pos[i * 3 + 1] += fn(b.pos[i * 3], b.pos[i * 3 + 2]); return this; }
  /** Scale the baked occlusion of every vertex from index `from` on (the inside copy of a canopy, a shaded underside). */
  dim(from, factor) { const b = this.b; for (let i = from; i < b.count; i++) b.col[i * 4 + 3] = Math.round(b.col[i * 4 + 3] * factor); return this; }
  /** Contact darkening towards the plane y = y0 (the ground, a deck, a catwalk). */
  ground(mark, height = 0.3, strength = 0.5, y0 = 0) { return this.shade(mark, (x, y) => 1 - strength * (1 - smoothstep(0, height, Math.abs(y - y0)))); }
  /** Darkening around a point where two parts meet. */
  joint(mark, c, radius, strength = 0.45) { return this.shade(mark, (x, y, z) => 1 - strength * (1 - smoothstep(0, radius, Math.hypot(x - c[0], y - c[1], z - c[2])))); }
  /** Darkening just below a horizontal plane (under a roof, a cap, a lid). */
  under(mark, yPlane, depth = 0.3, strength = 0.5) { return this.shade(mark, (x, y) => (y > yPlane ? 1 : 1 - strength * (1 - smoothstep(0, depth, yPlane - y)))); }

  /** Blend the vertex colour of everything since `mark` towards `tint` by fn(x, y, z) (grime that follows the object's logic). */
  grime(mark, fn, tint = [0.16, 0.14, 0.12]) {
    const b = this.b;
    for (let i = mark.v; i < b.count; i++) {
      const q = i * 4, id = b.mat[q];
      if (id === SOLID.SIGN || id === SOLID.EMISSIVE || id === SOLID.NEON || id === SOLID.LAMP_LENS) continue;
      if (b.col[q] === KEY[0] && b.col[q + 1] === KEY[1] && b.col[q + 2] === KEY[2]) continue;      // tint-keyed vertices must stay exact
      const t = clamp(fn(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]), 0, 1);
      for (let k = 0; k < 3; k++) b.col[q + k] = Math.round(b.col[q + k] + (tint[k] * 255 - b.col[q + k]) * t);
      if (b.col[q] === 255 && b.col[q + 1] === 0 && b.col[q + 2] === 255) b.col[q + 1] = 1;            // never create the key by accident
    }
    return this;
  }

  // ------------------------------------------------------------ primitives
  /** One-sided flat quad, corners counter-clockwise seen from the side it faces. uvs as MeshBuilder.flatQuad. */
  quad(p0, p1, p2, p3, uvs) { this.b.flatQuad(p0, p1, p2, p3, uvs); return this; }
  tri(p0, p1, p2) {
    const u = vsub(p1, p0), v = vsub(p2, p0), n = vcross(u, v), b = this.b;
    const a = b.vertex(p0[0], p0[1], p0[2], n[0], n[1], n[2]); b.vertex(p1[0], p1[1], p1[2], n[0], n[1], n[2]); b.vertex(p2[0], p2[1], p2[2], n[0], n[1], n[2]); b.tri(a, a + 1, a + 2);
    return this;
  }
  /**
   * Flat rectangle from a centre, a unit `right` and a unit `up` (it faces right x up).
   * uv spans [u0, v0] at the top-left to [u1, v1] at the bottom-right, the atlas convention; default is metres.
   */
  panel(c, right, up, w, h, uv = null) {
    const r = vmul(right, w / 2), u = vmul(up, h / 2), t = uv || [0, h, w, 0];
    return this.quad(vsub(vsub(c, r), u), vsub(vadd(c, r), u), vadd(vadd(c, r), u), vadd(vsub(c, r), u), [t[0], t[3], t[2], t[3], t[2], t[1], t[0], t[1]]);
  }

  /**
   * Tube along a polyline with parallel-transported rings. `radius`: number, array per point, or fn(i).
   * opts: capA, capB (flat end discs), up (hint for the ring's first direction).
   * uv = (metres along the path, metres around).
   */
  tube(points, radius, n = 12, opts = {}) {
    const b = this.b, m = points.length, rad = (i) => (typeof radius === 'number' ? radius : Array.isArray(radius) ? radius[i] : radius(i));
    // At a bend the ring lies in the mitre plane: its axis bisects the two segment directions (the chord between the
    // neighbours is not the bisector when the segments differ in length, and a ring set square to it shears the
    // shorter segment flat), and it is stretched along the bend so each segment keeps its full radius.
    const dir = (i) => vnorm(vsub(points[i + 1], points[i]));
    const tan = (i) => (i === 0 ? dir(0) : i === m - 1 ? dir(m - 2) : vnorm(vadd(dir(i - 1), dir(i))));
    // The ring's reference direction is carried from one ring to the next by the smallest rotation that turns the old
    // axis into the new one. (Projecting it onto the new ring plane instead twists the tube wherever a bend is sharp.)
    const carry = (v, t0, t1) => {
      const ax = vcross(t0, t1), sn = vlen(ax), cs = vdot(t0, t1);
      if (sn < 1e-6) return v;
      const u = vmul(ax, 1 / sn);
      return vnorm(vadd(vadd(vmul(v, cs), vmul(vcross(u, v), sn)), vmul(u, vdot(u, v) * (1 - cs))));
    };
    let N = perpendicular(tan(0), opts.up), T0 = tan(0), s = 0; const base = b.count, rings = [];
    for (let i = 0; i < m; i++) {
      const T = tan(i); N = carry(N, T0, T); T0 = T; const B = vcross(T, N), r = rad(i), P = points[i];
      let M = null, stretch = 0;
      if (i > 0 && i < m - 1) {
        const across = vsub(dir(i), dir(i - 1)), bend = vlen(across);
        if (bend > 1e-4) { M = vmul(across, 1 / bend); stretch = Math.min(3, 1 / Math.max(1e-3, vdot(T, dir(i)))) - 1; }
      }
      if (i > 0) s += vlen(vsub(P, points[i - 1]));
      const ds = i < m - 1 ? vlen(vsub(points[i + 1], P)) : vlen(vsub(P, points[i - 1])), slope = i < m - 1 ? (rad(i + 1) - r) / (ds || 1) : (r - rad(i - 1)) / (ds || 1);
      rings.push({ T, N, B, r, P });
      for (let j = 0; j <= n; j++) {
        const a = j / n * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), dx = N[0] * ca + B[0] * sa, dy = N[1] * ca + B[1] * sa, dz = N[2] * ca + B[2] * sa;
        const q = M ? (dx * M[0] + dy * M[1] + dz * M[2]) * stretch * r : 0;
        b.vertex(P[0] + dx * r + (M ? M[0] * q : 0), P[1] + dy * r + (M ? M[1] * q : 0), P[2] + dz * r + (M ? M[2] * q : 0), dx - T[0] * slope, dy - T[1] * slope, dz - T[2] * slope, s, j / n * Math.PI * 2 * r);
      }
    }
    const w = n + 1;
    for (let i = 0; i < m - 1; i++) for (let j = 0; j < n; j++) { const a = base + i * w + j; b.quad(a, a + 1, a + w + 1, a + w); }
    const cap = (ring, dir) => {
      const { T, N, B, r, P } = ring, c = b.vertex(P[0], P[1], P[2], T[0] * dir, T[1] * dir, T[2] * dir, 0, 0), f = b.count;
      for (let j = 0; j < n; j++) { const a = j / n * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a); b.vertex(P[0] + (N[0] * ca + B[0] * sa) * r, P[1] + (N[1] * ca + B[1] * sa) * r, P[2] + (N[2] * ca + B[2] * sa) * r, T[0] * dir, T[1] * dir, T[2] * dir, ca * r, sa * r); }
      for (let j = 0; j < n; j++) { const a = f + j, c2 = f + (j + 1) % n; if (dir > 0) b.tri(c, a, c2); else b.tri(c, c2, a); }
    };
    if (opts.capA) cap(rings[0], -1);
    if (opts.capB) cap(rings[m - 1], 1);
    return this;
  }
  /** Cylinder or cone frustum from a to b. opts: capA, capB, stops (extra rings at fractions 0..1, for occlusion gradients). */
  cyl(a, b, r0, r1 = r0, n = 12, opts = {}) {
    const ts = [0, ...(opts.stops || []), 1], pts = ts.map((t) => vlerp(a, b, t)), rs = ts.map((t) => r0 + (r1 - r0) * t);
    return this.tube(pts, rs, n, opts);
  }

  /**
   * Surface of revolution about `axis` through `origin`. profile: [[h, r], ...] traced so that the outside is on the
   * left of the direction of travel in the (r, h) plane: up an outer wall, inwards across a top, down an inner wall.
   * Profile corners sharper than `crease` degrees stay hard. opts: crease (default 35), a0, a1 (partial sweep, radians), up.
   */
  lathe(origin, axis, profile, n = 16, opts = {}) {
    const b = this.b, A = vnorm(axis), N = perpendicular(A, opts.up || [0, 0, 1]), B = vcross(A, N);
    const a0 = opts.a0 ?? 0, a1 = opts.a1 ?? Math.PI * 2, cosC = Math.cos((opts.crease ?? 35) * Math.PI / 180), m = profile.length;
    const segN = [];
    for (let i = 0; i < m - 1; i++) { const dh = profile[i + 1][0] - profile[i][0], dr = profile[i + 1][1] - profile[i][1], l = Math.hypot(dh, dr) || 1; segN.push([dh / l, -dr / l]); }   // [radial part, axial part]
    // one ring per profile point, two where the profile has a crease
    const rows = [];
    let dist = 0;
    for (let i = 0; i < m; i++) {
      if (i > 0) dist += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
      const prev = segN[i - 1], next = segN[i];
      if (prev && next && prev[0] * next[0] + prev[1] * next[1] >= cosC) rows.push({ i, n: [prev[0] + next[0], prev[1] + next[1]], d: dist });
      else { if (prev) rows.push({ i, n: prev, d: dist }); if (next) rows.push({ i, n: next, d: dist, start: !!prev }); }
    }
    const base = b.count, w = n + 1;
    for (const row of rows) {
      const [h, r] = profile[row.i];
      for (let j = 0; j <= n; j++) {
        const a = a0 + (a1 - a0) * j / n, ca = Math.cos(a), sa = Math.sin(a), dx = N[0] * ca + B[0] * sa, dy = N[1] * ca + B[1] * sa, dz = N[2] * ca + B[2] * sa;
        b.vertex(origin[0] + A[0] * h + dx * r, origin[1] + A[1] * h + dy * r, origin[2] + A[2] * h + dz * r,
          dx * row.n[0] + A[0] * row.n[1], dy * row.n[0] + A[1] * row.n[1], dz * row.n[0] + A[2] * row.n[1], row.d, a * Math.max(r, 0.02));
      }
    }
    for (let k = 0; k < rows.length - 1; k++) {
      if (rows[k + 1].start) continue;                             // the second ring of a crease starts a new strip
      const r0 = profile[rows[k].i][1], r1 = profile[rows[k + 1].i][1];
      for (let j = 0; j < n; j++) {
        const a = base + k * w + j, c = a + w;
        if (r0 > 1e-6 && r1 > 1e-6) b.quad(a, a + 1, c + 1, c); else if (r0 > 1e-6) b.tri(a, a + 1, c); else if (r1 > 1e-6) b.tri(a, c + 1, c);
      }
    }
    return this;
  }

  /** Ellipsoid (or a latitude band of one: v0, v1 in -0.5..0.5 from bottom pole to top pole). */
  ellipsoid(c, rx, ry, rz, n = 16, m = 8, opts = {}) {
    const v0 = opts.v0 ?? -0.5, v1 = opts.v1 ?? 0.5;
    this.b.grid(m, n, (i, j, o) => {
      const lat = (v0 + (v1 - v0) * i / m) * Math.PI, lon = j / n * Math.PI * 2, cl = Math.cos(lat), sl = Math.sin(lat), x = cl * Math.cos(lon), z = -cl * Math.sin(lon);
      o.x = c[0] + x * rx; o.y = c[1] + sl * ry; o.z = c[2] + z * rz; o.nx = x / rx; o.ny = sl / ry; o.nz = z / rz; o.u = j / n; o.v = i / m;
    });
    return this;
  }

  /**
   * Bar with a rectangular section (width w across `side`, height h across `up`) from a to b: beams, slats, plates,
   * posts, boxes. opts: up (hint), r (edge bevel in metres; default a few millimetres at the near level, 0 = sharp), stops (fractions for extra rings),
   * capA, capB (default true). uv = (metres along the bar, metres around), so wood grain runs along it.
   */
  bar(a, b2, w, h, opts = {}) {
    const b = this.b, axis = vsub(b2, a), L = vlen(axis), T = vnorm(axis), U = perpendicular(T, opts.up || [0, 1, 0]), S = vcross(U, T);
    // Nothing manufactured has a knife edge: up close every bar gets at least a small chamfer unless it is sheet-thin.
    const thin = Math.min(w, h, L), auto = this.near && this.detail > 0 && thin >= 0.012 ? clamp(thin * 0.1, 0.0015, 0.005) : 0;     // the low setting keeps its edges sharp
    const r = Math.min(opts.r ?? auto, w * 0.45, h * 0.45, L * 0.45), capA = opts.capA !== false, capB = opts.capB !== false, hw = w / 2, hh = h / 2;
    const at = (s, x, y) => [a[0] + T[0] * s + S[0] * x + U[0] * y, a[1] + T[1] * s + S[1] * x + U[1] * y, a[2] + T[2] * s + S[2] * x + U[2] * y];
    const stops = [0, ...(opts.stops || []).map((t) => t * L), L];
    if (r <= 0) {
      // sharp: four flat sides (split at the stops) and two caps
      const sides = [[[-hw, -hh], [hw, -hh]], [[hw, -hh], [hw, hh]], [[hw, hh], [-hw, hh]], [[-hw, hh], [-hw, -hh]]];
      let v = 0;
      for (const [p, q] of sides) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        for (let k = 0; k < stops.length - 1; k++) this.quad(at(stops[k], p[0], p[1]), at(stops[k], q[0], q[1]), at(stops[k + 1], q[0], q[1]), at(stops[k + 1], p[0], p[1]), [stops[k], v, stops[k], v + d, stops[k + 1], v + d, stops[k + 1], v]);
        v += d;
      }
      if (capA) this.quad(at(0, hw, -hh), at(0, -hw, -hh), at(0, -hw, hh), at(0, hw, hh), [w, 0, 0, 0, 0, h, w, h]);
      if (capB) this.quad(at(L, -hw, -hh), at(L, hw, -hh), at(L, hw, hh), at(L, -hw, hh), [0, 0, w, 0, w, h, 0, h]);
      return this;
    }
    // Bevelled. The flat faces keep their own normal and each chamfer strip runs between the normals of the two faces
    // it joins, so a three-millimetre chamfer shades like a rolled edge and catches a highlight while the faces stay
    // flat. (Averaging normals over the whole section instead makes every plate look like a cushion.)
    const dir = (x, y, t) => [S[0] * x + U[0] * y + T[0] * t, S[1] * x + U[1] * y + T[1] * t, S[2] * x + U[2] * y + T[2] * t];
    const put = (s, p, n, u, v) => { const q = at(s, p[0], p[1]); return b.vertex(q[0], q[1], q[2], n[0], n[1], n[2], u, v); };
    const four = (i0) => b.quad(i0, i0 + 1, i0 + 2, i0 + 3);
    const corner = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], N2 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const run = (i) => { const c0 = corner[i], c1 = corner[(i + 1) % 4]; return [Math.sign(c1[0] - c0[0]), Math.sign(c1[1] - c0[1])]; };
    const from = (i) => { const d = run(i); return [corner[i][0] + d[0] * r, corner[i][1] + d[1] * r]; };                 // where side i starts
    const upto = (i) => { const d = run(i), c = corner[(i + 1) % 4]; return [c[0] - d[0] * r, c[1] - d[1] * r]; };        // where it ends
    const inset = (p, i) => [p[0] - N2[i][0] * r, p[1] - N2[i][1] * r];
    const sA = capA ? r : 0, sB = capB ? L - r : L, rings = [sA, ...stops.slice(1, -1).filter((t) => t > sA + 1e-6 && t < sB - 1e-6), sB];
    const nA = dir(0, 0, -1), nB = dir(0, 0, 1), chamfer = r * Math.SQRT2;
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const i2 = (i + 1) % 4, p = from(i), q = upto(i), p2 = from(i2), n = dir(N2[i][0], N2[i][1], 0), n2 = dir(N2[i2][0], N2[i2][1], 0);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      for (let k = 0; k < rings.length - 1; k++) {
        const s0 = rings[k], s1 = rings[k + 1];
        four(put(s0, p, n, s0, v)); put(s0, q, n, s0, v + d); put(s1, q, n, s1, v + d); put(s1, p, n, s1, v);                  // the face
        four(put(s0, q, n, s0, v + d)); put(s0, p2, n2, s0, v + d + chamfer); put(s1, p2, n2, s1, v + d + chamfer); put(s1, q, n, s1, v + d);   // its edge
      }
      if (capB) {
        const c = inset(q, i);
        four(put(sB, p, n, sB, v)); put(sB, q, n, sB, v + d); put(L, c, nB, L, v + d); put(L, inset(p, i), nB, L, v);
        const t = put(sB, q, n, sB, v + d); put(sB, p2, n2, sB, v + d + chamfer); put(L, c, nB, L, v + d); b.tri(t, t + 1, t + 2);
      }
      if (capA) {
        const c = inset(q, i);
        four(put(0, inset(p, i), nA, 0, v)); put(0, c, nA, 0, v + d); put(sA, q, n, sA, v + d); put(sA, p, n, sA, v);
        const t = put(sA, p2, n2, sA, v + d + chamfer); put(sA, q, n, sA, v + d); put(0, c, nA, 0, v + d); b.tri(t, t + 1, t + 2);
      }
      v += d + chamfer;
    }
    const face = (s, n, flip) => {
      const f = b.count;
      for (const c of corner) { const x = c[0] - Math.sign(c[0]) * r, y = c[1] - Math.sign(c[1]) * r, q = at(s, x, y); b.vertex(q[0], q[1], q[2], n[0], n[1], n[2], x, y); }
      if (flip) b.quad(f + 1, f, f + 3, f + 2); else b.quad(f, f + 1, f + 2, f + 3);
    };
    if (capA) face(0, nA, true);
    if (capB) face(L, nB, false);
    return this;
  }
  /** Axis-aligned box from min to max corner. opts as `bar`, plus `axis`: 'x' | 'y' | 'z' (default y) for the uv grain and the bevel rings. */
  box(x0, y0, z0, x1, y1, z1, opts = {}) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, ax = opts.axis || 'y';
    if (ax === 'x') return this.bar([x0, cy, cz], [x1, cy, cz], z1 - z0, y1 - y0, { ...opts, up: [0, 1, 0] });
    if (ax === 'z') return this.bar([cx, cy, z0], [cx, cy, z1], x1 - x0, y1 - y0, { ...opts, up: [0, 1, 0] });
    return this.bar([cx, y0, cz], [cx, y1, cz], x1 - x0, z1 - z0, { ...opts, up: [0, 0, 1] });
  }

  /**
   * Extrude a 2D profile [[u, v], ...] along W: point = origin + u * U + v * V + t * W, t in 0..length, with U x V = W.
   * opts: closed (default true; open profiles are sheets and are emitted two-sided), crease (degrees, default 30),
   * caps (default true for closed), stops (fractions). uv = (metres along W, metres around the profile).
   */
  extrude(profile, origin, U, V, length, opts = {}) {
    const b = this.b, W = vcross(U, V), closed = opts.closed !== false, start = this.mark();
    let poly = profile;
    if (closed) { let area = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; } if (area < 0) poly = poly.slice().reverse(); }
    const at = (p, t) => [origin[0] + U[0] * p[0] + V[0] * p[1] + W[0] * t, origin[1] + U[1] * p[0] + V[1] * p[1] + W[1] * t, origin[2] + U[2] * p[0] + V[2] * p[1] + W[2] * t];
    const stops = [0, ...(opts.stops || []).map((t) => t * length), length], edges = closed ? poly.length : poly.length - 1;
    let around = 0;
    for (let e = 0; e < edges; e++) {
      const p = poly[e], q = poly[(e + 1) % poly.length], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      for (let k = 0; k < stops.length - 1; k++) this.quad(at(p, stops[k]), at(q, stops[k]), at(q, stops[k + 1]), at(p, stops[k + 1]), [stops[k], around, stops[k], around + d, stops[k + 1], around + d, stops[k + 1], around]);
      around += d;
    }
    b.computeNormals(opts.crease ?? 30, start.v, b.count);
    if (!closed) return this.twoSided(start);
    if (opts.caps !== false) {
      const tris = triangulate(poly);
      for (const [t, dir] of [[0, -1], [length, 1]]) {
        const f = b.count, n = vmul(W, dir);
        for (const p of poly) { const q = at(p, t); b.vertex(q[0], q[1], q[2], n[0], n[1], n[2], p[0], p[1]); }
        for (let i = 0; i < tris.length; i += 3) { if (dir > 0) b.tri(f + tris[i], f + tris[i + 1], f + tris[i + 2]); else b.tri(f + tris[i], f + tris[i + 2], f + tris[i + 1]); }
      }
    }
    return this;
  }

  /**
   * Skin a surface through rows of points (each row the same length). With rows running "up" and points running
   * "right" as seen from outside the winding is correct; pass flip otherwise. Normals are recomputed with `crease`.
   * opts: flip, crease (default 60), closed (join the last point of each row to the first), uv: fn(i, j) -> [u, v].
   */
  loft(rows, opts = {}) {
    const b = this.b, start = b.count, cols = rows[0].length, cl = opts.closed ? 1 : 0;
    b.grid(rows.length - 1, cols - 1 + cl, (i, j, o) => { const p = rows[i][j % cols]; o.x = p[0]; o.y = p[1]; o.z = p[2]; o.nx = 0; o.ny = 1; o.nz = 0; if (opts.uv) { const t = opts.uv(i, j); o.u = t[0]; o.v = t[1]; } else { o.u = j; o.v = i; } }, !!opts.flip);
    b.computeNormals(opts.crease ?? 60, start, b.count);
    return this;
  }

  /** Hexagonal bolt head or nut standing on `p` along `axis`. */
  bolt(p, axis, r = 0.018, h = 0.014) { return this.cyl(p, vmad(p, vnorm(axis), h), r, r, 6, { capB: true }); }

  // ------------------------------------------------------------ assemblies
  /** Append another kit (a sub-assembly built around its own origin) through a placement matrix; carries its fixtures along. */
  add(other, m = null) {
    this.b.append(other.b, m);
    const P = (p) => (m ? xformPoint(m, p) : p.slice()), D = (d) => (m ? vnorm(xformDir(m, d)) : d.slice());
    for (const l of other.lights) this.lights.push({ ...l, pos: P(l.pos), axis: D(l.axis) });
    for (const g of other.glows) this.glows.push({ ...g, pos: P(g.pos) });
    for (const s of other.lenses) { const f = D([s.facing[0], 0, s.facing[1]]), l = Math.hypot(f[0], f[2]) || 1; this.lenses.push({ ...s, pos: P(s.pos), facing: [f[0] / l, f[2] / l] }); }
    for (const a of other.anchors) this.anchors.push({ ...a, pos: P(a.pos) });
    return this;
  }

  /**
   * Register the light and the glow of a fixture whose lens geometry is at `pos` (section 4.5: all three in one place).
   * light: { color: [r, g, b] linear times intensity, radius, spot?: { axis, outerDeg, innerDeg } }
   * glow:  { color: [r, g, b] radiance, size, kind: 0 round | 1 star | 2 wide }
   */
  fixture(pos, channel, light, glow, seed = 0.5) {
    const spot = light.spot || null;
    this.lights.push({ pos: pos.slice(), radius: light.radius, color: light.color.slice(), type: spot ? 1 : 0, axis: spot ? vnorm(spot.axis) : [0, -1, 0],
      cosOuter: spot ? Math.cos(spot.outerDeg * Math.PI / 180) : -1, cosInner: spot ? Math.cos(spot.innerDeg * Math.PI / 180) : -1, channel, seed });
    this.glows.push({ pos: pos.slice(), size: glow.size, color: glow.color.slice(), channel, kind: glow.kind || 0 });
    return this;
  }
  /**
   * A light with no glow of its own: the wash of a neon run on the sheet metal behind it. A point light on the tube
   * itself would graze the panel and light a hand's breadth of it, so the wash stands off the surface in front of
   * the run; the tubes carry the glows.
   */
  wash(pos, channel, color, radius, seed = 0.5) {
    this.lights.push({ pos: pos.slice(), radius, color: color.slice(), type: 0, axis: [0, -1, 0], cosOuter: -1, cosInner: -1, channel, seed });
    return this;
  }
  /** A signal lens the game lights: colour 'red' | 'amber' | 'green', facing = unit [x, z], approach 0 | 1. */
  signalLens(pos, color, facing, diameter, approach = 0) { this.lenses.push({ pos: pos.slice(), color, facing: facing.slice(), diameter, approach }); return this; }

  lightRecords() {
    const out = new Float32Array(this.lights.length * LIGHT_STRIDE);
    this.lights.forEach((l, i) => { const o = i * LIGHT_STRIDE; out.set(l.pos, o); out[o + 3] = l.radius; out.set(l.color, o + 4); out[o + 7] = l.type; out.set(l.axis, o + 8); out[o + 11] = l.cosOuter; out[o + 12] = l.cosInner; out[o + 13] = l.channel; out[o + 14] = l.seed; });
    return out;
  }
  glowRecords() {
    const out = new Float32Array(this.glows.length * GLOW_STRIDE);
    this.glows.forEach((g, i) => { const o = i * GLOW_STRIDE; out.set(g.pos, o); out[o + 3] = g.size; out.set(g.color, o + 4); out[o + 7] = g.channel + 16 * g.kind; });
    return out;
  }
  get triangles() { return this.b.triangleCount; }
  finish() { return this.b.finish(); }
}
