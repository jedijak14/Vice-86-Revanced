// Drawing a vehicle: renderer meshes per model and level of detail, and the dynamic objects
// (body, glass, four wheels and, where the model has them, brake calipers and pop-up headlamp
// pods) of one vehicle on screen.
//
// A model is uploaded once (`createVehicleKit`) and shared by every vehicle of that type.
// A vehicle on screen (`VehicleView`) owns its dynamic objects. Objects for a level of detail
// are created the first time that level is shown, so a parked car in the distance costs one
// object, not thirteen.

import { m4mul, m4fromQuatPos, m4fromYawPos } from '../core/math.js';
import { paintState } from '../render/families/vehicle.js';
import { createLampRig } from './lamps.js';

const WHEEL_SIDE = [1, -1, 1, -1]; // FL, FR, RL, RR: +1 on the car's left
// A wheel turning faster than this is drawn with the model's smeared wheel, where it has one:
// spokes and wheel nuts sampled sixty times a second would otherwise strobe and appear to
// stand still or run backwards. Two thresholds, so that a steady speed never flickers.
const BLUR_ABOVE = 18, SHARP_BELOW = 14; // rad/s
/** Added to the indicator code in objB.w while the fog lamps are lit (the shader's circuit 7). */
export const FOG_LAMP_CODE = 8;

/**
 * Uploads a vehicle model's meshes.
 * @param {object} renderer
 * @param {object} model  vehicle model record (design/ARCHITECTURE.md 10.1 and 15.3)
 * @returns {object} kit shared by all views of this model
 */
export function createVehicleKit(renderer, model) {
  // Everything that is read from the model's anchors and sizes comes first: a model that
  // lacks some of it fails here, before anything of it is on the graphics card.
  const cache = new Map();
  const anchors = model.anchors.wheels;
  const kit = {
    model,
    levels: [],
    pods: [],
    wheelAnchors: [anchors.fl, anchors.fr, anchors.rl, anchors.rr],
    wheelRadius: [model.dims.wheelRadiusFront, model.dims.wheelRadiusFront, model.dims.wheelRadiusRear, model.dims.wheelRadiusRear],
    lamps: createLampRig(model),
    halfExtents: model.collider.halfExtents,
    colliderCentre: model.collider.centre,
    dispose() {
      for (const handle of cache.values()) renderer.destroyMesh(handle);
      cache.clear();
    },
  };
  const upload = (data) => {
    // A part that is not there, or is there with nothing in it yet, is not drawn.
    if (!data || data.indices.length === 0) return -1;
    // Front and rear wheels, or two levels, may share the same mesh data: upload it once.
    if (!cache.has(data)) cache.set(data, renderer.createMesh(data, { retain: true }));
    return cache.get(data);
  };
  // The mesh of each wheel in the order front left, front right, rear left, rear right. A
  // wheel whose pattern has a direction (slots swept against its turning) comes with a second
  // mesh for the right-hand side, modelled in the left wheel's frame like the first and placed
  // the same way; every other car wears the same wheel on both sides.
  const sides = (front, rear, frontRight, rearRight) => [front, frontRight >= 0 ? frontRight : front, rear, rearRight >= 0 ? rearRight : rear];
  const { levels, pods } = kit;
  const lods = Array.isArray(model.lods) && model.lods.length > 0 && model.lods[0].far !== Infinity ? model.lods : null;
  try {
    if (lods) {
      for (const lod of lods) {
        levels.push({
          body: upload(lod.body), glass: upload(lod.glass || null),
          wheels: sides(upload(lod.wheel || null), upload(lod.wheelRear || lod.wheel || null), -1, -1),
          caliperFront: -1, caliperRear: -1, smeared: [-1, -1, -1, -1],
          far: lod.far,
        });
      }
    } else {
      const parts = model.parts;
      levels.push({
        body: upload(parts.body), glass: upload(parts.glass),
        wheels: sides(
          upload(parts.wheelFront), upload(parts.wheelRear || parts.wheelFront),
          upload(parts.wheelFrontRight || null), upload(parts.wheelRearRight || parts.wheelFrontRight || null)),
        caliperFront: upload(parts.caliperFront || null), caliperRear: upload(parts.caliperRear || null),
        smeared: sides(
          upload(parts.wheelFrontBlur || null), upload(parts.wheelRearBlur || null),
          upload(parts.wheelFrontBlurRight || null), upload(parts.wheelRearBlurRight || null)),
        far: Infinity,
      });
      // Pop-up headlamp pods: one hinged part per side, where the model has them.
      const hinges = (model.anchors && model.anchors.lampPods) || {};
      for (const [mesh, hinge] of [[parts.lampPodLeft, hinges.left], [parts.lampPodRight, hinges.right]]) {
        if (mesh && hinge) pods.push({ mesh: upload(mesh), hinge: hinge.hinge, axis: hinge.axis, openAngle: hinge.openAngle });
      }
    }
  } catch (error) {
    kit.dispose(); // whatever was uploaded before a part turned out to be unusable
    throw error;
  }
  return kit;
}

const local = new Float32Array(16);

/**
 * Matrix in the vehicle frame of a part at a wheel: at (x, y, z), steered about the vertical
 * and rolled about the axle. Written column by column to avoid three products.
 *
 * Wheel meshes are modelled for the car's left. On the right (`side` -1) a wheel is the same
 * wheel turned half a turn about the vertical, as a real one is, so that lettering on the tyre
 * reads the right way round; a part bolted to the upright (`mirrored`, a brake caliper) is
 * the mirror image of its left-hand twin.
 */
function wheelLocal(out, x, y, z, steer, spin, side, mirrored) {
  const cs = Math.cos(steer), ss = Math.sin(steer), cr = Math.cos(spin), sr = Math.sin(spin);
  // Left: Ry(steer) * Rx(spin). Turned round: Ry(steer) * Ry(pi) * Rx(-spin), which is the
  // same matrix with its first and third columns negated; mirrored: only the first.
  const fore = mirrored ? 1 : side;
  out[0] = cs * side; out[1] = 0; out[2] = -ss * side; out[3] = 0;
  out[4] = ss * sr; out[5] = cr; out[6] = cs * sr; out[7] = 0;
  out[8] = ss * cr * fore; out[9] = -sr * fore; out[10] = cs * cr * fore; out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
}

/**
 * Rotation by `angle` (right-handed) about the unit `axis` through the point `hinge`, in the
 * vehicle frame.
 */
function hingeLocal(out, hinge, axis, angle) {
  const x = axis[0], y = axis[1], z = axis[2], c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  out[0] = t * x * x + c; out[1] = t * x * y + s * z; out[2] = t * x * z - s * y; out[3] = 0;
  out[4] = t * x * y - s * z; out[5] = t * y * y + c; out[6] = t * y * z + s * x; out[7] = 0;
  out[8] = t * x * z + s * y; out[9] = t * y * z - s * x; out[10] = t * z * z + c; out[11] = 0;
  // The hinge point stays where it is.
  const hx = hinge[0], hy = hinge[1], hz = hinge[2];
  out[12] = hx - (out[0] * hx + out[4] * hy + out[8] * hz);
  out[13] = hy - (out[1] * hx + out[5] * hy + out[9] * hz);
  out[14] = hz - (out[2] * hx + out[6] * hy + out[10] * hz);
  out[15] = 1;
}

/** Calls `fn` with every renderer object of one level of detail of a vehicle. */
function eachObject(set, fn) {
  fn(set.body);
  if (set.glass) fn(set.glass);
  for (const wheel of set.wheels) if (wheel) fn(wheel);
  for (const wheel of set.smeared) if (wheel) fn(wheel);
  for (const caliper of set.calipers) if (caliper) fn(caliper);
  for (const pod of set.pods) fn(pod);
}

export class VehicleView {
  /**
   * @param {object} renderer
   * @param {object} kit  from createVehicleKit
   * @param {{castShadow?: boolean}} [options]
   */
  constructor(renderer, kit, { castShadow = true } = {}) {
    this.renderer = renderer;
    this.kit = kit;
    this.castShadow = castShadow;
    /** Body matrix of the current frame: the lamp anchors are transformed by it. */
    this.matrix = new Float32Array(16);
    this.matrix[0] = this.matrix[5] = this.matrix[10] = this.matrix[15] = 1;
    this.objA = new Float32Array([0.5, 0.5, 0.5, 0]);
    this.objB = new Float32Array(4);
    this.level = -1;
    this.visible = true;
    /** Which of the renderer's two worlds the vehicle is drawn in: the street, or the garage (see setInterior). */
    this.interior = false;
    /** Pop-up headlamp pods: 0 closed (flush in the wings) .. 1 raised. */
    this.podOpen = 0;
    this._sets = kit.levels.map(() => null);
    this._teleported = true;
  }

  /**
   * Paint and dirt. `paint` is linear [r, g, b] with an optional fourth element, the finish
   * (0 solid, 1 metallic, 2 pearl). The VEHICLE and GLASS shaders read objA.w as
   * finish + dirt, the dirt kept below 1 so that the two can be told apart again.
   */
  setPaint(paint, dirt = 0) {
    this.objA[0] = paint[0]; this.objA[1] = paint[1]; this.objA[2] = paint[2];
    this.objA[3] = paintState(paint[3], dirt);
  }

  /**
   * Lamp levels drawn by the VEHICLE shader (design/ARCHITECTURE.md 5.4): headlamps, brake,
   * reverse 0..1; `indicator` is the code 0..3 plus 4 while a light bar runs; `fog` adds 8
   * while the fog lamps are lit. The code is passed on as given: a caller may already have
   * folded the flags in.
   */
  setLamps(head, brake, reverse, indicator, fog = false) {
    this.objB[0] = head; this.objB[1] = brake; this.objB[2] = reverse; this.objB[3] = indicator + (fog ? FOG_LAMP_CODE : 0);
  }

  /** The next update is a jump, not motion: the renderer must not blur or reproject across it. */
  markTeleported() {
    this._teleported = true;
  }

  setBodyFromQuat(pos, quat) {
    m4fromQuatPos(this.matrix, quat, pos);
  }

  setBodyFromYaw(pos, yaw) {
    m4fromYawPos(this.matrix, yaw, pos[0], pos[1], pos[2]);
  }

  /**
   * Pushes the pose to the renderer objects of the level of detail for `distance`.
   * @param {number} distance  metres from the camera
   * @param {object[]|null} wheels  physics wheels ({ localPos, steer, spin, angVel }) or null
   *                                for wheels at their anchors
   * @param {number} steer  road-wheel angle when `wheels` is null
   * @param {number} spin   wheel roll angle when `wheels` is null
   */
  update(distance, wheels, steer = 0, spin = 0) {
    const levels = this.kit.levels;
    let level = 0;
    while (level < levels.length - 1 && distance >= levels[level].far) level++;
    if (!this.visible) level = -1;
    if (level !== this.level) {
      if (this.level >= 0) this._show(this._sets[this.level], false);
      this.level = level;
      if (level >= 0) {
        if (!this._sets[level]) this._sets[level] = this._create(levels[level]);
        this._show(this._sets[level], true);
        this._teleported = true; // these objects have no history at this pose
      }
    }
    if (level < 0) return;
    const set = this._sets[level];
    const jumped = this._teleported;
    this._teleported = false;
    set.body.matrix.set(this.matrix);
    set.body.objA.set(this.objA);
    set.body.objB.set(this.objB);
    if (jumped) set.body.teleported = true;
    if (set.glass) {
      set.glass.matrix.set(this.matrix);
      set.glass.objA.set(this.objA);
      set.glass.objB.set(this.objB);
      if (jumped) set.glass.teleported = true;
    }
    for (let i = 0; i < set.pods.length; i++) {
      const pod = set.pods[i], hinge = this.kit.pods[i];
      hingeLocal(local, hinge.hinge, hinge.axis, hinge.openAngle * this.podOpen);
      m4mul(pod.matrix, this.matrix, local);
      pod.objA.set(this.objA);
      pod.objB.set(this.objB);
      if (jumped) pod.teleported = true;
    }
    const anchors = this.kit.wheelAnchors;
    for (let i = 0; i < 4; i++) {
      let wheel = set.wheels[i];
      if (!wheel) continue;
      if (wheels) {
        const w = wheels[i], p = w.localPos;
        wheelLocal(local, p[0], p[1], p[2], w.steer, w.spin, WHEEL_SIDE[i], false);
        const smeared = set.smeared[i];
        if (smeared) {
          const rate = Math.abs(w.angVel);
          const blur = set.blurred[i] ? rate > SHARP_BELOW : rate > BLUR_ABOVE;
          if (blur !== set.blurred[i]) {
            set.blurred[i] = blur;
            wheel.visible = !blur;
            smeared.visible = blur;
            (blur ? smeared : wheel).teleported = true; // it was last drawn somewhere else
          }
          if (blur) wheel = smeared;
        }
      } else {
        const p = anchors[i];
        wheelLocal(local, p[0], p[1], p[2], i < 2 ? steer : 0, spin, WHEEL_SIDE[i], false);
      }
      m4mul(wheel.matrix, this.matrix, local);
      wheel.objA.set(this.objA);
      if (jumped) wheel.teleported = true;
      const caliper = set.calipers[i];
      if (!caliper) continue;
      // A caliper is bolted to the upright: it steers and rides with the wheel but does not roll.
      const p = wheels ? wheels[i].localPos : anchors[i];
      wheelLocal(local, p[0], p[1], p[2], wheels ? wheels[i].steer : (i < 2 ? steer : 0), 0, WHEEL_SIDE[i], true);
      m4mul(caliper.matrix, this.matrix, local);
      caliper.objA.set(this.objA);
      if (jumped) caliper.teleported = true;
    }
  }

  setVisible(visible) {
    this.visible = visible;
  }

  /**
   * Moves the vehicle between the street and the garage: the renderer draws an object only in
   * frames of the world it belongs to (design/GARAGE.md, Interior rendering).
   */
  setInterior(interior) {
    if (interior === this.interior) return;
    this.interior = interior;
    for (const set of this._sets) if (set) eachObject(set, (object) => { object.interior = interior; });
    this._teleported = true; // it was last drawn in the other world
  }

  dispose() {
    for (const set of this._sets) if (set) eachObject(set, (object) => object.remove());
    this._sets.fill(null);
    this.level = -1;
  }

  _create(level) {
    const r = this.renderer, castShadow = this.castShadow, interior = this.interior;
    const wheel = (mesh) => (mesh >= 0 ? r.addDynamic({ mesh, castShadow, interior }) : null);
    const caliper = (mesh) => (mesh >= 0 ? r.addDynamic({ mesh, castShadow: false, interior }) : null);
    return {
      body: r.addDynamic({ mesh: level.body, castShadow, interior }),
      glass: level.glass >= 0 ? r.addDynamic({ mesh: level.glass, castShadow: false, interior }) : null,
      wheels: level.wheels.map(wheel),
      calipers: [caliper(level.caliperFront), caliper(level.caliperFront), caliper(level.caliperRear), caliper(level.caliperRear)],
      // The smeared twin of each wheel, shown instead of it at speed (see BLUR_ABOVE).
      smeared: level.smeared.map(wheel),
      blurred: [false, false, false, false],
      // The pods belong to the full model, which is the only level a model with pods has.
      pods: level.far === Infinity ? this.kit.pods.map((pod) => r.addDynamic({ mesh: pod.mesh, castShadow, interior })) : [],
    };
  }

  _show(set, visible) {
    if (!set) return;
    set.body.visible = visible;
    if (set.glass) set.glass.visible = visible;
    for (let i = 0; i < 4; i++) {
      if (set.wheels[i]) set.wheels[i].visible = visible && !set.blurred[i];
      if (set.smeared[i]) set.smeared[i].visible = visible && set.blurred[i];
    }
    for (const caliper of set.calipers) if (caliper) caliper.visible = visible;
    for (const pod of set.pods) pod.visible = visible;
  }
}
