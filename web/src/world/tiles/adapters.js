// The modules the tile builder composes are owned by other people and arrive at different times. Each is loaded
// here through its published interface (design/ARCHITECTURE.md section 9, the README files of roads and
// buildings). When a module cannot be imported yet, a deliberately plain stand-in with the same signature takes
// its place so that the plan, the tile builder and their tests always run; the real call path is identical.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, SOLID, GROUND, FACADE } from '../../core/ids.js';
import { hashInts, hash01 } from '../../core/math.js';
import { yawFromLayoutDeg } from '../plan/layout.js';
import { laneCode, laneLayout } from '../roads/lanes.js';

const LAND_Y = 1.2;

async function optional(path, names, notes) {
  try {
    const mod = await import(path);
    for (const n of names) if (typeof mod[n] === 'undefined') throw new Error('missing export ' + n);
    return mod;
  } catch (err) {
    // Only an absent module may fall back; a module that exists but throws is a defect worth seeing.
    const absent = err && (err.code === 'ERR_MODULE_NOT_FOUND' || /Failed to fetch|Cannot find module|missing export|error loading dynamically imported module|Importing a module script failed/i.test(String(err.message)));
    notes.push(`${path}: ${absent ? 'not available, plain stand-in used' : 'failed to load: ' + err.message}`);
    if (!absent) throw err;
    return null;
  }
}

// ------------------------------------------------------------------ stand-ins

/** Archetype sizes from src/world/buildings/README.md, used only until buildings/index.js exists. */
const PLAIN_ARCHETYPES = Object.fromEntries([
  ['deco_hotel', 14, 34, 18, 42, 2, 7, 'paved', { artdeco_beach: 10, beach_resort: 4 }],
  ['deco_apartment', 12, 30, 16, 40, 2, 4, 'paved', { artdeco_beach: 6, beach_resort: 6, hotel_strip: 2 }],
  ['deco_shop', 10, 44, 12, 30, 1, 2, 'paved', { artdeco_beach: 4, beach_resort: 4, latin_quarter: 2 }],
  ['motel', 28, 64, 22, 44, 1, 2, 'asphalt', { hotel_strip: 4, beach_resort: 2, latin_quarter: 1, downtown: 1 }],
  ['hotel_tower', 30, 80, 24, 50, 8, 22, 'paved', { hotel_strip: 8, beach_resort: 4, downtown: 2 }],
  ['office_tower', 30, 70, 30, 70, 12, 45, 'paved', { downtown: 8 }],
  ['office_block', 18, 54, 18, 44, 3, 12, 'paved', { downtown: 6, beach_resort: 2, hotel_strip: 1, latin_quarter: 1 }],
  ['strip_mall', 34, 100, 26, 46, 1, 1, 'asphalt', { latin_quarter: 4, residential_poor: 2, hotel_strip: 3, downtown: 1 }],
  ['diner', 16, 30, 16, 30, 1, 1, 'asphalt', { latin_quarter: 1, hotel_strip: 1, beach_resort: 1, artdeco_beach: 1 }],
  ['shop_row', 8, 44, 12, 28, 1, 4, 'paved', { latin_quarter: 10, residential_poor: 5, artdeco_beach: 2, beach_resort: 2 }],
  ['bungalow', 9, 18, 12, 26, 1, 1, 'lawn', { latin_quarter: 4, residential_poor: 8, hotel_strip: 3 }],
  ['villa', 16, 30, 18, 34, 1, 2, 'lawn', { hotel_strip: 5, beach_resort: 2, mansion_island: 2 }],
  ['mansion', 30, 70, 30, 70, 2, 3, 'lawn', { mansion_island: 10, studio_island: 2 }],
  ['warehouse', 22, 90, 18, 60, 1, 2, 'concrete', { industrial_port: 10, residential_poor: 3, airport: 2, studio_island: 3, military: 4 }],
  ['hangar', 34, 80, 34, 70, 1, 1, 'concrete', { airport: 8, military: 5 }],
  ['parking_garage', 30, 70, 28, 46, 3, 8, 'paved', { downtown: 4, hotel_strip: 2, airport: 2 }],
  ['gas_station', 26, 44, 22, 34, 1, 1, 'asphalt', { latin_quarter: 1, hotel_strip: 1, residential_poor: 1, downtown: 1 }],
].map(([name, minWidth, maxWidth, minDepth, maxDepth, f0, f1, groundCover, styles]) => [name, {
  name, styles, minWidth, maxWidth, minDepth, maxDepth, floors: [f0, f1], floorHeight: 3.2, groundHeight: 4, groundCover,
  margin: { front: groundCover === 'paved' ? 0 : 5, side: groundCover === 'paved' ? 0 : 2, back: 2 }, cornerOnly: false, variants: 1,
}]));

const plainBuildings = {
  ARCHETYPES: PLAIN_ARCHETYPES,
  archetypesFor: (style) => Object.values(PLAIN_ARCHETYPES).filter((a) => a.styles[style]).map((a) => ({ name: a.name, weight: a.styles[style] })).sort((a, b) => b.weight - a.weight),
  buildingHeight: (name, floors) => { const a = PLAIN_ARCHETYPES[name]; return a ? a.groundHeight + (Math.max(1, floors) - 1) * a.floorHeight + 0.9 : floors * 3.2; },
  /** A stuccoed box with a flat roof inside the lot margins. */
  buildBuilding(lot, level) {
    const a = PLAIN_ARCHETYPES[lot.archetype] || PLAIN_ARCHETYPES.shop_row, mb = new MeshBuilder();
    const hx = Math.max(2, lot.width / 2 - a.margin.side), z1 = lot.depth / 2 - a.margin.front, z0 = -lot.depth / 2 + a.margin.back, h = plainBuildings.buildingHeight(a.name, lot.floors);
    plainBox(mb, 0, (z0 + z1) / 2, hx, Math.max(2, (z1 - z0) / 2), h, lot.seed);
    return { mesh: mb, lights: new Float32Array(0), glows: new Float32Array(0), colliders: level === 0 ? Float32Array.from([0, h / 2, (z0 + z1) / 2, hx, h / 2, Math.max(2, (z1 - z0) / 2), 0]) : new Float32Array(0), signs: [], height: h, triangles: mb.triangleCount };
  },
  placeRecords(result, lot, groundY, out) {
    const c = Math.cos(lot.yaw), s = Math.sin(lot.yaw), b = result.colliders;
    for (let i = 0; i < b.length; i += 7) out.boxes.push(lot.x + b[i] * c + b[i + 2] * s, groundY + b[i + 1], lot.z - b[i] * s + b[i + 2] * c, b[i + 3], b[i + 4], b[i + 5], lot.yaw + b[i + 6]);
  },
};

function plainBox(mb, cx, cz, hx, hz, h, seed) {
  const tone = 0.62 + hash01(seed, 3) * 0.3;
  mb.family(FAMILY.FACADE).material(FACADE.BLANK, 0, 0, 0).color(tone, tone * 0.96, tone * 0.9);
  const x0 = cx - hx, x1 = cx + hx, z0 = cz - hz, z1 = cz + hz;
  const wall = (ax, az, bx, bz, nx, nz) => {
    const w = Math.hypot(bx - ax, bz - az);
    const v0 = mb.vertex(ax, 0, az, nx, 0, nz, 0, 0), v1 = mb.vertex(bx, 0, bz, nx, 0, nz, w, 0), v2 = mb.vertex(bx, h, bz, nx, 0, nz, w, h), v3 = mb.vertex(ax, h, az, nx, 0, nz, 0, h);
    mb.quad(v0, v1, v2, v3);
  };
  wall(x0, z1, x1, z1, 0, 1); wall(x1, z1, x1, z0, 1, 0); wall(x1, z0, x0, z0, 0, -1); wall(x0, z0, x0, z1, -1, 0);
  mb.family(FAMILY.SOLID).material(SOLID.ROOF, 0, 0, 0).color(0.5, 0.5, 0.52);
  mb.quad(mb.vertex(x0, h, z1, 0, 1, 0, 0, 0), mb.vertex(x1, h, z1, 0, 1, 0, 1, 0), mb.vertex(x1, h, z0, 0, 1, 0, 1, 1), mb.vertex(x0, h, z0, 0, 1, 0, 0, 1));
}

const plainLandmarks = {
  placeRecords: (result, lot, groundY, out) => plainBuildings.placeRecords(result, lot, groundY, out),
  landmarkLot: (m) => ({ id: 'landmark:' + m.id, x: m.pos[0], z: m.pos[1], yaw: yawFromLayoutDeg(m.yawDeg), width: m.footprint[0], depth: m.footprint[1], district: m.district, archetype: 'landmark', floors: Math.max(1, Math.round(m.heightM / 3.4)), seed: hashInts(m.pos[0] * 10 | 0, m.pos[1] * 10 | 0, 7), landmark: { id: m.id, kind: m.kind, gameName: m.gameName, heightM: m.heightM } }),
  buildLandmark(m, level) {
    const mb = new MeshBuilder(), hx = m.footprint[0] / 2 - 1, hz = m.footprint[1] / 2 - 1, h = m.heightM;
    plainBox(mb, 0, 0, hx, hz, h, hashInts(m.pos[0] | 0, m.pos[1] | 0));
    return { mesh: mb, lights: new Float32Array(0), glows: new Float32Array(0), colliders: level === 0 ? Float32Array.from([0, h / 2, 0, hx, h / 2, hz, 0]) : new Float32Array(0), signs: [], height: h, triangles: mb.triangleCount };
  },
};

/** Plain bridge: a deck ribbon with parapets on a ramp-and-crest profile, no supports. */
function plainBridges() {
  const smooth = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
  const bridgeSpecFromRoad = (road) => ({ id: road.id, path: road.points, halfWidth: road.width / 2, lanesPerDirection: road.lanesPerDirection, pavementWidth: road.pavementWidth, deckY: road.bridge.deckY, rampLength: road.bridge.rampLength || 80, style: road.bridge.style === 'arch' ? 'arch' : 'flat' });
  const describeBridge = (spec) => {
    const P = spec.path, st = [0]; for (let i = 1; i < P.length; i++) st.push(st[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const length = st[st.length - 1], ramp = Math.min(spec.rampLength || 80, length / 2), rise = spec.deckY - LAND_Y;
    const y = (s) => LAND_Y + rise * Math.min(smooth(s / ramp), smooth((length - s) / ramp));
    const frame = (s, out = {}) => {
      let i = 0; while (i + 2 < st.length && st[i + 1] < s) i++;
      const t = (Math.min(length, Math.max(0, s)) - st[i]) / (st[i + 1] - st[i] || 1), dx = P[i + 1][0] - P[i][0], dz = P[i + 1][1] - P[i][1];
      out.x = P[i][0] + dx * t; out.z = P[i][1] + dz * t; out.y = y(s); out.yaw = Math.atan2(dx, dz); out.grade = (y(s + 0.5) - y(s - 0.5)); return out;
    };
    const code = laneCode({ lanesPerDirection: spec.lanesPerDirection, openShoulder: true });
    return { length, profile: { y }, y, frame, sections: [{ from: 0, to: length, support: 'span' }], piers: [], lamps: [], halfExtent: spec.halfWidth + (spec.pavementWidth || 0) + 1.5, laneCode: code, layout: laneLayout(spec.halfWidth, code, true) };
  };
  const buildBridge = (spec, level, { range, origin = [0, 0] } = {}) => {
    const info = describeBridge(spec), mb = new MeshBuilder(), s0 = Math.max(0, range ? range[0] : 0), s1 = Math.min(info.length, range ? range[1] : info.length);
    const step = level === 0 ? 8 : 16, hw = spec.halfWidth, outer = hw + (spec.pavementWidth || 0) + 0.4, f = {}, positions = [], indices = [];
    const rows = []; for (let s = s0; s < s1 - 0.01; s += step) rows.push(s); rows.push(s1);
    // A ribbon between two lateral offsets (latA to the right of latB), facing up.
    const strip = (latA, latB, lift, material) => {
      material(); let prev = null;
      for (const s of rows) {
        info.frame(s, f); const rx = -Math.cos(f.yaw), rz = Math.sin(f.yaw);
        const a = mb.vertex(f.x + rx * latA - origin[0], f.y + lift, f.z + rz * latA - origin[1], 0, 1, 0, latA, s);
        const b = mb.vertex(f.x + rx * latB - origin[0], f.y + lift, f.z + rz * latB - origin[1], 0, 1, 0, latB, s);
        if (prev) mb.quad(prev[0], a, b, prev[1]);
        prev = [a, b];
      }
    };
    strip(hw, -hw, 0, () => mb.family(FAMILY.GROUND).material(GROUND.DECK, Math.round(hw * 10), info.laneCode, 12).color(1, 1, 1));
    const walkway = () => mb.family(FAMILY.SOLID).material(SOLID.CONCRETE, 0, 0, 0).color(0.7, 0.7, 0.68);
    strip(outer, hw, 0.14, walkway); strip(-hw, -outer, 0.14, walkway);
    // Parapets: a plain wall on each side, in the mesh and in the collider (no unfenced drop beside the road).
    const PARAPET = 1.0;
    walkway(); let prev = null;
    for (const s of rows) {
      info.frame(s, f); const rx = -Math.cos(f.yaw), rz = Math.sin(f.yaw), row = [];
      for (const side of [1, -1]) for (const [lat, n] of [[outer - 0.3, -side], [outer, side]]) for (const h of [0.14, PARAPET]) row.push(mb.vertex(f.x + rx * lat * side - origin[0], f.y + h, f.z + rz * lat * side - origin[1], rx * n, 0, rz * n, s, h));
      if (prev) for (let q = 0; q < 8; q += 2) { if (q === 0 || q === 6) mb.quad(prev[q], prev[q + 1], row[q + 1], row[q]); else mb.quad(prev[q], row[q], row[q + 1], prev[q + 1]); }
      prev = row;
    }
    if (level === 0) rows.forEach((s, i) => {
      info.frame(s, f); const rx = -Math.cos(f.yaw), rz = Math.sin(f.yaw), wall = outer - 0.3;
      // Per row: deck right, deck left, parapet top right, parapet top left.
      positions.push(f.x + rx * wall - origin[0], f.y, f.z + rz * wall - origin[1], f.x - rx * wall - origin[0], f.y, f.z - rz * wall - origin[1],
        f.x + rx * wall - origin[0], f.y + PARAPET, f.z + rz * wall - origin[1], f.x - rx * wall - origin[0], f.y + PARAPET, f.z - rz * wall - origin[1]);
      if (i) { const a = i * 4 - 4, b = i * 4; indices.push(a, b, b + 1, a, b + 1, a + 1, a, a + 2, b + 2, a, b + 2, b, a + 1, b + 1, b + 3, a + 1, b + 3, a + 3); }
    });
    return { mesh: mb, lights: new Float32Array(0), glows: new Float32Array(0), collider: level === 0 ? { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) } : null, profile: info.y, triangles: mb.triangleCount };
  };
  return { bridgeSpecFromRoad, describeBridge, buildBridge };
}

/**
 * The buildings module grows archetype by archetype. Archetypes it does not have yet are served by the plain
 * box so that every district has buildings from the first day; each one switches to the real builder as soon as
 * it appears in the module's ARCHETYPES table.
 */
function mergeBuildings(real, notes) {
  const missing = Object.keys(PLAIN_ARCHETYPES).filter((n) => !real.ARCHETYPES[n]);
  if (!missing.length) return real;
  notes.push('../buildings/index.js: plain stand-in used for archetypes not built yet: ' + missing.join(', '));
  const ARCHETYPES = { ...PLAIN_ARCHETYPES, ...real.ARCHETYPES };
  return {
    ...real, ARCHETYPES,
    archetypesFor: (style) => Object.values(ARCHETYPES).filter((a) => a.styles[style]).map((a) => ({ name: a.name, weight: a.styles[style] })).sort((a, b) => b.weight - a.weight),
    buildingHeight: (name, floors) => (real.ARCHETYPES[name] ? real.buildingHeight(name, floors) : plainBuildings.buildingHeight(name, floors)),
    buildBuilding: (lot, level) => (real.ARCHETYPES[lot.archetype] ? real.buildBuilding(lot, level) : plainBuildings.buildBuilding(lot, level)),
    placeRecords: (result, lot, groundY, out) => (real.ARCHETYPES[lot.archetype] ? real.placeRecords(result, lot, groundY, out) : plainBuildings.placeRecords(result, lot, groundY, out)),
  };
}

/** Markings stand-in: no decals (the GROUND shader still paints lane lines from uv). */
const plainMarkings = { addCrosswalk: () => ({ boxes: [] }), addStopLine: () => ({ boxes: [] }) };

/**
 * Load every collaborator. `base` is the URL of the src/world/ directory seen from the caller.
 * Returns { buildings, landmarks, bridges, markings, details, prototypes(detail), trafficTypes, notes }.
 */
export async function loadAdapters() {
  const notes = [];
  const [buildings, landmarks, bridges, markings, details, flora, props, traffic] = await Promise.all([
    optional('../buildings/index.js', ['buildBuilding', 'ARCHETYPES', 'archetypesFor', 'placeRecords'], notes),
    optional('../landmarks/index.js', ['buildLandmark', 'landmarkLot'], notes),
    optional('../roads/bridge.js', ['buildBridge', 'describeBridge', 'bridgeSpecFromRoad'], notes),
    optional('../roads/markings.js', ['addCrosswalk', 'addStopLine'], notes),
    optional('../roads/details.js', ['addStormDrain', 'addManhole'], notes),
    optional('../flora/index.js', ['buildPrototypes'], notes),
    optional('../props/index.js', ['buildPrototypes'], notes),
    optional('../../vehicles/traffic/index.js', ['buildTrafficModels'], notes),
  ]);
  return {
    buildings: buildings ? mergeBuildings(buildings, notes) : plainBuildings,
    // Landmarks return the same record shape as buildings and are placed with the same routine.
    landmarks: landmarks ? { placeRecords: buildings ? buildings.placeRecords : plainBuildings.placeRecords, ...landmarks } : plainLandmarks,
    bridges: bridges || plainBridges(),
    markings: markings || plainMarkings,
    details,
    /** All prototypes of both catalogues; a catalogue that is missing simply contributes nothing. */
    prototypes: (detail) => [...(flora ? flora.buildPrototypes(detail) : []), ...(props ? props.buildPrototypes(detail) : [])],
    hasTraffic: !!traffic,
    notes,
  };
}
