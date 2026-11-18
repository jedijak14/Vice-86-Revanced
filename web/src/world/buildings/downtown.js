// Downtown: office towers on parking podiums, mid-rise office blocks and parking structures
// (design/brief/architecture.md sections 12 and 13). In 1986 the skyline is one very tall tower, two or three at
// 150 to 190 m and a field of older, lower blocks; the planner sets the floors, these builders give each its skin.

import { CHANNEL } from '../../core/ids.js';
import { clamp, srgbToLinear } from '../../core/math.js';
import { rectRuns, namedRuns, shade, mixColor } from './kit.js';
import { scheme, GLASS_SKINS, NEON } from './palette.js';
import { F, WHITE, DARK, STEEL, mass, canopy, column, doorway, roofPlant, roofSign, wallSign, pitchedRoof, bySide, beacon, mast, awning, bayLines, windowUnits } from './parts.js';

export const O_FLOOR = 3.9, O_GROUND = 6.0, G_FLOOR = 3.0;
const CONC = [0.74, 0.73, 0.70];

/** Rectangle with its four corners cut at 45 degrees by c: an eight-sided tower plan. */
export function octRuns(x0, z0, x1, z1, c) {
  if (c < 0.3) return rectRuns(x0, z0, x1, z1);
  return namedRuns([[x0 + c, z1], [x1 - c, z1], [x1, z1 - c], [x1, z0 + c], [x1 - c, z0], [x0 + c, z0], [x0, z0 + c], [x0, z1 - c]], ['front', 'fr', 'right', 'br', 'back', 'bl', 'left', 'fl']);
}
/** A lit band round the top of a tower: emissive strip, a light and a glow on each long side, and a glow at each corner kept at every distance. */
function crownLight(k, runs, y, h, color, radiance = 5) {
  const lin = color.map(srgbToLinear);
  k.emissive(color, radiance, CHANNEL.NEON).occ(1);
  if (!k.far) k.ledge(runs, y, y + h, 0.06, { closed: true, top: false, bottom: false });
  for (const r of runs) { const a = r.pts[0], b = r.pts[r.pts.length - 1], mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    k.glow(a[0], y + h / 2, a[1], Math.max(2.5, h * 2.2), lin.map((c) => c * radiance * 0.5), CHANNEL.NEON, 0, true);
    if (r.len > 8) { k.light(mx + r.nx * 2.5, y + h / 2, mz + r.nz * 2.5, lin.map((c) => c * 9), 14, CHANNEL.NEON); k.glow(mx + r.nx * 0.1, y + h / 2, mz + r.nz * 0.1, Math.max(2.5, h * 2.2), lin.map((c) => c * radiance * 0.35), CHANNEL.NEON, 0); } }
}
/** Planters and benches of a tower plaza, in front of the wall at z0 out to z1. Near only, with colliders at every level. */
function plaza(k, x0, x1, z0, z1, cx, doorW) {
  const d = z1 - z0; if (d < 3) return;
  for (const s of [-1, 1]) {
    const a = s < 0 ? x0 + 0.8 : cx + doorW / 2 + 1.5, b = s < 0 ? cx - doorW / 2 - 1.5 : x1 - 0.8; if (b - a < 3) continue;
    const pz0 = z0 + d * 0.45, pz1 = z1 - 0.5;
    if (!k.far) { k.concrete(CONC, 0, 70).occ(1).box(a, 0, pz0, b, 0.5, pz1, 'xXzZ'); k.box(a, 0.5, pz0, b, 0.5, pz1, 'Y'); k.roofing(0, [0.2, 0.17, 0.12]).box(a + 0.18, 0.44, pz0 + 0.18, b - 0.18, 0.52, pz1 - 0.18, 'Y'); }
    k.collide(a, 0, pz0, b, 0.5, pz1);
  }
}

/**
 * Office tower. Variants: 0 stepped mirror glass in three tiers with a lit crown, 1 white gridded tower with a
 * set-back top, 2 dark glass box with louvred plant floors and roof letters, 3 bronze or gold mirror glass with cut
 * corners, 4 concrete slab between two solid cores, 5 an older masonry tower stepping back to a pyramid roof.
 * lot.podium (true | false) forces or forbids the parking podium; lot.floorsExact skips the archetype clamp (landmarks).
 */
export function officeTower(k, lot) {
  const S = scheme(lot.seed ^ 0xa5, 'office', lot.style), W = lot.width, D = lot.depth, floors = lot.floors | 0;
  const variant = (((lot.variant ?? Math.floor(k.h(1) * 6)) % 6) + 6) % 6, seed = S.seedByte;
  const x0 = -W / 2 + 1.5, x1 = W / 2 - 1.5, zf = D / 2 - 5.5, zb = -D / 2 + 1.5, cx = 0, stone = variant === 5 ? [0.80, 0.74, 0.62] : variant === 1 ? [0.91, 0.90, 0.87] : S.wall;
  const glass = lot.glass ?? (variant === 3 ? GLASS_SKINS[k.h(2) < 0.6 ? 4 : 5][0] : variant === 2 ? GLASS_SKINS[k.h(2) < 0.5 ? 6 : 3][0] : variant === 0 ? GLASS_SKINS[k.h(2) < 0.45 ? 1 : k.h(2) < 0.75 ? 2 : 0][0] : S.glass);
  const podium = lot.podium ?? (floors >= 16 && Math.min(x1 - x0, zf - zb) >= 30 && variant !== 4), pl = podium ? 3 + Math.floor(k.h(3) * 2.99) : 0;
  const lobby = { style: F('SHOPFRONT', 'OFFICE_LOBBY', variant === 5), bay: variant === 5 ? 4.2 : 3.0, color: variant === 2 || variant === 3 || variant === 0 ? CONC : stone, seed, occ: [1, 0.8] };
  const retail = { style: F('SHOPFRONT', 'SHOWROOM'), bay: 6, color: lobby.color, seed }, service = { style: F('SHOPFRONT', 'SERVICE'), bay: 6, color: shade(lobby.color, 0.92), seed };
  const gspec = (r) => (r.cls === 'front' ? lobby : r.cls === 'back' ? service : r.cls === 'left' || r.cls === 'right' ? retail : lobby);
  let y = 0, tx0 = x0, tx1 = x1, tz0 = zb, tz1 = zf;
  if (podium) {
    const deck = { style: F('GARAGE', variant === 1 || variant === 5 ? 'FINS' : 'SPANDREL'), bay: 7.5, color: variant === 5 ? stone : CONC, seed };
    const p = mass(k, rectRuns(x0, zb, x1, zf), 0, [{ h: O_GROUND, spec: gspec }, { h: pl * G_FLOOR, storey: G_FLOOR, spec: deck }], { parapet: 1.1, color: deck.color, seed, roofKind: 3, roof: [0.6, 0.6, 0.58] });
    y = p.roofY; const inset = clamp(Math.min(x1 - x0, zf - zb) * 0.1, 2.5, 5); tx0 += inset; tx1 -= inset; tz0 += inset * 1.4; tz1 -= inset * 0.6;
    if (k.near) bayLines(k, x0 + 1.5, tx0 - 0.6, zb + 2, zb + 7, 2.7, { y: y + 0.02 });
  }
  const up = Math.max(4, floors - (podium ? pl + 1 : 1)), base = podium ? [] : [{ h: O_GROUND, spec: gspec }];
  const tiers = [];                                              // { runs, bands, parapet, coping, color }
  const tw = tx1 - tx0, td = tz1 - tz0;
  if (variant === 0) {
    const skin = { style: F('CURTAIN', 'MIRROR'), bay: 1.5, color: glass, seed }, n = [Math.round(up * 0.52), Math.round(up * 0.3)]; n.push(Math.max(1, up - n[0] - n[1]));
    const st = clamp(Math.min(tw, td) * 0.13, 2.5, 5), dirx = k.h(4) < 0.5 ? 1 : 0;
    n.forEach((nf, i) => tiers.push({ runs: rectRuns(tx0 + (dirx ? st * i : 0), tz0 + (dirx ? 0 : st * i), tx1 - st * i * (dirx ? 1 : 0.5), tz1 - st * i * (dirx ? 0.5 : 0)), bands: [...(i === 0 ? base : []), { h: nf * O_FLOOR, storey: O_FLOOR, grounded: false, spec: skin }], parapet: 1.2, color: shade(glass, 0.8), style: F('CURTAIN', 'MIRROR') }));
  } else if (variant === 1) {
    const grid = { style: F('PUNCHED', 'SQUARE'), bay: 3.0, color: stone, seed }, n0 = Math.round(up * 0.82), ins = clamp(Math.min(tw, td) * 0.12, 2.5, 4.5);
    tiers.push({ runs: rectRuns(tx0, tz0, tx1, tz1), bands: [...base, { h: n0 * O_FLOOR, storey: O_FLOOR, grounded: false, spec: grid }], parapet: 1.0, color: stone });
    tiers.push({ runs: rectRuns(tx0 + ins, tz0 + ins, tx1 - ins, tz1 - ins), bands: [{ h: (up - n0) * O_FLOOR, storey: O_FLOOR, grounded: false, spec: grid }, { h: 3.9, storey: 3.9, grounded: false, spec: { style: F('BLANK', 'SHEET'), bay: 4, color: [0.62, 0.63, 0.62], seed } }], parapet: 0.6, color: [0.62, 0.63, 0.62] });
  } else if (variant === 2) {
    const skin = { style: F('CURTAIN', 'GRID'), bay: 1.5, color: glass, seed }, louvre = { style: F('BLANK', 'SHEET'), bay: 4, color: shade(glass, 0.9).map((c) => c * 0.6 + 0.08), seed };
    const n0 = Math.round(up * 0.5), bands = [...base, { h: n0 * O_FLOOR, storey: O_FLOOR, grounded: false, spec: skin }];
    if (up >= 18) bands.push({ h: O_FLOOR, storey: O_FLOOR, grounded: false, spec: louvre });
    bands.push({ h: (up - n0) * O_FLOOR, storey: O_FLOOR, grounded: false, spec: skin }, { h: 2 * O_FLOOR, storey: 2 * O_FLOOR, grounded: false, spec: louvre });
    tiers.push({ runs: rectRuns(tx0, tz0, tx1, tz1), bands, parapet: 0.8, color: louvre.color, style: F('BLANK', 'SHEET') });
  } else if (variant === 3) {
    const skin = { style: F('CURTAIN', 'MIRROR'), bay: 1.5, color: glass, seed }, c = clamp(Math.min(tw, td) * 0.2, 3, 8), n0 = Math.max(3, Math.round(up * 0.86));
    tiers.push({ runs: octRuns(tx0, tz0, tx1, tz1, c), bands: [...base, { h: n0 * O_FLOOR, storey: O_FLOOR, grounded: false, spec: skin }], parapet: 0.9, color: shade(glass, 0.8), style: F('CURTAIN', 'MIRROR') });
    tiers.push({ runs: octRuns(tx0 + c * 0.6, tz0 + c * 0.6, tx1 - c * 0.6, tz1 - c * 0.6, c * 0.9), bands: [{ h: Math.max(1, up - n0) * O_FLOOR, storey: O_FLOOR, grounded: false, spec: skin }], parapet: 1.5, color: shade(glass, 0.8), style: F('CURTAIN', 'MIRROR') });
  } else if (variant === 4) {
    const d = Math.min(td, 22), z1 = tz1, z0 = z1 - d, cw = 5.5, win = { style: F('PUNCHED', k.h(4) < 0.5 ? 'RIBBON' : 'EGGCRATE'), bay: 3.3, color: CONC, seed }, solid = { style: F('BLANK', 'CONCRETE'), bay: 4, color: shade(CONC, 0.96), seed };
    tiers.push({ runs: rectRuns(tx0 + cw - 0.5, z0, tx1 - cw + 0.5, z1), bands: [...base, { h: up * O_FLOOR, storey: O_FLOOR, grounded: false, spec: (r) => (r.cls === 'front' || r.cls === 'back' ? win : null) }, { h: 2.6, storey: 2.6, grounded: false, spec: (r) => (r.cls === 'front' || r.cls === 'back' ? solid : null) }], parapet: 0.6, color: CONC });
    for (const s of [-1, 1]) tiers.push({ runs: rectRuns(s < 0 ? tx0 : tx1 - cw, z0 - 1.2, s < 0 ? tx0 + cw : tx1, z1 + 0.9), bands: [{ h: (podium ? 0 : O_GROUND) + up * O_FLOOR + 6.5, storey: (podium ? 0 : O_GROUND) + up * O_FLOOR + 6.5, grounded: !podium, spec: solid }], parapet: 0, color: CONC, base: true });
  } else {
    const win = { style: F('PUNCHED', 'SLOT', true), bay: 2.6, color: stone, seed }, fr = [0.58, 0.2, 0.12, 0.1], st = clamp(Math.min(tw, td) * 0.11, 2, 4.2); let used = 0;
    fr.forEach((f, i) => { const nf = i === fr.length - 1 ? Math.max(1, up - used) : Math.max(1, Math.round(up * f)); used += nf; if (tw - 2 * st * i < 7 || td - 2 * st * i < 7) return;
      tiers.push({ runs: rectRuns(tx0 + st * i, tz0 + st * i, tx1 - st * i, tz1 - st * i), bands: [...(i === 0 ? base : []), { h: nf * O_FLOOR, storey: O_FLOOR, grounded: false, spec: win }], parapet: 1.0, color: stone, coping: shade(stone, 1.05) }); });
  }
  let top = y, topTier = null, ty = y, firstTop = y;
  tiers.forEach((t, i) => {
    const m = mass(k, t.runs, t.base ? y : ty, t.bands, { parapet: t.parapet, color: t.color, parapetStyle: t.style, coping: t.coping, seed, roofKind: 3, roof: [0.5, 0.5, 0.49] });
    if (!t.base) { ty = m.roofY; topTier = m; if (i === 0) firstTop = m.top; } top = Math.max(top, m.top);
  });
  const tt = topTier, ry = tt.roofY, mx = (tt.x0 + tt.x1) / 2, mz = (tt.z0 + tt.z1) / 2;
  // tops: each skin ends its own way
  if (variant === 5) { const ridge = pitchedRoof(k, tt.x0 + 0.6, tt.z0 + 0.6, tt.x1 - 0.6, tt.z1 - 0.6, tt.top, { pitch: 1.25, over: 0, kind: 2, color: [0.36, 0.55, 0.47] }); mast(k, mx, ridge - 0.3, mz, 9); top = ridge + 9; }
  else {
    roofPlant(k, tt.x0 + 1.5, tt.z0 + 1.5, tt.x1 - 1.5, tt.z1 - 1.5, ry, { core: true, units: 4, tank: false, aerial: false, color: [0.6, 0.6, 0.58] });
    if (variant === 2 || variant === 0 || k.h(5) < 0.5) { mast(k, mx + (tt.x1 - tt.x0) * 0.2, ry + 2.4, mz, 10 + k.h(6) * 14); top += 12; }
    else for (const [bx, bz] of [[tt.x0 + 0.3, tt.z0 + 0.3], [tt.x1 - 0.3, tt.z1 - 0.3]]) beacon(k, bx, tt.top + 0.1, bz);
  }
  if (variant === 0 || variant === 3 || (variant === 5 && k.h(7) < 0.6)) crownLight(k, tt.runs, tt.top - (variant === 5 ? 1.0 : 1.3), variant === 5 ? 0.5 : 0.9, variant === 5 ? NEON.warm : S.neon, variant === 5 ? 4 : 5);
  // the tenant's name high on the street face, seen across the bay
  const face = tt.runs.find((r) => r.cls === 'front'), cat = k.h(8) < 0.4 ? 'bank' : 'office';
  if (variant === 2) roofSign(k, mx, tt.top, tt.z1 - 0.6, { category: cat, variant: lot.seed >>> 3, height: clamp((tt.x1 - tt.x0) * 0.09, 2.2, 4), maxWidth: (tt.x1 - tt.x0) * 0.8, leg: 0.8, lit: S.signLit, far: true });
  else k.onRun(face, (len) => wallSign(k, cat, lot.seed >>> 3, len / 2, tt.roofY - (variant === 0 || variant === 3 ? 3.2 : 1.8), { height: clamp(len * 0.07, 1.6, 3.2), maxWidth: len * 0.7, lit: S.signLit, far: true, z: variant === 4 ? 0.05 : 0.08 }));

  // street level: the door under a canopy, plaza planters, a low monument sign
  const dw = 4.2;
  k.at(cx, 0, zf, 0, () => {
    if (variant === 5 || variant === 1) { for (const s of [-1, 1]) column(k, s * (dw / 2 + 0.9), 0.55, 0, O_GROUND - 0.6, 0.38, { color: stone, square: variant === 1 }); if (!k.far) k.stucco(stone, 60).occ(1).box(-dw / 2 - 1.5, O_GROUND - 0.6, 0, dw / 2 + 1.5, O_GROUND + 0.2, 1.0, 'xXZYy'); }
    else canopy(k, -dw / 2 - 1.2, dw / 2 + 1.2, 3.6, 3.2, { th: 0.28, color: [0.3, 0.31, 0.33], lip: variant === 3 ? [0.6, 0.48, 0.25] : [0.75, 0.76, 0.78], lamps: 2, lampPower: 30 });
    doorway(k, 0, 0, dw, 2.5, { leaves: 4 });
    wallSign(k, cat, lot.seed >>> 3, 0, variant === 5 || variant === 1 ? O_GROUND - 0.2 : 4.25, { height: 0.5, maxWidth: dw + 2, lit: S.signLit, z: variant === 5 || variant === 1 ? 1.02 : 0.04 });
  });
  if (variant === 5 || variant === 1) for (const s of [-1, 1]) k.collide(cx + s * (dw / 2 + 0.9) - 0.4, 0, zf + 0.15, cx + s * (dw / 2 + 0.9) + 0.4, O_GROUND - 0.6, zf + 0.95);
  plaza(k, x0, x1, zf, D / 2 - 0.4, cx, dw + 3);
  return { S, variant, top, crownY: tt.top };
}

/**
 * Mid-rise office block. Variants: 0 masonry with a cornice and shops below, 1 sun-breaker grid (egg-crate) on
 * pilotis, 2 small curtain-wall bank between stone cores, 3 older brick block with a fire escape.
 */
export function officeBlock(k, lot) {
  const S = scheme(lot.seed ^ 0x3c, 'office', lot.style), W = lot.width, D = lot.depth, att = lot.attached ?? {}, floors = clamp(lot.floors | 0, 3, 14), up = floors - 1;
  const variant = (((lot.variant ?? Math.floor(k.h(1) * 4)) % 4) + 4) % 4, seed = S.seedByte, FL = 3.5, G = 4.6;
  const x0 = -W / 2 + (att.left ? 0 : 0.6), x1 = W / 2 - (att.right ? 0 : 0.6), zf = D / 2 - 1.2, zb = -D / 2 + (att.back ? 0 : 2.0), cx = (x0 + x1) / 2, trim = S.trimC;
  const wall = variant === 3 ? [[0.52, 0.25, 0.19], [0.62, 0.36, 0.25], [0.70, 0.58, 0.42]][Math.floor(k.h(2) * 3)] : variant === 2 ? [0.82, 0.80, 0.75] : S.wall;
  const party = { style: F('BLANK', variant === 3 ? 'BRICK' : 'STUCCO'), bay: 4, color: shade(wall, 0.95), seed }, runs = rectRuns(x0, zb, x1, zf);
  const service = { style: F('SHOPFRONT', 'SERVICE'), bay: 5.5, color: shade(wall, 0.93), seed }, cat = variant === 2 ? 'bank' : 'office';
  let ground, upper, sideU, par = 1.0;
  if (variant === 0) { ground = { style: F('SHOPFRONT', 'RETAIL', k.h(3) < 0.4), bay: 5.6, color: wall, seed, occ: [1, 0.8] }; upper = { style: F('PUNCHED', 'SQUARE', true), bay: 2.8, color: wall, seed }; sideU = { style: F('PUNCHED', 'SLOT'), bay: 3.4, color: wall, seed }; }
  else if (variant === 1) { ground = { style: F('SHOPFRONT', 'OFFICE_LOBBY'), bay: 4.2, color: CONC, seed, occ: [1, 0.6] }; upper = { style: F('PUNCHED', 'EGGCRATE'), bay: 2.1, color: mixColor(wall, WHITE, 0.5), seed }; sideU = { style: F('BLANK', 'CONCRETE'), bay: 4, color: CONC, seed }; par = 0.5; }
  else if (variant === 2) { ground = { style: F('SHOPFRONT', 'OFFICE_LOBBY', true), bay: 3.0, color: wall, seed, occ: [1, 0.8] }; upper = { style: F('CURTAIN', k.h(3) < 0.5 ? 'BANDED' : 'PIERS'), bay: 1.5, color: S.glass, seed }; sideU = { style: F('BLANK', 'TILE'), bay: 4, color: wall, seed }; par = 0.7; }
  else { ground = { style: F('SHOPFRONT', k.h(3) < 0.5 ? 'RETAIL' : 'SHUTTERED'), bay: 5.2, color: wall, seed, occ: [1, 0.8] }; upper = { style: F('PUNCHED', 'BRICK'), bay: 2.6, color: wall, seed }; sideU = { style: F('PUNCHED', 'BRICK'), bay: 4.4, color: wall, seed }; }
  const body = mass(k, runs, 0, [{ h: G, spec: bySide({ front: ground, back: service, default: variant === 1 ? ground : { style: F('BLANK', variant === 3 ? 'BRICK' : 'STUCCO'), bay: 4, color: wall, seed } }, att, party) }, { h: up * FL, storey: FL, spec: bySide({ front: upper, back: sideU, default: sideU }, att, party) }], { parapet: par, color: wall, seed, coping: variant === 3 ? [0.75, 0.72, 0.66] : WHITE, parapetStyle: variant === 3 ? F('BLANK', 'BRICK') : undefined });
  const front = runs.find((r) => r.cls === 'front'), topY = body.roofY;
  k.onRun(front, (len) => {
    if (variant === 0) {
      // string course over the shops, cornice under the parapet, a flagpole
      if (!k.far) { k.stucco(shade(wall, 1.04), 60).occ(1).box(-0.12, G - 0.15, 0, len + 0.12, G + 0.2, 0.3, 'xXZYy').box(-0.2, topY - 0.1, 0, len + 0.2, topY + 0.35, 0.55, 'xXZYy').box(-0.12, topY + 0.35, 0, len + 0.12, topY + 0.6, 0.3, 'xXZY'); }
      const n = Math.max(1, Math.round(len / 5.6)); for (let i = 0; i < n; i++) if (k.h(20 + i) < 0.5) awning(k, i * len / n + 0.5, (i + 1) * len / n - 0.5, 3.3, { proj: 1.2, drop: 0.55, color: S.awning, pattern: S.awningStripe });
      for (let i = 0; i < n; i++) wallSign(k, ['shop', 'cafe', 'pharmacy', 'bank', 'market'][Math.floor(k.h(30 + i) * 5)], (lot.seed >>> 3) + i * 7, (i + 0.5) * len / n, 3.85, { height: 0.5, maxWidth: len / n - 1.2, lit: k.h(40 + i) < 0.7 });
    } else if (variant === 1) {
      // the grid stands proud as a frame: side cheeks, top and bottom beams, round pilotis in front of the glass lobby
      if (!k.far) { k.concrete(mixColor(wall, WHITE, 0.6), 0, 60).occ(1).box(-0.05, G - 0.3, 0, len + 0.05, G, 0.75, 'xXZYy').box(-0.05, topY, 0, len + 0.05, topY + 0.5, 0.75, 'xXZYy').box(-0.05, G, 0, 0.3, topY, 0.75, 'xXZ').box(len - 0.3, G, 0, len + 0.05, topY, 0.75, 'xXZ'); }
      const n = Math.max(2, Math.round(len / 6)); for (let i = 0; i <= n; i++) column(k, clamp(i * len / n, 0.4, len - 0.4), 0.4, 0, G - 0.3, 0.26, { color: CONC, blocks: false });
      doorway(k, len / 2, 0, 3.2, 2.4, { leaves: 2 }); wallSign(k, cat, lot.seed >>> 3, len / 2, G - 0.15, { height: 0.42, maxWidth: len * 0.5, z: 0.77, lit: S.signLit });
    } else if (variant === 2) {
      // stone cheeks either side of the glass, a slab canopy, the bank's name in lit letters on the top spandrel
      if (!k.far) for (const s of [0, 1]) k.tile(wall, 60, 0).occ(1).box(s ? len - 2.2 : -0.02, 0, 0, s ? len + 0.02 : 2.2, topY + 0.7, 0.5, 'xXZY');
      canopy(k, len / 2 - 3.5, len / 2 + 3.5, 3.4, 2.6, { th: 0.3, color: [0.3, 0.31, 0.33], lip: [0.78, 0.78, 0.8], lamps: 2 }); doorway(k, len / 2, 0, 3.4, 2.4, { leaves: 4 });
      wallSign(k, 'bank', lot.seed >>> 3, len / 2, topY - 0.05 - clamp(len * 0.05, 0.8, 1.6) / 2, { height: clamp(len * 0.05, 0.8, 1.6), maxWidth: len - 6, lit: S.signLit, far: true, z: 0.06 });
    } else {
      // brick: stone sills are in the wall shader; the iron fire escape is the ornament
      if (!k.far) { k.stucco([0.75, 0.72, 0.66], 80).occ(1).box(-0.06, G - 0.1, 0, len + 0.06, G + 0.18, 0.18, 'xXZYy').box(-0.1, topY, 0, len + 0.1, topY + 0.3, 0.3, 'xXZYy'); }
      if (!k.far && up >= 2) { const fx = len * (k.h(5) < 0.5 ? 0.25 : 0.72), fw = 2.6; k.steel(DARK, 0.6, 90).occ(1);
        for (let f = 1; f <= up; f++) { const y = G + (f - 1) * FL + 0.05; { k.box(fx - fw / 2, y - 0.05, 0, fx + fw / 2, y, 1.0, 'xXZYy'); if (k.near) { k.pipe([[fx - fw / 2, y + 0.95, 0.02], [fx - fw / 2, y + 0.95, 0.98], [fx + fw / 2, y + 0.95, 0.98], [fx + fw / 2, y + 0.95, 0.02]], 0.02, 4).pipe([[fx - fw / 2, y + 0.5, 0.98], [fx + fw / 2, y + 0.5, 0.98]], 0.014, 3); for (let i = 0; i <= 4; i++) k.pipe([[fx - fw / 2 + fw * i / 4, y, 0.98], [fx - fw / 2 + fw * i / 4, y + 0.95, 0.98]], 0.014, 3); if (f < up) k.pipe([[fx - fw / 2 + 0.3, y, 0.55], [fx + fw / 2 - 0.3, y + FL, 0.55]], 0.05, 4); } } } }
      const n = Math.max(1, Math.round(len / 5.2)); for (let i = 0; i < n; i++) wallSign(k, i === 0 ? 'office' : ['shop', 'bar', 'market'][Math.floor(k.h(30 + i) * 3)], (lot.seed >>> 3) + i * 5, (i + 0.5) * len / n, 3.8, { height: 0.5, maxWidth: len / n - 1.2, lit: k.h(40 + i) < 0.5 });
    }
  });
  if (variant === 1) { const n = Math.max(2, Math.round((x1 - x0) / 6)); for (let i = 0; i <= n; i++) { const px = clamp(x0 + i * (x1 - x0) / n, x0 + 0.4, x1 - 0.4); k.collide(px - 0.26, 0, zf + 0.14, px + 0.26, G - 0.3, zf + 0.66); } }
  windowUnits(k, body.info[1], ['back', 'left', 'right'], variant === 3 ? 0.4 : 0.15, 1.0);
  roofPlant(k, x0 + 1, zb + 1, x1 - 1, zf - 1.5, topY, { core: true, units: 3, tank: variant === 3 || (variant === 0 && k.h(6) < 0.4), color: shade(wall, 0.9) });
  if (variant !== 2 && k.h(7) < 0.35 && !att.left) roofSign(k, cx, body.top, zf - 0.8, { category: 'billboard', variant: lot.seed >>> 5, height: 3.2, maxWidth: Math.min(x1 - x0 - 2, 8), leg: 1.2, lit: false, far: true });
  return { S, variant, body };
}

/**
 * Parking structure. Variants: 0 continuous concrete spandrels, 1 vertical fins over the decks, 2 shops on the
 * street with rail-guarded decks above. A stair tower stands at one street corner and the top deck is open.
 */
export function parkingGarage(k, lot) {
  const S = scheme(lot.seed ^ 0x6d, 'office', lot.style), W = lot.width, D = lot.depth, floors = clamp(lot.floors | 0, 2, 9), variant = (((lot.variant ?? Math.floor(k.h(1) * 3)) % 3) + 3) % 3, seed = S.seedByte;
  const x0 = -W / 2 + 0.8, x1 = W / 2 - 0.8, zf = D / 2 - 1.5, zb = -D / 2 + 0.8, G = variant === 2 ? 4.2 : G_FLOOR, col = variant === 1 ? mixColor(S.wall, WHITE, 0.4) : CONC, trim = S.trimC;
  const deck = { style: F('GARAGE', ['SPANDREL', 'FINS', 'RAIL'][variant], k.h(2) < 0.5), bay: variant === 1 ? 6.0 : 7.5, color: col, seed };
  const ground = variant === 2 ? { style: F('SHOPFRONT', 'RETAIL'), bay: 6, color: col, seed, occ: [1, 0.8] } : { style: F('GARAGE', 'RAIL'), bay: 7.5, color: col, seed };
  const runs = rectRuns(x0, zb, x1, zf), side = k.h(3) < 0.5 ? -1 : 1, sw = 4.6;
  const body = mass(k, runs, 0, [{ h: G, spec: (r) => (r.cls === 'front' ? ground : { style: F('GARAGE', 'SPANDREL'), bay: 7.5, color: col, seed }) }, { h: (floors - 1) * G_FLOOR, storey: G_FLOOR, spec: deck }], { parapet: 1.1, color: col, seed, roofKind: 3, roof: [0.33, 0.33, 0.34], parapetStyle: F('BLANK', 'CONCRETE') });
  const ry = body.roofY;
  // stair and lift tower on the street corner, taller than the decks, with a slot of glass block
  const sx0 = side < 0 ? x0 - 0.3 : x1 - sw + 0.3, tower = mass(k, rectRuns(sx0, zf - sw, sx0 + sw, zf + 0.5), 0, [{ h: ry + 3.6, storey: ry + 3.6, spec: (r) => (r.cls === 'front' ? { style: F('DECO', 'GLASS_BLOCK'), bays: 1, color: col, seed } : { style: F('BLANK', 'CONCRETE', true), bay: 4, color: col, seed }) }], { roof: [0.5, 0.5, 0.5], roofKind: 3, collide: false });
  k.collide(sx0, ry, zf - sw, sx0 + sw, tower.roofY, zf + 0.5);
  if (!k.far) k.stucco(trim, 60).occ(1).box(sx0 - 0.1, tower.roofY, zf - sw - 0.1, sx0 + sw + 0.1, tower.roofY + 0.25, zf + 0.6, 'xXzZYy');
  k.at(sx0 + sw / 2, 0, zf + 0.5, 0, () => { doorway(k, 0, 0, 1.6, 2.15, { metal: true }); wallSign(k, 'parking', lot.seed >>> 3, 0, ry + 1.8, { height: 1.5, maxWidth: sw - 0.8, lit: S.signLit, far: true, z: 0.04 }); });
  // the way in: a dark mouth with a height bar and a lit sign over it
  const ex = side < 0 ? x1 - 9 : x0 + 9;
  k.at(ex, 0, zf, 0, () => {
    if (!k.far) { k.glass([0.01, 0.01, 0.012], 0.6).occ(0.6).box(-3.3, 0.02, 0, 3.3, 2.5, 0.03, 'Z'); k.concrete(col, 0, 60).occ(1).box(-3.6, 0, 0, -3.3, 2.75, 0.25, 'xXZ').box(3.3, 0, 0, 3.6, 2.75, 0.25, 'xXZ').box(-3.6, 2.5, 0, 3.6, 2.75, 0.25, 'ZYy');
      k.steel([0.85, 0.7, 0.1], 0.5, 40).box(-3.2, 2.1, 0.5, 3.2, 2.22, 0.56, 'xXzZYy'); k.box(-0.2, 0.9, 0.47, 3.0, 1.0, 0.53, 'xXzZYy'); k.steel(STEEL, 0.5, 40).box(-0.2, 0, 0.25, 0.2, 1.1, 0.75, 'xXzZY'); }
    wallSign(k, 'parking', (lot.seed >>> 3) + 1, 0, 2.75 + 0.45, { height: 0.6, maxWidth: 5, lit: S.signLit, z: 0.27 });
    k.lamp(-1.6, 2.5, 0.12, [0.9, 0.95, 1], { power: 20, radius: 7, radiance: 10, glow: 0.4 }); k.lamp(1.6, 2.5, 0.12, [0.9, 0.95, 1], { power: 20, radius: 7, radiance: 10, glow: 0.4 });
  });
  k.collide(ex - 0.2, 0, zf + 0.25, ex + 0.2, 1.1, zf + 0.75);
  if (variant === 2) k.onRun(runs.find((r) => r.cls === 'front'), (len) => { const a = side < 0 ? sw + 0.5 : 0.5, b = side < 0 ? len - 13 : len - sw - 0.5, n = Math.max(1, Math.round((b - a) / 6)); if (b - a > 5) { canopy(k, a, b, 3.2, 1.4, { th: 0.2, lip: trim }); for (let i = 0; i < n; i++) wallSign(k, ['shop', 'cafe', 'market', 'pharmacy'][Math.floor(k.h(30 + i) * 4)], (lot.seed >>> 3) + i * 3, a + (i + 0.5) * (b - a) / n, 3.75, { height: 0.5, maxWidth: (b - a) / n - 1, lit: S.signLit }); } });
  // top deck: ramp housing, light poles, painted bays
  if (!k.far) {
    k.concrete(col, 0, 70).occ(1).box(-side * 2 - 3, ry, zb + 3, -side * 2 + 3, ry + 2.6, zb + 9, 'xXzZY');
    for (let i = 0; i < 3; i++) { const lx = x0 + (x1 - x0) * (i + 0.5) / 3; k.steel(STEEL, 0.5, 40).cyl(lx, ry, 0, 0.07, ry + 6, { cap: false, segs: 5 }); k.box(lx - 0.5, ry + 6, -0.12, lx + 0.5, ry + 6.1, 0.12, 'xXzZY'); k.lamp(lx - 0.35, ry + 6, 0, [1, 0.74, 0.42], { power: 60, radius: 14, radiance: 16, glow: 0.8 }); k.lamp(lx + 0.35, ry + 6, 0, [1, 0.74, 0.42], { power: 60, radius: 14, radiance: 16, glow: 0.8 }); }
    if (k.near) { bayLines(k, x0 + 1.5, x1 - 1.5, zf - 6.2, zf - 1.2, 2.7, { y: ry + 0.02 }); bayLines(k, x0 + 1.5, x1 - 1.5, zb + 10, zb + 15, 2.7, { y: ry + 0.02 }); }
  }
  return { S, variant, body };
}
