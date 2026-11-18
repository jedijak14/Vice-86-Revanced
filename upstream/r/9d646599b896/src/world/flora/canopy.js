// Building blocks for everything that is not a palm: leaf-cluster cards, opaque leafy masses that fill
// the inside of a canopy, and blade cards for grasses. The FOLIAGE shader cuts leaves, blades and petals
// out of the cards; here we only decide where the cards are, which way they face and how they shade.

import { FAMILY, FOLIAGE } from '../../core/ids.js';
import { TAU, lerp, clamp, hash01 } from '../../core/math.js';
import { vadd, vsub, vscale, vmad, vdot, vcross, vnorm, shade } from './rig.js';

/**
 * A card of leaves (or flowers). `c` is its centre, `n` the way it faces, `up` the direction from the twig
 * to the leaf tips (made perpendicular to n here).
 * o: { material (FOLIAGE id, default LEAF), shape (p0), cells (p1), seed (p2), color, size: [width, height],
 *      weight: [stem, tip] sway weights, shadeNormal (unit: the canopy's outward direction at the card, blended
 *      into the normals so the crown shades as one volume instead of a pile of cards), cup (0 for a flat
 *      quad; otherwise the middle row is pushed along n by cup * height so the card is dished) }
 */
export function leafCard(mb, c, n, up, o) {
  const v = vnorm(vsub(up, vscale(n, vdot(up, n)))), u = vcross(v, n), rows = o.cup ? 2 : 1, first = mb.count;
  const [w, h] = o.size, sn = o.shadeNormal || n;
  mb.family(FAMILY.FOLIAGE).material(o.material ?? FOLIAGE.LEAF, o.shape, o.cells, o.seed);
  for (let i = 0; i <= rows; i++) {
    const f = i / rows, bulge = o.cup ? o.cup * h * (1 - (2 * f - 1) * (2 * f - 1)) : 0;
    mb.color(shade(o.color, lerp(0.82, 1.06, f))).occlusion(lerp(o.weight[0], o.weight[1], f));
    for (const s of [-0.5, 0.5]) {
      const p = vadd(vadd(vmad(c, u, s * w), vscale(v, (f - 0.5) * h)), vscale(n, bulge));
      // Towards the tips the card turns its face away from the canopy centre, as real sprays do.
      const m = vnorm(vadd(vadd(vscale(n, 0.55), vscale(sn, 0.8)), vscale(v, (f - 0.5) * 0.5)));
      mb.vertex(p[0], p[1], p[2], m[0], m[1], m[2], s + 0.5, f);
    }
  }
  for (let i = 0; i < rows; i++) { const q = first + i * 2; mb.quad(q, q + 1, q + 3, q + 2); }
}

/**
 * An opaque, lumpy ellipsoid of "leafy mass": the dark interior that stops a canopy from being a
 * see-through shell, and the whole crown at the far level. Its uv is in metres over the surface.
 * o: { seed, color, weight, lump (0..0.4 radius noise), shape (LEAF p0: which leaf the shader tiles it with) }
 */
export function leafMass(mb, centre, radii, sides, bands, o) {
  const first = mb.count, girth = Math.PI * (radii[0] + radii[2]), rise = Math.PI * 0.5 * (radii[1] + 0.5 * (radii[0] + radii[2]));
  mb.family(FAMILY.FOLIAGE).material(FOLIAGE.LEAF, o.shape || 0, 0, o.seed);
  for (let i = 0; i <= bands; i++) {
    const lat = Math.PI * (i / bands - 0.5), cl = Math.cos(lat), sl = Math.sin(lat);
    // Lit from above, in shade below: the mass carries the canopy's large-scale light and dark.
    mb.color(shade(o.color, lerp(0.62, 1, i / bands))).occlusion(o.weight);
    for (let j = 0; j <= sides; j++) {
      const a = (j % sides) / sides * TAU, d = [cl * Math.cos(a), sl, cl * Math.sin(a)];
      const k = i === 0 || i === bands ? 1 : 1 + (o.lump || 0) * (hash01(o.seed, i, j % sides) - 0.5) * 2;
      mb.vertex(centre[0] + d[0] * radii[0] * k, centre[1] + d[1] * radii[1] * k, centre[2] + d[2] * radii[2] * k,
        d[0] / radii[0], d[1] / radii[1], d[2] / radii[2], j / sides * girth, i / bands * rise);
    }
  }
  const w = sides + 1;
  for (let i = 0; i < bands; i++) for (let j = 0; j < sides; j++) { const q = first + i * w + j; mb.quad(q, q + w, q + w + 1, q + 1); }
}

/**
 * A card of grass blades (or stalks, or weed leaves) rooted on the ground along a short line through
 * `base`, leaning outwards towards `azimuth` and arching over.
 * o: { width, height, lean (radians from the vertical at the root), arch (extra lean gained by the tip),
 *      segs, kind (0 bunch blades, 1 seed stalks, 2 weed leaves, 3 turf), fade (cut-off distance in units of 5 m,
 *      over the last part of which the shader thins the card away; 0 = never), blades (p1), seed (p2),
 *      color, tip (colour at the tips) }
 * The card is a plain ribbon: the shader bunches the blades of a tuft at the root and fans them out to its full width.
 * The sway weight is 0 on the ground line and 1 at the tips. Normals are tilted most of the way to the
 * vertical so a tuft takes the same light as the ground it stands on and melts into a lawn.
 */
export function bladeCard(mb, base, azimuth, o) {
  const out = [Math.cos(azimuth), 0, Math.sin(azimuth)], side = [-out[2], 0, out[0]], first = mb.count;
  mb.family(FAMILY.FOLIAGE).material(FOLIAGE.GRASS, o.kind + 8 * o.fade, o.blades, o.seed);
  let p = base.slice();
  for (let k = 0; k <= o.segs; k++) {
    const f = k / o.segs, angle = o.lean + o.arch * f;
    if (k) { const a = o.lean + o.arch * (f - 0.5 / o.segs); p = vadd(p, vscale(vadd(vscale(out, Math.sin(a)), [0, Math.cos(a), 0]), o.height / o.segs)); }
    const n = vnorm(vadd([0, 1, 0], vscale(vsub(vscale(out, -Math.cos(angle)), [0, -Math.sin(angle), 0]), 0.35)));
    mb.color([lerp(o.color[0] * 0.7, o.tip[0], f), lerp(o.color[1] * 0.7, o.tip[1], f), lerp(o.color[2] * 0.7, o.tip[2], f)]).occlusion(f);
    for (const s of [-1, 1]) { const q = vmad(p, side, s * 0.5 * o.width); mb.vertex(q[0], q[1], q[2], n[0], n[1], n[2], s > 0 ? 1 : 0, f); }
  }
  for (let k = 0; k < o.segs; k++) { const q = first + k * 2; mb.quad(q, q + 1, q + 3, q + 2); }
}

/**
 * Plants that stand on the ground are anchored there: scale the sway weight of every vertex from `first`
 * on by its height (full weight from `height` up), so whatever touches the ground does not slide over it.
 */
export function anchorToGround(mb, first, height) {
  for (let i = first; i < mb.count; i++) mb.col[i * 4 + 3] = Math.round(mb.col[i * 4 + 3] * clamp(mb.pos[i * 3 + 1] / height, 0, 1));
}
