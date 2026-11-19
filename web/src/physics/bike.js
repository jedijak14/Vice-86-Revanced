// A motorcycle: two wheels, and the turn is a fall you keep catching.
//
// A car turns because its front wheels point somewhere else; a motorcycle turns because the rider
// puts it over and the tyres' contact patches trace a circle under the centre of gravity. The whole of
// that is one equation, and it is the one this file is built on:
//
//      tan(lean) = v^2 / (g * R)        so        turn rate = g * tan(lean) / v
//
// Nothing else here invents a turn. The rider's input asks for a rate, the rate asks for a lean, the
// lean takes a moment to arrive because the machine has to be steered the *other* way first to fall
// towards it (countersteering, and the reason a bicycle at speed steers itself), and the turn that
// happens is the one the achieved lean allows. Stand still and the bar does nothing, because a leaning
// bike with no speed has no circle to trace — which is also why below a walking pace it falls over
// unless somebody puts a foot down, and why the grip limit is a lean angle rather than a number the
// game made up: mu * g of lateral acceleration, and past that the tyres let go and it is a low-side.
//
// The interface is the car's and the boat's on purpose — pos, yaw, vel, speed, forwardSpeed, renderPos,
// renderQuat, step(dt, input), plus the rpm and gear an engine sound and a tachometer read.

import { clamp } from '../core/math.js';
import { basisFromAttitude, quatFromAttitude } from './plane.js';

const scratchQuat = [0, 0, 0, 1];

const G = 9.81;
/** How much of the weight is on the rear wheel at rest, and the tyre's grip on dry tarmac. */
const REAR_SHARE = 0.6, MU = 1.05;
/** kg/m3 and the rolling resistance a pair of tyres has. */
const RHO = 1.225, ROLL = 0.016;
/** Litres per kilowatt-hour a petrol engine drinks, and the kilowatts it burns standing still. */
const BSFC = 0.36, IDLE_KW = 1.2;
/** rpm an engine settles to with nothing on it, and the floor a tachometer never reads under. */
const IDLE_RPM = 900;

/**
 * Three machines a 1986 street has on it: a scooter for the errands, a roadster for the traffic, and a
 * big twin for the highway. `power` is at the rear wheel, `cda` is the drag area with a rider on it,
 * which is most of what a motorcycle is, and `wheelR` the tyre's radius.
 */
export const BIKES = Object.freeze({
  scooter: {
    name: 'Paloma Scooter', kind: 'scooter', mass: 110, rider: 80, power: 9000, cda: 0.72,
    wheelbase: 1.24, wheelR: 0.24, redline: 7200, gears: [21.6, 13.2, 6.6], seat: 0.76,
    maxLean: 0.72, balance: 2.0, tank: 8,
  },
  roadster: {
    name: 'Vice Roadster 600', kind: 'roadster', mass: 205, rider: 80, power: 55000, cda: 0.6,
    wheelbase: 1.42, wheelR: 0.31, redline: 10500, gears: [14.4, 10.4, 8.4, 7.2, 6.2], seat: 0.79,
    maxLean: 0.92, balance: 2.4, tank: 18,
  },
  cruiser: {
    name: 'Starfish Twin', kind: 'cruiser', mass: 285, rider: 85, power: 45000, cda: 0.82,
    wheelbase: 1.62, wheelR: 0.34, redline: 5600, gears: [13.0, 9.4, 7.2, 5.7, 4.5], seat: 0.72,
    maxLean: 0.62, balance: 2.2, tank: 19,
  },
});

/** @param {object|string} kind  a BIKES entry or its name */
export function bikeSpec(kind = 'roadster') {
  const a = typeof kind === 'string' ? BIKES[kind] || BIKES.roadster : kind;
  const mass = a.mass + a.rider;
  // The top speed the power and the drag area agree on, and the lean the grip allows at that speed.
  const vmax = Math.pow((2 * a.power) / (RHO * a.cda), 1 / 3);
  // A machine cannot lean further than its tyres can hold: past atan(mu) there is no circle left to
  // trace, so the lean limit is the grip's, or the machine's own if it is lower (a cruiser's hard parts
  // are on the tarmac long before its tyres are).
  const maxLean = Math.min(a.maxLean, Math.atan(MU * 0.97));
  return Object.freeze({
    ...a, mass, vmax, maxLean,
    /** m/s: the lateral grip limit is mu*g, so the fastest turn at a speed is this lean and no more. */
    gripAccel: MU * G,
    /** m/s below which the machine cannot hold itself up and needs a foot or a move. */
    balance: a.balance,
  });
}

/**
 * @param {object} spec  from `bikeSpec`
 * @param {{x?: number, y?: number, z?: number, yaw?: number, ground?: (x: number, z: number) => number}} [at]
 */
export function createBike(spec, at = {}) {
  const groundAt = at.ground || (() => 1.2);
  // The aeroplane's axis names, because it is the aeroplane's convention: +X is the machine's port side
  // on a map whose +Z is south, a positive lean puts that side down, and a positive yaw turns that way.
  const axes = { forward: [0, 0, 1], lateral: [1, 0, 0], up: [0, 1, 0] };
  // The saddle's own basis and place, so asking where the seat is sixty times a second allocates nothing.
  const seatBasis = { forward: axes.forward, lateral: axes.lateral, up: axes.up };
  const seatAt = [0, 0, 0];
  let fuel = spec.tank;

  const bike = {
    spec,
    pos: [at.x || 0, at.y || 0, at.z || 0],
    /** rad: heading, lean (positive is over to the left, the sign the whole game steers by), and the fork. */
    yaw: at.yaw || 0, lean: 0, steer: 0, pitch: 0,
    vel: [0, 0, 0],
    /** m/s along the heading, which for two wheels is the whole of the velocity worth naming. */
    speed: 0,
    /** rad/s of the turn the lean is actually producing. */
    yawRate: 0, leanRate: 0,
    // Idling rather than stopped: a machine on the kerb has an engine in it, and a tacho that reads zero
    // until the first frame is a tacho that reads a lie for exactly as long as it takes to board one.
    rpm: IDLE_RPM, gear: 1, wheelSpin: 0,
    /** True while the tyres are past their grip, while the machine is on its side with nobody on it,
     *  or while the rider has put a foot down to hold it up. A machine built at rest is standing there
     *  with a foot down already — the first frame agrees with it, but a panel read before that frame
     *  should not say a parked motorcycle is off its feet. */
    sliding: false, fallen: false, footDown: true, wheelie: 0,
    input: { throttle: 0, brake: 0, steer: 0 },
    distance: 0,
    fuelKg: fuel,

    get forwardSpeed() { return bike.speed; },
    get redline() { return spec.redline; },
    get renderPos() { return bike.pos; },
    // The aeroplane's convention, borrowed: a positive lean puts the machine over to the left, the same
    // sign as a positive roll on a wing and a positive steer on a wheel, so that one attitude means one
    // thing across the whole game and a rider and a pilot are not steering in opposite directions.
    get renderQuat() { return quatFromAttitude(bike.yaw, bike.pitch, bike.lean, scratchQuat); },
    /** Where the seat is, for a body that has to sit on it rather than inside a cabin. */
    get seatPos() {
      // The saddle is a point on the machine, so it goes where the machine's own attitude puts it — and
      // `axes` is the heading alone, which is why this asks for the full basis. A seat 0.79 m up leaned
      // over thirty degrees is 0.4 m of saddle to the inside of the corner and 0.1 m lower than an upright
      // one, and a rider put where the upright bike would have had him hangs off the outside of the
      // machine he is actually sitting on: the same give-away as a body that will not lean, only arrived
      // at from the other end, and the reason the lean has to be in the position and not only the pose.
      const b = basisFromAttitude(bike.yaw, bike.pitch, bike.lean, seatBasis);
      const along = -spec.wheelbase * 0.12;               // a saddle sits behind the middle of the wheelbase
      seatAt[0] = bike.pos[0] + b.forward[0] * along + b.up[0] * spec.seat;
      seatAt[1] = bike.pos[1] + b.forward[1] * along + b.up[1] * spec.seat;
      seatAt[2] = bike.pos[2] + b.forward[2] * along + b.up[2] * spec.seat;
      return seatAt;
    },

    place(x, y, z, yaw = 0) {
      bike.pos[0] = x; bike.pos[1] = y; bike.pos[2] = z; bike.yaw = yaw;
      bike.lean = bike.steer = bike.pitch = 0;
      bike.vel[0] = bike.vel[1] = bike.vel[2] = 0;
      bike.speed = bike.yawRate = bike.leanRate = 0;
      bike.sliding = false; bike.fallen = false; bike.footDown = true; bike.wheelie = 0;
      return bike;
    },

    refuel(litres = spec.tank) { fuel = clamp(litres, 0, spec.tank); bike.fuelKg = fuel; return bike; },

    /**
     * One frame of the argument between the rider, the machine and the tarmac.
     * @param {number} dt
     * @param {{throttle?: number, brake?: number, steer?: number}} input  -1..1
     */
    step(dt, input = {}) {
      const th = clamp(input.throttle || 0, -1, 1);
      const br = clamp(input.brake || 0, 0, 1);
      const st = clamp(input.steer || 0, -1, 1);
      bike.input.throttle = th; bike.input.brake = br; bike.input.steer = st;
      if (bike.fallen) {
        // On its side: the machine scrapes to a stop and stays there until it is picked up.
        bike.speed *= Math.pow(0.02, dt);
        bike.lean = clamp(bike.lean + Math.sign(bike.lean || 1) * 1.6 * dt, -1.35, 1.35);
        integrate(dt);
        return bike;
      }

      // ---- the gearbox and the drive: a torque curve, five ratios, and the tyre's say in it ----
      const nGears = spec.gears.length;
      const ratio = spec.gears[Math.min(nGears - 1, Math.max(0, bike.gear - 1))];
      const wheelRpm = (bike.speed / spec.wheelR) * 60 / (2 * Math.PI);
      bike.rpm = Math.max(IDLE_RPM, wheelRpm * ratio);
      // Up and down on the road speed, which is what a rider does without looking at the tachometer.
      if (bike.rpm > spec.redline * 0.94 && bike.gear < nGears) bike.gear++;
      else if (bike.rpm < spec.redline * 0.42 && bike.gear > 1) bike.gear--;
      // Torque falls away at the top of the curve; the power ceiling is what the engine can actually put
      // through at this speed, and the tyre decides how much of it reaches the road.
      const torqueShape = 1 - Math.pow(clamp(bike.rpm / spec.redline, 0, 1.2) - 0.62, 2) * 0.85;
      const hasFuel = fuel > 0;
      const driveForce = hasFuel ? Math.max(0, th) * spec.power / Math.max(6, bike.speed) * torqueShape : 0;
      const traction = MU * G * spec.mass * REAR_SHARE * (br > 0.4 ? 0.7 : 1);
      const atTyre = Math.min(driveForce * 1.35, traction);
      // Litres a second: the engine's brake-specific consumption times the power it is actually making,
      // which is the work at the tyre and not the work the throttle could ask for. A machine cruising on
      // a quarter throttle drinks what a quarter of the work costs rather than a quarter of the engine,
      // and one idling at the lights drinks almost nothing — which is why a tank lasts the hours it does.
      const kW = Math.max(0, atTyre * Math.abs(bike.speed)) / 1000;
      fuel = Math.max(0, fuel - hasFuel * BSFC * (kW + (th > 0.02 ? IDLE_KW : 0.35)) / 3600 * dt);
      bike.fuelKg = fuel;
      // A wheelie is what happens when the drive outpaces the weight on the front wheel at low speed.
      const wheelieAsk = clamp((atTyre - traction * 0.72) / (traction * 0.5), 0, 1) * clamp(1 - bike.speed / 18, 0, 1);
      bike.wheelie += (wheelieAsk * 0.3 - bike.wheelie) * Math.min(1, dt * 4);

      // ---- the drag, the rolling, and the brakes ----
      const drag = 0.5 * RHO * spec.cda * bike.speed * bike.speed;
      const roll = ROLL * spec.mass * G * Math.sign(bike.speed);
      const brakeForce = br * MU * G * spec.mass * (bike.sliding ? 0.45 : 0.85);
      let a = (atTyre + Math.min(0, th) * 900 - drag - roll - brakeForce * Math.sign(bike.speed)) / spec.mass;
      if (Math.abs(bike.speed) < 0.08 && Math.abs(a) < 0.6) { a = 0; bike.speed = 0; }
      bike.speed = clamp(bike.speed + a * dt, -12, spec.vmax * 1.05);

      // ---- the turn: a rate asked for, a lean to make it happen, and the grip that allows it ----
      // The most a machine can turn at this speed is what its tyres can hold: omega = mu*g / v. A bar
      // input asks for a share of that, so the same movement of the hand is a tight circle at twenty and
      // a motorway lane change at a hundred and twenty. Below a walking pace there is no circle at all,
      // and the lean belongs to the balance below rather than to the cornering here.
      const v = Math.max(0.4, Math.abs(bike.speed));
      const maxRate = Math.min(1.3, spec.gripAccel / v);
      const rolling = Math.abs(bike.speed) >= spec.balance;
      const asked = st * maxRate * (Math.abs(bike.speed) > 1 ? 1 : 0);
      // The lean that rate needs, and how long the machine takes to get there: it has to be steered the
      // other way first, which is why the response is a second-order thing and not a switch.
      const leanWant = rolling ? Math.atan((v * v * asked) / G) : 0;
      const sign = Math.sign(bike.speed) || 1;
      const leanResponse = rolling ? 2.2 + 5.5 * clamp(v / 18, 0, 1) : 0;
      if (rolling) {
        bike.leanRate += ((leanWant - bike.lean) * leanResponse - 2.6 * bike.leanRate) * dt;
        bike.lean = clamp(bike.lean + bike.leanRate * dt * sign, -spec.maxLean, spec.maxLean);
      } else bike.leanRate *= Math.pow(0.05, dt);
      // The fork follows the lean rather than the hand: a leaning bike steers itself into the fall, which
      // is the self-stability that makes two wheels possible at all.
      bike.steer += ((bike.lean * 0.55 + st * 0.16) - bike.steer) * Math.min(1, dt * 9);
      // The turn the achieved lean actually buys, and the grip that says no past its own limit.
      const rateFromLean = rolling ? clamp((G * Math.tan(bike.lean)) / v * sign, -maxRate, maxRate) : 0;
      bike.yawRate += (rateFromLean - bike.yawRate) * Math.min(1, dt * 8);
      const lateral = Math.abs(bike.yawRate * bike.speed);
      bike.sliding = lateral > spec.gripAccel * 0.98 || (br > 0.6 && Math.abs(bike.lean) > 0.3 && v > 9);
      if (bike.sliding) {
        // The tyres let go: the turn tightens no further and the machine stands up out of the bend,
        // which is what a rider feels as the bars going light.
        const limit = spec.gripAccel / v;
        bike.yawRate = clamp(bike.yawRate, -limit, limit) * 0.94;
        bike.lean *= Math.pow(0.35, dt);
        bike.speed -= Math.min(bike.speed, 2.4 * dt);
      }
      bike.yaw += bike.yawRate * dt;
      if (bike.yaw > Math.PI) bike.yaw -= Math.PI * 2;
      else if (bike.yaw < -Math.PI) bike.yaw += Math.PI * 2;

      // ---- balance: below a walking pace a leaning machine falls, and only a foot stops it ----
      // Below a walking pace there is no circle to trace, so the machine is held up by a rider and a
      // foot rather than by the tyres: it stands still upright, it can be leaned a little while it is
      // walked, and only past the angle nobody can catch does it go down on its side.
      const slow = Math.abs(bike.speed) < spec.balance;
      if (slow) {
        if (Math.abs(bike.lean) > 0.45) {
          const fall = (0.9 + Math.abs(bike.lean) / spec.maxLean) * Math.sign(bike.lean);
          bike.lean = clamp(bike.lean + fall * dt, -1.35, 1.35);
          bike.speed *= Math.pow(0.2, dt);
          if (Math.abs(bike.lean) > 1.12) { bike.fallen = true; bike.footDown = false; }
        } else {
          bike.lean += (0 - bike.lean) * Math.min(1, dt * 1.6);
        }
        bike.footDown = Math.abs(bike.lean) < 0.22 && Math.abs(th) < 0.05;
      } else bike.footDown = false;
      // The pitch the machine sits at: a wheelie under drive, a dive under the front brake, and the
      // slope of whatever is under it.
      const slope = slopeAt(groundAt, bike.pos[0], bike.pos[2], bike.yaw);
      const dive = -br * 0.09 * clamp(bike.speed / 12, 0, 1);
      bike.pitch += ((bike.wheelie * 0.42 + dive + slope * Math.cos(bike.lean)) - bike.pitch) * Math.min(1, dt * 6);
      bike.wheelSpin += (bike.speed / spec.wheelR) * dt;

      integrate(dt);
      return bike;
    },

    /** Pick it up: what a rider does to a machine that is lying on the kerb. */
    right() {
      bike.fallen = false; bike.lean = 0; bike.leanRate = 0; bike.speed = 0;
      return bike;
    },
  };

  /** Move it, and keep it on the ground it is standing on. */
  function integrate(dt) {
    const f = axes.forward;
    f[0] = Math.sin(bike.yaw); f[1] = 0; f[2] = Math.cos(bike.yaw);
    axes.lateral[0] = Math.cos(bike.yaw); axes.lateral[2] = -Math.sin(bike.yaw);
    const px = bike.pos[0], pz = bike.pos[2];
    bike.vel[0] = f[0] * bike.speed; bike.vel[1] = 0; bike.vel[2] = f[2] * bike.speed;
    bike.pos[0] += bike.vel[0] * dt;
    bike.pos[2] += bike.vel[2] * dt;
    bike.pos[1] = groundAt(bike.pos[0], bike.pos[2]);
    bike.distance += Math.hypot(bike.pos[0] - px, bike.pos[2] - pz);
  }

  bike.pos[1] = groundAt(bike.pos[0], bike.pos[2]);
  return bike;
}

/** The slope along a heading, from the ground either side of it: a hill a bike sits square to. */
function slopeAt(ground, x, z, yaw) {
  const d = 0.9;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  return Math.atan2(ground(x + fx * d, z + fz * d) - ground(x - fx * d, z - fz * d), 2 * d);
}
