// Listener-relative geometry for the audio page API: pan, distance attenuation, Doppler and
// the matching of traffic cars to synth voices between frames. Pure functions over arrays and
// one small stateful matcher; no Web Audio here, so all of it runs in Node.

export const SPEED_OF_SOUND = 343;          // m/s

const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

/** Reads [x, y, z] from an array or an {x, y, z} object into `out`. Missing values read as 0. */
export function readVec3(v, out) {
  if (!v) { out[0] = out[1] = out[2] = 0; return out; }
  if (typeof v.length === 'number') { out[0] = v[0] || 0; out[1] = v[1] || 0; out[2] = v[2] || 0; }
  else { out[0] = v.x || 0; out[1] = v.y || 0; out[2] = v.z || 0; }
  return out;
}

/**
 * Equal-power-ish pan (-1..1) of a source as heard by a listener facing `forward`: the sine of
 * the angle between forward and the direction to the source, projected on the ground plane.
 * Sources straight ahead or behind are centred; sources very close are centred too, so a car
 * passing through the listener does not snap from one side to the other.
 */
export function panOf(listenerPos, forward, sourcePos) {
  const dx = sourcePos[0] - listenerPos[0], dz = sourcePos[2] - listenerPos[2];
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-3) return 0;
  const fl = Math.sqrt(forward[0] * forward[0] + forward[2] * forward[2]) || 1;
  const fx = forward[0] / fl, fz = forward[2] / fl;
  // Right of the listener is forward rotated a quarter turn clockwise seen from above (+Y up).
  const rx = -fz, rz = fx;
  const side = (dx * rx + dz * rz) / d;
  return side * Math.min(1, d / 3);
}

/**
 * Distance gain for a point source: inverse distance beyond `ref` metres, 1 within, with the
 * tail cut off smoothly at `max` so far cars are free of cost.
 */
export function distanceGain(distance, ref = 6, max = 160) {
  if (distance >= max) return 0;
  const g = distance <= ref ? 1 : ref / distance;
  const fade = distance > max * 0.7 ? 1 - (distance - max * 0.7) / (max * 0.3) : 1;
  return g * fade;
}

/**
 * Doppler ratio heard by a listener at L moving with vL from a source at S moving with vS:
 * (c + vL . r) / (c + vS . r) where r is the unit vector from the listener to the source, so the
 * numerator grows when the listener moves towards the source and the denominator grows when
 * the source moves away. Both moving is the general case; approach gives > 1.
 */
export function dopplerRatio(listenerPos, listenerVel, sourcePos, sourceVel, c = SPEED_OF_SOUND) {
  const rx = sourcePos[0] - listenerPos[0], ry = sourcePos[1] - listenerPos[1], rz = sourcePos[2] - listenerPos[2];
  const d = len3(rx, ry, rz);
  if (d < 1e-3) return 1;
  const ux = rx / d, uy = ry / d, uz = rz / d;
  const vl = listenerVel[0] * ux + listenerVel[1] * uy + listenerVel[2] * uz;
  const vs = sourceVel[0] * ux + sourceVel[1] * uy + sourceVel[2] * uz;
  // Clamp so a source moving at the speed of sound does not divide by zero or flip the pitch.
  const ratio = (c + vl) / Math.max(c * 0.25, c + vs);
  return ratio < 0.5 ? 0.5 : ratio > 2 ? 2 : ratio;
}

/**
 * Keeps traffic entries attached to the same synth voice from frame to frame. The game reuses
 * its arrays, so entries are matched by an optional stable `id` or else by predicted position.
 * Each slot remembers position and velocity; a slot whose car is not seen for a frame is freed.
 */
export class TrafficMatcher {
  constructor(slots) {
    this.slots = [];
    for (let i = 0; i < slots; i++) this.slots.push({ used: false, id: null, serial: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, seen: 0 });
    this.frame = 0; this.serial = 0;
    this.tmp = [0, 0, 0]; this.tmpV = [0, 0, 0];
    /** Slot index per input entry after match(); -1 when there was no slot left. */
    this.assignment = new Int32Array(slots);
  }

  /**
   * @param {Array} entries  traffic objects with position, velocity and optional id
   * @param {number} count   how many of them to consider (at most the slot count)
   * @param {number} dt      seconds since the previous match, for position prediction
   */
  match(entries, count, dt) {
    this.frame++;
    const slots = this.slots, n = Math.min(count, slots.length), assign = this.assignment;
    for (let i = 0; i < n; i++) assign[i] = -1;
    // Pass 1: ids, then nearest predicted positions, each slot taken at most once.
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      if (e.id === undefined || e.id === null) continue;
      for (let s = 0; s < slots.length; s++) if (slots[s].used && slots[s].id === e.id && slots[s].seen !== this.frame) { assign[i] = s; slots[s].seen = this.frame; break; }
    }
    for (let i = 0; i < n; i++) {
      if (assign[i] >= 0) continue;
      const p = readVec3(entries[i].position, this.tmp);
      let best = -1, bestD = 25;                   // more than 5 m off the prediction is a different car
      for (let s = 0; s < slots.length; s++) {
        const sl = slots[s];
        if (!sl.used || sl.seen === this.frame || (sl.id !== null && entries[i].id !== undefined)) continue;
        const dx = sl.x + sl.vx * dt - p[0], dy = sl.y + sl.vy * dt - p[1], dz = sl.z + sl.vz * dt - p[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) { bestD = d2; best = s; }
      }
      if (best >= 0) { assign[i] = best; slots[best].seen = this.frame; }
    }
    // Pass 2: new cars take free slots; a new serial tells the synth to fade the slot over.
    for (let i = 0; i < n; i++) {
      if (assign[i] >= 0) continue;
      for (let s = 0; s < slots.length; s++) {
        const sl = slots[s];
        if (sl.used && sl.seen === this.frame) continue;
        sl.used = true; sl.seen = this.frame; sl.serial = ++this.serial;
        sl.id = entries[i].id === undefined ? null : entries[i].id;
        assign[i] = s; break;
      }
    }
    // Remember where everyone is; free the slots nobody claimed.
    for (let s = 0; s < slots.length; s++) {
      const sl = slots[s];
      if (sl.used && sl.seen !== this.frame) { sl.used = false; sl.id = null; }
    }
    for (let i = 0; i < n; i++) {
      const s = assign[i]; if (s < 0) continue;
      const sl = slots[s], p = readVec3(entries[i].position, this.tmp), v = readVec3(entries[i].velocity, this.tmpV);
      sl.x = p[0]; sl.y = p[1]; sl.z = p[2]; sl.vx = v[0]; sl.vy = v[1]; sl.vz = v[2];
    }
    return assign;
  }
}
