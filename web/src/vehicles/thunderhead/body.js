// The coachwork: every painted panel that is cut from the hull.
// Panels are authored on shared seam lines and each is inset by half a shut line, so the gaps between them are real.
// Side-view shapes (door, wheel openings, rocker) are given in drawing x, y and found on the hull by solving for the
// height; plan shapes (the bonnet's trailing edge, the hatch glass) are given in x, z.

import { VEHICLE } from '../../core/ids.js';
import { buildPanel, hem, HEM_GAP, HEM_LIP, HEM_TUCK } from '../hero/kit/panel.js';
import { roundCorners } from '../hero/kit/outline.js';
import * as S from './spec.js';

const MM = S.MM, HALF_GAP = S.GAP / 2 * MM, B = S.B_OF;
/** The bonnet's leading edge folds down behind the rub strip. */
const HEM_FOLD = hem({ radius: 0.005, turn: 80, depth: 0.014, segs: 5, dark: 0.3 });
/** The rebate a pane sits in: a small roll and a dark wall down to the glass. */
export const REVEAL = hem({ radius: 0.003, depth: 0.011, segs: 3, dark: 0.15 });

/** Chart ranges in which a plan position (z) and a side-view height (y) are looked for. */
const TOP = [0, B.H], SIDE = [B.G, B.S + 0.3], FLOOR = [B.S + 0.3, B.B];
/** Rows where the panels above and below the belt end: the two edges of the belt's own crease, under the rub strip. */
export const BELT_UP = B.R - 0.3, BELT_DOWN = B.R + 0.3;
/** Row of the body side's lower edge under the rocker, and of the base of the side glass. */
export const SILL_ROW = SIDE[1], GLASS_ROW = B.G;

/** Chart coordinates of a point given in side view (x, y), in plan (x, z) or on the floor (x, z). */
export const onSide = (hull, x, y) => [x, hull.solve(x, 1, y, SIDE[0], SIDE[1])];
export const onTop = (hull, x, z) => [x, hull.solve(x, 0, z, TOP[0], TOP[1])];
export const onFloor = (hull, x, z) => [x, hull.solve(x, 0, z, FLOOR[0], FLOOR[1])];
/** Point of the hull at chart position c, `depth` millimetres under the surface. Vehicle metres. */
export function under(hull, c, depth = 0) {
  const p = hull.pos(c[0], c[1], [0, 0, 0]), n = hull.normal(c[0], c[1], [0, 0, 0]);
  return [p[0] - n[0] * depth * MM, p[1] - n[1] * depth * MM, p[2] - n[2] * depth * MM];
}
export const topPoint = (hull, x, z, depth = 0) => under(hull, onTop(hull, x, z), depth);
export const sidePoint = (hull, x, y, depth = 0) => under(hull, onSide(hull, x, y), depth);
/** Height (mm) of a chart row at station x. */
export const rowY = (hull, x, row) => hull.pos(x, row, [0, 0, 0])[1] / MM;

// Edge kinds: what happens along the edge that leaves a vertex. Outlines are authored where the panel's edge wall
// stands; the skin stops short of that by the reach of the rolled edge (and by half a shut line on a seam).
const seam = { hem: HEM_GAP, inset: HALF_GAP + HEM_GAP.reach };
const free = { hem: HEM_LIP, inset: HEM_LIP.reach };
const tucked = { hem: HEM_TUCK, inset: HEM_TUCK.reach };
const reveal = { hem: REVEAL, inset: REVEAL.reach };
/** The edge of the frame round the windscreen: the same rebate, but glazed from its own sheet (greenhouse.js). */
const SCREEN_EDGE = hem({ radius: 0.003, depth: 0.012, segs: 3, dark: 0.15 });
const glazed = { hem: SCREEN_EDGE, inset: SCREEN_EDGE.reach };
const bare = { hem: null, inset: 0 };
/** An edge that lies on a chart row and is hidden (under the rub strip, under a seal): no inset, which would leave the row. */
const onRow = { hem: HEM_TUCK, inset: 0 };
const inSide = { via: 1, range: SIDE }, inPlan = { via: 0, range: TOP }, inGlass = { via: 1, range: [B.E, B.G] };
/** The edge of a slot cut through a panel (gill, door handle): a small roll and a dark wall. */
const SLOT = hem({ radius: 0.0035, depth: 0.015, segs: 4, dark: 0.3 });
const slot = { hem: SLOT, inset: SLOT.reach };
/** Side-view outlines [x, y] of the two gills, each a leaning slot. */
export function gillOutlines() {
  const G = S.GILL, h = G.width / 2, mid = (G.y[0] + G.y[1]) / 2, at = (c, y) => c - G.lean * (y - mid) / (G.y[1] - G.y[0]);
  return G.x.map((c) => [[at(c, G.y[0]) - h, G.y[0]], [at(c, G.y[0]) + h, G.y[0]], [at(c, G.y[1]) + h, G.y[1]], [at(c, G.y[1]) - h, G.y[1]]]);
}
/** Side-view outline [x, y] of the door handle's pocket. */
export function handleOutline() { const H = S.HANDLE; return [[H.x[0], H.y[0]], [H.x[1], H.y[0]], [H.x[1], H.y[1]], [H.x[0], H.y[1]]]; }

/** The pop-up lamp lid's outline on the bonnet as a panel loop, every edge of the given kind. */
const lidLoop = (hull, kind) => { const P = S.LAMP_POD; return [[P.x0, P.z0], [P.x0, P.z1], [P.x1, P.z1], [P.x1, P.z0]].map(([x, z]) => ({ p: onTop(hull, x, z), ...inPlan, ...kind, r: P.corner })); };
/**
 * The lid of the pop-up headlamp pod, shut: the piece of bonnet skin that buildCoachwork leaves out, with the same
 * shut line all round. It goes into its own builder because the pod is a moving part.
 */
export function buildLampLid(pod, hull, quality) {
  pod.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); pod.color(1, 1, 1); pod.occlusion(1);
  buildPanel(pod, hull, { outer: lidLoop(hull, seam), da: quality.da, db: quality.db, cornerSegs: 6, tolerance: 4e-4, halvings: 1 });
}

/** Cut line of a wheel opening: the opening moved 14 mm into the panel, where the arch lip hides it. */
const ARCH_CUT = 14;
/**
 * Part of a wheel opening's cut line, as side-view points. The circle is walked from angle a0 to a1 (degrees: 0
 * rearward, 90 up); each end is then moved along the circle onto a line given as height(x).
 */
export function archCut(axleX, w, a0, a1, level0, level1, spacing) {
  const r = S.ARCH.radius + ARCH_CUT, cy = w.axleY, at = (deg) => [axleX + r * Math.cos(deg * Math.PI / 180), cy + r * Math.sin(deg * Math.PI / 180)];
  const onto = (deg, level) => { let lo = deg - 25, hi = deg + 25; const f = (d) => at(d)[1] - level(at(d)[0]), rising = f(hi) > f(lo); for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if ((f(mid) < 0) === rising) lo = mid; else hi = mid; } return (lo + hi) / 2; };
  const b0 = onto(a0, level0), b1 = onto(a1, level1), n = Math.max(2, Math.round(r * Math.abs(b1 - b0) * Math.PI / 180 / spacing)), pts = [];
  for (let i = 0; i <= n; i++) pts.push(at(b0 + (b1 - b0) * i / n));
  return pts;
}

/** The door's outline in side view below the glass line, from its front top corner round the bottom to its rear top corner. */
function doorOutline(hull, fine) {
  const D = S.DOOR, top0 = rowY(hull, D.frontX, GLASS_ROW), top1 = rowY(hull, D.rearTopX, GLASS_ROW);
  return roundCorners([[D.frontX, top0], [D.frontX, D.bottomY], [D.rearBottomX, D.bottomY], [D.rearTopX, top1]], [0, D.frontCorner, D.rearCorner, 0], { segs: fine ? 8 : 2 });
}

/**
 * The door glass's two leaning edges on the hull, as chart rows at station x. lead: its leading edge, parallel to the
 * screen pillar line and PILLAR.width behind it; rear: its trailing edge against the hoop, straight in side view
 * from the door's rear top corner to the roof panel's rear corner. `out` (mm, square to the edge in side view)
 * moves an edge away from the glass, under the frame. Ahead of the leading edge's foot there is no glass: lead() is
 * then the base row; behind its top it is the roof edge row E, as rear() is behind the hoop; ahead of the trailing
 * edge's foot rear() is FREE_ROW, below any pane.
 * leadX: the stations where the leading edge meets the glass base row and the roof panel's side row.
 */
export const FREE_ROW = B.H;
/** Chart row between E and G at height y of station x, or `below` / `above` when y lies under G or over E. */
function clampRow(hull, x, y, below, above) {
  return y >= rowY(hull, x, B.E) ? above : y <= rowY(hull, x, B.G) ? below : hull.solve(x, 1, y, B.E, B.G);
}
export function sideGlassEdges(hull) {
  const E = B.E, G = B.G, sin = Math.sin(Math.atan(S.SCREEN.slope)), top = S.ROOF.sideRow;
  const leadY = (x, out) => S.pillarY(x - (S.PILLAR.width - out) / sin);
  const cross = (row, x0, x1) => { let lo = x0, hi = x1; for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (leadY(mid, 0) < rowY(hull, mid, row)) lo = mid; else hi = mid; } return (lo + hi) / 2; };
  const leadX = [cross(GLASS_ROW, S.PILLAR_FOOT_X, S.HEADER_X), cross(top, S.HEADER_X, S.HOOP_X)];
  const x0 = S.DOOR.rearTopX, x1 = S.HOOP_X, y0 = rowY(hull, x0, GLASS_ROW), y1 = rowY(hull, x1, top), slope = (y1 - y0) / (x1 - x0), run = Math.sin(Math.atan(slope));
  return {
    leadX,
    lead: (x, out = 0) => clampRow(hull, x, leadY(x, out), G, E),
    rear: (x, out = 0) => clampRow(hull, x, y0 + slope * (x - out / run - x0), FREE_ROW, E),
  };
}

/** The hatch glass in plan: [x, z] along its trailing edge from the centre line to the rear corner (bowed), and its side row. */
export function hatchEdge(hull) {
  const H = S.HATCH, sideB = (x) => hull.solve(x, 0, S.hatchSideZ(x), TOP[0], B.G);
  const cornerX = S.HATCH_END_X - H.bow, cornerZ = hull.sec(cornerX, sideB(cornerX))[0];
  const rear = [0, 0.25, 0.5, 0.75, 1].map((t) => [S.HATCH_END_X - H.bow * t * t, cornerZ * t]);
  return { rear, sideB, cornerX };
}

/**
 * Add the left half of the body panels to the builder.
 * quality: { da: lattice spacing along the car in mm, db: filler row spacing in chart units, hems: build shut lines,
 * arch: spacing of points round the wheel openings in mm }.
 * deck: plan points [x, z, turning] of the shut line between the deck and the tail's skin, from the body side to the
 * centre line. screen: the windscreen's boundary lines on the hull (screen.js).
 * Returns { apertures: the edge runs round the side glass and the hatch glass, for greenhouse.js }.
 */
export function buildCoachwork(mb, hull, quality, deck, screen) {
  const { da, db } = quality, fine = quality.hems !== false;
  // Without shut lines the panels simply butt: an open gap with nothing behind it would show daylight.
  const edge = (kind) => (fine ? kind : { ...kind, hem: null, inset: 0 });
  const SEAM = edge(seam), FREE = edge(free), TUCK = edge(tucked), ROW = edge(onRow), FOLD = { hem: HEM_FOLD, inset: HEM_FOLD.reach }, REV = edge(reveal), GLAZED = edge(glazed);
  mb.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); mb.color(1, 1, 1); mb.occlusion(1);
  const edges = fine ? { cornerSegs: 6, tolerance: 4e-4, halvings: 1 } : { cornerSegs: 2, tolerance: 0.0015, halvings: 1 };
  const panel = (outer, holes = []) => buildPanel(mb, hull, { outer, holes, da, db, ...edges });
  const side = (x, y) => onSide(hull, x, y), top = (x, z) => onTop(hull, x, z);
  const sidePts = (pts, kind, extra = {}) => pts.map((q, i) => ({ p: side(q[0], q[1]), ...inSide, ...kind, ...(i === 0 ? extra : {}) }));
  const level = (row) => (x) => rowY(hull, x, row), sillLine = () => S.DOOR.bottomY, F = S.WHEEL.front, R = S.WHEEL.rear, D = S.DOOR;
  const fx = S.FRONT_AXLE_X, rx = S.REAR_AXLE_X, sp = quality.arch;
  const ends = (pts, row0, row1) => { const out = pts.map((q) => side(q[0], q[1])); if (row0 !== null) out[0] = [pts[0][0], row0]; if (row1 !== null) out[out.length - 1] = [pts[pts.length - 1][0], row1]; return out; };
  const run = (chart, kind, extra = {}) => chart.map((p, i) => ({ p, ...inSide, ...kind, ...(i === 0 ? extra : {}) }));
  /** A slot through a side panel, from its side-view outline. */
  const cutOut = (loop, r) => loop.map(([x, y]) => ({ p: side(x, y), ...inSide, ...slot, r }));

  // wheel opening cut lines
  const frontTop = ends(archCut(fx, F, 140, 40, level(BELT_UP), level(BELT_UP), sp), BELT_UP, BELT_UP);
  const frontMid = ends(archCut(fx, F, 40, 11, level(BELT_DOWN), sillLine, sp), BELT_DOWN, null);
  const frontLow = ends(archCut(fx, F, 11, -22, sillLine, level(SILL_ROW), sp), null, SILL_ROW);
  const rearLow = ends(archCut(rx, R, 202, 169, level(SILL_ROW), sillLine, sp), SILL_ROW, null);
  const rearTop = ends(archCut(rx, R, 169, 45, sillLine, level(BELT_UP), sp), null, BELT_UP);

  // --- clamshell bonnet: everything above the belt ahead of the cowl, wing tops and all
  const clam = S.CLAM_CUT.map(([x, z]) => top(x, z));
  panel([
    { p: [S.NOSE_X, 0], ...FOLD },
    { p: [S.NOSE_X, BELT_UP], ...ROW, sharp: true },
    ...run(frontTop, TUCK, { sharp: true }),
    { p: frontTop[frontTop.length - 1], ...ROW, sharp: true },
    { p: [S.CLAM_X, BELT_UP], ...SEAM, sharp: true },
    { p: clam[3], ...inPlan, ...SEAM, r: 0.07 },
    { p: clam[2], ...inPlan, ...SEAM, r: 0.25 },
    { p: clam[1], ...inPlan, ...SEAM, r: 0.25 },
    { p: clam[0], ...bare, sharp: true },
  ], fine ? [lidLoop(hull, SEAM)] : []);                                           // the pod's lid is a part of its own; the reduced model leaves the bonnet whole

  // --- cowl: from the bonnet's trailing edge to the screen base and the door, down the flank to the belt
  // its trailing edge runs under the screen's lower edge: by SCREEN.tuck at the centre line, by nothing at the pillar foot
  const base = [0.92, 0.8, 0.66, 0.5, 0.34, 0.17, 0].map((s) => { const [x, b] = screen.base(s); return [x + S.SCREEN.tuck * (1 - s * s), b]; });
  panel([
    { p: clam[0], ...inPlan, ...SEAM, sharp: true },
    { p: clam[1], ...inPlan, ...SEAM, r: 0.25 },
    { p: clam[2], ...inPlan, ...SEAM, r: 0.25 },
    { p: clam[3], ...SEAM, r: 0.07 },
    { p: [S.CLAM_X, BELT_UP], ...ROW, sharp: true },
    { p: [D.frontX, BELT_UP], ...SEAM, sharp: true },
    { p: [D.frontX, GLASS_ROW], ...ROW, sharp: true },
    { p: [S.PILLAR_FOOT_X, GLASS_ROW], ...TUCK, sharp: true },
    { p: [S.PILLAR_FOOT_X, B.E], ...TUCK, sharp: true },
    ...base.map((p, i) => ({ p, ...(i === base.length - 1 ? bare : TUCK), sharp: i === base.length - 1 })),
  ]);

  // --- lower front wing: behind the wheel, from the belt down to the rocker
  panel([
    ...run(frontMid, TUCK, { sharp: true }),
    { p: frontMid[frontMid.length - 1], ...inSide, ...SEAM, sharp: true },
    { p: side(D.frontX, D.bottomY), ...SEAM, sharp: true },
    { p: [D.frontX, BELT_DOWN], ...ROW, sharp: true },
  ], fine ? gillOutlines().map((loop) => cutOut(loop, S.GILL.corner)) : []);

  // --- door
  const door = doorOutline(hull, fine), doorChart = door.map((q) => side(q[0], q[1]));
  doorChart[0] = [D.frontX, GLASS_ROW]; doorChart[doorChart.length - 1] = [D.rearTopX, GLASS_ROW];
  panel([...run(doorChart.slice(0, -1), SEAM, { sharp: true }), { p: doorChart[doorChart.length - 1], ...ROW, sharp: true }], fine ? [cutOut(handleOutline(), S.HANDLE.corner)] : []);

  // --- rocker: from wheel to wheel under the door line; it also fills the corners the door's round corners leave
  const bottom = door.filter((q) => q[1] < door[0][1] - 1 && q[1] <= D.bottomY + Math.max(D.frontCorner, D.rearCorner) + 1 && q[0] > D.frontX - 1), k0 = bottom.findIndex((q) => q[1] <= D.bottomY + 1e-6);
  const frontArc = bottom.slice(0, k0 + 1), rearArc = bottom.slice(bottom.length - 1 - bottom.slice().reverse().findIndex((q) => q[1] <= D.bottomY + 1e-6));
  const rearFoot = [D.rearBottomX, D.bottomY];
  panel([
    ...run(frontLow, TUCK, { sharp: true }),
    { p: frontLow[frontLow.length - 1], ...FREE, sharp: true },
    ...run(rearLow, TUCK, { sharp: true }),
    { p: rearLow[rearLow.length - 1], ...inSide, ...SEAM, sharp: true },
    { p: side(...rearFoot), ...inSide, ...SEAM, sharp: true },
    ...sidePts(rearArc.slice().reverse(), SEAM, { sharp: true }),
    ...sidePts(frontArc.slice().reverse(), SEAM),
    { p: side(D.frontX, D.bottomY), ...inSide, ...SEAM, sharp: true },
  ]);

  // --- rear body: quarter panel, hoop, wing tops and deck in one piece, with the hatch glass let into it
  const hatch = hatchEdge(hull), hx = S.HATCH_X, hRear = hatch.rear.map(([x, z]) => top(x, z));
  const upright = door.slice(door.length - 1 - rearArc.length + 1);                 // the door's rear edge above its round corner
  const rear = panel([
    { p: [S.HOOP_X, 0], ...SEAM, sharp: true },
    { p: [S.HOOP_X, S.ROOF.sideRow], ...inGlass, ...REV, sharp: true },
    { p: [D.rearTopX, GLASS_ROW], ...inSide, ...SEAM, sharp: true },
    ...sidePts(upright.slice(1, -1).reverse(), SEAM),
    { p: side(...rearFoot), ...inSide, ...SEAM, sharp: true },
    ...run(rearTop, TUCK, { sharp: true }),
    { p: rearTop[rearTop.length - 1], ...ROW, sharp: true },
    { p: [S.TAIL.seamX, BELT_UP], ...SEAM, sharp: true },
    ...deck.slice(0, -1).map(([x, z, turning], i) => ({ p: top(x, z), ...inPlan, ...SEAM, sharp: i === 0, r: turning ? 0.03 : 0 })),
    { p: [deck[deck.length - 1][0], 0], ...bare, sharp: true },
    { p: hRear[0], ...inPlan, ...REV, sharp: true },
    ...hRear.slice(1, -1).map((p) => ({ p, ...inPlan, ...REV })),
    { p: [hatch.cornerX, hatch.sideB(hatch.cornerX)], ...REV, r: S.HATCH.rearCorner },
    ...[3900, 3700, 3500, 3350].map((x) => ({ p: [x, hatch.sideB(x)], ...REV })),
    { p: [hx, hatch.sideB(hx)], ...REV, r: S.HATCH.frontCorner },
    { p: [hx, 0], ...bare, sharp: true },
  ]);

  // --- roof panel: lifts off between the screen header and the hoop
  const lead = [0, 0.25, 0.5, 0.75, 0.9].map((t) => top(S.HEADER_X + (S.HEADER_CORNER_X - S.HEADER_X) * t * t + S.ROOF.frame, screen.cornerZ * t));
  const roofCorner = [S.HEADER_CORNER_X + S.ROOF.frame, S.ROOF.sideRow];
  const roof = panel([
    { p: lead[0], ...inPlan, ...SEAM, sharp: true },
    ...lead.slice(1).map((p) => ({ p, ...inPlan, ...SEAM })),
    { p: roofCorner, ...REV, sharp: true },
    { p: [S.HOOP_X, S.ROOF.sideRow], ...SEAM, sharp: true },
    { p: [S.HOOP_X, 0], ...bare, sharp: true },
  ]);

  // --- screen frame: the header bar ahead of the roof panel and the outer face of the pillar, in one piece.
  // Its edge to the windscreen is the screen sheet's own boundary; its edge to the door glass leans with the pillar.
  const glassEdge = sideGlassEdges(hull), steps = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
  const frame = panel([
    { p: [S.HEADER_X, 0], ...GLAZED, sharp: true },
    ...steps.map((t) => ({ p: screen.header(t), ...GLAZED })),
    { p: [S.HEADER_CORNER_X, B.E], ...GLAZED, sharp: true },
    ...steps.slice().reverse().map((t) => ({ p: screen.pillar(t), ...GLAZED })),
    { p: [S.PILLAR_FOOT_X, B.E], ...bare, sharp: true },
    { p: [S.PILLAR_FOOT_X, GLASS_ROW], ...ROW, sharp: true },
    { p: [glassEdge.leadX[0], GLASS_ROW], ...inGlass, ...REV, r: 0.022 },
    { p: [glassEdge.leadX[1], S.ROOF.sideRow], ...REV, r: 0.03 },
    { p: roofCorner, ...inPlan, ...SEAM, sharp: true },
    ...lead.slice(1).reverse().map((p) => ({ p, ...inPlan, ...SEAM })),
    { p: lead[0], ...bare, sharp: true },
  ]);
  return { glazed: [...rear, ...roof, ...frame] };
}

/**
 * The floor: the underside of the hull between the wheel wells and on to the tail, notched for the wells.
 * wells: { front: [x0, x1], rear: [x0, x1] } footprints of the arch liners (see arches.js); end: where the tail's tray takes over.
 */
export function buildFloor(mb, hull, wells, quality) {
  const inFloor = { via: 0, range: FLOOR }, edge = FLOOR[0], f = wells.front, r = wells.rear, z = S.ARCH.linerZ;
  mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.5);
  buildPanel(mb, hull, {
    outer: [
      { p: onFloor(hull, f[0], z), ...inFloor }, { p: onFloor(hull, f[1], z) }, { p: [f[1], edge] },
      { p: [r[0], edge] }, { p: onFloor(hull, r[0], z), ...inFloor }, { p: onFloor(hull, r[1], z) }, { p: [r[1], edge] },
      { p: [wells.end, edge] }, { p: [wells.end, FLOOR[1]] }, { p: [f[0], FLOOR[1]] },
    ],
    da: quality.da * 3, db: 0.5,
  });
}
