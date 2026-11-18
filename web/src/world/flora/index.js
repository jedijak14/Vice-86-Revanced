// Flora prototypes: palms, broadleaf trees, shrubs, hedge, flowerbed and ground-level planting.
// See design/ARCHITECTURE.md section 9.3 for the record layout and the catalogue names.

import { clamp, lerp } from '../../core/math.js';
import { PALMS } from './palms.js';
import { TREES } from './trees.js';
import { PLANTS } from './plants.js';

const EMPTY = new Float32Array(0);
// Hand-over distances of the three palm levels, in metres at full detail.
const PALM_LOD = [45, 150, 700], SMALL_PALM_LOD = [30, 95, 300];

function palmRecipe(p) {
  const parts = [0, 1, 2].map((level) => p.make(p.v, level)), near = parts[0];
  return {
    name: p.name, tags: p.tags, lod: p.small ? SMALL_PALM_LOD : PALM_LOD, meshes: parts.map((part) => part.mb),
    // The trunk is what a car hits; the crown is far above the road.
    collider: { kind: 'cylinder', radius: Math.round(near.trunkRadius * 100) / 100, height: Math.round(near.clear * 10) / 10 },
    footprint: Math.round((near.trunkRadius + 0.35) * 100) / 100,
  };
}
const plantRecipe = (p, reach) => ({ ...p, meshes: p.lod.map((_, level) => p.build(level, Math.round(p.lod[p.lod.length - 1] * reach))) });

/**
 * Build every flora prototype.
 * detail: 0 | 1 | 2 (low, medium, high; default 2), as in section 9.3. It does not change the shapes, so every
 * preset shares one set of silhouettes; it scales the distances at which the levels hand over and at which
 * ground flora is cut off (0 -> 55 percent of the full-detail distances, 1 -> 78 percent). Grass cards carry
 * their cut-off distance so the shader can thin them away before it.
 * Each prototype follows section 9.3, plus `canopy: { radius, base }`: the horizontal reach of the
 * crown and the height at which it starts, for planners that want to keep crowns off facades.
 */
export function buildPrototypes(detail = 2) {
  const reach = lerp(0.55, 1, clamp(detail / 2, 0, 1));
  return [...PALMS.map(palmRecipe), ...TREES.map((p) => plantRecipe(p, reach)), ...PLANTS.map((p) => plantRecipe(p, reach))].map((r) => {
    const bounds = r.meshes[0].bounds(), lods = [];
    let near = 0;
    r.meshes.forEach((mb, i) => { const far = Math.round(r.lod[i] * reach); lods.push({ mesh: mb.finish(), near, far }); near = far; });
    const radius = Math.max(Math.abs(bounds[0]), Math.abs(bounds[3]), Math.abs(bounds[2]), Math.abs(bounds[5]));
    return {
      name: r.name, lods, lights: EMPTY, glows: EMPTY, collider: r.collider, footprint: r.footprint,
      height: Math.round(bounds[4] * 100) / 100, tags: r.tags,
      canopy: { radius: Math.round(radius * 100) / 100, base: r.collider && r.collider.kind === 'cylinder' ? r.collider.height : 0 },
    };
  });
}
