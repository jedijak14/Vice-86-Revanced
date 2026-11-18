// The cabin: windscreen frame, A pillars, roof and sail panels as one skin cut from the canopy loft, with the glass
// set into rebates under a dark rubber seal, an inner lining so nothing is see-through, and the rear wall with its
// slot window.

import { VEHICLE, GLASS } from '../../core/ids.js';
import { makeLoft, walk } from './kit/sheet.js';
import { buildPanel, hem, HEM_TUCK } from './kit/panel.js';
import { patch, region, ringLoft } from './kit/solids.js';
import { contains } from './kit/outline.js';
import * as S from './spec.js';
import { topPoint } from './body.js';

const MM = S.MM, C = S.CANOPY, W = S.WINDSCREEN, G = S.SIDE_GLASS;
/** The rebate a pane sits in: a small roll and a dark wall down to the glass. */
const REVEAL = hem({ radius: 0.003, depth: 0.011, segs: 3, dark: 0.15 });
const LINING_DEPTH = 0.016, LINING_WIDTH = 0.042, FRIT_WIDTH = 0.022;
/**
 * The edge on which the canopy stands on the scuttle and the wing. At the foot of the pillar the canopy is some 10 mm
 * proud of the body under it, and its edge wall goes down well past that: a wall that stopped short would leave a
 * slot between the two skins, open to any eye level with it.
 */
const SEAT = hem({ radius: 0.0008, depth: 0.022, segs: 1 });
const seated = { hem: SEAT, inset: SEAT.reach }, reveal = { hem: REVEAL, inset: REVEAL.reach }, bare = { hem: null, inset: 0 };
const LINING = [0.035, 0.033, 0.03];
export const TINT = { screen: [0.62, 0.74, 0.70], side: [0.50, 0.60, 0.58] };

/** The canopy sheet. Chart: a = x in drawing millimetres, b = 0 centre line, 1 pillar / roof edge, 2 glass base. */
export function makeCanopy(filletRows = 4) {
  return makeLoft({
    rails: [S.CANOPY_RAIL.C, S.CANOPY_RAIL.R, S.CANOPY_RAIL.G], radius: [0, S.CANOPY_RADIUS, 0], crown: [S.CANOPY_CROWN, 0], centred: true,
    place: (a, p, q, out) => S.toCar(a, q, p, out), flip: true, ha: 0.5, arcSegs: filletRows,
  });
}

/** Point of the sheet pushed `depth` metres under the skin. */
export function under(sheet, a, b, depth) {
  const p = sheet.pos(a, b, [0, 0, 0]), n = sheet.normal(a, b, [0, 0, 0]);
  return [p[0] - n[0] * depth, p[1] - n[1] * depth, p[2] - n[2] * depth];
}

const stations = (x0, x1, step, extra = []) => {
  const xs = new Set([x0, x1, ...extra.filter((x) => x > x0 && x < x1)]), n = Math.max(1, Math.round((x1 - x0) / step));
  for (let i = 1; i < n; i++) xs.add(x0 + (x1 - x0) * i / n);
  return [...xs].sort((a, b) => a - b);
};

/**
 * A pane: the sheet sampled on rows of constant x between two chart edges, sunk under the skin, with an outer and an
 * inner face. edge0(x), edge1(x) return chart b.
 */
function pane(glass, sheet, xs, edge0, edge1, { depth, thickness, tint, opacity, cols = 8, wiper = null }) {
  const grid = (d) => xs.map((x) => { const b0 = edge0(x), b1 = edge1(x), row = []; for (let j = 0; j <= cols; j++) row.push(under(sheet, x, b0 + (b1 - b0) * j / cols, d)); return row; });
  const mid = xs[xs.length >> 1], out = sheet.normal(mid, (edge0(mid) + edge1(mid)) / 2, [0, 0, 0]), into = out.map((v) => -v);
  // A wiped pane tells the glass shader where its wiper is: p1/p2 are the swept band's outer and inner radius in cm,
  // and each vertex's uv is its offset from the spindle in metres, x across the car and y up the glass.
  const sweep = (rows) => (wiper ? (i, j) => { const p = rows[i][j], s = wiper.spindle, dy = p[1] - s[1], dz = p[2] - s[2]; return [p[0] - s[0], Math.sign(dy) * Math.hypot(dy, dz)]; } : null);
  glass.material(GLASS.TINTED, opacity, wiper ? Math.round(wiper.outer * 100) : 0, wiper ? Math.round(wiper.inner * 100) : 0); glass.color(tint); glass.occlusion(1);
  const outer = grid(depth), inner = grid(depth + thickness);
  patch(glass, outer, { facing: out, crease: 50, uv: sweep(outer) });
  patch(glass, inner, { facing: into, crease: 50, uv: sweep(inner) });
}

/**
 * A band that follows the edge of an aperture, between two lines given as [depth under the skin, distance away from
 * the opening] in metres (a negative distance reaches into it). Used for the cabin lining behind the frame, for the
 * black border of the glass and for the return that joins the two. run: consecutive points of the panel's own
 * prepared edge. faces: 'out' of the car, 'in' to the cabin, or towards the middle of the 'aperture'.
 * Both lines are walked off along the skin and then sunk under it, so the band stays behind the panel round the
 * pillar and stops where the panel does (`domain`, see walk()).
 */
function edgeBand(body, sheet, domain, run, closed, from, to, faces) {
  const P = run.map((q) => sheet.pos(q.p[0], q.p[1], [0, 0, 0])), N = run.map((q) => sheet.normal(q.p[0], q.p[1], [0, 0, 0])), n = P.length;
  const centre = [0, 1, 2].map((k) => P.reduce((s, p) => s + p[k], 0) / n);
  const rows = [[], []], away = [];
  for (let i = 0; i < n; i++) {
    const a = P[closed ? (i + n - 1) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)], t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], nr = N[i];
    let o = [t[1] * nr[2] - t[2] * nr[1], t[2] * nr[0] - t[0] * nr[2], t[0] * nr[1] - t[1] * nr[0]]; const l = Math.hypot(...o) || 1;
    const sign = (o[0] * (P[i][0] - centre[0]) + o[1] * (P[i][1] - centre[1]) + o[2] * (P[i][2] - centre[2])) > 0 ? 1 / l : -1 / l;
    o = o.map((v) => v * sign); away.push(o);
    [from, to].forEach(([depth, reach], r) => rows[r].push(under(sheet, ...walk(sheet, run[i].p[0], run[i].p[1], reach < 0 ? o.map((v) => -v) : o, Math.abs(reach), domain), depth)));
  }
  const m = n >> 1, facing = faces === 'aperture' ? away[m].map((v) => -v) : N[m].map((v) => (faces === 'out' ? v : -v));
  patch(body, rows, { facing, closeJ: closed, crease: 60 });
}

/** Runs of consecutive edge points of a prepared loop that carry the given hem. */
function hemRuns(loop, profile) {
  const n = loop.length, has = (i) => loop[(i + n) % n].hem === profile;
  if (loop.every((q) => q.hem === profile)) return [{ run: loop, closed: true }];
  const runs = []; let start = 0; while (has(start)) start++;
  let cur = null;
  for (let s = 1; s <= n; s++) {
    const i = (start + s) % n;
    if (has(i)) { if (!cur) { cur = [loop[i]]; runs.push({ run: cur, closed: false }); } cur.push(loop[(i + 1) % n]); } else cur = null;
  }
  return runs;
}

/**
 * The windscreen wiper's spindle (vehicle metres) and the radii of the band its blade sweeps, from the same numbers
 * that place the wiper itself (details.js): the blade is parked across the glass from near the spindle to its far tip.
 */
function wiperSweep(hull) {
  const Wp = S.DETAIL.wiper, spindle = topPoint(hull, Wp.pivotX, Wp.pivotZ, 0), near = Wp.pivotZ + 90, far = near - Wp.blade, dx = (Wp.bladeX - Wp.pivotX) * MM;
  return { spindle, inner: Math.hypot(dx, (near - Wp.pivotZ) * MM), outer: Math.hypot(dx, (far - Wp.pivotZ) * MM) };
}

/**
 * After the glass has been mirrored to the right-hand side: the one wiper stays where it is, so the copied
 * windscreen vertices (from index `first`) get their offset across the car measured from the real spindle again.
 */
export function mirrorWiperSweep(glass, first, hull) {
  const spindleX = wiperSweep(hull).spindle[0];
  for (let i = first; i < glass.count; i++) {
    if (glass.mat[i * 4] === GLASS.TINTED && glass.mat[i * 4 + 2] > 0) glass.uv[i * 2] = -glass.uv[i * 2] - 2 * spindleX;
  }
}

/** Left half of the cabin. body: VEHICLE builder, glass: GLASS builder. */
export function buildGreenhouse(body, glass, hull, quality) {
  const canopy = makeCanopy(Math.min(4, quality.fillet));
  const top = (x, z) => [x, canopy.solve(x, 0, z, 0, 0.9)];
  const below = (x, mm) => canopy.bOf(x, canopy.arcOf(x, 1) + mm), above = (x, mm) => canopy.bOf(x, canopy.arcOf(x, 2) - mm);
  const inPlan = { via: 0, range: [0, 2] };

  // --- skin
  const sideXs = stations(G.x0, G.x1, 150, [C.headerX]);
  const sideHole = [
    ...sideXs.map((x, i) => ({ p: [x, below(x, G.pillar)], ...reveal, r: i === 0 || i === sideXs.length - 1 ? 0.012 : 0 })),
    ...sideXs.slice().reverse().map((x, i) => ({ p: [x, above(x, G.belt)], ...reveal, r: i === 0 || i === sideXs.length - 1 ? 0.012 : 0 })),
  ];
  body.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); body.color(1, 1, 1); body.occlusion(1);
  const loops = buildPanel(body, canopy, {
    outer: [
      { p: [C.x0, 0], ...seated, sharp: true },
      { p: [C.x0, canopy.solve(C.x0, 0, S.SCREEN_BASE.z0, 0, 0.9)], ...inPlan, ...seated, sharp: true },
      // along the belt the edge is the sheet's own last row: no inset, which on this chart would not stay parallel to it
      { p: [C.footX, 2], hem: HEM_TUCK, inset: 0, sharp: true },
      { p: [C.x1, 2], ...bare, sharp: true },
      { p: [C.x1, 0], ...bare, sharp: true },
      { p: [W.headerX, 0], ...reveal, sharp: true },
      { p: top(W.headerX, W.headerZ), ...inPlan, ...reveal, r: 0.02 },
      { p: top(W.footX, W.footZ), ...inPlan, ...reveal, r: 0.02 },
      { p: top(W.baseX, W.baseZ), ...reveal, r: 0.02 },
      { p: [W.baseX, 0], ...bare, sharp: true },
    ],
    holes: [sideHole], da: quality.da, db: quality.db, ...(quality.hems ? { cornerSegs: 5 } : { cornerSegs: 2, tolerance: 0.0015, halvings: 1 }),
  });

  // --- lining: behind every aperture edge, under the roof and inside the sail panel
  body.material(VEHICLE.INTERIOR, 2, 0); body.color(LINING); body.occlusion(0.7);
  const apertures = loops.flatMap((loop) => hemRuns(loop, REVEAL));
  // The lining stops just ahead of the slot window's pane: run to the rear wall it would cut through the slot's rebate.
  // Nor may a band leave the canopy's own outline, ahead of which the sheet runs on over the scuttle in thin air. The
  // windscreen's edge is part of the outer loop only because the car is built in halves; the bands cross it freely.
  const liningEnd = C.x1 - S.REAR_WINDOW.depth - 3, outline = loops[0].filter((q) => q.hem !== REVEAL).map((q) => q.p);
  const domain = { a: [C.x0, liningEnd], b: [0, 2], within: (a, b) => b <= 0 || contains(outline, [a, b]) };
  const band = (run, closed, from, to, faces) => edgeBand(body, canopy, domain, run, closed, from, to, faces);
  for (const { run, closed } of apertures) band(run, closed, [LINING_DEPTH, -FRIT_WIDTH], [LINING_DEPTH, LINING_WIDTH], 'in');
  const field = (xs, b0, b1, cols) => xs.map((x) => { const row = []; for (let j = 0; j <= cols; j++) row.push(under(canopy, x, b0(x) + (b1(x) - b0(x)) * j / cols, LINING_DEPTH)); return row; });
  const roofXs = stations(W.headerX + 20, liningEnd, 120), mid = (xs) => xs[xs.length >> 1];
  patch(body, field(roofXs, () => 0, () => 0.9, 4), { facing: canopy.normal(mid(roofXs), 0.4, [0, 0, 0]).map((v) => -v), crease: 60 });
  const sailXs = stations(G.x1 + 20, liningEnd, 60);
  patch(body, field(sailXs, () => 1.1, () => 2, 3), { facing: canopy.normal(mid(sailXs), 1.5, [0, 0, 0]).map((v) => -v), crease: 60 });

  // --- glass
  const overlap = 9, lin = (x, x0, v0, x1, v1) => v0 + (v1 - v0) * Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  const screenEdge = (x) => (x < W.footX ? lin(x, W.baseX, W.baseZ, W.footX, W.footZ) : lin(x, W.footX, W.footZ, W.headerX, W.headerZ)) + overlap;
  pane(glass, canopy, stations(W.baseX - overlap, W.headerX + overlap, 70, [W.footX]), () => 0, (x) => canopy.solve(x, 0, screenEdge(x), 0, 0.9),
    { depth: W.depth * MM, thickness: W.thickness * MM, tint: TINT.screen, opacity: 50, cols: 10, wiper: wiperSweep(hull) });
  pane(glass, canopy, stations(G.x0 - overlap, G.x1 + overlap, 90, [G.dividerX]), (x) => below(x, G.pillar - overlap), (x) => above(x, G.belt - overlap),
    { depth: G.depth * MM, thickness: G.thickness * MM, tint: TINT.side, opacity: 70, cols: 5 });
  // black border printed on the inside of each pane
  body.material(VEHICLE.TRIM_BLACK, 90, 0); body.color(0.012, 0.012, 0.013); body.occlusion(1);
  const fritDepth = (Math.max(W.depth + W.thickness, G.depth + G.thickness) + 0.8) * MM;
  for (const { run, closed } of apertures) {
    band(run, closed, [fritDepth, 0.008], [fritDepth, -FRIT_WIDTH], 'out');
    // the lining comes in as far as the border, and a return joins their edges: the frame is closed from every side
    band(run, closed, [fritDepth, -FRIT_WIDTH], [LINING_DEPTH, -FRIT_WIDTH], 'aperture');
  }

  // --- seals: a dark rubber surround on the skin round every pane, standing a little proud, so the glass is framed
  // in black from outside (the frit is seen through the glass; this is what thins the pillars to the eye)
  const seal = S.GLASS_SEAL, sealWidth = seal.width * MM, sealProud = seal.proud * MM;
  body.material(VEHICLE.TRIM_BLACK, 165, 0); body.color(0.014, 0.014, 0.015); body.occlusion(1);
  for (const { run, closed } of apertures) {
    band(run, closed, [0, sealWidth], [-sealProud, 0], 'out');
    band(run, closed, [-sealProud, 0], [0, 0], 'aperture');
  }

  // --- window bars: quarter-pane divider and the split of the drop glass
  body.material(VEHICLE.TRIM_BLACK, 120, 0); body.color(0.015, 0.015, 0.016); body.occlusion(1);
  const bar = (pts, width) => {
    const rows = pts.map(([x, b], i) => {
      const p = under(canopy, x, b, G.depth * MM - 0.004), q = pts[Math.min(pts.length - 1, i + 1)], r = pts[Math.max(0, i - 1)];
      const a = canopy.pos(r[0], r[1], [0, 0, 0]), c = canopy.pos(q[0], q[1], [0, 0, 0]), t = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], n = canopy.normal(x, b, [0, 0, 0]);
      let s = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]]; const l = Math.hypot(...s); s = s.map((v) => v / l * width / 2);
      const lift = n.map((v) => v * 0.003);
      return [[p[0] - s[0] - lift[0], p[1] - s[1] - lift[1], p[2] - s[2] - lift[2]], [p[0] - s[0], p[1] - s[1], p[2] - s[2]], [p[0] + s[0], p[1] + s[1], p[2] + s[2]], [p[0] + s[0] - lift[0], p[1] + s[1] - lift[1], p[2] + s[2] - lift[2]]];
    });
    // a closed section: the bars are seen from inside the cabin as well
    patch(body, rows, { facing: canopy.normal(pts[0][0], pts[0][1], [0, 0, 0]), closeJ: true, crease: 40 });
  };
  const b0 = below(G.dividerX, G.pillar - 4), b1 = above(G.dividerX, G.belt - 4);
  bar([0, 0.25, 0.5, 0.75, 1].map((t) => [G.dividerX, b0 + (b1 - b0) * t]), 0.016);
  const splitB = (x) => canopy.solve(x, 1, G.splitY, 1.1, 2);
  bar(stations(G.dividerX, G.x1 + 4, 120).map((x) => [x, splitB(x)]), 0.012);

  buildRearWall(body, glass, canopy, hull);
  return canopy;
}

/** The wall behind the seats, from the roof down to the engine deck, with its slot window. */
function buildRearWall(body, glass, canopy, hull) {
  const x = C.x1, plane = (u, v, w = 0) => S.toCar(x + w, v, -u), R = S.REAR_WINDOW;
  const sec = (sheet, bs) => bs.map((b) => { const p = sheet.pos(x, b, [0, 0, 0]); return [-p[0] / MM, p[1] / MM]; });
  const lower = sec(hull, [0, 0.9, 1, 1.1, 1.9, 2, 2.1, 3]);                         // deck, valley wall, wing top
  // side, roof edge, roof. The roof is crowned: a wall cut straight across under it would leave a sliver of daylight
  // between its top and the roof's trailing edge, so its top edge follows the crown.
  const roofSteps = 12, roof = Array.from({ length: roofSteps + 1 }, (_, i) => 0.9 * (1 - i / roofSteps));
  const upper = sec(canopy, [2, 1.1, 1.07, 1.03, 1, 0.97, 0.93, ...roof]);
  lower[0][0] = 0; upper[upper.length - 1][0] = 0;
  const slot = [[0, R.y[1]], [-R.halfWidth, R.y[1]], [-R.halfWidth, R.y[0]], [0, R.y[0]]];
  body.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); body.color(1, 1, 1); body.occlusion(0.8);
  region(body, plane, [...lower, ...upper, ...slot]);
  body.material(VEHICLE.TRIM_BLACK, 150, 0); body.color(0.015, 0.015, 0.016); body.occlusion(0.5);
  ringLoft(body, plane, slot, [[0, 0], [0, -R.depth]], { open: true });
  glass.material(GLASS.TINTED, 70, 0); glass.color(TINT.side); glass.occlusion(1);
  const pad = 6, quad = [[0, R.y[1] + pad], [-R.halfWidth - pad, R.y[1] + pad], [-R.halfWidth - pad, R.y[0] - pad], [0, R.y[0] - pad]];
  region(glass, plane, quad, [], { w: -R.depth });
}
