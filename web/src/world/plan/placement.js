// Where repeated objects go. Two kinds of rule, both general and deterministic:
//  - strips: things spaced along a road edge on a fixed station grid (lamps, pavement palms, meters, bins,
//    parked cars), so that a lamp is where it is no matter which tile asks;
//  - scatter: things on a global jittered lattice whose class is decided by what plan.field says is there
//    (dune grass on the back of the beach, umbrellas on dry sand, trees in parks, weeds in yards).
// Every candidate is checked against the field, so nothing stands on a carriageway, in a building lot or in water.
// Conventions for props (agreed with the props modeller): local +Z faces the carriageway for kerbside items,
// lamp arms reach along +Z, signs face +Z towards the oncoming driver, signal masts reach along +X.

import { TYPE, COVER, Sample, PARK_KINDS, LAND_Y } from './field.js';
import { edgePoint } from './network.js';
import { LANE, headingByte, lotBays } from '../roads/lanes.js';
import { hashInts, hash01, noise2 } from '../../core/math.js';

const COMMERCIAL = new Set(['artdeco_beach', 'beach_resort', 'downtown', 'latin_quarter', 'hotel_strip']);
const POLE_STREETS = new Set(['residential_poor', 'latin_quarter', 'industrial_port']);
const POLE_ALLEYS = new Set(['residential_poor', 'latin_quarter', 'industrial_port', 'artdeco_beach', 'beach_resort', 'hotel_strip']);
// Poles stand on their road's station grid, clear of the lamp columns' grid (64 m with phases 16 and 48).
const POLE_SPACING = 40, POLE_PHASE = 28;
/** Palms and trees along streets by district style: chance per 8 m station and the species mix. */
const STREET_TREES = {
  artdeco_beach: [0.85, ['palm_coconut_a', 'palm_coconut_b', 'palm_coconut_c', 'palm_coconut_a', 'palm_royal_a']],
  beach_resort: [0.6, ['palm_coconut_a', 'palm_coconut_c', 'palm_royal_a', 'palm_royal_b']],
  hotel_strip: [0.5, ['palm_royal_a', 'palm_royal_b', 'palm_coconut_b']],
  downtown: [0.4, ['palm_royal_a', 'palm_royal_b', 'palm_date_a']],
  latin_quarter: [0.22, ['palm_small_a', 'tree_broadleaf_a', 'palm_coconut_c', 'palm_date_a']],
  residential_poor: [0.12, ['palm_fan_a', 'palm_coconut_c', 'tree_broadleaf_a']],
  mansion_island: [0.8, ['palm_royal_a', 'palm_royal_b']],
  studio_island: [0.5, ['palm_fan_a', 'palm_fan_b', 'palm_royal_a']],
  golf: [0.3, ['palm_fan_a', 'palm_coconut_a', 'tree_broadleaf_b']],
  airport: [0.15, ['palm_fan_a', 'palm_fan_b']],
  military: [0.05, ['palm_fan_a']],
  industrial_port: [0.04, ['palm_fan_a']],
};
/** Share of kerbside bays with a car in them. */
const PARKED_SHARE = { artdeco_beach: 0.55, downtown: 0.5, latin_quarter: 0.45, beach_resort: 0.45, residential_poor: 0.35, hotel_strip: 0.3, industrial_port: 0.2 };
/** Vehicle type indices that park (order of buildTrafficModels: compact, sedan, coupe, wagon, pickup, van, taxi, police, sports, bus, truck). */
const PARKED_TYPES = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 8];
const PARKED_COLOURS = 16;
/** Scatter mixes: [chance per lattice point, [name, weight]...]. */
const MIX = {
  dune: [0.42, ['grass_dune_a', 5], ['grass_dune_b', 4], ['scrub_seagrape_a', 1.2], ['scrub_seagrape_b', 1.2], ['palm_coconut_a', 0.8], ['palm_coconut_b', 0.6], ['groundcover_b', 1.5]],
  park: [0.3, ['tree_broadleaf_a', 2], ['tree_broadleaf_b', 1.2], ['palm_royal_a', 1.2], ['palm_coconut_a', 1.5], ['palm_coconut_c', 1], ['shrub_a', 2], ['shrub_b', 1.5], ['shrub_c', 1.5], ['flowerbed_a', 1], ['bench_a', 0.5], ['grass_tuft_a', 2]],
  golfRough: [0.14, ['palm_fan_a', 1.5], ['palm_coconut_a', 2], ['palm_coconut_b', 1.5], ['tree_broadleaf_b', 1], ['shrub_a', 1], ['grass_tuft_c', 3]],
  lawn: [0.16, ['palm_coconut_a', 1.5], ['palm_royal_a', 1], ['palm_small_a', 1.5], ['palm_small_b', 1], ['shrub_a', 2], ['shrub_b', 2], ['shrub_c', 1.5], ['flowerbed_a', 0.8], ['grass_tuft_a', 2], ['groundcover_a', 1]],
  rough: [0.3, ['grass_tuft_b', 5], ['grass_tuft_c', 4], ['weed_a', 2], ['shrub_c', 0.7], ['scrub_seagrape_b', 0.5], ['palm_fan_a', 0.25], ['tree_broadleaf_a', 0.3]],
  plaza: [0.05, ['planter_a', 3], ['bench_plain', 1.5], ['palm_date_a', 1.5], ['bin_a', 0.5]],
  yard: [0.16, ['weed_a', 4], ['weed_b', 4], ['weed_c', 2], ['grass_tuft_c', 2], ['pallet_stack', 1], ['cone', 0.3], ['dumpster', 0.3]],
  shore: [0.4, ['scrub_seagrape_a', 2], ['scrub_seagrape_b', 3], ['weed_a', 1.5], ['grass_tuft_c', 2], ['groundcover_b', 1]],
  fill: [0.25, ['weed_a', 2], ['weed_b', 3], ['grass_tuft_b', 3], ['groundcover_b', 2]],
};
for (const m of Object.values(MIX)) m.total = m.slice(1).reduce((t, e) => t + e[1], 0);
const DENSITY = [0.4, 0.65, 0.85, 1];    // share of optional planting and furniture kept at each density setting

const tileKey = (x, z, tile) => Math.floor(x / tile) + ',' + Math.floor(z / tile);
/** Pylon sign prototypes by the archetype of the lot that puts one up, and the district styles that never do. */
const PYLON_KINDS = { motel: ['pylon_motel_a', 'pylon_motel_b', 'pylon_motel_c'], diner: ['pylon_diner_a', 'pylon_diner_b'], gas_station: ['pylon_garage_a', 'pylon_garage_b'] };
const NO_PYLON_STYLES = new Set(['industrial_port', 'airport', 'military', 'mansion_island', 'studio_island', 'downtown']);
/** Lots whose centre lies in a tile, indexed once per plan (the tile builder shares the same map). */
export function lotsInTile(plan, key) {
  if (!plan.lotTiles) { const map = new Map(), tile = plan.data.tile; for (const l of plan.lots) { const k = tileKey(l.x, l.z, tile); let a = map.get(k); if (!a) map.set(k, a = []); a.push(l); } plan.lotTiles = map; }
  return plan.lotTiles.get(key) || [];
}

/**
 * Plan-time furniture: signals with their lenses, stop and street signs, and the list of edges near each tile.
 * ctx: { net, field, data, laneGraph, tile, keepClear: [[x, z], ...] }.
 */
export function planFurniture(ctx, signalLenses) {
  const { net, field, laneGraph, tile } = ctx, S = new Sample();
  const fixed = new Map(), edgesByTile = new Map();
  const put = (proto, x, z, yaw) => { const k = tileKey(x, z, tile); let a = fixed.get(k); if (!a) fixed.set(k, a = []); a.push({ proto, x, z, yaw }); };
  for (const e of net.edges) {
    const seen = new Set(), reach = e.hw + e.pw + 14;
    for (let i = 0; i < e.pts.length; i += 2) for (const ox of [-reach, reach]) for (const oz of [-reach, reach]) {
      const k = tileKey(e.pts[i] + ox, e.pts[i + 1] + oz, tile); if (seen.has(k)) continue; seen.add(k);
      let a = edgesByTile.get(k); if (!a) edgesByTile.set(k, a = []); a.push(e.id);
    }
  }
  /** Step a kerbside point away from the node until it is off the carriageway. */
  const offRoad = (x, z, ox, oz) => { for (let i = 0; i < 16; i++) { const s = field.sample(x, z, S); if (s.type === TYPE.PAVEMENT || s.type === TYPE.LAND || s.type === TYPE.PARK || s.type === TYPE.LOT) return [x, z]; x += ox * 0.5; z += oz * 0.5; } return null; };

  for (const node of net.nodes) {
    if (node.kind !== 'junction') continue;
    const jid = laneGraph.nodeJunction[node.id], junction = jid >= 0 ? laneGraph.junctions[jid] : null, lenses = [];
    node.legs.forEach((leg, li) => {
      const e = net.edges[leg.edge], road = net.roads[e.road]; if (road.runway) return;
      const tx = -leg.dx, tz = -leg.dz, rx = -tz, rz = tx;                                  // travel direction into the node and its right-hand side
      const arrives = road.lanes.lanes.some((l) => (leg.end ? l.dir > 0 : l.dir < 0));
      if (!arrives) return;
      if (node.control === 'signal') {
        // Far-right corner: beyond the crossing road, to the right of our own carriageway.
        let cross = 0; for (const o of node.legs) if (o !== leg) cross = Math.max(cross, net.edges[o.edge].hw * Math.abs(leg.dx * o.dz - leg.dz * o.dx));
        const p = offRoad(node.x + rx * (e.hw + 0.9) + tx * (cross + 0.9), node.z + rz * (e.hw + 0.9) + tz * (cross + 0.9), (rx + tx) * 0.7, (rz + tz) * 0.7);
        if (!p) return;
        const proto = e.hw >= 8 ? 'signal_mast' : e.hw >= 5.5 ? 'signal_mast_short' : 'signal_post', yaw = Math.atan2(tx, tz), c = Math.cos(yaw), s = Math.sin(yaw);
        put(proto, p[0], p[1], yaw);
        for (const lens of signalLenses[proto] || []) {
          const lx = lens.pos[0], lz = lens.pos[2], fx = lens.facing[0], fz = lens.facing[1], colour = lens.color || lens.colour;
          lenses.push(p[0] + lx * c + lz * s, LAND_Y + 0.14 + lens.pos[1], p[1] - lx * s + lz * c, fx * c + fz * s, -fx * s + fz * c,
            colour === 'red' ? 0 : colour === 'amber' ? 1 : 2, lens.approach ? 1 - leg.group : leg.group, lens.diameter || 0.3);
        }
      } else if (leg.control === 'stop') {
        const p = offRoad(node.x - tx * (leg.setback + 0.4) + rx * (e.hw + 0.7), node.z - tz * (leg.setback + 0.4) + rz * (e.hw + 0.7), rx, rz);
        if (p) put('sign_stop', p[0], p[1], Math.atan2(-tx, -tz));
      }
      // One street-name sign per junction, on the left of its first kerbed leg.
      if (li === node.legs.findIndex((l) => net.edges[l.edge].pw > 0)) {
        const p = offRoad(node.x - tx * (leg.setback - 0.6) - rx * (e.hw + 0.7), node.z - tz * (leg.setback - 0.6) - rz * (e.hw + 0.7), -rx, -rz);
        if (p) put(['sign_street', 'sign_street_b', 'sign_street_c', 'sign_street_d'][hashInts(node.id, 5) & 3], p[0], p[1], Math.atan2(-tx, -tz));
      }
      // Speed limit sign after the junction on long main roads (facing traffic that leaves the node).
      if (e.hw >= 8 && e.length > 220 && !road.bridge) {
        const s0 = leg.end ? e.length - leg.setback - 45 : leg.setback + 45, f = edgePoint(e, s0, [0, 0, 0, 0]), dir = leg.end ? -1 : 1;
        const p = offRoad(f[0] - f[3] * dir * (e.hw + 0.7), f[1] + f[2] * dir * (e.hw + 0.7), -f[3] * dir, f[2] * dir);
        if (p) put(hashInts(e.id, 3) & 1 ? 'sign_speed' : 'sign_speed_b', p[0], p[1], Math.atan2(-f[2] * dir, -f[3] * dir));
      }
    });
    if (junction) junction.lenses = Float32Array.from(lenses);
  }
  return { fixed, edgesByTile, keepClear: ctx.keepClear || [] };
}

/**
 * Instances and parked cars of one tile.
 * plan: worker-side plan ({ data, field, net, furniture }); level 0 near, 1 mid (large things only), 2 far (nothing);
 * density 0..3 from settings; has(name) says whether a prototype exists (missing names are skipped).
 * Returns { groups: Map(name -> number[] of 8-float instance records), parked: number[] (6 floats each),
 * wires: number[] (7 floats per overhead conductor: both ends in world space, then 0 primary, 1 secondary, 2 cable) }.
 */
export function placeTile(plan, tx, tz, level, density, catalogue) {
  const { data, field, net, furniture } = plan, tile = data.tile, x0 = tx * tile, z0 = tz * tile, x1 = x0 + tile, z1 = z0 + tile;
  const groups = new Map(), parked = [], wires = [], S = new Sample(), f = [0, 0, 0, 0], thin = DENSITY[Math.max(0, Math.min(DENSITY.length - 1, density))];
  if (level >= 2) return { groups, parked, wires };
  const large = (name) => { const p = catalogue.get(name); return !!p && (p.tags.includes('tall') || p.tags.includes('large') || p.tags.includes('palm') || p.tags.includes('tree')); };
  const emit = (name, x, y, z, yaw, scale, seed, tint = 0) => {
    if (!catalogue.has(name) || (level === 1 && !large(name))) return;
    let g = groups.get(name); if (!g) groups.set(name, g = []);
    g.push(x, y, z, yaw, scale, hash01(seed, 91), tint, 0);
  };
  const inTile = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
  const styleAt = (s) => (s.district >= 0 ? data.districtInfo[s.district].style : 'golf');
  const key = tx + ',' + tz;

  // ---- fixed furniture decided with the plan
  for (const it of furniture.fixed.get(key) || []) { const s = field.sample(it.x, it.z, S); emit(it.proto, it.x, s.y, it.z, it.yaw, 1, hashInts(Math.round(it.x * 8), Math.round(it.z * 8))); }

  // ---- strips along roads
  for (const ei of furniture.edgesByTile.get(key) || []) {
    const e = net.edges[ei], road = net.roads[e.road];
    if (road.bridge) continue;
    const from = e.setA + 2, to = e.length - e.setB - 2, kerbed = e.pw >= 1.5, main = e.hw >= 8, lane = e.hw < 5;
    const medianHalf = data.edge.medHalf[ei];
    /** Walk a station grid anchored to the road's own stations; fn(s, x, z, tangentX, tangentZ, index). */
    const walk = (spacing, phase, fn) => {
      for (let k = Math.ceil((e.s0 + from - phase) / spacing); ; k++) {
        const s = k * spacing + phase - e.s0; if (s > to) break;
        edgePoint(e, s, f); fn(s, f[0], f[1], f[2], f[3], k);
      }
    };
    /** Place one thing at a lateral offset if the ground there is of an accepted type. */
    const at = (name, px, pz, tX, tZ, lateral, facing, types, seed, scale = 1, tint = 0) => {
      const x = px - tZ * lateral, z = pz + tX * lateral; if (!inTile(x, z)) return null;
      const s = field.sample(x, z, S); if (!types.includes(s.type)) return null;
      const side = lateral >= 0 ? 1 : -1;
      // facing: 0 towards the carriageway, 1 along the travel direction of that side, 2 against it (faces oncoming drivers)
      const yaw = facing === 0 ? Math.atan2(tZ * side, -tX * side) : facing === 1 ? Math.atan2(tX * side, tZ * side) : Math.atan2(-tX * side, -tZ * side);
      emit(name, x, s.y, z, yaw, scale, seed, tint); return s;
    };
    const PAVE = [TYPE.PAVEMENT], SOFT = [TYPE.LAND, TYPE.PARK, TYPE.SAND], MED = [TYPE.MEDIAN], ROADWAY = [TYPE.ROAD];
    /**
     * Lateral offset of a kerbside thing whose collider face stays `gap` metres behind the kerb face: a car that
     * mounts the kerb must not be trapped at once (trunks 0.9 m, posts and meters 0.5 m).
     */
    const off = (name, gap) => { const c = catalogue.get(name)?.collider; return e.hw + gap + (c ? (c.kind === 'box' ? Math.max(c.hx, c.hz) : c.radius) : 0); };
    if (road.runway) {
      walk(60, 30, (s, px, pz, tX, tZ, k) => { for (const side of [1, -1]) at('runway_light', px, pz, tX, tZ, side * (e.hw - 1.2), 0, [TYPE.ROAD, TYPE.JUNCTION, TYPE.PARK, TYPE.LAND], hashInts(ei, k, side + 1)); });
      continue;
    }
    // Lamps: twin cobra heads in a median, staggered single heads on kerbed roads, tall masts on open main roads,
    // low deco standards in the Art Deco beach district, utility poles down mainland lanes.
    if (medianHalf > 0) walk(48, 24, (s, px, pz, tX, tZ, k) => at('lamp_cobra_twin', px, pz, tX, tZ, 0.001, 0, MED, hashInts(ei, k, 1)));
    for (const side of [1, -1]) {
      const probe = edgePoint(e, Math.min(to, Math.max(from, e.length / 2)), [0, 0, 0, 0]);
      const style = styleAt(field.sample(probe[0] - probe[3] * side * (e.hw + e.pw + 4), probe[1] + probe[2] * side * (e.hw + e.pw + 4), S));
      const commercial = COMMERCIAL.has(style), kerbLine = side * (e.hw + 0.8);
      if (kerbed && !lane) {
        if (style === 'artdeco_beach' && !main) walk(32, side > 0 ? 0 : 16, (s, px, pz, tX, tZ, k) => at('lamp_deco', px, pz, tX, tZ, kerbLine, 0, PAVE, hashInts(ei, k, side + 5)));
        else if (!(medianHalf > 0)) walk(64, side > 0 ? 16 : 48, (s, px, pz, tX, tZ, k) => at('lamp_cobra', px, pz, tX, tZ, kerbLine, 0, PAVE, hashInts(ei, k, side + 5)));
      } else if (!kerbed && main && side > 0) walk(48, 16, (s, px, pz, tX, tZ, k) => at('lamp_highway', px, pz, tX, tZ, e.hw + 1.6, 0, SOFT, hashInts(ei, k, 6)));
      // Overhead lines on timber poles down one side: every mainland back street and every alley outside downtown.
      // A span belongs to the tile of its first pole and is strung to the next pole wherever that one stands.
      if (side < 0 && !main && (POLE_STREETS.has(style) || (lane && POLE_ALLEYS.has(style)))) {
        const lateral = side * (kerbed && !lane ? e.hw + 0.75 : e.hw + e.pw + 0.9), pole = [0, 0, 0, 0, false], next = [0, 0, 0, 0, false];
        const poleAt = (k, out) => {
          const st = k * POLE_SPACING + POLE_PHASE - e.s0; out[4] = false; if (st < from || st > to) return out;
          edgePoint(e, st, f); const x = f[0] - f[3] * lateral, z = f[1] + f[2] * lateral, s = field.sample(x, z, S);
          out[0] = x; out[1] = s.y; out[2] = z; out[3] = Math.atan2(f[3] * side, -f[2] * side); out[4] = s.type === TYPE.LAND || s.type === TYPE.PAVEMENT;
          return out;
        };
        for (let k = Math.ceil((e.s0 + from - POLE_PHASE) / POLE_SPACING); k * POLE_SPACING + POLE_PHASE - e.s0 <= to; k++) {
          poleAt(k, pole); if (!pole[4] || !inTile(pole[0], pole[2])) continue;
          const name = k % 3 === 0 ? 'power_pole' : 'power_pole_plain', anchors = catalogue.has(name) ? catalogue.get(name).anchors : null;
          emit(name, pole[0], pole[1], pole[2], pole[3], 1, hashInts(ei, k, 7));
          if (!anchors || !poleAt(k + 1, next)[4]) continue;
          for (const a of anchors) {
            const kind = a.kind === 'primary' ? 0 : a.kind === 'secondary' ? 1 : 2;
            for (const q of [pole, next]) { const c = Math.cos(q[3]), sn = Math.sin(q[3]); wires.push(q[0] + a.pos[0] * c + a.pos[2] * sn, q[1] + a.pos[1], q[2] - a.pos[0] * sn + a.pos[2] * c); }
            wires.push(kind);
          }
        }
      }

      // Palms and street trees: in pits along a wide pavement, otherwise on the verge behind it; and down the median.
      const trees = STREET_TREES[style];
      if (trees && !lane) {
        const inPavement = kerbed && e.pw >= 2.4;
        walk(8, 4, (s, px, pz, tX, tZ, k) => {
          const seed = hashInts(ei, k, side + 11); if (hash01(seed, 1) > trees[0] * (inPavement ? 1 : 0.7) * thin) return;
          const name = trees[1][Math.floor(hash01(seed, 2) * trees[1].length)];
          at(name, px, pz, tX, tZ, side * (inPavement ? off(name, 0.9) : e.hw + e.pw + 2.3), 0, inPavement ? PAVE : SOFT, seed, 0.9 + 0.25 * hash01(seed, 3));
        });
      }
      if (medianHalf > 0.8 && side > 0) walk(8, 4, (s, px, pz, tX, tZ, k) => {
        const seed = hashInts(ei, k, 23), r = hash01(seed, 1), palm = k % 3 === 0 ? 'palm_date_a' : ['palm_royal_a', 'palm_royal_b'][k & 1];
        // A trunk in the median keeps the same 0.9 m behind both kerb faces; a narrow median gets the shrubs.
        if (r < 0.7 * thin && off(palm, 0.9) - e.hw <= medianHalf) at(palm, px, pz, tX, tZ, 0.001, 0, MED, seed, 0.9 + 0.2 * hash01(seed, 3));
        else if (r < 0.95) at(['shrub_c', 'shrub_b', 'groundcover_a'][seed % 3], px, pz, tX, tZ, 0.001, 0, MED, seed);
      });

      if (level > 0) continue;                          // everything below is small street furniture and cars
      const parking = road.lanes.parking;
      if (kerbed) {
        walk(120, 37, (s, px, pz, tX, tZ, k) => { if ((k & 1) === (side > 0 ? 0 : 1)) at('hydrant', px, pz, tX, tZ, side * off('hydrant', 0.5), 0, PAVE, hashInts(ei, k, 31)); });
        if (commercial) {
          walk(40, 22, (s, px, pz, tX, tZ, k) => { if ((k & 1) === (side > 0 ? 0 : 1)) at('bin_a', px, pz, tX, tZ, side * off('bin_a', 0.5), 0, PAVE, hashInts(ei, k, 32)); });
          if (e.pw >= 2.5) walk(56, 30, (s, px, pz, tX, tZ, k) => { const seed = hashInts(ei, k, side + 33); if (hash01(seed, 1) < 0.6 * thin) at(seed & 1 ? 'bench_a' : 'bench_b', px, pz, tX, tZ, side * (e.hw + e.pw - 0.45), 0, PAVE, seed); });
          walk(176, 70, (s, px, pz, tX, tZ, k) => { if ((k & 1) === (side > 0 ? 1 : 0)) at('phone_booth', px, pz, tX, tZ, side * (e.hw + e.pw - 0.55), 0, PAVE, hashInts(ei, k, 34)); });
          if (parking && style !== 'hotel_strip') walk(LANE.BAY * 2, 0, (s, px, pz, tX, tZ, k) => at('meter_twin', px, pz, tX, tZ, side * off('meter_twin', 0.5), 0, PAVE, hashInts(ei, k, side + 35)));
          // Newspaper boxes in a short row near each corner.
          for (const [s0, n] of [[from + 3, 2 + (hashInts(ei, side + 36) % 3)], [to - 5, 2 + (hashInts(ei, side + 37) % 3)]]) {
            if (hash01(hashInts(ei, side, Math.round(s0)), 4) > 0.45 * thin || to - from < 30) continue;
            for (let i = 0; i < n; i++) { edgePoint(e, s0 + i * 0.6, f); const seed = hashInts(ei, side + 38, i + Math.round(s0)); at(seed & 1 ? 'newsbox' : 'newsbox_b', f[0], f[1], f[2], f[3], side * off('newsbox', 0.5), 0, PAVE, seed, 1, hash01(seed, 2)); }
          }
        } else walk(208, 90, (s, px, pz, tX, tZ, k) => { if ((k & 1) === (side > 0 ? 0 : 1)) at('mailbox', px, pz, tX, tZ, side * off('mailbox', 0.5), 0, PAVE, hashInts(ei, k, 39)); });
        if (busStopsOn(e)) walk(BUS_STOP_SPACING, busStopPhase(side), (s, px, pz, tX, tZ, k) => { if (at('bus_stop', px, pz, tX, tZ, side * (e.hw + e.pw - 0.95), 0, PAVE, hashInts(ei, k, 40))) at('bus_stop_sign', px + tX * 3.2, pz + tZ * 3.2, tX, tZ, side * off('bus_stop_sign', 0.5), 2, PAVE, hashInts(ei, k, 41)); });
      } else if (lane) walk(48, 20, (s, px, pz, tX, tZ, k) => { const seed = hashInts(ei, k, side + 42); if (hash01(seed, 1) < 0.35) at('dumpster', px, pz, tX, tZ, side * (e.hw + 1.3), 0, [TYPE.LAND], seed); });

      // Parked cars in the painted kerbside bays (bay lines are on the road's 6.7 m station grid).
      if (parking) {
        const share = (PARKED_SHARE[style] ?? 0.15) * (0.6 + 0.4 * thin), lateral = side * (parking.inner + parking.outer) / 2;
        walk(LANE.BAY, LANE.BAY / 2, (s, px, pz, tX, tZ, k) => {
          if (s < from + 5 || s > to - 5) return;
          // The painted bus stop box is kept clear.
          if (busStopsOn(e) && Math.abs(((s + e.s0 - busStopPhase(side)) % BUS_STOP_SPACING + BUS_STOP_SPACING * 1.5) % BUS_STOP_SPACING - BUS_STOP_SPACING / 2) < BUS_STOP_CLEAR) return;
          const seed = hashInts(ei, k, side + 51); if (hash01(seed, 1) > share) return;
          const x = px - tZ * lateral, z = pz + tX * lateral; if (!inTile(x, z)) return;
          // On the carriageway and hard against a kerb: where another road runs into this one at a shallow
          // angle the bay would lie in its traffic lane.
          if (field.sample(x, z, S).type !== TYPE.ROAD || S.a < -PARKED_KERB_REACH || furniture.keepClear.some((c) => Math.hypot(c[0] - x, c[1] - z) < 12)) return;
          parked.push(x, LAND_Y, z, Math.atan2(tX * side, tZ * side), PARKED_TYPES[seed % PARKED_TYPES.length], (seed >>> 8) % PARKED_COLOURS);
        });
      }
    }
  }

  // ---- scatter on a global jittered lattice
  const pickMix = (mix, r) => { let t = r * mix.total; for (let i = 1; i < mix.length; i++) { t -= mix[i][1]; if (t <= 0) return mix[i][0]; } return mix[mix.length - 1][0]; };
  const G = 5;
  for (let gz = Math.floor(z0 / G); gz * G < z1; gz++) for (let gx = Math.floor(x0 / G); gx * G < x1; gx++) {
    const seed = hashInts(gx, gz, 1009), x = (gx + 0.15 + 0.7 * hash01(seed, 1)) * G, z = (gz + 0.15 + 0.7 * hash01(seed, 2)) * G;
    if (!inTile(x, z)) continue;
    const s = field.sample(x, z, S); let mix = null;
    if (s.type === TYPE.SAND) { if (s.lr > 1 && s.sb < -2) mix = MIX.dune; }
    else if (s.type === TYPE.PARK) {
      const kind = PARK_KINDS[data.parkKind[s.parkId]];
      if (s.park > -2 || s.aP < 2) continue;
      if (kind === 'park') mix = MIX.park; else if (kind === 'golf') { if (field.coverOf(s) === COVER.ROUGH) mix = MIX.golfRough; } else if (kind === 'dirt') mix = MIX.fill;
    } else if (s.type === TYPE.LAND) {
      if (s.aP < 1.6 || s.lot < 1.2) continue;
      const cover = field.coverOf(s);
      if (s.lr < 7 && s.run > 0.5) mix = MIX.shore;
      else mix = cover === COVER.LAWN ? MIX.lawn : cover === COVER.ROUGH ? MIX.rough : cover === COVER.PAVERS ? MIX.plaza : cover === COVER.SAND ? MIX.dune : MIX.yard;
    } else if (s.type === TYPE.FILL) mix = MIX.fill;
    else if (s.type === TYPE.BED && s.y > 0.5 && s.run > 0.5 && s.run < 12) mix = MIX.shore;
    if (!mix || hash01(seed, 3) > mix[0] * thin) continue;
    emit(pickMix(mix, hash01(seed, 4)), x, s.y, z, hash01(seed, 5) * Math.PI * 2, 0.8 + 0.45 * hash01(seed, 6), seed, hash01(seed, 7));
  }

  // ---- turf: short grass cards standing in the lawn and the rough beside pavements, where a flat green surface
  // would be seen edge on from the road. The cards are only drawn close to the camera, so the band is narrow.
  if (level === 0) {
    for (let gz = Math.floor(z0 / TURF_CELL); gz * TURF_CELL < z1; gz++) for (let gx = Math.floor(x0 / TURF_CELL); gx * TURF_CELL < x1; gx++) {
      const cx = (gx + 0.5) * TURF_CELL, cz = (gz + 0.5) * TURF_CELL, s = field.sample(cx, cz, S);
      if (s.type === TYPE.PARK ? PARK_KINDS[data.parkKind[s.parkId]] !== 'park' || s.park > -TURF_MARGIN : s.type !== TYPE.LAND || s.lot < TURF_MARGIN) continue;
      if (s.aP < TURF_MARGIN || s.aP > TURF_REACH || s.sb < 2) continue;
      const cover = field.coverOf(s), lawn = cover === COVER.LAWN; if (!lawn && cover !== COVER.ROUGH) continue;
      // Thick at the pavement, thinning to nothing at the end of the band.
      const cell = hashInts(gx, gz, 6007), want = (lawn ? TURF_LAWN : TURF_ROUGH) * TURF_CELL * TURF_CELL * thin * (1 - (s.aP - TURF_MARGIN) / (TURF_REACH - TURF_MARGIN));
      const count = Math.floor(want + hash01(cell, 1));
      for (let i = 0; i < count; i++) {
        const seed = hashInts(cell, i, 6011);
        emit(lawn ? 'grass_tuft_a' : hash01(seed, 5) < 0.88 ? 'grass_tuft_b' : 'grass_tuft_c', cx + (hash01(seed, 1) - 0.5) * TURF_CELL, s.y, cz + (hash01(seed, 2) - 0.5) * TURF_CELL, hash01(seed, 3) * Math.PI * 2, 0.8 + 0.45 * hash01(seed, 4), seed, hash01(seed, 6));
      }
    }
  }

  // ---- the beach: umbrellas with a pair of loungers in rows on the dry sand, in clusters; lifeguard towers
  const seaward = (x, z) => { const a = field.sample(x + 3, z, S).ds, b = field.sample(x - 3, z, S).ds, c = field.sample(x, z + 3, S).ds, d = field.sample(x, z - 3, S).ds; return Math.atan2(b - a, d - c); };
  if (level === 0) {
    const BX = 7, BZ = 5.5;
    for (let gz = Math.floor(z0 / BZ); gz * BZ < z1; gz++) for (let gx = Math.floor(x0 / BX); gx * BX < x1; gx++) {
      const x = (gx + 0.5) * BX, z = (gz + 0.5) * BZ; if (!inTile(x, z)) continue;
      const s = field.sample(x, z, S); if (s.type !== TYPE.SAND && s.type !== TYPE.BED) continue;
      if (s.y < 0.92 || s.lr > -6 || s.ds < 30 || noise2(x / 70, z / 70, 31) < 0.52) continue;
      const seed = hashInts(gx, gz, 2003); if (hash01(seed, 1) > 0.8 * thin) continue;
      const y = s.y, yaw = seaward(x, z), c = Math.cos(yaw), sn = Math.sin(yaw), tint = hash01(hashInts(Math.floor(x / 60), Math.floor(z / 60), 7), 1);
      emit('umbrella_a', x, y, z, yaw, 0.9 + 0.2 * hash01(seed, 2), seed, tint);
      for (const o of [-0.75, 0.75]) emit('lounger', x + o * c + 0.5 * sn, y, z - o * sn + 0.5 * c, yaw, 1, seed + (o > 0 ? 1 : 2), tint);
    }
  }
  const LG = 230;
  for (let gz = Math.floor(z0 / LG); gz * LG < z1; gz++) for (let gx = Math.floor(x0 / LG); gx * LG < x1; gx++) {
    for (let t = 0; t < 12; t++) {
      const seed = hashInts(gx, gz, 3001 + t), x = (gx + hash01(seed, 1)) * LG, z = (gz + hash01(seed, 2)) * LG, s = field.sample(x, z, S);
      if ((s.type !== TYPE.SAND && s.type !== TYPE.BED) || s.y < 0.9 || s.y > 1.05 || s.ds < 30) continue;
      if (inTile(x, z)) emit(seed & 1 ? 'lifeguard_tower_a' : 'lifeguard_tower_b', x, s.y, z, seaward(x, z), 1, seed, hash01(seed, 3));
      break;
    }
  }

  // ---- docks and yards: container stacks on quays and in port yards, cranes on the quay edge, tanks
  const CX = 7.5, CZ = 3.4;
  const yardYaw = (s) => (s.type === TYPE.PARK ? data.parkYaw[s.parkId] : s.district >= 0 ? Math.PI / 2 - data.districtInfo[s.district].yaw : 0);
  for (let gz = Math.floor((z0 - 16) / 16); gz * 16 < z1 + 16; gz++) for (let gx = Math.floor((x0 - 16) / 16); gx * 16 < x1 + 16; gx++) {
    const cx = (gx + 0.5) * 16, cz = (gz + 0.5) * 16, s = field.sample(cx, cz, S);
    const dock = s.type === TYPE.PARK && PARK_KINDS[data.parkKind[s.parkId]] === 'dock', port = s.type === TYPE.LAND && s.district >= 0 && data.districtInfo[s.district].style === 'industrial_port';
    if (!dock && !port) continue;
    if (noise2(cx / 60, cz / 60, 41) < (dock ? 0.45 : 0.62)) continue;
    const yaw = yardYaw(s), c = Math.cos(yaw), sn = Math.sin(yaw), seed0 = hashInts(gx, gz, 4001);
    // A block of two rows of two boxes, stacked up to three high.
    for (let r = 0; r < 2; r++) for (let k = 0; k < 2; k++) {
      const u = (k - 0.5) * CX, v = (r - 0.5) * CZ, x = cx + u * c + v * sn, z = cz - u * sn + v * c; if (!inTile(x, z)) continue;
      const t = field.sample(x, z, S); if ((t.type !== TYPE.PARK && t.type !== TYPE.LAND) || t.aP < 5 || t.lot < 4 || t.lr < 5 || (t.type === TYPE.PARK && t.park > -4)) continue;
      const seed = hashInts(seed0, r, k), high = 1 + Math.floor(hash01(seed, 1) * (dock ? 3 : 2));
      for (let h = 0; h < high; h++) emit('container_a', x, t.y + h * 2.59, z, yaw + (hash01(seed, 5 + h) < 0.5 ? 0 : Math.PI), 1, seed + h, hash01(seed, 9 + h));
    }
  }
  for (let gz = Math.floor(z0 / 110); gz * 110 < z1; gz++) for (let gx = Math.floor(x0 / 110); gx * 110 < x1; gx++) {
    for (let t = 0; t < 10; t++) {
      const seed = hashInts(gx, gz, 5001 + t), x = (gx + hash01(seed, 1)) * 110, z = (gz + hash01(seed, 2)) * 110, s = field.sample(x, z, S);
      const dock = s.type === TYPE.PARK && PARK_KINDS[data.parkKind[s.parkId]] === 'dock';
      if (dock && s.lr > 5 && s.lr < 11 && s.run < 0.5) {
        // Boom over the water: local +Z points down the gradient of the distance to the shore.
        const yaw = Math.atan2(field.sample(x - 3, z, S).lr - field.sample(x + 3, z, S).lr, field.sample(x, z - 3, S).lr - field.sample(x, z + 3, S).lr);
        if (inTile(x, z)) emit('crane_dock', x, s.y, z, yaw, 1, seed); break;
      }
      const port = s.type === TYPE.LAND && s.district >= 0 && data.districtInfo[s.district].style === 'industrial_port';
      if (port && s.aP > 12 && s.lot > 10 && s.lr > 12 && s.park > 10 && hash01(seed, 3) < 0.5) { if (inTile(x, z)) emit('tank_a', x, s.y, z, 0, 1, seed); break; }
    }
  }

  // ---- roadside pylon signs: one per motor court, diner or garage lot, at the lot's street edge beside the
  // forecourt entrance, facing the carriageway. None where the era had none: the port, the airport, the base,
  // the mansion islands and downtown's towers.
  for (const lot of lotsInTile(plan, key)) {
    const kinds = PYLON_KINDS[lot.archetype]; if (!kinds || NO_PYLON_STYLES.has(lot.style) || lot.landmark) continue;
    const seed = hashInts(lot.seed, 77), c = Math.cos(lot.yaw), sn = Math.sin(lot.yaw);
    const lx = (hash01(seed, 1) < 0.5 ? -1 : 1) * (lot.width / 2 - 2.5), lz = lot.depth / 2 - 1.2, x = lot.x + lx * c + lz * sn, z = lot.z - lx * sn + lz * c;
    if (!inTile(x, z)) continue;
    const s = field.sample(x, z, S); if (s.type !== TYPE.LOT) continue;
    emit(kinds[seed % kinds.length], x, s.y, z, lot.yaw, 1, seed);
  }

  // ---- cars in the painted bays of public car parks
  if (level === 0) {
    const seen = new Set();
    for (let gz = 0; gz < 4; gz++) for (let gx = 0; gx < 4; gx++) { const s = field.sample(x0 + (gx + 0.5) * tile / 4, z0 + (gz + 0.5) * tile / 4, S); if (s.type === TYPE.PARK && PARK_KINDS[data.parkKind[s.parkId]] === 'parking') seen.add(s.parkId); }
    for (const id of seen) {
      const inside = (x, z) => { const s = field.sample(x, z, S); return s.type === TYPE.PARK && s.parkId === id && s.park < -1.5; };
      for (const bay of lotBays([x0, z0, x1, z1], inside, headingByte(data.parkYaw[id]), PARKING_SPACING_DM)) {
        if (!inTile(bay.x, bay.z)) continue;
        const seed = hashInts(Math.round(bay.x * 4), Math.round(bay.z * 4), 61); if (hash01(seed, 1) > 0.38 * (0.6 + 0.4 * thin)) continue;
        parked.push(bay.x, LAND_Y + 0.14, bay.z, bay.yaw, PARKED_TYPES[seed % PARKED_TYPES.length], (seed >>> 8) % PARKED_COLOURS);
      }
    }
  }
  return { groups, parked, wires };
}

// Turf cards: cell of the lattice that decides them, the clearance kept from paving and plots, the width of the
// band beside a pavement, and cards per square metre at the pavement for lawn and for rough grass.
const TURF_CELL = 2, TURF_MARGIN = 1.5, TURF_REACH = 9, TURF_LAWN = 7, TURF_ROUGH = 3.5;

// Bus stops stand on main roads with a wide pavement, on the road's own station grid, the two sides out of step.
// The ground mesher paints the stop box on the carriageway from the same rule.
export const BUS_STOP_SPACING = 336;
const BUS_STOP_CLEAR = 10;       // metres either side of the shelter in which nothing parks
export const busStopsOn = (e) => e.hw >= 8 && e.pw >= 3;
export const busStopPhase = (side) => (side > 0 ? 120 : 288);

/** Bay spacing of public car parks in decimetres (LOT material p1); the ground mesher writes the same value. */
const PARKED_KERB_REACH = 3;   // metres: a kerbside parked car's centre is never further than this from the kerb
export const PARKING_SPACING_DM = 27;
