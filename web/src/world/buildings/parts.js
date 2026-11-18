// Building parts shared by every archetype and by the landmarks: masses with parapets, eyebrows, balconies, railings,
// canopies, awnings, steps, roofs, roof plant, sign carriers, pools and yard furniture.
//
// Every part takes the Kit first and decides for itself what to emit at the kit's level of detail, so an archetype
// is written once: near gets everything, mid keeps what shapes the silhouette, far keeps the masses only.
// Unless stated, coordinates are in the kit's current frame; parts hung on a wall are called inside `k.onRun(run, ...)`,
// where x runs along the wall from its left end, z points out of the wall and the wall plane is z = 0.

import { FACADE, CHANNEL, SOLID } from '../../core/ids.js';
import { srgbToLinear, clamp } from '../../core/math.js';
import { facadeStyle, FACADE_TYPE, FACADE_LAYOUT } from '../../render/families/facade.js';
import { rectRuns, flat, bounds, shade, mixColor } from './kit.js';
import { GRAVEL } from './palette.js';

export const LAY = FACADE_LAYOUT;
/** Style byte by name: F('DECO', 'CASEMENT', true). */
export const F = (id, type = 0, flag = false) => facadeStyle(FACADE[id], typeof type === 'string' ? FACADE_TYPE[id][type] : type, flag);
const lin3 = (c) => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
const WHITE = [0.93, 0.93, 0.91], DARK = [0.16, 0.17, 0.18], STEEL = [0.34, 0.36, 0.38];

// ---------------------------------------------------------------- masses
/**
 * A walled volume: FACADE bands on the runs, then either a parapet (outer face as a wall band, inner face, coping,
 * roof deck) or a flat cap, and one collider box. o: { parapet: height, color (parapet face), parapetStyle,
 * skipParapet: [run classes without a parapet face], coping, roof (colour, or null for none), roofKind, seed, collide }.
 * Returns { info (per band, see Kit.walls), roofY, top, x0, x1, z0, z1, runs }.
 */
export function mass(k, runs, y0, bands, o = {}) {
  const info = k.walls(runs, y0, bands), roofY = info.length ? info[info.length - 1].y1 : y0, b = bounds(runs); let top = roofY;
  if (o.parapet > 0) {
    const col = o.color ?? WHITE, st = o.parapetStyle ?? F('BLANK', 'PARAPET'), skip = o.skipParapet;
    k.walls(runs, roofY, [{ h: o.parapet, storey: Math.max(1, o.parapet), grounded: false, spec: (r) => (skip && skip.includes(r.cls) ? null : { style: st, bay: 4, color: col, seed: o.seed }) }]);
    k.parapet(runs, roofY, o.parapet, { color: o.coping ?? shade(col, 1.03), inner: shade(col, 0.88), roof: o.roof ?? GRAVEL, roofKind: o.roofKind, t: o.t });
    top += o.parapet;
  } else if (o.roof !== null) k.roofing(o.roofKind ?? 0, o.roof ?? GRAVEL).occ(1).cap(flat(runs), roofY);
  if (o.collide !== false) k.collide(b.x0, y0, b.z0, b.x1, top, b.z1);
  return { info, roofY, top, runs, ...b };
}
/** Rows of a wall band as [{ y (row base), i }]. */
export const rowsOf = (band) => { const n = Math.max(1, Math.round((band.y1 - band.y0) / band.storey)), out = []; for (let i = 0; i < n; i++) out.push({ y: band.y0 + i * band.storey, i }); return out; };
/** The straight runs of a band whose class is in `classes`, with their bay counts. */
export const runsOf = (band, classes) => band.runs.filter((e) => e.n > 0 && !e.run.curved && classes.includes(e.run.cls));

/**
 * Eyebrows over the window rows of a band. `path`: consecutive runs to sweep a continuous eyebrow along (it turns the
 * corners with them); or, with o.perBay, one short eyebrow over each window of the straight runs in `path`.
 * o: { proj, color (top), lip (edge colour), neon (gas colour or null), under: y of the soffit above the row base,
 * rows: filter (rowIndex) => bool, flicker }.
 */
export function eyebrows(k, band, path, o = {}) {
  if (k.far || !path.length) return;
  const proj = o.proj ?? 0.7, th = o.th ?? 0.1, under = o.under ?? LAY.deco.head + 0.14, top = o.color ?? WHITE, lip = o.lip ?? top;
  for (const row of rowsOf(band)) {
    if (o.rows && !o.rows(row.i)) continue;
    const y = row.y + under;
    if (o.perBay && k.near) {
      for (const e of band.runs) {
        if (!path.includes(e.run) || e.run.curved || e.n < 1) continue;
        const half = 0.5 * clamp(e.bay - 2 * LAY.deco.pier, 0.9, LAY.deco.casementMax) + 0.32;
        k.onRun(e.run, () => { for (let i = 0; i < e.n; i++) { const c = (i + 0.5) * e.bay; k.stucco(top).occ(1).box(c - half, y, 0, c + half, y + th, proj, 'xXYy'); k.stucco(lip).box(c - half, y, 0, c + half, y + th, proj, 'Z'); } });
      }
    } else {
      k.stucco(top).occ(1).ledge(path, y, y + th, proj, { lip, bottom: k.near });
      if (o.neon && (!o.neonRows || o.neonRows(row.i))) for (const r of path) if (!r.curved) k.onRun(r, (len) => k.neon([[0.1, y + th * 0.5, proj + 0.035], [len - 0.1, y + th * 0.5, proj + 0.035]], o.neon, { back: [0, 0, -1], channel: o.flicker ? CHANNEL.FLICKER : CHANNEL.NEON, lights: o.neonLights !== false, radiance: 14 }));
    }
  }
}

// ---------------------------------------------------------------- railings, balconies
/**
 * Metal railing along a 3D polyline at floor level: top rail, intermediate rails and posts. Near level only.
 * o: { color, rails: [fractions of the height], post: spacing, r }.
 */
export function railing(k, pts, h = 1.05, o = {}) {
  if (!k.near || pts.length < 2) return;
  k.steel(o.color ?? WHITE, 0.45, o.rust ?? 25).occ(1);
  const lift = (f) => pts.map((p) => [p[0], p[1] + h * f, p[2]]);
  k.pipe(lift(1), o.r ?? 0.024, 4);
  for (const f of o.rails ?? [0.52, 0.1]) k.pipe(lift(f), 0.014, 3);
  const gap = o.post ?? 1.5;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[2] - a[2]), n = Math.max(1, Math.round(l / gap));
    for (let j = i === 0 ? 0 : 1; j <= n; j++) { const t = j / n, x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t, y = a[1] + (b[1] - a[1]) * t; k.pipe([[x, y, z], [x, y + h, z]], 0.018, 4); }
  }
}
/**
 * A balcony on a wall (call inside onRun): slab x0..x1 projecting `proj` at floor height y, with a guard.
 * guard: 'rail' (metal rails), 'solid' (stucco upstand), 'glass' (dark glass panels under a rail), 'bars' (rail on a low kerb).
 * Mid level keeps the slab and solid guards; far drops everything (the wall shader shades the slab line).
 */
export function balcony(k, x0, x1, y, proj, o = {}) {
  if (k.far) return;
  const th = o.th ?? 0.16, col = o.color ?? WHITE, guard = o.guard ?? 'rail', h = o.h ?? 1.05;
  k.stucco(col, 80).occ(1).box(x0, y - th, 0, x1, y, proj, k.near ? 'xXZYy' : 'xXZY');
  if (guard === 'solid') {
    k.stucco(o.guardColor ?? col, 80).box(x0, y, proj - 0.1, x1, y + h * 0.9, proj, k.near ? 'xXzZY' : 'xXZY');
    if (k.near && o.sides !== false) { k.box(x0, y, 0, x0 + 0.1, y + h * 0.9, proj - 0.1, 'xXY'); k.box(x1 - 0.1, y, 0, x1, y + h * 0.9, proj - 0.1, 'xXY'); }
  } else if (k.near) {
    if (guard === 'glass') { k.glass(o.glass ?? [0.2, 0.3, 0.32], 0.08).box(x0 + 0.03, y + 0.08, proj - 0.035, x1 - 0.03, y + h - 0.06, proj - 0.015, 'zZ'); }
    const path = [[x0 + 0.03, y, 0], [x0 + 0.03, y, proj - 0.03], [x1 - 0.03, y, proj - 0.03], [x1 - 0.03, y, 0]];
    railing(k, o.sides === false ? path.slice(1, 3) : path, h, { color: o.rail ?? WHITE, rails: guard === 'glass' ? [] : o.rails, post: o.post ?? 1.6 });
  }
}

// ---------------------------------------------------------------- canopies, awnings, steps, doors
/**
 * A flat canopy slab on a wall (inside onRun): x0..x1, underside at y, reaching `depth` out, front corners rounded
 * by o.r. o: { th, color (top), lip (fascia colour), neon (gas colour), neonAt: 'top' | 'bottom' | 'both', lamps: n soffit
 * lamps, lampColor }. Returns the fascia top height.
 */
export function canopy(k, x0, x1, y, depth, o = {}) {
  const th = o.th ?? 0.3, r = o.r ?? 0, top = o.color ?? WHITE;
  if (k.far && !o.far) return y + th;
  const runs = rectRuns(x0, o.z0 ?? 0, x1, depth, [r, r, 0, 0], k.arc);
  k.stucco(top, 70).occ(1).slab(runs, y, y + th, { bottom: true, under: 0.45, lip: o.lip ?? top, skip: o.z0 ? null : ['back'] });
  if (o.neon && !k.far) {
    // the tube follows the fascia from the wall, round the front and back to the wall
    const path = [], ins = 0.03, back = [0, 0, -1], edge = rectRuns(x0 - ins, 0, x1 + ins, depth + ins, [r + ins, r + ins, 0, 0], k.arc);
    for (const cls of ['left', 'fl', 'front', 'fr', 'right']) { const run = edge.find((e) => e.cls === cls); if (run) for (const q of run.pts) { const l = path[path.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-4) path.push(q); } }
    path[0] = [path[0][0], 0.06]; path[path.length - 1] = [path[path.length - 1][0], 0.06];
    for (const f of o.neonAt === 'both' ? [0.82, 0.18] : o.neonAt === 'top' ? [0.8] : [0.25]) k.neon(path.map((p) => [p[0], y + th * f, p[1]]), o.neon, { back, channel: o.flicker ? CHANNEL.FLICKER : CHANNEL.NEON, radiance: o.radiance ?? 15 });
  }
  if (o.lamps && !k.far) for (let i = 0; i < o.lamps; i++) k.lamp(x0 + (x1 - x0) * (i + 0.5) / o.lamps, y, depth * 0.5, o.lampColor ?? [1, 0.86, 0.62], { power: o.lampPower ?? 26, radius: 8, channel: CHANNEL.STREET, radiance: 9, glow: 0.45 });
  return y + th;
}
/**
 * A fabric awning on a wall (inside onRun): fixed along y at the wall, sloping down by `drop` over `proj`, with a
 * valance. pattern: FABRIC stripe pattern. Far level: nothing.
 */
export function awning(k, x0, x1, y, o = {}) {
  if (k.far) return;
  const proj = o.proj ?? 1.2, drop = o.drop ?? 0.55, val = o.valance ?? 0.22, c = o.color ?? [0.1, 0.5, 0.75], ye = y - drop;
  k.fabric(c, o.pattern ?? 0, 0).occ(1);
  const uvTop = [x0, 0, x1, 0, x1, Math.hypot(proj, drop), x0, Math.hypot(proj, drop)];
  if (k.near) {
    k.sheet([x0, ye, proj], [x1, ye, proj], [x1, y, 0.02], [x0, y, 0.02], uvTop, 0.55);
    k.sheet([x0, ye - val, proj], [x1, ye - val, proj], [x1, ye, proj], [x0, ye, proj], [x0, 0, x1, 0, x1, val, x0, val], 0.7);
    for (const [x, s] of [[x0, -1], [x1, 1]]) { const a = [x, ye, proj], b = [x, y, 0.02], w = [x, ye, 0.02]; if (s > 0) k.leaf(a, w, b); else k.leaf(a, b, w); }
    k.steel(DARK, 0.5, 30).pipe([[x0, ye, 0.02], [x0, ye, proj]], 0.012, 3).pipe([[x1, ye, 0.02], [x1, ye, proj]], 0.012, 3);
  } else { k.quad([x0, ye, proj], [x1, ye, proj], [x1, y, 0.02], [x0, y, 0.02], uvTop); k.quad([x0, ye - val, proj], [x1, ye - val, proj], [x1, ye, proj], [x0, ye, proj]); }
}
/**
 * Steps down from a platform edge at z = z0 (height H) towards +z, between x0 and x1. n treads; returns the z where
 * the flight lands. Near and mid (mid: one sloping block).
 */
export function steps(k, x0, x1, z0, H, o = {}) {
  const tread = o.tread ?? 0.32, n = o.n ?? Math.max(1, Math.round(H / 0.16) - 1), rise = H / (n + 1), col = o.color ?? [0.74, 0.72, 0.68];
  if (k.far) return z0 + n * tread;
  k.tile(col, 30, 2).occ(1);
  if (k.near) for (let i = 0; i < n; i++) k.box(x0, 0, z0 + i * tread, x1, H - (i + 1) * rise, z0 + (i + 1) * tread, 'xXZY');
  else { k.quad([x0, 0, z0 + n * tread], [x1, 0, z0 + n * tread], [x1, H, z0], [x0, H, z0]); k.tri3([x0, 0, z0], [x0, 0, z0 + n * tread], [x0, H, z0]); k.tri3([x1, 0, z0 + n * tread], [x1, 0, z0], [x1, H, z0]); }
  return z0 + n * tread;
}
/** Round or square column from y0 to y1 with a base and a cap block at the near level. */
export function column(k, x, z, y0, y1, r, o = {}) {
  if (k.far) return;
  const col = o.color ?? WHITE;
  k.stucco(col, 70).occ(1);
  if (o.square) k.box(x - r, y0, z - r, x + r, y1, z + r, 'xXzZ'); else k.cyl(x, y0, z, r, y1, { cap: false, segs: k.near ? (o.segs ?? 10) : 5, r1: o.r1 });
  if (k.near && o.blocks !== false) { const e = r + 0.05; k.stucco(o.trim ?? col, 70).box(x - e, y0, z - e, x + e, y0 + 0.14, z + e, 'xXzZY').box(x - e, y1 - 0.12, z - e, x + e, y1, z + e, 'xXzZy'); }
}
/**
 * An entrance on a wall (inside onRun): surround, glazed double doors with pulls, a threshold. The painted wall behind
 * stays; this is the part that makes the door read as a door from the pavement. Near level only.
 */
export function doorway(k, x, y, w, h, o = {}) {
  if (!k.near) return;
  const f = o.frame ?? [0.75, 0.76, 0.78], t = 0.09, d = 0.1;
  if (o.metal === false) k.paint(f, 0.5, 40); else k.bare(1, 0.35);
  k.occ(1).box(x - w / 2 - t, y, 0, x - w / 2, y + h + t, d, 'xXZY').box(x + w / 2, y, 0, x + w / 2 + t, y + h + t, d, 'xXZY').box(x - w / 2, y + h, 0, x + w / 2, y + h + t, d, 'ZYy');
  if (o.transom) k.box(x - w / 2, y + h - o.transom - 0.05, 0, x + w / 2, y + h - o.transom, d * 0.8, 'ZYy');
  const leaves = o.leaves ?? (w > 1.4 ? 2 : 1), lw = w / leaves, top = y + h - (o.transom ? o.transom + 0.05 : 0);
  for (let i = 0; i < leaves; i++) {
    const a = x - w / 2 + i * lw, b = a + lw;
    k.glass(o.glass ?? [0.08, 0.11, 0.12], 0.05).occ(0.8).box(a + 0.06, y + 0.12, 0, b - 0.06, top - 0.06, 0.035, 'Z');
    if (o.metal === false) k.paint(f, 0.5, 40); else k.bare(1, 0.35);
    k.occ(1).box(a + 0.01, y + 0.02, 0, a + 0.06, top, 0.05, 'xXZ').box(b - 0.06, y + 0.02, 0, b - 0.01, top, 0.05, 'xXZ').box(a + 0.06, y + 0.02, 0, b - 0.06, y + 0.12, 0.05, 'ZY').box(a + 0.06, top - 0.06, 0, b - 0.06, top, 0.05, 'Zy');
    const hx = leaves === 2 ? (i === 0 ? b - 0.12 : a + 0.12) : b - 0.14;
    k.bare(3, 0.3).pipe([[hx, y + 0.85, 0.05], [hx, y + 0.85, 0.1], [hx, y + 1.25, 0.1], [hx, y + 1.25, 0.05]], 0.012, 4);
  }
}

// ---------------------------------------------------------------- roofs
/**
 * Hipped roof over x0..x1, z0..z1 from eaves height y. o: { pitch (rise / run), over (eaves overhang), kind (ROOF
 * kind), color, fascia }. Gables instead of hips on the short ends with o.gable (then gable walls use o.gableSpec, a
 * FACADE spec, or stucco of o.wall). Returns the ridge height.
 */
export function pitchedRoof(k, x0, z0, x1, z1, y, o = {}) {
  // far: no overhang, the roof sits on the walls (a touch steeper) and nothing is ever seen from below
  const full = o.over ?? 0.5, over = k.far ? 0 : full, pitch = o.pitch ?? 0.42, X0 = x0 - over, X1 = x1 + over, Z0 = z0 - over, Z1 = z1 + over, w = X1 - X0, d = Z1 - Z0;
  const alongX = w >= d, half = Math.min(w, d) / 2, rise = (half - over + full) * pitch,          // the ridge is the same height at every level
    yr = y + rise, sl = Math.hypot(half, rise), fh = o.fascia ?? 0.14, ye = y;
  const col = o.color ?? [0.71, 0.33, 0.23], kind = o.kind ?? 1, hip = o.gable ? 0 : half;
  // a gable wall rises to the underside of the rake overhang when there is one, to the roof itself when there is not
  const barge = !hip && over > 0.05, ga = yr - (barge ? fh : 0), ge = barge ? Math.max(0, over * pitch - fh) : over * pitch;
  // soffit and fascia all round; on a gabled roof the end fascias sit in the gable plane and close the slot under the gable
  if (!k.far && over > 0.05) {
    const gx = !hip && alongX ? over : 0, gz = !hip && !alongX ? over : 0, eaves = rectRuns(X0 + gx, Z0 + gz, X1 - gx, Z1 - gz);
    k.paint(o.eaves ?? WHITE, 0.6, 60).occ(0.5).cap([[X0 + gx, Z1 - gz], [X1 - gx, Z1 - gz], [X1 - gx, Z0 + gz], [X0 + gx, Z0 + gz]], ye - fh, true);
    k.occ(1).sides(eaves, ye - fh, ye);
  }
  k.roofing(kind, col, o.wear ?? 110).occ(1);
  if (alongX) {
    const zc = (Z0 + Z1) / 2, r0 = X0 + hip, r1 = X1 - hip;
    k.quad([X0, ye, Z1], [X1, ye, Z1], [r1, yr, zc], [r0, yr, zc], [X0, 0, X1, 0, r1, sl, r0, sl]);
    k.quad([X1, ye, Z0], [X0, ye, Z0], [r0, yr, zc], [r1, yr, zc], [-X1, 0, -X0, 0, -r0, sl, -r1, sl]);
    if (hip > 0) { k.tri3([X1, ye, Z1], [X1, ye, Z0], [r1, yr, zc], [-Z1, 0, -Z0, 0, -zc, sl]); k.tri3([X0, ye, Z0], [X0, ye, Z1], [r0, yr, zc], [Z0, 0, Z1, 0, zc, sl]); }
    else gables(k, [[X1 - over, ye, Z1 - over], [X1 - over, ye, Z0 + over], [X1 - over, ga, zc]], [[X0 + over, ye, Z0 + over], [X0 + over, ye, Z1 - over], [X0 + over, ga, zc]], o, ge);
  } else {
    const xc = (X0 + X1) / 2, r0 = Z0 + hip, r1 = Z1 - hip;
    k.quad([X1, ye, Z1], [X1, ye, Z0], [xc, yr, r0], [xc, yr, r1], [-Z1, 0, -Z0, 0, -r0, sl, -r1, sl]);
    k.quad([X0, ye, Z0], [X0, ye, Z1], [xc, yr, r1], [xc, yr, r0], [Z0, 0, Z1, 0, r1, sl, r0, sl]);
    if (hip > 0) { k.tri3([X0, ye, Z1], [X1, ye, Z1], [xc, yr, r1], [X0, 0, X1, 0, xc, sl]); k.tri3([X1, ye, Z0], [X0, ye, Z0], [xc, yr, r0], [-X1, 0, -X0, 0, -xc, sl]); }
    else gables(k, [[X0 + over, ye, Z1 - over], [X1 - over, ye, Z1 - over], [xc, ga, Z1 - over]], [[X1 - over, ye, Z0 + over], [X0 + over, ye, Z0 + over], [xc, ga, Z0 + over]], o, ge);
  }
  // gable ends: a barge board down each rake and the underside of the overhang, so the roof has thickness there
  if (barge) {
    k.paint(o.eaves ?? WHITE, 0.6, 60);
    const c = alongX ? (Z0 + Z1) / 2 : (X0 + X1) / 2, P = (end, side, y) => (alongX ? [end, y, side] : [side, y, end]);
    for (const [end, s] of alongX ? [[X0, -1], [X1, 1]] : [[Z0, -1], [Z1, 1]]) for (const side of alongX ? [Z0, Z1] : [X0, X1]) {
      const out = alongX ? [s, 0, 0] : [0, 0, s], inn = end - s * over;
      k.occ(1).quadFacing(P(end, side, ye - fh), P(end, c, yr - fh), P(end, c, yr), P(end, side, ye), out);
      k.occ(0.55).quadFacing(P(end, side, ye - fh), P(end, c, yr - fh), P(inn, c, yr - fh), P(inn, side, ye - fh), [0, -1, 0]);
      k.occ(1).quadFacing(P(end, side, ye - fh), P(inn, side, ye - fh), P(inn, side, ye), P(end, side, ye), alongX ? [0, 0, side - c] : [side - c, 0, 0]);   // the eave fascia carried round the corner
    }
  }
  k.occ(1);
  return yr;
}
function gables(k, a, b, o, e) {
  for (const t of [a, b]) {
    const base = Math.hypot(t[1][0] - t[0][0], t[1][2] - t[0][2]), s = o.gableSpec ? o.gableSpec.storey ?? 3 : 0, rise = t[2][1] - t[0][1];
    const l = [t[0][0], t[0][1] + e, t[0][2]], r = [t[1][0], t[1][1] + e, t[1][2]];
    if (o.gableSpec) k.facade(o.gableSpec, s); else k.stucco(o.wall ?? WHITE);
    if (e > 0) k.quad(t[0], t[1], r, l, [0, s, base, s, base, s + e, 0, s + e]);
    k.tri3(l, r, t[2], [0, s + e, base, s + e, base / 2, s + rise]);
  }
  k.roofing(o.kind ?? 1, o.color ?? [0.71, 0.33, 0.23], o.wear ?? 110);
}

/**
 * Roof furniture inside the rectangle x0..x1, z0..z1 at roof level y, placed from the building seed: a stair core,
 * air-conditioning condensers, vents, sometimes a water tank on legs and a television aerial.
 * o: { core: bool, units: n, tank: bool, aerial: bool, color }. Mid keeps the core and the tank; far nothing.
 */
export function roofPlant(k, x0, z0, x1, z1, y, o = {}) {
  if (k.far) return;
  const w = x1 - x0, d = z1 - z0, col = o.color ?? [0.84, 0.83, 0.8], h = (s) => k.h(0x700 + s + (o.salt ?? 0));
  if (w < 3.2 || d < 3.2) return;
  const side = h(1) < 0.5 ? 0 : 1, cw = Math.min(3.2, w * 0.4), cd = Math.min(4.2, d * 0.4);
  const cx0 = side ? x1 - cw - 0.6 : x0 + 0.6, cz0 = z0 + 0.6 + h(2) * Math.max(0, d * 0.3 - 0.6);
  if (o.core !== false) {
    k.stucco(col, 120).occ(1).box(cx0, y, cz0, cx0 + cw, y + 2.6, cz0 + cd);
    k.roofing(3, [0.4, 0.4, 0.39]);
    if (k.near) { k.steel([0.36, 0.42, 0.45], 0.5, 60).box(cx0 + cw * 0.5 - 0.45, y + 0.05, cz0 + cd, cx0 + cw * 0.5 + 0.45, y + 2.05, cz0 + cd + 0.03, 'xXZY'); }
  }
  if (o.tank && d > 7 && w > 7) {
    const tx = side ? x0 + 2.2 : x1 - 2.2, tz = z0 + 2.2 + h(3) * 1.5, r = 1.15;
    if (k.near) { k.steel(STEEL, 0.6, 90); for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.pipe([[tx + sx * r * 0.7, y, tz + sz * r * 0.7], [tx + sx * r * 0.7, y + 1.6, tz + sz * r * 0.7]], 0.05, 4); }
    k.paint([0.72, 0.72, 0.68], 0.6, 130).cyl(tx, y + 1.6, tz, r, y + 3.9, { bottom: true, cap: false, segs: k.near ? 12 : 6 }).cyl(tx, y + 3.9, tz, r + 0.05, y + 4.4, { r1: 0.1, segs: k.near ? 12 : 6 });
  }
  if (!k.near) return;
  const n = o.units ?? Math.max(1, Math.min(6, Math.round(w * d / 70)));
  for (let i = 0; i < n; i++) {
    const ux = x0 + 1.2 + h(10 + i) * Math.max(0.1, w - 3.6), uz = z0 + 1.2 + h(20 + i) * Math.max(0.1, d - 3.4), big = h(30 + i) < 0.35, a = big ? 0.9 : 0.5, b = big ? 0.6 : 0.42, uh = big ? 1.15 : 0.75;
    if (o.core !== false && ux + a > cx0 - 0.3 && ux - a < cx0 + cw + 0.3 && uz + b > cz0 - 0.3 && uz - b < cz0 + cd + 0.3) continue;
    k.steel([0.74, 0.75, 0.74], 0.55, 50).occ(1).box(ux - a, y + 0.12, uz - b, ux + a, y + uh, uz + b);
    k.solid(SOLID.DARK_GLASS, [0.05, 0.05, 0.05], 200, 0).cyl(ux, y + uh, uz, Math.min(a, b) * 0.75, y + uh + 0.02, { segs: 8 });
    k.concrete([0.6, 0.6, 0.58]).box(ux - a - 0.05, y, uz - b - 0.05, ux + a + 0.05, y + 0.12, uz + b + 0.05);
  }
  for (let i = 0; i < 2 + Math.round(h(40) * 3); i++) { const vx = x0 + 0.9 + h(50 + i) * (w - 1.8), vz = z0 + 0.9 + h(60 + i) * (d - 1.8); k.bare(2, 0.55).cyl(vx, y, vz, 0.09, y + 0.55, { segs: 6, cap: false }).cyl(vx, y + 0.55, vz, 0.16, y + 0.68, { segs: 6, r1: 0.05 }); }
  if (o.aerial ?? h(70) < 0.6) aerial(k, cx0 + cw * 0.5, y + (o.core !== false ? 2.6 : 0), cz0 + cd * 0.5, 2.2 + h(71) * 1.6);
}
/** A television aerial: mast with a boom and cross elements. Near only. */
export function aerial(k, x, y, z, h = 3) {
  if (!k.near) return;
  k.bare(1, 0.4).occ(1).pipe([[x, y, z], [x, y + h, z]], 0.02, 4).pipe([[x - 0.7, y + h - 0.15, z], [x + 0.7, y + h - 0.15, z]], 0.012, 3);
  for (let i = 0; i < 5; i++) { const ex = x - 0.6 + i * 0.3, l = 0.5 - i * 0.07; k.pipe([[ex, y + h - 0.15, z - l], [ex, y + h - 0.15, z + l]], 0.007, 3); }
}
/** A whip or lattice mast with an aviation lamp on top (towers). Kept as a thin pole at mid; the lamp glow survives far. */
export function mast(k, x, y, z, h, o = {}) {
  if (!k.far) { k.steel(o.color ?? [0.85, 0.2, 0.15], 0.5, 40).occ(1).cyl(x, y, z, o.r ?? 0.12, y + h, { segs: k.near ? 6 : 3, r1: (o.r ?? 0.12) * 0.4, cap: false }); if (k.near && h > 8) { k.steel([0.9, 0.9, 0.9], 0.5, 40).cyl(x, y + h * 0.33, z, (o.r ?? 0.12) * 0.86, y + h * 0.66, { segs: 6, r1: (o.r ?? 0.12) * 0.62, cap: false }); } }
  beacon(k, x, y + h + 0.1, z);
}
/** Red aviation obstruction lamp: lens, light and glow in one place, on the AVIATION channel. The glow survives at every level. */
export function beacon(k, x, y, z) {
  if (k.near) k.lens([1, 0.1, 0.06], 40, CHANNEL.AVIATION).cyl(x, y - 0.1, z, 0.11, y + 0.14, { segs: 6 });
  k.light(x, y + 0.2, z, [9, 0.5, 0.25], 8, CHANNEL.AVIATION);
  k.glow(x, y + 0.05, z, 1.6, [22, 1.2, 0.6], CHANNEL.AVIATION, 0, true);
}

// ---------------------------------------------------------------- sign carriers
/**
 * Vertical blade sign standing off a wall (inside onRun): a slim double-faced box from y0 to y1 at x, projecting
 * from z0 by `proj`, with brackets, the name stacked on both faces and a neon outline. Returns nothing.
 * o: { category, variant, color (body), neon, thick, lit }.
 */
export function bladeSign(k, x, y0, y1, z0, o = {}) {
  if (k.far) return;
  const proj = o.proj ?? 1.3, t = o.thick ?? 0.34, body = o.color ?? [0.2, 0.3, 0.45], h = y1 - y0, gap = o.gap ?? 0.25;
  k.steel(body, 0.45, 30).occ(1).box(x - t / 2, y0, z0 + gap, x + t / 2, y1, z0 + gap + proj, 'xXzZYy');
  if (k.near && gap > 0.05) { k.steel(STEEL, 0.5, 50); for (const f of [0.12, 0.5, 0.88]) k.box(x - 0.04, y0 + h * f - 0.04, z0, x + 0.04, y0 + h * f + 0.04, z0 + gap, 'xXYy'); }
  for (const s of [1, -1]) k.at(x + s * (t / 2 + 0.012), 0, z0 + gap + proj / 2, s * Math.PI / 2, () => {
    k.sign(o.category ?? 'hotel-blade', o.variant ?? 0, 0, (y0 + y1) / 2, 0, { maxWidth: proj - 0.16, maxHeight: h - 0.3, height: h - 0.3, lit: o.lit, light: s > 0 });
    if (o.neon && o.lit !== false) { const a = proj / 2 - 0.05; k.neon([[-a, y0 + 0.06, 0.03], [a, y0 + 0.06, 0.03], [a, y1 - 0.06, 0.03], [-a, y1 - 0.06, 0.03]], o.neon, { closed: true, back: [0, 0, -1], lights: s > 0, channel: o.flicker ? CHANNEL.FLICKER : CHANNEL.NEON }); }
  });
}
/**
 * A sign on an open steel frame standing on a roof or canopy (current frame): face on the plane z, centred on x,
 * bottom at y + leg. o: { category, variant, height, maxWidth, neon, legs, lit }. Returns { width, height } or null.
 */
export function roofSign(k, x, y, z, o = {}) {
  if (k.far && !o.far) return null;
  const leg = o.leg ?? 0.5, hgt = o.height ?? 1.4;
  const s = k.sign(o.category ?? 'hotel', o.variant ?? 0, x, y + leg + hgt / 2, z, { height: hgt, maxWidth: o.maxWidth, lit: o.lit, double: o.double ?? 0.12, far: o.far, wallColor: o.wallColor });
  if (!s) return null;
  const w = s.width, h = s.height, y0 = y + leg + hgt / 2 - h / 2, y1 = y0 + h;
  if (k.near) {
    k.steel(STEEL, 0.5, 60).occ(1);
    const n = Math.max(2, Math.round(w / 2.2));
    for (let i = 0; i < n; i++) { const px = x - w / 2 + 0.15 + (w - 0.3) * i / (n - 1); k.box(px - 0.04, y, z - 0.1, px + 0.04, y1, z - 0.02, 'xXzZY'); k.pipe([[px, y, z - 1.0 - h * 0.25], [px, y0 + h * 0.75, z - 0.08]], 0.025, 4); }
    k.box(x - w / 2, y0 - 0.04, z - 0.11, x + w / 2, y0, z + 0.0, 'xXzZy').box(x - w / 2, y1, z - 0.11, x + w / 2, y1 + 0.04, z + 0.0, 'xXzZY');
  }
  if (o.neon && s.entry.lit !== false && o.lit !== false && !k.far) k.neon([[x - w / 2 - 0.05, y0 - 0.05, z + 0.03], [x + w / 2 + 0.05, y0 - 0.05, z + 0.03], [x + w / 2 + 0.05, y1 + 0.05, z + 0.03], [x - w / 2 - 0.05, y1 + 0.05, z + 0.03]], o.neon, { closed: true, free: true, back: [0, 0, -1], channel: o.flicker ? CHANNEL.FLICKER : CHANNEL.NEON });
  return s;
}
/**
 * A free-standing pylon sign (current frame) at x, z: one or two posts carrying a double-faced box sign whose faces
 * look along +z and -z. o: { height (to the top), category, variant, signHeight, maxWidth, color, neon, posts }.
 */
export function pylonSign(k, x, z, o = {}) {
  const H = o.height ?? 7, sh = o.signHeight ?? 1.6, t = 0.36, body = o.color ?? [0.85, 0.85, 0.82];
  k.collide(x - 0.2, 0, z - 0.2, x + 0.2, H - sh, z + 0.2);
  // far away the pylon is still part of the roadside silhouette: a post and a blank panel in the cabinet colour
  if (k.far) { const w = (o.maxWidth ?? 4.5) * 0.8; k.steel(body, 0.45, 40).occ(1).box(x - w / 2, H - sh, z - t / 2, x + w / 2, H - sh * 0.15, z + t / 2, 'xXzZY').box(x - 0.16, 0, z - 0.16, x + 0.16, H - sh, z + 0.16, 'xXzZ'); return; }
  const e = k.sign(o.category ?? 'motel', o.variant ?? 0, x, H - sh / 2, z + t / 2 + 0.012, { height: sh, maxWidth: o.maxWidth ?? 4.5, lit: o.lit });
  if (!e) return;
  k.at(x, 0, z - t / 2 - 0.012, Math.PI, () => k.sign(o.category ?? 'motel', o.variant ?? 0, 0, H - sh / 2, 0, { height: e.height, maxWidth: e.width, lit: o.lit, light: false }));
  const w = e.width, y0 = H - sh / 2 - e.height / 2 - 0.08, y1 = H - sh / 2 + e.height / 2 + 0.08;
  k.steel(body, 0.45, 40).occ(1).box(x - w / 2 - 0.08, y0, z - t / 2, x + w / 2 + 0.08, y1, z + t / 2, 'xXzZYy');
  k.steel(o.post ?? STEEL, 0.5, 50);
  if ((o.posts ?? 2) === 2 && w > 1.6) { for (const s of [-1, 1]) k.box(x + s * w * 0.32 - 0.09, 0, z - 0.09, x + s * w * 0.32 + 0.09, y0, z + 0.09, 'xXzZ'); }
  else k.cyl(x, 0, z, 0.16, y0, { cap: false, segs: k.near ? 8 : 4 });
  if (o.neon && o.lit !== false) for (const s of [1, -1]) k.neon([[x - w / 2, y0 + 0.04, z + s * (t / 2 + 0.03)], [x + w / 2, y0 + 0.04, z + s * (t / 2 + 0.03)], [x + w / 2, y1 - 0.04, z + s * (t / 2 + 0.03)], [x - w / 2, y1 - 0.04, z + s * (t / 2 + 0.03)]], o.neon, { closed: true, back: [0, 0, -s], lights: s > 0 });
}
/** A fascia or wall sign flush on a wall (inside onRun) with an optional neon underline. */
export function wallSign(k, category, variant, x, y, o = {}) {
  if (k.far && !o.far) return null;
  const s = k.sign(category, variant, x, y, o.z ?? 0.03, o);
  if (s && o.neon && !k.far && s.entry.lit !== false && o.lit !== false) k.neon([[x - s.width / 2, y - s.height / 2 - 0.1, (o.z ?? 0.03) + 0.04], [x + s.width / 2, y - s.height / 2 - 0.1, (o.z ?? 0.03) + 0.04]], o.neon, { back: [0, 0, -1], lights: false });
  return s;
}

// ---------------------------------------------------------------- yard
/** A swimming pool with a raised deck (current frame): deck x0..x1, z0..z1, 0.16 high, water set in by `rim`. */
export function pool(k, x0, z0, x1, z1, o = {}) {
  if (k.far) return;
  const rim = o.rim ?? 1.3, H = 0.16, r = o.r ?? 0.9, deck = o.deck ?? [0.80, 0.76, 0.68];
  const outer = rectRuns(x0, z0, x1, z1), inner = rectRuns(x0 + rim, z0 + rim, x1 - rim, z1 - rim, r, k.arc), ip = flat(inner), op = flat(outer);
  k.tile(deck, 40, o.pattern ?? 0).occ(1).sides(outer, 0.0, H);
  // deck ring: every inner edge fans to its nearest deck corner; one triangle per deck edge closes the gap between fans
  const CORNER = { fl: 0, front: 1, fr: 1, right: 2, br: 2, back: 3, bl: 3, left: 0 }, O = (c) => [op[c][0], H, op[c][1]], uv3 = (a, b, c) => [a[0], -a[2], b[0], -b[2], c[0], -c[2]];
  for (const run of inner) {
    const c = CORNER[run.cls];
    if (!run.curved) { const a = O((c + 3) % 4), b = O(c), q = [run.pts[0][0], H, run.pts[0][1]]; k.tri3(a, b, q, uv3(a, b, q)); }
    for (let i = 0; i < run.pts.length - 1; i++) { const a = O(c), b = [run.pts[i + 1][0], H, run.pts[i + 1][1]], q = [run.pts[i][0], H, run.pts[i][1]]; k.tri3(a, b, q, uv3(a, b, q)); }
  }
  k.tile([0.55, 0.78, 0.82], 15, 0).occ(0.8); for (const run of inner) for (let i = 0; i < run.pts.length - 1; i++) { const a = run.pts[i], b = run.pts[i + 1]; k.quad([b[0], 0.05, b[1]], [a[0], 0.05, a[1]], [a[0], H, a[1]], [b[0], H, b[1]]); }
  k.solid(SOLID.POOL_WATER, o.water ?? [0.25, 0.76, 0.79], 16, 0).occ(1).cap(ip, 0.06);
  if (k.near) { const c = lin3([0.5, 0.9, 1.0]); k.light((x0 + x1) / 2, 1.2, (z0 + z1) / 2, [c[0] * 5, c[1] * 5, c[2] * 5], 9, CHANNEL.STREET); k.glow((x0 + x1) / 2, 0.1, (z0 + z1) / 2, Math.min(x1 - x0, z1 - z0) * 0.5, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], CHANNEL.STREET, 2); }
}
/** Painted parking bay lines on the lot surface (near only): bays of `pitch` along x between x0 and x1, lines from z0 to z1. */
export function bayLines(k, x0, x1, z0, z1, pitch = 2.7, o = {}) {
  if (!k.near) return;
  const n = Math.max(1, Math.round((x1 - x0) / pitch)), y = o.y ?? 0.03;
  k.paint(o.color ?? [0.86, 0.86, 0.82], 0.8, 150).occ(1);
  for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n; k.quad([x - 0.05, y, z1], [x + 0.05, y, z1], [x + 0.05, y, z0], [x - 0.05, y, z0]); }
  if (o.stops) { k.concrete([0.7, 0.69, 0.66]); for (let i = 0; i < n; i++) { const x = x0 + (x1 - x0) * (i + 0.5) / n, z = o.stops; k.box(x - 0.85, y, z - 0.08, x + 0.85, y + 0.12, z + 0.08); } }
}
/**
 * A garden or yard wall along axis-aligned segments (current frame). pts: [[x, z], ...] polyline; gaps are made by
 * calling it once per stretch. o: { h, t, color, coping, piers: spacing, style: 'stucco' | 'block' | 'rail' }.
 */
export function yardWall(k, pts, o = {}) {
  const h = o.h ?? 1.8, t = o.t ?? 0.2, col = o.color ?? WHITE;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], horiz = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    const x0 = Math.min(a[0], b[0]) - (horiz ? 0 : t / 2), x1 = Math.max(a[0], b[0]) + (horiz ? 0 : t / 2), z0 = Math.min(a[1], b[1]) - (horiz ? t / 2 : 0), z1 = Math.max(a[1], b[1]) + (horiz ? t / 2 : 0);
    k.collide(x0, 0, z0, x1, h, z1);
    if (k.far) continue;                                   // too low to show in the far silhouette, but still solid
    if (o.style === 'rail') { k.stucco(col, 90).occ(1).box(x0, 0, z0, x1, 0.5, z1); railing(k, [[a[0], 0.5, a[1]], [b[0], 0.5, b[1]]], h - 0.5, { color: o.rail ?? DARK, rails: [0.08, 0.3, 0.52, 0.76], post: 2.4 }); }
    else { if (o.style === 'block') k.concrete(col, 4, 110); else k.stucco(col, 110); k.occ(1).box(x0, 0, z0, x1, h, z1); }
    if (k.near && o.piers) { const l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(l / o.piers)); k.stucco(o.coping ?? col, 90);
      for (let j = 0; j <= n; j++) { const px = a[0] + (b[0] - a[0]) * j / n, pz = a[1] + (b[1] - a[1]) * j / n, e = t / 2 + 0.07; k.box(px - e, 0, pz - e, px + e, h + 0.18, pz + e); } }
  }
}
/** A window air-conditioner hanging out of a wall (inside onRun) at x, base y. Near only. */
export function windowUnit(k, x, y) {
  if (!k.near) return;
  k.steel([0.78, 0.77, 0.72], 0.55, 70).occ(1).box(x - 0.33, y, 0, x + 0.33, y + 0.42, 0.36, 'xXZYy');
  k.solid(SOLID.DARK_GLASS, [0.06, 0.06, 0.06], 220, 0).box(x - 0.27, y + 0.06, 0.36, x + 0.27, y + 0.36, 0.365, 'Z');
}
/** Scatter window units over the rows of a band on the given run classes; `share` of the windows get one. */
export function windowUnits(k, band, classes, share, sillY = LAY.deco.sill) {
  if (!k.near) return;
  for (const e of runsOf(band, classes)) k.onRun(e.run, () => { for (const row of rowsOf(band)) for (let i = 0; i < e.n; i++) if (k.h(0x900 + row.i * 131 + i * 7 + Math.round(e.run.pts[0][0] * 3 + e.run.pts[0][1] * 5)) < share) windowUnit(k, (i + 0.5) * e.bay + (k.h(i + row.i * 17) - 0.5) * 0.3, row.y + sillY - 0.02); });
}
export { WHITE, DARK, STEEL, mixColor, shade };

/**
 * Wall spec chooser by run class. map: { front, back, left, right, <any class>, default }; a side with a neighbour
 * against it (lot.attached) becomes the blank party wall `party` instead.
 */
export function bySide(map, att, party) {
  return (r) => {
    const c = r.cls, side = c === 'left' || c === 'lret' || c === 'bl' ? 'left' : c === 'right' || c === 'rret' || c === 'br' ? 'right' : c === 'back' ? 'back' : null;
    if (side && att && att[side] && party) return party;
    return c in map ? map[c] : map.default;
  };
}
/** Straight flight of stairs with stringers and a rail (current frame): from (x, y0, z0) rising to y1 over the run towards +x or -x. Near and mid. */
export function flight(k, x0, x1, z0, z1, y0, y1, o = {}) {
  if (k.far) return;
  const n = Math.max(2, Math.round((y1 - y0) / 0.18)), col = o.color ?? [0.7, 0.7, 0.68];
  k.concrete(col, 0, 80).occ(1);
  if (k.near) { for (let i = 0; i < n; i++) { const a = x0 + (x1 - x0) * i / n, b = x0 + (x1 - x0) * (i + 1) / n, y = y0 + (y1 - y0) * (i + 1) / n; k.box(Math.min(a, b), y - 0.06, z0, Math.max(a, b), y, z1, 'xXzZYy'); } }
  else { const lo = [x0, y0, 0], hi = [x1, y1, 0]; if (x1 > x0) k.sheet([lo[0], y0, z1], [hi[0], y1, z1], [hi[0], y1, z0], [lo[0], y0, z0]); else k.sheet([hi[0], y1, z1], [lo[0], y0, z1], [lo[0], y0, z0], [hi[0], y1, z0]); }
  if (k.near) { k.steel(o.rail ?? WHITE, 0.5, 40); for (const z of [z0 + 0.03, z1 - 0.03]) { k.pipe([[x0, y0 + 0.95, z], [x1, y1 + 0.95, z]], 0.022, 4).pipe([[x0, y0 + 0.5, z], [x1, y1 + 0.5, z]], 0.014, 3).pipe([[x0, y0, z], [x0, y0 + 0.95, z]], 0.018, 4).pipe([[x1, y1, z], [x1, y1 + 0.95, z]], 0.018, 4).pipe([[x0, y0 + 0.05, z], [x1, y1 - 0.08, z]], 0.05, 4); } }
}
/** A thin slab whose top rises from ya at x0 to yb at x1 (current frame): canted canopies and folded roofs. Near and mid. */
export function tiltSlab(k, x0, z0, x1, z1, ya, yb, th = 0.2) {
  if (k.far) return;
  const A = [x0, ya, z1], B = [x1, yb, z1], C = [x1, yb, z0], E = [x0, ya, z0], dn = (p) => [p[0], p[1] - th, p[2]];
  k.occ(1); k.quad(A, B, C, E); k.quad(dn(A), dn(B), B, A); k.quad(dn(C), dn(E), E, C); k.quad(dn(B), dn(C), C, B); k.quad(dn(E), dn(A), A, E);
  k.occ(0.55); k.quad(dn(E), dn(C), dn(B), dn(A)); k.occ(1);
}
/**
 * Balconies up a tower face (run): one slab per floor between xa and xb along the run, with a guard and, near, the
 * dividing fins between rooms. o: { proj, guard: 'solid' | 'glass' | 'rail', color, guardColor, glass, bay, from, to, fins,
 * midEnds: which end faces ('x', 'X') a mid block needs when the other end is buried in the next run's balcony }.
 * Mid keeps slabs and solid guards so the face keeps its ribbed shadow; far relies on the wall shader.
 */
export function balconyRows(k, run, y0, storey, floors, o = {}) {
  if (k.far) return;
  const proj = o.proj ?? 1.5, guard = o.guard ?? 'solid', col = o.color ?? WHITE, th = 0.16, h = 1.05;
  k.onRun(run, (len) => {
    const xa = o.xa ?? 0.15, xb = o.xb != null ? (o.xb <= 0 ? len + o.xb : o.xb) : len - 0.15, bay = o.bay ?? 3.9, nb = Math.max(1, Math.round((xb - xa) / bay));
    for (let f = o.from ?? 1; f < (o.to ?? floors); f++) {
      const y = y0 + f * storey;
      // mid distance: slab and solid guard merge into one closed block, so no face is ever seen from behind
      if (!k.near && guard === 'solid') { k.stucco(o.guardColor ?? col, 70).occ(1).box(xa, y - th, 0, xb, y + h * 0.9, proj, o.fins !== false ? 'ZYy' : (o.midEnds ?? 'xX') + 'ZYy'); continue; }
      k.stucco(col, 70).occ(1).box(xa, y - th, 0, xb, y, proj, 'xXZYy');
      if (guard === 'solid') k.stucco(o.guardColor ?? col, 70).box(xa, y, proj - 0.1, xb, y + h * 0.9, proj, 'xXzZY');
      else if (k.near) {
        if (guard === 'glass') k.glass(o.glass ?? [0.16, 0.26, 0.28], 0.08).box(xa + 0.03, y + 0.08, proj - 0.04, xb - 0.03, y + h - 0.05, proj - 0.02, 'xXzZY');
        k.steel(o.rail ?? WHITE, 0.45, 25).pipe([[xa, y + h, proj - 0.03], [xb, y + h, proj - 0.03]], 0.025, 4);
        if (guard === 'rail') { k.pipe([[xa, y + h * 0.55, proj - 0.03], [xb, y + h * 0.55, proj - 0.03]], 0.014, 3).pipe([[xa, y + h * 0.15, proj - 0.03], [xb, y + h * 0.15, proj - 0.03]], 0.014, 3); for (let i = 0; i <= nb * 2; i++) { const x = xa + (xb - xa) * i / (nb * 2); k.pipe([[x, y, proj - 0.03], [x, y + h, proj - 0.03]], 0.016, 3); } }
      }
      if (k.near && o.fins !== false) { k.stucco(o.finColor ?? col, 70); for (let i = 0; i <= nb; i++) { const x = xa + (xb - xa) * i / nb; k.box(x - 0.07, y, 0, x + 0.07, y + (o.finH ?? storey - th), proj - 0.02, f === (o.to ?? floors) - 1 ? 'xXZY' : 'xXZ'); } }
    }
    // mid distance: the end fins run the whole height as one cheek each, closing the ends of every merged balcony block
    if (!k.near && guard === 'solid' && o.fins !== false) {
      const f0 = o.from ?? 1, f1 = (o.to ?? floors) - 1;
      if (f1 >= f0) { k.stucco(o.finColor ?? col, 70).occ(1); for (const x of [xa, xb]) k.box(x - 0.07, y0 + f0 * storey - th, 0, x + 0.07, y0 + f1 * storey + (o.finH ?? storey - th), proj + 0.01, 'xXZYy'); }
    }
  });
}
