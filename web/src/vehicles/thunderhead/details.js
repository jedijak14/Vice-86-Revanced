// What is fitted to the Thunderhead's shell: door mirrors, door handles, the backs of the gills, exhaust tips, wipers,
// the number plate with its lamps, our emblem on the nose and the name on the tail.
//   buildSideDetails(half, hull, quality)                 the left half's fittings; returns { exhausts }
//   buildCentreDetails(body, hull, screen, tailSheet)     what exists once; returns { plateRear, plateLamps }
// The slots of the gills and of the door handle are cut by body.js; here is what stands in and behind them.

import { VEHICLE } from '../../core/ids.js';
import { patch, polygon, region, ringLoft, roundRect, planeFrame, box, frame } from '../hero/kit/solids.js';
import { buildPlateLamps } from '../hero/lamps.js';
import * as S from './spec.js';
import { sidePoint, topPoint, gillOutlines, handleOutline } from './body.js';
import { tail } from './plan.js';
import { TAIL_ROW } from './bumpers.js';

const MM = S.MM;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], unit = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
const paint = (mb, occlusion = 1) => { mb.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); mb.color(1, 1, 1); mb.occlusion(occlusion); };
const black = (mb, rough = 140, occlusion = 1) => { mb.material(VEHICLE.TRIM_BLACK, rough, 0); mb.color(0.2, 0.2, 0.205); mb.occlusion(occlusion); };
const chrome = (mb, rough = 30, shade = 0.86) => { mb.material(VEHICLE.CHROME, rough, 0); mb.color(shade, shade, shade * 1.02); mb.occlusion(1); };

/** A bar between two points: `wide` across (towards `hint`), `thick` the other way. Metres. */
function strut(mb, a, b, wide, thick, hint) {
  const d = sub(b, a), mid = a.map((v, k) => (v + b[k]) / 2);
  box(mb, frame(mid, d, hint), Math.hypot(...d), wide, thick);
}
const centroid = (ring) => ring.reduce((c, p) => [c[0] + p[0] / ring.length, c[1] + p[1] / ring.length, c[2] + p[2] / ring.length], [0, 0, 0]);
/** Newell normal of a loop: it points at the side the loop is seen counter-clockwise from. */
function loopNormal(ring) {
  const n = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; n[0] += (p[1] - q[1]) * (p[2] + q[2]); n[1] += (p[2] - q[2]) * (p[0] + q[0]); n[2] += (p[0] - q[0]) * (p[1] + q[1]); }
  return n;
}
/** A flat face on a loop, seen from the side `towards` points at. */
function face(mb, ring, towards) { polygon(mb, dot(loopNormal(ring), towards) >= 0 ? ring : ring.slice().reverse()); }
/**
 * A closed skin through rings of equally many points, seen from outside (inside: `inward`). The ends are closed with
 * flat faces where asked.
 */
function tube(mb, rings, { capFirst = false, capLast = false, inward = false, crease = 40 } = {}) {
  const centres = rings.map(centroid), last = rings.length - 1, along = sub(centres[1], centres[0]), end = sub(centres[last], centres[last - 1]);
  // which way the grid's own winding faces: summed over every quad, so that a rolled lip cannot outvote the tube
  let away = 0;
  for (let i = 0; i < last; i++) for (let j = 0; j < rings[i].length; j++) {
    const p = rings[i][j];
    away += dot(cross(sub(rings[i + 1][j], p), sub(rings[i][(j + 1) % rings[i].length], p)), sub(p, centres[i]));
  }
  patch(mb, rings, { closeJ: true, flip: (away > 0) === inward, crease });
  if (capFirst) face(mb, rings[0], along.map((v) => (inward ? v : -v)));
  if (capLast) face(mb, rings[last], end.map((v) => (inward ? -v : v)));
}

// ---------------------------------------------------------------- door mirror

/**
 * The door mirror: a body-coloured housing that tapers forward, on a short foot ahead of the side glass.
 * Sections of the housing from its rear face forward: [distance, inner edge, outer edge, half height, corner], mm,
 * the edges measured outward from the housing's inner face.
 */
const MIRROR_SECTIONS = [[0, 0, 1, 1, 1], [0.06, -0.005, 1.012, 1.03, 1.05], [0.34, 0.01, 0.99, 0.98, 1], [0.64, 0.07, 0.86, 0.8, 0.85], [0.86, 0.15, 0.62, 0.52, 0.55], [0.97, 0.21, 0.42, 0.26, 0.26], [1, 0.25, 0.34, 0.1, 0.1]];
function buildMirror(mb, hull, full) {
  const M = S.MIRROR, foot = sidePoint(hull, M.x - M.length * 0.55, M.y - 46), rearZ = S.toCar(M.x, 0, 0)[2], inner = foot[0] + M.stand * MM, yc = M.y * MM, segs = full ? 4 : 1;
  const ring = ([d, u0, u1, h, r]) => roundRect(inner + u0 * M.width * MM, yc - h * M.height / 2 * MM, inner + u1 * M.width * MM, yc + h * M.height / 2 * MM, Math.min(r * M.corner, h * M.height / 2 - 0.5) * MM, segs).map(([x, y]) => [x, y, rearZ + d * M.length * MM]);
  paint(mb);
  tube(mb, MIRROR_SECTIONS.map(ring), { capLast: true });
  // the foot: from the door's skin up and out into the underside of the housing
  const onDoor = roundRect(M.x - M.length * 0.98, M.y - 66, M.x - M.length * 0.12, M.y - 30, 12, segs).map(([x, y]) => sidePoint(hull, x, y, 4));
  const z0 = rearZ + M.length * 0.2 * MM, z1 = rearZ + M.length * 0.86 * MM;
  const onHousing = roundRect(-z1, yc - M.height * 0.36 * MM, -z0, yc - M.height * 0.02 * MM, 0.01, segs).map(([z, y]) => [inner + 0.012, y, -z]);
  tube(mb, [onDoor, onHousing]);
  // rear face: a black rim and the glass a little way in
  const plane = planeFrame([inner + M.width / 2 * MM, yc, rearZ], [-MM, 0, 0], [0, MM, 0]), w = M.width / 2, h = M.height / 2;
  const rim = roundRect(-w, -h, w, h, M.corner, segs), glass = roundRect(-w + M.rim, -h + M.rim, w - M.rim, h - M.rim, M.corner - M.rim, segs);
  black(mb, 120, 0.8);
  region(mb, plane, rim, [glass], { w: 0 });
  ringLoft(mb, plane, glass, [[0, 0], [0, -4]]);
  chrome(mb, 12, 0.9);
  region(mb, plane, glass, [], { w: -4 });
}

// ---------------------------------------------------------------- gills and door handle

/** A piece of the body side's shape `depth` mm under the skin, over a side-view box grown by `margin`. */
function sunk(mb, hull, x0, x1, y0, y1, depth, cols = 4, rows = 4) {
  const grid = [];
  for (let i = 0; i <= cols; i++) { const row = []; for (let j = 0; j <= rows; j++) row.push(sidePoint(hull, x0 + (x1 - x0) * i / cols, y0 + (y1 - y0) * j / rows, depth)); grid.push(row); }
  patch(mb, grid, { facing: [1, 0, 0] });
}
function buildGills(mb, hull) {
  const G = S.GILL;
  black(mb, 170, 0.28);
  for (const loop of gillOutlines()) {
    const xs = loop.map((p) => p[0]);
    sunk(mb, hull, Math.min(...xs) - 12, Math.max(...xs) + 12, G.y[0] - 12, G.y[1] + 12, G.depth, 2, 5);
  }
}
function buildHandle(mb, hull) {
  const H = S.HANDLE, loop = handleOutline(), x0 = loop[0][0], x1 = loop[1][0], y0 = loop[0][1], y1 = loop[2][1], split = y1 - (y1 - y0) * H.flap;
  black(mb, 150, 0.3);
  sunk(mb, hull, x0 - 10, x1 + 10, y0 - 10, y1 + 10, H.depth);
  // the flap: hinged along its top edge, flush with the door, with the finger pocket open under it
  black(mb, 110, 0.9);
  sunk(mb, hull, x0 + 3, x1 - 3, split, y1 - 1.5, 2, 4, 2);
  face(mb, [sidePoint(hull, x0 + 3, split, 2), sidePoint(hull, x0 + 3, split, 6), sidePoint(hull, x1 - 3, split, 6), sidePoint(hull, x1 - 3, split, 2)], [0, -1, 0]);
}

// ---------------------------------------------------------------- exhaust

/** Two rectangular tips a side under the rear bumper. Returns [{ pos, dir }] of their mouths. */
function buildExhausts(mb) {
  const E = S.EXHAUST, rear = [0, 0, -1], mouths = [];
  for (const [z0, z1] of E.z) {
    const at = (x, grow) => roundRect(z0 - grow, E.y[0] - grow, z1 + grow, E.y[1] + grow, E.corner + grow, 3).map(([z, y]) => S.toCar(x, y, z));
    // outside: a rolled mouth, then the tube running forward under the car
    chrome(mb, 70, 0.62);
    tube(mb, [at(E.x - 1.2, -E.wall * 0.5), at(E.x, -0.4), at(E.x - 2.5, 0.6), at(E.x - 9, 0), at(E.x - E.length, 0)], { capLast: true, crease: 50 });
    // bore: bright at the mouth, sooty within
    tube(mb, [at(E.x - 1.2, -E.wall * 0.5), at(E.x - 6, -E.wall)], { inward: true });
    mb.material(VEHICLE.TRIM_BLACK, 200, 0); mb.color(0.1, 0.1, 0.1); mb.occlusion(0.4);
    tube(mb, [at(E.x - 6, -E.wall), at(E.x - E.bore, -E.wall)], { inward: true, capLast: true });
    mouths.push({ pos: S.toCar(E.x, (E.y[0] + E.y[1]) / 2, (z0 + z1) / 2), dir: rear });
  }
  // the pipe each pair hangs from, running forward into the dark under the floor
  const zc = (E.z[0][0] + E.z[1][1]) / 2, yc = (E.y[0] + E.y[1]) / 2;
  mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.05, 0.05, 0.05); mb.occlusion(0.5);
  const pipe = (x) => roundRect(zc - 70, yc - 22, zc + 70, yc + 22, 21, 3).map(([z, y]) => S.toCar(x, y, z));
  tube(mb, [pipe(E.x - E.length + 20), pipe(E.x - E.length - 330)], { capLast: true });
  return mouths;
}

/** The left half's fittings. Returns { exhausts: [{ pos, dir }] }. The reduced model gets only what shows in a silhouette. */
export function buildSideDetails(mb, hull, quality) {
  const full = quality.hems !== false;
  buildMirror(mb, hull, full);
  if (!full) return { exhausts: [] };
  buildGills(mb, hull);
  buildHandle(mb, hull);
  return { exhausts: buildExhausts(mb) };
}

// ---------------------------------------------------------------- wipers

/** Both wipers parked along the foot of the screen, their blades pointing at the passenger's side. */
function buildWipers(mb, screen) {
  const W = S.WIPER, p = [0, 0, 0], n = [0, 0, 0];
  /** A point over the screen: s from -1 (right pillar) to 1 (left pillar), t up the screen, `lift` mm off the glass. */
  const at = (s, t, lift) => { const a = Math.abs(s); screen.sheet.pos(a, t, p); screen.sheet.normal(a, t, n); const q = [p[0] + n[0] * lift * MM, p[1] + n[1] * lift * MM, p[2] + n[2] * lift * MM]; return s < 0 ? [-q[0], q[1], q[2]] : q; };
  const half = Math.hypot(...sub(at(1, W.t, 0), at(0, W.t, 0))), span = W.blade * MM / half;
  black(mb, 130, 0.9);
  for (const pivot of [0.86, 0.04]) {
    const tip = pivot - span, up = sub(at(pivot, W.t, 60), at(pivot, W.t, 0)), pts = [];
    for (let i = 0; i <= 6; i++) pts.push(pivot + (tip - pivot) * i / 6);
    // blade: the rubber on the glass and the sprung bridge over it
    for (let i = 0; i < 6; i++) {
      strut(mb, at(pts[i], W.t, 5), at(pts[i + 1], W.t, 5), 0.009, 0.01, up);
      if (i > 0 && i < 5) strut(mb, at(pts[i], W.t, W.lift - 3), at(pts[i + 1], W.t, W.lift - 3), 0.006, 0.005, up);
    }
    // arm: from the spindle at the foot of the screen to the middle of the blade
    const spindle = at(pivot + 0.03, -0.012, 8), elbow = at(pivot - span * 0.12, W.t * 0.4, W.lift + 4), mid = at(pivot - span * 0.5, W.t, W.lift + 3);
    strut(mb, spindle, elbow, 0.006, 0.016, up); strut(mb, elbow, mid, 0.004, 0.009, up);
    strut(mb, at(pivot + 0.03, -0.012, -4), at(pivot + 0.03, -0.012, 12), 0.02, 0.02, [0, 0, 1]);
  }
}

// ---------------------------------------------------------------- emblem and name

/** Our emblem on the nose: a round badge with a bright rim, black enamel, and a bolt of lightning from a cloud bar. */
const BOLT = [[0.12, 0.62], [-0.38, -0.06], [-0.06, -0.06], [-0.2, -0.66], [0.4, 0.14], [0.06, 0.14], [0.34, 0.62]];
function buildEmblem(mb, hull) {
  const E = S.EMBLEM, p = topPoint(hull, E.x, 0), q = topPoint(hull, E.x + 20, 0), V = unit(sub(q, p));
  const plane = planeFrame(p, [MM, 0, 0], V.map((v) => v * MM)), r = E.radius, loop = Array.from({ length: 32 }, (_, i) => [r * Math.cos(i * Math.PI / 16), r * Math.sin(i * Math.PI / 16)]);
  chrome(mb, 20);
  ringLoft(mb, plane, loop, [[0, 0], [0, 2.4], [-1, 3.2], [-2.8, 3.2], [-3.4, 2.4]], { crease: 50 });
  mb.material(VEHICLE.PAINT_FIXED, 0, 0); mb.color(0.012, 0.012, 0.016); mb.occlusion(1);
  region(mb, plane, loop.map(([u, v]) => [u * (1 - 3.2 / r), v * (1 - 3.2 / r)]), [], { w: 2.4 });
  chrome(mb, 20);
  const bolt = BOLT.map(([u, v]) => [u * r * 0.86, v * r * 0.86]);
  region(mb, plane, bolt, [], { w: 3.3 });
  ringLoft(mb, plane, bolt, [[0, 2.4], [0, 3.3]], { crease: 30 });
}

/** Capital letters as centre-line strokes on a unit-high grid: [advance, [polyline, ...]]. */
const GLYPHS = {
  T: [0.78, [[[0, 1], [0.62, 1]], [[0.31, 1], [0.31, 0]]]],
  H: [0.86, [[[0, 0], [0, 1]], [[0.66, 0], [0.66, 1]], [[0, 0.5], [0.66, 0.5]]]],
  U: [0.86, [[[0, 1], [0, 0.28], [0.1, 0.08], [0.33, 0], [0.56, 0.08], [0.66, 0.28], [0.66, 1]]]],
  N: [0.88, [[[0, 0], [0, 1], [0.68, 0], [0.68, 1]]]],
  D: [0.86, [[[0, 0], [0, 1], [0.34, 1], [0.56, 0.9], [0.66, 0.68], [0.66, 0.32], [0.56, 0.1], [0.34, 0], [0, 0]]]],
  E: [0.76, [[[0.58, 1], [0, 1], [0, 0], [0.58, 0]], [[0, 0.5], [0.46, 0.5]]]],
  R: [0.84, [[[0, 0], [0, 1], [0.4, 1], [0.57, 0.92], [0.63, 0.75], [0.57, 0.58], [0.4, 0.5], [0, 0.5]], [[0.32, 0.5], [0.66, 0]]]],
  A: [0.86, [[[0, 0], [0.33, 1], [0.66, 0]], [[0.12, 0.36], [0.54, 0.36]]]],
};
/** The model name in raised bright letters; to3(u, v, w) maps millimetres along the name, up it and off the skin. */
function buildScript(mb, to3, text, height, slant) {
  const stroke = height * 0.16;
  let pen = 0;
  chrome(mb, 30);
  for (const ch of text) {
    const [advance, lines] = GLYPHS[ch];
    for (const line of lines) for (let i = 0; i < line.length - 1; i++) {
      const at = ([gx, gy], w) => to3(pen + (gx + gy * slant) * height, gy * height, w), a = at(line[i], 1.2), b = at(line[i + 1], 1.2), d = unit(sub(b, a)), e = stroke * MM / 2;
      strut(mb, a.map((v, k) => v - d[k] * e), b.map((v, k) => v + d[k] * e), 0.0024, stroke * MM, sub(at(line[i], 100), a));
    }
    pen += advance * height;
  }
}

/**
 * Parts built once for the whole car: wipers, emblem, the name on the right of the tail, the rear plate and its lamps.
 * plateX: station of the back wall of the plate's recess. Returns { plateRear, plateLamps }.
 */
export function buildCentreDetails(mb, hull, screen, tailSheet, plateX) {
  buildWipers(mb, screen);
  buildEmblem(mb, hull);
  // the name follows the bumper's skin on the right of the plate, read from behind: u runs towards the car's right
  const N = S.SCRIPT, R = TAIL_ROW, p = [0, 0, 0], n = [0, 0, 0];
  buildScript(mb, (u, v, w) => {
    const a = tail.atZ(N.z + u), b = tailSheet.solve(a, 1, N.y + v, R.belt, R.bottom);
    tailSheet.pos(a, b, p); tailSheet.normal(a, b, n);
    return [-(p[0] + n[0] * w * MM), p[1] + n[1] * w * MM, p[2] + n[2] * w * MM];
  }, 'THUNDERHEAD', N.height, N.slant);

  const P = S.PLATE, plane = (u, v, w = 0) => S.toCar(plateX + w, v, -u), w = P.width / 2, y0 = P.y, y1 = P.y + P.height, f = P.frame;
  const outer = roundRect(-w - f, y0 - f, w + f, y1 + f, 9, 3), inner = roundRect(-w, y0, w, y1, 6, 3);
  black(mb, 110, 0.9);
  ringLoft(mb, plane, outer, [[0, 0], [0, 4], [-1.5, 5.5]]);
  region(mb, plane, outer.map(([u, v]) => [u - Math.sign(u) * 1.5, v + (v > (y0 + y1) / 2 ? -1.5 : 1.5)]), [inner], { w: 5.5 });
  mb.material(VEHICLE.PLATE, 1, 37); mb.color(0.93, 0.92, 0.86); mb.occlusion(1);
  region(mb, plane, inner, [], { w: 4.5, uv: (q) => [(q[0] + w) / P.width, (q[1] - y0) / P.height] });
  const centre = plane(0, (y0 + y1) / 2, 4.5);
  const lamps = buildPlateLamps(mb, { centre, normal: [0, 0, -1], up: [0, 1, 0], width: P.width * MM, height: P.height * MM });
  return { plateRear: centre, plateLamps: lamps };
}
