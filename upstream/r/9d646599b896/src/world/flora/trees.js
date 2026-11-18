// Broadleaf trees: a sea grape (low, sprawling, pale twisting stems, big round leaves) and a banyan-type
// fig (massive trunk, wide flat dome, aerial roots dropping from the limbs).
//
// The woody skeleton is grown limb by limb from one seed; leaf-cluster cards hang around the twig ends
// over opaque leafy masses. The skeleton consumes the random stream identically at every level of
// detail, so the levels share one shape; lower levels only draw less of it.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, SOLID } from '../../core/ids.js';
import { TAU, DEG, lerp, clamp, makeRng } from '../../core/math.js';
import { vadd, vsub, vscale, vmad, vnorm, vrotate, vperp, hex, shade, sweepTube, GOLDEN_ANGLE } from './rig.js';
import { SPECIES } from './trunk.js';
import { leafCard, leafMass } from './canopy.js';

const randomUnit = (r) => { const y = r.range(-1, 1), a = r.range(0, TAU), c = Math.sqrt(1 - y * y); return [c * Math.cos(a), y, c * Math.sin(a)]; };

/** Grow one limb and its children. Records twig ends in t.tips and limb midpoints in t.sites. */
function limb(t, start, dir, length, radius, depth, v0) {
  const k = t.kind, segs = depth === 0 ? k.trunkSegs : 4, rings = [{ c: start, r: radius * (depth === 0 ? k.flare : 1.12), v: v0 }];
  let p = start, d = dir, v = v0;
  for (let i = 1; i <= segs; i++) {
    const f = i / segs;
    // Limbs wander (twisting stems), reach out, and turn up towards the light near their ends.
    d = vnorm(vadd(vadd(d, vscale(randomUnit(t.rng), k.wander)), [0, k.lift * (depth ? 1 : 0), 0]));
    p = vmad(p, d, length / segs); v += length / segs;
    rings.push({ c: p, r: radius * (depth === 0 ? lerp(k.flare, 1, Math.min(1, f * 2.5)) * lerp(1, 0.86, f) : lerp(1, k.taper, f)), v });
  }
  const shadeAt = lerp(1, 0.62, depth / k.depth);
  for (const ring of rings) { ring.color = shade(k.bark, lerp(0.92, 1.05, t.rng.next())); ring.weight = shadeAt * (ring.c[1] < 0.3 ? 0.65 : 1); }
  const sides = [[12, 8, 6, 5, 3], [8, 6, 3, 3, 0], [5, 3, 0, 0, 0]][t.level][Math.min(depth, 4)];
  if (sides) {
    t.mb.family(FAMILY.SOLID).material(SOLID.TRUNK, SPECIES.BROADLEAF, 0, k.seed & 255);
    // Thin limbs, and the stems of the far level, keep their bends with half the rings. Every limb is closed
    // at its end: the children that leave a fork are thinner than the limb they leave.
    const coarse = depth ? sides <= 4 : t.level === 2;
    sweepTube(t.mb, coarse ? rings.filter((_, i) => i % 2 === 0 || i === segs) : rings, sides, { capEnd: true });
  }
  if (depth >= 1) t.sites.push({ p: rings[2].c, r: rings[2].r, depth });
  if (depth >= k.depth) { t.tips.push({ p, d }); return; }
  const n = k.forks[Math.min(depth, k.forks.length - 1)], turn = t.rng.range(0, TAU), axis0 = vperp(d);
  for (let i = 0; i < n; i++) {
    const axis = vrotate(axis0, d, turn + i * TAU / n + t.rng.range(-0.35, 0.35));
    const child = vrotate(d, axis, t.rng.range(k.spread[0], k.spread[1]) * DEG);
    limb(t, p, child, length * k.shrink * t.rng.range(0.85, 1.15), radius * k.taper * (n > 2 ? 0.72 : 0.8), depth + 1, v);
  }
}

/** Leaf clusters around every twig end. */
function foliage(t) {
  const k = t.kind, level = t.level, centre = vscale(t.tips.reduce((a, b) => vadd(a, b.p), [0, 0, 0]), 1 / t.tips.length);
  let reach = 0; for (const tip of t.tips) reach = Math.max(reach, Math.hypot(tip.p[0], tip.p[2]));
  centre[1] -= k.cluster * 0.6;
  // Far: one cluster in every few stands for its neighbours, grown to fill their place and drawn towards the
  // middle of the crown by as much as it grew, so that the outline stays where it was. One mass fills the crown.
  const far = level === 2, grow = far ? k.farGrow : 1, size = k.cluster * grow, pull = (grow - 1) * (k.cluster + 0.6 * k.card);
  if (far) {
    let low = Infinity, high = -Infinity; for (const tip of t.tips) { low = Math.min(low, tip.p[1]); high = Math.max(high, tip.p[1]); }
    leafMass(t.mb, [centre[0], (low + high) / 2, centre[2]], [reach * 0.62, (high - low) * 0.5, reach * 0.62], 6, 2,
      { seed: k.seed & 255, color: shade(k.leaf, 0.92), weight: 0.4, lump: 0.25, shape: k.shape });
  }
  t.tips.forEach((tip, i) => {
    if (far && i % k.farEvery) return;
    const r = t.rng.fork(300 + i), out = vmad(tip.p, tip.d, k.cluster * 0.25), heart = vmad(out, vnorm(vsub(centre, out)), pull);
    const weight = clamp(0.25 + 0.75 * Math.hypot(heart[0], heart[2]) / reach, 0, 1);
    if (!far) leafMass(t.mb, heart, [size * 0.74, size * 0.5, size * 0.74], level ? 5 : 7, level ? 2 : 3,
      { seed: (k.seed + i) & 255, color: shade(k.leaf, 0.92), weight: weight * 0.6, lump: 0.25, shape: k.shape });
    const cards = k.cards[level];
    for (let c = 0; c < cards; c++) {
      // All round a ball about the twig end, thinnest underneath; sprays stand out at all angles.
      const y = lerp(-0.8, 1, Math.sqrt((c + 0.5) / cards)), a = c * GOLDEN_ANGLE + r.range(-0.3, 0.3), q = Math.sqrt(1 - y * y);
      const dir = [q * Math.cos(a), y, q * Math.sin(a)], at = vmad(heart, [dir[0], dir[1] * 0.7, dir[2]], size * r.range(0.78, 1.02));
      const outwards = vnorm(vsub(at, centre)), n = vadd(vadd(vscale(dir, 0.6), vscale(outwards, 0.5)), vscale(randomUnit(r), 0.7));
      // Under the cluster the sprays hang as a fringe that hides the flat belly of the mass.
      if (y < 0) n[1] *= 0.15;
      const side = k.card * grow * r.range(0.8, 1.2) * (level ? 1.4 : 1);
      leafCard(t.mb, at, vnorm(n), y < 0 ? [dir[0] * 0.3, -1, dir[2] * 0.3] : vadd(vscale(dir, 0.6), [0, 0.5 - 0.9 * r.next(), 0]), {
        // the leaves keep their size on a grown card
        shape: k.shape, cells: Math.round(k.cells * grow), seed: r.int(0, 255), color: shade(k.leaf, r.range(0.88, 1.14) * lerp(0.78, 1.08, (y + 0.8) / 1.8)),
        size: [side, side], weight: [weight * 0.75, weight], shadeNormal: outwards, cup: level ? 0 : 0.12,
      });
    }
  });
}

/** Aerial roots of a fig: thin ropes hanging from the big limbs, a few thickened into props that reach the ground. */
function aerialRoots(t) {
  const k = t.kind;
  t.sites.filter((s) => s.depth <= 2).forEach((site, i) => {
    const r = t.rng.fork(600 + i);
    if (i % 2 || site.p[1] < 2.5 || t.level === 2) return;
    const prop = r.chance(0.45), bottom = prop ? 0 : site.p[1] * r.range(0.25, 0.6), rad = prop ? r.range(0.07, 0.16) : r.range(0.015, 0.03);
    const rings = [];
    for (let j = 0; j <= 3; j++) {
      const f = j / 3, y = lerp(site.p[1] - site.r * 0.5, bottom, f);
      rings.push({ c: [site.p[0] + Math.sin(f * 3 + i) * 0.08, y, site.p[2] + Math.cos(f * 2 + i) * 0.08], r: rad * (prop ? lerp(0.8, 1.5, f * f) : 1), v: site.p[1] - y, color: shade(k.bark, 0.9), weight: lerp(0.7, 1, f) * (y < 0.3 ? 0.65 : 1) });
    }
    t.mb.family(FAMILY.SOLID).material(SOLID.TRUNK, SPECIES.BROADLEAF, 0, k.seed & 255);
    sweepTube(t.mb, rings, t.level ? 3 : prop ? 6 : 4, { capStart: true, capEnd: !prop });
  });
}

function tree(kind, level) {
  const t = { mb: new MeshBuilder(8192), rng: makeRng(kind.seed), kind, level, tips: [], sites: [] };
  kind.stems.forEach((stem) => {
    // A leaning stem starts far enough under the ground that the whole rim of its foot is buried.
    const dir = vnorm(stem.dir), radius = kind.radius * stem.scale, sink = radius * kind.flare * Math.hypot(dir[0], dir[2]) / dir[1] + 0.02;
    limb(t, vmad(stem.at, dir, -sink), dir, kind.trunk * stem.scale + sink, radius, 0, 0);
  });
  if (kind.roots) aerialRoots(t);
  foliage(t);
  return t.mb;
}

const SEA_GRAPE = {
  seed: 211, bark: hex('#9A9084'), leaf: hex('#4B6A2E'), shape: 0, cells: 5, card: 1.15, cluster: 1.0, cards: [20, 6, 11], farEvery: 2, farGrow: 1.3,
  // Several stems from the ground, sprawling as much as they rise.
  stems: [{ at: [0, 0, 0], dir: [0.25, 1, 0.1], scale: 1 }, { at: [0.25, 0, 0.2], dir: [-0.5, 1, 0.45], scale: 0.85 }, { at: [-0.1, 0, -0.25], dir: [0.1, 1, -0.6], scale: 0.8 }],
  trunk: 1.7, trunkSegs: 4, radius: 0.15, flare: 1.5, taper: 0.72, depth: 3, forks: [2, 2, 2], spread: [22, 48], shrink: 0.8, wander: 0.2, lift: 0.1,
};
const BANYAN = {
  seed: 307, bark: hex('#7B7468'), leaf: hex('#33542A'), shape: 1, cells: 12, card: 2.2, cluster: 1.75, cards: [18, 5, 8], farEvery: 3, farGrow: 1.5, roots: true,
  stems: [{ at: [0, 0, 0], dir: [0.03, 1, -0.02], scale: 1 }],
  trunk: 3.0, trunkSegs: 5, radius: 0.62, flare: 1.7, taper: 0.7, depth: 4, forks: [5, 3, 2, 2], spread: [30, 58], shrink: 0.8, wander: 0.14, lift: 0.11,
};

export const TREES = [
  { name: 'tree_broadleaf_a', build: (level) => tree(SEA_GRAPE, level), tags: ['tree', 'broadleaf', 'seagrape', 'beach', 'park'], lod: [40, 130, 500], collider: { kind: 'cylinder', radius: 0.45, height: 1.6 }, footprint: 1.2 },
  { name: 'tree_broadleaf_b', build: (level) => tree(BANYAN, level), tags: ['tree', 'broadleaf', 'banyan', 'park', 'shade', 'large'], lod: [50, 170, 700], collider: { kind: 'cylinder', radius: 1.0, height: 3 }, footprint: 2.2 },
];
