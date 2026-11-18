// Nitrous and exhaust flames (design/ARCHITECTURE.md section 16).
//
// Three things live here because they share the exhaust pipes:
//   - the nitrous tank: how much is left, when the valve may open, how it refills;
//   - after-fire: short bursts when unburnt fuel reaches a hot exhaust, on a sharp lift-off
//     at high revs and on an up-shift under power;
//   - what the renderer gets for both: `frame.exhaust` entries at the model's exhaust
//     anchors, a point light and a glow per burning flame, and `frame.speedEffect`.
//
// The game decides when the valve may open (`vehicle.setBoost`); the physics vehicle decides
// how much nitrous the engine really takes (`vehicle.boost`: nothing during a gear change or
// with the handbrake on, less when traction control trims). Tank, flames, camera and sound
// all follow what was really delivered, so they can never disagree with the acceleration.

import { saturate, smoothstep, damp, hashInts, m4transformPoint, m4transformDir, makeRng } from '../core/math.js';
import { CHANNEL } from '../core/ids.js';
import { GLOW_ROUND } from './lamps.js';

// Tank.
export const TANK_SECONDS = 6; // s of full flow in a full tank
const REFILL_SECONDS = 45; // s from empty to full while standing or driving badly
const REFILL_SECONDS_CLEAN = 15; // the same while driving cleanly at speed
const REFILL_DELAY = 1.2; // s after the valve closes before the tank starts to refill
const CLEAN_SPEED = 18, CLEAN_SPEED_FULL = 40; // m/s over which the faster refill fades in
const CLEAN_SLIP = 0.25; // tyre slip (0..1) above which driving is not clean
const RESTART_LEVEL = 0.12; // a tank run dry must refill to this before the valve opens again
const MIN_THROTTLE = 0.2;
const VALVE_OPEN_HALF_LIFE = 0.035, VALVE_CLOSE_HALF_LIFE = 0.07; // s: how the flame follows the valve

// After-fire.
const LIFT_FROM = 0.7, LIFT_TO = 0.12; // throttle before and after a lift-off
const LIFT_WINDOW = 0.18; // s within which the throttle must fall for the lift to count as sharp
const LIFT_RPM = 0.7; // share of the redline above which a lift-off fires
const SHIFT_RPM = 0.78; // share of the redline before an up-shift that fires
const SHIFT_THROTTLE = 0.6;
const POP_SECONDS = 0.13; // length of one burst
const POP_GAP_MIN = 0.06, POP_GAP_MAX = 0.17; // s between the bursts of one crackle
const COOLDOWN = 0.45; // s after a crackle before the next may start

// Light. Magnitudes are on the scale of the vehicle lamps (lamps.js): a brake lamp is 30.
const LIGHT_REACH = 0.4; // m beyond the pipe at which the light sits, inside the flame
const LIGHT_RADIUS = 7; // m
// The colours follow the flame the renderer draws. A nitrous jet is blue-white only in its core at the
// nozzle and burns amber along the rest of its length, so the glow on the pipe is blue-white while the
// light it throws on the road and the bumper, which comes from the whole flame, is amber.
const NITROUS_CORE = [0.6, 0.75, 1.0], NITROUS_LIGHT = [1.0, 0.5, 0.16], NITROUS_LIGHT_POWER = 45;
const AFTERFIRE_LIGHT = [1.0, 0.45, 0.1], AFTERFIRE_LIGHT_POWER = 40;
const GLOW_SIZE = 0.3, GLOW_POWER = 60;

// Speed effect.
const SPEED_EFFECT_FROM = 30, SPEED_EFFECT_TO = 85; // m/s
const SPEED_SHARE = 0.55, BOOST_SHARE = 0.45;
const BOOST_EFFECT_FROM = 8, BOOST_EFFECT_TO = 30; // m/s: no stretch from boost at a standstill
const SPEED_EFFECT_HALF_LIFE = 0.12;

const makeFlame = (kind, seed) => ({ position: [0, 0, 0], direction: [0, 0, 1], velocity: [0, 0, 0], strength: 0, kind, seed });

/**
 * @param {{exhausts?: Array<{pos: number[], dir: number[]}>, audio?: object|null, seed?: number}} options
 *   exhausts: the car model's `anchors.exhausts` (vehicle frame). Without them there are no
 *   flames; the tank and the boost work all the same.
 */
export function createNitrous({ exhausts = [], audio = null, seed = 1 } = {}) {
  const rng = makeRng(hashInts(seed, 0x6e32));
  const pipes = [];
  const local = [0, 0, 0];
  let valve = 0; // what is asked of the vehicle this frame, 0..1
  let dry = false;
  let sinceUse = REFILL_DELAY;
  let sinceFullThrottle = 1;
  let lastGear = 1, lastRpmShare = 0;
  let cooldown = 0;
  let popsQueued = 0, nextPop = 0, queuedStrength = 0, popSerial = 0;

  const nitrous = {
    /** Tank level, 0..1. */
    level: 1,
    /** True while nitrous is really flowing into the engine. */
    boosting: false,
    /** 0..1: the flow as the flames, the camera and the sound follow it (eased). */
    flow: 0,
    /** This frame's flames: pass as `frame.exhaust`. The entries are reused. */
    exhaust: [],
    /** 0..1: pass as `frame.speedEffect`. */
    speedEffect: 0,

    /**
     * The exhaust pipes the flames come out of: another car has taken the place of the one
     * the pipes belonged to. Burning flames go out with the old pipes.
     * @param {Array<{pos: number[], dir: number[]}>} anchors  the model's `anchors.exhausts`
     */
    setPipes(anchors) {
      nitrous.exhaust.length = 0;
      pipes.length = 0;
      for (let i = 0; i < anchors.length; i++) {
        pipes.push({
          anchor: anchors[i],
          jet: makeFlame('nitrous', i + 1),
          pop: makeFlame('afterfire', 0),
          /** Seconds left of this pipe's current burst, and its strength at the start. */
          popLeft: 0,
          popPeak: 0,
        });
      }
      popsQueued = 0;
    },

    /** A full tank and no flames: after the car is placed somewhere. */
    reset() {
      nitrous.level = 1; nitrous.boosting = false; nitrous.flow = 0; nitrous.speedEffect = 0;
      nitrous.exhaust.length = 0;
      valve = 0; dry = false; sinceUse = REFILL_DELAY; sinceFullThrottle = 1; cooldown = 0; popsQueued = 0;
      for (const pipe of pipes) pipe.popLeft = 0;
    },

    /**
     * Before the physics steps: the valve opening to ask of the vehicle.
     * @param {number} held      the boost control, 0..1
     * @param {number} throttle  the throttle control, 0..1
     * @param {object} vehicle   the physics vehicle (rpm, gear, spec.boost.minRpm)
     * @returns {number} 0..1 for `vehicle.setBoost`
     */
    request(held, throttle, vehicle) {
      // A tank that ran dry stays shut until there is enough for more than a splutter.
      if (dry && nitrous.level >= RESTART_LEVEL) dry = false;
      const open = held > 0 && !dry && nitrous.level > 0 && throttle > MIN_THROTTLE && vehicle.rpm > vehicle.spec.boost.minRpm && vehicle.gear >= 1;
      valve = open ? saturate(held) : 0;
      return valve;
    },

    /**
     * After the physics steps: tank, after-fire, flames, lights.
     * @param {number} dt        frame time, seconds; 0 while paused
     * @param {number} throttle  the throttle control this frame, 0..1
     * @param {object} player    from createPlayer (vehicle, slip, view.matrix)
     * @param {object} lamps     LampBuffer to add the flame lights and glows to
     */
    update(dt, throttle, player, lamps) {
      const vehicle = player.vehicle;
      const speed = Math.abs(vehicle.speed);
      if (dt > 0) {
        // Tank.
        const delivered = valve > 0 ? saturate(vehicle.boost) : 0;
        if (valve > 0) {
          nitrous.level = Math.max(0, nitrous.level - (delivered * dt) / TANK_SECONDS);
          sinceUse = 0;
          if (nitrous.level <= 0) { dry = true; valve = 0; }
        } else {
          sinceUse += dt;
          if (sinceUse >= REFILL_DELAY && nitrous.level < 1) {
            const clean = smoothstep(CLEAN_SPEED, CLEAN_SPEED_FULL, speed) * (player.slip < CLEAN_SLIP ? 1 : 0);
            const seconds = REFILL_SECONDS + (REFILL_SECONDS_CLEAN - REFILL_SECONDS) * clean;
            nitrous.level = Math.min(1, nitrous.level + dt / seconds);
          }
        }
        nitrous.boosting = valve > 0 && delivered > 0;
        nitrous.flow = damp(nitrous.flow, valve > 0 ? delivered : 0, delivered > nitrous.flow ? VALVE_OPEN_HALF_LIFE : VALVE_CLOSE_HALF_LIFE, dt);
        if (nitrous.flow < 0.004) nitrous.flow = 0;

        detectAfterfire(dt, throttle, vehicle);
        advancePops(dt);

        const wanted = saturate(
          SPEED_SHARE * smoothstep(SPEED_EFFECT_FROM, SPEED_EFFECT_TO, speed)
          + BOOST_SHARE * nitrous.flow * smoothstep(BOOST_EFFECT_FROM, BOOST_EFFECT_TO, speed));
        nitrous.speedEffect = damp(nitrous.speedEffect, wanted, SPEED_EFFECT_HALF_LIFE, dt);
      }

      // Flames at the pipes, where they are at render time.
      const list = nitrous.exhaust;
      list.length = 0;
      const matrix = player.view.matrix, vel = vehicle.vel;
      for (let i = 0; i < pipes.length; i++) {
        const pipe = pipes[i];
        const pop = pipe.popLeft > 0 ? pipe.popPeak * popEnvelope(1 - pipe.popLeft / POP_SECONDS) : 0;
        if (nitrous.flow > 0) emit(list, lamps, pipe.jet, pipe.anchor, matrix, vel, nitrous.flow, NITROUS_CORE, NITROUS_LIGHT, NITROUS_LIGHT_POWER);
        if (pop > 0.02) emit(list, lamps, pipe.pop, pipe.anchor, matrix, vel, pop, AFTERFIRE_LIGHT, AFTERFIRE_LIGHT, AFTERFIRE_LIGHT_POWER);
      }
    },
  };

  /** Sharp attack, longer tail: 0..1 over the life of a burst. */
  function popEnvelope(t) {
    return t < 0.15 ? t / 0.15 : 1 - smoothstep(0.15, 1, t);
  }

  function emit(list, lamps, flame, anchor, matrix, vel, strength, core, color, power) {
    m4transformPoint(flame.position, matrix, anchor.pos);
    m4transformDir(flame.direction, matrix, anchor.dir);
    const d = flame.direction, n = Math.hypot(d[0], d[1], d[2]) || 1;
    d[0] /= n; d[1] /= n; d[2] /= n;
    flame.velocity[0] = vel[0]; flame.velocity[1] = vel[1]; flame.velocity[2] = vel[2];
    flame.strength = strength;
    list.push(flame);
    const p = flame.position, k = power * strength;
    lamps.point(p[0] + d[0] * LIGHT_REACH, p[1] + d[1] * LIGHT_REACH + 0.05, p[2] + d[2] * LIGHT_REACH, LIGHT_RADIUS, color[0] * k, color[1] * k, color[2] * k);
    const g = GLOW_POWER * strength;
    lamps.glow(p[0] + d[0] * 0.06, p[1] + d[1] * 0.06, p[2] + d[2] * 0.06, GLOW_SIZE, core[0] * g, core[1] * g, core[2] * g, CHANNEL.ALWAYS, GLOW_ROUND);
  }

  function detectAfterfire(dt, throttle, vehicle) {
    cooldown -= dt;
    sinceFullThrottle = throttle >= LIFT_FROM ? 0 : sinceFullThrottle + dt;
    const rpmShare = vehicle.redline > 0 ? vehicle.rpm / vehicle.redline : 0;
    if (cooldown <= 0 && pipes.length > 0 && vehicle.gear >= 1) {
      const lifted = throttle <= LIFT_TO && sinceFullThrottle > 0 && sinceFullThrottle <= LIFT_WINDOW && rpmShare > LIFT_RPM;
      const shifted = vehicle.gear > lastGear && lastGear >= 1 && lastRpmShare > SHIFT_RPM && throttle > SHIFT_THROTTLE;
      if (lifted) {
        // Fuel keeps arriving for a moment after the throttle shuts: a crackle of a few bursts,
        // more of them the higher the engine was revving.
        const heat = saturate((rpmShare - LIFT_RPM) / (1 - LIFT_RPM));
        crackle(2 + rng.int(0, 1 + Math.round(heat * 2)), 0.55 + 0.45 * heat);
        sinceFullThrottle = LIFT_WINDOW + 1;
      } else if (shifted) {
        crackle(1, 0.6 + 0.4 * saturate((lastRpmShare - SHIFT_RPM) / (1 - SHIFT_RPM)));
      }
    }
    lastGear = vehicle.gear;
    lastRpmShare = rpmShare;
  }

  function crackle(count, strength) {
    popsQueued = count;
    queuedStrength = strength;
    nextPop = 0;
    cooldown = COOLDOWN + count * POP_GAP_MAX;
  }

  function advancePops(dt) {
    for (const pipe of pipes) if (pipe.popLeft > 0) pipe.popLeft -= dt;
    if (popsQueued <= 0) return;
    nextPop -= dt;
    if (nextPop > 0) return;
    // Each burst comes out of one pipe, picked afresh, and is a little weaker than the last.
    const pipe = pipes[rng.int(0, pipes.length - 1)];
    const strength = queuedStrength * rng.range(0.75, 1);
    pipe.popLeft = POP_SECONDS;
    pipe.popPeak = strength;
    pipe.pop.seed = hashInts(seed, ++popSerial) & 0xffff;
    if (audio) audio.afterfire(strength);
    queuedStrength *= 0.8;
    popsQueued--;
    nextPop = rng.range(POP_GAP_MIN, POP_GAP_MAX);
  }

  nitrous.setPipes(exhausts);
  return nitrous;
}
