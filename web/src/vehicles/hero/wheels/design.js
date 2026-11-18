// Dimensions of the road wheels, tyres and brakes, in millimetres in the wheel frame: origin at the wheel centre
// (the middle of the tyre's width, on the axle), +X along the axle out of the car, radius measured from the axle.
// The tyre size, track, lip radius, dish and offset belong to the car (spec.js WHEEL); everything else is here.
//
// The wheel is a three-piece racing alloy of the period: a polished outer lip (a deep barrel at the rear) bolted
// with a ring of small bolts to a satin cast centre of five broad tapered spokes round a small hub, and behind the
// centre an unpainted inner barrel. The brake sits deep inside the barrel; the openings between the spokes show its
// disc and the caliper.

import { curve } from '../kit/curve.js';

const DEG = Math.PI / 180, TAU = Math.PI * 2;

/** Colours (sRGB). */
export const COLOUR = {
  alloy: [0.80, 0.805, 0.79],            // satin silver of the cast centre: pale, so that it stays bright in the dish's shade
  polished: [0.90, 0.90, 0.91],          // the mirror-polished lip
  barrel: [0.46, 0.46, 0.455],           // unpainted casting inside the rim
  steel: [0.80, 0.80, 0.82],             // plated bolts, nuts and studs
  iron: [0.5, 0.5, 0.52],                // the swept face of a brake disc
  castIron: [0.26, 0.25, 0.24],
  caliper: [0.70, 0.055, 0.04],           // gloss red
  lead: [0.42, 0.42, 0.44],
  rubber: [0.145, 0.145, 0.15],          // a shade warmer and lighter than the arch liner's black
  black: [0.03, 0.03, 0.032],
};

/**
 * Everything the builders need for one end of the car. w: spec WHEEL.front or WHEEL.rear.
 * Lengths are millimetres; angles are radians measured from +Y (up) towards +Z (forward) about the axle.
 */
export function wheelDesign(w, rear = !!(w && w.tyreWidth > 300)) {
  const hw = w.tyreWidth / 2, R = w.tyreRadius;
  const xo = hw - 14;                                    // plane of the outer rim flange's face
  const dish = w.dish;                                   // the bolt ring lies this far behind that plane
  const xr = xo - dish;                                  // plane of the bolt ring's face
  const flange = { top: w.lip, faceIn: w.bead, wallFoot: w.bead - 4 };
  // the lip: a rolled flange, then a gently hollowed barrel down to the plane where it is bolted to the centre
  const lip = { top: flange.wallFoot - 1, foot: rear ? 184 : 188, seat: xr - 2.5, hollow: rear ? 3.5 : 1.5 };
  lip.radiusAt = (x) => { const t = Math.min(1, Math.max(0, (x - lip.seat) / (xo - 0.7 - lip.seat))); return lip.foot + (lip.top - lip.foot) * t - lip.hollow * 4 * t * (1 - t); };
  // the centre's outer ring, clamped to the lip by a circle of small bolts; its face is the plane xr
  const ring = { outer: 180.5, inner: 164, pitch: 172, bolts: w.bolts, across: 7.5, height: 3.8 };
  // the hub: a flat face for the five nuts and the cap, `sink` behind the ring's face
  const sink = rear ? 10 : 5;                            // shallow, so the spoke faces look outward and catch the light
  const hub = { radius: 72, face: xr - sink, thickness: 30, nutPitch: 56, seat: 30 };
  hub.pad = hub.face - hub.thickness;                    // the mounting face, against the brake's hat
  // five spokes, a spoke straight up, the nuts between them. Widths are half widths at a radius.
  const spoke = {
    count: 5, angle0: 0,
    halfWidth: curve([[hub.radius, 17.5], [112, 19.5], [ring.inner, 27]]),
    thickness: curve([[hub.radius, hub.thickness], [84, 27], [150, 22], [ring.inner, 22]]),
    crown: 2.2,                                          // each spoke's face falls away this much from its middle to its edge
    edge: 5.5, backEdge: 2,                              // fillets round the openings, on the face and on the back
  };
  // the openings between the spokes: from radius `inner` to `outer`, corners rounded to `corner`
  const opening = { inner: 79, outer: 156, corner: curve([[79, 9], [156, 14]]), centre: 120 };
  const face = curve([[0, hub.face], [hub.radius, hub.face], [112, hub.face + sink * 0.52], [154, xr - 0.4], [162, xr], [ring.inner, xr]]);
  const nutAngle0 = spoke.angle0 + Math.PI / spoke.count;
  // the brake: a deep hat, so that the caliper clears the back of the spokes
  const hatDepth = 32;
  const disc = { radius: rear ? 145 : 150, inner: rear ? 90 : 94, thickness: rear ? 22 : 26, plate: rear ? 6.5 : 8, hat: 74, vanes: 36 };
  disc.x = hub.pad - hatDepth - disc.thickness / 2;     // mid plane
  return {
    rear, hw, R, xo, dish, xr, flange, lip, ring, hub, spoke, opening, face, nutAngle0, disc,
    bore: 184,                                           // inside radius of the barrel behind the centre
    offset: w.offset || 0,                               // the wheel is drawn this far outboard of the hub
    pad: hub.pad,
    // the car gives the caliper's place in degrees from straight ahead towards the top; here it is from the top forwards
    caliperAngle: Math.PI / 2 - (w.caliperAngle ?? (rear ? 25 : 155)) * DEG,
    tyre: {
      shoulder: rear ? 30 : 25, crown: rear ? 2.5 : 2, depth: 7,
      grooves: rear ? [24, 66, 108] : [20, 56],          // centres of the circumferential grooves each side of the middle
      grooveWidth: rear ? 8 : 7, slot: 4.5, pitches: 64,
      brand: 'VELTRO', line: 'RADIALE', size: rear ? '345/30 VR16' : '225/45 VR16', capHeight: rear ? 22 : 20,
    },
  };
}

/**
 * How much of a short arc of the wheel's face is metal, as a camera with its shutter open while the wheel turns
 * through `blur` radians would record it: 1 on the hub and the ring, between the spokes the share of the arc centred
 * on angle a (from the top) that the spokes cover. Averaged right round (blur = a whole spoke pitch) it is the share
 * of that circle that is metal.
 */
export function spokeCover(d, r, a, blur) {
  const S = d.spoke, O = d.opening, pitch = TAU / S.count;
  if (r <= O.inner || r >= O.outer) return 1;
  const half = Math.asin(Math.min(1, S.halfWidth(r) / r));
  let da = a - S.angle0; da -= Math.round(da / pitch) * pitch;
  // overlap of the arc [da - blur/2, da + blur/2] with the spoke at 0 and with its neighbours either side
  let on = 0;
  for (const c of [-pitch, 0, pitch]) on += Math.max(0, Math.min(da + blur / 2, c + half) - Math.max(da - blur / 2, c - half));
  const ends = Math.min(1, (r - O.inner) / O.corner(r)) * Math.min(1, (O.outer - r) / O.corner(r));     // the openings' rounded ends
  return 1 - (1 - Math.min(1, on / blur)) * ends * ends * (3 - 2 * ends);
}
