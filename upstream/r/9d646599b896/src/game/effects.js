// What the car does to the world around it that is not physics: the particle emitters given
// to the renderer each frame (road spray, tyre smoke, dust, splashes), and the reaction to
// impacts (sound, camera shake, controller rumble).
//
// Emitters follow design/ARCHITECTURE.md 7.3: { position, velocity, rate, kind } with `rate`
// in particles per second and `velocity` the initial velocity of the particles in m/s. The
// renderer owns the particles from there on. The objects in `effects.spray` are reused.

import { saturate, smoothstep, m4transformPoint } from '../core/math.js';
import { KIND } from '../physics/index.js';

const MAX_TRAFFIC_SPRAY = 4;
const MAX_BURSTS = 6;

// Road spray.
const SPRAY_MIN_WETNESS = 0.12;
const SPRAY_MIN_SPEED = 5; // m/s
// Spray is a haze of many faint sprites (the renderer draws each at a tenth opacity), so the plume only
// reads when there are hundreds of them. The two ceilings keep the worst case, the player flat out among
// four passing cars, near a thousand live particles, which the renderer's pool holds at every preset.
const SPRAY_RATE = 13; // particles per second per m/s above the minimum, at full wetness
const SPRAY_MAX_RATE = 380; // per rear wheel of the player's car
const TRAFFIC_SPRAY_MAX_RATE = 120; // per passing vehicle
// A low fan of mist that hangs behind the wheels, not a rising cloud: it is barely thrown up.
const SPRAY_SIZE = 0.8, SPRAY_SIZE_FAST = 0.4; // scale of the particle at walking pace, and what speed adds
const SPRAY_LIFT = 0.3, SPRAY_LIFT_PER_SPEED = 0.02; // m/s upwards, and per m/s of road speed

// Tyre smoke.
const SMOKE_START = 0.3; // slip measure (0..1 per wheel) at which smoke begins
const SMOKE_RATE = 20; // particles per second per wheel at full slip: wisps off a sliding tyre, a cloud only from a held burnout
const WHEELSPIN_SPEED = 3; // m/s of tyre surface speed over the road that smokes at a standstill

// Dust.
const DUST_MIN_SPEED = 2.5;
const DUST_RATE = 5;
const DUST_MAX_RATE = 220;
const SAND_COLOR = [0.78, 0.68, 0.52];
const EARTH_COLOR = [0.4, 0.34, 0.25];

// Impacts.
const IMPACT_FULL_SPEED = 16; // m/s closing speed that counts as a full-strength hit
const IMPACT_MIN_STRENGTH = 0.04;
const BURST_SECONDS = 0.12;
const LANDING_SPEED = 2.5; // m/s onto the ground before a landing is worth a sound

// Tyre slip thresholds (shared with player.js through the physics owner's definition).
const SLIP_LONG_START = 0.15, SLIP_LONG_RANGE = 0.45, SLIP_LAT_START = 0.18, SLIP_LAT_RANGE = 0.30;

const IMPACT_SOUND = {
  [KIND.VEHICLE]: 'vehicle', [KIND.TRAFFIC]: 'vehicle', [KIND.BUILDING]: 'wall', [KIND.POLE]: 'pole',
  [KIND.BARRIER]: 'barrier', [KIND.WATER]: 'splash',
};

const makeEmitter = () => ({ position: [0, 0, 0], velocity: [0, 0, 0], rate: 0, kind: 'spray', color: null, size: 1, ttl: 0 });

/**
 * @param {{physics: object, audio: object|null, camera: object, input: object, settings: object}} deps
 */
export function createEffects({ physics, audio, camera, input, settings }) {
  const wheelEmitters = [makeEmitter(), makeEmitter(), makeEmitter(), makeEmitter()];
  const trafficEmitters = [];
  for (let i = 0; i < MAX_TRAFFIC_SPRAY; i++) trafficEmitters.push(makeEmitter());
  const bursts = [];
  for (let i = 0; i < MAX_BURSTS; i++) bursts.push(makeEmitter());
  const local = [0, 0, 0];
  const at = [0, 0, 0];
  let playerVehicle = null;
  let wasInWater = false;
  let wetness = 0;

  function burst(kind, x, y, z, vx, vy, vz, rate, size, color) {
    let slot = bursts[0];
    for (let i = 0; i < MAX_BURSTS; i++) {
      if (bursts[i].ttl <= 0) { slot = bursts[i]; break; }
      if (bursts[i].ttl < slot.ttl) slot = bursts[i];
    }
    slot.position[0] = x; slot.position[1] = y; slot.position[2] = z;
    slot.velocity[0] = vx; slot.velocity[1] = vy; slot.velocity[2] = vz;
    slot.rate = rate; slot.kind = kind; slot.size = size; slot.color = color; slot.ttl = BURST_SECONDS;
  }

  const unsubscribe = physics.onImpact((e) => {
    if (e.vehicle !== playerVehicle) return;
    const ground = e.otherKind === KIND.ASPHALT || e.otherKind === KIND.CONCRETE || e.otherKind === KIND.SAND || e.otherKind === KIND.GRASS;
    // The floor is only worth a sound when the car lands on it.
    if (ground && e.speed < LANDING_SPEED) return;
    const strength = saturate(e.speed / IMPACT_FULL_SPEED) * (ground ? 0.5 : 1);
    if (strength < IMPACT_MIN_STRENGTH) return;
    at[0] = e.pos[0]; at[1] = e.pos[1]; at[2] = e.pos[2];
    if (audio) audio.impact(strength, at, IMPACT_SOUND[e.otherKind] || 'scrape');
    camera.addTrauma(0.25 + strength * 0.75);
    if (settings.controls.vibration !== false) input.rumble(0.3 + strength * 0.7, 0.12 + strength * 0.25);
    // Something to see where it happened: dust off a wall, a sheet of water, a puff off the road.
    const kind = e.otherKind === KIND.WATER ? 'splash' : wetness > 0.4 && ground ? 'splash' : 'dust';
    burst(kind, at[0], at[1], at[2], e.normal[0] * 2, 1.5 + strength * 2, e.normal[2] * 2, 150 + strength * 600, 0.6 + strength, kind === 'dust' ? EARTH_COLOR : null);
  });

  const effects = {
    /** Emitters for this frame: pass as `frame.spray`. */
    spray: [],

    /**
     * @param {number} dt        frame time, seconds; 0 while paused
     * @param {object} player    from createPlayer
     * @param {{wetness: number, puddles: number, rain: number}} weather
     * @param {object[]} nearby  traffic near the camera: [{ position, velocity }]
     */
    update(dt, player, weather, nearby) {
      const list = effects.spray;
      list.length = 0;
      playerVehicle = player.vehicle;
      wetness = weather.wetness;
      if (!(dt > 0)) return;
      const vehicle = player.vehicle, vel = vehicle.vel;
      const speed = Math.hypot(vel[0], vel[2]);
      const wet = saturate((weather.wetness - SPRAY_MIN_WETNESS) / (1 - SPRAY_MIN_WETNESS) + weather.puddles * 0.5);

      for (let i = 0; i < 4; i++) {
        const w = vehicle.wheels[i];
        if (!w.contact) continue;
        const e = wheelEmitters[i];
        const radius = player.kit.wheelRadius[i];
        const paved = w.surfaceKind === KIND.ASPHALT || w.surfaceKind === KIND.CONCRETE;
        const slip = Math.max((Math.abs(w.slipLong) - SLIP_LONG_START) / SLIP_LONG_RANGE, (Math.abs(w.slipLat) - SLIP_LAT_START) / SLIP_LAT_RANGE);
        // A wheel spinning on the spot has a slip ratio that means little; its surface speed says it all.
        const scrub = Math.abs(w.angVel * radius - vehicle.speed);
        const sliding = speed > 2 ? saturate(slip) : saturate((scrub - WHEELSPIN_SPEED) / 6);
        e.rate = 0;
        e.color = null;
        if (!paved && (w.surfaceKind === KIND.SAND || w.surfaceKind === KIND.GRASS)) {
          if (speed > DUST_MIN_SPEED || sliding > 0.2) {
            e.kind = 'dust';
            // Wet ground does not raise dust.
            e.rate = Math.min(DUST_MAX_RATE, (speed * DUST_RATE + sliding * 120)) * (1 - 0.85 * saturate(weather.wetness * 1.5));
            e.color = w.surfaceKind === KIND.SAND ? SAND_COLOR : EARTH_COLOR;
            e.size = 0.7 + sliding * 0.8;
          }
        } else if (paved && sliding > SMOKE_START && wet < 0.6) {
          e.kind = 'smoke';
          const amount = (sliding - SMOKE_START) / (1 - SMOKE_START);
          // Squared: a tyre just over the limit squeals long before it smokes.
          e.rate = SMOKE_RATE * amount * amount * (1 - wet) * (vehicle.drifting ? 1.3 : 1);
          e.size = 0.8 + sliding * 0.7;
        } else if (paved && wet > 0 && speed > SPRAY_MIN_SPEED && i >= 2) {
          // The rear wheels throw the plume; the fronts' spray is hidden under the car.
          e.kind = 'spray';
          e.rate = Math.min(SPRAY_MAX_RATE, (speed - SPRAY_MIN_SPEED) * SPRAY_RATE * wet);
          e.size = SPRAY_SIZE + smoothstep(8, 45, speed) * SPRAY_SIZE_FAST;
        }
        if (e.rate < 1) continue;
        // The contact patch at render time: the wheel centre in the car frame, down by the radius.
        local[0] = w.localPos[0]; local[1] = w.localPos[1] - radius * 0.9; local[2] = w.localPos[2] - radius * 0.6;
        m4transformPoint(e.position, player.view.matrix, local);
        // The emitter's own velocity: the renderer decides how much of it each kind of particle keeps.
        e.velocity[0] = vel[0]; e.velocity[1] = e.kind === 'spray' ? SPRAY_LIFT + speed * SPRAY_LIFT_PER_SPEED : 0.7; e.velocity[2] = vel[2];
        list.push(e);
      }

      // Other vehicles drag spray too, which is most of what a wet street looks like.
      if (wet > 0) {
        for (let i = 0, used = 0; i < nearby.length && used < MAX_TRAFFIC_SPRAY; i++) {
          const n = nearby[i];
          const v = Math.hypot(n.velocity[0], n.velocity[2]);
          if (v < SPRAY_MIN_SPEED + 2) continue;
          const e = trafficEmitters[used++];
          e.kind = 'spray'; e.color = null;
          e.rate = Math.min(TRAFFIC_SPRAY_MAX_RATE, (v - SPRAY_MIN_SPEED) * SPRAY_RATE * wet);
          e.size = SPRAY_SIZE + smoothstep(8, 45, v) * SPRAY_SIZE_FAST;
          // Behind the rear axle, on the centre line.
          e.position[0] = n.position[0] - n.velocity[0] / v * 1.6; e.position[1] = n.position[1] + 0.15; e.position[2] = n.position[2] - n.velocity[2] / v * 1.6;
          e.velocity[0] = n.velocity[0]; e.velocity[1] = SPRAY_LIFT + v * SPRAY_LIFT_PER_SPEED; e.velocity[2] = n.velocity[2];
          list.push(e);
        }
      }

      // Driving into the sea.
      if (vehicle.inWater && !wasInWater) {
        const p = player.pos;
        burst('splash', p[0], physics.seaLevel, p[2], vel[0] * 0.3, 3 + speed * 0.1, vel[2] * 0.3, 900, 1.6, null);
        if (audio) audio.impact(saturate(0.3 + speed / 30), p, 'splash');
      }
      wasInWater = vehicle.inWater;

      for (let i = 0; i < MAX_BURSTS; i++) {
        const b = bursts[i];
        if (b.ttl <= 0) continue;
        b.ttl -= dt;
        list.push(b);
      }
    },

    dispose() {
      unsubscribe();
    },
  };
  return effects;
}
