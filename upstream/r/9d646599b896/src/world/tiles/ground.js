// Ground of one tile, meshed from the plan field rather than from clipped polygons.
//
// The field is sampled on a square lattice. Cells whose corners all carry the same surface become quads, and
// runs of such cells collapse into larger fans whose rim keeps every lattice vertex (so there are no T-joints).
// Every other cell is cut into two triangles and each triangle is clipped by the same decision tree that
// `typeOf` applies to a point, using the field's signed distances interpolated linearly: the crossings land on
// the true contour, which is what makes kerbs straight on straight roads and smooth round corners.
//
// Height steps (kerb faces, median faces, sea walls, the pit under a bridge) are closed with vertical faces.
// Each piece knows which of its edges lie on which contour, and the piece on the high side adds the face down
// to the height the low side is known to have; no matching between neighbours is needed.
//
// Near tiles follow design/ROAD_STANDARD.md point 6: the kerb is a stone profile (face, bevel, top) with a station
// along it for the shader's stone joints, it drops at crossings and driveways with the pavement behind it, the
// carriageway has a dished gutter pan, and cells in which a kerb line curves (junction corners) are meshed on a
// lattice four times finer so that the arcs are round. A fine cell shares its extra edge points with its coarse
// neighbours, so no T-joint appears where the two meet.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, GROUND, SOLID } from '../../core/ids.js';
import { PARKING_SPACING_DM, BUS_STOP_SPACING, busStopsOn, busStopPhase } from '../plan/placement.js';
import { edgePoint } from '../plan/network.js';
import { closeSeams } from './seams.js';
import { LANE } from '../roads/lanes.js';
import { hashInts, hash01, hashString, fbm2, noise2 } from '../../core/math.js';
import { TYPE, COVER, Sample, heightOf, LAND_Y, KERB_HEIGHT, KERB_WIDTH, BEACH_SEAWARD, PARK_KINDS, GOLF_BANDS, YARD_BANDS, coverPattern } from '../plan/field.js';

// Slots of a mesher vertex: position, the field scalars the tree cuts by, two pattern values, the height gradient.
const X = 0, Z = 1, LAND = 2, W = 3, G = 4, A = 5, AK = 6, AP = 7, MA = 8, MB = 9, ME = 10, JN = 11, RAISE = 12, LOT = 13, PARK = 14, SB = 15,
  LR = 16, RUN = 17, DS = 18, RB = 19, PG = 20, PY = 21, GX = 22, GZ = 23, DROP = 24, BITS = 25, K = 26;
const FROM_SAMPLE = [[LAND, 'land'], [W, 'w'], [G, 'g'], [A, 'a'], [AK, 'aK'], [AP, 'aP'], [MA, 'mA'], [MB, 'mB'], [ME, 'mE'], [JN, 'jn'], [RAISE, 'raise'], [LOT, 'lot'], [PARK, 'park'], [SB, 'sb'], [LR, 'lr'], [RUN, 'run'], [DS, 'ds']];
// Which contour a clipped vertex lies on.
const ON_SHORE = 1, ON_ROAD = 2, ON_MEDIAN = 4, ON_BRIDGE = 8;

const CELL = [2, 4, 8];                 // lattice step by level
const BLOCK = 16;                       // largest merged fan, metres
const PAVERS_STRIP = 9;                 // downtown: paving this far behind the pavement, planting beyond
const PATTERN_SLOPE = 30;               // metres per unit of the cover pattern, to turn a pattern margin into a distance
const WATER_BED_Y = -3;        // lowest height reported to the physics (design/ARCHITECTURE.md section 9.2)
export const COPING_HEIGHT = 0.45, COPING_WIDTH = 0.4;   // sea-wall parapet; also a collider wall
const SEA_WALL_DROP = 1;
// Kerb stones and what belongs to them (design/ROAD_STANDARD.md point 6), near tiles only.
const CHAMFER = 0.025;                  // bevel of a kerb stone, at 45 degrees
const FACE = KERB_HEIGHT - CHAMFER;      // height of a kerb stone's upright face above the gutter line
const DROPPED = 0.02;                   // height a dropped kerb keeps above the gutter
const DROP_RAMP = 1;                    // metres along the kerb over which it comes down
const DROP_BACK = 1.2;                  // metres of pavement behind a dropped kerb that slope with it
const DROP_FAR = -9;                    // 'no dropped kerb near here'
const PAN_DISH = 0.015;                 // depth of the gutter pan at the kerb face
const CROSSING_DEPTH = 3, CROSSING_BACK = 2.1;   // crosswalk band: depth, and its middle's distance inside the stop line
const CROSSING_LANDING = 2.5;           // a crossing must find the kerb within this distance beyond the leg's own kerb line
const FINE = 4;                         // sub-cells per side of a cell in which a kerb line curves
const CURVED = 0.012;                   // metres by which the road distance may differ from its bilinear estimate
const DRAIN_SPACING = 48, MANHOLE_SPACING = 62;   // metres between storm drains on a kerb, and between covers on a road
const WHEEL_PATH = 0.8;                 // a wheel path's distance from its lane's centre
// How far the grass of each district style is left to the sun (0 watered and mown, 1 never tended), the neglect
// from which the strip along a pavement is worn to dirt, and the vertex tints of kept and of dried grass.
const GRASS_NEGLECT = { mansion_island: 0.05, golf: 0.1, hotel_strip: 0.15, beach_resort: 0.2, artdeco_beach: 0.25, studio_island: 0.3, downtown: 0.3, latin_quarter: 0.5, airport: 0.6, military: 0.6, residential_poor: 0.7, industrial_port: 0.8 };
const WORN_VERGE = 0.6, KEPT = [0.86, 0.92, 0.84], DRIED = [1, 0.8, 0.56];
const BOX_INSIDE = 4.4;                          // metres from a leg's stop bar side of the junction to the yellow box: clear of the crossing
const BUS_BOX_LENGTH = 14, BUS_BOX_WIDTH = 2.8;  // metres: painted bus stop box
const STOP_TEXT_BACK = 5.2, ARROW_BACK = 12;     // metres from the stop bar to the middle of the lettering and of the arrows
const POOL = [];                        // clip vertices, reused between cells and tiles                // a shore edge with a drop above this gets the parapet

/** Pavement style (GROUND.SIDEWALK p0) by district style. */
const SIDEWALK_STYLE = { artdeco_beach: 2, beach_resort: 1, hotel_strip: 1, latin_quarter: 3, mansion_island: 3 };
const headingByte = (yaw) => ((Math.round(yaw / Math.PI * 256) % 256) + 256) % 256;
const blendCode = (id, variant = 0) => id + 1 + 16 * (variant & 15);

/**
 * Middle of the pedestrian crossing over one leg of a controlled junction, or null where the leg has none: an
 * unkerbed, bridge or runway leg, a leg too short for it, or one whose crossing would not reach a kerb at both ends
 * (a leg cut short by a joint can have its stop line where the corner beside it has not formed yet).
 */
function crossingOf(plan, node, leg, S) {
  const { net, field } = plan, e = net.edges[leg.edge], road = net.roads[e.road];
  if (road.runway || road.bridge || !(e.pw > 0) || leg.setback <= 5 || !(node.control === 'signal' || leg.control === 'stop')) return null;
  // The corner arcs may have carried the kerb a little way off the leg's own kerb line by here, but not a lane's width.
  const d = leg.setback - CROSSING_BACK, x = node.x + leg.dx * d, z = node.z + leg.dz * d, reach = e.hw + CROSSING_LANDING;
  for (const side of [-1, 1]) if (!(field.sample(x - leg.dz * reach * side, z + leg.dx * reach * side, S).a > 0)) return null;
  return [x, z];
}

/**
 * Where the kerb is dropped around a tile: the crosswalks of controlled junctions and one driveway per detached lot.
 * Each zone is [x, z, ux, uz, half, lo, hi, both]: origin on the middle of the opening, u along the kerb, half the
 * opening's width, and the range of the distance across (measured along the left normal of u, or to either side of
 * the line when `both`) in which the zone applies.
 */
function dropZones(plan, tx, tz) {
  const { net, data } = plan, tile = data.tile, cx = (tx + 0.5) * tile, cz = (tz + 0.5) * tile, reach = tile * 0.75 + 20, zones = [], S = new Sample();
  for (const node of net.nodes) {
    if (node.kind !== 'junction' || (node.control !== 'signal' && node.control !== 'stop') || Math.abs(node.x - cx) > reach + node.radius || Math.abs(node.z - cz) > reach + node.radius) continue;
    for (const leg of node.legs) {
      const e = net.edges[leg.edge], at = crossingOf(plan, node, leg, S); if (!at) continue;
      zones.push([at[0], at[1], leg.dx, leg.dz, CROSSING_DEPTH / 2 + 0.3, e.hw - 4.5, e.hw + e.pw + 4.5, 1]);
    }
  }
  for (const lot of data.lots) {
    if (Math.abs(lot.x - cx) > reach + lot.depth || Math.abs(lot.z - cz) > reach + lot.depth) continue;
    if (lot.landmark || lot.edge < 0 || lot.width < 9 || lot.attached.left || lot.attached.right || !(net.edges[lot.edge].pw > 0)) continue;
    const hard = lot.cover === COVER.PARKING || lot.cover === COVER.CONCRETE || lot.cover === COVER.GRAVEL, half = hard ? 3 : 1.7;
    const cos = Math.cos(lot.yaw), sin = Math.sin(lot.yaw), along = (lot.seed & 1 ? 1 : -1) * (lot.width / 2 - half - 0.8);
    // The lot's front edge faces the street along its local +Z = (sin, cos); its local +X = (cos, -sin).
    zones.push([lot.x + along * cos + lot.depth / 2 * sin, lot.z - along * sin + lot.depth / 2 * cos, -cos, sin, half, -4, 12, 0]);
  }
  return zones;
}

/**
 * Build the ground of tile (tx, tz). plan: worker-side plan ({ field, data, net, furniture }); markings: the road
 * markings builders; details: the road details builders (painted storm drains and covers), near level only;
 * ironwork(name, x, y, z, yaw, seed) -> boolean: sets a cast-iron prototype ('manhole_a', 'manhole_b',
 * 'drain_grate', 'gutter_inlet') at a world position and says whether the catalogue had it, in which case nothing
 * is painted there. Returns { mesh: MeshBuilder (tile-local), heights: Float32Array | null (near level),
 * cell (heightfield step), boxes: number[] (world-space collider walls, 7 floats each) }.
 */
export function buildGround(plan, tx, tz, level, markings, details = null, ironwork = null) {
  const { field, data, net } = plan, tile = data.tile, ox = tx * tile, oz = tz * tile, cell = CELL[level], n = tile / cell + 1;
  const mb = new MeshBuilder(8192), S = new Sample(), H = { lr: 0, run: 0, ds: 0, w: 0, raise: 0 }, F = [0, 0], boxes = [];
  const edgeData = data.edge, roads = data.roads;

  // ---- lattice: one field sample per point; everything later works from what is stored here
  const L = new Float64Array(n * n * K), type = new Uint8Array(n * n), key = new Float64Array(n * n), yy = new Float32Array(n * n), dd = new Float32Array(n * n);
  const lat = new Float32Array(n * n), st = new Float32Array(n * n), edgeAt = new Int32Array(n * n), nodeAt = new Int32Array(n * n), lotAt = new Int32Array(n * n), parkAt = new Int16Array(n * n), districtAt = new Int16Array(n * n), flat = new Uint8Array(n * n);
  let golf = false, yard = false;
  const detailed = level === 0, zones = detailed ? dropZones(plan, tx, tz) : [];
  /** Dropped-kerb measure at a point: metres inside the nearest opening (negative: metres short of it). */
  const dropAt = (x, z) => {
    let best = DROP_FAR;
    for (const q of zones) {
      const px = x - q[0], pz = z - q[1]; let across = -px * q[3] + pz * q[2]; if (q[7] && across < 0) across = -across;
      if (across < q[5] || across > q[6]) continue;
      const along = px * q[2] + pz * q[3], d = q[4] - (along < 0 ? -along : along);
      if (d > best) best = d;
    }
    return best;
  };
  /** Copy a field sample into the slots of a mesher vertex. */
  const store = (V, o, s) => {
    V[o + X] = s.x; V[o + Z] = s.z; V[o + LAND] = s.land; V[o + W] = s.w; V[o + G] = s.g; V[o + A] = s.a; V[o + AK] = s.aK; V[o + AP] = s.aP; V[o + MA] = s.mA; V[o + MB] = s.mB; V[o + ME] = s.mE;
    V[o + JN] = s.jn; V[o + RAISE] = s.raise; V[o + LOT] = s.lot; V[o + PARK] = s.park; V[o + SB] = s.sb; V[o + LR] = s.lr; V[o + RUN] = s.run; V[o + DS] = s.ds; V[o + RB] = s.lr + s.run;
    V[o + DROP] = zones.length && s.a > -6 && s.a < 14 ? dropAt(s.x, s.z) : DROP_FAR;
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, o = k * K, s = field.sample(ox + i * cell, oz + j * cell, S);
    store(L, o, s);
    let t = s.type; if (level === 2 && t === TYPE.KERB) t = TYPE.PAVEMENT; if (level === 2 && t === TYPE.MEDIAN) t = TYPE.ROAD;
    type[k] = t; lat[k] = s.lat; st[k] = s.st; edgeAt[k] = s.edge; nodeAt[k] = s.node; lotAt[k] = s.lotId >= 0 ? s.lotId : s.lotNear; parkAt[k] = s.parkId; districtAt[k] = s.district;
    if (s.parkId >= 0 && PARK_KINDS[data.parkKind[s.parkId]] === 'golf') golf = true;
    if (s.district >= 0 && data.districtInfo[s.district].cover === COVER.GRAVEL) yard = true;
  }
  if (golf || yard) for (let k = 0; k < n * n; k++) { const o = k * K; if (golf) L[o + PG] = coverPattern(L[o + X], L[o + Z], 5); if (yard) L[o + PY] = coverPattern(L[o + X], L[o + Z], 9); }
  /** What a surface needs to know about its place, read back from a lattice point (same field names as a Sample). */
  const R = { edge: -1, node: -1, lotId: -1, lotNear: -1, parkId: -1, district: -1, sb: 0, aP: 0, ds: 0, run: 0 };
  const at = (k) => { const o = k * K; R.edge = edgeAt[k]; R.node = nodeAt[k]; R.lotId = R.lotNear = lotAt[k]; R.parkId = parkAt[k]; R.district = districtAt[k]; R.sb = L[o + SB]; R.aP = L[o + AP]; R.ds = L[o + DS]; R.run = L[o + RUN]; return R; };
  /** Representative for a piece of type t cut from cell k0: a corner of that type, else the best informed corner. */
  const pick = (k0, t, poly) => {
    const c = [k0, k0 + 1, k0 + n, k0 + n + 1];
    for (const k of c) if (type[k] === t) return at(k);
    if (t === TYPE.PARK) {
      // A sliver of a park none of whose corners is in the park: ask the field at its middle.
      let x = 0, z = 0; for (const v of poly) { x += v[X]; z += v[Z]; }
      const s = field.sample(x / poly.length, z / poly.length, S); at(k0); R.parkId = s.parkId; R.district = s.district; return R;
    }
    if (t === TYPE.JUNCTION) for (const k of c) if (nodeAt[k] >= 0 && L[k * K + JN] > -4) return at(k);
    if (t === TYPE.LOT) { let best = c[0]; for (const k of c) if (L[k * K + LOT] < L[best * K + LOT]) best = k; return at(best); }
    let best = c[0]; for (const k of c) if (L[k * K + A] < L[best * K + A]) best = k;
    return at(best);
  };

  // ---- surfaces
  const M = { family: 0, id: 0, p0: 0, p1: 0, p2: 0, blend: -1, scale: 1, offset: 0, road: false, weightless: false, walk: false, wall: false, bevel: false, neglect: -1 };
  const districtStyle = (s) => (s.district >= 0 ? data.districtInfo[s.district].style : 'beach_resort');
  const roadHeading = (s) => { if (s.edge < 0) return 0; const g = edgeData.seg0[s.edge] + (edgeData.segN[s.edge] >> 1); return headingByte(Math.atan2(data.seg.dx[g], data.seg.dz[g])); };
  // Asphalt age per road, hashed from the road's name so that all numbered parts of one road were laid together:
  // main roads are resurfaced most often (110..170), streets less (120..190), lanes hardly ever (170..230). The same
  // byte goes to every marking painted on that road, so paint wear shows the matching asphalt through it.
  const roadAge = (road) => { const base = road.planClass === 'lane' ? 170 : road.hw < 8 ? 120 : 110; return base + (hashString(road.id.replace(/_\d+$/, '')) % 61); };
  // A junction is surfaced as its widest road throughout, so that no seam runs across it.
  const nodeRoad = new Map();
  const roadOfNode = (node) => {
    if (!nodeRoad.has(node)) { let best = -1; for (const leg of net.nodes[node].legs) { const r = net.edges[leg.edge].road; if (best < 0 || roads[r].hw > roads[best].hw || (roads[r].hw === roads[best].hw && r < best)) best = r; } nodeRoad.set(node, best); }
    return nodeRoad.get(node);
  };
  const set = (family, id, p0 = 0, p1 = 0, p2 = 0) => {
    M.family = family; M.id = id; M.p0 = p0; M.p1 = p1; M.p2 = p2; M.blend = -1; M.scale = 1; M.offset = 0; M.road = false; M.weightless = false; M.wall = false; M.neglect = -1;
    // Paved walking surfaces carry (distance to the kerb line, distance to the building line) for the shader's dirt.
    M.walk = family === FAMILY.GROUND && (id === GROUND.SIDEWALK || id === GROUND.PAVERS);
  };
  const blend = (slot, scale = 1, offset = 0) => { M.blend = slot; M.scale = scale; M.offset = offset; };
  const neglectOf = (s) => GRASS_NEGLECT[districtStyle(s)] ?? 0.4;
  const grass = (s, variant) => {
    const neglect = neglectOf(s);
    // Grass creeps over whichever is nearer: sand, or the back edge of the pavement. Where nobody tends it, feet
    // and tyres have worn the strip along the pavement down to the dirt instead.
    if (s.sb < s.aP) { set(FAMILY.GROUND, GROUND.GRASS, variant, blendCode(GROUND.SAND), roadHeading(s)); blend(SB); }
    else if (neglect >= WORN_VERGE) { set(FAMILY.GROUND, GROUND.GRASS, variant, blendCode(GROUND.DIRT, 0), roadHeading(s)); blend(AP, 2.5); }
    else { set(FAMILY.GROUND, GROUND.GRASS, variant, blendCode(GROUND.SIDEWALK, SIDEWALK_STYLE[districtStyle(s)] || 0), roadHeading(s)); blend(AP, 2.5); }
    M.neglect = neglect;
  };
  /**
   * Vertex tint of unmown and garden grass at a point: a slow drift between watered green and sun-dried straw whose
   * balance follows how the district keeps its grass, and a finer change of tone, so no lawn is one flat colour.
   */
  const grassTint = (x, z) => {
    const dry = Math.min(1, Math.max(0, M.neglect + (fbm2(x / 70, z / 70, 3, 911) - 0.5) * 1.1)), tone = 0.8 + 0.2 * noise2(x / 19, z / 19, 77);
    mb.color(tone * (KEPT[0] + (DRIED[0] - KEPT[0]) * dry), tone * (KEPT[1] + (DRIED[1] - KEPT[1]) * dry), tone * (KEPT[2] + (DRIED[2] - KEPT[2]) * dry));
  };
  const sand = (s) => { set(FAMILY.GROUND, GROUND.SAND, 0, blendCode(GROUND.SIDEWALK, SIDEWALK_STYLE[districtStyle(s)] ?? 1)); blend(AP); };
  const cover = (c, s, yaw) => {
    switch (c) {
      case COVER.PAVING: set(FAMILY.GROUND, GROUND.SIDEWALK, SIDEWALK_STYLE[districtStyle(s)] || 0, 0, yaw); break;
      case COVER.PAVERS: set(FAMILY.GROUND, GROUND.PAVERS, (s.district + 4) % 4, 0, yaw); break;
      case COVER.LAWN: set(FAMILY.GROUND, GROUND.GRASS, 0, 0, yaw); M.neglect = neglectOf(s); break;
      case COVER.ROUGH: set(FAMILY.GROUND, GROUND.GRASS, 1, 0, yaw); M.neglect = neglectOf(s); break;
      case COVER.FAIRWAY: set(FAMILY.GROUND, GROUND.GRASS, 2, 0, yaw); break;
      case COVER.GREEN: set(FAMILY.GROUND, GROUND.GRASS, 3, 0, yaw); break;
      case COVER.PARKING: set(FAMILY.GROUND, GROUND.LOT, 0, PARKING_SPACING_DM, yaw); break;
      case COVER.CONCRETE: set(FAMILY.GROUND, GROUND.LOT, 1, 0, yaw); break;
      case COVER.GRAVEL: set(FAMILY.GROUND, GROUND.LOT, 2, 0, yaw); break;
      case COVER.DIRT: set(FAMILY.GROUND, GROUND.DIRT, 0, 0, 0); break;
      case COVER.TARMAC: set(FAMILY.GROUND, GROUND.TARMAC, 2, 0, yaw); break;
      case COVER.SAND: set(FAMILY.GROUND, GROUND.SAND, 0, 0, 0); break;
      case COVER.ROCK: set(FAMILY.SOLID, SOLID.ROCK); break;
      default: set(FAMILY.GROUND, GROUND.SIDEWALK, 0, 0, yaw);
    }
  };
  /** Band of a banded surface from the pattern values at a point (or -1): the same thresholds the plan's cover uses. */
  const bandOf = (t, s, pg, py, ap) => {
    if (t === TYPE.PARK) return s.parkId >= 0 && PARK_KINDS[data.parkKind[s.parkId]] === 'golf' ? (pg < GOLF_BANDS.bunker ? 0 : pg < GOLF_BANDS.fairway ? 1 : pg < GOLF_BANDS.green ? 2 : 3) : -1;
    if (t === TYPE.LAND && s.district >= 0) { const c = data.districtInfo[s.district].cover; if (c === COVER.GRAVEL) return py < YARD_BANDS.dirt ? 0 : py < YARD_BANDS.gravel ? 1 : 2; if (c === COVER.PAVERS) return ap < PAVERS_STRIP ? 0 : 1; }
    return -1;
  };
  /** Fill M for a piece of type t whose representative sample is s. */
  const surface = (t, s, band) => {
    switch (t) {
      case TYPE.ROAD: case TYPE.JUNCTION: {
        const r = t === TYPE.JUNCTION && s.node >= 0 ? roadOfNode(s.node) : edgeData.road[s.edge], road = roads[r];
        if (road.runway) set(FAMILY.GROUND, GROUND.TARMAC, /taxiway/.test(road.id) ? 1 : 0, Math.min(255, Math.round(road.length / 16)), Math.round(road.hw));
        else set(FAMILY.GROUND, GROUND.ASPHALT, Math.min(255, Math.round(road.hw * 10)), road.laneCode, roadAge(road));
        M.road = true; M.weightless = t === TYPE.JUNCTION && !road.runway; break;
      }
      case TYPE.MEDIAN: set(FAMILY.GROUND, GROUND.MEDIAN, 1, 0, roadHeading(s)); break;
      // band: bit 0 = the bevel strip, bit 1 = a dropped stone or the ramp down to one.
      case TYPE.KERB: set(FAMILY.GROUND, GROUND.KERB, 0, band > 0 && band & 2 ? 1 : 0, roadHeading(s)); M.bevel = band > 0 && (band & 1) === 1; break;
      case TYPE.PAVEMENT: {
        const style = SIDEWALK_STYLE[districtStyle(s)] || 0;
        if (s.sb < 3) { set(FAMILY.GROUND, GROUND.SIDEWALK, style, blendCode(GROUND.SAND), roadHeading(s)); blend(SB, 2.5); } else set(FAMILY.GROUND, GROUND.SIDEWALK, style, 0, roadHeading(s));
        // A building line exists where the lot behind is built up to the pavement or paved to it.
        const behind = data.lots[s.lotNear]; M.wall = !!behind && (behind.attached.left || behind.attached.right || behind.cover === COVER.PAVING || behind.cover === COVER.PAVERS);
        break;
      }
      case TYPE.LOT: { const lot = data.lots[s.lotId >= 0 ? s.lotId : s.lotNear]; if (lot) cover(lot.cover, s, headingByte(lot.yaw)); else grass(s, 1); break; }
      case TYPE.PARK: {
        const kind = s.parkId >= 0 ? PARK_KINDS[data.parkKind[s.parkId]] : 'park', yaw = s.parkId >= 0 ? headingByte(data.parkYaw[s.parkId]) : 0;
        if (kind === 'golf') { if (band === 0) cover(COVER.SAND, s, 0); else { set(FAMILY.GROUND, GROUND.GRASS, band, band === 1 ? blendCode(GROUND.SAND) : 0, yaw); if (band === 1) blend(PG, PATTERN_SLOPE, GOLF_BANDS.bunker); } }
        else if (kind === 'parking') cover(COVER.PARKING, s, yaw);
        else if (kind === 'apron') cover(COVER.TARMAC, s, yaw);
        else if (kind === 'runway') set(FAMILY.GROUND, GROUND.TARMAC, 2, 0, yaw);
        else if (kind === 'dock') cover(COVER.CONCRETE, s, yaw);
        else if (kind === 'dirt') { set(FAMILY.GROUND, GROUND.DIRT, 1, blendCode(GROUND.GRASS, 1)); blend(PARK, -1); }
        else grass(s, 0);
        break;
      }
      case TYPE.SAND: sand(s); break;
      case TYPE.FILL: set(FAMILY.GROUND, GROUND.DIRT, 0); break;
      case TYPE.BED:
        // band 1 = the slope down from the land edge; band 0 = the bottom.
        if (band === 1 && s.ds <= -BEACH_SEAWARD && s.run <= 12) set(FAMILY.SOLID, SOLID.ROCK); else sand(s);
        break;
      default: {
        const c = s.district >= 0 ? data.districtInfo[s.district].cover : COVER.ROUGH;
        if (c === COVER.GRAVEL) { if (band === 0) { set(FAMILY.GROUND, GROUND.DIRT, 0, blendCode(GROUND.LOT, 2)); blend(PY, -PATTERN_SLOPE, YARD_BANDS.dirt); } else cover(band === 1 ? COVER.GRAVEL : COVER.CONCRETE, s, headingByte(data.districtInfo[s.district].yaw)); }
        else if (c === COVER.PAVERS) { if (band === 0) cover(COVER.PAVERS, s, roadHeading(s)); else { set(FAMILY.GROUND, GROUND.GRASS, 0, blendCode(GROUND.PAVERS, (s.district + 4) % 4), roadHeading(s)); blend(AP, 1, PAVERS_STRIP); } }
        else grass(s, c === COVER.LAWN ? 0 : 1);
      }
    }
  };
  const keyOfM = (t) => ((((t * 8 + M.family) * 32 + M.id) * 256 + M.p0) * 256 + M.p1) * 256 + M.p2;
  /** Depth of the gutter pan below the road at a carriageway vertex: deepest at the face of a kerb. */
  const pan = (v) => { const kerbed = (v[A] - v[AK]) / KERB_WIDTH, k = 1 + v[A] / LANE.GUTTER; return kerbed > 0 && k > 0 ? PAN_DISH * Math.min(1, kerbed) * Math.min(1, k) : 0; };
  const height = (t, v) => {
    if (t === TYPE.ROAD || t === TYPE.JUNCTION) return detailed ? LAND_Y - pan(v) : LAND_Y;
    H.lr = v[LR]; H.run = v[RUN]; H.ds = v[DS]; H.w = v[W]; H.raise = v[RAISE];
    let y = heightOf(t, H);
    if (!detailed || t === TYPE.MEDIAN || t === TYPE.FILL || t === TYPE.BED || !(v[AK] < v[A])) return y;
    // A dropped kerb, and the pavement that slopes down to it.
    if (v[DROP] > -DROP_RAMP && v[AK] < DROP_BACK && v[RAISE] > DROPPED) y -= (v[RAISE] - DROPPED) * Math.min(1, 1 + v[DROP] / DROP_RAMP) * Math.min(1, 1 - v[AK] / DROP_BACK);
    // The bevel on the front of a kerb stone, never more than half the stone's height.
    if (t === TYPE.KERB && v[A] < CHAMFER) y -= Math.min(CHAMFER, (y - LAND_Y + PAN_DISH) / 2) * (1 - Math.max(0, v[A]) / CHAMFER);
    return y;
  };
  /** uv of a paved walking surface: distance to the kerb line, distance to the building line; 99 where there is none. */
  const walkU = (v) => (v[AK] < v[A] - 1e-6 ? Math.max(0, v[A]) : 99);
  const walkV = (v) => (M.wall ? Math.max(0, -v[AP]) : 99);
  /** u across the kerb profile for a point on the stone's upper surfaces (the roads engineer's stone coordinates). */
  const kerbU = (v) => (v[A] < CHAMFER ? FACE + 0.035 * Math.max(0, v[A]) / CHAMFER : 0.15 + 0.15 * Math.min(1, (v[A] - CHAMFER) / (KERB_WIDTH - CHAMFER)));
  /** Height of the sea side at a shore vertex. */
  const bedHeight = (v) => { if (v[W] <= 0) return -6; H.lr = v[LR]; H.run = v[RUN]; H.ds = v[DS]; H.w = v[W]; return heightOf(TYPE.BED, H); };

  // Second lattice pass: surface key, height and blend distance of every lattice point.
  const view = (k) => L.subarray(k * K, k * K + K);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, o = k * K, t = type[k];
    if (t === TYPE.NONE || (t === TYPE.BED && level === 2)) { type[k] = TYPE.NONE; key[k] = 0; yy[k] = -6; continue; }
    const s = at(k), band = t === TYPE.BED ? (L[o + RB] > 0 ? 1 : 0) : bandOf(t, s, L[o + PG], L[o + PY], L[o + AP]);
    surface(t, s, band);
    key[k] = keyOfM(t) + (band + 1) * 2 ** 48; yy[k] = height(t, view(k));
    dd[k] = M.blend < 0 ? 0 : (L[o + M.blend] - M.offset) * M.scale;
    // Mergeable into a large fan: not a road (its uv bends with it), and no blend edge within reach.
    flat[k] = !M.road && (M.blend < 0 || dd[k] >= 3 || M.id === GROUND.SAND) && !(t === TYPE.MEDIAN) && !(M.walk && L[o + A] < 3) ? 1 : 0;
  }
  // Height gradient on sloping sand and sea bed, for smooth normals.
  const sloped = (k) => type[k] === TYPE.BED || type[k] === TYPE.SAND;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i; if (!sloped(k)) continue;
    const a = i > 0 && sloped(k - 1) ? k - 1 : k, b = i < n - 1 && sloped(k + 1) ? k + 1 : k, c = j > 0 && sloped(k - n) ? k - n : k, d = j < n - 1 && sloped(k + n) ? k + n : k;
    const gx = b > a ? (yy[b] - yy[a]) / ((b - a) * cell) : 0, gz = d > c ? (yy[d] - yy[c]) / ((d - c) / n * cell) : 0;
    L[k * K + GX] = Math.abs(gx) < 0.6 ? gx : 0; L[k * K + GZ] = Math.abs(gz) < 0.6 ? gz : 0;
  }

  // ---- emission
  const put = (x, y, z, v, u0, u1) => mb.vertex(x - ox, y, z - oz, v ? -v[GX] : 0, 1, v ? -v[GZ] : 0, u0, u1);
  const apply = () => { mb.family(M.family).material(M.id, M.p0, M.p1, M.p2).color(1, 1, 1).occlusion(1); };
  /** Vertical face between two points, from the given tops down to the given bottoms, facing (nx, nz). */
  const face = (ax, az, bx, bz, topA, topB, botA, botB, nx, nz, family, id, p2 = 0) => {
    if (topA - botA < 0.004 && topB - botB < 0.004) return;
    mb.family(family).material(id, 0, 0, p2).color(1, 1, 1).occlusion(1);
    const len = Math.hypot(bx - ax, bz - az), a = mb.vertex(ax - ox, topA, az - oz, nx, 0, nz, 0, topA), b = mb.vertex(bx - ox, topB, bz - oz, nx, 0, nz, len, topB), c = mb.vertex(bx - ox, botB, bz - oz, nx, 0, nz, len, botB), d = mb.vertex(ax - ox, botA, az - oz, nx, 0, nz, 0, botA);
    // Counter-clockwise seen from the side the normal points to.
    if ((bz - az) * nx - (bx - ax) * nz > 0) mb.quad(a, b, c, d); else mb.quad(a, d, c, b);
  };
  /** Front face of a kerb stone run between two points, with the stone coordinates (height up the face, station). */
  /**
   * Road vertex alpha and uv. On a road the alpha is the marking weight: full, thinning to a half over the last
   * 8 m before a stop line. Junction cells carry no lane paint (alpha below the shader's 0.12), except along their
   * kerbs: there uv.x is bent to follow the kerb round the fillet (half width minus |uv.x| = distance to the kerb)
   * and the alpha rises to 0.25, which draws the gutter pan only, so the gutter continues round the corner.
   */
  const roadUv = (v, F) => {
    if (!M.weightless) { mb.occlusion(0.5 + 0.5 * Math.min(1, Math.max(0, -v[JN] / 8))); return; }
    const toKerb = -v[A];
    if (toKerb < 3) { F[0] = (F[0] < 0 ? -1 : 1) * Math.max(0, M.p0 / 10 - toKerb); mb.occlusion(0.25 * (1 - Math.max(0, toKerb) / 3)); } else mb.occlusion(0);
  };
  const kerbFace = (u, v, yu, yv, su, sv, nx, nz, dropped) => {
    const bu = LAND_Y - pan(u), bv = LAND_Y - pan(v); if (yu - bu < 0.004 && yv - bv < 0.004) return;
    mb.family(FAMILY.GROUND).material(GROUND.KERB, 0, dropped, M.p2).color(1, 1, 1).occlusion(1);
    // The face stands in the dished gutter, so it is a little taller than the stone's nominal face: u stays within it.
    const up = (h) => Math.min(FACE, h * FACE / (FACE + PAN_DISH));
    const a = mb.vertex(u[X] - ox, yu, u[Z] - oz, nx, 0, nz, up(yu - bu), su), b = mb.vertex(v[X] - ox, yv, v[Z] - oz, nx, 0, nz, up(yv - bv), sv), c = mb.vertex(v[X] - ox, bv, v[Z] - oz, nx, 0, nz, 0, sv), d = mb.vertex(u[X] - ox, bu, u[Z] - oz, nx, 0, nz, 0, su);
    if ((v[Z] - u[Z]) * nx - (v[X] - u[X]) * nz > 0) mb.quad(a, b, c, d); else mb.quad(a, d, c, b);
  };
  const wallsOf = (t, poly, ys) => {
    for (let i = 0; i < poly.length; i++) {
      const u = poly[i], v = poly[(i + 1) % poly.length], bits = u[BITS] & v[BITS]; if (!bits) continue;
      const ex = v[X] - u[X], ez = v[Z] - u[Z], len = Math.hypot(ex, ez); if (len < 1e-4) continue;
      const nx = -ez / len, nz = ex / len, yu = ys[i], yv = ys[(i + 1) % poly.length];
      if (bits & ON_SHORE) {
        const bu = bedHeight(u), bv = bedHeight(v);
        if (t !== TYPE.FILL && yu - bu > SEA_WALL_DROP && yv - bv > SEA_WALL_DROP) {
          // Sea wall with a parapet: no unfenced drop into the water, and a wall for the physics as well.
          const top = Math.max(yu, yv) + COPING_HEIGHT, ix = -nx * COPING_WIDTH, iz = -nz * COPING_WIDTH;
          face(u[X], u[Z], v[X], v[Z], top, top, bu, bv, nx, nz, FAMILY.SOLID, SOLID.CONCRETE);
          face(u[X] + ix, u[Z] + iz, v[X] + ix, v[Z] + iz, top, top, yu, yv, -nx, -nz, FAMILY.SOLID, SOLID.CONCRETE);
          mb.family(FAMILY.SOLID).material(SOLID.CONCRETE);
          const a = put(u[X], top, u[Z], null, 0, 0), b = put(u[X] + ix, top, u[Z] + iz, null, 0, COPING_WIDTH), c = put(v[X] + ix, top, v[Z] + iz, null, len, COPING_WIDTH), d = put(v[X], top, v[Z], null, len, 0);
          mb.quad(a, d, c, b);
          if (level === 0) boxes.push((u[X] + v[X] + ix) / 2, top - (COPING_HEIGHT + 0.3) / 2, (u[Z] + v[Z] + iz) / 2, len / 2 + 0.05, (COPING_HEIGHT + 0.3) / 2, COPING_WIDTH / 2, Math.atan2(-ez, ex));
        } else face(u[X], u[Z], v[X], v[Z], yu, yv, bu, bv, nx, nz, FAMILY.SOLID, SOLID.CONCRETE);
      }
      if (bits & ON_BRIDGE && t !== TYPE.FILL) face(u[X], u[Z], v[X], v[Z], yu, yv, LAND_Y - 0.3, LAND_Y - 0.3, nx, nz, FAMILY.SOLID, SOLID.CONCRETE);
      if ((bits & ON_ROAD && t !== TYPE.ROAD && t !== TYPE.JUNCTION && t !== TYPE.MEDIAN) || (bits & ON_MEDIAN && t === TYPE.MEDIAN)) {
        if (detailed && t === TYPE.KERB) kerbFace(u, v, yu, yv, stations[i], stations[(i + 1) % poly.length], nx, nz, M.p1);
        else if (detailed) {
          // Edgings without a kerb strip of their own (median islands, raised beds) still show stones on the face.
          let su = 0, sv = len;
          if (pieceEdge >= 0) { field.frame(pieceEdge, u[X], u[Z], F); su = F[1]; field.frame(pieceEdge, v[X], v[Z], F); sv = F[1]; }
          kerbFace(u, v, yu, yv, su, sv, nx, nz, 0);
        } else if (level < 2 || yu - LAND_Y > 0.2) face(u[X], u[Z], v[X], v[Z], yu, yv, LAND_Y, LAND_Y, nx, nz, FAMILY.GROUND, GROUND.KERB, M.p2);
      }
    }
  };
  const ys = [], stations = [], MID = new Float64Array(K); let pieceEdge = -1;
  const area2 = (a, b, c) => Math.abs((b[X] - a[X]) * (c[Z] - a[Z]) - (b[Z] - a[Z]) * (c[X] - a[X]));
  /** Emit a convex piece of type t; s is its representative sample, band its pattern band. */
  const emit = (t, poly, s, band) => {
    surface(t, s, band); apply(); pieceEdge = s.edge;
    const slopedPiece = t === TYPE.BED || t === TYPE.SAND, kerb = detailed && t === TYPE.KERB, m = poly.length; ys.length = 0; stations.length = 0;
    // The bevel of a kerb stone is a tilted plane: its normal comes from the piece itself.
    let nx = 0, ny = 1, nz = 0;
    if (kerb && M.bevel) {
      for (let i = 1; i + 1 < m && ny === 1; i++) {
        const a = poly[0], b = poly[i], c = poly[i + 1]; if (area2(a, b, c) < 1e-7) continue;
        const ya = height(t, a), ux = b[X] - a[X], uy = height(t, b) - ya, uz = b[Z] - a[Z], vx = c[X] - a[X], vy = height(t, c) - ya, vz = c[Z] - a[Z];
        let px = uy * vz - uz * vy, py = uz * vx - ux * vz, pz = ux * vy - uy * vx; if (py < 0) { px = -px; py = -py; pz = -pz; }
        const l = Math.hypot(px, py, pz); if (l > 0 && py / l < 0.999) { nx = px / l; ny = py / l; nz = pz / l; }
      }
    }
    const vertex = (v) => {
      const y = height(t, v);
      if (M.road) { field.frame(s.edge, v[X], v[Z], F); roadUv(v, F); return [put(v[X], y, v[Z], null, F[0], F[1]), y, 0]; }
      if (kerb) { field.frame(s.edge, v[X], v[Z], F); return [mb.vertex(v[X] - ox, y, v[Z] - oz, nx, ny, nz, kerbU(v), F[1]), y, F[1]]; }
      const d = M.blend < 0 ? 0 : (v[M.blend] - M.offset) * M.scale;
      if (M.walk) { mb.occlusion(M.p1 ? Math.min(1, Math.max(0, d / 2.5)) : 1); return [put(v[X], y, v[Z], null, walkU(v), walkV(v)), y, 0]; }
      if (M.neglect >= 0) grassTint(v[X], v[Z]);
      return [put(v[X], y, v[Z], slopedPiece ? v : null, d, 0), y, 0];
    };
    const first = mb.count;
    for (const v of poly) { const r = vertex(v); ys.push(r[1]); stations.push(r[2]); }
    // A fan from the first corner, unless points lie along one of its edges (the extra edge points beside a finely
    // meshed cell): then a fan around the middle, which uses every point of the outline.
    let slivers = false;
    for (let i = 1; i + 1 < m && !slivers; i++) if (area2(poly[0], poly[i], poly[i + 1]) <= 1e-5) slivers = true;
    if (slivers && m > 3) {
      for (let q = 0; q < BITS; q++) { let sum = 0; for (const v of poly) sum += v[q]; MID[q] = sum / m; }
      const hub = vertex(MID)[0];
      for (let i = 0; i < m; i++) if (area2(MID, poly[i], poly[(i + 1) % m]) > 1e-7) mb.tri(hub, first + i, first + (i + 1) % m);
    } else for (let i = 1; i + 1 < m; i++) if (area2(poly[0], poly[i], poly[i + 1]) > 1e-5) mb.tri(first, first + i, first + i + 1);
    wallsOf(t, poly, ys);
  };

  // ---- clipping
  // Vertices made while clipping a cell are taken from a pool that is rewound for every cell.
  let poolNext = 0, cellIndex = 0;
  const alloc = () => { if (poolNext === POOL.length) POOL.push(new Float64Array(K)); return POOL[poolNext++]; };
  const lerp = (a, b, t, bit) => { const v = alloc(); for (let i = 0; i < BITS; i++) v[i] = a[i] + (b[i] - a[i]) * t; v[BITS] = (a[BITS] & b[BITS]) | bit; return v; };
  /** Split a convex polygon by slot value < thr (neg) / >= thr (pos). */
  const split = (poly, slot, thr, bit) => {
    let anyNeg = false, anyPos = false;
    for (let i = 0; i < poly.length; i++) { if (poly[i][slot] < thr) anyNeg = true; else anyPos = true; }
    if (!anyNeg) return [null, poly]; if (!anyPos) return [poly, null];
    const neg = [], pos = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], da = a[slot] - thr, db = b[slot] - thr;
      (da < 0 ? neg : pos).push(a);
      if ((da < 0) !== (db < 0)) { const c = lerp(a, b, da / (da - db), bit); neg.push(c); pos.push(c); }
    }
    return [neg, pos];
  };
  /** Last cut of a land piece: the part inside a bridge footprint becomes fill. */
  const finish = (t, poly, band) => {
    const [inside, outside] = split(poly, G, 0, ON_BRIDGE);
    if (inside && inside.length >= 3) emit(TYPE.FILL, inside, pick(cellIndex, TYPE.FILL, inside), -1);
    if (outside && outside.length >= 3) emit(t, outside, pick(cellIndex, t, outside), band);
  };
  const BAND_CUTS = { golf: [PG, [GOLF_BANDS.bunker, GOLF_BANDS.fairway, GOLF_BANDS.green]], yard: [PY, [YARD_BANDS.dirt, YARD_BANDS.gravel]], pavers: [AP, [PAVERS_STRIP]] };
  const banded = (t, poly) => {
    if (!poly || poly.length < 3) return;
    let cuts = null;
    if (t === TYPE.PARK || t === TYPE.LAND) {
      const s = pick(cellIndex, t, poly);
      if (t === TYPE.PARK) { if (s.parkId >= 0 && PARK_KINDS[data.parkKind[s.parkId]] === 'golf') cuts = BAND_CUTS.golf; }
      else if (s.district >= 0) { const c = data.districtInfo[s.district].cover; cuts = c === COVER.GRAVEL ? BAND_CUTS.yard : c === COVER.PAVERS ? BAND_CUTS.pavers : null; }
    }
    if (!cuts) { finish(t, poly, -1); return; }
    let rest = poly;
    for (let b = 0; b < cuts[1].length && rest; b++) { const [below, above] = split(rest, cuts[0], cuts[1][b], 0); if (below && below.length >= 3) finish(t, below, b); rest = above; }
    if (rest && rest.length >= 3) finish(t, rest, cuts[1].length);
  };
  const roadPart = (poly) => {
    if (!poly || poly.length < 3) return;
    const [onRoad, inJunction] = split(poly, JN, 1e-9, 0);
    for (const [t, part] of [[TYPE.JUNCTION, inJunction], [TYPE.ROAD, onRoad]]) {
      if (!part || part.length < 3) continue;
      if (!detailed) { finish(t, part, -1); continue; }
      // The gutter pan is a strip of the carriageway with its own slope: cut along its inner edge.
      const [inner, gutter] = split(part, A, -LANE.GUTTER, 0);
      if (inner && inner.length >= 3) finish(t, inner, -1);
      if (gutter && gutter.length >= 3) finish(t, gutter, -1);
    }
  };
  /** Cut a piece where a dropped kerb's ramp starts and where it is fully down; fn(part, dropped). */
  const dropBands = (poly, fn) => {
    const [full, lowered] = split(poly, DROP, -DROP_RAMP, 0);
    if (full && full.length >= 3) fn(full, 0);
    if (!lowered) return;
    const [ramp, down] = split(lowered, DROP, 0, 0);
    if (ramp && ramp.length >= 3) fn(ramp, 2);
    if (down && down.length >= 3) fn(down, 2);
  };
  /** Kerb stones: bevel strip and top strip, cut at the ends of dropped runs. */
  const kerbPart = (poly) => dropBands(poly, (part, dropped) => {
    const [bevel, top] = split(part, A, CHAMFER, 0);
    if (bevel && bevel.length >= 3) finish(TYPE.KERB, bevel, dropped + 1);
    if (top && top.length >= 3) finish(TYPE.KERB, top, dropped);
  });
  const SIDE_CUTS = [[AP, TYPE.PAVEMENT], [LOT, TYPE.LOT], [PARK, TYPE.PARK], [SB, TYPE.SAND]];
  const sidePart = (poly) => {
    let rest = poly;
    for (let q = 0; q < SIDE_CUTS.length; q++) {
      if (!rest) return;
      const [inside, beyond] = split(rest, SIDE_CUTS[q][0], 0, 0); banded(SIDE_CUTS[q][1], inside); rest = beyond;
    }
    banded(TYPE.LAND, rest);
  };
  /** Mesh one convex outline of lattice points (a triangle, possibly with extra points along its edges). */
  const triangle = (outline) => {
    const [sea, land] = split(outline, LAND, 0, ON_SHORE);
    if (sea && level < 2) {
      const [, bed] = split(sea, W, 1e-9, 0);
      if (bed && bed.length >= 3) { const [bottom, slope] = split(bed, RB, 1e-9, 0); if (bottom && bottom.length >= 3) emit(TYPE.BED, bottom, pick(cellIndex, TYPE.BED, bottom), 0); if (slope && slope.length >= 3) emit(TYPE.BED, slope, pick(cellIndex, TYPE.BED, slope), 1); }
    }
    if (!land || land.length < 3) return;
    const [road, side] = split(land, A, 0, ON_ROAD);
    if (road) {
      if (level === 2) roadPart(road);
      else {
        // Median: inside all three of its linear measures. What is cut away on each side stays road.
        const [r1, m1] = split(road, MA, 1e-9, ON_MEDIAN); roadPart(r1);
        const [r2, m2] = m1 ? split(m1, MB, 1e-9, ON_MEDIAN) : [null, null]; roadPart(r2);
        const [r3, median] = m2 ? split(m2, ME, 1e-9, ON_MEDIAN) : [null, null]; roadPart(r3);
        if (median && median.length >= 3) finish(TYPE.MEDIAN, median, -1);
      }
    }
    if (!side) return;
    let rest = side;
    if (level < 2) { const [kerb, beyond] = split(rest, AK, 0, 0); if (kerb && kerb.length >= 3) { if (detailed) kerbPart(kerb); else finish(TYPE.KERB, kerb, -1); } rest = beyond; }
    if (!rest) return;
    // Behind a dropped kerb the ground slopes down to it: that strip is cut out so the slope has its own edges.
    // (Judged from the piece's extremes, not corner by corner: the slope can cross a piece none of whose corners
    // is on it, and the neighbour across that edge would then be cut where this piece is not.)
    let lowered = false;
    if (detailed) { let drop = -Infinity, back = Infinity; for (const v of rest) { if (v[DROP] > drop) drop = v[DROP]; if (v[AK] < back) back = v[AK]; } lowered = drop > -DROP_RAMP && back < DROP_BACK; }
    if (!lowered) { sidePart(rest); return; }
    const [strip, back] = split(rest, AK, DROP_BACK, 0);
    if (strip && strip.length >= 3) dropBands(strip, sidePart);
    if (back && back.length >= 3) sidePart(back);
  };

  // ---- cells: plain quads, merged fans, clipped triangles
  const plain = new Uint8Array((n - 1) * (n - 1));
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const k = j * n + i, q = key[k];
    if (q !== key[k + 1] || q !== key[k + n] || q !== key[k + n + 1]) continue;
    // A raised median narrower than the lattice step can hide between four road corners.
    if (type[k] === TYPE.ROAD && level < 2 && Math.max(L[k * K + ME], L[(k + 1) * K + ME], L[(k + n) * K + ME], L[(k + n + 1) * K + ME]) > -cell && Math.min(Math.abs(lat[k]), Math.abs(lat[k + 1]), Math.abs(lat[k + n]), Math.abs(lat[k + n + 1])) < cell + 1.5) continue;
    if (detailed) {
      const o = [k * K, (k + 1) * K, (k + n) * K, (k + n + 1) * K];
      // The gutter pan and the slope behind a dropped kerb need their cuts even where the surface is all one kind.
      if (type[k] === TYPE.ROAD || type[k] === TYPE.JUNCTION) { if (Math.max(L[o[0] + A], L[o[1] + A], L[o[2] + A], L[o[3] + A]) > -LANE.GUTTER - 0.05) continue; }
      else if (Math.max(L[o[0] + DROP], L[o[1] + DROP], L[o[2] + DROP], L[o[3] + DROP]) > -DROP_RAMP && Math.min(L[o[0] + AK], L[o[1] + AK], L[o[2] + AK], L[o[3] + AK]) < DROP_BACK) continue;
    }
    plain[j * (n - 1) + i] = 1;
  }
  // Cells in which a kerb line curves: the road distance at the middle is not what the corners predict. They are
  // meshed four times finer, and their neighbours are clipped too so that they pick up the extra edge points.
  const fine = new Uint8Array((n - 1) * (n - 1)), fineVertices = new Map();
  if (detailed) {
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const c = j * (n - 1) + i, k = j * n + i; if (plain[c]) continue;
      const o = [k * K, (k + 1) * K, (k + n) * K, (k + n + 1) * K];
      let nearKerb = false; for (const q of o) if (Math.abs(L[q + A]) < cell * 1.5) nearKerb = true;
      if (!nearKerb) continue;
      const s = field.sample(ox + (i + 0.5) * cell, oz + (j + 0.5) * cell, S);
      if (Math.abs(s.a - (L[o[0] + A] + L[o[1] + A] + L[o[2] + A] + L[o[3] + A]) / 4) > CURVED) fine[c] = 1;
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      if (!fine[j * (n - 1) + i]) continue;
      if (i > 0) plain[j * (n - 1) + i - 1] = 0; if (i < n - 2) plain[j * (n - 1) + i + 1] = 0; if (j > 0) plain[(j - 1) * (n - 1) + i] = 0; if (j < n - 2) plain[(j + 1) * (n - 1) + i] = 0;
    }
  }
  const isFine = (i, j) => i >= 0 && j >= 0 && i < n - 1 && j < n - 1 && fine[j * (n - 1) + i] === 1;
  /** Vertex of the fine lattice at (I, J) quarter steps; lattice points proper are copied, the rest sampled once. */
  const fineVertex = (I, J) => {
    const id = J * (n * FINE) + I; let v = fineVertices.get(id); if (v) return v;
    v = new Float64Array(K);
    if (I % FINE === 0 && J % FINE === 0) { const k = (J / FINE) * n + I / FINE; for (let q = 0; q < BITS; q++) v[q] = L[k * K + q]; }
    else {
      store(v, 0, field.sample(ox + I * cell / FINE, oz + J * cell / FINE, S));
      if (golf) v[PG] = coverPattern(v[X], v[Z], 5); if (yard) v[PY] = coverPattern(v[X], v[Z], 9);
    }
    fineVertices.set(id, v); return v;
  };
  const lattice = (k, t, e) => {
    const o = k * K, v = L.subarray(o, o + K);
    if (M.road) {
      if (edgeAt[k] === e) { F[0] = lat[k]; F[1] = st[k]; } else field.frame(e, v[X], v[Z], F);
      roadUv(v, F);
      return put(v[X], yy[k], v[Z], null, F[0], F[1]);
    }
    if (M.walk) { mb.occlusion(M.p1 ? Math.min(1, Math.max(0, dd[k] / 2.5)) : 1); return put(v[X], yy[k], v[Z], null, walkU(v), walkV(v)); }
    if (M.neglect >= 0) grassTint(v[X], v[Z]);
    return put(v[X], yy[k], v[Z], t === TYPE.BED || t === TYPE.SAND ? v : null, dd[k], 0);
  };
  const uniform = (i0, j0, m) => {
    const k0 = j0 * n + i0, q = key[k0];
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) if (!plain[(j0 + j) * (n - 1) + i0 + i]) return false;
    const y00 = yy[k0], y10 = yy[k0 + m], y01 = yy[k0 + m * n], y11 = yy[k0 + m * n + m];
    for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) {
      const k = k0 + j * n + i; if (key[k] !== q || !flat[k]) return false;
      const u = i / m, v = j / m; if (Math.abs(yy[k] - ((y00 * (1 - u) + y10 * u) * (1 - v) + (y01 * (1 - u) + y11 * u) * v)) > 0.02) return false;
    }
    return true;
  };
  const block = (i0, j0, m) => {
    const k0 = j0 * n + i0, t = type[k0];
    if (m === 1 ? plain[j0 * (n - 1) + i0] : uniform(i0, j0, m)) {
      if (t === TYPE.NONE) return;
      const kc = m === 1 ? k0 : k0 + (m >> 1) * n + (m >> 1), s = at(kc), band = t === TYPE.BED ? (L[kc * K + RB] > 0 ? 1 : 0) : bandOf(t, s, L[kc * K + PG], L[kc * K + PY], L[kc * K + AP]);
      surface(t, s, band); apply(); pieceEdge = s.edge;
      if (m === 1) { const a = lattice(k0, t, s.edge), b = lattice(k0 + n, t, s.edge), c = lattice(k0 + n + 1, t, s.edge), d = lattice(k0 + 1, t, s.edge); mb.quad(a, b, c, d); return; }
      // Fan around the centre; the rim keeps every lattice vertex so neighbours of any size meet it exactly.
      const hub = lattice(kc, t, s.edge); let prev = -1, start = -1;
      const rim = (k) => { const v = lattice(k, t, s.edge); if (prev >= 0) mb.tri(hub, prev, v); else start = v; prev = v; };
      for (let j = 0; j < m; j++) rim(k0 + j * n);
      for (let i = 0; i < m; i++) rim(k0 + m * n + i);
      for (let j = m; j > 0; j--) rim(k0 + j * n + m);
      for (let i = m; i > 0; i--) rim(k0 + i);
      mb.tri(hub, prev, start);
      return;
    }
    if (m > 1) { const h = m >> 1; block(i0, j0, h); block(i0 + h, j0, h); block(i0, j0 + h, h); block(i0 + h, j0 + h, h); return; }
    poolNext = 0; cellIndex = k0;
    if (fine[j0 * (n - 1) + i0]) {
      for (let q = 0; q < FINE; q++) for (let p = 0; p < FINE; p++) {
        const I = i0 * FINE + p, J = j0 * FINE + q, a = fineVertex(I, J), b = fineVertex(I, J + 1), c = fineVertex(I + 1, J + 1), d = fineVertex(I + 1, J);
        triangle([a, b, d]); triangle([d, b, c]);
      }
      return;
    }
    const corner = (k) => { const v = alloc(); for (let q = 0; q < BITS; q++) v[q] = L[k * K + q]; v[BITS] = 0; return v; };
    const a = corner(k0), b = corner(k0 + n), c = corner(k0 + n + 1), d = corner(k0 + 1);
    // Outline of the two triangles, with the fine neighbours' edge points where there are any.
    const upper = [a], lower = [d, b], I = i0 * FINE, J = j0 * FINE;
    if (isFine(i0 - 1, j0)) for (let q = 1; q < FINE; q++) upper.push(fineVertex(I, J + q));
    upper.push(b, d);
    if (isFine(i0, j0 - 1)) for (let q = FINE - 1; q > 0; q--) upper.push(fineVertex(I + q, J));
    if (isFine(i0, j0 + 1)) for (let q = 1; q < FINE; q++) lower.push(fineVertex(I + q, J + FINE));
    lower.push(c);
    if (isFine(i0 + 1, j0)) for (let q = FINE - 1; q > 0; q--) lower.push(fineVertex(I + FINE, J + q));
    triangle(upper); triangle(lower);
  };
  const top = BLOCK / cell;
  for (let j = 0; j < n - 1; j += top) for (let i = 0; i < n - 1; i += top) block(i, j, top);
  // Later cuts put points on edges that earlier pieces took as one run: give both sides the same vertices,
  // before any paint is laid over the surface.
  closeSeams(mb);

  // ---- crossings and stop lines at controlled junctions whose centre is in this tile
  if (level < 2 && markings) {
    for (let ni = 0; ni < net.nodes.length; ni++) {
      const node = net.nodes[ni]; if (node.kind !== 'junction' || (node.control !== 'signal' && node.control !== 'stop')) continue;
      for (const leg of node.legs) {
        const e = net.edges[leg.edge], road = net.roads[e.road]; if (road.runway || road.bridge) continue;
        const px = node.x + leg.dx * (leg.setback + 0.45), pz = node.z + leg.dz * (leg.setback + 0.45);
        if (Math.floor(px / tile) !== tx || Math.floor(pz / tile) !== tz) continue;
        const controlled = node.control === 'signal' || leg.control === 'stop';
        const crossing = crossingOf(plan, node, leg, S);
        if (crossing) markings.addCrosswalk(mb, { x: crossing[0] - ox, z: crossing[1] - oz, yaw: Math.atan2(leg.dx, leg.dz), width: 2 * e.hw, depth: CROSSING_DEPTH, y: LAND_Y, style: node.control === 'signal' ? 'zebra' : 'lines', age: roadAge(road) });
        if (!controlled) continue;
        // Approach lanes: those that travel towards the node. Laterals are mirrored when that is against the stations.
        const towards = leg.end === 0 ? -1 : 1; let from = Infinity, to = -Infinity;
        for (const lane of road.lanes.lanes) { if (lane.dir !== towards) continue; from = Math.min(from, lane.offset * towards - lane.width / 2); to = Math.max(to, lane.offset * towards + lane.width / 2); }
        if (to > from) markings.addStopLine(mb, { x: px - ox, z: pz - oz, yaw: Math.atan2(-leg.dx, -leg.dz), from, to, y: LAND_Y, age: roadAge(road) });
        if (level > 0) continue;
        // STOP lettering in every approach lane of a stop-controlled leg; lane arrows where a direction has two
        // lanes or more.
        const approach = road.lanes.lanes.filter((lane) => lane.dir === towards).sort((p, q) => Math.abs(p.offset) - Math.abs(q.offset));
        // Placed along the road's own line, which may bend before the junction.
        const room = e.length - e.setA - e.setB, f = [0, 0, 0, 0];
        const spot = (lane, back) => { const d = leg.setback + 0.45 + back; edgePoint(e, leg.end === 0 ? d : e.length - d, f); return { x: f[0] - f[3] * lane.offset - ox, z: f[1] + f[2] * lane.offset - oz, yaw: Math.atan2(f[2] * towards, f[3] * towards), y: LAND_Y, age: roadAge(road) }; };
        if (leg.control === 'stop' && room > 16) for (const lane of approach) markings.addRoadText(mb, { ...spot(lane, STOP_TEXT_BACK), word: 'STOP' });
        if (approach.length >= 2 && room > 44) approach.forEach((lane, i) => markings.addArrow(mb, { ...spot(lane, ARROW_BACK), kind: i === 0 ? 'straight-left' : i === approach.length - 1 ? 'straight-right' : 'straight' }));
      }
      // A yellow box over the middle of a signalled junction where two roads of two lanes or more each way cross.
      if (node.control !== 'signal' || Math.floor(node.x / tile) !== tx || Math.floor(node.z / tile) !== tz) continue;
      const wide = new Set(), corners = [];
      for (const leg of node.legs) {
        const e = net.edges[leg.edge], road = net.roads[e.road], lanes = road.lanes.lanes;
        if (!road.bridge && Math.min(lanes.filter((lane) => lane.dir > 0).length, lanes.filter((lane) => lane.dir < 0).length) >= 2) wide.add(road.id.replace(/_\d+$/, ''));     // a road keeps its name through its numbered parts
        // Each leg gives the two ends of its mouth, just inside its crossing.
        const back = leg.setback - BOX_INSIDE, half = road.lanes.edge || e.hw - LANE.GUTTER;
        for (const side of [-1, 1]) corners.push([node.x + leg.dx * back - leg.dz * half * side, node.z + leg.dz * back + leg.dx * half * side]);
      }
      if (wide.size < 2) continue;
      corners.sort((p, q) => Math.atan2(p[1] - node.z, p[0] - node.x) - Math.atan2(q[1] - node.z, q[0] - node.x));
      const turns = corners.map((p, i) => { const a = corners[(i + corners.length - 1) % corners.length], b = corners[(i + 1) % corners.length]; return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]); });
      // Only a convex outline is hatched: mouths that overlap at a skewed junction leave none.
      if (turns.every((t) => t > -0.5)) markings.addBoxJunction(mb, { points: corners.map((p) => [p[0] - ox, p[1] - oz]), yaw: Math.atan2(node.legs[0].dx, node.legs[0].dz), y: LAND_Y, age: roadAge(roads[roadOfNode(ni)]) });
    }

    // Bus stop boxes in the kerb lane beside each shelter, by the placement's own rule.
    const f = [0, 0, 0, 0];
    for (const ei of plan.furniture.edgesByTile.get(tx + ',' + tz) || []) {
      const e = net.edges[ei], road = net.roads[e.road]; if (road.bridge || road.runway || !busStopsOn(e)) continue;
      const from = e.setA + 2, to = e.length - e.setB - 2, parking = road.lanes.parking;
      const outer = parking ? parking.outer : e.hw - LANE.GUTTER, width = Math.min(BUS_BOX_WIDTH, parking ? parking.outer - parking.inner : BUS_BOX_WIDTH);
      for (const side of [1, -1]) for (let k = Math.ceil((e.s0 + from - busStopPhase(side)) / BUS_STOP_SPACING); ; k++) {
        const st = k * BUS_STOP_SPACING + busStopPhase(side) - e.s0; if (st > to) break;
        if (st < from + BUS_BOX_LENGTH / 2 || st > to - BUS_BOX_LENGTH / 2) continue;
        edgePoint(e, st, f); const lateral = side * (outer - width / 2), x = f[0] - f[3] * lateral, z = f[1] + f[2] * lateral;
        if (Math.floor(x / tile) !== tx || Math.floor(z / tile) !== tz) continue;
        // The shelter stands only where its spot is pavement; the box follows it.
        const shelter = side * (e.hw + e.pw - 0.95); if (field.sample(f[0] - f[3] * shelter, f[1] + f[2] * shelter, S).type !== TYPE.PAVEMENT) continue;
        markings.addBusStop(mb, { x: x - ox, z: z - oz, yaw: Math.atan2(f[2] * side, f[3] * side), length: BUS_BOX_LENGTH, width, y: LAND_Y, age: roadAge(road) });
      }
    }
  }

  // ---- storm drains in the gutters and covers in the wheel paths, on the roads' own station grids. Cast-iron
  // prototypes where the catalogue has them (`ironwork` returns true); the painted decals otherwise.
  if (detailed && (details || ironwork)) {
    const f = [0, 0, 0, 0], inTile = (x, z) => Math.floor(x / tile) === tx && Math.floor(z / tile) === tz;
    const set = (name, x, z, yaw, seed) => !!ironwork && ironwork(name, x, LAND_Y, z, yaw, seed);
    for (const ei of plan.furniture.edgesByTile.get(tx + ',' + tz) || []) {
      const e = net.edges[ei], road = net.roads[e.road]; if (road.bridge || road.runway) continue;
      const from = e.setA + 3, to = e.length - e.setB - 3;
      const walk = (spacing, phase, fn) => { for (let k = Math.ceil((e.s0 + from - phase) / spacing); ; k++) { const st = k * spacing + phase - e.s0; if (st > to) break; edgePoint(e, st, f); fn(k); } };
      // A road was drained in one campaign: grates in the gutter on side streets, kerb openings on some, and
      // the combination of both on the wide roads that shed the most water.
      const drain = e.hw >= 8 ? ['gutter_inlet', 'drain_grate'] : hashInts(e.road, 75) & 1 ? ['drain_grate'] : ['gutter_inlet'];
      if (e.pw > 0) walk(DRAIN_SPACING, hashInts(e.road, 71) % DRAIN_SPACING, (k) => {
        for (const side of [1, -1]) {
          // The kerb on the right of the direction of travel on that side of the road.
          const x = f[0] - f[3] * side * e.hw, z = f[1] + f[2] * side * e.hw;
          if (!inTile(x, z) || dropAt(x, z) >= -DROP_RAMP - 1) continue;
          const seed = hashInts(ei, k, side + 72), towardsRoad = Math.atan2(f[3] * side, -f[2] * side);
          let cast = true; for (const name of drain) cast = set(name, x, z, towardsRoad, seed) && cast;
          if (!cast && details) details.addStormDrain(mb, { x: x - ox, z: z - oz, yaw: Math.atan2(f[2] * side, f[3] * side), y: LAND_Y - PAN_DISH / 2, seed });
        }
      });
      walk(MANHOLE_SPACING, hashInts(e.road, 73) % MANHOLE_SPACING, (k) => {
        const seed = hashInts(ei, k, 74), lane = road.lanes.lanes[seed % road.lanes.lanes.length]; if (!lane) return;
        const lateral = lane.offset + ((seed >>> 4) & 1 ? WHEEL_PATH : -WHEEL_PATH), x = f[0] - f[3] * lateral, z = f[1] + f[2] * lateral, pick = (seed >>> 8) % 20;
        if (!inTile(x, z)) return;
        // Covers are dropped into their frames any way round.
        if (set(pick < 12 ? 'manhole_a' : 'manhole_b', x, z, hash01(seed, 3) * Math.PI * 2, seed)) return;
        if (details) details.addManhole(mb, { x: x - ox, z: z - oz, y: LAND_Y, yaw: Math.atan2(f[2], f[3]), kind: pick < 12 ? 'round' : pick < 17 ? 'utility' : 'grate', seed });
      });
    }
  }

  // ---- heightfield for the physics: one sample per metre, kerbs become short ramps. Between lattice points
  // the field scalars are interpolated and classified exactly as the clipped mesh is, without new field samples.
  let heights = null;
  if (level === 0) {
    const N = tile, r = cell, v = new Float64Array(K); heights = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const ci = Math.min(n - 2, Math.floor(i / r)), cj = Math.min(n - 2, Math.floor(j / r)), k = cj * n + ci, u = i / r - ci, w = j / r - cj;
      let y;
      if (u === 0 && w === 0) y = yy[k];
      else if (plain[cj * (n - 1) + ci]) y = (yy[k] * (1 - u) + yy[k + 1] * u) * (1 - w) + (yy[k + n] * (1 - u) + yy[k + n + 1] * u) * w;
      else {
        const a = k * K, b = a + K, c = (k + n) * K, d = c + K;
        for (let q = LAND; q < BITS; q++) v[q] = (L[a + q] * (1 - u) + L[b + q] * u) * (1 - w) + (L[c + q] * (1 - u) + L[d + q] * u) * w;
        const t = v[LAND] < 0 ? (v[W] > 0 ? TYPE.BED : TYPE.NONE) : v[G] < 0 ? TYPE.FILL : v[A] < 0 ? (v[MA] > 0 && v[MB] > 0 && v[ME] > 0 ? TYPE.MEDIAN : TYPE.ROAD) : TYPE.LAND;
        y = height(t, v);
      }
      // The physics contract treats the sea as a bed at -3 m; the drawn bed dives deeper only to hide its edge.
      heights[j * (N + 1) + i] = y < WATER_BED_Y ? WATER_BED_Y : y;
    }
  }
  return { mesh: mb, heights, cell: 1, boxes };
}
