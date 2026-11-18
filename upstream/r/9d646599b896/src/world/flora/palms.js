// Palm recipes: coconut, royal, Washingtonia fan, Canary date and two small garden palms.
//
// Each recipe builds the same plant at three levels of detail from one seed. Every frond owns a forked
// random stream, so a level that draws fewer cards (or fewer fronds) still places them exactly where the
// full-detail level does and the levels cross over without the crown changing shape.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, FOLIAGE } from '../../core/ids.js';
import { DEG, TAU, clamp, lerp, smoothstep, makeRng } from '../../core/math.js';
import { vadd, vscale, vmad, vnorm, dirFromAngles, GOLDEN_ANGLE, hex, mixColor, shade, table, ovoid, DOWN } from './rig.js';
import { SPECIES, trunkPath, pathAt, buildTrunk, ringFractions, trunkOcclusion, leafBase } from './trunk.js';
import { FROND_KIND, FROND_SOLID, frondSeed, buildFeatherFrond, buildFanLeaf, buildSpear } from './frond.js';

const COLOR = {
  frond: hex('#4C6B2A'), young: hex('#7D9A3A'), ageing: hex('#A8973F'), dead: hex('#9A7D58'), rachis: hex('#8F9A45'),
  royalFrond: hex('#3F5F28'), dateFrond: hex('#475C2B'), fanFrond: hex('#4E6B2C'), caneFrond: hex('#6A8A34'),
  coconutBark: hex('#8A8176'), coconutFibre: hex('#6F6253'), royalBark: hex('#C2BFB6'), crownshaft: hex('#4F7A32'),
  fanBark: hex('#8C7F6E'), thatch: hex('#9A7D58'), dateBark: hex('#8E7459'), dateStub: hex('#7A5F45'),
  cane: hex('#9AA05A'), nutGreen: hex('#6E8B3A'), nutGold: hex('#C9A23A'), nutBrown: hex('#7A5A3A'),
  bloom: hex('#D8CFA0'), dates: hex('#D98A2B'),
};

// Cards per frond at the three levels. Near: every card carries about five leaflets. Far: flat ribbons filled
// to their edges, so that the triangles go into keeping the crown as full as it is near by rather than into
// bends nobody can see. midTip < 1 does the same, in part, for a crown that sheds a rank of leaflets at the mid level.
const cuts = (cards, segs, { rachisSegs = 8, farCards = 2, midTip = 1 } = {}) => [
  { rachisSegs, cards, segs, jitter: true, rachis: 'tube', tip: 1 },
  { rachisSegs: 6, cards: Math.max(4, Math.round(cards / 3)), segs: 2, jitter: false, rachis: 'strip', tip: midTip },
  { rachisSegs: 4, cards: farCards, segs: 1, jitter: false, rachis: 'none', tip: 0.5 },
];
const FAN_CUTS = [{ wedges: 16, rings: 4, stalk: 'tube', tip: 1 }, { wedges: 6, rings: 3, stalk: 'strip', tip: 1 }, { wedges: 2, rings: 1, stalk: 'none', tip: 0.8 }];

/** Horizontal unit vector at an azimuth. */
const outward = (azimuth) => [Math.cos(azimuth), 0, Math.sin(azimuth)];

/** Leaf colour by age: fresh yellow-green at the spear, deep green in its prime, yellowing before it dies. */
function leafColor(base, age, r) {
  if (age < 0.14) return mixColor(COLOR.young, base, age / 0.14);
  if (age > 0.8) return mixColor(base, COLOR.ageing, ((age - 0.8) / 0.2) * r.range(0.2, 0.9));
  return shade(base, r.range(0.94, 1.06));
}

/**
 * A crown of feather fronds on `hub` ({ p, t }): fronds are ordered young to old, turning by the golden
 * angle; the youngest stand nearly upright in the middle and the oldest hang below the horizontal.
 */
function featherCrown(mb, rng, hub, c, level) {
  const n = c.fronds, keep = level === 2 ? Math.max(1, Math.round(n / c.farFronds)) : 1;
  for (let k = 0; k < n; k++) {
    const r = rng.fork(k + 1);
    // A far crown keeps every keep-th frond counted from the oldest: the lowest, widest ones draw the outline.
    if ((n - 1 - k) % keep) continue;
    const age = k / (n - 1), azimuth = c.turn + k * GOLDEN_ANGLE + r.range(-0.22, 0.22);
    const elevation = c.elevation(age) + r.range(-1, 1) * c.scatter;
    // Never let a frond curl back under itself: the tip stops just short of hanging straight down.
    const droop = Math.min(c.droop(elevation, age) * r.range(0.85, 1.15), elevation + 85 * DEG);
    buildFeatherFrond(mb, {
      base: vmad(vmad(hub.p, hub.t, -c.spread * age), outward(azimuth), c.hubRadius),
      azimuth, elevation, droop, droopPow: c.droopPow,
      length: c.length * lerp(0.7, 1, smoothstep(0, 0.22, age)) * r.range(0.93, 1.05) * (level === 2 ? 1.06 : 1),
      sweep: r.range(-0.22, 0.22), twist: c.twist * r.sign() * r.range(0.4, 1), petiole: c.petiole,
      rachisRadius: c.rachisRadius, kind: c.kind, phase: r.int(0, 15), stiffness: lerp(0.4, 1, age),
      colors: { leaf: leafColor(c.leaf, age, r), rachis: c.rachis || COLOR.rachis }, leaflet: c.leaflet,
      // Far away (and at the mid level of many-fronded crowns) a second rank of leaflets is only overdraw.
      rows: level === 2 || (level === 1 && c.leanMid) ? c.rows(age).slice(-1) : c.rows(age), rng: r,
    }, c.cuts[level]);
  }
}

/** Dead fronds: brown, shrivelled, hanging against the trunk until they fall. */
function deadFronds(mb, rng, hub, c, count, level) {
  for (let k = 0; k < count; k++) {
    const r = rng.fork(900 + k), azimuth = r.range(0, TAU);
    if (level === 2) continue;
    buildFeatherFrond(mb, {
      base: vmad(vmad(hub.p, hub.t, -c.spread - 0.15), outward(azimuth), c.hubRadius), azimuth,
      elevation: r.range(-62, -48) * DEG, droop: r.range(18, 30) * DEG, droopPow: 1.2, length: c.length * r.range(0.7, 0.85),
      sweep: r.range(-0.3, 0.3), twist: r.range(-1, 1), petiole: c.petiole, rachisRadius: c.rachisRadius, kind: c.kind,
      phase: r.int(0, 15), stiffness: 1, colors: { leaf: shade(COLOR.dead, r.range(0.85, 1.05)), rachis: COLOR.dead },
      leaflet: c.leaflet, rows: [{ roof: 0.5, hang: 1, length: 0.6 }], rng: r,
    }, c.cuts[level]);
  }
}

/** Fruit hanging under a crown: closed ovoids near the camera, a few facets further away, nothing at the far level. */
function fruit(mb, rng, hub, level, { count, ring, drop, size, colors }) {
  if (level === 2) return;
  mb.family(FAMILY.FOLIAGE).material(FOLIAGE.FROND, FROND_KIND.COCONUT, FROND_SOLID, frondSeed(0, 3)).occlusion(0);
  const bunches = Math.max(1, Math.round(count / 4));
  for (let i = 0; i < count; i++) {
    const r = rng.fork(700 + i), bunch = i % bunches, azimuth = bunch * TAU / bunches + r.range(-0.35, 0.35);
    const centre = vadd(vmad(vmad(hub.p, hub.t, -drop - r.range(0, 0.22)), outward(azimuth), ring * r.range(0.8, 1.2)), [0, -size * 0.6, 0]);
    mb.color(shade(colors[bunch % colors.length], r.range(0.85, 1.1)));
    ovoid(mb, centre, vnorm(vadd(DOWN, vscale(outward(azimuth), 0.35))), size * 2.3, size, level ? 4 : 7, level ? 2 : 4,
      (t) => Math.pow(Math.sin(Math.PI * t), 0.7));
  }
}

/** A hanging spray of fine strands (flower broom or fruit stalks), cut out of a drooping card by the shader. */
function spray(mb, rng, base, azimuth, { length, width, strands, color, elevation }) {
  const out = outward(azimuth), side = [-out[2], 0, out[0]], segs = 3, first = mb.count;
  mb.family(FAMILY.FOLIAGE).material(FOLIAGE.FROND, FROND_KIND.STRAND, strands, frondSeed(rng.int(0, 15), rng.int(0, 15)));
  let p = base.slice();
  for (let k = 0; k <= segs; k++) {
    const f = k / segs, d = dirFromAngles(azimuth, elevation - (elevation + 80 * DEG) * Math.pow(f, 0.8));
    if (k) p = vmad(p, d, length / segs);
    const w = width * (0.25 + 0.75 * f), n = vnorm(vadd(vscale(out, Math.sin(elevation) + 0.3), [0, 1, 0]));
    mb.color(shade(color, lerp(0.8, 1.05, f))).occlusion(0.5 * f);
    for (const s of [-1, 1]) { const q = vmad(p, side, s * w * 0.5); mb.vertex(q[0], q[1], q[2], n[0], n[1], n[2], s > 0 ? 1 : 0, f); }
  }
  for (let k = 0; k < segs; k++) { const q = first + k * 2; mb.quad(q, q + 2, q + 3, q + 1); }
}

// ---------------------------------------------------------------- coconut
function coconut(v, level) {
  const mb = new MeshBuilder(8192), rng = makeRng(v.seed);
  const path = trunkPath({ height: v.trunk, lean: v.lean * DEG, leanTop: v.lean * DEG * 0.22, azimuth: 0, wander: 0.35, phase: v.seed }, 24);
  const length = path[path.length - 1].s, r0 = 0.145, fibre = length - 0.9;
  // Swollen, root-matted foot; then a slim column that thins a little towards the crown.
  const profile = [[0, 1.95], [0.25, 1.62], [0.6, 1.22], [1.1, 1.05], [1.8, 1.0], [length, 0.84]];
  const occlusion = trunkOcclusion(length);
  buildTrunk(mb, path, ringFractions([24, 9, 4][level], 1.8 / length, [6, 3, 1][level]), {
    sides: [12, 8, 5][level], species: SPECIES.COCONUT, seed: v.seed, zoneStart: fibre,
    radius: (s) => r0 * table(profile, s), occlusion,
    color: (s) => (s > fibre ? COLOR.coconutFibre : mixColor(COLOR.coconutFibre, COLOR.coconutBark, smoothstep(0, 0.7, s))),
  });
  const hub = pathAt(path, 1);
  const crown = {
    fronds: v.fronds, farFronds: v.fronds, turn: rng.range(0, TAU), cuts: cuts(18, 4), kind: FROND_KIND.COCONUT,
    length: v.frond, petiole: 0.14, rachisRadius: [0.045, 0.008], hubRadius: 0.1, spread: 0.55, twist: 1.2, scatter: 7 * DEG,
    leaf: COLOR.frond, droopPow: 1.7,
    elevation: (age) => (86 - 122 * Math.pow(age, 0.85)) * DEG,
    droop: (e) => clamp(35 + 45 * (1 - e / (90 * DEG)), 25, 95) * DEG,
    leaflet: { length: 1.05, pitch: 0.052, planBase: 1.25, planTip: 0.6, profile: [[0, 0.5], [0.15, 0.9], [0.4, 1], [0.75, 0.82], [1, 0.38]] },
    // Young fronds hold their leaflets in a shallow V; on older ones they hang like a curtain.
    rows: (age) => [{ roof: lerp(-0.3, 0.45, age), hang: lerp(0.3, 0.92, age), length: 1 }],
  };
  featherCrown(mb, rng, hub, crown, level);
  deadFronds(mb, rng, hub, crown, v.dead, level);
  if (level < 2) buildSpear(mb, { base: hub.p, azimuth: rng.range(0, TAU), elevation: 84 * DEG, length: v.frond * 0.55, droop: 0.12, droopPow: 2, kind: FROND_KIND.COCONUT, phase: 3, radius: 0.05, color: COLOR.young, stiffness: 0.3 }, level ? 3 : 6);
  fruit(mb, rng, hub, level, { count: v.nuts, ring: 0.32, drop: 0.62, size: 0.115, colors: [COLOR.nutGreen, COLOR.nutGold, COLOR.nutBrown] });
  return { mb, trunkRadius: r0 * 1.6, clear: v.trunk - 1.5 };
}

// ---------------------------------------------------------------- royal
function royal(v, level) {
  const mb = new MeshBuilder(8192), rng = makeRng(v.seed), shaft = 1.75;
  const path = trunkPath({ height: v.trunk + shaft, lean: v.lean * DEG, leanTop: 0, azimuth: 0 }, 16);
  const length = path[path.length - 1].s, zone = length - shaft;
  // A concrete-grey column, widest at the foot and again with a gentle belly two thirds of the way up.
  const column = [[0, 0.37], [0.04, 0.31], [0.2, 0.255], [0.45, 0.24], [0.62, 0.255], [0.78, 0.27], [0.92, 0.245], [1, 0.215]];
  // The crownshaft: a smooth green sheath of leaf bases, swollen at the bottom, slender where the fronds leave it.
  const sheath = [[0, 0.225], [0.12, 0.25], [0.35, 0.235], [0.7, 0.17], [1, 0.11]];
  const fractions = [...ringFractions([18, 8, 4][level], 0.06 * zone / length, [4, 2, 1][level]).map((f) => f * (zone - 0.01) / length),
    ...ringFractions([7, 3, 1][level]).map((f) => (zone + 0.01 + f * (shaft - 0.01)) / length)];
  buildTrunk(mb, path, fractions, {
    sides: [14, 8, 5][level], species: SPECIES.ROYAL, seed: v.seed, zoneStart: zone,
    radius: (s) => (s < zone ? table(column, s / zone) : table(sheath, (s - zone) / shaft)) * v.girth,
    occlusion: (s) => lerp(0.62, 1, smoothstep(0, 0.35, s)) * (s > zone ? lerp(0.9, 0.6, (s - zone) / shaft) : 1),
    color: (s) => (s < zone ? COLOR.royalBark : mixColor(COLOR.crownshaft, COLOR.young, 0.35 * (s - zone) / shaft)),
  });
  const hub = pathAt(path, 1);
  featherCrown(mb, rng, hub, {
    fronds: v.fronds, farFronds: v.fronds, turn: rng.range(0, TAU), cuts: cuts(14, 3, { farCards: 3 }), kind: FROND_KIND.ROYAL,
    length: v.frond, petiole: 0.1, rachisRadius: [0.05, 0.008], hubRadius: 0.06, spread: 0.3, twist: 0.5, scatter: 6 * DEG,
    leaf: COLOR.royalFrond, droopPow: 2.1,
    elevation: (age) => (82 - 104 * Math.pow(age, 0.9)) * DEG,
    droop: (e) => clamp(55 + 40 * (1 - e / (90 * DEG)), 50, 100) * DEG,
    leaflet: { length: 0.8, pitch: 0.032, planBase: 1.2, planTip: 0.55, profile: [[0, 0.55], [0.2, 1], [0.6, 0.95], [1, 0.4]] },
    // Leaflets leave the rachis in several planes, which is what makes a royal's frond a plume and not a comb.
    rows: (age) => [{ roof: -0.75, hang: lerp(0.25, 0.5, age), length: 0.9 }, { roof: 0.35, hang: lerp(0.45, 0.8, age), length: 1 }],
  }, level);
  if (level < 2) {
    buildSpear(mb, { base: hub.p, azimuth: rng.range(0, TAU), elevation: 86 * DEG, length: v.frond * 0.6, droop: 0.06, droopPow: 2, kind: FROND_KIND.ROYAL, phase: 5, radius: 0.045, color: COLOR.young, stiffness: 0.25 }, level ? 3 : 6);
    // Flower brooms break out from under the crownshaft.
    const at = pathAt(path, (zone - 0.05) / length), turn = rng.range(0, TAU);
    for (let i = 0; i < 3; i++) spray(mb, rng.fork(40 + i), vmad(at.p, outward(turn + i * 2.3), 0.2 * v.girth), turn + i * 2.3, { length: 1.0, width: 0.75, strands: 16, color: COLOR.bloom, elevation: 25 * DEG });
  }
  return { mb, trunkRadius: 0.33 * v.girth, clear: v.trunk };
}

// ---------------------------------------------------------------- Washingtonia (fan)
function fan(v, level) {
  const mb = new MeshBuilder(8192), rng = makeRng(v.seed);
  const path = trunkPath({ height: v.trunk, lean: v.lean * DEG, leanTop: v.lean * DEG * 0.4, azimuth: 0, wander: 0.3, phase: v.seed }, 20);
  const length = path[path.length - 1].s, zone = length - v.skirt;
  // Flared foot, then a pole; under the crown the old leaf bases and thatch swell it again.
  const pole = (s) => 0.17 * table([[0, 2.5], [0.3, 1.9], [0.9, 1.3], [2, 1.05], [length, 0.92]], s);
  buildTrunk(mb, path, [...ringFractions([18, 8, 4][level], 2 / length, [5, 2, 1][level]).map((f) => f * (zone - 0.01) / length),
    ...ringFractions([6, 3, 2][level]).map((f) => (zone + 0.01 + f * (v.skirt - 0.01)) / length)], {
    sides: [10, 7, 5][level], species: SPECIES.FAN, seed: v.seed, zoneStart: zone,
    radius: (s) => (s < zone ? pole(s) : pole(zone) * table([[0, 1.3], [0.5, 1.9], [0.8, 1.7], [1, 0.5]], (s - zone) / v.skirt)),
    occlusion: (s) => lerp(0.62, 1, smoothstep(0, 0.35, s)) * (s > zone ? 0.7 : 1),
    color: (s) => (s < zone ? COLOR.fanBark : COLOR.thatch),
  });
  const hub = pathAt(path, 1), cut = FAN_CUTS[level], turn = rng.range(0, TAU);
  const leaf = (r, base, azimuth, elevation, age, dead) => buildFanLeaf(mb, {
    base, azimuth, elevation, stalk: v.stalk * r.range(0.85, 1.1), stalkDroop: dead ? 0.15 : lerp(0.04, 0.6, age), stalkRadius: 0.022,
    radius: v.blade * r.range(0.9, 1.08) * (dead ? 0.85 : 1), span: dead ? 1.0 : 1.7, fold: dead ? 0.7 : 0.5,
    curl: dead ? 0.5 : lerp(0.1, 0.3, age), tipDroop: dead ? 0.3 : lerp(0.12, 0.42, age), pleat: level ? 0 : 0.03, segments: 46,
    kind: FROND_KIND.FAN, phase: r.int(0, 15), stiffness: dead ? 0.8 : lerp(0.45, 1, age),
    colors: { leaf: dead ? shade(COLOR.thatch, r.range(0.8, 1.1)) : leafColor(COLOR.fanFrond, age, r), rachis: dead ? COLOR.thatch : COLOR.rachis }, rng: r,
  }, cut);
  const n = v.leaves;
  for (let k = 0; k < n; k++) {
    const r = rng.fork(k + 1), age = k / (n - 1), azimuth = turn + k * GOLDEN_ANGLE + r.range(-0.2, 0.2);
    // Most of the living leaves stand erect, their folded blades facing outwards; only the oldest hang towards the skirt.
    leaf(r, vmad(vmad(hub.p, hub.t, -0.9 * age), outward(azimuth), 0.14), azimuth, (88 - 150 * Math.pow(age, 1.3)) * DEG + r.range(-6, 6) * DEG, age, false);
  }
  // The skirt: dead leaves folded down over one another along the thatch.
  const dead = Math.round(v.skirt * 7), keepDead = level === 2 ? 2 : 1;
  for (let k = 0; k < dead; k++) {
    const r = rng.fork(500 + k), azimuth = turn + k * GOLDEN_ANGLE, down = 0.5 + (k / dead) * (v.skirt - 0.7);
    if (k % keepDead) continue;
    const at = pathAt(path, (length - down) / length);
    leaf(r, vmad(at.p, outward(azimuth), 0.2), azimuth, r.range(-72, -55) * DEG, 1, true);
  }
  return { mb, trunkRadius: 0.3, clear: zone };
}

// ---------------------------------------------------------------- date (Canary Island type)
function date(v, level) {
  const mb = new MeshBuilder(16384), rng = makeRng(v.seed);
  const path = trunkPath({ height: v.trunk, lean: 0, leanTop: 0, azimuth: 0 }, 8);
  const length = v.trunk, zone = length - v.pineapple, r0 = v.radius, rows = Math.round(length / 0.115);
  const sides = [20, 10, 5][level];
  buildTrunk(mb, path, ringFractions([rows, 8, 3][level]), {
    sides, species: SPECIES.DATE, seed: v.seed, zoneStart: zone,
    // Foot flare, a column, and the swollen "pineapple" of cut leaf bases under the crown.
    radius: (s) => r0 * (table([[0, 1.3], [0.35, 1.08], [0.9, 1], [zone, 1], [zone + 0.45 * v.pineapple, 1.36], [length, 1.05]], s)),
    occlusion: trunkOcclusion(length, 1.2),
    color: (s) => (s > zone ? COLOR.dateStub : COLOR.dateBark),
    // The diamond scars of old leaf bases are deep enough to break the outline, so they are modelled.
    relief: level ? null : (s, u) => 1 + ((Math.round(s * rows / length) + Math.round(u * sides)) % 2 ? 0.055 : -0.03),
  });
  if (level < 2) {
    mb.family(FAMILY.SOLID);
    const stubs = level ? 16 : 44;
    for (let i = 0; i < stubs; i++) {
      const f = i / stubs, s = zone + 0.1 + f * (v.pineapple - 0.15), at = pathAt(path, s / length), azimuth = i * GOLDEN_ANGLE;
      const r = r0 * table([[zone, 1], [zone + 0.45 * v.pineapple, 1.36], [length, 1.05]], s);
      leafBase(mb, at, azimuth, r, { length: 0.2 * v.scale, width: 0.085 * v.scale, thick: 0.035 * v.scale }, 50 * DEG, COLOR.dateStub, lerp(0.85, 0.6, f), (azimuth / TAU) % 1, s, level ? 3 : 4);
    }
  }
  const hub = pathAt(path, 1);
  featherCrown(mb, rng, hub, {
    // Far: every 2nd frond of the large palm. Every 4th would step 4 x 137.5 = 190 degrees and flatten the crown into a fan.
    fronds: v.fronds, farFronds: 32, turn: rng.range(0, TAU), cuts: cuts(v.cards, 2, { rachisSegs: 6, midTip: 0.7 }), kind: FROND_KIND.DATE,
    length: v.frond, petiole: 0.1, rachisRadius: [0.04 * v.scale, 0.006], hubRadius: r0 * 0.5, spread: 0.6 * v.scale, twist: 0.5, scatter: 5 * DEG,
    leaf: COLOR.dateFrond, rachis: hex('#6E8440'), droopPow: 1.8, leanMid: true,
    // Evenly spread over a ball: many fronds near the horizontal, few straight up.
    elevation: (age) => Math.asin(lerp(0.995, v.low, Math.pow(age, 0.8))),
    droop: (e) => (v.droop[0] + v.droop[1] * (1 - e / (90 * DEG))) * DEG,
    leaflet: { length: v.leaflet, pitch: v.pitch, planBase: 1.0, planTip: 0.5, profile: [[0, 0.4], [0.18, 1], [0.7, 0.88], [1, 0.3]] },
    // Stiff leaflets in an upward V, with a second rank held flatter: the frond has depth from every side.
    rows: (age) => [{ roof: -0.85, hang: lerp(0.06, 0.25, age) * v.lax, length: 0.92 }, { roof: -0.15, hang: lerp(0.1, 0.35, age) * v.lax, length: 1 }],
  }, level);
  if (level < 2 && v.dates) {
    const turn = rng.range(0, TAU);
    for (let i = 0; i < v.dates; i++) spray(mb, rng.fork(60 + i), vmad(vmad(hub.p, hub.t, -0.45), outward(turn + i * 1.9), r0), turn + i * 1.9, { length: 1.5, width: 0.7, strands: 14, color: COLOR.dates, elevation: 35 * DEG });
  }
  return { mb, trunkRadius: r0 * 1.15, clear: zone };
}

// ---------------------------------------------------------------- clustering cane palm
function cane(v, level) {
  const mb = new MeshBuilder(8192), rng = makeRng(v.seed);
  for (let i = 0; i < v.canes; i++) {
    const r = rng.fork(100 + i), azimuth = i * GOLDEN_ANGLE + r.range(-0.3, 0.3), height = lerp(v.tall, v.short, i / (v.canes - 1)) * r.range(0.9, 1.1);
    const foot = vscale(outward(azimuth), i ? r.range(0.12, 0.3) : 0);
    const path = trunkPath({ height, lean: (i ? r.range(8, 20) : 3) * DEG, leanTop: 4 * DEG, azimuth }, 6).map((q) => ({ ...q, p: vadd(q.p, foot) }));
    const length = path[path.length - 1].s, zone = length - 0.45;
    buildTrunk(mb, path, ringFractions([7, 3, 2][level]), {
      sides: [7, 5, 3][level], species: SPECIES.ROYAL, seed: v.seed + i, zoneStart: zone,
      radius: (s) => 0.038 * table([[0, 1.5], [0.2, 1], [zone, 0.95], [zone + 0.15, 1.2], [length, 0.6]], s),
      occlusion: (s) => lerp(0.55, 1, smoothstep(0, 0.5, s)), color: (s) => (s > zone ? COLOR.young : COLOR.cane),
    });
    featherCrown(mb, r, pathAt(path, 1), {
      fronds: v.fronds, farFronds: 3, turn: r.range(0, TAU), cuts: cuts(8, 3, { rachisSegs: 6 }), kind: FROND_KIND.ROYAL,
      length: v.frond, petiole: 0.2, rachisRadius: [0.014, 0.004], hubRadius: 0.02, spread: 0.15, twist: 0.4, scatter: 8 * DEG,
      leaf: COLOR.caneFrond, droopPow: 1.6,
      elevation: (age) => (78 - 60 * age) * DEG, droop: (e) => clamp(70 - 30 * (e / (90 * DEG)), 40, 80) * DEG,
      leaflet: { length: 0.42, pitch: 0.034, planBase: 1.05, planTip: 0.5, profile: [[0, 0.5], [0.25, 1], [0.7, 0.9], [1, 0.35]] },
      rows: (age) => [{ roof: -0.6, hang: lerp(0.2, 0.4, age), length: 1 }],
    }, level);
  }
  return { mb, trunkRadius: 0.35, clear: 0.6 };
}

// ---------------------------------------------------------------- catalogue
const DATE_CANARY = { trunk: 4.9, pineapple: 1.3, radius: 0.37, scale: 1, fronds: 64, cards: 8, frond: 4.2, droop: [22, 34], leaflet: 0.62, pitch: 0.026, lax: 1, low: -0.78, dates: 4 };
const DATE_PYGMY = { trunk: 1.55, pineapple: 0.45, radius: 0.075, scale: 0.4, fronds: 32, cards: 7, frond: 1.45, droop: [40, 30], leaflet: 0.3, pitch: 0.016, lax: 2.2, low: -0.3, dates: 0 };

/** name, generator, variant parameters, tags and the distances at which the levels hand over. */
export const PALMS = [
  { name: 'palm_coconut_a', make: coconut, v: { seed: 11, trunk: 7.4, lean: 12, fronds: 26, frond: 5.0, dead: 1, nuts: 9 }, tags: ['palm', 'tall', 'coconut', 'beach'] },
  { name: 'palm_coconut_b', make: coconut, v: { seed: 23, trunk: 9.6, lean: 22, fronds: 29, frond: 5.3, dead: 2, nuts: 12 }, tags: ['palm', 'tall', 'coconut', 'beach', 'leaning'] },
  { name: 'palm_coconut_c', make: coconut, v: { seed: 37, trunk: 6.0, lean: 5, fronds: 23, frond: 4.6, dead: 1, nuts: 6 }, tags: ['palm', 'tall', 'coconut', 'beach'] },
  { name: 'palm_royal_a', make: royal, v: { seed: 41, trunk: 11.6, lean: 0.6, girth: 1, fronds: 15, frond: 4.0 }, tags: ['palm', 'tall', 'royal', 'avenue'] },
  { name: 'palm_royal_b', make: royal, v: { seed: 53, trunk: 14.4, lean: 1.2, girth: 1.08, fronds: 17, frond: 4.3 }, tags: ['palm', 'tall', 'royal', 'avenue'] },
  { name: 'palm_fan_a', make: fan, v: { seed: 61, trunk: 15.6, lean: 2, skirt: 1.6, leaves: 34, stalk: 1.05, blade: 1.15 }, tags: ['palm', 'tall', 'fan', 'avenue'] },
  { name: 'palm_fan_b', make: fan, v: { seed: 73, trunk: 19.2, lean: 4, skirt: 3.6, leaves: 38, stalk: 1.1, blade: 1.2 }, tags: ['palm', 'tall', 'fan', 'avenue', 'skirt'] },
  { name: 'palm_date_a', make: date, v: { seed: 83, ...DATE_CANARY }, tags: ['palm', 'date', 'stout', 'plaza'] },
  { name: 'palm_small_a', make: date, v: { seed: 97, ...DATE_PYGMY }, tags: ['palm', 'small', 'garden'], small: true },
  { name: 'palm_small_b', make: cane, v: { seed: 101, canes: 6, tall: 1.9, short: 0.9, fronds: 6, frond: 1.7 }, tags: ['palm', 'small', 'garden', 'clump'], small: true },
];
