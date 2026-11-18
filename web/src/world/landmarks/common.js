// Shared pieces for the named places: stock buildings placed inside a landmark, civic blocks, yards and roof gear.

import { hashInts } from '../../core/math.js';
import { CHANNEL } from '../../core/ids.js';
import { facadeSeed } from '../../render/families/facade.js';
import { rectRuns, lineRun } from '../buildings/kit.js';
import { withPaint } from '../buildings/palette.js';
import { pickSign } from '../buildings/signs-adapter.js';
import { styleOf } from '../buildings/index.js';
import { F, mass, STEEL, WHITE, yardWall } from '../buildings/parts.js';

export const DEG = Math.PI / 180;
/** FACADE wall spec. */
export const W = (id, type, bay, color, seed, flag = false) => ({ style: F(id, type, flag), bay, color, seed });
/** FACADE seed byte of this landmark for a trim index and an age 0..3. */
export const sb = (k, trim, age = 0) => facadeSeed(trim, age, k.seed >>> 6);

const GENERIC = new Set(['billboard', 'billboard-wide', 'poster', 'parking', 'window', 'notice', 'direction', 'container', 'street-name', 'plate']);
/**
 * Sign renaming for a landmark: every name sign of the stock building shows the landmark's own atlas entry, blade
 * signs its stacked version (none when the atlas has no stacked version), posters and notices stay as they are.
 */
export function nameMap(id) {
  const cat = 'landmark:' + id, main = pickSign(cat, 0), blade = pickSign(cat, 1);
  return (category) => (GENERIC.has(category) ? null : category === 'hotel-blade' ? (blade && blade.vertical ? [cat, 1] : false) : main ? [cat, 0] : null);
}

/**
 * Build a stock archetype inside the landmark at (x, z) turned by yaw. lot: the fields the builder reads (width,
 * depth, floors, variant, ...). o: { x, z, yaw, paint (see withPaint), named: its signs carry the landmark's name, salt }.
 */
export function part(k, build, lot, o = {}) {
  const x = o.x ?? 0, z = o.z ?? 0;
  const sub = { id: k.lot.id, district: k.lot.district, style: styleOf(k.lot.district), floors: 1, seed: hashInts(k.lot.seed, Math.round(x * 4), Math.round(z * 4), o.salt | 0), ...lot };
  const keep = [k.seed, k.sb, k.signMap, k.lot];
  k.seed = sub.seed >>> 0; k.sb = k.seed & 255; k.lot = sub; if (!o.named) k.signMap = null;
  let out;
  try { k.at(x, 0, z, o.yaw ?? 0, () => { out = o.paint ? withPaint(o.paint, () => build(k, sub)) : build(k, sub); }); }
  finally { [k.seed, k.sb, k.signMap, k.lot] = keep; }
  return out;
}

/**
 * A plain civic block: a ground storey and upper storeys of FACADE wall under a parapet roof.
 * o: { floors, ground (height), storey, wall, groundSpec, upperSpec (spec or (run) => spec), parapet, coping, roof, roofKind, y0, r }.
 */
export function block(k, x0, z0, x1, z1, o) {
  const G = o.ground ?? 4.2, st = o.storey ?? 3.4, up = Math.max(0, (o.floors ?? 2) - 1), fn = (s) => (typeof s === 'function' ? s : () => s);
  const bands = [{ h: G, storey: G, grounded: (o.y0 ?? 0) < 0.3, spec: fn(o.groundSpec) }]; if (up) bands.push({ h: up * st, storey: st, grounded: false, spec: fn(o.upperSpec ?? o.groundSpec) });
  return mass(k, rectRuns(x0, z0, x1, z1, o.r ?? 0), o.y0 ?? 0, bands, { parapet: o.parapet ?? 0.9, color: o.wall, seed: o.seed, coping: o.coping, roof: o.roof, roofKind: o.roofKind ?? 0, collide: o.collide });
}
/** The landmark's name on a wall (inside onRun) or any plane of the current frame; null when the atlas has no entry. */
export const nameSign = (k, x, y, z, o = {}) => k.sign('landmark:' + k.lot.landmark.id, o.variant ?? 0, x, y, z, o);

/** Helicopter deck on a roof: a dark pad with the ring, the letter and four edge lamps. */
export function helipad(k, x, y, z, r = 6) {
  if (k.far) return;
  k.paint([0.3, 0.31, 0.32], 0.8, 90).occ(1).cyl(x, y, z, r, y + 0.25, { segs: k.near ? 20 : 10 });
  if (!k.near) return;
  k.paint([0.9, 0.9, 0.86], 0.7, 120); const n = 20, ri = r * 0.78, ro = r * 0.86, Y = y + 0.262;
  for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI, b = (i + 1) / n * 2 * Math.PI; k.quad([x + ro * Math.sin(a), Y, z + ro * Math.cos(a)], [x + ro * Math.sin(b), Y, z + ro * Math.cos(b)], [x + ri * Math.sin(b), Y, z + ri * Math.cos(b)], [x + ri * Math.sin(a), Y, z + ri * Math.cos(a)]); }
  const hw = r * 0.26, hh = r * 0.38, t = r * 0.07, bar = (ax, az, bx, bz) => k.quad([x + ax, Y, z + bz], [x + bx, Y, z + bz], [x + bx, Y, z + az], [x + ax, Y, z + az]);
  bar(-hw, -hh, -hw + t, hh); bar(hw - t, -hh, hw, hh); bar(-hw, -t / 2, hw, t / 2);
  for (let i = 0; i < 4; i++) { const a = (i + 0.5) / 4 * 2 * Math.PI; k.lamp(x + r * 0.95 * Math.sin(a), y + 0.3, z + r * 0.95 * Math.cos(a), [0.3, 1, 0.45], { power: 6, radius: 4, radiance: 6, glow: 0.25, size: 0.06 }); }
}
/** Flagpole with a flag (near; mid keeps the pole). */
export function flagpole(k, x, z, h = 9, color = [0.75, 0.12, 0.14], y = 0) {
  if (k.far) return;
  k.bare(1, 0.4).occ(1).cyl(x, y, z, 0.06, y + h, { segs: k.near ? 6 : 3, r1: 0.035 });
  if (k.near) { k.ball(x, y + h + 0.06, z, 0.09, { segs: 6 }); k.fabric(color, 1, 0).sheet([x, y + h - 1.3, z], [x + 1.9, y + h - 1.35, z + 0.1], [x + 1.9, y + h - 0.15, z + 0.1], [x, y + h - 0.1, z]); }
}
/**
 * Fence or wall round a rectangle with a gateway left open on the street side. gate: { x, w }.
 * o: yardWall options. Stretches shorter than a metre are skipped.
 */
export function compound(k, x0, z0, x1, z1, gate, o = {}) {
  const seg = (a, b) => { if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1) yardWall(k, [a, b], o); };
  seg([x0, z0], [x1, z0]); seg([x0, z0], [x0, z1]); seg([x1, z0], [x1, z1]);
  if (gate) { seg([x0, z1], [gate.x - gate.w / 2, z1]); seg([gate.x + gate.w / 2, z1], [x1, z1]); } else seg([x0, z1], [x1, z1]);
  if (k.far) return;
  const t = 0.3, h = o.h ?? 1.8;                                   // the planner gets one thin collider per side
  k.collide(x0, 0, z0 - t / 2, x1, h, z0 + t / 2); k.collide(x0 - t / 2, 0, z0, x0 + t / 2, h, z1); k.collide(x1 - t / 2, 0, z0, x1 + t / 2, h, z1);
  if (gate) { k.collide(x0, 0, z1 - t / 2, gate.x - gate.w / 2, h, z1 + t / 2); k.collide(gate.x + gate.w / 2, 0, z1 - t / 2, x1, h, z1 + t / 2); } else k.collide(x0, 0, z1 - t / 2, x1, h, z1 + t / 2);
}
/** Lifting barrier at a gate (near and mid): post, counterweight and a striped arm across x0..x1 at z. */
export function barrier(k, x0, x1, z) {
  if (k.far) return;
  k.steel([0.85, 0.85, 0.82], 0.5, 40).occ(1).box(x0 - 0.15, 0, z - 0.15, x0 + 0.15, 1.1, z + 0.15);
  const n = k.near ? 6 : 1; for (let i = 0; i < n; i++) { k.paint(i % 2 ? [0.9, 0.9, 0.88] : [0.8, 0.12, 0.1], 0.5, 30).box(x0 + (x1 - x0) * i / n, 0.95, z - 0.04, x0 + (x1 - x0) * (i + 1) / n, 1.07, z + 0.04, 'xXzZYy'); }
  k.collide(x0, 0.9, z - 0.05, x1, 1.1, z + 0.05);
}
/** Floodlight mast: a pole with a bank of lamps at the top, aimed along (dx, dz). */
export function floodMast(k, x, z, h, dx, dz, o = {}) {
  if (!k.far) { k.steel(STEEL, 0.5, 50).occ(1).cyl(x, 0, z, o.r ?? 0.22, h, { segs: k.near ? 8 : 4, r1: (o.r ?? 0.22) * 0.55 }); k.steel([0.25, 0.26, 0.27], 0.5, 40).box(x - 1.4 * Math.abs(dz) - 0.2, h - 0.2, z - 1.4 * Math.abs(dx) - 0.2, x + 1.4 * Math.abs(dz) + 0.2, h + 1.0, z + 1.4 * Math.abs(dx) + 0.2, 'xXzZYy'); }
  k.lamp(x + dx * 0.3, h + 0.4, z + dz * 0.3, o.color ?? [1, 0.93, 0.8], { power: o.power ?? 260, flood: true, radius: o.radius ?? 45, radiance: 30, glow: 2.2, size: 0.5, spot: [dx, -1.1, dz], outer: 55, inner: 30, far: true });
  k.collide(x - 0.25, 0, z - 0.25, x + 0.25, h, z + 0.25);
}
/** Block numeral 0..9 painted on a wall (inside onRun): seven bars, h tall, centred on x, base y. */
export function numeral(k, d, x, y, h, color = [0.2, 0.2, 0.22]) {
  if (k.far) return;
  const w = h * 0.55, t = h * 0.13, on = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abfgcd'][d], z = 0.02;
  const bars = { a: [-w / 2, h - t, w / 2, h], g: [-w / 2, h / 2 - t / 2, w / 2, h / 2 + t / 2], d: [-w / 2, 0, w / 2, t], f: [-w / 2, h / 2, -w / 2 + t, h], b: [w / 2 - t, h / 2, w / 2, h], e: [-w / 2, 0, -w / 2 + t, h / 2], c: [w / 2 - t, 0, w / 2, h / 2] };
  k.paint(color, 0.7, 120).occ(1); for (const c of on) { const b = bars[c]; k.quad([x + b[0], y + b[1], z], [x + b[2], y + b[1], z], [x + b[2], y + b[3], z], [x + b[0], y + b[3], z]); }
}
export { lineRun, WHITE, STEEL, CHANNEL };
