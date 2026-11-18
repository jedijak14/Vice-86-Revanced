// Per-frame light, glow and ground-occluder lists for the renderer, and the rule that turns a
// vehicle model's lamp anchors into light and glow records.
//
// The anchors are the model's own lamp positions (design/ARCHITECTURE.md 10.1), transformed
// here by the same matrix that draws the body. There is no second table of lamp positions,
// which is what keeps every light exactly on its lens.

import { LIGHT_STRIDE, GLOW_STRIDE, CHANNEL } from '../core/ids.js';
import { DEG, smoothstep } from '../core/math.js';

const OCCLUDER_STRIDE = 8;

export const GLOW_ROUND = 0;
export const GLOW_STAR = 1;

// Lamp colours are those of design/brief/lighting-and-mood.md section 9, in linear light.
// Headlamp low beam (design/ARCHITECTURE.md 4.6): a sealed beam, warm white #FFE3B8, never blue.
//
// A lamp 0.6 m above the road lights it at a grazing angle, so with a plain cone the light on
// the road falls with the cube of the distance: a white patch on the first metres and darkness
// beyond. The renderer therefore has a light type for a low beam (record type 2). Its axis is
// the lamp's level aim; below the axis the beam is shaped to light the road evenly out to the
// hot spot, which sits HEAD_HOT_SPOT below the axis, and above the axis a cut-off leaves only
// stray light. HEAD_STRENGTH is the peak intensity, in the hot spot: set so that at the night
// exposure the lit road is clearly brighter than the street lighting yet still reads as asphalt,
// with its grain and markings, rather than as a pale wash.
// A halogen sealed beam, as a camera balanced for the evening sky records it: warm white, not amber.
const HEAD_COLOR = [1, 0.88, 0.7];
const HEAD_STRENGTH = 22000;
const HEAD_RADIUS = 90;
const HEAD_TAN_SPREAD = Math.tan(32 * DEG); // horizontal half spread
const HEAD_TAN_HOT_SPOT = Math.tan(1.6 * DEG);
const HEAD_LENS_RADIUS = 0.08; // m: how large the lamp looks in a reflection
// One merged beam stands in for both lamps of a vehicle that is not close to the camera. It throws
// what the two throw together, in the same fan, from between them: where a vehicle passes from one
// description to the other the road must be lit the same by both.
const MERGED_STRENGTH = HEAD_STRENGTH * 2;
const MERGED_LENS_RADIUS = 0.3;
// A beam fainter than this lights nothing that can be seen and is not written (a thousandth of a low beam).
const BEAM_FLOOR = HEAD_STRENGTH * 0.001;

// Glow radiance (what the lens looks like to the eye) and sprite sizes in metres.
const HEAD_GLOW = 150, HEAD_GLOW_SIZE = 0.62;
const TAIL_GLOW = 1.4, BRAKE_GLOW = 6, TAIL_GLOW_SIZE = 0.34, BRAKE_GLOW_SIZE = 0.46;
const REVERSE_GLOW = 5, REVERSE_GLOW_SIZE = 0.3;
const INDICATOR_GLOW = 7, INDICATOR_GLOW_SIZE = 0.3;
// A lens seen edge-on shows nothing, and its glow comes up as the lens turns towards the eye: over
// the first GLOW_TURN of the cosine between the car's axis and the line to the eye (about nine
// degrees), so that the lamps of a car crossing ahead do not appear in one frame.
const GLOW_TURN = 0.15;
const RED = [1, 0.016, 0.0094]; // #D21A12, tail and brake: a filament bulb behind a red lens
const AMBER = [1, 0.323, 0.014]; // #FF9A1F, turn signals
const REVERSE_WHITE = [1, 0.905, 0.745]; // #FFF4E0
// The red wash the tail and brake lamps throw on the road behind the car: a spot that looks
// back and down from between the lamps. A point light there would light the car's own tail
// panel far more strongly than the road, and the lenses would be lost in a red panel.
const TAIL_WASH_RADIUS = 7, TAIL_WASH = 0.7, BRAKE_WASH = 5;
const TAIL_WASH_BACK = 0.12; // metres behind the lenses
const TAIL_WASH_AXIS = [0, -0.5, -0.866]; // vehicle frame: 30 degrees below level, rearwards
const TAIL_WASH_COS_OUTER = Math.cos(72 * DEG);
const TAIL_WASH_COS_INNER = Math.cos(25 * DEG);

// Fog lamps: low in the bumper, a flat beam that is wide and short. It lights the road and both kerbs
// just ahead of the car from under the rain instead of throwing light into it. Same record type as
// a low beam, so it has the same cut-off above the lamp's level aim; the hot spot lies 8 m ahead.
const FOG_STRENGTH = 3500;
const FOG_RADIUS = 22;
const FOG_TAN_SPREAD = Math.tan(55 * DEG);
const FOG_TAN_HOT_SPOT = Math.tan(2.1 * DEG);
const FOG_LENS_RADIUS = 0.05;
const FOG_GLOW = 45, FOG_GLOW_SIZE = 0.4;

// Number plate lamps: two small bulbs under a cowl over the rear plate. Each is a spot that reaches
// no farther than the plate and the panel around it. The lens itself sits within a centimetre of the
// plate's plane; a light placed there would graze the plate and light only its top edge, where the
// real lens spreads the light down the whole sheet. So the light stands off the plate by
// PLATE_STANDOFF and looks down and back at it. A rear plate faces backwards on every vehicle.
const PLATE_COLOR = [1, 0.8, 0.55]; // a five watt festoon bulb: warmer than a headlamp
const PLATE_STRENGTH = 4;
const PLATE_RADIUS = 0.22;
const PLATE_STANDOFF = 0.04;
const PLATE_TAN_AIM = Math.tan(32 * DEG); // tilt of the light from the lamp's own aim towards the plate
const PLATE_COS_OUTER = Math.cos(75 * DEG);
const PLATE_COS_INNER = Math.cos(30 * DEG);

// When drivers switch their headlamps on (design/brief/lighting-and-mood.md section 10):
// with the sun lower than three degrees above the horizon, or in rain.
export const HEADLAMP_SUN_ELEVATION = 3 * DEG;
export const HEADLAMP_RAIN = 0.3;
// Fog lamps go on with the low beams once it rains in earnest or mist hangs in the air (the
// weather's fog value; a steady rain raises it to about 0.1).
export const FOGLAMP_RAIN = 0.3;
export const FOGLAMP_MIST = 0.05;

/** Indicators and hazards blink at 1.5 Hz, in phase with the VEHICLE shader's own blink. */
export const blinkOn = (time) => (time * 1.5) % 1 < 0.5;

export class LampBuffer {
  constructor(maxLights = 256, maxGlows = 1536, maxOccluders = 32) {
    this.lights = new Float32Array(maxLights * LIGHT_STRIDE);
    this.glows = new Float32Array(maxGlows * GLOW_STRIDE);
    this.occluders = new Float32Array(maxOccluders * OCCLUDER_STRIDE);
    this.lightCount = 0;
    this.glowCount = 0;
    this.occluderCount = 0;
    this._maxLights = maxLights;
    this._maxGlows = maxGlows;
    this._maxOccluders = maxOccluders;
  }

  reset() {
    this.lightCount = 0;
    this.glowCount = 0;
    this.occluderCount = 0;
  }

  /** Point light. Colour is linear rgb times intensity. Dropped silently when the list is full. */
  point(x, y, z, radius, r, g, b) {
    if (this.lightCount >= this._maxLights) return;
    const a = this.lights, o = this.lightCount++ * LIGHT_STRIDE;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = radius;
    a[o + 4] = r; a[o + 5] = g; a[o + 6] = b; a[o + 7] = 0;
    a[o + 8] = 0; a[o + 9] = -1; a[o + 10] = 0; a[o + 11] = -1; a[o + 12] = -1;
    a[o + 13] = CHANNEL.ALWAYS; a[o + 14] = 0; a[o + 15] = 0;
  }

  /** Spot light along the unit axis (ax, ay, az). */
  spot(x, y, z, radius, r, g, b, ax, ay, az, cosOuter, cosInner) {
    if (this.lightCount >= this._maxLights) return;
    const a = this.lights, o = this.lightCount++ * LIGHT_STRIDE;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = radius;
    a[o + 4] = r; a[o + 5] = g; a[o + 6] = b; a[o + 7] = 1;
    a[o + 8] = ax; a[o + 9] = ay; a[o + 10] = az; a[o + 11] = cosOuter; a[o + 12] = cosInner;
    a[o + 13] = CHANNEL.ALWAYS; a[o + 14] = 0; a[o + 15] = 0;
  }

  /**
   * Low beam of a headlamp along the unit axis (ax, ay, az), the lamp's level aim.
   * tanSpread: tangent of the horizontal half spread; tanHotSpot: tangent of the angle of the
   * hot spot below the axis; lensRadius: metres.
   */
  beam(x, y, z, radius, r, g, b, ax, ay, az, tanSpread, tanHotSpot, lensRadius) {
    if (this.lightCount >= this._maxLights) return;
    const a = this.lights, o = this.lightCount++ * LIGHT_STRIDE;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = radius;
    a[o + 4] = r; a[o + 5] = g; a[o + 6] = b; a[o + 7] = 2;
    a[o + 8] = ax; a[o + 9] = ay; a[o + 10] = az; a[o + 11] = tanSpread; a[o + 12] = tanHotSpot;
    a[o + 13] = CHANNEL.ALWAYS; a[o + 14] = 0; a[o + 15] = lensRadius;
  }

  /**
   * Ready-made light records (a set's own lights), their colours scaled by `gain`.
   * @param {Float32Array} records  LIGHT_STRIDE floats each
   * @param {number} index  the record to copy
   */
  lightRecord(records, index, gain) {
    if (this.lightCount >= this._maxLights) return;
    const a = this.lights, o = this.lightCount++ * LIGHT_STRIDE, from = index * LIGHT_STRIDE;
    for (let i = 0; i < LIGHT_STRIDE; i++) a[o + i] = records[from + i];
    a[o + 4] *= gain; a[o + 5] *= gain; a[o + 6] *= gain;
  }

  /** Ready-made glow records, GLOW_STRIDE floats each, their colours scaled by `gain`. */
  glowRecords(records, gain) {
    const count = Math.min(Math.floor(records.length / GLOW_STRIDE), this._maxGlows - this.glowCount);
    const a = this.glows, start = this.glowCount * GLOW_STRIDE;
    for (let i = 0; i < count * GLOW_STRIDE; i++) a[start + i] = records[i];
    for (let i = 0; i < count; i++) {
      const o = start + i * GLOW_STRIDE;
      a[o + 4] *= gain; a[o + 5] *= gain; a[o + 6] *= gain;
    }
    this.glowCount += count;
  }

  /** Glow sprite. `kind`: GLOW_ROUND or GLOW_STAR. */
  glow(x, y, z, size, r, g, b, channel, kind) {
    if (this.glowCount >= this._maxGlows) return;
    const a = this.glows, o = this.glowCount++ * GLOW_STRIDE;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = size;
    a[o + 4] = r; a[o + 5] = g; a[o + 6] = b; a[o + 7] = channel + 16 * kind;
  }

  /** Box under which the ground is darkened (a vehicle's contact shadow). */
  occluder(cx, cy, cz, yaw, halfWidth, halfHeight, halfLength) {
    if (this.occluderCount >= this._maxOccluders) return;
    const a = this.occluders, o = this.occluderCount++ * OCCLUDER_STRIDE;
    a[o] = cx; a[o + 1] = cy; a[o + 2] = cz; a[o + 3] = yaw;
    a[o + 4] = halfWidth; a[o + 5] = halfHeight; a[o + 6] = halfLength; a[o + 7] = 0;
  }
}

/**
 * Lamp layout of a vehicle model, read once from its anchors.
 * @param {object} model  vehicle model record (10.1)
 */
export function createLampRig(model) {
  const anchors = model.anchors || {};
  // The modeller gives a lamp's heading. A beam's axis is level in the vehicle, whatever tilt the
  // anchor carries: the dip of a low beam is one rule for every vehicle, and it is part of the
  // beam's shape.
  const levelled = (h) => {
    const d = h.dir || [0, 0, 1];
    const flat = Math.hypot(d[0], d[2]) || 1;
    return { pos: h.pos, dir: [d[0] / flat, 0, d[2] / flat] };
  };
  const head = (anchors.headlamps || []).map(levelled);
  const plate = (anchors.plateLamps || []).map((l) => {
    const d = l.dir || [0, -1, 0];
    const length = Math.hypot(d[0], d[1], d[2] + PLATE_TAN_AIM);
    return { pos: [l.pos[0], l.pos[1], l.pos[2] - PLATE_STANDOFF], dir: [d[0] / length, d[1] / length, (d[2] + PLATE_TAN_AIM) / length] };
  });
  // Low beams: the outermost lamp on each side. Inner lamps of a four-lamp front only glow.
  const beams = [];
  for (const side of [1, -1]) {
    let best = null;
    for (const h of head) if (h.pos[0] * side > 0 && (!best || Math.abs(h.pos[0]) > Math.abs(best.pos[0]))) best = h;
    if (best) beams.push(best);
  }
  if (beams.length === 0 && head.length > 0) beams.push(head[0]);
  const centre = (list) => {
    if (list.length === 0) return null;
    const c = [0, 0, 0];
    for (const e of list) { c[0] += e.pos[0]; c[1] += e.pos[1]; c[2] += e.pos[2]; }
    return [c[0] / list.length, c[1] / list.length, c[2] / list.length];
  };
  const sized = (list, fallback) => (list || []).map((e) => ({ pos: e.pos, size: e.size ? Math.max(e.size * 1.6, fallback) : fallback }));
  const ind = anchors.indicators || {};
  const tail = sized(anchors.tailLamps, TAIL_GLOW_SIZE);
  return {
    head, beams,
    headCentre: centre(beams),
    fog: (anchors.fogLamps || []).map(levelled),
    plate,
    tail,
    brake: sized(anchors.brakeLamps, BRAKE_GLOW_SIZE),
    reverse: sized(anchors.reverseLamps, REVERSE_GLOW_SIZE),
    tailCentre: centre(tail),
    left: [ind.fl, ind.rl].filter(Boolean),
    right: [ind.fr, ind.rr].filter(Boolean),
  };
}

const p = [0, 0, 0];
const transformPoint = (m, v) => {
  const x = v[0], y = v[1], z = v[2];
  p[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  p[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  p[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return p;
};
const q = [0, 0, 0];
const transformDirection = (m, v) => {
  const x = v[0], y = v[1], z = v[2];
  q[0] = m[0] * x + m[4] * y + m[8] * z;
  q[1] = m[1] * x + m[5] * y + m[9] * z;
  q[2] = m[2] * x + m[6] * y + m[10] * z;
  return q;
};

/**
 * Writes the lights and glows of one vehicle for this frame.
 * @param {LampBuffer} out
 * @param {object} rig       from createLampRig
 * @param {Float32Array} m   the body's model matrix
 * @param {{head: number, brake: number, reverse: number, indicator: number, fog?: number}} state
 *        head/brake/reverse 0..1; indicator 0 off, 1 left, 2 right, 3 hazard; fog 0..1, given
 *        only by vehicles that switch their fog lamps
 * @param {number[]} eye     camera position
 * @param {number} time      seconds, for the indicator blink
 * @param {number} reach     0..1: share of their strength the headlamp beams throw on the road; 0
 *                           leaves the glows only (a vehicle far from the camera)
 * @param {number} near      0..1: share of the close-up set, which is one beam per headlamp instead
 *                           of a merged one, the fog beams, the plate lamps and the tail wash
 * @param {number} glare     0..1: share of their brightness the glows of the lenses are drawn with
 *
 * The three shares are continuous so that a caller can fade a vehicle in, out, and from one set of
 * lamps to the other: whatever is switched instead shows as a jump in the picture.
 */
export function writeVehicleLamps(out, rig, m, state, eye, time, reach, near, glare) {
  // Unit forward of the body, for the directional falloff of lamps seen off their axis.
  const fx = m[8], fy = m[9], fz = m[10];
  const toEyeX = eye[0] - m[12], toEyeY = eye[1] - m[13], toEyeZ = eye[2] - m[14];
  const eyeDistance = Math.sqrt(toEyeX * toEyeX + toEyeY * toEyeY + toEyeZ * toEyeZ) || 1;
  const front = (toEyeX * fx + toEyeY * fy + toEyeZ * fz) / eyeDistance; // 1 = seen head on

  if (state.head > 0.01) {
    const level = state.head;
    if (front > 0) {
      // A headlamp is blinding on its axis and fades quickly to the side.
      const lens = HEAD_GLOW * level * glare * (0.12 + 0.88 * front * front) * smoothstep(0, GLOW_TURN, front);
      for (let i = 0; i < rig.head.length; i++) {
        const w = transformPoint(m, rig.head[i].pos);
        out.glow(w[0], w[1], w[2], HEAD_GLOW_SIZE, lens * HEAD_COLOR[0], lens * HEAD_COLOR[1], lens * HEAD_COLOR[2], CHANNEL.ALWAYS, GLOW_STAR);
      }
    }
    const each = HEAD_STRENGTH * level * reach * near, merged = MERGED_STRENGTH * level * reach * (1 - near);
    if (each > BEAM_FLOOR) {
      for (let i = 0; i < rig.beams.length; i++) {
        const d = rig.beams[i].dir;
        const ax = m[0] * d[0] + m[8] * d[2], ay = m[1] * d[0] + m[9] * d[2], az = m[2] * d[0] + m[10] * d[2];
        const w = transformPoint(m, rig.beams[i].pos);
        out.beam(w[0], w[1], w[2], HEAD_RADIUS, each * HEAD_COLOR[0], each * HEAD_COLOR[1], each * HEAD_COLOR[2], ax, ay, az, HEAD_TAN_SPREAD, HEAD_TAN_HOT_SPOT, HEAD_LENS_RADIUS);
      }
    }
    if (merged > BEAM_FLOOR && rig.headCentre) {
      const w = transformPoint(m, rig.headCentre);
      out.beam(w[0], w[1], w[2], HEAD_RADIUS, merged * HEAD_COLOR[0], merged * HEAD_COLOR[1], merged * HEAD_COLOR[2], fx, fy, fz, HEAD_TAN_SPREAD, HEAD_TAN_HOT_SPOT, MERGED_LENS_RADIUS);
    }
  }

  if (state.fog > 0.01) {
    if (front > 0) {
      const lens = FOG_GLOW * state.fog * glare * (0.12 + 0.88 * front * front) * smoothstep(0, GLOW_TURN, front);
      for (let i = 0; i < rig.fog.length; i++) {
        const w = transformPoint(m, rig.fog[i].pos);
        out.glow(w[0], w[1], w[2], FOG_GLOW_SIZE, lens * HEAD_COLOR[0], lens * HEAD_COLOR[1], lens * HEAD_COLOR[2], CHANNEL.ALWAYS, GLOW_STAR);
      }
    }
    const s = FOG_STRENGTH * state.fog * near;
    if (s > BEAM_FLOOR) {
      for (let i = 0; i < rig.fog.length; i++) {
        const a = transformDirection(m, rig.fog[i].dir);
        const w = transformPoint(m, rig.fog[i].pos);
        out.beam(w[0], w[1], w[2], FOG_RADIUS, s * HEAD_COLOR[0], s * HEAD_COLOR[1], s * HEAD_COLOR[2], a[0], a[1], a[2], FOG_TAN_SPREAD, FOG_TAN_HOT_SPOT, FOG_LENS_RADIUS);
      }
    }
  }

  const rear = -front; // 1 = seen from straight behind
  if (rear > 0) {
    // The plate is lit whenever the lamps are on, and only somebody behind the car can see it.
    if (near > 0.01 && state.head > 0.01) {
      const s = PLATE_STRENGTH * state.head * near;
      for (let i = 0; i < rig.plate.length; i++) {
        const a = transformDirection(m, rig.plate[i].dir);
        const w = transformPoint(m, rig.plate[i].pos);
        out.spot(w[0], w[1], w[2], PLATE_RADIUS, s * PLATE_COLOR[0], s * PLATE_COLOR[1], s * PLATE_COLOR[2], a[0], a[1], a[2], PLATE_COS_OUTER, PLATE_COS_INNER);
      }
    }
    const spread = (0.25 + 0.75 * rear) * glare * smoothstep(0, GLOW_TURN, rear);
    if (state.head > 0.01) {
      const level = TAIL_GLOW * state.head * spread;
      for (let i = 0; i < rig.tail.length; i++) {
        const w = transformPoint(m, rig.tail[i].pos);
        out.glow(w[0], w[1], w[2], rig.tail[i].size, level * RED[0], level * RED[1], level * RED[2], CHANNEL.ALWAYS, GLOW_ROUND);
      }
    }
    if (state.brake > 0.01) {
      const level = BRAKE_GLOW * state.brake * spread;
      for (let i = 0; i < rig.brake.length; i++) {
        const w = transformPoint(m, rig.brake[i].pos);
        out.glow(w[0], w[1], w[2], rig.brake[i].size, level * RED[0], level * RED[1], level * RED[2], CHANNEL.ALWAYS, GLOW_ROUND);
      }
    }
    if (state.reverse > 0.01) {
      const level = REVERSE_GLOW * state.reverse * spread;
      for (let i = 0; i < rig.reverse.length; i++) {
        const w = transformPoint(m, rig.reverse[i].pos);
        out.glow(w[0], w[1], w[2], rig.reverse[i].size, level * REVERSE_WHITE[0], level * REVERSE_WHITE[1], level * REVERSE_WHITE[2], CHANNEL.ALWAYS, GLOW_ROUND);
      }
    }
  }
  if (rig.tailCentre) {
    const wash = (TAIL_WASH * state.head + BRAKE_WASH * state.brake) * near;
    if (wash > 0.05) {
      const w = transformPoint(m, rig.tailCentre), d = TAIL_WASH_AXIS;
      const ax = m[4] * d[1] + m[8] * d[2], ay = m[5] * d[1] + m[9] * d[2], az = m[6] * d[1] + m[10] * d[2];
      out.spot(w[0] - fx * TAIL_WASH_BACK, w[1] - fy * TAIL_WASH_BACK, w[2] - fz * TAIL_WASH_BACK, TAIL_WASH_RADIUS,
        wash * RED[0], wash * RED[1], wash * RED[2], ax, ay, az, TAIL_WASH_COS_OUTER, TAIL_WASH_COS_INNER);
    }
  }

  if (state.indicator > 0 && blinkOn(time)) {
    const level = INDICATOR_GLOW * glare;
    if (state.indicator !== 2) {
      for (let i = 0; i < rig.left.length; i++) {
        const w = transformPoint(m, rig.left[i]);
        out.glow(w[0], w[1], w[2], INDICATOR_GLOW_SIZE, level * AMBER[0], level * AMBER[1], level * AMBER[2], CHANNEL.ALWAYS, GLOW_ROUND);
      }
    }
    if (state.indicator !== 1) {
      for (let i = 0; i < rig.right.length; i++) {
        const w = transformPoint(m, rig.right[i]);
        out.glow(w[0], w[1], w[2], INDICATOR_GLOW_SIZE, level * AMBER[0], level * AMBER[1], level * AMBER[2], CHANNEL.ALWAYS, GLOW_ROUND);
      }
    }
  }
}
