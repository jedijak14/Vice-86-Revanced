// The game camera: chase, bonnet, orbit (title screen) and free.
//
// Everything that eases (heading, arm length, height, field of view) is a critically damped
// spring integrated in closed form, so the camera behaves the same at 20 frames per second
// as at 240 and can never oscillate or blow up on a long frame.
//
// The chase camera sits on an arm behind a pivot above the car. The arm follows the car's
// heading, leans a little towards the direction of travel so that a slide reads as a slide,
// lengthens with speed and under acceleration, and is shortened by a ray cast when a building
// would come between the camera and the car. Mode changes and the rear view are cuts: the
// camera sets `cut` for one frame so the renderer drops its history instead of smearing.

import { clamp, lerp, smoothstep, angleDelta, quatRotate, m4lookAt, DEG, TAU } from '../core/math.js';

export const CAMERA_MODES = Object.freeze(['chase', 'bonnet', 'orbit', 'free', 'garage']);
/** Modes the player cycles through with the camera key. */
const PLAYER_MODES = ['chase', 'bonnet'];

// Chase arm.
// The lens is that of a camera car, not of a toy: about 28 mm (full frame) at rest, opening
// to about 24 mm at speed. The camera rides above roof height and looks down at the road a
// few metres ahead of the car, so that the car's whole upper side is in the picture, the car
// sits at about a quarter of the frame's width and the horizon in the upper third.
const ARM_LENGTH = 7.0, ARM_LENGTH_FAST = 7.5; // m behind the pivot at rest and at speed
const ARM_HEIGHT = 2.35, ARM_HEIGHT_FAST = 2.0; // m above the car's ground point
const PIVOT_HEIGHT = 1.0;
const TARGET_HEIGHT = 0.5; // m above the car's ground point of the point looked at
const FAST_SPEED = 70; // m/s at which the "fast" values are reached
const HEADING_RATE = 5.2; // 1/s: how tightly the arm follows the car's heading
const HEADING_RATE_FAST = 7.5;
const SLIDE_SHARE = 0.4; // how far the arm leans from the heading towards the direction of travel
const SLIDE_LIMIT = 0.45; // rad
const TURN_LEAD = 0.2; // s of yaw rate by which the view leads into a bend
const TURN_LEAD_LIMIT = 0.28; // rad
const LOOK_AHEAD = 1.6, LOOK_AHEAD_PER_SPEED = 0.07; // m, and m per m/s
const SURGE_GAIN = 0.045; // m of arm per m/s^2 of acceleration
const SURGE_LIMIT = 0.7;
const FOV_REST = 46 * DEG, FOV_FAST = 53 * DEG;
const BONNET_FOV_REST = 48 * DEG, BONNET_FOV_FAST = 62 * DEG;
const BONNET_DROP = 1.6; // m the aim falls over 20 m: enough to keep the falling nose of a wedge in the frame
// The camera car leans in a bend as the car it follows does: the horizon tilts a little.
const ROLL_PER_ACCEL = 0.0027; // rad per m/s^2 of lateral acceleration (1.5 degrees at 1 g)
const ROLL_LIMIT = 2 * DEG;
const MIN_ARM = 1.3; // m: the closest the camera is ever pulled in
const WALL_MARGIN = 0.35; // m kept between the camera and what it would hit
const PROBE_SIDE = 0.45; // m: the side probes keep the near plane out of a wall at a corner
const GROUND_CLEARANCE = 0.45;
const ARM_RECOVER_RATE = 2.2; // 1/s: how fast the arm grows back after an obstruction

// Reverse view.
const REVERSE_SPEED = 1.5, REVERSE_ENTER = 0.45, REVERSE_LEAVE = 0.3; // m/s, seconds

// Shake.
const TRAUMA_DECAY = 1.5; // per second
const SHAKE_ANGLE = 0.022; // rad at full trauma
const SHAKE_SHIFT = 0.07; // m
const ROUGH_ANGLE = 0.0045, ROUGH_SHIFT = 0.018;

// Nitrous: the view widens, the car pulls away from the camera a little, and the picture buzzes.
const BOOST_FOV = 4 * DEG, BOOST_ARM = 0.45; // rad and m at full boost
const BOOST_SHAKE_ANGLE = 0.0022, BOOST_SHAKE_SHIFT = 0.008;
const BOOST_SHAKE_PACE = 1.5; // times the pace of the impact shake: a buzz of 4 to 10 Hz, which a 60 Hz display can still show

// Orbit (title screen). The title car parks kerbside with the lit strip across the street on its left, so the camera
// does not circle: it swings slowly through the front three-quarter on the car's right, at headlamp height, and the
// strip stays behind the car for the whole sweep instead of giving way to the empty beach half the time.
const ORBIT_RADIUS = 7.4, ORBIT_HEIGHT = 0.95, ORBIT_PERIOD = 52, ORBIT_FOV = 38 * DEG;
const ORBIT_CENTRE = -1.0, ORBIT_SWING = 0.3; // rad: camera bearing from the nose (negative = car's right), and the swing either side
const ORBIT_SHIFT = 1.4; // m the aim point sits to the camera's left of the car, so that the car clears the title menu on the left

/** One step of a critically damped spring towards `target`. `state` is { x, v }. */
function spring(state, target, rate, dt) {
  const e = Math.exp(-rate * dt);
  const d = state.x - target;
  const t = (state.v + rate * d) * dt;
  state.x = target + (d + t) * e;
  state.v = (state.v - rate * t) * e;
  return state.x;
}

/** The same for an angle: takes the short way round. */
function springAngle(state, target, rate, dt) {
  const goal = state.x + angleDelta(state.x, target);
  return spring(state, goal, rate, dt);
}

/** Smooth pseudo-random signal in -1..1 for the shake: three sines that never line up. */
const wobble = (t, k) => (Math.sin(t * (17.3 + k * 3.1) + k * 1.7) + Math.sin(t * (29.7 + k * 4.3) + k * 4.1) * 0.6 + Math.sin(t * (43.1 + k * 2.3) + k) * 0.35) / 1.95;

const UP = [0, 1, 0];

/**
 * @param {{
 *   obstruction?: (origin: number[], direction: number[], maxDistance: number) => number,
 * }} [options]
 *   obstruction: distance along a unit direction to the first thing the camera must not pass
 *   (buildings, walls, the ground), or `maxDistance` if the way is clear.
 */
export function createCamera({ obstruction = null } = {}) {
  const heading = { x: 0, v: 0 };
  const arm = { x: ARM_LENGTH, v: 0 };
  const height = { x: ARM_HEIGHT, v: 0 };
  const pivotY = { x: 0, v: 0 };
  const pitch = { x: 0, v: 0 };
  const surge = { x: 0, v: 0 };
  const fov = { x: FOV_REST, v: 0 };
  const lead = { x: 0, v: 0 };
  const roll = { x: 0, v: 0 };
  let free = 1e9; // arm length the last obstruction test allowed
  let lastSpeed = 0;
  let reverseTimer = 0;
  let rearView = false;
  let orbitPhase = 0;
  let trauma = 0;
  let clock = 0;
  let hasPrevious = false;
  let pendingCut = true;

  const pivot = [0, 0, 0];
  const back = [0, 0, 0];
  const probe = [0, 0, 0];
  const forward = [0, 0, 1];
  const carUp = [0, 1, 0];
  const up = [0, 1, 0];
  const local = [0, 0, 0];
  const previous = [0, 0, 0];

  const camera = {
    position: [0, 5, -8],
    target: [0, 1, 0],
    /** Unit view direction. */
    forward: [0, 0, 1],
    velocity: [0, 0, 0],
    view: new Float32Array(16),
    fovY: FOV_REST,
    near: 0.3,
    far: 6000,
    /** True for the one frame that does not continue the previous one. */
    cut: true,
    mode: 'chase',

    /**
     * Switches mode with a cut.
     * @param {string} mode  'chase' | 'bonnet' | 'orbit' | 'free' | 'garage' (placed each frame
     *        by the garage's rig through `place`)
     * @param {{position?: number[], target?: number[], fov?: number}} [pose]  for 'free': where
     *        the camera stands and what it looks at; without it the camera stays where it is
     * @returns {boolean} false if the mode does not exist
     */
    setMode(mode, pose) {
      if (!CAMERA_MODES.includes(mode)) return false;
      camera.mode = mode;
      pendingCut = true;
      if (mode === 'free' && pose) {
        if (pose.position) { camera.position[0] = pose.position[0]; camera.position[1] = pose.position[1]; camera.position[2] = pose.position[2]; }
        if (pose.target) { camera.target[0] = pose.target[0]; camera.target[1] = pose.target[1]; camera.target[2] = pose.target[2]; }
        if (pose.fov > 0) fov.x = pose.fov * DEG;
      }
      return true;
    },

    /**
     * Where a camera that does not follow the car stands ('garage' and 'free'): eye, aim point
     * and vertical field of view in radians. No cut: call `snap` for one.
     */
    place(position, target, fovY) {
      camera.position[0] = position[0]; camera.position[1] = position[1]; camera.position[2] = position[2];
      camera.target[0] = target[0]; camera.target[1] = target[1]; camera.target[2] = target[2];
      fov.x = fovY;
    },

    /** The camera key: chase, bonnet, chase, ... Returns the new mode. */
    nextMode() {
      const i = PLAYER_MODES.indexOf(camera.mode);
      camera.setMode(PLAYER_MODES[(i + 1) % PLAYER_MODES.length]);
      return camera.mode;
    },

    /** Adds shake: 0..1, from impacts and landings. */
    addTrauma(amount) {
      trauma = Math.min(1, trauma + amount);
    },

    /** The next frame starts from the ideal pose instead of easing to it (after a teleport). */
    snap() {
      pendingCut = true;
    },

    /**
     * @param {number} dt  frame time, seconds
     * @param {{
     *   pos: number[], quat: number[], yaw: number, vel: number[], forwardSpeed: number, yawRate: number,
     *   lookBack: boolean, roughness: number, bonnet: number[]|null, length: number, height: number,
     *   boost?: number,
     * }} subject  the car at render time. forwardSpeed is signed; roughness 0..1 is how rough
     *   the surface under the wheels is at this speed; bonnet is the bonnet camera anchor in
     *   the vehicle frame; boost 0..1 is the nitrous flow.
     */
    update(dt, subject) {
      clock += dt;
      trauma = Math.max(0, trauma - TRAUMA_DECAY * dt);
      const speed = Math.abs(subject.forwardSpeed);
      const fast = smoothstep(0, FAST_SPEED, speed);
      const boost = subject.boost || 0;

      // Rear view: held on request, and after reversing for a moment.
      if (subject.forwardSpeed < -REVERSE_SPEED) reverseTimer = Math.min(REVERSE_ENTER, Math.max(0, reverseTimer) + dt);
      else if (subject.forwardSpeed > -0.3) reverseTimer = Math.max(-REVERSE_LEAVE, Math.min(0, reverseTimer) - dt);
      const wantRear = subject.lookBack || (rearView ? reverseTimer > -REVERSE_LEAVE : reverseTimer >= REVERSE_ENTER);
      if (wantRear !== rearView && (camera.mode === 'chase' || camera.mode === 'bonnet')) pendingCut = true;
      rearView = wantRear;

      const cut = pendingCut;
      pendingCut = false;
      quatRotate(forward, subject.quat, FORWARD);
      quatRotate(carUp, subject.quat, UP);

      if (camera.mode === 'chase') updateChase(dt, subject, speed, fast, boost, cut);
      else if (camera.mode === 'bonnet') updateBonnet(dt, subject, fast, boost, cut);
      else if (camera.mode === 'orbit') updateOrbit(dt, subject, cut);
      else { up[0] = 0; up[1] = 1; up[2] = 0; camera.fovY = fov.x; }

      // Shake turns the view, and shifts it a little, around the pose computed above.
      const rough = subject.roughness || 0;
      const shake = trauma * trauma;
      const angle = shake * SHAKE_ANGLE + rough * ROUGH_ANGLE;
      const shift = shake * SHAKE_SHIFT + rough * ROUGH_SHIFT;
      if (angle > 0 && camera.mode !== 'free' && camera.mode !== 'garage') {
        const reach = Math.hypot(camera.target[0] - camera.position[0], camera.target[1] - camera.position[1], camera.target[2] - camera.position[2]);
        camera.target[0] += wobble(clock, 1) * angle * reach;
        camera.target[1] += wobble(clock, 2) * angle * reach;
        camera.target[2] += wobble(clock, 3) * angle * reach;
        camera.position[1] += wobble(clock, 4) * shift;
      }
      if (boost > 0 && (camera.mode === 'chase' || camera.mode === 'bonnet')) {
        const reach = Math.hypot(camera.target[0] - camera.position[0], camera.target[1] - camera.position[1], camera.target[2] - camera.position[2]);
        const t = clock * BOOST_SHAKE_PACE, a = boost * BOOST_SHAKE_ANGLE * reach;
        camera.target[0] += wobble(t, 5) * a;
        camera.target[1] += wobble(t, 6) * a;
        camera.target[2] += wobble(t, 7) * a;
        camera.position[1] += wobble(t, 8) * boost * BOOST_SHAKE_SHIFT;
      }

      m4lookAt(camera.view, camera.position, camera.target, up);
      const fx = camera.target[0] - camera.position[0], fy = camera.target[1] - camera.position[1], fz = camera.target[2] - camera.position[2];
      const fl = Math.hypot(fx, fy, fz) || 1;
      camera.forward[0] = fx / fl; camera.forward[1] = fy / fl; camera.forward[2] = fz / fl;
      if (hasPrevious && !cut && dt > 0) {
        camera.velocity[0] = (camera.position[0] - previous[0]) / dt;
        camera.velocity[1] = (camera.position[1] - previous[1]) / dt;
        camera.velocity[2] = (camera.position[2] - previous[2]) / dt;
      } else if (cut) {
        // Across a cut the listener moves with the car, not at the speed of the jump.
        camera.velocity[0] = subject.vel[0]; camera.velocity[1] = subject.vel[1]; camera.velocity[2] = subject.vel[2];
      }
      previous[0] = camera.position[0]; previous[1] = camera.position[1]; previous[2] = camera.position[2];
      hasPrevious = true;
      camera.cut = cut;
      lastSpeed = subject.forwardSpeed;
    },
  };

  function updateChase(dt, subject, speed, fast, boost, cut) {
    // Where the arm should point: along the car, leaning towards where the car is going.
    let wanted = subject.yaw;
    if (speed > 4 && !rearView) {
      const travel = Math.atan2(subject.vel[0], subject.vel[2]);
      wanted += clamp(angleDelta(subject.yaw, travel) * SLIDE_SHARE, -SLIDE_LIMIT, SLIDE_LIMIT) * smoothstep(4, 12, speed);
    }
    if (rearView) wanted += Math.PI;
    const accel = dt > 0 ? (subject.forwardSpeed - lastSpeed) / dt : 0;
    const armTarget = lerp(ARM_LENGTH, ARM_LENGTH_FAST, fast) + BOOST_ARM * boost;
    const heightTarget = lerp(ARM_HEIGHT, ARM_HEIGHT_FAST, fast);
    const fovTarget = lerp(FOV_REST, FOV_FAST, fast) + BOOST_FOV * boost;
    const leadTarget = rearView ? 0 : clamp(subject.yawRate * TURN_LEAD, -TURN_LEAD_LIMIT, TURN_LEAD_LIMIT);
    const rollTarget = clamp(subject.yawRate * subject.forwardSpeed * ROLL_PER_ACCEL, -ROLL_LIMIT, ROLL_LIMIT);
    if (cut) {
      heading.x = wanted; heading.v = 0;
      arm.x = armTarget; arm.v = 0;
      height.x = heightTarget; height.v = 0;
      pivotY.x = subject.pos[1]; pivotY.v = 0;
      pitch.x = forward[1]; pitch.v = 0;
      surge.x = 0; surge.v = 0;
      fov.x = fovTarget; fov.v = 0;
      lead.x = leadTarget; lead.v = 0;
      roll.x = rollTarget; roll.v = 0;
      free = 1e9;
    } else {
      springAngle(heading, wanted, lerp(HEADING_RATE, HEADING_RATE_FAST, fast), dt);
      spring(arm, armTarget, 3, dt);
      spring(height, heightTarget, 3, dt);
      // Height changes of the car (kerbs, landings) reach the camera softened.
      spring(pivotY, subject.pos[1], 9, dt);
      spring(pitch, forward[1], 3.5, dt);
      spring(surge, clamp(accel * SURGE_GAIN, -SURGE_LIMIT, SURGE_LIMIT), 4, dt);
      spring(fov, fovTarget, 3, dt);
      spring(lead, leadTarget, 5, dt);
      spring(roll, rollTarget, 4, dt);
    }
    const sign = rearView ? -1 : 1;
    const hx = Math.sin(heading.x), hz = Math.cos(heading.x);
    pivot[0] = subject.pos[0]; pivot[1] = pivotY.x + PIVOT_HEIGHT; pivot[2] = subject.pos[2];

    // The arm, from the pivot back and up; on a slope it tilts with the road.
    const length = arm.x + surge.x;
    const rise = height.x - PIVOT_HEIGHT - sign * pitch.x * length;
    const full = Math.hypot(length, rise);
    back[0] = -hx * length / full; back[1] = rise / full; back[2] = -hz * length / full;
    let allowed = full;
    if (obstruction) {
      // Three probes: the arm itself and one to each side of it.
      const sx = hz * PROBE_SIDE, sz = -hx * PROBE_SIDE;
      allowed = obstruction(pivot, back, full + WALL_MARGIN) - WALL_MARGIN;
      for (let side = -1; side <= 1; side += 2) {
        probe[0] = back[0] * full + sx * side; probe[1] = back[1] * full; probe[2] = back[2] * full + sz * side;
        const reach = Math.hypot(probe[0], probe[1], probe[2]);
        probe[0] /= reach; probe[1] /= reach; probe[2] /= reach;
        allowed = Math.min(allowed, obstruction(pivot, probe, reach + WALL_MARGIN) - WALL_MARGIN);
      }
      allowed = clamp(allowed, MIN_ARM, full);
    }
    // Pulled in at once, let out gradually: the camera never passes through the wall and
    // does not jump back when the wall ends.
    free = allowed < free || cut ? allowed : Math.min(allowed, free + (full - free) * (1 - Math.exp(-ARM_RECOVER_RATE * dt)) + 0.5 * dt);
    const used = Math.min(full, free);
    camera.position[0] = pivot[0] + back[0] * used;
    camera.position[1] = Math.max(pivot[1] + back[1] * used, subject.pos[1] + GROUND_CLEARANCE);
    camera.position[2] = pivot[2] + back[2] * used;

    // Look ahead of the car, further at speed, and into the bend.
    const ahead = (LOOK_AHEAD + speed * LOOK_AHEAD_PER_SPEED) * sign;
    const lx = Math.sin(heading.x + lead.x * sign), lz = Math.cos(heading.x + lead.x * sign);
    camera.target[0] = pivot[0] + lx * ahead;
    camera.target[1] = pivot[1] - PIVOT_HEIGHT + TARGET_HEIGHT + sign * pitch.x * Math.abs(ahead);
    camera.target[2] = pivot[2] + lz * ahead;
    // Turning left (positive yaw rate) the body leans to the right, and the picture with it.
    // The arm's left is (hz, 0, -hx); seen in the rear view the lean is the other way round.
    const lean = Math.tan(roll.x) * sign;
    up[0] = -hz * lean; up[1] = 1; up[2] = hx * lean;
    camera.fovY = fov.x;
  }

  function updateBonnet(dt, subject, fast, boost, cut) {
    const fovTarget = lerp(BONNET_FOV_REST, BONNET_FOV_FAST, fast) + BOOST_FOV * boost;
    if (cut) { fov.x = fovTarget; fov.v = 0; } else spring(fov, fovTarget, 3, dt);
    if (rearView) {
      // From the tail, looking back along the car.
      local[0] = 0; local[1] = subject.height * 0.92; local[2] = -subject.length * 0.5 - 0.2;
    } else if (subject.bonnet) {
      local[0] = subject.bonnet[0]; local[1] = subject.bonnet[1]; local[2] = subject.bonnet[2];
    } else {
      local[0] = 0; local[1] = subject.height * 0.86; local[2] = subject.length * 0.12;
    }
    quatRotate(camera.position, subject.quat, local);
    camera.position[0] += subject.pos[0]; camera.position[1] += subject.pos[1]; camera.position[2] += subject.pos[2];
    const sign = rearView ? -1 : 1;
    camera.target[0] = camera.position[0] + forward[0] * 20 * sign;
    camera.target[1] = camera.position[1] + forward[1] * 20 * sign - BONNET_DROP;
    camera.target[2] = camera.position[2] + forward[2] * 20 * sign;
    // The horizon rolls with the body, but less: full roll is tiring to watch.
    up[0] = carUp[0] * 0.6; up[1] = carUp[1] * 0.6 + 0.4; up[2] = carUp[2] * 0.6;
    camera.fovY = fov.x;
  }

  function updateOrbit(dt, subject, cut) {
    if (cut) { fov.x = ORBIT_FOV; fov.v = 0; }
    orbitPhase = (orbitPhase + dt * TAU / ORBIT_PERIOD) % TAU;
    const swing = Math.sin(orbitPhase);
    // The eye rises a little towards the sides of the swing so that the roof line is seen as well as the lamps.
    const lift = ORBIT_HEIGHT + 0.2 * swing * swing;
    const angle = subject.yaw + ORBIT_CENTRE + ORBIT_SWING * swing;
    pivot[0] = subject.pos[0]; pivot[1] = subject.pos[1] + 0.62; pivot[2] = subject.pos[2];
    back[0] = Math.sin(angle) * ORBIT_RADIUS; back[1] = lift - 0.62; back[2] = Math.cos(angle) * ORBIT_RADIUS;
    const full = Math.hypot(back[0], back[1], back[2]);
    back[0] /= full; back[1] /= full; back[2] /= full;
    let used = full;
    if (obstruction) used = clamp(obstruction(pivot, back, full + WALL_MARGIN) - WALL_MARGIN, 3.2, full);
    camera.position[0] = pivot[0] + back[0] * used;
    camera.position[1] = Math.max(pivot[1] + back[1] * used, subject.pos[1] + GROUND_CLEARANCE);
    camera.position[2] = pivot[2] + back[2] * used;
    // Camera right is forward x up with forward = -back, on the ground plane; the aim point moves the other way.
    const flat = Math.hypot(back[0], back[2]) || 1, rx = back[2] / flat, rz = -back[0] / flat;
    camera.target[0] = pivot[0] - rx * ORBIT_SHIFT; camera.target[1] = pivot[1]; camera.target[2] = pivot[2] - rz * ORBIT_SHIFT;
    up[0] = 0; up[1] = 1; up[2] = 0;
    camera.fovY = spring(fov, ORBIT_FOV, 3, dt);
  }

  return camera;
}

const FORWARD = [0, 0, 1];
