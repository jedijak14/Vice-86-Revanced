// Shared vocabulary of the props: the colour palette (sRGB), light source colours and the small
// sub-assemblies that many prototypes repeat (bolted base plates, pipe railings, ladders, sign plates).

import { CHANNEL } from '../../core/ids.js';
import { linearToSrgb, hashString } from '../../core/math.js';
import { vadd, vsub, vmul, vmad, vnorm, vcross, vlen, vlerp } from './kit.js';

/**
 * Albedo colours, sRGB 0..1. Kept in one place so every prop sits in the same tonal family. They are the colours
 * of paint that has been outdoors for years: whites stay under 0.78 linear, signal colours are sun-faded rather
 * than fresh from the tin, the beach pastels are chalky (saturation about a third).
 */
export const C = Object.freeze({
  galv: [0.62, 0.64, 0.65],          // tint for galvanised steel
  alu: [0.74, 0.75, 0.76],
  poleGrey: [0.47, 0.48, 0.47],
  darkSteel: [0.17, 0.175, 0.18],
  black: [0.06, 0.06, 0.062],
  white: [0.87, 0.865, 0.84],
  offWhite: [0.80, 0.78, 0.72],
  concrete: [0.60, 0.59, 0.55],
  concreteDark: [0.46, 0.45, 0.42],
  signalYellow: [0.78, 0.60, 0.13],
  safetyYellow: [0.80, 0.66, 0.16],
  hydrantRed: [0.56, 0.13, 0.10],
  mailBlue: [0.11, 0.17, 0.34],
  bronze: [0.20, 0.16, 0.12],        // dark anodised aluminium
  dumpsterGreen: [0.13, 0.25, 0.18],
  coneOrange: [0.84, 0.34, 0.11],
  timber: [0.42, 0.31, 0.22],        // creosoted or weathered structural timber
  timberPale: [0.62, 0.52, 0.40],
  rust: [0.33, 0.17, 0.09],
  porcelain: [0.45, 0.30, 0.22],     // brown glazed insulators
  transformer: [0.56, 0.59, 0.60],
  aqua: [0.45, 0.72, 0.70],
  pink: [0.88, 0.58, 0.66],
  flamingo: [0.86, 0.47, 0.52],
  sun: [0.88, 0.75, 0.38],
  lilac: [0.60, 0.50, 0.74],
  seaBlue: [0.22, 0.42, 0.66],
  craneBlue: [0.36, 0.45, 0.53],
  rope: [0.70, 0.62, 0.45],
  canvas: [0.82, 0.80, 0.72],
});

/** Chromaticities of light sources, linear rgb with the brightest channel at 1. */
export const SOURCE = Object.freeze({
  sodium: [1, 0.62, 0.214],          // high-pressure sodium: the orange-pink of 1980s roadway lighting
  warmWhite: [1, 0.84, 0.60],        // incandescent / opal globe
  fluorescent: [0.86, 1, 0.94],      // cool white tube with its green cast
  halide: [0.95, 1, 0.98],
  aviationRed: [1, 0.06, 0.03],
  runwayWhite: [1, 0.93, 0.76],
  taxiBlue: [0.08, 0.25, 1],
});
/** sRGB vertex colour for a linear chromaticity (lens and tube colours are authored as their emission colour). */
export const srgb = (lin) => [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])];
export const times = (lin, s) => [lin[0] * s, lin[1] * s, lin[2] * s];

/** Stable per-prototype seed byte from its name. */
export const seedOf = (name) => hashString(name) & 255;

/**
 * Register a luminaire: light and glow of one source colour at the lens position.
 * power: light colour scale (section 4.6: about 5 * (mounting height^2 + 1) lights the ground like a street lamp),
 * radiance: what the lens emits (also the glow colour), size: glow sprite diameter.
 */
export function luminaire(k, pos, source, { power, radius, radiance, size, kind = 1, channel = CHANNEL.STREET, spot = null, seed = 0.5 }) {
  k.fixture(pos, channel, { color: times(source, power), radius, spot }, { color: times(source, radiance), size, kind }, seed);
}

/**
 * Steel base plate with anchor bolts, nuts and washers, sitting on y = y0. The pole is expected to stand on its centre.
 * Bolts sit at the four corners; only the plate at the far level.
 */
export function basePlate(k, size, thick, y0 = 0, boltR = 0.016) {
  const h = size / 2;
  if (k.lod === 2) { k.box(-h, y0, -h, h, y0 + thick, h); return; }
  k.box(-h, y0, -h, h, y0 + thick, h, { r: Math.min(0.008, thick * 0.4) });
  if (!k.near) return;
  const e = h - Math.max(0.045, size * 0.13);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = [sx * e, y0 + thick, sz * e];
    k.cyl(p, vadd(p, [0, 0.004, 0]), boltR * 2.1, boltR * 2.1, 8, { capB: true });        // washer
    k.bolt(vadd(p, [0, 0.004, 0]), [0, 1, 0], boltR * 1.55, boltR * 1.4);                  // nut
    k.cyl(vadd(p, [0, 0.004 + boltR * 1.4, 0]), vadd(p, [0, 0.03 + boltR * 1.4, 0]), boltR, boltR, 5, { capB: true });   // stud
  }
}

/** Points of a circular arc in the plane spanned by unit vectors u and v around c, from angle a0 to a1 (radians). */
export function arc(c, u, v, r, a0, a1, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push(vadd(vadd(c, vmul(u, Math.cos(a) * r)), vmul(v, Math.sin(a) * r))); }
  return pts;
}

/**
 * Pipe railing along a polyline (points at the walking surface): posts, top rail and `mids` intermediate rails.
 * opts: height, r (pipe radius), postEvery (max spacing), mids, square (timber section instead of pipe), n.
 */
export function railing(k, pts, opts = {}) {
  const height = opts.height ?? 1.05, r = opts.r ?? 0.021, mids = opts.mids ?? 1, every = opts.postEvery ?? 1.6, n = opts.n ?? k.n(8, 4);
  // every stick is closed at both ends: posts often stand on a deck edge or a stair stringer, where the player
  // on the ground below looks straight up into an open foot
  const stick = (a, b) => (opts.square ? k.bar(a, b, r * 2, r * 2, { capA: true, capB: true }) : k.cyl(a, b, r, r, n, { capA: true, capB: true }));
  const up = (p, h) => [p[0], p[1] + h, p[2]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], len = vlen(vsub(b, a)), count = Math.max(1, Math.ceil(len / every));
    for (let j = 0; j <= count; j++) { if (j === 0 && i > 0) continue; const p = vlerp(a, b, j / count); stick(p, up(p, height)); }
    if (!opts.square) continue;
    stick(up(a, height), up(b, height));
    if (k.mid) for (let m = 1; m <= mids; m++) stick(up(a, height * m / (mids + 1)), up(b, height * m / (mids + 1)));
  }
  if (opts.square) return;
  // round rails are one bent pipe each, mitred at the corners: no gap opens on the outside of a bend and no
  // triangles are spent on end caps buried inside the joints
  const run = (h) => k.tube(pts.map((p) => up(p, h)), r, n, { capA: true, capB: true });
  run(height);
  if (k.mid) for (let m = 1; m <= mids; m++) run(height * m / (mids + 1));
}

/**
 * Ladder from `a` (bottom) to `b` (top): two stiles and rungs. `out` is the unit direction the climber's back faces.
 */
export function ladder(k, a, b, out, width = 0.42, rung = 0.3) {
  const axis = vnorm(vsub(b, a)), side = vnorm(vcross(axis, out)), len = vlen(vsub(b, a)), hw = width / 2;
  for (const s of [-1, 1]) k.bar(vmad(a, side, s * hw), vmad(b, side, s * hw), 0.012, 0.05, { up: out });
  if (!k.mid) return;
  const count = Math.floor(len / rung);
  for (let i = 1; i <= count; i++) { const p = vmad(a, axis, i * len / (count + 1)); k.cyl(vmad(p, side, -hw), vmad(p, side, hw), 0.011, 0.011, 5); }
}

/**
 * A sheet-metal sign plate: printed face from the atlas on the front, bare aluminium on the back, visible edge.
 * `outline`: polygon [[x, y], ...] in the plate's own plane (x along `right`, y along `up`), counter-clockwise, convex.
 * rect: atlas entry from pickSign ({ uv: [u0, v0, u1, v1] }) mapped onto the outline's bounding box; null = painted `color`.
 * opts: code (SIGN p0), channel, backSign (rect for a second printed side instead of bare metal), thickness,
 *       edge: fn(k) that sets the material of the edge and of an unprinted back (default bare aluminium).
 */
export function signPlate(k, centre, right, up, outline, rect, opts = {}) {
  const t = opts.thickness ?? 0.004, nrm = vcross(right, up), b = k.b;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of outline) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const at = (p, off) => vadd(vadd(vadd(centre, vmul(right, p[0])), vmul(up, p[1])), vmul(nrm, off));
  const face = (side, r) => {
    // side +1: front (faces nrm), -1: back
    if (r) k.signFace(opts.code ?? r.emissiveCode ?? 0, opts.channel ?? CHANNEL.NEON, 0.45); else if (opts.edge) opts.edge(k); else k.bare(1, 0.45, C.alu);
    const f = b.count, uv = r ? r.uv : [0, 0, 1, 1];
    for (const p of outline) {
      const s = (p[0] - x0) / (x1 - x0), q = (p[1] - y0) / (y1 - y0), u = side > 0 ? s : 1 - s, pos = at(p, side * t / 2);
      b.vertex(pos[0], pos[1], pos[2], nrm[0] * side, nrm[1] * side, nrm[2] * side, uv[0] + (uv[2] - uv[0]) * u, uv[3] + (uv[1] - uv[3]) * q);
    }
    for (let i = 1; i < outline.length - 1; i++) { if (side > 0) b.tri(f, f + i, f + i + 1); else b.tri(f, f + i + 1, f + i); }
  };
  face(1, rect);
  face(-1, opts.backSign || null);
  // The edge is kept at every level of detail: without it the inside of the far face shows through the gap
  // between the two faces whenever the plate is seen edge-on.
  if (opts.edge) opts.edge(k); else k.bare(1, 0.5, C.alu);
  for (let i = 0; i < outline.length; i++) { const p = outline[i], q = outline[(i + 1) % outline.length]; k.quad(at(p, -t / 2), at(q, -t / 2), at(q, t / 2), at(p, t / 2)); }
}
/** Rectangle outline centred on the origin. */
export const rectOutline = (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
/** Regular octagon (flat top) of the given width across flats. */
export const octagonOutline = (across) => { const h = across / 2, c = h * Math.tan(Math.PI / 8); return [[-c, -h], [c, -h], [h, -c], [h, c], [c, h], [-c, h], [-h, c], [-h, -c]]; };

/**
 * Rolled steel I-section from a to b (web along `up`): flange width w, depth h. Beyond the near level it is a plain bar,
 * which keeps the silhouette and drops the re-entrant faces nobody can see from there.
 */
export function ibeam(k, a, b, w, h, up = [0, 0, 1], opts = {}) {
  if (!k.near) return k.bar(a, b, w, h, { up, ...opts });
  const T = vnorm(vsub(b, a)), d = up[0] * T[0] + up[1] * T[1] + up[2] * T[2], V = vnorm(vmad(up, T, -d)), U = vcross(V, T);   // U x V = T
  const f = Math.max(0.012, h * 0.07), t = Math.max(0.01, w * 0.07), x = w / 2, y = h / 2;
  const profile = [[-x, -y], [x, -y], [x, -y + f], [t, -y + f], [t, y - f], [x, y - f], [x, y], [-x, y], [-x, y - f], [-t, y - f], [-t, -y + f], [-x, -y + f]];
  return k.extrude(profile, a, U, V, vlen(vsub(b, a)), { crease: 30, ...opts });
}
