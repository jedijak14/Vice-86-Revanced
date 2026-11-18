// Kit: small solid shapes for everything that is bolted onto a body shell (bumpers, lamp units, mirrors,
// handles, seats, wheels). All of them write through a Skin, which orients triangles from the normals given
// here, so the shapes only have to state where the outside is.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
export const vec = { sub, cross, unit, add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s], mad: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s] };

/** Flat quadrilateral through four points given around its perimeter; `n` is its outward normal. uv = four [u, v] pairs or none. */
export function quad(sk, m, P, n, uv = null, occ = 1) {
  const id = P.map((p, k) => sk.raw(p[0], p[1], p[2], n[0], n[1], n[2], uv ? uv[k][0] : 0, uv ? uv[k][1] : 0, Array.isArray(occ) ? occ[k] : occ));
  sk.quad(id[0], id[1], id[2], id[3], m);
}

/**
 * Box centred on c with half sizes h = [hx, hy, hz] along the axes ax (three unit vectors, default world axes).
 * `skip` lists faces to leave out, as letters: x X y Y z Z for the negative and positive face on each axis.
 * `occ` darkens the whole box, or with [bottom, top] the faces grade from one to the other along the second axis.
 */
export function box(sk, m, c, h, { ax = [X, Y, Z], skip = '', occ = 1, mats = null } = {}) {
  const P = (sx, sy, sz) => [0, 1, 2].map((k) => c[k] + ax[0][k] * h[0] * sx + ax[1][k] * h[1] * sy + ax[2][k] * h[2] * sz);
  const o = (sy) => (Array.isArray(occ) ? (sy < 0 ? occ[0] : occ[1]) : occ);
  const face = (name, n, pts) => { if (skip.includes(name)) return; quad(sk, (mats && mats[name]) || m, pts.map((s) => P(s[0], s[1], s[2])), n, null, pts.map((s) => o(s[1]))); };
  const neg = (v) => [-v[0], -v[1], -v[2]];
  face('X', ax[0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]); face('x', neg(ax[0]), [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]);
  face('Y', ax[1], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]); face('y', neg(ax[1]), [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]);
  face('Z', ax[2], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]); face('z', neg(ax[2]), [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]);
}

/**
 * Closed cross-section of a rounded rectangle, w wide (first coordinate) and h tall, corner radius r drawn with n
 * steps per corner. Returns points { a, b, na, nb } around the perimeter; with n = 0 it is a plain rectangle
 * whose corners are doubled so each face keeps its own normal.
 */
export function roundRect(w, h, r, n) {
  const out = [], hw = w / 2, hh = h / 2;
  if (n <= 0 || r <= 0) {
    const c = [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]], nn = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let k = 0; k < 4; k++) { const d = c[(k + 1) % 4]; out.push({ a: c[k][0], b: c[k][1], na: nn[k][0], nb: nn[k][1] }, { a: d[0], b: d[1], na: nn[k][0], nb: nn[k][1], cut: true }); }
    return out;
  }
  r = Math.min(r, hw, hh);
  const cs = [[hw - r, -hh + r, -Math.PI / 2], [hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2], [-hw + r, -hh + r, Math.PI]];
  for (const [ca, cb, a0] of cs) for (let k = 0; k <= n; k++) { const t = a0 + (Math.PI / 2) * k / n; out.push({ a: ca + r * Math.cos(t), b: cb + r * Math.sin(t), na: Math.cos(t), nb: Math.sin(t) }); }
  return out;
}

/**
 * Sweep a closed cross-section along a list of frames { o, a, b }: a section point (pa, pb) lands on o + a pa + b pb.
 * `caps` closes the first and/or last section ('0', '1' or '01'); mat may be a function of the section point index.
 */
export function sweep(sk, m, frames, prof, { caps = '', occ = 1 } = {}) {
  const np = prof.length, rows = frames.map((f) => prof.map((p) => {
    const n = unit([f.a[0] * p.na + f.b[0] * p.nb, f.a[1] * p.na + f.b[1] * p.nb, f.a[2] * p.na + f.b[2] * p.nb]);
    return sk.raw(f.o[0] + f.a[0] * p.a + f.b[0] * p.b, f.o[1] + f.a[1] * p.a + f.b[1] * p.b, f.o[2] + f.a[2] * p.a + f.b[2] * p.b, n[0], n[1], n[2], 0, 0, typeof occ === 'function' ? occ(p) : occ);
  }));
  const pick = (k) => (typeof m === 'function' ? m(k) : m);
  for (let i = 0; i < frames.length - 1; i++) for (let k = 0; k < np; k++) { if (prof[k].cut) continue; const k1 = (k + 1) % np; sk.quad(rows[i][k], rows[i][k1], rows[i + 1][k1], rows[i + 1][k], pick(k)); }
  for (const end of caps) {
    const i = end === '0' ? 0 : frames.length - 1, f = frames[i], g = frames[end === '0' ? 1 : frames.length - 2];
    const n = unit(sub(f.o, g.o)), ids = prof.filter((p) => !p.cut).map((p) => sk.raw(f.o[0] + f.a[0] * p.a + f.b[0] * p.b, f.o[1] + f.a[1] * p.a + f.b[1] * p.b, f.o[2] + f.a[2] * p.a + f.b[2] * p.b, n[0], n[1], n[2], 0, 0, typeof occ === 'function' ? 0.8 : occ));
    for (let k = 1; k < ids.length - 1; k++) sk.tri(ids[0], ids[k], ids[k + 1], pick(0));
  }
}

/**
 * Surface of revolution about the axis through o along `ax`; u and v span the plane across it.
 * prof = [{ r, h, nr, nh, m?, uv? }]: radius, height along the axis and normal of each ring; consecutive entries are
 * joined unless the later one has `cut`. Ring k uses material prof[k].m (or `m`) for the strip that starts there.
 * uvOf(ring, fraction of a turn) supplies texture coordinates.
 */
export function lathe(sk, m, o, ax, u, v, prof, segs, uvOf = null, occ = 1) {
  const rings = prof.map((p, k) => {
    const ids = [];
    for (let s = 0; s <= segs; s++) {
      const t = (s / segs) * 2 * Math.PI, c = Math.cos(t), sn = Math.sin(t), d = [u[0] * c + v[0] * sn, u[1] * c + v[1] * sn, u[2] * c + v[2] * sn], uv = uvOf ? uvOf(p, s / segs, k) : [0, 0];
      ids.push(sk.raw(o[0] + ax[0] * p.h + d[0] * p.r, o[1] + ax[1] * p.h + d[1] * p.r, o[2] + ax[2] * p.h + d[2] * p.r, ax[0] * p.nh + d[0] * p.nr, ax[1] * p.nh + d[1] * p.nr, ax[2] * p.nh + d[2] * p.nr, uv[0], uv[1], p.occ ?? occ));
    }
    return ids;
  });
  for (let k = 0; k < prof.length - 1; k++) { if (prof[k + 1].cut) continue; const mm = prof[k].m || m; for (let s = 0; s < segs; s++) sk.quad(rings[k][s], rings[k][s + 1], rings[k + 1][s + 1], rings[k + 1][s], mm); }
}

/** Flat disc of radius r about o facing n (u, v span its plane); uv in metres from the centre. */
export function disc(sk, m, o, n, u, v, r, segs, occ = 1, r0 = 0) {
  const pt = (rad, t) => { const c = Math.cos(t) * rad, s = Math.sin(t) * rad; return sk.raw(o[0] + u[0] * c + v[0] * s, o[1] + u[1] * c + v[1] * s, o[2] + u[2] * c + v[2] * s, n[0], n[1], n[2], c, s, occ); };
  const centre = r0 ? null : sk.raw(o[0], o[1], o[2], n[0], n[1], n[2], 0, 0, occ);
  let pa = pt(r, 0), pi = r0 ? pt(r0, 0) : -1;
  for (let s = 1; s <= segs; s++) { const t = (s / segs) * 2 * Math.PI, b = pt(r, t); if (r0) { const bi = pt(r0, t); sk.quad(pi, pa, b, bi, m); pi = bi; } else sk.tri(centre, pa, b, m); pa = b; }
}

/** The cheapest closed disc: a fan from one rim point, segs - 2 triangles, for end caps that are barely seen. */
export function cap(sk, m, o, n, u, v, r, segs, occ = 1) {
  const ids = [];
  for (let s = 0; s < segs; s++) { const t = (s / segs) * 2 * Math.PI, c = Math.cos(t) * r, sn = Math.sin(t) * r; ids.push(sk.raw(o[0] + u[0] * c + v[0] * sn, o[1] + u[1] * c + v[1] * sn, o[2] + u[2] * c + v[2] * sn, n[0], n[1], n[2], c, sn, occ)); }
  for (let s = 1; s < segs - 1; s++) sk.tri(ids[0], ids[s], ids[s + 1], m);
}

/** Straight round bar from p0 to p1. */
export function rod(sk, m, p0, p1, r, segs, caps = true, occ = 1) {
  const ax = unit(sub(p1, p0)), ref = Math.abs(ax[1]) < 0.9 ? Y : X, u = unit(cross(ref, ax)), v = cross(ax, u), len = Math.hypot(...sub(p1, p0));
  lathe(sk, m, p0, ax, u, v, [{ r, h: 0, nr: 1, nh: 0 }, { r, h: len, nr: 1, nh: 0 }], segs, null, occ);
  if (caps) { disc(sk, m, p0, [-ax[0], -ax[1], -ax[2]], u, v, r, segs, occ); disc(sk, m, p1, ax, u, v, r, segs, occ); }
}
