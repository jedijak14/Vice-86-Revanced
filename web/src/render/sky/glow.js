// The lamp light a city throws into the air at night, as the sky sees it. A coarse plan of how brightly each part of
// the map is lit (built once from the coast map and whatever the game says about its districts) and, every frame, a
// summary of what an observer standing somewhere in it has of that light: how much stands right round and above, and
// how much lies out towards each compass direction. Pure JavaScript: testable without GL.
//
// The dome and the fog get the summary through the Sky block (no texture: the fog chunk runs in every renderer
// shader); the cloud march, which needs the light under any cloud of the sky, reads the plan itself as a texture.

/** Cells along each side of the plan. Lamp light spreads through hundreds of metres of haze, so about 100 m a cell is plenty. */
export const GLOW_MAP_SIDE = 64;
/** The plan reaches this many city radii from the centre: past the last street, so that its rim is dark. */
const REACH = 1.5;
/** How brightly land is lit while the game has not said which district is which. */
const UNKNOWN_DISTRICT = 0.6;
/** Compass directions the far glow is gathered in; enough to resolve the two harmonics the block carries. */
const SECTORS = 12;
/**
 * Where along a level line of sight the far glow is gathered (m) and the length of lit air each sample stands for
 * (km), already thinned by the haze between it and the eye. Air nearer than the first sample is the local term.
 */
const RING_DISTANCE = [900, 1700, 2900, 4500], RING_KM = [0.70, 0.76, 0.86, 0.85];

const SECTOR_X = new Float64Array(SECTORS), SECTOR_Z = new Float64Array(SECTORS);
for (let k = 0; k < SECTORS; k++) { SECTOR_X[k] = Math.cos(k * 2 * Math.PI / SECTORS); SECTOR_Z[k] = Math.sin(k * 2 * Math.PI / SECTORS); }

const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Number of floats glowAround writes. */
export const GLOW_SUMMARY_FLOATS = 6;

export function createGlowMap() {
  const N = GLOW_MAP_SIDE, lit = new Float32Array(N * N), scratch = new Float32Array(N * N), bytes = new Uint8Array(N * N);
  // origin x, z of the first cell's corner and 1 / extent (the plan is square)
  const frame = new Float32Array([-1, -1, 0.5]);

  /** Lit amount 0..1 at a world position, interpolated between cell centres; dark outside the plan. */
  function at(x, z) {
    const u = (x - frame[0]) * frame[2] * N - 0.5, v = (z - frame[1]) * frame[2] * N - 0.5;
    if (!(u > 0 && v > 0 && u < N - 1 && v < N - 1)) return 0;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, o = j * N + i;
    return (lit[o] * (1 - fu) + lit[o + 1] * fu) * (1 - fv) + (lit[o + N] * (1 - fu) + lit[o + N + 1] * fu) * fv;
  }

  return {
    /** Bytes of the plan for an R8 texture, row = z, column = x. */
    bytes,
    /** xy = world xz of the first texel corner, z = 1 / extent. */
    frame,
    at,
    /**
     * (Re)build the plan. city: [centre x, centre z, 1 / radius]. coast: world.plan.coast or null.
     * lights: (x, z) => 0..1, how brightly that spot is lit, or null.
     */
    build(city, coast, lights) {
      const radius = 1 / city[2], extent = 2 * REACH * radius, cell = extent / N;
      frame[0] = city[0] - REACH * radius; frame[1] = city[1] - REACH * radius; frame[2] = 1 / extent;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const x = frame[0] + (i + 0.5) * cell, z = frame[1] + (j + 0.5) * cell;
          // Water is dark. Where the coast map does not reach, the caller's own account of the place stands (it
          // answers 0 outside the map), and with neither there is only the city's radius to go by.
          let land = lights ? 1 : Math.hypot(x - city[0], z - city[1]) < radius ? 1 : 0;
          if (coast) {
            const cx = Math.floor((x - coast.minX) / coast.cell), cz = Math.floor((z - coast.minZ) / coast.cell);
            // the coast map stores 128 + distance / 2, positive over water
            if (cx >= 0 && cz >= 0 && cx < coast.width && cz < coast.height && coast.data[(cz * coast.width + cx) * 4] >= 128) land = 0;
          }
          lit[j * N + i] = land ? (lights ? saturate(lights(x, z)) : UNKNOWN_DISTRICT) : 0;
        }
      }
      // Light spreads sideways in the haze before it comes back down: a block does not glow on its own, a quarter does.
      // Two passes of a 1-2-1 kernel each way; the plan's own rim stays dark so that clamped lookups outside it are too.
      for (let pass = 0; pass < 2; pass++) {
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const o = j * N + i; scratch[o] = 0.5 * lit[o] + 0.25 * (lit[o - (i > 0 ? 1 : 0)] + lit[o + (i < N - 1 ? 1 : 0)]);
        }
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const o = j * N + i, rim = i === 0 || j === 0 || i === N - 1 || j === N - 1;
          lit[o] = rim ? 0 : 0.5 * scratch[o] + 0.25 * (scratch[o - (j > 0 ? N : 0)] + scratch[o + (j < N - 1 ? N : 0)]);
        }
      }
      for (let o = 0; o < N * N; o++) bytes[o] = Math.round(lit[o] * 255);
    },
    /**
     * What an observer at world (x, z) has of the city's light. Writes GLOW_SUMMARY_FLOATS numbers to out at offset o:
     *   [0] lit amount 0..1 of the place itself (the air overhead, the fronts and pavement round about)
     *   [1] lit air along a level line of sight, mean over the compass (km of fully lit haze)
     *   [2] [3] its first harmonic: how much more of it lies towards +x and towards +z
     *   [4] [5] its second harmonic (cos and sin of twice the bearing), which tells a strip of city from a single one
     * Allocation-free.
     */
    around(x, z, out, o = 0) {
      let mean = 0, c1 = 0, s1 = 0, c2 = 0, s2 = 0;
      for (let k = 0; k < SECTORS; k++) {
        const dx = SECTOR_X[k], dz = SECTOR_Z[k];
        let far = 0;
        for (let r = 0; r < RING_DISTANCE.length; r++) far += RING_KM[r] * at(x + dx * RING_DISTANCE[r], z + dz * RING_DISTANCE[r]);
        mean += far; c1 += far * dx; s1 += far * dz;
        c2 += far * (dx * dx - dz * dz); s2 += far * 2 * dx * dz;
      }
      out[o] = at(x, z);
      out[o + 1] = mean / SECTORS;
      out[o + 2] = 2 * c1 / SECTORS; out[o + 3] = 2 * s1 / SECTORS;
      out[o + 4] = 2 * c2 / SECTORS; out[o + 5] = 2 * s2 / SECTORS;
      return out;
    },
  };
}

/** The far glow towards a unit compass direction (hx, hz), from a summary: the same sum the shaders evaluate. */
export function glowTowards(summary, hx, hz) {
  return Math.max(summary[1] + summary[2] * hx + summary[3] * hz + summary[4] * (hx * hx - hz * hz) + summary[5] * 2 * hx * hz, 0);
}
