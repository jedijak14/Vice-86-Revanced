// The coachwork: every painted panel of the lower body, cut from the hull.
// Panels are authored on shared seam lines and each is inset by half a shut line, so the gaps between them are real.
// Side-view shapes (door, arches, sill) are given in drawing x, y and found on the hull by solving for the height;
// plan shapes (bonnet lines, lamp bays, louvres) are given in x, z.

import { VEHICLE } from '../../core/ids.js';
import { buildPanel, hem, HEM_GAP, HEM_LIP, HEM_TUCK, HEM_DUCT } from './kit/panel.js';
import { shiftRow } from './kit/sheet.js';
import { patch, polygon } from './kit/solids.js';
import { arc, roundCorners, offset } from './kit/outline.js';
import * as S from './spec.js';

const MM = S.MM, HALF_GAP = S.GAP / 2 * MM;
/** The nose and tail edges: the top skin folds down over the bumper and the tail panel. */
const HEM_FOLD = hem({ radius: 0.006, turn: 78, depth: 0.016, segs: 5, dark: 0.3 });

const SIDE = [3.1, 6.12], TOP = [0, 3];
/** Chart row of the bonnet, engine lid and boot lid side seams: on the flat, LID_MARGIN short of the crease fillet. */
const LID_MARGIN = 0.04, LID_ROW = 0.9 - LID_MARGIN;
/** Chart coordinates of a point given in side view (x, y) or in plan (x, z). */
export const onSide = (hull, x, y) => [x, hull.solve(x, 1, y, SIDE[0], SIDE[1])];
export const onTop = (hull, x, z) => [x, hull.solve(x, 0, z, TOP[0], TOP[1])];
/** Point of the top skin over plan position (x, z), or of the body side at side-view position (x, y), `depth` millimetres under the surface. Vehicle metres. */
export function topPoint(hull, x, z, depth = 0) { return under(hull, onTop(hull, x, z), depth); }
export function sidePoint(hull, x, y, depth = 0) { return under(hull, onSide(hull, x, y), depth); }
function under(hull, c, depth) {
  const p = hull.pos(c[0], c[1], [0, 0, 0]), n = hull.normal(c[0], c[1], [0, 0, 0]);
  return [p[0] - n[0] * depth * MM, p[1] - n[1] * depth * MM, p[2] - n[2] * depth * MM];
}
const FLOOR = [6.12, 7];
export const onFloor = (hull, x, z) => [x, hull.solve(x, 0, z, FLOOR[0], FLOOR[1])];

// Edge kinds: what happens along the edge that leaves a vertex. Outlines are authored where the panel's edge wall
// stands; the skin stops short of that by the reach of the rolled edge (and by half a shut line on a seam).
const seam = { hem: HEM_GAP, inset: HALF_GAP + HEM_GAP.reach };
const free = { hem: HEM_LIP, inset: HEM_LIP.reach };
const tucked = { hem: HEM_TUCK, inset: HEM_TUCK.reach };
const bare = { hem: null, inset: 0 };
const inSide = { via: 1, range: SIDE }, inPlan = { via: 0, range: TOP };

/** Cut line of a wheel opening: the opening outline moved 14 mm into the panel, where the flare band hides it. */
export function frontArchCut(fine = true) {
  const r = S.FRONT_ARCH.radius + 14, cx = S.FRONT_AXLE_X, cy = S.WHEEL.front.axleY;
  const a0 = Math.PI - Math.asin((S.NOSE_CUT_Y - cy) / r), a1 = Math.asin((S.SILL_TOP_Y - cy) / r), a2 = -Math.asin((cy - S.GROUND_CLEARANCE - 4) / r);
  return { upper: arc(cx, cy, r, a0, a1, fine ? 36 : 9), lower: arc(cx, cy, r, a1, a2, fine ? 12 : 3) };
}
export function rearArchOutline(grow = 0, fine = true) {
  const pts = grow ? offset(S.REAR_ARCH.outline, grow) : S.REAR_ARCH.outline;
  return roundCorners(pts, S.REAR_ARCH.cornerRadius.map((r) => (r ? r + grow : 0)), { segs: fine ? 7 : 2 });
}

/**
 * The NACA duct in side view: its three corners and the two points where the door's rear shut line crosses its edges
 * (the door carries the tip of the arrowhead, the rear wing the rest). All points are [x, y].
 */
export function nacaOutline(hull, doorTopRow) {
  const N = S.NACA, D = S.DOOR, top = hull.pos(D.rearTopX, doorTopRow, [0, 0, 0]), seam = [[D.rearTopX, top[1] / MM], [D.rearBottomX, S.SILL_TOP_Y]];
  const meet = (a, b) => {
    const [p, q] = seam, rx = q[0] - p[0], ry = q[1] - p[1], sx = b[0] - a[0], sy = b[1] - a[1], t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / (rx * sy - ry * sx);
    return [p[0] + rx * t, p[1] + ry * t];
  };
  return { apex: N.apex, mouthTop: N.top, mouthBottom: N.bottom, seamTop: meet(N.apex, N.top), seamBottom: meet(N.apex, N.bottom) };
}
export const DOOR_TOP_ROW = SIDE[0];
/** Chart row of the body side's lower edge, under the sill. */
export const SILL_ROW = SIDE[1];

// The lids meet the fixed shell on one chart row. Each side is cut from a copy of the hull whose row is moved
// half a shut line its own way, so both edges are true mesh rows and the gap is even along its whole length.
const LID_INSET = HALF_GAP + HEM_GAP.reach;
const lidSheet = (hull) => shiftRow(hull, LID_ROW, -LID_INSET, 0.1, LID_MARGIN);
const shellSheet = (hull) => shiftRow(hull, LID_ROW, LID_INSET, 0.1, LID_MARGIN);

/** Plan corners [x, z] of an opening in the wing top between the bonnet shut line and the shoulder, front inboard first. */
const wingOpening = (o) => [
  [o.x0, S.lidZ(o.x0) + o.lidClear], [o.x0, S.shoulderZ(o.x0) - o.shoulderClear],
  [o.x1, S.shoulderZ(o.x1) - o.shoulderClear], [o.x1, S.lidZ(o.x1) + o.lidClear],
];
const WING_CORNER = 0.016;
/** Lamp pod: depth of the lid's inner face under the skin (mm) and the gap kept between the turning pod and the opening (m). */
const LID_THICKNESS = 5, SWING_CLEARANCE = 0.006;
/** The same opening as a panel loop on `sheet`, every edge of the given kind. */
const wingLoop = (sheet, o, kind) => wingOpening(o).map(([x, z]) => ({ p: onTop(sheet, x, z), ...inPlan, ...kind, r: WING_CORNER }));

/**
 * Add the left half of the body panels to the builder.
 * quality: { da: lattice spacing along the car in mm, db: filler row spacing in chart units, hems: build shut lines }.
 */
export function buildCoachwork(mb, hull, quality) {
  const { da, db } = quality, withHems = quality.hems !== false;
  // Without shut lines the panels simply butt: an open gap with nothing behind it would show daylight. The folds
  // at the nose and tail stay, because they are what closes the skin onto the bumper and the tail panel.
  const edge = (kind) => (withHems ? kind : { ...kind, hem: null, inset: 0 });
  const SEAM = edge(seam), FREE = edge(free), TUCK = edge(tucked), FOLD = { hem: HEM_FOLD, inset: HEM_FOLD.reach };
  mb.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); mb.color(1, 1, 1); mb.occlusion(1);

  const lidInset = withHems ? LID_INSET : 0, lidHull = withHems ? lidSheet(hull) : hull, shellHull = withHems ? shellSheet(hull) : hull;
  const LID = LID_ROW, LIDSEAM = edge({ hem: HEM_GAP, inset: 0, margin: lidInset });
  const side = (x, y) => onSide(shellHull, x, y), top = (x, z) => onTop(shellHull, x, z);
  // every vertex of a panel's edge puts a row through the whole panel, so the reduced model takes its edges coarsely
  const edges = withHems ? { cornerSegs: 6 } : { cornerSegs: 2, tolerance: 0.0015, halvings: 1 };
  const lid = (outer) => buildPanel(mb, lidHull, { outer, da, db, ...edges });
  const panel = (outer, holes = []) => buildPanel(mb, shellHull, { outer, holes, da, db, ...edges });
  const polyline = (pts, kind, extra = {}) => pts.map((q, i) => ({ p: side(q[0], q[1]), ...kind, ...(i === 0 ? extra : {}) }));
  const D = S.DOOR, sillB = SIDE[1];

  // bonnet lid
  lid([
    { p: [S.BONNET.x0, 0], ...FOLD }, { p: [S.BONNET.x0, LID], ...LIDSEAM, sharp: true },
    { p: [S.BONNET.x1, LID], ...SEAM, r: 0.016 }, { p: [S.BONNET.x1, 0], ...bare, sharp: true },
  ]);

  // front shell: wing top, shoulder, flank and cowl in one piece
  const fa = frontArchCut(withHems), sb = S.SCREEN_BASE;
  const doorTop = DOOR_TOP_ROW;
  // The headlamp pod's lid is a separate, moving part (see buildLampLid). The reduced model, which has no shut
  // lines, simply leaves the wing whole there.
  const wingHoles = [wingLoop(shellHull, S.INDICATOR, TUCK)];
  if (withHems) wingHoles.push(wingLoop(shellHull, S.LAMP_POD, SEAM));
  panel([
    { p: [0, LID], ...FOLD, sharp: true },
    { p: side(0, S.NOSE_CUT_Y), ...inSide, ...SEAM, sharp: true },
    ...polyline(fa.upper, TUCK, { sharp: true }),
    { p: side(fa.upper[fa.upper.length - 1][0], S.SILL_TOP_Y), ...inSide, ...SEAM, sharp: true },
    { p: side(D.frontBottomX, S.SILL_TOP_Y), ...inSide, ...SEAM, r: 0.01 },
    { p: [D.frontTopX, doorTop], ...FREE, sharp: true },
    { p: top(sb.x1, sb.z1), ...inPlan, ...FREE },
    { p: top(sb.x0, sb.z0), ...FREE },
    { p: [sb.x0, 0], ...bare, sharp: true },
    { p: [S.BONNET.x1, 0], ...SEAM, sharp: true },
    { p: [S.BONNET.x1, LID], ...LIDSEAM, r: 0.016 },
  ], wingHoles);

  // door
  const duct = nacaOutline(shellHull, doorTop), ductEdge = { ...inSide, ...edge({ hem: HEM_DUCT, inset: HEM_DUCT.reach }), sharp: true };
  panel([
    { p: [D.frontTopX, doorTop], ...FREE, sharp: true },
    { p: [D.rearTopX, doorTop], ...inSide, ...SEAM, sharp: true },
    { p: side(...duct.seamTop), ...ductEdge },
    { p: side(...duct.apex), ...ductEdge },
    { p: side(...duct.seamBottom), ...inSide, ...SEAM, sharp: true },
    { p: side(D.rearBottomX, S.SILL_TOP_Y), ...inSide, ...SEAM, r: 0.01 },
    { p: side(D.frontBottomX, S.SILL_TOP_Y), ...inSide, ...SEAM, r: 0.01 },
  ]);

  // sill, from wheel opening to wheel opening
  const ra = rearArchOutline(14, withHems), raFront = S.REAR_ARCH.outline[0][0] - 14;
  panel([
    ...polyline(fa.lower.slice().reverse(), TUCK, { sharp: true }),
    { p: side(fa.lower[0][0], S.SILL_TOP_Y), ...inSide, ...SEAM, sharp: true },
    { p: side(raFront, S.SILL_TOP_Y), ...TUCK, sharp: true },
    { p: [raFront, sillB], ...TUCK, sharp: true },
    { p: [fa.lower[fa.lower.length - 1][0], sillB], ...TUCK, sharp: true },
  ]);

  // rear shell: quarter panel, rear wing top, valley walls and the fixed strips around the lids
  const el = S.ENGINE_LID, tailX = S.LENGTH, archTop = ra.filter((q) => q[1] > S.SILL_TOP_Y);
  const lv = S.LOUVRE_BANK;
  panel([
    { p: [S.CABIN_END_X, 0], ...TUCK, sharp: true },
    { p: [S.CABIN_END_X, 2.12], ...TUCK, sharp: true },
    { p: [D.rearTopX, doorTop], ...inSide, ...SEAM, sharp: true },
    { p: side(...duct.seamTop), ...ductEdge },
    { p: side(...duct.mouthTop), ...ductEdge },
    { p: side(...duct.mouthBottom), ...ductEdge },
    { p: side(...duct.seamBottom), ...inSide, ...SEAM, sharp: true },
    { p: side(D.rearBottomX, S.SILL_TOP_Y), ...inSide, ...SEAM, r: 0.01 },
    { p: side(raFront, S.SILL_TOP_Y), ...TUCK, sharp: true },
    ...polyline(archTop, TUCK),
    { p: [ra[ra.length - 1][0], sillB], ...FREE, sharp: true },
    { p: [tailX, sillB], ...FOLD, sharp: true },
    { p: [tailX, LID], ...LIDSEAM, sharp: true },
    { p: [S.BOOT_LID.x0, LID], ...SEAM, r: 0.016 },
    { p: [S.BOOT_LID.x0, 0], ...bare, sharp: true },
    { p: [el.x1, 0], ...SEAM, sharp: true },
    { p: [el.x1, LID], ...LIDSEAM, r: 0.016 },
    { p: [el.x0, LID], ...SEAM, r: 0.016 },
    { p: [el.x0, 0], ...bare, sharp: true },
  ], [[
    { p: top(lv.x0, lv.z0), ...inPlan, ...TUCK, r: 0.01 }, { p: top(lv.x0, lv.z1), ...inPlan, ...TUCK, r: 0.01 },
    { p: top(lv.x1, lv.z1 + 22), ...inPlan, ...TUCK, r: 0.01 }, { p: top(lv.x1, lv.z0), ...inPlan, ...TUCK, r: 0.01 },
  ]]);

  // engine lid and boot lid
  lid([{ p: [el.x0, 0], ...SEAM, sharp: true }, { p: [el.x0, LID], ...LIDSEAM, r: 0.016 }, { p: [el.x1, LID], ...SEAM, r: 0.016 }, { p: [el.x1, 0], ...bare, sharp: true }]);
  lid([{ p: [S.BOOT_LID.x0, 0], ...SEAM, sharp: true }, { p: [S.BOOT_LID.x0, LID], ...LIDSEAM, r: 0.016 }, { p: [tailX, LID], ...FOLD, sharp: true }, { p: [tailX, 0], ...bare, sharp: true }]);
}

/**
 * The lid of the pop-up headlamp pod, in its closed position: the piece of wing skin that buildCoachwork leaves out,
 * with the same shut line all round. It goes into its own builder because the pod is a moving part.
 */
export function buildLampLid(pod, hull, quality) {
  const sheet = shellSheet(hull);
  pod.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); pod.color(1, 1, 1); pod.occlusion(1);
  buildPanel(pod, sheet, { outer: wingLoop(sheet, S.LAMP_POD, seam), da: quality.da, db: quality.db, cornerSegs: 6 });
}

/**
 * The well under the pod's opening: satin black walls dropping from the shut line and a floor that falls away to the
 * rear, where the pod is deepest. Returns the cavity the lamp unit must live in and turn in:
 * { outline: plan corners [x, z] mm, lidUnder(x, z): point on the lid's inner face, floorY(x, z): floor height in mm,
 *   hinge: a point of the hinge axis, axis, openAngle, swing: the reach of the opening's front edge from the axis,
 *   less a working clearance; nothing on the pod may be further from the axis than that } (vehicle metres).
 */
export function buildLampWell(mb, hull) {
  const P = S.LAMP_POD, sheet = shellSheet(hull), outline = wingOpening(P);
  const drop = (x) => P.depthFront + (P.depthRear - P.depthFront) * (x - P.x0) / (P.x1 - P.x0);
  const floorY = (x, z) => topPoint(sheet, x, z)[1] / MM - drop(x);
  const loop = roundCorners(outline, WING_CORNER / MM, { closed: true, segs: 4 });
  const rim = loop.map(([x, z]) => topPoint(sheet, x, z, HEM_GAP.drop / MM)), foot = loop.map(([x, z]) => S.toCar(x, floorY(x, z), z));
  // walls and floor: unlit by the sky while the lid is shut, so they are authored dark
  mb.material(VEHICLE.TRIM_BLACK, 170, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.25);
  patch(mb, [rim, foot], { flip: true, closeJ: true, crease: 50 });
  polygon(mb, foot);

  const midZ = (S.lidZ(P.hingeX) + P.lidClear + S.shoulderZ(P.hingeX) - P.shoulderClear) / 2;
  const hinge = topPoint(sheet, P.hingeX, midZ, P.hingeDepth);
  let reach = Infinity;
  for (let k = 0; k <= 8; k++) {
    const q = topPoint(sheet, P.x0, outline[0][1] + (outline[1][1] - outline[0][1]) * k / 8);
    reach = Math.min(reach, Math.hypot(q[1] - hinge[1], q[2] - hinge[2]));
  }
  return {
    outline, floorY, lidUnder: (x, z) => topPoint(sheet, x, z, LID_THICKNESS),
    hinge, axis: [-1, 0, 0], openAngle: P.openAngle, swing: reach - SWING_CLEARANCE,
  };
}

/**
 * The floor: the underside of the hull from between the front wheel wells to the tail, notched for the wheel wells.
 * wells: { front: [x0, x1], rear: [x0, x1] } footprints of the arch liners (see arches.js).
 * from: the x between the front wells at which the nose's undertray has come up to the floor (see fascia.js).
 */
export function buildFloor(mb, hull, wells, from, quality) {
  const inFloor = { via: 0, range: FLOOR }, edge = FLOOR[0], f = [from, wells.front[1]], r = wells.rear;
  const fz = S.FRONT_ARCH.linerZ, rz = S.REAR_ARCH.linerZ, tail = S.LENGTH - S.TAIL_INSET;
  mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.5);
  buildPanel(mb, hull, {
    outer: [
      { p: onFloor(hull, f[0], fz), ...inFloor }, { p: onFloor(hull, f[1], fz) }, { p: [f[1], edge] },
      { p: [r[0], edge] }, { p: onFloor(hull, r[0], rz), ...inFloor }, { p: onFloor(hull, r[1], rz) }, { p: [r[1], edge] },
      { p: [tail, edge] }, { p: [tail, FLOOR[1]] }, { p: [f[0], FLOOR[1]] },
    ],
    da: quality.da * 3, db: 0.5,
  });
}
