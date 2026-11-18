// Motels of the 1950s and 60s and the beach-front hotel towers (design/brief/architecture.md sections 4 and 5):
// long room ranges with outside galleries round a pool, and slabs of balconies on a lobby podium.

import { clamp } from '../../core/math.js';
import { rectRuns, shade, mixColor } from './kit.js';
import { scheme } from './palette.js';
import { F, WHITE, mass, eyebrows, railing, canopy, column, doorway, roofPlant, roofSign, pylonSign, wallSign, windowUnits, pool, bayLines, flight, tiltSlab, balconyRows, beacon, mast, yardWall } from './parts.js';

// ------------------------------------------------------------------------------------------------ motel
const M_FLOOR = 2.75, M_BAY = 3.66, M_DEPTH = 7.4, M_GAL = 1.5, M_BASE = 0.12;

/** One range of motel rooms: rooms open on the gallery side `face` (a rectRuns class); stair at the end `stairEnd` (0 | 1). */
function roomRange(k, S, r, floors, o = {}) {
  const wall = S.wall, seed = S.seedByte, trim = S.trimC, H = floors * M_FLOOR, runs = rectRuns(r.x0, r.z0, r.x1, r.z1);
  const rooms = { style: F('LOWRISE', 'MOTEL', o.dado), bay: M_BAY, color: wall, seed }, rear = { style: F('BLANK', 'SERVICE'), bay: M_BAY, color: shade(wall, 0.95), seed };
  const end = { style: F('BLANK', 'STUCCO', true), bay: 4, color: o.endColor ?? wall, seed };
  const opp = { front: 'back', back: 'front', left: 'right', right: 'left' }[r.face];
  const body = mass(k, runs, 0, [{ h: M_BASE, storey: 1, spec: { style: F('BLANK', 'CONCRETE'), bay: 4, color: [0.6, 0.6, 0.58], seed } }, { h: H, storey: M_FLOOR, spec: (run) => (run.cls === r.face ? rooms : run.cls === opp ? rear : end) }], { parapet: 0.25, color: wall, seed, coping: trim, roofKind: 0 });
  const roofY = body.roofY, face = runs.find((e) => e.cls === r.face);
  // the roof sails out past the walls as a thin plane with a coloured fascia
  if (!k.far) k.stucco(WHITE, 70).occ(1).ledge(runs, roofY - 0.02, roofY + 0.3, 0.45, { lip: trim, closed: true, bottom: k.near, inner: roofY });
  k.onRun(face, (len) => {
    if (k.far) return;
    const g = M_GAL, n = Math.max(1, Math.round(len / M_BAY)), sx = r.stairEnd ? len - 0.3 : 0.3, dir = r.stairEnd ? -1 : 1, top = sx + dir * 3.9, land = top + dir * 1.2;
    k.concrete([0.62, 0.61, 0.58], 0, 70).occ(1).box(0, 0, 0, len, M_BASE, g + 0.4, 'xXZY');
    k.stucco(WHITE, 70).box(-0.3, roofY - 0.02, 0.45, len + 0.3, roofY + 0.14, g + 0.35, 'xXYy'); k.stucco(trim, 60).box(-0.3, roofY - 0.02, 0.45, len + 0.3, roofY + 0.14, g + 0.35, 'Z');
    for (let f = 1; f < floors; f++) {
      const y = M_BASE + f * M_FLOOR;
      k.stucco(WHITE, 80).occ(1).box(0, y - 0.15, 0, len, y, g, k.near ? 'xXZYy' : 'ZY');
      // landing where the stair arrives, then rails either side of it
      k.box(Math.min(top, land), y - 0.15, g, Math.max(top, land), y, g + 1.15, 'xXZYy');
      const lo = Math.min(top, land), hi = Math.max(top, land), rc = { color: o.rail ?? trim, post: M_BAY / 3 };
      railing(k, [[0, y, 0.03], [0, y, g - 0.03], [lo, y, g - 0.03]], 1.05, rc); railing(k, [[hi, y, g - 0.03], [len, y, g - 0.03], [len, y, 0.03]], 1.05, rc);
      railing(k, dir > 0 ? [[land, y, g], [land, y, g + 1.12], [top, y, g + 1.12]] : [[top, y, g + 1.12], [land, y, g + 1.12], [land, y, g]], 1.05, rc);
      flight(k, sx, top, g + 0.05, g + 1.12, f === 1 ? 0 : y - M_FLOOR, y, { rail: o.rail ?? trim });
    }
    // slim steel posts carry the gallery and the roof edge
    k.steel(WHITE, 0.5, 30);
    for (let i = 0; i <= n; i++) { const x = clamp(i * len / n, 0.08, len - 0.08); k.box(x - 0.045, M_BASE, g - 0.1, x + 0.045, roofY - 0.02, g - 0.01, k.near ? 'xXzZ' : 'xXZ'); }
    for (let i = 0; i < n; i += 2) for (let f = 0; f < floors; f++) k.lamp((i + 0.5) * len / n, M_BASE + (f + 1) * M_FLOOR - (f + 1 < floors ? 0.16 : 0.03), g * 0.55, [1, 0.84, 0.6], { power: 12, radius: 6, radiance: 8, glow: 0.3, size: 0.08 });
  });
  const band = body.info[1];
  windowUnits(k, band, [opp], 0.7, 1.2); windowUnits(k, band, [r.face], 0.35, 0.5);
  return body;
}

/**
 * Motel. Variants: 0 L-shaped (back range and one wing), 1 U round a pool court, 2 one bar behind its parking with
 * the office pavilion in front, 3 two ranges end-on to the street with the pool between.
 */
export function motel(k, lot) {
  const S = scheme(lot.seed ^ 0x33, 'resort', lot.style), W = lot.width, D = lot.depth, floors = clamp(lot.floors | 0, 1, 2);
  let variant = lot.variant ?? (W >= 46 ? (k.h(1) < 0.5 ? 1 : k.h(1) < 0.75 ? 3 : 0) : D >= 30 ? (k.h(1) < 0.6 ? 0 : 2) : 2);
  variant = ((variant % 4) + 4) % 4; if ((variant === 1 || variant === 3) && W < 40) variant = 0; if (variant === 0 && D < 27) variant = 2;
  const x0 = -W / 2 + 1.0, x1 = W / 2 - 1.0, zb = -D / 2 + 1.2, zf = D / 2 - 2.0, flip = k.h(2) < 0.5 ? -1 : 1, trim = S.trimC, wall = S.wall, seed = S.seedByte, dado = k.h(3) < 0.5;
  const mx = (a, b) => (flip < 0 ? [-b, -a] : [a, b]);           // mirror an x interval so the office can stand at either end
  const ranges = [], OW = 8.5, OD = 7.5, opt = { dado, endColor: k.h(4) < 0.4 ? mixColor(wall, trim, 0.8) : wall };
  let office, court;
  if (variant === 2) {
    ranges.push({ x0, z0: zb, x1, z1: zb + M_DEPTH, face: 'front', stairEnd: flip < 0 ? 0 : 1 });
    const [a, b] = mx(x0, x0 + OW); office = { x0: a, x1: b, z0: zb + M_DEPTH + M_GAL + 2.2, z1: Math.min(zf - 1, zb + M_DEPTH + M_GAL + 2.2 + OD) }; court = { x0: Math.min(...mx(x0 + OW + 3, x1)), x1: Math.max(...mx(x0 + OW + 3, x1)), z0: zb + M_DEPTH + M_GAL + 1.5, z1: zf };
  } else if (variant === 3) {
    const zr0 = zb, zr1 = zf - OD - 1.5;
    ranges.push({ x0, z0: zr0, x1: x0 + M_DEPTH, z1: zr1, face: 'right', stairEnd: 0 }, { x0: x1 - M_DEPTH, z0: zr0, x1, z1: zr1 + OD + 1.5 - 4, face: 'left', stairEnd: 1 });
    if (flip < 0) for (const r of ranges) { const a = -r.x1, b = -r.x0; r.x0 = a; r.x1 = b; r.face = r.face === 'left' ? 'right' : 'left'; r.stairEnd = 1 - r.stairEnd; }
    ranges.sort((p, q) => p.x0 - q.x0);
    const [a, b] = mx(x0, x0 + OW); office = { x0: a, x1: b, z0: zr1, z1: zr1 + OD }; court = { x0: x0 + M_DEPTH + M_GAL + 1.2, x1: x1 - M_DEPTH - M_GAL - 1.2, z0: zb + 1, z1: zf };
  } else {
    const wingZ1 = zf - OD - 0.5;
    ranges.push({ x0, z0: zb, x1, z1: zb + M_DEPTH, face: 'front', stairEnd: flip < 0 ? 0 : 1 });
    const w1 = mx(x0, x0 + M_DEPTH); ranges.push({ x0: w1[0], x1: w1[1], z0: zb + M_DEPTH, z1: wingZ1, face: flip < 0 ? 'left' : 'right', stairEnd: flip < 0 ? 1 : 0 });
    if (variant === 1) { const w2 = mx(x1 - M_DEPTH, x1); ranges.push({ x0: w2[0], x1: w2[1], z0: zb + M_DEPTH, z1: zf - 3.5, face: flip < 0 ? 'right' : 'left', stairEnd: flip < 0 ? 0 : 1 }); }
    const [a, b] = mx(x0, x0 + OW); office = { x0: a, x1: b, z0: wingZ1, z1: wingZ1 + OD };
    const c = mx(x0 + M_DEPTH + M_GAL + 1.5, variant === 1 ? x1 - M_DEPTH - M_GAL - 1.5 : x1); court = { x0: c[0], x1: c[1], z0: zb + M_DEPTH + M_GAL + 1.5, z1: zf };
  }
  for (const r of ranges) roomRange(k, S, r, floors, opt);

  // office pavilion: glass to the street and the drive, a deep fascia, the canted canopy on leaning poles
  const OH = 3.3, oruns = rectRuns(office.x0, office.z0, office.x1, office.z1), drive = flip < 0 ? 'left' : 'right';
  const glassy = { style: F('SHOPFRONT', 'OFFICE_LOBBY'), bay: 2.8, color: wall, seed, occ: [1, 0.7] }, stone = { style: F('BLANK', k.h(5) < 0.5 ? 'TILE' : 'STUCCO', true), bay: 4, color: k.h(5) < 0.5 ? mixColor(trim, [0.7, 0.66, 0.6], 0.6) : wall, seed };
  mass(k, oruns, 0, [{ h: OH, spec: (r) => (r.cls === 'front' || r.cls === drive ? glassy : stone) }], { parapet: 0.2, color: wall, seed, roofKind: 3, roof: [0.8, 0.8, 0.78] });
  if (!k.far) k.stucco(WHITE, 70).occ(1).ledge(oruns, OH - 0.05, OH + 0.5, 0.7, { lip: trim, closed: true, bottom: k.near, inner: OH });
  const ox = flip < 0 ? office.x0 : office.x1, cz0 = office.z0 + 0.8, cz1 = office.z1 - 0.8, reach = clamp(Math.abs((flip < 0 ? court.x0 : court.x1) - ox) - 1, 4.5, 6.5);
  if (!k.far) {
    k.stucco(WHITE, 70); tiltSlab(k, Math.min(ox, ox + flip * reach), cz0, Math.max(ox, ox + flip * reach), cz1, flip > 0 ? OH + 0.1 : OH + 1.5, flip > 0 ? OH + 1.5 : OH + 0.1, 0.22);
    k.steel(trim, 0.45, 20);
    for (const z of [cz0 + 0.5, cz1 - 0.5]) { const px = ox + flip * (reach - 1.4); k.pipe([[px, 0, z], [px + flip * 0.9, OH + 1.05, z]], 0.07, k.near ? 6 : 3); k.pipe([[px, 0, z], [px - flip * 1.3, OH + 0.55, z]], 0.05, k.near ? 6 : 3); }
    if (S.lit) { const xe = ox + flip * (reach + 0.03), ye = OH + 1.5 - 0.11; k.neon([[xe, ye, cz0], [xe, ye, cz1]], S.neon, { back: [-flip, 0, 0], radiance: 15 }); }
    for (const z of [cz0 + 1.2, cz1 - 1.2]) k.lamp(ox + flip * reach * 0.5, OH + 0.5, z, [1, 0.86, 0.62], { power: 24, radius: 8, radiance: 9, glow: 0.4 });
  }
  for (const z of [cz0 + 0.5, cz1 - 0.5]) { const px = ox + flip * (reach - 1.4); k.collide(px - 0.15, 0, z - 0.15, px + 0.15, 3, z + 0.15); }
  k.onRun(oruns.find((r) => r.cls === 'front'), (len) => { doorway(k, len / 2, 0, 1.7, 2.15, {}); wallSign(k, 'motel', lot.seed >>> 3, len / 2, OH + 0.24, { height: 0.42, maxWidth: len - 0.6, z: 0.72, lit: S.signLit }); });

  // pool in the court, parking against the street, the pylon by the entrance
  const cw = court.x1 - court.x0, cd = court.z1 - court.z0;
  let parkZ0 = court.z0;
  if (cw >= 9 && cd >= 13) { const pw = clamp(cw - 4, 6, 13), pd = clamp(cd - 9, 4.5, 7), px = (court.x0 + court.x1) / 2; pool(k, px - pw / 2, court.z0 + 0.8, px + pw / 2, court.z0 + 0.8 + pd, { rim: 1.1, r: k.h(6) < 0.5 ? 1.2 : 0 }); parkZ0 = court.z0 + pd + 1.6; }
  if (court.z1 - parkZ0 >= 5) bayLines(k, court.x0 + 0.5, court.x1 - 0.5, Math.max(parkZ0, court.z1 - 5.2), court.z1 - 0.2, 2.7);
  const px = flip < 0 ? Math.min(office.x0 - 2.2, court.x1 - 1) : Math.max(office.x1 + 2.2, court.x0 + 1), pz = D / 2 - 1.3;
  k.at(clamp(px, x0 + 0.5, x1 - 0.5), 0, pz, Math.PI / 2, () => pylonSign(k, 0, 0, { height: 6.5 + k.h(7) * 2.5, category: 'motel', variant: lot.seed >>> 3, signHeight: 1.7, maxWidth: 2.2, neon: S.lit ? S.neon : null, color: mixColor(trim, WHITE, 0.3), posts: 1 }));
  return { S, variant };
}

// ------------------------------------------------------------------------------------------------ hotel tower
const T_FLOOR = 3.0, T_PODIUM = 5.0;

/**
 * Beach-front hotel or condominium tower on a lobby podium. Variants: 0 balcony slab, 1 point tower with corner
 * balconies and a set-back penthouse, 2 tinted glass condominium in two staggered slabs with a coloured stair tower,
 * 3 an older stepped tower with a fin and crown.
 */
export function hotelTower(k, lot) {
  const S = scheme(lot.seed ^ 0x99, 'resort', lot.style), W = lot.width, D = lot.depth, floors = lot.floorsExact ? lot.floors | 0 : clamp(lot.floors | 0, 8, 22), up = floors - 1;
  const variant = (((lot.variant ?? Math.floor(k.h(1) * 4)) % 4) + 4) % 4;
  const x0 = -W / 2 + 2, x1 = W / 2 - 2, zf = D / 2 - 6.5, zb = Math.max(-D / 2 + 2, zf - 34), wall = S.wall, trim = S.trimC, seed = S.seedByte, cx = 0;
  const lobby = { style: F('SHOPFRONT', 'OFFICE_LOBBY', k.h(2) < 0.5), bay: 3.6, color: wall, seed, occ: [1, 0.75] }, shops = { style: F('SHOPFRONT', 'SHOWROOM'), bay: 5, color: wall, seed }, service = { style: F('SHOPFRONT', 'SERVICE'), bay: 5.5, color: shade(wall, 0.92), seed };
  const pod = mass(k, rectRuns(x0, zb, x1, zf), 0, [{ h: T_PODIUM, spec: (r) => (r.cls === 'front' ? lobby : r.cls === 'back' ? service : shops) }], { parapet: 0.9, color: wall, seed, coping: trim, roofKind: 3, roof: [0.74, 0.73, 0.7] });
  const py = pod.roofY, H = up * T_FLOOR, blank = { style: F('BLANK', 'STUCCO', true), bay: 4, color: wall, seed }, slot = { style: F('PUNCHED', 'SLOT'), bay: 4.2, color: wall, seed };
  let top = py + H, signY = top, signZ = zf - 2, crown = null;

  if (variant === 0) {
    const tz1 = zf - 1.5, tz0 = Math.max(zb + 1, tz1 - 17), tx0 = x0 + 1.5, tx1 = x1 - 1.5, runs = rectRuns(tx0, tz0, tx1, tz1);
    const rooms = { style: F('CONDO', k.h(3) < 0.5 ? 'SLIDER' : 'HOTEL_ROOM', true), bay: 3.9, color: wall, seed };
    const t = mass(k, runs, py, [{ h: H, storey: T_FLOOR, spec: (r) => (r.cls === 'front' || r.cls === 'back' ? rooms : k.h(4) < 0.5 ? blank : slot) }], { parapet: 1.1, color: wall, seed, coping: trim });
    const guard = ['solid', 'glass', 'rail'][Math.floor(k.h(5) * 3)], gc = k.h(6) < 0.4 ? trim : WHITE;
    for (const c of ['front', 'back']) balconyRows(k, runs.find((r) => r.cls === c), py, T_FLOOR, up, { guard, guardColor: gc, rail: gc, proj: 1.5, from: 0 });
    // end walls carry a full-height fin in the trim colour
    if (!k.far) for (const c of ['left', 'right']) k.onRun(runs.find((r) => r.cls === c), (len) => k.stucco(trim, 60).occ(1).box(len / 2 - 1.2, 0, 0, len / 2 + 1.2, H + 1.1 + 2.2, 0.35, 'xXZY'));
    top = t.top; signZ = tz1; roofPlant(k, tx0 + 2, tz0 + 1.5, tx1 - 2, tz1 - 1.5, t.roofY, { core: true, units: 4, tank: false, color: shade(wall, 0.9) });
    crown = { x: (tx0 + tx1) / 2, z: (tz0 + tz1) / 2, y: t.roofY };
  } else if (variant === 1) {
    const s = Math.min(x1 - x0 - 4, zf - zb - 3, 27), tx0 = cx - s / 2, tz1 = zf - 1.5, tz0 = tz1 - s, runs = rectRuns(tx0, tz0, tx0 + s, tz1), ph = 2;
    const rooms = { style: F('CONDO', 'MIXED', true), bay: 4.2, color: wall, seed };
    const t = mass(k, runs, py, [{ h: (up - ph) * T_FLOOR, storey: T_FLOOR, spec: rooms }], { parapet: 1.0, color: wall, seed, coping: WHITE, roofKind: 3, roof: [0.75, 0.74, 0.7] });
    // balconies wrap the four corners
    const cw = s * 0.3;
    for (const r of runs) { balconyRows(k, r, py, T_FLOOR, up - ph, { guard: 'solid', guardColor: k.h(6) < 0.5 ? trim : WHITE, proj: 1.4, xa: -1.4, xb: cw, from: 0, fins: false, midEnds: 'X' }); balconyRows(k, r, py, T_FLOOR, up - ph, { guard: 'solid', guardColor: k.h(6) < 0.5 ? trim : WHITE, proj: 1.4, xa: s - cw, xb: s + 1.4, from: 0, fins: false, midEnds: 'x' }); }
    const pr = rectRuns(tx0 + 3, tz0 + 3, tx0 + s - 3, tz1 - 3), p = mass(k, pr, t.roofY, [{ h: ph * T_FLOOR, storey: T_FLOOR, grounded: false, spec: { style: F('CONDO', 'SLIDER'), bay: 4, color: wall, seed } }], { roof: [0.8, 0.8, 0.78], roofKind: 3, collide: false });
    if (!k.far) k.stucco(WHITE, 70).occ(1).ledge(pr, p.roofY, p.roofY + 0.45, 2.2, { lip: trim, closed: true, bottom: true, inner: p.roofY });
    top = p.roofY + 0.45; signZ = tz1 - 3; signY = top; crown = { x: cx, z: (tz0 + tz1) / 2, y: top };
    roofPlant(k, tx0 + 5, tz0 + 5, tx0 + s - 5, tz1 - 5, top, { core: true, units: 2, tank: false, color: shade(wall, 0.9) });
  } else if (variant === 2) {
    const tz1 = zf - 1.5, d = Math.min(16, (zf - zb) * 0.55), mid = cx + (k.h(3) - 0.5) * 6, lo = Math.max(3, Math.round(up * 0.72)), glass = S.glass;
    const skin = { style: F('CURTAIN', 'BANDED'), bay: 1.5, color: glass, seed }, endw = { style: F('BLANK', 'CONCRETE'), bay: 4, color: [0.78, 0.77, 0.74], seed };
    const a = mass(k, rectRuns(x0 + 1.5, tz1 - d, mid + 1.5, tz1), py, [{ h: H, storey: T_FLOOR, spec: (r) => (r.cls === 'front' || r.cls === 'back' ? skin : endw) }], { parapet: 0.8, color: [0.78, 0.77, 0.74], seed, roofKind: 3 });
    const b = mass(k, rectRuns(mid - 1.5, tz1 - d - 5, x1 - 1.5, tz1 - 5), py, [{ h: lo * T_FLOOR, storey: T_FLOOR, spec: (r) => (r.cls === 'front' || r.cls === 'back' ? skin : endw) }], { parapet: 0.8, color: [0.78, 0.77, 0.74], seed, roofKind: 3, collide: false });
    // the stair tower between the slabs is the one strong colour
    const st = mass(k, rectRuns(mid - 2.2, tz1 - 4.5, mid + 2.2, tz1 + 0.6), py, [{ h: H + 4, storey: H + 4, grounded: false, spec: { style: F('BLANK', 'STUCCO'), bay: 4, color: mixColor(trim, [0.8, 0.2, 0.15], k.h(7) < 0.4 ? 0.8 : 0), seed } }], { roof: [0.5, 0.5, 0.5], roofKind: 3, collide: false });
    for (const [m, n] of [[a, up], [b, lo]]) balconyRows(k, m.runs.find((r) => r.cls === 'front'), py, T_FLOOR, n, { guard: 'glass', glass: shade(glass, 0.6), proj: 1.3, from: 0, bay: 6, finColor: [0.8, 0.79, 0.76] });
    top = st.roofY; signY = a.top; signZ = tz1; crown = { x: mid, z: tz1 - 2, y: top };
    roofPlant(k, x0 + 3, tz1 - d + 1.5, mid - 3, tz1 - 1.5, a.roofY, { core: false, units: 4, tank: false });
  } else {
    // stepped tower: wide lower block, narrower upper block, a fin up the middle and a ziggurat crown
    const tz1 = zf - 1.5, d = Math.min(18, zf - zb - 3), w = Math.min(x1 - x0 - 3, 44), n1 = Math.max(3, Math.round(up * 0.6)), n2 = up - n1, stripes = k.h(3) < 0.6;
    const win = { style: F('DECO', 'CASEMENT', stripes), bay: 3.2, color: wall, seed }, sidew = { style: F('DECO', 'SIDE', stripes), bay: 3.4, color: wall, seed };
    const sp = (r) => (r.cls === 'front' ? win : r.cls === 'back' ? { style: F('DECO', 'SIDE'), bay: 3.2, color: shade(wall, 0.96), seed } : sidew);
    const a = mass(k, rectRuns(cx - w / 2, tz1 - d, cx + w / 2, tz1), py, [{ h: n1 * T_FLOOR, storey: T_FLOOR, spec: sp }], { parapet: 0.9, color: wall, seed, coping: trim });
    const w2 = w * 0.56, b = mass(k, rectRuns(cx - w2 / 2, tz1 - d + 1.5, cx + w2 / 2, tz1 - 0.01), a.roofY, [{ h: n2 * T_FLOOR, storey: T_FLOOR, grounded: false, spec: sp }], { parapet: 0.9, color: wall, seed, coping: trim, collide: false });
    eyebrows(k, a.info[0], [a.runs[0]], { proj: 0.6, color: WHITE, lip: trim }); eyebrows(k, b.info[0], [b.runs[0]], { proj: 0.6, color: WHITE, lip: trim });
    let y = b.top, cwid = w2 * 0.5; const fw = Math.min(4.2, w2 * 0.22);
    for (let i = 0; i < 3; i++) { const m = mass(k, rectRuns(cx - cwid / 2, tz1 - d * 0.5 - cwid * 0.3, cx + cwid / 2, tz1 - 0.02), y - (i === 0 ? 0.9 : 0), [{ h: 2.4 + (i === 0 ? 0.9 : 0), storey: 3.3, grounded: false, spec: { style: F('DECO', 'FLUTED'), bay: 4, color: i === 2 ? mixColor(wall, trim, 0.8) : wall, seed } }], { roof: shade(wall, 0.8), roofKind: 3, collide: false }); y = m.roofY; cwid *= 0.62; }
    if (!k.far) { k.stucco(trim, 60).occ(1).box(cx - fw / 2, py + 0.2, tz1, cx + fw / 2, b.top + 1.2, tz1 + 0.5, 'xXZY'); k.stucco(WHITE, 60).box(cx - 0.25, py + 0.2, tz1 + 0.5, cx + 0.25, y + 1.0, tz1 + 0.95, 'xXZYz');
      if (S.lit) for (const sx of [-1, 1]) k.neon([[cx + sx * 0.3, py + 0.6, tz1 + 0.99], [cx + sx * 0.3, y + 0.9, tz1 + 0.99]], S.neon, { back: [0, 0, -1], maxLights: 3 }); }
    mast(k, cx, y, tz1 - d * 0.4, 7);
    top = y; signY = a.top; signZ = tz1 - 0.3; crown = null;
    roofPlant(k, cx - w / 2 + 1, tz1 - d + 1, cx - w2 / 2 - 1, tz1 - 1, a.roofY, { core: false, units: 3, tank: k.h(8) < 0.5, color: shade(wall, 0.9) });
    k.collide(cx - w2 / 2, a.roofY, tz1 - d + 1.5, cx + w2 / 2, b.top, tz1);
  }
  if (crown && top > 38) beacon(k, crown.x, crown.y + (variant === 0 ? 3.6 : 0.4), crown.z);

  // name on the roof edge, facing the street: lit letters on a frame, kept at every distance as the sign face
  roofSign(k, variant === 3 ? cx - Math.min(x1 - x0 - 3, 44) * 0.32 : cx + (variant === 2 ? -8 : 0), signY, signZ - 0.5, { category: 'hotel', variant: lot.seed >>> 3, height: clamp(1.6 + floors * 0.06, 1.8, 3), maxWidth: Math.min(16, W * 0.4), neon: S.lit ? S.neon : null, lit: S.signLit, far: true });

  // porte-cochere: a deep canopy on columns over the door, the name again on its fascia
  const cwid = clamp(W * 0.3, 9, 16), cd = 5.2;
  k.at(cx, 0, zf, 0, () => {
    canopy(k, -cwid / 2, cwid / 2, 3.7, cd, { r: variant === 3 ? 1.6 : 0.01, th: 0.5, lip: trim, neon: S.lit ? S.neonAccent : null, lamps: 3, lampPower: 30 });
    for (const sx of [-1, 1]) column(k, sx * (cwid / 2 - 0.8), cd - 0.8, 0, 3.7, 0.22, { color: variant === 2 ? [0.75, 0.75, 0.73] : WHITE, trim });
    doorway(k, 0, 0, 3.6, 2.4, { leaves: 4 });
    wallSign(k, 'hotel', lot.seed >>> 3, 0, 3.95, { height: 0.36, maxWidth: cwid - 2, z: cd + 0.015, lit: S.signLit });
  });
  for (const sx of [-1, 1]) k.collide(cx + sx * (cwid / 2 - 0.8) - 0.25, 0, zf + cd - 1.05, cx + sx * (cwid / 2 - 0.8) + 0.25, 3.7, zf + cd - 0.55);
  // pool terrace behind the podium when the lot runs deep enough
  const yard = zb - (-D / 2 + 1);
  if (yard >= 9) { pool(k, x0 + 3, -D / 2 + 1.5, Math.min(x1 - 3, x0 + 3 + 18), zb - 1.5, { rim: 1.4, r: 1.5 }); yardWall(k, [[x0, zb], [x0, -D / 2 + 0.6], [x1, -D / 2 + 0.6], [x1, zb]], { h: 1.6, color: wall, piers: 4 }); }
  return { S, variant, top };
}
