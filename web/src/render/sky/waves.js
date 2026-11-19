// The wave trains of the sea: a fixed, deterministic set of directions and lengths, scaled every frame by the wind.
// Pure JavaScript; ocean.js uploads the two arrays as uniforms (glsl/ocean.js: uWaveA, uWaveB).
import { makeRng } from '../../core/math.js';

const TAU = Math.PI * 2, GRAVITY = 9.81;
const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

const LONGEST = 64, SHORTEST = 0.28;      // metres
const FOAM_LAG = 1.6;                     // seconds a breaking crest's foam stays visible behind it

/**
 * Build a wave set. `count` trains with wavelengths spaced geometrically from LONGEST to SHORTEST, each with its own
 * heading relative to the wind and its own phase. Three of the long ones are swell: they come from the open Atlantic
 * whatever the local wind does.
 */
export function createWaveSet(count, seed = 0x5ea) {
  const rng = makeRng(seed).next, ratio = Math.pow(SHORTEST / LONGEST, 1 / (count - 1));
  const set = {
    count, camX: Infinity, camZ: Infinity,   // camera position of the last update
    length: new Float64Array(count), heading: new Float64Array(count), phase: new Float64Array(count),
    omega: new Float64Array(count), swell: new Uint8Array(count),
    a: new Float32Array(count * 4), b: new Float32Array(count * 4),
  };
  for (let i = 0; i < count; i++) {
    // jitter the lengths so no two trains are harmonics of each other: that is what would make the sea repeat
    const length = LONGEST * Math.pow(ratio, i) * (0.93 + 0.14 * rng()), spread = mix(0.30, 1.25, smoothstep(0, count - 1, i));
    set.length[i] = length;
    set.heading[i] = (rng() + rng() - 1) * spread;          // triangular: most energy runs with the wind
    set.phase[i] = rng() * TAU;
    set.omega[i] = Math.sqrt(GRAVITY * TAU / length);         // deep-water dispersion
    set.swell[i] = length > 26 && length < 52 && i % 2 === 1 ? 1 : 0;
  }
  return set;
}

/**
 * Advance the set by dt seconds and fill set.a and set.b. windX/windZ: unit direction the wind sea runs towards;
 * state: 0 glassy .. 1 storm; camX/camZ: camera position (world metres).
 *
 * Each train carries its phase AT THE CAMERA and moves it by the distance the camera travelled along the train and by
 * the time that passed. Float32 therefore never sees world coordinates, the phases stay exact however long the game
 * runs, and when the wind veers the pattern turns about the camera instead of racing past it (a phase computed from
 * the world origin would spin by thousands of radians for a small turn of a short wave two kilometres out).
 */
export function updateWaveSet(set, windX, windZ, windSpeed, state, dt, camX, camZ) {
  const windAngle = Math.atan2(windZ, windX);
  // the sea the local wind can raise: longer and steeper waves as it strengthens
  const peak = mix(3.5, 58, Math.pow(state, 1.25)), steepness = mix(0.020, 0.082, state), chop = mix(0.55, 1.0, state);
  // a jump of the camera (first frame, teleport) carries no meaning for the phases
  const moved = Math.hypot(camX - set.camX, camZ - set.camZ) < 400;
  const dx = moved ? camX - set.camX : 0, dz = moved ? camZ - set.camZ : 0;
  set.camX = camX; set.camZ = camZ;
  for (let i = 0; i < set.count; i++) {
    const length = set.length[i], k = TAU / length, over = Math.log2(length / peak);
    let steep = steepness * (over > 0 ? Math.exp(-1.6 * over * over) : Math.pow(length / peak, 0.10));
    let angle = windAngle + set.heading[i];
    if (set.swell[i]) {
      // swell: from the east-south-east, low and regular, there on the calmest day
      const swellSteep = 0.016 + 0.01 * state;
      if (swellSteep > steep) { steep = swellSteep; angle = Math.PI + 0.22 + set.heading[i] * 0.35; }
    }
    const kx = Math.cos(angle) * k, kz = Math.sin(angle) * k, o = i * 4;
    let phase = (set.phase[i] + kx * dx + kz * dz - set.omega[i] * dt) % TAU; if (phase < 0) phase += TAU;
    set.phase[i] = phase;
    set.a[o] = kx; set.a[o + 1] = kz; set.a[o + 2] = steep / k; set.a[o + 3] = phase;
    set.b[o] = length;
    set.b[o + 1] = mix(0.55, 0.035, smoothstep(Math.log(0.9), Math.log(7), Math.log(length)));   // sheltered water keeps only the short chop
    set.b[o + 2] = set.omega[i] * FOAM_LAG;
    set.b[o + 3] = chop;
  }
  return set;
}

/**
 * The sea's height at a world point, on the CPU: the same trains the ocean shader draws (set.a),
 * at their camera-relative phases, so a hull floating in JavaScript and its reflection in the
 * water agree about where the surface is. Vertical displacement of a Gerstner train is its
 * amplitude times the cosine of its phase at the point.
 */
export function surfaceHeight(set, x, z) {
  let h = 0;
  for (let i = 0; i < set.count; i++) {
    const o = i * 4;
    h += set.a[o + 2] * Math.cos(set.a[o + 3] + set.a[o] * (x - set.camX) + set.a[o + 1] * (z - set.camZ));
  }
  return h;
}

/** Mean square slope of the set on the open sea (tests compare it with the Cox-Munk relation). */
export function meanSquareSlope(set) {
  let sum = 0;
  for (let i = 0; i < set.count; i++) { const steep = set.a[i * 4 + 2] * TAU / set.length[i]; sum += 0.5 * steep * steep; }
  return sum;
}
/** Significant wave height (m) of the set on the open sea: four standard deviations of the surface. */
export function significantHeight(set) {
  let sum = 0;
  for (let i = 0; i < set.count; i++) sum += 0.5 * set.a[i * 4 + 2] * set.a[i * 4 + 2];
  return 4 * Math.sqrt(sum);
}
