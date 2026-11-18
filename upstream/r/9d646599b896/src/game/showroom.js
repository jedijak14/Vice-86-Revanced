// The garage as the game runs it: the set's meshes in the renderer, the turntable turning, the
// door rising, the room's lights in the frame's light list, and where the car stands.
//
// The set (src/world/garage, or the stand-in room) is plain data in its own frame; it stands
// in the world translated by `origin` and never rotated. Everything it draws carries the
// renderer's `interior` flag (design/GARAGE.md, Interior rendering), so it exists only in
// frames whose environment is the closed room's.
//
// The car on the turntable is not simulated there. Its vehicle stays parked on the street,
// where the drive will begin, and is drawn here as it sits on its springs there: the plane
// through its four tyre contact points is laid on the disc.

import { TAU, damp, saturate, smoothstep, angleDelta, quatFromYaw, quatMul, quatRotate, m4fromYawPos } from '../core/math.js';

const TURNTABLE_RATE = (6 * Math.PI) / 180; // rad/s: slow enough to read the car, fast enough for highlights to travel
const DOOR_SECONDS = 3.2; // s for the door's whole travel
const ALIGN_SECONDS = 2.0; // s for the turntable to bring the car's nose round to the door
const DIP = 0.45; // what is left of the room's light while a car is being built
const DIP_HALF_LIFE = 0.12; // s
const DOOR_PROBE_INTERVAL = 0.25; // s between recaptures of the room's reflections while the door moves
// Places in the frame's light list that are always the car's: its two headlamp beams. The room
// is lit by the rest whether the lamps burn or not, so that switching them on takes no light
// out of the room; where the budget is larger than the room, the car's other lamps fit too.
const CAR_LIGHTS = 2;
/** The set's meshes that never move, and whether each casts a shadow (design/GARAGE.md, The set). */
const FIXED_PARTS = Object.freeze({ floor: false, shell: true, dressing: true, neon: false, lightbox: false });

const contact = [0, 0, 0];
const level = [0, 0, 0, 1];
const turn = [0, 0, 0, 1];
const middle = [0, 0, 0];

/**
 * Where a car must be put for its tyres to stand on a level surface.
 * @param {number[]} outPos    position of the vehicle frame's origin
 * @param {number[]} outQuat   its orientation
 * @param {{localPos: number[]}[]} wheels  the four wheels (front left, front right, rear left,
 *   rear right): their centres in the vehicle frame, as the suspension holds them
 * @param {number[]} radii     tyre radius of each wheel
 * @param {number[]} spot      the point of the surface that the middle of the four contact patches stands on
 * @param {number} yaw         heading of the car
 */
export function standingPose(outPos, outQuat, wheels, radii, spot, yaw) {
  // The plane through the contact patches, in the vehicle frame: y = height + sx x + sz z.
  // Front against rear gives its slope along the car, left against right across it.
  let frontY = 0, rearY = 0, leftY = 0, rightY = 0, frontZ = 0, rearZ = 0, leftX = 0, rightX = 0;
  middle[0] = 0; middle[1] = 0; middle[2] = 0;
  for (let i = 0; i < 4; i++) {
    const p = wheels[i].localPos, y = p[1] - radii[i];
    if (i < 2) { frontY += y; frontZ += p[2]; } else { rearY += y; rearZ += p[2]; }
    if (i % 2 === 0) { leftY += y; leftX += p[0]; } else { rightY += y; rightX += p[0]; }
    middle[0] += p[0] / 4; middle[1] += y / 4; middle[2] += p[2] / 4;
  }
  const sz = (frontY - rearY) / (frontZ - rearZ), sx = (leftY - rightY) / (leftX - rightX);
  // The rotation that stands the plane's normal upright: the shortest one, about the level
  // axis square to it, written as the quaternion between the two directions.
  const length = Math.hypot(sx, 1, sz), nx = -sx / length, ny = 1 / length, nz = -sz / length;
  const norm = Math.hypot(nz, nx, 1 + ny);
  level[0] = -nz / norm; level[1] = 0; level[2] = nx / norm; level[3] = (1 + ny) / norm;
  quatMul(outQuat, quatFromYaw(turn, yaw), level);
  quatRotate(contact, outQuat, middle);
  outPos[0] = spot[0] - contact[0]; outPos[1] = spot[1] - contact[1]; outPos[2] = spot[2] - contact[2];
}

/**
 * @param {object} deps
 * @param {object} deps.renderer
 * @param {number[]} deps.origin  where the set stands in the world
 */
export function createShowroom({ renderer, origin }) {
  let set = null, kit = null;
  const meshes = [];
  const statics = [];
  let turntable = null, door = null;
  let records = null, groups = null, glows = null, budget = -1;
  let angle = 0;
  let doorTime = -1; // seconds since the door began to rise, negative while it is shut
  let doorProbe = 0;
  // With the door rising the turntable does what a garage turntable is for: it turns the car
  // to face the way out, the shorter way round, and stops.
  let alignFrom = 0, alignTurn = 0;
  let building = false, gain = 1, gainSettled = true;
  const spot = [0, 0, 0];
  const boxRadiance = [0, 0, 0];
  const ambient = [0, 0, 0];

  const showroom = {
    /** True once a set is in the renderer. */
    ready: false,
    /** Whether the set is the bare stand-in room. */
    standIn: false,
    /** The set's anchors, in its own frame; null until loaded. */
    anchors: null,
    /** Where the car is drawn: the arrays a staged player reads (player.stage). */
    carPos: [0, 0, 0],
    carQuat: [0, 0, 0, 1],
    /** The room as the renderer and the reflections read it (frame.room); null until loaded. */
    room: null,
    /** World height of the floor, and the point the room's reflections are captured from. */
    floorY: origin[1],
    probe: [origin[0], origin[1] + 1.1, origin[2]],
    /** 0 shut .. 1 fully raised. */
    get doorOpening() { return doorTime < 0 ? 0 : saturate(doorTime / DOOR_SECONDS); },
    /** Radians the turntable has turned since the garage was entered. */
    get angle() { return angle; },

    /**
     * Puts a built set into the renderer.
     * @param {{set: object, lightRecords: Function, glowRecords: Function}} built  from buildGarageSet
     */
    load(built) {
      set = built.set; kit = built;
      const anchors = set.anchors;
      for (const name in FIXED_PARTS) {
        const data = set.meshes[name];
        // A part with nothing in it yet (the dressing, while the set is being made) is left out.
        if (!data || data.indices.length === 0) continue;
        const mesh = renderer.createMesh(data);
        meshes.push(mesh);
        statics.push(renderer.addStatic({ mesh, origin, castShadow: FIXED_PARTS[name], interior: true }));
      }
      const moving = (data) => {
        const mesh = renderer.createMesh(data);
        meshes.push(mesh);
        // `fixture`: a moving part of the room, which belongs in the room's reflections; the
        // renderer leaves out of them only the vehicle standing where they are captured from.
        return renderer.addDynamic({ mesh, castShadow: false, interior: true, fixture: true });
      };
      turntable = moving(set.meshes.turntable);
      door = moving(set.meshes.door);

      const world = (p) => [origin[0] + p[0], origin[1] + p[1], origin[2] + p[2]];
      const box = anchors.lightBox, look = anchors.look;
      for (let i = 0; i < 3; i++) { boxRadiance[i] = box.radiance[i]; ambient[i] = look.ambient[i]; }
      showroom.room = {
        min: world(anchors.room.min), max: world(anchors.room.max), version: 0,
        lightBox: { centre: world(box.centre), u: box.u.slice(), v: box.v.slice(), radiance: boxRadiance.slice() },
        ambient: ambient.slice(), haze: look.haze,
      };
      showroom.floorY = origin[1] + anchors.floor.y;
      showroom.probe = world(anchors.probe.position);
      showroom.anchors = anchors;
      showroom.standIn = Boolean(set.standIn);
      showroom.ready = true;
      budget = -1;
      showroom.enter();
    },

    /** On entering the garage: the door shut, the lights up, the turntable where it begins. */
    enter() {
      angle = 0; doorTime = -1; doorProbe = 0;
      building = false; gain = 1; gainSettled = true;
      if (showroom.room) showroom.room.version++;
      pose();
    },

    /** The door starts to rise, and the turntable brings the car round to face it. */
    openDoor() {
      if (doorTime >= 0) return;
      doorTime = 0; doorProbe = 0;
      const anchors = showroom.anchors, opening = anchors.door.opening, centre = anchors.turntable.centre;
      const exit = Math.atan2((opening.min[0] + opening.max[0]) / 2 - centre[0], (opening.min[2] + opening.max[2]) / 2 - centre[2]);
      alignFrom = angle;
      alignTurn = angleDelta(anchors.car.yaw + angle, exit);
      showroom.room.version++;
    },

    /** The room's lights dip while a car is being built, and come back when it stands there. */
    setBuilding(on) {
      if (on === building) return;
      building = on;
      gainSettled = false;
      if (showroom.room) showroom.room.version++;
    },

    /**
     * One frame: the turntable, the door, the lights' level, and the car's place.
     * @param {number} dt
     * @param {object} player  the car on show (createPlayer), staged on carPos and carQuat
     */
    update(dt, player) {
      const room = showroom.room;
      if (doorTime < 0) angle = (angle + TURNTABLE_RATE * dt) % TAU;
      if (doorTime >= 0 && doorTime < DOOR_SECONDS) {
        doorTime = Math.min(DOOR_SECONDS, doorTime + dt);
        angle = alignFrom + alignTurn * smoothstep(0, ALIGN_SECONDS, doorTime);
        doorProbe += dt;
        // The light through the opening changes what the room reflects: often enough to follow
        // it, not every frame.
        if (doorProbe >= DOOR_PROBE_INTERVAL || doorTime >= DOOR_SECONDS) { doorProbe = 0; room.version++; }
      }
      if (!gainSettled) {
        const target = building ? DIP : 1;
        gain = damp(gain, target, DIP_HALF_LIFE, dt);
        if (Math.abs(gain - target) < 0.01) { gain = target; gainSettled = true; room.version++; }
        for (let i = 0; i < 3; i++) { room.lightBox.radiance[i] = boxRadiance[i] * gain; room.ambient[i] = ambient[i] * gain; }
      }
      pose();
      const anchors = showroom.anchors;
      // The car turns with the disc, about the disc's centre.
      const centre = anchors.turntable.centre, at = anchors.car.position;
      const dx = at[0] - centre[0], dz = at[2] - centre[2], c = Math.cos(angle), s = Math.sin(angle);
      spot[0] = origin[0] + centre[0] + dx * c + dz * s;
      spot[1] = origin[1] + at[1];
      spot[2] = origin[2] + centre[2] - dx * s + dz * c;
      standingPose(showroom.carPos, showroom.carQuat, player.vehicle.wheels, player.kit.wheelRadius, spot, anchors.car.yaw + angle);
    },

    /**
     * The room's lights and glows for this frame, after the car's lamps, which the list holds
     * already with the headlamp beams first. Of those it keeps as many as the room leaves.
     * @param {object} lamps  the frame's LampBuffer
     * @param {number} limit  light records the renderer takes in an interior frame
     */
    writeLights(lamps, limit) {
      if (limit !== budget) {
        budget = limit;
        // The set picks its most telling lights for the number it is given.
        const made = kit.lightRecords(set, Math.max(limit - CAR_LIGHTS, 0), origin);
        records = made.records; groups = made.groups;
        glows = kit.glowRecords(set, origin);
      }
      lamps.lightCount = Math.min(lamps.lightCount, limit - groups.length);
      const opening = showroom.doorOpening, shut = showroom.anchors.door.closedGain || 0;
      // What comes through the door grows with the opening; everything dips together.
      const doorGain = (shut + (1 - shut) * opening) * gain;
      for (let i = 0; i < groups.length; i++) lamps.lightRecord(records, i, groups[i] === 'door' ? doorGain : gain);
      lamps.glowRecords(glows, gain);
    },

    dispose() {
      for (const id of statics) renderer.remove(id);
      if (turntable) turntable.remove();
      if (door) door.remove();
      for (const mesh of meshes) renderer.destroyMesh(mesh);
      statics.length = 0; meshes.length = 0;
      turntable = null; door = null;
      showroom.ready = false;
    },
  };

  /** The disc and the door where the frame has them. */
  function pose() {
    if (!showroom.ready) return;
    const anchors = showroom.anchors, centre = anchors.turntable.centre;
    m4fromYawPos(turntable.matrix, angle, origin[0] + centre[0], origin[1] + centre[1], origin[2] + centre[2]);
    const rise = showroom.doorOpening * anchors.door.travel, axis = anchors.door.axis;
    m4fromYawPos(door.matrix, 0, origin[0] + axis[0] * rise, origin[1] + axis[1] * rise, origin[2] + axis[2] * rise);
  }

  return showroom;
}
