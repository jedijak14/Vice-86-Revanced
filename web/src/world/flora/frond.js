// Palm leaves as real geometry.
//
// A feather (pinnate) frond is a curved, tapering rachis that carries a "curtain" of leaflets on each
// side. The curtain is cut into cards; each card is a short strip that follows the hang of the leaflets
// and carries several leaflets, which the FOLIAGE shader cuts out of it with a procedural alpha
// (uv = across the card, root to tip; material p1 = leaflets on the card, p2 = wind phase and pattern
// seed). Lower levels of detail use the same construction with fewer, longer cards, so a palm keeps its
// true three-dimensional silhouette at every distance.
//
// A fan (costapalmate) leaf is a stalk and a pleated, V-folded disc of segments that are joined near the
// hub and free, pointed and drooping at the rim.
//
// Conventions: angles in radians, elevation above the horizon, azimuth about +Y from +X towards +Z.
// The vertex colour alpha is the sway weight (0 where the leaf is attached to the trunk).

import { FAMILY, FOLIAGE } from '../../core/ids.js';
import { clamp, lerp, smoothstep } from '../../core/math.js';
import { vadd, vsub, vscale, vmad, vcross, vnorm, vlerp, vrotate, dirFromAngles, table, shade, sweepTube, DOWN } from './rig.js';

/** p1 value that marks opaque plant tissue in the FROND material (rachis, stalk, spear, fruit). */
export const FROND_SOLID = 255;

/** p0 of the FROND material: selects the leaflet outline and surface in the shader. */
export const FROND_KIND = Object.freeze({ COCONUT: 0, ROYAL: 1, FAN: 2, DATE: 3, STRAND: 4 });

/** p2 of the FROND material: wind phase of the whole frond (high nibble) and pattern seed of the card (low nibble). */
export const frondSeed = (phase, card) => ((phase & 15) << 4) | (card & 15);

/**
 * Frames along a rachis that leaves `base` at (azimuth, elevation) and sags under gravity:
 * elevation(f) = elevation - droop * f^droopPow, measured in the world, so a frond on a leaning palm
 * still hangs towards the ground. `sweep` bends it sideways (wind set); `twist` rolls the leaf about
 * its own axis over the outer part so that the outer leaflets hang in a vertical plane.
 * Returns n + 1 frames { p, t (tangent), up (upper-surface normal), side, f }.
 */
export function rachisFrames(spec, n) {
  const frames = [], twistStart = spec.twistStart ?? 0.45;
  const tangentAt = (f) => dirFromAngles(spec.azimuth + spec.sweep * f, spec.elevation - spec.droop * Math.pow(f, spec.droopPow));
  let p = spec.base.slice(), previous = tangentAt(0);
  for (let i = 0; i <= n; i++) {
    const f = i / n, t = tangentAt(f);
    if (i > 0) p = vmad(p, vnorm(vadd(previous, t)), spec.length / n);
    const az = spec.azimuth + spec.sweep * f, flat = [-Math.sin(az), 0, Math.cos(az)];
    const roll = (spec.twist || 0) * smoothstep(twistStart, 1, f);
    frames.push({ p, t, up: vrotate(vnorm(vcross(flat, t)), t, roll), side: vrotate(flat, t, roll), f });
    previous = t;
  }
  return frames;
}

/** Interpolated frame at fraction f of a list from rachisFrames. */
export function frameAt(frames, f) {
  const x = clamp(f, 0, 1) * (frames.length - 1), i = Math.min(frames.length - 2, Math.floor(x)), k = x - i, a = frames[i], b = frames[i + 1];
  return { p: vlerp(a.p, b.p, k), t: vnorm(vlerp(a.t, b.t, k)), up: vnorm(vlerp(a.up, b.up, k)), side: vnorm(vlerp(a.side, b.side, k)), f };
}

/** One edge of a leaflet card: the polyline a leaflet rooted at fraction f of the frond follows, with its normals. */
function leafletEdge(frames, spec, row, side, f, segs, vary) {
  const fr = frameAt(frames, f), L = spec.leaflet, blade = clamp((f - spec.petiole) / (1 - spec.petiole), 0, 1);
  const length = L.length * table(L.profile, blade) * row.length * vary.length;
  const plan = lerp(L.planBase, L.planTip, blade), roof = row.roof + vary.roof;
  // Root direction: swept towards the tip by `plan`, tilted below the plane of the frond by `roof`.
  const across = vsub(vscale(fr.side, side * Math.cos(roof)), vscale(fr.up, Math.sin(roof)));
  const root = vnorm(vadd(vscale(fr.t, Math.cos(plan)), vscale(across, Math.sin(plan))));
  // Leaflets hang towards the ground, mostly in the world and a little relative to the leaf itself.
  const rest = vnorm(vadd(vscale(DOWN, 0.7), vscale(fr.up, -0.3)));
  const points = [fr.p.slice()], normals = [];
  let p = fr.p;
  for (let k = 0; k < segs; k++) {
    const h = clamp(row.hang * Math.pow((k + 0.6) / segs, 1.3), 0, 0.97), d = vnorm(vlerp(root, rest, h));
    p = vmad(p, d, length / segs); points.push(p);
    normals.push(vnorm(vscale(vcross(d, fr.t), side)));
  }
  normals.push(normals[segs - 1]);
  return { points, normals };
}

/** The leaflet cards of one row on both sides of a frond. */
function leafletCards(mb, frames, spec, row, cut) {
  const rng = spec.rng, segs = cut.segs, start = row.start ?? spec.petiole, steady = { length: 1, roof: 0 };
  for (const side of [1, -1]) {
    for (let i = 0; i < cut.cards; i++) {
      // Jitter is per card, so neighbouring cards do not line up into a machine-made comb.
      const vary = cut.jitter ? { length: rng.range(0.86, 1.06) * (rng.chance(0.07) ? 0.6 : 1), roof: rng.range(-0.1, 0.1) } : steady;
      const fa = lerp(start, 1, i / cut.cards), fb = lerp(start, 1, (i + 1) / cut.cards);
      const a = leafletEdge(frames, spec, row, side, fa, segs, vary), b = leafletEdge(frames, spec, row, side, fb, segs, vary);
      const leaflets = clamp(Math.round((fb - fa) * spec.length / spec.leaflet.pitch), 1, 250);
      mb.material(FOLIAGE.FROND, spec.kind, leaflets, frondSeed(spec.phase, rng.int(0, 15)));
      const tone = cut.jitter ? rng.range(0.9, 1.08) : 1, first = mb.count;
      for (let k = 0; k <= segs; k++) {
        // The inner crown is in the shade of everything above it: darker near the trunk and at the leaflet roots.
        const depth = (e) => tone * lerp(0.62, 1, smoothstep(0.0, 0.5, e)) * lerp(0.86, 1, k / segs);
        const v = (k / segs) * cut.tip, na = a.normals[k], nb = b.normals[k];
        mb.color(shade(spec.colors.leaf, depth(fa))).occlusion(spec.stiffness * fa);
        mb.vertex(a.points[k][0], a.points[k][1], a.points[k][2], na[0], na[1], na[2], 0, v);
        mb.color(shade(spec.colors.leaf, depth(fb))).occlusion(spec.stiffness * fb);
        mb.vertex(b.points[k][0], b.points[k][1], b.points[k][2], nb[0], nb[1], nb[2], 1, v);
      }
      for (let k = 0; k < segs; k++) {
        const q = first + k * 2;
        // Front faces are the upper (sun) side of the leaf on both sides of the rachis.
        if (side > 0) mb.quad(q, q + 2, q + 3, q + 1); else mb.quad(q, q + 1, q + 3, q + 2);
      }
    }
  }
}

/** Rachis as a three-sided tapering tube (near) or a flat strip along the bare stalk (lower levels). */
function rachis(mb, frames, spec, cut) {
  mb.material(FOLIAGE.FROND, spec.kind, FROND_SOLID, frondSeed(spec.phase, 0));
  const [r0, r1] = spec.rachisRadius;
  if (cut.rachis === 'tube') {
    const rings = frames.map((fr) => ({
      c: fr.p, r: lerp(r0, r1, Math.pow(fr.f, 0.7)) * (1 + 2.2 * Math.pow(1 - fr.f, 10)),   // flares where it clasps the trunk
      v: fr.f * spec.length, color: shade(spec.colors.rachis, lerp(0.7, 1, smoothstep(0, 0.35, fr.f))), weight: spec.stiffness * fr.f,
    }));
    sweepTube(mb, rings, 3, { frame: vscale(frames[0].up, -1) });
    return;
  }
  // Flat strip over the bare stalk only: beyond it the leaflet ribbons meet along the rachis and cover it.
  const steps = 2, first = mb.count;
  for (let i = 0; i <= steps; i++) {
    const fr = frameAt(frames, spec.petiole * 1.15 * i / steps), w = lerp(r0, r1, fr.f) * 1.6;
    mb.color(shade(spec.colors.rachis, 0.85)).occlusion(spec.stiffness * fr.f);
    const a = vmad(fr.p, fr.side, -w), b = vmad(fr.p, fr.side, w);
    mb.vertex(a[0], a[1], a[2], fr.up[0], fr.up[1], fr.up[2], 0, fr.f);
    mb.vertex(b[0], b[1], b[2], fr.up[0], fr.up[1], fr.up[2], 1, fr.f);
  }
  for (let i = 0; i < steps; i++) { const q = first + i * 2; mb.quad(q, q + 1, q + 3, q + 2); }
}

/**
 * Build one feather frond.
 *
 * spec: {
 *   base, azimuth, elevation, length, droop, droopPow, sweep, twist, twistStart?,   the rachis curve (see rachisFrames)
 *   petiole,                     fraction of the length that is bare stalk
 *   rachisRadius: [atTrunk, atTip],
 *   kind,                        FROND_KIND
 *   phase,                       0..15, wind phase shared by the whole frond
 *   stiffness,                   0..1 scale on the sway weight (young upright fronds barely move)
 *   colors: { leaf, rachis },    sRGB triples
 *   leaflet: { length, pitch, planBase, planTip, profile: [[bladeFraction, lengthFactor], ...] },
 *   rows: [{ roof, hang, length, start? }],   one curtain per entry: roof = angle below the frond plane,
 *                                hang = 0..1 how far the leaflets fall towards vertical, length = scale
 *   rng
 * }
 * cut: { rachisSegs, cards (per side and row), segs (along a leaflet), jitter, rachis: 'tube' | 'strip' | 'none',
 *        tip: uv.y at the free edge of a card. 1 shows the leaflets to their points; less shows only their broad
 *        roots, so a distant card is filled to its edge and stands for the fronds that were left out }
 */
export function buildFeatherFrond(mb, spec, cut) {
  const frames = rachisFrames(spec, cut.rachisSegs);
  mb.family(FAMILY.FOLIAGE);
  if (cut.rachis !== 'none') rachis(mb, frames, spec, cut);
  for (const row of spec.rows) leafletCards(mb, frames, spec, row, cut);
  return frames;
}

/** A closed spear: the newest, still folded leaf standing at the top of the crown. */
export function buildSpear(mb, spec, segs) {
  const frames = rachisFrames({ ...spec, sweep: 0, twist: 0 }, segs);
  mb.family(FAMILY.FOLIAGE).material(FOLIAGE.FROND, spec.kind, FROND_SOLID, frondSeed(spec.phase, 0));
  const rings = frames.map((fr) => ({
    c: fr.p, r: spec.radius * Math.max(0.04, Math.sin(Math.PI * Math.min(1, 0.12 + fr.f * 0.88)) * (1 - 0.55 * fr.f)),
    v: fr.f * spec.length, color: shade(spec.color, lerp(0.75, 1.05, fr.f)), weight: spec.stiffness * fr.f,
  }));
  sweepTube(mb, rings, 4);
}

/**
 * Build one fan (costapalmate) leaf.
 *
 * spec: {
 *   base, azimuth, elevation,    where the stalk leaves the trunk and in which direction
 *   stalk, stalkDroop,           stalk length and how far it sags (radians) along its length
 *   stalkRadius,
 *   radius,                      blade radius from the hub to the segment tips
 *   span,                        half-angle of the fan about its midrib
 *   fold,                        V-fold of the two halves about the midrib
 *   curl,                        how far the midrib (costa) curls down, as a fraction of the radius
 *   tipDroop,                    how far the free segment tips hang, as a fraction of the radius
 *   pleat,                       pleat depth in metres at the rim (0 for none)
 *   segments,                    leaf segments across the whole fan (shader cuts them out)
 *   kind, phase, stiffness, colors: { leaf, rachis }, rng
 * }
 * cut: { wedges (even), rings, stalk: 'tube' | 'strip' | 'none' (the blade then reaches back to the leaf base),
 *        tip: uv.y at the rim, as for feather fronds }
 */
export function buildFanLeaf(mb, spec, cut) {
  const stalkFrames = rachisFrames({ base: spec.base, azimuth: spec.azimuth, elevation: spec.elevation, length: spec.stalk, droop: spec.stalkDroop, droopPow: 1.6, sweep: 0, twist: 0 }, 3);
  const hubWeight = 0.4 * spec.stiffness;
  mb.family(FAMILY.FOLIAGE);
  if (cut.stalk !== 'none') {
    mb.material(FOLIAGE.FROND, spec.kind, FROND_SOLID, frondSeed(spec.phase, 0));
    if (cut.stalk === 'tube') {
      sweepTube(mb, stalkFrames.map((fr) => ({ c: fr.p, r: spec.stalkRadius * lerp(1.5, 0.8, fr.f), v: fr.f * spec.stalk, color: spec.colors.rachis, weight: hubWeight * fr.f })), 3, { frame: vscale(stalkFrames[0].up, -1) });
    } else {
      const first = mb.count;
      for (const fr of [stalkFrames[0], stalkFrames[3]]) {
        mb.color(spec.colors.rachis).occlusion(hubWeight * fr.f);
        const a = vmad(fr.p, fr.side, -spec.stalkRadius * 1.5), b = vmad(fr.p, fr.side, spec.stalkRadius * 1.5);
        mb.vertex(a[0], a[1], a[2], fr.up[0], fr.up[1], fr.up[2], 0, fr.f);
        mb.vertex(b[0], b[1], b[2], fr.up[0], fr.up[1], fr.up[2], 1, fr.f);
      }
      mb.quad(first, first + 1, first + 3, first + 2);
    }
  }
  const hub = stalkFrames[3], wedges = cut.wedges, rings = cut.rings, lift = Math.tan(spec.fold), first = mb.count;
  mb.material(FOLIAGE.FROND, spec.kind, clamp(spec.segments, 1, 250), frondSeed(spec.phase, spec.rng.int(0, 15)));
  const tone = spec.rng.range(0.92, 1.06);
  for (let r = 0; r <= rings; r++) {
    // Rings crowd towards the rim, where the segments separate and bend.
    const rho = lerp(0.06, 1, Math.pow(r / rings, 0.8));
    for (let j = 0; j <= wedges; j++) {
      const a = lerp(-spec.span, spec.span, j / wedges), sa = Math.sin(a), ca = Math.cos(a);
      const dir = vnorm(vadd(vadd(vscale(hub.t, ca), vscale(hub.side, sa)), vscale(hub.up, Math.abs(sa) * lift)));
      let p = r === 0 && cut.stalk === 'none' ? spec.base.slice() : vmad(hub.p, dir, spec.radius * rho);
      const zig = (j % 2 ? 1 : -1) * spec.pleat * rho;
      p = vmad(p, hub.up, zig);
      p[1] -= spec.radius * (spec.curl * rho * rho * (0.5 + 0.5 * ca) + spec.tipDroop * Math.pow(smoothstep(0.45, 1, rho), 2));
      mb.color(shade(spec.colors.leaf, tone * lerp(0.7, 1, rho))).occlusion(spec.stiffness * lerp(0.4, 1, rho));
      mb.vertex(p[0], p[1], p[2], hub.up[0], hub.up[1], hub.up[2], j / wedges, rho * cut.tip);
    }
  }
  const w = wedges + 1;
  for (let r = 0; r < rings; r++) for (let j = 0; j < wedges; j++) {
    const q = first + r * w + j;
    mb.quad(q, q + 1, q + w + 1, q + w);
  }
  // Hard creases along the pleats near the camera, a smooth dish further away.
  mb.computeNormals(spec.pleat > 0 ? 28 : 180, first, mb.count);
}
