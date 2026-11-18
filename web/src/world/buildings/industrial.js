// Sheds: warehouses of the port and the back streets, and aircraft hangars (design/brief/architecture.md sections 18, 19).

import { clamp } from '../../core/math.js';
import { rectRuns, lineRun, shade, mixColor } from './kit.js';
import { scheme } from './palette.js';
import { F, WHITE, STEEL, mass, canopy, steps, doorway, pitchedRoof, roofPlant, wallSign, yardWall, tiltSlab, beacon, bayLines } from './parts.js';

const DOCK = 1.15;
/** Lamp on a wall bracket over a door (inside onRun). */
const wallLamp = (k, x, y, o = {}) => { if (!k.far) { k.steel(STEEL, 0.5, 60).occ(1).box(x - 0.03, y, 0, x + 0.03, y + 0.05, 0.5, 'xXZYy'); k.lamp(x, y, 0.45, o.color ?? [1, 0.78, 0.48], { power: o.power ?? 30, radius: 10, radiance: 12, glow: 0.5, spot: [0, -1, 0.25], outer: 75, inner: 45 }); } };
/** A row of spinning ridge ventilators. Near only. */
function ridgeVents(k, x0, x1, y, z, n) { if (!k.near) return; k.bare(2, 0.5).occ(1); for (let i = 0; i < n; i++) { const x = x0 + (x1 - x0) * (i + 0.5) / n; k.cyl(x, y - 0.1, z, 0.16, y + 0.3, { cap: false, segs: 6 }); k.ball(x, y + 0.42, z, 0.3, { segs: 8, sy: 0.8 }); } }
/** Loading dock along a wall (inside onRun): platform, bumpers, steps at one end, a canopy over the doors. */
function dock(k, x0, x1, o = {}) {
  const d = o.depth ?? 2.4;
  if (!k.far) { k.concrete([0.63, 0.62, 0.59], 0, 120).occ(1).box(x0, 0, 0, x1, DOCK, d, 'xXZY'); if (k.near) { k.paint([0.85, 0.7, 0.1], 0.6, 120).box(x0, DOCK - 0.12, d, x1, DOCK, d + 0.012, 'Z'); k.paint([0.08, 0.08, 0.08], 0.9, 60); for (let x = x0 + 1.2; x < x1 - 0.5; x += 4.2) k.box(x - 0.15, DOCK - 0.5, d, x + 0.15, DOCK - 0.15, d + 0.1, 'xXZY'); }
    k.at(x1, 0, 0.3, 0, () => steps(k, 0, 1.1, 0, DOCK, { n: 5, tread: Math.min(0.3, (d - 0.35) / 5), color: [0.6, 0.59, 0.56] }));
    if (o.canopy !== false) { k.steel(o.canopyColor ?? [0.62, 0.64, 0.64], 0.5, 90).occ(1); tiltSlab(k, x0, 0, x1, d + 0.9, o.canopyY ?? 5.2, o.canopyY ?? 5.2, 0.14); if (k.near) for (let x = x0 + 0.3; x <= x1; x += 4.2) k.steel(STEEL, 0.5, 80).pipe([[x, (o.canopyY ?? 5.2) + 1.6, 0.02], [x, (o.canopyY ?? 5.2), d + 0.6]], 0.03, 4); } }
  k.collide(x0, 0, 0, x1, DOCK, d);
}

/**
 * Warehouse. Variants: 0 a corrugated steel shed with a gable roof on a block base and a canopied loading dock,
 * 1 an older brick warehouse with a stepped gable, steel-sash windows and a saw-tooth north-light roof, 2 a
 * tilt-up concrete box with a two-storey office corner and a stripe round the top.
 */
export function warehouse(k, lot) {
  const S = scheme(lot.seed ^ 0x9a, 'industrial', lot.style), W = lot.width, D = lot.depth, seed = S.seedByte, variant = (((lot.variant ?? Math.floor(k.h(1) * 3)) % 3) + 3) % 3, trim = S.trimC;
  const x0 = -W / 2 + 1.2, x1 = W / 2 - 1.2, zb = -D / 2 + 1.2, zf = D / 2 - (variant === 1 ? 2.0 : 6.5), H = (lot.floors > 1 ? 9.5 : 7.0) + k.h(2) * 1.5, flip = k.h(3) < 0.5 ? -1 : 1, runs = rectRuns(x0, zb, x1, zf), front = runs.find((r) => r.cls === 'front');
  const wall = variant === 1 ? [[0.52, 0.26, 0.2], [0.6, 0.34, 0.25], [0.66, 0.5, 0.36]][Math.floor(k.h(4) * 3)] : variant === 2 ? [0.82, 0.8, 0.75] : S.wall, nb = Math.max(2, Math.round((x1 - x0) / 6.5));
  if (variant === 0) {
    const sheet = { style: F('WAREHOUSE', 'SHEET', k.h(5) < 0.5), bay: 6, color: wall, seed }, doors = { style: F('WAREHOUSE', 'DOORS'), bays: nb, color: wall, seed };
    mass(k, runs, 0, [{ h: H, spec: (r) => (r.cls === 'front' ? doors : sheet) }], { roof: null });
    const ridge = pitchedRoof(k, x0, zb, x1, zf, H, { pitch: 0.22, over: 0.3, kind: 2, color: k.h(6) < 0.6 ? [0.6, 0.62, 0.62] : shade(wall, 0.8), gable: true, gableSpec: { style: F('BLANK', 'SHEET'), bay: 60, color: wall, seed, storey: 9 }, wear: 170 });
    const along = (x1 - x0) >= (zf - zb); if (along) ridgeVents(k, x0 + 3, x1 - 3, ridge, (zb + zf) / 2, Math.max(2, Math.round((x1 - x0) / 9))); else if (k.near) { k.bare(2, 0.5); for (let i = 0; i < 3; i++) { const z = zb + (zf - zb) * (i + 0.5) / 3; k.cyl(0, ridge - 0.1, z, 0.16, ridge + 0.3, { cap: false, segs: 6 }); k.ball(0, ridge + 0.42, z, 0.3, { segs: 8, sy: 0.8 }); } }
    k.onRun(front, (len) => { dock(k, 0.5, len - 2.2, { canopyColor: shade(wall, 0.85) }); for (let i = 0; i < nb; i += 2) wallLamp(k, (i + 0.5) * len / nb, 5.0); wallSign(k, 'warehouse', lot.seed >>> 3, len / 2, H - 0.9, { height: 1.0, maxWidth: len * 0.6, lit: false, far: true, wallColor: wall }); });
  } else if (variant === 1) {
    const brick = { style: F('WAREHOUSE', 'BRICK'), bay: 4.6, color: wall, seed };
    mass(k, runs, 0, [{ h: H, spec: (r) => (r.cls === 'front' ? { style: F('WAREHOUSE', 'BRICK'), bays: nb, color: wall, seed } : brick) }], { parapet: 0.9, color: wall, seed, parapetStyle: F('BLANK', 'BRICK'), coping: [0.72, 0.7, 0.65], roof: null, skipParapet: ['front'] });
    // stepped gable on the street: three rising blocks of brick with stone copings
    const bs = { style: F('BLANK', 'BRICK'), bay: 4, color: wall, seed }, w = x1 - x0;
    [0, 0.2, 0.36].forEach((f, i) => { mass(k, rectRuns(x0 + w * f, zf - 0.4, x1 - w * f, zf + (i ? 0.01 * i : 0)), H + (i ? [0.9, 1.8][i - 1] : 0), [{ h: 0.9, storey: 1, grounded: false, spec: bs }], { roof: [0.72, 0.7, 0.65], roofKind: 3, collide: false }); });
    // saw-tooth roof: glazed faces to the north (the back), sheet slopes to the south
    const nt = Math.max(2, Math.round((zf - zb - 1) / 7)), tz = (zf - zb - 0.8) / nt;
    for (let i = 0; i < nt; i++) { const a = zb + 0.2 + i * tz, b = a + tz;
      k.roofing(2, [0.5, 0.52, 0.52], 170).occ(1); k.quad([x0 + 0.25, H + 0.2, b], [x1 - 0.25, H + 0.2, b], [x1 - 0.25, H + 2.4, a + 0.05], [x0 + 0.25, H + 2.4, a + 0.05], [0, 0, w, 0, w, tz, 0, tz]);
      k.glass([0.2, 0.26, 0.26], 0.3).occ(0.9); k.quad([x1 - 0.25, H + 0.2, a], [x0 + 0.25, H + 0.2, a], [x0 + 0.25, H + 2.4, a + 0.05], [x1 - 0.25, H + 2.4, a + 0.05]);
      k.facade(bs, 9); k.tri3([x1 - 0.25, H + 0.2, b], [x1 - 0.25, H + 0.2, a], [x1 - 0.25, H + 2.4, a + 0.05]); k.tri3([x0 + 0.25, H + 0.2, a], [x0 + 0.25, H + 0.2, b], [x0 + 0.25, H + 2.4, a + 0.05]); }
    k.onRun(front, (len) => { for (let i = 0; i < nb; i += 2) wallLamp(k, (i + 0.5) * len / nb, 4.6); wallSign(k, 'warehouse', lot.seed >>> 3, len / 2, H + 0.45, { height: 0.8, maxWidth: len * 0.5, lit: false, far: true, wallColor: wall }); });
    // a brick chimney and a water tank on legs behind the gable
    const cxs = x0 + (flip < 0 ? 2.5 : w - 2.5), cz = zb + 3;
    if (!k.far) { k.facade(bs, 9); k.walls(rectRuns(cxs - 0.9, cz - 0.9, cxs + 0.9, cz + 0.9), H, [{ h: 9, storey: 9, grounded: false, spec: bs }]); k.stucco([0.3, 0.29, 0.28], 200).cap([[cxs - 0.9, cz + 0.9], [cxs + 0.9, cz + 0.9], [cxs + 0.9, cz - 0.9], [cxs - 0.9, cz - 0.9]], H + 9); }
    roofPlant(k, x0 + w * 0.3, zf - 5, x1 - w * 0.3, zf - 1, H + 2.5, { core: false, units: 0, tank: true, aerial: false });
  } else {
    const panel = { style: F('WAREHOUSE', 'TILT_UP', true), bay: 7.2, color: wall, seed }, doors = { style: F('WAREHOUSE', 'DOORS'), bay: 5.4, color: wall, seed };
    const ow = clamp(W * 0.28, 8, 14), od = 8, oh = 7.2, [oa, ob] = flip < 0 ? [x0, x0 + ow] : [x1 - ow, x1];
    const m = mass(k, runs, 0, [{ h: H, spec: (r) => (r.cls === (flip < 0 ? 'right' : 'left') ? doors : panel) }], { parapet: 0.6, color: wall, seed, coping: shade(wall, 0.9), roofKind: 3, roof: [0.82, 0.82, 0.8] });
    // office corner: two storeys of ribbon windows in front of the shed, a slab canopy and the firm's sign
    const o = mass(k, rectRuns(oa, zf - 1, ob, zf + od - 3.5), 0, [{ h: oh, storey: 3.6, spec: (r) => (r.cls === 'back' ? null : r.cls === 'front' ? { style: F('PUNCHED', 'RIBBON'), bay: 3.2, color: mixColor(wall, WHITE, 0.4), seed } : { style: F('PUNCHED', 'SLOT'), bay: 3.2, color: mixColor(wall, WHITE, 0.4), seed }) }], { parapet: 0.5, color: mixColor(wall, WHITE, 0.4), seed, coping: trim });
    k.onRun(o.runs.find((r) => r.cls === 'front'), (len) => { canopy(k, len / 2 - 2.2, len / 2 + 2.2, 2.75, 1.8, { th: 0.2, lip: trim, lamps: 1 }); doorway(k, len / 2, 0, 1.8, 2.3, {}); wallSign(k, 'warehouse', lot.seed >>> 3, len / 2, oh + 0.05, { height: 0.5, maxWidth: len - 1, lit: false, wallColor: mixColor(wall, WHITE, 0.4), z: 0.02 }); });
    k.onRun(runs.find((r) => r.cls === (flip < 0 ? 'right' : 'left')), (len) => { dock(k, 2, len - 3, { canopy: false, depth: 1.0 }); for (let x = 5; x < len - 3; x += 10.8) wallLamp(k, x, 5.2); });
    k.onRun(front, (len) => wallSign(k, 'warehouse', (lot.seed >>> 3) + 1, flip < 0 ? (len + ow) / 2 : (len - ow) / 2, H - 2.4, { height: 1.4, maxWidth: (len - ow) * 0.7, lit: false, far: true, wallColor: wall }));
    roofPlant(k, x0 + 3, zb + 3, x1 - 3, zf - 3, m.roofY, { core: false, units: 6, tank: false, aerial: false });
    bayLines(k, flip < 0 ? x0 + ow + 1 : x0 + 1, flip < 0 ? x1 - 1 : x1 - ow - 1, zf + 0.6, zf + 5.4, 2.7);
  }
  // yard fence to the street with the gateway left open
  const fz = D / 2 - 0.5, gx = flip * (W / 2 - 6), o = { h: 2.2, t: 0.12, color: [0.66, 0.65, 0.62], style: 'rail', rail: [0.6, 0.62, 0.63] };
  if (variant !== 1 && k.h(8) < 0.7) { const a = Math.min(gx - 3, gx + 3), b = Math.max(gx - 3, gx + 3); if (a - (-W / 2 + 0.4) > 1) yardWall(k, [[-W / 2 + 0.4, fz], [a, fz]], o); if (W / 2 - 0.4 - b > 1) yardWall(k, [[b, fz], [W / 2 - 0.4, fz]], o); }
  return { S, variant };
}

/**
 * Aircraft hangar. Variants: 0 a bow-string arched roof over sliding doors, 1 a steel gable hangar with door
 * pockets either side, 2 a flat-roofed maintenance hangar with a tail slot over the door. Each has a lean-to annexe
 * and obstruction lamps on the roof.
 */
export function hangar(k, lot) {
  const S = scheme(lot.seed ^ 0xb7, 'industrial', lot.style), W = lot.width, D = lot.depth, seed = S.seedByte, variant = (((lot.variant ?? Math.floor(k.h(1) * 3)) % 3) + 3) % 3;
  const wall = lot.wallColor ?? (k.h(2) < 0.5 ? [0.78, 0.8, 0.8] : S.wall), aw = 6.5, flip = k.h(3) < 0.5 ? -1 : 1;
  const x0 = -W / 2 + 1.5 + (flip < 0 ? aw : 0), x1 = W / 2 - 1.5 - (flip > 0 ? aw : 0), zb = -D / 2 + 1.5, zf = D / 2 - 5, w = x1 - x0, H = clamp(w * 0.22, 8, 12), runs = rectRuns(x0, zb, x1, zf);
  const sheet = { style: F('WAREHOUSE', 'SHEET', true), bay: 7, color: wall, seed }, door = { style: F('WAREHOUSE', 'HANGAR_DOOR'), bay: (w - 3) / 6, color: wall, seed }, gsp = { style: F('BLANK', 'SHEET'), bay: 60, color: wall, seed, storey: 9 };
  const pocket = 1.5;
  k.walls(runs, 0, [{ h: H, spec: (r) => (r.cls === 'front' ? null : sheet) }]);
  k.walls([lineRun(x0, zf, x0 + pocket, zf), lineRun(x1 - pocket, zf, x1, zf)], 0, [{ h: H, spec: { style: F('BLANK', 'SHEET'), bay: 4, color: wall, seed } }]);
  k.walls([lineRun(x0 + pocket, zf, x1 - pocket, zf)], 0, [{ h: H, spec: door }]);
  k.collide(x0, 0, zb, x1, H, zf);
  let top = H;
  if (variant === 0) {
    const n = k.near ? 12 : k.mid ? 8 : 4, rise = w * 0.2, pt = (i) => [x0 - 0.3 + (w + 0.6) * i / n, H + rise * Math.sin(Math.PI * i / n)];
    k.roofing(2, [0.62, 0.64, 0.64], 170).occ(1);
    for (let i = 0; i < n; i++) { const a = pt(i), b = pt(i + 1); k.sheet([a[0], a[1], zf + 0.4], [b[0], b[1], zf + 0.4], [b[0], b[1], zb - 0.4], [a[0], a[1], zb - 0.4], [0, i * 3, D, i * 3, D, i * 3 + 3, 0, i * 3 + 3]); }   // two-sided: the overhang is seen from below
    k.facade(gsp, 9);
    // gable ends follow the roof line exactly between the walls
    for (let i = 0; i < n; i++) { const a = pt(i), b = pt(i + 1), ax = clamp(a[0], x0, x1), bx = clamp(b[0], x0, x1), at = (x) => a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]), ay = at(ax), by = at(bx);
      k.quad([ax, H, zf], [bx, H, zf], [bx, by, zf], [ax, ay, zf], [ax, 9, bx, 9, bx, 9 + by - H, ax, 9 + ay - H]); k.quad([bx, H, zb], [ax, H, zb], [ax, ay, zb], [bx, by, zb], [-bx, 9, -ax, 9, -ax, 9 + ay - H, -bx, 9 + by - H]); }
    top = H + rise;
  } else if (variant === 1) {
    top = pitchedRoof(k, x0, zb, x1, zf, H, { pitch: 0.2, over: 0.3, kind: 2, color: [0.6, 0.62, 0.62], gable: true, gableSpec: gsp, wear: 170 });
    // door pockets: the leaves slide out past the walls on outrigger frames
    const out = (s) => Math.min(3.5, (s < 0 ? x0 + W / 2 : W / 2 - x1) - 0.3);
    if (!k.far) { k.steel(STEEL, 0.5, 80).occ(1); for (const s of [-1, 1]) { const a = s < 0 ? x0 - out(s) : x1, b = a + out(s); k.box(a, H - 1.6, zf + 0.05, b, H - 1.3, zf + 0.35, 'xXzZYy'); k.box((s < 0 ? a : b) - 0.1, 0, zf + 0.1, (s < 0 ? a : b) + 0.1, H - 1.6, zf + 0.3, 'xXzZ'); } }
    for (const s of [-1, 1]) { const px = s < 0 ? x0 - out(s) : x1 + out(s); k.collide(px - 0.1, 0, zf + 0.1, px + 0.1, H - 1.6, zf + 0.3); }
  } else {
    const m = mass(k, runs, H, [{ h: 2.2, storey: 2.2, grounded: false, spec: { style: F('BLANK', 'SHEET', true), bay: 4, color: wall, seed } }], { parapet: 0.3, color: wall, seed, roofKind: 3, roof: [0.7, 0.7, 0.68], collide: false });
    // tail slot: a taller door section in the middle for the fin
    const tw = clamp(w * 0.16, 5, 8), th = 5; mass(k, rectRuns(-tw / 2 + (x0 + x1) / 2, zf - 6, tw / 2 + (x0 + x1) / 2, zf + 0.02), m.roofY, [{ h: th, storey: th, grounded: false, spec: (r) => (r.cls === 'front' ? { style: F('WAREHOUSE', 'HANGAR_DOOR'), bay: tw / 2, color: wall, seed } : { style: F('BLANK', 'SHEET'), bay: 4, color: wall, seed }) }], { roof: [0.7, 0.7, 0.68], roofKind: 3, collide: false });
    top = m.roofY + th;
  }
  k.collide(x0, H, zb, x1, top, zf);
  // lean-to annexe: workshops and offices under a mono-pitch roof
  const a0 = flip < 0 ? x0 - aw : x1, a1 = a0 + aw, ah = 4.2, az1 = zf - 3, az0 = zb + 2;
  mass(k, rectRuns(a0, az0, a1, az1), 0, [{ h: ah, storey: ah, spec: (r) => (r.cls === (flip < 0 ? 'right' : 'left') ? null : r.cls === 'front' ? { style: F('SHOPFRONT', 'SERVICE'), bay: aw, color: wall, seed } : { style: F('PUNCHED', 'RIBBON'), bay: 3.6, color: mixColor(wall, WHITE, 0.3), seed }) }], { roof: null });
  k.roofing(2, [0.6, 0.62, 0.62], 170); tiltSlab(k, a0 - (flip < 0 ? 0.3 : 0), az0 - 0.3, a1 + (flip > 0 ? 0.3 : 0), az1 + 0.3, flip < 0 ? ah + 0.1 : ah + 1.3, flip < 0 ? ah + 1.3 : ah + 0.1, 0.12);
  if (k.far) { k.roofing(2, [0.6, 0.62, 0.62], 170).occ(1).cap([[a0, az1], [a1, az1], [a1, az0], [a0, az0]], ah); }
  else {                                                       // end walls carried up under the tilted roof
    const lo = ah, hi = ah + 1.3 - 0.13, ya = flip < 0 ? lo : hi, yb = flip < 0 ? hi : lo;
    k.facade(gsp, 9).occ(1); k.quad([a0, ah, az1], [a1, ah, az1], [a1, yb, az1], [a0, ya, az1], [a0, 9, a1, 9, a1, 9 + yb - ah, a0, 9 + ya - ah]); k.quad([a1, ah, az0], [a0, ah, az0], [a0, ya, az0], [a1, yb, az0], [-a1, 9, -a0, 9, -a0, 9 + ya - ah, -a1, 9 + yb - ah]);
  }
  // big painted number or name over the door, door lamps, apron lines, roof beacons
  k.at((x0 + x1) / 2, 0, zf, 0, () => { wallSign(k, 'warehouse', lot.seed >>> 3, 0, H - (variant === 2 ? -1.0 : 0.9), { height: 1.4, maxWidth: w * 0.5, lit: false, far: true, wallColor: wall, z: 0.03 }); if (!k.far) for (const f of [-0.3, 0, 0.3]) { k.steel(STEEL, 0.5, 60).occ(1).box(f * w - 0.03, H - 2.2, 0, f * w + 0.03, H - 2.15, 0.7, 'xXZYy'); k.lamp(f * w, H - 2.2, 0.65, [1, 0.8, 0.5], { power: 70, radius: 16, radiance: 14, glow: 0.8, spot: [0, -1, 0.3], outer: 75, inner: 50 }); } });
  if (k.near) { k.paint([0.85, 0.7, 0.1], 0.8, 150).occ(1); k.quad([x0 + pocket, 0.03, zf + 4.4], [x1 - pocket, 0.03, zf + 4.4], [x1 - pocket, 0.03, zf + 4.25], [x0 + pocket, 0.03, zf + 4.25]); k.quad([(x0 + x1) / 2 - 0.08, 0.03, zf + 4.25], [(x0 + x1) / 2 + 0.08, 0.03, zf + 4.25], [(x0 + x1) / 2 + 0.08, 0.03, zf + 0.2], [(x0 + x1) / 2 - 0.08, 0.03, zf + 0.2]); }
  beacon(k, x0 + 0.5, variant === 0 ? H + 0.3 : top + 0.05 - (variant === 1 ? (top - H) : 0), zf - 0.5); beacon(k, x1 - 0.5, variant === 0 ? H + 0.3 : top + 0.05 - (variant === 1 ? (top - H) : 0), zb + 0.5);
  return { S, variant, top };
}
