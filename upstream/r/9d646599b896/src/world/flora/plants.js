// Planting below tree height: shrubs, clipped hedge, flowerbed, and the ground-level flora that makes
// lawns, verges, vacant lots and the back of the beach read as living ground (grass tufts, dune grass
// and sea oats, weeds, creeping ground cover, sea grape scrub).
//
// These are placed in very large numbers, so each one is a few dozen to a few hundred triangles, has
// at most two levels and a cut-off distance, and gets its richness from the FOLIAGE shader.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, FOLIAGE } from '../../core/ids.js';
import { TAU, lerp, makeRng } from '../../core/math.js';
import { vadd, vscale, vnorm, hex, shade, mixColor, GOLDEN_ANGLE } from './rig.js';
import { leafCard, leafMass, bladeCard, anchorToGround } from './canopy.js';

const COLOR = {
  hibiscusLeaf: hex('#3E6428'), hibiscusRed: hex('#F43B41'), hibiscusPink: hex('#E674A1'), crotonLeaf: hex('#4A6A22'),
  ixoraLeaf: hex('#3A5E26'), ixoraBloom: hex('#E8452C'), hedge: hex('#3F6226'), seaGrape: hex('#55702F'),
  lawn: hex('#4A7035'), lawnTip: hex('#64863D'), rough: hex('#465E2F'), roughTip: hex('#6C7C42'), straw: hex('#978B5E'),
  dune: hex('#6F7F45'), duneTip: hex('#A9A866'), weed: hex('#47602B'), weedTip: hex('#63773A'),
  cover: hex('#45682B'), vine: hex('#4E7434'), vineBloom: hex('#C46BB5'), lantana: hex('#E9B932'), white: hex('#E9E6D8'), violet: hex('#8A5CC4'),
};

/**
 * A mound of leaf cards over an opaque heart: the body of every shrub and bush.
 * o: { radius: [x, y, z] of the mound (it sits on the ground), cards, card (size), shape, cells, leaf,
 *      flowers: { count, kind, cells, color, size } | null, lump, coarse (a low-resolution heart for small plants) }
 */
function mound(mb, rng, o, level, centre = [0, 0, 0]) {
  const [rx, ry, rz] = o.radius, heart = vadd(centre, [0, ry * 0.42, 0]), coarse = level || o.coarse;
  // The heart is tiled with leaves by the shader, so it can fill most of the bush; the cards make the ragged outline.
  leafMass(mb, heart, [rx * 0.82, ry * 0.52, rz * 0.82], coarse ? 6 : 9, coarse ? 3 : 4, { seed: rng.int(0, 255), color: shade(o.leaf, 0.9), weight: 0.3, lump: o.lump ?? 0.22, shape: o.shape });
  const cards = level ? Math.ceil(o.cards / 3) : o.cards, size = o.card * (level ? 1.5 : 1);
  const place = (i, n, r, lift, fn) => {
    // Evenly over the dome, from the skirt at the ground to the top.
    const y = lerp(0.1, 0.98, (i + 0.5) / n), a = i * GOLDEN_ANGLE + r.range(-0.25, 0.25), q = Math.sqrt(1 - y * y);
    const dir = [q * Math.cos(a), y, q * Math.sin(a)], k = r.range(0.92, 1.08) + lift;
    fn(vadd(centre, [dir[0] * rx * k, dir[1] * ry * k, dir[2] * rz * k]), vnorm([dir[0] / rx, dir[1] / ry, dir[2] / rz]), y);
  };
  for (let i = 0; i < cards; i++) {
    const r = rng.fork(i + 1);
    // Sprays stand out from the surface at all angles, so some are seen edge-on against the sky and break the outline.
    place(i, cards, r, 0, (at, outwards, y) => leafCard(mb, at, vnorm(vadd(outwards, [r.range(-0.8, 0.8), r.range(-0.2, 0.7), r.range(-0.8, 0.8)])), [outwards[0] * 0.8, 1, outwards[2] * 0.8], {
      shape: o.shape, cells: o.cells, seed: r.int(0, 255), color: shade(o.leaf, r.range(0.88, 1.14) * lerp(0.8, 1.08, y)),
      size: [size * r.range(0.85, 1.15), size * r.range(0.85, 1.15)], weight: [0.25 + 0.4 * y, 0.45 + 0.55 * y], shadeNormal: outwards, cup: level ? 0 : 0.1,
    }));
  }
  if (!o.flowers) return;
  const f = o.flowers, count = level ? Math.ceil(f.count / 2) : f.count;
  for (let i = 0; i < count; i++) {
    const r = rng.fork(400 + i);
    // Flowers ride just proud of the leaves, facing out.
    place(i, count, r, 0.06, (at, outwards, y) => leafCard(mb, at, outwards, [0, 1, 0], {
      material: FOLIAGE.FLOWER, shape: f.kind, cells: f.cells, seed: r.int(0, 255), color: shade(Array.isArray(f.color[0]) ? r.pick(f.color) : f.color, r.range(0.9, 1.08)),
      size: [f.size, f.size], weight: [0.4 + 0.5 * y, 0.5 + 0.5 * y], shadeNormal: outwards, cup: 0,
    }));
  }
}

function shrub(o, level) {
  const mb = new MeshBuilder(1024), rng = makeRng(o.seed);
  (o.lobes || [{ at: [0, 0, 0], scale: 1 }]).forEach((lobe, i) => mound(mb, rng.fork(50 + i), { ...o, radius: vscale(o.radius, lobe.scale), cards: Math.round(o.cards * lobe.scale), flowers: o.flowers && { ...o.flowers, count: Math.round(o.flowers.count * lobe.scale) } }, level, lobe.at));
  anchorToGround(mb, 0, o.radius[1] * 0.6);
  return mb;
}

/** A 2 m run of clipped hedge along x. Both ends are plain sections of the heart, so runs butt together seamlessly. */
function hedge(level) {
  const mb = new MeshBuilder(1024), rng = makeRng(503), L = 2, H = 1.1, D = 0.8, inset = 0.07;
  // Opaque heart, a little inside the clipped surface: dark at the foot, lighter under the top. uv in metres.
  mb.family(FAMILY.FOLIAGE).material(FOLIAGE.LEAF, 3, 0, 7).occlusion(0.2);
  const x0 = -L / 2, x1 = L / 2, z = D / 2 - inset, top = H - inset, heart = shade(COLOR.hedge, 0.8);
  const face = (a, b, c, d, n, w, h, lo) => {
    const q = mb.count;
    mb.color(shade(heart, lo)); mb.vertex(a[0], a[1], a[2], n[0], n[1], n[2], 0, 0); mb.vertex(b[0], b[1], b[2], n[0], n[1], n[2], w, 0);
    mb.color(heart); mb.vertex(c[0], c[1], c[2], n[0], n[1], n[2], w, h); mb.vertex(d[0], d[1], d[2], n[0], n[1], n[2], 0, h);
    mb.quad(q, q + 1, q + 2, q + 3);
  };
  face([x0, 0, z], [x1, 0, z], [x1, top, z], [x0, top, z], [0, 0, 1], L, top, 0.55);
  face([x1, 0, -z], [x0, 0, -z], [x0, top, -z], [x1, top, -z], [0, 0, -1], L, top, 0.55);
  face([x0, top, z], [x1, top, z], [x1, top, -z], [x0, top, -z], [0, 1, 0], L, 2 * z, 1);
  face([x0, 0, -z], [x0, 0, z], [x0, top, z], [x0, top, -z], [-1, 0, 0], 2 * z, top, 0.55);
  face([x1, 0, z], [x1, 0, -z], [x1, top, -z], [x1, top, z], [1, 0, 0], 2 * z, top, 0.55);
  // The clipped skin: square cards of small leaves on the two long faces and the top.
  const n = level ? 2 : 4, cell = L / n, cells = Math.round(cell / 0.075);
  const skin = (centre, normal, up, w, h, tone, weight) => leafCard(mb, centre, normal, up, { shape: 3, cells, seed: rng.int(0, 255), color: shade(COLOR.hedge, tone * rng.range(0.92, 1.08)), size: [w, h], weight, shadeNormal: normal, cup: 0 });
  for (let i = 0; i < n; i++) {
    const x = x0 + (i + 0.5) * cell, rows = level ? 1 : 2;
    for (let j = 0; j < rows; j++) {
      const y = (j + 0.5) * H / rows, tone = lerp(0.72, 1, (j + 0.5) / rows);
      for (const s of [1, -1]) skin([x, y, s * D / 2], [0, 0, s], [0, 1, 0], cell, H / rows, tone, [0.15 + 0.5 * j / rows, 0.15 + 0.5 * (j + 1) / rows]);
    }
    for (const s of level ? [0] : [0.5, -0.5]) skin([x, H, s * D / 2], [0, 1, 0], [0, 0, -1], cell, level ? D : D / 2, 1.08, [0.7, 0.7]);
  }
  // Shoots that have grown since the last trim break the ruled top edge.
  if (!level) for (let i = 0; i < 12; i++) {
    const r = rng.fork(i + 1), x = lerp(x0 + 0.1, x1 - 0.1, (i + r.next()) / 12), s = r.sign();
    leafCard(mb, [x, H + 0.04, s * D * r.range(0.1, 0.5)], vnorm([r.range(-0.4, 0.4), 0.4, s]), [0, 1, 0], { shape: 1, cells: 3, seed: r.int(0, 255), color: shade(COLOR.hedge, 1.2), size: [0.26, 0.26], weight: [0.7, 1], shadeNormal: [0, 1, 0], cup: 0 });
  }
  anchorToGround(mb, 0, 0.6);
  return mb;
}

/** A planted bed about 2.4 m by 1.2 m: low leafy plants and drifts of flowers in three colours. */
function flowerbed(level) {
  const mb = new MeshBuilder(1024), rng = makeRng(601);
  const plants = level ? 5 : 11, blooms = [COLOR.hibiscusPink, COLOR.lantana, COLOR.white, COLOR.violet];
  for (let i = 0; i < plants; i++) {
    const r = rng.fork(i + 1), x = lerp(-1.0, 1.0, (i + 0.5) / plants) + r.range(-0.08, 0.08), z = (i % 2 ? 0.26 : -0.26) + r.range(-0.1, 0.1), s = r.range(0.8, 1.2) * (level ? 1.5 : 1);
    mound(mb, r, { radius: [0.3 * s, 0.26 * s, 0.3 * s], cards: level ? 6 : 5, card: 0.3 * s, shape: 1, cells: 5, leaf: shade(COLOR.cover, r.range(0.9, 1.15)), lump: 0.2, coarse: true,
      flowers: { count: 3, kind: i % 3 ? 1 : 0, cells: 3, color: blooms[Math.floor(i / 3) % blooms.length], size: 0.3 * s } }, level, [x, 0, z]);
  }
  anchorToGround(mb, 0, 0.2);
  return mb;
}

/**
 * A tuft: blade cards fanned around a point (or strung along a line for fence rows).
 * o: { cards, width, height: [min, max], lean: [min, max], arch, segs, spread (radius over which the roots are scattered),
 *      line (half-length along x; 0 for a round tuft), kind, blades, color, tip,
 *      stalks: { count, height: [min, max], width, blades } | null   seed-head stalks standing above the blades }
 * far: the distance at which the renderer stops drawing the tuft; the shader thins it away just before.
 */
function tuft(o, far) {
  const mb = new MeshBuilder(256), rng = makeRng(o.seed), fade = Math.min(31, Math.round(far / 5));
  const card = (i, n, c) => {
    const r = rng.fork(c.salt + i), azimuth = i * GOLDEN_ANGLE * (o.line ? 0.5 : 1) + r.range(-0.4, 0.4);
    const d = r.range(0, o.spread), a = r.range(0, TAU);
    const base = o.line ? [lerp(-o.line, o.line, (i + 0.5) / n) + r.range(-0.1, 0.1), 0, r.range(-o.spread, o.spread)] : [Math.cos(a) * d, 0, Math.sin(a) * d];
    bladeCard(mb, base, azimuth, {
      width: c.width * r.range(0.8, 1.2), height: r.range(c.height[0], c.height[1]), lean: r.range(o.lean[0], o.lean[1]), arch: o.arch * r.range(0.6, 1.3),
      segs: o.segs, kind: c.kind, fade, blades: c.blades, seed: r.int(0, 255), color: shade(o.color, r.range(0.88, 1.1)), tip: shade(o.tip, r.range(0.9, 1.1)),
    });
  };
  for (let i = 0; i < o.cards; i++) card(i, o.cards, { salt: 1, width: o.width, height: o.height, kind: o.kind, blades: o.blades });
  if (o.stalks) for (let i = 0; i < o.stalks.count; i++) card(i, o.stalks.count, { salt: 200, width: o.stalks.width, height: o.stalks.height, kind: 1, blades: o.stalks.blades });
  return mb;
}

/** Creeping ground cover: overlapping, nearly flat leaf cards hugging the ground, with a scatter of flowers. */
function creeper(o) {
  const mb = new MeshBuilder(256), rng = makeRng(o.seed);
  for (let i = 0; i < o.cards; i++) {
    const r = rng.fork(i + 1), d = o.radius * Math.sqrt((i + 0.5) / o.cards) * 0.85, a = i * GOLDEN_ANGLE, out = [Math.cos(a), 0, Math.sin(a)];
    const at = [out[0] * d, o.height * r.range(0.5, 1), out[2] * d], n = vnorm([out[0] * 0.25 + r.range(-0.15, 0.15), 1, out[2] * 0.25 + r.range(-0.15, 0.15)]);
    // Runners spread from the middle, so the leaves point outwards; the rim lies lowest.
    leafCard(mb, at, n, out, { shape: o.shape, cells: o.cells, seed: r.int(0, 255), color: shade(o.leaf, r.range(0.85, 1.12)), size: [o.card, o.card], weight: [0.15, 0.4], shadeNormal: [0, 1, 0], cup: -0.12 });
    if (i < o.flowers.count) leafCard(mb, vadd(at, [0, 0.03, 0]), [0, 1, 0], out, { material: FOLIAGE.FLOWER, shape: o.flowers.kind, cells: o.flowers.cells, seed: r.int(0, 255), color: o.flowers.color, size: [o.card * 0.9, o.card * 0.9], weight: [0.3, 0.5], shadeNormal: [0, 1, 0], cup: 0 });
  }
  anchorToGround(mb, 0, o.height);
  return mb;
}

const HIBISCUS = { seed: 401, radius: [0.95, 1.65, 0.95], cards: 34, card: 0.62, shape: 1, cells: 6, leaf: COLOR.hibiscusLeaf, flowers: { count: 12, kind: 0, cells: 3, color: [COLOR.hibiscusRed, COLOR.hibiscusRed, COLOR.hibiscusPink], size: 0.6 } };
const CROTON = { seed: 409, radius: [0.6, 1.15, 0.6], cards: 26, card: 0.5, shape: 2, cells: 4, leaf: COLOR.crotonLeaf, flowers: null };
const IXORA = { seed: 419, radius: [0.7, 0.85, 0.7], cards: 26, card: 0.42, shape: 1, cells: 7, leaf: COLOR.ixoraLeaf, flowers: { count: 14, kind: 1, cells: 3, color: COLOR.ixoraBloom, size: 0.34 } };
const SCRUB_A = { seed: 431, radius: [1.5, 1.7, 1.3], cards: 30, card: 0.95, shape: 4, cells: 4, leaf: COLOR.seaGrape, flowers: null, lump: 0.35, lobes: [{ at: [0, 0, 0], scale: 1 }, { at: [1.1, 0, 0.5], scale: 0.62 }] };
const SCRUB_B = { seed: 433, radius: [1.1, 1.05, 1.0], cards: 22, card: 0.8, shape: 4, cells: 4, leaf: mixColor(COLOR.seaGrape, COLOR.dune, 0.2), flowers: null, lump: 0.35, lobes: [{ at: [0, 0, 0], scale: 1 }, { at: [-0.9, 0, 0.4], scale: 0.7 }, { at: [0.5, 0, -0.9], scale: 0.55 }] };

const GRASS = {
  // Mown turf: short upright cards at every angle over the whole footprint, so no view lines them up.
  lawn: { seed: 701, cards: 10, width: 0.22, height: [0.06, 0.13], lean: [-0.15, 0.3], arch: 0.25, segs: 1, spread: 0.33, kind: 3, blades: 16, color: COLOR.lawn, tip: COLOR.lawnTip },
  rough: { seed: 703, cards: 7, width: 0.62, height: [0.2, 0.38], lean: [0.1, 0.55], arch: 0.6, segs: 2, spread: 0.2, kind: 0, blades: 16, color: COLOR.rough, tip: COLOR.roughTip },
  tall: { seed: 709, cards: 9, width: 0.75, height: [0.55, 0.95], lean: [0.08, 0.5], arch: 0.9, segs: 3, spread: 0.14, kind: 0, blades: 12, color: COLOR.rough, tip: COLOR.straw },
  // Sea oats: sparse arching blades and tall stalks whose heavy seed heads nod over the dune.
  oats: { seed: 719, cards: 7, width: 0.9, height: [0.7, 1.15], lean: [0.1, 0.5], arch: 1.0, segs: 3, spread: 0.22, kind: 0, blades: 8, color: COLOR.dune, tip: COLOR.duneTip, stalks: { count: 4, height: [1.3, 1.85], width: 0.6, blades: 3 } },
  dune: { seed: 727, cards: 10, width: 0.85, height: [0.45, 0.8], lean: [0.15, 0.7], arch: 0.8, segs: 3, spread: 0.3, kind: 0, blades: 10, color: COLOR.dune, tip: COLOR.straw },
  // Vacant-lot weeds: rank broad leaves with seeding stalks; a low rosette with seed heads; a ragged fence row.
  weedTall: { seed: 733, cards: 7, width: 0.68, height: [0.4, 0.8], lean: [0.1, 0.6], arch: 0.7, segs: 2, spread: 0.18, kind: 2, blades: 6, color: COLOR.weed, tip: COLOR.weedTip, stalks: { count: 3, height: [0.7, 1.1], width: 0.3, blades: 3 } },
  weedLow: { seed: 739, cards: 6, width: 0.45, height: [0.12, 0.22], lean: [0.7, 1.2], arch: 0.3, segs: 1, spread: 0.06, kind: 2, blades: 5, color: COLOR.weed, tip: COLOR.weedTip, stalks: { count: 2, height: [0.22, 0.4], width: 0.16, blades: 2 } },
  weedRow: { seed: 743, cards: 9, width: 0.75, height: [0.35, 0.9], lean: [-0.25, 0.3], arch: 0.5, segs: 2, spread: 0.08, line: 1.0, kind: 0, blades: 9, color: COLOR.weed, tip: COLOR.straw, stalks: { count: 4, height: [0.6, 1.1], width: 0.4, blades: 3 } },
};
const COVER_A = { seed: 751, cards: 14, radius: 0.9, height: 0.16, card: 0.55, shape: 1, cells: 10, leaf: COLOR.cover, flowers: { count: 5, kind: 1, cells: 4, color: COLOR.lantana } };
const COVER_B = { seed: 757, cards: 12, radius: 1.2, height: 0.07, card: 0.7, shape: 0, cells: 6, leaf: COLOR.vine, flowers: { count: 3, kind: 0, cells: 5, color: COLOR.vineBloom } };

/** name, builder (level, cut-off distance at the chosen detail), tags, hand-over distances at full detail (the last is the cut-off), collider and spacing radius. */
export const PLANTS = [
  { name: 'shrub_a', build: (level) => shrub(HIBISCUS, level), tags: ['shrub', 'hibiscus', 'flowering', 'garden'], lod: [35, 160], collider: null, footprint: 0.95 },
  { name: 'shrub_b', build: (level) => shrub(CROTON, level), tags: ['shrub', 'croton', 'colourful', 'garden'], lod: [30, 130], collider: null, footprint: 0.6 },
  { name: 'shrub_c', build: (level) => shrub(IXORA, level), tags: ['shrub', 'ixora', 'flowering', 'low', 'garden'], lod: [30, 120], collider: null, footprint: 0.7 },
  { name: 'hedge_seg', build: hedge, tags: ['hedge', 'segment', 'clipped', 'garden'], lod: [45, 220], collider: { kind: 'box', hx: 1.0, hy: 0.55, hz: 0.4 }, footprint: 1.0 },
  { name: 'flowerbed_a', build: flowerbed, tags: ['flowerbed', 'flowering', 'garden'], lod: [30, 110], collider: null, footprint: 1.3 },
  { name: 'scrub_seagrape_a', build: (level) => shrub(SCRUB_A, level), tags: ['scrub', 'seagrape', 'beach', 'dune'], lod: [40, 200], collider: null, footprint: 2.0 },
  { name: 'scrub_seagrape_b', build: (level) => shrub(SCRUB_B, level), tags: ['scrub', 'seagrape', 'beach', 'dune', 'low'], lod: [35, 160], collider: null, footprint: 1.7 },
  { name: 'grass_tuft_a', build: (level, far) => tuft(GRASS.lawn, far), tags: ['grass', 'ground', 'lawn'], lod: [45], collider: null, footprint: 0.35 },
  { name: 'grass_tuft_b', build: (level, far) => tuft(GRASS.rough, far), tags: ['grass', 'ground', 'rough', 'verge'], lod: [60], collider: null, footprint: 0.35 },
  { name: 'grass_tuft_c', build: (level, far) => tuft(GRASS.tall, far), tags: ['grass', 'ground', 'tall', 'vacant'], lod: [80], collider: null, footprint: 0.45 },
  { name: 'grass_dune_a', build: (level, far) => tuft(GRASS.oats, far), tags: ['grass', 'ground', 'dune', 'seaoats', 'beach'], lod: [120], collider: null, footprint: 0.5 },
  { name: 'grass_dune_b', build: (level, far) => tuft(GRASS.dune, far), tags: ['grass', 'ground', 'dune', 'beach'], lod: [90], collider: null, footprint: 0.5 },
  { name: 'weed_a', build: (level, far) => tuft(GRASS.weedTall, far), tags: ['weed', 'ground', 'vacant', 'tall'], lod: [70], collider: null, footprint: 0.4 },
  { name: 'weed_b', build: (level, far) => tuft(GRASS.weedLow, far), tags: ['weed', 'ground', 'vacant', 'kerb', 'low'], lod: [40], collider: null, footprint: 0.2 },
  { name: 'weed_c', build: (level, far) => tuft(GRASS.weedRow, far), tags: ['weed', 'ground', 'fence', 'segment'], lod: [70], collider: null, footprint: 1.0 },
  { name: 'groundcover_a', build: () => creeper(COVER_A), tags: ['groundcover', 'ground', 'garden', 'flowering'], lod: [60], collider: null, footprint: 0.9 },
  { name: 'groundcover_b', build: () => creeper(COVER_B), tags: ['groundcover', 'ground', 'beach', 'dune', 'vine'], lod: [60], collider: null, footprint: 1.2 },
];
