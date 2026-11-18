// The back wall's centrepiece in neon: a slatted sun going down behind a horizon line, a palm either side, and the
// game's wordmark in script under it with its three speed stripes. Drawn in the wall's plane in metres (x across the
// room, y above the floor), each shape cut into lengths a glass bender could make and none crossing another.

import { vadd } from '../props/kit.js';
import { arc, bezier, tube, transformer, cable, frame } from './neon.js';
import { ROOM, GAS, FEATURE } from './plan.js';

const SUN = { c: [0, 2.64], r: 1.4 };
const HORIZON = SUN.c[1] - 0.035;
const MAX_TUBE = 2.3, JOINT = 0.03;

const length2 = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
/** The part of a 2D polyline between arc lengths s0 and s1. */
function slice2(pts, s0, s1) {
  const out = []; let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-9) continue;
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (s + l > s0 && s < s1) {
      if (!out.length) out.push(at(Math.max(0, (s0 - s) / l)));
      out.push(at(Math.min(1, (s1 - s) / l)));
    }
    s += l;
  }
  return out;
}
/** Cut a shape into tubes: equal lengths no longer than a bender's reach, a joint's width apart. */
function pieces(pts, closed) {
  const path = closed ? [...pts, pts[0]] : pts, L = length2(path), n = Math.max(1, Math.ceil(L / MAX_TUBE)), out = [];
  for (let i = 0; i < n; i++) {
    const s0 = i * L / n + (closed || i > 0 ? JOINT / 2 : 0), s1 = (i + 1) * L / n - (closed || i < n - 1 ? JOINT / 2 : 0);
    out.push(slice2(path, s0, s1));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the picture
/** The sun's slats, top first: [lower edge, upper edge] as fractions of the radius, wider gaps towards the horizon. */
const SLATS = [[0.62, 1.0, 'amber'], [0.44, 0.575, 'amber'], [0.285, 0.385, 'orange'], [0.155, 0.225, 'pink'], [0.045, 0.095, 'magenta']];

function sunShapes() {
  const { c, r } = SUN, out = [];
  for (const [lo, hi, gas] of SLATS) {
    const a0 = Math.asin(lo), a1 = Math.asin(Math.min(1, hi));
    const outline = hi >= 1
      ? [...arc(c, r, a0, Math.PI - a0)]                                           // the cap: one arc over the top, closed by its chord
      : [...arc(c, r, a0, a1), ...arc(c, r, Math.PI - a1, Math.PI - a0)];
    out.push({ gas, closed: true, pts: outline });
    if (hi >= 1) {                                                               // a second line inside the cap, as sign makers fill a large shape
      const ri = r - 0.11, b0 = Math.asin((lo * r + 0.11) / ri);
      out.push({ gas: 'orange', closed: true, pts: arc(c, ri, b0, Math.PI - b0) });
    }
  }
  return out;
}

/** A palm on the horizon at x, leaning by `lean` (+1 leans right): trunk in two lines, seven fronds as slim leaves. */
function palmShapes(x, lean) {
  const out = [], foot = [x, HORIZON + 0.05], crown = [x + lean * 0.34, HORIZON + 1.04];
  const P = (u, v) => [foot[0] + (crown[0] - foot[0]) * (v * v * 0.7 + v * 0.3) + u, foot[1] + (crown[1] - foot[1]) * v];
  for (const side of [-1, 1]) {
    const pts = []; for (let i = 0; i <= 10; i++) { const v = i / 10; pts.push(P(side * (0.05 - 0.018 * v), v * 0.94)); }
    out.push({ gas: 'violet', closed: false, pts });
  }
  // fronds: [direction in degrees from straight up towards the lean side, length, droop]
  const fronds = [[-100, 0.62, 0.34], [-62, 0.72, 0.3], [-24, 0.72, 0.2], [14, 0.72, 0.2], [50, 0.76, 0.3], [86, 0.7, 0.36], [118, 0.54, 0.3]];
  for (const [deg, len, droop] of fronds) {
    const a = deg * Math.PI / 180, d = [Math.sin(a) * lean, Math.cos(a)], n = [d[1], -d[0]];
    const start = [crown[0] + d[0] * 0.07, crown[1] + d[1] * 0.07], tip = [crown[0] + d[0] * len, crown[1] + d[1] * len - droop * len];
    const mid = (bow) => [crown[0] + d[0] * len * 0.55 + n[0] * bow, crown[1] + d[1] * len * 0.55 + n[1] * bow + droop * len * 0.12];
    // one leaf: out along its upper edge to the tip, back along the lower
    const up = bezier([start, mid(0.07), mid(0.07), tip], 9), down = bezier([tip, mid(-0.05), mid(-0.05), [start[0] + n[0] * -0.03, start[1] + n[1] * -0.03]], 9);
    out.push({ gas: 'cyan', closed: false, pts: [...up, ...down.slice(1)] });
  }
  return out;
}

// The wordmark in script. Letters are drawn upright on a baseline as centrelines with the x-height as the unit, then
// slanted and scaled. A single 15 mm line is too slight for letters meant to be read across a workshop, so each
// stroke is made the way sign shops give script its weight: double, the glass going out along one side of the
// stroke, round its end and back along the other. No stroke crosses itself or another.
const X_HEIGHT = 0.42, SLANT = 0.26, STROKE = 0.019;
const ring = (cx, cy, rx, ry, a0 = 100) => { const pts = []; for (let i = 0; i <= 28; i++) { const a = (a0 + i / 28 * 340) * Math.PI / 180; pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); } return pts; };
const GLYPH = {
  V: { w: 2.0, strokes: [bezier([[0.0, 1.5], [0.0, 1.82], [0.22, 1.96], [0.38, 1.78], [0.54, 1.58], [0.54, 0.0], [0.84, 0.0], [1.14, 0.0], [1.2, 1.46], [1.5, 1.84], [1.6, 1.96], [1.8, 1.98], [1.9, 1.82]], 12)] },
  i: { w: 0.8, strokes: [bezier([[0.3, 1.0], [0.3, 0.7], [0.3, 0.5], [0.3, 0.26], [0.3, 0.04], [0.5, -0.02], [0.74, 0.22]], 8), { single: true, pts: ring(0.3, 1.46, 0.085, 0.085, 280) }] },
  c: { w: 1.02, strokes: [bezier([[0.8, 0.7], [0.72, 1.02], [0.36, 1.08], [0.18, 0.72], [0.02, 0.4], [0.14, 0.02], [0.46, 0.0], [0.66, 0.0], [0.84, 0.12], [0.98, 0.3]], 9)] },
  e: { w: 1.1, strokes: [bezier([[0.31, 0.47], [0.5, 0.49], [0.76, 0.6], [0.76, 0.82], [0.76, 1.06], [0.36, 1.08], [0.2, 0.74], [0.04, 0.4], [0.16, 0.02], [0.48, 0.0], [0.68, 0.0], [0.86, 0.12], [1.0, 0.3]], 9)] },
  "'": { w: 0.5, strokes: [bezier([[0.22, 1.96], [0.22, 1.78], [0.14, 1.6], [0.04, 1.5]], 5)] },
  8: { w: 1.0, strokes: [ring(0.44, 1.53, 0.3, 0.37, 280), ring(0.42, 0.49, 0.38, 0.49, 100)] },
  6: { w: 0.95, strokes: [bezier([[0.78, 1.8], [0.5, 1.98], [0.1, 1.5], [0.06, 0.62], [0.02, 0.2], [0.24, 0.0], [0.44, 0.0], [0.7, 0.0], [0.84, 0.24], [0.84, 0.52], [0.84, 0.84], [0.62, 1.04], [0.42, 1.04], [0.36, 1.04], [0.31, 1.01], [0.28, 0.95]], 9)] },
};
const TEXT = [['V', 0], ['i', 0.02], ['c', 0], ['e', 0], ["'", 0.5], ['8', 0.02], ['6', 0.1]];

/** A stroke's centreline as one length of glass: out along its left side, round the far end, back along its right. */
function doubled(pts, d) {
  const last = pts.length - 1, normal = (i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(last, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  };
  const side = (s) => pts.map((p, i) => { const n = normal(i); return [p[0] + n[0] * d * s, p[1] + n[1] * d * s]; });
  const n = normal(last), turn = Math.atan2(n[1], n[0]);
  return [...side(1), ...arc(pts[last], d, turn, turn - Math.PI, 0.012).slice(1, -1), ...side(-1).reverse()];
}

function scriptShapes(centre, baseline) {
  let pen = 0; const raw = [];
  for (const [ch, lead] of TEXT) {
    pen += lead;
    for (const s of GLYPH[ch].strokes) raw.push({ single: !!s.single, pts: (s.pts || s).map(([x, y]) => [pen + x + SLANT * y, y]) });
    pen += GLYPH[ch].w;
  }
  const width = pen + SLANT * 1.9;
  return raw.map((s) => {
    const pts = s.pts.map(([x, y]) => [centre + (x - width / 2) * X_HEIGHT, baseline + y * X_HEIGHT]);
    return { gas: 'pink', closed: false, pts: s.single ? pts : doubled(pts, STROKE) };
  });
}

/**
 * Where each part of the sign is lit from: one line across the part, [x0, x1, y, radius] on the wall. The line stands
 * for many bent tubes, so it is given the half height of the part as its radius: the wall behind then takes an even
 * wash as tall as the part instead of one hot stripe.
 */
export const SIGN_LIGHT = Object.freeze({
  'sign-sun': [-SUN.r * 0.9, SUN.r * 0.9, SUN.c[1] + 0.45 * SUN.r, 0.5],
  'sign-script': [-1.6, 1.6, 1.95, 0.3],
  'sign-palm': [-4.05, 4.05, HORIZON + 0.5, 0.6],
});

/** Every tube of the sign as a 2D shape: { gas, group, closed, pts }. */
export function signShapes() {
  const baseline = 1.7, out = [];
  for (const s of sunShapes()) out.push({ ...s, group: 'sign-sun' });
  out.push({ gas: 'violet', group: 'sign-palm', closed: false, pts: [[-4.05, HORIZON], [-1.52, HORIZON]] }, { gas: 'violet', group: 'sign-palm', closed: false, pts: [[1.52, HORIZON], [4.05, HORIZON]] });
  for (const s of [...palmShapes(-3.18, 1), ...palmShapes(3.18, -1)]) out.push({ ...s, group: 'sign-palm' });
  for (const s of scriptShapes(0, baseline)) out.push({ ...s, group: 'sign-script' });
  // the wordmark's leaning line and its two echoes, as three stripes stepping away to the right
  out.push({ gas: 'pink', group: 'sign-script', closed: false, pts: [[-1.7, 1.56], [1.3, 1.56]] }, { gas: 'magenta', group: 'sign-script', closed: false, pts: [[-1.1, 1.48], [1.6, 1.48]] }, { gas: 'violet', group: 'sign-script', closed: false, pts: [[-0.5, 1.4], [1.9, 1.4]] });
  return out;
}

/**
 * Build the sign on the back wall: tubes, posts, boots, the cables that string the tubes of each colour together,
 * and the transformers that feed them.
 */
export function buildSign(k, log) {
  const f = frame([0, 0, ROOM.z0], [1, 0, 0], [0, 1, 0]), first = log.length;
  let id = 0;
  for (const shape of signShapes()) for (const pts of pieces(shape.pts, shape.closed)) {
    if (pts.length < 2) continue;
    tube(k, log, f, pts, { id: `${shape.group}-${++id}`, group: shape.group, gas: GAS[shape.gas] });
  }
  // wiring: each tube's second leg to the nearest unused first leg of another tube of its group
  const mine = log.slice(first), lift = (p) => vadd(p, [0, 0, 0.012]);
  for (const group of ['sign-sun', 'sign-palm', 'sign-script']) {
    const list = mine.filter((t) => t.group === group), used = new Set();
    for (const t of list) {
      let best = null, bd = 0.32;
      for (const o of list) { if (o === t || used.has(o)) continue; const d = Math.hypot(o.ends[0][0] - t.ends[1][0], o.ends[0][1] - t.ends[1][1]); if (d < bd && d > 0.03) { bd = d; best = o; } }
      if (best) { used.add(best); cable(k, lift(t.ends[1]), lift(best.ends[0]), 0.004, Math.min(0.05, bd * 0.18), undefined, 5); }
    }
  }
  // transformers in a row under the picture, fed by one conduit that runs along the wall under them and up to the
  // roof steel beside the panel
  const row = 1.235, riser = FEATURE.x0 - 0.5, z = ROOM.z0 + 0.016;
  k.bare(2, 0.5, [0.6, 0.61, 0.62]);
  k.tube([[3.75, row, z], [riser + 0.05, row, z], [riser, row + 0.05, z], [riser, ROOM.truss + 0.4, z]], 0.01, 6, { capA: true });
  for (let x = riser + 0.4; x < 3.7; x += 0.95) k.box(x - 0.008, row - 0.022, ROOM.z0, x + 0.008, row + 0.022, z + 0.012, { r: 0 });
  for (let y = row + 0.5; y < ROOM.truss; y += 0.9) k.box(riser - 0.022, y - 0.008, ROOM.z0, riser + 0.022, y + 0.008, z + 0.012, { r: 0 });
  for (const x of [-3.75, -2.5, 2.5, 3.75]) {
    const entry = transformer(k, f, [x, row + 0.14], -1);
    k.cyl(entry, [entry[0], row - 0.004, entry[2]], 0.01, 0.01, 6, { capB: true });
    // the high-tension leads from the case's bushings up to the nearest tube legs
    for (const s of [-1, 1]) {
      let best = null, bd = 1e9; for (const t of mine) for (const e of t.ends) { const d = Math.hypot(e[0] - (x + s * 0.4), e[1] - 1.7); if (d < bd) { bd = d; best = e; } }
      cable(k, [x + s * 0.2, row + 0.18, ROOM.z0 + 0.09], lift(best), 0.0045, 0.02, undefined, 8);
    }
  }
  return k;
}
