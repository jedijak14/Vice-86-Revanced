// Deco apartment blocks and deco shop blocks: the plainer neighbours of the hotels (design/brief/architecture.md
// sections 6 and 7). Same vocabulary, less of it: eyebrows, stripes, a glass-block stair light, portholes by the door.

import { CHANNEL } from '../../core/ids.js';
import { clamp } from '../../core/math.js';
import { rectRuns, namedRuns, shade, mixColor } from './kit.js';
import { scheme } from './palette.js';
import { F, WHITE, mass, eyebrows, canopy, awning, steps, doorway, roofPlant, bladeSign, wallSign, windowUnits, bySide, balcony, flight } from './parts.js';

const FLOOR = 3.0;

// ------------------------------------------------------------------------------------------------ apartment
/**
 * Deco apartment block. Variants: 0 symmetrical block with a projecting stair bay, 1 U-shaped court open to the
 * street, 2 streamline block with two rounded front corners, 3 gallery-access block with an outside stair.
 */
export function decoApartment(k, lot) {
  const S = scheme(lot.seed ^ 0x51, 'deco', lot.style), W = lot.width, D = lot.depth, att = lot.attached ?? {}, floors = clamp(lot.floors | 0, 2, 4);
  let variant = lot.variant ?? (W >= 19 && k.h(1) < 0.4 ? 1 : k.h(1) < 0.55 ? 0 : k.h(1) < 0.8 ? 2 : 3);
  variant = ((variant % 4) + 4) % 4; if (variant === 3 && floors > 2 && lot.variant == null) variant = 0;
  const x0 = -W / 2 + (att.left ? 0 : 1.0), x1 = W / 2 - (att.right ? 0 : 1.0), zf = D / 2 - 3.0, zb = Math.max(-D / 2 + (att.back ? 0 : 2.5), zf - 28), Wb = x1 - x0;
  const P = 0.5, roofY = P + floors * FLOOR, wall = S.wall, trim = S.trimC, seed = S.seedByte, stripes = k.h(2) < 0.45, PAR = 0.8;
  const party = { style: F('BLANK', 'STUCCO'), bay: 4, color: shade(wall, 0.96), seed };
  const side = { style: F('DECO', 'SIDE', stripes), bay: 3.0, color: wall, seed }, back = { style: F('BLANK', 'SERVICE'), bay: 3.2, color: shade(wall, 0.95), seed };
  const plinth = { style: F('BLANK', 'STUCCO'), bay: 4, color: shade(wall, 0.86), seed };
  const win = { style: F('DECO', 'CASEMENT', stripes), bay: 2.9, color: wall, seed };
  const bands = (spec) => [{ h: P, storey: 1, spec: bySide({ default: plinth }, att, party) }, { h: floors * FLOOR, storey: FLOOR, grounded: false, spec }];
  const brow = { proj: 0.55, color: WHITE, lip: k.h(3) < 0.6 ? trim : WHITE, perBay: true };
  const lampCol = [1, 0.85, 0.62];
  let body, doorX = 0, doorZ = zf, sideDoor = false;

  if (variant === 0) {
    const cw = clamp(Wb * 0.24, 2.8, 4.2), p = 0.45, a = -cw / 2 + (x0 + x1) / 2, b = a + cw;
    const runs = namedRuns([[x0, zf], [a, zf], [a, zf + p], [b, zf + p], [b, zf], [x1, zf], [x1, zb], [x0, zb]], ['wingL', 'jogL', 'centre', 'jogR', 'wingR', 'right', 'back', 'left']);
    const plain = { style: F('DECO', 'PLAIN'), bays: 1, color: wall, seed };
    body = mass(k, runs, 0, bands(bySide({ wingL: win, wingR: win, centre: { style: F('DECO', 'GLASS_BLOCK'), bays: 1, color: wall, seed }, jogL: plain, jogR: plain, back, default: side }, att, party)), { parapet: PAR, color: wall, seed, coping: WHITE, skipParapet: ['centre', 'jogL', 'jogR'] });
    eyebrows(k, body.info[1], runs.filter((r) => r.cls === 'wingL' || r.cls === 'wingR'), brow);
    const rise = 1.0 + k.h(4) * 0.8;
    mass(k, rectRuns(a, zf + p - 2.4, b, zf + p), roofY, [{ h: PAR + rise, storey: PAR + rise, grounded: false, spec: { style: F('BLANK', 'STUCCO', true), bay: 4, color: wall, seed } }], { roof: shade(wall, 0.7), roofKind: 3, collide: false });
    if (!k.far) k.stucco(trim, 60).occ(1).box(a - 0.06, roofY + PAR + rise, zf + p - 2.46, b + 0.06, roofY + PAR + rise + 0.12, zf + p + 0.06, 'xXzZYy');
    doorX = (a + b) / 2; doorZ = zf + p;
    // the door stands in the glass-block bay: a solid surround and a small rounded canopy mark it
    k.at(doorX, 0, doorZ, 0, () => {
      if (!k.far) k.stucco(wall, 60).occ(1).box(-cw / 2 + 0.25, P, 0, cw / 2 - 0.25, P + 2.75, 0.06, 'xXZY');
      canopy(k, -cw / 2 - 0.3, cw / 2 + 0.3, P + 2.55, 1.5, { r: 0.7, th: 0.18, lip: trim, lamps: 1, lampPower: 24 });
    });
  } else if (variant === 1) {
    // U court: two wings and a back range; the court is open to the street
    const cw = clamp(Wb * 0.3, 4.5, 7.5), cd = clamp((zf - zb) * 0.55, 6, 13), a = (x0 + x1) / 2 - cw / 2, b = a + cw, zc = zf - cd;
    const runs = namedRuns([[x0, zf], [a, zf], [a, zc], [b, zc], [b, zf], [x1, zf], [x1, zb], [x0, zb]], ['wingL', 'courtL', 'court', 'courtR', 'wingR', 'right', 'back', 'left']);
    const cs = { style: F('DECO', 'SIDE', stripes), bay: 3.2, color: wall, seed };
    body = mass(k, runs, 0, bands(bySide({ wingL: win, wingR: win, court: { style: F('DECO', 'CASEMENT'), bay: 2.4, color: wall, seed }, courtL: cs, courtR: cs, back, default: side }, att, party)), { parapet: PAR, color: wall, seed, coping: WHITE });
    eyebrows(k, body.info[1], runs.filter((r) => r.cls === 'wingL' || r.cls === 'wingR'), brow);
    eyebrows(k, body.info[1], [runs.find((r) => r.cls === 'court')], { ...brow, perBay: false, proj: 0.45 });
    doorX = (a + b) / 2; doorZ = zc;
    // court gate: two piers and a low wall, a lamp on each pier
    if (!k.far) for (const s of [-1, 1]) { const px = doorX + s * 1.1; k.stucco(wall, 80).occ(1).box(px - 0.25, 0, zf - 0.5, px + 0.25, 1.9, zf); k.stucco(trim, 60).box(px - 0.3, 1.9, zf - 0.55, px + 0.3, 2.0, zf + 0.05, 'xXzZYy'); k.stucco(wall, 80).box(s < 0 ? a : px + 0.25, 0, zf - 0.38, s < 0 ? px - 0.25 : b, 0.9, zf - 0.12); k.lamp(px, 2.32, zf - 0.25, lampCol, { power: 14, radius: 6, radiance: 8, glow: 0.35, size: 0.1 }); }
    for (const s of [-1, 1]) k.collide(s < 0 ? a : doorX + 0.85, 0, zf - 0.5, s < 0 ? doorX - 0.85 : b, 0.9, zf);
    k.at(doorX, 0, doorZ, 0, () => canopy(k, -1.4, 1.4, P + 2.5, 1.2, { r: 0.5, th: 0.16, lip: trim, lamps: 1, lampPower: 24 }));
  } else if (variant === 2) {
    const rad = clamp(Wb * 0.14, 1.6, 2.4), runs = rectRuns(x0, zb, x1, zf, [att.left ? 0 : rad, att.right ? 0 : rad, 0, 0], k.arc);
    const wrap = { style: F('DECO', 'WRAP', true), bays: 3, color: wall, seed }, rib = { style: F('DECO', 'RIBBON', true), bay: 3.3, color: wall, seed };
    body = mass(k, runs, 0, bands(bySide({ front: rib, fl: wrap, fr: wrap, back, default: side }, att, party)), { parapet: PAR, color: wall, seed, coping: trim });
    const path = ['left', 'fl', 'front', 'fr', 'right'].map((c) => runs.find((r) => r.cls === c)).filter((r) => r && (r.cls === 'front' || r.curved));
    eyebrows(k, body.info[1], path, { proj: 0.6, color: WHITE, lip: trim });
    doorX = (x0 + x1) / 2;
    k.at(doorX, 0, zf, 0, () => {
      // a plain entrance panel through the ribbon windows, with a porthole each side of the door
      if (!k.far) { k.stucco(wall, 60).occ(1).box(-1.6, P, 0, 1.6, P + FLOOR + 0.2, 0.08, 'xXZY'); if (k.near) for (const s of [-1, 1]) { k.at(s * 1.15, P + 1.75, 0.08, 0, () => { k.stucco(trim, 50); const n = 14, ring = []; for (let i = 0; i < n; i++) { const an = i / n * Math.PI * 2; ring.push([Math.sin(an) * 0.3, Math.cos(an) * 0.3, 0.02]); } k.pipe(ring, 0.035, 4, true); k.glass([0.1, 0.14, 0.16]).box(-0.21, -0.21, 0, 0.21, 0.21, 0.012, 'Z'); }); } }
      canopy(k, -1.9, 1.9, P + 2.55, 1.6, { r: 0.8, th: 0.18, lip: trim, neon: S.lit && k.h(6) < 0.35 ? S.neon : null, lamps: 1, lampPower: 24 });
    });
  } else {
    // gallery access: doors on an open walkway along one side, reached by a stair at the street end
    const sideL = k.h(5) < 0.5, gw = 1.5, bx0 = sideL ? x0 + gw : x0, bx1 = sideL ? x1 : x1 - gw;
    const runs = rectRuns(bx0, zb, bx1, zf - 0), gal = { style: F('LOWRISE', 'MOTEL'), bay: 3.9, color: wall, seed };
    body = mass(k, runs, 0, bands(bySide({ front: win, back, [sideL ? 'left' : 'right']: gal, default: side }, att, party)), { parapet: PAR, color: wall, seed, coping: WHITE });
    eyebrows(k, body.info[1], [runs.find((r) => r.cls === 'front')], brow);
    const gr = runs.find((r) => r.cls === (sideL ? 'left' : 'right'));
    k.onRun(gr, (len) => {
      for (let f = 1; f < floors; f++) { const y = P + f * FLOOR; balcony(k, 0.2, len - 2.6, y, gw - 0.1, { guard: 'rail', color: WHITE, rail: k.h(7) < 0.5 ? trim : WHITE, post: 1.9 }); }
      if (!k.far) { k.stucco(WHITE, 70).occ(1).box(0, roofY - 0.05, 0, len, roofY + 0.12, gw + 0.2, 'xXZYy'); for (let i = 0; i <= Math.round(len / 3.9); i++) { const px = Math.min(len - 0.15, 0.2 + i * 3.9); k.steel(WHITE, 0.5, 30).box(px - 0.05, P, gw - 0.2, px + 0.05, roofY - 0.05, gw - 0.1, 'xXzZ'); } }
      // a bulkhead lamp under each walkway soffit, at the stair head
      for (let f = 1; f <= floors; f++) k.lamp(len - 5.2, P + f * FLOOR - 0.06, gw * 0.5, lampCol, { power: 16, radius: 6, radiance: 8, glow: 0.35, size: 0.09 });
      // the stair runs along the walkway at the street end, flight by flight
      for (let f = 1; f < floors; f++) flight(k, len - 0.2, len - 4.2, 0.25, gw - 0.15, P + (f - 1) * FLOOR + (f === 1 ? -P : 0), P + f * FLOOR, { rail: WHITE });
    });
    sideDoor = true;
  }
  if (!sideDoor) { k.at(doorX, 0, doorZ, 0, () => { steps(k, -1.3, 1.3, 0.06, P, { n: 2, tread: 0.32, color: [0.74, 0.72, 0.68] }); doorway(k, 0, P, 1.5, 2.15, { metal: false, frame: mixColor(trim, WHITE, 0.3) }); }); k.collide(doorX - 1.3, 0, doorZ, doorX + 1.3, P, doorZ + 0.7); }
  const up = body.info[1];
  windowUnits(k, up, ['left', 'right', 'courtL', 'courtR'], 0.3);
  windowUnits(k, up, ['wingL', 'wingR', 'front', 'court'], S.age >= 2 ? 0.28 : 0.12);
  roofPlant(k, x0 + 0.6, zb + 0.6, x1 - 0.6, Math.min(zf - 0.6, zb + 14), roofY, { tank: k.h(30) < 0.2, color: shade(wall, 0.92), units: 2 });
  // On the neon strips an apartment house is let by the week like the hotels beside it and dresses as they do, more
  // quietly: one tube under the coping of its street front and its name lit over the door. Elsewhere the name, where
  // there is one, is small painted lettering.
  const dressed = S.lit && k.h(33) < 0.7;
  if (dressed && !k.far) for (const e of up.runs) if (e.n > 0 && !e.run.curved && ['wingL', 'wingR', 'front'].includes(e.run.cls))
    k.onRun(e.run, (len) => k.neon([[0.2, roofY + PAR - 0.15, 0.04], [len - 0.2, roofY + PAR - 0.15, 0.04]], S.neon, { back: [0, 0, -1], radiance: 14 }));
  if (!sideDoor && (dressed || k.h(31) < 0.5)) k.at(doorX, 0, doorZ, 0, () => wallSign(k, 'hotel', lot.seed >>> 4, 0, P + (dressed ? 3.35 : 3.25), { height: dressed ? 0.48 : 0.32, maxWidth: dressed ? 3.6 : 3, lit: dressed && S.signLit, neon: dressed ? S.neonAccent : null, z: 0.09 }));
  return { S, body, variant };
}

// ------------------------------------------------------------------------------------------------ shops
/**
 * Deco shop block on the pavement. Variants: 0 one-storey shops, each unit with its own stepped parapet and awning;
 * 1 two-storey block with a streamline upper floor over a continuous canopy (rounded on corner lots);
 * 2 cinema with a marquee, a tall blank front and a blade sign.
 */
export function decoShop(k, lot) {
  const S = scheme(lot.seed ^ 0x77, 'deco', lot.style), W = lot.width, D = lot.depth, att = lot.attached ?? {}, corner = lot.corner | 0;
  let variant = lot.variant ?? (lot.floors >= 2 ? (W >= 15 && k.h(1) < 0.22 ? 2 : 1) : (W >= 15 && k.h(1) < 0.12 ? 2 : 0));
  variant = ((variant % 3) + 3) % 3;
  const x0 = -W / 2 + (att.left ? 0 : 0.15), x1 = W / 2 - (att.right ? 0 : 0.15), zf = D / 2 - 1.5, zb = -D / 2 + (att.back ? 0 : 1.5), Wb = x1 - x0;
  const wall = S.wall, trim = S.trimC, seed = S.seedByte, G = 4.0;
  const party = { style: F('BLANK', 'STUCCO'), bay: 4, color: shade(wall, 0.95), seed };
  const service = { style: F('SHOPFRONT', 'SERVICE'), bay: 5, color: shade(wall, 0.93), seed }, sideG = { style: F('BLANK', 'STUCCO'), bay: 4, color: wall, seed };
  const units = Math.max(1, Math.round(Wb / 6.2)), uw = Wb / units;
  const shop = (flag) => ({ style: F('SHOPFRONT', 'RETAIL', flag), bays: units, color: wall, seed, occ: [1, 0.8] });
  let body;
  const unitSigns = (y, z, lit) => { for (let i = 0; i < units; i++) k.at(x0 + (i + 0.5) * uw, 0, z, 0, () => wallSign(k, ['shop', 'cafe', 'bar', 'pharmacy', 'market', 'shop'][Math.floor(k.h(40 + i) * 6)], (lot.seed >>> 2) + i * 13, 0, y, { height: 0.62, maxWidth: uw - 1.0, lit: lit && k.h(50 + i) < 0.7, neon: S.lit && k.h(60 + i) < 0.35 ? S.neonAccent : null })); };

  if (variant === 0) {
    const sideStreet = corner === 1 ? 'left' : corner === 2 ? 'right' : null, tile = k.h(2) < 0.6;
    const runs = rectRuns(x0, zb, x1, zf);
    body = mass(k, runs, 0, [{ h: G, spec: bySide({ front: shop(tile), back: service, [sideStreet ?? 'none']: { style: F('SHOPFRONT', 'RETAIL', tile), bay: 6, color: wall, seed }, default: sideG }, att, party) }], { parapet: 0.6, color: wall, seed, coping: WHITE, skipParapet: ['front'] });
    // each shop raises its own parapet: a stepped panel, taller in the middle of the unit, some with a fin
    for (let i = 0; i < units; i++) {
      const a = x0 + i * uw, b = a + uw, kind = Math.floor(k.h(10 + i) * 4), hgt = 0.9 + k.h(20 + i) * 0.9, col = k.h(30 + i) < 0.3 ? mixColor(wall, trim, 0.75) : wall;
      const pspec = { style: F('BLANK', 'STUCCO', kind === 1), bay: 4, color: col, seed };
      mass(k, rectRuns(a, zf - 0.5, b, zf), G, [{ h: hgt, storey: Math.max(1, hgt), grounded: false, spec: pspec }], { roof: shade(col, 0.75), roofKind: 3, collide: false });
      if (kind >= 2 && !k.far) { const cw = uw * 0.5; mass(k, rectRuns(a + (uw - cw) / 2, zf - 0.5, b - (uw - cw) / 2, zf + 0.02), G + hgt, [{ h: 0.6, storey: 1, grounded: false, spec: pspec }], { roof: shade(col, 0.75), roofKind: 3, collide: false }); }
      if (kind === 3 && !k.far) { k.stucco(trim, 60).occ(1).box(a + uw / 2 - 0.1, G - 0.6, zf, a + uw / 2 + 0.1, G + hgt + 1.5, zf + 0.45, 'xXzZYy'); if (S.lit) k.neon([[a + uw / 2, G - 0.5, zf + 0.485], [a + uw / 2, G + hgt + 1.4, zf + 0.485]], S.neon, { back: [0, 0, -1], lights: i % 2 === 0 }); }
      if (!k.far) k.stucco(k.h(35 + i) < 0.5 ? trim : WHITE, 60).occ(1).box(a + 0.02, G + hgt, zf - 0.52, b - 0.02, G + hgt + 0.1, zf + 0.05, 'xXzZYy');
      if (k.h(70 + i) < 0.62) k.at(a, 0, zf, 0, () => awning(k, 0.45, uw - 0.45, 3.05, { proj: 1.25, drop: 0.6, color: k.h(80 + i) < 0.5 ? S.awning : shade(trim, 0.85), pattern: S.awningStripe ? 1 : 0 }));
    }
    unitSigns(3.5, zf + 0.03, true);
  } else if (variant === 1) {
    const rad = corner ? clamp(Wb * 0.14, 1.8, 2.8) : 0, U = 3.0, upN = 1, cs = corner === 1 ? 'left' : 'right', arc = corner === 1 ? 'fl' : 'fr';
    const runs = rectRuns(x0, zb, x1, zf, corner === 1 ? [rad, 0, 0, 0] : [0, rad, 0, 0], k.arc);
    const rib = { style: F('DECO', 'RIBBON', true), bay: 3.3, color: wall, seed }, wrap = { style: F('DECO', 'WRAP', true), bays: 3, color: wall, seed }, sideU = { style: F('DECO', 'SIDE'), bay: 3.1, color: wall, seed };
    const gmap = { front: shop(true), back: service, default: sideG }, umap = { front: rib, back: { style: F('BLANK', 'SERVICE'), bay: 3.2, color: shade(wall, 0.95), seed }, default: sideU };
    if (corner) { gmap[cs] = { style: F('SHOPFRONT', 'RETAIL', true), bay: 6, color: wall, seed }; gmap[arc] = { style: F('SHOPFRONT', 'LOBBY', true), bays: 1, color: wall, seed }; umap[cs] = rib; umap[arc] = wrap; }
    body = mass(k, runs, 0, [{ h: G, spec: bySide(gmap, att, party) }, { h: upN * U, storey: U, spec: bySide(umap, att, party) }], { parapet: 0.9, color: wall, seed, coping: trim });
    const order = corner === 1 ? ['left', 'fl', 'front'] : corner === 2 ? ['front', 'fr', 'right'] : ['front'], path = order.map((c) => runs.find((r) => r.cls === c)).filter(Boolean);
    eyebrows(k, body.info[1], path, { proj: 0.6, color: WHITE, lip: trim, neon: S.lit && k.h(9) < 0.3 ? S.neon : null });
    // continuous canopy over the pavement, following the corner
    if (!k.far) { k.stucco(WHITE, 70).occ(1).ledge(path, 3.25, 3.55, 1.3, { lip: k.h(3) < 0.5 ? trim : WHITE, under: 0.45 }); if (S.lit) for (const r of path) if (!r.curved) k.onRun(r, (len) => k.neon([[0.2, 3.33, 1.335], [len - 0.2, 3.33, 1.335]], S.neonAccent, { back: [0, 0, -1] })); }
    unitSigns(3.78, zf + 0.03, true);
    if (k.h(4) < 0.5) k.onRun(runs.find((r) => r.cls === 'front'), (len) => bladeSign(k, corner === 1 ? len - 1.2 : 1.2, G + 0.5, G + U + 1.6, 0, { category: 'hotel-blade', variant: lot.seed >>> 5, color: mixColor(trim, [0.1, 0.1, 0.16], 0.5), neon: S.lit ? S.neon : null, lit: S.signLit, proj: 1.1 }));
  } else {
    // cinema: lobby front under a marquee, a tall auditorium wall above with stepped piers, the name on a blade
    const H = 9.5 + k.h(2) * 2, runs = rectRuns(x0, zb, x1, zf), cx = (x0 + x1) / 2, mw = Math.min(Wb - 1.5, 11), col = k.h(3) < 0.5 ? wall : mixColor(wall, trim, 0.25);
    const upS = { style: F('DECO', 'FLUTED'), bay: 4, color: col, seed }, blank = { style: F('BLANK', 'STUCCO', true), bay: 4, color: col, seed };
    body = mass(k, runs, 0, [{ h: G, spec: bySide({ front: { style: F('SHOPFRONT', 'LOBBY', true), bay: 3.2, color: wall, seed, occ: [0.9, 0.6] }, back: service, default: sideG }, att, party) }, { h: H - G, storey: H - G, spec: bySide({ front: upS, default: blank }, att, party) }], { parapet: 0.8, color: col, seed, coping: trim });
    for (const s of [-1, 1]) { const px = cx + s * (mw / 2 + 0.2); if (!k.far) k.stucco(trim, 60).occ(1).box(px - 0.35, G, zf, px + 0.35, H + 1.6, zf + 0.3, 'xXzZYy').box(px - 0.2, H + 1.6, zf, px + 0.2, H + 2.4, zf + 0.3, 'xXzZYy'); }
    // the marquee: a wedge-fronted box with a lit sign face on each slope and bulbs under it
    const my = 3.3, mh = 1.25, md = 1.35;
    k.at(cx, 0, zf, 0, () => {
      if (!k.far) {
        k.steel(shade(trim, 0.8), 0.45, 30).occ(1).box(-mw / 2, my, 0, mw / 2, my + mh, md, 'xXZY'); k.occ(0.5).box(-mw / 2, my, 0, mw / 2, my + mh, md, 'y').occ(1);
        k.sign('cinema', lot.seed >>> 2, 0, my + mh / 2, md + 0.02, { height: mh - 0.3, maxWidth: mw - 0.6, lit: S.signLit });
        if (k.near) { k.neon([[-mw / 2 - 0.03, my + 0.08, md + 0.04], [mw / 2 + 0.03, my + 0.08, md + 0.04]], S.neon, { back: [0, 0, -1] }); k.neon([[-mw / 2 - 0.03, my + mh - 0.08, md + 0.04], [mw / 2 + 0.03, my + mh - 0.08, md + 0.04]], S.neonAccent, { back: [0, 0, -1], lights: false }); }
        const n = Math.max(3, Math.round(mw / 1.6)); for (let i = 0; i < n; i++) k.lamp(-mw / 2 + mw * (i + 0.5) / n, my, md * 0.55, [1, 0.8, 0.5], { power: 16, radius: 6, radiance: 14, glow: 0.3, size: 0.07, channel: CHANNEL.NEON });
      }
      doorway(k, 0, 0, 3.4, 2.3, { leaves: 4 });
      if (k.near) { k.stucco(wall, 60).occ(1).box(-0.9 - 3.2, 0, 0, -3.2 + 0.9, 2.6, 0.9, 'xXZY'); k.glass([0.15, 0.2, 0.22]).box(-3.9, 1.0, 0.9, -2.5, 2.1, 0.92, 'Z'); }
      for (const s of [-1, 1]) wallSign(k, 'poster', (lot.seed >>> 6) + s, s * (mw / 2 - 0.2 + 1.2 > Wb / 2 - 0.4 ? mw / 2 - 0.9 : mw / 2 + 0.9), 1.9, { height: 1.5, lit: S.signLit, z: 0.05 });
    });
    k.onRun(runs.find((r) => r.cls === 'front'), (len) => bladeSign(k, len / 2, my + mh + 0.4, H + 2.2, 0, { category: 'hotel-blade', variant: lot.seed >>> 5, color: mixColor(trim, [0.08, 0.08, 0.14], 0.6), neon: S.neon, lit: S.signLit, proj: 1.3, flicker: S.flicker }));
    k.collide(cx - 4.1, 0, zf, cx - 2.3, 2.6, zf + 0.9);
  }
  roofPlant(k, x0 + 0.5, zb + 0.5, x1 - 0.5, zf - 1.2, body.roofY, { units: Math.max(2, units), color: shade(wall, 0.9), aerial: false });
  return { S, body, variant };
}
