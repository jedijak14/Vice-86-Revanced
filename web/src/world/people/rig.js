// The rig a person is drawn with: seven bones, forward kinematics, and the poses the street needs.
//
// The release has no skeletal animation — nothing in the renderer takes skin weights, and every moving
// thing (a car, an officer, a palm) is drawn as a handful of rigid objects posed by their own matrices.
// A person made that way is a puppet, and a puppet is the right answer here: the parts are authored
// around their joints, so the geometry of a sleeve, a trouser and a shoe never has to know that it is
// being bent, and the same meshes serve every outfit.
//
// This module is plain arithmetic on numbers and Float32Arrays. It knows nothing about the renderer, the
// world or the clock, which is why the walk can be tested without a page.

import { m4, m4mul, m4translation, m4rotationX, m4rotationY, m4rotationZ, clamp, lerp } from '../../core/math.js';

/**
 * The bones, in the order they are posed: each one turns about its own joint, after its parent.
 * `offset` is the joint's place in the parent's frame (metres, y up, z forward along the body),
 * and `axes` says which local rotations a pose may drive.
 */
export const BONES = Object.freeze([
  { name: 'hips', parent: null, offset: [0, 0.94, 0], axes: 'yz' },
  { name: 'chest', parent: 'hips', offset: [0, 0.27, 0], axes: 'yz' },
  { name: 'torso', parent: 'chest', offset: [0, 0.12, 0], axes: '' },
  { name: 'armL', parent: 'chest', offset: [0.205, 0.13, 0], axes: 'xz' },
  { name: 'armR', parent: 'chest', offset: [-0.205, 0.13, 0], axes: 'xz' },
  { name: 'thighL', parent: 'hips', offset: [0.095, -0.02, 0], axes: 'x' },
  { name: 'shinL', parent: 'thighL', offset: [0, -0.42, 0], axes: 'x' },
  { name: 'thighR', parent: 'hips', offset: [-0.095, -0.02, 0], axes: 'x' },
  { name: 'shinR', parent: 'thighR', offset: [0, -0.42, 0], axes: 'x' },
]);

/** The parts a body is actually drawn with: one object per entry, and nothing else. */
export const PARTS = Object.freeze(['torso', 'armL', 'armR', 'thighL', 'shinL', 'thighR', 'shinR']);

/** The bone each drawn part hangs from. */
export const PART_BONE = Object.freeze({
  torso: 'torso', armL: 'armL', armR: 'armR', thighL: 'thighL', shinL: 'shinL', thighR: 'thighR', shinR: 'shinR',
});

const INDEX = new Map(BONES.map((b, i) => [b.name, i]));
export const boneCount = BONES.length;
export const boneIndex = (name) => INDEX.get(name) ?? -1;

/** A pose: the angles a rig is driven by, in radians, all zero when nothing is happening. */
export function createPose() {
  return {
    hipsYaw: 0, hipsBob: 0, hipsDip: 0, lean: 0, turn: 0,
    armL: 0, armLOut: 0, armR: 0, armROut: 0,
    thighL: 0, thighR: 0, shinL: 0, shinR: 0,
    /** A head that looks about its business: yaw then pitch. */
    look: 0, lookPitch: 0,
    /** How much of this pose is the walk, 0..1: the blend between standing and striding. */
    stride: 1,
  };
}

const HALF = Math.PI;

/**
 * A walking person. `phase` is anywhere in the cycle (0..1 per full two-step cycle), `speed` the
 * ground speed in m/s, which sets how deep the stride is: at 0.4 m/s a leg barely lifts, at 2 m/s
 * it is a walk, and above that the same cycle simply runs faster.
 */
export function walkPose(pose, phase, speed = 1.3) {
  const a = phase * Math.PI * 2;
  const depth = clamp(0.18 + speed * 0.3, 0.1, 0.75);
  const lift = clamp(speed * 0.42, 0.05, 0.5);
  pose.thighL = Math.sin(a) * depth;
  pose.thighR = Math.sin(a + Math.PI) * depth;
  // The knee only bends as the leg comes forward, and never backwards: the shin's angle is the
  // thigh's, folded up, so a straight leg under the body is impossible.
  pose.shinL = Math.max(0, -Math.sin(a - 0.6)) * lift * 1.7;
  pose.shinR = Math.max(0, -Math.sin(a + Math.PI - 0.6)) * lift * 1.7;
  // Arms against the legs, elbows just bent enough that they do not swing like sticks.
  pose.armL = Math.sin(a + Math.PI) * depth * 0.85 - 0.12;
  pose.armR = Math.sin(a) * depth * 0.85 - 0.12;
  pose.armLOut = 0.1 + Math.abs(Math.sin(a)) * 0.03;
  pose.armROut = 0.1 + Math.abs(Math.sin(a + Math.PI)) * 0.03;
  // One step per half cycle, so the body dips twice as often as it turns.
  pose.hipsDip = Math.abs(Math.sin(a)) * 0.028 * depth - 0.014;
  pose.hipsBob = Math.sin(a * 2) * 0.02;
  pose.lean = clamp(speed * 0.03, 0, 0.09);
  pose.turn = Math.sin(a) * 0.05;
  pose.stride = 1;
  return pose;
}

/** Standing, with the small movements that say a person is not a lamppost. */
export function idlePose(pose, clock = 0, weight = 1) {
  const shift = Math.sin(clock * 0.7) * 0.5 + Math.sin(clock * 0.23) * 0.5;
  pose.armL = -0.06 + shift * 0.02;
  pose.armR = -0.06 - shift * 0.02;
  pose.armLOut = 0.13;
  pose.armROut = 0.13;
  pose.thighL = shift * 0.02;
  pose.thighR = -shift * 0.02;
  pose.shinL = Math.max(0, -shift) * 0.1;
  pose.shinR = Math.max(0, shift) * 0.1;
  pose.hipsYaw = shift * 0.03;
  pose.hipsDip = -0.012;
  pose.lean = 0.02 + Math.abs(shift) * 0.01;
  pose.turn = 0;
  pose.look = shift * 0.5;
  pose.stride = 0 * weight;
  return pose;
}

/** An arm raised and waving: the hail of a fare, held until a car stops. */
export function hailPose(pose, clock = 0) {
  idlePose(pose, clock);
  const wave = Math.sin(clock * 3.4);
  pose.armL = -2.5 - wave * 0.22;
  pose.armLOut = 0.5 + wave * 0.12;
  pose.armR = -0.1;
  pose.look = wave * 0.35;
  pose.lean = 0.04;
  return pose;
}

/** Both hands up, weight back: the answer to a car coming at you on the wrong side of the kerb. */
export function startlePose(pose, k = 1) {
  const s = clamp(k, 0, 1);
  pose.armL = -1.5 * s; pose.armR = -1.55 * s;
  pose.armLOut = 0.55 * s; pose.armROut = 0.6 * s;
  pose.lean = -0.14 * s;
  pose.thighL = 0.12 * s; pose.thighR = -0.16 * s;
  pose.shinL = 0.2 * s; pose.shinR = 0.1 * s;
  pose.stride = 0;
  return pose;
}

/** Pointing at somewhere: one arm out and level, the body squared up to it. */
export function pointPose(pose, clock = 0) {
  idlePose(pose, clock);
  const bob = Math.sin(clock * 1.6) * 0.04;
  pose.armL = -1.5 + bob;
  pose.armLOut = 0.06;
  pose.look = 0.15;
  return pose;
}

/** `a` towards `b`, for one frame. Posing is cheap; the ease is what stops a snap. */
export function blendPose(a, b, t) {
  for (const key of Object.keys(b)) {
    if (typeof a[key] !== 'number') continue;
    a[key] = lerp(a[key], b[key], t);
  }
  return a;
}

const _tx = m4(), _rx = m4(), _ry = m4(), _rz = m4(), _tmp = m4(), _local = m4(), _world = m4();

/**
 * Solve the rig: `out[i]` is the world matrix of bone i, ready for the part that hangs from it.
 * `root` is the person's place in the world: [x, z, yaw]; `ground` is the height of the land they
 * stand on (the flat street level the whole island is drawn at).
 *
 * Only the seven drawn parts matter to the caller, but every bone is solved, because a shin needs
 * its thigh and a thigh needs its hips.
 */
export function boneMatrices(pose, root, out, ground = 0) {
  const [x, z, yaw] = root;
  const by = new Map();
  for (let i = 0; i < BONES.length; i++) {
    const bone = BONES[i], m = out[i] || (out[i] = m4());
    m4translation(m, bone.offset[0], bone.offset[1], bone.offset[2]);
    if (bone.axes.includes('y')) {
      const turn = bone.name === 'hips' ? yaw + pose.hipsYaw + pose.turn : (bone.name === 'chest' ? pose.look * 0.5 : 0);
      m4rotationY(_ry, turn);
      m4mul(m, m, _ry);
    }
    if (bone.name === 'hips') {
      // The whole person's heading, then the dip and bob the walk puts in their hips.
      m4rotationY(_ry, 0);
      m4translation(_tx, x, ground + pose.hipsDip, z);
      m4mul(_tmp, _tx, m);
      m.set(_tmp);
      m4translation(_tx, 0, pose.hipsBob * 0.06, 0);
      m4mul(m, m, _tx);
    }
    if (bone.name === 'chest' && pose.lean) { m4rotationX(_rx, pose.lean); m4mul(m, m, _rx); }
    if (bone.name === 'armL') { m4rotationX(_rx, pose.armL); m4mul(m, m, _rx); m4rotationZ(_rz, -pose.armLOut); m4mul(m, m, _rz); }
    if (bone.name === 'armR') { m4rotationX(_rx, pose.armR); m4mul(m, m, _rx); m4rotationZ(_rz, pose.armROut); m4mul(m, m, _rz); }
    if (bone.name === 'thighL' || bone.name === 'thighR') {
      const swing = bone.name === 'thighL' ? pose.thighL : pose.thighR;
      m4rotationX(_rx, swing); m4mul(m, m, _rx);
    }
    if (bone.name === 'shinL' || bone.name === 'shinR') {
      const bend = bone.name === 'shinL' ? pose.shinL : pose.shinR;
      m4rotationX(_rx, -bend); m4mul(m, m, _rx);
    }
    const parent = bone.parent ? by.get(bone.parent) : null;
    by.set(bone.name, m);
    if (parent) {
      // Compose with the parent's solved matrix; the bone's own matrix stays as the local part for
      // anybody who asks (a shoe that wants its parent's world turn).
      const world = out[i + BONES.length] || (out[i + BONES.length] = m4());
      m4mul(world, parent, m);
      out[i] = world;
      by.set(bone.name, world);
    } else {
      const world = out[i + BONES.length] || (out[i + BONES.length] = m4());
      world.set(m);
      out[i] = world;
      by.set(bone.name, world);
    }
  }
  return out;
}

/** Half-width across the shoulders and the height of the head, for the crowd's spacing tests. */
export const FOOTPRINT = Object.freeze({ halfWidth: 0.23, height: 1.8, depth: 0.15 });

/** How far a person's centre is from the kerb edge they walk along. */
export const KERB_STANDOFF = 0.85;

/** The step a walker covers per cycle, metres: the crowd's speed and its phase come from this. */
export const STRIDE_METRES = 1.34;

/** Where the feet are, in the rig: used to keep them on the ground and to test the walk. */
export const HIP_HEIGHT = BONES[0].offset[1];
