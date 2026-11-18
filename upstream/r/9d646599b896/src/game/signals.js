// Traffic signal timing and the lit lenses.
//
// A signalised junction cycles through its phase groups: green, amber, then a short period
// with every approach on red before the next group starts. The state is a pure function of
// the junction and the simulation time, so drivers and the lens glows can never disagree.

import { hash01 } from '../core/math.js';
import { CHANNEL } from '../core/ids.js';

export const SIGNAL = Object.freeze({ RED: 0, AMBER: 1, GREEN: 2 });

const AMBER_SECONDS = 3.2;
const ALL_RED_SECONDS = 1.6;
const GREEN_MIN_SECONDS = 13;
const GREEN_EXTRA_SECONDS = 9;

// Lens appearance, from design/brief/lighting-and-mood.md section 9.4: colour in linear light
// times the emissive level of that lens (a signal reads a little below a street lamp lens).
const LENS_COLORS = [
  [25, 0.58, 0.26], // red #FF2A1A at 25
  [25, 10.9, 0], // amber #FFB000 at 25
  [0.55, 15.8, 7.0], // green #2EE6A0 at 20: bluish, as filament signals are
];
const LENS_LIGHT_SHARE = 0.36; // the wash a lens throws, as a share of its own brightness
const LENS_GLOW_SCALE = 2.5; // glow sprite diameter in lens diameters: half a metre for a 0.2 m lens
const LENS_LIGHT_RADIUS = 7; // metres: the wash on the mast, the kerb and a wet road
const LENS_GLOW_RANGE = 320; // metres from the camera
const LENS_LIGHT_RANGE = 70;

/** Seconds of green for a junction and the offset of its cycle, derived from its id. */
function timing(junction) {
  if (!junction.timing) {
    const green = GREEN_MIN_SECONDS + GREEN_EXTRA_SECONDS * hash01(junction.id, 17);
    const slot = green + AMBER_SECONDS + ALL_RED_SECONDS;
    const cycle = slot * junction.groups;
    junction.timing = { green, slot, cycle, offset: hash01(junction.id, 5) * cycle };
  }
  return junction.timing;
}

/**
 * State of one phase group of a signalised junction at simulation time `time`.
 * @returns {number} SIGNAL.RED | AMBER | GREEN
 */
export function signalState(junction, group, time) {
  const t = timing(junction);
  const local = (time + t.offset) % t.cycle - (group % junction.groups) * t.slot;
  if (local < 0 || local >= t.slot - ALL_RED_SECONDS) return SIGNAL.RED;
  return local < t.green ? SIGNAL.GREEN : SIGNAL.AMBER;
}

/**
 * Writes glows (and, close to the camera, small coloured lights) for the lit lens of every
 * signal head near the camera.
 * @param {import('./lamps.js').LampBuffer} lamps
 * @param {object[]} junctions  prepared junctions (lanes.js)
 * @param {number} time         simulation time, seconds
 * @param {number[]} eye        camera position
 */
export function writeSignalLamps(lamps, junctions, time, eye) {
  for (let j = 0; j < junctions.length; j++) {
    const junction = junctions[j];
    if (junction.control !== 'signal' || junction.lenses.length === 0) continue;
    const dx = junction.x - eye[0], dz = junction.z - eye[2];
    const range = LENS_GLOW_RANGE + junction.radius;
    if (dx * dx + dz * dz > range * range) continue;
    const lenses = junction.lenses;
    for (let i = 0; i + 7 < lenses.length; i += 8) {
      const colour = lenses[i + 5] | 0;
      const lit = signalState(junction, lenses[i + 6] | 0, time);
      if (colour !== lit) continue;
      const x = lenses[i], y = lenses[i + 1], z = lenses[i + 2];
      const ex = eye[0] - x, ey = eye[1] - y, ez = eye[2] - z;
      const distance = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
      // A signal head has a visor: it is bright on its axis and dark from behind.
      const facing = (ex * lenses[i + 3] + ez * lenses[i + 4]) / distance;
      if (facing <= 0.05) continue;
      const c = LENS_COLORS[colour];
      const level = Math.sqrt(facing);
      lamps.glow(x, y, z, lenses[i + 7] * LENS_GLOW_SCALE, c[0] * level, c[1] * level, c[2] * level, CHANNEL.ALWAYS, 0);
      if (distance < LENS_LIGHT_RANGE) {
        // Slightly in front of the lens so that the head itself does not shadow the wash.
        lamps.point(x + lenses[i + 3] * 0.15, y, z + lenses[i + 4] * 0.15, LENS_LIGHT_RADIUS,
          c[0] * LENS_LIGHT_SHARE, c[1] * LENS_LIGHT_SHARE, c[2] * LENS_LIGHT_SHARE);
      }
    }
  }
}
