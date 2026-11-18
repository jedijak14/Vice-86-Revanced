// The cabin seen through the glass. A tub closes the car from the inside: the linings of the body side from under
// every pane down to the floor, the backbone between the seats, the sills, the wall behind the seats, the load
// floor under the hatch glass with its shelves over the wheel houses, and the dash that runs forward under the
// screen. In it: two high-backed seats and, on the driver's side, the wheel and the liquid-crystal instrument panel.
// Tub and seats are built as the left half and mirrored with the body; the controls are built once.
// Nothing here may stand in a wheel house: behind the seats everything keeps above the shelves or inside the well.

import { VEHICLE } from '../../core/ids.js';
import { patch, polygon, region, ringLoft, lathe, box, frame } from '../hero/kit/solids.js';
import { roundCorners, densify, leftNormals, offset } from '../hero/kit/outline.js';
import * as S from './spec.js';
import { sideGlassEdges, hatchEdge, topPoint, GLASS_ROW } from './body.js';
import { sunk, stations, LINING, LINING_DEPTH } from './glazing.js';

const MM = S.MM, toCar = S.toCar, K = S.CABIN, B = S.B_OF;
const HIDE = [0.20, 0.20, 0.205], HIDE_SHADE = [0.13, 0.13, 0.135], CHARCOAL = [0.04, 0.04, 0.042], CARPET = [0.055, 0.055, 0.058], PLASTIC = [0.035, 0.035, 0.037];
const LEATHER = 0, PILE = 1, HARD = 2, DISPLAY = 4;
const trim = (mb, kind, colour, occlusion = 1) => { mb.material(VEHICLE.INTERIOR, kind, 0); mb.color(colour); mb.occlusion(occlusion); };
/** A direction given in drawing axes (rearward, up, outboard) as a vehicle-frame vector. */
const dir = (dx, dy, dz) => [dz, dy, -dx];
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const steps = (a, b, n) => { const out = []; for (let i = 0; i <= n; i++) out.push(lerp(a, b, i / n)); return out; };

/** The wall of the body side stands this far under the skin (behind the linings of the frames), metres; the capping under the door glass less. */
const WALL_DEPTH = LINING_DEPTH + 0.002, CAPPING_DEPTH = 0.0135;
/** The capping begins this far above the base of the door glass and the wall runs on this far below it, mm of girth. */
const CAPPING_TOP = 4, CAPPING_FOOT = 18;
/** The wall's upper edge lies this far outside the edge of the opening it borders, under the frame's lining, mm. */
const UNDER_FRAME = 12;
/** Inner face of the door glass under the skin, metres: the inner seal closes the slot between it and the capping. */
const PANE_INNER = (S.PANE.side.depth + S.PANE.side.thickness) * MM + 0.0003;
/** Rows of the wall between its upper edge and the foot of the capping. */
const WALL_ROWS = 7;
/** Row where the roof lining ends (greenhouse.js): behind the door the wall climbs to just above it. */
const ROOF_ROW = B.E + 0.15;

/** Station of the wall behind the seats at height y. */
function bulkheadX(y) {
  const P = K.bulkhead;
  for (let k = 1; k < P.length; k++) if (y <= P[k][1] && P[k][1] > P[k - 1][1]) return lerp(P[k - 1][0], P[k][0], (y - P[k - 1][1]) / (P[k][1] - P[k - 1][1]));
  return P[P.length - 1][0];
}

/**
 * The body side from the inside, from the dash to the hoop: the wall under the skin from the edge of the glass
 * (the door glass's base, then up the hoop behind it) down to the door card, the card with its armrest, the sill,
 * the floor and the backbone.
 */
function buildSide(mb, hull) {
  const side = sideGlassEdges(hull), over = (x, row, mm) => hull.bOf(x, hull.arcOf(x, row) + mm), D = S.DOOR;
  const end = S.HATCH_X - 8, glassFrom = side.leadX[0], glassTo = D.rearTopX;
  const rim = (x) => Math.min(over(x, GLASS_ROW, -CAPPING_TOP), Math.max(ROOF_ROW, side.rear(x, UNDER_FRAME + 3)));
  const xs = stations(K.footX - 60, end, 55, [glassFrom, glassTo, glassTo + 30, S.HOOP_X, end - 30]);
  // --- upper wall: inner seal, capping (lining behind the door), the top of the card down to the shelf's height
  const upper = xs.map((x) => {
    const glazed = x >= glassFrom - 1 && x <= glassTo + 1, depth = glazed ? CAPPING_DEPTH : WALL_DEPTH, top = rim(x), foot = over(x, GLASS_ROW, CAPPING_FOOT), row = [];
    row.push(sunk(hull, x, hull.bOf(x, hull.arcOf(x, top) - 3), glazed ? PANE_INNER : depth));
    for (let j = 0; j < WALL_ROWS; j++) row.push(sunk(hull, x, lerp(top, foot, j / (WALL_ROWS - 1)), depth));
    const last = row[row.length - 1], y = last[1] / MM - 28;
    row.push(toCar(x, y, K.cardZ), toCar(x, K.shelfY, K.cardZ));
    return row;
  });
  patch(mb, upper, {
    facing: [-1, 0, 0], crease: 50,
    style: (i, j) => {
      const glazed = xs[i] >= glassFrom - 1 && xs[i + 1] <= glassTo + 1;
      if (j === 0) { mb.material(VEHICLE.TRIM_BLACK, 165, 0); mb.color(0.21, 0.21, 0.215); mb.occlusion(0.9); } else if (j < WALL_ROWS) { if (glazed) trim(mb, HARD, CHARCOAL, 0.8); else trim(mb, HARD, LINING, 0.7); } else trim(mb, LEATHER, HIDE, 0.85);
    },
  });

  // --- card, armrest, sill, floor and backbone; the last section leans with the wall behind the seats
  const arm = K.armY, cz = K.cardZ, th = K.tunnelHalf, top = K.tunnelTop;
  const section = [[cz, K.shelfY], [cz, arm + 34], [cz - 20, arm + 20], [cz - 30, arm + 4], [cz - 24, arm - 14], [cz - 2, arm - 24], [cz, K.sillTop],
    [K.sillZ + 12, K.sillTop], [K.sillZ + 3, K.sillTop - 4], [K.sillZ, K.sillTop - 14], [K.sillZ, K.floorY], [th, K.floorY], [th, top - 14], [th - 4, top - 4], [th - 14, top], [0, top]];
  const lowerXs = [...steps(K.footX - 60, K.bulkhead[0][0], 10), null];
  patch(mb, lowerXs.map((x) => section.map(([z, y]) => toCar(x === null ? bulkheadX(y) : x, y, z))), {
    facing: [-0.5, 1, 0], crease: 50,
    style: (i, j) => {
      if (j < 1) trim(mb, LEATHER, HIDE, 0.85); else if (j < 5) trim(mb, LEATHER, HIDE_SHADE, 0.85); else if (j < 6) trim(mb, LEATHER, HIDE, 0.7);
      else if (j < 9) trim(mb, HARD, CHARCOAL, 0.7); else if (j < 12) trim(mb, PILE, CARPET, 0.5); else trim(mb, LEATHER, CHARCOAL, 0.8);
    },
  });
}

/** The wall behind the seats and everything under the hatch glass: load floor, well, shelves and the walls up to the glass. */
function buildLoadSpace(mb, hull) {
  const P = K.bulkhead, wall = K.cardZ + 30, well = K.wellZ, y0 = K.loadY, y1 = K.shelfY, x0 = P[P.length - 1][0], x1 = K.loadEndX;
  trim(mb, PILE, CARPET, 0.6);
  patch(mb, P.slice(0, 3).map(([x, y]) => [toCar(x, y, 0), toCar(x, y, K.tunnelHalf), toCar(x, y, well)]), { facing: dir(-1, 0.4, 0) });
  patch(mb, P.map(([x, y]) => [toCar(x, y, well), toCar(x, y, wall)]), { facing: dir(-1, 0.4, 0) });
  // the step between the two, seen from the seats
  polygon(mb, [toCar(P[2][0], y0, well), toCar(P[2][0], y1, well), toCar(P[2][0] - 1, y1, well - 1)]);
  // well: floor, side and end
  trim(mb, PILE, CARPET, 0.5);
  patch(mb, [[toCar(x0, y0, 0), toCar(x0, y0, well)], [toCar(x1, y0, 0), toCar(x1, y0, well)]], { facing: [0, 1, 0] });
  patch(mb, [[toCar(x0, y0, well), toCar(x0, y1, well)], [toCar(x1, y0, well), toCar(x1, y1, well)]], { facing: [-1, 0, 0] });
  patch(mb, [[toCar(x1, y0, 0), toCar(x1, y0, well)], [toCar(x1, y1, 0), toCar(x1, y1, well)]], { facing: [0, 0, 1] });

  // the edge of the hatch glass in plan, from its front corner round the rear corner to the centre line, moved out under the frame
  const hatch = hatchEdge(hull), cornerZ = hatch.rear[hatch.rear.length - 1][1];
  const line = [...stations(S.HATCH_X - UNDER_FRAME, hatch.cornerX, 90).map((x) => [x, S.hatchSideZ(Math.max(S.HATCH_X, x))]), ...steps(1, 0, 6).slice(1).map((t) => [S.HATCH_END_X - S.HATCH.bow * t * t, cornerZ * t])];
  const corner = line.findIndex((p) => p[0] === hatch.cornerX), radii = line.map((_, k) => (k === corner ? S.HATCH.rearCorner / MM : 0));
  const edge = offset(roundCorners(line, radii, { segs: 6 }), UNDER_FRAME);
  edge[edge.length - 1][1] = 0;
  const foot = edge.map(([x, z]) => [x, z]), inWell = ([x, z]) => [Math.min(x, x1), Math.min(z, well)];
  trim(mb, HARD, LINING, 0.7);
  patch(mb, edge.map(([x, z], k) => [topPoint(hull, x, z, WALL_DEPTH / MM), toCar(foot[k][0], y1, foot[k][1])]), { facing: dir(-0.5, 0, -1), crease: 50 });
  // shelves: from the foot of the wall in to the well, and forward to the wall behind the seats
  trim(mb, PILE, CARPET, 0.6);
  const shelf = [[x0, K.cardZ], ...foot];
  patch(mb, shelf.map((p) => [toCar(p[0], y1, p[1]), toCar(inWell(p)[0], y1, inWell(p)[1])]), { facing: [0, 1, 0] });
}

/** The dash: its top from under the screen back to the brow, the face, the panel that closes the footwell, and the console. */
function buildDash(mb, screen) {
  const D = K.dash, shares = steps(0, 1, 10), rows = steps(0, 1, 6);
  const browX = (s) => lerp(D.browX, D.sideX, s * s), browY = (s) => D.top - D.fall * s * s;
  // front edge: under the lower edge of the screen glass
  const front = shares.map((s) => sunk(screen.sheet, s * 0.995, -0.03, 0.013));
  const top = rows.map((v) => shares.map((s, k) => {
    const f = front[k], b = toCar(browX(s), browY(s), D.z * s), w = smooth(0, 1, v);
    return [lerp(f[0], b[0], v), lerp(f[1], b[1], w), lerp(f[2], b[2], v)];
  }));
  trim(mb, LEATHER, CHARCOAL, 0.9);
  patch(mb, top, { facing: [0, 1, 0], crease: 50 });
  // brow and face
  const face = [[0, 0], [10, -4], [16, -16], [D.lipX - D.browX + 4, -60], [D.lipX - D.browX, D.lipY - D.top]];
  patch(mb, face.map(([dx, dy], i) => shares.map((s) => toCar(browX(s) + dx, i === face.length - 1 ? D.lipY : browY(s) + dy, D.z * s))), { facing: dir(1, 0, 0), crease: 50, style: (i) => { trim(mb, LEATHER, i < 2 ? CHARCOAL : HIDE_SHADE, 0.85); } });
  // end of the dash, where it shows above the door's capping
  const s1 = 1, end = [...rows.map((v) => top[rows.indexOf(v)][shares.length - 1]), ...face.slice(1).map(([dx, dy], i) => toCar(browX(s1) + dx, i === face.length - 2 ? D.lipY : browY(s1) + dy, D.z)), toCar(K.footX, D.lipY, D.z)];
  trim(mb, HARD, CHARCOAL, 0.6);
  polygon(mb, end.reverse());
  // under the dash: a plain slope from the lip to the floor closes the footwell
  trim(mb, PILE, CARPET, 0.4);
  patch(mb, [shares.map((s) => toCar(browX(s) + D.lipX - D.browX, D.lipY, D.z * s)), shares.map((s) => toCar(K.footX, K.floorY, D.z * s))], { facing: dir(1, 0.5, 0) });
  // console: from the dash down onto the backbone, with its cheek
  const cw = K.tunnelHalf - 14, c0 = [D.browX + 16, D.top - 30], c1 = [D.browX + 250, K.tunnelTop];
  trim(mb, LEATHER, CHARCOAL, 0.9);
  patch(mb, [[toCar(c0[0], c0[1], 0), toCar(c0[0], c0[1], cw)], [toCar(c1[0], c1[1], 0), toCar(c1[0], c1[1], cw)]], { facing: dir(1, 0.5, 0) });
  polygon(mb, [toCar(c0[0], K.tunnelTop, cw), toCar(c1[0], c1[1], cw), toCar(c0[0], c0[1], cw)]);
}

/**
 * A high-backed seat: one skin wrapped along a side-view spine (up the front of the cushion, along it, up the
 * backrest, over the headrest and down the back), raised into side bolsters and pressed into pleats, and two
 * flat side panels. zc: the seat's centre line.
 */
function buildSeat(mb, zc) {
  const T = K.seat, spine = densify(roundCorners(T.spine, T.radius, { segs: 5 }), 16), normals = leftNormals(spine);
  const topIndex = spine.reduce((best, p, i) => (p[1] > spine[best][1] ? i : best), 0), shoulderY = T.spine[5][1];
  let s = 0; const along = spine.map((p, i) => { if (i) s += Math.hypot(p[0] - spine[i - 1][0], p[1] - spine[i - 1][1]); return s; });
  const cols = [-1, -0.965, -0.84, -0.68, -0.52, -0.3, 0, 0.3, 0.52, 0.68, 0.84, 0.965, 1];
  const rows = spine.map(([x, y], i) => {
    const front = i <= topIndex, head = smooth(shoulderY, shoulderY + 120, y), hw = lerp(T.halfWidth, T.headHalfWidth, smooth(shoulderY, T.spine[7][1], y));
    const upholstered = front && y > K.floorY + 150 ? 1 - head : 0;
    return cols.map((c) => {
      const a = Math.abs(c), bolster = (front ? lerp(T.bolster, 10, head) : 0) * smooth(0.52, 0.84, a), groove = upholstered * (1 - smooth(0.5, 0.68, a)) * 6 * (1 - Math.pow(Math.abs(Math.sin(Math.PI * along[i] / T.pleat)), 0.5));
      const edge = a === 1 ? 9 : a > 0.9 ? 2 : 0, h = bolster - groove - edge;
      return toCar(x + normals[i][0] * h, y + normals[i][1] * h, zc + c * hw);
    });
  });
  trim(mb, LEATHER, HIDE, 0.95);
  patch(mb, rows, { flip: true, crease: 55, style: (i) => { mb.occlusion(i > topIndex ? 0.7 : 0.95); } });
  trim(mb, LEATHER, HIDE_SHADE, 0.8);
  const last = cols.length - 1;
  polygon(mb, rows.map((r) => r[last]).reverse());
  polygon(mb, rows.map((r) => r[0]));
}

/** Left half of the cabin. screen: screen.js (the dash runs forward under its lower edge). */
export function buildCabin(mb, hull, screen) {
  buildSide(mb, hull);
  buildLoadSpace(mb, hull);
  buildDash(mb, screen);
  buildSeat(mb, K.seat.z);
}

// ------------------------------------------------------------------------------------------------ driver's controls

/** Lit segments of the seven-segment figures 0 to 9, as [top, upper right, lower right, bottom, lower left, upper left, middle]. */
const FIGURES = ['1111110', '0110000', '1101101', '1111001', '0110011', '1011011', '1011111', '1110000', '1111111', '1111011'];
/** Colours of the display: blue-green figures, and a bar graph that runs from green through amber into red. Unlit segments show faintly. */
const GLOW = { figure: [0.25, 0.95, 0.75], green: [0.2, 0.95, 0.4], amber: [1, 0.55, 0.05], red: [1, 0.08, 0.04], ghost: 0.09 };

/**
 * The liquid-crystal instrument panel: a black face under a hood. Left the speed, right the engine speed, each a
 * bar graph that climbs in a curve over a large figure; between them fuel as a ladder and two small readings.
 * The car is parked with the ignition on: no speed, the engine at idle.
 */
function buildInstruments(mb) {
  const I = K.panel, plane = (u, v, w = 0) => toCar(I.faceX + w, v, -u), wall = 7, zc = (I.z[0] + I.z[1]) / 2, yc = (I.y[0] + I.y[1]) / 2;
  const face = [[-I.z[1], I.y[0]], [-I.z[0], I.y[0]], [-I.z[0], I.y[1]], [-I.z[1], I.y[1]]], rim = face.map(([u, v]) => [u + Math.sign(u + zc) * wall, v + (v > I.y[0] ? wall : 0)]);
  mb.material(VEHICLE.TRIM_BLACK, 40, 0); mb.color(0.02, 0.02, 0.022); mb.occlusion(0.9);
  region(mb, plane, face);
  trim(mb, HARD, PLASTIC, 0.5);
  ringLoft(mb, plane, face, [[0, 0], [0, I.hood]], { outer: true, crease: 30 });
  trim(mb, LEATHER, CHARCOAL, 0.9);
  region(mb, plane, rim, [face], { w: I.hood });
  // outside of the hood: top and two cheeks running forward into the dash top
  const zi = I.z[0] - wall, zo = I.z[1] + wall, yt = I.y[1] + wall, back = I.faceX + I.hood, foot = I.y[0] - 30;
  patch(mb, [[toCar(back, yt, zi), toCar(back, yt, zo)], [toCar(I.faceX, yt + 3, zi), toCar(I.faceX, yt + 3, zo)], [toCar(I.noseX, I.noseY, zi), toCar(I.noseX, I.noseY, zo)], [toCar(I.noseX, foot, zi), toCar(I.noseX, foot, zo)]], { facing: [0, 1, 0], crease: 15 });
  const cheek = (z) => [toCar(back, foot, z), toCar(back, yt, z), toCar(I.faceX, yt + 3, z), toCar(I.noseX, I.noseY, z), toCar(I.noseX, foot, z)];
  polygon(mb, cheek(zo));
  polygon(mb, cheek(zi).reverse());
  polygon(mb, [toCar(back, foot, zi), toCar(back, foot, zo), toCar(back, I.y[0], zo), toCar(back, I.y[0], zi)].reverse());

  // --- the display: every segment is a small lit quad just proud of the face; u to the driver's right, v up, from the middle of the face
  const lit = (colour, on) => { mb.material(VEHICLE.INTERIOR, DISPLAY, 0); mb.color(colour.map((c) => c * (on ? 1 : GLOW.ghost))); mb.occlusion(1); };
  const quad = (pts) => region(mb, plane, pts.map(([u, v]) => [u - zc, v + yc]), [], { w: 1.2 });
  const bar = (u0, v0, u1, v1) => quad([[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
  /** A seven-segment figure of height h with its lower left corner at (u, v); `value` null shows every segment unlit. */
  const figure = (u, v, h, value, colour) => {
    const w = h * 0.52, t = h * 0.12, g = t * 0.25, m = v + h / 2, on = value === null ? '0000000' : FIGURES[value];
    const segs = [[u + g, v + h - t, u + w - g, v + h], [u + w - t, m + g, u + w, v + h - g], [u + w - t, v + g, u + w, m - g], [u + g, v, u + w - g, v + t], [u, v + g, u + t, m - g], [u, m + g, u + t, v + h - g], [u + g, m - t / 2, u + w - g, m + t / 2]];
    segs.forEach((q, k) => { lit(colour, on[k] === '1'); bar(...q); });
  };
  const BARS = 22;
  /** A climbing bar graph in the block that starts at u0 and is `span` wide; the first `count` bars are lit. */
  const graph = (u0, span, count) => {
    for (let k = 0; k < BARS; k++) {
      const t = k / (BARS - 1), u = u0 + span * k / BARS, base = 4 + 30 * t ** 1.7, height = 9 + 11 * t, lean = 2.5;
      lit(t > 0.86 ? GLOW.red : t > 0.68 ? GLOW.amber : GLOW.green, k < count);
      quad([[u, base], [u + span / BARS * 0.62, base], [u + span / BARS * 0.62 + lean, base + height], [u + lean, base + height]]);
    }
  };
  const half = (I.z[1] - I.z[0]) / 2, block = 128, left = -half + 12, right = half - 12 - block;
  graph(left, block, 0); graph(right, block, 3);
  // speed: one figure lit; engine speed in hundreds
  figure(left + 34, -44, 34, null, GLOW.figure); figure(left + 58, -44, 34, 0, GLOW.figure);
  figure(right + 40, -44, 34, null, GLOW.figure); figure(right + 64, -44, 34, 8, GLOW.figure);
  // captions: plain strokes under each block
  lit(GLOW.figure, true); bar(left + 92, -44, left + 118, -41); bar(right + 4, -44, right + 30, -41);
  // middle: the fuel ladder and two small readings (oil pressure, coolant)
  for (let k = 0; k < 10; k++) { lit(k < 2 ? GLOW.red : GLOW.amber, k < 7); bar(-26, -46 + k * 5.2, -8, -46 + k * 5.2 + 3.4); }
  [[4, 14, [1, 3, 8]], [4, -12, [null, 4, 5]], [4, -40, [1, 8, 5]]].forEach(([u, v, digits]) => digits.forEach((d, k) => figure(u + k * 10.5, v, 15, d, GLOW.amber)));
}

/** Steering wheel on its column: two broad spokes and a padded hub. */
function buildSteeringWheel(mb) {
  const W = K.wheel, rake = W.rake * Math.PI / 180, R = W.diameter / 2 - W.tube, axis = dir(Math.cos(rake), Math.sin(rake), 0), up = dir(-Math.sin(rake), Math.cos(rake), 0);
  const centre = toCar(W.topX + Math.sin(rake) * (R + W.tube), W.topY - Math.cos(rake) * (R + W.tube), W.z), m = frame(centre, axis, up);
  const tube = []; for (let i = 0; i <= 10; i++) { const t = i / 10 * Math.PI * 2; tube.push([-W.tube * Math.cos(t) * MM, (R + W.tube * Math.sin(t)) * MM]); }
  trim(mb, LEATHER, CHARCOAL, 1);
  lathe(mb, m, tube, { segs: 48, crease: 50 });
  // hub pad and the column running forward into the dash
  lathe(mb, m, [[-0.2, 0.03], [-0.03, 0.03], [-0.03, 0.062], [0.006, 0.062], [0.018, 0.054], [0.02, 0]], { segs: 24, crease: 40, style: (i) => { trim(mb, i < 2 ? HARD : LEATHER, i < 2 ? PLASTIC : CHARCOAL, 0.9); } });
  // spokes: left and right, a little below the centre, flat and broad
  trim(mb, LEATHER, CHARCOAL, 0.95);
  const side = [axis[1] * up[2] - axis[2] * up[1], axis[2] * up[0] - axis[0] * up[2], axis[0] * up[1] - axis[1] * up[0]];
  for (const a of [-0.2, Math.PI + 0.2]) {
    const radial = [0, 1, 2].map((k) => side[k] * Math.cos(a) + up[k] * Math.sin(a)), mid = (0.05 + R * MM) / 2;
    box(mb, frame([0, 1, 2].map((k) => centre[k] + radial[k] * mid - axis[k] * 0.004), radial, axis), R * MM - 0.045, 0.012, 0.05);
  }
}

/** The lever on the backbone: a short stalk in a leather boot with a ball knob. */
function buildLever(mb) {
  const L = K.lever, foot = toCar(L.x, K.tunnelTop, L.z), lean = dir(0.25, 1, 0), m = frame(foot, lean, dir(1, 0, 0));
  trim(mb, LEATHER, CHARCOAL, 0.9);
  lathe(mb, m, [[0, 0.055], [0.03, 0.04], [0.085, 0.014], [0.09, 0]], { segs: 14, crease: 40 });
  mb.material(VEHICLE.CHROME, 60, 0); mb.color(0.8, 0.8, 0.82); mb.occlusion(1);
  lathe(mb, m, [[0.085, 0.006], [0.15, 0.006]], { segs: 10 });
  trim(mb, HARD, PLASTIC, 1);
  const knob = [], ball = 0.022; for (let i = 0; i <= 10; i++) { const t = i / 10 * Math.PI; knob.push([0.15 + ball * 0.8 - ball * Math.cos(t), ball * Math.sin(t)]); }
  lathe(mb, m, knob, { segs: 16, crease: 50 });
}

/** Everything that is not mirrored: the instrument panel and the wheel on the left, the lever on the backbone. */
export function buildControls(mb) {
  buildInstruments(mb);
  buildSteeringWheel(mb);
  buildLever(mb);
}

/** Where the driver's eyes are, vehicle frame. */
export const driverEye = () => toCar(K.eye[0], K.eye[1], K.eye[2]);
