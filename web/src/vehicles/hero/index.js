// The player's car: the Lucera, a mid-engined V12 wedge of the mid-1980s. Our own design, name and emblem.
//
// buildHeroCar() assembles the model record of design/ARCHITECTURE.md 10.1. The car is symmetric apart from the
// driving position, so everything that can be is built as the left half (+X) and mirrored; the controls, wiper,
// emblem, script and number plate are then added once. Lamp, exhaust and plate anchors are returned by the functions
// that place the geometry, so there is no second table of positions to drift out of step.
//
// The record is plain data (typed arrays and objects) because it is built in a worker and posted to the page.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, VEHICLE } from '../../core/ids.js';
import * as S from './spec.js';
import { compact } from './kit/solids.js';
import { makeHull } from './shell.js';
import { buildCoachwork, buildFloor, buildLampLid, buildLampWell, topPoint } from './body.js';
import { buildArches } from './arches.js';
import { buildFascia, noseUnderside } from './fascia.js';
import { buildTail } from './tail.js';
import { buildVents } from './vents.js';
import { buildFrontLamps, buildLampPod } from './lamps.js';
import { mirrorLampCircuits } from './lamps/optics.js';
import { buildGreenhouse, mirrorWiperSweep } from './greenhouse.js';
import { buildCabin, buildControls, driverEye } from './interior.js';
import { buildSideDetails, buildCentreDetails } from './details.js';
import { buildWheel, buildWheelBlur, buildCaliper } from './wheels.js';

export const MODEL_NAME = 'Lucera';

const MM = S.MM;
const MIRROR = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const mirrored = (p) => [-p[0], p[1], p[2]];

/** Tessellation of the full model and of the reduced one used for reflections and far shadows. */
const FULL = { da: 20, db: 0.23, fillet: 5, hems: true, arch: 22, flare: 14, fascia: 45, wheel: 1, cabin: true };
const REDUCED = { da: 150, db: 1.7, fillet: 1, hems: false, arch: 110, flare: 4, fascia: 160, wheel: 0.2, cabin: false };

/**
 * A stand-in for the glass builder of the reduced model: panes go into the body mesh as gloss black, so the reduced
 * car is one closed, opaque mesh. Only the material and colour calls are replaced.
 */
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

/** Body and glass at one level of tessellation, with the anchors of everything placed on the way. */
function assemble(quality) {
  const hull = makeHull(quality.fillet), half = new MeshBuilder(60000), glassHalf = new MeshBuilder(4000);
  half.family(FAMILY.VEHICLE); glassHalf.family(FAMILY.GLASS);
  const panes = quality.cabin ? glassHalf : blackedOut(half);

  buildCoachwork(half, hull, quality);
  const arches = buildArches(half, hull, quality);
  const nose = buildFascia(half, quality.cabin ? glassHalf : null, hull, quality, arches.front.floorLine);
  const rear = buildTail(half, quality.cabin ? glassHalf : null, hull);
  buildVents(half, hull);
  const front = buildFrontLamps(half, quality.cabin ? glassHalf : null, hull);
  const canopy = buildGreenhouse(half, panes, hull, quality);
  if (quality.cabin) { buildCabin(half, canopy); buildSideDetails(half, hull); }
  buildFloor(half, hull, { front: arches.front.footprint, rear: arches.rear.footprint }, noseUnderside(hull).end, quality);

  // The pop-up headlamp pod is a part of its own, built closed; the runtime turns it about the hinge.
  let pods = null;
  if (quality.hems) {
    const pod = new MeshBuilder(6000); pod.family(FAMILY.VEHICLE);
    buildLampLid(pod, hull, quality);
    const cavity = buildLampWell(half, hull), unit = buildLampPod(pod, hull, cavity);
    const right = new MeshBuilder(pod.count); right.family(FAMILY.VEHICLE);
    right.append(pod, MIRROR);
    pods = { left: pod.finish(), right: right.finish(), cavity, headlamps: unit.headlamps, beam: unit.dir };
  }

  const body = new MeshBuilder(half.count * 2 + 8000); body.family(FAMILY.VEHICLE);
  body.append(half); appendMirrored(body, half);
  let plates = null;
  if (quality.cabin) { buildControls(body); plates = buildCentreDetails(body, hull, canopy); }
  const glass = new MeshBuilder(glassHalf.count * 2 + 16); glass.family(FAMILY.GLASS);
  glass.append(glassHalf); appendMirrored(glass, glassHalf, true); mirrorWiperSweep(glass, glassHalf.count, hull);
  return { body: compact(body.finish()), glass: compact(glass.finish()), front, rear, plates, hull, pods, fog: nose.fog };
}

/**
 * Factory colours as [r, g, b, finish]: linear colour and 0 solid, 1 metallic, 2 pearl. The first is the car's
 * default: a deep metallic red, then white, metallic black, yellow and pearl teal.
 */
export const FACTORY_PAINTS = [[0.50, 0.010, 0.004, 1], [0.72, 0.71, 0.68, 0], [0.012, 0.012, 0.014, 1], [0.62, 0.37, 0.006, 0], [0.02, 0.30, 0.29, 2]];

/** Both sides of a list of left-hand entries, left first. */
const bothSides = (left, mirrorEntry) => [...left, ...left.map(mirrorEntry)];

function makeAnchors({ front, rear, plates, hull, pods, fog }) {
  const F = S.WHEEL.front, R = S.WHEEL.rear, frontZ = (S.ORIGIN_X - S.FRONT_AXLE_X) * MM, rearZ = (S.ORIGIN_X - S.REAR_AXLE_X) * MM;
  const lamp = (a) => ({ pos: a.pos, size: Math.max(a.size[0], a.size[1]), extent: a.size });
  const lampPair = (a) => bothSides([lamp(a)], (e) => ({ ...e, pos: mirrored(e.pos) }));
  const cowl = topPoint(hull, S.WINDSCREEN.baseX - 40, 0, 0);
  return {
    wheels: {
      fl: [F.track / 2 * MM, F.axleY * MM, frontZ], fr: [-F.track / 2 * MM, F.axleY * MM, frontZ],
      rl: [R.track / 2 * MM, R.axleY * MM, rearZ], rr: [-R.track / 2 * MM, R.axleY * MM, rearZ],
    },
    // four lamps in the two pods, given with the pods OPEN: the runtime lights them only when the pods are up
    headlamps: bothSides(pods.headlamps.map((pos) => ({ pos, dir: pods.beam })), (e) => ({ pos: mirrored(e.pos), dir: e.dir })),
    tailLamps: lampPair(rear.tail), brakeLamps: lampPair(rear.brake), reverseLamps: lampPair(rear.reverse),
    indicators: { fl: front.indicator, fr: mirrored(front.indicator), rl: rear.indicator.pos, rr: mirrored(rear.indicator.pos) },
    // Both pods turn the same way about the same transverse axis: positive angles raise the lid's front edge.
    lampPods: {
      left: { hinge: pods.cavity.hinge, axis: pods.cavity.axis, openAngle: pods.cavity.openAngle },
      right: { hinge: mirrored(pods.cavity.hinge), axis: pods.cavity.axis, openAngle: pods.cavity.openAngle },
    },
    sideMarkers: bothSides([front.marker, front.rearMarker], mirrored),
    fogLamps: bothSides([{ pos: fog.centre, dir: fog.dir }], (e) => ({ pos: mirrored(e.pos), dir: e.dir })),
    plateLamps: plates.plateLamps,
    exhausts: bothSides(rear.exhausts, (e) => ({ pos: mirrored(e.pos), dir: mirrored(e.dir) })),
    plateFront: plates.plateFront, plateRear: plates.plateRear,
    driverEye: driverEye(),
    // over the scuttle, just ahead of the screen: the bonnet fills the bottom of the frame
    bonnetCam: [0, cowl[1] + 0.12, cowl[2]],
    // engine and gearbox sit between the cabin and the rear axle: 42 % of the weight on the front wheels
    centreOfMass: [0, 0.43, frontZ + (rearZ - frontZ) * 0.58],
  };
}

/**
 * Build the hero car.
 * @param {{detail?: number, paint?: number[]}} [options]  detail scales the wheel tessellation only (1 = full);
 *   paint is an [r, g, b, finish] entry put ahead of the factory colours, so it becomes the car's default.
 * @returns the vehicle model record of ARCHITECTURE 10.1, as structured-cloneable data.
 */
export function buildHeroCar({ detail = 1, paint = null } = {}) {
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
      // Brake calipers do not turn with the wheel: draw them with the wheel's transform without its spin.
      caliperFront: buildCaliper(F), caliperRear: buildCaliper(R),
      // The wheels as they look at speed; the runtime swaps them in above a set rate of spin.
      wheelFrontBlur: buildWheelBlur(F), wheelRearBlur: buildWheelBlur(R),
      // Headlamp pods, closed, in the vehicle frame: draw each turned about anchors.lampPods while the lamps are on.
      lampPodLeft: full.pods.left, lampPodRight: full.pods.right,
      extras: {},
    },
    lods: [{ body: reduced.body, wheelFront: buildWheel(F, REDUCED.wheel), wheelRear: buildWheel(R, REDUCED.wheel), far: Infinity }],
    anchors: makeAnchors(full),
    collider: { halfExtents: [S.WIDTH * MM / 2, (height - clearance) / 2, (noseZ - tailZ) / 2], centre: [0, (height + clearance) / 2, (noseZ + tailZ) / 2] },
    paints: paint ? [paint, ...FACTORY_PAINTS] : FACTORY_PAINTS,
  };
}
