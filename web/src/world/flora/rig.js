// Shared construction helpers for the flora generators: small vector maths on plain arrays, colour
// helpers, and the swept-tube builder used for trunks, branches, stalks and fruit.
//
// Everything here runs once per prototype at start-up (inside the world worker), so clarity wins over
// allocation discipline; nothing in this folder runs per frame.

import { TAU, clamp, lerp, hexColor } from '../../core/math.js';

// ---------------------------------------------------------------- vectors (plain [x, y, z], allocating)
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vmad = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vlerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Rotate v about the unit axis k by `angle` (Rodrigues). */
export function vrotate(v, k, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), d = vdot(k, v) * (1 - c), x = vcross(k, v);
  return [v[0] * c + x[0] * s + k[0] * d, v[1] * c + x[1] * s + k[1] * d, v[2] * c + x[2] * s + k[2] * d];
}
/** Any unit vector perpendicular to the unit vector t (stable for every t). */
export function vperp(t) {
  const a = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return vnorm(vcross(a, t));
}
/** Unit direction from an azimuth about +Y (0 = +X, towards +Z) and an elevation above the horizon. */
export const dirFromAngles = (azimuth, elevation) => {
  const c = Math.cos(elevation);
  return [c * Math.cos(azimuth), Math.sin(elevation), c * Math.sin(azimuth)];
};

export const UP = Object.freeze([0, 1, 0]);
export const DOWN = Object.freeze([0, -1, 0]);
/** Successive leaves, fronds and branches turn by this much about the stem (137.5 degrees). */
export const GOLDEN_ANGLE = TAU * (1 - 1 / 1.6180339887498949);

// ---------------------------------------------------------------- colour
/** '#rrggbb' to sRGB triple. */
export const hex = hexColor;
export const mixColor = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const shade = (c, k) => [clamp(c[0] * k, 0, 1), clamp(c[1] * k, 0, 1), clamp(c[2] * k, 0, 1)];

// ---------------------------------------------------------------- curves
/** Piecewise-linear lookup in a table of [x, y] pairs sorted by x. */
export function table(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const a = points[i - 1], b = points[i];
      return lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
    }
  }
  return points[points.length - 1][1];
}

/**
 * Sweep a round (or n-sided) section along a centreline.
 *
 * rings: [{ c: [x, y, z], r: radius, v: texture v (metres along the stem), color?: [r, g, b], weight?: 0..1 }]
 * `weight` is written to the vertex alpha: baked occlusion on SOLID parts, sway weight on FOLIAGE parts.
 * opts.radial(i, j, u) -> multiplier on the radius of ring i at side j (surface relief, fluting);
 * opts.capStart / opts.capEnd close the ends with a flat polygon; opts.frame is the starting side vector.
 * The seam column is duplicated so u runs 0..1 exactly once around.
 */
export function sweepTube(mb, rings, sides, opts = {}) {
  const n = rings.length, radial = opts.radial || null;
  const tangents = rings.map((_, i) => vnorm(vsub(rings[Math.min(n - 1, i + 1)].c, rings[Math.max(0, i - 1)].c)));
  // Parallel transport keeps the section from spinning as the centreline curves.
  let side = opts.frame ? vnorm(vsub(opts.frame, vscale(tangents[0], vdot(opts.frame, tangents[0])))) : vperp(tangents[0]);
  const base = mb.count, frames = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i], ring = rings[i];
    side = vnorm(vsub(side, vscale(t, vdot(side, t))));
    const bin = vcross(t, side);
    frames.push({ t, side, bin });
    const prev = rings[Math.max(0, i - 1)], next = rings[Math.min(n - 1, i + 1)];
    const slope = (next.r - prev.r) / Math.max(1e-5, vlen(vsub(next.c, prev.c)));
    if (ring.color) mb.color(ring.color);
    if (ring.weight !== undefined) mb.occlusion(ring.weight);
    for (let j = 0; j <= sides; j++) {
      const u = j / sides, a = u * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const d = [side[0] * ca + bin[0] * sa, side[1] * ca + bin[1] * sa, side[2] * ca + bin[2] * sa];
      const r = ring.r * (radial ? radial(i, j % sides, u) : 1);
      mb.vertex(ring.c[0] + d[0] * r, ring.c[1] + d[1] * r, ring.c[2] + d[2] * r,
        d[0] - t[0] * slope, d[1] - t[1] * slope, d[2] - t[2] * slope, u, ring.v);
    }
  }
  const w = sides + 1;
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < sides; j++) {
    const a = base + i * w + j;
    mb.quad(a, a + 1, a + w + 1, a + w);
  }
  const cap = (i, flip) => {
    const ring = rings[i], f = frames[i], nrm = flip ? vscale(f.t, -1) : f.t;
    if (ring.color) mb.color(ring.color);
    if (ring.weight !== undefined) mb.occlusion(ring.weight);
    // The rim is repeated with the cap's own normal. A plain rim is convex and is fanned from its first vertex
    // (two triangles fewer); a rim with relief may not be, and is fanned from the centre.
    const first = mb.count;
    for (let j = 0; j < sides; j++) {
      const p = base + i * w + j;
      mb.vertex(mb.pos[p * 3], mb.pos[p * 3 + 1], mb.pos[p * 3 + 2], nrm[0], nrm[1], nrm[2], j / sides, ring.v);
    }
    const hub = radial ? mb.vertex(ring.c[0], ring.c[1], ring.c[2], nrm[0], nrm[1], nrm[2], 0.5, ring.v) : first;
    for (let j = radial ? 0 : 1; j < (radial ? sides : sides - 1); j++) {
      const a = first + j, b = first + (j + 1) % sides;
      if (flip) mb.tri(hub, b, a); else mb.tri(hub, a, b);
    }
  };
  if (opts.capStart) cap(0, true);
  if (opts.capEnd) cap(n - 1, false);
  return frames;
}

/**
 * A closed ovoid (fruit, buds, knuckles): `rings` latitude bands by `sides` segments about `axis`.
 * profile(t) -> radius multiplier along the axis, t in 0..1 (defaults to an ellipsoid).
 */
export function ovoid(mb, centre, axis, length, radius, sides, bands, profile = null) {
  const a = vnorm(axis), list = [];
  for (let i = 0; i <= bands; i++) {
    const t = i / bands, r = radius * (profile ? profile(t) : Math.sin(Math.PI * t));
    list.push({ c: vmad(centre, a, (t - 0.5) * length), r: Math.max(r, radius * 0.02), v: t * length });
  }
  sweepTube(mb, list, sides);
}
