// Front lamps of the Lucera, the fog lamps in the bumper and the number plate lamps.
//
//   buildLampPod(pod, hull, cavity)     the pop-up headlamp unit under its lid: two round sealed-beam lamps in a
//                                       black face that hangs from the lid's front edge, side cheeks, the lid's
//                                       lining and the hinge. Built shut, as the lid is; it turns about the hinge.
//   buildFrontLamps(body, glass, hull)  the indicator and parking lamp unit let into the nose and the side markers
//   buildFogLamp(body, glass, mount)    a rectangular fog lamp in the bumper pocket
//   buildPlateLamps(body, plate)        the two lamps over the rear number plate
//
// Every builder makes the car's LEFT half and returns the anchors of what it placed (vehicle frame, metres), so that
// the game's light and glow records come from the same numbers as the geometry. `glass` may be null: the lamp is
// then one lit face without reflector or lens glass, as the reduced model wants it.
// Materials and their parameters are explained in lamps/optics.js.

import { VEHICLE } from '../../core/ids.js';
import { patch, region, ringLoft, lathe, planeFrame, frame, roundRect, box } from './kit/solids.js';
import { roundCorners } from './kit/outline.js';
import * as S from './spec.js';
import { onSide, topPoint } from './body.js';
import {
  MM, CIRCUIT, OPTICS, LENS, CHROME, sub, unit, cross, dot, axisOf, subFrame, circle, centreOf, clipByLine, bowlTint,
  loopBowl, bulb, lensFace, trim, sealedBeam, asGlass,
} from './lamps/optics.js';

export { mirrorLampCircuits } from './lamps/optics.js';
export const HEAD_WHITE = [1.0, 0.95, 0.82], AMBER = [1.0, 0.6, 0.12];

const lerp = (a, b, t) => a + (b - a) * t;
function black(mb, occlusion = 0.6, rough = 160) { mb.material(VEHICLE.TRIM_BLACK, rough, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(occlusion); }

/** Root of a falling or rising function between a and b, by bisection. */
function solve(f, a, b) {
  let fa = f(a);
  for (let k = 0; k < 40; k++) { const m = (a + b) / 2, fm = f(m); if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m; }
  return (a + b) / 2;
}

// ---------------------------------------------------------------------------------------------- pop-up headlamps

/** Headlamp unit: radius over the retaining ring, distance between the two lamp centres, clearance to the opening. */
const POD = { lampRadius: 71, pitch: 147, clearance: 0.006, sink: 0.002, lining: 8 };

/**
 * The geometry of the pod with the lid raised. cavity: see buildLampWell in body.js. Everything here is in the
 * vehicle frame, metres, with the lid OPEN; shut(p) brings a point back to where it lies when the lid is shut.
 */
function podLayout(cavity) {
  const H = cavity.hinge, A = cavity.axis, [c0, c1, c2, c3] = cavity.outline;
  const turn = (p, angle) => {                                                  // about the hinge axis, right-handed
    const c = Math.cos(angle), s = Math.sin(angle), d = sub(p, H), k = dot(A, d) * (1 - c), x = cross(A, d);
    return [H[0] + d[0] * c + x[0] * s + A[0] * k, H[1] + d[1] * c + x[1] * s + A[1] * k, H[2] + d[2] * c + x[2] * s + A[2] * k];
  };
  const raised = (p) => turn(p, cavity.openAngle), shut = (p) => turn(p, -cavity.openAngle);
  const reach = (p) => Math.hypot(p[1] - H[1], p[2] - H[2]);
  // the opening's inboard and outboard edges as lateral position (m) against distance from the hinge axis
  const edge = (a, b) => {
    const table = [];
    for (let k = 0; k <= 24; k++) { const p = cavity.lidUnder(lerp(a[0], b[0], k / 24), lerp(a[1], b[1], k / 24)); if (p[2] > H[2]) table.push([reach(p), p[0]]); }
    table.sort((p, q) => p[0] - q[0]);
    return (r) => {
      if (r <= table[0][0]) return table[0][1];
      for (let k = 1; k < table.length; k++) if (r <= table[k][0]) return lerp(table[k - 1][1], table[k][1], (r - table[k - 1][0]) / (table[k][0] - table[k - 1][0]));
      return table[table.length - 1][1];
    };
  };
  const inner = edge(c0, c3), outer = edge(c1, c2);
  /** Lateral position of a cheek at a point of the (y, z) plane: it clears the opening wherever it passes through. */
  const cheekX = (side, y, z) => (side < 0 ? inner(Math.hypot(y - H[1], z - H[2])) + POD.clearance : outer(Math.hypot(y - H[1], z - H[2])) - POD.clearance);
  const drawingX = (z) => S.ORIGIN_X - z / MM;
  /** Height of the raised lid's inner face over lateral position x at station z. */
  const lidY = (x, z) => { const at = solve((d) => raised(cavity.lidUnder(d, x / MM))[2] - z, c0[0], c3[0]); return raised(cavity.lidUnder(at, x / MM))[1]; };
  /** Height of the wing's skin beside the opening, less a little so that the pod's skirt hides inside the opening. */
  const sillY = (x, z) => cavity.lidUnder(drawingX(z), x / MM)[1] - POD.sink;
  /** A cheek's top and bottom at station z: [[x, y, z] top, [x, y, z] bottom]. */
  const cheek = (side, z) => {
    let x = cheekX(side, H[1], z), top = 0, bottom = 0;
    for (let k = 0; k < 2; k++) { top = lidY(x, z); x = cheekX(side, top, z); }
    bottom = sillY(x, z);
    return [[x, top, z], [cheekX(side, bottom, z), bottom, z]];
  };
  // the face stands upright as far forward as the swing of the pod allows
  const limit = cavity.swing - 0.002, zEdge = cavity.lidUnder(c0[0], (c0[1] + c1[1]) / 2)[2];
  const faceZ = solve((z) => Math.max(reach(cheek(-1, z)[1]), reach(cheek(1, z)[1])) - limit, H[2] + 0.1, zEdge);
  // the cheeks begin where the raised lid first stands clear of the wing
  const startZ = (side) => solve((z) => { const [t, b] = cheek(side, z); return t[1] - b[1] - 0.003; }, H[2], faceZ);
  return { raised, shut, cheek, lidY, faceZ, startZ, reach };
}

/**
 * The headlamp unit of the left pop-up pod. pod: the builder that already holds the lid's skin, in the vehicle
 * family and in the shut position; it is left in the vehicle family. cavity: the record returned by buildLampWell.
 * Returns { headlamps: [inboard, outboard] lens centres with the lid OPEN, dir: the way the beams point }.
 */
export function buildLampPod(pod, hull, cavity) {
  const L = podLayout(cavity), [c0, c1, c2, c3] = cavity.outline, z = L.faceZ;
  const [inTop, inBottom] = L.cheek(-1, z), [outTop, outBottom] = L.cheek(1, z);

  // --- lining of the lid: its inner face, inside the rolled edge
  black(pod, 0.5, 175);
  const lining = [], g = POD.lining;
  for (let i = 0; i <= 6; i++) {
    const x = lerp(c0[0] + g, c3[0] - g, i / 6), t = (x - c0[0]) / (c3[0] - c0[0]), a = lerp(c0[1], c3[1], t) + g, b = lerp(c1[1], c2[1], t) - g, row = [];
    for (let j = 0; j <= 4; j++) row.push(cavity.lidUnder(x, lerp(a, b, j / 4)));
    lining.push(row);
  }
  patch(pod, lining, { facing: [0, -1, 0], crease: 50 });

  // --- face: a black panel between the cheeks, from the lid down into the opening, with the two lamps in it
  const origin = [(inBottom[0] + outBottom[0]) / 2, Math.max(inBottom[1], outBottom[1]), z];
  const face = (u, v, w = 0) => L.shut([origin[0] + u * MM, origin[1] + v * MM, origin[2] + w * MM]);
  const uv = (p) => [(p[0] - origin[0]) / MM, (p[1] - origin[1]) / MM];
  const outline = [uv(inBottom), uv(outBottom), uv(outTop)];
  for (let k = 1; k < 8; k++) { const x = lerp(outTop[0], inTop[0], k / 8); outline.push(uv([x, L.lidY(x, z), z])); }
  outline.push(uv(inTop));
  const height = Math.min(uv(inTop)[1], uv(outTop)[1]), centreV = height / 2 - 3, R = POD.lampRadius;
  const centres = [-POD.pitch / 2, POD.pitch / 2].map((u) => [u, centreV]);
  black(pod, 0.75, 150);
  region(pod, face, outline, centres.map(([u, v]) => circle(R - 0.5, 40, u, v)));
  const headlamps = centres.map(([u, v]) => {
    const lamp = subFrame(face, [u, v, 0], [1, 0, 0], [0, 1, 0]);
    return L.raised(sealedBeam(pod, lamp, (build) => asGlass(pod, build), { r: R }));
  });

  // --- cheeks: the sides of the box, from the lid down to just inside the opening
  for (const side of [-1, 1]) {
    const rows = [], z0 = L.startZ(side);
    for (let i = 0; i <= 10; i++) {
      const [top, bottom] = L.cheek(side, lerp(z0, z, i / 10)), row = [];
      for (let j = 0; j <= 3; j++) { const y = lerp(top[1], bottom[1], j / 3); row.push(L.shut([lerp(top[0], bottom[0], j / 3), y, top[2]])); }
      rows.push(row);
    }
    black(pod, 0.8, 150);
    patch(pod, rows, { facing: [side, 0, 0], crease: 50 });
  }

  // --- hinge: a steel pin across the box on the hinge axis, and two arms that carry the lid on it
  const H = cavity.hinge, across = [inTop[0] + 0.02, outTop[0] - 0.02];
  pod.material(VEHICLE.CHROME, 110, 0); pod.color(0.5, 0.5, 0.52); pod.occlusion(0.6);
  lathe(pod, frame([across[0], H[1], H[2]], [1, 0, 0], [0, 1, 0]), [[0, 0], [0, 0.005], [across[1] - across[0], 0.005], [across[1] - across[0], 0]], { segs: 10 });
  black(pod, 0.55, 140);
  for (const x of [lerp(across[0], across[1], 0.12), lerp(across[0], across[1], 0.88)]) {
    const foot = cavity.lidUnder(S.ORIGIN_X - (H[2] + 0.07) / MM, x / MM), pin = [x, H[1], H[2]], d = sub(foot, pin);
    box(pod, frame([x, (foot[1] + pin[1]) / 2, (foot[2] + pin[2]) / 2], unit(d), [1, 0, 0]), Math.hypot(...d) + 0.012, 0.022, 0.006);
  }
  return { headlamps, dir: [0, 0, 1] };
}

// ------------------------------------------------------------------------------- indicator and parking lamp unit

/** Plan corners of a wing-top opening (see spec INDICATOR), grown by `grow` millimetres: [[x, z] x 4]. */
function opening(o, grow = 0) {
  return [[o.x0 - grow, S.lidZ(o.x0) + o.lidClear - grow], [o.x0 - grow, S.shoulderZ(o.x0) - o.shoulderClear + grow],
    [o.x1 + grow, S.shoulderZ(o.x1) - o.shoulderClear + grow], [o.x1 + grow, S.lidZ(o.x1) + o.lidClear - grow]];
}

/**
 * The unit let into the nose ahead of the pod: under one flush lens, the amber direction indicator inboard and the
 * clear parking lamp outboard, each with its own reflector and bulb, parted by a bright bar.
 * Returns { indicator, sideLamp }: the two lens centres.
 */
function buildNoseUnit(body, glass, hull) {
  const I = S.INDICATOR, q = opening(I, 2), xc = (I.x0 + I.x1) / 2, zc = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const TUB = -24, SEAT = -6, LENS_W = -2.5;
  // u across the car (outboard positive), v up the slope towards the cabin, w out of the skin: millimetres
  const to3 = (u, v, w = 0) => topPoint(hull, xc + v, zc + u, -w);
  const plan = ([x, zz]) => [zz - zc, x - xc], corners = q.map(plan), loop = roundCorners(corners, 14, { closed: true, segs: 3 });
  // the split runs up the slope at the amber share of the unit's width
  const split = (t) => { const a = lerp(corners[0][0], corners[1][0], I.amberShare), b = lerp(corners[3][0], corners[2][0], I.amberShare); return [lerp(a, b, t), lerp(corners[0][1], corners[3][1], t)]; };
  const s0 = split(-0.5), s1 = split(1.5);
  const halves = [
    { loop: clipByLine(loop, s0, s1, true), circuit: CIRCUIT.INDICATOR, lens: LENS.amber, bulb: LENS.amber.colour, key: 'indicator' },
    { loop: clipByLine(loop, s0, s1, false), circuit: CIRCUIT.MARKER, lens: LENS.clear, bulb: [1, 0.95, 0.85], key: 'sideLamp' },
  ];
  const anchors = {};
  if (glass) {
    trim(body, to3, loop, [[0, -2], [0, TUB]], { rough: 150, occlusion: 0.5 });
    black(body, 0.3, 190); region(body, to3, loop, [], { w: TUB });
  }
  for (const h of halves) {
    const [cu, cv, du, dv] = centreOf(h.loop), inset = h.loop.map((p) => [cu + (p[0] - cu) * (1 - 5 / du), cv + (p[1] - cv) * (1 - 5 / dv)]);
    if (glass) {
      loopBowl(body, to3, inset, { w: SEAT, depth: 16, circuit: h.circuit, tint: bowlTint(h.lens), focus: [cu, cv], floor: 0.35 });
      bulb(body, to3, { u: cu, v: cv, w: SEAT - 16, r: 6, length: 14, circuit: h.circuit, colour: h.bulb });
    }
    lensFace(body, glass, to3, h.loop, { w: LENS_W, optics: OPTICS.FLUTES, circuit: h.circuit, lens: h.lens, origin: [cu, cv] });
    anchors[h.key] = to3(cu, cv, 0);
  }
  if (glass) {
    // the bar between the two lamps, from the lens down to the back of the tub
    const a = split(0.04), b = split(0.96), t = 1.2, n = unit([b[1] - a[1], a[0] - b[0], 0]);
    body.material(CHROME.id, CHROME.rough, 0); body.color(CHROME.colour); body.occlusion(0.9);
    for (const side of [1, -1]) {
      const p = [a[0] + n[0] * t * side, a[1] + n[1] * t * side], r = [b[0] + n[0] * t * side, b[1] + n[1] * t * side];
      const quad = [to3(p[0], p[1], TUB), to3(r[0], r[1], TUB), to3(r[0], r[1], LENS_W - 0.6), to3(p[0], p[1], LENS_W - 0.6)];
      if (side > 0) body.flatQuad(quad[0], quad[1], quad[2], quad[3]); else body.flatQuad(quad[3], quad[2], quad[1], quad[0]);
    }
    const top = [[a, -1], [a, 1], [b, 1], [b, -1]].map(([p, side]) => to3(p[0] + n[0] * t * side, p[1] + n[1] * t * side, LENS_W - 0.6));
    body.flatQuad(top[0], top[1], top[2], top[3]);
  }
  return anchors;
}

// --------------------------------------------------------------------------------------------------- side markers

/** A small marker lamp on the body side at side-view point (x, y): a lens with rounded edges on a black gasket. */
function sideMarker(body, hull, x, y, width, height, lens) {
  const c = onSide(hull, x, y), p = hull.pos(c[0], c[1], [0, 0, 0]), n = hull.normal(c[0], c[1], [0, 0, 0]);
  const ja = [0, 0, 0], jb = [0, 0, 0]; hull.jac(c[0], c[1], ja, jb);
  const U = unit(sub(ja, n.map((v) => v * dot(ja, n)))), V = cross(n, U), plane = planeFrame(p, U.map((v) => v * MM), V.map((v) => v * MM));
  const loop = roundRect(-width / 2, -height / 2, width / 2, height / 2, 4, 3), metres = (q) => [q[0] * MM, q[1] * MM];
  trim(body, plane, loop, [[2.2, -1], [2.2, 1.2], [1.2, 2], [0, 2]], { rough: 130, occlusion: 0.8 });
  body.material(VEHICLE.LAMP_MARKER, OPTICS.FLUTES, 0); body.color(lens.colour); body.occlusion(1);
  ringLoft(body, plane, loop, [[0, 2], [0, 5], [-0.8, 6.3], [-2.4, 7]], { crease: 60 });
  region(body, plane, loop.map((q) => [q[0] * (1 - 4.8 / width), q[1] * (1 - 4.8 / height)]), [], { w: 7, uv: metres });
  return plane(0, 0, 7);
}

/**
 * Left half of the fixed front lamps: the indicator and parking lamp unit in the nose, and the amber and red side
 * markers on the body side. Returns { indicator, sideLamp, marker, rearMarker } (positions). The headlamps live in
 * the pop-up pod (buildLampPod).
 */
export function buildFrontLamps(body, glass, hull) {
  const anchors = buildNoseUnit(body, glass, hull), M = S.SIDE_MARKER;
  anchors.marker = sideMarker(body, hull, M.front[0], M.front[1], M.width, M.height, LENS.amber);
  anchors.rearMarker = sideMarker(body, hull, M.rear[0], M.rear[1], M.width, M.height, LENS.red);
  return anchors;
}

// ------------------------------------------------------------------------------------------------------ fog lamps

/**
 * A rectangular fog lamp. mount = { plane(u, v, w), size: [width, height] (mm), depth (mm) }: plane maps millimetres
 * about the lamp's centre (u across, v up, +w out of the car, w = 0 at the lamp's front face) to vehicle metres.
 * Returns { centre, size (metres), dir }.
 */
export function buildFogLamp(body, glass, mount) {
  const [width, height] = mount.size, depth = Math.min(mount.depth - 4, 46), rim = 5;
  const outer = roundRect(-width / 2, -height / 2, width / 2, height / 2, 7, 3), inner = roundRect(-width / 2 + rim, -height / 2 + rim, width / 2 - rim, height / 2 - rim, 4, 3);
  // bright frame round the lens, standing on a black body that reaches back into the pocket
  trim(body, mount.plane, outer, [[0, -depth - 4], [0, -3]], { rough: 140, occlusion: 0.6 });
  trim(body, mount.plane, inner, [[rim, -3], [rim, -1], [rim - 1, 0], [1, 0], [0, -1], [0, -3.5]], CHROME);
  if (glass) {
    loopBowl(body, mount.plane, inner, { w: -3.5, depth: depth - 4, circuit: CIRCUIT.FOG, tint: [0.95, 0.95, 0.96], focus: [0, 0], floor: 0.3, rows: 6 });
    bulb(body, mount.plane, { w: -depth + 0.5, r: 6, length: 22, circuit: CIRCUIT.FOG });
    // the cap that hides the bulb from oncoming eyes
    const cup = frame(mount.plane(0, 0, -depth + 26), axisOf(mount.plane), sub(mount.plane(1, 0, 0), mount.plane(0, 0, 0)));
    body.material(VEHICLE.CHROME, 25, 0); body.color(0.9, 0.9, 0.92); body.occlusion(1);
    lathe(body, cup, [[-0.007, 0.008], [-0.001, 0.008], [0.002, 0.006], [0.003, 0]], { segs: 12 });
  }
  lensFace(body, glass, mount.plane, inner, { w: -2.2, optics: OPTICS.FLUTES, circuit: CIRCUIT.FOG, lens: LENS.clear });
  return { centre: mount.plane(0, 0, 0), size: [width * MM, height * MM], dir: axisOf(mount.plane) };
}

// --------------------------------------------------------------------------------------------- number plate lamps

/**
 * Two small lamps over the rear number plate, shining down on it. plate = { centre, normal (out of the plate), up,
 * width, height } in vehicle metres. Returns [{ pos, dir }, { pos, dir }] for the whole car (left lamp first).
 */
export function buildPlateLamps(body, { centre, normal, up, width, height = width / 2 }) {
  const N = unit(normal), Up = unit(up), Right = cross(Up, N), down = Up.map((v) => -v), lamps = [];
  for (const side of [-1, 1]) {                                                  // Right points to the car's right when the plate faces backwards
    const at = centre.map((c, k) => c + Up[k] * (height / 2 + 0.011) + Right[k] * side * width * 0.27 + N[k] * 0.009);
    // a black cowl, rounded on top, with a clear lens let into its underside
    const below = planeFrame(at, Right.map((v) => v * MM), N.map((v) => v * MM)), above = planeFrame(at, Right.map((v) => -v * MM), N.map((v) => v * MM));
    const loop = roundRect(-19, -9, 19, 9, 5, 3), lens = roundRect(-15, -6, 15, 6, 3, 2);
    black(body, 0.8, 120);
    ringLoft(body, below, loop, [[0, 7], [0, -5], [-1.5, -7]], { crease: 60, outer: true });
    region(body, above, loop.map((p) => [p[0] * (1 - 1.5 / 19), p[1] * (1 - 1.5 / 9)]), [], { w: 7 });
    region(body, below, loop, [lens], { w: 7 });
    body.material(VEHICLE.LAMP_MARKER, OPTICS.FLUTES, 0); body.color(LENS.clear.colour); body.occlusion(1);
    region(body, below, lens, [], { w: 7, uv: () => [0, 0] });
    lamps.push({ pos: at.map((c, k) => c + down[k] * 0.0075), dir: down });
  }
  return lamps;
}
