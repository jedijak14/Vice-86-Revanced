// Named places that are their own kind of structure: the lighthouse, the stadium, the malls, the film studio, the
// docks, the airport, the scrapyard and the army base.

import { hashInts } from '../../core/math.js';
import { SOLID } from '../../core/ids.js';
import { rectRuns, polyRuns, shade } from '../buildings/kit.js';
import { TRIM, NEON, ROOF_TILE } from '../buildings/palette.js';
import { F, mass, canopy, column, doorway, pitchedRoof, roofPlant, roofSign, mast, beacon, bayLines, tiltSlab, railing } from '../buildings/parts.js';
import { bungalow } from '../buildings/low.js';
import { parkingGarage } from '../buildings/downtown.js';
import { warehouse, hangar } from '../buildings/industrial.js';
import { W, sb, part, block, nameSign, helipad, flagpole, compound, barrier, floodMast, numeral, WHITE, STEEL, CHANNEL } from './common.js';

const CONC = [0.7, 0.69, 0.66];
const front = (m) => m.runs.find((r) => r.cls === 'front');

// ------------------------------------------------------------------------------------------------ lighthouse
export function lighthouse(k, m) {
  const H = m.heightM, segs = k.near ? 20 : k.far ? 6 : 10, yg = H - 7, r0 = 3.6, r1 = 2.1;
  // rock plinth, tapering shaft with a red band, gallery, lantern and cap
  k.solid(SOLID.ROCK, [0.5, 0.48, 0.44], 40, 0).occ(1).cyl(0, 0, 0, 5.6, 1.4, { segs: k.far ? 6 : 10, r1: 4.6 });
  k.stucco([0.94, 0.94, 0.92], 110).cyl(0, 1.4, 0, r0, yg * 0.45, { segs, r1: r0 - (r0 - r1) * 0.45, cap: false });
  k.stucco([0.75, 0.1, 0.09], 110).cyl(0, yg * 0.45, 0, r0 - (r0 - r1) * 0.45, yg * 0.62, { segs, r1: r0 - (r0 - r1) * 0.62, cap: false });
  k.stucco([0.94, 0.94, 0.92], 110).cyl(0, yg * 0.62, 0, r0 - (r0 - r1) * 0.62, yg, { segs, r1, cap: false });
  k.paint([0.2, 0.2, 0.22], 0.5, 60).cyl(0, yg, 0, r1 + 1.1, yg + 0.3, { segs, bottom: true });
  k.collide(-r0 * 0.75, 0, -r0 * 0.75, r0 * 0.75, H, r0 * 0.75);
  const lr = 1.7, ly = yg + 0.3;
  k.paint([0.75, 0.1, 0.09], 0.5, 40).cyl(0, ly, 0, lr, ly + 0.9, { segs, cap: false });
  k.glass([0.3, 0.36, 0.38], 0.05).cyl(0, ly + 0.9, 0, lr, ly + 3.4, { segs, cap: false });
  k.paint([0.75, 0.1, 0.09], 0.4, 40).cyl(0, ly + 3.4, 0, lr + 0.25, ly + 5.2, { segs, r1: 0.15, bottom: true });
  if (!k.far) { k.ball(0, ly + 5.35, 0, 0.3, { segs: 6 }); k.steel(STEEL, 0.5, 40).cyl(0, ly + 5.5, 0, 0.03, ly + 7, { segs: 3, cap: false }); }
  if (k.near) { const ring = []; for (let i = 0; i < 16; i++) { const a = i / 16 * 2 * Math.PI; ring.push([(r1 + 1.0) * Math.sin(a), yg + 0.3, (r1 + 1.0) * Math.cos(a)]); } ring.push(ring[0]); railing(k, ring, 1.1, { color: [0.2, 0.2, 0.22] });
    k.at(0, 0, r0 - 0.05, 0, () => doorway(k, 0, 1.4, 1.1, 2.1, { metal: false, leaves: 1 })); k.glass([0.1, 0.12, 0.14]); for (let i = 1; i <= 3; i++) { const y = 1.4 + yg * 0.22 * i, r = r0 - (r0 - r1) * (y / yg) + 0.02; k.quad([-0.35, y, r], [0.35, y, r], [0.35, y + 1.1, r - 0.05], [-0.35, y + 1.1, r - 0.05]); } }
  // the lamp: lens, light and a glow that carries across the bay
  k.lens([1, 0.95, 0.8], 60, CHANNEL.STREET).cyl(0, ly + 1.4, 0, 0.55, ly + 2.8, { segs: k.far ? 4 : 8 });
  k.light(0, ly + 2.1, 0, [300, 285, 235], 60, CHANNEL.STREET); k.glow(0, ly + 2.1, 0, 5, [30, 28, 22], CHANNEL.STREET, 1, true);
  k.at(0, 0, r0 + 0.3, 0, () => nameSign(k, 0, 4.4, 0, { height: 0.4, maxWidth: 2.4, lit: false, wallColor: [0.94, 0.94, 0.92] }));
}

// ------------------------------------------------------------------------------------------------ stadium
export function stadium(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], seed = sb(k, TRIM.ORANGE, 2), A = Wd / 2 - 42, B = D / 2 - 34, a = A - 44, b = B - 44, n = k.near ? 44 : k.far ? 12 : 24;
  const H0 = 16, H1 = m.heightM, conc = [0.76, 0.74, 0.7], P = (ra, rb, i) => { const t = (i / n) * 2 * Math.PI; return [ra * Math.sin(t), rb * Math.cos(t)]; };
  const outer = []; for (let i = 0; i < n; i++) outer.push(P(A, B, i));
  const runs = polyRuns(outer);
  // outer wall: an arcade at the foot, ribbed concrete above; the two long sides carry an upper deck
  const upper = (i) => { const t = ((i + 0.5) / n) * 2 * Math.PI; return Math.abs(Math.cos(t)) > 0.55; };
  k.walls(runs, 0, [{ h: 6, storey: 6, spec: W('SHOPFRONT', 'SERVICE', 6.5, conc, seed) }, { h: H0 - 6, storey: 5, grounded: false, spec: W('GARAGE', 'FINS', 3.2, conc, seed) }]);
  k.walls(runs.filter((_, i) => upper(i)), H0, [{ h: H1 - H0, storey: 5, grounded: false, spec: W('BLANK', 'CONCRETE', 6.5, conc, seed) }]);
  for (let i = 0; i < n; i++) { const p = outer[i], q = outer[(i + 1) % n], cx = (p[0] + q[0]) / 2, cz = (p[1] + q[1]) / 2, len = Math.hypot(q[0] - p[0], q[1] - p[1]); k.at(cx * 0.94, 0, cz * 0.94, Math.atan2(q[1] - p[1], q[0] - p[0]) * -1, () => k.collide(-len / 2, 0, -7, len / 2, upper(i) ? H1 : H0, 7)); }
  // seating: a lower bowl all round, an upper tier on the long sides; seats in bands of orange and aqua
  const seat = [[0.86, 0.45, 0.12], [0.2, 0.62, 0.6], [0.8, 0.78, 0.72]];
  for (let i = 0; i < n; i++) {
    const j = i + 1, c = seat[Math.floor(i * 3 / n * 4) % 3];
    const I0 = P(a, b, i), I1 = P(a, b, j), M0 = P(A - 16, B - 16, i), M1 = P(A - 16, B - 16, j), O0 = P(A - 0.3, B - 0.3, i), O1 = P(A - 0.3, B - 0.3, j);
    k.concrete(c, 8, 60).occ(1).quad([M0[0], 10.5, M0[1]], [M1[0], 10.5, M1[1]], [I1[0], 1.6, I1[1]], [I0[0], 1.6, I0[1]]);
    k.concrete(conc, 0, 80).quad([I1[0], 0, I1[1]], [I0[0], 0, I0[1]], [I0[0], 1.6, I0[1]], [I1[0], 1.6, I1[1]]);
    if (upper(i)) { const U0 = P(A - 20, B - 20, i), U1 = P(A - 20, B - 20, j);
      k.concrete(seat[(Math.floor(i * 3 / n * 4) + 1) % 3], 8, 60).quad([O0[0], H1 - 0.6, O0[1]], [O1[0], H1 - 0.6, O1[1]], [U1[0], 13.5, U1[1]], [U0[0], 13.5, U0[1]]);
      k.concrete(shade(conc, 0.85), 0, 80).occ(0.6).quad([U0[0], 12.6, U0[1]], [U1[0], 12.6, U1[1]], [O1[0], H1 - 1.5, O1[1]], [O0[0], H1 - 1.5, O0[1]]); k.occ(1);
      k.quad([U1[0], 12.6, U1[1]], [U0[0], 12.6, U0[1]], [U0[0], 13.5, U0[1]], [U1[0], 13.5, U1[1]]);
      // where the upper deck stops, a radial end wall from the concourse to the top closes the space under it
      for (const [e, s] of [[i, upper((i + n - 1) % n)], [j, upper(j % n)]]) if (!s) { const u = P(A - 20, B - 20, e), o = P(A - 0.3, B - 0.3, e), w = P(A, B, e), l = P(A - 16, B - 16, e), fl = e === i;
        const ring = [[w[0], H1, w[1]], [o[0], H1 - 0.6, o[1]], [u[0], 13.5, u[1]], [u[0], 12.6, u[1]], [l[0], 10.5, l[1]]], hub = [w[0], 10.5, w[1]];
        for (let v = 0; v + 1 < ring.length; v++) fl ? k.tri3(hub, ring[v], ring[v + 1]) : k.tri3(hub, ring[v + 1], ring[v]); }
      k.quad([outer[i][0], H1, outer[i][1]], [outer[j % n][0], H1, outer[j % n][1]], [O1[0], H1 - 0.6, O1[1]], [O0[0], H1 - 0.6, O0[1]]);
    } else { k.concrete(conc, 0, 80).quad([O0[0], H0, O0[1]], [O1[0], H0, O1[1]], [M1[0], 10.5, M1[1]], [M0[0], 10.5, M0[1]]); k.quad([outer[i][0], H0, outer[i][1]], [outer[j % n][0], H0, outer[j % n][1]], [O1[0], H0, O1[1]], [O0[0], H0, O0[1]]); }
    if (upper(i)) k.concrete(conc, 0, 80).quad([O0[0], H0 - 3, O0[1]], [O1[0], H0 - 3, O1[1]], [M1[0], 10.5, M1[1]], [M0[0], 10.5, M0[1]]);
  }
  // the pitch: mown stripes
  const stripes = k.near ? 12 : k.far ? 1 : 4, fw = a - 6, fd = b - 5;
  for (let i = 0; i < stripes; i++) { const xa = -fw + 2 * fw * i / stripes, xb = -fw + 2 * fw * (i + 1) / stripes; k.paint(i % 2 ? [0.22, 0.47, 0.2] : [0.27, 0.53, 0.23], 0.9, 20).occ(1).quad([xa, 0.3, fd], [xb, 0.3, fd], [xb, 0.3, -fd], [xa, 0.3, -fd]); }
  k.concrete([0.6, 0.36, 0.28], 0, 60).cap(Array.from({ length: n }, (_, i) => P(a, b, i)), 0.12);
  // floodlight towers behind the ends, scoreboard over one end, the name over the main gate
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) floodMast(k, sx * (A * 0.78), sz * (B * 0.78 + 6), H1 + 16, -sx * 0.7, -sz * 0.6, { power: 700, radius: 80, r: 0.6 });
  k.at(A - 17, 0, 0, Math.PI / 2 + Math.PI, () => { k.steel([0.15, 0.16, 0.18], 0.5, 40).occ(1).box(-11, 18, -0.5, 11, 27, 0.5, 'xXzZYy'); if (!k.far) for (const s of [-9, 9]) k.steel(STEEL, 0.5, 50).box(s - 0.3, 10, -0.3, s + 0.3, 18, 0.3, 'xXzZ'); nameSign(k, 0, 24.5, 0.52, { height: 3, maxWidth: 20, far: true }); });
  k.at(0, 0, B, 0, () => { canopy(k, -14, 14, 6.2, 5, { th: 0.6, lip: [0.86, 0.45, 0.12], lamps: 6, far: true }); nameSign(k, 0, 9.2, 0.4, { height: 3.2, maxWidth: 40, far: true, wallColor: conc }); });
  // car parks and the helicopter pads on the corners of the lot
  for (const s of [-1, 1]) { bayLines(k, -A, A, s * (D / 2 - 4) - 2.7, s * (D / 2 - 4) + 2.7, 2.8); helipad(k, s * (Wd / 2 - 14), 0.02, -D / 2 + 14, 8); }
}

// ------------------------------------------------------------------------------------------------ malls
/** A mall entrance on a wall (inside onRun): a tall glazed porch under a slab with the name over it. */
function mallGate(k, x, H, o = {}) {
  const w = o.w ?? 14, wall = o.wall ?? WHITE;
  if (!k.far) { k.glass([0.12, 0.2, 0.24], 0.06).occ(1).box(x - w / 2 + 0.6, 0, 0, x + w / 2 - 0.6, H - 1.2, 2.4, 'xXZ'); k.stucco(wall, 60).box(x - w / 2, H - 1.2, 0, x + w / 2, H + 1.6, 3.2, 'xXZYy').box(x - w / 2, 0, 0, x - w / 2 + 0.6, H - 1.2, 3.2, 'xXZ').box(x + w / 2 - 0.6, 0, 0, x + w / 2, H - 1.2, 3.2, 'xXZ');
    for (const s of [-0.25, 0.25]) k.lamp(x + s * w, H - 1.22, 2.8, [1, 0.9, 0.75], { power: 40, radius: 10, radiance: 12, glow: 0.5 }); doorway(k, x, 0, 4, 2.6, { leaves: 2 }); if (o.neon) k.neon([[x - w / 2, H + 1.5, 3.25], [x + w / 2, H + 1.5, 3.25]], o.neon, { back: [0, 0, -1], maxLights: 2 }); }
  k.collide(x - w / 2, 0, 0, x - w / 2 + 0.6, H, 3.2); k.collide(x + w / 2 - 0.6, 0, 0, x + w / 2, H, 3.2);
  nameSign(k, x, H + 0.2, 3.23, { height: Math.min(2.2, w / 6), maxWidth: w - 1.5, far: true });
}
const MALL_SHOPS = ['shop', 'cafe', 'pharmacy', 'shop', 'market', 'shop'];
/**
 * The covered walk along a mall's street front (inside onRun), from xa to xb: a thin slab on steel posts, a shop
 * sign on the wall over every other window, soffit lamps, and palms in pits at the kerb edge of the walk.
 */
function arcade(k, xa, xb, o = {}) {
  if (k.far || xb - xa < 6) return;
  const n = Math.max(1, Math.round((xb - xa) / (o.bay ?? 7))), w = (xb - xa) / n, y = o.y ?? 3.6, d = o.depth ?? 3.4, lip = o.lip ?? WHITE;
  k.stucco(WHITE, 70).occ(1).slab(rectRuns(xa, 0, xb, d), y, y + 0.3, { bottom: true, under: 0.5, lip, skip: ['back'] });
  for (let i = 0; i <= n; i++) { const x = xa + i * w;
    if (k.near) column(k, clampX(x, xa + 0.15, xb - 0.15), d - 0.3, 0, y, 0.09, { square: true, color: [0.82, 0.82, 0.8], blocks: false });
    if (i < n && i % 2 === 0) k.sign(MALL_SHOPS[hashInts(k.seed, 71, o.salt | 0, i) % MALL_SHOPS.length], hashInts(k.seed, 72, o.salt | 0, i), x + w / 2, y + 1.15, 0.05, { height: 0.9, maxWidth: w - 1.6, own: true });
    if (i < n && i % 2 === 1 && k.near) k.lamp(x + w / 2, y, d * 0.5, [1, 0.9, 0.74], { power: 24, radius: 7, radiance: 9, glow: 0.4, size: 0.1 });
    if (i < n && i % 3 === 1) k.plant(i % 2 ? 'royal' : 'coconut', x + w / 2, d + 2.2); }
}
const clampX = (x, a, b) => Math.max(a, Math.min(b, x));

/** Open-air mall: four two-storey wings of shops round a court, cars on the roof reached by a spiral ramp. */
export function courtMall(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = [0.93, 0.89, 0.8], seed = sb(k, TRIM.TURQUOISE, 1), x0 = -Wd / 2 + 16, x1 = Wd / 2 - 16, zb = -D / 2 + 8, zf = D / 2 - 14, wd = 24, G = 4.8, H = 9.6, aqua = [0.25, 0.7, 0.7];
  const shop = W('SHOPFRONT', 'RETAIL', 6, wall, seed), blank = W('BLANK', 'STUCCO', 6, wall, seed, true), svc = W('BLANK', 'SERVICE', 6, wall, seed);
  // wings: [x0, z0, x1, z1, class of the wall facing the court]
  const wings = [[x0, zf - wd, x1, zf, 'back'], [x0, zb, x1, zb + wd, 'front'], [x0, zb + wd, x0 + wd, zf - wd, 'right'], [x1 - wd, zb + wd, x1, zf - wd, 'left']];
  wings.forEach(([xa, za, xb, zc, court], i) => {
    const t = mass(k, rectRuns(xa, za, xb, zc), 0, [{ h: G, storey: G, spec: (r) => (r.cls === court || (i === 0 && r.cls === 'front') ? shop : i >= 2 && (r.cls === 'front' || r.cls === 'back') ? null : i === 1 && r.cls === 'back' ? svc : blank) }, { h: H - G, storey: H - G, grounded: false, spec: (r) => (r.cls === court ? shop : i >= 2 && (r.cls === 'front' || r.cls === 'back') ? null : blank) }], { parapet: 1.1, color: wall, seed, coping: aqua, roofKind: 3, roof: [0.33, 0.33, 0.34] });
    // gallery along the court at the upper level, on columns
    const cr = t.runs.find((r) => r.cls === court); k.onRun(cr, (len) => { if (k.far) return; k.concrete([0.8, 0.78, 0.74], 0, 50).occ(1).box(0, G - 0.3, 0, len, G, 3, 'xXZYy'); if (k.near) { railing(k, [[0, G, 2.9], [len, G, 2.9]], 1.05, { color: aqua }); for (let x = 3; x < len; x += 12) column(k, x, 2.7, 0, G - 0.3, 0.18, {}); } });
    if (k.near) { bayLines(k, xa + 2, xb - 2, za + 2, za + 7.2, 2.7, { y: H + 0.02 }); }
    if (i === 0) k.onRun(t.runs.find((r) => r.cls === 'front'), (len) => { arcade(k, 1, len / 2 - 10.5, { lip: aqua, salt: 1 }); arcade(k, len / 2 + 10.5, len - 1, { lip: aqua, salt: 2 }); });
  });
  k.at(0, 0, zf, 0, () => mallGate(k, 0, H, { w: 18, wall, neon: NEON.aqua })); k.at(x0, 0, 0, -Math.PI / 2, () => mallGate(k, 0, H, { w: 12, wall })); k.at(x1, 0, 0, Math.PI / 2, () => mallGate(k, 0, H, { w: 12, wall }));
  // court: paving band, a fountain, lamp standards
  if (!k.far) { k.tile([0.86, 0.78, 0.66], 30, 1).occ(1).quad([x0 + wd + 4, 0.03, zf - wd - 4], [x1 - wd - 4, 0.03, zf - wd - 4], [x1 - wd - 4, 0.03, zb + wd + 4], [x0 + wd + 4, 0.03, zb + wd + 4]);
    k.stucco([0.9, 0.88, 0.82], 80).cyl(0, 0, 0, 5, 0.6, { segs: k.near ? 20 : 10, cap: false }); k.solid(SOLID.POOL_WATER, [0.25, 0.76, 0.79], 6, 0).cyl(0, 0.44, 0, 4.8, 0.45, { segs: k.near ? 20 : 10 }); k.collide(-4, 0, -4, 4, 0.6, 4);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = sx * (x1 - wd - 14), z = sz * (zf - wd - 12); k.steel([0.2, 0.3, 0.3], 0.5, 30).occ(1).cyl(x, 0, z, 0.08, 5, { segs: 6, cap: false }); k.lamp(x, 5.2, z, [1, 0.9, 0.75], { power: 60, radius: 14, radiance: 16, glow: 0.7, size: 0.2 }); k.collide(x - 0.1, 0, z - 0.1, x + 0.1, 5, z + 0.1); } }
  // spiral ramp drum at the back corner
  const rx = x1 + 8, rz = zb + 12, rr = 7.5, segs = k.near ? 24 : k.far ? 6 : 12;
  k.concrete([0.74, 0.72, 0.68], 0, 90).occ(1).cyl(rx, 0, rz, 2.2, H + 1, { segs: Math.max(6, segs / 2) });
  if (!k.far) for (let i = 0; i < segs * 2; i++) { const t0 = i / segs * 2 * Math.PI, t1 = (i + 1) / segs * 2 * Math.PI, y0 = H * i / (segs * 2), y1 = H * (i + 1) / (segs * 2), p = (t, r, y) => [rx + r * Math.sin(t), y, rz + r * Math.cos(t)];
    k.concrete([0.7, 0.69, 0.66], 0, 70).occ(1).quad(p(t0, rr, y0), p(t1, rr, y1), p(t1, 2.2, y1), p(t0, 2.2, y0)); k.occ(0.55).quad(p(t1, rr, y1 - 0.3), p(t0, rr, y0 - 0.3), p(t0, 2.2, y0 - 0.3), p(t1, 2.2, y1 - 0.3)); k.occ(1).quad(p(t0, rr, y0 - 0.3), p(t1, rr, y1 - 0.3), p(t1, rr, y1 + 0.9), p(t0, rr, y0 + 0.9)); k.quad(p(t1, rr - 0.15, y1 - 0.3), p(t0, rr - 0.15, y0 - 0.3), p(t0, rr - 0.15, y0 + 0.9), p(t1, rr - 0.15, y1 + 0.9)); }
  else k.concrete([0.72, 0.7, 0.67], 0, 90).cyl(rx, 0, rz, rr, H, { segs });
  k.collide(rx - rr * 0.8, 0, rz - rr * 0.8, rx + rr * 0.8, H + 1, rz + rr * 0.8);
  for (const s of [-1, 1]) bayLines(k, x0, x1, s > 0 ? zf + 5 : zb - 6, s > 0 ? zf + 10.4 : zb - 0.6, 2.8);
}
/** Enclosed mall on an H plan: two long ranges joined by a sky-lit concourse, anchor stores at the ends, a car park deck. */
export function hMall(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = [0.94, 0.92, 0.86], seed = sb(k, TRIM.STRAW, 1), H = 11, G = 5.5, band = [0.86, 0.78, 0.6];
  const blank = W('BLANK', 'STUCCO', 7, wall, seed, true), tile = W('BLANK', 'TILE', 7, [0.9, 0.87, 0.8], seed), svc = W('BLANK', 'SERVICE', 7, wall, seed);
  const bx = Wd / 2 - 78, range = (xa, xb, za, zc, shops) => { const t = mass(k, rectRuns(xa, za, xb, zc), 0, [{ h: G, storey: G, spec: (r) => (r.cls === shops ? W('SHOPFRONT', 'RETAIL', 7, wall, seed) : r.cls === 'back' ? svc : tile) }, { h: H - G, storey: H - G, grounded: false, spec: blank }], { parapet: 1.2, color: wall, seed, coping: band, roofKind: 3, roof: [0.86, 0.85, 0.82] }); if (!k.far) k.ledge(t.runs, G - 0.25, G + 0.25, 0.15, { lip: band }); roofPlant(k, xa + 3, za + 3, xb - 3, zc - 3, t.roofY, { core: false, units: 6, tank: false, aerial: false }); return t; };
  const zA = D / 2 - 62, zB = -D / 2 + 20;                           // front range, back range, the bar between them
  const fr = range(-bx, bx, zA, zA + 36, 'front'), bk = range(-bx, bx, zB, zB + 36), bar = range(-22, 22, zB + 36, zA);
  // anchors: taller blocks on the four ends, each with its own big sign
  [[-1, zA], [1, zA], [-1, zB], [1, zB]].forEach(([s, z], i) => { const xa = s < 0 ? -bx - 6 : bx - 30, t = mass(k, rectRuns(xa, z - 4, xa + 36, z + 40), 0, [{ h: 4.4, storey: 4.4, spec: (r) => (r.cls === (i < 2 ? 'front' : 'back') ? W('SHOPFRONT', 'SHOWROOM', 6, wall, seed) : blank) }, { h: H - 1.2, storey: H - 1.2, grounded: false, spec: (r) => (r.cls === (i < 2 ? 'front' : 'back') ? W('BLANK', 'TILE', 7, [0.88, 0.84, 0.76], seed) : blank) }], { parapet: 1.0, color: wall, seed, coping: band, roofKind: 3, roof: [0.86, 0.85, 0.82] });
    k.onRun(t.runs.find((r) => r.cls === (i < 2 ? 'front' : 'back')), (len) => { canopy(k, 1.5, len - 1.5, 4.4, 3.6, { th: 0.5, lip: band, lamps: 6, far: true }); doorway(k, len / 2, 0, 4, 2.6, { leaves: 2 }); k.sign(['shop', 'market', 'pharmacy', 'shop'][i], hashInts(k.seed, i), len / 2, H + 0.4, 0.05, { height: 2.6, maxWidth: len - 10, far: true, own: true });
      if (!k.far) { for (let x = 1.8; x < len - 1; x += (len - 3.6) / 6) column(k, x, 3.3, 0, 4.4, 0.12, { square: true, color: [0.82, 0.82, 0.8], blocks: false }); if (i < 2) for (const f of [0.2, 0.8]) k.plant('royal', len * f, 6.4); } }); });
  k.onRun(front(fr), (len) => { arcade(k, 36.5, len / 2 - 12.5, { lip: band, y: 3.9, salt: 1 }); arcade(k, len / 2 + 12.5, len - 36.5, { lip: band, y: 3.9, salt: 2 }); });
  k.at(0, 0, zA + 36, 0, () => mallGate(k, 0, H, { w: 22, wall, neon: NEON.pink })); k.at(0, 0, zB, Math.PI, () => mallGate(k, 0, H, { w: 16, wall }));
  // glazed vault along the concourse and over the bar
  if (!k.far) { k.glass([0.3, 0.42, 0.45], 0.08).occ(1); for (const [xa, xb, za, zc] of [[-bx + 20, bx - 20, zA + 15, zA + 21], [-bx + 20, bx - 20, zB + 15, zB + 21]]) { k.quad([xa, fr.top, zc], [xb, fr.top, zc], [xb, fr.top + 2.6, (za + zc) / 2], [xa, fr.top + 2.6, (za + zc) / 2]); k.quad([xb, fr.top, za], [xa, fr.top, za], [xa, fr.top + 2.6, (za + zc) / 2], [xb, fr.top + 2.6, (za + zc) / 2]); k.tri3([xb, fr.top, zc], [xb, fr.top, za], [xb, fr.top + 2.6, (za + zc) / 2]); k.tri3([xa, fr.top, za], [xa, fr.top, zc], [xa, fr.top + 2.6, (za + zc) / 2]); } }
  // multi-storey car park at one end
  part(k, parkingGarage, { width: 62, depth: 46, floors: 4, variant: 0 }, { x: Wd / 2 - 36, z: 0, yaw: -Math.PI / 2, salt: 9 });
  for (const z of [D / 2 - 20, D / 2 - 9]) bayLines(k, -bx - 6, bx + 6, z, z + 5.4, 2.8); bayLines(k, -bx, bx, -D / 2 + 6, -D / 2 + 11.4, 2.8);
  for (const s of [-1, 1]) floodMast(k, s * bx * 0.5, D / 2 - 12, 14, 0, 0.4, { power: 300, radius: 34 });
  return { fr, bk, bar };
}

// ------------------------------------------------------------------------------------------------ film studio
export function filmStudio(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = [0.9, 0.86, 0.76], seed = sb(k, TRIM.OXBLOOD, 1), x0 = -Wd / 2 + 1, x1 = Wd / 2 - 1, zb = -D / 2 + 1, zf = D / 2 - 1;
  compound(k, x0, zb, x1, zf, { x: 0, w: 12 }, { h: 2.7, color: wall, piers: 8 });
  // gate arch: two towers with tile caps and a sign bridge between them
  for (const s of [-1, 1]) { mass(k, rectRuns(s * 8.2 - 2.2, zf - 3, s * 8.2 + 2.2, zf + 1), 0, [{ h: 7.5, storey: 2.5, spec: W('BLANK', 'STUCCO', 4, wall, seed, true) }], { roof: null }); pitchedRoof(k, s * 8.2 - 2.2, zf - 3, s * 8.2 + 2.2, zf + 1, 7.5, { pitch: 0.5, over: 0.4, kind: 1, color: ROOF_TILE[0] }); }
  if (!k.far) k.stucco(wall, 70).occ(1).box(-6, 5.6, zf - 1.2, 6, 7.3, zf + 0.2, 'zZYy');
  k.at(0, 0, zf + 0.2, 0, () => { nameSign(k, 0, 6.45, 0.03, { height: 1.3, maxWidth: 11, far: true }); if (!k.far) k.neon([[-6, 5.7, 0.06], [6, 5.7, 0.06]], NEON.warm, { back: [0, 0, -1], maxLights: 2 }); });
  barrier(k, -5.8, -0.2, zf - 3.2); barrier(k, 5.8, 0.2, zf - 3.2);
  // three sound stages: blank boxes with a stage number, elephant doors on the lot side, vents on the roof
  [[-46, -12, 1], [0, -22, 2], [46, -12, 3]].forEach(([cx, cz, no]) => { const t = mass(k, rectRuns(cx - 15, cz - 22.5, cx + 15, cz + 22.5), 0, [{ h: 13, storey: 13, spec: (r) => (r.cls === 'front' ? { style: F('WAREHOUSE', 'DOORS'), bays: 2, color: wall, seed } : W('WAREHOUSE', 'TILT_UP', 7.5, wall, seed)) }], { parapet: 0.8, color: wall, seed, coping: [0.56, 0.2, 0.16], roofKind: 3, roof: [0.8, 0.8, 0.78] });
    k.onRun(front(t), (len) => { numeral(k, no, len - 4, 8.4, 3.2, [0.56, 0.2, 0.16]); if (!k.far) k.lamp(len / 2, 7.2, 0.5, [1, 0.85, 0.6], { power: 60, radius: 14, radiance: 14, glow: 0.6, spot: [0, -1, 0.3], outer: 70, inner: 40 }); });
    k.onRun(t.runs.find((r) => r.cls === 'left'), (len) => numeral(k, no, 5, 8.4, 3.2, [0.56, 0.2, 0.16]));
    roofPlant(k, cx - 13, cz - 20, cx + 13, cz + 20, t.roofY, { core: false, units: 6, tank: false, aerial: false }); });
  // water tower with the studio's name round the tank
  const tx = 26, tz = zf - 18, r = 3.2, ty = 17;
  if (!k.far) { k.steel(STEEL, 0.5, 80).occ(1); for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { k.pipe([[tx + sx * 3.4, 0, tz + sz * 3.4], [tx + sx * 2.3, ty, tz + sz * 2.3]], 0.14, k.near ? 6 : 3); if (k.near) k.pipe([[tx + sx * 3.1, 5, tz + sz * 3.1], [tx - sz * 2.8, 10, tz + sx * 2.8]], 0.05, 3); } k.cyl(tx, 0, tz, 0.25, ty, { segs: 6, cap: false }); }
  k.paint([0.9, 0.9, 0.88], 0.5, 90).occ(1).cyl(tx, ty, tz, r, ty + 5, { segs: k.near ? 16 : 8, bottom: true, cap: false }).cyl(tx, ty + 5, tz, r + 0.15, ty + 7, { segs: k.near ? 16 : 8, r1: 0.2 });
  k.at(tx, 0, tz + r + 0.05, 0, () => nameSign(k, 0, ty + 2.6, 0, { height: 1.1, maxWidth: 5.2, far: true, lit: false, wallColor: [0.9, 0.9, 0.88] })); beacon(k, tx, ty + 7.2, tz); k.collide(tx - 3.5, 0, tz - 3.5, tx + 3.5, ty + 7, tz + 3.5);
  // production bungalows inside the gate
  for (const s of [-1, 1]) part(k, bungalow, { width: 16, depth: 20, variant: 0 }, { x: s * 40, z: zf - 14, salt: s + 2 });
  bayLines(k, -24, -10, zf - 9, zf - 3.6, 2.7);
}

// ------------------------------------------------------------------------------------------------ docks
/** Ship-to-shore gantry crane on four legs: portal, machinery house, apex frame and a boom reaching out over -z. */
function gantryCrane(k, x, z, o = {}) {
  const g = 22, base = 16, yb = 30, apex = 56, out = 36, back = 14, col = o.color ?? [0.82, 0.3, 0.12], seg = k.near ? 4 : 3;
  if (k.far) { k.steel(col, 0.5, 80).occ(1).box(x - 1, yb - 2, z - out, x + 1, yb, z + g + back, 'xXzZYy'); for (const sx of [-1, 1]) for (const sz of [0, g]) k.box(x + sx * base / 2 - 0.9, 0, z + sz - 0.9, x + sx * base / 2 + 0.9, yb, z + sz + 0.9, 'xXzZY'); for (const sz of [0, g]) k.box(x - base / 2, yb - 2, z + sz - 0.7, x + base / 2, yb, z + sz + 0.7, 'zZYy'); beacon(k, x, apex + 0.3, z + g * 0.5); return; }
  k.steel(col, 0.5, 80).occ(1);
  for (const sx of [-1, 1]) for (const sz of [0, g]) { k.box(x + sx * base / 2 - 0.6, 0.8, z + sz - 0.6, x + sx * base / 2 + 0.6, yb, z + sz + 0.6, 'xXzZ'); k.steel([0.2, 0.2, 0.22], 0.6, 90).box(x + sx * base / 2 - 1.6, 0, z + sz - 0.7, x + sx * base / 2 + 1.6, 0.8, z + sz + 0.7); k.steel(col, 0.5, 80); k.collide(x + sx * base / 2 - 1.6, 0, z + sz - 0.7, x + sx * base / 2 + 1.6, yb, z + sz + 0.7); }
  for (const sz of [0, g]) { k.box(x - base / 2, yb - 1.6, z + sz - 0.5, x + base / 2, yb, z + sz + 0.5, 'xXzZYy').box(x - base / 2, 12, z + sz - 0.4, x + base / 2, 13, z + sz + 0.4, 'xXzZYy'); if (k.near) k.pipe([[x - base / 2, 13, z + sz], [x + base / 2, yb - 1.6, z + sz]], 0.2, seg).pipe([[x + base / 2, 13, z + sz], [x - base / 2, yb - 1.6, z + sz]], 0.2, seg); }
  for (const sx of [-1, 1]) k.box(x + sx * base / 2 - 0.5, yb - 1.6, z, x + sx * base / 2 + 0.5, yb, z + g, 'xXzZYy');
  // boom girder: two box beams out over the water and back over the quay
  for (const sx of [-1, 1]) k.box(x + sx * 3 - 0.6, yb, z - out, x + sx * 3 + 0.6, yb + 2, z + g + back, 'xXzZYy');
  if (k.near) for (let zz = z - out + 4; zz < z + g + back; zz += 8) k.box(x - 3, yb + 0.6, zz - 0.2, x + 3, yb + 1.2, zz + 0.2, 'zZYy');
  // apex frame and stays
  for (const sx of [-1, 1]) { k.pipe([[x + sx * 3, yb + 2, z + 1], [x + sx * 1.2, apex, z + 5]], 0.35, seg).pipe([[x + sx * 3, yb + 2, z + g - 1], [x + sx * 1.2, apex, z + 5]], 0.3, seg); k.pipe([[x + sx * 1.2, apex, z + 5], [x + sx * 3, yb + 2, z - out + 3]], 0.12, 3).pipe([[x + sx * 1.2, apex, z + 5], [x + sx * 3, yb + 2, z - out * 0.5]], 0.12, 3).pipe([[x + sx * 1.2, apex, z + 5], [x + sx * 3, yb + 2, z + g + back - 2]], 0.12, 3); }
  k.box(x - 1.4, apex - 0.4, z + 4.4, x + 1.4, apex + 0.4, z + 5.6, 'xXzZYy');
  // machinery house, operator's cab hanging under the boom, the spreader on its ropes
  k.steel([0.86, 0.86, 0.84], 0.5, 70).box(x - 4.5, yb + 2, z + g - 4, x + 4.5, yb + 6.5, z + g + 8, 'xXzZYy'); k.steel([0.86, 0.86, 0.84], 0.5, 40).box(x - 1.3, yb - 3, z - 9, x + 1.3, yb - 0.3, z - 6, 'xXzZYy');
  if (k.near) { k.glass([0.15, 0.2, 0.22]).box(x - 1.32, yb - 2.4, z - 9.02, x + 1.32, yb - 1.2, z - 8.4, 'xXz'); k.steel([0.9, 0.8, 0.1], 0.5, 60).box(x - 3, yb - 13, z - 22, x + 3, yb - 12.5, z - 20.8, 'xXzZYy'); k.steel([0.1, 0.1, 0.1], 0.6, 0); for (const sx of [-2.6, 2.6]) k.pipe([[x + sx, yb, z - 21.4], [x + sx, yb - 12.5, z - 21.4]], 0.03, 3); }
  k.lamp(x, yb - 0.1, z - 12, [1, 0.9, 0.75], { power: 220, flood: true, radius: 34, radiance: 24, glow: 1.4, size: 0.4, spot: [0, -1, 0], outer: 60, inner: 35, far: true }); k.lamp(x, yb - 1.7, z + g / 2, [1, 0.9, 0.75], { power: 160, flood: true, radius: 30, radiance: 20, glow: 1.0, size: 0.3, spot: [0, -1, 0], outer: 60, inner: 35 });
  beacon(k, x, apex + 0.6, z + 5); beacon(k, x, yb + 2.2, z - out + 0.5);
}
const BOX_COLORS = [[0.62, 0.2, 0.14], [0.16, 0.32, 0.5], [0.2, 0.42, 0.3], [0.78, 0.5, 0.12], [0.55, 0.56, 0.56], [0.75, 0.72, 0.6], [0.4, 0.16, 0.2]];
/** A stack of shipping containers: rows along x, up to `high` tiers, colours and gaps from the seed. */
function containerStack(k, x0, z0, nx, nz, high, salt) {
  const L = 12.2, Wc = 2.44, Hc = 2.6, r = (i) => hashInts(k.seed, salt, i) / 4294967296;
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const n = Math.floor(r(ix * 31 + iz * 7) * (high + 1)); if (!n) continue;
    const xa = x0 + ix * (L + 0.4), za = z0 + iz * (Wc + 0.25);
    if (k.far) { k.steel(BOX_COLORS[Math.floor(r(ix + iz * 13 + 5) * 7)], 0.6, 90).occ(1).box(xa, 0, za, xa + L, n * Hc, za + Wc); continue; }
    for (let t = 0; t < n; t++) { k.solid(SOLID.METAL_PAINTED, BOX_COLORS[Math.floor(r(ix * 3 + iz * 13 + t * 101) * 7)], 150, 70 + Math.floor(r(t + ix) * 80)).occ(1).box(xa, t * Hc, za, xa + L, (t + 1) * Hc, za + Wc, t === n - 1 ? 'xXzZY' : 'xXzZ'); }
    k.collide(xa, 0, za, xa + L, n * Hc, za + Wc);
  }
}
export function docks(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], zq = -D / 2 + 6;
  // quay edge along the back: cranes on their rails
  const nc = 3; for (let i = 0; i < nc; i++) gantryCrane(k, -Wd / 2 + 50 + i * (Wd - 100) / (nc - 1), zq + 8, { color: i === 1 ? [0.2, 0.36, 0.55] : [0.82, 0.3, 0.12] });
  if (!k.far) { k.steel([0.3, 0.3, 0.32], 0.6, 120).occ(1); for (const z of [zq + 8, zq + 30]) k.box(-Wd / 2 + 8, 0.03, z - 0.12, Wd / 2 - 8, 0.1, z + 0.12, 'xXzZY'); k.paint([0.85, 0.7, 0.1], 0.8, 150).quad([-Wd / 2 + 4, 0.03, zq + 1.2], [Wd / 2 - 4, 0.03, zq + 1.2], [Wd / 2 - 4, 0.03, zq + 0.8], [-Wd / 2 + 4, 0.03, zq + 0.8]);
    for (let x = -Wd / 2 + 12; x < Wd / 2 - 8; x += 24) { k.steel([0.15, 0.15, 0.16], 0.6, 100).cyl(x, 0, zq + 1.8, 0.3, 0.55, { segs: 6 }); k.collide(x - 0.3, 0, zq + 1.5, x + 0.3, 0.55, zq + 2.1); } }
  // container yard in blocks with lanes between, light masts at the lane ends
  for (let b = 0; b < 4; b++) containerStack(k, -Wd / 2 + 14 + b * 60, zq + 44, 4, k.far ? 2 : 8, 3, b + 1);
  for (let b = 0; b < 4; b++) floodMast(k, -Wd / 2 + 10 + b * 60 + 50, zq + 40, 26, 0, 0.3, { power: 420, radius: 50, r: 0.3 });
  // the quay itself and the gate apron are lit too: a port works all night
  for (let i = 0; i < nc; i++) floodMast(k, -Wd / 2 + 50 + i * (Wd - 100) / (nc - 1) + 18, zq + 24, 22, 0, -0.5, { power: 360, radius: 44, r: 0.28 });
  for (const x of [-14, 40]) floodMast(k, x, D / 2 - 6, 18, 0, 0.2, { power: 260, radius: 36, r: 0.25 });
  // transit sheds and the gatehouse along the street side
  part(k, warehouse, { width: 84, depth: 42, floors: 2, variant: 0 }, { x: -Wd / 2 + 60, z: D / 2 - 28, salt: 1, named: true });
  part(k, warehouse, { width: 70, depth: 40, floors: 1, variant: 2 }, { x: Wd / 2 - 52, z: D / 2 - 27, salt: 2 });
  compound(k, -Wd / 2 + 1, zq + 38, Wd / 2 - 1, D / 2 - 1, { x: 12, w: 14 }, { h: 2.4, t: 0.1, style: 'rail', color: [0.66, 0.65, 0.62], rail: [0.6, 0.62, 0.63] });
  barrier(k, 5.2, 11.8, D / 2 - 2); barrier(k, 18.8, 12.2, D / 2 - 2);
}
export function boatyard(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1];
  part(k, warehouse, { width: Wd * 0.55, depth: D - 12, floors: 2, variant: 0 }, { x: -Wd * 0.2, z: 2, named: true, paint: { wall: [0.44, 0.55, 0.65], trim: TRIM.NAVY, age: 2 } });
  // slipway rails and a cradle with a hull on it, a timber jetty behind
  const sx = Wd * 0.28;
  if (!k.far) { k.concrete([0.64, 0.63, 0.6], 20, 130).occ(1).box(sx - 5, 0, -D / 2 + 2, sx + 5, 0.12, D / 2 - 10, 'xXzZY'); k.steel([0.3, 0.3, 0.32], 0.6, 140); for (const s of [-1.6, 1.6]) k.box(sx + s - 0.07, 0.12, -D / 2 + 2, sx + s + 0.07, 0.26, D / 2 - 10, 'xXzZY');
    k.steel(STEEL, 0.6, 120).box(sx - 2.2, 0.26, 2, sx + 2.2, 0.7, 12, 'xXzZYy'); k.paint([0.9, 0.9, 0.88], 0.4, 60).box(sx - 1.7, 1.6, 0.5, sx + 1.7, 3.0, 13.5, 'xXzZY'); k.paint([0.12, 0.25, 0.45], 0.4, 80); tiltSlab(k, sx - 1.7, 0.5, sx, 13.5, 1.6, 0.75, 0.05); tiltSlab(k, sx, 0.5, sx + 1.7, 13.5, 0.75, 1.6, 0.05);
    k.paint([0.9, 0.9, 0.88], 0.4, 60).box(sx - 1.1, 3.0, 5, sx + 1.1, 4.3, 10, 'xXzZY'); k.collide(sx - 2.2, 0, 0.5, sx + 2.2, 4.3, 13.5);
    k.solid(SOLID.WOOD, [0.5, 0.42, 0.33], 190, 180).box(-Wd / 2 + 4, 0.5, -D / 2 + 1, -Wd / 2 + 7, 0.7, -D / 2 + 9, 'xXzZYy'); }
}

// ------------------------------------------------------------------------------------------------ airport
/** Control tower: a tapering concrete shaft, a walkway, a cab of outward-canted glass under a flat cap. */
export function controlTower(k, x, z, H) {
  const segs = k.near ? 8 : k.far ? 4 : 8, yc = H - 9.5;
  k.concrete([0.8, 0.79, 0.76], 30, 70).occ(1).cyl(x, 0, z, 4.2, yc, { segs, r1: 3.3, cap: false });
  k.concrete([0.74, 0.73, 0.7], 0, 70).cyl(x, yc, z, 3.3, yc + 2.2, { segs, r1: 6.2, bottom: true });
  k.glass([0.16, 0.26, 0.28], 0.05).cyl(x, yc + 2.2, z, 5.6, yc + 5.6, { segs, r1: 6.6, cap: false });
  k.paint([0.9, 0.9, 0.88], 0.5, 50).cyl(x, yc + 5.6, z, 7.0, yc + 6.5, { segs, bottom: true });
  if (k.near) { const ring = []; for (let i = 0; i <= 8; i++) { const a = (i + 0.5) / 8 * 2 * Math.PI; ring.push([x + 6.1 * Math.sin(a), yc + 2.2, z + 6.1 * Math.cos(a)]); } railing(k, ring, 1.0, { color: [0.3, 0.3, 0.32] }); k.at(x, 0, z + 4.2, 0, () => doorway(k, 0, 0, 1.2, 2.1, { leaves: 1 })); }
  if (!k.far) { k.steel([0.9, 0.9, 0.9], 0.4, 30).occ(1).cyl(x - 2, yc + 6.5, z - 2, 0.9, yc + 7.4, { segs: 8 }).ball(x - 2, yc + 8.2, z - 2, 0.9, { segs: 8 }); k.light(x, yc + 3.5, z, [2, 6, 4.5], 14, CHANNEL.WINDOW); }
  k.glow(x, yc + 3.9, z, 4, [0.15, 0.5, 0.35], CHANNEL.WINDOW, 2, true);
  mast(k, x + 2, yc + 6.5, z + 1, 7, { r: 0.1 }); k.collide(x - 3.6, 0, z - 3.6, x + 3.6, yc + 6.5, z + 3.6);
}
/** Fan-shaped terminal: wedge-shaped halls on a shallow arc under a folded-plate roof, glass towards the apron. */
export function terminalFan(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], seed = sb(k, TRIM.TURQUOISE, 0), conc = [0.86, 0.85, 0.82], H = 12, n = 7, R = 300, cz = D / 2 - 22 - R, span = (Wd - 70) / R, dep = 44;
  for (let i = 0; i < n; i++) {
    const t = -span / 2 + span * (i + 0.5) / n, w = 2 * R * Math.tan(span / n / 2) + 0.4, x = R * Math.sin(t), z = cz + R * Math.cos(t);
    k.at(x, 0, z, t, () => {
      const hall = mass(k, rectRuns(-w / 2, -dep, w / 2, 0), 0, [{ h: 6, storey: 6, spec: (r) => (r.cls === 'front' ? W('SHOPFRONT', 'OFFICE_LOBBY', 4, conc, seed) : r.cls === 'back' ? W('CURTAIN', 'GRID', 2, [0.25, 0.49, 0.53], seed) : null) }, { h: 6, storey: 6, grounded: false, spec: (r) => (r.cls === 'front' ? W('CURTAIN', 'PIERS', 2, [0.25, 0.49, 0.53], seed) : r.cls === 'back' ? W('CURTAIN', 'GRID', 2, [0.25, 0.49, 0.53], seed) : (i === 0 && r.cls === 'left') || (i === n - 1 && r.cls === 'right') ? W('BLANK', 'CONCRETE', 6, conc, seed) : null) }], { roof: null });
      if (i === 0 || i === n - 1) k.walls([i === 0 ? hall.runs.find((r) => r.cls === 'left') : hall.runs.find((r) => r.cls === 'right')], 0, [{ h: 6, storey: 6, spec: W('BLANK', 'CONCRETE', 6, conc, seed) }]);
      // woven roof: folded plates running front to back, oversailing the kerb and the apron
      const folds = k.far ? 1 : 4, fw = w / folds; k.roofing(3, [0.9, 0.89, 0.86], 70).occ(1);
      for (let f = 0; f < folds; f++) { const xa = -w / 2 + f * fw; if (k.far) { k.box(xa, H, -dep - 4, xa + fw, H + 1.2, 9, 'xXzZYy'); continue; } tiltSlab(k, xa, -dep - 5, xa + fw / 2, 10, H, H + 2.4, 0.18); tiltSlab(k, xa + fw / 2, -dep - 5, xa + fw, 10, H + 2.4, H, 0.18); }
      if (!k.far) { for (const s of [-1, 1]) column(k, s * (w / 2 - 0.6), 8.5, 0, H, 0.35, { round: true }); for (const f of [0.25, 0.75]) k.lamp(-w / 2 + w * f, H - 0.2, 5, [1, 0.92, 0.8], { power: 90, radius: 16, radiance: 16, glow: 0.7, size: 0.25 }); doorway(k, 0, 0, 4, 2.6, { leaves: 2 }); }
      for (const s of [-1, 1]) k.collide(s * (w / 2 - 0.6) - 0.4, 0, 8.1, s * (w / 2 - 0.6) + 0.4, H, 8.9);
      if (i === (n >> 1)) roofSign(k, 0, H + 2.4, 6, { category: 'landmark:' + m.id, height: 2.6, maxWidth: w * 1.6, neon: NEON.aqua, far: true, leg: 0.6 });
      // a pier out to the stands from every other hall
      if (i % 2 === 1) { mass(k, rectRuns(-4, -dep - 26, 4, -dep), 3.6, [{ h: 3.6, storey: 3.6, grounded: false, spec: W('PUNCHED', 'RIBBON', 3, conc, seed) }], { roof: [0.8, 0.8, 0.78], roofKind: 3, collide: false }); if (!k.far) { k.concrete(conc, 0, 80).occ(0.6).cap([[-4, -dep - 26], [4, -dep - 26], [4, -dep], [-4, -dep]], 3.6, true); k.occ(1); for (const zz of [-dep - 24, -dep - 12]) k.box(-1, 0, zz - 1, 1, 3.6, zz + 1, 'xXzZ'); } for (const zz of [-dep - 24, -dep - 12]) k.collide(-1, 0, zz - 1, 1, 3.6, zz + 1); }
    });
  }
  controlTower(k, Wd / 2 - 20, D / 2 - 30, 48);
}
/** The older terminal: a long concrete block with a taller central hall, a kerbside canopy on columns, a roof deck. */
export function terminalBlock(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], seed = sb(k, TRIM.SLATE, 2), conc = [0.8, 0.78, 0.73], x0 = -Wd / 2 + 12, x1 = Wd / 2 - 12, zf = D / 2 - 20, zb = -D / 2 + 14;
  const wings = block(k, x0, zb, x1, zf, { floors: 2, ground: 5, storey: 4.5, wall: conc, seed, coping: [0.3, 0.42, 0.5], roofKind: 3, roof: [0.74, 0.73, 0.7], groundSpec: (r) => (r.cls === 'front' ? W('SHOPFRONT', 'OFFICE_LOBBY', 4.5, conc, seed) : r.cls === 'back' ? W('PUNCHED', 'RIBBON', 4.5, conc, seed) : W('BLANK', 'CONCRETE', 6, conc, seed)), upperSpec: (r) => (r.cls === 'left' || r.cls === 'right' ? W('BLANK', 'CONCRETE', 6, conc, seed) : W('PUNCHED', 'EGGCRATE', 4.5, conc, seed)) });
  const hall = mass(k, rectRuns(-34, zb + 4, 34, zf + 3), wings.roofY, [{ h: 4.5, storey: 4.5, grounded: false, spec: (r) => (r.cls === 'front' || r.cls === 'back' ? W('CURTAIN', 'PIERS', 2.2, [0.23, 0.27, 0.31], seed) : W('BLANK', 'CONCRETE', 6, conc, seed)) }], { parapet: 0.8, color: conc, seed, roofKind: 3, roof: [0.74, 0.73, 0.7], collide: false });
  k.collide(-34, wings.roofY, zb + 4, 34, hall.top, zf); roofPlant(k, x0 + 3, zb + 3, -38, zf - 3, wings.roofY, { units: 6, tank: false, aerial: false }); roofPlant(k, 38, zb + 3, x1 - 3, zf - 3, wings.roofY, { units: 6, tank: false, aerial: false, salt: 3 });
  k.onRun(front(wings), (len) => { canopy(k, 6, len - 6, 4.2, 9, { th: 0.5, lip: [0.3, 0.42, 0.5], lamps: k.near ? 14 : 0, far: true });
    for (let x = 9; x <= len - 9; x += (len - 18) / 15) { if (!k.far) column(k, x, 8.2, 0, 4.2, 0.25, {}); k.collide(x - 0.3, 0, 7.9, x + 0.3, 4.2, 8.5); }
    for (const f of [0.2, 0.5, 0.8]) doorway(k, len * f, 0, 4, 2.6, { leaves: 2 }); });
  k.at(0, 0, zf + 3, 0, () => nameSign(k, 0, wings.roofY + 2.6, 0.06, { height: 2.2, maxWidth: 60, far: true }));
  // observation deck rail and the radar on the roof
  if (k.near) railing(k, [[x0 + 1, wings.top, zb + 0.6], [-35, wings.top, zb + 0.6]], 1.0, { color: [0.3, 0.42, 0.5] });
  if (!k.far) { k.steel([0.85, 0.85, 0.85], 0.5, 40).occ(1).cyl(20, hall.top, zb + 12, 0.4, hall.top + 5, { segs: 6 }); k.steel([0.8, 0.3, 0.1], 0.5, 40).box(16, hall.top + 5, zb + 11.6, 24, hall.top + 6.6, zb + 12.4, 'xXzZYy'); }
  beacon(k, 20, hall.top + 6.9, zb + 12); beacon(k, x0 + 1, wings.top + 0.2, zf - 1); beacon(k, x1 - 1, wings.top + 0.2, zf - 1);
  bayLines(k, x0, x1, D / 2 - 7, D / 2 - 1.6, 2.7);
}
/** A row of hangars and freight sheds along the long axis of the lot, doors to the apron (side: +1 = +X, -1 = -X). */
export function hangarRow(k, m, side = 1) {
  const Wd = m.footprint[0], D = m.footprint[1], n = Math.max(2, Math.floor(D / 64)), pitch = D / n;
  for (let i = 0; i < n; i++) { const z = -D / 2 + pitch * (i + 0.5), freight = i % 3 === 2;
    if (freight) part(k, warehouse, { width: pitch - 8, depth: Wd - 8, floors: 2, variant: i % 2 ? 0 : 2 }, { x: 0, z, yaw: side * Math.PI / 2, salt: i });
    else part(k, hangar, { width: pitch - 6, depth: Wd - 4, variant: i % 3, wallColor: i % 2 ? [0.78, 0.8, 0.8] : [0.85, 0.82, 0.72] }, { x: 0, z, yaw: side * Math.PI / 2, salt: i, named: i === 0 }); }
}

// ------------------------------------------------------------------------------------------------ yards
const CAR_COLORS = [[0.5, 0.12, 0.1], [0.15, 0.25, 0.4], [0.7, 0.68, 0.6], [0.2, 0.32, 0.22], [0.75, 0.55, 0.15], [0.35, 0.35, 0.37], [0.6, 0.3, 0.14]];
export function scrapyard(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], x0 = -Wd / 2 + 1, x1 = Wd / 2 - 1, zb = -D / 2 + 1, zf = D / 2 - 1, r = (i) => hashInts(k.seed, 77, i) / 4294967296;
  compound(k, x0, zb, x1, zf, { x: -20, w: 10 }, { h: 3, t: 0.1, style: 'rail', color: [0.5, 0.42, 0.34], rail: [0.45, 0.36, 0.28] });
  k.at(-20, 0, zf, 0, () => { if (!k.far) { k.steel([0.4, 0.3, 0.24], 0.6, 200).occ(1); for (const s of [-5.2, 5.2]) k.box(s - 0.15, 0, -0.15, s + 0.15, 5.6, 0.15, 'xXzZ'); } k.steel([0.4, 0.3, 0.24], 0.6, 200).occ(1).box(-5.2, 4.4, -0.1, 5.2, 5.6, 0.1, 'xXzZYy'); nameSign(k, 0, 5.0, 0.11, { height: 1.0, maxWidth: 9.6, far: true, wallColor: [0.4, 0.3, 0.24] }); });
  // stacks of crushed cars in rows
  for (let row = 0; row < 5; row++) for (let i = 0; i < 9; i++) {
    const n = 1 + Math.floor(r(row * 40 + i) * 4.5), x = x0 + 12 + i * 13.5 + r(row * 7 + i + 900) * 3, z = zb + 14 + row * 27; if (r(row * 13 + i + 300) < 0.2) continue;
    if (k.far) { if (n > 2) k.steel(CAR_COLORS[i % 7], 0.7, 200).occ(1).box(x, 0, z, x + 4.4, n * 0.75, z + 5.4); continue; }
    for (let t = 0; t < n; t++) for (let c = 0; c < 3; c++) { if (!k.near && c) break; const w = k.near ? 1.75 : 5.4; k.solid(SOLID.METAL_PAINTED, CAR_COLORS[Math.floor(r(row * 97 + i * 11 + t * 5 + c) * 7)], 180, 150 + Math.floor(r(t + c + i) * 100)).occ(0.9).box(x + (r(t * 3 + c + i) - 0.5) * 0.3, t * 0.75, z + c * 1.82, x + 4.4 + (r(t * 5 + c + i) - 0.5) * 0.3, t * 0.75 + 0.7, z + c * 1.82 + w, t === n - 1 ? 'xXzZY' : 'xXzZ'); }
    k.collide(x, 0, z, x + 4.4, n * 0.75, z + 5.4);
  }
  // crusher shed, a crawler crane with a grab, the office hut by the gate
  part(k, warehouse, { width: 30, depth: 22, floors: 1, variant: 0 }, { x: x1 - 24, z: zb + 20, yaw: -Math.PI / 2, salt: 4, paint: { age: 3 } });
  const cx = 10, cz = 0;
  if (!k.far) { k.steel([0.78, 0.6, 0.1], 0.6, 160).occ(1).box(cx - 2.2, 0.9, cz - 2.8, cx + 2.2, 3.4, cz + 2.8, 'xXzZYy'); k.steel([0.12, 0.12, 0.13], 0.7, 100).box(cx - 2.6, 0, cz - 3.3, cx - 1.6, 0.9, cz + 3.3).box(cx + 1.6, 0, cz - 3.3, cx + 2.6, 0.9, cz + 3.3);
    k.steel([0.78, 0.6, 0.1], 0.6, 160).pipe([[cx, 3.0, cz + 2.4], [cx, 19, cz + 15]], 0.35, 4).pipe([[cx, 4.4, cz - 2.2], [cx, 19, cz + 15]], 0.06, 3); k.steel([0.1, 0.1, 0.1], 0.6, 60).pipe([[cx, 19, cz + 15], [cx, 9, cz + 15]], 0.04, 3); k.steel([0.25, 0.25, 0.27], 0.6, 200).ball(cx, 8.4, cz + 15, 0.9, { segs: 6 }); }
  k.collide(cx - 2.6, 0, cz - 3.3, cx + 2.6, 3.4, cz + 3.3);
  part(k, bungalow, { width: 12, depth: 16, variant: 2, style: 'residential_poor' }, { x: -34, z: zf - 12, salt: 5, paint: { age: 3 } });
}
export function trailerLot(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], x0 = -Wd / 2 + 1, x1 = Wd / 2 - 1, zb = -D / 2 + 1, zf = D / 2 - 1;
  compound(k, x0, zb, x1, zf, { x: 8, w: 6 }, { h: 2.2, t: 0.1, style: 'rail', color: [0.5, 0.45, 0.38], rail: [0.45, 0.4, 0.34] });
  // the trailer on blocks: an aluminium box with a door, steps and an awning
  const tx = -12, tz = 4;
  k.bare(1, 0.5).occ(1).box(tx - 7, 0.7, tz - 1.7, tx + 7, 3.5, tz + 1.7, 'xXzZYy'); k.collide(tx - 7, 0, tz - 1.7, tx + 7, 3.5, tz + 1.7);
  if (!k.far) { k.concrete([0.6, 0.6, 0.58]); for (const s of [-5, 0, 5]) k.box(tx + s - 0.3, 0, tz - 1.2, tx + s + 0.3, 0.7, tz + 1.2); k.glass([0.12, 0.14, 0.16]); for (const s of [-5, -2.4, 4.4]) k.box(tx + s - 0.6, 2.0, tz + 1.7, tx + s + 0.6, 2.8, tz + 1.72, 'Z'); k.paint([0.55, 0.2, 0.15], 0.6, 120).box(tx + 1.2, 0.8, tz + 1.7, tx + 2.1, 2.9, tz + 1.73, 'Z'); k.paint([0.7, 0.66, 0.2], 0.6, 150).box(tx - 7.02, 1.5, tz - 1.72, tx + 7.02, 1.8, tz + 1.72, 'xXzZ');
    k.at(tx + 1.65, 0, tz + 1.7, 0, () => { k.solid(SOLID.WOOD, [0.5, 0.42, 0.33], 190, 160).occ(1).box(-0.6, 0, 0, 0.6, 0.35, 1.0).box(-0.6, 0.35, 0, 0.6, 0.7, 0.5); }); k.fabric([0.3, 0.45, 0.3], 1, 0); k.sheet([tx - 1, 3.4, tz + 1.7], [tx + 4, 3.4, tz + 1.7], [tx + 4, 2.7, tz + 4], [tx - 1, 2.7, tz + 4]);
    k.lamp(tx + 1.65, 3.3, tz + 1.9, [1, 0.8, 0.5], { power: 20, radius: 7, radiance: 9, glow: 0.4 });
    // oil drums and the range: a bench and target boards against an earth bank
    for (let i = 0; i < 7; i++) { const x = x1 - 6 + (i % 3) * 1.0, z = zf - 6 - Math.floor(i / 3) * 1.0; k.steel(i % 2 ? [0.2, 0.3, 0.5] : [0.6, 0.25, 0.12], 0.6, 170).cyl(x, 0, z, 0.3, 0.9, { segs: 8 }); }
    k.collide(x1 - 6.4, 0, zf - 8.4, x1 - 3.6, 0.9, zf - 5.6);
    k.solid(SOLID.ROCK, [0.45, 0.38, 0.28], 20, 0).box(x0 + 3, 0, zb + 2, x0 + 30, 2.4, zb + 5, 'xXzZY'); k.collide(x0 + 3, 0, zb + 2, x0 + 30, 2.4, zb + 5);
    for (let i = 0; i < 5; i++) { const x = x0 + 6 + i * 5; k.paint(WHITE, 0.8, 120).box(x - 0.4, 0.6, zb + 5.3, x + 0.4, 1.9, zb + 5.35, 'xXzZY'); k.paint([0.1, 0.1, 0.1], 0.8, 60).box(x - 0.15, 1.1, zb + 5.35, x + 0.15, 1.5, zb + 5.36, 'Z'); }
    k.solid(SOLID.WOOD, [0.5, 0.42, 0.33], 190, 160).box(x0 + 4, 0.85, zb + 24, x0 + 28, 0.95, zb + 25, 'xXzZYy'); for (const s of [5, 16, 27]) k.box(x0 + s - 0.06, 0, zb + 24.4, x0 + s + 0.06, 0.85, zb + 24.6, 'xXzZ'); }
  k.at(8 - 4.5, 0, zf + 0.06, 0, () => nameSign(k, 0, 1.5, 0, { height: 0.6, maxWidth: 3, lit: false, wallColor: [0.5, 0.45, 0.38] }));
}
/** Guard tower: a cabin on four legs with a searchlight. */
function guardTower(k, x, z) {
  const h = 8;
  if (!k.far) { k.steel([0.3, 0.34, 0.26], 0.6, 90).occ(1); for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.pipe([[x + sx * 1.6, 0, z + sz * 1.6], [x + sx * 1.2, h, z + sz * 1.2]], 0.1, 4); }
  k.paint([0.36, 0.4, 0.3], 0.7, 80).occ(1).box(x - 1.6, h, z - 1.6, x + 1.6, h + 1.1, z + 1.6, 'xXzZYy'); k.roofing(2, [0.3, 0.33, 0.27], 120).box(x - 2, h + 2.3, z - 2, x + 2, h + 2.5, z + 2, 'xXzZYy');
  if (k.near) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.steel([0.3, 0.34, 0.26], 0.6, 60).box(x + sx * 1.5 - 0.05, h + 1.1, z + sz * 1.5 - 0.05, x + sx * 1.5 + 0.05, h + 2.3, z + sz * 1.5 + 0.05, 'xXzZ');
  k.lamp(x, h + 2.28, z + 1.8, [0.95, 0.97, 1], { power: 200, flood: true, radius: 30, radiance: 24, glow: 1.0, size: 0.25, spot: [0, -0.8, 0.6], outer: 40, inner: 20, far: true }); k.collide(x - 1.6, 0, z - 1.6, x + 1.6, h + 2.5, z + 1.6);
}
export function armyBase(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], x0 = -Wd / 2 + 1, x1 = Wd / 2 - 1, zb = -D / 2 + 1, zf = D / 2 - 1, olive = [0.5, 0.52, 0.4], khaki = [0.76, 0.72, 0.58], seed = sb(k, TRIM.FOREST, 2);
  compound(k, x0, zb, x1, zf, { x: 0, w: 12 }, { h: 3, t: 0.1, style: 'rail', color: [0.6, 0.6, 0.56], rail: [0.5, 0.52, 0.5] });
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) guardTower(k, sx * (Wd / 2 - 5), sz * (D / 2 - 5));
  // gate: guardhouse between barriers, the name on a low wall
  block(k, -3, zf - 6, 3, zf - 1.5, { floors: 1, ground: 3.2, wall: khaki, seed, parapet: 0.4, groundSpec: W('PUNCHED', 'RIBBON', 3, khaki, seed) });
  barrier(k, -3.2, -9, zf - 3); barrier(k, 3.2, 9, zf - 3);
  if (!k.far) k.stucco(khaki, 90).occ(1).box(10, 0, zf - 0.4, 22, 1.8, zf + 0.1); k.at(16, 0, zf + 0.1, 0, () => nameSign(k, 0, 1.0, 0.02, { height: 0.9, maxWidth: 10, lit: false, far: true, wallColor: khaki })); k.collide(10, 0, zf - 0.4, 22, 1.8, zf + 0.1);
  // headquarters facing the gate across the parade ground, with the flag
  const hq = block(k, -26, zb + 16, 26, zb + 34, { floors: 2, ground: 4, storey: 3.6, wall: khaki, seed, coping: olive, groundSpec: (r) => (r.cls === 'front' ? W('SHOPFRONT', 'LOBBY', 4, khaki, seed) : W('PUNCHED', 'SQUARE', 3.4, khaki, seed)), upperSpec: W('PUNCHED', 'SQUARE', 3.4, khaki, seed) });
  k.onRun(front(hq), (len) => { canopy(k, len / 2 - 4, len / 2 + 4, 3.2, 2.6, { lip: olive, lamps: 2 }); doorway(k, len / 2, 0, 2.4, 2.4, {}); }); roofPlant(k, -25, zb + 17, 25, zb + 33, hq.roofY, { units: 4, tank: false }); mast(k, -20, hq.roofY, zb + 22, 16, { r: 0.2 });
  flagpole(k, 0, zb + 44, 14, [0.2, 0.3, 0.6]);
  // barracks: long huts under metal roofs, in two rows
  for (let i = 0; i < 6; i++) { const xa = -Wd / 2 + 14 + (i % 3) * 18, za = zb + 44 + Math.floor(i / 3) * 44; mass(k, rectRuns(xa, za, xa + 12, za + 34), 0, [{ h: 3.4, storey: 3.4, spec: W('LOWRISE', 'BLOCK', 3.4, olive, seed) }], { roof: null }); pitchedRoof(k, xa, za, xa + 12, za + 34, 3.4, { pitch: 0.3, over: 0.4, kind: 2, color: [0.42, 0.45, 0.38], gable: true, wall: olive, wear: 150 }); }
  // hangars and the motor pool on the other side
  for (let i = 0; i < 2; i++) part(k, hangar, { width: 46, depth: 44, variant: 1, wallColor: olive }, { x: Wd / 2 - 34, z: zb + 34 + i * 54, yaw: -Math.PI / 2, salt: i + 1 });
  bayLines(k, 34, 70, zf - 12, zf - 6, 3.4); helipad(k, 46, 0.02, zb + 18, 8);
  for (const s of [-1, 1]) floodMast(k, s * 30, zb + 60, 16, 0, 0.3, { power: 300, radius: 36 });
}
