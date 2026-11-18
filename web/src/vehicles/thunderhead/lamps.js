// The Thunderhead's lamps.
//   buildLampWell(body, hull)            the well under a pop-up lid, and the room the pod has to turn in
//   buildLampPod(pod, cavity)            the pod under its lid: two rectangular lamps side by side in a black face
//   buildFrontLamps(body, glass, mount)  the unit in the bumper's slot: fog lamp inboard, turn and parking lamps outboard
//   buildTailLamps(body, glass, sockets) the four round lamps of the tail panel (two on the left)
//   buildStopLamp(body, hull)            the high centre stop lamp on the hoop (its left half)
//   buildSideMarkers(body, nose, tail)   amber and red marker lamps on the bumpers' sides
// Everything is the left half (+X). `glass` is the glass builder, or null for the reduced model, which gets lit faces
// lying on the skin and nothing behind them. The optics themselves come from the kit (hero/lamps/optics.js).

import { VEHICLE } from '../../core/ids.js';
import { patch, polygon, region, ringLoft, roundRect, planeFrame } from '../hero/kit/solids.js';
import { roundCorners, densify } from '../hero/kit/outline.js';
import { HEM_GAP } from '../hero/kit/panel.js';
import * as S from './spec.js';
import { topPoint } from './body.js';
import { nose, tail } from './plan.js';
import { NOSE_ROW, TAIL_ROW } from './bumpers.js';
import { CIRCUIT, OPTICS, LENS, CHROME, sub, unit, cross, dot, subFrame, circle, bowlTint, roundBowl, loopBowl, bulb, lensFace, trim, asGlass, rectBeam } from '../hero/lamps/optics.js';

const MM = S.MM, lerp = (a, b, t) => a + (b - a) * t;
/** Moulded black plastic and rubber: never pure black, so that it still takes light. */
const BLACK = [0.2, 0.2, 0.205], BULB_CLEAR = [1, 0.95, 0.85];
function black(mb, occlusion = 0.7, rough = 150) { mb.material(VEHICLE.TRIM_BLACK, rough, 0); mb.color(BLACK); mb.occlusion(occlusion); }
/** Height at which a lit face lies on the skin in the reduced model, mm. */
const PROUD = 1.5;

/** Root of a falling or rising function between a and b, by bisection; the nearer end when there is none. */
function solve(f, a, b) {
  const rising = f(b) > f(a);
  for (let i = 0; i < 40; i++) { const mid = (a + b) / 2; if ((f(mid) < 0) === rising) a = mid; else b = mid; }
  return (a + b) / 2;
}

/** A flat frame (u, v in mm, w out of the skin) touching a sheet at chart point (a, b); u runs as nearly along `along` as the skin allows. */
function tangentFrame(sheet, a, b, along) {
  const p = sheet.pos(a, b, [0, 0, 0]), n = sheet.normal(a, b, [0, 0, 0]), d = dot(along, n);
  const U = unit([along[0] - n[0] * d, along[1] - n[1] * d, along[2] - n[2] * d]), V = cross(n, U);
  return planeFrame(p, U.map((v) => v * MM), V.map((v) => v * MM));
}

// ---------------------------------------------------------------- pop-up headlamps

/** Depth of the lid's inner face under the skin (mm); the gap kept between the turning pod and the opening (m). */
const LID_THICKNESS = 6, SWING_CLEARANCE = 0.006;
/** The pod's face stands this far behind the lid's leading edge; its cheeks this far inside the opening's sides (mm). */
const FACE_SETBACK = 18, CHEEK_CLEAR = 6;
/** The face ends this far under the bonnet's skin when the pod is up, so that no gap shows under it (m). */
const SINK = 0.003;

/**
 * The well under the pod's opening: dark walls dropping from the shut line and a floor that rises to the hinge.
 * Returns the cavity the lamp unit lives and turns in: { lidUnder(x, z): point on the lid's inner face, skin(x, z):
 * point on the bonnet, hinge: a point of the hinge axis, axis, openAngle, swing: the reach of the opening's leading
 * edge from the axis less a working clearance; nothing on the pod may be further from the axis } (vehicle metres).
 */
export function buildLampWell(mb, hull) {
  const P = S.LAMP_POD, outline = [[P.x0, P.z0], [P.x0, P.z1], [P.x1, P.z1], [P.x1, P.z0]];
  const drop = (x) => lerp(P.depthFront, P.depthRear, (x - P.x0) / (P.x1 - P.x0));
  const loop = roundCorners(outline, P.corner / MM, { closed: true, segs: 4 });
  const rim = loop.map(([x, z]) => topPoint(hull, x, z, HEM_GAP.drop / MM)), foot = loop.map(([x, z]) => { const p = topPoint(hull, x, z); return [p[0], p[1] - drop(x) * MM, p[2]]; });
  // walls and floor: unlit by the sky while the lid is shut, so they are authored dark
  mb.material(VEHICLE.TRIM_BLACK, 170, 0); mb.color(0.05, 0.05, 0.052); mb.occlusion(0.25);
  patch(mb, [rim, foot], { flip: true, closeJ: true, crease: 50 });
  polygon(mb, foot);

  const hinge = topPoint(hull, P.hingeX, (P.z0 + P.z1) / 2, P.hingeDepth);
  let reach = Infinity;
  for (let k = 0; k <= 8; k++) { const q = topPoint(hull, P.x0, lerp(P.z0, P.z1, k / 8)); reach = Math.min(reach, Math.hypot(q[1] - hinge[1], q[2] - hinge[2])); }
  return {
    lidUnder: (x, z) => topPoint(hull, x, z, LID_THICKNESS), skin: (x, z) => topPoint(hull, x, z),
    hinge, axis: [-1, 0, 0], openAngle: P.openAngle, swing: reach - SWING_CLEARANCE,
  };
}

/**
 * The headlamp unit of the left pod. pod: the builder that already holds the lid's skin, in the vehicle family and
 * shut; it is left in the vehicle family. The unit is laid out with the lid OPEN (face upright, cheeks square to the
 * hinge) and every point is turned back to where it lies when the lid is shut.
 * Returns { headlamps: [inboard, outboard] lens centres with the lid OPEN, dir: the way the beams point }.
 */
export function buildLampPod(pod, cavity) {
  const P = S.LAMP_POD, H = cavity.hinge, A = cavity.axis;
  const turn = (p, angle) => {                                                  // about the hinge axis, right-handed
    const c = Math.cos(angle), s = Math.sin(angle), d = sub(p, H), k = dot(A, d) * (1 - c), x = cross(A, d);
    return [H[0] + d[0] * c + x[0] * s + A[0] * k, H[1] + d[1] * c + x[1] * s + A[1] * k, H[2] + d[2] * c + x[2] * s + A[2] * k];
  };
  const raised = (p) => turn(p, cavity.openAngle), shut = (p) => turn(p, -cavity.openAngle);
  const reach = (y, z) => Math.hypot(y - H[1], z - H[2]), drawingX = (z) => S.ORIGIN_X - z / MM;
  /** Height of the raised lid's inner face at lateral position x (m) and station z (m). */
  const lidY = (x, z) => raised(cavity.lidUnder(solve((d) => raised(cavity.lidUnder(d, x / MM))[2] - z, P.x0, P.x1), x / MM))[1];
  /** Height of the bonnet's skin there, less a little: where the pod's skirt ends, inside the opening. */
  const sillY = (x, z) => cavity.skin(drawingX(z), x / MM)[1] - SINK;
  const sides = [(P.z0 + CHEEK_CLEAR) * MM, (P.z1 - CHEEK_CLEAR) * MM], middle = (sides[0] + sides[1]) / 2;

  // the face stands upright behind the lid's leading edge, and no further forward than the swing of the pod allows
  const lidZ = Math.min(...[sides[0], middle, sides[1]].map((x) => raised(cavity.lidUnder(P.x0 + FACE_SETBACK, x / MM))[2]));
  const swingZ = solve((z) => Math.max(...sides.map((x) => reach(sillY(x, z), z))) - cavity.swing, H[2] + 0.1, cavity.skin(P.x0, middle / MM)[2]);
  const z = Math.min(lidZ, swingZ);

  // --- lining of the lid: its inner face, inside the rolled edge
  black(pod, 0.5, 175);
  const lining = [], g = 8;
  for (let i = 0; i <= 6; i++) { const row = []; for (let j = 0; j <= 4; j++) row.push(cavity.lidUnder(lerp(P.x0 + g, P.x1 - g, i / 6), lerp(P.z0 + g, P.z1 - g, j / 4))); lining.push(row); }
  patch(pod, lining, { facing: [0, -1, 0], crease: 50 });

  // --- face: a black panel between the cheeks, from the lid down into the opening, with the two lamps in it
  const origin = [middle, Math.max(sillY(sides[0], z), sillY(sides[1], z)), z];
  const face = (u, v, w = 0) => shut([origin[0] + u * MM, origin[1] + v * MM, origin[2] + w * MM]);
  const uv = (x, y) => [(x - origin[0]) / MM, (y - origin[1]) / MM];
  const outline = [uv(sides[0], sillY(sides[0], z)), uv(sides[1], sillY(sides[1], z))];
  for (let k = 0; k <= 8; k++) { const x = lerp(sides[1], sides[0], k / 8); outline.push(uv(x, lidY(x, z))); }
  const L = P.lamp, height = Math.min(outline[2][1], outline[outline.length - 1][1]), centres = [-L.pitch / 2, L.pitch / 2].map((u) => [u, height / 2]);
  black(pod, 0.75, 150);
  region(pod, face, outline, centres.map(([u, v]) => roundRect(u - L.width / 2, v - L.height / 2, u + L.width / 2, v + L.height / 2, L.corner, 5)));
  const headlamps = centres.map(([u, v]) => raised(rectBeam(pod, subFrame(face, [u, v, 0], [1, 0, 0], [0, 1, 0]), (build) => asGlass(pod, build), { width: L.width, height: L.height, corner: L.corner })));

  // --- cheeks: the sides of the box, from where the raised lid first stands clear of the bonnet forward to the face
  sides.forEach((x, k) => {
    const z0 = solve((s) => lidY(x, s) - sillY(x, s) - 0.003, H[2] + 0.01, z), rows = [];
    for (let i = 0; i <= 10; i++) { const s = lerp(z0, z, i / 10), top = lidY(x, s), bottom = sillY(x, s); rows.push([0, 1, 2, 3].map((j) => shut([x, lerp(top, bottom, j / 3), s]))); }
    black(pod, 0.8, 150);
    patch(pod, rows, { facing: [k ? 1 : -1, 0, 0], crease: 50 });
  });
  return { headlamps, dir: [0, 0, 1], faceHeight: height };
}

// ---------------------------------------------------------------- front bumper unit

/**
 * The lamp unit in the front bumper's slot. mount: { slot(z, y, w), opening } from buildFrontBumper: the slot's
 * coordinates follow the bumper round the corner, so each lens is a row of flat facets.
 * Returns { indicator: position, fog: { pos, dir }, parking: position } of the left unit.
 */
export function buildFrontLamps(body, glass, mount) {
  const F = S.FRONT_LAMPS, O = mount.opening, [y0, y1] = F.y, cy = (y0 + y1) / 2;
  const slot = glass ? mount.slot : (z, y, w = 0) => mount.slot(z, y, w - F.seat + PROUD);
  const lamps = [
    { z: F.fog, circuit: CIRCUIT.FOG, lens: LENS.clear, optics: OPTICS.FLUTES, colour: BULB_CLEAR, key: 'fog' },
    { z: F.turn, circuit: CIRCUIT.INDICATOR, lens: LENS.amber, optics: OPTICS.FLUTES, colour: LENS.amber.colour, key: 'indicator' },
    { z: F.park, circuit: CIRCUIT.MARKER, lens: LENS.amber, optics: OPTICS.PRISMS, colour: LENS.amber.colour, key: 'parking' },
  ];
  const band = (z0, z1, v0, v1, w) => { const n = Math.max(2, Math.round((z1 - z0) / 24)), grid = []; for (let i = 0; i <= n; i++) { const z = lerp(z0, z1, i / n); grid.push([slot(z, v0, w), slot(z, v1, w)]); } return grid; };
  if (glass) {
    // the plate the lamps stand on, behind the slot's rolled edge
    const back = F.seat - 7;
    black(body, 0.5, 170);
    patch(body, band(O.z[0] - 3, O.z[1] + 3, O.y[0] - 3, O.y[1] + 3, back), { facing: sub(slot(O.z[0], cy, 1), slot(O.z[0], cy, 0)) });
  }
  const anchors = {};
  for (const lamp of lamps) {
    const [z0, z1] = lamp.z, cz = (z0 + z1) / 2, n = Math.max(1, Math.round((z1 - z0) / F.facet));
    for (let i = 0; i < n; i++) {
      const a = lerp(z0, z1, i / n), b = lerp(z0, z1, (i + 1) / n);
      lensFace(body, glass, slot, [[a, y0], [b, y0], [b, y1], [a, y1]], { w: F.seat, optics: lamp.optics, circuit: lamp.circuit, lens: lamp.lens, origin: [cz, cy] });
    }
    const centre = slot(cz, cy, F.seat), dir = unit(sub(slot(cz, cy, F.seat + 1), centre));
    anchors[lamp.key] = lamp.key === 'fog' ? { pos: centre, dir } : centre;
    if (!glass) continue;
    // black frame round the lens, the reflector behind it and its bulb
    const loop = densify(roundRect(z0, y0, z1, y1, 4, 2), 22), f = F.frame;
    trim(body, slot, loop, [[f, F.seat - 7], [f, F.seat + 2.4], [f - 0.9, F.seat + 3.2], [0.9, F.seat + 3.2], [0, F.seat + 2.2], [0, F.seat - 1]], { rough: 140, colour: BLACK, occlusion: 0.8 });
    loopBowl(body, slot, loop, { w: F.seat - 1.5, depth: F.depth, circuit: lamp.circuit, tint: bowlTint(lamp.lens), focus: [cz, cy], floor: 0.35 });
    const local = planeFrame(slot(cz, cy, 0), sub(slot(cz + 1, cy, 0), slot(cz, cy, 0)), sub(slot(cz, cy + 1, 0), slot(cz, cy, 0)));
    bulb(body, local, { w: F.seat - 1.5 - F.depth, r: 7, length: 22, circuit: lamp.circuit, colour: lamp.colour });
  }
  return anchors;
}

// ---------------------------------------------------------------- tail lamps

/**
 * One round tail lamp in its opening: a red lens moulded in rings round a centre that is a lamp of its own behind a
 * bright ring. plane: the opening's frame; radius: of the opening; ring, centre: { circuit, lens }.
 * Returns { ring, centre } anchors, each { pos, size, dir }.
 */
function roundLamp(body, glass, plane, radius, ring, centre) {
  const T = S.TAIL_LAMP, seat = glass ? T.seat : PROUD, n = glass ? 40 : 20, m = glass ? 28 : 12, inner = T.centre + T.ring;
  lensFace(body, glass, plane, circle(T.lens, n), { w: seat, holes: [circle(glass ? inner : T.centre, m)], optics: OPTICS.RINGS, circuit: ring.circuit, lens: ring.lens });
  lensFace(body, glass, plane, circle(T.centre, m), { w: seat, optics: OPTICS.PRISMS, circuit: centre.circuit, lens: centre.lens });
  const dir = unit(sub(plane(0, 0, 1), plane(0, 0, 0)));
  const anchors = { ring: { pos: plane(0, T.centre + (T.lens - T.centre) / 2, seat), size: [2 * T.lens * MM, 2 * T.lens * MM], dir }, centre: { pos: plane(0, 0, seat), size: [2 * T.centre * MM, 2 * T.centre * MM], dir } };
  if (!glass) return anchors;
  // gasket between the opening's wall and the lens
  trim(body, plane, circle(T.lens, n), [[radius - T.lens + 1.5, seat + 1.5], [1.2, seat + 1.5], [0, seat + 0.6], [0, seat - 1]], { rough: 160, colour: BLACK, occlusion: 0.75 });
  // bright ring round the centre lamp, and the barrel that parts the two reflectors
  trim(body, plane, circle(T.centre, m), [[T.ring, seat - 0.5], [T.ring, seat + 1.6], [T.ring - 0.7, seat + 2.2], [0.7, seat + 2.2], [0, seat + 1.6], [0, seat - 0.5]], { ...CHROME, crease: 60 });
  const r = T.lens - 0.5, neck = r * 0.17, meet = T.depth * (r * r - inner * inner) / (r * r - neck * neck);
  trim(body, plane, circle(inner - 0.3, m), [[0, seat - 2 - meet], [0, seat - 0.5]], { ...CHROME, crease: 60 });
  roundBowl(body, plane, { r, depth: T.depth, circuit: ring.circuit, tint: bowlTint(ring.lens), neck, w: seat - 1 });
  roundBowl(body, plane, { r: T.centre, depth: T.centreDepth, circuit: centre.circuit, tint: bowlTint(centre.lens), segs: m, rows: 6, w: seat - 1 });
  bulb(body, plane, { w: seat - 1 - T.centreDepth, r: 6, length: 15, circuit: centre.circuit, colour: centre.lens === LENS.clear ? BULB_CLEAR : centre.lens.colour });
  return anchors;
}

/**
 * The two round lamps of the left half of the tail panel. sockets: [{ plane, radius }] from buildTail, inboard first.
 * Inboard: tail lamp round the reversing lamp. Outboard: stop and tail lamp round the indicator.
 * Returns { tail: [inboard, outboard], brake, reverse, indicator }, each anchor { pos, size, dir }.
 */
export function buildTailLamps(body, glass, sockets) {
  const [a, b] = sockets;
  const inboard = roundLamp(body, glass, a.plane, a.radius, { circuit: CIRCUIT.TAIL, lens: LENS.red }, { circuit: CIRCUIT.REVERSE, lens: LENS.clear });
  const outboard = roundLamp(body, glass, b.plane, b.radius, { circuit: CIRCUIT.STOP_TAIL, lens: LENS.red }, { circuit: CIRCUIT.INDICATOR, lens: LENS.red });
  return { tail: [inboard.ring, outboard.ring], brake: outboard.ring, reverse: inboard.centre, indicator: outboard.centre };
}

// ---------------------------------------------------------------- high centre stop lamp

/** Side view of the housing: [along its length 0..1, height 0..1]. Its trailing face is upright and carries the lens. */
const STOP_HOUSING = [[0, 0], [0.1, 0.07], [0.28, 0.38], [0.52, 0.78], [0.76, 0.97], [0.9, 1], [0.97, 0.93], [1, 0.8], [1, 0]];

/**
 * Left half of the high centre stop lamp: a low painted housing on the hoop, ahead of the hatch glass, with a red
 * lens across its trailing face. full: the full model's tessellation. Returns its anchor { pos, size, dir }.
 */
export function buildStopLamp(body, hull, full) {
  const P = S.STOP_LAMP, round = 24, flat = P.half - round, across = full ? 6 : 2, cap = full ? 5 : 2, stations = [];
  for (let j = 0; j <= across; j++) stations.push(flat * j / across);
  // the housing's ends are rounded off in plan and in height over the last `round` mm
  for (let j = 1; j <= cap; j++) stations.push(flat + round * Math.sin(j / cap * Math.PI / 2));
  const point = (z, t, h) => {
    const k = Math.max(0, z - flat) / round, s = Math.sqrt(Math.max(0.05, 1 - k * k)), mid = P.x - P.length * 0.35;
    const p = topPoint(hull, mid + (P.x - P.length * (1 - t) - mid) * (0.45 + 0.55 * s), z);
    return [p[0], p[1] + (h * P.height * s - (h === 0 ? 2 : 0)) * MM, p[2]];                // the feet stand a little in the skin
  };
  body.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); body.color(1, 1, 1); body.occlusion(1);
  patch(body, stations.map((z) => STOP_HOUSING.map(([t, h]) => point(z, t, h))), { facing: [0, 1, 0], crease: 40 });
  // the lens: a strip standing a millimetre proud of the trailing face
  const lens = flat - 6, y0 = 0.14, y1 = 0.7, at = (z, h) => { const p = point(z, 1, h); return [p[0], p[1], p[2] - 0.001]; };
  body.material(VEHICLE.LAMP_BRAKE, OPTICS.FLUTES, 0); body.color(LENS.red.colour); body.occlusion(1);
  const strip = []; for (let j = 0; j <= 4; j++) strip.push([at(lens * j / 4, y0), at(lens * j / 4, y1)]);
  patch(body, strip, { facing: [0, 0, -1], uv: (i, j) => [lens * i / 4 * MM, j * (y1 - y0) * P.height * MM] });
  const c = at(0, (y0 + y1) / 2);
  return { pos: [0, c[1], c[2]], size: [2 * lens * MM, (y1 - y0) * P.height * MM], dir: [0, 0, -1] };
}

// ---------------------------------------------------------------- side markers

/** A small marker lamp standing on a skin at chart point (a, b): a black frame and a fluted lens. Returns its centre. */
function sideMarker(body, sheet, a, b, lens) {
  const M = S.SIDE_MARKER, plane = tangentFrame(sheet, a, b, [0, 0, 1]);
  const loop = roundRect(-M.width / 2, -M.height / 2, M.width / 2, M.height / 2, 4, 3), metres = (q) => [q[0] * MM, q[1] * MM];
  trim(body, plane, loop, [[2.2, -1], [2.2, 1.2], [1.2, 2], [0, 2]], { rough: 130, colour: BLACK, occlusion: 0.8 });
  body.material(VEHICLE.LAMP_MARKER, OPTICS.FLUTES, 0); body.color(lens.colour); body.occlusion(1);
  ringLoft(body, plane, loop, [[0, 2], [0, 4.4], [-0.8, 5.6], [-2.4, 6.2]], { crease: 60 });
  region(body, plane, loop.map((q) => [q[0] * (1 - 4.8 / M.width), q[1] * (1 - 4.8 / M.height)]), [], { w: 6.2, uv: metres });
  return plane(0, 0, 6.2);
}

/** The left side's marker lamps: amber on the front bumper's side, red on the tail's. Returns [front, rear] positions. */
export function buildSideMarkers(body, noseSheet, tailSheet) {
  const M = S.SIDE_MARKER, fa = nose.atX(M.front[0]), ra = tail.atX(M.rear[0]);
  return [
    sideMarker(body, noseSheet, fa, noseSheet.solve(fa, 1, M.front[1], NOSE_ROW.belt, NOSE_ROW.lip), LENS.amber),
    sideMarker(body, tailSheet, ra, tailSheet.solve(ra, 1, M.rear[1], TAIL_ROW.belt, TAIL_ROW.bulge), LENS.red),
  ];
}
