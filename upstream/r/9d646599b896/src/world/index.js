// The streamed city, page side. A module worker builds the plan and the tiles; this file keeps the page's copy of
// the plan, decides which tiles are wanted at which level, uploads what arrives within a time budget, and tells
// the renderer, the physics and the game. Contract: design/ARCHITECTURE.md sections 9.2, 15 and 17.

import { planFromData } from './plan/index.js';
import { drawMinimap } from './plan/minimap.js';

const NEAR = 0, MID = 1, FAR = 2;
// Rings by draw distance setting (metres from the camera to the nearest point of a tile).
const NEAR_RADIUS = [170, 210, 250, 300];
const MID_RADIUS = [520, 760, 1000, 1300];
const NEAR_HYSTERESIS = 70, MID_HYSTERESIS = 140;   // a level is released only this far beyond its ring
const IN_FLIGHT = 2;                 // requests the worker holds at once: enough to keep it busy, few enough to stay current
const UPLOAD_BUDGET_MS = 2;          // main-thread time per update spent on uploads
const RESCHEDULE_SECONDS = 0.25, RESCHEDULE_METRES = 24;
const AHEAD_BONUS = 60;              // metres of priority a tile straight ahead gains over one abeam
const GROUPS_PER_STEP = 6;           // instance groups added to the scene per upload step
const MID_CLOSEST = 100;             // prototype levels that end nearer than this are not used by mid-level tiles
const SEA_BED_REACH = 64;            // sea bed is meshed this far from land

const now = () => performance.now();
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * createWorld({ renderer, physics, settings, onProgress(fraction, label), onTileLoaded(tile), onTileReleased(key) })
 * Optional for tests and tools: createWorker() -> { postMessage(message, transfer), onmessage }, layout (parsed).
 */
export async function createWorld({ renderer, physics, settings, onProgress = () => {}, onTileLoaded = () => {}, onTileReleased = () => {}, createWorker, layout }) {
  const worker = createWorker ? createWorker() : new Worker(new URL('./tiles/worker.js', import.meta.url), { type: 'module' });
  const graphics = () => (settings && settings.graphics) || {};
  const level03 = (v, fallback) => (Number.isFinite(v) ? Math.max(0, Math.min(3, v | 0)) : fallback);

  // ---- start: plan and prototypes
  let onTile = null, onTileError = null;
  const ready = await new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const m = event.data;
      if (m.type === 'progress') onProgress(m.fraction * 0.85, m.label);
      else if (m.type === 'ready') resolve(m);
      else if (m.type === 'tile') onTile(m);
      else if (m.type === 'error') { if (onTileError) onTileError(m); else reject(new Error('The city could not be built. ' + m.message)); }
    };
    worker.onerror = (event) => reject(new Error('The city worker failed to start: ' + (event.message || 'unknown error')));
    worker.postMessage({ type: 'init', detail: Math.min(2, level03(graphics().drawDistance, 2)), layout }, []);
  });
  const plan = planFromData(ready.data), data = ready.data, tileSize = data.tile;

  /** Prototype name -> { lods: [{ mesh handle, near, far }], castShadow }. */
  const prototypes = new Map();
  let sliceStart = now();
  for (let i = 0; i < ready.prototypes.length; i++) {
    const p = ready.prototypes[i];
    prototypes.set(p.name, { castShadow: p.castShadow, lods: p.lods.map((lod) => ({ mesh: renderer.createMesh(lod.mesh), near: lod.near, far: lod.far })) });
    if (now() - sliceStart > 12) { onProgress(0.85 + 0.15 * (i + 1) / ready.prototypes.length, 'Planting the palms'); await breathe(); sliceStart = now(); }
  }

  // ---- which tiles hold anything: land (or sea bed near it) from the coast map, bridges from the road lines
  const tx0 = Math.floor(data.bounds[0] / tileSize), tz0 = Math.floor(data.bounds[1] / tileSize), tx1 = Math.floor(data.bounds[2] / tileSize), tz1 = Math.floor(data.bounds[3] / tileSize);
  const columns = tx1 - tx0 + 1, rows = tz1 - tz0 + 1;
  const GROUND = 1, SOLID = 2;                              // content flags: anything to mesh; something a skyline shows
  const content = new Uint8Array(columns * rows);
  const slot = (tx, tz) => (tx < tx0 || tx > tx1 || tz < tz0 || tz > tz1 ? -1 : (tz - tz0) * columns + (tx - tx0));
  {
    const coast = data.coast, bedLimit = 128 + SEA_BED_REACH / 2;
    for (let j = 0; j < coast.height; j++) for (let i = 0; i < coast.width; i++) {
      const r = coast.data[(j * coast.width + i) * 4]; if (r > bedLimit) continue;
      const x = coast.minX + (i + 0.5) * coast.cell, z = coast.minZ + (j + 0.5) * coast.cell;
      // A cell near a tile edge also marks the neighbours, so that nothing at a border is missed.
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const s = slot(Math.floor((x + dx * coast.cell) / tileSize), Math.floor((z + dz * coast.cell) / tileSize));
        if (s >= 0) content[s] |= r <= 128 ? GROUND | SOLID : GROUND;
      }
    }
    for (const road of data.minimap.roads) {
      if (!road.bridge) continue;
      for (let i = 0; i + 3 < road.pts.length; i += 2) {
        const ax = road.pts[i], az = road.pts[i + 1], bx = road.pts[i + 2], bz = road.pts[i + 3], steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 16));
        for (let k = 0; k <= steps; k++) { const s = slot(Math.floor((ax + (bx - ax) * k / steps) / tileSize), Math.floor((az + (bz - az) * k / steps) / tileSize)); if (s >= 0) content[s] |= GROUND | SOLID; }
      }
    }
  }

  // ---- tiles
  /** key -> { key, tx, tz, levels: [record | null x3], shown: level or -1, installing, flying: [bool x3], failed: [bool x3] } */
  const tiles = new Map();
  const tileAt = (tx, tz) => {
    const key = tx + ',' + tz; let t = tiles.get(key);
    if (!t) tiles.set(key, t = { key, tx, tz, levels: [null, null, null], shown: -1, installing: false, flying: [false, false, false], failed: [false, false, false] });
    return t;
  };
  const stats = { tilesLoaded: 0, tilesPending: 0, workerMs: 0, skylinePending: 0 };
  let density = level03(graphics().density, 2), inFlight = 0, nextRequest = 1;
  let candidates = [], uploads = [], active = null;      // to request; arrived and waiting; being installed
  const requests = new Map();          // request id -> { tile, level } while the worker has it
  const camera = { x: data.titleSpot.x, z: data.titleSpot.z, dirX: 0, dirZ: 0, scheduledX: Infinity, scheduledZ: Infinity, timer: 0 };

  const rectDistance = (tx, tz, x, z) => {
    const dx = Math.max(tx * tileSize - x, 0, x - (tx + 1) * tileSize), dz = Math.max(tz * tileSize - z, 0, z - (tz + 1) * tileSize);
    return Math.hypot(dx, dz);
  };
  // Nearest first, so that a burst of skyline tiles never holds up the street the car is on.
  const uploadOrder = (job, x, z) => job.payload.level * 1e5 + rectDistance(job.payload.tx, job.payload.tz, x, z);
  const stale = (record) => record.density !== density && record.level !== FAR;      // the far level has no planting

  // ---- scene objects of a level record: `statics` (tile meshes) and `batches` (instance groups)
  function addStatics(tile, record) {
    const origin = [tile.tx * tileSize, 0, tile.tz * tileSize];
    record.meshes.forEach((mesh, i) => record.statics.push(renderer.addStatic({ mesh, origin, castShadow: record.level !== FAR && record.castShadow[i] })));
  }
  function addBatches(record, from, to) {
    for (let g = from; g < to; g++) {
      const group = record.instances[g], proto = prototypes.get(group.proto); if (!proto || !group.count) continue;
      for (const lod of proto.lods) {
        // A mid-level tile is never seen from close by, so the close-up meshes of its palms are not added.
        if (record.level !== NEAR && lod.far <= MID_CLOSEST) continue;
        record.batches.push(renderer.addInstances({ mesh: lod.mesh, instances: group.data, count: group.count, castShadow: proto.castShadow, lodNear: lod.near, lodFar: lod.far }));
      }
    }
  }
  const removeAll = (list) => { for (const id of list) renderer.remove(id); list.length = 0; };
  const setLights = (tile, record) => renderer.setLights(tile.key, record && record.lights.length ? record.lights : null, record && record.glows.length ? record.glows : null);
  function show(tile, level) {
    const record = tile.levels[level];
    addStatics(tile, record); addBatches(record, 0, record.instances.length); setLights(tile, record); tile.shown = level;
  }
  function hide(tile) {
    if (tile.shown < 0) return;
    const record = tile.levels[tile.shown];
    removeAll(record.statics); removeAll(record.batches); setLights(tile, null); tile.shown = -1;
  }
  /** Exactly one level of a tile is in the scene: the finest one loaded. */
  function showFinest(tile) {
    const finest = tile.levels.findIndex((record) => record);
    if (finest === tile.shown) return;
    hide(tile); if (finest >= 0) show(tile, finest);
  }
  /** Drops a level record. `replacing`: a rebuilt record follows at once, so the game keeps the tile's parked cars. */
  function release(tile, level, replacing = false) {
    const record = tile.levels[level]; if (!record) return;
    if (tile.shown === level) hide(tile);
    for (const mesh of record.meshes) renderer.destroyMesh(mesh);
    tile.levels[level] = null; stats.tilesLoaded--;
    if (level === NEAR) { physics.removeTile(tile.key); if (!replacing) onTileReleased(tile.key); }
    showFinest(tile);
  }

  /** Which level-of-detail rings a tile is in now: [near wanted, mid wanted], and whether it may be kept. */
  const ringOf = (distance) => {
    const d = level03(graphics().drawDistance, 2);
    return { near: distance < NEAR_RADIUS[d], mid: distance < MID_RADIUS[d], keepNear: distance < NEAR_RADIUS[d] + NEAR_HYSTERESIS, keepMid: distance < MID_RADIUS[d] + MID_HYSTERESIS };
  };

  /** Recompute releases and the ordered list of tile levels to request. */
  function schedule() {
    camera.scheduledX = camera.x; camera.scheduledZ = camera.z; camera.timer = RESCHEDULE_SECONDS;
    for (const tile of tiles.values()) {
      const ring = ringOf(rectDistance(tile.tx, tile.tz, camera.x, camera.z));
      if (tile.installing) continue;                 // a level change in progress is finished first
      if (tile.levels[NEAR] && !ring.keepNear) release(tile, NEAR);
      if (tile.levels[MID] && !ring.keepMid) release(tile, MID);
    }
    const list = []; let pending = 0, skyline = 0;
    const d = level03(graphics().drawDistance, 2), reach = MID_RADIUS[d];
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
      const flags = content[slot(tx, tz)]; if (!flags) continue;
      const distance = rectDistance(tx, tz, camera.x, camera.z), tile = tiles.get(tx + ',' + tz);
      const missing = (level) => !tile || ((!tile.levels[level] || stale(tile.levels[level])) && !tile.failed[level]);
      const cx = (tx + 0.5) * tileSize - camera.x, cz = (tz + 0.5) * tileSize - camera.z, l = Math.hypot(cx, cz) || 1, ahead = (cx * camera.dirX + cz * camera.dirZ) / l;
      // Order: the near ring, then the skyline of the whole city, then the mid ring; nearer and ahead first.
      if (distance < NEAR_RADIUS[d] && missing(NEAR)) { pending++; list.push({ tx, tz, level: NEAR, cost: distance - AHEAD_BONUS * ahead }); }
      if ((flags & SOLID) && missing(FAR)) { skyline++; list.push({ tx, tz, level: FAR, cost: 1000 + distance * 0.01 }); }
      if (distance < reach && missing(MID)) { pending++; list.push({ tx, tz, level: MID, cost: 2000 + distance - AHEAD_BONUS * ahead }); }
    }
    list.sort((a, b) => b.cost - a.cost);          // cheapest last, so that requests pop from the end
    candidates = list; stats.tilesPending = pending; stats.skylinePending = skyline;
  }

  function request() {
    while (inFlight < IN_FLIGHT && candidates.length) {
      const c = candidates.pop(), tile = tileAt(c.tx, c.tz);
      // The list is a little out of date by the time an entry is reached: skip what is under way or has arrived.
      if (tile.flying[c.level] || (tile.levels[c.level] && !stale(tile.levels[c.level]))) continue;
      tile.flying[c.level] = true; inFlight++; requests.set(nextRequest, { tile, level: c.level });
      worker.postMessage({ type: 'tile', id: nextRequest++, tx: c.tx, tz: c.tz, level: c.level, density }, []);
    }
  }

  onTile = (message) => {
    const p = message.payload, tile = tileAt(p.tx, p.tz);
    inFlight--; requests.delete(message.id);
    stats.workerMs = stats.workerMs ? stats.workerMs * 0.9 + message.ms * 0.1 : message.ms;
    // `flying` stays set until the level is installed, so that it is not asked for a second time meanwhile.
    uploads.push({ payload: p, tile, density: message.density, stage: 'meshes', meshes: [], next: 0, old: null });
    request();
  };
  onTileError = (message) => {
    // A tile that cannot be built is left out rather than asked for again every frame; the reason is logged once.
    console.error('world: ' + message.message);
    const failed = requests.get(message.id); if (!failed) return;
    requests.delete(message.id); inFlight--; failed.tile.flying[failed.level] = false; failed.tile.failed[failed.level] = true;
    request();
  };

  /**
   * One step of an upload; returns true when the tile level is installed (or dropped). The steps are small so
   * that the frame can stop between them: one mesh, then the swap of the tile meshes, then a few instance groups
   * at a time. The level shown before keeps its instances until the new ones are all in, so nothing blinks.
   */
  function uploadStep(job) {
    const p = job.payload, tile = job.tile;
    if (job.stage === 'meshes') {
      if (job.next === 0) {
        // Dropped if the camera has left its ring while it was being built.
        const ring = ringOf(rectDistance(p.tx, p.tz, camera.x, camera.z));
        if ((p.level === NEAR && !ring.keepNear) || (p.level === MID && !ring.keepMid)) { tile.flying[p.level] = false; return true; }
      }
      if (job.next < p.meshes.length) { job.meshes.push(renderer.createMesh(p.meshes[job.next++])); return false; }
      job.stage = 'install'; return false;
    }
    if (job.stage === 'install') {
      if (tile.levels[p.level]) release(tile, p.level, true);      // replaced after a density change
      const record = { level: p.level, density: job.density, meshes: job.meshes, castShadow: p.castShadow, instances: p.instances, lights: p.lights, glows: p.glows, statics: [], batches: [] };
      tile.levels[p.level] = record; stats.tilesLoaded++; tile.flying[p.level] = false;
      if (p.level === NEAR) physics.addTile(tile.key, p.colliders, p.tx * tileSize, p.tz * tileSize);
      if (tile.shown >= 0 && tile.shown < p.level) return true;    // a finer level is on show; this one waits its turn
      job.old = tile.shown >= 0 ? tile.levels[tile.shown] : null; tile.installing = true;
      addStatics(tile, record); if (job.old) removeAll(job.old.statics);
      job.next = 0; job.stage = 'batches'; return false;
    }
    const record = tile.levels[p.level], to = Math.min(record.instances.length, job.next + GROUPS_PER_STEP);
    addBatches(record, job.next, to); job.next = to;
    if (to < record.instances.length) return false;
    if (job.old) removeAll(job.old.batches);
    setLights(tile, record); tile.shown = p.level; tile.installing = false;
    if (p.level === NEAR) onTileLoaded({ key: tile.key, tx: p.tx, tz: p.tz, level: p.level, parked: p.parked });
    return true;
  }

  schedule(); request();          // the worker starts on the first scene while the page loads everything else

  return {
    plan, stats,

    /** Requests, time-budgeted uploads and releases. cameraPosition: [x, y, z]. */
    update(cameraPosition, dt) {
      const x = cameraPosition[0], z = cameraPosition[2], mx = x - camera.x, mz = z - camera.z, moved = Math.hypot(mx, mz);
      if (moved > 0.05 && moved < 200) {
        // The view follows the direction of travel; smoothed so that a slide does not reshuffle the queue.
        const k = Math.min(1, dt * 3), dx = camera.dirX + (mx / moved - camera.dirX) * k, dz = camera.dirZ + (mz / moved - camera.dirZ) * k, l = Math.hypot(dx, dz) || 1;
        camera.dirX = dx / l; camera.dirZ = dz / l;
      }
      camera.x = x; camera.z = z; camera.timer -= dt;
      const start = now();
      if (camera.timer <= 0 || Math.hypot(x - camera.scheduledX, z - camera.scheduledZ) > RESCHEDULE_METRES) schedule();
      while (now() - start < UPLOAD_BUDGET_MS) {
        if (!active) {
          if (!uploads.length) break;
          let best = 0;
          for (let i = 1; i < uploads.length; i++) if (uploadOrder(uploads[i], x, z) < uploadOrder(uploads[best], x, z)) best = i;
          active = uploads[best]; uploads[best] = uploads[uploads.length - 1]; uploads.pop();
        }
        if (uploadStep(active)) active = null;
      }
      request();
    },

    /** Are all near tiles within `radius` of a point loaded (renderer and physics)? position: [x, y, z]. */
    isReady(position, radius) {
      const x = position[0], z = position[2];
      for (let tz = Math.floor((z - radius) / tileSize); tz <= Math.floor((z + radius) / tileSize); tz++) for (let tx = Math.floor((x - radius) / tileSize); tx <= Math.floor((x + radius) / tileSize); tx++) {
        const s = slot(tx, tz); if (s < 0 || !content[s] || rectDistance(tx, tz, x, z) > radius) continue;
        const tile = tiles.get(tx + ',' + tz);
        if (!tile || ((!tile.levels[NEAR] || tile.installing) && !tile.failed[NEAR])) return false;
      }
      return true;
    },

    /** The plan's answer at a point (one reused object; copy what you keep). */
    field: plan.field,

    /** Lore name of the district at a point, '' over open water. */
    districtAt(x, z) { const d = plan.districtAt(x, z); return d ? d.gameName : ''; },

    /** Planting and furniture density, 0..3 from settings. Loaded tiles are rebuilt in the background. */
    setDensity(level) {
      const next = level03(level, density); if (next === density) return;
      density = next; schedule(); request();
    },

    drawMinimap(ctx, centreX, centreZ, heading, metresAcross, sizePx) { drawMinimap(ctx, data.minimap, centreX, centreZ, heading, metresAcross, sizePx); },

    /** Notes from start-up: collaborators that were replaced by stand-ins, and layout issues. */
    notes: ready.notes, issues: ready.issues,
  };
}
