// Building lots. Landmarks are reserved first at their researched positions; then every road edge is walked on
// both sides and lots are laid along the frontage, sized for an archetype the district's style calls for; a
// last pass fills the deep interior of large blocks on the district grid. A lot is accepted only where the plan
// field says the ground is free: no carriageway, pavement, water, sand, park, bridge footprint or other lot.

import { TYPE, COVER, Sample } from './field.js';
import { rectsOverlap } from './geom.js';
import { edgePoint } from './network.js';
import { hashInts, hash01 } from '../../core/math.js';

const GROUND_TO_COVER = { paved: COVER.PAVING, lawn: COVER.LAWN, asphalt: COVER.PARKING, concrete: COVER.CONCRETE, sand: COVER.SAND };
/** Ground around a landmark, by kind. */
const LANDMARK_COVER = {
  mansion: COVER.LAWN, house: COVER.LAWN, clubhouse: COVER.LAWN, ruin: COVER.ROUGH, lighthouse: COVER.ROCK, junkyard: COVER.DIRT, compound: COVER.DIRT,
  docks: COVER.CONCRETE, boatyard: COVER.CONCRETE, depot: COVER.CONCRETE, factory: COVER.CONCRETE, hangar: COVER.CONCRETE, military: COVER.CONCRETE,
  garage: COVER.CONCRETE, showroom: COVER.PARKING, mall: COVER.PARKING, stadium: COVER.PAVERS, terminal: COVER.CONCRETE, marina: COVER.PAVERS,
};
/** Gap between neighbouring lots by district style; zero makes party walls. */
const STYLE_GAP = { artdeco_beach: 0, downtown: 0, latin_quarter: 0, beach_resort: 2, hotel_strip: 6, residential_poor: 3, industrial_port: 6, mansion_island: 12, studio_island: 8, airport: 14, military: 12, golf: 20 };
/** Styles whose block interiors may be filled with further buildings. */
const FILL_STYLES = new Set(['downtown', 'industrial_port', 'hotel_strip', 'studio_island', 'military']);
const SHORE_MARGIN = 5;
/** Landmark kinds that belong on the water's edge and may reach over it. */
const MIN_LANDMARK_PLOT = 10;   // metres: a landmark plot is not reduced below this
const LANDMARK_PROBE = 6;       // metres between the samples that test a landmark plot (narrower than any road with its pavements)
const LANDMARK_RINGS = 4;       // rings of candidate positions tried around the researched point
const WATERSIDE = new Set(['marina', 'docks', 'boatyard', 'lighthouse']);

/**
 * plan pieces: { layout, net, field (created without lots), fieldData }, deps: { ARCHETYPES, archetypesFor, landmarkLot }.
 * Returns lots in the buildings contract ({ id, x, z, yaw, width, depth, district, style, archetype, floors, seed,
 * corner, attached, landmark }) plus planner fields: cover (COVER id), edge (frontage edge or -1), index.
 */
export function buildLots({ layout, net, field, fieldData }, deps, issues) {
  const lots = [], rects = [], S = new Sample();
  // Spatial hash of accepted rectangles for the overlap test.
  const cell = 48, hash = new Map();
  const cellsOf = (r, fn) => { const rad = Math.hypot(r[2], r[3]); for (let cz = Math.floor((r[1] - rad) / cell); cz <= Math.floor((r[1] + rad) / cell); cz++) for (let cx = Math.floor((r[0] - rad) / cell); cx <= Math.floor((r[0] + rad) / cell); cx++) if (fn(cx + ',' + cz)) return true; return false; };
  const collides = (r, gap) => cellsOf(r, (key) => { const list = hash.get(key); return !!list && list.some((i) => rectsOverlap(rects[i], r, gap - 0.01)); });
  const accept = (lot) => {
    const r = [lot.x, lot.z, lot.width / 2, lot.depth / 2, Math.cos(lot.yaw), Math.sin(lot.yaw)];
    lot.index = lots.length; lots.push(lot); rects.push(r);
    cellsOf(r, (key) => { let l = hash.get(key); if (!l) hash.set(key, l = []); l.push(lot.index); return false; });
  };
  /** Is the whole rectangle on free land? Sampled along the outline and on an inner lattice. */
  const free = (x, z, hw, hd, cos, sin, district) => {
    const nu = Math.max(2, Math.ceil(hw / 2.5)), nv = Math.max(2, Math.ceil(hd / 2.5));
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      if (i > 0 && i < nu && j > 0 && j < nv && (i % 2 || j % 2)) continue;       // outline fully, interior coarsely
      const u = -hw + 2 * hw * i / nu, v = -hd + 2 * hd * j / nv, s = field.sample(x + u * cos + v * sin, z - u * sin + v * cos, S);
      if (s.type !== TYPE.LAND || s.lr < SHORE_MARGIN || s.g < 1.5 || s.aP < 0.05 || s.park < 0.5 || (district >= 0 && s.district !== district)) return false;
    }
    return true;
  };

  // ---- 1. landmarks
  for (const m of layout.landmarks) {
    const lot = deps.landmarkLot(m), di = layout.districts.findIndex((d) => d.id === m.district);
    Object.assign(lot, { district: m.district, style: di >= 0 ? layout.districts[di].style : 'downtown', corner: 0, attached: { left: false, right: false, back: false }, cover: LANDMARK_COVER[m.kind] ?? COVER.PAVING, edge: -1, landmarkIndex: layout.landmarks.indexOf(m) });
    // A landmark plot must be clear of roads, of other landmarks and (unless it is a waterside place) of the water.
    // Where the researched rectangle is not, take the largest clear one near it: full size first, moved by no more
    // than a third of its shorter side so the researched point stays inside it, then smaller sizes, and at last a
    // plot shrunk about the best position found.
    const cos = Math.cos(lot.yaw), sin = Math.sin(lot.yaw), full = [lot.width, lot.depth], home = [lot.x, lot.z];
    const blocked = (x, z, width, depth) => {
      const nu = Math.max(4, Math.ceil(width / LANDMARK_PROBE)), nv = Math.max(4, Math.ceil(depth / LANDMARK_PROBE));
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const u = (i / nu - 0.5) * width, v = (j / nv - 0.5) * depth, q = field.sample(x + u * cos + v * sin, z - u * sin + v * cos, S);
        if (q.aP < 0 || q.g < 0 || (!WATERSIDE.has(m.kind) && q.lr < 2)) return true;
      }
      return collides([x, z, width / 2, depth / 2, cos, sin], 0);
    };
    const settle = (scale) => {
      const width = full[0] * scale, depth = full[1] * scale, reach = Math.min(full[0], full[1]) / 3;
      for (let ring = 0; ring <= LANDMARK_RINGS; ring++) for (let k = 0; k < (ring ? 8 : 1); k++) {
        const r = reach * ring / LANDMARK_RINGS, x = home[0] + Math.sin(k * Math.PI / 4) * r, z = home[1] + Math.cos(k * Math.PI / 4) * r;
        if (!blocked(x, z, width, depth)) { lot.x = x; lot.z = z; lot.width = width; lot.depth = depth; return true; }
      }
      return false;
    };
    let scale = 1; while (!settle(scale) && Math.min(full[0], full[1]) * scale * 0.85 >= MIN_LANDMARK_PLOT) scale *= 0.85;
    const clear = !blocked(lot.x, lot.z, lot.width, lot.depth);
    if (scale < 1 || lot.x !== home[0] || lot.z !== home[1] || !clear) {
      issues.push({ level: clear ? 'note' : 'warning', what: 'landmark', id: m.id, text: clear
        ? `plot ${full[0]} x ${full[1]} m did not fit at its position: reserved ${lot.width.toFixed(0)} x ${lot.depth.toFixed(0)} m, moved ${Math.hypot(lot.x - home[0], lot.z - home[1]).toFixed(0)} m`
        : 'no plot clear of roads, water and other landmarks near its position' });
    }
    accept(lot);
  }

  // ---- 2. frontage walking, widest roads first so that the main streets get the regular plots
  const pick = (choices, total, r) => { let t = r * total; for (const c of choices) { t -= c.weight; if (t <= 0) return c; } return choices[choices.length - 1]; };
  const styleChoices = new Map();
  const choicesFor = (style) => {
    if (!styleChoices.has(style)) { const list = deps.archetypesFor(style).filter((c) => deps.ARCHETYPES[c.name]); styleChoices.set(style, { list, total: list.reduce((t, c) => t + c.weight, 0) }); }
    return styleChoices.get(style);
  };
  const floorsFor = (arch, district, seed) => {
    const lo = Math.max(arch.floors[0], Math.min(arch.floors[1], district.buildingHeights[0] || 1)), hi = Math.max(lo, Math.min(arch.floors[1], district.buildingHeights[1] || 1));
    return lo + Math.floor((hi - lo + 1) * Math.pow(hash01(seed, 11), 1.9));
  };
  const order = net.edges.map((e) => e.id).sort((a, b) => net.edges[b].hw - net.edges[a].hw || a - b);
  for (const ei of order) {
    const e = net.edges[ei], road = net.roads[e.road];
    if (road.bridge || road.runway) continue;
    const local = (s) => edgePoint(e, s, [0, 0, 0, 0]);
    for (const side of [1, -1]) {
      const start = Math.max(e.setA, 2) + 1, end = e.length - Math.max(e.setB, 2) - 1;
      let s = start, previous = null, tries = 0;
      while (s < end - 8) {
        const p0 = local(s), nx = -p0[3] * side, nz = p0[2] * side;               // outward normal on this side
        const probe = field.sample(p0[0] + nx * (e.hw + e.pw + 3), p0[1] + nz * (e.hw + e.pw + 3), S);
        const district = probe.district >= 0 ? layout.districts[probe.district] : null;
        const choices = district ? choicesFor(district.style) : null;
        if (probe.type !== TYPE.LAND || !choices || !choices.list.length) { s += 6; previous = null; continue; }
        const seed = hashInts(ei, side + 1, Math.round(s * 4) + 977 * tries);
        const c = pick(choices.list, choices.total, hash01(seed, 1)), arch = deps.ARCHETYPES[c.name];
        const gap = STYLE_GAP[district.style] ?? 4;
        // Depth available before the next road, shore or park; back-to-back lots share it.
        let room = 0; for (; room < 2 * arch.maxDepth + 8; room += 4) { const t = field.sample(p0[0] + nx * (e.hw + e.pw + 0.6 + room), p0[1] + nz * (e.hw + e.pw + 0.6 + room), S); if (t.type !== TYPE.LAND || t.lr < SHORE_MARGIN) break; }
        const depthCap = room >= 2 * arch.maxDepth + 8 ? arch.maxDepth : room > arch.maxDepth + arch.minDepth ? room / 2 - 1 : room - 2;
        let placed = null;
        if (depthCap >= arch.minDepth) {
          const wantW = Math.min(arch.maxWidth, Math.max(arch.minWidth, arch.minWidth + (arch.maxWidth - arch.minWidth) * Math.pow(hash01(seed, 2), 1.6)));
          const wantD = Math.min(depthCap, arch.minDepth + (arch.maxDepth - arch.minDepth) * (0.45 + 0.55 * hash01(seed, 3)));
          for (const [fw, fd] of [[1, 1], [0.7, 0.8], [0.3, 0.6], [0, 0]]) {
            const w = Math.min(arch.minWidth + (wantW - arch.minWidth) * fw, end - s), d = arch.minDepth + (wantD - arch.minDepth) * fd;
            if (w < arch.minWidth) break;
            const pm = local(s + w / 2), mx = -pm[3] * side, mz = pm[2] * side, off = e.hw + e.pw + 0.12 + d / 2;
            const x = pm[0] + mx * off, z = pm[1] + mz * off, yaw = Math.atan2(-mx, -mz);   // local +Z faces the street
            const r = [x, z, w / 2, d / 2, Math.cos(yaw), Math.sin(yaw)];
            if (!collides(r, previous && gap === 0 ? 0 : Math.min(gap, 1)) && free(x, z, w / 2, d / 2, r[4], r[5], probe.district)) { placed = { x, z, yaw, width: w, depth: d, tangent: [pm[2], pm[3]] }; break; }
          }
        }
        if (!placed) { tries++; if (tries > 1) { s += 5; tries = 0; previous = null; } continue; }
        tries = 0;
        const lot = {
          id: lots.length, x: placed.x, z: placed.z, yaw: placed.yaw, width: placed.width, depth: placed.depth, district: district.id, style: district.style,
          archetype: arch.name, floors: floorsFor(arch, district, seed), seed, corner: 0, attached: { left: false, right: false, back: false }, landmark: null,
          cover: GROUND_TO_COVER[arch.groundCover] ?? COVER.PAVING, edge: ei,
        };
        // Local +X runs along the street; which way depends on the side of the road the lot is on.
        const xAlong = Math.cos(lot.yaw) * placed.tangent[0] - Math.sin(lot.yaw) * placed.tangent[1] > 0 ? 1 : -1;
        if (previous && gap === 0 && s - previous.end < 0.3) { if (xAlong > 0) { lot.attached.left = true; previous.lot.attached.right = true; } else { lot.attached.right = true; previous.lot.attached.left = true; } }
        if (e.setA > 0 && s - start < 6) lot.corner = xAlong > 0 ? 1 : 2;
        else if (e.setB > 0 && end - (s + placed.width) < 6) lot.corner = xAlong > 0 ? 2 : 1;
        accept(lot);
        previous = { lot, end: s + placed.width };
        s += placed.width + gap * (0.6 + 0.8 * hash01(seed, 5));
      }
    }
  }

  // ---- 3. block fill: free ground deep inside blocks, on the district grid, facing the nearest road
  for (let di = 0; di < layout.districts.length; di++) {
    const district = layout.districts[di]; if (!FILL_STYLES.has(district.style)) continue;
    const choices = choicesFor(district.style); if (!choices.list.length) continue;
    const a = district.grid ? district.grid.angleDeg * Math.PI / 180 : 0, ux = Math.cos(a), uz = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of district.polygon) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const module = 26;
    for (let v = v0 + module / 2; v < v1; v += module) for (let u = u0 + module / 2; u < u1; u += module) {
      const x = u * ux - v * uz, z = u * uz + v * ux, s = field.sample(x, z, S);
      if (s.type !== TYPE.LAND || s.district !== di || s.aP < 30) continue;
      const seed = hashInts(di, Math.round(u), Math.round(v)), c = pick(choices.list, choices.total, hash01(seed, 1)), arch = deps.ARCHETYPES[c.name];
      const w = Math.min(arch.maxWidth, Math.max(arch.minWidth, module * (1 + Math.floor(hash01(seed, 2) * 2)) - 4)), d = Math.min(arch.maxDepth, Math.max(arch.minDepth, module - 4));
      // Face the nearest road: one of the four grid directions.
      let best = null;
      for (let k = 0; k < 4; k++) { const yaw = Math.PI / 2 - a + k * Math.PI / 2, fx = Math.sin(yaw), fz = Math.cos(yaw), t = field.sample(x + fx * 24, z + fz * 24, S); if (!best || t.a < best.a) best = { a: t.a, yaw }; }
      const r = [x, z, w / 2, d / 2, Math.cos(best.yaw), Math.sin(best.yaw)];
      if (collides(r, 3) || !free(x, z, w / 2, d / 2, r[4], r[5], di)) continue;
      accept({ id: lots.length, x, z, yaw: best.yaw, width: w, depth: d, district: district.id, style: district.style, archetype: arch.name, floors: floorsFor(arch, district, seed), seed, corner: 0, attached: { left: false, right: false, back: false }, landmark: null, cover: GROUND_TO_COVER[arch.groundCover] ?? COVER.PAVING, edge: -1 });
    }
  }
  return lots;
}

/** Lots grouped by the tile that contains their centre: Map 'tx,tz' -> [lot index]. */
export function lotsByTile(lots, tile) {
  const map = new Map();
  for (const l of lots) { const key = Math.floor(l.x / tile) + ',' + Math.floor(l.z / tile); let a = map.get(key); if (!a) map.set(key, a = []); a.push(l.index); }
  return map;
}
