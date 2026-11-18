// Trunks, stems and the woody parts that sit on them.
//
// Everything here is SOLID.TRUNK: uv = (around 0..1, arc length from the ground in metres), p0 = species,
// p1 = arc length in decimetres at which the species' upper zone begins (crownshaft, boots, stub zone,
// fibre), p2 = seed. The vertex colour is the base colour of the zone the vertex is in and the vertex
// alpha is baked occlusion (ground line and the shade under the crown).

import { FAMILY, SOLID } from '../../core/ids.js';
import { clamp, lerp, smoothstep } from '../../core/math.js';
import { vadd, vscale, vmad, vnorm, vcross, vlerp, vperp, dirFromAngles, shade, sweepTube } from './rig.js';

export const SPECIES = Object.freeze({ COCONUT: 0, ROYAL: 1, FAN: 2, DATE: 3, BROADLEAF: 4 });

/**
 * Centreline of a trunk that leaves the ground leaning by `lean` from the vertical towards `azimuth`
 * and straightens to `leanTop` as it grows towards the light (the sweep of a coconut palm). `wander`
 * swings the lean direction along the way so the curve is not confined to one plane.
 * The curve is scaled so that its top is exactly `height` above the ground.
 * Returns steps + 1 samples { p, t, s (arc length), f }.
 */
export function trunkPath(spec, steps) {
  const dirAt = (f) => {
    const lean = spec.leanTop + (spec.lean - spec.leanTop) * Math.pow(1 - f, spec.leanPow ?? 1.6);
    return dirFromAngles(spec.azimuth + (spec.wander || 0) * Math.sin(2.4 * f + (spec.phase || 0)), Math.PI / 2 - lean);
  };
  const raw = [[0, 0, 0]];
  for (let i = 1; i <= steps; i++) raw.push(vadd(raw[i - 1], vscale(dirAt((i - 0.5) / steps), 1 / steps)));
  const k = spec.height / raw[steps][1], out = [];
  for (let i = 0; i <= steps; i++) out.push({ p: vscale(raw[i], k), t: dirAt(i / steps), s: k * i / steps, f: i / steps });
  return out;
}

/** Sample of a path from trunkPath at arc-length fraction f, with a stable side vector. */
export function pathAt(path, f) {
  const x = clamp(f, 0, 1) * (path.length - 1), i = Math.min(path.length - 2, Math.floor(x)), k = x - i, a = path[i], b = path[i + 1];
  const t = vnorm(vlerp(a.t, b.t, k));
  return { p: vlerp(a.p, b.p, k), t, s: lerp(a.s, b.s, k), f, side: vperp(t) };
}

/**
 * Skin a path.
 * opts: { sides, species, seed, zoneStart (metres of arc length, 0 = none),
 *         radius(s, f) -> metres, color(s, f) -> sRGB, occlusion(s, f) -> 0..1,
 *         relief(s, u) -> radius multiplier (surface relief that is worth real geometry), capEnd }
 * `fractions` lists where rings go (0..1), so rings can crowd where the profile changes quickly.
 */
export function buildTrunk(mb, path, fractions, opts) {
  mb.family(FAMILY.SOLID).material(SOLID.TRUNK, opts.species, clamp(Math.round((opts.zoneStart || 0) * 10), 0, 255), opts.seed);
  const rings = fractions.map((f) => {
    const q = pathAt(path, f);
    return { c: q.p, r: opts.radius(q.s, f), v: q.s, color: opts.color(q.s, f), weight: opts.occlusion(q.s, f) };
  });
  // A leaning stem would lift one side of its foot off the ground: the first ring slides down the stem's own
  // axis until its whole rim is buried.
  const lean = path[0].t;
  rings[0].c = vmad(rings[0].c, lean, -(rings[0].r * Math.hypot(lean[0], lean[2]) / lean[1] + 0.02));
  const relief = opts.relief;
  return sweepTube(mb, rings, opts.sides, { capEnd: opts.capEnd !== false, radial: relief ? (i, j, u) => relief(rings[i].v, u) : null, frame: [1, 0, 0] });
}

/** Ring fractions: `count` rings spread evenly plus extra rings in the first `baseHeight` fraction (the swollen foot). */
export function ringFractions(count, baseFraction = 0, baseRings = 0) {
  const out = [];
  for (let i = 0; i < baseRings; i++) out.push(baseFraction * Math.pow(i / baseRings, 1.5));
  for (let i = 0; i <= count; i++) out.push(lerp(baseFraction, 1, i / count));
  return out;
}

/** Occlusion profile shared by the palms: dark at the ground line, open along the stem, shaded under the crown. */
export const trunkOcclusion = (length, crownShade = 1.6) => (s) =>
  lerp(0.62, 1, smoothstep(0, 0.35, s)) * lerp(0.55, 1, smoothstep(0, crownShade, length - s));

/**
 * A cut leaf base: a short tapered stub that leans up and out from the stem. These make the knobbly
 * silhouette of a date palm and the ragged collar under other crowns; a shader pattern cannot.
 * at: { p (point on the stem axis), t (stem axis) }, azimuth about the axis, r = stem radius there.
 */
export function leafBase(mb, at, azimuth, r, size, tilt, color, occlusion, u, v, sides = 4) {
  const side = vperp(at.t), bin = vcross(at.t, side);
  const out = vadd(vscale(side, Math.cos(azimuth)), vscale(bin, Math.sin(azimuth)));
  const dir = vnorm(vadd(vscale(out, Math.cos(tilt)), vscale(at.t, Math.sin(tilt))));
  const root = vmad(at.p, out, r * 0.82), tip = vmad(root, dir, size.length);
  const across = vnorm(vcross(dir, at.t)), up = vcross(dir, across), first = mb.count;
  // Flattened section: leaf bases are wide across the stem and thin along it.
  const ring = (c, w, h, shadeK, vv) => {
    mb.color(shade(color, shadeK)).occlusion(occlusion);
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const d = vadd(vscale(across, ca), vscale(up, sa));
      mb.vertex(c[0] + across[0] * ca * w + up[0] * sa * h, c[1] + across[1] * ca * w + up[1] * sa * h, c[2] + across[2] * ca * w + up[2] * sa * h, d[0], d[1], d[2], clamp(u + 0.03 * ca, 0, 1), vv);
    }
  };
  ring(root, size.width, size.thick, 0.8, v);
  ring(tip, size.width * 0.55, size.thick * 0.6, 1.05, v + size.length);
  const w = sides + 1;
  for (let j = 0; j < sides; j++) { const q = first + j; mb.quad(q, q + 1, q + w + 1, q + w); }
  mb.color(shade(color, 1.15));
  const centre = mb.vertex(tip[0], tip[1], tip[2], dir[0], dir[1], dir[2], u, v + size.length);
  for (let j = 0; j < sides; j++) mb.tri(centre, first + w + j, first + w + j + 1);
}
