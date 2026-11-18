// Traffic vehicles: the period cars, vans, lorry and bus that fill the streets (design/ARCHITECTURE.md 10.3).
//
// buildTrafficModels() returns one model record per vehicle type in the contract of sections 10.1 and 15.3:
// plain data only (packed MeshData, numbers, arrays), so the whole result can be posted from a worker.
// The array index is the vehicle type index; the first eleven entries follow the fixed order of kinds
// compact, sedan, coupe, wagon, pickup, van, taxi, police, sports, bus, truck, and further body variants
// (the mid-size sedan) come after them, reusing a kind.

import { SPECS } from './specs.js';
import { buildVehicle } from './vehicle.js';
import { buildWheel } from './wheels.js';

/** Order of kinds of the first entries of the result. */
export const TRAFFIC_KINDS = ['compact', 'sedan', 'coupe', 'wagon', 'pickup', 'van', 'taxi', 'police', 'sports', 'bus', 'truck'];

/** Camera distance (m) at which each level of detail hands over to the next. Large vehicles hold their levels longer. */
const HANDOVER = [28, 95, Infinity];

/** One model record from a description (see specs.js). `first` is the first level to build: 0 near, 1 mid. */
function buildModel(p, first) {
  const lods = [], scale = Math.max(1, (p.nose - p.tail) / 5.5);
  let anchors = null;
  for (let lv = first; lv < 3; lv++) {
    const v = buildVehicle(p, lv);
    if (!anchors) anchors = v.anchors;
    // The far level carries its wheels baked into the body and no glass of its own.
    const wheel = lv < 2 ? buildWheel(p.wheels, lv).finish() : null;
    lods.push({
      body: v.body.finish(), glass: v.glass.count ? v.glass.finish() : null,
      wheel, wheelRear: lv < 2 && p.wheelsRear ? buildWheel(p.wheelsRear, lv).finish() : wheel,
      far: lv === 2 ? Infinity : HANDOVER[lv] * scale,
    });
  }
  const height = p.H + (p.extraHeight || 0), rear = p.wheelsRear || p.wheels;
  // Overall length is measured on the mesh, bumpers included; the description's nose and tail are the sheet metal.
  const bounds = lods[0].body.bounds, noseZ = bounds[5], tailZ = bounds[2];
  // The collider is the body proper: mirrors and aerials stand outside it. A cargo body wider than its cab counts.
  const halfWidth = (p.colliderWidth || p.W) / 2;
  return {
    name: p.name, kind: p.kind, spawnWeight: p.spawnWeight, paints: p.paints, mass: p.mass,
    dims: {
      length: noseZ - tailZ, width: p.colliderWidth || p.W, height, wheelbase: p.wheelbase, trackFront: p.trackF, trackRear: p.trackR,
      wheelRadiusFront: p.wheels.R, wheelRadiusRear: rear.R, tyreWidthFront: p.wheels.w, tyreWidthRear: rear.w * (rear.dual ? 2 : 1) + (rear.dual ? 0.04 : 0),
      groundClearance: p.clearance, frontAxleZ: p.wheelbase / 2, rearAxleZ: -p.wheelbase / 2,
    },
    parts: { body: lods[0].body, glass: lods[0].glass, wheelFront: lods[0].wheel, wheelRear: lods[0].wheelRear },
    lods, anchors,
    collider: { halfExtents: [halfWidth, (height - p.clearance) / 2, (noseZ - tailZ) / 2], centre: [0, (height + p.clearance) / 2, (noseZ + tailZ) / 2] },
  };
}

/**
 * Build every traffic vehicle type.
 * @param {number} [detail=1]  1: three levels of detail (near, mid, far); 0: the near level is left out and
 *                             the mid level serves from the camera outwards, for low graphics presets.
 * @returns {object[]} model records, indexed by vehicle type
 */
export function buildTrafficModels(detail = 1) {
  return SPECS.map((make) => buildModel(make(), detail >= 1 ? 0 : 1));
}
