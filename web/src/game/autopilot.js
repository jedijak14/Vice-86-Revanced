// A simple driver for the player's car, for unattended runs (`drive=auto`, performance
// captures) and for tests: it follows the lane graph at the speed limit, slows for bends,
// stops at red signals and behind whatever a ray ahead of the bonnet finds.
//
// Steering is pure pursuit: aim at a point on the route a speed-dependent distance ahead and
// steer along the arc that passes through it.

import { clamp, angleDelta, hash01 } from '../core/math.js';
import { samplePoint, comfortSpeed, segmentAt } from './lanes.js';
import { SIGNAL, signalState } from './signals.js';

const LOOK_AHEAD_MIN = 6, LOOK_AHEAD_SECONDS = 0.9; // m, s
const SPEED_SHARE = 0.95; // of the limit
const LATERAL_LIMIT = 6.5; // m/s^2 the autopilot will corner at
const BRAKING = 5; // m/s^2 it plans stops with
const LINE_MARGIN = 3.5; // m from the car's origin to the stop line when waiting
const AMBER_GO_SECONDS = 2;
const GAP_SECONDS = 1.3, GAP_STANDING = 5; // following distance
const LOST_DISTANCE = 12; // m from the route before the autopilot looks for a new one
const REACH = 60; // m within which it looks for a lane
const STUCK_SECONDS = 6;
const TURN_WEIGHT = [1, 0.25, 0.3, 0]; // straight on mostly, never a u-turn

const target = [0, 0, 0];
const origin = [0, 0, 0];
const direction = [0, 0, 0];

/**
 * @param {{graph: import('./lanes.js').LaneGraph, physics: object, seed?: number}} deps
 */
export function createAutopilot({ graph, physics, seed = 1 }) {
  let lane = null, next = null;
  let s = 0;
  let hint = 0;
  let choices = 0;
  let stuckTime = 0;
  const acceptRoad = (l) => !l.junction && l.next.length > 0;

  function choose(from) {
    if (from.next.length === 0) return null;
    let total = 0;
    for (const l of from.next) total += l.junction ? TURN_WEIGHT[l.turn] || 0.01 : 1;
    let r = hash01(seed, from.id, choices++) * total;
    for (const l of from.next) {
      r -= l.junction ? TURN_WEIGHT[l.turn] || 0.01 : 1;
      if (r <= 0) return l;
    }
    return from.next[from.next.length - 1];
  }

  /** Station on `lane` of the point closest to (x, z), searching near the previous one. */
  function project(x, z) {
    const p = lane.pts, cum = lane.cum;
    let best = Infinity, bestS = s;
    const from = Math.max(0, hint - 1), to = Math.min(lane.count - 2, hint + 3);
    for (let i = from; i <= to; i++) {
      const ax = p[i * 3], az = p[i * 3 + 2], dx = p[i * 3 + 3] - ax, dz = p[i * 3 + 5] - az, len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / len2, 0, 1) : 0;
      const ex = x - ax - dx * t, ez = z - az - dz * t, d2 = ex * ex + ez * ez;
      if (d2 < best) { best = d2; bestS = cum[i] + (cum[i + 1] - cum[i]) * t; hint = i; }
    }
    s = bestS;
    return Math.sqrt(best);
  }

  /** Point on the route `ahead` metres beyond the current station. */
  function routePoint(ahead, out) {
    let l = lane, at = s + ahead, following = next;
    while (at > l.length && following) {
      at -= l.length;
      l = following;
      // Beyond the lane after next the route is not decided yet: carry straight on.
      following = l.next.length === 1 ? l.next[0] : null;
    }
    samplePoint(l, at, out, l === lane ? hint : 0);
  }

  const autopilot = {
    /** True once the car has made no progress for a while; the game then puts it back on the road. */
    stuck: false,

    /** Forgets the route; the next update finds the lane under the car. */
    reset() {
      lane = null; next = null; stuckTime = 0; autopilot.stuck = false;
    },

    /**
     * @param {number} dt
     * @param {object} vehicle  the physics vehicle
     * @param {number} time     traffic simulation time, for the signal phases
     * @param {{throttle: number, brake: number, steer: number, handbrake: number}} out
     */
    update(dt, vehicle, time, out) {
      const x = vehicle.pos[0], z = vehicle.pos[2], v = Math.max(0, vehicle.speed);
      out.handbrake = 0;
      // Pushed, spun or teleported away from the route: look for the lane nearest the car again.
      const lost = lane !== null && project(x, z) > LOST_DISTANCE;
      if (!lane || lost) {
        const hit = graph.nearest(x, z, REACH, acceptRoad);
        if (!hit) { lane = null; out.throttle = 0; out.brake = 1; out.steer = 0; return out; }
        // The lane is taken however far away it is; the steering below then heads for it.
        if (hit.lane !== lane) { lane = hit.lane; next = choose(lane); }
        s = hit.s; hint = segmentAt(lane, s);
      } else if (s >= lane.length - 0.05 && next) {
        lane = next; s = 0; hint = 0;
        next = choose(lane);
        project(x, z);
      }

      // Steering.
      const reach = LOOK_AHEAD_MIN + v * LOOK_AHEAD_SECONDS;
      routePoint(reach, target);
      const dx = target[0] - x, dz = target[2] - z;
      const distance = Math.hypot(dx, dz) || 1;
      const alpha = angleDelta(vehicle.yaw, Math.atan2(dx, dz));
      const wheelbase = vehicle.model.dims.wheelbase || 2.5;
      const wanted = Math.atan(2 * wheelbase * Math.sin(alpha) / distance);
      // The car scales its lock with speed; ask for the share of the lock it has at this speed.
      const steerSpec = vehicle.spec.steer;
      const lock = Math.min(steerSpec.maxAngle, Math.atan(wheelbase * steerSpec.lateralRef / Math.max(v * v, 1)) + 0.05);
      out.steer = clamp(wanted / lock, -1, 1);

      // Speed: the limit, the bends ahead, the stop line, the vehicle in front.
      let limit = Math.min(lane.speedLimit * SPEED_SHARE, comfortSpeed(lane, s, hint) * 1.25);
      const curvature = Math.abs(2 * Math.sin(alpha) / distance);
      if (curvature > 1e-4) limit = Math.min(limit, Math.sqrt(LATERAL_LIMIT / curvature));
      const toEnd = lane.length - s;
      if (next) limit = Math.min(limit, Math.sqrt(next.speedProfile[0] * next.speedProfile[0] * 1.5 + 2 * BRAKING * toEnd));
      const control = lane.control;
      if (control && control.kind === 'signal' && control.junctionRef) {
        const state = signalState(control.junctionRef, control.group, time);
        const stopDistance = toEnd - LINE_MARGIN;
        const mustStop = state === SIGNAL.RED || (state === SIGNAL.AMBER && toEnd > v * AMBER_GO_SECONDS);
        if (mustStop && stopDistance > -1.5) limit = Math.min(limit, Math.sqrt(2 * BRAKING * Math.max(0, stopDistance)));
      }
      origin[0] = x; origin[1] = vehicle.pos[1] + 0.55; origin[2] = z;
      direction[0] = Math.sin(vehicle.yaw + alpha * 0.5); direction[1] = 0; direction[2] = Math.cos(vehicle.yaw + alpha * 0.5);
      const range = GAP_STANDING + v * GAP_SECONDS + v * v / (2 * BRAKING) + 6;
      const hit = physics.raycast(origin, direction, range, vehicle);
      if (hit.hit && hit.body) {
        const gap = hit.dist - vehicle.model.dims.length * 0.5 - GAP_STANDING * 0.5;
        const ahead = hit.body.vel ? Math.max(0, hit.body.vel[0] * direction[0] + hit.body.vel[2] * direction[2]) : 0;
        limit = Math.min(limit, Math.sqrt(Math.max(0, ahead * ahead + 2 * BRAKING * gap)));
      }

      const error = limit - v;
      out.throttle = clamp(error * 0.45, 0, 1);
      out.brake = clamp(-error * 0.5 - 0.05, 0, 1);
      if (limit < 0.3) { out.throttle = 0; out.brake = Math.max(out.brake, 0.6); }

      // Not moving although it wants to: wedged against something.
      stuckTime = out.throttle > 0.3 && v < 0.4 ? stuckTime + dt : 0;
      autopilot.stuck = stuckTime > STUCK_SECONDS;
      if (autopilot.stuck) stuckTime = 0;
      return out;
    },
  };
  return autopilot;
}

