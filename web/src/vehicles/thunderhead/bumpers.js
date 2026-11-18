// The two ends of the car below (and, at the tail, behind) the hull: the front bumper with its air dam, and the
// tail with the undercut lamp panel, the shelf and the rear bumper. Both are body colour and both are one skin swept
// along the plan outline of the belt (plan.js), so that they turn the corners of the car as the real mouldings do.
// On the body side each skin has exactly the hull's section, and fades into its own section round the corner.
// Also here: the rub strip, which runs along the belt right round the car and hides the joint between the skins.

import { VEHICLE } from '../../core/ids.js';
import { makeLoft } from '../hero/kit/sheet.js';
import { buildPanel, hem, HEM_GAP, HEM_LIP, HEM_TUCK, HEM_DUCT } from '../hero/kit/panel.js';
import { patch, polygon, planeFrame } from '../hero/kit/solids.js';
import * as S from './spec.js';
import { nose, tail } from './plan.js';
import { archCut, onTop, BELT_UP } from './body.js';
import { BAND } from './shell.js';

const MM = S.MM, B = S.B_OF, HALF_GAP = S.GAP / 2 * MM;
/** Smooth step with zero slope and zero curvature at both ends. */
const ease = (u) => { const t = Math.max(0, Math.min(1, u)); return t * t * t * (10 - 15 * t + 6 * t * t); };
const mix = (p, q, w) => [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w];
const BLACK = [0.21, 0.21, 0.215];
/**
 * Rails and radii of a swept skin from one function a -> { knots: [[out, y]...], radii: [...] }. The loft asks for
 * each rail separately and for the same few stations over and over; the section is worked out once per station.
 */
function sectioned(count, section) {
  const seen = new Map(), at = (a) => { let s = seen.get(a); if (!s) { s = section(a); seen.set(a, s); } return s; };
  return { rails: Array.from({ length: count }, (_, k) => (a) => at(a).knots[k]), radius: Array.from({ length: count }, (_, k) => (a) => at(a).radii[k]) };
}
function paint(mb, occ = 1) { mb.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); mb.color(1, 1, 1); mb.occlusion(occ); }
function urethane(mb, occ = 0.9) { mb.material(VEHICLE.TRIM_BLACK, 180, 0); mb.color(BLACK); mb.occlusion(occ); }
function underside(mb) { mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.5); }

// ---------------------------------------------------------------- front bumper

/** Chart rows of the front bumper's skin. */
export const NOSE_ROW = { belt: 0, lip: 1, under: 2, dam: 3 };
/**
 * The front bumper's skin. Chart: a along the nose outline (plan.js), b = 0 on the belt, 1 the lip, 2 the edge
 * under it where the paint ends, 3 the foot of the air dam.
 */
export function makeNoseSheet(filletRows = 4) {
  const F = S.FRONT_BUMPER, station = (a) => Math.max(S.NOSE_X, nose.point(a)[0]);
  const fade = (a) => 1 - ease((station(a) - F.fade[0]) / (F.fade[1] - F.fade[0]));
  /** The body side under the belt at height y, as [out, y]. */
  const flank = (x, y) => { const r = S.RAIL.R(x), s = S.RAIL.S(x); return [(s[0] - r[0]) * (r[1] - y) / (r[1] - s[1]), y]; };
  const sheet = makeLoft({
    ...sectioned(4, (a) => {
      const x = station(a), w = fade(a), r = S.RAIL.R(x), s = S.RAIL.S(x);
      return {
        knots: [[0, r[1]], mix(flank(x, F.sideLipY), F.lip, w), mix(flank(x, F.sideUnderY), F.under, w), mix([s[0] - r[0], s[1]], F.dam, w)],
        radii: [0, F.lipRadius * w, F.underRadius * w, 0],
      };
    }),
    place: (a, out, y, o) => { const f = nose.frame(a); return S.toCar(f[0] + f[2] * out, y, f[1] + f[3] * out, o); },
    flip: true, ha: 0.5, band: BAND, arcSegs: filletRows,
  });
  sheet.cols = () => [nose.corner, ...[2, 5, 10, 18, 30, 45, 65].map((d) => nose.corner + d)];
  return sheet;
}

/** The lamp slot in the front bumper's face: [z0, z1] across the car and [y0, y1] in height, mm; its corner radius, m. */
const LAMP_SLOT = { z: [190, 630], y: [392, 478], radius: 0.014 };

/**
 * Left half of the front bumper: painted face, black air dam, the tray under the nose.
 * trayEnd: station where the floor behind takes over (the front of the wheel well).
 * Returns { slot(z, y, w): the lamp slot's coordinates in vehicle metres, opening: the slot's extent } for lamps.js.
 */
export function buildFrontBumper(mb, sheet, quality, trayEnd) {
  const fine = quality.hems !== false, da = quality.da, edges = fine ? { cornerSegs: 6, tolerance: 4e-4, halvings: 1 } : { cornerSegs: 2, tolerance: 0.0015, halvings: 1 };
  const edge = (kind) => (fine ? kind : { hem: null, inset: 0 });
  const TUCK = edge({ hem: HEM_TUCK, inset: HEM_TUCK.reach }), ROW = edge({ hem: HEM_TUCK, inset: 0 }), DUCT = edge({ hem: HEM_DUCT, inset: HEM_DUCT.reach }), bare = { hem: null, inset: 0 };
  const R = NOSE_ROW, inY = { via: 1, range: [R.belt, R.dam] }, fx = S.FRONT_AXLE_X, F = S.WHEEL.front;
  const rowY = (row) => (x) => sheet.sec(nose.atX(x), row)[1];
  const chart = (pts, row0, row1) => pts.map((q, i) => [nose.atX(q[0]), i === 0 ? row0 : i === pts.length - 1 ? row1 : sheet.solve(nose.atX(q[0]), 1, q[1], R.belt, R.dam)]);
  const run = (pts, kind) => pts.map((p, i) => ({ p, ...inY, ...kind, sharp: i === 0 }));
  // the wheel opening's cut line: from the belt down to the paint's lower edge, and on down the air dam
  const upper = chart(archCut(fx, F, 144, 190, rowY(R.belt), rowY(R.under), quality.arch), R.belt, R.under);
  const lower = chart(archCut(fx, F, 190, 202, rowY(R.under), rowY(R.dam), quality.arch), R.under, R.dam);

  // --- painted face, with the slot of the turn and fog lamps
  const L = LAMP_SLOT, opening = [[L.z[0], L.y[1]], [L.z[1], L.y[1]], [L.z[1], L.y[0]], [L.z[0], L.y[0]]].map(([z, y]) => { const a = nose.atZ(z); return [a, sheet.solve(a, 1, y, R.belt, R.lip)]; });
  paint(mb);
  buildPanel(mb, sheet, {
    outer: [
      { p: [0, R.belt], ...bare, sharp: true },
      { p: [0, R.under], ...ROW, sharp: true },
      ...run(upper.slice().reverse(), TUCK),
      { p: upper[0], ...ROW, sharp: true },
    ],
    holes: fine ? [opening.map((p) => ({ p, ...DUCT, r: L.radius }))] : [],
    da, db: quality.db, ...edges,
  });
  /** The slot's own coordinates: z across the car and y up (mm) on the bumper's skin, w mm out of it. */
  const slot = (z, y, w = 0) => { const a = nose.atZ(z), b = sheet.solve(a, 1, y, R.belt, R.lip), p = sheet.pos(a, b, [0, 0, 0]), n = sheet.normal(a, b, [0, 0, 0]); return [p[0] + n[0] * w * MM, p[1] + n[1] * w * MM, p[2] + n[2] * w * MM]; };

  // --- air dam
  urethane(mb, 0.8);
  buildPanel(mb, sheet, {
    outer: [
      { p: [0, R.under], ...bare, sharp: true },
      { p: [0, R.dam], ...ROW, sharp: true },
      ...run(lower.slice().reverse(), TUCK),
      { p: lower[0], ...ROW, sharp: true },
    ],
    da: da * 2, db: quality.db, ...edges,
  });

  // --- tray under the nose, from the foot of the air dam back to the wheel well
  underside(mb);
  const aEnd = nose.atX(trayEnd), foot = []; for (let i = 0, n = 24; i <= n; i++) foot.push(sheet.pos(aEnd * i / n, R.dam, [0, 0, 0]));
  const last = foot[foot.length - 1];
  polygon(mb, [...foot, [0, last[1], last[2]]]);
  return { slot, opening: L };
}

// ---------------------------------------------------------------- tail

/** Chart rows of the tail's skin. */
export const TAIL_ROW = { inner: 0, crest: 1, foot: 2, ledge: 3, belt: 4, bulge: 5, bottom: 6, tuck: 7 };
/** On the body side the two rails the hull does not have lie on its facets: this share of the way down each. */
const LEDGE_SHARE = 0.8, BULGE_SHARE = 0.3;
/** How far the return under the bumper reaches inboard of the body side's lower edge, mm. */
const TUCK_IN = 45;

/**
 * The tail's skin. Chart: a along the tail outline (plan.js), b = 0 on the level deck inboard, 1 the deck's edge
 * (on the body side: the fender top G), 2 the foot of the lamp panel (H), 3 the shelf's edge, 4 the belt (R),
 * 5 the bumper's rearmost line, 6 its lower edge (S), 7 the return under it.
 */
export function makeTailSheet(hull, filletRows = 4) {
  const T = S.TAIL, station = (a) => Math.min(T.cornerX, tail.point(a)[0]);
  // the fade from the body side's section to the tail's begins just before the corner and is over well before its end
  const span = tail.rear - tail.corner, fade = (a) => ease((a - (tail.corner - 40)) / (span * 0.75 + 40));
  /** Height of the hull's deck over a plan point; outside the level part, that of its edge. */
  const deckY = (x, z) => { const xc = Math.min(S.DECK_END_X, x), zc = Math.max(0, Math.min(S.RAIL.G(xc)[0] - 40, z)); return hull.sec(xc, hull.solve(xc, 0, zc, B.C, B.G))[1]; };
  const inboard = (a, d) => { const f = tail.frame(a); return deckY(f[0] - f[2] * d, f[1] - f[3] * d); };
  const rail = (name, x) => { const p = S.RAIL[name](x); return [p[0] - S.beltZ(x), p[1]]; };
  const creased = (name, x) => (S.CREASE_RADIUS[name] instanceof Function ? S.CREASE_RADIUS[name](x) : S.CREASE_RADIUS[name]);
  const sheet = makeLoft({
    ...sectioned(8, (a) => {
      const x = station(a), w = fade(a), G = rail('G', x), H = rail('H', x), R = rail('R', x), Sb = rail('S', x), to = (side, rear) => side + (rear - side) * w;
      return {
        knots: [
          [-T.inner, inboard(a, T.inner)],
          mix(G, [T.crest[0], inboard(a, -T.crest[0]) + T.crest[1]], w),
          mix(H, T.foot, w),
          mix(mix(H, R, LEDGE_SHARE), T.ledge, w),
          R,
          mix(mix(R, Sb, BULGE_SHARE), T.bulge, w),
          mix(Sb, T.bottom, w),
          mix([Sb[0] - TUCK_IN, Sb[1]], T.tuck, w),
        ],
        radii: [0, to(creased('G', x), T.crestRadius), to(creased('H', x), T.footRadius), to(0, T.ledgeRadius), to(creased('R', x), T.beltRadius), to(0, T.bulgeRadius), to(creased('S', x), T.bottomRadius), 0],
      };
    }),
    place: (a, out, y, o) => { const f = tail.frame(a); return S.toCar(f[0] + f[2] * out, y, f[1] + f[3] * out, o); },
    flip: true, ha: 0.5, band: BAND, arcSegs: filletRows,
  });
  sheet.cols = () => [tail.corner, tail.rear];
  return sheet;
}

/** Tail lamps: centres [z, y] of the two on the left, and the radius of the opening each stands in, mm. */
export const TAIL_LAMPS = { centres: [[392, 777], [602, 777]], opening: 71 };
/** Recess of the rear number plate: half width, bottom and top, and how far its back wall stands ahead of the belt, mm. */
const PLATE_RECESS = { half: 168, y: [511, 692], back: 84 };

/** Plan points [x, z] of the shut line between the tail's skin and the deck, from the body side to the centre line. */
export function deckSeam(sheet) {
  const a0 = tail.atX(S.TAIL.seamX), pts = [], stops = [a0];
  for (let a = Math.ceil((a0 + 40) / 60) * 60; a < tail.corner - 30; a += 60) stops.push(a);
  for (let i = 0; i <= 14; i++) stops.push(tail.corner - 30 + (tail.rear + 30 - tail.corner + 30) * i / 14);
  for (let a = tail.rear + 100; a < tail.end - 40; a += 110) stops.push(a);
  stops.push(tail.end);
  for (const a of stops) { const p = sheet.pos(a, S.TAIL.cutRow, [0, 0, 0]); pts.push([S.ORIGIN_X - p[2] / MM, p[0] / MM]); }
  pts[pts.length - 1][1] = 0;
  return pts;
}

/**
 * Left half of the tail: the painted skin with the lamp openings and the plate recess, and the tray under it.
 * Returns { lamps: [{ plane, radius }], plateX }: the frame of each lamp opening, inboard first, and its radius in
 * mm; the station of the back wall of the plate's recess.
 */
export function buildTail(mb, sheet, quality) {
  const fine = quality.hems !== false, da = quality.da, edges = fine ? { cornerSegs: 6, tolerance: 4e-4, halvings: 1 } : { cornerSegs: 2, tolerance: 0.0015, halvings: 1 };
  const edge = (kind) => (fine ? kind : { hem: null, inset: 0 });
  const SEAM = edge({ hem: HEM_GAP, inset: HALF_GAP + HEM_GAP.reach }), FREE = edge({ hem: HEM_LIP, inset: HEM_LIP.reach }), TUCK = edge({ hem: HEM_TUCK, inset: HEM_TUCK.reach });
  const ROW = edge({ hem: HEM_TUCK, inset: 0 }), DUCT = edge({ hem: WELL, inset: WELL.reach }), bare = { hem: null, inset: 0 };
  const R = TAIL_ROW, T = S.TAIL, inY = { via: 1, range: [R.foot, R.tuck - 0.7] }, rx = S.REAR_AXLE_X, W = S.WHEEL.rear, P = PLATE_RECESS;
  const below = R.belt + BAND, sill = R.bottom + BAND, rowY = (row) => (x) => sheet.sec(tail.atX(x), row)[1];
  const cut = archCut(rx, W, 40, -22, rowY(below), rowY(sill), quality.arch).map((q, i, all) => [tail.atX(q[0]), i === 0 ? below : i === all.length - 1 ? sill : sheet.solve(tail.atX(q[0]), 1, q[1], below, sill)]);
  const aSeam = tail.atX(T.seamX), aPlate = tail.atZ(P.half), up = [R.crest, R.belt], down = [R.belt, R.bottom];
  const yRow = (a, y, range) => sheet.solve(a, 1, y, range[0], range[1]);
  const lamps = TAIL_LAMPS.centres.map(([z, y]) => {
    const loop = []; for (let i = 0; i < 28; i++) { const t = Math.PI * 2 * i / 28, a = tail.atZ(z + TAIL_LAMPS.opening * Math.cos(t)); loop.push({ p: [a, yRow(a, y + TAIL_LAMPS.opening * Math.sin(t), [R.crest, R.foot])], ...DUCT }); }
    return loop;
  });
  paint(mb);
  buildPanel(mb, sheet, {
    outer: [
      { p: [aSeam, T.cutRow], ...SEAM, sharp: true },
      { p: [aSeam, below], ...ROW, sharp: true },
      ...cut.map((p, i) => ({ p, ...inY, ...TUCK, sharp: i === 0 })),
      { p: cut[cut.length - 1], ...FREE, sharp: true },
      { p: [tail.corner - 60, sill], ...FREE, r: 0.05 },
      { p: [tail.corner + 60, R.tuck], ...bare, r: 0.05 },
      { p: [tail.end, R.tuck], ...bare, sharp: true },
      { p: [tail.end, yRow(tail.end, P.y[0], down)], ...FREE, sharp: true },
      { p: [aPlate, yRow(aPlate, P.y[0], down)], ...FREE, r: 0.012 },
      { p: [aPlate, yRow(aPlate, P.y[1], up)], ...bare, sharp: true },
      { p: [tail.end, yRow(tail.end, P.y[1], up)], ...bare, sharp: true },
      { p: [tail.end, T.cutRow], ...SEAM, sharp: true },
    ],
    holes: fine ? lamps : [],
    da, db: quality.db, ...edges,
  });

  // --- lamp openings: the frame each lamp is built in (u across the car, v up the panel, w out of it; mm)
  const out = { lamps: [], plateX: tail.beltX - P.back };
  for (const [z, y] of TAIL_LAMPS.centres) {
    const a = tail.atZ(z), c = sheet.pos(a, yRow(a, y, [R.crest, R.foot]), [0, 0, 0]), n = sheet.normal(a, yRow(a, y, [R.crest, R.foot]), [0, 0, 0]);
    const u = [-MM, 0, 0], v = [(n[1] * u[2] - n[2] * u[1]), (n[2] * u[0] - n[0] * u[2]), (n[0] * u[1] - n[1] * u[0])];
    out.lamps.push({ plane: planeFrame(c, u, v), radius: TAIL_LAMPS.opening });
  }

  // --- plate recess: side wall, floor and back wall
  // the walls stand just behind the skin's turned edges, which hide where they begin
  const backX = tail.beltX - P.back, wallZ = P.half + 1, floorY = P.y[0] - 1;
  const profile = []; for (let i = 0; i <= 14; i++) { const y = floorY + (P.y[1] - floorY) * i / 14, a = tail.atZ(wallZ), p = sheet.pos(a, yRow(a, y, y > T.ledge[1] ? up : down), [0, 0, 0]); profile.push([S.ORIGIN_X - p[2] / MM, y]); }
  paint(mb, 0.7);
  polygon(mb, [...profile, [backX, P.y[1]], [backX, P.y[0]]].map(([x, y]) => S.toCar(x, y, wallZ)).reverse());
  polygon(mb, [[profile[0][0], wallZ], [backX, wallZ], [backX, 0], [profile[0][0], 0]].map(([x, z]) => S.toCar(x, floorY, z)).reverse());
  paint(mb, 0.6);
  polygon(mb, [[0, floorY], [0, P.y[1] + 3], [wallZ, P.y[1] + 3], [wallZ, floorY]].map(([z, y]) => S.toCar(backX, y, z)));

  // --- tray under the tail, from the bumper's return forward to where the floor ends
  underside(mb);
  const foot = []; for (let i = 0, n = 28; i <= n; i++) foot.push(sheet.pos(tail.corner - 60 + (tail.end - tail.corner + 60) * i / n, R.tuck - 0.3, [0, 0, 0]));
  const first = foot[0];
  polygon(mb, [[0, first[1], first[2]], ...foot.map((p) => [p[0], p[1] + 0.002, p[2]])].reverse());
  return out;
}
/** The wall of a lamp opening: a small roll and a painted wall down to the lamp's gasket. */
const WELL = hem({ radius: 0.004, depth: 0.014, segs: 4, dark: 0.35 });

// ---------------------------------------------------------------- rub strip

/** Section of the rub strip as [across, proud] mm: across the strip (up the skin) and out of the skin. */
const STRIP = [[-12, -4], [-12, 3.5], [-9.5, 6], [9.5, 6], [12, 3.5], [12, -4]];
/** The strip stops this far short of a wheel opening's edge, on the flare, mm. */
const STRIP_END = 16;

/** One run of the strip along a row of a sheet. stops: chart coordinates a of its sections. */
function stripRun(mb, sheet, row, stops, capStart, capEnd) {
  const ja = [0, 0, 0], jb = [0, 0, 0], grid = stops.map((a) => {
    const p = sheet.pos(a, row, [0, 0, 0]), n = sheet.normal(a, row, [0, 0, 0]); sheet.jac(a, row, ja, jb);
    // up the skin, square to the strip's run
    let u = [n[1] * ja[2] - n[2] * ja[1], n[2] * ja[0] - n[0] * ja[2], n[0] * ja[1] - n[1] * ja[0]]; const l = Math.hypot(...u) * (u[1] < 0 ? -1 : 1); u = u.map((v) => v / l);
    return STRIP.map(([across, proud]) => [p[0] + (u[0] * across + n[0] * proud) * MM, p[1] + (u[1] * across + n[1] * proud) * MM, p[2] + (u[2] * across + n[2] * proud) * MM]);
  });
  // which way the grid faces depends on the direction of travel; the first section's middle tells
  const mid = grid[0][2], base = sheet.pos(stops[0], row, [0, 0, 0]), n0 = sheet.normal(stops[0], row, [0, 0, 0]);
  patch(mb, grid, { facing: [mid[0] - base[0] + n0[0], mid[1] - base[1] + n0[1], mid[2] - base[2] + n0[2]], crease: 35 });
  if (capStart) polygon(mb, grid[0]);
  if (capEnd) polygon(mb, grid[grid.length - 1].slice().reverse());
}
const spaced = (a0, a1, step, extra = []) => { const n = Math.max(1, Math.round(Math.abs(a1 - a0) / step)), out = []; for (let i = 0; i <= n; i++) out.push(a0 + (a1 - a0) * i / n); return [...out, ...extra.filter((a) => a > Math.min(a0, a1) && a < Math.max(a0, a1))].sort((p, q) => p - q); };

/** The left half of the rub strip: nose to front wheel, wheel to wheel, rear wheel to the plate recess. */
export function buildRubStrip(mb, hull, noseSheet, tailSheet, quality) {
  const step = quality.da * 1.5, reach = S.ARCH.radius + S.ARCH.flare - STRIP_END;
  // stations where the strip meets the flares of the wheel openings
  const meet = (axleX, w, sign) => { let x = axleX + sign * reach; for (let i = 0; i < 6; i++) x = axleX + sign * Math.sqrt(Math.max(0, reach * reach - (S.beltY(x) - w.axleY) ** 2)); return x; };
  const f0 = meet(S.FRONT_AXLE_X, S.WHEEL.front, -1), f1 = meet(S.FRONT_AXLE_X, S.WHEEL.front, 1), r0 = meet(S.REAR_AXLE_X, S.WHEEL.rear, -1), r1 = meet(S.REAR_AXLE_X, S.WHEEL.rear, 1);
  urethane(mb);
  const fineNose = []; for (let a = nose.corner; a < nose.atX(420); a += step * 0.4) fineNose.push(a);
  stripRun(mb, noseSheet, NOSE_ROW.belt, spaced(0, nose.atX(f0), step, fineNose), false, true);
  stripRun(mb, hull, B.R, spaced(f1, r0, step * 2), true, true);
  const fineTail = []; for (let a = tail.corner; a < tail.rear; a += step * 0.3) fineTail.push(a);
  stripRun(mb, tailSheet, TAIL_ROW.belt, spaced(tail.atX(r1), tail.atZ(PLATE_RECESS.half + 2), step, [...fineTail, tail.rear]), true, true);
}
