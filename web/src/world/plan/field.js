// plan.field: the single source of truth for what is at a point of the city. Everything is derived from signed
// distance fields (to road centre lines, shore lines, lot rectangles and area polygons), never from clipped
// polygons, so the ground mesher, lot placement, the lane graph, physics and the minimap can never disagree
// about where a kerb or a shoreline is. The field is a pure function of plain typed-array data, which lets the
// worker build that data once and the page create an identical field from a copy of it.

import { buildGrid, gridCell, buildPolygonSet, queryPolygonSet } from './geom.js';
import { noise2 } from '../../core/math.js';
import { KERB_RADIUS, MAX_REACH } from './network.js';

export const LAND_Y = 1.2;
export const KERB_HEIGHT = 0.14;
export const KERB_WIDTH = 0.15;
const FAR = 60;                 // value of a distance that is out of reach
const ROAD_REACH = 28;          // road distances are exact up to this far beyond the pavement edge
const DISTRICT_REACH = 48;      // land this close to a district outline belongs to it
const SHORE_REACH = 44;         // shore distances are exact up to this far
const BED_RANGE = 36;           // sea bed is meshed this far out from walls and rocks
export const BEACH_SEAWARD = 30;       // and this far beyond the seaward edge of a beach polygon
const WATERLINE = 18;           // metres inside the seaward edge of a beach polygon where the sand meets still water
const EMBANKMENT = 2.5;         // fill kept beyond the pavement edge where a road without a bridge leaves the land

/** What a point is, as decided by the distance fields. The ground mesher builds one surface per type. */
export const TYPE = Object.freeze({ NONE: 0, BED: 1, ROAD: 2, JUNCTION: 3, MEDIAN: 4, KERB: 5, PAVEMENT: 6, LOT: 7, PARK: 8, SAND: 9, LAND: 10, FILL: 11 });
const KIND_NAMES = ['water', 'water', 'road', 'junction', 'median', 'pavement', 'pavement', 'lot', 'park', 'beach', 'verge', 'verge'];

/** Ground cover classes: the land-use answer of the field, and the palette of the land-cover map. */
export const COVER = Object.freeze({
  WATER: 0, ASPHALT: 1, KERB: 2, PAVING: 3, MEDIAN: 4, SAND: 5, LAWN: 6, ROUGH: 7, FAIRWAY: 8, GREEN: 9, PARKING: 10,
  CONCRETE: 11, GRAVEL: 12, DIRT: 13, PAVERS: 14, TARMAC: 15, ROCK: 16, DECK: 17,
});
export const COVER_NAMES = ['water', 'asphalt', 'kerb', 'paving', 'median', 'sand', 'lawn', 'rough', 'fairway', 'green', 'parking', 'concrete', 'gravel', 'dirt', 'pavers', 'tarmac', 'rock', 'deck'];
/** Covers that count as hard paving in the land-use statistics. */
export const COVER_HARD = [0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1];

/** How each district style covers land that is neither road, lot nor park. */
const STYLE_COVER = {
  downtown: COVER.PAVERS, industrial_port: COVER.GRAVEL, airport: COVER.ROUGH, military: COVER.ROUGH, golf: COVER.ROUGH,
  residential_poor: COVER.ROUGH, latin_quarter: COVER.LAWN, hotel_strip: COVER.LAWN, beach_resort: COVER.LAWN,
  artdeco_beach: COVER.LAWN, mansion_island: COVER.LAWN, studio_island: COVER.LAWN,
};
/** Shore treatment by district style: horizontal run of the slope from land level to the bed (0 = vertical wall). */
const STYLE_SHORE = {
  downtown: 0, industrial_port: 0, hotel_strip: 0, beach_resort: 0, artdeco_beach: 0, studio_island: 0, mansion_island: 0,
  airport: 9, military: 9, residential_poor: 9, latin_quarter: 9, golf: 9,
};
const SHORE_ROCK = 9, SHORE_SAND = 22;
const PARK_KINDS = ['park', 'golf', 'parking', 'apron', 'dock', 'runway', 'dirt'];
export const WATER_KINDS = ['ocean', 'bay', 'canal', 'marina'];

/**
 * Prepare the field data. net: road network; bridges: [{ road (index), halfExtent, length, step, y: Float32Array }];
 * lots: array of lot records (may be empty and replaced later with `setLots`).
 */
export function buildFieldData(layout, net, bridges) {
  const ext = layout.extent, bounds = [ext.minX, ext.minZ, ext.maxX, ext.maxZ];
  // ---- roads
  const E = net.edges.length; let S = 0; for (const e of net.edges) S += e.pts.length / 2 - 1;
  const seg = { ax: new Float64Array(S), az: new Float64Array(S), dx: new Float64Array(S), dz: new Float64Array(S), len: new Float64Array(S), s0: new Float64Array(S), edge: new Int32Array(S) };
  const edge = {
    road: new Int32Array(E), hw: new Float32Array(E), pw: new Float32Array(E), hwA: new Float32Array(E), hwB: new Float32Array(E), pwA: new Float32Array(E), pwB: new Float32Array(E),
    s0: new Float64Array(E), s1: new Float64Array(E), setA: new Float32Array(E), setB: new Float32Array(E), nodeA: new Int32Array(E), nodeB: new Int32Array(E),
    medLo: new Float64Array(E), medHi: new Float64Array(E), medHalf: new Float32Array(E), bridge: new Int32Array(E).fill(-1), seg0: new Int32Array(E), segN: new Int32Array(E),
    partner0: new Int32Array(E + 1), partner: [], partnerR: [],
  };
  const bridgeOfRoad = new Map(bridges.map((b, i) => [b.road, i]));
  let k = 0;
  for (const e of net.edges) {
    const road = net.roads[e.road], i = e.id, n = e.pts.length / 2;
    edge.road[i] = e.road; edge.hw[i] = e.hw; edge.pw[i] = e.pw; edge.s0[i] = e.s0; edge.s1[i] = e.s1; edge.setA[i] = e.setA; edge.setB[i] = e.setB; edge.nodeA[i] = e.a; edge.nodeB[i] = e.b;
    if (bridgeOfRoad.has(e.road) && bridges[bridgeOfRoad.get(e.road)].edge === i) edge.bridge[i] = bridgeOfRoad.get(e.road);
    // Widths taper to the narrower neighbour at a joint so that two roads of different width meet without a step.
    const endWidth = (node, own, key) => {
      if (node.kind !== 'joint') return own;
      const other = net.edges[node.legs.find((l) => l.edge !== i).edge];
      return bridgeOfRoad.has(other.road) || bridgeOfRoad.has(e.road) ? own : Math.min(own, other[key]);
    };
    edge.hwA[i] = endWidth(net.nodes[e.a], e.hw, 'hw'); edge.hwB[i] = endWidth(net.nodes[e.b], e.hw, 'hw');
    edge.pwA[i] = endWidth(net.nodes[e.a], e.pw, 'pw'); edge.pwB[i] = endWidth(net.nodes[e.b], e.pw, 'pw');
    // Raised median: between the junction setbacks, with room for turning traffic and a rounded nose.
    const mh = edge.bridge[i] < 0 ? road.lanes.medianHalf : 0;
    const keepsMedian = (node) => node.kind === 'joint' && node.legs.every((l) => net.roads[net.edges[l.edge].road].lanes.medianHalf > 0 && !bridgeOfRoad.has(net.edges[l.edge].road));
    const lo = e.s0 + (keepsMedian(net.nodes[e.a]) ? -FAR : e.setA + 7), hi = e.s1 - (keepsMedian(net.nodes[e.b]) ? -FAR : e.setB + 7);
    if (mh > 0.3 && hi - lo > 10) { edge.medHalf[i] = mh; edge.medLo[i] = lo + mh; edge.medHi[i] = hi - mh; }
    edge.seg0[i] = k; edge.segN[i] = n - 1;
    for (let j = 0; j + 1 < n; j++, k++) {
      const ax = e.pts[j * 2], az = e.pts[j * 2 + 1], bx = e.pts[j * 2 + 2], bz = e.pts[j * 2 + 3], len = Math.hypot(bx - ax, bz - az) || 1e-6;
      seg.ax[k] = ax; seg.az[k] = az; seg.dx[k] = (bx - ax) / len; seg.dz[k] = (bz - az) / len; seg.len[k] = len; seg.s0[k] = e.st[j]; seg.edge[k] = i;
    }
  }
  // Kerb radius between every pair of legs at a junction: full radius at right angles, none between legs in line.
  // A leg that reaches a joint within a junction's length carries on as the next edge, and the corner it makes with
  // its neighbour may lie beyond that joint, so the edges past such joints round against the other legs as well.
  const partners = net.edges.map(() => []);
  for (const node of net.nodes) {
    if (node.kind !== 'junction') continue;
    const runs = node.legs.map((leg) => {
      const run = [leg.edge]; let e = net.edges[leg.edge], at = net.nodes[leg.end === 0 ? e.b : e.a], gone = e.length;
      while (at.kind === 'joint' && gone < MAX_REACH) {
        const id = e.id, on = at.legs.find((l) => l.edge !== id); if (!on) break;
        e = net.edges[on.edge]; run.push(e.id); gone += e.length; at = net.nodes[on.end === 0 ? e.b : e.a];
      }
      return run;
    });
    node.legs.forEach((mine, p) => node.legs.forEach((o, q) => {
      if (p === q) return;
      const cos = Math.abs(mine.dx * o.dx + mine.dz * o.dz), open = net.edges[mine.edge].pw === 0 || net.edges[o.edge].pw === 0;
      const radius = (open ? 1.6 : 1) * KERB_RADIUS * Math.min(1, (1 - cos) * 2.5);
      for (const a of runs[p]) for (const b of runs[q]) if (a !== b) partners[a].push([b, radius]);
    }));
  }
  for (let i = 0; i < E; i++) {
    edge.partner0[i] = edge.partner.length;
    for (const [other, radius] of partners[i]) { edge.partner.push(other); edge.partnerR.push(radius); }
  }
  edge.partner0[E] = edge.partner.length; edge.partner = Int32Array.from(edge.partner); edge.partnerR = Float32Array.from(edge.partnerR);
  const reachOf = (i) => { const b = edge.bridge[seg.edge[i]], road = edge.hw[seg.edge[i]] + edge.pw[seg.edge[i]] + ROAD_REACH; return b >= 0 ? Math.max(road, bridges[b].halfExtent + 6) : road; };
  const roadGrid = buildGrid(S, (i, o) => {
    const r = reachOf(i), bx = seg.ax[i] + seg.dx[i] * seg.len[i], bz = seg.az[i] + seg.dz[i] * seg.len[i];
    o[0] = Math.min(seg.ax[i], bx) - r; o[1] = Math.min(seg.az[i], bz) - r; o[2] = Math.max(seg.ax[i], bx) + r; o[3] = Math.max(seg.az[i], bz) + r;
  }, bounds, 16);
  const roads = net.roads.map((r) => ({ id: r.id, name: r.name, class: r.class, planClass: r.planClass, hw: r.hw, pw: r.pw, open: r.open, runway: r.runway, laneCode: r.laneCode, speed: r.speedLimitKmh / 3.6, generated: r.generated, length: r.length }));
  const nodes = net.nodes.map((n) => ({ x: n.x, z: n.z, kind: n.kind, control: n.control, radius: n.radius, junction: -1 }));

  // ---- land, beaches, parks, districts
  const land = buildPolygonSet(layout.landmasses.map((l) => l.polygon), bounds, 32, SHORE_REACH);
  const beach = buildPolygonSet(layout.beaches.map((b) => b.polygon), bounds, 32, SHORE_REACH);
  const parks = buildPolygonSet(layout.parks.map((p) => p.polygon), bounds, 32, 24);
  // District outlines are drawn loosely inside the coast: land just outside one belongs to the nearest district.
  const districts = buildPolygonSet(layout.districts.map((d) => d.polygon), bounds, 32, DISTRICT_REACH);
  const q = {};
  // Beach edges that face the sea carry the beach profile; land edges under a beach are not a shore at all.
  beach.flag = new Uint8Array(beach.ax.length);
  for (let i = 0; i < beach.ax.length; i++) beach.flag[i] = queryPolygonSet(land, (beach.ax[i] + beach.bx[i]) / 2, (beach.az[i] + beach.bz[i]) / 2, q) < 0 ? 1 : 0;
  land.flag = new Uint8Array(land.ax.length); land.run = new Float32Array(land.ax.length);
  const parkKind = layout.parks.map((p) => (p.kind === 'park' && /dirt|bare earth/i.test(p.id + ' ' + (p.notes || '')) ? PARK_KINDS.indexOf('dirt') : Math.max(0, PARK_KINDS.indexOf(p.kind))));
  for (let i = 0; i < land.ax.length; i++) {
    const mx = (land.ax[i] + land.bx[i]) / 2, mz = (land.az[i] + land.bz[i]) / 2, ex = land.bx[i] - land.ax[i], ez = land.bz[i] - land.az[i], l = Math.hypot(ex, ez) || 1;
    if (queryPolygonSet(beach, mx, mz, q) >= 0) { land.run[i] = SHORE_SAND; continue; }
    land.flag[i] = 1;
    // Look a little way inland (the layout winds polygons so that the inside is on the left of each edge in x, z).
    let style = null, park = -1;
    for (const side of [1, -1]) {
      const px = mx + side * ez / l * 8, pz = mz - side * ex / l * 8;
      if (queryPolygonSet(land, px, pz, q) < 0) continue;
      let d = queryPolygonSet(districts, px, pz, q); if (d < 0 && q.edge >= 0) d = districts.owner[q.edge];
      style = d >= 0 ? layout.districts[d].style : null; park = queryPolygonSet(parks, px, pz, q); break;
    }
    let run = style && style in STYLE_SHORE ? STYLE_SHORE[style] : SHORE_ROCK;
    if (park >= 0) run = parkKind[park] === PARK_KINDS.indexOf('dock') ? 0 : parkKind[park] <= 1 ? SHORE_ROCK : run;
    // Quiet garden and golf shores get the odd sandy cove instead of rock or wall.
    if ((style === 'golf' || style === 'mansion_island') && noise2(mx / 160, mz / 160, 77) > 0.62) run = SHORE_SAND;
    land.run[i] = run;
  }
  // Pattern heading of each area (parking rows, apron joints): along its longest side.
  const parkYaw = layout.parks.map((p) => {
    let best = 0, yaw = 0;
    p.polygon.forEach((a, i) => { const b = p.polygon[(i + 1) % p.polygon.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > best) { best = l; yaw = Math.atan2(b[0] - a[0], b[1] - a[1]); } });
    return yaw;
  });
  return {
    bounds, seg, edge, roadGrid, roads, nodes, land, beach, parks, parkKind, parkYaw, districts,
    districtInfo: layout.districts.map((d) => ({ id: d.id, name: d.name, gameName: d.name, style: d.style, cover: STYLE_COVER[d.style] ?? COVER.ROUGH, yaw: d.grid ? d.grid.angleDeg * Math.PI / 180 : 0 })),
    bridges, lots: [], lotGrid: null, coast: null,
  };
}

/** Attach the lots (after frontage walking) and their lookup grid. A lot is an oriented rectangle. */
export function setLots(data, lots) {
  data.lots = lots;
  data.lotRect = new Float32Array(lots.length * 6);
  lots.forEach((l, i) => { data.lotRect.set([l.x, l.z, l.width / 2, l.depth / 2, Math.cos(l.yaw), Math.sin(l.yaw)], i * 6); });
  data.lotGrid = buildGrid(lots.length, (i, o) => { const l = lots[i], r = Math.hypot(l.width, l.depth) / 2 + 6; o[0] = l.x - r; o[1] = l.z - r; o[2] = l.x + r; o[3] = l.z + r; }, data.bounds, 32);
}

/**
 * Back beach. Researched beach polygons stop some way short of the sea-front road, and a lawn between a road and
 * a beach is not what a beach town looks like: unbuilt land that is connected to a beach without crossing a road,
 * a lot or a park becomes sand as well, up to a verge beside the pavement. Flood fill on a coarse grid from the
 * beach polygons; the result is stored as a blurred mask that the field samples bilinearly.
 * Call after setLots; `field` must have been created after setLots too.
 */
export function setBackBeach(data, field, beaches) {
  const cell = 8, reach = 220, verge = 7, [bx0, bz0, bx1, bz1] = data.bounds;
  const width = Math.ceil((bx1 - bx0) / cell), height = Math.ceil((bz1 - bz0) / cell), state = new Uint8Array(width * height), S = new Sample();
  // state: 0 unknown, 1 beach (seed), 2 flooded, 3 blocked
  const queue = [];
  for (const b of beaches) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of b.polygon) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    const i0 = Math.max(0, Math.floor((x0 - bx0) / cell)), i1 = Math.min(width - 1, Math.floor((x1 - bx0) / cell)), j0 = Math.max(0, Math.floor((z0 - bz0) / cell)), j1 = Math.min(height - 1, Math.floor((z1 - bz0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * width + i; if (state[k]) continue;
      const s = field.sample(bx0 + (i + 0.5) * cell, bz0 + (j + 0.5) * cell, S);
      if (s.sb < 0 && s.type === TYPE.SAND) { state[k] = 1; queue.push(k, 0); }
    }
  }
  for (let head = 0; head < queue.length; head += 2) {
    const k = queue[head], steps = queue[head + 1], i = k % width, j = (k - i) / width;
    if (steps * cell >= reach) continue;
    for (let n = 0; n < 4; n++) {
      const ni = i + (n === 0 ? 1 : n === 1 ? -1 : 0), nj = j + (n === 2 ? 1 : n === 3 ? -1 : 0); if (ni < 0 || nj < 0 || ni >= width || nj >= height) continue;
      const nk = nj * width + ni; if (state[nk]) continue;
      const s = field.sample(bx0 + (ni + 0.5) * cell, bz0 + (nj + 0.5) * cell, S);
      if (s.type === TYPE.LAND && s.aP > verge && s.lot > 1 && s.park > 1) { state[nk] = 2; queue.push(nk, steps + 1); } else state[nk] = 3;
    }
  }
  // Blur to a 0..255 mask whose 50 % contour is the smooth edge of the sand.
  const mask = new Uint8Array(width * height);
  for (let j = 1; j < height - 1; j++) for (let i = 1; i < width - 1; i++) {
    let sum = 0;
    for (let oj = -1; oj <= 1; oj++) for (let oi = -1; oi <= 1; oi++) { const v = state[(j + oj) * width + i + oi]; sum += (v === 1 || v === 2 ? 1 : 0) * (oi === 0 && oj === 0 ? 4 : oi === 0 || oj === 0 ? 2 : 1); }
    mask[j * width + i] = Math.round(sum / 16 * 255);
  }
  data.backBeach = { mask, width, height, cell, minX: bx0, minZ: bz0 };
}

/** One evaluation of the field. Numeric fields only, reused between calls by the caller. */
export class Sample {
  constructor() {
    this.x = 0; this.z = 0; this.type = 0; this.y = 0;
    this.a = FAR; this.aK = FAR; this.aP = FAR; this.mA = -FAR; this.mB = -FAR; this.mE = -FAR; this.jn = -FAR; this.raise = KERB_HEIGHT;   // roads
    this.edge = -1; this.lat = 0; this.st = 0; this.node = -1;
    this.g = FAR; this.bridge = -1; this.bridgeSt = 0; this.bridgeLat = 0;                                // bridge footprint
    this.land = 0; this.lr = 0; this.run = 0; this.rb = 0; this.w = 0; this.ds = -FAR; this.sb = FAR; this.dsand = FAR;   // shore
    this.lot = FAR; this.lotId = -1; this.lotNear = -1; this.park = FAR; this.parkId = -1; this.district = -1;
  }
}
/** Names of the continuous scalars a mesher may interpolate between samples. */
export const SCALARS = ['a', 'aK', 'aP', 'mA', 'mB', 'mE', 'jn', 'raise', 'g', 'land', 'lr', 'run', 'rb', 'w', 'ds', 'sb', 'dsand', 'lot', 'park'];

/** Sand height across a beach as a function of the distance inland from the still waterline. */
function beachHeight(t) {
  if (t >= 13) return Math.min(LAND_Y + KERB_HEIGHT, 0.9 + (t - 13) * 0.012);   // berm, nearly level
  if (t >= 0) return 0.9 * t / 13;                                              // foreshore, about 7 %
  if (t >= -14.4) return t / 12;                                                // shallows, 1 in 12
  return Math.max(-3, -1.2 + (t + 14.4) * (1.8 / 33.6));                        // easing to 3 m deep at 48 m
}

/** Height of the surface of a given type from the scalars of a sample (or of an interpolated vertex). */
export function heightOf(type, s) {
  switch (type) {
    case TYPE.ROAD: case TYPE.JUNCTION: return LAND_Y;
    case TYPE.MEDIAN: return LAND_Y + KERB_HEIGHT;
    case TYPE.FILL: return LAND_Y - 0.3;
    case TYPE.NONE: return -6;
    case TYPE.BED: {
      const out = -s.lr, wall = -2.5 - 0.5 * Math.min(1, Math.max(0, out) / 30);
      let y = out >= s.run || s.run < 0.5 ? wall : LAND_Y + KERB_HEIGHT + (wall - LAND_Y - KERB_HEIGHT) * Math.max(0, out) / s.run;
      if (s.ds > -BEACH_SEAWARD) {
        // Sand profile from the sea, pulled up to land level over the last metres before the land edge.
        const sand = beachHeight(s.ds - WATERLINE), k = Math.min(1, Math.max(0, out) / 10), ease = k * k * (3 - 2 * k);
        y = Math.max(y, LAND_Y + KERB_HEIGHT + (sand - LAND_Y - KERB_HEIGHT) * ease);
      }
      // The bed dives at its outer edge so that the cut-off is never seen through the water.
      const edgeFade = Math.min(1, Math.max(0, s.w / 6));
      return y - (1 - edgeFade) * 3;
    }
    default: return LAND_Y + s.raise;
  }
}

/** Type of a point from its scalars: the same decision tree the ground mesher applies when it clips cells. */
export function typeOf(s) {
  if (s.g < 0) return s.land >= 0 ? TYPE.FILL : s.w > 0 ? TYPE.BED : TYPE.NONE;
  if (s.land < 0) return s.w > 0 ? TYPE.BED : TYPE.NONE;
  if (s.a < 0) return s.mA > 0 && s.mB > 0 && s.mE > 0 ? TYPE.MEDIAN : s.jn > 0 ? TYPE.JUNCTION : TYPE.ROAD;
  if (s.aK < 0) return TYPE.KERB;
  if (s.aP < 0) return TYPE.PAVEMENT;
  if (s.lot < 0) return TYPE.LOT;
  if (s.park < 0) return TYPE.PARK;
  if (s.sb < 0) return TYPE.SAND;
  return TYPE.LAND;
}

const roundUnion = (a, b, r) => { const u = r - a, v = r - b; return Math.max(r, Math.min(a, b)) - Math.hypot(u > 0 ? u : 0, v > 0 ? v : 0); };

/**
 * Create the field functions from field data.
 * Returns { sample(x, z, out), frame(edge, x, z, out), field(x, z), districtAt(x, z), data }.
 */
export function createField(data) {
  const { seg, edge, roadGrid, land, beach, parks, districts, bridges } = data;
  const q = { dist: 0, edge: -1, dist2: 0, edge2: -1 };
  /** District index at a point: the polygon holding it, else the one whose outline is nearest within reach. */
  const districtOf = (x, z) => { const d = queryPolygonSet(districts, x, z, q); return d >= 0 ? d : q.edge >= 0 ? districts.owner[q.edge] : -1; };
  const partnerRadius = (e1, e2) => { for (let p = edge.partner0[e1]; p < edge.partner0[e1 + 1]; p++) if (edge.partner[p] === e2) return edge.partnerR[p]; return 0; };
  const taper = (i, st, mid, endA, endB) => {
    if (endA !== mid) { const d = st - edge.s0[i]; if (d < 24) return endA + (mid - endA) * (d < 0 ? 0 : d / 24); }
    if (endB !== mid) { const d = edge.s1[i] - st; if (d < 24) return endB + (mid - endB) * (d < 0 ? 0 : d / 24); }
    return mid;
  };

  function sample(x, z, o) {
    o.x = x; o.z = z;
    // ---- roads: nearest three distinct edges by carriageway distance, and the nearest bridge footprint
    let a1 = FAR, e1 = -1, lat1 = 0, st1 = 0, a2 = FAR, e2 = -1, a3 = FAR, e3 = -1;
    let g = FAR, gd = FAR, gb = -1, gSt = 0, gLat = 0;
    const c = gridCell(roadGrid, x, z), items = roadGrid.items;
    for (let p = roadGrid.start[c], end = roadGrid.start[c + 1]; p < end; p++) {
      const i = items[p], px = x - seg.ax[i], pz = z - seg.az[i], dx = seg.dx[i], dz = seg.dz[i], len = seg.len[i];
      const along = px * dx + pz * dz, t = along < 0 ? 0 : along > len ? len : along;
      const qx = px - t * dx, qz = pz - t * dz, d = Math.sqrt(qx * qx + qz * qz), e = seg.edge[i], st = seg.s0[i] + t;
      const side = pz * dx - px * dz < 0 ? -1 : 1;
      const b = edge.bridge[e];
      if (b >= 0) {
        // Bridge footprint: square ends at the bridge's own start and end (the stop lines where it meets a
        // junction), so the planner's road butts against the bridge builder's first section. Every segment is
        // cut by both end planes, or the round cap of the last-but-one would poke past the end.
        const i0 = edge.seg0[e], i1 = i0 + edge.segN[e] - 1, br = bridges[b];
        const beforeA = br.start - ((x - seg.ax[i0]) * seg.dx[i0] + (z - seg.az[i0]) * seg.dz[i0]), afterB = (x - seg.ax[i1]) * seg.dx[i1] + (z - seg.az[i1]) * seg.dz[i1] - seg.len[i1] + br.tail;
        const fd = Math.max(d - br.halfExtent, beforeA, afterB);
        // Near the ends the planes decide for every segment alike: the nearest segment gives station and side.
        if (fd < g || (fd === g && b === gb && d < gd)) { gd = d; g = fd; gb = b; gSt = st - edge.s0[e] - br.start + (i === i0 && along < 0 ? along : i === i1 && along > len ? along - len : 0); gLat = side * d; }
      }
      // A bridge edge is an ordinary road as well: outside the footprint its ends are the legs of its junctions.
      const sd = d - taper(e, st, edge.hw[e], edge.hwA[e], edge.hwB[e]);
      if (e === e1) { if (sd < a1) { a1 = sd; lat1 = side * d; st1 = st; } }
      else if (sd < a1) { if (e === e2) { a2 = a1; e2 = e1; } else { if (e1 !== e3) { a3 = a2; e3 = e2; } a2 = a1; e2 = e1; } a1 = sd; e1 = e; lat1 = side * d; st1 = st; }
      else if (e === e2) { if (sd < a2) a2 = sd; }
      else if (sd < a2) { if (e !== e3) { a3 = a2; e3 = e2; } else { a3 = FAR; e3 = -1; } a2 = sd; e2 = e; }
      else if (e === e3) { if (sd < a3) a3 = sd; }
      else if (sd < a3) { a3 = sd; e3 = e; }
    }
    let a = a1;
    if (e2 >= 0 && a2 < 2 * KERB_RADIUS) {
      let r = partnerRadius(e1, e2); if (r > 0) a = Math.min(a, roundUnion(a1, a2, r));
      if (e3 >= 0 && a3 < 2 * KERB_RADIUS) {
        r = partnerRadius(e1, e3); if (r > 0) a = Math.min(a, roundUnion(a1, a3, r));
        r = partnerRadius(e2, e3); if (r > 0) a = Math.min(a, roundUnion(a2, a3, r));
      }
    }
    o.edge = e1; o.lat = lat1; o.st = st1; o.g = g; o.bridge = gb; o.bridgeSt = gSt; o.bridgeLat = gLat;
    if (e1 >= 0) {
      const pw = taper(e1, st1, edge.pw[e1], edge.pwA[e1], edge.pwB[e1]), kerbed = pw > 0 ? Math.min(1, pw / 1.5) : 0;
      o.a = a; o.aK = a - KERB_WIDTH * kerbed; o.aP = a - pw;
      // Beside an unkerbed road the ground meets the road flush and rises to the usual level over three metres.
      const flush = a <= 0 ? 0 : a >= 3 ? 1 : a / 3;
      o.raise = KERB_HEIGHT * (kerbed + (1 - kerbed) * flush * flush * (3 - 2 * flush));
      const fromA = st1 - edge.s0[e1], fromB = edge.s1[e1] - st1, ja = edge.setA[e1] > 0 ? edge.setA[e1] - fromA : -FAR, jb = edge.setB[e1] > 0 ? edge.setB[e1] - fromB : -FAR;
      o.jn = ja > jb ? ja : jb; o.node = ja > jb ? edge.nodeA[e1] : edge.nodeB[e1];
      const mh = edge.medHalf[e1];
      // Raised median as three linear measures (lateral from each side, station from the nearer nose): a mesher
      // can then cut the strip exactly even where it is narrower than its sampling step.
      if (mh > 0) { o.mA = lat1 + mh; o.mB = mh - lat1; const lo = st1 - edge.medLo[e1] + mh, hi = edge.medHi[e1] + mh - st1; o.mE = lo < hi ? lo : hi; } else { o.mA = -FAR; o.mB = -FAR; o.mE = -FAR; }
    } else { o.a = FAR; o.aK = FAR; o.aP = FAR; o.raise = KERB_HEIGHT; o.jn = -FAR; o.node = -1; o.mA = -FAR; o.mB = -FAR; o.mE = -FAR; }

    // ---- shore
    const onLand = queryPolygonSet(land, x, z, q) >= 0;
    const lr = onLand ? q.dist : -q.dist, landEdgeIsBeach = q.edge >= 0 && !land.flag[q.edge];
    o.lr = lr; o.run = q.edge >= 0 ? land.run[q.edge] : 0;
    const embank = EMBANKMENT - o.aP;
    o.land = lr > embank ? lr : embank;
    o.rb = lr + o.run;
    const inBeach = queryPolygonSet(beach, x, z, q) >= 0;
    o.sb = inBeach ? -q.dist : q.dist;
    o.ds = inBeach ? q.dist2 : -q.dist2;
    const bb = data.backBeach;
    if (bb && o.sb > 0 && lr > 0) {
      const fx = (x - bb.minX) / bb.cell - 0.5, fz = (z - bb.minZ) / bb.cell - 0.5, i = Math.floor(fx), j = Math.floor(fz);
      if (i >= 0 && j >= 0 && i < bb.width - 1 && j < bb.height - 1) {
        const k = j * bb.width + i, m = bb.mask, tx = fx - i, tz = fz - j;
        const v = (m[k] * (1 - tx) + m[k + 1] * tx) * (1 - tz) + (m[k + bb.width] * (1 - tx) + m[k + bb.width + 1] * tx) * tz;
        // Mask value to metres: the blur ramps from 0 to 255 over about two cells.
        if (v > 0) { const d = (127.5 - v) / 255 * 2 * bb.cell; if (d < o.sb) o.sb = d; }
      }
    }
    if (o.ds <= -SHORE_REACH + 0.01) o.ds = -FAR;
    const wShore = lr + BED_RANGE, wBeach = o.ds + BEACH_SEAWARD;
    o.w = wShore > wBeach ? wShore : wBeach;
    o.dsand = landEdgeIsBeach && lr >= 0 ? (o.sb < lr ? (o.sb > 0 ? o.sb : 0) : lr) : (o.sb > 0 ? o.sb : 0);

    // ---- areas
    const pk = queryPolygonSet(parks, x, z, q);
    o.parkId = pk; o.park = pk >= 0 ? -q.dist : q.dist;
    o.district = districtOf(x, z);
    let lot = FAR, lotId = -1;
    const lg = data.lotGrid;
    if (lg) {
      const lc = gridCell(lg, x, z), R = data.lotRect;
      for (let p = lg.start[lc], end = lg.start[lc + 1]; p < end; p++) {
        const i = lg.items[p] * 6, dx = x - R[i], dz = z - R[i + 1], cs = R[i + 4], sn = R[i + 5];
        const u = Math.abs(dx * cs - dz * sn) - R[i + 2], v = Math.abs(dx * sn + dz * cs) - R[i + 3];
        const sd = u > 0 && v > 0 ? Math.sqrt(u * u + v * v) : u > v ? u : v;
        if (sd < lot) { lot = sd; lotId = lg.items[p]; }
      }
    }
    o.lot = lot; o.lotId = lot < 0 ? lotId : -1; o.lotNear = lotId;
    o.type = typeOf(o); o.y = heightOf(o.type, o);
    return o;
  }

  /** Lateral offset and station of a point relative to one given edge (extrapolated past its ends). */
  function frame(e, x, z, out) {
    let best = Infinity;
    for (let i = edge.seg0[e], end = i + edge.segN[e]; i < end; i++) {
      const px = x - seg.ax[i], pz = z - seg.az[i], dx = seg.dx[i], dz = seg.dz[i], len = seg.len[i];
      const along = px * dx + pz * dz, first = i === edge.seg0[e], last = i === end - 1;
      const t = along < 0 ? (first ? along : 0) : along > len ? (last ? along : len) : along;
      const qx = px - t * dx, qz = pz - t * dz, d = qx * qx + qz * qz;
      if (d < best) { best = d; out[0] = (pz * dx - px * dz < 0 ? -1 : 1) * Math.sqrt(d); out[1] = seg.s0[i] + t; }
    }
    return out;
  }

  /** Ground cover class at a sample (the land-use rules; the mesher refines the same rules into materials). */
  function coverOf(s) {
    switch (s.type) {
      case TYPE.NONE: return COVER.WATER;
      case TYPE.BED: return s.y < 0 ? COVER.WATER : s.ds > -BEACH_SEAWARD || s.run > 12 ? COVER.SAND : COVER.ROCK;
      case TYPE.ROAD: case TYPE.JUNCTION: return data.roads[edge.road[s.edge]].runway ? COVER.TARMAC : COVER.ASPHALT;
      case TYPE.MEDIAN: return COVER.MEDIAN;
      case TYPE.KERB: return COVER.KERB;
      case TYPE.PAVEMENT: return COVER.PAVING;
      case TYPE.LOT: return data.lots[s.lotId].cover;
      case TYPE.PARK: return parkCover(data, s);
      case TYPE.SAND: return COVER.SAND;
      case TYPE.FILL: return COVER.DIRT;
      default: return landCover(data, s);
    }
  }

  const S = new Sample();
  const result = { kind: 'water', cover: 'water', coverId: 0, y: 0, yGround: 0, roadId: null, road: -1, edge: -1, lateral: 0, station: 0, distRoad: FAR, distShore: 0, district: null, districtIndex: -1, lot: -1, water: null, junction: -1, onBridge: false };
  /**
   * The public answer. Returns one reused object:
   * kind 'road' | 'junction' | 'bridge' | 'median' | 'pavement' | 'lot' | 'park' | 'beach' | 'verge' | 'water';
   * cover (name from COVER_NAMES) and coverId; y = height of the drivable surface (bridge deck where there is
   * one), yGround = ground or sea bed below; roadId / road (index) / edge, lateral, station for the nearest road;
   * distRoad = metres to the nearest carriageway edge (negative on it); distShore = metres to the still waterline
   * (positive on land); district id; lot index; water = null | 'ocean' | 'bay' | 'canal' | 'marina'.
   */
  function field(x, z) {
    const s = sample(x, z, S), r = result;
    r.kind = KIND_NAMES[s.type]; r.coverId = coverOf(s); r.cover = COVER_NAMES[r.coverId]; r.y = r.yGround = s.y; r.onBridge = false;
    r.edge = s.edge; r.road = s.edge >= 0 ? edge.road[s.edge] : -1; r.roadId = r.road >= 0 ? data.roads[r.road].id : null;
    r.lateral = s.lat; r.station = s.st; r.distRoad = s.a; r.junction = s.type === TYPE.JUNCTION ? data.nodes[s.node].junction : -1;
    r.districtIndex = s.district; r.district = s.district >= 0 ? data.districtInfo[s.district].id : null; r.lot = s.lotId;
    if (s.g < 0) {
      const b = bridges[s.bridge];
      // The footprint is already cut square at both ends, so inside it the deck is a matter of width alone.
      if (Math.abs(s.bridgeLat) < b.deckHalf) {
        r.kind = 'bridge'; r.onBridge = true; r.y = bridgeY(b, s.bridgeSt); r.coverId = COVER.DECK; r.cover = 'deck';
        r.road = b.road; r.roadId = data.roads[b.road].id; r.lateral = s.bridgeLat; r.station = Math.min(b.length, Math.max(0, s.bridgeSt)); r.edge = b.edge; r.distRoad = Math.abs(s.bridgeLat) - b.hw;
      }
    }
    r.distShore = shoreDistance(s);
    // Only what lies below the still water is water: the dry part of a shore slope is beach sand or rock bank.
    r.water = s.y < 0 ? waterKind(x, z) : null;
    if (s.type <= TYPE.BED && !r.onBridge) r.kind = r.water ? 'water' : r.coverId === COVER.SAND ? 'beach' : 'verge';
    return r;
  }

  /** Open ocean, bay, canal or marina, from the coarse water-type grid of the coast map. */
  function waterKind(x, z) {
    const cm = data.coast; if (!cm) return 'bay';
    let cx = Math.floor((x - cm.minX) / cm.kindCell), cz = Math.floor((z - cm.minZ) / cm.kindCell);
    cx = cx < 0 ? 0 : cx >= cm.kindWidth ? cm.kindWidth - 1 : cx; cz = cz < 0 ? 0 : cz >= cm.kindHeight ? cm.kindHeight - 1 : cz;
    return WATER_KINDS[cm.kinds[cz * cm.kindWidth + cx]];
  }

  const districtAt = (x, z) => { const d = districtOf(x, z); return d >= 0 ? data.districtInfo[d] : null; };
  return { sample, frame, field, districtAt, coverOf, data };
}

/**
 * Signed distance to the still waterline from a sample, positive on land: at the wall, part of the way down a
 * rock slope, or where the beach profile crosses sea level. Exact near shores, clamped beyond the field's reach.
 */
export function shoreDistance(s) {
  const beachSide = s.ds > -BEACH_SEAWARD ? s.ds - WATERLINE : -FAR, hardSide = s.lr >= 0 ? s.lr : s.lr + s.run * 0.35;
  if (s.lr >= 0) return Math.max(s.lr, beachSide);
  const d = Math.max(hardSide, beachSide);
  // The slope estimates above are approximate; the sign always agrees with the ground height.
  return s.y >= 0 ? Math.max(d, 0.1) : Math.min(d, -0.1);
}

/** Deck height of a bridge at a station, from the profile table stored with the plan. */
export function bridgeY(b, s) {
  const f = Math.min(b.y.length - 1.001, Math.max(0, s / b.step)), i = Math.floor(f);
  return b.y[i] + (b.y[i + 1] - b.y[i]) * (f - i);
}

/** Low-frequency pattern that shapes golf holes, yards and patchy grass. Shared by cover statistics and meshing. */
export function coverPattern(x, z, seed) { return noise2(x / 46, z / 46, seed) * 0.65 + noise2(x / 15, z / 15, seed + 1) * 0.35; }

export const GOLF_BANDS = { bunker: 0.3, fairway: 0.47, green: 0.67 };

function parkCover(data, s) {
  const kind = PARK_KINDS[data.parkKind[s.parkId]];
  if (kind === 'golf') { const c = coverPattern(s.x, s.z, 5); return c < GOLF_BANDS.bunker ? COVER.SAND : c < GOLF_BANDS.fairway ? COVER.ROUGH : c < GOLF_BANDS.green ? COVER.FAIRWAY : COVER.GREEN; }
  if (kind === 'parking') return COVER.PARKING;
  if (kind === 'apron' || kind === 'runway') return COVER.TARMAC;
  if (kind === 'dock') return COVER.CONCRETE;
  if (kind === 'dirt') return COVER.DIRT;
  return COVER.LAWN;
}

/** Yard pattern thresholds for industrial land: dirt, gravel, then concrete. */
export const YARD_BANDS = { dirt: 0.42, gravel: 0.6 };

function landCover(data, s) {
  const d = s.district >= 0 ? data.districtInfo[s.district] : null;
  if (!d) return COVER.ROUGH;
  if (d.cover === COVER.GRAVEL) { const c = coverPattern(s.x, s.z, 9); return c < YARD_BANDS.dirt ? COVER.DIRT : c < YARD_BANDS.gravel ? COVER.GRAVEL : COVER.CONCRETE; }
  // Downtown paves the strip beside the pavement and leaves the back of the block as planting.
  if (d.cover === COVER.PAVERS) return s.aP < 9 ? COVER.PAVERS : COVER.LAWN;
  return d.cover;
}
export { PARK_KINDS, parkCover, landCover };
