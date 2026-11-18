// Neon as it is built: lengths of 15 mm glass tube bent to shape, held off the wall on glass posts, each length
// ending in two blacked-out legs that turn back into rubber boots at the wall, fed from a transformer box through
// flexible conduit. A tube is never longer than a glass bender can handle (about 2.4 m), so long runs are several
// lengths with a finger's gap between them, and no tube crosses another.
//
// Shapes are designed in a wall's own plane as 2D polylines (metres) and placed by a frame { origin, right, up,
// normal }. Every tube is also recorded as data (centreline, colour, radiance) for the lighting and the reflections.

import { CHANNEL } from '../../core/ids.js';
import { vadd, vmad, vsub, vlen, vnorm, vcross, vdot } from '../props/kit.js';
import { COLOR, RADIANCE } from './plan.js';

export const TUBE_RADIUS = 0.0075, STANDOFF = 0.045;
const BEND = 0.022;           // tightest bend a 15 mm tube takes
const POST_PITCH = 0.34;      // a support at least this often, and one near each end

// ------------------------------------------------------------------------------------------------ 2D shape tools
/** Points of a cubic Bezier chain: [start, c1, c2, end, c1, c2, end, ...], `steps` segments per curve. */
export function bezier(chain, steps = 8) {
  const out = [chain[0]];
  for (let i = 1; i + 2 < chain.length; i += 3) {
    const p0 = chain[i - 1], p1 = chain[i], p2 = chain[i + 1], p3 = chain[i + 2];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
    }
  }
  return out;
}

/** Points of a circular arc about c from angle a0 to a1 (radians, counter-clockwise positive). */
export function arc(c, r, a0, a1, maxStep = 0.09) {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / maxStep)), out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]); }
  return out;
}

/**
 * Replace every corner sharper than `minTurn` degrees by an arc of radius r (shortened where a leg is too short
 * for it), as glass is bent: works on 2D or 3D points.
 */
export function roundCorners(points, r = BEND, minTurn = 25, steps = 4) {
  const dim = points[0].length, sub = (a, b) => a.map((v, i) => v - b[i]), len = (a) => Math.hypot(...a), mad = (a, b, s) => a.map((v, i) => v + b[i] * s);
  const out = [points[0]], cosMin = Math.cos(minTurn * Math.PI / 180);
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], a = sub(points[i - 1], p), b = sub(points[i + 1], p), la = len(a), lb = len(b);
    if (la < 1e-6 || lb < 1e-6) continue;
    const ua = a.map((v) => v / la), ub = b.map((v) => v / lb), cosTurn = -ua.reduce((s, v, k) => s + v * ub[k], 0);
    if (cosTurn > cosMin) { out.push(p); continue; }
    // tangent length for radius r at this corner: r / tan(half the interior angle)
    const half = Math.acos(Math.max(-1, Math.min(1, -cosTurn))) / 2, want = r / Math.max(0.05, Math.tan(half)), t = Math.min(want, la * 0.45, lb * 0.45);
    const start = mad(p, ua, t), end = mad(p, ub, t);
    for (let s = 0; s <= steps; s++) {
      // a quadratic through the corner is within a fraction of a millimetre of the true arc at these sizes
      const f = s / steps, u = 1 - f, q = new Array(dim);
      for (let k = 0; k < dim; k++) q[k] = u * u * start[k] + 2 * u * f * p[k] + f * f * end[k];
      out.push(q);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

const pathLength = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += vlen(vsub(pts[i], pts[i - 1])); return s; };
/** Point and unit tangent at arc length s along a polyline. */
function along(pts, s) {
  for (let i = 1; i < pts.length; i++) {
    const d = vsub(pts[i], pts[i - 1]), l = vlen(d);
    if (s <= l || i === pts.length - 1) return { p: vmad(pts[i - 1], d, Math.min(1, s / (l || 1))), t: vnorm(d) };
    s -= l;
  }
  return { p: pts[0], t: [1, 0, 0] };
}

/**
 * A polyline with the points left out that it can lose without moving more than `tolerance` from its line: the
 * drawn glass on Low. (The tube's record keeps every point.)
 */
function thin(pts, tolerance) {
  const keep = new Array(pts.length).fill(false), stack = [[0, pts.length - 1]];
  keep[0] = keep[pts.length - 1] = true;
  while (stack.length) {
    const [i0, i1] = stack.pop(), a = pts[i0], d = vsub(pts[i1], a), l = vlen(d) || 1;
    let worst = tolerance, at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const v = vsub(pts[i], a), t = Math.min(1, Math.max(0, vdot(v, d) / (l * l))), off = vlen(vsub(v, [d[0] * t, d[1] * t, d[2] * t]));
      if (off > worst) { worst = off; at = i; }
    }
    if (at > 0) { keep[at] = true; stack.push([i0, at], [at, i1]); }
  }
  return pts.filter((p, i) => keep[i]);
}

// ------------------------------------------------------------------------------------------------ one tube
/** A wall's frame for placing 2D shapes: point = origin + x * right + y * up + off * normal. */
export const frame = (origin, right, up) => ({ origin, right, up, normal: vnorm(vcross(right, up)) });
const lift = (f, p, off) => vadd(vadd(vmad(f.origin, f.right, p[0]), [f.up[0] * p[1], f.up[1] * p[1], f.up[2] * p[1]]), [f.normal[0] * off, f.normal[1] * off, f.normal[2] * off]);

/**
 * One length of tube. `shape` is its lit centreline in the frame's plane (2D), already free of crossings.
 *   k      kit receiving the geometry (glass, legs, boots, posts)
 *   log    array receiving the tube record
 *   o      { id, group, gas (GAS entry), standoff, sides, posts (false for a tube held some other way) }
 * Returns the record: { id, group, color (linear, of its light), srgb (of the glass), radiance, radius, points, ends }.
 */
export function tube(k, log, f, shape, o) {
  // a 15 mm tube is a few pixels wide from the turntable: on Low it is drawn square and bloom rounds it
  const lean = k.detail === 0, standoff = o.standoff ?? STANDOFF, r = TUBE_RADIUS, sides = o.sides ?? (lean ? 4 : 6), N = f.normal, around = lean ? 5 : 8;
  const lit = roundCorners(shape).map((p) => lift(f, p, standoff));
  k.neon(o.gas.tube, o.radiance ?? RADIANCE.tube, CHANNEL.ALWAYS);
  k.tube(lean ? thin(lit, 0.002) : lit, r, sides);

  // legs: each end turns through a tight bend and runs back to the wall, blacked out, into a boot
  const ends = [];
  for (const [end, next] of [[lit[0], lit[1]], [lit[lit.length - 1], lit[lit.length - 2]]]) {
    const out = vnorm(vsub(end, next)), knee = vmad(end, out, BEND), foot = vmad(knee, N, -(standoff - 0.002));
    const bend = roundCorners([end, knee, vmad(knee, N, -BEND * 1.2)], BEND, 25, lean ? 2 : 3);
    k.neon(o.gas.tube, o.radiance ?? RADIANCE.tube, CHANNEL.ALWAYS); k.tube(bend, r, sides);
    k.paint(COLOR.boot, 0.6, 0.1); k.cyl(vmad(knee, N, -BEND * 0.9), vmad(foot, N, 0.03), r + 0.0012, r + 0.0012, sides, { capA: true });
    k.rubber(COLOR.boot, 0.8);
    k.cyl(vmad(foot, N, 0.034), vmad(foot, N, lean ? 0 : 0.004), 0.0125, 0.0125, around, { capA: true });
    if (!lean) k.cyl(vmad(foot, N, 0.004), foot, 0.02, 0.02, around, { capA: true });
    ends.push(foot);
  }

  // glass posts: a cup screwed to the wall, a clear post, the tube tied into its fork
  if (o.posts !== false) {
    const L = pathLength(lit), n = Math.max(2, Math.ceil(L / POST_PITCH) + 1), inset = Math.min(0.07, L * 0.2);
    for (let i = 0; i < n; i++) {
      const at = along(lit, inset + (L - 2 * inset) * (n === 1 ? 0.5 : i / (n - 1))), base = vmad(at.p, N, -standoff);
      // clear glass takes the colour of what is behind it: a dull neutral stands in for it at this size
      k.plastic([0.3, 0.31, 0.32], 0.2);
      if (!lean) k.lathe(base, N, [[0, 0.009], [0.003, 0.009], [0.01, 0.005], [0.01, 0]], 6, { crease: 40 });
      k.cyl(lean ? base : vmad(base, N, 0.009), vmad(at.p, N, -r * 0.6), 0.0032, 0.0032, lean ? 3 : 5);
    }
  }
  const record = { id: o.id, group: o.group, color: o.gas.light.slice(), srgb: o.gas.tube.slice(), radiance: o.radiance ?? RADIANCE.tube, radius: r, points: lit, ends, length: pathLength(lit) };
  log.push(record);
  return record;
}

/** A closed outline as one tube: the loop is left open by a finger's gap at its start so both legs sit side by side. */
export function loop(k, log, f, outline, o) {
  const first = outline[0], second = outline[1], last = outline[outline.length - 1];
  const d = [second[0] - first[0], second[1] - first[1]], l = Math.hypot(d[0], d[1]), e = [first[0] - last[0], first[1] - last[1]], le = Math.hypot(e[0], e[1]), gap = 0.022;
  // open the loop on the closing segment: start a gap after the first point's side, end a gap before it
  const start = [first[0] + d[0] / l * gap, first[1] + d[1] / l * gap], end = le > 1e-6 ? [first[0] - e[0] / le * gap, first[1] - e[1] / le * gap] : [first[0] - d[0] / l * gap, first[1] - d[1] / l * gap];
  return tube(k, log, f, [start, ...outline.slice(1), ...(le > gap * 2 ? [end] : [])], o);
}

/** A straight run split into glass-length sections with gaps: returns the tube records. */
export function run(k, log, f, a, b, o) {
  const d = [b[0] - a[0], b[1] - a[1]], L = Math.hypot(d[0], d[1]), n = Math.max(1, Math.ceil(L / (o.section ?? 2.35))), gap = 0.07, out = [];
  for (let i = 0; i < n; i++) {
    const t0 = (i * L / n + gap / 2) / L, t1 = ((i + 1) * L / n - gap / 2) / L;
    out.push(tube(k, log, f, [[a[0] + d[0] * t0, a[1] + d[1] * t0], [a[0] + d[0] * t1, a[1] + d[1] * t1]], { ...o, id: `${o.id}-${i + 1}` }));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the electrics
/**
 * Transformer: a grey steel case screwed to the wall on two lugs, with a cover plate and a conduit entry on top.
 * `at` is the 2D position of its centre in the frame, `side` +1 for a conduit entry on top, -1 underneath; returns
 * the 3D point of the entry.
 */
export function transformer(k, f, at, side = 1, w = 0.3, h = 0.2, depth = 0.18) {
  const c = lift(f, at, depth / 2), R = f.right, U = f.up, N = f.normal;
  k.steel(COLOR.transformer, 0.55, 0.3);
  const m = k.mark();
  k.bar(vmad(c, R, -w / 2), vmad(c, R, w / 2), depth, h, { up: U, r: 0.006 });
  for (const s of [-1, 1]) {                                                       // mounting lugs, each with a screw
    const lug = vmad(lift(f, at, 0.004), R, s * (w / 2 + 0.022));
    k.bar(vmad(lug, R, -0.03), vmad(lug, R, 0.03), 0.008, 0.045, { up: U, r: 0.001 });
    k.bolt(vmad(lug, N, 0.003), N, 0.006, 0.004);
  }
  for (const s of [-1, 1]) {                                                       // ribbed porcelain bushings on the end faces
    const base = vadd(vmad(c, R, s * w / 2), vmad([0, 0, 0], U, h * 0.2));
    k.plastic(COLOR.porcelain, 0.3);
    k.lathe(base, vmad([0, 0, 0], R, s), [[0, 0.02], [0.008, 0.02], [0.011, 0.014], [0.016, 0.02], [0.021, 0.014], [0.026, 0.019], [0.031, 0.013], [0.038, 0.013], [0.038, 0]], 10, { crease: 50 });
    k.bare(1, 0.5, [0.7, 0.62, 0.4]); k.cyl(vmad(base, R, s * 0.038), vmad(base, R, s * 0.05), 0.004, 0.004, 6, { capB: true });
    k.steel(COLOR.transformer, 0.55, 0.3);
  }
  k.shade(m, (x, y, z) => 0.75 + 0.25 * Math.min(1, Math.abs(vdot(vsub([x, y, z], lift(f, at, 0)), N)) / depth));
  k.steel([0.5, 0.51, 0.5], 0.5, 0.2);
  k.bar(vmad(lift(f, at, depth + 0.001), R, -w * 0.3), vmad(lift(f, at, depth + 0.001), R, w * 0.3), 0.003, h * 0.5, { up: U, r: 0 });   // rating plate
  const entry = vadd(vmad(c, U, side * h / 2), vmad([0, 0, 0], R, -w * 0.28));
  k.bare(2, 0.5, [0.7, 0.7, 0.7]); k.cyl(entry, vmad(entry, U, side * 0.022), 0.012, 0.012, 8, { capB: true });
  return vmad(entry, U, side * 0.02);
}

/**
 * A cable or flexible conduit hanging between two points on the wall: it sags under its own weight and is held
 * a centimetre off the surface by its clips.
 */
export function cable(k, a, b, radius = 0.005, sag = 0.06, color = COLOR.boot, steps = 8) {
  const pts = [];
  for (let i = 0; i <= steps; i++) { const t = i / steps, p = vadd(vmad(a, vsub(b, a), t), [0, -sag * 4 * t * (1 - t), 0]); pts.push(p); }
  k.rubber(color, 0.7); k.tube(pts, radius, 5, { capA: true, capB: true });
  return pts;
}
