// Painted road markings that are not part of the lane pattern: crossings, stop lines, arrows, hatching, words.
// They are flat GROUND.MARKING decals in the plane of the road; the family's deform() lifts them clear of it.
// Each builder appends to the caller's MeshBuilder in the caller's coordinates and returns the triangles it added.
//
// Decal space: u runs across the direction of travel (positive on the right), v along it, both in metres from
// the decal's anchor. The shader reads uv as (u, v): zebra bars and hatching are drawn from it, everything else
// is solid paint whose shape is the geometry.
// The vertex alpha is the marking weight of the road underneath (each builder has a default, `weight` overrides it).
//
// Tyres take paint off where they run, so the shader must know where the wheel paths cross a decal. The material
// byte p0 therefore carries the lane width next to the fill, and u is shifted so that lane boundaries fall on whole
// multiples of that width: arrows and letters are centred on their lane by construction, crossings and stop lines
// work it out from the road's half width and lane code when the caller passes them.

import { FAMILY, GROUND } from '../../core/ids.js';
import { LAND_Y, LANE, laneLayout } from './lanes.js';

/** MARKING p0, low three bits: how the shader fills the decal. */
export const MARKING_FILL = Object.freeze({ ZEBRA: 0, SOLID: 1, HATCH: 2, RUBBER: 3, CHEVRONS: 5 });
/** MARKING p0, upper five bits: lane width in these units (0 = the decal does not know its lanes). */
export const MARKING_LANE_UNIT = 0.125;
const LANE_CENTRED = 31;                 // widest code: a decal centred on its own lane, wheel paths either side of u = 0
/** Thermoplastic colours in sRGB (the vertex colour is the paint). */
export const PAINT = Object.freeze({ WHITE: [0.775, 0.772, 0.75], YELLOW: [0.77, 0.65, 0.25] });

export const STOP_LINE_WIDTH = 0.45;
const ARROW_LINE = 0.2, TEXT_STROKE = 0.14, TEXT_HEIGHT = 2.4, TEXT_WIDTH = 0.52, TEXT_GAP = 0.26;
const BOX_LINE = 0.15, BUS_DASH = 1.0, BUS_GAP = 0.6;

/** Decal frame at (x, z) with heading yaw: maps (u, v) to the caller's (x, z). */
function frame(o, lanes = NO_LANES) {
  const s = Math.sin(o.yaw || 0), c = Math.cos(o.yaw || 0), y = o.y ?? LAND_Y;
  return { y, shift: lanes.shift, at: (u, v) => [o.x - c * u + s * v, o.z + s * u + c * v] };
}

// weight: the marking weight of the road under the decal (1 on a free-running leg, 0.5 at a stop line, 0 inside a
// junction), carried in the vertex alpha so that the shader lays the same asphalt under the paint as beside it.
function begin(mb, fill, o, lanes = NO_LANES, weight = 1) {
  mb.family(FAMILY.GROUND).material(GROUND.MARKING, fill + 8 * lanes.code, o.wear ?? 90, o.age ?? 120).color(o.paint || PAINT.WHITE).occlusion(o.weight ?? weight);
  return mb.idxLen[FAMILY.GROUND];
}

// Lane information of a decal: the width code for p0 and the shift that puts lane boundaries on multiples of the width.
const NO_LANES = Object.freeze({ code: 0, shift: 0 });
const OWN_LANE = Object.freeze({ code: LANE_CENTRED, shift: LANE_CENTRED * MARKING_LANE_UNIT / 2 });
/** For a decal anchored on the centre line of a road (every lane layout is symmetric about it). */
function lanesAcross(o) {
  if (!(o.halfWidth > 0) || o.laneCode == null) return NO_LANES;
  const layout = laneLayout(o.halfWidth, o.laneCode);
  return { code: Math.min(LANE_CENTRED - 1, Math.round(layout.laneWidth / MARKING_LANE_UNIT)), shift: layout.laneWidth / 2 - layout.lanes[0].offset };
}
const added = (mb, start) => ({ triangles: (mb.idxLen[FAMILY.GROUND] - start) / 3 });

/** Convex polygon given in decal space, in either winding; emitted facing up. */
function polygon(mb, f, pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const order = area >= 0 ? pts : pts.slice().reverse();          // counter-clockwise in (u, v) faces +Y
  const idx = order.map(([u, v]) => { const w = f.at(u, v); return mb.vertex(w[0], f.y, w[1], 0, 1, 0, u + f.shift, v); });
  for (let i = 1; i + 1 < idx.length; i++) mb.tri(idx[0], idx[i], idx[i + 1]);
}

/** A straight band of paint from a to b, square ended, lengthened by `cap` at both ends. */
function stroke(mb, f, a, b, width, cap = 0) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); if (l < 1e-6) return;
  const tx = dx / l, ty = dy / l, nx = -ty * width / 2, ny = tx * width / 2, ex = tx * cap, ey = ty * cap;
  polygon(mb, f, [[a[0] - ex - nx, a[1] - ey - ny], [b[0] + ex - nx, b[1] + ey - ny], [b[0] + ex + nx, b[1] + ey + ny], [a[0] - ex + nx, a[1] - ey + ny]]);
}

/**
 * Pedestrian crossing. x, z: centre, on the centre line of the road; yaw: heading of the road being crossed;
 * width: kerb to kerb. halfWidth, laneCode (optional): the road's, so that the paint wears in its wheel paths.
 * 'zebra' is one quad whose bars the shader draws along the road; 'lines' is a pair of transverse bars.
 */
export function addCrosswalk(mb, o) {
  const lanes = lanesAcross(o), f = frame(o, lanes), hw = o.width / 2, hd = (o.depth ?? 3) / 2, style = o.style || 'zebra';
  const start = begin(mb, style === 'zebra' ? MARKING_FILL.ZEBRA : MARKING_FILL.SOLID, o, lanes, 0);
  if (style === 'zebra') polygon(mb, f, [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]);
  else for (const v of [-hd + 0.15, hd - 0.15]) stroke(mb, f, [-hw, v], [hw, v], 0.3);
  return added(mb, start);
}

/**
 * Stop bar across the approach lanes: lateral offsets from..to at the centre-line point x, z (right of the heading
 * is positive). halfWidth, laneCode (optional): the road's, as for addCrosswalk.
 */
export function addStopLine(mb, o) {
  const lanes = lanesAcross(o), f = frame(o, lanes), start = begin(mb, MARKING_FILL.SOLID, o, lanes, 0.5);
  stroke(mb, f, [Math.min(o.from, o.to), 0], [Math.max(o.from, o.to), 0], STOP_LINE_WIDTH);
  return added(mb, start);
}

/** One arrow limb: a shaft from a to b that ends in a barbed head pointing the same way. */
function limb(mb, f, a, b, headLength, headHalf) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy), tx = dx / l, ty = dy / l;
  const neck = [b[0] - tx * headLength, b[1] - ty * headLength];
  stroke(mb, f, a, neck, ARROW_LINE);
  polygon(mb, f, [[neck[0] + ty * headHalf, neck[1] - tx * headHalf], b, [neck[0] - ty * headHalf, neck[1] + tx * headHalf]]);
}

/**
 * Lane arrow, 3.2 m long, anchored at its middle and pointing along yaw.
 * kind: 'straight' | 'left' | 'right' | 'straight-left' | 'straight-right'.
 */
export function addArrow(mb, o) {
  const f = frame(o, OWN_LANE), start = begin(mb, MARKING_FILL.SOLID, o, OWN_LANE), kind = o.kind || 'straight';
  const turn = kind.includes('left') ? -1 : kind.includes('right') ? 1 : 0, ahead = kind.startsWith('straight');
  if (ahead) limb(mb, f, [0, -1.6], [0, 1.6], 1.25, 0.42);
  else stroke(mb, f, [0, -1.6], [0, 0.35], ARROW_LINE);
  if (turn) {
    // the branch leaves the shaft below the head and sweeps to the side through one bend
    const root = ahead ? -0.5 : 0.3, bend = [turn * 0.28, root + 0.42], tip = [turn * 1.05, root + 0.72];
    stroke(mb, f, [0, root - 0.06], bend, ARROW_LINE, 0.06);
    limb(mb, f, bend, tip, 0.62, 0.36);
  }
  return added(mb, start);
}

/**
 * Hatched gore or painted island. points: convex outline [[x, z], ...] in the caller's coordinates; yaw: heading
 * of the traffic beside it, which the diagonal bars lean against. Outlined with a solid line as painted on site.
 */
export function addChevrons(mb, o) {
  const s = Math.sin(o.yaw || 0), c = Math.cos(o.yaw || 0), x0 = o.points[0][0], z0 = o.points[0][1];
  const f = frame({ ...o, x: x0, z: z0 });
  const local = o.points.map(([x, z]) => [-(x - x0) * c + (z - z0) * s, (x - x0) * s + (z - z0) * c]);
  const start = begin(mb, MARKING_FILL.CHEVRONS, o);
  polygon(mb, f, local);
  begin(mb, MARKING_FILL.SOLID, o);
  for (let i = 0; i < local.length; i++) stroke(mb, f, local[i], local[(i + 1) % local.length], LANE.LINE, LANE.LINE / 2);
  return added(mb, start);
}

// Letters as strokes on a unit square (x to the right, y away from the reader), drawn tall because a driver
// reads them foreshortened.
const GLYPHS = {
  A: [[[0, 0], [0.5, 1], [1, 0]], [[0.2, 0.4], [0.8, 0.4]]],
  B: [[[0, 0], [0, 1], [0.75, 1], [0.95, 0.87], [0.95, 0.63], [0.75, 0.5], [0, 0.5]], [[0.75, 0.5], [1, 0.37], [1, 0.13], [0.8, 0], [0, 0]]],
  G: [[[1, 0.85], [0.8, 1], [0.2, 1], [0, 0.85], [0, 0.15], [0.2, 0], [0.8, 0], [1, 0.15], [1, 0.45], [0.55, 0.45]]],
  I: [[[0.5, 0], [0.5, 1]]],
  L: [[[0, 1], [0, 0], [1, 0]]],
  N: [[[0, 0], [0, 1], [1, 0], [1, 1]]],
  O: [[[0.2, 0], [0, 0.15], [0, 0.85], [0.2, 1], [0.8, 1], [1, 0.85], [1, 0.15], [0.8, 0], [0.2, 0]]],
  P: [[[0, 0], [0, 1], [0.8, 1], [1, 0.87], [1, 0.6], [0.8, 0.47], [0, 0.47]]],
  S: [[[1, 0.85], [0.8, 1], [0.2, 1], [0, 0.85], [0, 0.6], [0.2, 0.5], [0.8, 0.5], [1, 0.4], [1, 0.15], [0.8, 0], [0.2, 0], [0, 0.15]]],
  T: [[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
  U: [[[0, 1], [0, 0.15], [0.2, 0], [0.8, 0], [1, 0.15], [1, 1]]],
  W: [[[0, 1], [0.2, 0], [0.5, 0.6], [0.8, 0], [1, 1]]],
  X: [[[0, 0], [1, 1]], [[0, 1], [1, 0]]],
  Y: [[[0, 1], [0.5, 0.5], [1, 1]], [[0.5, 0.5], [0.5, 0]]],
};

/** A word in decal space, centred on (cu, cv); size scales the standard lettering. */
function letters(mb, f, text, cu, cv, size = 1) {
  const word = text.toUpperCase(), wide = TEXT_WIDTH * size, pitch = wide + TEXT_GAP * size, left = cu - (word.length * pitch - TEXT_GAP * size) / 2;
  for (let k = 0; k < word.length; k++) {
    const glyph = GLYPHS[word[k]]; if (!glyph) throw new Error(`road lettering: no glyph for "${word[k]}"`);
    const place = ([x, y]) => [left + k * pitch + x * wide, cv + (y - 0.5) * TEXT_HEIGHT * size];
    for (const line of glyph) for (let i = 0; i + 1 < line.length; i++) stroke(mb, f, place(line[i]), place(line[i + 1]), TEXT_STROKE * size, TEXT_STROKE * size / 2);
  }
}

/** A word painted across the lane, centred on x, z (the middle of the lane) and read by traffic heading along yaw. */
export function addRoadText(mb, o) {
  const f = frame(o, OWN_LANE), start = begin(mb, MARKING_FILL.SOLID, o, OWN_LANE, 0.75);
  letters(mb, f, o.word, 0, 0);
  return added(mb, start);
}

/**
 * Yellow box junction: criss-cross hatching over the convex outline points [[x, z], ...] with a border line.
 * yaw: heading of one of the roads; the hatching runs diagonally to it.
 */
export function addBoxJunction(mb, o) {
  const s = Math.sin(o.yaw || 0), c = Math.cos(o.yaw || 0), x0 = o.points[0][0], z0 = o.points[0][1], paint = { ...o, paint: o.paint || PAINT.YELLOW };
  const f = frame({ ...o, x: x0, z: z0 });
  const local = o.points.map(([x, z]) => [-(x - x0) * c + (z - z0) * s, (x - x0) * s + (z - z0) * c]);
  const start = begin(mb, MARKING_FILL.HATCH, paint, NO_LANES, 0);
  polygon(mb, f, local);
  begin(mb, MARKING_FILL.SOLID, paint, NO_LANES, 0);
  for (let i = 0; i < local.length; i++) stroke(mb, f, local[i], local[(i + 1) % local.length], BOX_LINE, BOX_LINE / 2);
  return added(mb, start);
}

/**
 * Bus stop box against the kerb: a broken yellow outline on the three sides away from the kerb and the words
 * BUS STOP, read by traffic heading along yaw. x, z: centre of the box; the kerb is on the right of yaw.
 */
export function addBusStop(mb, o) {
  const length = o.length ?? 14, hw = (o.width ?? 2.8) / 2, hl = length / 2, paint = { ...o, paint: o.paint || PAINT.YELLOW };
  const f = frame(o), start = begin(mb, MARKING_FILL.SOLID, paint);
  const dashed = (a, b) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round((l + BUS_GAP) / (BUS_DASH + BUS_GAP))), pitch = (l + BUS_GAP) / n;
    for (let k = 0; k < n; k++) {
      const t0 = k * pitch / l, t1 = Math.min(1, (k * pitch + pitch - BUS_GAP) / l);
      stroke(mb, f, [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], BOX_LINE);
    }
  };
  dashed([hw, -hl], [-hw, -hl]); dashed([-hw, -hl], [-hw, hl]); dashed([-hw, hl], [hw, hl]);
  // the driver meets BUS first; both words are squeezed to the width of the box
  const size = Math.min(1, (2 * hw - 0.5) / (4 * (TEXT_WIDTH + TEXT_GAP) - TEXT_GAP)), step = TEXT_HEIGHT * size * 0.5 + 0.5;
  letters(mb, f, 'BUS', 0, -step, size); letters(mb, f, 'STOP', 0, step, size);
  return added(mb, start);
}

/**
 * Rubber laid by a sliding tyre: a ribbon along points [[x, z, strength 0..1], ...] in the caller's coordinates.
 * width: tyre width in metres; y: road height; age: age byte of the asphalt underneath; start: metres already
 * laid by earlier pieces of the same mark, so the streaks run on from piece to piece.
 * The shader darkens the road under it; it cannot keep lane paint it crosses, so keep it no wider than a tyre.
 * Returns { triangles, length } with length = start plus the length added.
 */
export function addRubberStrip(mb, o) {
  const pts = o.points, y = o.y ?? LAND_Y, hw = (o.width ?? 0.25) / 2;
  mb.family(FAMILY.GROUND).material(GROUND.MARKING, MARKING_FILL.RUBBER, 0, o.age ?? 120).color(1, 1, 1);
  const begun = mb.idxLen[FAMILY.GROUND];
  let along = o.start ?? 0, prev = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], p = pts[i];
    const tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1, nx = -tz / l * hw, nz = tx / l * hw;   // to the right of travel
    if (i > 0) along += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    mb.occlusion(Math.max(0, Math.min(1, p[2] ?? 1)));
    const left = mb.vertex(p[0] - nx, y, p[1] - nz, 0, 1, 0, -1, along), right = mb.vertex(p[0] + nx, y, p[1] + nz, 0, 1, 0, 1, along);
    if (prev) { mb.tri(prev[0], prev[1], right); mb.tri(prev[0], right, left); }     // counter-clockwise seen from above
    prev = [left, right];
  }
  return { triangles: (mb.idxLen[FAMILY.GROUND] - begun) / 3, length: along };
}
