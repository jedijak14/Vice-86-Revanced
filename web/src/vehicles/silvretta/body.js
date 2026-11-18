// The coachwork: every painted panel, cut from the hull.
// Panels are authored on shared seam lines and each is inset by half a shut line, so the gaps between them are real.
// Plan shapes (bonnet, engine lid, windscreen, rear window) are given in drawing x, z; side-view shapes (door, side
// windows, wheel openings, sill) in x, y; both are found on the hull by solving across its section.
//
// The fixed shell is cut in two along the gutter row, a joint without a gap that the drip rail covers on the roof:
// the upper piece carries the cowl, the windscreen and rear window openings, the roof and the deck round the engine
// lid; the lower piece the screen pillar's outer half, the door post, the quarter light, the rear wing and its wheel
// opening. Every vertex of a panel's edge puts a mesh row through that panel, so shorter panels are cheaper ones.

import { FAMILY, VEHICLE, GLASS } from '../../core/ids.js';
import { makeSheet } from '../hero/kit/sheet.js';
import { patch, polygon } from '../hero/kit/solids.js';
import { buildPanel, prepareLoop, hem, HEM_GAP, HEM_LIP, HEM_TUCK } from '../hero/kit/panel.js';
import { arc } from '../hero/kit/outline.js';
import * as S from './spec.js';
import { onTop, onSide, onCabin, onFloor, inPlan, inSide, inCabin, inFloor, drawn } from './shell.js';
import { headlampOpening } from './lamps.js';

const MM = S.MM, HALF_GAP = S.GAP / 2 * MM;
/** The nose and tail edges: the skin folds down behind the bumper and the lamp band. */
const HEM_FOLD = hem({ radius: 0.006, turn: 78, depth: 0.016, segs: 5, dark: 0.3 });
/** The edge of a window opening: a small roll into the rebate that the glass and its seal sit in. */
const HEM_REBATE = hem({ radius: 0.003, depth: 0.0085, segs: 3, dark: 0.2 });

// Edge kinds: what happens along the edge that leaves a vertex. Outlines are authored where the panel's edge wall
// stands; the skin stops short of that by the reach of the rolled edge (and by half a shut line on a seam).
const seam = { hem: HEM_GAP, inset: HALF_GAP + HEM_GAP.reach };
const free = { hem: HEM_LIP, inset: HEM_LIP.reach };
const tucked = { hem: HEM_TUCK, inset: HEM_TUCK.reach };
const rebate = { hem: HEM_REBATE, inset: HEM_REBATE.reach };
const fold = { hem: HEM_FOLD, inset: HEM_FOLD.reach };
const bare = { hem: null, inset: 0 };

/** How far under the flare a panel is cut round a wheel opening, mm. */
const ARCH_TUCK = 14;

/** Height of the hull's lower edge, mm. */
export const sillY = (hull, x) => hull.sec(x, S.SILL_ROW)[1];

/**
 * Cut lines of the wheel openings in side view [[x, y]...], 14 mm outside the openings. Front: `foot` from the
 * hull's lower edge ahead of the wheel over the top to the sill's top behind it, `lower` on down to the hull's lower
 * edge. Rear: `lower` from the hull's lower edge ahead of the wheel up to the sill's top, `upper` from there over the
 * top and down to the hull's lower edge behind the wheel.
 */
export function archCuts(hull, fine = true) {
  const foot = (cx, cy, r, sign) => {       // angle below the axle at which the circle meets the hull's lower edge
    let a = 0.3; for (let i = 0; i < 6; i++) a = Math.asin(Math.min(0.95, (cy - sillY(hull, cx + sign * r * Math.cos(a))) / r));
    return a;
  };
  const F = S.FRONT_ARCH, fx = S.FRONT_AXLE_X, fy = S.WHEEL.front.axleY, fr = F.radius + ARCH_TUCK;
  const R = S.REAR_ARCH, rx = S.REAR_AXLE_X, ry = S.WHEEL.rear.axleY, rr = R.radius + ARCH_TUCK;
  const n = (span, r) => Math.max(3, Math.round(Math.abs(span) * r / (fine ? 30 : 110)));
  const f0 = Math.PI + foot(fx, fy, fr, -1), f1 = Math.asin((S.SILL_TOP_Y - fy) / fr), f2 = -foot(fx, fy, fr, 1);
  const r0 = Math.PI + foot(rx, ry, rr, -1), r1 = Math.PI - Math.asin((S.SILL_TOP_Y - ry) / rr), r2 = -foot(rx, ry, rr, 1);
  return {
    front: { foot: arc(fx, fy, fr, f0, f1, n(f0 - f1, fr)), lower: arc(fx, fy, fr, f1, f2, n(f1 - f2, fr)) },
    rear: { lower: arc(rx, ry, rr, r0, r1, n(r0 - r1, rr)), upper: arc(rx, ry, rr, r1, r2, n(r1 - r2, rr)) },
  };
}

/** The windscreen opening in plan, from the header on the centre line round the outside to the foot on the centre line: [[x, z], corner radius]. */
export function windscreenOutline() {
  const W = S.WINDSCREEN, pts = [[[W.head(0), 0], 0], [[W.head(W.headZ * 0.5), W.headZ * 0.5], 0], [[W.head(W.headZ), W.headZ], W.corner]];
  for (const t of [1, 0.86, 0.68, 0.46, 0.23]) pts.push([[W.base(W.footZ * t), W.footZ * t], t === 1 ? W.corner : 0]);
  pts.push([[W.base(0), 0], 0]);
  return pts;
}

/** Edge kinds with nothing built on them: panels cut with these butt without a gap (the cabin's lining, the glass). */
const BUTT = { SEAM: bare, FREE: bare, TUCK: bare, REBATE: bare, FOLD: bare };

/**
 * The outlines of the body panels as buildPanel takes them: { bonnet, wing, door, sill, upper, lower, lid }, each
 * { outer, holes }. K: the edge kinds { SEAM, FREE, TUCK, REBATE, FOLD };
 * fine: dense wheel opening cuts.
 */
export function panelOutlines(hull, K, fine = true) {
  const { SEAM, FREE, TUCK, REBATE, FOLD } = K;
  const top = (x, z) => onTop(hull, x, z), side = (x, y) => onSide(hull, x, y), cabin = (x, y) => onCabin(hull, x, y);
  const sideLine = (pts, kind, first = {}) => pts.map((q, i) => ({ p: side(q[0], q[1]), ...inSide, ...kind, ...(i === 0 ? first : {}) }));
  const planLine = (pts, kind, first = {}) => pts.map((q, i) => ({ p: top(q[0], q[1]), ...inPlan, ...kind, ...(i === 0 ? first : {}) }));
  const B = S.BONNET, D = S.DOOR, G = S.GUTTER_ROW, BELT = S.BELT_ROW, SILL = S.SILL_ROW, cuts = archCuts(hull, fine);
  const shut = B.shut, cowlCorner = shut[2], wingEnd = shut[3], FOOT_X = S.FRONT_BUMPER.bellowsX;
  const W = S.REAR_WINDOW, L = S.ENGINE_LID, screen = windscreenOutline(), DG = S.DOOR_GLASS, Q = S.QUARTER_LIGHT, T = S.TAIL.band;
  const doorRear = () => [
    { p: [D.x1, BELT], ...inSide, ...SEAM, sharp: true },
    ...sideLine(D.rear.slice(0, -1), SEAM).map((v) => ({ ...v, r: 0.25 })),
    { p: side(...D.rear[D.rear.length - 1]), ...inSide, ...SEAM, r: D.corner },
  ];
  return {
    bonnet: { outer: [
      { p: [B.x0, 0], ...FOLD }, { p: top(...shut[0]), ...inPlan, ...SEAM, r: 0.03 }, { p: top(...shut[1]), ...inPlan, ...SEAM, r: 1.2 },
      { p: top(...cowlCorner), ...SEAM, r: B.corner }, { p: [B.x1, 0], ...bare, sharp: true },
    ] },
    // from the bonnet's shut line over the crest and down the flank, from the nose to the door
    wing: { outer: [
      { p: top(...shut[0]), ...FOLD, sharp: true },
      { p: side(S.NOSE_X, S.NOSE_CUT_Y), ...inSide, ...TUCK, sharp: true },
      { p: side(FOOT_X, S.NOSE_CUT_Y), ...SEAM, sharp: true },
      { p: [FOOT_X, SILL], ...FREE, sharp: true },
      { p: [cuts.front.foot[0][0], SILL], ...inSide, ...TUCK, sharp: true },
      ...sideLine(cuts.front.foot.slice(1), TUCK),
      { p: side(cuts.front.foot[cuts.front.foot.length - 1][0], S.SILL_TOP_Y), ...inSide, ...SEAM, sharp: true },
      { p: side(D.x0, S.SILL_TOP_Y), ...SEAM, sharp: true },
      { p: top(...wingEnd), ...inPlan, ...SEAM, sharp: true },
      { p: top(...cowlCorner), ...inPlan, ...SEAM, r: 1.2 }, { p: top(...shut[1]), ...inPlan, ...SEAM, r: 1.2 },
    ], holes: fine ? [headlampOpening(hull).map((p) => ({ p, ...SEAM }))] : [] },
    door: { outer: [{ p: [D.x0, BELT], ...SEAM, sharp: true }, { p: [DG.foot, BELT], ...REBATE, sharp: true }, ...doorRear(), { p: side(D.x0, S.SILL_TOP_Y), ...SEAM, r: D.corner }] },
    // from wheel opening to wheel opening
    sill: { outer: [
      ...sideLine(cuts.front.lower.slice().reverse(), TUCK, { sharp: true }),
      { p: side(cuts.front.lower[0][0], S.SILL_TOP_Y), ...inSide, ...SEAM, sharp: true },
      ...sideLine(cuts.rear.lower.slice().reverse(), TUCK, { sharp: true }),
      { p: [cuts.rear.lower[0][0], SILL], ...TUCK, sharp: true },
      { p: [cuts.front.lower[cuts.front.lower.length - 1][0], SILL], ...TUCK, sharp: true },
    ] },
    // cowl, roof and rear deck, with the windscreen, the rear window and the engine lid let into it
    upper: { outer: [
      { p: [B.x1, 0], ...SEAM, sharp: true },
      { p: top(...cowlCorner), ...inPlan, ...SEAM, r: B.corner },
      { p: top(...wingEnd), ...SEAM, sharp: true },
      { p: [D.x0, G], ...bare, sharp: true },
      { p: [S.TAIL_X, G], ...FOLD, sharp: true },
      { p: [S.TAIL_X, 0], ...bare, sharp: true },
      { p: [L.x1, 0], ...SEAM, sharp: true },
      ...planLine(L.z.slice().reverse(), SEAM).map((v, i) => ({ ...v, r: i === 1 ? 1.5 : L.corner })),
      { p: [L.x0, 0], ...bare, sharp: true },
      { p: [W.x1, 0], ...REBATE, sharp: true },
      { p: top(W.x1, W.z1), ...inPlan, ...REBATE, r: W.corner },
      { p: top(W.x0, W.z0), ...REBATE, r: W.corner },
      { p: [W.x0, 0], ...bare, sharp: true },
      ...screen.map(([q, r], i) => ({ p: i === 0 || i === screen.length - 1 ? [q[0], 0] : top(q[0], q[1]), ...inPlan, ...(i === screen.length - 1 ? bare : REBATE), ...(i === 0 || i === screen.length - 1 ? { sharp: true } : { r: r || 0.6 }) })),
    ] },
    // the screen pillar's outer half, the door post, the quarter light, the rear wing
    lower: { outer: [
      { p: [D.x0, G], ...SEAM, sharp: true },
      { p: [D.x0, BELT], ...SEAM, sharp: true },
      { p: [DG.foot, BELT], ...inCabin, ...REBATE, r: 0.02 },
      ...DG.top.map((q, i) => ({ p: cabin(q[0], q[1]), ...inCabin, ...REBATE, r: i === 1 ? 2.5 : DG.corner })),
      ...doorRear(),
      ...sideLine(cuts.rear.upper, TUCK, { sharp: true }), { p: [cuts.rear.upper[cuts.rear.upper.length - 1][0], SILL], ...FREE, sharp: true },
      { p: [S.REAR_SKIRT_X, SILL], ...TUCK, sharp: true },
      { p: side(S.REAR_SKIRT_X, S.TAIL_CUT_Y), ...inSide, ...TUCK, sharp: true },
      { p: side(T.endX, S.TAIL_CUT_Y), ...TUCK, sharp: true },
      { p: side(T.endX, T.y[1]), ...inSide, ...TUCK, sharp: true },
      { p: side(S.TAIL_X, T.y[1]), ...FOLD, sharp: true },
      { p: [S.TAIL_X, G], ...bare, sharp: true },
    ], holes: [Q.outline.map((q, i) => ({ p: cabin(q[0], q[1]), ...inCabin, ...REBATE, r: Q.corner[i] || 1.2 }))] },
    lid: { outer: [
      { p: [L.x0, 0], ...SEAM, sharp: true },
      ...planLine(L.z, SEAM).map((v, i) => ({ ...v, r: i === 1 ? 1.5 : L.corner })),
      { p: [L.x1, 0], ...bare, sharp: true },
    ] },
  };
}

/** The window openings as outlines for buildPanel on the glass sheet: { screen, rear, door, quarter }. */
export function glassOutlines(hull) {
  const top = (x, z) => onTop(hull, x, z), cabin = (x, y) => onCabin(hull, x, y);
  const W = S.REAR_WINDOW, screen = windscreenOutline(), DG = S.DOOR_GLASS, Q = S.QUARTER_LIGHT, D = S.DOOR, BELT = S.BELT_ROW;
  return {
    screen: screen.map(([q, r], i) => ({ p: i === 0 || i === screen.length - 1 ? [q[0], 0] : top(q[0], q[1]), ...inPlan, ...(i === 0 || i === screen.length - 1 ? { sharp: true } : { r: r || 0.6 }) })).reverse().map((v, i, a) => ({ ...v, via: undefined, range: undefined, ...(a[(i + 1) % a.length].p[1] === 0 && v.p[1] === 0 ? {} : inPlan) })),
    rear: [{ p: [W.x0, 0], ...inPlan, sharp: true }, { p: top(W.x0, W.z0), ...inPlan, r: W.corner }, { p: top(W.x1, W.z1), ...inPlan, r: W.corner }, { p: [W.x1, 0], sharp: true }],
    door: [{ p: [DG.foot, BELT], sharp: true }, { p: [D.x1, BELT], ...inCabin, sharp: true }, ...DG.top.slice().reverse().map((q, i) => ({ p: cabin(q[0], q[1]), ...inCabin, r: i === 1 ? 2.5 : DG.corner }))],
    quarter: Q.outline.map((q, i) => ({ p: cabin(q[0], q[1]), ...inCabin, r: Q.corner[i] || 1.2 })).reverse().map((v, i, a) => ({ ...v, r: a[(i + a.length - 1) % a.length].r })),
  };
}

/**
 * Add the left half of the body panels to the builder.
 * quality: { da: lattice spacing along the car in mm, db: filler row spacing in chart units, hems: build shut lines }.
 */
export function buildCoachwork(mb, hull, quality) {
  const { da, db } = quality, withHems = quality.hems !== false;
  // Without shut lines the panels simply butt: an open gap with nothing behind it would show daylight. The folds at
  // the nose and tail stay, because they are what closes the skin onto the bumper and the lamp band.
  const edge = (kind) => (withHems ? kind : { ...kind, hem: null, inset: 0 });
  const K = { SEAM: edge(seam), FREE: edge(free), TUCK: edge(tucked), REBATE: edge(rebate), FOLD: fold };
  mb.material(VEHICLE.PAINT, 0, 0); mb.color(1, 1, 1); mb.occlusion(1);
  const edges = withHems ? { cornerSegs: 6, tolerance: 4e-4, halvings: 1 } : { cornerSegs: 2, tolerance: 0.0015, halvings: 1 };
  const first = mb.idxLen[FAMILY.VEHICLE] || 0;
  for (const o of Object.values(panelOutlines(hull, K, withHems))) buildPanel(mb, hull, { outer: o.outer, holes: o.holes || [], da, db, ...edges });
  settleSlivers(mb, FAMILY.VEHICLE, first);
}

/**
 * Along a curved edge the panel builder leaves needles between the chord and the arc of the outline: three points
 * of one edge, a fraction of a millimetre high. In the chart they are wound correctly, but on a doubly curved skin
 * such a needle can stand on its side or lie on its back. Turn those to face the way their vertices' normals do.
 * Only triangles under `height` metres high are touched, so that a panel wound the wrong way is still reported.
 */
export function settleSlivers(mb, family, first, height = 0.0015) {
  const ix = mb.idx[family], end = mb.idxLen[family], p = mb.pos, n = mb.nrm;
  for (let i = first; i < end; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    if (gx * (n[a] + n[b] + n[c]) + gy * (n[a + 1] + n[b + 1] + n[c + 1]) + gz * (n[a + 2] + n[b + 2] + n[c + 2]) >= 0) continue;
    const longest = Math.sqrt(Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, (ux - vx) ** 2 + (uy - vy) ** 2 + (uz - vz) ** 2));
    if (Math.hypot(gx, gy, gz) < height * longest) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  }
}

/** Depth of the cabin's lining and of the glass under the skin, and the thickness of the glass, metres. */
const LINING_DEPTH = 0.013, GLASS_DEPTH = 0.005, GLASS_THICKNESS = 0.004;
const LINING = [0.035, 0.033, 0.03];
/** The drum over the rear wheel well is this much larger than the wheel opening, mm; and the chart row at which the body side ends. */
const WELL_CLEAR = 30, SIDE_FOOT = S.ROWS.side[1];

/**
 * The hull moved `depth` metres under its own surface; with `inward` it faces the cabin. depth may be a function of
 * the side-view position (x, y in drawing mm).
 */
function innerSheet(hull, depth, inward) {
  const n = [0, 0, 0], depthAt = typeof depth === 'function' ? depth : () => depth;
  const sheet = makeSheet((a, b, out) => {
    hull.pos(a, b, out); hull.normal(a, b, n);
    const d = depthAt(a, out[1] / MM);
    out[0] -= n[0] * d; out[1] -= n[1] * d; out[2] -= n[2] * d;
    return out;
  }, { flip: inward ? !hull.flip : hull.flip, ha: 2, hb: 0.01, rows: hull.rows, cols: hull.cols });
  sheet.sec = hull.sec; sheet.solve = hull.solve; if (hull.arcOf) { sheet.arcOf = hull.arcOf; sheet.bOf = hull.bOf; } if (hull.hs) sheet.hs = hull.hs;
  return sheet;
}

/**
 * The cabin's lining: an inner face behind the door, the sill, the roof and the rear wing, so that nothing is seen
 * from behind through the windows, and the bulkheads that close the cabin at the scuttle and behind the rear seats.
 */
export function buildLining(mb, hull, quality) {
  // Round the rear wheel the lining lies deeper: the arch's flare ends in a wall that runs 25 mm into the body.
  const R = S.REAR_ARCH, cx = S.REAR_AXLE_X, cy = S.WHEEL.rear.axleY, reach = R.radius + R.flare + 40;
  const ease = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
  const sheet = innerSheet(hull, (x, y) => LINING_DEPTH + 0.018 * ease((reach + 90 - Math.hypot(x - cx, y - cy)) / 90), true), o = panelOutlines(hull, BUTT, false);
  mb.material(VEHICLE.INTERIOR, 2, 0); mb.color(LINING); mb.occlusion(0.7);
  const C = S.CABIN, p = [0, 0, 0];
  for (const name of ['door', 'sill', 'upper', 'lower']) buildPanel(mb, sheet, { outer: o[name].outer, holes: o[name].holes || [], da: Math.max(60, quality.da * 3), db: Math.max(0.5, quality.db * 2), cornerSegs: 2, tolerance: 0.002, halvings: 1 });

  // The rear wheel well stands in the cabin: a drum over the arch's liner, from just under the skin to an end wall
  // inboard of the liner's. Its feet stand between the cabin's floor and the car's.
  const rc = R.radius + WELL_CLEAR, z0 = R.linerZ - 14;
  const foot = Math.asin((cy - (sillY(hull, cx) + 5)) / rc), n = Math.max(8, Math.round(rc * (Math.PI + 2 * foot) / Math.max(40, quality.da * 2)));
  const drum = [], wall = [];
  for (let i = 0; i <= n; i++) {
    const th = Math.PI + foot - (Math.PI + 2 * foot) * i / n, x = cx + rc * Math.cos(th), y = cy + rc * Math.sin(th);
    const low = hull.sec(x, SIDE_FOOT)[1] + 2, q = drawn(hull, onSide(hull, x, Math.max(y, low)));
    drum.push([S.toCar(x, y, q[2] - 6 - Math.max(0, low - y) * 1.5), S.toCar(x, y, z0)]); wall.push(S.toCar(x, y, z0));
  }
  patch(mb, drum, { facing: [0, 1, 0], crease: 60 }); polygon(mb, wall);

  for (const [x, facesBack] of [[C.x0, true], [C.x1, false]]) {
    const loop = []; for (let b = 0; b <= S.RAIL.B + 0.001; b += 0.25) { sheet.pos(x, Math.min(S.RAIL.B, b), p); loop.push([p[0], p[1], p[2]]); }
    polygon(mb, facesBack ? loop : loop.reverse());
  }
  // floor of the cabin, notched where the drum stands on it
  const w0 = cx - rc * Math.cos(foot) + 6, w1 = cx + rc * Math.cos(foot) - 6;
  buildPanel(mb, sheet, { outer: [
    { p: [C.x0, S.SILL_ROW] }, { p: [w0, S.SILL_ROW] }, { p: onFloor(hull, w0, z0 + 6), ...inFloor }, { p: onFloor(hull, w1, z0 + 6) }, { p: [w1, S.SILL_ROW] },
    { p: [C.x1, S.SILL_ROW] }, { p: [C.x1, S.RAIL.B] }, { p: [C.x0, S.RAIL.B] },
  ], da: 200, db: 0.5 });
}

/** The glass: panes that follow the hull, set under the skin in the window openings. glass: GLASS builder. */
export function buildGlass(glass, hull, quality) {
  // the reduced model's panes lie flush with the skin they butt against: nothing is seen past their edges
  const full = quality.cabin !== false, o = glassOutlines(hull), outer = innerSheet(hull, full ? GLASS_DEPTH : 0, false), inner = innerSheet(hull, GLASS_DEPTH + GLASS_THICKNESS, true);
  const spec = { da: Math.max(50, quality.da * 2.5), db: Math.max(0.4, quality.db * 2), cornerSegs: quality.hems === false ? 2 : 5 };
  const pane = (outline, tint, opacity) => {
    glass.material(GLASS.TINTED, opacity, 0, 0); glass.color(tint); glass.occlusion(1);
    buildPanel(glass, outer, { outer: outline, ...spec }); if (quality.cabin !== false) buildPanel(glass, inner, { outer: outline, ...spec });
  };
  const family = quality.cabin !== false ? FAMILY.GLASS : FAMILY.VEHICLE, first = glass.idxLen[family] || 0;
  pane(o.screen, TINT.screen, 60); pane(o.rear, TINT.side, 70); pane(o.door, TINT.side, 70); pane(o.quarter, TINT.side, 70);
  settleSlivers(glass, family, first);
}
/** Rubber of the window seals: [r, g, b] and roughness. */
const SEAL = { colour: [0.2, 0.2, 0.21], rough: 175 };
/**
 * Section of a window seal, mm: s runs from the opening's edge onto the glass, d is the depth under the skin. The
 * seal fills the rebate from just under the paint to behind the lining, so it laps the edge of the glass outside and
 * the edge of the lining inside, and nothing is seen between the skin, the glass and the lining.
 */
const SEAL_SECTION = { s: 4.5, d: 9, rs: 6.5, rd: 6.5 };

/**
 * A bead of oval section laid along a prepared loop of the hull's chart. A loop that touches the centre line is
 * swept only between its two points there and left open at them, to meet its mirror image.
 */
function bead(mb, hull, loop, section, segs) {
  const m = loop.length, onAxis = loop.map((q) => q.p[1] < 1e-7), closed = !onAxis.some(Boolean);
  let run = loop;
  if (!closed) {
    let i0 = 0; while (!(onAxis[i0] && !onAxis[(i0 + 1) % m])) i0++;
    run = [loop[i0]]; for (let k = 1; k < m; k++) { run.push(loop[(i0 + k) % m]); if (onAxis[(i0 + k) % m]) break; }
  }
  const n = run.length, P = run.map((q) => hull.pos(q.p[0], q.p[1], [0, 0, 0])), N = run.map((q) => hull.normal(q.p[0], q.p[1], [0, 0, 0]));
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const at = (i) => (closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i)));
  const grid = []; let turned = false;
  for (let i = 0; i < n; i++) {
    const end = !closed && (i === 0 || i === n - 1);
    // at the centre line the bead leaves square to the plane of symmetry
    const t = end ? [P[at(i + 1)][0] - P[at(i - 1)][0] > 0 ? 1 : -1, 0, 0] : unit(sub(P[at(i + 1)], P[at(i - 1)]));
    const nrm = end ? unit([0, N[i][1], N[i][2]]) : N[i];
    // which way is the glass: to the left of the loop in the chart (a in mm, b in rails of some 100 mm)
    const da = run[at(i + 1)].p[0] - run[at(i - 1)].p[0], db = (run[at(i + 1)].p[1] - run[at(i - 1)].p[1]) * 100, l = Math.hypot(da, db) || 1;
    const q = sub(hull.pos(run[i].p[0] - db / l, Math.max(0, run[i].p[1] + da / l / 100), [0, 0, 0]), P[i]);
    let s = unit(cross(nrm, t)); if (dot(s, q) < 0) { s = [-s[0], -s[1], -s[2]]; if (i === 1) turned = true; }
    const ring = [];
    for (let j = 0; j < segs; j++) {
      const th = 2 * Math.PI * j / segs, u = (section.s + section.rs * Math.cos(th)) * MM, w = (section.d + section.rd * Math.sin(th)) * MM;
      ring.push([P[i][0] + s[0] * u - nrm[0] * w, P[i][1] + s[1] * u - nrm[1] * w, P[i][2] + s[2] * u - nrm[2] * w]);
    }
    grid.push(ring);
  }
  patch(mb, grid, { flip: turned, closeJ: true, closeI: closed, crease: 50 });
}

/** The rubber seals round the windscreen, the rear window, the door glass and the quarter light. */
export function buildSeals(mb, hull, quality) {
  const o = glassOutlines(hull), edges = { cornerSegs: 4, tolerance: 6e-4, halvings: 1 };
  mb.material(VEHICLE.TRIM_BLACK, SEAL.rough, 0); mb.color(SEAL.colour); mb.occlusion(0.85);
  for (const outline of [o.screen, o.rear, o.door, o.quarter]) bead(mb, hull, prepareLoop(hull, outline, edges), SEAL_SECTION, quality.hems === false ? 4 : 7);
}

export const TINT = { screen: [0.62, 0.74, 0.70], side: [0.50, 0.60, 0.58] };

/**
 * The floor: the underside of the hull, notched for the wheel wells.
 * wells: { front: [x0, x1], rear: [x0, x1] } footprints of the arch liners (see arches.js).
 */
export function buildFloor(mb, hull, wells, quality) {
  const f = wells.front, r = wells.rear, fz = S.FRONT_ARCH.linerZ, rz = S.REAR_ARCH.linerZ, x0 = S.FRONT_BUMPER.bellowsX, x1 = S.TAIL_X, B = S.RAILS.length - 1;
  mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.5);
  buildPanel(mb, hull, {
    outer: [
      { p: [x0, S.SILL_ROW] }, { p: [f[0], S.SILL_ROW] }, { p: onFloor(hull, f[0], fz), ...inFloor }, { p: onFloor(hull, f[1], fz) }, { p: [f[1], S.SILL_ROW] },
      { p: [r[0], S.SILL_ROW] }, { p: onFloor(hull, r[0], rz), ...inFloor }, { p: onFloor(hull, r[1], rz) }, { p: [r[1], S.SILL_ROW] },
      { p: [x1, S.SILL_ROW] }, { p: [x1, B] }, { p: [x0, B] },
    ],
    da: Math.min(quality.da * 3, 150), db: 0.5,
  });
  // an upstand across each end of the floor, behind the valance: no way in between the floor and the tray over it
  for (const [x, dir] of [[x0, 1], [x1, -1]]) {
    const rows = []; for (let i = 0; i <= 10; i++) { const q = drawn(hull, [x, S.SILL_ROW + (B - S.SILL_ROW) * i / 10]); rows.push([S.toCar(q[0], q[1], q[2]), S.toCar(q[0], q[1] + 45, q[2])]); }
    patch(mb, rows, { facing: [0, 0, dir] });
  }
  // A curb round each notch, from the floor up past the foot of the arch's liner (which ends at the height of the
  // body's lower edge): seen from the ground, nothing shows between the tyre, the liner and the floor.
  for (const [w, lz] of [[f, fz], [r, rz]]) {
    const b0 = onFloor(hull, w[0], lz)[1], b1 = onFloor(hull, w[1], lz)[1], path = [], steps = 5, n = Math.max(2, Math.round((w[1] - w[0]) / 80));
    for (let i = 0; i < steps; i++) path.push([w[0], S.SILL_ROW + (b0 - S.SILL_ROW) * i / steps]);
    for (let i = 0; i <= n; i++) { const x = w[0] + (w[1] - w[0]) * i / n; path.push(i === 0 ? [x, b0] : i === n ? [x, b1] : onFloor(hull, x, lz)); }
    for (let i = 1; i <= steps; i++) path.push([w[1], b1 + (S.SILL_ROW - b1) * i / steps]);
    // seen from the wheel, and (a second skin 5 mm behind) from under the car
    for (const back of [0, 5]) {
      const wall = path.map((c) => {
        const q = drawn(hull, c), x = q[0] + (c[0] <= w[0] ? -back : c[0] >= w[1] ? back : 0), z = q[2] - (c[1] >= Math.min(b0, b1) - 1e-6 ? back : 0);
        return [S.toCar(x, q[1], z), S.toCar(x, Math.max(q[1] + 10, sillY(hull, q[0]) + CURB), z)];
      });
      patch(mb, wall, { facing: [back ? -1 : 1, 0, 0], crease: 40 });
    }
  }
}
/** Height of the curb round a wheel well's notch over the body's lower edge, mm. */
const CURB = 14;
