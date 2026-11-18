// Loads and validates the researched map (design/map/layout.json). The researcher may still refine the file, so
// the loader is tolerant: a broken record is dropped with a note in `issues`, never a crash, and every optional
// field gets a sensible default here so that the rest of the plan code can read fields without checking.

import { polygonArea, polygonSelfIntersects, pointInPolygon } from './geom.js';

const isPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Remove repeated points and make the winding the layout's (negative shoelace area). */
function cleanPolygon(poly) {
  const out = [];
  for (const p of poly) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) out.push([p[0], p[1]]); }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.05) out.pop();
  if (polygonArea(out) > 0) out.reverse();
  return out;
}

function polygonRecords(list, what, issues, extra) {
  const out = [];
  for (const rec of Array.isArray(list) ? list : []) {
    if (!rec || !Array.isArray(rec.polygon) || rec.polygon.length < 3 || !rec.polygon.every(isPoint)) { issues.push({ level: 'error', what, id: rec && rec.id, text: 'polygon missing or malformed; record dropped' }); continue; }
    const polygon = cleanPolygon(rec.polygon);
    if (polygon.length < 3 || Math.abs(polygonArea(polygon)) < 1) { issues.push({ level: 'error', what, id: rec.id, text: 'polygon has no area; record dropped' }); continue; }
    if (polygonSelfIntersects(polygon)) issues.push({ level: 'warning', what, id: rec.id, text: 'polygon crosses itself' });
    out.push({ ...rec, id: String(rec.id ?? what + out.length), polygon, ...extra(rec) });
  }
  return out;
}

/**
 * Normalise a parsed layout. Returns { meta, extent, landmasses, beaches, districts, roads, junctions, landmarks,
 * parks, spawn, issues }. `issues` lists everything that was repaired or dropped: { level, what, id, text }.
 */
export function normaliseLayout(raw) {
  const issues = [];
  if (!raw || typeof raw !== 'object') throw new Error('layout: not an object');
  const meta = raw.meta || {};
  const landmasses = polygonRecords(raw.landmasses, 'landmass', issues, (r) => ({ kind: r.kind || 'island' }));
  if (!landmasses.length) throw new Error('layout: no landmasses');
  const beaches = polygonRecords(raw.beaches, 'beach', issues, () => ({}));
  const parks = polygonRecords(raw.parks, 'park', issues, (r) => ({ kind: r.kind || 'park' }));
  const districts = polygonRecords(raw.districts, 'district', issues, (r) => ({
    name: r.gameName || r.name || String(r.id), style: r.style || 'residential_poor', buildingHeights: Array.isArray(r.buildingHeights) ? r.buildingHeights : [1, 3],
    grid: r.grid && Number.isFinite(r.grid.angleDeg) ? { angleDeg: r.grid.angleDeg, blockX: r.grid.blockX || 100, blockZ: r.grid.blockZ || 100, streetWidth: r.grid.streetWidth || 12, origin: isPoint(r.grid.origin) ? r.grid.origin : [0, 0] } : null,
  }));

  const roads = [];
  for (const r of Array.isArray(raw.roads) ? raw.roads : []) {
    if (!r || !Array.isArray(r.points) || !r.points.every(isPoint)) { issues.push({ level: 'error', what: 'road', id: r && r.id, text: 'points missing or malformed; road dropped' }); continue; }
    const points = [];
    for (const p of r.points) { const q = points[points.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.2) points.push([p[0], p[1]]); }
    if (points.length < 2) { issues.push({ level: 'error', what: 'road', id: r.id, text: 'fewer than two distinct points; road dropped' }); continue; }
    const width = Number.isFinite(r.width) && r.width >= 4 ? r.width : 10;
    const median = !!r.median, oneWay = !!r.oneWay;
    const perDirection = Math.max(1, Math.round(r.lanesPerDirection || (r.lanes ? (oneWay ? r.lanes : r.lanes / 2) : 1)));
    const sidewalk = r.sidewalk !== false && r.surface !== 'runway';
    roads.push({
      id: String(r.id ?? 'road' + roads.length), name: r.gameName || r.name || '', class: r.class || 'street', planClass: r.planClass || r.class || 'street',
      points, width, median, oneWay, lanesPerDirection: perDirection, sidewalk,
      pavementWidth: sidewalk ? (Number.isFinite(r.pavementWidth) && r.pavementWidth > 0 ? r.pavementWidth : 2.5) : 0,
      speedLimitKmh: Number.isFinite(r.speedLimitKmh) ? r.speedLimitKmh : 50, district: r.district || null, surface: r.surface || null,
      bridge: r.bridge && Number.isFinite(r.bridge.deckY) ? { ...r.bridge } : null, generated: false,
    });
  }
  if (!roads.length) throw new Error('layout: no roads');
  const ids = new Set();
  for (const r of roads) { if (ids.has(r.id)) { issues.push({ level: 'warning', what: 'road', id: r.id, text: 'duplicate id; renamed' }); r.id += '_' + ids.size; } ids.add(r.id); }

  const junctions = (Array.isArray(raw.junctions) ? raw.junctions : []).filter((j) => j && isPoint(j.pos)).map((j) => ({ id: String(j.id), pos: [j.pos[0], j.pos[1]], control: j.control || 'stop' }));
  const landmarks = [];
  for (const m of Array.isArray(raw.landmarks) ? raw.landmarks : []) {
    if (!m || !isPoint(m.pos) || !Array.isArray(m.footprint)) { issues.push({ level: 'error', what: 'landmark', id: m && m.id, text: 'position or footprint missing; landmark dropped' }); continue; }
    // `name` in the layout is the research label; only the game's own name leaves the loader.
    landmarks.push({ ...m, id: String(m.id), name: m.gameName || m.name || String(m.id), yawDeg: m.yawDeg || 0, heightM: m.heightM || 10 });
  }

  let extent = meta.extent;
  if (!extent || !['minX', 'maxX', 'minZ', 'maxZ'].every((k) => Number.isFinite(extent[k]))) {
    extent = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const l of landmasses) for (const p of l.polygon) { extent.minX = Math.min(extent.minX, p[0] - 300); extent.maxX = Math.max(extent.maxX, p[0] + 300); extent.minZ = Math.min(extent.minZ, p[1] - 300); extent.maxZ = Math.max(extent.maxZ, p[1] + 300); }
    issues.push({ level: 'warning', what: 'meta', id: 'extent', text: 'extent missing; derived from the landmasses' });
  }
  for (const d of districts) if (!landmasses.some((l) => d.polygon.some((p) => pointInPolygon(p[0], p[1], l.polygon)))) issues.push({ level: 'warning', what: 'district', id: d.id, text: 'district polygon lies entirely off the land' });
  const spawn = raw.spawn && isPoint(raw.spawn.pos) ? { pos: [raw.spawn.pos[0], raw.spawn.pos[1]], yawDeg: raw.spawn.yawDeg || 0 } : null;
  if (!spawn) issues.push({ level: 'warning', what: 'spawn', id: 'spawn', text: 'spawn missing; the plan picks the longest avenue' });
  return { meta, extent, landmasses, beaches, districts, roads, junctions, landmarks, parks, spawn, issues };
}

/** Layout yaw (degrees, 0 = north = -Z, clockwise from above) to game yaw (radians, 0 = +Z, positive towards +X). */
export const yawFromLayoutDeg = (deg) => Math.PI - deg * Math.PI / 180;
