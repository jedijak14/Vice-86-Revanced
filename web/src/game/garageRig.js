// The garage camera: a camera on a dolly circling the car on the turntable, the way a car is filmed in a studio.
//
// The eye rides a sphere about a point at the car's waist: a bearing round the room, an elevation and a
// distance. Left alone it drifts slowly round the door side of the room, so the sign wall stays behind the car
// and the highlights never stand still; a drag or the right stick takes over at once and the drift comes back
// a few seconds after the hand lets go. A change of car is a cut to the next of a few composed angles, as an
// editor would cut rather than swing a dolly through the room. Drive is one more cut, to a low view from the
// back of the room that pushes in on the car while the door rises beyond it.
//
// The lens is the one a car is photographed with: 35 to 60 mm on a 36 mm frame. The rig stands as far back as
// the room lets it and uses the lens to frame; only when the lens is at its long end does it move in. The room
// is not round, so the distance the walls allow changes with the bearing and the lens takes up the difference.
//
// Everything is in the set's own frame (metres, origin at the turntable centre on the floor, +Z towards the
// roller door) and moved to the world by `origin` on the way out. Nothing is allocated after creation.

import { clamp, DEG } from '../core/math.js';

/** Width of the film frame the focal lengths refer to, mm. */
export const FRAME_WIDTH = 36;
/**
 * Focal lengths (mm) at the two ends of the zoom. The wide end is what the room asks for: from seven metres,
 * the furthest the walls allow, it shows the longest car corner to corner across three fifths of the picture,
 * with air on both sides for the garage's panels.
 */
export const FOCAL_WIDE = 35, FOCAL_LONG = 60;
/** f-number. At f/2 from six metres a 35 mm lens holds the car from nose to tail and leaves the far wall a little soft. */
export const APERTURE = 2;
/** The drift: degrees per second, slow enough to read as a dolly and not as the room turning. */
export const DRIFT_RATE = 2 * DEG;
/** Seconds the camera rests after the hand lets go before it drifts again, and 1/s at which the drift picks up. */
const DRIFT_REST = 3, DRIFT_EASE = 1.2;
/** The drift turns back this far (rad) either side of the middle of the room; the hand may go on to the yaw limit. */
const DRIFT_RANGE = 1.0;
/** 1/s: how closely the eye follows the hand. Tight enough to feel held, loose enough to hide a mouse's steps. */
const FOLLOW_RATE = 12, ZOOM_RATE = 8;
/** The eye keeps this clear of the faces of the camera volume, m (the near plane must not cut a wall). */
const WALL_MARGIN = 0.05;
/** Aspect assumed until the game says otherwise. */
const DEFAULT_ASPECT = 16 / 9;

/**
 * The composed angles a change of car cuts between, as bearings in the room (rad from the door side, positive
 * towards +X) and eye heights (m). The car turns on its table, so these place the room behind it, not the car's
 * face: the sign wall square on, then over each shoulder, a high one for the bonnet, and a long low one.
 */
const ANGLES = Object.freeze([
  { yaw: 0.6, height: 0.75 },
  { yaw: -0.7, height: 0.6 },
  { yaw: 0.08, height: 0.5 },
  { yaw: 0.38, height: 2.1 },
  { yaw: -0.95, height: 0.9 },
]);

/** The Drive shot: bearing from the door side (so behind the car, off to one side), height, distance and push. */
const DRIVE = Object.freeze({ yaw: Math.PI - 0.42, height: 0.48, distance: 6.9, push: 0.3, closest: 5.4 });

/** A car's plan diagonal when none has been given, m. */
const DEFAULT_DIAGONAL = 4.6;
/** Share of the plan diagonal from the car's centre to the shoulder nearest the camera, where focus is held. */
const SHOULDER = 0.25;

/** One step of a critically damped spring towards `target`. `state` is { x, v }. */
function spring(state, target, rate, dt) {
  const e = Math.exp(-rate * dt);
  const d = state.x - target;
  const t = (state.v + rate * d) * dt;
  state.x = target + (d + t) * e;
  state.v = (state.v - rate * t) * e;
  return state.x;
}

/** A view for `rig.update` to fill when the caller keeps none of its own. */
export function createGarageView() {
  return { position: [0, 0, 0], target: [0, 0, 0], fov: 0, cut: false, focusDistance: 0, aperture: 0 };
}

/**
 * @param {object} options
 * @param {object} options.anchors  `buildGarage().anchors`; read: `camera.min`, `camera.max` (the volume the eye
 *        may be in) and, where given, `camera.orbit { centre, minRadius, maxRadius, minHeight, maxHeight,
 *        yaw { centre, halfRange } }` and `camera.home { yaw, height }`
 * @param {number[]} [options.origin]  world position of the set's origin
 */
export function createGarageRig({ anchors, origin = [0, 0, 0] }) {
  const volume = anchors.camera, orbit = volume.orbit || {};
  const centre = orbit.centre || [0, 0.6, 0];
  const minRadius = orbit.minRadius ?? 5, maxRadius = orbit.maxRadius ?? 7;
  const minHeight = Math.max(orbit.minHeight ?? 0.3, volume.min[1] + WALL_MARGIN);
  const maxHeight = Math.min(orbit.maxHeight ?? 2.4, volume.max[1] - WALL_MARGIN);
  const yawCentre = orbit.yaw ? orbit.yaw.centre : 0, yawRange = orbit.yaw ? orbit.yaw.halfRange : 1.9;
  const driftRange = Math.min(DRIFT_RANGE, yawRange);
  // Elevation limits are those of the eye height at the far end of the arm, so a high view is never bought by
  // the ceiling of the volume pushing the camera in.
  const pitchOfHeight = (height) => Math.asin(clamp((height - centre[1]) / maxRadius, -0.95, 0.95));
  const minPitch = pitchOfHeight(minHeight), maxPitch = pitchOfHeight(maxHeight);
  // What the picture spans across at the car, m: the widest lens from the far end of the arm, and the longest
  // from the near end.
  const widest = FRAME_WIDTH * maxRadius / FOCAL_WIDE, tightest = FRAME_WIDTH * minRadius / FOCAL_LONG;

  const angles = ANGLES.map((angle) => ({ yaw: angle.yaw, pitch: pitchOfHeight(angle.height) }));
  if (volume.home) { angles[0].yaw = volume.home.yaw; angles[0].pitch = pitchOfHeight(volume.home.height); }
  for (const angle of angles) {
    angle.yaw = clamp(angle.yaw, yawCentre - yawRange, yawCentre + yawRange);
    angle.pitch = clamp(angle.pitch, minPitch, maxPitch);
  }

  const yaw = { x: 0, v: 0 }, pitch = { x: 0, v: 0 }, span = { x: widest, v: 0 }, drift = { x: 0, v: 0 };
  const goal = { yaw: 0, pitch: 0, span: widest };
  let angleIndex = 0, driftWay = 1, rest = 0, cutPending = true, driving = false, pushed = 0;
  let diagonal = DEFAULT_DIAGONAL;
  const ownView = createGarageView();

  /** Puts the camera on a composed angle, as a cut. */
  function cutTo(index) {
    angleIndex = ((index % angles.length) + angles.length) % angles.length;
    goal.yaw = angles[angleIndex].yaw; goal.pitch = angles[angleIndex].pitch; goal.span = widest;
    // Towards the middle of the room first: the longer run before the drift has to turn back.
    driftWay = goal.yaw > yawCentre ? -1 : 1;
    rest = 0; driving = false; pushed = 0; cutPending = true;
  }

  /** Furthest the eye may stand from the orbit centre along a unit direction without leaving the volume. */
  function reach(dx, dy, dz, wanted) {
    let r = wanted;
    if (dx > 1e-6) r = Math.min(r, (volume.max[0] - WALL_MARGIN - centre[0]) / dx); else if (dx < -1e-6) r = Math.min(r, (volume.min[0] + WALL_MARGIN - centre[0]) / dx);
    if (dy > 1e-6) r = Math.min(r, (volume.max[1] - WALL_MARGIN - centre[1]) / dy); else if (dy < -1e-6) r = Math.min(r, (volume.min[1] + WALL_MARGIN - centre[1]) / dy);
    if (dz > 1e-6) r = Math.min(r, (volume.max[2] - WALL_MARGIN - centre[2]) / dz); else if (dz < -1e-6) r = Math.min(r, (volume.min[2] + WALL_MARGIN - centre[2]) / dz);
    return Math.max(r, 0);
  }

  const rig = {
    /** The view filled by `update` when it is given none. */
    view: ownView,

    /** True when the camera has arrived where it is going (nothing left but the drift). */
    get settled() {
      return !cutPending && Math.abs(yaw.x - goal.yaw) < 2e-3 && Math.abs(pitch.x - goal.pitch) < 2e-3 && Math.abs(span.x - goal.span) < 5e-3 * goal.span;
    },

    /** Entering the garage: the home angle, as a cut. */
    reset() { cutTo(0); },

    /**
     * A car has been put on the turntable: cut to the next composed angle (`direction` +1) or the one before (-1).
     * @param {{length: number, width: number, height: number}} car  its size, m
     */
    setCar(car, direction = 1) {
      diagonal = car && car.length > 0 && car.width > 0 ? Math.hypot(car.length, car.width) : DEFAULT_DIAGONAL;
      cutTo(angleIndex + (direction < 0 ? -1 : 1));
    },

    /** The door starts to rise: cut to the low view from the back of the room and push in until `reset`. */
    drive() {
      goal.yaw = DRIVE.yaw; goal.pitch = pitchOfHeight(DRIVE.height); goal.span = widest;
      driving = true; pushed = 0; rest = 0; cutPending = true;
    },

    /**
     * Advances the camera and writes the view.
     * @param {number} dt  seconds
     * @param {{yaw: number, pitch: number, zoom: number, held: boolean, aspect: number}|null} look  this frame's
     *        turn of the view by the player: yaw and pitch in radians (positive yaw takes the eye anticlockwise
     *        seen from above, positive pitch raises it), zoom as a ratio (0.1 = a tenth closer), held while a
     *        button or finger is down; aspect is the picture's width over its height
     * @param {object} [out]  a view from `createGarageView()`; `rig.view` when omitted
     * @returns the view: position and target (world), fov (vertical, radians), cut (true for the one update
     *          after reset, setCar or drive), focusDistance (m) and aperture (f-number)
     */
    update(dt, look, out = ownView) {
      const cut = cutPending;
      cutPending = false;
      if (cut) { drift.x = 0; drift.v = 0; }
      if (driving) {
        pushed = Math.min(pushed + DRIVE.push * dt, DRIVE.distance - DRIVE.closest);
      } else {
        const turned = look ? look.yaw || 0 : 0, raised = look ? look.pitch || 0 : 0, zoomed = look ? look.zoom || 0 : 0;
        const handled = (look && look.held) || turned !== 0 || raised !== 0 || zoomed !== 0;
        if (handled) {
          goal.yaw += turned; goal.pitch += raised; goal.span *= 1 - clamp(zoomed, -0.5, 0.5);
          rest = DRIFT_REST; drift.x = 0; drift.v = 0;
        } else if (rest > 0) {
          rest -= dt;
        } else {
          // Turn back before the end of the run, and from wherever the hand left the camera beyond it.
          if (goal.yaw > yawCentre + driftRange) driftWay = -1; else if (goal.yaw < yawCentre - driftRange) driftWay = 1;
          goal.yaw += spring(drift, driftWay * DRIFT_RATE, DRIFT_EASE, dt) * dt;
        }
        goal.yaw = clamp(goal.yaw, yawCentre - yawRange, yawCentre + yawRange);
        goal.pitch = clamp(goal.pitch, minPitch, maxPitch);
        goal.span = clamp(goal.span, tightest, widest);
      }
      if (cut) {
        yaw.x = goal.yaw; pitch.x = goal.pitch; span.x = goal.span;
        yaw.v = pitch.v = span.v = 0;
      } else {
        spring(yaw, goal.yaw, FOLLOW_RATE, dt); spring(pitch, goal.pitch, FOLLOW_RATE, dt); spring(span, goal.span, ZOOM_RATE, dt);
      }

      const cosPitch = Math.cos(pitch.x);
      const dx = Math.sin(yaw.x) * cosPitch, dy = Math.sin(pitch.x), dz = Math.cos(yaw.x) * cosPitch;
      // As far back as the long end of the lens needs and the room allows; the lens then frames from there.
      const wanted = driving ? DRIVE.distance - pushed : clamp(span.x * FOCAL_LONG / FRAME_WIDTH, minRadius, maxRadius);
      const distance = reach(dx, dy, dz, wanted);
      const focal = clamp(FRAME_WIDTH * distance / span.x, FOCAL_WIDE, FOCAL_LONG);
      const aspect = look && look.aspect > 0 ? look.aspect : DEFAULT_ASPECT;

      out.position[0] = origin[0] + centre[0] + dx * distance;
      out.position[1] = origin[1] + centre[1] + dy * distance;
      out.position[2] = origin[2] + centre[2] + dz * distance;
      out.target[0] = origin[0] + centre[0]; out.target[1] = origin[1] + centre[1]; out.target[2] = origin[2] + centre[2];
      out.fov = 2 * Math.atan(0.5 * FRAME_WIDTH / focal / aspect);
      out.cut = cut;
      out.focusDistance = Math.max(distance - SHOULDER * diagonal, 0.5);
      out.aperture = APERTURE;
      return out;
    },
  };
  return rig;
}
