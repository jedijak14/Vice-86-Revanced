// Lightning: when and where it strikes, how the flash flickers, and when the thunder arrives. Pure JavaScript.
//
//   const lightning = createLightning({ seed, onThunder(distance, x, z), onStrike(strike) });
//   const flash = lightning.update(dt, intensity, camX, camZ);   // every simulation step; intensity = env.weather.lightning 0..1
//   deriveEnvironment({ ..., lightning: flash, strike: lightning.strike })
//
// onThunder fires distance / 343 seconds after the flash, so audio can play the clap with the right delay; the distance
// lets it choose between a crack and a rumble.
import { makeRng } from '../../core/math.js';

const SPEED_OF_SOUND = 343;
const MAX_PENDING = 8;
/** A flash is a train of return strokes: [start (s), peak 0..1, decay time (s)], drawn per strike. */
const MAX_STROKES = 5;

export function createLightning({ seed = 0x1e57, onThunder = null, onStrike = null } = {}) {
  const rng = makeRng(seed);
  const strike = new Float32Array([0, 0, -1, 0]);        // x, z, age (s; negative = none yet), seed 0..1
  const strokes = new Float32Array(MAX_STROKES * 3); let strokeCount = 0;
  const pendingAt = new Float64Array(MAX_PENDING), pendingDist = new Float32Array(MAX_PENDING), pendingX = new Float32Array(MAX_PENDING), pendingZ = new Float32Array(MAX_PENDING);
  let pending = 0, clock = 0, wait = rng.range(2, 6);
  const api = {
    /** Current flash 0..1. */
    flash: 0,
    /** Last strike; pass to deriveEnvironment as `strike`. */
    strike,
    /**
     * Advance by dt seconds. intensity 0 = no storm (nothing is scheduled, pending thunder still arrives).
     * Returns the flash level 0..1 for `lightning` in deriveEnvironment.
     */
    update(dt, intensity, camX, camZ) {
      clock += dt;
      if (strike[2] >= 0) strike[2] += dt;
      if (intensity > 0.01) {
        wait -= dt * (0.35 + 1.65 * intensity);            // a full storm flashes every few seconds
        if (wait <= 0) {
          wait = rng.range(3.5, 16);
          // most strikes are far off over the bay or the ocean; a few are frighteningly close
          const distance = rng.chance(0.18) ? rng.range(250, 900) : rng.range(900, 6500), bearing = rng.range(0, Math.PI * 2);
          strike[0] = camX + Math.cos(bearing) * distance; strike[1] = camZ + Math.sin(bearing) * distance; strike[2] = 0; strike[3] = rng.next();
          strokeCount = rng.int(2, MAX_STROKES); let at = 0;
          for (let i = 0; i < strokeCount; i++) {
            strokes[i * 3] = at; strokes[i * 3 + 1] = i === 0 ? 1 : rng.range(0.35, 0.9); strokes[i * 3 + 2] = rng.range(0.03, 0.09);
            at += rng.range(0.04, 0.13);
          }
          if (pending < MAX_PENDING) { pendingAt[pending] = clock + distance / SPEED_OF_SOUND; pendingDist[pending] = distance; pendingX[pending] = strike[0]; pendingZ[pending] = strike[1]; pending++; }
          if (onStrike) onStrike(strike);
        }
      }
      // flash: sum of the strokes, each a sharp rise and an exponential tail; dimmer when far away
      let level = 0;
      if (strike[2] >= 0 && strike[2] < 1.2) {
        for (let i = 0; i < strokeCount; i++) {
          const since = strike[2] - strokes[i * 3];
          if (since >= 0) level += strokes[i * 3 + 1] * Math.exp(-since / strokes[i * 3 + 2]);
        }
        const distance = Math.hypot(strike[0] - camX, strike[1] - camZ);
        level *= 0.35 + 0.65 / (1 + (distance / 1800) * (distance / 1800));
      }
      api.flash = level > 1 ? 1 : level;
      for (let i = 0; i < pending;) {
        if (pendingAt[i] <= clock) {
          const distance = pendingDist[i], x = pendingX[i], z = pendingZ[i];
          pending--; pendingAt[i] = pendingAt[pending]; pendingDist[i] = pendingDist[pending]; pendingX[i] = pendingX[pending]; pendingZ[i] = pendingZ[pending];
          if (onThunder) onThunder(distance, x, z);
        } else i++;
      }
      return api.flash;
    },
  };
  return api;
}

/** Line segments one bolt may use (trunk plus branches). */
export const BOLT_SEGMENTS = 96;
const TRUNK_STEPS = 28;

/**
 * Build the shape of a bolt for a strike: a jagged trunk from the cloud base to the ground with branches that leave it
 * downwards and die out in mid-air. Deterministic in `seed` (0..1). Writes segments [x0, y0, z0, b0, x1, y1, z1, b1]
 * (world metres, b = brightness 0..1) into `out` (Float32Array of BOLT_SEGMENTS * 8) and returns the segment count.
 */
export function buildBolt(x, z, top, bottom, seed, out) {
  const rng = makeRng(Math.floor(seed * 4294967295) || 1);
  let n = 0;
  const segment = (x0, y0, z0, b0, x1, y1, z1, b1) => { const o = n * 8; out[o] = x0; out[o + 1] = y0; out[o + 2] = z0; out[o + 3] = b0; out[o + 4] = x1; out[o + 5] = y1; out[o + 6] = z1; out[o + 7] = b1; n++; };
  // Trunk: a random walk pinned at both ends (the wander is weighted by a hump so it starts and ends on the axis).
  const height = top - bottom, wander = height * 0.03;
  let px = x, py = top, pz = z, ox = 0, oz = 0;
  for (let i = 1; i <= TRUNK_STEPS; i++) {
    const f = i / TRUNK_STEPS, hump = Math.sin(Math.PI * f);
    ox += rng.range(-1, 1) * wander; oz += rng.range(-1, 1) * wander;
    const nx = x + ox * hump, ny = top - height * (i === TRUNK_STEPS ? 1 : f + rng.range(-0.3, 0.3) / TRUNK_STEPS), nz = z + oz * hump;
    segment(px, py, pz, 1, nx, ny, nz, 1);
    px = nx; py = ny; pz = nz;
  }
  // Branches leave trunk joints in the upper two thirds.
  for (let b = 0; b < 7 && n < BOLT_SEGMENTS - 8; b++) {
    const joint = rng.int(2, Math.floor(TRUNK_STEPS * 0.7)), o = joint * 8;
    let bx = out[o], by = out[o + 1], bz = out[o + 2], bright = rng.range(0.25, 0.55);
    const steps = rng.int(4, 9), heading = rng.range(0, Math.PI * 2), reach = height * rng.range(0.02, 0.05), drop = (by - bottom) * rng.range(0.25, 0.6) / steps;
    for (let i = 0; i < steps && n < BOLT_SEGMENTS; i++) {
      const nx = bx + Math.cos(heading) * reach + rng.range(-1, 1) * wander, nz = bz + Math.sin(heading) * reach + rng.range(-1, 1) * wander, ny = by - drop * rng.range(0.6, 1.4), fade = bright * (1 - (i + 1) / steps);
      segment(bx, by, bz, bright * (1 - i / steps), nx, ny, nz, fade);
      bx = nx; by = ny; bz = nz;
    }
  }
  return n;
}
