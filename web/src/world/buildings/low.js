// The low city: strip malls, diners, shop rows, bungalows, villas, mansions and filling stations
// (design/brief/architecture.md sections 9, 11, 14 to 17).

import { CHANNEL } from '../../core/ids.js';
import { clamp, hashInts } from '../../core/math.js';
import { rectRuns, lineRun, shade, mixColor } from './kit.js';
import { scheme, ROOF_TILE } from './palette.js';
import { F, WHITE, DARK, STEEL, mass, railing, balcony, canopy, awning, steps, column, doorway, pitchedRoof, roofPlant, roofSign, pylonSign, wallSign, bladeSign, pool, bayLines, yardWall, windowUnits, bySide, tiltSlab, aerial } from './parts.js';

const SHOP_CATS = ['shop', 'market', 'pharmacy', 'cafe', 'bar', 'shop', 'garage', 'shop'];
const PAVE = [0.70, 0.68, 0.64];
/** A flat slab on the ground (drives, paths, forecourts), a few centimetres proud so it never fights the lot surface. */
function pad(k, x0, z0, x1, z1, color = PAVE, o = {}) {
  if (k.far) return;
  if (o.tile) k.tile(color, o.tile, o.pattern ?? 3); else k.concrete(color, o.joint ?? 20, 100);
  k.occ(1).box(x0, 0, z0, x1, o.h ?? 0.04, z1, 'xXzZY');
}
/** Lamp on a pole for car parks and forecourts: pole, arm, lens, light and glow, with a collider. */
function lotLamp(k, x, z, o = {}) {
  const h = o.h ?? 7, dx = o.dx ?? 0.9;
  if (!k.far) { k.steel(STEEL, 0.5, 40).occ(1).cyl(x, 0, z, 0.07, h, { cap: false, segs: k.near ? 6 : 4 }); k.box(Math.min(x, x + dx), h, z - 0.05, Math.max(x, x + dx), h + 0.08, z + 0.05, 'xXzZYy'); k.lamp(x + dx * 0.85, h, z, [1, 0.74, 0.42], { power: 70, radius: 15, radiance: 16, glow: 0.9, spot: [0, -1, 0], outer: 75, inner: 50 }); }
  k.collide(x - 0.12, 0, z - 0.12, x + 0.12, 3, z + 0.12);
}

// ------------------------------------------------------------------------------------------------ strip mall
/**
 * Strip mall behind its car park. Variants: 0 one bar with a covered walk, 1 L-shaped with a return wing,
 * 2 a bar ending in a taller anchor store. The fascia over the walk carries one lit sign per unit.
 */
export function stripMall(k, lot) {
  const fam = lot.style === 'latin_quarter' || lot.style === 'residential_poor' ? 'latin' : 'resort', S = scheme(lot.seed ^ 0x18, fam, lot.style), W = lot.width, D = lot.depth, seed = S.seedByte;
  let variant = (((lot.variant ?? Math.floor(k.h(1) * 3)) % 3) + 3) % 3; if (variant === 1 && W < 46) variant = 0;
  const x0 = -W / 2 + 1, x1 = W / 2 - 1, zb = -D / 2 + 1.5, bd = clamp(D * 0.36, 9, 14), zs = zb + bd, G = 4.4, WALK = 2.6, wall = S.wall, trim = S.trimC, flip = k.h(2) < 0.5 ? -1 : 1;
  const fascia = Math.floor(k.h(3) * 3), fcol = fascia === 1 ? ROOF_TILE[Math.floor(k.h(4) * 3)] : fascia === 2 ? [0.3, 0.36, 0.4] : mixColor(wall, trim, k.h(4) < 0.5 ? 1 : 0);
  const service = { style: F('SHOPFRONT', 'SERVICE'), bay: 6.5, color: shade(wall, 0.93), seed }, blank = { style: F('BLANK', 'STUCCO'), bay: 4, color: wall, seed };
  // a range of shops: wall, covered walk on posts, fascia with signs
  const range = (r, face, units, salt) => {
    const runs = rectRuns(r.x0, r.z0, r.x1, r.z1), opp = { front: 'back', left: 'right', right: 'left' }[face];
    const shop = { style: F('SHOPFRONT', 'RETAIL', k.h(salt) < 0.3), bays: units, color: wall, seed, occ: [1, 0.55] };
    const m = mass(k, runs, 0, [{ h: G, spec: (run) => (run.cls === face ? shop : run.cls === opp ? service : blank) }], { parapet: 0.8, color: wall, seed, coping: WHITE });
    k.onRun(runs.find((e) => e.cls === face), (len) => {
      const uw = len / units, fy0 = 3.15, fy1 = fy0 + 1.25;
      if (!k.far) {
        k.concrete(PAVE, 15, 80).occ(1).box(0, 0, 0, len, 0.14, WALK + 0.3, 'xXZY');
        k.stucco(WHITE, 70).occ(1).box(0, fy0, 0, len, fy0 + 0.16, WALK, 'xXYy');
        if (fascia === 0) { k.stucco(fcol, 70).box(0, fy0, WALK - 0.25, len, fy1, WALK, 'xXZYz'); }
        else { k.roofing(fascia === 1 ? 1 : 2, fcol, 100); k.quad([0, fy0, WALK + 0.35], [len, fy0, WALK + 0.35], [len, fy1 + 0.25, WALK - 0.55], [0, fy1 + 0.25, WALK - 0.55], [0, 0, len, 0, len, 1.75, 0, 1.75]); k.stucco(WHITE, 70); k.quad([len, fy0, WALK - 0.55], [0, fy0, WALK - 0.55], [0, fy1 + 0.25, WALK - 0.55], [len, fy1 + 0.25, WALK - 0.55]); k.tri3([0, fy0, WALK - 0.55], [0, fy0, WALK + 0.35], [0, fy1 + 0.25, WALK - 0.55]); k.tri3([len, fy0, WALK + 0.35], [len, fy0, WALK - 0.55], [len, fy1 + 0.25, WALK - 0.55]); k.stucco(WHITE, 70).box(0, fy0 - 0.02, WALK - 0.55, len, fy0, WALK + 0.35, 'Zy'); }
        k.stucco(WHITE, 70);
        for (let i = 0; i <= units; i++) { const x = clamp(i * uw, 0.2, len - 0.2); if (k.near) column(k, x, WALK - 0.2, 0.14, fy0, 0.13, { square: fascia !== 1, blocks: fascia === 1 }); else k.box(x - 0.13, 0.14, WALK - 0.33, x + 0.13, fy0, WALK - 0.07, 'xXZ'); }
      }
      for (let i = 0; i < units; i++) {
        const cat = SHOP_CATS[Math.floor(k.h(salt + 10 + i) * SHOP_CATS.length)], cx = (i + 0.5) * uw;
        if (fascia === 0) wallSign(k, cat, hashInts(lot.seed, 0x3c7 + salt, i), cx, (fy0 + fy1) / 2 + 0.05, { height: 0.7, maxWidth: uw - 1.2, lit: S.signLit, z: WALK + 0.02 });
        else k.at(cx, (fy0 + fy1) / 2 + 0.1, WALK - 0.08, 0, () => { if (!k.far) k.steel([0.9, 0.9, 0.88], 0.5, 30).occ(1).box(-Math.min(uw - 1.2, 3.6) / 2 - 0.06, -0.42, -0.1, Math.min(uw - 1.2, 3.6) / 2 + 0.06, 0.42, 0.12, 'xXYy'); wallSign(k, cat, hashInts(lot.seed, 0x3c7 + salt, i), 0, 0, { height: 0.72, maxWidth: Math.min(uw - 1.2, 3.6), lit: S.signLit, z: 0.125 }); });
        if (i % 2 === 0) k.lamp(cx, fy0, WALK * 0.5, [1, 0.9, 0.75], { power: 16, radius: 7, radiance: 9, glow: 0.35, size: 0.1 });
      }
      for (let i = 0; i <= units; i++) { const x = clamp(i * uw, 0.2, len - 0.2); k.collide(x - 0.15, 0, WALK - 0.35, x + 0.15, fy0, WALK - 0.05); }
    });
    return m;
  };
  const wingW = 11, mainX0 = variant === 1 && flip < 0 ? x0 + wingW : x0, mainX1 = variant === 1 && flip > 0 ? x1 - wingW : x1;
  let ax0 = mainX0, ax1 = mainX1, anchor = null;
  if (variant === 2) { const aw = clamp(W * 0.3, 13, 22); if (flip < 0) { anchor = [mainX0, mainX0 + aw]; ax0 = mainX0 + aw; } else { anchor = [mainX1 - aw, mainX1]; ax1 = mainX1 - aw; } }
  const main = range({ x0: ax0, z0: zb, x1: ax1, z1: zs }, 'front', Math.max(2, Math.round((ax1 - ax0) / 6.6)), 100);
  if (variant === 1) { const wx0 = flip < 0 ? x0 : x1 - wingW; range({ x0: wx0, z0: zb, x1: wx0 + wingW, z1: Math.min(D / 2 - 7, zs + 16) }, flip < 0 ? 'right' : 'left', Math.max(2, Math.round((Math.min(D / 2 - 7, zs + 16) - zb) / 6.6)), 200); }
  if (anchor) {
    // the anchor store: taller, a big glazed entrance bay and the largest sign on the lot
    const H = 7.2, runs = rectRuns(anchor[0], zb, anchor[1], zs + 2.2), aw = anchor[1] - anchor[0];
    mass(k, runs, 0, [{ h: H, spec: (r) => (r.cls === 'front' ? { style: F('SHOPFRONT', 'SHOWROOM'), bay: aw / 3, color: wall, seed, occ: [1, 0.8] } : r.cls === 'back' ? service : { style: F('BLANK', 'STUCCO', true), bay: 4, color: wall, seed }) }], { parapet: 1.0, color: wall, seed, coping: trim });
    k.onRun(runs.find((r) => r.cls === 'front'), (len) => { canopy(k, len / 2 - 4, len / 2 + 4, 3.4, 2.4, { th: 0.35, lip: trim, lamps: 2 }); doorway(k, len / 2, 0, 3.6, 2.4, { leaves: 4 }); wallSign(k, 'market', lot.seed >>> 4, len / 2, H - 1.1, { height: 1.5, maxWidth: len - 3, lit: S.signLit, far: true, neon: S.lit ? S.neon : null }); });
  }
  roofPlant(k, ax0 + 1, zb + 1, ax1 - 1, zs - 1, main.roofY, { core: false, units: 5, tank: false, aerial: false, color: shade(wall, 0.9) });
  // car park: two rows of bays, lamps, the pylon at the street
  const pz0 = zs + WALK + 1.2, pz1 = D / 2 - 1.5, px0 = variant === 1 && flip < 0 ? x0 + wingW + WALK + 1.5 : x0 + 1, px1 = variant === 1 && flip > 0 ? x1 - wingW - WALK - 1.5 : x1 - 1;
  bayLines(k, px0, px1, pz0, pz0 + 5, 2.7); if (pz1 - pz0 > 16) bayLines(k, px0, px1, pz1 - 5, pz1, 2.7);
  for (const f of [0.25, 0.75]) lotLamp(k, px0 + (px1 - px0) * f, (pz0 + pz1) / 2, {});
  k.at(flip < 0 ? x1 - 2.5 : x0 + 2.5, 0, D / 2 - 2.4, Math.PI / 2, () => pylonSign(k, 0, 0, { height: 8, category: anchor ? 'market' : 'shop', variant: lot.seed >>> 4, signHeight: 1.8, maxWidth: 4, neon: null }));
  return { S, variant };
}

// ------------------------------------------------------------------------------------------------ diner
/**
 * Diner. Variants: 0 stainless car with rounded ends, 1 drive-in: a kitchen box under a wide flat canopy for cars,
 * 2 a folded-roof coffee shop with a glass front and a stone pier.
 */
export function diner(k, lot) {
  const S = scheme(lot.seed ^ 0x42, 'resort', lot.style), W = lot.width, D = lot.depth, seed = S.seedByte, variant = (((lot.variant ?? Math.floor(k.h(1) * 3)) % 3) + 3) % 3, trim = S.trimC, neon = S.neon;
  const cx = 0, zf = D / 2 - 3.2;
  if (variant === 0) {
    const w = Math.min(W - 4, 19), d = 5.6, H = 3.3, x0 = cx - w / 2, z1 = zf, z0 = z1 - d, runs = rectRuns(x0, z0, x0 + w, z1, [d * 0.42, d * 0.42, d * 0.42, d * 0.42], k.arc), cream = [0.9, 0.88, 0.82];
    const win = { style: F('SHOPFRONT', 'CAFE'), bay: 2.4, color: cream, seed, occ: [1, 0.8] }, wrap = { style: F('SHOPFRONT', 'CAFE'), bays: 2, color: cream, seed };
    mass(k, runs, 0, [{ h: 0.45, storey: 1, spec: { style: F('BLANK', 'TILE'), bay: 4, color: [0.12, 0.12, 0.13], seed } }, { h: H - 0.45, storey: H - 0.45, grounded: false, spec: (r) => (r.cls === 'back' ? { style: F('BLANK', 'SHEET'), bay: 4, color: [0.74, 0.76, 0.78], seed } : r.curved ? wrap : win) }], { roof: [0.72, 0.74, 0.76], roofKind: 2 });
    // stainless bands above and below the windows, an enamel stripe between, a rounded roof edge with a neon line
    if (!k.far) { k.bare(0, 0.22).occ(1); k.ledge(runs, 0.45, 1.25, 0.04, { closed: true }); k.ledge(runs, H - 0.75, H, 0.04, { closed: true }); k.paint(trim, 0.3, 30); k.ledge(runs, 0.78, 0.95, 0.06, { closed: true }); k.ledge(runs, H - 0.5, H - 0.28, 0.06, { closed: true }); k.bare(0, 0.2); k.ledge(runs, H, H + 0.22, 0.28, { closed: true, bottom: true, inner: H }); }
    if (S.signLit) k.neon(runs.filter((r) => r.cls !== 'back' && r.cls !== 'bl' && r.cls !== 'br').sort((a, b) => ['left', 'fl', 'front', 'fr', 'right'].indexOf(a.cls) - ['left', 'fl', 'front', 'fr', 'right'].indexOf(b.cls)).flatMap((r) => r.pts.map((p, i) => [p[0] + r.nrm[i][0] * 0.33, H + 0.11, p[1] + r.nrm[i][1] * 0.33])), neon, { back: [0, 0, -1], radiance: 15, free: true });
    // kitchen annexe behind, vestibule in front
    mass(k, rectRuns(cx - w * 0.3, z0 - Math.min(5, z0 + D / 2 - 1.5), cx + w * 0.3, z0 + 0.5), 0, [{ h: 3.6, spec: (r) => (r.cls === 'back' ? { style: F('SHOPFRONT', 'SERVICE'), bay: 5, color: [0.8, 0.79, 0.75], seed } : { style: F('BLANK', 'STUCCO'), bay: 4, color: [0.8, 0.79, 0.75], seed }) }], { parapet: 0.4, color: [0.8, 0.79, 0.75], seed });
    k.at(cx, 0, z1, 0, () => { if (!k.far) { k.paint(cream, 0.3, 30).occ(1).box(-1.1, 0, 0, 1.1, 2.9, 1.3, 'xXZY'); k.bare(0, 0.25).box(-1.14, 2.9, 0, 1.14, 3.02, 1.34, 'xXZYy'); } doorway(k, 0, 0.0, 1.5, 2.15, {}); steps(k, -1.1, 1.1, 1.3, 0.16, { n: 1 }); });
    k.collide(cx - 1.1, 0, z1, cx + 1.1, 2.9, z1 + 1.3);
    roofSign(k, cx, H + 0.22, z1 - d / 2, { category: 'diner', variant: lot.seed >>> 3, height: 1.5, maxWidth: w * 0.6, leg: 0.5, neon: S.neonAccent, lit: S.signLit, far: true });
    roofPlant(k, x0 + 2, z0 + 1, x0 + w - 2, z1 - 3.4, H, { core: false, units: 2, tank: false, aerial: false });
  } else if (variant === 1) {
    const kw = Math.min(W * 0.45, 10), kd = 7, H = 3.4, z0 = -D / 2 + 2, runs = rectRuns(cx - kw / 2, z0, cx + kw / 2, z0 + kd), wall = S.wall;
    mass(k, runs, 0, [{ h: H, spec: (r) => (r.cls === 'back' ? { style: F('SHOPFRONT', 'SERVICE'), bay: 5, color: wall, seed } : { style: F('SHOPFRONT', 'CAFE', true), bay: 2.6, color: wall, seed, occ: [1, 0.5] }) }], { parapet: 0.5, color: wall, seed, coping: trim });
    // the canopy: a long thin roof on two rows of steel posts reaching the street, lamps and a neon line under its edge
    const cw = Math.min(W - 3, 24), cz1 = D / 2 - 2.5, cz0 = z0 + kd - 1, cy = 3.7;
    if (!k.far) { k.stucco(WHITE, 60).occ(1).box(cx - cw / 2, cy, cz0, cx + cw / 2, cy + 0.42, cz1, 'Yy'); k.stucco(trim, 60).box(cx - cw / 2, cy - 0.2, cz0, cx + cw / 2, cy + 0.42, cz1, 'xXzZ'); k.stucco(WHITE, 60).box(cx - cw / 2 + 0.01, cy - 0.2, cz0 + 0.01, cx - cw / 2 + 0.12, cy + 0.12, cz1 - 0.01, 'X').box(cx + cw / 2 - 0.12, cy - 0.2, cz0 + 0.01, cx + cw / 2 - 0.01, cy + 0.12, cz1 - 0.01, 'x').box(cx - cw / 2, cy - 0.2, cz1 - 0.12, cx + cw / 2, cy + 0.12, cz1 - 0.01, 'z');
      if (S.signLit) k.neon([[cx - cw / 2 - 0.035, cy + 0.1, cz0 + 0.3], [cx - cw / 2 - 0.035, cy + 0.1, cz1 + 0.035], [cx + cw / 2 + 0.035, cy + 0.1, cz1 + 0.035], [cx + cw / 2 + 0.035, cy + 0.1, cz0 + 0.3]], neon, { back: [0, 0, -1] }); }
    const nz = Math.max(2, Math.round((cz1 - cz0) / 5.5));
    for (const sx of [-1, 1]) for (let i = 0; i < nz; i++) { const px = cx + sx * (cw / 2 - 1.2), pz = cz0 + (cz1 - cz0) * (i + 0.7) / nz; if (!k.far) { k.steel(WHITE, 0.4, 30).cyl(px, 0, pz, 0.08, cy - 0.2, { cap: false, segs: k.near ? 8 : 4 }); k.lamp(px - sx * 2.2, cy, pz, [1, 0.92, 0.8], { power: 26, radius: 8, radiance: 10, glow: 0.45 }); } k.collide(px - 0.12, 0, pz - 0.12, px + 0.12, cy, pz + 0.12); }
    bayLines(k, cx - cw / 2 + 0.6, cx - kw / 2 - 0.4, cz0 + 2, cz0 + 7, 2.9); bayLines(k, cx + kw / 2 + 0.4, cx + cw / 2 - 0.6, cz0 + 2, cz0 + 7, 2.9);
    roofSign(k, cx, cy + 0.42, cz1 - 0.4, { category: 'diner', variant: lot.seed >>> 3, height: 1.4, maxWidth: cw * 0.5, leg: 0.3, neon: S.neonAccent, lit: S.signLit, far: true });
  } else {
    const w = Math.min(W - 4, 17), d = Math.min(D - 9, 11), x0 = cx - w / 2, z1 = zf, z0 = z1 - d, H0 = 3.0, wall = S.wall, runs = rectRuns(x0, z0, x0 + w, z1);
    const stonew = { style: F('BLANK', 'TILE'), bay: 4, color: [0.62, 0.52, 0.42], seed };
    mass(k, runs, 0, [{ h: H0, spec: (r) => (r.cls === 'front' ? { style: F('SHOPFRONT', 'SHOWROOM'), bay: 2.8, color: wall, seed, occ: [1, 1] } : r.cls === 'back' ? { style: F('SHOPFRONT', 'SERVICE'), bay: 5, color: wall, seed } : r.cls === 'left' ? stonew : { style: F('SHOPFRONT', 'CAFE'), bay: 2.8, color: wall, seed }) }], { roof: [0.8, 0.8, 0.78], roofKind: 3 });
    // folded roof: two planes rising to the street and sailing past the glass on steel legs
    const over = 2.2, yb = H0 + 0.25, yf = H0 + 2.3, mid = cx + (k.h(2) - 0.5) * 2;
    if (!k.far) { k.stucco(WHITE, 60);
      for (const [a, b, ya, yb2] of [[x0 - 0.8, mid, yf, yb + 0.5], [mid, x0 + w + 0.8, yb + 0.5, yf]]) { tiltSlab(k, a, z1 - 2.5, b, z1 + over, ya, yb2, 0.2); k.stucco(WHITE, 60); tiltSlab(k, a, z0 - 0.4, b, z1 - 2.5, ya, yb2, 0.2); }
      // glass gable under the folds
      k.glass([0.07, 0.1, 0.11], 0.05).occ(0.85); k.leaf([x0, H0, z1 + 0.01], [mid, H0, z1 + 0.01], [x0, yf - 0.45, z1 + 0.01]); k.leaf([mid, H0, z1 + 0.01], [x0 + w, H0, z1 + 0.01], [x0 + w, yf - 0.45, z1 + 0.01]);
      k.steel(trim, 0.4, 20); for (const sx of [x0 - 0.5, x0 + w + 0.5]) k.pipe([[sx, 0, z1 + over - 0.5], [sx, yf - 0.25, z1 + over - 0.9]], 0.06, k.near ? 6 : 3);
      if (S.signLit) k.neon([[x0 - 0.8, yf - 0.1, z1 + over + 0.035], [mid, yb + 0.4, z1 + over + 0.035], [x0 + w + 0.8, yf - 0.1, z1 + over + 0.035]], neon, { back: [0, 0, -1], radiance: 15 });
    }
    k.tile([0.62, 0.52, 0.42], 30, 0).occ(1).box(x0 - 0.5, 0, z1 - 1.5, x0, yf + 1.6, z1 + 1.0, 'xXzZY');   // the stone sign wall is the far silhouette too
    for (const sx of [x0 - 0.5, x0 + w + 0.5]) k.collide(sx - 0.12, 0, z1 + over - 0.65, sx + 0.12, 3, z1 + over - 0.35);
    k.collide(x0 - 0.5, 0, z1 - 1.5, x0, yf + 1.6, z1 + 1.0);
    k.at(x0 - 0.52, 0, z1 - 0.25, -Math.PI / 2, () => wallSign(k, 'diner', lot.seed >>> 3, 0, yf + 0.7, { height: 1.2, maxWidth: 2.3, lit: S.signLit, far: true }));
    k.at(cx + w * 0.2, 0, z1, 0, () => doorway(k, 0, 0, 1.7, 2.2, {}));
    k.at(cx, 0, z1, 0, () => wallSign(k, 'diner', lot.seed >>> 3, -w * 0.15, H0 + 0.55, { height: 0.6, maxWidth: w * 0.4, lit: S.signLit, z: 0.04 }));
  }
  // every diner has a tall roadside sign and a few bays out front or beside
  k.at(W / 2 - 2.2, 0, D / 2 - 1.3, Math.PI / 2, () => pylonSign(k, 0, 0, { height: 7.5, category: 'diner', variant: lot.seed >>> 3, signHeight: 1.6, maxWidth: 2.4, neon: S.lit ? neon : null, posts: 1, color: mixColor(trim, WHITE, 0.2) }));
  if (variant !== 1) bayLines(k, -W / 2 + 1.2, W / 2 - 4, D / 2 - 2.9, D / 2 - 0.3, 2.7);
  return { S, variant };
}

// ------------------------------------------------------------------------------------------------ shop row
/**
 * Party-wall shops of the mainland streets. Variants: 0 one storey, each shop with its own parapet, awning and
 * hand-painted sign; 1 rooms above the shops behind a balcony; 2 walk-up flats over shops with galleries;
 * 3 one wide glass-fronted business (laundry, market) with a painted side wall.
 */
export function shopRow(k, lot) {
  const poor = lot.style === 'residential_poor', S = scheme(lot.seed ^ 0x2b, poor ? 'poor' : 'latin', lot.style), W = lot.width, D = lot.depth, att = lot.attached ?? {}, seed = S.seedByte, floors = clamp(lot.floors | 0, 1, 4);
  let variant = lot.variant ?? (floors === 1 ? (k.h(1) < 0.75 ? 0 : 3) : floors === 2 ? 1 : 2); variant = ((variant % 4) + 4) % 4;
  const x0 = -W / 2 + (att.left ? 0 : 0.1), x1 = W / 2 - (att.right ? 0 : 0.1), zf = D / 2 - 1.0, zb = -D / 2 + (att.back ? 0 : 2.5), G = 3.8, FL = 3.0, trim = S.trimC, wall = S.wall;
  const units = Math.max(1, Math.round((x1 - x0) / 5.6)), uw = (x1 - x0) / units, paintCat = poor ? 'shop-haiti' : 'shop-latin';
  const party = { style: F('BLANK', 'STUCCO'), bay: 4, color: shade(wall, 0.94), seed }, service = { style: F('SHOPFRONT', 'SERVICE'), bay: 5, color: shade(wall, 0.92), seed };
  // each unit has its own paint: the row is a strip of separate owners
  const unitCol = (i) => (units === 1 ? wall : scheme(lot.seed + i * 977, poor ? 'poor' : 'latin').wall), unitTrim = (i) => scheme(lot.seed + i * 977, poor ? 'poor' : 'latin').trimC;
  const signs = (y, z) => { for (let i = 0; i < units; i++) k.at(x0 + (i + 0.5) * uw, 0, zf, 0, () => { const painted = k.h(40 + i) < 0.7; wallSign(k, painted ? paintCat : SHOP_CATS[Math.floor(k.h(50 + i) * SHOP_CATS.length)], hashInts(lot.seed, 0x5a1, i), 0, y, { height: painted ? 0.85 : 0.6, maxWidth: uw - 0.9, lit: !painted, z, wallColor: unitCol(i) }); }); };
  const fronts = (yAwn) => { for (let i = 0; i < units; i++) { const a = x0 + i * uw; if (k.h(60 + i) < 0.55) k.at(a, 0, zf, 0, () => awning(k, 0.4, uw - 0.4, yAwn, { proj: 1.3, drop: 0.6, color: k.h(70 + i) < 0.5 ? unitTrim(i) : S.awning, pattern: k.h(80 + i) < 0.4 ? 1 : 0 })); else if (!k.far && k.h(60 + i) < 0.8) k.at(a, 0, zf, 0, () => k.stucco(shade(unitCol(i), 0.97), 80).occ(1).box(0.2, yAwn - 0.1, 0, uw - 0.2, yAwn + 0.06, 1.1, 'xXZYy')); } };
  let body;
  if (variant === 0) {
    const runs = rectRuns(x0, zb, x1, zf);
    body = mass(k, runs, 0, [{ h: G, spec: bySide({ back: service, front: null, default: { style: F('BLANK', 'STUCCO'), bay: 4, color: wall, seed } }, att, party) }], { parapet: 0.5, color: wall, seed, skipParapet: ['front'] });
    for (let i = 0; i < units; i++) {
      const a = x0 + i * uw, b = a + uw, col = unitCol(i), hgt = 0.5 + k.h(10 + i) * 1.3, kind = Math.floor(k.h(20 + i) * 4), st = k.h(30 + i);
      const spec = { style: F('SHOPFRONT', st < 0.5 ? 'RETAIL' : st < 0.75 ? 'SHUTTERED' : 'CAFE', k.h(35 + i) < 0.25), bays: 1, color: col, seed: scheme(lot.seed + i * 977, 'latin').seedByte, occ: [1, 0.85] };
      k.walls([lineRun(a, zf, b, zf)], 0, [{ h: G, spec }]);
      const pr = rectRuns(a, zf - 0.4, b, zf), ps = { style: F('BLANK', 'STUCCO', kind === 1), bay: 4, color: col, seed: spec.seed };
      mass(k, pr, G, [{ h: hgt, storey: Math.max(1, hgt), grounded: false, spec: ps }], { roof: shade(col, 0.7), roofKind: 3, collide: false });
      if (kind >= 2 && !k.far) mass(k, rectRuns(a + uw * 0.22, zf - 0.4, b - uw * 0.22, zf + 0.02), G + hgt, [{ h: 0.55, storey: 1, grounded: false, spec: ps }], { roof: shade(col, 0.7), roofKind: 3, collide: false });
      if (!k.far) k.stucco(k.h(36 + i) < 0.5 ? unitTrim(i) : shade(col, 1.05), 80).occ(1).box(a + 0.02, G + hgt, zf - 0.42, b - 0.02, G + hgt + 0.08, zf + 0.04, 'xXzZYy');
    }
    fronts(3.0); signs(3.45, 0.03);
  } else if (variant === 3) {
    const runs = rectRuns(x0, zb, x1, zf), H = 4.6, open = !att.left ? 'left' : !att.right ? 'right' : null;
    body = mass(k, runs, 0, [{ h: H, spec: bySide({ front: { style: F('SHOPFRONT', 'SHOWROOM'), bay: 3.2, color: wall, seed, occ: [1, 0.8] }, back: service, default: { style: F('BLANK', open && k.h(2) < 0.7 ? 'MURAL' : 'STUCCO'), bay: 60, color: wall, seed } }, att, party) }], { parapet: 0.9, color: wall, seed, coping: trim });
    k.onRun(runs.find((r) => r.cls === 'front'), (len) => { if (!k.far) k.stucco(trim, 70).occ(1).box(-0.05, 3.3, 0, len + 0.05, 4.5, 0.35, 'xXZYy'); wallSign(k, k.h(3) < 0.5 ? paintCat : 'market', lot.seed >>> 3, len / 2, 3.9, { height: 0.9, maxWidth: len - 1.5, lit: S.signLit, z: 0.37, wallColor: trim }); doorway(k, len / 2, 0, 1.9, 2.2, {}); for (let i = 0; i < Math.max(1, Math.round(len / 5)); i++) k.lamp((i + 0.5) * len / Math.max(1, Math.round(len / 5)), 3.3, 0.2, [0.95, 0.97, 1], { power: 16, radius: 6, radiance: 9, glow: 0.3, size: 0.09 }); });
  } else {
    const upN = variant === 1 ? 1 : Math.max(2, floors - 1), runs = rectRuns(x0, zb, x1, zf), upSpec = { style: F('LOWRISE', variant === 1 ? (k.h(2) < 0.5 ? 'SHUTTERS' : 'GRILLE') : 'GALLERY', k.h(3) < 0.4), bay: variant === 1 ? 2.8 : 3.6, color: wall, seed };
    body = mass(k, runs, 0, [{ h: G, spec: bySide({ front: { style: F('SHOPFRONT', 'RETAIL', k.h(4) < 0.25), bays: units, color: wall, seed, occ: [1, 0.6] }, back: service, default: { style: F('BLANK', 'STUCCO'), bay: 4, color: wall, seed } }, att, party) }, { h: upN * FL, storey: FL, spec: bySide({ front: upSpec, back: { style: F('LOWRISE', 'GRILLE'), bay: 3.4, color: shade(wall, 0.95), seed }, default: { style: F('LOWRISE', 'SHUTTERS'), bay: 4.2, color: wall, seed } }, att, party) }], { parapet: 0.7, color: wall, seed, coping: k.h(5) < 0.5 ? trim : WHITE });
    k.onRun(runs.find((r) => r.cls === 'front'), (len) => {
      for (let f = 0; f < upN; f++) { const y = G + f * FL; if (variant === 2 || f === 0) balcony(k, 0.05, len - 0.05, y, variant === 1 ? 1.2 : 1.35, { guard: k.h(6) < 0.35 ? 'solid' : 'rail', color: WHITE, rail: k.h(7) < 0.6 ? DARK : trim, guardColor: mixColor(wall, WHITE, 0.3), post: 1.4, rails: [0.75, 0.5, 0.25, 0.08] }); }
      if (variant === 2 && !k.far) { const n = Math.max(1, Math.round(len / 3.6)); k.steel(WHITE, 0.5, 40).occ(1); for (let i = 0; i <= n; i++) { const x = clamp(i * len / n, 0.1, len - 0.1); k.box(x - 0.05, G, 1.2, x + 0.05, G + upN * FL, 1.3, 'xXzZ'); } k.stucco(WHITE, 80).box(0, G + upN * FL - 0.02, 0, len, G + upN * FL + 0.12, 1.5, 'xXZYy'); }
    });
    fronts(3.05); signs(3.42, 0.03);
    windowUnits(k, body.info[1], ['front', 'back', 'left', 'right'], 0.35, 1.0);
    if (k.h(8) < 0.3) k.onRun(runs.find((r) => r.cls === 'front'), (len) => bladeSign(k, len - 0.8, G + 1.3, G + upN * FL + 0.5, variant === 1 ? 1.2 : 1.35, { category: 'hotel-blade', variant: lot.seed >>> 5, neon: S.lit ? S.neon : null, lit: S.signLit, proj: 0.9, gap: 0.02, color: mixColor(trim, [0.1, 0.1, 0.12], 0.5) }));
  }
  roofPlant(k, x0 + 0.5, zb + 0.5, x1 - 0.5, zf - 1, body.roofY, { core: variant === 2, units: Math.max(2, units), tank: variant === 2 && k.h(9) < 0.5, color: shade(wall, 0.9) });
  return { S, variant, body };
}

// ------------------------------------------------------------------------------------------------ houses
/**
 * Small house on a lawn. Variants: 0 stucco bungalow under a hipped tile or shingle roof with a porch, 1 wood-frame
 * house on piers with a tin gable roof and a full-width porch, 2 flat-roofed concrete-block house with a carport.
 */
export function bungalow(k, lot) {
  const poor = lot.style === 'residential_poor', S = scheme(lot.seed ^ 0x61, poor ? 'poor' : 'latin', lot.style), W = lot.width, D = lot.depth, seed = S.seedByte, trim = S.trimC, wall = S.wall;
  const variant = (((lot.variant ?? (poor ? (k.h(1) < 0.55 ? 1 : k.h(1) < 0.8 ? 2 : 0) : (k.h(1) < 0.55 ? 0 : k.h(1) < 0.8 ? 2 : 1))) % 3) + 3) % 3;
  // a shallow lot gives up front garden before it gives up house; the carport variant needs a lot wide enough for both
  const cw = 3.4, flip = k.h(2) < 0.5 ? -1 : 1, wide = clamp(W - 4.5, 6.5, 11), port = variant === 2 && Math.min(wide, W - cw - 2.0) >= 5.5, hw = port ? Math.min(wide, W - cw - 2.0) : wide;
  const front = clamp(D - 9.6, 2.4, 5.2), hd = clamp(D - front - 2.6, 7, 12), cx = port ? flip * (W / 2 - 1.0 - hw / 2) : flip * (W - hw - 3.2) / 2 * 0.7, z1 = D / 2 - front, z0 = z1 - hd, x0 = cx - hw / 2, x1 = cx + hw / 2;
  const driveX = flip < 0 ? W / 2 - 3.2 : -W / 2 + 0.4;
  if (variant === 0) {
    const H = 2.9, runs = rectRuns(x0, z0, x1, z1), win = { style: F('LOWRISE', k.h(3) < 0.5 ? 'SHUTTERS' : 'GRILLE', k.h(4) < 0.3), bay: 3.1, color: wall, seed };
    mass(k, runs, 0, [{ h: H, spec: win }], { roof: null });
    const tile = k.h(5) < 0.6; pitchedRoof(k, x0, z0, x1, z1, H, { pitch: tile ? 0.42 : 0.36, over: 0.55, kind: tile ? 1 : 4, color: tile ? ROOF_TILE[Math.floor(k.h(6) * 3)] : [0.42, 0.4, 0.38] });
    // porch: a small projecting roof on two posts over a raised step
    const pw = 3.2, px = cx - flip * hw * 0.15;
    k.at(px, 0, z1, 0, () => { if (!k.far) { k.concrete(PAVE, 0, 80).occ(1).box(-pw / 2, 0, 0, pw / 2, 0.3, 1.9, 'xXZY'); k.stucco(WHITE, 70).box(-pw / 2 - 0.2, 2.45, 0, pw / 2 + 0.2, 2.62, 2.1, 'xXZYy'); for (const s of [-1, 1]) column(k, s * (pw / 2 - 0.15), 1.75, 0.3, 2.45, 0.09, { square: true, blocks: false }); } doorway(k, 0, 0.3, 0.95, 2.05, { metal: false, frame: trim }); steps(k, -0.8, 0.8, 1.9, 0.3, { n: 1 }); k.lamp(0, 2.45, 1.0, [1, 0.85, 0.6], { power: 10, radius: 5, radiance: 7, glow: 0.3, size: 0.08 }); });
    for (const s of [-1, 1]) k.collide(px + s * (pw / 2 - 0.15) - 0.1, 0, z1 + 1.65, px + s * (pw / 2 - 0.15) + 0.1, 2.45, z1 + 1.85);
    windowUnits(k, { y0: 0, y1: H, storey: H, runs: runs.map((r) => ({ run: r, n: Math.max(1, Math.round(r.len / 3.1)), bay: r.len / Math.max(1, Math.round(r.len / 3.1)) })) }, ['left', 'right', 'back'], 0.4, 1.0);
  } else if (variant === 1) {
    const base = 0.7, H = 2.8, runs = rectRuns(x0, z0, x1, z1 - 1.9), col = poor && k.h(3) < 0.5 ? shade(wall, 0.92) : wall;
    // piers under the floor, clapboard above, the porch across the whole front under the main roof
    if (!k.far) { k.concrete([0.6, 0.59, 0.56], 4, 110).occ(0.8); for (const px of [x0 + 0.2, cx, x1 - 0.2]) for (const pz of [z0 + 0.2, (z0 + z1) / 2, z1 - 0.2]) k.box(px - 0.2, 0, pz - 0.2, px + 0.2, base, pz + 0.2, 'xXzZ'); k.glass([0.01, 0.01, 0.01], 0.9).occ(0.4).box(x0 + 0.25, 0, z0 + 0.25, x1 - 0.25, base - 0.05, z1 - 0.25, 'xXzZ'); }
    mass(k, runs, base, [{ h: H, storey: H, grounded: false, spec: { style: F('LOWRISE', 'CLAPBOARD'), bay: 2.7, color: col, seed } }], { roof: null, collide: false });
    k.collide(x0, 0, z0, x1, base + H, z1);
    if (!k.far) { k.paint(shade(col, 0.8), 0.7, 120).occ(1).box(x0, base - 0.14, z0, x1, base, z1, 'xXzZ'); k.paint([0.55, 0.5, 0.44], 0.7, 140).box(x0, base - 0.02, z1 - 1.9, x1, base, z1, 'Y');
      for (let i = 0; i <= 3; i++) { const px = x0 + 0.1 + (hw - 0.2) * i / 3; k.paint(WHITE, 0.6, 90).box(px - 0.06, base, z1 - 0.16, px + 0.06, base + H, z1 - 0.04, 'xXzZ'); }
      railing(k, [[x0 + 0.1, base, z1 - 0.1], [cx - 0.7, base, z1 - 0.1]], 0.85, { color: WHITE, rails: [0.1, 0.4, 0.7], post: 0.5 }); railing(k, [[cx + 0.7, base, z1 - 0.1], [x1 - 0.1, base, z1 - 0.1]], 0.85, { color: WHITE, rails: [0.1, 0.4, 0.7], post: 0.5 }); }
    pitchedRoof(k, x0, z0, x1, z1, base + H, { pitch: 0.5, over: 0.45, kind: 2, color: k.h(5) < 0.5 ? [0.62, 0.64, 0.64] : [0.5, 0.3, 0.24], gable: true, gableSpec: { style: F('LOWRISE', 'CLAPBOARD'), bay: 60, color: col, seed, storey: 9 }, wear: 170 });
    k.at(cx, 0, z1, 0, () => { steps(k, -0.7, 0.7, 0, base, { n: 3, tread: 0.28, color: [0.6, 0.58, 0.54] }); });
    k.at(cx, base, z1 - 1.9, 0, () => doorway(k, 0, 0, 0.9, 2.0, { metal: false, frame: trim }));
    k.lamp(cx, base + H - 0.05, z1 - 1.0, [1, 0.85, 0.6], { power: 10, radius: 5, radiance: 7, glow: 0.3, size: 0.08 });
  } else {
    const H = 2.75, runs = rectRuns(x0, z0, x1, z1), col = wall;
    mass(k, runs, 0, [{ h: H, spec: { style: F('LOWRISE', 'BLOCK', k.h(3) < 0.5), bay: 2.9, color: col, seed } }], { parapet: 0.25, color: col, seed, coping: WHITE });
    if (!k.far) k.stucco(WHITE, 80).occ(1).ledge(runs, H - 0.02, H + 0.2, 0.55, { closed: true, lip: k.h(4) < 0.5 ? trim : WHITE, bottom: true });
    // carport: the roof slab carries on over the drive on two steel posts
    const c0 = flip < 0 ? x1 : x0 - cw, c1 = c0 + cw;
    if (port && !k.far) { k.stucco(WHITE, 80).occ(1).box(c0, H - 0.02, z1 - 5.5, c1, H + 0.16, z1 + 0.4, 'xXzZYy'); k.steel(WHITE, 0.5, 60); for (const pz of [z1 - 5.2, z1 + 0.1]) k.box((flip < 0 ? c1 : c0) - 0.05 + (flip < 0 ? -0.2 : 0.2), 0, pz - 0.05, (flip < 0 ? c1 : c0) + 0.05 + (flip < 0 ? -0.2 : 0.2), H, pz + 0.05, 'xXzZ'); }
    if (port) for (const pz of [z1 - 5.2, z1 + 0.1]) { const px = (flip < 0 ? c1 - 0.2 : c0 + 0.2); k.collide(px - 0.08, 0, pz - 0.08, px + 0.08, H, pz + 0.08); }
    k.at(cx, 0, z1, 0, () => { doorway(k, 0, 0.1, 0.9, 2.0, { metal: false, frame: trim }); if (!k.far) k.concrete(PAVE, 0, 80).occ(1).box(-0.8, 0, 0, 0.8, 0.1, 1.0, 'xXZY'); k.lamp(0.75, 2.2, 0.12, [1, 0.85, 0.6], { power: 8, radius: 4.5, radiance: 7, glow: 0.25, size: 0.07 }); });
    windowUnits(k, { y0: 0, y1: H, storey: H, runs: runs.map((r) => ({ run: r, n: Math.max(1, Math.round(r.len / 2.9)), bay: r.len / Math.max(1, Math.round(r.len / 2.9)) })) }, ['left', 'right', 'back', 'front'], 0.45, 1.0);
    aerial(k, cx + 1, H + 0.25, z0 + 1.5, 2.6);
  }
  // drive, path and a front fence: chain-link or low block in the poor streets, a low wall or nothing elsewhere
  pad(k, driveX, D / 2 - 9, driveX + 2.8, D / 2 - 0.2, [0.66, 0.65, 0.62], { joint: 30 });
  pad(k, cx - 0.5 - (variant === 0 ? flip * hw * 0.15 : 0), z1 + (variant === 0 ? 2.2 : variant === 1 ? 0.9 : 1.0), cx + 0.5 - (variant === 0 ? flip * hw * 0.15 : 0), D / 2 - 0.2, PAVE, { joint: 10 });
  if (k.h(9) < (poor ? 0.75 : 0.4)) { const fz = D / 2 - 0.5, gx = cx - (variant === 0 ? flip * hw * 0.15 : 0), a = -W / 2 + 0.3, b = W / 2 - 0.3, st = poor && k.h(10) < 0.6 ? 'rail' : 'block', o = { h: st === 'rail' ? 1.2 : 0.8, t: 0.15, color: st === 'rail' ? [0.7, 0.69, 0.66] : mixColor(wall, WHITE, 0.4), style: st, rail: [0.62, 0.64, 0.66] };
    const cuts = [[driveX - 0.1, driveX + 2.9], [gx - 0.7, gx + 0.7]].sort((p, q) => p[0] - q[0]); let x = a; for (const [c0, c1] of cuts) { if (c0 - x > 0.6) yardWall(k, [[x, fz], [c0, fz]], o); x = Math.max(x, c1); } if (b - x > 0.6) yardWall(k, [[x, fz], [b, fz]], o); }
  return { S, variant };
}

/**
 * Villa. Variants: 0 Mediterranean two-storey house with arched windows, a tile roof and a garage wing; 1 white
 * modern house: flat roofs at two heights, a long window wall, a floating entrance slab; 2 an L-shaped ranch house
 * under low hipped roofs with a carport. A pool sits behind when the lot is deep enough.
 */
export function villa(k, lot) {
  const S = scheme(lot.seed ^ 0x72, 'mansion', lot.style), W = lot.width, D = lot.depth, seed = S.seedByte, wall = S.wall, floors = clamp(lot.floors | 0, 1, 2);
  const variant = (((lot.variant ?? Math.floor(k.h(1) * 3)) % 3) + 3) % 3, flip = k.h(2) < 0.5 ? -1 : 1, FL = 3.1, z1 = D / 2 - 6.5, tile = ROOF_TILE[Math.floor(k.h(3) * 3)];
  const hw = clamp(W - 6, 10, 20), hd = clamp(D - 15, 8, 12), x0 = -hw / 2, x1 = hw / 2, z0 = z1 - hd, mx = (a, b) => (flip < 0 ? [-b, -a] : [a, b]);
  let doorX = 0, doorZ = z1;
  if (variant === 0) {
    const H = floors * FL, gw = clamp(hw * 0.36, 3.6, 6.2), [ma, mb] = mx(x0 + gw, x1), [ga, gb] = mx(x0, x0 + gw);
    const arch = { style: F('MANSION', 'ARCHED', true), bay: 2.9, color: wall, seed }, plain = { style: F('MANSION', 'SHUTTERS'), bay: 3.3, color: wall, seed };
    mass(k, rectRuns(ma, z0, mb, z1), 0, [{ h: H, storey: FL, spec: (r) => (r.cls === 'front' ? arch : plain) }], { roof: null });
    pitchedRoof(k, ma, z0, mb, z1, H, { pitch: 0.4, over: 0.5, kind: 1, color: tile });
    // garage wing: lower, set back, its door a panelled roller
    mass(k, rectRuns(ga, z0 + 1, gb, z1 - 1.6), 0, [{ h: 2.9, spec: (r) => (r.cls === 'front' ? { style: F('WAREHOUSE', 'DOORS'), bay: gw, color: wall, seed } : { style: F('BLANK', 'STUCCO'), bay: 4, color: wall, seed }) }], { roof: null });
    pitchedRoof(k, ga, z0 + 1, gb, z1 - 1.6, 2.9, { pitch: 0.4, over: 0.4, kind: 1, color: tile });
    doorX = (ma + mb) / 2;
    k.at(doorX, 0, z1, 0, () => { if (!k.far) { k.stucco(shade(wall, 1.03), 60).occ(1).box(-1.5, 0, 0, 1.5, 3.3, 0.5, 'xXZY'); k.roofing(1, tile).box(-1.7, 3.3, 0, 1.7, 3.42, 0.7, 'xXZY'); k.glass([0.02, 0.02, 0.02], 0.5).occ(0.5).box(-0.75, 0, 0.5, 0.75, 2.5, 0.51, 'Z'); } k.at(0, 0, 0.42, 0, () => doorway(k, 0, 0.15, 1.3, 2.2, { metal: false, frame: [0.3, 0.2, 0.12], glass: [0.12, 0.07, 0.04] })); steps(k, -1.1, 1.1, 0.5, 0.15, { n: 1 }); k.lamp(0, 3.0, 0.62, [1, 0.82, 0.55], { power: 12, radius: 5, radiance: 8, glow: 0.3, size: 0.09 }); });
    pad(k, ga + 0.4, z1 - 1.6, gb - 0.4, D / 2 - 0.2, [0.72, 0.66, 0.58], { tile: 30, pattern: 3 });
  } else if (variant === 1) {
    const [la, lb] = mx(x0, x0 + hw * 0.55), [ta, tb] = mx(x0 + hw * 0.45, x1), white = [0.94, 0.94, 0.92];
    const glassy = { style: F('MANSION', 'MODERN'), bay: 3.2, color: white, seed }, blank = { style: F('BLANK', 'STUCCO'), bay: 4, color: white, seed };
    const low = mass(k, rectRuns(la, z0, lb, z1 - 1.5), 0, [{ h: 3.2, spec: (r) => (r.cls === 'front' || r.cls === 'back' ? glassy : blank) }], { parapet: 0.3, color: white, seed, coping: white, roofKind: 3, roof: [0.85, 0.85, 0.83] });
    const tall = mass(k, rectRuns(ta, z0 + 1, tb, z1), 0, [{ h: floors === 2 ? 6.2 : 4.2, storey: 3.1, spec: (r) => (r.cls === 'front' ? { style: F('BLANK', 'STUCCO'), bay: 4, color: white, seed } : r.cls === 'back' ? glassy : blank) }], { parapet: 0.3, color: white, seed, coping: white, roofKind: 3, roof: [0.85, 0.85, 0.83] });
    if (!k.far) { k.stucco(white, 50).occ(1).ledge(low.runs, 3.2, 3.5, 0.9, { closed: true, bottom: true, inner: 3.2 }); k.glass([0.06, 0.09, 0.1], 0.05).occ(0.9).box(ta + 0.8, 1.0, z1, ta + 1.5, tall.roofY - 0.8, z1 + 0.02, 'Z'); }
    doorX = flip < 0 ? la + 1.5 : lb - 1.5; doorZ = z1 - 1.5;
    k.at(doorX, 0, doorZ, 0, () => { doorway(k, 0, 0.1, 1.4, 2.3, {}); if (!k.far) { k.stucco(white, 50).occ(1).box(-2.2, 2.7, 0, 2.2, 2.85, 3.0, 'xXZYy'); k.steel(DARK, 0.4, 10).cyl(1.9, 0, 2.7, 0.04, 2.7, { cap: false, segs: 6 }); } k.lamp(0, 2.7, 1.2, [1, 0.9, 0.75], { power: 12, radius: 5, radiance: 8, glow: 0.3, size: 0.08 }); });
    pad(k, Math.min(ta, tb) + 0.5, z1, Math.max(ta, tb) - 0.5, D / 2 - 0.2, [0.78, 0.77, 0.74], { joint: 20 });
  } else {
    const H = 2.8, [la, lb] = mx(x0, x1), [wa, wb] = mx(x1 - 6.5, x1), col = wall, win = { style: F('LOWRISE', 'SHUTTERS'), bay: 3.3, color: col, seed }, shingle = [0.36, 0.33, 0.3];
    mass(k, rectRuns(la, z0, lb, z0 + 7), 0, [{ h: H, spec: win }], { roof: null }); pitchedRoof(k, la, z0, lb, z0 + 7, H, { pitch: 0.3, over: 0.7, kind: k.h(4) < 0.5 ? 4 : 1, color: k.h(4) < 0.5 ? shingle : tile });
    mass(k, rectRuns(wa, z0 + 7, wb, z1), 0, [{ h: H, spec: win }], { roof: null }); pitchedRoof(k, wa, z0 + 6, wb, z1, H, { pitch: 0.3, over: 0.7, kind: k.h(4) < 0.5 ? 4 : 1, color: k.h(4) < 0.5 ? shingle : tile });
    const [ca, cb] = mx(x0, x0 + 5.4);
    if (!k.far) { k.stucco(WHITE, 80).occ(1).box(ca, H - 0.05, z0 + 7, cb, H + 0.14, z0 + 12.5, 'xXzZYy'); k.steel(WHITE, 0.5, 40); for (const px of [ca + 0.2, cb - 0.2]) k.box(px - 0.05, 0, z0 + 12.2, px + 0.05, H - 0.05, z0 + 12.3, 'xXzZ'); }
    for (const px of [ca + 0.2, cb - 0.2]) k.collide(px - 0.08, 0, z0 + 12.15, px + 0.08, H, z0 + 12.35);
    doorX = flip < 0 ? wb + 1.2 : wa - 1.2; doorZ = z0 + 7;
    k.at(doorX, 0, doorZ, 0, () => { doorway(k, 0, 0.08, 0.95, 2.05, { metal: false, frame: S.trim2C }); k.lamp(0.8, 2.2, 0.12, [1, 0.85, 0.6], { power: 9, radius: 5, radiance: 7, glow: 0.25, size: 0.07 }); });
    pad(k, ca + 0.3, z0 + 12.5, cb - 0.3, D / 2 - 0.2, [0.68, 0.67, 0.64], { joint: 30 });
  }
  pad(k, doorX - 0.6, doorZ + 0.6, doorX + 0.6, D / 2 - 0.2, [0.76, 0.72, 0.64], { tile: 30, pattern: 3 });
  const yard = z0 - (-D / 2 + 1.2);
  if (yard >= 7.5) { const pw = clamp(hw * 0.6, 7, 11); pool(k, -pw / 2 - flip * 1.5, -D / 2 + 1.6, pw / 2 - flip * 1.5, z0 - 1.0, { rim: 1.1, r: variant === 1 ? 0 : 1.4 }); }
  // a coconut palm or two in the front garden, clear of the drive, and one by the pool
  for (const s of [-1, 1]) { const px = s * (W / 2 - 2.2); if (Math.abs(px - doorX) > 3) k.plant('coconut', px, D / 2 - 2.4, { scale: 0.8 + k.h(76 + s) * 0.3 }); }
  k.plant('small', flip * (hw * 0.5 + 1.5), -D / 2 + 1.6, { scale: 0.9 });
  // low street wall with a gate gap opposite the door and the drive left open
  if (k.h(8) < 0.7) { const fz = D / 2 - 0.45, o = { h: 1.0, t: 0.22, color: mixColor(wall, WHITE, 0.3), piers: 3.2, coping: WHITE }; const g0 = doorX - 0.9, g1 = doorX + 0.9, dr = variant === 0 ? mx(x0, x0 + clamp(hw * 0.36, 3.6, 6.2)) : variant === 1 ? mx(x0 + hw * 0.45, x1) : mx(x0, x0 + 5.4);
    const cuts = [[g0, g1], [Math.min(...dr), Math.max(...dr)]].sort((p, q) => p[0] - q[0]); let x = -W / 2 + 0.3; for (const [c0, c1] of cuts) { if (c0 - x > 0.8) yardWall(k, [[x, fz], [c0, fz]], o); x = Math.max(x, c1); } if (W / 2 - 0.3 - x > 0.8) yardWall(k, [[x, fz], [W / 2 - 0.3, fz]], o); }
  return { S, variant };
}

/**
 * Mansion in walled grounds. Variants: 0 Mediterranean revival: a centre block with a loggia between two wings and
 * a stair turret, under tile roofs; 1 white modern: stacked flat-roofed boxes with long terraces; 2 a classical
 * house with a two-storey portico and pediment. All have a gate with lamp piers, a paved forecourt and a pool.
 */
export function mansion(k, lot) {
  const S = scheme(lot.seed ^ 0x8e, 'mansion', lot.style), W = lot.width, D = lot.depth, seed = S.seedByte, floors = clamp(lot.floors | 0, 2, 3), FL = 3.4;
  const variant = (((lot.variant ?? Math.floor(k.h(1) * 3)) % 3) + 3) % 3, wall = lot.wallColor ?? (variant === 1 ? [0.95, 0.95, 0.93] : variant === 2 ? [0.95, 0.94, 0.9] : S.wall), tile = ROOF_TILE[Math.floor(k.h(2) * 3)];
  const hw = clamp(W - 14, 20, 46), hd = clamp(D * 0.3, 11, 17), z1 = D / 2 - clamp(D * 0.3, 11, 18), z0 = z1 - hd, x0 = -hw / 2, x1 = hw / 2, H = floors * FL;
  const arch = { style: F('MANSION', 'ARCHED', true), bay: 3.0, color: wall, seed }, shut = { style: F('MANSION', 'SHUTTERS', true), bay: 3.2, color: wall, seed };
  if (variant === 0) {
    const ww = clamp(hw * 0.26, 6, 10), cz1 = z1 - 2.6;
    mass(k, rectRuns(x0 + ww, z0, x1 - ww, cz1), 0, [{ h: H, storey: FL, spec: arch }], { roof: null }); pitchedRoof(k, x0 + ww - 0.4, z0, x1 - ww + 0.4, cz1, H, { pitch: 0.38, over: 0.6, kind: 1, color: tile });
    for (const s of [-1, 1]) { const a = s < 0 ? x0 : x1 - ww, wh = H - (floors > 2 ? FL : 0); mass(k, rectRuns(a, z0 + 1, a + ww, z1), 0, [{ h: wh, storey: FL, spec: (r) => (r.cls === 'front' ? arch : shut) }], { roof: null }); pitchedRoof(k, a, z0 + 1, a + ww, z1, wh, { pitch: 0.38, over: 0.6, kind: 1, color: tile }); }
    // loggia between the wings: arches on columns under a terrace
    const la = x0 + ww, lb = x1 - ww, n = Math.max(3, Math.round((lb - la) / 3.2));
    if (!k.far) { k.stucco(wall, 60).occ(1).box(la, 3.25, cz1, lb, 3.7, z1 - 0.2, 'ZYy'); k.tile([0.72, 0.5, 0.4], 30, 0).box(la, 0, cz1, lb, 0.18, z1 - 0.2, 'ZY'); for (let i = 0; i <= n; i++) column(k, la + (lb - la) * i / n, z1 - 0.5, 0.18, 3.25, 0.17, { color: [0.9, 0.87, 0.8] }); railing(k, [[la, 3.7, z1 - 0.25], [lb, 3.7, z1 - 0.25]], 0.95, { color: DARK, rails: [0.1, 0.35, 0.6, 0.85], post: 1.6 }); }
    for (let i = 0; i <= n; i++) { const px = la + (lb - la) * i / n; k.collide(px - 0.2, 0, z1 - 0.7, px + 0.2, 3.25, z1 - 0.3); }
    k.at(0, 0, cz1, 0, () => { doorway(k, 0, 0.18, 1.8, 2.5, { metal: false, frame: [0.3, 0.2, 0.12], glass: [0.12, 0.07, 0.04] }); for (const s of [-1, 1]) k.lamp(s * 1.4, 2.6, 0.12, [1, 0.8, 0.5], { power: 12, radius: 5, radiance: 8, glow: 0.3, size: 0.08 }); });
    // stair turret in the angle of one wing
    const tx = (k.h(3) < 0.5 ? -1 : 1) * ((lb - la) / 2 + 0.2), tr = 2.0;
    if (!k.far) { k.stucco(wall, 60).occ(1).cyl(tx, 0, cz1 + 0.6, tr, H + 1.6, { cap: false, segs: k.near ? 14 : 8 }); k.roofing(1, tile).cyl(tx, H + 1.6, cz1 + 0.6, tr + 0.3, H + 4.0, { r1: 0.05, cap: false, segs: k.near ? 14 : 8 }); }
    k.collide(tx - tr, 0, cz1 + 0.6 - tr, tx + tr, H + 1.6, cz1 + 0.6 + tr);
  } else if (variant === 1) {
    const glassy = { style: F('MANSION', 'MODERN'), bay: 3.4, color: wall, seed }, blank = { style: F('BLANK', 'STUCCO'), bay: 4, color: wall, seed }, sp = (r) => (r.cls === 'front' || r.cls === 'back' ? glassy : blank), roof = { parapet: 0.35, color: wall, seed, coping: wall, roofKind: 3, roof: [0.86, 0.86, 0.84] };
    const a = mass(k, rectRuns(x0, z0, x1, z1 - 2), 0, [{ h: 3.6, spec: sp }], roof);
    const off = (k.h(3) - 0.5) * hw * 0.2, b = mass(k, rectRuns(x0 + hw * 0.18 + off, z0 + 1.5, x1 - hw * 0.12 + off, z1), a.roofY, [{ h: 3.3, storey: 3.3, grounded: false, spec: sp }], { ...roof, collide: false });
    k.collide(b.x0, 0, z1 - 2, b.x1, 3.6, z1);
    if (floors > 2) mass(k, rectRuns(-4 + off, z0 + 3, 5 + off, z1 - 2.5), b.roofY, [{ h: 3.0, storey: 3.0, grounded: false, spec: sp }], { ...roof, collide: false });
    if (!k.far) { k.stucco(wall, 50).occ(1).ledge(b.runs, b.roofY, b.roofY + 0.35, 1.2, { closed: true, bottom: true, inner: b.roofY }); k.ledge(a.runs, a.roofY, a.roofY + 0.35, 0.5, { closed: true, bottom: true, inner: a.roofY });
      for (const px of [b.x0 + 0.3, (b.x0 + b.x1) / 2, b.x1 - 0.3]) k.stucco(wall, 50).box(px - 0.2, 0, z1 - 0.4, px + 0.2, 3.6, z1, 'xXZz'); }
    for (const px of [b.x0 + 0.3, (b.x0 + b.x1) / 2, b.x1 - 0.3]) k.collide(px - 0.2, 0, z1 - 0.4, px + 0.2, 3.6, z1);
    k.onRun(a.runs.find((r) => r.cls === 'front'), (len) => { railing(k, [[0.1, 3.95, 0.02], [b.x0 - x0, 3.95, 0.02]], 0.9, { color: [0.75, 0.76, 0.78], rails: [0.5], post: 2 }); doorway(k, len / 2 + off, 0.1, 2.2, 2.6, { leaves: 2 }); k.lamp(len / 2 + off, 3.55, 1.0, [1, 0.92, 0.8], { power: 16, radius: 6, radiance: 9, glow: 0.35 }); });
  } else {
    const c = mass(k, rectRuns(x0, z0, x1, z1), 0, [{ h: H, storey: FL, spec: shut }], { parapet: 0.9, color: wall, seed, coping: WHITE });
    if (!k.far) k.stucco(WHITE, 50).occ(1).ledge(c.runs, H - 0.15, H + 0.3, 0.45, { closed: true, bottom: true, inner: H });
    // portico: four columns the full height carrying a pediment
    const pw = clamp(hw * 0.4, 9, 14), pd = 3.4, ph = Math.min(H, 2 * FL) + 0.1;
    k.at(0, 0, z1, 0, () => {
      if (!k.far) { k.tile([0.86, 0.84, 0.8], 40, 0).occ(1).box(-pw / 2, 0, 0, pw / 2, 0.45, pd, 'xXZY'); k.stucco(WHITE, 50).box(-pw / 2, ph, 0, pw / 2, ph + 0.7, pd, 'xXZy'); }
      for (let i = 0; i < 4; i++) column(k, -pw / 2 + 0.6 + (pw - 1.2) * i / 3, pd - 0.6, 0.45, ph, 0.36, { color: WHITE, segs: 14 });
      pitchedRoof(k, -pw / 2, 0, pw / 2, pd, ph + 0.7, { pitch: 0.34, over: 0.25, kind: 4, color: [0.3, 0.3, 0.32], gable: true, wall: WHITE });
      doorway(k, 0, 0.45, 2.0, 2.7, { metal: false, frame: WHITE, glass: [0.05, 0.08, 0.06] }); steps(k, -pw / 2 + 0.4, pw / 2 - 0.4, pd, 0.45, { n: 2, tread: 0.35 });
      k.lamp(0, ph - 0.05, pd * 0.5, [1, 0.86, 0.6], { power: 22, radius: 7, radiance: 9, glow: 0.4 });
    });
    for (let i = 0; i < 4; i++) { const px = -pw / 2 + 0.6 + (pw - 1.2) * i / 3; k.collide(px - 0.4, 0, z1 + pd - 1.0, px + 0.4, ph, z1 + pd - 0.2); }
    roofPlant(k, x0 + 2, z0 + 2, x1 - 2, z1 - 2, H, { core: false, units: 2, tank: false, aerial: false });
  }
  // grounds: perimeter wall, gate with lamp piers, forecourt, garage block, pool terrace behind
  const wh = 2.1 + k.h(4) * 0.6, gate = 4.2 + k.h(5) * 1.3, fz = D / 2 - 0.5, ex = W / 2 - 0.5, bz = -D / 2 + 0.5, wo = { h: wh, t: 0.3, color: mixColor(wall, WHITE, 0.4), piers: 4.5, coping: WHITE };
  yardWall(k, [[-gate / 2 - 0.4, fz], [-ex, fz]], wo); yardWall(k, [[-ex, fz], [-ex, bz]], wo); yardWall(k, [[-ex, bz], [ex, bz]], wo); yardWall(k, [[ex, bz], [ex, fz]], wo); yardWall(k, [[ex, fz], [gate / 2 + 0.4, fz]], wo);
  for (const s of [-1, 1]) { const px = s * (gate / 2 + 0.4); if (!k.far) { k.stucco(WHITE, 60).occ(1).box(px - 0.45, 0, fz - 0.45, px + 0.45, wh + 0.5, fz + 0.45); k.box(px - 0.55, wh + 0.5, fz - 0.55, px + 0.55, wh + 0.62, fz + 0.55, 'xXzZYy'); k.lamp(px, wh + 1.0, fz, [1, 0.84, 0.58], { power: 22, radius: 8, radiance: 10, glow: 0.5, size: 0.14 });
      if (k.near) { k.steel(DARK, 0.4, 30); const a = px - s * 0.45, b = px - s * (0.45 + gate * 0.42); k.pipe([[a, 0.15, fz], [b, 0.15, fz]], 0.025, 4).pipe([[a, wh - 0.1, fz], [b, wh + 0.25, fz]], 0.025, 4); for (let i = 0; i <= 8; i++) { const t = i / 8, gx = a + (b - a) * t; k.pipe([[gx, 0.15, fz], [gx, wh - 0.1 + 0.35 * t, fz]], 0.014, 3); } } }
    k.collide(px - 0.45, 0, fz - 0.45, px + 0.45, wh + 0.5, fz + 0.45); }
  pad(k, -gate / 2 - 1, z1 + (variant === 2 ? 4.2 : 0.3), gate / 2 + 1, fz - 0.4, [0.74, 0.68, 0.6], { tile: 40, pattern: 3 });
  pad(k, -Math.min(hw / 2, 12), z1 + (variant === 2 ? 4.2 : 0.3), Math.min(hw / 2, 12), z1 + (variant === 2 ? 4.2 : 0.3) + 5.5, [0.74, 0.68, 0.6], { tile: 40, pattern: 3 });
  const gs = k.h(6) < 0.5 ? -1 : 1, gx0 = gs < 0 ? -ex + 1.2 : ex - 1.2 - 7.5;
  { const gz0 = z1 + 1.5, gz1 = Math.min(fz - 2.5, gz0 + 6.5); if (gz1 - gz0 > 4.5 && Math.abs(gx0 + 3.75) - 3.75 > gate / 2 + 2) { mass(k, rectRuns(gx0, gz0, gx0 + 7.5, gz1), 0, [{ h: 3.0, spec: (r) => (r.cls === (gs < 0 ? 'right' : 'left') ? { style: F('WAREHOUSE', 'DOORS'), bay: 3.2, color: wall, seed } : { style: F('BLANK', 'STUCCO'), bay: 4, color: wall, seed }) }], variant === 1 ? { parapet: 0.3, color: wall, seed } : { roof: null }); if (variant !== 1) pitchedRoof(k, gx0, gz0, gx0 + 7.5, gz1, 3.0, { pitch: 0.36, over: 0.4, kind: variant === 0 ? 1 : 4, color: variant === 0 ? tile : [0.3, 0.3, 0.32] }); } }
  // planting: royal palms either side of the drive, coconuts in the corners of the grounds, a shrub border inside
  // the street wall so the wall reads as a garden boundary rather than a bare fence (the tile builder instances them)
  for (const s of [-1, 1]) { k.plant('royal', s * (gate / 2 + 3.2), fz - 3.2, { scale: 0.95 + k.h(70 + s) * 0.15 }); k.plant('coconut', s * (ex - 2.6), bz + 2.6, { scale: 0.85 + k.h(72 + s) * 0.25 }); }
  for (let x = -ex + 2.0; x < ex - 1.5; x += 2.6) if (Math.abs(x) > gate / 2 + 1.4) k.plant('shrub', x + (k.h(74 + x) - 0.5) * 0.6, fz - 1.9, { scale: 1.0 + k.h(75 + x) * 0.35 });
  const yard = z0 - bz;
  if (yard >= 10) { const pw = clamp(hw * 0.5, 12, 20), pd = clamp(yard - 4.5, 6, 9); pool(k, -pw / 2, z0 - 2 - pd - 2.4, pw / 2, z0 - 2, { rim: 1.5, r: variant === 1 ? 0.01 : 1.8, pattern: 1 }); }
  return { S, variant };
}

// ------------------------------------------------------------------------------------------------ filling station
/**
 * Filling station. Variants: 0 a flat canopy on four columns over two pump islands with a glass shop behind,
 * 1 a canted canopy on a single row of masts, 2 an older streamlined station: rounded office, service bays, a
 * canopy growing out of the building. All have a price pylon by the road.
 */
export function gasStation(k, lot) {
  const S = scheme(lot.seed ^ 0x57, 'resort', lot.style), W = lot.width, D = lot.depth, seed = S.seedByte, variant = (((lot.variant ?? Math.floor(k.h(1) * 3)) % 3) + 3) % 3;
  const brand = [[0.85, 0.12, 0.1], [0.1, 0.3, 0.7], [0.95, 0.6, 0.05], [0.1, 0.5, 0.25]][Math.floor(k.h(2) * 4)], white = [0.93, 0.93, 0.91], zb = -D / 2 + 1.5, bw = clamp(W * 0.6, 14, 22), bd = 7, flip = k.h(3) < 0.5 ? -1 : 1;
  const bx0 = -bw / 2, bx1 = bw / 2, runs = variant === 2 ? rectRuns(bx0, zb, bx1, zb + bd, flip < 0 ? [2.6, 0, 0, 0] : [0, 2.6, 0, 0], k.arc) : rectRuns(bx0, zb, bx1, zb + bd), H = 3.6;
  const bays = { style: F('WAREHOUSE', 'DOORS'), bay: 4.2, color: white, seed }, shop = { style: F('SHOPFRONT', 'RETAIL'), bay: 3.4, color: white, seed, occ: [1, 0.8] };
  // front wall: shop at one end, service bays at the other; hand-made so the two halves can differ
  const m = mass(k, runs, 0, [{ h: H, spec: (r) => (r.cls === 'front' ? null : r.cls === 'back' ? { style: F('BLANK', 'SERVICE'), bay: 4, color: white, seed } : r.curved ? { style: F('SHOPFRONT', 'RETAIL'), bays: 2, color: white, seed } : { style: F('BLANK', 'STUCCO', true), bay: 4, color: white, seed }) }], { parapet: 0.5, color: white, seed, coping: brand });
  const fr = runs.find((r) => r.cls === 'front'), split = fr.len * 0.45;
  k.onRun(fr, (len) => {
    const seg = (a, b, spec) => k.walls([lineRun(a, 0, b, 0)], 0, [{ h: H, spec }]);
    if (flip < 0) { seg(0, split, shop); seg(split, len, bays); } else { seg(0, len - split, bays); seg(len - split, len, shop); }
    if (!k.far) k.paint(brand, 0.4, 40).occ(1).box(-0.02, H - 0.55, 0, len + 0.02, H - 0.2, 0.05, 'xXZYy');
    const sx = flip < 0 ? split / 2 : len - split / 2; doorway(k, sx + 1.0, 0, 1.0, 2.1, {}); wallSign(k, 'gas', lot.seed >>> 3, sx, H + 0.05, { height: 0.9, maxWidth: split - 1, lit: S.signLit, far: true, z: 0.06 });
    wallSign(k, 'garage', lot.seed >>> 4, flip < 0 ? (split + len) / 2 : (len - split) / 2, H - 0.05, { height: 0.5, maxWidth: len - split - 1, lit: false, z: 0.06 });
  });
  roofPlant(k, bx0 + 1, zb + 1, bx1 - 1, zb + bd - 1, m.roofY, { core: false, units: 2, tank: false, aerial: false });
  // canopy and pump islands
  const cw = clamp(W * 0.55, 12, 20), cd = clamp(D * 0.3, 7, 10), cz0 = zb + bd + (variant === 2 ? 0 : 4.5), cz1 = Math.min(D / 2 - 3, cz0 + cd), cy = 4.5, cx0 = variant === 2 ? (flip < 0 ? bx0 : bx1 - cw * 0.6) : -cw / 2, cx1 = variant === 2 ? cx0 + cw * 0.6 : cw / 2, zc = (cz0 + cz1) / 2;
  const islands = variant === 2 ? [(cx0 + cx1) / 2] : [cx0 + (cx1 - cx0) * 0.27, cx0 + (cx1 - cx0) * 0.73];
  if (!k.far) {
    if (variant === 1) { k.stucco(white, 50); tiltSlab(k, cx0, cz0, (cx0 + cx1) / 2, cz1, cy + 1.3, cy, 0.3); k.stucco(white, 50); tiltSlab(k, (cx0 + cx1) / 2, cz0, cx1, cz1, cy, cy + 1.3, 0.3); k.paint(brand, 0.4, 30).occ(1).box(cx0 - 0.02, cy + 0.85, cz0 - 0.02, cx0 + 0.04, cy + 1.3, cz1 + 0.02, 'xXzZYy').box(cx1 - 0.04, cy + 0.85, cz0 - 0.02, cx1 + 0.02, cy + 1.3, cz1 + 0.02, 'xXzZYy'); }
    else { k.stucco(white, 50).occ(1).box(cx0, cy, cz0, cx1, cy + 0.7, cz1, 'Yy'); k.stucco(white, 50).box(cx0, cy, cz0, cx1, cy + 0.7, cz1, 'xXzZ'); k.paint(brand, 0.4, 30).box(cx0 - 0.02, cy + 0.2, cz0 - 0.02, cx1 + 0.02, cy + 0.5, cz1 + 0.02, 'xXzZ');
      k.emissive(white, 6, CHANNEL.STREET).box(cx0 - 0.03, cy + 0.04, cz0 - 0.03, cx1 + 0.03, cy + 0.12, cz1 + 0.03, 'xXZ'); k.glow(cx0, cy + 0.1, cz1, 1.2, [1.2, 1.2, 1.3], CHANNEL.STREET); k.glow(cx1, cy + 0.1, cz1, 1.2, [1.2, 1.2, 1.3], CHANNEL.STREET); k.light((cx0 + cx1) / 2, cy + 0.1, cz1 + 0.6, [18, 18, 20], 9, CHANNEL.STREET); }
  }
  for (const ix of islands) {
    if (!k.far) { k.concrete([0.74, 0.73, 0.7], 0, 80).occ(1).box(ix - 0.6, 0, zc - 2.6, ix + 0.6, 0.18, zc + 2.6, 'xXzZY');
      for (const pz of [zc - 1.3, zc + 1.3]) { k.paint(white, 0.35, 40).box(ix - 0.4, 0.18, pz - 0.28, ix + 0.4, 1.35, pz + 0.28, 'xXzZ'); k.paint(brand, 0.35, 40).box(ix - 0.42, 1.35, pz - 0.3, ix + 0.42, 1.75, pz + 0.3, 'xXzZY'); k.glass([0.05, 0.06, 0.07], 0.1).box(ix - 0.41, 0.95, pz - 0.2, ix + 0.41, 1.25, pz + 0.2, 'xX'); }
      const cols = variant === 1 ? [zc] : [zc - 2.2, zc + 2.2]; for (const pz of cols) { k.steel(white, 0.4, 30).box(ix - 0.14, 0.18, pz - 0.14, ix + 0.14, variant === 1 ? cy + 0.4 : cy, pz + 0.14, 'xXzZ'); }
      for (const pz of [zc - 1.6, zc + 1.6]) for (const sx of [-1.6, 1.6]) k.lamp(ix + sx, variant === 1 ? cy + 0.15 : cy, pz, [0.95, 0.98, 1], { power: 34, radius: 9, radiance: 12, glow: 0.5, spot: [0, -1, 0], outer: 70, inner: 45 }); }
    k.collide(ix - 0.6, 0, zc - 2.6, ix + 0.6, 1.75, zc + 2.6);
  }
  k.at(flip < 0 ? W / 2 - 2.2 : -W / 2 + 2.2, 0, D / 2 - 1.9, Math.PI / 2, () => pylonSign(k, 0, 0, { height: 8.5, category: 'gas', variant: lot.seed >>> 3, signHeight: 2.2, maxWidth: 3.2, posts: 2, color: white }));
  return { S, variant };
}
