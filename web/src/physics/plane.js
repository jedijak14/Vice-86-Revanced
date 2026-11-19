// An aeroplane: wings first, engine second, and the ground a fact it has to argue with.
//
// A car is tyres arguing with a road and a boat is a hull arguing with Archimedes; an aeroplane is a
// wing arguing with the air it is dragged through, and the argument is the same one at every altitude.
// Everything here is the standard set of equations a pilot is taught, in the units a pilot is taught
// them in, with the coefficients of three real aeroplanes of 1986:
//
//   L = q·S·Cl     D = q·S·Cd     q = ½·ρ·V²      Cl = Cl0 + Cla·α   (up to the stall, then it falls)
//   Cd = Cd0 + k·Cl²                                ρ = the ISA atmosphere's, so a plane flies further
//                                                   and faster high up and lands longer on a hot day
//
// The attitude is integrated from the three moment equations — Cm_α gives the nose-down pitch that makes
// an aeroplane stable, Cn_β the weathercock yaw that puts the nose back into the wind, Cl_β the dihedral
// that lifts a dropped wing — and the velocity from the three forces. Nothing here turns the aircraft
// because the player pressed a button: bank it and the lift vector tilts, the horizontal component of
// lift bends the flight path, and the yaw follows the sideslip the way a real one does. That is why a
// stall is a stall rather than a limit, why a landing can be firm, and why the numbers in
// test/physics/plane.test.mjs are the numbers in the aeroplane's own handbook.
//
// The interface is the car's and the boat's on purpose — pos, yaw, vel, speed, renderPos, renderQuat,
// step(dt, input) — so the camera, the audio and the HUD can hold one without learning a new verb.

import { clamp } from '../core/math.js';

/** kg/m3 at sea level in the standard atmosphere, and the lapse the troposphere actually has. */
export const RHO0 = 1.225;
const LAPSE = 2.25577e-5;   // per metre, ISA below 11 km
const EXP = 4.2561;
/** m/s2. */
const G = 9.81;
/** m/s per knot, for the instruments. */
export const KNOT = 0.514444;

/** The ISA density at a height in metres above sea level. Thinner air holds a wing up less well. */
export function airDensity(h) {
  const hh = Math.max(-100, Math.min(11000, h));
  return RHO0 * Math.pow(1 - LAPSE * hh, EXP);
}

/**
 * Three aeroplanes, each with its own handbook numbers.
 * `thrust` is static thrust in newtons; `prop` says how much of it the slipstream loses with speed
 * (a propeller does, badly; a jet barely does), and `burn` is the fuel it drinks per second at full
 * throttle, in kilograms — the mass of the aeroplane falls as it flies, which is why a long trip lands
 * shorter than it took off.
 */
export const AIRFRAMES = Object.freeze({
  trainer: {
    name: 'Paloma Flight School Trainer', tail: 'N86PT', seats: 2,
    dryMass: 780, fuelMax: 180, wingArea: 16.2, span: 10.7, chord: 1.5, length: 8.0,
    cl0: 0.25, clAlpha: 4.9, clMax: 1.5, clMaxFlaps: 1.9, cd0: 0.032, k: 0.048,
    thrust: 2600, aileron: 0.030, prop: 0.55, vmax: 78, vne: 88, burn: 0.0185, gearLength: 1.15,
  },
  commuter: {
    name: 'Vice Interline Twin', tail: 'N86VC', seats: 19,
    dryMass: 4300, fuelMax: 1400, wingArea: 27.4, span: 15.3, chord: 1.9, length: 15.7,
    cl0: 0.28, clAlpha: 4.8, clMax: 1.7, clMaxFlaps: 2.1, cd0: 0.030, k: 0.045,
    thrust: 13200, aileron: 0.020, prop: 0.42, vmax: 140, vne: 165, burn: 0.105, gearLength: 1.6,
  },
  jet: {
    name: 'Escobar Executive Jet', tail: 'N86IJ', seats: 8,
    dryMass: 4800, fuelMax: 2000, wingArea: 24.6, span: 12.0, chord: 2.1, length: 14.8,
    cl0: 0.2, clAlpha: 4.6, clMax: 1.4, clMaxFlaps: 1.8, cd0: 0.028, k: 0.06,
    // `vne` is the speed the airframe stops being an aeroplane and starts being a problem, and for a light
    // jet it is a low-altitude limit rather than a structural one: 420 kt indicated, which is where the
    // real ones are placarded. Full throttle in level flight gets to 396 kt and stays inside it; a six
    // degree dive from two and a half thousand metres goes through it, which is the only place a pilot
    // ever meets the number and therefore the only place the warning is worth printing.
    thrust: 22200, aileron: 0.017, prop: 0.12, vmax: 245, vne: 216, burn: 0.175, gearLength: 1.5,
  },
});

/**
 * @param {object|string} airframe  an AIRFRAMES entry or its name
 * @param {{fuel?: number, thrustScale?: number}} [over]
 */
export function planeSpec(airframe = 'trainer', over = {}) {
  const a = typeof airframe === 'string' ? AIRFRAMES[airframe] || AIRFRAMES.trainer : airframe;
  const fuel = over.fuel === undefined ? a.fuelMax : clamp(over.fuel, 0, a.fuelMax);
  const thrustScale = over.thrustScale === undefined ? 1 : over.thrustScale;
  const mass = a.dryMass + fuel;
  // Radii of gyration an aeroplane of this span actually has, so the rates come out right rather than
  // merely plausible: a trainer answers the stick in about a second, a jet takes two.
  const b = a.span;
  const spec = Object.freeze({
    ...a, fuel, fuelMax: a.fuelMax, mass, thrust: a.thrust * thrustScale,
    span: b, wingArea: a.wingArea, chord: a.chord,
    ixx: mass * Math.pow(0.11 * b, 2),
    iyy: mass * Math.pow(0.125 * b, 2),
    izz: mass * Math.pow(0.14 * b, 2),
    /** m/s at which the wing stops holding it, clean and with everything down. */
    stallSpeed: stallSpeedOf(a, mass, 0),
    stallSpeedFlaps: stallSpeedOf(a, mass, 1),
    /** m/s: the handbook's rotation speed is 1.2 times the stall, and the approach 1.3. */
    rotateSpeed: 1.2 * stallSpeedOf(a, mass, 0),
    approachSpeed: 1.3 * stallSpeedOf(a, mass, 1),
  });
  return spec;
}

/** Vs = sqrt(2·W / (ρ·S·Cl_max)) — the speed the wing runs out of at this mass and flap setting. */
export function stallSpeedOf(a, mass, flaps = 0) {
  const cl = flaps > 0 ? a.clMaxFlaps : a.clMax;
  return Math.sqrt((2 * mass * G) / (RHO0 * a.wingArea * cl));
}

/** Flap settings: what they add to the wing's lift, what they add to its drag, and how fast they may go. */
export const FLAPS = Object.freeze([
  { deg: 0, dCl: 0, dCd: 0 },
  { deg: 15, dCl: 0.28, dCd: 0.014 },
  { deg: 32, dCl: 0.52, dCd: 0.038 },
]);
/** The gear's own drag, and how fast it may be down before the doors and the legs complain. */
export const GEAR_CD = 0.026, GEAR_VLE = 75;

/**
 * The body axes from an attitude, in the frame this engine draws in: +Z forward, +X right, +Y up.
 * Yaw, then pitch about the right axis, then roll about the forward axis — the order a pilot reads an
 * attitude in, and the one the renderer's matrix is built from, so what is drawn is what is flown.
 */
/**
 * The attitude as a quaternion, from the same three angles and the same sign convention as
 * `basisFromAttitude`: a positive roll puts the right wing down, a positive yaw turns right, and a
 * positive pitch raises the nose. Two vehicles fly and ride on this file's convention, so the sign
 * lives here once rather than in each of their render paths.
 * @param {number} yaw @param {number} pitch @param {number} roll  radians
 * @param {number[]} [out]  [x, y, z, w]
 */
export function quatFromAttitude(yaw, pitch, roll, out = [0, 0, 0, 1]) {
  const axes = basisFromAttitude(yaw, pitch, roll, scratchAttitude);
  const r = axes.lateral, u = axes.up, f = axes.forward;
  const tr = r[0] + u[1] + f[2];
  if (tr > 0) {
    const k = Math.sqrt(tr + 1) * 2;
    out[0] = (u[2] - f[1]) / k; out[1] = (f[0] - r[2]) / k; out[2] = (r[1] - u[0]) / k; out[3] = 0.25 * k;
    return out;
  }
  // The trace went negative: read the quaternion off whichever diagonal is largest instead.
  if (r[0] > u[1] && r[0] > f[2]) {
    const k = Math.sqrt(1 + r[0] - u[1] - f[2]) * 2;
    out[0] = 0.25 * k; out[1] = (r[1] + u[0]) / k; out[2] = (r[2] + f[0]) / k; out[3] = (u[2] - f[1]) / k;
  } else if (u[1] > f[2]) {
    const k = Math.sqrt(1 + u[1] - r[0] - f[2]) * 2;
    out[0] = (r[1] + u[0]) / k; out[1] = 0.25 * k; out[2] = (u[2] + f[1]) / k; out[3] = (f[0] - r[2]) / k;
  } else {
    const k = Math.sqrt(1 + f[2] - r[0] - u[1]) * 2;
    out[0] = (r[2] + f[0]) / k; out[1] = (u[2] + f[1]) / k; out[2] = 0.25 * k; out[3] = (r[1] - u[0]) / k;
  }
  return out;
}

const scratchAttitude = {};
const scratchQuat = [0, 0, 0, 1];

/**
 * The three body axes from the three angles, in the world's own frame.
 *
 * One thing about that frame decides the sign of everything below, so it is written down: the map is laid
 * out with +X east and +Z *south* (design/map/layout.json says so in its meta), which makes a yaw of zero
 * a heading of 180 and puts a vehicle's own left side along +X when it faces that way. `lateral` is
 * therefore the *port* side, and a positive roll puts it down: a bank to the left. That is the same sign
 * as a positive yaw, which is a turn to the left, which is the same sign as `controls.steer` positive,
 * which the rest of the game has called left since the beginning. One convention, all the way through,
 * and the compass a pilot reads is 180 - yaw rather than yaw.
 * @param {number} yaw @param {number} pitch @param {number} roll  radians
 * @param {object} [out]  filled with `forward`, `lateral` (port) and `up`
 */
export function basisFromAttitude(yaw, pitch, roll, out = {}) {
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sr = Math.sin(roll), cr = Math.cos(roll);
  const f0 = [sy, 0, cy], r0 = [cy, 0, -sy], u0 = [0, 1, 0];
  const f = [f0[0] * cp + u0[0] * sp, f0[1] * cp + u0[1] * sp, f0[2] * cp + u0[2] * sp];
  const up = [u0[0] * cp - f0[0] * sp, u0[1] * cp - f0[1] * sp, u0[2] * cp - f0[2] * sp];
  const r = [r0[0] * cr - up[0] * sr, r0[1] * cr - up[1] * sr, r0[2] * cr - up[2] * sr];
  const u = [up[0] * cr + r0[0] * sr, up[1] * cr + r0[1] * sr, up[2] * cr + r0[2] * sr];
  out.forward = f; out.lateral = r; out.up = u;
  return out;
}

/**
 * @param {object} spec  from `planeSpec`
 * @param {{x?: number, y?: number, z?: number, yaw?: number, ground?: (x: number, z: number) => number}} [at]
 *   `y` is the aircraft's own height, not the ground's; the gear hangs `gearLength` below it.
 */
export function createPlane(spec, at = {}) {
  const groundAt = at.ground || (() => 0);
  const axes = { forward: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] };
  let fuel = spec.fuel;

  const plane = {
    spec,
    /** m: the aircraft's own reference point, with the gear `gearLength` below it. */
    pos: [at.x || 0, at.y || 0, at.z || 0],
    /** rad: heading, nose-up, right-wing-down — the attitude a pilot reads off the panel. */
    yaw: at.yaw || 0, pitch: 0, roll: 0,
    /** rad/s about the body axes: roll, pitch, yaw. */
    p: 0, q: 0, r: 0,
    vel: [0, 0, 0],
    /** deg: what the wing is being asked to do, and what the air is doing about it. */
    alpha: 0, beta: 0,
    /** True while the wheels are on something. */
    onGround: true,
    /** 0..2 of flap, and whether the legs are down. */
    flaps: 0, gearDown: true,
    input: { throttle: 0, elevator: 0, aileron: 0, rudder: 0, brake: 0 },
    /** Instruments, all of them read straight off the state rather than estimated. */
    gLoad: 1, lift: 0, drag: 0, thrust: 0, qDyn: 0, rho: RHO0,
    /** What the last substep decided, filled in place: a test reads it and the tuning is checked, not trusted. */
    debug: { alpha: 0, aStall: 0, cl: 0, cd: 0, cm: 0, clRoll: 0, cn: 0, qDyn: 0, pDot: 0, qDot: 0, rDot: 0, fy: 0 },
    stalled: false, overspeed: false, gearUnsafe: false,
    /** m/s down at the last touchdown, and whether it was firm enough to be called a bad landing. */
    touchdownSink: 0, crashed: false,
    /** kg of fuel left, and how far the aeroplane has flown since it was parked. */
    distance: 0, airborne: 0,

    get mass() { return spec.dryMass + fuel; },
    get fuelKg() { return fuel; },
    get fuelFraction() { return spec.fuelMax > 0 ? fuel / spec.fuelMax : 0; },
    get speed() { return Math.hypot(plane.vel[0], plane.vel[1], plane.vel[2]); },
    /** m/s through the air, which is the only speed a wing cares about. */
    get airspeed() { return plane.speed; },
    /** m/s the airspeed indicator reads: the true speed corrected for the thinner air up there. */
    get ias() { return plane.speed * Math.sqrt(plane.rho / RHO0); },
    get knots() { return plane.ias / KNOT; },
    get forwardSpeed() {
      const f = axes.forward;
      return plane.vel[0] * f[0] + plane.vel[1] * f[1] + plane.vel[2] * f[2];
    },
    get altitude() { return plane.pos[1] - groundAt(plane.pos[0], plane.pos[2]); },
    get verticalSpeed() { return plane.vel[1]; },
    /** ft/min, the number on the panel's needle. */
    get vsi() { return plane.vel[1] * 196.85; },
    /**
     * The compass heading in degrees, which is not the yaw: the map is laid out with +Z south, so a yaw
     * of zero is a heading of 180 and north is at zero. A panel that read the yaw would tell a pilot he
     * was flying south on a northbound runway, and he would believe it.
     */
    get heading() { return ((180 - (plane.yaw * 180) / Math.PI) % 360 + 360) % 360; },
    get stallSpeed() { return stallSpeedOf(spec, plane.mass, plane.flaps > 0 ? 1 : 0); },
    get renderPos() { return plane.pos; },
    get renderQuat() { return quatFromAttitude(plane.yaw, plane.pitch, plane.roll, scratchQuat); },

    /**
     * Put the aeroplane somewhere. Without `air` it is parked: settled on its legs, wheels down, at the
     * height the ground under it asks for. With `air` — a speed in m/s — it is placed flying at that
     * speed along the heading given, which is how a test of the air's own behaviour starts one and how
     * a flight that was left in the air would be handed back.
     * @param {number} x @param {number} y @param {number} z @param {number} [yaw] @param {number|null} [air]
     */
    place(x, y, z, yaw = 0, air = null) {
      plane.pos[0] = x; plane.pos[1] = y; plane.pos[2] = z; plane.yaw = yaw;
      plane.pitch = plane.roll = plane.p = plane.q = plane.r = 0;
      plane.alpha = plane.beta = 0; plane.crashed = false; plane.touchdownSink = 0;
      plane.airborne = 0; plane.distance = 0;
      if (air === null || air === undefined) {
        plane.vel[0] = plane.vel[1] = plane.vel[2] = 0;
        plane.onGround = true; plane.gearDown = true; plane.flaps = 0;
        plane.pos[1] = groundAt(x, z) + spec.gearLength;
      } else {
        plane.vel[0] = Math.sin(yaw) * air; plane.vel[1] = 0; plane.vel[2] = Math.cos(yaw) * air;
        plane.onGround = false; plane.gearDown = false; plane.flaps = 0;
      }
      return plane;
    },

    /** Fuel for a trip: the tanks are filled to `kg`, which is how a dispatcher hands over an aeroplane. */
    refuel(kg = spec.fuelMax) { fuel = clamp(kg, 0, spec.fuelMax); return plane; },

    /**
     * One step of the air's argument, substepped: an aeroplane at 200 m/s moves 1.7 m per 1/120 s and
     * the moment equations are stiff enough that a single step of that length is a step too far.
     * @param {number} dt seconds
     * @param {{throttle?: number, elevator?: number, aileron?: number, rudder?: number, brake?: number,
     *          flaps?: number, gear?: boolean}} input  each axis -1..1, throttle 0..1
     */
    step(dt, input = {}) {
      const th = clamp(input.throttle === undefined ? plane.input.throttle : input.throttle, 0, 1);
      const el = clamp(input.elevator || 0, -1, 1);
      const al = clamp(input.aileron || 0, -1, 1);
      const ru = clamp(input.rudder || 0, -1, 1);
      const br = clamp(input.brake || 0, 0, 1);
      plane.input.throttle = th; plane.input.elevator = el;
      plane.input.aileron = al; plane.input.rudder = ru; plane.input.brake = br;
      if (input.flaps !== undefined) plane.flaps = clamp(Math.round(input.flaps), 0, 2);
      if (input.gear !== undefined) plane.gearDown = !!input.gear;

      const n = Math.max(1, Math.min(6, Math.ceil(dt / (1 / 240))));
      const h = dt / n;
      for (let i = 0; i < n; i++) substep(h, th, el, al, ru, br);
      return plane;
    },
  };

  /** The physics, once, at a length of time short enough to be honest. */
  function substep(dt, th, el, al, ru, br) {
    const m = plane.mass;
    const groundY = groundAt(plane.pos[0], plane.pos[2]);
    basisFromAttitude(plane.yaw, plane.pitch, plane.roll, axes);
    const f = axes.forward, r = axes.lateral, u = axes.up;

    // What the air is: thinner with height, so the same aeroplane flies faster and lands longer up there.
    const rho = airDensity(plane.pos[1]);
    plane.rho = rho;
    const V = plane.speed;
    const q = 0.5 * rho * V * V;
    plane.qDyn = q;

    // The velocity in body axes, which is where an aeroplane's angles live.
    const vF = plane.vel[0] * f[0] + plane.vel[1] * f[1] + plane.vel[2] * f[2];
    const vR = plane.vel[0] * r[0] + plane.vel[1] * r[1] + plane.vel[2] * r[2];
    const vU = plane.vel[0] * u[0] + plane.vel[1] * u[1] + plane.vel[2] * u[2];
    // The wing's angle to the flow it is in: nose up to the wind is a positive alpha, and past the
    // critical one the flow separates and the lift falls away — that is the stall, and it is a property
    // of the alpha, not of a speed the game invented.
    const alpha = V > 1 ? Math.atan2(-vU, Math.max(0.5, vF)) : plane.pitch;
    const beta = V > 1 ? Math.asin(clamp(vR / V, -1, 1)) : 0;
    plane.alpha = alpha * 180 / Math.PI;
    plane.beta = beta * 180 / Math.PI;

    const flap = FLAPS[plane.flaps];
    const clMaxEff = (plane.flaps > 0 ? spec.clMaxFlaps : spec.clMax) + flap.dCl;
    const aStall = clMaxEff > spec.cl0 ? (clMaxEff - spec.cl0) / spec.clAlpha : 0.3;
    // The lift curve: straight to the stall, and past it a falling branch that bottoms out at what a
    // flat plate still makes, because a separated wing is not a wing with no lift but one with a great
    // deal less lift and a great deal more drag. `stallBreak` below is the nose dropping through it.
    const past = Math.max(0, alpha - aStall);
    const cl = alpha <= aStall
      ? spec.cl0 + flap.dCl + spec.clAlpha * alpha
      : Math.max(0.5, clMaxEff - (clMaxEff - 0.5) * Math.min(1, past / 0.6));
    plane.stalled = past > 0.02 && V > 5;

    const cd = spec.cd0 + flap.dCd + spec.k * cl * cl + 1.9 * past * past
      + (plane.gearDown ? GEAR_CD * (plane.onGround ? 0.35 : 1) : 0)
      + 1.1 * beta * beta;
    plane.gearUnsafe = plane.gearDown && plane.ias > GEAR_VLE;
    plane.overspeed = plane.ias > spec.vne;

    const lift = q * spec.wingArea * cl;
    const drag = q * spec.wingArea * cd;
    plane.lift = lift; plane.drag = drag;
    // Thrust: a propeller's falls off with speed because the disc it screws through is already moving,
    // a jet's barely does. No fuel, no thrust — and then the aeroplane is a glider with an engine drag.
    fuel = Math.max(0, fuel - th * spec.burn * dt);
    const thrust = fuel > 0
      ? th * spec.thrust * Math.max(0.08, 1 - spec.prop * Math.min(1, plane.ias / spec.vmax))
      : -0.06 * spec.thrust * th;
    plane.thrust = thrust;

    // Lift acts across the flow in the plane of symmetry, drag back along it, thrust along the crankshaft.
    const vhat = V > 0.5 ? [plane.vel[0] / V, plane.vel[1] / V, plane.vel[2] / V] : f;
    let lx = u[0] - vhat[0] * (u[0] * vhat[0] + u[1] * vhat[1] + u[2] * vhat[2]);
    let ly = u[1] - vhat[1] * (u[0] * vhat[0] + u[1] * vhat[1] + u[2] * vhat[2]);
    let lz = u[2] - vhat[2] * (u[0] * vhat[0] + u[1] * vhat[1] + u[2] * vhat[2]);
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx /= ll; ly /= ll; lz /= ll;
    let fx = thrust * f[0] - drag * vhat[0] + lift * lx + q * spec.wingArea * (-0.55 * beta) * r[0];
    let fy = thrust * f[1] - drag * vhat[1] + lift * ly + q * spec.wingArea * (-0.55 * beta) * r[1] - m * G;
    let fz = thrust * f[2] - drag * vhat[2] + lift * lz + q * spec.wingArea * (-0.55 * beta) * r[2];
    plane.gLoad = lift / (m * G);

    // ---- moments, non-dimensionalised the way the coefficients are written for ----
    const pDim = plane.p * spec.span / (2 * Math.max(8, plane.ias));
    const qDim = plane.q * spec.chord / (2 * Math.max(8, plane.ias));
    const rDim = plane.r * spec.span / (2 * Math.max(8, plane.ias));
    // The stall break: past the critical angle the centre of pressure moves back and the nose goes
    // down on its own, which is the whole of stall recovery and the reason an aeroplane is flyable.
    const cm = -0.9 * clamp(alpha, -0.8, 0.8) - 2.4 * past - 20 * qDim + 0.7 * el - flap.dCl * 0.22;
    // Full aileron gives a steady roll *rate*, not a bank angle: the wing keeps going round until the
    // stick is centred, which is why the number here is a rate and why it is small. A trainer answers at
    // about twenty-five degrees a second, a light jet at forty, and a stalled wing's ailerons are in
    // separated air and barely half as good as they were — which is the reason a stall is recovered with
    // the rudder and the elevator, not by hauling on the aileron.
    const alEff = past > 0 ? al * 0.45 : al;
    const clRoll = -0.12 * beta - 0.8 * pDim + 0.08 * rDim + spec.aileron * alEff;
    // The fin: a weathervane that puts the nose back into the airflow, a damping in yaw, and a rudder
    // whose authority is a quarter of the fin's rather than nearly all of it. That ratio is what decides
    // how far an aeroplane slips when a pilot holds a rudder on, and a full rudder at cruise is about ten
    // degrees of slip — enough to make the ball a real instrument and not a decoration, and not so much
    // that a quarter of a pedal rolls the wings over by itself.
    const cn = 0.18 * beta - 0.25 * rDim + 0.045 * ru;
    const pDot = (q * spec.wingArea * spec.span * clRoll) / spec.ixx;
    const qDot = (q * spec.wingArea * spec.chord * cm) / spec.iyy;
    const rDot = (q * spec.wingArea * spec.span * cn) / spec.izz;
    const dbg = plane.debug;
    dbg.alpha = alpha; dbg.aStall = aStall; dbg.cl = cl; dbg.cd = cd; dbg.cm = cm;
    dbg.clRoll = clRoll; dbg.cn = cn; dbg.qDyn = q; dbg.pDot = pDot; dbg.qDot = qDot; dbg.rDot = rDot; dbg.fy = fy;

    const wheelY = groundY + spec.gearLength;

    // The ground is a constraint, not a branch to be re-decided every step: while the wheels are on it
    // they hold the aeroplane up and level, and they let go the moment the wing can carry the whole
    // weight. Deciding "am I on the ground" from the height alone makes a rotating aeroplane flicker
    // between the two and never leave, which is a hover, not a takeoff.
    if (plane.onGround) {
      plane.pos[1] = wheelY;
      // Rolling is a scalar along the ground in the direction the aeroplane points, not a projection of
      // a pitched body axis: projecting twice through the nose's own cosine bleeds the run away, and an
      // aeroplane that cannot reach its rotation speed is not an aeroplane but a very slow taxi.
      const hx = Math.sin(plane.yaw), hz = Math.cos(plane.yaw);
      const vRoll = plane.vel[0] * hx + plane.vel[2] * hz;
      // Thrust along the nose, drag and rolling resistance back, and the brakes as a fraction of what is
      // actually pressing the tyres down \u2014 which is the weight minus whatever the wing has lifted off it.
      const onWheels = Math.max(0, m * G - lift);
      const roll = 0.02 * onWheels + br * 0.55 * onWheels;
      const aRoll = (thrust * Math.cos(plane.pitch) - drag - (Math.abs(vRoll) > 0.2 ? roll * Math.sign(vRoll) : 0)) / m;
      let vNext = vRoll + aRoll * dt;
      if (Math.abs(vNext) < 0.3 && th < 0.05) vNext = 0;
      plane.vel[0] = hx * vNext; plane.vel[2] = hz * vNext; plane.vel[1] = 0;
      // The attitude the legs allow: the tail sits down until the elevator has the airspeed to lift it,
      // and the roll is held flat by a spring that is the undercarriage.
      const authority = clamp((q * spec.wingArea * spec.chord * 0.7) / spec.iyy, 0, 1);
      plane.q += (qDot - 40 * plane.q) * dt;
      plane.pitch = clamp(plane.pitch + plane.q * dt, -0.05, 0.2);
      if (plane.pitch <= -0.0495 || plane.pitch >= 0.1995) plane.q *= 0.15;
      plane.roll += (-3.2 * plane.roll - 1.4 * plane.p) * dt;
      plane.p = 0;
      // Steering: the nose wheel bites harder the faster the wheels turn and gives up as the rudder takes
      // over, which is why a takeoff run wanders at first and straightens as the speed builds.
      const nosewheel = clamp(plane.ias / 14, 0, 1) * (1 - clamp(plane.ias / 75, 0, 0.75));
      const yawCmd = (al * 0.35 + ru) * (0.55 * nosewheel + 0.5 * authority);
      plane.r += (yawCmd * 1.4 - 2.6 * plane.r) * dt;
      plane.yaw += plane.r * dt;
      // The wing lifts it off when it can carry the whole weight, which is the stall speed by definition.
      if (lift > m * G * 0.99 && plane.pitch > 0.04) {
        plane.onGround = false;
        plane.vel[1] = 0.25;                       // the first of the climb, and the end of the run
      }
    } else {
      // ---- in the air: the three forces and the three moments, and nothing holding it level ----
      plane.vel[0] += (fx / m) * dt;
      plane.vel[1] += (fy / m) * dt;
      plane.vel[2] += (fz / m) * dt;
      plane.p = clamp(plane.p + pDot * dt, -2.4, 2.4);
      plane.q = clamp(plane.q + qDot * dt, -1.6, 1.6);
      plane.r = clamp(plane.r + rDot * dt, -1.6, 1.6);
      // Body rates to the attitude, with the kinematic cross-coupling a real gimbal set has: at a steep
      // pitch the roll axis yaws the nose, which is what makes a loop come out the far end pointing
      // somewhere else, and what a pilot means by the top of a loop being sloppy.
      const cp = Math.cos(plane.pitch);
      const t = Math.tan(plane.pitch);
      plane.roll += (plane.p + plane.q * Math.sin(plane.roll) * t + plane.r * Math.cos(plane.roll) * t) * dt;
      plane.pitch += (plane.q * Math.cos(plane.roll) - plane.r * Math.sin(plane.roll)) * dt;
      plane.yaw += ((plane.q * Math.sin(plane.roll) + plane.r * Math.cos(plane.roll)) / (Math.abs(cp) < 1e-3 ? 1e-3 : cp)) * dt;
      plane.roll = clamp(plane.roll, -Math.PI * 0.98, Math.PI * 0.98);
      plane.pitch = clamp(plane.pitch, -1.2, 1.2);
      if (plane.yaw > Math.PI) plane.yaw -= Math.PI * 2;
      else if (plane.yaw < -Math.PI) plane.yaw += Math.PI * 2;
    }

    const px = plane.pos[0], py = plane.pos[1], pz = plane.pos[2];
    plane.pos[0] += plane.vel[0] * dt;
    plane.pos[1] += plane.vel[1] * dt;
    plane.pos[2] += plane.vel[2] * dt;
    plane.distance += Math.hypot(plane.pos[0] - px, plane.pos[2] - pz) + Math.abs(plane.pos[1] - py);
    if (!plane.onGround) {
      plane.airborne += dt;
      // The wheels meet something. On a runway that is a landing; anywhere else it is a field, a roof or
      // a hillside, and the legs are not up to it.
      const gHere = groundAt(plane.pos[0], plane.pos[2]) + spec.gearLength;
      if (plane.pos[1] <= gHere && plane.vel[1] <= 0) {
        const sink = -plane.vel[1];
        plane.touchdownSink = sink;
        plane.pos[1] = gHere;
        plane.vel[1] = 0;
        plane.onGround = true;
        if (sink > 5.5 || Math.abs(plane.roll) > 0.35 || plane.pitch < -0.12) plane.crashed = true;
        // Whatever of the speed the wheels can take, they take along the heading it arrived on.
        const hx = Math.sin(plane.yaw), hz = Math.cos(plane.yaw);
        const vRoll = plane.vel[0] * hx + plane.vel[2] * hz;
        plane.vel[0] = hx * vRoll; plane.vel[2] = hz * vRoll;
      }
    }
  }

  // Parked: settled on its legs at the height the ground asks for, so the first frame is not a fall.
  plane.pos[1] = groundAt(plane.pos[0], plane.pos[2]) + spec.gearLength;
  plane.onGround = true;
  return plane;
}
