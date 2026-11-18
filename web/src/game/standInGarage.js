// A bare room in the shape of the garage set, used when the real set (src/world/garage/) cannot
// be loaded: four walls with a door opening, a floor, a turntable disc, a door panel, a few
// lights. It follows the set's contract (design/GARAGE.md, Interfaces), so the garage phase
// runs the same code against either.
//
// The frame is the set's: metres, origin at the centre of the turntable on the finished floor,
// +Z the street side with the roller door, the car standing at the origin.

import { FAMILY, SOLID, CHANNEL, LIGHT_STRIDE } from '../core/ids.js';
import { MeshBuilder } from '../core/mesh.js';
import { TAU } from '../core/math.js';

const HALF_WIDTH = 7, HALF_DEPTH = 9, HEIGHT = 4.5;
const DOOR_HALF = 2.2, DOOR_TOP = 3.6, DOOR_TRAVEL = 3.45;
const DISC_RADIUS = 2.5, DISC_TOP = 0.06, DISC_SIDES = 64;
const BOX_HALF = [2.3, 1.15], BOX_Y = 3.3;

/** One rectangle seen from the side its normal points to; corners counter-clockwise from there. */
function wall(mb, a, b, c, d, normal) {
  const ids = [a, b, c, d].map((p) => mb.vertex(p[0], p[1], p[2], normal[0], normal[1], normal[2], p[0] + p[2], p[1]));
  mb.quad(ids[0], ids[1], ids[2], ids[3]);
}

function buildShell() {
  const mb = new MeshBuilder(64), w = HALF_WIDTH, d = HALF_DEPTH, h = HEIGHT;
  mb.family(FAMILY.SOLID).material(SOLID.PAINT, 200, 40, 3).color(0.32, 0.33, 0.36);
  wall(mb, [-w, 0, -d], [w, 0, -d], [w, h, -d], [-w, h, -d], [0, 0, 1]); // back
  wall(mb, [-w, 0, d], [-w, 0, -d], [-w, h, -d], [-w, h, d], [1, 0, 0]);
  wall(mb, [w, 0, -d], [w, 0, d], [w, h, d], [w, h, -d], [-1, 0, 0]);
  // The street wall around the door opening: left, right, and the lintel above it.
  wall(mb, [w, 0, d], [DOOR_HALF, 0, d], [DOOR_HALF, h, d], [w, h, d], [0, 0, -1]);
  wall(mb, [-DOOR_HALF, 0, d], [-w, 0, d], [-w, h, d], [-DOOR_HALF, h, d], [0, 0, -1]);
  wall(mb, [DOOR_HALF, DOOR_TOP, d], [-DOOR_HALF, DOOR_TOP, d], [-DOOR_HALF, h, d], [DOOR_HALF, h, d], [0, 0, -1]);
  mb.material(SOLID.PAINT, 230, 60, 5).color(0.1, 0.1, 0.11);
  wall(mb, [-w, h, -d], [w, h, -d], [w, h, d], [-w, h, d], [0, -1, 0]); // ceiling
  return mb.finish();
}

function buildFloor() {
  const mb = new MeshBuilder(4), w = HALF_WIDTH, d = HALF_DEPTH;
  mb.family(FAMILY.SOLID).material(SOLID.CONCRETE, 30, 60, 1).color(0.12, 0.12, 0.13);
  wall(mb, [-w, 0, d], [w, 0, d], [w, 0, -d], [-w, 0, -d], [0, 1, 0]);
  return mb.finish();
}

function buildTurntable() {
  const mb = new MeshBuilder(DISC_SIDES * 3 + 1);
  mb.family(FAMILY.SOLID).material(SOLID.RUBBER, 220, 0, 2).color(0.06, 0.06, 0.065);
  const centre = mb.vertex(0, DISC_TOP, 0, 0, 1, 0, 0, 0);
  for (let i = 0; i < DISC_SIDES; i++) {
    const a = (i / DISC_SIDES) * TAU;
    mb.vertex(Math.sin(a) * DISC_RADIUS, DISC_TOP, Math.cos(a) * DISC_RADIUS, 0, 1, 0, Math.sin(a), Math.cos(a));
  }
  for (let i = 0; i < DISC_SIDES; i++) mb.tri(centre, centre + 1 + i, centre + 1 + ((i + 1) % DISC_SIDES));
  mb.material(SOLID.METAL_BARE, 90, 0, 4).color(0.6, 0.6, 0.62);
  for (let i = 0; i < DISC_SIDES; i++) {
    const a = (i / DISC_SIDES) * TAU, b = ((i + 1) / DISC_SIDES) * TAU;
    const pa = [Math.sin(a) * DISC_RADIUS, Math.cos(a) * DISC_RADIUS], pb = [Math.sin(b) * DISC_RADIUS, Math.cos(b) * DISC_RADIUS];
    const m = (a + b) / 2;
    wall(mb, [pa[0], 0, pa[1]], [pb[0], 0, pb[1]], [pb[0], DISC_TOP, pb[1]], [pa[0], DISC_TOP, pa[1]], [Math.sin(m), 0, Math.cos(m)]);
  }
  return mb.finish();
}

function buildDoor() {
  const mb = new MeshBuilder(4), z = HALF_DEPTH - 0.04;
  mb.family(FAMILY.SOLID).material(SOLID.METAL_PAINTED, 150, 30, 6).color(0.45, 0.46, 0.48);
  wall(mb, [DOOR_HALF + 0.1, 0, z], [-DOOR_HALF - 0.1, 0, z], [-DOOR_HALF - 0.1, DOOR_TOP + 0.1, z], [DOOR_HALF + 0.1, DOOR_TOP + 0.1, z], [0, 0, -1]);
  return mb.finish();
}

/**
 * The stand-in set: plain data, the same every time.
 * @returns {object} { standIn: true, meshes, lights, anchors } as `buildGarage` of src/world/garage
 */
export function buildGarage() {
  const w = HALF_WIDTH, d = HALF_DEPTH;
  return {
    standIn: true,
    meshes: { floor: buildFloor(), shell: buildShell(), turntable: buildTurntable(), door: buildDoor() },
    // Colour is linear rgb times intensity. Lowest priority number first.
    lights: [
      { kind: 'point', position: [0, BOX_Y - 0.3, 0], color: [150, 160, 175], range: 14, group: 'box', priority: 0 },
      { kind: 'point', position: [-w + 0.6, 2.6, 0], color: [90, 4, 60], range: 12, group: 'side-magenta', priority: 0 },
      { kind: 'point', position: [w - 0.6, 2.6, 0], color: [3, 70, 90], range: 12, group: 'side-cyan', priority: 0 },
      { kind: 'point', position: [0, 3.2, -d + 0.6], color: [90, 30, 12], range: 12, group: 'sign-sun', priority: 1 },
      { kind: 'point', position: [0, 1.4, d + 0.8], color: [60, 34, 50], range: 11, group: 'door', priority: 1 },
    ],
    anchors: {
      car: { position: [0, DISC_TOP, 0], yaw: Math.PI / 2 },
      turntable: { centre: [0, 0, 0], radius: DISC_RADIUS, axis: [0, 1, 0], top: DISC_TOP },
      door: { opening: { min: [-DOOR_HALF, 0, d], max: [DOOR_HALF, DOOR_TOP, d] }, travel: DOOR_TRAVEL, axis: [0, 1, 0], closedGain: 0.04 },
      camera: {
        min: [-w + 1.2, 0.25, -d + 2], max: [w - 1.2, 2.6, d - 1.2],
        orbit: { centre: [0, 0.6, 0], minRadius: 4.4, maxRadius: 6.4, minHeight: 0.5, maxHeight: 2.4 },
      },
      lightBox: { centre: [0, BOX_Y, 0], u: [BOX_HALF[0], 0, 0], v: [0, 0, BOX_HALF[1]], normal: [0, -1, 0], radiance: [2.75, 2.98, 3.2] },
      room: { min: [-w, 0, -d], max: [w, HEIGHT, d] },
      probe: { min: [-w, 0, -d], max: [w, HEIGHT, d], position: [0, 1.1, 0] },
      floor: { y: 0, min: [-w, -d], max: [w, d] },
      swept: { radius: 3, height: 1.75 },
      look: { ambient: [0.02, 0.02, 0.024], haze: 0.25 },
    },
  };
}

/**
 * The set's lights as light records in the world, most important first.
 * @param {object} set        from buildGarage
 * @param {number} maxLights  never more records than this
 * @param {number[]} origin   where the set stands in the world
 * @returns {{records: Float32Array, groups: string[]}} groups[i] names the group of record i
 */
export function lightRecords(set, maxLights, origin) {
  const lights = set.lights.slice().sort((a, b) => a.priority - b.priority).slice(0, maxLights);
  const records = new Float32Array(lights.length * LIGHT_STRIDE);
  lights.forEach((light, i) => {
    const o = i * LIGHT_STRIDE, p = light.position, c = light.color;
    records[o] = origin[0] + p[0]; records[o + 1] = origin[1] + p[1]; records[o + 2] = origin[2] + p[2]; records[o + 3] = light.range;
    records[o + 4] = c[0]; records[o + 5] = c[1]; records[o + 6] = c[2];
    records[o + 9] = -1; records[o + 11] = -1; records[o + 12] = -1; records[o + 13] = CHANNEL.ALWAYS;
  });
  return { records, groups: lights.map((light) => light.group) };
}

/** The set's glow records in the world: the stand-in has no tubes, so none. */
export function glowRecords() {
  return new Float32Array(0);
}
