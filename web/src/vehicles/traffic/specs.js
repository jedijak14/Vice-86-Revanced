// Descriptions of the traffic vehicles. Each function returns the plain numbers and material choices that
// vehicle.js turns into geometry; nothing here creates a vertex except the few type-specific fittings
// (roof sign, light bar, cargo box, bus doors) handed over as callbacks.
//
// Distances along a car are written the way a body draughtsman reads them: `d` metres back from the nose.
// They become z in the vehicle frame (origin under the middle of the wheelbase) through z(d).

import * as mt from './materials.js';
import { slabShell, polyline } from './body.js';
import { endPanel, faceLamp, roundLamp, lightbar, roofSign, sideStrip, sideMarker, steeringWheel, wiper } from './parts.js';
import { patrol, unmarked } from './liveries.js';
import { box, rod, disc, quad, vec, X, Y, Z } from './kit.js';

const V = mt.VEHICLE, hex = mt.hex;
const xb = (d) => (F) => F.xB - d;
const toLinear = (c) => c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));

/** Period paint chart (sRGB). */
const PAINT = {
  white: 0xedebe2, cream: 0xe6ddb8, silver: 0xa9a9ad, lightBlue: 0x85afce, mediumBlue: 0x3f6190, navy: 0x1e2f55, burgundy: 0x5e1620, red: 0xb01a22,
  beige: 0xd7c9b6, lightBrown: 0x8a6b4a, darkBrown: 0x4a3528, black: 0x121214, charcoal: 0x4b4e52, darkGreen: 0x1d3a2b, paleYellow: 0xead77a, blueGrey: 0x717f8c,
  taxi: 0xf2c12e, patrolGreen: 0x22502b, busWhite: 0xf2f2f0,
};
const paints = (names) => names.split(' ').map((n) => mt.limitLinear(toLinear(hex(PAINT[n]))));
const TRIM = { tan: hex(0x8a6b4a), burgundy: hex(0x5e1620), blue: hex(0x2b4a7a), grey: hex(0x55585c) };
const amber = mt.lens(V.LAMP_INDICATOR_L, mt.C.amber, 1), plastic = mt.trim(0.7, mt.C.plastic);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Passenger car, pickup or van on the two-shell recipe: a lower body and a glasshouse.
 * o: dimensions from the reference table, the side-view stations (hood, cowl, headerF, peak, headerR, deck,
 * tailTop), door cuts, pillars, lamp panels and trim. Everything optional has a period default.
 */
function car(o) {
  const nose = o.wb / 2 + o.FO, tail = -o.wb / 2 - o.RO, z = (d) => nose - d, stand = o.stand ?? 0.12;
  const body = mt.paint(o.flake ?? 0), tint = o.glassTint ?? 70, beltY = o.cowl[1] - 0.045;
  const p = {
    name: o.name, kind: o.kind, spawnWeight: o.weight, seed: o.seed, paints: paints(o.paints), z,
    W: o.W, H: o.H, wheelbase: o.wb, trackF: o.trackF, trackR: o.trackR, wheelR: o.R, tyreW: o.tyreW, clearance: o.clearance,
    archR: o.archR ?? o.R + 0.09, nose, tail, standF: stand, standR: stand, bow: o.bow, cornerR: o.cornerR, taper: o.taper, flare: o.flare,
    hoodFront: o.hood, cowlZ: z(o.cowl[0]), cowlY: o.cowl[1], deckZ: z(o.deck[0]), deckY: o.deck[1], tailTop: o.tailTop,
    sillY: o.sill ?? o.clearance + 0.09, valanceF: o.valF ?? o.clearance + 0.2, valanceR: o.valR ?? o.clearance + 0.2,
    crease: o.crease, upper: o.upper, rowsLow: o.rowsLow, rowsHigh: o.rowsHigh, leanU: o.leanU, curveU: o.curveU,
    sillMoulding: o.sillMoulding, archMoulding: o.archMoulding, zRear: o.zRear, archZ: o.archZ, taperR: o.taperR,
    mats: { body, roof: o.roof || null, sideGlass: mt.glass(tint), screenGlass: mt.glass(Math.max(40, tint - 20)) },
    lowerCols: [], lowerPins: {}, livery: o.livery ? o.livery(z, body) : null,
    cabin: {
      headerF: [z(o.headerF[0]), o.headerF[1]], peak: [z(o.peak[0]), o.peak[1]], headerR: [z(o.headerR[0]), o.headerR[1]], baseR: o.baseR ? [z(o.baseR[0]), o.baseR[1]] : undefined,
      roofHalf: o.roofHalf, pillars: [], windows: o.windows.map(([c0, c1, extra]) => ({ c0, c1, ...(extra || {}) })), ...(o.cabin || {}),
    },
    front: o.front, rear: o.rear, eye: o.eye, wipers: o.wipers ?? [[o.eye[0] + 0.24, o.eye[0] - 0.3], [-0.06, -o.eye[0] - 0.2]],
    wheels: o.wheels, wheelsRear: o.wheelsRear, plate: o.plate,
    exhausts: (o.exhausts || [-0.5]).map((x) => ({ x, y: (o.valR ?? o.clearance + 0.2) - 0.05, z0: tail + 0.5, z1: tail + stand * 0.5 })),
    interior: o.interior, headlining: o.headlining, setup: o.setup, halfParts: o.halfParts, centreParts: o.centreParts,
    strips: o.strips || [], handles: [], markers: [], extraHeight: o.extraHeight || 0, mass: o.mass,
  };
  // Shut lines: bonnet and boot lid across the car and along their sides, and one column per door edge.
  if (o.hoodLine !== false) {
    p.lowerCols.push({ tag: 'hood', z: p.cowlZ + 0.1, gap: true, bandGroove: ['hoodSide', 'centre'], lod: 0 });
    p.lowerPins.hoodSide = { from: { top: 'hood' }, to: { top: 'endF' }, x: xb(0.085), gap: true, lod: 0 };
  }
  if (o.lid) {
    p.lowerCols.push({ tag: 'lid', z: p.deckZ - 0.09, gap: true, bandGroove: ['deckSide', 'centre'], lod: 0 });
    p.lowerPins.deckSide = { from: { top: 'endR' }, to: { top: 'lid-' }, x: xb(0.085), gap: true, lod: 0 };
  }
  const cutLod = o.doorLod ?? 0;
  o.doors.forEach((d, k) => p.lowerCols.push({ tag: 'door' + k, z: z(d), gap: true, sideGroove: ['sill', 'top'], lod: cutLod }));
  for (const [a, b] of o.doorSpans || o.doors.slice(1).map((d, k) => [o.doors[k], d])) p.handles.push({ z: z(b) + 0.14, y: lerp(beltY, o.deck[1] - 0.045, (b - o.cowl[0]) / (o.deck[0] - o.cowl[0])) - 0.06 });
  // Pillars: [tag, d of the foot, lean of the top towards the nose, kind]. A door edge running up through the
  // window frames ('gap') gets a post each side; 'rear' is the last door edge, with glass only ahead of it.
  for (const [tag, d, lean = 0, kind] of o.pillars) {
    const at = (dz) => ({ zb: z(d) + dz, zt: z(d) + dz + lean });
    if (kind === 'gap' || kind === 'rear') {
      if (kind === 'gap') p.cabin.pillars.push({ tag: tag + 'a', ...at(-0.04) });
      p.cabin.pillars.push({ tag, ...at(0), gap: true, sideGroove: ['bottom', 'top'], lod: cutLod }, { tag: tag + 'b', ...at(0.04) });
    } else if (kind === 'front') p.cabin.pillars.push({ tag, fromFront: d });
    else if (kind === 'back') p.cabin.pillars.push({ tag, fromRear: d, lean });
    else p.cabin.pillars.push({ tag, ...at(0) });
  }
  p.mirror = o.mirror === null ? null : { at: [o.W / 2 - 0.1, beltY + 0.07, p.cowlZ - 0.32], mat: o.mirror || mt.chrome };
  // Side marker lamps: amber on the front wings, red on the rear quarters.
  const markerY = o.markerY ?? 0.52, markerZ = [nose - stand - 0.3, tail + stand + 0.3];
  p.markers.push({ z: markerZ[0], y: markerY, color: mt.C.amber }, { z: markerZ[1], y: markerY, color: mt.C.red });
  // A side moulding at the height of the marker lamps ends just short of them instead of running across the lenses.
  for (const st of p.strips) if (!st.flat && typeof st.y === 'number' && st.z0 === undefined && Math.abs(st.y - markerY) < (st.h ?? 0.03) / 2 + 0.025) { st.z1 = markerZ[0] - 0.08; st.z0 = markerZ[1] + 0.08; }
  // Rain gutter along the roof edge, over the door glass.
  if (o.dripRail !== false) p.strips.push({ cabin: true, mat: o.dripRail || mt.chrome, y: (zz, cab) => cab.roofY(zz) - (p.cabin.headerDrop ?? 0.04) + 0.009, z0: p.cabin.headerR[0] + 0.04, z1: p.cabin.headerF[0] - 0.04, h: 0.016, proud: 0.007, step: 0.15, lod: 0 });
  // Small fittings of the nearest level: fuel filler door on the left rear quarter (in the middle of the rear
  // overhang unless the description places it), radio aerial on the right front wing, emblems.
  const quarter = [-o.wb / 2 - p.archR - 0.06, tail + stand + 0.02], wing = (o.wb / 2 + p.archR + 0.06 + nose - stand) / 2;
  p.filler = o.filler === undefined ? { z: (quarter[0] + quarter[1]) / 2, y: (o.crease[1] + o.upper[1]) / 2 } : o.filler;
  p.aerial = o.aerial === undefined ? { x: -(o.W / 2 - 0.17), z: p.cowlZ + 0.32 } : o.aerial;
  p.emblems = o.emblem === null ? [] : [{ kind: o.emblem || 'bar', z: wing, y: (o.crease[0] + o.upper[0]) / 2 + 0.035 }];
  if (o.crest) p.emblems.push({ kind: 'crest', cabin: true, z: z(o.crest), y: beltY + 0.21 });
  if (o.ornament) p.ornament = nose - stand - 0.1;
  p.tailBadge = o.tailBadge; p.mudFlaps = o.mudFlaps;
  const bar = (b, end) => (b === null ? null : { y: 0.46, h: 0.15, depth: stand + 0.02, wrap: 0.2, mat: mt.chrome, strip: 0.04, ...(b || {}) });
  p.bumperF = bar(o.bumperF); p.bumperR = bar(o.bumperR);
  return p;
}

/** Amber parking lamp and indicator set in the face of the front bumper bar. */
const bumperIndicator = (x, w = 0.2, h = 0.055) => (ctx) => {
  const { p, sk, lv } = ctx, b = p.bumperF, zf = p.nose - (b.bow ?? 0.03) * (x / (p.W / 2)) ** 2;
  ctx.lamps.indF.push(faceLamp(sk, [x, b.y, zf], w, h, 1, amber, lv));
};
const run = (...fns) => (ctx) => { for (const f of fns) if (f) f(ctx); };
const steel = (R, rimR, w, color, more) => ({ R, w, rimR, style: 'steel', color, ...more });
const tailBlock = (body) => ({ rows: ['crease', 'upper'], depth: 0.012, segs: [
  { w: 0.14, kind: 'brake', split: true, cells: [{ kind: 'brake', h: 1 }, { kind: 'brake', h: 1 }] }, { w: 0.14, kind: 'brake', split: true, cells: [{ kind: 'brake', h: 1 }, { kind: 'brake', h: 1 }] },
  { w: 0.14, kind: 'brake', cells: [{ kind: 'brake', h: 1 }, { kind: 'rev', h: 1 }] }, { kind: 'panel', mat: body }] });

/**
 * The full-size three-box sedan and everything built on it: s scales lengths, dy shifts the heights of the
 * body lines, and `v` carries what differs (size table row, trim level, livery, fittings).
 */
function sedan(v) {
  const s = v.L / 5.4, dy = v.H - 1.43, fleet = v.fleet, body = mt.paint(v.flake ?? 0), wR = v.R;
  return car({
    hood: 0.82 + dy, cowl: [1.6 * s, 0.93 + dy], headerF: [2.21 * s, 1.38 + dy], peak: [2.9 * s, 1.43 + dy], headerR: [3.75 * s, 1.39 + dy], deck: [4.23 * s, 0.95 + dy], tailTop: 0.9 + dy,
    crease: [0.6 + dy, 0.63 + dy], upper: [0.755 + dy, 0.8 + dy], roofHalf: 0.75 * v.W / 1.92, lid: true,
    doors: [1.665 * s, 2.765 * s, 3.665 * s], doorLod: v.doorLod,
    pillars: [['C', 3.665 * s, 0.16 * s, 'rear'], ['B', 2.765 * s, 0, 'gap'], ['A', 0.075, 0, 'front']], windows: [['Cb', 'Ba'], ['Bb', 'A']],
    front: { rows: ['crease', 'upper'], depth: 0.035, segs: [...(fleet ? [{ w: 0.07, kind: 'ind' }] : []), { w: 0.4, kind: 'lamps', lamps: 'quad' }, { kind: 'grille', pattern: fleet ? 0 : 1 }] },
    rear: [tailBlock(body)], plate: { y: 0.46, on: 'bumper' },
    bumperF: fleet ? { mat: mt.dullMetal } : { guard: 0.24 }, bumperR: fleet ? { mat: mt.dullMetal } : { guard: 0.24 },
    sillMoulding: !fleet, archMoulding: !fleet,
    wheels: fleet ? steel(wR, 0.2 * s, v.tyreW, [0.05, 0.05, 0.05]) : { R: wR, w: v.tyreW, rimR: 0.2 * s, style: 'wire', whitewall: true },
    strips: [{ mat: mt.rubber, y: 0.565 + dy, h: 0.045, proud: 0.009 }, ...(v.strips || [])], markerY: 0.565 + dy,
    tailBadge: true, crest: fleet ? 0 : 3.97 * s, ornament: !fleet, aerial: fleet ? null : undefined,
    interior: { tint: v.trim, rows: [{ dz: -0.28 }, { dz: -1.06 * s }], shelf: true },
    halfParts: run(fleet ? null : bumperIndicator(0.56 * v.W / 1.92), v.halfParts),
    ...v,
  });
}

const sedanFull = () => sedan({
  name: 'sedan', kind: 'sedan', weight: 18, seed: 11, L: 5.4, W: 1.92, H: 1.43, wb: 2.95, trackF: 1.57, trackR: 1.54, R: 0.344, tyreW: 0.205, clearance: 0.15, FO: 1.05, RO: 1.4, mass: 1650,
  eye: [0.4, 1.12, 0.2], trim: TRIM.burgundy, flake: 60, paints: 'white burgundy navy lightBlue beige lightBrown silver darkBrown white cream blueGrey darkGreen',
});

const sedanMid = () => {
  const roof = mt.vinyl(hex(0x1b2440));
  return sedan({
    name: 'sedan-midsize', kind: 'sedan', weight: 10, seed: 23, L: 4.78, W: 1.76, H: 1.37, wb: 2.66, trackF: 1.46, trackR: 1.44, R: 0.305, tyreW: 0.185, clearance: 0.15, FO: 0.93, RO: 1.19, mass: 1300,
    eye: [0.36, 1.07, 0.16], trim: TRIM.blue, flake: 60, roof, paints: 'white lightBlue silver cream navy blueGrey mediumBlue beige',
    // A plainer trim level than the big saloon: painted steel wheels with a bright ring and hub cap.
    wheels: { R: 0.305, w: 0.185, rimR: 0.177, style: 'steel', color: [0.6, 0.61, 0.62], ring: true, whitewall: true },
  });
};

const taxi = () => sedan({
  name: 'taxi', kind: 'taxi', weight: 6, seed: 37, L: 5.4, W: 1.92, H: 1.43, wb: 2.95, trackF: 1.57, trackR: 1.54, R: 0.344, tyreW: 0.205, clearance: 0.15, FO: 1.05, RO: 1.4, mass: 1700,
  eye: [0.4, 1.12, 0.2], trim: TRIM.grey, fleet: true, paints: 'taxi', extraHeight: 0.18,
  strips: [{ mat: mt.fixed([0.03, 0.03, 0.03]), y: 0.5, h: 0.05, proud: 0.0025, flat: true, lod: 2, step: 0.6 }],
  // The roof sign stands across the car above the B pillar.
  centreParts: ({ p, cab, skC, lv }) => { const zs = p.z(2.765); roofSign(skC, [0, cab.bandAt(cab.topS(zs), 0)[1] - 0.012, zs], 0.56, 0.16, 0.16, lv); },
});

const police = () => {
  const s = 5.22 / 5.4, d0 = 1.665 * s, d1 = 3.665 * s;
  return sedan({
    name: 'police', kind: 'police', weight: 2, seed: 53, L: 5.22, W: 1.85, H: 1.4, wb: 2.86, trackF: 1.52, trackR: 1.5, R: 0.341, tyreW: 0.215, clearance: 0.15, FO: 1.0, RO: 1.36, mass: 1650,
    eye: [0.38, 1.1, 0.15], trim: TRIM.grey, fleet: true, paints: 'patrolGreen', extraHeight: 0.18, doorLod: 2,
    // Green bonnet, wings, boot and quarters; white doors, pillars and roof. The pattern is the
    // agency's, not this body's (vehicles/traffic/liveries.js): the same livery goes on any of the
    // cars the island already builds, which is what a police car is here.
    livery: (z) => patrol(z, { doors: [d0, d1] }),
    strips: [{ mat: mt.fixed([0.03, 0.03, 0.03]), y: 0.5 - 0.03, h: 0.06, proud: 0.0025, flat: true, lod: 2, step: 0.6 }],
    centreParts: ({ p, cab, skC, lv }) => {
      const zs = p.z(2.765 * s), top = cab.bandAt(cab.topS(zs), 0)[1];
      lightbar(skC, [0, top + 0.035, zs], 1.25, 0.3, 0.14, lv);
      if (lv === 2) return;
      // Spot lamp on the driver's screen pillar: a short chrome drum facing forwards.
      const c = [cab.base(p.cowlZ - 0.2) + 0.075, p.cowlY + 0.12, p.cowlZ - 0.2];
      rod(skC, mt.chrome, [c[0] - 0.07, c[1] - 0.02, c[2] - 0.03], [c[0], c[1], c[2] - 0.03], 0.008, 6, false);
      rod(skC, mt.chrome, [c[0], c[1], c[2] - 0.07], [c[0], c[1], c[2] + 0.04], 0.065, lv === 0 ? 14 : 8, false);
      disc(skC, mt.unlitLens, [c[0], c[1], c[2] + 0.04], Z, X, Y, 0.065, lv === 0 ? 14 : 8); disc(skC, mt.chrome, [c[0], c[1], c[2] - 0.07], [0, 0, -1], X, Y, 0.065, lv === 0 ? 14 : 8);
    },
  });
};

const policeUnmarked = () => sedan({
  name: 'police-unmarked', kind: 'police', weight: 1, seed: 59, L: 4.78, W: 1.76, H: 1.37, wb: 2.66, trackF: 1.46, trackR: 1.44, R: 0.305, tyreW: 0.185, clearance: 0.15, FO: 0.93, RO: 1.19, mass: 1350,
  eye: [0.36, 1.07, 0.16], trim: TRIM.grey, flake: 20, paints: 'charcoal',
  // A radio car: no bar, no stripe, nothing on the paint. What gives it away is the aerial on the
  // rear wing and the fact that it is following you.
  livery: unmarked,
  centreParts: ({ p, skC, lv }) => {
    if (lv === 2) return;
    // Whips on the rear wing: a quarter-scale aerial in its mount, leaning outboard.
    const z = p.z(-2.0), y = 0.86;
    // The whip itself is a rod, and its mount a short length of black trim: an aerial is the one
    // fitting a radio car cannot be built without, and the only thing that gives it away.
    rod(skC, mt.blackTrim, [0.62, y, z], [0.64, y + 0.46, z - 0.06], 0.005, lv === 0 ? 6 : 4, false);
    rod(skC, mt.blackTrim, [0.62, y - 0.01, z - 0.04], [0.62, y + 0.02, z + 0.02], 0.024, 8, true);
  },
});

/** Personal two-door: the sedan recipe with one long door, a short cabin under a padded half roof and a formal upright grille. */
const coupe = () => {
  const body = mt.paint(100), landau = mt.vinyl(hex(0x17181b)), zB = 2.74 / 2 + 1.0 - 3.07;
  const block = (w, low) => ({ w, kind: 'brake', split: true, cells: [{ kind: low, h: 1 }, { kind: 'brake', h: 1 }] });
  return car({
    name: 'coupe', kind: 'coupe', weight: 12, seed: 71, W: 1.82, H: 1.37, wb: 2.74, trackF: 1.49, trackR: 1.47, R: 0.321, tyreW: 0.205, clearance: 0.14, FO: 1.0, RO: 1.35, mass: 1450,
    eye: [0.38, 1.06, 0], flake: 100, paints: 'silver burgundy black navy white charcoal darkBrown',
    hood: 0.8, cowl: [1.73, 0.9], headerF: [2.3, 1.32], peak: [2.85, 1.37], headerR: [3.42, 1.33], deck: [3.77, 0.92], tailTop: 0.89,
    crease: [0.57, 0.6], upper: [0.735, 0.79], roofHalf: 0.7, lid: true, doors: [1.72, 3.07],
    pillars: [['C', 3.5, 0.14], ['B', 3.07, 0, 'gap'], ['A', 0.075, 0, 'front']], windows: [['C', 'Ba'], ['Bb', 'A']],
    // The padded roof covers everything behind the door glass, in the manner of a town carriage.
    cabin: { sideMat: (z) => (z < zB - 0.03 ? landau : null), bandMat: (x, y, z) => (z < zB - 0.03 ? landau : null) },
    front: { rows: ['crease', 'upper'], depth: 0.035, segs: [{ w: 0.4, kind: 'lamps', lamps: 'quad' }, { kind: 'grille', pattern: 3 }] },
    rear: [{ rows: ['crease', 'upper'], depth: 0.012, segs: [block(0.17, 'brake'), block(0.17, 'brake'), block(0.13, 'rev'), { kind: 'panel', mat: body }] }],
    plate: { y: 0.46, on: 'bumper' }, bumperF: { guard: 0.22 }, bumperR: { guard: 0.22 }, sillMoulding: true, archMoulding: true,
    wheels: { R: 0.321, w: 0.205, rimR: 0.19, style: 'rally' },
    strips: [{ mat: mt.rubber, y: 0.55, h: 0.04, proud: 0.009 }], markerY: 0.55, tailBadge: true, crest: 3.6, ornament: true,
    interior: { tint: TRIM.burgundy, rows: [{ dz: -0.28, bucket: true }, { dz: -1.0 }], shelf: true },
    halfParts: bumperIndicator(0.52),
  });
};

/** Full-size station wagon: the big sedan to the middle pillar, then a long flat roof, wood-effect flanks and a roof rack. */
const wagon = () => {
  const body = mt.paint(40), wood = mt.wood(mt.C.woodPanel), frame = mt.fixed(mt.C.woodFrame, true), tail = -2.95 / 2 - 1.48, lo = 0.44, hi = 0.8;
  const stack = { w: 0.12, kind: 'brake', cells: [{ kind: 'rev', h: 0.6 }, { kind: 'brake', h: 1 }, { kind: 'brake', h: 1 }] };
  return car({
    name: 'wagon', kind: 'wagon', weight: 8, seed: 83, W: 2.01, H: 1.48, wb: 2.95, trackF: 1.58, trackR: 1.63, R: 0.359, tyreW: 0.225, clearance: 0.16, FO: 1.05, RO: 1.48, mass: 1900,
    ornament: true,
    eye: [0.4, 1.15, 0.2], flake: 40, cornerR: 0.09, paints: 'white burgundy navy lightBlue beige lightBrown darkBrown cream darkGreen silver',
    hood: 0.865, cowl: [1.6, 0.95], headerF: [2.21, 1.42], peak: [3.2, 1.48], headerR: [4.96, 1.44], deck: [5.2, 0.97], tailTop: 0.95,
    rowsLow: [{ tag: 'woodLo', y: lo, n: 1 }], crease: [0.57, 0.62], upper: [hi, hi], roofHalf: 0.8,
    doors: [1.665, 2.765, 3.665], pillars: [['D', 0.1, 0.02, 'back'], ['C', 3.665, 0, 'gap'], ['B', 2.765, 0, 'gap'], ['A', 0.075, 0, 'front']],
    windows: [['D', 'Ca'], ['Cb', 'Ba'], ['Bb', 'A']], cabin: { cornerR: 0.1, bowR: 0.03 },
    // Wood-effect film on the flanks and the tailgate, edged by a lighter strip standing just proud of it.
    livery: () => ({ side: (z, y) => (y > lo && y < hi ? wood : null), band: (x, y, z) => (z < tail + 0.4 && y > lo && y < hi ? wood : null), cabin: () => null }),
    strips: [{ mat: frame, y: lo + 0.012, h: 0.035, proud: 0.006, lod: 1 }, { mat: frame, y: hi - 0.012, h: 0.035, proud: 0.006, lod: 1 }],
    front: { rows: ['crease', 'upper'], depth: 0.035, segs: [{ w: 0.4, kind: 'lamps', lamps: 'quad' }, { kind: 'grille', pattern: 1 }] },
    rear: [{ rows: ['crease', 'upper'], depth: 0.012, segs: [stack, { kind: 'panel', mat: wood }] }],
    plate: { y: 0.555 }, bumperF: { guard: 0.24 }, bumperR: { y: 0.4, h: 0.14 }, archMoulding: true, markerY: 0.37,
    wheels: { R: 0.359, w: 0.225, rimR: 0.205, style: 'wire', whitewall: true },
    interior: { tint: TRIM.tan, rows: [{ dz: -0.28 }, { dz: -1.06 }], shelf: 0.56 },
    halfParts: run(bumperIndicator(0.6), ({ sk, cab, p, lv }) => {
      // Roof rack: a bright rail along each side standing on short feet (the cross bars are added once, below).
      if (lv === 2) return;
      const x = 0.55, z0 = p.z(4.9), z1 = p.z(3.3), y = (z) => cab.bandAt(cab.topS(z), x)[1];
      rod(sk, mt.chrome, [x, y(z0) + 0.05, z0], [x, y(z1) + 0.05, z1], 0.011, lv === 0 ? 8 : 5, true);
      for (const z of [z0 + 0.05, (z0 + z1) / 2, z1 - 0.05]) box(sk, mt.chrome, [x, y(z) + 0.02, z], [0.012, 0.03, 0.02], { skip: 'y' });
    }),
    centreParts: ({ skC, cab, p, lv }) => {
      if (lv === 2) return;
      for (const d of [4.6, 3.6]) { const z = p.z(d), y = cab.bandAt(cab.topS(z), 0.55)[1] + 0.05; rod(skC, mt.chrome, [-0.55, y, z], [0.55, y, z], 0.009, lv === 0 ? 8 : 5, false); }
    },
  });
};

/** Small front-drive hatchback: two boxes, a broad rear pillar, plastic bumpers and single rectangular lamps. */
const compact = () => {
  const body = mt.paint(0);
  return car({
    name: 'compact', kind: 'compact', weight: 18, seed: 97, W: 1.62, H: 1.4, wb: 2.4, trackF: 1.39, trackR: 1.36, R: 0.288, tyreW: 0.165, clearance: 0.14, FO: 0.8, RO: 0.7, mass: 900,
    filler: { z: -1.3, y: 0.81 }, tailBadge: true, dripRail: plastic,
    eye: [0.34, 1.1, 0.05], stand: 0.08, bow: 0.02, cornerR: 0.08, paints: 'white red paleYellow lightBlue silver beige mediumBlue',
    hood: 0.78, cowl: [0.95, 0.92], headerF: [1.46, 1.35], peak: [2.4, 1.4], headerR: [3.3, 1.37], deck: [3.68, 0.92], tailTop: 0.88,
    crease: [0.545, 0.6], upper: [0.715, 0.75], roofHalf: 0.62, doors: [1.02, 1.98, 2.78],
    pillars: [['C', 2.78, 0.1, 'rear'], ['B', 1.98, 0, 'gap'], ['A', 0.075, 0, 'front']], windows: [['Cb', 'Ba'], ['Bb', 'A']],
    cabin: { frame: mt.blackTrim, cornerR: 0.12 },
    front: { rows: ['crease', 'upper'], depth: 0.03, wall: mt.blackTrim, segs: [{ w: 0.07, kind: 'ind' }, { w: 0.235, kind: 'lamps' }, { kind: 'grille', pattern: 0 }] },
    rear: [{ rows: ['crease', 'upper'], depth: 0.01, wall: mt.blackTrim, segs: [{ w: 0.1, kind: 'ind' }, { w: 0.13, kind: 'brake' }, { w: 0.09, kind: 'rev' }, { kind: 'panel', mat: body }] }],
    plate: { y: 0.46, on: 'bumper' }, bumperF: { mat: plastic, y: 0.45, h: 0.17, wrap: 0.3, strip: 0 }, bumperR: { mat: plastic, y: 0.45, h: 0.17, wrap: 0.3, strip: 0 },
    wheels: { R: 0.288, w: 0.165, rimR: 0.17, style: 'cover' }, mirror: plastic, markerY: 0.62,
    strips: [{ mat: mt.rubber, y: 0.5, h: 0.035, proud: 0.007 }],
    interior: { tint: TRIM.grey, rows: [{ dz: -0.28, bucket: true }, { dz: -0.98 }], shelf: true },
  });
};

/** Domestic sports coupe: long low bonnet, lamps in deep pockets, glass hatch, dark lower body and tail panel. */
const sports = () => {
  const body = mt.paint(110), dark = mt.fixed(hex(0x2a2c30), true), nose = 2.565 / 2 + 1.08, tail = -2.565 / 2 - 1.235, len = nose - tail, low = 0.43;
  const along = (f, r) => (z) => lerp(r, f, (z - tail) / len);
  return car({
    name: 'sports', kind: 'sports', weight: 4, seed: 113, W: 1.85, H: 1.275, wb: 2.565, trackF: 1.54, trackR: 1.56, R: 0.33, tyreW: 0.215, clearance: 0.12, FO: 1.08, RO: 1.235, mass: 1480,
    dripRail: false, emblem: null, aerial: null,
    eye: [0.37, 0.98, -0.25], flake: 110, stand: 0.1, archR: 0.365, paints: 'red black white navy silver charcoal',
    hood: 0.68, cowl: [1.75, 0.86], headerF: [2.49, 1.235], peak: [2.85, 1.275], headerR: [3.15, 1.25], deck: [4.0, 0.93], tailTop: 0.93,
    rowsLow: [{ tag: 'low', y: low, n: 1 }], crease: [0.47, 0.6], rowsHigh: [{ tag: 'tailLo', y: along(0.53, 0.72), n: 1 }], upper: [0.6, 0.865], roofHalf: 0.62, leanU: 0.08, valF: 0.2,
    doors: [1.75, 3.05], pillars: [['B', 3.05, 0.04, 'rear'], ['A', 0.075, 0, 'front']], windows: [['Bb', 'A']],
    cabin: { frame: mt.blackTrim, cornerR: 0.3, bowR: 0.03, bowF: 0.04 },
    // Everything below the join line, air dam and rear valance included, is a contrasting dark grey.
    livery: () => ({ side: (z, y) => (y < low ? dark : null), band: (x, y) => (y < low ? dark : null), cabin: () => null }),
    front: { rows: ['crease', 'upper'], depth: 0.05, wall: mt.blackTrim, segs: [{ w: 0.4, kind: 'lamps', lamps: 'quad' }, { kind: 'panel', mat: body }] },
    rear: [{ rows: ['tailLo', 'upper'], depth: 0.012, wall: mt.blackTrim, segs: [{ w: 0.3, kind: 'brake', cells: [{ kind: 'brake', h: 1 }, { kind: 'brake', h: 1 }] }, { w: 0.1, kind: 'ind' }, { w: 0.12, kind: 'rev' }, { kind: 'panel', mat: mt.blackTrim }] }],
    plate: { y: 0.5, on: 'bumper' }, bumperF: { mat: body, y: 0.37, h: 0.14, strip: 0.03 }, bumperR: { mat: body, y: 0.52, h: 0.18, strip: 0.03 },
    wheels: { R: 0.33, w: 0.215, rimR: 0.205, style: 'alloy' }, mirror: body, markerY: 0.5, exhausts: [-0.45, -0.56],
    strips: [{ mat: mt.fixed(hex(0xc8c8c8)), y: low + 0.008, h: 0.012, proud: 0.002, flat: true, lod: 0 }],
    interior: { tint: TRIM.grey, rows: [{ dz: -0.28, bucket: true }, { dz: -0.95 }], shelf: true },
    halfParts: ({ sk, lower, lv }) => {
      // A rectangular fog lamp set in the air dam.
      if (lv === 2) return;
      const P = lower.bandAt(lower.faceS(1, 0.29), 0.5); box(sk, mt.vmat(V.LENS_CLEAR, 1, 0, 0, [0.95, 0.93, 0.85]), [0.5, 0.29, P[2] + 0.002], [0.08, 0.035, 0.008], { skip: 'z' });
    },
    centreParts: ({ skC, lower, p, lv }) => {
      // Black rubber lip across the trailing edge of the deck.
      const z = p.tail + p.standR + 0.09, y = lower.bandAt(lower.topS(z), 0)[1];
      box(skC, mt.rubber, [0, y + 0.012, z], [p.W / 2 - 0.14, 0.022, 0.035], { skip: 'y' });
    },
  });
};

/** Long-bed pickup: bonnet, a short upright cab and an open load bed cut into the rear body, with a two-tone band. */
const pickup = () => {
  const body = mt.paint(0), tone = mt.fixed(hex(0xe6ddb8)), wb = 3.34, FO = 0.83, z = (d) => wb / 2 + FO - d, lo = 0.62, hi = 1.0, bedDepth = 0.36;
  return car({
    name: 'pickup', kind: 'pickup', weight: 8, seed: 131, W: 2.02, H: 1.77, wb, trackF: 1.67, trackR: 1.59, R: 0.367, tyreW: 0.235, clearance: 0.2, FO, RO: 1.21, mass: 1750,
    eye: [0.42, 1.5, 0.33], archR: 0.427, cornerR: 0.07, stand: 0.1, bow: 0.02, taper: 0.03, leanU: 0.02, curveU: 0.04, paints: 'beige white red mediumBlue lightBrown darkBrown darkGreen',
    hood: 1.08, cowl: [1.35, 1.14], headerF: [1.84, 1.72], peak: [2.4, 1.77], headerR: [3.02, 1.73], deck: [3.1, 1.2], tailTop: 1.2,
    rowsLow: [{ tag: 'toneLo', y: lo, n: 1 }], crease: [0.76, 0.76], upper: [hi, hi], roofHalf: 0.75,
    doors: [1.8, 2.95], pillars: [['B', 2.95, 0, 'rear'], ['A', 0.075, 0, 'front']], windows: [['Bb', 'A']], cabin: { cornerR: 0.1, bowR: 0.025, bowF: 0.05 },
    // A second colour fills the band between two bright mouldings, tailgate included.
    livery: () => ({ side: (zz, y) => (y > lo && y < hi ? tone : null), band: (x, y, zz) => (zz < z(5.0) && y > lo && y < hi ? tone : null), cabin: () => null }),
    strips: [{ mat: mt.chrome, y: lo, h: 0.022, proud: 0.006, lod: 1 }, { mat: mt.chrome, y: hi, h: 0.022, proud: 0.006, lod: 1 }],
    front: { rows: ['crease', 'upper'], depth: 0.035, segs: [{ w: 0.26, kind: 'lamps' }, { kind: 'grille', pattern: 0 }] },
    rear: [{ rows: ['crease', 'upper'], depth: 0.01, segs: [{ w: 0.1, kind: 'brake', cells: [{ kind: 'rev', h: 0.5 }, { kind: 'brake', h: 1 }] }, { kind: 'panel', mat: tone }] }],
    plate: { y: 0.56, on: 'bumper' }, bumperF: { y: 0.58, h: 0.17, wrap: 0.16 }, bumperR: { y: 0.56, h: 0.17, wrap: 0.1 }, markerY: 0.7,
    wheels: steel(0.367, 0.21, 0.235, [0.82, 0.82, 0.78], { cap: 'small' }),
    emblem: 'plaque', filler: { z: z(3.5), y: 0.88 }, mudFlaps: [{ c: [0.82, 0.5, -wb / 2 - 0.43], w: 0.3, h: 0.37 }],
    interior: { tint: TRIM.tan, rows: [{ dz: -0.28 }], shelf: null },
    setup: ({ lower }) => {
      // The bed is a recess in the top of the rear body; a narrow shut line parts it from the cab.
      lower.def.cols.push({ tag: 'bedF', z: z(3.17) }, { tag: 'cabGap', z: z(3.135), gap: true, sideGroove: ['sill', 'top'], bandGroove: ['side', 'centre'], lod: 1 });
      lower.def.pins.bedSide = { from: { top: 'endR' }, to: { top: 'bedF' }, x: xb(0.1) };
      lower.bandBlock({ kind: 'recess', from: { top: 'endR' }, to: { top: 'bedF' }, k0: 'bedSide', k1: 'centre', depth: bedDepth, floor: mt.trim(0.75, hex(0x3a3b3d)), wall: body });
    },
    halfParts: run(bumperIndicator(0.66), ({ sk, lower, p, lv }) => {
      // The bed floor lies just above the rear tyres; each wheel housing shows as a low hump against the side.
      if (lv === 2) return;
      const a = lower.arches[0], yF = 1.2 - 0.045 - bedDepth, x1 = lower.def.side(a.z, 1.15) - 0.11;
      box(sk, body, [(a.xin - 0.02 + x1) / 2, yF + 0.03, a.z], [(x1 - a.xin + 0.02) / 2, 0.035, a.radius + 0.05], { skip: 'yX' });
    }),
  });
};

/** Panel van: a short sloping bonnet under a tall box with glass only in the cab and the rear doors. */
const van = () => {
  const body = mt.paint(0), wb = 3.505, FO = 0.75, z = (d) => wb / 2 + FO - d;
  return car({
    name: 'van', kind: 'van', weight: 6, seed: 149, W: 2.03, H: 2.05, wb, trackF: 1.76, trackR: 1.7, R: 0.367, tyreW: 0.235, clearance: 0.19, FO, RO: 0.995, mass: 2000,
    emblem: 'plaque', filler: { z: -0.5, y: 0.66 },
    eye: [0.48, 1.62, 0.7], cornerR: 0.05, stand: 0.06, bow: 0.015, taper: 0.03, leanU: 0.012, curveU: 0.02, paints: 'white cream white lightBlue lightBrown red',
    hood: 1.03, cowl: [0.85, 1.2], headerF: [1.53, 2.01], peak: [3.0, 2.05], headerR: [5.11, 2.02], deck: [5.13, 1.2], tailTop: 1.2,
    crease: [0.78, 0.8], upper: [0.965, 1.1], roofHalf: 0.93, glassTint: 90,
    doors: [1.31, 2.1, 2.3, 3.5], doorSpans: [[1.31, 2.1], [2.3, 3.5]],
    pillars: [['B', 2.1, 0, 'rear'], ['A', 0.075, 0, 'front']], windows: [['Bb', 'A']],
    cabin: {
      cornerR: 0.07, cornerF: 0.12, bowR: 0.02, bowF: 0.05, ledge: 0.006, roofEdge: 0.06, headerDrop: 0.1,
      // Each rear door carries its own pane instead of one glass across the tail.
      pins: { rearDoor: { from: { rear: 'sill' }, to: { rear: 'header' }, x: () => 0.06 } },
      backlight: { k1: 'rearDoor', inset: [0.1, 0.07, 0.1, 0.07], radius: 0.04, frame: body },
    },
    front: { rows: ['crease', 'upper'], depth: 0.03, segs: [{ w: 0.26, kind: 'lamps' }, { kind: 'grille', pattern: 0 }] },
    rear: [{ rows: ['crease', 'upper'], depth: 0.01, segs: [{ w: 0.09, kind: 'brake', cells: [{ kind: 'rev', h: 0.5 }, { kind: 'brake', h: 1 }, { kind: 'brake', h: 1 }] }, { kind: 'panel', mat: body }] }],
    plate: { y: 0.75 }, bumperF: { y: 0.52, h: 0.17, wrap: 0.16 }, bumperR: { y: 0.5, h: 0.16, wrap: 0.1 }, markerY: 0.7,
    wheels: steel(0.367, 0.21, 0.235, [0.82, 0.82, 0.78], { cap: 'small' }),
    // Three shallow ribs pressed along the flanks below the waist.
    strips: [0.86, 0.94, 1.02].map((y) => ({ mat: body, y, h: 0.03, proud: 0.007, z0: z(4.95), z1: z(2.2), lod: 0 })),
    interior: { tint: TRIM.grey, rows: [{ dz: -0.28, bucket: true }], shelf: 0.6, wallDz: -0.5, wallTop: 1.9 },
    halfParts: bumperIndicator(0.66),
    centreParts: ({ skC, lower, cab, p, lv }) => {
      if (lv === 2) return;
      // The meeting edge of the two rear doors, and their handle.
      const zl = lower.bandAt(lower.faceS(-1, 0.8), 0)[2], zc = cab.bandAt(cab.faceS(-1, 1.6), 0)[2];
      box(skC, mt.blackTrim, [0, 0.82, zl - 0.001], [0.004, 0.3, 0.002], { skip: 'Z' });
      box(skC, mt.blackTrim, [0, 1.62, zc - 0.001], [0.004, 0.36, 0.002], { skip: 'Z' });
      box(skC, mt.chrome, [0.06, 1.12, zl - 0.012], [0.035, 0.012, 0.012], { skip: 'Z' });
    },
  });
};

/** Tall door mirror of a van, lorry or bus: a dark head with a bright glass on two tubular arms. */
const tallMirror = (door, head, w = 0.15, h = 0.25) => ({ sk, lv }) => {
  if (lv === 2) return;
  box(sk, mt.blackTrim, head, [w / 2, h / 2, 0.012], { mats: { z: mt.chrome } });
  if (lv === 0) for (const dy of [-h / 2 + 0.02, h / 2 - 0.02]) rod(sk, mt.dullMetal, [door[0], door[1] + dy * 0.6, door[2]], [head[0] - w / 2 + 0.01, head[1] + dy, head[2]], 0.008, 5, false);
};
const marker = (color) => mt.lens(V.LAMP_MARKER, color, 1);

/** Box truck: the van's cab cut off behind the doors, and a separate aluminium cargo body on the chassis rails. */
const truck = () => {
  const body = mt.paint(0), wb = 4.01, FO = 0.76, nose = wb / 2 + FO, tail = -wb / 2 - 2.13, z = (d) => nose - d;
  const white = mt.fixed(hex(0xecebe6)), alu = mt.rim(hex(0xb4b6b8), 0.45, 0.9), frame = mt.trim(0.7, hex(0x1c1d1f));
  const zb0 = tail + 0.13, zb1 = z(2.5), half = 1.15, floor = 0.95, bandLo = 1.7, bandHi = 2.1;
  const p = car({
    name: 'truck', kind: 'truck', weight: 3, seed: 163, W: 2.03, H: 2.05, wb, trackF: 1.76, trackR: 1.8, R: 0.386, tyreW: 0.215, clearance: 0.2, FO, RO: 2.13, mass: 3200,
    emblem: 'plaque', filler: null, mudFlaps: [{ c: [0.87, 0.95, -wb / 2 - 0.6], w: 0.56, h: 0.68 }],
    eye: [0.48, 1.65, 0.965], cornerR: 0.05, stand: 0.06, bow: 0.015, taper: 0.03, leanU: 0.012, curveU: 0.02, paints: 'white red mediumBlue cream paleYellow white darkGreen',
    hood: 1.03, cowl: [0.85, 1.2], headerF: [1.53, 2.01], peak: [1.9, 2.05], headerR: [2.28, 2.03], deck: [2.3, 1.2], tailTop: 1.2, zRear: z(2.4), archZ: [wb / 2], extraHeight: 1.05, valR: 0.29,
    crease: [0.78, 0.8], upper: [0.965, 1.1], roofHalf: 0.93, glassTint: 90,
    doors: [1.31, 2.05], pillars: [['B', 2.05, 0, 'rear'], ['A', 0.075, 0, 'front']], windows: [['Bb', 'A']],
    cabin: { cornerR: 0.07, cornerF: 0.12, bowR: 0.02, bowF: 0.05, ledge: 0.006, roofEdge: 0.06, headerDrop: 0.1, backlight: null },
    front: { rows: ['crease', 'upper'], depth: 0.03, segs: [{ w: 0.26, kind: 'lamps' }, { kind: 'grille', pattern: 0 }] },
    rear: [], plate: { y: 0.75, z: zb0 }, bumperF: { y: 0.6, h: 0.17, wrap: 0.16 }, bumperR: null, markerY: 0.7, mirror: null,
    wheels: { R: 0.386, w: 0.215, rimR: 0.22, style: 'truck', color: [0.82, 0.82, 0.78] },
    wheelsRear: { R: 0.386, w: 0.215, rimR: 0.22, style: 'truck', dual: true, color: [0.82, 0.82, 0.78] },
    interior: { tint: TRIM.grey, rows: [{ dz: -0.28, bucket: true }], shelf: null },
    setup: (ctx) => {
      // The cargo body: white panels inside a frame of aluminium extrusions, with a band in the cab's colour.
      const edge = (zz, y) => zz < zb0 + 0.06 || zz > zb1 - 0.06 || y < floor + 0.06 || y > 2.97;
      ctx.box = slabShell({
        z0: zb0 + 0.05, z1: zb1 - 0.05, y0: floor, y1: 3.035, half, corner: 0.06, edge: { top: 0.055, front: 0.05, rear: 0.05, bottom: 0.02 }, crown: { top: 0.01, front: 0, rear: 0, bottom: 0 },
        rows: [{ tag: 'trimLo', y: floor + 0.06, n: 1 }, { tag: 'bandLo', y: bandLo, n: 1 }, { tag: 'bandHi', y: bandHi, n: 1 }, { tag: 'trimHi', y: 2.97, n: 1 }],
        cols: [{ tag: 'postR', z: zb0 + 0.06 }, { tag: 'postF', z: zb1 - 0.06 }],
        pins: { roll: { from: { rear: 'trimLo' }, to: { rear: 'trimHi' }, x: () => 1.03 } },
        matSide: (zz, y) => (edge(zz, y) ? alu : y > bandLo && y < bandHi ? body : white),
        matBand: (x, y, zz, chain) => (chain === 3 ? mt.under : chain === 1 ? alu : white),
      });
      ctx.box.bandBlock({ kind: 'recess', from: { rear: 'trimLo' }, to: { rear: 'trimHi' }, k0: 'roll', k1: 'centre', depth: 0.035, floor: white, wall: alu });
      ctx.shells.push({ shell: ctx.box });
    },
    halfParts: run(bumperIndicator(0.66), tallMirror([0.99, 1.45, z(1.4)], [1.13, 1.5, z(1.36)]), (ctx) => {
      const { sk, lv, lamps, note } = ctx, zr = zb0 + 0.035, red = mt.lens(V.LAMP_BRAKE, mt.C.red, 2, 1);
      // Rear sill of the body with the lamps let into it, the step bumper hung below on two brackets.
      box(sk, frame, [0.55, 0.825, zb0 + 0.06], [0.55, 0.125, 0.06], { skip: 'xY' });
      note('brake', faceLamp(sk, [0.98, 0.85, zb0], 0.1, 0.13, -1, red, lv));
      note('brake', faceLamp(sk, [0.86, 0.85, zb0], 0.1, 0.13, -1, red, lv));
      note('ind', faceLamp(sk, [0.74, 0.85, zb0], 0.1, 0.13, -1, mt.lens(V.LAMP_INDICATOR_L, mt.C.amber, 2), lv));
      note('rev', faceLamp(sk, [0.62, 0.85, zb0], 0.1, 0.13, -1, mt.lens(V.LAMP_REVERSE, mt.C.white, 2), lv));
      box(sk, mt.dullMetal, [0.54, 0.55, tail + 0.075], [0.54, 0.05, 0.075], { skip: 'x' });
      if (lv < 2) {
        box(sk, frame, [0.7, 0.66, tail + 0.1], [0.03, 0.06, 0.04], { skip: 'yY' });
        // Chassis rail, rear axle and spring under the body; a mud flap behind the twin wheels.
        box(sk, frame, [0.42, 0.62, (z(2.3) + zb0) / 2 + 0.1], [0.04, 0.09, (z(2.3) - zb0) / 2 - 0.1], { skip: 'Z' });
        rod(sk, frame, [0, 0.386, -wb / 2], [0.62, 0.386, -wb / 2], 0.06, 8, false);
        box(sk, frame, [0.42, 0.74, -wb / 2], [0.05, 0.035, 0.6], {});
        box(sk, mt.rubber, [0.915, 0.63, -wb / 2 - 0.5], [0.215, 0.33, 0.006], { skip: 'Y' });
        // Clearance lamps at the top corners and beside the centre group, amber ahead and red behind.
        const zf = zb1;
        for (const x of [0.25, 1.05]) { faceLamp(sk, [x, 3.0, zf], 0.07, 0.03, 1, marker(mt.C.amber), lv); faceLamp(sk, [x, 3.0, zb0], 0.07, 0.03, -1, marker(mt.C.red), lv); }
        sideMarker(sk, ctx.box, zb0 + 0.25, 1.05, mt.C.red, lv); sideMarker(sk, ctx.box, zb1 - 0.25, 1.05, mt.C.amber, lv);
      }
      if (lv === 0) {
        // Rivet lines on the side panels and the slats of the roll-up door.
        for (let zz = zb0 + 0.6; zz < zb1 - 0.3; zz += 0.6) box(sk, white, [half + 0.002, (floor + 0.06 + bandLo) / 2, zz], [0.003, (bandLo - floor - 0.06) / 2, 0.008], { skip: 'x' }), box(sk, white, [half + 0.002, (bandHi + 2.97) / 2, zz], [0.003, (2.97 - bandHi) / 2, 0.008], { skip: 'x' });
        for (let y = floor + 0.06 + 0.3; y < 2.95; y += 0.3) box(sk, mt.trim(0.6, hex(0x8f9194)), [0.515, y, zr - 0.001], [0.515, 0.006, 0.002], { skip: 'xZ' });
      }
    }),
    centreParts: ({ skC, lv }) => {
      if (lv === 2) return;
      faceLamp(skC, [0, 3.0, zb1], 0.07, 0.03, 1, marker(mt.C.amber), lv); faceLamp(skC, [0, 3.0, zb0], 0.07, 0.03, -1, marker(mt.C.red), lv);
      // Fuel tank on the left rail, the door's pull strap and latch, the bracket of the number plate.
      rod(skC, mt.dullMetal, [0.78, 0.55, z(3.0)], [0.78, 0.55, z(3.6)], 0.17, lv === 0 ? 12 : 6, true);
      box(skC, mt.blackTrim, [0, 1.08, zb0 + 0.033], [0.02, 0.07, 0.003], { skip: 'Z' });
      box(skC, mt.dullMetal, [0, 1.0, zb0 + 0.03], [0.07, 0.015, 0.006], { skip: 'Z' });
    },
  });
  p.markers.pop();                 // the rear side marker sits on the cargo body instead (see halfParts)
  p.colliderWidth = 2 * half;      // the cargo body is wider than the cab
  p.exhausts = [{ x: -0.62, y: 0.5, z0: -wb / 2 - 0.7, z1: zb0 + 0.25 }];   // the pipe ends under the body, not beyond the step
  return p;
};

/** City bus: one long slab with a dark window band, an upright two-piece windscreen under a destination sign, and doors on the kerb side only. */
const bus = () => {
  const wb = 6.05, FO = 2.13, RO = 2.49, nose = wb / 2 + FO, tail = -wb / 2 - RO, z = (d) => nose - d, W = 2.59, hw = W / 2 - 0.006;
  const body = mt.paint(0), teal = mt.fixed(hex(0x1fa6a0)), pink = mt.fixed(hex(0xe8438f)), grey = mt.fixed(hex(0x8e9296)), black = mt.trim(0.3, hex(0x0f1012));
  const glassSide = mt.glass(140), glassScreen = mt.glass(95), belt = 1.3, header = 2.25, lean = 0.3, y0 = 0.34, y1 = 2.7, floor = 0.86;
  const wheel = { R: 0.5, w: 0.3, rimR: 0.29, style: 'truck', color: [0.86, 0.86, 0.83] };
  // Window modules along the side, d from the nose: the driver's (or door) bay, then six of 1.4 m.
  const bays = [[0.66, 1.42], ...[0, 1, 2, 3, 4, 5].map((k) => [1.52 + 1.4 * k, 2.82 + 1.4 * k])], zW1 = z(bays[0][0]) + 0.05, zW0 = z(bays[6][1]) - 0.05;
  const side = (zz, y) => hw - (y > belt ? 0.05 * (y - belt) : 0);
  // Far away the narrow white line between the two stripes is given up and the upper stripe takes its place.
  const livery = (y, lv) => (y < 0.55 && lv < 2 ? grey : y > 0.96 && y < 1.1 ? pink : y > (lv === 2 ? 1.1 : 1.14) && y < 1.28 ? teal : null);
  const doors = [[0.64, 1.5], [6.42, 7.42]];
  return {
    name: 'bus', kind: 'bus', spawnWeight: 2, seed: 181, paints: paints('busWhite'), z, W, H: 2.9, extraHeight: 0.12, wheelbase: wb, trackF: 2.18, trackR: 1.94, wheelR: 0.5, tyreW: 0.3, clearance: 0.3,
    // Long flat panels need far fewer stations along the body than a car's curves do.
    quality: [{ len: 0.28 }, { len: 1.2 }, {}],
    archR: 0.57, nose, tail, eye: [0.8, 1.95, 4.4], mass: 11500, massBias: 0, wheels: wheel, wheelsRear: { ...wheel, dual: true }, lowerLiner: mt.interior(2, [0.6, 0.6, 0.58]),
    makeLower: (p, lv) => {
      // From far away the grey skirt, the blind and the plain panels at each end of the window band are given up:
      // the grid they need costs more than a few pixels are worth.
      const cols = []; bays.forEach(([d0, d1], k) => cols.push({ tag: 'w' + k + 'f', z: z(d0), lod: 1 }, { tag: 'w' + k + 'r', z: z(d1), lod: 1 }));
      const glazed = (zz, y) => y > belt && y < header && (lv === 2 || (zz < zW1 && zz > zW0));
      const sh = slabShell({
        z0: tail + 0.26, z1: nose - 0.29, y0, y1, half: side, lean, corner: 0.1, endCols: [3, 2, 1],
        edge: { top: 0.18, front: 0.2, rear: 0.2, bottom: 0.04 }, crown: { top: 0.02, front: 0.03, rear: 0, bottom: 0 },
        rows: [{ tag: 'skirt', y: 0.55, n: 1, lod: 1 }, { tag: 'lampLo', y: 0.72, n: 1 }, { tag: 'lampHi', y: 0.88, n: 1 }, { tag: 'p0', y: 0.96, n: 1 }, { tag: 'p1', y: 1.1, n: 1 }, { tag: 't0', y: 1.14, n: 1, lod: 1 }, { tag: 't1', y: 1.28, n: 1 },
          { tag: 'belt', y: belt, n: 2 }, { tag: 'header', y: header, n: 1 }, { tag: 'signLo', y: 2.33, n: 1, lod: 1 }, { tag: 'signHi', y: 2.56, n: 1, lod: 1 }],
        cols, pins: { screen: { from: { front: 'header' }, to: { front: 'belt' }, x: () => (lv < 2 ? 1.14 : 1.13) }, ...(lv < 2 ? { sign: { from: { front: 'signHi' }, to: { front: 'signLo' }, x: () => 0.8 } } : null) },
        // The posts between the panes are black, so the glazing reads as one dark band that carries on round both ends.
        matSide: (zz, y) => (glazed(zz, y) ? (lv === 2 ? mt.farGlass : black) : livery(y, lv) || body),
        matBand: (x, y, zz, chain) => (chain === 3 ? mt.under : chain === 1 ? body : y > belt && y < (chain === 2 && lv < 2 ? 2.56 : header) ? black : livery(y, lv) || body),
      });
      for (const az of [-wb / 2, wb / 2]) sh.arch({ z: az, y: 0.5, radius: 0.57, lipMat: black, depth: az < 0 ? 0.78 : 0.46 });
      // Only the nearest level has real glass with a saloon behind it; further off the dark panes are blind.
      const pane = lv === 0 ? { kind: 'window', frame: black } : { kind: 'recess', depth: 0.012, wall: black, floor: mt.farGlass };
      if (lv < 2) bays.forEach((b, k) => sh.sideWindow({ ...pane, r0: 'belt', r1: 'header', c0: 'w' + k + 'r', c1: 'w' + k + 'f', inset: 0.02, radius: 0.05, pane: glassSide, far: mt.farGlass }));
      sh.bandBlock({ ...pane, from: { front: 'header' }, to: { front: 'belt' }, k0: 'screen', k1: 'centre', inset: [0.03, 0.03, 0, 0.03], radius: 0.06, pane: glassScreen, far: mt.farGlass });
      // Destination blind: an amber lens that glows with the lamps, set in the black panel over the windscreen.
      if (lv < 2) sh.bandBlock({ kind: 'recess', from: { front: 'signHi' }, to: { front: 'signLo' }, k0: 'sign', k1: 'centre', depth: 0.02, floor: mt.lens(V.LAMP_MARKER, [0.62, 0.4, 0.08], 2), wall: black });
      return sh;
    },
    front: (lv) => ({ rows: ['lampLo', 'lampHi'], depth: 0.03, margin: lv < 2 ? 0.07 : 0.16, wall: black, segs: [...(lv < 2 ? [{ w: 0.1, kind: 'ind' }] : []), { w: lv < 2 ? 0.4 : 0.5, kind: 'lamps', lamps: 'quad' }, { kind: 'grille', pattern: 0 }] }),
    rear: [{ rows: ['lampLo', 'p1'], depth: 0.03, margin: 0.4, wall: black, lod: 1, segs: [{ kind: 'grille', pattern: 0 }] }],
    bumperF: { y: 0.47, h: 0.25, depth: 0.08, wrap: 0.3, radius: 0.22, mat: mt.rubber }, bumperR: { y: 0.47, h: 0.25, depth: 0.08, wrap: 0.3, radius: 0.22, mat: mt.rubber },
    plate: { y: 0.7, z: tail + 0.06 + 0.03 }, exhausts: [{ x: -0.95, y: 0.36, z0: tail + 0.6, z1: tail + 0.03 }],
    strips: [{ mat: mt.rubber, y: 0.55, h: 0.05, proud: 0.01, lod: 1 }],
    markers: [{ z: nose - 0.5, y: 0.64, color: mt.C.amber }, { z: tail + 0.5, y: 0.64, color: mt.C.red }, { z: 0.3, y: 0.64, color: mt.C.amber }],
    halfParts: run(tallMirror([1.28, 1.7, z(0.38)], [1.42, 1.75, z(0.3)], 0.18, 0.3), (ctx) => {
      const { sk, lv, lower, note } = ctx, rear = (y, x) => lower.bandAt(lower.faceS(-1, y), x), front = (y, x) => lower.bandAt(lower.faceS(1, y), x);
      // Three round lamps stacked at each rear corner: stop and tail, indicator, reversing.
      note('brake', roundLamp(sk, rear(1.1, 1.03), 0.05, -1, mt.lens(V.LAMP_BRAKE, mt.C.red, 3, 1), lv));
      note('ind', roundLamp(sk, rear(0.95, 1.03), 0.05, -1, mt.lens(V.LAMP_INDICATOR_L, mt.C.amber, 3), lv));
      note('rev', roundLamp(sk, rear(0.8, 1.03), 0.05, -1, mt.lens(V.LAMP_REVERSE, mt.C.white, 3), lv));
      if (lv === 2) return;
      // Clearance lamps along the top edge of both ends.
      for (const x of [0.22, 1.02]) { faceLamp(sk, front(2.63, x), 0.07, 0.03, 1, marker(mt.C.amber), lv); faceLamp(sk, rear(2.6, x), 0.07, 0.03, -1, marker(mt.C.red), lv); }
      if (lv === 1) return;
      // Saloon: a floor at the top of the entrance steps, lined walls below the windows and rows of paired seats.
      const dark = mt.interior(1, hex(0x2c2e31)), seat = mt.interior(0, hex(0x2a4a6a)), x1 = hw - 0.06;
      // The floor stops at each wheel housing, which rises through it as a box.
      let zz0 = tail + 0.4;
      const strip = (za, zb, x) => quad(sk, dark, [[0, floor, za], [0, floor, zb], [x, floor, zb], [x, floor, za]], Y, null, 0.7);
      for (const a of lower.arches.slice().sort((p0, p1) => p0.z - p1.z)) {
        const xi = a.xin - 0.02, hl = a.radius + 0.06, top = a.y + a.radius + 0.06;
        strip(zz0, a.z - hl, x1); strip(a.z - hl, a.z + hl, xi); zz0 = a.z + hl;
        box(sk, dark, [(xi + x1) / 2, (floor + top) / 2, a.z], [(x1 - xi) / 2, (top - floor) / 2, hl], { skip: 'yX', occ: 0.7 });
      }
      strip(zz0, nose - 0.45, x1);
      for (let zz = 3.5; zz > tail + 1.2; zz -= 0.8) {
        box(sk, seat, [0.78, 1.52, zz - 0.2], [0.42, 0.34, 0.035], { skip: 'y', occ: 0.75 });
        if (lv === 0) box(sk, seat, [0.78, 1.25, zz], [0.42, 0.045, 0.2], { skip: 'yz', occ: 0.6 });
      }
      // The back of the saloon is closed off from the engine bay.
      quad(sk, dark, [[0, floor, tail + 0.4], [x1, floor, tail + 0.4], [x1 - 0.05, header + 0.1, tail + 0.4], [0, header + 0.1, tail + 0.4]], Z, null, 0.6);
    }),
    centreParts: ({ skC, lv, lower }) => {
      const front = (y, x) => lower.bandAt(lower.faceS(1, y), x), rear = (y) => lower.bandAt(lower.faceS(-1, y), 0);
      // Air-conditioning unit on the rear of the roof.
      box(skC, body, [0, 2.95, tail + 1.5], [0.9, 0.07, 1.0], { skip: 'y' });
      // Kerb-side doors: two glazed leaves each, standing just proud of the body side.
      const up = vec.unit([0.05, 1, 0]), out = vec.unit([-1, 0.05, 0]), leaf = (m, zc, w, ya, yb, proud) => {
        // Far away the slight lean of the upper half is not worth a second slab: the one upright slab then stands a
        // little clear of the leaning side above the belt, so it keeps its inner face.
        const lowTop = lv === 2 ? yb : Math.min(yb, belt);
        if (ya < belt) box(skC, m, [-(hw + proud / 2), (ya + lowTop) / 2, zc], [proud / 2, (lowTop - ya) / 2, w / 2], { ax: [[-1, 0, 0], Y, [0, 0, -1]], skip: lv === 2 ? '' : 'x' });
        if (yb > lowTop) { const a = Math.max(ya, belt), ym = (a + yb) / 2; box(skC, m, vec.mad([-side(0, ym), ym, zc], out, proud / 2), [proud / 2, (yb - a) / 2, w / 2], { ax: [out, up, [0, 0, -1]], skip: 'x' }); }
      };
      for (const [d0, d1] of doors) {
        const zc = z((d0 + d1) / 2), w = d1 - d0;
        leaf(black, zc, w, 0.4, header + 0.02, 0.014);
        if (lv === 0) leaf(mt.dullMetal, zc, 0.03, 0.42, header, 0.02);
        if (lv < 2) for (const s of [-1, 1]) { leaf(mt.farGlass, zc + s * w / 4, w / 2 - 0.05, 0.5, belt - 0.05, 0.018); leaf(mt.farGlass, zc + s * w / 4, w / 2 - 0.05, belt + 0.04, header - 0.04, 0.018); }
      }
      if (lv === 2) return;
      faceLamp(skC, front(2.63, 0), 0.07, 0.03, 1, marker(mt.C.amber), lv); faceLamp(skC, rear(2.6), 0.07, 0.03, -1, marker(mt.C.red), lv);
      // The windscreen is two panes: a black post down the middle.
      const a = front(belt + 0.03, 0), b = front(header - 0.03, 0), mid = vec.scale(vec.add(a, b), 0.5), along = vec.unit(vec.sub(b, a)), n = [a[3], a[4], a[5]];
      box(skC, black, vec.mad(mid, n, 0.004), [0.02, Math.hypot(...vec.sub(b, a)) / 2, 0.006], { ax: [X, along, n], skip: 'z' });
      if (lv === 1) return;
      // Driver's place on the left: seat, a binnacle under the screen and a large, flat wheel.
      const dark = mt.interior(2, hex(0x1c1d20)), e = [0.8, 1.95, 4.4];
      box(skC, mt.interior(0, hex(0x2a4a6a)), [e[0], 1.3, e[2] - 0.05], [0.25, 0.06, 0.24], {}); box(skC, mt.interior(0, hex(0x2a4a6a)), [e[0], 1.68, e[2] - 0.3], [0.25, 0.36, 0.05], {});
      box(skC, dark, [0, 1.16, a[2] - 0.22], [hw - 0.1, 0.14, 0.1], { skip: 'y' });
      if (lv === 0) {
        steeringWheel(skC, [e[0], 1.36, e[2] + 0.36], vec.unit([0, 0.82, -0.57]), lv, dark);
        for (const [xa, xb2] of [[1.0, 0.35], [-0.15, -0.8]]) { const P = (x) => front(belt + 0.07, Math.abs(x)), A = P(xa), B = P(xb2); wiper(skC, [xa, A[1], A[2]], [xb2, B[1], B[2]], [0, A[4], A[5]], [xa, A[1] - 0.06, A[2] + 0.02]); }
      }
    },
  };
};

export const SPECS = [compact, sedanFull, coupe, wagon, pickup, van, taxi, police, sports, bus, truck, sedanMid, policeUnmarked];
