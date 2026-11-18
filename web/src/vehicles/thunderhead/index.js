// The Thunderhead: a front-engined American V8 two-seater of 1986 with a plastic body, a clamshell bonnet and a
// glass hatch. Our own design, name and emblem.
//
// buildCar() assembles the model record of design/ARCHITECTURE.md 10.1. Everything that can be is built as the left
// half (+X) and mirrored. The record is plain data because it is built in a worker and posted to the page.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, VEHICLE } from '../../core/ids.js';
import * as S from './spec.js';
import { makeHull } from './shell.js';
import { buildCoachwork, buildFloor, buildLampLid, topPoint } from './body.js';
import { buildArches } from './arches.js';
import { makeScreen } from './screen.js';
import { buildGreenhouse } from './greenhouse.js';
import { makeNoseSheet, makeTailSheet, deckSeam, buildFrontBumper, buildTail, buildRubStrip } from './bumpers.js';
import { buildCabin, buildControls, driverEye } from './cabin.js';
import { buildLampWell, buildLampPod, buildFrontLamps, buildTailLamps, buildStopLamp, buildSideMarkers } from './lamps.js';
import { buildSideDetails, buildCentreDetails } from './details.js';
import { compact } from '../hero/kit/solids.js';
import { mirrorLampCircuits } from '../hero/lamps/optics.js';
import { buildWheel, buildWheelBlur, buildCaliper } from './wheels.js';

export const MODEL_NAME = 'Thunderhead';

const MM = S.MM;
const MIRROR = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Tessellation of the full model and of the reduced one used for reflections and far shadows. */
const FULL = { da: 26, db: 0.3, fillet: 4, hems: true, arch: 22, flare: 12, wheel: 1, cabin: true };
const REDUCED = { da: 150, db: 1.7, fillet: 1, hems: false, arch: 110, flare: 4, wheel: 0.2, cabin: false };

/** The builder with every material and colour forced to gloss black: how the panes go into the reduced model, which has no glass part. */
function blackedOut(body) {
  const material = () => body.material(VEHICLE.TRIM_BLACK, 12, 0), color = () => body.color(0.012, 0.014, 0.016);
  return new Proxy(body, { get: (target, key) => (key === 'material' ? material : key === 'color' ? color : typeof target[key] === 'function' ? target[key].bind(target) : target[key]) });
}

/** Copy the left half to the right. append() reverses the winding; the copied indicators must answer to their own circuit. */
function appendMirrored(mb, half, isGlass = false) {
  const first = mb.count;
  mb.append(half, MIRROR);
  mirrorLampCircuits(mb, first, isGlass);
}

/**
 * A finished mesh without its triangles of no area. Where two turned edges meet in a point the strip between them
 * closes up into triangles that draw nothing; they would still be uploaded and counted.
 */
function withoutSlivers(mesh) {
  const pos = new Float32Array(mesh.vertices), stride = mesh.vertices.byteLength / mesh.vertexCount / 4, kept = new Uint32Array(mesh.indexCount), groups = [];
  let at = 0;
  for (const g of mesh.groups) {
    const start = at;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const a = mesh.indices[i] * stride, b = mesh.indices[i + 1] * stride, c = mesh.indices[i + 2] * stride;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      if (!(Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) >= 1e-12)) continue;
      kept[at++] = mesh.indices[i]; kept[at++] = mesh.indices[i + 1]; kept[at++] = mesh.indices[i + 2];
    }
    groups.push({ ...g, start, count: at - start });
  }
  return { ...mesh, indices: kept.slice(0, at), groups, indexCount: at };
}

/** Body and glass at one level of tessellation, with the anchors of everything placed on the way. */
function assemble(quality) {
  const hull = makeHull(quality.fillet), half = new MeshBuilder(60000), glassHalf = new MeshBuilder(12000);
  half.family(FAMILY.VEHICLE); glassHalf.family(FAMILY.GLASS);
  const noseSheet = makeNoseSheet(quality.fillet), tailSheet = makeTailSheet(hull, quality.fillet);
  const screen = makeScreen(hull), { glazed } = buildCoachwork(half, hull, quality, deckSeam(tailSheet), screen);
  buildGreenhouse(half, quality.cabin ? glassHalf : blackedOut(half), hull, screen, glazed, quality);
  const arches = buildArches(half, hull, quality);
  buildFloor(half, hull, { front: arches.front.footprint, rear: arches.rear.footprint, end: S.TAIL.cornerX - 55 }, quality);
  const lensGlass = quality.cabin ? glassHalf : null;
  const bumper = buildFrontBumper(half, noseSheet, quality, arches.front.footprint[0]), tailEnd = buildTail(half, tailSheet, quality);
  const front = buildFrontLamps(half, lensGlass, bumper), rear = buildTailLamps(half, lensGlass, tailEnd.lamps);
  const fittings = buildSideDetails(half, hull, quality);
  const stop = buildStopLamp(half, hull, quality.hems), markers = buildSideMarkers(half, noseSheet, tailSheet);
  buildRubStrip(half, hull, noseSheet, tailSheet, quality);
  if (quality.cabin) buildCabin(half, hull, screen);

  // The pop-up headlamp pod is a part of its own, built shut; the runtime turns it about the hinge.
  let pods = null;
  if (quality.hems) {
    const pod = new MeshBuilder(6000); pod.family(FAMILY.VEHICLE);
    buildLampLid(pod, hull, quality);
    const cavity = buildLampWell(half, hull), unit = buildLampPod(pod, cavity);
    const right = new MeshBuilder(pod.count); right.family(FAMILY.VEHICLE);
    right.append(pod, MIRROR);
    pods = { left: compact(pod.finish()), right: compact(right.finish()), cavity, headlamps: unit.headlamps, beam: unit.dir };
  }

  const body = new MeshBuilder(half.count * 2 + 8000); body.family(FAMILY.VEHICLE);
  body.append(half); appendMirrored(body, half);
  if (quality.cabin) buildControls(body);
  // no front plate is fitted (the setting asks for a rear one only): plateFront is where one would go, between the lamp units
  const plates = quality.hems ? { ...buildCentreDetails(body, hull, screen, tailSheet, tailEnd.plateX), plateFront: bumper.slot(0, S.FRONT_LAMPS.y[0], 0) } : null;
  const glass = new MeshBuilder(glassHalf.count * 2 + 16); glass.family(FAMILY.GLASS);
  glass.append(glassHalf); appendMirrored(glass, glassHalf, true);
  return { body: compact(withoutSlivers(body.finish())), glass: compact(glass.finish()), hull, front, rear, stop, markers, pods, fittings, plates };
}

/**
 * Factory colours as [r, g, b, finish]: linear colour and 0 solid, 1 metallic, 2 pearl. The first is the car's
 * default: bright red, then white, black, silver, medium blue and gold metallic.
 */
export const FACTORY_PAINTS = [[0.50, 0.010, 0.004, 0], [0.80, 0.80, 0.78, 0], [0.010, 0.010, 0.011, 0], [0.52, 0.53, 0.54, 1], [0.03, 0.13, 0.36, 1], [0.42, 0.27, 0.07, 1]];

const mirrored = (p) => [-p[0], p[1], p[2]];
/** Both sides of a list of left-hand entries, left first. */
const bothSides = (left, mirrorEntry) => [...left, ...left.map(mirrorEntry)];

function makeAnchors({ hull, front, rear, markers, pods, fittings, plates }) {
  const F = S.WHEEL.front, R = S.WHEEL.rear, frontZ = (S.ORIGIN_X - S.FRONT_AXLE_X) * MM, rearZ = (S.ORIGIN_X - S.REAR_AXLE_X) * MM;
  const lamp = (a) => ({ pos: a.pos, size: Math.max(a.size[0], a.size[1]), extent: a.size });
  const lamps = (list) => bothSides(list.map(lamp), (e) => ({ ...e, pos: mirrored(e.pos) }));
  const cowl = topPoint(hull, S.SCREEN_BASE_X - 40, 0);
  return {
    wheels: {
      fl: [F.track / 2 * MM, F.axleY * MM, frontZ], fr: [-F.track / 2 * MM, F.axleY * MM, frontZ],
      rl: [R.track / 2 * MM, R.axleY * MM, rearZ], rr: [-R.track / 2 * MM, R.axleY * MM, rearZ],
    },
    // four lamps in the two pods, given with the pods OPEN: the runtime lights them only when the pods are up
    headlamps: bothSides(pods.headlamps.map((pos) => ({ pos, dir: pods.beam })), (e) => ({ pos: mirrored(e.pos), dir: e.dir })),
    // all four round lamps are tail lamps; the outer pair are the stop lamps. The lamp on the hoop lights with them
    // (it is brake-lamp material) but throws no pool of its own: it stands ahead of the rear axle
    tailLamps: lamps(rear.tail), brakeLamps: lamps([rear.brake]), reverseLamps: lamps([rear.reverse]),
    indicators: { fl: front.indicator, fr: mirrored(front.indicator), rl: rear.indicator.pos, rr: mirrored(rear.indicator.pos) },
    // Both pods turn the same way about the same transverse axis: positive angles raise the lid's leading edge.
    lampPods: {
      left: { hinge: pods.cavity.hinge, axis: pods.cavity.axis, openAngle: pods.cavity.openAngle },
      right: { hinge: mirrored(pods.cavity.hinge), axis: pods.cavity.axis, openAngle: pods.cavity.openAngle },
    },
    sideMarkers: bothSides(markers, mirrored),
    fogLamps: bothSides([front.fog], (e) => ({ pos: mirrored(e.pos), dir: mirrored(e.dir) })),
    plateLamps: plates.plateLamps, plateFront: plates.plateFront, plateRear: plates.plateRear,
    exhausts: bothSides(fittings.exhausts, (e) => ({ pos: mirrored(e.pos), dir: e.dir })),
    driverEye: driverEye(),
    // over the scuttle, just ahead of the screen: the bonnet fills the bottom of the frame
    bonnetCam: [0, cowl[1] + 0.12, cowl[2]],
    // engine ahead of the cabin but behind the front axle, gearbox between the seats: 51 % of the weight on the front wheels
    centreOfMass: [0, 0.45, frontZ + (rearZ - frontZ) * 0.49],
  };
}

/**
 * Build the car.
 * @param {{detail?: number, paint?: number[]}} [options]  detail scales the wheel tessellation only (1 = full);
 *   paint is an [r, g, b, finish] entry put ahead of the factory colours, so it becomes the car's default.
 * @returns the vehicle model record of ARCHITECTURE 10.1, as structured-cloneable data.
 */
export function buildCar({ detail = 1, paint = null } = {}) {
  const full = assemble(FULL), reduced = assemble(REDUCED);
  const F = S.WHEEL.front, R = S.WHEEL.rear, noseZ = S.ORIGIN_X * MM, tailZ = (S.ORIGIN_X - S.LENGTH) * MM;
  const clearance = S.GROUND_CLEARANCE * MM, height = S.HEIGHT * MM;
  return {
    name: MODEL_NAME,
    dims: {
      length: S.LENGTH * MM, width: S.WIDTH * MM, height, wheelbase: S.WHEELBASE * MM,
      trackFront: F.track * MM, trackRear: R.track * MM, wheelRadiusFront: F.tyreRadius * MM, wheelRadiusRear: R.tyreRadius * MM,
      tyreWidthFront: F.tyreWidth * MM, tyreWidthRear: R.tyreWidth * MM, groundClearance: clearance,
      frontAxleZ: (S.ORIGIN_X - S.FRONT_AXLE_X) * MM, rearAxleZ: (S.ORIGIN_X - S.REAR_AXLE_X) * MM,
    },
    parts: {
      body: full.body, glass: full.glass,
      wheelFront: buildWheel(F, FULL.wheel * detail), wheelRear: buildWheel(R, FULL.wheel * detail),
      caliperFront: buildCaliper(F), caliperRear: buildCaliper(R),
      wheelFrontBlur: buildWheelBlur(F), wheelRearBlur: buildWheelBlur(R),
      // the slots are swept, so the right-hand wheels are their own meshes (authored in the left wheel's frame)
      wheelFrontRight: buildWheel(F, FULL.wheel * detail, -1), wheelRearRight: buildWheel(R, FULL.wheel * detail, -1),
      wheelFrontBlurRight: buildWheelBlur(F, -1), wheelRearBlurRight: buildWheelBlur(R, -1),
      // Headlamp pods, shut, in the vehicle frame: draw each turned about anchors.lampPods while the lamps are on.
      lampPodLeft: full.pods.left, lampPodRight: full.pods.right,
      extras: {},
    },
    lods: [{ body: reduced.body, wheelFront: buildWheel(F, REDUCED.wheel), wheelRear: buildWheel(R, REDUCED.wheel), far: Infinity }],
    anchors: makeAnchors(full),
    collider: { halfExtents: [S.WIDTH * MM / 2, (height - clearance) / 2, (noseZ - tailZ) / 2], centre: [0, (height + clearance) / 2, (noseZ + tailZ) / 2] },
    paints: paint ? [paint, ...FACTORY_PAINTS] : FACTORY_PAINTS,
  };
}
