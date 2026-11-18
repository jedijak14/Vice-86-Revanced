// Streamline and tropical deco: the ocean-front hotels, their plainer apartment neighbours and the deco shop blocks.
//
// Proportions follow design/brief/architecture.md sections 4 to 9: a 15 m lot gives a 14 m front of three storeys,
// wings with a parapet near 11 m, a centre division a fifth to a third of the width that rises at least 1.5 m higher,
// a raised terrazzo porch about 4 m deep, eyebrows over the windows, racing stripes in the spandrels, walls mostly
// white or cream with the colour in trim, and neon on the name, the vertical element and the porch fascia first.

import { CHANNEL } from '../../core/ids.js';
import { clamp } from '../../core/math.js';
import { rectRuns, namedRuns, shade, mixColor } from './kit.js';
import { scheme } from './palette.js';
import { F, WHITE, mass, eyebrows, canopy, steps, column, doorway, roofPlant, bladeSign, roofSign, wallSign, windowUnits } from './parts.js';

const PLINTH = 0.6, LOBBY = 3.4, UPPER = 3.0, PARAPET = 0.9;
const TERRAZZO = [0.80, 0.76, 0.70];

/**
 * Plan of a block with a projecting centre division and short returns on the sides.
 * Classes: wingL, jogL, centre, jogR, wingR, rret (first metres of the right side), right, back, left, lret.
 */
function tripartite(x0, x1, zb, zf, a, b, p, retL, retR) {
  const pts = [], cls = [], add = (x, z, c) => { pts.push([x, z]); cls.push(c); }, sideL = zf - zb;
  if (a - x0 > 0.3) add(x0, zf, 'wingL');
  add(a, zf, 'jogL'); add(a, zf + p, 'centre'); add(b, zf + p, 'jogR');
  if (x1 - b > 0.3) { add(b, zf, 'wingR'); }
  if (retR >= sideL - 0.5) add(x1, zf, 'rret'); else { add(x1, zf, 'rret'); add(x1, zf - retR, 'right'); }
  add(x1, zb, 'back');
  if (retL >= sideL - 0.5) add(x0, zb, 'lret'); else { add(x0, zb, 'left'); add(x0, zf - retL, 'lret'); }
  return namedRuns(pts, cls);
}

/** Stepped top on a rectangle: each step is narrower and shallower than the one below. Returns the top height. */
function ziggurat(k, x0, x1, z0, z1, y, stepsH, spec, o = {}) {
  let a = x0, b = x1, zb = z0;
  for (let i = 0; i < stepsH.length; i++) {
    const ins = (x1 - x0) * (o.inset ?? 0.16); a += ins; b -= ins; zb += (z1 - z0) * 0.12;
    if (b - a < 0.5) break;
    if (k.far && i > 0) break;
    mass(k, rectRuns(a, zb, b, z1 + (o.flush ? 0 : 0)), y, [{ h: stepsH[i], storey: Math.max(1, stepsH[i]), grounded: false, spec }], { roof: o.roof ?? shade(spec.color, 0.8), roofKind: 3, collide: false });
    y += stepsH[i];
  }
  return y;
}

/** The raised porch of a hotel: terrazzo platform, steps on the axis, low walls, and one of three kinds of cover. */
function porch(k, S, o) {
  const { x0, x1, zf, zEdge, cx, sw, kind, wall, nameY } = o, zp = zEdge - 1.15, H = PLINTH;
  k.tile(TERRAZZO, 60, 2).occ(1).box(x0, 0, zf - 0.02, x1, H, zp, 'xXZY');
  k.collide(x0, 0, zf, x1, H, zp);
  const sx0 = cx - sw / 2, sx1 = cx + sw / 2;
  steps(k, sx0, sx1, zp, H, { n: 3, tread: 0.32, color: TERRAZZO });
  // low walls at the porch edge, cheeks beside the steps
  if (!k.far) {
    k.stucco(wall, 70).occ(1);
    for (const [a, b] of [[x0, sx0 - 0.3], [sx1 + 0.3, x1]]) if (b - a > 0.6) { k.box(a, H, zp - 0.22, b, H + 0.78, zp, 'xXzZ'); k.stucco(S.trimC, 60).box(a - 0.02, H + 0.78, zp - 0.26, b + 0.02, H + 0.86, zp + 0.04, 'xXzZYy'); k.stucco(wall, 70); }
    for (const sxx of [sx0 - 0.3, sx1]) { k.box(sxx, 0, zp - 0.22, sxx + 0.3, H + 0.86, zp + 1.0, 'xXzZY'); }
  }
  for (const [a, b] of [[x0, sx0 - 0.3], [sx1 + 0.3, x1]]) if (b - a > 0.6) k.collide(a, H, zp - 0.22, b, H + 0.8, zp);
  const yR = H + 2.9, fasciaTop = H + LOBBY;
  let signY = null, signZ = null;
  if (kind === 0) {                                               // flat roof on columns across the whole front
    const zc = zp - 0.3, xs = [];
    for (const s of [-1, 1]) { let x = cx + s * (sw / 2 + 0.25); const end = s < 0 ? x0 + 0.3 : x1 - 0.3; const n = Math.max(1, Math.round(Math.abs(end - x) / 3.5)); for (let i = 0; i <= n; i++) xs.push(x + (end - x) * i / n); }
    for (const x of xs) { column(k, x, zc, H, yR, o.square ? 0.19 : 0.17, { square: o.square, color: wall, trim: S.trimC }); k.collide(x - 0.2, H, zc - 0.2, x + 0.2, yR, zc + 0.2); }
    if (!k.far) {
      k.stucco(WHITE, 70).occ(1).slab(rectRuns(x0 - 0.0, zf, x1 + 0.0, zp + 0.3, [0.3, 0.3, 0, 0], k.arc), yR, fasciaTop, { bottom: true, under: 0.42, lip: o.fascia, skip: ['back'] });
      if (S.lit && k.near) k.neon([[x0 + 0.3, yR + 0.08, zp + 0.335], [x1 - 0.3, yR + 0.08, zp + 0.335]], S.neonAccent, { back: [0, 0, -1] });
      if (S.lit && k.near && o.double) k.neon([[x0 + 0.3, fasciaTop - 0.08, zp + 0.335], [x1 - 0.3, fasciaTop - 0.08, zp + 0.335]], S.neon, { back: [0, 0, -1], lights: false });
      for (let i = 0; i < Math.max(2, Math.round((x1 - x0) / 5)); i++) k.lamp(x0 + (x1 - x0) * (i + 0.5) / Math.max(2, Math.round((x1 - x0) / 5)), yR, (zf + zp) / 2, [1, 0.84, 0.6], { power: 24, radius: 8, radiance: 8, glow: 0.4 });
    }
    signY = (yR + fasciaTop) / 2; signZ = zp + 0.3;
  } else if (kind === 1) {                                        // a rounded canopy over the steps only
    const cw = sw + 2.2, d = zp + 0.5 - zf;
    k.at(cx - cw / 2, 0, zf, 0, () => { canopy(k, 0, cw, yR, d, { r: Math.min(1.6, d * 0.45), th: 0.42, lip: o.fascia, neon: S.lit ? S.neonAccent : null, neonAt: 'bottom', lamps: 2 }); });
    for (const s of [-1, 1]) { const x = cx + s * (sw / 2 + 0.25); column(k, x, zp - 0.3, H, yR, 0.15, { color: wall, trim: S.trimC }); k.collide(x - 0.18, H, zp - 0.48, x + 0.18, yR, zp - 0.12); }
    signY = yR + 0.21; signZ = zp + 0.5;
  } else {                                                        // a thin cantilevered eyebrow the width of the front
    const d = 2.3;
    k.at(x0, 0, zf, 0, () => canopy(k, 0, x1 - x0, yR + 0.25, d, { r: 0.8, th: 0.2, lip: o.fascia, neon: S.lit ? S.neonAccent : null, neonAt: 'bottom', lamps: 3 }));
    signY = nameY; signZ = null;
  }
  return { yR, fasciaTop, signY, signZ, zp };
}

// ------------------------------------------------------------------------------------------------ hotel
/**
 * Streamline hotel. Variants: 0 stepped centre pylon with a fin, 1 rounded corner with a drum (corner lots), 2 three
 * fins, 3 sign pylon (inverted T), 4 off-centre stair tower with a blade sign, 5 tall slab with a stepped crown,
 * 6 corner tower with a spire (corner lots).
 */
export function decoHotel(k, lot) {
  const S = scheme(lot.seed, 'deco', lot.style), W = lot.width, D = lot.depth, att = lot.attached ?? {}, corner = lot.corner | 0;
  const floors = clamp(lot.floors | 0, 2, 7), upper = floors - 1;
  let variant = lot.variant;
  if (variant == null) {
    const r = k.h(1);
    if (floors >= 5) variant = 5; else if (corner) variant = r < 0.6 ? 1 : 6; else variant = r < 0.38 ? 0 : r < 0.55 ? 2 : r < 0.75 ? 3 : 4;
  }
  variant = ((variant % 7) + 7) % 7; if ((variant === 1 || variant === 6) && !corner && lot.variant == null) variant = 0;
  const cornerSide = corner === 1 ? -1 : 1;                       // which end the corner feature sits on (a mid-block lot forced to a corner variant uses +X)
  const x0 = -W / 2 + (att.left ? 0 : 0.6), x1 = W / 2 - (att.right ? 0 : 0.6), zEdge = D / 2 - 0.2, zf = zEdge - 4.9, zb = Math.max(-D / 2 + (att.back ? 0 : 2.2), zf - 30), Wb = x1 - x0;
  const yU = PLINTH + LOBBY, roofY = yU + upper * UPPER, wall = S.wall, trim = S.trimC, seed = S.seedByte;
  const stripes = k.h(2) < 0.62, winT = variant === 1 ? 'RIBBON' : (k.h(3) < 0.55 ? 'CASEMENT' : 'RIBBON'), bayT = winT === 'CASEMENT' ? 2.75 : 3.4;
  const fascia = k.h(4) < 0.5 ? trim : WHITE;
  const sideStyle = (r) => (att[r.cls === 'left' ? 'left' : 'right'] ? { style: F('BLANK', 'STUCCO'), bay: 4, color: shade(wall, 0.96), seed } : { style: F('DECO', 'SIDE', stripes), bay: 3.1, color: wall, seed, grounded: false });
  const backSpec = { style: F('BLANK', att.back ? 'STUCCO' : 'SERVICE'), bay: 3.4, color: shade(wall, 0.95), seed, grounded: false };
  const front = { style: F('DECO', winT, stripes), bay: bayT, color: wall, seed };
  const lobby = { style: F('SHOPFRONT', 'LOBBY'), bay: bayT + 0.6, color: wall, seed, grounded: true, occ: [0.8, 0.62] };
  const plinth = { style: F('BLANK', 'STUCCO'), bay: 4, color: shade(wall, 0.9), seed };
  let centreUp, centreLobby, runs, cx = 0, cw = 0, p = 0, body, eyePaths = [], frontClasses;

  if (variant === 1 || variant === 6) {
    // ---- corner buildings: the side street gets a full front
    const rad = variant === 1 ? clamp(Wb * 0.17, 2.2, 2.8) : 0;
    runs = rectRuns(x0, zb, x1, zf, cornerSide < 0 ? [rad, 0, 0, 0] : [0, rad, 0, 0], k.arc);
    const streetSide = cornerSide < 0 ? 'left' : 'right', arc = cornerSide < 0 ? 'fl' : 'fr';
    frontClasses = ['front', arc, streetSide];
    const spec = (kind) => (r) => {
      if (r.cls === 'front' || r.cls === streetSide) return kind === 'up' ? front : kind === 'lobby' ? (r.cls === 'front' ? lobby : { ...lobby, style: F('SHOPFRONT', 'CAFE'), occ: [1, 1] }) : plinth;
      if (r.cls === arc) return kind === 'up' ? { style: F('DECO', 'WRAP', stripes), color: wall, seed, facetBays: true, bays: 3 } : kind === 'lobby' ? { style: F('DECO', 'WRAP'), color: wall, seed, bays: 3, grounded: true } : plinth;
      if (r.cls === 'back') return kind === 'plinth' ? plinth : backSpec;
      return kind === 'plinth' ? plinth : sideStyle(r);
    };
    const bands = k.far ? [{ h: PLINTH + LOBBY, storey: 4, spec: spec('lobby') }, { h: upper * UPPER, storey: UPPER, spec: spec('up') }]
      : [{ h: PLINTH, storey: 1, spec: spec('plinth') }, { h: LOBBY, spec: spec('lobby') }, { h: upper * UPPER, storey: UPPER, spec: spec('up') }];
    body = mass(k, runs, 0, bands, { parapet: PARAPET, color: wall, seed, coping: fascia });
    const up = body.info[body.info.length - 1];
    eyePaths = [(cornerSide < 0 ? ['left', 'fl', 'front'] : ['front', 'fr', 'right']).map((c) => runs.find((r) => r.cls === c)).filter(Boolean)];
    eyebrows(k, up, eyePaths[0], { proj: 0.7, color: WHITE, lip: trim, neon: S.lit && k.h(9) < 0.4 ? S.neon : null, perBay: winT === 'CASEMENT' && variant === 6 });
    const top = body.top;
    if (variant === 1) {                                         // drum over the round corner, ringed, with a needle
      const ox = cornerSide < 0 ? x0 + rad : x1 - rad, oz = zf - rad, rise = 1.6 + k.h(11) * 1.2, segs = k.near ? 16 : k.far ? 6 : 8;
      k.stucco(wall, 70).occ(1).cyl(ox, roofY, oz, rad + 0.02, top + rise, { segs });
      if (!k.far) { k.stucco(trim, 60); for (const f of [0.35, 0.65]) k.cyl(ox, top + rise * f - 0.09, oz, rad + 0.14, top + rise * f + 0.09, { segs, bottom: true }); k.stucco(WHITE, 60).cyl(ox, top + rise, oz, rad * 0.55, top + rise + 0.5, { segs }); }
      const nh = 3.2 + k.h(12) * 2;
      if (!k.far) { k.bare(1, 0.3).cyl(ox, top + rise + 0.5, oz, 0.07, top + rise + 0.5 + nh, { segs: 6, r1: 0.015 }); if (k.near) k.ball(ox, top + rise + 0.5 + nh * 0.3, oz, 0.2); }
      if (S.lit && !k.far) { const ring = []; for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; ring.push([ox + Math.sin(a) * (rad + 0.2), top + rise * 0.65, oz + Math.cos(a) * (rad + 0.2)]); } k.neon(ring, S.neon, { closed: true, back: [0, -1, 0], channel: S.flicker ? CHANNEL.FLICKER : CHANNEL.NEON, maxLights: 3 }); }
    } else {                                                     // square corner tower with a stepped top, lantern and spire
      const tw = clamp(Wb * 0.26, 3.6, 4.6), a = cornerSide < 0 ? x0 - 0.02 : x1 - tw + 0.02, rise = 2.2 + k.h(11) * 1.4;
      const tspec = { style: F('DECO', k.h(13) < 0.5 ? 'PORTHOLE' : 'FLUTED'), bays: 1, color: wall, seed };
      mass(k, rectRuns(a, zf - tw + 0.02, a + tw, zf + 0.02), roofY, [{ h: PARAPET + rise, storey: PARAPET + rise, grounded: false, spec: tspec }], { roof: shade(wall, 0.7), roofKind: 3, collide: false });
      const y2 = ziggurat(k, a, a + tw, zf - tw, zf, top + rise, [0.7, 0.5], { style: F('BLANK', 'STUCCO'), bay: 4, color: mixColor(wall, trim, 0.85), seed });
      const mx = a + tw / 2, mz = zf - tw / 2 + tw * 0.1;
      if (!k.far) { k.stucco(WHITE, 60).occ(1).cyl(mx, y2, mz, 0.7, y2 + 1.3, { segs: 8 }); k.stucco(trim, 60).cyl(mx, y2 + 1.3, mz, 0.82, y2 + 1.45, { segs: 8, bottom: true }).cyl(mx, y2 + 1.45, mz, 0.6, y2 + 4.2, { segs: 8, r1: 0.03 }); if (k.near) k.bare(3, 0.3).ball(mx, y2 + 4.3, mz, 0.16); }
      if (S.lit && !k.far) { const ring = []; for (let i = 0; i < 8; i++) { const an = i / 8 * Math.PI * 2; ring.push([mx + Math.sin(an) * 0.86, y2 + 1.375, mz + Math.cos(an) * 0.86]); } k.neon(ring, S.neon, { closed: true, back: [0, -1, 0], maxLights: 2 }); }
    }
    cx = (x0 + x1) / 2 - cornerSide * Wb * 0.08; cw = 4;
  } else {
    // ---- mid-block buildings: wings and a centre division
    cw = variant === 4 ? clamp(Wb * 0.24, 3.4, 4.6) : variant === 3 ? clamp(Wb * 0.3, 3.6, 7) : variant === 5 ? clamp(Wb * 0.3, 4, 8) : clamp(Wb * (0.22 + 0.1 * k.h(5)), 3.0, 7.5);
    p = variant === 2 ? 0.15 : 0.3 + 0.3 * k.h(6);
    cx = variant === 4 ? (k.h(7) < 0.5 ? x0 + cw / 2 + Math.min(3.2, Wb * 0.2) : x1 - cw / 2 - Math.min(3.2, Wb * 0.2)) : (x0 + x1) / 2;
    const a = cx - cw / 2, b = cx + cw / 2, sideL = zf - zb, ret = Math.min(sideL - 1, variant === 5 ? 7.5 : 4.2);
    runs = tripartite(x0, x1, zb, zf, a, b, p, corner === 1 ? sideL : att.left ? 0.6 : ret, corner === 2 ? sideL : att.right ? 0.6 : ret);
    const cStyle = variant === 4 ? 'GLASS_BLOCK' : variant === 2 ? 'FLUTED' : ['GLASS_BLOCK', 'FLUTED', 'PORTHOLE', 'PLAIN'][Math.floor(k.h(8) * 4)];
    const cCol = cStyle === 'FLUTED' || cStyle === 'PLAIN' ? (k.h(14) < 0.5 ? mixColor(wall, trim, 0.8) : wall) : wall;
    centreUp = { style: F('DECO', cStyle, cStyle === 'PLAIN' && stripes), bays: 1, color: cCol, seed };
    centreLobby = cw >= 4.4 ? { style: F('DECO', 'GLASS_BLOCK'), bays: 2, color: wall, seed, grounded: true, occ: [0.8, 0.62] } : { style: F('DECO', 'PLAIN'), bays: 1, color: wall, seed, grounded: true, occ: [0.8, 0.62] };
    const jog = { style: F('DECO', 'PLAIN', stripes), bays: 1, color: cCol, seed, grounded: false };
    frontClasses = ['wingL', 'wingR', 'lret', 'rret'];
    const isRet = (r) => r.cls === 'lret' || r.cls === 'rret';
    const spec = (kind) => (r) => {
      const c = r.cls;
      if (kind === 'plinth') return plinth;
      if (c === 'wingL' || c === 'wingR') return kind === 'up' ? front : lobby;
      if (isRet(r)) return att[c === 'lret' ? 'left' : 'right'] ? sideStyle({ cls: c === 'lret' ? 'left' : 'right' }) : kind === 'up' ? front : { style: F('DECO', 'SIDE', stripes), bay: 3.1, color: wall, seed };
      if (c === 'centre') return kind === 'up' ? centreUp : centreLobby;
      if (c === 'jogL' || c === 'jogR') return kind === 'up' ? jog : { ...jog, style: F('DECO', 'PLAIN') };
      if (c === 'back') return backSpec;
      return sideStyle(r);
    };
    const bands = k.far ? [{ h: PLINTH + LOBBY, storey: 4, spec: spec('lobby') }, { h: upper * UPPER, storey: UPPER, spec: spec('up') }]
      : [{ h: PLINTH, storey: 1, spec: spec('plinth') }, { h: LOBBY, spec: spec('lobby') }, { h: upper * UPPER, storey: UPPER, spec: spec('up') }];
    body = mass(k, runs, 0, bands, { parapet: PARAPET, color: wall, seed, coping: fascia, skipParapet: ['centre', 'jogL', 'jogR'] });
    const up = body.info[body.info.length - 1], R = (c) => runs.find((r) => r.cls === c);
    const pathL = [R('lret'), R('wingL')].filter(Boolean), pathR = [R('wingR'), R('rret')].filter(Boolean);
    const brow = { proj: winT === 'CASEMENT' ? 0.6 : 0.72, color: WHITE, lip: k.h(15) < 0.6 ? trim : WHITE, perBay: winT === 'CASEMENT', neon: S.lit && k.h(9) < 0.3 ? S.neon : null };
    if (!att.left || R('wingL')) eyebrows(k, up, att.left ? [R('wingL')].filter(Boolean) : pathL, brow);
    if (!att.right || R('wingR')) eyebrows(k, up, att.right ? [R('wingR')].filter(Boolean) : pathR, brow);
    eyePaths = [pathL, pathR];

    // ---- the centre division above the roof
    const top = body.top, zc = zf + p, depthC = Math.min(3.6, sideL * 0.4), tSpec = { style: F(cStyle === 'FLUTED' ? 'DECO' : 'BLANK', cStyle === 'FLUTED' ? 'FLUTED' : 'STUCCO', false), bay: 4, bays: 1, color: cCol, seed };
    const lit = S.lit && !k.far, flick = S.flicker ? CHANNEL.FLICKER : CHANNEL.NEON;
    if (variant === 0 || variant === 5) {
      const rise = (variant === 5 ? 2.2 : 1.5) + k.h(16) * 1.2;
      mass(k, rectRuns(a, zc - depthC, b, zc), roofY, [{ h: PARAPET + rise, storey: PARAPET + rise, grounded: false, spec: tSpec }], { roof: shade(cCol, 0.7), roofKind: 3, collide: false });
      const yz = ziggurat(k, a, b, zc - depthC, zc, top + rise, variant === 5 ? [0.9, 0.7, 0.5] : [0.7, 0.5], { style: F('BLANK', 'STUCCO'), bay: 4, color: k.h(17) < 0.5 ? trim : cCol, seed });
      // the fin: a thin blade on the axis from above the porch to above the crown
      const ft = 0.22, fp = 0.5, fy0 = yU + 0.5, fy1 = yz + 1.2 + k.h(18) * 1.6;
      if (!k.far) {
        k.stucco(trim, 60).occ(1).box(cx - ft / 2, fy0, zc - 1.2, cx + ft / 2, fy1, zc + fp, 'xXzZYy');
        if (k.near) k.stucco(WHITE, 60).box(cx - ft / 2 - 0.05, fy1, zc - 1.2, cx + ft / 2 + 0.05, fy1 + 0.1, zc + fp + 0.05, 'xXzZYy');
        if (lit) for (const s of [-1, 1]) k.neon([[cx + s * (ft / 2 + 0.035), fy0 + 0.1, zc + fp - 0.04], [cx + s * (ft / 2 + 0.035), fy1 - 0.1, zc + fp - 0.04]], S.neon, { back: [-s, 0, 0], channel: flick, lights: s > 0 });
      }
      if (variant === 5) roofSign(k, (x0 + a) / 2, top, zf - 0.8, { category: 'hotel', variant: lot.seed >>> 3, height: 1.5, maxWidth: (Wb - cw) * 0.5 - 1, lit: S.signLit, neon: S.lit ? S.neonAccent : null, far: true });
    } else if (variant === 2) {
      mass(k, rectRuns(a, zc - 1.0, b, zc), roofY, [{ h: PARAPET + 1.0, storey: PARAPET + 1, grounded: false, spec: tSpec }], { roof: shade(cCol, 0.7), roofKind: 3, collide: false });
      const s3 = cw / 3.3, ft = 0.2, fp = 0.55;
      for (const i of [-1, 0, 1]) {
        const fx = cx + i * s3, fy0 = yU + 0.35, fy1 = top + 1.0 + (i === 0 ? 2.3 : 1.2) + k.h(18) * 0.8;
        if (k.far && i !== 0) continue;
        if (!k.far || i === 0) k.stucco(i === 0 ? trim : (k.h(19) < 0.5 ? trim : WHITE), 60).occ(1).box(fx - ft / 2, fy0, zc - 0.8, fx + ft / 2, fy1, zc + fp, 'xXzZYy');
        if (lit) k.neon([[fx, fy0 + 0.1, zc + fp + 0.035], [fx, fy1 - 0.1, zc + fp + 0.035]], S.neon, { back: [0, 0, -1], channel: flick });
      }
    } else if (variant === 3) {
      const bar = 1.1 + k.h(16) * 0.5, pw = clamp(cw * 0.42, 1.5, 2.2), ph = 4.2 + k.h(18) * 1.6, pd = 0.8;
      mass(k, rectRuns(a, zc - 1.6, b, zc), roofY, [{ h: PARAPET + bar, storey: PARAPET + bar, grounded: false, spec: tSpec }], { roof: shade(cCol, 0.7), roofKind: 3, collide: false });
      const py0 = top + bar, pcol = k.h(17) < 0.6 ? trim : wall;
      mass(k, rectRuns(cx - pw / 2, zc - pd, cx + pw / 2, zc + 0.12), py0, [{ h: ph, storey: ph, grounded: false, spec: { style: F('BLANK', 'STUCCO'), bay: 4, color: pcol, seed } }], { roof: shade(pcol, 0.7), roofKind: 3, collide: false });
      if (!k.far) k.stucco(WHITE, 60).occ(1).box(cx - pw / 2 - 0.08, py0 + ph, zc - pd - 0.08, cx + pw / 2 + 0.08, py0 + ph + 0.14, zc + 0.2, 'xXzZYy');
      k.at(0, 0, zc + 0.12, 0, () => {
        k.sign('hotel-blade', lot.seed >>> 3, cx, py0 + ph / 2, 0.03, { height: ph - 0.5, maxWidth: pw - 0.3, lit: S.signLit, far: true });
        if (lit) k.neon([[cx - pw / 2 + 0.06, py0 + 0.1, 0.05], [cx - pw / 2 + 0.06, py0 + ph - 0.1, 0.05], [cx + pw / 2 - 0.06, py0 + ph - 0.1, 0.05], [cx + pw / 2 - 0.06, py0 + 0.1, 0.05]], S.neon, { back: [0, 0, -1], channel: flick });
      });
    } else {                                                     // 4: stair tower with a blade sign
      const rise = 2.0 + k.h(16) * 1.4;
      mass(k, rectRuns(a, zc - Math.min(5, sideL * 0.5), b, zc), roofY, [{ h: PARAPET + rise, storey: PARAPET + rise, grounded: false, spec: { ...tSpec, style: F('DECO', 'FLUTED') } }], { roof: shade(cCol, 0.7), roofKind: 3, collide: false });
      ziggurat(k, a, b, zc - Math.min(5, sideL * 0.5), zc, top + rise, [0.5], { style: F('BLANK', 'STUCCO'), bay: 4, color: trim, seed }, { inset: 0.08 });
      const R2 = R('centre');
      k.onRun(R2, (len) => bladeSign(k, len * (cx < 0 ? 0.25 : 0.75), yU + 0.9, top + rise - 0.3, 0, { variant: lot.seed >>> 3, color: mixColor(trim, [0.1, 0.12, 0.2], 0.55), neon: S.lit ? S.neon : null, lit: S.signLit, flicker: S.flicker, proj: 1.25 }));
    }
  }

  // ---- porch, entrance and name
  const pk = lot.porch ?? (k.h(20) < 0.55 ? 0 : k.h(20) < 0.85 ? 1 : 2), sw = clamp(cw + 0.6, 3.0, 5.6);
  const P = porch(k, S, { x0: x0 + (att.left ? 0 : 0.1), x1: x1 - (att.right ? 0 : 0.1), zf: zf, zEdge, cx, sw, kind: pk, wall, fascia, square: k.h(21) < 0.45, double: k.h(22) < 0.4, nameY: yU - 0.45 });
  const centreRun = runs.find((r) => r.cls === 'centre');
  if (centreRun) k.onRun(centreRun, (len) => { doorway(k, len / 2, PLINTH, Math.min(1.9, len - 1.0), 2.3, { transom: 0.4 }); if (pk === 2 || P.signZ == null) wallSign(k, 'hotel', lot.seed >>> 2, len / 2, yU - 0.42, { height: 0.5, maxWidth: len - 0.4, lit: S.signLit }); });
  else k.at(cx, 0, zf, 0, () => doorway(k, 0, PLINTH, 1.9, 2.3, { transom: 0.4 }));
  if (P.signZ != null) k.at(cx, 0, P.signZ, 0, () => {
    if (pk === 0 && k.h(23) < 0.45) roofSign(k, 0, P.fasciaTop, -0.35, { category: 'hotel', variant: lot.seed >>> 2, height: 0.75, leg: 0.12, maxWidth: Math.min(Wb * 0.6, 8), lit: S.signLit, neon: S.lit ? S.neon : null });
    else wallSign(k, 'hotel', lot.seed >>> 2, 0, P.signY, { height: 0.4, maxWidth: Math.min(Wb * 0.5, sw + 1.6), lit: S.signLit, z: 0.04 });
  });

  // ---- side and roof life
  const up = body.info[body.info.length - 1];
  windowUnits(k, up, ['left', 'right'], 0.22);
  if (S.age >= 2) windowUnits(k, up, frontClasses, 0.1);
  roofPlant(k, x0 + 0.6, zb + 0.6, x1 - 0.6, zf - 4.2, roofY, { tank: k.h(30) < 0.3, color: shade(wall, 0.92) });
  return { S, body, variant };
}
