// The wake field: a shallow-water wave equation on a grid that follows the action, so the water
// remembers what went through it. A hull pushes the surface down by its immersion every step; the
// push spreads as a ring at the shallow-water speed; rings from the same hull interfere into the
// V of a wake; and the whole grid recentres itself under the player so the memory is always where
// the boats are. Below Ultra nothing samples it and it never steps: the sea stays the flat plane
// it has always been. Above, boats float on the sum of the ocean's own trains and this field, and
// a boat meets its own wake coming back at it, which is the whole difference between water and a
// moving floor.
//
// The integration is the standard second-order leapfrog on the Laplacian, damped, with a slow
// leak so a closed basin settles instead of ringing forever. Two substeps keep c*dt/dx far inside
// the stability limit at any frame rate the game runs.

/** Cells a side, and the metres they cover: about 2.3 m of water per cell. */
export const FIELD_CELLS = 96;
export const FIELD_EXTENT = 220;

export function createWaterField({ cells = FIELD_CELLS, extent = FIELD_EXTENT, speed = 12, damp = 0.986 } = {}) {
  const dx = extent / cells;
  const c2 = (speed * speed) / (dx * dx);
  let h = new Float32Array(cells * cells);
  let v = new Float32Array(cells * cells);
  let cx = 0, cz = 0;

  const cellOf = (x) => (x - (cx - extent / 2)) / dx;

  /** Move the window in whole cells; what slides out of the world is forgotten. */
  function recenter(nx, nz) {
    const sx = Math.round((nx - cx) / dx), sz = Math.round((nz - cz) / dx);
    if (!sx && !sz) return;
    if (Math.abs(sx) >= cells || Math.abs(sz) >= cells) { h.fill(0); v.fill(0); cx = nx; cz = nz; return; }
    const nh = new Float32Array(cells * cells), nv = new Float32Array(cells * cells);
    for (let z = 0; z < cells; z++) {
      const z0 = z - sz;
      if (z0 < 0 || z0 >= cells) continue;
      for (let x = 0; x < cells; x++) {
        const x0 = x - sx;
        if (x0 < 0 || x0 >= cells) continue;
        nh[z * cells + x] = h[z0 * cells + x0];
        nv[z * cells + x] = v[z0 * cells + x0];
      }
    }
    h = nh; v = nv; cx += sx * dx; cz += sz * dx;
  }

  /**
   * Push the surface: a gaussian dip (negative amount) or a crest, in metres per second of
   * velocity. This is what a hull, a swimmer or a dropped body does to water.
   */
  function splash(x, z, radius, amount) {
    const gx = cellOf(x), gz = cellOf(z), r = Math.max(1, radius / dx);
    const x0 = Math.max(1, Math.floor(gx - r)), x1 = Math.min(cells - 2, Math.ceil(gx + r));
    const z0 = Math.max(1, Math.floor(gz - r)), z1 = Math.min(cells - 2, Math.ceil(gz + r));
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = ((x - gx) * (x - gx) + (z - gz) * (z - gz)) / (r * r);
        if (d2 > 1) continue;
        v[z * cells + x] += amount * Math.exp(-3 * d2);
      }
    }
  }

  /** Bilinear height at a world point; zero outside the window, where the sea is only its trains. */
  function height(x, z) {
    const gx = cellOf(x) - 0.5, gz = cellOf(z) - 0.5;
    if (gx < 0 || gz < 0 || gx > cells - 2 || gz > cells - 2) return 0;
    const x0 = gx | 0, z0 = gz | 0, fx = gx - x0, fz = gz - z0;
    const i = z0 * cells + x0;
    const a = h[i], b = h[i + 1], c = h[i + cells], d = h[i + cells + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  /** The surface gradient, for foam and for anything that should slide downhill. */
  function slope(x, z) {
    return [(height(x + dx, z) - height(x - dx, z)) / (2 * dx), (height(x, z + dx) - height(x, z - dx)) / (2 * dx)];
  }

  /** One frame: recentre, then two leapfrog substeps over the Laplacian. */
  function step(dt, nx, nz) {
    recenter(nx, nz);
    const sdt = dt / 2;
    for (let s = 0; s < 2; s++) {
      for (let z = 1; z < cells - 1; z++) {
        const row = z * cells;
        for (let x = 1; x < cells - 1; x++) {
          const i = row + x;
          const lap = h[i - 1] + h[i + 1] + h[i - cells] + h[i + cells] - 4 * h[i];
          v[i] = (v[i] + lap * c2 * sdt) * damp;
        }
      }
      for (let i = 0; i < h.length; i++) h[i] = (h[i] + v[i] * sdt) * 0.9995;
    }
  }

  return {
    cells, extent,
    get cell() { return dx; },
    get centre() { return [cx, cz]; },
    splash, height, slope, step, recenter,
  };
}
