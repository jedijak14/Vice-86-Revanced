// One tile at one level of detail: the payload of design/ARCHITECTURE.md section 9.2.
// Runs in the world worker (and directly in Node for tests and previews). It composes what the other world
// modules build: ground from the plan field, buildings and landmarks on their lots, bridge pieces, prototype
// instances with their lights, and the colliders the physics needs, all from the same plan.

import { MeshBuilder } from '../../core/mesh.js';
import { m4, m4fromYawPos, hash01 } from '../../core/math.js';
import { FAMILY, SOLID } from '../../core/ids.js';
import { LAND_Y, KERB_HEIGHT } from '../plan/field.js';
import { placeTile, lotsInTile } from '../plan/placement.js';
import { buildGround } from './ground.js';

const LIGHT_STRIDE = 16, GLOW_STRIDE = 8, INSTANCE_STRIDE = 8;
const BRIDGE_CHUNK = 16;                     // the bridge builder cuts on this station grid

const MIN_BOX_HALF = 0.15;     // metres: half of the thinnest collider box the physics accepts

// Overhead conductors by kind (primary, secondary, communications cable): sag as a share of the span, and radius.
// The radii are a little over life size so that a wire holds a pixel at street distances.
const WIRE_SAG = [0.016, 0.024, 0.034], WIRE_RADIUS = [0.011, 0.013, 0.022];

/**
 * Overhead wires as one mesh: each conductor a three-sided strand hanging in a parabola between its two anchors.
 * wires: 7 floats per conductor (ends in world space, kind); ox, oz: tile origin; steps: segments per span.
 */
function buildWires(wires, ox, oz, steps) {
  const mb = new MeshBuilder(1024);
  mb.family(FAMILY.SOLID).material(SOLID.RUBBER, 200, 0, 0).color(0.055, 0.055, 0.06).occlusion(1);
  for (let w = 0; w < wires.length; w += 7) {
    const ax = wires[w], ay = wires[w + 1], az = wires[w + 2], bx = wires[w + 3], by = wires[w + 4], bz = wires[w + 5], kind = wires[w + 6];
    const dx = bx - ax, dz = bz - az, span = Math.hypot(dx, dz); if (span < 0.5) continue;
    const sx = -dz / span, sz = dx / span, sag = span * WIRE_SAG[kind], r = WIRE_RADIUS[kind]; let ring = -1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = ax + dx * t - ox, z = az + dz * t - oz, y = ay + (by - ay) * t - 4 * sag * t * (1 - t), first = mb.count;
      // Three corners round the strand: up, and down to either side.
      for (let c = 0; c < 3; c++) { const a = c * 2.0944, side = Math.sin(a), up = Math.cos(a); mb.vertex(x + sx * side * r, y + up * r, z + sz * side * r, sx * side, up, sz * side, c / 3, span * t); }
      if (ring >= 0) for (let c = 0; c < 3; c++) { const d = (c + 1) % 3; mb.quad(ring + c, first + c, first + d, ring + d); }
      ring = first;
    }
  }
  return mb;
}

/** Bridge pieces by tile, computed once per plan: Map 'tx,tz' -> [{ bridge, from, to }] in runs of whole chunks. */
function bridgeRuns(plan, deps) {
  if (plan.bridgeRuns) return plan.bridgeRuns;
  const runs = new Map(), tile = plan.data.tile, f = {};
  plan.bridges.forEach((b, index) => {
    const info = deps.bridges.describeBridge(b.spec); let open = null;
    for (let s = 0; s < info.length; s += BRIDGE_CHUNK) {
      const to = Math.min(info.length, s + BRIDGE_CHUNK); info.frame((s + to) / 2, f);
      const key = Math.floor(f.x / tile) + ',' + Math.floor(f.z / tile);
      if (open && open.key === key) { open.to = to; continue; }
      open = { key, bridge: index, from: s, to };
      let list = runs.get(key); if (!list) runs.set(key, list = []); list.push(open);
    }
  });
  plan.bridgeRuns = runs; return runs;
}


/**
 * Build tile (tx, tz). level: 0 near, 1 mid, 2 far. density: 0..3 (settings).
 * catalogue: Map name -> prototype (from buildPrototypes of flora and props).
 * Returns { payload, transfer } where payload is the section 9.2 record plus `castShadow` (one flag per mesh);
 * with options.keepBuilders also `builders` (the MeshBuilders before packing, for previews).
 */
export function buildTile(plan, deps, catalogue, tx, tz, level, density = 3, options = {}) {
  const tile = plan.data.tile, ox = tx * tile, oz = tz * tile, key = tx + ',' + tz;
  const lights = [], glows = [], boxes = [], cylinders = [], colliderMeshes = [];
  const builders = [], castShadow = [];

  // ---- ground
  // Drains and covers are cast-iron prototypes set flush in the road, and the plants buildings ask for; both join
  // the tile's other instances below.
  const irons = new Map();
  const ironwork = (name, x, y, z, yaw, seed) => {
    if (!catalogue.has(name)) return false;
    let list = irons.get(name); if (!list) irons.set(name, list = []);
    list.push(x, y, z, yaw, 1, hash01(seed, 91), 0, 0); return true;
  };
  // Buildings ask for their forecourt palms and hedges by flora tag (lot-local requests); they become ordinary
  // instances of the tagged prototypes, so a club's palms are the same models as the avenue's.
  const tagged = new Map();
  const byTag = (tag) => { if (!tagged.has(tag)) tagged.set(tag, [...catalogue.values()].filter((p) => p.tags && p.tags.includes(tag)).map((p) => p.name).sort()); return tagged.get(tag); };
  const plantsOf = (built, lot, groundY) => {
    const cy = Math.cos(lot.yaw), sy = Math.sin(lot.yaw);
    for (const q of built.plants || []) {
      const names = byTag(q.tag); if (!names.length) continue;
      const name = names[(q.seed >>> 0) % names.length]; let list = irons.get(name); if (!list) irons.set(name, list = []);
      list.push(lot.x + q.x * cy + q.z * sy, groundY + q.y, lot.z - q.x * sy + q.z * cy, lot.yaw + q.yaw, q.scale || 1, hash01(q.seed, 93), 0, 0);
    }
  };
  const ground = buildGround(plan, tx, tz, level, deps.markings, deps.details, ironwork);
  if (ground.mesh.count) { builders.push(ground.mesh); castShadow.push(false); }
  for (const v of ground.boxes) boxes.push(v);

  // ---- buildings and landmarks whose lot centre is in this tile, on the pavement level
  const lots = lotsInTile(plan, key), groundY = LAND_Y + KERB_HEIGHT;
  if (lots.length) {
    const mb = new MeshBuilder(4096), m = m4(), records = { lights, glows, boxes };
    for (const lot of lots) {
      // A landmark is built for the plot the plan could reserve, which may be smaller than the researched footprint.
      const built = lot.landmark ? deps.landmarks.buildLandmark({ ...plan.layout.landmarks[lot.landmarkIndex], footprint: [lot.width, lot.depth] }, level) : deps.buildings.buildBuilding(lot, level);
      if (!built) continue;
      mb.append(built.mesh, m4fromYawPos(m, lot.yaw, lot.x - ox, groundY, lot.z - oz));
      (lot.landmark ? deps.landmarks : deps.buildings).placeRecords(built, lot, groundY, records);
      plantsOf(built, lot, groundY);
    }
    if (mb.count) { builders.push(mb); castShadow.push(true); }
  }

  // ---- bridge pieces
  const runs = bridgeRuns(plan, deps).get(key);
  if (runs) {
    const mb = new MeshBuilder(4096);
    for (const run of runs) {
      const piece = deps.bridges.buildBridge(plan.bridges[run.bridge].spec, level, { range: [run.from, run.to], origin: [ox, oz] });
      mb.append(piece.mesh);
      for (const v of piece.lights) lights.push(v);
      for (const v of piece.glows) glows.push(v);
      if (piece.collider && piece.collider.indices.length) {
        // The contract wants collider meshes in world coordinates.
        const p = Float32Array.from(piece.collider.positions); for (let i = 0; i < p.length; i += 3) { p[i] += ox; p[i + 2] += oz; }
        colliderMeshes.push({ positions: p, indices: Uint32Array.from(piece.collider.indices) });
      }
    }
    if (mb.count) { builders.push(mb); castShadow.push(true); }
  }

  // ---- prototype instances, with the lights, glows and colliders each one brings
  const placed = placeTile(plan, tx, tz, level, density, catalogue), instances = [];
  for (const [name, list] of irons) placed.groups.set(name, list);
  for (const [name, list] of placed.groups) {
    const proto = catalogue.get(name), data = Float32Array.from(list), count = data.length / INSTANCE_STRIDE;
    instances.push({ proto: name, data, count });
    const hasLights = level === 0 && proto.lights && proto.lights.length, hasGlows = level <= 1 && proto.glows && proto.glows.length, collider = level === 0 ? proto.collider : null;
    const extra = level === 0 && proto.extraColliders && proto.extraColliders.length ? proto.extraColliders : null;
    if (!hasLights && !hasGlows && !collider && !extra) continue;
    for (let i = 0; i < data.length; i += INSTANCE_STRIDE) {
      const x = data[i], y = data[i + 1], z = data[i + 2], yaw = data[i + 3], scale = data[i + 4], c = Math.cos(yaw) * scale, s = Math.sin(yaw) * scale;
      const addCollider = (part, px, py, pz) => {
        const cx = x + px * c + pz * s, cy = y + py * scale, cz = z - px * s + pz * c;
        if (part.kind === 'cylinder') cylinders.push(cx, cy, cz, part.radius * scale, part.height * scale);
        else if (part.kind === 'box') boxes.push(cx, cy + part.hy * scale, cz, part.hx * scale, part.hy * scale, part.hz * scale, yaw);
      };
      if (hasLights) for (let k = 0; k < proto.lights.length; k += LIGHT_STRIDE) {
        const L = proto.lights, at = lights.length; for (let q = 0; q < LIGHT_STRIDE; q++) lights.push(L[k + q]);
        lights[at] = x + L[k] * c + L[k + 2] * s; lights[at + 1] = y + L[k + 1] * scale; lights[at + 2] = z - L[k] * s + L[k + 2] * c; lights[at + 3] = L[k + 3] * scale;
        lights[at + 8] = (L[k + 8] * c + L[k + 10] * s) / scale; lights[at + 10] = (-L[k + 8] * s + L[k + 10] * c) / scale; lights[at + 14] = data[i + 5];
      }
      if (hasGlows) for (let k = 0; k < proto.glows.length; k += GLOW_STRIDE) {
        const g = proto.glows, at = glows.length; for (let q = 0; q < GLOW_STRIDE; q++) glows.push(g[k + q]);
        glows[at] = x + g[k] * c + g[k + 2] * s; glows[at + 1] = y + g[k + 1] * scale; glows[at + 2] = z - g[k] * s + g[k + 2] * c; glows[at + 3] = g[k + 3] * scale;
      }
      if (collider) addCollider(collider, 0, 0, 0);
      // Second poles of span-wire signals and gantries, crane legs, tower ramps: offsets are in prototype space.
      if (extra) for (const part of extra) addCollider(part, part.offset[0], part.offset[1], part.offset[2]);
    }
  }

  // Overhead wires between the utility poles: too thin to shadow anything.
  if (placed.wires.length) { builders.push(buildWires(placed.wires, ox, oz, level === 0 ? 8 : 4)); castShadow.push(false); }

  // The physics can tunnel through thin boxes (design/ARCHITECTURE.md section 17): none is thinner than 0.3 m.
  for (let i = 0; i < boxes.length; i += 7) for (let k = 3; k < 6; k++) if (boxes[i + k] < MIN_BOX_HALF) boxes[i + k] = MIN_BOX_HALF;

  const meshes = builders.map((b) => b.finish());
  const payload = {
    key, tx, tz, level, meshes, castShadow, instances,
    lights: Float32Array.from(lights), glows: Float32Array.from(glows),
    colliders: level === 0 ? { heights: ground.heights, cell: ground.cell, boxes: Float32Array.from(boxes), cylinders: Float32Array.from(cylinders), meshes: colliderMeshes } : null,
    parked: Float32Array.from(placed.parked),
  };
  const transfer = [payload.lights.buffer, payload.glows.buffer, payload.parked.buffer];
  for (const m of meshes) transfer.push(m.vertices, m.indices.buffer);
  for (const g of instances) transfer.push(g.data.buffer);
  if (payload.colliders) { const c = payload.colliders; transfer.push(c.heights.buffer, c.boxes.buffer, c.cylinders.buffer); for (const m of c.meshes) transfer.push(m.positions.buffer, m.indices.buffer); }
  return options.keepBuilders ? { payload, transfer, builders } : { payload, transfer };
}
