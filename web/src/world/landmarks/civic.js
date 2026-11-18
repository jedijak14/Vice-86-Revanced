// Named places made of one main building: shops and garages, clubs, hospitals, police stations, towers, hotels, houses.

import { clamp } from '../../core/math.js';
import { SOLID } from '../../core/ids.js';
import { rectRuns, shade } from '../buildings/kit.js';
import { TRIM, NEON, GLASS_SKINS, ROOF_TILE } from '../buildings/palette.js';
import { F, mass, canopy, awning, steps, column, doorway, pitchedRoof, roofPlant, roofSign, bladeSign, pylonSign, mast, beacon, pool, bayLines, balconyRows, tiltSlab, yardWall } from '../buildings/parts.js';
import { decoHotel } from '../buildings/deco.js';
import { decoShop } from '../buildings/deco2.js';
import { hotelTower } from '../buildings/resort.js';
import { officeTower, officeBlock, O_FLOOR, O_GROUND } from '../buildings/downtown.js';
import { bungalow, mansion } from '../buildings/low.js';
import { warehouse } from '../buildings/industrial.js';
import { W, sb, part, block, nameSign, helipad, flagpole, compound, barrier, WHITE, STEEL, CHANNEL } from './common.js';

const CREAM = [0.92, 0.88, 0.78], CONC = [0.7, 0.69, 0.66];
const front = (m) => m.runs.find((r) => r.cls === 'front');

// ------------------------------------------------------------------------------------------------ shops and garages
/**
 * A small free-standing business. o: { wall, trim (index), age, floors, kind: 'shop' | 'garage' | 'cafe' | 'bar',
 * doors (roller doors), awning (colour), stripe (colour of a painted band), roofSign, neon, lit, sign (false: none) }.
 * Returns the mass so the caller can add the thing that makes the place itself.
 */
export function store(k, m, o = {}) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = o.wall ?? CREAM, seed = sb(k, o.trim ?? TRIM.WHITE, o.age ?? 1), G = o.ground ?? (o.kind === 'garage' ? 4.6 : 4.0), floors = o.floors ?? 1;
  const x0 = -Wd / 2 + 1.5, x1 = Wd / 2 - 1.5, zf = D / 2 - (o.setback ?? 3), zb = -D / 2 + 1.2;
  const fr = o.kind === 'garage' ? { style: F('WAREHOUSE', 'DOORS'), bays: o.doors ?? 2, color: wall, seed } : W('SHOPFRONT', o.kind === 'cafe' ? 'CAFE' : o.kind === 'bar' ? 'CLUB' : o.kind === 'barred' ? 'SHUTTERED' : 'RETAIL', o.bay ?? 4.2, wall, seed);
  const side = W('BLANK', 'STUCCO', 4, wall, seed), back = W('BLANK', 'SERVICE', 5, wall, seed), up = W('PUNCHED', 'SQUARE', 3.2, wall, seed);
  const b = block(k, x0, zb, x1, zf, { floors, ground: G, storey: 3.2, wall, seed, parapet: o.parapet ?? 0.9, coping: o.coping ?? shade(wall, 1.04),
    groundSpec: (r) => (r.cls === 'front' ? fr : r.cls === 'back' ? back : o.sideGlass && r.cls === o.sideGlass ? fr : side), upperSpec: (r) => (r.cls === 'back' || r.cls === 'front' ? up : side) });
  k.onRun(front(b), (len) => {
    if (o.stripe && !k.far) { k.paint(o.stripe, 0.5, 60).occ(1).box(0, G - 0.75, 0, len, G - 0.35, 0.03, 'Z'); }
    if (o.awning && o.kind !== 'garage') awning(k, 0.6, len - 0.6, G - 1.0, { proj: 1.6, drop: 0.6, color: o.awning, pattern: o.awningPattern ?? 1 });
    if (o.kind !== 'garage') doorway(k, len / 2, 0, 1.7, 2.25, {});
    if (o.sign !== false) {
      if (o.roofSign) roofSign(k, len / 2, b.top, -0.5, { height: o.roofSign, maxWidth: len - 2, neon: o.neon, far: true, lit: o.lit });
      else nameSign(k, len / 2, b.roofY + (floors > 1 ? -0.6 : 0.35), 0.04, { height: 0.85, maxWidth: len - 2, far: true, lit: o.lit, wallColor: wall });
      if (o.neon && !k.far && !o.roofSign) k.neon([[0.3, b.top - 0.12, 0.05], [len - 0.3, b.top - 0.12, 0.05]], o.neon, { back: [0, 0, -1], maxLights: 2 });
    }
    if (!k.far) for (const f of [0.25, 0.75]) k.lamp(len * f, G - 0.25, 0.35, [1, 0.85, 0.6], { power: 26, radius: 8, radiance: 10, glow: 0.4, spot: [0, -1, 0.2], outer: 70, inner: 40 });
  });
  roofPlant(k, x0 + 1, zb + 1, x1 - 1, zf - 1, b.roofY, { core: false, units: 2, tank: false });
  bayLines(k, x0 + 1, x1 - 1, zf + 0.4, D / 2 - 0.2, 2.7);
  return b;
}

export function gunShop(k, m) {
  const two = m.heightM > 8, b = store(k, m, { wall: [0.45, 0.47, 0.3], trim: TRIM.SUN, kind: 'barred', floors: two ? 2 : 1, roofSign: two ? 1.3 : 0, stripe: [0.83, 0.68, 0.12], neon: two ? NEON.red : null });
  // downtown: a gun barrel thrust out over the door
  if (two && !k.far) k.onRun(front(b), (len) => { k.steel([0.25, 0.27, 0.22], 0.5, 60).occ(1).pipe([[len / 2, 5.4, -0.2], [len / 2, 5.7, 3.4]], 0.16, k.near ? 10 : 5).pipe([[len / 2, 5.67, 3.0], [len / 2, 5.72, 3.6]], 0.22, k.near ? 10 : 5); k.box(len / 2 - 0.7, 4.9, 0, len / 2 + 0.7, 5.9, 0.6, 'xXZYy'); });
}
export function sprayShop(k, m) {
  const marked = m.id !== 'eight_ball_bomb_shop', wall = marked ? [0.9, 0.9, 0.88] : [0.62, 0.6, 0.55];
  const b = store(k, m, { wall, trim: TRIM.PALE_BLUE, kind: 'garage', doors: 2, stripe: marked ? [0.15, 0.4, 0.75] : null, sign: marked, age: marked ? 1 : 3, lit: false });
  if (marked) k.onRun(front(b), (len) => { if (!k.far) k.paint([0.15, 0.4, 0.75], 0.5, 60).occ(1).box(0, b.roofY + 0.85, 0, len, b.top, 0.03, 'Z'); });
}
export function hardware(k, m) {
  const b = store(k, m, { wall: [0.88, 0.84, 0.72], trim: TRIM.OXBLOOD, awning: [0.6, 0.15, 0.12], roofSign: 1.1 });
  // the giant hammer lying along the parapet
  if (!k.far) { const y = b.top + 0.1, z = b.z1 - 1.6, x = b.x0 + 2.2; k.solid(SOLID.WOOD, [0.62, 0.42, 0.22], 150, 60).occ(1).box(x, y + 0.5, z - 0.22, x + 6.4, y + 0.95, z + 0.22, 'xXzZYy'); k.steel([0.3, 0.31, 0.33], 0.4, 40).box(x + 6.0, y, z - 0.5, x + 7.2, y + 2.3, z + 0.5, 'xXzZYy'); for (const px of [x + 0.8, x + 4.6]) k.steel(STEEL, 0.5, 60).box(px - 0.06, y - 0.1, z - 0.06, px + 0.06, y + 0.5, z + 0.06, 'xXzZ'); }
}
export function laundromat(k, m) { store(k, m, { wall: [0.9, 0.91, 0.92], trim: TRIM.PALE_BLUE, stripe: [0.3, 0.55, 0.8], sideGlass: 'left', neon: NEON.azure }); }
export function cafe(k, m) {
  const b = store(k, m, { wall: [0.9, 0.78, 0.3], trim: TRIM.WHITE, kind: 'cafe', awning: [0.82, 0.2, 0.18], awningPattern: 1, sideGlass: 'left', neon: NEON.warm, setback: 5.5 });
  // pavement tables under parasols
  if (!k.far) for (let i = 0; i < 4; i++) { const x = b.x0 + 2.5 + i * (b.x1 - b.x0 - 5) / 3, z = b.z1 + 3.2; k.bare(1, 0.4).occ(1).cyl(x, 0, z, 0.04, 2.3, { segs: 4, cap: false }).cyl(x, 0.7, z, 0.45, 0.74, { segs: k.near ? 10 : 6, bottom: true }); k.fabric(i % 2 ? [0.9, 0.9, 0.85] : [0.82, 0.2, 0.18], 1, 0).cyl(x, 2.05, z, 1.25, 2.5, { r1: 0.04, segs: 8 }); k.collide(x - 0.45, 0, z - 0.45, x + 0.45, 0.75, z + 0.45); }
}
export function bikerBar(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], seed = sb(k, TRIM.OXBLOOD, 3), wood = [0.42, 0.3, 0.2], x0 = -Wd / 2 + 2, x1 = Wd / 2 - 2, zf = D / 2 - 5.5, zb = -D / 2 + 1.5, H = 3.6;
  const b = mass(k, rectRuns(x0, zb, x1, zf), 0, [{ h: H, storey: H, spec: (r) => (r.cls === 'back' ? W('BLANK', 'SERVICE', 5, wood, seed) : W('LOWRISE', 'CLAPBOARD', 3.4, wood, seed)) }], { roof: null });
  pitchedRoof(k, x0, zb, x1, zf, H, { pitch: 0.3, over: 0.4, kind: 2, color: [0.36, 0.3, 0.27], gable: true, wall: wood, wear: 200 });
  // a lean-to porch on rough posts, the sign on its roof, bikes parked in front
  k.onRun(front(b), (len) => { k.roofing(2, [0.36, 0.3, 0.27], 200); tiltSlab(k, 0, 0, len, 2.8, 3.0, 3.0, 0.1);
    if (!k.far) { k.solid(SOLID.WOOD, wood, 170, 150).occ(1); for (let x = 0.2; x <= len; x += (len - 0.4) / 5) k.box(x - 0.08, 0, 2.5, x + 0.08, 3.0, 2.66, 'xXzZ'); k.box(0, 0.12, 0, len, 0.2, 2.8, 'xXZY'); }
    doorway(k, len / 2, 0.2, 1.6, 2.1, { metal: false });
    roofSign(k, len / 2, 3.1, 2.2, { height: 1.2, maxWidth: len * 0.6, neon: NEON.red, far: true, leg: 0.3 });
    for (const f of [0.2, 0.8]) if (!k.far) k.lamp(len * f, 2.9, 1.4, [1, 0.7, 0.4], { power: 20, radius: 7, radiance: 9, glow: 0.4 }); });
  k.collide(x0, 0, zf, x1, 0.2, zf + 2.8);
}
export function cabDepot(k, m) {
  const D = m.footprint[1], Wd = m.footprint[0];
  store(k, { ...m, footprint: [Wd * 0.62, D * 0.6] }, { wall: [0.9, 0.74, 0.16], trim: TRIM.NAVY, kind: 'garage', doors: 4, roofSign: 1.6, stripe: [0.1, 0.1, 0.1], lit: false, setback: 1 });
  compound(k, -Wd / 2 + 0.6, -D / 2 + 0.6, Wd / 2 - 0.6, D / 2 - 0.6, { x: Wd * 0.25, w: 8 }, { h: 2.2, t: 0.1, style: 'rail', color: [0.66, 0.65, 0.62], rail: [0.6, 0.62, 0.63] });
  bayLines(k, -Wd / 2 + 2, Wd / 2 - 2, D / 2 - 7, D / 2 - 2, 2.8);
}
export function showroom(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], seed = sb(k, TRIM.SUN, 0), wall = [0.93, 0.93, 0.9], x0 = -Wd / 2 + 6, x1 = Wd / 2 - 16, zf = D / 2 - 14, zb = zf - 18, H = 6.0;
  // glass box under an oversailing flat roof on round columns
  const b = mass(k, rectRuns(x0, zb, x1, zf, [2.5, 2.5, 0, 0]), 0, [{ h: H, storey: H, spec: (r) => (r.cls === 'back' ? W('BLANK', 'STUCCO', 5, wall, seed) : W('SHOPFRONT', 'SHOWROOM', 4.5, wall, seed)) }], { roof: null });
  if (!k.far) { k.paint(WHITE, 0.5, 30).occ(1).slab(rectRuns(x0 - 2.2, zb - 0.3, x1 + 2.2, zf + 2.6, [3, 3, 0, 0]), H, H + 0.7, { bottom: true, under: 0.55 }); for (let x = x0 - 1; x <= x1 + 1.01; x += (x1 - x0 + 2) / 5) column(k, x, zf + 1.6, 0, H, 0.2, { round: true }); k.neon([[x0 - 2, H + 0.35, zf + 2.65], [x1 + 2, H + 0.35, zf + 2.65]], NEON.warm, { back: [0, 0, -1], maxLights: 3 }); }
  else k.paint(WHITE, 0.5, 30).cap([[x0, zf], [x1, zf], [x1, zb], [x0, zb]], H);
  k.at((x0 + x1) / 2, 0, zf + 2.7, 0, () => nameSign(k, 0, H + 1.5, 0, { height: 1.5, maxWidth: x1 - x0, far: true, double: 0.15 }));
  // four workshops behind, and the sun on a pylon by the road
  const g = block(k, x0, zb - 14, x1, zb - 4, { floors: 1, ground: 4.8, wall, seed, groundSpec: (r) => (r.cls === 'front' ? { style: F('WAREHOUSE', 'DOORS'), bays: 4, color: wall, seed } : W('BLANK', 'SERVICE', 5, wall, seed)), coping: [0.9, 0.74, 0.16] });
  roofPlant(k, x0 + 1, zb - 13, x1 - 1, zb - 5, g.roofY, { core: false, units: 3 });
  k.at(Wd / 2 - 7, 0, D / 2 - 4, Math.PI / 2, () => pylonSign(k, 0, 0, { height: 9, signHeight: 2, maxWidth: 5.5, category: 'landmark:' + m.id, neon: NEON.warm }));
  if (!k.far) { k.emissive([1, 0.8, 0.25], 6).occ(1).ball(Wd / 2 - 7, 10.4, D / 2 - 4, 1.3, { segs: k.near ? 12 : 6 }); k.glow(Wd / 2 - 7, 10.4, D / 2 - 4, 3, [1.2, 0.8, 0.2], CHANNEL.NEON, 2, true); k.light(Wd / 2 - 7, 9, D / 2 - 2.5, [40, 30, 8], 9, CHANNEL.NEON); }
  bayLines(k, x0, x1, zf + 5, zf + 10.5, 3.2); bayLines(k, x1 + 3, Wd / 2 - 3, zb, zb + 5.4, 2.7);
}
export function iceCreamFactory(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], seed = sb(k, TRIM.FLAMINGO, 1), wall = [0.93, 0.9, 0.84], x0 = -Wd / 2 + 2, x1 = Wd / 2 - 2, zf = D / 2 - 6, zb = -D / 2 + 1.5;
  const b = block(k, x0, zb, x1, zf, { floors: 1, ground: 5.4, wall, seed, coping: [0.9, 0.55, 0.62], groundSpec: (r) => (r.cls === 'front' ? W('SHOPFRONT', 'SERVICE', 6, wall, seed) : r.cls === 'back' ? { style: F('WAREHOUSE', 'DOORS'), bays: 5, color: wall, seed } : W('WAREHOUSE', 'TILT_UP', 6, wall, seed, true)) });
  // two scoops with cherries on the roof
  [[-0.24, [0.93, 0.6, 0.68]], [0.24, [0.95, 0.9, 0.78]]].forEach(([f, c]) => { const x = Wd * f, z = zf - 7, r = 5.2, segs = k.near ? 18 : k.far ? 6 : 10;
    k.paint(c, 0.45, 50).occ(1).ball(x, b.roofY - 0.4, z, r, { segs, dome: true }); k.paint([0.78, 0.6, 0.38], 0.6, 80).cyl(x, b.roofY, z, r + 0.25, b.roofY + 0.9, { segs, r1: r + 0.05 });
    if (!k.far) { k.paint([0.8, 0.06, 0.1], 0.25, 10).ball(x, b.roofY + r + 0.25, z, 0.75, { segs: k.near ? 10 : 6 }); k.steel([0.2, 0.35, 0.12], 0.5, 10).pipe([[x, b.roofY + r + 0.9, z], [x + 0.25, b.roofY + r + 1.7, z], [x + 0.7, b.roofY + r + 2.1, z]], 0.05, 4); } });
  k.onRun(front(b), (len) => { nameSign(k, len / 2, b.roofY - 1.0, 0.04, { height: 1.2, maxWidth: len * 0.6, far: true, wallColor: wall }); canopy(k, len / 2 - 3, len / 2 + 3, 3.0, 1.8, { lip: [0.9, 0.55, 0.62], lamps: 2 }); doorway(k, len / 2, 0, 1.8, 2.3, {}); });
  roofPlant(k, x0 + 1, zb + 1, x1 - 1, zb + 9, b.roofY, { core: false, units: 5, tank: true });
  bayLines(k, x0, x1, zf + 0.5, zf + 5.5, 2.7);
}

// ------------------------------------------------------------------------------------------------ clubs
/**
 * Night club: a windowless box, a canopied door, the name in a neon frame and tubes round the parapet.
 * o: { wall, trim, neon, neon2, drum (a round glass entrance), blade }.
 */
export function club(k, m, o) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = o.wall, seed = sb(k, o.trim, 1), x0 = -Wd / 2 + 2, x1 = Wd / 2 - 2, zf = D / 2 - 3.5, zb = -D / 2 + 1.5, G = 4.2, H = m.heightM - 1;
  const blank = W('BLANK', 'STUCCO', 5, wall, seed, true), runs = rectRuns(x0, zb, x1, zf);
  const b = mass(k, runs, 0, [{ h: G, storey: G, spec: (r) => (r.cls === 'back' ? W('BLANK', 'SERVICE', 5, wall, seed) : blank) }, { h: Math.round((H - G) * 10) / 10, storey: Math.round((H - G) * 10) / 10, grounded: false, spec: blank }], { parapet: 1.0, color: wall, seed, coping: o.coping ?? shade(wall, 1.05) });
  if (!k.far) { k.ledge(runs.filter((r) => r.cls !== 'back'), G - 0.15, G + 0.15, 0.12, { lip: o.band ?? WHITE }); k.neon(runs.filter((r) => r.cls !== 'back').flatMap((r) => r.pts).map((p, i, a) => [p[0], b.top - 0.15, p[1] + 0.06]).filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[2] - a[i - 1][2]) > 0.05), o.neon, { back: [0, 0, -1], maxLights: 4 }); }
  const cx = (x0 + x1) / 2;
  k.onRun(front(b), (len) => {
    canopy(k, len / 2 - 3.2, len / 2 + 3.2, 3.0, 2.6, { th: 0.4, lip: o.band ?? WHITE, neon: o.neon2, neonAt: 'both', lamps: 3, lampColor: [1, 0.6, 0.8] });
    doorway(k, len / 2, 0, 2.2, 2.4, { metal: false });
    if (o.chequer && !k.far) {                                      // the flag band over the ground floor, and a tiled dado
      k.tile([0.9, 0.9, 0.87], 40, 1).occ(1).box(0.05, G + 0.2, 0, len - 0.05, G + 1.0, 0.06, 'xXZYy');
      k.tile([0.16, 0.16, 0.18], 20, 0).box(0.05, 0, 0, len / 2 - 2, 1.0, 0.05, 'xXZY').box(len / 2 + 2, 0, 0, len - 0.05, 1.0, 0.05, 'xXZY');
      for (const s of [-1, 1]) { k.plant('small', len / 2 + s * 6.5, 1.6); k.uplight(len / 2 + s * 6.5, 2.6, [0, 0.93, -0.36], [1, 0.6, 0.72], { power: 9, radius: 7 }); k.uplight(len / 2 + s * 11, 1.0, [0, 0.95, -0.3], [1, 0.6, 0.72], { power: 8, radius: 8 }); }
    }
    nameSign(k, len / 2, G + (H - G) * 0.55, 0.06, { height: Math.min(2.2, (H - G) * 0.6), maxWidth: len * 0.62, far: true });
    if (!k.far) { const s = len * 0.31 + 0.3, y0 = G + (H - G) * 0.55 - 1.4, y1 = y0 + 2.8; k.neon([[len / 2 - s, y0, 0.07], [len / 2 + s, y0, 0.07], [len / 2 + s, y1, 0.07], [len / 2 - s, y1, 0.07]], o.neon2, { closed: true, back: [0, 0, -1], maxLights: 2 }); }
    if (o.blade) bladeSign(k, len - 1.2, G + 0.4, b.top + 2.2, 0, { category: 'landmark:' + m.id, variant: 1, neon: o.neon, color: shade(wall, 0.5) });
  });
  roofPlant(k, x0 + 1.5, zb + 1.5, x1 - 1.5, zf - 2, b.roofY, { units: 4, tank: false });
  bayLines(k, x0, x1, zf + 0.6, D / 2 - 0.3, 2.7);
}

/**
 * The beach nightclub: a long windowless hall in faded pink with rounded corners and an aqua tile base, a white
 * entrance block with glass-block flanks, and in front of it a deep porte-cochere on round columns whose fascia
 * carries two tubes and whose roof carries the name in script. Portholes, a steel sculpture, planters with palms
 * lit from the ground. Everything a car arriving at night aims for is on the axis of the door.
 */
export function beachClub(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], pink = [0.90, 0.71, 0.72], aqua = [0.33, 0.70, 0.72], seed = sb(k, TRIM.TURQUOISE, 1), white = [0.91, 0.90, 0.87];
  const hw = Math.min(Wd / 2 - 5, 20), zb = -D / 2 + 1.5, zf = D / 2 - 17, G = 4.4, H = Math.min(m.heightM - 4, 8), EH = Math.min(m.heightM - 1.5, 10.5), ew = 7.5, pc = 9.5, cy = 4.3, cth = 0.8;
  const tile = W('BLANK', 'TILE', 4, aqua, seed), blank = W('BLANK', 'STUCCO', 5, pink, seed, true), ports = W('DECO', 'PORTHOLE', 4.4, pink, seed);
  // the hall: tile to door-handle height, portholes on the front, a blind upper wall under an aqua coping
  const runs = rectRuns(-hw, zb, hw, zf, [4, 4, 0, 0], k.arc);
  const hall = mass(k, runs, 0, [{ h: 1.1, storey: 1.1, spec: (r) => (r.cls === 'back' ? W('BLANK', 'SERVICE', 5, pink, seed) : tile) },
    { h: G - 1.1, storey: G - 1.1, grounded: false, spec: (r) => (r.cls === 'front' ? ports : r.cls === 'back' ? W('BLANK', 'SERVICE', 5, pink, seed) : blank) },
    { h: H - G, storey: H - G, grounded: false, spec: blank }], { parapet: 0.9, color: pink, seed, coping: aqua });
  const street = runs.filter((r) => r.cls !== 'back');
  if (!k.far) {
    k.ledge(street, G - 0.14, G + 0.14, 0.14, { lip: aqua });
    // one tube under the coping, round both corners: the hall's own outline
    const path = street.flatMap((r) => r.pts).filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 0.05).filter((p) => p[1] > zf - 9);
    k.neon(path.map((p) => [p[0] * (1 + 0.06 / hw), hall.top - 0.2, p[1] + 0.06]), NEON.aqua, { back: [0, 0, -1], maxLights: 6 });
  }
  // lower wings set back at each end: stores and the stage door
  for (const s of [-1, 1]) { const xa = s < 0 ? -Wd / 2 + 1.5 : hw, xb = s < 0 ? -hw : Wd / 2 - 1.5;
    const wing = block(k, xa, zb + 1, xb, zf - 6, { floors: 1, ground: 4.6, wall: shade(pink, 0.97), seed, coping: aqua, parapet: 0.6, groundSpec: (r) => (r.cls === (s < 0 ? 'right' : 'left') ? null : r.cls === 'front' ? W('BLANK', 'SERVICE', xb - xa, shade(pink, 0.97), seed) : W('BLANK', 'STUCCO', 5, shade(pink, 0.97), seed)) });
    if (s > 0) roofPlant(k, xa + 0.4, zb + 2, xb - 0.4, zf - 7, wing.roofY, { units: 2, tank: false, core: false, aerial: false }); }
  // the entrance block: taller, white, stepped at the top, glass block either side of the doors
  const ent = mass(k, rectRuns(-ew, zf - 3, ew, zf + 2.2, k.far ? 0 : [1.2, 1.2, 0, 0], k.arc), 0, [{ h: cy + cth, storey: cy + cth, spec: (r) => (r.cls === 'front' ? { style: F('SHOPFRONT', 'CLUB'), bays: 3, color: white, seed, occ: [1, 0.5] } : r.cls === 'back' ? null : W('DECO', 'GLASS_BLOCK', 2.5, white, seed)) },
    { h: EH - cy - cth, storey: EH - cy - cth, grounded: false, spec: (r) => (r.cls === 'back' ? W('BLANK', 'STUCCO', 5, white, seed) : W('DECO', 'FLUTED', 1.6, white, seed)) }], { parapet: 0.7, color: white, seed, coping: aqua });
  if (!k.far) { k.stucco(white, 60).occ(1).box(-ew * 0.55, ent.top, zf - 2, ew * 0.55, ent.top + 0.9, zf + 1.6, 'xXzZY'); k.stucco(aqua, 60).box(-ew * 0.25, ent.top + 0.9, zf - 1.2, ew * 0.25, ent.top + 1.6, zf + 1.1, 'xXzZY'); }
  // the porte-cochere: a thick slab with a rounded nose over the drive, on six columns
  const z0 = zf + 2.2, cw = ew + 1.4;
  k.at(0, 0, z0, 0, () => {
    canopy(k, -cw, cw, cy, pc, { th: cth, r: 3.2, lip: white, color: white, far: true, neon: NEON.pink, neonAt: 'top' });
    if (!k.far) {
      const nose = rectRuns(-cw - 0.03, 0, cw + 0.03, pc + 0.03, [3.23, 3.23, 0, 0], k.arc), path = [];
      for (const cls of ['left', 'fl', 'front', 'fr', 'right']) for (const q of nose.find((e) => e.cls === cls).pts) { const l = path[path.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-4) path.push(q); }
      path[0] = [path[0][0], 0.06]; path[path.length - 1] = [path[path.length - 1][0], 0.06];
      k.neon(path.map((p) => [p[0], cy + cth * 0.22, p[1]]), NEON.aqua, { back: [0, 0, -1], maxLights: 8 });
      k.stucco(aqua, 60).occ(1).slab(rectRuns(-cw + 0.5, 0.2, cw - 0.5, pc - 0.5, [2.7, 2.7, 0, 0], k.arc), cy - 0.12, cy, { bottom: true, under: 0.5 });   // a coloured soffit panel
      for (const [x, z] of [[-cw + 1.2, pc - 3.4], [cw - 1.2, pc - 3.4], [-cw + 1.2, pc * 0.42], [cw - 1.2, pc * 0.42], [-cw + 3.6, pc - 1.1], [cw - 3.6, pc - 1.1]]) column(k, x, z, 0, cy - 0.12, 0.3, { color: aqua, trim: white, segs: 12 });
      for (const x of [-4.6, 0, 4.6]) for (const z of [2.2, 6.2]) k.lamp(x, cy - 0.12, z, [1, 0.84, 0.62], { power: 26, radius: 7, radiance: 10, glow: 0.4, size: 0.1 });
      doorway(k, -1.5, 0, 2.2, 2.5, { leaves: 2 }); doorway(k, 1.5, 0, 2.2, 2.5, { leaves: 2 });
      k.tile([0.52, 0.2, 0.22], 30, 1).occ(1).box(-3.2, 0, 0, 3.2, 0.03, pc - 1.5, 'xXZY');             // the carpet to the kerb, in terrazzo
    }
    roofSign(k, 0, cy + cth, pc - 1.6, { category: 'landmark:' + m.id, height: 2.6, maxWidth: cw * 1.55, neon: NEON.pink, far: true, leg: 0.7 });
  });
  for (const [x, z] of [[-cw + 1.2, pc - 3.4], [cw - 1.2, pc - 3.4], [-cw + 1.2, pc * 0.42], [cw - 1.2, pc * 0.42], [-cw + 3.6, pc - 1.1], [cw - 3.6, pc - 1.1]]) k.collide(x - 0.3, 0, z0 + z - 0.3, x + 0.3, cy, z0 + z + 0.3);
  // planters against the front wall, palms in them, and a lamp in the ground under every palm and between portholes
  for (const s of [-1, 1]) {
    const xa = s * (cw + 1.2), xb = s * (hw - 4.5), a = Math.min(xa, xb), b = Math.max(xa, xb);
    if (!k.far) { k.stucco(white, 70).occ(1).box(a, 0, zf + 0.5, b, 0.55, zf + 2.9, 'xXzZ'); k.solid(SOLID.CONCRETE, [0.2, 0.16, 0.12], 0, 200).box(a + 0.15, 0.4, zf + 0.65, b - 0.15, 0.47, zf + 2.75, 'Y'); }
    k.collide(a, 0, zf + 0.5, b, 0.55, zf + 2.9);
    const n = Math.max(2, Math.round((b - a) / 4.4));
    for (let i = 0; i < n; i++) { const x = a + (b - a) * (i + 0.5) / n;
      k.plant(i % 2 ? 'small' : 'royal', x, zf + 1.7, { y: 0.45 }); if (i % 2) k.plant('shrub', x + 1.1, zf + 1.6, { y: 0.45 });
      k.uplight(x + (i % 2 ? 0 : 0.9), zf + 3.35, [0, 0.93, -0.36], i % 2 ? [1, 0.55, 0.68] : [1, 0.88, 0.7], { power: i % 2 ? 10 : 14, radius: i % 2 ? 7 : 12 }); }
  }
  // the forecourt: a sculpture of three steel fins on a plinth, two tall palms at the drive, bays at the sides
  const sx = -hw + 3.5, sz = D / 2 - 7;
  if (!k.far) { k.bare(0, 0.2).occ(1); for (let i = 0; i < 3; i++) k.box(sx + i * 0.9, 0.35, sz - i * 0.5, sx + 0.25 + i * 0.9, 3.4 + i * 1.3, sz + 1.4 - i * 0.5, 'xXzZYy'); k.concrete(CONC).box(sx - 0.7, 0, sz - 1.6, sx + 3.1, 0.35, sz + 2); k.uplight(sx + 1.2, sz + 2.4, [0, 0.9, -0.44], [0.8, 0.9, 1], { power: 8, radius: 8 }); }
  k.collide(sx - 0.7, 0, sz - 1.6, sx + 3.1, 4, sz + 2);
  for (const s of [-1, 1]) { k.plant('coconut', s * (cw + 3.5), D / 2 - 3.2); k.uplight(s * (cw + 3.5) + 0.8, D / 2 - 3.2, [-0.25 * s, 0.95, 0], [1, 0.88, 0.7], { power: 14, radius: 12 }); }
  roofPlant(k, -hw + 2, zb + 1.5, hw - 2, zf - 4, hall.roofY, { units: 5, tank: false });
  bayLines(k, hw - 12, hw + 1, D / 2 - 6.5, D / 2 - 1, 2.7);
}

// ------------------------------------------------------------------------------------------------ hospitals and police
/** Red cross in a white field on a wall (inside onRun), lit from within at night. */
function redCross(k, x, y, s) {
  if (k.far) return;
  k.paint(WHITE, 0.5, 20).occ(1).box(x - s * 0.8, y - s * 0.8, 0, x + s * 0.8, y + s * 0.8, 0.12, 'xXZYy');
  k.emissive([0.9, 0.05, 0.06], 4).box(x - s * 0.55, y - s * 0.18, 0.12, x + s * 0.55, y + s * 0.18, 0.16, 'xXZYy').box(x - s * 0.18, y - s * 0.55, 0.12, x + s * 0.18, y + s * 0.55, 0.16, 'xXZYy');
  k.light(x, y, 1.6, [4, 0.3, 0.3], 7, CHANNEL.NEON); k.glow(x, y, 0.2, s * 1.6, [1.2, 0.08, 0.08], CHANNEL.NEON, 2, true);
}
/**
 * Hospital: a ward slab on a wider ground floor, a lift and stair tower carrying the cross, an ambulance bay under a
 * canopy. o: { wall, trim, glassBand (window type), age, pad (helipad) }.
 */
export function hospital(k, m, o) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = o.wall, seed = sb(k, o.trim, o.age ?? 0), st = 3.6, G = 4.5, floors = Math.max(2, Math.round((m.heightM - G - 1) / st) + 1);
  const x0 = -Wd / 2 + 3, x1 = Wd / 2 - 3, zf = D / 2 - 11, zb = -D / 2 + 3, flip = k.h(1) < 0.5 ? -1 : 1;
  const ward = W('PUNCHED', o.windows ?? 'CLINIC', 3.6, wall, seed), lobby = W('SHOPFRONT', 'LOBBY', 4, wall, seed), service = W('BLANK', 'SERVICE', 5, wall, seed);
  // podium floor the full width, ward slab set back above it
  const pod = block(k, x0, zb, x1, zf, { floors: 1, ground: G, wall, seed, coping: o.band, roofKind: 3, roof: [0.78, 0.78, 0.76], groundSpec: (r) => (r.cls === 'front' ? lobby : r.cls === 'back' ? service : ward) });
  const sx0 = x0 + 4, sx1 = x1 - 4, sz1 = zf - 3, sz0 = Math.max(zb + 2, sz1 - 18);
  const slab = mass(k, rectRuns(sx0, sz0, sx1, sz1), G, [{ h: (floors - 1) * st, storey: st, grounded: false, spec: (r) => (r.cls === 'left' || r.cls === 'right' ? W('BLANK', 'STUCCO', 5, wall, seed, true) : ward) }], { parapet: 1.1, color: wall, seed, coping: o.band, roofKind: 3, roof: [0.78, 0.78, 0.76] });
  if (!k.far) for (let i = 1; i < floors; i++) k.paint(o.band, 0.5, 40).occ(1).ledge([slab.runs.find((r) => r.cls === 'front')], G + i * st - 0.25, G + i * st, 0.35, { lip: o.band });
  // lift tower on the street face with the cross
  const tx = flip < 0 ? sx0 + 2 : sx1 - 8, tw = 6, tt = mass(k, rectRuns(tx, sz1 - 1, tx + tw, sz1 + 2.2), G, [{ h: (floors - 1) * st + 3.6, storey: st, grounded: false, spec: W('BLANK', 'STUCCO', 6, shade(wall, 0.97), seed) }], { roof: [0.78, 0.78, 0.76], roofKind: 3, collide: false });
  k.collide(tx, G, sz1 - 1, tx + tw, tt.top, sz1 + 2.2);
  k.onRun(front(tt), (len) => { redCross(k, len / 2, tt.top - 2.4, 1.6); });
  // entrance canopy and the ambulance bay to one side
  k.onRun(front(pod), (len) => { const ex = flip < 0 ? len * 0.62 : len * 0.38, ax = flip < 0 ? len * 0.16 : len * 0.84;
    canopy(k, ex - 6, ex + 6, 3.3, 5.5, { th: 0.45, lip: o.band, lamps: 4, far: true }); if (!k.far) for (const s of [-5.4, 5.4]) column(k, ex + s, 5.0, 0, 3.3, 0.2, { round: true });
    doorway(k, ex, 0, 3.2, 2.5, { leaves: 2 }); nameSign(k, ex, G - 0.42, 5.52, { height: 0.5, maxWidth: 11, far: false });
    k.at(ex, 0, 0, 0, () => nameSign(k, 0, G + 0.5, 0.05, { height: 0.9, maxWidth: len * 0.5, far: true, wallColor: wall }));
    canopy(k, ax - 5, ax + 5, 3.6, 7, { th: 0.3, lip: [0.8, 0.12, 0.1], lamps: 2 }); if (!k.far) { for (const s of [-4.6, 4.6]) column(k, ax + s, 6.5, 0, 3.6, 0.16, {}); k.paint([0.8, 0.12, 0.1], 0.6, 80).occ(1).quad([ax - 4.4, 0.03, 6.8], [ax + 4.4, 0.03, 6.8], [ax + 4.4, 0.03, 6.6], [ax - 4.4, 0.03, 6.6]); } });
  roofPlant(k, sx0 + 1, sz0 + 1, sx1 - 1, sz1 - 2, slab.roofY, { units: 6, tank: false });
  if (o.pad) { const px = flip < 0 ? sx1 - 9 : sx0 + 9; if (!k.far) k.steel(STEEL, 0.5, 50).occ(1).box(px - 7, slab.roofY, (sz0 + sz1) / 2 - 7, px + 7, slab.roofY + 1.6, (sz0 + sz1) / 2 + 7, 'xXzZ'); helipad(k, px, slab.roofY + 1.6, (sz0 + sz1) / 2, 7); beacon(k, px + 7, slab.roofY + 2, (sz0 + sz1) / 2 + 7); }
  else mast(k, tx + tw / 2, tt.top, sz1, 6, {});
  bayLines(k, x0, x1, D / 2 - 6, D / 2 - 0.6, 2.7);
}
/**
 * Police station: a sober block with a stepped entrance between blue lamps, a radio mast, and a fenced yard of
 * patrol-car bays behind or beside it. o: { wall, trim, glass (curtain bands instead of punched windows), pad }.
 */
export function police(k, m, o) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = o.wall, seed = sb(k, o.trim, 1), st = 3.6, G = 4.4, floors = Math.max(2, Math.round((m.heightM - G - 1) / st) + 1), flip = k.h(1) < 0.5 ? -1 : 1;
  const yard = clamp(Wd * 0.3, 12, 20), x0 = -Wd / 2 + 2 + (flip < 0 ? yard : 0), x1 = Wd / 2 - 2 - (flip > 0 ? yard : 0), zf = D / 2 - 6, zb = -D / 2 + 3, blue = [0.2, 0.36, 0.62];
  const up = o.glass ? W('CURTAIN', 'BANDED', 1.6, [0.2, 0.34, 0.5], seed) : W('PUNCHED', floors > 3 ? 'SLOT' : 'SQUARE', 3.2, wall, seed), blank = W('BLANK', o.glass ? 'CONCRETE' : 'STUCCO', 5, wall, seed);
  const b = block(k, x0, zb, x1, zf, { floors, ground: G, storey: st, wall, seed, coping: blue, parapet: 1.0, groundSpec: (r) => (r.cls === 'front' ? W('SHOPFRONT', 'LOBBY', 4, wall, seed) : r.cls === 'back' ? W('BLANK', 'SERVICE', 5, wall, seed) : W('PUNCHED', 'SLOT', 3.2, wall, seed)), upperSpec: (r) => (r.cls === 'left' || r.cls === 'right' ? (o.glass ? blank : up) : up) });
  if (!k.far) k.ledge(b.runs, G - 0.2, G + 0.2, 0.15, { lip: blue });
  k.onRun(front(b), (len) => {
    steps(k, len / 2 - 4, len / 2 + 4, 2.2, 0.75, { n: 4 }); if (!k.far) k.concrete([0.72, 0.71, 0.68]).occ(1).box(len / 2 - 4, 0, 0, len / 2 + 4, 0.75, 2.2, 'xXZY'); k.collide(len / 2 - 4, 0, 0, len / 2 + 4, 0.75, 2.2);
    canopy(k, len / 2 - 4.4, len / 2 + 4.4, 3.6, 2.6, { th: 0.4, lip: blue, lamps: 2, far: true }); doorway(k, len / 2, 0.75, 2.4, 2.4, {});
    nameSign(k, len / 2, G + 0.55, 0.05, { height: 0.8, maxWidth: len * 0.7, far: true, wallColor: wall });
    if (!k.far) for (const s of [-1, 1]) { const x = len / 2 + s * 4.3; k.steel([0.15, 0.2, 0.3], 0.5, 30).occ(1).cyl(x, 0, 3.2, 0.07, 2.6, { segs: 6, cap: false }); k.emissive([0.25, 0.45, 1], 6, CHANNEL.STREET).ball(x, 2.8, 3.2, 0.24, { segs: 8 }); k.light(x, 2.8, 3.2, [6, 12, 30], 7, CHANNEL.STREET); k.glow(x, 2.8, 3.2, 0.7, [0.6, 1.2, 3], CHANNEL.STREET, 0); }
    flagpole(k, len / 2 + 7.5, 3.5, 9, [0.2, 0.3, 0.6]);
  });
  roofPlant(k, x0 + 1, zb + 1, x1 - 1, zf - 1, b.roofY, { units: 4, tank: false, aerial: false });
  if (o.pad) helipad(k, x0 + (x1 - x0) * 0.7, b.roofY + 0.05, (zb + zf) / 2, 6.5);
  mast(k, x0 + (x1 - x0) * 0.2, b.roofY, zb + 4, 12, { r: 0.16 });
  // the yard: rail fence, a gate to the street, bays
  const y0 = flip < 0 ? -Wd / 2 + 1 : x1 + 1.2, y1 = y0 + yard - 0.2;
  compound(k, y0, zb, y1, D / 2 - 2, { x: (y0 + y1) / 2, w: 6 }, { h: 2.4, t: 0.1, style: 'rail', color: [0.66, 0.65, 0.62], rail: [0.55, 0.57, 0.6] });
  barrier(k, (y0 + y1) / 2 - 3, (y0 + y1) / 2 + 2.9, D / 2 - 2.3); bayLines(k, y0 + 1, y1 - 1, zb + 1, zb + 6.4, 2.8);
}
export function fireStation(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], brick = [0.58, 0.3, 0.22], seed = sb(k, TRIM.WHITE, 1), x0 = -Wd / 2 + 4, x1 = Wd / 2 - 4, zf = D / 2 - 9, zb = -D / 2 + 3, G = 5.4, red = [0.72, 0.08, 0.07];
  const bw = W('BLANK', 'BRICK', 4, brick, seed), pb = W('PUNCHED', 'BRICK', 3.4, brick, seed);
  // appliance bays: two tall doors in a brick front, quarters above
  const bx1 = x0 + (x1 - x0) * 0.62, b = block(k, x0, zb, bx1, zf, { floors: 2, ground: G, storey: 3.4, wall: brick, seed, coping: [0.82, 0.8, 0.74], groundSpec: bw, upperSpec: (r) => (r.cls === 'front' || r.cls === 'back' ? pb : bw) });
  k.onRun(front(b), (len) => { const dw = (len - 3) / 2 - 0.5;
    for (const i of [0, 1]) { const a = 1.5 + i * (dw + 1), c = a + dw; if (k.far) continue; k.paint(red, 0.45, 40).occ(0.9).box(a, 0, 0, c, 4.5, 0.05, 'Z'); if (k.near) { k.glass([0.12, 0.14, 0.16], 0.1).box(a + 0.3, 2.6, 0.05, c - 0.3, 3.5, 0.07, 'Z'); k.stucco([0.82, 0.8, 0.74], 60).occ(1).box(a - 0.25, 4.5, 0, c + 0.25, 4.9, 0.2, 'xXZYy').box(a - 0.25, 0, 0, a, 4.5, 0.2, 'xXZ').box(c, 0, 0, c + 0.25, 4.5, 0.2, 'xXZ'); } k.lamp((a + c) / 2, 5.0, 0.5, [1, 0.85, 0.6], { power: 40, radius: 10, radiance: 12, glow: 0.5, spot: [0, -1, 0.3], outer: 70, inner: 40 }); }
    nameSign(k, len / 2, G + 0.2, 0.05, { height: 0.7, maxWidth: len * 0.8, far: true, wallColor: brick });
    if (k.near) { k.paint([0.85, 0.7, 0.1], 0.8, 150).occ(1); for (const i of [0, 1]) { const a = 1.5 + i * (dw + 1); k.quad([a, 0.03, 8.5], [a + 0.15, 0.03, 8.5], [a + 0.15, 0.03, 0.1], [a, 0.03, 0.1]); k.quad([a + dw - 0.15, 0.03, 8.5], [a + dw, 0.03, 8.5], [a + dw, 0.03, 0.1], [a + dw - 0.15, 0.03, 0.1]); } } });
  // office wing and the hose tower
  const o = block(k, bx1, zb + 4, x1, zf - 2, { floors: 2, ground: 3.6, storey: 3.2, wall: brick, seed, coping: [0.82, 0.8, 0.74], groundSpec: (r) => (r.cls === 'left' ? null : pb), upperSpec: (r) => (r.cls === 'left' ? null : pb) });
  k.onRun(front(o), (len) => { doorway(k, len / 2, 0, 1.6, 2.2, {}); awning(k, len / 2 - 1.4, len / 2 + 1.4, 2.9, { proj: 1.2, color: red }); });
  mass(k, rectRuns(x1 - 4.5, zb, x1, zb + 4), 0, [{ h: 14.4, storey: 3.6, spec: (r) => (r.cls === 'front' ? pb : bw) }], { roof: null });
  pitchedRoof(k, x1 - 4.5, zb, x1, zb + 4, 14.4, { pitch: 0.6, over: 0.3, kind: 1, color: ROOF_TILE[0] });
  flagpole(k, x0 - 1.5, zf + 4, 10); roofPlant(k, x0 + 1, zb + 1, bx1 - 1, zf - 1, b.roofY, { units: 2, tank: false });
}

// ------------------------------------------------------------------------------------------------ towers and hotels
const floorsFor = (h, ground, storey, top) => Math.max(2, Math.round((h - ground - top) / storey) + 1);
export const oceanHotel = (k, m) => part(k, decoHotel, { width: m.footprint[0], depth: m.footprint[1], floors: 4, variant: 0, porch: true, corner: 0 }, { named: true, paint: { wall: [0.93, 0.93, 0.9], trim: TRIM.SEA_GREEN, trim2: TRIM.SUN, age: 0, neon: NEON.green, neonAccent: NEON.pink, lit: true, flicker: false, awning: [0.13, 0.42, 0.3] } });
export const pinkCondo = (k, m) => part(k, hotelTower, { width: m.footprint[0], depth: m.footprint[1], floors: floorsFor(m.heightM, 5, 3, 4), variant: 1 }, { named: true, paint: { wall: [0.92, 0.72, 0.72], trim: TRIM.WHITE, trim2: TRIM.FLAMINGO, age: 0, lit: true } });
export const golfApartments = (k, m) => part(k, hotelTower, { width: m.footprint[0], depth: m.footprint[1], floors: 6, floorsExact: true, variant: 0 }, { named: true, paint: { wall: [0.86, 0.79, 0.66], trim: TRIM.PERIWINKLE, trim2: TRIM.PERIWINKLE, age: 1 } });
export function junctionHotel(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1];
  part(k, hotelTower, { width: Wd, depth: D - 12, floors: 6, floorsExact: true, variant: 0 }, { z: -6, named: true, paint: { wall: [0.94, 0.76, 0.6], trim: TRIM.WHITE, trim2: TRIM.TURQUOISE, age: 0, lit: true, neon: NEON.aqua } });
  pool(k, -Wd * 0.3, D / 2 - 12.5, Wd * 0.05, D / 2 - 2, {}); k.collide(-Wd * 0.3, 0, D / 2 - 12.5, Wd * 0.05, 0.16, D / 2 - 2);
}
export const newsTower = (k, m) => { const r = part(k, officeTower, { width: m.footprint[0], depth: m.footprint[1], floors: floorsFor(m.heightM, O_GROUND, O_FLOOR, 5), floorsExact: true, variant: 2, podium: false }, { named: true }); if (r) { helipad(k, 4, r.top + 0.05, -6, 6); mast(k, -8, r.top, 6, 22, { r: 0.3 }); } };
export const tallestTower = (k, m) => part(k, officeTower, { width: m.footprint[0], depth: m.footprint[1], floors: floorsFor(m.heightM, O_GROUND, O_FLOOR, 12), floorsExact: true, variant: 0, podium: true, glass: GLASS_SKINS[1][0] }, { named: true });
/** Two bronze slabs slipped past each other with a concrete core between them. */
export function twinTower(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], glass = GLASS_SKINS[4][0], seed = sb(k, TRIM.STRAW, 0), n = floorsFor(m.heightM, O_GROUND, O_FLOOR, 3), sw = (Wd - 14) / 2, cx = 0;
  const lobby = W('SHOPFRONT', 'OFFICE_LOBBY', 3, CONC, seed), skin = W('CURTAIN', 'BANDED', 1.5, glass, seed), end = W('CURTAIN', 'MIRROR', 1.5, glass, seed);
  const slab = (xa, xb, za, zb, fl) => { const t = mass(k, rectRuns(xa, za, xb, zb), 0, [{ h: O_GROUND, storey: O_GROUND, spec: lobby }, { h: (fl - 1) * O_FLOOR, storey: O_FLOOR, grounded: false, spec: (r) => (r.cls === 'left' || r.cls === 'right' ? end : skin) }, { h: 3.9, storey: 3.9, grounded: false, spec: W('PUNCHED', 'SLOT', 1.5, [0.3, 0.26, 0.22], seed) }], { parapet: 1.2, color: [0.3, 0.26, 0.22], seed, roofKind: 3, roof: [0.5, 0.5, 0.5] }); roofPlant(k, xa + 1, za + 1, xb - 1, zb - 1, t.roofY, { units: 5, tank: false, aerial: false }); return t; };
  const a = slab(-Wd / 2 + 3, -sw + cx + sw / 2 - 3, -D / 2 + 3, D / 2 - 14, n), b = slab(sw / 2 - 1, Wd / 2 - 3, -D / 2 + 10, D / 2 - 7, n - 3);
  const core = mass(k, rectRuns(a.x1, -D / 2 + 9, b.x0, D / 2 - 13), 0, [{ h: O_GROUND + n * O_FLOOR + 3.9, storey: O_FLOOR, spec: W('BLANK', 'CONCRETE', 6, [0.74, 0.72, 0.68], seed) }], { roof: [0.5, 0.5, 0.5], roofKind: 3 });
  mast(k, (a.x1 + b.x0) / 2, core.top, 0, 14, { r: 0.25 }); for (const t of [a, b]) { beacon(k, t.x0 + 0.4, t.top + 0.2, t.z1 - 0.4); beacon(k, t.x1 - 0.4, t.top + 0.2, t.z0 + 0.4); }
  k.onRun(front(b), (len) => { canopy(k, len / 2 - 4, len / 2 + 4, 4.2, 3.5, { th: 0.4, lip: [0.5, 0.4, 0.28], lamps: 3, far: true }); doorway(k, len / 2, 0, 3, 2.6, {}); nameSign(k, len / 2, O_GROUND - 0.7, 0.05, { height: 0.7, maxWidth: len - 3 }); });
  k.at(0, 0, 0, 0, () => { const r = front(a); k.onRun(r, (len) => nameSign(k, len / 2, a.top - 2.6, 0.06, { height: 2.6, maxWidth: len - 2, far: true })); });
}
/** A condominium bent round a court open to the street: three wings of balconies in white with green bands. */
export function courtCondo(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = [0.93, 0.93, 0.9], green = [0.25, 0.55, 0.42], seed = sb(k, TRIM.SEA_GREEN, 0), st = 3.0, G = 4.5, n = floorsFor(m.heightM, G, st, 2), wing = 15;
  const x0 = -Wd / 2 + 3, x1 = Wd / 2 - 3, zb = -D / 2 + 3, zf = D / 2 - 7, H = (n - 1) * st;
  const rooms = W('CONDO', 'SLIDER', 3.9, wall, seed, true), ends = W('BLANK', 'STUCCO', 5, wall, seed, true), gnd = W('SHOPFRONT', 'OFFICE_LOBBY', 3.6, wall, seed), svc = W('PUNCHED', 'SLOT', 3.9, wall, seed);
  const wingOf = (xa, za, xb, zc, faces, open) => { const t = mass(k, rectRuns(xa, za, xb, zc), 0, [{ h: G, storey: G, spec: (r) => (r.cls === 'back' ? svc : gnd) }, { h: H, storey: st, grounded: false, spec: (r) => (faces.includes(r.cls) ? rooms : r.cls === open ? null : r.cls === 'back' ? svc : ends) }], { parapet: 1.1, color: wall, seed, coping: green, roofKind: 3, roof: [0.8, 0.8, 0.78] });
    for (const c of faces) balconyRows(k, t.runs.find((r) => r.cls === c), G, st, n - 1, { proj: 1.5, guard: 'solid', guardColor: wall, bay: 3.9 }); return t; };
  const back = wingOf(x0, zb, x1, zb + wing, ['front'], null), left = wingOf(x0, zb + wing, x0 + wing, zf, ['right', 'front'], 'back'), right = wingOf(x1 - wing, zb + wing, x1, zf, ['left', 'front'], 'back');
  if (!k.far) for (const t of [back, left, right]) k.ledge(t.runs, t.roofY - 0.5, t.roofY - 0.1, 0.1, { lip: green });
  roofPlant(k, x0 + 1, zb + 1, x0 + wing + 6, zb + wing - 1, back.roofY, { units: 4, tank: false }); helipad(k, x1 - 12, back.roofY + 0.05, zb + wing / 2, 6); beacon(k, x1 - 0.5, back.top + 0.2, zb + 0.5); beacon(k, x0 + 0.5, left.top + 0.2, zf - 0.5); beacon(k, x1 - 0.5, right.top + 0.2, zf - 0.5);
  k.onRun(front(left), (len) => bladeSign(k, len - 1, G + 3, G + 14, 0, { category: 'landmark:' + m.id, variant: 1, neon: NEON.green, color: [0.15, 0.35, 0.28] }));
  // the court: a porte-cochere at the back wing, a pool in front of it
  k.at(0, 0, zb + wing, 0, () => { canopy(k, -6, 6, 3.6, 6, { th: 0.4, lip: green, lamps: 4, far: true }); if (!k.far) for (const s of [-5.4, 5.4]) column(k, s, 5.4, 0, 3.6, 0.22, { round: true }); doorway(k, 0, 0, 3, 2.5, {}); nameSign(k, 0, 4.0, 6.03, { height: 0.5, maxWidth: 10 }); });
  pool(k, -9, zf - 16, 9, zf - 4, {}); k.collide(-9, 0, zf - 16, 9, 0.16, zf - 4);
  yardWall(k, [[x0 + wing, zf + 0.5], [-4, zf + 0.5]], { h: 1.2, color: wall }); yardWall(k, [[4, zf + 0.5], [x1 - wing, zf + 0.5]], { h: 1.2, color: wall });
}
export const radioStudio = (k, m) => { part(k, officeBlock, { width: m.footprint[0], depth: m.footprint[1], floors: 4, variant: 2 }, { named: true, paint: { glass: GLASS_SKINS[6][0], wall: [0.3, 0.3, 0.32], trim: TRIM.SLATE } });
  // the guitar on the roof: a neck and a body outlined in neon, and the station mast
  const y = m.heightM + 0.4, x = -m.footprint[0] / 2 + 8, z = m.footprint[1] / 2 - 4.5;
  if (!k.far) { k.steel([0.5, 0.1, 0.1], 0.4, 20).occ(1).box(x, y + 0.6, z - 0.15, x + 3.6, y + 2.8, z + 0.15, 'xXzZYy').box(x + 3.6, y + 1.4, z - 0.1, x + 9, y + 2.0, z + 0.1, 'xXzZYy').box(x + 9, y + 1.2, z - 0.1, x + 10.2, y + 2.2, z + 0.1, 'xXzZYy'); for (const px of [x + 0.6, x + 3, x + 8]) k.steel(STEEL, 0.5, 50).box(px - 0.05, y - 0.4, z - 0.05, px + 0.05, y + 1.4, z + 0.05, 'xXzZ');
    k.neon([[x - 0.05, y + 0.55, z + 0.2], [x + 3.65, y + 0.55, z + 0.2], [x + 3.65, y + 1.35, z + 0.2], [x + 10.25, y + 1.15, z + 0.2], [x + 10.25, y + 2.25, z + 0.2], [x + 3.65, y + 2.05, z + 0.2], [x + 3.65, y + 2.85, z + 0.2], [x - 0.05, y + 2.85, z + 0.2]], NEON.red, { closed: true, back: [0, 0, -1], maxLights: 2 }); }
  mast(k, m.footprint[0] / 2 - 7, m.heightM - 1, -m.footprint[1] / 2 + 6, 24, { r: 0.3 }); };
export const lawOffice = (k, m) => part(k, decoShop, { width: m.footprint[0], depth: m.footprint[1], floors: 2, variant: 1, corner: 1 }, { named: true, paint: { wall: [0.92, 0.75, 0.74], trim: TRIM.WHITE, trim2: TRIM.FLAMINGO, age: 1, awning: [0.78, 0.2, 0.29] } });
export function portOffice(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1];
  part(k, officeBlock, { width: Wd * 0.6, depth: D - 10, floors: 3, variant: 1 }, { x: -Wd * 0.18, z: -3, named: true, paint: { wall: [0.85, 0.84, 0.8], trim: TRIM.NAVY, age: 2 } });
  // the dock gate beside it: a booth between two barriers
  const gx = Wd * 0.3, gz = D / 2 - 5;
  if (!k.far) { k.stucco([0.85, 0.84, 0.8], 90).occ(1).box(gx - 1.2, 0, gz - 1.5, gx + 1.2, 2.7, gz + 1.5); k.glass([0.12, 0.16, 0.18]).box(gx - 1.22, 1.0, gz - 1.3, gx + 1.22, 2.1, gz + 1.3, 'xX').box(gx - 1.0, 1.0, gz + 1.5, gx + 1.0, 2.1, gz + 1.52, 'Z'); k.paint([0.2, 0.25, 0.4], 0.5, 40).box(gx - 1.6, 2.7, gz - 1.9, gx + 1.6, 2.9, gz + 1.9, 'xXzZYy'); k.lamp(gx, 2.68, gz + 1.7, [1, 0.9, 0.7], { power: 30, radius: 9, radiance: 10, glow: 0.4 }); }
  k.collide(gx - 1.2, 0, gz - 1.5, gx + 1.2, 2.9, gz + 1.5); barrier(k, gx - 1.5, gx - 8, gz); barrier(k, gx + 1.5, gx + 8, gz);
}
export const printWorks = (k, m) => part(k, warehouse, { width: m.footprint[0], depth: m.footprint[1], floors: 2, variant: 1 }, { named: true });

// ------------------------------------------------------------------------------------------------ houses
export const modernVilla = (k, m) => part(k, mansion, { width: m.footprint[0], depth: m.footprint[1], floors: 2, variant: 1 }, { named: true });
export const stiltShack = (k, m) => part(k, bungalow, { width: Math.min(18, m.footprint[0]), depth: m.footprint[1], variant: 1, style: 'residential_poor' }, { named: true, paint: { wall: [0.9, 0.55, 0.66], trim: TRIM.PALE_BLUE, trim2: TRIM.PALE_BLUE, age: 2 } });
/** The big house: a three-storey centre between two lower wings, a pool on each side, a low wall along the road. */
export function estate(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = [0.86, 0.52, 0.47], paint = { wall, trim: TRIM.WHITE, trim2: TRIM.OXBLOOD, age: 0 }, seed = sb(k, TRIM.WHITE, 0), tile = ROOF_TILE[0];
  part(k, mansion, { width: 70, depth: 70, floors: 3, variant: 0, wallColor: wall }, { z: -D / 2 + 37, paint, named: true });
  for (const s of [-1, 1]) {                                        // wings: arcaded pavilions under tile roofs
    const xa = s * 39 - 13, xb = s * 39 + 13, za = -D / 2 + 14, zb = za + 16;
    mass(k, rectRuns(xa, za, xb, zb), 0, [{ h: 6.8, storey: 3.4, spec: (r) => (r.cls === 'front' ? W('MANSION', 'ARCADE', 3.2, wall, seed) : W('MANSION', 'ARCHED', 3.2, wall, seed)) }], { roof: null });
    pitchedRoof(k, xa, za, xb, zb, 6.8, { pitch: 0.36, over: 0.6, kind: 1, color: tile });
    pool(k, s * 62 - 11, za - 2, s * 62 + 11, za + 22, { r: 2 }); k.collide(s * 62 - 11, 0, za - 2, s * 62 + 11, 0.16, za + 22);
  }
  compound(k, -Wd / 2 + 1, -D / 2 + 1, Wd / 2 - 1, D / 2 - 1, { x: 0, w: 7 }, { h: 1.5, color: [0.93, 0.9, 0.84], piers: 6 });
  // gate piers with lanterns, a round fountain on the forecourt
  if (!k.far) { for (const s of [-1, 1]) { k.stucco([0.93, 0.9, 0.84], 60).occ(1).box(s * 4 - 0.5, 0, D / 2 - 1.5, s * 4 + 0.5, 3, D / 2 - 0.5); k.lamp(s * 4, 3.4, D / 2 - 1, [1, 0.85, 0.6], { power: 30, radius: 9, radiance: 12, glow: 0.5, size: 0.16 }); }
    const fz = D / 2 - 22; k.stucco([0.9, 0.88, 0.82], 80).occ(1).cyl(0, 0, fz, 4, 0.6, { segs: k.near ? 20 : 10, cap: false }); k.solid(SOLID.POOL_WATER, [0.25, 0.76, 0.79], 6, 0).cyl(0, 0.44, fz, 3.8, 0.45, { segs: k.near ? 20 : 10 }); k.stucco([0.9, 0.88, 0.82], 80).cyl(0, 0.4, fz, 0.5, 1.8, { segs: 8 }).cyl(0, 1.8, fz, 1.3, 2.0, { segs: 10, bottom: true }); k.collide(-3, 0, fz - 3, 3, 0.6, fz + 3); }
  k.at(5.6, 0, D / 2 - 0.95, 0, () => nameSign(k, 0, 1.0, 0, { height: 0.35, maxWidth: 2.4, lit: false, wallColor: [0.93, 0.9, 0.84] }));
  // grounds: a royal palm avenue from the gate to the fountain, coconuts along the road wall and round the pools
  for (let z = D / 2 - 6; z > D / 2 - 20; z -= 4.5) for (const s of [-1, 1]) k.plant('royal', s * 6.5, z, { scale: 1.0 + k.h(80 + z) * 0.1 });
  for (let x = -Wd / 2 + 6; x < Wd / 2 - 5; x += 7) if (Math.abs(x) > 9) k.plant(k.h(81 + x) < 0.6 ? 'coconut' : 'shrub', x, D / 2 - 3.2, { scale: 0.85 + k.h(82 + x) * 0.3 });
  for (const s of [-1, 1]) for (const dz of [-6, 26]) k.plant('coconut', s * 62 + (k.h(83 + dz) - 0.5) * 10, -D / 2 + 14 + dz, { scale: 0.9 + k.h(84 + dz) * 0.25 });
}
/** Three abandoned houses side by side: the stock mansions gone grey, stained to the eaves. */
export function ruins(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], w = Wd / 3;
  [0, 2, 0].forEach((variant, i) => part(k, mansion, { width: w - 1, depth: D, floors: 2, variant, wallColor: [[0.74, 0.69, 0.62], [0.7, 0.7, 0.68], [0.76, 0.66, 0.6]][i] }, { x: (i - 1) * w, salt: i, paint: { age: 3, trim: TRIM.STRAW, trim2: TRIM.SLATE, lit: false } }));
  k.at(-Wd / 2 + 6, 0, D / 2 - 0.6, 0, () => nameSign(k, 0, 1.6, 0, { height: 0.9, maxWidth: 5, lit: false, double: 0.1 }));
}
/** Golf clubhouse: a two-storey centre and two low wings under tile, green awnings, a porch for cars. */
export function clubhouse(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = [0.93, 0.88, 0.76], seed = sb(k, TRIM.FOREST, 0), tile = ROOF_TILE[1], green = [0.13, 0.42, 0.3], zb = -D / 2 + 3, zf = D / 2 - 12;
  const centre = mass(k, rectRuns(-12, zb, 12, zf), 0, [{ h: 7.0, storey: 3.5, spec: (r) => (r.cls === 'back' ? W('MANSION', 'ARCADE', 3.4, wall, seed) : W('MANSION', 'ARCHED', 3.4, wall, seed)) }], { roof: null });
  pitchedRoof(k, -12, zb, 12, zf, 7.0, { pitch: 0.36, over: 0.7, kind: 1, color: tile });
  for (const s of [-1, 1]) { const xa = s < 0 ? -Wd / 2 + 3 : 12, xb = s < 0 ? -12 : Wd / 2 - 3; const wg = mass(k, rectRuns(xa, zb + 2, xb, zf - 3), 0, [{ h: 3.8, storey: 3.8, spec: (r) => (r.cls === (s < 0 ? 'right' : 'left') ? null : W('MANSION', 'SHUTTERS', 3.4, wall, seed)) }], { roof: null });
    pitchedRoof(k, xa, zb + 2, xb, zf - 3, 3.8, { pitch: 0.34, over: 0.6, kind: 1, color: tile });
    k.onRun(front(wg), (len) => { for (let x = 1.7; x < len - 1; x += 3.4) awning(k, x - 1.1, x + 1.1, 2.9, { proj: 1.0, drop: 0.5, color: green, pattern: 2 }); }); }
  k.onRun(front(centre), (len) => { k.roofing(1, tile, 110); tiltSlab(k, len / 2 - 5, 0, len / 2 + 5, 7, 3.9, 3.9, 0.3); if (!k.far) for (const [x, z] of [[-4.5, 6.4], [4.5, 6.4], [-4.5, 3.2], [4.5, 3.2]]) column(k, len / 2 + x, z, 0, 3.9, 0.22, {});
    doorway(k, len / 2, 0, 2.4, 2.4, { metal: false }); nameSign(k, len / 2, 3.6, 7.03, { height: 0.45, maxWidth: 8, lit: false, wallColor: wall }); for (const s of [-3, 3]) if (!k.far) k.lamp(len / 2 + s, 3.85, 5, [1, 0.85, 0.6], { power: 24, radius: 8, radiance: 10, glow: 0.4 }); });
  for (const [x, z] of [[-4.5, zf + 6.4], [4.5, zf + 6.4]]) k.collide(x - 0.25, 0, z - 0.25, x + 0.25, 3.9, z + 0.25);
  compound(k, -Wd / 2 + 1, zf + 1, Wd / 2 - 1, D / 2 - 1, { x: Wd * 0.3, w: 7 }, { h: 1.3, color: wall, piers: 5 });
  bayLines(k, -Wd / 2 + 3, -8, D / 2 - 7, D / 2 - 1.6, 2.7); flagpole(k, 9, zf + 9, 9, green);
}
/** Marina hall: a long white shed of boat stores with a harbour office and a signal mast at the street end. */
export function marina(k, m) {
  const Wd = m.footprint[0], D = m.footprint[1], wall = [0.94, 0.94, 0.92], blue = [0.15, 0.36, 0.6], seed = sb(k, TRIM.NAVY, 1), x0 = -Wd / 2 + 4, x1 = Wd / 2 - 4, zb = -D / 2 + 3, zo = D / 2 - 24;
  mass(k, rectRuns(x0, zb, x1, zo), 0, [{ h: 8.4, storey: 4.2, spec: (r) => (r.cls === 'front' ? null : r.cls === 'back' ? { style: F('WAREHOUSE', 'DOORS'), bays: 4, color: wall, seed } : W('WAREHOUSE', 'TILT_UP', 6.3, wall, seed, true)) }], { roof: null });
  pitchedRoof(k, x0, zb, x1, zo, 8.4, { pitch: 0.18, over: 0.4, kind: 2, color: [0.36, 0.5, 0.62], gable: true, wall, wear: 120 });
  const office = block(k, x0, zo, x1, D / 2 - 8, { floors: 3, ground: 4.2, storey: 3.3, wall, seed, coping: blue, groundSpec: (r) => (r.cls === 'back' ? null : W('SHOPFRONT', 'SHOWROOM', 4.6, wall, seed)), upperSpec: (r) => (r.cls === 'back' ? W('BLANK', 'STUCCO', 5, wall, seed) : W('PUNCHED', 'RIBBON', 3.3, wall, seed)) });
  k.onRun(front(office), (len) => { balconyRows(k, front(office), 4.2, 3.3, 2, { proj: 1.6, guard: 'rail', guardColor: blue, bay: len }); canopy(k, len / 2 - 4, len / 2 + 4, 3.2, 3, { lip: blue, lamps: 3 }); doorway(k, len / 2, 0, 2.6, 2.4, {}); roofSign(k, len / 2, office.top, -1, { category: 'landmark:' + m.id, height: 1.8, maxWidth: len - 3, neon: NEON.azure, far: true }); });
  // signal mast with a yard-arm, and a boat hoist frame beside the shed
  if (!k.far) { const mx = x1 - 3, mz = D / 2 - 5; k.paint(WHITE, 0.5, 40).occ(1).cyl(mx, 0, mz, 0.14, 16, { segs: 6, r1: 0.07 }); k.pipe([[mx - 3, 11, mz], [mx + 3, 11, mz]], 0.05, 4); k.collide(mx - 0.2, 0, mz - 0.2, mx + 0.2, 16, mz + 0.2); }
  beacon(k, x1 - 3, 16.2, D / 2 - 5); roofPlant(k, x0 + 1, zo + 1, x1 - 1, D / 2 - 9, office.roofY, { units: 3, tank: false }); bayLines(k, x0, x1 - 6, D / 2 - 6.5, D / 2 - 1.2, 2.7);
}
