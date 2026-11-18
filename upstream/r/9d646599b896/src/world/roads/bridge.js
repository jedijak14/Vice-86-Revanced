// Bridges and causeways: everything between the two points where a road leaves the land and returns to it.
// The builder sweeps cross-sections along the road's centre line on a vertical profile (profile.js) and adds what
// stands on or under the deck: parapets, lamp standards, girders, piers, abutments and rock-faced fill.
//
// Stations are metres along the centre line exactly as the plan gives it. The bridge is cut into 16 m chunks on a
// fixed station grid; each chunk has one kind of support, so pieces built from adjacent ranges meet exactly.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, GROUND, SOLID, CHANNEL, LIGHT_STRIDE, GLOW_STRIDE } from '../../core/ids.js';
import { clamp, lerp, smoothstep, hashInts, hash01, hashString } from '../../core/math.js';
import { LAND_Y, KERB_HEIGHT, KERB, LANE_FLAG, laneCode, laneLayout, headingByte } from './lanes.js';

/** Metres at each end of a bridge over which its lane lines move from the kerbed street's layout to their own. */
export const LANE_TAPER = 16;

// uv of a strip that takes no part in any blend (ARCHITECTURE 5.2: blend distance 99 = none)
const NO_BLEND = Object.freeze([99, 0, 99, 0]);
import { makeProfile } from './profile.js';
import { frameAt, place, quadAwayFrom, box, column, pipe } from './shapes.js';

/** Station length of one chunk: the unit in which a bridge is built, cut and assigned to tiles. */
export const BRIDGE_CHUNK = 16;
/** Piers and expansion joints stand on every second chunk boundary inside a run of spans. */
const BAY = 2 * BRIDGE_CHUNK;
/** Station step of the swept surfaces per level of detail. */
const STEP = [2, 8, 16];
/** Size of one armour stone on a rock slope, metres. */
const ROCK_SIZE = 1.0;

const DECK = Object.freeze({
  KERB_TOP: 0.15,        // width of the kerb stone
  WALL: 0.30,            // parapet thickness; also the least thickness of the collision wall
  WALL_TOP: 1.05,        // height of the collision wall above the walkway
  SLAB: 0.35,            // depth of the deck slab at its edge
  GIRDER: 1.40,          // underside of the girders below the road surface
  SLOPE: 1.25,           // fill and embankment side slopes, horizontal per vertical
  SEA_TOE: -3.05,        // rock fill is built down to here, just under the deepest sea bed near a shore
  SHORE: [2, 10],        // the toe goes from land level to the sea bed between these distances past a landfall
  SKIRT: 0.45,           // the verge turns down by this much at the edge of the footprint to close against the plan's ground
  MIN_CLEAR: 2.3,        // least height of the road above the sea at the end of a span
  FILL_REACH: 96,        // a causeway's rock fill runs at most this far out from each shore
});
const TINT = Object.freeze({
  concrete: [0.74, 0.73, 0.70], pier: [0.68, 0.67, 0.64], rock: [0.47, 0.45, 0.41], steel: [0.60, 0.62, 0.63],
  decoRail: [0.52, 0.78, 0.74], decoStone: [0.90, 0.86, 0.78], pole: [0.33, 0.37, 0.36], sodium: [1, 0.81, 0.50], warm: [1, 0.93, 0.80],
});
/** Lamp sources: linear chromaticity, light power, radius, lens radiance, glow size (ARCHITECTURE 4.6). */
const LAMP = Object.freeze({
  cobra: { source: [1, 0.62, 0.214], power: 420, radius: 26, radiance: 45, glow: 1.5, height: 9.0, tint: TINT.sodium },
  deco: { source: [1, 0.84, 0.60], power: 85, radius: 13, radiance: 24, glow: 1.0, height: 4.1, tint: TINT.warm },
});
const radianceCode = (radiance) => clamp(Math.round(16 * Math.log2(radiance / 0.25)), 2, 255);

// ------------------------------------------------------------------------------------------------ centre line

function measure(path) {
  const n = path.length, cum = new Float64Array(n), fx = new Float64Array(n), fz = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = path[i][0] - path[i - 1][0], dz = path[i][1] - path[i - 1][1], l = Math.hypot(dx, dz) || 1e-9;
    cum[i] = cum[i - 1] + l; fx[i - 1] = dx / l; fz[i - 1] = dz / l;
  }
  if (n > 1) { fx[n - 1] = fx[n - 2]; fz[n - 1] = fz[n - 2]; }
  return { path, cum, fx, fz, length: cum[n - 1] || 0 };
}
function segmentAt(line, s) {
  let i = 0; const last = line.cum.length - 2;
  while (i < last && s > line.cum[i + 1]) i++;
  return i;
}
/** Closest point of the centre line: station and lateral offset (right of the direction of travel is positive). */
function stationOf(line, x, z) {
  let best = Infinity, out = { s: 0, lateral: 0 };
  for (let i = 0; i + 1 < line.path.length; i++) {
    const ax = line.path[i][0], az = line.path[i][1], len = line.cum[i + 1] - line.cum[i];
    const t = clamp(((x - ax) * line.fx[i] + (z - az) * line.fz[i]), 0, len), px = ax + line.fx[i] * t, pz = az + line.fz[i] * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; out = { s: line.cum[i] + t, lateral: (x - px) * -line.fz[i] + (z - pz) * line.fx[i] }; }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ description

const cache = new WeakMap();

/** Spec for buildBridge from a layout road that has a `bridge` entry (path: `points` or `path`). */
export function bridgeSpecFromRoad(road) {
  const b = road.bridge || {}, arch = b.style === 'arch', id = road.id ?? 'bridge', pick = hashInts(hashString(String(id)), 7);
  const railing = b.railing || (arch ? 'deco' : (pick & 1 ? 'parapet' : 'rail'));
  return {
    id, path: road.points || road.path, halfWidth: road.width / 2, lanesPerDirection: road.lanesPerDirection || Math.max(1, (road.lanes || 2) >> 1),
    oneWay: !!road.oneWay, pavementWidth: road.sidewalk === false ? 0 : (road.pavementWidth ?? 2), deckY: b.deckY, style: arch ? 'arch' : 'flat',
    kind: arch ? 'bridge' : 'causeway', landfallA: b.landfallA, landfallB: b.landfallB, railing, lamps: b.lamps || (railing === 'deco' ? 'deco' : 'cobra'), age: road.age ?? 120,
  };
}

/**
 * Everything about a bridge that does not need a mesh: length, profile, frames, supports, piers, lamps, footprint.
 * Cheap (a few hundred operations) and cached per spec object.
 */
export function describeBridge(spec) {
  const hit = cache.get(spec); if (hit) return hit;
  const line = measure(spec.path), length = line.length, seed = hashString(String(spec.id ?? 'bridge'));
  const profile = makeProfile({ length, rise: Math.max(0, (spec.deckY ?? LAND_Y) - LAND_Y), style: spec.style === 'arch' ? 'arch' : 'flat' });
  const hw = spec.halfWidth, pw = Math.max(0, spec.pavementWidth ?? 2), kh = pw > 0 ? KERB_HEIGHT : 0;
  const lp = hw + (pw > 0 ? pw : 0.3), le = lp + DECK.WALL;
  const code = spec.laneCode ?? laneCode({ lanesPerDirection: spec.lanesPerDirection || 1, oneWay: !!spec.oneWay });

  // water: explicit station intervals, or the stretch between the two landfalls
  let water = (spec.water || []).map(([a, b]) => [Math.min(a, b), Math.max(a, b)]);
  if (!water.length && spec.landfallA && spec.landfallB) {
    const a = stationOf(line, spec.landfallA[0], spec.landfallA[1]).s, b = stationOf(line, spec.landfallB[0], spec.landfallB[1]).s;
    if (Math.abs(b - a) > 1) water = [[Math.min(a, b), Math.max(a, b)]];
  }
  const overWater = (s) => water.some(([a, b]) => s >= a && s <= b);

  // one support per chunk
  const chunks = Math.max(1, Math.ceil(length / BRIDGE_CHUNK - 1e-6)), support = new Array(chunks).fill(null);
  const startOf = (k) => k * BRIDGE_CHUNK, endOf = (k) => Math.min(length, (k + 1) * BRIDGE_CHUNK);
  for (const [a, b] of water) {
    // fill runs out from each shore, further on a causeway; what is left in the middle is carried on piers
    const reach = spec.kind === 'bridge' || b - a < 120 ? 0 : Math.min(0.3 * (b - a), DECK.FILL_REACH);
    let k0 = Math.ceil((a + reach) / BRIDGE_CHUNK - 1e-6), k1 = Math.floor((b - reach) / BRIDGE_CHUNK + 1e-6) - 1;
    const mid = clamp(Math.floor((a + b) / 2 / BRIDGE_CHUNK), 0, chunks - 1);
    // a span needs headroom over the sea at both ends: keep filling until the deck is high enough
    while (k0 < mid && profile.y(startOf(k0)) < DECK.MIN_CLEAR) k0++;
    while (k1 > mid && profile.y(endOf(k1)) < DECK.MIN_CLEAR) k1--;
    if (k1 < k0) k0 = k1 = mid;
    for (let k = Math.max(0, k0); k <= Math.min(chunks - 1, k1); k++) support[k] = 'span';
  }
  for (let k = 0; k < chunks; k++) {
    if (support[k]) continue;
    const s0 = startOf(k), s1 = endOf(k), top = Math.max(profile.y(s0), profile.y(s1));
    // rock fill only where the whole chunk stands in the sea; a chunk that straddles the shore is still an embankment
    support[k] = overWater(s0) && overWater(s1) ? 'fill' : (top - LAND_Y < 0.05 ? 'grade' : 'embankment');
  }
  const sections = [];
  for (let k = 0; k < chunks; k++) {
    const last = sections[sections.length - 1];
    if (last && last.support === support[k]) last.to = endOf(k); else sections.push({ from: startOf(k), to: endOf(k), support: support[k] });
  }

  // level the side slopes come down to: the land, or just past a landfall the sea bed
  const floorAt = (s) => {
    let f = 0;
    for (const [a, b] of water) f = Math.max(f, Math.min(smoothstep(a + DECK.SHORE[0], a + DECK.SHORE[1], s), 1 - smoothstep(b - DECK.SHORE[1], b - DECK.SHORE[0], s)));
    return lerp(LAND_Y, DECK.SEA_TOE, f);
  };
  // the slope starts under the edge beam, or at the ground where the road is still low
  const slopeTop = (s) => Math.max(profile.y(s) - DECK.SLAB, floorAt(s));
  const toeAt = (s) => le + DECK.SLOPE * (slopeTop(s) - floorAt(s));
  let halfExtent = le + 1.5;
  for (let k = 0; k < chunks; k++) if (support[k] !== 'span') halfExtent = Math.max(halfExtent, toeAt(startOf(k)) + 0.8, toeAt(endOf(k)) + 0.8);
  // distance over which cross-sections turn into the mitre at each vertex: 1.5 times what keeps them from crossing
  const fan = new Float64Array(line.path.length);
  for (let v = 1; v < line.path.length - 1; v++) {
    const angle = Math.abs(Math.atan2(line.fx[v - 1] * line.fz[v] - line.fz[v - 1] * line.fx[v], line.fx[v - 1] * line.fx[v] + line.fz[v - 1] * line.fz[v]));
    fan[v] = Math.min(Math.max(1, 0.75 * angle * halfExtent), 0.45 * Math.min(line.cum[v] - line.cum[v - 1], line.cum[v + 1] - line.cum[v]));
  }

  const piers = [], lamps = [], lampKind = spec.lamps || (spec.railing === 'deco' ? 'deco' : 'cobra');
  for (let k = 1; k < chunks; k++) if (support[k] === 'span' && support[k - 1] === 'span' && (k * BRIDGE_CHUNK) % BAY === 0) piers.push(startOf(k));
  if (lampKind !== 'none') for (let k = 0; k < chunks; k++) {
    // sodium lanterns every second chunk, alternating sides; the low deco lamps in every chunk
    if (endOf(k) - startOf(k) < BRIDGE_CHUNK * 0.75 || (lampKind === 'cobra' && !(k & 1))) continue;
    lamps.push({ s: startOf(k) + BRIDGE_CHUNK / 2, side: ((lampKind === 'cobra' ? k >> 1 : k) & 1) ? -1 : 1 });
  }

  const frame = (s, out = {}) => {
    s = clamp(s, 0, length); const i = segmentAt(line, s), t = s - line.cum[i];
    out.x = line.path[i][0] + line.fx[i] * t; out.z = line.path[i][1] + line.fz[i] * t; out.y = profile.y(s);
    out.yaw = Math.atan2(line.fx[i], line.fz[i]); out.grade = profile.grade(s); out.fx = line.fx[i]; out.fz = line.fz[i];
    return out;
  };
  const info = {
    length, profile, y: profile.y, frame, stationOf: (x, z) => stationOf(line, x, z), sections, piers, lamps, halfExtent,
    laneCode: code, layout: laneLayout(hw, code, true), chunk: BRIDGE_CHUNK, chunks,
    internal: { line, fan, seed, support, startOf, endOf, floorAt, slopeTop, toeAt, hw, pw, kh, lp, le, code, lampKind, railing: spec.railing || 'parapet', age: spec.age ?? 120 },
  };
  cache.set(spec, info);
  return info;
}

// ------------------------------------------------------------------------------------------------ cross-sections

/**
 * Cross-section at station s. On a straight it is square to the road. Near an interior vertex of the centre line it
 * turns towards the bisector, reaching it exactly at the vertex, and is stretched so that everything keeps its
 * distance from the centre line (a mitre spread over `fan` metres, so that no two sections can cross at the toe of
 * the fill however close to the vertex they are).
 */
function rowAt(info, s) {
  const I = info.internal, line = I.line, last = line.path.length - 2;
  s = clamp(s, 0, info.length);
  const i = segmentAt(line, s), t = s - line.cum[i], left = line.cum[i + 1] - s, nx = -line.fz[i], nz = line.fx[i];
  let rx = nx, rz = nz;
  const turn = (other, fan, d) => { const w = 0.5 * (1 - d / fan); rx += (-line.fz[other] - nx) * w; rz += (line.fx[other] - nz) * w; };
  if (i > 0 && t < I.fan[i]) turn(i - 1, I.fan[i], t); else if (i < last && left < I.fan[i + 1]) turn(i + 1, I.fan[i + 1], left);
  const stretch = 1 / Math.max(0.5, rx * nx + rz * nz); rx *= stretch; rz *= stretch;
  const x = line.path[i][0] + line.fx[i] * t, z = line.path[i][1] + line.fz[i] * t;
  const y = info.profile.y(s), floor = I.floorAt(s), top = I.slopeTop(s);
  return { s, x, z, rx, rz, y, g: info.profile.grade(s), floor, top, toe: I.le + DECK.SLOPE * (top - floor) };
}

/** Stations of chunk k at a level, split into runs at the vertices of the centre line (constant heading per run). */
function chunkRuns(info, k, lod) {
  const I = info.internal, line = I.line, a = I.startOf(k), b = I.endOf(k), cuts = [a];
  for (let i = 1; i < line.path.length - 1; i++) if (line.cum[i] > a + 1e-6 && line.cum[i] < b - 1e-6) cuts.push(line.cum[i]);
  cuts.push(b);
  const runs = [];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const rows = [], from = cuts[c], to = cuts[c + 1];
    // stations stay on the global grid of the level, so neighbouring pieces sample the vertical curve alike
    for (let s = from; s < to - 1e-6; s = Math.min(to, (Math.floor(s / STEP[lod] + 1e-6) + 1) * STEP[lod])) rows.push(rowAt(info, s));
    rows.push(rowAt(info, to));
    const seg = segmentAt(line, (from + to) / 2);
    runs.push({ rows, fx: line.fx[seg], fz: line.fz[seg], heading: headingByte(Math.atan2(line.fx[seg], line.fz[seg])) });
  }
  return runs;
}

// ------------------------------------------------------------------------------------------------ builder

/**
 * Build the chunks of a bridge whose start station lies in range = [from, to) (default: the whole bridge).
 * level 0 near, 1 mid, 2 far. The mesh and the collider are relative to `origin` (x, z; heights are absolute), the
 * lights and glows are in world coordinates. The collider exists at level 0 only: the deck, the kerbs as short
 * ramps, the walkways, a solid wall 0.3 m thick and 1.05 m high along both edges, and the slopes of the fill.
 */
export function buildBridge(spec, level = 0, { range, origin = [0, 0] } = {}) {
  const info = describeBridge(spec), I = info.internal, { hw, pw, kh, lp, le, seed, railing } = I;
  const lod = clamp(level | 0, 0, 2), ox = origin[0], oz = origin[1];
  const from = range ? range[0] : 0, to = range ? range[1] : info.length;
  const mb = new MeshBuilder(), lights = [], glows = [];
  const wallH = lod === 2 ? (railing === 'rail' ? 0.3 : railing === 'deco' ? 1.0 : 0.8) : railing === 'deco' ? 0.22 : railing === 'rail' ? 0.3 : 0.8;
  const weather = clamp(Math.round(I.age * 0.8), 0, 255), seedByte = seed & 255, ext = info.halfExtent;
  const stone = railing === 'deco' ? TINT.decoStone : TINT.concrete;
  const paint = {
    deck: () => mb.family(FAMILY.GROUND).material(GROUND.DECK, hw * 10, I.code, BAY).color(1, 1, 1).occlusion(1),
    road: () => mb.family(FAMILY.GROUND).material(GROUND.ASPHALT, hw * 10, I.code | LANE_FLAG.OPEN_SHOULDER, I.age).color(1, 1, 1).occlusion(1),
    kerb: (h) => mb.family(FAMILY.GROUND).material(GROUND.KERB, 0, 0, h).color(1, 1, 1).occlusion(1),
    walk: (h) => mb.family(FAMILY.GROUND).material(GROUND.SIDEWALK, 0, 0, h).color(1, 1, 1).occlusion(1),
    grass: (h) => mb.family(FAMILY.GROUND).material(GROUND.GRASS, 1, 0, h).color(1, 1, 1).occlusion(1),
    wall: (shade = 1) => mb.family(FAMILY.SOLID).material(SOLID.CONCRETE, 40, weather, seedByte).color(stone[0] * shade, stone[1] * shade, stone[2] * shade).occlusion(1),
    concrete: (occ = 1) => mb.family(FAMILY.SOLID).material(SOLID.CONCRETE, 0, weather, seedByte).color(TINT.pier).occlusion(occ),
    rock: () => mb.family(FAMILY.SOLID).material(SOLID.ROCK, 80, 5, seedByte).color(TINT.rock).occlusion(1),
    steel: () => mb.family(FAMILY.SOLID).material(SOLID.METAL_BARE, 120, 2, seedByte).color(TINT.steel).occlusion(1),
    rail: () => mb.family(FAMILY.SOLID).material(SOLID.METAL_PAINTED, 110, 50, seedByte).color(railing === 'deco' ? TINT.decoRail : TINT.pole).occlusion(1),
    lens: (kind) => mb.family(FAMILY.SOLID).material(SOLID.LAMP_LENS, radianceCode(LAMP[kind].radiance), CHANNEL.STREET, seedByte).color(LAMP[kind].tint).occlusion(1),
  };

  /**
   * Ribbon between two points of the cross-section, a(row) and b(row) -> [lateral, y], along a run. It faces the
   * side given by (b - a) x direction of travel: up for a to b running left to right. uv: 1 road (lateral,
   * station), 2 other ground (no blend), 0 solid (metres).
   */
  /**
   * The street that meets the bridge is kerbed: gutter pans, perhaps parking, so its lanes are narrower than the
   * open-shoulder lanes up here and its lines sit further in. Over the first and last LANE_TAPER metres the lateral
   * coordinate the shader reads is stretched by the ratio of the two lane widths, which puts every line of the
   * bridge exactly on the street's at the ends and lets them run out to their own places in between. Roads with
   * a median keep their lane width whatever the edge, so there is nothing to scale.
   */
  const street = laneLayout(hw, I.code), ratio = I.code & LANE_FLAG.MEDIAN ? 1 : info.layout.laneWidth / street.laneWidth;
  const laneSqueeze = (s) => 1 + (ratio - 1) * (1 - smoothstep(0, LANE_TAPER, Math.min(s, info.length - s)));
  const strip = (run, a, b, uv) => {
    const base = mb.count, rows = run.rows;
    for (const r of rows) {
      const pa = a(r), pb = b(r), dl = pb[0] - pa[0], ax = r.rx * dl, ay = pb[1] - pa[1], az = r.rz * dl;
      let nx = ay * run.fz - az * r.g, ny = az * run.fx - ax * run.fz, nz = ax * r.g - ay * run.fx;
      if (nx * nx + ny * ny + nz * nz < 1e-12) { nx = 0; ny = 1; nz = 0; }
      // uv: 0 = (distance across the strip, station), 1 = (lateral, station) for road surfaces, or four numbers
      // [u at a, v at a, u at b, v at b] with null standing for the station (kerbs and walkways, ARCHITECTURE 5.2)
      const own = Array.isArray(uv), squeeze = uv === 1 ? laneSqueeze(r.s) : 1;
      mb.vertex(r.x + r.rx * pa[0] - ox, pa[1], r.z + r.rz * pa[0] - oz, nx, ny, nz, own ? uv[0] : uv === 1 ? pa[0] * squeeze : 0, own ? uv[1] ?? r.s : r.s);
      mb.vertex(r.x + r.rx * pb[0] - ox, pb[1], r.z + r.rz * pb[0] - oz, nx, ny, nz, own ? uv[2] : uv === 1 ? pb[0] * squeeze : Math.hypot(dl, ay), own ? uv[3] ?? r.s : r.s);
    }
    for (let i = 0; i + 1 < rows.length; i++) { const q = base + 2 * i; mb.quad(q, q + 1, q + 3, q + 2); }
  };

  /**
   * Rock slope between a(row) and b(row). Near, it is cut into stones about a metre across, each a pair of flat
   * facets pushed in or out of the slope; further away it is the plain slope. Every vertex is a function of its
   * station and column alone, and the number of columns is the same along the whole bridge (`share` of the longest
   * slope), so the pieces built for neighbouring chunks fit.
   */
  const longestSlope = (info.halfExtent - 0.8 - le) * Math.hypot(1, 1 / DECK.SLOPE);
  const rockPoint = (r, side, a, b, j, cols) => {
    const pa = a(r), pb = b(r), t = j / cols; let l = Math.abs(lerp(pa[0], pb[0], t)), y = lerp(pa[1], pb[1], t);
    const dl = Math.abs(pb[0]) - Math.abs(pa[0]), dy = pb[1] - pa[1], len = Math.hypot(dl, dy);
    if (lod === 0 && j > 0 && len > 0.4) {
      const key = Math.round(r.s * 4), bump = (hash01(seed ^ (side > 0 ? 0x51 : 0x97), key, j) - 0.5) * Math.min(0.38, 0.5 * len);
      const slide = j < cols ? (hash01(seed ^ 0x33, key, j * 2 + (side > 0 ? 0 : 1)) - 0.5) * 0.4 * len / cols : 0;
      l += (-dy * bump + dl * slide) / len; y += (dl * bump + dy * slide) / len;
    }
    return [r.x + r.rx * side * l - ox, y, r.z + r.rz * side * l - oz];
  };
  const rockSlope = (run, side, a, b, share) => {
    const rows = [];
    for (let i = 0; i < run.rows.length; i++) {
      // stones are smaller than the station step of the deck: add the rows in between
      if (i && lod === 0) { const s0 = run.rows[i - 1].s, s1 = run.rows[i].s, n = Math.round((s1 - s0) / ROCK_SIZE); for (let k = 1; k < n; k++) rows.push(rowAt(info, lerp(s0, s1, k / n))); }
      rows.push(run.rows[i]);
    }
    const cols = lod === 0 ? clamp(Math.round(share * longestSlope / ROCK_SIZE), 1, 10) : lod === 1 ? 2 : 1;
    const grid = rows.map((r) => { const line = []; for (let j = 0; j <= cols; j++) line.push(rockPoint(r, side, a, b, j, cols)); return line; });
    const out = place(frameAt(rows[0].x - ox, rows[0].z - oz, Math.atan2(run.fx, run.fz)), 0, -40, 0);
    for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j < cols; j++) {
      const p = grid[i][j], q = grid[i][j + 1], u = grid[i + 1][j + 1], v = grid[i + 1][j];
      if (lod > 0) { quadAwayFrom(mb, p, q, u, v, out[0], out[1], out[2]); continue; }
      // two facets per stone, split along either diagonal
      const flip = hashInts(seed, Math.round(rows[i].s * 4), j * 2 + (side > 0 ? 0 : 1)) & 1;
      for (const [c0, c1, c2] of flip ? [[p, q, v], [q, u, v]] : [[p, q, u], [p, u, v]]) {
        const ux = c1[0] - c0[0], uy = c1[1] - c0[1], uz = c1[2] - c0[2], vx = c2[0] - c0[0], vy = c2[1] - c0[1], vz = c2[2] - c0[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const up = side > 0 ? 1 : -1;
        nx *= up; ny *= up; nz *= up;
        const i0 = mb.vertex(c0[0], c0[1], c0[2], nx, ny, nz, j * ROCK_SIZE, rows[i].s), i1 = mb.vertex(c1[0], c1[1], c1[2], nx, ny, nz, j * ROCK_SIZE + 1, rows[i].s), i2 = mb.vertex(c2[0], c2[1], c2[2], nx, ny, nz, j * ROCK_SIZE, rows[i].s + 1);
        if (side > 0) mb.tri(i0, i1, i2); else mb.tri(i0, i2, i1);
      }
    }
  };

  const sweepRun = (run, support) => {
    const span = support === 'span', far = lod === 2;
    (span ? paint.deck : paint.road)();
    strip(run, (r) => [-hw, r.y], (r) => [hw, r.y], 1);
    for (const side of [1, -1]) {
      const P = (l, h) => (r) => [side * l, r.y + h];
      const edge = (a, b, uv) => (side > 0 ? strip(run, a, b, uv) : strip(run, b, a, uv));
      // a box section of the railing: inner face, top, outer face, underside
      const beam = (l0, l1, h0, h1) => { edge(P(l0, h0), P(l0, h1), 0); edge(P(l0, h1), P(l1, h1), 0); edge(P(l1, h1), P(l1, h0), 0); edge(P(l1, h0), P(l0, h0), 0); };
      if (pw > 0) {
        // kerb: face then top, u across the profile; walkway: metres to the kerb line and to the parapet
        const kerbUv = (u0, u1) => (side > 0 ? [u0, null, u1, null] : [u1, null, u0, null]);
        const walkFrom = far ? hw : hw + DECK.KERB_TOP, walkUv = side > 0 ? [0, lp - walkFrom, lp - walkFrom, 0] : [lp - walkFrom, 0, 0, lp - walkFrom];
        if (!far) { paint.kerb(run.heading); edge(P(hw, 0), P(hw, kh), kerbUv(0, KERB.CHAMFER)); edge(P(hw, kh), P(hw + DECK.KERB_TOP, kh), kerbUv(KERB.CHAMFER, KERB.BACK)); }
        // far away the kerb is only the inner edge of a walkway that tips down to the road
        paint.walk(run.heading); edge(far ? P(hw, 0) : P(walkFrom, kh), P(lp, kh), walkUv);
      } else { paint.concrete(); edge(P(hw, 0), P(lp, 0), 0); }
      paint.wall();
      edge(P(lp, kh), P(lp, kh + wallH), 0); edge(P(lp, kh + wallH), P(le, kh + wallH), 0);
      edge(P(le, kh + wallH), span ? P(le, far ? -DECK.GIRDER : -DECK.SLAB) : (r) => [side * le, r.top], 0);
      if (!far) {
        if (railing === 'parapet') { paint.steel(); beam(lp + 0.11, lp + 0.19, kh + 0.97, kh + 1.05); }
        else if (railing === 'rail') { paint.rail(); beam(lp + 0.12, lp + 0.18, kh + 0.66, kh + 0.72); beam(lp + 0.11, lp + 0.19, kh + 1.03, kh + 1.10); }
        else {
          paint.wall(); beam(lp, le, kh + 0.84, kh + 1.0);
          // beyond the near level the balusters are one shaded panel
          if (lod === 1) { paint.wall(0.62); edge(P(lp + 0.1, kh + 0.22), P(lp + 0.1, kh + 0.84), 0); edge(P(le - 0.1, kh + 0.84), P(le - 0.1, kh + 0.22), 0); }
        }
      }
      if (span) continue;
      const top = (r) => [side * le, r.top], toe = (r) => [side * r.toe, r.floor];
      if (support === 'fill') { paint.rock(); rockSlope(run, side, top, toe, 1); continue; }
      if (support === 'embankment') {
        // grass bank with a rock toe
        const mid = (r) => [side * lerp(le, r.toe, 0.55), lerp(r.top, r.floor, 0.55)];
        paint.grass(run.heading); edge(top, mid, NO_BLEND);
        paint.rock(); rockSlope(run, side, mid, toe, 0.45);
      }
      const rim = (r) => [side * Math.max(r.toe, ext), r.floor];
      paint.grass(run.heading); edge(toe, rim, NO_BLEND);
      paint.concrete(); edge(rim, (r) => [side * Math.max(r.toe, ext), r.floor - DECK.SKIRT], 0);
    }
    if (!span) return;
    // underside: slab soffit with girders near, a plain box further away
    const U = (l, h) => (r) => [l, r.y - h], web = le - 0.6;
    paint.concrete(0.6);
    if (lod === 2) { strip(run, U(le, DECK.GIRDER), U(-le, DECK.GIRDER), 0); return; }
    if (lod === 1) {
      strip(run, U(le, DECK.SLAB), U(web, DECK.SLAB), 0); strip(run, U(web, DECK.SLAB), U(web, DECK.GIRDER), 0); strip(run, U(web, DECK.GIRDER), U(-web, DECK.GIRDER), 0);
      strip(run, U(-web, DECK.GIRDER), U(-web, DECK.SLAB), 0); strip(run, U(-web, DECK.SLAB), U(-le, DECK.SLAB), 0);
      return;
    }
    strip(run, U(le, DECK.SLAB), U(-le, DECK.SLAB), 0);
    const girders = Math.max(2, Math.round((2 * web - 0.5) / 2.6) + 1);
    paint.concrete(0.75);
    for (let g = 0; g < girders; g++) {
      const c = lerp(-(web - 0.25), web - 0.25, g / (girders - 1));
      strip(run, U(c + 0.25, DECK.SLAB), U(c + 0.25, DECK.GIRDER), 0); strip(run, U(c + 0.25, DECK.GIRDER), U(c - 0.25, DECK.GIRDER), 0); strip(run, U(c - 0.25, DECK.GIRDER), U(c - 0.25, DECK.SLAB), 0);
    }
  };

  /** Upright frame on the walkway at station s (mesh coordinates). */
  const standAt = (s) => { const f = info.frame(s); return frameAt(f.x - ox, f.z - oz, f.yaw, f.y + kh); };

  /** Posts, balusters and pillars of the railing: everything that is not swept along the deck. */
  const railingPieces = (k) => {
    if (lod === 2) return;
    const a = I.startOf(k), b = I.endOf(k);
    const each = (pitch, fn) => { for (let s = Math.ceil(a / pitch - 1e-6) * pitch; s < b - 1e-6; s += pitch) if (s > 0.6 && s < info.length - 0.6) fn(s); };
    for (const side of [1, -1]) {
      const span = (l0, l1) => (side > 0 ? [l0, l1] : [-l1, -l0]);
      if (railing === 'parapet' && lod === 0) { paint.steel(); each(2, (s) => { const [l0, l1] = span(lp + 0.12, lp + 0.18); box(mb, standAt(s), l0, l1, 0.8, 0.97, -0.03, 0.03, 'tb'); }); }
      if (railing === 'rail') { paint.rail(); each(lod === 0 ? 2 : 4, (s) => { const [l0, l1] = span(lp + 0.11, lp + 0.19); box(mb, standAt(s), l0, l1, 0.3, 1.03, -0.04, 0.04, 'tb'); }); }
      if (railing === 'deco') {
        paint.wall();
        each(4, (s) => {
          const B = standAt(s), [l0, l1] = span(lp - 0.05, le + 0.05);
          box(mb, B, l0, l1, 0, 1.1, -0.2, 0.2, 'b');
          if (lod === 0) { const [c0, c1] = span(lp - 0.09, le + 0.09); box(mb, B, c0, c1, 1.1, 1.16, -0.24, 0.24); }
        });
        if (lod === 0) { paint.rail(); each(0.5, (s) => { if (Math.abs(s / 4 - Math.round(s / 4)) < 1e-6) return; const [l0, l1] = span(lp + 0.09, le - 0.09); box(mb, standAt(s), l0, l1, 0.22, 0.84, -0.055, 0.055, 'tb'); }); }
      }
      // a pillar closes each end of the wall
      paint.wall();
      for (const s of [0.3, info.length - 0.3]) if (s >= a && s < b) { const [l0, l1] = span(lp - 0.1, le + 0.1); box(mb, standAt(s), l0, l1, 0, 1.25, -0.3, 0.3, 'b'); }
    }
  };

  /** Pier under the joint at station s: cap beam on columns and a pile cap, or a pile bent where the deck is low. */
  const pier = (s) => {
    const f = info.frame(s), B = frameAt(f.x - ox, f.z - oz, f.yaw), seat = f.y - DECK.GIRDER, under = Math.max(seat - 0.9, 0.1);
    const n = lod === 0 ? 8 : lod === 1 ? 6 : 4, count = hw > 8 ? 3 : 2, reach = le - 1.7;
    paint.concrete(0.85);
    box(mb, B, -(le - 0.5), le - 0.5, under, seat, -0.7, 0.7);
    if (under >= 1.4) {
      for (let c = 0; c < count; c++) column(mb, B, lerp(-reach, reach, c / (count - 1)), 0, 0.6, under, 0.55, 0.55, n);
      box(mb, B, -(le - 0.9), le - 0.9, -0.6, 0.6, -1.7, 1.7, lod === 2 ? 'b' : '');
      if (lod === 0) for (let c = 0; c < count; c++) for (const along of [-1, 1]) column(mb, B, lerp(-reach, reach, c / (count - 1)), along, -3.2, -0.6, 0.35, 0.35, 6);
    } else {
      const piles = count + 2;
      for (let c = 0; c < piles; c++) column(mb, B, lerp(-(le - 1.1), le - 1.1, c / (piles - 1)), 0, lod === 2 ? -0.5 : -3.2, under, 0.4, 0.4, n);
    }
  };

  /** Abutment where a run of spans meets the fill at station s; `dir` points into the span. */
  const abutment = (s, dir) => {
    const r = rowAt(info, s), f = info.frame(s + dir * 0.01), B = frameAt(r.x - ox, r.z - oz, f.yaw);
    paint.concrete(0.9);
    box(mb, B, -le, le, r.floor, r.y - DECK.GIRDER, 0, 1.4 * dir, 'b');
    // the retaining wall that holds the end of the fill, seen between and beside the girders
    const out = place(B, 0, r.y, -dir * 5);
    quadAwayFrom(mb, place(B, -r.toe, r.floor, 0), place(B, r.toe, r.floor, 0), place(B, le, r.top, 0), place(B, -le, r.top, 0), out[0], out[1], out[2]);
  };

  /** Lamp standard: lens geometry, light and glow in one place (ARCHITECTURE 4.5). */
  const lamp = (at) => {
    const kind = I.lampKind, def = LAMP[kind], B = standAt(at.s), side = at.side, lc = side * (lp + 0.15), n = lod === 0 ? 8 : lod === 1 ? 5 : 3;
    let lens;
    if (kind === 'cobra') {
      const foot = Math.max(wallH + 0.1, 0.5), top = def.height, arm = (d) => lc - side * d;
      if (lod < 2) { paint.wall(); box(mb, B, lc - 0.24, lc + 0.24, 0, foot, -0.24, 0.24, 'b'); }
      mb.family(FAMILY.SOLID).material(SOLID.METAL_BARE, 130, 2, seedByte).color(TINT.steel).occlusion(1);
      column(mb, B, lc, 0, foot, top, 0.11, 0.065, n, lod === 0 ? 't' : '');
      // the arm sweeps up from the pole and levels out over the kerb line
      const path = lod === 2 ? [[0, top - 0.1], [2.6, top + 0.6]] : [[0, top - 0.2], [0.8, top + 0.36], [1.8, top + 0.58], [2.6, top + 0.6]];
      pipe(mb, path.map(([d, h]) => place(B, arm(d), h, 0)), 0.045, lod === 0 ? 6 : 3);
      const l0 = Math.min(arm(2.5), arm(3.3)), l1 = Math.max(arm(2.5), arm(3.3)), under = top + 0.5;
      box(mb, B, l0, l1, under, under + 0.14, -0.16, 0.16, 'b');
      paint.lens(kind);
      quadAwayFrom(mb, place(B, l0, under, -0.16), place(B, l1, under, -0.16), place(B, l1, under, 0.16), place(B, l0, under, 0.16), ...place(B, (l0 + l1) / 2, under + 1, 0));
      lens = place(B, arm(2.9), under - 0.02, 0);
    } else {
      const foot = lod === 2 ? 0 : 1.16, top = def.height;
      paint.rail();
      column(mb, B, lc, 0, foot, top - 0.5, lod === 2 ? 0.1 : 0.07, 0.05, n);
      if (lod === 0) column(mb, B, lc, 0, foot, foot + 0.3, 0.12, 0.075, n);
      if (lod < 2) column(mb, B, lc, 0, top - 0.02, top + 0.2, 0.3, 0.04, n);          // the lantern's roof
      paint.lens(kind);
      column(mb, B, lc, 0, top - 0.5, top - 0.02, 0.16, 0.24, lod === 0 ? 8 : 4, 'b');
      lens = place(B, lc, top - 0.25, 0);
    }
    const wx = lens[0] + ox, wz = lens[2] + oz, spot = kind === 'cobra';
    if (lod < 2) lights.push(wx, lens[1], wz, def.radius, def.source[0] * def.power, def.source[1] * def.power, def.source[2] * def.power, spot ? 1 : 0,
      0, -1, 0, spot ? Math.cos(78 * Math.PI / 180) : -1, spot ? Math.cos(55 * Math.PI / 180) : -1, CHANNEL.STREET, hash01(seed, Math.round(at.s), 3), 0);
    glows.push(wx, lens[1], wz, def.glow, def.source[0] * def.radiance, def.source[1] * def.radiance, def.source[2] * def.radiance, CHANNEL.STREET + 16);
  };

  // ---- collision surface: one sheet over each edge wall and across the deck, welded by position so it has no gaps
  const solid = { positions: [], indices: [], index: new Map() };
  const weld = (x, y, z) => {
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`; let i = solid.index.get(key);
    if (i === undefined) { i = solid.positions.length / 3; solid.positions.push(x, y, z); solid.index.set(key, i); }
    return i;
  };
  /** Collision cross-section, left to right: slope or fascia, wall outer face, wall top, wall inner face, walkway, kerb ramp, road. */
  const solidPoint = (r, span, j) => {
    const side = j < 7 ? -1 : 1, q = j < 7 ? j : 13 - j, wallTop = r.y + kh + DECK.WALL_TOP;
    const p = q === 0 ? (span ? [le, r.y - DECK.GIRDER] : [r.toe, r.floor]) : q === 1 ? [le, r.top] : q === 2 ? [le, wallTop] : q === 3 ? [lp, wallTop]
      : q === 4 ? [lp, r.y + kh] : q === 5 ? [hw + DECK.KERB_TOP, r.y + kh] : [hw, r.y];
    return weld(r.x + r.rx * side * p[0] - ox, p[1], r.z + r.rz * side * p[0] - oz);
  };
  const solidRun = (run, support) => {
    const span = support === 'span', rows = run.rows.map((r) => { const ids = []; for (let j = 0; j < 14; j++) ids.push(solidPoint(r, span, j)); return ids; });
    for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j < 13; j++) {
      const a = rows[i][j], b = rows[i][j + 1], c = rows[i + 1][j + 1], d = rows[i + 1][j];
      if (a !== b && b !== c && c !== a) solid.indices.push(a, b, c);
      if (a !== c && c !== d && d !== a) solid.indices.push(a, c, d);
    }
    // the cut ends of the walls at the two ends of the bridge
    for (const [r, ids, forward] of [[run.rows[0], rows[0], false], [run.rows[run.rows.length - 1], rows[rows.length - 1], true]]) {
      if (r.s > 1e-6 && r.s < info.length - 1e-6) continue;
      for (const [a, b, c, d] of [[1, 2, 3, 4], [9, 10, 11, 12]]) {
        if (forward) solid.indices.push(ids[a], ids[b], ids[c], ids[a], ids[c], ids[d]); else solid.indices.push(ids[a], ids[c], ids[b], ids[a], ids[d], ids[c]);
      }
    }
  };

  for (let k = 0; k < info.chunks; k++) {
    const a = I.startOf(k); if (a < from - 1e-6 || a >= to - 1e-6) continue;
    const support = I.support[k];
    for (const run of chunkRuns(info, k, lod)) { sweepRun(run, support); if (lod === 0) solidRun(run, support); }
    railingPieces(k);
    if (support === 'span') {
      if (info.piers.includes(a)) pier(a);
      if (k > 0 && I.support[k - 1] !== 'span') abutment(a, 1);
      if (k + 1 < info.chunks && I.support[k + 1] !== 'span') abutment(I.endOf(k), -1);
    }
    for (const at of info.lamps) if (at.s >= a && at.s < I.endOf(k)) lamp(at);
  }
  return {
    mesh: mb, lights: new Float32Array(lights), glows: new Float32Array(glows),
    collider: lod === 0 ? { positions: new Float32Array(solid.positions), indices: new Uint32Array(solid.indices) } : null,
    profile: info.y, triangles: mb.triangleCount,
  };
}
