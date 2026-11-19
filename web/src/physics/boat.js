// A boat: buoyancy first, engine second.
//
// A car in this engine is tyres arguing with a road; a boat is a hull arguing with a volume of water, and
// the argument is Archimedes'. The hull is sampled at six points — four corners of the waterplane and the
// stems fore and aft — and each point that is under the surface pushes up with the weight of the water it
// displaced (rho * g * area * depth). Summed, those six springs are the whole of flotation: they hold the
// boat at a draft of mass / (rho * waterplane area), they right a heel because a dipped side immerses
// deeper and pushes harder, and they pitch a bow wave back down because a buried stem is a buried stem.
// Nothing here is a heightfield cheat: the boat floats because the water pushes it, and it sinks towards
// an equilibrium it can be measured at, which is what makes the numbers in test/game/boat.test.mjs worth
// asserting.
//
// What the water takes as well as gives: drag. Surge dies quadratically (a hull makes its own wake), sway
// dies hard (water is a wall sideways), and the rudder only bites on flow — a boat with no way on does not
// turn, because a rudder is a wing and a wing needs air.
//
// The interface is the car's on purpose — pos, yaw, vel, speed, renderPos, renderQuat, step(dt, input) — so
// that the chase camera, the audio and the HUD can hold a boat without learning a new verb.

import { clamp } from '../core/math.js';

/** kg/m3: the sea the coast map meshes is salt, and salt water holds a hull up better than fresh. */
export const RHO = 1025;
/** m/s2. */
const G = 9.81;

/**
 * @param {{
 *   mass?: number,            kg, displacement included
 *   length?: number,          m overall
 *   beam?: number,            m overall
 *   waterplane?: number,      0..1 fullness of the waterplane against length*beam (a planing hull ~0.6)
 *   power?: number,           N of thrust at full throttle
 *   maxTurn?: number,         rad/s of yaw rate at full rudder and way on
 *   water?: (x: number, z: number) => number,   the surface height; defaults to still water at 0
 * }} spec
 */
export function boatSpec(spec = {}) {
  const mass = spec.mass || 1400;
  const length = spec.length || 6.4;
  const beam = spec.beam || 2.4;
  const waterplane = spec.waterplane || 0.62;
  const area = length * beam * waterplane;
  return Object.freeze({
    mass, length, beam, waterplane, area,
    power: spec.power || 9000,
    maxTurn: spec.maxTurn || 0.85,
    /** m of hull under the surface at rest: the draft the boat was promised. */
    draft: mass / (RHO * area),
    water: spec.water || null,
  });
}

/** The six hull points, in body metres: +Z is the bow, +X the right hand side. */
const POINTS = Object.freeze([
  [0.42, 0.5], [-0.42, 0.5], [0.42, -0.5], [-0.42, -0.5],   // the waterplane corners, as fractions
  [0, 0.5], [0, -0.5],                                       // and the stems
]);

/**
 * @param {object} spec        from `boatSpec`
 * @param {{x?: number, y?: number, z?: number, yaw?: number}} [at]
 */
export function createBoat(spec, at = {}) {
  const waterAt = spec.water || (() => 0);
  const m = spec.mass;
  // Rotational masses of a hull: I = m * (k * L)^2, with the radii of gyration a boat actually has.
  const Ipitch = m * Math.pow(0.28 * spec.length, 2);
  const Iroll = m * Math.pow(0.38 * spec.beam, 2);
  // There is no yaw inertia to match: a hull's heading is a rate the rudder sets against the flow (see
  // the yaw below), not a moment divided by a mass, so only the two that are divided by anything are here.

  const boat = {
    spec,
    pos: [at.x || 0, at.y || 0, at.z || 0],
    yaw: at.yaw || 0,
    /** rad: bow-up and right-down, small angles about the body axes. */
    pitch: 0, roll: 0,
    vel: [0, 0, 0],            // world m/s
    pitchRate: 0, rollRate: 0, yawRate: 0,
    /** m of hull in the water right now, mean over the samples: what a wake and a hull sound read. */
    immersion: 0,
    /** True while the keel is touching what is under the water: a beach, a sandbar, the seabed. */
    aground: false,
    input: { throttle: 0, steer: 0, brake: 0 },

    get speed() { return Math.hypot(boat.vel[0], boat.vel[2]); },
    get forwardSpeed() {
      const s = Math.sin(boat.yaw), c = Math.cos(boat.yaw);
      return boat.vel[0] * s + boat.vel[2] * c;
    },
    get renderPos() { return boat.pos; },
    get renderQuat() {
      // yaw, then the small pitch and roll about the turned body axes: half-angles, multiplied out.
      const hy = boat.yaw * 0.5, hp = boat.pitch * 0.5, hr = boat.roll * 0.5;
      const cy = Math.cos(hy), sy = Math.sin(hy), cp = Math.cos(hp), sp = Math.sin(hp);
      const cr = Math.cos(hr), sr = Math.sin(hr);
      // q = qy * qp * qr, body order yaw-pitch-roll
      const y = [0, sy, 0, cy], p = [sp, 0, 0, cp], r = [0, 0, sr, cr];
      const mul = (a, b) => [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
      ];
      return mul(mul(y, p), r);
    },

    place(x, y, z, yaw = 0) {
      boat.pos[0] = x; boat.pos[1] = y; boat.pos[2] = z; boat.yaw = yaw;
      boat.vel[0] = boat.vel[1] = boat.vel[2] = 0;
      boat.pitch = boat.roll = boat.pitchRate = boat.rollRate = boat.yawRate = 0;
      return boat;
    },

    /**
     * One step of the water's argument.
     * @param {number} dt seconds
     * @param {{throttle?: number, steer?: number, brake?: number}} input  -1..1 each
     */
    step(dt, input = {}) {
      const th = clamp(input.throttle || 0, -1, 1);
      const st = clamp(input.steer || 0, -1, 1);
      const br = clamp(input.brake || 0, 0, 1);
      boat.input.throttle = th; boat.input.steer = st; boat.input.brake = br;

      const s = Math.sin(boat.yaw), c = Math.cos(boat.yaw);
      // Body axes in the world: forward (bow) and right, flat on the surface — the small angles ride on
      // top of the heading rather than inside it.
      const fwd = [s, 0, c], right = [c, 0, -s];
      const vFwd = boat.vel[0] * fwd[0] + boat.vel[2] * fwd[2];
      const vRight = boat.vel[0] * right[0] + boat.vel[2] * right[2];

      // Buoyancy, point by point: how deep each sample of the hull is under the local surface.
      let Fy = 0, torquePitch = 0, torqueRoll = 0, immersed = 0, samples = 0;
      const share = (spec.area / POINTS.length) * RHO * G;
      for (const [fx, fz] of POINTS) {
        const bx = fx * spec.beam, bz = fz * spec.length;
        // World offset of the sample: turned by the heading, lifted by pitch (bow up raises the bow)
        // and dropped by roll (right down lowers the right hand side).
        const wx = boat.pos[0] + right[0] * bx + fwd[0] * bz;
        const wz = boat.pos[2] + right[2] * bx + fwd[2] * bz;
        const wy = boat.pos[1] + boat.pitch * bz - boat.roll * bx;
        const h = waterAt(wx, wz) - wy;
        if (h > 0) {
          const f = share * Math.min(h, spec.draft * 2.2);   // a deck under water floods, it does not dive
          Fy += f;
          torquePitch += f * bz;
          torqueRoll -= f * bx;
          immersed += Math.min(h, spec.draft * 2.2);
          samples++;
        }
      }
      boat.immersion = samples ? immersed / samples : 0;
      boat.aground = boat.immersion > 0 && boat.immersion < spec.draft * 0.45;

      // Heave: buoyancy up, weight down, and the water's own dashpot on vertical motion — a hull that
      // slaps back down on its own wake is a hull that slaps.
      const heaveDamp = RHO * G * spec.area * 0.22;
      const ay = (Fy - m * G - heaveDamp * boat.vel[1]) / m;
      boat.vel[1] += ay * dt;

      // Pitch and roll: the restoring torques above, damped by the water the hull has to move out of
      // the way to rock, and stiffer in roll than a car ever is because a keel and a beam are a spring.
      boat.pitchRate += (torquePitch / Ipitch - 2.4 * boat.pitchRate - 3.0 * boat.pitch) * dt;
      boat.rollRate += (torqueRoll / Iroll - 2.2 * boat.rollRate - 3.4 * boat.roll) * dt;
      boat.pitch = clamp(boat.pitch + boat.pitchRate * dt, -0.5, 0.5);
      boat.roll = clamp(boat.roll + boat.rollRate * dt, -0.9, 0.9);

      // Thrust along the bow, a little of it lifting the stern squat at speed; brake is a wake-making
      // drag rather than a stop, because water has no brakes.
      const thrust = th * spec.power * (boat.aground ? 0.25 : 1);
      const dragSurge = 350 + 26 * Math.abs(vFwd);   // viscous at walking pace, wake-making above it
      const aFwd = (thrust - dragSurge * vFwd - br * 900 * vFwd) / m;
      // Sway: the hull's sideways resistance is an order above its lengthwise one, which is why a boat
      // turns by pointing, not by sliding.
      const aRight = (-1600 * vRight) / m;
      const vF = vFwd + aFwd * dt, vR = vRight + aRight * dt;
      boat.vel[0] = vF * fwd[0] + vR * right[0];
      boat.vel[2] = vF * fwd[2] + vR * right[2];

      // The rudder: a wing under the stern. No flow, no bite — way on or prop wash, whichever is greater.
      const flow = Math.min(1, Math.abs(vF) / 2.2 + Math.abs(th) * 0.55);
      const yawAccel = (st * spec.maxTurn * flow * 2.6 - 2.0 * boat.yawRate) * (boat.aground ? 0.3 : 1);
      boat.yawRate += yawAccel * dt;
      boat.yaw += boat.yawRate * dt;
      if (boat.yaw > Math.PI) boat.yaw -= Math.PI * 2;
      else if (boat.yaw < -Math.PI) boat.yaw += Math.PI * 2;

      boat.pos[0] += boat.vel[0] * dt;
      boat.pos[1] += boat.vel[1] * dt;
      boat.pos[2] += boat.vel[2] * dt;
      return boat;
    },
  };

  // Settle: drop the hull from the surface line and let the six springs find the draft before anybody
  // reads it, so a moored boat is a floating boat from its first frame on screen.
  boat.pos[1] = (at.y || 0) - spec.draft;
  for (let i = 0; i < 90; i++) boat.step(1 / 60, {});
  boat.vel[0] = boat.vel[1] = boat.vel[2] = 0;
  boat.pitchRate = boat.rollRate = boat.yawRate = 0;
  return boat;
}
