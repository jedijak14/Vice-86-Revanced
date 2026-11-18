// Secondary streets. The traced roads are the lore-accurate primary network, but they leave some very large
// blocks. Wherever a district has a block grid, grid lines that run through ground farther than a block's depth
// from any road become two-lane streets or service lanes, ending on existing roads at T or cross junctions.
// Parks, golf, the airport, gardens and beaches are never subdivided (their districts have no grid, and the
// buildable test below excludes parks, sand and the shore strip).

import { buildPolygonSet, queryPolygonSet, segmentIntersection, pointInPolygon } from './geom.js';
import { yawFromLayoutDeg } from './layout.js';

const DEEP = 68;            // a line is worth building if it passes at least this far from every road
const PARALLEL = 34;        // and never runs closer than this alongside one
const MIN_LENGTH = 70;
const STEP = 6;

/** Nearest-road distance from sampled centre-line points in a coarse hash grid (exact enough for planning). */
class RoadProbe {
  constructor() { this.cells = new Map(); this.size = 48; }
  add(points, halfWidth) {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
      for (let k = 0; k <= n; k++) {
        const x = a[0] + (b[0] - a[0]) * k / n, z = a[1] + (b[1] - a[1]) * k / n, key = Math.floor(x / this.size) + ',' + Math.floor(z / this.size);
        let c = this.cells.get(key); if (!c) this.cells.set(key, c = []); c.push(x, z, halfWidth);
      }
    }
  }
  /** Distance to the nearest carriageway edge, capped at two cells. */
  distance(x, z) {
    const cx = Math.floor(x / this.size), cz = Math.floor(z / this.size); let best = this.size * 2;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const c = this.cells.get((cx + dx) + ',' + (cz + dz)); if (!c) continue;
      for (let i = 0; i < c.length; i += 3) { const d = Math.hypot(c[i] - x, c[i + 1] - z) - c[i + 2]; if (d < best) best = d; }
    }
    return best;
  }
}

/** Returns generated road records to append to layout.roads. */
export function infillStreets(layout) {
  const ext = layout.extent, bounds = [ext.minX, ext.minZ, ext.maxX, ext.maxZ], q = {};
  const land = buildPolygonSet(layout.landmasses.map((l) => l.polygon), bounds, 32, 30);
  const parks = buildPolygonSet(layout.parks.map((p) => p.polygon), bounds, 32, 14);
  const beach = buildPolygonSet(layout.beaches.map((b) => b.polygon), bounds, 32, 14);
  const probe = new RoadProbe();
  const roads = layout.roads.map((r) => ({ points: r.points, hw: r.width / 2 }));
  for (const r of roads) probe.add(r.points, r.hw);
  const reserved = layout.landmarks.map((m) => { const yaw = yawFromLayoutDeg(m.yawDeg); return [m.pos[0], m.pos[1], m.footprint[0] / 2 + 10, m.footprint[1] / 2 + 10, Math.cos(yaw), Math.sin(yaw)]; });
  const inReserved = (x, z) => reserved.some((r) => { const dx = x - r[0], dz = z - r[1]; return Math.abs(dx * r[4] - dz * r[5]) < r[2] && Math.abs(dx * r[5] + dz * r[4]) < r[3]; });
  const out = [];

  for (const district of layout.districts) {
    const grid = district.grid; if (!grid) continue;
    const a = grid.angleDeg * Math.PI / 180, ux = Math.cos(a), uz = Math.sin(a), vx = -uz, vz = ux, [ox, oz] = grid.origin;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of district.polygon) { const u = (p[0] - ox) * ux + (p[1] - oz) * uz, v = (p[0] - ox) * vx + (p[1] - oz) * vz; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const buildable = (x, z) => pointInPolygon(x, z, district.polygon) && queryPolygonSet(land, x, z, q) >= 0 && q.dist > 24
      && (queryPolygonSet(parks, x, z, q) < 0 && q.dist > 8) && (queryPolygonSet(beach, x, z, q) < 0 && q.dist > 8) && !inReserved(x, z);
    // Lines across the short side of the blocks first: they do most to open up a deep block.
    const families = [
      { along: [vx, vz], across: [ux, uz], block: grid.blockX, lo: u0, hi: u1, from: v0, to: v1 },
      { along: [ux, uz], across: [vx, vz], block: grid.blockZ, lo: v0, hi: v1, from: u0, to: u1 },
    ].sort((f, g) => f.block - g.block);
    for (const fam of families) for (let k = Math.ceil(fam.lo / fam.block); k * fam.block <= fam.hi; k++) {
      const bx = ox + fam.across[0] * k * fam.block, bz = oz + fam.across[1] * k * fam.block;
      const at = (t) => [bx + fam.along[0] * t, bz + fam.along[1] * t];
      const A = at(fam.from - 20), B = at(fam.to + 20), span = fam.to - fam.from + 40;
      // Where the line meets existing roads, and how squarely.
      const crossings = [];
      for (const r of roads) for (let i = 0; i + 1 < r.points.length; i++) {
        const t = segmentIntersection(A, B, r.points[i], r.points[i + 1]); if (t < 0) continue;
        const ex = r.points[i + 1][0] - r.points[i][0], ez = r.points[i + 1][1] - r.points[i][1], l = Math.hypot(ex, ez) || 1;
        crossings.push({ t: fam.from - 20 + t * span, sin: Math.abs(fam.along[0] * ez - fam.along[1] * ex) / l, hw: r.hw });
      }
      crossings.sort((p, r) => p.t - r.t);
      const ends = [{ t: fam.from - 20, open: true }, ...crossings, { t: fam.to + 20, open: true }];
      for (let c = 0; c + 1 < ends.length; c++) {
        let t0 = ends[c].t, t1 = ends[c + 1].t, c0 = !ends[c].open && ends[c].sin > 0.64, c1 = !ends[c + 1].open && ends[c + 1].sin > 0.64;
        if ((!ends[c].open && !c0) || (!ends[c + 1].open && !c1)) continue;       // would meet a road at a poor angle
        // Trim to the buildable run that touches a connected end.
        const ok = []; for (let t = t0 + STEP; t < t1 - STEP / 2; t += STEP) { const p = at(t); ok.push(buildable(p[0], p[1])); }
        let first = 0, last = ok.length - 1;
        if (c0) { last = 0; while (last + 1 < ok.length && ok[last + 1] && ok[last]) last++; if (!ok[0]) continue; if (last < ok.length - 1) { c1 = false; t1 = t0 + STEP * (last + 1); } }
        else if (c1) { first = ok.length - 1; while (first > 0 && ok[first - 1] && ok[first]) first--; if (!ok[ok.length - 1]) continue; t0 = t0 + STEP * (first + 1); }
        else continue;
        const length = t1 - t0;
        if (length < MIN_LENGTH || (!(c0 && c1) && length < 110)) continue;
        // A junction must not land beside an existing one.
        const crowded = (t, connected) => connected && layout.junctions.some((j) => { const p = at(t), d = Math.hypot(j.pos[0] - p[0], j.pos[1] - p[1]); return d > 2 && d < 30; });
        if (crowded(t0, c0) || crowded(t1, c1)) continue;
        let deep = 0, tight = Infinity;
        for (let t = t0 + STEP; t < t1; t += STEP) {
          const p = at(t), d = probe.distance(p[0], p[1]); if (d > deep) deep = d;
          if (Math.min(t - t0, t1 - t) > 40 || (!c0 && t - t0 < 40) || (!c1 && t1 - t < 40)) tight = Math.min(tight, d);
        }
        if (deep < DEEP || tight < PARALLEL) continue;
        const lane = k % 2 !== 0;
        const industrial = district.style === 'industrial_port';
        const road = {
          id: `${district.id}_infill_${out.length + 1}`, name: '', class: lane ? 'service' : 'street', planClass: lane ? 'lane' : 'street',
          points: [at(t0), at((t0 + t1) / 2), at(t1)], width: lane ? 7 : 10, median: false, oneWay: false, lanesPerDirection: 1,
          sidewalk: !(lane && industrial), pavementWidth: lane && industrial ? 0 : lane ? 2 : 2.5, speedLimitKmh: lane ? 25 : 40,
          district: district.id, surface: null, bridge: null, generated: true,
        };
        out.push(road); roads.push({ points: road.points, hw: road.width / 2 }); probe.add(road.points, road.width / 2);
      }
    }
  }
  return out;
}
