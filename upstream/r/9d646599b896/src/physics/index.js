// Physics module: Rapier (WASM) rigid-body world plus a raycast vehicle model.
// No DOM and no WebGL in here: the same files run in Node (tests) and in the browser.
//
// CONVENTIONS, used everywhere in this module
//   Units: metres, seconds, kilograms, radians.
//   World: right-handed, +Y up, +X east, +Z south.
//   Vehicle frame: right-handed, +Y up, +Z forward, which makes +X the car's LEFT.
//   Yaw: rotation about +Y. Yaw 0 faces +Z (south). Positive yaw turns toward +X,
//        which is a left turn for the driver (counter-clockwise seen from above).
//   Steering input: positive = left, same sign as yaw.
//   Vehicle origin (`pos`): the point on the ground under the middle of the car (midway
//        between the axles, on the centre line) when it rests at nominal ride height.
//   Quaternions are [x, y, z, w]. Wheel order is FL, FR, RL, RR.
//
// See design/physics-notes.md for the design, the tuning values and the test results.

import RAPIER from '../../vendor/rapier/rapier.mjs';
import { v3lerp, quatSlerp, angleDelta } from '../core/math.js';
import { Vehicle } from './vehicle.js';
import { HERO_SPEC, carSpec, describeSpec, CAR_IDS, trafficSpec, surfaceOfField, KIND, SURFACES } from './specs.js';

export { HERO_SPEC, carSpec, describeSpec, CAR_IDS, trafficSpec, surfaceOfField, KIND, SURFACES };

/** Fixed simulation step. `phys.step(dt)` runs as many of these as fit into dt. */
export const FIXED_DT = 1 / 120;
/** Upper bound of substeps per `phys.step` call. Extra time is dropped, not queued. */
const MAX_SUBSTEPS = 10;
/** Slowest closing speed (m/s) that is reported as an impact. */
const MIN_IMPACT_SPEED = 1.0;
/** Edge length of a world tile, metres (design/ARCHITECTURE.md 9.2). */
const TILE_SIZE = 128;

// Collision group bits. A Rapier group word is (memberships << 16) | filter.
const G_GROUND = 0x0001; // drivable static surfaces: terrain and collider meshes
const G_OBSTACLE = 0x0002; // buildings, walls, poles
const G_VEHICLE = 0x0004; // simulated vehicles
const G_TRAFFIC = 0x0008; // traffic boxes
const G_FALLBACK = 0x0010; // the fallback ground plane
const G_ALL = 0xffff;
const groupWord = (member, filter) => ((member << 16) | filter) >>> 0;

// Traffic box behaviour.
const ARM_HORIZON = 0.2; // s: a box becomes pushable this long before something can reach it
const ARM_MARGIN = 0.6; // m added to that reach
const DISARM_DELAY = 0.3; // s without anything near before an untouched box is kinematic again
const PUSH_DV = 0.3; // m/s off the commanded velocity that counts as having been hit
const PUSH_DW = 0.25; // rad/s, same for the yaw rate
const SLIDE_LAT = 7.5; // m/s^2: how fast a pushed box loses sideways speed (tyres scrubbing)
const SLIDE_LONG = 4.0; // m/s^2: and speed along its length (driver on the brakes)
const SLIDE_YAW = 5.0; // rad/s^2
const TELEPORT_SPEED = 90; // m/s: a setPose that asks for more than this is treated as a teleport

let rapierReady = null;

const approach = (x, target, step) => (x < target ? Math.min(x + step, target) : Math.max(x - step, target));

/**
 * A traffic car or other moving obstacle, as one box.
 *
 * Normally it is a velocity-driven kinematic body: the game calls `setPose` once per frame
 * and the box moves there at the matching velocity during the next `phys.step`, so it costs
 * almost nothing and the driver AI keeps full authority over where it is.
 *
 * Shortly before a simulated vehicle (or an already pushed box) can reach it, a pushable box
 * turns into a dynamic body that still follows `setPose`. If it is then really hit, it takes
 * the blow with its own mass (`pushed` becomes true), stops listening to `setPose` and slides
 * to rest like a car on locked wheels. It only moves in the ground plane and only turns about
 * the vertical axis, so it cannot tumble or be launched. If nothing touches it, it goes back
 * to kinematic. The AI reads `pushed` and decides what happens next: `resume()` or removal.
 */
class TrafficBox {
  constructor(phys, spec) {
    // Shape: the model's collider box if a model is given, else `size` = [width, height, length].
    const collider = spec.collider || (spec.model && spec.model.collider);
    const size = spec.size || [2, 1.5, 4.5];
    const he = collider ? collider.halfExtents : [size[0] / 2, size[1] / 2, size[2] / 2];
    const centre = collider ? collider.centre : [0, size[1] / 2, 0];
    // The box floats a little above the road so that it never scrapes kerbs or ramps.
    const lift = spec.lift !== undefined ? spec.lift : 0.15;
    const top = centre[1] + he[1];
    const bottom = Math.max(centre[1] - he[1], lift);
    this._phys = phys;
    this.kind = spec.kind !== undefined ? spec.kind : KIND.TRAFFIC;
    this.userData = spec.userData !== undefined ? spec.userData : null;
    this.size = [he[0] * 2, top, he[2] * 2];
    this.mass = spec.mass !== undefined ? spec.mass : 1500;
    this.pushable = spec.pushable !== false;
    /** True once the box has been hit and is sliding or resting on its own. */
    this.pushed = false;
    this.pos = [0, 0, 0];
    this.prevPos = [0, 0, 0];
    this.quat = [0, 0, 0, 1];
    this.prevQuat = [0, 0, 0, 1];
    this.renderPos = [0, 0, 0];
    this.renderQuat = [0, 0, 0, 1];
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.yawRate = 0;
    /** Radius of the circle around the origin that contains the box footprint. */
    this.boundRadius = Math.hypot(he[0], he[2] + Math.abs(centre[2]));
    this._target = [0, 0, 0, 0];
    this._hasTarget = false;
    this._moving = false;
    this._armed = false; // dynamic, but still following setPose
    this._clearTime = 0;
    this._cmd = [0, 0, 0, 0]; // commanded velocity x, y, z and yaw rate
    this._v = { x: 0, y: 0, z: 0 };
    this._q = { x: 0, y: 0, z: 0, w: 1 };
    this.body = phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicVelocityBased());
    this.body.userData = this;
    const hy = (top - bottom) / 2;
    const cd = RAPIER.ColliderDesc.cuboid(he[0], hy, he[2])
      .setTranslation(centre[0], bottom + hy, centre[2])
      .setDensity(0)
      .setFriction(0.3)
      .setRestitution(0.05)
      .setCollisionGroups(phys._groups.traffic);
    this._collider = phys.world.createCollider(cd, this.body);
    // Mass of a solid box. Only matters while the body is dynamic.
    const w = he[0] * 2, l = he[2] * 2, h = hy * 2, m = this.mass;
    this.body.setAdditionalMassProperties(
      m, { x: centre[0], y: bottom + hy, z: centre[2] },
      { x: (m / 12) * (h * h + l * l), y: (m / 12) * (w * w + l * l), z: (m / 12) * (w * w + h * h) },
      { x: 0, y: 0, z: 0, w: 1 }, false,
    );
    phys._ownerByCollider.set(this._collider.handle, this);
    this.teleport(spec.pos || [0, 0, 0], spec.yaw || 0);
  }

  /**
   * Where the box should be at the end of the next `phys.step`. Ignored while `pushed`.
   * `pos` is the point on the ground under the middle of the vehicle.
   * @param {number[]} pos
   * @param {number} yaw
   */
  setPose(pos, yaw) {
    const t = this._target;
    t[0] = pos[0]; t[1] = pos[1]; t[2] = pos[2]; t[3] = yaw;
    this._hasTarget = true;
  }

  /** Moves the box instantly (spawning, large corrections) and makes it kinematic. */
  teleport(pos, yaw) {
    this._setDynamic(false);
    this.pushed = false;
    const v = this._v, q = this._q;
    v.x = pos[0]; v.y = pos[1]; v.z = pos[2];
    q.x = 0; q.y = Math.sin(yaw / 2); q.z = 0; q.w = Math.cos(yaw / 2);
    this.body.setTranslation(v, true);
    this.body.setRotation(q, true);
    v.x = 0; v.y = 0; v.z = 0;
    this.body.setLinvel(v, true);
    this.body.setAngvel(v, true);
    for (let i = 0; i < 3; i++) {
      this.pos[i] = pos[i];
      this.prevPos[i] = pos[i];
      this.renderPos[i] = pos[i];
      this.vel[i] = 0;
    }
    for (const out of [this.quat, this.prevQuat, this.renderQuat]) {
      out[0] = 0; out[1] = q.y; out[2] = 0; out[3] = q.w;
    }
    this.yaw = yaw;
    this.yawRate = 0;
    this._cmd.fill(0);
    this._hasTarget = false;
    this._moving = false;
  }

  /** Hands a pushed box back to `setPose` control, from where it now stands. */
  resume() {
    this.pushed = false;
    this._setDynamic(false);
    this._cmd.fill(0);
    this._hasTarget = false;
    this._moving = true; // the next _aim writes a clean zero velocity
  }

  /** Lets the box go as if it had been hit (a crash decided by the game). */
  release() {
    if (!this.pushable || this.pushed) return;
    this._setDynamic(true);
    this._setPushed();
  }

  _setDynamic(on) {
    if (on === this._armed) return;
    this._armed = on;
    const body = this.body;
    body.setBodyType(on ? RAPIER.RigidBodyType.Dynamic : RAPIER.RigidBodyType.KinematicVelocityBased, true);
    if (on) {
      // Planar motion only: slides and turns on the road, never tips, never leaves it.
      body.setEnabledTranslations(true, false, true, true);
      body.setEnabledRotations(false, true, false, true);
      this._clearTime = 0;
    }
    this._collider.setCollisionGroups(this._phys._groups.traffic);
  }

  _setPushed() {
    this.pushed = true;
    // From now on walls and poles stop it too.
    this._collider.setCollisionGroups(this._phys._groups.trafficPushed);
    const list = this._phys._pushed;
    if (list.indexOf(this) < 0) list.push(this);
  }

  /** True if `other` (a vehicle or pushed box) could touch this box within the arming horizon. */
  _withinReach(other, slack) {
    const dx = other.pos[0] - this.pos[0], dz = other.pos[2] - this.pos[2];
    if (Math.abs(other.pos[1] - this.pos[1]) > 4) return false;
    const rvx = other.vel[0] - this.vel[0], rvz = other.vel[2] - this.vel[2];
    const reach = this.boundRadius + other.boundRadius + ARM_MARGIN + Math.sqrt(rvx * rvx + rvz * rvz) * ARM_HORIZON + slack;
    return dx * dx + dz * dz < reach * reach;
  }

  /** Once per frame, before the substeps: arming, and the velocity toward the target pose. */
  _aim(n) {
    if (this.pushed) return;
    const phys = this._phys;
    const dt = n * FIXED_DT;
    if (this.pushable) {
      let near = false;
      const slack = this._armed ? 1 : 0; // a little hysteresis
      const vehicles = phys.vehicles, pushed = phys._pushed;
      for (let i = 0; i < vehicles.length && !near; i++) near = this._withinReach(vehicles[i], slack);
      for (let i = 0; i < pushed.length && !near; i++) near = this._withinReach(pushed[i], slack);
      if (near) {
        this._clearTime = 0;
        this._setDynamic(true);
      } else if (this._armed) {
        this._clearTime += dt;
        if (this._clearTime > DISARM_DELAY) this._setDynamic(false);
      }
    }
    const v = this._v, cmd = this._cmd;
    if (!this._hasTarget) {
      // No new pose this frame: stand still.
      if (this._moving || this._armed) {
        cmd.fill(0);
        v.x = 0; v.y = 0; v.z = 0;
        phys._setLinvel(this.body, v, true);
        phys._setAngvel(this.body, v, true);
        this._moving = false;
      }
      return;
    }
    this._hasTarget = false;
    const t = this._target;
    const dx = t[0] - this.pos[0], dy = t[1] - this.pos[1], dz = t[2] - this.pos[2];
    const inv = 1 / dt;
    if ((dx * dx + dy * dy + dz * dz) * inv * inv > TELEPORT_SPEED * TELEPORT_SPEED) {
      // Faster than any car: this is a respawn, not motion.
      this.teleport(t, t[3]);
      return;
    }
    cmd[0] = dx * inv; cmd[1] = dy * inv; cmd[2] = dz * inv;
    cmd[3] = angleDelta(this.yaw, t[3]) * inv;
    if (this._armed && dy !== 0) {
      // A dynamic box has its height locked: follow the target height directly.
      const p = this.body.translation(v);
      p.y = t[1];
      this.body.setTranslation(p, true);
      cmd[1] = 0;
    }
    v.x = cmd[0]; v.y = cmd[1]; v.z = cmd[2];
    phys._setLinvel(this.body, v, true);
    v.x = 0; v.y = cmd[3]; v.z = 0;
    phys._setAngvel(this.body, v, true);
    this._moving = true;
  }

  /** Every substep while pushed: tyre-like friction and following the ground height. */
  _slide(h) {
    const body = this.body;
    const phys = this._phys;
    if (body.isSleeping()) return;
    const v = body.linvel(this._v);
    const q = body.rotation(this._q);
    const yaw = 2 * Math.atan2(q.y, q.w);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    // Split the velocity along and across the car, brake each part at its own rate.
    const vLong = approach(v.x * fx + v.z * fz, 0, SLIDE_LONG * h);
    const vLat = approach(v.x * fz - v.z * fx, 0, SLIDE_LAT * h);
    v.x = fx * vLong + fz * vLat;
    v.y = 0;
    v.z = fz * vLong - fx * vLat;
    phys._setLinvel(body, v, false);
    const w = body.angvel(this._v);
    w.x = 0; w.z = 0;
    w.y = approach(w.y, 0, SLIDE_YAW * h) * (1 - 1.5 * h);
    phys._setAngvel(body, w, false);
    // Follow the ground under the box (ramps, the drop into water) at a limited speed.
    const p = body.translation(this._v);
    if (phys._castGround(p.x, p.y + 1, p.z, 0, -1, 0, 12, phys._groups.wheelRay)) {
      const y = approach(p.y, p.y + 1 - phys._groundHit.dist, 6 * h);
      if (y !== p.y) {
        p.y = y;
        body.setTranslation(p, false);
      }
    }
  }

  /** Once per frame, after the substeps: read the pose back and notice a hit. */
  _sync() {
    if (!this._moving && !this._armed) {
      this.prevPos[0] = this.pos[0]; this.prevPos[1] = this.pos[1]; this.prevPos[2] = this.pos[2];
      this.prevQuat[1] = this.quat[1]; this.prevQuat[3] = this.quat[3];
      return;
    }
    const body = this.body;
    const t = body.translation(this._v);
    this.pos[0] = t.x; this.pos[1] = t.y; this.pos[2] = t.z;
    const q = body.rotation(this._q);
    this.yaw = 2 * Math.atan2(q.y, q.w);
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
    else if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
    this.quat[1] = q.y; this.quat[3] = q.w;
    const v = body.linvel(this._v);
    this.vel[0] = v.x; this.vel[1] = v.y; this.vel[2] = v.z;
    this.yawRate = body.angvel(this._v).y;
    if (this._armed && !this.pushed) {
      const cmd = this._cmd;
      const dvx = this.vel[0] - cmd[0], dvz = this.vel[2] - cmd[2];
      if (dvx * dvx + dvz * dvz > PUSH_DV * PUSH_DV || Math.abs(this.yawRate - cmd[3]) > PUSH_DW) this._setPushed();
    }
    // The velocity is steady over a substep, so the previous substep pose is one step back.
    // (From `pos`, not from `t`: the velocity reads above reuse the same scratch vector.)
    this.prevPos[0] = this.pos[0] - this.vel[0] * FIXED_DT;
    this.prevPos[1] = this.pos[1] - this.vel[1] * FIXED_DT;
    this.prevPos[2] = this.pos[2] - this.vel[2] * FIXED_DT;
    const prevYaw = this.yaw - this.yawRate * FIXED_DT;
    this.prevQuat[1] = Math.sin(prevYaw / 2); this.prevQuat[3] = Math.cos(prevYaw / 2);
  }
}

class Physics {
  constructor(opts) {
    this.RAPIER = RAPIER;
    this.gravity = opts.gravity !== undefined ? opts.gravity : -9.81;
    this.world = new RAPIER.World({ x: 0, y: this.gravity, z: 0 });
    this.world.timestep = FIXED_DT;
    /** Interpolation factor 0..1 between prevPos/prevQuat and pos/quat, valid after step(). */
    this.alpha = 0;
    /** Simulated time in seconds. */
    this.time = 0;
    this.fixedDt = FIXED_DT;
    /** Height of the sea surface. A vehicle well below it reports `inWater`. */
    this.seaLevel = opts.seaLevel !== undefined ? opts.seaLevel : 0;
    this.vehicles = [];
    this.boxes = [];

    this._acc = 0;
    this._grip = 1;
    this._groundY = 0;
    this._killY = opts.killY !== undefined ? opts.killY : -20;
    this._groundCollider = null;
    this._surfaceSampler = null;
    this._tiles = new Map(); // key -> { colliders, cell }
    this._tileCells = new Set(); // numeric cell keys of the loaded tiles
    this._terrain = new Set(); // collider handles of terrain: heightfields and the fallback plane
    this._kindByCollider = new Map(); // static collider handle -> kind
    this._ownerByCollider = new Map(); // dynamic/kinematic collider handle -> Vehicle | TrafficBox
    this._pushed = []; // traffic boxes that slide on their own
    this._groups = {
      vehicle: groupWord(G_VEHICLE, G_ALL),
      vehicleNoFallback: groupWord(G_VEHICLE, G_ALL & ~G_FALLBACK),
      wheelRay: groupWord(G_ALL, G_GROUND | G_FALLBACK),
      wheelRayNoFallback: groupWord(G_ALL, G_GROUND),
      traffic: groupWord(G_TRAFFIC, G_VEHICLE | G_TRAFFIC),
      trafficPushed: groupWord(G_TRAFFIC, G_VEHICLE | G_TRAFFIC | G_OBSTACLE),
      query: groupWord(G_ALL, G_ALL & ~G_FALLBACK),
    };
    this._impactCallbacks = [];
    this._events = new RAPIER.EventQueue(true);

    // Rapier's JS wrapper creates a temporary WASM vector (plus a finalizer entry) for every
    // vector argument: setLinvel, addForce, a ray origin. That is garbage on every substep,
    // so the hot paths below call the raw bindings with these three reused vectors instead.
    this._rawA = RAPIER.VectorOps.intoRaw({ x: 0, y: 0, z: 0 });
    this._rawOrigin = RAPIER.VectorOps.intoRaw({ x: 0, y: 0, z: 0 });
    this._rawDir = RAPIER.VectorOps.intoRaw({ x: 0, y: -1, z: 0 });
    this._rayDist = 0;
    this._groundHit = { dist: 0, nx: 0, ny: 1, nz: 0, kind: 0, terrain: false };
    this._rayResult = { hit: false, dist: 0, normal: [0, 1, 0], kind: -1, body: null };
    this._impactEvent = { speed: 0, pos: [0, 0, 0], normal: [0, 1, 0], otherKind: -1, vehicle: null, other: null };
    this._tmpA = { x: 0, y: 0, z: 0 };
    this._tmpB = { x: 0, y: 0, z: 0 };
    this._contactPoint = { x: 0, y: 0, z: 0 };
    this._contactFound = false;
    this._onForceEvent = (ev) => this._handleForceEvent(ev);
    this._onManifold = (manifold) => {
      if (!this._contactFound && manifold.numSolverContacts() > 0) {
        manifold.solverContactPoint(0, this._contactPoint);
        this._contactFound = true;
      }
    };
  }

  // ---------------------------------------------------------------------------------
  // Stepping
  // ---------------------------------------------------------------------------------

  /**
   * Advances the simulation by `dt` seconds of real time using fixed 120 Hz substeps.
   * Afterwards every vehicle and box holds its last two poses, `phys.alpha` says how far
   * the render time lies between them, and `renderPos` / `renderQuat` hold that blend.
   * @param {number} dt  frame time in seconds
   * @returns {number} number of substeps that were run
   */
  step(dt) {
    if (!(dt > 0)) return 0;
    this._acc += dt > 0.1 ? 0.1 : dt;
    let n = Math.floor(this._acc / FIXED_DT + 1e-6);
    if (n > MAX_SUBSTEPS) {
      n = MAX_SUBSTEPS;
      this._acc = n * FIXED_DT;
    }
    this._acc -= n * FIXED_DT;
    if (this._acc < 0) this._acc = 0;
    this.advance(n, this._acc / FIXED_DT);
    return n;
  }

  /**
   * The same as `step` for a game loop that keeps its own accumulator: runs exactly `n`
   * substeps of FIXED_DT (traffic boxes reach their `setPose` targets at the end of them),
   * then blends the render poses at `alpha`.
   * @param {number} n      whole substeps to run, 0 to 10
   * @param {number} alpha  0..1, how far the render time lies between the last two substeps
   */
  advance(n, alpha) {
    const vehicles = this.vehicles;
    const boxes = this.boxes;
    if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
    if (n > 0) {
      const pushed = this._pushed;
      for (let i = 0; i < boxes.length; i++) boxes[i]._aim(n);
      for (let s = 0; s < n; s++) {
        for (let i = 0; i < vehicles.length; i++) vehicles[i]._preStep(FIXED_DT);
        for (let i = 0; i < pushed.length; i++) pushed[i]._slide(FIXED_DT);
        this._stepWorld();
        this.time += FIXED_DT;
        this._events.drainContactForceEvents(this._onForceEvent);
        for (let i = 0; i < vehicles.length; i++) vehicles[i]._postStep(FIXED_DT);
      }
      for (let i = 0; i < boxes.length; i++) boxes[i]._sync();
      // Forget pushed boxes that were resumed or teleported.
      for (let i = pushed.length - 1; i >= 0; i--) if (!pushed[i].pushed) pushed.splice(i, 1);
    }
    this.alpha = alpha;
    for (let i = 0; i < vehicles.length; i++) vehicles[i]._interpolate(alpha);
    for (let i = 0; i < boxes.length; i++) this.interpolate(boxes[i], boxes[i].renderPos, boxes[i].renderQuat);
  }

  /**
   * One Rapier step. This calls the physics pipeline directly instead of `world.step`:
   * the wrapper's `world.step` re-scans every body and collider of the world afterwards
   * (needed only for soft bodies, which create colliders while stepping), and that scan
   * costs about 0.13 microseconds per collider per step, far more than the step itself
   * once a few thousand static colliders are loaded.
   */
  _stepWorld() {
    const w = this.world;
    w.physicsPipeline.step(
      w.gravity, w.integrationParameters, w.islands, w.broadPhase, w.narrowPhase,
      w.bodies, w.colliders, w.softBodies, w.impulseJoints, w.multibodyJoints, w.ccdSolver,
      this._events,
    );
  }

  /**
   * Interpolated pose of a vehicle or traffic box at the render time.
   * The same values are kept up to date in `obj.renderPos` and `obj.renderQuat`.
   * @param {{pos:number[], quat:number[], prevPos:number[], prevQuat:number[]}} obj
   * @param {number[]} outPos   length 3
   * @param {number[]} outQuat  length 4
   */
  interpolate(obj, outPos, outQuat) {
    v3lerp(outPos, obj.prevPos, obj.pos, this.alpha);
    quatSlerp(outQuat, obj.prevQuat, obj.quat, this.alpha);
  }

  /** Global grip multiplier for the weather: 1 dry, about 0.8 in rain. */
  setGrip(mult) {
    this._grip = mult > 0.05 ? mult : 0.05;
  }

  /**
   * Hook that tells the tyres what the terrain is made of. Called with the world x and z
   * of a wheel contact, for one wheel per vehicle per substep; must return a KIND id
   * (0 asphalt, 1 concrete, 2 sand, 3 grass, 7 water). Typical use:
   *   phys.setSurfaceSampler((x, z) => surfaceOfField(world.field(x, z).kind));
   * Collider meshes (bridge decks) always count as asphalt and do not ask the sampler.
   * @param {((x: number, z: number) => number) | null} fn
   */
  setSurfaceSampler(fn) {
    this._surfaceSampler = fn || null;
  }

  // ---------------------------------------------------------------------------------
  // Static world
  // ---------------------------------------------------------------------------------

  _addStatic(desc, kind, group, list) {
    desc.setFriction(0.6).setRestitution(0).setCollisionGroups(groupWord(group, G_ALL));
    const col = this.world.createCollider(desc);
    this._kindByCollider.set(col.handle, kind);
    list.push(col);
    return col;
  }

  _cellKey(x, z) {
    return (Math.floor(x / TILE_SIZE) + 32768) * 65536 + (Math.floor(z / TILE_SIZE) + 32768);
  }

  /** True if the tile under world position (x, z) is loaded. */
  _hasTileAt(x, z) {
    return this._tileCells.size > 0 && this._tileCells.has(this._cellKey(x, z));
  }

  /**
   * Adds the static colliders of one world tile: the `colliders` record of a near-level
   * tile payload (design/ARCHITECTURE.md 9.2).
   * @param {string|number} key
   * @param {{heights?: Float32Array, cell?: number, boxes?: Float32Array, cylinders?: Float32Array,
   *          meshes?: Array<{positions: Float32Array, indices: Uint32Array}>}} colliders
   *   heights: (N+1)*(N+1) absolute ground heights, row-major (z rows, x within a row),
   *            sample (ix, iz) lies at (originX + ix*cell, originZ + iz*cell)
   *   boxes: stride 7 = cx, cy, cz, hx, hy, hz, yaw
   *   cylinders (upright): stride 5 = x, yBase, z, radius, height
   *   meshes: triangle meshes that can be driven on (bridges, ramps)
   * @param {number} originX  world x of the tile's low corner (tx * 128)
   * @param {number} originZ  world z of the tile's low corner (tz * 128)
   * @param {boolean} [local]  true if boxes, cylinders and meshes are relative to the tile
   *                           origin; false (default) if they are in world coordinates
   * @returns {number} number of colliders created
   */
  addTile(key, colliders, originX, originZ, local = false) {
    if (this._tiles.has(key)) this.removeTile(key);
    const list = [];
    const ox = local ? originX : 0, oz = local ? originZ : 0;
    const heights = colliders.heights;
    if (heights && heights.length > 3) {
      const n = Math.round(Math.sqrt(heights.length)) - 1;
      if ((n + 1) * (n + 1) !== heights.length) throw new Error('addTile: heights must be a square grid');
      const size = n * colliders.cell;
      // Rapier stores the grid column by column (x outer, z inner): transpose.
      const grid = new Float32Array(heights.length);
      for (let iz = 0; iz <= n; iz++) {
        for (let ix = 0; ix <= n; ix++) grid[ix * (n + 1) + iz] = heights[iz * (n + 1) + ix];
      }
      // The flag stops the chassis from catching on the edges between ground triangles.
      const desc = RAPIER.ColliderDesc.heightfield(n, n, grid, { x: size, y: 1, z: size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
        .setTranslation(originX + size / 2, 0, originZ + size / 2);
      this._terrain.add(this._addStatic(desc, KIND.ASPHALT, G_GROUND, list).handle);
    }
    const b = colliders.boxes;
    if (b) {
      for (let i = 0; i + 6 < b.length; i += 7) {
        const desc = RAPIER.ColliderDesc.cuboid(b[i + 3], b[i + 4], b[i + 5]).setTranslation(b[i] + ox, b[i + 1], b[i + 2] + oz);
        const yaw = b[i + 6];
        if (yaw !== 0) desc.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
        this._addStatic(desc, KIND.BUILDING, G_OBSTACLE, list);
      }
    }
    const c = colliders.cylinders;
    if (c) {
      for (let i = 0; i + 4 < c.length; i += 5) {
        const half = c[i + 4] / 2;
        const desc = RAPIER.ColliderDesc.cylinder(half, c[i + 3]).setTranslation(c[i] + ox, c[i + 1] + half, c[i + 2] + oz);
        this._addStatic(desc, KIND.POLE, G_OBSTACLE, list);
      }
    }
    if (colliders.meshes) {
      for (const mesh of colliders.meshes) {
        // The flag stops the chassis from catching on the seams between triangles.
        const desc = RAPIER.ColliderDesc.trimesh(mesh.positions, mesh.indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
          .setTranslation(ox, 0, oz);
        this._addStatic(desc, KIND.ASPHALT, G_GROUND, list);
      }
    }
    const cell = this._cellKey(originX + TILE_SIZE / 2, originZ + TILE_SIZE / 2);
    this._tileCells.add(cell);
    this._tiles.set(key, { colliders: list, cell });
    return list.length;
  }

  /** Removes everything that addTile created for `key`. */
  removeTile(key) {
    const tile = this._tiles.get(key);
    if (!tile) return false;
    const list = tile.colliders;
    for (let i = 0; i < list.length; i++) {
      this._kindByCollider.delete(list[i].handle);
      this._terrain.delete(list[i].handle);
      this.world.removeCollider(list[i], false);
    }
    this._tiles.delete(key);
    this._tileCells.delete(tile.cell);
    return true;
  }

  /**
   * Fallback ground: an infinite flat plane at height `y` that exists only where no tile
   * is loaded, so that a vehicle never falls through the world while tiles stream in.
   * Over a loaded tile the plane is ignored (the sea bed lies below it).
   * @param {number} y
   */
  setGroundPlane(y) {
    if (this._groundCollider) {
      this._kindByCollider.delete(this._groundCollider.handle);
      this._terrain.delete(this._groundCollider.handle);
      this.world.removeCollider(this._groundCollider, true);
    }
    const desc = new RAPIER.ColliderDesc(new RAPIER.HalfSpace({ x: 0, y: 1, z: 0 })).setTranslation(0, y, 0);
    this._groundCollider = this._addStatic(desc, KIND.ASPHALT, G_FALLBACK, []);
    this._terrain.add(this._groundCollider.handle);
    this._groundY = y;
  }

  // ---------------------------------------------------------------------------------
  // Dynamic things
  // ---------------------------------------------------------------------------------

  /**
   * Creates a simulated vehicle with suspension, tyres and drivetrain.
   * @param {import('./specs.js').VehicleSpec} spec  tuning, for example HERO_SPEC
   * @param {import('./specs.js').VehicleGeometry} [model]  the vehicle model record
   *   (design/ARCHITECTURE.md 10.1): `dims`, `anchors.wheels` and `collider` are read.
   *   Without it the stand-in geometry in `spec.model` is used.
   * @returns {Vehicle}
   */
  createVehicle(spec, model) {
    const v = new Vehicle(this, spec, model || spec.model);
    this.vehicles.push(v);
    return v;
  }

  /** Removes a vehicle created with createVehicle. */
  removeVehicle(v) {
    const i = this.vehicles.indexOf(v);
    if (i < 0) return;
    this.vehicles.splice(i, 1);
    for (const col of v._colliders) this._ownerByCollider.delete(col.handle);
    this.world.removeRigidBody(v.body);
  }

  /**
   * Creates a traffic box (see TrafficBox): kinematic, driven with setPose, and pushable.
   * @param {{model?: object, collider?: {halfExtents: number[], centre: number[]}, size?: number[],
   *          mass?: number, pushable?: boolean, pos?: number[], yaw?: number, kind?: number,
   *          lift?: number, userData?: any}} spec
   *   Shape from `model.collider` (a vehicle model record), `collider`, or `size` = [width, height, length].
   *   A spec from trafficSpec() can be passed as it is.
   * @returns {TrafficBox}
   */
  createKinematicBox(spec) {
    const box = new TrafficBox(this, spec);
    this.boxes.push(box);
    return box;
  }

  /** Removes a box created with createKinematicBox. */
  removeKinematicBox(box) {
    const i = this.boxes.indexOf(box);
    if (i < 0) return;
    this.boxes.splice(i, 1);
    const j = this._pushed.indexOf(box);
    if (j >= 0) this._pushed.splice(j, 1);
    this._ownerByCollider.delete(box._collider.handle);
    this.world.removeRigidBody(box.body);
  }

  // ---------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------

  /**
   * One ray through Rapier's raw bindings, with reused vectors. The direction must be unit
   * length. Returns the handle of the collider that was hit, or -1. On a hit `_rayDist` is
   * the distance and RAPIER.scratchBuffer[0..2] the surface normal.
   */
  _castRaw(ox, oy, oz, dx, dy, dz, maxDist, groups, excludeBody) {
    const o = this._rawOrigin, d = this._rawDir;
    o.x = ox; o.y = oy; o.z = oz;
    d.x = dx; d.y = dy; d.z = dz;
    const w = this.world;
    const hit = w.broadPhase.raw.castRayAndGetNormal(
      w.narrowPhase.raw, w.bodies.raw, w.colliders.raw, o, d, maxDist, true,
      undefined, groups, undefined, excludeBody, undefined,
    );
    if (!hit) return -1;
    const handle = hit.colliderHandle();
    this._rayDist = hit.time_of_impact();
    hit.normal(RAPIER.scratchBuffer);
    hit.free();
    return handle;
  }

  /** setLinvel, setAngvel, addForce and addTorque of a body, without a temporary vector. */
  _setLinvel(body, v, wake) {
    const r = this._rawA;
    r.x = v.x; r.y = v.y; r.z = v.z;
    body.rawSet.rbSetLinvel(body.handle, r, wake);
  }

  _setAngvel(body, v, wake) {
    const r = this._rawA;
    r.x = v.x; r.y = v.y; r.z = v.z;
    body.rawSet.rbSetAngvel(body.handle, r, wake);
  }

  _addForce(body, v, wake) {
    const r = this._rawA;
    r.x = v.x; r.y = v.y; r.z = v.z;
    body.rawSet.rbAddForce(body.handle, r, wake);
  }

  _addTorque(body, v, wake) {
    const r = this._rawA;
    r.x = v.x; r.y = v.y; r.z = v.z;
    body.rawSet.rbAddTorque(body.handle, r, wake);
  }

  /**
   * Ray used by the wheels: only drivable static surfaces. Fills `_groundHit`.
   * The direction must be unit length.
   */
  _castGround(ox, oy, oz, dx, dy, dz, maxDist, groups) {
    const handle = this._castRaw(ox, oy, oz, dx, dy, dz, maxDist, groups, undefined);
    if (handle < 0) return false;
    const n = RAPIER.scratchBuffer;
    // Ignore a ray that starts inside a solid, and faces that are too steep to stand on.
    // In both cases the chassis collider deals with the obstacle instead.
    if (this._rayDist < 1e-4 || -(n[0] * dx + n[1] * dy + n[2] * dz) < 0.5) return false;
    const g = this._groundHit;
    g.dist = this._rayDist;
    g.nx = n[0]; g.ny = n[1]; g.nz = n[2];
    const kind = this._kindByCollider.get(handle);
    g.kind = kind !== undefined ? kind : 0;
    g.terrain = this._terrain.has(handle);
    return true;
  }

  /**
   * Casts a ray against the static world, vehicles and traffic boxes (not the fallback
   * ground plane). For camera collision and AI. The returned object is reused by the next call.
   * @param {number[]} origin
   * @param {number[]} dir       need not be normalised
   * @param {number} maxDist     metres
   * @param {{body: object}} [exclude]  a vehicle or box to ignore (for example the hero)
   * @returns {{hit: boolean, dist: number, normal: number[], kind: number, body: object|null}}
   *   kind: a KIND id; body: the Vehicle or TrafficBox that was hit, or null
   */
  raycast(origin, dir, maxDist, exclude) {
    const out = this._rayResult;
    out.hit = false; out.dist = maxDist; out.kind = -1; out.body = null;
    const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    if (!(len > 0)) return out;
    const handle = this._castRaw(
      origin[0], origin[1], origin[2], dir[0] / len, dir[1] / len, dir[2] / len,
      maxDist, this._groups.query, exclude ? exclude.body.handle : undefined,
    );
    if (handle < 0) return out;
    const n = RAPIER.scratchBuffer;
    out.hit = true;
    out.dist = this._rayDist;
    out.normal[0] = n[0]; out.normal[1] = n[1]; out.normal[2] = n[2];
    const owner = this._ownerByCollider.get(handle);
    if (owner) {
      out.kind = owner.kind;
      out.body = owner;
    } else {
      const kind = this._kindByCollider.get(handle);
      out.kind = kind !== undefined ? kind : 0;
    }
    return out;
  }

  // ---------------------------------------------------------------------------------
  // Impact events
  // ---------------------------------------------------------------------------------

  /**
   * Registers a callback for vehicle impacts (audio, sparks, damage).
   * The event object is reused: copy what you need to keep.
   * @param {(e: {speed: number, pos: number[], normal: number[], otherKind: number, vehicle: Vehicle, other: object|null}) => void} cb
   *   speed: closing speed along the contact normal, m/s
   *   normal: points from the obstacle toward the vehicle
   *   otherKind: KIND id of what was hit. A wall-like face of a collider mesh (a parapet)
   *              is reported as BARRIER, a floor-like face as ASPHALT.
   *   other: the Vehicle or TrafficBox that was hit, or null for the static world
   * @returns {() => void} call it to unregister
   */
  onImpact(cb) {
    this._impactCallbacks.push(cb);
    return () => {
      const i = this._impactCallbacks.indexOf(cb);
      if (i >= 0) this._impactCallbacks.splice(i, 1);
    };
  }

  _handleForceEvent(ev) {
    const h1 = ev.collider1(), h2 = ev.collider2();
    const o1 = this._ownerByCollider.get(h1);
    const o2 = this._ownerByCollider.get(h2);
    if (o1 instanceof Vehicle) this._reportImpact(o1, h1, h2, o2, ev);
    if (o2 instanceof Vehicle) this._reportImpact(o2, h2, h1, o1, ev);
  }

  _reportImpact(veh, hSelf, hOther, other, ev) {
    if (veh._impactCooldown > 0 || veh.recovering) return;
    const n = ev.maxForceDirection(this._tmpA);
    const now = veh.body.linvel(this._tmpB);
    const pre = veh._preV;
    // Orient the normal the way the contact pushed the vehicle.
    let nx = n.x, ny = n.y, nz = n.z;
    if ((now.x - pre[0]) * nx + (now.y - pre[1]) * ny + (now.z - pre[2]) * nz < 0) {
      nx = -nx; ny = -ny; nz = -nz;
    }
    let rx = pre[0], ry = pre[1], rz = pre[2];
    if (other) {
      const ov = other instanceof Vehicle ? other._preV : other.vel;
      rx -= ov[0]; ry -= ov[1]; rz -= ov[2];
    }
    const speed = -(rx * nx + ry * ny + rz * nz);
    if (!(speed >= MIN_IMPACT_SPEED)) return;
    const e = this._impactEvent;
    e.speed = speed;
    e.normal[0] = nx; e.normal[1] = ny; e.normal[2] = nz;
    e.vehicle = veh;
    e.other = other || null;
    if (other) {
      e.otherKind = other.kind;
    } else {
      const kind = this._kindByCollider.get(hOther);
      e.otherKind = kind !== undefined ? kind : 0;
      if (e.otherKind <= KIND.GRASS && Math.abs(ny) < 0.5) e.otherKind = KIND.BARRIER;
    }
    // Contact position from the narrow phase, or the vehicle position if it has none.
    this._contactFound = false;
    this.world.narrowPhase.contactPair(hSelf, hOther, this.world.bodies, this._onManifold);
    if (this._contactFound) {
      e.pos[0] = this._contactPoint.x; e.pos[1] = this._contactPoint.y; e.pos[2] = this._contactPoint.z;
    } else {
      e.pos[0] = veh.pos[0]; e.pos[1] = veh.pos[1] + 0.4; e.pos[2] = veh.pos[2];
    }
    veh.lastImpact.speed = speed;
    veh.lastImpact.time = this.time;
    veh.lastImpact.kind = e.otherKind;
    veh._impactCooldown = 0.15;
    const cbs = this._impactCallbacks;
    for (let i = 0; i < cbs.length; i++) cbs[i](e);
  }

  /** Frees the WASM world. The object must not be used afterwards. */
  dispose() {
    this._events.free();
    this._rawA.free();
    this._rawOrigin.free();
    this._rawDir.free();
    this.world.free();
    this.vehicles.length = 0;
    this.boxes.length = 0;
    this._pushed.length = 0;
  }
}

/**
 * Creates the physics world. Loads the Rapier WASM on first use.
 * @param {{gravity?: number, killY?: number, seaLevel?: number}} [opts]
 *   gravity: m/s^2 along Y, default -9.81
 *   killY: height below which a vehicle counts as lost and is put back, default -20
 *   seaLevel: height of the sea surface, default 0
 * @returns {Promise<Physics>}
 */
export async function createPhysics(opts = {}) {
  if (!rapierReady) rapierReady = RAPIER.init();
  await rapierReady;
  return new Physics(opts);
}
