// Coast map for the ocean shader and the water-type answer of plan.field. One low-resolution texture over the
// whole map (agreed with the sky and water module): r = signed distance to the shoreline (positive over water),
// g = what the nearest shore is made of, b = how exposed the water is to the open sea. A coarser grid of water
// kinds (ocean, bay, canal, marina) is derived from the same exposure measure.

import { Sample, shoreDistance } from './field.js';

const CELL = 8, MARGIN = 600, COARSE = 4;          // coarse cell = 32 m
const EXACT = 36;                                 // the field's own shore distance is trusted this far
const RAYS = 12, RAY_REACH = 3000, RAY_SHELTER = 1500, RAY_STEP = 2;   // rays march two coarse cells at a time
const SHORE_SAND = 0, SHORE_ROCK = 128, SHORE_WALL = 255;

/**
 * data: field data (bounds, landmarks optional); field: createField(data).
 * Returns { data: Uint8Array(width * height * 4), width, height, minX, minZ, cell, kinds, kindWidth, kindHeight, kindCell }.
 */
export function buildCoastMap(data, field, marinas = []) {
  const [bx0, bz0, bx1, bz1] = data.bounds, minX = bx0 - MARGIN, minZ = bz0 - MARGIN;
  const width = Math.ceil((bx1 - bx0 + 2 * MARGIN) / CELL / COARSE) * COARSE, height = Math.ceil((bz1 - bz0 + 2 * MARGIN) / CELL / COARSE) * COARSE, N = width * height;
  const exact = new Float32Array(N).fill(-1e3), shoreKind = new Uint8Array(N), water = new Uint8Array(N).fill(1), S = new Sample();
  // Sample the field only where there can be land: inside the plan bounds plus the reach of the sea bed.
  const i0 = Math.max(0, Math.floor((bx0 - 64 - minX) / CELL)), i1 = Math.min(width, Math.ceil((bx1 + 64 - minX) / CELL));
  const j0 = Math.max(0, Math.floor((bz0 - 64 - minZ) / CELL)), j1 = Math.min(height, Math.ceil((bz1 + 64 - minZ) / CELL));
  // One sample per coarse block first: a block whose centre is farther from any shore than its own half
  // diagonal plus the trusted range is all land or all water and needs no fine samples.
  const block = COARSE * CELL, skip = EXACT + block * 0.71 + 1;
  for (let j = Math.floor(j0 / COARSE) * COARSE; j < j1; j += COARSE) for (let i = Math.floor(i0 / COARSE) * COARSE; i < i1; i += COARSE) {
    const c = field.sample(minX + i * CELL + block / 2, minZ + j * CELL + block / 2, S), dc = shoreDistance(c), uniform = Math.abs(dc) > skip && Math.abs(c.lr) > skip;
    for (let jj = j; jj < j + COARSE; jj++) for (let ii = i; ii < i + COARSE; ii++) {
      const k = jj * width + ii;
      if (uniform) { exact[k] = dc < 0 ? -1e3 : 1e3; water[k] = dc < 0 ? 1 : 0; continue; }
      const s = field.sample(minX + (ii + 0.5) * CELL, minZ + (jj + 0.5) * CELL, S), d = shoreDistance(s);
      exact[k] = d; water[k] = d < 0 ? 1 : 0;
      shoreKind[k] = s.ds > -30 || s.run > 12 ? SHORE_SAND : s.run > 0.5 ? SHORE_ROCK : SHORE_WALL;
    }
  }

  // Nearest cell of the other kind for every cell (two-pass vector distance transform).
  const nearest = (target) => {
    const dx = new Int16Array(N), dz = new Int16Array(N), BIG = 16000;
    for (let k = 0; k < N; k++) if (water[k] !== target) { dx[k] = BIG; dz[k] = BIG; }
    const relax = (k, i, j, oi, oj) => {
      const ni = i + oi, nj = j + oj; if (ni < 0 || nj < 0 || ni >= width || nj >= height) return;
      const n = nj * width + ni; if (dx[n] === BIG) return;
      const cx = dx[n] + oi, cz = dz[n] + oj;
      if (dx[k] === BIG || cx * cx + cz * cz < dx[k] * dx[k] + dz[k] * dz[k]) { dx[k] = cx; dz[k] = cz; }
    };
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) { const k = j * width + i; relax(k, i, j, -1, 0); relax(k, i, j, 0, -1); relax(k, i, j, -1, -1); relax(k, i, j, 1, -1); }
      for (let i = width - 1; i >= 0; i--) relax(j * width + i, i, j, 1, 0);
    }
    for (let j = height - 1; j >= 0; j--) {
      for (let i = width - 1; i >= 0; i--) { const k = j * width + i; relax(k, i, j, 1, 0); relax(k, i, j, 0, 1); relax(k, i, j, 1, 1); relax(k, i, j, -1, 1); }
      for (let i = 0; i < width; i++) relax(j * width + i, i, j, -1, 0);
    }
    return { dx, dz };
  };
  const toLand = nearest(0), toWater = nearest(1);

  // Exposure on the coarse grid: a ray scores 1 if it reaches the open sea beyond the map, a little if it at
  // least crosses a wide stretch of water, nothing if it runs into land close by.
  const cw = width / COARSE, ch = height / COARSE, coarse = COARSE * CELL, exposure = new Float32Array(cw * ch), open = new Float32Array(cw * ch);
  const wet = (ci, cj) => ci < 0 || cj < 0 || ci >= cw || cj >= ch || water[(cj * COARSE + (COARSE >> 1)) * width + ci * COARSE + (COARSE >> 1)] === 1;
  const steps = Math.ceil(RAY_REACH / coarse / RAY_STEP);
  for (let cj = 0; cj < ch; cj++) for (let ci = 0; ci < cw; ci++) {
    if (!wet(ci, cj)) continue;
    let score = 0, wide = 0;
    for (let r = 0; r < RAYS; r++) {
      const a = (r + 0.5) / RAYS * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a); let reach = steps;
      for (let t = 1; t <= steps; t++) {
        const pi = Math.round(ci + ux * t * RAY_STEP), pj = Math.round(cj + uz * t * RAY_STEP);
        if (pi < 0 || pj < 0 || pi >= cw || pj >= ch) break;                    // left the map over water: open sea
        if (!wet(pi, pj)) { reach = t - 1; break; }
      }
      const metres = reach * coarse * RAY_STEP;
      score += reach === steps ? 1 : metres >= RAY_SHELTER ? 0.35 : 0;
      if (metres >= 220) wide++;
    }
    exposure[cj * cw + ci] = score / RAYS; open[cj * cw + ci] = wide / RAYS;
  }
  // Spread exposure onto land cells next to water so that the bilinear lookup near shores is not darkened.
  const filled = exposure.slice();
  for (let cj = 0; cj < ch; cj++) for (let ci = 0; ci < cw; ci++) {
    if (wet(ci, cj)) continue; let sum = 0, n = 0;
    for (let oj = -1; oj <= 1; oj++) for (let oi = -1; oi <= 1; oi++) { const pi = ci + oi, pj = cj + oj; if (pi >= 0 && pj >= 0 && pi < cw && pj < ch && wet(pi, pj)) { sum += exposure[pj * cw + pi]; n++; } }
    filled[cj * cw + ci] = n ? sum / n : 0;
  }
  const kinds = new Uint8Array(cw * ch);
  for (let cj = 0; cj < ch; cj++) for (let ci = 0; ci < cw; ci++) {
    const k = cj * cw + ci, e = filled[k], x = minX + (ci + 0.5) * coarse, z = minZ + (cj + 0.5) * coarse;
    let kind = e >= 0.3 ? 0 : open[k] >= 0.4 || !wet(ci, cj) ? 1 : 2;
    if (kind !== 0 && marinas.some((m) => Math.hypot(m[0] - x, m[1] - z) < 150)) kind = 3;
    kinds[k] = kind;
  }

  const out = new Uint8Array(N * 4);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const k = j * width + i, w = water[k] === 1, v = w ? toLand : toWater;
    const far = v.dx[k] === 16000 ? 1e4 : Math.max(0, Math.hypot(v.dx[k], v.dz[k]) - 0.5) * CELL;
    const d = Math.abs(exact[k]) < EXACT ? -exact[k] : w ? Math.max(EXACT, far) : -Math.max(EXACT, far);
    const shoreCell = w && v.dx[k] !== 16000 ? k + v.dz[k] * width + v.dx[k] : k;
    // Exposure: bilinear from the coarse grid.
    const fx = Math.min(cw - 1.001, Math.max(0, (i + 0.5) / COARSE - 0.5)), fz = Math.min(ch - 1.001, Math.max(0, (j + 0.5) / COARSE - 0.5)), ci = Math.floor(fx), cj = Math.floor(fz), tx = fx - ci, tz = fz - cj;
    const e = (filled[cj * cw + ci] * (1 - tx) + filled[cj * cw + ci + 1] * tx) * (1 - tz) + (filled[(cj + 1) * cw + ci] * (1 - tx) + filled[(cj + 1) * cw + ci + 1] * tx) * tz;
    out[k * 4] = 128 + Math.round(Math.max(-127, Math.min(127, d / 2)));
    out[k * 4 + 1] = shoreKind[shoreCell];
    out[k * 4 + 2] = Math.round(255 * Math.min(1, e / 0.45));
    out[k * 4 + 3] = 255;
  }
  return { data: out, width, height, minX, minZ, cell: CELL, kinds, kindWidth: cw, kindHeight: ch, kindCell: coarse };
}
