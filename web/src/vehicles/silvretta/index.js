// The Silvretta Turbo: a rear-engined, turbocharged flat-six 2+2 coupe of 1986. Our own name, emblem and script.
//
// buildCar() assembles the model record of design/ARCHITECTURE.md 10.1. The car is symmetric apart from the driving
// position, so everything that can be is built as the left half (+X) and mirrored; what exists once is then added.
// Lamp, exhaust and plate anchors are returned by the functions that place the geometry.
//
// The record is plain data (typed arrays and objects) because it is built in a worker and posted to the page.

import { MeshBuilder } from '../../core/mesh.js';
import { FAMILY, VEHICLE } from '../../core/ids.js';
import * as S from './spec.js';
import { makeHull, topPoint } from './shell.js';
import { buildCoachwork, buildFloor, buildLining, buildSeals, buildGlass } from './body.js';
import { buildArches } from './arches.js';
import { buildFascia } from './fascia.js';
import { buildTail, buildPlate } from './tail.js';
import { buildHeadlamp } from './lamps.js';
import { buildSpoiler } from './spoiler.js';
import { mirrorLampCircuits } from '../hero/lamps/optics.js';
import { buildWheel, buildWheelBlur, buildCaliper } from './wheels.js';

export const MODEL_NAME = 'Silvretta Turbo';

const MM = S.MM;
const MIRROR = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const mirrored = (p) => [-p[0], p[1], p[2]];

/** Tessellation of the full model and of the reduced one used for reflections and far shadows. */
const FULL = { da: 24, db: 0.27, hems: true, arch: 22, flare: 14, fascia: 45, wheel: 1, cabin: true };
const REDUCED = { da: 150, db: 1.7, hems: false, arch: 110, flare: 4, fascia: 160, wheel: 0.2, cabin: false };

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
  const hull = makeHull(), half = new MeshBuilder(60000), glassHalf = new MeshBuilder(4000);
  half.family(FAMILY.VEHICLE); glassHalf.family(FAMILY.GLASS);

  buildCoachwork(half, hull, quality);
  const arches = buildArches(half, hull, quality);
  buildFloor(half, hull, { front: arches.front.footprint, rear: arches.rear.footprint }, quality);
  // the reduced model's windows are blacked out and its panels butt: nothing can be seen from behind
  if (quality.cabin) { buildLining(half, hull, quality); buildSeals(half, hull, quality); }
  buildGlass(quality.cabin ? glassHalf : blackedOut(half), hull, quality);
  const lampGlass = quality.cabin ? glassHalf : null;
  const nose = buildFascia(half, lampGlass, quality), tail = buildTail(half, lampGlass, quality), headlamp = buildHeadlamp(half, lampGlass);

  buildSpoiler(half, hull, quality);

  const body = new MeshBuilder(half.count * 2 + 8000); body.family(FAMILY.VEHICLE);
  body.append(half); appendMirrored(body, half);
  // what exists once: the rear plate (the full model only; the reduced one is never seen that close)
  const plate = quality.cabin ? buildPlate(body) : tail.plate;
  const glass = new MeshBuilder(glassHalf.count * 2 + 16); glass.family(FAMILY.GLASS);
  glass.append(glassHalf); appendMirrored(glass, glassHalf, true);
  return { body: body.finish(), glass: glass.finish(), hull, nose, tail: { ...tail, plate }, headlamp };
}

/**
 * Factory colours as [r, g, b, finish]: linear colour and 0 solid, 1 metallic, 2 pearl. The first is the car's
 * default: black, then red, white, silver metallic, a light blue metallic and a dark green metallic.
 */
export const FACTORY_PAINTS = [
  [0.010, 0.010, 0.011, 0], [0.50, 0.012, 0.006, 0], [0.80, 0.80, 0.77, 0],
  [0.46, 0.47, 0.48, 1], [0.10, 0.22, 0.40, 1], [0.012, 0.085, 0.045, 1],
];

/** Both sides of a list of left-hand entries, left first. */
const bothSides = (left, mirrorEntry) => [...left, ...left.map(mirrorEntry)];

function makeAnchors({ hull, nose, tail, headlamp }) {
  const F = S.WHEEL.front, R = S.WHEEL.rear, frontZ = (S.ORIGIN_X - S.FRONT_AXLE_X) * MM, rearZ = (S.ORIGIN_X - S.REAR_AXLE_X) * MM;
  const cowl = topPoint(hull, S.WINDSCREEN.baseX - 40, 0, 0);
  const lamp = (a) => ({ pos: a.pos, size: Math.max(a.extent[0], a.extent[1]), extent: a.extent });
  const pair = (a) => bothSides([lamp(a)], (e) => ({ ...e, pos: mirrored(e.pos) }));
  const beams = (b, dir = (d) => d) => bothSides([b], (e) => ({ pos: mirrored(e.pos), dir: dir(e.dir) }));
  // the stop lamp shares the tail lamp's lens: the one red field between the reversing lamp and the name band
  return {
    wheels: {
      fl: [F.track / 2 * MM, F.axleY * MM, frontZ], fr: [-F.track / 2 * MM, F.axleY * MM, frontZ],
      rl: [R.track / 2 * MM, R.axleY * MM, rearZ], rr: [-R.track / 2 * MM, R.axleY * MM, rearZ],
    },
    headlamps: beams(headlamp),
    tailLamps: pair(tail.tail), brakeLamps: pair(tail.tail), reverseLamps: pair(tail.reverse),
    indicators: { fl: nose.indicator, fr: mirrored(nose.indicator), rl: tail.indicator.pos, rr: mirrored(tail.indicator.pos) },
    // the wrapped ends of the front indicators and of the rear lamp band are the side markers
    sideMarkers: bothSides([nose.marker, tail.marker], mirrored),
    fogLamps: beams(nose.fog),
    plateLamps: beams(tail.plateLamp, mirrored),
    exhausts: [{ pos: [0.42, 0.27, (S.ORIGIN_X - S.LENGTH) * MM + 0.04], dir: [0, 0, -1] }],
    plateFront: S.toCar(S.FRONT_BUMPER.line[0][0] - 2, (S.FRONT_BUMPER.strip.y[0] + S.FRONT_BUMPER.faceTop) / 2 - 40, 0), plateRear: tail.plate,
    driverEye: [0.36, 1.08, 0.02],
    // over the scuttle, just ahead of the screen: the bonnet fills the bottom of the frame
    bonnetCam: [0, cowl[1] + 0.12, cowl[2]],
    // engine behind the rear axle: 40 % of the weight on the front wheels
    centreOfMass: [0, 0.46, frontZ + (rearZ - frontZ) * 0.60],
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
      // Brake calipers do not turn with the wheel: draw them with the wheel's transform without its spin.
      caliperFront: buildCaliper(F), caliperRear: buildCaliper(R),
      // The wheels as they look at speed; the runtime swaps them in above a set rate of spin.
      wheelFrontBlur: buildWheelBlur(F), wheelRearBlur: buildWheelBlur(R),
      extras: {},
    },
    lods: [{ body: reduced.body, wheelFront: buildWheel(F, REDUCED.wheel), wheelRear: buildWheel(R, REDUCED.wheel), far: Infinity }],
    anchors: makeAnchors(full),
    collider: { halfExtents: [S.WIDTH * MM / 2, (height - clearance) / 2, (noseZ - tailZ) / 2], centre: [0, (height + clearance) / 2, (noseZ + tailZ) / 2] },
    paints: paint ? [paint, ...FACTORY_PAINTS] : FACTORY_PAINTS,
  };
}
