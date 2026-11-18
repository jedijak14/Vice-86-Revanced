// Raycast vehicle: suspension, tyres, drivetrain, driver aids and the stay-upright logic.
//
// One Rapier dynamic rigid body carries the chassis collider. Wheels are not bodies:
// each substep casts one ray per wheel along the suspension axis, turns the hit into a
// spring/damper force, and runs a combined-slip tyre model on the contact patch velocity.
// All forces of a substep are summed in JS and handed to Rapier as one force and one
// torque, then Rapier integrates the body and resolves chassis contacts.
//
// Frame: right-handed, +Y up, +Z forward, +X to the car's LEFT. Yaw is rotation about +Y,
// yaw 0 faces +Z, positive yaw and positive steer both turn the car to its left.
// Wheel order: 0 front left, 1 front right, 2 rear left, 3 rear right.

import { clamp, v3lerp, quatSlerp } from '../core/math.js';
import { KIND, SURFACES } from './specs.js';

const RAD_TO_RPM = 60 / (2 * Math.PI);
const AIR_DENSITY = 1.2;
// Below these speeds the slip definitions use a fixed reference speed. That turns the
// tyre into a strong viscous brake near standstill and keeps the explicit integration
// stable (the values are the smallest that stay well damped at 120 Hz).
const LOW_V_LONG = 5;
const LOW_V_LAT = 4;
const G = 9.81;
// Below sea level the car is in water: heavy drag, and `inWater` tells the game.
const WATER_DRAG = 2.5;
// Seconds a car has to stand still before it is parked (put to sleep): normally, and
// after something other than the driver has moved it.
const PARK_DELAY = 0.35;
const PARK_DELAY_DISTURBED = 2;

// Scratch outputs of tyreForce(): force along and across the wheel, slip ratio and tan(slip
// angle). A typed array, because numbers stored in plain module variables are boxed.
const TYRE = new Float64Array(4);

/**
 * Combined-slip tyre force.
 * Longitudinal and lateral slip are each normalised by the slip at peak grip, the
 * magnitude of that vector picks a point on one grip curve (rises to 1 at the peak,
 * then eases off), and the force points against the slip. This gives a friction
 * circle for free: a locked or spinning wheel has little lateral grip left.
 * @param {number} vx   patch speed along the wheel heading
 * @param {number} vy   patch speed to the wheel's left
 * @param {number} wr   wheel surface speed (omega * radius)
 * @param {number} fz   normal load, N
 * @param {number} mu   friction coefficient
 * @param {number} kp   slip ratio at peak
 * @param {number} ap   tan(slip angle) at peak
 * @param {number} cB   curve stiffness factor
 * @param {number} cC   curve shape factor
 */
function tyreForce(vx, vy, wr, fz, mu, kp, ap, cB, cC) {
  const avx = vx < 0 ? -vx : vx;
  const sx = (wr - vx) / (avx > LOW_V_LONG ? avx : LOW_V_LONG);
  const sy = -vy / (avx > LOW_V_LAT ? avx : LOW_V_LAT);
  const nx = sx / kp;
  const ny = sy / ap;
  const s = Math.sqrt(nx * nx + ny * ny);
  TYRE[2] = sx;
  TYRE[3] = sy;
  if (s < 1e-9) {
    TYRE[0] = 0;
    TYRE[1] = 0;
    return;
  }
  const f = (mu * fz * Math.sin(cC * Math.atan(cB * s))) / s;
  TYRE[0] = f * nx;
  TYRE[1] = f * ny;
}

/** Moves `x` toward `target` by at most `step`. */
function approach(x, target, step) {
  if (x < target) return x + step > target ? target : x + step;
  return x - step < target ? target : x - step;
}

/**
 * Collision hull of the body: a car-like convex shape fitted inside the model's bounding box.
 * The floor is lifted to `clearance` and rises to the bumpers over `chamfer` metres, so the
 * hull passes over kerbs and slides up obstacles instead of digging in. The roof is narrower
 * and shorter than the belt line, like a cabin.
 * @returns {Float32Array} points, x y z triples, vehicle frame
 */
function chassisHull(collider, chassis) {
  const he = collider.halfExtents, c = collider.centre;
  const hx = he[0];
  const front = c[2] + he[2], rear = c[2] - he[2], len = he[2] * 2;
  const top = c[1] + he[1];
  const floor = Math.max(c[1] - he[1], chassis.clearance);
  const belt = floor + (top - floor) * 0.45;
  const lip = floor + (belt - floor) * 0.35;
  const ch = Math.min(chassis.chamfer, len * 0.25);
  const pts = [];
  const pair = (x, y, z) => pts.push(x, y, z, -x, y, z);
  pair(hx * 0.96, floor, front - ch);
  pair(hx * 0.96, floor, rear + ch);
  pair(hx * 0.9, lip, front);
  pair(hx * 0.9, lip, rear);
  pair(hx, belt, front - ch * 0.5);
  pair(hx, belt, rear + ch * 0.5);
  pair(hx * 0.9, belt, front);
  pair(hx * 0.9, belt, rear);
  pair(hx * 0.68, top, front - len * 0.36);
  pair(hx * 0.68, top, rear + len * 0.2);
  return new Float32Array(pts);
}

export class Vehicle {
  /**
   * @param {object} phys  the physics object from createPhysics (internal fields are used)
   * @param {import('./specs.js').VehicleSpec} spec       tuning
   * @param {import('./specs.js').VehicleGeometry} model  geometry (the vehicle model record)
   */
  constructor(phys, spec, model) {
    const RAPIER = phys.RAPIER;
    this._phys = phys;
    this.spec = spec;
    this.model = model;
    this.kind = KIND.VEHICLE;
    /** Free slot for the game (driver, mesh, ...). */
    this.userData = null;
    /** Radius of the circle around the origin that contains the footprint. */
    this.boundRadius = Math.hypot(model.collider.halfExtents[0], model.collider.halfExtents[2] + Math.abs(model.collider.centre[2]));

    // ---- public, read-only state (updated every substep) ----
    this.pos = [0, 0, 0];
    this.quat = [0, 0, 0, 1];
    this.prevPos = [0, 0, 0];
    this.prevQuat = [0, 0, 0, 1];
    this.vel = [0, 0, 0];
    this.angVel = [0, 0, 0];
    this.speed = 0;
    this.rpm = spec.engine.idle;
    this.gear = 1;
    this.redline = spec.engine.redline;
    /** Nitrous really delivered, 0..1 (see setBoost). */
    this.boost = 0;
    /** Turbocharger boost 0..1, with its lag. Always 0 on a car without a turbocharger. */
    this.turbo = 0;
    /** 1 while the gearbox is changing gear (clutch open, torque cut or blip), else 0. */
    this.shifting = 0;
    /** Pedals and steering as applied after the aids and the rate limit (not the raw input). */
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0; // -1..1, positive left
    this.steerAngle = 0; // road wheel angle, rad
    this.onGround = false; // at least two wheels touch
    this.airborne = false; // no wheel touches
    this.inWater = false; // the car is below sea level
    this.gForce = [0, 0];
    /** Pose interpolated to the render time, refreshed by every phys.step. */
    this.renderPos = [0, 0, 0];
    this.renderQuat = [0, 0, 0, 1];
    this.lastImpact = { speed: 0, time: -1, kind: -1 };
    this.yaw = 0;
    /** True while the auto recover is turning the car back onto its wheels. */
    this.recovering = false;
    /** True while a handbrake drift is in progress (the aids are relaxed). */
    this.drifting = false;
    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      this.wheels.push({
        steer: 0, spin: 0, suspLen: 0, contact: false,
        slipLong: 0, slipLat: 0, surfaceKind: 0, surfaceY: 0,
        worldPos: [0, 0, 0], // wheel centre, world space, at the latest substep
        localPos: [0, 0, 0], // wheel centre in the vehicle frame: use with the interpolated pose
        load: 0, angVel: 0,
      });
    }

    // ---- input ----
    this._in = { throttle: 0, brake: 0, steer: 0, handbrake: 0, clutchKick: false, boost: 0 };

    // ---- derived constants ----
    const s = spec.suspension;
    const anchors = model.anchors.wheels;
    const wheelPos = [anchors.fl, anchors.fr, anchors.rl, anchors.rr];
    const zf = (wheelPos[0][2] + wheelPos[1][2]) * 0.5;
    const zr = (wheelPos[2][2] + wheelPos[3][2]) * 0.5;
    this._wheelbase = zf - zr;
    const frontShare = spec.weightFront;
    // The centre of mass is a tuning value: on the centre line, at the height and the
    // front/rear weight split of the spec, wherever the model puts its axles.
    const com = [0, spec.comHeight, zr + frontShare * this._wheelbase];
    this._comX = com[0];
    this._comY = com[1];
    this._comZ = com[2];
    this._radius = new Float64Array(4);
    this._k = new Float64Array(4);
    this._cBump = new Float64Array(4);
    this._cReb = new Float64Array(4);
    this._staticLoad = new Float64Array(4);
    this._mu = new Float64Array(4);
    // Hardpoints: the top of each suspension ray, in the vehicle frame.
    this._hx = new Float64Array(4);
    this._hy = new Float64Array(4);
    this._hz = new Float64Array(4);
    const gAbs = Math.abs(phys.gravity);
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      this._radius[i] = front ? model.dims.wheelRadiusFront : model.dims.wheelRadiusRear;
      this._k[i] = front ? s.stiffness.front : s.stiffness.rear;
      this._cBump[i] = front ? s.bump.front : s.bump.rear;
      this._cReb[i] = front ? s.rebound.front : s.rebound.rear;
      this._staticLoad[i] = spec.mass * gAbs * (front ? frontShare : 1 - frontShare) * 0.5;
      this._mu[i] = front ? spec.tyre.mu.front : spec.tyre.mu.rear;
      // Place the hardpoint so that the static sag puts the wheel centre exactly at the
      // position given in the spec. That makes the ride height a spec value, not a tuning result.
      const sag = this._staticLoad[i] / this._k[i];
      this._hx[i] = wheelPos[i][0];
      this._hy[i] = wheelPos[i][1] + (s.restLength - sag);
      this._hz[i] = wheelPos[i][2];
    }
    this._arbF = s.antiRoll.front;
    this._arbR = s.antiRoll.rear;
    this._tyreC = spec.tyre.shape;
    this._tyreB = Math.tan(Math.PI / (2 * spec.tyre.shape)); // puts the curve peak at slip 1
    this._tyreAp = Math.tan(spec.tyre.peakSlipAngle);
    this._curve = new Float64Array(spec.engine.torqueCurve.length * 2);
    for (let i = 0; i < spec.engine.torqueCurve.length; i++) {
      this._curve[i * 2] = spec.engine.torqueCurve[i][0];
      this._curve[i * 2 + 1] = spec.engine.torqueCurve[i][1];
    }
    this._awd = spec.drivetrain === 'awd';
    this._nDriven = this._awd ? 4 : 2;
    this._driveShare = this._awd ? [0.2, 0.2, 0.3, 0.3] : [0, 0, 0.5, 0.5];

    // ---- per wheel state ----
    this._omega = new Float64Array(4);
    this._comp = new Float64Array(4); // spring compression
    this._load = new Float64Array(4); // normal force
    this._contact = new Uint8Array(4);
    this._surf = new Uint8Array(4);
    this._abs = new Float64Array([1, 1, 1, 1]);
    this._cp = new Float64Array(12); // contact points
    this._cn = new Float64Array(12); // contact normals
    this._driveT = new Float64Array(4);
    this._brakeT = new Float64Array(4);
    this._inertia = new Float64Array(4);

    // ---- drivetrain and driver state ----
    this._steer = 0; // rate limited steering position -1..1
    this._steerAngle = 0;
    this._shiftTimer = 0;
    this._shiftCooldown = 0;
    this._shiftDir = 0; // +1 while an upshift is in progress, -1 for a downshift
    this._driveHeld = 0; // the pedal the upshift point follows; lags a lift (see liftHold)
    this._liftTimer = 0;
    this._reverseTimer = 0;
    this._tc = 1;
    this._kickTimer = 0;
    this._kickBurst = 0;
    this._kickHeld = false;
    this._driftTimer = 0;
    this._parkTimer = 0;
    this._parkDelay = PARK_DELAY;
    this._parked = false;
    this._tiltTimer = 0;
    this._recoverT = 0;
    this._safeTimer = 0;
    this._safe = [0, 0, 0, 0]; // last good x, y, z, yaw
    this._hasSafe = false;
    this._impactCooldown = 0;
    this._contacts = 0;
    this._gLat = 0;
    this._gLong = 0;
    this._prevSlipAngle = 0;
    // Smoothed ground normal, the reference for roll and pitch.
    this._gnx = 0;
    this._gny = 1;
    this._gnz = 0;
    // Velocity at the start of the current substep: the reference for impact speed.
    this._preV = [0, 0, 0];
    // Surface kind per wheel from the surface sampler; one wheel is refreshed per substep.
    this._sampled = new Uint8Array(4);
    this._sampleIdx = 0;
    // True while the car is outside the loaded tiles and rides the fallback ground plane.
    this._onFallback = true;

    // ---- rigid body ----
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setCanSleep(false) // sleeping is driven by the parking logic below
      .setCcdEnabled(true) // 0.6 m per substep at top speed: do not tunnel through thin walls
      .setAngularDamping(0.1);
    this.body = phys.world.createRigidBody(desc);
    this.body.userData = this;
    const groups = phys._groups.vehicle;
    const c = spec.chassis;
    this._colliders = [];
    const addCollider = (cd) => {
      cd.setDensity(0)
        .setFriction(c.friction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(c.restitution)
        .setCollisionGroups(groups)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        // About 2 g on the whole car: ignores resting and light scrapes.
        .setContactForceEventThreshold(spec.mass * 20);
      const col = phys.world.createCollider(cd, this.body);
      this._colliders.push(col);
      phys._ownerByCollider.set(col.handle, this);
    };
    const hull = RAPIER.ColliderDesc.convexHull(chassisHull(model.collider, c));
    if (!hull) throw new Error('createVehicle: the model collider is degenerate');
    addCollider(hull);
    // Mass, centre of mass and inertia come from the spec, not from the collider shape.
    this.body.setAdditionalMassProperties(
      spec.mass,
      { x: com[0], y: com[1], z: com[2] },
      { x: spec.inertia[0], y: spec.inertia[1], z: spec.inertia[2] },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    // Reused Rapier argument objects.
    this._v3a = { x: 0, y: 0, z: 0 };
    this._q = { x: 0, y: 0, z: 0, w: 1 };
    this._readPose();
    this._copyPrev();
  }

  /**
   * Driver input. Values are clamped. Positive steer turns left.
   * @param {{throttle?: number, brake?: number, steer?: number, handbrake?: number, clutchKick?: boolean}} input
   */
  setInput(input) {
    const i = this._in;
    if (input.throttle !== undefined) i.throttle = clamp(+input.throttle || 0, 0, 1);
    if (input.brake !== undefined) i.brake = clamp(+input.brake || 0, 0, 1);
    if (input.steer !== undefined) i.steer = clamp(+input.steer || 0, -1, 1);
    if (input.handbrake !== undefined) i.handbrake = clamp(+input.handbrake || 0, 0, 1);
    if (input.clutchKick !== undefined) i.clutchKick = !!input.clutchKick;
  }

  /**
   * Nitrous request, 0..1. It stays set until changed; `reset` and `recover(pos)` clear it.
   * What the engine really delivers is `this.boost`: nothing off the throttle, below
   * `spec.boost.minRpm`, in reverse or during a shift, and less when traction control trims.
   * A vehicle whose spec has no `boost` block ignores the call.
   * @param {number} amount
   */
  setBoost(amount) {
    this._in.boost = clamp(+amount || 0, 0, 1);
  }

  /**
   * Places the car at rest. `pos` is the point on the ground under the middle of the car.
   * @param {number[]} pos
   * @param {number} yaw
   */
  reset(pos, yaw) {
    const b = this.body;
    const q = this._q;
    q.x = 0; q.y = Math.sin(yaw / 2); q.z = 0; q.w = Math.cos(yaw / 2);
    const v = this._v3a;
    v.x = pos[0]; v.y = pos[1]; v.z = pos[2];
    b.setTranslation(v, true);
    b.setRotation(q, true);
    v.x = 0; v.y = 0; v.z = 0;
    b.setLinvel(v, true);
    b.setAngvel(v, true);
    b.resetForces(false);
    b.resetTorques(false);
    this._omega.fill(0);
    this._abs.fill(1);
    this._contact.fill(0);
    this._steer = 0;
    this._steerAngle = 0;
    this.gear = 1;
    this.rpm = this.spec.engine.idle;
    this._shiftTimer = 0;
    this._shiftCooldown = 0;
    this._shiftDir = 0;
    this.shifting = 0;
    this._driveHeld = 0;
    this._liftTimer = 0;
    this._reverseTimer = 0;
    this._tc = 1;
    this._kickTimer = 0;
    this._kickBurst = 0;
    this.boost = 0;
    this.turbo = 0;
    this._in.boost = 0;
    this._driftTimer = 0;
    this.drifting = false;
    this._parked = false;
    this._parkTimer = 0;
    this._parkDelay = PARK_DELAY;
    this._tiltTimer = 0;
    this.recovering = false;
    this._gnx = 0; this._gny = 1; this._gnz = 0;
    this._gLat = 0; this._gLong = 0;
    this.gForce[0] = 0; this.gForce[1] = 0;
    this.steer = 0; this.steerAngle = 0; this.throttle = 0; this.brake = 0;
    this._safe[0] = pos[0]; this._safe[1] = pos[1]; this._safe[2] = pos[2]; this._safe[3] = yaw;
    this._hasSafe = true;
    this._readPose();
    this._copyPrev();
    this._interpolate(1);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.spin = 0; w.contact = false; w.slipLong = 0; w.slipLat = 0; w.steer = 0; w.angVel = 0;
      const sag = this._staticLoad[i] / this._k[i];
      w.suspLen = this.spec.suspension.restLength - sag;
      this._wheelWorldPos(i, w.suspLen);
    }
  }

  /**
   * Puts the car back on its wheels.
   * With a position: placed at rest there (for example the nearest road point), facing `yaw`.
   * Without arguments: righted where it is, eased over about a second.
   * @param {number[]} [pos]  point on the ground
   * @param {number} [yaw]
   */
  recover(pos, yaw) {
    if (pos) this.reset(pos, yaw !== undefined ? yaw : this.yaw);
    else if (!this.recovering) this._beginRecover(false);
  }

  // ------------------------------------------------------------------------------------
  // Internal: called by phys.step for every fixed substep.
  // ------------------------------------------------------------------------------------

  _copyPrev() {
    const p = this.pos, pp = this.prevPos, q = this.quat, pq = this.prevQuat;
    pp[0] = p[0]; pp[1] = p[1]; pp[2] = p[2];
    pq[0] = q[0]; pq[1] = q[1]; pq[2] = q[2]; pq[3] = q[3];
  }

  _readPose() {
    const b = this.body;
    const t = b.translation(this._v3a);
    this.pos[0] = t.x; this.pos[1] = t.y; this.pos[2] = t.z;
    const q = b.rotation(this._q);
    this.quat[0] = q.x; this.quat[1] = q.y; this.quat[2] = q.z; this.quat[3] = q.w;
    const v = b.linvel(this._v3a);
    this.vel[0] = v.x; this.vel[1] = v.y; this.vel[2] = v.z;
    const w = b.angvel(this._v3a);
    this.angVel[0] = w.x; this.angVel[1] = w.y; this.angVel[2] = w.z;
    // Basis vectors of the vehicle frame in world space.
    const x = q.x, y = q.y, z = q.z, qw = q.w;
    this._lx = 1 - 2 * (y * y + z * z); this._ly = 2 * (x * y + qw * z); this._lz = 2 * (x * z - qw * y);
    this._ux = 2 * (x * y - qw * z); this._uy = 1 - 2 * (x * x + z * z); this._uz = 2 * (y * z + qw * x);
    this._fx = 2 * (x * z + qw * y); this._fy = 2 * (y * z - qw * x); this._fz = 1 - 2 * (x * x + y * y);
    this.yaw = Math.atan2(this._fx, this._fz);
    this.speed = this.vel[0] * this._fx + this.vel[1] * this._fy + this.vel[2] * this._fz;
  }

  /** Fills renderPos and renderQuat for a render time `alpha` between the last two substeps. */
  _interpolate(alpha) {
    v3lerp(this.renderPos, this.prevPos, this.pos, alpha);
    quatSlerp(this.renderQuat, this.prevQuat, this.quat, alpha);
  }

  _wheelWorldPos(i, suspLen) {
    const hx = this._hx[i], hy = this._hy[i] - suspLen, hz = this._hz[i];
    const lp = this.wheels[i].localPos;
    lp[0] = hx; lp[1] = hy; lp[2] = hz;
    const wp = this.wheels[i].worldPos;
    wp[0] = this.pos[0] + this._lx * hx + this._ux * hy + this._fx * hz;
    wp[1] = this.pos[1] + this._ly * hx + this._uy * hy + this._fy * hz;
    wp[2] = this.pos[2] + this._lz * hx + this._uz * hy + this._fz * hz;
  }

  /** Engine torque at full throttle, linear interpolation of the curve. */
  _engineTorque(rpm) {
    const c = this._curve;
    const n = c.length;
    if (rpm <= c[0]) return c[1];
    for (let i = 2; i < n; i += 2) {
      if (rpm <= c[i]) {
        const t = (rpm - c[i - 2]) / (c[i] - c[i - 2]);
        return c[i - 1] + (c[i + 1] - c[i - 1]) * t;
      }
    }
    return c[n - 1];
  }

  /** Total ratio engine to wheel for the current gear, negative in reverse. */
  _ratio() {
    const s = this.spec;
    if (this.gear > 0) return s.gears[this.gear - 1] * s.finalDrive;
    if (this.gear < 0) return -s.reverse * s.finalDrive;
    return 0;
  }

  /**
   * Steering: rate limited key position, speed sensitive lock, and a countersteer
   * assist that lets the front wheels follow the direction of travel in a slide
   * (what a real steering wheel does when you let it slip through your hands).
   */
  _updateSteering(h, vLong, vLatFront) {
    const st = this.spec.steer;
    const target = this._in.steer;
    // Releasing the key or reversing the input is quicker than winding lock on.
    const unwinding = target === 0 || target * this._steer < 0;
    this._steer = approach(this._steer, target, (unwinding ? st.centreRate : st.rate) * h);
    const v = vLong < 0 ? -vLong : vLong;
    const v2 = v * v > 1 ? v * v : 1;
    let lock = Math.atan((this._wheelbase * st.lateralRef) / v2) + st.slipAllowance * this.spec.tyre.peakSlipAngle;
    if (lock > st.maxAngle) lock = st.maxAngle;
    let angle = this._steer * lock;
    if (vLong > 6 && st.counterSteer > 0) {
      let beta = Math.atan2(vLatFront, vLong);
      // Small angles are normal cornering, leave those to the driver.
      const dead = 0.035;
      beta = beta > dead ? beta - dead : beta < -dead ? beta + dead : 0;
      const fade = clamp((vLong - 6) / 6, 0, 1);
      angle += beta * st.counterSteer * fade;
    }
    angle = clamp(angle, -st.maxAngle, st.maxAngle);
    // The assist can ask for a jump when grip returns, keep the wheels' slew rate finite.
    this._steerAngle = approach(this._steerAngle, angle, 3.5 * h);
    this.steer = this._steer;
    this.steerAngle = this._steerAngle;
    this.wheels[0].steer = this._steerAngle;
    this.wheels[1].steer = this._steerAngle;
  }

  /**
   * Pedals, automatic gearbox, clutch, engine, traction control, ABS.
   * Fills _driveT, _brakeT and _inertia for the four wheels.
   */
  _updateDrivetrain(h, vLong, roadSpeed, rearSlipAngle) {
    const spec = this.spec;
    const eng = spec.engine;
    const gb = spec.gearbox;
    const aids = spec.aids;
    const inp = this._in;
    const onGround = this._contacts >= 2;

    // --- pedal roles: in reverse gear the brake pedal drives and the throttle brakes ---
    let drive, brake;
    if (this.gear >= 1) {
      if (inp.brake > 0.1 && inp.throttle < 0.05 && vLong < 0.5) {
        this._reverseTimer += h;
        if (this._reverseTimer > 0.2) {
          this.gear = -1;
          this._reverseTimer = 0;
        }
      } else {
        this._reverseTimer = 0;
      }
    } else if (inp.throttle > 0.1 && inp.brake < 0.05 && vLong > -0.5) {
      this.gear = 1;
      this._shiftCooldown = gb.cooldown;
    }
    if (this.gear >= 1) {
      drive = inp.throttle;
      brake = inp.brake;
    } else {
      drive = inp.brake;
      brake = inp.throttle;
      // Fade the drive out near the reverse speed limit.
      drive *= clamp((gb.reverseMaxSpeed + vLong) / 2, 0, 1);
    }
    const aSpeed = vLong < 0 ? -vLong : vLong;
    // Auto hold: with no pedal pressed, a nearly stopped car is held on the brakes.
    if (drive < 0.02 && aSpeed < 1.2 && onGround) brake = brake > 0.4 ? brake : 0.4;

    // --- automatic gearbox, decided on road speed so that wheelspin cannot cause shifts ---
    const rDriven = this._radius[2];
    if (this._shiftTimer > 0) this._shiftTimer -= h;
    if (this._shiftCooldown > 0) this._shiftCooldown -= h;
    // The upshift point follows the pedal up at once but follows a lift only after
    // `liftHold`: a car that lifts off at high revs keeps its gear for a moment instead of
    // climbing through the box, and an upshift on a light pedal comes one gear at a time.
    const liftHold = gb.liftHold || 0;
    if (drive < this._driveHeld - 0.05 && liftHold > 0) {
      this._liftTimer += h;
      if (this._liftTimer > liftHold) {
        this._driveHeld = drive;
        this._liftTimer = 0;
      }
    } else {
      this._driveHeld = drive;
      this._liftTimer = 0;
    }
    if (this.gear >= 1 && this._shiftCooldown <= 0 && onGround) {
      const toRpm = (spec.finalDrive * RAD_TO_RPM) / rDriven;
      const roadRpm = roadSpeed * toRpm * spec.gears[this.gear - 1];
      const upRpm = eng.redline * (gb.upRpmCruise + (gb.upRpm - gb.upRpmCruise) * this._driveHeld);
      // The top `overdrive` gears are too tall for the engine alone: they are only taken
      // while nitrous is flowing, and left again once the gear below fits under the limiter.
      const normalGears = spec.gears.length - (gb.overdrive || 0);
      const mayShiftUp = this.gear < normalGears || (this.gear < spec.gears.length && this.boost > 0.5);
      if (mayShiftUp && roadRpm > upRpm && inp.handbrake < 0.1) {
        this.gear++;
        this._shiftTimer = gb.shiftTime;
        this._shiftDir = 1;
        // On a light pedal the next gear waits a full hold, so a coasting car shifts up
        // one gear at a time rather than two within the cooldown.
        this._shiftCooldown = drive < 0.5 && liftHold > gb.cooldown ? liftHold : gb.cooldown;
      } else if (this.gear > 1) {
        // Shift down when the lower gear would still sit comfortably below its upshift
        // point. The pedal of the moment decides here, so that a kick-down is immediate.
        const upRpmNow = eng.redline * (gb.upRpmCruise + (gb.upRpm - gb.upRpmCruise) * drive);
        const lowerRpm = roadSpeed * toRpm * spec.gears[this.gear - 2];
        const overdriveSpent = this.gear > normalGears && this.boost < 0.1 && inp.boost < 0.1;
        if (lowerRpm < upRpmNow * 0.8 || (overdriveSpent && lowerRpm < eng.redline * 0.97)) {
          this.gear--;
          this._shiftTimer = gb.downshiftTime;
          this._shiftDir = -1;
          this._shiftCooldown = gb.cooldown;
        }
      }
    }
    this.shifting = this._shiftTimer > 0 ? 1 : 0;

    // --- drift state: entered with the handbrake at speed, left when the slide has ended ---
    const absBeta = rearSlipAngle < 0 ? -rearSlipAngle : rearSlipAngle;
    if (inp.handbrake > 0.5 && aSpeed > 8) {
      this.drifting = true;
      this._driftTimer = 0;
    } else if (this.drifting) {
      this._driftTimer = absBeta < 0.09 ? this._driftTimer + h : 0;
      if (this._driftTimer > 0.4 || aSpeed < 4) this.drifting = false;
    }

    // --- clutch kick: a short clutch dip, then a torque burst to unsettle the rear ---
    if (inp.clutchKick && !this._kickHeld) this._kickTimer = 0.12;
    this._kickHeld = inp.clutchKick;
    if (this._kickTimer > 0) {
      this._kickTimer -= h;
      if (this._kickTimer <= 0) this._kickBurst = 0.4;
    }
    if (this._kickBurst > 0) this._kickBurst -= h;

    // --- traction control: trims the throttle when the driven wheels spin up ---
    let slip = 0;
    for (let i = 0; i < 4; i++) {
      if (this._driveShare[i] > 0 && this._contact[i]) {
        const s = this.wheels[i].slipLong * (this.gear < 0 ? -1 : 1);
        if (s > slip) slip = s;
      }
    }
    // While drifting or after a clutch kick the driver wants wheelspin: allow far more slip.
    const loose = this.drifting || this._kickBurst > 0;
    const s0 = loose ? 0.45 : aids.tcSlip;
    const width = loose ? 0.6 : 0.12;
    let tcTarget = 1;
    if (aids.tc > 0 && slip > s0) tcTarget = 1 - aids.tc * clamp((slip - s0) / width, 0, 1);
    // Cut fast, give back more slowly: no on/off chatter.
    this._tc = approach(this._tc, tcTarget, (tcTarget < this._tc ? 25 : 6) * h);

    // --- engine and clutch ---
    const ratio = this._ratio();
    const aRatio = ratio < 0 ? -ratio : ratio;
    let wSum = 0;
    for (let i = 0; i < 4; i++) wSum += this._omega[i] * this._driveShare[i];
    // Crank speed implied by the driven wheels. Negative means that the car rolls against
    // the selected gear (shoved backwards by a collision, say): the clutch then slips as
    // it does when pulling away, so the engine can never drive or brake the wrong way.
    const wheelRpm = Math.max(0, wSum * ratio) * RAD_TO_RPM;
    const clutchOpen = this._shiftTimer > 0 || inp.handbrake > 0.1 || this._kickTimer > 0 || ratio === 0;
    let engineT = 0; // at the crank
    let locked = false;
    let rpm;
    let thr = drive * this._tc;
    // Nitrous multiplies the engine torque. The flow follows the throttle after traction
    // control, so everything that holds the engine back holds the boost back as well. It
    // builds up over a moment and is cut quickly: no kick in the back, no lag when grip goes.
    const nos = spec.boost;
    let boostGain = 1;
    if (nos) {
      let flow = 0;
      if (!clutchOpen && this.gear >= 1) {
        flow = inp.boost * thr * clamp((this.rpm - nos.minRpm + 400) / 400, 0, 1) *
          clamp((eng.redline + 50 - this.rpm) / 100, 0, 1);
      }
      this.boost = approach(this.boost, flow, (flow > this.boost ? nos.rise : nos.fall) * h);
      boostGain = 1 + nos.force * this.boost;
    }
    // Turbocharger: the torque curve of the spec is the engine on full boost. Off boost
    // it gives only a share of that. Boost builds with the pedal down above the threshold
    // revs, after a lag, and is dumped on a lift and through the torque cut of an upshift.
    const tb = eng.turbo;
    if (tb) {
      const cut = this._shiftTimer > 0 && this._shiftDir > 0;
      const want = cut ? 0 : thr * clamp((this.rpm - tb.startRpm) / (tb.fullRpm - tb.startRpm), 0, 1);
      this.turbo = approach(this.turbo, want, (want > this.turbo ? tb.rise : tb.fall) * h);
      boostGain *= tb.offBoost + (1 - tb.offBoost) * this.turbo;
    }
    if (this.shifting && inp.handbrake <= 0.1 && this._kickTimer <= 0 && ratio !== 0) {
      // Gear change: the revs travel to the new gear's speed over the rest of the shift and
      // arrive matched, so nothing steps when the clutch closes. An upshift cuts the
      // torque (throttle reads 0), a downshift blips the throttle to bring the revs up.
      const target = wheelRpm > eng.idle ? wheelRpm : eng.idle;
      const left = this._shiftTimer + h; // time the shift had left at the start of this step
      rpm = this.rpm + (target - this.rpm) * clamp(h / left, 0, 1);
      thr = this._shiftDir > 0 ? 0 : (drive > 0.5 ? drive : 0.5);
    } else if (clutchOpen) {
      // Free revving: the needle follows the pedal.
      const target = eng.idle + drive * (eng.redline * 0.92 - eng.idle);
      rpm = this.rpm + (target - this.rpm) * clamp(9 * h, 0, 1);
      thr = drive;
    } else {
      // Pulling away: the clutch slips so that the engine sits in its power band. It bites
      // progressively: the revs start below the launch speed and are pulled up to it as the
      // wheels catch up, instead of sitting on one note until the clutch locks.
      const firstGear = this.gear === 1 || this.gear === -1;
      const slipRpm = firstGear ? eng.idle + drive * (eng.launchRpm - eng.idle) : eng.idle;
      if (wheelRpm < slipRpm) {
        const rise = eng.launchRise || 0;
        const target = slipRpm - (slipRpm - wheelRpm) * rise;
        rpm = this.rpm + (target - this.rpm) * clamp(12 * h, 0, 1);
        engineT = this._engineTorque(rpm) * thr * boostGain;
      } else {
        locked = true;
        rpm = wheelRpm;
        engineT = this._engineTorque(rpm) * thr * boostGain;
        if (this._kickBurst > 0) engineT *= 1.5;
        // Rev limiter: fade the torque out over the last 100 rpm.
        engineT *= clamp((eng.redline + 50 - rpm) / 100, 0, 1);
        // Engine braking grows with revs and with a closed throttle, and fades out at idle.
        const eb = (eng.brakeBase + (eng.brakeSlope * rpm) / eng.redline) * (1 - thr);
        engineT -= eb * clamp((rpm - eng.idle) / 400, 0, 1);
      }
    }
    this.rpm = clamp(rpm, eng.idle * 0.9, eng.redline + 150);
    this.throttle = thr;
    this.brake = brake;

    // --- torques at the wheels ---
    const wheelT = clutchOpen ? 0 : engineT * ratio * spec.efficiency;
    const reflected = locked ? (eng.inertia * aRatio * aRatio) / this._nDriven : 0;
    const br = spec.brakes;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      this._driveT[i] = wheelT * this._driveShare[i];
      this._inertia[i] = spec.wheelInertia + (this._driveShare[i] > 0 ? reflected : 0);

      // ABS: release the brake on a wheel that is close to locking.
      const w = this.wheels[i];
      let absTarget = 1;
      if (aids.abs > 0 && brake > 0 && aSpeed > 2.5 && this._contact[i]) {
        const s = w.slipLong * (vLong < 0 ? 1 : -1);
        absTarget = clamp(1 - (s - aids.absSlip) / 0.1, 0.05, 1);
      }
      this._abs[i] = approach(this._abs[i], absTarget, (absTarget < this._abs[i] ? 40 : 12) * h);
      const share = front ? br.bias * 0.5 : (1 - br.bias) * 0.5;
      let bt = brake * br.torque * share * this._abs[i];
      if (!front) bt += inp.handbrake * br.handbrake * 0.5;
      this._brakeT[i] = bt;
    }
    // Limited slip differential on the rear axle: resists a speed difference left to right.
    if (!clutchOpen) {
      const t = clamp((this._omega[3] - this._omega[2]) * gb.lsd, -gb.lsdMax, gb.lsdMax);
      this._driveT[2] += t;
      this._driveT[3] -= t;
    }
  }

  /** One fixed substep: compute and apply all forces. Runs before the Rapier step. */
  _preStep(h) {
    this._copyPrev();
    const phys = this._phys;
    const spec = this.spec;
    const body = this.body;
    const inp = this._in;

    this._preV[0] = this.vel[0]; this._preV[1] = this.vel[1]; this._preV[2] = this.vel[2];
    if (this.recovering) {
      this._recoverStep(h);
      return;
    }

    // ---- parked: the body sleeps until the driver or a collision wakes it ----
    if (this._parked) {
      const wantsMove = inp.throttle > 0.02 || inp.brake > 0.02;
      // Rapier keeps simulating a sleeping body that touches an awake one (a traffic box
      // that has just been pushed against the car, say) and may still report it as asleep,
      // so the velocity is the reliable sign that the car has been disturbed.
      const lv = body.linvel(this._v3a);
      const disturbed = !body.isSleeping() || lv.x * lv.x + lv.y * lv.y + lv.z * lv.z > 1e-6;
      if (wantsMove || disturbed) {
        this._parked = false;
        this._parkTimer = 0;
        // After a disturbance wait longer before parking again, so that a car resting
        // against something that is still settling does not park and wake in a cycle.
        this._parkDelay = wantsMove ? PARK_DELAY : PARK_DELAY_DISTURBED;
        body.wakeUp();
      } else {
        this._updateSteering(h, 0, 0);
        this.rpm += (spec.engine.idle - this.rpm) * clamp(6 * h, 0, 1);
        this.throttle = 0;
        this.brake = 0;
        return;
      }
    }

    const px = this.pos[0], py = this.pos[1], pz = this.pos[2];
    const lx = this._lx, ly = this._ly, lz = this._lz;
    const ux = this._ux, uy = this._uy, uz = this._uz;
    const fx = this._fx, fy = this._fy, fz = this._fz;
    const vx = this.vel[0], vy = this.vel[1], vz = this.vel[2];
    const wx = this.angVel[0], wy = this.angVel[1], wz = this.angVel[2];
    // Centre of mass in world space. Rapier's linear velocity is the velocity of this point.
    const cx = px + lx * this._comX + ux * this._comY + fx * this._comZ;
    const cy = py + ly * this._comX + uy * this._comY + fy * this._comZ;
    const cz = pz + lz * this._comX + uz * this._comY + fz * this._comZ;

    // Velocity in the vehicle frame, and at the two axles.
    const vLong = vx * fx + vy * fy + vz * fz;
    const vLat = vx * lx + vy * ly + vz * lz;
    const yawRate = wx * ux + wy * uy + wz * uz;
    const zFront = this._hz[0] - this._comZ;
    const zRear = this._hz[2] - this._comZ;
    const vLatFront = vLat + yawRate * zFront;
    const vLatRear = vLat + yawRate * zRear;
    const aLong = vLong < 0 ? -vLong : vLong;
    const rearSlipAngle = Math.atan2(vLatRear, aLong > 3 ? aLong : 3);

    // The fallback ground plane only exists for this car where no tile is loaded.
    const onFallback = !phys._hasTileAt(px, pz);
    if (onFallback !== this._onFallback) {
      this._onFallback = onFallback;
      const groups = onFallback ? phys._groups.vehicle : phys._groups.vehicleNoFallback;
      for (let i = 0; i < this._colliders.length; i++) this._colliders[i].setCollisionGroups(groups);
    }
    const rayGroups = onFallback ? phys._groups.wheelRay : phys._groups.wheelRayNoFallback;
    const sampler = phys._surfaceSampler;
    this._sampleIdx = (this._sampleIdx + 1) & 3;

    // ---- 1. suspension rays ----
    const susp = spec.suspension;
    let contacts = 0;
    let nxSum = 0, nySum = 0, nzSum = 0;
    for (let i = 0; i < 4; i++) {
      const hx = this._hx[i], hy = this._hy[i], hz = this._hz[i];
      const ox = px + lx * hx + ux * hy + fx * hz;
      const oy = py + ly * hx + uy * hy + fy * hz;
      const oz = pz + lz * hx + uz * hy + fz * hz;
      const r = this._radius[i];
      const maxDist = susp.restLength + r;
      const w = this.wheels[i];
      if (phys._castGround(ox, oy, oz, -ux, -uy, -uz, maxDist, rayGroups)) {
        const hit = phys._groundHit;
        let len = hit.dist - r;
        if (len < 0) len = 0;
        this._contact[i] = 1;
        this._comp[i] = susp.restLength - len;
        const j = i * 3;
        this._cp[j] = ox - ux * hit.dist;
        this._cp[j + 1] = oy - uy * hit.dist;
        this._cp[j + 2] = oz - uz * hit.dist;
        this._cn[j] = hit.nx;
        this._cn[j + 1] = hit.ny;
        this._cn[j + 2] = hit.nz;
        nxSum += hit.nx; nySum += hit.ny; nzSum += hit.nz;
        contacts++;
        // What the tyre stands on. Terrain carries no surface of its own: the game's
        // sampler says what is there (asked for one wheel per substep, the answer is kept).
        let kind = hit.kind;
        if (hit.terrain && sampler) {
          if (i === this._sampleIdx) this._sampled[i] = sampler(this._cp[j], this._cp[j + 2]);
          kind = this._sampled[i];
        }
        this._surf[i] = kind;
        w.suspLen = len;
        w.contact = true;
        w.surfaceKind = kind;
        w.surfaceY = this._cp[j + 1];
      } else {
        this._contact[i] = 0;
        this._comp[i] = 0;
        this._load[i] = 0;
        // The wheel drops to full droop, at a finite speed so it does not snap visually.
        w.suspLen = approach(w.suspLen, susp.restLength, 2.5 * h);
        w.contact = false;
      }
    }
    this._contacts = contacts;
    this.onGround = contacts >= 2;
    this.airborne = contacts === 0;
    this.inWater = py < phys.seaLevel - 0.5;

    // Reference "up" for roll and pitch: the ground under the wheels, or the sky when airborne.
    {
      let tx = 0, ty = 1, tz = 0;
      if (contacts >= 3) {
        const inv = 1 / Math.sqrt(nxSum * nxSum + nySum * nySum + nzSum * nzSum);
        tx = nxSum * inv; ty = nySum * inv; tz = nzSum * inv;
      }
      const a = clamp(10 * h, 0, 1);
      this._gnx += (tx - this._gnx) * a;
      this._gny += (ty - this._gny) * a;
      this._gnz += (tz - this._gnz) * a;
      const inv = 1 / Math.sqrt(this._gnx * this._gnx + this._gny * this._gny + this._gnz * this._gnz);
      this._gnx *= inv; this._gny *= inv; this._gnz *= inv;
    }

    // ---- 2. driver, drivetrain ----
    this._updateSteering(h, vLong, vLatFront);
    this._updateDrivetrain(h, vLong, Math.sqrt(vLong * vLong + vLat * vLat), rearSlipAngle);

    // Force and torque accumulators (world frame, torque about the centre of mass).
    let Fx = 0, Fy = 0, Fz = 0, Tx = 0, Ty = 0, Tz = 0;

    // ---- 3. suspension forces with anti-roll bars ----
    for (let i = 0; i < 4; i++) {
      if (!this._contact[i]) continue;
      const j = i * 3;
      const nx = this._cn[j], ny = this._cn[j + 1], nz = this._cn[j + 2];
      const rx = this._cp[j] - cx, ry = this._cp[j + 1] - cy, rz = this._cp[j + 2] - cz;
      // Velocity of the contact point of the chassis along the ground normal.
      // Negative means the body is moving into the ground: the spring is compressing.
      const pvx = vx + wy * rz - wz * ry;
      const pvy = vy + wz * rx - wx * rz;
      const pvz = vz + wx * ry - wy * rx;
      const vn = pvx * nx + pvy * ny + pvz * nz;
      const comp = this._comp[i];
      let f = this._k[i] * comp - (vn < 0 ? this._cBump[i] : this._cReb[i]) * vn;
      if (comp > susp.travel) f += this._k[i] * susp.bumpStop * (comp - susp.travel);
      // Anti-roll bar: load moves from the extended side to the compressed side.
      const other = i ^ 1;
      const otherComp = this._contact[other] ? this._comp[other] : 0;
      f += (i < 2 ? this._arbF : this._arbR) * (comp - otherComp);
      f = clamp(f, 0, this._staticLoad[i] * susp.maxForce);
      this._load[i] = f;
      const sx = nx * f, sy = ny * f, sz = nz * f;
      Fx += sx; Fy += sy; Fz += sz;
      Tx += ry * sz - rz * sy;
      Ty += rz * sx - rx * sz;
      Tz += rx * sy - ry * sx;
    }

    // ---- 4. tyres and wheel spin ----
    const tyre = spec.tyre;
    const grip = phys._grip;
    const kp = tyre.peakSlipRatio, ap = this._tyreAp, cB = this._tyreB, cC = this._tyreC;
    const cosS = Math.cos(this._steerAngle), sinS = Math.sin(this._steerAngle);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const r = this._radius[i];
      const inertia = this._inertia[i];
      const driveT = this._driveT[i];
      const brakeT = this._brakeT[i];
      let omega = this._omega[i];
      if (!this._contact[i]) {
        // Free wheel: drive and brake torque only.
        const dir = omega > 0.01 ? 1 : omega < -0.01 ? -1 : 0;
        let wn = omega + (h * (driveT - brakeT * dir)) / inertia;
        if (brakeT > 0 && (dir === 0 ? brakeT >= Math.abs(driveT) : wn * dir < 0)) wn = 0;
        wn = clamp(wn, -400, 400);
        this._omega[i] = wn;
        w.spin += wn * h;
        w.angVel = wn;
        w.slipLong = 0;
        w.slipLat = 0;
        this._wheelWorldPos(i, w.suspLen);
        continue;
      }
      const j = i * 3;
      const nx = this._cn[j], ny = this._cn[j + 1], nz = this._cn[j + 2];
      // Wheel heading: the vehicle's forward axis turned by the steer angle (front wheels),
      // projected onto the ground plane. Side = normal x heading, which points left.
      let hx, hy, hz;
      if (i < 2) {
        hx = fx * cosS + lx * sinS; hy = fy * cosS + ly * sinS; hz = fz * cosS + lz * sinS;
      } else {
        hx = fx; hy = fy; hz = fz;
      }
      const hn = hx * nx + hy * ny + hz * nz;
      hx -= nx * hn; hy -= ny * hn; hz -= nz * hn;
      const hInv = 1 / Math.sqrt(hx * hx + hy * hy + hz * hz);
      hx *= hInv; hy *= hInv; hz *= hInv;
      const sx = ny * hz - nz * hy, sy = nz * hx - nx * hz, sz = nx * hy - ny * hx;
      // Contact patch velocity.
      const rx = this._cp[j] - cx, ry = this._cp[j + 1] - cy, rz = this._cp[j + 2] - cz;
      const pvx = vx + wy * rz - wz * ry;
      const pvy = vy + wz * rx - wx * rz;
      const pvz = vz + wx * ry - wy * rx;
      const pLong = pvx * hx + pvy * hy + pvz * hz;
      const pLat = pvx * sx + pvy * sy + pvz * sz;
      const load = this._load[i];
      const surface = SURFACES[this._surf[i]];
      // Slightly less grip per newton on a heavily loaded tyre (load sensitivity).
      const rel = load / this._staticLoad[i] - 1;
      const mu = this._mu[i] * surface.grip * grip * clamp(1 - tyre.loadSensitivity * rel, 0.75, 1.1);

      // Wheel spin, integrated implicitly: the tyre force reacts so strongly to wheel speed
      // that an explicit step would oscillate. Linearise the force around the current speed.
      tyreForce(pLong, pLat, omega * r, load, mu, kp, ap, cB, cC);
      const f0 = TYRE[0];
      tyreForce(pLong, pLat, (omega + 0.5) * r, load, mu, kp, ap, cB, cC);
      let slope = (TYRE[0] - f0) / 0.5;
      if (slope < 0) slope = 0;
      const dir = omega > 0.01 ? 1 : omega < -0.01 ? -1 : pLong > 0.05 ? 1 : pLong < -0.05 ? -1 : 0;
      const torque = driveT - brakeT * dir;
      let wn = omega + (h * (torque - f0 * r)) / (inertia + h * r * slope);
      // A tyre that is sliding has no slope left, so the step above is an explicit one, and
      // at low road speed it can throw the wheel right across its rolling speed into the
      // opposite slide, and back again on the next step: a spinning wheel that never hooks
      // up. When a step crosses the rolling speed, the rest of it is redone from there,
      // where the tyre is stiff, so the wheel is caught instead.
      const roll = pLong / r;
      if ((omega - roll) * (wn - roll) < 0) {
        const rest = h * (wn - roll) / (wn - omega);
        tyreForce(pLong, pLat, pLong, load, mu, kp, ap, cB, cC);
        const fr = TYRE[0];
        tyreForce(pLong, pLat, pLong + (wn > roll ? 0.5 : -0.5) * r, load, mu, kp, ap, cB, cC);
        let grip0 = (TYRE[0] - fr) / (wn > roll ? 0.5 : -0.5);
        if (grip0 < 0) grip0 = 0;
        wn = roll + (rest * (torque - fr * r)) / (inertia + rest * r * grip0);
      }
      // A brake can stop a wheel but never spin it backwards.
      if (brakeT > 0 && (dir === 0 ? brakeT >= Math.abs(driveT) : wn * dir < 0)) wn = 0;
      wn = clamp(wn, -400, 400);
      this._omega[i] = wn;
      w.spin += wn * h;
      w.angVel = wn;

      // Final forces at the new wheel speed.
      tyreForce(pLong, pLat, wn * r, load, mu, kp, ap, cB, cC);
      w.slipLong = TYRE[2];
      w.slipLat = Math.atan(TYRE[3]);
      w.load = load;
      // Rolling resistance acts on the body directly.
      const fLong = TYRE[0] - surface.roll * load * clamp(pLong, -1, 1);
      const fLat = TYRE[1];
      const tfx = hx * fLong + sx * fLat;
      const tfy = hy * fLong + sy * fLat;
      const tfz = hz * fLong + sz * fLat;
      // Apply a little above the road: a lower roll and pitch moment.
      const ax = rx + nx * tyre.forceHeight, ay = ry + ny * tyre.forceHeight, az = rz + nz * tyre.forceHeight;
      Fx += tfx; Fy += tfy; Fz += tfz;
      Tx += ay * tfz - az * tfy;
      Ty += az * tfx - ax * tfz;
      Tz += ax * tfy - ay * tfx;
      this._wheelWorldPos(i, w.suspLen);
    }

    // ---- 5. aerodynamics ----
    {
      const aero = spec.aero;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const kd = 0.5 * AIR_DENSITY * aero.cdA * sp;
      Fx -= kd * vx; Fy -= kd * vy; Fz -= kd * vz;
      if (aero.clA > 0 && contacts > 0) {
        const down = 0.5 * AIR_DENSITY * aero.clA * vLong * vLong;
        // Acts on the centre line, at the height of the centre of mass.
        const z = this._hz[2] + (this._hz[0] - this._hz[2]) * aero.balance - this._comZ;
        const dx = -ux * down, dy = -uy * down, dz = -uz * down;
        const rx = fx * z, ry = fy * z, rz = fz * z;
        Fx += dx; Fy += dy; Fz += dz;
        Tx += ry * dz - rz * dy;
        Ty += rz * dx - rx * dz;
        Tz += rx * dy - ry * dx;
      }
    }

    if (this.inWater) {
      const k = spec.mass * WATER_DRAG;
      Fx -= k * vx; Fy -= k * vy; Fz -= k * vz;
    }

    // ---- 6. staying upright ----
    const stab = spec.stability;
    const I = spec.inertia;
    const gnx = this._gnx, gny = this._gny, gnz = this._gnz;
    const roll = Math.asin(clamp(lx * gnx + ly * gny + lz * gnz, -1, 1)); // positive: left side up
    const pitch = Math.asin(clamp(fx * gnx + fy * gny + fz * gnz, -1, 1)); // positive: nose up
    const rollRate = wx * fx + wy * fy + wz * fz; // about the forward axis
    const pitchRate = wx * lx + wy * ly + wz * lz; // about the left axis, positive: nose going down
    let tRoll = 0, tPitch = 0, tYaw = 0;
    if (contacts === 0) {
      // Airborne: level the car so that it lands on its wheels, and fall a bit faster
      // than real gravity so that crests give a short hop instead of a long flight.
      tRoll = -I[2] * (stab.airStiffness * roll + stab.airDamping * rollRate);
      tPitch = I[0] * (stab.airStiffness * pitch - stab.airDamping * pitchRate);
      tYaw = -I[1] * 1.5 * yawRate;
      Fy -= spec.mass * G * stab.airGravity;
    } else {
      // On the ground: nothing until roll or pitch leave their normal range, then a
      // firm spring and damper pull the body back.
      const rollEx = roll > stab.rollLimit ? roll - stab.rollLimit : roll < -stab.rollLimit ? roll + stab.rollLimit : 0;
      const pitchEx = pitch > stab.pitchLimit ? pitch - stab.pitchLimit : pitch < -stab.pitchLimit ? pitch + stab.pitchLimit : 0;
      if (rollEx !== 0) tRoll = -I[2] * (stab.uprightStiffness * rollEx + stab.uprightDamping * rollRate);
      if (pitchEx !== 0) tPitch = I[0] * (stab.uprightStiffness * pitchEx - stab.uprightDamping * pitchRate);
    }
    // Yaw assist: when the rear slides further than allowed, turn the car back toward
    // its direction of travel. This is what keeps keyboard steering from spinning the car.
    // The allowance is small in normal driving, wide in a drift, widest with the handbrake on.
    const aids = spec.aids;
    const slipRate = (rearSlipAngle - this._prevSlipAngle) / h;
    this._prevSlipAngle = rearSlipAngle;
    const hSpeed = Math.sqrt(vLong * vLong + vLat * vLat);
    if (aids.stability > 0 && hSpeed > 5 && (this._contact[2] || this._contact[3])) {
      let limit = inp.handbrake > 0.1 ? aids.handbrakeAngle : this.drifting ? aids.driftAngle : aids.slideAngle;
      // A car may be given a wide allowance for slow corners and a narrow one at speed.
      if (aids.slideAngleFast !== undefined && inp.handbrake <= 0.1 && !this.drifting) {
        limit += (aids.slideAngleFast - limit) * clamp((hSpeed - aids.slideFadeFrom) / (aids.slideFadeTo - aids.slideFadeFrom), 0, 1);
      }
      const ex = rearSlipAngle > limit ? rearSlipAngle - limit : rearSlipAngle < -limit ? rearSlipAngle + limit : 0;
      const sign = vLong < 0 ? -1 : 1;
      let acc = 0;
      if (ex !== 0) acc = clamp(ex * 22 * sign - yawRate * 1.2, -7, 7);
      // A slide that collapses quickly ends in a snap the other way (a tank slapper).
      // Slow the return down so that the tail comes back in line gently.
      const collapsing = rearSlipAngle * slipRate < 0 && Math.abs(rearSlipAngle) > 0.05;
      if (inp.handbrake < 0.1 && (this.drifting || collapsing)) {
        acc += clamp(slipRate * aids.snapDamping, -5, 5) * sign;
      }
      tYaw += I[1] * acc * aids.stability * clamp((hSpeed - 5) / 5, 0, 1);
    }
    Tx += fx * tRoll + lx * tPitch + ux * tYaw;
    Ty += fy * tRoll + ly * tPitch + uy * tYaw;
    Tz += fz * tRoll + lz * tPitch + uz * tYaw;

    // ---- 7. hand everything to Rapier ----
    // As a force, not an impulse: Rapier then integrates it inside its solver substeps
    // together with gravity, so a car at rest has exactly zero velocity.
    const v3 = this._v3a;
    body.resetForces(false);
    body.resetTorques(false);
    v3.x = Fx; v3.y = Fy; v3.z = Fz;
    phys._addForce(body, v3, true);
    v3.x = Tx; v3.y = Ty; v3.z = Tz;
    phys._addTorque(body, v3, true);

    // ---- 8. safety clamps: no physics state is allowed to run away ----
    let cvx = vx, cvy = vy, cvz = vz;
    let changed = false;
    if (!(cvx === cvx && cvy === cvy && cvz === cvz)) {
      cvx = 0; cvy = 0; cvz = 0;
      changed = true;
    }
    const sp2 = cvx * cvx + cvy * cvy + cvz * cvz;
    if (sp2 > stab.maxSpeed * stab.maxSpeed) {
      const k = stab.maxSpeed / Math.sqrt(sp2);
      cvx *= k; cvy *= k; cvz *= k;
      changed = true;
    }
    if (cvy > stab.maxRiseSpeed) {
      cvy = stab.maxRiseSpeed;
      changed = true;
    }
    if (changed) {
      v3.x = cvx; v3.y = cvy; v3.z = cvz;
      phys._setLinvel(body, v3, true);
    }
    const badSpin = !(wx === wx && wy === wy && wz === wz);
    const cRoll = clamp(rollRate, -stab.maxRollRate, stab.maxRollRate);
    const cPitch = clamp(pitchRate, -stab.maxRollRate, stab.maxRollRate);
    const cYaw = clamp(yawRate, -stab.maxYawRate, stab.maxYawRate);
    if (badSpin) {
      v3.x = 0; v3.y = 0; v3.z = 0;
      phys._setAngvel(body, v3, true);
    } else if (cRoll !== rollRate || cPitch !== pitchRate || cYaw !== yawRate) {
      v3.x = fx * cRoll + lx * cPitch + ux * cYaw;
      v3.y = fy * cRoll + ly * cPitch + uy * cYaw;
      v3.z = fz * cRoll + lz * cPitch + uz * cYaw;
      phys._setAngvel(body, v3, true);
    }

    // ---- 9. parking: a stopped car with no input goes to sleep, so it cannot creep ----
    const still = contacts === 4 && aLong < 0.06 && (vLat < 0 ? -vLat : vLat) < 0.06 &&
      (vy < 0 ? -vy : vy) < 0.03 && wx * wx + wy * wy + wz * wz < 0.0004 &&
      inp.throttle < 0.02 && inp.brake < 0.02;
    if (still) {
      this._parkTimer += h;
      if (this._parkTimer > this._parkDelay) {
        this._parked = true;
        this._omega.fill(0);
        for (let i = 0; i < 4; i++) {
          this.wheels[i].slipLong = 0;
          this.wheels[i].slipLat = 0;
          this.wheels[i].angVel = 0;
        }
        body.resetForces(false);
        body.resetTorques(false);
        body.sleep();
        // Rapier still integrates a sleeping body while an awake one rests against it.
        // Holding the weight means that the car stays put in that case too.
        const v = this._v3a;
        v.x = 0; v.y = -phys.gravity * body.mass(); v.z = 0;
        phys._addForce(body, v, false);
      }
    } else {
      this._parkTimer = 0;
    }
  }

  /** Runs after the Rapier step: read back the pose, update derived state, watch for trouble. */
  _postStep(h) {
    const ovx = this.vel[0], ovy = this.vel[1], ovz = this.vel[2];
    this._readPose();
    if (this.recovering) return;
    if (this._impactCooldown > 0) this._impactCooldown -= h;

    // g forces from the change of velocity over the substep, in the vehicle frame, smoothed.
    if (!this._parked) {
      const ax = (this.vel[0] - ovx) / h, ay = (this.vel[1] - ovy) / h, az = (this.vel[2] - ovz) / h;
      const lat = (ax * this._lx + ay * this._ly + az * this._lz) / G;
      const lon = (ax * this._fx + ay * this._fy + az * this._fz) / G;
      const a = clamp(12 * h, 0, 1);
      this._gLat += (clamp(lat, -6, 6) - this._gLat) * a;
      this._gLong += (clamp(lon, -6, 6) - this._gLong) * a;
    } else {
      this._gLat *= 0.9;
      this._gLong *= 0.9;
    }
    this.gForce[0] = this._gLat;
    this.gForce[1] = this._gLong;

    // ---- auto recover ----
    const p = this.pos;
    const bad = !(p[0] === p[0] && p[1] === p[1] && p[2] === p[2] && this.quat[3] === this.quat[3]);
    const below = p[1] < this._phys._killY;
    const stab = this.spec.stability;
    if (this._uy < Math.cos(stab.recoverAngle)) this._tiltTimer += h;
    else this._tiltTimer = 0;
    if (bad || below || this._tiltTimer > 0.6) {
      this._beginRecover(bad || below);
      return;
    }
    // Remember the last place where the car stood properly on four wheels.
    this._safeTimer += h;
    if (this._safeTimer > 0.5 && this._contacts === 4 && this._uy > 0.95 && !this.inWater) {
      this._safeTimer = 0;
      this._safe[0] = p[0]; this._safe[1] = p[1]; this._safe[2] = p[2]; this._safe[3] = this.yaw;
      this._hasSafe = true;
    }
  }

  /**
   * Starts the auto recover. Normally the car is righted where it is. If it left the
   * world (below the kill height or a broken state) it goes back to the last safe spot.
   */
  _beginRecover(lost) {
    const phys = this._phys;
    this.recovering = true;
    this._recoverT = 0;
    this._tiltTimer = 0;
    this._parked = false;
    let x = this.pos[0], y = this.pos[1], z = this.pos[2], yaw = this.yaw;
    if (lost || !(yaw === yaw)) {
      if (this._hasSafe) {
        x = this._safe[0]; y = this._safe[1]; z = this._safe[2]; yaw = this._safe[3];
      } else {
        x = x === x ? x : 0; z = z === z ? z : 0; y = phys._groundY; yaw = 0;
      }
      // A real jump in position: tell the renderer not to interpolate across it.
      const v = this._v3a;
      v.x = x; v.y = y + 0.3; v.z = z;
      this.body.setTranslation(v, true);
      const q = this._q;
      q.x = 0; q.y = Math.sin(yaw / 2); q.z = 0; q.w = Math.cos(yaw / 2);
      this.body.setRotation(q, true);
      this._readPose();
      this._copyPrev();
    } else if (phys._castGround(x, y + 1.5, z, 0, -1, 0, 30, phys._groups.wheelRay)) {
      // Find the ground under the car, the righted car will be set down on it.
      y = y + 1.5 - phys._groundHit.dist;
    }
    this.body.resetForces(false);
    this.body.resetTorques(false);
    this._recX = x; this._recY = y; this._recZ = z; this._recYaw = yaw;
    this._omega.fill(0);
  }

  /** While recovering, the car is moved kinematically: eased upright over about a second. */
  _recoverStep(h) {
    const body = this.body;
    this._recoverT += h;
    const a = clamp(5 * h, 0, 1);
    // Blend the rotation toward "upright, same heading" (normalised lerp, shortest way).
    const ty = Math.sin(this._recYaw / 2), tw = Math.cos(this._recYaw / 2);
    const q = this._q;
    const cq = this.quat;
    const dot = cq[1] * ty + cq[3] * tw;
    const sgn = dot < 0 ? -1 : 1;
    q.x = cq[0] * (1 - a);
    q.y = cq[1] + (ty * sgn - cq[1]) * a;
    q.z = cq[2] * (1 - a);
    q.w = cq[3] + (tw * sgn - cq[3]) * a;
    const inv = 1 / Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    q.x *= inv; q.y *= inv; q.z *= inv; q.w *= inv;
    body.setRotation(q, true);
    const v = this._v3a;
    v.x = this.pos[0] + (this._recX - this.pos[0]) * a;
    v.y = this.pos[1] + (this._recY + 0.05 - this.pos[1]) * a;
    v.z = this.pos[2] + (this._recZ - this.pos[2]) * a;
    body.setTranslation(v, true);
    v.x = 0; v.y = 0; v.z = 0;
    body.setLinvel(v, true);
    body.setAngvel(v, true);
    this.throttle = 0;
    this.brake = 0;
    this.rpm += (this.spec.engine.idle - this.rpm) * a;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.contact = false; w.slipLong = 0; w.slipLat = 0; w.angVel = 0;
      this._wheelWorldPos(i, w.suspLen);
    }
    // Done when upright and close to the set-down height, or after a time limit.
    const upright = q.x * q.x + q.z * q.z < 0.0004;
    if ((upright && Math.abs(this.pos[1] - this._recY - 0.05) < 0.05 && this._recoverT > 0.5) || this._recoverT > 2.5) {
      this.recovering = false;
      this.gear = 1;
      this._gnx = 0; this._gny = 1; this._gnz = 0;
    }
  }
}
