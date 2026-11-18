// The city plan: everything that is decided once for the whole map. The world worker builds it from the layout
// and posts the transferable part (`plan.data`) to the page, where `planFromData` recreates the same field and
// exposes the page-side shape agreed in design/ARCHITECTURE.md section 15.1.

import { normaliseLayout, yawFromLayoutDeg } from './layout.js';
import { infillStreets } from './infill.js';
import { buildNetwork, edgePoint } from './network.js';
import { buildFieldData, createField, setLots, setBackBeach, LAND_Y, Sample } from './field.js';
import { buildLots } from './lots.js';
import { buildLaneGraph } from './lanes.js';
import { buildCoastMap } from './coast.js';
import { planFurniture } from './placement.js';
import { buildMinimap } from './minimap.js';
import { distSqToSegment, pointInPolygon } from './geom.js';

export const TILE = 128;
const BRIDGE_SHOULDER = 11;    // metres of embankment beside a bridge's pavements that other roads must stay out of
const BRIDGE_SEARCH = 60;      // metres from its end within which a bridge may be held back to clear other roads

/**
 * Build the plan. rawLayout: parsed layout.json. deps: the adapters object (bridges, buildings, landmarks).
 * options.signalLenses: { prototypeName: [{ pos, color, facing, diameter, approach }] } from the props catalogue.
 * Returns the worker-side plan: { data, field, net, layout, lots, issues, ... }.
 */
export function buildPlan(rawLayout, deps, options = {}) {
  const timings = {}, clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let t = clock(); const lap = (name) => { const n = clock(); timings[name] = Math.round(n - t); t = n; };
  const layout = normaliseLayout(rawLayout), issues = layout.issues;
  layout.roads.push(...infillStreets(layout)); lap('infill');
  const net = buildNetwork(layout.roads, layout.junctions, issues); lap('network');

  // Bridges: the roads engineer's description gives the profile and the full footprint; the profile is tabulated
  // so that the page can answer heights without loading the bridge builder.
  const bridges = [], f = [0, 0, 0, 0];
  for (const road of net.roads) {
    if (!road.bridge || !road.edges.length) continue;
    if (road.edges.length > 1) issues.push({ level: 'warning', what: 'road', id: road.id, text: 'a junction lies on this bridge; only its first stretch is built as a bridge' });
    // The bridge spans its edge between the stop lines: where it ends in a junction the junction area stays on the
    // ground, so the deck and its parapets never reach into the crossing road.
    const e = net.edges[road.edges[0]], half = road.hw + road.pw + BRIDGE_SHOULDER;
    const start = bridgeHoldBack(layout, net, e, 0, half, issues), tail = bridgeHoldBack(layout, net, e, 1, half, issues), length = e.length - start - tail;
    const pts = [[edgePoint(e, start, f)[0], f[1]]];
    for (let i = 1; i + 1 < e.pts.length / 2; i++) { const st = e.st[i] - e.s0; if (st > start + 0.5 && st < e.length - tail - 0.5) pts.push([e.pts[i * 2], e.pts[i * 2 + 1]]); }
    pts.push([edgePoint(e, e.length - tail, f)[0], f[1]]);
    const spec = deps.bridges.bridgeSpecFromRoad({ ...layout.roads[road.index], points: pts }), info = deps.bridges.describeBridge(spec);
    const step = 2, n = Math.ceil(length / step) + 2, y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = info.y(Math.min(length, i * step));
    bridges.push({ road: road.index, edge: e.id, id: road.id, hw: road.hw, deckHalf: road.hw + road.pw + 0.6, halfExtent: Math.max(info.halfExtent || 0, road.hw + road.pw + 1), start, tail, length, step, y, spec });
  }
  lap('bridges');
  const data = buildFieldData(layout, net, bridges);
  let field = createField(data); lap('field');
  const lots = buildLots({ layout, net, field, fieldData: data }, { ARCHETYPES: deps.buildings.ARCHETYPES, archetypesFor: deps.buildings.archetypesFor, landmarkLot: deps.landmarks.landmarkLot }, issues);
  setLots(data, lots); field = createField(data); setBackBeach(data, field, layout.beaches); lap('lots');
  const marinas = layout.landmarks.filter((m) => m.kind === 'marina' || m.kind === 'boatyard').map((m) => m.pos);
  data.coast = buildCoastMap(data, field, marinas); lap('coast');
  const probe = new Sample(), laneGraph = buildLaneGraph(net, bridges, (x, z) => field.sample(x, z, probe).a); lap('lanes');
  laneGraph.nodeJunction.forEach((j, i) => { data.nodes[i].junction = j; });
  const { spawn, titleSpot } = spawnPoints(layout, net, laneGraph, field);
  const furniture = planFurniture({ net, field, data, laneGraph, tile: TILE, keepClear: [[spawn.x, spawn.z], [titleSpot.x, titleSpot.z]] }, options.signalLenses || {}); lap('furniture');
  Object.assign(data, {
    tile: TILE, landY: LAND_Y, laneGraph: { lanes: laneGraph.lanes, junctions: laneGraph.junctions }, spawn, titleSpot, minimap: buildMinimap(layout, net),
    cityName: layout.meta.cityName || '', countyName: layout.meta.countyName || '',
    landmarks: layout.landmarks.map((m) => ({ id: m.id, name: m.name, kind: m.kind, x: m.pos[0], z: m.pos[1], yaw: yawFromLayoutDeg(m.yawDeg) })),
  });
  lap('finish');
  return { data, field, layout, net, bridges, lots, laneGraph, furniture, issues, timings, spawn, titleSpot };
}

/**
 * How far from one end of its edge (0 = a, 1 = b) a bridge has to begin so that its footprint, `half` metres to
 * either side, lies clear of every other road: past the stop line of a junction it ends in, and past any street
 * that cuts the corner of its approach. The stretch held back stays an ordinary road on the ground.
 */
function bridgeHoldBack(layout, net, e, end, half, issues) {
  const node = net.nodes[end ? e.b : e.a], base = node.kind === 'junction' ? (end ? e.setB : e.setA) : 0, f = [0, 0, 0, 0];
  // A joint continues the bridge road itself; every other road near the end is an obstacle.
  const through = node.kind === 'joint' ? new Set(node.legs.map((l) => l.edge)) : new Set([e.id]);
  const near = net.edges.filter((o) => !through.has(o.id) && !net.roads[o.road].bridge && (() => { for (let i = 0; i < o.pts.length; i += 2) if (Math.hypot(o.pts[i] - node.x, o.pts[i + 1] - node.z) < BRIDGE_SEARCH + 60) return true; return false; })());
  const blockedAt = (s) => {
    edgePoint(e, end ? e.length - s : s, f);
    for (let lat = -half; lat <= half; lat += 2) {
      const x = f[0] - f[3] * lat, z = f[1] + f[2] * lat;
      for (const o of near) for (let i = 0; i + 3 < o.pts.length; i += 2) if (distSqToSegment(x, z, o.pts[i], o.pts[i + 1], o.pts[i + 2], o.pts[i + 3]) < (o.hw + o.pw + 0.5) ** 2) return true;
    }
    return false;
  };
  const onLand = (s) => { edgePoint(e, end ? e.length - s : s, f); return layout.landmasses.some((l) => pointInPolygon(f[0], f[1], l.polygon)); };
  let hold = base;
  while (hold < Math.min(BRIDGE_SEARCH, e.length / 4) && (blockedAt(hold) || blockedAt(hold + 3) || blockedAt(hold + 6))) {
    if (!onLand(hold + 2)) { issues.push({ level: 'warning', what: 'road', id: net.roads[e.road].id, text: `another road lies inside the bridge approach at (${node.x.toFixed(0)}, ${node.z.toFixed(0)}) and there is no land to start the bridge beyond it` }); break; }
    hold += 2;
  }
  return hold;
}

/**
 * Spawn: the layout's point moved onto the nearest lane centre and turned to the lane's direction.
 * Title spot: parked against the kerb of the ocean-front drive (the road with the most beach beside it), sea in view.
 */
function spawnPoints(layout, net, laneGraph, field) {
  const onLane = (x, z, yaw) => {
    let best = null;
    for (const lane of laneGraph.lanes) {
      if (lane.junction >= 0) continue;
      for (let i = 0; i + 1 < lane.pts.length / 3; i++) {
        const ax = lane.pts[i * 3], az = lane.pts[i * 3 + 2], bx = lane.pts[i * 3 + 3], bz = lane.pts[i * 3 + 5], l = Math.hypot(bx - ax, bz - az) || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (l * l))), px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
        const heading = Math.atan2(bx - ax, bz - az), turn = yaw === null ? 0 : Math.abs(Math.atan2(Math.sin(heading - yaw), Math.cos(heading - yaw)));
        const d = Math.hypot(px - x, pz - z) + turn * 6;                          // prefer the lane that already points the right way
        if (!best || d < best.d) best = { d, x: px, z: pz, yaw: heading, lane: lane.id };
      }
    }
    return best;
  };
  let spawn;
  if (layout.spawn) { const s = onLane(layout.spawn.pos[0], layout.spawn.pos[1], yawFromLayoutDeg(layout.spawn.yawDeg)); spawn = { x: s.x, z: s.z, yaw: s.yaw }; }
  else { const lane = laneGraph.lanes.reduce((a, b) => (b.junction < 0 && b.length > a.length ? b : a)); const s = onLane(lane.pts[0], lane.pts[2], null); spawn = { x: s.x, z: s.z, yaw: s.yaw }; }
  // Title spot: the kerbside point with the widest run of sand directly beside it, nearest to the spawn among equals.
  let title = null;
  for (const e of net.edges) {
    const road = net.roads[e.road]; if (road.bridge || road.runway || road.generated) continue;
    for (let i = 2; i + 2 < e.pts.length / 2; i += 3) {
      const dx = e.pts[i * 2 + 2] - e.pts[i * 2], dz = e.pts[i * 2 + 3] - e.pts[i * 2 + 1], l = Math.hypot(dx, dz) || 1;
      for (const side of [1, -1]) {
        const nx = -dz / l * side, nz = dx / l * side; let sand = 0, sea = false;
        for (let d = e.hw + 12; d < e.hw + 460; d += 10) { const f = field.field(e.pts[i * 2] + nx * d, e.pts[i * 2 + 1] + nz * d); if (f.kind === 'beach' || (f.cover === 'sand')) sand++; if (f.water === 'ocean') { sea = true; break; } if (f.kind === 'lot' || f.kind === 'road') break; }
        if (!sea || sand < 3) continue;
        const score = sand * 30 - Math.hypot(e.pts[i * 2] - spawn.x, e.pts[i * 2 + 1] - spawn.z) * 0.2;
        if (!title || score > title.score) {
          const off = road.lanes.parking ? (road.lanes.parking.inner + road.lanes.parking.outer) / 2 : e.hw - 1.3;
          title = { score, x: e.pts[i * 2] + nx * off, z: e.pts[i * 2 + 1] + nz * off, yaw: Math.atan2(dx * side, dz * side) };
        }
      }
    }
  }
  const titleSpot = title ? { x: title.x, z: title.z, yaw: title.yaw } : { ...spawn };
  return { spawn, titleSpot };
}

/**
 * Page side: recreate the plan from the data the worker posted.
 * Returns { spawn, titleSpot, bounds, laneGraph, coast, districts, landmarks, roads, minimap, cityName,
 * countyName, field, districtAt, sample, data }. Every name in it is the game's own (the layout's gameName).
 */
export function planFromData(data) {
  const f = createField(data);
  return {
    spawn: data.spawn, titleSpot: data.titleSpot, bounds: data.bounds, laneGraph: data.laneGraph, coast: data.coast,
    districts: data.districtInfo, landmarks: data.landmarks, roads: data.roads, minimap: data.minimap,
    cityName: data.cityName, countyName: data.countyName,
    field: f.field, districtAt: f.districtAt, sample: f.sample, data,
  };
}

export { createField, LAND_Y };
