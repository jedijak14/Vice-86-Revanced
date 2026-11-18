// Body builders: turn a vehicle description into shells (see shell.js) with their windows, wheel arches,
// panel gaps and lamp recesses, and emit both halves.
//
// A passenger car is two shells: the lower body from sill to shoulder, and the glasshouse standing on it.
// The lower body's band is the bonnet, cowl and boot lid on top, the nose and tail panels at the ends and
// the floor underneath; over the cabin it is cut away so the interior shows through the glass.

import { roundedPath } from './curve.js';
import { Shell } from './shell.js';
import { m4scaling, m4 } from '../../core/math.js';
import { MeshBuilder } from '../../core/mesh.js';
import * as mt from './materials.js';

/** Tessellation presets for the three levels of detail. */
export const QUALITY = [
  { level: 0, len: 0.11, ang: 0.14, rows: 1, fillet: 3, band: 6, grooves: true, archAng: 0.1 },
  { level: 1, len: 0.34, ang: 0.4, rows: 0.5, fillet: 2, band: 3, grooves: false, archAng: 0.42 },
  { level: 2, len: 1.5, ang: 1.0, rows: 0.01, fillet: 1, band: 1, grooves: false, archAng: 0.85 },
];

const EDGE = 0.025;                         // radius of the shoulder edge between body side and bonnet
const lerp = (a, b, t) => a + (b - a) * t;
/** Piecewise-linear function through points [[z, y]...] sorted by z, held constant outside. */
export function polyline(pts) {
  return (z) => {
    if (z <= pts[0][0]) return pts[0][1];
    for (let k = 1; k < pts.length; k++) if (z <= pts[k][0]) return lerp(pts[k - 1][1], pts[k][1], (z - pts[k - 1][0]) / (pts[k][0] - pts[k - 1][0]));
    return pts[pts.length - 1][1];
  };
}
const meet = (p, d, q, e) => { const den = d[0] * e[1] - d[1] * e[0], t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den; return [p[0] + d[0] * t, p[1] + d[1] * t]; };

/**
 * Lower body of a car or pickup. All heights in p are centre-line heights above the road; the seam the
 * shell is built on lies lower by the shoulder edge radius and the crown of the panels.
 */
export function lowerShell(p) {
  const crown = p.crown ?? 0.02, off = EDGE + crown, bow = p.bow ?? 0.03, Rc = p.cornerR ?? 0.13, wrap = Rc * 0.866;
  // zRear lets a body stop short of the tail (the cab of a lorry); archZ lists the axles it stands over.
  const zF = p.nose - p.standF - bow - 0.004, zR = p.zRear ?? p.tail + p.standR + bow + 0.004;
  const archZ = (p.archZ || [-p.wheelbase / 2, p.wheelbase / 2]).slice().sort((a, b) => a - b);
  const top = [[zR, p.tailTop - off], [p.deckZ, p.deckY - off], [p.cowlZ, p.cowlY - off], [zF, p.hoodFront - off]];
  const bottom = [[zR, p.valanceR], ...archZ.map((z) => [z, p.sillY]), [zF, p.valanceF]];
  const topY = polyline(top), botY = polyline(bottom);
  const outline = roundedPath([
    { a: zR, b: p.valanceR, r: 0.04, tag: 'rb' }, { a: zR, b: top[0][1], r: p.cornerTop ?? 0.022, tag: 'rt' },
    { a: top[1][0], b: top[1][1], r: p.topR ?? 1.2 }, { a: top[2][0], b: top[2][1], r: p.topR ?? 1.2 },
    { a: zF, b: top[3][1], r: p.cornerTop ?? 0.022, tag: 'ft' }, { a: zF, b: p.valanceF, r: 0.04, tag: 'fb' },
    ...archZ.slice().reverse().map((z) => ({ a: z, b: p.sillY, r: 0.5 })),
  ], true);
  const hw = p.W / 2 - 0.006, taperL = 0.6, taper = p.taper ?? 0.05, creaseY = polyline([[zR, p.crease[1]], [zF, p.crease[0]]]), upperY = polyline([[zR, p.upper[1]], [zF, p.upper[0]]]);
  // The top feature line has to clear the shoulder seam, or the rows of the side grid would cross.
  for (const z of [zR, zF]) if (upperY(z) > topY(z) - 0.012) throw new Error(`${p.name}: upper body line ${upperY(z).toFixed(3)} reaches the shoulder seam ${topY(z).toFixed(3)}`);
  const leanU = p.leanU ?? 0.045, curveU = p.curveU ?? 0.22, leanL = p.leanL ?? 0.03, tuck = p.tuck ?? 0.04, flare = p.flare ?? 0;
  const side = (z, y) => {
    let x = hw;
    const tf = (z - (zF - taperL)) / taperL, tr = (zR + taperL - z) / taperL;
    if (tf > 0) x -= taper * tf * tf; if (tr > 0) x -= (p.taperR ?? taper) * tr * tr;
    // The body side itself turns the plan-view corner through sixty degrees; the seam fillet finishes it.
    const df = Math.min(z - (zF - wrap), Rc * 0.93), dr = Math.min(zR + wrap - z, Rc * 0.93);
    if (df > 0) x -= Rc - Math.sqrt(Rc * Rc - df * df); if (dr > 0) x -= Rc - Math.sqrt(Rc * Rc - dr * dr);
    const h = y - creaseY(z), hs = Math.sqrt(h * h + 4e-4), up = (hs + h) / 2, dn = (hs - h) / 2;
    x -= leanU * up + curveU * up * up + leanL * dn;
    const t = Math.min(1.4, (botY(z) + 0.1 - y) / 0.1); if (t > 0) x -= tuck * t * t;
    if (flare) for (const az of archZ) { const d = Math.hypot(z - az, y - p.wheelR) - p.archR; if (d < 0.12) { const k = 1 - Math.max(0, d) / 0.12; x += flare * k * k; } }
    return x;
  };
  const M = p.mats, moulding = p.sillMoulding ? (z) => Math.abs(z) < p.wheelbase / 2 - p.archR - 0.04 : () => false;
  const def = {
    outline, side, endCols: [4, 2, 1],
    fillet: { top: EDGE, front: 0.03, rear: 0.03, bottom: 0.03 }, crown: { top: crown, front: bow, rear: bow, bottom: 0 },
    rows: [{ tag: 'bottom', n: 1 }, { tag: 'sill', y: (z) => botY(z) + 0.065, n: p.rowsLow ? 1 : 3, lod: 1 }, ...(p.rowsLow || []), { tag: 'crease', y: creaseY, n: 2 }, ...(p.rowsHigh || []), { tag: 'upper', y: upperY, n: 1 }],
    cols: [{ tag: 'endR', z: zR + wrap + 0.004 }, { tag: 'endF', z: zF - wrap - 0.004 }, ...p.lowerCols],
    pins: p.lowerPins,
    matSide: (z, y) => (p.livery && p.livery.side(z, y)) || (y < botY(z) + 0.06 && moulding(z) ? mt.chrome : M.body),
    matBand: (x, y, z, chain) => (chain === 3 ? mt.under : (p.livery && p.livery.band(x, y, z)) || M.body),
  };
  const sh = new Shell(def); sh.zF = zF; sh.zR = zR; sh.topSeam = topY; sh.botLine = botY; sh.creaseY = creaseY; sh.upperY = upperY; sh.bow = bow;
  for (const z of archZ) sh.arch({ z, y: p.wheelR + (p.archRise ?? 0), radius: p.archR, lipMat: p.archMoulding ? mt.chrome : null, depth: p.tyreW + 0.14, ...(p.archMoulding ? { band: 0.02 } : null) });
  return sh;
}

/**
 * Glasshouse standing on a lower body. g = p.cabin: { cowlZ, headerF:[z,y], peak:[z,y], headerR:[z,y], baseR:[z, y], roofHalf,
 *   pillars:[{tag, zb, zt, gap, sideGroove}], windows:[{c0, c1, inset, radius, frame}], screen:{...}, backlight:{...} }.
 * Points are on the centre line of the car; the seam is set back from them by the pillar radius and the bow of the glass.
 */
export function cabinShell(p, lower) {
  const g = p.cabin, rRoof = g.roofEdge ?? 0.045, cRoof = g.roofCrown ?? 0.035, rA = 0.03, bowF = g.bowF ?? 0.07, bowR = g.bowR ?? 0.04;
  const offT = rRoof * 0.7 + cRoof, offF = rA * 0.75 + bowF, offR = rA * 0.75 + bowR;
  const baseF = [p.cowlZ, p.cowlY], baseR = g.baseR || [p.deckZ, p.deckY];
  const unit = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  // Front and rear glass lines moved inwards to the seam, and the roof line lowered to it.
  const dF = unit(g.headerF, baseF), dR = unit(baseR, g.headerR), nF = [-dF[1], dF[0]], nR = [-dR[1], dR[0]];
  const fP = [baseF[0] - nF[0] * offF, baseF[1] - nF[1] * offF], rP = [baseR[0] - nR[0] * offR, baseR[1] - nR[1] * offR];
  const pk = [g.peak[0], g.peak[1] - offT], hf = [g.headerF[0], g.headerF[1] - offT], hr = [g.headerR[0], g.headerR[1] - offT];
  const ft = meet(fP, dF, hf, unit(pk, hf)), rt = meet(rP, dR, hr, unit(hr, pk));
  // The glasshouse starts below the shoulder so that its bowed ends still reach under the crowned cowl and deck.
  const belt = (z) => lower.topSeam(z), yb = (z) => belt(z) - 0.06;
  const fb = meet(fP, dF, [baseF[0], yb(baseF[0])], [1, 0]), rb = meet(rP, dR, [baseR[0], yb(baseR[0])], [1, 0]);
  const outline = roundedPath([
    { a: rb[0], b: rb[1], r: 0, tag: 'rb' }, { a: rt[0], b: rt[1], r: g.cornerR ?? 0.22, tag: 'rt' }, { a: pk[0], b: pk[1], r: 2 },
    { a: ft[0], b: ft[1], r: g.cornerF ?? 0.22, tag: 'ft' }, { a: fb[0], b: fb[1], r: 0, tag: 'fb' },
  ], true);
  const roofY = polyline([[rt[0], rt[1]], [pk[0], pk[1]], [ft[0], ft[1]]]);
  const ledge = g.ledge ?? 0.05, base = (z) => lower.def.side(z, belt(z)) - ledge, baseMax = base(0), curve = 0.1;
  const side = (z, y) => { const b = base(z), yB = belt(z), hgt = roofY(z) - yB, top = g.roofHalf - (baseMax - b) * 0.8, h = y - yB; return b - ((b - top) / hgt - curve * hgt) * h - curve * h * h; };
  // The glass starts just above the shoulder along the sides; across the cowl and the rear deck it has to
  // clear the crown of those panels, so the line climbs inside the corner pillars.
  const lift = (p.crown ?? 0.02) + 0.02, ramp = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const sillF = meet(fP, dF, [baseF[0], belt(baseF[0]) + 0.036 + lift], [1, 0])[0], sillR = meet(rP, dR, [baseR[0], belt(baseR[0]) + 0.036 + lift], [1, 0])[0];
  const sillY = (z) => belt(z) + 0.036 + lift * (ramp(sillF - (g.rampF ?? 0.07), sillF - 0.005, z) + ramp(sillR + (g.rampR ?? 0.07), sillR + 0.005, z));
  const footF = meet(fP, dF, [baseF[0], belt(baseF[0])], [1, 0])[0], footR = meet(rP, dR, [baseR[0], belt(baseR[0])], [1, 0])[0];
  const M = p.mats;
  const def = {
    outline, side, endCols: [1, 1, 1], openBottom: true,
    fillet: { top: rRoof, front: rA, rear: rA, bottom: 0 }, crown: { top: cRoof, front: bowF, rear: bowR, bottom: 0 },
    rows: [{ tag: 'bottom', n: 1 }, { tag: 'sill', y: sillY, n: 2 }, { tag: 'header', y: (z) => roofY(z) - (g.headerDrop ?? 0.04), n: 1 }],
    cols: g.pillars.map((c) => (c.fromFront !== undefined ? { ...c, zb: fb[0] - c.fromFront, zt: ft[0] - c.fromFront - (c.lean || 0) } : c.fromRear !== undefined ? { ...c, zb: rb[0] + c.fromRear, zt: rt[0] + c.fromRear + (c.lean || 0) } : c)),
    pins: { screen: { from: { front: 'header' }, to: { front: 'sill' }, x: (F) => F.xB - 0.006 }, backlight: { from: { rear: 'sill' }, to: { rear: 'header' }, x: (F) => F.xB - 0.006 }, ...(g.pins || {}) },
    matSide: (z, y) => (p.livery && p.livery.cabin(0, y, z, true)) || (g.sideMat ? g.sideMat(z, y) : null) || M.roof || M.body,
    matBand: (x, y, z) => (p.livery && p.livery.cabin(x, y, z, false)) || (g.bandMat ? g.bandMat(x, y, z) : null) || M.roof || M.body,
  };
  const sh = new Shell(def); sh.base = base; sh.belt = belt; sh.roofY = roofY; sh.sillY = sillY; sh.footF = footF; sh.footR = footR; sh.fb = fb; sh.ft = ft; sh.rb = rb; sh.rt = rt;
  // The lower body is cut away under the glasshouse, just inside its footprint, so the cabin is open to the interior.
  lower.def.cols.push({ tag: 'deckCut', z: footR + 0.03, lod: 1 }, { tag: 'cowlCut', z: footF - 0.03, lod: 1 });
  lower.def.pins.cabin = { from: { top: 'deckCut' }, to: { top: 'cowlCut' }, x: (F) => base(F.z) - 0.03, lod: 1 };
  lower.bandBlock({ kind: 'cut', from: { top: 'deckCut' }, to: { top: 'cowlCut' }, k0: 'cabin', k1: 'centre', wall: mt.blackTrim, depth: 0.05, lod: 1 });
  const frame = g.frame || mt.chrome;
  for (const w of g.windows) sh.sideWindow({ kind: 'window', r0: 'sill', r1: 'header', inset: 0.016, radius: 0.028, frame, pane: M.sideGlass, far: mt.farGlass, ...w });
  if (g.screen !== null) sh.bandBlock({ kind: 'window', from: { front: 'header' }, to: { front: 'sill' }, k0: 'screen', k1: 'centre', inset: [0.02, 0.014, 0, 0.02], radius: 0.035, frame: g.screenFrame || mt.blackTrim, pane: M.screenGlass, far: mt.farGlass, ...(g.screen || {}) });
  if (g.backlight !== null) sh.bandBlock({ kind: 'window', from: { rear: 'sill' }, to: { rear: 'header' }, k0: 'backlight', k1: 'centre', inset: [0.02, 0.014, 0, 0.02], radius: 0.035, frame: g.screenFrame || mt.blackTrim, pane: M.sideGlass, far: mt.farGlass, ...(g.backlight || {}) });
  for (const b of g.blocks || []) sh.bandBlock(b);
  return sh;
}

/**
 * A plain slab with rounded edges: bus bodies and cargo boxes. o = { z0, z1 (rear and front face), y0, y1 (seam
 * heights), half: number | fn(z, y), lean (how far the front face leans back at the top), edge: { top, front, rear, bottom }
 * fillet radii, crown: { ... }, corner (radius of the roof ends in side view), rows, cols, pins, matSide, matBand, endCols }.
 */
export function slabShell(o) {
  const c = o.corner ?? 0.05, outline = roundedPath([
    { a: o.z0, b: o.y0, r: 0.03, tag: 'rb' }, { a: o.z0, b: o.y1, r: c, tag: 'rt' },
    { a: o.z1 - (o.lean || 0), b: o.y1, r: c, tag: 'ft' }, { a: o.z1, b: o.y0, r: 0.03, tag: 'fb' },
  ], true);
  const side = typeof o.half === 'function' ? o.half : () => o.half;
  const sh = new Shell({ outline, side, endCols: o.endCols || [2, 1, 1], fillet: o.edge, crown: o.crown, rows: [{ tag: 'bottom', n: 1 }, ...(o.rows || [])], cols: o.cols || [], pins: o.pins || {}, matSide: o.matSide, matBand: o.matBand });
  sh.zF = o.z1; sh.zR = o.z0;
  return sh;
}

const MIRROR = m4scaling(m4(), -1, 1, 1);
/** Append a left half and its mirror image; on the mirrored copy left and right indicator lenses change roles. */
export function mirrorInto(target, half) {
  target.append(half);
  const base = target.append(half, MIRROR);
  for (let i = base; i < target.count; i++) { const id = target.mat[i * 4]; if (id === mt.VEHICLE.LAMP_INDICATOR_L) target.mat[i * 4] = mt.VEHICLE.LAMP_INDICATOR_R; }
}

/** Lay out and emit a list of shells for one level of detail. Returns { body, glass } builders holding the left half. */
export function emitShells(shells, q) {
  const body = new MeshBuilder(4096), glass = new MeshBuilder(512);
  for (const s of shells) { s.shell.layout({ ...q, endCols: (s.shell.def.endCols || [1, 1, 1])[q.level] }); s.shell.emit({ body, glass, well: mt.under, liner: q.level < 2 ? s.liner || null : null, linerDepth: 0.022 }); }
  return { body, glass };
}
